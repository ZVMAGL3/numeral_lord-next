export interface MapEditorPan {
  readonly x: number;
  readonly y: number;
}

export interface MapEditorSize {
  readonly width: number;
  readonly height: number;
}

/** Keep the board bounds straddling the viewport center on both axes. */
export function clampMapEditorPan(
  pan: MapEditorPan,
  viewport: MapEditorSize,
  board: MapEditorSize,
  boardCenter: MapEditorPan
): MapEditorPan {
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  return {
    x: Math.max(centerX - board.width / 2 - boardCenter.x,
      Math.min(centerX + board.width / 2 - boardCenter.x, pan.x)),
    y: Math.max(centerY - board.height / 2 - boardCenter.y,
      Math.min(centerY + board.height / 2 - boardCenter.y, pan.y))
  };
}
