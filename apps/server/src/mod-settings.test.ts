import { describe, expect, it } from "vitest";
import { coreTerrainCatalog, createMatchFromMapCode, parseMapCode, serializeMapCode } from "@numeral-lord/core-content";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";

const catalogs = {
  terrains: { ...coreTerrainCatalog, ...oilFieldTerrainCatalog },
  terrainModIds: { "mod/oil-field": oilFieldMod.id },
  mods: { [oilFieldMod.id]: oilFieldMod }
};

function oilMap(modSettings?: Record<string, Record<string, number>>): string {
  return JSON.stringify({
    version: 1,
    id: "oil-settings-test",
    name: "油田设置测试",
    columns: 2,
    terrain: "FF",
    terrainLegend: { F: "mod/oil-field" },
    requiredTerrainModIds: ["mod-oil-field"],
    ...(modSettings ? { modSettings } : {}),
    players: 2,
    soldiers: [[0, 1, 1], [1, 2, 1]],
    teams: [1, 2],
    matchConditionIds: []
  });
}

describe("map-author and host Mod settings", () => {
  it("uses the Mod default for old codes, map value for new codes, and room override last", () => {
    const oldMatch = createMatchFromMapCode(oilMap(), catalogs);
    expect(oldMatch.players["player-1" as keyof typeof oldMatch.players]?.reinforcementPoints).toBe(2);

    const code = oilMap({ "mod-oil-field": { incomePerTurn: 5 } });
    const mapMatch = createMatchFromMapCode(code, catalogs);
    expect(mapMatch.players["player-1" as keyof typeof mapMatch.players]?.reinforcementPoints).toBe(5);
    expect(mapMatch.settings.modSettings?.["mod-oil-field"]?.incomePerTurn).toBe(5);

    const roomMatch = createMatchFromMapCode(code, {
      ...catalogs,
      roomModSettings: { "mod-oil-field": { incomePerTurn: 7 } }
    });
    expect(roomMatch.players["player-1" as keyof typeof roomMatch.players]?.reinforcementPoints).toBe(7);
    expect(roomMatch.settings.terrainCapabilityOverrides?.["mod/oil-field"]?.["core/income-source"]?.amount).toBe(7);
  });

  it("keeps map settings in its portable code and rejects invalid values", () => {
    const code = oilMap({ "mod-oil-field": { incomePerTurn: 4 } });
    expect(parseMapCode(serializeMapCode(parseMapCode(code, catalogs), catalogs), catalogs).modSettings)
      .toEqual({ "mod-oil-field": { incomePerTurn: 4 } });
    expect(() => parseMapCode(oilMap({ "mod-oil-field": { incomePerTurn: 21 } }), catalogs))
      .toThrow(/0～20/);
    expect(() => parseMapCode(oilMap({ "mod-oil-field": { surprise: 1 } }), catalogs))
      .toThrow(/没有参数/);
    expect(() => createMatchFromMapCode(code, {
      ...catalogs,
      roomModSettings: { "mod-oil-field": { incomePerTurn: -1 } }
    })).toThrow(/0～20/);
  });
});
