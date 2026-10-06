import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEnvironment } from "./environment.js";
import { startPlayServer } from "./play-server.js";

test("local demo validates paused actions, stale snapshots and the acting seat", async () => {
  const server = await startPlayServer({ port: 0, simulations: 1, thinkMs: 1, device: "cpu" });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown) => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  try {
    const initial = await (await fetch(url + "/api/state")).json() as { state: { sequence: number }; legal: unknown[] };
    assert.ok(initial.legal.length > 0);
    await post("/api/pause", { paused: true });
    assert.equal((await post("/api/action", { index: 0, sequence: initial.state.sequence })).status, 400);
    await post("/api/pause", { paused: false });
    assert.equal((await post("/api/action", { index: 0, sequence: initial.state.sequence - 1 })).status, 400);
    assert.equal((await post("/api/action", { index: 0, sequence: initial.state.sequence })).status, 200);
    assert.equal((await post("/api/action", { index: 0, sequence: initial.state.sequence })).status, 400);
    assert.equal((await post("/api/new", { seat: 3 })).status, 400);
    await post("/api/new", { seat: 1, watch: true });
    assert.equal((await post("/api/action", { index: 0, sequence: 0 })).status, 400);
  } finally {
    await new Promise<void>((resolveRun) => server.close(() => resolveRun()));
  }
});

test("local demo loads fingerprinted action replay and seeks immutable frames", async () => {
  const server = await startPlayServer({ port: 0, simulations: 1, thinkMs: 1, device: "cpu" });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = createEnvironment();
  let state = env.initialState();
  const actions = [];
  for (let index = 0; index < 2; index += 1) {
    const intent = env.legal(state).find((candidate) => candidate.type === (state.turn.phase === "action"
      ? "end-action-phase" : "end-reinforcement-phase"))!;
    actions.push({ sequence: state.sequence, round: state.turn.round, phase: state.turn.phase,
      seat: state.players[state.turn.currentPlayerId]!.seat, intent });
    state = env.step(state, intent);
  }
  const post = (path: string, data: unknown) => fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  try {
    assert.equal((await post("/api/replay/load", { fingerprint: "wrong", actions })).status, 400);
    const loadedResponse = await post("/api/replay/load", { fingerprint: env.fingerprint, actions });
    assert.equal(loadedResponse.status, 200);
    const loaded = await loadedResponse.json() as { state: { sequence: number }; playback: { active: boolean; totalActions: number } };
    assert.equal(loaded.state.sequence, 0);
    assert.deepEqual(loaded.playback, { active: true, index: 0, totalActions: 2 });
    const steppedResponse = await post("/api/replay/seek", { index: 2 });
    const stepped = await steppedResponse.json() as { state: { sequence: number; turn: { currentPlayerId: string } } };
    assert.equal(steppedResponse.status, 200);
    assert.equal(stepped.state.sequence, 2);
    assert.equal(stepped.state.turn.currentPlayerId, "player-2");
    assert.equal((await post("/api/replay/seek", { index: 3 })).status, 400);
  } finally {
    await new Promise<void>((resolveRun) => server.close(() => resolveRun()));
  }
});

test("training history lists terminal scores and only serves replays from the active ruleset", async () => {
  const runsDirectory = mkdtempSync(join(tmpdir(), "hunxiao-ai-runs-"));
  const env = createEnvironment();
  const writeRun = (name: string, fingerprint: string) => {
    const directory = join(runsDirectory, name);
    mkdirSync(directory);
    writeFileSync(join(directory, "metadata.json"), JSON.stringify({ fingerprint }));
    writeFileSync(join(directory, "summary.json"), JSON.stringify({ fingerprint }));
    writeFileSync(join(directory, "game-0.json"), JSON.stringify({ id: 0, policies: ["search", "random"], candidateSeat: 2,
      selfPlay: false, actions: 40,
      opponentModel: "snapshot-2/iteration-2",
      rounds: 3, finished: true, truncated: false, winningTeamIds: ["team-1"], pointsByTeam: { "team-1": 7, "team-2": 5 },
      occupiedCellsByTeam: { "team-1": 4, "team-2": 3 },
      resultMessage: "第 3 回合结束，玩家 1 获胜。", elapsedMs: 1200 }));
    writeFileSync(join(directory, "game-0.replay.json"), JSON.stringify({ fingerprint, actions: [] }));
  };
  writeRun("current-run", env.fingerprint);
  writeRun("previous-rules", "old-fingerprint");
  const truncatedDirectory = join(runsDirectory, "truncated-run");
  mkdirSync(truncatedDirectory);
  writeFileSync(join(truncatedDirectory, "metadata.json"), JSON.stringify({ fingerprint: env.fingerprint }));
  writeFileSync(join(truncatedDirectory, "game-0.json"), JSON.stringify({ id: 0, policies: ["search", "random"], actions: 800,
    rounds: 24, finished: false, truncated: true, winningTeamIds: [], pointsByTeam: { "team-1": 73, "team-2": 251 },
    occupiedCellsByTeam: { "team-1": 2, "team-2": 2 }, elapsedMs: 120000 }));
  writeFileSync(join(truncatedDirectory, "game-0.replay.json"), JSON.stringify({ fingerprint: env.fingerprint, actions: [], result: { finished: false } }));
  const server = await startPlayServer({ port: 0, simulations: 1, thinkMs: 1, device: "cpu", runsDirectory });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const listing = await (await fetch(url + "/api/training/games")).json() as { fingerprint: string; totalGames: number; games: Record<string, unknown>[] };
    assert.equal(listing.fingerprint, env.fingerprint);
    assert.equal(listing.totalGames, 3);
    const currentGame = listing.games.find((game) => game.run === "current-run")!;
    const oldGame = listing.games.find((game) => game.run === "previous-rules")!;
    const truncatedGame = listing.games.find((game) => game.run === "truncated-run")!;
    assert.deepEqual(currentGame.pointsByTeam, { "team-1": 7, "team-2": 5 });
    assert.deepEqual(currentGame.occupiedCellsByTeam, { "team-1": 4, "team-2": 3 });
    assert.equal(currentGame.currentRules, true);
    assert.equal(currentGame.candidateSeat, 2);
    assert.equal(currentGame.selfPlay, false);
    assert.equal(currentGame.opponentModel, "snapshot-2/iteration-2");
    assert.equal(currentGame.replayAvailable, true);
    assert.equal(oldGame.currentRules, false);
    assert.equal(oldGame.replayAvailable, false);
    assert.equal(truncatedGame.finished, false);
    assert.equal(truncatedGame.truncated, true);
    const truncatedReplay = await (await fetch(url + "/api/training/replay?run=truncated-run&game=0")).json() as {
      result: { finished: boolean; truncated: boolean };
    };
    assert.deepEqual(truncatedReplay.result, { finished: false, truncated: true });
    assert.equal((await fetch(url + "/api/training/replay?run=current-run&game=0")).status, 200);
    assert.equal((await fetch(url + "/api/training/replay?run=previous-rules&game=0")).status, 409);
    assert.equal((await fetch(url + "/api/training/replay?run=..%2Foutside&game=0")).status, 400);

    const bulkDirectory = join(runsDirectory, "bulk-run");
    mkdirSync(bulkDirectory);
    writeFileSync(join(bulkDirectory, "metadata.json"), JSON.stringify({ fingerprint: env.fingerprint }));
    for (let id = 0; id < 205; id += 1) writeFileSync(join(bulkDirectory, `game-${id}.json`), JSON.stringify({ id }));
    const capped = await (await fetch(url + "/api/training/games")).json() as { totalGames: number; games: Record<string, unknown>[] };
    assert.equal(capped.totalGames, 208);
    assert.equal(capped.games.length, 200);
  } finally {
    await new Promise<void>((resolveRun) => server.close(() => resolveRun()));
    rmSync(runsDirectory, { recursive: true, force: true });
  }
});
