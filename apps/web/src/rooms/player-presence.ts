import type { LobbyMember, PlayerState } from "@numeral-lord/game-core";

/** Map live room presence to the match players by their stable seat. */
export function getDisconnectedPlayerIds(
  players: readonly Pick<PlayerState, "id" | "seat">[],
  members: readonly Pick<LobbyMember, "seat" | "participating" | "connected">[]
): ReadonlySet<PlayerState["id"]> {
  const onlineSeats = new Set(members
    .filter((member) => member.participating && member.seat !== null && member.connected)
    .map((member) => member.seat));
  const disconnectedSeats = new Set(members
    .filter((member) => member.participating && member.seat !== null && !member.connected && !onlineSeats.has(member.seat))
    .map((member) => member.seat));
  return new Set(players.filter((player) => disconnectedSeats.has(player.seat)).map((player) => player.id));
}
