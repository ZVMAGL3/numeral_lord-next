<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Client, type Room } from "@colyseus/sdk";
import {
  applyCommand,
  DEFAULT_LOBBY_SETTINGS,
  getActionableUnitIds,
  getLegalActionDestinationIds,
  getPoweredUnitIds,
  appendActionNotation,
  appendPhaseEndNotation,
  appendReinforcementNotation,
  type CellId,
  type GameCommand,
  type LobbyRolePayload,
  type LobbyRoomState,
  type LobbyModSettings,
  type MatchStartPayload,
  type CommandResult,
  type ActionOutcome,
  type NotationEntry,
  type PlayerId,
  type PlayerState,
  type UnitId
} from "@numeral-lord/game-core";
import {
  DEFAULT_MAP_CODE,
  DEFAULT_MAP_DEFINITION,
  coreMatchConditionCatalog,
  coreUnitCatalog,
  createMatchFromMapCode
} from "@numeral-lord/core-content";
import HexBoard from "./components/HexBoard.vue";
import HomeScreen from "./components/HomeScreen.vue";
import LobbyPanel from "./components/LobbyPanel.vue";
import MapLibrary from "./components/MapLibrary.vue";
import WorkshopPanel from "./components/WorkshopPanel.vue";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "./components/WorkshopPanel.vue";
import { addMapToLibrary, loadMapLibrary, removeMapFromLibrary } from "./map-library";
import { installedMapCatalogs, installedTerrainCatalog, installedTerrainMods } from "./installed-content";
import { WorkshopClient, type WorkshopConnectionStatus } from "./workshop-client";
import { requestReturnToLobby } from "./room-reset";
import {
  advanceMatchClocks,
  clockExpiration,
  rebaseMatchClock,
  remainingMatchSeconds,
  remainingTurnSeconds,
  startMatchClocks,
  type MatchClockSnapshot
} from "./match-clock";

const PLAYER_NAME_STORAGE_KEY = "numeral-lord.player-name";
const ACCOUNT_ID_STORAGE_KEY = "numeral-lord.account-id";
const CONNECTION_LOG_STORAGE_KEY = "numeral-lord.connection-log.v1";

function readConnectionLog(): string[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(CONNECTION_LOG_STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((line): line is string => typeof line === "string").slice(-120) : [];
  } catch { return []; }
}

const connectionLog = ref<string[]>(readConnectionLog());
const connectionLogDialogOpen = ref(false);
const connectionLogCopyMessage = ref("");
const connectionLogText = computed(() => connectionLog.value.join("\n"));

function logConnection(event: string, detail: Record<string, unknown> = {}): void {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}`;
  connectionLog.value = [...connectionLog.value, line].slice(-120);
  try { sessionStorage.setItem(CONNECTION_LOG_STORAGE_KEY, JSON.stringify(connectionLog.value)); } catch { /* Diagnostics remain in memory. */ }
}

/** Keep the relay host/path useful for debugging without exposing URL credentials or tokens. */
function relayEndpointForLog(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid relay URL";
  }
}

async function copyConnectionLog(): Promise<void> {
  try {
    await navigator.clipboard.writeText(connectionLogText.value);
    connectionLogCopyMessage.value = "连接日志已复制。";
  } catch {
    connectionLogCopyMessage.value = "自动复制不可用，请在下方文本框中手动选择复制。";
  }
}

/** randomUUID is unavailable on plain HTTP public IPs; getRandomValues works there. */
function createCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomPlayerName(): string {
  const adjectives = ["晨星", "远航", "青岚", "逐光", "沉舟", "星火", "白榆", "长风"];
  const roles = ["棋手", "领主", "旅人", "先锋", "守望者", "指挥官"];
  const random = new Uint32Array(3);
  crypto.getRandomValues(random);
  return `${adjectives[random[0]! % adjectives.length]}${roles[random[1]! % roles.length]}${String(random[2]! % 10_000).padStart(4, "0")}`;
}

function loadOrCreateLocalValue(key: string, create: () => string): string {
  const saved = localStorage.getItem(key)?.trim();
  if (saved) return saved;
  const value = create();
  localStorage.setItem(key, value);
  return value;
}

function loadOrCreateTabValue(key: string, create: () => string): string {
  // A temporary PvP identity belongs to one tab. Refresh keeps the seat;
  // another tab must not silently replace this one's room session.
  const saved = sessionStorage.getItem(key)?.trim();
  if (saved) return saved;
  const value = create();
  sessionStorage.setItem(key, value);
  return value;
}

const game = ref(createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs));
const playerName = ref(loadOrCreateLocalValue(PLAYER_NAME_STORAGE_KEY, randomPlayerName));
const configuredMaps = ref(loadMapLibrary());
const selectedMapLibraryId = ref(DEFAULT_MAP_DEFINITION.id);
const mapActionMessage = ref("");
const mapActionError = ref(false);
const mapLibraryRef = ref<InstanceType<typeof MapLibrary> | null>(null);
const builtInTerrainMod: TerrainModEntry = {
  id: "local:mod-oil-field",
  modId: installedTerrainMods[0].id,
  name: "油田",
  version: installedTerrainMods[0].version,
  description: "占据时每回合产生 2 点；离开时留下 1 点游兵。不导电。这个地块由独立的 oil-field-mod 包提供。",
  terrainIds: installedTerrainMods[0].terrains.map((terrain) => terrain.id),
  installed: true,
  authorName: "Numeral Lord",
  sourceFiles: []
};
const builtInMapWork: MapWorkshopEntry = {
  id: "local:map-1001",
  mapId: DEFAULT_MAP_DEFINITION.id,
  name: DEFAULT_MAP_DEFINITION.name,
  code: DEFAULT_MAP_CODE,
  description: "内置示例地图，使用油田地块 Mod。地图作品本身只是一段地图码。",
  players: DEFAULT_MAP_DEFINITION.players,
  requiredTerrainModIds: DEFAULT_MAP_DEFINITION.requiredTerrainModIds,
  authorName: "Numeral Lord"
};
const remoteTerrainMods = ref<TerrainModEntry[]>([]);
const remoteMapWorks = ref<MapWorkshopEntry[]>([]);
const workshopTerrainMods = computed(() => [builtInTerrainMod, ...remoteTerrainMods.value]);
const workshopMapWorks = computed(() => [builtInMapWork, ...remoteMapWorks.value]);
const workshopStatus = ref<WorkshopConnectionStatus>("offline");
/** Anonymous source publishing is intentionally unavailable on public staging. */
const workshopPublishingEnabled = !window.location.pathname.startsWith("/numeral-lord-play-stage/");
const workshopActionMessage = ref("");
const workshopActionError = ref(false);
const workshopWorking = ref(false);
let workshopClient: WorkshopClient | undefined;
const relayAccountKey = loadOrCreateTabValue(ACCOUNT_ID_STORAGE_KEY, createCommandId);
const invitedRoomId = new URLSearchParams(window.location.search).get("room")?.trim() ?? "";
// A room link is already an explicit game entry. Only the bare site URL shows
// the name/start home page; invite links join immediately with the saved (or
// freshly generated) local name.
const page = ref<"home" | "maps" | "workshop" | "rooms">(invitedRoomId ? "rooms" : "home");
const relayStatus = ref(invitedRoomId ? "连接中…" : "未连接");
const relayRoomId = ref("");
const roomIdInput = ref("");
const relayPlayerId = ref<string | null>(null);
const relayAccountId = ref<string | null>(null);
const relaySessionId = ref<string | null>(null);
const relayIsHost = ref(false);
let relayRoom: Room | undefined;
let relayEndpoint = "";
let connectionAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const leaveDialogOpen = ref(false);
const clockNow = ref(Date.now());
const matchClock = ref<MatchClockSnapshot | null>(null);
let clockTimer: ReturnType<typeof setInterval> | undefined;
let expiredStepSequence: number | null = null;
let lastSnapshotSyncAt = 0;
const initialMapPlayerCount = DEFAULT_MAP_DEFINITION.players;
const lobbyState = ref<LobbyRoomState>({
  phase: "lobby",
  mapPlayerCount: initialMapPlayerCount,
  mapCode: DEFAULT_MAP_CODE,
  mapName: DEFAULT_MAP_DEFINITION.name,
  requiredTerrainModIds: DEFAULT_MAP_DEFINITION.requiredTerrainModIds,
  roomModSettings: {},
  settings: { ...DEFAULT_LOBBY_SETTINGS },
  members: []
});
const lobbyError = ref("");
const lobbyPreviewState = computed(() => {
  try { return createMatchFromMapCode(lobbyState.value.mapCode, {
    ...installedMapCatalogs,
    roomModSettings: lobbyState.value.roomModSettings
  }); }
  catch { return null; }
});
const lobbyPreviewPoweredUnitIds = computed(() => lobbyPreviewState.value
  ? [...getPoweredUnitIds(lobbyPreviewState.value, installedTerrainCatalog)] : []);
const selectedUnitId = ref<UnitId | null>(null);
/** Cell captured at selection time; notation never infers an attacker from a later click. */
const selectedSourceCellId = ref<CellId | null>(null);
/** Only a real user selection can contribute a source-coordinate click to notation. */
const selectedByUser = ref(false);
const notice = ref("选择己方单位，再点击相邻格移动或攻击。");

interface PendingRemoteAction {
  readonly commandId: string;
  readonly expectedSequence: number;
  readonly sourceCellId: CellId;
  readonly targetCellId: CellId;
  readonly includeSourceClick: boolean;
}
let pendingRemoteAction: PendingRemoteAction | undefined;

const notation = ref<readonly NotationEntry[]>([]);
const notationDialogOpen = ref(false);
const notationCopyMessage = ref("");

interface ReinforcementHold {
  readonly cellId: CellId;
  readonly startedAt: number;
  readonly initialPoints: number;
  isLongPress: boolean;
  delayTimer?: ReturnType<typeof setTimeout>;
  tickTimer?: ReturnType<typeof setTimeout>;
}
let reinforcementHold: ReinforcementHold | undefined;

const players = computed(() => (Object.values(game.value.players) as PlayerState[])
  .sort((left, right) => left.seat - right.seat));
const currentPlayer = computed(() => game.value.players[game.value.turn.currentPlayerId]);
const isMatchFinished = computed(() => game.value.turn.phase === "finished");
const winningTeamLabel = computed(() => {
  const winningTeamIds = game.value.result?.winningTeamIds ?? [];
  if (winningTeamIds.length === 0) return "未记录获胜队伍";
  return winningTeamIds.map((teamId) => {
    const members = players.value
      .filter((player) => player.teamId === teamId)
      .map((player) => player.displayName)
      .join("、");
    return members ? `${teamId}（${members}）` : teamId;
  }).join("、");
});
const matchResultTitle = computed(() => game.value.result?.winningTeamIds.length
  ? `${winningTeamLabel.value} 获胜`
  : "对局结束");
const matchResultMessage = computed(() => game.value.result?.message ?? "胜负条件已满足，本局结束。");
const selectedUnit = computed(() => selectedUnitId.value ? game.value.units[selectedUnitId.value] : undefined);
const poweredUnitIds = computed(() => [...getPoweredUnitIds(game.value, installedTerrainCatalog)]);
const actionableUnitIds = computed(() => [...getActionableUnitIds(game.value, installedTerrainCatalog, coreUnitCatalog)]);
const selectedIsPowered = computed(() => selectedUnit.value ? poweredUnitIds.value.includes(selectedUnit.value.id) : false);
const isActionPhase = computed(() => game.value.turn.phase === "action");
const isReinforcementPhase = computed(() => game.value.turn.phase === "reinforcement");
const phaseLabel = computed(() => isActionPhase.value ? "行动回合" : isReinforcementPhase.value ? "加点回合" : "已结束");
const showHome = computed(() => page.value === "home" && !relayRoom);
const showMaps = computed(() => page.value === "maps" && !relayRoom);
const showWorkshop = computed(() => page.value === "workshop" && !relayRoom);
const showLobby = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "lobby");
const showRoomEntry = computed(() => page.value === "rooms"
  && (relayStatus.value === "未连接" || relayStatus.value === "连接失败" || relayStatus.value === "连接已断开"));
const hasLiveSnapshot = ref(false);
const showGame = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "playing" && hasLiveSnapshot.value);
const showGameLoading = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "playing" && !hasLiveSnapshot.value);
const missingLocalModIds = computed(() => lobbyState.value.requiredTerrainModIds.filter(
  (id) => !installedTerrainMods.some((mod) => mod.id === id)
));
const isSpectator = computed(() => lobbyState.value.phase === "playing" && relayPlayerId.value === null);
const canActCurrentPlayer = computed(() => !relayRoom || (lobbyState.value.phase === "playing"
  && relayPlayerId.value === currentPlayer.value?.id));
const stepSecondsRemaining = computed(() => remainingTurnSeconds(matchClock.value, game.value.turn.phase, clockNow.value));
const matchSecondsRemaining = computed(() => remainingMatchSeconds(matchClock.value, lobbyState.value.settings, clockNow.value));
const stepClockLabel = computed(() => isMatchFinished.value
  ? "已停止"
  : formatClock(stepSecondsRemaining.value, stepSecondsRemaining.value === null));
const matchClockLabel = computed(() => isMatchFinished.value
  ? "已停止"
  : formatClock(matchSecondsRemaining.value, lobbyState.value.settings.matchTimeMinutes === 0));
const notationTuples = computed(() => notation.value.map((entry) => entry.tuple));
const notationText = computed(() => JSON.stringify(notationTuples.value));
const latestContinuation = computed(() => [...notation.value].reverse().find((entry) => entry.continuation)?.continuation);
/** Only blue-outlined cells are valid commands for the selected unit. */
const legalActionCellIds = computed<readonly CellId[]>(() => selectedUnit.value
  ? getLegalActionDestinationIds(game.value, selectedUnit.value.id, installedTerrainCatalog, coreUnitCatalog)
  : []);

function resolveRelayEndpoint(): string {
  // A query override keeps the static preview deployable without bundling a
  // secret or rebuilding the client for each server address: `?relay=ws...`.
  const configured = new URLSearchParams(window.location.search).get("relay");
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  if (window.location.port === "5173") return `${protocol}://${window.location.hostname}:2567`;
  if (window.location.pathname.startsWith("/numeral-lord-play-stage/")) {
    return `${protocol}://${window.location.host}/numeral-lord-stage`;
  }
  return `${protocol}://${window.location.host}/numeral-lord`;
}

function formatClock(seconds: number | null, unlimited: boolean): string {
  if (unlimited || seconds === null) return "不限时";
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function broadcastSnapshot(resolution?: {
  readonly resolvedCommandId: string;
  readonly continuation?: NonNullable<ActionOutcome["continuation"]>;
  readonly errorMessage?: string;
}): void {
  if (relayRoom && relayIsHost.value && lobbyState.value.phase === "playing") {
    logConnection("snapshot.sent", { sequence: game.value.sequence, phase: game.value.turn.phase });
    relayRoom.send("host-snapshot", {
      state: game.value,
      clock: matchClock.value,
      hostSentAtEpochMs: Date.now(),
      ...resolution
    });
  }
}

function submitRemoteCommand(command: GameCommand): boolean {
  if (!relayRoom || relayIsHost.value) return false;
  if (command.type === "move-unit" || command.type === "attack-unit") {
    const sourceCellId = selectedSourceCellId.value ?? game.value.units[command.unitId]?.cellId;
    if (sourceCellId) {
      pendingRemoteAction = {
        commandId: command.commandId,
        expectedSequence: command.expectedSequence,
        sourceCellId,
        targetCellId: command.type === "move-unit" ? command.destinationId : command.targetId,
        includeSourceClick: selectedByUser.value
      };
    }
  }
  relayRoom.send("player-intent", { playerId: relayPlayerId.value, command });
  notice.value = "操作已发送给房主，等待权威棋盘同步。";
  clearSelectionSilently();
  return true;
}

function canCurrentClientAct(): boolean {
  if (!relayRoom) return true;
  // The interval may not have fired yet when a click lands exactly at the
  // deadline. Resolve the timeout before accepting a host-side command.
  if (relayIsHost.value && clockExpiration(matchClock.value, game.value.turn.phase, lobbyState.value.settings, Date.now())) {
    tickClocks();
    return false;
  }
  if (lobbyState.value.phase !== "playing") {
    notice.value = "对局尚未开始，请先在准备房间就绪。";
    return false;
  }
  if (!relayPlayerId.value) {
    notice.value = "你当前在观战位，不能操作棋盘。";
    clearSelectionSilently();
    return false;
  }
  if (relayPlayerId.value !== currentPlayer.value?.id) {
    notice.value = "现在轮到另一位玩家，等待对方行动。";
    clearSelectionSilently();
    return false;
  }
  return true;
}

function cancelReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function scheduleReconnect(roomId: string, attempt: number): void {
  cancelReconnect();
  if (attempt > 5) {
    logConnection("reconnect.exhausted", { roomId });
    relayStatus.value = "连接已断开";
    notice.value = "自动重连未成功。房间可能已失效；请用房间号手动重试，或返回主页新建房间。";
    return;
  }
  const delay = [800, 1_600, 3_000, 5_000, 8_000][attempt - 1]!;
  logConnection("reconnect.scheduled", { roomId, attempt, delayMs: delay });
  relayStatus.value = "连接已断开";
  notice.value = `连接中断，${Math.ceil(delay / 1_000)} 秒后自动重连（${attempt}/5）…`;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (relayRoom || page.value !== "rooms") return;
    void connectRelay("join", roomId, attempt);
  }, delay);
}

async function connectRelay(mode: "create" | "join", requestedRoomId?: string, reconnectAttempt = 0): Promise<void> {
  if (relayRoom) return;
  cancelReconnect();
  const attempt = ++connectionAttempt;
  relayEndpoint = resolveRelayEndpoint();
  logConnection("connect.begin", { mode, roomId: requestedRoomId ?? null, retry: reconnectAttempt, endpoint: relayEndpointForLog(relayEndpoint) });
  relayStatus.value = "连接中…";
  lobbyError.value = "";
  try {
    const client = new Client(relayEndpoint);
    const options = {
      name: playerName.value,
      accountId: relayAccountKey,
      installedModIds: installedTerrainMods.map((mod) => mod.id)
    };
    const room = mode === "join" && requestedRoomId
      ? await client.joinById(requestedRoomId, options)
      : await client.create("pvp", options);
    if (attempt !== connectionAttempt) {
      void room.leave();
      return;
    }
    relayRoom = room;
    cancelReconnect();
    logConnection("connect.joined", { roomId: room.roomId, retry: reconnectAttempt });
    relaySessionId.value = room.sessionId;
    relayRoomId.value = room.roomId;
    roomIdInput.value = room.roomId;
    relayStatus.value = "已连接";
    const inviteUrl = new URL(window.location.href);
    inviteUrl.searchParams.set("room", room.roomId);
    window.history.replaceState(null, "", inviteUrl);
    room.onMessage("room-role", (payload: LobbyRolePayload) => {
      relayPlayerId.value = payload.playerId ?? null;
      relayAccountId.value = payload.accountId ?? null;
      relayIsHost.value = Boolean(payload.isHost);
      logConnection("room.role", { host: payload.isHost, playerId: payload.playerId ?? null, seat: payload.seat });
    });
    room.onMessage("room-state", (payload: LobbyRoomState) => {
      const wasPlaying = lobbyState.value.phase === "playing";
      lobbyState.value = payload;
      logConnection("room.state", { phase: payload.phase, members: payload.members.length, map: payload.mapName });
      lobbyError.value = "";
      if (payload.phase === "lobby") {
        hasLiveSnapshot.value = false;
        pendingRemoteAction = undefined;
        matchClock.value = null;
        expiredStepSequence = null;
        lastSnapshotSyncAt = 0;
        notation.value = [];
        clearReinforcementHold();
        clearSelectionSilently();
        notice.value = wasPlaying
          ? "房主已结束对局，全员返回准备房间。请重新准备。"
          : "选择参战位置并准备；只要参战玩家全部准备即可开始。";
      }
    });
    room.onMessage("lobby-error", (payload: { message?: string }) => {
      lobbyError.value = payload.message ?? "房间设置没有生效。";
      notice.value = lobbyError.value;
      logConnection("room.error", { message: lobbyError.value.slice(0, 250) });
    });
    room.onMessage("match-start", (payload: MatchStartPayload) => {
      logConnection("match.start", { assignments: payload.assignments.length, roomId: room.roomId });
      startLobbyMatch(payload);
    });
    room.onMessage("snapshot-request", () => {
      logConnection("snapshot.requested", { host: relayIsHost.value, sequence: game.value.sequence });
      if (relayIsHost.value) broadcastSnapshot();
    });
    room.onMessage("room-host", (payload: { sessionId?: string }) => {
      relayIsHost.value = payload.sessionId === room.sessionId;
      logConnection("room.host", { selfIsHost: relayIsHost.value, hasSnapshot: hasLiveSnapshot.value });
      if (relayIsHost.value && lobbyState.value.phase === "playing") broadcastSnapshot();
    });
    room.onMessage("player-intent", (payload: { playerId?: string; command?: GameCommand }) => {
      if (!relayIsHost.value || !payload.command) return;
      tickClocks();
      const active = currentPlayer.value;
      if (!active || payload.command.actorId !== active.id) return;
      const result = applyCommand(game.value, payload.command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
      if (!applyResult(result, false, payload.command.commandId) && !result.accepted) {
        broadcastSnapshot({ resolvedCommandId: payload.command.commandId, errorMessage: result.error.message });
      }
    });
    room.onMessage("host-snapshot", (payload: {
      state?: typeof game.value;
      clock?: MatchClockSnapshot;
      serverSentAtEpochMs?: number;
      resolvedCommandId?: string;
      continuation?: NonNullable<ActionOutcome["continuation"]>;
      errorMessage?: string;
      handoff?: boolean;
    }) => {
      if (!payload.state || (relayIsHost.value && payload.handoff !== true)) return;
      if (missingLocalModIds.value.length > 0) {
        logConnection("snapshot.missing-mods", { missingModIds: missingLocalModIds.value });
        notice.value = `当前设备缺少地块 Mod：${missingLocalModIds.value.join("、")}。安装后才能进入对局。`;
        return;
      }
      logConnection("snapshot.received", {
        sequence: payload.state.sequence,
        handoff: payload.handoff === true,
        selfIsHost: relayIsHost.value,
        previousSequence: game.value.sequence
      });
      // A promoted/reconnected host must adopt the server's last accepted
      // snapshot before it starts broadcasting. Ordinary echoes are ignored.
      if (payload.handoff && hasLiveSnapshot.value && payload.state.sequence < game.value.sequence) {
        if (relayIsHost.value) broadcastSnapshot();
        return;
      }
      game.value = payload.state;
      hasLiveSnapshot.value = true;
      lastSnapshotSyncAt = 0;
      const receivedAt = Date.now();
      matchClock.value = payload.clock
        ? typeof payload.serverSentAtEpochMs === "number"
          ? rebaseMatchClock(payload.clock, payload.serverSentAtEpochMs, receivedAt)
          : payload.clock
        : startMatchClocks(payload.state, lobbyState.value.settings, receivedAt);
      expiredStepSequence = null;
      const pending = pendingRemoteAction;
      if (pending && payload.resolvedCommandId === pending.commandId) {
        pendingRemoteAction = undefined;
        if (payload.errorMessage) {
          clearSelectionSilently();
          notice.value = payload.errorMessage;
        } else {
          recordAction(pending.sourceCellId, pending.targetCellId, payload.continuation?.cellId, pending.includeSourceClick);
          continueActionAt(payload.continuation?.unitId ?? null);
          if (!payload.continuation) notice.value = "行动完成。";
        }
      } else {
        if (pending && payload.state.sequence > pending.expectedSequence) pendingRemoteAction = undefined;
        clearSelectionSilently();
        notice.value = "已收到房主的最新棋盘。";
      }
      if (payload.handoff && relayIsHost.value) broadcastSnapshot();
    });
    room.onLeave((code) => {
      if (relayRoom !== room) return;
      logConnection("socket.closed", {
        code, roomId: room.roomId, phase: lobbyState.value.phase,
        selfIsHost: relayIsHost.value, sequence: game.value.sequence,
        online: navigator.onLine, visibility: document.visibilityState
      });
      console.warn("PvP room socket closed", { code, roomId: room.roomId });
      relayStatus.value = "连接已断开";
      relayRoom = undefined;
      relayRoomId.value = "";
      relayPlayerId.value = null;
      relayAccountId.value = null;
      relaySessionId.value = null;
      relayIsHost.value = false;
      hasLiveSnapshot.value = false;
      pendingRemoteAction = undefined;
      scheduleReconnect(room.roomId, 1);
    });
    room.onError((code, message) => {
      logConnection("socket.error", { code, message: String(message).slice(0, 250), roomId: room.roomId });
    });
    // onJoin can emit identity before browser handlers are installed. This
    // explicit handshake makes first load, late spectating and refresh safe.
    logConnection("snapshot.sync-request", { roomId: room.roomId, initial: true });
    room.send("room-sync", {});
    lastSnapshotSyncAt = Date.now();
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    logConnection("connect.failed", {
      mode, roomId: requestedRoomId ?? null, retry: reconnectAttempt,
      error: error instanceof Error ? error.message.slice(0, 250) : String(error).slice(0, 250)
    });
    relayStatus.value = "连接失败";
    notice.value = `PvP 房间连接失败：${error instanceof Error ? error.message : "请检查后端地址"}`;
    if (reconnectAttempt > 0 && requestedRoomId) scheduleReconnect(requestedRoomId, reconnectAttempt + 1);
  }
}

function startFromHome(): void {
  const normalizedName = playerName.value.trim().slice(0, 24) || randomPlayerName();
  playerName.value = normalizedName;
  localStorage.setItem(PLAYER_NAME_STORAGE_KEY, normalizedName);
  page.value = "rooms";
}

function updatePlayerName(value: string): void {
  playerName.value = value;
  const normalizedName = value.trim().slice(0, 24);
  if (normalizedName) localStorage.setItem(PLAYER_NAME_STORAGE_KEY, normalizedName);
}

function openMapLibrary(): void {
  page.value = "maps";
}

function openWorkshop(): void {
  page.value = "workshop";
  if (!workshopClient) {
    workshopClient = new WorkshopClient(resolveRelayEndpoint(), {
      catalog: (catalog) => {
        remoteMapWorks.value = catalog.maps.map((entry) => ({ ...entry }));
        const installedIds = new Set(installedTerrainMods.map((mod) => mod.id));
        remoteTerrainMods.value = catalog.terrainMods.map((entry) => ({
          ...entry,
          installed: installedIds.has(entry.modId)
        }));
      },
      detail: (detail) => {
        if (detail.kind === "map") {
          remoteMapWorks.value = remoteMapWorks.value.map((entry) => entry.id === detail.entry.id
            ? { ...entry, ...detail.entry } : entry);
        } else {
          remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.id === detail.entry.id
            ? { ...entry, ...detail.entry } : entry);
        }
      },
      published: (published) => {
        workshopWorking.value = false;
        workshopActionError.value = false;
        workshopActionMessage.value = published.kind === "map" ? "地图码已发布到创意工坊。" : "地块 Mod 已发布供其他玩家预览。";
        workshopClient?.requestList();
      },
      error: (message) => {
        workshopWorking.value = false;
        workshopActionError.value = true;
        workshopActionMessage.value = message;
      },
      status: (status) => { workshopStatus.value = status; }
    });
  }
  const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
  void workshopClient.connect({ name });
}

function selectWorkshopMap(id: string): void {
  if (id === builtInMapWork.id) return;
  const entry = remoteMapWorks.value.find((candidate) => candidate.id === id);
  if (entry && !entry.code) workshopClient?.requestDetail("map", id);
}

function selectWorkshopTerrainMod(id: string): void {
  if (id === builtInTerrainMod.id) return;
  const entry = remoteTerrainMods.value.find((candidate) => candidate.id === id);
  if (entry && !entry.sourceFiles) workshopClient?.requestDetail("terrain-mod", id);
}

function saveWorkshopMap(code: string): void {
  try {
    const next = addMapToLibrary(configuredMaps.value, code);
    configuredMaps.value = next;
    selectedMapLibraryId.value = next.at(-1)?.definition.id ?? DEFAULT_MAP_DEFINITION.id;
    workshopActionError.value = false;
    workshopActionMessage.value = `「${next.at(-1)?.definition.name ?? "地图"}」已保存到我的地图配置。`;
  } catch (error) {
    workshopActionError.value = true;
    workshopActionMessage.value = error instanceof Error ? error.message : "地图码无法保存。";
  }
}

function publishWorkshopMap(entry: MapSubmission): void {
  if (!workshopPublishingEnabled) return;
  if (!workshopClient?.publishMap(entry)) return;
  workshopWorking.value = true;
  workshopActionMessage.value = "正在发布地图码…";
  workshopActionError.value = false;
}

function publishWorkshopTerrainMod(entry: TerrainModSubmission): void {
  if (!workshopPublishingEnabled) return;
  if (!workshopClient?.publishTerrainMod(entry)) return;
  workshopWorking.value = true;
  workshopActionMessage.value = "正在发布地块 Mod…";
  workshopActionError.value = false;
}

function addConfiguredMap(rawCode: string): void {
  try {
    const next = addMapToLibrary(configuredMaps.value, rawCode);
    configuredMaps.value = next;
    selectedMapLibraryId.value = next.at(-1)?.definition.id ?? DEFAULT_MAP_DEFINITION.id;
    mapActionMessage.value = `「${next.at(-1)?.definition.name ?? "地图"}」已保存到本机。`;
    mapActionError.value = false;
    mapLibraryRef.value?.clearCodeDraft();
  } catch (error) {
    mapActionMessage.value = error instanceof Error ? error.message : "地图码无法导入。";
    mapActionError.value = true;
  }
}

function removeConfiguredMap(id: string): void {
  const removed = configuredMaps.value.find((map) => map.definition.id === id);
  configuredMaps.value = removeMapFromLibrary(configuredMaps.value, id);
  selectedMapLibraryId.value = DEFAULT_MAP_DEFINITION.id;
  mapActionMessage.value = removed ? `「${removed.definition.name}」已从本机移除。` : "";
  mapActionError.value = false;
}

function requestHome(): void {
  if (relayRoom) {
    leaveDialogOpen.value = true;
    return;
  }
  void leaveToHome();
}

async function leaveToHome(): Promise<void> {
  leaveDialogOpen.value = false;
  connectionAttempt += 1;
  cancelReconnect();
  if (relayRoom) logConnection("room.left-by-user", { roomId: relayRoom.roomId });
  const room = relayRoom;
  relayRoom = undefined;
  const workshop = workshopClient;
  workshopClient = undefined;
  page.value = "home";
  relayStatus.value = "未连接";
  relayRoomId.value = "";
  roomIdInput.value = "";
  relayPlayerId.value = null;
  relayAccountId.value = null;
  relaySessionId.value = null;
  relayIsHost.value = false;
  hasLiveSnapshot.value = false;
  lastSnapshotSyncAt = 0;
  lobbyError.value = "";
  pendingRemoteAction = undefined;
  matchClock.value = null;
  clearSelectionSilently();
  clearReinforcementHold();
  notationDialogOpen.value = false;
  lobbyState.value = {
    phase: "lobby",
    mapPlayerCount: initialMapPlayerCount,
    mapCode: DEFAULT_MAP_CODE,
    mapName: DEFAULT_MAP_DEFINITION.name,
    requiredTerrainModIds: DEFAULT_MAP_DEFINITION.requiredTerrainModIds,
    roomModSettings: {},
    settings: { ...DEFAULT_LOBBY_SETTINGS },
    members: []
  };
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState(null, "", url);
  if (room) {
    try { await room.leave(); } catch { /* The local page has already left. */ }
  }
  if (workshop) await workshop.leave();
}

function createRoom(): void {
  void connectRelay("create");
}

function joinRoom(): void {
  const roomId = roomIdInput.value.trim();
  if (!roomId) {
    notice.value = "请输入房间号。";
    return;
  }
  void connectRelay("join", roomId);
}

function startLobbyMatch(payload: MatchStartPayload): void {
  pendingRemoteAction = undefined;
  const assignment = payload.assignments.find((candidate) => candidate.sessionId === relaySessionId.value);
  relayPlayerId.value = assignment?.playerId ?? null;
  if (missingLocalModIds.value.length > 0) {
    hasLiveSnapshot.value = false;
    notice.value = `当前设备缺少地块 Mod：${missingLocalModIds.value.join("、")}。安装后才能进入对局。`;
    logConnection("match.missing-mods", { missingModIds: missingLocalModIds.value });
    return;
  }
  try { game.value = createMatchFromMapCode(payload.mapCode, {
    ...installedMapCatalogs,
    activePlayerIds: payload.assignments.map((candidate) => candidate.playerId as PlayerId),
    playerDisplayNames: Object.fromEntries(payload.assignments.map((candidate) => [
      candidate.playerId,
      candidate.displayName ?? lobbyState.value.members.find((member) => member.sessionId === candidate.sessionId)?.displayName ?? `玩家 ${candidate.seat}`
    ])),
    friendlyFire: payload.settings.friendlyFire,
    roomModSettings: payload.roomModSettings ?? {}
  }); } catch (error) {
    hasLiveSnapshot.value = false;
    notice.value = error instanceof Error ? error.message : "当前地图内容无法加载。";
    logConnection("match.load-failed", { message: notice.value });
    return;
  }
  hasLiveSnapshot.value = true;
  matchClock.value = startMatchClocks(game.value, payload.settings, Date.now());
  expiredStepSequence = null;
  notation.value = [];
  clearSelectionSilently();
  notice.value = assignment
    ? `对局开始：你被分配到 ${assignment.seat} 号位。`
    : "对局开始：你正在观战。";
  if (relayIsHost.value) broadcastSnapshot();
}

function sendLobbyReady(ready: boolean): void {
  relayRoom?.send("lobby-ready", { ready });
}

function sendLobbySeat(seat: number | null): void {
  relayRoom?.send("lobby-seat", { seat });
}

function sendLobbyParticipation(participating: boolean): void {
  relayRoom?.send("lobby-participation", { participating });
}

function sendLobbySettings(settings: Record<string, boolean | number>): void {
  relayRoom?.send("lobby-settings", settings);
}

function sendLobbyModSettings(modSettings: LobbyModSettings): void {
  relayRoom?.send("lobby-mod-settings", { modSettings });
}

function sendLobbyAssignment(payload: { sessionId: string; seat?: number | null; participating?: boolean }): void {
  relayRoom?.send("lobby-assign", payload);
}

function sendLobbyMap(mapCode: string): void {
  relayRoom?.send("lobby-map", { mapCode });
}

function onCellClick(cellId: CellId): void {
  if (!canCurrentClientAct()) return;
  if (isReinforcementPhase.value) return;
  if (!isActionPhase.value) return;
  const cell = game.value.cells[cellId];
  const clickedUnit = cell?.unitId ? game.value.units[cell.unitId] : undefined;
  const active = currentPlayer.value;
  if (!cell || !active) return;
  const actingUnit = selectedUnit.value;
  if (!actingUnit) {
    selectOwnUnit(clickedUnit?.id ?? null);
    return;
  }
  // Once a unit is selected, a board click has only two meanings:
  // - a blue-outlined legal cell executes the action;
  // - every other rendered board cell cancels the current selection.
  //
  // In particular, do not silently switch from friendly unit A to B here.
  // With friendly fire enabled B may also be a legal attack target, so mixing
  // "switch selection" and "attack target" in one click is ambiguous. The
  // player must first cancel on a non-target cell, then explicitly select B.
  if (!legalActionCellIds.value.includes(cellId)) {
    clearSelection();
    return;
  }
  // Capture both values before applying the command. A later friendly-fire
  // click cannot reinterpret a cancelled selection as the action source.
  const actingUnitId = actingUnit.id;
  const sourceCellId = selectedSourceCellId.value ?? actingUnit.cellId;
  const includeSourceClick = selectedByUser.value;
  const command: GameCommand = clickedUnit
    ? {
      type: "attack-unit", commandId: createCommandId(), actorId: active.id,
      expectedSequence: game.value.sequence, unitId: actingUnitId, targetId: cellId
    }
    : {
      type: "move-unit", commandId: createCommandId(), actorId: active.id,
      expectedSequence: game.value.sequence, unitId: actingUnitId, destinationId: cellId
    };
  if (submitRemoteCommand(command)) return;
  const result = applyCommand(game.value, command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
  if (!applyResult(result) || !result.accepted) return;
  recordAction(sourceCellId, cellId, result.outcome?.continuation?.cellId, includeSourceClick);
  continueActionAt(result.outcome?.continuation?.unitId ?? null);
}

function clearSelection(): void {
  selectedUnitId.value = null;
  selectedSourceCellId.value = null;
  selectedByUser.value = false;
  notice.value = "已取消选择。";
}

function selectOwnUnit(unitId: UnitId | null): void {
  const active = currentPlayer.value;
  const unit = unitId ? game.value.units[unitId] : undefined;
  if (!canCurrentClientAct()) return;
  if (!active || !unit || unit.ownerId !== active.id) {
    notice.value = "请选择当前玩家自己的单位。";
    return;
  }
  if (game.value.turn.exhaustedUnitIds.includes(unit.id)) {
    notice.value = "该单位本回合已经耗尽行动力。";
    return;
  }
  if (getLegalActionDestinationIds(game.value, unit.id, installedTerrainCatalog, coreUnitCatalog).length === 0) {
    notice.value = "该单位当前没有合法行动格；请在加点回合为通电兵投入点数。";
    return;
  }
  selectedUnitId.value = unit.id;
  selectedSourceCellId.value = unit.cellId;
  selectedByUser.value = true;
  notice.value = poweredUnitIds.value.includes(unit.id)
    ? "通电兵已选中：移动时会在原格留下 1 点。"
    : "游兵已选中：行动后点数减 1；原本只有 1 点时，本回合将失去行动力。";
}

function onCellPressStart(cellId: CellId): void {
  if (!canCurrentClientAct()) return;
  if (!isReinforcementPhase.value || !isReinforcementTarget(cellId)) return;
  clearReinforcementHold();
  const player = currentPlayer.value;
  if (!player) return;
  reinforcementHold = {
    cellId,
    startedAt: performance.now(),
    initialPoints: player.reinforcementPoints,
    isLongPress: false
  };
  reinforcementHold.delayTimer = setTimeout(() => {
    if (!reinforcementHold || reinforcementHold.cellId !== cellId) return;
    reinforcementHold.isLongPress = true;
    allocateHeldPoints();
  }, 320);
}

function onCellPressEnd(cellId: CellId): void {
  const hold = reinforcementHold;
  if (!hold || hold.cellId !== cellId) return;
  const wasLongPress = hold.isLongPress;
  clearReinforcementHold();
  if (!wasLongPress) allocatePointsAt(cellId, 1);
}

function isReinforcementTarget(cellId: CellId): boolean {
  const cell = game.value.cells[cellId];
  const unit = cell?.unitId ? game.value.units[cell.unitId] : undefined;
  const active = currentPlayer.value;
  return Boolean(unit && active && unit.ownerId === active.id
    && poweredUnitIds.value.includes(unit.id) && active.reinforcementPoints > 0);
}

function allocateHeldPoints(): void {
  const hold = reinforcementHold;
  const player = currentPlayer.value;
  if (!hold || !player || !isReinforcementPhase.value || !isReinforcementTarget(hold.cellId)) return;

  const elapsed = Math.min(performance.now() - hold.startedAt, 3_000);
  // Cubic ease-in means allocation starts gently, then visibly accelerates.
  const shouldHaveSpent = Math.ceil(hold.initialPoints * (elapsed / 3_000) ** 3);
  const spent = hold.initialPoints - player.reinforcementPoints;
  const added = allocatePointsAt(hold.cellId, Math.max(1, shouldHaveSpent - spent), true);

  if (!isReinforcementPhase.value) {
    clearReinforcementHold();
    return;
  }

  if (!reinforcementHold || currentPlayer.value?.reinforcementPoints === 0 || elapsed >= 3_000) {
    if (currentPlayer.value?.reinforcementPoints) {
      allocatePointsAt(hold.cellId, currentPlayer.value.reinforcementPoints, true);
    }
    notice.value = "长按加点完成。";
    return;
  }
  if (added > 0) notice.value = "持续加点中：按住越久越快，3 秒内会投入全部可用点数。";
  hold.tickTimer = setTimeout(allocateHeldPoints, 55);
}

function allocatePointsAt(cellId: CellId, requested: number, quiet = false): number {
  const active = currentPlayer.value;
  const cell = game.value.cells[cellId];
  const unit = cell?.unitId ? game.value.units[cell.unitId] : undefined;
  if (!active || !unit) return 0;

  let completed = 0;
  for (let index = 0; index < requested; index += 1) {
    const command: GameCommand = {
      type: "reinforce-unit", commandId: createCommandId(), actorId: active.id,
      expectedSequence: game.value.sequence, unitId: unit.id
    };
    if (submitRemoteCommand(command)) {
      completed += 1;
      break;
    }
    const result = applyCommand(game.value, command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
    if (!applyResult(result, quiet) || !result.accepted) break;
    completed += 1;
  }
  if (completed > 0) recordReinforcement(cellId, completed);
  if (completed > 0 && !quiet) {
    notice.value = isActionPhase.value
      ? `点数已用完，自动轮到 ${currentPlayer.value?.displayName ?? "下一位玩家"} 行动。`
      : `已向该单位投入 ${completed} 点。`;
  }
  return completed;
}

function endActionPhase(): void {
  if (!canCurrentClientAct()) return;
  const active = currentPlayer.value;
  if (!active) return;
  const command: GameCommand = {
    type: "end-action-phase", commandId: createCommandId(), actorId: active.id,
    expectedSequence: game.value.sequence
  };
  if (submitRemoteCommand(command)) return;
  const result = applyCommand(game.value, command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
  if (applyResult(result) && result.accepted) {
    recordSpecial("action");
    clearSelectionSilently();
  }
}

function endReinforcementPhase(): void {
  if (!canCurrentClientAct()) return;
  const active = currentPlayer.value;
  if (!active) return;
  clearReinforcementHold();
  const command: GameCommand = {
    type: "end-reinforcement-phase", commandId: createCommandId(), actorId: active.id,
    expectedSequence: game.value.sequence
  };
  if (submitRemoteCommand(command)) return;
  const result = applyCommand(game.value, command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
  if (applyResult(result) && result.accepted) {
    recordSpecial("reinforcement");
    clearSelectionSilently();
  }
}

function resetMatch(): void {
  if (relayRoom) {
    if (!requestReturnToLobby(relayRoom, relayIsHost.value)) {
      notice.value = "只有房主可以结束联网对局。";
      return;
    }
    logConnection("match.return-to-lobby.requested", { roomId: relayRoom.roomId });
    notice.value = "正在等待房间返回准备阶段…";
    return;
  }
  clearReinforcementHold();
  pendingRemoteAction = undefined;
  const activePlayerIds = lobbyState.value.members
    .filter((member) => member.participating && member.seat !== null)
    .map((member) => `player-${member.seat}` as PlayerId);
  game.value = createMatchFromMapCode(lobbyState.value.mapCode, {
    ...installedMapCatalogs,
    ...(activePlayerIds.length > 0 ? { activePlayerIds } : {}),
    playerDisplayNames: Object.fromEntries(lobbyState.value.members
      .filter((member) => member.participating && member.seat !== null)
      .map((member) => [`player-${member.seat}`, member.displayName])),
    friendlyFire: lobbyState.value.settings.friendlyFire,
    roomModSettings: lobbyState.value.roomModSettings
  });
  matchClock.value = startMatchClocks(game.value, lobbyState.value.settings, Date.now());
  expiredStepSequence = null;
  broadcastSnapshot();
  clearSelectionSilently();
  notation.value = [];
  notice.value = "演示地图已重置，赤方先行动。";
}

function openNotationDialog(): void {
  notationCopyMessage.value = "";
  notationDialogOpen.value = true;
}

async function copyNotation(): Promise<void> {
  try {
    await navigator.clipboard.writeText(notationText.value);
    notationCopyMessage.value = "已复制当前棋谱。";
  } catch {
    notationCopyMessage.value = "浏览器未允许自动复制，请手动选择内容复制。";
  }
}

function continueActionAt(unitId: UnitId | null): void {
  if (!isActionPhase.value) {
    clearSelectionSilently();
    return;
  }
  if (!unitId || getLegalActionDestinationIds(game.value, unitId, installedTerrainCatalog, coreUnitCatalog).length === 0) {
    clearSelectionSilently();
    return;
  }
  selectedUnitId.value = unitId;
  selectedSourceCellId.value = game.value.units[unitId]?.cellId ?? null;
  selectedByUser.value = false;
  notice.value = "行动完成；该单位仍可行动，已自动继续选中。";
}

function clearSelectionSilently(): void {
  selectedUnitId.value = null;
  selectedSourceCellId.value = null;
  selectedByUser.value = false;
}

/** Selections are intentionally deferred until a move or attack succeeds. */
function recordAction(
  sourceCellId: CellId,
  targetCellId: CellId,
  continuationCellId: CellId | undefined,
  includeSourceClick: boolean
): void {
  const source = game.value.cells[sourceCellId]?.coordinate;
  const target = game.value.cells[targetCellId]?.coordinate;
  if (!source || !target) return;
  const continuation = continuationCellId ? game.value.cells[continuationCellId]?.coordinate : undefined;
  notation.value = appendActionNotation(notation.value, source, target, continuation, includeSourceClick);
}

function recordReinforcement(cellId: CellId, clicks: number): void {
  const coordinate = game.value.cells[cellId]?.coordinate;
  if (!coordinate) return;
  notation.value = appendReinforcementNotation(notation.value, coordinate, clicks);
}

function recordSpecial(phase: "action" | "reinforcement"): void {
  notation.value = appendPhaseEndNotation(notation.value, phase);
}

function clearReinforcementHold(): void {
  if (!reinforcementHold) return;
  if (reinforcementHold.delayTimer) clearTimeout(reinforcementHold.delayTimer);
  if (reinforcementHold.tickTimer) clearTimeout(reinforcementHold.tickTimer);
  reinforcementHold = undefined;
}

function applyResult(result: CommandResult, quiet = false, resolvedCommandId?: string): boolean {
  if (!result.accepted) {
    if (!quiet) notice.value = result.error.message;
    return false;
  }
  if (pendingRemoteAction) {
    notice.value = "上一行动正在同步，请稍候。";
    return false;
  }
  const before = game.value;
  const now = Date.now();
  matchClock.value = advanceMatchClocks(
    matchClock.value ?? startMatchClocks(before, lobbyState.value.settings, now),
    before,
    result.state,
    lobbyState.value.settings,
    now
  );
  game.value = result.state;
  expiredStepSequence = null;
  broadcastSnapshot(resolvedCommandId
    ? { resolvedCommandId, ...(result.outcome?.continuation ? { continuation: result.outcome.continuation } : {}) }
    : undefined);
  if (!quiet) notice.value = result.events.at(-1)?.message ?? "操作完成。";
  return true;
}

function expireCurrentPhase(phase: "action" | "reinforcement"): boolean {
  const active = currentPlayer.value;
  if (!active || game.value.turn.phase !== phase) return false;
  const command: GameCommand = {
    type: phase === "action" ? "end-action-phase" : "end-reinforcement-phase",
    commandId: createCommandId(),
    actorId: active.id,
    expectedSequence: game.value.sequence
  };
  const result = applyCommand(game.value, command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
  if (!applyResult(result, true) || !result.accepted) return false;
  recordSpecial(phase);
  clearSelectionSilently();
  return true;
}

function tickClocks(): void {
  clockNow.value = Date.now();
  // A late joiner must not wait forever when its first snapshot request raced
  // with a host handoff or an empty server cache.
  if (relayRoom && lobbyState.value.phase === "playing" && !hasLiveSnapshot.value
    && clockNow.value - lastSnapshotSyncAt >= 2_000) {
    logConnection("snapshot.sync-request", { roomId: relayRoom.roomId, initial: false, sequence: game.value.sequence });
    relayRoom.send("room-sync", {});
    lastSnapshotSyncAt = clockNow.value;
  }
  if (!relayRoom || !relayIsHost.value || lobbyState.value.phase !== "playing" || isMatchFinished.value) return;
  const expiration = clockExpiration(matchClock.value, game.value.turn.phase, lobbyState.value.settings, clockNow.value);
  if (!expiration || expiredStepSequence === game.value.sequence) return;
  expiredStepSequence = game.value.sequence;
  const timedOutName = currentPlayer.value?.displayName ?? "当前玩家";
  if (expiration === "match") {
    if (isActionPhase.value && !expireCurrentPhase("action")) return;
    if (isReinforcementPhase.value) expireCurrentPhase("reinforcement");
    notice.value = `${timedOutName} 的局时耗尽，已自动结束本回合；之后该玩家每回合仍有 2 秒行动时间。`;
    return;
  }
  const phase = isActionPhase.value ? "action" : isReinforcementPhase.value ? "reinforcement" : null;
  if (phase && expireCurrentPhase(phase)) notice.value = phase === "action"
    ? "步时用尽，已自动进入加点阶段，至少保留 2 秒。"
    : "步时用尽，已自动结束加点并轮到下一位玩家。";
}

function logBrowserConnectionState(): void {
  logConnection("browser.connection", { online: navigator.onLine, visibility: document.visibilityState });
}

function logBrowserError(event: ErrorEvent): void {
  logConnection("browser.error", { message: event.message.slice(0, 250) });
}

function logUnhandledRejection(event: PromiseRejectionEvent): void {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  logConnection("browser.unhandled-rejection", { message: message.slice(0, 250) });
}

onMounted(() => {
  logConnection("page.loaded", { path: window.location.pathname, invitedRoom: Boolean(invitedRoomId), online: navigator.onLine });
  window.addEventListener("online", logBrowserConnectionState);
  window.addEventListener("offline", logBrowserConnectionState);
  document.addEventListener("visibilitychange", logBrowserConnectionState);
  window.addEventListener("error", logBrowserError);
  window.addEventListener("unhandledrejection", logUnhandledRejection);
  clockTimer = setInterval(tickClocks, 250);
  if (invitedRoomId) {
    roomIdInput.value = invitedRoomId;
    void connectRelay("join", invitedRoomId);
  }
});
onBeforeUnmount(() => {
  clearReinforcementHold();
  cancelReconnect();
  window.removeEventListener("online", logBrowserConnectionState);
  window.removeEventListener("offline", logBrowserConnectionState);
  document.removeEventListener("visibilitychange", logBrowserConnectionState);
  window.removeEventListener("error", logBrowserError);
  window.removeEventListener("unhandledrejection", logUnhandledRejection);
  if (clockTimer) clearInterval(clockTimer);
  relayRoom?.leave();
  void workshopClient?.leave();
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-block">
        <button v-if="!showHome && !showMaps && !showWorkshop" class="topbar-back" @click="requestHome"><span aria-hidden="true">←</span> 返回主页</button>
        <p class="eyebrow">NUMERAL LORD · EARLY ACCESS</p><h1>Numeral Lord</h1>
      </div>
      <div class="topbar-meta">
        <div v-if="showHome" class="turn-pill"><span class="turn-dot" />选择入口，开启对局</div>
        <div v-else-if="showMaps" class="turn-pill"><span class="turn-dot" />地图配置 · {{ configuredMaps.length }} 张可用</div>
        <div v-else-if="showWorkshop" class="turn-pill"><span class="turn-dot" />创意工坊 · {{ workshopStatus === 'connected' ? '已连接' : workshopStatus === 'connecting' ? '连接中' : '离线预览' }}</div>
        <div v-else-if="showRoomEntry" class="turn-pill"><span class="turn-dot" />创建房间或用房间号加入</div>
        <div v-else-if="relayStatus === '连接中…'" class="turn-pill"><span class="turn-dot" />正在连接 PvP 房间…</div>
        <div v-else-if="showLobby" class="turn-pill"><span class="turn-dot" />准备房间 · 地图 {{ lobbyState.mapPlayerCount }} 个玩家位</div>
        <div v-else-if="showGameLoading" class="turn-pill"><span class="turn-dot" />正在同步对局棋盘…</div>
        <div v-else class="turn-pill" :style="{ '--player-color': currentPlayer?.color }"><span class="turn-dot" />第 {{ game.turn.round }} 回合 · {{ currentPlayer?.displayName }} · {{ phaseLabel }} · 步 {{ stepClockLabel }} · 局 {{ matchClockLabel }}</div>
        <div v-if="!showHome && !showMaps && !showWorkshop" class="network-pill" :class="{ connected: relayStatus === '已连接' }">PvP {{ relayStatus }}<span v-if="relayRoomId"> · 房间 {{ relayRoomId }}</span><span v-if="relayIsHost"> · 房主</span><span v-else-if="isSpectator"> · 观战</span><span v-else-if="relayPlayerId"> · {{ relayPlayerId }}</span></div>
        <button v-if="!showHome && !showMaps && !showWorkshop" class="connection-log-trigger" type="button" @click="connectionLogCopyMessage = ''; connectionLogDialogOpen = true">连接日志</button>
      </div>
    </header>

    <HomeScreen
      v-if="showHome"
      :name="playerName"
      @update:name="updatePlayerName"
      @start="startFromHome"
      @maps="openMapLibrary"
      @workshop="openWorkshop"
    />

    <MapLibrary
      v-else-if="showMaps"
      ref="mapLibraryRef"
      :maps="configuredMaps"
      :selected-id="selectedMapLibraryId"
      :action-message="mapActionMessage"
      :action-error="mapActionError"
      @back="requestHome"
      @select="selectedMapLibraryId = $event"
      @add="addConfiguredMap"
      @remove="removeConfiguredMap"
    />

    <WorkshopPanel
      v-else-if="showWorkshop"
      :terrain-mods="workshopTerrainMods"
      :map-entries="workshopMapWorks"
      :saved-map-ids="configuredMaps.map((map) => map.definition.id)"
      :action-message="workshopActionMessage"
      :action-error="workshopActionError"
      :working="workshopWorking"
      :publishing-enabled="workshopPublishingEnabled"
      @back="requestHome"
      @select-map="selectWorkshopMap"
      @select-terrain-mod="selectWorkshopTerrainMod"
      @save-map="saveWorkshopMap"
      @publish-map="publishWorkshopMap"
      @publish-terrain-mod="publishWorkshopTerrainMod"
    />

    <section v-else-if="showRoomEntry" class="room-hub">
      <div class="room-hub-heading">
        <p class="entry-kicker">PLAY ONLINE</p>
        <h2>准备一场对局</h2>
        <p>创建房间后可选择地图、设置规则和座位；已有房间号可直接加入，开局后的房间也允许观战。</p>
      </div>
      <div class="room-hub-grid">
        <article class="room-option create-option"><div class="option-index">01 / HOST</div><h3>创建房间</h3><p>由你选择地图与房间规则，再把房间号发给朋友。</p><button class="primary" @click="createRoom">创建新房间 <span aria-hidden="true">→</span></button></article>
        <article class="room-option join-option"><div class="option-index">02 / JOIN</div><h3>加入房间</h3><p>输入好友分享的房间号，随时加入准备房间或观战。</p><div class="join-row"><input v-model.trim="roomIdInput" type="text" autocomplete="off" placeholder="输入房间号" aria-label="房间号" @keyup.enter="joinRoom" /><button class="secondary" @click="joinRoom">加入 <span aria-hidden="true">→</span></button></div></article>
      </div>
      <div class="room-hub-foot"><span>当前名字：<strong>{{ playerName }}</strong></span><span>{{ configuredMaps.length }} 张本机地图可供房主选择</span></div>
      <p v-if="relayStatus === '连接失败' || relayStatus === '连接已断开'" class="entry-error" role="alert">{{ notice }} <button v-if="roomIdInput" @click="joinRoom">重试加入</button></p>
    </section>

    <section v-else-if="relayStatus === '连接中…'" class="room-entry connecting-card">
      <div class="entry-copy"><p class="entry-kicker">CONNECTING</p><h2>正在进入房间…</h2><p>正在同步成员、地图玩家位和当前棋盘。</p></div>
    </section>

    <LobbyPanel
      v-else-if="showLobby"
      :room="lobbyState"
      :room-id="relayRoomId"
      :self-session-id="relaySessionId"
      :preview-state="lobbyPreviewState"
      :preview-powered-unit-ids="lobbyPreviewPoweredUnitIds"
      :available-maps="configuredMaps"
      :error-message="lobbyError"
      @ready="sendLobbyReady"
      @seat="sendLobbySeat"
      @participation="sendLobbyParticipation"
      @settings="sendLobbySettings"
      @mod-settings="sendLobbyModSettings"
      @assign="sendLobbyAssignment"
      @map="sendLobbyMap"
    />

    <section v-if="showGameLoading" class="sync-panel" role="status"><span v-if="missingLocalModIds.length === 0" class="sync-spinner" /><h2>{{ missingLocalModIds.length ? '当前设备缺少地块 Mod' : '正在同步棋盘' }}</h2><p>{{ missingLocalModIds.length ? `此地图需要 ${missingLocalModIds.join('、')}。安装后才能进入对局。` : '正在从房间获取当前地图和最新对局状态；若房主刚断线，系统会自动重试。' }}</p></section>

    <section v-if="showGame && isMatchFinished" class="match-result" role="status" aria-live="polite">
      <div>
        <p class="result-kicker">MATCH FINISHED · 对局结束</p>
        <h2>{{ matchResultTitle }}</h2>
        <p>{{ matchResultMessage }}</p>
      </div>
      <button v-if="relayStatus !== '已连接' || relayIsHost" class="primary" @click="resetMatch">{{ relayRoomId ? '返回准备房间' : '重新开始演示对局' }}</button>
    </section>

    <section v-if="showGame" class="play-layout">
      <aside class="panel player-panel">
        <div class="panel-heading"><span>玩家状态</span><small>按座位依次行动</small></div>
        <article v-for="player in players" :key="player.id" class="player-card" :class="{ active: player.id === currentPlayer?.id }">
          <span class="player-color" :style="{ background: player.color }" />
          <div><strong>{{ player.displayName }}</strong><small>队伍 {{ player.teamId }} · 座位 {{ player.seat }}</small></div><b>{{ player.reinforcementPoints }} 点</b>
        </article>
        <div class="legend"><p><i class="legend-token powered" />通电兵：每回合 +1；1 点不能行动</p><p><i class="legend-token roaming" />游兵：行动 -1；1 点作最后一次行动后失活</p><p><i class="legend-token exhausted" />失活：本回合不能继续行动</p></div>
      </aside>

      <section class="board-wrap">
        <HexBoard
          :state="game"
          :selected-unit-id="selectedUnitId"
          :legal-action-cell-ids="legalActionCellIds"
          :actionable-unit-ids="actionableUnitIds"
          :powered-unit-ids="poweredUnitIds"
          @cell-click="onCellClick"
          @background-click="clearSelection"
          @cell-press-start="onCellPressStart"
          @cell-press-end="onCellPressEnd"
        />
        <p class="notice">{{ notice }}</p>
      </section>

      <aside class="panel action-panel">
        <div class="panel-heading"><span>对局操作</span><small>规则本地执行 · 房主广播</small></div>
        <div class="selected-info">
          <template v-if="isMatchFinished"><small>结算完成</small><strong>{{ matchResultTitle }}</strong><span>{{ matchResultMessage }}</span></template>
          <template v-else-if="isSpectator"><small>观战模式</small><strong>棋盘操作已锁定</strong><span>观战者会实时收到房主同步的棋盘，但不能提交移动、攻击或加点。</span></template>
          <template v-else-if="isReinforcementPhase"><small>加点回合</small><strong>剩余 {{ currentPlayer?.reinforcementPoints ?? 0 }} 点</strong><span>点击通电兵加 1 点；长按会逐渐加速，最多 3 秒投入全部点数。</span></template>
          <template v-else-if="selectedUnit"><small>已选单位</small><strong>{{ selectedIsPowered ? "通电兵" : "游兵" }} · {{ selectedUnit.strength }} 点</strong><span>点击青色描边的相邻格移动或攻击。</span></template>
          <template v-else><small>尚未选择单位</small><span>点击带扩散光圈的当前可行动单位。</span></template>
        </div>
        <button v-if="isActionPhase" class="secondary" :disabled="!canActCurrentPlayer" @click="endActionPhase">结束行动，进入加点</button>
        <button v-else-if="isReinforcementPhase" class="primary" :disabled="!canActCurrentPlayer" @click="endReinforcementPhase">结束加点，轮到下一位</button>
        <button v-if="relayStatus !== '已连接' || relayIsHost" class="ghost" @click="resetMatch">{{ relayRoomId ? '返回准备房间' : '重置演示对局' }}</button>
        <button class="ghost notation-trigger" @click="openNotationDialog">查看 / 复制本地棋谱</button>
      </aside>
    </section>
    <footer>Numeral Lord · 多人战棋测试版</footer>

    <div v-if="leaveDialogOpen" class="notation-backdrop" @click.self="leaveDialogOpen = false">
      <section class="leave-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-title">
        <p class="entry-kicker">LEAVE ROOM</p>
        <h2 id="leave-title">返回主页？</h2>
        <p>离开后当前席位会释放。{{ relayIsHost ? '房主身份将移交给其他在线成员。' : '你可以稍后通过房间号重新加入；已开局时会进入观战。' }}</p>
        <div class="leave-actions"><button class="ghost" @click="leaveDialogOpen = false">留在房间</button><button class="secondary" @click="leaveToHome">离开房间</button></div>
      </section>
    </div>

    <div v-if="notationDialogOpen" class="notation-backdrop" @click.self="notationDialogOpen = false">
      <section class="notation-dialog" role="dialog" aria-modal="true" aria-labelledby="notation-title">
        <div class="panel-heading"><span id="notation-title">本地棋谱</span><small>[行, 列, 点击次数]</small></div>
        <p>仅真实点击记谱；连续加点会合并第三项的次数。</p>
        <pre>{{ notationText }}</pre>
        <p v-if="latestContinuation" class="notation-detail">最近一次动作的自动续选坐标：{{ JSON.stringify(latestContinuation) }}</p>
        <p class="notation-detail">`[-1,-1,-1]` 为结束行动，`[-1,-1,-2]` 为结束加点。</p>
        <p v-if="notationCopyMessage" class="copy-status">{{ notationCopyMessage }}</p>
        <div class="notation-actions">
          <button class="primary" @click="copyNotation">复制当前棋谱</button>
          <button class="ghost" @click="notationDialogOpen = false">关闭</button>
        </div>
      </section>
    </div>

    <div v-if="connectionLogDialogOpen" class="notation-backdrop" @click.self="connectionLogDialogOpen = false">
      <section class="connection-log-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-log-title">
        <div class="panel-heading"><span id="connection-log-title">连接日志</span><small>当前标签页 · 最近 120 条</small></div>
        <p>记录连接、断线码、房主切换和棋盘同步；刷新本标签页后仍会保留。遇到掉线时复制发给我。</p>
        <textarea readonly :value="connectionLogText" aria-label="连接诊断日志" @focus="($event.target as HTMLTextAreaElement).select()" />
        <p v-if="connectionLogCopyMessage" class="copy-status" role="status">{{ connectionLogCopyMessage }}</p>
        <div class="connection-log-actions"><button class="primary" type="button" @click="copyConnectionLog">复制日志</button><button class="ghost" type="button" @click="connectionLogDialogOpen = false">关闭</button></div>
      </section>
    </div>
  </main>
</template>
