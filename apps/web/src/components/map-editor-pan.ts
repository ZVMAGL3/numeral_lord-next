export interface MapEditorPan {
  readonly x: number;
  readonly y: number;
}

export interface MapEditorSize {
  readonly width: number;
  readonly height: number;
}

/** Keep at least half of the viewport covered, unless the board is smaller. */
export function clampMapEditorPan(
  pan: MapEditorPan,
  viewport: MapEditorSize,
  board: MapEditorSize,
  boardCenter: MapEditorPan
): MapEditorPan {
  const visibleX = Math.min(viewport.width / 2, board.width);
  const visibleY = Math.min(viewport.height / 2, board.height);
  return {
    x: Math.max(visibleX - board.width / 2 - boardCenter.x,
      Math.min(viewport.width - visibleX + board.width / 2 - boardCenter.x, pan.x)),
    y: Math.max(visibleY - board.height / 2 - boardCenter.y,
      Math.min(viewport.height - visibleY + board.height / 2 - boardCenter.y, pan.y))
  };
}
