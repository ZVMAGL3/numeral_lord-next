import { describe, expect, it } from "vitest";
import { getHexNeighbours } from "@numeral-lord/game-core";
import { getMapCellRangeIndices } from "./map-cell-range";

describe("map editor hex fill range", () => {
  it.each([[0, 1], [1, 7], [2, 19], [3, 37]])("radius %i contains %i cells away from edges", (radius, count) => {
    const center = 10 * 21 + 10;
    expect(getMapCellRangeIndices(center, 21, 21 * 21, radius)).toHaveLength(count);
  });

  it("clips a fill range at the map boundary", () => {
    expect(getMapCellRangeIndices(0, 9, 81, 1)).toEqual([0, 1, 9, 10]);
  });

  it.each([10 * 21 + 10, 11 * 21 + 10])("matches the game's six neighbours for center index %i", (center) => {
    const coordinate = { column: center % 21, row: Math.floor(center / 21) };
    const expected = [center, ...getHexNeighbours(coordinate, { columns: 21, rows: 21 })
      .map(({ column, row }) => row * 21 + column)].sort((a, b) => a - b);
    expect(getMapCellRangeIndices(center, 21, 21 * 21, 1)).toEqual(expected);
  });
});
