import { describe, expect, it } from "vitest";
import type { PlayerId } from "@numeral-lord/game-core";
import { getDisconnectedPlayerIds } from "./player-presence.js";

const players = [
  { id: "player-1" as PlayerId, seat: 1 },
  { id: "player-2" as PlayerId, seat: 2 }
] as const;

describe("match player presence", () => {
  it("maps disconnected room participants to match players by seat", () => {
    expect(getDisconnectedPlayerIds(players, [
      { seat: 1, participating: true, connected: true },
      { seat: 2, participating: true, connected: false }
    ])).toEqual(new Set(["player-2"]));
  });

  it("restores online state after reconnect and ignores spectators", () => {
    expect(getDisconnectedPlayerIds(players, [
      { seat: 1, participating: true, connected: false },
      { seat: 1, participating: true, connected: true },
      { seat: null, participating: false, connected: false }
    ])).toEqual(new Set());
  });
});
