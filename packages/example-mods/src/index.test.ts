import { describe, expect, it } from "vitest";
import { validateTerrainModDefinition } from "@numeral-lord/content-schema";
import type { GameCommand, GameState, TerrainCatalog } from "@numeral-lord/game-core";
import { applyModRules } from "@numeral-lord/game-core";
import {
  borderWardMod,
  exampleTerrainMods,
  GROVE_MOD_ID,
  GROVE_TERRAIN_ID,
  WARD_MOD_ID,
  WARD_TERRAIN_ID,
  verdantGroveMod
} from "./index.js";
import type { CellId, PlayerId, TeamId, UnitId } from "@numeral-lord/game-core";
import { toCellId } from "@numeral-lord/game-core";

const p1 = "player-1" as PlayerId;
const p2 = "player-2" as PlayerId;
const t1 = "team-1" as TeamId;
const t2 = "team-2" as TeamId;
const mobileId = "unit-mobile" as UnitId;
const wardId = "unit-ward" as UnitId;
const cell = (column: number, row: number) => toCellId({ column, row });

const terrainCatalog: TerrainCatalog = {
  "core/plain": { id: "core/plain", displayName: "平原", capabilities: [{ id: "core/occupiable" }] },
  [GROVE_TERRAIN_ID]: verdantGroveMod.terrain,
  [WARD_TERRAIN_ID]: borderWardMod.terrain
};

function fixture(options: { readonly mobileColumn?: number; readonly grove?: boolean } = {}): GameState {
  const mobileColumn = options.mobileColumn ?? (options.grove ? 1 : 0);
  const cells: Record<CellId, GameState["cells"][CellId]> = {} as Record<CellId, GameState["cells"][CellId]>;
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const id = cell(column, row);
      cells[id] = {
        id,
        coordinate: { column, row },
        terrainId: options.grove && column === 1 && row === 1 ? GROVE_TERRAIN_ID : "core/plain"
      };
    }
  }
  cells[cell(mobileColumn, 1)] = { ...cells[cell(mobileColumn, 1)]!, unitId: mobileId };
  cells[cell(3, 1)] = { ...cells[cell(3, 1)]!, terrainId: WARD_TERRAIN_ID, unitId: wardId };
  const patterns = [...(verdantGroveMod.spatialPatterns ?? []), ...(borderWardMod.spatialPatterns ?? [])];
  const rules = [...(verdantGroveMod.rules ?? []), ...(borderWardMod.rules ?? [])];
  return {
    sequence: 0,
    settings: {
      friendlyFire: false,
      modSettings: {
        [GROVE_MOD_ID]: { pointsPerTurn: 3 },
        [WARD_MOD_ID]: { radius: "2", exhaustOnEnter: true, exhaustOnLeave: true }
      },
      modRuleSet: { patterns, rules }
    },
    board: { columns: 5, rows: 3 },
    turn: { phase: "action", currentPlayerId: p1, round: 1, exhaustedUnitIds: [], counterattacksUsed: {} },
    cells,
    units: {
      [mobileId]: { id: mobileId, definitionId: "core/roamer", ownerId: p1, cellId: cell(mobileColumn, 1), strength: 3 },
      [wardId]: { id: wardId, definitionId: "core/roamer", ownerId: p2, cellId: cell(3, 1), strength: 3 }
    },
    players: {
      [p1]: { id: p1, teamId: t1, seat: 1, displayName: "甲", color: "#f66", reinforcementPoints: 0 },
      [p2]: { id: p2, teamId: t2, seat: 2, displayName: "乙", color: "#66f", reinforcementPoints: 0 }
    },
    teams: {
      [t1]: { id: t1, playerIds: [p1] },
      [t2]: { id: t2, playerIds: [p2] }
    }
  };
}

function move(state: GameState, destination: CellId): { readonly command: GameCommand; readonly next: GameState } {
  const unit = state.units[mobileId]!;
  const origin = state.cells[unit.cellId]!;
  const destinationCell = state.cells[destination]!;
  const { unitId: _unitId, ...emptyOrigin } = origin;
  return {
    command: {
      type: "move-unit",
      commandId: `test-${destination}`,
      actorId: p1,
      expectedSequence: state.sequence,
      unitId: mobileId,
      destinationId: destination
    },
    next: {
      ...state,
      cells: { ...state.cells, [origin.id]: emptyOrigin, [destination]: { ...destinationCell, unitId: mobileId } },
      units: { ...state.units, [mobileId]: { ...unit, cellId: destination } }
    }
  };
}

describe("bundled example Mods", () => {
  it("satisfies the same structural contract used for Workshop imports", () => {
    for (const mod of exampleTerrainMods) {
      expect(() => validateTerrainModDefinition({
        id: mod.id,
        version: mod.version,
        capabilities: mod.capabilities,
        settings: mod.settings,
        spatialPatterns: mod.spatialPatterns,
        rules: mod.rules,
        terrain: { capabilities: mod.terrain.capabilities, ...(mod.terrain.visuals ? { visuals: mod.terrain.visuals } : {}) }
      })).not.toThrow();
    }
  });

  it("accepts safe composable predicates for custom terrain income", () => {
    expect(() => validateTerrainModDefinition({
      id: "mod-income-condition",
      version: "1.0.0",
      capabilities: [{
        id: "core/income-source",
        target: "terrain",
        defaultConfig: { amount: 2, requires: "occupied", when: "owner-turn-start" }
      }],
      terrain: {
        capabilities: [
          { id: "core/occupiable" },
          { id: "core/income-source", config: {
            amount: 2,
            condition: { op: "all", items: [
              { op: "unit-is-powered" },
              { op: "unit-has-marker", marker: "income-eligible" }
            ] }
          } }
        ],
        visuals: { baseColor: "#638f67" }
      }
    }, { requireBaseLayer: true })).not.toThrow();
  });

  it("grants the configured income to the current player for each occupied Grove", () => {
    const state = fixture({ grove: true });
    const result = applyModRules(state, state, undefined, terrainCatalog, true);
    expect(result.players[p1]?.reinforcementPoints).toBe(3);
    expect(result.players[p2]?.reinforcementPoints).toBe(0);
  });

  it("applies a hostile ward's selected boundary behavior, not movement inside its area", () => {
    const enteringState = fixture();
    const entering = move(enteringState, cell(1, 1)); // distance 3 -> 2 from the ward
    const enterResult = applyModRules(enteringState, entering.next, entering.command, terrainCatalog);
    expect(enterResult.turn.exhaustedUnitIds).toContain(mobileId);

    const internalState = fixture({ mobileColumn: 2 });
    const internal = move(internalState, cell(1, 1)); // distance 1 -> 2; both cells are inside radius 2
    const internalResult = applyModRules(internalState, internal.next, internal.command, terrainCatalog);
    expect(internalResult.turn.exhaustedUnitIds).not.toContain(mobileId);

    const leavingState = fixture({ mobileColumn: 1 });
    const leaving = move(leavingState, cell(0, 1)); // distance 2 -> 3 from the ward
    const leaveResult = applyModRules(leavingState, leaving.next, leaving.command, terrainCatalog);
    expect(leaveResult.turn.exhaustedUnitIds).toContain(mobileId);
  });

  it("clears an inactive-unit reference if a Mod effect destroys the unit", () => {
    const base = fixture();
    const markedCell = cell(0, 1);
    const state: GameState = {
      ...base,
      turn: { ...base.turn, exhaustedUnitIds: [mobileId] },
      units: { ...base.units, [mobileId]: { ...base.units[mobileId]!, markers: ["mod-test/doomed"] } },
      settings: {
        ...base.settings,
        modRuleSet: {
          patterns: [{
            id: "mod-test/doomed-units",
            starts: { op: "unit-has-marker", marker: "mod-test/doomed" },
            expression: { op: "repeat", min: 0, max: 0, item: {
              op: "step", relation: "hex-neighbor", where: { op: "cell-exists" }
            } },
            result: { entity: "unit", distinctBy: "id" }
          }],
          rules: [{
            id: "mod-test/doom-on-turn-start",
            trigger: "turn-start",
            target: { scope: "pattern-units", patternId: "mod-test/doomed-units", owner: "actor" },
            effects: [{ type: "change-strength", amount: -100 }]
          }]
        }
      }
    };
    const result = applyModRules(state, state, undefined, terrainCatalog, true);
    expect(result.units[mobileId]).toBeUndefined();
    expect(result.cells[markedCell]?.unitId).toBeUndefined();
    expect(result.turn.exhaustedUnitIds).not.toContain(mobileId);
  });
});
