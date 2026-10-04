import { describe, expect, it } from "vitest";
import { selectSpatialPatternCells, selectSpatialPatternUnits, type SpatialPatternDefinition } from "./spatial-pattern.js";
import type { TerrainCatalog } from "./content.js";
import type { CellId, GameState, PlayerId, TeamId, UnitId } from "./state.js";

const p1 = "p1" as PlayerId;
const p2 = "p2" as PlayerId;
const cellId = (column: number) => `${column},0` as CellId;
const unitId = (name: string) => name as UnitId;

const terrains: TerrainCatalog = {
  source: { id: "source", displayName: "源", capabilities: [{ id: "power-source" }, { id: "conductor" }] },
  wire: { id: "wire", displayName: "线", capabilities: [{ id: "conductor" }] },
  plain: { id: "plain", displayName: "平原", capabilities: [] }
};

const state: GameState = {
  sequence: 0,
  settings: { friendlyFire: false },
  board: { columns: 5, rows: 1 },
  turn: { phase: "action", currentPlayerId: p1, round: 1, exhaustedUnitIds: [], counterattacksUsed: {} },
  cells: Object.fromEntries(Array.from({ length: 5 }, (_, column) => {
    const id = cellId(column);
    const unit = column < 4 ? unitId(`unit-${column}`) : undefined;
    return [id, { id, coordinate: { column, row: 0 }, terrainId: column === 0 ? "source" : column < 4 ? "wire" : "plain", ...(unit ? { unitId: unit } : {}) }];
  })) as GameState["cells"],
  units: Object.fromEntries(Array.from({ length: 4 }, (_, column) => {
    const id = unitId(`unit-${column}`);
    return [id, { id, definitionId: "unit", ownerId: column === 3 ? p2 : p1, cellId: cellId(column), strength: 1 }];
  })) as GameState["units"],
  players: {
    [p1]: { id: p1, teamId: "t1" as TeamId, seat: 1, displayName: "甲", color: "#fff", reinforcementPoints: 0 },
    [p2]: { id: p2, teamId: "t2" as TeamId, seat: 2, displayName: "乙", color: "#000", reinforcementPoints: 0 }
  },
  teams: {
    ["t1" as TeamId]: { id: "t1" as TeamId, playerIds: [p1] },
    ["t2" as TeamId]: { id: "t2" as TeamId, playerIds: [p2] }
  }
};

describe("serializable spatial patterns", () => {
  it("uses start filters and repeated neighbor steps to find only connected friendly conductive units", () => {
    const poweredNetwork: SpatialPatternDefinition = {
      id: "mod/example/powered-network",
      result: { entity: "unit", distinctBy: "id" },
      starts: {
        op: "all",
        items: [
          { op: "terrain-has", capabilityId: "power-source" },
          { op: "terrain-has", capabilityId: "conductor" },
          { op: "unit-owner-is", owner: "actor" }
        ]
      },
      expression: {
        op: "repeat", min: 0, max: 5,
        item: {
          op: "step", relation: "hex-neighbor",
          where: {
            op: "all",
            items: [
              { op: "terrain-has", capabilityId: "conductor" },
              { op: "unit-owner-is", owner: "actor" }
            ]
          }
        }
      }
    };

    const cellSelectionPattern = { ...poweredNetwork, result: { entity: "cell" as const } };
    expect([...selectSpatialPatternCells(state, terrains, cellSelectionPattern, p1)].sort())
      .toEqual([cellId(0), cellId(1), cellId(2)].sort());
    expect([...selectSpatialPatternUnits(state, terrains, poweredNetwork, p1)].sort())
      .toEqual([unitId("unit-0"), unitId("unit-1"), unitId("unit-2")].sort());
  });

  it("supports grouped alternatives and ordered path sequences", () => {
    const path: SpatialPatternDefinition = {
      id: "mod/example/two-step-route",
      result: { entity: "cell" },
      starts: { op: "terrain-has", capabilityId: "power-source" },
      expression: {
        op: "sequence",
        items: [
          { op: "step", relation: "hex-neighbor", where: { op: "any", items: [
            { op: "terrain-has", capabilityId: "conductor" },
            { op: "terrain-has", capabilityId: "missing-alternative" }
          ] } },
          { op: "step", relation: "hex-neighbor", where: { op: "terrain-has", capabilityId: "conductor" } }
        ]
      }
    };
    expect([...selectSpatialPatternCells(state, terrains, path, p1)]).toContain(cellId(2));
  });

  it("can exclude area anchors when a repeated path folds back to its start", () => {
    const surroundingArea: SpatialPatternDefinition = {
      id: "mod/example/surrounding-two-rings",
      result: { entity: "cell" },
      starts: { op: "terrain-has", capabilityId: "power-source" },
      expression: {
        op: "repeat", min: 1, max: 2,
        item: { op: "step", relation: "hex-neighbor", where: { op: "cell-exists" } }
      },
      excludeStarts: true
    };
    const selected = selectSpatialPatternCells(state, terrains, surroundingArea, p1);
    expect(selected).toContain(cellId(1));
    expect(selected).toContain(cellId(2));
    expect(selected).not.toContain(cellId(0));
  });

  it("selects exact concentric rings by shortest hex distance", () => {
    const secondRing: SpatialPatternDefinition = {
      id: "mod/example/exact-second-ring",
      result: { entity: "cell" },
      starts: { op: "terrain-has", capabilityId: "power-source" },
      expression: { op: "hex-range", min: 2, max: 2, where: { op: "cell-exists" } }
    };
    expect([...selectSpatialPatternCells(state, terrains, secondRing, p1)]).toEqual([cellId(2)]);
  });

  it("evaluates several full-board alternatives on the largest supported map", () => {
    const largeState: GameState = {
      ...state,
      board: { columns: 64, rows: 64 },
      cells: Object.fromEntries(Array.from({ length: 64 * 64 }, (_, index) => {
        const column = index % 64;
        const row = Math.floor(index / 64);
        const id = `${column},${row}` as CellId;
        return [id, { id, coordinate: { column, row }, terrainId: "plain" }];
      })) as GameState["cells"],
      units: {}
    };
    const wideTerrains: TerrainCatalog = {
      plain: { id: "plain", displayName: "平原", capabilities: [{ id: "test/all-cells" }] }
    };
    const broadStep = {
      op: "step" as const,
      relation: "hex-neighbor" as const,
      where: { op: "terrain-has" as const, capabilityId: "test/all-cells" }
    };
    const broadPattern: SpatialPatternDefinition = {
      id: "mod/example/five-way-scan",
      result: { entity: "cell" },
      starts: { op: "terrain-has", capabilityId: "test/all-cells" },
      expression: { op: "either", items: [broadStep, broadStep, broadStep, broadStep, broadStep] }
    };

    expect(selectSpatialPatternCells(largeState, wideTerrains, broadPattern, p1).size).toBe(64 * 64);
  });
});
