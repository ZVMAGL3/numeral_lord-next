import { hasTerrainCapability, startMatch, toCellId } from "@numeral-lord/game-core";
import type {
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
import { oilFieldTerrainCatalog, OIL_FIELD_TERRAIN_ID } from "../../oil-field-mod/src/index.js";
import { coreMatchConditionCatalog } from "./match-conditions.js";
import { legacyDemoMap } from "./legacy-demo-map.js";
import { coreTerrainCatalog } from "./terrains.js";
import { coreUnitCatalog } from "./units.js";

/** A soldier is [row-major cell index, one-based map seat, strength, optional unit id]. */
export type MapSoldier = readonly [number, number, number, string?];

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
  readonly players: number;
  readonly soldiers: readonly MapSoldier[];
  readonly teams: readonly number[];
  readonly matchConditionIds: readonly string[];
}

export interface MapCatalogs {
  /** Pass the same installed terrain/Mod catalog to map loading and the engine. */
  readonly terrains?: TerrainCatalog;
  readonly units?: UnitCatalog;
  readonly matchConditions?: MatchConditionCatalog;
}

export interface MapMatchOptions extends MapCatalogs {
  /** Seats without a room participant start with no units. */
  readonly activePlayerIds?: readonly PlayerId[];
  readonly friendlyFire?: boolean;
}

export const DEFAULT_MAP_TERRAIN_CATALOG: TerrainCatalog = {
  ...coreTerrainCatalog,
  ...oilFieldTerrainCatalog
};

const DEFAULT_LEGEND: Readonly<Record<string, string>> = {
  M: "core/plain",
  P: "core/mountain",
  S: "core/stronghold",
  O: "core/ocean",
  F: OIL_FIELD_TERRAIN_ID,
  V: "core/void"
};

const DEFAULT_CONDITIONS = ["core/lose-all-survival-anchors", "core/last-team-standing"];
const MAX_MAP_CODE_LENGTH = 64 * 1024;
const MAX_CELLS = 4096;
const MAX_PLAYERS = 64;
const PLAYER_COLORS = [
  "#fb7185", "#60a5fa", "#fbbf24", "#a78bfa",
  "#34d399", "#f472b6", "#38bdf8", "#fb923c"
];

/** The old 1001 map is the first built-in map, 昏晓. */
export const DEFAULT_MAP_DEFINITION: MapDefinition = {
  version: 1,
  id: String(legacyDemoMap.id),
  name: "昏晓",
  columns: legacyDemoMap.columns,
  terrain: legacyDemoMap.terrain,
  terrainLegend: DEFAULT_LEGEND,
  players: 2,
  soldiers: legacyDemoMap.soldiers.map(([index, legacySeat, strength]) => [index, legacySeat + 1, strength]),
  teams: [1, 2],
  matchConditionIds: DEFAULT_CONDITIONS
};

/** Canonical shareable map code. It is ordinary JSON for easy inspection. */
export const DEFAULT_MAP_CODE = serializeMapCode(DEFAULT_MAP_DEFINITION);

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
  const map = validateMapDefinition(definition, options);
  const terrainCatalog = options.terrains ?? DEFAULT_MAP_TERRAIN_CATALOG;
  const unitCatalog = options.units ?? coreUnitCatalog;
  const matchConditionCatalog = options.matchConditions ?? coreMatchConditionCatalog;
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

  for (let seat = 1; seat <= map.players; seat += 1) {
    const playerId = `player-${seat}` as PlayerId;
    const teamId = `team-${map.teams[seat - 1]}` as TeamId;
    players[playerId] = {
      id: playerId,
      teamId,
      seat,
      displayName: `玩家 ${seat}`,
      color: PLAYER_COLORS[(seat - 1) % PLAYER_COLORS.length]!,
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
    settings: { friendlyFire: options.friendlyFire ?? false, matchConditionIds: map.matchConditionIds },
    board: { columns: map.columns, rows },
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
  for (const [symbol, terrainId] of Object.entries(data.terrainLegend)) {
    if (!usedSymbols.has(symbol)) continue;
    if (symbol.length !== 1 || typeof terrainId !== "string" || !terrainCatalog[terrainId]) {
      throw new Error(`未知的地形或 Mod：${symbol} → ${String(terrainId)}`);
    }
    terrainLegend[symbol] = terrainId;
  }
  for (const symbol of data.terrain) {
    if (!terrainLegend[symbol]) throw new Error(`地图使用了未定义的地形代码：${symbol}`);
  }
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
    if (!hasTerrainCapability(terrainCatalog[terrainId]!, "core/occupiable")) {
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
  return {
    version: 1,
    id: data.id.trim(),
    name: data.name.trim(),
    columns,
    terrain: data.terrain,
    terrainLegend,
    players,
    soldiers,
    teams: [...teams] as number[],
    matchConditionIds: [...matchConditionIds] as string[]
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
