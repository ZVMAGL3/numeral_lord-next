export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type CellId = Brand<string, "CellId">;
export type PlayerId = Brand<string, "PlayerId">;
export type TeamId = Brand<string, "TeamId">;
export type UnitId = Brand<string, "UnitId">;

/** Every player completes actions first, then independently allocates points. */
export type MatchPhase = "action" | "reinforcement" | "finished";
export type UnitPowerState = "roaming" | "powered";

export interface HexCoordinate {
  readonly column: number;
  readonly row: number;
}

export interface MapCell {
  readonly id: CellId;
  readonly coordinate: HexCoordinate;
  readonly terrainId: string;
  readonly unitId?: UnitId;
}

export interface UnitState {
  readonly id: UnitId;
  readonly definitionId: string;
  readonly ownerId: PlayerId;
  readonly cellId: CellId;
  readonly strength: number;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly teamId: TeamId;
  readonly seat: number;
  readonly displayName: string;
  readonly color: string;
  readonly reinforcementPoints: number;
}

export interface TeamState {
  readonly id: TeamId;
  readonly playerIds: readonly PlayerId[];
}

export interface TurnState {
  readonly phase: MatchPhase;
  readonly currentPlayerId: PlayerId;
  readonly round: number;
  /** Units that may not take another action before the current turn ends. */
  readonly exhaustedUnitIds: readonly UnitId[];
  /** How many counterattacks each unit has spent in the current action phase. */
  readonly counterattacksUsed: Readonly<Record<UnitId, number>>;
}

export interface MatchSettings {
  readonly friendlyFire: boolean;
  /** Ordered ids of map-selected match-condition modules. Defaults to last-team-standing. */
  readonly matchConditionIds?: readonly string[];
}

/** Persisted settlement data shared by the browser, server and headless AI. */
export interface MatchResult {
  readonly winningTeamIds: readonly TeamId[];
  readonly message?: string;
}

export interface BoardState {
  readonly columns: number;
  readonly rows: number;
}

export interface GameState {
  readonly sequence: number;
  readonly settings: MatchSettings;
  readonly board: BoardState;
  readonly turn: TurnState;
  /** Present only after a victory-condition module finishes the match. */
  readonly result?: MatchResult;
  readonly cells: Readonly<Record<CellId, MapCell>>;
  readonly units: Readonly<Record<UnitId, UnitState>>;
  readonly players: Readonly<Record<PlayerId, PlayerState>>;
  readonly teams: Readonly<Record<TeamId, TeamState>>;
}

export interface DerivedUnitState {
  readonly unitId: UnitId;
  readonly power: UnitPowerState;
}
