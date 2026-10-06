import { describe, expect, it } from "vitest";
import { compareModVersions, latestTerrainModVersions } from "./workshop-terrain-catalog.js";

describe("server terrain Mod catalog", () => {
  it("keeps one current entry per Mod ID and chooses the highest semantic version", () => {
    const entries = [
      { id: "old", modId: "mod-decay-terrain", version: "0.1.0", createdAt: "2026-01-01" },
      { id: "preview", modId: "mod-preview", version: "1.0.0", createdAt: "2026-01-01" },
      { id: "new", modId: "mod-decay-terrain", version: "0.2.0", createdAt: "2026-02-01" }
    ];
    expect(latestTerrainModVersions(entries).map(({ id, version }) => [id, version])).toEqual([
      ["new", "0.2.0"], ["preview", "1.0.0"]
    ]);
  });

  it("treats stable versions as newer than prereleases", () => {
    expect(compareModVersions("1.0.0", "1.0.0-rc.2")).toBe(1);
  });
});
