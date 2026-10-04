import { coreTerrainCatalog, type MapCatalogs } from "@numeral-lord/core-content";
import { validateTerrainModDefinition, type TerrainModDefinition } from "@numeral-lord/content-schema";
import type { ModDefinition } from "@numeral-lord/game-sdk";
import type { ModContentLock, TerrainCatalog } from "@numeral-lord/game-core";
import { decayTerrainMod } from "@numeral-lord/decay-terrain-mod";
import { desertTerrainMod } from "@numeral-lord/desert-terrain-mod";
import { exampleTerrainMods } from "@numeral-lord/example-mods";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";
import { reactive } from "vue";
import { compareModVersions } from "../workshop/workshop-terrain-catalog.js";
import { loadInstalledTerrainModObjects, loadInstalledTerrainModReleases, persistInstalledTerrainModObject, terrainModContentHash, type CachedTerrainModRelease } from "./mod-installation";

/** Bundled playable examples plus persisted packages, all validated before hydration. */
const bundledTerrainMods: ModDefinition[] = [oilFieldMod, decayTerrainMod, desertTerrainMod, ...exampleTerrainMods];
/** IDs for app-shipped Mods; their artwork and later releases still come from the Workshop. */
export const bundledTerrainModIds: ReadonlySet<string> = new Set(bundledTerrainMods.map((mod) => mod.id));
export const installedTerrainMods = reactive<ModDefinition[]>(bundledTerrainMods);
/** Immutable cached releases are separate from the active subscription version. */
export const cachedTerrainModReleases = reactive<CachedTerrainModRelease[]>([]);

export const installedTerrainCatalog = reactive<Record<string, (typeof coreTerrainCatalog)[string]>>({
  ...coreTerrainCatalog,
  ...oilFieldTerrainCatalog,
  ...Object.fromEntries(bundledTerrainMods.flatMap((mod) => mod.terrain ? [[mod.terrain.id, mod.terrain]] : []))
});

export const installedTerrainModIds = reactive<Record<string, string>>(Object.fromEntries(
  bundledTerrainMods.flatMap((mod) => mod.terrain ? [[mod.terrain.id, mod.id]] : [])
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

export function installedTerrainModContentHashes(): Readonly<Record<string, string>> {
  return Object.fromEntries(installedTerrainMods.map((mod) => [
    mod.id,
    terrainModContentHash(terrainModDefinitionObject(mod))
  ]));
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
  cacheTerrainModDefinition(definition, name);
  const current = installedTerrainMods.find((mod) => mod.id === definition.id);
  if (current) {
    const versionOrder = compareModVersions(current.version, definition.version);
    // The shipped definition is authoritative for its exact bundled release.
    // A same-version IndexedDB copy must not replace packaged visual assets.
    if (versionOrder > 0 || (versionOrder === 0 && bundledTerrainModIds.has(definition.id))) return;
  }
  const runtimeMod = runtimeTerrainMod(definition, name);
  const previousIndex = installedTerrainMods.findIndex((mod) => mod.id === definition.id);
  if (previousIndex >= 0) {
    const previousTerrain = installedTerrainMods[previousIndex]!.terrain;
    if (previousTerrain) {
      const terrain = previousTerrain;
      if (installedTerrainModIds[terrain.id] === definition.id) {
        delete installedTerrainModIds[terrain.id];
        delete installedTerrainCatalog[terrain.id];
      }
    }
    installedTerrainMods.splice(previousIndex, 1, runtimeMod);
  } else {
    installedTerrainMods.push(runtimeMod);
  }
  if (runtimeMod.terrain) {
    const terrain = runtimeMod.terrain;
    installedTerrainCatalog[terrain.id] = terrain;
    installedTerrainModIds[terrain.id] = runtimeMod.id;
  }
  installedModCatalog[runtimeMod.id] = runtimeMod;
}

function cacheTerrainModDefinition(definition: TerrainModDefinition, name: string): void {
  const hash = terrainModContentHash(definition);
  const releaseKey = `${definition.id}\u0000${definition.version}\u0000${hash}`;
  const index = cachedTerrainModReleases.findIndex((candidate) => candidate.releaseKey === releaseKey);
  const record = { releaseKey, id: definition.id, version: definition.version, contentHash: hash, name, definition };
  if (index >= 0) cachedTerrainModReleases.splice(index, 1, record);
  else cachedTerrainModReleases.push(record);
}

export async function hydrateInstalledTerrainMods(): Promise<void> {
  const [definitions, releases] = await Promise.all([loadInstalledTerrainModObjects(), loadInstalledTerrainModReleases()]);
  for (const release of releases) {
    try {
      validateTerrainModObject(release.definition);
      if (release.contentHash !== terrainModContentHash(release.definition)) throw new Error("缓存版本指纹不一致。");
      cacheTerrainModDefinition(release.definition, release.name);
    } catch (error) {
      console.warn("Skipping invalid cached terrain Mod release", release.id, release.version, error);
    }
  }
  for (const { definition, name } of definitions) {
    try {
      validateTerrainModObject(definition);
      registerTerrainModObject(definition, name);
    } catch (error) {
      // One damaged record must not prevent the rest of the game/catalog from starting.
      console.warn("Skipping invalid installed terrain Mod", definition?.id, error);
    }
  }
}

export function cacheInstalledTerrainModRelease(definition: TerrainModDefinition, name: string): void {
  validateTerrainModObject(definition);
  cacheTerrainModDefinition(definition, name);
}

/**
 * Resolve a map's Mod IDs to active local releases, or to the room host's
 * selected releases when provided. Version identities belong to the room,
 * never to the map code itself.
 */
export function resolveMapCatalogs(code: string, roomReleases: readonly ModContentLock[] = []): MapCatalogs | null {
  let data: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(code);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    data = decoded as Record<string, unknown>;
  } catch { return null; }

  const declaredIds = Array.isArray(data.requiredTerrainModIds)
    ? data.requiredTerrainModIds.filter((id): id is string => typeof id === "string") : [];
  const cached = [...cachedTerrainModReleases.map((release) => release.definition),
    ...installedTerrainMods.map((mod) => terrainModDefinitionObject(mod))];
  const active = installedTerrainMods.map((mod) => terrainModDefinitionObject(mod));
  const ownerByTerrain = new Map(cached.map((definition) => [terrainIdForModId(definition.id), definition.id] as const));
  const legend = typeof data.terrainLegend === "object" && data.terrainLegend !== null && !Array.isArray(data.terrainLegend)
    ? Object.values(data.terrainLegend as Record<string, unknown>).filter((id): id is string => typeof id === "string") : [];
  const inferredIds = legend.flatMap((terrainId) => {
    if (terrainId.startsWith("core/")) return [];
    const owner = ownerByTerrain.get(terrainId) ?? /^mod\/([^/]+)(?:\/.*)?$/.exec(terrainId)?.[1];
    return owner ? [owner.startsWith("mod-") ? owner : `mod-${owner}`] : [];
  });
  const requiredIds = [...new Set([...declaredIds, ...inferredIds])];
  const selectedRoomReleases = new Map(roomReleases.map((release) => [release.id, release]));
  const selectedMods: TerrainModDefinition[] = [];
  for (const id of requiredIds) {
    const roomRelease = selectedRoomReleases.get(id);
    const source = roomRelease ? cached : active;
    const matching = source.filter((definition) => definition.id === id
      && (!roomRelease || (definition.version === roomRelease.version
        && terrainModContentHash(definition) === roomRelease.contentHash)));
    // Room members must use the host's exact release. Outside a room, maps
    // follow the browser's active installation and ignore legacy map locks.
    if (roomRelease && matching.length === 0) continue;
    matching.sort((left, right) => compareModVersions(right.version, left.version));
    const selected = matching[0];
    if (selected) selectedMods.push(selected);
  }

  const terrains: Record<string, TerrainCatalog[string]> = { ...coreTerrainCatalog };
  const terrainModIds: Record<string, string> = {};
  const mods: Record<string, ModDefinition> = {};
  for (const definition of selectedMods) {
    const cachedName = cachedTerrainModReleases.find((release) => release.id === definition.id
      && release.version === definition.version && release.contentHash === terrainModContentHash(definition))?.name;
    const name = installedTerrainMods.find((mod) => mod.id === definition.id && mod.version === definition.version)?.terrain?.displayName
      ?? cachedName ?? defaultTerrainDisplayName(definition.id);
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

/** Register an already-persisted definition without writing IndexedDB a second time. */
export function registerInstalledTerrainModObject(definition: TerrainModDefinition, name: string): void {
  validateTerrainModObject(definition);
  registerTerrainModObject(definition, name);
}

export async function installTerrainModObject(definition: TerrainModDefinition, name: string): Promise<void> {
  validateTerrainModObject(definition);
  await persistInstalledTerrainModObject(definition, name);
  registerTerrainModObject(definition, name);
}

export function uninstallTerrainModObject(modId: string): void {
  const index = installedTerrainMods.findIndex((mod) => mod.id === modId);
  if (index < 0) return;
  const [removed] = installedTerrainMods.splice(index, 1);
  if (!removed) return;
  const terrain = removed.terrain;
  if (terrain) {
    if (installedTerrainModIds[terrain.id] === modId) {
      delete installedTerrainModIds[terrain.id];
      delete installedTerrainCatalog[terrain.id];
    }
  }
  delete installedModCatalog[modId];
}
