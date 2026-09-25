<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Client, type Room } from "@colyseus/sdk";
import {
  applyCommand,
  DEFAULT_LOBBY_SETTINGS,
  getActionableUnitIds,
  getLegalActionDestinationIds,
  getPoweredUnitIds,
  getPlayerColor,
  appendActionNotation,
  appendPhaseEndNotation,
  appendReinforcementNotation,
  type CellId,
  type GameCommand,
  type GameState,
  type LobbyRolePayload,
  type LobbyRoomState,
  type LobbyModSettings,
  type MatchStartPayload,
  type CommandResult,
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
  createMatchFromMapCode,
  serializeMapCode
} from "@numeral-lord/core-content";
import HexBoard from "./components/HexBoard.vue";
import HomeScreen from "./components/HomeScreen.vue";
import LobbyPanel from "./components/LobbyPanel.vue";
import MapLibrary from "./components/MapLibrary.vue";
import WorkshopPanel from "./components/WorkshopPanel.vue";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "./components/WorkshopPanel.vue";
import { addMapToLibrary, loadMapLibrary, removeMapFromLibrary, saveMapToLibrary } from "./map-library";
import {
  hydrateInstalledTerrainMods,
  installTerrainModObject,
  installedMapCatalogs,
  installedTerrainCatalog,
  installedTerrainMods,
  terrainModDefinitionObject
} from "./installed-content";
import { WorkshopClient, type WorkshopConnectionStatus } from "./workshop-client";
import { loadModSubscriptions, markModUpdateCheck, shouldCheckModUpdates, subscribeToTerrainMod, updateSubscribedMod } from "./mod-installation";
import { requestReturnToLobby } from "./room-reset";
import { useBoardInteraction } from "./board-interaction";
import { createCommandTimeline, type CommandEnvelope } from "./command-sync";
import { useMatchStore } from "./stores/match";
import { toNetworkPayload } from "./network-payload";
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
const gameOptionsOpen = ref(false);
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

function loadOrCreateBrowserIdentity(key: string): string {
  const saved = localStorage.getItem(key)?.trim();
  if (saved) return saved;
  // Migrate the earlier per-tab guest identity when upgrading an existing tab.
  const legacyTabIdentity = sessionStorage.getItem(key)?.trim();
  const value = legacyTabIdentity || createCommandId();
  localStorage.setItem(key, value);
  return value;
}

const matchStore = useMatchStore();
if (!matchStore.game) matchStore.setGame(createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs));
const game = computed(() => matchStore.game!);
const commandTimeline = createCommandTimeline();
const isRepairing = ref(false);
const playerName = ref(loadOrCreateLocalValue(PLAYER_NAME_STORAGE_KEY, randomPlayerName));
const configuredMaps = ref(loadMapLibrary());
const selectedMapLibraryId = ref(configuredMaps.value[0]?.definition.id ?? "");
const mapActionMessage = ref("");
const mapActionError = ref(false);
const mapLibraryRef = ref<InstanceType<typeof MapLibrary> | null>(null);
const builtInTerrainMod: TerrainModEntry = {
  id: "local:mod-oil-field",
  modId: installedTerrainMods[0]!.id,
  name: "油田",
  version: installedTerrainMods[0]!.version,
  description: "占据时每回合产生 2 点；离开时留下 1 点游兵。不导电。这个地块由独立的 oil-field-mod 包提供。",
  terrainIds: installedTerrainMods[0]!.terrains.map((terrain) => terrain.id),
  installed: true,
  authorName: "Numeral Lord",
  definition: terrainModDefinitionObject(installedTerrainMods[0]!)
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
// One browser profile uses one temporary PvP identity across its tabs. This
// is only a local guest identity, not a verified account or login credential.
const relayAccountKey = loadOrCreateBrowserIdentity(ACCOUNT_ID_STORAGE_KEY);
const invitedRoomId = new URLSearchParams(window.location.search).get("room")?.trim() ?? "";
// A room link is already an explicit game entry. Only the bare site URL shows
// the name/start home page; invite links join immediately with the saved (or
// freshly generated) local name.
const route = useRoute();
const router = useRouter();
const page = computed<"home" | "maps" | "workshop" | "rooms">(() => {
  if (route.query.room) return "rooms";
  if (route.path === "/maps") return "maps";
  if (route.path === "/workshop") return "workshop";
  if (route.path === "/rooms") return "rooms";
  return "home";
});
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
/** Selection, legal destinations and defense frames are private per-client UI state. */
const boardInteraction = useBoardInteraction(() => game.value, installedTerrainCatalog, coreUnitCatalog);
const {
  selectedUnitId,
  selectedSourceCellId,
  selectedByUser,
  selectedUnit,
  legalActionCellIds,
  counterattackCellIds,
  noCounterattackCellIds
} = boardInteraction;
const notice = ref("选择己方单位，再点击相邻格移动或攻击。");

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
const activePlayerCount = computed(() => players.value.length);
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
  && relayPlayerId.value === currentPlayer.value?.id) && !isRepairing.value);
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
  readonly resolvedCommandId?: string;
  readonly errorMessage?: string;
  readonly reconcile?: boolean;
  readonly cacheOnly?: boolean;
}): void {
  if (relayRoom && relayIsHost.value && lobbyState.value.phase === "playing") {
    try {
      relayRoom.send("host-snapshot", toNetworkPayload({
        state: game.value,
        commandHeadId: commandTimeline.headId,
        clock: matchClock.value,
        hostSentAtEpochMs: Date.now(),
        ...resolution
      }));
      logConnection("snapshot.sent", { sequence: game.value.sequence, phase: game.value.turn.phase });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logConnection("snapshot.send-failed", { sequence: game.value.sequence, message: message.slice(0, 250) });
      notice.value = "棋盘同步失败，已记录错误；请复制连接日志。";
      console.error("PvP snapshot encoding failed", error);
    }
  }
}

/** Every participant executes locally first; the relay distributes commands in the background. */
function executeLocalCommand(command: GameCommand, quiet = false): CommandResult {
  const before = game.value;
  const envelope = commandTimeline.envelope(command);
  const startedAt = performance.now();
  const result = applyCommand(game.value, command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
  if (!result.accepted || !applyResult(result, quiet)) return result;
  commandTimeline.commit(envelope);
  if (command.type === "move-unit" || command.type === "attack-unit") {
    const sourceCellId = before.units[command.unitId]?.cellId;
    const sourceCell = sourceCellId ? before.cells[sourceCellId] : undefined;
    const targetCellId = command.type === "move-unit" ? command.destinationId : command.targetId;
    if (sourceCell) recordAction(sourceCellId!, targetCellId, result.outcome?.continuation?.cellId, selectedByUser.value);
    continueActionAt(result.outcome?.continuation?.unitId ?? null);
  } else if (command.type === "reinforce-unit") {
    const reinforcedCellId = before.units[command.unitId]?.cellId;
    if (reinforcedCellId) recordReinforcement(reinforcedCellId, 1);
  } else if (command.type === "end-action-phase") {
    recordSpecial("action");
    clearSelectionSilently();
  } else if (command.type === "end-reinforcement-phase") {
    recordSpecial("reinforcement");
    clearSelectionSilently();
  }
  if (relayRoom) {
    try {
      relayRoom.send("player-intent", { ...envelope, playerId: relayPlayerId.value });
      logConnection("intent.local-applied", {
        commandId: command.commandId, commandType: command.type,
        sequence: game.value.sequence, localMs: Math.round((performance.now() - startedAt) * 100) / 100
      });
      if (relayIsHost.value) broadcastSnapshot({ cacheOnly: true });
    } catch (error) {
      logConnection("intent.send-failed", { commandId: command.commandId, message: String(error).slice(0, 250) });
      requestCommandRepair("操作未能同步，正在恢复连接状态。");
    }
  }
  return result;
}

function requestCommandRepair(reason: string): void {
  clearSelectionSilently();
  clearReinforcementHold();
  logConnection("command.conflict", { reason, sequence: game.value.sequence, commandHeadId: commandTimeline.headId });
  if (relayIsHost.value) {
    broadcastSnapshot({ reconcile: true, errorMessage: reason });
    return;
  }
  isRepairing.value = true;
  notice.value = "对局状态发生冲突，正在同步房主的棋盘。";
  relayRoom?.send("command-conflict", { sequence: game.value.sequence, commandHeadId: commandTimeline.headId });
}

function canCurrentClientAct(): boolean {
  if (isRepairing.value) {
    notice.value = "正在校正对局状态，请稍候。";
    return false;
  }
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
      installedModIds: installedTerrainMods.map((mod) => mod.id),
      ...(mode === "create" ? { mapCode: configuredMaps.value.find((map) => map.definition.id === selectedMapLibraryId.value)?.code } : {})
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
    void router.replace({ path: "/rooms", query: { ...route.query, room: room.roomId } });
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
        commandTimeline.reset(null);
        isRepairing.value = false;
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
    room.onMessage("intent-rejected", (payload: { commandId?: string; reason?: string }) => {
      logConnection("intent.rejected-relay", { commandId: payload.commandId, reason: payload.reason });
      requestCommandRepair("服务器未能转发本地已执行的操作。");
    });
    room.onMessage("snapshot-rejected", (payload: { reason?: string }) => {
      logConnection("snapshot.rejected-relay", {
        reason: payload.reason,
        sequence: game.value.sequence,
        host: relayIsHost.value
      });
      if (relayIsHost.value) relayRoom?.send("room-sync", {});
    });
    room.onMessage("match-start", (payload: MatchStartPayload) => {
      logConnection("match.start", { assignments: payload.assignments.length, roomId: room.roomId });
      startLobbyMatch(payload);
    });
    room.onMessage("snapshot-request", (payload?: { commandId?: string; errorMessage?: string }) => {
      logConnection("snapshot.requested", {
        host: relayIsHost.value,
        sequence: game.value.sequence,
        hasCommandId: typeof payload?.commandId === "string"
      });
      if (relayIsHost.value) {
        const resolution = typeof payload?.commandId === "string"
          ? {
            resolvedCommandId: payload.commandId,
            ...(typeof payload.errorMessage === "string" ? { errorMessage: payload.errorMessage } : {})
          }
          : undefined;
        broadcastSnapshot(resolution);
      }
    });
    room.onMessage("command-conflict", (payload: { sequence?: number; commandHeadId?: string | null }) => {
      logConnection("command.conflict-received", {
        host: relayIsHost.value, localSequence: game.value.sequence,
        remoteSequence: payload.sequence, localHeadId: commandTimeline.headId,
        remoteHeadId: payload.commandHeadId ?? null
      });
      if (relayIsHost.value) broadcastSnapshot({ reconcile: true });
    });
    room.onMessage("room-host", (payload: { sessionId?: string }) => {
      relayIsHost.value = payload.sessionId === room.sessionId;
      logConnection("room.host", { selfIsHost: relayIsHost.value, hasSnapshot: hasLiveSnapshot.value });
      if (relayIsHost.value && lobbyState.value.phase === "playing") broadcastSnapshot();
    });
    room.onMessage("player-intent", (payload: { playerId?: string; command?: GameCommand; parentCommandId?: string | null }) => {
      if (!payload.command) return;
      const envelope: CommandEnvelope = { command: payload.command, parentCommandId: payload.parentCommandId ?? null };
      const inspection = commandTimeline.inspect(envelope);
      if (inspection === "duplicate") return;
      if (inspection === "conflict") {
        requestCommandRepair("收到的操作与本地历史不一致。");
        return;
      }
      logConnection("intent.received", {
        commandId: payload.command.commandId,
        commandType: payload.command.type,
        expectedSequence: payload.command.expectedSequence,
        actorId: payload.command.actorId,
        sequence: game.value.sequence
      });
      const active = currentPlayer.value;
      if (!active || payload.command.actorId !== active.id) {
        logConnection("intent.rejected-stale-actor", {
          commandId: payload.command.commandId,
          requestedActorId: payload.command.actorId,
          activePlayerId: active?.id ?? null,
          sequence: game.value.sequence
        });
        requestCommandRepair("收到的操作行动者与当前回合不一致。");
        return;
      }
      const before = game.value;
      const result = applyCommand(game.value, payload.command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
      if (!result.accepted) {
        requestCommandRepair(result.error.message);
        return;
      }
      commandTimeline.commit(envelope);
      clearSelectionSilently();
      if (payload.command.type === "move-unit" || payload.command.type === "attack-unit") {
        const sourceCellId = before.units[payload.command.unitId]?.cellId;
        if (sourceCellId) recordAction(sourceCellId,
          payload.command.type === "move-unit" ? payload.command.destinationId : payload.command.targetId,
          result.outcome?.continuation?.cellId, false);
      } else if (payload.command.type === "reinforce-unit") {
        const cellId = before.units[payload.command.unitId]?.cellId;
        if (cellId) recordReinforcement(cellId, 1);
      } else if (payload.command.type === "end-action-phase") recordSpecial("action");
      else if (payload.command.type === "end-reinforcement-phase") recordSpecial("reinforcement");
      applyResult(result, true);
      if (relayIsHost.value) broadcastSnapshot({ cacheOnly: true });
    });
    room.onMessage("host-snapshot", (payload: {
      state?: GameState;
      commandHeadId?: string | null;
      clock?: MatchClockSnapshot;
      serverSentAtEpochMs?: number;
      errorMessage?: string;
      handoff?: boolean;
    }) => {
      if (!payload.state || (relayIsHost.value && payload.handoff !== true)) return;
      if (payload.state.sequence < game.value.sequence) {
        logConnection("snapshot.ignored-stale", {
          sequence: payload.state.sequence,
          currentSequence: game.value.sequence,
          handoff: payload.handoff === true
        });
        if (relayIsHost.value && payload.handoff) broadcastSnapshot();
        return;
      }
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
      // Snapshots are recovery only; routine player actions travel as commands.
      if (!isRepairing.value && hasLiveSnapshot.value && payload.handoff !== true
        && payload.state.sequence === game.value.sequence) return;
      matchStore.setGame(payload.state);
      commandTimeline.reset(payload.commandHeadId ?? null);
      isRepairing.value = false;
      hasLiveSnapshot.value = true;
      lastSnapshotSyncAt = 0;
      const receivedAt = Date.now();
      matchClock.value = payload.clock
        ? typeof payload.serverSentAtEpochMs === "number"
          ? rebaseMatchClock(payload.clock, payload.serverSentAtEpochMs, receivedAt)
          : payload.clock
        : startMatchClocks(payload.state, lobbyState.value.settings, receivedAt);
      expiredStepSequence = null;
      clearSelectionSilently();
      notice.value = payload.errorMessage ?? "已从房主恢复最新棋盘。";
      if (payload.handoff && relayIsHost.value) broadcastSnapshot();
    });
    room.onLeave((code) => {
      if (relayRoom !== room) return;
      const replacedByAnotherTab = code === 4001;
      logConnection("socket.closed", {
        code, roomId: room.roomId, phase: lobbyState.value.phase,
        selfIsHost: relayIsHost.value, sequence: game.value.sequence, replacedByAnotherTab,
        online: navigator.onLine, visibility: document.visibilityState
      });
      console.warn("PvP room socket closed", { code, roomId: room.roomId });
      relayStatus.value = "连接已断开";
      relayRoom = undefined;
      relayRoomId.value = "";
      boardInteraction.clear();
      relayPlayerId.value = null;
      relayAccountId.value = null;
      relaySessionId.value = null;
      relayIsHost.value = false;
      hasLiveSnapshot.value = false;
      commandTimeline.reset(null);
      isRepairing.value = false;
      if (replacedByAnotherTab) {
        cancelReconnect();
        notice.value = "同一浏览器身份已在另一个标签页进入此房间；本标签页已退出。";
        return;
      }
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
  void router.push({ path: "/rooms", query: route.query });
}

function updatePlayerName(value: string): void {
  playerName.value = value;
  const normalizedName = value.trim().slice(0, 24);
  if (normalizedName) localStorage.setItem(PLAYER_NAME_STORAGE_KEY, normalizedName);
}

function openMapLibrary(): void {
  void router.push("/maps");
}

function ensureWorkshopClient(): void {
  if (!workshopClient) {
    workshopClient = new WorkshopClient(resolveRelayEndpoint(), {
      catalog: (catalog) => {
        remoteMapWorks.value = catalog.maps.map((entry) => ({ ...entry }));
        const installedIds = new Set(installedTerrainMods.map((mod) => mod.id));
        remoteTerrainMods.value = catalog.terrainMods.map((entry) => ({
          ...entry,
          installed: installedIds.has(entry.modId)
        }));
        void requestSubscribedModUpdates(catalog.terrainMods);
      },
      detail: (detail) => {
        if (detail.kind === "map") {
          remoteMapWorks.value = remoteMapWorks.value.map((entry) => entry.id === detail.entry.id
            ? { ...entry, ...detail.entry } : entry);
        } else {
          remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.id === detail.entry.id
            ? { ...entry, ...detail.entry } : entry);
          if (detail.entry.definition) void autoUpdateSubscribedMod(detail.entry.definition);
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
}

function openWorkshop(): void {
  void router.push("/workshop");
  ensureWorkshopClient();
  const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
  void workshopClient?.connect({ name });
}

function selectWorkshopMap(id: string): void {
  if (id === builtInMapWork.id) return;
  const entry = remoteMapWorks.value.find((candidate) => candidate.id === id);
  if (entry && !entry.code) workshopClient?.requestDetail("map", id);
}

function selectWorkshopTerrainMod(id: string): void {
  if (id === builtInTerrainMod.id) return;
  const entry = remoteTerrainMods.value.find((candidate) => candidate.id === id);
  if (entry && !entry.definition) workshopClient?.requestDetail("terrain-mod", id);
}

async function installWorkshopTerrainMod(definition: import("@numeral-lord/content-schema").TerrainModDefinition): Promise<void> {
  try {
    await subscribeToTerrainMod(definition);
    await installTerrainModObject(definition);
    remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.modId === definition.id
      ? { ...entry, installed: true } : entry);
    workshopActionError.value = false;
    workshopActionMessage.value = `「${definition.id}」v${definition.version} 已安装并载入本机规则目录。`;
  } catch (error) {
    workshopActionError.value = true;
    workshopActionMessage.value = error instanceof Error ? error.message : "Mod 安装失败。";
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/).map((part) => Number(part) || 0);
  const b = right.split(/[.+-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

async function requestSubscribedModUpdates(entries: readonly import("./workshop-client").WorkshopTerrainModSummary[]): Promise<void> {
  try {
    if (!await shouldCheckModUpdates()) return;
    const subscriptions = await loadModSubscriptions();
    const latest = new Map<string, string>();
    for (const entry of entries) {
      if (!latest.has(entry.modId) || compareVersions(entry.version, latest.get(entry.modId)!) > 0) latest.set(entry.modId, entry.version);
    }
    const installedVersions = new Map(installedTerrainMods.map((mod) => [mod.id, mod.version]));
    for (const subscription of subscriptions) {
      const version = latest.get(subscription.id);
      if (version && compareVersions(version, installedVersions.get(subscription.id) ?? subscription.installedVersion) > 0) {
        const entry = entries.find((candidate) => candidate.modId === subscription.id && candidate.version === version);
        if (entry) workshopClient?.requestDetail("terrain-mod", entry.id);
      }
    }
    await markModUpdateCheck();
  } catch (error) {
    logConnection("mods.update-check.failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

async function autoUpdateSubscribedMod(definition: import("@numeral-lord/content-schema").TerrainModDefinition): Promise<void> {
  try {
    const subscriptions = await loadModSubscriptions();
    if (!subscriptions.some((entry) => entry.id === definition.id)) return;
    const current = installedTerrainMods.find((mod) => mod.id === definition.id)?.version;
    if (current && compareVersions(definition.version, current) <= 0) return;
    await updateSubscribedMod(definition);
    await installTerrainModObject(definition);
    logConnection("mods.updated", { modId: definition.id, version: definition.version });
    remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.modId === definition.id
      ? { ...entry, installed: true } : entry);
  } catch (error) {
    logConnection("mods.update.failed", { modId: definition.id, message: error instanceof Error ? error.message : String(error) });
  }
}

function saveWorkshopMap(code: string): void {
  try {
    const next = addMapToLibrary(configuredMaps.value, code);
    configuredMaps.value = next;
    selectedMapLibraryId.value = next.at(-1)?.definition.id ?? "";
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
    selectedMapLibraryId.value = next.at(-1)?.definition.id ?? "";
    mapActionMessage.value = `「${next.at(-1)?.definition.name ?? "地图"}」已保存到本机。`;
    mapActionError.value = false;
    mapLibraryRef.value?.clearCodeDraft();
  } catch (error) {
    mapActionMessage.value = error instanceof Error ? error.message : "地图码无法导入。";
    mapActionError.value = true;
  }
}

function saveConfiguredMap(definition: import("@numeral-lord/core-content").MapDefinition): void {
  try {
    const next = saveMapToLibrary(configuredMaps.value, serializeMapCode(definition, { ...installedMapCatalogs, allowUnknownTerrainMods: true }));
    configuredMaps.value = next;
    selectedMapLibraryId.value = definition.id;
    mapActionMessage.value = `「${definition.name}」已保存到当前浏览器。`;
    mapActionError.value = false;
  } catch (error) {
    mapActionMessage.value = error instanceof Error ? error.message : "地图无法保存。";
    mapActionError.value = true;
  }
}

function removeConfiguredMap(id: string): void {
  const removed = configuredMaps.value.find((map) => map.definition.id === id);
  configuredMaps.value = removeMapFromLibrary(configuredMaps.value, id);
  selectedMapLibraryId.value = configuredMaps.value[0]?.definition.id ?? "";
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
  void router.push("/");
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
  commandTimeline.reset(null);
  isRepairing.value = false;
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
  const query = { ...route.query };
  delete query.room;
  void router.replace({ path: "/", query });
  if (room) {
    try { await room.leave(); } catch { /* The local page has already left. */ }
  }
  if (workshop) await workshop.leave();
}

function createRoom(): void {
  const map = configuredMaps.value.find((entry) => entry.definition.id === selectedMapLibraryId.value) ?? configuredMaps.value[0];
  if (!map) {
    mapActionError.value = true;
    mapActionMessage.value = "先导入或创建一张地图，再创建对战房间。";
    void router.push("/maps");
    return;
  }
  lobbyState.value = { ...lobbyState.value, mapCode: map.code, mapName: map.definition.name,
    mapPlayerCount: map.definition.players, requiredTerrainModIds: map.definition.requiredTerrainModIds };
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
  commandTimeline.reset(null);
  isRepairing.value = false;
  const assignment = payload.assignments.find((candidate) => candidate.sessionId === relaySessionId.value);
  relayPlayerId.value = assignment?.playerId ?? null;
  if (missingLocalModIds.value.length > 0) {
    hasLiveSnapshot.value = false;
    notice.value = `当前设备缺少地块 Mod：${missingLocalModIds.value.join("、")}。安装后才能进入对局。`;
    logConnection("match.missing-mods", { missingModIds: missingLocalModIds.value });
    return;
  }
  try { matchStore.setGame(createMatchFromMapCode(payload.mapCode, {
    ...installedMapCatalogs,
    activePlayerIds: payload.assignments.map((candidate) => candidate.playerId as PlayerId),
    playerDisplayNames: Object.fromEntries(payload.assignments.map((candidate) => [
      candidate.playerId,
      candidate.displayName ?? lobbyState.value.members.find((member) => member.sessionId === candidate.sessionId)?.displayName ?? `玩家 ${candidate.seat}`
    ])),
    playerColors: Object.fromEntries(payload.assignments.flatMap((candidate) => {
      const color = getPlayerColor(candidate.playerColorId);
      return color ? [[candidate.playerId, color]] : [];
    })),
    friendlyFire: payload.settings.friendlyFire,
    roomModSettings: payload.roomModSettings ?? {}
  })); } catch (error) {
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

function sendLobbyColor(playerColorId: string): void {
  relayRoom?.send("lobby-color", { playerColorId });
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
  const actingUnitId = actingUnit.id;
  // Switch directly when the user clicks another friendly unit, before
  // interpreting that cell as an attack target or an invalid destination.
  if (clickedUnit?.ownerId === active.id && clickedUnit.id !== actingUnitId) {
    selectOwnUnit(clickedUnit.id);
    return;
  }
  // Once a unit is selected, a board click has only two meanings:
  // - a blue-outlined legal cell executes the action;
  // - every other rendered board cell cancels the current selection.
  //
  if (!legalActionCellIds.value.includes(cellId)) {
    clearSelection();
    return;
  }
  // Capture both values before applying the command. A later friendly-fire
  // click cannot reinterpret a cancelled selection as the action source.
  const command: GameCommand = clickedUnit
    ? {
      type: "attack-unit", commandId: createCommandId(), actorId: active.id,
      expectedSequence: game.value.sequence, unitId: actingUnitId, targetId: cellId
    }
    : {
      type: "move-unit", commandId: createCommandId(), actorId: active.id,
      expectedSequence: game.value.sequence, unitId: actingUnitId, destinationId: cellId
    };
  executeLocalCommand(command);
}

function clearSelection(): void {
  clearSelectionSilently();
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
  boardInteraction.select(unit.id);
  notice.value = poweredUnitIds.value.includes(unit.id)
    ? "通电兵已选中：移动时会在原格留下 1 点。"
    : "游兵已选中：移动后点数减 1；攻击按当前点数结算，不扣这 1 点。";
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
    const result = executeLocalCommand(command, quiet);
    if (!result.accepted) break;
    completed += 1;
  }
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
  executeLocalCommand(command);
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
  executeLocalCommand(command);
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
  commandTimeline.reset(null);
  const activePlayerIds = lobbyState.value.members
    .filter((member) => member.participating && member.seat !== null)
    .map((member) => `player-${member.seat}` as PlayerId);
  matchStore.setGame(createMatchFromMapCode(lobbyState.value.mapCode, {
    ...installedMapCatalogs,
    ...(activePlayerIds.length > 0 ? { activePlayerIds } : {}),
    playerDisplayNames: Object.fromEntries(lobbyState.value.members
      .filter((member) => member.participating && member.seat !== null)
      .map((member) => [`player-${member.seat}`, member.displayName])),
    friendlyFire: lobbyState.value.settings.friendlyFire,
    roomModSettings: lobbyState.value.roomModSettings
  }));
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
    boardInteraction.clear();
    return;
  }
  if (!boardInteraction.continueAt(unitId)) {
    return;
  }
  notice.value = "行动完成；该单位仍可行动，已自动继续选中。";
}

function clearSelectionSilently(): void {
  boardInteraction.clear();
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
  const before = game.value;
  const now = Date.now();
  matchClock.value = advanceMatchClocks(
    matchClock.value ?? startMatchClocks(before, lobbyState.value.settings, now),
    before,
    result.state,
    lobbyState.value.settings,
    now
  );
  matchStore.setGame(result.state);
  expiredStepSequence = null;
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
  const result = executeLocalCommand(command, true);
  return result.accepted;
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

onMounted(async () => {
  try {
    await hydrateInstalledTerrainMods();
    logConnection("mods.hydrated", { count: installedTerrainMods.length });
    if ((await loadModSubscriptions()).length) {
      ensureWorkshopClient();
      const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
      void workshopClient?.connect({ name });
    }
  } catch (error) {
    logConnection("mods.hydrate-failed", { message: String(error).slice(0, 250) });
    notice.value = "本地 Mod 缓存读取失败；内置内容仍可使用。";
  }
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
  <main class="app-shell" :class="{ 'game-shell': showGame }">
    <header class="topbar" :class="{ 'game-topbar': showGame }">
      <div class="brand-block">
        <button v-if="!showHome && !showMaps && !showWorkshop" class="topbar-back" @click="requestHome"><span aria-hidden="true">←</span> 返回主页</button>
        <template v-if="!showGame"><p class="eyebrow">NUMERAL LORD · EARLY ACCESS</p><h1>Numeral Lord</h1></template>
      </div>
      <div v-if="showGame" class="match-scoreboard" aria-label="对局状态">
        <div><span>人数</span><strong>{{ activePlayerCount }}</strong></div>
        <div><span>回合</span><strong>{{ game.turn.round }}</strong></div>
        <div class="scoreboard-current" :style="{ '--player-color': currentPlayer?.color }"><span>{{ currentPlayer?.displayName }} · {{ phaseLabel }}</span><strong>{{ currentPlayer?.reinforcementPoints ?? 0 }} <small>点</small></strong><em>步 {{ stepClockLabel }} · 局 {{ matchClockLabel }}</em></div>
      </div>
      <div class="topbar-meta">
        <div v-if="showHome" class="turn-pill"><span class="turn-dot" />选择入口，开启对局</div>
        <div v-else-if="showMaps" class="turn-pill"><span class="turn-dot" />地图配置 · {{ configuredMaps.length }} 张可用</div>
        <div v-else-if="showWorkshop" class="turn-pill"><span class="turn-dot" />创意工坊 · {{ workshopStatus === 'connected' ? '已连接' : workshopStatus === 'connecting' ? '连接中' : '离线预览' }}</div>
        <div v-else-if="showRoomEntry" class="turn-pill"><span class="turn-dot" />创建房间或用房间号加入</div>
        <div v-else-if="relayStatus === '连接中…'" class="turn-pill"><span class="turn-dot" />正在连接 PvP 房间…</div>
        <div v-else-if="showLobby" class="turn-pill"><span class="turn-dot" />准备房间 · 地图 {{ lobbyState.mapPlayerCount }} 个玩家位</div>
        <div v-else-if="showGameLoading" class="turn-pill"><span class="turn-dot" />正在同步对局棋盘…</div>
        <div v-if="!showHome && !showMaps && !showWorkshop && !showGame" class="network-pill" :class="{ connected: relayStatus === '已连接' }">PvP {{ relayStatus }}<span v-if="relayRoomId"> · 房间 {{ relayRoomId }}</span><span v-if="relayIsHost"> · 房主</span><span v-else-if="isSpectator"> · 观战</span><span v-else-if="relayPlayerId"> · {{ relayPlayerId }}</span></div>
        <button v-if="!showHome && !showMaps && !showWorkshop && !showGame" class="connection-log-trigger" type="button" @click="connectionLogCopyMessage = ''; connectionLogDialogOpen = true">连接日志</button>
        <div v-if="showGame" class="game-options" @click.stop>
          <button class="game-options-trigger" type="button" aria-label="对局选项" :aria-expanded="gameOptionsOpen" @click="gameOptionsOpen = !gameOptionsOpen">⚙</button>
          <div v-if="gameOptionsOpen" class="game-options-menu" role="menu">
            <div class="game-options-status" :class="{ connected: relayStatus === '已连接' }"><span class="turn-dot" />PvP {{ relayStatus }}<small v-if="relayRoomId">房间 {{ relayRoomId }}<template v-if="relayIsHost"> · 房主</template><template v-else-if="isSpectator"> · 观战</template><template v-else-if="relayPlayerId"> · {{ relayPlayerId }}</template></small></div>
            <button type="button" role="menuitem" @click="connectionLogCopyMessage = ''; connectionLogDialogOpen = true; gameOptionsOpen = false">连接日志</button>
            <button type="button" role="menuitem" @click="openNotationDialog(); gameOptionsOpen = false">查看 / 复制本地棋谱</button>
            <button v-if="relayStatus !== '已连接' || relayIsHost" type="button" role="menuitem" @click="resetMatch(); gameOptionsOpen = false">{{ relayRoomId ? '返回准备房间' : '重置演示对局' }}</button>
          </div>
        </div>
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
      @save="saveConfiguredMap"
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
      @install-terrain-mod="installWorkshopTerrainMod"
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
      @color="sendLobbyColor"
      @settings="sendLobbySettings"
      @mod-settings="sendLobbyModSettings"
      @assign="sendLobbyAssignment"
      @map="sendLobbyMap"
    />

    <section v-if="showGameLoading" class="sync-panel" role="status"><span v-if="missingLocalModIds.length === 0" class="sync-spinner" /><h2>{{ missingLocalModIds.length ? '当前设备缺少地块 Mod' : '正在同步棋盘' }}</h2><p>{{ missingLocalModIds.length ? `此地图需要 ${missingLocalModIds.join('、')}。安装后才能进入对局。` : '正在从房间获取当前地图和最新对局状态；若房主刚断线，系统会自动重试。' }}</p></section>

    <Teleport to="body">
      <div v-if="showGame && isMatchFinished" class="result-backdrop">
        <section class="result-dialog" role="dialog" aria-modal="true" aria-labelledby="match-result-title" aria-describedby="match-result-message">
          <div class="result-emblem" aria-hidden="true">✦</div>
          <p class="result-kicker">MATCH FINISHED <span>·</span> 对局结束</p>
          <h2 id="match-result-title">{{ matchResultTitle }}</h2>
          <p id="match-result-message" class="result-message">{{ matchResultMessage }}</p>
          <div class="result-divider"><span /><i>本局结算</i><span /></div>
          <button v-if="relayStatus !== '已连接' || relayIsHost" class="primary result-return" @click="resetMatch">{{ relayRoomId ? '返回准备房间' : '重新开始演示对局' }} <span aria-hidden="true">→</span></button>
          <p v-else class="result-waiting">等待房主返回准备房间</p>
        </section>
      </div>
    </Teleport>

    <section v-if="showGame" class="play-layout">
      <aside class="panel player-panel">
        <div class="panel-heading"><span>玩家状态</span><small>按座位依次行动</small></div>
        <article v-for="player in players" :key="player.id" class="player-card" :class="{ active: player.id === currentPlayer?.id }">
          <span class="player-color" :style="{ background: player.color }" />
          <div><strong>{{ player.displayName }}</strong><small>队伍 {{ player.teamId }} · 座位 {{ player.seat }}</small></div><b>{{ player.reinforcementPoints }} 点</b>
        </article>
        <div class="legend"><p><i class="legend-token powered" />通电兵：每回合 +1；1 点不能行动</p><p><i class="legend-token roaming" />游兵：行动 -1；1 点作最后一次行动后失活</p><p><i class="legend-token exhausted" />失活：本回合不能继续行动</p><p><i class="counter-frame-key" /><i class="counter-frame-key safe" />红框可反击，白框本回合不能反击</p></div>
      </aside>

      <section class="board-wrap">
        <HexBoard
          :state="game"
          :selected-unit-id="selectedUnitId"
          :legal-action-cell-ids="legalActionCellIds"
          :counterattack-cell-ids="counterattackCellIds"
          :no-counterattack-cell-ids="noCounterattackCellIds"
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
        <div class="panel-heading"><span>对局操作</span><small>本地即时结算 · 操作同步</small></div>
        <div class="selected-info">
          <template v-if="isMatchFinished"><small>结算完成</small><strong>{{ matchResultTitle }}</strong><span>{{ matchResultMessage }}</span></template>
          <template v-else-if="isSpectator"><small>观战模式</small><strong>只读观战</strong><span>棋盘实时同步中。</span></template>
          <template v-else-if="isRepairing"><small>状态校正</small><strong>正在恢复同步</strong><span>发现操作历史分叉，正在获取房主的最新棋盘。</span></template>
          <template v-else-if="isReinforcementPhase"><small>加点</small><strong>剩余 {{ currentPlayer?.reinforcementPoints ?? 0 }} 点</strong><span>点击通电兵加点，结束后轮到下一位。</span></template>
          <template v-else-if="selectedUnit"><small>已选单位</small><strong>{{ selectedIsPowered ? "通电兵" : "游兵" }} · {{ selectedUnit.strength }} 点</strong><span>点击高亮格移动或攻击。</span></template>
          <template v-else><small>行动</small><span>选择棋盘上的可行动单位。</span></template>
        </div>
        <button v-if="isActionPhase" class="secondary" :disabled="!canActCurrentPlayer" @click="endActionPhase">结束行动，进入加点</button>
        <button v-else-if="isReinforcementPhase" class="primary" :disabled="!canActCurrentPlayer" @click="endReinforcementPhase">结束加点，轮到下一位</button>
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
