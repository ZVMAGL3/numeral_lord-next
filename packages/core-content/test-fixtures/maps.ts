import type { MapDefinition } from "../src/map-code.js";

/**
 * Historical map fixture used to test map-code migration and Mod dependency
 * handling. It is deliberately outside core-content's runtime exports.
 */
export const legacyDemoMap = {
  id: 1001,
  author: "maker",
  columns: 9,
  terrain: "MMMMMMMPVPSMOOMOMPMOOMMOFMVPMOSMPOMPPMMPPMMPVPMOPMSOMPMFOMMOOMVPMOMOOMSPPMMMMMMMV",
  soldiers: [
    [10, 0, 2],
    [11, 0, 1],
    [30, 1, 1],
    [50, 0, 1],
    [69, 1, 1],
    [70, 1, 2],
    [79, 1, 1]
  ] as const
} as const;

export const TEST_MAP_DEFINITION: MapDefinition = {
  version: 1,
  id: String(legacyDemoMap.id),
  name: "昏晓",
  columns: legacyDemoMap.columns,
  terrain: legacyDemoMap.terrain,
  terrainLegend: {
    M: "core/plain",
    P: "core/mountain",
    S: "core/stronghold",
    O: "core/ocean",
    F: "mod/oil-field",
    V: "core/void"
  },
  requiredTerrainModIds: ["mod-oil-field"],
  players: 2,
  soldiers: legacyDemoMap.soldiers.map(([index, legacySeat, strength]) => [index, legacySeat + 1, strength]),
  teams: [1, 2],
  matchConditionIds: ["core/lose-all-survival-anchors", "core/last-team-standing"]
};

export const TEST_MAP_CODE = JSON.stringify(TEST_MAP_DEFINITION);
