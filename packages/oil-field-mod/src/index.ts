import { defineMod, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";

/** Stable terrain id owned by this Mod, not by the built-in terrain pack. */
export const OIL_FIELD_TERRAIN_ID = "mod/oil-field";

// `core/occupiable` is a public capability supplied by the core terrain pack.
const occupiable: CapabilityBinding = { id: "core/occupiable" };

// These two public rule capabilities are registered by this Mod because the
// oil field is an optional content package, not a native terrain.
const oilFieldIncome: CapabilityBinding = {
  id: "core/income-source",
  config: {
    amount: 2,
    timing: "start-of-owner-turn",
    requires: "occupant"
  }
};

const departureGarrison: CapabilityBinding = {
  id: "core/departure-garrison",
  config: {
    strength: 1,
    unitDefinitionId: "core/roamer"
  }
};

/**
 * Optional example Mod. It composes public core capabilities without changing
 * `game-core` or the native terrain definitions. A future Mod follows this
 * same shape: define its own id/version, register any new capabilities, then
 * export a terrain catalog that a map explicitly installs.
 */
export const oilFieldMod = defineMod({
  id: "mod-oil-field",
  version: "0.1.0",
  capabilities: [
    {
      id: "core/income-source",
      target: "terrain",
      defaultConfig: {
        amount: 0,
        timing: "start-of-owner-turn",
        requires: "occupant"
      }
    },
    {
      id: "core/departure-garrison",
      target: "terrain",
      defaultConfig: { strength: 1, unitDefinitionId: "core/roamer" }
    }
  ],
  terrains: [{
    id: OIL_FIELD_TERRAIN_ID,
    displayName: "油田",
    // It is occupiable but deliberately not conductive: oil income does not
    // turn a roaming unit into a powered unit.
    capabilities: [occupiable, oilFieldIncome, departureGarrison]
  }],
  units: [],
  commandRules: [],
  victoryConditions: []
});

/** Runtime catalog installed by maps that opt into this Mod. */
export const oilFieldTerrainCatalog = Object.fromEntries(
  oilFieldMod.terrains.map((terrain) => [terrain.id, terrain])
) as TerrainCatalog;
