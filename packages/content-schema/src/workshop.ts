/** Versioned, JSON-only Mod object. Runtime behavior comes from core capability handlers. */
export type WorkshopKind = "map" | "terrain-mod";

export interface TerrainModDefinition {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly {
    readonly id: string;
    readonly target: "terrain";
    readonly defaultConfig: Readonly<Record<string, unknown>>;
  }[];
  readonly settings?: readonly TerrainModSetting[];
  readonly spatialPatterns?: readonly SpatialPatternDefinition[];
  readonly rules?: readonly ModRuleDefinition[];
  readonly terrains: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly capabilities: readonly {
      readonly id: string;
      readonly config?: Readonly<Record<string, unknown>>;
    }[];
  }[];
}

export type SpatialPredicate =
  | { readonly op: "terrain-has"; readonly capabilityId: string }
  | { readonly op: "unit-owner-is"; readonly owner: "actor" | "other" }
  | { readonly op: "unit-has-marker"; readonly marker: string }
  | { readonly op: "all" | "any"; readonly items: readonly SpatialPredicate[] }
  | { readonly op: "not"; readonly item: SpatialPredicate };

export type SpatialExpression =
  | { readonly op: "step"; readonly relation: "hex-neighbor"; readonly where: SpatialPredicate }
  | { readonly op: "sequence" | "either"; readonly items: readonly SpatialExpression[] }
  | { readonly op: "repeat"; readonly item: SpatialExpression; readonly min: number; readonly max: number };

export interface SpatialPatternDefinition {
  readonly id: string;
  readonly starts: SpatialPredicate;
  readonly expression: SpatialExpression;
  readonly result: { readonly entity: "cell" } | { readonly entity: "unit"; readonly distinctBy: "id" };
  readonly role?: "core/powered-units";
}

export type ModRuleTrigger = "state-changed" | "unit-enter" | "unit-leave" | "unit-destroyed" | "turn-start";
export type ModRuleTarget = { readonly scope: "trigger-unit" }
  | { readonly scope: "pattern-units"; readonly patternId: string };
export type ModRuleCondition =
  | { readonly op: "at-cell-matches"; readonly predicate: SpatialPredicate }
  | { readonly op: "pattern-includes-trigger-unit"; readonly patternId: string };
export type ModRuleEffect =
  | { readonly type: "change-strength"; readonly amount: number }
  | { readonly type: "grant-points"; readonly amount: number }
  | { readonly type: "exhaust-unit" }
  | { readonly type: "set-unit-marker"; readonly marker: string }
  | { readonly type: "remove-unit-marker"; readonly marker: string }
  | { readonly type: "sync-unit-marker"; readonly marker: string; readonly patternId: string };
export interface ModRuleDefinition {
  readonly id: string;
  readonly trigger: ModRuleTrigger;
  readonly target: ModRuleTarget;
  readonly conditions?: readonly ModRuleCondition[];
  readonly effects: readonly ModRuleEffect[];
}

export type TerrainModSetting =
  | (TerrainModSettingBase & { readonly kind: "integer"; readonly defaultValue: number; readonly min: number; readonly max: number })
  | (TerrainModSettingBase & { readonly kind: "boolean"; readonly defaultValue: boolean })
  | (TerrainModSettingBase & { readonly kind: "choice"; readonly defaultValue: string; readonly options: readonly string[] });

interface TerrainModSettingBase {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly target: { readonly terrainId: string; readonly capabilityId: string; readonly configKey: string };
}

export interface PublishMapRequest {
  readonly code: string;
  readonly description: string;
}

export interface PublishTerrainModRequest {
  readonly name: string;
  readonly description: string;
  readonly definition: TerrainModDefinition;
}

export interface WorkshopMapSummary {
  /** Opaque publication id assigned by the server, distinct from mapId. */
  readonly id: string;
  readonly mapId: string;
  readonly name: string;
  readonly description: string;
  readonly authorName: string;
  readonly createdAt: string;
  readonly players: number;
  /** Maps are JSON codes, not installable packages. */
  readonly requiredTerrainModIds: readonly string[];
}

export interface WorkshopTerrainModSummary {
  /** Opaque publication id assigned by the server, distinct from modId. */
  readonly id: string;
  readonly modId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly authorName: string;
  readonly createdAt: string;
  readonly terrainIds: readonly string[];
}

export interface WorkshopMapEntry extends WorkshopMapSummary {
  readonly code: string;
}

export interface WorkshopTerrainModEntry extends WorkshopTerrainModSummary {
  /** Missing only on legacy source-only records which must be republished. */
  readonly definition?: TerrainModDefinition;
}

export interface WorkshopCatalog {
  readonly maps: readonly WorkshopMapSummary[];
  readonly terrainMods: readonly WorkshopTerrainModSummary[];
}

export type WorkshopDetail =
  | { readonly kind: "map"; readonly entry: WorkshopMapEntry }
  | { readonly kind: "terrain-mod"; readonly entry: WorkshopTerrainModEntry };

export interface WorkshopGetRequest {
  readonly kind: WorkshopKind;
  readonly id: string;
}

export interface WorkshopPublished {
  readonly kind: WorkshopKind;
  readonly id: string;
}

export interface WorkshopError {
  readonly message: string;
}
