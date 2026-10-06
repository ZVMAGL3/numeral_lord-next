<script setup lang="ts">
import { provide, proxyRefs } from "vue";
import { useAppRuntime } from "./app/app-runtime";
import { appRuntimeKey } from "./app/app-runtime-key";
import FullscreenControl from "./components/FullscreenControl.vue";

const runtime = useAppRuntime();
provide(appRuntimeKey, runtime);
const home = proxyRefs(runtime.home);
const {
  showHome, showMaps, showWorkshop, showRoomEntry, showLobby, showGame, showGameLoading,
  hoveredTeamColor, currentPlayer, teamColors, relayStatus, relayRoomId, relayIsHost,
  isSpectator, relayPlayerId, stepClockLabel, matchClockLabel, configuredMaps, battleLobbyStatus,
  workshopStatus, publicBattleRooms, lobbyState, privateReservePlayer, privateReserveIncome,
  gameOptionsOpen, gameActionsOpen, game, requestHome, openNotationDialog, resetMatch, zoomBoard
} = runtime.shell;
const {
  leaveDialogOpen, leaveToHome, notationDialogOpen, notationText, latestContinuation,
  notationCopyMessage, copyNotation, connectionLogDialogOpen, connectionLogText,
  connectionLogCopyMessage, copyConnectionLog
} = runtime.dialogs;
</script>

<template>
<main class="app-shell" :class="{ 'home-shell': showHome, 'game-shell': showGame }" @click="gameActionsOpen = false; gameOptionsOpen = false">
    <header class="topbar" :class="{ 'game-topbar': showGame, 'battle-hall-topbar': showRoomEntry, 'lobby-topbar': showLobby }" :style="showGame ? { '--team-color': hoveredTeamColor ?? (currentPlayer ? teamColors.get(currentPlayer.teamId) : undefined) } : undefined">
      <div class="brand-block">
        <button v-if="showGame" class="game-options-trigger game-pause-trigger" type="button" aria-label="对局菜单（不会暂停其他玩家）" title="对局菜单" aria-haspopup="menu" :aria-expanded="gameOptionsOpen" @click.stop="gameOptionsOpen = !gameOptionsOpen; gameActionsOpen = false"><span class="pause-glyph" aria-hidden="true"><i></i><i></i></span></button>
        <button v-else-if="!showHome && !showMaps && !showWorkshop" class="topbar-back" @click="requestHome"><span aria-hidden="true">←</span> 返回主页</button>
        <template v-if="!showGame && !showRoomEntry"><p class="eyebrow">NUMERAL LORD · EARLY ACCESS</p><h1>Numeral Lord</h1></template>
          <div v-if="showGame && gameOptionsOpen" class="game-options-menu" role="menu" @click.stop>
          <div class="game-options-status" :class="{ connected: relayStatus === '已连接' }"><span class="turn-dot" />PvP {{ relayStatus }}<small v-if="relayRoomId">房间 {{ relayRoomId }}<template v-if="relayIsHost"> · 房主</template><template v-else-if="isSpectator"> · 观战</template><template v-else-if="relayPlayerId"> · {{ relayPlayerId }}</template></small></div>
          <small class="game-menu-clocks">步 {{ stepClockLabel }} · 局 {{ matchClockLabel }}</small>
          <button type="button" role="menuitem" @click="connectionLogCopyMessage = ''; connectionLogDialogOpen = true; gameOptionsOpen = false">连接日志</button>
          <button type="button" role="menuitem" @click="openNotationDialog(); gameOptionsOpen = false">查看 / 复制本地棋谱</button>
          <button v-if="relayStatus !== '已连接' || relayIsHost" type="button" role="menuitem" @click="resetMatch(); gameOptionsOpen = false">{{ relayRoomId ? '返回准备房间' : '重置演示对局' }}</button>
          <button type="button" role="menuitem" class="game-menu-leave" @click="requestHome(); gameOptionsOpen = false">离开对局</button>
        </div>
      </div>
      <div v-if="showGame" class="match-scoreboard" aria-label="对局状态">
        <div class="scoreboard-round"><span>回合</span><strong>{{ game.turn.round }}</strong></div>
        <div class="scoreboard-current"><span>点数</span><strong v-if="privateReservePlayer">{{ privateReservePlayer.reinforcementPoints }}<small v-if="privateReserveIncome > 0">(+{{ privateReserveIncome }})</small></strong><strong v-else>—</strong></div>
      </div>
      <div v-if="showRoomEntry" class="battle-hall-online" :class="{ disconnected: battleLobbyStatus === 'error' }"><span class="battle-online-dot" /><strong>{{ battleLobbyStatus === 'error' ? '离线' : '在线' }}</strong></div>
      <div v-if="!showRoomEntry" class="topbar-meta">
        <label v-if="showHome" class="topbar-home-name">
          <span>玩家名字</span>
          <input
            :value="home.playerName"
            type="text"
            maxlength="24"
            autocomplete="nickname"
            placeholder="输入你的名字"
            aria-label="玩家名字"
            @input="home.updatePlayerName(($event.target as HTMLInputElement).value)"
            @keydown.enter.prevent="home.startFromHome"
          />
        </label>
        <div v-else-if="showMaps" class="turn-pill"><span class="turn-dot" />地图配置 · {{ configuredMaps.length }} 张可用</div>
        <div v-else-if="showWorkshop" class="turn-pill"><span class="turn-dot" />创意工坊 · {{ workshopStatus === 'connected' ? '已连接' : workshopStatus === 'connecting' ? '连接中' : '离线预览' }}</div>
        <div v-else-if="showRoomEntry" class="turn-pill"><span class="turn-dot" />战斗大厅 · {{ publicBattleRooms.length }} 个公开房间</div>
        <div v-else-if="relayStatus === '连接中…'" class="turn-pill"><span class="turn-dot" />正在连接 PvP 房间…</div>
        <div v-else-if="showLobby" class="turn-pill"><span class="turn-dot" />准备房间 · 地图 {{ lobbyState.mapPlayerCount }} 个玩家位</div>
        <div v-else-if="showGameLoading" class="turn-pill"><span class="turn-dot" />正在同步对局棋盘…</div>
        <div v-if="!showHome && !showMaps && !showWorkshop && !showGame" class="network-pill" :class="{ connected: relayStatus === '已连接' }">PvP {{ relayStatus }}<span v-if="relayRoomId"> · 房间 {{ relayRoomId }}</span><span v-if="relayIsHost"> · 房主</span><span v-else-if="isSpectator"> · 观战</span><span v-else-if="relayPlayerId"> · {{ relayPlayerId }}</span></div>
        <button v-if="!showHome && !showMaps && !showWorkshop && !showGame" class="connection-log-trigger" type="button" @click="connectionLogCopyMessage = ''; connectionLogDialogOpen = true">连接日志</button>
        <div v-if="showGame" class="game-board-tools" @click.stop>
          <button class="game-zoom-button" type="button" aria-label="棋盘功能" title="棋盘功能" aria-haspopup="menu" :aria-expanded="gameActionsOpen" @click="gameActionsOpen = !gameActionsOpen; gameOptionsOpen = false"><span class="zoom-glyph" aria-hidden="true">＋</span></button>
          <div v-if="gameActionsOpen" class="game-options-menu game-board-menu" role="menu" aria-label="棋盘功能">
            <button type="button" role="menuitem" @click="zoomBoard('in'); gameActionsOpen = false">放大棋盘</button>
            <button type="button" role="menuitem" @click="zoomBoard('out'); gameActionsOpen = false">缩小棋盘</button>
            <button type="button" role="menuitem" @click="zoomBoard('reset'); gameActionsOpen = false">重置视图</button>
            <button type="button" role="menuitem" class="game-menu-leave" @click="requestHome(); gameActionsOpen = false">离开对局</button>
          </div>
        </div>
      </div>
    </header>

    <RouterView />
    <FullscreenControl />
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
