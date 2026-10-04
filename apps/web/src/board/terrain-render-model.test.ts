import { describe, expect, it } from "vitest";
import { resolveTerrainArtwork } from "./terrain-render-model.js";

describe("resolveTerrainArtwork", () => {
  it("把底图和顶部图案解析为统一的绘制模型", () => {
    expect(resolveTerrainArtwork({
      baseColor: "#123456",
      baseAssetId: "base",
      overlay: { assetId: "frame", scale: 0.8, opacity: 0.7, offsetX: 0.1, offsetY: -0.2 }
    }, { base: "/asset/base.svg", frame: "/asset/frame.svg" })).toEqual({
      base: { src: "/asset/base.svg", scale: 1, opacity: 1, offsetX: 0, offsetY: 0 },
      overlay: { src: "/asset/frame.svg", scale: 0.8, opacity: 0.7, offsetX: 0.1, offsetY: -0.2 },
      useColorFallback: false,
      transparent: false
    });
  });

  it("底图资源缺失时使用颜色底图，但保留已解析的顶部图案", () => {
    expect(resolveTerrainArtwork({
      baseColor: "#123456",
      baseAssetId: "missing",
      overlay: { assetId: "frame", scale: 1, opacity: 1, offsetX: 0, offsetY: 0 }
    }, { frame: "/asset/frame.svg" })).toMatchObject({
      useColorFallback: true,
      transparent: false,
      overlay: { src: "/asset/frame.svg" }
    });
  });

  it("纯色与图片是互斥的底部外观；图片定义不再需要附带纯色", () => {
    expect(resolveTerrainArtwork({ baseColor: "#123456" }, {})).toMatchObject({
      useColorFallback: true,
      transparent: false
    });
    expect(resolveTerrainArtwork({ baseAssetId: "base" }, { base: "/asset/base.svg" })).toMatchObject({
      base: { src: "/asset/base.svg" },
      useColorFallback: false,
      transparent: false
    });
  });

  it("透明底图不补色，资源列表未提供的图层不会绘制", () => {
    expect(resolveTerrainArtwork({
      baseColor: "#123456",
      baseAssetId: "base",
      baseTransparent: true,
      overlay: { assetId: "missing", scale: 1, opacity: 1, offsetX: 0, offsetY: 0 }
    }, {})).toEqual({ useColorFallback: false, transparent: true });
  });
});
