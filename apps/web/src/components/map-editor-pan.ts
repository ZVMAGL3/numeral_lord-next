export interface MapEditorPan {
  readonly x: number;
  readonly y: number;
}

export interface MapEditorSize {
  readonly width: number;
  readonly height: number;
}

/** Clamp a full-screen canvas pan so the board bounds stop at screen edges. */
export function clampMapEditorPan(
  pan: MapEditorPan,
  viewport: MapEditorSize,
  board: MapEditorSize,
  boardCenter: MapEditorPan
): MapEditorPan {
  const centeredPanX = viewport.width / 2 - boardCenter.x;
  const centeredPanY = viewport.height / 2 - boardCenter.y;
  const travelX = Math.abs(viewport.width - board.width) / 2;
  const travelY = Math.abs(viewport.height - board.height) / 2;
  return {
    x: Math.max(centeredPanX - travelX, Math.min(centeredPanX + travelX, pan.x)),
    y: Math.max(centeredPanY - travelY, Math.min(centeredPanY + travelY, pan.y))
  };
}
