import type { GameCommand } from "./commands.js";
import type { TerrainCatalog } from "./content.js";
import { selectSpatialPatternUnits, matchesSpatialPredicate } from "./spatial-pattern.js";
import type { CellId, GameState, PlayerId, UnitId, UnitState } from "./state.js";

export type ModRuleTrigger = "state-changed" | "unit-enter" | "unit-leave" | "unit-destroyed" | "turn-start";
export type ModRuleTarget = { readonly scope: "trigger-unit" }
  | { readonly scope: "pattern-units"; readonly patternId: string };
export type ModRuleCondition =
  | { readonly op: "at-cell-matches"; readonly predicate: import("./spatial-pattern.js").SpatialPredicate }
  | { readonly op: "pattern-includes-trigger-unit"; readonly patternId: string };
export type ModRuleEffect =
  | { readonly type: "change-strength"; readonly amount: number }
  | { readonly type: "grant-points"; readonly amount: number }
  | { readonly type: "exhaust-unit" }
  | { readonly type: "set-unit-marker"; readonly marker: string }
  | { readonly type: "remove-unit-marker"; readonly marker: string }
  | { readonly type: "sync-unit-marker"; readonly marker: string; readonly patternId: string };

export interface ModRuleDefinition {
  readonly id: string;
  readonly trigger: ModRuleTrigger;
  readonly target: ModRuleTarget;
  readonly conditions?: readonly ModRuleCondition[];
  readonly effects: readonly ModRuleEffect[];
}

export interface ModRuleEvent {
  readonly trigger: ModRuleTrigger;
  readonly actorId: PlayerId;
  readonly unitId?: UnitId;
  readonly cellId?: CellId;
}

/** Run only object-defined rules. Rule/effect order is stable and no dynamic code is evaluated. */
export function applyModRules(
  previous: GameState,
  next: GameState,
  command: GameCommand | undefined,
  terrains: TerrainCatalog,
  initial = false
): GameState {
  const ruleSet = next.settings.modRuleSet;
  if (!ruleSet) return next;
  const patterns = new Map(ruleSet.patterns.map((pattern) => [pattern.id, pattern]));
  const events = initial
    ? [{ trigger: "turn-start" as const, actorId: next.turn.currentPlayerId }]
    : command ? collectEvents(previous, next, command) : [];
  let state = next;
  for (const event of events) {
    for (const rule of ruleSet.rules) {
      if (rule.trigger !== event.trigger || !conditionsMatch(state, terrains, rule, event, patterns)) continue;
      for (const effect of rule.effects) {
        if (effect.type === "sync-unit-marker") {
          const pattern = patterns.get(effect.patternId);
          if (!pattern || pattern.result.entity !== "unit") continue;
          const selected = new Set<UnitId>();
          for (const player of Object.values(state.players)) {
            for (const unitId of selectSpatialPatternUnits(state, terrains, pattern, player.id)) selected.add(unitId);
          }
          const units: Record<UnitId, UnitState> = { ...state.units };
          for (const unit of Object.values(state.units)) {
            const hasMarker = unit.markers?.includes(effect.marker) ?? false;
            const shouldHave = selected.has(unit.id);
            if (hasMarker === shouldHave) continue;
            units[unit.id] = {
              ...unit,
              markers: shouldHave
                ? [...(unit.markers ?? []), effect.marker]
                : (unit.markers ?? []).filter((marker) => marker !== effect.marker)
            };
          }
          state = { ...state, units };
          continue;
        }
        for (const targetId of resolveTargets(state, terrains, rule.target, event, patterns)) {
          state = applyEffect(state, targetId, effect);
        }
      }
    }
  }
  return state;
}

function conditionsMatch(
  state: GameState,
  terrains: TerrainCatalog,
  rule: ModRuleDefinition,
  event: ModRuleEvent,
  patterns: ReadonlyMap<string, import("./spatial-pattern.js").SpatialPatternDefinition>
): boolean {
  return (rule.conditions ?? []).every((condition) => {
    if (condition.op === "at-cell-matches") {
      return !!event.cellId && matchesSpatialPredicate(state, terrains, event.cellId, event.actorId, condition.predicate);
    }
    if (!event.unitId) return false;
    const pattern = patterns.get(condition.patternId);
    return !!pattern && pattern.result.entity === "unit"
      && selectSpatialPatternUnits(state, terrains, pattern, event.actorId).has(event.unitId);
  });
}

function resolveTargets(
  state: GameState,
  terrains: TerrainCatalog,
  target: ModRuleTarget,
  event: ModRuleEvent,
  patterns: ReadonlyMap<string, import("./spatial-pattern.js").SpatialPatternDefinition>
): readonly UnitId[] {
  if (target.scope === "trigger-unit") return event.unitId && state.units[event.unitId] ? [event.unitId] : [];
  const pattern = patterns.get(target.patternId);
  if (!pattern || pattern.result.entity !== "unit") return [];
  return [...selectSpatialPatternUnits(state, terrains, pattern, event.actorId)];
}

function applyEffect(state: GameState, unitId: UnitId, effect: Exclude<ModRuleEffect, { type: "sync-unit-marker" }>): GameState {
  const unit = state.units[unitId];
  if (!unit) return state;
  switch (effect.type) {
    case "change-strength": {
      const strength = unit.strength + effect.amount;
      if (strength > 0) return { ...state, units: { ...state.units, [unitId]: { ...unit, strength } } };
      const units = { ...state.units };
      delete units[unitId];
      const cell = state.cells[unit.cellId];
      let cells = state.cells;
      if (cell?.unitId === unitId) {
        const { unitId: _removedUnitId, ...emptyCell } = cell;
        cells = { ...state.cells, [cell.id]: emptyCell };
      }
      return { ...state, units, cells };
    }
    case "grant-points": {
      const player = state.players[unit.ownerId];
      if (!player) return state;
      return { ...state, players: { ...state.players, [player.id]: { ...player, reinforcementPoints: player.reinforcementPoints + effect.amount } } };
    }
    case "exhaust-unit":
      return state.turn.exhaustedUnitIds.includes(unitId) ? state : {
        ...state,
        turn: { ...state.turn, exhaustedUnitIds: [...state.turn.exhaustedUnitIds, unitId] }
      };
    case "set-unit-marker":
      return unit.markers?.includes(effect.marker) ? state : {
        ...state,
        units: { ...state.units, [unitId]: { ...unit, markers: [...(unit.markers ?? []), effect.marker] } }
      };
    case "remove-unit-marker":
      return !unit.markers?.includes(effect.marker) ? state : {
        ...state,
        units: { ...state.units, [unitId]: { ...unit, markers: unit.markers.filter((marker) => marker !== effect.marker) } }
      };
  }
}

function collectEvents(previous: GameState, next: GameState, command: GameCommand): ModRuleEvent[] {
  const result: ModRuleEvent[] = [{ trigger: "state-changed", actorId: command.actorId }];
  const pushUnitMove = (unitId: UnitId, from: CellId, to: CellId, actorId: PlayerId) => {
    result.push({ trigger: "unit-leave", actorId, unitId, cellId: from });
    result.push({ trigger: "unit-enter", actorId, unitId, cellId: to });
  };
  if (command.type === "move-unit") {
    const before = previous.units[command.unitId];
    const arriving = next.cells[command.destinationId]?.unitId
      ? next.units[next.cells[command.destinationId]!.unitId!]
      : undefined;
    // Powered moves split off a new one-point branch, so the command's source
    // ID can remain behind. The occupied destination is the authoritative
    // identity of the unit that actually entered the cell.
    if (before && arriving?.ownerId === command.actorId && arriving.cellId === command.destinationId) {
      pushUnitMove(arriving.id, before.cellId, arriving.cellId, arriving.ownerId);
    }
  } else if (command.type === "attack-unit") {
    const attacker = previous.units[command.unitId];
    const target = previous.cells[command.targetId];
    const afterTarget = next.cells[command.targetId];
    const arriving = afterTarget?.unitId ? next.units[afterTarget.unitId] : undefined;
    if (attacker && arriving?.ownerId === attacker.ownerId && arriving.cellId === command.targetId && attacker.cellId !== arriving.cellId) {
      pushUnitMove(arriving.id, attacker.cellId, arriving.cellId, arriving.ownerId);
    }
    const defender = target?.unitId ? previous.units[target.unitId] : undefined;
    if (defender && !next.units[defender.id]) {
      result.push({ trigger: "unit-destroyed", actorId: command.actorId, unitId: defender.id, cellId: defender.cellId });
    }
    if (attacker && !next.units[attacker.id] && !arriving) {
      result.push({ trigger: "unit-destroyed", actorId: command.actorId, unitId: attacker.id, cellId: attacker.cellId });
    }
  }
  if (previous.turn.currentPlayerId !== next.turn.currentPlayerId || previous.turn.round !== next.turn.round) {
    result.push({ trigger: "turn-start", actorId: next.turn.currentPlayerId });
  }
  return result;
}
