import { describe, expect, it } from "vitest";
import { selectQuickMatchRoom, updateBattleRoomListings, type BattleRoomListing } from "./battle-lobby";

function room(
  roomId: string,
  metadata: Record<string, unknown>,
  clients = 1,
  locked = false
): BattleRoomListing {
  return { roomId, clients, locked, metadata };
}

describe("battle lobby quick match selection", () => {
  it("joins the fullest available public staging room first", () => {
    const selected = selectQuickMatchRoom([
      room("empty", { visibility: "public", phase: "lobby", openSeats: 3 }, 1),
      room("nearly-full", { visibility: "public", phase: "lobby", openSeats: 1 }, 1),
      room("playing", { visibility: "public", phase: "playing", openSeats: 2 }, 3)
    ]);
    expect(selected?.roomId).toBe("nearly-full");
  });

  it("skips private, full, and locked rooms", () => {
    expect(selectQuickMatchRoom([
      room("private", { visibility: "private", phase: "lobby", openSeats: 2 }),
      room("full", { visibility: "public", phase: "lobby", openSeats: 0 }),
      room("locked", { visibility: "public", phase: "lobby", openSeats: 2 }, 1, true)
    ])).toBeUndefined();
  });
});

describe("battle lobby room listing lifecycle", () => {
  it("replaces old cached entries when a fresh server snapshot arrives", () => {
    const stale = room("gone", { visibility: "public", phase: "lobby", openSeats: 1 });
    const current = room("live", { visibility: "public", phase: "lobby", openSeats: 1 });

    expect(updateBattleRoomListings([stale], { type: "snapshot", rooms: [current] })).toEqual([current]);
  });

  it("clears cached entries when the lobby connection is stopped or lost", () => {
    const cached = room("ghost", { visibility: "public", phase: "lobby", openSeats: 1 });

    expect(updateBattleRoomListings([cached], { type: "reset" })).toEqual([]);
  });

  it("applies room-created and room-removed events without duplicating entries", () => {
    const first = room("one", { visibility: "public", phase: "lobby", openSeats: 1 });
    const updated = room("one", { visibility: "public", phase: "lobby", openSeats: 0 });
    const created = room("two", { visibility: "public", phase: "lobby", openSeats: 1 });
    const afterUpdate = updateBattleRoomListings([first], { type: "upsert", room: updated });
    const afterCreate = updateBattleRoomListings(afterUpdate, { type: "upsert", room: created });

    expect(afterUpdate).toEqual([updated]);
    expect(updateBattleRoomListings(afterCreate, { type: "remove", roomId: "one" })).toEqual([created]);
  });
});
