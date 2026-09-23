import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAP_CODE,
  DEFAULT_MAP_DEFINITION,
  coreTerrainCatalog,
  createMatchFromMapCode,
  parseMapCode,
  serializeMapCode
} from "@numeral-lord/core-content";

describe("map terrain Mod dependencies", () => {
  it("lists the optional terrain Mod without installing it in core-content", () => {
    expect(DEFAULT_MAP_DEFINITION.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    expect(() => parseMapCode(DEFAULT_MAP_CODE)).toThrow(/未知的地形或 Mod/);
    const saved = parseMapCode(DEFAULT_MAP_CODE, { allowUnknownTerrainMods: true });
    expect(saved.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    expect(serializeMapCode(saved, { allowUnknownTerrainMods: true })).toBe(DEFAULT_MAP_CODE);
    expect(() => createMatchFromMapCode(DEFAULT_MAP_CODE, { allowUnknownTerrainMods: true }))
      .toThrow(/未知的地形或 Mod/);
  });

  it("upgrades map codes written before dependencies were explicit", () => {
    const oldCode = JSON.stringify({ ...DEFAULT_MAP_DEFINITION, requiredTerrainModIds: undefined });
    const upgraded = parseMapCode(oldCode, { allowUnknownTerrainMods: true });
    expect(upgraded.requiredTerrainModIds).toEqual(["mod-oil-field"]);
    expect(serializeMapCode(upgraded, { allowUnknownTerrainMods: true })).toBe(DEFAULT_MAP_CODE);
  });

  it("rejects missing or unrelated declarations", () => {
    expect(() => parseMapCode(JSON.stringify({ ...DEFAULT_MAP_DEFINITION, requiredTerrainModIds: [] }), {
      allowUnknownTerrainMods: true
    })).toThrow(/依赖与地图实际使用的地形不一致/);
    expect(() => parseMapCode(JSON.stringify({
      ...DEFAULT_MAP_DEFINITION,
      requiredTerrainModIds: ["mod-oil-field", "mod-unused"]
    }), { allowUnknownTerrainMods: true })).toThrow(/依赖与地图实际使用的地形不一致/);
  });

  it("does not require oil-field when the map uses only core terrain", () => {
    const plainOnly = {
      ...DEFAULT_MAP_DEFINITION,
      terrain: DEFAULT_MAP_DEFINITION.terrain.replaceAll("F", "M"),
      requiredTerrainModIds: []
    };
    const code = serializeMapCode(plainOnly, { terrains: coreTerrainCatalog });
    expect(parseMapCode(code).requiredTerrainModIds).toEqual([]);
  });
});
