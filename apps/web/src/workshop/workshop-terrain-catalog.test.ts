import { describe, expect, it } from "vitest";
import { canApplySubscribedModUpdate, latestTerrainModVersions, mapTerrainModUpdateCandidates, mergeWorkshopTerrainCatalog, terrainModUpdateCandidates } from "./workshop-terrain-catalog.js";
import type { TerrainModEntry } from "./types";

const oilField: TerrainModEntry = {
  id: "local-installed:mod-oil-field", modId: "mod-oil-field", name: "油田", version: "1.0.0",
  description: "本机已安装的地块。", terrainId: "mod/oil-field", installed: true
};
const decay: TerrainModEntry = {
  id: "local-installed:mod-decay-terrain", modId: "mod-decay-terrain", name: "衰蚀地", version: "0.1.0",
  description: "回合开始时减兵。", terrainId: "mod/decay-terrain", installed: true,
  definition: { id: "mod-decay-terrain", version: "0.1.0", capabilities: [], terrain: { capabilities: [] } }
};

describe("workshop terrain catalog", () => {
  it("applies automatic subscription updates in the workshop or battle lobby, never mid-match", () => {
    expect(canApplySubscribedModUpdate(true, false)).toBe(true);
    expect(canApplySubscribedModUpdate(false, false)).toBe(false);
    expect(canApplySubscribedModUpdate(true, true)).toBe(false);
    expect(canApplySubscribedModUpdate(false, false, true)).toBe(true);
    expect(canApplySubscribedModUpdate(false, true, true)).toBe(false);
    expect(canApplySubscribedModUpdate(false, false, false, true)).toBe(true);
    expect(canApplySubscribedModUpdate(false, true, false, true)).toBe(false);
  });

  it("shows one card per Mod and prefers the latest semantic version", () => {
    const versions = [
      { id: "old", modId: "mod-decay-terrain", name: "衰蚀地", version: "0.1.0", description: "旧说明", terrainId: "mod/decay-terrain", installed: true, authorName: "作者", createdAt: "2026-01-01" },
      { id: "preview", modId: "mod-preview", name: "预览", version: "1.0.0", description: "预览", terrainId: "mod/preview", installed: false, authorName: "作者", createdAt: "2026-01-01" },
      { id: "new", modId: "mod-decay-terrain", name: "衰蚀地", version: "0.2.0", description: "新说明", terrainId: "mod/decay-terrain", installed: true, authorName: "作者", createdAt: "2026-02-01" }
    ];
    expect(latestTerrainModVersions(versions).map(({ id, version }) => [id, version])).toEqual([
      ["new", "0.2.0"], ["preview", "1.0.0"]
    ]);
  });

  it("treats a stable release as newer than its prerelease", () => {
    const versions = [
      { id: "stable", modId: "mod-test", name: "测试", version: "1.0.0", description: "稳定版", terrainId: "mod/test", installed: false, authorName: "作者", createdAt: "2026-01-01" },
      { id: "rc", modId: "mod-test", name: "测试", version: "1.0.0-rc.2", description: "预发布", terrainId: "mod/test", installed: false, authorName: "作者", createdAt: "2026-02-01" }
    ];
    expect(latestTerrainModVersions(versions).map(({ id }) => id)).toEqual(["stable"]);
  });

  it("does not update an installed Mod unless the player subscribed to it", () => {
    const latest = [
      { id: "workshop-oil-field-v2", modId: "mod-oil-field", version: "0.1.1" },
      { id: "workshop-decay-v2", modId: "mod-decay-terrain", version: "0.3.1" }
    ];
    expect(terrainModUpdateCandidates(
      latest,
      [],
      [{ id: "mod-oil-field", version: "0.1.0" }]
    )).toEqual([]);
  });

  it("checks only subscribed Mod updates required by the open map", () => {
    const latest = [
      { id: "oil-v2", modId: "mod-oil-field", version: "0.1.1" },
      { id: "desert-v2", modId: "mod-desert-terrain", version: "0.2.0" },
      { id: "subscribed-v2", modId: "mod-community", version: "2.0.0" }
    ];
    const updates = mapTerrainModUpdateCandidates(
      latest,
      [{ id: "mod-community", installedVersion: "1.0.0" }],
      [
        { id: "mod-oil-field", version: "0.1.0" },
        { id: "mod-community", version: "1.0.0" }
      ],
      ["mod-community", "mod-oil-field"]
    );
    expect(updates.map(({ id }) => id)).toEqual(["mod-community"]);
  });

  it("ignores map dependencies that are not explicitly subscribed", () => {
    const latest = [
      { id: "oil-v2", modId: "mod-oil-field", version: "0.1.1" },
      { id: "decay-v2", modId: "mod-decay-terrain", version: "0.2.0" },
      { id: "subscribed-v2", modId: "mod-community", version: "2.0.0" }
    ];
    const updates = mapTerrainModUpdateCandidates(
      latest,
      [],
      [
        { id: "mod-oil-field", version: "0.1.0" },
        { id: "mod-decay-terrain", version: "0.2.0" },
        { id: "mod-community", version: "1.0.0" }
      ],
      ["mod-oil-field", "mod-decay-terrain"]
    );
    expect(updates).toEqual([]);
  });

  it("keeps newly installed packages visible when the workshop is offline", () => {
    expect(mergeWorkshopTerrainCatalog([], [oilField], [oilField, decay]).map(({ modId }) => modId))
      .toEqual(["mod-oil-field", "mod-decay-terrain"]);
  });

  it("retains remote entries and marks their installed package without duplicating it", () => {
    const { definition: _definition, ...summary } = decay;
    const remote: TerrainModEntry = { ...summary, id: "workshop-decay", installed: false };
    const [entry] = mergeWorkshopTerrainCatalog([remote], [], [decay]);
    expect(entry).toMatchObject({ id: "workshop-decay", modId: "mod-decay-terrain", installed: true, definition: decay.definition });
    expect(mergeWorkshopTerrainCatalog([remote], [], [decay])).toHaveLength(1);
  });

  it("does not mark an unpublished newer release as installed from an older cached definition", () => {
    const { definition: _definition, ...summary } = decay;
    const latest: TerrainModEntry = { ...summary, id: "workshop-decay-v2", version: "0.2.0", installed: false };
    const [entry] = mergeWorkshopTerrainCatalog([latest], [], [decay]);
    expect(entry?.installed).toBe(false);
    expect(entry?.definition).toBeUndefined();
  });
});
