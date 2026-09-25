import { describe, expect, it } from "vitest";
import { getMapCellRangeIndices } from "./map-cell-range";

describe("map editor hex fill range", () => {
  it.each([[0, 1], [1, 7], [2, 19], [3, 37]])("radius %i contains %i cells away from edges", (radius, count) => {
    const center = 10 * 21 + 10;
    expect(getMapCellRangeIndices(center, 21, 21 * 21, radius)).toHaveLength(count);
  });

  it("clips a fill range at the map boundary", () => {
    expect(getMapCellRangeIndices(0, 9, 81, 1)).toEqual([0, 1, 9]);
  });
});
