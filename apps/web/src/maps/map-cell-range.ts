import { getHexNeighbours } from "@numeral-lord/game-core";

/** Return the board indices within a radius using the game's actual hex neighbours. */
export function getMapCellRangeIndices(centerIndex: number, columns: number, cellCount: number, radius: number): number[] {
  if (!Number.isInteger(centerIndex) || !Number.isInteger(columns) || columns < 1 || centerIndex < 0 || centerIndex >= cellCount) return [];
  const normalizedRadius = Math.max(0, Math.trunc(radius));
  const rowCount = Math.ceil(cellCount / columns);
  const center = { column: centerIndex % columns, row: Math.floor(centerIndex / columns) };
  const visited = new Set<number>([centerIndex]);
  let frontier = [center];
  for (let distance = 0; distance < normalizedRadius; distance += 1) {
    const next: typeof frontier = [];
    for (const coordinate of frontier) {
      for (const neighbour of getHexNeighbours(coordinate, { columns, rows: rowCount })) {
        const index = neighbour.row * columns + neighbour.column;
        if (index >= cellCount || visited.has(index)) continue;
        visited.add(index);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return [...visited].sort((a, b) => a - b);
}
