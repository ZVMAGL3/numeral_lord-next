import { coreTerrainCatalog, type MapCatalogs } from "@numeral-lord/core-content";
import { validateTerrainModDefinition, type TerrainModDefinition } from "@numeral-lord/content-schema";
import type { ModDefinition } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";
import { reactive, ref } from "vue";

/** Current Mod definitions fetched from the server, kept only in runtime memory. */
export const loadedTerrainMods = reactive<ModDefinition[]>([]);

/** Explicit invalidation token for async Mod definition consumers and map previews. */
export const loadedTerrainCatalogRevision = ref(0);

export const loadedTerrainCatalog = reactive<Record<string, (typeof coreTerrainCatalog)[string]>>({ ...coreTerrainCatalog });

export const loadedTerrainModIds = reactive<Record<string, string>>({});

const loadedModCatalog = reactive<Record<string, ModDefinition>>(
  Object.fromEntries(loadedTerrainMods.map((mod) => [mod.id, mod]))
);

export const runtimeMapCatalogs = {
  terrains: loadedTerrainCatalog,
  terrainModIds: loadedTerrainModIds,
  mods: loadedModCatalog
};

export function terrainModDefinitionObject(mod: ModDefinition): TerrainModDefinition {
  if (!mod.terrain) throw new Error(`Terrain Mod ${mod.id} has no terrain.`);
  const { id: _terrainId, displayName: _displayName, ...terrain } = mod.terrain;
  const capabilities: TerrainModDefinition["capabilities"] = mod.capabilities.map((capability) => {
    if (capability.target !== "terrain" || !isRecord(capability.defaultConfig)) {
      throw new Error(`Terrain Mod ${mod.id} contains a non-terrain capability.`);
    }
    return { id: capability.id, target: "terrain", defaultConfig: capability.defaultConfig };
  });
  return {
    id: mod.id,
    version: mod.version,
    capabilities,
    ...(mod.settings ? { settings: mod.settings } : {}),
    ...(mod.spatialPatterns ? { spatialPatterns: mod.spatialPatterns } : {}),
    ...(mod.rules ? { rules: mod.rules } : {}),
    ...(mod.visualAssets ? { visualAssets: mod.visualAssets } : {}),
    terrain
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function terrainVisualAssetsForCatalogs(catalogs: Pick<MapCatalogs, "mods"> | null | undefined): Readonly<Record<string, Readonly<Record<string, string>>>> {
  return Object.fromEntries(Object.values(catalogs?.mods ?? {}).flatMap((mod) => {
    const assets = new Map((mod.visualAssets ?? []).map((asset) => [asset.id, asset.dataUrl]));
    const terrain = mod.terrain;
    if (!terrain) return [];
    const ids = new Set([terrain.visuals?.baseAssetId, terrain.visuals?.overlay?.assetId]
      .filter((id): id is string => Boolean(id)));
    const referenced = Object.fromEntries([...ids].flatMap((id) => assets.has(id) ? [[id, assets.get(id)!] as const] : []));
    return Object.keys(referenced).length ? [[terrain.id, referenced] as const] : [];
  }));
}

function terrainIdForModId(modId: string): string {
  return `mod/${modId.slice(4)}`;
}

function defaultTerrainDisplayName(modId: string): string {
  return modId.slice(4).split("-").map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(" ");
}

function runtimeTerrainMod(definition: TerrainModDefinition, name: string): ModDefinition {
  const terrainId = terrainIdForModId(definition.id);
  return {
    ...definition,
    terrain: { ...definition.terrain, id: terrainId, displayName: name },
    units: [],
    commandRules: [],
    victoryConditions: []
  } as ModDefinition;
}

function registerTerrainModObject(definition: TerrainModDefinition, name: string): void {
  const runtimeMod = runtimeTerrainMod(definition, name);
  const previousIndex = loadedTerrainMods.findIndex((mod) => mod.id === definition.id);
  if (previousIndex >= 0) {
    const previousTerrain = loadedTerrainMods[previousIndex]!.terrain;
    if (previousTerrain) {
      const terrain = previousTerrain;
      if (loadedTerrainModIds[terrain.id] === definition.id) {
        delete loadedTerrainModIds[terrain.id];
        delete loadedTerrainCatalog[terrain.id];
      }
    }
    loadedTerrainMods.splice(previousIndex, 1, runtimeMod);
  } else {
    loadedTerrainMods.push(runtimeMod);
  }
  if (runtimeMod.terrain) {
    const terrain = runtimeMod.terrain;
    loadedTerrainCatalog[terrain.id] = terrain;
    loadedTerrainModIds[terrain.id] = runtimeMod.id;
  }
  loadedModCatalog[runtimeMod.id] = runtimeMod;
  loadedTerrainCatalogRevision.value += 1;
}

/**
 * Resolve a map's Mod IDs to the current server definitions loaded in memory.
 */
export function resolveMapCatalogs(code: string): MapCatalogs | null {
  let data: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(code);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    data = decoded as Record<string, unknown>;
  } catch { return null; }

  const declaredIds = Array.isArray(data.requiredTerrainModIds)
    ? data.requiredTerrainModIds.filter((id): id is string => typeof id === "string") : [];
  const active = loadedTerrainMods.map((mod) => terrainModDefinitionObject(mod));
  const ownerByTerrain = new Map(active.map((definition) => [terrainIdForModId(definition.id), definition.id] as const));
  const legend = typeof data.terrainLegend === "object" && data.terrainLegend !== null && !Array.isArray(data.terrainLegend)
    ? Object.values(data.terrainLegend as Record<string, unknown>).filter((id): id is string => typeof id === "string") : [];
  const inferredIds = legend.flatMap((terrainId) => {
    if (terrainId.startsWith("core/")) return [];
    const owner = ownerByTerrain.get(terrainId) ?? /^mod\/([^/]+)(?:\/.*)?$/.exec(terrainId)?.[1];
    return owner ? [owner.startsWith("mod-") ? owner : `mod-${owner}`] : [];
  });
  const requiredIds = [...new Set([...declaredIds, ...inferredIds])];
  const selectedMods: TerrainModDefinition[] = [];
  for (const id of requiredIds) {
    const selected = active.find((definition) => definition.id === id);
    if (selected) selectedMods.push(selected);
  }

  const terrains: Record<string, TerrainCatalog[string]> = { ...coreTerrainCatalog };
  const terrainModIds: Record<string, string> = {};
  const mods: Record<string, ModDefinition> = {};
  for (const definition of selectedMods) {
    const name = loadedTerrainMods.find((mod) => mod.id === definition.id)?.terrain?.displayName
      ?? defaultTerrainDisplayName(definition.id);
    const runtime = runtimeTerrainMod(definition, name);
    mods[definition.id] = runtime;
    if (runtime.terrain) {
      terrains[runtime.terrain.id] = runtime.terrain;
      terrainModIds[runtime.terrain.id] = definition.id;
    }
  }
  return { terrains: terrains as TerrainCatalog, terrainModIds, mods, allowUnknownTerrainMods: true };
}

/** Delegate install/hydration checks to the same validator used by the workshop server. */
export function validateTerrainModObject(definition: TerrainModDefinition): void {
  validateTerrainModDefinition(definition);
}

/** Register a server-fetched definition in memory for current map/game use. */
export function registerServerTerrainModDefinition(definition: TerrainModDefinition, name: string): void {
  validateTerrainModObject(definition);
  registerTerrainModObject(definition, name);
}

export function unloadServerTerrainMod(modId: string): void {
  const index = loadedTerrainMods.findIndex((mod) => mod.id === modId);
  if (index < 0) return;
  const [removed] = loadedTerrainMods.splice(index, 1);
  if (!removed) return;
  const terrain = removed.terrain;
  if (terrain) {
    if (loadedTerrainModIds[terrain.id] === modId) {
      delete loadedTerrainModIds[terrain.id];
      delete loadedTerrainCatalog[terrain.id];
    }
  }
  delete loadedModCatalog[modId];
  loadedTerrainCatalogRevision.value += 1;
}
