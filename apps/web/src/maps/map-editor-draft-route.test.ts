import { describe, expect, it } from "vitest";
import { clearMapEditorDraft, mapEditorDraftIdFromPath } from "./map-editor-draft-route.js";

describe("map editor draft routes", () => {
  it("identifies the exact draft key from edit routes", () => {
    expect(mapEditorDraftIdFromPath("/maps/edit/new")).toBe("new");
    expect(mapEditorDraftIdFromPath("/maps/edit/custom%2Fmap")).toBe("custom/map");
    expect(mapEditorDraftIdFromPath("/maps")).toBeNull();
    expect(mapEditorDraftIdFromPath("/maps/edit/custom/map")).toBeNull();
    expect(mapEditorDraftIdFromPath("/maps/edit/%E0%A4%A")).toBeNull();
  });

  it("discards the cancelled map draft without touching another map's draft", () => {
    let value: string | null = JSON.stringify({ mapId: "map-a", definition: { name: "unsaved" } });
    const storage = {
      getItem: () => value,
      removeItem: () => { value = null; }
    };

    clearMapEditorDraft(storage, "map-b", "draft");
    expect(value).not.toBeNull();
    clearMapEditorDraft(storage, "map-a", "draft");
    expect(value).toBeNull();
  });
});
