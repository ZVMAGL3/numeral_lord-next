import { defineTerrainMod, loadTerrainSvgAsset, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";

const oilFieldArtwork = await loadTerrainSvgAsset(new URL("./assets/oil-field.svg", import.meta.url));

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
    amount: 2,
    requires: "occupied",
    when: "owner-turn-start"
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
export const oilFieldMod = defineTerrainMod({
  id: "mod-oil-field",
  name: "油田",
  version: "0.1.1",
  settings: [{
    id: "incomePerTurn",
    displayName: "油田每回合收益",
    description: "有己方单位占领时，在该玩家回合开始获得的点数；不要求通电。",
    kind: "integer",
    defaultValue: 2,
    min: 0,
    max: 20,
    target: {
      capabilityId: "core/income-source",
      configKey: "amount"
    }
  }],
  capabilities: [
    {
      id: "core/income-source",
      target: "terrain",
      defaultConfig: {
        amount: 0,
        requires: "occupied",
        when: "owner-turn-start"
      }
    },
    {
      id: "core/departure-garrison",
      target: "terrain",
      defaultConfig: { strength: 1, unitDefinitionId: "core/roamer" }
    }
  ],
  visualAssets: [{ id: "oil-field-art", dataUrl: oilFieldArtwork }],
  terrain: {
    // It is occupiable but deliberately not conductive: oil income does not
    // turn a roaming unit into a powered unit.
    capabilities: [occupiable, oilFieldIncome, departureGarrison, noCounterattack, captureArrivalExhaustion],
    visuals: {
      baseAssetId: "oil-field-art"
    }
  },
  units: [],
  commandRules: [],
  victoryConditions: []
});

/** Stable terrain id owned by this Mod, derived from its Mod ID. */
export const OIL_FIELD_TERRAIN_ID = oilFieldMod.terrain.id;

/** Runtime catalog installed by maps that opt into this Mod. */
export const oilFieldTerrainCatalog = Object.fromEntries(
  [[oilFieldMod.terrain.id, oilFieldMod.terrain]]
) as TerrainCatalog;
