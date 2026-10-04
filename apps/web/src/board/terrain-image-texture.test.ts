import { afterEach, describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import { loadTerrainImageTexture } from "./terrain-image-texture.js";

describe("Mod terrain image texture loading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes uploaded SVG data URLs with the native image path before creating a Pixi texture", async () => {
    const dataUrl = "data:image/svg+xml;base64,PHN2Zy8+";
    const image = {
      decoding: "",
      src: "",
      decode: vi.fn(async () => undefined)
    } as unknown as HTMLImageElement;
    vi.stubGlobal("Image", class { constructor() { return image; } });
    const texture = {} as Texture;
    const from = vi.spyOn(Texture, "from").mockReturnValue(texture);

    await expect(loadTerrainImageTexture(dataUrl)).resolves.toBe(texture);

    expect(image.src).toBe(dataUrl);
    expect(image.decode).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith({ resource: image });
    from.mockRestore();
  });
});
