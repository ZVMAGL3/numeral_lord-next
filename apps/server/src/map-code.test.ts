import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAP_CODE,
  DEFAULT_MAP_DEFINITION,
  coreTerrainCatalog,
  createMatchFromMapCode,
  legacyDemoMap,
  parseMapCode,
  serializeMapCode
} from "@numeral-lord/core-content";
import type { CellId } from "@numeral-lord/game-core";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";

const installedMapCatalogs = {
  terrains: { ...coreTerrainCatalog, ...oilFieldTerrainCatalog },
  terrainModIds: Object.fromEntries(oilFieldMod.terrains.map((terrain) => [terrain.id, oilFieldMod.id]))
};

describe("shared map code", () => {
  it("round trips 昏晓 and keeps every legacy cell and soldier", () => {
    const map = parseMapCode(DEFAULT_MAP_CODE, installedMapCatalogs);
    expect(map.name).toBe("昏晓");
    expect(map.players).toBe(2);
    expect(map.terrain).toBe(legacyDemoMap.terrain);
    expect(map.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    expect(serializeMapCode(map, installedMapCatalogs)).toBe(DEFAULT_MAP_CODE);

    const state = createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs);
    expect(Object.keys(state.cells)).toHaveLength(legacyDemoMap.terrain.length);
    expect(Object.keys(state.units)).toHaveLength(legacyDemoMap.soldiers.length);
    expect(state.players["player-1" as keyof typeof state.players]?.seat).toBe(1);
    expect(Object.values(state.cellTriggers ?? {}).some((triggers) => triggers.enter.some(
      (link) => link.relationId === "core/adjacent-hostile-exhaustion"
    ))).toBe(true);
  });

  it("compiles arbitrary map-authored point-to-point links into destination lookup lists", () => {
    const map = {
      ...DEFAULT_MAP_DEFINITION,
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
      ...DEFAULT_MAP_DEFINITION,
      cellLinks: [{ trigger: "leave", source: 0, target: 1, relationId: "mod/bridge/exit-gate" }] as const
    }, installedMapCatalogs);
    expect(createMatchFromMapCode(exitCode, installedMapCatalogs).cellTriggers?.["0,0" as CellId]?.leave).toContainEqual({
      relatedCellId: "1,0" as CellId,
      relationId: "mod/bridge/exit-gate"
    });
  });

  it("rejects cell links that point outside the map or omit a relation id", () => {
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      cellLinks: [{ trigger: "enter", source: 0, target: DEFAULT_MAP_DEFINITION.terrain.length, relationId: "mod/bridge/gate" }]
    }, installedMapCatalogs)).toThrow(/源格、目标格和关系 ID/);
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      cellLinks: [{ trigger: "leave", source: 0, target: 1, relationId: "" }]
    }, installedMapCatalogs)).toThrow(/源格、目标格和关系 ID/);
  });

  it("starts unoccupied map seats dead; map condition modules decide settlement", () => {
    const map = { ...DEFAULT_MAP_DEFINITION, matchConditionIds: ["core/lose-all-survival-anchors"] };
    const activePlayerIds = ["player-1" as keyof ReturnType<typeof createMatchFromMapCode>["players"]];
    const state = createMatchFromMapCode(serializeMapCode(map, installedMapCatalogs), {
      ...installedMapCatalogs,
      activePlayerIds
    });
    expect(Object.keys(state.units)).toHaveLength(3);
    expect(Object.values(state.units).every((unit) => unit.ownerId === "player-1")).toBe(true);
    expect(state.turn.phase).not.toBe("finished");

    const lastTeamMap = createMatchFromMapCode(DEFAULT_MAP_CODE, { ...installedMapCatalogs, activePlayerIds });
    expect(lastTeamMap.turn.phase).toBe("finished");
  });

  it("rejects unknown mods, invalid seats, overlapping pieces and blocked cells", () => {
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      terrainLegend: { ...DEFAULT_MAP_DEFINITION.terrainLegend, F: "missing/oil" }
    }, installedMapCatalogs)).toThrow(/未知的地形或 Mod/);
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      soldiers: [[10, 3, 1]]
    }, installedMapCatalogs)).toThrow(/兵力玩家位/);
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      soldiers: [[10, 1, 1], [10, 2, 1]]
    }, installedMapCatalogs)).toThrow(/两个单位/);
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      soldiers: [[7, 1, 1]]
    }, installedMapCatalogs)).toThrow(/不可驻兵/);
    expect(() => parseMapCode(DEFAULT_MAP_CODE, { terrains: coreTerrainCatalog })).toThrow(/未知的地形或 Mod/);
  });

  it("upgrades the old row-major map object", () => {
    const map = parseMapCode(JSON.stringify(legacyDemoMap), installedMapCatalogs);
    expect(map.players).toBe(2);
    expect(map.soldiers[0]).toEqual([10, 1, 2]);
    expect(createMatchFromMapCode(serializeMapCode(map, installedMapCatalogs), installedMapCatalogs).board.columns).toBe(9);
  });

  it("supports extra declared seats and maps that do not install the oil-field Mod", () => {
    const plainOnly = {
      ...DEFAULT_MAP_DEFINITION,
      players: 3,
      teams: [1, 1, 2],
      terrain: DEFAULT_MAP_DEFINITION.terrain.replaceAll("F", "M"),
      requiredTerrainModIds: []
    };
    const code = serializeMapCode(plainOnly, { terrains: coreTerrainCatalog });
    const map = parseMapCode(code, { terrains: coreTerrainCatalog });
    expect(map.players).toBe(3);
    expect(map.terrainLegend.F).toBeUndefined();
    const state = createMatchFromMapCode(code, { terrains: coreTerrainCatalog });
    expect(state.players["player-2" as keyof typeof state.players]?.teamId).toBe(
      state.players["player-1" as keyof typeof state.players]?.teamId
    );
    expect(state.players["player-3" as keyof typeof state.players]?.seat).toBe(3);
  });

  it("uses room participant names in headless match state", () => {
    const state = createMatchFromMapCode(DEFAULT_MAP_CODE, {
      ...installedMapCatalogs,
      playerDisplayNames: { "player-1": "阿蓝", "player-2": "阿红" }
    });
    expect(state.players["player-1" as keyof typeof state.players]?.displayName).toBe("阿蓝");
    expect(state.players["player-2" as keyof typeof state.players]?.displayName).toBe("阿红");
  });
});
