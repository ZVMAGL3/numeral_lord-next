export interface MapEditorPan {
  readonly x: number;
  readonly y: number;
}

export interface MapEditorSize {
  readonly width: number;
  readonly height: number;
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
