import { DEFAULT_MAP_CODE } from "@numeral-lord/core-content";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { SqliteWorkshopStore, WorkshopInputError, WorkshopStore } from "./workshop.js";

let dataDirectory: string;
let store: WorkshopStore;

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "numeral-workshop-test-"));
  store = new WorkshopStore(dataDirectory);
});

afterEach(async () => {
  const resolvedDirectory = await realpath(dataDirectory);
  const resolvedTemp = await realpath(tmpdir());
  const child = relative(resolve(resolvedTemp), resolve(resolvedDirectory));
  if (!child.startsWith("numeral-workshop-test-") || child.includes("..")) {
    throw new Error("Refusing to remove an unexpected test directory.");
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
});

const exampleModDefinition = {
  id: "mod-oil-field",
  version: "1.0.0",
  capabilities: [{ id: "core/income-source", target: "terrain", defaultConfig: { amount: 0 } }],
  settings: [{
    id: "incomePerTurn", displayName: "每回合收益", kind: "integer", defaultValue: 2, min: 0, max: 20,
    target: { terrainId: "mod/oil-field", capabilityId: "core/income-source", configKey: "amount" }
  }],
  spatialPatterns: [{
    id: "mod-oil-field/wire-network",
    role: "core/powered-units",
    result: { entity: "unit", distinctBy: "id" },
    starts: { op: "terrain-has", capabilityId: "core/power-source" },
    expression: {
      op: "repeat", min: 0, max: 128,
      item: { op: "step", relation: "hex-neighbor", where: { op: "terrain-has", capabilityId: "core/power-conductor" } }
    }
  }],
  rules: [{
    id: "mod-oil-field/field-income",
    trigger: "unit-enter",
    target: { scope: "trigger-unit" },
    conditions: [{ op: "at-cell-matches", predicate: { op: "terrain-has", capabilityId: "core/income-source" } }],
    effects: [{ type: "grant-points", amount: 2 }]
  }],
  terrains: [{
    id: "mod/oil-field",
    displayName: "油田",
    capabilities: [{ id: "core/occupiable" }, { id: "core/income-source", config: { amount: 2 } }]
  }]
};

describe("workshop persistence and data-only Mod objects", () => {
  it("publishes a JSON map without installing its required terrain Mod", async () => {
    const published = await store.publishMap({ code: DEFAULT_MAP_CODE, description: "内置地形示例" }, "地图作者");
    expect(published.kind).toBe("map");

    const catalog = await store.list();
    expect(catalog.maps).toMatchObject([{
      id: published.id,
      mapId: "1001",
      name: "昏晓",
      players: 2,
      requiredTerrainModIds: ["mod-oil-field"],
      authorName: "地图作者"
    }]);
    expect("code" in catalog.maps[0]!).toBe(false);
    const detail = await store.get({ kind: "map", id: published.id });
    expect(detail?.kind).toBe("map");
    if (detail?.kind === "map") expect(JSON.parse(detail.entry.code)).toMatchObject({ name: "昏晓" });

    const persisted = new WorkshopStore(dataDirectory);
    expect((await persisted.list()).maps).toEqual(catalog.maps);
    expect(JSON.parse(await readFile(join(dataDirectory, "workshop.json"), "utf8"))).toMatchObject({ version: 1 });
  });

  it("imports the legacy JSON once and persists the same portable records in local SQLite", async () => {
    await store.publishMap({ code: DEFAULT_MAP_CODE, description: "旧 JSON 地图" }, "旧作者");
    const sqlitePath = join(dataDirectory, "local.sqlite");
    const sqlite = new SqliteWorkshopStore(sqlitePath, dataDirectory);
    try {
      const firstRead = await sqlite.list();
      expect(firstRead.maps).toMatchObject([{ mapId: "1001", name: "昏晓", authorName: "旧作者" }]);
      const customCode = JSON.stringify({ ...(JSON.parse(DEFAULT_MAP_CODE) as object), id: "sqlite-custom-map" });
      await sqlite.publishMap({ code: customCode, description: "本地数据库地图" }, "本地玩家");
    } finally {
      sqlite.close();
    }

    const reopened = new SqliteWorkshopStore(sqlitePath, dataDirectory);
    try {
      expect((await reopened.list()).maps.map((map) => map.name)).toEqual(["昏晓", "昏晓"]);
      await expect(reopened.publishMap({ code: DEFAULT_MAP_CODE, description: "重复" }, "其他作者"))
        .rejects.toThrow(/已经发布/);
    } finally {
      reopened.close();
    }
  });

  it("stores and returns a JSON Mod definition object, without source files", async () => {
    const published = await store.publishTerrainMod({
      name: "油田",
      description: "不导电的资源地块",
      definition: exampleModDefinition
    }, "Mod 作者");
    const catalog = await store.list();
    expect(catalog.terrainMods).toMatchObject([{
      id: published.id,
      modId: "mod-oil-field",
      terrainIds: ["mod/oil-field"],
      authorName: "Mod 作者"
    }]);
    expect("sourceFiles" in catalog.terrainMods[0]!).toBe(false);
    const detail = await store.get({ kind: "terrain-mod", id: published.id });
    if (detail?.kind !== "terrain-mod") throw new Error("Missing Mod detail");
    expect(detail.entry.definition).toEqual(exampleModDefinition);
  });

  it("rejects duplicate, oversized and invalid capability objects", async () => {
    await store.publishMap({ code: DEFAULT_MAP_CODE, description: "" }, "A");
    await expect(store.publishMap({ code: DEFAULT_MAP_CODE, description: "" }, "B"))
      .rejects.toThrow(/已经发布/);
    await expect(store.publishMap({ code: "x".repeat(65_537), description: "" }, "A"))
      .rejects.toBeInstanceOf(WorkshopInputError);
    const mod = {
      name: "油田",
      description: "",
      definition: exampleModDefinition
    };
    await expect(store.publishTerrainMod({ ...mod, definition: { ...exampleModDefinition, terrains: [{ ...exampleModDefinition.terrains[0]!, id: "mod/unrelated" }] } }, "A"))
      .rejects.toThrow(/地块 ID/);
    await expect(store.publishTerrainMod({ ...mod, definition: { ...exampleModDefinition, terrains: [{ ...exampleModDefinition.terrains[0]!, capabilities: [{ id: "mod/execute-script" }] }] } }, "A"))
      .rejects.toThrow(/不支持/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      settings: [{ ...exampleModDefinition.settings[0]!, target: { terrainId: "mod/oil-field", capabilityId: "core/power-conductor", configKey: "amount" } }]
    } }, "A")).rejects.toThrow(/未绑定对应能力/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      spatialPatterns: [{ ...exampleModDefinition.spatialPatterns[0]!, expression: {
        op: "repeat", min: 0, max: 50_000, item: exampleModDefinition.spatialPatterns[0]!.expression
      } }]
    } }, "A")).rejects.toThrow(/重复次数/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      spatialPatterns: [{ ...exampleModDefinition.spatialPatterns[0]!, result: { entity: "unit" } }]
    } }, "A")).rejects.toThrow(/按 ID 去重/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      rules: [{ ...exampleModDefinition.rules[0]!, effects: [{ type: "execute-script", source: "alert(1)" }] }]
    } }, "A")).rejects.toThrow(/不支持的效果/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      rules: [{ ...exampleModDefinition.rules[0]!, target: { scope: "pattern-units", patternId: "mod-oil-field/missing" } }]
    } }, "A")).rejects.toThrow(/规则 ID、触发器、目标或结构无效/);
    await expect(store.publishTerrainMod({ ...mod, definition: { ...exampleModDefinition, terrains: [{ ...exampleModDefinition.terrains[0]!, displayName: "x".repeat(65_537) }] } }, "A"))
      .rejects.toThrow(/64 KiB/);
    await expect(store.publishTerrainMod({ ...mod, definition: undefined }, "A"))
      .rejects.toBeInstanceOf(WorkshopInputError);
    expect((await store.list()).terrainMods).toHaveLength(0);
  });

  it("serializes concurrent publication writes without losing entries", async () => {
    const codes = Array.from({ length: 5 }, (_, index) => {
      const map = JSON.parse(DEFAULT_MAP_CODE) as Record<string, unknown>;
      map.id = `parallel-${index}`;
      return JSON.stringify(map);
    });
    await Promise.all(codes.map((code) => store.publishMap({ code, description: "" }, "A")));
    expect((await store.list()).maps).toHaveLength(5);
    expect((await new WorkshopStore(dataDirectory).list()).maps).toHaveLength(5);
  });
});
