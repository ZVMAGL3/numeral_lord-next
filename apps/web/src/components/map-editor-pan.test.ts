import { describe, expect, it } from "vitest";
import { clampMapEditorPan } from "./map-editor-pan";

describe("map editor pan bounds", () => {
  it("stops when dragging right/up would move the left/bottom edge past center", () => {
    const clamped = clampMapEditorPan({ x: 5000, y: -5000 },
      { width: 1000, height: 800 }, { width: 400, height: 300 }, { x: 450, y: 400 });
    expect(clamped).toEqual({ x: 250, y: -150 });
  });

  it("stops when dragging left/down would move the right/top edge past center", () => {
    const clamped = clampMapEditorPan({ x: -5000, y: 5000 },
      { width: 1000, height: 800 }, { width: 1600, height: 1200 }, { x: 450, y: 400 });
    expect(clamped).toEqual({ x: -750, y: 600 });
  });
});
