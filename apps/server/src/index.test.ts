import type { Client, MessageContext } from "colyseus";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LobbyRoomState, MatchStartPayload } from "@numeral-lord/game-core/node";
import { PvpRelayRoom } from "./index.js";

interface SentMessage {
  readonly type: string | number;
  readonly payload: unknown;
}

interface BroadcastMessage extends SentMessage {
  readonly exceptSessionIds: readonly string[];
}

interface FakeClient extends Client {
  readonly sent: SentMessage[];
}

type MessageHandler = (client: Client, payload: Record<string, unknown>, context: MessageContext) => unknown;

/**
 * Exercises the real room lifecycle and registered message callbacks without
 * opening sockets. Only the Colyseus transport boundary is replaced.
 */
class TestPvpRelayRoom extends PvpRelayRoom {
  readonly broadcasts: BroadcastMessage[] = [];
  readonly handlers = new Map<string | number, MessageHandler>();
  metadataSnapshot: unknown;

  override onMessage<T = unknown>(
    type: string | number | "*",
    schemaOrHandler: unknown,
    maybeHandler?: unknown
  ): () => void {
    const handler = (typeof maybeHandler === "function" ? maybeHandler : schemaOrHandler) as MessageHandler;
    this.handlers.set(type, handler);
    return () => this.handlers.delete(type);
  }

  override broadcast(type: string | number, payload?: unknown, options?: { except?: Client | Client[] }): void {
    const except = options?.except === undefined
      ? []
      : Array.isArray(options.except) ? options.except : [options.except];
    this.broadcasts.push({
      type,
      payload,
      exceptSessionIds: except.map((client: Client) => client.sessionId)
    });
    for (const client of this.clients as unknown as FakeClient[]) {
      if (!except.includes(client)) client.send(type, payload);
    }
  }

  override async setMetadata(metadata: unknown): Promise<void> {
    this.metadataSnapshot = metadata;
  }

  receive(type: string, client: FakeClient, payload: Record<string, unknown> = {}): void {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`No handler registered for ${type}`);
    handler(client, payload, {
      id: undefined,
      reject: () => undefined as never,
      resolve: () => undefined as never
    });
  }
}

function fakeClient(sessionId: string): FakeClient {
  const sent: SentMessage[] = [];
  return {
    sessionId,
    sent,
    send(type: string | number, payload?: unknown) {
      sent.push({ type, payload });
    }
  } as FakeClient;
}

function createRoom(mapPlayerCount: number): TestPvpRelayRoom {
  const room = new TestPvpRelayRoom();
  room.onCreate({ mapPlayerCount });
  return room;
}

function join(room: TestPvpRelayRoom, sessionId: string, name = sessionId, accountId = `account-${sessionId}`): FakeClient {
  const client = fakeClient(sessionId);
  room.clients.push(client);
  room.onJoin(client, { accountId, name });
  return client;
}

function lastBroadcast<T>(room: TestPvpRelayRoom, type: string): T {
  const event = room.broadcasts.findLast((candidate) => candidate.type === type);
  if (!event) throw new Error(`No ${type} broadcast was emitted`);
  return event.payload as T;
}

function lastSent<T>(client: FakeClient, type: string): T {
  const event = client.sent.findLast((candidate) => candidate.type === type);
  if (!event) throw new Error(`No ${type} message was sent to ${client.sessionId}`);
  return event.payload as T;
}

describe("PvpRelayRoom lobby contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sorts participants first by fixed seat, then spectators by join order", () => {
    const room = createRoom(3);
    const alice = join(room, "alice");
    const bob = join(room, "bob");
    const cara = join(room, "cara");
    join(room, "dan");

    room.receive("lobby-seat", bob, { seat: null });
    room.receive("lobby-assign", alice, { sessionId: "cara", seat: 1 });

    const state = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(state.members.map((member) => [member.sessionId, member.seat, member.participating])).toEqual([
      ["cara", 1, true],
      ["alice", 3, true],
      ["bob", null, false],
      ["dan", null, false]
    ]);
  });

  it("starts a fixed-position map with only the occupied seats assigned", () => {
    const room = createRoom(4);
    const host = join(room, "host");

    room.receive("lobby-seat", host, { seat: 3 });
    room.receive("lobby-ready", host, { ready: true });

    const start = lastBroadcast<MatchStartPayload>(room, "match-start");
    expect(start.assignments).toEqual([
      { sessionId: "host", seat: 3, playerId: "player-3" }
    ]);
    expect(start.assignments).toHaveLength(1);
    expect(new Set(start.assignments.map((assignment) => assignment.seat))).toEqual(new Set([3]));
    expect(lastBroadcast<LobbyRoomState>(room, "room-state")).toMatchObject({
      phase: "playing",
      mapPlayerCount: 4
    });
  });

  it("offers only participate/spectate in random mode and leaves unused random seats empty", () => {
    const room = createRoom(4);
    const host = join(room, "host");
    const second = join(room, "second");
    const spectator = join(room, "spectator");

    room.receive("lobby-settings", host, { randomizePositions: true });
    room.receive("lobby-participation", spectator, { participating: false });

    room.receive("lobby-seat", second, { seat: 4 });
    expect(lastSent<{ message: string }>(second, "lobby-error").message).toContain("只能选择参战或观战");
    const beforeStart = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(beforeStart.members.filter((member) => member.participating).every((member) => member.seat === null)).toBe(true);
    expect(beforeStart.members.at(-1)).toMatchObject({
      sessionId: "spectator",
      participating: false,
      seat: null
    });

    vi.spyOn(Math, "random").mockReturnValue(0);
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", second, { ready: true });

    const start = lastBroadcast<MatchStartPayload>(room, "match-start");
    const assignedSeats = start.assignments.map((assignment) => assignment.seat);
    expect(start.assignments.map((assignment) => assignment.sessionId).sort()).toEqual(["host", "second"]);
    expect(new Set(assignedSeats).size).toBe(2);
    expect(assignedSeats.every((seat) => seat >= 1 && seat <= 4)).toBe(true);
    expect([1, 2, 3, 4].filter((seat) => !assignedSeats.includes(seat))).toHaveLength(2);

    const playing = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(playing.members.find((member) => member.sessionId === "spectator")).toMatchObject({
      participating: false,
      seat: null
    });
  });

  it("admits a late room-code join as a spectator and syncs the active match", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    room.receive("lobby-ready", host, { ready: true });
    room.receive("host-snapshot", host, { state: { sequence: 1 }, stepStartedAtEpochMs: 1 });

    const late = join(room, "late", "晚到观众");
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members.find(
      (member) => member.sessionId === "late"
    )).toMatchObject({
      displayName: "晚到观众",
      participating: false,
      seat: null,
      ready: false
    });
    expect(room.broadcasts.some((event) => event.type === "snapshot-request")).toBe(false);

    late.sent.length = 0;
    room.broadcasts.length = 0;
    room.receive("room-sync", late);

    expect(late.sent.map((event) => event.type)).toEqual(["room-role", "room-state", "room-host", "host-snapshot"]);
    expect(lastSent<LobbyRoomState>(late, "room-state").phase).toBe("playing");
    expect(lastSent<Record<string, unknown>>(late, "room-role")).toMatchObject({
      sessionId: "late",
      participating: false,
      seat: null
    });
    expect(lastSent<{ sessionId: string }>(late, "room-host")).toEqual({ sessionId: "host" });
    expect(lastSent<{ state: { sequence: number } }>(late, "host-snapshot").state.sequence).toBe(1);
    expect(room.broadcasts.some((event) => event.type === "snapshot-request")).toBe(false);
  });

  it("recognizes a refreshed account and preserves its seat without a duplicate spectator", () => {
    const room = createRoom(2);
    const original = join(room, "old", "棋手", "stable-account");
    join(room, "other");
    const refreshed = join(room, "new", "棋手", "stable-account");

    const members = lastBroadcast<LobbyRoomState>(room, "room-state").members;
    expect(members).toHaveLength(2);
    expect(members.find((member) => member.sessionId === "new")).toMatchObject({
      seat: 1,
      participating: true,
      isHost: true
    });
    expect(members.some((member) => member.sessionId === "old")).toBe(false);
    room.receive("room-sync", refreshed);
    expect(lastSent<Record<string, unknown>>(refreshed, "room-role")).toMatchObject({
      seat: 1,
      isHost: true,
      playerId: "player-1"
    });
    // The superseded socket is no longer allowed to change this room.
    room.receive("lobby-seat", original, { seat: null });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members.find(
      (member) => member.sessionId === "new"
    )?.seat).toBe(1);
  });

  it("room-sync returns authoritative lobby context without requesting a game snapshot", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    host.sent.length = 0;
    room.broadcasts.length = 0;

    room.receive("room-sync", host);

    expect(host.sent.map((event) => event.type)).toEqual(["room-role", "room-state", "room-host"]);
    expect(lastSent<LobbyRoomState>(host, "room-state").phase).toBe("lobby");
    expect(lastSent<Record<string, unknown>>(host, "room-role")).toMatchObject({
      sessionId: "host",
      isHost: true,
      participating: true,
      seat: 1
    });
    expect(room.broadcasts.some((event) => event.type === "snapshot-request")).toBe(false);
  });
});
