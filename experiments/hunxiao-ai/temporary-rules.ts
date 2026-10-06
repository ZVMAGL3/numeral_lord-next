import type { GameState, MatchConditionModule, TeamId } from "../../packages/game-core/src/index.js";

/** Temporary experiment rule. Keep this out of the shipped map and core catalog. */
export const TRAINING_ROUND_LIMIT = 10;
export const ROUND_LIMIT_BACK_MIN_RATIO = 1.1;
export const ROUND_LIMIT_BACK_WIN_RATIO = 1.45;
export const ROUND_LIMIT_AREA_DRAW_WITHIN = 11;
export const ROUND_LIMIT_CONDITION_ID = "experiment/round-10-strength-area";

export const roundLimitByStrengthAndArea: MatchConditionModule = {
  id: ROUND_LIMIT_CONDITION_ID,
  displayName: "第 10 回合后手/先手兵力比低于 1.1 则先手胜、高于 1.45 则后手胜；其余按占地格决胜（差距小于 12 格平局，昏晓 AI 临时规则）",
  evaluate(state) {
    // The engine increments round when seat 2 completes reinforcement. Round 11
    // therefore means both seats have completed all ten rounds.
    if (state.turn.phase === "finished" || state.turn.round <= TRAINING_ROUND_LIMIT) return undefined;
    const points = totalStrengthByTeam(state);
    const occupied = occupiedCellsByTeam(state);
    const first = points["team-1"] ?? 0;
    const back = points["team-2"] ?? 0;
    const firstArea = occupied["team-1"] ?? 0;
    const backArea = occupied["team-2"] ?? 0;
    const areaDifference = Math.abs(backArea - firstArea);
    // Strict ratio thresholds: r < 1.1 => first wins; r > 1.45 => back wins.
    // Integer cross-multiplication avoids floating-point boundary errors.
    // The inclusive middle interval is decided by occupied cells; difference <12 (<=11) is a draw.
    const firstWinsByStrength = back * 10 < first * 11;
    const backWinsByStrength = back * 100 > first * 145;
    const closeAreaDraw = areaDifference <= ROUND_LIMIT_AREA_DRAW_WITHIN;
    const firstWinsByArea = !firstWinsByStrength && !backWinsByStrength && !closeAreaDraw && firstArea > backArea;
    const backWinsByArea = !firstWinsByStrength && !backWinsByStrength && !closeAreaDraw && backArea > firstArea;
    const firstWins = firstWinsByStrength || firstWinsByArea;
    const backWins = backWinsByStrength || backWinsByArea;
    const score = `先手 ${first}、后手 ${back}`;
    const area = `先手 ${firstArea} 格、后手 ${backArea} 格`;
    const middle = `兵力比处于 1.1 至 1.45；占地${area}`;
    return {
      finish: {
        winningTeamIds: firstWins ? ["team-1" as TeamId] : backWins ? ["team-2" as TeamId] : [],
        message: firstWinsByStrength
          ? `第 ${TRAINING_ROUND_LIMIT} 回合结束，总兵力点数：${score}；占地：${area}。后手/先手兵力比低于 1.1，先手获胜。`
          : backWinsByStrength
            ? `第 ${TRAINING_ROUND_LIMIT} 回合结束，总兵力点数：${score}；占地：${area}。后手/先手兵力比高于 1.45，后手获胜。`
            : closeAreaDraw
              ? `第 ${TRAINING_ROUND_LIMIT} 回合结束，总兵力点数：${score}；${middle}，相差 ${areaDifference} 格（小于 12 格），平局。`
              : `第 ${TRAINING_ROUND_LIMIT} 回合结束，总兵力点数：${score}；${middle}，占地较多的一方获胜。`
      }
    };
  }
};

export function totalStrengthByTeam(state: GameState): Readonly<Record<string, number>> {
  const totals: Record<string, number> = Object.fromEntries(Object.keys(state.teams).map((teamId) => [teamId, 0]));
  for (const unit of Object.values(state.units)) {
    const teamId = state.players[unit.ownerId]?.teamId;
    if (teamId && teamId in totals) totals[teamId] = (totals[teamId] ?? 0) + unit.strength;
  }
  return totals;
}

/** Count map cells currently occupied by a living unit from each team. */
export function occupiedCellsByTeam(state: GameState): Readonly<Record<string, number>> {
  const totals: Record<string, number> = Object.fromEntries(Object.keys(state.teams).map((teamId) => [teamId, 0]));
  for (const cell of Object.values(state.cells)) {
    if (!cell.unitId) continue;
    const unit = state.units[cell.unitId];
    const teamId = unit ? state.players[unit.ownerId]?.teamId : undefined;
    if (teamId && teamId in totals) totals[teamId] = (totals[teamId] ?? 0) + 1;
  }
  return totals;
}
