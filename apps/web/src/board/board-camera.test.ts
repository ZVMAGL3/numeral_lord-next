import { describe, expect, it } from "vitest";
import { getBoardWheelZoomFactor, MAX_BOARD_ZOOM, MIN_BOARD_ZOOM, zoomBoardCameraAtPoint } from "./board-camera.js";

describe("board camera zoom", () => {
  it("uses a fine 5% wheel step", () => {
    expect(getBoardWheelZoomFactor(-100)).toBe(1.05);
    expect(getBoardWheelZoomFactor(100)).toBe(0.95);
    expect(getBoardWheelZoomFactor(0)).toBe(1);
  });

  it("keeps the world point under the pointer fixed while zooming", () => {
    const viewport = { width: 900, height: 640 };
    const point = { x: 173, y: 411 };
    const camera = { zoom: 1.35, pan: { x: -72, y: 28 } };
    const beforeOffsetX = (1 - camera.zoom) * viewport.width / 2 + camera.pan.x;
    const beforeOffsetY = (1 - camera.zoom) * viewport.height / 2 + camera.pan.y;
    const beforeWorldPoint = {
      x: (point.x - beforeOffsetX) / camera.zoom,
      y: (point.y - beforeOffsetY) / camera.zoom
    };

    const nextCamera = zoomBoardCameraAtPoint(camera, viewport, point, 1.24);
    const afterOffsetX = (1 - nextCamera.zoom) * viewport.width / 2 + nextCamera.pan.x;
    const afterOffsetY = (1 - nextCamera.zoom) * viewport.height / 2 + nextCamera.pan.y;
    const afterWorldPoint = {
      x: (point.x - afterOffsetX) / nextCamera.zoom,
      y: (point.y - afterOffsetY) / nextCamera.zoom
    };

    expect(afterWorldPoint.x).toBeCloseTo(beforeWorldPoint.x, 10);
    expect(afterWorldPoint.y).toBeCloseTo(beforeWorldPoint.y, 10);
  });

  it("allows a much wider zoom range while clamping at the new maximum", () => {
    const camera = { zoom: MAX_BOARD_ZOOM - 0.1, pan: { x: 0, y: 0 } };
    const result = zoomBoardCameraAtPoint(camera, { width: 800, height: 600 }, { x: 400, y: 300 }, 2);

    expect(result.zoom).toBe(MAX_BOARD_ZOOM);
  });

  it("allows zooming out to the new minimum", () => {
    const camera = { zoom: MIN_BOARD_ZOOM + 0.01, pan: { x: 0, y: 0 } };
    const result = zoomBoardCameraAtPoint(camera, { width: 800, height: 600 }, { x: 400, y: 300 }, 0.1);

    expect(result.zoom).toBe(MIN_BOARD_ZOOM);
  });
});
