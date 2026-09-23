<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Client, type Room } from "@colyseus/sdk";
import {
  applyCommand,
  DEFAULT_LOBBY_SETTINGS,
  finishMatch,
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
  type MatchStartPayload,
  type CommandResult,
  type NotationEntry,
  type PlayerId,
  type PlayerState,
  type UnitId
} from "@numeral-lord/game-core";
import {
  coreMatchConditionCatalog,
  coreTerrainCatalog,
  coreUnitCatalog,
  oilFieldTerrainCatalog
} from "@numeral-lord/core-content";
import HexBoard from "./components/HexBoard.vue";
import LobbyPanel from "./components/LobbyPanel.vue";
import { createDemoMatch } from "@numeral-lord/core-content";

// The preview explicitly installs the optional oil-field Mod. A different
// map can keep only `coreTerrainCatalog` and omit this merge entirely.
const installedTerrainCatalog = { ...coreTerrainCatalog, ...oilFieldTerrainCatalog };
const PLAYER_NAME_STORAGE_KEY = "numeral-lord.player-name";
const ACCOUNT_ID_STORAGE_KEY = "numeral-lord.account-id";

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

const game = ref(createDemoMatch());
const playerName = ref(loadOrCreateLocalValue(PLAYER_NAME_STORAGE_KEY, randomPlayerName));
const relayAccountKey = loadOrCreateLocalValue(ACCOUNT_ID_STORAGE_KEY, createCommandId);
const invitedRoomId = new URLSearchParams(window.location.search).get("room")?.trim() ?? "";
// A room link is already an explicit game entry. Only the bare site URL shows
// the name/start home page; invite links join immediately with the saved (or
// freshly generated) local name.
const hasStartedFromHome = ref(Boolean(invitedRoomId));
const relayStatus = ref(invitedRoomId ? "连接中…" : "未连接");
const relayRoomId = ref("");
const roomIdInput = ref("");
const relayPlayerId = ref<string | null>(null);
const relayAccountId = ref<string | null>(null);
const relaySessionId = ref<string | null>(null);
const relayIsHost = ref(false);
let relayRoom: Room | undefined;
let relayEndpoint = "";
const clockNow = ref(Date.now());
const matchStartedAtEpochMs = ref<number | null>(null);
const stepStartedAtEpochMs = ref<number | null>(null);
let clockTimer: ReturnType<typeof setInterval> | undefined;
let expiredStepSequence: number | null = null;
const initialMapPlayerCount = Object.keys(game.value.players).length;
const lobbyState = ref<LobbyRoomState>({
  phase: "lobby",
  mapPlayerCount: initialMapPlayerCount,
  settings: { ...DEFAULT_LOBBY_SETTINGS },
  members: []
});
const selectedUnitId = ref<UnitId | null>(null);
/** Cell captured at selection time; notation never infers an attacker from a later click. */
const selectedSourceCellId = ref<CellId | null>(null);
/** Only a real user selection can contribute a source-coordinate click to notation. */
const selectedByUser = ref(false);
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
const showHome = computed(() => !hasStartedFromHome.value && !relayRoom);
const showLobby = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "lobby");
const showRoomEntry = computed(() => hasStartedFromHome.value
  && (relayStatus.value === "未连接" || relayStatus.value === "连接失败" || relayStatus.value === "连接已断开"));
const showGame = computed(() => relayStatus.value === "已连接" && lobbyState.value.phase === "playing");
const isSpectator = computed(() => lobbyState.value.phase === "playing" && relayPlayerId.value === null);
const canActCurrentPlayer = computed(() => !relayRoom || (lobbyState.value.phase === "playing"
  && relayPlayerId.value === currentPlayer.value?.id));
const stepSecondsRemaining = computed(() => remainingSeconds(
  stepStartedAtEpochMs.value,
  lobbyState.value.settings.turnTimeSeconds * 1_000
));
const matchSecondsRemaining = computed(() => remainingSeconds(
  matchStartedAtEpochMs.value,
  lobbyState.value.settings.matchTimeMinutes * 60_000
));
const stepClockLabel = computed(() => isMatchFinished.value
  ? "已停止"
  : formatClock(stepSecondsRemaining.value, lobbyState.value.settings.turnTimeSeconds === 0));
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
  return `${protocol}://${window.location.host}/numeral-lord`;
}

function remainingSeconds(startedAt: number | null, durationMs: number): number | null {
  if (durationMs === 0 || startedAt === null) return null;
  return Math.max(0, Math.ceil((startedAt + durationMs - clockNow.value) / 1_000));
}

function formatClock(seconds: number | null, unlimited: boolean): string {
  if (unlimited || seconds === null) return "不限时";
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function resetStepClock(startedAt = Date.now()): void {
  stepStartedAtEpochMs.value = startedAt;
  expiredStepSequence = null;
}

function broadcastSnapshot(): void {
  if (relayRoom && relayIsHost.value && lobbyState.value.phase === "playing") {
    relayRoom.send("host-snapshot", {
      state: game.value,
      stepStartedAtEpochMs: stepStartedAtEpochMs.value
    });
  }
}

function submitRemoteCommand(command: GameCommand): boolean {
  if (!relayRoom || relayIsHost.value) return false;
  relayRoom.send("player-intent", { playerId: relayPlayerId.value, command });
  notice.value = "操作已发送给房主，等待权威棋盘同步。";
  clearSelectionSilently();
  return true;
}

function canCurrentClientAct(): boolean {
  if (!relayRoom) return true;
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

async function connectRelay(mode: "create" | "join", requestedRoomId?: string): Promise<void> {
  if (relayRoom) return;
  relayEndpoint = resolveRelayEndpoint();
  relayStatus.value = "连接中…";
  try {
    const client = new Client(relayEndpoint);
    const options = {
      name: playerName.value,
      accountId: relayAccountKey,
      mapPlayerCount: initialMapPlayerCount
    };
    const room = mode === "join" && requestedRoomId
      ? await client.joinById(requestedRoomId, options)
      : await client.create("pvp", options);
    relayRoom = room;
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
    });
    room.onMessage("room-state", (payload: LobbyRoomState) => {
      lobbyState.value = payload;
      if (payload.startedAtEpochMs !== undefined) matchStartedAtEpochMs.value = payload.startedAtEpochMs;
      if (payload.phase === "lobby") {
        clearSelectionSilently();
        notice.value = "选择参战位置并准备；只要参战玩家全部准备即可开始。";
      }
    });
    room.onMessage("lobby-error", (payload: { message?: string }) => {
      notice.value = payload.message ?? "房间设置没有生效。";
    });
    room.onMessage("match-start", (payload: MatchStartPayload) => {
      startLobbyMatch(payload);
    });
    room.onMessage("snapshot-request", () => {
      if (relayIsHost.value) broadcastSnapshot();
    });
    room.onMessage("room-host", (payload: { sessionId?: string }) => {
      relayIsHost.value = payload.sessionId === room.sessionId;
      if (relayIsHost.value && lobbyState.value.phase === "playing") broadcastSnapshot();
    });
    room.onMessage("player-intent", (payload: { playerId?: string; command?: GameCommand }) => {
      if (!relayIsHost.value || !payload.command) return;
      const active = currentPlayer.value;
      if (!active || payload.command.actorId !== active.id) return;
      const result = applyCommand(game.value, payload.command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
      applyResult(result);
    });
    room.onMessage("host-snapshot", (payload: { state?: typeof game.value; stepStartedAtEpochMs?: number | null }) => {
      if (relayIsHost.value || !payload.state) return;
      game.value = payload.state;
      if (typeof payload.stepStartedAtEpochMs === "number") resetStepClock(payload.stepStartedAtEpochMs);
      clearSelectionSilently();
      notice.value = "已收到房主的最新棋盘。";
    });
    room.onLeave(() => {
      relayStatus.value = "连接已断开";
      relayRoom = undefined;
      relayRoomId.value = "";
      relayPlayerId.value = null;
      relayAccountId.value = null;
      relaySessionId.value = null;
      relayIsHost.value = false;
    });
    // onJoin can emit identity before browser handlers are installed. This
    // explicit handshake makes first load, late spectating and refresh safe.
    room.send("room-sync", {});
  } catch (error) {
    relayStatus.value = "连接失败";
    notice.value = `PvP 房间连接失败：${error instanceof Error ? error.message : "请检查后端地址"}`;
  }
}

function startFromHome(): void {
  const normalizedName = playerName.value.trim().slice(0, 24) || randomPlayerName();
  playerName.value = normalizedName;
  localStorage.setItem(PLAYER_NAME_STORAGE_KEY, normalizedName);
  hasStartedFromHome.value = true;
  if (invitedRoomId) {
    roomIdInput.value = invitedRoomId;
    void connectRelay("join", invitedRoomId);
  }
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
  const assignment = payload.assignments.find((candidate) => candidate.sessionId === relaySessionId.value);
  relayPlayerId.value = assignment?.playerId ?? null;
  game.value = createDemoMatch({
    activePlayerIds: payload.assignments.map((candidate) => candidate.playerId as PlayerId),
    friendlyFire: payload.settings.friendlyFire
  });
  matchStartedAtEpochMs.value = payload.startedAtEpochMs;
  resetStepClock(payload.startedAtEpochMs);
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

function sendLobbyAssignment(payload: { sessionId: string; seat?: number | null; participating?: boolean }): void {
  relayRoom?.send("lobby-assign", payload);
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
  if (relayRoom && !relayIsHost.value) {
    notice.value = "只有房主可以重置联网对局。";
    return;
  }
  clearReinforcementHold();
  const activePlayerIds = lobbyState.value.members
    .filter((member) => member.participating && member.seat !== null)
    .map((member) => `player-${member.seat}` as PlayerId);
  game.value = createDemoMatch({
    ...(activePlayerIds.length > 0 ? { activePlayerIds } : {}),
    friendlyFire: lobbyState.value.settings.friendlyFire
  });
  matchStartedAtEpochMs.value = Date.now();
  resetStepClock(matchStartedAtEpochMs.value);
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

function applyResult(result: CommandResult, quiet = false): boolean {
  if (!result.accepted) {
    if (!quiet) notice.value = result.error.message;
    return false;
  }
  game.value = result.state;
  resetStepClock();
  broadcastSnapshot();
  if (!quiet) notice.value = result.events.at(-1)?.message ?? "操作完成。";
  return true;
}

function tickClocks(): void {
  clockNow.value = Date.now();
  if (!relayRoom || !relayIsHost.value || lobbyState.value.phase !== "playing" || isMatchFinished.value) return;

  if (matchSecondsRemaining.value === 0) {
    game.value = finishMatch(game.value, "局时耗尽，本局结束。");
    clearSelectionSilently();
    notice.value = "局时耗尽，本局结束。";
    broadcastSnapshot();
    return;
  }
  if (stepSecondsRemaining.value !== 0 || expiredStepSequence === game.value.sequence) return;
  expiredStepSequence = game.value.sequence;
  const active = currentPlayer.value;
  if (!active || !isActionPhase.value && !isReinforcementPhase.value) return;
  const phase = isActionPhase.value ? "action" : "reinforcement";
  const command: GameCommand = {
    type: isActionPhase.value ? "end-action-phase" : "end-reinforcement-phase",
    commandId: createCommandId(),
    actorId: active.id,
    expectedSequence: game.value.sequence
  };
  const result = applyCommand(game.value, command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
  if (applyResult(result, true) && result.accepted) {
    recordSpecial(phase);
    clearSelectionSilently();
    notice.value = phase === "action"
      ? "本步计时结束，已自动进入加点回合。"
      : "本步计时结束，已自动轮到下一位玩家。";
  }
}

onMounted(() => {
  clockTimer = setInterval(tickClocks, 250);
  if (invitedRoomId) {
    roomIdInput.value = invitedRoomId;
    void connectRelay("join", invitedRoomId);
  }
});
onBeforeUnmount(() => {
  clearReinforcementHold();
  if (clockTimer) clearInterval(clockTimer);
  relayRoom?.leave();
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div><p class="eyebrow">LOCAL RULES PROTOTYPE</p><h1>Numeral Lord</h1></div>
      <div class="topbar-meta">
        <div v-if="showHome" class="turn-pill"><span class="turn-dot" />设置名字，开始游戏</div>
        <div v-else-if="showRoomEntry" class="turn-pill"><span class="turn-dot" />创建房间或用房间号加入</div>
        <div v-else-if="relayStatus === '连接中…'" class="turn-pill"><span class="turn-dot" />正在连接 PvP 房间…</div>
        <div v-else-if="showLobby" class="turn-pill"><span class="turn-dot" />准备房间 · 地图 {{ lobbyState.mapPlayerCount }} 个玩家位</div>
        <div v-else class="turn-pill" :style="{ '--player-color': currentPlayer?.color }"><span class="turn-dot" />第 {{ game.turn.round }} 回合 · {{ currentPlayer?.displayName }} · {{ phaseLabel }} · 步 {{ stepClockLabel }} · 局 {{ matchClockLabel }}</div>
        <div class="network-pill" :class="{ connected: relayStatus === '已连接' }">PvP {{ relayStatus }}<span v-if="relayRoomId"> · 房间 {{ relayRoomId }}</span><span v-if="relayIsHost"> · 房主</span><span v-else-if="isSpectator"> · 观战</span><span v-else-if="relayPlayerId"> · {{ relayPlayerId }}</span></div>
      </div>
    </header>

    <section v-if="showHome" class="room-entry home-entry">
      <div class="entry-copy">
        <p class="entry-kicker">WELCOME</p>
        <h2>准备进入 Numeral Lord</h2>
        <p>这个名字会显示在准备房间和对局成员列表中。首次进入时已经为你随机生成，可随时修改。</p>
      </div>
      <form class="entry-actions" @submit.prevent="startFromHome">
        <label class="name-field">
          <span>玩家名字</span>
          <input v-model="playerName" type="text" maxlength="24" autocomplete="nickname" aria-label="玩家名字" />
        </label>
        <button class="primary" type="submit">开始游戏</button>
      </form>
    </section>

    <section v-else-if="showRoomEntry" class="room-entry">
      <div class="entry-copy">
        <p class="entry-kicker">ONLINE MATCH</p>
        <h2>创建或加入房间</h2>
        <p>创建者成为房主；其他人输入房间号加入。对局开始后仍可用同一房间号进入观战。</p>
      </div>
      <div class="entry-actions">
        <button class="primary" @click="createRoom">创建新房间</button>
        <div class="join-row">
          <input v-model.trim="roomIdInput" type="text" autocomplete="off" placeholder="输入房间号" aria-label="房间号" @keyup.enter="joinRoom" />
          <button class="secondary" @click="joinRoom">加入房间</button>
        </div>
        <p v-if="relayStatus === '连接失败' || relayStatus === '连接已断开'" class="entry-error">{{ notice }}</p>
      </div>
    </section>

    <section v-else-if="relayStatus === '连接中…'" class="room-entry connecting-card">
      <div class="entry-copy"><p class="entry-kicker">CONNECTING</p><h2>正在进入房间…</h2><p>正在同步成员、地图玩家位和当前棋盘。</p></div>
    </section>

    <LobbyPanel
      v-else-if="showLobby"
      :room="lobbyState"
      :room-id="relayRoomId"
      :self-session-id="relaySessionId"
      :preview-state="game"
      :preview-powered-unit-ids="poweredUnitIds"
      @ready="sendLobbyReady"
      @seat="sendLobbySeat"
      @participation="sendLobbyParticipation"
      @settings="sendLobbySettings"
      @assign="sendLobbyAssignment"
    />

    <section v-if="showGame && isMatchFinished" class="match-result" role="status" aria-live="polite">
      <div>
        <p class="result-kicker">MATCH FINISHED · 对局结束</p>
        <h2>{{ matchResultTitle }}</h2>
        <p>{{ matchResultMessage }}</p>
      </div>
      <button v-if="relayStatus !== '已连接' || relayIsHost" class="primary" @click="resetMatch">重新开始演示对局</button>
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
        <button v-if="relayStatus !== '已连接' || relayIsHost" class="ghost" @click="resetMatch">重置演示对局</button>
        <button class="ghost notation-trigger" @click="openNotationDialog">查看 / 复制本地棋谱</button>
      </aside>
    </section>
    <footer>规则在客户端运行；联网房间由 Colyseus 负责房间、账户席位和广播，房主快照作为冲突时的权威结果。</footer>

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
  </main>
</template>
