import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { DEFAULT_MAP_CODE, createMatchFromMapCode } from "@numeral-lord/core-content";
import { getLegalActionDestinationIds } from "@numeral-lord/game-core";
import { coreUnitCatalog } from "@numeral-lord/core-content";
import { installedMapCatalogs, installedTerrainCatalog } from "./installed-content.js";
import { useBoardInteraction } from "./board-interaction.js";

describe("private board interaction state", () => {
  it("derives movement and counterattack previews only from the locally selected unit", () => {
    const game = ref(createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs));
    const attacker = Object.values(game.value.units).find((unit) => unit.ownerId === game.value.turn.currentPlayerId
      && getLegalActionDestinationIds(game.value, unit.id, installedTerrainCatalog, coreUnitCatalog).length > 0);
    expect(attacker).toBeDefined();
    if (!attacker) return;

    const interaction = useBoardInteraction(() => game.value, installedTerrainCatalog, coreUnitCatalog);
    expect(interaction.legalActionCellIds.value).toEqual([]);
    expect(interaction.select(attacker.id)).toBe(true);
    expect(interaction.selectedUnitId.value).toBe(attacker.id);
    expect(interaction.selectedSourceCellId.value).toBe(attacker.cellId);
    expect(interaction.selectedByUser.value).toBe(true);
    expect(interaction.legalActionCellIds.value).toEqual(
      getLegalActionDestinationIds(game.value, attacker.id, installedTerrainCatalog, coreUnitCatalog)
    );

    const expectedOccupiedTargets = interaction.legalActionCellIds.value.filter((cellId) => Boolean(game.value.cells[cellId]?.unitId));
    const framedTargets = [...interaction.counterattackCellIds.value, ...interaction.noCounterattackCellIds.value];
    expect(framedTargets).toHaveLength(expectedOccupiedTargets.length);
    expect(new Set(framedTargets)).toEqual(new Set(expectedOccupiedTargets));
    expect(framedTargets.every((cellId) => interaction.legalActionCellIds.value.includes(cellId))).toBe(true);
    expect(framedTargets.length).toBeLessThan(Object.values(game.value.cells).filter((cell) => cell.unitId).length);

    interaction.clear();
    expect(interaction.selectedUnitId.value).toBeNull();
    expect(interaction.legalActionCellIds.value).toEqual([]);
    expect(interaction.counterattackCellIds.value).toEqual([]);
    expect(interaction.noCounterattackCellIds.value).toEqual([]);
  });

  it("does not continue a unit exhausted by the authoritative board update", () => {
    const game = ref(createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs));
    const interaction = useBoardInteraction(() => game.value, installedTerrainCatalog, coreUnitCatalog);
    const unit = Object.values(game.value.units).find((candidate) => candidate.ownerId === game.value.turn.currentPlayerId
      && getLegalActionDestinationIds(game.value, candidate.id, installedTerrainCatalog, coreUnitCatalog).length > 0);
    expect(unit).toBeDefined();
    if (!unit) return;
    expect(interaction.select(unit.id)).toBe(true);
    game.value = {
      ...game.value,
      turn: { ...game.value.turn, exhaustedUnitIds: [...game.value.turn.exhaustedUnitIds, unit.id] }
    };
    expect(interaction.continueAt(unit.id)).toBe(false);
    expect(interaction.selectedUnitId.value).toBeNull();
  });
});
