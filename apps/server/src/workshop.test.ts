import { DEFAULT_MAP_CODE } from "@numeral-lord/core-content";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { WorkshopInputError, WorkshopStore } from "./workshop.js";

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

describe("workshop persistence and inert previews", () => {
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

  it("keeps a Mod as source text only, without evaluating it", async () => {
    const source = "throw new Error('This source must never run');";
    const published = await store.publishTerrainMod({
      id: "mod-oil-field",
      name: "油田",
      version: "1.0.0",
      description: "不导电的资源地块",
      terrainIds: ["mod/oil-field"],
      sourceFiles: [{ path: "src/index.ts", content: source }]
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
    expect(detail.entry.sourceFiles[0]?.content).toBe(source);
  });

  it("rejects duplicate and oversized submissions, unsafe paths and mismatched terrain IDs", async () => {
    await store.publishMap({ code: DEFAULT_MAP_CODE, description: "" }, "A");
    await expect(store.publishMap({ code: DEFAULT_MAP_CODE, description: "" }, "B"))
      .rejects.toThrow(/已经发布/);
    await expect(store.publishMap({ code: "x".repeat(65_537), description: "" }, "A"))
      .rejects.toBeInstanceOf(WorkshopInputError);
    const mod = {
      id: "mod-oil-field",
      name: "油田",
      version: "1.0.0",
      description: "",
      terrainIds: ["mod/oil-field"],
      sourceFiles: [{ path: "src/index.ts", content: "export default 1;" }]
    };
    await expect(store.publishTerrainMod({ ...mod, terrainIds: ["mod/unrelated"] }, "A"))
      .rejects.toThrow(/属于该 Mod/);
    await expect(store.publishTerrainMod({ ...mod, sourceFiles: [{ path: "../escape.ts", content: "x" }] }, "A"))
      .rejects.toThrow(/路径无效/);
    await expect(store.publishTerrainMod({ ...mod, sourceFiles: [{ path: "src/index.ts", content: "x".repeat(65_537) }] }, "A"))
      .rejects.toThrow(/64 KiB/);
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
