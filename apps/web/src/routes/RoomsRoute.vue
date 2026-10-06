<script setup lang="ts">
import { inject, onBeforeUnmount, proxyRefs, ref, watch } from "vue";
import HexBoard from "../components/HexBoard.vue";
import LobbyPanel from "../components/LobbyPanel.vue";
import { appRuntimeKey } from "../app/app-runtime-key";

const runtime = inject(appRuntimeKey);
if (!runtime) throw new Error("房间页未连接应用运行时");
const page = proxyRefs(runtime.rooms);
const boardRef = ref<InstanceType<typeof HexBoard> | null>(null);

// 棋盘视图随房间页挂载；把缩放入口交给常驻顶栏，离开时清空引用。
watch(boardRef, page.registerGameBoard, { immediate: true });
onBeforeUnmount(() => page.registerGameBoard(null));
</script>

<template>
  <section v-if="page.showRoomEntry" class="room-hub">
    <div class="room-hub-heading">
      <div>
        <p class="entry-kicker">NUMERAL LORD / ONLINE</p>
        <h2>战斗大厅</h2>
        <p>浏览公开战局，加入正在等人的房间，或快速匹配陌生玩家。</p>
      </div>
      <div class="battle-online-status" :class="{ connected: page.battleLobbyStatus === 'connected' }">
        <span class="battle-online-dot" />
        {{ page.battleLobbyStatus === 'connected' ? '大厅在线' : page.battleLobbyStatus === 'connecting' ? '正在连接' : page.battleLobbyStatus === 'error' ? '连接异常' : '离线' }}
        <small>{{ page.publicBattleRooms.length }} 个房间</small>
      </div>
    </div>
    <div class="battle-lobby-grid">
      <section class="public-room-pane" aria-label="公开房间列表">
        <div class="battle-pane-heading">
          <div><span class="battle-section-index">01 / OPEN ROOMS</span><h3>公开战局</h3></div>
          <button class="battle-refresh" type="button" :disabled="page.battleLobbyStatus === 'connecting'" @click="page.refreshBattleLobby" aria-label="刷新公开房间">↻ <span>刷新</span></button>
        </div>
        <p v-if="page.battleLobbyStatus === 'connecting' && page.publicBattleRooms.length === 0" class="battle-list-hint">正在寻找开放房间…</p>
        <p v-else-if="page.battleLobbyStatus === 'error' && page.publicBattleRooms.length === 0" class="battle-list-hint battle-list-error">{{ page.battleLobbyError || '暂时无法连接大厅。' }} <button type="button" @click="page.refreshBattleLobby">重新连接</button></p>
        <p v-else-if="page.publicBattleRooms.length === 0" class="battle-list-hint"><span>暂时没有公开战局。</span><span class="battle-list-hint-detail">快速匹配会为你创建新房间。</span></p>
        <div v-else class="battle-room-list">
          <article v-for="room in page.sortedPublicBattleRooms" :key="room.roomId" class="battle-room-card">
            <div class="battle-room-avatar" aria-hidden="true">{{ String(room.metadata.hostName || '领').slice(0, 1) }}</div>
            <div class="battle-room-main">
              <div class="battle-room-title"><strong>{{ room.metadata.hostName || '玩家房间' }}</strong><span :class="room.metadata.phase === 'lobby' ? 'battle-room-open' : 'battle-room-playing'">{{ room.metadata.phase === 'lobby' ? '等待中' : '进行中' }}</span></div>
              <div class="battle-room-meta"><span>{{ room.metadata.mapName || '未命名地图' }}</span><i>·</i><span>{{ room.metadata.playerCount ?? 0 }} / {{ room.metadata.mapPlayerCount ?? '?' }} 人</span><i>·</i><span>房间 {{ room.roomId.slice(0, 7) }}</span></div>
            </div>
            <button class="battle-room-join" type="button" :disabled="page.battleLobbyWorking || page.relayStatus === '连接中…'" @click="page.joinPublicBattleRoom(room)">{{ room.metadata.phase === 'playing' ? '进入对局' : Number(room.metadata.openSeats) > 0 ? '加入' : '观战' }} <span aria-hidden="true">→</span></button>
          </article>
        </div>
        <p v-if="page.battleLobbyError && page.battleLobbyStatus === 'connected'" class="battle-inline-error" role="status">{{ page.battleLobbyError }}</p>
      </section>

      <aside class="battle-match-pane" aria-label="匹配和加入房间">
        <div class="battle-match-art" aria-hidden="true"><span /><span /><span /><span /><span /></div>
        <span class="battle-section-index">02 / QUICK MATCH</span>
        <h3>开始一场战斗</h3>
        <p>快速加入有空位的公开房间；暂时无人时，会自动创建一间等候陌生玩家加入。</p>
        <button class="battle-quick-match" type="button" :disabled="page.battleLobbyWorking || page.relayStatus === '连接中…'" @click="page.quickMatch"><span>{{ page.battleLobbyWorking || page.relayStatus === '连接中…' ? '正在为你匹配…' : '快速匹配' }}</span><b aria-hidden="true">→</b></button>
        <button class="battle-create-room" type="button" :disabled="page.relayStatus === '连接中…'" @click="page.createRoom">＋ 创建公开房间</button>
        <div class="battle-room-code">
          <label for="battle-room-id">通过房间号加入</label>
          <div class="join-row"><input id="battle-room-id" v-model.trim="page.roomIdInput" type="text" autocomplete="off" placeholder="输入好友分享的房间号" aria-label="房间号" @keyup.enter="page.joinRoom" /><button class="secondary" :disabled="page.relayStatus === '连接中…'" @click="page.joinRoom">加入</button></div>
        </div>
      </aside>
    </div>
    <div class="room-hub-foot"><span :aria-label="`当前玩家：${page.playerName}`"><i class="battle-profile-dot" /><strong>{{ page.playerName }}</strong></span><span>{{ page.configuredMaps.length }} 张本机地图可供房主选择</span></div>
    <p v-if="page.relayStatus === '连接失败' || page.relayStatus === '连接已断开'" class="entry-error" role="alert">{{ page.notice }} <button v-if="page.roomIdInput" @click="page.joinRoom">重试加入</button></p>
  </section>

  <section v-else-if="page.relayStatus === '连接中…'" class="room-entry connecting-card">
    <div class="entry-copy"><p class="entry-kicker">CONNECTING</p><h2>正在进入房间…</h2><p>正在同步成员、地图玩家位和当前棋盘。</p></div>
  </section>

  <LobbyPanel
    v-else-if="page.showLobby"
    :room="page.lobbyState"
    :room-id="page.relayRoomId"
    :self-session-id="page.relaySessionId"
    :preview-state="page.lobbyPreviewState"
    :preview-powered-unit-ids="page.lobbyPreviewPoweredUnitIds"
    :preview-terrain-catalog="page.activeTerrainCatalog"
    :preview-terrain-visual-assets="page.activeTerrainVisualAssets"
    :available-maps="page.configuredMaps"
    :error-message="page.lobbyError"
    :updating-mod-id="page.pendingRoomModUpdateId"
    :mod-update-message="page.roomModUpdateMessage"
    :subscribed-updates-pending="page.pendingSubscribedModUpdateIds.length > 0"
    @ready="page.sendLobbyReady"
    @seat="page.sendLobbySeat"
    @participation="page.sendLobbyParticipation"
    @color="page.sendLobbyColor"
    @settings="page.sendLobbySettings"
    @mod-settings="page.sendLobbyModSettings"
    @assign="page.sendLobbyAssignment"
    @map="page.sendLobbyMap"
    @open-workshop-mod="page.openWorkshopForMissingTerrainMod"
    @update-mod="page.updateRoomModVersion"
  />

  <section v-if="page.showGameLoading" class="sync-panel" role="status"><span v-if="page.missingLoadedModIds.length === 0" class="sync-spinner" /><h2>{{ page.missingLoadedModIds.length ? '正在读取地图地块' : '正在同步棋盘' }}</h2><p>{{ page.missingLoadedModIds.length ? `正在从服务器加载本局需要的地块：${page.missingLoadedModIds.join('、')}。` : '正在从房间获取当前地图和最新对局状态；若房主刚断线，系统会自动重试。' }}</p></section>

  <Teleport to="body">
    <div v-if="page.showGame && page.isMatchFinished" class="result-backdrop">
      <section class="result-dialog" role="dialog" aria-modal="true" aria-labelledby="match-result-title" aria-describedby="match-result-message">
        <div class="result-emblem" aria-hidden="true">✦</div>
        <p class="result-kicker">MATCH FINISHED <span>·</span> 对局结束</p>
        <h2 id="match-result-title">{{ page.matchResultTitle }}</h2>
        <p id="match-result-message" class="result-message">{{ page.matchResultMessage }}</p>
        <div class="result-divider"><span /><i>本局结算</i><span /></div>
        <button v-if="page.relayStatus !== '已连接' || page.relayIsHost" class="primary result-return" @click="page.resetMatch">{{ page.relayRoomId ? '返回准备房间' : '重新开始演示对局' }} <span aria-hidden="true">→</span></button>
        <p v-else class="result-waiting">等待房主返回准备房间</p>
      </section>
    </div>
  </Teleport>

  <section v-if="page.showGame" class="play-layout">
    <aside class="panel player-panel">
      <article v-for="player in page.players" :key="player.id" class="player-card" :class="{ active: player.id === page.currentPlayer?.id, 'team-highlighted': page.hoveredTeamId === player.teamId, disconnected: page.disconnectedPlayerIds.has(player.id) }" :style="{ '--team-color': page.teamColors.get(player.teamId) }" :title="`${player.displayName}${page.disconnectedPlayerIds.has(player.id) ? ' · 离线' : ''} · 棋盘点数 ${page.publicBoardPoints[player.id] ?? 0}`" @pointerenter="page.onPlayerCardPointerEnter(player.id)" @pointerleave="page.clearPlayerCardHover">
        <span class="player-color-hex" :style="{ background: player.color }" aria-hidden="true" />
        <strong>{{ player.displayName }}<i v-if="page.disconnectedPlayerIds.has(player.id)" class="player-offline-dot" aria-label="离线" /></strong>
        <b class="player-public-points"><span aria-hidden="true">ϟ</span> {{ page.publicBoardPoints[player.id] ?? 0 }}</b>
      </article>
    </aside>

    <section class="board-wrap">
      <HexBoard
        ref="boardRef"
        :state="page.game"
        :selected-unit-id="page.selectedUnitId"
        :legal-action-cell-ids="page.legalActionCellIds"
        :counterattack-cell-ids="page.counterattackCellIds"
        :no-counterattack-cell-ids="page.noCounterattackCellIds"
        :actionable-unit-ids="page.actionableUnitIds"
        :highlighted-unit-ids="page.highlightedUnitIds"
        :powered-unit-ids="page.poweredUnitIds"
        :terrain-catalog="page.activeTerrainCatalog"
        :terrain-visual-assets="page.activeTerrainVisualAssets"
        :highlighted-player-id="page.hoveredPlayerId"
        @cell-click="page.onCellClick"
        @board-draw-measured="page.onBoardDrawMeasured"
        @interaction-draw-measured="page.onInteractionDrawMeasured"
        @background-click="page.clearSelection"
        @cell-press-start="page.onCellPressStart"
        @cell-press-end="page.onCellPressEnd"
      />
    </section>

    <aside class="panel action-panel" :class="{ 'action-panel-full-cta': page.isActionPhase || page.isReinforcementPhase }">
      <button v-if="page.isActionPhase" class="phase-end-action" :class="{ 'phase-end-action-other-turn': !page.canActCurrentPlayer && !page.isSpectator && !page.isRepairing && !page.isMatchFinished }" :aria-label="page.isSpectator ? '观战中' : '点击这里结束行动'" :disabled="!page.canActCurrentPlayer" @click="page.endActionPhase">
        <strong>
          <template v-if="page.isSpectator">观战中</template>
          <template v-else-if="page.isRepairing">正在同步棋盘…</template>
          <template v-else-if="page.isMatchFinished">{{ page.matchResultTitle }}</template>
          <template v-else-if="!page.canActCurrentPlayer">其他玩家行动中</template>
          <template v-else>选择单位行动，剩余 <span class="phase-action-points">{{ page.actionableUnitIds.length }}</span> 块</template>
        </strong>
        <span v-if="page.isSpectator || page.isRepairing || page.isMatchFinished || page.canActCurrentPlayer">
          <template v-if="page.isSpectator">对局实时同步</template>
          <template v-else-if="page.isRepairing">请稍候</template>
          <template v-else-if="page.isMatchFinished">{{ page.matchResultMessage }}</template>
          <template v-else>点击己方单位选择移动或攻击　·　<span class="phase-action-end-hint">点击这里结束行动</span></template>
        </span>
      </button>
      <button v-else-if="page.isReinforcementPhase" class="phase-end-action" :class="{ 'phase-end-action-other-turn': !page.canActCurrentPlayer && !page.isSpectator && !page.isRepairing && !page.isMatchFinished }" :aria-label="page.isSpectator ? '观战中' : '点击这里结束成长'" :disabled="!page.canActCurrentPlayer" @click="page.endReinforcementPhase">
        <strong>
          <template v-if="page.isSpectator">观战中</template>
          <template v-else-if="page.isRepairing">正在同步棋盘…</template>
          <template v-else-if="page.canActCurrentPlayer">点击地块<span class="phase-action-growth">成长</span>，剩余<span class="phase-action-points">{{ page.currentPlayer?.reinforcementPoints ?? 0 }}</span>点</template>
          <template v-else-if="!page.isMatchFinished">其他玩家行动中</template>
          <template v-else>{{ page.matchResultTitle }}</template>
        </strong>
        <span v-if="page.isSpectator || page.isRepairing || page.canActCurrentPlayer || page.isMatchFinished">
          <template v-if="page.isSpectator">对局实时同步</template>
          <template v-else-if="page.isRepairing">请稍候</template>
          <template v-else-if="page.canActCurrentPlayer"><span class="phase-action-end-hint">点击这里结束成长</span></template>
          <template v-else>{{ page.matchResultMessage }}</template>
        </span>
      </button>
      <div v-else class="selected-info">
        <template v-if="page.isSpectator"><strong>观战中</strong><span>对局实时同步</span></template>
        <template v-else-if="page.isRepairing"><strong>正在同步棋盘…</strong><span>请稍候</span></template>
        <template v-else><strong>{{ page.isMatchFinished ? page.matchResultTitle : '对局已结束' }}</strong><span>{{ page.isMatchFinished ? page.matchResultMessage : '等待下一场对局' }}</span></template>
      </div>
    </aside>
  </section>
</template>
