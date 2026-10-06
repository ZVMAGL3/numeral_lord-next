/** Unit silhouettes communicate power through size, never through translucency. */
export function getUnitRenderScale(isPowered: boolean): number {
  return isPowered ? 1 : 0.58;
}

/** Live-match labels stay proportional to their hex; compact previews retain their legible floor. */
export function getUnitStrengthFontSize(radius: number, isPowered: boolean, isPreview: boolean, zoom = 1): number {
  const ratio = isPreview
    ? (isPowered ? 0.52 : 0.46)
    : (isPowered ? 0.54 : 0.42);
  const size = radius * ratio;
  return (isPreview ? Math.max(9, Math.round(size)) : size) * Math.max(0.01, zoom);
}

/** Counter the camera transform after rasterizing labels at their zoomed size. */
export function getUnitStrengthLabelScale(zoom: number): number {
  return 1 / Math.max(0.01, zoom);
}

export const UNIT_BODY_ALPHA = 0.96;
export const UNIT_DETAIL_ALPHA = 0.24;
