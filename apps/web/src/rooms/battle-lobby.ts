export interface BattleRoomListing {
  readonly roomId: string;
  readonly clients: number;
  readonly locked?: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type BattleRoomListingEvent =
  | { readonly type: "snapshot"; readonly rooms: readonly BattleRoomListing[] }
  | { readonly type: "upsert"; readonly room: BattleRoomListing }
  | { readonly type: "remove"; readonly roomId: string }
  | { readonly type: "reset" };

/** Apply authoritative LobbyRoom events without retaining entries from older connections. */
export function updateBattleRoomListings(
  current: readonly BattleRoomListing[],
  event: BattleRoomListingEvent
): BattleRoomListing[] {
  switch (event.type) {
    case "snapshot":
      return [...event.rooms];
    case "upsert":
      return [...current.filter((room) => room.roomId !== event.room.roomId), event.room];
    case "remove":
      return current.filter((room) => room.roomId !== event.roomId);
    case "reset":
      return [];
  }
}

/** Prefer a nearly full public staging room so strangers converge quickly. */
export function selectQuickMatchRoom(rooms: readonly BattleRoomListing[]): BattleRoomListing | undefined {
  return rooms
    .filter((room) => room.locked !== true
      && room.metadata.visibility === "public"
      && room.metadata.phase === "lobby"
      && typeof room.metadata.openSeats === "number"
      && room.metadata.openSeats > 0)
    .sort((left, right) => {
      const openSeatDifference = Number(left.metadata.openSeats) - Number(right.metadata.openSeats);
      return openSeatDifference || right.clients - left.clients;
    })[0];
}
