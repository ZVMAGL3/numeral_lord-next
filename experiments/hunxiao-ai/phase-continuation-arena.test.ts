import assert from "node:assert/strict";
import test from "node:test";
import { PHASE_ARENA, phaseArenaGate, phaseArenaSearchOptions, reconcilePhaseArenaInference } from "./phase-continuation-arena.js";
import type { GameReport, PhaseArenaSeatDiagnostics } from "./protocol.js";

function diagnostic(mode: PhaseArenaSeatDiagnostics["mode"]): PhaseArenaSeatDiagnostics {
  return { mode, moves: 10, networkPositions: 2580, maximumPositionsPerMove: 258,
    searchElapsedMs: 100, completedSimulations: 80, fallbackMoves: 0,
    incompleteContinuations: 0, incompleteByEvaluationBudget: 0, incompleteByStepLimit: 0,
    incompleteEvaluationPositions: 0 };
}

function reports(): GameReport[] {
  return Array.from({ length: PHASE_ARENA.games }, (_, id) => {
    const candidateSeat = (id % 2 + 1) as 1 | 2;
    return {
      id, seed: PHASE_ARENA.seed + Math.floor(id / 2), policies: ["network", "network"],
      candidateSeat, selfPlay: false, actions: 20, rounds: 2, finished: true,
      winningTeamIds: [`team-${candidateSeat}`], pointsByTeam: {}, occupiedCellsByTeam: {},
      notation: [], truncated: false, learningEligible: false, trainingFilteredAfterRound: false,
      elapsedMs: 1000, sampleCount: 0, searchSimulations: 160,
      phaseArenaSearch: { maximumNetworkPositionsPerMove: 258,
        bySeat: { 1: diagnostic(candidateSeat === 1 ? "leaf-policy-continuation" : "atomic-puct-control"),
          2: diagnostic(candidateSeat === 2 ? "leaf-policy-continuation" : "atomic-puct-control") } }
    };
  });
}

test("phase arena assigns equal hard position caps without changing ordinary search defaults", () => {
  const continuation = phaseArenaSearchOptions("continuation", 17);
  const atomic = phaseArenaSearchOptions("atomic", 17);
  assert.equal(continuation.leafContinuation?.evaluationBudget, 258);
  assert.equal(continuation.leafContinuation?.maximumAtomicSteps, 64);
  assert.equal(continuation.simulations, 256);
  assert.equal(atomic.leafContinuation, undefined);
  assert.equal(atomic.simulations, 257, "root plus 257 expansions is capped at 258 positions");
  assert.equal(atomic.minimumSimulations, 257);
  assert.equal(continuation.timeLimitMs, undefined);
  assert.equal(atomic.timeLimitMs, undefined);
});

test("paired 32-game gate applies score, interval and zero-truncation requirements", () => {
  const result = phaseArenaGate(reports());
  assert.equal(result.scoreRate, 1);
  assert.deepEqual(result.pairedBootstrap95, [1, 1]);
  assert.equal(result.truncatedGames, 0);
  assert.equal(result.declaredGatePassed, true);
  assert.equal(result.eligibleToProposeSmallDataExperiment, true);

  const truncated = reports();
  truncated[0]!.finished = false;
  truncated[0]!.truncated = true;
  const failed = phaseArenaGate(truncated);
  assert.equal(failed.declaredGatePassed, false);
  assert.equal(failed.eligibleToProposeSmallDataExperiment, false);
});

test("fallbacks remain in the full result but make an otherwise winning arena ambiguous", () => {
  const games = reports();
  games[4]!.phaseArenaSearch!.bySeat[games[4]!.candidateSeat].fallbackMoves = 1;
  const result = phaseArenaGate(games);
  assert.equal(result.declaredGatePassed, true);
  assert.equal(result.fallbackMoves, 1);
  assert.equal(result.eligibleToProposeSmallDataExperiment, false);
  assert.match(result.ambiguity ?? "", /fallback/);
});

test("paired seed or candidate-seat drift fails closed", () => {
  const wrongSeed = reports();
  wrongSeed[1]!.seed++;
  assert.throws(() => phaseArenaGate(wrongSeed), /paired seed mismatch/);
  const wrongSeat = reports();
  wrongSeat[0]!.candidateSeat = 2;
  assert.throws(() => phaseArenaGate(wrongSeat), /candidate seat mismatch/);
});

test("arm mapping, move totals and main-process inference positions reconcile exactly", () => {
  const games = reports();
  const result = phaseArenaGate(games);
  assert.equal(result.uniquePairedSeeds, 16);
  assert.equal(result.byAlgorithm["leaf-policy-continuation"].moves, 320);
  assert.equal(result.byAlgorithm["atomic-puct-control"].moves, 320);
  const continuationPositions = result.byAlgorithm["leaf-policy-continuation"].totalNetworkPositions;
  const atomicPositions = result.byAlgorithm["atomic-puct-control"].totalNetworkPositions;
  assert.deepEqual(reconcilePhaseArenaInference(games, {
    candidate: { positions: continuationPositions }, opponent: { positions: atomicPositions }
  }), { matched: true, continuationPositions, atomicPositions });
  assert.throws(() => reconcilePhaseArenaInference(games, {
    candidate: { positions: continuationPositions + 1 }, opponent: { positions: atomicPositions }
  }), /do not match/);

  const wrongMoves = reports();
  wrongMoves[0]!.phaseArenaSearch!.bySeat[1].moves++;
  assert.throws(() => phaseArenaGate(wrongMoves), /move accounting mismatch/);
  const wrongArm = reports();
  wrongArm[0]!.phaseArenaSearch!.bySeat[1].mode = "atomic-puct-control";
  assert.throws(() => phaseArenaGate(wrongArm), /arm mapping mismatch/);
});
