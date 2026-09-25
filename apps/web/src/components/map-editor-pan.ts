export interface MapEditorPan {
  readonly x: number;
  readonly y: number;
}

export interface MapEditorSize {
  readonly width: number;
  readonly height: number;
}

/** Clamp panning so at least half of the smaller board/viewport extent stays visible. */
export function clampMapEditorPan(
  pan: MapEditorPan,
  viewport: MapEditorSize,
  board: MapEditorSize,
  boardCenter: MapEditorPan
): MapEditorPan {
  const visibleX = Math.min(viewport.width, board.width) / 2;
  const visibleY = Math.min(viewport.height, board.height) / 2;
  return {
    x: Math.max(visibleX - board.width / 2 - boardCenter.x,
      Math.min(viewport.width - visibleX + board.width / 2 - boardCenter.x, pan.x)),
    y: Math.max(visibleY - board.height / 2 - boardCenter.y,
      Math.min(viewport.height - visibleY + board.height / 2 - boardCenter.y, pan.y))
  };
}
