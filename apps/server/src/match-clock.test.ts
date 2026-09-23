import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_CODE, coreTerrainCatalog, createMatchFromMapCode } from "@numeral-lord/core-content";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";
import type { GameState, LobbySettings, PlayerId } from "@numeral-lord/game-core/node";
import {
  advanceMatchClocks,
  clockExpiration,
  rebaseMatchClock,
  remainingMatchSeconds,
  remainingTurnSeconds,
  startMatchClocks
} from "../../web/src/match-clock.js";

const settings: LobbySettings = {
  friendlyFire: false,
  turnTimeSeconds: 60,
  matchTimeMinutes: 30,
  randomizePositions: false
};
const initial = createMatchFromMapCode(DEFAULT_MAP_CODE, {
  terrains: { ...coreTerrainCatalog, ...oilFieldTerrainCatalog },
  terrainModIds: Object.fromEntries(oilFieldMod.terrains.map((terrain) => [terrain.id, oilFieldMod.id]))
});

function turn(state: GameState, phase: GameState["turn"]["phase"], playerId = state.turn.currentPlayerId, round = state.turn.round): GameState {
  return { ...state, turn: { ...state.turn, phase, currentPlayerId: playerId as PlayerId, round } };
}

describe("per-player match clocks", () => {
  it("does not refill step time after a move and gives reinforcement at least two seconds", () => {
    const start = startMatchClocks(initial, settings, 1_000);
    const moved = advanceMatchClocks(start, initial, initial, settings, 11_000);
    expect(remainingTurnSeconds(moved, "action", 11_000)).toBe(50);
    expect(remainingMatchSeconds(moved, settings, 11_000)).toBe(29 * 60 + 50);
    expect(clockExpiration(moved, "action", settings, 61_000)).toBe("step");

    const reinforcement = turn(initial, "reinforcement");
    const afterTimeout = advanceMatchClocks(moved, initial, reinforcement, settings, 61_000);
    expect(remainingTurnSeconds(afterTimeout, "reinforcement", 61_000)).toBe(2);
    expect(clockExpiration(afterTimeout, "reinforcement", settings, 63_000)).toBe("step");
  });

  it("early end of action preserves unused step time for reinforcement", () => {
    const start = startMatchClocks(initial, settings, 0);
    const reinforcement = turn(initial, "reinforcement");
    const afterManualEnd = advanceMatchClocks(start, initial, reinforcement, settings, 5_000);
    expect(remainingTurnSeconds(afterManualEnd, "reinforcement", 5_000)).toBe(55);
    expect(remainingTurnSeconds(afterManualEnd, "reinforcement", 60_000)).toBe(0);
  });

  it("only charges the player whose turn is active", () => {
    const start = startMatchClocks(initial, settings, 0);
    const playerTwo = "player-2" as PlayerId;
    const secondTurn = turn(initial, "action", playerTwo, 2);
    const afterFirst = advanceMatchClocks(start, initial, secondTurn, settings, 10_000);
    expect(afterFirst.bankRemainingMsByPlayer["player-1"]).toBe(1_790_000);
    expect(afterFirst.bankRemainingMsByPlayer["player-2"]).toBe(1_800_000);

    const thirdTurn = turn(initial, "action", initial.turn.currentPlayerId, 3);
    const afterSecond = advanceMatchClocks(afterFirst, secondTurn, thirdTurn, settings, 25_000);
    expect(afterSecond.bankRemainingMsByPlayer["player-1"]).toBe(1_790_000);
    expect(afterSecond.bankRemainingMsByPlayer["player-2"]).toBe(1_785_000);
  });

  it("exhausting a bank forces the current turn but later turns get two-second action time", () => {
    const shortBank = { ...settings, matchTimeMinutes: 1, turnTimeSeconds: 60 };
    const start = startMatchClocks(initial, shortBank, 0);
    expect(clockExpiration(start, "action", shortBank, 60_000)).toBe("match");
    const nextTurn = turn(initial, "action", initial.turn.currentPlayerId, 2);
    const overtime = advanceMatchClocks(start, initial, nextTurn, shortBank, 60_000);
    expect(overtime.overtimeTurn).toBe(true);
    expect(remainingTurnSeconds(overtime, "action", 60_000)).toBe(2);
    expect(clockExpiration(overtime, "action", shortBank, 60_001)).toBeNull();
    expect(clockExpiration(overtime, "action", shortBank, 62_000)).toBe("step");

    const reinforcement = turn(nextTurn, "reinforcement");
    const overtimeReinforcement = advanceMatchClocks(overtime, nextTurn, reinforcement, shortBank, 62_000);
    expect(remainingTurnSeconds(overtimeReinforcement, "reinforcement", 62_000)).toBe(2);
  });

  it("rebases cached relay clocks without giving late spectators fresh time", () => {
    const start = startMatchClocks(initial, settings, 1_000);
    // Host time 1 second, relay time 101 seconds. Thirty seconds later a
    // spectator receives the cached relay snapshot on a 1,000-second clock.
    const serverClock = rebaseMatchClock(start, 1_000, 101_000);
    const spectatorClock = rebaseMatchClock(serverClock, 131_000, 1_000_000);
    expect(remainingTurnSeconds(spectatorClock, "action", 1_000_000)).toBe(30);
    expect(remainingMatchSeconds(spectatorClock, settings, 1_000_000)).toBe(29 * 60 + 30);
  });
});
