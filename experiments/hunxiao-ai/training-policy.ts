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
