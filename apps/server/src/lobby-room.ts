import { LobbyRoom, type IRoomCache } from "colyseus";

interface LobbyFilter {
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Colyseus' default LobbyRoom reads metadata before it rejects a room-name
 * mismatch. A public room without metadata can therefore break every filtered
 * lobby snapshot. Compare the name first and treat absent metadata as a miss.
 */
export function matchesLobbyFilter(room: Pick<IRoomCache, "name" | "metadata">, filter?: LobbyFilter): boolean {
  if (!filter) return true;
  if (filter.name !== room.name) return false;
  if (!filter.metadata) return true;

  const metadata = room.metadata;
  if (metadata === null || typeof metadata !== "object") return false;

  return Object.entries(filter.metadata).every(([field, expected]) =>
    (metadata as Record<string, unknown>)[field] === expected);
}

export class SafeLobbyRoom extends LobbyRoom {
  protected override filterItemForClient(room: IRoomCache, filter?: LobbyFilter): boolean {
    return matchesLobbyFilter(room, filter);
  }
}
