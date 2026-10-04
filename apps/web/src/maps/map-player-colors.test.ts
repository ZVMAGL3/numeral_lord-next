import { describe, expect, it } from "vitest";
import { changeSeatColor } from "./map-player-colors.js";

describe("map player color editing", () => {
  it("uses an unused custom color without changing other seats", () => {
    expect(changeSeatColor(["#BB5F5F", "#7BBB5E"], 0, "#123abc")).toEqual(["#123ABC", "#7BBB5E"]);
  });

  it("swaps colors when the selected color belongs to another seat", () => {
    expect(changeSeatColor(["#BB5F5F", "#7BBB5E", "#4769C8"], 0, "#4769c8"))
      .toEqual(["#4769C8", "#7BBB5E", "#BB5F5F"]);
  });

  it("does not mutate source colors or accept invalid input", () => {
    const source = ["#BB5F5F", "#7BBB5E"];
    expect(changeSeatColor(source, 0, "red")).toEqual(source);
    expect(changeSeatColor(source, 4, "#123456")).toEqual(source);
    expect(source).toEqual(["#BB5F5F", "#7BBB5E"]);
  });
});
