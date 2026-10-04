/** Check updates in the workshop, battle lobby, or when a map needs Mod artwork. */
export function shouldConnectWorkshopOnStartup(
  isWorkshopRoute: boolean,
  isBattleLobbyWithSubscriptions = false,
  isMapRouteWithModDependencies = false
): boolean {
  return isWorkshopRoute || isBattleLobbyWithSubscriptions || isMapRouteWithModDependencies;
}
