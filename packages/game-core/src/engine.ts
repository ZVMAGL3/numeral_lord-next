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
import { getHexDistance, getHexNeighbours, toCellId, type HexBounds } from "./hex.js";
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
  departureExhaustion: "core/exhaust-on-departure",
  hostileExhaustion: "core/adjacent-hostile-exhaustion",
  departureGarrison: "core/departure-garrison",
  counterattackTerrainLimit: "core/counterattack-terrain-limit"
} as const;

const UNIT_CAPABILITY = {
  move: "core/move",
  attack: "core/attack",
  attackRange: "core/attack-range",
  counterattack: "core/counterattack",
  counterattackLimit: "core/counterattack-limit",
  actionStrengthDecay: "core/action-strength-decay",
  poweredActionThreshold: "core/powered-action-threshold",
  poweredIncome: "core/powered-income",
  attackExhaustion: "core/exhaust-after-attack"
} as const;

// GameState snapshots are immutable by contract. Cache one derived power set
// per (state snapshot, terrain catalog), so getLegalActionDestinationIds can
// ask the same question for several units without repeating the BFS. WeakMaps
// release old snapshots after a command replaces them.
const poweredCache = new WeakMap<GameState, WeakMap<TerrainCatalog, ReadonlySet<UnitId>>>();

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
      return finalizeCommand(state, moveUnit(state, command, terrains, units), terrains, units, matchConditions);
    case "attack-unit":
      if (state.turn.phase !== "action") return fail(state, "wrong-phase", "加点回合不能移动或攻击。");
      return finalizeCommand(state, attackUnit(state, command, terrains, units), terrains, units, matchConditions);
    case "reinforce-unit":
      if (state.turn.phase !== "reinforcement") return fail(state, "wrong-phase", "请先结束行动，进入加点回合。");
      return finalizeCommand(state, reinforceUnit(state, command, terrains, units), terrains, units, matchConditions);
    case "end-action-phase":
      if (state.turn.phase !== "action") return fail(state, "wrong-phase", "当前不是行动回合。");
      return finalizeCommand(state, endActionPhase(state), terrains, units, matchConditions);
    case "end-reinforcement-phase":
      if (state.turn.phase !== "reinforcement") return fail(state, "wrong-phase", "当前不是加点回合。");
      return finalizeCommand(state, endReinforcementPhase(state, terrains, units), terrains, units, matchConditions);
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
  grantReinforcementIncome(draft, current, terrains, units, events);
  events.push({ type: "turn-started", message: `现在轮到 ${current.displayName} 的行动回合。` });
  resolveMatchConditions(draft, terrains, matchConditions, events);
  return { state: asDraftState(draft), events };
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
 * Derived, never persisted: a unit is powered only through a friendly chain.
 *
 * Algorithm (breadth-first search / BFS):
 * 1. Run once per player. Power never crosses an owner boundary, even when
 *    two players are teammates or friendly fire is enabled.
 * 2. Seed the queue with that player's units standing on a terrain that has
 *    both `core/power-source` and `core/power-conductor`. In the core pack
 *    this is an occupied stronghold. An empty stronghold cannot be a seed
 *    because only a unit can be added to the queue.
 * 3. Pop one powered unit and inspect the six hex neighbours. A neighbour is
 *    added only when it has a same-owner unit and its terrain has
 *    `core/power-conductor`. The unit itself is the bridge: an empty plain
 *    does not transmit power to a distant unit.
 * 4. `visited` prevents loops when units form a ring. Each unit and each
 *    adjacent edge is examined at most once, so the work is O(V + E) for the
 *    units in the board.
 *
 * This is a fresh implementation for the normalized `{cells, units}` model;
 * it preserves the old store's connected-component rule without keeping the
 * old mutable `specialForces` set. Callers derive it again from state after
 * every command, so a unit becomes powered or unpowered immediately when the
 * board topology changes.
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
  const bounds: HexBounds = state.board;

  // A separate traversal for each player prevents one player's stronghold from
  // powering another player's units through an otherwise conductive chain.
  for (const player of Object.values(state.players)) {
    // `frontier` is the BFS queue; `visited` is separate from `powered` so a
    // unit is enqueued once even if several powered neighbours point to it.
    const frontier: UnitId[] = [];
    const visited = new Set<UnitId>();

    // Find all occupied, conductive power sources owned by this player.
    for (const unit of Object.values(state.units)) {
      if (unit.ownerId !== player.id) continue;
      const cell = state.cells[unit.cellId];
      if (!cell) continue;
      const terrain = requireTerrain(terrains, cell.terrainId);
      if (
        hasTerrainCapability(terrain, CAPABILITY.conductor)
        && hasTerrainCapability(terrain, CAPABILITY.source)
      ) {
        frontier.push(unit.id);
        visited.add(unit.id);
        powered.add(unit.id);
      }
    }

    // Expand through friendly units on conductive terrain.
    while (frontier.length > 0) {
      const currentId = frontier.shift();
      if (!currentId) continue;
      const current = state.units[currentId];
      if (!current) continue;
      const currentCell = state.cells[current.cellId];
      if (!currentCell) continue;

      for (const neighbour of getHexNeighbours(currentCell.coordinate, bounds)) {
        const neighbourId = toCellId(neighbour);
        const neighbourCell = state.cells[neighbourId];
        const neighbourUnit = neighbourCell?.unitId
          ? state.units[neighbourCell.unitId]
          : undefined;
        // Empty cells, enemy units and already visited units terminate this
        // edge. A conductive empty cell is intentionally not a power bridge.
        if (!neighbourCell || !neighbourUnit || neighbourUnit.ownerId !== player.id || visited.has(neighbourUnit.id)) {
          continue;
        }
        const neighbourTerrain = requireTerrain(terrains, neighbourCell.terrainId);
        if (!hasTerrainCapability(neighbourTerrain, CAPABILITY.conductor)) continue;

        visited.add(neighbourUnit.id);
        powered.add(neighbourUnit.id);
        frontier.push(neighbourUnit.id);
      }
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
  const unit = state.units[unitId];
  if (state.turn.phase !== "action" || !unit || unit.ownerId !== state.turn.currentPlayerId) return [];
  if (state.turn.exhaustedUnitIds.includes(unit.id)) return [];

  const sourceCell = state.cells[unit.cellId];
  if (!sourceCell) return [];
  const sourceTerrain = requireTerrain(terrains, sourceCell.terrainId);
  const departureGarrison = hasCellTrigger(state, sourceCell.id, "leave", CAPABILITY.departureGarrison, sourceTerrain)
    ? getDepartureGarrison(sourceTerrain) : undefined;
  const canLeaveSource = !departureGarrison || unit.strength > departureGarrison.strength;
  const unitDefinition = units[unit.definitionId];
  if (!unitDefinition) return [];

  const powered = getPoweredUnitIds(state, terrains).has(unit.id);
  if (!hasEnoughStrengthToAct(unit, unitDefinition, powered)) return [];
  const legal = new Set<CellId>();
  const moveRange = getConfiguredMax(unitDefinition, UNIT_CAPABILITY.move, "maxDistance");
  if (moveRange && canLeaveSource) {
    for (const cell of Object.values(state.cells)) {
      if (cell.unitId) continue;
      const terrain = requireTerrain(terrains, cell.terrainId);
      if (!hasTerrainCapability(terrain, CAPABILITY.occupiable)) continue;
      const distance = getHexDistance(sourceCell.coordinate, cell.coordinate, state.board);
      if (distance && distance <= moveRange) legal.add(cell.id);
    }
  }

  const attackRange = getAttackRange(unitDefinition);
  const attackCapability = getUnitCapability(unitDefinition, UNIT_CAPABILITY.attack);
  const attackMovesIntoTarget = attackCapability?.config?.movesIntoTarget !== false;
  if (attackCapability && attackRange && (!attackMovesIntoTarget || canLeaveSource)) {
    for (const cell of Object.values(state.cells)) {
      const target = cell.unitId ? state.units[cell.unitId] : undefined;
      if (!target || (areSameTeam(state, unit.ownerId, target.ownerId) && !state.settings.friendlyFire)) continue;
      const distance = getHexDistance(sourceCell.coordinate, cell.coordinate, state.board);
      if (distance !== undefined && distance >= attackRange.min && distance <= attackRange.max) legal.add(cell.id);
    }
  }
  return [...legal];
}

/** Units that can presently produce at least one legal action. */
export function getActionableUnitIds(
  state: GameState,
  terrains: TerrainCatalog,
  units: UnitCatalog
): ReadonlySet<UnitId> {
  if (state.turn.phase !== "action") return new Set<UnitId>();

  return new Set(Object.values(state.units)
    .filter((unit) => unit.ownerId === state.turn.currentPlayerId)
    .filter((unit) => getLegalActionDestinationIds(state, unit.id, terrains, units).length > 0)
    .map((unit) => unit.id));
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
  const departureGarrison = hasCellTrigger(state, sourceCell.id, "leave", CAPABILITY.departureGarrison, sourceTerrain)
    ? getDepartureGarrison(sourceTerrain) : undefined;
  if (departureGarrison && unit.strength <= departureGarrison.strength) {
    return fail(state, "insufficient-strength", "该地形需要留下 1 点留守游兵，至少需要 2 点才能离开。");
  }
  if (departureGarrison && !units[departureGarrison.unitDefinitionId ?? unit.definitionId]) {
    return fail(state, "invalid-unit-definition", "该地形配置的留守兵种不存在。");
  }
  const moveRange = getConfiguredMax(unitDefinition, UNIT_CAPABILITY.move, "maxDistance");
  if (!moveRange) return fail(state, "unit-cannot-move", "该兵种没有移动能力。");
  if (destinationCell.unitId) return fail(state, "occupied-destination", "移动目标必须是空格；攻击请使用攻击能力。");
  const destinationTerrain = requireTerrain(terrains, destinationCell.terrainId);
  if (!hasTerrainCapability(destinationTerrain, CAPABILITY.occupiable)) {
    return fail(state, "blocked-terrain", "山地和虚无不能进入。");
  }
  const distance = getHexDistance(sourceCell.coordinate, destinationCell.coordinate, state.board);
  if (!distance || distance > moveRange) return fail(state, "non-adjacent-destination", "目标超出该兵种的移动距离。");

  const powered = getPoweredUnitIds(state, terrains).has(unit.id);
  if (!hasEnoughStrengthToAct(unit, unitDefinition, powered)) {
    return fail(state, "insufficient-strength", "通电兵点数不足，不能行动。");
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

  const arrivedCell = draft.cells[destinationCell.id];
  const arrivingUnit = arrivedCell?.unitId
    ? draft.units[arrivedCell.unitId]
    : undefined;
  // A hostile occupied stronghold has the highest exhaustion priority: it
  // must win over the generic one-point/departure rules for the same arrival.
  if (arrivingUnit) {
    applyAdjacentHostileExhaustion(draft, arrivingUnit, terrains, events);
  }
  applyDepartureExhaustion(
    draft,
    continuationUnitId,
    sourceCell.id,
    requireTerrain(terrains, sourceCell.terrainId),
    destinationTerrain,
    events
  );
  applyMinimumStrengthExhaustion(draft, continuationUnitId, unit, unitDefinition, events);
  const phaseAdvanced = enterReinforcementIfNoActions(draft, terrains, units, events);

  return succeed(draft, events, continuationUnitId && !phaseAdvanced
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
  const departureGarrison = movesIntoTarget
    && hasCellTrigger(state, sourceCell.id, "leave", CAPABILITY.departureGarrison, sourceTerrain)
    ? getDepartureGarrison(sourceTerrain)
    : undefined;
  if (departureGarrison && attacker.strength <= departureGarrison.strength) {
    return fail(state, "insufficient-strength", "该地形需要留下 1 点留守游兵，至少需要 2 点才能离开。");
  }
  if (departureGarrison && !units[departureGarrison.unitDefinitionId ?? attacker.definitionId]) {
    return fail(state, "invalid-unit-definition", "该地形配置的留守兵种不存在。");
  }
  const powered = getPoweredUnitIds(state, terrains).has(attacker.id);
  if (!hasEnoughStrengthToAct(attacker, attackerDefinition, powered)) {
    return fail(state, "insufficient-strength", "通电兵点数不足，不能行动。");
  }
  const attackStrength = movesIntoTarget && powered
    ? getMovingStrengthAfterAction(attacker, attackerDefinition, true)
    : attacker.strength;
  if (attackStrength < 1) return fail(state, "insufficient-strength", "单位兵力不足，无法保留供电锚点并完成行动。");

  const draft = createDraft(state);
  const events: GameEvent[] = [];
  let continuationUnitId = resolveAttack(
    draft, attacker, defender, targetCell.id, attackStrength, powered, movesIntoTarget, events
  );
  if (departureGarrison) {
    leaveDepartureGarrison(draft, sourceCell.id, attacker, departureGarrison, units, events);
  }
  applyCounterattack(draft, defender.id, continuationUnitId, terrains, units, events);
  if (continuationUnitId && !draft.units[continuationUnitId]) continuationUnitId = undefined;

  // Melee already incorporates the action strength into its casualty result.
  // A non-moving attack has no split/casualty movement, so decay its surviving
  // acting stack here after combat and counterattack both finish.
  if (continuationUnitId && !movesIntoTarget) {
    applyStationaryActionStrengthDecay(draft, continuationUnitId, attackerDefinition);
  }
  if (movesIntoTarget) {
    const arrivedCell = draft.cells[targetCell.id];
    const arrivingUnit = arrivedCell?.unitId ? draft.units[arrivedCell.unitId] : undefined;
    if (arrivingUnit) applyAdjacentHostileExhaustion(draft, arrivingUnit, terrains, events);
  }

  // Generic one-point exhaustion is deliberately after the stronghold-zone
  // check so the zone rule remains the highest-priority reason for arrival.
  applyMinimumStrengthExhaustion(draft, continuationUnitId, attacker, attackerDefinition, events);

  // An attack itself exhausts only an unpowered unit with this capability.
  // The hostile-stronghold zone above runs first, so its higher-priority event
  // wins when both rules would mark the same arrival unit exhausted. Powered
  // units retain their action and may attack again unless the zone catches them.
  if (!powered && continuationUnitId && hasUnitCapability(attackerDefinition, UNIT_CAPABILITY.attackExhaustion)) {
    if (exhaustUnitForCurrentPhase(draft, continuationUnitId)) {
      events.push({ type: "unit-exhausted", message: "游兵完成攻击，本回合失去行动力。" });
    }
  }
  const phaseAdvanced = enterReinforcementIfNoActions(draft, terrains, units, events);

  return succeed(draft, events, continuationUnitId && !phaseAdvanced
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
  terrains: TerrainCatalog,
  units: UnitCatalog
): CommandResult {
  const unit = state.units[command.unitId];
  if (!unit) return fail(state, "unknown-unit", "找不到要强化的单位。");
  if (unit.ownerId !== command.actorId) return fail(state, "not-unit-owner", "只能给自己的单位投入点数。");
  const player = state.players[command.actorId];
  if (!player || player.reinforcementPoints < 1) {
    return fail(state, "insufficient-points", "没有可用点数。");
  }
  if (!getPoweredUnitIds(state, terrains).has(unit.id)) {
    return fail(state, "unit-not-powered", "游兵不能投入点数；请先连接到据点。");
  }

  const draft = createDraft(state);
  draft.units[unit.id] = { ...unit, strength: unit.strength + 1 };
  draft.players[player.id] = { ...player, reinforcementPoints: player.reinforcementPoints - 1 };
  const events: GameEvent[] = [{
    type: "unit-reinforced",
    message: `${player.displayName} 为单位投入了 1 点。`
  }];
  advanceTurnIfNoReinforcementPoints(draft, terrains, units, events);
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

function endReinforcementPhase(state: GameState, terrains: TerrainCatalog, units: UnitCatalog): CommandResult {
  const current = state.players[state.turn.currentPlayerId];
  if (!current) return fail(state, "not-current-player", "找不到当前行动玩家。");

  const draft = createDraft(state);
  const events: GameEvent[] = [{ type: "reinforcement-phase-ended", message: `${current.displayName} 结束了加点回合。` }];
  startNextActionPhase(draft, terrains, units, events);
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
  events: GameEvent[]
): UnitId | undefined {
  const sourceCell = draft.cells[attacker.cellId];
  const destinationCell = draft.cells[destinationId];
  if (!sourceCell || !destinationCell) return undefined;

  if (movesIntoTarget && powered) {
    draft.units[attacker.id] = { ...attacker, strength: 1 };
    draft.cells[attacker.cellId] = { ...sourceCell, unitId: attacker.id };
  } else if (movesIntoTarget) {
    delete draft.units[attacker.id];
    draft.cells[attacker.cellId] = withCellUnit(sourceCell, undefined);
  }

  if (attackStrength > defender.strength) {
    const survivorStrength = attackStrength - defender.strength;
    delete draft.units[defender.id];
    if (!movesIntoTarget) {
      draft.cells[destinationId] = withCellUnit(destinationCell, undefined);
      events.push({ type: "unit-attacked", message: "远程进攻成功，敌方单位被消灭。" });
      return attacker.id;
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

  if (attackStrength === defender.strength) {
    delete draft.units[defender.id];
    draft.cells[destinationId] = withCellUnit(destinationCell, undefined);
    events.push({ type: "unit-attacked", message: movesIntoTarget ? "双方兵力相抵，单位同时消灭。" : "远程攻击消灭了敌方单位。" });
    return movesIntoTarget ? (powered ? attacker.id : undefined) : attacker.id;
  }

  draft.units[defender.id] = {
    ...defender,
    strength: defender.strength - attackStrength
  };
  events.push({ type: "unit-attacked", message: "进攻失败，防守方损失部分兵力。" });
  return movesIntoTarget ? (powered ? attacker.id : undefined) : attacker.id;
}

/** A defender may react independently of its own attack range. */
function applyCounterattack(
  draft: Draft,
  defenderId: UnitId,
  attackerId: UnitId | undefined,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  events: GameEvent[]
): void {
  if (!attackerId) return;
  const defender = draft.units[defenderId];
  const attacker = draft.units[attackerId];
  if (!defender || !attacker) return;
  const definition = units[defender.definitionId];
  if (!definition || !hasUnitCapability(definition, UNIT_CAPABILITY.counterattack)) return;

  const used = draft.turn.counterattacksUsed[defender.id] ?? 0;
  const defendingCell = draft.cells[defender.cellId];
  if (!defendingCell) return;
  const terrain = requireTerrain(terrains, defendingCell.terrainId);
  // Terrain can suppress or extend the unit's reaction, but cannot grant
  // counterattack to a unit without the corresponding unit capability.
  const limit = getCounterattackLimit(terrain, definition);
  if (used >= limit) return;

  draft.turn = {
    ...draft.turn,
    counterattacksUsed: { ...draft.turn.counterattacksUsed, [defender.id]: used + 1 }
  };
  const remainingStrength = attacker.strength - defender.strength;
  if (remainingStrength > 0) {
    draft.units[attacker.id] = { ...attacker, strength: remainingStrength };
    events.push({ type: "unit-counterattacked", message: "防守单位发动反击，进攻单位损失兵力。" });
    return;
  }

  const attackerCell = draft.cells[attacker.cellId];
  if (attackerCell) draft.cells[attacker.cellId] = withCellUnit(attackerCell, undefined);
  delete draft.units[attacker.id];
  events.push({ type: "unit-counterattacked", message: "防守单位发动反击，进攻单位被消灭。" });
}

/** A terrain's reaction limit overrides the unit's ordinary fallback limit. */
function getCounterattackLimit(terrain: TerrainSpec, unit: UnitSpec): number {
  const configured = getTerrainCapability(terrain, CAPABILITY.counterattackTerrainLimit)?.config?.maxPerActionPhase;
  if (configured === "unlimited") return Number.POSITIVE_INFINITY;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) return configured;
  return getConfiguredMax(unit, UNIT_CAPABILITY.counterattackLimit, "maxPerActionPhase") ?? 1;
}

function applyAdjacentHostileExhaustion(
  draft: Draft,
  arrivingUnit: UnitState,
  terrains: TerrainCatalog,
  events: GameEvent[]
): void {
  const cell = draft.cells[arrivingUnit.cellId];
  if (!cell) return;

  // Maps loaded by core-content carry a precompiled inbound-link index, so a
  // move reads only relationships attached to the arrival cell. The geometric
  // fallback supports older snapshots and hand-built states which predate the
  // index; it can be removed once those snapshots are no longer accepted.
  const links = draft.state.cellTriggers?.[cell.id]?.enter
    ?? getHexNeighbours(cell.coordinate, draft.state.board).map((neighbour) => ({
      relatedCellId: toCellId(neighbour),
      relationId: CAPABILITY.hostileExhaustion
    }));
  for (const link of links) {
    if (link.relationId !== CAPABILITY.hostileExhaustion) continue;
    if (!link.relatedCellId) continue;
    const strongholdCell = draft.cells[link.relatedCellId];
    const owner = strongholdCell?.unitId ? draft.units[strongholdCell.unitId] : undefined;
    if (!strongholdCell || !owner || areSameTeam(draft.state, arrivingUnit.ownerId, owner.ownerId)) {
      continue;
    }
    const terrain = requireTerrain(terrains, strongholdCell.terrainId);
    if (!hasTerrainCapability(terrain, CAPABILITY.hostileExhaustion)) continue;

    if (exhaustUnitForCurrentPhase(draft, arrivingUnit.id)) {
      events.push({ type: "unit-exhausted", message: "单位进入敌方据点封锁区，本回合失去行动力。" });
    }
  }
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
  const destinationTerrainIdNot = capability.config?.destinationTerrainIdNot;
  if (typeof destinationTerrainIdNot === "string" && destinationTerrain.id === destinationTerrainIdNot) return;
  if (exhaustUnitForCurrentPhase(draft, unitId)) {
    events.push({ type: "unit-exhausted", message: "单位离开该地形，本回合失去行动力。" });
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

/** Applies action decay for a cannon-like action that leaves the unit in place. */
function applyStationaryActionStrengthDecay(draft: Draft, unitId: UnitId, definition: UnitSpec): void {
  const unit = draft.units[unitId];
  const actionDecay = getActionStrengthDecay(definition);
  if (!unit || !actionDecay || unit.strength <= actionDecay.minimumStrength) return;
  draft.units[unitId] = {
    ...unit,
    strength: Math.max(actionDecay.minimumStrength, unit.strength - actionDecay.amount)
  };
}

interface DepartureGarrison {
  /** The strength reserved in the terrain's source cell. */
  readonly strength: number;
  /** Optional explicit unit type for the resident; defaults to the departing type. */
  readonly unitDefinitionId?: string;
}

/**
 * A terrain can reserve a unit when an occupier leaves it. This is a terrain
 * rule instead of a power rule: oil fields intentionally do not conduct or
 * supply electricity, yet can still keep a one-point roaming resident.
 */
function getDepartureGarrison(terrain: TerrainSpec): DepartureGarrison | undefined {
  const capability = getTerrainCapability(terrain, CAPABILITY.departureGarrison);
  const config = capability?.config;
  const strength = config?.strength;
  if (typeof strength !== "number" || !Number.isInteger(strength) || strength < 1) return undefined;
  const unitDefinitionId = config?.unitDefinitionId;
  return {
    strength,
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

function grantReinforcementIncome(
  draft: Draft,
  player: PlayerState,
  terrains: TerrainCatalog,
  units: UnitCatalog,
  events: GameEvent[]
): void {
  const draftState = asDraftState(draft);
  const powered = getPoweredUnitIds(draftState, terrains);
  let income = 0;
  for (const unit of Object.values(draft.units)) {
    if (unit.ownerId !== player.id) continue;
    const cell = draft.cells[unit.cellId];
    if (!cell) continue;
    const definition = units[unit.definitionId];
    const poweredIncome = definition
      ? getUnitCapability(definition, UNIT_CAPABILITY.poweredIncome)?.config?.amount
      : undefined;
    if (powered.has(unit.id) && typeof poweredIncome === "number" && poweredIncome > 0) {
      income += poweredIncome;
    }
    const terrain = requireTerrain(terrains, cell.terrainId);
    const source = getMatchTerrainCapability(draftState, terrain, CAPABILITY.income);
    if (!source?.config) continue;
    const amount = source.config.amount;
    const requires = source.config.requires;
    if (typeof amount !== "number") continue;
    if (requires === "powered-occupant" && !powered.has(unit.id)) continue;
    income += amount;
  }
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
  if (getActionableUnitIds(asDraftState(draft), terrains, units).size > 0) return false;
  const current = draft.players[draft.turn.currentPlayerId];
  events.push({
    type: "action-phase-ended",
    message: `${current?.displayName ?? "当前玩家"} 已无可行动单位，自动结束行动回合。`
  });
  enterReinforcementPhase(draft, events);
  return true;
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
  units: UnitCatalog,
  events: GameEvent[]
): boolean {
  const current = draft.players[draft.turn.currentPlayerId];
  if (!current || current.reinforcementPoints > 0) return false;
  events.push({ type: "reinforcement-phase-ended", message: `${current.displayName} 已用完点数，自动结束加点回合。` });
  startNextActionPhase(draft, terrains, units, events);
  return true;
}

/** Starts a seat's action phase and calculates that seat's points exactly once. */
function startNextActionPhase(
  draft: Draft,
  terrains: TerrainCatalog,
  units: UnitCatalog,
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
  grantReinforcementIncome(draft, next, terrains, units, events);
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
  matchConditions: MatchConditionCatalog
): CommandResult {
  if (!result.accepted) return result;

  const draft = createDraft(result.state);
  const events = [...result.events];
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
  const { [unitId]: removedCounterattack, ...counterattacksUsed } = draft.turn.counterattacksUsed;
  void removedCounterattack;
  draft.turn = {
    ...draft.turn,
    exhaustedUnitIds: draft.turn.exhaustedUnitIds.filter((id) => id !== unitId),
    counterattacksUsed
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
  return state.players[left]?.teamId === state.players[right]?.teamId;
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
 * separate from move/attack: a Mod can create a unit that acts without
 * changing strength, or give a stationary attacker the same decay.
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
