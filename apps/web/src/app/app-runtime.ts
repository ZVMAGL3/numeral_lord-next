import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Client, type Room } from "@colyseus/sdk";
import {
  applyCommand,
  calculateReinforcementIncome,
  DEFAULT_LOBBY_SETTINGS,
  getActionableUnitIds,
  getLegalActionDestinationIds,
  getPotentiallyActionableUnitIds,
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
  type TeamId,
  type UnitId
} from "@numeral-lord/game-core";
import {
  coreMatchConditionCatalog,
  coreUnitCatalog,
  createMatchFromMapCode,
  serializeMapCode
} from "@numeral-lord/core-content";
import HexBoard from "../components/HexBoard.vue";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "../workshop/types";
import type { WorkshopPersonalMapsPayload, WorkshopTerrainModPreview } from "@numeral-lord/content-schema";
import { addMapToLibrary, createPersonalMapSyncRequest, loadMapLibrary, reconcilePersonalMapLibrary, removeMapFromLibrary, saveMapToLibrary } from "../maps/map-library";
import { normalizeImportedMapCode } from "../maps/legacy-map-code";
import {
  registerServerTerrainModDefinition,
  validateTerrainModObject,
  runtimeMapCatalogs,
  loadedTerrainCatalog,
  loadedTerrainCatalogRevision,
  loadedTerrainMods,
  terrainVisualAssetsForCatalogs,
  resolveMapCatalogs
} from "../content/installed-content";
import { WorkshopClient, type WorkshopConnectionStatus } from "../workshop/workshop-client";
import { latestTerrainModVersions } from "../workshop/workshop-terrain-catalog";
import { requestReturnToLobby } from "../rooms/room-reset";
import { useBoardInteraction } from "../board/board-interaction";
import { getDisconnectedPlayerIds } from "../rooms/player-presence";
import { resolveCurrentPlayerId } from "../rooms/room-role";
import { getLobbyPreviewPlayerColors } from "../rooms/lobby-preview";
import { selectQuickMatchRoom, updateBattleRoomListings, type BattleRoomListing } from "../rooms/battle-lobby";
import { withoutRoomInvite } from "../rooms/room-route";
import { createCommandTimeline, type CommandEnvelope } from "../rooms/command-sync";
import { useMatchStore } from "../stores/match";
import { toNetworkGameState, toNetworkPayload } from "../rooms/network-payload";
import {
  advanceMatchClocks,
  clockExpiration,
  rebaseMatchClock,
  remainingMatchSeconds,
  remainingTurnSeconds,
  startMatchClocks,
  type MatchClockSnapshot
} from "../rooms/match-clock";

export interface AppRuntime {
  readonly shell: Record<string, any>;
  readonly dialogs: Record<string, any>;
  readonly home: Record<string, any>;
  readonly maps: Record<string, any>;
  readonly workshop: Record<string, any>;
  readonly rooms: Record<string, any>;
}

export function useAppRuntime(): AppRuntime {
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
  const gameActionsOpen = ref(false);
  const connectionLogText = computed(() => connectionLog.value.join("\n"));
  interface BoardPaintMeasurement {
    readonly sequence: number;
    readonly boardDrawMs?: number;
    readonly boardDrawMeasuredAt?: number;
    readonly layoutMs?: number;
    readonly terrainDrawMs?: number;
    readonly unitDrawMs?: number;
    readonly labelDrawMs?: number;
    readonly interactionDrawMs?: number;
    readonly interactionDrawMeasuredAt?: number;
    readonly poweredDeriveMs?: number;
    readonly actionableDeriveMs?: number;
    readonly highlightDeriveMs?: number;
    readonly cellCount?: number;
    readonly unitCount?: number;
    readonly unitCellsRebuilt?: number;
    readonly unitCellsReused?: number;
    readonly pulsesRebuilt?: number;
  }
  interface BoardDerivedMeasurement {
    readonly sequence: number;
    readonly poweredDeriveMs?: number;
    readonly actionableDeriveMs?: number;
    readonly highlightDeriveMs?: number;
  }
  let latestBoardPaintMeasurement: BoardPaintMeasurement | undefined;
  let latestBoardDerivedMeasurement: BoardDerivedMeasurement | undefined;
  let pendingBoardCommandMeasurement: Record<string, number | string> | undefined;
  let pendingLegalPreviewMs: number | undefined;

  function onBoardDrawMeasured(measurement: {
    sequence: number;
    durationMs: number;
    layoutMs: number;
    terrainDrawMs: number;
    unitDrawMs: number;
    labelDrawMs: number;
    cellCount: number;
    unitCount: number;
    unitCellsRebuilt: number;
    unitCellsReused: number;
    pulsesRebuilt: number;
  }): void {
    const derived = latestBoardDerivedMeasurement?.sequence === measurement.sequence
      ? latestBoardDerivedMeasurement
      : undefined;
    latestBoardPaintMeasurement = {
      ...(latestBoardPaintMeasurement?.sequence === measurement.sequence ? latestBoardPaintMeasurement : {}),
      sequence: measurement.sequence,
      boardDrawMs: measurement.durationMs,
      boardDrawMeasuredAt: performance.now(),
      layoutMs: measurement.layoutMs,
      terrainDrawMs: measurement.terrainDrawMs,
      unitDrawMs: measurement.unitDrawMs,
      labelDrawMs: measurement.labelDrawMs,
      ...(derived ? {
        poweredDeriveMs: derived.poweredDeriveMs,
        actionableDeriveMs: derived.actionableDeriveMs,
        highlightDeriveMs: derived.highlightDeriveMs
      } : {}),
      cellCount: measurement.cellCount,
      unitCount: measurement.unitCount,
      unitCellsRebuilt: measurement.unitCellsRebuilt,
      unitCellsReused: measurement.unitCellsReused,
      pulsesRebuilt: measurement.pulsesRebuilt
    };
  }

  function onInteractionDrawMeasured(measurement: { sequence: number; durationMs: number }): void {
    latestBoardPaintMeasurement = {
      ...(latestBoardPaintMeasurement?.sequence === measurement.sequence ? latestBoardPaintMeasurement : {}),
      sequence: measurement.sequence,
      interactionDrawMs: measurement.durationMs,
      interactionDrawMeasuredAt: performance.now()
    };
  }

  function afterAnimationFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

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
  // The shared app shell also hosts Workshop and Maps routes; don't create an
  // unrelated demo match here. A real state is installed when a match starts
  // or the first authoritative snapshot arrives.
  const game = computed(() => matchStore.game!);
  const commandTimeline = createCommandTimeline();
  const isRepairing = ref(false);
  const playerName = ref(loadOrCreateLocalValue(PLAYER_NAME_STORAGE_KEY, randomPlayerName));
  const configuredMaps = ref(loadMapLibrary(playerName.value));
  const selectedMapLibraryId = ref(configuredMaps.value[0]?.definition.id ?? "");
  const mapActionMessage = ref("");
  const mapActionError = ref(false);
  const mapImporting = ref(false);
  const mapImportNotice = ref("");
  const gameBoardRef = ref<InstanceType<typeof HexBoard> | null>(null);
  function registerGameBoard(board: InstanceType<typeof HexBoard> | null): void { gameBoardRef.value = board; }
  function zoomBoard(action: "in" | "out" | "reset"): void {
    if (action === "in") gameBoardRef.value?.zoomIn();
    else if (action === "out") gameBoardRef.value?.zoomOut();
    else gameBoardRef.value?.resetZoom();
  }
  const remoteTerrainMods = ref<TerrainModEntry[]>([]);
  const remoteMapWorks = ref<MapWorkshopEntry[]>([]);
  const workshopTerrainMods = computed(() => remoteTerrainMods.value);
  const workshopMapWorks = computed(() => remoteMapWorks.value);
  const workshopStatus = ref<WorkshopConnectionStatus>("offline");
  // 客户端可显示发布入口，是否接受写入由当前环境的服务器开关决定。
  const workshopPublishingEnabled = true;
  const workshopActionMessage = ref("");
  const workshopActionError = ref(false);
  const workshopWorking = ref(false);
  const pendingWorkshopModUpdate = ref(false);
  const subscribedTerrainModIds = ref<string[]>([]);
  const workshopUserId = ref<string | null>(null);
  const pendingSubscribedModUpdateIds = ref<string[]>([]);
  const pendingWorkshopTerrainModId = ref<string | null>(null);
  const pendingRoomModUpdateId = ref<string | null>(null);
  const roomModUpdateMessage = ref("");
  let workshopClient: WorkshopClient | undefined;

  function normalizedWorkshopName(value: string): string {
    return value.normalize("NFKC").trim().toLowerCase();
  }

  function setPlayerNameAndPersonalMaps(value: string): void {
    const previousKey = normalizedWorkshopName(playerName.value);
    playerName.value = value;
    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, value);
    if (previousKey === normalizedWorkshopName(value)) return;
    mapImportNotice.value = "";
    mapActionMessage.value = "";
    mapActionError.value = false;
    configuredMaps.value = loadMapLibrary(value);
    if (!configuredMaps.value.some((map) => map.definition.id === selectedMapLibraryId.value)) {
      selectedMapLibraryId.value = configuredMaps.value[0]?.definition.id ?? "";
    }
  }

  function syncPersonalMaps(identityName = playerName.value): boolean {
    if (!workshopUserId.value || !workshopClient?.connected) return false;
    return workshopClient.syncPersonalMaps(createPersonalMapSyncRequest(identityName));
  }
  let lastLobbyModCatalogCheckKey = "";
  // One browser profile uses one temporary PvP identity across its tabs. This
  // is only a local guest identity, not a verified account or login credential.
  const relayAccountKey = loadOrCreateBrowserIdentity(ACCOUNT_ID_STORAGE_KEY);
  const invitedRoomId = new URLSearchParams(window.location.search).get("room")?.trim() ?? "";
  // A room link is already an explicit game entry. Only the bare site URL shows
  // the name/start home page; invite links join immediately with the saved (or
  // freshly generated) local name.
  const route = useRoute();
  const router = useRouter();
  // 页面类别来自路由元信息，只供跨页连接副作用判断，不负责选择页面组件。
  const activeRouteSection = computed(() => route.meta.page ?? "home");
  const relayStatus = ref(invitedRoomId ? "连接中…" : "未连接");
  const relayRoomId = ref("");
  const roomIdInput = ref("");
  const relayPlayerId = ref<string | null>(null);
  const relayAccountId = ref<string | null>(null);
  const relaySessionId = ref<string | null>(null);
  const relayRoleReceived = ref(false);
  let pendingMatchStartPayload: MatchStartPayload | null = null;
  const workshopReturnRoute = ref<string | null>(null);
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
  const lobbyState = ref<LobbyRoomState>({
    phase: "lobby",
    mapPlayerCount: 0,
    mapCode: "",
    mapName: "",
    requiredTerrainModIds: [],
    roomModSettings: {},
    settings: { ...DEFAULT_LOBBY_SETTINGS },
    members: []
  });
  const lobbyError = ref("");
  const activeMapCatalogs = computed(() => {
    void loadedTerrainCatalogRevision.value;
    return resolveMapCatalogs(lobbyState.value.mapCode) ?? runtimeMapCatalogs;
  });
  const activeTerrainCatalog = computed(() => activeMapCatalogs.value.terrains ?? loadedTerrainCatalog);
  const activeTerrainVisualAssets = computed(() => terrainVisualAssetsForCatalogs(activeMapCatalogs.value));
  const publicBattleRooms = ref<BattleRoomListing[]>([]);
  const battleLobbyStatus = ref<"offline" | "connecting" | "connected" | "error">("offline");
  const battleLobbyError = ref("");
  const battleLobbyWorking = ref(false);
  const battleLobbyRoom = ref<Room | undefined>();
  let battleLobbyAttempt = 0;
  const sortedPublicBattleRooms = computed(() => [...publicBattleRooms.value].sort((left, right) => {
    const leftPhase = left.metadata.phase === "lobby" ? 0 : 1;
    const rightPhase = right.metadata.phase === "lobby" ? 0 : 1;
    return leftPhase - rightPhase
      || Number(right.metadata.openSeats ?? 0) - Number(left.metadata.openSeats ?? 0)
      || right.clients - left.clients;
  }));
  const quickMatchRoom = computed(() => selectQuickMatchRoom(publicBattleRooms.value));
  const lobbyPreviewState = computed(() => {
    try { return createMatchFromMapCode(lobbyState.value.mapCode, {
      ...activeMapCatalogs.value,
      roomModSettings: lobbyState.value.roomModSettings,
      playerColors: getLobbyPreviewPlayerColors(lobbyState.value.members)
    }); }
    catch { return null; }
  });
  const lobbyPreviewPoweredUnitIds = computed(() => lobbyPreviewState.value
    ? [...getPoweredUnitIds(lobbyPreviewState.value, activeTerrainCatalog.value)] : []);
  /** Selection, legal destinations and defense frames are private per-client UI state. */
  const boardInteraction = useBoardInteraction(() => game.value, () => activeTerrainCatalog.value, coreUnitCatalog);
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
  const hoveredTeamId = ref<TeamId | null>(null);
  const hoveredPlayerId = ref<PlayerId | null>(null);

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
  const TEAM_COLORS = ["#35d6c0", "#f06bd1", "#ffb25d", "#77b8ff", "#e6dc68", "#ad8aff", "#ff7e86", "#72d77c"] as const;
  const teamColors = computed(() => new Map([...new Set(players.value.map((player) => player.teamId))]
    .sort((left, right) => left.localeCompare(right))
    .map((teamId, index) => [teamId, TEAM_COLORS[index % TEAM_COLORS.length]!] as const)));
  const viewerTeamId = computed(() => players.value.find((player) => player.id === relayPlayerId.value)?.teamId ?? currentPlayer.value?.teamId ?? null);
  const hoveredTeamColor = computed(() => hoveredTeamId.value ? teamColors.value.get(hoveredTeamId.value) : undefined);
  const currentPlayer = computed(() => game.value.players[game.value.turn.currentPlayerId]);
  const disconnectedPlayerIds = computed(() => getDisconnectedPlayerIds(players.value, lobbyState.value.members));
  function setHoveredTeam(teamId: TeamId | null): void {
    hoveredTeamId.value = teamId && teamId !== viewerTeamId.value ? teamId : null;
  }
  function onPlayerCardPointerEnter(playerId: PlayerId): void {
    const player = game.value.players[playerId];
    hoveredPlayerId.value = player?.id ?? null;
    setHoveredTeam(player?.teamId ?? null);
  }
  function clearPlayerCardHover(): void {
    hoveredPlayerId.value = null;
    hoveredTeamId.value = null;
  }
  const publicBoardPoints = computed(() => Object.values(game.value.units).reduce<Record<string, number>>((totals, unit) => {
    totals[unit.ownerId] = (totals[unit.ownerId] ?? 0) + unit.strength;
    return totals;
  }, {}));
  const privateReservePlayerId = computed(() => relayRoom ? relayPlayerId.value : currentPlayer.value?.id ?? null);
  const isMatchFinished = computed(() => game.value.turn.phase === "finished");
  const privateReservePlayer = computed(() => {
    const id = privateReservePlayerId.value;
    return id ? players.value.find((player) => player.id === id) : undefined;
  });
  const privateReserveIncome = computed(() => privateReservePlayer.value && !isMatchFinished.value
    ? calculateReinforcementIncome(game.value, privateReservePlayer.value.id, activeTerrainCatalog.value)
    : 0);
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
  const poweredUnitIds = computed(() => {
    const state = game.value;
    const startedAt = performance.now();
    const result = [...getPoweredUnitIds(state, activeTerrainCatalog.value)];
    latestBoardDerivedMeasurement = {
      ...(latestBoardDerivedMeasurement?.sequence === state.sequence ? latestBoardDerivedMeasurement : {}),
      sequence: state.sequence,
      poweredDeriveMs: performance.now() - startedAt
    };
    return result;
  });
  const actionableUnitIds = computed(() => {
    const state = game.value;
    const startedAt = performance.now();
    const result = [...getActionableUnitIds(state, activeTerrainCatalog.value, coreUnitCatalog)];
    latestBoardDerivedMeasurement = {
      ...(latestBoardDerivedMeasurement?.sequence === state.sequence ? latestBoardDerivedMeasurement : {}),
      sequence: state.sequence,
      actionableDeriveMs: performance.now() - startedAt
    };
    return result;
  });
  const highlightedUnitIds = computed(() => {
    const state = game.value;
    const startedAt = performance.now();
    const result = state.turn.phase === "action" || state.turn.phase === "reinforcement"
      ? [...getPotentiallyActionableUnitIds(state, activeTerrainCatalog.value, coreUnitCatalog)]
      : [];
    latestBoardDerivedMeasurement = {
      ...(latestBoardDerivedMeasurement?.sequence === state.sequence ? latestBoardDerivedMeasurement : {}),
      sequence: state.sequence,
      highlightDeriveMs: performance.now() - startedAt
    };
    return result;
  });
  const selectedIsPowered = computed(() => selectedUnit.value ? poweredUnitIds.value.includes(selectedUnit.value.id) : false);
  const isActionPhase = computed(() => game.value.turn.phase === "action");
  const isReinforcementPhase = computed(() => game.value.turn.phase === "reinforcement");
  const showHome = computed(() => activeRouteSection.value === "home" && !relayRoom);
  const showMaps = computed(() => activeRouteSection.value === "maps" && !relayRoom);
  const showWorkshop = computed(() => activeRouteSection.value === "workshop");
  const showLobby = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "lobby");
  const showRoomEntry = computed(() => activeRouteSection.value === "rooms"
    && (relayStatus.value === "未连接" || relayStatus.value === "连接失败" || relayStatus.value === "连接已断开"));
  watch(
    () => [activeRouteSection.value, subscribedTerrainModIds.value.join("\u0000"), getMapRequiredTerrainModIds().join("\u0000")] as const,
    ([currentPage]) => {
      if (currentPage === "rooms" && !invitedRoomId) connectWorkshopForLobbyModUpdates(true);
    }
  );
  watch(
    () => [activeRouteSection.value, configuredMaps.value.map((map) => map.definition.requiredTerrainModIds.join("\u0000")).join("\u0001"), subscribedTerrainModIds.value.join("\u0000")] as const,
    ([currentPage]) => {
      if (currentPage === "maps") connectWorkshopForMapPreviewUpdates();
    }
  );
  watch(
    () => [activeRouteSection.value, String(route.query.room ?? ""), relayStatus.value] as const,
    ([currentPage, roomQuery, status]) => {
      if (currentPage === "rooms" && !roomQuery && status !== "连接中…" && status !== "已连接") {
        void connectBattleLobby();
      } else if (currentPage !== "rooms" || roomQuery || status === "连接中…" || status === "已连接") {
        stopBattleLobby();
      }
    },
    { immediate: true }
  );
  const hasLiveSnapshot = ref(false);
  const showGame = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "playing" && hasLiveSnapshot.value);
  const showGameLoading = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "playing" && !hasLiveSnapshot.value);
  const missingLoadedModIds = computed(() => lobbyState.value.requiredTerrainModIds.filter(
    (id) => !resolveMapCatalogs(lobbyState.value.mapCode)?.mods?.[id]
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
    if (import.meta.env.DEV || window.location.port === "5173") {
      const hostname = window.location.hostname;
      const relayHost = ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? "127.0.0.1" : hostname;
      return `${protocol}://${relayHost}:2567`;
    }
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

  let pendingHostSnapshotCacheFrame = 0;
  let pendingHostSnapshotCacheTimer: number | undefined;

  /** Cache-only snapshots are recovery data, so let the local board paint first. */
  function scheduleHostSnapshotCacheUpdate(): void {
    if (pendingHostSnapshotCacheFrame || pendingHostSnapshotCacheTimer !== undefined) return;
    const flush = (): void => {
      if (pendingHostSnapshotCacheFrame) cancelAnimationFrame(pendingHostSnapshotCacheFrame);
      if (pendingHostSnapshotCacheTimer !== undefined) window.clearTimeout(pendingHostSnapshotCacheTimer);
      pendingHostSnapshotCacheFrame = 0;
      pendingHostSnapshotCacheTimer = undefined;
      if (!relayRoom || !relayIsHost.value || lobbyState.value.phase !== "playing" || !matchStore.game) return;
      const sequence = game.value.sequence;
      const startedAt = performance.now();
      broadcastSnapshot({ cacheOnly: true });
      logConnection("board.snapshot-cache-timing", {
        sequence,
        syncMs: performance.now() - startedAt,
        cellCount: Object.keys(game.value.cells).length,
        unitCount: Object.keys(game.value.units).length
      });
    };

    // The timer is a fallback for background tabs where requestAnimationFrame is
    // throttled. Active tabs flush in a task after the next render opportunity.
    pendingHostSnapshotCacheTimer = window.setTimeout(flush, 250);
    pendingHostSnapshotCacheFrame = requestAnimationFrame(() => {
      pendingHostSnapshotCacheFrame = 0;
      if (pendingHostSnapshotCacheTimer !== undefined) window.clearTimeout(pendingHostSnapshotCacheTimer);
      pendingHostSnapshotCacheTimer = window.setTimeout(flush, 0);
    });
  }

  function cancelHostSnapshotCacheUpdate(): void {
    if (pendingHostSnapshotCacheFrame) cancelAnimationFrame(pendingHostSnapshotCacheFrame);
    if (pendingHostSnapshotCacheTimer !== undefined) window.clearTimeout(pendingHostSnapshotCacheTimer);
    pendingHostSnapshotCacheFrame = 0;
    pendingHostSnapshotCacheTimer = undefined;
  }

  function broadcastSnapshot(resolution?: {
    readonly resolvedCommandId?: string;
    readonly errorMessage?: string;
    readonly reconcile?: boolean;
    readonly cacheOnly?: boolean;
  }): void {
    if (relayRoom && relayIsHost.value && lobbyState.value.phase === "playing" && matchStore.game) {
      try {
        relayRoom.send("host-snapshot", toNetworkPayload({
          state: toNetworkGameState(game.value),
          commandHeadId: commandTimeline.headId,
          clock: matchClock.value,
          hostSentAtEpochMs: Date.now(),
          ...resolution
        }));
        if (resolution?.cacheOnly !== true) {
          logConnection("snapshot.sent", { sequence: game.value.sequence, phase: game.value.turn.phase });
        }
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
    const startedAt = performance.now();
    const before = game.value;
    const envelope = commandTimeline.envelope(command);
    const engineStartedAt = performance.now();
    const result = applyCommand(game.value, command, activeTerrainCatalog.value, coreUnitCatalog, coreMatchConditionCatalog);
    const engineMs = performance.now() - engineStartedAt;
    if (!result.accepted) {
      pendingBoardCommandMeasurement = {
        commandType: command.type,
        commandRejected: 1,
        engineMs,
        commandTotalMs: performance.now() - startedAt
      };
      return result;
    }
    const stateCommitStartedAt = performance.now();
    if (!applyResult(result, quiet)) {
      pendingBoardCommandMeasurement = {
        commandType: command.type,
        commandRejected: 1,
        engineMs,
        stateCommitMs: performance.now() - stateCommitStartedAt,
        commandTotalMs: performance.now() - startedAt
      };
      return result;
    }
    const stateCommitMs = performance.now() - stateCommitStartedAt;
    const bookkeepingStartedAt = performance.now();
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
    const localBookkeepingMs = performance.now() - bookkeepingStartedAt;
    let intentSendMs = 0;
    let hostSnapshotScheduleMs = 0;
    if (relayRoom) {
      try {
        const intentSendStartedAt = performance.now();
        relayRoom.send("player-intent", { ...envelope, playerId: relayPlayerId.value });
        intentSendMs = performance.now() - intentSendStartedAt;
        if (relayIsHost.value) {
          const snapshotScheduleStartedAt = performance.now();
          scheduleHostSnapshotCacheUpdate();
          hostSnapshotScheduleMs = performance.now() - snapshotScheduleStartedAt;
        }
      } catch (error) {
        logConnection("intent.send-failed", { commandId: command.commandId, message: String(error).slice(0, 250) });
        requestCommandRepair("操作未能同步，正在恢复连接状态。");
      }
    }
    pendingBoardCommandMeasurement = {
      commandType: command.type,
      engineMs,
      stateCommitMs,
      localBookkeepingMs,
      intentSendMs,
      hostSnapshotScheduleMs,
      commandTotalMs: performance.now() - startedAt
    };
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
      if (isCurrentRoomRoute(roomId)) {
        returnToBattleHall(roomId, "房间连接已失效，已返回战斗大厅；公开房间列表正在重新加载。");
      } else {
        relayStatus.value = "连接已断开";
        notice.value = "自动重连未成功。房间可能已失效；请用房间号手动重试，或返回主页新建房间。";
      }
      return;
    }
    const delay = [800, 1_600, 3_000, 5_000, 8_000][attempt - 1]!;
    logConnection("reconnect.scheduled", { roomId, attempt, delayMs: delay });
    relayStatus.value = "连接已断开";
    notice.value = `连接中断，${Math.ceil(delay / 1_000)} 秒后自动重连（${attempt}/5）…`;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (relayRoom || activeRouteSection.value !== "rooms") return;
      void connectRelay("join", roomId, attempt);
    }, delay);
  }

  function parseBattleRoom(roomId: unknown, raw: unknown): BattleRoomListing | undefined {
    if (typeof roomId !== "string" || !roomId || !raw || typeof raw !== "object") return;
    const cache = raw as Record<string, unknown>;
    const rawMetadata = cache.metadata;
    const metadata = rawMetadata && typeof rawMetadata === "object"
      ? rawMetadata as Record<string, unknown>
      : {};
    if (metadata.visibility !== "public") return;
    return {
      roomId,
      clients: typeof cache.clients === "number" ? cache.clients : 0,
      locked: cache.locked === true,
      metadata
    };
  }

  function stopBattleLobby(): void {
    battleLobbyAttempt += 1;
    const room = battleLobbyRoom.value;
    battleLobbyRoom.value = undefined;
    if (room) void room.leave();
    publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "reset" });
    battleLobbyStatus.value = "offline";
    battleLobbyError.value = "";
  }

  function isCurrentRoomRoute(roomId: string): boolean {
    return activeRouteSection.value === "rooms" && String(route.query.room ?? "") === roomId;
  }

  /** A dead direct-room URL otherwise suppresses the public lobby subscription. */
  function returnToBattleHall(roomId: string, message: string): void {
    if (!isCurrentRoomRoute(roomId)) return;
    cancelReconnect();
    connectionAttempt += 1;
    const room = relayRoom;
    relayRoom = undefined;
    if (room) void room.leave();
    relayStatus.value = "连接失败";
    relayRoomId.value = "";
    roomIdInput.value = "";
    relayPlayerId.value = null;
    relayAccountId.value = null;
    relaySessionId.value = null;
    relayRoleReceived.value = false;
    relayIsHost.value = false;
    hasLiveSnapshot.value = false;
    pendingMatchStartPayload = null;
    commandTimeline.reset(null);
    isRepairing.value = false;
    boardInteraction.clear();
    notice.value = message;
    // Removing ?room= is what lets the battle-lobby watcher reconnect and
    // repopulate public rooms after a direct join expires or is rejected.
    void router.replace({ path: "/rooms", query: withoutRoomInvite(route.query) });
  }

  async function connectBattleLobby(): Promise<void> {
    if (battleLobbyRoom.value || battleLobbyStatus.value === "connecting") return;
    // A disconnected LobbyRoom snapshot is never authoritative. Hide its cache
    // while reconnecting instead of briefly presenting rooms that no longer exist.
    publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "reset" });
    battleLobbyStatus.value = "connecting";
    battleLobbyError.value = "";
    const attempt = ++battleLobbyAttempt;
    try {
      const client = new Client(resolveRelayEndpoint());
      const room = await client.joinOrCreate("lobby", {
        filter: { name: "pvp", metadata: { visibility: "public" } }
      });
      if (attempt !== battleLobbyAttempt || activeRouteSection.value !== "rooms" || route.query.room || relayStatus.value === "已连接") {
        void room.leave();
        return;
      }
      battleLobbyRoom.value = room;
      battleLobbyStatus.value = "connected";
      room.onMessage("rooms", (payload: unknown) => {
        if (attempt !== battleLobbyAttempt) return;
        const listings = Array.isArray(payload)
          ? payload.flatMap((entry) => {
            const listing = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
            return parseBattleRoom(listing.roomId, entry) ?? [];
          })
          : [];
        publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "snapshot", rooms: listings });
      });
      room.onMessage("+", (payload: unknown) => {
        if (attempt !== battleLobbyAttempt || !Array.isArray(payload)) return;
        const listing = parseBattleRoom(payload[0], payload[1]);
        const roomId = payload[0];
        if (listing) {
          publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "upsert", room: listing });
        } else if (typeof roomId === "string") {
          // A public room that becomes private or stops matching the filter must
          // disappear from the current public listing immediately.
          publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "remove", roomId });
        }
      });
      room.onMessage("-", (roomId: unknown) => {
        if (attempt === battleLobbyAttempt && typeof roomId === "string") {
          publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "remove", roomId });
        }
      });
      room.onLeave(() => {
        if (attempt !== battleLobbyAttempt) return;
        battleLobbyRoom.value = undefined;
        publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "reset" });
        battleLobbyStatus.value = "error";
        battleLobbyError.value = "与战斗大厅的连接已断开，请刷新列表重试。";
      });
      room.onError((_code, message) => {
        if (attempt !== battleLobbyAttempt) return;
        battleLobbyRoom.value = undefined;
        publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "reset" });
        battleLobbyStatus.value = "error";
        battleLobbyError.value = message || "战斗大厅连接失败，请刷新列表重试。";
        void room.leave();
      });
      // Re-request after handlers are attached so the first room snapshot is
      // never lost if it raced the LobbyRoom JOIN acknowledgment.
      room.send("filter", { name: "pvp", metadata: { visibility: "public" } });
    } catch (error) {
      if (attempt !== battleLobbyAttempt) return;
      publicBattleRooms.value = updateBattleRoomListings(publicBattleRooms.value, { type: "reset" });
      battleLobbyStatus.value = "error";
      battleLobbyError.value = error instanceof Error ? error.message : "战斗大厅连接失败，请检查网络后重试。";
    }
  }

  function refreshBattleLobby(): void {
    if (battleLobbyRoom.value) {
      battleLobbyRoom.value.send("filter", {
        name: "pvp",
        metadata: { visibility: "public" }
      });
      return;
    }
    void connectBattleLobby();
  }

  async function connectRelay(mode: "create" | "join", requestedRoomId?: string, reconnectAttempt = 0): Promise<boolean> {
    if (relayRoom) return false;
    stopBattleLobby();
    cancelReconnect();
    const attempt = ++connectionAttempt;
    relayEndpoint = resolveRelayEndpoint();
    logConnection("connect.begin", { mode, roomId: requestedRoomId ?? null, retry: reconnectAttempt, endpoint: relayEndpointForLog(relayEndpoint) });
    relayStatus.value = "连接中…";
    lobbyError.value = "";
    relayRoleReceived.value = false;
    relayPlayerId.value = null;
    relayAccountId.value = null;
    pendingMatchStartPayload = null;
    try {
      const client = new Client(relayEndpoint);
      const options = {
        name: playerName.value,
        accountId: relayAccountKey,
        ...(mode === "create" ? { mapCode: configuredMaps.value.find((map) => map.definition.id === selectedMapLibraryId.value)?.code } : {})
      };
      const room = mode === "join" && requestedRoomId
        ? await client.joinById(requestedRoomId, options)
        : await client.create("pvp", options);
      if (attempt !== connectionAttempt) {
        void room.leave();
        return false;
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
        relayRoleReceived.value = true;
        relayPlayerId.value = payload.playerId ?? null;
        relayAccountId.value = payload.accountId ?? null;
        relayIsHost.value = Boolean(payload.isHost);
        logConnection("room.role", { host: payload.isHost, playerId: payload.playerId ?? null, seat: payload.seat });
        flushPendingMatchStart();
      });
      room.onMessage("room-state", (payload: LobbyRoomState) => {
        const wasPlaying = lobbyState.value.phase === "playing";
        const normalizedPayload = payload;
        lobbyState.value = normalizedPayload;
        if (normalizedPayload.requiredTerrainModIds.length > 0) connectWorkshopForLobbyModUpdates();
        if (normalizedPayload.phase === "lobby") {
          const catalogCheckKey = `${relayRoomId.value}\u0000${[...normalizedPayload.requiredTerrainModIds].sort().join("\u0000")}`;
          const refreshModCatalog = wasPlaying || catalogCheckKey !== lastLobbyModCatalogCheckKey;
          lastLobbyModCatalogCheckKey = catalogCheckKey;
          if (normalizedPayload.requiredTerrainModIds.length > 0) connectWorkshopForLobbyModUpdates(refreshModCatalog);
        }
        const ownMember = normalizedPayload.members.find((member) => member.sessionId === relaySessionId.value);
        if (ownMember) {
          relayRoleReceived.value = true;
          relayPlayerId.value = ownMember.participating && ownMember.seat !== null
            ? `player-${ownMember.seat}`
            : null;
          relayAccountId.value = ownMember.accountId;
          relayIsHost.value = ownMember.isHost;
          flushPendingMatchStart();
        }
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
          sequence: matchStore.game?.sequence ?? null,
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
          sequence: matchStore.game?.sequence ?? null,
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
          host: relayIsHost.value, localSequence: matchStore.game?.sequence ?? null,
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
        const result = applyCommand(game.value, payload.command, activeTerrainCatalog.value, coreUnitCatalog, coreMatchConditionCatalog);
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
        if (relayIsHost.value) scheduleHostSnapshotCacheUpdate();
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
        const currentGame = matchStore.game;
        if (currentGame && payload.state.sequence < currentGame.sequence) {
          logConnection("snapshot.ignored-stale", {
            sequence: payload.state.sequence,
            currentSequence: currentGame.sequence,
            handoff: payload.handoff === true
          });
          if (relayIsHost.value && payload.handoff) broadcastSnapshot();
          return;
        }
        if (missingLoadedModIds.value.length > 0) {
          logConnection("snapshot.missing-mods", { missingModIds: missingLoadedModIds.value });
          notice.value = `正在从服务器加载对局所需地块：${missingLoadedModIds.value.join("、")}…`;
          requestTerrainModDefinitions(missingLoadedModIds.value);
          return;
        }
        logConnection("snapshot.received", {
          sequence: payload.state.sequence,
          handoff: payload.handoff === true,
          selfIsHost: relayIsHost.value,
          previousSequence: currentGame?.sequence ?? null
        });
        // Snapshots are recovery only; routine player actions travel as commands.
        if (!isRepairing.value && hasLiveSnapshot.value && payload.handoff !== true
          && currentGame && payload.state.sequence === currentGame.sequence) return;
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
          selfIsHost: relayIsHost.value, sequence: matchStore.game?.sequence ?? null, replacedByAnotherTab,
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
        relayRoleReceived.value = false;
        pendingMatchStartPayload = null;
        relayIsHost.value = false;
        hasLiveSnapshot.value = false;
        commandTimeline.reset(null);
        isRepairing.value = false;
        if (replacedByAnotherTab) {
          cancelReconnect();
          const message = "同一浏览器身份已在另一个标签页进入此房间；本标签页已退出，已返回战斗大厅。";
          if (isCurrentRoomRoute(room.roomId)) returnToBattleHall(room.roomId, message);
          else notice.value = message;
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
      return true;
    } catch (error) {
      if (attempt !== connectionAttempt) return false;
      logConnection("connect.failed", {
        mode, roomId: requestedRoomId ?? null, retry: reconnectAttempt,
        error: error instanceof Error ? error.message.slice(0, 250) : String(error).slice(0, 250)
      });
      const errorMessage = error instanceof Error ? error.message : "请检查后端地址";
      if (mode === "join" && requestedRoomId && reconnectAttempt === 0 && isCurrentRoomRoute(requestedRoomId)) {
        returnToBattleHall(requestedRoomId, `无法进入此房间（${errorMessage}），已返回战斗大厅。`);
      } else {
        relayStatus.value = "连接失败";
        notice.value = `PvP 房间连接失败：${errorMessage}`;
        if (reconnectAttempt > 0 && requestedRoomId) scheduleReconnect(requestedRoomId, reconnectAttempt + 1);
      }
      return false;
    }
  }

  function startFromHome(): void {
    const normalizedName = playerName.value.trim().slice(0, 24) || randomPlayerName();
    setPlayerNameAndPersonalMaps(normalizedName);
    void router.push({ path: "/rooms", query: route.query });
  }

  function updatePlayerName(value: string): void {
    const normalizedName = value.trim().slice(0, 24);
    if (!normalizedName) {
      playerName.value = value;
      return;
    }
    setPlayerNameAndPersonalMaps(normalizedName);
    if (showMaps.value || showWorkshop.value) {
      void ensureWorkshopClient().connect({ name: normalizedName }).then((connected) => {
        if (connected) syncPersonalMaps(normalizedName);
      });
    }
  }

  function openMapLibrary(): void {
    void router.push("/maps");
  }

  const requestedTerrainModIds = new Set<string>();
  const pendingSubscriptionChanges = new Map<string, boolean>();

  function getMapRequiredTerrainModIds(): string[] {
    return [...new Set(configuredMaps.value.flatMap((map) => map.definition.requiredTerrainModIds))];
  }

  function requiredModIdsFromCode(code: string): string[] {
    try {
      const data: unknown = JSON.parse(code);
      if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
      const ids = (data as { requiredTerrainModIds?: unknown }).requiredTerrainModIds;
      return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string"))] : [];
    } catch { return []; }
  }

  function requestTerrainModDefinitions(modIds: readonly string[]): void {
    const client = workshopClient;
    if (!client?.connected) return;
    for (const id of new Set(modIds)) {
      if (loadedTerrainMods.some((mod) => mod.id === id) || requestedTerrainModIds.has(id)) continue;
      const entry = remoteTerrainMods.value.find((candidate) => candidate.modId === id);
      if (entry && client.requestDetail("terrain-mod", entry.id)) requestedTerrainModIds.add(id);
    }
  }

  function requestedTerrainModIdsForCurrentUse(): string[] {
    return [...new Set([
      ...subscribedTerrainModIds.value,
      ...getMapRequiredTerrainModIds(),
      ...lobbyState.value.requiredTerrainModIds
    ])];
  }

  function ensureWorkshopClient(): WorkshopClient {
    if (!workshopClient) {
      workshopClient = new WorkshopClient(resolveRelayEndpoint(), {
        account: (account) => {
          workshopUserId.value = account.userId;
          subscribedTerrainModIds.value = [...account.subscribedModIds];
          setPlayerNameAndPersonalMaps(account.displayName);
          remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => ({
            ...entry, subscribed: account.subscribedModIds.includes(entry.modId ?? entry.id)
          }));
          requestTerrainModDefinitions(requestedTerrainModIdsForCurrentUse());
          syncPersonalMaps(account.displayName);
        },
        personalMaps: (payload: WorkshopPersonalMapsPayload) => {
          if (payload.userId !== workshopUserId.value) return;
          configuredMaps.value = reconcilePersonalMapLibrary(playerName.value, payload);
          if (!configuredMaps.value.some((map) => map.definition.id === selectedMapLibraryId.value)) {
            selectedMapLibraryId.value = configuredMaps.value[0]?.definition.id ?? "";
          }
          if (mapActionMessage.value.includes("同步账号")) {
            mapActionMessage.value = `个人地图已与工坊账号同步。${mapImportNotice.value}`;
            mapActionError.value = false;
          }
          // Keep edits made while the previous sync was in flight queued until
          // the server acknowledges their own operation IDs.
          const request = createPersonalMapSyncRequest(playerName.value);
          if (request.operations.length) syncPersonalMaps(playerName.value);
        },
        subscriptions: ({ userId, subscribedModIds }) => {
          if (userId !== workshopUserId.value) return;
          const nextIds = new Set(subscribedModIds);
          subscribedTerrainModIds.value = [...subscribedModIds];
          remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => ({
            ...entry, subscribed: subscribedModIds.includes(entry.modId ?? entry.id)
          }));
          for (const [modId, desired] of pendingSubscriptionChanges) {
            if (nextIds.has(modId) !== desired) continue;
            pendingSubscriptionChanges.delete(modId);
            workshopWorking.value = false;
            workshopActionError.value = false;
            workshopActionMessage.value = desired ? `已在服务器账号中订阅「${modId}」。` : `已在服务器账号中取消订阅「${modId}」。`;
          }
          requestTerrainModDefinitions(requestedTerrainModIdsForCurrentUse());
        },
        catalog: (catalog) => {
          remoteMapWorks.value = catalog.maps.map((entry) => ({ ...entry }));
          const currentIds = new Set(subscribedTerrainModIds.value);
          const latest = latestTerrainModVersions(catalog.terrainMods).map((entry) => ({
            ...entry, subscribed: currentIds.has(entry.modId)
          }));
          remoteTerrainMods.value = latest;
          requestTerrainModDefinitions(requestedTerrainModIdsForCurrentUse());
        },
        detail: (detail) => {
          if (detail.kind === "map") {
            remoteMapWorks.value = remoteMapWorks.value.map((entry) => entry.id === detail.entry.id
              ? { ...entry, ...detail.entry } : entry);
            requestTerrainModDefinitions(requiredModIdsFromCode(detail.entry.code));
            return;
          }
          if (detail.entry.definition) {
            try {
              validateTerrainModObject(detail.entry.definition);
              registerServerTerrainModDefinition(detail.entry.definition, detail.entry.name);
              requestedTerrainModIds.delete(detail.entry.modId ?? detail.entry.definition.id);
            } catch (error) {
              workshopActionError.value = true;
              workshopActionMessage.value = error instanceof Error ? error.message : "服务器返回的地块 Mod 无效。";
              return;
            }
          }
          remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.id === detail.entry.id
            ? { ...entry, ...detail.entry, subscribed: subscribedTerrainModIds.value.includes(detail.entry.modId ?? detail.entry.id) }
            : entry);
          if (pendingRoomModUpdateId.value === detail.entry.modId) {
            pendingRoomModUpdateId.value = null;
            roomModUpdateMessage.value = `已从服务器加载「${detail.entry.modId}」的当前版本。`;
          }
          if (pendingMatchStartPayload && relayRoleReceived.value) flushPendingMatchStart();
        },
        preview: (payload: WorkshopTerrainModPreview) => {
          remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.id === payload.id
            ? { ...entry, preview: payload.preview } : entry);
        },
        published: (published) => {
          workshopWorking.value = false;
          workshopActionError.value = false;
          workshopActionMessage.value = published.kind === "map" ? "地图码已发布到创意工坊。" : "地块 Mod 已发布到服务器数据库。";
          pendingWorkshopModUpdate.value = false;
          workshopClient?.requestList();
        },
        error: (message) => {
          workshopWorking.value = false;
          pendingWorkshopModUpdate.value = false;
          if (pendingRoomModUpdateId.value) {
            pendingRoomModUpdateId.value = null;
            roomModUpdateMessage.value = message;
          }
          workshopActionError.value = true;
          workshopActionMessage.value = message;
          if (message.includes("个人地图")) {
            mapActionError.value = true;
            mapActionMessage.value = message;
          }
        },
        status: (status) => {
          workshopStatus.value = status;
          if (status === "offline") {
            requestedTerrainModIds.clear();
            workshopUserId.value = null;
          }
          if (status === "connected" && workshopActionMessage.value === "创意工坊尚未连接。") {
            workshopActionMessage.value = "";
            workshopActionError.value = false;
          }
        }
      });
    }
    return workshopClient;
  }

  async function connectWorkshopForLobbyModUpdates(refreshCatalog = false): Promise<void> {
    if (activeRouteSection.value !== "rooms") return;
    const client = ensureWorkshopClient();
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    setPlayerNameAndPersonalMaps(name);
    if (!await client.connect({ name })) return;
    requestTerrainModDefinitions(lobbyState.value.requiredTerrainModIds);
    if (refreshCatalog) client.requestList();
  }

  async function connectWorkshopForMapPreviewUpdates(): Promise<void> {
    if (!showMaps.value) return;
    const client = ensureWorkshopClient();
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    setPlayerNameAndPersonalMaps(name);
    if (!await client.connect({ name })) return;
    client.requestList();
    requestTerrainModDefinitions(requestedTerrainModIdsForCurrentUse());
  }

  async function openWorkshop(): Promise<boolean> {
    await router.push("/workshop");
    const client = ensureWorkshopClient();
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    setPlayerNameAndPersonalMaps(name);
    const connected = await client.connect({ name });
    if (connected) client.requestList();
    return connected;
  }

  function selectWorkshopMap(id: string): void {
    const entry = remoteMapWorks.value.find((candidate) => candidate.id === id);
    if (entry && !entry.code) workshopClient?.requestDetail("map", id);
  }

  function selectWorkshopTerrainMod(id: string): void {
    const entry = remoteTerrainMods.value.find((candidate) => candidate.id === id || candidate.modId === id);
    if (entry && !entry.definition) workshopClient?.requestDetail("terrain-mod", entry.id);
  }

  function terrainModDisplayName(definition: import("@numeral-lord/content-schema").TerrainModDefinition): string {
    return remoteTerrainMods.value.find((entry) => entry.modId === definition.id)?.name
      ?? loadedTerrainMods.find((mod) => mod.id === definition.id)?.terrain?.displayName
      ?? definition.id.slice(4).replace(/-/g, " ");
  }

  async function openWorkshopForMissingTerrainMod(id: string): Promise<void> {
    workshopReturnRoute.value = route.fullPath;
    pendingWorkshopTerrainModId.value = id;
    if (await openWorkshop()) selectWorkshopTerrainMod(id);
  }

  function returnFromWorkshop(): void {
    const returnRoute = workshopReturnRoute.value;
    workshopReturnRoute.value = null;
    if (returnRoute) void router.push(returnRoute);
    else requestHome();
  }

  async function subscribeWorkshopTerrainMod(definition: import("@numeral-lord/content-schema").TerrainModDefinition): Promise<void> {
    try {
      validateTerrainModObject(definition);
      const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
      setPlayerNameAndPersonalMaps(name);
      const client = ensureWorkshopClient();
      if (!await client.connect({ name })) throw new Error("创意工坊尚未连接，无法保存订阅。");
      pendingSubscriptionChanges.set(definition.id, true);
      workshopWorking.value = true;
      workshopActionError.value = false;
      workshopActionMessage.value = `正在把「${definition.id}」订阅保存到服务器账号…`;
      if (!client.setSubscription(definition.id, true)) throw new Error("订阅请求未能发送到服务器。");
    } catch (error) {
      pendingSubscriptionChanges.delete(definition.id);
      workshopWorking.value = false;
      workshopActionError.value = true;
      workshopActionMessage.value = error instanceof Error ? error.message : "保存订阅失败。";
    }
  }

  function updateRoomModVersion(modId: string): void {
    if (loadedTerrainMods.some((mod) => mod.id === modId)) return;
    pendingRoomModUpdateId.value = modId;
    roomModUpdateMessage.value = `正在从服务器加载「${modId}」的当前 Mod…`;
    const client = ensureWorkshopClient();
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    setPlayerNameAndPersonalMaps(name);
    void client.connect({ name }).then((connected) => {
      if (!connected) return;
      client.requestList();
      requestTerrainModDefinitions([modId]);
    });
  }

  async function unsubscribeWorkshopTerrainMod(id: string): Promise<void> {
    if (!subscribedTerrainModIds.value.includes(id)) return;
    if (!window.confirm(`取消「${id}」的服务器账号订阅？订阅只控制地图编辑器的可选地块；已有地图和房间仍会从服务器读取当前 Mod。`)) return;
    workshopWorking.value = true;
    pendingSubscriptionChanges.set(id, false);
    const client = ensureWorkshopClient();
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    setPlayerNameAndPersonalMaps(name);
    if (!await client.connect({ name }) || !client.setSubscription(id, false)) {
      pendingSubscriptionChanges.delete(id);
      workshopWorking.value = false;
      workshopActionError.value = true;
      workshopActionMessage.value = "创意工坊尚未连接，取消订阅请求未能发送。";
    }
  }

  function clearPendingWorkshopTerrainMod(id: string): void {
    if (pendingWorkshopTerrainModId.value === id) pendingWorkshopTerrainModId.value = null;
  }

  function saveWorkshopMap(code: string): void {
    try {
      const next = addMapToLibrary(configuredMaps.value, code, playerName.value);
      configuredMaps.value = next;
      selectedMapLibraryId.value = next.at(-1)?.definition.id ?? "";
      const syncRequested = syncPersonalMaps();
      workshopActionError.value = false;
      workshopActionMessage.value = syncRequested
        ? `「${next.at(-1)?.definition.name ?? "地图"}」已保存到本机缓存，正在同步账号。`
        : `「${next.at(-1)?.definition.name ?? "地图"}」已保存到本机缓存，联网后同步账号。`;
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
    pendingWorkshopModUpdate.value = Boolean(entry.updateId);
    workshopActionMessage.value = entry.updateId ? "正在发布地块 Mod 更新…" : "正在发布地块 Mod…";
    workshopActionError.value = false;
  }

  async function addConfiguredMap(rawCode: string): Promise<boolean> {
    if (mapImporting.value) return false;
    mapImporting.value = true;
    mapImportNotice.value = "";
    const identity = normalizedWorkshopName(playerName.value);
    try {
      const imported = await normalizeImportedMapCode(rawCode);
      if (identity !== normalizedWorkshopName(playerName.value)) throw new Error("导入期间玩家账号已切换，请重新导入地图。");
      const next = addMapToLibrary(configuredMaps.value, imported.code, playerName.value);
      configuredMaps.value = next;
      selectedMapLibraryId.value = next.at(-1)?.definition.id ?? "";
      const syncRequested = syncPersonalMaps();
      mapActionMessage.value = syncRequested
        ? `「${next.at(-1)?.definition.name ?? "地图"}」已保存到本机缓存，正在同步账号。`
        : `「${next.at(-1)?.definition.name ?? "地图"}」已保存到本机缓存，联网后同步账号。`;
      mapImportNotice.value = imported.legacy ? ` 原版地图码已转换为当前格式。${imported.warnings.join(" ")}` : "";
      mapActionMessage.value += mapImportNotice.value;
      mapActionError.value = false;
      return true;
    } catch (error) {
      mapActionMessage.value = error instanceof Error ? error.message : "地图码无法导入。";
      mapActionError.value = true;
      return false;
    } finally {
      mapImporting.value = false;
    }
  }

  function saveConfiguredMap(definition: import("@numeral-lord/core-content").MapDefinition): void {
    mapImportNotice.value = "";
    try {
      const next = saveMapToLibrary(configuredMaps.value, serializeMapCode(definition, { ...runtimeMapCatalogs, allowUnknownTerrainMods: true }), playerName.value);
      configuredMaps.value = next;
      selectedMapLibraryId.value = definition.id;
      const syncRequested = syncPersonalMaps();
      mapActionMessage.value = syncRequested
        ? `「${definition.name}」已保存到本机缓存，正在同步账号。`
        : `「${definition.name}」已保存到本机缓存，联网后同步账号。`;
      mapActionError.value = false;
    } catch (error) {
      mapActionMessage.value = error instanceof Error ? error.message : "地图无法保存。";
      mapActionError.value = true;
    }
  }

  function removeConfiguredMap(id: string): void {
    mapImportNotice.value = "";
    const removed = configuredMaps.value.find((map) => map.definition.id === id);
    configuredMaps.value = removeMapFromLibrary(configuredMaps.value, id, playerName.value);
    selectedMapLibraryId.value = configuredMaps.value[0]?.definition.id ?? "";
    const syncRequested = removed ? syncPersonalMaps() : false;
    mapActionMessage.value = removed ? syncRequested
      ? `「${removed.definition.name}」已从本机移除，正在同步账号。`
      : `「${removed.definition.name}」已从本机移除，删除将在联网后同步账号。` : "";
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
    relayRoleReceived.value = false;
    pendingMatchStartPayload = null;
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
      mapPlayerCount: 0,
      mapCode: "",
      mapName: "",
      requiredTerrainModIds: [],
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

  async function quickMatch(): Promise<void> {
    if (battleLobbyWorking.value) return;
    battleLobbyWorking.value = true;
    battleLobbyError.value = "";
    try {
      const target = quickMatchRoom.value;
      if (target) {
        const connected = await connectRelay("join", target.roomId);
        if (connected) return;
        battleLobbyError.value = "刚才的房间可能已满，正在为你创建新的公开房间。";
      }
      createRoom();
    } finally {
      battleLobbyWorking.value = false;
    }
  }

  async function joinPublicBattleRoom(room: BattleRoomListing): Promise<void> {
    roomIdInput.value = room.roomId;
    const connected = await connectRelay("join", room.roomId);
    // Retry remains available in the manual room-code field. Do not pin a dead
    // public room id in the hall's retry banner after its card has gone stale.
    if (!connected && roomIdInput.value === room.roomId) roomIdInput.value = "";
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
    if (!relayRoleReceived.value) {
      pendingMatchStartPayload = payload;
      logConnection("match.waiting-for-room-role", { roomId: relayRoomId.value });
      return;
    }
    const requiredModIds = requiredModIdsFromCode(payload.mapCode);
    const missingModIds = requiredModIds.filter((id) => !loadedTerrainMods.some((mod) => mod.id === id));
    if (missingModIds.length > 0) {
      pendingMatchStartPayload = payload;
      hasLiveSnapshot.value = false;
      notice.value = `正在从服务器加载本局地块：${missingModIds.join("、")}…`;
      logConnection("match.waiting-for-server-mods", { missingModIds });
      const client = ensureWorkshopClient();
      const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
      setPlayerNameAndPersonalMaps(name);
      void client.connect({ name }).then((connected) => {
        if (!connected) return;
        client.requestList();
        requestTerrainModDefinitions(missingModIds);
      });
      return;
    }
    pendingMatchStartPayload = null;
    commandTimeline.reset(null);
    isRepairing.value = false;
    const playerId = resolveCurrentPlayerId(relaySessionId.value, payload.assignments, {
      received: relayRoleReceived.value,
      playerId: relayPlayerId.value
    });
    relayPlayerId.value = playerId;
    const ownMember = lobbyState.value.members.find((member) => member.sessionId === relaySessionId.value);
    const assignments = [...payload.assignments];
    if (playerId && !assignments.some((candidate) => candidate.playerId === playerId)) {
      const seat = ownMember?.seat ?? Number(playerId.replace(/^player-/, ""));
      if (Number.isInteger(seat) && seat > 0) {
        assignments.push({
          sessionId: relaySessionId.value ?? "",
          seat,
          playerId,
          displayName: ownMember?.displayName ?? playerName.value,
          ...(ownMember?.playerColorId ? { playerColorId: ownMember.playerColorId } : {})
        });
      }
    }
    const assignment = playerId ? assignments.find((candidate) => candidate.playerId === playerId) : undefined;
    logConnection("match.role-resolved", {
      roleReceived: relayRoleReceived.value,
      playerId,
      assignmentFound: Boolean(assignment),
      assignmentSessionMatches: assignment?.sessionId === relaySessionId.value
    });
    try {
      const exactMapCatalogs = resolveMapCatalogs(payload.mapCode);
      if (!exactMapCatalogs) throw new Error("无法从服务器解析本局使用的地块 Mod。");
      matchStore.setGame(createMatchFromMapCode(payload.mapCode, {
      ...exactMapCatalogs,
      activePlayerIds: assignments.map((candidate) => candidate.playerId as PlayerId),
      playerDisplayNames: Object.fromEntries(assignments.map((candidate) => [
        candidate.playerId,
        candidate.displayName ?? lobbyState.value.members.find((member) => member.sessionId === candidate.sessionId)?.displayName ?? `玩家 ${candidate.seat}`
      ])),
      playerColors: Object.fromEntries(assignments.flatMap((candidate) => {
        const color = getPlayerColor(candidate.playerColorId);
        return color ? [[candidate.playerId, color]] : [];
      })),
      friendlyFire: payload.settings.friendlyFire,
      roomModSettings: payload.roomModSettings ?? {}
      }));
    } catch (error) {
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

  function flushPendingMatchStart(): void {
    if (!relayRoleReceived.value || !pendingMatchStartPayload) return;
    const payload = pendingMatchStartPayload;
    pendingMatchStartPayload = null;
    startLobbyMatch(payload);
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

  function onCellClick(cellId: CellId, boardCellHitTestMs?: number): void {
    const inputStartedAt = performance.now();
    const sequenceBefore = game.value.sequence;
    pendingBoardCommandMeasurement = undefined;
    pendingLegalPreviewMs = undefined;
    try {
      handleBoardCellClick(cellId);
    } finally {
      const handlerMs = performance.now() - inputStartedAt;
      const commandMeasurement = pendingBoardCommandMeasurement;
      const legalPreviewMs = pendingLegalPreviewMs;
      pendingBoardCommandMeasurement = undefined;
      pendingLegalPreviewMs = undefined;
      void nextTick()
        .then(afterAnimationFrame)
        .then(() => {
          // This is the input-to-first-paint opportunity. Waiting for a second
          // animation frame inflated the logged "latency" by another refresh
          // interval (roughly 16.7 ms at 60 Hz) even though the UI was already
          // interactive on the first frame.
          const inputToFirstFrameMs = performance.now() - inputStartedAt;
          const paint = latestBoardPaintMeasurement?.sequence === game.value.sequence
            ? latestBoardPaintMeasurement
            : undefined;
          logConnection("board.input-timing", {
            cellId,
            sequenceBefore,
            sequenceAfter: game.value.sequence,
            boardCellHitTestMs: boardCellHitTestMs ?? null,
            handlerMs,
            inputToFirstFrameMs,
            legalPreviewMs: legalPreviewMs ?? null,
            boardDrawMs: paint?.boardDrawMeasuredAt !== undefined && paint.boardDrawMeasuredAt >= inputStartedAt
              ? paint.boardDrawMs ?? null
              : null,
            layoutMs: paint?.boardDrawMeasuredAt !== undefined && paint.boardDrawMeasuredAt >= inputStartedAt
              ? paint.layoutMs ?? null
              : null,
            terrainDrawMs: paint?.boardDrawMeasuredAt !== undefined && paint.boardDrawMeasuredAt >= inputStartedAt
              ? paint.terrainDrawMs ?? null
              : null,
            unitDrawMs: paint?.boardDrawMeasuredAt !== undefined && paint.boardDrawMeasuredAt >= inputStartedAt
              ? paint.unitDrawMs ?? null
              : null,
            labelDrawMs: paint?.boardDrawMeasuredAt !== undefined && paint.boardDrawMeasuredAt >= inputStartedAt
              ? paint.labelDrawMs ?? null
              : null,
            interactionDrawMs: paint?.interactionDrawMeasuredAt !== undefined && paint.interactionDrawMeasuredAt >= inputStartedAt
              ? paint.interactionDrawMs ?? null
              : null,
            poweredDeriveMs: paint?.poweredDeriveMs ?? null,
            actionableDeriveMs: paint?.actionableDeriveMs ?? null,
            highlightDeriveMs: paint?.highlightDeriveMs ?? null,
            cellCount: paint?.cellCount ?? Object.keys(game.value.cells).length,
            unitCount: paint?.unitCount ?? Object.keys(game.value.units).length,
            unitCellsRebuilt: paint?.unitCellsRebuilt ?? null,
            unitCellsReused: paint?.unitCellsReused ?? null,
            pulsesRebuilt: paint?.pulsesRebuilt ?? null,
            ...(commandMeasurement ?? {})
          });
        });
    }
  }

  function handleBoardCellClick(cellId: CellId): void {
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
    const legalPreviewStartedAt = performance.now();
    const legalDestinations = getLegalActionDestinationIds(game.value, unit.id, activeTerrainCatalog.value, coreUnitCatalog);
    pendingLegalPreviewMs = performance.now() - legalPreviewStartedAt;
    if (legalDestinations.length === 0) {
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
      ...activeMapCatalogs.value,
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
      logConnection("snapshot.sync-request", { roomId: relayRoom.roomId, initial: false, sequence: matchStore.game?.sequence ?? null });
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
    if (showMaps.value || showWorkshop.value || showRoomEntry.value) {
      const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
      setPlayerNameAndPersonalMaps(name);
      if (showMaps.value || showWorkshop.value) void ensureWorkshopClient().connect({ name });
      else connectWorkshopForLobbyModUpdates(true);
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
    cancelHostSnapshotCacheUpdate();
    window.removeEventListener("online", logBrowserConnectionState);
    window.removeEventListener("offline", logBrowserConnectionState);
    document.removeEventListener("visibilitychange", logBrowserConnectionState);
    window.removeEventListener("error", logBrowserError);
    window.removeEventListener("unhandledrejection", logUnhandledRejection);
    if (clockTimer) clearInterval(clockTimer);
    relayRoom?.leave();
    void workshopClient?.leave();
  });

    // 按页面拆分能力，路由视图只拿自己需要的状态和操作。
    return {
      shell: {
        showHome, showMaps, showWorkshop, showRoomEntry, showLobby, showGame, showGameLoading,
        hoveredTeamColor, currentPlayer, teamColors, relayStatus, relayRoomId, relayIsHost, isSpectator, battleLobbyStatus,
        relayPlayerId, stepClockLabel, matchClockLabel, configuredMaps, workshopStatus, publicBattleRooms,
        lobbyState, privateReservePlayer, privateReserveIncome, gameOptionsOpen, gameActionsOpen, game,
        registerGameBoard, zoomBoard, requestHome, openNotationDialog, resetMatch
      },
      dialogs: {
        leaveDialogOpen, relayIsHost, leaveToHome, notationDialogOpen, notationText, latestContinuation,
        notationCopyMessage, copyNotation, connectionLogDialogOpen, connectionLogText,
        connectionLogCopyMessage, copyConnectionLog
      },
      home: { playerName, updatePlayerName, startFromHome, openMapLibrary, openWorkshop },
      maps: {
        configuredMaps, selectedMapLibraryId, mapActionMessage, mapActionError, mapImporting, subscribedModIds: subscribedTerrainModIds,
        requestHome, addConfiguredMap, saveConfiguredMap, removeConfiguredMap
      },
      workshop: {
        workshopTerrainMods, workshopMapWorks, configuredMaps,
        subscribedTerrainModIds, playerName, pendingWorkshopTerrainModId, workshopActionMessage,
        workshopActionError, workshopWorking, workshopPublishingEnabled, returnFromWorkshop,
        selectWorkshopMap, selectWorkshopTerrainMod, saveWorkshopMap, publishWorkshopMap,
        publishWorkshopTerrainMod, subscribeWorkshopTerrainMod,
        unsubscribeWorkshopTerrainMod, clearPendingWorkshopTerrainMod,
        requestTerrainModPreview(id: string) { workshopClient?.requestTerrainModPreview(id); },
        uploadTerrainAsset(dataUrl: string) { return ensureWorkshopClient().uploadTerrainAsset(dataUrl); },
        downloadTerrainAsset(url: string) { return ensureWorkshopClient().downloadTerrainAsset(url); }
      },
      rooms: {
        showRoomEntry, battleLobbyStatus, publicBattleRooms, sortedPublicBattleRooms, refreshBattleLobby,
        battleLobbyError, relayStatus, battleLobbyWorking, joinPublicBattleRoom, quickMatch, createRoom,
        roomIdInput, joinRoom, playerName, configuredMaps, notice, showLobby, lobbyState, relayRoomId,
        relaySessionId, lobbyPreviewState, lobbyPreviewPoweredUnitIds, activeTerrainCatalog,
        activeTerrainVisualAssets, lobbyError, pendingRoomModUpdateId, roomModUpdateMessage,
        pendingSubscribedModUpdateIds, sendLobbyReady, sendLobbySeat, sendLobbyParticipation,
        sendLobbyColor, sendLobbySettings, sendLobbyModSettings, sendLobbyAssignment, sendLobbyMap,
        openWorkshopForMissingTerrainMod, updateRoomModVersion, showGameLoading, missingLoadedModIds,
        showGame, isMatchFinished, matchResultTitle, matchResultMessage, relayIsHost,
        resetMatch, players, currentPlayer, hoveredTeamId, disconnectedPlayerIds,
        teamColors, publicBoardPoints, onPlayerCardPointerEnter, clearPlayerCardHover, game,
        selectedUnitId, legalActionCellIds, counterattackCellIds, noCounterattackCellIds,
        actionableUnitIds, highlightedUnitIds, poweredUnitIds, hoveredPlayerId, onCellClick, onBoardDrawMeasured,
        onInteractionDrawMeasured, clearSelection, onCellPressStart, onCellPressEnd,
        isActionPhase, isReinforcementPhase, canActCurrentPlayer, isSpectator, isRepairing,
        endActionPhase, endReinforcementPhase, registerGameBoard
      }
    };
}
