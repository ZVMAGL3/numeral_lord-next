import { coreTerrainCatalog } from "@numeral-lord/core-content";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";

/** Content installed in this client build. Map codes only reference these IDs. */
export const installedTerrainMods = [oilFieldMod] as const;

export const installedTerrainCatalog = {
  ...coreTerrainCatalog,
  ...oilFieldTerrainCatalog
};

export const installedTerrainModIds = Object.fromEntries(
  installedTerrainMods.flatMap((mod) => mod.terrains.map((terrain) => [terrain.id, mod.id]))
) as Readonly<Record<string, string>>;

export const installedMapCatalogs = {
  terrains: installedTerrainCatalog,
  terrainModIds: installedTerrainModIds,
  mods: Object.fromEntries(installedTerrainMods.map((mod) => [mod.id, mod]))
};
