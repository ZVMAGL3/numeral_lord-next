import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { GameIntent } from "../../packages/game-core/src/index.js";
import { createEnvironment } from "./environment.js";
import type { GameReport, TrainingSample } from "./protocol.js";

const sourceGames = 20;
const samplesPerGame = 12;
const maxSourceRows = 5120;
const maxSourceBytes = 32 * 1024 * 1024;
const validationGames = new Set([3, 10, 16, 19]);
const seed = 20261114;

type Replay = { fingerprint: string; actions: NonNullable<GameReport["replay"]> };
type Pick = { ply: number; seat: number; phase: string; round: number; stratum: string;
  featureSha256: string; rank: string; recordedPolicySupport: number };

function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function hash(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function encodeKey(intent: GameIntent): string {
  return JSON.stringify(Object.entries(intent).sort(([first], [second]) => first.localeCompare(second)));
}

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error("Usage: prepare-reanalysis.ts <source directory> <new manifest>");
  const source = resolve(input);
  const env = createEnvironment();
  const metadataBytes = readFileSync(join(source, "metadata.json"));
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as { fingerprint: string };
  if (metadata.fingerprint !== env.fingerprint) throw new Error("Source rule fingerprint differs");
  const candidates = new Map<number, Map<number, TrainingSample>>();
  const sourceBytes = createHash("sha256");
  let rows = 0;
  let bytes = 0;
  const inputStream = createReadStream(join(source, "samples.jsonl"));
  inputStream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxSourceBytes) inputStream.destroy(new Error("Source byte limit exceeded"));
    else sourceBytes.update(chunk);
  });
  for await (const line of createInterface({ input: inputStream, crlfDelay: Infinity })) {
    const sample = JSON.parse(line) as TrainingSample;
    rows++;
    if (rows > maxSourceRows || sample.schemaVersion !== 1 || sample.fingerprint !== env.fingerprint
        || !Number.isInteger(sample.gameId) || sample.gameId < 0 || sample.gameId >= sourceGames
        || !Number.isInteger(sample.ply) || sample.ply < 0 || (sample.seat !== 1 && sample.seat !== 2)
        || sample.policy.length !== sample.candidates.length || sample.policy.length === 0
        || sample.policy.some((mass) => !Number.isFinite(mass) || mass < 0)
        || Math.abs(sample.policy.reduce((sum, mass) => sum + mass, 0) - 1) > 1e-4) {
      throw new Error(`Invalid archived sample at row ${rows}`);
    }
    const game = candidates.get(sample.gameId) ?? new Map<number, TrainingSample>();
    if (game.has(sample.ply)) throw new Error(`Duplicate sample at ${sample.gameId}:${sample.ply}`);
    game.set(sample.ply, sample);
    candidates.set(sample.gameId, game);
  }
  if (candidates.size !== sourceGames) throw new Error("Expected samples from exactly 20 games");

  const pickedFeatures = new Set<string>();
  const replayHashes = new Set<string>();
  const games = [];
  const ids = [...candidates.keys()].sort((first, second) =>
    Number(validationGames.has(second)) - Number(validationGames.has(first)) || first - second);
  for (const id of ids) {
    const replayPath = join(source, `game-${id}.replay.json`);
    const replayBytes = readFileSync(replayPath);
    const replay = JSON.parse(replayBytes.toString("utf8")) as Replay;
    const trajectory = hash(JSON.stringify(replay.actions));
    const reportPath = join(source, `game-${id}.json`);
    const report = read<GameReport>(reportPath);
    const samples = candidates.get(id)!;
    if (report.id !== id || !report.finished || report.truncated || replay.fingerprint !== env.fingerprint
        || replay.actions.length !== report.actions || samples.size !== report.sampleCount
        || replayHashes.has(trajectory)) {
      throw new Error(`Unexpected replay or report metadata for game ${id}`);
    }
    replayHashes.add(trajectory);

    let state = env.initialState();
    const strata = new Map<string, Pick[]>();
    for (const action of replay.actions) {
      const { sequence, round, phase } = action;
      if (sequence !== state.sequence || round !== state.turn.round || phase !== state.turn.phase
          || state.players[state.turn.currentPlayerId]?.seat !== action.seat) {
        throw new Error(`Invalid replay boundary in game ${id} at ${sequence}`);
      }
      const sample = samples.get(sequence);
      if (sample) {
        const encoded = env.encode(state);
        const features = JSON.stringify([encoded.observation, encoded.global, encoded.candidates]);
        const intentKey = encodeKey(action.intent);
        const chosenIndex = encoded.intents.findIndex((intent) => encodeKey(intent) === intentKey);
        if (action.seat !== sample.seat || chosenIndex < 0
            || features !== JSON.stringify([sample.observation, sample.global, sample.candidates])) {
          throw new Error(`Archived sample differs from legal replay at ${id}:${sequence}`);
        }
        const stratum = `${action.seat}/${phase}/${round <= 3 ? "opening" : "later"}`;
        const group = strata.get(stratum) ?? [];
        group.push({ ply: sequence, seat: action.seat, phase, round, stratum, featureSha256: hash(features),
          rank: hash(`${seed}/${id}/${sequence}`), recordedPolicySupport: sample.policy[chosenIndex]! });
        strata.set(stratum, group);
      }
      state = env.step(state, action.intent);
    }
    if (state.turn.phase !== "finished"
        || JSON.stringify(state.result?.winningTeamIds) !== JSON.stringify(report.winningTeamIds)
        || [...samples.keys()].some((ply) => ply >= replay.actions.length)) {
      throw new Error(`Replay terminal or sample coverage differs for game ${id}`);
    }

    const groups = [...strata.entries()].sort(([first], [second]) => first.localeCompare(second))
      .map(([, group]) => group.sort((first, second) => first.rank.localeCompare(second.rank)));
    const selected: Omit<Pick, "rank">[] = [];
    while (selected.length < samplesPerGame) {
      let advanced = false;
      for (const group of groups) {
        let pick = group.shift();
        while (pick && pickedFeatures.has(pick.featureSha256)) pick = group.shift();
        if (!pick) continue;
        const { rank: _, ...record } = pick;
        selected.push(record);
        pickedFeatures.add(pick.featureSha256);
        advanced = true;
        if (selected.length === samplesPerGame) break;
      }
      if (!advanced) throw new Error(`Too few distinct archived roots for game ${id}`);
    }
    games.push({ id, seed: report.seed, split: validationGames.has(id) ? "validation" : "train",
      winner: report.winningTeamIds, reportSha256: hash(readFileSync(reportPath)), replaySha256: hash(replayBytes),
      roots: selected.sort((first, second) => first.ply - second.ply) });
  }
  const manifest = { schemaVersion: 1, fingerprint: env.fingerprint, source, sourceMetadataSha256: hash(metadataBytes),
    sourceSampleSha256: sourceBytes.digest("hex"),
    sourceRows: rows, sourceBytes: bytes, seed, selection: "round-robin seat/phase/round strata within each game; exact feature dedup with validation priority",
    games: games.sort((first, second) => first.id - second.id) };
  writeFileSync(resolve(output), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ sourceRows: rows, games: games.length, trainRoots: (games.length - validationGames.size) * samplesPerGame,
    validationRoots: validationGames.size * samplesPerGame, uniqueRoots: pickedFeatures.size }));
}

await main();
