import type { GameReport } from "./protocol.js";
import type { SearchOptions } from "./search.js";

export const PHASE_ARENA = {
  games: 32, workers: 8, seed: 20261114, maxActions: 10000,
  maximumNetworkPositionsPerMove: 258,
  continuationSimulations: 256, atomicSimulations: 257,
  maximumContinuationSteps: 64, maxDepth: 96, bootstrapSamples: 4000,
  bootstrapSeed: 20261114 ^ 0x51a7
} as const;

export function phaseArenaSearchOptions(mode: "continuation" | "atomic", seed: number): SearchOptions {
  const common = { seed, temperature: 0, rootNoise: 0, maxDepth: PHASE_ARENA.maxDepth };
  return mode === "continuation"
    ? { ...common, simulations: PHASE_ARENA.continuationSimulations, minimumSimulations: 1,
      leafContinuation: { maximumAtomicSteps: PHASE_ARENA.maximumContinuationSteps,
        evaluationBudget: PHASE_ARENA.maximumNetworkPositionsPerMove } }
    : { ...common, simulations: PHASE_ARENA.atomicSimulations,
      minimumSimulations: PHASE_ARENA.atomicSimulations };
}

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function phaseArenaGate(reports: GameReport[]): {
  complete: boolean; games: number; scoreRate: number; scoreBySeat: Record<1 | 2, {
    games: number; wins: number; draws: number; losses: number; truncated: number; points: number }>;
  pairedBootstrap95: [number, number]; bootstrapSeed: number; truncatedGames: number;
  fallbackMoves: number; positionBudgetViolations: number; declaredGatePassed: boolean;
  uniquePairedSeeds: number;
  byAlgorithm: Record<"leaf-policy-continuation" | "atomic-puct-control", {
    moves: number; totalNetworkPositions: number; averageNetworkPositionsPerMove: number;
    maximumNetworkPositionsPerMove: number; searchElapsedMs: number; fallbackMoves: number }>;
  fallbackSources: Array<{ gameId: number; seat: 1 | 2; mode: string; fallbackMoves: number }>;
  eligibleToProposeSmallDataExperiment: boolean; ambiguity?: string;
} {
  if (reports.length !== PHASE_ARENA.games
      || new Set(reports.map((report) => report.id)).size !== PHASE_ARENA.games
      || reports.some((report) => report.id < 0 || report.id >= PHASE_ARENA.games)) {
    throw new Error("phase arena requires exactly the complete 32 unique game IDs");
  }
  const ordered = [...reports].sort((a, b) => a.id - b.id);
  const pairedSeeds = new Set<number>();
  for (let id = 0; id < ordered.length; id += 2) {
    const expectedSeed = (PHASE_ARENA.seed + id / 2) >>> 0;
    if (ordered[id]!.seed !== expectedSeed || ordered[id + 1]!.seed !== expectedSeed) {
      throw new Error(`paired seed mismatch at games ${id}/${id + 1}`);
    }
    pairedSeeds.add(expectedSeed);
  }
  if (pairedSeeds.size !== 16) throw new Error("phase arena requires exactly 16 unique paired seeds");
  const scoreBySeat = {
    1: { games: 0, wins: 0, draws: 0, losses: 0, truncated: 0, points: 0 },
    2: { games: 0, wins: 0, draws: 0, losses: 0, truncated: 0, points: 0 }
  } satisfies Record<1 | 2, { games: number; wins: number; draws: number; losses: number; truncated: number; points: number }>;
  const points: number[] = [];
  let fallbackMoves = 0;
  let positionBudgetViolations = 0;
  const fallbackSources: Array<{ gameId: number; seat: 1 | 2; mode: string; fallbackMoves: number }> = [];
  const totals = {
    "leaf-policy-continuation": { moves: 0, totalNetworkPositions: 0, maximumNetworkPositionsPerMove: 0,
      searchElapsedMs: 0, fallbackMoves: 0 },
    "atomic-puct-control": { moves: 0, totalNetworkPositions: 0, maximumNetworkPositionsPerMove: 0,
      searchElapsedMs: 0, fallbackMoves: 0 }
  };
  for (const report of ordered) {
    const seat = (report.id % 2 + 1) as 1 | 2;
    if (report.candidateSeat !== seat) throw new Error(`candidate seat mismatch in game ${report.id}`);
    const row = scoreBySeat[seat];
    row.games++;
    const diagnostic = report.phaseArenaSearch;
    if (!diagnostic) throw new Error(`missing phase arena diagnostics in game ${report.id}`);
    if (diagnostic.bySeat[seat].mode !== "leaf-policy-continuation"
        || diagnostic.bySeat[seat === 1 ? 2 : 1].mode !== "atomic-puct-control") {
      throw new Error(`phase arena arm mapping mismatch in game ${report.id}`);
    }
    if (diagnostic.bySeat[1].moves + diagnostic.bySeat[2].moves !== report.actions) {
      throw new Error(`phase arena move accounting mismatch in game ${report.id}`);
    }
    for (const armSeat of [1, 2] as const) {
      const arm = diagnostic.bySeat[armSeat];
      const total = totals[arm.mode];
      total.moves += arm.moves;
      total.totalNetworkPositions += arm.networkPositions;
      total.maximumNetworkPositionsPerMove = Math.max(total.maximumNetworkPositionsPerMove, arm.maximumPositionsPerMove);
      total.searchElapsedMs += arm.searchElapsedMs;
      total.fallbackMoves += arm.fallbackMoves;
      if (arm.fallbackMoves) fallbackSources.push({ gameId: report.id, seat: armSeat,
        mode: arm.mode, fallbackMoves: arm.fallbackMoves });
    }
    fallbackMoves += diagnostic.bySeat[1].fallbackMoves + diagnostic.bySeat[2].fallbackMoves;
    positionBudgetViolations += Number(diagnostic.bySeat[1].maximumPositionsPerMove > PHASE_ARENA.maximumNetworkPositionsPerMove)
      + Number(diagnostic.bySeat[2].maximumPositionsPerMove > PHASE_ARENA.maximumNetworkPositionsPerMove);
    if (!report.finished || report.truncated) { row.truncated++; points.push(0); continue; }
    const win = report.winningTeamIds.includes(`team-${seat}`);
    const draw = report.winningTeamIds.length === 0;
    const point = win ? 1 : draw ? 0.5 : 0;
    row.wins += Number(win); row.draws += Number(draw); row.losses += Number(!win && !draw);
    row.points += point; points.push(point);
  }
  const pairs = Array.from({ length: PHASE_ARENA.games / 2 }, (_, index) =>
    (points[index * 2]! + points[index * 2 + 1]!) / 2);
  const random = randomSource(PHASE_ARENA.bootstrapSeed);
  const estimates = Array.from({ length: PHASE_ARENA.bootstrapSamples }, () => {
    let total = 0;
    for (let index = 0; index < pairs.length; index++) total += pairs[Math.floor(random() * pairs.length)]!;
    return total / pairs.length;
  }).sort((a, b) => a - b);
  const pairedBootstrap95: [number, number] = [estimates[99]!, estimates[3899]!];
  const scoreRate = pairs.reduce((sum, value) => sum + value, 0) / pairs.length;
  const truncatedGames = scoreBySeat[1].truncated + scoreBySeat[2].truncated;
  const declaredGatePassed = truncatedGames === 0 && scoreRate > 0.55 && pairedBootstrap95[0] > 0.5;
  const unambiguous = fallbackMoves === 0 && positionBudgetViolations === 0;
  const byAlgorithm = Object.fromEntries(Object.entries(totals).map(([mode, total]) => [mode, {
    ...total, averageNetworkPositionsPerMove: total.moves ? total.totalNetworkPositions / total.moves : 0
  }])) as ReturnType<typeof phaseArenaGate>["byAlgorithm"];
  return { complete: true, games: reports.length, scoreRate, scoreBySeat, pairedBootstrap95,
    bootstrapSeed: PHASE_ARENA.bootstrapSeed, truncatedGames, fallbackMoves, positionBudgetViolations,
    declaredGatePassed, uniquePairedSeeds: pairedSeeds.size, byAlgorithm, fallbackSources,
    eligibleToProposeSmallDataExperiment: declaredGatePassed && unambiguous,
    ...(!unambiguous ? { ambiguity: "A search fallback or position-budget violation prevents interpreting the arena as the predeclared equal-budget comparison." } : {}) };
}

export function reconcilePhaseArenaInference(reports: GameReport[], inference: {
  candidate?: { positions: number }; opponent?: { positions: number };
}): { matched: true; continuationPositions: number; atomicPositions: number } {
  const continuationPositions = reports.reduce((sum, report) => sum
    + report.phaseArenaSearch!.bySeat[report.candidateSeat].networkPositions, 0);
  const atomicPositions = reports.reduce((sum, report) => sum
    + report.phaseArenaSearch!.bySeat[report.candidateSeat === 1 ? 2 : 1].networkPositions, 0);
  if (inference.candidate?.positions !== continuationPositions || inference.opponent?.positions !== atomicPositions) {
    throw new Error("main-process inference positions do not match per-game arm totals");
  }
  return { matched: true, continuationPositions, atomicPositions };
}
