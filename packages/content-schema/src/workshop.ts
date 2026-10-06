import type {
  ModRuleCondition,
  ModRuleDefinition,
  ModRuleEffect,
  ModRuleTarget,
  ModRuleTrigger,
  SpatialExpression,
  SpatialPatternDefinition,
  SpatialPredicate
} from "@numeral-lord/game-core";

export type {
  ModRuleCondition,
  ModRuleDefinition,
  ModRuleEffect,
  ModRuleTarget,
  ModRuleTrigger,
  SpatialExpression,
  SpatialPatternDefinition,
  SpatialPredicate
} from "@numeral-lord/game-core";

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
  readonly visualAssets?: readonly { readonly id: string; readonly dataUrl: string }[];
  readonly terrain: {
    readonly capabilities: readonly {
      readonly id: string;
      readonly config?: Readonly<Record<string, unknown>>;
    }[];
    readonly visuals?: {
      readonly baseColor?: string;
      readonly baseAssetId?: string;
      /** Opacity of the base color or image, from fully transparent to opaque. */
      readonly baseOpacity?: number;
      /** Explicitly leaves the hex tile transparent, like the built-in void terrain. */
      readonly baseTransparent?: boolean;
      readonly overlay?: {
        readonly assetId: string;
        readonly scale: number;
        readonly opacity: number;
        readonly offsetX: number;
        readonly offsetY: number;
        readonly whenOccupied?: boolean;
      };
    };
  };
}

export type TerrainModSetting =
  | (TerrainModSettingBase & { readonly kind: "integer"; readonly defaultValue: number; readonly min: number; readonly max: number })
  | (TerrainModSettingBase & { readonly kind: "boolean"; readonly defaultValue: boolean })
  | (TerrainModSettingBase & { readonly kind: "choice"; readonly defaultValue: string; readonly options: readonly string[] });

interface TerrainModSettingBase {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly target: { readonly capabilityId: string; readonly configKey: string };
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
  readonly terrainId: string;
  /** Hash of the immutable, playable release content. */
  readonly contentHash?: string;
  /** URLs and color fallback are included in the catalog so artwork is available on first render. */
  readonly preview?: TerrainModVisualPreview;
}

export interface TerrainModVisualPreview {
  readonly terrainId: string;
  readonly displayName: string;
  readonly visuals?: TerrainModDefinition["terrain"]["visuals"];
  readonly visualAssets: readonly { readonly id: string; readonly url: string }[];
}

export interface WorkshopTerrainModPreview {
  readonly id: string;
  readonly preview: TerrainModVisualPreview;
}

export interface WorkshopMapEntry extends WorkshopMapSummary {
  readonly code: string;
}

export interface WorkshopTerrainModEntry extends WorkshopTerrainModSummary {
  /** Missing only on legacy source-only records which must be republished. */
  readonly definition?: TerrainModDefinition;
}

/** Wire representation used for full Mod details; image bytes load separately from these URLs. */
export type TerrainModDefinitionAssetReferences = Omit<TerrainModDefinition, "visualAssets"> & {
  readonly visualAssets?: readonly { readonly id: string; readonly url: string }[];
};

export interface WorkshopTerrainModDetailEntry extends WorkshopTerrainModSummary {
  /** Image references remain URLs on the wire; the client downloads and materializes them for installation. */
  readonly definition?: TerrainModDefinitionAssetReferences;
}

export interface WorkshopCatalog {
  readonly maps: readonly WorkshopMapSummary[];
  readonly terrainMods: readonly WorkshopTerrainModSummary[];
}

export type WorkshopDetail =
  | { readonly kind: "map"; readonly entry: WorkshopMapEntry }
  | { readonly kind: "terrain-mod"; readonly entry: WorkshopTerrainModDetailEntry };

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

/** A player's private map, stored by server-side workshop user ID. */
export interface WorkshopPersonalMap {
  readonly mapId: string;
  readonly code: string;
  readonly updatedAt: string;
}

export type WorkshopPersonalMapOperation =
  | { readonly operationId: string; readonly type: "upsert"; readonly mapId: string; readonly code: string }
  | { readonly operationId: string; readonly type: "delete"; readonly mapId: string };

/** Local cache is imported only when the account has not synced before; queued edits always apply. */
export interface WorkshopPersonalMapSyncRequest {
  readonly cachedMaps: readonly Pick<WorkshopPersonalMap, "mapId" | "code">[];
  readonly operations: readonly WorkshopPersonalMapOperation[];
}

export interface WorkshopPersonalMapsPayload {
  readonly userId: string;
  readonly maps: readonly WorkshopPersonalMap[];
  readonly acknowledgedOperationIds: readonly string[];
}
