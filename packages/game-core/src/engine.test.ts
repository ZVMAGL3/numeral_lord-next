import { describe, expect, it } from "vitest";
import { coreMatchConditionCatalog } from "../../core-content/src/match-conditions.js";
import { applyCommand, finishMatch, getActionableUnitIds, getLegalActionDestinationIds, getPoweredUnitIds, startMatch } from "./engine.js";
import { applyIntent, getLegalIntents } from "./simulation.js";
import type { TerrainCatalog, UnitCatalog } from "./content.js";
import { toCellId } from "./hex.js";
import type {
  CellId,
  GameState,
  MapCell,
  PlayerId,
  TeamId,
  UnitId
} from "./state.js";

const p1 = "p1" as PlayerId;
const p2 = "p2" as PlayerId;
const t1 = "t1" as TeamId;
const t2 = "t2" as TeamId;
const id = (value: string) => value as UnitId;

const terrains: TerrainCatalog = {
  mountain: { id: "mountain", displayName: "山地", capabilities: [] },
  plain: { id: "plain", displayName: "平原", capabilities: [{ id: "core/occupiable" }, { id: "core/power-conductor" }] },
  ocean: {
    id: "ocean",
    displayName: "海洋",
    capabilities: [
      { id: "core/occupiable" },
      { id: "core/exhaust-on-departure", config: { destinationTerrainIdNot: "ocean" } }
    ]
  },
  stronghold: {
    id: "stronghold",
    displayName: "据点",
    capabilities: [
      { id: "core/occupiable" },
      { id: "core/power-conductor" },
      { id: "core/power-source" },
      { id: "core/survival-anchor" },
      { id: "core/adjacent-hostile-exhaustion" }
    ]
  },
  oilfield: {
    id: "oilfield",
    displayName: "油田",
    capabilities: [
      { id: "core/occupiable" },
      {
        id: "core/departure-garrison",
        config: { strength: 1, unitDefinitionId: "roamer" }
      }
    ]
  }
};

const unitCatalog: UnitCatalog = {
  roamer: {
    id: "roamer",
    displayName: "游兵",
    capabilities: [
      { id: "core/move", config: { maxDistance: 1 } },
      { id: "core/attack", config: { movesIntoTarget: true } },
      { id: "core/attack-range", config: { min: 1, max: 1 } },
      { id: "core/counterattack" },
      { id: "core/counterattack-limit", config: { maxPerActionPhase: 1 } },
      { id: "core/action-strength-decay", config: { amount: 1, minimumStrength: 1 } },
      { id: "core/powered-action-threshold", config: { minimumStrength: 2 } },
      { id: "core/powered-income", config: { amount: 1 } },
      { id: "core/exhaust-after-attack" }
    ]
  }
};

function fixture(): GameState {
  const cells: Record<CellId, MapCell> = {} as Record<CellId, MapCell>;
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const coordinate = { column, row };
      const cellId = toCellId(coordinate);
      cells[cellId] = { id: cellId, coordinate, terrainId: "plain" };
    }
  }
  const p1Home = id("p1-home");
  const p1Scout = id("p1-scout");
  const p2Home = id("p2-home");
  const units: GameState["units"] = {
    [p1Home]: { id: p1Home, definitionId: "roamer", ownerId: p1, cellId: toCellId({ column: 0, row: 1 }), strength: 3 },
    [p1Scout]: { id: p1Scout, definitionId: "roamer", ownerId: p1, cellId: toCellId({ column: 1, row: 1 }), strength: 2 },
    [p2Home]: { id: p2Home, definitionId: "roamer", ownerId: p2, cellId: toCellId({ column: 3, row: 1 }), strength: 3 }
  };
  cells[toCellId({ column: 0, row: 1 })] = { ...cells[toCellId({ column: 0, row: 1 })]!, terrainId: "stronghold", unitId: p1Home };
  cells[toCellId({ column: 1, row: 1 })] = { ...cells[toCellId({ column: 1, row: 1 })]!, unitId: p1Scout };
  cells[toCellId({ column: 3, row: 1 })] = { ...cells[toCellId({ column: 3, row: 1 })]!, terrainId: "stronghold", unitId: p2Home };
  return {
    sequence: 0,
    board: { columns: 5, rows: 3 },
    settings: { friendlyFire: false },
    turn: { phase: "action", currentPlayerId: p1, round: 1, exhaustedUnitIds: [], counterattacksUsed: {} },
    cells,
    units,
    players: {
      [p1]: { id: p1, teamId: t1, seat: 1, displayName: "玩家 1", color: "#f00", reinforcementPoints: 0 },
      [p2]: { id: p2, teamId: t2, seat: 2, displayName: "玩家 2", color: "#00f", reinforcementPoints: 0 }
    },
    teams: {
      [t1]: { id: t1, playerIds: [p1] },
      [t2]: { id: t2, playerIds: [p2] }
    }
  };
}

describe("core turn rules", () => {
  const siegeCatalog: UnitCatalog = {
    ...unitCatalog,
    cannon: { id: "cannon", displayName: "测试炮", capabilities: [
      { id: "core/attack", config: { movesIntoTarget: false } },
      { id: "core/attack-range", config: { min: 1, max: 5 } }
    ] }
  };
  function siegeState(strength: number): GameState {
    const state = fixture();
    return { ...state, turn: { ...state.turn, currentPlayerId: p2 }, units: {
      ...state.units,
      [id("p1-scout")]: { ...state.units[id("p1-scout")]!, strength },
      [id("p2-home")]: { ...state.units[id("p2-home")]!, definitionId: "cannon" }
    } };
  }
  const siegeCommand = {
    type: "attack-unit" as const, commandId: "siege", actorId: p2, expectedSequence: 0,
    unitId: id("p2-home"), targetId: toCellId({ column: 0, row: 1 })
  };

  it("rejects unknown command types instead of returning undefined", () => {
    const state = fixture();
    const result = applyCommand(state, {
      type: "install-mod-at-runtime",
      commandId: "unknown-command",
      actorId: p1,
      expectedSequence: state.sequence
    }, terrains, unitCatalog);

    expect(result).toEqual({
      accepted: false,
      state,
      error: {
        code: "unknown-command",
        message: "无法识别操作类型：install-mod-at-runtime"
      }
    });
  });

  it.each([
    null,
    [],
    { type: "move-unit", commandId: "missing-fields", actorId: p1, expectedSequence: 0 },
    { type: "end-action-phase", commandId: "bad-sequence", actorId: p1, expectedSequence: "0" }
  ])("rejects malformed runtime command %# without throwing", malformedCommand => {
    const state = fixture();
    const result = applyCommand(state, malformedCommand, terrains, unitCatalog);

    expect(result.accepted).toBe(false);
    expect(result.state).toBe(state);
    if (!result.accepted) expect(result.error.code).toBe("invalid-command");
  });

  it("deducts power-loss strength immediately and only once", () => {
    const state = siegeState(3);
    const result = applyCommand(state, siegeCommand, terrains, siegeCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.units[id("p1-scout")]?.strength).toBe(2);
    expect(getPoweredUnitIds(result.state, terrains)).not.toContain(id("p1-scout"));
    expect(state.units[id("p1-scout")]?.strength).toBe(3);
    const next = applyIntent(result.state, { type: "end-action-phase" }, "next", terrains, siegeCatalog);
    expect(next.accepted).toBe(true);
    expect(next.state.units[id("p1-scout")]?.strength).toBe(2);
  });

  it("destroys a one-point disconnected unit and clears its cell immediately", () => {
    const result = applyCommand(siegeState(1), siegeCommand, terrains, siegeCatalog);
    expect(result.accepted).toBe(true);
    expect(result.state.units[id("p1-scout")]).toBeUndefined();
    expect(result.state.cells[toCellId({ column: 1, row: 1 })]?.unitId).toBeUndefined();
    expect(result.state.turn.phase).toBe("finished");
    expect(result.state.result?.winningTeamIds).toEqual([t2]);
  });

  it("uses the map's stronghold elimination module before checking team victory", () => {
    const initial = siegeState(5);
    const state = { ...initial, settings: { ...initial.settings,
      matchConditionIds: ["core/last-team-standing", "core/lose-all-survival-anchors"]
    } };
    const result = applyCommand(state, siegeCommand, terrains, siegeCatalog, coreMatchConditionCatalog);
    expect(result.accepted).toBe(true);
    expect(Object.values(result.state.units).some(unit => unit.ownerId === p1)).toBe(false);
    expect(result.state.turn.phase).toBe("finished");
    expect(result.state.result?.winningTeamIds).toEqual([t2]);
  });

  it("allows maps to disable the default victory condition", () => {
    const initial = siegeState(1);
    const state = { ...initial, settings: { ...initial.settings, matchConditionIds: [] } };
    const result = applyCommand(state, siegeCommand, terrains, siegeCatalog);
    expect(result.accepted).toBe(true);
    expect(result.state.turn.phase).not.toBe("finished");
  });

  it("keeps the army powered and alive when another occupied stronghold remains", () => {
    const initial = siegeState(5);
    const scoutCell = toCellId({ column: 1, row: 1 });
    const state: GameState = { ...initial,
      settings: { ...initial.settings, matchConditionIds: ["core/lose-all-survival-anchors", "core/last-team-standing"] },
      cells: { ...initial.cells, [scoutCell]: { ...initial.cells[scoutCell]!, terrainId: "stronghold" } }
    };
    const result = applyCommand(state, siegeCommand, terrains, siegeCatalog, coreMatchConditionCatalog);
    expect(result.accepted).toBe(true);
    expect(result.state.units[id("p1-scout")]?.strength).toBe(5);
    expect(result.state.turn.phase).not.toBe("finished");
  });

  it("eliminates only the player without strongholds, not their teammate", () => {
    const initial = siegeState(5);
    const state: GameState = { ...initial,
      settings: { friendlyFire: true, matchConditionIds: ["core/lose-all-survival-anchors"] },
      players: { ...initial.players, [p2]: { ...initial.players[p2]!, teamId: t1 } },
      teams: { [t1]: { id: t1, playerIds: [p1, p2] } }
    };
    const result = applyCommand(state, siegeCommand, terrains, siegeCatalog, coreMatchConditionCatalog);
    expect(result.accepted).toBe(true);
    expect(result.state.units[id("p1-scout")]).toBeUndefined();
    expect(result.state.units[id("p2-home")]).toBeDefined();
  });
  it("derives power through a chain of friendly units on conductive terrain", () => {
    const state = fixture();
    const powered = getPoweredUnitIds(state, terrains);
    expect(powered).toEqual(new Set([id("p1-home"), id("p1-scout"), id("p2-home")]));
  });

  it("exhausts a roamer when it leaves ocean for land", () => {
    const state = fixture();
    const sourceCellId = toCellId({ column: 2, row: 0 });
    const destinationCellId = toCellId({ column: 1, row: 0 });
    const source = { ...state.cells[sourceCellId]!, terrainId: "ocean", unitId: id("p1-scout") };
    const cleared = { ...state.cells[toCellId({ column: 1, row: 1 })] };
    delete (cleared as { unitId?: UnitId }).unitId;
    const stateOnOcean: GameState = {
      ...state,
      cells: {
        ...state.cells,
        [toCellId({ column: 1, row: 1 })]: cleared,
        [sourceCellId]: source
      },
      units: {
        ...state.units,
        [id("p1-scout")]: { ...state.units[id("p1-scout")]!, cellId: sourceCellId, strength: 3 }
      }
    };
    const result = applyCommand(stateOnOcean, {
      type: "move-unit", commandId: "leave-ocean", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), destinationId: destinationCellId
    }, terrains, unitCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.turn.exhaustedUnitIds).toContain(id("p1-scout"));
  });

  it("exhausts an unpowered roamer after attacking a unit", () => {
    const state = fixture();
    const oldTargetCell = toCellId({ column: 3, row: 1 });
    const targetCell = toCellId({ column: 2, row: 1 });
    const cleared = { ...state.cells[oldTargetCell]! };
    delete (cleared as { unitId?: UnitId }).unitId;
    const attackState: GameState = {
      ...state,
      cells: {
        ...state.cells,
        [toCellId({ column: 1, row: 1 })]: { ...state.cells[toCellId({ column: 1, row: 1 })]!, terrainId: "ocean" },
        [oldTargetCell]: cleared,
        [targetCell]: { ...state.cells[targetCell]!, unitId: id("p2-home") }
      },
      units: {
        ...state.units,
        [id("p2-home")]: { ...state.units[id("p2-home")]!, cellId: targetCell, strength: 1 }
      }
    };
    const result = applyCommand(attackState, {
      type: "attack-unit", commandId: "attack-exhausts", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), targetId: targetCell
    }, terrains, unitCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    // A successful attack may split the surviving attacker into a new
    // continuation id (for example `p1-scout@0`). Assert against the unit
    // that actually arrived on the target cell, not the pre-attack id.
    const arrivedUnitId = result.state.cells[targetCell]?.unitId;
    expect(arrivedUnitId).toBeDefined();
    expect(result.state.turn.exhaustedUnitIds).toContain(arrivedUnitId);
  });

  it("does not exhaust a powered roamer after attacking", () => {
    const state = fixture();
    const oldTargetCell = toCellId({ column: 3, row: 1 });
    const targetCell = toCellId({ column: 2, row: 1 });
    const cleared = { ...state.cells[oldTargetCell]! };
    delete (cleared as { unitId?: UnitId }).unitId;
    const attackState: GameState = {
      ...state,
      cells: {
        ...state.cells,
        [oldTargetCell]: cleared,
        [targetCell]: { ...state.cells[targetCell]!, unitId: id("p2-home") }
      },
      units: {
        ...state.units,
        [id("p1-scout")]: { ...state.units[id("p1-scout")]!, strength: 5 },
        [id("p2-home")]: { ...state.units[id("p2-home")]!, cellId: targetCell, strength: 1 }
      }
    };
    const result = applyCommand(attackState, {
      type: "attack-unit", commandId: "powered-attack", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), targetId: targetCell
    }, terrains, unitCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const arrivedUnitId = result.state.cells[targetCell]?.unitId;
    expect(arrivedUnitId).toBeDefined();
    expect(result.state.turn.exhaustedUnitIds).not.toContain(arrivedUnitId);
    expect(result.state.units[arrivedUnitId!]?.strength).toBe(3);
  });

  it("prioritizes an occupied enemy stronghold zone over powered attack continuation", () => {
    const state = fixture();
    const targetCell = toCellId({ column: 2, row: 1 });
    const targetId = id("p2-target");
    const attackState: GameState = {
      ...state,
      cells: {
        ...state.cells,
        [targetCell]: { ...state.cells[targetCell]!, unitId: targetId }
      },
      units: {
        ...state.units,
        [id("p1-scout")]: { ...state.units[id("p1-scout")]!, strength: 5 },
        [targetId]: { id: targetId, definitionId: "roamer", ownerId: p2, cellId: targetCell, strength: 1 }
      }
    };

    const result = applyCommand(attackState, {
      type: "attack-unit", commandId: "powered-stronghold-zone", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), targetId: targetCell
    }, terrains, unitCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const arrivedUnitId = result.state.cells[targetCell]?.unitId;
    expect(arrivedUnitId).toBeDefined();
    // The attacker is powered, but the occupied enemy stronghold at (3, 1)
    // still exhausts it because the zone rule has higher priority.
    expect(result.state.turn.exhaustedUnitIds).toEqual([arrivedUnitId]);
  });

  it("does not exhaust an attack arrival near an empty or friendly stronghold", () => {
    const targetCell = toCellId({ column: 2, row: 1 });
    const homeCell = toCellId({ column: 3, row: 1 });
    const targetId = id("p2-target");

    const makeAttackState = (strongholdUnit?: UnitId, strongholdOwner: PlayerId = p2): GameState => {
      const state = fixture();
      const home = state.units[id("p2-home")]!;
      const units: Record<UnitId, NonNullable<GameState["units"][UnitId]>> = {
        ...state.units,
        [id("p1-scout")]: { ...state.units[id("p1-scout")]!, strength: 5 },
        [targetId]: { id: targetId, definitionId: "roamer", ownerId: p2, cellId: targetCell, strength: 1 }
      };
      if (strongholdUnit) {
        units[id("p2-home")] = { ...home, ownerId: strongholdOwner };
      } else {
        delete units[id("p2-home")];
      }
      return {
        ...state,
        cells: {
          ...state.cells,
          [targetCell]: { ...state.cells[targetCell]!, unitId: targetId },
          [homeCell]: strongholdUnit
            ? { ...state.cells[homeCell]!, unitId: id("p2-home") }
            : (() => {
              const { unitId: ignored, ...emptyCell } = state.cells[homeCell]!;
              void ignored;
              return emptyCell;
            })()
        },
        units
      };
    };

    for (const [label, state] of [
      ["empty", makeAttackState()],
      ["friendly", makeAttackState(id("p2-home"), p1)]
    ] as const) {
      const result = applyCommand(state, {
        type: "attack-unit", commandId: `${label}-stronghold-zone`, actorId: p1, expectedSequence: 0,
        unitId: id("p1-scout"), targetId: targetCell
      }, terrains, unitCatalog);
      expect(result.accepted).toBe(true);
      if (!result.accepted) continue;
      const arrivedUnitId = result.state.cells[targetCell]?.unitId;
      expect(arrivedUnitId).toBeDefined();
      expect(result.state.turn.exhaustedUnitIds).not.toContain(arrivedUnitId);
    }
  });

  it("only exposes neighbouring cells that a selected unit can really act on", () => {
    const state = fixture();
    const blockedId = toCellId({ column: 2, row: 0 });
    const stateWithMountain: GameState = {
      ...state,
      cells: { ...state.cells, [blockedId]: { ...state.cells[blockedId]!, terrainId: "mountain" } }
    };

    const legal = getLegalActionDestinationIds(stateWithMountain, id("p1-scout"), terrains, unitCatalog);

    expect(legal).toContain(toCellId({ column: 2, row: 1 }));
    expect(legal).not.toContain(blockedId);
    expect(legal).not.toContain(toCellId({ column: 1, row: 1 }));
  });

  it("only marks actionable units during the action phase", () => {
    const state = fixture();
    expect(getActionableUnitIds(state, terrains, unitCatalog)).toContain(id("p1-scout"));

    const reinforcementState: GameState = {
      ...state,
      turn: { ...state.turn, phase: "reinforcement" }
    };
    expect(getActionableUnitIds(reinforcementState, terrains, unitCatalog)).toEqual(new Set());
  });

  it("does not expose a powered one-point unit as actionable", () => {
    const state = fixture();
    const onePointScout: GameState = {
      ...state,
      units: { ...state.units, [id("p1-scout")]: { ...state.units[id("p1-scout")]!, strength: 1 } }
    };

    expect(getLegalActionDestinationIds(onePointScout, id("p1-scout"), terrains, unitCatalog)).toEqual([]);
    expect(getActionableUnitIds(onePointScout, terrains, unitCatalog)).not.toContain(id("p1-scout"));
  });

  it("decays an unpowered roamer after moving and exhausts its one-point final action", () => {
    const state = fixture();
    const originalCellId = toCellId({ column: 1, row: 1 });
    const sourceCellId = toCellId({ column: 2, row: 0 });
    const destinationCellId = toCellId({ column: 1, row: 0 });
    const { unitId: originalOccupant, ...clearedOriginalCell } = state.cells[originalCellId]!;
    void originalOccupant;
    const createRoamingState = (strength: number): GameState => ({
      ...state,
      cells: {
        ...state.cells,
        [originalCellId]: clearedOriginalCell,
        [sourceCellId]: { ...state.cells[sourceCellId]!, unitId: id("p1-scout") }
      },
      units: {
        ...state.units,
        [id("p1-scout")]: {
          ...state.units[id("p1-scout")]!,
          cellId: sourceCellId,
          strength
        }
      }
    });

    const threePointRoamer = createRoamingState(3);
    expect(getPoweredUnitIds(threePointRoamer, terrains)).not.toContain(id("p1-scout"));
    const decayed = applyCommand(threePointRoamer, {
      type: "move-unit", commandId: "roamer-decay", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), destinationId: destinationCellId
    }, terrains, unitCatalog);
    expect(decayed.accepted).toBe(true);
    if (!decayed.accepted) return;
    expect(decayed.state.units[id("p1-scout")]?.strength).toBe(2);
    expect(decayed.state.turn.exhaustedUnitIds).not.toContain(id("p1-scout"));

    const onePointRoamer = createRoamingState(1);
    const finalAction = applyCommand(onePointRoamer, {
      type: "move-unit", commandId: "roamer-final-action", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), destinationId: destinationCellId
    }, terrains, unitCatalog);
    expect(finalAction.accepted).toBe(true);
    if (!finalAction.accepted) return;
    expect(finalAction.state.units[id("p1-scout")]?.strength).toBe(1);
    expect(finalAction.state.turn.exhaustedUnitIds).toContain(id("p1-scout"));
    expect(finalAction.events.map((event) => event.type)).toContain("unit-exhausted");
  });

  it("keeps an exhausted one-point roamer behind when leaving an unpowered oil field", () => {
    const state = fixture();
    const originalCellId = toCellId({ column: 1, row: 1 });
    const oilFieldCellId = toCellId({ column: 2, row: 0 });
    const destinationCellId = toCellId({ column: 1, row: 0 });
    const { unitId: originalOccupant, ...clearedOriginalCell } = state.cells[originalCellId]!;
    void originalOccupant;
    const createOilFieldState = (strength: number): GameState => ({
      ...state,
      cells: {
        ...state.cells,
        [originalCellId]: clearedOriginalCell,
        [oilFieldCellId]: {
          ...state.cells[oilFieldCellId]!,
          terrainId: "oilfield",
          unitId: id("p1-scout")
        }
      },
      units: {
        ...state.units,
        [id("p1-scout")]: {
          ...state.units[id("p1-scout")]!,
          cellId: oilFieldCellId,
          strength
        }
      }
    });

    const stateWithThreePoints = createOilFieldState(3);
    expect(getPoweredUnitIds(stateWithThreePoints, terrains)).not.toContain(id("p1-scout"));
    const result = applyCommand(stateWithThreePoints, {
      type: "move-unit", commandId: "leave-oil-field", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), destinationId: destinationCellId
    }, terrains, unitCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    const garrisonId = result.state.cells[oilFieldCellId]?.unitId;
    expect(garrisonId).toBeDefined();
    expect(garrisonId).not.toBe(id("p1-scout"));
    if (!garrisonId) return;
    expect(result.state.units[id("p1-scout")]?.strength).toBe(2);
    expect(result.state.units[garrisonId]).toMatchObject({
      definitionId: "roamer",
      ownerId: p1,
      cellId: oilFieldCellId,
      strength: 1
    });
    expect(result.state.turn.exhaustedUnitIds).toContain(garrisonId);
    expect(getLegalActionDestinationIds(result.state, garrisonId, terrains, unitCatalog)).toEqual([]);

    const onePointState = createOilFieldState(1);
    expect(getLegalActionDestinationIds(onePointState, id("p1-scout"), terrains, unitCatalog)).toEqual([]);
    const rejected = applyCommand(onePointState, {
      type: "move-unit", commandId: "cannot-leave-oil-field", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), destinationId: destinationCellId
    }, terrains, unitCatalog);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted) expect(rejected.error.code).toBe("insufficient-strength");
  });

  it("exposes a UI-free legal action space for bots and simulations", () => {
    const state = fixture();
    const intents = getLegalIntents(state, terrains, unitCatalog);
    const move = intents.find((intent) => intent.type === "move-unit"
      && intent.unitId === id("p1-scout") && intent.destinationId === toCellId({ column: 2, row: 1 }));

    expect(move).toBeDefined();
    expect(intents).toContainEqual({ type: "end-action-phase" });
    if (!move || move.type !== "move-unit") return;
    expect(applyIntent(state, move, "bot-step-1", terrains, unitCatalog).accepted).toBe(true);
  });

  it("rejects friendly targets unless the map explicitly enables friendly fire", () => {
    const state = fixture();
    const result = applyCommand(state, {
      type: "attack-unit", commandId: "friendly-target", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), targetId: toCellId({ column: 0, row: 1 })
    }, terrains, unitCatalog);

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.error.code).toBe("friendly-target");
  });

  it("uses independent attack range and counterattack capability modules", () => {
    const state = fixture();
    const artilleryCatalog: UnitCatalog = {
      ...unitCatalog,
      artillery: {
        id: "artillery",
        displayName: "火炮",
        capabilities: [
          { id: "core/move", config: { maxDistance: 1 } },
          { id: "core/attack", config: { movesIntoTarget: false } },
          { id: "core/attack-range", config: { min: 2, max: 2 } }
        ]
      }
    };
    const artilleryId = id("p1-scout");
    const artilleryState: GameState = {
      ...state,
      units: { ...state.units, [artilleryId]: { ...state.units[artilleryId]!, definitionId: "artillery" } }
    };

    const legal = getLegalActionDestinationIds(artilleryState, artilleryId, terrains, artilleryCatalog);
    expect(legal).toContain(toCellId({ column: 3, row: 1 }));

    const result = applyCommand(artilleryState, {
      type: "attack-unit", commandId: "ranged-attack", actorId: p1, expectedSequence: 0,
      unitId: artilleryId, targetId: toCellId({ column: 3, row: 1 })
    }, terrains, artilleryCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.units[id("p2-home")]?.strength).toBe(1);
    expect(result.state.units[artilleryId]?.cellId).toBe(toCellId({ column: 1, row: 1 }));
    expect(result.state.units[artilleryId]?.strength).toBe(1);
    expect(result.state.turn.counterattacksUsed[id("p2-home")]).toBe(1);
    expect(result.events.map((event) => event.type)).toContain("unit-counterattacked");
  });

  it("splits a powered unit and exhausts it after entering an enemy stronghold zone", () => {
    const state = fixture();
    const result = applyCommand(state, {
      type: "move-unit", commandId: "move-1", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), destinationId: toCellId({ column: 2, row: 1 })
    }, terrains, unitCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const arriving = result.state.cells[toCellId({ column: 2, row: 1 })]?.unitId;
    expect(arriving).toBeDefined();
    expect(result.state.units[id("p1-scout")]?.strength).toBe(1);
    expect(result.state.turn.exhaustedUnitIds).toEqual([arriving]);
    expect(result.events.map((event) => event.type)).toContain("unit-exhausted");
    expect(result.outcome).toBeUndefined();
  });

  it("calculates current-player income at action-phase start, not when action ends", () => {
    const state = fixture();
    const started = startMatch(state, terrains, unitCatalog);
    expect(started.state.players[p1]?.reinforcementPoints).toBe(2);
    expect(started.events.map((event) => event.type)).toContain("points-granted");

    const result = applyCommand(started.state, {
      type: "end-action-phase", commandId: "end-action-1", actorId: p1, expectedSequence: started.state.sequence
    }, terrains, unitCatalog);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.turn.currentPlayerId).toBe(p1);
    expect(result.state.turn.phase).toBe("reinforcement");
    expect(result.state.players[p1]?.reinforcementPoints).toBe(2);
    expect(result.events.map((event) => event.type)).toContain("reinforcement-phase-started");

    const next = applyCommand(result.state, {
      type: "end-reinforcement-phase", commandId: "end-reinforcement-1", actorId: p1,
      expectedSequence: result.state.sequence
    }, terrains, unitCatalog);
    expect(next.accepted).toBe(true);
    if (!next.accepted) return;
    expect(next.state.turn.currentPlayerId).toBe(p2);
    expect(next.state.turn.phase).toBe("action");
    expect(next.state.players[p2]?.reinforcementPoints).toBe(1);
  });

  it("automatically enters reinforcement when the final actionable unit is exhausted", () => {
    const state = fixture();
    const homeCellId = toCellId({ column: 0, row: 1 });
    const { [id("p1-home")]: removedHome, ...remainingUnits } = state.units;
    void removedHome;
    const { unitId: removedOccupant, ...emptyHome } = state.cells[homeCellId]!;
    void removedOccupant;
    const singleUnitState: GameState = {
      ...state,
      units: remainingUnits,
      cells: { ...state.cells, [homeCellId]: emptyHome }
    };

    const result = applyCommand(singleUnitState, {
      type: "move-unit", commandId: "final-action", actorId: p1, expectedSequence: 0,
      unitId: id("p1-scout"), destinationId: toCellId({ column: 2, row: 1 })
    }, terrains, unitCatalog);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.turn.phase).toBe("reinforcement");
    expect(result.outcome).toBeUndefined();
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "unit-exhausted", "action-phase-ended", "reinforcement-phase-started"
    ]));
  });

  it("automatically advances to the next player after spending the final point", () => {
    const state = fixture();
    const reinforcementState: GameState = {
      ...state,
      turn: { ...state.turn, phase: "reinforcement" },
      players: { ...state.players, [p1]: { ...state.players[p1]!, reinforcementPoints: 1 } }
    };

    const result = applyCommand(reinforcementState, {
      type: "reinforce-unit", commandId: "last-point", actorId: p1, expectedSequence: 0,
      unitId: id("p1-home")
    }, terrains, unitCatalog);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.players[p1]?.reinforcementPoints).toBe(0);
    expect(result.state.turn.currentPlayerId).toBe(p2);
    expect(result.state.turn.phase).toBe("action");
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "unit-reinforced", "reinforcement-phase-ended", "turn-started"
    ]));
  });

  it("lets an external room clock finish a match through the headless core", () => {
    const state = fixture();
    const finished = finishMatch(state, "局时耗尽，本局结束。");

    expect(finished.sequence).toBe(state.sequence + 1);
    expect(finished.turn.phase).toBe("finished");
    expect(finished.result).toEqual({ winningTeamIds: [], message: "局时耗尽，本局结束。" });
    expect(finishMatch(finished, "不能覆盖")).toBe(finished);
  });
});
