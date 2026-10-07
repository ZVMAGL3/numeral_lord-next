import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvironment } from "./environment.js";
import { createHeuristicEvaluator, search, type Evaluator } from "./search.js";
import { InferenceService } from "./runtime.js";
import { getPoweredUnitIds, type GameIntent, type GameState } from "../../packages/game-core/src/index.js";
import { coreTerrainCatalog } from "../../packages/core-content/src/index.js";
import type { GameReport } from "./protocol.js";

const RECENT_RUN_LIMIT = 5;
const RECENT_FILES_PER_RUN = 250;
const TRAINING_GAME_LIST_LIMIT = 100;

export async function startPlayServer(options: { checkpoint?: string | undefined; port: number; simulations: number; device: string; thinkMs: number; runsDirectory?: string }) {
  const env = createEnvironment();
  const runsDirectory = options.runsDirectory ?? fileURLToPath(new URL("./runs/", import.meta.url));
  const teacher = createHeuristicEvaluator(env);
  const service = options.checkpoint ? new InferenceService(options.checkpoint, env.fingerprint, options.device) : undefined;
  if (service) await service.start();
  const neural: Evaluator | undefined = service ? (positions) => service.evaluate(positions.map(({ observation, global, candidates }) => ({ observation, global, candidates }))) : undefined;
  let state = env.initialState();
  let humanSeat = 1;
  let watching = false;
  let paused = false;
  let thinking = false;
  let generation = 0;
  let error = "";
  let lastSearch: unknown = null;
  let seed = 20261005;
  let replayStates: GameState[] | undefined;
  let replayCursor = 0;

  function snapshot() {
    return { state, legal: env.legal(state), powered: [...getPoweredUnitIds(state, coreTerrainCatalog)], humanSeat, watching, paused, thinking,
      error, lastSearch, model: options.checkpoint ? basename(options.checkpoint) : "规则搜索基线", device: service?.stats.device ?? "CPU",
      fingerprint: env.fingerprint, conditions: env.normalizedMap.matchConditionIds,
      playback: replayStates ? { active: true, index: replayCursor, totalActions: replayStates.length - 1 } : { active: false, index: 0, totalActions: 0 } };
  }

  const isAiTurn = () => state.turn.phase !== "finished" && !paused
    && (watching || state.players[state.turn.currentPlayerId]!.seat !== humanSeat);

  function scheduleAi() {
    if (thinking || !isAiTurn()) return;
    const token = generation;
    thinking = true;
    void (async () => {
      let consecutive = 0;
      while (token === generation && isAiTurn()) {
        const before = state;
        const seat = state.players[state.turn.currentPlayerId]!.seat;
        const evaluator = watching && seat === 2 ? teacher : neural ?? teacher;
        const result = await search(env, state, evaluator, { simulations: options.simulations, seed: seed++, temperature: 0,
          timeLimitMs: options.thinkMs, maxDepth: 96 });
        if (token !== generation || state !== before || paused) break;
        state = env.step(state, result.intent);
        lastSearch = { seat, ...result.stats, value: result.value };
        consecutive += 1;
        // Keep the demo controllable; arena/self-play use their own explicit action budgets.
        if (!watching && consecutive >= 256 && isAiTurn()) {
          for (let i = 0; i < 2 && isAiTurn(); i += 1) {
            const ending = env.legal(state).find((intent) => intent.type.startsWith("end-"));
            if (ending) state = env.step(state, ending);
          }
          error = "本轮演示达到 256 动作上限，AI 已结束回合。";
        }
        await new Promise<void>((resolveRun) => setTimeout(resolveRun, watching ? 150 : 0));
      }
    })().catch((cause: unknown) => {
      if (token === generation) error = cause instanceof Error ? cause.message : String(cause);
    }).finally(() => {
      if (token === generation) { thinking = false; if (isAiTurn() && !error) scheduleAi(); }
    });
  }

  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (raw.length > 2_000_000) throw new Error("request too large"); }
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  }

  function readJson(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) return undefined;
    try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
    catch { return undefined; }
  }

  function listTrainingGames() {
    if (!existsSync(runsDirectory)) return { totalGames: 0, games: [] as Record<string, unknown>[] };
    const runs: { name: string; directory: string; gameFiles: string[]; runComplete: boolean; fingerprint: string | null; updatedAt: number }[] = [];
    let totalGames = 0;
    for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      const runDirectory = join(runsDirectory, entry.name);
      const metadata = readJson(join(runDirectory, "metadata.json"));
      let gameFiles: string[];
      try { gameFiles = readdirSync(runDirectory).filter((file) => /^game-\d+\.json$/.test(file)); }
      catch { continue; }
      totalGames += gameFiles.length;
      runs.push({ name: entry.name, directory: runDirectory, gameFiles, runComplete: existsSync(join(runDirectory, "summary.json")),
        fingerprint: typeof metadata?.fingerprint === "string" ? metadata.fingerprint : null,
        updatedAt: statSync(runDirectory).mtimeMs });
    }
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    const candidates: { run: typeof runs[number]; file: string; id: number; updatedAt: number }[] = [];
    for (const run of runs.slice(0, RECENT_RUN_LIMIT)) {
      const recentFiles = run.gameFiles
        .map((file) => ({ file, match: /^game-(\d+)\.json$/.exec(file) }))
        .filter((item): item is { file: string; match: RegExpExecArray } => item.match !== null)
        .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
        .slice(0, RECENT_FILES_PER_RUN);
      for (const { file, match } of recentFiles) {
        const gamePath = join(run.directory, file);
        candidates.push({ run, file, id: Number(match[1]), updatedAt: statSync(gamePath).mtimeMs });
      }
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    const games: Record<string, unknown>[] = [];
    for (const candidate of candidates.slice(0, TRAINING_GAME_LIST_LIMIT)) {
      const gamePath = join(candidate.run.directory, candidate.file);
        const game = readJson(gamePath) as Partial<GameReport> | undefined;
        if (!game || typeof game.id !== "number" || !Number.isSafeInteger(game.id)) continue;
        const replayFile = join(candidate.run.directory, `game-${game.id}.replay.json`);
        games.push({
          run: candidate.run.name,
          id: game.id,
          fingerprint: candidate.run.fingerprint,
          currentRules: candidate.run.fingerprint === env.fingerprint,
          policies: Array.isArray(game.policies) ? game.policies : [],
          candidateSeat: game.candidateSeat ?? (game.id % 2 + 1),
          selfPlay: game.selfPlay === true || (game.selfPlay === undefined
            && candidate.run.name.startsWith("hunxiao-selfplay-1000-iteration-") && !game.opponentModel),
          opponentModel: game.opponentModel ?? "",
          actions: game.actions ?? 0,
          rounds: game.rounds ?? 0,
          finished: game.finished === true,
          truncated: game.truncated === true,
          learningEligible: game.learningEligible !== false,
          trainingFilteredAfterRound: game.trainingFilteredAfterRound === true,
          trainingFilterMessage: game.trainingFilterMessage ?? "",
          winningTeamIds: Array.isArray(game.winningTeamIds) ? game.winningTeamIds : [],
          pointsByTeam: game.pointsByTeam ?? {},
          occupiedCellsByTeam: game.occupiedCellsByTeam ?? {},
          resultMessage: game.resultMessage ?? "",
          elapsedMs: game.elapsedMs ?? 0,
          replayAvailable: candidate.run.fingerprint === env.fingerprint && existsSync(replayFile),
          runComplete: candidate.run.runComplete,
          updatedAt: new Date(candidate.updatedAt).toISOString()
        });
    }
    return { totalGames, games };
  }

  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "GET" && request.url === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(readFileSync(fileURLToPath(new URL("./public/index.html", import.meta.url))));
        return;
      }
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      if (request.method === "GET" && request.url === "/api/state") response.end(JSON.stringify(snapshot()));
      else if (request.method === "GET" && request.url === "/api/training/games") {
        response.end(JSON.stringify({ fingerprint: env.fingerprint, ...listTrainingGames() }));
      } else if (request.method === "GET" && request.url?.startsWith("/api/training/replay?")) {
        const query = new URL(request.url, "http://127.0.0.1").searchParams;
        const run = query.get("run") ?? "";
        const gameId = Number(query.get("game"));
        if (!/^[a-zA-Z0-9_-]+$/.test(run) || !Number.isSafeInteger(gameId) || gameId < 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "训练对局编号无效。" }));
          return;
        }
        const replay = readJson(join(runsDirectory, run, `game-${gameId}.replay.json`));
        if (!replay) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "这局没有保存可回放的棋谱。" }));
          return;
        }
        if (replay.fingerprint !== env.fingerprint) {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "这份棋谱属于不同规则版本，不能在当前环境中回放。" }));
          return;
        }
        const storedGame = readJson(join(runsDirectory, run, `game-${gameId}.json`));
        const storedResult = replay.result && typeof replay.result === "object"
          ? replay.result as Record<string, unknown> : {};
        response.end(JSON.stringify({ ...replay, result: {
          ...storedResult,
          ...(typeof storedGame?.finished === "boolean" ? { finished: storedGame.finished } : {}),
          ...(typeof storedGame?.truncated === "boolean" ? { truncated: storedGame.truncated } : {}),
          ...(typeof storedGame?.resultMessage === "string" ? { resultMessage: storedGame.resultMessage } : {}),
          ...(typeof storedGame?.trainingFilteredAfterRound === "boolean"
            ? { trainingFilteredAfterRound: storedGame.trainingFilteredAfterRound } : {}),
          ...(typeof storedGame?.trainingFilterMessage === "string"
            ? { trainingFilterMessage: storedGame.trainingFilterMessage } : {})
        } }));
      }
      else if (request.method === "POST" && request.url === "/api/new") {
        const data = await body(request);
        if (data.seat !== 1 && data.seat !== 2) throw new Error("seat must be 1 or 2");
        generation += 1;
        state = env.initialState();
        replayStates = undefined;
        replayCursor = 0;
        humanSeat = data.seat;
        watching = data.watch === true;
        paused = false;
        thinking = false;
        error = "";
        lastSearch = null;
        seed = 20261005;
        response.end(JSON.stringify(snapshot()));
        scheduleAi();
      } else if (request.method === "POST" && request.url === "/api/replay/load") {
        const data = await body(request);
        if (data.fingerprint !== env.fingerprint) throw new Error("棋谱规则/特征指纹与当前实验环境不匹配。");
        if (!Array.isArray(data.actions) || data.actions.length > 10000) throw new Error("棋谱动作格式错误或超过 10000 步。");
        generation += 1;
        const frames = [env.initialState()];
        let replayState = frames[0]!;
        for (const [index, action] of data.actions.entries()) {
          if (!action || typeof action !== "object") throw new Error(`棋谱第 ${index + 1} 步格式错误。`);
          const item = action as Record<string, unknown>;
          const player = replayState.players[replayState.turn.currentPlayerId]!;
          if (item.sequence !== replayState.sequence || item.round !== replayState.turn.round
            || item.phase !== replayState.turn.phase || item.seat !== player.seat) {
            throw new Error(`棋谱第 ${index + 1} 步的序号、回合、阶段或席位不匹配。`);
          }
          replayState = env.step(replayState, item.intent as GameIntent);
          frames.push(replayState);
        }
        replayStates = frames;
        replayCursor = 0;
        state = frames[0]!;
        humanSeat = 1;
        watching = false;
        paused = true;
        thinking = false;
        error = "";
        lastSearch = null;
        response.end(JSON.stringify(snapshot()));
      } else if (request.method === "POST" && request.url === "/api/replay/seek") {
        const data = await body(request);
        if (!replayStates || !Number.isSafeInteger(data.index)
          || (data.index as number) < 0 || (data.index as number) >= replayStates.length) {
          throw new Error("棋谱步数超出范围。");
        }
        generation += 1;
        replayCursor = data.index as number;
        state = replayStates[replayCursor]!;
        paused = true;
        thinking = false;
        response.end(JSON.stringify(snapshot()));
      } else if (request.method === "POST" && request.url === "/api/pause") {
        const data = await body(request);
        paused = data.paused === true;
        response.end(JSON.stringify(snapshot()));
        if (!paused) scheduleAi();
      } else if (request.method === "POST" && request.url === "/api/action") {
        const data = await body(request);
        if (paused || watching || thinking || state.players[state.turn.currentPlayerId]!.seat !== humanSeat
          || state.turn.phase === "finished") throw new Error("当前不是你的行动阶段");
        if (data.sequence !== state.sequence) throw new Error("局面已更新，请重试");
        if (!Number.isInteger(data.index)) throw new Error("invalid action index");
        const intent = env.legal(state)[data.index as number];
        if (!intent) throw new Error("动作不在当前合法列表中");
        state = env.step(state, intent);
        error = "";
        response.end(JSON.stringify(snapshot()));
        scheduleAi();
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: "not found" })); }
    })().catch((cause: unknown) => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
    });
  });
  server.on("close", () => { generation += 1; service?.close(); });
  await new Promise<void>((resolveRun, rejectRun) => {
    server.once("error", rejectRun);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", rejectRun); resolveRun(); });
  });
  console.log(`昏晓 AI 本地试玩：http://127.0.0.1:${options.port}/ （${options.checkpoint ? basename(options.checkpoint) : "规则搜索"}）`);
  scheduleAi();
  return server;
}
