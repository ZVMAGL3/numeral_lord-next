import assert from "node:assert/strict";
import test from "node:test";
import { selectRelabelRoots } from "./offline-paired-relabel.js";

function manifest(): Parameters<typeof selectRelabelRoots>[0] {
  const strata = ["1/action/opening", "1/action/later", "1/reinforcement/opening", "1/reinforcement/later",
    "2/action/opening", "2/action/later", "2/reinforcement/opening", "2/reinforcement/later"];
  return {
    schemaVersion: 1, fingerprint: "f", source: "source", sourceMetadataSha256: "m",
    sourceSampleSha256: "s", sourceRows: 1, sourceBytes: 1, seed: 100,
    games: Array.from({ length: 20 }, (_, id) => ({ id, seed: 1000 + id,
      split: [3, 10, 16, 19].includes(id) ? "validation" as const : "train" as const,
      winner: [], reportSha256: "r", replaySha256: "p",
      roots: strata.map((stratum, index) => ({ ply: index, seat: Number(stratum[0]),
        phase: stratum.includes("reinforcement") ? "reinforcement" : "action",
        round: stratum.endsWith("opening") ? 2 : 5, stratum,
        featureSha256: `${id}-${index}`, recordedPolicySupport: 0.5 })) }))
  };
}

test("offline relabel selection locks eight strata to eight different training games deterministically", () => {
  const first = selectRelabelRoots(manifest());
  const second = selectRelabelRoots(manifest());
  assert.deepEqual(first, second);
  assert.equal(first.length, 64);
  assert.equal(new Set(first.map((root) => root.featureSha256)).size, 64);
  for (const stratum of new Set(first.map((root) => root.stratum))) {
    const rows = first.filter((root) => root.stratum === stratum);
    assert.equal(rows.length, 8);
    assert.equal(new Set(rows.map((root) => root.gameId)).size, 8);
    assert.ok(rows.every((root) => ![3, 10, 16, 19].includes(root.gameId)));
  }
  assert.deepEqual(first.map((root) => root.relabelSeed), Array.from({ length: 64 }, (_, index) => 100 + index));
});

test("offline relabel selection fails closed when a stratum lacks eight training games", () => {
  const input = manifest();
  for (const game of input.games.filter((game) => game.split === "train").slice(7)) {
    game.roots = game.roots.filter((root) => root.stratum !== "1/action/opening");
  }
  assert.throws(() => selectRelabelRoots(input), /cannot supply eight different training games/);
});
