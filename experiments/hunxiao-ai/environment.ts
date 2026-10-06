import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyIntent,
  appendActionNotation,
  appendPhaseEndNotation,
  appendReinforcementNotation,
  calculateReinforcementIncome,
  getLegalIntents,
  getPoweredUnitIds,
  hasTerrainCapability,
  selectSpatialPatternCells,
  toCellId,
  type CellId,
  type GameIntent,
  type GameState,
  type MatchConditionCatalog,
  type NotationEntry,
  type PlayerState,
  type TerrainCatalog,
  type UnitCatalog,
  type UnitState
} from "../../packages/game-core/src/index.js";
import {
  coreMatchConditionCatalog,
  coreTerrainCatalog,
  coreTerrainMod,
  coreUnitCatalog,
  createMatchFromMapDefinition,
  parseMapCode,
  type MapDefinition
} from "../../packages/core-content/src/index.js";
import { occupiedCellsByTeam, roundLimitByStrengthAndArea, ROUND_LIMIT_BACK_MIN_RATIO, ROUND_LIMIT_BACK_WIN_RATIO, ROUND_LIMIT_AREA_DRAW_WITHIN, ROUND_LIMIT_CONDITION_ID, TRAINING_ROUND_LIMIT } from "./temporary-rules.js";

/** Model/data contract: changing the order or normalization requires a new version. */
export const ENCODING_SCHEMA_VERSION = 4;
export const BOARD_COLUMNS = 9;
export const BOARD_ROWS = 9;
export const OBSERVATION_CHANNELS = [
  "terrain_plain", "terrain_mountain", "terrain_void", "terrain_stronghold", "terrain_ocean",
  "own_occupied", "enemy_occupied", "own_strength_log", "enemy_strength_log",
  "own_powered", "enemy_powered", "own_exhausted", "enemy_exhausted",
  "cell_counterattacks_used_div_6", "own_survival_anchor", "enemy_survival_anchor",
  "enemy_stronghold_exhaustion_zone", "own_stronghold_exhaustion_zone",
  "own_income_cell", "enemy_income_cell"
] as const;
export const CHANNELS = OBSERVATION_CHANNELS;
export const GLOBAL_CHANNELS = [
  "phase_action", "phase_reinforcement", "phase_finished", "current_seat_zero_based",
  "rounds_remaining_fraction", "own_reinforcement_log", "enemy_reinforcement_log",
  "own_income_div_16", "enemy_income_div_16", "own_total_strength_log",
  "enemy_total_strength_log", "sequence_log"
] as const;
export const CANDIDATE_CHANNELS = [
  "move", "attack", "reinforce", "end_action", "end_reinforcement",
  "source_column_div_8", "source_row_div_8", "target_column_div_8", "target_row_div_8",
  "source_strength_log", "target_strength_log", "target_team_relation",
  "source_powered", "target_powered", "target_survival_anchor", "target_enemy_stronghold_zone"
] as const;
export const OBSERVATION_SIZE = BOARD_COLUMNS * BOARD_ROWS * OBSERVATION_CHANNELS.length;
export const GLOBAL_SIZE = GLOBAL_CHANNELS.length;
export const CANDIDATE_SIZE = CANDIDATE_CHANNELS.length;
/** Small discount per completed round; favors earlier wins while keeping the same winner. */
export const TRAINING_WIN_SPEED_DISCOUNT = 0.98;
/** Search-only positional weights. The round-limit weights foreground material and initiative. */
export const SEARCH_HEURISTIC_WEIGHTS = {
  early: { anchors: 0.30, income: 0.12, strength: 0.38, occupiedCells: 0.08, attackPressure: 0.12 },
  roundLimit: { anchors: 0.10, income: 0.05, strength: 0.45, occupiedCells: 0.15, attackPressure: 0.25 }
} as const;
export const DEFAULT_MATCH_CONDITION_IDS = [
  "core/lose-all-survival-anchors", "core/last-team-standing"
] as const;
export const EXPERIMENT_MATCH_CONDITION_IDS = [...DEFAULT_MATCH_CONDITION_IDS, ROUND_LIMIT_CONDITION_ID] as const;
const experimentMatchConditions: MatchConditionCatalog = Object.freeze({
  ...coreMatchConditionCatalog,
  [ROUND_LIMIT_CONDITION_ID]: roundLimitByStrengthAndArea
});

export const FEATURE_SCHEMA = {
  schemaVersion: ENCODING_SCHEMA_VERSION,
  observationChannels: OBSERVATION_CHANNELS,
  globalFeatures: GLOBAL_CHANNELS,
  candidateFeatures: CANDIDATE_CHANNELS,
  observationLayout: "row-major cells, cell-major channels",
  scalarLog: "log2(1 + max(0, value)) / 8",
  sequenceLog: "log2(1 + sequence) / 16",
  coordinateDivisor: 8,
  missingCoordinate: -1,
  targetTeamRelation: { own: 1, empty: 0, enemy: -1 },
  incomeDivisor: 16,
  counterattackDivisor: 6,
  temporaryRoundLimit: TRAINING_ROUND_LIMIT,
  temporaryRoundBackToFirstRatio: {
    firstWinsBelow: ROUND_LIMIT_BACK_MIN_RATIO,
    secondWinsAbove: ROUND_LIMIT_BACK_WIN_RATIO,
    otherwise: "occupied-cells-tiebreak"
  },
  temporaryRoundOccupiedCellTieBreak: { count: "living-unit-occupied-cells-by-team", drawWhenDifferenceAtMost: ROUND_LIMIT_AREA_DRAW_WITHIN },
  temporaryRoundScore: "sum-of-living-unit-strength-by-team; back-to-first-ratio-below-1.1-first-wins; above-1.45-second-wins; inclusive-middle-decided-by-occupied-cells; difference-below-12-draw",
  trainingEvaluation: {
    winSpeedDiscountPerCompletedRound: TRAINING_WIN_SPEED_DISCOUNT,
    searchHeuristicWeights: SEARCH_HEURISTIC_WEIGHTS,
    positionalSignals: ["anchors", "reinforcement-income", "strength-difference", "occupied-cells", "units-near-enemy-strongholds"],
    note: "Training/search evaluation only; does not change the match winner rules."
  }
} as const;

export interface RuleSnapshot {
  readonly normalizedMap: MapDefinition;
  readonly terrains: TerrainCatalog;
  readonly units: UnitCatalog;
  readonly coreTerrainRules: typeof coreTerrainMod;
  readonly matchConditions: readonly { id: string; sourceModule: string; sourceSha256: string }[];
  readonly sourceHashes: Readonly<Record<string, string>>;
}

export interface EncodedPosition {
  /** Row-major cells, then the 20 channels for each cell (cell-major, not NCHW). */
  readonly observation: number[];
  readonly global: number[];
  /** One vector for EVERY legal intent, in the exact order of intents. No top-k cutoff. */
  readonly candidates: number[][];
  readonly intents: GameIntent[];
  /** The value head predicts the result from this acting team's perspective. */
  readonly teamId: string;
}

export interface Environment {
  readonly fingerprint: string;
  readonly featureSchema: Readonly<Record<string, unknown>>;
  readonly ruleSnapshot: RuleSnapshot;
  readonly normalizedMap: MapDefinition;
  initialState(): GameState;
  team(state: GameState): string;
  legal(state: GameState): readonly GameIntent[];
  step(state: GameState, intent: GameIntent): GameState;
  terminalValue(state: GameState, teamId: string): number | null;
  encode(state: GameState): EncodedPosition;
  heuristic(state: GameState, teamId: string): number;
}

const DEFAULT_MAP_PATH = fileURLToPath(new URL("./maps/hunxiao.json", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TERRAIN_ORDER = ["core/plain", "core/mountain", "core/void", "core/stronghold", "core/ocean"];
const ACTION_ORDER: GameIntent["type"][] = [
  "move-unit", "attack-unit", "reinforce-unit", "end-action-phase", "end-reinforcement-phase"
];

/**
 * Isolated experiment defaults. The checked-in user map keeps matchConditionIds: [].
 * Only this loader applies the user's confirmed normal elimination/victory rules.
 * This factory already starts the match through core-content; never start it again.
 */
export function createEnvironment(
  mapPath = DEFAULT_MAP_PATH,
  options: { includeTemporaryRoundLimit?: boolean } = {}
): Environment {
  const includeTemporaryRoundLimit = options.includeTemporaryRoundLimit ?? false;
  const featureSchema = featureSchemaFor(includeTemporaryRoundLimit);
  const activeMatchConditions = includeTemporaryRoundLimit ? experimentMatchConditions : coreMatchConditionCatalog;
  const rawMap = parseMapCode(readFileSync(mapPath, "utf8"));
  if (rawMap.columns !== BOARD_COLUMNS || rawMap.terrain.length !== BOARD_COLUMNS * BOARD_ROWS
    || rawMap.players !== 2 || rawMap.teams[0] === rawMap.teams[1]) {
    throw new Error("昏晓实验仅支持 9×9、双人两队地图。");
  }
  if (rawMap.requiredTerrainModIds.length || rawMap.specialUnits?.length
    || Object.values(rawMap.terrainLegend).some((id) => !TERRAIN_ORDER.includes(id))
    || rawMap.soldiers.some((soldier) => soldier[3] !== undefined && soldier[3] !== "core/roamer")) {
    throw new Error("当前昏晓编码只支持五类核心地形和游兵，不支持 Mod 或中立单位。");
  }
  if (rawMap.matchConditionIds.length && (rawMap.matchConditionIds.length !== DEFAULT_MATCH_CONDITION_IDS.length
    || DEFAULT_MATCH_CONDITION_IDS.some((id, index) => rawMap.matchConditionIds[index] !== id))) {
    throw new Error("昏晓实验地图条件应为空，或明确使用默认的据点全失淘汰和最后存活队获胜规则。");
  }
  const normalizedMap = deepFreeze<MapDefinition>({
    ...rawMap,
    matchConditionIds: [...(includeTemporaryRoundLimit ? EXPERIMENT_MATCH_CONDITION_IDS : DEFAULT_MATCH_CONDITION_IDS)]
  });
  const ruleSnapshot = createRuleSnapshot(normalizedMap, includeTemporaryRoundLimit);
  const fingerprint = createHash("sha256").update(canonicalJson({ featureSchema, ruleSnapshot })).digest("hex");
  const legalCache = new WeakMap<GameState, readonly GameIntent[]>();
  const encodedCache = new WeakMap<GameState, EncodedPosition>();
  const env: Environment = {
    normalizedMap,
    fingerprint,
    featureSchema,
    ruleSnapshot,
    initialState: () => createMatchFromMapDefinition(normalizedMap, {
      terrains: coreTerrainCatalog, units: coreUnitCatalog, matchConditions: activeMatchConditions
    }),
    team(state) {
      const player = state.players[state.turn.currentPlayerId];
      if (!player) throw new Error("状态缺少当前玩家。");
      return player.teamId;
    },
    legal(state) {
      const cached = legalCache.get(state);
      if (cached) return cached;
      const result = getLegalIntents(state, coreTerrainCatalog, coreUnitCatalog);
      legalCache.set(state, result);
      return result;
    },
    step(state, intent) {
      // Validation stays in the shared engine, including phase, owner and sequence.
      const result = applyIntent(state, intent, `hunxiao-ai-${state.sequence}`,
        coreTerrainCatalog, coreUnitCatalog, activeMatchConditions);
      if (!result.accepted) throw new Error(`非法实验动作 ${intent.type}: ${result.error.code} ${result.error.message}`);
      return result.state;
    },
    terminalValue(state, teamId) {
      assertTeam(state, teamId);
      if (state.turn.phase !== "finished") return null;
      if (!state.result) throw new Error("终局状态缺少 MatchResult。");
      if (!state.result.winningTeamIds.length) return 0;
      const outcome = state.result.winningTeamIds.some((id) => id === teamId) ? 1 : -1;
      const roundDiscount = includeTemporaryRoundLimit ? TRAINING_WIN_SPEED_DISCOUNT : 1;
      return outcome * roundDiscount ** Math.max(0, state.turn.round - 1);
    },
    encode(state) {
      const cached = encodedCache.get(state);
      if (cached) return cached;
      const teamId = env.team(state);
      const current = state.players[state.turn.currentPlayerId]!;
      const enemy = Object.values(state.players).find((player) => player.teamId !== teamId);
      if (!enemy) throw new Error("昏晓状态缺少对手。");
      const powered = getPoweredUnitIds(state, coreTerrainCatalog);
      const exhausted = new Set(state.turn.exhaustedUnitIds);
      const ownDanger = strongholdZone(state, current);
      const enemyDanger = strongholdZone(state, enemy);
      const observation: number[] = [];
      for (let row = 0; row < BOARD_ROWS; row += 1) {
        for (let column = 0; column < BOARD_COLUMNS; column += 1) {
          const cellId = toCellId({ row, column });
          const cell = state.cells[cellId];
          if (!cell) throw new Error(`昏晓状态缺少格子 ${cellId}。`);
          const unit = cell.unitId ? state.units[cell.unitId] : undefined;
          const relation = teamRelation(state, unit, teamId);
          const own = relation === 1;
          const opposing = relation === -1;
          const isPowered = !!unit && powered.has(unit.id);
          const isExhausted = !!unit && exhausted.has(unit.id);
          const anchor = hasTerrainCapability(coreTerrainCatalog[cell.terrainId]!, "core/survival-anchor");
          // The experiment allows only core terrains. Their income is 1 on powered plains/anchors.
          const incomeCell = isPowered && (cell.terrainId === "core/plain" || anchor);
          observation.push(
            ...TERRAIN_ORDER.map((terrainId) => Number(cell.terrainId === terrainId)),
            Number(own), Number(opposing), own ? strengthLog(unit!.strength) : 0, opposing ? strengthLog(unit!.strength) : 0,
            Number(own && isPowered), Number(opposing && isPowered), Number(own && isExhausted), Number(opposing && isExhausted),
            (state.turn.counterattacksUsed[cellId] ?? 0) / 6, Number(own && anchor), Number(opposing && anchor),
            Number(ownDanger.has(cellId)), Number(enemyDanger.has(cellId)), Number(own && incomeCell), Number(opposing && incomeCell)
          );
        }
      }
      const intents = [...env.legal(state)];
      const candidates = intents.map((intent) => {
        const source = "unitId" in intent ? state.units[intent.unitId] : undefined;
        const sourceCell = source ? state.cells[source.cellId] : undefined;
        const targetId = intent.type === "move-unit" ? intent.destinationId
          : intent.type === "attack-unit" ? intent.targetId : source?.cellId;
        const targetCell = targetId ? state.cells[targetId] : undefined;
        const target = targetCell?.unitId ? state.units[targetCell.unitId] : undefined;
        return [
          ...ACTION_ORDER.map((type) => Number(intent.type === type)),
          sourceCell ? sourceCell.coordinate.column / 8 : -1, sourceCell ? sourceCell.coordinate.row / 8 : -1,
          targetCell ? targetCell.coordinate.column / 8 : -1, targetCell ? targetCell.coordinate.row / 8 : -1,
          source ? strengthLog(source.strength) : 0, target ? strengthLog(target.strength) : 0,
          teamRelation(state, target, teamId), Number(!!source && powered.has(source.id)), Number(!!target && powered.has(target.id)),
          Number(!!targetCell && hasTerrainCapability(coreTerrainCatalog[targetCell.terrainId]!, "core/survival-anchor")),
          Number(!!targetId && ownDanger.has(targetId))
        ];
      });
      const global = [
        Number(state.turn.phase === "action"), Number(state.turn.phase === "reinforcement"), Number(state.turn.phase === "finished"),
        current.seat - 1, includeTemporaryRoundLimit
          ? Math.max(0, (TRAINING_ROUND_LIMIT + 1 - state.turn.round) / TRAINING_ROUND_LIMIT) : 0,
        strengthLog(current.reinforcementPoints), strengthLog(enemy.reinforcementPoints),
        calculateReinforcementIncome(state, current.id, coreTerrainCatalog) / 16,
        calculateReinforcementIncome(state, enemy.id, coreTerrainCatalog) / 16,
        strengthLog(totalStrength(state, teamId)), strengthLog(totalStrength(state, enemy.teamId)),
        Math.log2(1 + state.sequence) / 16
      ];
      const result: EncodedPosition = { observation, global, candidates, intents, teamId };
      encodedCache.set(state, result);
      return result;
    },
    heuristic(state, teamId) {
      const terminal = env.terminalValue(state, teamId);
      if (terminal !== null) return terminal;
      const stats = teamStats(state);
      const own = stats[teamId]!;
      const enemy = stats[Object.keys(state.teams).find((id) => id !== teamId)!]!;
      const relative = (a: number, b: number) => (a - b) / Math.max(1, a + b);
      const early = SEARCH_HEURISTIC_WEIGHTS.early;
      const earlyScore = early.anchors * relative(own.anchors, enemy.anchors)
        + early.income * relative(own.income, enemy.income)
        + early.strength * relative(own.strength, enemy.strength)
        + early.occupiedCells * relative(own.occupiedCells, enemy.occupiedCells)
        + early.attackPressure * relative(own.attackPressure, enemy.attackPressure);
      const roundsRemaining = Math.max(0, Math.min(TRAINING_ROUND_LIMIT, TRAINING_ROUND_LIMIT + 1 - state.turn.round));
      const urgency = includeTemporaryRoundLimit ? 1 - roundsRemaining / TRAINING_ROUND_LIMIT : 0;
      const late = SEARCH_HEURISTIC_WEIGHTS.roundLimit;
      const lateScore = late.anchors * relative(own.anchors, enemy.anchors)
        + late.income * relative(own.income, enemy.income)
        + late.strength * relative(own.strength, enemy.strength)
        + late.occupiedCells * relative(own.occupiedCells, enemy.occupiedCells)
        + late.attackPressure * relative(own.attackPressure, enemy.attackPressure);
      return earlyScore * (1 - urgency) + lateScore * urgency;
    }
  };
  return env;
}

function featureSchemaFor(includeTemporaryRoundLimit: boolean): Readonly<Record<string, unknown>> {
  if (includeTemporaryRoundLimit) return FEATURE_SCHEMA;
  return {
    ...FEATURE_SCHEMA,
    globalFeatures: GLOBAL_CHANNELS.map((name) => name === "rounds_remaining_fraction" ? "unused_round_feature" : name),
    temporaryRoundLimit: null,
    temporaryRoundBackToFirstRatio: null,
    temporaryRoundOccupiedCellTieBreak: null,
    temporaryRoundScore: "disabled; normal core elimination only",
    trainingEvaluation: {
      ...FEATURE_SCHEMA.trainingEvaluation,
      winSpeedDiscountPerCompletedRound: 1,
      searchHeuristicWeights: { normalPlay: SEARCH_HEURISTIC_WEIGHTS.early },
      note: "Normal rules only; no temporary round cap, strength-ratio result or time discount."
    }
  };
}

/** Log2(1 + nonnegative value) / 8; preserves high-strength distinctions without clipping. */
function strengthLog(value: number): number {
  return Math.log2(1 + Math.max(0, value)) / 8;
}

function teamRelation(state: GameState, unit: UnitState | undefined, teamId: string): number {
  if (!unit) return 0;
  return state.players[unit.ownerId]?.teamId === teamId ? 1 : -1;
}

function totalStrength(state: GameState, teamId: string): number {
  return Object.values(state.units).reduce((total, unit) =>
    total + (state.players[unit.ownerId]?.teamId === teamId ? unit.strength : 0), 0);
}

function strongholdZone(state: GameState, actor: PlayerState): ReadonlySet<CellId> {
  const pattern = state.settings.modRuleSet?.patterns.find((candidate) =>
    candidate.id === "core-terrain/hostile-stronghold-zone");
  if (!pattern) throw new Error("昏晓规则缺少核心据点封锁区 pattern。");
  return selectSpatialPatternCells(state, coreTerrainCatalog, pattern, actor.id);
}

function assertTeam(state: GameState, teamId: string): void {
  if (!Object.values(state.teams).some((team) => team.id === teamId)) throw new Error(`未知队伍 ${teamId}。`);
}

function teamStats(state: GameState): Readonly<Record<string, {
  anchors: number; income: number; strength: number; occupiedCells: number; attackPressure: number
}>> {
  const teamIds = Object.keys(state.teams);
  const playersByTeam = new Map(teamIds.map((teamId) => [teamId,
    Object.values(state.players).filter((player) => player.teamId === teamId)]));
  const unitsByTeam = new Map(teamIds.map((teamId) => [teamId,
    Object.values(state.units).filter((unit) => state.players[unit.ownerId]?.teamId === teamId)]));
  const pressureZones = new Map<string, ReadonlySet<CellId>>();
  for (const teamId of teamIds) {
    const cells = new Set<CellId>();
    for (const player of playersByTeam.get(teamId) ?? []) {
      for (const cellId of strongholdZone(state, player)) cells.add(cellId);
    }
    pressureZones.set(teamId, cells);
  }
  const occupied = occupiedCellsByTeam(state);
  return Object.fromEntries(teamIds.map((teamId) => {
    const players = playersByTeam.get(teamId) ?? [];
    const units = unitsByTeam.get(teamId) ?? [];
    return [teamId, {
      anchors: units.filter((unit) => hasTerrainCapability(coreTerrainCatalog[state.cells[unit.cellId]!.terrainId]!, "core/survival-anchor")).length,
      income: players.reduce((total, player) => total + calculateReinforcementIncome(state, player.id, coreTerrainCatalog), 0),
      strength: units.reduce((total, unit) => total + unit.strength, 0),
      occupiedCells: occupied[teamId] ?? 0,
      attackPressure: units.filter((unit) => pressureZones.get(teamId)?.has(unit.cellId)).length
    }];
  }));
}

function createRuleSnapshot(map: MapDefinition, includeTemporaryRoundLimit: boolean): RuleSnapshot {
  const modules: Record<string, string> = {};
  for (const packageName of ["game-core", "core-content", "game-sdk"]) {
    for (const sourcePath of sourceFiles(join(REPOSITORY_ROOT, "packages", packageName, "src"))) {
      modules[relative(REPOSITORY_ROOT, sourcePath).replaceAll("\\", "/")] =
        createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    }
  }
  const encodingPath = fileURLToPath(import.meta.url);
  modules[relative(REPOSITORY_ROOT, encodingPath).replaceAll("\\", "/")] =
    createHash("sha256").update(readFileSync(encodingPath)).digest("hex");
  if (includeTemporaryRoundLimit) {
    const temporaryRulesPath = join(REPOSITORY_ROOT, "experiments", "hunxiao-ai", "temporary-rules.ts");
    modules[relative(REPOSITORY_ROOT, temporaryRulesPath).replaceAll("\\", "/")] =
      createHash("sha256").update(readFileSync(temporaryRulesPath)).digest("hex");
  }
  return {
    normalizedMap: map,
    terrains: coreTerrainCatalog,
    units: coreUnitCatalog,
    coreTerrainRules: coreTerrainMod,
    matchConditions: map.matchConditionIds.map((id) => {
      const sourceModule = id === "core/last-team-standing"
        ? "packages/game-core/src/engine.ts"
        : id === ROUND_LIMIT_CONDITION_ID ? "experiments/hunxiao-ai/temporary-rules.ts"
          : "packages/core-content/src/match-conditions.ts";
      return { id, sourceModule, sourceSha256: modules[sourceModule]! };
    }),
    sourceHashes: modules
  };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  }).sort();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
