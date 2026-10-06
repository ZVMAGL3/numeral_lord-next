import type { CellId, HexCoordinate, MapCell } from "@numeral-lord/game-core";

export interface BoardLayoutSnapshot {
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly coordinates: ReadonlyMap<CellId, HexCoordinate>;
}

export interface BoardLayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly Pick<MapCell, "id" | "coordinate">[];
}

export const GAME_BOARD_HEX_RADIUS = 24;

/** Keep gameplay boards on a stable world scale; previews and the map editor fit their available surface. */
export function getBoardHexRadius(
  width: number,
  height: number,
  columns: number,
  rows: number,
  padding: number,
  fitToViewport: boolean,
  fixedRadius = GAME_BOARD_HEX_RADIUS
): number {
  if (!fitToViewport) return fixedRadius;
  const fitRadius = Math.min(
    (width - padding) / (Math.sqrt(3) * (columns + 0.5)),
    (height - padding) / (1.5 * (rows - 1) + 2)
  );
  return Math.max(1, fitRadius);
}

/** 只在棋盘几何真的改变时重算格子位置，不依赖网络快照对象的引用。 */
export function boardLayoutChanged(previous: BoardLayoutSnapshot | undefined, next: BoardLayoutInput): boolean {
  if (!previous
    || previous.columns !== next.columns
    || previous.rows !== next.rows
    || previous.width !== next.width
    || previous.height !== next.height
    || previous.coordinates.size !== next.cells.length) return true;

  return next.cells.some(({ id, coordinate }) => {
    const old = previous.coordinates.get(id);
    return !old || old.column !== coordinate.column || old.row !== coordinate.row;
  });
}
