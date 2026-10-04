import { describe, expect, it } from "vitest";
import { getUnitRenderScale, UNIT_BODY_ALPHA, UNIT_DETAIL_ALPHA } from "./unit-render-style.js";

describe("unit render style", () => {
  it("keeps powered units larger than roamers", () => {
    expect(getUnitRenderScale(false)).toBe(0.58);
    expect(getUnitRenderScale(true)).toBe(1);
  });

  it("does not make a unit translucent to indicate that it has acted", () => {
    expect(UNIT_BODY_ALPHA).toBe(0.96);
    expect(UNIT_DETAIL_ALPHA).toBe(0.24);
  });
});
