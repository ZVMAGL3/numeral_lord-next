import assert from "node:assert/strict";
import test from "node:test";
import type { GameIntent, GameState } from "../../packages/game-core/src/index.js";
import {
  createHeuristicEvaluator, encodeForSearch, search,
  type EncodedPosition, type Evaluator, type SearchEnvironment
} from "./search.js";

interface GraphNode {
  team: "A" | "B";
  children?: number[];
  terminalA?: number;
  heuristicA?: number;
}

/** Tiny deterministic engine graphs isolate perspective and backup correctness. */
function graphEnvironment(graph: GraphNode[]): SearchEnvironment & { initial: GameState } {
  const stateAt = (index: number): GameState => ({
    sequence: index,
    settings: { friendlyFire: false },
    board: { columns: 9, rows: 9 },
    turn: {
      phase: graph[index]!.terminalA === undefined ? "action" : "finished",
      currentPlayerId: graph[index]!.team === "A" ? "p1" : "p2",
      round: 1, exhaustedUnitIds: [], counterattacksUsed: {}
    },
    cells: {}, units: {},
    players: { p1: { id: "p1", teamId: "A" }, p2: { id: "p2", teamId: "B" } },
    teams: {}
  } as unknown as GameState);
  const intentsAt = (index: number): GameIntent[] => (graph[index]!.children ?? []).map((target, offset) => ({
    type: "move-unit", unitId: `u-${offset}`, destinationId: `${target}`
  } as GameIntent));
  const env: SearchEnvironment & { initial: GameState } = {
    initial: stateAt(0),
    team: (state) => graph[state.sequence]!.team,
    legal: (state) => intentsAt(state.sequence),
    step: (state, intent) => {
      const legal = intentsAt(state.sequence);
      assert.ok(legal.some((candidate) => JSON.stringify(candidate) === JSON.stringify(intent)), "engine rejects illegal intent");
      assert.equal(intent.type, "move-unit");
      return stateAt(Number((intent as Extract<GameIntent, { type: "move-unit" }>).destinationId));
    },
    terminalValue: (state, team) => {
      const value = graph[state.sequence]!.terminalA;
      return value === undefined ? null : team === "A" ? value : -value;
    },
    heuristic: (state, team) => (graph[state.sequence]!.heuristicA ?? 0) * (team === "A" ? 1 : -1),
    encode: (state) => {
      const intents = intentsAt(state.sequence);
      return {
        observation: [state.sequence], global: [],
        candidates: intents.map(() => Array<number>(16).fill(0)),
        intents, teamId: graph[state.sequence]!.team
      };
    }
  };
  return env;
}

const uniform: Evaluator = async (positions) => positions.map((position) => ({
  priors: position.intents.map(() => 1), value: 0
}));

function destination(intent: GameIntent): string {
  assert.equal(intent.type, "move-unit");
  return (intent as Extract<GameIntent, { type: "move-unit" }>).destinationId;
}

function checkPolicy(result: Awaited<ReturnType<typeof search>>, expectedLength: number): void {
  assert.equal(result.policy.length, expectedLength);
  assert.equal(result.visits.length, expectedLength);
  assert.ok(result.policy.every((prior) => Number.isFinite(prior) && prior >= 0));
  assert.ok(Math.abs(result.policy.reduce((sum, prior) => sum + prior, 0) - 1) < 1e-12);
}

test("consecutive same-team commands preserve value sign", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2] },
    { team: "A", children: [3] },
    { team: "A", terminalA: 0 },
    { team: "B", terminalA: 1 }
  ]);
  const result = await search(env, env.initial, uniform, { simulations: 80, temperature: 0, seed: 7 });
  assert.equal(destination(result.intent), "1");
  assert.ok(result.value > 0.7, `expected winning root value, got ${result.value}`);
  checkPolicy(result, 2);
});

test("opponent nodes maximize their own team's value", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2] },
    { team: "B", children: [3, 4] },
    { team: "A", terminalA: 0 },
    { team: "A", terminalA: -1 },
    { team: "A", terminalA: 1 }
  ]);
  const result = await search(env, env.initial, uniform, { simulations: 160, temperature: 0, seed: 42 });
  assert.equal(destination(result.intent), "2", "avoid an opponent-controlled trap");
  assert.ok(result.visits[1]! > result.visits[0]!);
});

test("exact terminal results override misleading evaluator values", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2] },
    { team: "B", terminalA: -1 },
    { team: "B", terminalA: 1 }
  ]);
  let calls = 0;
  const misleading: Evaluator = async (positions) => {
    calls++;
    assert.ok(positions.every((position) => position.observation[0] === 0), "terminal states never reach neural evaluator");
    return positions.map((position) => ({ priors: position.intents.map(() => 1), value: -0.9 }));
  };
  const result = await search(env, env.initial, misleading, { simulations: 40, temperature: 0, seed: 1 });
  assert.equal(destination(result.intent), "2");
  assert.equal(calls, 1);
  assert.ok(result.value > 0.8);
});

test("depth cutoff bootstraps a leaf value rather than inventing a draw", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1] },
    { team: "B", children: [2] },
    { team: "A", terminalA: 1 }
  ]);
  const evaluator: Evaluator = async (positions) => positions.map((position) => ({
    priors: position.intents.map(() => 1), value: position.teamId === "B" ? 0.7 : 0
  }));
  const result = await search(env, env.initial, evaluator, { simulations: 12, maxDepth: 1, seed: 2 });
  assert.ok(Math.abs(result.value + 0.7) < 1e-12);
  assert.equal(result.stats.maxDepth, 1);
  assert.deepEqual(result.visits, [12]);
});

test("zero edge visits fall back to normalized legal priors", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2] },
    { team: "A", terminalA: -1 }, { team: "A", terminalA: 1 }
  ]);
  const evaluator: Evaluator = async () => [{ priors: [1, 3], value: 0.35 }];
  const result = await search(env, env.initial, evaluator, { simulations: 5, maxDepth: 0, seed: 2 });
  assert.deepEqual(result.visits, [0, 0]);
  assert.deepEqual(result.policy, [0.25, 0.75]);
  assert.ok(Math.abs(result.value - 0.35) < 1e-12);
  checkPolicy(result, 2);
});

test("seed reproduces exploration noise, visits, selected intent and value", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2, 3] },
    { team: "A", terminalA: 0 }, { team: "A", terminalA: 0 }, { team: "A", terminalA: 0 }
  ]);
  const opts = { simulations: 36, rootNoise: 0.25, seed: 8192, temperature: 1 };
  const a = await search(env, env.initial, uniform, opts);
  const b = await search(env, env.initial, uniform, opts);
  assert.deepEqual(a.intent, b.intent);
  assert.deepEqual(a.visits, b.visits);
  assert.deepEqual(a.policy, b.policy);
  assert.equal(a.value, b.value);
  assert.ok(env.legal(env.initial).some((intent) => JSON.stringify(intent) === JSON.stringify(a.intent)));
  checkPolicy(a, 3);
});

test("shallow teacher discovers immediate wins without removing any legal action", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2, 3] },
    { team: "B", terminalA: -1 }, { team: "B", terminalA: 1 }, { team: "A", heuristicA: 0.1, children: [0] }
  ]);
  const teacher = createHeuristicEvaluator(env, { teacherDepth: 1 });
  const encoded = encodeForSearch(env, env.initial);
  const [evaluation] = await teacher([encoded]);
  assert.equal(evaluation!.priors.length, 3);
  assert.ok(evaluation!.priors.every((prior) => prior > 0));
  assert.ok(evaluation!.priors[1]! > 0.9);
  assert.equal(evaluation!.value, 1);
  assert.equal(Object.hasOwn(encoded, "state"), false, "teacher state stays outside neural IPC data");
  const result = await search(env, env.initial, teacher, { simulations: 1, temperature: 0, seed: 3 });
  assert.equal(destination(result.intent), "2");
  checkPolicy(result, 3);
});

test("teacher minimax also preserves consecutive team turns and opposes enemy choices", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2, 3] },
    { team: "A", children: [4, 5] },
    { team: "B", children: [4, 5] },
    { team: "A", terminalA: 0 },
    { team: "A", terminalA: 1 }, { team: "A", terminalA: -1 }
  ]);
  const teacher = createHeuristicEvaluator(env, { teacherDepth: 2 });
  const [evaluation] = await teacher([encodeForSearch(env, env.initial)]);
  assert.ok(evaluation!.priors[0]! > evaluation!.priors[2]!);
  assert.ok(evaluation!.priors[2]! > evaluation!.priors[1]!);
});

test("teacher rejects unregistered positions and positions from another environment", async () => {
  const graph: GraphNode[] = [{ team: "A", children: [1] }, { team: "A", terminalA: 1 }];
  const first = graphEnvironment(graph);
  const second = graphEnvironment(graph);
  const teacher = createHeuristicEvaluator(first);
  await assert.rejects(teacher([first.encode(first.initial)]), /encodeForSearch/);
  await assert.rejects(teacher([encodeForSearch(second, second.initial)]), /this environment/);
});

test("evaluator cannot omit, reorder or add legal candidates", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2] }, { team: "A", terminalA: 0 }, { team: "A", terminalA: 1 }
  ]);
  await assert.rejects(search(env, env.initial, async () => [{ priors: [1], value: 0 }], { simulations: 1 }), /every legal candidate/);
  const encode = env.encode;
  env.encode = (state): EncodedPosition => ({ ...encode(state), intents: [...encode(state).intents].reverse() });
  await assert.rejects(search(env, env.initial, uniform, { simulations: 1 }), /complete legal intent order/);
});

test("malformed evaluation batches, invalid priors and NaN values are rejected", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2] }, { team: "A", terminalA: 0 }, { team: "A", terminalA: 1 }
  ]);
  const cases: Array<{ evaluation: unknown; pattern: RegExp }> = [
    { evaluation: [], pattern: /one result per position/ },
    { evaluation: [{ priors: [1, NaN], value: 0 }], pattern: /finite and nonnegative/ },
    { evaluation: [{ priors: [1, -1], value: 0 }], pattern: /finite and nonnegative/ },
    { evaluation: [{ priors: [0, 0], value: 0 }], pattern: /positive sum/ },
    { evaluation: [{ priors: [1, 1], value: NaN }], pattern: /finite value/ },
    { evaluation: [{ priors: [1, 1], value: 1.1 }], pattern: /finite value/ }
  ];
  for (const entry of cases) {
    await assert.rejects(search(env, env.initial, async () => entry.evaluation as Awaited<ReturnType<Evaluator>>, { simulations: 1 }), entry.pattern);
  }
});

test("terminal roots and invalid search limits are rejected", async () => {
  const terminal = graphEnvironment([{ team: "A", terminalA: 1 }]);
  await assert.rejects(search(terminal, terminal.initial, uniform, { simulations: 1 }), /terminal position/);
  const env = graphEnvironment([{ team: "A", children: [1] }, { team: "A", terminalA: 1 }]);
  await assert.rejects(search(env, env.initial, uniform, { simulations: 0 }), /positive integer/);
  await assert.rejects(search(env, env.initial, uniform, { simulations: 1, maxDepth: -1 }), /nonnegative integer/);
  await assert.rejects(search(env, env.initial, uniform, { simulations: 1, timeLimitMs: 0 }), /finite and positive/);
});

test("soft time budget guarantees one simulation and reports actual work", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1] }, { team: "A", terminalA: 1 }
  ]);
  const slowRoot: Evaluator = async (positions) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return uniform(positions);
  };
  const result = await search(env, env.initial, slowRoot, { simulations: 100, timeLimitMs: 1, seed: 2 });
  assert.equal(result.stats.simulations, 1);
  assert.deepEqual(result.visits, [1]);
  assert.equal(result.value, 1);
  assert.ok(result.stats.elapsedMs >= 1, "in-flight evaluator is allowed to exceed a soft budget");
});

test("action temperature does not discard root-visit training targets", async () => {
  const env = graphEnvironment([
    { team: "A", children: [1, 2, 3] },
    { team: "B", terminalA: 0 }, { team: "B", terminalA: 0 }, { team: "B", terminalA: 0 }
  ]);
  const cold = await search(env, env.initial, uniform, { simulations: 35, temperature: 0, seed: 19 });
  const warm = await search(env, env.initial, uniform, { simulations: 35, temperature: 1, seed: 19 });
  assert.deepEqual(cold.visits, warm.visits);
  cold.visits.forEach((count, index) => {
    assert.ok(Math.abs(cold.policy[index]! - count / 35) < 1e-12);
  });
  assert.deepEqual(cold.policy, warm.policy);
  assert.ok(cold.policy.every((probability) => probability > 0));
});
