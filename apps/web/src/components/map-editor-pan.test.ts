import { describe, expect, it } from "vitest";
import { clampMapEditorPan } from "./map-editor-pan";

describe("map editor pan bounds", () => {
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
