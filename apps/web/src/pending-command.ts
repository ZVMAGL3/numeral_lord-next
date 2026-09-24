import { computed, readonly, shallowRef } from "vue";
import type { CellId, GameCommand } from "@numeral-lord/game-core";

export type PendingResolution =
  | { readonly kind: "action"; readonly sourceCellId: CellId; readonly targetCellId: CellId; readonly includeSourceClick: boolean }
  | { readonly kind: "reinforcement"; readonly cellId: CellId }
  | { readonly kind: "phase"; readonly phase: "action" | "reinforcement" };

export interface PendingRemoteCommand {
  readonly commandId: string;
  readonly expectedSequence: number;
  readonly resolution: PendingResolution;
}

/**
 * A remote command is not an optimistic board update. Keep one in flight,
 * lock further input, and release it only on its matching host response or an
 * explicit lifecycle reset/reconciliation.
 */
export function usePendingCommand() {
  const current = shallowRef<PendingRemoteCommand | null>(null);
  const isPending = computed(() => current.value !== null);

  function begin(command: GameCommand, resolution: PendingResolution): boolean {
    if (current.value) return false;
    current.value = {
      commandId: command.commandId,
      expectedSequence: command.expectedSequence,
      resolution
    };
    return true;
  }

  function resolve(commandId: string): PendingRemoteCommand | null {
    if (current.value?.commandId !== commandId) return null;
    const resolved = current.value;
    current.value = null;
    return resolved;
  }

  function clear(commandId?: string): boolean {
    if (commandId && current.value?.commandId !== commandId) return false;
    const hadPending = current.value !== null;
    current.value = null;
    return hadPending;
  }

  return {
    current: readonly(current),
    isPending,
    begin,
    resolve,
    clear
  };
}
