import type { ModContentLock } from "./state.js";

/** Lifecycle of an online room before and after the map starts. */
export type LobbyPhase = "lobby" | "playing";

/** Transport-safe values; the SDK checks each field against its Mod schema. */
export type LobbyModSettings = Readonly<Record<string, Readonly<Record<string, number | boolean | string>>>>;

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
  /** Legacy soldier color selected in the lobby; spectators have no color. */
  readonly playerColorId: string | null;
  /** False means spectator, regardless of whether a seat has been assigned. */
  readonly participating: boolean;
  readonly ready: boolean;
  /** Content available to this browser for constructing the selected match. */
  readonly installedModIds: readonly string[];
  /** Installed package versions, keyed by Mod ID, for match compatibility checks. */
  readonly installedModVersions: Readonly<Record<string, string>>;
  /** Canonical SHA-256 identities, keyed by Mod ID, for exact compatibility checks. */
  readonly installedModContentHashes?: Readonly<Record<string, string>>;
  /** Selected map dependencies absent from this browser. Empty means playable. */
  readonly missingModIds: readonly string[];
}

export interface LobbyRoomState {
  readonly phase: LobbyPhase;
  /** Selected, validated map code shared by every lobby member. */
  readonly mapCode: string;
  readonly mapName: string;
  readonly mapPlayerCount: number;
  /** Required executable terrain Mod package IDs from the selected map code. */
  readonly requiredTerrainModIds: readonly string[];
  /** Current exact releases selected by the room host for this map's Mod IDs. */
  readonly effectiveTerrainModReleases: readonly ModContentLock[];
  /** Required Mods whose installed versions differ between participating members. */
  readonly modVersionMismatchIds: readonly string[];
  /** Room-host overrides; map-authored values and Mod defaults remain in the map/SDK. */
  readonly roomModSettings: LobbyModSettings;
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
  /** Name shown on the game board; optional for older relay messages. */
  readonly displayName?: string;
  /** Legacy soldier color selected for this match. */
  readonly playerColorId?: string;
}

export interface MatchStartPayload {
  /** Start all clients from the same map definition. */
  readonly mapCode: string;
  /** Release identities frozen for this match from the host's active Mods. */
  readonly effectiveTerrainModReleases: readonly ModContentLock[];
  readonly settings: LobbySettings;
  /** Exact same validated host overrides used by each browser's shared core. */
  readonly roomModSettings: LobbyModSettings;
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
