import { describe, expect, it } from "vitest";
import { resolveCurrentPlayerId } from "./room-role.js";

describe("current room role", () => {
  const assignments = [
    { sessionId: "old-session", playerId: "player-2" },
    { sessionId: "new-session", playerId: "player-1" }
  ];

  it("prefers the room's current seat over a stale match-start session mapping", () => {
    expect(resolveCurrentPlayerId("new-session", assignments, {
      received: true,
      playerId: "player-2"
    })).toBe("player-2");
  });

  it("does not let a stale assignment turn an explicit spectator into a player", () => {
    expect(resolveCurrentPlayerId("new-session", assignments, {
      received: true,
      playerId: null
    })).toBeNull();
  });

  it("falls back to match-start when the current room role has not arrived", () => {
    expect(resolveCurrentPlayerId("old-session", assignments, {
      received: false,
      playerId: null
    })).toBe("player-2");
  });
});
