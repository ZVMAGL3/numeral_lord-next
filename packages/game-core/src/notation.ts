import type { HexCoordinate } from "./state.js";

/** Replay-friendly tuple: row, column, then how many actual clicks it represents. */
export type NotationTuple = readonly [row: number, column: number, clickCount: number];

/**
 * The kind is local recording metadata, not part of the exported tuple format.
 * It prevents a reinforcement entry from being confused with a move target that
 * happens to have the same coordinate.
 */
export interface NotationEntry {
  readonly tuple: NotationTuple;
  readonly kind: "action-source" | "action-target" | "reinforcement" | "phase-end";
  /** The next selected unit may be elsewhere than the action target (for artillery). */
  readonly continuation?: readonly [row: number, column: number];
}

export function appendActionNotation(
  entries: readonly NotationEntry[],
  source: HexCoordinate,
  target: HexCoordinate,
  continuation?: HexCoordinate,
  includeSourceClick = true
): readonly NotationEntry[] {
  const targetEntry: NotationEntry = {
    kind: "action-target",
    tuple: toSingleClickTuple(target),
    ...(continuation ? { continuation: [continuation.row, continuation.column] as const } : {})
  };
  return includeSourceClick
    ? [...entries, { kind: "action-source", tuple: toSingleClickTuple(source) }, targetEntry]
    : [...entries, targetEntry];
}

/**
 * Several uninterrupted points allocated to the same cell are one notation
 * entry. It records the number of actual point-allocation clicks, not a global
 * sequence number. Automatic continuation is likewise never represented as a
 * source click.
 */
export function appendReinforcementNotation(
  entries: readonly NotationEntry[],
  coordinate: HexCoordinate,
  clickCount: number
): readonly NotationEntry[] {
  if (clickCount < 1) return entries;
  const previous = entries.at(-1);
  if (previous?.kind === "reinforcement"
    && previous.tuple[0] === coordinate.row
    && previous.tuple[1] === coordinate.column) {
    return [
      ...entries.slice(0, -1),
      {
        kind: "reinforcement",
        tuple: [coordinate.row, coordinate.column, previous.tuple[2] + clickCount]
      }
    ];
  }
  return [...entries, { kind: "reinforcement", tuple: [coordinate.row, coordinate.column, clickCount] }];
}

export function appendPhaseEndNotation(
  entries: readonly NotationEntry[],
  phase: "action" | "reinforcement"
): readonly NotationEntry[] {
  return [...entries, {
    kind: "phase-end",
    tuple: [-1, -1, phase === "action" ? -1 : -2]
  }];
}

function toSingleClickTuple(coordinate: HexCoordinate): NotationTuple {
  return [coordinate.row, coordinate.column, 1];
}
