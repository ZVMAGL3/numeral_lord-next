import type { GameCommand } from "./commands.js";
import type { MatchConditionCatalog, TerrainCatalog, UnitCatalog } from "./content.js";
import {
  applyCommand,
  getLegalActionDestinationIds,
  getPoweredUnitIds,
  type CommandResult
} from "./engine.js";
import type { CellId, GameState, UnitId } from "./state.js";

/**
 * A UI-free action space for bots, simulations, servers, and training jobs.
 * The actor and sequence are derived from the state at submission time so a
 * policy only decides the game action, not client protocol bookkeeping.
 */
export type GameIntent =
  | { readonly type: "move-unit"; readonly unitId: UnitId; readonly destinationId: CellId }
  | { readonly type: "attack-unit"; readonly unitId: UnitId; readonly targetId: CellId }
  | { readonly type: "reinforce-unit"; readonly unitId: UnitId }
  | { readonly type: "end-action-phase" }
  | { readonly type: "end-reinforcement-phase" };

/** Enumerates every command the current player may legally choose right now. */
export function getLegalIntents(
  state: GameState,
  terrains: TerrainCatalog,
  units: UnitCatalog
): readonly GameIntent[] {
  const current = state.players[state.turn.currentPlayerId];
  if (!current || state.turn.phase === "finished") return [];

  if (state.turn.phase === "reinforcement") {
    const powered = getPoweredUnitIds(state, terrains);
    const reinforcement = current.reinforcementPoints > 0
      ? Object.values(state.units)
        .filter((unit) => unit.ownerId === current.id && powered.has(unit.id))
        .map((unit) => ({ type: "reinforce-unit" as const, unitId: unit.id }))
      : [];
    return [...reinforcement, { type: "end-reinforcement-phase" }];
  }

  const intents: GameIntent[] = [];
  for (const unit of Object.values(state.units)) {
    if (unit.ownerId !== current.id) continue;
    for (const cellId of getLegalActionDestinationIds(state, unit.id, terrains, units)) {
      if (state.cells[cellId]?.unitId) intents.push({ type: "attack-unit", unitId: unit.id, targetId: cellId });
      else intents.push({ type: "move-unit", unitId: unit.id, destinationId: cellId });
    }
  }
  // Ending early is always a legitimate strategic choice.
  intents.push({ type: "end-action-phase" });
  return intents;
}

/** Applies an AI-selected intent through exactly the same validation as the web client. */
export function applyIntent(
  state: GameState,
  intent: GameIntent,
  commandId: string,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  matchConditions: MatchConditionCatalog = {}
): CommandResult {
  const command = toCommand(state, intent, commandId);
  return applyCommand(state, command, terrains, units, matchConditions);
}

function toCommand(state: GameState, intent: GameIntent, commandId: string): GameCommand {
  const base = {
    commandId,
    actorId: state.turn.currentPlayerId,
    expectedSequence: state.sequence
  };
  switch (intent.type) {
    case "move-unit": return { ...base, type: intent.type, unitId: intent.unitId, destinationId: intent.destinationId };
    case "attack-unit": return { ...base, type: intent.type, unitId: intent.unitId, targetId: intent.targetId };
    case "reinforce-unit": return { ...base, type: intent.type, unitId: intent.unitId };
    case "end-action-phase": return { ...base, type: intent.type };
    case "end-reinforcement-phase": return { ...base, type: intent.type };
  }
}
