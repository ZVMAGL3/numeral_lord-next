import { DEFAULT_MAP_CODE } from "@numeral-lord/core-content";
import type { TerrainModDefinition } from "@numeral-lord/content-schema";
import { decayTerrainMod } from "@numeral-lord/decay-terrain-mod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkshopStore, WorkshopInputError, WorkshopStore } from "./workshop.js";
import { persistTerrainVisualAssets } from "./workshop-assets.js";

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
    target: { capabilityId: "core/income-source", configKey: "amount" }
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
  visualAssets: [{ id: "base-image", dataUrl: makePngHeader(32, 32) }],
  terrain: {
    capabilities: [{ id: "core/occupiable" }, { id: "core/income-source", config: { amount: 2 } }],
    visuals: { baseColor: "#638f67", baseAssetId: "base-image" }
  }
};

describe("workshop persistence and data-only Mod objects", () => {
  it("keeps stronghold suppression system-managed instead of publishable as a general terrain feature", async () => {
    const linkedTerrain = withBaseLayer({
      ...exampleModDefinition,
      terrain: { ...exampleModDefinition.terrain, capabilities: [...exampleModDefinition.terrain.capabilities, { id: "core/adjacent-hostile-exhaustion" }] }
    } as unknown as TerrainModDefinition);
    await expect(store.publishTerrainMod({ name: "误用据点压制", description: "", definition: linkedTerrain }, "作者"))
      .rejects.toThrow("据点压制由系统固定绑定在据点上，并自动作用于周围六格");

    const declaredCapability = withBaseLayer({
      ...exampleModDefinition,
      capabilities: [...exampleModDefinition.capabilities, {
        id: "core/adjacent-hostile-exhaustion", target: "terrain", defaultConfig: {}
      }]
    } as unknown as TerrainModDefinition);
    await expect(store.publishTerrainMod({ name: "误用据点压制", description: "", definition: declaredCapability }, "作者"))
      .rejects.toThrow("据点压制由系统固定绑定在据点上，并自动作用于周围六格");
  });

  it("accepts spatial zones with boundary-only enter or leave reactions", async () => {
    const zonePatternId = "mod-oil-field/outer-two-rings";
    const definition = withBaseLayer({
      ...exampleModDefinition,
      capabilities: [...exampleModDefinition.capabilities, {
        id: "mod/oil-field/zone-source", target: "terrain", defaultConfig: {}
      }],
      spatialPatterns: [{
        id: zonePatternId,
        starts: { op: "all", items: [
          { op: "terrain-has", capabilityId: "mod/oil-field/zone-source" },
          { op: "unit-team-is", team: "other" }
        ] },
        expression: {
          op: "hex-range", min: 1, max: 2,
          where: { op: "cell-exists" }
        },
        result: { entity: "cell" },
        excludeStarts: true
      }],
      rules: [{
        id: "mod-oil-field/exhaust-when-leaving-zone",
        trigger: "unit-leave",
        target: { scope: "trigger-unit" },
        conditions: [{ op: "crosses-pattern-boundary", patternId: zonePatternId, direction: "leave" }],
        effects: [{ type: "exhaust-unit" }]
      }],
      terrain: { ...exampleModDefinition.terrain, capabilities: [...exampleModDefinition.terrain.capabilities, { id: "mod/oil-field/zone-source" }] }
    } as unknown as TerrainModDefinition);

    const published = await store.publishTerrainMod({ name: "外围压制", description: "只在离开区域时失活。", definition }, "作者");
    const detail = await store.get({ kind: "terrain-mod", id: published.id });
    if (detail?.kind !== "terrain-mod" || !detail.entry.definition) throw new Error("Missing spatial zone Mod detail");
    expect(detail.entry.definition.rules).toMatchObject([{
      trigger: "unit-leave",
      conditions: [{ op: "crosses-pattern-boundary", patternId: zonePatternId, direction: "leave" }]
    }]);
    expect(detail.entry.definition.spatialPatterns?.[0]).toMatchObject({
      expression: { op: "hex-range", min: 1, max: 2 }, excludeStarts: true
    });
  });

  it("accepts a namespaced Mod capability and persists its rule object for workshop installation", async () => {
    const published = await store.publishTerrainMod({
      name: "衰蚀地",
      description: "单位在所属玩家回合开始时，若位于衰蚀地，兵力减少 1。",
      definition: withBaseLayer(decayTerrainMod as unknown as TerrainModDefinition)
    }, "Numeral Lord");
    expect((await store.list()).terrainMods).toMatchObject([{
      id: published.id,
      modId: "mod-decay-terrain",
      name: "衰蚀地",
      terrainId: "mod/decay-terrain"
    }]);
    const detail = await store.get({ kind: "terrain-mod", id: published.id });
    if (detail?.kind !== "terrain-mod") throw new Error("Missing decay Mod detail");
    expect(detail.entry.definition).toMatchObject({
      id: "mod-decay-terrain",
      terrain: { capabilities: expect.arrayContaining([{ id: "core/power-conductor" }]) },
      rules: [{ trigger: "turn-start", target: { owner: "actor" }, effects: [{ type: "change-strength", amount: -1 }] }]
    });
  });

  it("stores artwork separately and returns only URLs for referenced preview assets", async () => {
    const topLayer = { id: "top-layer", dataUrl: makePngHeader(32, 32) };
    const unusedAsset = { id: "unused-art", dataUrl: makePngHeader(32, 32) };
    const definition = {
      ...exampleModDefinition,
      visualAssets: [...exampleModDefinition.visualAssets, topLayer, unusedAsset],
      terrain: {
        ...exampleModDefinition.terrain,
        visuals: { ...exampleModDefinition.terrain.visuals, overlay: { assetId: topLayer.id, scale: 0.8, opacity: 0.75, offsetX: 0, offsetY: -0.1 } }
      }
    } as unknown as TerrainModDefinition;

    await store.publishTerrainMod({ name: "叠层预览", description: "目录卡片带顶部图层", definition }, "作者");

    const summary = (await store.list()).terrainMods[0]!;
    expect("preview" in summary).toBe(false);
    const preview = await store.getTerrainModPreview(summary.id);
    expect(preview).toMatchObject({
      id: summary.id,
      preview: {
        terrainId: "mod/oil-field",
        displayName: "叠层预览",
        visuals: { baseAssetId: "base-image", overlay: { assetId: "top-layer", scale: 0.8 } },
        visualAssets: [{ id: "base-image" }, { id: "top-layer" }]
      }
    });
    expect(preview?.preview.visualAssets.map(({ id }) => id)).not.toContain("unused-art");
    expect(preview?.preview.visualAssets.every(({ url }) => /^assets\/terrain\/[a-f0-9]{64}\.png$/.test(url))).toBe(true);
    const storedDatabase = JSON.parse(await readFile(join(dataDirectory, "workshop.json"), "utf8")) as unknown;
    expect(JSON.stringify(storedDatabase)).not.toContain("data:image/");
    const imageUrl = preview!.preview.visualAssets[0]!.url;
    const imageBytes = await readFile(join(dataDirectory, imageUrl));
    expect(imageBytes.toString("base64")).toBe(topLayer.dataUrl.slice(topLayer.dataUrl.indexOf(",") + 1));
    const detail = await store.get({ kind: "terrain-mod", id: summary.id });
    const detailAssets = detail?.kind === "terrain-mod" ? detail.entry.definition?.visualAssets : undefined;
    expect(detailAssets?.find(({ id }) => id === "base-image")?.url).toContain("assets/terrain/");
    expect(detailAssets?.every((asset) => !("dataUrl" in asset))).toBe(true);
    expect(await store.getTerrainModPreview("missing-publication")).toBeUndefined();
  });

  it("rejects the removed multi-terrain definition format", async () => {
    const definition = {
      ...exampleModDefinition,
      terrains: [exampleModDefinition.terrain, exampleModDefinition.terrain]
    } as unknown as TerrainModDefinition;
    await expect(store.publishTerrainMod({ name: "多地块 SVG", description: "", definition }, "作者"))
      .rejects.toThrow("地块 Mod 必须提交仅包含受支持字段的结构化 definition 对象。");
  });

  it("does not use detached card artwork as a second source for terrain previews", async () => {
    const { visualAssets: _inlineAssets, ...definition } = exampleModDefinition;
    const artworkUrl = `assets/terrain/${"a".repeat(64)}.svg`;
    const entry = {
      id: "curated-preview-release",
      modId: "mod-oil-field",
      name: "油田",
      version: "1.0.0",
      description: "预览 artwork",
      terrainId: "mod/oil-field",
      authorName: "Numeral Lord",
      createdAt: new Date(0).toISOString(),
      definition,
      previewArtworkUrls: { "mod/oil-field": artworkUrl }
    };
    await writeFile(join(dataDirectory, "workshop.json"), JSON.stringify({ version: 1, maps: [], terrainMods: [entry] }));
    store = new WorkshopStore(dataDirectory);

    const [summary] = (await store.list()).terrainMods;
    expect(summary).not.toHaveProperty("previewArtworkUrls");
    expect(await store.getTerrainModPreview(entry.id)).toMatchObject({
      id: entry.id,
      preview: { terrainId: "mod/oil-field", visuals: { baseAssetId: "base-image" }, visualAssets: [] }
    });
    expect(await store.get({ kind: "terrain-mod", id: entry.id })).not.toHaveProperty("entry.previewArtworkUrls");
  });

  it("资源迁移不会改变地块 Mod 发布内容或自动创建新版本", async () => {
    const sourceAssets = await persistTerrainVisualAssets([
      ...exampleModDefinition.visualAssets,
      { id: "card-art", dataUrl: makeSvgDataUrl() }
    ], dataDirectory);
    const { visualAssets: _inlineAssets, ...withoutInlineAssets } = exampleModDefinition;
    const { visuals: _oldVisuals, ...terrainWithoutVisuals } = withoutInlineAssets.terrain;
    const definition = {
      ...withoutInlineAssets,
      terrain: terrainWithoutVisuals
    };
    const entry = {
      id: "legacy-preview-release",
      modId: exampleModDefinition.id,
      name: "油田",
      version: exampleModDefinition.version,
      description: "历史卡片图",
      terrainId: "mod/oil-field",
      authorName: "作者",
      createdAt: new Date(0).toISOString(),
      definition,
      visualAssetUrls: Object.fromEntries(sourceAssets.map(({ id, url }) => [id, url])),
      previewArtworkUrls: { "mod/oil-field": sourceAssets.find(({ id }) => id === "card-art")!.url }
    };
    await writeFile(join(dataDirectory, "workshop.json"), JSON.stringify({ version: 1, maps: [], terrainMods: [entry] }));

    const sqlite = new SqliteWorkshopStore(join(dataDirectory, "migration.sqlite"), dataDirectory);
    try {
      const catalog = await sqlite.list();
      expect(catalog.terrainMods.map(({ version }) => version)).toEqual(["1.0.0"]);
      expect(catalog.terrainMods[0]?.id).toBe("legacy-preview-release");
      const detail = await sqlite.get({ kind: "terrain-mod", id: "legacy-preview-release" });
      if (detail?.kind !== "terrain-mod" || !detail.entry.definition) throw new Error("Missing original Mod release");
      expect(detail.entry.version).toBe("1.0.0");
      expect(detail.entry.definition.terrain.visuals).toBeUndefined();
      expect(detail.entry.definition.visualAssets).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("启动时保留已有发布记录，不回写过去的地块视觉定义", async () => {
    const cardArtDataUrl = makeSvgDataUrl();
    const sourceAssets = await persistTerrainVisualAssets([
      ...exampleModDefinition.visualAssets,
      { id: "card-art", dataUrl: cardArtDataUrl }
    ], dataDirectory);
    const cardArtUrl = sourceAssets.find(({ id }) => id === "card-art")!.url;
    const cardArtBytes = Buffer.from(cardArtDataUrl.split(",")[1]!, "base64");
    const cardArtId = `art-${createHash("sha256").update(cardArtBytes).digest("hex").slice(0, 28)}`;
    const { visualAssets: _inlineAssets, ...withoutInlineAssets } = exampleModDefinition;
    const { visuals: _oldVisuals, ...terrainWithoutVisuals } = withoutInlineAssets.terrain;
    const legacyDefinition = {
      ...withoutInlineAssets,
      terrain: terrainWithoutVisuals
    };
    const brokenDefinition = {
      ...withoutInlineAssets,
      version: "1.0.1",
      terrain: {
        ...terrainWithoutVisuals,
        visuals: {
          baseColor: "#475569",
          overlay: { assetId: cardArtId, scale: 1, opacity: 1, offsetX: 0, offsetY: 0 }
        }
      }
    };
    const entries = [
      {
        id: "old-card-preview",
        modId: exampleModDefinition.id,
        name: "油田",
        version: "1.0.0",
        description: "历史卡片图",
        terrainId: "mod/oil-field",
        authorName: "作者",
        createdAt: new Date(0).toISOString(),
        definition: legacyDefinition,
        previewArtworkUrls: { "mod/oil-field": cardArtUrl }
      },
      {
        id: "bad-overlay-migration",
        modId: exampleModDefinition.id,
        name: "油田",
        version: "1.0.1",
        description: "旧迁移生成的错误叠层",
        terrainId: "mod/oil-field",
        authorName: "作者",
        createdAt: new Date(1).toISOString(),
        definition: brokenDefinition,
        visualAssetUrls: Object.fromEntries(sourceAssets.map(({ id, url }) => [id === "card-art" ? cardArtId : id, url]))
      }
    ];
    await writeFile(join(dataDirectory, "workshop.json"), JSON.stringify({ version: 1, maps: [], terrainMods: entries }));

    const databasePath = join(dataDirectory, "migration.sqlite");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`CREATE TABLE nl_schema_migrations (name TEXT PRIMARY KEY, completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO nl_schema_migrations (name) VALUES ('terrain_mod_preview_artwork_to_visual_assets_v1');`);
    legacyDatabase.close();

    const sqlite = new SqliteWorkshopStore(databasePath, dataDirectory);
    try {
      const catalog = await sqlite.list();
      expect(catalog.terrainMods.map(({ version }) => version).sort()).toEqual(["1.0.0", "1.0.1"]);
      const detail = await sqlite.get({ kind: "terrain-mod", id: "bad-overlay-migration" });
      if (detail?.kind !== "terrain-mod" || !detail.entry.definition) throw new Error("Missing original Mod release");
      expect(detail.entry.version).toBe("1.0.1");
      expect(detail.entry.definition.terrain.visuals?.baseColor).toBe("#475569");
      expect(detail.entry.definition.terrain.visuals?.baseAssetId).toBeUndefined();
      expect(detail.entry.definition.terrain.visuals?.overlay).toEqual(
        { assetId: cardArtId, scale: 1, opacity: 1, offsetX: 0, offsetY: 0 }
      );
    } finally {
      sqlite.close();
    }
  });

  it("不会从历史图案推断或生成作者未发布的新版本", async () => {
    const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="116" viewBox="0 0 100 116"><rect width="100" height="116" fill="#a67a49"/><path d="M50 19 32 74" fill="none" stroke="#f6c56d" stroke-width="3"/></svg>`;
    const sourceDataUrl = `data:image/svg+xml;base64,${Buffer.from(sourceSvg).toString("base64")}`;
    const assets = await persistTerrainVisualAssets([
      { id: "base-image", dataUrl: sourceDataUrl },
      { id: "authored-accent", dataUrl: makeSvgDataUrl() }
    ], dataDirectory);
    const sourceUrl = assets.find(({ id }) => id === "base-image")!.url;
    const authoredAccentUrl = assets.find(({ id }) => id === "authored-accent")!.url;
    const records = [
      { modId: "mod-oil-field", version: "0.1.3", terrainId: "mod/oil-field", name: "油田" },
      { modId: "mod-decay-terrain", version: "0.3.3", terrainId: "mod/decay-terrain", name: "衰蚀地" }
    ].map(({ modId, version, terrainId, name }) => ({
      id: `bad-${modId}`,
      modId,
      name,
      version,
      description: "完整底图被错误叠加到棋子上",
      authorName: "Numeral Lord",
      createdAt: new Date(0).toISOString(),
      terrainId,
      definition: {
        id: modId,
        version,
        capabilities: [],
        terrain: {
          capabilities: [{ id: "core/occupiable" }],
          visuals: {
            baseColor: "#475569",
            baseAssetId: "base-image",
            overlay: { assetId: "authored-accent", scale: 0.5, opacity: 0.7, offsetX: 0, offsetY: 0 }
          }
        }
      },
      visualAssetUrls: {
        "base-image": sourceUrl,
        "authored-accent": authoredAccentUrl
      }
    }));
    await writeFile(join(dataDirectory, "workshop.json"), JSON.stringify({ version: 1, maps: [], terrainMods: records }));

    const sqlite = new SqliteWorkshopStore(join(dataDirectory, "accent-migration.sqlite"), dataDirectory);
    try {
      const catalog = await sqlite.list();
      expect(catalog.terrainMods).toHaveLength(2);
      expect(catalog.terrainMods.map(({ version }) => version).sort()).toEqual(["0.1.3", "0.3.3"]);
      for (const original of records) {
        const detail = await sqlite.get({ kind: "terrain-mod", id: `bad-${original.modId}` });
        if (detail?.kind !== "terrain-mod" || !detail.entry.definition) throw new Error(`Missing ${original.name} release`);
        const terrain = detail.entry.definition.terrain;
        expect(detail.entry.version).toBe(original.version);
        expect(terrain.visuals?.baseAssetId).toBe("base-image");
        expect(terrain.visuals?.overlay).toEqual(
          { assetId: "authored-accent", scale: 0.5, opacity: 0.7, offsetX: 0, offsetY: 0 }
        );
        expect((await readFile(join(dataDirectory, "assets", "terrain", sourceUrl.split("/").at(-1)!), "utf8"))).toBe(sourceSvg);
      }
    } finally {
      sqlite.close();
    }
  });

  it("rejects SVG scripts and external resource references", async () => {
    const svgDataUrl = (content: string) => `data:image/svg+xml;base64,${btoa(content)}`;
    await expect(store.publishTerrainMod({ name: "脚本", description: "", definition: {
      ...exampleModDefinition,
      visualAssets: [{ id: "base-image", dataUrl: svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }]
    } }, "作者")).rejects.toThrow(/静态图案/);
    await expect(store.publishTerrainMod({ name: "外链", description: "", definition: {
      ...exampleModDefinition,
      visualAssets: [{ id: "base-image", dataUrl: svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>') }]
    } }, "作者")).rejects.toThrow(/外部资源/);
    await expect(store.publishTerrainMod({ name: "循环引用", description: "", definition: {
      ...exampleModDefinition,
      visualAssets: [{ id: "base-image", dataUrl: svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs><rect id="surface" width="20" height="20" fill="url(#a)"/></svg>') }]
    } }, "作者")).rejects.toThrow(/循环/);
  });

  it("migrates historical inline art out of the workshop database on load", async () => {
    const dataUrl = makePngHeader(32, 32);
    const legacyEntry = {
      id: "legacy-release",
      modId: exampleModDefinition.id,
      name: "旧版油田",
      version: exampleModDefinition.version,
      description: "旧记录",
      authorName: "作者",
      createdAt: new Date().toISOString(),
      terrainId: "mod/oil-field",
      contentHash: "legacy-hash",
      definition: exampleModDefinition
    };
    await writeFile(join(dataDirectory, "workshop.json"), JSON.stringify({
      version: 1,
      maps: [],
      terrainMods: [{ ...legacyEntry, definition: { ...legacyEntry.definition, visualAssets: [{ id: "base-image", dataUrl }] } }]
    }));

    const migratedStore = new WorkshopStore(dataDirectory);
    const detail = await migratedStore.get({ kind: "terrain-mod", id: legacyEntry.id });
    expect(detail?.kind === "terrain-mod" ? detail.entry.definition?.visualAssets?.[0]?.url : undefined)
      .toMatch(/^assets\/terrain\/[a-f0-9]{64}\.png$/);
    expect(await readFile(join(dataDirectory, "workshop.json"), "utf8")).not.toContain("data:image/");
  });

  it("appends immutable releases, only for its author, and requires a newer version", async () => {
    const original = await store.publishTerrainMod({
      name: "衰蚀地", description: "旧版", definition: withBaseLayer(decayTerrainMod as unknown as TerrainModDefinition)
    }, "作者");
    const nextDefinition = withBaseLayer({ ...decayTerrainMod, version: "0.4.0" } as unknown as TerrainModDefinition);
    await expect(store.updateTerrainMod({
      updateId: original.id, name: "腐蚀地", description: "新版", definition: nextDefinition
    }, "冒名者")).rejects.toThrow("只能更新由当前作者发布的 Mod");
    await expect(store.updateTerrainMod({
      updateId: original.id, name: "腐蚀地", description: "旧版本", definition: withBaseLayer(decayTerrainMod as unknown as TerrainModDefinition)
    }, "作者")).rejects.toThrow("更新版本必须高于当前版本");
    const updated = await store.updateTerrainMod({
      updateId: original.id, name: "腐蚀地", description: "新版", definition: nextDefinition
    }, "作者");
    expect(updated).toEqual({ kind: "terrain-mod", id: expect.not.stringMatching(original.id) });
    const catalog = await store.list();
    expect(catalog.terrainMods).toMatchObject([
      { id: updated.id, name: "腐蚀地", version: "0.4.0", description: "新版" },
      { id: original.id, name: "衰蚀地", version: "0.3.1", description: "旧版" }
    ]);
    expect(catalog.terrainMods[0]?.terrainId).toBe("mod/decay-terrain");
    expect(catalog.terrainMods).toHaveLength(2);
    expect(catalog.terrainMods.every((release) => release.contentHash?.startsWith("sha256:") === true)).toBe(true);
    expect((await store.get({ kind: "terrain-mod", id: original.id }))?.kind).toBe("terrain-mod");
    await expect(store.updateTerrainMod({
      updateId: original.id, name: "再次更新", description: "过期页面", definition: withBaseLayer({ ...decayTerrainMod, version: "0.5.0" } as unknown as TerrainModDefinition)
    }, "作者")).rejects.toThrow("当前发布版本已变化");
  });

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
      terrainId: "mod/oil-field",
      authorName: "Mod 作者"
    }]);
    expect("sourceFiles" in catalog.terrainMods[0]!).toBe(false);
    const detail = await store.get({ kind: "terrain-mod", id: published.id });
    if (detail?.kind !== "terrain-mod") throw new Error("Missing Mod detail");
    expect(detail.entry.definition).toMatchObject({
      id: exampleModDefinition.id,
      visualAssets: [{ id: "base-image", url: expect.stringMatching(/^assets\/terrain\/[a-f0-9]{64}\.png$/) }]
    });
  });

  it("validates rule conditions and effect amounts against Mod settings", async () => {
    const definition = {
      ...exampleModDefinition,
      rules: [{
        id: "mod-oil-field/configured-income",
        trigger: "turn-start",
        target: { scope: "trigger-unit" },
        conditions: [{ op: "mod-setting-equals", settingId: "incomePerTurn", value: 3 }],
        effects: [
          { type: "grant-points-from-setting", settingId: "incomePerTurn" },
          { type: "change-strength-from-setting", settingId: "incomePerTurn" }
        ]
      }]
    };
    await store.publishTerrainMod({ name: "设置驱动规则", description: "", definition }, "规则作者");

    await expect(store.publishTerrainMod({ name: "类型错误", description: "", definition: {
      ...definition,
      rules: [{ ...definition.rules[0]!, conditions: [
        { op: "mod-setting-equals", settingId: "incomePerTurn", value: true }
      ] }]
    } }, "规则作者")).rejects.toThrow(/参数不存在，或默认值类型\/选项不匹配/);

    await expect(store.publishTerrainMod({ name: "越界奖励", description: "", definition: {
      ...definition,
      settings: [{ ...definition.settings[0]!, min: 0, max: 101 }],
      rules: definition.rules
    } }, "规则作者")).rejects.toThrow(/点数奖励设置的范围必须在 0 到 100/);
  });

  it("prevents Mod updates from removing settings referenced by existing maps", async () => {
    const original = await store.publishTerrainMod({
      name: "油田", description: "带可配置参数", definition: exampleModDefinition
    }, "参数作者");
    await expect(store.updateTerrainMod({
      updateId: original.id,
      name: "油田",
      description: "删除旧参数",
      definition: { ...exampleModDefinition, version: "99.0.0", settings: [] }
    }, "参数作者")).rejects.toThrow(/不能删除或重定向旧参数/);
  });

  it("validates versioned terrain art assets and includes them in the release hash", async () => {
    const dataUrl = makePngHeader(32, 32);
    const definition = {
      ...exampleModDefinition,
      visualAssets: [{ id: "base-image", dataUrl }, { id: "top-pattern", dataUrl }],
      terrain: {
        ...exampleModDefinition.terrain,
        visuals: {
          baseColor: "#314253",
          baseAssetId: "base-image",
          overlay: { assetId: "top-pattern", scale: 0.8, opacity: 0.7, offsetX: 0, offsetY: -0.1 }
        }
      }
    };
    const published = await store.publishTerrainMod({ name: "纹理地块", description: "带自定义外观", definition }, "美术作者");
    const summary = (await store.list()).terrainMods[0];
    expect(summary?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const detail = await store.get({ kind: "terrain-mod", id: published.id });
    expect(detail?.kind === "terrain-mod" ? detail.entry.definition?.visualAssets : undefined).toHaveLength(2);

    await expect(store.publishTerrainMod({ name: "坏图", description: "", definition: {
      ...definition,
      id: "mod-bad-image",
      visualAssets: [{ id: "base-image", dataUrl: "data:image/png;base64,AAAA" }],
      terrain: definition.terrain
    } }, "作者")).rejects.toThrow(/PNG 图片文件头无效/);
    await expect(store.publishTerrainMod({ name: "缺图", description: "", definition: {
      ...definition,
      id: "mod-missing-image",
      terrain: { ...definition.terrain, visuals: { baseColor: "#314253", baseAssetId: "not-uploaded" } }
    } }, "作者")).rejects.toThrow(/底图颜色或图片引用无效/);
  });

  it("allows exactly one bottom appearance choice while keeping top artwork optional", async () => {
    await expect(store.publishTerrainMod({ name: "缺底图", description: "", definition: {
      ...exampleModDefinition,
      terrain: { ...exampleModDefinition.terrain, visuals: {} }
    } }, "作者")).rejects.toThrow(/纯色、有效图片或透明底/);

    const solidColor = await store.publishTerrainMod({ name: "纯色底", description: "不用图片的纯色地块", definition: {
      ...exampleModDefinition,
      id: "mod-solid-color-base",
      capabilities: [],
      settings: [],
      spatialPatterns: [],
      rules: [],
      visualAssets: [],
      terrain: {
        capabilities: [{ id: "core/occupiable" }],
        visuals: { baseColor: "#638f67" }
      }
    } }, "作者");
    expect(solidColor.kind).toBe("terrain-mod");

    const published = await store.publishTerrainMod({ name: "纯底图", description: "顶部装饰可留空", definition: {
      ...exampleModDefinition,
      id: "mod-base-only",
      capabilities: [],
      settings: [],
      spatialPatterns: [],
      rules: [],
      terrain: {
        capabilities: [{ id: "core/occupiable" }],
        visuals: { baseAssetId: "base-image" }
      }
    } }, "作者");
    expect(published.kind).toBe("terrain-mod");

    const transparent = await store.publishTerrainMod({ name: "透明底", description: "类似虚无地块", definition: {
      ...exampleModDefinition,
      id: "mod-transparent-base",
      capabilities: [],
      settings: [],
      spatialPatterns: [],
      rules: [],
      visualAssets: [],
      terrain: {
        capabilities: [{ id: "core/occupiable" }],
        visuals: { baseTransparent: true }
      }
    } }, "作者");
    expect(transparent.kind).toBe("terrain-mod");

    await expect(store.publishTerrainMod({ name: "冲突图层", description: "", definition: {
      ...exampleModDefinition,
      terrain: { ...exampleModDefinition.terrain, visuals: {
        baseColor: "#638f67", baseTransparent: true, baseAssetId: "base-image"
      } }
    } }, "作者")).rejects.toThrow(/底图颜色或图片引用无效/);
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
    await expect(store.publishTerrainMod({ ...mod, definition: { ...exampleModDefinition, terrain: { ...exampleModDefinition.terrain, id: "mod/unrelated" } } }, "A"))
      .rejects.toThrow(/有效 terrain 对象/);
    await expect(store.publishTerrainMod({ ...mod, definition: { ...exampleModDefinition, terrain: { ...exampleModDefinition.terrain, capabilities: [{ id: "mod/execute-script" }] } } }, "A"))
      .rejects.toThrow(/不支持/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      settings: [{ ...exampleModDefinition.settings[0]!, target: { capabilityId: "core/power-conductor", configKey: "amount" } }]
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
      spatialPatterns: [{ ...exampleModDefinition.spatialPatterns[0]!,
        result: { entity: "unit", distinctBy: "id" }, excludeStarts: true }]
    } }, "A")).rejects.toThrow(/excludeStarts 只能用于格子结果/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      rules: [{ ...exampleModDefinition.rules[0]!, effects: [{ type: "execute-script", source: "alert(1)" }] }]
    } }, "A")).rejects.toThrow(/不支持的效果/);
    await expect(store.publishTerrainMod({ ...mod, definition: {
      ...exampleModDefinition,
      rules: [{ ...exampleModDefinition.rules[0]!, target: { scope: "pattern-units", patternId: "mod-oil-field/missing" } }]
    } }, "A")).rejects.toThrow(/规则 ID、触发器、目标或结构无效/);
    await expect(store.publishTerrainMod({ ...mod, name: "x".repeat(65_537) }, "A"))
      .rejects.toThrow(/Mod 名称无效或过长/);
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

function makePngHeader(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

function svgContent(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M4 28 16 4l12 24z" fill="#d8b77e"/></svg>';
}

function makeSvgDataUrl(): string {
  return `data:image/svg+xml;base64,${btoa(svgContent())}`;
}

function withBaseLayer(definition: TerrainModDefinition): TerrainModDefinition {
  const baseAsset = definition.visualAssets?.find((asset) => asset.id === "base-image")
    ?? { id: "base-image", dataUrl: makePngHeader(32, 32) };
  const visualAssets = definition.visualAssets?.some((asset) => asset.id === baseAsset.id)
    ? [...(definition.visualAssets ?? [])]
    : [...(definition.visualAssets ?? []), baseAsset];
  return {
    id: definition.id,
    version: definition.version,
    capabilities: definition.capabilities,
    ...(definition.settings ? { settings: definition.settings } : {}),
    ...(definition.spatialPatterns ? { spatialPatterns: definition.spatialPatterns } : {}),
    ...(definition.rules ? { rules: definition.rules } : {}),
    visualAssets,
    terrain: {
      capabilities: definition.terrain.capabilities,
      visuals: {
        ...(definition.terrain.visuals ?? {}),
        baseColor: definition.terrain.visuals?.baseColor ?? "#638f67",
        baseAssetId: baseAsset.id
      }
    }
  };
}
