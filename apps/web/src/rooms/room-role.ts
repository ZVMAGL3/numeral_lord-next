export interface SessionAssignment {
  readonly sessionId: string;
  readonly playerId: string;
}

export interface CurrentRoomRole {
  /** Distinguishes an explicit spectator role from a role message not received yet. */
  readonly received: boolean;
  readonly playerId: string | null;
}

/** Prefer the server's current-session role over a stale match-start session mapping. */
export function resolveCurrentPlayerId(
  sessionId: string | null,
  assignments: readonly SessionAssignment[],
  role: CurrentRoomRole
): string | null {
  if (role.received) return role.playerId;
  return assignments.find((assignment) => assignment.sessionId === sessionId)?.playerId ?? null;
}
