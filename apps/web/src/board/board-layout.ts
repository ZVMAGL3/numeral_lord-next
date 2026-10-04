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
