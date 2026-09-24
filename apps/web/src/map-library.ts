import {
  parseMapCode,
  serializeMapCode,
  type MapDefinition
} from "@numeral-lord/core-content";
import { installedMapCatalogs, installedTerrainMods } from "./installed-content";

const STORAGE_KEY = "numeral-lord.map-library.v1";
const MAX_CUSTOM_MAPS = 32;

export interface ConfiguredMap {
  readonly code: string;
  readonly definition: MapDefinition;
  readonly isDefault: boolean;
}

/** A map code may be saved without its terrain Mods, but cannot be played yet. */
export function missingTerrainMods(map: ConfiguredMap): string[] {
  const installedModIds = new Set(installedTerrainMods.map((mod) => mod.id));
  return map.definition.requiredTerrainModIds.filter((id) => !installedModIds.has(id));
}

const libraryCatalogs = { ...installedMapCatalogs, allowUnknownTerrainMods: true };

/** Local-only map library. Room selection sends a complete code to every client. */
export function loadMapLibrary(): ConfiguredMap[] {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    saved = [];
  }
  const maps: ConfiguredMap[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(saved)) return maps;
  for (const value of saved.slice(0, MAX_CUSTOM_MAPS)) {
    if (typeof value !== "string") continue;
    try {
      const definition = parseMapCode(value, libraryCatalogs);
      if (seen.has(definition.id)) continue;
      seen.add(definition.id);
      maps.push({ code: serializeMapCode(definition, libraryCatalogs), definition, isDefault: false });
    } catch {
      // A stale or damaged local entry does not prevent opening the game.
    }
  }
  return maps;
}

export function addMapToLibrary(current: readonly ConfiguredMap[], rawCode: string): ConfiguredMap[] {
  if (rawCode.length > 128_000) throw new Error("地图码过长，请检查粘贴内容。");
  const definition = parseMapCode(rawCode, libraryCatalogs);
  if (current.some((map) => map.definition.id === definition.id)) {
    throw new Error(`地图「${definition.name}」已经在地图库中。`);
  }
  if (current.length >= MAX_CUSTOM_MAPS) throw new Error("本机最多可保存 32 张自定义地图。");
  const next = [...current, { code: serializeMapCode(definition, libraryCatalogs), definition, isDefault: false }];
  persistCustomMaps(next);
  return next;
}

export function saveMapToLibrary(current: readonly ConfiguredMap[], rawCode: string): ConfiguredMap[] {
  if (rawCode.length > 128_000) throw new Error("地图数据过长。");
  const definition = parseMapCode(rawCode, libraryCatalogs);
  const existing = current.find((map) => map.definition.id === definition.id);
  const exists = existing !== undefined;
  if (!exists && current.length >= MAX_CUSTOM_MAPS) throw new Error("本机最多可保存 32 张自定义地图。");
  const entry: ConfiguredMap = { code: serializeMapCode(definition, libraryCatalogs), definition, isDefault: false };
  const next = exists
    ? current.map((map) => map.definition.id === definition.id ? entry : map)
    : [...current, entry];
  persistCustomMaps(next);
  return next;
}

export function removeMapFromLibrary(current: readonly ConfiguredMap[], id: string): ConfiguredMap[] {
  const next = current.filter((map) => map.definition.id !== id);
  persistCustomMaps(next);
  return next;
}

function persistCustomMaps(maps: readonly ConfiguredMap[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(maps.filter((map) => !map.isDefault).map((map) => map.code)));
}
