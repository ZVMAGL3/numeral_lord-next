import { defineStore } from "pinia";
import { shallowRef } from "vue";
import type { GameState } from "@numeral-lord/game-core";

/**
 * Pinia is the reactive source of truth for the match. GameState is an immutable
 * snapshot, so a shallow ref notifies consumers when the snapshot is replaced
 * without recursively proxying every cell, unit, and rule setting.
 */
export const useMatchStore = defineStore("match", () => {
  const game = shallowRef<GameState | null>(null);

  function setGame(next: GameState): void {
    game.value = next;
  }

  return { game, setGame };
});
