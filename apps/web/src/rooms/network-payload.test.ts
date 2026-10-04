import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import { DEFAULT_MAP_CODE, createMatchFromMapCode } from "@numeral-lord/core-content";
import { installedMapCatalogs } from "../content/installed-content.js";
import { toNetworkGameState, toNetworkPayload } from "./network-payload.js";

describe("Colyseus network payload normalization", () => {
  it("converts null-prototype Mod settings throughout a game snapshot", () => {
    const game = reactive(createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs));
    expect(Object.getPrototypeOf(game.settings.modSettings)).toBeNull();
    expect(() => game.settings.modSettings?.hasOwnProperty("mod/oil-field"))
      .toThrow(/hasOwnProperty is not a function/);

    const payload = toNetworkPayload({ state: game, clock: { startedAtEpochMs: 1 } });

    expect(Object.getPrototypeOf(payload.state.settings.modSettings)).toBe(Object.prototype);
    expect(typeof payload.state.settings.modSettings?.hasOwnProperty).toBe("function");
    expect(Object.getPrototypeOf(payload.state.settings.terrainCapabilityOverrides)).toBe(Object.prototype);
  });

  it("normalizes snapshot settings without cloning the immutable board", () => {
    const game = createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs);
    const payload = toNetworkGameState(game);

    expect(payload).not.toBe(game);
    expect(payload.settings).not.toBe(game.settings);
    expect(payload.cells).toBe(game.cells);
    expect(payload.units).toBe(game.units);
    expect(payload.players).toBe(game.players);
  });

  it("normalizes nested records and arrays without changing primitive values", () => {
    const payload = toNetworkPayload({ values: [Object.assign(Object.create(null), { count: 2 })] });

    expect(payload).toEqual({ values: [{ count: 2 }] });
    expect(typeof payload.values[0]?.hasOwnProperty).toBe("function");
  });

  it("preserves references for ordinary immutable records", () => {
    const snapshot = { sequence: 4, cells: { "0,0": { terrainId: "core/plain" } } };

    expect(toNetworkPayload(snapshot)).toBe(snapshot);
  });

  it("copies only the path leading to null-prototype dictionaries", () => {
    const dictionary = Object.assign(Object.create(null), { count: 3 });
    const untouched = { label: "same reference" };
    const snapshot = { settings: { dictionary }, untouched };
    const payload = toNetworkPayload(snapshot);

    expect(payload).not.toBe(snapshot);
    expect(payload.settings).not.toBe(snapshot.settings);
    expect(payload.settings.dictionary).not.toBe(dictionary);
    expect(payload.untouched).toBe(untouched);
  });
});
