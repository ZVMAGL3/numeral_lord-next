import { computed, readonly, ref } from "vue";
import {
  canCounterattack,
  getLegalActionDestinationIds,
  type CellId,
  type GameState,
  type TerrainCatalog,
  type UnitCatalog,
  type UnitId
} from "@numeral-lord/game-core";

/**
 * Per-client board interaction state. It is intentionally not part of
 * GameState and is never sent through the PvP relay; move previews can reveal
 * a player's plan, so only the selecting client should see them.
 */
export function useBoardInteraction(
  getGame: () => GameState,
  terrains: TerrainCatalog,
  units: UnitCatalog
) {
  const currentSelectedUnitId = ref<UnitId | null>(null);
  const currentSourceCellId = ref<CellId | null>(null);
  const currentSelectionWasUserInitiated = ref(false);

  const selectedUnit = computed(() => {
    const unitId = currentSelectedUnitId.value;
    return unitId ? getGame().units[unitId] : undefined;
  });

  /** Legal cells are always recalculated from this tab's selection and the latest canonical board. */
  const legalActionCellIds = computed<readonly CellId[]>(() => {
    const unitId = currentSelectedUnitId.value;
    return unitId ? getLegalActionDestinationIds(getGame(), unitId, terrains, units) : [];
  });

  const counterattackCellIds = computed<readonly CellId[]>(() => legalActionCellIds.value.filter((cellId) => {
    const targetId = getGame().cells[cellId]?.unitId;
    return Boolean(targetId && canCounterattack(getGame(), targetId, terrains, units));
  }));

  const noCounterattackCellIds = computed<readonly CellId[]>(() => legalActionCellIds.value.filter((cellId) => {
    const targetId = getGame().cells[cellId]?.unitId;
    return Boolean(targetId && !canCounterattack(getGame(), targetId, terrains, units));
  }));

  function clear(): void {
    currentSelectedUnitId.value = null;
    currentSourceCellId.value = null;
    currentSelectionWasUserInitiated.value = false;
  }

  function select(unitId: UnitId, userInitiated = true): boolean {
    const game = getGame();
    const unit = game.units[unitId];
    if (!unit || getLegalActionDestinationIds(game, unitId, terrains, units).length === 0) {
      clear();
      return false;
    }
    currentSelectedUnitId.value = unitId;
    currentSourceCellId.value = unit.cellId;
    currentSelectionWasUserInitiated.value = userInitiated;
    return true;
  }

  /** Continuation is allowed only if the authoritative result says the unit may act again. */
  function continueAt(unitId: UnitId | null): boolean {
    if (!unitId) {
      clear();
      return false;
    }
    return select(unitId, false);
  }

  return {
    selectedUnitId: readonly(currentSelectedUnitId),
    selectedSourceCellId: readonly(currentSourceCellId),
    selectedByUser: readonly(currentSelectionWasUserInitiated),
    selectedUnit,
    legalActionCellIds,
    counterattackCellIds,
    noCounterattackCellIds,
    clear,
    select,
    continueAt
  };
}
