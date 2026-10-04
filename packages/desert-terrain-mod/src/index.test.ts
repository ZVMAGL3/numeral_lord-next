import { describe, expect, it } from "vitest";
import { validateTerrainModDefinition } from "@numeral-lord/content-schema";
import { desertTerrainMod, DESERT_MOD_ID, DESERT_TERRAIN_ID } from "./index.js";

describe("desert terrain Mod", () => {
  it("is a separately installable plain-like Mod with no income source", () => {
    expect(desertTerrainMod.id).toBe(DESERT_MOD_ID);
    expect(desertTerrainMod.terrain.id).toBe(DESERT_TERRAIN_ID);
    expect(desertTerrainMod.terrain.capabilities.map(({ id }) => id)).toEqual([
      "core/occupiable",
      "core/power-conductor",
      "core/counterattack-terrain-limit",
      "core/exhaust-unpowered-after-capture"
    ]);
    expect(() => validateTerrainModDefinition({
      id: desertTerrainMod.id,
      version: desertTerrainMod.version,
      capabilities: desertTerrainMod.capabilities,
      terrain: { capabilities: desertTerrainMod.terrain.capabilities, visuals: desertTerrainMod.terrain.visuals }
    })).not.toThrow();
  });
});
