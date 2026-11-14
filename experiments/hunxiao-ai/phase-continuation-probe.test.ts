import assert from "node:assert/strict";
import test from "node:test";
import { continuationGate, validateFrozen256 } from "./phase-continuation-probe.js";

const expected = {
  checkpoint: "C:\\run\\g2.pt",
  checkpointSha256: "a".repeat(64),
  fingerprint: "normal-fingerprint",
  casesPath: "C:\\run\\cases.json",
  casesSha256: "b".repeat(64),
  cases: Array.from({ length: 6 }, (_, index) => ({
    id: `case-${index}`, stateSha256: `${index}`.repeat(64), legalIntentCount: 2
  }))
};

function frozenReference(): Parameters<typeof validateFrozen256>[0] {
  return {
    schemaVersion: 1, status: "complete", mode: "reference-extension",
    checkpoint: expected.checkpoint, checkpointSha256: expected.checkpointSha256,
    modelFamily: "hex-graph-v1", fingerprint: expected.fingerprint,
    cases: expected.casesPath, casesSha256: expected.casesSha256,
    settings: { budgets: [256], minimumSimulations: "equals each budget", thinkMs: 0,
      seed: 20261112, maxDepth: 96, temperature: 0, rootNoise: 0, device: "xpu" },
    caseResults: expected.cases.map((entry) => ({ id: entry.id, stateSha256: entry.stateSha256,
      budgets: [{ actualSimulations: 256, maximumAtomicDepth: 4, opponentResponseSteps: 0,
        exploredOpponentResponse: false, selectedIntentKey: "end-action-phase",
        policy: [0.5, 0.5], visits: [128, 128], policySummary: { visitedLegalFraction: 1 },
        inferenceDelta: { positions: 258 } }] }))
  };
}

test("frozen 256 provenance accepts only the exact six-root equal-cost control", () => {
  validateFrozen256(frozenReference(), expected);
  const wrongPositions = frozenReference();
  wrongPositions.caseResults[2]!.budgets[0]!.inferenceDelta.positions = 257;
  assert.throws(() => validateFrozen256(wrongPositions, expected), /case row mismatch/);
  const wrongSeed = frozenReference();
  wrongSeed.settings.seed++;
  assert.throws(() => validateFrozen256(wrongSeed, expected), /provenance or fixed settings/);
});

test("six-root gate requires recovery of all three frozen zero-response cases and useful coverage in five", () => {
  const passing = Array.from({ length: 6 }, (_, index) => ({
    id: `case-${index}`,
    baselineOpponentResponseSteps: index < 3 ? 0 : 10,
    accountingValid: true, legalTargetValid: true,
    completedSimulations: index === 5 ? 4 : 8,
    completedWithOpponentResponse: 1, completedWithNaturalTerminal: 0
  }));
  assert.deepEqual(continuationGate(passing), {
    pass: true, legalAndAccountingCases: 6, responseAndEightSimulationCases: 5,
    zeroResponseBaselineCases: 3, zeroResponseBaselineCasesRecovered: 3, failures: []
  });
  passing[1]!.completedWithOpponentResponse = 0;
  passing[1]!.completedWithNaturalTerminal = 1;
  const failed = continuationGate(passing);
  assert.equal(failed.pass, false);
  assert.equal(failed.zeroResponseBaselineCasesRecovered, 2);
  assert.ok(failed.failures.some((message) => message.includes("zero-response")));
  assert.ok(failed.failures.some((message) => message.includes("opponent action")),
    "a terminal-only completion must not substitute for an actual opponent action");
});
