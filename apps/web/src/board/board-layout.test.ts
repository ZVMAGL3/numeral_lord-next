import { describe, expect, it } from "vitest";
import type { CellId } from "@numeral-lord/game-core";
import { boardLayoutChanged, type BoardLayoutSnapshot } from "./board-layout.js";

const a = "a" as CellId;
const b = "b" as CellId;

function previousLayout(): BoardLayoutSnapshot {
  return {
    columns: 2,
    rows: 1,
    width: 400,
    height: 300,
    coordinates: new Map([
      [a, { column: 0, row: 0 }],
      [b, { column: 1, row: 0 }]
    ])
  };
}

describe("棋盘布局失效判断", () => {
  it("网络重建了对象但格子几何相同时不触发整盘布局重算", () => {
    expect(boardLayoutChanged(previousLayout(), {
      columns: 2,
      rows: 1,
      width: 400,
      height: 300,
      cells: [
        { id: a, coordinate: { column: 0, row: 0 } },
        { id: b, coordinate: { column: 1, row: 0 } }
      ]
    })).toBe(false);
  });

  it("尺寸、视口或坐标变化时才重算布局", () => {
    const previous = previousLayout();
    const base = {
      columns: 2,
      rows: 1,
      width: 400,
      height: 300,
      cells: [
        { id: a, coordinate: { column: 0, row: 0 } },
        { id: b, coordinate: { column: 1, row: 0 } }
      ]
    };

    expect(boardLayoutChanged(previous, { ...base, width: 401 })).toBe(true);
    expect(boardLayoutChanged(previous, {
      ...base,
      cells: [base.cells[0]!, { id: b, coordinate: { column: 0, row: 1 } }]
    })).toBe(true);
  });
});
