/** The online reset is a room transition; clients never reset only their own board. */
export function requestReturnToLobby(
  room: { send(type: string, payload: Record<string, never>): void } | undefined,
  isHost: boolean
): boolean {
  if (!room || !isHost) return false;
  room.send("match-return-to-lobby", {});
  return true;
}
