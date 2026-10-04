export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type CellId = Brand<string, "CellId">;
export type PlayerId = Brand<string, "PlayerId">;
export type TeamId = Brand<string, "TeamId">;
export type UnitId = Brand<string, "UnitId">;

/** Immutable identity of the exact data-only Mod release a map was saved with. */
export interface ModContentLock {
  readonly id: string;
  readonly version: string;
  readonly contentHash: string;
}

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

/** A static relation attached to an enter/leave trigger on one cell. */
export interface CellTriggerLink {
  readonly relationId: string;
  /** The related cell for a directed link; omitted for cell-local triggers. */
  readonly relatedCellId?: CellId;
}

export interface CellTriggerSet {
  readonly enter: readonly CellTriggerLink[];
  readonly leave: readonly CellTriggerLink[];
}

export interface UnitState {
  readonly id: UnitId;
  readonly definitionId: string;
  readonly ownerId: PlayerId;
  readonly cellId: CellId;
  readonly strength: number;
  /** Mod-owned boolean tags, changed only by validated data-only rule effects. */
  readonly markers?: readonly string[];
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
  /** Counterattack usage is terrain-cell state, not unit identity state. */
  readonly counterattacksUsed: Readonly<Record<CellId, number>>;
}

export interface MatchSettings {
  readonly friendlyFire: boolean;
  /** Ordered ids of map-selected match-condition modules. Defaults to last-team-standing. */
  readonly matchConditionIds?: readonly string[];
  /** Resolved map defaults plus room overrides, kept with a replay/snapshot. */
  readonly modSettings?: Readonly<Record<string, Readonly<Record<string, number | boolean | string>>>>;
  /** Generic capability values resolved from Mod setting schemas, by terrain and capability ID. */
  readonly terrainCapabilityOverrides?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>>;
  /** Data-only Mod rule snapshot loaded with the selected map. */
  readonly modRuleSet?: {
    readonly patterns: readonly import("./spatial-pattern.js").SpatialPatternDefinition[];
    readonly rules: readonly import("./mod-rules.js").ModRuleDefinition[];
  };
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
  /** Static trigger/link metadata compiled at map load, indexed by trigger cell. */
  readonly cellTriggers?: Readonly<Record<CellId, CellTriggerSet>>;
  readonly units: Readonly<Record<UnitId, UnitState>>;
  readonly players: Readonly<Record<PlayerId, PlayerState>>;
  readonly teams: Readonly<Record<TeamId, TeamState>>;
}

export interface DerivedUnitState {
  readonly unitId: UnitId;
  readonly power: UnitPowerState;
}
