import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeMapCode } from "@numeral-lord/core-content";
import { TEST_MAP_DEFINITION } from "../../../../packages/core-content/test-fixtures/maps.js";
import { runtimeMapCatalogs } from "../content/installed-content.js";
import {
  addMapToLibrary,
  createPersonalMapSyncRequest,
  loadMapLibrary,
  reconcilePersonalMapLibrary,
  removeMapFromLibrary
} from "./map-library.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

const mapCode = serializeMapCode({ ...TEST_MAP_DEFINITION, id: "personal-cache-map", name: "缓存测试地图" }, {
  ...runtimeMapCatalogs,
  allowUnknownTerrainMods: true
});

describe("account-scoped personal map cache", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("keeps account maps cached locally and queues saves/deletes for database sync", () => {
    const firstSave = addMapToLibrary([], mapCode, " ZVMAGL3 ");
    expect(loadMapLibrary("zvmagl3").map((map) => map.definition.id)).toEqual(["personal-cache-map"]);
    const initialSync = createPersonalMapSyncRequest("ZVMAGL3");
    expect(initialSync.cachedMaps).toEqual([{ mapId: "personal-cache-map", code: firstSave[0]!.code }]);
    expect(initialSync.operations).toMatchObject([{ type: "upsert", mapId: "personal-cache-map" }]);

    const synced = reconcilePersonalMapLibrary("ZVMAGL3", {
      userId: "user-1",
      maps: [{ mapId: "personal-cache-map", code: mapCode, updatedAt: "2026-10-05T00:00:00.000Z" }],
      acknowledgedOperationIds: initialSync.operations.map(({ operationId }) => operationId)
    });
    expect(synced.map((map) => map.definition.id)).toEqual(["personal-cache-map"]);
    expect(createPersonalMapSyncRequest("zvmagl3")).toEqual({ cachedMaps: [], operations: [] });
    expect(loadMapLibrary("ZVMAGL4")).toEqual([]);

    removeMapFromLibrary(synced, "personal-cache-map", "ZVMAGL3");
    expect(createPersonalMapSyncRequest("zvmagl3").operations).toMatchObject([
      { type: "delete", mapId: "personal-cache-map" }
    ]);
  });

  it("migrates the previous browser-wide cache into the first selected account once", () => {
    localStorage.setItem("numeral-lord.map-library.v1", JSON.stringify([mapCode]));

    expect(loadMapLibrary("ZVMAGL3").map((map) => map.definition.id)).toEqual(["personal-cache-map"]);
    expect(localStorage.getItem("numeral-lord.map-library.v1")).toBeNull();
    expect(loadMapLibrary("ZVMAGL4")).toEqual([]);
  });
});
