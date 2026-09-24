import { defineStore } from "pinia";
import { ref } from "vue";
import type { GameState } from "@numeral-lord/game-core";

/**
 * Pinia is the reactive source of truth for the match. Commands and network
 * snapshots commit their resulting state through setGame; Vue then propagates
 * the update to the board and the rest of the UI.
 */
export const useMatchStore = defineStore("match", () => {
  const game = ref<GameState | null>(null);

  function setGame(next: GameState): void {
    game.value = next;
  }

  return { game, setGame };
});
