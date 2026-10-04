import { createPinia, setActivePinia } from "pinia";
import { computed, isReactive } from "vue";
import { describe, expect, it } from "vitest";
import type { GameState } from "@numeral-lord/game-core";
import { useMatchStore } from "./match.js";

describe("match store", () => {
  it("notifies consumers on snapshot replacement without deep-proxying the board", () => {
    setActivePinia(createPinia());
    const store = useMatchStore();
    const firstSnapshot = { sequence: 0 } as unknown as GameState;
    const observedSequence = computed(() => store.game?.sequence);

    store.setGame(firstSnapshot);
    expect(observedSequence.value).toBe(0);
    expect(isReactive(store.game)).toBe(false);

    store.setGame({ sequence: 1 } as unknown as GameState);
    expect(observedSequence.value).toBe(1);
  });
});
