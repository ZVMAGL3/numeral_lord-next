import { describe, expect, it } from "vitest";
import { findBoardCellAtPoint } from "./board-hit-test.js";

describe("board pointer hit testing", () => {
  const layouts = new Map([
    ["left", { x: 0, y: 0, radius: 10 }],
    ["right", { x: Math.sqrt(3) * 10, y: 0, radius: 10 }],
    ["void", { x: 0, y: 15, radius: 10 }]
  ]);
  const terrain = new Map([
    ["left", "core/plain"],
    ["right", "core/ocean"],
    ["void", "core/void"]
  ]);

  it("finds the clicked pointy-top hex and its neighbor", () => {
    expect(findBoardCellAtPoint(layouts, terrain, { x: 0, y: 0 })).toBe("left");
    expect(findBoardCellAtPoint(layouts, terrain, { x: Math.sqrt(3) * 10, y: 0 })).toBe("right");
  });

  it("does not turn gaps outside every hex into clicks", () => {
    expect(findBoardCellAtPoint(layouts, terrain, { x: 8.7, y: 9.9 })).toBeUndefined();
    expect(findBoardCellAtPoint(layouts, terrain, { x: 0, y: 10.1 })).toBeUndefined();
  });

  it("ignores void cells in play but leaves them clickable in the editor", () => {
    expect(findBoardCellAtPoint(layouts, terrain, { x: 0, y: 15 })).toBeUndefined();
    expect(findBoardCellAtPoint(layouts, terrain, { x: 0, y: 15 }, true)).toBe("void");
  });

  it("uses nearby grid candidates without changing hit results", () => {
    const radius = 10;
    const columns = 8;
    const rows = 7;
    const gridLayouts = new Map<string, { x: number; y: number; radius: number }>();
    const gridTerrain = new Map<string, string>();
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const id = `${column},${row}`;
        gridLayouts.set(id, {
          x: Math.sqrt(3) * radius * (column + ((row + 1) % 2) * 0.5),
          y: 1.5 * radius * row,
          radius
        });
        gridTerrain.set(id, "core/plain");
      }
    }
    const geometry = { columns, rows, originX: 0, originY: 0, radius };
    for (let y = -radius; y <= 1.5 * radius * rows; y += 2.5) {
      for (let x = -radius; x <= Math.sqrt(3) * radius * (columns + 1); x += 2.5) {
        expect(findBoardCellAtPoint(gridLayouts, gridTerrain, { x, y }, true, geometry))
          .toBe(findBoardCellAtPoint(gridLayouts, gridTerrain, { x, y }, true));
      }
    }
  });
});
