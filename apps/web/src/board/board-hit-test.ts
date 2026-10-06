import { toCellId } from "@numeral-lord/game-core";

export interface BoardCellLayout {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface BoardHitTestGeometry {
  readonly columns: number;
  readonly rows: number;
  readonly originX: number;
  readonly originY: number;
  readonly radius: number;
}

/** Map one stage-space point to a real hex without asking Pixi to hit-test every tile Graphic. */
export function findBoardCellAtPoint<CellKey extends string>(
  cellLayouts: ReadonlyMap<CellKey, BoardCellLayout>,
  terrainByCell: ReadonlyMap<CellKey, string>,
  point: Readonly<{ x: number; y: number }>,
  editable = false,
  geometry?: BoardHitTestGeometry
): CellKey | undefined {
  let selectedCell: CellKey | undefined;
  let selectedDistance = Number.POSITIVE_INFINITY;
  const sqrtThree = Math.sqrt(3);

  if (geometry && geometry.radius > 0) {
    const { columns, rows, originX, originY, radius } = geometry;
    const rowCenter = Math.round((point.y - originY) / (1.5 * radius));
    for (let row = Math.max(0, rowCenter - 1); row <= Math.min(rows - 1, rowCenter + 1); row += 1) {
      const rowOffset = ((row + 1) % 2) * 0.5;
      const columnCenter = Math.round((point.x - originX) / (sqrtThree * radius) - rowOffset);
      for (let column = Math.max(0, columnCenter - 1); column <= Math.min(columns - 1, columnCenter + 1); column += 1) {
        const cellId = toCellId({ column, row }) as unknown as CellKey;
        const layout = cellLayouts.get(cellId);
        if (!layout || (!editable && terrainByCell.get(cellId) === "core/void")) continue;
        const dx = Math.abs(point.x - layout.x);
        const dy = Math.abs(point.y - layout.y);
        if (dx > layout.radius * sqrtThree / 2 || dy > layout.radius) continue;
        if (sqrtThree * dx + dy > sqrtThree * layout.radius + 0.001) continue;
        const distance = dx * dx + dy * dy;
        if (distance >= selectedDistance) continue;
        selectedCell = cellId;
        selectedDistance = distance;
      }
    }
    return selectedCell;
  }

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
