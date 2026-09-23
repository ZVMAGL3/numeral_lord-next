import { applyIntent, getLegalIntents } from "@numeral-lord/game-core/node";
import type {
  GameIntent,
  GameState,
  MatchConditionCatalog,
  TerrainCatalog,
  UnitCatalog
} from "@numeral-lord/game-core/node";

export { getLegalIntents };

/**
 * The server will keep the authoritative GameState and invoke this same
 * headless API that a browser prediction client or a training worker uses.
 */
export function validateIntent(
  state: GameState,
  intent: GameIntent,
  commandId: string,
  catalogs: {
    readonly terrains: TerrainCatalog;
    readonly units: UnitCatalog;
    readonly matchConditions?: MatchConditionCatalog;
  }
) {
  return applyIntent(state, intent, commandId, catalogs.terrains, catalogs.units, catalogs.matchConditions);
}

console.info("Numeral Lord server scaffold: shared Node rule core loaded.");
