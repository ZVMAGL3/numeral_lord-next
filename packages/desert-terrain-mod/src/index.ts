import { defineTerrainMod, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";

export const DESERT_MOD_ID = "mod-desert-terrain";

// Desert tiles otherwise follow the plain's movement and combat behavior.
const plainCapabilities: readonly CapabilityBinding[] = [
  { id: "core/occupiable" },
  { id: "core/power-conductor" },
  { id: "core/counterattack-terrain-limit", config: { maxPerActionPhase: 1 } },
  { id: "core/exhaust-unpowered-after-capture" }
];

export const desertTerrainMod = defineTerrainMod({
  id: DESERT_MOD_ID,
  name: "沙漠",
  version: "1.0.0",
  capabilities: [],
  terrain: {
    // 沙漠没有绑定收益来源，因此驻兵不会产点；不需要额外的“禁止收益”能力。
    capabilities: [...plainCapabilities],
    visuals: { baseColor: "#c6a46b" }
  },
  units: [],
  commandRules: [],
  victoryConditions: []
});

export const DESERT_TERRAIN_ID = desertTerrainMod.terrain.id;

export const desertTerrainCatalog = Object.fromEntries(
  [[desertTerrainMod.terrain.id, desertTerrainMod.terrain]]
) as TerrainCatalog;
