import { describe, expect, it } from "vitest";
import { shouldRequestWorkshopTerrainPreview } from "./workshop-preview-request.js";

describe("workshop terrain preview requests", () => {
  it("does not ask the workshop server for local or already-installed artwork", () => {
    expect(shouldRequestWorkshopTerrainPreview("local:mod-oil-field", true, false)).toBe(false);
    expect(shouldRequestWorkshopTerrainPreview("local-installed:mod-desert", true, false)).toBe(false);
    expect(shouldRequestWorkshopTerrainPreview("remote-release-1", true, false)).toBe(false);
    expect(shouldRequestWorkshopTerrainPreview("remote-release-1", false, true)).toBe(false);
  });

  it("loads artwork for a remote summary that has not been hydrated yet", () => {
    expect(shouldRequestWorkshopTerrainPreview("remote-release-1", false, false)).toBe(true);
    expect(shouldRequestWorkshopTerrainPreview(undefined, false, false)).toBe(false);
  });
});
