import {
  DEFAULT_LOBBY_SETTINGS,
  MAX_ROOM_CAPACITY,
  PLAYER_COLOR_OPTIONS,
  applyIntent,
  getLegalIntents
} from "@numeral-lord/game-core/node";
import { DEFAULT_MAP_CODE, coreTerrainCatalog, parseMapCode, validateModSettings } from "@numeral-lord/core-content";
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";
import type {
  GameIntent,
  GameState,
  LobbyMember,
  LobbyModSettings,
  LobbyRoomState,
  LobbySettings,
  MatchStartPayload,
  MatchConditionCatalog,
  TerrainCatalog,
  UnitCatalog
} from "@numeral-lord/game-core/node";
import { RelayRoom, Server, WebSocketTransport, type Client } from "colyseus";
import { pathToFileURL } from "node:url";
import { WorkshopRoom } from "./workshop.js";

/** The relay accepts only terrain content the deployed client currently ships. */
const installedMapCatalogs = {
  terrains: { ...coreTerrainCatalog, ...oilFieldTerrainCatalog },
  terrainModIds: Object.fromEntries(oilFieldMod.terrains.map((terrain) => [terrain.id, oilFieldMod.id])),
  mods: { [oilFieldMod.id]: oilFieldMod }
};

export { getLegalIntents };

/**
 * Colyseus' ws transport defaults to only 4 KiB for messages sent by clients.
 * Even the built-in 81-cell board takes about 6.5 KiB as a host-snapshot, so
 * that default closes the host socket with WebSocket code 1009 on the first
 * sync. Keep an explicit bounded limit for larger user maps and workshop
 * uploads rather than disabling the receiver's size protection.
 */
export const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;

interface MutableLobbyMember {
  sessionId: string;
  accountId: string;
  displayName: string;
  connected: boolean;
  seat: number | null;
  participating: boolean;
  playerColorId: string | null;
  ready: boolean;
  installedModIds: readonly string[];
  joinOrder: number;
}

interface CachedHostSnapshot {
  readonly payload: Record<string, unknown>;
  readonly sequence: number;
}

interface RoomCreateOptions {
  allowReconnectionTime?: number;
  mapCode?: string;
  maxClients?: number;
  metadata?: unknown;
}

/** Relay metadata used by the browser to keep player ownership deterministic. */
export class PvpRelayRoom extends RelayRoom {
  private static readonly ROOM_SYNC_COOLDOWN_MS = 750;

  private hostSessionId: string | undefined;
  /**
   * A newly elected host is only authoritative after the server has queued
   * the cached board state to that socket. This prevents a stale local board
   * from winning the host-migration race.
   */
  private authoritativeHostSessionId: string | undefined;
  private readonly members = new Map<string, MutableLobbyMember>();
  private readonly lastRoomSyncAtBySession = new Map<string, number>();
  private phase: LobbyRoomState["phase"] = "lobby";
  private mapPlayerCount = 2;
  private mapCode = DEFAULT_MAP_CODE;
  private mapName = "昏晓";
  private requiredTerrainModIds: readonly string[] = [];
  private roomModSettings: LobbyModSettings = {};
  private settings: LobbySettings = DEFAULT_LOBBY_SETTINGS;
  private matchStartedAtEpochMs: number | null = null;
  private nextJoinOrder = 0;
  private latestHostSnapshot: CachedHostSnapshot | undefined;
  /** Re-sendable initial state seed if the first host disappears before its first snapshot. */
  private matchStartPayload: MatchStartPayload | undefined;

  override onCreate(options: RoomCreateOptions): void {
    const initialMapCode = options.mapCode ?? DEFAULT_MAP_CODE;
    const initialMap = parseMapCode(initialMapCode, installedMapCatalogs);
    this.mapCode = initialMapCode;
    this.mapName = initialMap.name;
    this.mapPlayerCount = initialMap.players;
    this.requiredTerrainModIds = initialMap.requiredTerrainModIds;
    this.roomModSettings = {};
    this.settings = { ...DEFAULT_LOBBY_SETTINGS };
    this.maxClients = MAX_ROOM_CAPACITY;
    if (options.allowReconnectionTime) {
      this.allowReconnectionTime = Math.min(options.allowReconnectionTime, 40);
    }
    this.setMetadata({
      ...(typeof options.metadata === "object" && options.metadata ? options.metadata : {}),
      mapName: this.mapName,
      mapPlayerCount: this.mapPlayerCount
    });

    // The server owns room membership and setup, while game-core remains the
    // authority for board rules in the host client.
    this.onMessage("player-intent", (client, payload: Record<string, unknown> = {}) => {
      const member = this.members.get(client.sessionId);
      if (this.phase !== "playing" || this.authoritativeHostSessionId !== this.hostSessionId
        || !member?.participating || member.seat === null) return;
      const playerId = playerIdForSeat(member.seat);
      const command = isRecord(payload.command)
        ? { ...payload.command, actorId: playerId }
        : payload.command;
      this.broadcast("player-intent", { ...payload, command, playerId }, { except: client });
    });
    this.onMessage("host-snapshot", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "playing" || client.sessionId !== this.hostSessionId
        || client.sessionId !== this.authoritativeHostSessionId) return;
      const receivedAtEpochMs = Date.now();
      const snapshot = this.validateSnapshot(payload, receivedAtEpochMs);
      if (!snapshot) return;
      this.latestHostSnapshot = snapshot;
      this.broadcast("host-snapshot", {
        ...snapshot.payload,
        serverSentAtEpochMs: receivedAtEpochMs
      }, { except: client });
    });
    this.onMessage("lobby-ready", (client, payload: Record<string, unknown> = {}) => {
      const member = this.members.get(client.sessionId);
      if (this.phase !== "lobby" || !member?.participating) return;
      if (payload.ready === true && this.missingModIds(member).length > 0) {
        this.sendError(client, `请先安装地图需要的地块 Mod：${this.missingModIds(member).join("、")}`);
        return;
      }
      member.ready = payload.ready === true;
      this.broadcastRoomState();
      this.startWhenReady();
    });
    this.onMessage("lobby-installed-mods", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby") return;
      const member = this.members.get(client.sessionId);
      if (!member) return;
      const ids = parseInstalledModIds(payload.installedModIds);
      if (!ids) {
        this.sendError(client, "已安装 Mod 列表格式不正确。");
        return;
      }
      member.installedModIds = ids;
      member.ready = false;
      this.broadcastRoomState();
    });
    this.onMessage("lobby-settings", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby" || client.sessionId !== this.hostSessionId) return;
      this.updateSettings(client, payload);
    });
    this.onMessage("lobby-map", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby" || client.sessionId !== this.hostSessionId) return;
      this.selectMap(client, payload.mapCode);
    });
    this.onMessage("lobby-mod-settings", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby" || client.sessionId !== this.hostSessionId) return;
      this.updateModSettings(client, payload.modSettings);
    });
    this.onMessage("lobby-seat", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby") return;
      const member = this.members.get(client.sessionId);
      if (!member) return;
      this.chooseSeat(client, member, payload.seat);
    });
    this.onMessage("lobby-color", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby") return;
      const member = this.members.get(client.sessionId);
      if (!member?.participating) return;
      const colorId = typeof payload.playerColorId === "string" ? payload.playerColorId : "";
      if (!PLAYER_COLOR_OPTIONS.some((color) => color.id === colorId)) {
        this.sendError(client, "这个棋子花色不存在。");
        return;
      }
      if ([...this.members.values()].some((candidate) => candidate !== member
        && candidate.participating && candidate.playerColorId === colorId)) {
        this.sendError(client, "这个棋子花色已经被其他参战玩家选了。");
        return;
      }
      member.playerColorId = colorId;
      member.ready = false;
      this.broadcastRoomState();
    });
    this.onMessage("lobby-participation", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby") return;
      const member = this.members.get(client.sessionId);
      if (!member) return;
      this.chooseParticipation(client, member, payload.participating === true);
    });
    this.onMessage("lobby-assign", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "lobby" || client.sessionId !== this.hostSessionId) return;
      this.assignMember(client, payload);
    });
    this.onMessage("match-return-to-lobby", (client) => {
      if (this.phase !== "playing") return;
      if (client.sessionId !== this.hostSessionId || !this.members.has(client.sessionId)) {
        this.sendError(client, "只有房主可以结束对局并返回准备房间。");
        return;
      }
      this.returnToLobby();
    });
    this.onMessage("room-sync", (client) => {
      if (!this.members.has(client.sessionId)) return;
      const now = Date.now();
      const lastSyncAt = this.lastRoomSyncAtBySession.get(client.sessionId);
      if (lastSyncAt !== undefined && now - lastSyncAt < PvpRelayRoom.ROOM_SYNC_COOLDOWN_MS) return;
      this.lastRoomSyncAtBySession.set(client.sessionId, now);

      // A replacement host first needs the last accepted board. If the first
      // host vanished before sending one, replay match-start so it can build
      // the same initial board. Only then may it become authoritative.
      if (this.phase === "playing" && client.sessionId === this.hostSessionId
        && client.sessionId !== this.authoritativeHostSessionId) {
        if (this.sendCachedSnapshot(client, true) || this.sendMatchStart(client)) {
          this.authoritativeHostSessionId = client.sessionId;
        }
      }
      this.sendClientContext(client);
      if (this.phase === "playing") {
        if (client.sessionId === this.hostSessionId) {
          // Room-host normally triggers the upload. This explicit request also
          // recovers if that earlier event was missed before handlers existed.
          if (!this.latestHostSnapshot && client.sessionId === this.authoritativeHostSessionId) {
            client.send("snapshot-request", { sessionId: client.sessionId });
          }
        } else if (!this.sendCachedSnapshot(client)) {
          this.requestHostSnapshot(client.sessionId);
        }
      }
    });
  }

  private validateSnapshot(payload: Record<string, unknown>, receivedAtEpochMs: number): CachedHostSnapshot | undefined {
    const state = payload.state;
    const sequence = isRecord(state) ? state.sequence : undefined;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return;
    if (this.latestHostSnapshot && sequence < this.latestHostSnapshot.sequence) return;
    const hostSentAtEpochMs = payload.hostSentAtEpochMs;
    const offset = typeof hostSentAtEpochMs === "number" && Number.isFinite(hostSentAtEpochMs)
      ? receivedAtEpochMs - hostSentAtEpochMs
      : 0;
    const clock = isRecord(payload.clock) ? payload.clock : undefined;
    // `handoff` is a server-only delivery marker, never supplied by the host.
    const { handoff: _ignoredHandoff, ...cleanPayload } = payload;
    return {
      payload: clock ? { ...cleanPayload, clock: rebaseClockEpochs(clock, offset) } : cleanPayload,
      sequence
    };
  }

  private sendCachedSnapshot(client: Client, handoff = false): boolean {
    if (!this.latestHostSnapshot) return false;
    client.send("host-snapshot", {
      ...this.latestHostSnapshot.payload,
      ...(handoff ? { handoff: true } : {}),
      serverSentAtEpochMs: Date.now()
    });
    return true;
  }

  private sendMatchStart(client: Client): boolean {
    if (!this.matchStartPayload) return false;
    client.send("match-start", this.matchStartPayload);
    return true;
  }

  private requestHostSnapshot(sessionId: string): void {
    const host = this.clients.find((candidate) => candidate.sessionId === this.hostSessionId);
    if (host) host.send("snapshot-request", { sessionId });
  }

  private roomState(): LobbyRoomState {
    const members = [...this.members.values()]
      .sort((left, right) => {
        if (left.participating !== right.participating) return left.participating ? -1 : 1;
        if (left.participating && !this.settings.randomizePositions && left.seat !== right.seat) {
          return (left.seat ?? Number.MAX_SAFE_INTEGER) - (right.seat ?? Number.MAX_SAFE_INTEGER);
        }
        return left.joinOrder - right.joinOrder;
      })
      .map((member): LobbyMember => ({
        sessionId: member.sessionId,
        accountId: member.accountId,
        displayName: member.displayName,
        connected: member.connected,
        isHost: member.sessionId === this.hostSessionId,
        seat: member.seat,
        participating: member.participating,
        playerColorId: member.playerColorId,
        ready: member.ready,
        installedModIds: member.installedModIds,
        missingModIds: this.missingModIds(member)
      }));
    return {
      phase: this.phase,
      mapCode: this.mapCode,
      mapName: this.mapName,
      mapPlayerCount: this.mapPlayerCount,
      requiredTerrainModIds: this.requiredTerrainModIds,
      roomModSettings: this.roomModSettings,
      settings: this.settings,
      members,
      ...(this.matchStartedAtEpochMs === null ? {} : { startedAtEpochMs: this.matchStartedAtEpochMs })
    };
  }

  private broadcastRoomState(): void {
    for (const client of this.clients) {
      this.sendClientRole(client);
    }
    this.broadcast("room-state", this.roomState());
  }

  private sendClientContext(client: Client): void {
    this.sendClientRole(client);
    client.send("room-state", this.roomState());
    client.send("room-host", { sessionId: this.hostSessionId });
  }

  private sendClientRole(client: Client): void {
    const member = this.members.get(client.sessionId);
    if (!member) return;
    client.send("room-role", {
      ...this.publicMember(member),
      ...(member.seat === null ? {} : { playerId: playerIdForSeat(member.seat) })
    });
  }

  private publicMember(member: MutableLobbyMember): LobbyMember {
    return {
      sessionId: member.sessionId,
      accountId: member.accountId,
      displayName: member.displayName,
      connected: member.connected,
      isHost: member.sessionId === this.hostSessionId,
      seat: member.seat,
      participating: member.participating,
      playerColorId: member.playerColorId,
      ready: member.ready,
      installedModIds: member.installedModIds,
      missingModIds: this.missingModIds(member)
    };
  }

  private missingModIds(member: MutableLobbyMember): string[] {
    const installed = new Set(member.installedModIds);
    return this.requiredTerrainModIds.filter((id) => !installed.has(id));
  }

  override onJoin(client: Client, options: Record<string, unknown> = {}): void {
    super.onJoin(client, options);
    const requestedAccountId = typeof options.accountId === "string" ? options.accountId.trim() : "";
    const requestedName = typeof options.name === "string" ? options.name.trim() : "";
    const installedModIds = parseInstalledModIds(options.installedModIds) ?? [];
    const previous = requestedAccountId
      ? [...this.members.values()].find((member) => member.accountId === requestedAccountId)
      : undefined;
    if (previous) {
      const oldSessionId = previous.sessionId;
      this.members.delete(oldSessionId);
      this.lastRoomSyncAtBySession.delete(oldSessionId);
      previous.sessionId = client.sessionId;
      previous.displayName = requestedName || previous.displayName;
      previous.connected = true;
      previous.installedModIds = installedModIds;
      if (this.phase === "lobby" && this.missingModIds(previous).length > 0) previous.ready = false;
      this.members.set(client.sessionId, previous);
      if (this.hostSessionId === oldSessionId || !this.hostSessionId) {
        this.hostSessionId = client.sessionId;
        // The replacement host first receives the last accepted board.
        // Until then it cannot submit a new authoritative snapshot.
        this.authoritativeHostSessionId = this.phase === "playing" ? undefined : client.sessionId;
      }
      this.broadcastRoomState();
      this.broadcast("room-host", { sessionId: this.hostSessionId });
      return;
    }
    const defaultSeat = this.phase === "lobby" && !this.settings.randomizePositions
      ? this.firstOpenSeat()
      : null;
    const canParticipate = this.phase === "lobby"
      && (this.settings.randomizePositions
        ? this.participantCount() < Math.min(this.mapPlayerCount, PLAYER_COLOR_OPTIONS.length)
        : defaultSeat !== null && this.firstAvailablePlayerColor() !== null);
    const member: MutableLobbyMember = {
      sessionId: client.sessionId,
      accountId: requestedAccountId || `guest-${client.sessionId.slice(0, 6)}`,
      displayName: requestedName || `玩家 ${this.nextJoinOrder + 1}`,
      connected: true,
      seat: canParticipate ? defaultSeat : null,
      participating: canParticipate,
      playerColorId: canParticipate ? this.firstAvailablePlayerColor() : null,
      ready: false,
      installedModIds,
      joinOrder: this.nextJoinOrder++
    };
    this.members.set(client.sessionId, member);
    if (!this.hostSessionId) this.hostSessionId = client.sessionId;
    this.broadcastRoomState();
    this.broadcast("room-host", { sessionId: this.hostSessionId });
  }

  override async onLeave(client: Client, code: number): Promise<void> {
    const member = this.members.get(client.sessionId);
    if (member) {
      console.info("PvP socket left", {
        roomId: this.roomId,
        sessionId: client.sessionId,
        closeCode: code,
        phase: this.phase,
        wasHost: client.sessionId === this.hostSessionId
      });
      member.connected = false;
      member.ready = false;
      // Do not leave the match without an authority for the entire Colyseus
      // reconnection grace period. A returning player keeps their seat, but
      // the connected successor remains host for this handoff.
      if (client.sessionId === this.hostSessionId) this.promoteConnectedHost(client.sessionId);
      this.broadcastRoomState();
    }
    await super.onLeave(client, code);
    // A new socket using the same account may have replaced this member while
    // allowReconnection was pending. Never remove or demote that new session.
    if (!member || this.members.get(client.sessionId) !== member) return;
    const reconnected = this.clients.some((candidate) => candidate.sessionId === client.sessionId);
    if (reconnected && member) {
      member.connected = true;
      this.broadcastRoomState();
      return;
    }
    if (this.phase === "lobby") this.members.delete(client.sessionId);
    this.lastRoomSyncAtBySession.delete(client.sessionId);
    if (client.sessionId === this.hostSessionId) this.promoteConnectedHost(client.sessionId);
    this.broadcastRoomState();
    // A disconnected participant may have been the only member preventing
    // the remaining ready participants from starting. Once their reconnect
    // window expires, re-evaluate the lobby with the smaller participant set.
    this.startWhenReady();
  }

  private promoteConnectedHost(excludeSessionId: string): void {
    // Prefer an active player who received match-start. A spectator can still
    // take over from a cached board if every active player is disconnected.
    const successor = [...this.members.values()]
      .filter((candidate) => candidate.connected && candidate.sessionId !== excludeSessionId)
      .sort((left, right) => Number(right.participating) - Number(left.participating)
        || left.joinOrder - right.joinOrder)[0];
    this.hostSessionId = successor?.sessionId;
    this.authoritativeHostSessionId = undefined;
    const nextClient = this.clients.find((candidate) => candidate.sessionId === successor?.sessionId);
    if (nextClient && (this.phase !== "playing"
      || this.sendCachedSnapshot(nextClient, true)
      || this.sendMatchStart(nextClient))) {
      this.authoritativeHostSessionId = nextClient.sessionId;
    }
    this.broadcast("room-host", { sessionId: this.hostSessionId });
  }

  private updateSettings(client: Client, payload: Record<string, unknown>): void {
    const wasRandom = this.settings.randomizePositions;
    const nextSettings: LobbySettings = {
      friendlyFire: typeof payload.friendlyFire === "boolean" ? payload.friendlyFire : this.settings.friendlyFire,
      turnTimeSeconds: clampTimer(payload.turnTimeSeconds, 10, 300, this.settings.turnTimeSeconds),
      matchTimeMinutes: clampTimer(payload.matchTimeMinutes, 1, 180, this.settings.matchTimeMinutes),
      randomizePositions: typeof payload.randomizePositions === "boolean"
        ? payload.randomizePositions
        : this.settings.randomizePositions
    };
    if (nextSettings.turnTimeSeconds !== 0 && nextSettings.matchTimeMinutes !== 0
      && nextSettings.turnTimeSeconds > nextSettings.matchTimeMinutes * 60) {
      this.sendError(client, "步时不能大于局时，请调整后再试。 ");
      return;
    }
    this.settings = nextSettings;
    if (wasRandom !== this.settings.randomizePositions) this.convertPositionMode();
    this.resetReady();
    this.setMetadata({
      protocol: "host-authoritative-relay",
      version: "0.2.0",
      mapName: this.mapName,
      mapPlayerCount: this.mapPlayerCount
    });
    this.broadcastRoomState();
  }

  private selectMap(client: Client, requestedCode: unknown): void {
    if (typeof requestedCode !== "string") {
      this.sendError(client, "地图码格式不正确。 ");
      return;
    }
    let selectedMap: ReturnType<typeof parseMapCode>;
    try {
      selectedMap = parseMapCode(requestedCode, installedMapCatalogs);
    } catch {
      this.sendError(client, "地图码无法读取，请检查内容后重试。 ");
      return;
    }
    if (requestedCode === this.mapCode) return;

    this.mapCode = requestedCode;
    this.mapName = selectedMap.name;
    this.mapPlayerCount = selectedMap.players;
    this.requiredTerrainModIds = selectedMap.requiredTerrainModIds;
    this.roomModSettings = {};
    if (this.settings.randomizePositions) {
      const participants = [...this.members.values()]
        .filter((member) => member.participating)
        .sort((left, right) => left.joinOrder - right.joinOrder);
      for (const member of participants.slice(this.mapPlayerCount)) {
        member.participating = false;
        member.seat = null;
        member.playerColorId = null;
      }
    } else {
      for (const member of this.members.values()) {
        if (member.seat !== null && member.seat > this.mapPlayerCount) {
          member.seat = null;
          member.participating = false;
          member.playerColorId = null;
        }
      }
    }
    this.resetReady();
    this.setMetadata({
      protocol: "host-authoritative-relay",
      version: "0.2.0",
      mapName: this.mapName,
      mapPlayerCount: this.mapPlayerCount
    });
    this.broadcastRoomState();
  }

  private updateModSettings(client: Client, rawSettings: unknown): void {
    try {
      // The message replaces the entire room override. Unknown Mod IDs,
      // undeclared fields and out-of-range values never enter room state.
      this.roomModSettings = validateModSettings(
        rawSettings,
        this.requiredTerrainModIds,
        installedMapCatalogs.mods,
        false
      ) ?? {};
    } catch (error) {
      this.sendError(client, error instanceof Error ? error.message : "Mod 设置无效。");
      return;
    }
    this.resetReady();
    this.broadcastRoomState();
  }

  private convertPositionMode(): void {
    const participants = [...this.members.values()]
      .filter((member) => member.participating)
      .sort((left, right) => left.joinOrder - right.joinOrder)
      .slice(0, this.mapPlayerCount);
    const selected = new Set(participants.map((member) => member.sessionId));
    for (const member of this.members.values()) {
      member.participating = selected.has(member.sessionId);
      if (!member.participating) member.playerColorId = null;
      member.seat = this.settings.randomizePositions || !member.participating
        ? null
        : participants.findIndex((candidate) => candidate.sessionId === member.sessionId) + 1;
    }
  }

  private chooseSeat(client: Client, member: MutableLobbyMember, requestedSeat: unknown): void {
    if (this.settings.randomizePositions) {
      this.sendError(client, "随机位置模式只能选择参战或观战。 ");
      return;
    }
    if (requestedSeat === null) {
      member.seat = null;
      member.participating = false;
      member.playerColorId = null;
      member.ready = false;
      this.broadcastRoomState();
      return;
    }
    const seat = Number(requestedSeat);
    if (!Number.isInteger(seat) || seat < 1 || seat > this.mapPlayerCount) {
      this.sendError(client, "该地图没有这个玩家位。 ");
      return;
    }
    const occupied = [...this.members.values()].some((candidate) => candidate !== member && candidate.seat === seat);
    if (occupied) {
      this.sendError(client, `${seat} 号位已经有人。`);
      return;
    }
    const playerColorId = member.playerColorId ?? this.firstAvailablePlayerColor();
    if (!playerColorId) {
      this.sendError(client, "旧版棋子花色已用完，当前最多支持 9 位参战玩家。");
      return;
    }
    member.seat = seat;
    member.participating = true;
    member.playerColorId = playerColorId;
    member.ready = false;
    this.broadcastRoomState();
  }

  private chooseParticipation(client: Client, member: MutableLobbyMember, participating: boolean): void {
    if (!this.settings.randomizePositions) {
      this.sendError(client, "固定位置模式请直接选择具体座位。 ");
      return;
    }
    if (participating && !member.participating && this.participantCount() >= this.mapPlayerCount) {
      this.sendError(client, "参战名额已满，可以先进入观战位。 ");
      return;
    }
    const playerColorId = participating && !member.participating
      ? this.firstAvailablePlayerColor()
      : member.playerColorId;
    if (participating && !playerColorId) {
      this.sendError(client, "旧版棋子花色已用完，当前最多支持 9 位参战玩家。");
      return;
    }
    member.participating = participating;
    member.playerColorId = participating ? playerColorId! : null;
    member.seat = null;
    member.ready = false;
    this.broadcastRoomState();
  }

  private assignMember(client: Client, payload: Record<string, unknown>): void {
    const target = typeof payload.sessionId === "string" ? this.members.get(payload.sessionId) : undefined;
    if (!target) {
      this.sendError(client, "找不到要调整的房间成员。 ");
      return;
    }
    if (this.settings.randomizePositions) {
      this.chooseParticipation(client, target, payload.participating === true);
      return;
    }
    if (payload.seat === null) {
      target.seat = null;
      target.participating = false;
      target.playerColorId = null;
      target.ready = false;
      this.broadcastRoomState();
      return;
    }
    const seat = Number(payload.seat);
    if (!Number.isInteger(seat) || seat < 1 || seat > this.mapPlayerCount) {
      this.sendError(client, "该地图没有这个玩家位。 ");
      return;
    }
    const previousSeat = target.seat;
    const occupant = [...this.members.values()].find((candidate) => candidate !== target && candidate.seat === seat);
    const targetColor = target.playerColorId ?? occupant?.playerColorId ?? this.firstAvailablePlayerColor(target);
    if (!targetColor) {
      this.sendError(client, "旧版棋子花色已用完，当前最多支持 9 位参战玩家。");
      return;
    }
    if (occupant) {
      occupant.seat = previousSeat;
      occupant.participating = previousSeat !== null;
      if (!occupant.participating) occupant.playerColorId = null;
      occupant.ready = false;
    }
    target.seat = seat;
    target.participating = true;
    target.playerColorId = targetColor;
    target.ready = false;
    this.broadcastRoomState();
  }

  private startWhenReady(): void {
    if (this.phase !== "lobby") return;
    let participants = [...this.members.values()]
      .filter((member) => member.participating);
    if (participants.length === 0 || participants.length > this.mapPlayerCount
      || new Set(participants.map((member) => member.playerColorId)).size !== participants.length
      || participants.some((member) => !member.connected || !member.ready || !member.playerColorId || this.missingModIds(member).length > 0)) return;

    if (this.settings.randomizePositions) {
      participants = shuffle(participants);
      const randomizedSeats = shuffle(Array.from({ length: this.mapPlayerCount }, (_, index) => index + 1));
      participants.forEach((member, index) => { member.seat = randomizedSeats[index]!; });
    } else {
      const seats = new Set(participants.map((member) => member.seat));
      if (seats.size !== participants.length || [...seats].some((seat) => seat === null)) return;
      participants.sort((left, right) => (left.seat ?? 0) - (right.seat ?? 0));
    }

    this.phase = "playing";
    this.matchStartedAtEpochMs = Date.now();
    this.authoritativeHostSessionId = this.hostSessionId;
    this.latestHostSnapshot = undefined;
    const payload: MatchStartPayload = {
      mapCode: this.mapCode,
      settings: this.settings,
      roomModSettings: this.roomModSettings,
      startedAtEpochMs: this.matchStartedAtEpochMs,
      assignments: participants.map((member) => ({
        sessionId: member.sessionId,
        seat: member.seat!,
        playerId: playerIdForSeat(member.seat!),
        displayName: member.displayName,
        ...(member.playerColorId ? { playerColorId: member.playerColorId } : {})
      }))
    };
    this.matchStartPayload = payload;
    this.broadcastRoomState();
    this.broadcast("match-start", payload);
  }

  /** End the current online match for every member, not just the host's local board. */
  private returnToLobby(): void {
    this.phase = "lobby";
    this.matchStartedAtEpochMs = null;
    this.latestHostSnapshot = undefined;
    this.matchStartPayload = undefined;
    this.authoritativeHostSessionId = this.hostSessionId;
    this.lastRoomSyncAtBySession.clear();
    this.resetReady();
    // Random seats were only assigned for the finished match. Participants
    // choose participate/spectate again in the lobby, not those old seats.
    if (this.settings.randomizePositions) {
      for (const member of this.members.values()) member.seat = null;
    }
    this.broadcastRoomState();
  }

  private firstOpenSeat(): number | null {
    if (this.participantCount() >= PLAYER_COLOR_OPTIONS.length) return null;
    const occupied = new Set([...this.members.values()].map((member) => member.seat));
    for (let seat = 1; seat <= this.mapPlayerCount; seat += 1) {
      if (!occupied.has(seat)) return seat;
    }
    return null;
  }

  private participantCount(): number {
    return [...this.members.values()].filter((member) => member.participating).length;
  }

  private firstAvailablePlayerColor(except?: MutableLobbyMember): string | null {
    const used = new Set([...this.members.values()]
      .filter((member) => member !== except && member.participating)
      .map((member) => member.playerColorId)
      .filter((colorId): colorId is string => colorId !== null));
    return PLAYER_COLOR_OPTIONS.find((color) => !used.has(color.id))?.id ?? null;
  }

  private resetReady(): void {
    for (const member of this.members.values()) member.ready = false;
  }

  private sendError(client: Client, message: string): void {
    client.send("lobby-error", { message });
  }
}

/**
 * Optional headless entry point for a future authoritative deployment.
 * The current PvP room deliberately does not call it: the host executes
 * game-core locally and the relay only transports commands/snapshots.
 */
export function validateIntent(
  state: GameState,
  intent: GameIntent,
  commandId: string,
  catalogs: {
    readonly terrains: TerrainCatalog;
    readonly units: UnitCatalog;
    readonly matchConditions?: MatchConditionCatalog;
  }
) {
  return applyIntent(state, intent, commandId, catalogs.terrains, catalogs.units, catalogs.matchConditions);
}

/**
 * The first online slice deliberately keeps the backend thin:
 * - Colyseus owns room discovery, seats, reconnect windows and transport.
 * - RelayRoom broadcasts the host's authoritative snapshot/messages.
 * - The browser and the headless game-core remain responsible for rules.
 *
 * `validateIntent` stays exported for a later server-authoritative mode, but
 * it is not called by this relay room. A host conflict is resolved by the
 * host's snapshot, which is the contract for today's local-first PvP test.
 */
export function createGameServer(): Server {
  const gameServer = new Server({
    transport: new WebSocketTransport({ maxPayload: MAX_CLIENT_MESSAGE_BYTES })
  });

  gameServer.define("pvp", PvpRelayRoom, {
    maxClients: MAX_ROOM_CAPACITY,
    allowReconnectionTime: 30,
    metadata: {
      protocol: "host-authoritative-relay",
      version: "0.2.0"
    }
  });
  // Public PvP staging must not expose anonymous source/map publishing. Keep
  // the workshop available during local development; production opts in.
  if (process.env.WORKSHOP_ENABLED === "1"
    || (process.env.NODE_ENV !== "production" && process.env.WORKSHOP_ENABLED !== "0")) {
    gameServer.define("workshop", WorkshopRoom);
  }
  return gameServer;
}

export async function startServer(
  port = Number(process.env.PORT ?? 2567),
  host = process.env.HOST ?? "0.0.0.0"
): Promise<void> {
  const gameServer = createGameServer();
  await gameServer.listen(port, host);
  console.info(`Numeral Lord relay server listening on ${host}:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer();
}

function playerIdForSeat(seat: number): string {
  return `player-${seat}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Bound and sanitize the client capability declaration used for lobby checks. */
function parseInstalledModIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  if (!value.every((id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/.test(id))) return undefined;
  return [...new Set(value as string[])];
}

/** Keep the cached clock in server time; each delivery receives a fresh stamp. */
function rebaseClockEpochs(clock: Record<string, unknown>, offset: number): Record<string, unknown> {
  const rebased = { ...clock };
  for (const field of ["activeSinceEpochMs", "actionDeadlineEpochMs", "reinforcementDeadlineEpochMs"] as const) {
    const timestamp = clock[field];
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      rebased[field] = timestamp + offset;
    }
  }
  return rebased;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function clampTimer(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (Number(value) === 0) return 0;
  return clampInteger(value, minimum, maximum, fallback);
}

function shuffle<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
