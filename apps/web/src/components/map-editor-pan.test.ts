import { describe, expect, it } from "vitest";
import { clampMapEditorPan } from "./map-editor-pan";

describe("map editor pan bounds", () => {
  it("allows a large drag but keeps at least half a small board visible", () => {
    const clamped = clampMapEditorPan({ x: 5000, y: -5000 },
      { width: 1000, height: 800 }, { width: 400, height: 300 }, { x: 450, y: 400 });
    expect(clamped).toEqual({ x: 550, y: -400 });
  });

  it("keeps at least half of the viewport covered by an oversized board", () => {
    const clamped = clampMapEditorPan({ x: -5000, y: 5000 },
      { width: 1000, height: 800 }, { width: 1600, height: 1200 }, { x: 450, y: 400 });
    expect(clamped).toEqual({ x: -750, y: 600 });
  });
});
