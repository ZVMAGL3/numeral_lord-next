import type { WorkshopPersonalMapOperation, WorkshopPersonalMapSyncRequest, WorkshopPersonalMapsPayload } from "@numeral-lord/content-schema";
import {
  parseMapCode,
  serializeMapCode,
  type MapDefinition
} from "@numeral-lord/core-content";
import { runtimeMapCatalogs, resolveMapCatalogs } from "../content/installed-content";

const LEGACY_STORAGE_KEY = "numeral-lord.map-library.v1";
const STORAGE_KEY_PREFIX = "numeral-lord.map-library.v2:";
const MAX_CUSTOM_MAPS = 32;

interface PersonalMapCache {
  readonly version: 1;
  readonly serverSynced: boolean;
  readonly maps: readonly string[];
  readonly pendingOperations: readonly WorkshopPersonalMapOperation[];
}

export interface ConfiguredMap {
  readonly code: string;
  readonly definition: MapDefinition;
  readonly isDefault: boolean;
}

/** A map code may be saved without loading its server terrain Mods, but cannot be played yet. */
export function missingTerrainMods(map: ConfiguredMap): string[] {
  const activeCatalogs = resolveMapCatalogs(map.code);
  return map.definition.requiredTerrainModIds.filter((id) => !activeCatalogs?.mods?.[id]);
}

function catalogsForCode(code: string) {
  const exact = resolveMapCatalogs(code);
  // Preserve maps for inspection while a required server Mod is not loaded.
  return exact ?? { ...runtimeMapCatalogs, mods: {}, allowUnknownTerrainMods: true };
}

function accountStorageKey(identityName: string): string {
  const normalizedName = identityName.normalize("NFKC").trim().toLowerCase() || "guest";
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(normalizedName)}`;
}

function emptyCache(): PersonalMapCache {
  return { version: 1, serverSynced: false, maps: [], pendingOperations: [] };
}

function decodeLegacyCache(raw: string | null): PersonalMapCache | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) {
      return { version: 1, serverSynced: false, maps: value.filter((code): code is string => typeof code === "string").slice(0, MAX_CUSTOM_MAPS), pendingOperations: [] };
    }
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.maps) || !Array.isArray(value.pendingOperations)) return null;
    return {
      version: 1,
      serverSynced: value.serverSynced === true,
      maps: value.maps.filter((code): code is string => typeof code === "string").slice(0, MAX_CUSTOM_MAPS),
      pendingOperations: value.pendingOperations.filter(isPersonalMapOperation).slice(0, MAX_CUSTOM_MAPS)
    };
  } catch {
    return null;
  }
}

function readCache(identityName: string): PersonalMapCache {
  const key = accountStorageKey(identityName);
  const scoped = decodeLegacyCache(localStorage.getItem(key));
  if (scoped) return scoped;

  // One-time adoption of the earlier browser-wide map list into the currently
  // selected player account. The scoped copy is written before removing it.
  const legacy = decodeLegacyCache(localStorage.getItem(LEGACY_STORAGE_KEY));
  if (!legacy) return emptyCache();
  localStorage.setItem(key, JSON.stringify(legacy));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return legacy;
}

function writeCache(identityName: string, cache: PersonalMapCache): void {
  localStorage.setItem(accountStorageKey(identityName), JSON.stringify(cache));
}

function mapFromCode(code: string): ConfiguredMap | null {
  try {
    const catalogs = catalogsForCode(code);
    const definition = parseMapCode(code, catalogs);
    return { code: serializeMapCode(definition, catalogs), definition, isDefault: false };
  } catch {
    // A stale or damaged local entry does not prevent opening the game.
    return null;
  }
}

function mapIdFromCode(code: string): string | null {
  return mapFromCode(code)?.definition.id ?? null;
}

/** Loads the fast local cache for an identity; server sync reconciles it after connect. */
export function loadMapLibrary(identityName = ""): ConfiguredMap[] {
  const cache = readCache(identityName);
  const maps: ConfiguredMap[] = [];
  const seen = new Set<string>();
  for (const code of cache.maps) {
    const map = mapFromCode(code);
    if (!map || seen.has(map.definition.id)) continue;
    seen.add(map.definition.id);
    maps.push(map);
  }
  return maps;
}

export function createPersonalMapSyncRequest(identityName: string): WorkshopPersonalMapSyncRequest {
  const cache = readCache(identityName);
  const cachedMaps = new Map<string, { mapId: string; code: string }>();
  if (!cache.serverSynced) {
    for (const code of cache.maps) {
      const mapId = mapIdFromCode(code);
      if (mapId && !cachedMaps.has(mapId)) cachedMaps.set(mapId, { mapId, code });
    }
  }
  return {
    cachedMaps: [...cachedMaps.values()],
    operations: cache.pendingOperations
  };
}

/** Merge the authoritative server snapshot with edits made since the sync request was sent. */
export function reconcilePersonalMapLibrary(identityName: string, payload: WorkshopPersonalMapsPayload): ConfiguredMap[] {
  const cache = readCache(identityName);
  const acknowledged = new Set(payload.acknowledgedOperationIds);
  const pendingOperations = cache.pendingOperations.filter((operation) => !acknowledged.has(operation.operationId));
  const byId = new Map<string, string>(payload.maps.map((map) => [map.mapId, map.code]));
  for (const operation of pendingOperations) {
    if (operation.type === "delete") byId.delete(operation.mapId);
    else byId.set(operation.mapId, operation.code);
  }

  const reconciled = [...byId.values()].flatMap((code) => {
    const map = mapFromCode(code);
    return map ? [map] : [];
  }).slice(0, MAX_CUSTOM_MAPS);
  writeCache(identityName, {
    version: 1,
    serverSynced: true,
    maps: reconciled.map((map) => map.code),
    pendingOperations
  });
  return reconciled;
}

export function addMapToLibrary(current: readonly ConfiguredMap[], rawCode: string, identityName = ""): ConfiguredMap[] {
  if (rawCode.length > 128_000) throw new Error("地图码过长，请检查粘贴内容。");
  const catalogs = catalogsForCode(rawCode);
  const definition = parseMapCode(rawCode, catalogs);
  if (current.some((map) => map.definition.id === definition.id)) {
    throw new Error(`地图「${definition.name}」已经在地图库中。`);
  }
  if (current.length >= MAX_CUSTOM_MAPS) throw new Error("账号最多可保存 32 张自定义地图。");
  const next = [...current, { code: serializeMapCode(definition, catalogs), definition, isDefault: false }];
  persistCustomMaps(next, identityName);
  return next;
}

export function saveMapToLibrary(current: readonly ConfiguredMap[], rawCode: string, identityName = ""): ConfiguredMap[] {
  if (rawCode.length > 128_000) throw new Error("地图数据过长。");
  const definition = parseMapCode(rawCode, { ...runtimeMapCatalogs, allowUnknownTerrainMods: true });
  const existing = current.find((map) => map.definition.id === definition.id);
  const exists = existing !== undefined;
  if (!exists && current.length >= MAX_CUSTOM_MAPS) throw new Error("账号最多可保存 32 张自定义地图。");
  const code = serializeMapCode(definition, { ...runtimeMapCatalogs, allowUnknownTerrainMods: true });
  // Maps retain Mod IDs only and always resolve against the current server definition.
  const entry: ConfiguredMap = { code, definition: parseMapCode(code, { ...runtimeMapCatalogs, allowUnknownTerrainMods: true }), isDefault: false };
  const next = exists
    ? current.map((map) => map.definition.id === definition.id ? entry : map)
    : [...current, entry];
  persistCustomMaps(next, identityName);
  return next;
}

export function removeMapFromLibrary(current: readonly ConfiguredMap[], id: string, identityName = ""): ConfiguredMap[] {
  const next = current.filter((map) => map.definition.id !== id);
  persistCustomMaps(next, identityName);
  return next;
}

function persistCustomMaps(next: readonly ConfiguredMap[], identityName: string): void {
  const cache = readCache(identityName);
  const oldCodes = new Map<string, string>();
  for (const code of cache.maps) {
    const id = mapIdFromCode(code);
    if (id) oldCodes.set(id, code);
  }
  const newCodes = new Map(next.filter((map) => !map.isDefault).map((map) => [map.definition.id, map.code]));
  const operations = new Map(cache.pendingOperations.map((operation) => [operation.mapId, operation]));
  for (const id of new Set([...oldCodes.keys(), ...newCodes.keys()])) {
    const oldCode = oldCodes.get(id);
    const newCode = newCodes.get(id);
    if (oldCode === newCode) continue;
    const operationId = createOperationId();
    operations.set(id, newCode === undefined
      ? { operationId, type: "delete", mapId: id }
      : { operationId, type: "upsert", mapId: id, code: newCode });
  }
  writeCache(identityName, {
    version: 1,
    serverSynced: cache.serverSynced,
    maps: [...newCodes.values()],
    pendingOperations: [...operations.values()].slice(-MAX_CUSTOM_MAPS)
  });
}

function createOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersonalMapOperation(value: unknown): value is WorkshopPersonalMapOperation {
  return isRecord(value) && typeof value.operationId === "string" && typeof value.mapId === "string"
    && (value.type === "delete" || (value.type === "upsert" && typeof value.code === "string"));
}
