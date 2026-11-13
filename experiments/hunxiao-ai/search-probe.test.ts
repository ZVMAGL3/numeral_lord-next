import assert from "node:assert/strict";
import test from "node:test";
import type { GameIntent, GameState } from "../../packages/game-core/src/index.js";
import { jensenShannon, observeTransitions, policySummary, probeMode, validateReferenceReport } from "./search-probe.js";
import type { SearchEnvironment } from "./search.js";

function state(sequence: number, phase: "action" | "reinforcement", player: "p1" | "p2"): GameState {
  return {
    sequence,
    turn: { phase, currentPlayerId: player, round: 1, exhaustedUnitIds: [], counterattacksUsed: {} },
    players: {
      p1: { id: "p1", seat: 1, teamId: "A", reinforcementPoints: 2 },
      p2: { id: "p2", seat: 2, teamId: "B", reinforcementPoints: 2 }
    }
  } as unknown as GameState;
}

test("transition observer records same-player phase continuation and opponent handoff", () => {
  const intent = { type: "end-action-phase" } as GameIntent;
  const base: SearchEnvironment = {
    legal: () => [intent],
    step: (position) => position.sequence === 0 ? state(1, "reinforcement", "p1")
      : position.sequence === 1 ? state(2, "action", "p2") : state(3, "reinforcement", "p2"),
    terminalValue: () => null,
    encode: () => ({ observation: [], global: [], candidates: [[]], intents: [intent], teamId: "A" }),
    heuristic: () => 0,
    team: (position) => position.players[position.turn.currentPlayerId]!.teamId
  };
  const observed = observeTransitions(base);
  const reinforcement = observed.env.step(state(0, "action", "p1"), intent);
  const opponentTurn = observed.env.step(reinforcement, intent);
  const stepCallsByTeam: Record<string, number> = observed.observation.stepCallsByTeam;
  assert.deepEqual(observed.observation, {
    stepCalls: 2,
    teamSwitches: 1,
    seatSwitches: 1,
    stepCallsByTeam: { A: 2 },
    encodedNodesByTeam: {},
    phaseTransitions: { "action->reinforcement": 1, "reinforcement->action": 1 },
    phaseExitSteps: [
      { parentSequence: 0, fromPhase: "action", toPhase: "reinforcement", actingTeam: "A",
        actingSeat: 1, reinforcementPoints: 2, intentType: "end-action-phase" },
      { parentSequence: 1, fromPhase: "reinforcement", toPhase: "action", actingTeam: "A",
        actingSeat: 1, reinforcementPoints: 2, intentType: "end-action-phase" }
    ]
  });
  assert.equal(stepCallsByTeam.B ?? 0, 0,
    "reaching the opponent turn is not yet exploring an opponent response");
  observed.env.step(opponentTurn, intent);
  assert.equal(stepCallsByTeam.B, 1,
    "stepping from the opponent parent records an explored opponent response");
});

test("policy diagnostics report support and symmetric information delta", () => {
  const summary = policySummary([0.5, 0.5, 0], [2, 2, 0]);
  assert.equal(summary.visitedActions, 2);
  assert.equal(summary.visitedLegalFraction, 2 / 3);
  assert.ok(Math.abs(summary.effectiveActionCount - 2) < 1e-12);
  const divergence = jensenShannon([0.75, 0.25], [0.25, 0.75]);
  assert.ok(divergence > 0);
  assert.equal(divergence, jensenShannon([0.25, 0.75], [0.75, 0.25]));
  assert.equal(jensenShannon([0.75, 0.25], [0.75, 0.25]), 0);
});

test("budget mode keeps the baseline and requires frozen provenance for 256", () => {
  assert.deepEqual(probeMode("4,16,64"), { kind: "baseline", budgets: [4, 16, 64] });
  assert.deepEqual(probeMode("256", "reference.json", "ABC"), {
    kind: "reference-extension", budgets: [256], reference: "reference.json", referenceSha256: "abc"
  });
  assert.throws(() => probeMode("256"), /requires --reference/);
  assert.throws(() => probeMode("4,16,64", "reference.json", "abc"), /does not accept/);
  assert.throws(() => probeMode("64,256", "reference.json", "abc"), /must be exactly/);
});

test("reference validation accepts exact frozen settings and rejects provenance drift", () => {
  const budget = {
    actualSimulations: 64, maximumAtomicDepth: 5, expanded: 65,
    opponentResponseSteps: 2, exploredOpponentResponse: true,
    reachedDifferentPhase: true, reachedDifferentTeam: true,
    selectedIntentKey: "end-action-phase", policy: [0.25, 0.75],
    policySummary: { visitedLegalFraction: 1 }
  };
  const reference = {
    schemaVersion: 1, status: "complete", checkpoint: "model.pt", checkpointSha256: "checkpoint",
    modelFamily: "hex-graph-v1", fingerprint: "fingerprint", casesSha256: "cases",
    settings: { budgets: [4, 16, 64], minimumSimulations: "equals each budget", thinkMs: 0,
      seed: 7, maxDepth: 96, temperature: 0, rootNoise: 0 },
    caseResults: [{ id: "case", stateSha256: "state", budgets: [budget] }]
  };
  const expected = { checkpoint: "model.pt", checkpointSha256: "checkpoint", fingerprint: "fingerprint",
    casesSha256: "cases", seed: 7, maxDepth: 96, cases: [{ id: "case", stateSha256: "state" }] };
  assert.doesNotThrow(() => validateReferenceReport(reference, expected));
  assert.throws(() => validateReferenceReport({ ...reference, settings: { ...reference.settings, seed: 8 } }, expected),
    /provenance/);
  assert.throws(() => validateReferenceReport({ ...reference,
    caseResults: [{ ...reference.caseResults[0]!, stateSha256: "changed" }] }, expected), /frozen 64/);
});
