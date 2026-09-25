import { describe, expect, it } from "vitest";
import { clampMapEditorPan } from "./map-editor-pan";

describe("map editor pan bounds", () => {
  it("lets a board smaller than the screen move until its edge reaches the screen", () => {
    const clamped = clampMapEditorPan({ x: 5000, y: -5000 },
      { width: 1000, height: 800 }, { width: 400, height: 300 }, { x: 500, y: 400 });
    expect(clamped).toEqual({ x: 300, y: -250 });
  });

  it("lets a board larger than the screen move until its opposite edge reaches the screen", () => {
    const clamped = clampMapEditorPan({ x: -5000, y: 5000 },
      { width: 1000, height: 800 }, { width: 1600, height: 1200 }, { x: 500, y: 400 });
    expect(clamped).toEqual({ x: -300, y: 200 });
  });
});
