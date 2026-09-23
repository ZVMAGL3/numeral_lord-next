/** Messages and data exchanged with the optional community workshop room. */
export type WorkshopKind = "map" | "terrain-mod";

export interface WorkshopSourceFile {
  readonly path: string;
  /** Source is retained as inert text for preview; the workshop never runs it. */
  readonly content: string;
}

export interface PublishMapRequest {
  readonly code: string;
  readonly description: string;
}

export interface PublishTerrainModRequest {
  /** Stable Mod package id, e.g. mod-oil-field. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly terrainIds: readonly string[];
  readonly sourceFiles: readonly WorkshopSourceFile[];
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
  readonly sourceFiles: readonly WorkshopSourceFile[];
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
