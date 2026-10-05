import { describe, expect, it } from "vitest";
import {
  coreTerrainCatalog,
  coreUnitCatalog,
  createMatchFromMapCode,
  parseMapCode,
  serializeMapCode
} from "@numeral-lord/core-content";
import { TEST_MAP_CODE, TEST_MAP_DEFINITION } from "../../../packages/core-content/test-fixtures/maps.js";
import { applyCommand, canCounterattack } from "@numeral-lord/game-core";
import type { CellId, PlayerId, UnitId } from "@numeral-lord/game-core";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";
import { decayTerrainCatalog, decayTerrainMod } from "@numeral-lord/decay-terrain-mod";
import { hashModContent } from "@numeral-lord/game-sdk";

const installedMapCatalogs = {
  terrains: { ...coreTerrainCatalog, ...oilFieldTerrainCatalog, ...decayTerrainCatalog },
  terrainModIds: {
    [oilFieldMod.terrain.id]: oilFieldMod.id,
    [decayTerrainMod.terrain.id]: decayTerrainMod.id
  },
  mods: { [oilFieldMod.id]: oilFieldMod, [decayTerrainMod.id]: decayTerrainMod }
};

describe("shared map code", () => {
  it("does not treat the obsolete core/desert ID as either a built-in terrain or a Mod alias", () => {
    expect(coreTerrainCatalog).not.toHaveProperty("core/desert");
    const staleMap = {
      ...TEST_MAP_DEFINITION,
      terrainLegend: { ...TEST_MAP_DEFINITION.terrainLegend, M: "core/desert" }
    };
    expect(() => parseMapCode(JSON.stringify(staleMap), installedMapCatalogs)).toThrow(/未知的地形或 Mod/);
  });

  it("hashes equivalent JSON Mod content canonically", () => {
    expect(hashModContent({})).toBe("sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(hashModContent({ b: 2, a: 1 })).toBe(hashModContent({ a: 1, b: 2 }));
  });

  it("drains all of the current player's units on decay terrain, including roamers, at their turn start", () => {
    const map = {
      version: 1 as const,
      id: "decay-test",
      name: "衰蚀地测试",
      columns: 7,
      terrain: "SDPDDDS",
      terrainLegend: { S: "core/stronghold", D: "mod/decay-terrain", P: "core/plain" },
      requiredTerrainModIds: [decayTerrainMod.id],
      players: 2,
      // Player 1's unit at cell 3 is an unpowered roamer: the plain tile at
      // cell 2 breaks its connection to their stronghold at cell 0.
      soldiers: [[0, 1, 3], [1, 1, 3], [3, 1, 3], [5, 2, 3], [6, 2, 3]] as const,
      specialUnits: [[4, "blocker", 3]] as const,
      teams: [1, 2],
      matchConditionIds: []
    };
    const catalogs = {
      terrains: { ...coreTerrainCatalog, ...decayTerrainCatalog },
      terrainModIds: { "mod/decay-terrain": decayTerrainMod.id },
      mods: { [decayTerrainMod.id]: decayTerrainMod }
    };
    const initial = createMatchFromMapCode(serializeMapCode(map, catalogs), catalogs);
    expect(initial.units["seat-1-cell-1" as UnitId]?.strength).toBe(2);
    expect(initial.units["seat-1-cell-3" as UnitId]?.strength).toBe(2);
    expect(initial.units["seat-2-cell-5" as UnitId]?.strength).toBe(3);
    expect(initial.units["blocker-cell-4" as UnitId]?.strength).toBe(3);

    const actionEnd = applyCommand(initial, {
      type: "end-action-phase", commandId: "decay-action-end", actorId: "player-1" as PlayerId,
      expectedSequence: initial.sequence
    }, catalogs.terrains, coreUnitCatalog);
    expect(actionEnd.accepted).toBe(true);
    if (!actionEnd.accepted) return;
    const turnEnd = applyCommand(actionEnd.state, {
      type: "end-reinforcement-phase", commandId: "decay-reinforcement-end", actorId: "player-1" as PlayerId,
      expectedSequence: actionEnd.state.sequence
    }, catalogs.terrains, coreUnitCatalog);
    expect(turnEnd.accepted).toBe(true);
    if (!turnEnd.accepted) return;
    expect(turnEnd.state.units["seat-1-cell-1" as UnitId]?.strength).toBe(2);
    expect(turnEnd.state.units["seat-1-cell-3" as UnitId]?.strength).toBe(2);
    expect(turnEnd.state.units["seat-2-cell-5" as UnitId]?.strength).toBe(2);
    expect(turnEnd.state.units["blocker-cell-4" as UnitId]?.strength).toBe(3);
  });

  it("uses lobby-selected legacy colors when creating a headless match", () => {
    const state = createMatchFromMapCode(TEST_MAP_CODE, {
      ...installedMapCatalogs,
      playerColors: { "player-1": "#CC3563", "player-2": "#53AEBB" }
    });
    expect(state.players["player-1" as PlayerId]?.color).toBe("#CC3563");
    expect(state.players["player-2" as PlayerId]?.color).toBe("#53AEBB");
  });

  it("round trips editable map seat names and uses them as default player display names", () => {
    const definition = { ...TEST_MAP_DEFINITION, playerNames: ["赤方", "蓝方"] };
    const code = serializeMapCode(definition, installedMapCatalogs);
    expect(parseMapCode(code, installedMapCatalogs).playerNames).toEqual(["赤方", "蓝方"]);
    expect(createMatchFromMapCode(code, installedMapCatalogs).players["player-1" as PlayerId]?.displayName).toBe("赤方");
    expect(createMatchFromMapCode(code, {
      ...installedMapCatalogs,
      playerDisplayNames: { "player-1": "在线昵称" }
    }).players["player-1" as PlayerId]?.displayName).toBe("在线昵称");
    expect(createMatchFromMapCode(TEST_MAP_CODE, installedMapCatalogs).players["player-1" as PlayerId]?.displayName).toBe("玩家 1");
  });

  it("round trips custom player colors and rejects incomplete or malformed palettes", () => {
    const definition = { ...TEST_MAP_DEFINITION, playerColors: ["#12ab34", "#aabbcc"] };
    const code = serializeMapCode(definition, installedMapCatalogs);
    expect(parseMapCode(code, installedMapCatalogs).playerColors).toEqual(["#12AB34", "#AABBCC"]);
    const match = createMatchFromMapCode(code, installedMapCatalogs);
    expect(match.players["player-1" as PlayerId]?.color).toBe("#12AB34");
    expect(match.players["player-2" as PlayerId]?.color).toBe("#AABBCC");
    expect(() => serializeMapCode({ ...TEST_MAP_DEFINITION, playerColors: ["#123456"] }, installedMapCatalogs)).toThrow(/六位十六进制颜色/);
    expect(() => serializeMapCode({ ...TEST_MAP_DEFINITION, playerColors: ["red", "#AABBCC"] }, installedMapCatalogs)).toThrow(/六位十六进制颜色/);
  });

  it("round trips an editor-replaced void tile as its new terrain", () => {
    const original = {
      version: 1 as const,
      id: "painted-void-test",
      name: "虚无重绘测试",
      columns: 2,
      terrain: "VP",
      terrainLegend: { V: "core/void", P: "core/plain" },
      requiredTerrainModIds: [],
      players: 2,
      soldiers: [],
      teams: [1, 2],
      matchConditionIds: []
    };
    const replaced = { ...original, terrain: "PP" };
    const code = serializeMapCode(replaced, installedMapCatalogs);
    expect(parseMapCode(code, installedMapCatalogs).terrainLegend).toEqual({ P: "core/plain" });
    expect(parseMapCode(code, installedMapCatalogs).terrain).toBe("PP");
  });

  it("rejects missing, empty, or overlong map seat names", () => {
    expect(() => serializeMapCode({ ...TEST_MAP_DEFINITION, playerNames: ["赤方"] }, installedMapCatalogs)).toThrow(/每个玩家位填写/);
    expect(() => serializeMapCode({ ...TEST_MAP_DEFINITION, playerNames: ["", "蓝方"] }, installedMapCatalogs)).toThrow(/每个玩家位填写/);
    expect(() => serializeMapCode({ ...TEST_MAP_DEFINITION, playerNames: ["甲".repeat(25), "蓝方"] }, installedMapCatalogs)).toThrow(/每个玩家位填写/);
  });

  it("round trips a versioned map with an explicit Mod legend and dependency", () => {
    const map = parseMapCode(TEST_MAP_CODE, installedMapCatalogs);
    expect(map.name).toBe("Mod依赖测试地图");
    expect(map.players).toBe(2);
    expect(map.terrain).toBe(TEST_MAP_DEFINITION.terrain);
    expect(map.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    const idOnlyCode = serializeMapCode(map, installedMapCatalogs);
    expect(idOnlyCode).not.toContain("requiredTerrainModLocks");
    expect(serializeMapCode(parseMapCode(idOnlyCode, installedMapCatalogs), installedMapCatalogs)).toBe(idOnlyCode);

    const state = createMatchFromMapCode(TEST_MAP_CODE, installedMapCatalogs);
    expect(Object.keys(state.cells)).toHaveLength(TEST_MAP_DEFINITION.terrain.length);
    expect(Object.keys(state.units)).toHaveLength(TEST_MAP_DEFINITION.soldiers.length);
    expect(state.players["player-1" as keyof typeof state.players]?.seat).toBe(1);
    expect(state.settings.modRuleSet?.patterns.some((pattern) => pattern.id === "core-terrain/hostile-stronghold-zone")).toBe(true);
    expect(state.settings.modRuleSet?.rules.some((rule) => rule.id === "core-terrain/hostile-stronghold-exhaustion")).toBe(true);
  });

  it("loads old maps with the currently installed Mod even when they contain a legacy version lock", () => {
    const code = JSON.stringify({
      ...TEST_MAP_DEFINITION,
      requiredTerrainModLocks: [{ id: oilFieldMod.id, version: "0.0.1", contentHash: `sha256:${"0".repeat(64)}` }]
    });
    const changedMod = {
      ...oilFieldMod,
      version: "0.2.0",
      terrain: { ...oilFieldMod.terrain, displayName: `${oilFieldMod.terrain.displayName}!` }
    };
    const changedCatalogs = {
      ...installedMapCatalogs,
      mods: { ...installedMapCatalogs.mods, [oilFieldMod.id]: changedMod }
    };
    expect(parseMapCode(code, changedCatalogs)).not.toHaveProperty("requiredTerrainModLocks");
    expect(serializeMapCode(parseMapCode(code, changedCatalogs), changedCatalogs)).not.toContain("requiredTerrainModLocks");
    expect(() => createMatchFromMapCode(code, changedCatalogs)).not.toThrow();
  });

  it("keeps map codes independent from Mod version and visual asset fingerprints", () => {
    const modWithArt = {
      ...oilFieldMod,
      visualAssets: [{ id: "ground", dataUrl: "data:image/webp;base64,AAAB" }],
      terrain: { ...oilFieldMod.terrain, visuals: { baseColor: "#334455", baseAssetId: "ground" } }
    };
    const catalogs = {
      ...installedMapCatalogs,
      terrains: { ...installedMapCatalogs.terrains, [modWithArt.terrain.id]: modWithArt.terrain },
      mods: { ...installedMapCatalogs.mods, [oilFieldMod.id]: modWithArt }
    };
    const code = serializeMapCode(TEST_MAP_DEFINITION, catalogs);
    expect(code).not.toContain("requiredTerrainModLocks");
    expect(parseMapCode(code, catalogs).requiredTerrainModIds).toContain(modWithArt.id);

    const changedArtMod = { ...modWithArt, visualAssets: [{ id: "ground", dataUrl: "data:image/webp;base64,AAAC" }] };
    expect(() => createMatchFromMapCode(code, {
      ...catalogs,
      mods: { ...catalogs.mods, [oilFieldMod.id]: changedArtMod }
    })).not.toThrow();
  });

  it("always serializes only Mod IDs, following whichever release the caller provides", () => {
    const saved = parseMapCode(serializeMapCode(TEST_MAP_DEFINITION, installedMapCatalogs), installedMapCatalogs);
    const revisedMod = { ...oilFieldMod, version: "0.2.0" };
    const revisedCatalogs = { ...installedMapCatalogs, mods: { [oilFieldMod.id]: revisedMod } };
    const revisedCode = serializeMapCode(saved, revisedCatalogs);
    expect(JSON.parse(revisedCode)).not.toHaveProperty("requiredTerrainModLocks");
    expect(parseMapCode(revisedCode, revisedCatalogs).requiredTerrainModIds).toEqual([oilFieldMod.id]);
  });

  it("compiles arbitrary map-authored point-to-point links into destination lookup lists", () => {
    const map = {
      ...TEST_MAP_DEFINITION,
      cellLinks: [{ trigger: "enter", source: 0, target: 1, relationId: "mod/bridge/paired-gate" }] as const
    };
    const code = serializeMapCode(map, installedMapCatalogs);
    const parsed = parseMapCode(code, installedMapCatalogs);
    expect(parsed.cellLinks).toEqual(map.cellLinks);
    const state = createMatchFromMapCode(code, installedMapCatalogs);
    expect(state.cellTriggers?.["1,0" as CellId]?.enter).toContainEqual({
      relatedCellId: "0,0" as CellId,
      relationId: "mod/bridge/paired-gate"
    });
    const exitCode = serializeMapCode({
      ...TEST_MAP_DEFINITION,
      cellLinks: [{ trigger: "leave", source: 0, target: 1, relationId: "mod/bridge/exit-gate" }] as const
    }, installedMapCatalogs);
    expect(createMatchFromMapCode(exitCode, installedMapCatalogs).cellTriggers?.["0,0" as CellId]?.leave).toContainEqual({
      relatedCellId: "1,0" as CellId,
      relationId: "mod/bridge/exit-gate"
    });
  });

  it("rejects cell links that point outside the map or omit a relation id", () => {
    expect(() => serializeMapCode({
      ...TEST_MAP_DEFINITION,
      cellLinks: [{ trigger: "enter", source: 0, target: TEST_MAP_DEFINITION.terrain.length, relationId: "mod/bridge/gate" }]
    }, installedMapCatalogs)).toThrow(/源格、目标格和关系 ID/);
    expect(() => serializeMapCode({
      ...TEST_MAP_DEFINITION,
      cellLinks: [{ trigger: "leave", source: 0, target: 1, relationId: "" }]
    }, installedMapCatalogs)).toThrow(/源格、目标格和关系 ID/);
  });

  it("starts unoccupied map seats dead; map condition modules decide settlement", () => {
    const map = { ...TEST_MAP_DEFINITION, matchConditionIds: ["core/lose-all-survival-anchors"] };
    const activePlayerIds = ["player-1" as keyof ReturnType<typeof createMatchFromMapCode>["players"]];
    const state = createMatchFromMapCode(serializeMapCode(map, installedMapCatalogs), {
      ...installedMapCatalogs,
      activePlayerIds
    });
    expect(Object.keys(state.units)).toHaveLength(3);
    expect(Object.values(state.units).every((unit) => unit.ownerId === "player-1")).toBe(true);
    expect(state.turn.phase).not.toBe("finished");

    const lastTeamMap = createMatchFromMapCode(TEST_MAP_CODE, { ...installedMapCatalogs, activePlayerIds });
    expect(lastTeamMap.turn.phase).toBe("finished");
  });

  it("rejects unknown mods, invalid seats, overlapping pieces and blocked cells", () => {
    expect(() => serializeMapCode({
      ...TEST_MAP_DEFINITION,
      terrainLegend: { ...TEST_MAP_DEFINITION.terrainLegend, X: "missing/oil" }
    }, installedMapCatalogs)).toThrow(/未知的地形或 Mod/);
    expect(() => serializeMapCode({
      ...TEST_MAP_DEFINITION,
      soldiers: [[10, 3, 1]]
    }, installedMapCatalogs)).toThrow(/兵力玩家位/);
    expect(() => serializeMapCode({
      ...TEST_MAP_DEFINITION,
      soldiers: [[10, 1, 1], [10, 2, 1]]
    }, installedMapCatalogs)).toThrow(/两个单位/);
    expect(() => serializeMapCode({
      ...TEST_MAP_DEFINITION,
      soldiers: [[7, 1, 1]]
    }, installedMapCatalogs)).toThrow(/不可驻兵/);
    expect(() => parseMapCode(TEST_MAP_CODE, { terrains: coreTerrainCatalog })).toThrow(/未知的地形或 Mod/);
  });

  it("loads neutral blockers without reactions and wild units with terrain-bound reactions", () => {
    const map = {
      ...TEST_MAP_DEFINITION,
      terrain: "M".repeat(81),
      terrainLegend: { M: "core/plain" },
      requiredTerrainModIds: [],
      soldiers: [[0, 1, 3], [80, 2, 2]] as const,
      specialUnits: [[1, "blocker", 4], [9, "wild", 2]] as const,
      matchConditionIds: []
    };
    const code = serializeMapCode(map, { terrains: coreTerrainCatalog });
    const parsed = parseMapCode(code, { terrains: coreTerrainCatalog });
    expect(parsed.specialUnits).toEqual(map.specialUnits);
    const state = createMatchFromMapCode(code, { terrains: coreTerrainCatalog });
    expect(state.units["blocker-cell-1" as UnitId]).toMatchObject({ definitionId: "core/blocker", strength: 4 });
    expect(state.units["wild-cell-9" as UnitId]).toMatchObject({ definitionId: "core/wild", strength: 2 });
    expect(canCounterattack(state, "blocker-cell-1" as UnitId, coreTerrainCatalog, coreUnitCatalog)).toBe(false);
    expect(canCounterattack(state, "wild-cell-9" as UnitId, coreTerrainCatalog, coreUnitCatalog)).toBe(true);
    const attack = applyCommand(state, {
      type: "attack-unit", commandId: "attack-neutral-blocker", actorId: "player-1" as PlayerId,
      expectedSequence: state.sequence, unitId: "seat-1-cell-0" as UnitId, targetId: "1,0" as CellId
    }, coreTerrainCatalog, coreUnitCatalog);
    expect(attack.accepted).toBe(true);
    if (attack.accepted) {
      expect(attack.state.units["seat-1-cell-0" as UnitId]?.cellId).toBe("0,0");
      expect(attack.state.units["blocker-cell-1" as UnitId]?.strength).toBe(1);
      expect(attack.events.some((event) => event.type === "unit-exhausted")).toBe(true);
      expect(attack.events.some((event) => event.type === "unit-counterattacked")).toBe(false);
    }
    expect(serializeMapCode(parsed, { terrains: coreTerrainCatalog })).toBe(code);
  });

  it("rejects neutral units on blocked terrain and overlapping player units", () => {
    expect(() => serializeMapCode({ ...TEST_MAP_DEFINITION, specialUnits: [[7, "wild", 1]] }, installedMapCatalogs)).toThrow(/不可驻兵/);
    expect(() => serializeMapCode({ ...TEST_MAP_DEFINITION, soldiers: [[10, 1, 1]], specialUnits: [[10, "blocker", 1]] }, installedMapCatalogs)).toThrow(/两个单位/);
  });

  it("rejects unversioned map data instead of guessing terrain glyphs or Mod IDs", () => {
    const oldMap = {
      id: 1001,
      columns: TEST_MAP_DEFINITION.columns,
      terrain: TEST_MAP_DEFINITION.terrain,
      soldiers: TEST_MAP_DEFINITION.soldiers.map(([index, seat, strength]) => [index, seat - 1, strength])
    };
    expect(() => parseMapCode(JSON.stringify(oldMap), installedMapCatalogs)).toThrow(/不支持的地图码版本/);
  });

  it("supports extra declared seats and maps that do not install the oil-field Mod", () => {
    const plainOnly = {
      ...TEST_MAP_DEFINITION,
      players: 3,
      teams: [1, 1, 2],
      terrain: TEST_MAP_DEFINITION.terrain.replaceAll("X", "M"),
      requiredTerrainModIds: []
    };
    const code = serializeMapCode(plainOnly, { terrains: coreTerrainCatalog });
    const map = parseMapCode(code, { terrains: coreTerrainCatalog });
    expect(map.players).toBe(3);
    expect(map.terrainLegend.X).toBeUndefined();
    const state = createMatchFromMapCode(code, { terrains: coreTerrainCatalog });
    expect(state.players["player-2" as keyof typeof state.players]?.teamId).toBe(
      state.players["player-1" as keyof typeof state.players]?.teamId
    );
    expect(state.players["player-3" as keyof typeof state.players]?.seat).toBe(3);
  });

  it("uses room participant names in headless match state", () => {
    const state = createMatchFromMapCode(TEST_MAP_CODE, {
      ...installedMapCatalogs,
      playerDisplayNames: { "player-1": "阿蓝", "player-2": "阿红" }
    });
    expect(state.players["player-1" as keyof typeof state.players]?.displayName).toBe("阿蓝");
    expect(state.players["player-2" as keyof typeof state.players]?.displayName).toBe("阿红");
  });
});
