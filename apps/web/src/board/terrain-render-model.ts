import type { TerrainVisualSpec } from "@numeral-lord/game-core";

export interface ResolvedTerrainArtLayer {
  readonly src: string;
  readonly scale: number;
  readonly opacity: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly whenOccupied?: boolean;
}

export interface ResolvedTerrainArtwork {
  readonly base?: ResolvedTerrainArtLayer;
  readonly overlay?: ResolvedTerrainArtLayer;
  readonly useColorFallback: boolean;
  readonly transparent: boolean;
}

/** 工坊预览、地图编辑器和实战棋盘共用同一份地块视觉解析结果。 */
export function resolveTerrainArtwork(
  visuals: TerrainVisualSpec | undefined,
  assets: Readonly<Record<string, string>>,
  occupied = false
): ResolvedTerrainArtwork {
  if (!visuals) return { useColorFallback: false, transparent: false };

  const baseSource = visuals.baseTransparent || !visuals.baseAssetId
    ? undefined
    : assets[visuals.baseAssetId];
  const baseOpacity = visuals.baseTransparent === true ? 0 : visuals.baseOpacity ?? 1;
  const base = baseSource
    ? { src: baseSource, scale: 1, opacity: baseOpacity, offsetX: 0, offsetY: 0 }
    : undefined;
  const layer = visuals.overlay;
  const src = layer?.whenOccupied && !occupied ? undefined : layer ? assets[layer.assetId] : undefined;
  const overlay = layer && src ? { src, scale: layer.scale, opacity: layer.opacity, offsetX: layer.offsetX, offsetY: layer.offsetY,
    ...(layer.whenOccupied ? { whenOccupied: true } : {}) } : undefined;

  return {
    ...(base ? { base } : {}),
    ...(overlay ? { overlay } : {}),
    useColorFallback: !visuals.baseTransparent && !base && visuals.baseColor !== undefined,
    transparent: visuals.baseTransparent === true || baseOpacity === 0
  };
}
