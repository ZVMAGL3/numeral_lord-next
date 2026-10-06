import { describe, expect, it } from "vitest";
import { clampMapEditorPan, clampMapEditorZoom, getMapEditorMaxZoom, MAP_EDITOR_TARGET_HEX_RADIUS, zoomMapEditorCameraAtPoints } from "./map-editor-pan";

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

describe("map editor zoom anchors", () => {
  it("keeps the world location under a wheel pointer fixed", () => {
    const viewport = { width: 420, height: 760 };
    const point = { x: 83, y: 514 };
    const camera = { zoom: 1.4, pan: { x: -48, y: 72 } };
    const beforeOffset = {
      x: (1 - camera.zoom) * viewport.width / 2 + camera.pan.x,
      y: (1 - camera.zoom) * viewport.height / 2 + camera.pan.y
    };
    const world = { x: (point.x - beforeOffset.x) / camera.zoom, y: (point.y - beforeOffset.y) / camera.zoom };

    const next = zoomMapEditorCameraAtPoints(camera, viewport, point, point, 2.1);
    const afterOffset = {
      x: (1 - next.zoom) * viewport.width / 2 + next.pan.x,
      y: (1 - next.zoom) * viewport.height / 2 + next.pan.y
    };

    expect((point.x - afterOffset.x) / next.zoom).toBeCloseTo(world.x, 10);
    expect((point.y - afterOffset.y) / next.zoom).toBeCloseTo(world.y, 10);
  });

  it("keeps the initial pinch location under the moving two-finger midpoint", () => {
    const viewport = { width: 420, height: 760 };
    const start = { x: 170, y: 360 };
    const moved = { x: 205, y: 390 };
    const camera = { zoom: 1, pan: { x: 0, y: 0 } };
    const next = zoomMapEditorCameraAtPoints(camera, viewport, start, moved, 1.75);
    const nextOffset = {
      x: (1 - next.zoom) * viewport.width / 2 + next.pan.x,
      y: (1 - next.zoom) * viewport.height / 2 + next.pan.y
    };

    expect((moved.x - nextOffset.x) / next.zoom).toBeCloseTo(start.x, 10);
    expect((moved.y - nextOffset.y) / next.zoom).toBeCloseTo(start.y, 10);
  });
});
