import { describe, expect, it } from "vitest";
import type { CellId } from "@numeral-lord/game-core";
import { boardLayoutChanged, GAME_BOARD_HEX_RADIUS, getBoardHexRadius, type BoardLayoutSnapshot } from "./board-layout.js";

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
  it("游戏地图使用稳定格子尺寸，编辑地图按可视区适配", () => {
    expect(getBoardHexRadius(1360, 800, 63, 63, 44, false)).toBe(GAME_BOARD_HEX_RADIUS);
    expect(getBoardHexRadius(1360, 800, 10, 10, 44, false)).toBe(GAME_BOARD_HEX_RADIUS);
    const smallEditorMapRadius = getBoardHexRadius(1920, 950, 9, 9, 14, true);
    const largeEditorMapRadius = getBoardHexRadius(1920, 950, 63, 63, 14, true);
    expect(smallEditorMapRadius).toBeGreaterThan(largeEditorMapRadius);
  });

  it("非交互地图预览仍然完整适配可视区", () => {
    expect(getBoardHexRadius(1000, 800, 10, 10, 44, true)).toBeCloseTo(48.77, 2);
  });

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
