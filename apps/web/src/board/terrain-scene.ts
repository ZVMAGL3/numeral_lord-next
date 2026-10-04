export interface TerrainSceneLayer {
  removeChildren(): readonly { destroy(options?: { children?: boolean }): void }[];
}

/** 地形底图与顶图属于同一场景，替换时必须一起销毁再重建。 */
export function replaceTerrainScene(
  baseLayer: TerrainSceneLayer,
  topLayer: TerrainSceneLayer,
  draw: () => void
): void {
  for (const layer of [baseLayer, topLayer]) {
    for (const child of layer.removeChildren()) child.destroy({ children: true });
  }
  draw();
}
