<script setup lang="ts">
import { computed, ref } from "vue";
import type { GameState, LobbyMember, LobbyModSettings, LobbyRoomState, UnitId } from "@numeral-lord/game-core";
import { getPlayerColor, getPlayerColorSprite, PLAYER_COLOR_OPTIONS } from "@numeral-lord/game-core";
import { parseMapCode } from "@numeral-lord/core-content";
import { missingTerrainMods, type ConfiguredMap } from "../map-library";
import { installedMapCatalogs, installedTerrainMods } from "../installed-content";
import HexBoard from "./HexBoard.vue";

type ModSetting = {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly kind: "integer" | "boolean" | "choice";
  readonly defaultValue: number | boolean | string;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
};

type InstalledMod = {
  readonly id: string;
  readonly terrains: readonly { readonly displayName: string }[];
  readonly settings?: readonly ModSetting[];
};

const props = defineProps<{
  room: LobbyRoomState;
  roomId: string;
  selfSessionId: string | null;
  previewState: GameState | null;
  previewPoweredUnitIds: readonly UnitId[];
  availableMaps: readonly ConfiguredMap[];
  errorMessage: string;
}>();

const emit = defineEmits<{
  ready: [ready: boolean];
  seat: [seat: number | null];
  participation: [participating: boolean];
  color: [playerColorId: string];
  settings: [settings: Record<string, boolean | number>];
  assign: [payload: { sessionId: string; seat?: number | null; participating?: boolean }];
  map: [mapCode: string];
  "mod-settings": [settings: LobbyModSettings];
}>();

const me = computed(() => props.room.members.find((member) => member.sessionId === props.selfSessionId));
const amHost = computed(() => Boolean(me.value?.isHost));
const participants = computed(() => props.room.members.filter((member) => member.participating));
const readyCount = computed(() => participants.value.filter((member) => member.ready && member.connected && member.missingModIds.length === 0).length);
const allSlotsReady = computed(() => participants.value.length > 0
  && readyCount.value === participants.value.length);
const mapOptions = computed(() => {
  if (props.availableMaps.some((map) => map.code === props.room.mapCode)) return props.availableMaps;
  try {
    return [{ code: props.room.mapCode, definition: parseMapCode(props.room.mapCode, { ...installedMapCatalogs, allowUnknownTerrainMods: true }), isDefault: false }, ...props.availableMaps];
  } catch {
    return props.availableMaps;
  }
});
const selectedMapIndex = computed(() => mapOptions.value.findIndex((map) => map.code === props.room.mapCode));
const selectedMapDefinition = computed(() => mapOptions.value[selectedMapIndex.value]?.definition);
const requiredMods = computed(() => props.room.requiredTerrainModIds.map((id) => ({
  id,
  definition: (installedTerrainMods as readonly InstalledMod[]).find((mod) => mod.id === id)
})));
const myMissingModIds = computed(() => me.value?.missingModIds ?? []);
const maximumTurnSeconds = computed(() => props.room.settings.matchTimeMinutes === 0
  ? 300
  : Math.min(300, props.room.settings.matchTimeMinutes * 60));
const copyStatus = ref("");
const inviteUrl = computed(() => {
  const url = new URL(window.location.href);
  url.searchParams.set("room", props.roomId);
  return url.toString();
});

async function copyInvite(): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(inviteUrl.value);
    copyStatus.value = "邀请链接已复制";
  } catch {
    const field = document.createElement("textarea");
    field.value = inviteUrl.value;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    copyStatus.value = copied ? "邀请链接已复制" : "无法自动复制，请手动复制房间号";
  }
}

function onMapSelect(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const index = Number(select.value);
  const map = mapOptions.value[index];
  if (map && missingTerrainMods(map).length === 0 && map.code !== props.room.mapCode) emit("map", map.code);
  // Server acknowledgement owns the committed value. A rejected map choice
  // must not appear selected merely because the native select changed.
  select.value = String(selectedMapIndex.value);
}

function seatLabel(member: LobbyMember): string {
  if (!member.participating) return "观战位";
  if (props.room.settings.randomizePositions) return "参战（开局随机位置）";
  return member.seat === null ? "参战（未选位）" : `${member.seat} 号位`;
}

function seatIsOccupied(seat: number, exceptSessionId: string): boolean {
  return props.room.members.some((member) => member.sessionId !== exceptSessionId && member.seat === seat);
}

function colorIsOccupied(playerColorId: string, exceptSessionId: string): boolean {
  return props.room.members.some((member) => member.sessionId !== exceptSessionId
    && member.participating && member.playerColorId === playerColorId);
}

function colorName(playerColorId: string | null): string {
  return PLAYER_COLOR_OPTIONS.find((color) => color.id === playerColorId)?.name ?? "未选择";
}

function availableColorsFor(member: LobbyMember) {
  return PLAYER_COLOR_OPTIONS.filter((color) => color.id === member.playerColorId
    || !colorIsOccupied(color.id, member.sessionId));
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
  const input = event.target as HTMLInputElement;
  emit("settings", { [key]: Number(input.value) });
  input.value = String(props.room.settings[key]);
}

function emitBooleanSetting(key: "friendlyFire" | "randomizePositions", event: Event): void {
  emit("settings", { [key]: (event.target as HTMLInputElement).checked });
}

function modDisplayName(mod: InstalledMod | undefined, id: string): string {
  return mod?.terrains.map((terrain) => terrain.displayName).join("、") || id;
}

function hasRoomOverride(modId: string, settingId: string): boolean {
  return Object.prototype.hasOwnProperty.call(props.room.roomModSettings[modId] ?? {}, settingId);
}

function settingValue(modId: string, setting: ModSetting): number | boolean | string {
  return props.room.roomModSettings[modId]?.[setting.id]
    ?? selectedMapDefinition.value?.modSettings?.[modId]?.[setting.id]
    ?? setting.defaultValue;
}

function settingSource(modId: string, setting: ModSetting): string {
  if (hasRoomOverride(modId, setting.id)) return "房主设置";
  if (Object.prototype.hasOwnProperty.call(selectedMapDefinition.value?.modSettings?.[modId] ?? {}, setting.id)) return "地图作者默认";
  return "Mod 默认";
}

function updateModSetting(modId: string, settingId: string, value: number | boolean | string | undefined): void {
  const next: Record<string, Record<string, number | boolean | string>> = Object.fromEntries(
    Object.entries(props.room.roomModSettings).map(([id, values]) => [id, { ...values }])
  );
  const modValues = { ...next[modId] };
  if (value === undefined) delete modValues[settingId];
  else modValues[settingId] = value;
  if (Object.keys(modValues).length === 0) delete next[modId];
  else next[modId] = modValues;
  emit("mod-settings", next);
}

function onModSettingChange(modId: string, setting: ModSetting, event: Event): void {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  if (setting.kind === "boolean") {
    updateModSetting(modId, setting.id, (input as HTMLInputElement).checked);
    return;
  }
  if (setting.kind === "choice") {
    if (setting.options?.includes(input.value)) updateModSetting(modId, setting.id, input.value);
    return;
  }
  if (input.value.trim() === "") {
    input.value = String(settingValue(modId, setting));
    return;
  }
  const value = Number(input.value);
  if (Number.isInteger(value) && value >= (setting.min ?? 0) && value <= (setting.max ?? Number.MAX_SAFE_INTEGER)) {
    updateModSetting(modId, setting.id, value);
  }
  input.value = String(settingValue(modId, setting));
}
</script>

<template>
  <section class="lobby-shell">
    <header class="lobby-header">
      <div>
        <p class="kicker">PVP LOBBY</p>
        <h2>对战准备房间</h2>
        <p>正在使用「{{ room.mapName }}」· {{ room.mapPlayerCount }} 个玩家位；当前 {{ room.members.length }} 人。多出的成员自动观战。</p>
        <div class="room-invite"><span>房间号 <b>{{ roomId }}</b></span><button @click="copyInvite">复制邀请链接</button><small v-if="copyStatus">{{ copyStatus }}</small></div>
        <p v-if="errorMessage" class="lobby-error" role="alert">{{ errorMessage }}</p>
      </div>
      <div class="lobby-header-side">
        <section class="map-preview-card">
          <div class="map-preview-title"><strong>{{ room.mapName }}</strong><span>{{ room.mapPlayerCount }} 个玩家位</span></div>
          <div class="map-preview-board">
            <HexBoard
              v-if="previewState"
              preview
              :state="previewState"
              :selected-unit-id="null"
              :legal-action-cell-ids="[]"
              :actionable-unit-ids="[]"
              :powered-unit-ids="previewPoweredUnitIds"
            />
            <p v-else class="preview-unavailable">缺少地图所需地块 Mod，暂不能显示真实棋盘预览。</p>
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
                <small v-if="member.missingModIds.length" class="missing-mod-note" :title="member.missingModIds.join('、')">缺少地块 Mod：{{ member.missingModIds.join("、") }}</small>
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

            <select
              v-if="member.participating && member.sessionId === selfSessionId"
              class="color-select"
              :value="member.playerColorId ?? ''"
              :style="{ '--swatch-color': getPlayerColor(member.playerColorId) }"
              aria-label="选择自己的棋子花色"
              @change="emit('color', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="color in availableColorsFor(member)" :key="color.id" :value="color.id">{{ color.name }}</option>
            </select>
            <span
              v-else-if="member.participating && member.playerColorId"
              class="color-readonly"
              :style="{ '--swatch-color': getPlayerColor(member.playerColorId) }"
            ><img :src="getPlayerColorSprite(member.playerColorId)" alt="" />{{ colorName(member.playerColorId) }}</span>
            <span v-else class="color-readonly spectator-color">—</span>

            <span class="ready-state" :class="{ ready: member.ready }">
              {{ !member.connected ? "重连中" : member.participating ? (member.missingModIds.length ? "缺少 Mod" : member.ready ? "已准备" : "未准备") : "观战" }}
            </span>
          </article>
        </div>

        <button
          v-if="me?.participating"
          class="ready-button"
          :class="{ active: me.ready }"
          :disabled="myMissingModIds.length > 0"
          @click="emit('ready', !me.ready)"
        >{{ myMissingModIds.length ? "缺少地块 Mod，暂不能准备" : me.ready ? "取消准备" : "准备" }}</button>
        <p v-if="me?.participating && myMissingModIds.length" class="dependency-warning">此设备缺少 {{ myMissingModIds.join("、") }}。安装所需地块 Mod 并重新进入房间后才能参战。</p>
        <p v-if="!me?.participating" class="spectator-note">你当前在观战位。切换到可用玩家位（随机模式为“参战”）后才能准备。</p>
      </section>

      <div class="settings-stack">
      <section class="lobby-card settings-card">
        <div class="section-title"><h3>房间设置</h3><span>{{ amHost ? "房主可修改" : "由房主设置" }}</span></div>
        <div class="map-setting">
          <label for="lobby-map-select"><strong>对局地图</strong><small>房主从本机已配置的地图中选择；其他成员会自动同步。</small></label>
          <select v-if="amHost" id="lobby-map-select" class="map-select" :value="selectedMapIndex" @change="onMapSelect">
            <option v-for="(map, index) in mapOptions" :key="`${map.definition.id}-${index}`" :value="index" :disabled="missingTerrainMods(map).length > 0">{{ map.definition.name }} · {{ map.definition.players }} 人{{ map.isDefault ? " · 默认" : "" }}{{ missingTerrainMods(map).length ? " · 缺少地块 Mod" : "" }}</option>
          </select>
          <div v-else class="map-selected-name">{{ room.mapName }} · {{ room.mapPlayerCount }} 人地图</div>
        </div>
        <label class="toggle-row">
          <span><strong>友方伤害</strong><small>开启后允许攻击同队单位</small></span>
          <input type="checkbox" :checked="room.settings.friendlyFire" :disabled="!amHost" @change="emitBooleanSetting('friendlyFire', $event)" />
        </label>
        <label class="toggle-row">
          <span><strong>随机位置与次序</strong><small>大厅只选择参战/观战，开局时随机分配地图位</small></span>
          <input type="checkbox" :checked="room.settings.randomizePositions" :disabled="!amHost" @change="emitBooleanSetting('randomizePositions', $event)" />
        </label>
        <div class="number-grid">
          <label><span>步时（秒）</span><input type="number" min="0" :max="maximumTurnSeconds" step="10" :value="room.settings.turnTimeSeconds" :disabled="!amHost" @change="emitNumberSetting('turnTimeSeconds', $event)" /><small>行动与加点共用；0 为不限时</small></label>
          <label><span>局时（分钟）</span><input type="number" min="0" max="180" step="1" :value="room.settings.matchTimeMinutes" :disabled="!amHost" @change="emitNumberSetting('matchTimeMinutes', $event)" /><small>每位玩家的累计用时；0 为不限时</small></label>
        </div>
        <p class="settings-hint">步时不能大于局时。两个阶段交接至少保留 2 秒；局时耗尽后每回合仍有 2 秒。切换地图或规则会取消所有人的准备。要添加新地图，请返回主页的“地图配置”导入地图码后再创建房间。</p>
      </section>
      <section class="lobby-card mod-settings-card">
        <div class="section-title"><h3>地块 Mod 设置</h3><span>{{ amHost ? "房主可覆盖地图默认值" : "当前生效配置" }}</span></div>
        <p v-if="requiredMods.length === 0" class="mod-empty">这张地图不需要额外地块 Mod。</p>
        <div v-for="item in requiredMods" :key="item.id" class="mod-group">
          <div class="mod-group-heading">
            <div><strong>{{ modDisplayName(item.definition, item.id) }}</strong><code>{{ item.id }}</code></div>
            <span :class="item.definition ? 'mod-installed' : 'mod-missing'">{{ item.definition ? "本机已安装" : "本机缺失" }}</span>
          </div>
          <p v-if="!item.definition" class="mod-description">此浏览器无法运行这个地块 Mod；参战成员必须安装后才能准备。</p>
          <p v-else-if="!item.definition.settings?.length" class="mod-description">该 Mod 没有可调整的公开参数。</p>
          <div v-for="setting in item.definition?.settings ?? []" :key="setting.id" class="mod-setting-row">
            <div class="mod-setting-copy">
              <label :for="`mod-setting-${item.id}-${setting.id}`">{{ setting.displayName }}</label>
              <small v-if="setting.description">{{ setting.description }}</small>
            </div>
            <div class="mod-setting-controls">
              <input
                v-if="setting.kind === 'integer'"
                :id="`mod-setting-${item.id}-${setting.id}`"
                type="number"
                step="1"
                :min="setting.min"
                :max="setting.max"
                :value="settingValue(item.id, setting)"
                :disabled="!amHost"
                @change="onModSettingChange(item.id, setting, $event)"
              />
              <input
                v-else-if="setting.kind === 'boolean'"
                :id="`mod-setting-${item.id}-${setting.id}`"
                type="checkbox"
                :checked="Boolean(settingValue(item.id, setting))"
                :disabled="!amHost"
                @change="onModSettingChange(item.id, setting, $event)"
              />
              <select
                v-else
                :id="`mod-setting-${item.id}-${setting.id}`"
                :value="settingValue(item.id, setting)"
                :disabled="!amHost"
                @change="onModSettingChange(item.id, setting, $event)"
              >
                <option v-for="option in setting.options ?? []" :key="option" :value="option">{{ option }}</option>
              </select>
              <button v-if="amHost && hasRoomOverride(item.id, setting.id)" class="reset-mod-setting" @click="updateModSetting(item.id, setting.id, undefined)">恢复地图设置</button>
            </div>
            <small class="mod-setting-source">{{ settingSource(item.id, setting) }}</small>
          </div>
        </div>
        <p class="settings-hint">地图作者可在地图码中设默认值；房主只修改本房间的覆盖值，不会改动地图作品。</p>
      </section>
      </div>
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
.lobby-error { max-width: 520px; margin-top: 12px !important; padding: 10px 12px; border: 1px solid rgba(251, 150, 150, .4); border-radius: 10px; color: #ffd0d0 !important; background: rgba(120, 39, 52, .18); font-size: 12px; line-height: 1.5; }
.lobby-header-side { display: grid; width: clamp(240px, 25vw, 320px); flex: 0 0 auto; gap: 9px; }
.map-preview-card { overflow: hidden; padding: 9px; border: 1px solid rgba(130, 167, 204, .3); border-radius: 16px; background: rgba(8, 19, 31, .7); }
.map-preview-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 2px 7px; }.map-preview-title strong { color: #dce9f7; font-size: 11px; }.map-preview-title span { color: #7892ad; font-size: 9px; }
.map-preview-board { height: clamp(150px, 14vw, 190px); }
.preview-unavailable { display: grid; place-items: center; height: 100%; margin: 0; padding: 12px; color: #a9bfd2; font-size: 11px; line-height: 1.5; text-align: center; }
.ready-summary { padding: 9px 13px; border: 1px solid rgba(103, 232, 249, .35); border-radius: 13px; background: rgba(8, 19, 31, .62); text-align: center; }
.ready-summary strong, .ready-summary span { display: block; }
.ready-summary strong { color: #fff; font-size: 22px; }.ready-summary span { margin-top: 2px; color: #91a8c0; font-size: 11px; }.ready-summary.complete { border-color: #4ade80; box-shadow: 0 0 24px rgba(74, 222, 128, .14); }
.lobby-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(280px, .75fr); align-items: start; gap: 16px; }
.settings-stack { display: grid; align-content: start; gap: 14px; min-width: 0; }
.lobby-card { padding: 18px; border: 1px solid rgba(130, 167, 204, .25); border-radius: 18px; background: rgba(8, 21, 34, .67); }
.section-title { justify-content: space-between; gap: 12px; margin-bottom: 14px; }.section-title h3 { margin: 0; color: #eaf4ff; font-size: 16px; }.section-title span { color: #7892ad; font-size: 11px; }
.member-list { display: grid; gap: 8px; }.member-row { display: grid; grid-template-columns: minmax(145px, 1fr) minmax(126px, .7fr) minmax(102px, .58fr) 70px; gap: 10px; padding: 10px 12px; border: 1px solid rgba(108, 145, 182, .22); border-radius: 12px; background: rgba(22, 43, 63, .62); }.member-row.disconnected { opacity: .55; }
.member-name { gap: 9px; min-width: 0; }.member-name strong, .member-name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.member-name strong { color: #f4f8fc; }.member-name small { color: #8fa7bf; font-size: 11px; }.presence { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #4ade80; box-shadow: 0 0 10px rgba(74, 222, 128, .6); }.disconnected .presence { background: #64748b; box-shadow: none; }
.member-name .missing-mod-note { margin-top: 3px; color: #fbbf94; }
.seat-select, .number-grid input { width: 100%; border: 1px solid rgba(129, 168, 207, .35); border-radius: 9px; background: #0d2032; color: #eaf4ff; outline: none; }.seat-select { padding: 7px 9px; }.seat-readonly { color: #bfd0e2; font-size: 12px; }.ready-state { color: #8fa5ba; font-size: 11px; text-align: right; }.ready-state.ready { color: #86efac; font-weight: 800; }
.color-select { width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid rgba(129,168,207,.35); border-left: 4px solid var(--swatch-color, #42566a); border-radius: 9px; outline: none; background: #0d2032; color: #eef5fb; }.color-readonly { display: flex; align-items: center; gap: 8px; min-width: 0; color: #c3d2df; font-size: 11px; }.color-readonly img { width: 24px; height: 22px; flex: 0 0 auto; object-fit: contain; }.spectator-color { color: #6f8499; }
.ready-button { width: 100%; margin-top: 14px; padding: 12px; border: 0; border-radius: 11px; background: linear-gradient(90deg, #5eead4, #60a5fa); color: #071626; font-weight: 900; cursor: pointer; }.ready-button.active { background: #223b52; color: #c5d6e7; }.spectator-note, .settings-hint { margin: 13px 0 0; color: #7f98b1; font-size: 11px; line-height: 1.55; }
.ready-button:disabled { cursor: not-allowed; background: #344a5e; color: #c3d0dd; }
.dependency-warning { margin: 10px 0 0; padding: 9px 11px; border: 1px solid rgba(251, 191, 146, .4); border-radius: 9px; color: #ffd8ba; background: rgba(109, 60, 39, .24); font-size: 11px; line-height: 1.5; }
.toggle-row { justify-content: space-between; gap: 16px; padding: 11px 0; border-bottom: 1px solid rgba(122, 157, 191, .16); }.toggle-row strong, .toggle-row small { display: block; }.toggle-row strong { color: #dce9f7; font-size: 13px; }.toggle-row small { margin-top: 2px; color: #8299b0; font-size: 10px; }.toggle-row input { width: 18px; height: 18px; accent-color: #67e8f9; }
.number-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-top: 14px; }.number-grid label span, .number-grid label small { display: block; }.number-grid label span { margin-bottom: 5px; color: #aabed2; font-size: 11px; }.number-grid input { box-sizing: border-box; padding: 8px; }.number-grid label small { margin-top: 4px; color: #647c94; font-size: 9px; }
.map-setting { display: grid; gap: 10px; padding: 14px; border: 1px solid rgba(103, 232, 249, .22); border-radius: 14px; background: rgba(32, 72, 88, .27); }
.map-setting strong, .map-setting small { display: block; }
.map-setting strong { color: #f1fbff; font-size: 14px; }
.map-setting small { margin-top: 3px; color: #a1b9c9; font-size: 11px; line-height: 1.5; }
.map-select, .map-selected-name { box-sizing: border-box; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid rgba(129, 201, 223, .43); border-radius: 10px; background: #102b3d; color: #eefaff; font: inherit; font-size: 13px; }
.map-select { cursor: pointer; }
.map-select:focus-visible, .seat-select:focus-visible, .number-grid input:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
.map-selected-name { display: flex; align-items: center; color: #a8eaf5; }
.seat-select { min-height: 42px; }
.ready-button { min-height: 48px; font-size: 14px; }
.room-invite button { min-height: 38px; }
.mod-empty, .mod-description { margin: 0; color: #91a8c0; font-size: 11px; line-height: 1.5; }
.mod-group { padding: 13px; border: 1px solid rgba(112, 155, 193, .23); border-radius: 13px; background: rgba(24, 46, 64, .5); }
.mod-group + .mod-group { margin-top: 9px; }
.mod-group-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
.mod-group-heading strong, .mod-group-heading code { display: block; }
.mod-group-heading strong { color: #edf6ff; font-size: 13px; }
.mod-group-heading code { margin-top: 3px; color: #8aabc4; font-size: 10px; }
.mod-group-heading span { flex: 0 0 auto; padding: 4px 6px; border-radius: 6px; font-size: 10px; }
.mod-installed { color: #a7f3d0; background: rgba(45, 114, 95, .25); }
.mod-missing { color: #ffd0ae; background: rgba(144, 75, 47, .3); }
.mod-setting-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(110px, .7fr); align-items: center; gap: 5px 11px; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(122, 157, 191, .15); }
.mod-setting-copy label, .mod-setting-copy small { display: block; }
.mod-setting-copy label { color: #e7f0f8; font-size: 12px; font-weight: 700; }
.mod-setting-copy small { margin-top: 3px; color: #8da4b8; font-size: 10px; line-height: 1.4; }
.mod-setting-controls { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.mod-setting-controls input[type="number"], .mod-setting-controls select { box-sizing: border-box; width: 100%; min-height: 37px; padding: 6px 8px; border: 1px solid rgba(129, 168, 207, .35); border-radius: 8px; background: #0d2032; color: #eaf4ff; }
.mod-setting-controls input[type="checkbox"] { width: 18px; height: 18px; accent-color: #67e8f9; }
.mod-setting-controls input:disabled, .mod-setting-controls select:disabled { opacity: .72; }
.reset-mod-setting { padding: 3px 0; border: 0; background: transparent; color: #8de4ed; font-size: 10px; cursor: pointer; }
.mod-setting-source { grid-column: 1 / -1; color: #7995aa; font-size: 10px; }
@media (max-width: 800px) { .lobby-shell { padding: 15px; }.lobby-header { display: grid; }.lobby-header-side { width: 100%; grid-template-columns: minmax(0, 1fr) 130px; align-items: stretch; }.map-preview-board { height: 170px; }.ready-summary { display: grid; align-content: center; }.lobby-grid { grid-template-columns: 1fr; }.member-row { grid-template-columns: minmax(115px, 1fr) minmax(105px, .7fr) minmax(96px, .6fr) 58px; }.number-grid { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .lobby-header-side { grid-template-columns: 1fr; }.ready-summary { min-width: 0; }.member-row { grid-template-columns: minmax(0, 1fr) 118px; }.color-readonly, .color-select { grid-column: 1; }.ready-state { grid-column: 2; grid-row: 2; text-align: right; }.mod-setting-row { grid-template-columns: minmax(0, 1fr) 105px; } }
</style>
