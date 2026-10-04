/** Only remote, summary-only workshop entries need to fetch preview artwork. */
export function shouldRequestWorkshopTerrainPreview(
  publicationId: string | undefined,
  hasDefinition: boolean,
  hasPreview: boolean
): boolean {
  if (!publicationId) return false;
  return !publicationId.startsWith("local:")
    && !publicationId.startsWith("local-installed:")
    && !hasDefinition
    && !hasPreview;
}
