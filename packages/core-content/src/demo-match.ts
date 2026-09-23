import { startMatch, toCellId } from "@numeral-lord/game-core";
import type {
  CellId,
  GameState,
  MapCell,
  PlayerId,
  TeamId,
  UnitId
} from "@numeral-lord/game-core";
import { coreTerrainCatalog } from "./terrains.js";
import { coreUnitCatalog } from "./units.js";
import { coreMatchConditionCatalog } from "./match-conditions.js";
import { legacyDemoMap } from "./legacy-demo-map.js";
// The demo explicitly opts into this optional Mod. The relative source import
// keeps the workspace preview usable before a consumer runs a package build.
import { OIL_FIELD_TERRAIN_ID, oilFieldTerrainCatalog } from "../../oil-field-mod/src/index.js";

const playerOne = "player-1" as PlayerId;
const playerTwo = "player-2" as PlayerId;
const teamOne = "team-1" as TeamId;
const teamTwo = "team-2" as TeamId;

function unitId(value: string): UnitId {
  return value as UnitId;
}

function terrainFromLegacyCode(code: string): string {
  const terrainIds: Record<string, string> = {
    M: "core/plain",
    P: "core/mountain",
    S: "core/stronghold",
    O: "core/ocean",
    F: OIL_FIELD_TERRAIN_ID,
    V: "core/void"
  };
  const terrainId = terrainIds[code];
  if (!terrainId) throw new Error(`Legacy demo map has unknown terrain code: ${code}`);
  return terrainId;
}

/**
 * A data-only fixture for manual preview, rule tests, and headless agents.
 * It deliberately imports no browser, Vue, or Pixi code.
 */
export function createDemoMatch(): GameState {
  // This map explicitly installs the optional oil-field Mod alongside the
  // native terrain pack. Other maps can omit it and never know this terrain.
  const terrainCatalog = { ...coreTerrainCatalog, ...oilFieldTerrainCatalog };
  const columns = legacyDemoMap.columns;
  const rows = legacyDemoMap.terrain.length / columns;
  const cells: Record<CellId, MapCell> = {} as Record<CellId, MapCell>;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const coordinate = { column, row };
      const id = toCellId(coordinate);
      cells[id] = {
        id,
        coordinate,
        terrainId: terrainFromLegacyCode(legacyDemoMap.terrain[row * columns + column] ?? "")
      };
    }
  }

  const legacyPlayers = [playerOne, playerTwo] as const;
  const units: Record<UnitId, NonNullable<GameState["units"][UnitId]>> = {};
  for (const [index, legacyPlayer, strength] of legacyDemoMap.soldiers) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const ownerId = legacyPlayers[legacyPlayer];
    if (!ownerId) throw new Error(`Legacy demo map has unknown player number: ${legacyPlayer}`);
    const id = unitId(`${legacyPlayer === 0 ? "red" : "blue"}-${index}`);
    units[id] = {
      id,
      definitionId: "core/roamer",
      ownerId,
      cellId: toCellId({ column, row }),
      strength
    };
  }

  for (const unit of Object.values(units)) {
    const cell = cells[unit.cellId];
    if (cell) cells[unit.cellId] = { ...cell, unitId: unit.id };
  }

  const initialState: GameState = {
    sequence: 0,
    board: { columns, rows },
    settings: {
      friendlyFire: false,
      // 地图显式选择模块；这不是前端 if，也不是据点的硬编码继承逻辑。
      matchConditionIds: ["core/lose-all-survival-anchors", "core/last-team-standing"]
    },
    turn: { phase: "action", currentPlayerId: playerOne, round: 1, exhaustedUnitIds: [], counterattacksUsed: {} },
    cells,
    units,
    players: {
      [playerOne]: { id: playerOne, teamId: teamOne, seat: 1, displayName: "赤方 · 玩家 1", color: "#fb7185", reinforcementPoints: 0 },
      [playerTwo]: { id: playerTwo, teamId: teamTwo, seat: 2, displayName: "蓝方 · 玩家 2", color: "#60a5fa", reinforcementPoints: 0 }
    },
    teams: {
      [teamOne]: { id: teamOne, playerIds: [playerOne] },
      [teamTwo]: { id: teamTwo, playerIds: [playerTwo] }
    }
  };
  return startMatch(initialState, terrainCatalog, coreUnitCatalog, coreMatchConditionCatalog).state;
}
