/** Void is not a playable/rendered tile, but must remain paintable in the map editor. */
export function shouldCreateCellHitTarget(terrainId: string, editable: boolean): boolean {
  return terrainId !== "core/void" || editable;
}
