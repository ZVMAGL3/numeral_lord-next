import { describe, expect, it } from "vitest";
import {
  appendActionNotation,
  appendPhaseEndNotation,
  appendReinforcementNotation
} from "./notation.js";

describe("chess notation", () => {
  it("records an accepted action as one source click and one target click", () => {
    const notation = appendActionNotation(
      [],
      { row: 3, column: 1 },
      { row: 2, column: 1 },
      { row: 2, column: 1 }
    );

    expect(notation.map((entry) => entry.tuple)).toEqual([[3, 1, 1], [2, 1, 1]]);
    expect(notation.at(-1)?.continuation).toEqual([2, 1]);
  });

  it("does not invent a source click for an automatically continued action", () => {
    const firstAction = appendActionNotation(
      [],
      { row: 3, column: 1 },
      { row: 2, column: 1 },
      { row: 2, column: 1 }
    );
    const continuedAction = appendActionNotation(
      firstAction,
      { row: 2, column: 1 },
      { row: 2, column: 2 },
      { row: 2, column: 2 },
      false
    );

    expect(continuedAction.map((entry) => entry.tuple)).toEqual([
      [3, 1, 1], [2, 1, 1], [2, 2, 1]
    ]);
  });

  it("coalesces only consecutive reinforcement clicks for the same cell", () => {
    const afterAction = appendActionNotation([], { row: 3, column: 1 }, { row: 2, column: 1 });
    const firstAllocation = appendReinforcementNotation(afterAction, { row: 2, column: 1 }, 1);
    const repeatedAllocation = appendReinforcementNotation(firstAllocation, { row: 2, column: 1 }, 4);
    const anotherCell = appendReinforcementNotation(repeatedAllocation, { row: 1, column: 2 }, 2);
    const ended = appendPhaseEndNotation(anotherCell, "reinforcement");

    expect(ended.map((entry) => entry.tuple)).toEqual([
      [3, 1, 1], [2, 1, 1], [2, 1, 5], [1, 2, 2], [-1, -1, -2]
    ]);
  });
});
