export * from "./terrains.js";
export * from "./units.js";
export * from "./demo-match.js";
export * from "./match-conditions.js";
export * from "./legacy-demo-map.js";
// Re-export the optional Mod entry point so consumers can inspect/install it.
export { OIL_FIELD_TERRAIN_ID, oilFieldMod, oilFieldTerrainCatalog } from "../../oil-field-mod/src/index.js";
