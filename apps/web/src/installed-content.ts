import { coreTerrainCatalog } from "@numeral-lord/core-content";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";
import type { TerrainModDefinition } from "@numeral-lord/content-schema";
import type { ModDefinition } from "@numeral-lord/game-sdk";
import { reactive } from "vue";
import { loadInstalledTerrainModObjects, persistInstalledTerrainModObject } from "./mod-installation";

/** Runtime mod registry. Published packages are hydrated from IndexedDB objects. */
export const installedTerrainMods = reactive<ModDefinition[]>([oilFieldMod]);

export const installedTerrainCatalog = reactive<Record<string, (typeof coreTerrainCatalog)[string]>>({
  ...coreTerrainCatalog,
  ...oilFieldTerrainCatalog
});

export const installedTerrainModIds = reactive<Record<string, string>>(Object.fromEntries(
  installedTerrainMods.flatMap((mod) => mod.terrains.map((terrain) => [terrain.id, mod.id]))
));

const installedModCatalog = reactive<Record<string, ModDefinition>>(
  Object.fromEntries(installedTerrainMods.map((mod) => [mod.id, mod]))
);

export const installedMapCatalogs = {
  terrains: installedTerrainCatalog,
  terrainModIds: installedTerrainModIds,
  mods: installedModCatalog
};

export function terrainModDefinitionObject(mod: ModDefinition): TerrainModDefinition {
  return {
    id: mod.id,
    version: mod.version,
    capabilities: mod.capabilities,
    ...(mod.settings ? { settings: mod.settings } : {}),
    ...(mod.spatialPatterns ? { spatialPatterns: mod.spatialPatterns } : {}),
    ...(mod.rules ? { rules: mod.rules } : {}),
    terrains: mod.terrains
  } as unknown as TerrainModDefinition;
}

function registerTerrainModObject(definition: TerrainModDefinition): void {
  const runtimeMod = {
    ...definition,
    units: [],
    commandRules: [],
    victoryConditions: []
  } as unknown as ModDefinition;
  const previousIndex = installedTerrainMods.findIndex((mod) => mod.id === definition.id);
  if (previousIndex >= 0) {
    for (const terrain of installedTerrainMods[previousIndex]!.terrains) {
      if (installedTerrainModIds[terrain.id] === definition.id) {
        delete installedTerrainModIds[terrain.id];
        delete installedTerrainCatalog[terrain.id];
      }
    }
    installedTerrainMods.splice(previousIndex, 1, runtimeMod);
  } else {
    installedTerrainMods.push(runtimeMod);
  }
  for (const terrain of runtimeMod.terrains) {
    installedTerrainCatalog[terrain.id] = terrain;
    installedTerrainModIds[terrain.id] = runtimeMod.id;
  }
  installedModCatalog[runtimeMod.id] = runtimeMod;
}

export async function hydrateInstalledTerrainMods(): Promise<void> {
  const definitions = await loadInstalledTerrainModObjects();
  for (const definition of definitions) {
    if (definition.id === "core-terrain" || definition.id.startsWith("core-")) continue;
    registerTerrainModObject(definition);
  }
}

export async function installTerrainModObject(definition: TerrainModDefinition): Promise<void> {
  if (!definition.id.startsWith("mod-") || !Array.isArray(definition.terrains)
    || new TextEncoder().encode(JSON.stringify(definition)).byteLength > 64 * 1024) {
    throw new Error("Mod 属性对象无效或超过 64 KiB。");
  }
  await persistInstalledTerrainModObject(definition);
  registerTerrainModObject(definition);
}
