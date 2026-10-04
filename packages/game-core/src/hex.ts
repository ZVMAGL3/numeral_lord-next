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

export interface HexAxialCoordinate {
  readonly q: number;
  readonly r: number;
}

/** Convert this board's even-row-shifted coordinates to parity-free axial coordinates. */
export function toAxialCoordinate(coordinate: HexCoordinate): HexAxialCoordinate {
  return { q: coordinate.column - Math.floor((coordinate.row + 1) / 2), r: coordinate.row };
}

/** Convert parity-free axial coordinates back to this board's even-row-shifted layout. */
export function fromAxialCoordinate(coordinate: HexAxialCoordinate): HexCoordinate {
  return { column: coordinate.q + Math.floor((coordinate.r + 1) / 2), row: coordinate.r };
}

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
  const startId = toCellId(from);
  const visited = new Set<CellId>([startId]);
  const frontier: Array<{ readonly coordinate: HexCoordinate; readonly id: CellId; readonly distance: number }> = [
    { coordinate: from, id: startId, distance: 0 }
  ];
  for (let head = 0; head < frontier.length; head += 1) {
    const current = frontier[head];
    if (!current) continue;
    if (current.id === targetId) return current.distance;
    for (const neighbour of getHexNeighbours(current.coordinate, bounds)) {
      const neighbourId = toCellId(neighbour);
      if (visited.has(neighbourId)) continue;
      visited.add(neighbourId);
      frontier.push({ coordinate: neighbour, id: neighbourId, distance: current.distance + 1 });
    }
  }
  return undefined;
}

/**
 * Return board-aware distances from one cell, optionally stopping at a range.
 * A single breadth-first walk is much cheaper than asking for the distance to
 * every board cell independently when painting legal-action highlights.
 */
export function getHexDistances(
  from: HexCoordinate,
  bounds: HexBounds,
  maxDistance = Number.POSITIVE_INFINITY
): ReadonlyMap<CellId, number> {
  if (!isWithinHexBounds(from, bounds) || maxDistance < 0) return new Map();
  const distances = new Map<CellId, number>([[toCellId(from), 0]]);
  const frontier: Array<{ readonly coordinate: HexCoordinate; readonly id: CellId }> = [
    { coordinate: from, id: toCellId(from) }
  ];

  for (let head = 0; head < frontier.length; head += 1) {
    const current = frontier[head];
    if (!current) continue;
    const distance = distances.get(current.id) ?? 0;
    if (distance >= maxDistance) continue;
    for (const neighbour of getHexNeighbours(current.coordinate, bounds)) {
      const neighbourId = toCellId(neighbour);
      if (distances.has(neighbourId)) continue;
      distances.set(neighbourId, distance + 1);
      frontier.push({ coordinate: neighbour, id: neighbourId });
    }
  }
  return distances;
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
