import { describe, expect, it } from "vitest";
import { shouldCreateCellHitTarget } from "./board-cell-hit-target.js";

describe("board cell hit targets", () => {
  it("keeps void invisible in play while allowing the map editor to paint it", () => {
    expect(shouldCreateCellHitTarget("core/void", false)).toBe(false);
    expect(shouldCreateCellHitTarget("core/void", true)).toBe(true);
    expect(shouldCreateCellHitTarget("core/plain", false)).toBe(true);
  });
});
