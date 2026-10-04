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
  DEFAULT_MAP_CODE,
  DEFAULT_MAP_DEFINITION,
  coreMatchConditionCatalog,
  coreUnitCatalog,
  createMatchFromMapCode,
  serializeMapCode
} from "@numeral-lord/core-content";
import HexBoard from "../components/HexBoard.vue";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "../workshop/types";
import type { WorkshopTerrainModPreview } from "@numeral-lord/content-schema";
import { addMapToLibrary, loadMapLibrary, removeMapFromLibrary, saveMapToLibrary } from "../maps/map-library";
import {
  hydrateInstalledTerrainMods,
  registerInstalledTerrainModObject,
  installedTerrainModContentHashes,
  validateTerrainModObject,
  bundledTerrainModIds,
  installTerrainModObject,
  installedMapCatalogs,
  installedTerrainCatalog,
  installedTerrainMods,
  terrainVisualAssetsForCatalogs,
  cachedTerrainModReleases,
  cacheInstalledTerrainModRelease,
  resolveMapCatalogs,
  terrainModDefinitionObject
} from "../content/installed-content";
import { WorkshopClient, type WorkshopConnectionStatus } from "../workshop/workshop-client";
import { canApplySubscribedModUpdate, compareModVersions, latestTerrainModVersions, mapTerrainModUpdateCandidates, mergeWorkshopTerrainCatalog, terrainModUpdateCandidates } from "../workshop/workshop-terrain-catalog";
import { shouldConnectWorkshopOnStartup } from "../workshop/workshop-startup";
import { cacheTerrainModRelease, loadModSubscriptions, subscribeToTerrainMod, terrainModContentHash, unsubscribeFromTerrainMod, updateSubscribedMod } from "../content/mod-installation";
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

export function useAppRuntime() {
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
  if (!matchStore.game) matchStore.setGame(createMatchFromMapCode(DEFAULT_MAP_CODE, installedMapCatalogs));
  const game = computed(() => matchStore.game!);
  const commandTimeline = createCommandTimeline();
  const isRepairing = ref(false);
  const playerName = ref(loadOrCreateLocalValue(PLAYER_NAME_STORAGE_KEY, randomPlayerName));
  const configuredMaps = ref(loadMapLibrary());
  const installedModsHydrated = ref(false);
  const selectedMapLibraryId = ref(configuredMaps.value[0]?.definition.id ?? "");
  const mapActionMessage = ref("");
  const mapActionError = ref(false);
  const gameBoardRef = ref<InstanceType<typeof HexBoard> | null>(null);
  function registerGameBoard(board: InstanceType<typeof HexBoard> | null): void { gameBoardRef.value = board; }
  function zoomBoard(action: "in" | "out" | "reset"): void {
    if (action === "in") gameBoardRef.value?.zoomIn();
    else if (action === "out") gameBoardRef.value?.zoomOut();
    else gameBoardRef.value?.resetZoom();
  }
  const builtInTerrainMod: TerrainModEntry = {
    id: "local:mod-oil-field",
    modId: installedTerrainMods[0]!.id,
    name: "油田",
    version: installedTerrainMods[0]!.version,
    description: "占据时每回合产生 2 点；离开时留下 1 点游兵。不导电。这个地块由独立的 oil-field-mod 包提供。",
    terrainId: installedTerrainMods[0]!.terrain?.id ?? "mod/oil-field",
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
  const remoteTerrainModReleases = ref<TerrainModEntry[]>([]);
  const remoteMapWorks = ref<MapWorkshopEntry[]>([]);
  const localInstalledTerrainMods = computed<TerrainModEntry[]>(() => installedTerrainMods.map((mod) => ({
    id: `local-installed:${mod.id}`,
    modId: mod.id,
    name: mod.terrain?.displayName ?? mod.id,
    version: mod.version,
    contentHash: terrainModContentHash(terrainModDefinitionObject(mod)),
    description: mod.id === "mod-desert-terrain"
      ? "沿用平原的驻兵、导电和战斗规则；驻在沙漠上的单位不产生回合点数。"
      : "本机已安装的地块 Mod。连接工坊后可同步作品信息与更新。",
    terrainId: mod.terrain?.id ?? `mod/${mod.id.slice(4)}`,
    installed: true,
    authorName: "本机安装",
    definition: terrainModDefinitionObject(mod)
  })));
  const workshopTerrainMods = computed(() => mergeWorkshopTerrainCatalog(
    remoteTerrainMods.value,
   [builtInTerrainMod],
    localInstalledTerrainMods.value
  ));
  const workshopMapWorks = computed(() => [builtInMapWork, ...remoteMapWorks.value]);
  const workshopStatus = ref<WorkshopConnectionStatus>("offline");
  // 客户端可显示发布入口，是否接受写入由当前环境的服务器开关决定。
  const workshopPublishingEnabled = true;
  const workshopActionMessage = ref("");
  const workshopActionError = ref(false);
  const workshopWorking = ref(false);
  const pendingWorkshopModUpdate = ref(false);
  const subscribedTerrainModIds = ref<string[]>([]);
  const pendingSubscribedModUpdateIds = ref<string[]>([]);
  const pendingWorkshopTerrainModId = ref<string | null>(null);
  const pendingRoomModUpdateId = ref<string | null>(null);
  const roomModUpdateMessage = ref("");
  let workshopClient: WorkshopClient | undefined;
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
  const initialMapPlayerCount = DEFAULT_MAP_DEFINITION.players;
  const lobbyState = ref<LobbyRoomState>({
    phase: "lobby",
    mapPlayerCount: initialMapPlayerCount,
    mapCode: DEFAULT_MAP_CODE,
    mapName: DEFAULT_MAP_DEFINITION.name,
    requiredTerrainModIds: DEFAULT_MAP_DEFINITION.requiredTerrainModIds,
    effectiveTerrainModReleases: [],
    modVersionMismatchIds: [],
    roomModSettings: {},
    settings: { ...DEFAULT_LOBBY_SETTINGS },
    members: []
  });
  const lobbyError = ref("");
  const activeMapCatalogs = computed(() => resolveMapCatalogs(
    lobbyState.value.mapCode,
    lobbyState.value.effectiveTerrainModReleases
  ) ?? installedMapCatalogs);
  const activeTerrainCatalog = computed(() => activeMapCatalogs.value.terrains ?? installedTerrainCatalog);
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
    () => [activeRouteSection.value, subscribedTerrainModIds.value.join("\u0000")] as const,
    ([currentPage, subscriptionIds]) => {
      if (currentPage === "rooms" && subscriptionIds && !invitedRoomId) connectWorkshopForLobbyModUpdates(true);
    }
  );
  watch(
    () => [activeRouteSection.value, configuredMaps.value.map((map) => map.definition.requiredTerrainModIds.join("\u0000")).join("\u0001"), subscribedTerrainModIds.value.join("\u0000")] as const,
    ([currentPage]) => {
      if (currentPage === "maps" && installedModsHydrated.value) connectWorkshopForMapPreviewUpdates();
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
  const missingLocalModIds = computed(() => lobbyState.value.requiredTerrainModIds.filter(
    (id) => !resolveMapCatalogs(lobbyState.value.mapCode, lobbyState.value.effectiveTerrainModReleases)?.mods?.[id]
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
      if (!relayRoom || !relayIsHost.value || lobbyState.value.phase !== "playing") return;
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
    if (relayRoom && relayIsHost.value && lobbyState.value.phase === "playing") {
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
        installedModIds: installedTerrainMods.map((mod) => mod.id),
        installedModVersions: Object.fromEntries(installedTerrainMods.map((mod) => [mod.id, mod.version])),
        installedModContentHashes: installedTerrainModContentHashes(),
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
        const normalizedPayload = { ...payload, effectiveTerrainModReleases: payload.effectiveTerrainModReleases ?? [] };
        lobbyState.value = normalizedPayload;
        if (normalizedPayload.phase === "lobby") {
          reportInstalledModsToRoom();
          const catalogCheckKey = `${relayRoomId.value}\u0000${[...normalizedPayload.requiredTerrainModIds].sort().join("\u0000")}`;
          const refreshModCatalog = wasPlaying || catalogCheckKey !== lastLobbyModCatalogCheckKey;
          lastLobbyModCatalogCheckKey = catalogCheckKey;
          connectWorkshopForLobbyModUpdates(refreshModCatalog);
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

  function ensureWorkshopClient(): WorkshopClient {
    if (!workshopClient) {
      workshopClient = new WorkshopClient(resolveRelayEndpoint(), {
        catalog: (catalog) => {
          remoteMapWorks.value = catalog.maps.map((entry) => ({ ...entry }));
          const toReleaseEntry = (entry: import("../workshop/workshop-client").WorkshopTerrainModSummary): TerrainModEntry => {
            const active = installedTerrainMods.find((mod) => mod.id === entry.modId);
            const cached = cachedTerrainModReleases.some((release) => release.id === entry.modId
              && release.version === entry.version && release.contentHash === entry.contentHash);
            return { ...entry, installed: active?.version === entry.version, cached };
          };
          const latest = latestTerrainModVersions(catalog.terrainMods);
          remoteTerrainModReleases.value = catalog.terrainMods.map(toReleaseEntry);
          remoteTerrainMods.value = latest.map(toReleaseEntry);
          void requestSubscribedModUpdates(latest);
          const pendingModId = pendingRoomModUpdateId.value;
          if (pendingModId) {
            const roomRelease = lobbyState.value.effectiveTerrainModReleases.find((candidate) => candidate.id === pendingModId);
            const entry = roomRelease ? catalog.terrainMods.find((candidate) => candidate.modId === pendingModId
              && candidate.version === roomRelease.version && candidate.contentHash === roomRelease.contentHash) : undefined;
            if (!entry) {
              pendingRoomModUpdateId.value = null;
              roomModUpdateMessage.value = roomRelease
                ? `创意工坊中未找到房主当前使用的「${pendingModId}」v${roomRelease.version}。`
                : "房间还没有收到房主的 Mod 版本信息，请稍后重试。";
            } else if (!workshopClient?.requestDetail("terrain-mod", entry.id)) {
              pendingRoomModUpdateId.value = null;
              roomModUpdateMessage.value = "无法请求地块 Mod 详情，请稍后重试。";
            }
          }
        },
        detail: (detail) => {
          if (detail.kind === "map") {
            remoteMapWorks.value = remoteMapWorks.value.map((entry) => entry.id === detail.entry.id
              ? { ...entry, ...detail.entry } : entry);
          } else {
            remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.id === detail.entry.id
              ? { ...entry, ...detail.entry } : entry);
            const existingRelease = remoteTerrainModReleases.value.some((entry) => entry.id === detail.entry.id);
            remoteTerrainModReleases.value = existingRelease
              ? remoteTerrainModReleases.value.map((entry) => entry.id === detail.entry.id ? { ...entry, ...detail.entry } : entry)
              : [{ ...detail.entry, installed: false, cached: false }, ...remoteTerrainModReleases.value];
            if (detail.entry.definition && pendingRoomModUpdateId.value === detail.entry.modId) {
              void installRoomModUpdate(detail.entry.definition);
            } else if (detail.entry.definition && remoteTerrainMods.value.some((entry) =>
              entry.id === detail.entry.id && entry.modId === detail.entry.definition!.id)) {
              void autoUpdateSubscribedMod(detail.entry.definition);
            }
            else if (pendingRoomModUpdateId.value === detail.entry.modId) {
              pendingRoomModUpdateId.value = null;
              roomModUpdateMessage.value = "工坊没有返回可安装的 Mod 版本。";
            }
          }
        },
        preview: (payload: WorkshopTerrainModPreview) => {
          const attachPreview = (entry: TerrainModEntry): TerrainModEntry => entry.id === payload.id
            ? { ...entry, preview: payload.preview }
            : entry;
          remoteTerrainMods.value = remoteTerrainMods.value.map(attachPreview);
          remoteTerrainModReleases.value = remoteTerrainModReleases.value.map(attachPreview);
        },
        published: (published) => {
          workshopWorking.value = false;
          workshopActionError.value = false;
          workshopActionMessage.value = published.kind === "map" ? "地图码已发布到创意工坊。"
            : pendingWorkshopModUpdate.value ? "地块 Mod 已更新，订阅玩家进入战斗大厅时会自动获取新版本。" : "地块 Mod 已发布供其他玩家预览。";
          pendingWorkshopModUpdate.value = false;
          workshopClient?.requestList();
        },
        error: (message) => {
          workshopWorking.value = false;
          pendingWorkshopModUpdate.value = false;
          if (pendingSubscribedModUpdateIds.value.length > 0) {
            pendingSubscribedModUpdateIds.value = [];
            if (activeRouteSection.value === "rooms" && lobbyState.value.phase === "lobby") {
              roomModUpdateMessage.value = `订阅 Mod 更新检查失败，已保留当前版本：${message}`;
            }
          }
          if (pendingRoomModUpdateId.value) {
            pendingRoomModUpdateId.value = null;
            roomModUpdateMessage.value = message;
          }
          workshopActionError.value = true;
          workshopActionMessage.value = message;
        },
        status: (status) => {
          workshopStatus.value = status;
          // A request may have raced the first join in an earlier navigation.
          // Once the room is live, don't leave that transient warning on screen.
          if (status === "connected" && workshopActionMessage.value === "创意工坊尚未连接。") {
            workshopActionMessage.value = "";
            workshopActionError.value = false;
          }
        }
      });
    }
    return workshopClient;
  }

  function connectWorkshopForLobbyModUpdates(refreshCatalog = false): void {
    const usesBundledMod = lobbyState.value.requiredTerrainModIds.some((id) => bundledTerrainModIds.has(id));
    if (activeRouteSection.value !== "rooms" || lobbyState.value.phase !== "lobby"
      || (subscribedTerrainModIds.value.length === 0 && !usesBundledMod)) return;
    ensureWorkshopClient();
    if (workshopClient?.connected) {
      if (refreshCatalog) workshopClient.requestList();
      return;
    }
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    playerName.value = name;
    void workshopClient?.connect({ name });
  }

  function getMapRequiredTerrainModIds(): string[] {
    return [...new Set(configuredMaps.value.flatMap((map) => map.definition.requiredTerrainModIds))];
  }

  function mapPreviewNeedsWorkshopUpdate(): boolean {
    return getMapRequiredTerrainModIds().some((id) => bundledTerrainModIds.has(id)
      || subscribedTerrainModIds.value.includes(id));
  }

  function connectWorkshopForMapPreviewUpdates(): void {
    if (!showMaps.value || !installedModsHydrated.value || !mapPreviewNeedsWorkshopUpdate()) return;
    const client = ensureWorkshopClient();
    if (client.connected) {
      client.requestList();
      return;
    }
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    playerName.value = name;
    void client.connect({ name });
  }

  async function openWorkshop(): Promise<boolean> {
    await router.push("/workshop");
    const client = ensureWorkshopClient();
    const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
    playerName.value = name;
    if (client.connected) {
      client.requestList();
      return true;
    }
    return client.connect({ name });
  }

  function selectWorkshopMap(id: string): void {
    if (id === builtInMapWork.id) return;
    const entry = remoteMapWorks.value.find((candidate) => candidate.id === id);
    if (entry && !entry.code) workshopClient?.requestDetail("map", id);
  }

  function selectWorkshopTerrainMod(id: string): void {
    if (id === builtInTerrainMod.id) return;
    const entry = remoteTerrainModReleases.value.find((candidate) => candidate.id === id)
      ?? remoteTerrainMods.value.find((candidate) => candidate.id === id || candidate.modId === id);
    if (entry && !entry.definition) workshopClient?.requestDetail("terrain-mod", entry.id);
  }

  function terrainModDisplayName(definition: import("@numeral-lord/content-schema").TerrainModDefinition): string {
    return remoteTerrainModReleases.value.find((entry) => entry.modId === definition.id && entry.version === definition.version)?.name
      ?? remoteTerrainMods.value.find((entry) => entry.modId === definition.id)?.name
      ?? installedTerrainMods.find((mod) => mod.id === definition.id)?.terrain?.displayName
      ?? definition.id.slice(4).replace(/-/g, " ");
  }

  async function cacheWorkshopTerrainModRelease(definition: import("@numeral-lord/content-schema").TerrainModDefinition): Promise<void> {
    try {
      validateTerrainModObject(definition);
      const name = terrainModDisplayName(definition);
      await cacheTerrainModRelease(definition, name);
      cacheInstalledTerrainModRelease(definition, name);
      remoteTerrainModReleases.value = remoteTerrainModReleases.value.map((entry) => entry.modId === definition.id
        && entry.version === definition.version ? { ...entry, cached: true, definition } : entry);
      workshopActionError.value = false;
      workshopActionMessage.value = `「${definition.id}」v${definition.version} 已缓存，可在房间要求该版本时使用。`;
    } catch (error) {
      workshopActionError.value = true;
      workshopActionMessage.value = error instanceof Error ? error.message : "缓存 Mod 版本失败。";
    }
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

  async function installWorkshopTerrainMod(definition: import("@numeral-lord/content-schema").TerrainModDefinition): Promise<void> {
    try {
      validateTerrainModObject(definition);
      const name = terrainModDisplayName(definition);
      await subscribeToTerrainMod(definition, name);
      registerInstalledTerrainModObject(definition, name);
      reportInstalledModsToRoom();
      if (!subscribedTerrainModIds.value.includes(definition.id)) subscribedTerrainModIds.value = [...subscribedTerrainModIds.value, definition.id];
      remoteTerrainModReleases.value = remoteTerrainModReleases.value.map((entry) => entry.modId === definition.id
        && entry.version === definition.version ? { ...entry, cached: true, definition } : entry);
      remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.modId === definition.id
        ? { ...entry, installed: true } : entry);
      workshopActionError.value = false;
      workshopActionMessage.value = `「${definition.id}」v${definition.version} 已安装并载入本机规则目录。`;
    } catch (error) {
      workshopActionError.value = true;
      workshopActionMessage.value = error instanceof Error ? error.message : "Mod 安装失败。";
    }
  }

  function reportInstalledModsToRoom(): void {
    if (!relayRoom || lobbyState.value.phase !== "lobby") return;
    const report = new Map(installedTerrainMods.map((mod) => [mod.id, mod]));
    // The host reports its active release; other members report the room's exact
    // selected release when already installed or cached, without downgrading
    // their global subscription version.
    const isRoomHost = lobbyState.value.members.some((member) => member.sessionId === relaySessionId.value && member.isHost);
    if (!isRoomHost) for (const roomRelease of lobbyState.value.effectiveTerrainModReleases) {
      const exact = [...installedTerrainMods.map(terrainModDefinitionObject), ...cachedTerrainModReleases.map((release) => release.definition)]
        .find((definition) => definition.id === roomRelease.id
          && definition.version === roomRelease.version
          && terrainModContentHash(definition) === roomRelease.contentHash);
      if (exact) report.set(roomRelease.id, exact as import("@numeral-lord/game-sdk").ModDefinition);
    }
    const reportedMods = [...report.values()];
    relayRoom.send("lobby-installed-mods", {
      installedModIds: reportedMods.map((mod) => mod.id),
      installedModVersions: Object.fromEntries(reportedMods.map((mod) => [mod.id, mod.version])),
      installedModContentHashes: Object.fromEntries(reportedMods.map((mod) => [mod.id,
        terrainModContentHash(terrainModDefinitionObject(mod) as import("@numeral-lord/content-schema").TerrainModDefinition)]))
    });
  }

  function updateRoomModVersion(modId: string): void {
    if (lobbyState.value.phase !== "lobby" || !lobbyState.value.modVersionMismatchIds.includes(modId)) return;
    pendingRoomModUpdateId.value = modId;
    const roomRelease = lobbyState.value.effectiveTerrainModReleases.find((candidate) => candidate.id === modId);
    if (!roomRelease) {
      pendingRoomModUpdateId.value = null;
      roomModUpdateMessage.value = "正在等待房主的 Mod 版本信息，请稍后重试。";
      return;
    }
    roomModUpdateMessage.value = `正在获取房主当前使用的「${modId}」v${roomRelease.version}…`;
    ensureWorkshopClient();
    if (workshopClient?.connected) workshopClient.requestList();
    else {
      const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
      playerName.value = name;
      void workshopClient?.connect({ name });
    }
  }

  async function installRoomModUpdate(definition: import("@numeral-lord/content-schema").TerrainModDefinition): Promise<void> {
    const modId = pendingRoomModUpdateId.value;
    if (!modId || definition.id !== modId) return;
    try {
      validateTerrainModObject(definition);
      const roomRelease = lobbyState.value.effectiveTerrainModReleases.find((candidate) => candidate.id === modId);
      if (!roomRelease) throw new Error("房间还没有收到房主的 Mod 版本信息，请稍后重试。");
      if (definition.version !== roomRelease.version || terrainModContentHash(definition) !== roomRelease.contentHash) {
        throw new Error(`房主当前使用「${modId}」v${roomRelease.version}，当前下载的 Mod 版本或内容不匹配。`);
      }
      const name = terrainModDisplayName(definition);
      await cacheTerrainModRelease(definition, name);
      cacheInstalledTerrainModRelease(definition, name);
      remoteTerrainModReleases.value = remoteTerrainModReleases.value.map((entry) => entry.modId === modId
        && entry.version === definition.version ? { ...entry, cached: true, definition } : entry);
      remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.modId === modId
        ? { ...entry, definition } : entry);
      reportInstalledModsToRoom();
      roomModUpdateMessage.value = roomRelease
        ? `已缓存房主使用的「${modId}」v${definition.version}，现在可以重新准备。`
        : `「${modId}」已更新到 v${definition.version}，全体玩家需要重新准备。`;
      logConnection("room.mods.quick-updated", { modId, version: definition.version, hostRelease: Boolean(roomRelease) });
    } catch (error) {
      roomModUpdateMessage.value = error instanceof Error ? error.message : "地块 Mod 快速更新失败。";
    } finally {
      pendingRoomModUpdateId.value = null;
    }
  }

  async function unsubscribeWorkshopTerrainMod(id: string): Promise<void> {
    if (!subscribedTerrainModIds.value.includes(id)) return;
    const dependentMaps = configuredMaps.value.filter((map) => map.definition.requiredTerrainModIds.includes(id));
    const inCurrentRoom = lobbyState.value?.requiredTerrainModIds.includes(id) ?? false;
    const impact = [
      dependentMaps.length ? `本机有 ${dependentMaps.length} 张地图依赖此 Mod` : "",
      inCurrentRoom ? "当前房间地图也需要此 Mod" : ""
    ].filter(Boolean).join("；");
    const warning = impact ? `\n\n${impact}。取消订阅不会卸载当前版本；更新订阅取消后，地图继续使用本机当前安装版本。` : "";
    if (!window.confirm(`取消「${id}」的自动更新订阅？本机已下载版本不会删除。${warning}`)) return;
    workshopWorking.value = true;
    try {
      await unsubscribeFromTerrainMod(id);
      subscribedTerrainModIds.value = subscribedTerrainModIds.value.filter((entry) => entry !== id);
      workshopActionError.value = false;
      workshopActionMessage.value = `已取消「${id}」的自动更新订阅，本机当前版本和地图依赖均保留。`;
    } catch (error) {
      workshopActionError.value = true;
      workshopActionMessage.value = error instanceof Error ? error.message : "取消订阅失败。";
    } finally {
      workshopWorking.value = false;
    }
  }

  function clearPendingWorkshopTerrainMod(id: string): void {
    if (pendingWorkshopTerrainModId.value === id) pendingWorkshopTerrainModId.value = null;
  }

  async function requestSubscribedModUpdates(entries: readonly import("../workshop/workshop-client").WorkshopTerrainModSummary[]): Promise<void> {
    try {
      // Published updates are checked in the workshop or battle lobby, never during a match.
      const mapLibraryIsOpen = showMaps.value;
      if (!canApplySubscribedModUpdate(showWorkshop.value, lobbyState.value.phase === "playing", activeRouteSection.value === "rooms", mapLibraryIsOpen)) return;
      const subscriptions = await loadModSubscriptions();
      if (!canApplySubscribedModUpdate(showWorkshop.value, lobbyState.value.phase === "playing", activeRouteSection.value === "rooms", showMaps.value)) return;
      subscribedTerrainModIds.value = subscriptions.map((entry) => entry.id);
      const updates = (showMaps.value
        ? mapTerrainModUpdateCandidates(entries, subscriptions, installedTerrainMods, bundledTerrainModIds, getMapRequiredTerrainModIds())
        : terrainModUpdateCandidates(
          entries,
          subscriptions,
          installedTerrainMods,
          bundledTerrainModIds,
          showWorkshop.value,
          activeRouteSection.value === "rooms" && lobbyState.value.phase === "lobby" ? lobbyState.value.requiredTerrainModIds : []
        )).filter(({ id }) => !pendingSubscribedModUpdateIds.value.includes(id));
      pendingSubscribedModUpdateIds.value = updates.map(({ id }) => id);
      if (updates.length > 0 && activeRouteSection.value === "rooms" && lobbyState.value.phase === "lobby") sendLobbyReady(false);
      for (const { id, entry } of updates) {
        if (!workshopClient?.requestDetail("terrain-mod", entry.id)) clearPendingSubscribedModUpdate(id);
      }
    } catch (error) {
      pendingSubscribedModUpdateIds.value = [];
      logConnection("mods.update-check.failed", { message: error instanceof Error ? error.message : String(error) });
      if (activeRouteSection.value === "rooms" && lobbyState.value.phase === "lobby") {
        roomModUpdateMessage.value = `Mod 更新检查失败，已保留当前版本：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  async function autoUpdateSubscribedMod(definition: import("@numeral-lord/content-schema").TerrainModDefinition): Promise<void> {
    try {
      const subscriptions = await loadModSubscriptions();
      // A catalog reply can arrive after the user has entered a match; recheck at apply time.
      if (!canApplySubscribedModUpdate(showWorkshop.value, lobbyState.value.phase === "playing", activeRouteSection.value === "rooms", showMaps.value)) return;
      const isSubscribed = subscriptions.some((entry) => entry.id === definition.id);
      const isRoomDependency = activeRouteSection.value === "rooms" && lobbyState.value.phase === "lobby"
        && lobbyState.value.requiredTerrainModIds.includes(definition.id);
      const isMapDependency = showMaps.value && getMapRequiredTerrainModIds().includes(definition.id);
      const isBundledUpdate = bundledTerrainModIds.has(definition.id)
        && (showWorkshop.value || isRoomDependency || isMapDependency);
      if (showMaps.value && !isMapDependency) return;
      if (!isSubscribed && !isBundledUpdate) return;
      const current = installedTerrainMods.find((mod) => mod.id === definition.id)?.version;
      if (current && compareModVersions(definition.version, current) <= 0) return;
      validateTerrainModObject(definition);
      const name = terrainModDisplayName(definition);
      if (isSubscribed) {
        await updateSubscribedMod(definition, name);
        registerInstalledTerrainModObject(definition, name);
      } else {
        // Store the server-authored release and its fetched artwork locally, but
        // do not silently create a user subscription for an app-bundled Mod.
        await installTerrainModObject(definition, name);
      }
      reportInstalledModsToRoom();
      logConnection("mods.updated", { modId: definition.id, version: definition.version });
      if (activeRouteSection.value === "rooms") roomModUpdateMessage.value = `已自动更新「${definition.id}」v${definition.version}；房间成员需统一版本后重新准备。`;
      remoteTerrainModReleases.value = remoteTerrainModReleases.value.map((entry) => entry.modId === definition.id
        && entry.version === definition.version ? { ...entry, cached: true, definition } : entry);
      remoteTerrainMods.value = remoteTerrainMods.value.map((entry) => entry.modId === definition.id
        ? { ...entry, installed: true } : entry);
    } catch (error) {
      logConnection("mods.update.failed", { modId: definition.id, message: error instanceof Error ? error.message : String(error) });
      if (activeRouteSection.value === "rooms") roomModUpdateMessage.value = error instanceof Error ? error.message : "Mod 自动更新失败。";
    } finally {
      clearPendingSubscribedModUpdate(definition.id);
    }
  }

  function clearPendingSubscribedModUpdate(id: string): void {
    pendingSubscribedModUpdateIds.value = pendingSubscribedModUpdateIds.value.filter((pendingId) => pendingId !== id);
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
    pendingWorkshopModUpdate.value = Boolean(entry.updateId);
    workshopActionMessage.value = entry.updateId ? "正在发布地块 Mod 更新…" : "正在发布地块 Mod…";
    workshopActionError.value = false;
  }

  function addConfiguredMap(rawCode: string): boolean {
    try {
      const next = addMapToLibrary(configuredMaps.value, rawCode);
      configuredMaps.value = next;
      selectedMapLibraryId.value = next.at(-1)?.definition.id ?? "";
      mapActionMessage.value = `「${next.at(-1)?.definition.name ?? "地图"}」已保存到本机。`;
      mapActionError.value = false;
      return true;
    } catch (error) {
      mapActionMessage.value = error instanceof Error ? error.message : "地图码无法导入。";
      mapActionError.value = true;
      return false;
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
      mapPlayerCount: initialMapPlayerCount,
      mapCode: DEFAULT_MAP_CODE,
      mapName: DEFAULT_MAP_DEFINITION.name,
      requiredTerrainModIds: DEFAULT_MAP_DEFINITION.requiredTerrainModIds,
      effectiveTerrainModReleases: [],
      modVersionMismatchIds: [],
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
    if (missingLocalModIds.value.length > 0) {
      hasLiveSnapshot.value = false;
      notice.value = `当前设备缺少地块 Mod：${missingLocalModIds.value.join("、")}。安装后才能进入对局。`;
      logConnection("match.missing-mods", { missingModIds: missingLocalModIds.value });
      return;
    }
    try {
      const exactMapCatalogs = resolveMapCatalogs(payload.mapCode, payload.effectiveTerrainModReleases ?? []);
      if (!exactMapCatalogs) throw new Error("无法解析房主为本局选择的地块 Mod 版本。");
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
      const subscriptions = await loadModSubscriptions();
      subscribedTerrainModIds.value = subscriptions.map((entry) => entry.id);
      installedModsHydrated.value = true;
      const checkBattleLobbySubscriptions = activeRouteSection.value === "rooms" && !invitedRoomId && subscriptions.length > 0;
      const checkMapPreviewDependencies = activeRouteSection.value === "maps" && mapPreviewNeedsWorkshopUpdate();
      if (shouldConnectWorkshopOnStartup(showWorkshop.value, checkBattleLobbySubscriptions, checkMapPreviewDependencies)) {
        ensureWorkshopClient();
        const name = playerName.value.trim().slice(0, 24) || randomPlayerName();
        playerName.value = name;
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
        configuredMaps, selectedMapLibraryId, mapActionMessage, mapActionError,
        requestHome, addConfiguredMap, saveConfiguredMap, removeConfiguredMap
      },
      workshop: {
        workshopTerrainMods, remoteTerrainModReleases, workshopMapWorks, configuredMaps,
        subscribedTerrainModIds, playerName, pendingWorkshopTerrainModId, workshopActionMessage,
        workshopActionError, workshopWorking, workshopPublishingEnabled, returnFromWorkshop,
        selectWorkshopMap, selectWorkshopTerrainMod, saveWorkshopMap, publishWorkshopMap,
        publishWorkshopTerrainMod, installWorkshopTerrainMod, cacheWorkshopTerrainModRelease,
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
        openWorkshopForMissingTerrainMod, updateRoomModVersion, showGameLoading, missingLocalModIds,
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
