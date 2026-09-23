import type { CellId, HexCoordinate } from "./state.js";

export interface HexBounds {
  readonly columns: number;
  readonly rows: number;
}

/**
 * The game preserves the old project's odd-row horizontal layout. Rows are
 * offset alternately, so the six neighbours depend on row parity.
 */
export const HEX_DIRECTIONS = [
  "northWest",
  "northEast",
  "east",
  "southEast",
  "southWest",
  "west"
] as const;

export type HexDirection = (typeof HEX_DIRECTIONS)[number];

const evenRowOffsets: Readonly<Record<HexDirection, HexCoordinate>> = {
  // The legacy board shifts even rows half a cell to the right. Keep these
  // offsets in exactly the same coordinate system as map.js#around().
  northWest: { column: 0, row: -1 },
  northEast: { column: 1, row: -1 },
  east: { column: 1, row: 0 },
  southEast: { column: 1, row: 1 },
  southWest: { column: 0, row: 1 },
  west: { column: -1, row: 0 }
};

const oddRowOffsets: Readonly<Record<HexDirection, HexCoordinate>> = {
  northWest: { column: -1, row: -1 },
  northEast: { column: 0, row: -1 },
  east: { column: 1, row: 0 },
  southEast: { column: 0, row: 1 },
  southWest: { column: -1, row: 1 },
  west: { column: -1, row: 0 }
};

export function isWithinHexBounds(
  coordinate: HexCoordinate,
  bounds: HexBounds
): boolean {
  return coordinate.column >= 0
    && coordinate.column < bounds.columns
    && coordinate.row >= 0
    && coordinate.row < bounds.rows;
}

export function getHexNeighbour(
  coordinate: HexCoordinate,
  direction: HexDirection
): HexCoordinate {
  const offsets = coordinate.row % 2 === 0 ? evenRowOffsets : oddRowOffsets;
  const offset = offsets[direction];

  return {
    column: coordinate.column + offset.column,
    row: coordinate.row + offset.row
  };
}

export function getHexNeighbours(
  coordinate: HexCoordinate,
  bounds: HexBounds
): HexCoordinate[] {
  return HEX_DIRECTIONS
    .map((direction) => getHexNeighbour(coordinate, direction))
    .filter((neighbour) => isWithinHexBounds(neighbour, bounds));
}

/**
 * Board-aware hex distance. A breadth-first walk keeps the calculation tied
 * to the legacy alternating-row layout, including map edges.
 */
export function getHexDistance(
  from: HexCoordinate,
  to: HexCoordinate,
  bounds: HexBounds
): number | undefined {
  if (!isWithinHexBounds(from, bounds) || !isWithinHexBounds(to, bounds)) return undefined;
  const targetId = toCellId(to);
  const visited = new Set<CellId>([toCellId(from)]);
  const frontier: Array<{ readonly coordinate: HexCoordinate; readonly distance: number }> = [{ coordinate: from, distance: 0 }];

  while (frontier.length > 0) {
    const current = frontier.shift();
    if (!current) break;
    if (toCellId(current.coordinate) === targetId) return current.distance;
    for (const neighbour of getHexNeighbours(current.coordinate, bounds)) {
      const neighbourId = toCellId(neighbour);
      if (visited.has(neighbourId)) continue;
      visited.add(neighbourId);
      frontier.push({ coordinate: neighbour, distance: current.distance + 1 });
    }
  }
  return undefined;
}

export function toCellId(coordinate: HexCoordinate): CellId {
  return `${coordinate.column},${coordinate.row}` as CellId;
}

export function fromCellId(cellId: CellId): HexCoordinate {
  const [columnText, rowText, ...remaining] = cellId.split(",");
  const column = Number(columnText);
  const row = Number(rowText);

  if (
    remaining.length > 0
    || !Number.isInteger(column)
    || !Number.isInteger(row)
    || column < 0
    || row < 0
  ) {
    throw new Error(`Invalid cell id: ${cellId}`);
  }

  return { column, row };
}
