import { describe, expect, it } from "vitest";
import { replaceTerrainScene, type TerrainSceneLayer } from "./terrain-scene.js";

class TestLayer implements TerrainSceneLayer {
  readonly children = new Set<{ destroyed: boolean }> ();

  removeChildren(): readonly { destroy(options?: { children?: boolean }): void }[] {
    const children = [...this.children];
    this.children.clear();
    return children.map((child) => ({ destroy: () => { child.destroyed = true; } }));
  }

  add(): { destroyed: boolean } {
    const child = { destroyed: false };
    this.children.add(child);
    return child;
  }
}

describe("replaceTerrainScene", () => {
  it("替换一帧时同时清空旧底图和旧顶图，避免重绘后图案累积", () => {
    const base = new TestLayer();
    const top = new TestLayer();
    const oldBase = base.add();
    const oldTop = top.add();

    replaceTerrainScene(base, top, () => {
      base.add();
      top.add();
    });

    expect(oldBase.destroyed).toBe(true);
    expect(oldTop.destroyed).toBe(true);
    expect(base.children.size).toBe(1);
    expect(top.children.size).toBe(1);
  });
});
