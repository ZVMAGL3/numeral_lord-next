import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { GameIntent, GameState } from "../../packages/game-core/src/index.js";
import { createEnvironment } from "./environment.js";
import { InferenceService, type FlushMode } from "./runtime.js";
import { jensenShannon, observeTransitions, policySummary } from "./search-probe.js";
import { search } from "./search.js";

const FIXED_SEED = 20261112;
const FIXED_MAX_DEPTH = 96;
const FIXED_MAX_POSITIONS = 258;
const FIXED_SEARCH_POSITIONS = 257;
const FIXED_MAX_CONTINUATION_STEPS = 64;
const FIXED_MAX_SIMULATIONS = 256;

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

interface FrozenBudgetRow {
  actualSimulations: number;
  maximumAtomicDepth: number;
  opponentResponseSteps: number;
  exploredOpponentResponse: boolean;
  selectedIntentKey: string;
  policy: number[];
  visits: number[];
  policySummary: { visitedLegalFraction: number };
  inferenceDelta: { positions: number };
}

interface FrozenReport {
  schemaVersion: number;
  status: string;
  mode: string;
  checkpoint: string;
  checkpointSha256: string;
  modelFamily: string;
  fingerprint: string;
  cases: string;
  casesSha256: string;
  settings: { budgets: number[]; minimumSimulations: string; thinkMs: number; seed: number;
    maxDepth: number; temperature: number; rootNoise: number; device: string };
  caseResults: Array<{ id: string; stateSha256: string; budgets: FrozenBudgetRow[] }>;
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

export function validateFrozen256(reference: FrozenReport, expected: {
  checkpoint: string; checkpointSha256: string; fingerprint: string; casesPath: string; casesSha256: string;
  cases: Array<{ id: string; stateSha256: string; legalIntentCount: number }>;
}): void {
  if (reference.schemaVersion !== 1 || reference.status !== "complete" || reference.mode !== "reference-extension"
      || resolve(reference.checkpoint) !== resolve(expected.checkpoint)
      || reference.checkpointSha256 !== expected.checkpointSha256
      || reference.modelFamily !== "hex-graph-v1" || reference.fingerprint !== expected.fingerprint
      || resolve(reference.cases) !== resolve(expected.casesPath) || reference.casesSha256 !== expected.casesSha256
      || JSON.stringify(reference.settings.budgets) !== JSON.stringify([256])
      || reference.settings.minimumSimulations !== "equals each budget" || reference.settings.thinkMs !== 0
      || reference.settings.seed !== FIXED_SEED || reference.settings.maxDepth !== FIXED_MAX_DEPTH
      || reference.settings.temperature !== 0 || reference.settings.rootNoise !== 0
      || reference.settings.device !== "xpu" || reference.caseResults.length !== expected.cases.length) {
    throw new Error("frozen XPU256 baseline provenance or fixed settings mismatch");
  }
  for (const entry of expected.cases) {
    const candidate = reference.caseResults.find((item) => item.id === entry.id);
    const row = candidate?.budgets[0];
    if (!candidate || candidate.stateSha256 !== entry.stateSha256 || candidate.budgets.length !== 1
        || !row || row.actualSimulations !== 256 || row.inferenceDelta.positions !== FIXED_MAX_POSITIONS
        || row.policy.length !== entry.legalIntentCount || row.visits.length !== entry.legalIntentCount
        || !row.policy.every((value) => Number.isFinite(value) && value >= 0)) {
      throw new Error(`frozen XPU256 case row mismatch: ${entry.id}`);
    }
  }
}

export interface GateCase {
  id: string;
  baselineOpponentResponseSteps: number;
  accountingValid: boolean;
  legalTargetValid: boolean;
  completedSimulations: number;
  completedWithOpponentResponse: number;
  completedWithNaturalTerminal: number;
}

export function continuationGate(cases: GateCase[]): {
  pass: boolean; legalAndAccountingCases: number; responseAndEightSimulationCases: number;
  zeroResponseBaselineCases: number; zeroResponseBaselineCasesRecovered: number; failures: string[];
} {
  const legalAndAccountingCases = cases.filter((item) => item.accountingValid && item.legalTargetValid).length;
  const successful = (item: GateCase) => item.completedWithOpponentResponse > 0;
  const responseAndEightSimulationCases = cases.filter((item) => successful(item) && item.completedSimulations >= 8).length;
  const zeroBaseline = cases.filter((item) => item.baselineOpponentResponseSteps === 0);
  const zeroResponseBaselineCasesRecovered = zeroBaseline.filter(successful).length;
  const failures: string[] = [];
  if (cases.length !== 6) failures.push("gate requires exactly six frozen cases");
  if (legalAndAccountingCases !== 6) failures.push("not all cases have legal finite targets and exact accounting");
  if (zeroBaseline.length !== 3) failures.push("frozen baseline no longer has exactly three zero-response cases");
  if (zeroResponseBaselineCasesRecovered !== zeroBaseline.length) failures.push("a frozen zero-response case still lacks a completed opponent action");
  if (responseAndEightSimulationCases < 5) failures.push("fewer than five cases have a completed opponent action and at least eight completed root simulations");
  return { pass: failures.length === 0, legalAndAccountingCases, responseAndEightSimulationCases,
    zeroResponseBaselineCases: zeroBaseline.length, zeroResponseBaselineCasesRecovered, failures };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    cases: { type: "string" }, checkpoint: { type: "string" }, "checkpoint-sha256": { type: "string" },
    reference: { type: "string" }, "reference-sha256": { type: "string" },
    output: { type: "string" }, progress: { type: "string" }, device: { type: "string", default: "xpu" },
    "flush-mode": { type: "string", default: "timer" },
    "experimental-leaf-continuation": { type: "boolean", default: false },
    "check-only": { type: "boolean", default: false }
  } });
  if (positionals.length) throw new Error(`unexpected positional arguments: ${positionals.join(" ")}`);
  if (!values.cases || !values.checkpoint || !values["checkpoint-sha256"] || !values.reference
      || !values["reference-sha256"] || !values.output || !values.progress) {
    throw new Error("requires --cases, --checkpoint, --checkpoint-sha256, --reference, --reference-sha256, --output and --progress");
  }
  if (!values["experimental-leaf-continuation"]) {
    throw new Error("isolated prototype requires explicit --experimental-leaf-continuation");
  }
  if (values.device !== "xpu") throw new Error("frozen comparison requires --device xpu");
  if (values["flush-mode"] !== "timer") throw new Error("frozen comparison requires --flush-mode timer");
  const flushMode = values["flush-mode"] as FlushMode;
  const casePath = resolve(values.cases);
  const checkpoint = resolve(values.checkpoint);
  const referencePath = resolve(values.reference);
  const output = resolve(values.output);
  const progress = resolve(values.progress);
  if (![casePath, checkpoint, referencePath].every(existsSync)) throw new Error("case, checkpoint or reference file does not exist");
  if ([output, `${output}.tmp`, progress, `${progress}.tmp`].some(existsSync)) {
    throw new Error("refusing to overwrite phase-continuation output or progress");
  }
  const checkpointSha256 = sha256File(checkpoint);
  const referenceSha256 = sha256File(referencePath);
  if (checkpointSha256 !== values["checkpoint-sha256"].toLowerCase()) throw new Error("checkpoint SHA256 mismatch");
  if (referenceSha256 !== values["reference-sha256"].toLowerCase()) throw new Error("frozen reference SHA256 mismatch");
  const rawCases = readFileSync(casePath, "utf8");
  const suite = JSON.parse(rawCases) as ProbeSuite;
  const base = createEnvironment(undefined, { includeTemporaryRoundLimit: false });
  if (suite.schemaVersion !== 1 || suite.fingerprint !== base.fingerprint || suite.cases.length !== 6
      || suite.constraints?.bestMoveLabels !== false) {
    throw new Error("case suite schema, fingerprint, count or non-label status mismatch");
  }
  const casesSha256 = createHash("sha256").update(rawCases).digest("hex");
  const reference = JSON.parse(readFileSync(referencePath, "utf8")) as FrozenReport;
  validateFrozen256(reference, { checkpoint, checkpointSha256, fingerprint: base.fingerprint,
    casesPath: casePath, casesSha256,
    cases: suite.cases.map((entry) => ({ id: entry.id, stateSha256: entry.stateSha256,
      legalIntentCount: entry.legalIntentCount })) });
  if (values["check-only"]) {
    console.log(JSON.stringify({ validated: true, mode: "experimental-leaf-policy-continuation",
      checkpointSha256, referenceSha256, casesSha256, cases: 6,
      maximumNetworkPositionsPerRoot: FIXED_MAX_POSITIONS, maximumContinuationSteps: FIXED_MAX_CONTINUATION_STEPS }));
    return;
  }

  const service = new InferenceService(checkpoint, base.fingerprint, values.device, 32, 2, "serve_hex.py", flushMode);
  const startedAt = new Date().toISOString();
  const caseResults: Array<Record<string, unknown>> = [];
  atomicJson(progress, { schemaVersion: 1, status: "starting", startedAt, completedCases: 0,
    totalCases: 6, checkpoint, checkpointSha256, reference: referencePath, referenceSha256, output });
  try {
    await service.start();
    for (let caseIndex = 0; caseIndex < suite.cases.length; caseIndex++) {
      const entry = suite.cases[caseIndex]!;
      if (entry.fingerprint !== base.fingerprint
          || createHash("sha256").update(canonicalJson(entry.state)).digest("hex") !== entry.stateSha256) {
        throw new Error(`case identity mismatch: ${entry.id}`);
      }
      const state = entry.state;
      const player = state.players[state.turn.currentPlayerId];
      if (!player || state.sequence !== entry.source.sequence || state.turn.round !== entry.source.round
          || state.turn.phase !== entry.source.phase || player.seat !== entry.source.seat) {
        throw new Error(`case source boundary mismatch: ${entry.id}`);
      }
      const legal = base.legal(state);
      if (legal.length !== entry.legalIntentCount || !entry.actualFirstIntentLegal
          || !legal.some((intent) => intentKey(intent) === intentKey(entry.actualFirstIntent))) {
        throw new Error(`case legal intent record mismatch: ${entry.id}`);
      }
      const root = base.encode(state);
      if (root.teamId !== base.team(state) || root.intents.length !== legal.length) {
        throw new Error(`root acting-team perspective or legal encoding mismatch: ${entry.id}`);
      }
      const frozen = reference.caseResults.find((item) => item.id === entry.id)!.budgets[0]!;
      const statsBefore = { ...service.stats };
      const [rootEvaluation] = await service.evaluate([root]);
      if (!rootEvaluation) throw new Error("network omitted diagnostic root evaluation");
      const { env, observation } = observeTransitions(base);
      const result = await search(env, state, (positions) => service.evaluate(positions), {
        simulations: FIXED_MAX_SIMULATIONS, minimumSimulations: 1, seed: FIXED_SEED + caseIndex,
        temperature: 0, rootNoise: 0, maxDepth: FIXED_MAX_DEPTH,
        leafContinuation: { maximumAtomicSteps: FIXED_MAX_CONTINUATION_STEPS,
          evaluationBudget: FIXED_SEARCH_POSITIONS }
      });
      const leaf = result.stats.leafContinuation;
      if (!leaf) throw new Error("search did not report explicitly enabled continuation accounting");
      const inferenceDelta = {
        calls: service.stats.calls - statsBefore.calls,
        positions: service.stats.positions - statsBefore.positions,
        inferenceRoundtripMs: service.stats.inferenceRoundtripMs - statsBefore.inferenceRoundtripMs
      };
      const visitTotal = result.visits.reduce((sum, count) => sum + count, 0);
      const policyTotal = result.policy.reduce((sum, probability) => sum + probability, 0);
      const legalTargetValid = result.policy.length === legal.length && result.visits.length === legal.length
        && result.policy.every((probability) => Number.isFinite(probability) && probability >= 0)
        && Math.abs(policyTotal - 1) < 1e-8 && visitTotal === result.stats.simulations;
      const accountingValid = inferenceDelta.positions === leaf.evaluationPositions + 1
        && inferenceDelta.positions <= FIXED_MAX_POSITIONS && leaf.evaluationPositions <= FIXED_SEARCH_POSITIONS
        && leaf.attemptedSimulations === result.stats.simulations + leaf.discardedSimulations;
      if (!legalTargetValid || !accountingValid || !Number.isFinite(result.value)) {
        throw new Error(`target, value or neural-position accounting invalid: ${entry.id}`);
      }
      const observedOpponentSteps = Object.entries(observation.stepCallsByTeam)
        .reduce((total, [teamId, count]) => total + (teamId === root.teamId ? 0 : count), 0);
      const responseOrTerminal = leaf.completedWithOpponentResponse + leaf.completedWithNaturalTerminal > 0;
      const hasActualOpponentResponse = leaf.completedWithOpponentResponse > 0;
      const usableForFutureTraining = result.stats.simulations >= 8 && hasActualOpponentResponse && visitTotal > 0;
      const selectedIntentKey = intentKey(result.intent);
      caseResults.push({
        id: entry.id, source: entry.source, stateSha256: entry.stateSha256,
        legalIntentCount: legal.length, rootTeamId: root.teamId, rootPerspectiveChecked: true,
        comparisonHypothesis: entry.comparisonHypothesis, bestIntentLabel: null,
        selectedIntent: result.intent, selectedIntentKey, rootNetworkValue: rootEvaluation.value,
        searchValue: result.value, policy: result.policy, visits: result.visits,
        policySummary: policySummary(result.policy, result.visits),
        completedSimulations: result.stats.simulations, attemptedSimulations: leaf.attemptedSimulations,
        incompleteContinuations: leaf.discardedSimulations,
        incompleteByEvaluationBudget: leaf.discardedForEvaluationBudget,
        incompleteByStepLimit: leaf.discardedForStepLimit,
        incompleteEvaluationPositions: leaf.discardedEvaluationPositions,
        incompleteEvaluationPositionsTotal: leaf.discardedEvaluationPositions
          .reduce((sum, positions) => sum + positions, 0),
        completedWithOpponentResponse: leaf.completedWithOpponentResponse,
        completedWithNaturalTerminal: leaf.completedWithNaturalTerminal,
        hasActualOpponentResponse,
        continuationSteps: leaf.continuationSteps,
        continuationOpponentResponseSteps: leaf.opponentResponseSteps,
        observedEngineOpponentSteps: observedOpponentSteps,
        maximumAtomicTreeDepth: result.stats.maxDepth,
        expandedTreeNodes: result.stats.expanded,
        elapsedMs: result.stats.elapsedMs,
        inferenceDelta,
        accountingValid, legalTargetValid, usableForFutureTraining,
        frozen256: {
          selectedIntentKey: frozen.selectedIntentKey, selectedIntentChanged: selectedIntentKey !== frozen.selectedIntentKey,
          opponentResponseSteps: frozen.opponentResponseSteps,
          rootPolicyJensenShannonNats: jensenShannon(frozen.policy, result.policy),
          visitedLegalFraction: frozen.policySummary.visitedLegalFraction,
          visitedLegalFractionDelta: policySummary(result.policy, result.visits).visitedLegalFraction
            - frozen.policySummary.visitedLegalFraction,
          maximumAtomicDepth: frozen.maximumAtomicDepth,
          neuralPositions: frozen.inferenceDelta.positions
        },
        transitionObservation: observation
      });
      atomicJson(progress, { schemaVersion: 1, status: "running", startedAt, updatedAt: new Date().toISOString(),
        completedCases: caseResults.length, totalCases: 6, lastCompleted: {
          id: entry.id, completedSimulations: result.stats.simulations,
          incompleteContinuations: leaf.discardedSimulations,
          completedWithOpponentResponse: leaf.completedWithOpponentResponse,
          completedWithNaturalTerminal: leaf.completedWithNaturalTerminal,
          positions: inferenceDelta.positions, elapsedMs: result.stats.elapsedMs
        }, inference: service.stats });
      console.log(JSON.stringify({ type: "phase-continuation-case", id: entry.id,
        completedCases: caseResults.length, completedSimulations: result.stats.simulations,
        positions: inferenceDelta.positions, responseOrTerminal, hasActualOpponentResponse }));
    }
    const gateCases: GateCase[] = caseResults.map((result) => ({
      id: String(result.id),
      baselineOpponentResponseSteps: reference.caseResults
        .find((entry) => entry.id === String(result.id))!.budgets[0]!.opponentResponseSteps,
      accountingValid: Boolean(result.accountingValid), legalTargetValid: Boolean(result.legalTargetValid),
      completedSimulations: Number(result.completedSimulations),
      completedWithOpponentResponse: Number(result.completedWithOpponentResponse),
      completedWithNaturalTerminal: Number(result.completedWithNaturalTerminal)
    }));
    const gate = continuationGate(gateCases);
    const report = {
      schemaVersion: 1, status: "complete", startedAt, finishedAt: new Date().toISOString(),
      scope: "Isolated, explicitly enabled leaf-policy continuation probe on six frozen unlabeled states; no games, training, promotion or playing-strength claim.",
      mode: "experimental-leaf-policy-continuation", checkpoint, checkpointSha256,
      modelFamily: "hex-graph-v1", fingerprint: base.fingerprint,
      cases: casePath, casesSha256, reference: referencePath, referenceSha256,
      settings: { seed: FIXED_SEED, maximumSimulations: FIXED_MAX_SIMULATIONS,
        maximumNetworkPositionsPerRoot: FIXED_MAX_POSITIONS, searchNetworkPositionBudget: FIXED_SEARCH_POSITIONS,
        maximumContinuationSteps: FIXED_MAX_CONTINUATION_STEPS, maxDepth: FIXED_MAX_DEPTH,
        temperature: 0, rootNoise: 0, device: values.device, flushMode },
      inference: service.stats, gate, caseResults,
      interpretationLimits: [
        "The six replay states have no best-move labels; changed visits, values or selected intents do not establish better play.",
        "Incomplete continuations consume neural positions but create no backed-up simulation, root visit or learning sample.",
        "Natural terminal completion is backed up, but only an actually executed non-root-team action satisfies the opponent-response gates; an opponent action that itself terminates is counted in both fields.",
        "Passing the six-root gate only permits the separately reviewed 32-game paired comparison; it does not promote or alter G2."
      ]
    };
    writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2), { flag: "wx" });
    renameSync(`${output}.tmp`, output);
    atomicJson(progress, { schemaVersion: 1, status: "complete", startedAt, finishedAt: report.finishedAt,
      completedCases: 6, totalCases: 6, output, gate, inference: service.stats });
    console.log(JSON.stringify({ output, cases: 6, gate, inference: service.stats }));
  } catch (error) {
    atomicJson(progress, { schemaVersion: 1, status: "failed", startedAt, failedAt: new Date().toISOString(),
      completedCases: caseResults.length, error: error instanceof Error ? error.message : String(error),
      inference: service.stats });
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
