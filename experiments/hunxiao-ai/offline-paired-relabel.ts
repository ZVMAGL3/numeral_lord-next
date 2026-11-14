import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { GameIntent, GameState } from "../../packages/game-core/src/index.js";
import { createEnvironment } from "./environment.js";
import { PHASE_ARENA, phaseArenaSearchOptions } from "./phase-continuation-arena.js";
import type { GameReport, TrainingSample } from "./protocol.js";
import { InferenceService } from "./runtime.js";
import { policySummary, jensenShannon } from "./search-probe.js";
import { search } from "./search.js";

const ROOTS = 64;
const ROOTS_PER_STRATUM = 8;
const POSITION_CAP_PER_ARM = 258;
const TOTAL_POSITION_CAP = ROOTS * POSITION_CAP_PER_ARM * 2;

interface ManifestRoot { ply: number; seat: number; phase: string; round: number; stratum: string;
  featureSha256: string; recordedPolicySupport: number }
interface ManifestGame { id: number; seed: number; split: "train" | "validation"; winner: string[];
  reportSha256: string; replaySha256: string; roots: ManifestRoot[] }
interface Manifest { schemaVersion: number; fingerprint: string; source: string; sourceMetadataSha256: string;
  sourceSampleSha256: string; sourceRows: number; sourceBytes: number; seed: number; games: ManifestGame[] }
export interface SelectedRoot extends ManifestRoot { id: string; selectionIndex: number; gameId: number; gameSeed: number;
  relabelSeed: number }
type Replay = { fingerprint: string; actions: NonNullable<GameReport["replay"]> };

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function sha256File(path: string): string { return sha256(readFileSync(path)); }
function intentKey(intent: GameIntent): string {
  return JSON.stringify(Object.entries(intent).sort(([a], [b]) => a.localeCompare(b)));
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
  renameSync(temporary, path);
}

export function selectRelabelRoots(manifest: Manifest): SelectedRoot[] {
  const games = manifest.games.filter((game) => game.split === "train").sort((a, b) => a.id - b.id);
  if (games.length !== 16) throw new Error("relabel manifest must contain exactly 16 training games");
  const strata = [...new Set(games.flatMap((game) => game.roots.map((root) => root.stratum)))].sort();
  if (strata.length !== 8) throw new Error("relabel manifest must contain exactly eight strata");
  const selected: SelectedRoot[] = [];
  const features = new Set<string>();
  for (const stratum of strata) {
    const picks: Array<{ game: ManifestGame; root: ManifestRoot }> = [];
    for (const game of games) {
      const root = game.roots.find((candidate) => candidate.stratum === stratum);
      if (root) picks.push({ game, root });
      if (picks.length === ROOTS_PER_STRATUM) break;
    }
    if (picks.length !== ROOTS_PER_STRATUM || new Set(picks.map((pick) => pick.game.id)).size !== ROOTS_PER_STRATUM) {
      throw new Error(`stratum ${stratum} cannot supply eight different training games`);
    }
    for (const { game, root } of picks) {
      if (features.has(root.featureSha256)) throw new Error(`duplicate selected feature ${root.featureSha256}`);
      features.add(root.featureSha256);
      const selectionIndex = selected.length;
      selected.push({ ...root, id: `${game.id}:${root.ply}`, selectionIndex, gameId: game.id,
        gameSeed: game.seed, relabelSeed: (manifest.seed + selectionIndex) >>> 0 });
    }
  }
  if (selected.length !== ROOTS) throw new Error("relabel selection must contain exactly 64 roots");
  return selected;
}

async function loadSelectedSamples(path: string, expectedSha: string, expectedRows: number,
  selected: SelectedRoot[], fingerprint: string): Promise<Map<string, { sample: TrainingSample; row: number }>> {
  const wanted = new Set(selected.map((root) => root.id));
  const found = new Map<string, { sample: TrainingSample; row: number }>();
  const digest = createHash("sha256");
  const input = createReadStream(path);
  input.on("data", (chunk: Buffer) => digest.update(chunk));
  let rows = 0;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    rows++;
    const sample = JSON.parse(line) as TrainingSample;
    if (sample.schemaVersion !== 1 || sample.fingerprint !== fingerprint) throw new Error(`invalid sample schema at row ${rows}`);
    const id = `${sample.gameId}:${sample.ply}`;
    if (wanted.has(id)) {
      if (found.has(id)) throw new Error(`duplicate selected sample ${id}`);
      found.set(id, { sample, row: rows });
    }
  }
  if (rows !== expectedRows || digest.digest("hex") !== expectedSha) throw new Error("source sample row count or SHA256 mismatch");
  if (found.size !== selected.length) throw new Error("not every selected root has an archived sample");
  return found;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ strict: true, allowPositionals: true, options: {
    manifest: { type: "string" }, "manifest-sha256": { type: "string" }, samples: { type: "string" },
    "samples-sha256": { type: "string" }, checkpoint: { type: "string" }, "checkpoint-sha256": { type: "string" },
    selection: { type: "string" }, output: { type: "string" }, progress: { type: "string" },
    device: { type: "string", default: "xpu" }, "flush-mode": { type: "string", default: "timer" },
    "check-only": { type: "boolean", default: false }
  } });
  if (positionals.length) throw new Error(`unexpected positional arguments: ${positionals.join(" ")}`);
  if (!values.manifest || !values["manifest-sha256"] || !values.samples || !values["samples-sha256"]
      || !values.checkpoint || !values["checkpoint-sha256"] || !values.selection || !values.output || !values.progress) {
    throw new Error("missing required offline paired relabel argument");
  }
  if (values.device !== "xpu" || values["flush-mode"] !== "timer") throw new Error("paired relabel requires XPU timer inference");
  const manifestPath = resolve(values.manifest); const samplePath = resolve(values.samples);
  const checkpoint = resolve(values.checkpoint); const selectionPath = resolve(values.selection);
  const output = resolve(values.output); const progress = resolve(values.progress);
  for (const path of [manifestPath, samplePath, checkpoint]) if (!existsSync(path)) throw new Error(`missing input: ${path}`);
  for (const path of [selectionPath, `${selectionPath}.tmp`, output, `${output}.tmp`, progress, `${progress}.tmp`]) {
    if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
  }
  const manifestSha256 = sha256File(manifestPath); const sampleSha256 = sha256File(samplePath);
  const checkpointSha256 = sha256File(checkpoint);
  if (manifestSha256 !== values["manifest-sha256"].toLowerCase()) throw new Error("manifest SHA256 mismatch");
  if (sampleSha256 !== values["samples-sha256"].toLowerCase()) throw new Error("sample SHA256 mismatch");
  if (checkpointSha256 !== values["checkpoint-sha256"].toLowerCase()) throw new Error("checkpoint SHA256 mismatch");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const env = createEnvironment(undefined, { includeTemporaryRoundLimit: false });
  if (manifest.schemaVersion !== 1 || manifest.fingerprint !== env.fingerprint
      || manifest.sourceSampleSha256 !== sampleSha256 || manifest.games.length !== 20) {
    throw new Error("manifest schema, rules, source sample or game count mismatch");
  }
  const source = resolve(manifest.source);
  const metadataPath = join(source, "metadata.json");
  if (sha256File(metadataPath) !== manifest.sourceMetadataSha256) throw new Error("source metadata SHA256 mismatch");
  const selected = selectRelabelRoots(manifest);
  const samples = await loadSelectedSamples(samplePath, sampleSha256, manifest.sourceRows, selected, env.fingerprint);
  const states = new Map<string, GameState>();
  const rootTeams = new Map<string, string>();
  for (const game of manifest.games.filter((entry) => entry.split === "train")) {
    const reportPath = join(source, `game-${game.id}.json`); const replayPath = join(source, `game-${game.id}.replay.json`);
    if (sha256File(reportPath) !== game.reportSha256 || sha256File(replayPath) !== game.replaySha256) {
      throw new Error(`report or replay SHA mismatch for game ${game.id}`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as GameReport;
    const replay = JSON.parse(readFileSync(replayPath, "utf8")) as Replay;
    if (!report.finished || report.truncated || report.seed !== game.seed || replay.fingerprint !== env.fingerprint
        || replay.actions.length !== report.actions || JSON.stringify(report.winningTeamIds) !== JSON.stringify(game.winner)) {
      throw new Error(`archived game metadata mismatch for game ${game.id}`);
    }
    const gameRoots = selected.filter((root) => root.gameId === game.id);
    let state = env.initialState();
    for (const action of replay.actions) {
      const id = `${game.id}:${state.sequence}`;
      const root = gameRoots.find((candidate) => candidate.id === id);
      if (root) {
        const archived = samples.get(id)!.sample;
        const encoded = env.encode(state);
        const features = JSON.stringify([encoded.observation, encoded.global, encoded.candidates]);
        if (state.turn.round !== root.round || state.turn.phase !== root.phase
            || state.players[state.turn.currentPlayerId]?.seat !== root.seat || sha256(features) !== root.featureSha256
            || features !== JSON.stringify([archived.observation, archived.global, archived.candidates])
            || encoded.intents.findIndex((intent) => intentKey(intent) === intentKey(action.intent)) < 0
            || archived.policy.length !== encoded.intents.length) {
          throw new Error(`selected root replay/sample/legal-order mismatch at ${id}`);
        }
        states.set(id, state);
        rootTeams.set(id, encoded.teamId);
      }
      if (action.sequence !== state.sequence || action.round !== state.turn.round || action.phase !== state.turn.phase
          || action.seat !== state.players[state.turn.currentPlayerId]?.seat) throw new Error(`replay boundary mismatch at ${id}`);
      state = env.step(state, action.intent);
    }
    if (state.turn.phase !== "finished" || gameRoots.some((root) => !states.has(root.id))) {
      throw new Error(`replay terminal or selected root coverage mismatch for game ${game.id}`);
    }
    for (const root of gameRoots) {
      const sample = samples.get(root.id)!.sample;
      const expectedValue = env.terminalValue(state, rootTeams.get(root.id)!);
      if (sample.valueSource !== "terminal" || sample.value === null || expectedValue === null
          || Math.abs(sample.value - expectedValue) > 1e-8) {
        throw new Error(`archived natural-terminal value mismatch at ${root.id}`);
      }
    }
  }
  const selection = { schemaVersion: 1, status: "locked",
    manifest: manifestPath, manifestSha256, samples: samplePath, sampleSha256, checkpoint, checkpointSha256,
    fingerprint: env.fingerprint, roots: selected.map((root) => ({ ...root, sampleRow: samples.get(root.id)!.row })),
    strata: Object.fromEntries([...new Set(selected.map((root) => root.stratum))].sort().map((stratum) => [stratum,
      selected.filter((root) => root.stratum === stratum).map((root) => ({ id: root.id, gameId: root.gameId, ply: root.ply }))])) };
  const selectionSha256 = sha256(JSON.stringify(selection, null, 2));
  if (values["check-only"]) {
    console.log(JSON.stringify({ validated: true, roots: selected.length, strata: Object.keys(selection.strata).length,
      selectionSha256, manifestSha256, sampleSha256, checkpointSha256, gpuStarted: false }));
    return;
  }
  atomicJson(selectionPath, selection);
  atomicJson(progress, { schemaVersion: 1, status: "selection-locked", selection: selectionPath,
    selectionSha256, completedRoots: 0, totalRoots: ROOTS });
  const service = new InferenceService(checkpoint, env.fingerprint, "xpu", 32, 2, "serve_hex.py", "timer");
  const results: Array<Record<string, unknown>> = [];
  const startedAt = new Date().toISOString();
  try {
    await service.start();
    for (const root of selected) {
      const state = states.get(root.id)!; const legal = env.legal(state);
      const runArm = async (arm: "atomic" | "continuation") => {
        let positions = 0; const before = { ...service.stats }; const started = performance.now();
        const result = await search(env, state, async (batch) => {
          if (positions + batch.length > POSITION_CAP_PER_ARM) throw new Error(`${root.id} ${arm} exceeded position cap`);
          positions += batch.length; return service.evaluate(batch);
        }, phaseArenaSearchOptions(arm, root.relabelSeed));
        if (positions > POSITION_CAP_PER_ARM || service.stats.positions - before.positions !== positions) {
          throw new Error(`${root.id} ${arm} inference accounting mismatch`);
        }
        return { policy: result.policy, value: result.value, visits: result.visits,
          policySummary: policySummary(result.policy, result.visits), positions, elapsedMs: performance.now() - started,
          inferenceDelta: { calls: service.stats.calls - before.calls, positions: service.stats.positions - before.positions,
            inferenceRoundtripMs: service.stats.inferenceRoundtripMs - before.inferenceRoundtripMs }, stats: result.stats };
      };
      const atomic = await runArm("atomic"); const continuation = await runArm("continuation");
      const leaf = continuation.stats.leafContinuation!;
      const normalized = (policy: number[]) => policy.length === legal.length && policy.every((v) => Number.isFinite(v) && v >= 0)
        && Math.abs(policy.reduce((a, b) => a + b, 0) - 1) < 1e-8;
      const pairedValid = normalized(atomic.policy) && normalized(continuation.policy)
        && Number.isFinite(atomic.value) && Number.isFinite(continuation.value)
        && atomic.stats.simulations === PHASE_ARENA.atomicSimulations
        && atomic.visits.reduce((a, b) => a + b, 0) === atomic.stats.simulations
        && continuation.visits.reduce((a, b) => a + b, 0) === continuation.stats.simulations
        && continuation.stats.simulations >= 8 && leaf.completedWithOpponentResponse > 0
        && continuation.stats.simulations > 0
        && (legal.length === 1 || continuation.visits.filter((visits) => visits > 0).length >= 2);
      results.push({ ...root, actingTeam: env.team(state), legalIntentCount: legal.length, legalIntents: legal, pairedValid,
        oldTarget: { policy: samples.get(root.id)!.sample.policy, value: samples.get(root.id)!.sample.value,
          valueSource: samples.get(root.id)!.sample.valueSource }, atomic, continuation,
        policyJensenShannonNats: jensenShannon(atomic.policy, continuation.policy) });
      atomicJson(progress, { schemaVersion: 1, status: "running", startedAt, updatedAt: new Date().toISOString(),
        selection: selectionPath, selectionSha256, completedRoots: results.length, totalRoots: ROOTS,
        lastCompleted: { id: root.id, stratum: root.stratum, pairedValid, atomicPositions: atomic.positions,
          continuationPositions: continuation.positions }, inference: service.stats });
      console.log(JSON.stringify({ type: "offline-paired-relabel-root", completedRoots: results.length,
        totalRoots: ROOTS, id: root.id, stratum: root.stratum, pairedValid,
        atomicPositions: atomic.positions, continuationPositions: continuation.positions }));
    }
    const byStratum = Object.fromEntries([...new Set(selected.map((root) => root.stratum))].sort().map((stratum) => {
      const rows = results.filter((row) => row.stratum === stratum);
      return [stratum, { roots: rows.length, pairedValid: rows.filter((row) => row.pairedValid).length }];
    }));
    const validRoots = results.filter((row) => row.pairedValid).length;
    const totalPositions = results.reduce((sum, row) => sum
      + Number((row.atomic as { positions: number }).positions) + Number((row.continuation as { positions: number }).positions), 0);
    const inferenceReconciled = service.stats.positions === totalPositions;
    const gate = { pass: validRoots >= 48 && Object.values(byStratum).every((row) => row.pairedValid >= 4)
      && totalPositions <= TOTAL_POSITION_CAP && inferenceReconciled, validRoots, requiredValidRoots: 48, byStratum,
      totalPositions, maximumTotalPositions: TOTAL_POSITION_CAP, inferenceReconciled };
    const report = { schemaVersion: 1, status: "complete", startedAt, finishedAt: new Date().toISOString(),
      scope: "64-root paired relabel diagnostic only; old policy/value targets and natural terminal labels are preserved read-only.",
      selection: selectionPath, selectionSha256, manifest: manifestPath, manifestSha256, samples: samplePath, sampleSha256,
      checkpoint, checkpointSha256, fingerprint: env.fingerprint,
      settings: { roots: ROOTS, rootsPerStratum: ROOTS_PER_STRATUM, positionCapPerArmPerRoot: POSITION_CAP_PER_ARM,
        totalPositionCap: TOTAL_POSITION_CAP, atomicSimulations: PHASE_ARENA.atomicSimulations,
        continuationSimulations: PHASE_ARENA.continuationSimulations, maximumContinuationSteps: PHASE_ARENA.maximumContinuationSteps,
        maxDepth: PHASE_ARENA.maxDepth, rootNoise: 0, temperature: 0, device: "xpu", flushMode: "timer" },
      inference: service.stats, gate, roots: results };
    writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2), { flag: "wx" }); renameSync(`${output}.tmp`, output);
    atomicJson(progress, { schemaVersion: 1, status: "complete", startedAt, finishedAt: report.finishedAt,
      completedRoots: ROOTS, totalRoots: ROOTS, output, gate, inference: service.stats });
    console.log(JSON.stringify({ output, gate, inference: service.stats }));
  } catch (error) {
    atomicJson(progress, { schemaVersion: 1, status: "failed", startedAt, failedAt: new Date().toISOString(),
      completedRoots: results.length, totalRoots: ROOTS, error: error instanceof Error ? error.message : String(error), inference: service.stats });
    throw error;
  } finally { service.close(); }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) void main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
