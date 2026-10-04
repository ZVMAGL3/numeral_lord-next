import { describe, expect, it } from "vitest";
import { getLobbyPreviewPlayerColors } from "./lobby-preview.js";

describe("lobby map preview player colors", () => {
  it("reflects the selected color for each participating seat", () => {
    expect(getLobbyPreviewPlayerColors([
      { participating: true, seat: 1, playerColorId: "legacy-1" },
      { participating: true, seat: 2, playerColorId: "legacy-3" }
    ])).toEqual({ "player-1": "#BB5F5F", "player-2": "#4769C8" });
  });

  it("does not apply colors from spectators or unassigned players", () => {
    expect(getLobbyPreviewPlayerColors([
      { participating: false, seat: 2, playerColorId: null },
      { participating: true, seat: null, playerColorId: "legacy-3" },
      { participating: true, seat: 3, playerColorId: "unknown-color" }
    ])).toEqual({});
  });
});
