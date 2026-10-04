/** Unit silhouettes communicate power through size, never through translucency. */
export function getUnitRenderScale(isPowered: boolean): number {
  return isPowered ? 1 : 0.58;
}

export const UNIT_BODY_ALPHA = 0.96;
export const UNIT_DETAIL_ALPHA = 0.24;
