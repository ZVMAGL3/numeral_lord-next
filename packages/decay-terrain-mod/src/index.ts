import { defineTerrainMod, loadTerrainSvgAsset, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";

const decayTerrainArtwork = await loadTerrainSvgAsset(new URL("./assets/decay-terrain.svg", import.meta.url));
const decayOccupiedFrameArtwork = await loadTerrainSvgAsset(new URL("./assets/occupied-frame.svg", import.meta.url));

export const DECAY_MOD_ID = "mod-decay-terrain";
const DECAY_CAPABILITY_ID = "mod/decay-terrain/turn-start-drain";
const decayTerrain: CapabilityBinding = { id: DECAY_CAPABILITY_ID };
const occupiable: CapabilityBinding = { id: "core/occupiable" };
const powerConductor: CapabilityBinding = { id: "core/power-conductor" };

const unitsOnDecayTerrain = {
  id: "mod-decay-terrain/units-on-decay",
  starts: { op: "terrain-has" as const, capabilityId: DECAY_CAPABILITY_ID },
  expression: { op: "repeat" as const, min: 0, max: 0, item: {
    op: "step" as const,
    relation: "hex-neighbor" as const,
    where: { op: "terrain-has" as const, capabilityId: DECAY_CAPABILITY_ID }
  } },
  result: { entity: "unit" as const, distinctBy: "id" as const }
} as const;

/** A player's unit loses one strength when its owner's turn begins on this tile. */
export const decayTerrainMod = defineTerrainMod({
  id: DECAY_MOD_ID,
  name: "衰蚀地",
  version: "0.3.1",
  capabilities: [{
    id: DECAY_CAPABILITY_ID,
    target: "terrain",
    defaultConfig: {}
  }],
  spatialPatterns: [unitsOnDecayTerrain],
  rules: [{
    id: "mod-decay-terrain/lose-strength-at-turn-start",
    trigger: "turn-start",
    target: { scope: "pattern-units", patternId: unitsOnDecayTerrain.id, owner: "actor" },
    effects: [{ type: "change-strength", amount: -1 }]
  }],
  visualAssets: [
    { id: "decay-terrain-art", dataUrl: decayTerrainArtwork },
    { id: "decay-terrain-occupied-frame", dataUrl: decayOccupiedFrameArtwork }
  ],
  terrain: {
    capabilities: [occupiable, powerConductor, decayTerrain],
    visuals: {
      baseAssetId: "decay-terrain-art",
      overlay: {
        assetId: "decay-terrain-occupied-frame",
        scale: 1,
        opacity: 0.94,
        offsetX: 0,
        offsetY: 0,
        whenOccupied: true
      }
    }
  },
  units: [],
  commandRules: [],
  victoryConditions: []
});

export const DECAY_TERRAIN_ID = decayTerrainMod.terrain.id;

export const decayTerrainCatalog = Object.fromEntries(
  [[decayTerrainMod.terrain.id, decayTerrainMod.terrain]]
) as TerrainCatalog;
