export interface BoardCellLayout {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Map one stage-space point to a real hex without asking Pixi to hit-test every tile Graphic. */
export function findBoardCellAtPoint<CellKey extends string>(
  cellLayouts: ReadonlyMap<CellKey, BoardCellLayout>,
  terrainByCell: ReadonlyMap<CellKey, string>,
  point: Readonly<{ x: number; y: number }>,
  editable = false
): CellKey | undefined {
  let selectedCell: CellKey | undefined;
  let selectedDistance = Number.POSITIVE_INFINITY;
  const sqrtThree = Math.sqrt(3);

  for (const [cellId, layout] of cellLayouts) {
    if (!editable && terrainByCell.get(cellId) === "core/void") continue;
    const dx = Math.abs(point.x - layout.x);
    const dy = Math.abs(point.y - layout.y);
    if (dx > layout.radius * sqrtThree / 2 || dy > layout.radius) continue;
    if (sqrtThree * dx + dy > sqrtThree * layout.radius + 0.001) continue;

    const distance = dx * dx + dy * dy;
    if (distance >= selectedDistance) continue;
    selectedCell = cellId;
    selectedDistance = distance;
  }

  return selectedCell;
}
