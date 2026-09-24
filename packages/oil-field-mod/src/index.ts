import { defineMod, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";

/** Stable terrain id owned by this Mod, not by the built-in terrain pack. */
export const OIL_FIELD_TERRAIN_ID = "mod/oil-field";

// `core/occupiable` is a public capability supplied by the core terrain pack.
const occupiable: CapabilityBinding = { id: "core/occupiable" };

/** Oil fields cannot counterattack even if the occupying unit normally can. */
const noCounterattack: CapabilityBinding = {
  id: "core/counterattack-terrain-limit",
  config: { maxPerActionPhase: 0 }
};

/** Reuse the core terrain's capture-arrival reaction on this optional tile. */
const captureArrivalExhaustion: CapabilityBinding = {
  id: "core/exhaust-unpowered-after-capture"
};

// These two public rule capabilities are registered by this Mod because the
// oil field is an optional content package, not a native terrain.
const oilFieldIncome: CapabilityBinding = {
  id: "core/income-source",
  config: {
    // 触发时机和驻兵要求是内核现有能力契约；可配置的是收益数量。
    amount: 2
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
  settings: [{
    id: "incomePerTurn",
    displayName: "油田每回合收益",
    description: "有己方单位驻守时，在该玩家回合开始获得的点数。",
    kind: "integer",
    defaultValue: 2,
    min: 0,
    max: 20,
    target: {
      terrainId: OIL_FIELD_TERRAIN_ID,
      capabilityId: "core/income-source",
      configKey: "amount"
    }
  }],
  capabilities: [
    {
      id: "core/income-source",
      target: "terrain",
      defaultConfig: {
        amount: 0
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
    capabilities: [occupiable, oilFieldIncome, departureGarrison, noCounterattack, captureArrivalExhaustion]
  }],
  units: [],
  commandRules: [],
  victoryConditions: []
});

/** Runtime catalog installed by maps that opt into this Mod. */
export const oilFieldTerrainCatalog = Object.fromEntries(
  oilFieldMod.terrains.map((terrain) => [terrain.id, terrain])
) as TerrainCatalog;
