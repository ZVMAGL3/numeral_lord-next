import { describe, expect, it } from "vitest";
import { getTerrainArtClipPoints, getTerrainHexPoints, TERRAIN_ART_FOOTPRINT_SCALE } from "./terrain-art-geometry.js";

describe("terrain art geometry", () => {
  it("uses the exact shared hex footprint for every terrain and art layer", () => {
    expect(TERRAIN_ART_FOOTPRINT_SCALE).toBe(0.98);
    expect(getTerrainArtClipPoints()).toBe("99,29.4449 99,86.0251 50,114.3153 1,86.0251 1,29.4448 50,1.1547");
    expect(getTerrainHexPoints(TERRAIN_ART_FOOTPRINT_SCALE)).toBe(getTerrainArtClipPoints());
  });
});
