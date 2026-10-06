export interface MapEditorPan {
  readonly x: number;
  readonly y: number;
}

export interface MapEditorSize {
  readonly width: number;
  readonly height: number;
}

export interface MapEditorCamera {
  readonly zoom: number;
  readonly pan: MapEditorPan;
}

export interface MapEditorPoint {
  readonly x: number;
  readonly y: number;
}

export const MIN_MAP_EDITOR_ZOOM = 0.6;
export const MAP_EDITOR_TARGET_HEX_RADIUS = 192;

/** Scale each map only until its hexes reach the same usable screen size. */
export function getMapEditorMaxZoom(baseHexRadius: number): number {
  return MAP_EDITOR_TARGET_HEX_RADIUS / Math.max(1, baseHexRadius);
}

export function clampMapEditorZoom(zoom: number, maxZoom: number): number {
  const ceiling = Math.max(0.01, maxZoom);
  const floor = Math.min(MIN_MAP_EDITOR_ZOOM, ceiling);
  return Math.max(floor, Math.min(ceiling, zoom));
}

/** Keep the world point under an anchor fixed, allowing the anchor to move during a pinch. */
export function zoomMapEditorCameraAtPoints(
  camera: MapEditorCamera,
  viewport: MapEditorSize,
  anchorBefore: MapEditorPoint,
  anchorAfter: MapEditorPoint,
  zoom: number
): MapEditorCamera {
  if (camera.zoom <= 0 || zoom <= 0) return camera;
  const oldOffsetX = (1 - camera.zoom) * viewport.width / 2 + camera.pan.x;
  const oldOffsetY = (1 - camera.zoom) * viewport.height / 2 + camera.pan.y;
  const worldX = (anchorBefore.x - oldOffsetX) / camera.zoom;
  const worldY = (anchorBefore.y - oldOffsetY) / camera.zoom;
  const nextOffsetX = anchorAfter.x - worldX * zoom;
  const nextOffsetY = anchorAfter.y - worldY * zoom;

  return {
    zoom,
    pan: {
      x: nextOffsetX - (1 - zoom) * viewport.width / 2,
      y: nextOffsetY - (1 - zoom) * viewport.height / 2
    }
  };
}

/** Keep the screen center inside the board bounds while allowing the board off-screen. */
export function clampMapEditorPan(
  pan: MapEditorPan,
  viewport: MapEditorSize,
  board: MapEditorSize,
  boardCenter: MapEditorPan
): MapEditorPan {
  const minX = viewport.width / 2 - board.width / 2 - boardCenter.x;
  const maxX = viewport.width / 2 + board.width / 2 - boardCenter.x;
  const minY = viewport.height / 2 - board.height / 2 - boardCenter.y;
  const maxY = viewport.height / 2 + board.height / 2 - boardCenter.y;
  return {
    x: Math.max(minX, Math.min(maxX, pan.x)),
    y: Math.max(minY, Math.min(maxY, pan.y))
  };
}
