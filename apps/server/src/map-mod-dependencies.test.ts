import { describe, expect, it } from "vitest";
import {
  coreTerrainCatalog,
  createMatchFromMapCode,
  parseMapCode,
  serializeMapCode
} from "@numeral-lord/core-content";
import { TEST_MAP_CODE, TEST_MAP_DEFINITION } from "../../../packages/core-content/test-fixtures/maps.js";

describe("map terrain Mod dependencies", () => {
  it("lists the optional terrain Mod without installing it in core-content", () => {
    expect(TEST_MAP_DEFINITION.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    expect(() => parseMapCode(TEST_MAP_CODE)).toThrow(/未知的地形或 Mod/);
    const saved = parseMapCode(TEST_MAP_CODE, { allowUnknownTerrainMods: true });
    expect(saved.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    expect(serializeMapCode(saved, { allowUnknownTerrainMods: true })).toBe(TEST_MAP_CODE);
    expect(() => createMatchFromMapCode(TEST_MAP_CODE, { allowUnknownTerrainMods: true }))
      .toThrow(/未知的地形或 Mod/);
  });

  it("upgrades map codes written before dependencies were explicit", () => {
    const oldCode = JSON.stringify({ ...TEST_MAP_DEFINITION, requiredTerrainModIds: undefined });
    const upgraded = parseMapCode(oldCode, { allowUnknownTerrainMods: true });
    expect(upgraded.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    expect(serializeMapCode(upgraded, { allowUnknownTerrainMods: true })).toBe(TEST_MAP_CODE);
  });

  it("requires every used terrain Mod but permits selected Mods that are not used yet", () => {
    expect(() => parseMapCode(JSON.stringify({ ...TEST_MAP_DEFINITION, requiredTerrainModIds: [] }), {
      allowUnknownTerrainMods: true
    })).toThrow(/依赖缺少地图实际使用的地形/);

    const selectedButUnused = {
      ...TEST_MAP_DEFINITION,
      requiredTerrainModIds: ["mod-oil-field", "mod-unused"]
    };
    const code = serializeMapCode(selectedButUnused, { allowUnknownTerrainMods: true });
    expect(parseMapCode(code, { allowUnknownTerrainMods: true }).requiredTerrainModIds)
      .toEqual(["mod-oil-field", "mod-unused"]);
  });

  it("does not require oil-field when the map uses only core terrain", () => {
    const plainOnly = {
      ...TEST_MAP_DEFINITION,
      terrain: TEST_MAP_DEFINITION.terrain.replaceAll("F", "M"),
      requiredTerrainModIds: []
    };
    const code = serializeMapCode(plainOnly, { terrains: coreTerrainCatalog });
    expect(parseMapCode(code).requiredTerrainModIds).toEqual([]);
  });
});
