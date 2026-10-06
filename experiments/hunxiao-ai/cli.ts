import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createEnvironment, OBSERVATION_SIZE, GLOBAL_SIZE, CANDIDATE_SIZE } from "./environment.js";
import { InferenceService, pythonExecutable, type NetworkResult } from "./runtime.js";
import { effectiveLearningRoundLimit, effectiveSearchBudget, effectiveWorkerCount } from "./training-policy.js";
import type { GameOutput, GameReport, JobOptions, PolicyKind, PositionPayload } from "./protocol.js";

const experimentRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const env = createEnvironment(undefined, { includeTemporaryRoundLimit: false });
const policyKinds = ["random", "teacher", "search", "network"];
const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: {
  games: { type: "string", default: "4" }, workers: { type: "string", default: "4" },
  simulations: { type: "string", default: "32" }, "min-simulations": { type: "string", default: "1" },
  "max-actions": { type: "string", default: "10000" },
  "max-samples": { type: "string", default: "256" }, seed: { type: "string", default: "20261005" },
  "max-learning-rounds": { type: "string", default: "0" },
  policy: { type: "string", default: "search" }, opponent: { type: "string", default: "search" },
  checkpoint: { type: "string" }, "opponent-checkpoint": { type: "string" },
  "opponent-pool": { type: "string" }, "league-ratio": { type: "string", default: "auto" },
  bootstrap: { type: "string", default: "none" }, device: { type: "string", default: "auto" },
  name: { type: "string" }, steps: { type: "string", default: "400" },
  "batch-size": { type: "string", default: "64" }, "think-ms": { type: "string", default: "0" },
  iterations: { type: "string", default: "1" }, data: { type: "string" }, metadata: { type: "string" },
  output: { type: "string" }, resume: { type: "string" }, "seed-data": { type: "string" },
  "seed-metadata": { type: "string" }, port: { type: "string", default: "8060" },
  help: { type: "boolean", short: "h" }, replay: { type: "boolean", default: false }
} });

function integer(value: string | undefined, name: string, minimum = 1, maximum = 100000): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be integer ${minimum}..${maximum}`);
  return parsed;
}

function policy(value: string | undefined): PolicyKind {
  if (!policyKinds.includes(value ?? "")) throw new Error(`policy must be ${policyKinds.join("/")}`);
  return value as PolicyKind;
}

function runName(prefix: string): string {
  const name = flags.name ?? `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("name must contain only letters, numbers, _ and -");
  return name;
}

function learningRoundLimit(name = flags.name): number {
  // The already-running iterations 4 and 5 captured their old 30-round setting.
  // Iteration 6 onward ignores that stale argument from the long-lived PowerShell loop.
  const requested = integer(flags["max-learning-rounds"], "max-learning-rounds", 0, 1000);
  return effectiveLearningRoundLimit(name ?? "", requested);
}

function consecutivePromotionFailures(name: string): number {
  const match = name.match(/^hunxiao-selfplay-1000-iteration-(\d+)-\d{8}$/);
  if (!match) return 0;
  let failures = 0;
  const currentIteration = Number(match[1]);
  const runsRoot = join(experimentRoot, "runs");
  for (let iteration = currentIteration - 1; iteration >= 4 && failures < 2; iteration -= 1) {
    const exactRunName = new RegExp(`^hunxiao-selfplay-1000-iteration-${iteration}-\\d{8}$`);
    const previousRun = readdirSync(runsRoot, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && exactRunName.test(entry.name));
    if (!previousRun) break;
    const promotionPath = join(runsRoot, previousRun.name, "promotion.json");
    if (!existsSync(promotionPath)) break;
    const promotion = JSON.parse(readFileSync(promotionPath, "utf8")) as { newCheckpointPromoted?: boolean };
    if (promotion.newCheckpointPromoted) break;
    failures += 1;
  }
  return failures;
}

function metadata() {
  const files = ["environment.ts", "search.ts", "worker.ts", "training-policy.ts", "protocol.ts", "runtime.ts", "cli.ts", "tsconfig.json", "launch.mjs", "worker-bootstrap.mjs",
    "python/model.py", "python/train.py", "python/serve.py", "python/requirements-xpu.txt"];
  const implementationHashes = Object.fromEntries(files.map((path) => ["experiments/hunxiao-ai/" + path,
    createHash("sha256").update(readFileSync(join(experimentRoot, path))).digest("hex")]));
  return { schemaVersion: 1, fingerprint: env.fingerprint, featureSchema: env.featureSchema,
    learningWindow: { maxRounds: learningRoundLimit(),
      beyondWindow: learningRoundLimit() === 0 ? "all natural game rounds are eligible" : "positions after this round are omitted" },
    dimensions: { observation: OBSERVATION_SIZE, global: GLOBAL_SIZE, candidate: CANDIDATE_SIZE },
    ruleSnapshot: env.ruleSnapshot, implementationHashes, timestampUtc: new Date().toISOString(), kernel: "local shared TS source" };
}

interface RunSettings {
  name: string;
  games: number;
  workers: number;
  simulations: number;
  minimumSimulations: number;
  searchMultiplier: number;
  consecutiveNonPromotions: number;
  maxActions: number;
  maxLearningRounds: number;
  maxSamples: number;
  seed: number;
  policy: PolicyKind;
  opponent: PolicyKind;
  collect: boolean;
  bootstrap: JobOptions["bootstrap"];
  exploratory: boolean;
  thinkMs: number;
  checkpoint?: string;
  opponentCheckpoint?: string;
  opponentPool: string[];
  leagueRatio: number;
  recordReplay: boolean;
}

function automaticOpponentPool(name: string, candidateCheckpoint: string): string[] {
  const match = name.match(/^hunxiao-selfplay-1000-iteration-(\d+)-/);
  const iteration = Number(match?.[1] ?? 0);
  if (!match || iteration < 4) return [];

  const runsRoot = join(experimentRoot, "runs");
  const candidates: { iteration: number; path: string }[] = [];
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const node = entry.name.match(/^hunxiao-selfplay-1000-iteration-(\d+)-/);
    if (!node || Number(node[1]) >= iteration) continue;
    const nodeNumber = Number(node[1]);
    const path = join(runsRoot, entry.name, `iteration-${nodeNumber}.pt`);
    if (existsSync(path)) candidates.push({ iteration: nodeNumber, path });
  }
  const seedPath = join(runsRoot, "hunxiao-selfplay-1000-20261006-v3", "iteration-2.pt");
  if (existsSync(seedPath)) candidates.push({ iteration: 2, path: seedPath });
  const initialPath = join(runsRoot, "hunxiao-fast-prototype-20261006", "iteration-1.pt");
  if (existsSync(initialPath)) candidates.push({ iteration: 1, path: initialPath });

  const current = resolve(candidateCheckpoint);
  const unique = new Map<string, { iteration: number; path: string }>();
  for (const candidate of candidates) {
    const path = resolve(candidate.path);
    if (path !== current) unique.set(path, { ...candidate, path });
  }
  const ordered = [...unique.values()].sort((a, b) => b.iteration - a.iteration);
  const newest = ordered[0];
  const initial = unique.get(resolve(initialPath));
  if (newest && initial && newest.path !== initial.path) return [newest.path, initial.path];
  return ordered.slice(0, 2).map((item) => item.path);
}

function modelLabel(path: string): string {
  return `${basename(dirname(path))}/${basename(path).replace(/\.pt$/, "")}`;
}

async function runGames(settings: RunSettings) {
  const directory = join(experimentRoot, "runs", settings.name);
  if (existsSync(join(directory, "summary.json")) || existsSync(join(directory, "samples.jsonl"))) throw new Error(`run already exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  const metadataPath = join(directory, "metadata.json");
  const dataPath = join(directory, "samples.jsonl");
  const runMetadata = { ...metadata(), workerCount: settings.workers,
    search: { simulations: settings.simulations, minimumSimulations: settings.minimumSimulations,
      thinkMs: settings.thinkMs, adaptiveMultiplier: settings.searchMultiplier,
      consecutiveNonPromotions: settings.consecutiveNonPromotions } };
  writeFileSync(metadataPath, JSON.stringify(runMetadata, null, 2));
  // Isolated reproducibility archive; it is not a product Mod history.
  for (const path of [...Object.keys(env.ruleSnapshot.sourceHashes), ...Object.keys(runMetadata.implementationHashes)]) {
    const source = resolve(repositoryRoot, path);
    if (!source.startsWith(repositoryRoot)) throw new Error("rule snapshot path escaped repository");
    const destination = join(directory, "rules", path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  if (settings.collect) writeFileSync(dataPath, "");
  const services: Record<string, InferenceService> = {};
  const workers: Worker[] = [];
  const reports: GameReport[] = [];
  let nextJob = 0;
  let failed = false;
  const started = performance.now();
  try {
    if (settings.policy === "network" || settings.opponent === "network" || settings.bootstrap === "network"
      || (settings.opponentPool.length > 0 && settings.leagueRatio > 0)) {
      if (!settings.checkpoint) throw new Error("network policy/bootstrap requires --checkpoint");
      services.candidate = new InferenceService(resolve(settings.checkpoint), env.fingerprint, flags.device);
      await services.candidate.start();
      if (settings.opponentCheckpoint) {
        services.opponent = new InferenceService(resolve(settings.opponentCheckpoint), env.fingerprint, flags.device);
        await services.opponent.start();
      }
      for (let index = 0; index < settings.opponentPool.length && settings.leagueRatio > 0; index += 1) {
        const service = new InferenceService(settings.opponentPool[index]!, env.fingerprint, flags.device);
        services[`opponent-${index}`] = service;
        await service.start();
      }
    }
    const finished = new Promise<void>((resolveRun, rejectRun) => {
      const dispatch = (worker: Worker) => {
        if (nextJob >= settings.games || failed) return;
        const id = nextJob++;
        const candidateSeat = (id % 2 + 1) as 1 | 2;
        const period = 20;
        const leagueGamesPerPeriod = Math.round(settings.leagueRatio * period / 2) * 2;
        const useLeagueOpponent = !!settings.opponentCheckpoint
          || (settings.opponentPool.length > 0 && id % period < leagueGamesPerPeriod);
        const opponentIndex = settings.opponentPool.length ? Math.floor(id / 2) % settings.opponentPool.length : -1;
        const opponentSlot = settings.opponentCheckpoint ? "opponent"
          : useLeagueOpponent && opponentIndex >= 0 ? `opponent-${opponentIndex}` : undefined;
        const opponentPath = settings.opponentCheckpoint ?? (opponentIndex >= 0 ? settings.opponentPool[opponentIndex] : undefined);
        const policies: [PolicyKind, PolicyKind] = candidateSeat === 1
          ? [settings.policy, settings.opponent] : [settings.opponent, settings.policy];
        const job: JobOptions = { id, seed: settings.seed + id, simulations: settings.simulations,
          minimumSimulations: settings.minimumSimulations, maxActions: settings.maxActions,
          maxLearningRounds: settings.maxLearningRounds,
          policies, collect: settings.collect, bootstrap: settings.bootstrap, exploratory: settings.exploratory,
          maxSamples: settings.maxSamples, recordReplay: settings.recordReplay, candidateSeat,
          networkOpponent: useLeagueOpponent, ...(opponentSlot ? { opponentSlot } : {}),
          ...(useLeagueOpponent && opponentPath ? { opponentLabel: modelLabel(opponentPath) } : {}), thinkMs: settings.thinkMs };
        worker.postMessage({ type: "job", job });
      };
      const fail = (error: Error) => { if (!failed) { failed = true; rejectRun(error); } };
      for (let i = 0; i < Math.min(settings.workers, settings.games); i += 1) {
        const worker = new Worker(new URL("./worker-bootstrap.mjs", import.meta.url), { workerData: { includeTemporaryRoundLimit: false } });
        workers.push(worker);
        worker.on("error", fail);
        worker.on("exit", (code) => { if (code !== 0 && reports.length < settings.games) fail(new Error(`worker exited ${code}`)); });
        worker.on("message", (message: { type: string; fingerprint?: string; error?: string; output?: GameOutput;
          id?: number; slot?: string; positions?: PositionPayload[]; gameId?: number; actions?: number; round?: number }) => {
          if (message.type === "ready") {
            if (message.fingerprint !== env.fingerprint) { fail(new Error("worker rules fingerprint changed")); return; }
            dispatch(worker);
          } else if (message.type === "error") fail(new Error(message.error));
          else if (message.type === "inference") {
            const service = services[message.slot ?? "candidate"] ?? services.candidate;
            if (!service) { fail(new Error("no network service for inference request")); return; }
            void service.evaluate(message.positions!).then((results: NetworkResult[]) => worker.postMessage({ type: "inference-result", id: message.id, results }))
              .catch((error: unknown) => {
                worker.postMessage({ type: "inference-result", id: message.id, error: String(error) });
                fail(error instanceof Error ? error : new Error(String(error)));
              });
          } else if (message.type === "complete") {
            try {
              const { report, samples } = message.output!;
              const { replay: replayActions, ...gameSummary } = report;
              // Persist exact replays per game, then release their large action arrays instead of
              // retaining every full replay until a 1,000-game run has finished.
              reports.push(gameSummary);
              writeFileSync(join(directory, `game-${report.id}.json`), JSON.stringify(gameSummary, null, 2));
              if (replayActions) writeFileSync(join(directory, `game-${report.id}.replay.json`), JSON.stringify({
                schemaVersion: 1, fingerprint: env.fingerprint, map: env.normalizedMap,
                result: { finished: report.finished, winningTeamIds: report.winningTeamIds,
                  pointsByTeam: report.pointsByTeam, occupiedCellsByTeam: report.occupiedCellsByTeam,
                  resultMessage: report.resultMessage, truncated: report.truncated,
                  trainingFilteredAfterRound: report.trainingFilteredAfterRound,
                  trainingFilterMessage: report.trainingFilterMessage },
                notation: report.notation, actions: replayActions
              }, null, 2));
              if (settings.collect && samples.length) writeFileSync(dataPath, samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n", { flag: "a" });
              console.log(JSON.stringify({ game: report.id, actions: report.actions, finished: report.finished,
                learningEligible: report.learningEligible, trainingFilteredAfterRound: report.trainingFilteredAfterRound,
                winners: report.winningTeamIds, points: report.pointsByTeam, occupiedCells: report.occupiedCellsByTeam,
                result: report.resultMessage,
                samples: report.sampleCount, seconds: Math.round(report.elapsedMs) / 1000 }));
              if (reports.length === settings.games) resolveRun();
              else dispatch(worker);
            } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
          }
        });
      }
    });
    await finished;
    reports.sort((a, b) => a.id - b.id);
    const scoreBySeat = [1, 2].map((seat) => {
      const games = reports.filter((report) => report.id % 2 + 1 === seat);
      return { candidateSeat: seat, games: games.length, wins: games.filter((r) => r.finished && r.winningTeamIds.includes(`team-${seat}`)).length,
        losses: games.filter((r) => r.finished && r.winningTeamIds.length && !r.winningTeamIds.includes(`team-${seat}`)).length,
        naturalDraws: games.filter((r) => r.finished && !r.winningTeamIds.length).length,
        truncated: games.filter((r) => r.truncated).length,
        gamesWithNoTrainingSamples: games.filter((r) => !r.sampleCount).length,
        gamesFilteredAfterLearningWindow: games.filter((r) => r.trainingFilteredAfterRound).length };
    });
    const summaryReports = reports.map(({ replay: _replay, ...report }) => report);
    const summary = { schemaVersion: 1, fingerprint: env.fingerprint, settings, games: reports.length,
      naturalFinished: reports.filter((r) => r.finished).length, truncated: reports.filter((r) => r.truncated).length,
      gamesWithNoTrainingSamples: reports.filter((r) => !r.sampleCount).length,
      gamesFilteredAfterLearningWindow: reports.filter((r) => r.trainingFilteredAfterRound).length,
      actions: reports.reduce((sum, r) => sum + r.actions, 0), samples: reports.reduce((sum, r) => sum + r.sampleCount, 0),
      elapsedSeconds: (performance.now() - started) / 1000, scoreBySeat,
      inference: Object.fromEntries(Object.entries(services).map(([slot, service]) => [slot, service.stats])),
      budgetNote: settings.thinkMs > 0 ? "same soft per-command thinking budget; one evaluation can overshoot" : "equal simulation cap; wall-clock thinking time can differ",
      dataPath: settings.collect ? dataPath : null, metadataPath, reports: summaryReports };
    writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ summary: join(directory, "summary.json"), naturalFinished: summary.naturalFinished,
      truncated: summary.truncated, gamesWithNoTrainingSamples: summary.gamesWithNoTrainingSamples,
      gamesFilteredAfterLearningWindow: summary.gamesFilteredAfterLearningWindow, samples: summary.samples, scoreBySeat, inference: summary.inference }));
    return { directory, dataPath, metadataPath, summary };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    Object.values(services).forEach((service) => service.close());
  }
}

async function train(data: string, metadataPath: string, output: string, resume?: string): Promise<void> {
  const args = [fileURLToPath(new URL("./python/train.py", import.meta.url)), "--data", data, "--metadata", metadataPath,
    "--output", output, "--device", flags.device!, "--steps", flags.steps!, "--batch-size", flags["batch-size"]!, "--seed", flags.seed!];
  if (resume) args.push("--resume", resume);
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(pythonExecutable(), args, { stdio: "inherit", windowsHide: true });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`training exited ${code}`)));
  });
}

async function selectContinuousChampion(output: string, resume: string): Promise<void> {
  const resolvedOutput = resolve(output);
  const nodeName = basename(dirname(resolvedOutput));
  const node = nodeName.match(/^hunxiao-selfplay-1000-iteration-(\d+)-/);
  if (!node || Number(node[1]) < 4 || !existsSync(resolvedOutput)) return;

  const fixedSnapshots = [
    join(experimentRoot, "runs", "hunxiao-selfplay-1000-20261006-v3", "iteration-2.pt"),
    join(experimentRoot, "runs", "hunxiao-fast-prototype-20261006", "iteration-1.pt")
  ];
  const paths = [resolvedOutput, resolve(resume), ...automaticOpponentPool(nodeName, resolvedOutput), ...fixedSnapshots]
    .filter((path) => existsSync(path));
  const byContent = new Map<string, { path: string; incumbent: boolean }>();
  const resumeHash = createHash("sha256").update(readFileSync(resolve(resume))).digest("hex");
  for (const path of paths) {
    const resolved = resolve(path);
    const hash = createHash("sha256").update(readFileSync(resolved)).digest("hex");
    const previous = byContent.get(hash);
    if (previous) previous.incumbent ||= hash === resumeHash;
    else byContent.set(hash, { path: resolved, incumbent: hash === resumeHash });
  }
  const models = [...byContent.entries()].map(([hash, value]) => ({ hash, ...value, label: modelLabel(value.path), games: 0, points: 0 }));
  if (models.length < 2) return;

  let pair = 0;
  for (let first = 0; first < models.length; first += 1) {
    for (let second = first + 1; second < models.length; second += 1) {
      const firstModel = models[first]!;
      const secondModel = models[second]!;
      const arena: RunSettings = {
        name: `${nodeName}-promotion-pair-${first + 1}-vs-${second + 1}`,
        games: 24, workers: 8, simulations: 16, minimumSimulations: 4,
        searchMultiplier: 1, consecutiveNonPromotions: 0,
        maxActions: 10000, maxLearningRounds: 0, maxSamples: 0,
        seed: (integer(flags.seed, "seed", 0, 0xffffffff) + 80000 + pair * 1000) >>> 0,
        policy: "network", opponent: "network", collect: false, bootstrap: "none", exploratory: false, thinkMs: 50,
        checkpoint: firstModel.path, opponentCheckpoint: secondModel.path, opponentPool: [], leagueRatio: 0, recordReplay: true
      };
      const result = await runGames(arena);
      for (const report of result.summary.reports as GameReport[]) {
        const candidateWon = report.winningTeamIds.includes(`team-${report.candidateSeat}`);
        const drawOrTruncated = !report.finished || report.winningTeamIds.length === 0;
        firstModel.games += 1;
        secondModel.games += 1;
        const firstPoints = drawOrTruncated ? 0.5 : candidateWon ? 1 : 0;
        firstModel.points += firstPoints;
        secondModel.points += 1 - firstPoints;
      }
      pair += 1;
    }
  }

  const byScore = [...models].sort((a, b) => {
    const scoreDifference = b.points / Math.max(1, b.games) - a.points / Math.max(1, a.games);
    return Math.abs(scoreDifference) > 1e-12 ? scoreDifference : Number(b.incumbent) - Number(a.incumbent);
  });
  const candidateHash = createHash("sha256").update(readFileSync(resolvedOutput)).digest("hex");
  const candidate = byScore.find((model) => model.hash === candidateHash);
  const incumbent = byScore.find((model) => model.hash === resumeHash);
  const bestLegacy = byScore.find((model) => model.hash !== candidateHash);
  const minimumClearImprovement = 0.05;
  const scoreRate = (model: typeof byScore[number] | undefined) => model ? model.points / Math.max(1, model.games) : 0;
  const candidateVsIncumbent = scoreRate(candidate) - scoreRate(incumbent);
  const candidateClearsPromotionGate = !!candidate && !!incumbent && !!bestLegacy
    && candidateVsIncumbent >= minimumClearImprovement
    && scoreRate(candidate) - scoreRate(bestLegacy) >= minimumClearImprovement;
  const incumbentSafeFallback = incumbent && (!bestLegacy || scoreRate(bestLegacy) < scoreRate(incumbent) + minimumClearImprovement)
    ? incumbent : undefined;
  const selected = candidateClearsPromotionGate ? candidate! : incumbentSafeFallback ?? bestLegacy ?? byScore[0]!;
  if (selected.path !== resolvedOutput) copyFileSync(selected.path, resolvedOutput);
  const report = {
    method: "balanced pairwise checkpoint tournament",
    gamesPerPair: 24,
    minimumClearImprovement,
    candidateVsIncumbentScoreRate: candidateVsIncumbent,
    candidateClearsPromotionGate,
    modelCount: models.length,
    selected: selected.label,
    newCheckpointPromoted: selected.hash === candidateHash && candidateHash !== resumeHash,
    models: models.map(({ hash: _hash, path: _path, ...model }) => ({ ...model,
      scoreRate: model.points / Math.max(1, model.games) }))
  };
  writeFileSync(join(dirname(resolvedOutput), "promotion.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ champion: report.selected, newCheckpointPromoted: report.newCheckpointPromoted,
    models: report.models.map((model) => ({ label: model.label, scoreRate: model.scoreRate, games: model.games })) }));
}

function settings(name: string, collect: boolean): RunSettings {
  const bootstrap = flags.bootstrap as JobOptions["bootstrap"];
  if (!["none", "teacher", "network"].includes(bootstrap)) throw new Error("bootstrap must be none/teacher/network");
  const explicitPool = flags["opponent-pool"]?.split("|").filter(Boolean).map((path) => resolve(repositoryRoot, path));
  const opponentPool = explicitPool?.length ? explicitPool : automaticOpponentPool(name, flags.checkpoint ?? "");
  const ratioText = flags["league-ratio"] ?? "auto";
  const parsedRatio = ratioText === "auto" ? (opponentPool.length ? 0.4 : 0)
    : Number(ratioText);
  if (!Number.isFinite(parsedRatio) || parsedRatio < 0 || parsedRatio > 1) throw new Error("league-ratio must be auto or a number in [0, 1]");
  const consecutiveNonPromotions = consecutivePromotionFailures(name);
  const searchBudget = effectiveSearchBudget(name, {
    simulations: integer(flags.simulations, "simulations", 1, 4096),
    minimumSimulations: integer(flags["min-simulations"], "min-simulations", 1, 4096),
    thinkMs: integer(flags["think-ms"], "think-ms", 0, 60000)
  }, consecutiveNonPromotions);
  return { name, games: integer(flags.games, "games", 1, 10000),
    workers: effectiveWorkerCount(name, integer(flags.workers, "workers", 1, 20)),
    simulations: searchBudget.simulations, minimumSimulations: searchBudget.minimumSimulations,
    searchMultiplier: searchBudget.multiplier, consecutiveNonPromotions,
    maxActions: integer(flags["max-actions"], "max-actions", 1, 100000),
    maxLearningRounds: learningRoundLimit(name),
    maxSamples: integer(flags["max-samples"], "max-samples", 0, 10000), seed: integer(flags.seed, "seed", 0, 0xffffffff),
    policy: policy(flags.policy), opponent: policy(flags.opponent), collect, bootstrap, exploratory: collect,
    thinkMs: searchBudget.thinkMs, recordReplay: flags.replay!,
    opponentPool, leagueRatio: parsedRatio,
    ...(flags.checkpoint ? { checkpoint: flags.checkpoint } : {}),
    ...(flags["opponent-checkpoint"] ? { opponentCheckpoint: flags["opponent-checkpoint"] } : {}) };
}

async function main() {
  const command = positionals[0] ?? "help";
  if (flags.help || command === "help") {
    console.log(`昏晓 AI 实验（本地共享规则；不会操作线上房间）
  pnpm ai inspect
  pnpm ai arena --policy search --opponent random --games 4 --simulations 32 --min-simulations 1
  pnpm ai sample --bootstrap teacher --games 4 --workers 4 --name teacher-seed
  pnpm ai train --data <samples.jsonl> --metadata <metadata.json> --output <model.pt>
  pnpm ai selfplay --checkpoint <model.pt> --bootstrap network
  pnpm ai arena --policy network --checkpoint <model.pt> --opponent search --think-ms 100 --simulations 256
  pnpm ai pilot --iterations 1 --games 4 --workers 4 --simulations 16 --steps 300
  pnpm ai pilot --seed-data <samples.jsonl> --seed-metadata <metadata.json> (reuse a completed teacher-data run)
  pnpm ai play --checkpoint <model.pt> --device cpu
  pnpm ai:test
Options: --device auto/cpu/xpu --max-actions 10000 --max-learning-rounds 0 (unlimited) --max-samples 256 --seed 20261005 --replay
Self-play leagues accept --opponent-pool <checkpoint1|checkpoint2> and --league-ratio auto/0..1; continuous iterations use a 40% historical-opponent mix once snapshots are available.
Truncation defaults to no value label. Bootstrap labels are explicitly marked, never claimed as wins.`);
  } else if (command === "inspect") {
    const state = env.initialState();
    console.log(JSON.stringify({ ...metadata(), initial: { player: state.turn.currentPlayerId, phase: state.turn.phase,
      players: state.players, legalActions: env.legal(state).length } }, null, 2));
  } else if (command === "sample" || command === "arena" || command === "selfplay") {
    const options = settings(runName(command), command !== "arena");
    if (command === "selfplay") { options.policy = "network"; options.opponent = "network"; }
    await runGames(options);
  } else if (command === "train") {
    if (!flags.data || !flags.metadata || !flags.output) throw new Error("train requires --data, --metadata, --output");
    const output = resolve(flags.output);
    const resume = flags.resume ? resolve(flags.resume) : undefined;
    await train(resolve(flags.data), resolve(flags.metadata), output, resume);
    if (resume) await selectContinuousChampion(output, resume);
  } else if (command === "pilot") {
    const name = runName("pilot");
    const base = settings(name, true);
    let seedRun: { directory: string; dataPath: string; metadataPath: string };
    if (flags["seed-data"] || flags["seed-metadata"]) {
      if (!flags["seed-data"] || !flags["seed-metadata"]) throw new Error("pilot seed reuse requires both --seed-data and --seed-metadata");
      const dataPath = resolve(flags["seed-data"]);
      const metadataPath = resolve(flags["seed-metadata"]);
      if (!existsSync(dataPath) || !existsSync(metadataPath)) throw new Error("seed data or metadata does not exist");
      const seedMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { fingerprint?: string };
      if (seedMetadata.fingerprint !== env.fingerprint) throw new Error("seed data rules/map fingerprint mismatch");
      seedRun = { directory: dirname(dataPath), dataPath, metadataPath };
      console.log(JSON.stringify({ reusedTeacherData: dataPath, fingerprint: env.fingerprint }));
    } else {
      seedRun = await runGames({ ...base, name: `${name}-teacher`, policy: "search", opponent: "random", bootstrap: "teacher" });
    }
    let checkpoint = join(experimentRoot, "runs", name, "warmstart.pt");
    await train(seedRun.dataPath, seedRun.metadataPath, checkpoint);
    const iterations = integer(flags.iterations, "iterations", 0, 100);
    const stages = [{ stage: "teacher", run: seedRun.directory, checkpoint }];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const selfplay = await runGames({ ...base, name: `${name}-selfplay-${iteration + 1}`, policy: "network", opponent: "network",
        checkpoint, bootstrap: "network" });
      const previous = checkpoint;
      checkpoint = join(experimentRoot, "runs", name, `iteration-${iteration + 1}.pt`);
      await train(selfplay.dataPath, selfplay.metadataPath, checkpoint, previous);
      stages.push({ stage: `selfplay-${iteration + 1}`, run: selfplay.directory, checkpoint });
    }
    const arena = await runGames({ ...base, collect: false, exploratory: false, bootstrap: "none", name: `${name}-arena`,
      policy: "network", opponent: "search", checkpoint, recordReplay: true, thinkMs: base.thinkMs || 50 });
    const result = { fingerprint: env.fingerprint, checkpoint, stages, arena: arena.directory,
      note: "Pipeline pilot only. Teacher/bootstrap values are not human-strength evidence. No automatic claim or promotion to top strength." };
    mkdirSync(join(experimentRoot, "runs", name), { recursive: true });
    writeFileSync(join(experimentRoot, "runs", name, "pilot.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else if (command === "play") {
    const { startPlayServer } = await import("./play-server.js");
    await startPlayServer({ checkpoint: flags.checkpoint ? resolve(flags.checkpoint) : undefined,
      port: integer(flags.port, "port", 1024, 65535), simulations: integer(flags.simulations, "simulations", 1, 4096),
      device: flags.device!, thinkMs: integer(flags["think-ms"], "think-ms", 0, 60000) || 100 });
  } else throw new Error(`unknown command ${command}`);
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
