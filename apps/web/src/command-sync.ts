import type { GameCommand } from "@numeral-lord/game-core";

/** The parent identifies the exact committed history a command was based on. */
export interface CommandEnvelope {
  readonly command: GameCommand;
  readonly parentCommandId: string | null;
}

export interface ReplicatedCommand extends CommandEnvelope {
  readonly playerId: string;
}

export type CommandInspection = "duplicate" | "ready" | "conflict";

const RECENT_COMMAND_LIMIT = 256;

/**
 * Tracks command order without owning or changing the game state. Each client
 * may apply a local command immediately, then commit it here before broadcasting
 * it. Recipients inspect the envelope before applying it through game-core.
 * Equal sequence numbers alone do not prove equal history, so a different
 * parent is a conflict and must be reconciled using the host's snapshot.
 */
export function createCommandTimeline() {
  let headId: string | null = null;
  const seen = new Set<string>();

  function remember(commandId: string): void {
    seen.add(commandId);
    if (seen.size > RECENT_COMMAND_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  function inspect(envelope: CommandEnvelope): CommandInspection {
    if (seen.has(envelope.command.commandId)) return "duplicate";
    return envelope.parentCommandId === headId ? "ready" : "conflict";
  }

  function commit(envelope: CommandEnvelope): void {
    const inspection = inspect(envelope);
    if (inspection === "duplicate") return;
    if (inspection === "conflict") throw new Error("Cannot commit a command from a different command history.");
    headId = envelope.command.commandId;
    remember(headId);
  }

  function reset(nextHeadId: string | null): void {
    seen.clear();
    headId = nextHeadId;
    if (nextHeadId !== null) remember(nextHeadId);
  }

  return {
    get headId(): string | null { return headId; },
    envelope(command: GameCommand): CommandEnvelope {
      return { command, parentCommandId: headId };
    },
    inspect,
    commit,
    reset
  };
}
