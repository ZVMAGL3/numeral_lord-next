import type { TerrainModDefinitionAssetReferences } from "@numeral-lord/content-schema";

export function terrainModAuthoringJson(
  name: string,
  description: string,
  definition: TerrainModDefinitionAssetReferences
) {
  const { terrain, ...fields } = definition;
  return { name, description, definition: { ...fields, terrain } };
}
