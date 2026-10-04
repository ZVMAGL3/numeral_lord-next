export interface MapEditorPan {
  readonly x: number;
  readonly y: number;
}

export interface MapEditorSize {
  readonly width: number;
  readonly height: number;
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
