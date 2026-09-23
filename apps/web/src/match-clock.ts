import type { GameState, LobbySettings } from "@numeral-lord/game-core";

const REINFORCEMENT_GRACE_MS = 2_000;
const OVERTIME_ACTION_MS = 2_000;

/**
 * Room-host clock snapshot. The host sends it beside the board state so a
 * spectator refresh or host transfer never starts every player's time anew.
 * Bank balances are settled on commands; the active player's elapsed time is
 * subtracted while displaying or checking the clock.
 */
export interface MatchClockSnapshot {
  readonly bankRemainingMsByPlayer: Readonly<Record<string, number>>;
  readonly activePlayerId: string | null;
  readonly activeSinceEpochMs: number | null;
  readonly actionDeadlineEpochMs: number | null;
  readonly reinforcementDeadlineEpochMs: number | null;
  /** The bank was already empty when this turn began; allow its 2-second turn. */
  readonly overtimeTurn: boolean;
}

export type ClockExpiration = "match" | "step" | null;

/**
 * Move absolute deadlines between wall-clock origins. The relay stamps each
 * delivery with its current server time, including cached snapshots for late
 * spectators; the receiver rebases from that stamp to its own Date.now().
 */
export function rebaseMatchClock(clock: MatchClockSnapshot, sourceNow: number, localNow: number): MatchClockSnapshot {
  const offset = localNow - sourceNow;
  return {
    ...clock,
    activeSinceEpochMs: clock.activeSinceEpochMs === null ? null : clock.activeSinceEpochMs + offset,
    actionDeadlineEpochMs: clock.actionDeadlineEpochMs === null ? null : clock.actionDeadlineEpochMs + offset,
    reinforcementDeadlineEpochMs: clock.reinforcementDeadlineEpochMs === null ? null : clock.reinforcementDeadlineEpochMs + offset
  };
}

export function startMatchClocks(state: GameState, settings: LobbySettings, now: number): MatchClockSnapshot {
  const bankRemainingMsByPlayer: Record<string, number> = {};
  if (settings.matchTimeMinutes > 0) {
    for (const player of Object.values(state.players)) {
      bankRemainingMsByPlayer[player.id] = settings.matchTimeMinutes * 60_000;
    }
  }
  return startTurnClock(state, settings, bankRemainingMsByPlayer, now);
}

/** A command settles elapsed bank time but never refills the turn's step time. */
export function advanceMatchClocks(
  previous: MatchClockSnapshot,
  before: GameState,
  after: GameState,
  settings: LobbySettings,
  now: number
): MatchClockSnapshot {
  const bankRemainingMsByPlayer = { ...previous.bankRemainingMsByPlayer };
  if (settings.matchTimeMinutes > 0 && previous.activePlayerId && previous.activeSinceEpochMs !== null) {
    const oldBalance = bankRemainingMsByPlayer[previous.activePlayerId] ?? settings.matchTimeMinutes * 60_000;
    bankRemainingMsByPlayer[previous.activePlayerId] = Math.max(0, oldBalance - Math.max(0, now - previous.activeSinceEpochMs));
  }
  if (after.turn.phase === "finished") {
    return {
      bankRemainingMsByPlayer,
      activePlayerId: null,
      activeSinceEpochMs: null,
      actionDeadlineEpochMs: null,
      reinforcementDeadlineEpochMs: null,
      overtimeTurn: false
    };
  }

  const beganAnotherTurn = before.turn.currentPlayerId !== after.turn.currentPlayerId
    || before.turn.round !== after.turn.round
    || before.turn.phase === "reinforcement" && after.turn.phase === "action";
  if (beganAnotherTurn) return startTurnClock(after, settings, bankRemainingMsByPlayer, now);

  if (before.turn.phase === "action" && after.turn.phase === "reinforcement") {
    return {
      ...previous,
      bankRemainingMsByPlayer,
      activeSinceEpochMs: now,
      reinforcementDeadlineEpochMs: previous.actionDeadlineEpochMs === null
        ? null
        : Math.max(previous.actionDeadlineEpochMs, now + REINFORCEMENT_GRACE_MS)
    };
  }

  return { ...previous, bankRemainingMsByPlayer, activeSinceEpochMs: now };
}

export function remainingTurnSeconds(clock: MatchClockSnapshot | null, phase: GameState["turn"]["phase"], now: number): number | null {
  if (!clock) return null;
  const deadline = phase === "action"
    ? clock.actionDeadlineEpochMs
    : phase === "reinforcement" ? clock.reinforcementDeadlineEpochMs : null;
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1_000));
}

export function remainingMatchSeconds(clock: MatchClockSnapshot | null, settings: LobbySettings, now: number): number | null {
  if (!clock || settings.matchTimeMinutes === 0 || !clock.activePlayerId) return null;
  const balance = clock.bankRemainingMsByPlayer[clock.activePlayerId] ?? settings.matchTimeMinutes * 60_000;
  const elapsed = clock.activeSinceEpochMs === null ? 0 : Math.max(0, now - clock.activeSinceEpochMs);
  return Math.max(0, Math.ceil((balance - elapsed) / 1_000));
}

/** Cumulative bank expiration ends this turn; step expiration ends one phase. */
export function clockExpiration(
  clock: MatchClockSnapshot | null,
  phase: GameState["turn"]["phase"],
  settings: LobbySettings,
  now: number
): ClockExpiration {
  if (!clock || phase === "finished") return null;
  if (!clock.overtimeTurn && remainingMatchSeconds(clock, settings, now) === 0) return "match";
  if (remainingTurnSeconds(clock, phase, now) === 0) return "step";
  return null;
}

function startTurnClock(
  state: GameState,
  settings: LobbySettings,
  bankRemainingMsByPlayer: Readonly<Record<string, number>>,
  now: number
): MatchClockSnapshot {
  if (state.turn.phase === "finished") {
    return {
      bankRemainingMsByPlayer,
      activePlayerId: null,
      activeSinceEpochMs: null,
      actionDeadlineEpochMs: null,
      reinforcementDeadlineEpochMs: null,
      overtimeTurn: false
    };
  }
  const activePlayerId = state.turn.currentPlayerId;
  const overtimeTurn = settings.matchTimeMinutes > 0 && (bankRemainingMsByPlayer[activePlayerId] ?? 0) <= 0;
  const actionDeadlineEpochMs = overtimeTurn
    ? now + OVERTIME_ACTION_MS
    : settings.turnTimeSeconds > 0 ? now + settings.turnTimeSeconds * 1_000 : null;
  return {
    bankRemainingMsByPlayer,
    activePlayerId,
    activeSinceEpochMs: now,
    actionDeadlineEpochMs,
    reinforcementDeadlineEpochMs: state.turn.phase === "reinforcement" && actionDeadlineEpochMs !== null
      ? Math.max(actionDeadlineEpochMs, now + REINFORCEMENT_GRACE_MS)
      : null,
    overtimeTurn
  };
}
