export type PolicyKind = "random" | "teacher" | "search" | "network";

export interface JobOptions {
  id: number;
  seed: number;
  simulations: number;
  maxActions: number;
  maxLearningRounds: number;
  policies: [PolicyKind, PolicyKind];
  collect: boolean;
  bootstrap: "none" | "teacher" | "network";
  exploratory: boolean;
  maxSamples: number;
  recordReplay: boolean;
  candidateSeat: 1 | 2;
  networkOpponent: boolean;
  opponentSlot?: string;
  opponentLabel?: string;
  thinkMs: number;
}

export interface PositionPayload {
  observation: number[];
  global: number[];
  candidates: number[][];
}

export interface TrainingSample extends PositionPayload {
  schemaVersion: 1;
  fingerprint: string;
  gameId: number;
  ply: number;
  seat: number;
  policy: number[];
  value: number | null;
  valueSource: "terminal" | "teacher-bootstrap" | "network-bootstrap" | "unlabelled";
  simulations: number;
}

export interface GameReport {
  id: number;
  seed: number;
  policies: [PolicyKind, PolicyKind];
  candidateSeat: 1 | 2;
  selfPlay: boolean;
  opponentModel?: string;
  actions: number;
  rounds: number;
  finished: boolean;
  winningTeamIds: string[];
  pointsByTeam: Record<string, number>;
  occupiedCellsByTeam: Record<string, number>;
  notation: import("../../packages/game-core/src/index.js").NotationTuple[];
  resultMessage?: string;
  truncated: boolean;
  learningEligible: boolean;
  trainingFilteredAfterRound: boolean;
  trainingFilterMessage?: string;
  elapsedMs: number;
  sampleCount: number;
  searchSimulations: number;
  replay?: { sequence: number; round: number; phase: string; seat: number; intent: import("../../packages/game-core/src/index.js").GameIntent }[];
}

export interface GameOutput {
  report: GameReport;
  samples: TrainingSample[];
}
