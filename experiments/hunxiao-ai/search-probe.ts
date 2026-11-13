import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { GameIntent, GameState } from "../../packages/game-core/src/index.js";
import { createEnvironment, type Environment } from "./environment.js";
import { InferenceService } from "./runtime.js";
import { search, type SearchEnvironment } from "./search.js";

export interface TransitionObservation {
  stepCalls: number;
  teamSwitches: number;
  seatSwitches: number;
  stepCallsByTeam: Record<string, number>;
  encodedNodesByTeam: Record<string, number>;
  phaseTransitions: Record<string, number>;
  phaseExitSteps: Array<{ parentSequence: number; fromPhase: string; toPhase: string;
    actingTeam: string; actingSeat: number; reinforcementPoints: number; intentType: string }>;
}

interface ProbeCase {
  id: string;
  fingerprint: string;
  source: { game: number; sequence: number; round: number; phase: string; seat: number };
  stateSha256: string;
  state: GameState;
  legalIntentCount: number;
  actualFirstIntent: GameIntent;
  actualFirstIntentLegal: boolean;
  comparisonHypothesis: string;
  bestIntentLabel: null;
}

interface ProbeSuite {
  schemaVersion: number;
  fingerprint: string;
  constraints?: { bestMoveLabels?: boolean };
  cases: ProbeCase[];
}

interface ReferenceBudget {
  actualSimulations: number;
  maximumAtomicDepth: number;
  expanded: number;
  opponentResponseSteps: number;
  exploredOpponentResponse: boolean;
  reachedDifferentPhase: boolean;
  reachedDifferentTeam: boolean;
  selectedIntentKey: string;
  policy: number[];
  policySummary: { visitedLegalFraction: number };
}

interface ReferenceCase {
  id: string;
  stateSha256: string;
  budgets: ReferenceBudget[];
}

interface ReferenceReport {
  schemaVersion: number;
  status: string;
  checkpoint: string;
  checkpointSha256: string;
  modelFamily: string;
  fingerprint: string;
  casesSha256: string;
  settings: { budgets: number[]; minimumSimulations: string; thinkMs: number; seed: number;
    maxDepth: number; temperature: number; rootNoise: number };
  caseResults: ReferenceCase[];
}

export type ProbeMode = { kind: "baseline"; budgets: [4, 16, 64] }
  | { kind: "reference-extension"; budgets: [256]; reference: string; referenceSha256: string };

export function probeMode(budgetText: string, reference?: string, referenceSha256?: string): ProbeMode {
  if (budgetText === "4,16,64") {
    if (reference || referenceSha256) throw new Error("baseline mode does not accept a reference");
    return { kind: "baseline", budgets: [4, 16, 64] };
  }
  if (budgetText === "256") {
    if (!reference || !referenceSha256) {
      throw new Error("--budgets 256 requires --reference and --reference-sha256");
    }
    return { kind: "reference-extension", budgets: [256], reference, referenceSha256: referenceSha256.toLowerCase() };
  }
  throw new Error("controlled probe budgets must be exactly 4,16,64 or the reference extension 256");
}

export function validateReferenceReport(reference: ReferenceReport, expected: {
  checkpoint: string; checkpointSha256: string; fingerprint: string; casesSha256: string;
  seed: number; maxDepth: number; cases: Array<{ id: string; stateSha256: string }>;
}): void {
  if (reference.schemaVersion !== 1 || reference.status !== "complete"
      || resolve(reference.checkpoint) !== resolve(expected.checkpoint)
      || reference.checkpointSha256 !== expected.checkpointSha256
      || reference.modelFamily !== "hex-graph-v1" || reference.fingerprint !== expected.fingerprint
      || reference.casesSha256 !== expected.casesSha256
      || JSON.stringify(reference.settings.budgets) !== JSON.stringify([4, 16, 64])
      || reference.settings.minimumSimulations !== "equals each budget"
      || reference.settings.thinkMs !== 0 || reference.settings.seed !== expected.seed
      || reference.settings.maxDepth !== expected.maxDepth || reference.settings.temperature !== 0
      || reference.settings.rootNoise !== 0 || reference.caseResults.length !== expected.cases.length) {
    throw new Error("reference report provenance or fixed search settings mismatch");
  }
  for (const entry of expected.cases) {
    const candidate = reference.caseResults.find((item) => item.id === entry.id);
    const budget = candidate?.budgets.find((item) => item.actualSimulations === 64);
    if (!candidate || candidate.stateSha256 !== entry.stateSha256 || !budget
        || !Array.isArray(budget.policy) || budget.policy.length === 0) {
      throw new Error(`reference case or frozen 64-simulation row mismatch: ${entry.id}`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
  renameSync(temporary, path);
}

function intentKey(intent: GameIntent): string {
  switch (intent.type) {
    case "move-unit": return `move:${intent.unitId}:${intent.destinationId}`;
    case "attack-unit": return `attack:${intent.unitId}:${intent.targetId}`;
    case "reinforce-unit": return `reinforce:${intent.unitId}`;
    default: return intent.type;
  }
}

function seat(state: GameState): number {
  const player = state.players[state.turn.currentPlayerId];
  if (!player) throw new Error("state has no current player");
  return player.seat;
}

export function observeTransitions(base: SearchEnvironment): {
  env: SearchEnvironment;
  observation: TransitionObservation;
} {
  const observation: TransitionObservation = {
    stepCalls: 0, teamSwitches: 0, seatSwitches: 0,
    stepCallsByTeam: {}, encodedNodesByTeam: {}, phaseTransitions: {}, phaseExitSteps: []
  };
  const env: SearchEnvironment = {
    legal: (state) => base.legal(state),
    step: (state, intent) => {
      const beforeTeam = base.team?.(state) ?? state.players[state.turn.currentPlayerId]?.teamId;
      const beforeSeat = seat(state);
      const beforePhase = state.turn.phase;
      const next = base.step(state, intent);
      const afterTeam = base.team?.(next) ?? next.players[next.turn.currentPlayerId]?.teamId;
      const transition = `${beforePhase}->${next.turn.phase}`;
      observation.stepCalls += 1;
      if (!beforeTeam) throw new Error("step parent has no acting team");
      observation.stepCallsByTeam[beforeTeam] = (observation.stepCallsByTeam[beforeTeam] ?? 0) + 1;
      observation.phaseTransitions[transition] = (observation.phaseTransitions[transition] ?? 0) + 1;
      if (beforePhase !== next.turn.phase) {
        const player = state.players[state.turn.currentPlayerId]!;
        observation.phaseExitSteps.push({ parentSequence: state.sequence,
          fromPhase: beforePhase, toPhase: next.turn.phase,
          actingTeam: beforeTeam, actingSeat: beforeSeat,
          reinforcementPoints: player.reinforcementPoints, intentType: intent.type });
      }
      observation.teamSwitches += Number(beforeTeam !== afterTeam);
      observation.seatSwitches += Number(beforeSeat !== seat(next));
      return next;
    },
    terminalValue: (state, teamId) => base.terminalValue(state, teamId),
    encode: (state) => {
      const team = base.team?.(state) ?? state.players[state.turn.currentPlayerId]?.teamId;
      if (!team) throw new Error("encoded state has no acting team");
      observation.encodedNodesByTeam[team] = (observation.encodedNodesByTeam[team] ?? 0) + 1;
      return base.encode(state);
    },
    heuristic: (state, teamId) => base.heuristic(state, teamId),
    ...(base.team ? { team: (state: GameState) => base.team!(state) } : {})
  };
  return { env, observation };
}

export function policySummary(policy: number[], visits: number[]): {
  entropyNats: number;
  effectiveActionCount: number;
  visitedActions: number;
  visitedLegalFraction: number;
  maximumShare: number;
} {
  const entropyNats = -policy.reduce((total, probability) =>
    total + (probability > 0 ? probability * Math.log(probability) : 0), 0);
  return {
    entropyNats,
    effectiveActionCount: Math.exp(entropyNats),
    visitedActions: visits.filter((count) => count > 0).length,
    visitedLegalFraction: visits.filter((count) => count > 0).length / visits.length,
    maximumShare: Math.max(...policy)
  };
}

export function jensenShannon(first: number[], second: number[]): number {
  if (first.length !== second.length) throw new Error("policy lengths differ");
  const middle = first.map((value, index) => (value + second[index]!) / 2);
  const kl = (left: number[], right: number[]) => left.reduce((sum, value, index) =>
    sum + (value > 0 ? value * Math.log(value / right[index]!) : 0), 0);
  return (kl(first, middle) + kl(second, middle)) / 2;
}

function transitionSummary(base: Environment, state: GameState, intent: GameIntent) {
  const beforePlayer = state.players[state.turn.currentPlayerId]!;
  const before = {
    sequence: state.sequence, round: state.turn.round, phase: state.turn.phase,
    seat: beforePlayer.seat, teamId: beforePlayer.teamId,
    reinforcementPoints: beforePlayer.reinforcementPoints
  };
  const next = base.step(state, intent);
  const afterPlayer = next.players[next.turn.currentPlayerId]!;
  return {
    before,
    after: {
      sequence: next.sequence, round: next.turn.round, phase: next.turn.phase,
      seat: afterPlayer.seat, teamId: afterPlayer.teamId,
      reinforcementPoints: afterPlayer.reinforcementPoints
    },
    sameSeat: before.seat === afterPlayer.seat,
    sameTeam: before.teamId === afterPlayer.teamId
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      cases: { type: "string" }, checkpoint: { type: "string" },
      "checkpoint-sha256": { type: "string" }, output: { type: "string" }, progress: { type: "string" },
      budgets: { type: "string", default: "4,16,64" },
      reference: { type: "string" }, "reference-sha256": { type: "string" },
      device: { type: "string", default: "xpu" }, seed: { type: "string", default: "20261112" },
      "max-depth": { type: "string", default: "96" }, "check-only": { type: "boolean", default: false }
    }
  });
  if (positionals.length) throw new Error(`unexpected positional arguments: ${positionals.join(" ")}`);
  if (!values.cases || !values.checkpoint || !values["checkpoint-sha256"] || !values.output || !values.progress) {
    throw new Error("requires --cases, --checkpoint, --checkpoint-sha256, --output and --progress");
  }
  const casePath = resolve(values.cases);
  const checkpoint = resolve(values.checkpoint);
  const output = resolve(values.output);
  const progress = resolve(values.progress);
  if (!existsSync(casePath) || !existsSync(checkpoint)) throw new Error("case file or checkpoint does not exist");
  if (existsSync(output) || existsSync(`${output}.tmp`) || existsSync(progress) || existsSync(`${progress}.tmp`)) {
    throw new Error("refusing to overwrite probe output or progress");
  }
  const checkpointSha256 = sha256File(checkpoint);
  if (checkpointSha256 !== values["checkpoint-sha256"].toLowerCase()) throw new Error("checkpoint SHA256 mismatch");
  const mode = probeMode(values.budgets, values.reference, values["reference-sha256"]);
  const budgets: number[] = [...mode.budgets];
  const seed = Number(values.seed);
  const maxDepth = Number(values["max-depth"]);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be uint32");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 512) throw new Error("max-depth must be 1..512");

  const rawCases = readFileSync(casePath, "utf8");
  const suite = JSON.parse(rawCases) as ProbeSuite;
  const base = createEnvironment(undefined, { includeTemporaryRoundLimit: false });
  if (suite.schemaVersion !== 1 || suite.fingerprint !== base.fingerprint || suite.cases.length !== 6
      || suite.constraints?.bestMoveLabels !== false) {
    throw new Error("case suite schema, fingerprint, count or non-label status mismatch");
  }
  const casesSha256 = createHash("sha256").update(rawCases).digest("hex");
  let reference: ReferenceReport | undefined;
  let referencePath: string | undefined;
  let referenceSha256: string | undefined;
  if (mode.kind === "reference-extension") {
    referencePath = resolve(mode.reference);
    if (!existsSync(referencePath)) throw new Error("reference report does not exist");
    referenceSha256 = sha256File(referencePath);
    if (referenceSha256 !== mode.referenceSha256) throw new Error("reference report SHA256 mismatch");
    reference = JSON.parse(readFileSync(referencePath, "utf8")) as ReferenceReport;
    validateReferenceReport(reference, {
      checkpoint, checkpointSha256, fingerprint: base.fingerprint, casesSha256, seed, maxDepth,
      cases: suite.cases.map((entry) => ({ id: entry.id, stateSha256: entry.stateSha256 }))
    });
  }
  if (values["check-only"]) {
    console.log(JSON.stringify({ validated: true, mode: mode.kind, budgets, checkpointSha256,
      fingerprint: base.fingerprint, casesSha256,
      ...(referencePath ? { reference: referencePath, referenceSha256 } : {}) }));
    return;
  }
  const service = new InferenceService(checkpoint, base.fingerprint, values.device, 32, 2, "serve_hex.py");
  const startedAt = new Date().toISOString();
  const caseResults: Array<Record<string, unknown>> = [];
  atomicJson(progress, { schemaVersion: 1, status: "starting", startedAt,
    completedBudgetRuns: 0, totalBudgetRuns: suite.cases.length * budgets.length,
    checkpoint, checkpointSha256, output,
    ...(referencePath ? { reference: referencePath, referenceSha256 } : {}) });
  try {
    await service.start();
    for (let caseIndex = 0; caseIndex < suite.cases.length; caseIndex += 1) {
      const entry = suite.cases[caseIndex]!;
      if (entry.fingerprint !== base.fingerprint || createHash("sha256").update(canonicalJson(entry.state)).digest("hex") !== entry.stateSha256) {
        throw new Error(`case identity mismatch: ${entry.id}`);
      }
      const state = entry.state;
      const currentPlayer = state.players[state.turn.currentPlayerId];
      if (!currentPlayer || state.sequence !== entry.source.sequence || state.turn.round !== entry.source.round
          || state.turn.phase !== entry.source.phase || currentPlayer.seat !== entry.source.seat) {
        throw new Error(`case source boundary mismatch: ${entry.id}`);
      }
      const legal = base.legal(state);
      const actualKey = intentKey(entry.actualFirstIntent);
      if (legal.length !== entry.legalIntentCount || entry.actualFirstIntentLegal !== true
          || !legal.some((intent) => intentKey(intent) === actualKey)) {
        throw new Error(`case legal intent record mismatch: ${entry.id}`);
      }
      const root = base.encode(state);
      if (root.teamId !== base.team(state) || root.intents.length !== legal.length) {
        throw new Error(`root value perspective or legal encoding mismatch: ${entry.id}`);
      }
      const budgetResults: Array<Record<string, unknown> & { policy: number[]; selectedIntentKey: string }> = [];
      for (const budget of budgets) {
        const rootStatsBefore = { ...service.stats };
        const [rootEvaluation] = await service.evaluate([root]);
        if (!rootEvaluation) throw new Error("network omitted root evaluation");
        const { env, observation } = observeTransitions(base);
        const result = await search(env, state, (positions) => service.evaluate(positions), {
          simulations: budget, minimumSimulations: budget, seed: seed + caseIndex,
          temperature: 0, rootNoise: 0, maxDepth
        });
        if (result.stats.simulations !== budget || result.visits.reduce((sum, count) => sum + count, 0) !== budget) {
          throw new Error(`probe did not complete fixed budget ${budget} for ${entry.id}`);
        }
        const selectedIntentKey = intentKey(result.intent);
        const priorEntropy = -rootEvaluation.priors.reduce((total, probability) =>
          total + (probability > 0 ? probability * Math.log(probability) : 0), 0);
        const opponentResponseSteps = Object.entries(observation.stepCallsByTeam)
          .reduce((total, [teamId, count]) => total + (teamId === root.teamId ? 0 : count), 0);
        const rootPhaseExitSteps = observation.phaseExitSteps
          .filter((exit) => exit.parentSequence === state.sequence);
        budgetResults.push({
          requestedSimulations: budget,
          actualSimulations: result.stats.simulations,
          expanded: result.stats.expanded,
          maximumAtomicDepth: result.stats.maxDepth,
          elapsedMs: result.stats.elapsedMs,
          rootTeamId: root.teamId,
          rootNetworkValue: rootEvaluation.value,
          searchValue: result.value,
          selectedIntent: result.intent,
          selectedIntentKey,
          selectedMatchesRecordedIntent: selectedIntentKey === actualKey,
          selectedTransition: transitionSummary(base, state, result.intent),
          treeTransitions: observation,
          reachedDifferentPhase: Object.entries(observation.phaseTransitions)
            .some(([transition, count]) => count > 0 && transition !== `${state.turn.phase}->${state.turn.phase}`),
          reachedDifferentSeat: observation.seatSwitches > 0,
          reachedDifferentTeam: observation.teamSwitches > 0,
          opponentResponseSteps,
          exploredOpponentResponse: opponentResponseSteps > 0,
          phaseExitMeasurement: {
            rootReinforcementPoints: currentPlayer.reinforcementPoints,
            totalPhaseExitSteps: observation.phaseExitSteps.length,
            directRootPhaseExitSteps: rootPhaseExitSteps.length,
            nonRootPhaseExitSteps: observation.phaseExitSteps.length - rootPhaseExitSteps.length,
            reinforcementToActionSteps: observation.phaseExitSteps
              .filter((exit) => exit.fromPhase === "reinforcement" && exit.toPhase === "action").length,
            directRootEndPhaseIntents: rootPhaseExitSteps
              .filter((exit) => exit.intentType === "end-action-phase" || exit.intentType === "end-reinforcement-phase").length
          },
          policy: result.policy,
          visits: result.visits,
          policySummary: policySummary(result.policy, result.visits),
          networkPriorSummary: {
            entropyNats: priorEntropy,
            effectiveActionCount: Math.exp(priorEntropy),
            maximumShare: Math.max(...rootEvaluation.priors)
          },
          rootPolicyVsNetworkPriorJensenShannonNats: jensenShannon(result.policy, rootEvaluation.priors),
          rootDistribution: legal.map((intent, index) => ({
            index, intent, intentKey: intentKey(intent), prior: rootEvaluation.priors[index],
            visits: result.visits[index], policy: result.policy[index],
            selected: intentKey(intent) === selectedIntentKey,
            recorded: intentKey(intent) === actualKey
          })),
          inferenceDelta: {
            calls: service.stats.calls - rootStatsBefore.calls,
            positions: service.stats.positions - rootStatsBefore.positions,
            inferenceRoundtripMs: service.stats.inferenceRoundtripMs - rootStatsBefore.inferenceRoundtripMs
          }
        });
        const completedBudgetRuns = caseIndex * budgets.length + budgetResults.length;
        const update = { schemaVersion: 1, status: "running", startedAt,
          updatedAt: new Date().toISOString(), completedBudgetRuns,
          totalBudgetRuns: suite.cases.length * budgets.length,
          lastCompleted: { caseId: entry.id, budget, actualSimulations: result.stats.simulations,
            expanded: result.stats.expanded, maximumAtomicDepth: result.stats.maxDepth,
            elapsedMs: result.stats.elapsedMs }, inference: service.stats };
        atomicJson(progress, update);
        console.log(JSON.stringify({ type: "search-probe-budget", ...update.lastCompleted,
          completedBudgetRuns, totalBudgetRuns: update.totalBudgetRuns }));
      }
      const comparisons = budgetResults.slice(1).map((current, index) => {
        const previous = budgetResults[index]!;
        return {
          fromSimulations: previous.actualSimulations,
          toSimulations: current.actualSimulations,
          rootPolicyJensenShannonNats: jensenShannon(previous.policy, current.policy),
          selectedIntentChanged: previous.selectedIntentKey !== current.selectedIntentKey,
          searchValueDelta: Number(current.searchValue) - Number(previous.searchValue),
          maximumAtomicDepthDelta: Number(current.maximumAtomicDepth) - Number(previous.maximumAtomicDepth),
          expandedDelta: Number(current.expanded) - Number(previous.expanded)
        };
      });
      let reference64ToNew: Record<string, unknown> | undefined;
      if (reference) {
        const frozenCase = reference.caseResults.find((item) => item.id === entry.id)!;
        const frozen = frozenCase.budgets.find((item) => item.actualSimulations === 64)!;
        const current = budgetResults[0]!;
        reference64ToNew = {
          fromSimulations: 64,
          toSimulations: Number(current.actualSimulations),
          rootPolicyJensenShannonNats: jensenShannon(frozen.policy, current.policy),
          selectedIntentChanged: frozen.selectedIntentKey !== current.selectedIntentKey,
          maximumAtomicDepthDelta: Number(current.maximumAtomicDepth) - frozen.maximumAtomicDepth,
          expandedDelta: Number(current.expanded) - frozen.expanded,
          rootVisitedLegalFractionDelta: Number((current.policySummary as { visitedLegalFraction: number }).visitedLegalFraction)
            - frozen.policySummary.visitedLegalFraction,
          opponentResponseSteps64: frozen.opponentResponseSteps,
          opponentResponseStepsNew: Number(current.opponentResponseSteps),
          opponentResponseStepsDelta: Number(current.opponentResponseSteps) - frozen.opponentResponseSteps,
          exploredOpponentResponse64: frozen.exploredOpponentResponse,
          exploredOpponentResponseNew: Boolean(current.exploredOpponentResponse),
          reachedDifferentPhase64: frozen.reachedDifferentPhase,
          reachedDifferentPhaseNew: Boolean(current.reachedDifferentPhase),
          reachedDifferentTeam64: frozen.reachedDifferentTeam,
          reachedDifferentTeamNew: Boolean(current.reachedDifferentTeam)
        };
      }
      caseResults.push({
        id: entry.id,
        source: entry.source,
        stateSha256: entry.stateSha256,
        legalIntentCount: legal.length,
        rootPerspectiveChecked: true,
        recordedIntent: entry.actualFirstIntent,
        recordedIntentKey: actualKey,
        recordedTransition: transitionSummary(base, state, entry.actualFirstIntent),
        comparisonHypothesis: entry.comparisonHypothesis,
        bestIntentLabel: null,
        budgets: budgetResults,
        incrementalComparisons: comparisons,
        ...(reference64ToNew ? { reference64ToNew } : {})
      });
    }
    const report = {
      schemaVersion: 1,
      status: "complete",
      startedAt,
      finishedAt: new Date().toISOString(),
      scope: mode.kind === "baseline"
        ? "Search-budget information probe on six legal provisional states; no best-move labels and no playing-strength claim."
        : "256-simulation reference extension on the same six legal states; frozen 64-simulation rows are read, not rerun.",
      mode: mode.kind,
      checkpoint,
      checkpointSha256,
      modelFamily: "hex-graph-v1",
      fingerprint: base.fingerprint,
      cases: casePath,
      casesSha256,
      settings: { budgets, minimumSimulations: "equals each budget", thinkMs: 0, seed, maxDepth, temperature: 0, rootNoise: 0, device: values.device },
      ...(referencePath ? { reference: referencePath, referenceSha256 } : {}),
      inference: service.stats,
      caseResults,
      interpretationLimits: [
        "More search is not assumed to improve decisions; this report measures only stability and incremental tree information.",
        "The six replay states are provisional diagnostic cases, not validated tactical tests or best-action labels.",
        "Atomic reinforcement commands add one point at a time; phase/team transition counts expose how much of that sequence each budget actually traverses."
      ]
    };
    writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2), { flag: "wx" });
    renameSync(`${output}.tmp`, output);
    atomicJson(progress, { schemaVersion: 1, status: "complete", startedAt,
      finishedAt: report.finishedAt, completedBudgetRuns: suite.cases.length * budgets.length,
      totalBudgetRuns: suite.cases.length * budgets.length, output, inference: service.stats });
    console.log(JSON.stringify({ output, cases: caseResults.length, budgets, inference: service.stats }));
  } catch (error) {
    atomicJson(progress, { schemaVersion: 1, status: "failed", startedAt,
      failedAt: new Date().toISOString(), completedCases: caseResults.length,
      error: error instanceof Error ? error.message : String(error), inference: service.stats });
    throw error;
  } finally {
    service.close();
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
