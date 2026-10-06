import { describe, expect, it } from "vitest";
import { computed } from "vue";
import type { TerrainModDefinition } from "@numeral-lord/content-schema";
import { coreTerrainCatalog, createMatchFromMapCode, parseMapCode, serializeMapCode } from "@numeral-lord/core-content";
import { TEST_MAP_DEFINITION } from "../../../../packages/core-content/test-fixtures/maps.js";
import {
  loadedTerrainCatalog,
  loadedTerrainModIds,
  loadedTerrainMods,
  loadedTerrainCatalogRevision,
  registerServerTerrainModDefinition,
  resolveMapCatalogs,
  terrainVisualAssetsForCatalogs
} from "./installed-content.js";

function terrainMod(id: string, version: string, displayName: string): TerrainModDefinition {
  const slug = id.slice(4);
  return {
    id,
    version,
    capabilities: [],
    terrain: { capabilities: [{ id: "core/occupiable" }] }
  };
}

function mapCodeFor(mod: TerrainModDefinition, id: string): string {
  const terrain = { ...mod.terrain, id: `mod/${mod.id.slice(4)}`, displayName: "" };
  const runtimeMod = { ...mod, terrain, units: [], commandRules: [], victoryConditions: [] };
  const code = serializeMapCode({
    ...TEST_MAP_DEFINITION,
    id,
    terrainLegend: { ...TEST_MAP_DEFINITION.terrainLegend, X: terrain.id },
    requiredTerrainModIds: [mod.id]
  }, {
    terrains: { ...coreTerrainCatalog, [terrain.id]: terrain },
    terrainModIds: { [terrain.id]: mod.id },
    mods: { [mod.id]: runtimeMod }
  });
  return code;
}

describe("map Mod dependency release resolution", () => {
  it("starts with only core terrain and no bundled Mods", () => {
    expect(loadedTerrainMods).toEqual([]);
    expect(Object.keys(loadedTerrainModIds)).toEqual([]);
    expect(loadedTerrainCatalog["mod/oil-field"]).toBeUndefined();
    expect(loadedTerrainCatalog["core/plain"]).toEqual(coreTerrainCatalog["core/plain"]);
  });

  it("passes artwork from a Mod explicitly present in the resolved catalog", () => {
    const assetUrl = "data:image/svg+xml;base64,PHN2Zy8+";
    const catalogs = {
      mods: {
        "mod-oil-field": {
          id: "mod-oil-field",
          terrain: {
            id: "mod/oil-field",
            visuals: { baseColor: "#475569", overlay: { assetId: "oil-art", scale: 1, opacity: 1, offsetX: 0, offsetY: 0 } }
          },
          visualAssets: [{ id: "oil-art", dataUrl: assetUrl }]
        }
      }
    } as unknown as Parameters<typeof terrainVisualAssetsForCatalogs>[0];
    expect(terrainVisualAssetsForCatalogs(catalogs)).toEqual({ "mod/oil-field": { "oil-art": assetUrl } });
  });

  it("invalidates map preview catalogs after an asynchronously fetched Mod registers", () => {
    const mod = terrainMod("mod-reactive-preview", "1.0.0", "异步地块");
    const code = mapCodeFor(mod, "map-reactive-preview");
    const previewMod = computed(() => {
      void loadedTerrainCatalogRevision.value;
      return resolveMapCatalogs(code)?.mods?.[mod.id];
    });

    expect(previewMod.value).toBeUndefined();
    registerServerTerrainModDefinition(mod, "异步地块");
    expect(previewMod.value?.version).toBe(mod.version);
  });

  it("keeps map Mods as external dependencies instead of preinstalling them", () => {
    const code = JSON.stringify({
      version: 1,
      id: "external-mod-map",
      name: "外部 Mod 地图",
      columns: 4,
      terrain: "ABCD",
      terrainLegend: { A: "core/plain", B: "mod/decay-terrain", C: "mod/oil-field", D: "core/void" },
      requiredTerrainModIds: ["mod-oil-field", "mod-decay-terrain"],
      players: 2,
      soldiers: [],
      teams: [1, 2],
      matchConditionIds: []
    });
    const catalogs = resolveMapCatalogs(code);
    expect(catalogs?.mods).toEqual({});
    expect(catalogs?.terrains?.["mod/oil-field"]).toBeUndefined();
    expect(parseMapCode(code, catalogs!).requiredTerrainModIds).toEqual(["mod-oil-field", "mod-decay-terrain"]);
  });

  it("uses the currently loaded server definition regardless of an old room release hint", () => {
    const oldRelease = terrainMod("mod-map-pin-history", "1.0.0", "旧版地块");
    const currentRelease = terrainMod("mod-map-pin-history", "2.0.0", "新版地块");
    const code = mapCodeFor(oldRelease, "map-pinned-old-release");
    registerServerTerrainModDefinition(oldRelease, "旧版地块");
    registerServerTerrainModDefinition(currentRelease, "新版地块");

    const catalogs = resolveMapCatalogs(code);
    expect(catalogs?.mods?.[oldRelease.id]?.version).toBe("2.0.0");
    expect(createMatchFromMapCode(code, catalogs!).cells).toBeDefined();
  });

  it("does not gate a map on a legacy release pin when the current server definition is loaded", () => {
    const hostRelease = terrainMod("mod-map-pin-missing", "1.0.0", "房主版本");
    const currentRelease = terrainMod("mod-map-pin-missing", "2.0.0", "本机版本");
    const code = mapCodeFor(hostRelease, "map-host-release-missing");
    registerServerTerrainModDefinition(currentRelease, "服务器当前地块");

    const catalogs = resolveMapCatalogs(code);
    expect(catalogs?.mods?.[hostRelease.id]?.version).toBe("2.0.0");
    expect(createMatchFromMapCode(code, catalogs!).cells).toBeDefined();
  });

  it("ignores legacy map locks and still infers the Mod ID when older maps omitted the dependency list", () => {
    const mod = terrainMod("mod-map-pin-legacy", "1.0.0", "旧地图地块");
    const nextRelease = terrainMod("mod-map-pin-legacy", "2.0.0", "更新地块");
    registerServerTerrainModDefinition(mod, "旧地图地块");
    registerServerTerrainModDefinition(nextRelease, "更新地块");
    const oldCode = JSON.parse(mapCodeFor(mod, "map-with-inferred-mod")) as Record<string, unknown>;
    delete oldCode.requiredTerrainModIds;
    oldCode.requiredTerrainModLocks = [{ id: mod.id, version: mod.version, contentHash: `sha256:${"0".repeat(64)}` }];
    const code = JSON.stringify(oldCode);
    const catalogs = resolveMapCatalogs(code);
    expect(catalogs?.mods?.[mod.id]?.version).toBe(nextRelease.version);
    expect(createMatchFromMapCode(code, catalogs!).cells).toBeDefined();
  });

  it("keeps legacy maps without explicit dependency lists working through terrain inference", () => {
    const mod = terrainMod("mod-map-pin-inferred-legacy", "1.0.0", "旧地图地块");
    registerServerTerrainModDefinition(mod, "旧地图地块");
    const oldCode = JSON.parse(mapCodeFor(mod, "map-with-inferred-mod")) as Record<string, unknown>;
    delete oldCode.requiredTerrainModIds;
    delete oldCode.requiredTerrainModLocks;
    const code = JSON.stringify(oldCode);
    const catalogs = resolveMapCatalogs(code);
    expect(catalogs?.mods?.[mod.id]?.version).toBe(mod.version);
    expect(createMatchFromMapCode(code, catalogs!).cells).toBeDefined();
  });
});
