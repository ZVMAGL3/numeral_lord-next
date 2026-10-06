import { performance } from "node:perf_hooks";
import type { GameIntent, GameState } from "../../packages/game-core/src/index.js";

/** The evaluator sees only legal candidates, in exactly the engine's order. */
export interface EncodedPosition {
  observation: number[];
  global: number[];
  candidates: number[][];
  intents: readonly GameIntent[];
  teamId: string;
}

export interface SearchEnvironment {
  legal(state: GameState): readonly GameIntent[];
  step(state: GameState, intent: GameIntent): GameState;
  terminalValue(state: GameState, teamId: string): number | null;
  encode(state: GameState): EncodedPosition;
  heuristic(state: GameState, teamId: string): number;
  team?(state: GameState): string;
}

export type Evaluation = { priors: number[]; value: number };
export type Evaluator = (positions: EncodedPosition[]) => Promise<Evaluation[]>;

export interface SearchOptions {
  simulations: number;
  /** Minimum amount of useful tree expansion before a soft time budget can stop search. */
  minimumSimulations?: number;
  cpuct?: number;
  seed?: number;
  temperature?: number;
  /** Fraction of root priors replaced by Dirichlet(alpha=0.3) noise. */
  rootNoise?: number;
  /** Atomic-command depth, not player turns. Zero performs root bootstrapping. */
  maxDepth?: number;
  /** Soft wall-clock budget, including root evaluation; one simulation is guaranteed. */
  timeLimitMs?: number;
}

export interface SearchResult {
  intent: GameIntent;
  /** Normalized root visits used as training targets, before action temperature. */
  policy: number[];
  value: number;
  visits: number[];
  stats: { simulations: number; expanded: number; maxDepth: number; elapsedMs: number };
}

// Teacher state never becomes a JSON field or enters neural-inference IPC.
const encodedStates = new WeakMap<EncodedPosition, { env: SearchEnvironment; state: GameState }>();

export function encodeForSearch(env: SearchEnvironment, state: GameState): EncodedPosition {
  const position = env.encode(state);
  encodedStates.set(position, { env, state });
  return position;
}

function currentTeam(env: SearchEnvironment, state: GameState): string {
  const team = env.team?.(state) ?? state.players[state.turn.currentPlayerId]?.teamId;
  if (!team) throw new Error("Search state has no current player's team.");
  return team;
}

function checkedValue(value: number, label: string): number {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`${label} must be a finite value in [-1, 1].`);
  }
  return value;
}

function checkedEvaluation(result: Evaluation | undefined, count: number): Evaluation {
  if (!result || !Array.isArray(result.priors) || result.priors.length !== count) {
    throw new Error("Evaluator priors must match every legal candidate, in order.");
  }
  const total = result.priors.reduce((sum, prior) => {
    if (!Number.isFinite(prior) || prior < 0) throw new Error("Evaluator priors must be finite and nonnegative.");
    return sum + prior;
  }, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error("Evaluator priors must have a finite positive sum.");
  return { priors: result.priors.map((prior) => prior / total), value: checkedValue(result.value, "Evaluator value") };
}

function intentKey(intent: GameIntent): string {
  switch (intent.type) {
    case "move-unit": return `move:${intent.unitId}:${intent.destinationId}`;
    case "attack-unit": return `attack:${intent.unitId}:${intent.targetId}`;
    case "reinforce-unit": return `reinforce:${intent.unitId}`;
    default: return intent.type;
  }
}

function checkCandidateOrder(position: EncodedPosition, legal: readonly GameIntent[], teamId: string): void {
  if (position.teamId !== teamId) throw new Error("Encoded value perspective must match the current player's team.");
  if (position.candidates.length !== legal.length || position.intents.length !== legal.length
    || position.intents.some((intent, index) => intentKey(intent) !== intentKey(legal[index]!))) {
    throw new Error("Encoded candidates must match the complete legal intent order.");
  }
}

/** A bounded shallow teacher; it never reads future data or bypasses engine steps. */
export function createHeuristicEvaluator(
  env: SearchEnvironment,
  options: { teacherDepth?: number } = {}
): Evaluator {
  const depth = options.teacherDepth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 3) {
    throw new Error("teacherDepth must be an integer from 0 to 3.");
  }

  const minimax = (state: GameState, perspective: string, remaining: number): number => {
    const terminal = env.terminalValue(state, perspective);
    if (terminal !== null) return checkedValue(terminal, "Terminal value");
    if (remaining === 0) return checkedValue(env.heuristic(state, perspective), "Heuristic value");
    const legal = env.legal(state);
    if (legal.length === 0) throw new Error("Nonterminal teacher state has no legal intents.");
    const maximize = currentTeam(env, state) === perspective;
    let value = maximize ? -1 : 1;
    for (const intent of legal) {
      const childValue = minimax(env.step(state, intent), perspective, remaining - 1);
      value = maximize ? Math.max(value, childValue) : Math.min(value, childValue);
    }
    return value;
  };

  return async (positions) => positions.map((position) => {
    const reference = encodedStates.get(position);
    if (!reference || reference.env !== env) {
      throw new Error("Heuristic evaluation requires encodeForSearch with this environment.");
    }
    const { state } = reference;
    const legal = env.legal(state);
    checkCandidateOrder(position, legal, currentTeam(env, state));
    if (legal.length === 0) throw new Error("Terminal positions must be resolved by the engine before evaluation.");
    if (depth === 0) {
      return { priors: legal.map(() => 1 / legal.length), value: minimax(state, position.teamId, 0) };
    }
    const scores = legal.map((intent) => minimax(env.step(state, intent), position.teamId, depth - 1));
    const best = Math.max(...scores);
    const weights = scores.map((score) => Math.exp((score - best) / 0.15));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    // Preserve exploration of every legal action, including ending early.
    const priors = weights.map((weight) => 0.97 * weight / total + 0.03 / legal.length);
    return { priors, value: best };
  });
}

interface Node {
  state: GameState;
  teamId: string;
  terminal: number | null;
  expanded: boolean;
  value: number;
  visits: number;
  intents: readonly GameIntent[];
  priors: number[];
  edgeVisits: number[];
  /** Q sums are always in this parent node's team's perspective. */
  edgeValues: number[];
  children: Array<Node | undefined>;
}

function makeNode(env: SearchEnvironment, state: GameState): Node {
  const teamId = currentTeam(env, state);
  const terminal = env.terminalValue(state, teamId);
  if (terminal !== null) checkedValue(terminal, "Terminal value");
  return {
    state, teamId, terminal, expanded: false, value: terminal ?? 0, visits: 0,
    intents: [], priors: [], edgeVisits: [], edgeValues: [], children: []
  };
}

/** Seeded PRNG keeps search/noise/tie breaking reproducible. */
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function gamma(alpha: number, random: () => number): number {
  if (alpha < 1) return gamma(alpha + 1, random) * Math.pow(Math.max(random(), Number.MIN_VALUE), 1 / alpha);
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const normal = Math.sqrt(-2 * Math.log(Math.max(random(), Number.MIN_VALUE))) * Math.cos(2 * Math.PI * random());
    const base = 1 + c * normal;
    if (base <= 0) continue;
    const v = base ** 3;
    const u = Math.max(random(), Number.MIN_VALUE);
    if (u < 1 - 0.0331 * normal ** 4 || Math.log(u) < 0.5 * normal ** 2 + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

function applyRootNoise(priors: number[], fraction: number, random: () => number): number[] {
  if (fraction === 0 || priors.length === 1) return priors;
  const noise = priors.map(() => gamma(0.3, random));
  const total = noise.reduce((sum, value) => sum + value, 0);
  return priors.map((prior, index) => (1 - fraction) * prior + fraction * noise[index]! / total);
}

function selectEdge(node: Node, cpuct: number, random: () => number): number {
  let best = -Infinity;
  const ties: number[] = [];
  for (let index = 0; index < node.intents.length; index++) {
    const visits = node.edgeVisits[index]!;
    const q = visits > 0 ? node.edgeValues[index]! / visits : 0;
    const score = q + cpuct * node.priors[index]! * Math.sqrt(node.visits + 1) / (1 + visits);
    if (score > best + 1e-12) { best = score; ties.length = 0; ties.push(index); }
    else if (Math.abs(score - best) <= 1e-12) ties.push(index);
  }
  return ties[Math.floor(random() * ties.length)]!;
}

function policyFromVisits(visits: number[], priors: number[], temperature: number): number[] {
  const totalVisits = visits.reduce((sum, count) => sum + count, 0);
  if (totalVisits === 0) return [...priors];
  if (temperature === 0) {
    // Keep tied maxima visible; the final deterministic seeded choice resolves them.
    const best = Math.max(...visits);
    const count = visits.filter((visit) => visit === best).length;
    return visits.map((visit) => visit === best ? 1 / count : 0);
  }
  const logs = visits.map((count) => count > 0 ? Math.log(count) / temperature : -Infinity);
  const maximum = Math.max(...logs);
  const weights = logs.map((value) => Math.exp(value - maximum));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function chooseIntent(node: Node, policy: number[], temperature: number, random: () => number): number {
  if (temperature === 0) {
    let best = -Infinity;
    const ties: number[] = [];
    for (let index = 0; index < policy.length; index++) {
      if (policy[index] === 0) continue;
      const visits = node.edgeVisits[index]!;
      const q = visits > 0 ? node.edgeValues[index]! / visits : node.value;
      const score = q + 1e-9 * node.priors[index]!;
      if (score > best + 1e-12) { best = score; ties.length = 0; ties.push(index); }
      else if (Math.abs(score - best) <= 1e-12) ties.push(index);
    }
    return ties[Math.floor(random() * ties.length)]!;
  }
  let sample = random();
  for (let index = 0; index < policy.length; index++) {
    sample -= policy[index]!;
    if (sample < 0) return index;
  }
  return policy.length - 1;
}

/** PUCT over exact engine states; evaluation may batch across concurrent searches. */
export async function search(
  env: SearchEnvironment,
  state: GameState,
  evaluate: Evaluator,
  options: SearchOptions
): Promise<SearchResult> {
  const { simulations, minimumSimulations = 1, cpuct = 1.5, seed = 0, temperature = 1, rootNoise = 0, maxDepth = 128, timeLimitMs } = options;
  if (!Number.isSafeInteger(simulations) || simulations < 1) throw new Error("simulations must be a positive integer.");
  if (!Number.isSafeInteger(minimumSimulations) || minimumSimulations < 1 || minimumSimulations > simulations) {
    throw new Error("minimumSimulations must be a positive integer no greater than simulations.");
  }
  if (!Number.isFinite(cpuct) || cpuct <= 0) throw new Error("cpuct must be finite and positive.");
  if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer.");
  if (!Number.isFinite(temperature) || temperature < 0) throw new Error("temperature must be finite and nonnegative.");
  if (!Number.isFinite(rootNoise) || rootNoise < 0 || rootNoise > 1) throw new Error("rootNoise must be in [0, 1].");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error("maxDepth must be a nonnegative integer.");
  if (timeLimitMs !== undefined && (!Number.isFinite(timeLimitMs) || timeLimitMs <= 0)) {
    throw new Error("timeLimitMs must be finite and positive when supplied.");
  }
  const started = performance.now();
  const random = randomSource(seed);
  const root = makeNode(env, state);
  if (root.terminal !== null) throw new Error("Cannot search a terminal position.");
  let expanded = 0;
  let deepest = 0;

  const expand = async (node: Node): Promise<number> => {
    const intents = env.legal(node.state);
    if (intents.length === 0) throw new Error("Nonterminal search state has no legal intents.");
    const position = encodeForSearch(env, node.state);
    checkCandidateOrder(position, intents, node.teamId);
    const batch = await evaluate([position]);
    if (!Array.isArray(batch) || batch.length !== 1) throw new Error("Evaluator must return one result per position.");
    const result = checkedEvaluation(batch[0], intents.length);
    node.intents = [...intents];
    node.priors = result.priors;
    node.value = result.value;
    node.edgeVisits = intents.map(() => 0);
    node.edgeValues = intents.map(() => 0);
    node.children = intents.map(() => undefined);
    node.expanded = true;
    expanded++;
    return result.value;
  };

  await expand(root);
  root.priors = applyRootNoise(root.priors, rootNoise, random);
  let rootValueSum = 0;
  let completed = 0;
  for (let simulation = 0; simulation < simulations; simulation++) {
    if (completed >= minimumSimulations && timeLimitMs !== undefined && performance.now() - started >= timeLimitMs) break;
    let node = root;
    let depth = 0;
    const path: Array<{ parent: Node; edge: number; child: Node }> = [];
    let value: number;
    for (;;) {
      deepest = Math.max(deepest, depth);
      if (node.terminal !== null) { value = node.terminal; break; }
      if (!node.expanded) { value = await expand(node); break; }
      if (depth >= maxDepth) { value = node.value; break; }
      const edge = selectEdge(node, cpuct, random);
      const child = node.children[edge] ?? makeNode(env, env.step(node.state, node.intents[edge]!));
      node.children[edge] = child;
      path.push({ parent: node, edge, child });
      node = child;
      depth++;
    }
    node.visits++;
    for (let index = path.length - 1; index >= 0; index--) {
      const { parent, edge, child } = path[index]!;
      // Atomic commands may retain the same player/team through both phases.
      if (parent.teamId !== child.teamId) value = -value;
      parent.edgeVisits[edge] = parent.edgeVisits[edge]! + 1;
      parent.edgeValues[edge] = parent.edgeValues[edge]! + value;
      parent.visits++;
    }
    rootValueSum += value;
    completed++;
    // A single awaited evaluator call can exceed the budget; this is not a hard deadline.
    if (completed >= minimumSimulations && timeLimitMs !== undefined && performance.now() - started >= timeLimitMs) break;
  }
  const policy = policyFromVisits(root.edgeVisits, root.priors, 1);
  const selectionPolicy = policyFromVisits(root.edgeVisits, root.priors, temperature);
  const selected = chooseIntent(root, selectionPolicy, temperature, random);
  return {
    intent: root.intents[selected]!, policy, value: rootValueSum / completed, visits: [...root.edgeVisits],
    stats: { simulations: completed, expanded, maxDepth: deepest, elapsedMs: performance.now() - started }
  };
}
