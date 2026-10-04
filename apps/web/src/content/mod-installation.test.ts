import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import type { TerrainModDefinition } from "@numeral-lord/content-schema";
import { oilFieldMod } from "@numeral-lord/oil-field-mod";
import { cloneTerrainModDefinition } from "./mod-installation.js";
import { terrainModDefinitionObject, validateTerrainModObject } from "./installed-content.js";

describe("terrain Mod persistence serialization", () => {
  it("unwraps nested Vue proxies before structured cloning for IndexedDB", () => {
    const definition = reactive({
      id: "mod-test-terrain",
      version: "1.0.0",
      capabilities: [{ id: "mod/test/decay", target: "terrain", defaultConfig: { amount: 1 } }],
      terrain: { capabilities: [{ id: "mod/test/decay", config: { amount: 2 } }] }
    }) as unknown as TerrainModDefinition;

    expect(() => structuredClone(definition)).toThrow();
    const stored = cloneTerrainModDefinition(definition);
    expect(stored).toEqual(definition);
    expect(structuredClone(stored)).toEqual(stored);
    expect(stored.terrain.capabilities[0]?.config).toEqual({ amount: 2 });
  });

  it("rejects malformed or core-overwriting installed Mod terrain objects", () => {
    const valid = {
      id: "mod-test",
      version: "1.0.0",
      capabilities: [{ id: "mod/test/decay", target: "terrain" as const, defaultConfig: { amount: 1 } }],
      terrain: { capabilities: [{ id: "mod/test/decay" }] }
    } as unknown as TerrainModDefinition;
    expect(() => validateTerrainModObject(valid)).not.toThrow();
    expect(() => validateTerrainModObject({
      ...valid,
      terrain: { capabilities: [{ id: "core/plain" }] }
    })).toThrow(/地块绑定了引擎不支持/);
    expect(() => validateTerrainModObject({
      ...valid,
      rules: [{ type: "run-javascript", source: "alert(1)" }]
    } as unknown as TerrainModDefinition)).toThrow(/Mod 规则/);
    expect(() => validateTerrainModObject(terrainModDefinitionObject(oilFieldMod))).not.toThrow();
  });
});
