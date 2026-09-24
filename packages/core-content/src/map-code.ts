import { getHexNeighbours, getPlayerColor, hasTerrainCapability, startMatch, toCellId } from "@numeral-lord/game-core";
import type {
  CellTriggerLink,
  CellId,
  GameState,
  MapCell,
  MatchConditionCatalog,
  PlayerId,
  TeamId,
  TerrainCatalog,
  UnitCatalog,
  UnitId,
  UnitState
} from "@numeral-lord/game-core";
import { coreMatchConditionCatalog } from "./match-conditions.js";
import { legacyDemoMap } from "./legacy-demo-map.js";
import { coreTerrainCatalog } from "./terrains.js";
import { coreUnitCatalog } from "./units.js";
import { resolveModSettings, validateModSettings, type ModCatalog } from "./mod-settings.js";
import type { ModSettings } from "@numeral-lord/game-sdk";

/** A soldier is [row-major cell index, one-based map seat, strength, optional unit id]. */
export type MapSoldier = readonly [number, number, number, string?];

/** A directed, named relation between two row-major map cells. */
export interface MapCellLink {
  readonly trigger: "enter" | "leave";
  readonly source: number;
  readonly target: number;
  readonly relationId: string;
}

/**
 * Versioned, JSON-serializable map data. A one-character terrain symbol keeps
 * the old row-major map string small; the legend resolves it to a registered
 * terrain/Mod id. Team numbers may repeat to put map seats on the same team.
 */
export interface MapDefinition {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly columns: number;
  readonly terrain: string;
  readonly terrainLegend: Readonly<Record<string, string>>;
  /** IDs of separately installed terrain Mods used by this map. */
  readonly requiredTerrainModIds: readonly string[];
  /** Optional map-author defaults. A room host may override declared values. */
  readonly modSettings?: ModSettings;
  /** Optional directed relationships, resolved by their enter/leave trigger. */
  readonly cellLinks?: readonly MapCellLink[];
  readonly players: number;
  readonly soldiers: readonly MapSoldier[];
  readonly teams: readonly number[];
  readonly matchConditionIds: readonly string[];
}

export interface MapCatalogs {
  /** Pass the same installed terrain/Mod catalog to map loading and the engine. */
  readonly terrains?: TerrainCatalog;
  /** Resolve a registered terrain ID to its owning Mod ID. Core terrains need no entry. */
  readonly terrainModIds?: Readonly<Record<string, string>>;
  /** Installed Mod schemas used to validate configurable map/room values. */
  readonly mods?: ModCatalog;
  /** Inspect/store a map before optional terrain Mods are installed. Never use for play. */
  readonly allowUnknownTerrainMods?: boolean;
  readonly units?: UnitCatalog;
  readonly matchConditions?: MatchConditionCatalog;
}

export interface MapMatchOptions extends MapCatalogs {
  /** Seats without a room participant start with no units. */
  readonly activePlayerIds?: readonly PlayerId[];
  /** Online room member names, keyed by the map's stable player ID. */
  readonly playerDisplayNames?: Readonly<Record<string, string>>;
  /** Selected legacy palette colors keyed by stable map player ID. */
  readonly playerColors?: Readonly<Record<string, string>>;
  readonly friendlyFire?: boolean;
  /** Host overrides, validated against the installed Mod's setting schema. */
  readonly roomModSettings?: ModSettings;
}

export const DEFAULT_MAP_TERRAIN_CATALOG: TerrainCatalog = coreTerrainCatalog;

const DEFAULT_LEGEND: Readonly<Record<string, string>> = {
  M: "core/plain",
  P: "core/mountain",
  S: "core/stronghold",
  O: "core/ocean",
  F: "mod/oil-field",
  V: "core/void"
};

const DEFAULT_CONDITIONS = ["core/lose-all-survival-anchors", "core/last-team-standing"];
const MAX_MAP_CODE_LENGTH = 64 * 1024;
const MAX_CELLS = 4096;
const MAX_PLAYERS = 64;
const DEFAULT_PLAYER_COLOR_IDS = ["legacy-1", "legacy-2", "legacy-3", "legacy-4", "legacy-5", "legacy-6", "legacy-7", "legacy-8", "legacy-9"] as const;

/** The old 1001 map is the first built-in map, 昏晓. */
export const DEFAULT_MAP_DEFINITION: MapDefinition = {
  version: 1,
  id: String(legacyDemoMap.id),
  name: "昏晓",
  columns: legacyDemoMap.columns,
  terrain: legacyDemoMap.terrain,
  terrainLegend: DEFAULT_LEGEND,
  requiredTerrainModIds: ["mod-oil-field"],
  players: 2,
  soldiers: legacyDemoMap.soldiers.map(([index, legacySeat, strength]) => [index, legacySeat + 1, strength]),
  teams: [1, 2],
  matchConditionIds: DEFAULT_CONDITIONS
};

/** Canonical shareable map code. It is ordinary JSON for easy inspection. */
// The example deliberately references an optional Mod. Exporting its JSON must
// not implicitly install that Mod; callers pass installed catalogs to load it.
export const DEFAULT_MAP_CODE = JSON.stringify(DEFAULT_MAP_DEFINITION);

/**
 * Decode and validate a map before adding it to the local library or room.
 * Unknown terrain/Mod and victory-condition ids fail here, not during play.
 * The unversioned old `legacyDemoMap` object is also accepted and upgraded.
 */
export function parseMapCode(raw: string, catalogs: MapCatalogs = {}): MapDefinition {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_MAP_CODE_LENGTH) {
    throw new Error("地图码为空或超过 64 KiB。");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("地图码不是有效的 JSON。");
  }
  return validateMapDefinition(decoded, catalogs);
}

/** Normalize and validate before exporting, so copied codes always load. */
export function serializeMapCode(definition: MapDefinition, catalogs: MapCatalogs = {}): string {
  const normalized = validateMapDefinition(definition, catalogs);
  const code = JSON.stringify(normalized);
  if (code.length > MAX_MAP_CODE_LENGTH) throw new Error("地图码超过 64 KiB。");
  return code;
}

/** Build the same headless state for browser play, server checks and AI runs. */
export function createMatchFromMapCode(code: string, options: MapMatchOptions = {}): GameState {
  return createMatchFromMapDefinition(parseMapCode(code, options), options);
}

export function createMatchFromMapDefinition(definition: MapDefinition, options: MapMatchOptions = {}): GameState {
  // A missing optional Mod may be tolerated by a map library, never by play.
  const map = validateMapDefinition(definition, { ...options, allowUnknownTerrainMods: false });
  const terrainCatalog = options.terrains ?? DEFAULT_MAP_TERRAIN_CATALOG;
  const unitCatalog = options.units ?? coreUnitCatalog;
  const matchConditionCatalog = options.matchConditions ?? coreMatchConditionCatalog;
  const resolvedModSettings = resolveModSettings(
    map.requiredTerrainModIds,
    map.modSettings,
    options.roomModSettings,
    options.mods
  );
  const selectedMods = map.requiredTerrainModIds
    .map((modId) => options.mods?.[modId])
    .filter((mod): mod is NonNullable<typeof mod> => mod !== undefined);
  const spatialPatterns = selectedMods.flatMap((mod) => mod.spatialPatterns ?? []).sort((left, right) => left.id.localeCompare(right.id));
  const rules = selectedMods.flatMap((mod) => mod.rules ?? []).sort((left, right) => left.id.localeCompare(right.id));
  const rows = map.terrain.length / map.columns;
  const cells = {} as Record<CellId, MapCell>;
  const units = {} as Record<UnitId, UnitState>;
  const players = {} as Record<PlayerId, GameState["players"][PlayerId]>;
  const teams = {} as Record<TeamId, GameState["teams"][TeamId]>;
  const active = new Set(options.activePlayerIds ?? Array.from({ length: map.players }, (_, index) => `player-${index + 1}` as PlayerId));

  for (const playerId of active) {
    if (!/^player-([1-9]\d*)$/.test(playerId) || Number(playerId.slice(7)) > map.players) {
      throw new Error(`地图没有玩家位置：${playerId}`);
    }
  }

  for (let index = 0; index < map.terrain.length; index += 1) {
    const coordinate = { row: Math.floor(index / map.columns), column: index % map.columns };
    const id = toCellId(coordinate);
    cells[id] = { id, coordinate, terrainId: map.terrainLegend[map.terrain[index]!]! };
  }

  // Compile static terrain relationships once during map creation. For
  // example, the stronghold-lock rule becomes incoming links on its six
  // neighboring cells; movement then checks only the links on the arrival
  // cell, while resolving the source cell's current occupant and team.
  const cellTriggers: Record<CellId, { enter: CellTriggerLink[]; leave: CellTriggerLink[] }> = {} as Record<CellId, { enter: CellTriggerLink[]; leave: CellTriggerLink[] }>;
  const triggerSet = (cellId: CellId) => (cellTriggers[cellId] ??= { enter: [], leave: [] });
  const addCellLink = (sourceCellId: CellId, targetCellId: CellId, trigger: "enter" | "leave", relationId: string): void => {
    const triggerCellId = trigger === "enter" ? targetCellId : sourceCellId;
    const relatedCellId = trigger === "enter" ? sourceCellId : targetCellId;
    triggerSet(triggerCellId)[trigger].push({ relatedCellId, relationId });
  };
  const addCellLocalTrigger = (cellId: CellId, trigger: "enter" | "leave", relationId: string): void => {
    triggerSet(cellId)[trigger].push({ relationId });
  };
  for (const source of Object.values(cells)) {
    const terrain = terrainCatalog[source.terrainId];
    if (!terrain) continue;
    if (hasTerrainCapability(terrain, "core/adjacent-hostile-exhaustion")) {
      for (const neighbour of getHexNeighbours(source.coordinate, { columns: map.columns, rows })) {
        addCellLink(source.id, toCellId(neighbour), "enter", "core/adjacent-hostile-exhaustion");
      }
    }
    if (hasTerrainCapability(terrain, "core/exhaust-unpowered-after-capture")) {
      addCellLocalTrigger(source.id, "enter", "core/exhaust-unpowered-after-capture");
    }
    if (hasTerrainCapability(terrain, "core/departure-garrison")) addCellLocalTrigger(source.id, "leave", "core/departure-garrison");
    if (hasTerrainCapability(terrain, "core/exhaust-on-departure")) addCellLocalTrigger(source.id, "leave", "core/exhaust-on-departure");
  }
  for (const link of map.cellLinks ?? []) {
    const sourceCellId = toCellId({ row: Math.floor(link.source / map.columns), column: link.source % map.columns });
    const targetCellId = toCellId({ row: Math.floor(link.target / map.columns), column: link.target % map.columns });
    addCellLink(sourceCellId, targetCellId, link.trigger, link.relationId);
  }

  for (let seat = 1; seat <= map.players; seat += 1) {
    const playerId = `player-${seat}` as PlayerId;
    const teamId = `team-${map.teams[seat - 1]}` as TeamId;
    players[playerId] = {
      id: playerId,
      teamId,
      seat,
      displayName: options.playerDisplayNames?.[playerId]?.trim().slice(0, 24) || `玩家 ${seat}`,
      color: options.playerColors?.[playerId]
        ?? getPlayerColor(DEFAULT_PLAYER_COLOR_IDS[(seat - 1) % DEFAULT_PLAYER_COLOR_IDS.length])!,
      reinforcementPoints: 0
    };
    const existing = teams[teamId];
    teams[teamId] = { id: teamId, playerIds: [...(existing?.playerIds ?? []), playerId] };
  }

  for (const [cellIndex, seat, strength, definitionId = "core/roamer"] of map.soldiers) {
    const ownerId = `player-${seat}` as PlayerId;
    if (!active.has(ownerId)) continue;
    const cellId = toCellId({ row: Math.floor(cellIndex / map.columns), column: cellIndex % map.columns });
    const unitId = `seat-${seat}-cell-${cellIndex}` as UnitId;
    units[unitId] = { id: unitId, definitionId, ownerId, cellId, strength };
    cells[cellId] = { ...cells[cellId]!, unitId };
  }

  const firstActive = Array.from({ length: map.players }, (_, index) => `player-${index + 1}` as PlayerId)
    .find((playerId) => active.has(playerId)) ?? ("player-1" as PlayerId);
  const initialState: GameState = {
    sequence: 0,
    settings: {
      friendlyFire: options.friendlyFire ?? false,
      matchConditionIds: map.matchConditionIds,
      modSettings: resolvedModSettings.values,
      terrainCapabilityOverrides: resolvedModSettings.terrainCapabilityOverrides,
      ...(spatialPatterns.length || rules.length ? { modRuleSet: { patterns: spatialPatterns, rules } } : {})
    },
    board: { columns: map.columns, rows },
    cellTriggers,
    turn: {
      phase: "action",
      currentPlayerId: firstActive,
      round: 1,
      exhaustedUnitIds: [],
      counterattacksUsed: {}
    },
    cells,
    units,
    players,
    teams
  };
  return startMatch(initialState, terrainCatalog, unitCatalog, matchConditionCatalog).state;
}

function validateMapDefinition(input: unknown, catalogs: MapCatalogs): MapDefinition {
  if (!isRecord(input)) throw new Error("地图码必须是对象。");
  const data = upgradeLegacyMap(input);
  if (data.version !== 1) throw new Error("不支持的地图码版本。");
  if (typeof data.id !== "string" || data.id.trim().length === 0 || data.id.length > 80) {
    throw new Error("地图 ID 无效。");
  }
  if (typeof data.name !== "string" || data.name.trim().length === 0 || data.name.length > 60) {
    throw new Error("地图名称无效。");
  }
  if (!Number.isInteger(data.columns) || (data.columns as number) < 1 || (data.columns as number) > 64) {
    throw new Error("地图列数必须在 1 到 64 之间。");
  }
  const columns = data.columns as number;
  if (typeof data.terrain !== "string" || data.terrain.length === 0 || data.terrain.length > MAX_CELLS || data.terrain.length % columns !== 0 || data.terrain.length / columns > 64) {
    throw new Error("地形格数无效，必须能被列数整除，行列各不超过 64。");
  }
  if (!Number.isInteger(data.players) || (data.players as number) < 1 || (data.players as number) > MAX_PLAYERS) {
    throw new Error("地图玩家位数必须在 1 到 64 之间。");
  }
  const players = data.players as number;
  if (!isRecord(data.terrainLegend)) throw new Error("地图缺少地形代码表。");
  const terrainCatalog = catalogs.terrains ?? DEFAULT_MAP_TERRAIN_CATALOG;
  const terrainLegend: Record<string, string> = {};
  const usedSymbols = new Set(data.terrain);
  const inferredTerrainModIds = new Set<string>();
  for (const [symbol, terrainId] of Object.entries(data.terrainLegend)) {
    if (!usedSymbols.has(symbol)) continue;
    if (symbol.length !== 1 || typeof terrainId !== "string" || terrainId.length === 0) {
      throw new Error(`未知的地形或 Mod：${symbol} → ${String(terrainId)}`);
    }
    const modId = terrainModIdFor(terrainId, catalogs);
    if (modId) inferredTerrainModIds.add(modId);
    if (!terrainCatalog[terrainId] && (!catalogs.allowUnknownTerrainMods || !modId)) {
      throw new Error(`未知的地形或 Mod：${symbol} → ${terrainId}`);
    }
    terrainLegend[symbol] = terrainId;
  }
  for (const symbol of data.terrain) {
    if (!terrainLegend[symbol]) throw new Error(`地图使用了未定义的地形代码：${symbol}`);
  }
  const declaredTerrainModIds = data.requiredTerrainModIds ?? [...inferredTerrainModIds];
  if (!Array.isArray(declaredTerrainModIds) || declaredTerrainModIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 120 || id.trim() !== id) || new Set(declaredTerrainModIds).size !== declaredTerrainModIds.length) {
    throw new Error("地块 Mod 依赖列表无效。");
  }
  if (declaredTerrainModIds.length !== inferredTerrainModIds.size || declaredTerrainModIds.some((id) => !inferredTerrainModIds.has(id))) {
    throw new Error("地块 Mod 依赖与地图实际使用的地形不一致。");
  }
  const modSettings = validateModSettings(
    data.modSettings,
    declaredTerrainModIds as string[],
    catalogs.mods,
    Boolean(catalogs.allowUnknownTerrainMods)
  );
  if (!Array.isArray(data.soldiers)) throw new Error("地图兵力数据无效。");
  const unitCatalog = catalogs.units ?? coreUnitCatalog;
  const occupied = new Set<number>();
  const soldiers: MapSoldier[] = [];
  for (const candidate of data.soldiers) {
    if (!Array.isArray(candidate) || candidate.length < 3 || candidate.length > 4) {
      throw new Error("兵力格式应为 [格索引, 玩家位, 点数, 可选兵种 ID]。");
    }
    const [cellIndex, seat, strength, suppliedDefinitionId] = candidate as unknown[];
    const definitionId = suppliedDefinitionId ?? "core/roamer";
    if (!Number.isInteger(cellIndex) || (cellIndex as number) < 0 || (cellIndex as number) >= data.terrain.length) {
      throw new Error("兵力格索引超出地图。");
    }
    if (!Number.isInteger(seat) || (seat as number) < 1 || (seat as number) > players) {
      throw new Error("兵力玩家位超出地图玩家位数。");
    }
    if (!Number.isInteger(strength) || (strength as number) < 1 || (strength as number) > 65535) {
      throw new Error("兵力点数无效。");
    }
    if (typeof definitionId !== "string" || !unitCatalog[definitionId]) {
      throw new Error(`地图使用了未安装的兵种或 Mod：${String(definitionId)}`);
    }
    if (occupied.has(cellIndex as number)) throw new Error("同一个格子不能放置两个单位。");
    const terrainId = terrainLegend[data.terrain[cellIndex as number]!]!;
    if (terrainCatalog[terrainId] && !hasTerrainCapability(terrainCatalog[terrainId]!, "core/occupiable")) {
      throw new Error("山地或虚无等不可驻兵地形不能放置单位。");
    }
    occupied.add(cellIndex as number);
    soldiers.push(suppliedDefinitionId === undefined
      ? [cellIndex as number, seat as number, strength as number]
      : [cellIndex as number, seat as number, strength as number, definitionId]);
  }
  const teams = data.teams === undefined
    ? Array.from({ length: players }, (_, index) => index + 1)
    : data.teams;
  if (!Array.isArray(teams) || teams.length !== players || teams.some((team) => !Number.isInteger(team) || team < 1 || team > MAX_PLAYERS)) {
    throw new Error("队伍配置必须为每个玩家位指定 1 到 64 的队伍号。");
  }
  const matchConditionIds = data.matchConditionIds ?? DEFAULT_CONDITIONS;
  if (!Array.isArray(matchConditionIds) || matchConditionIds.some((id) => typeof id !== "string")) {
    throw new Error("胜负条件模块列表无效。");
  }
  const matchConditionCatalog = catalogs.matchConditions ?? coreMatchConditionCatalog;
  for (const id of matchConditionIds as string[]) {
    if (id !== "core/last-team-standing" && !matchConditionCatalog[id]) {
      throw new Error(`地图使用了未安装的胜负条件模块：${id}`);
    }
  }
  const cellLinks = validateCellLinks(data.cellLinks, data.terrain.length);
  return {
    version: 1,
    id: data.id.trim(),
    name: data.name.trim(),
    columns,
    terrain: data.terrain,
    terrainLegend,
    requiredTerrainModIds: [...inferredTerrainModIds],
    ...(modSettings ? { modSettings } : {}),
    ...(cellLinks.length ? { cellLinks } : {}),
    players,
    soldiers,
    teams: [...teams] as number[],
    matchConditionIds: [...matchConditionIds] as string[]
  };
}

function validateCellLinks(input: unknown, cellCount: number): MapCellLink[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > cellCount * 8) {
    throw new Error("格子关联列表无效或数量超过地图上限。");
  }
  const seen = new Set<string>();
  const links: MapCellLink[] = [];
  for (const candidate of input) {
    if (!isRecord(candidate)
      || !Number.isInteger(candidate.source) || (candidate.source as number) < 0 || (candidate.source as number) >= cellCount
      || !Number.isInteger(candidate.target) || (candidate.target as number) < 0 || (candidate.target as number) >= cellCount
      || (candidate.trigger !== "enter" && candidate.trigger !== "leave")
      || typeof candidate.relationId !== "string" || !/^[a-z0-9][a-z0-9/-]{0,119}$/.test(candidate.relationId)) {
      throw new Error("格子关联必须指定有效的源格、目标格和关系 ID。");
    }
    const link = candidate as unknown as MapCellLink;
    const key = `${link.trigger}:${link.source}:${link.target}:${link.relationId}`;
    if (seen.has(key)) throw new Error("格子关联不能重复。");
    seen.add(key);
    links.push({ trigger: link.trigger, source: link.source, target: link.target, relationId: link.relationId });
  }
  return links;
}

function upgradeLegacyMap(input: Record<string, unknown>): Record<string, unknown> {
  if (input.version !== undefined) return input;
  if (!Array.isArray(input.soldiers) || typeof input.terrain !== "string") return input;
  const oldSeats = input.soldiers.map((soldier) => Array.isArray(soldier) ? soldier[1] : undefined);
  if (oldSeats.some((seat) => !Number.isInteger(seat) || seat < 0)) return input;
  const players = Math.max(1, ...oldSeats.map((seat) => (seat as number) + 1));
  return {
    version: 1,
    id: String(input.id ?? "legacy-map"),
    name: typeof input.name === "string" ? input.name : `地图 ${String(input.id ?? "legacy")}`,
    columns: input.columns,
    terrain: input.terrain,
    terrainLegend: DEFAULT_LEGEND,
    players,
    soldiers: input.soldiers.map((soldier) => {
      if (!Array.isArray(soldier)) return soldier;
      return [soldier[0], (soldier[1] as number) + 1, soldier[2]];
    }),
    teams: Array.from({ length: players }, (_, index) => index + 1),
    matchConditionIds: DEFAULT_CONDITIONS
  };
}

/**
 * A registered provider is authoritative. The `mod/<slug>` convention lets
 * old map codes advertise common dependencies even before a Mod is installed.
 */
function terrainModIdFor(terrainId: string, catalogs: MapCatalogs): string | undefined {
  const registered = catalogs.terrainModIds?.[terrainId];
  if (registered !== undefined) {
    if (!registered || registered.trim() !== registered) throw new Error(`地块 Mod ID 无效：${terrainId}`);
    return registered;
  }
  if (terrainId.startsWith("core/")) return undefined;
  const [, slug] = /^mod\/([^/]+)(?:\/.*)?$/.exec(terrainId) ?? [];
  if (slug) return `mod-${slug}`;
  throw new Error(`未知的地形或 Mod（无法确定所属 Mod）：${terrainId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
