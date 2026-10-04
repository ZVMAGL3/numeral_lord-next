import {
  DEFAULT_LOBBY_SETTINGS,
  MAX_ROOM_CAPACITY,
  PLAYER_COLOR_OPTIONS,
  applyIntent,
  getLegalIntents
} from "@numeral-lord/game-core/node";
import { DEFAULT_MAP_CODE, coreTerrainCatalog, parseMapCode, serializeMapCode, validateModSettings } from "@numeral-lord/core-content";
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
  ModContentLock,
  TerrainCatalog,
  UnitCatalog
} from "@numeral-lord/game-core/node";
import { RelayRoom, Server, WebSocketTransport, type Client } from "colyseus";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SafeLobbyRoom } from "./lobby-room.js";
import {
  initializeWorkshopStore,
  isWorkshopEnabled,
  saveUploadedTerrainAsset,
  startWorkshopAssetCleanupScheduler,
  WorkshopInputError,
  WorkshopRoom
} from "./workshop.js";
import { defaultWorkshopDataDirectory, getTerrainAssetContentType, workshopTerrainAssetDirectory } from "./workshop-assets.js";

/** Server-side schemas validate map and Mod settings; this does not install Mods on clients. */
const installedMapCatalogs = {
  terrains: { ...coreTerrainCatalog, ...oilFieldTerrainCatalog },
  terrainModIds: { [oilFieldMod.terrain.id]: oilFieldMod.id },
  mods: { [oilFieldMod.id]: oilFieldMod },
  // The relay transports maps/mod settings but does not run a client's Mod
  // code. The owning clients validate custom definitions before play.
  allowUnknownTerrainMods: true
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
const MAX_TERRAIN_ASSET_BYTES = 128 * 1024;
const REPLACED_BROWSER_SESSION_CLOSE_CODE = 4001;

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
  installedModVersions: Readonly<Record<string, string>>;
  installedModContentHashes: Readonly<Record<string, string>>;
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
  private effectiveTerrainModReleases: readonly ModContentLock[] = [];
  private roomModSettings: LobbyModSettings = {};
  private settings: LobbySettings = DEFAULT_LOBBY_SETTINGS;
  private matchStartedAtEpochMs: number | null = null;
  private nextJoinOrder = 0;
  private lastLobbyListingSignature = "";
  private roomCreationMetadata: Record<string, unknown> = {};
  private latestHostSnapshot: CachedHostSnapshot | undefined;
  /** Re-sendable initial state seed if the first host disappears before its first snapshot. */
  private matchStartPayload: MatchStartPayload | undefined;

  override onCreate(options: RoomCreateOptions): void {
    const initialMapCode = options.mapCode ?? DEFAULT_MAP_CODE;
    const initialMap = parseMapCode(initialMapCode, installedMapCatalogs);
    this.roomCreationMetadata = isRecord(options.metadata) ? options.metadata : {};
    this.mapCode = serializeMapCode(initialMap, installedMapCatalogs);
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
      ...this.roomCreationMetadata,
      visibility: "public",
      phase: this.phase,
      mapName: this.mapName,
      mapPlayerCount: this.mapPlayerCount,
      requiredTerrainModIds: this.requiredTerrainModIds,
      playerCount: 0,
      openSeats: this.mapPlayerCount,
      hostName: ""
    });

    // The server owns room membership and setup, while game-core remains the
    // authority for board rules in the host client.
    this.onMessage("player-intent", (client, rawPayload: unknown = {}) => {
      const payload = isRecord(rawPayload) ? rawPayload : {};
      const member = this.members.get(client.sessionId);
      if (this.phase !== "playing" || this.authoritativeHostSessionId !== this.hostSessionId
        || !member?.participating || member.seat === null) {
        const commandId = isRecord(payload.command) && typeof payload.command.commandId === "string"
          ? payload.command.commandId
          : undefined;
        console.warn("PvP intent rejected by relay", {
          roomId: this.roomId,
          sessionId: client.sessionId,
          phase: this.phase,
          isAuthoritativeHost: this.authoritativeHostSessionId === this.hostSessionId,
          participating: member?.participating ?? false,
          seat: member?.seat ?? null,
          commandId
        });
        client.send("intent-rejected", { commandId, reason: "room-not-ready-or-player-ineligible" });
        return;
      }
      const playerId = playerIdForSeat(member.seat);
      const command = sanitizeRelayedCommand(payload.command, playerId);
      const parentCommandId = payload.parentCommandId === undefined || payload.parentCommandId === null
        ? null
        : typeof payload.parentCommandId === "string" && payload.parentCommandId.length <= 128
          ? payload.parentCommandId
          : undefined;
      if (!command || parentCommandId === undefined) {
        client.send("intent-rejected", {
          commandId: isRecord(payload.command) && typeof payload.command.commandId === "string"
            ? payload.command.commandId.slice(0, 128)
            : undefined,
          reason: "invalid-command-payload"
        });
        return;
      }
      console.info("PvP intent relayed", {
        roomId: this.roomId,
        sessionId: client.sessionId,
        seat: member.seat,
        playerId,
        commandType: isRecord(command) ? command.type : typeof command,
        commandId: isRecord(command) ? command.commandId : undefined,
        expectedSequence: isRecord(command) ? command.expectedSequence : undefined,
        hostSessionId: this.hostSessionId
      });
      this.broadcast("player-intent", { parentCommandId, command, playerId }, { except: client });
    });
    this.onMessage("host-snapshot", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "playing" || client.sessionId !== this.hostSessionId) return;
      if (client.sessionId !== this.authoritativeHostSessionId) {
        console.warn("PvP host snapshot rejected: host is not authoritative", {
          roomId: this.roomId,
          sessionId: client.sessionId,
          authoritativeHostSessionId: this.authoritativeHostSessionId
        });
        client.send("snapshot-rejected", { reason: "host-not-authoritative" });
        return;
      }
      const receivedAtEpochMs = Date.now();
      const snapshot = this.validateSnapshot(payload, receivedAtEpochMs);
      if (!snapshot) {
        console.warn("PvP host snapshot ignored", {
          roomId: this.roomId,
          sessionId: client.sessionId,
          receivedSequence: isRecord(payload.state) ? payload.state.sequence : undefined,
          cachedSequence: this.latestHostSnapshot?.sequence,
          reason: "invalid-or-stale"
        });
        return;
      }
      const previousSequence = this.latestHostSnapshot?.sequence;
      this.latestHostSnapshot = snapshot;
      if (previousSequence !== snapshot.sequence || typeof payload.resolvedCommandId === "string") {
        console.info("PvP host snapshot accepted", {
          roomId: this.roomId,
          sessionId: client.sessionId,
          previousSequence: previousSequence ?? null,
          sequence: snapshot.sequence,
          resolvedCommandId: typeof payload.resolvedCommandId === "string" ? payload.resolvedCommandId : undefined
        });
      }
      // Local-first command replication keeps snapshots out of the normal
      // action path. Only initial join, handoff, or explicit conflict repair
      // fans a full board out to the room.
      if (payload.cacheOnly !== true || payload.reconcile === true) {
        this.broadcast("host-snapshot", {
          ...snapshot.payload,
          serverSentAtEpochMs: receivedAtEpochMs
        }, { except: client });
      }
    });
    this.onMessage("command-conflict", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "playing" || !this.members.has(client.sessionId)) return;
      const host = this.clients.find((candidate) => candidate.sessionId === this.authoritativeHostSessionId);
      if (!host) return;
      host.send("command-conflict", {
        sessionId: client.sessionId,
        sequence: payload.sequence,
        commandHeadId: typeof payload.commandHeadId === "string" ? payload.commandHeadId : null
      });
    });
    this.onMessage("snapshot-check", (client, payload: Record<string, unknown> = {}) => {
      if (this.phase !== "playing" || !this.members.has(client.sessionId)
        || client.sessionId === this.hostSessionId) return;
      const clientSequence = payload.sequence;
      if (typeof clientSequence !== "number" || !Number.isSafeInteger(clientSequence) || clientSequence < 0) return;
      if (!this.latestHostSnapshot) {
        // The client already received match-start to enter play. Replaying it
        // on every check resets its local board and can make the match
        // impossible to advance while the host's first snapshot is missing.
        this.requestHostSnapshot(client.sessionId);
      } else if (clientSequence < this.latestHostSnapshot.sequence) {
        this.sendCachedSnapshot(client);
      } else if (clientSequence > this.latestHostSnapshot.sequence) {
        // The cached relay copy can lag only during host handoff or a missed
        // publication. Ask the authority to refresh it; never roll the client back.
        this.requestHostSnapshot(client.sessionId);
      }
    });
    this.onMessage("lobby-ready", (client, payload: Record<string, unknown> = {}) => {
      const member = this.members.get(client.sessionId);
      if (this.phase !== "lobby" || !member?.participating) return;
      if (payload.ready === true && this.missingModIds(member).length > 0) {
        this.sendError(client, `请先安装地图需要的地块 Mod：${this.missingModIds(member).join("、")}`);
        return;
      }
      if (payload.ready === true && this.modVersionMismatchIds().length > 0) {
        this.sendError(client, `参战玩家的地块 Mod 版本或内容不一致：${this.modVersionMismatchIds().join("、")}。请更新后重新准备。`);
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
      const versions = parseInstalledModVersions(payload.installedModVersions, ids);
      if (!versions) {
        this.sendError(client, "已安装地块 Mod 版本列表格式不正确。");
        return;
      }
      const contentHashes = parseInstalledModContentHashes(payload.installedModContentHashes, ids);
      if (!contentHashes) {
        this.sendError(client, "已安装地块 Mod 内容指纹格式不正确。");
        return;
      }
      if (sameStringRecord(member.installedModVersions, versions)
        && sameStringRecord(member.installedModContentHashes, contentHashes)
        && sameModIds(member.installedModIds, ids)) return;
      member.installedModIds = ids;
      member.installedModVersions = versions;
      member.installedModContentHashes = contentHashes;
      this.refreshEffectiveTerrainModReleases();
      this.resetReady();
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
          // A room can enter `playing` a moment before its new host publishes
          // the first snapshot. Give refreshes/late spectators the deterministic
          // opening board immediately, then request the live host snapshot to
          // replace it. This avoids an endless loading screen if that request
          // races with host handoff or reconnect.
          this.sendMatchStart(client);
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
        installedModVersions: member.installedModVersions,
        installedModContentHashes: member.installedModContentHashes,
        missingModIds: this.missingModIds(member)
      }));
    return {
      phase: this.phase,
      mapCode: this.mapCode,
      mapName: this.mapName,
      mapPlayerCount: this.mapPlayerCount,
      requiredTerrainModIds: this.requiredTerrainModIds,
      effectiveTerrainModReleases: this.effectiveTerrainModReleases,
      modVersionMismatchIds: this.modVersionMismatchIds(),
      roomModSettings: this.roomModSettings,
      settings: this.settings,
      members,
      ...(this.matchStartedAtEpochMs === null ? {} : { startedAtEpochMs: this.matchStartedAtEpochMs })
    };
  }

  private broadcastRoomState(): void {
    this.updateLobbyListingMetadata();
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
      installedModVersions: member.installedModVersions,
      installedModContentHashes: member.installedModContentHashes,
      missingModIds: this.missingModIds(member)
    };
  }

  private updateLobbyListingMetadata(): void {
    const noConnectedClients = this.clients.length === 0;
    const metadata = {
      // Keep a running room discoverable while anyone is connected. If every
      // socket drops, hide it during Colyseus' reconnect grace period: the
      // room can still be resumed by its id, but it is no longer a ghost in
      // the public lobby. A returning member makes it public again below.
      visibility: noConnectedClients ? "private" : "public",
      phase: this.phase,
      mapName: this.mapName,
      mapPlayerCount: this.mapPlayerCount,
      requiredTerrainModIds: this.requiredTerrainModIds,
      playerCount: this.participantCount(),
      openSeats: Math.max(0, this.mapPlayerCount - this.participantCount()),
      hostName: [...this.members.values()].find((member) => member.sessionId === this.hostSessionId)?.displayName ?? ""
    };
    const signature = JSON.stringify(metadata);
    if (signature === this.lastLobbyListingSignature) return;
    this.lastLobbyListingSignature = signature;
    void this.setMetadata({ ...this.roomCreationMetadata, protocol: "host-authoritative-relay", version: "0.2.0", ...metadata });
    // LobbyRoom removes rooms from already-connected clients when Colyseus'
    // actual private flag changes; metadata filtering alone only affects the
    // next room-list snapshot.
    void this.setPrivate(noConnectedClients);
  }

  private missingModIds(member: MutableLobbyMember): string[] {
    const installed = new Set(member.installedModIds);
    return this.requiredTerrainModIds.filter((id) => !installed.has(id));
  }

  /** Maps declare dependency IDs only; the elected host supplies their active release. */
  private refreshEffectiveTerrainModReleases(): void {
    if (this.phase !== "lobby") return;
    const host = this.hostSessionId ? this.members.get(this.hostSessionId) : undefined;
    this.effectiveTerrainModReleases = host
      ? this.requiredTerrainModIds.flatMap((id) => {
        const version = host.installedModVersions[id];
        const contentHash = host.installedModContentHashes[id];
        return version && contentHash ? [{ id, version, contentHash }] : [];
      })
      : [];
  }

  private modVersionMismatchIds(): string[] {
    const participants = [...this.members.values()].filter((member) => member.participating);
    return this.requiredTerrainModIds.filter((modId) => {
      if (participants.some((member) => !member.installedModIds.includes(modId))) return false;
      if (participants.some((member) => !member.installedModVersions[modId] || !member.installedModContentHashes[modId])) return true;
      const hostRelease = this.effectiveTerrainModReleases.find((candidate) => candidate.id === modId);
      if (hostRelease) return participants.some((member) => member.installedModVersions[modId] !== hostRelease.version
        || member.installedModContentHashes[modId] !== hostRelease.contentHash);
      const versions = participants.map((member) => member.installedModVersions[modId]);
      const hashes = participants.map((member) => member.installedModContentHashes[modId]);
      return new Set(versions).size > 1 || new Set(hashes).size > 1;
    });
  }

  override onJoin(client: Client, options: Record<string, unknown> = {}): void {
    super.onJoin(client, options);
    const requestedAccountId = typeof options.accountId === "string" ? options.accountId.trim() : "";
    const requestedName = typeof options.name === "string" ? options.name.trim() : "";
    const installedModIds = parseInstalledModIds(options.installedModIds) ?? [];
    const installedModVersions = parseInstalledModVersions(options.installedModVersions, installedModIds) ?? {};
    const installedModContentHashes = parseInstalledModContentHashes(options.installedModContentHashes, installedModIds) ?? {};
    const previous = requestedAccountId
      ? [...this.members.values()].find((member) => member.accountId === requestedAccountId)
      : undefined;
    if (previous) {
      const oldSessionId = previous.sessionId;
      const oldClient = this.clients.find((candidate) => candidate.sessionId === oldSessionId);
      console.info("PvP member identity resumed", {
        roomId: this.roomId,
        phase: this.phase,
        oldSessionId,
        newSessionId: client.sessionId,
        seat: previous.seat,
        participating: previous.participating,
        wasHost: oldSessionId === this.hostSessionId
      });
      this.members.delete(oldSessionId);
      this.lastRoomSyncAtBySession.delete(oldSessionId);
      previous.sessionId = client.sessionId;
      previous.displayName = requestedName || previous.displayName;
      previous.connected = true;
      previous.installedModIds = installedModIds;
      previous.installedModVersions = installedModVersions;
      previous.installedModContentHashes = installedModContentHashes;
      if (this.phase === "lobby") this.resetReady();
      this.members.set(client.sessionId, previous);
      // Match-start is retained so a replacement host can rebuild the opening
      // state if no authoritative snapshot has been published yet. Keep its
      // session mapping in step with the resumed browser identity; otherwise
      // the refreshed host receives the right seat from room-role but appears
      // as a spectator when the retained payload is replayed.
      if (this.matchStartPayload) {
        this.matchStartPayload = {
          ...this.matchStartPayload,
          assignments: this.matchStartPayload.assignments.map((assignment) =>
            assignment.sessionId === oldSessionId
              ? { ...assignment, sessionId: client.sessionId }
              : assignment
          )
        };
      }
      if (oldClient) {
        console.info("PvP browser identity moved to a new tab", {
          roomId: this.roomId,
          oldSessionId,
          newSessionId: client.sessionId
        });
        oldClient.leave(REPLACED_BROWSER_SESSION_CLOSE_CODE, "This browser identity joined from another tab.");
      }
      if (this.hostSessionId === oldSessionId || !this.hostSessionId) {
        this.hostSessionId = client.sessionId;
        // The replacement host first receives the last accepted board.
        // Until then it cannot submit a new authoritative snapshot.
        this.authoritativeHostSessionId = this.phase === "playing" ? undefined : client.sessionId;
      }
      this.refreshEffectiveTerrainModReleases();
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
      installedModVersions,
      installedModContentHashes,
      joinOrder: this.nextJoinOrder++
    };
    console.info("PvP new room member joined", {
      roomId: this.roomId,
      phase: this.phase,
      sessionId: client.sessionId,
      seat: member.seat,
      participating: member.participating,
      accountMatched: false
    });
    this.members.set(client.sessionId, member);
    if (!this.hostSessionId) this.hostSessionId = client.sessionId;
    this.refreshEffectiveTerrainModReleases();
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
    if (this.phase === "lobby") {
      this.refreshEffectiveTerrainModReleases();
      this.resetReady();
    }
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
    this.updateLobbyListingMetadata();
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
    const canonicalCode = serializeMapCode(selectedMap, installedMapCatalogs);
    if (canonicalCode === this.mapCode) return;

    this.mapCode = canonicalCode;
    this.mapName = selectedMap.name;
    this.mapPlayerCount = selectedMap.players;
    this.requiredTerrainModIds = selectedMap.requiredTerrainModIds;
    this.refreshEffectiveTerrainModReleases();
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
    this.updateLobbyListingMetadata();
    this.broadcastRoomState();
  }

  private updateModSettings(client: Client, rawSettings: unknown): void {
    try {
      // The message replaces the entire room override. Known Mod settings are
      // schema-validated here; unknown Mod objects receive only safe JSON
      // values because the relay forwards data and never executes their code.
      this.roomModSettings = validateModSettings(
        rawSettings,
        this.requiredTerrainModIds,
        installedMapCatalogs.mods,
        true
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
      || this.modVersionMismatchIds().length > 0
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
      effectiveTerrainModReleases: this.effectiveTerrainModReleases,
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
    this.refreshEffectiveTerrainModReleases();
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
    transport: new WebSocketTransport({ maxPayload: MAX_CLIENT_MESSAGE_BYTES }),
    express: (app) => {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      };
      app.options("/assets/terrain", (_request: unknown, response: {
        set: (headers: Readonly<Record<string, string>>) => unknown;
        sendStatus: (status: number) => unknown;
      }) => {
        response.set(corsHeaders);
        response.sendStatus(204);
      });
      app.post("/assets/terrain", async (
        request: {
          readonly headers: Readonly<Record<string, string | string[] | undefined>>;
          on: (event: string, listener: (...args: unknown[]) => void) => unknown;
        },
        response: {
          set: (headers: Readonly<Record<string, string>>) => unknown;
          status: (status: number) => { json: (value: unknown) => unknown };
        }
      ) => {
        response.set(corsHeaders);
        const fail = (status: number, error: string): void => { response.status(status).json({ error }); };
        if (!isWorkshopEnabled() || (process.env.NODE_ENV === "production" && process.env.WORKSHOP_PUBLISH_ENABLED !== "1")) {
          fail(503, "当前环境暂未开放工坊图片上传。");
          return;
        }
        const contentTypeHeader = request.headers["content-type"];
        const contentType = typeof contentTypeHeader === "string" ? contentTypeHeader.toLowerCase() : "";
        if (!["image/png", "image/webp", "image/svg+xml"].includes(contentType)) {
          fail(415, "图片仅支持 PNG、WebP 或静态 SVG 格式。");
          return;
        }
        const contentLength = Number(request.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_TERRAIN_ASSET_BYTES) {
          fail(413, "图片文件不能超过 128 KiB。");
          return;
        }
        try {
          const chunks: Buffer[] = [];
          let byteSize = 0;
          let tooLarge = false;
          await new Promise<void>((resolve, reject) => {
            request.on("data", (chunk: unknown) => {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              byteSize += bytes.length;
              if (byteSize > MAX_TERRAIN_ASSET_BYTES) tooLarge = true;
              else if (!tooLarge) chunks.push(bytes);
            });
            request.on("end", () => resolve());
            request.on("error", (error: unknown) => reject(error));
          });
          if (tooLarge) { fail(413, "图片文件不能超过 128 KiB。"); return; }
          const bytes = Buffer.concat(chunks);
          if (!bytes.length) { fail(400, "上传的图片内容为空。"); return; }
          if (!matchesImageContentType(bytes, contentType)) { fail(415, "图片内容与文件格式不一致。"); return; }
          const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
          const record = await saveUploadedTerrainAsset(dataUrl, contentType, bytes.length);
          response.status(201).json({ url: record.assetUrl, uploadId: record.uploadId });
        } catch (error) {
          fail(error instanceof WorkshopInputError ? 400 : 500,
            error instanceof Error ? error.message : "图片上传失败。");
        }
      });
      app.get("/assets/terrain/:fileName", async (
        request: { readonly params: { readonly fileName: string } },
        response: {
          sendStatus: (status: number) => unknown;
          set: (headers: Readonly<Record<string, string>>) => { send: (body: Buffer) => unknown };
        }
      ) => {
        response.set({ "Access-Control-Allow-Origin": "*" });
        const fileName = request.params.fileName;
        const contentType = getTerrainAssetContentType(fileName);
        if (!contentType) {
          response.sendStatus(404);
          return;
        }
        try {
          const asset = await readFile(join(workshopTerrainAssetDirectory(defaultWorkshopDataDirectory()), fileName));
          response.set({
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Type": contentType,
            "X-Content-Type-Options": "nosniff",
            ...(contentType === "image/svg+xml" ? { "Content-Security-Policy": "default-src 'none'; sandbox" } : {})
          }).send(asset);
        } catch {
          response.set({ "Access-Control-Allow-Origin": "*" });
          response.sendStatus(404);
        }
      });
    }
  });

  gameServer.define("pvp", PvpRelayRoom, {
    maxClients: MAX_ROOM_CAPACITY,
    allowReconnectionTime: 30,
    metadata: {
      protocol: "host-authoritative-relay",
      version: "0.2.0"
    }
  }).enableRealtimeListing();
  gameServer.define("lobby", SafeLobbyRoom);
  // Public PvP staging must not expose anonymous source/map publishing. Keep
  // the workshop available during local development; production opts in.
  if (isWorkshopEnabled()) {
    gameServer.define("workshop", WorkshopRoom);
  }
  return gameServer;
}

export async function startServer(
  port = Number(process.env.PORT ?? 2567),
  host = process.env.HOST ?? "0.0.0.0",
  startup: ServerStartupDependencies = {
    createGameServer,
    isWorkshopEnabled,
    initializeWorkshopStore,
    startWorkshopAssetCleanupScheduler
  }
): Promise<void> {
  const gameServer = startup.createGameServer();
  if (startup.isWorkshopEnabled()) {
    await startup.initializeWorkshopStore();
    startup.startWorkshopAssetCleanupScheduler?.();
  }
  await gameServer.listen(port, host);
  console.info(`Numeral Lord relay server listening on ${host}:${port}`);
}

export interface ServerStartupDependencies {
  readonly createGameServer: () => Pick<Server, "listen">;
  readonly isWorkshopEnabled: () => boolean;
  readonly initializeWorkshopStore: () => Promise<void>;
  readonly startWorkshopAssetCleanupScheduler?: () => void;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer();
}

function playerIdForSeat(seat: number): string {
  return `player-${seat}`;
}

function matchesImageContentType(bytes: Buffer, contentType: string): boolean {
  if (contentType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/webp") return bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (contentType === "image/svg+xml") {
    const source = bytes.toString("utf8").replace(/^\uFEFF/, "").trimStart();
    return /^<(?:\?xml\b[^?]*\?>\s*)?(?:!--[\s\S]*?-->\s*)*svg(?:\s|>)/i.test(source);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeRelayedCommand(input: unknown, actorId: string): Record<string, unknown> | undefined {
  if (!isRecord(input)
    || typeof input.commandId !== "string" || input.commandId.length < 1 || input.commandId.length > 128
    || !Number.isSafeInteger(input.expectedSequence) || (input.expectedSequence as number) < 0) return undefined;
  const base = { commandId: input.commandId, actorId, expectedSequence: input.expectedSequence as number };
  switch (input.type) {
    case "move-unit":
      return typeof input.unitId === "string" && input.unitId.length > 0 && input.unitId.length <= 80
        && typeof input.destinationId === "string" && input.destinationId.length > 0 && input.destinationId.length <= 80
        ? { ...base, type: input.type, unitId: input.unitId, destinationId: input.destinationId }
        : undefined;
    case "attack-unit":
      return typeof input.unitId === "string" && input.unitId.length > 0 && input.unitId.length <= 80
        && typeof input.targetId === "string" && input.targetId.length > 0 && input.targetId.length <= 80
        ? { ...base, type: input.type, unitId: input.unitId, targetId: input.targetId }
        : undefined;
    case "reinforce-unit":
      return typeof input.unitId === "string" && input.unitId.length > 0 && input.unitId.length <= 80
        ? { ...base, type: input.type, unitId: input.unitId }
        : undefined;
    case "end-action-phase":
    case "end-reinforcement-phase":
      return { ...base, type: input.type };
    default:
      return undefined;
  }
}

/** Bound and sanitize the client capability declaration used for lobby checks. */
function parseInstalledModIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  if (!value.every((id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/.test(id))) return undefined;
  return [...new Set(value as string[])];
}

/** Versions are bounded, inert labels. Missing labels are kept absent so an old client cannot silently pass compatibility checks. */
function parseInstalledModVersions(value: unknown, installedModIds: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 64) return undefined;
  const installed = new Set(installedModIds);
  const versions: Record<string, string> = {};
  for (const [modId, version] of Object.entries(value)) {
    if (!installed.has(modId) || !/^mod-[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(modId)
      || typeof version !== "string" || version.length < 1 || version.length > 48
      || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/.test(version)) return undefined;
    versions[modId] = version;
  }
  return versions;
}

function parseInstalledModContentHashes(value: unknown, installedModIds: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 64) return undefined;
  const installed = new Set(installedModIds);
  const hashes: Record<string, string> = {};
  for (const [modId, hash] of Object.entries(value)) {
    if (!installed.has(modId) || !/^mod-[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(modId)
      || typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash)) return undefined;
    hashes[modId] = hash;
  }
  return hashes;
}

function sameModIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function sameStringRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([id, version]) => right[id] === version);
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
