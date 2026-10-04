export interface BoardCamera {
  readonly zoom: number;
  readonly pan: Readonly<{ x: number; y: number }>;
}

export interface BoardViewport {
  readonly width: number;
  readonly height: number;
}

export interface BoardPoint {
  readonly x: number;
  readonly y: number;
}

export const MIN_BOARD_ZOOM = 0.2;
export const MAX_BOARD_ZOOM = 6;

/** Keep the established per-wheel-event increment; only the available zoom range is changing. */
export function getBoardWheelZoomFactor(deltaY: number): number {
  if (deltaY === 0) return 1;
  return deltaY < 0 ? 1.05 : 0.95;
}

/** Keep the world point beneath the cursor stationary while changing camera scale. */
export function zoomBoardCameraAtPoint(
  camera: BoardCamera,
  viewport: BoardViewport,
  point: BoardPoint,
  zoomFactor: number
): BoardCamera {
  const zoom = Math.max(MIN_BOARD_ZOOM, Math.min(MAX_BOARD_ZOOM, camera.zoom * zoomFactor));
  if (zoom === camera.zoom) return camera;

  const oldOffsetX = (1 - camera.zoom) * viewport.width / 2 + camera.pan.x;
  const oldOffsetY = (1 - camera.zoom) * viewport.height / 2 + camera.pan.y;
  const worldX = (point.x - oldOffsetX) / camera.zoom;
  const worldY = (point.y - oldOffsetY) / camera.zoom;
  const nextOffsetX = point.x - worldX * zoom;
  const nextOffsetY = point.y - worldY * zoom;

  return {
    zoom,
    pan: {
      x: nextOffsetX - (1 - zoom) * viewport.width / 2,
      y: nextOffsetY - (1 - zoom) * viewport.height / 2
    }
  };
}
