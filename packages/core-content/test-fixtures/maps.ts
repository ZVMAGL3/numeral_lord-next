import type { MapDefinition } from "../src/map-code.js";

export const TEST_MAP_DEFINITION: MapDefinition = {
  version: 1,
  id: "test-map-explicit-mod",
  name: "Mod依赖测试地图",
  columns: 9,
  terrain: "MMMMMMMPVPSMOOMOMPMOOMMOXMVPMOSMPOMPPMMPPMMPVPMOPMSOMPMXOMMOOMVPMOMOOMSPPMMMMMMMV",
  terrainLegend: {
    M: "core/plain",
    P: "core/mountain",
    S: "core/stronghold",
    O: "core/ocean",
    X: "mod/oil-field",
    V: "core/void"
  },
  requiredTerrainModIds: ["mod-oil-field"],
  players: 2,
  soldiers: [
    [10, 1, 2],
    [11, 1, 1],
    [30, 2, 1],
    [50, 1, 1],
    [69, 2, 1],
    [70, 2, 2],
    [79, 2, 1]
  ],
  teams: [1, 2],
  matchConditionIds: ["core/lose-all-survival-anchors", "core/last-team-standing"]
};

export const TEST_MAP_CODE = JSON.stringify(TEST_MAP_DEFINITION);
