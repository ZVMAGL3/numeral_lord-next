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

describe("shared map code", () => {
  it("round trips 昏晓 and keeps every legacy cell and soldier", () => {
    const map = parseMapCode(DEFAULT_MAP_CODE);
    expect(map.name).toBe("昏晓");
    expect(map.players).toBe(2);
    expect(map.terrain).toBe(legacyDemoMap.terrain);
    expect(serializeMapCode(map)).toBe(DEFAULT_MAP_CODE);

    const state = createMatchFromMapCode(DEFAULT_MAP_CODE);
    expect(Object.keys(state.cells)).toHaveLength(legacyDemoMap.terrain.length);
    expect(Object.keys(state.units)).toHaveLength(legacyDemoMap.soldiers.length);
    expect(state.players["player-1" as keyof typeof state.players]?.seat).toBe(1);
  });

  it("starts unoccupied map seats dead; map condition modules decide settlement", () => {
    const map = { ...DEFAULT_MAP_DEFINITION, matchConditionIds: ["core/lose-all-survival-anchors"] };
    const activePlayerIds = ["player-1" as keyof ReturnType<typeof createMatchFromMapCode>["players"]];
    const state = createMatchFromMapCode(serializeMapCode(map), { activePlayerIds });
    expect(Object.keys(state.units)).toHaveLength(3);
    expect(Object.values(state.units).every((unit) => unit.ownerId === "player-1")).toBe(true);
    expect(state.turn.phase).not.toBe("finished");

    const lastTeamMap = createMatchFromMapCode(DEFAULT_MAP_CODE, { activePlayerIds });
    expect(lastTeamMap.turn.phase).toBe("finished");
  });

  it("rejects unknown mods, invalid seats, overlapping pieces and blocked cells", () => {
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      terrainLegend: { ...DEFAULT_MAP_DEFINITION.terrainLegend, F: "missing/oil" }
    })).toThrow(/未知的地形或 Mod/);
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      soldiers: [[10, 3, 1]]
    })).toThrow(/兵力玩家位/);
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      soldiers: [[10, 1, 1], [10, 2, 1]]
    })).toThrow(/两个单位/);
    expect(() => serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      soldiers: [[7, 1, 1]]
    })).toThrow(/不可驻兵/);
    expect(() => parseMapCode(DEFAULT_MAP_CODE, { terrains: coreTerrainCatalog })).toThrow(/未知的地形或 Mod/);
  });

  it("upgrades the old row-major map object", () => {
    const map = parseMapCode(JSON.stringify(legacyDemoMap));
    expect(map.players).toBe(2);
    expect(map.soldiers[0]).toEqual([10, 1, 2]);
    expect(createMatchFromMapCode(serializeMapCode(map)).board.columns).toBe(9);
  });

  it("supports extra declared seats and maps that do not install the oil-field Mod", () => {
    const plainOnly = {
      ...DEFAULT_MAP_DEFINITION,
      players: 3,
      teams: [1, 1, 2],
      terrain: DEFAULT_MAP_DEFINITION.terrain.replaceAll("F", "M")
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
});
