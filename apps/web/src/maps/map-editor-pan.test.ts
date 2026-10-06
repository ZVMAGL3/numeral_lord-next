import { describe, expect, it } from "vitest";
import { clampMapEditorPan, clampMapEditorZoom, getMapEditorMaxZoom, MAP_EDITOR_TARGET_HEX_RADIUS } from "./map-editor-pan";

describe("map editor pan bounds", () => {
  it("sets a map-size-aware limit so every map reaches the same maximum hex size", () => {
    const smallMapBaseRadius = 66.8;
    const largeMapBaseRadius = 9.8;
    const smallMapLimit = getMapEditorMaxZoom(smallMapBaseRadius);
    const largeMapLimit = getMapEditorMaxZoom(largeMapBaseRadius);

    expect(largeMapLimit).toBeGreaterThan(smallMapLimit);
    expect(smallMapBaseRadius * smallMapLimit).toBeCloseTo(MAP_EDITOR_TARGET_HEX_RADIUS);
    expect(largeMapBaseRadius * largeMapLimit).toBeCloseTo(MAP_EDITOR_TARGET_HEX_RADIUS);
    expect(clampMapEditorZoom(3.3, largeMapLimit)).toBe(3.3);
    expect(clampMapEditorZoom(100, smallMapLimit)).toBeCloseTo(smallMapLimit);
    expect(clampMapEditorZoom(0.2, largeMapLimit)).toBe(0.6);

    const verySmallMapBaseRadius = 400;
    const verySmallMapLimit = getMapEditorMaxZoom(verySmallMapBaseRadius);
    expect(verySmallMapBaseRadius * verySmallMapLimit).toBeCloseTo(MAP_EDITOR_TARGET_HEX_RADIUS);
    expect(clampMapEditorZoom(1, verySmallMapLimit)).toBeCloseTo(verySmallMapLimit);
  });

  it("allows most of a smaller board off-screen but keeps the screen center inside it", () => {
    const clamped = clampMapEditorPan({ x: 5000, y: -5000 },
      { width: 1000, height: 800 }, { width: 400, height: 300 }, { x: 500, y: 400 });
    expect(clamped).toEqual({ x: 200, y: -150 });
  });

  it("lets a larger board move beyond the screen while keeping its bounds across the center", () => {
    const clamped = clampMapEditorPan({ x: -5000, y: 5000 },
      { width: 1000, height: 800 }, { width: 1600, height: 1200 }, { x: 500, y: 400 });
    expect(clamped).toEqual({ x: -800, y: 600 });
  });
});
