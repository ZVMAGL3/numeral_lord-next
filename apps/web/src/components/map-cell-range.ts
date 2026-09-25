/** Return the board indices within a radius on the editor's odd-row hex grid. */
export function getMapCellRangeIndices(centerIndex: number, columns: number, cellCount: number, radius: number): number[] {
  if (!Number.isInteger(centerIndex) || !Number.isInteger(columns) || columns < 1 || centerIndex < 0 || centerIndex >= cellCount) return [];
  const normalizedRadius = Math.max(0, Math.trunc(radius));
  const centerRow = Math.floor(centerIndex / columns);
  const centerColumn = centerIndex % columns;
  const toAxial = (column: number, row: number) => ({ q: column - Math.floor((row - (row & 1)) / 2), r: row });
  const center = toAxial(centerColumn, centerRow);
  const indexes: number[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    const row = Math.floor(index / columns), column = index % columns;
    const cell = toAxial(column, row);
    const dq = cell.q - center.q, dr = cell.r - center.r;
    if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) <= normalizedRadius) indexes.push(index);
  }
  return indexes;
}
