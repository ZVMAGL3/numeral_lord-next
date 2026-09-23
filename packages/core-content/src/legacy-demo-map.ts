/**
 * Migrated from the old `src/store/map.js` map id 1001.
 *
 * The terrain string is row-major: index = row * columns + column.
 * M = plain, P = mountain, S = stronghold, O = ocean, F = oil field, V = void.
 * Keeping this as data makes future map maintenance a content-only change.
 */
export const legacyDemoMap = {
  id: 1001,
  author: "maker",
  columns: 9,
  // Oil fields replace the two marked plain cells from the preview: (row 2, column 6)
  // and (row 6, column 1), using the same row-major coordinates as the old map.
  terrain: "MMMMMMMPVPSMOOMOMPMOOMMOFMVPMOSMPOMPPMMPPMMPVPMOPMSOMPMFOMMOOMVPMOMOOMSPPMMMMMMMV",
  soldiers: [
    // [row-major index, legacy player number, strength]
    [10, 0, 2],
    [11, 0, 1],
    [30, 1, 1],
    [50, 0, 1],
    [69, 1, 1],
    [70, 1, 2],
    [79, 1, 1]
  ] as const
} as const;

export type LegacyDemoMap = typeof legacyDemoMap;
