<script setup lang="ts">
import { computed, ref } from "vue";
import type { GameState, LobbyMember, LobbyRoomState, UnitId } from "@numeral-lord/game-core";
import HexBoard from "./HexBoard.vue";

const props = defineProps<{
  room: LobbyRoomState;
  roomId: string;
  selfSessionId: string | null;
  previewState: GameState;
  previewPoweredUnitIds: readonly UnitId[];
}>();

const emit = defineEmits<{
  ready: [ready: boolean];
  seat: [seat: number | null];
  participation: [participating: boolean];
  settings: [settings: Record<string, boolean | number>];
  assign: [payload: { sessionId: string; seat?: number | null; participating?: boolean }];
}>();

const me = computed(() => props.room.members.find((member) => member.sessionId === props.selfSessionId));
const amHost = computed(() => Boolean(me.value?.isHost));
const participants = computed(() => props.room.members.filter((member) => member.participating));
const readyCount = computed(() => participants.value.filter((member) => member.ready && member.connected).length);
const allSlotsReady = computed(() => participants.value.length > 0
  && readyCount.value === participants.value.length);
const copyStatus = ref("");
const inviteUrl = computed(() => {
  const url = new URL(window.location.href);
  url.searchParams.set("room", props.roomId);
  return url.toString();
});

async function copyInvite(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl.value);
    copyStatus.value = "邀请链接已复制";
  } catch {
    copyStatus.value = "浏览器未允许自动复制，请手动复制房间号";
  }
}

function seatLabel(member: LobbyMember): string {
  if (!member.participating) return "观战位";
  if (props.room.settings.randomizePositions) return "参战（开局随机位置）";
  return member.seat === null ? "参战（未选位）" : `${member.seat} 号位`;
}

function seatIsOccupied(seat: number, exceptSessionId: string): boolean {
  return props.room.members.some((member) => member.sessionId !== exceptSessionId && member.seat === seat);
}

function onMemberRoleChange(member: LobbyMember, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const isSelf = member.sessionId === props.selfSessionId;
  if (props.room.settings.randomizePositions) {
    const participating = value === "play";
    if (isSelf) emit("participation", participating);
    else emit("assign", { sessionId: member.sessionId, participating });
    return;
  }
  const seat = value === "spectate" ? null : Number(value);
  if (isSelf) emit("seat", seat);
  else emit("assign", { sessionId: member.sessionId, seat });
}

function emitNumberSetting(key: "turnTimeSeconds" | "matchTimeMinutes", event: Event): void {
  emit("settings", { [key]: Number((event.target as HTMLInputElement).value) });
}

function emitBooleanSetting(key: "friendlyFire" | "randomizePositions", event: Event): void {
  emit("settings", { [key]: (event.target as HTMLInputElement).checked });
}
</script>

<template>
  <section class="lobby-shell">
    <header class="lobby-header">
      <div>
        <p class="kicker">PVP LOBBY</p>
        <h2>对战准备房间</h2>
        <p>地图提供 {{ room.mapPlayerCount }} 个玩家位；当前共 {{ room.members.length }} 人，超出玩家位的成员自动观战。</p>
        <div class="room-invite"><span>房间号 <b>{{ roomId }}</b></span><button @click="copyInvite">复制邀请链接</button><small v-if="copyStatus">{{ copyStatus }}</small></div>
      </div>
      <div class="lobby-header-side">
        <section class="map-preview-card">
          <div class="map-preview-title"><strong>地图预览</strong><span>{{ room.mapPlayerCount }} 个玩家位</span></div>
          <div class="map-preview-board">
            <HexBoard
              preview
              :state="previewState"
              :selected-unit-id="null"
              :legal-action-cell-ids="[]"
              :actionable-unit-ids="[]"
              :powered-unit-ids="previewPoweredUnitIds"
            />
          </div>
        </section>
        <div class="ready-summary" :class="{ complete: allSlotsReady }">
          <strong>{{ readyCount }} / {{ participants.length }}</strong>
          <span>{{ allSlotsReady ? "正在开始" : "参战玩家已准备" }}</span>
        </div>
      </div>
    </header>

    <div class="lobby-grid">
      <section class="lobby-card member-card">
        <div class="section-title"><h3>成员与位置</h3><span>{{ room.members.length }} 人在线房间</span></div>
        <div class="member-list">
          <article v-for="member in room.members" :key="member.sessionId" class="member-row" :class="{ disconnected: !member.connected }">
            <div class="member-name">
              <span class="presence" />
              <div>
                <strong>{{ member.displayName }}</strong>
                <small><b v-if="member.isHost">房主 · </b>{{ seatLabel(member) }}</small>
              </div>
            </div>

            <select
              v-if="member.sessionId === selfSessionId || amHost"
              class="seat-select"
              :value="room.settings.randomizePositions ? (member.participating ? 'play' : 'spectate') : (member.seat ?? 'spectate')"
              :aria-label="`调整 ${member.displayName} 的位置`"
              @change="onMemberRoleChange(member, $event)"
            >
              <template v-if="room.settings.randomizePositions">
                <option value="play">参战</option>
                <option value="spectate">观战</option>
              </template>
              <template v-else>
                <option value="spectate">观战位</option>
                <option
                  v-for="seat in room.mapPlayerCount"
                  :key="seat"
                  :value="seat"
                  :disabled="seatIsOccupied(seat, member.sessionId)"
                >{{ seat }} 号位</option>
              </template>
            </select>
            <span v-else class="seat-readonly">{{ seatLabel(member) }}</span>

            <span class="ready-state" :class="{ ready: member.ready }">
              {{ !member.connected ? "重连中" : member.participating ? (member.ready ? "已准备" : "未准备") : "观战" }}
            </span>
          </article>
        </div>

        <button
          v-if="me?.participating"
          class="ready-button"
          :class="{ active: me.ready }"
          @click="emit('ready', !me.ready)"
        >{{ me.ready ? "取消准备" : "准备" }}</button>
        <p v-else class="spectator-note">你当前在观战位。切换到可用玩家位（随机模式为“参战”）后才能准备。</p>
      </section>

      <section class="lobby-card settings-card">
        <div class="section-title"><h3>房间设置</h3><span>{{ amHost ? "房主可修改" : "由房主设置" }}</span></div>
        <label class="toggle-row">
          <span><strong>友方伤害</strong><small>开启后允许攻击同队单位</small></span>
          <input type="checkbox" :checked="room.settings.friendlyFire" :disabled="!amHost" @change="emitBooleanSetting('friendlyFire', $event)" />
        </label>
        <label class="toggle-row">
          <span><strong>随机位置与次序</strong><small>大厅只选择参战/观战，开局时随机分配地图位</small></span>
          <input type="checkbox" :checked="room.settings.randomizePositions" :disabled="!amHost" @change="emitBooleanSetting('randomizePositions', $event)" />
        </label>
        <div class="number-grid">
          <label><span>步时（秒）</span><input type="number" min="0" max="300" step="10" :value="room.settings.turnTimeSeconds" :disabled="!amHost" @change="emitNumberSetting('turnTimeSeconds', $event)" /><small>0 为不限时</small></label>
          <label><span>局时（分钟）</span><input type="number" min="0" max="180" step="5" :value="room.settings.matchTimeMinutes" :disabled="!amHost" @change="emitNumberSetting('matchTimeMinutes', $event)" /><small>0 为不限时</small></label>
        </div>
        <p class="settings-hint">修改设置会取消所有人的准备状态。房间成员数量不受地图玩家位限制，多出的成员进入观战位。</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.lobby-shell { padding: 24px; border: 1px solid rgba(137, 180, 222, .38); border-radius: 24px; background: linear-gradient(145deg, rgba(25, 45, 66, .98), rgba(13, 28, 43, .98)); box-shadow: 0 24px 70px rgba(2, 8, 18, .34); }
.lobby-header, .section-title, .member-row, .member-name, .toggle-row { display: flex; align-items: center; }
.lobby-header { align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
.lobby-header h2 { margin: 3px 0 5px; color: #f7fbff; font-size: clamp(23px, 3vw, 34px); }
.lobby-header p { margin: 0; color: #aebfd3; }
.kicker { color: #67e8f9 !important; font-size: 11px; font-weight: 900; letter-spacing: .16em; }
.room-invite { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }.room-invite span { padding: 6px 9px; border: 1px solid rgba(103, 232, 249, .28); border-radius: 8px; color: #9fb4c9; font-size: 11px; }.room-invite b { color: #fff; letter-spacing: .06em; }.room-invite button { width: auto; margin-top: 0; padding: 7px 10px; border: 1px solid rgba(103, 232, 249, .32); border-radius: 8px; background: rgba(10, 35, 52, .8); color: #a5f3fc; font-size: 11px; cursor: pointer; }.room-invite small { color: #86efac; font-size: 10px; }
.lobby-header-side { display: grid; width: clamp(240px, 25vw, 320px); flex: 0 0 auto; gap: 9px; }
.map-preview-card { overflow: hidden; padding: 9px; border: 1px solid rgba(130, 167, 204, .3); border-radius: 16px; background: rgba(8, 19, 31, .7); }
.map-preview-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 2px 7px; }.map-preview-title strong { color: #dce9f7; font-size: 11px; }.map-preview-title span { color: #7892ad; font-size: 9px; }
.map-preview-board { height: clamp(150px, 14vw, 190px); }
.ready-summary { padding: 9px 13px; border: 1px solid rgba(103, 232, 249, .35); border-radius: 13px; background: rgba(8, 19, 31, .62); text-align: center; }
.ready-summary strong, .ready-summary span { display: block; }
.ready-summary strong { color: #fff; font-size: 22px; }.ready-summary span { margin-top: 2px; color: #91a8c0; font-size: 11px; }.ready-summary.complete { border-color: #4ade80; box-shadow: 0 0 24px rgba(74, 222, 128, .14); }
.lobby-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(280px, .75fr); gap: 16px; }
.lobby-card { padding: 18px; border: 1px solid rgba(130, 167, 204, .25); border-radius: 18px; background: rgba(8, 21, 34, .67); }
.section-title { justify-content: space-between; gap: 12px; margin-bottom: 14px; }.section-title h3 { margin: 0; color: #eaf4ff; font-size: 16px; }.section-title span { color: #7892ad; font-size: 11px; }
.member-list { display: grid; gap: 8px; }.member-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(126px, .7fr) 70px; gap: 10px; padding: 10px 12px; border: 1px solid rgba(108, 145, 182, .22); border-radius: 12px; background: rgba(22, 43, 63, .62); }.member-row.disconnected { opacity: .55; }
.member-name { gap: 9px; min-width: 0; }.member-name strong, .member-name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.member-name strong { color: #f4f8fc; }.member-name small { color: #8fa7bf; font-size: 11px; }.presence { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #4ade80; box-shadow: 0 0 10px rgba(74, 222, 128, .6); }.disconnected .presence { background: #64748b; box-shadow: none; }
.seat-select, .number-grid input { width: 100%; border: 1px solid rgba(129, 168, 207, .35); border-radius: 9px; background: #0d2032; color: #eaf4ff; outline: none; }.seat-select { padding: 7px 9px; }.seat-readonly { color: #bfd0e2; font-size: 12px; }.ready-state { color: #8fa5ba; font-size: 11px; text-align: right; }.ready-state.ready { color: #86efac; font-weight: 800; }
.ready-button { width: 100%; margin-top: 14px; padding: 12px; border: 0; border-radius: 11px; background: linear-gradient(90deg, #5eead4, #60a5fa); color: #071626; font-weight: 900; cursor: pointer; }.ready-button.active { background: #223b52; color: #c5d6e7; }.spectator-note, .settings-hint { margin: 13px 0 0; color: #7f98b1; font-size: 11px; line-height: 1.55; }
.toggle-row { justify-content: space-between; gap: 16px; padding: 11px 0; border-bottom: 1px solid rgba(122, 157, 191, .16); }.toggle-row strong, .toggle-row small { display: block; }.toggle-row strong { color: #dce9f7; font-size: 13px; }.toggle-row small { margin-top: 2px; color: #8299b0; font-size: 10px; }.toggle-row input { width: 18px; height: 18px; accent-color: #67e8f9; }
.number-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-top: 14px; }.number-grid label span, .number-grid label small { display: block; }.number-grid label span { margin-bottom: 5px; color: #aabed2; font-size: 11px; }.number-grid input { box-sizing: border-box; padding: 8px; }.number-grid label small { margin-top: 4px; color: #647c94; font-size: 9px; }
@media (max-width: 800px) { .lobby-shell { padding: 15px; }.lobby-header { display: grid; }.lobby-header-side { width: 100%; grid-template-columns: minmax(0, 1fr) 130px; align-items: stretch; }.map-preview-board { height: 170px; }.ready-summary { display: grid; align-content: center; }.lobby-grid { grid-template-columns: 1fr; }.member-row { grid-template-columns: minmax(120px, 1fr) 120px 58px; }.number-grid { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .lobby-header-side { grid-template-columns: 1fr; }.ready-summary { min-width: 0; }.member-row { grid-template-columns: 1fr 118px; }.ready-state { grid-column: 1 / -1; text-align: left; padding-left: 17px; } }
</style>
