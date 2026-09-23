<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Client, type Room } from "@colyseus/sdk";
import {
  applyCommand,
  getActionableUnitIds,
  getLegalActionDestinationIds,
  getPoweredUnitIds,
  appendActionNotation,
  appendPhaseEndNotation,
  appendReinforcementNotation,
  type CellId,
  type GameCommand,
  type CommandResult,
  type NotationEntry,
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
import { createDemoMatch } from "@numeral-lord/core-content";

// The preview explicitly installs the optional oil-field Mod. A different
// map can keep only `coreTerrainCatalog` and omit this merge entirely.
const installedTerrainCatalog = { ...coreTerrainCatalog, ...oilFieldTerrainCatalog };
const game = ref(createDemoMatch());
const relayStatus = ref("未连接");
const relayRoomId = ref("");
const relayPlayerId = ref<string | null>(null);
const relayIsHost = ref(false);
let relayRoom: Room | undefined;
let relayEndpoint = "";
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
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:2567`;
}

function broadcastSnapshot(): void {
  if (relayRoom && relayIsHost.value) relayRoom.send("host-snapshot", { state: game.value });
}

function submitRemoteCommand(command: GameCommand): boolean {
  if (!relayRoom || relayIsHost.value) return false;
  relayRoom.send("player-intent", { playerId: relayPlayerId.value, command });
  notice.value = "操作已发送给房主，等待权威棋盘同步。";
  clearSelectionSilently();
  return true;
}

async function connectRelay(): Promise<void> {
  if (relayRoom) return;
  relayEndpoint = resolveRelayEndpoint();
  relayStatus.value = "连接中…";
  try {
    const client = new Client(relayEndpoint);
    const room = await client.joinOrCreate("pvp", { name: "本地玩家" });
    relayRoom = room;
    relayRoomId.value = room.roomId;
    relayStatus.value = "已连接";
    room.onMessage("room-role", (payload: { playerId?: string; isHost?: boolean }) => {
      relayPlayerId.value = payload.playerId ?? null;
      relayIsHost.value = Boolean(payload.isHost);
      if (relayIsHost.value) broadcastSnapshot();
    });
    room.onMessage("room-host", (payload: { sessionId?: string }) => {
      relayIsHost.value = payload.sessionId === room.sessionId;
      if (relayIsHost.value) broadcastSnapshot();
    });
    room.onMessage("player-intent", (payload: { playerId?: string; command?: GameCommand }) => {
      if (!relayIsHost.value || !payload.command) return;
      const active = currentPlayer.value;
      if (!active || payload.command.actorId !== active.id) return;
      const result = applyCommand(game.value, payload.command, installedTerrainCatalog, coreUnitCatalog, coreMatchConditionCatalog);
      if (applyResult(result)) broadcastSnapshot();
    });
    room.onMessage("host-snapshot", (payload: { state?: typeof game.value }) => {
      if (relayIsHost.value || !payload.state) return;
      game.value = payload.state;
      clearSelectionSilently();
      notice.value = "已收到房主的最新棋盘。";
    });
    room.onLeave(() => {
      relayStatus.value = "连接已断开";
      relayRoom = undefined;
      relayRoomId.value = "";
      relayPlayerId.value = null;
      relayIsHost.value = false;
    });
  } catch (error) {
    relayStatus.value = "连接失败";
    notice.value = `PvP 房间连接失败：${error instanceof Error ? error.message : "请检查后端地址"}`;
  }
}

function onCellClick(cellId: CellId): void {
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
  if (clickedUnit?.id === actingUnit.id) {
    clearSelection();
    return;
  }
  if (clickedUnit?.ownerId === active.id && !legalActionCellIds.value.includes(cellId)) {
    selectOwnUnit(clickedUnit.id);
    return;
  }
  if (!legalActionCellIds.value.includes(cellId)) {
    if (!clickedUnit) {
      clearSelection();
      return;
    }
    notice.value = "只能对青色描边的合法相邻格行动。";
    return;
  }
  // Capture both values before applying the command. A later friendly-fire
  // click cannot reinterpret a cancelled selection as the action source.
  const actingUnitId = actingUnit.id;
  const sourceCellId = selectedSourceCellId.value ?? actingUnit.cellId;
  const includeSourceClick = selectedByUser.value;
  const command: GameCommand = clickedUnit
    ? {
      type: "attack-unit", commandId: crypto.randomUUID(), actorId: active.id,
      expectedSequence: game.value.sequence, unitId: actingUnitId, targetId: cellId
    }
    : {
      type: "move-unit", commandId: crypto.randomUUID(), actorId: active.id,
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
  if (relayRoom && relayPlayerId.value && active && active.id !== relayPlayerId.value) {
    notice.value = "现在轮到另一位玩家，等待对方行动。";
    return;
  }
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
      type: "reinforce-unit", commandId: crypto.randomUUID(), actorId: active.id,
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
  const active = currentPlayer.value;
  if (!active) return;
  const command: GameCommand = {
    type: "end-action-phase", commandId: crypto.randomUUID(), actorId: active.id,
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
  const active = currentPlayer.value;
  if (!active) return;
  clearReinforcementHold();
  const command: GameCommand = {
    type: "end-reinforcement-phase", commandId: crypto.randomUUID(), actorId: active.id,
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
  game.value = createDemoMatch();
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
  broadcastSnapshot();
  if (!quiet) notice.value = result.events.at(-1)?.message ?? "操作完成。";
  return true;
}

onMounted(() => { void connectRelay(); });
onBeforeUnmount(() => {
  clearReinforcementHold();
  relayRoom?.leave();
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div><p class="eyebrow">LOCAL RULES PROTOTYPE</p><h1>Numeral Lord</h1></div>
      <div class="topbar-meta">
        <div class="turn-pill" :style="{ '--player-color': currentPlayer?.color }"><span class="turn-dot" />第 {{ game.turn.round }} 回合 · {{ currentPlayer?.displayName }} · {{ phaseLabel }}</div>
        <div class="network-pill" :class="{ connected: relayStatus === '已连接' }">PvP {{ relayStatus }}<span v-if="relayRoomId"> · 房间 {{ relayRoomId }}</span><span v-if="relayIsHost"> · 房主</span><span v-else-if="relayPlayerId"> · {{ relayPlayerId }}</span></div>
      </div>
    </header>

    <section v-if="isMatchFinished" class="match-result" role="status" aria-live="polite">
      <div>
        <p class="result-kicker">MATCH FINISHED · 对局结束</p>
        <h2>{{ matchResultTitle }}</h2>
        <p>{{ matchResultMessage }}</p>
      </div>
      <button class="primary" @click="resetMatch">重新开始演示对局</button>
    </section>

    <section class="play-layout">
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
          <template v-else-if="isReinforcementPhase"><small>加点回合</small><strong>剩余 {{ currentPlayer?.reinforcementPoints ?? 0 }} 点</strong><span>点击通电兵加 1 点；长按会逐渐加速，最多 3 秒投入全部点数。</span></template>
          <template v-else-if="selectedUnit"><small>已选单位</small><strong>{{ selectedIsPowered ? "通电兵" : "游兵" }} · {{ selectedUnit.strength }} 点</strong><span>点击青色描边的相邻格移动或攻击。</span></template>
          <template v-else><small>尚未选择单位</small><span>点击带扩散光圈的当前可行动单位。</span></template>
        </div>
        <button v-if="isActionPhase" class="secondary" @click="endActionPhase">结束行动，进入加点</button>
        <button v-else-if="isReinforcementPhase" class="primary" @click="endReinforcementPhase">结束加点，轮到下一位</button>
        <button class="ghost" @click="resetMatch">重置演示对局</button>
        <button class="ghost notation-trigger" @click="openNotationDialog">查看 / 复制本地棋谱</button>
        <button v-if="relayStatus === '连接失败' || relayStatus === '连接已断开'" class="ghost" @click="connectRelay">重新连接 PvP</button>
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
