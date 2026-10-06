import { parentPort, workerData } from "node:worker_threads";
import { appendActionNotation, appendPhaseEndNotation, appendReinforcementNotation } from "../../packages/game-core/src/index.js";
import { createEnvironment } from "./environment.js";
import { occupiedCellsByTeam, totalStrengthByTeam } from "./temporary-rules.js";
import { createHeuristicEvaluator, encodeForSearch, search } from "./search.js";
import { isWithinLearningRoundWindow } from "./training-policy.js";
import type { Evaluator } from "./search.js";
import type { GameOutput, JobOptions, PositionPayload, TrainingSample } from "./protocol.js";
import type { NetworkResult } from "./runtime.js";

if (!parentPort) throw new Error("worker.ts must run in a worker thread");
const port = parentPort;
const env = createEnvironment(undefined, { includeTemporaryRoundLimit: workerData?.includeTemporaryRoundLimit === true });
const teacher = createHeuristicEvaluator(env);
let inferenceId = 0;
const pending = new Map<number, { resolve: (results: NetworkResult[]) => void; reject: (error: Error) => void }>();

function randomSource(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}

function choose(policy: number[], random: () => number, exploratory: boolean): number {
  if (!exploratory) return policy.indexOf(Math.max(...policy));
  let remaining = random();
  for (let i = 0; i < policy.length; i += 1) { remaining -= policy[i]!; if (remaining <= 0) return i; }
  return policy.length - 1;
}

function network(slot: string): Evaluator {
  return (positions) => new Promise((resolve, reject) => {
    const id = inferenceId++;
    pending.set(id, { resolve, reject });
    const payload: PositionPayload[] = positions.map(({ observation, global, candidates }) => ({ observation, global, candidates }));
    port.postMessage({ type: "inference", id, slot, positions: payload });
  });
}

async function run(job: JobOptions): Promise<GameOutput> {
  const random = randomSource(job.seed);
  const sampleRandom = randomSource(job.seed ^ 0x5f3759df);
  let state = env.initialState();
  const samplesBySeat: Record<1 | 2, TrainingSample[]> = { 1: [], 2: [] };
  const sampleTeamsBySeat: Record<1 | 2, string[]> = { 1: [], 2: [] };
  const eligibleSamplesBySeat: Record<1 | 2, number> = { 1: 0, 2: 0 };
  const replay: NonNullable<GameOutput["report"]["replay"]> = [];
  let notation: Parameters<typeof appendPhaseEndNotation>[0] = [];
  let actions = 0;
  let searchSimulations = 0;
  let maxRoundPlayed = 0;
  const started = performance.now();
  while (state.turn.phase !== "finished" && actions < job.maxActions) {
    maxRoundPlayed = Math.max(maxRoundPlayed, state.turn.round);
    const encoded = env.encode(state);
    if (!encoded.intents.length) throw new Error("unfinished state has no legal actions");
    const seat = state.players[state.turn.currentPlayerId]!.seat as 1 | 2;
    const policyKind = job.policies[seat - 1]!;
    let policy: number[];
    let intent;
    let simulations = 0;
    if (policyKind === "random") {
      policy = encoded.intents.map(() => 1 / encoded.intents.length);
      intent = encoded.intents[choose(policy, random, true)]!;
    } else if (policyKind === "teacher") {
      const result = (await teacher([encodeForSearch(env, state)]))[0]!;
      policy = result.priors;
      intent = encoded.intents[choose(policy, random, job.exploratory)]!;
    } else {
      const evaluator = policyKind === "network"
        ? network(job.networkOpponent && seat !== job.candidateSeat ? job.opponentSlot ?? "opponent" : "candidate") : teacher;
      // Diversify openings, then let the learned policy finish the game without perpetual noise.
      const openingExploration = job.exploratory && actions < 80;
      const result = await search(env, state, evaluator, { simulations: job.simulations, seed: Math.floor(random() * 0xffffffff),
        // Vary self-play openings, then let the learned policy finish without perpetual noise.
        // Evaluation games set exploratory=false and remain deterministic for comparison.
        temperature: job.exploratory ? (actions < 80 ? 1 : 0.2) : 0, rootNoise: openingExploration ? 0.12 : 0, maxDepth: 96,
        ...(job.thinkMs > 0 ? { timeLimitMs: job.thinkMs } : {}) });
      policy = result.policy;
      intent = result.intent;
      simulations = result.stats.simulations;
      searchSimulations += simulations;
    }
    // Reservoir sampling bounds memory while retaining positions across the full game.
    if (job.collect && job.maxSamples > 0 && policyKind !== "random"
      && (!job.networkOpponent || seat === job.candidateSeat)
      && isWithinLearningRoundWindow(state.turn.round, job.maxLearningRounds)) {
      eligibleSamplesBySeat[seat] += 1;
      const sample: TrainingSample = { schemaVersion: 1, fingerprint: env.fingerprint, gameId: job.id, ply: actions, seat,
        observation: encoded.observation, global: encoded.global, candidates: encoded.candidates,
        policy, value: null, valueSource: "unlabelled", simulations };
      // A leading side often generates more atomic actions. Cap each seat
      // separately so that the replay buffer does not learn mostly from it.
      const extraSeat = (job.id % 2 + 1) as 1 | 2;
      const seatLimit = job.networkOpponent
        ? job.maxSamples
        : Math.floor(job.maxSamples / 2) + Number(job.maxSamples % 2 === 1 && seat === extraSeat);
      const bucket = samplesBySeat[seat];
      const teamBucket = sampleTeamsBySeat[seat];
      const destination = bucket.length < seatLimit
        ? bucket.length
        : Math.floor(sampleRandom() * eligibleSamplesBySeat[seat]);
      if (destination < seatLimit) {
        bucket[destination] = sample;
        teamBucket[destination] = encoded.teamId;
      }
    }
    if (job.recordReplay) replay.push({ sequence: state.sequence, round: state.turn.round, phase: state.turn.phase, seat, intent });
    if (intent.type === "move-unit" || intent.type === "attack-unit") {
      const sourceCell = state.cells[state.units[intent.unitId]!.cellId]!;
      const targetCellId = intent.type === "move-unit" ? intent.destinationId : intent.targetId;
      const targetCell = state.cells[targetCellId]!;
      notation = appendActionNotation(notation, sourceCell.coordinate, targetCell.coordinate);
    } else if (intent.type === "reinforce-unit") {
      const sourceCell = state.cells[state.units[intent.unitId]!.cellId]!;
      notation = appendReinforcementNotation(notation, sourceCell.coordinate, 1);
    } else if (intent.type === "end-action-phase" || intent.type === "end-reinforcement-phase") {
      notation = appendPhaseEndNotation(notation, state.turn.phase);
    }
    state = env.step(state, intent);
    actions += 1;
  }
  const finished = state.turn.phase === "finished";
  const trainingFilteredAfterRound = job.maxLearningRounds > 0
    && (maxRoundPlayed > job.maxLearningRounds || state.turn.round > job.maxLearningRounds);
  const orderedSamples = ([1, 2] as const).flatMap((seat) => samplesBySeat[seat].map((sample, index) => ({
    sample, team: sampleTeamsBySeat[seat][index]!
  }))).sort((a, b) => a.sample.ply - b.sample.ply);
  const samples = orderedSamples.map((entry) => entry.sample);
  const sampleTeams = orderedSamples.map((entry) => entry.team);
  const learningEligible = samples.length > 0;
  let bootstrapTeam: string | undefined;
  let bootstrapValue = 0;
  if (!trainingFilteredAfterRound && !finished && job.bootstrap === "network") {
    const position = env.encode(state);
    bootstrapTeam = position.teamId;
    bootstrapValue = (await network("candidate")([position]))[0]!.value;
  }
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const team = sampleTeams[i]!;
    if (finished) {
      sample.value = env.terminalValue(state, team as Parameters<typeof env.terminalValue>[1]);
      sample.valueSource = "terminal";
    } else if (!trainingFilteredAfterRound && job.bootstrap === "teacher") {
      sample.value = env.heuristic(state, team as Parameters<typeof env.heuristic>[1]);
      sample.valueSource = "teacher-bootstrap";
    } else if (!trainingFilteredAfterRound && job.bootstrap === "network") {
      sample.value = team === bootstrapTeam ? bootstrapValue : -bootstrapValue;
      sample.valueSource = "network-bootstrap";
    }
  }
  const report: GameOutput["report"] = { id: job.id, seed: job.seed, policies: job.policies,
    candidateSeat: job.candidateSeat, selfPlay: !job.networkOpponent && job.policies[0] === "network" && job.policies[1] === "network",
    actions, rounds: state.turn.round,
    ...(job.opponentLabel ? { opponentModel: job.opponentLabel } : {}),
    finished, winningTeamIds: [...(state.result?.winningTeamIds ?? [])], truncated: !finished, learningEligible, trainingFilteredAfterRound,
    ...(trainingFilteredAfterRound && job.collect
      ? { trainingFilterMessage: `第 ${job.maxLearningRounds + 1} 回合及以后不采集局面；之前的训练样本保留。` } : {}),
    pointsByTeam: { ...totalStrengthByTeam(state) }, occupiedCellsByTeam: { ...occupiedCellsByTeam(state) },
    notation: notation.map((entry) => [...entry.tuple] as [number, number, number]),
    ...(state.result?.message ? { resultMessage: state.result.message } : {}),
    elapsedMs: performance.now() - started, sampleCount: samples.length, searchSimulations,
    ...(job.recordReplay ? { replay } : {}) };
  return { samples, report };
}

let busy = false;
port.on("message", (message: { type: string; id?: number; results?: NetworkResult[]; error?: string; job?: JobOptions }) => {
  if (message.type === "inference-result") {
    const request = pending.get(message.id!);
    if (!request) return;
    pending.delete(message.id!);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.results!);
  } else if (message.type === "job") {
    if (busy) { port.postMessage({ type: "error", error: "worker received overlapping jobs" }); return; }
    busy = true;
    void run(message.job!).then((output) => port.postMessage({ type: "complete", output }))
      .catch((error: unknown) => port.postMessage({ type: "error", error: error instanceof Error ? error.stack : String(error) }))
      .finally(() => { busy = false; });
  }
});
port.postMessage({ type: "ready", fingerprint: env.fingerprint });
