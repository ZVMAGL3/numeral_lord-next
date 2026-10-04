import { describe, expect, it } from "vitest";
import type { IRoomCache } from "colyseus";
import { matchesLobbyFilter } from "./lobby-room.js";

describe("lobby room filtering", () => {
  it("rejects a different room name before requiring its metadata", () => {
    const workshopRoom = { name: "workshop", roomId: "workshop", metadata: undefined } as unknown as IRoomCache;

    expect(matchesLobbyFilter(workshopRoom, { name: "pvp", metadata: { visibility: "public" } })).toBe(false);
  });

  it("safely skips a matching room that has no metadata instead of crashing the lobby", () => {
    const incompleteRoom = { name: "pvp", roomId: "incomplete", metadata: undefined } as unknown as IRoomCache;

    expect(matchesLobbyFilter(incompleteRoom, { name: "pvp", metadata: { visibility: "public" } })).toBe(false);
  });

  it("retains rooms whose requested metadata matches", () => {
    const publicRoom = { name: "pvp", roomId: "public", metadata: { visibility: "public", phase: "lobby" } } as IRoomCache;

    expect(matchesLobbyFilter(publicRoom, { name: "pvp", metadata: { visibility: "public" } })).toBe(true);
    expect(matchesLobbyFilter(publicRoom, { name: "pvp", metadata: { visibility: "private" } })).toBe(false);
  });
});
