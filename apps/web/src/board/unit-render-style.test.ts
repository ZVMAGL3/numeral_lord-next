import { describe, expect, it } from "vitest";
import { getUnitRenderScale, getUnitStrengthFontSize, getUnitStrengthLabelScale, UNIT_BODY_ALPHA, UNIT_DETAIL_ALPHA } from "./unit-render-style.js";

describe("unit render style", () => {
  it("keeps powered units larger than roamers", () => {
    expect(getUnitRenderScale(false)).toBe(0.58);
    expect(getUnitRenderScale(true)).toBe(1);
  });

  it("keeps world labels proportional to cells and rasterizes them at the active zoom", () => {
    expect(getUnitStrengthFontSize(8, false, false)).toBeCloseTo(3.36);
    expect(getUnitStrengthFontSize(22, false, false)).toBeCloseTo(9.24);
    expect(getUnitStrengthFontSize(8, false, true)).toBe(9);
    expect(getUnitStrengthFontSize(8, false, false, 4) * getUnitStrengthLabelScale(4)).toBeCloseTo(3.36);
    expect(getUnitStrengthFontSize(8, false, false, 4)).toBeGreaterThan(getUnitStrengthFontSize(8, false, false));
  });

  it("does not make a unit translucent to indicate that it has acted", () => {
    expect(UNIT_BODY_ALPHA).toBe(0.96);
    expect(UNIT_DETAIL_ALPHA).toBe(0.24);
  });
});
