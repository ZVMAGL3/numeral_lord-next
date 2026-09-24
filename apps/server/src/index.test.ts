import { getMessageBytes, Protocol, type Client, type MessageContext } from "colyseus";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LobbyRoomState, MatchStartPayload } from "@numeral-lord/game-core/node";
import { DEFAULT_MAP_CODE, DEFAULT_MAP_DEFINITION, coreTerrainCatalog, createMatchFromMapCode, serializeMapCode } from "@numeral-lord/core-content";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";
import { MAX_CLIENT_MESSAGE_BYTES, PvpRelayRoom, createGameServer } from "./index.js";

const installedMapCatalogs = {
  terrains: { ...coreTerrainCatalog, ...oilFieldTerrainCatalog },
  terrainModIds: Object.fromEntries(oilFieldMod.terrains.map((terrain) => [terrain.id, oilFieldMod.id])),
  mods: { [oilFieldMod.id]: oilFieldMod }
};

interface SentMessage {
  readonly type: string | number;
  readonly payload: unknown;
}

interface BroadcastMessage extends SentMessage {
  readonly exceptSessionIds: readonly string[];
}

interface FakeClient extends Client {
  readonly sent: SentMessage[];
  readonly leave: (code?: number, data?: string) => void;
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
    },
    leave: vi.fn<(code?: number, data?: string) => void>()
  } as unknown as FakeClient;
}

function createRoom(mapPlayerCount: number): TestPvpRelayRoom {
  const room = new TestPvpRelayRoom();
  room.onCreate({ mapCode: mapCodeForSeats(mapPlayerCount) });
  return room;
}

function mapCodeForSeats(seats: number): string {
  if (seats === DEFAULT_MAP_DEFINITION.players) return DEFAULT_MAP_CODE;
  return serializeMapCode({
    ...DEFAULT_MAP_DEFINITION,
    id: `test-${seats}`,
    name: `测试地图 ${seats} 人`,
    players: seats,
    teams: Array.from({ length: seats }, (_, index) => index + 1)
  }, installedMapCatalogs);
}

function join(
  room: TestPvpRelayRoom,
  sessionId: string,
  name = sessionId,
  accountId = `account-${sessionId}`,
  installedModIds: readonly string[] = [oilFieldMod.id]
): FakeClient {
  const client = fakeClient(sessionId);
  room.clients.push(client);
  room.onJoin(client, { accountId, name, installedModIds });
  return client;
}

function dropSocket(room: TestPvpRelayRoom, client: FakeClient): void {
  const index = room.clients.indexOf(client);
  if (index !== -1) room.clients.splice(index, 1);
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

it("accepts an initial host snapshot beyond Colyseus' 4 KiB transport default", () => {
  const state = createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs);
  const frame = getMessageBytes.raw(Protocol.ROOM_DATA, "host-snapshot", {
    state,
    clock: {},
    hostSentAtEpochMs: Date.now()
  });
  expect(frame.byteLength).toBeGreaterThan(4 * 1024);

  const server = createGameServer();
  const transport = server.transport as unknown as { wss: { options: { maxPayload: number } } };
  expect(transport.wss.options.maxPayload).toBe(MAX_CLIENT_MESSAGE_BYTES);
  expect(transport.wss.options.maxPayload).toBeGreaterThan(frame.byteLength);
});

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

  it("replaces and disconnects the old tab when a browser identity joins the same room again", () => {
    const room = createRoom(3);
    const oldTab = join(room, "old-tab", "ZVMAGL3", "same-browser");
    join(room, "peer", "对手", "peer-account");

    const newTab = join(room, "new-tab", "ZVMAGL3", "same-browser");

    expect(oldTab.leave).toHaveBeenCalledWith(4001, "This browser identity joined from another tab.");
    const members = lastBroadcast<LobbyRoomState>(room, "room-state").members;
    expect(members.filter((member) => member.accountId === "same-browser")).toHaveLength(1);
    expect(members.find((member) => member.accountId === "same-browser")).toMatchObject({
      sessionId: newTab.sessionId,
      seat: 1,
      participating: true
    });
  });

  it("starts a fixed-position map with only the occupied seats assigned", () => {
    const room = createRoom(4);
    const host = join(room, "host", "房主名字");

    room.receive("lobby-seat", host, { seat: 3 });
    room.receive("lobby-ready", host, { ready: true });

    const start = lastBroadcast<MatchStartPayload>(room, "match-start");
    expect(start.assignments).toEqual([
      { sessionId: "host", seat: 3, playerId: "player-3", displayName: "房主名字", playerColorId: "legacy-1" }
    ]);
    expect(start.mapCode).toBe(mapCodeForSeats(4));
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

  it("lets each participant select a unique legacy color and releases it when they spectate", () => {
    const room = createRoom(3);
    const host = join(room, "host");
    const second = join(room, "second");
    const third = join(room, "third");

    room.receive("lobby-color", host, { playerColorId: "legacy-2" });
    expect(lastSent<{ message: string }>(host, "lobby-error").message).toContain("已经被其他参战玩家选了");
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members[0]?.playerColorId).toBe("legacy-1");

    room.receive("lobby-color", host, { playerColorId: "legacy-9" });
    room.receive("lobby-seat", second, { seat: null });
    room.receive("lobby-color", third, { playerColorId: "legacy-2" });
    const members = lastBroadcast<LobbyRoomState>(room, "room-state").members;
    const colors = members.filter((member) => member.participating).map((member) => member.playerColorId);
    expect(colors).toEqual(["legacy-9", "legacy-2"]);
    expect(new Set(colors).size).toBe(colors.length);
    expect(members.find((member) => member.sessionId === "second")?.playerColorId).toBeNull();

    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", third, { ready: true });
    expect(lastBroadcast<MatchStartPayload>(room, "match-start").assignments.map((assignment) => assignment.playerColorId))
      .toEqual(["legacy-9", "legacy-2"]);
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
    expect(lastSent<LobbyRoomState>(late, "room-state").mapCode).toBe(DEFAULT_MAP_CODE);
    expect(lastSent<Record<string, unknown>>(late, "room-role")).toMatchObject({
      sessionId: "late",
      participating: false,
      seat: null
    });
    expect(lastSent<{ sessionId: string }>(late, "room-host")).toEqual({ sessionId: "host" });
    expect(lastSent<{ state: { sequence: number } }>(late, "host-snapshot").state.sequence).toBe(1);
    expect(room.broadcasts.some((event) => event.type === "snapshot-request")).toBe(false);
  });

  it("rebases host clocks to server time and stamps cached deliveries at send time", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const room = createRoom(2);
    const host = join(room, "host");
    room.receive("lobby-ready", host, { ready: true });
    const spectator = join(room, "spectator");

    room.receive("host-snapshot", host, {
      state: { sequence: 7 },
      hostSentAtEpochMs: 10_000,
      clock: {
        bankRemainingMsByPlayer: { "player-1": 60_000 },
        activePlayerId: "player-1",
        activeSinceEpochMs: 9_000,
        actionDeadlineEpochMs: 70_000,
        reinforcementDeadlineEpochMs: null,
        overtimeTurn: false
      }
    });
    expect(lastSent<Record<string, unknown>>(spectator, "host-snapshot")).toMatchObject({
      state: { sequence: 7 },
      serverSentAtEpochMs: 100_000,
      clock: {
        bankRemainingMsByPlayer: { "player-1": 60_000 },
        activeSinceEpochMs: 99_000,
        actionDeadlineEpochMs: 160_000,
        reinforcementDeadlineEpochMs: null
      }
    });

    now.mockReturnValue(105_000);
    const later = join(room, "later");
    room.receive("room-sync", later);
    expect(lastSent<Record<string, unknown>>(later, "host-snapshot")).toMatchObject({
      serverSentAtEpochMs: 105_000,
      clock: { activeSinceEpochMs: 99_000, actionDeadlineEpochMs: 160_000 }
    });
  });

  it("sends the cached board only when a client's sequence check shows it is behind", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    room.receive("lobby-ready", host, { ready: true });
    room.receive("host-snapshot", host, { state: { sequence: 8 } });
    const player = join(room, "player");
    player.sent.length = 0;

    room.receive("snapshot-check", player, { sequence: 8 });
    expect(player.sent.some((event) => event.type === "host-snapshot")).toBe(false);

    room.receive("snapshot-check", player, { sequence: 7 });
    expect(lastSent<{ state: { sequence: number } }>(player, "host-snapshot").state.sequence).toBe(8);
  });

  it("requests a missing initial host snapshot without replaying match-start", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    room.receive("lobby-ready", host, { ready: true });
    const player = join(room, "player");
    player.sent.length = 0;
    host.sent.length = 0;

    room.receive("snapshot-check", player, { sequence: 0 });

    expect(player.sent.some((event) => event.type === "match-start")).toBe(false);
    expect(host.sent.some((event) => event.type === "snapshot-request")).toBe(true);
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

  it("restores a refreshed participant's seat during a live match", () => {
    const room = createRoom(2);
    const host = join(room, "host", "房主");
    const player = join(room, "player-old", "棋手", "stable-account");
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", player, { ready: true });

    const refreshed = join(room, "player-new", "棋手", "stable-account");

    expect(lastSent<Record<string, unknown>>(refreshed, "room-role")).toMatchObject({
      sessionId: "player-new",
      seat: 2,
      participating: true,
      playerId: "player-2"
    });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members.filter(
      (member) => member.accountId === "stable-account"
    )).toHaveLength(1);
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

  it("bootstraps a refreshing spectator before the first host snapshot is cached", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    room.receive("lobby-ready", host, { ready: true });
    const late = join(room, "late");
    late.sent.length = 0;

    room.receive("room-sync", late);

    expect(late.sent.map((message) => message.type)).toEqual([
      "room-role", "room-state", "room-host", "match-start"
    ]);
    expect(lastSent<LobbyRoomState>(late, "room-state").phase).toBe("playing");
    expect(lastSent<MatchStartPayload>(late, "match-start").mapCode).toBe(DEFAULT_MAP_CODE);
    expect(host.sent.some((message) => message.type === "snapshot-request")).toBe(true);
  });

  it("lets only the host select a validated map and frees seats outside its range", () => {
    const room = createRoom(4);
    const host = join(room, "host");
    const other = join(room, "other");
    const third = join(room, "third");
    const fourth = join(room, "fourth");

    room.receive("lobby-map", other, { mapCode: DEFAULT_MAP_CODE });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").mapPlayerCount).toBe(4);

    room.receive("lobby-map", host, { mapCode: "not a map" });
    expect(lastSent<{ message: string }>(host, "lobby-error").message).toContain("地图码");
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").mapPlayerCount).toBe(4);

    room.receive("lobby-map", host, { mapCode: DEFAULT_MAP_CODE });
    const state = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(state).toMatchObject({ mapCode: DEFAULT_MAP_CODE, mapName: "昏晓", mapPlayerCount: 2 });
    expect(state.members.map((member) => [member.sessionId, member.seat, member.participating])).toEqual([
      ["host", 1, true],
      ["other", 2, true],
      ["third", null, false],
      ["fourth", null, false]
    ]);
    expect(third.sent.findLast((message) => message.type === "room-state")?.payload).toMatchObject({
      mapCode: DEFAULT_MAP_CODE
    });
  });

  it("resets readiness when the host changes maps", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    join(room, "other");
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-map", host, { mapCode: mapCodeForSeats(3) });

    const state = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(state.mapPlayerCount).toBe(3);
    expect(state.members.every((member) => member.ready === false)).toBe(true);
    expect(room.broadcasts.some((message) => message.type === "match-start")).toBe(false);
  });

  it("shows missing map Mods and refuses readiness until the client reports installation", () => {
    const room = createRoom(2);
    const host = join(room, "host", "未安装者", "account-host", []);
    expect(lastBroadcast<LobbyRoomState>(room, "room-state")).toMatchObject({
      requiredTerrainModIds: [oilFieldMod.id],
      members: [{ sessionId: "host", installedModIds: [], missingModIds: [oilFieldMod.id] }]
    });

    room.receive("lobby-ready", host, { ready: true });
    expect(lastSent<{ message: string }>(host, "lobby-error").message).toContain(oilFieldMod.id);
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members[0]?.ready).toBe(false);
    expect(room.broadcasts.some((message) => message.type === "match-start")).toBe(false);

    room.receive("lobby-installed-mods", host, { installedModIds: [oilFieldMod.id] });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members[0]?.missingModIds).toEqual([]);
    room.receive("lobby-ready", host, { ready: true });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").phase).toBe("playing");
  });

  it("accepts only host Mod overrides declared by the map and preserves them across rematch", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    const peer = join(room, "peer");
    room.receive("lobby-mod-settings", peer, { modSettings: { [oilFieldMod.id]: { incomePerTurn: 9 } } });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").roomModSettings).toEqual({});

    room.receive("lobby-mod-settings", host, { modSettings: { [oilFieldMod.id]: { incomePerTurn: 7 } } });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").roomModSettings[oilFieldMod.id]?.incomePerTurn).toBe(7);
    room.receive("lobby-mod-settings", host, { modSettings: { [oilFieldMod.id]: { incomePerTurn: 21 } } });
    expect(lastSent<{ message: string }>(host, "lobby-error").message).toContain("0～20");
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").roomModSettings[oilFieldMod.id]?.incomePerTurn).toBe(7);
    room.receive("lobby-mod-settings", host, { modSettings: { "mod-undeclared": { incomePerTurn: 4 } } });
    expect(lastSent<{ message: string }>(host, "lobby-error").message).toContain("配置无效");

    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", peer, { ready: true });
    expect(lastBroadcast<MatchStartPayload>(room, "match-start").roomModSettings[oilFieldMod.id]?.incomePerTurn).toBe(7);
    room.receive("match-return-to-lobby", host);
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").roomModSettings[oilFieldMod.id]?.incomePerTurn).toBe(7);
  });

  it("clears Mod overrides and dependency gating when the host switches maps", () => {
    const room = createRoom(2);
    const host = join(room, "host", "无 Mod 玩家", "account-host", []);
    room.receive("lobby-mod-settings", host, { modSettings: { [oilFieldMod.id]: { incomePerTurn: 8 } } });
    const plainCode = serializeMapCode({
      ...DEFAULT_MAP_DEFINITION,
      id: "plain-room-map",
      terrain: DEFAULT_MAP_DEFINITION.terrain.replaceAll("F", "M"),
      requiredTerrainModIds: []
    }, { terrains: coreTerrainCatalog });
    room.receive("lobby-map", host, { mapCode: plainCode });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state")).toMatchObject({
      requiredTerrainModIds: [],
      roomModSettings: {},
      members: [{ sessionId: "host", missingModIds: [] }]
    });
    room.receive("lobby-ready", host, { ready: true });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").phase).toBe("playing");
  });

  it("returns every player to the same ready room and discards the old match snapshot", () => {
    const room = createRoom(2);
    const host = join(room, "host", "房主");
    const peer = join(room, "peer", "对手");
    room.receive("lobby-settings", host, { friendlyFire: true, turnTimeSeconds: 45 });
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", peer, { ready: true });
    room.receive("host-snapshot", host, { state: { sequence: 8 } });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").phase).toBe("playing");

    room.receive("match-return-to-lobby", host);

    const readyRoom = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(readyRoom).toMatchObject({
      phase: "lobby",
      mapCode: DEFAULT_MAP_CODE,
      settings: { friendlyFire: true, turnTimeSeconds: 45 }
    });
    expect(readyRoom).not.toHaveProperty("startedAtEpochMs");
    expect(readyRoom.members.map((member) => [member.sessionId, member.seat, member.ready]))
      .toEqual([["host", 1, false], ["peer", 2, false]]);
    expect(lastSent<LobbyRoomState>(peer, "room-state").phase).toBe("lobby");

    // A delayed upload from the old match may not bring its board back.
    room.receive("host-snapshot", host, { state: { sequence: 9 } });
    const late = join(room, "late");
    late.sent.length = 0;
    room.receive("room-sync", late);
    expect(lastSent<LobbyRoomState>(late, "room-state").phase).toBe("lobby");
    expect(late.sent.some((message) => message.type === "host-snapshot" || message.type === "match-start"
      || message.type === "snapshot-request")).toBe(false);

    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", peer, { ready: true });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").phase).toBe("playing");
    expect(lastBroadcast<MatchStartPayload>(room, "match-start").assignments).toHaveLength(2);
  });

  it("rejects a non-host request to return the match to the lobby", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    const peer = join(room, "peer");
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", peer, { ready: true });
    const broadcastsBefore = room.broadcasts.length;

    room.receive("match-return-to-lobby", peer);

    expect(lastSent<{ message: string }>(peer, "lobby-error").message).toContain("只有房主");
    expect(room.broadcasts).toHaveLength(broadcastsBefore);
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").phase).toBe("playing");
  });

  it("clears randomized seats before preparing the next match", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    const peer = join(room, "peer");
    room.receive("lobby-settings", host, { randomizePositions: true });
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", peer, { ready: true });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members.every((member) => member.seat !== null)).toBe(true);

    room.receive("match-return-to-lobby", host);

    const readyRoom = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(readyRoom.phase).toBe("lobby");
    expect(readyRoom.settings.randomizePositions).toBe(true);
    expect(readyRoom.members.every((member) => member.participating && member.seat === null && !member.ready)).toBe(true);
  });

  it("keeps the earliest participants when a random-position map shrinks", () => {
    const room = createRoom(4);
    const host = join(room, "host");
    join(room, "second");
    join(room, "third");
    join(room, "fourth");

    room.receive("lobby-settings", host, { randomizePositions: true });
    room.receive("lobby-map", host, { mapCode: DEFAULT_MAP_CODE });

    const state = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(state.members.map((member) => [member.sessionId, member.participating, member.seat])).toEqual([
      ["host", true, null],
      ["second", true, null],
      ["third", false, null],
      ["fourth", false, null]
    ]);
  });

  it("rejects a step timer longer than the match timer without changing other settings or readiness", () => {
    const room = createRoom(2);
    const host = join(room, "host");
    join(room, "other");
    room.receive("lobby-settings", host, { turnTimeSeconds: 120 });
    room.receive("lobby-ready", host, { ready: true });
    const broadcastsBefore = room.broadcasts.length;

    room.receive("lobby-settings", host, { matchTimeMinutes: 1, randomizePositions: true });
    expect(lastSent<{ message: string }>(host, "lobby-error").message).toContain("步时不能大于局时");
    expect(room.broadcasts).toHaveLength(broadcastsBefore);
    let state = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(state.settings).toMatchObject({ turnTimeSeconds: 120, matchTimeMinutes: 30, randomizePositions: false });
    expect(state.members.find((member) => member.sessionId === "host")).toMatchObject({ ready: true, seat: 1 });

    room.receive("lobby-settings", host, { matchTimeMinutes: 1, turnTimeSeconds: 60 });
    state = lastBroadcast<LobbyRoomState>(room, "room-state");
    expect(state.settings).toMatchObject({ turnTimeSeconds: 60, matchTimeMinutes: 1 });
    expect(state.members.find((member) => member.sessionId === "host")?.ready).toBe(false);

    const broadcastsAfterValid = room.broadcasts.length;
    room.receive("lobby-settings", host, { turnTimeSeconds: 120, friendlyFire: true });
    expect(lastSent<{ message: string }>(host, "lobby-error").message).toContain("步时不能大于局时");
    expect(room.broadcasts).toHaveLength(broadcastsAfterValid);
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").settings.friendlyFire).toBe(false);

    room.receive("lobby-settings", host, { matchTimeMinutes: 0, turnTimeSeconds: 120, randomizePositions: true });
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").settings).toMatchObject({
      matchTimeMinutes: 0,
      turnTimeSeconds: 120,
      randomizePositions: true
    });
  });

  it("hands the cached board to a connected player before announcing the new host", async () => {
    const room = createRoom(2);
    const host = join(room, "host");
    const peer = join(room, "peer");
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", peer, { ready: true });
    room.receive("host-snapshot", host, { state: { sequence: 7 } });
    peer.sent.length = 0;

    dropSocket(room, host);
    await room.onLeave(host, 1000);

    const handoffIndex = peer.sent.findIndex((message) => message.type === "host-snapshot"
      && (message.payload as { handoff?: boolean }).handoff === true);
    const hostIndex = peer.sent.findIndex((message) => message.type === "room-host");
    expect(handoffIndex).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThan(handoffIndex);
    expect(lastSent<{ sessionId: string }>(peer, "room-host").sessionId).toBe("peer");

    room.receive("host-snapshot", peer, { state: { sequence: 8 } });
    const late = join(room, "late");
    room.receive("room-sync", late);
    expect(lastSent<{ state: { sequence: number }; handoff?: boolean }>(late, "host-snapshot"))
      .toMatchObject({ state: { sequence: 8 } });
    expect(lastSent<{ handoff?: boolean }>(late, "host-snapshot").handoff).not.toBe(true);
  });

  it("recovers when the first host drops before sending any board snapshot", async () => {
    const room = createRoom(2);
    const host = join(room, "host");
    const peer = join(room, "peer");
    room.receive("lobby-ready", host, { ready: true });
    room.receive("lobby-ready", peer, { ready: true });
    peer.sent.length = 0;

    dropSocket(room, host);
    await room.onLeave(host, 1000);

    const startIndex = peer.sent.findIndex((message) => message.type === "match-start");
    const hostIndex = peer.sent.findIndex((message) => message.type === "room-host");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThan(startIndex);
    room.receive("room-sync", peer);
    expect(lastSent<{ sessionId: string }>(peer, "room-host").sessionId).toBe("peer");
    expect(peer.sent.some((message) => message.type === "snapshot-request")).toBe(true);

    room.receive("host-snapshot", peer, { state: { sequence: 0 } });
    const late = join(room, "late");
    room.receive("room-sync", late);
    expect(lastSent<{ state: { sequence: number } }>(late, "host-snapshot").state.sequence).toBe(0);
  });

  it("lets a departed player reclaim their seat and bootstrap an empty-cache room", async () => {
    const room = createRoom(2);
    const host = join(room, "old", "棋手", "stable-account");
    room.receive("lobby-ready", host, { ready: true });

    dropSocket(room, host);
    await room.onLeave(host, 1000);
    const replacement = join(room, "new", "棋手", "stable-account");
    replacement.sent.length = 0;
    room.receive("room-sync", replacement);

    expect(replacement.sent.map((message) => message.type).slice(0, 4))
      .toEqual(["match-start", "room-role", "room-state", "room-host"]);
    expect(lastSent<Record<string, unknown>>(replacement, "room-role"))
      .toMatchObject({ seat: 1, participating: true, isHost: true, playerId: "player-1" });
    room.receive("host-snapshot", replacement, { state: { sequence: 0 } });
    const spectator = join(room, "spectator");
    room.receive("room-sync", spectator);
    expect(lastSent<{ state: { sequence: number } }>(spectator, "host-snapshot").state.sequence).toBe(0);
  });

  it("does not revoke a replacement host when the old socket's leave finishes later", async () => {
    const room = createRoom(2);
    const original = join(room, "old", "棋手", "stable-account");
    room.receive("lobby-ready", original, { ready: true });
    room.allowReconnectionTime = 30;
    let finishLeave!: () => void;
    const pendingReconnection = new Promise<Client>((_, reject) => {
      finishLeave = () => reject(new Error("old socket expired"));
    });
    vi.spyOn(room, "allowReconnection").mockReturnValue(
      pendingReconnection as unknown as ReturnType<typeof room.allowReconnection>
    );

    dropSocket(room, original);
    const leaving = room.onLeave(original, 1006);
    const replacement = join(room, "new", "棋手", "stable-account");
    room.receive("room-sync", replacement);
    room.receive("host-snapshot", replacement, { state: { sequence: 1 } });
    finishLeave();
    await leaving;

    expect(lastSent<{ sessionId: string }>(replacement, "room-host").sessionId).toBe("new");
    const late = join(room, "late");
    room.receive("room-sync", late);
    expect(lastSent<{ state: { sequence: number } }>(late, "host-snapshot").state.sequence).toBe(1);
    expect(lastBroadcast<LobbyRoomState>(room, "room-state").members.filter(
      (member) => member.accountId === "stable-account"
    )).toHaveLength(1);
  });

  it("replays a trusted handoff to a refreshed host and rejects stale snapshots", () => {
    const room = createRoom(2);
    const original = join(room, "old", "棋手", "stable-account");
    room.receive("lobby-ready", original, { ready: true });
    room.receive("host-snapshot", original, { state: { sequence: 5 } });

    const replacement = join(room, "new", "棋手", "stable-account");
    replacement.sent.length = 0;
    // onJoin's role message can race browser handler registration; the explicit
    // room-sync handshake must recover the cached board before host authority.
    room.receive("host-snapshot", original, { state: { sequence: 6 } });
    room.receive("room-sync", replacement);
    expect(replacement.sent.map((message) => message.type).slice(0, 4))
      .toEqual(["host-snapshot", "room-role", "room-state", "room-host"]);
    expect(lastSent<{ handoff?: boolean; state: { sequence: number } }>(replacement, "host-snapshot"))
      .toMatchObject({ handoff: true, state: { sequence: 5 } });

    room.receive("host-snapshot", replacement, { state: { sequence: 4 } });
    const late = join(room, "late");
    room.receive("room-sync", late);
    expect(lastSent<{ state: { sequence: number } }>(late, "host-snapshot").state.sequence).toBe(5);
    room.receive("host-snapshot", replacement, { state: { sequence: 6 } });
    expect(lastSent<{ state: { sequence: number } }>(late, "host-snapshot").state.sequence).toBe(6);
  });
});
