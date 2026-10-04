import { describe, expect, it } from "vitest";
import {
  fromCellId,
  getHexNeighbour,
  getHexDistances,
  getHexDistance,
  getHexNeighbours,
  isWithinHexBounds,
  toCellId
} from "./hex.js";

describe("odd-row hex grid", () => {
  it("uses the old board's alternating row layout", () => {
    expect(getHexNeighbour({ column: 2, row: 2 }, "northEast")).toEqual({
      column: 3,
      row: 1
    });
    expect(getHexNeighbour({ column: 2, row: 3 }, "northEast")).toEqual({
      column: 2,
      row: 2
    });
    expect(getHexNeighbour({ column: 2, row: 2 }, "west")).toEqual({
      column: 1,
      row: 2
    });
    expect(getHexNeighbour({ column: 2, row: 3 }, "southWest")).toEqual({
      column: 1,
      row: 4
    });
  });

  it("returns only valid adjacent cells at a map edge", () => {
    const neighbours = getHexNeighbours(
      { column: 0, row: 0 },
      { columns: 3, rows: 3 }
    );

    expect(neighbours).toEqual([
      { column: 1, row: 0 },
      { column: 1, row: 1 },
      { column: 0, row: 1 }
    ]);
  });

  it("computes one bounded distance map for a unit's action range", () => {
    const bounds = { columns: 7, rows: 7 };
    const distances = getHexDistances({ column: 3, row: 3 }, bounds, 2);

    expect(distances.get(toCellId({ column: 3, row: 3 }))).toBe(0);
    expect(distances.get(toCellId({ column: 4, row: 3 }))).toBe(1);
    expect(distances.get(toCellId({ column: 5, row: 3 }))).toBe(2);
    expect(getHexDistance({ column: 3, row: 3 }, { column: 5, row: 3 }, bounds)).toBe(2);
    expect(distances.has(toCellId({ column: 6, row: 3 }))).toBe(false);
    expect([...distances.values()].every((distance) => distance <= 2)).toBe(true);
  });

  it("checks bounds and serializes stable cell identifiers", () => {
    const coordinate = { column: 4, row: 7 };
    const id = toCellId(coordinate);

    expect(id).toBe("4,7");
    expect(fromCellId(id)).toEqual(coordinate);
    expect(isWithinHexBounds(coordinate, { columns: 5, rows: 8 })).toBe(true);
    expect(isWithinHexBounds({ column: 5, row: 7 }, { columns: 5, rows: 8 })).toBe(false);
    expect(() => fromCellId("1,not-a-row" as never)).toThrow("Invalid cell id");
  });
});
