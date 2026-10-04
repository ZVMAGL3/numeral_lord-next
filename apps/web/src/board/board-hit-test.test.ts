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
});
