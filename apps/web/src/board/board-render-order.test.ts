import { describe, expect, it } from "vitest";
import { BOARD_RENDER_STACK, BOARD_RENDER_Z_INDEX, isBoardRenderStackOrdered } from "./board-render-order.js";

describe("board render stack", () => {
  it("keeps bottom art, units, top art, numbers and effects in their intended order", () => {
    expect(isBoardRenderStackOrdered()).toBe(true);
    expect(BOARD_RENDER_STACK.slice(0, 4)).toEqual([
      "terrainBase", "unit", "terrainTop", "unitStrength"
    ]);
    expect(BOARD_RENDER_Z_INDEX.legalEffect).toBeGreaterThan(BOARD_RENDER_Z_INDEX.unitStrength);
  });
});
