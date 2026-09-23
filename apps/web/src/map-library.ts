import {
  DEFAULT_MAP_CODE,
  DEFAULT_MAP_DEFINITION,
  parseMapCode,
  serializeMapCode,
  type MapDefinition
} from "@numeral-lord/core-content";

const STORAGE_KEY = "numeral-lord.map-library.v1";
const MAX_CUSTOM_MAPS = 32;

export interface ConfiguredMap {
  readonly code: string;
  readonly definition: MapDefinition;
  readonly isDefault: boolean;
}

const defaultMap: ConfiguredMap = {
  code: DEFAULT_MAP_CODE,
  definition: DEFAULT_MAP_DEFINITION,
  isDefault: true
};

/** Local-only map library. Room selection sends a complete code to every client. */
export function loadMapLibrary(): ConfiguredMap[] {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    saved = [];
  }
  const maps = [defaultMap];
  const seen = new Set([defaultMap.definition.id]);
  if (!Array.isArray(saved)) return maps;
  for (const value of saved.slice(0, MAX_CUSTOM_MAPS)) {
    if (typeof value !== "string") continue;
    try {
      const definition = parseMapCode(value);
      if (seen.has(definition.id)) continue;
      seen.add(definition.id);
      maps.push({ code: serializeMapCode(definition), definition, isDefault: false });
    } catch {
      // A stale or damaged local entry does not prevent opening the game.
    }
  }
  return maps;
}

export function addMapToLibrary(current: readonly ConfiguredMap[], rawCode: string): ConfiguredMap[] {
  if (rawCode.length > 128_000) throw new Error("地图码过长，请检查粘贴内容。");
  const definition = parseMapCode(rawCode);
  if (current.some((map) => map.definition.id === definition.id)) {
    throw new Error(`地图「${definition.name}」已经在地图库中。`);
  }
  if (current.length - 1 >= MAX_CUSTOM_MAPS) throw new Error("本机最多可保存 32 张自定义地图。");
  const next = [...current, { code: serializeMapCode(definition), definition, isDefault: false }];
  persistCustomMaps(next);
  return next;
}

export function removeMapFromLibrary(current: readonly ConfiguredMap[], id: string): ConfiguredMap[] {
  const next = current.filter((map) => map.isDefault || map.definition.id !== id);
  persistCustomMaps(next);
  return next;
}

function persistCustomMaps(maps: readonly ConfiguredMap[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(maps.filter((map) => !map.isDefault).map((map) => map.code)));
}
