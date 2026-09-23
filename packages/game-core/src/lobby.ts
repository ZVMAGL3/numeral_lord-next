/** Lifecycle of an online room before and after the map starts. */
export type LobbyPhase = "lobby" | "playing";

/**
 * Room options are transport-level match setup, not UI state.  The selected
 * map remains responsible for declaring how many playable seats it contains.
 */
export interface LobbySettings {
  readonly friendlyFire: boolean;
  /** Seconds available for one operation; 0 disables the timer. */
  readonly turnTimeSeconds: number;
  /** Minutes available for the whole match; 0 disables the timer. */
  readonly matchTimeMinutes: number;
  /** Assign participating members to map seats only when the match starts. */
  readonly randomizePositions: boolean;
}

export interface LobbyMember {
  readonly sessionId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly connected: boolean;
  readonly isHost: boolean;
  /** A numbered map seat. Random-position lobbies leave this null until start. */
  readonly seat: number | null;
  /** False means spectator, regardless of whether a seat has been assigned. */
  readonly participating: boolean;
  readonly ready: boolean;
}

export interface LobbyRoomState {
  readonly phase: LobbyPhase;
  /** Selected, validated map code shared by every lobby member. */
  readonly mapCode: string;
  readonly mapName: string;
  readonly mapPlayerCount: number;
  readonly settings: LobbySettings;
  readonly members: readonly LobbyMember[];
  readonly startedAtEpochMs?: number;
}

export interface LobbyRolePayload extends LobbyMember {
  /** Maps a room member onto the player id already declared by the map. */
  readonly playerId?: string;
}

export interface MatchPlayerAssignment {
  readonly sessionId: string;
  readonly seat: number;
  readonly playerId: string;
}

export interface MatchStartPayload {
  /** Start all clients from the same map definition. */
  readonly mapCode: string;
  readonly settings: LobbySettings;
  readonly assignments: readonly MatchPlayerAssignment[];
  /** Server timestamp used to start every client's visible clocks together. */
  readonly startedAtEpochMs: number;
}

export const DEFAULT_LOBBY_SETTINGS: LobbySettings = {
  friendlyFire: false,
  turnTimeSeconds: 60,
  matchTimeMinutes: 30,
  randomizePositions: false
};

/** Transport safety limit only; it is not a visible game or lobby setting. */
export const MAX_ROOM_CAPACITY = 64;
