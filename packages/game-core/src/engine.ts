import type { GameCommand } from "./commands.js";
import {
  getTerrainCapability,
  getMatchTerrainCapability,
  getUnitCapability,
  hasTerrainCapability,
  hasUnitCapability,
  type MatchConditionCatalog,
  type TerrainCatalog,
  type TerrainSpec,
  type UnitCatalog,
  type UnitSpec
} from "./content.js";
import { getHexDistance, getHexDistances, getHexNeighbours, toCellId, type HexBounds } from "./hex.js";
import { matchesSpatialPredicate, selectSpatialExpressionCellsFrom, selectSpatialPatternUnits, type SpatialExpression, type SpatialPatternDefinition, type SpatialPredicate } from "./spatial-pattern.js";
import { applyModRules } from "./mod-rules.js";
import type {
  CellId,
  GameState,
  PlayerId,
  PlayerState,
  TeamId,
  UnitId,
  UnitState,
  MapCell,
  MatchResult
} from "./state.js";

export interface GameEvent {
  readonly type:
    | "unit-moved"
    | "unit-attacked"
    | "unit-counterattacked"
    | "unit-depowered"
    | "unit-destroyed"
    | "player-eliminated"
    | "unit-exhausted"
    | "unit-reinforced"
    | "points-granted"
    | "action-phase-ended"
    | "reinforcement-phase-started"
    | "reinforcement-phase-ended"
    | "turn-started"
    | "match-finished";
  readonly message: string;
}

export interface CommandFailure {
  readonly code:
    | "match-finished"
    | "stale-command"
    | "not-current-player"
    | "wrong-phase"
    | "invalid-unit-definition"
    | "unit-cannot-move"
    | "unit-cannot-attack"
    | "occupied-destination"
    | "target-required"
    | "target-out-of-range"
    | "unknown-unit"
    | "not-unit-owner"
    | "unit-exhausted"
    | "invalid-destination"
    | "non-adjacent-destination"
    | "blocked-terrain"
    | "friendly-target"
    | "insufficient-strength"
    | "insufficient-points"
    | "unit-not-powered"
    | "invalid-command"
    | "mod-rule-error"
    | "unknown-command";
  readonly message: string;
}

/**
 * The rule action can nominate the unit that should remain selected. This is
 * deliberately separate from a destination: later actions such as artillery
 * may attack a target while keeping the acting unit at its original cell.
 */
export interface ActionOutcome {
  readonly continuation?: {
    readonly unitId: UnitId;
    readonly cellId: CellId;
  };
}

export type CommandResult =
  | { readonly accepted: true; readonly state: GameState; readonly events: readonly GameEvent[]; readonly outcome?: ActionOutcome }
  | { readonly accepted: false; readonly state: GameState; readonly error: CommandFailure };

/** Headless match bootstrap: calculate the first seat's points before any action. */
export interface MatchStartResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

interface Draft {
  readonly state: GameState;
  readonly units: Record<UnitId, UnitState>;
  readonly cells: GameState["cells"] extends Readonly<Record<CellId, infer Cell>>
    ? Record<CellId, Cell>
    : never;
  readonly players: Record<PlayerId, PlayerState>;
  turn: GameState["turn"];
  result?: MatchResult | undefined;
}

const CAPABILITY = {
  occupiable: "core/occupiable",
  conductor: "core/power-conductor",
  source: "core/power-source",
  income: "core/income-source",
  entryExhaustion: "core/exhaust-on-entry",
  departureExhaustion: "core/exhaust-on-departure",
  attackCaptureExhaustion: "core/exhaust-unpowered-after-capture",
  departureGarrison: "core/departure-garrison",
  terrainMovement: "core/terrain-movement",
  counterattackTerrainLimit: "core/counterattack-terrain-limit"
} as const;

function getTerrainMovementRule(terrain: TerrainSpec): {
  readonly enabled: boolean;
  readonly expression?: SpatialExpression;
} {
  const config = getTerrainCapability(terrain, CAPABILITY.terrainMovement)?.config;
  const expression = isRecord(config?.expression) ? config.expression as SpatialExpression : undefined;
  return {
    enabled: config?.enabled !== false,
    ...(expression ? { expression } : {})
  };
}

const UNIT_CAPABILITY = {
  move: "core/move",
  attack: "core/attack",
  attackRange: "core/attack-range",
  counterattack: "core/counterattack",
  counterattackLimit: "core/counterattack-limit",
  terrainBoundCounterattack: "core/terrain-bound-counterattack",
  actionStrengthDecay: "core/action-strength-decay",
  poweredActionThreshold: "core/powered-action-threshold",
  attackExhaustion: "core/exhaust-after-attack"
} as const;

// GameState snapshots are immutable by contract. Cache one derived power set
// per (state snapshot, terrain catalog), so getLegalActionDestinationIds can
// ask the same question for several units without repeating the BFS. WeakMaps
// release old snapshots after a command replaces them.
const poweredCache = new WeakMap<GameState, WeakMap<TerrainCatalog, ReadonlySet<UnitId>>>();
const legalDestinationCache = new WeakMap<
  GameState,
  WeakMap<TerrainCatalog, WeakMap<UnitCatalog, Map<UnitId, readonly CellId[]>>>
>();
const actionableUnitCache = new WeakMap<
  GameState,
  WeakMap<TerrainCatalog, WeakMap<UnitCatalog, ReadonlySet<UnitId>>>
>();
const potentialActionableCache = new WeakMap<
  GameState,
  WeakMap<TerrainCatalog, WeakMap<UnitCatalog, ReadonlySet<UnitId>>>
>();
const reinforceableCache = new WeakMap<GameState, WeakMap<TerrainCatalog, ReadonlySet<UnitId>>>();
const exhaustedUnitSetCache = new WeakMap<GameState, ReadonlySet<UnitId>>();
const noUnitIds: ReadonlySet<UnitId> = new Set();

/** The built-in power network is itself a serializable spatial pattern. */
export const POWER_NETWORK_PATTERN: SpatialPatternDefinition = {
  id: "core/powered-network",
  result: { entity: "unit", distinctBy: "id" },
  role: "core/powered-units",
  starts: {
    op: "all",
    items: [
      { op: "terrain-has", capabilityId: CAPABILITY.conductor },
      { op: "terrain-has", capabilityId: CAPABILITY.source },
      { op: "unit-owner-is", owner: "actor" }
    ]
  },
  expression: {
    op: "repeat",
    min: 0,
    max: 4096,
    item: {
      op: "step",
      relation: "hex-neighbor",
      where: {
        op: "all",
        items: [
          { op: "terrain-has", capabilityId: CAPABILITY.conductor },
          { op: "unit-owner-is", owner: "actor" }
        ]
      }
    }
  }
};

/** Built-in fallback keeps existing maps playable without a content package. */
const DEFAULT_MATCH_CONDITIONS: MatchConditionCatalog = {
  "core/last-team-standing": {
    id: "core/last-team-standing",
    displayName: "场上仅剩一队",
    evaluate(state) {
      const surviving = new Set<TeamId>();
      for (const unit of Object.values(state.units)) {
        const player = state.players[unit.ownerId];
        if (player) surviving.add(player.teamId);
      }
      if (surviving.size > 1) return undefined;
      const winners = [...surviving];
      return {
        finish: {
          winningTeamIds: winners,
          message: `队伍 ${winners[0] ?? "无"} 获胜。`
        }
      };
    }
  }
};

export function applyCommand(
  state: GameState,
  command: unknown,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  matchConditions: MatchConditionCatalog = {}
): CommandResult {
  if (!isRecord(command) || typeof command.type !== "string") {
    return fail(state, "invalid-command", "操作数据格式不正确。");
  }
  if (!isKnownCommandType(command.type)) {
    return fail(state, "unknown-command", `无法识别操作类型：${command.type}`);
  }
  if (!isWellFormedGameCommand(command)) {
    return fail(state, "invalid-command", "操作缺少必需参数或参数类型不正确。");
  }
  if (state.turn.phase === "finished") {
    return fail(state, "match-finished", "本局游戏已经结束。");
  }
  if (command.expectedSequence !== state.sequence) {
    return fail(state, "stale-command", "棋盘已更新，请按最新状态重新操作。");
  }
  if (command.actorId !== state.turn.currentPlayerId) {
    return fail(state, "not-current-player", "现在不是该玩家的行动回合。");
  }

  switch (command.type) {
    case "move-unit":
      if (state.turn.phase !== "action") return fail(state, "wrong-phase", "加点回合不能移动或攻击。");
      return finalizeCommand(state, moveUnit(state, command, terrains, units), terrains, units, matchConditions, command);
    case "attack-unit":
      if (state.turn.phase !== "action") return fail(state, "wrong-phase", "加点回合不能移动或攻击。");
      return finalizeCommand(state, attackUnit(state, command, terrains, units), terrains, units, matchConditions, command);
    case "reinforce-unit":
      if (state.turn.phase !== "reinforcement") return fail(state, "wrong-phase", "请先结束行动，进入加点回合。");
      return finalizeCommand(state, reinforceUnit(state, command, terrains), terrains, units, matchConditions, command);
    case "end-action-phase":
      if (state.turn.phase !== "action") return fail(state, "wrong-phase", "当前不是行动回合。");
      return finalizeCommand(state, endActionPhase(state), terrains, units, matchConditions, command);
    case "end-reinforcement-phase":
      if (state.turn.phase !== "reinforcement") return fail(state, "wrong-phase", "当前不是加点回合。");
      return finalizeCommand(state, endReinforcementPhase(state, terrains), terrains, units, matchConditions, command);
  }
}

/**
 * Commands can arrive from the network as arbitrary JSON even though trusted
 * TypeScript callers see the GameCommand union. Validate that boundary here so
 * every runtime input produces a CommandResult instead of throwing or falling
 * through the switch with `undefined`.
 */
function isWellFormedGameCommand(command: unknown): command is GameCommand {
  if (!isRecord(command)) return false;
  if (typeof command.commandId !== "string"
    || typeof command.actorId !== "string"
    || typeof command.expectedSequence !== "number"
    || !Number.isSafeInteger(command.expectedSequence)) return false;

  switch (command.type) {
    case "move-unit":
      return typeof command.unitId === "string" && typeof command.destinationId === "string";
    case "attack-unit":
      return typeof command.unitId === "string" && typeof command.targetId === "string";
    case "reinforce-unit":
      return typeof command.unitId === "string";
    case "end-action-phase":
    case "end-reinforcement-phase":
      return true;
    default:
      return false;
  }
}

function isKnownCommandType(type: string): type is GameCommand["type"] {
  return type === "move-unit"
    || type === "attack-unit"
    || type === "reinforce-unit"
    || type === "end-action-phase"
    || type === "end-reinforcement-phase";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Starts an already-created map state without any browser/UI dependency.
 * Map factories should create zero reinforcement points, then call this once.
 */
export function startMatch(
  state: GameState,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  matchConditions: MatchConditionCatalog = {}
): MatchStartResult {
  const current = state.players[state.turn.currentPlayerId];
  if (!current || state.turn.phase !== "action") return { state, events: [] };
  const draft = createDraft(state);
  const events: GameEvent[] = [];
  grantReinforcementIncome(draft, current, terrains, events);
  events.push({ type: "turn-started", message: `现在轮到 ${current.displayName} 的行动回合。` });
  const withRules = applyModRules(state, asDraftState(draft), undefined, terrains, true,
    (current, unitId) => getPoweredUnitIds(current, terrains).has(unitId));
  const ruledDraft = createDraft(withRules);
  resolveMatchConditions(ruledDraft, terrains, matchConditions, events);
  return { state: asDraftState(ruledDraft), events };
}

/**
 * External clocks and tournament controllers end a match through game-core
 * instead of mutating UI state directly.  A wall clock is intentionally not
 * stored or ticked here, keeping simulations deterministic.
 */
export function finishMatch(
  state: GameState,
  message: string,
  winningTeamIds: readonly TeamId[] = []
): GameState {
  if (state.turn.phase === "finished") return state;
  return {
    ...state,
    sequence: state.sequence + 1,
    turn: {
      ...state.turn,
      phase: "finished",
      exhaustedUnitIds: [],
      counterattacksUsed: {}
    },
    result: { winningTeamIds, message }
  };
}

/**
 * Derived, never persisted: evaluate a regular-path query on the board graph.
 * One owner-scoped pattern starts at their occupied power sources and repeats
 * neighbor steps through friendly occupied conductive cells. The interpreter
 * de-duplicates visited cells, so cyclic unit networks terminate. This keeps
 * the legacy connected-component behavior while making the path definition
 * serializable and reusable by data-only Mods.
 */
export function getPoweredUnitIds(
  state: GameState,
  terrains: TerrainCatalog
): ReadonlySet<UnitId> {
  const cachedByTerrain = poweredCache.get(state);
  const cached = cachedByTerrain?.get(terrains);
  if (cached) return cached;

  // The returned set is the complete derived answer, never persisted in GameState.
  const powered = new Set<UnitId>();

  // A separate interpretation per player scopes the `actor` predicate to that
  // owner. The pattern is the same serializable grammar that future Mods use.
  const customPatterns = state.settings.modRuleSet?.patterns.filter((pattern) => pattern.role === "core/powered-units") ?? [];
  const patterns = customPatterns.length > 0 ? customPatterns : [POWER_NETWORK_PATTERN];
  for (const player of Object.values(state.players)) {
    for (const pattern of patterns) {
      for (const unitId of selectSpatialPatternUnits(state, terrains, pattern, player.id)) powered.add(unitId);
    }
  }

  const cacheForState = cachedByTerrain ?? new WeakMap<TerrainCatalog, ReadonlySet<UnitId>>();
  cacheForState.set(terrains, powered);
  if (!cachedByTerrain) poweredCache.set(state, cacheForState);
  return powered;
}

/**
 * Returns only the cells a unit may act on right now. It uses the same
 * predicates as `moveUnit`, so a local client never paints a target that the
 * authoritative validator will reject.
 */
export function getLegalActionDestinationIds(
  state: GameState,
  unitId: UnitId,
  terrains: TerrainCatalog,
  units: UnitCatalog
): readonly CellId[] {
  // This public query describes actions that can be issued now. The private
  // owner-scoped variant is also used for future-turn previews during growth.
  if (state.turn.phase !== "action") return [];

  const cachedByTerrain = legalDestinationCache.get(state);
  const cachedForTerrain = cachedByTerrain?.get(terrains);
  const cachedByUnit = cachedForTerrain?.get(units);
  const cachedDestinations = cachedByUnit?.get(unitId);
  if (cachedDestinations) return cachedDestinations;

  const destinations = getLegalActionDestinationsForOwner(
    state,
    unitId,
    terrains,
    units,
    state.turn.currentPlayerId,
    getExhaustedUnitIds(state)
  );
  const cacheForState = cachedByTerrain ?? new WeakMap<TerrainCatalog, WeakMap<UnitCatalog, Map<UnitId, readonly CellId[]>>>();
  const cacheForTerrain = cachedForTerrain ?? new WeakMap<UnitCatalog, Map<UnitId, readonly CellId[]>>();
  const cacheForCatalogs = cachedByUnit ?? new Map<UnitId, readonly CellId[]>();
  cacheForCatalogs.set(unitId, destinations);
  cacheForTerrain.set(units, cacheForCatalogs);
  if (!cachedByTerrain) legalDestinationCache.set(state, cacheForState);
  if (!cachedForTerrain) cacheForState.set(terrains, cacheForTerrain);
  return destinations;
}

/**
 * Shared legal-action calculation. `actorId` and exhaustion are parameters so
 * the UI can preview another player's turn without cloning/mutating GameState.
 */
function getLegalActionDestinationsForOwner(
  state: GameState,
  unitId: UnitId,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  actorId: PlayerId,
  exhaustedUnitIds: ReadonlySet<UnitId>,
  poweredUnitIds?: ReadonlySet<UnitId>
): readonly CellId[] {
  const unit = state.units[unitId];
  if (!unit || unit.ownerId !== actorId) return [];
  if (exhaustedUnitIds.has(unit.id)) return [];

  const sourceCell = state.cells[unit.cellId];
  if (!sourceCell) return [];
  const sourceTerrain = requireTerrain(terrains, sourceCell.terrainId);
  const powered = (poweredUnitIds ?? getPoweredUnitIds(state, terrains)).has(unit.id);
  const departureGarrison = hasCellTrigger(state, sourceCell.id, "leave", CAPABILITY.departureGarrison, sourceTerrain)
    ? getDepartureGarrison(sourceTerrain, powered) : undefined;
  const canLeaveSource = !departureGarrison || unit.strength > departureGarrison.strength;
  const terrainMovement = getTerrainMovementRule(sourceTerrain);
  const unitDefinition = units[unit.definitionId];
  if (!unitDefinition) return [];

  if (!hasEnoughStrengthToAct(unit, unitDefinition, powered)) return [];
  const legal = new Set<CellId>();
  const moveRange = getConfiguredMax(unitDefinition, UNIT_CAPABILITY.move, "maxDistance");
  const mayMove = Boolean(moveRange && canLeaveSource && terrainMovement.enabled);
  const movementRange = mayMove && !terrainMovement.expression ? moveRange! : 0;
  const attackRange = getAttackRange(unitDefinition);
  const attackCapability = getUnitCapability(unitDefinition, UNIT_CAPABILITY.attack);
  const attackMovesIntoTarget = attackCapability?.config?.movesIntoTarget !== false;
  const mayAttack = Boolean(attackCapability && attackRange
    && (!attackMovesIntoTarget || (canLeaveSource && terrainMovement.enabled)));
  const maxDistance = Math.max(movementRange, mayAttack ? attackRange!.max : 0);
  const distances = maxDistance > 0
    ? getHexDistances(sourceCell.coordinate, state.board, maxDistance)
    : new Map<CellId, number>();

  if (movementRange > 0) {
    for (const [cellId, distance] of distances) {
      if (distance === 0 || distance > movementRange) continue;
      const cell = state.cells[cellId];
      if (!cell || cell.unitId) continue;
      const terrain = requireTerrain(terrains, cell.terrainId);
      if (hasTerrainCapability(terrain, CAPABILITY.occupiable)) legal.add(cell.id);
    }
  }

  if (mayMove && terrainMovement.expression) {
    try {
      for (const cellId of selectSpatialExpressionCellsFrom(
        state, terrains, [sourceCell.id], terrainMovement.expression, actorId
      )) {
        if (cellId === sourceCell.id) continue;
        const cell = state.cells[cellId];
        if (!cell || cell.unitId) continue;
        const terrain = requireTerrain(terrains, cell.terrainId);
        if (hasTerrainCapability(terrain, CAPABILITY.occupiable)) legal.add(cellId);
      }
    } catch {
      // Malformed or over-budget movement expressions grant no destinations.
    }
  }

  if (mayAttack && attackRange) {
    // `distances` is already bounded to the unit's movement/attack range.
    // Inspect only those nearby cells: scanning every unit here made the
    // actionability preview quadratic as armies grew (one full unit scan for
    // every candidate acting unit).
    for (const [targetCellId, distance] of distances) {
      if (distance < attackRange.min || distance > attackRange.max) continue;
      const targetCell = state.cells[targetCellId];
      const targetUnitId = targetCell?.unitId;
      const target = targetUnitId ? state.units[targetUnitId] : undefined;
      if (!target) continue;
      if (areSameTeam(state, unit.ownerId, target.ownerId) && !state.settings.friendlyFire) continue;
      legal.add(targetCellId);
    }
  }
  return [...legal];
}

/** Reuse the current snapshot's exhaustion lookup across all unit queries. */
function getExhaustedUnitIds(state: GameState): ReadonlySet<UnitId> {
  const cached = exhaustedUnitSetCache.get(state);
  if (cached) return cached;
  const exhausted = new Set(state.turn.exhaustedUnitIds);
  exhaustedUnitSetCache.set(state, exhausted);
  return exhausted;
}

/** Units that can presently produce at least one legal action. */
export function getActionableUnitIds(
  state: GameState,
  terrains: TerrainCatalog,
  units: UnitCatalog
): ReadonlySet<UnitId> {
  if (state.turn.phase !== "action") return noUnitIds;

  const cachedByTerrain = actionableUnitCache.get(state);
  const cachedForTerrain = cachedByTerrain?.get(terrains);
  const cached = cachedForTerrain?.get(units);
  if (cached) return cached;

  const actionable = new Set(Object.values(state.units)
    .filter((unit) => unit.ownerId === state.turn.currentPlayerId)
    .filter((unit) => getLegalActionDestinationIds(state, unit.id, terrains, units).length > 0)
    .map((unit) => unit.id));
  const cacheForState = cachedByTerrain ?? new WeakMap<TerrainCatalog, WeakMap<UnitCatalog, ReadonlySet<UnitId>>>();
  const cacheForTerrain = cachedForTerrain ?? new WeakMap<UnitCatalog, ReadonlySet<UnitId>>();
  cacheForTerrain.set(units, actionable);
  cacheForState.set(terrains, cacheForTerrain);
  if (!cachedByTerrain) actionableUnitCache.set(state, cacheForState);
  return actionable;
}

/**
 * Units with a legal action when each living player's turn is considered in
 * isolation. During action, current-player exhaustion is honored while
 * opponents are previewed with a fresh action phase. During reinforcement,
 * every player is previewed with fresh exhaustion because those units will
 * act in a later action phase, after exhaustion has reset.
 */
export function getPotentiallyActionableUnitIds(
  state: GameState,
  terrains: TerrainCatalog,
  units: UnitCatalog
): ReadonlySet<UnitId> {
  if (state.turn.phase !== "action" && state.turn.phase !== "reinforcement") return new Set<UnitId>();

  const cachedByTerrain = potentialActionableCache.get(state);
  const cachedForTerrain = cachedByTerrain?.get(terrains);
  const cached = cachedForTerrain?.get(units);
  if (cached) return cached;

  const isActionPhase = state.turn.phase === "action";
  const potential = new Set(isActionPhase ? getActionableUnitIds(state, terrains, units) : []);
  const powered = getPoweredUnitIds(state, terrains);
  for (const unit of Object.values(state.units)) {
    if (!state.players[unit.ownerId]) continue;
    // The active player's current exhausted actions matter only while they
    // are still acting. In reinforcement everyone is being previewed for a
    // future action phase, so stale exhaustion must not suppress highlights.
    if (isActionPhase && unit.ownerId === state.turn.currentPlayerId) continue;
    if (getLegalActionDestinationsForOwner(state, unit.id, terrains, units, unit.ownerId, noUnitIds, powered).length > 0) {
      potential.add(unit.id);
    }
  }

  const cacheForState = cachedByTerrain ?? new WeakMap<TerrainCatalog, WeakMap<UnitCatalog, ReadonlySet<UnitId>>>();
  const cacheForCatalogs = cachedForTerrain ?? new WeakMap<UnitCatalog, ReadonlySet<UnitId>>();
  cacheForCatalogs.set(units, potential);
  if (!cachedByTerrain) potentialActionableCache.set(state, cacheForState);
  if (!cachedForTerrain) cacheForState.set(terrains, cacheForCatalogs);
  return potential;
}

/** Units the current player can reinforce during this phase. */
export function getReinforceableUnitIds(
  state: GameState,
  terrains: TerrainCatalog
): ReadonlySet<UnitId> {
  const cachedByTerrain = reinforceableCache.get(state);
  const cached = cachedByTerrain?.get(terrains);
  if (cached) return cached;
  if (state.turn.phase !== "reinforcement" || (state.players[state.turn.currentPlayerId]?.reinforcementPoints ?? 0) < 1) {
    return new Set<UnitId>();
  }

  const powered = getPoweredUnitIds(state, terrains);
  const reinforceable = new Set(Object.values(state.units)
    .filter((unit) => unit.ownerId === state.turn.currentPlayerId && powered.has(unit.id))
    .map((unit) => unit.id));
  const cacheForState = cachedByTerrain ?? new WeakMap<TerrainCatalog, ReadonlySet<UnitId>>();
  cacheForState.set(terrains, reinforceable);
  if (!cachedByTerrain) reinforceableCache.set(state, cacheForState);
  return reinforceable;
}

function moveUnit(
  state: GameState,
  command: Extract<GameCommand, { type: "move-unit" }>,
  terrains: TerrainCatalog,
  units: UnitCatalog
): CommandResult {
  const unit = state.units[command.unitId];
  if (!unit) return fail(state, "unknown-unit", "找不到要移动的单位。");
  if (unit.ownerId !== command.actorId) return fail(state, "not-unit-owner", "只能操作自己的单位。");
  if (state.turn.exhaustedUnitIds.includes(unit.id)) {
    return fail(state, "unit-exhausted", "该单位本回合已失去行动力。");
  }

  const sourceCell = state.cells[unit.cellId];
  const destinationCell = state.cells[command.destinationId];
  if (!sourceCell || !destinationCell) {
    return fail(state, "invalid-destination", "目标格不存在。");
  }
  const unitDefinition = units[unit.definitionId];
  if (!unitDefinition) return fail(state, "invalid-unit-definition", "单位没有可用的兵种定义。");
  const sourceTerrain = requireTerrain(terrains, sourceCell.terrainId);
  const powered = getPoweredUnitIds(state, terrains).has(unit.id);
  const departureGarrison = hasCellTrigger(state, sourceCell.id, "leave", CAPABILITY.departureGarrison, sourceTerrain)
    ? getDepartureGarrison(sourceTerrain, powered) : undefined;
  if (departureGarrison && unit.strength <= departureGarrison.strength) {
    return fail(state, "insufficient-strength", "该地形需要留下 1 点留守游兵，至少需要 2 点才能离开。");
  }
  if (departureGarrison && !units[departureGarrison.unitDefinitionId ?? unit.definitionId]) {
    return fail(state, "invalid-unit-definition", "该地形配置的留守兵种不存在。");
  }
  const moveRange = getConfiguredMax(unitDefinition, UNIT_CAPABILITY.move, "maxDistance");
  if (!moveRange) return fail(state, "unit-cannot-move", "该兵种没有移动能力。");
  if (!getTerrainMovementRule(sourceTerrain).enabled) {
    return fail(state, "unit-cannot-move", "当前地块不允许单位移动离开。");
  }
  if (destinationCell.unitId) return fail(state, "occupied-destination", "移动目标必须是空格；攻击请使用攻击能力。");
  const destinationTerrain = requireTerrain(terrains, destinationCell.terrainId);
  if (!hasTerrainCapability(destinationTerrain, CAPABILITY.occupiable)) {
    return fail(state, "blocked-terrain", "山地和虚无不能进入。");
  }
  if (!hasEnoughStrengthToAct(unit, unitDefinition, powered)) {
    return fail(state, "insufficient-strength", "通电兵点数不足，不能行动。");
  }
  if (!getLegalActionDestinationIds(state, unit.id, terrains, units).includes(destinationCell.id)) {
    return fail(state, "non-adjacent-destination", "目标不在该地块允许的移动范围内。");
  }
  // A powered stack must leave its one-point supply anchor in the source cell.
  // Roamer's optional action-strength-decay controls the strength of the
  // branch that actually performed the move, including unpowered movement.
  const movingStrength = getMovingStrengthAfterAction(unit, unitDefinition, powered);
  if (movingStrength < 1) {
    return fail(state, "insufficient-strength", "单位兵力不足，无法保留供电锚点并完成行动。");
  }

  const draft = createDraft(state);
  const events: GameEvent[] = [];
  const continuationUnitId = moveIntoEmptyCell(draft, unit, destinationCell.id, movingStrength, powered, events);

  if (departureGarrison) {
    leaveDepartureGarrison(draft, sourceCell.id, unit, departureGarrison, units, events);
  }

  applyEntryExhaustion(
    draft,
    continuationUnitId,
    sourceTerrain,
    destinationTerrain,
    destinationCell.id,
    events
  );
  applyDepartureExhaustion(
    draft,
    continuationUnitId,
    sourceCell.id,
    requireTerrain(terrains, sourceCell.terrainId),
    destinationTerrain,
    events
  );
  applyMinimumStrengthExhaustion(draft, continuationUnitId, unit, unitDefinition, events);

  return succeed(draft, events, continuationUnitId
    && canContinueAction(draft, continuationUnitId, terrains, units) ? {
    continuation: {
      unitId: continuationUnitId,
      cellId: draft.units[continuationUnitId]?.cellId ?? destinationCell.id
    }
  } : undefined);
}

function attackUnit(
  state: GameState,
  command: Extract<GameCommand, { type: "attack-unit" }>,
  terrains: TerrainCatalog,
  units: UnitCatalog
): CommandResult {
  const attacker = state.units[command.unitId];
  if (!attacker) return fail(state, "unknown-unit", "找不到要攻击的单位。");
  if (attacker.ownerId !== command.actorId) return fail(state, "not-unit-owner", "只能操作自己的单位。");
  if (state.turn.exhaustedUnitIds.includes(attacker.id)) {
    return fail(state, "unit-exhausted", "该单位本回合已失去行动力。");
  }
  const sourceCell = state.cells[attacker.cellId];
  const targetCell = state.cells[command.targetId];
  if (!sourceCell || !targetCell) return fail(state, "invalid-destination", "攻击目标格不存在。");
  const defender = targetCell.unitId ? state.units[targetCell.unitId] : undefined;
  if (!defender) return fail(state, "target-required", "攻击目标必须有单位。");
  if (areSameTeam(state, attacker.ownerId, defender.ownerId) && !state.settings.friendlyFire) {
    return fail(state, "friendly-target", "本地图关闭友伤，不能攻击同队单位。");
  }
  const attackerDefinition = units[attacker.definitionId];
  if (!attackerDefinition) return fail(state, "invalid-unit-definition", "单位没有可用的兵种定义。");
  const attackCapability = getUnitCapability(attackerDefinition, UNIT_CAPABILITY.attack);
  const attackRange = getAttackRange(attackerDefinition);
  if (!attackCapability || !attackRange) return fail(state, "unit-cannot-attack", "该兵种没有攻击能力或攻击距离。");
  const distance = getHexDistance(sourceCell.coordinate, targetCell.coordinate, state.board);
  if (distance === undefined || distance < attackRange.min || distance > attackRange.max) {
    return fail(state, "target-out-of-range", "目标超出该兵种的攻击距离。");
  }

  const movesIntoTarget = attackCapability.config?.movesIntoTarget !== false;
  const sourceTerrain = requireTerrain(terrains, sourceCell.terrainId);
  if (movesIntoTarget && !getTerrainMovementRule(sourceTerrain).enabled) {
    return fail(state, "unit-cannot-move", "当前地块不允许单位移动离开并推进占领。");
  }
  const powered = getPoweredUnitIds(state, terrains).has(attacker.id);
  const departureGarrison = movesIntoTarget
    && hasCellTrigger(state, sourceCell.id, "leave", CAPABILITY.departureGarrison, sourceTerrain)
    ? getDepartureGarrison(sourceTerrain, powered)
    : undefined;
  if (departureGarrison && attacker.strength <= departureGarrison.strength) {
    return fail(state, "insufficient-strength", "该地形需要留下 1 点留守游兵，至少需要 2 点才能离开。");
  }
  if (departureGarrison && !units[departureGarrison.unitDefinitionId ?? attacker.definitionId]) {
    return fail(state, "invalid-unit-definition", "该地形配置的留守兵种不存在。");
  }
  if (!hasEnoughStrengthToAct(attacker, attackerDefinition, powered)) {
    return fail(state, "insufficient-strength", "通电兵点数不足，不能行动。");
  }
  const attackStrength = movesIntoTarget && powered
    ? getMovingStrengthAfterAction(attacker, attackerDefinition, true)
    : attacker.strength;
  if (attackStrength < 1) return fail(state, "insufficient-strength", "单位兵力不足，无法保留供电锚点并完成行动。");

  const draft = createDraft(state);
  const events: GameEvent[] = [];
  // Capture the target tile's pre-combat defense state once. Combat results,
  // UI red/white frames, and the per-cell usage counter all use this same
  // predicate; a split unit ID must never restore the tile's defense.
  const hasDefense = canCounterattack(state, defender.id, terrains, units);
  if (hasDefense) consumeCellDefense(draft, targetCell.id);
  let continuationUnitId = resolveAttack(
    draft, attacker, defender, targetCell.id, attackStrength, powered, movesIntoTarget, hasDefense, events
  );
  // A failed attack may leave its attacker on the source tile (or the
  // defender may counterattack and kill it there); those are not departures.
  if (departureGarrison && !draft.units[defender.id]) {
    leaveDepartureGarrison(draft, sourceCell.id, attacker, departureGarrison, units, events);
  }
  applyCounterattack(draft, defender.id, continuationUnitId, hasDefense, events);
  if (continuationUnitId && !draft.units[continuationUnitId]) continuationUnitId = undefined;

  // Attacks are resolved by combat strength, not by the movement point decay.
  if (movesIntoTarget) {
    const arrivedCell = draft.cells[targetCell.id];
    const arrivingUnit = arrivedCell?.unitId ? draft.units[arrivedCell.unitId] : undefined;
    if (arrivingUnit && arrivingUnit.id === continuationUnitId && arrivingUnit.cellId === targetCell.id) {
      // Arrival reactions are resolved against the captured cell's current
      // state, after capture has updated occupancy and any powered connection.
      const destinationTerrain = requireTerrain(terrains, targetCell.terrainId);
      applyEntryExhaustion(draft, arrivingUnit.id, sourceTerrain, destinationTerrain, targetCell.id, events);
      // An attack that advances off a terrain must resolve the same departure
      // reaction as an ordinary move. In particular, leaving ocean for land
      // exhausts the arriving roamer even if a captured stronghold powers it.
      applyDepartureExhaustion(
        draft,
        arrivingUnit.id,
        sourceCell.id,
        sourceTerrain,
        destinationTerrain,
        events
      );
      applyCaptureArrivalExhaustion(draft, arrivingUnit.id, attackerDefinition, terrains, events);
    }
  }

  // Native minimum-strength exhaustion is resolved here. Declarative spatial
  // zone effects are applied by finalizeCommand before continuation is checked.
  applyMinimumStrengthExhaustion(draft, continuationUnitId, attacker, attackerDefinition, events);

  // Ranged/non-entering attacks have no terrain arrival reaction, so retain
  // their normal unpowered attack exhaustion. Captures are handled by the
  // destination terrain's enter capability above, using post-capture power.
  const attackerStayedAtSource = movesIntoTarget && continuationUnitId
    && draft.units[continuationUnitId]?.cellId !== targetCell.id;
  if (attackerStayedAtSource && continuationUnitId && draft.units[continuationUnitId]) {
    if (exhaustUnitForCurrentPhase(draft, continuationUnitId)) {
      events.push({ type: "unit-exhausted", message: "攻击未能推进，单位本回合失去行动力。" });
    }
  } else if (!movesIntoTarget && !powered && continuationUnitId
    && draft.units[continuationUnitId]
    && hasUnitCapability(attackerDefinition, UNIT_CAPABILITY.attackExhaustion)) {
    if (exhaustUnitForCurrentPhase(draft, continuationUnitId)) {
      events.push({ type: "unit-exhausted", message: "游兵完成攻击，本回合失去行动力。" });
    }
  }
  return succeed(draft, events, continuationUnitId
    && canContinueAction(draft, continuationUnitId, terrains, units) ? {
    continuation: {
      unitId: continuationUnitId,
      cellId: draft.units[continuationUnitId]?.cellId ?? attacker.cellId
    }
  } : undefined);
}

function reinforceUnit(
  state: GameState,
  command: Extract<GameCommand, { type: "reinforce-unit" }>,
  terrains: TerrainCatalog
): CommandResult {
  const unit = state.units[command.unitId];
  if (!unit) return fail(state, "unknown-unit", "找不到要强化的单位。");
  if (unit.ownerId !== command.actorId) return fail(state, "not-unit-owner", "只能给自己的单位投入点数。");
  const player = state.players[command.actorId];
  if (!player || player.reinforcementPoints < 1) {
    return fail(state, "insufficient-points", "没有可用点数。");
  }
  if (!getReinforceableUnitIds(state, terrains).has(unit.id)) {
    return fail(state, "unit-not-powered", "游兵不能投入点数；请先连接到据点。");
  }

  const draft = createDraft(state);
  draft.units[unit.id] = { ...unit, strength: unit.strength + 1 };
  draft.players[player.id] = { ...player, reinforcementPoints: player.reinforcementPoints - 1 };
  const events: GameEvent[] = [{
    type: "unit-reinforced",
    message: `${player.displayName} 为单位投入了 1 点。`
  }];
  advanceTurnIfNoReinforcementPoints(draft, terrains, events);
  return succeed(draft, events);
}

function endActionPhase(state: GameState): CommandResult {
  const current = state.players[state.turn.currentPlayerId];
  if (!current) return fail(state, "not-current-player", "找不到当前行动玩家。");

  const draft = createDraft(state);
  const events: GameEvent[] = [
    { type: "action-phase-ended", message: `${current.displayName} 结束了行动回合。` }
  ];
  enterReinforcementPhase(draft, events);
  return succeed(draft, events);
}

function endReinforcementPhase(state: GameState, terrains: TerrainCatalog): CommandResult {
  const current = state.players[state.turn.currentPlayerId];
  if (!current) return fail(state, "not-current-player", "找不到当前行动玩家。");

  const draft = createDraft(state);
  const events: GameEvent[] = [{ type: "reinforcement-phase-ended", message: `${current.displayName} 结束了加点回合。` }];
  startNextActionPhase(draft, terrains, events);
  return succeed(draft, events);
}

function moveIntoEmptyCell(
  draft: Draft,
  unit: UnitState,
  destinationId: CellId,
  movingStrength: number,
  powered: boolean,
  events: GameEvent[]
): UnitId | undefined {
  const sourceCell = draft.cells[unit.cellId];
  const destinationCell = draft.cells[destinationId];
  if (!sourceCell || !destinationCell) return undefined;

  if (powered) {
    const movedId = createSplitId(unit.id, draft.state.sequence);
    draft.units[unit.id] = { ...unit, strength: 1 };
    draft.units[movedId] = { ...unit, id: movedId, cellId: destinationId, strength: movingStrength };
    draft.cells[destinationId] = { ...destinationCell, unitId: movedId };
    draft.cells[unit.cellId] = withCellUnit(sourceCell, unit.id);
    events.push({ type: "unit-moved", message: "单位已移动到相邻格。" });
    return movedId;
  } else {
    draft.units[unit.id] = { ...unit, cellId: destinationId, strength: movingStrength };
    draft.cells[destinationId] = { ...destinationCell, unitId: unit.id };
  }
  draft.cells[unit.cellId] = withCellUnit(sourceCell, undefined);
  events.push({ type: "unit-moved", message: "单位已移动到相邻格。" });
  return unit.id;
}

function resolveAttack(
  draft: Draft,
  attacker: UnitState,
  defender: UnitState,
  destinationId: CellId,
  attackStrength: number,
  powered: boolean,
  movesIntoTarget: boolean,
  hasDefense: boolean,
  events: GameEvent[]
): UnitId | undefined {
  const sourceCell = draft.cells[attacker.cellId];
  const destinationCell = draft.cells[destinationId];
  if (!sourceCell || !destinationCell) return undefined;

  // `attackStrength` is already the forward force: a powered stack has kept
  // one point at its source; a roamer attacks with its full number. The old
  // action rule consumes one point only for an otherwise uneventful move, so
  // attacks use the +1 comparison/damage adjustment below instead.
  //
  // If `attackStrength + 1` beats B, B is removed. With defense available the
  // defender absorbs its strength from the advancing force; without defense
  // the whole forward force enters. If it does not beat B, B loses the forward
  // force, and an available defense kills the attacker; without defense the
  // attacker stays at A and is exhausted for this action phase.
  if (attackStrength + 1 > defender.strength) {
    // Without an available defense, a successful capture does not trade away
    // attacking points. A live defense absorbs the defender's strength first.
    const survivorStrength = hasDefense
      ? attackStrength - defender.strength
      : attackStrength;
    delete draft.units[defender.id];
    if (!movesIntoTarget) {
      draft.cells[destinationId] = withCellUnit(destinationCell, undefined);
      events.push({ type: "unit-attacked", message: "远程进攻成功，敌方单位被消灭。" });
      return attacker.id;
    }
    if (powered) {
      draft.units[attacker.id] = { ...attacker, strength: 1 };
      draft.cells[attacker.cellId] = { ...sourceCell, unitId: attacker.id };
    }
    if (survivorStrength < 1) {
      if (!powered) {
        delete draft.units[attacker.id];
        draft.cells[attacker.cellId] = withCellUnit(sourceCell, undefined);
      }
      draft.cells[destinationId] = withCellUnit(destinationCell, undefined);
      events.push({ type: "unit-attacked", message: "进攻成功，但兵力相抵，攻击单位未能推进。" });
      return undefined;
    }
    if (!powered) {
      delete draft.units[attacker.id];
      draft.cells[attacker.cellId] = withCellUnit(sourceCell, undefined);
    }
    const survivorId = createSplitId(attacker.id, draft.state.sequence);
    draft.units[survivorId] = {
      ...attacker,
      id: survivorId,
      cellId: destinationId,
      strength: survivorStrength
    };
    draft.cells[destinationId] = { ...destinationCell, unitId: survivorId };
    events.push({ type: "unit-attacked", message: "进攻成功，敌方单位被消灭。" });
    return survivorId;
  }

  draft.units[defender.id] = {
    ...defender,
    strength: defender.strength - attackStrength
  };
  events.push({ type: "unit-attacked", message: "进攻未能击破防守，防守方损失兵力。" });
  // A failed melee attack does not move the attacker. Keeping its id alive
  // lets the defender's configured reaction resolve normally; if there is no
  // reaction available, the unpowered attacker remains at its source and is
  // exhausted by the post-attack rule below.
  return attacker.id;
}

/** A defender may react independently of its own attack range. */
function applyCounterattack(
  draft: Draft,
  defenderId: UnitId,
  attackerId: UnitId | undefined,
  defenseWasAvailable: boolean,
  events: GameEvent[]
): void {
  if (!attackerId) return;
  const defender = draft.units[defenderId];
  const attacker = draft.units[attackerId];
  if (!defender || !attacker) return;
  if (!defenseWasAvailable) return;
  // The defense exchange is already represented by resolveAttack's strength
  // arithmetic. If the defender survived that exchange, the attacking stack
  // is eliminated; if it was broken, there is no separate retaliation.
  const attackerCell = draft.cells[attacker.cellId];
  if (attackerCell) draft.cells[attacker.cellId] = withCellUnit(attackerCell, undefined);
  delete draft.units[attacker.id];
  events.push({ type: "unit-counterattacked", message: "防守方反击，攻击单位被消灭。" });
}

function consumeCellDefense(draft: Draft, cellId: CellId): void {
  const used = draft.turn.counterattacksUsed[cellId] ?? 0;
  draft.turn = {
    ...draft.turn,
    counterattacksUsed: { ...draft.turn.counterattacksUsed, [cellId]: used + 1 }
  };
}

/** Shared rule/query for both combat resolution and the red/white target hint. */
export function canCounterattack(
  state: GameState,
  unitId: UnitId,
  terrains: TerrainCatalog,
  units: UnitCatalog
): boolean {
  const unit = state.units[unitId];
  if (!unit || state.turn.phase !== "action" || state.turn.exhaustedUnitIds.includes(unitId)) return false;
  const definition = units[unit.definitionId];
  if (!definition || !hasUnitCapability(definition, UNIT_CAPABILITY.counterattack)) return false;
  const cell = state.cells[unit.cellId];
  if (!cell) return false;
  const terrain = terrains[cell.terrainId];
  if (!terrain) return false;
  if (hasUnitCapability(definition, UNIT_CAPABILITY.terrainBoundCounterattack)
    && !getTerrainCapability(terrain, CAPABILITY.counterattackTerrainLimit)) return false;
  const used = state.turn.counterattacksUsed[cell.id] ?? 0;
  return used < getCounterattackLimit(terrain, definition);
}

/**
 * Resolve the destination terrain's "unpowered attacker captured a unit"
 * enter reaction. This is terrain-owned so optional terrain Mods can opt in
 * without adding special cases to the unit or attack implementation. Power is
 * recalculated after capture; if capture just powered the arriving unit, its
 * unit-level exhaust-after-attack capability no longer applies.
 */
function applyCaptureArrivalExhaustion(
  draft: Draft,
  unitId: UnitId,
  definition: UnitSpec,
  terrains: TerrainCatalog,
  events: GameEvent[]
): void {
  const unit = draft.units[unitId];
  if (!unit || !hasUnitCapability(definition, UNIT_CAPABILITY.attackExhaustion)) return;
  const cell = draft.cells[unit.cellId];
  if (!cell) return;
  const terrain = terrains[cell.terrainId];
  if (!terrain || !hasCellTrigger(
    draft.state, cell.id, "enter", CAPABILITY.attackCaptureExhaustion, terrain
  )) return;
  if (getPoweredUnitIds(asDraftState(draft), terrains).has(unitId)) return;
  if (exhaustUnitForCurrentPhase(draft, unitId)) {
    events.push({ type: "unit-exhausted", message: "游兵完成攻击，本回合失去行动力。" });
  }
}

/** A terrain's reaction limit overrides the unit's ordinary fallback limit. */
function getCounterattackLimit(terrain: TerrainSpec, unit: UnitSpec): number {
  const configured = getTerrainCapability(terrain, CAPABILITY.counterattackTerrainLimit)?.config?.maxPerActionPhase;
  if (configured === "unlimited") return Number.POSITIVE_INFINITY;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) return configured;
  return getConfiguredMax(unit, UNIT_CAPABILITY.counterattackLimit, "maxPerActionPhase") ?? 1;
}

/** A terrain may exhaust a unit when it leaves, independently of movement. */
function applyDepartureExhaustion(
  draft: Draft,
  unitId: UnitId | undefined,
  sourceCellId: CellId,
  sourceTerrain: TerrainSpec,
  destinationTerrain: TerrainSpec,
  events: GameEvent[]
): void {
  if (!unitId || !draft.units[unitId]) return;
  if (!hasCellTrigger(draft.state, sourceCellId, "leave", CAPABILITY.departureExhaustion, sourceTerrain)) return;
  const capability = getTerrainCapability(sourceTerrain, CAPABILITY.departureExhaustion);
  if (!capability) return;
  if (capability.config?.triggerMode === "terrain-transition" && sourceTerrain.id === destinationTerrain.id) return;
  // Read old releases without changing their behaviour; new Mods use triggerMode.
  const destinationTerrainIdNot = capability.config?.destinationTerrainIdNot;
  if (typeof destinationTerrainIdNot === "string" && destinationTerrain.id === destinationTerrainIdNot) return;
  if (exhaustUnitForCurrentPhase(draft, unitId)) {
    events.push({ type: "unit-exhausted", message: "单位离开该地形，本回合失去行动力。" });
  }
}

/** A terrain may exhaust a unit when it enters, optionally only from another terrain type. */
function applyEntryExhaustion(
  draft: Draft,
  unitId: UnitId | undefined,
  sourceTerrain: TerrainSpec,
  destinationTerrain: TerrainSpec,
  destinationCellId: CellId,
  events: GameEvent[]
): void {
  if (!unitId || !draft.units[unitId]) return;
  if (!hasCellTrigger(draft.state, destinationCellId, "enter", CAPABILITY.entryExhaustion, destinationTerrain)) return;
  const capability = getTerrainCapability(destinationTerrain, CAPABILITY.entryExhaustion);
  if (!capability) return;
  if (capability.config?.triggerMode === "terrain-transition" && sourceTerrain.id === destinationTerrain.id) return;
  if (exhaustUnitForCurrentPhase(draft, unitId)) {
    events.push({ type: "unit-exhausted", message: "单位进入该地形，本回合失去行动力。" });
  }
}

/**
 * Handles the base roamer's "one point can make a final move" rule. The
 * check uses strength before the action: a two-point roamer moves as one
 * point and may still make that final one-point action; a one-point roamer
 * stays at one and is exhausted after the action. This is deliberately a
 * turn-scoped flag rather than a UI-only selection state.
 */
function applyMinimumStrengthExhaustion(
  draft: Draft,
  resultUnitId: UnitId | undefined,
  unitBeforeAction: UnitState,
  definition: UnitSpec,
  events: GameEvent[]
): void {
  const actionDecay = getActionStrengthDecay(definition);
  if (!resultUnitId || !draft.units[resultUnitId] || !actionDecay) return;
  if (unitBeforeAction.strength > actionDecay.minimumStrength) return;
  if (exhaustUnitForCurrentPhase(draft, resultUnitId)) {
    events.push({ type: "unit-exhausted", message: "单位以 1 点完成行动，本回合失去行动力。" });
  }
}

/** A shared mutation for every source of turn-scoped exhaustion. */
function exhaustUnitForCurrentPhase(draft: Draft, unitId: UnitId): boolean {
  if (draft.turn.exhaustedUnitIds.includes(unitId)) return false;
  draft.turn = {
    ...draft.turn,
    exhaustedUnitIds: [...draft.turn.exhaustedUnitIds, unitId]
  };
  return true;
}

interface DepartureGarrison {
  /** The strength reserved in the terrain's source cell. */
  readonly strength: number;
  /** 留兵触发前置条件；缺省时按旧定义解释为无条件留兵。 */
  readonly requires: "occupied" | "powered-occupant";
  /** Optional explicit unit type for the resident; defaults to the departing type. */
  readonly unitDefinitionId?: string;
}

/**
 * A terrain can reserve a unit when an occupier leaves it. This is a terrain
 * rule instead of a power rule: oil fields intentionally do not conduct or
 * supply electricity, yet can still keep a one-point roaming resident.
 */
function getDepartureGarrison(terrain: TerrainSpec, departingUnitIsPowered: boolean): DepartureGarrison | undefined {
  const capability = getTerrainCapability(terrain, CAPABILITY.departureGarrison);
  const config = capability?.config;
  const strength = config?.strength;
  if (typeof strength !== "number" || !Number.isInteger(strength) || strength < 1) return undefined;
  const configuredRequirement = config?.requires;
  if (configuredRequirement !== undefined
    && configuredRequirement !== "occupied" && configuredRequirement !== "powered-occupant") return undefined;
  const requires = configuredRequirement ?? "occupied";
  if (requires === "powered-occupant" && !departingUnitIsPowered) return undefined;
  const unitDefinitionId = config?.unitDefinitionId;
  return {
    strength,
    requires,
    ...(typeof unitDefinitionId === "string" ? { unitDefinitionId } : {})
  };
}

/**
 * Mod/map triggers are precompiled per cell by the map loader. Older manually
 * constructed states have no trigger index, so they retain capability-based
 * behavior until their snapshot is refreshed from map code.
 */
function hasCellTrigger(
  state: GameState,
  cellId: CellId,
  phase: "enter" | "leave",
  relationId: string,
  fallbackTerrain?: TerrainSpec
): boolean {
  if (state.cellTriggers) {
    return state.cellTriggers[cellId]?.[phase].some((trigger) => trigger.relationId === relationId) ?? false;
  }
  return fallbackTerrain ? hasTerrainCapability(fallbackTerrain, relationId) : false;
}

/**
 * Called only after a move or moving attack has vacated the source cell. The
 * generated resident is immediately exhausted, so it visibly occupies the
 * terrain but cannot be selected for another action in this action phase.
 */
function leaveDepartureGarrison(
  draft: Draft,
  sourceCellId: CellId,
  departingUnit: UnitState,
  garrison: DepartureGarrison,
  units: UnitCatalog,
  events: GameEvent[]
): void {
  const sourceCell = draft.cells[sourceCellId];
  if (!sourceCell) return;

  let garrisonId = sourceCell.unitId;
  if (!garrisonId) {
    const definitionId = garrison.unitDefinitionId ?? departingUnit.definitionId;
    if (!units[definitionId]) return;
    garrisonId = createGarrisonId(departingUnit.id, draft.state.sequence);
    draft.units[garrisonId] = {
      ...departingUnit,
      id: garrisonId,
      definitionId,
      cellId: sourceCellId,
      strength: garrison.strength
    };
    draft.cells[sourceCellId] = { ...sourceCell, unitId: garrisonId };
  }

  if (exhaustUnitForCurrentPhase(draft, garrisonId)) {
    events.push({ type: "unit-exhausted", message: "地形留下 1 点留守游兵，本回合不能行动。" });
  }
}

/** Predict the points awarded to a player at the start of their next turn. */
export function calculateReinforcementIncome(
  state: GameState,
  playerId: PlayerId,
  terrains: TerrainCatalog
): number {
  const powered = getPoweredUnitIds(state, terrains);
  let income = 0;
  for (const cell of Object.values(state.cells)) {
    if (!cell.unitId) continue;
    const unit = state.units[cell.unitId];
    if (!unit) continue;
    if (unit.ownerId !== playerId) continue;
    const terrain = requireTerrain(terrains, cell.terrainId);
    const source = getMatchTerrainCapability(state, terrain, CAPABILITY.income);
    if (!source?.config) continue;
    const amount = source.config.amount;
    const requires = source.config.requires;
    const condition = source.config.condition;
    const when = source.config.when;
    // 旧版收益定义没有 when 字段时，沿用原来的“己方回合开始”时机。
    if (typeof amount !== "number" || when !== undefined && when !== "owner-turn-start") continue;
    if (requires !== undefined && requires !== "occupied" && requires !== "powered-occupant") continue;
    if (requires === "powered-occupant" && !powered.has(unit.id)) continue;
    if (condition !== undefined && (!isRecord(condition) || typeof condition.op !== "string"
      || !matchesSpatialPredicate(state, terrains, cell.id, playerId, condition as unknown as SpatialPredicate, powered))) continue;
    if (amount > 0) income += amount;
  }
  return income;
}

function grantReinforcementIncome(
  draft: Draft,
  player: PlayerState,
  terrains: TerrainCatalog,
  events: GameEvent[]
): void {
  const income = calculateReinforcementIncome(asDraftState(draft), player.id, terrains);
  if (income > 0) {
    draft.players[player.id] = {
      ...(draft.players[player.id] ?? player),
      reinforcementPoints: (draft.players[player.id] ?? player).reinforcementPoints + income
    };
    events.push({ type: "points-granted", message: `${player.displayName} 获得 ${income} 点收益。` });
  }
}

/** Action resolution never changes the already-calculated points of this turn. */
function enterReinforcementPhase(draft: Draft, events: GameEvent[]): void {
  const current = draft.players[draft.turn.currentPlayerId];
  if (!current) return;
  draft.turn = { ...draft.turn, phase: "reinforcement", exhaustedUnitIds: [] };
  events.push({ type: "reinforcement-phase-started", message: `现在进入 ${current.displayName} 的加点回合。` });
}

/** Mirrors the old reviseCombatUnit() behaviour after a successful action. */
function enterReinforcementIfNoActions(
  draft: Draft,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  events: GameEvent[]
): boolean {
  if (draft.turn.phase !== "action") return false;
  if (hasAnyActionableUnit(asDraftState(draft), terrains, units)) return false;
  const current = draft.players[draft.turn.currentPlayerId];
  events.push({
    type: "action-phase-ended",
    message: `${current?.displayName ?? "当前玩家"} 已无可行动单位，自动结束行动回合。`
  });
  enterReinforcementPhase(draft, events);
  return true;
}

/** Short-circuit phase checks; callers only need to know whether one action exists. */
function hasAnyActionableUnit(state: GameState, terrains: TerrainCatalog, units: UnitCatalog): boolean {
  if (state.turn.phase !== "action") return false;
  for (const unit of Object.values(state.units)) {
    if (unit.ownerId === state.turn.currentPlayerId
      && getLegalActionDestinationIds(state, unit.id, terrains, units).length > 0) return true;
  }
  return false;
}

/** A continuation is emitted only when its concrete result unit can act again. */
function canContinueAction(
  draft: Draft,
  unitId: UnitId,
  terrains: TerrainCatalog,
  units: UnitCatalog
): boolean {
  return getLegalActionDestinationIds(asDraftState(draft), unitId, terrains, units).length > 0;
}

/** Mirrors the old bonusEvent() behaviour: spending the final point advances the seat. */
function advanceTurnIfNoReinforcementPoints(
  draft: Draft,
  terrains: TerrainCatalog,
  events: GameEvent[]
): boolean {
  const current = draft.players[draft.turn.currentPlayerId];
  if (!current || current.reinforcementPoints > 0) return false;
  events.push({ type: "reinforcement-phase-ended", message: `${current.displayName} 已用完点数，自动结束加点回合。` });
  startNextActionPhase(draft, terrains, events);
  return true;
}

/** Starts a seat's action phase and calculates that seat's points exactly once. */
function startNextActionPhase(
  draft: Draft,
  terrains: TerrainCatalog,
  events: GameEvent[]
): void {
  const current = draft.players[draft.turn.currentPlayerId];
  const players = Object.values(draft.players).sort((left, right) => left.seat - right.seat);
  const currentIndex = players.findIndex((player) => player.id === current?.id);
  // Players whose armies have been eliminated no longer receive turns.
  const alive = new Set(Object.values(draft.units).map((unit) => unit.ownerId));
  const next = Array.from({ length: players.length }, (_, offset) =>
    players[(currentIndex + 1 + offset) % players.length]
  ).find((player) => player && alive.has(player.id));
  if (!current || !next) return;
  draft.turn = {
    phase: "action",
    currentPlayerId: next.id,
    round: next.seat <= current.seat ? draft.turn.round + 1 : draft.turn.round,
    exhaustedUnitIds: [],
    counterattacksUsed: {}
  };
  grantReinforcementIncome(draft, next, terrains, events);
  events.push({ type: "turn-started", message: `现在轮到 ${next.displayName} 的行动回合。` });
}

/**
 * Applies all state transitions shared by local UI, server validation and AI
 * simulation.  In particular, losing a source can cut a whole power network:
 * old Numeral Lord removed one point from every newly disconnected unit and
 * destroyed one-point units immediately.  This is a topology transition, not
 * a turn-end effect, so it belongs immediately after a successful command.
 */
function finalizeCommand(
  previousState: GameState,
  result: CommandResult,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  matchConditions: MatchConditionCatalog,
  command: GameCommand
): CommandResult {
  if (!result.accepted) return result;

  // Native transitions (move/attack/reinforce) are resolved first; data-only
  // Mod rules then observe that committed result and may apply deterministic
  // follow-up effects before power-loss and victory checks run.
  let ruledState: GameState;
  try {
    ruledState = applyModRules(previousState, result.state, command, terrains, false,
      (current, unitId) => getPoweredUnitIds(current, terrains).has(unitId));
  } catch {
    return fail(previousState, "mod-rule-error", "地块 Mod 规则计算失败，操作未生效。请检查地图依赖的 Mod 版本。");
  }
  const draft = createDraft(ruledState);
  const events = [...result.events];
  const alreadyReportedExhaustion = new Set(result.state.turn.exhaustedUnitIds);
  for (const unitId of ruledState.turn.exhaustedUnitIds) {
    if (!alreadyReportedExhaustion.has(unitId) && ruledState.units[unitId]) {
      events.push({ type: "unit-exhausted", message: "单位触发地块规则，本回合失去行动力。" });
    }
  }
  applyPowerLossAfterTransition(previousState, draft, terrains, events);
  resolveMatchConditions(draft, terrains, matchConditions, events);

  // Power loss or a condition may remove the only remaining actionable unit.
  // Re-evaluate from the finished state rather than leaving the player stuck
  // in an action phase that has no legal action.
  enterReinforcementIfNoActions(draft, terrains, units, events);

  const finalState = asDraftState(draft);
  const continuation = result.outcome?.continuation;
  const outcome = continuation
    && finalState.turn.phase === "action"
    && getLegalActionDestinationIds(finalState, continuation.unitId, terrains, units).length > 0
    ? { continuation }
    : undefined;

  return {
    accepted: true,
    state: finalState,
    events,
    ...(outcome ? { outcome } : {})
  };
}

interface PowerComponent {
  readonly unitIds: ReadonlySet<UnitId>;
  readonly hasSource: boolean;
}

/**
 * Returns the conductive unit component containing `startUnitId`.
 * Unlike getPoweredUnitIds this is intentionally local: it is used only after
 * a unit was removed, so it can answer "does this affected component still
 * contain a source?" without scanning unrelated players or map regions.
 */
function getPowerComponent(
  state: GameState,
  startUnitId: UnitId,
  terrains: TerrainCatalog
): PowerComponent {
  const start = state.units[startUnitId];
  const startCell = start ? state.cells[start.cellId] : undefined;
  if (!start || !startCell) return { unitIds: new Set(), hasSource: false };
  const startTerrain = requireTerrain(terrains, startCell.terrainId);
  if (!hasTerrainCapability(startTerrain, CAPABILITY.conductor)) {
    return { unitIds: new Set(), hasSource: false };
  }

  const unitIds = new Set<UnitId>();
  const queue: UnitId[] = [startUnitId];
  let hasSource = false;
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || unitIds.has(currentId)) continue;
    const current = state.units[currentId];
    const currentCell = current ? state.cells[current.cellId] : undefined;
    if (!current || !currentCell) continue;
    const currentTerrain = requireTerrain(terrains, currentCell.terrainId);
    if (!hasTerrainCapability(currentTerrain, CAPABILITY.conductor)) continue;

    unitIds.add(currentId);
    if (hasTerrainCapability(currentTerrain, CAPABILITY.source)) hasSource = true;
    for (const neighbour of getHexNeighbours(currentCell.coordinate, state.board)) {
      const neighbourCell = state.cells[toCellId(neighbour)];
      const neighbourUnit = neighbourCell?.unitId ? state.units[neighbourCell.unitId] : undefined;
      if (neighbourUnit && neighbourUnit.ownerId === current.ownerId && !unitIds.has(neighbourUnit.id)) {
        queue.push(neighbourUnit.id);
      }
    }
  }
  return { unitIds, hasSource };
}

/** Applies the legacy -1 / destroy-at-1 rule only to components split by a death. */
function applyPowerLossAfterTransition(
  previousState: GameState,
  draft: Draft,
  terrains: TerrainCatalog,
  events: GameEvent[]
): void {
  const componentCache = new Map<UnitId, PowerComponent>();
  const getCachedComponent = (unitId: UnitId): PowerComponent => {
    const cached = componentCache.get(unitId);
    if (cached) return cached;
    const component = getPowerComponent(previousState, unitId, terrains);
    for (const componentUnitId of component.unitIds) componentCache.set(componentUnitId, component);
    componentCache.set(unitId, component);
    return component;
  };

  // A move keeps a powered source anchor in the old cell. Therefore only unit
  // ids that disappeared from the snapshot can split a power component.
  const removedPoweredUnitIds: UnitId[] = [];
  const poweredBeforeComponentIds = new Set<UnitId>();
  for (const unit of Object.values(previousState.units)) {
    if (draft.units[unit.id]) continue;
    const component = getCachedComponent(unit.id);
    if (!component.hasSource) continue;
    removedPoweredUnitIds.push(unit.id);
    for (const componentUnitId of component.unitIds) poweredBeforeComponentIds.add(componentUnitId);
  }
  if (removedPoweredUnitIds.length === 0) return;

  const afterState = asDraftState(draft);
  const inspectedAfter = new Set<UnitId>();
  const unitsToDepower = new Set<UnitId>();
  for (const removedId of removedPoweredUnitIds) {
    const removed = previousState.units[removedId];
    const removedCell = removed ? previousState.cells[removed.cellId] : undefined;
    if (!removedCell) continue;

    for (const neighbour of getHexNeighbours(removedCell.coordinate, previousState.board)) {
      const neighbourCellId = toCellId(neighbour);
      const neighbourCell = afterState.cells[neighbourCellId];
      const neighbourId = neighbourCell?.unitId;
      if (!neighbourId || !poweredBeforeComponentIds.has(neighbourId) || inspectedAfter.has(neighbourId)) continue;

      const afterComponent = getPowerComponent(afterState, neighbourId, terrains);
      for (const componentUnitId of afterComponent.unitIds) inspectedAfter.add(componentUnitId);
      if (afterComponent.hasSource) continue;

      // New units that entered during this command were never powered before,
      // so only old members of the split component can lose a point here.
      for (const componentUnitId of afterComponent.unitIds) {
        if (poweredBeforeComponentIds.has(componentUnitId)) unitsToDepower.add(componentUnitId);
      }
    }
  }

  for (const unitId of unitsToDepower) {
    const unit = draft.units[unitId];
    if (!unit) continue;
    if (unit.strength <= 1) {
      removeUnit(draft, unitId);
      events.push({ type: "unit-destroyed", message: "单位失去电力时仅剩 1 点，已阵亡。" });
    } else {
      draft.units[unitId] = { ...unit, strength: unit.strength - 1 };
      events.push({ type: "unit-depowered", message: "单位失去电力，兵力减少 1 点。" });
    }
  }
}

/** Runs ordered map modules after every state transition. */
function resolveMatchConditions(
  draft: Draft,
  terrains: TerrainCatalog,
  matchConditions: MatchConditionCatalog,
  events: GameEvent[]
): void {
  const catalog: MatchConditionCatalog = { ...DEFAULT_MATCH_CONDITIONS, ...matchConditions };
  const conditionIds = draft.state.settings.matchConditionIds ?? ["core/last-team-standing"];

  // First apply all eliminations. This lets a later last-team-standing module
  // see the actual board after a player lost every survival anchor.
  for (const conditionId of conditionIds) {
    const condition = catalog[conditionId];
    if (!condition) throw new Error(`Match condition is not registered: ${conditionId}`);
    const effect = condition.evaluate(asDraftState(draft), terrains);
    for (const playerId of effect?.eliminatePlayerIds ?? []) {
      const player = draft.players[playerId];
      const ownedUnitIds = Object.values(draft.units)
        .filter((unit) => unit.ownerId === playerId)
        .map((unit) => unit.id);
      if (!player || ownedUnitIds.length === 0) continue;
      for (const unitId of ownedUnitIds) removeUnit(draft, unitId);
      draft.players[playerId] = { ...player, reinforcementPoints: 0 };
      events.push({ type: "player-eliminated", message: `${player.displayName} 失去全部据点，其余单位阵亡。` });
    }
  }

  for (const conditionId of conditionIds) {
    const condition = catalog[conditionId];
    if (!condition) continue;
    const effect = condition.evaluate(asDraftState(draft), terrains);
    if (!effect?.finish || draft.turn.phase === "finished") continue;
    draft.result = {
      winningTeamIds: [...effect.finish.winningTeamIds],
      ...(effect.finish.message ? { message: effect.finish.message } : {})
    };
    draft.turn = { ...draft.turn, phase: "finished" };
    events.push({
      type: "match-finished",
      message: effect.finish.message
        ?? `队伍 ${effect.finish.winningTeamIds[0] ?? "无"} 获胜。`
    });
  }
}

/** Removes a unit and all ephemeral references to it in a consistent way. */
function removeUnit(draft: Draft, unitId: UnitId): void {
  const unit = draft.units[unitId];
  if (!unit) return;
  const cell = draft.cells[unit.cellId];
  if (cell?.unitId === unitId) draft.cells[unit.cellId] = withCellUnit(cell, undefined);
  delete draft.units[unitId];
  draft.turn = {
    ...draft.turn,
    exhaustedUnitIds: draft.turn.exhaustedUnitIds.filter((id) => id !== unitId)
  };
}

function createDraft(state: GameState): Draft {
  return {
    state,
    units: { ...state.units },
    cells: { ...state.cells },
    players: { ...state.players },
    turn: {
      ...state.turn,
      exhaustedUnitIds: [...state.turn.exhaustedUnitIds],
      counterattacksUsed: { ...state.turn.counterattacksUsed }
    },
    result: state.result
      ? { ...state.result, winningTeamIds: [...state.result.winningTeamIds] }
      : undefined
  };
}

/** Exposes a draft to pure derived-rule helpers without committing a sequence. */
function asDraftState(draft: Draft): GameState {
  return {
    ...draft.state,
    units: draft.units,
    cells: draft.cells,
    players: draft.players,
    turn: draft.turn,
    ...(draft.result ? { result: draft.result } : {})
  };
}

function succeed(draft: Draft, events: readonly GameEvent[], outcome?: ActionOutcome): CommandResult {
  return {
    accepted: true,
    events,
    state: {
      ...draft.state,
      sequence: draft.state.sequence + 1,
      units: draft.units,
      cells: draft.cells,
      players: draft.players,
      turn: draft.turn,
      ...(draft.result ? { result: draft.result } : {})
    },
    ...(outcome ? { outcome } : {})
  };
}

function fail(
  state: GameState,
  code: CommandFailure["code"],
  message: string
): CommandResult {
  return { accepted: false, state, error: { code, message } };
}

function requireTerrain(catalog: TerrainCatalog, terrainId: string): TerrainSpec {
  const terrain = catalog[terrainId];
  if (!terrain) throw new Error(`Terrain is not registered: ${terrainId}`);
  return terrain;
}

function areSameTeam(state: GameState, left: PlayerId, right: PlayerId): boolean {
  const leftTeam = state.players[left]?.teamId;
  const rightTeam = state.players[right]?.teamId;
  // Neutral map pieces deliberately have reserved owner ids absent from the
  // player roster. Two missing lookups must not make them appear allied.
  return leftTeam !== undefined && rightTeam !== undefined && leftTeam === rightTeam;
}

function getConfiguredMax(
  unit: UnitSpec,
  capabilityId: string,
  key: string
): number | undefined {
  const value = getUnitCapability(unit, capabilityId)?.config?.[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A map can opt a unit into the old powered-unit action threshold independently of move/attack. */
function hasEnoughStrengthToAct(unit: UnitState, definition: UnitSpec, powered: boolean): boolean {
  if (!powered) return true;
  const minimum = getConfiguredMax(definition, UNIT_CAPABILITY.poweredActionThreshold, "minimumStrength");
  return minimum === undefined || unit.strength >= minimum;
}

interface ActionStrengthDecay {
  readonly amount: number;
  readonly minimumStrength: number;
}

/**
 * Opt-in unit rule for the old roaming-unit lifecycle. It is intentionally
 * separate from attacks: a Mod can create a unit with its own movement decay.
 */
function getActionStrengthDecay(definition: UnitSpec): ActionStrengthDecay | undefined {
  const capability = getUnitCapability(definition, UNIT_CAPABILITY.actionStrengthDecay);
  if (!capability) return undefined;
  const amount = getConfiguredMax(definition, UNIT_CAPABILITY.actionStrengthDecay, "amount");
  const minimumStrength = getConfiguredMax(
    definition,
    UNIT_CAPABILITY.actionStrengthDecay,
    "minimumStrength"
  );
  if (amount === undefined || minimumStrength === undefined) return undefined;
  return { amount, minimumStrength };
}

/**
 * A powered movement keeps exactly one point as its source-cell anchor. Its
 * outgoing branch therefore applies the same configured decay directly. An
 * unpowered unit leaves no anchor, but still cannot fall below its configured
 * minimum strength.
 */
function getMovingStrengthAfterAction(unit: UnitState, definition: UnitSpec, powered: boolean): number {
  const actionDecay = getActionStrengthDecay(definition);
  if (powered) return unit.strength - (actionDecay?.amount ?? 1);
  if (!actionDecay) return unit.strength;
  return Math.max(actionDecay.minimumStrength, unit.strength - actionDecay.amount);
}

function getAttackRange(unit: UnitSpec): { readonly min: number; readonly max: number } | undefined {
  const capability = getUnitCapability(unit, UNIT_CAPABILITY.attackRange);
  const min = capability?.config?.min;
  const max = capability?.config?.max;
  if (
    typeof min !== "number" || !Number.isInteger(min) || min < 1
    || typeof max !== "number" || !Number.isInteger(max) || max < min
  ) return undefined;
  return { min, max };
}

function createSplitId(unitId: UnitId, sequence: number): UnitId {
  return `${unitId}@${sequence}` as UnitId;
}

function createGarrisonId(unitId: UnitId, sequence: number): UnitId {
  return `${unitId}@garrison@${sequence}` as UnitId;
}

function withCellUnit(cell: MapCell, unitId: UnitId | undefined): MapCell {
  if (unitId) return { ...cell, unitId };
  const { unitId: ignored, ...emptyCell } = cell;
  void ignored;
  return emptyCell;
}
