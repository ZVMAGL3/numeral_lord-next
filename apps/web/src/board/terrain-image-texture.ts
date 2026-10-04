import { Texture } from "pixi.js";

/** Decode uploaded raster/SVG artwork through the browser's native image path,
 * then hand the ready resource to Pixi. This keeps board rendering consistent
 * with the editor's `<img>` terrain icon previews. */
export async function loadTerrainImageTexture(dataUrl: string): Promise<Texture> {
  const image = new Image();
  image.decoding = "async";
  if (typeof image.decode === "function") {
    image.src = dataUrl;
    await image.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("地块图片无法解码。"));
      image.src = dataUrl;
    });
  }
  return Texture.from({ resource: image });
}
