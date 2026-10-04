import type { GameCommand } from "./commands.js";
import type { TerrainCatalog } from "./content.js";
import { selectSpatialPatternCells, selectSpatialPatternUnits, matchesSpatialPredicate } from "./spatial-pattern.js";
import type { SpatialPatternDefinition } from "./spatial-pattern.js";
import type { CellId, GameState, PlayerId, UnitId, UnitState } from "./state.js";

export type ModRuleTrigger = "state-changed" | "unit-enter" | "unit-leave" | "unit-destroyed" | "turn-start";
export type ModRuleTarget = { readonly scope: "trigger-unit" }
  | {
    readonly scope: "pattern-units";
    readonly patternId: string;
    /** Restrict a turn-start target to the player whose turn triggered the rule. */
    readonly owner?: "actor";
    /** Restrict targets to units in the derived power network. */
    readonly powered?: true;
  };
export type ModRuleCondition =
  | { readonly op: "at-cell-matches"; readonly predicate: import("./spatial-pattern.js").SpatialPredicate }
  | { readonly op: "cell-in-pattern"; readonly patternId: string }
  | { readonly op: "crosses-pattern-boundary"; readonly patternId: string; readonly direction: "enter" | "leave" }
  | { readonly op: "pattern-includes-trigger-unit"; readonly patternId: string }
  | { readonly op: "mod-setting-equals"; readonly settingId: string; readonly value: number | boolean | string };
export type ModRuleEffect =
  | { readonly type: "change-strength"; readonly amount: number }
  | { readonly type: "grant-points"; readonly amount: number }
  | { readonly type: "change-strength-from-setting"; readonly settingId: string }
  | { readonly type: "grant-points-from-setting"; readonly settingId: string }
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
  /** Source and destination of a unit-enter/unit-leave movement event. */
  readonly fromCellId?: CellId;
  readonly toCellId?: CellId;
}

interface CompiledRuleSet {
  readonly patterns: ReadonlyMap<string, SpatialPatternDefinition>;
  readonly rulesByTrigger: ReadonlyMap<ModRuleTrigger, readonly ModRuleDefinition[]>;
}

const compiledRuleSetCache = new WeakMap<object, CompiledRuleSet>();
const spatialUnitSelectionCache = new WeakMap<
  GameState,
  WeakMap<TerrainCatalog, WeakMap<SpatialPatternDefinition, Map<PlayerId, ReadonlySet<UnitId>>>>
>();
const spatialCellSelectionCache = new WeakMap<
  GameState,
  WeakMap<TerrainCatalog, WeakMap<SpatialPatternDefinition, Map<PlayerId, ReadonlySet<CellId>>>>
>();

function compileRuleSet(ruleSet: NonNullable<GameState["settings"]["modRuleSet"]>): CompiledRuleSet {
  const cached = compiledRuleSetCache.get(ruleSet);
  if (cached) return cached;
  const patterns = new Map(ruleSet.patterns.map((pattern) => [pattern.id, pattern]));
  const rulesByTrigger = new Map<ModRuleTrigger, ModRuleDefinition[]>();
  for (const rule of ruleSet.rules) {
    const rules = rulesByTrigger.get(rule.trigger) ?? [];
    rules.push(rule);
    rulesByTrigger.set(rule.trigger, rules);
  }
  const compiled = { patterns, rulesByTrigger };
  compiledRuleSetCache.set(ruleSet, compiled);
  return compiled;
}

function selectUnitsCached(
  state: GameState,
  terrains: TerrainCatalog,
  pattern: SpatialPatternDefinition,
  actorOwnerId: PlayerId
): ReadonlySet<UnitId> {
  let selectionsByTerrain = spatialUnitSelectionCache.get(state);
  if (!selectionsByTerrain) {
    selectionsByTerrain = new WeakMap();
    spatialUnitSelectionCache.set(state, selectionsByTerrain);
  }
  let selectionsByPattern = selectionsByTerrain.get(terrains);
  if (!selectionsByPattern) {
    selectionsByPattern = new WeakMap();
    selectionsByTerrain.set(terrains, selectionsByPattern);
  }
  let selections = selectionsByPattern.get(pattern);
  if (!selections) {
    selections = new Map();
    selectionsByPattern.set(pattern, selections);
  }
  const cached = selections.get(actorOwnerId);
  if (cached) return cached;
  const selected = selectSpatialPatternUnits(state, terrains, pattern, actorOwnerId);
  selections.set(actorOwnerId, selected);
  return selected;
}

function selectCellsCached(
  state: GameState,
  terrains: TerrainCatalog,
  pattern: SpatialPatternDefinition,
  actorOwnerId: PlayerId
): ReadonlySet<CellId> {
  let selectionsByTerrain = spatialCellSelectionCache.get(state);
  if (!selectionsByTerrain) {
    selectionsByTerrain = new WeakMap();
    spatialCellSelectionCache.set(state, selectionsByTerrain);
  }
  let selectionsByPattern = selectionsByTerrain.get(terrains);
  if (!selectionsByPattern) {
    selectionsByPattern = new WeakMap();
    selectionsByTerrain.set(terrains, selectionsByPattern);
  }
  let selections = selectionsByPattern.get(pattern);
  if (!selections) {
    selections = new Map();
    selectionsByPattern.set(pattern, selections);
  }
  const cached = selections.get(actorOwnerId);
  if (cached) return cached;
  const selected = selectSpatialPatternCells(state, terrains, pattern, actorOwnerId);
  selections.set(actorOwnerId, selected);
  return selected;
}

/** Run only object-defined rules. Rule/effect order is stable and no dynamic code is evaluated. */
export function applyModRules(
  previous: GameState,
  next: GameState,
  command: GameCommand | undefined,
  terrains: TerrainCatalog,
  initial = false,
  isUnitPowered?: (state: GameState, unitId: UnitId) => boolean
): GameState {
  const ruleSet = next.settings.modRuleSet;
  if (!ruleSet) return next;
  const compiled = compileRuleSet(ruleSet);
  const events = initial
    ? [{ trigger: "turn-start" as const, actorId: next.turn.currentPlayerId }]
    : command ? collectEvents(previous, next, command) : [];
  let state = next;
  for (const event of events) {
    for (const rule of compiled.rulesByTrigger.get(event.trigger) ?? []) {
      const namespaceEnd = rule.id.indexOf("/");
      const ruleModId = namespaceEnd > 0 ? rule.id.slice(0, namespaceEnd) : "";
      if (!conditionsMatch(state, terrains, rule, event, compiled.patterns, ruleModId)) continue;
      let cachedTargets: readonly UnitId[] | undefined;
      for (const effect of rule.effects) {
        if (effect.type === "sync-unit-marker") {
          const pattern = compiled.patterns.get(effect.patternId);
          if (!pattern || pattern.result.entity !== "unit") continue;
          const selected = new Set<UnitId>();
          for (const player of Object.values(state.players)) {
            for (const unitId of selectUnitsCached(state, terrains, pattern, player.id)) selected.add(unitId);
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
          // Marker predicates can change the target selection for a later
          // effect in this same rule, so lazily resolve it again if needed.
          cachedTargets = undefined;
          continue;
        }
        const targets = cachedTargets ??= resolveTargets(
          state, terrains, rule.target, event, compiled.patterns, isUnitPowered
        );
        for (const targetId of targets) {
          state = applyEffect(state, targetId, effect, ruleModId);
        }
        // These effects may change whether a unit belongs to a spatial
        // selection (markers) or remove it from the board (strength).
        if (effect.type === "change-strength" || effect.type === "change-strength-from-setting"
          || effect.type === "set-unit-marker" || effect.type === "remove-unit-marker") {
          cachedTargets = undefined;
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
  patterns: ReadonlyMap<string, import("./spatial-pattern.js").SpatialPatternDefinition>,
  ruleModId: string
): boolean {
  return (rule.conditions ?? []).every((condition) => {
    if (condition.op === "at-cell-matches") {
      return !!event.cellId && matchesSpatialPredicate(state, terrains, event.cellId, event.actorId, condition.predicate);
    }
    if (condition.op === "mod-setting-equals") {
      return state.settings.modSettings?.[ruleModId]?.[condition.settingId] === condition.value;
    }
    if (condition.op === "cell-in-pattern") {
      const pattern = patterns.get(condition.patternId);
      return !!event.cellId && !!pattern && pattern.result.entity === "cell"
        && selectCellsCached(state, terrains, pattern, event.actorId).has(event.cellId);
    }
    if (condition.op === "crosses-pattern-boundary") {
      const pattern = patterns.get(condition.patternId);
      if (!pattern || pattern.result.entity !== "cell" || !event.fromCellId || !event.toCellId) return false;
      const cells = selectCellsCached(state, terrains, pattern, event.actorId);
      return condition.direction === "enter"
        ? !cells.has(event.fromCellId) && cells.has(event.toCellId)
        : cells.has(event.fromCellId) && !cells.has(event.toCellId);
    }
    if (!event.unitId) return false;
    const pattern = patterns.get(condition.patternId);
    return !!pattern && pattern.result.entity === "unit"
      && selectUnitsCached(state, terrains, pattern, event.actorId).has(event.unitId);
  });
}

function resolveTargets(
  state: GameState,
  terrains: TerrainCatalog,
  target: ModRuleTarget,
  event: ModRuleEvent,
  patterns: ReadonlyMap<string, import("./spatial-pattern.js").SpatialPatternDefinition>,
  isUnitPowered?: (state: GameState, unitId: UnitId) => boolean
): readonly UnitId[] {
  if (target.scope === "trigger-unit") return event.unitId && state.units[event.unitId] ? [event.unitId] : [];
  const pattern = patterns.get(target.patternId);
  if (!pattern || pattern.result.entity !== "unit") return [];
  return [...selectUnitsCached(state, terrains, pattern, event.actorId)].filter((unitId) => {
    const unit = state.units[unitId];
    if (target.owner === "actor" && unit?.ownerId !== event.actorId) return false;
    if (target.powered && !isUnitPowered?.(state, unitId)) return false;
    return true;
  });
}

function applyEffect(state: GameState, unitId: UnitId, effect: Exclude<ModRuleEffect, { type: "sync-unit-marker" }>, ruleModId: string): GameState {
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
      const exhaustedUnitIds = state.turn.exhaustedUnitIds.filter((exhaustedId) => exhaustedId !== unitId);
      return {
        ...state,
        units,
        cells,
        ...(exhaustedUnitIds.length !== state.turn.exhaustedUnitIds.length
          ? { turn: { ...state.turn, exhaustedUnitIds } }
          : {})
      };
    }
    case "grant-points": {
      const player = state.players[unit.ownerId];
      if (!player) return state;
      return { ...state, players: { ...state.players, [player.id]: { ...player, reinforcementPoints: player.reinforcementPoints + effect.amount } } };
    }
    case "grant-points-from-setting": {
      const value = state.settings.modSettings?.[ruleModId]?.[effect.settingId];
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) return state;
      return applyEffect(state, unitId, { type: "grant-points", amount: value as number }, ruleModId);
    }
    case "change-strength-from-setting": {
      const value = state.settings.modSettings?.[ruleModId]?.[effect.settingId];
      if (!Number.isInteger(value) || Math.abs(value as number) > 100) return state;
      return applyEffect(state, unitId, { type: "change-strength", amount: value as number }, ruleModId);
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
    result.push({ trigger: "unit-leave", actorId, unitId, cellId: from, fromCellId: from, toCellId: to });
    result.push({ trigger: "unit-enter", actorId, unitId, cellId: to, fromCellId: from, toCellId: to });
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
