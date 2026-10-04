/** Every terrain surface uses the exact shared tile footprint for fills and artwork. */
export const TERRAIN_ART_FOOTPRINT_SCALE = 0.98;
export const TERRAIN_ART_VIEWBOX_HEIGHT = 115.47;

export interface TerrainArtPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 所有地块图片都使用同一六边形范围计算尺寸、偏移和裁剪半径。 */
export function getTerrainArtPlacement(
  centerX: number,
  centerY: number,
  radius: number,
  scale = 1,
  offsetX = 0,
  offsetY = 0
): TerrainArtPlacement & { readonly clipRadius: number } {
  const clipRadius = radius * TERRAIN_ART_FOOTPRINT_SCALE;
  const artRadius = clipRadius * scale;
  return {
    x: centerX + clipRadius * offsetX,
    y: centerY + clipRadius * offsetY,
    width: Math.sqrt(3) * artRadius,
    height: 2 * artRadius,
    clipRadius
  };
}

export function getTerrainArtClipPoints(): string {
  return getTerrainHexPoints(TERRAIN_ART_FOOTPRINT_SCALE);
}

/** 以 Pixi 棋盘相同的顶点顺序，生成指定缩放比例的六边形路径。 */
export function getTerrainHexPoints(scale: number): string {
  const coordinates = getTerrainHexCoordinates(50, TERRAIN_ART_VIEWBOX_HEIGHT / 2, TERRAIN_ART_VIEWBOX_HEIGHT / 2 * scale);
  const points: string[] = [];
  for (let index = 0; index < coordinates.length; index += 2) {
    points.push(`${Number(coordinates[index]!.toFixed(4))},${Number(coordinates[index + 1]!.toFixed(4))}`);
  }
  return points.join(" ");
}

/** 与 Pixi 六边形绘制共用的顶点算法。 */
export function getTerrainHexCoordinates(centerX: number, centerY: number, radius: number): number[] {
  const coordinates: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI / 180) * (60 * index - 30);
    coordinates.push(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle));
  }
  return coordinates;
}
