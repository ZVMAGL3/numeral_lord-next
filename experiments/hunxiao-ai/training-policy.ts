/** A zero round limit means every round may produce training samples. */
export function isWithinLearningRoundWindow(round: number, maxLearningRounds: number): boolean {
  if (!Number.isSafeInteger(round) || round < 1) throw new RangeError("round must be a positive integer");
  if (!Number.isSafeInteger(maxLearningRounds) || maxLearningRounds < 0) throw new RangeError("maxLearningRounds must be a non-negative integer");
  return maxLearningRounds === 0 || round <= maxLearningRounds;
}

export function effectiveLearningRoundLimit(runName: string, requestedLimit: number): number {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) throw new RangeError("requestedLimit must be a non-negative integer");
  const continuousIteration = runName.match(/^hunxiao-selfplay-1000-iteration-(\d+)-\d{8}$/);
  return continuousIteration && Number(continuousIteration[1]) >= 6 ? 0 : requestedLimit;
}

/** Allow the requested full parallelism now that the local demo has been closed. */
export function effectiveWorkerCount(runName: string, requestedWorkers: number): number {
  if (!Number.isSafeInteger(requestedWorkers) || requestedWorkers < 1) throw new RangeError("requestedWorkers must be a positive integer");
  const continuousIteration = runName.match(/^hunxiao-selfplay-1000-iteration-(\d+)-\d{8}$/);
  return continuousIteration && Number(continuousIteration[1]) >= 12
    ? Math.min(requestedWorkers, 16)
    : requestedWorkers;
}

/** Raise the search budget after the 10 ms pilot proved to produce only one simulation per move. */
export function effectiveSearchBudget(
  runName: string,
  requested: { simulations: number; minimumSimulations: number; thinkMs: number },
  consecutiveNonPromotions = 0
): { simulations: number; minimumSimulations: number; thinkMs: number; multiplier: number } {
  if (!Number.isSafeInteger(requested.simulations) || requested.simulations < 1) throw new RangeError("simulations must be a positive integer");
  if (!Number.isSafeInteger(requested.minimumSimulations) || requested.minimumSimulations < 1
    || requested.minimumSimulations > requested.simulations) throw new RangeError("minimumSimulations must be an integer within the simulation budget");
  if (!Number.isSafeInteger(requested.thinkMs) || requested.thinkMs < 0) throw new RangeError("thinkMs must be a non-negative integer");
  if (!Number.isSafeInteger(consecutiveNonPromotions) || consecutiveNonPromotions < 0) throw new RangeError("consecutiveNonPromotions must be a non-negative integer");
  const continuousIteration = runName.match(/^hunxiao-selfplay-1000-iteration-(\d+)-\d{8}$/);
  if (!continuousIteration || Number(continuousIteration[1]) < 12) return { ...requested, multiplier: 1 };
  const multiplier = Math.min(1.5, 1 + 0.25 * Math.min(consecutiveNonPromotions, 2));
  const simulations = Math.max(requested.simulations, 16);
  const minimumSimulations = Math.max(requested.minimumSimulations, 4);
  const thinkMs = Math.max(requested.thinkMs, 50);
  return {
    simulations: Math.ceil(simulations * multiplier),
    minimumSimulations: Math.ceil(minimumSimulations * multiplier),
    thinkMs: Math.ceil(thinkMs * multiplier),
    multiplier
  };
}

export type SeatScoreStats = { games: number; points: number };
export const PROMOTION_SEAT2_SCORE_WEIGHT = 0.55;

/** Score models with a modest seat-2 emphasis while still reporting each seat independently. */
export function weightedSeatScoreRate(
  seats: Record<1 | 2, SeatScoreStats>,
  seat2Weight = PROMOTION_SEAT2_SCORE_WEIGHT
): number {
  if (!Number.isFinite(seat2Weight) || seat2Weight < 0 || seat2Weight > 1) {
    throw new RangeError("seat2Weight must be within [0, 1]");
  }
  for (const seat of [1, 2] as const) {
    const result = seats[seat];
    if (!Number.isSafeInteger(result.games) || result.games < 1) {
      throw new RangeError(`seat ${seat} games must be a positive integer`);
    }
    if (!Number.isFinite(result.points) || result.points < 0 || result.points > result.games) {
      throw new RangeError(`seat ${seat} points must be within [0, games]`);
    }
  }
  return (1 - seat2Weight) * (seats[1].points / seats[1].games)
    + seat2Weight * (seats[2].points / seats[2].games);
}

/** Give each seat-swapped pair the same deterministic game seed. */
export function pairedSeatSeed(baseSeed: number, gameIndex: number): number {
  if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffffffff) {
    throw new RangeError("baseSeed must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(gameIndex) || gameIndex < 0) {
    throw new RangeError("gameIndex must be a non-negative integer");
  }
  return (baseSeed + Math.floor(gameIndex / 2)) >>> 0;
}
