import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculateReinforcementIncome, hasTerrainCapability, selectSpatialPatternCells, type GameState } from "../../packages/game-core/src/index.js";
import { coreTerrainCatalog } from "../../packages/core-content/src/index.js";
import { CANDIDATE_SIZE, DEFAULT_MATCH_CONDITION_IDS, EXPERIMENT_MATCH_CONDITION_IDS, GLOBAL_SIZE, OBSERVATION_SIZE, SEARCH_HEURISTIC_WEIGHTS, TRAINING_WIN_SPEED_DISCOUNT, createEnvironment } from "./environment.js";
import { effectiveLearningRoundLimit, isWithinLearningRoundWindow } from "./training-policy.js";
import { occupiedCellsByTeam, totalStrengthByTeam } from "./temporary-rules.js";

const env = createEnvironment(undefined, { includeTemporaryRoundLimit: true });
const normalEnv = createEnvironment();

test("用户地图保持空条件，实验应用正常规则并只初始化一次收益", () => {
  const raw = JSON.parse(readFileSync(new URL("./maps/hunxiao.json", import.meta.url), "utf8"));
  assert.deepEqual(raw.matchConditionIds, []);
  assert.equal(raw.terrain, "AAAAAAABCBDAEEAEABAEEAAEAACBAEDABEABBAABBAABCBAEBADEABAAEAAEEACBAEAEEADBBAAAAAAAC");
  assert.equal(raw.terrain.length, 81);
  assert.deepEqual(env.normalizedMap.matchConditionIds, EXPERIMENT_MATCH_CONDITION_IDS);
  const state = env.initialState();
  assert.deepEqual(state.settings.matchConditionIds, EXPERIMENT_MATCH_CONDITION_IDS);
  const current = state.players[state.turn.currentPlayerId]!;
  assert.equal(current.reinforcementPoints, calculateReinforcementIncome(state, current.id, coreTerrainCatalog));
  assert.equal(current.reinforcementPoints, 3);
  assert.equal(state.turn.phase, "action");
  assert.equal(env.terminalValue(state, "team-1"), null);
  assert.equal(env.encode(state).global[4], 1);
  assert.equal(env.ruleSnapshot.matchConditions.find((condition) => condition.id === "experiment/round-10-strength-area")?.sourceModule,
    "experiments/hunxiao-ai/temporary-rules.ts");
});

test("默认环境只用核心自然胜负规则，不启用临时十回合条件或时间折扣", () => {
  const state = normalEnv.initialState();
  assert.deepEqual(normalEnv.normalizedMap.matchConditionIds, DEFAULT_MATCH_CONDITION_IDS);
  assert.deepEqual(state.settings.matchConditionIds, DEFAULT_MATCH_CONDITION_IDS);
  assert.equal(normalEnv.encode(state).global[4], 0);
  assert.equal(normalEnv.featureSchema.temporaryRoundLimit, null);
  assert.equal(normalEnv.ruleSnapshot.matchConditions.some((condition) => condition.id === "experiment/round-10-strength-area"), false);
  const lateLoss = normalEnv.step({ ...withoutAnchors(normalEnv.initialState(), "team-1"), turn: {
    ...withoutAnchors(normalEnv.initialState(), "team-1").turn, round: 20
  } }, { type: "end-action-phase" });
  assert.equal(normalEnv.terminalValue(lateLoss, "team-2"), 1);
  assert.equal(normalEnv.terminalValue(lateLoss, "team-1"), -1);
  const roundTen = beforeLastReinforcement(normalEnv.initialState());
  assert.notEqual(normalEnv.step(roundTen, { type: "end-reinforcement-phase" }).turn.phase, "finished");
});

test("学习回合上限为0时长局全程采样且自然结束", () => {
  assert.equal(isWithinLearningRoundWindow(30, 30), true);
  assert.equal(isWithinLearningRoundWindow(31, 30), false);
  assert.equal(isWithinLearningRoundWindow(100, 30), false);
  assert.equal(isWithinLearningRoundWindow(31, 0), true);
  assert.equal(isWithinLearningRoundWindow(1000, 0), true);
  assert.throws(() => isWithinLearningRoundWindow(0, 0), /positive integer/);
  assert.throws(() => isWithinLearningRoundWindow(31.5, 30), /positive integer/);
  assert.throws(() => isWithinLearningRoundWindow(31, -1), /non-negative integer/);
  const state = { ...normalEnv.initialState(), turn: { ...normalEnv.initialState().turn, round: 31 } };
  assert.notEqual(normalEnv.step(state, { type: "end-action-phase" }).turn.phase, "finished");
});

test("连续训练第6轮起忽略已运行循环传入的旧回合限制", () => {
  assert.equal(effectiveLearningRoundLimit("hunxiao-selfplay-1000-iteration-5-20261006", 30), 30);
  assert.equal(effectiveLearningRoundLimit("hunxiao-selfplay-1000-iteration-6-20261006", 30), 0);
  assert.equal(effectiveLearningRoundLimit("manual-selfplay-test", 30), 30);
});

test("全体合法动作可用共享引擎执行且输入状态保持不可变", () => {
  const initial = deepFreeze(env.initialState());
  const before = JSON.stringify(initial);
  assert.ok(env.legal(initial).length > 1);
  for (const intent of env.legal(initial)) {
    const next = env.step(initial, intent);
    assert.notEqual(next, initial);
    assert.equal(next.sequence, initial.sequence + 1);
    assert.equal(JSON.stringify(initial), before);
  }
});

test("行动转增援保持己方视角，仅增援结束后的对手回合改变视角", () => {
  const initial = env.initialState();
  const first = env.encode(initial);
  const reinforcement = env.step(initial, { type: "end-action-phase" });
  const second = env.encode(reinforcement);
  assert.equal(env.team(reinforcement), env.team(initial));
  assert.equal(second.teamId, first.teamId);
  assert.deepEqual(first.global.slice(0, 3), [1, 0, 0]);
  assert.deepEqual(second.global.slice(0, 3), [0, 1, 0]);
  assert.deepEqual(second.observation, first.observation);
  const enemy = env.step(reinforcement, { type: "end-reinforcement-phase" });
  const third = env.encode(enemy);
  assert.notEqual(third.teamId, second.teamId);
  assert.equal(third.teamId, "team-2");
  assert.deepEqual(third.global.slice(0, 3), [1, 0, 0]);
  assert.equal(env.terminalValue(enemy, "team-1"), null);
  assert.equal(env.terminalValue(enemy, "team-2"), null);
  assert.equal(env.heuristic(enemy, "team-1"), -env.heuristic(enemy, "team-2"));
});

test("双方失去全部据点即淘汰余部，终局值严格按队伍返回", () => {
  for (const losingTeam of ["team-1", "team-2"]) {
    const initial = withoutAnchors(env.initialState(), losingTeam);
    assert.ok(Object.values(initial.units).some((unit) => initial.players[unit.ownerId]?.teamId === losingTeam));
    const ended = env.step(initial, { type: "end-action-phase" });
    const winningTeam = losingTeam === "team-1" ? "team-2" : "team-1";
    assert.equal(ended.turn.phase, "finished");
    assert.deepEqual(ended.result?.winningTeamIds, [winningTeam]);
    assert.ok(Object.values(ended.units).every((unit) => ended.players[unit.ownerId]?.teamId !== losingTeam));
    assert.equal(env.terminalValue(ended, losingTeam), -1);
    assert.equal(env.terminalValue(ended, winningTeam), 1);
    assert.deepEqual(env.legal(ended), []);
    assert.deepEqual(env.encode(ended).candidates, []);
  }
});

test("搜索评估明确奖励兵力差和逼近敌方据点，且双方严格对称", () => {
  const state = env.initialState();
  const firstPlayer = Object.values(state.players).find((player) => player.teamId === "team-1")!;
  const secondPlayer = Object.values(state.players).find((player) => player.teamId === "team-2")!;
  const baseline = env.heuristic(state, "team-1");
  assert.ok(Math.abs(baseline + env.heuristic(state, "team-2")) < 1e-12);

  const heavier = { ...state, units: { ...state.units } };
  const firstUnit = Object.values(state.units).find((unit) => state.players[unit.ownerId]?.teamId === firstPlayer.teamId)!;
  heavier.units[firstUnit.id] = { ...firstUnit, strength: firstUnit.strength + 1 };
  assert.ok(env.heuristic(heavier, "team-1") > baseline, "more team-1 strength should improve its positional value");

  const pattern = state.settings.modRuleSet?.patterns.find((candidate) => candidate.id === "core-terrain/hostile-stronghold-zone");
  assert.ok(pattern, "core stronghold pressure pattern should exist");
  const enemyStrongholdZone = selectSpatialPatternCells(state, coreTerrainCatalog, pattern, firstPlayer.id);
  const donor = Object.values(state.units).find((unit) => state.players[unit.ownerId]?.teamId === firstPlayer.teamId
    && unit.strength > 1);
  assert.ok(donor, "fixture should have a team-1 unit with spare strength");
  const emptyTargets = Object.values(state.cells).filter((cell) => !cell.unitId
    && !hasTerrainCapability(coreTerrainCatalog[cell.terrainId]!, "core/survival-anchor"));
  const attackingTargets = emptyTargets.filter((cell) => enemyStrongholdZone.has(cell.id));
  const quietTargets = emptyTargets.filter((cell) => !enemyStrongholdZone.has(cell.id));
  let comparison: { attacking: GameState; quiet: GameState } | undefined;
  for (const attackTarget of attackingTargets) {
    const attacking = addScoutWithoutChangingStrength(state, donor.id, attackTarget.id);
    for (const quietTarget of quietTargets) {
      const quiet = addScoutWithoutChangingStrength(state, donor.id, quietTarget.id);
      if (calculateReinforcementIncome(attacking, firstPlayer.id, coreTerrainCatalog)
          === calculateReinforcementIncome(quiet, firstPlayer.id, coreTerrainCatalog)
        && calculateReinforcementIncome(attacking, secondPlayer.id, coreTerrainCatalog)
          === calculateReinforcementIncome(quiet, secondPlayer.id, coreTerrainCatalog)) {
        comparison = { attacking, quiet };
        break;
      }
    }
    if (comparison) break;
  }
  assert.ok(comparison, "fixture should allow equivalent-income attacking and quiet placements");
  assert.ok(env.heuristic(comparison.attacking, "team-1") > env.heuristic(comparison.quiet, "team-1"),
    "a unit pressuring an enemy stronghold should be valued above the same unit elsewhere");
  assert.ok(Math.abs(env.heuristic(comparison.attacking, "team-1") + env.heuristic(comparison.attacking, "team-2")) < 1e-12);

  for (const weights of Object.values(SEARCH_HEURISTIC_WEIGHTS)) {
    assert.equal(Object.values(weights).reduce((sum, weight) => sum + weight, 0), 1);
  }
});

test("终局偏好早点获胜但不改变胜负方，失败方也按对称值返回", () => {
  const earlySetup = withoutAnchors(env.initialState(), "team-1");
  const early = env.step(earlySetup, { type: "end-action-phase" });
  const lateSetup = withoutAnchors(env.initialState(), "team-1");
  const late = env.step({ ...lateSetup, turn: { ...lateSetup.turn, round: 7 } }, { type: "end-action-phase" });
  const earlyWinner = env.terminalValue(early, "team-2");
  const lateWinner = env.terminalValue(late, "team-2");
  assert.equal(early.result?.winningTeamIds[0], "team-2");
  assert.equal(late.result?.winningTeamIds[0], "team-2");
  assert.equal(earlyWinner, 1);
  assert.ok(Math.abs(lateWinner! - TRAINING_WIN_SPEED_DISCOUNT ** 6) < 1e-12);
  assert.equal(env.terminalValue(early, "team-1"), -earlyWinner!);
  assert.equal(env.terminalValue(late, "team-1"), -lateWinner!);
});

test("第十个完整回合按兵力比阈值和占地决胜，差距小于十二格平局且正常据点胜利优先", () => {
  const base = beforeLastReinforcement(env.initialState());
  assert.deepEqual(totalStrengthByTeam(base), { "team-1": 4, "team-2": 5 });
  assert.deepEqual(occupiedCellsByTeam(base), { "team-1": 3, "team-2": 4 });

  const firstWinsBelowRatio = withAddedStrength(withAddedStrength(base, "team-1", 16), "team-2", 16);
  const firstWinsBelowRatioEnd = env.step(firstWinsBelowRatio, { type: "end-reinforcement-phase" });
  assert.deepEqual(totalStrengthByTeam(firstWinsBelowRatio), { "team-1": 20, "team-2": 21 });
  assert.deepEqual(firstWinsBelowRatioEnd.result?.winningTeamIds, ["team-1"]);
  assert.match(firstWinsBelowRatioEnd.result?.message ?? "", /低于 1\.1/);

  const exactLowerThresholdAreaTiebreak = withAddedOccupiedCells(
    withAddedStrength(withAddedStrength(base, "team-1", 16), "team-2", 4), "team-2", 13
  );
  assert.deepEqual(totalStrengthByTeam(exactLowerThresholdAreaTiebreak), { "team-1": 20, "team-2": 22 });
  const exactLowerThresholdEnd = env.step(exactLowerThresholdAreaTiebreak, { type: "end-reinforcement-phase" });
  assert.deepEqual(exactLowerThresholdEnd.result?.winningTeamIds, ["team-2"]);
  assert.doesNotMatch(exactLowerThresholdEnd.result?.message ?? "", /低于 1\.1/);

  const elevenCellDifference = withAddedStrength(
    withAddedStrength(withAddedOccupiedCells(base, "team-1", 12), "team-1", 4), "team-2", 19);
  assert.deepEqual(totalStrengthByTeam(elevenCellDifference), { "team-1": 20, "team-2": 24 });
  assert.deepEqual(occupiedCellsByTeam(elevenCellDifference), { "team-1": 15, "team-2": 4 });
  assert.deepEqual(env.step(elevenCellDifference, { type: "end-reinforcement-phase" }).result?.winningTeamIds, []);

  const exactTwelveCellDifference = withAddedStrength(
    withAddedStrength(withAddedOccupiedCells(base, "team-1", 13), "team-1", 3), "team-2", 19);
  assert.deepEqual(totalStrengthByTeam(exactTwelveCellDifference), { "team-1": 20, "team-2": 24 });
  assert.deepEqual(occupiedCellsByTeam(exactTwelveCellDifference), { "team-1": 16, "team-2": 4 });
  assert.deepEqual(env.step(exactTwelveCellDifference, { type: "end-reinforcement-phase" }).result?.winningTeamIds, ["team-1"]);

  const beyondTwelveCellDifference = withAddedStrength(
    withAddedStrength(withAddedOccupiedCells(base, "team-1", 14), "team-1", 2), "team-2", 19);
  assert.deepEqual(totalStrengthByTeam(beyondTwelveCellDifference), { "team-1": 20, "team-2": 24 });
  assert.deepEqual(occupiedCellsByTeam(beyondTwelveCellDifference), { "team-1": 17, "team-2": 4 });
  assert.deepEqual(env.step(beyondTwelveCellDifference, { type: "end-reinforcement-phase" }).result?.winningTeamIds, ["team-1"]);

  const firstWinsByArea = withAddedStrength(
    withAddedStrength(withAddedOccupiedCells(base, "team-1", 14), "team-1", 2), "team-2", 19);
  assert.deepEqual(totalStrengthByTeam(firstWinsByArea), { "team-1": 20, "team-2": 24 });
  assert.deepEqual(occupiedCellsByTeam(firstWinsByArea), { "team-1": 17, "team-2": 4 });
  assert.deepEqual(env.step(firstWinsByArea, { type: "end-reinforcement-phase" }).result?.winningTeamIds, ["team-1"]);

  const backWinsByArea = withAddedStrength(withAddedOccupiedCells(base, "team-2", 13), "team-1", 9);
  assert.deepEqual(totalStrengthByTeam(backWinsByArea), { "team-1": 13, "team-2": 18 });
  assert.deepEqual(occupiedCellsByTeam(backWinsByArea), { "team-1": 3, "team-2": 17 });
  assert.deepEqual(env.step(backWinsByArea, { type: "end-reinforcement-phase" }).result?.winningTeamIds, ["team-2"]);

  const exactUpperThresholdAreaTiebreak = withAddedStrength(
    withAddedStrength(withAddedOccupiedCells(base, "team-1", 14), "team-1", 2), "team-2", 24
  );
  assert.deepEqual(totalStrengthByTeam(exactUpperThresholdAreaTiebreak), { "team-1": 20, "team-2": 29 });
  assert.deepEqual(env.step(exactUpperThresholdAreaTiebreak, { type: "end-reinforcement-phase" }).result?.winningTeamIds, ["team-1"]);

  const backWinsAboveRatio = withAddedStrength(withAddedStrength(base, "team-1", 16), "team-2", 25);
  assert.deepEqual(totalStrengthByTeam(backWinsAboveRatio), { "team-1": 20, "team-2": 30 });
  const backWinsAboveRatioEnd = env.step(backWinsAboveRatio, { type: "end-reinforcement-phase" });
  assert.deepEqual(backWinsAboveRatioEnd.result?.winningTeamIds, ["team-2"]);
  assert.match(backWinsAboveRatioEnd.result?.message ?? "", /高于 1\.45/);

  const eliminated = withoutAnchors(base, "team-2");
  const eliminationEnd = env.step(eliminated, { type: "end-reinforcement-phase" });
  assert.deepEqual(eliminationEnd.result?.winningTeamIds, ["team-1"]);
  assert.doesNotMatch(eliminationEnd.result?.message ?? "", /第 10 回合结束/);
});

test("编码完整保留候选顺序且动作、增援和终局形状固定", () => {
  const initial = env.initialState();
  const reinforcement = env.step(initial, { type: "end-action-phase" });
  const finished = env.step(withoutAnchors(initial, "team-2"), { type: "end-action-phase" });
  for (const state of [initial, reinforcement, finished]) {
    const encoded = env.encode(state);
    assert.equal(encoded.observation.length, OBSERVATION_SIZE);
    assert.equal(encoded.global.length, GLOBAL_SIZE);
    assert.deepEqual(encoded.intents, env.legal(state));
    assert.equal(encoded.candidates.length, encoded.intents.length);
    for (const candidate of encoded.candidates) {
      assert.equal(candidate.length, CANDIDATE_SIZE);
      assert.equal(candidate.slice(0, 5).reduce((sum, value) => sum + value, 0), 1);
    }
    assert.ok([...encoded.observation, ...encoded.global, ...encoded.candidates.flat()].every(Number.isFinite));
  }
});

test("相同初局、固定动作序列与规则指纹可复现", () => {
  const other = createEnvironment(undefined, { includeTemporaryRoundLimit: true });
  assert.match(env.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(other.fingerprint, env.fingerprint);
  let left = env.initialState();
  let right = other.initialState();
  assert.deepEqual(left, right);
  for (let step = 0; step < 40; step += 1) {
    const intents = env.legal(left);
    if (!intents.length) break;
    const intent = intents[(step * 7 + 3) % intents.length]!;
    left = env.step(left, intent);
    right = other.step(right, intent);
    assert.deepEqual(left, right);
    assert.deepEqual(env.encode(left), other.encode(right));
  }
});

function withoutAnchors(state: GameState, losingTeam: string): GameState {
  const removed = new Set(Object.values(state.units).filter((unit) =>
    state.players[unit.ownerId]?.teamId === losingTeam
    && hasTerrainCapability(coreTerrainCatalog[state.cells[unit.cellId]!.terrainId]!, "core/survival-anchor")).map((unit) => unit.id));
  return {
    ...state,
    units: Object.fromEntries(Object.entries(state.units).filter(([id]) => !removed.has(id as never))) as GameState["units"],
    cells: Object.fromEntries(Object.entries(state.cells).map(([id, cell]) => {
      if (!cell.unitId || !removed.has(cell.unitId)) return [id, cell];
      const { unitId: _removed, ...empty } = cell;
      return [id, empty];
    })) as GameState["cells"]
  };
}

function beforeLastReinforcement(state: GameState): GameState {
  const player = Object.values(state.players).find((candidate) => candidate.seat === 2)!;
  return {
    ...state,
    players: Object.fromEntries(Object.values(state.players).map((candidate) => [candidate.id,
      { ...candidate, reinforcementPoints: candidate.seat === 2 ? 0 : candidate.reinforcementPoints }])) as GameState["players"],
    turn: { ...state.turn, currentPlayerId: player.id, phase: "reinforcement", round: 10 }
  };
}

function withAddedStrength(state: GameState, teamId: string, amount: number): GameState {
  const unit = Object.values(state.units).find((candidate) => state.players[candidate.ownerId]?.teamId === teamId)!;
  return { ...state, units: { ...state.units, [unit.id]: { ...unit, strength: unit.strength + amount } } };
}

function withAddedOccupiedCells(state: GameState, teamId: string, count: number): GameState {
  const player = Object.values(state.players).find((candidate) => candidate.teamId === teamId)!;
  const template = Object.values(state.units).find((candidate) => state.players[candidate.ownerId]?.teamId === teamId)!;
  const emptyCells = Object.values(state.cells).filter((cell) => !cell.unitId).slice(0, count);
  assert.equal(emptyCells.length, count);
  const units = { ...state.units };
  const cells = { ...state.cells };
  emptyCells.forEach((cell, index) => {
    const id = `test-${teamId}-${index}` as typeof template.id;
    units[id] = { ...template, id, ownerId: player.id, cellId: cell.id, strength: 1 };
    cells[cell.id] = { ...cell, unitId: id };
  });
  return { ...state, units, cells };
}

function addScoutWithoutChangingStrength(state: GameState, donorId: keyof GameState["units"], destinationId: keyof GameState["cells"]): GameState {
  const donor = state.units[donorId]!;
  const destination = state.cells[destinationId]!;
  assert.ok(!destination.unitId);
  const scoutId = `test-scout-${destination.id}` as typeof donor.id;
  return {
    ...state,
    units: {
      ...state.units,
      [donor.id]: { ...donor, strength: donor.strength - 1 },
      [scoutId]: { ...donor, id: scoutId, cellId: destination.id, strength: 1 }
    },
    cells: { ...state.cells, [destination.id]: { ...destination, unitId: scoutId } }
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
