import type { TerrainModDefinition, TerrainModDefinitionAssetReferences, TerrainModVisualPreview } from "@numeral-lord/content-schema";

/** 工坊公开的地形 Mod 条目。 */
export interface TerrainModEntry {
  readonly id: string;
  readonly modId?: string;
  readonly name: string;
  readonly version: string;
  readonly contentHash?: string;
  readonly description: string;
  readonly terrainId: string;
  readonly installed: boolean;
  readonly cached?: boolean;
  readonly author?: string;
  readonly authorName?: string;
  readonly createdAt?: string;
  readonly readme?: string;
  readonly definition?: TerrainModDefinition;
  readonly preview?: TerrainModVisualPreview;
  /** Original workshop URLs retained alongside downloaded local bytes for editing. */
  readonly visualAssetUrls?: Readonly<Record<string, string>>;
}

/** 工坊地图列表条目；地图码只在读取详情后提供。 */
export interface MapWorkshopEntry {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly description: string;
  readonly author?: string;
  readonly authorName?: string;
  readonly createdAt?: string;
  readonly mapId?: string;
  readonly players?: number;
  readonly version?: string;
  readonly requiredTerrainModIds?: readonly string[];
}

/** 发布或更新地形 Mod 时提交的数据。 */
export interface TerrainModSubmission {
  readonly name: string;
  readonly description: string;
  readonly definition: TerrainModDefinitionAssetReferences;
  readonly updateId?: string;
}

/** 发布地图时提交的数据。 */
export interface MapSubmission {
  readonly code: string;
  readonly description: string;
}
