import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_CODE, createMatchFromMapCode } from "@numeral-lord/core-content";
import { installedMapCatalogs } from "./installed-content.js";
import { toNetworkPayload } from "./network-payload.js";

describe("Colyseus network payload normalization", () => {
  it("converts null-prototype Mod settings throughout a game snapshot", () => {
    const game = createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs);
    expect(Object.getPrototypeOf(game.settings.modSettings)).toBeNull();

    const payload = toNetworkPayload({ state: game, clock: { startedAtEpochMs: 1 } });

    expect(Object.getPrototypeOf(payload.state.settings.modSettings)).toBe(Object.prototype);
    expect(typeof payload.state.settings.modSettings?.hasOwnProperty).toBe("function");
    expect(Object.getPrototypeOf(payload.state.settings.terrainCapabilityOverrides)).toBe(Object.prototype);
  });

  it("normalizes nested records and arrays without changing primitive values", () => {
    const payload = toNetworkPayload({ values: [Object.assign(Object.create(null), { count: 2 })] });

    expect(payload).toEqual({ values: [{ count: 2 }] });
    expect(typeof payload.values[0]?.hasOwnProperty).toBe("function");
  });
});
