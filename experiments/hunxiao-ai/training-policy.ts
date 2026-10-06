/**
 * Positions in the first N rounds may produce training samples. Later positions are
 * omitted while the match continues normally; earlier positions can still use the
 * match's eventual natural result as their value label.
 */
export function isWithinLearningRoundWindow(round: number, maxLearningRounds: number): boolean {
  if (!Number.isSafeInteger(round) || round < 1) throw new RangeError("round must be a positive integer");
  if (!Number.isSafeInteger(maxLearningRounds) || maxLearningRounds < 1) throw new RangeError("maxLearningRounds must be a positive integer");
  return round <= maxLearningRounds;
}
