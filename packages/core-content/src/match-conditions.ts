import {
  hasTerrainCapability,
  type MatchConditionCatalog,
  type MatchConditionModule
} from "@numeral-lord/game-core";

/**
 * When this module is selected by a map, a player with remaining units but no
 * occupied `core/survival-anchor` terrain loses every remaining unit. It is
 * player-scoped: teammates may keep fighting, while the normal team victory
 * module decides the eventual winner.
 */
const loseAllAnchorsEliminatesArmy: MatchConditionModule = {
  id: "core/lose-all-survival-anchors",
  displayName: "失去全部据点则其余单位阵亡",
  evaluate(state, terrains) {
    const eliminatedPlayerIds = Object.values(state.players)
      .filter((player) => {
        const ownedUnits = Object.values(state.units).filter((unit) => unit.ownerId === player.id);
        if (ownedUnits.length === 0) return false;
        return !ownedUnits.some((unit) => {
          const cell = state.cells[unit.cellId];
          const terrain = cell ? terrains[cell.terrainId] : undefined;
          return Boolean(terrain && hasTerrainCapability(terrain, "core/survival-anchor"));
        });
      })
      .map((player) => player.id);

    return eliminatedPlayerIds.length > 0 ? { eliminatePlayerIds: eliminatedPlayerIds } : undefined;
  }
};

/** Runtime registry supplied to every browser, server, simulation and bot. */
export const coreMatchConditionCatalog: MatchConditionCatalog = {
  [loseAllAnchorsEliminatesArmy.id]: loseAllAnchorsEliminatesArmy
};
