<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { GameState, LobbyMember, LobbyModSettings, LobbyRoomState, TerrainCatalog, UnitId } from "@numeral-lord/game-core";
import { getPlayerColorSprite, getPoweredUnitIds, PLAYER_COLOR_OPTIONS } from "@numeral-lord/game-core";
import { createMatchFromMapCode, parseMapCode } from "@numeral-lord/core-content";
import { missingTerrainMods, type ConfiguredMap } from "../maps/map-library";
import { runtimeMapCatalogs, loadedTerrainCatalog, loadedTerrainCatalogRevision, loadedTerrainMods, resolveMapCatalogs, terrainVisualAssetsForCatalogs } from "../content/installed-content";
import HexBoard from "./HexBoard.vue";
import NumberStepper from "./NumberStepper.vue";

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
  readonly terrain?: { readonly displayName: string };
  readonly settings?: readonly ModSetting[];
};

const props = defineProps<{
  room: LobbyRoomState;
  roomId: string;
  selfSessionId: string | null;
  previewState: GameState | null;
  previewPoweredUnitIds: readonly UnitId[];
  previewTerrainCatalog?: TerrainCatalog;
  previewTerrainVisualAssets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  updatingModId: string | null;
  modUpdateMessage: string;
  subscribedUpdatesPending: boolean;
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
  "open-workshop-mod": [id: string];
  "update-mod": [id: string];
}>();

const me = computed(() => props.room.members.find((member) => member.sessionId === props.selfSessionId));
const amHost = computed(() => Boolean(me.value?.isHost));
const participants = computed(() => props.room.members.filter((member) => member.participating));
const mapOptions = computed(() => {
  if (props.availableMaps.some((map) => map.code === props.room.mapCode)) return props.availableMaps;
  try {
    return [{ code: props.room.mapCode, definition: parseMapCode(props.room.mapCode, { ...runtimeMapCatalogs, allowUnknownTerrainMods: true }), isDefault: false }, ...props.availableMaps];
  } catch {
    return props.availableMaps;
  }
});
const selectedMapIndex = computed(() => mapOptions.value.findIndex((map) => map.code === props.room.mapCode));
const selectedMapDefinition = computed(() => mapOptions.value[selectedMapIndex.value]?.definition);
const mapOptionPreviews = computed(() => {
  void loadedTerrainCatalogRevision.value;
  return new Map(mapOptions.value.flatMap((map) => {
    try {
      const catalogs = resolveMapCatalogs(map.code);
      if (!catalogs) return [];
      const state = createMatchFromMapCode(map.code, catalogs);
      const terrainCatalog = catalogs.terrains ?? loadedTerrainCatalog;
      return [[map.code, {
        state,
        poweredUnitIds: [...getPoweredUnitIds(state, terrainCatalog)],
        terrainCatalog,
        terrainVisualAssets: terrainVisualAssetsForCatalogs(catalogs)
      }] as const];
    } catch {
      return [];
    }
  }));
});
const requiredMods = computed(() => props.room.requiredTerrainModIds.map((id) => ({
  id,
  definition: (loadedTerrainMods as readonly InstalledMod[]).find((mod) => mod.id === id)
})));
const cannotPrepare = computed(() => props.subscribedUpdatesPending);
const maximumTurnSeconds = computed(() => props.room.settings.matchTimeMinutes === 0
  ? 300
  : Math.min(300, props.room.settings.matchTimeMinutes * 60));
const copyStatus = ref("");
const mapPickerOpen = ref(false);
const visibleMapCount = ref(10);
const visibleMapOptions = computed(() => mapOptions.value.slice(0, visibleMapCount.value));
const mapPreviewModalOpen = ref(false);
const openColorPickerSessionId = ref<string | null>(null);
const openSeatPickerSessionId = ref<string | null>(null);
const activeTab = ref<"players" | "settings" | "mods">("players");
const readyActionLabel = computed(() => props.subscribedUpdatesPending
  ? "正在从服务器加载地块…"
  : me.value?.ready ? "取消准备" : "准备");
const openSeats = computed(() => {
  const totalSeats = Math.max(0, Math.floor(props.room.mapPlayerCount));
  if (props.room.settings.randomizePositions) {
    const openCount = Math.max(0, totalSeats - participants.value.length);
    return Array.from({ length: openCount }, (_, index) => ({
      key: `random-${index}`,
      label: "随机位置",
      description: "等待玩家加入"
    }));
  }
  const assignedSeats = new Set(participants.value
    .map((member) => member.seat)
    .filter((seat): seat is number => seat !== null));
  return Array.from({ length: totalSeats }, (_, index) => index + 1)
    .filter((seat) => !assignedSeats.has(seat))
    .map((seat) => ({ key: `seat-${seat}`, label: `${seat} 号位`, description: "等待玩家加入" }));
});
const inviteUrl = computed(() => {
  const url = new URL(window.location.href);
  url.searchParams.set("room", props.roomId);
  return url.toString();
});

function mapOptionPreview(map: ConfiguredMap) {
  return mapOptionPreviews.value.get(map.code);
}

function choosePreviewMap(map: ConfiguredMap): void {
  if (missingTerrainMods(map).length === 0 && map.code !== props.room.mapCode) emit("map", map.code);
  mapPickerOpen.value = false;
}

function togglePreviewMapPicker(): void {
  mapPickerOpen.value = !mapPickerOpen.value;
  if (mapPickerOpen.value) visibleMapCount.value = 10;
}

function loadMorePreviewMaps(event: Event): void {
  const list = event.currentTarget as HTMLElement;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 48) {
    visibleMapCount.value = Math.min(mapOptions.value.length, visibleMapCount.value + 10);
  }
}

function onMapPickerKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    mapPickerOpen.value = false;
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const picker = event.currentTarget as HTMLElement;
  const focusOption = (): void => {
    const options = [...picker.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const selectedIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
    const from = currentIndex < 0 ? Math.max(0, selectedIndex) : currentIndex;
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : (from + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[nextIndex]?.focus();
  };
  if (!mapPickerOpen.value) {
    visibleMapCount.value = 10;
    mapPickerOpen.value = true;
    void nextTick(focusOption);
  } else focusOption();
}

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

function memberStatusLabel(member: LobbyMember): string {
  if (!member.connected) return "离线";
  if (!member.participating) return "观战";
  return member.ready ? "已准备" : "未准备";
}

function seatIsOccupied(seat: number, exceptSessionId: string): boolean {
  return props.room.members.some((member) => member.sessionId !== exceptSessionId && member.seat === seat);
}

function memberRoleValue(member: LobbyMember): string {
  if (props.room.settings.randomizePositions) return member.participating ? "play" : "spectate";
  return String(member.seat ?? "spectate");
}

function memberRoleOptions(member: LobbyMember): { value: string; label: string; disabled?: boolean }[] {
  if (props.room.settings.randomizePositions) return [
    { value: "play", label: "参战" },
    { value: "spectate", label: "观战位" }
  ];
  return [
    { value: "spectate", label: "观战位" },
    ...Array.from({ length: Math.max(0, Math.floor(props.room.mapPlayerCount)) }, (_, index) => {
      const seat = index + 1;
      return { value: String(seat), label: `${seat} 号位`, disabled: seatIsOccupied(seat, member.sessionId) };
    })
  ];
}

function memberRoleLabel(member: LobbyMember): string {
  return memberRoleOptions(member).find((option) => option.value === memberRoleValue(member))?.label ?? seatLabel(member);
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

function toggleColorPicker(sessionId: string): void {
  openSeatPickerSessionId.value = null;
  openColorPickerSessionId.value = openColorPickerSessionId.value === sessionId ? null : sessionId;
}

function choosePlayerColor(playerColorId: string): void {
  emit("color", playerColorId);
  openColorPickerSessionId.value = null;
}

function onMemberRoleChange(member: LobbyMember, value: string): void {
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

function toggleSeatPicker(sessionId: string): void {
  openColorPickerSessionId.value = null;
  openSeatPickerSessionId.value = openSeatPickerSessionId.value === sessionId ? null : sessionId;
}

function chooseMemberRole(member: LobbyMember, value: string, event: MouseEvent): void {
  onMemberRoleChange(member, value);
  openSeatPickerSessionId.value = null;
  (event.currentTarget as HTMLElement).closest(".seat-picker")?.querySelector<HTMLButtonElement>(".seat-select")?.focus();
}

function onSeatPickerKeydown(event: KeyboardEvent, member: LobbyMember): void {
  const picker = event.currentTarget as HTMLElement;
  if (event.key === "Escape") {
    event.preventDefault();
    openSeatPickerSessionId.value = null;
    picker.querySelector<HTMLButtonElement>(".seat-select")?.focus();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const focusOption = (): void => {
    const options = [...picker.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const selectedIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
    const from = currentIndex < 0 ? Math.max(0, selectedIndex) : currentIndex;
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : (from + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[nextIndex]?.focus();
  };
  if (openSeatPickerSessionId.value !== member.sessionId) {
    openColorPickerSessionId.value = null;
    openSeatPickerSessionId.value = member.sessionId;
    void nextTick(focusOption);
  } else focusOption();
}

function emitNumberSetting(key: "turnTimeSeconds" | "matchTimeMinutes", value: number): void {
  emit("settings", { [key]: value });
}

function emitBooleanSetting(key: "friendlyFire" | "randomizePositions", event: Event): void {
  emit("settings", { [key]: (event.target as HTMLInputElement).checked });
}

function modDisplayName(mod: InstalledMod | undefined, id: string): string {
  return mod?.terrain?.displayName || id;
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
  }
}

function onModIntegerSettingChange(modId: string, setting: ModSetting, value: number): void {
  const normalized = Math.round(value);
  if (normalized >= (setting.min ?? 0) && normalized <= (setting.max ?? Number.MAX_SAFE_INTEGER)) {
    updateModSetting(modId, setting.id, normalized);
  }
}
</script>

<template>
  <section class="lobby-shell" @click="openColorPickerSessionId = null; openSeatPickerSessionId = null; mapPickerOpen = false" @keydown.esc.window="mapPreviewModalOpen = false; mapPickerOpen = false">
    <header class="lobby-header">
      <div>
        <p class="kicker">PVP LOBBY</p>
        <h2>对战准备房间</h2>
        <p>正在使用「{{ room.mapName }}」· {{ room.mapPlayerCount }} 个玩家位；当前 {{ room.members.length }} 人。多出的成员自动观战。</p>
        <p v-if="errorMessage" class="lobby-error" role="alert">{{ errorMessage }}</p>
      </div>
      <button class="header-copy-invite" type="button" :aria-label="copyStatus || '复制邀请链接'" @click="copyInvite">{{ copyStatus || "复制邀请链接" }} <span aria-hidden="true">↗</span></button>
    </header>

    <div class="lobby-layout">
      <main class="lobby-main">
        <nav class="lobby-tabs" role="tablist" aria-label="准备房间功能区">
          <button id="lobby-tab-players" type="button" role="tab" :aria-selected="activeTab === 'players'" :class="{ active: activeTab === 'players' }" @click="activeTab = 'players'">
            <span class="tab-index">01</span><span>成员与位置</span><small>{{ participants.length }} / {{ room.mapPlayerCount }}</small>
          </button>
          <button id="lobby-tab-settings" type="button" role="tab" :aria-selected="activeTab === 'settings'" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">
            <span class="tab-index">02</span><span>房间规则</span><small>{{ amHost ? "房主设置" : "房间信息" }}</small>
          </button>
          <button id="lobby-tab-mods" type="button" role="tab" :aria-selected="activeTab === 'mods'" :class="{ active: activeTab === 'mods' }" @click="activeTab = 'mods'">
            <span class="tab-index">03</span><span>地图 Mod</span><small>{{ requiredMods.length }} 项依赖</small>
          </button>
        </nav>

        <section v-if="activeTab === 'players'" class="lobby-card member-card tab-page" role="tabpanel" aria-labelledby="lobby-tab-players">
        <div class="section-title"><div><h3>参战成员</h3><span class="section-subtitle">选择位置与棋子颜色，全部就绪后由房主开始</span></div><span>{{ room.members.length }} 人在线</span></div>
        <div class="member-list">
          <article v-for="member in room.members" :key="member.sessionId" class="member-row" :class="{ disconnected: !member.connected, 'member-self': member.sessionId === selfSessionId, 'member-ready': member.ready }">
            <div class="member-name">
              <span class="presence" />
              <div>
                <strong>{{ member.displayName }}</strong>
                <small><b v-if="member.isHost">房主 · </b>{{ seatLabel(member) }}</small>
              </div>
            </div>

            <div
              v-if="member.sessionId === selfSessionId || amHost"
              class="seat-picker"
              @click.stop
              @keydown="onSeatPickerKeydown($event, member)"
            >
              <button
                type="button"
                class="seat-select"
                :aria-label="`调整 ${member.displayName} 的位置`"
                aria-haspopup="listbox"
                :aria-expanded="openSeatPickerSessionId === member.sessionId"
                :aria-controls="`seat-picker-${member.sessionId}`"
                @click="toggleSeatPicker(member.sessionId)"
              ><span>{{ memberRoleLabel(member) }}</span><span class="seat-select-chevron" aria-hidden="true" /></button>
              <div v-if="openSeatPickerSessionId === member.sessionId" :id="`seat-picker-${member.sessionId}`" class="seat-picker-menu" role="listbox" :aria-label="`${member.displayName}的可选位置`">
                <button
                  v-for="option in memberRoleOptions(member)"
                  :key="option.value"
                  type="button"
                  role="option"
                  class="seat-option"
                  :class="{ selected: option.value === memberRoleValue(member) }"
                  :aria-selected="option.value === memberRoleValue(member)"
                  :disabled="option.disabled"
                  tabindex="-1"
                  @click.stop="chooseMemberRole(member, option.value, $event)"
                ><span>{{ option.label }}</span><span class="seat-option-mark" aria-hidden="true">{{ option.value === memberRoleValue(member) ? "✓" : option.disabled ? "占用" : "" }}</span></button>
              </div>
            </div>
            <span v-else class="seat-readonly">{{ seatLabel(member) }}</span>

            <div
              v-if="member.participating && member.sessionId === selfSessionId"
              class="color-picker"
              @click.stop
            >
              <button
                class="color-preview-button"
                type="button"
                :aria-label="`当前花色：${colorName(member.playerColorId)}，点击更换`"
                :aria-expanded="openColorPickerSessionId === member.sessionId"
                @click="toggleColorPicker(member.sessionId)"
              >
                <img :src="getPlayerColorSprite(member.playerColorId)" alt="" />
              </button>
              <div v-if="openColorPickerSessionId === member.sessionId" class="color-picker-menu" role="listbox" aria-label="可选棋子花色">
                <button
                  v-for="color in availableColorsFor(member)"
                  :key="color.id"
                  type="button"
                  role="option"
                  :aria-selected="member.playerColorId === color.id"
                  :aria-label="`选择${color.name}花色`"
                  :title="color.name"
                  @click.stop="choosePlayerColor(color.id)"
                ><img :src="getPlayerColorSprite(color.id)" alt="" /></button>
              </div>
            </div>
            <span
              v-else-if="member.participating && member.playerColorId"
              class="color-readonly"
              :title="`${member.displayName}的棋子花色：${colorName(member.playerColorId)}`"
            ><img :src="getPlayerColorSprite(member.playerColorId)" alt="" /></span>
            <span v-else class="color-readonly spectator-color">—</span>

            <span
              class="ready-state"
              :class="{ ready: member.ready, offline: !member.connected, spectator: !member.participating }"
              role="img"
              :aria-label="memberStatusLabel(member)"
              :title="memberStatusLabel(member)"
            />
          </article>
          <article v-for="seat in openSeats" :key="seat.key" class="open-seat-card">
            <span class="open-seat-icon" aria-hidden="true">＋</span>
            <span><strong>{{ seat.label }}</strong><small>{{ seat.description }}</small></span>
            <span class="open-seat-state">可加入</span>
          </article>
        </div>
        <p class="dependency-scope-note">地图所需地块由服务器数据库统一提供；是否订阅不影响开局或加入房间。</p>
        <p v-if="subscribedUpdatesPending" class="dependency-warning">正在从服务器加载对局所需地块…</p>
        <p v-if="modUpdateMessage" class="mod-update-message" role="status">{{ modUpdateMessage }}</p>
        <p v-if="!me?.participating" class="spectator-note">你当前在观战位。切换到可用玩家位（随机模式为“参战”）后才能准备。</p>
        <div v-if="me?.participating" class="member-actions">
          <button
            type="button"
            class="ready-button member-prepare-button"
            :class="{ active: me.ready }"
            :disabled="cannotPrepare"
            :aria-label="readyActionLabel"
            :aria-pressed="me.ready"
            :title="readyActionLabel"
            @click.stop="emit('ready', !me.ready)"
          ><span>{{ readyActionLabel }}</span><span class="ready-button-icon" aria-hidden="true">{{ me.ready ? "↶" : "✓" }}</span></button>
        </div>
      </section>

      <section v-else-if="activeTab === 'settings'" class="lobby-card settings-card tab-page" role="tabpanel" aria-labelledby="lobby-tab-settings">
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
          <div class="number-field"><label for="turn-time-seconds">步时（秒）</label><NumberStepper id="turn-time-seconds" :model-value="room.settings.turnTimeSeconds" :min="0" :max="maximumTurnSeconds" :step="10" aria-label="步时（秒）" :disabled="!amHost" @change="emitNumberSetting('turnTimeSeconds', $event)" /><small>行动与加点共用；0 为不限时</small></div>
          <div class="number-field"><label for="match-time-minutes">局时（分钟）</label><NumberStepper id="match-time-minutes" :model-value="room.settings.matchTimeMinutes" :min="0" :max="180" aria-label="局时（分钟）" :disabled="!amHost" @change="emitNumberSetting('matchTimeMinutes', $event)" /><small>每位玩家的累计用时；0 为不限时</small></div>
        </div>
        <p class="settings-hint">步时不能大于局时。两个阶段交接至少保留 2 秒；局时耗尽后每回合仍有 2 秒。切换地图或规则会取消所有人的准备。要添加新地图，请返回主页的“地图配置”导入地图码后再创建房间。</p>
      </section>

      <section v-else class="lobby-card mod-settings-card tab-page" role="tabpanel" aria-labelledby="lobby-tab-mods">
        <div class="section-title"><h3>地块 Mod 设置</h3><span>{{ amHost ? "房主可覆盖地图默认值" : "当前生效配置" }}</span></div>
        <p v-if="requiredMods.length === 0" class="mod-empty">这张地图不需要额外地块 Mod。</p>
        <div v-for="item in requiredMods" :key="item.id" class="mod-group">
          <div class="mod-group-heading">
            <div><strong>{{ modDisplayName(item.definition, item.id) }}</strong><code>{{ item.id }}</code></div>
            <span :class="item.definition ? 'mod-installed' : 'mod-missing'">{{ item.definition ? "服务器已加载" : "等待服务器加载" }}</span>
          </div>
          <p v-if="!item.definition" class="mod-description">正在按地图中的 Mod ID 从服务器数据库读取当前定义。</p>
          <p v-else-if="!item.definition.settings?.length" class="mod-description">该 Mod 没有可调整的公开参数。</p>
          <div v-for="setting in item.definition?.settings ?? []" :key="setting.id" class="mod-setting-row">
            <div class="mod-setting-copy">
              <label :for="`mod-setting-${item.id}-${setting.id}`">{{ setting.displayName }}</label>
              <small v-if="setting.description">{{ setting.description }}</small>
            </div>
            <div class="mod-setting-controls">
              <NumberStepper
                v-if="setting.kind === 'integer'"
                :id="`mod-setting-${item.id}-${setting.id}`"
                :step="1"
                :min="setting.min ?? 0"
                :max="setting.max ?? Number.MAX_SAFE_INTEGER"
                :model-value="Number(settingValue(item.id, setting))"
                :disabled="!amHost"
                :aria-label="setting.displayName"
                @change="onModIntegerSettingChange(item.id, setting, $event)"
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

      </main>

      <aside class="lobby-aside">
        <section class="map-preview-card">
          <div class="map-preview-picker" @keydown="onMapPickerKeydown">
            <div class="map-preview-picker-heading">
              <strong>{{ amHost ? "选择地图" : "当前地图" }}</strong>
              <small>{{ amHost ? "从本机地图中选择" : "由房主统一设置" }}</small>
            </div>
            <div class="map-picker" @click.stop>
              <button
                v-if="amHost"
                id="lobby-preview-map-select"
                class="map-picker-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-controls="lobby-preview-map-options"
                :aria-expanded="mapPickerOpen"
                :aria-label="`当前地图：${selectedMapDefinition?.name ?? room.mapName}，${selectedMapDefinition?.players ?? room.mapPlayerCount} 个玩家位；点击更换地图`"
                @click.stop="togglePreviewMapPicker"
              >
                <span class="map-picker-trigger-copy"><strong>{{ selectedMapDefinition?.name ?? room.mapName }}</strong><small>{{ selectedMapDefinition?.players ?? room.mapPlayerCount }} 个玩家位</small></span>
                <span class="map-picker-chevron" :class="{ open: mapPickerOpen }" aria-hidden="true" />
              </button>
              <div v-else class="map-picker-trigger readonly">
                <span class="map-picker-trigger-copy"><strong>{{ selectedMapDefinition?.name ?? room.mapName }}</strong><small>{{ selectedMapDefinition?.players ?? room.mapPlayerCount }} 个玩家位</small></span>
              </div>
              <div v-if="amHost && mapPickerOpen" id="lobby-preview-map-options" class="map-picker-options" role="listbox" aria-label="可选地图" @scroll.passive="loadMorePreviewMaps">
                <button
                  v-for="map in visibleMapOptions"
                  :key="map.code"
                  type="button"
                  role="option"
                  class="map-picker-option"
                  :class="{ selected: map.code === room.mapCode }"
                  :aria-selected="map.code === room.mapCode"
                  :disabled="missingTerrainMods(map).length > 0"
                  @click.stop="choosePreviewMap(map)"
                >
                  <span class="map-picker-option-preview" role="img" :aria-label="`${map.definition.name}地图预览`">
                    <HexBoard
                      v-if="mapOptionPreview(map)"
                      preview
                      :show-unit-labels="false"
                      :state="mapOptionPreview(map)!.state"
                      :selected-unit-id="null"
                      :legal-action-cell-ids="[]"
                      :actionable-unit-ids="[]"
                      :powered-unit-ids="mapOptionPreview(map)!.poweredUnitIds"
                      :terrain-catalog="mapOptionPreview(map)!.terrainCatalog"
                      :terrain-visual-assets="mapOptionPreview(map)!.terrainVisualAssets"
                    />
                    <span v-else class="map-picker-no-preview">正在从服务器加载地图地块</span>
                  </span>
                  <span class="map-picker-option-copy">
                    <strong>{{ map.definition.name }}</strong>
                    <small>{{ map.definition.columns }} × {{ map.definition.terrain.length / map.definition.columns }} 格 · {{ map.definition.players }} 个玩家位</small>
                    <small v-if="map.isDefault" class="map-picker-default">默认地图</small>
                    <small v-if="missingTerrainMods(map).length" class="map-picker-missing">缺少地块 Mod</small>
                  </span>
                  <span class="map-picker-selected-mark" aria-hidden="true">{{ map.code === room.mapCode ? "✓" : "" }}</span>
                </button>
                <small v-if="visibleMapOptions.length < mapOptions.length" class="map-picker-load-hint">继续滚动，每次加载 10 张地图</small>
              </div>
            </div>
          </div>
          <button class="map-preview-open" type="button" @click="mapPreviewModalOpen = true">查看地图预览 <span aria-hidden="true">↗</span></button>
          <Teleport to="body" :disabled="!mapPreviewModalOpen">
            <div
              class="map-preview-stage"
              :class="{ 'is-modal': mapPreviewModalOpen }"
              :role="mapPreviewModalOpen ? 'dialog' : undefined"
              :aria-modal="mapPreviewModalOpen ? 'true' : undefined"
              :aria-label="mapPreviewModalOpen ? '地图预览' : undefined"
              :tabindex="mapPreviewModalOpen ? 0 : undefined"
              @click.capture="mapPreviewModalOpen = false"
            >
              <div class="map-preview-board" :class="{ 'is-modal': mapPreviewModalOpen }">
                <HexBoard
                  v-if="previewState"
                  preview
                  :show-unit-labels="false"
                  :state="previewState"
                  :selected-unit-id="null"
                  :legal-action-cell-ids="[]"
                  :actionable-unit-ids="[]"
                  :powered-unit-ids="previewPoweredUnitIds"
                  :terrain-catalog="previewTerrainCatalog"
                  :terrain-visual-assets="previewTerrainVisualAssets"
                />
                <p v-else class="preview-unavailable">缺少地图所需地块 Mod，暂不能显示真实棋盘预览。</p>
              </div>
              <span v-if="mapPreviewModalOpen" class="map-preview-dismiss">点击任意位置关闭</span>
            </div>
          </Teleport>
        </section>
        <p class="aside-tip">{{ amHost ? "调整规则或地图后，所有成员需要重新准备。" : "地图、规则与 Mod 版本由房主统一设置。" }}</p>
      </aside>
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
.lobby-header-side { display: grid; width: clamp(280px, 29vw, 420px); flex: 0 0 auto; gap: 9px; }
.map-preview-card { min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.map-preview-picker { display: grid; gap: 8px; margin-bottom: 11px; padding: 0; border: 0; border-radius: 0; background: transparent; }
.map-preview-picker-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.map-preview-picker-heading strong { color: #dcecf5; font-size: 11px; font-weight: 750; }
.map-preview-picker-heading small { color: #7f9bb0; font-size: 9px; text-align: right; }
.map-picker { position: relative; z-index: 5; }
.map-picker-trigger { display: flex; width: 100%; min-height: 42px; align-items: center; justify-content: space-between; gap: 12px; margin: 0; padding: 8px 11px; border: 1px solid rgba(117, 172, 192, .3); border-radius: 9px; color: #e6f2ff; background: #0b2031; text-align: left; cursor: pointer; }
.map-picker-trigger:hover, .map-picker-trigger[aria-expanded="true"] { border-color: rgba(103, 190, 190, .62); background: #10293a; }
.map-picker-trigger:focus-visible, .map-picker-option:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
.map-picker-trigger.readonly { cursor: default; }
.map-picker-trigger-copy { display: grid; min-width: 0; gap: 2px; }
.map-picker-trigger-copy strong { overflow: hidden; color: #f0f7ff; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.map-picker-trigger-copy small { color: #8daabd; font-size: 9px; }
.map-picker-chevron { width: 8px; height: 8px; flex: 0 0 auto; margin: -4px 3px 0 0; transform: rotate(45deg); border-right: 1.5px solid #9ab6c8; border-bottom: 1.5px solid #9ab6c8; transition: transform .16s ease; }
.map-picker-chevron.open { margin-top: 4px; transform: rotate(225deg); }
.map-picker-options { position: absolute; z-index: 30; top: calc(100% + 6px); right: 0; left: 0; display: grid; max-height: min(58vh, 430px); gap: 6px; overflow-y: auto; padding: 7px; border: 1px solid rgba(117, 172, 192, .35); border-radius: 12px; background: #091827; box-shadow: 0 16px 36px rgba(0, 0, 0, .5); overscroll-behavior: contain; }
.map-picker-option { display: grid; width: 100%; min-height: 78px; grid-template-columns: minmax(78px, 30%) minmax(0, 1fr) 18px; align-items: center; gap: 9px; margin: 0; padding: 6px; border: 1px solid rgba(117, 153, 183, .2); border-radius: 8px; color: #e6f2ff; background: rgba(18, 39, 57, .84); text-align: left; cursor: pointer; }
.map-picker-option:hover:not(:disabled), .map-picker-option.selected { border-color: rgba(103, 190, 190, .55); background: rgba(24, 65, 77, .75); }
.map-picker-option:disabled { opacity: .58; cursor: not-allowed; }
.map-picker-option-preview { display: block; width: 100%; height: 64px; overflow: hidden; border-radius: 6px; background: #182638; }
.map-picker-option-preview :deep(.board-canvas) { width: 100%; height: 100%; min-height: 0; border: 0; border-radius: 6px; background: #182638; }
.map-picker-no-preview { display: grid; width: 100%; height: 100%; place-items: center; padding: 5px; color: #a9bdd0; font-size: 8px; text-align: center; }
.map-picker-option-copy { display: grid; min-width: 0; gap: 4px; }
.map-picker-option-copy strong { overflow: hidden; color: #f0f7ff; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.map-picker-option-copy small { overflow: hidden; color: #8fa9bc; font-size: 8px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.map-picker-option-copy .map-picker-default { color: #83ddd0; }
.map-picker-option-copy .map-picker-missing { color: #f3bb8a; }
.map-picker-selected-mark { color: #81e8d4; font-size: 12px; font-weight: 900; text-align: center; }
.map-preview-stage { min-width: 0; }
.map-preview-board { height: clamp(240px, 25vw, 360px); overflow: hidden; border: 0; border-radius: 10px; background: radial-gradient(ellipse at 50% 46%, rgba(48, 77, 105, .19), rgba(7, 15, 26, .08) 72%); }
.map-preview-open { display: none; }
.map-preview-stage.is-modal { position: fixed; z-index: 1000; inset: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto; place-items: center; gap: 12px; padding: max(18px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: rgba(3, 10, 18, .9); backdrop-filter: blur(8px); cursor: pointer; }
.map-preview-board.is-modal { width: min(94vw, 1100px); height: min(78dvh, 760px); border: 1px solid rgba(130, 167, 204, .34); border-radius: 16px; background: #102032; box-shadow: 0 24px 80px rgba(0, 0, 0, .52); }
.map-preview-dismiss { color: #b8cbd9; font-size: 11px; text-align: center; }
.preview-unavailable { display: grid; place-items: center; height: 100%; margin: 0; padding: 12px; color: #a9bfd2; font-size: 11px; line-height: 1.5; text-align: center; }
.lobby-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(280px, .75fr); align-items: start; gap: 16px; }
.settings-stack { display: grid; align-content: start; gap: 14px; min-width: 0; }
.lobby-card { padding: 18px; border: 1px solid rgba(130, 167, 204, .25); border-radius: 18px; background: rgba(8, 21, 34, .67); }
.section-title { justify-content: space-between; gap: 12px; margin-bottom: 14px; }.section-title h3 { margin: 0; color: #eaf4ff; font-size: 16px; }.section-title span { color: #7892ad; font-size: 11px; }
.member-list { display: grid; gap: 8px; }.member-row { position: relative; display: grid; grid-template-columns: minmax(145px, 1fr) minmax(126px, .7fr) minmax(72px, .42fr) 70px; gap: 10px; padding: 10px 12px; border: 1px solid rgba(108, 145, 182, .22); border-radius: 12px; background: rgba(22, 43, 63, .62); }.member-row:focus-within { z-index: 4; }.member-row.disconnected { opacity: .55; }
.member-name { gap: 9px; min-width: 0; }.member-name strong, .member-name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.member-name strong { color: #f4f8fc; }.member-name small { color: #8fa7bf; font-size: 11px; }.presence { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #4ade80; box-shadow: 0 0 10px rgba(74, 222, 128, .6); }.disconnected .presence { background: #64748b; box-shadow: none; }
.member-name .missing-mod-note { margin-top: 3px; color: #fbbf94; }
.member-missing-mods{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;margin-top:4px}.member-missing-mods .missing-mod-note{margin:0}.install-missing-mod{width:auto;min-height:22px;margin:0;padding:2px 7px;border:1px solid rgba(248,177,127,.28);border-radius:6px;color:#ffd2ad;background:rgba(144,75,47,.22);font-size:9px}.dependency-scope-note{margin:9px 0 0;color:#829caf;font-size:9px;line-height:1.45}
.member-version-mismatch{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;margin-top:4px}.version-mismatch-note,.peer-mod-status{color:#ffba89;font-size:9px}.quick-update-mod{width:auto;min-height:22px;margin:0;padding:2px 7px;border:1px solid rgba(255,186,137,.35);border-radius:6px;color:#ffe0c6;background:rgba(130,70,43,.28);font-size:9px}.quick-update-mod:disabled{opacity:.6}.mod-update-message{margin:9px 0 0;padding:8px 10px;border:1px solid rgba(111,210,194,.28);border-radius:8px;color:#a9e9d8;background:rgba(35,106,98,.15);font-size:10px;line-height:1.5}
.seat-select { width: 100%; border: 1px solid rgba(129, 168, 207, .35); border-radius: 9px; background: #0d2032; color: #eaf4ff; outline: none; }.seat-select { padding: 7px 9px; }.seat-readonly { color: #bfd0e2; font-size: 12px; }.ready-state { color: #8fa5ba; font-size: 11px; text-align: right; }.ready-state.ready { color: #86efac; font-weight: 800; }
.color-picker { position: relative; display: flex; min-width: 0; align-items: center; justify-content: center; }.color-preview-button { display: grid; width: 52px; height: 42px; place-items: center; margin: 0; padding: 2px; border: 1px solid transparent; border-radius: 9px; background: transparent; cursor: pointer; }.color-preview-button:hover, .color-preview-button:focus-visible { border-color: rgba(131,233,216,.55); background: rgba(7,21,33,.55); outline: none; }.color-preview-button img { display: block; width: 44px; height: 38px; object-fit: contain; }.color-picker-menu { position: absolute; z-index: 10; top: calc(100% + 5px); left: 0; display: grid; min-width: 164px; grid-template-columns: repeat(3, 1fr); gap: 5px; padding: 8px; border: 1px solid rgba(131,181,207,.4); border-radius: 11px; background: #091827; box-shadow: 0 12px 28px rgba(0,0,0,.48); }.color-picker-menu button { display: grid; width: 43px; height: 39px; place-items: center; margin: 0; padding: 2px; border: 1px solid transparent; border-radius: 7px; background: transparent; cursor: pointer; }.color-picker-menu button:hover, .color-picker-menu button:focus-visible, .color-picker-menu button[aria-selected="true"] { border-color: rgba(131,233,216,.72); background: rgba(57,119,130,.3); outline: none; }.color-picker-menu img { display: block; width: 36px; height: 32px; object-fit: contain; }.color-readonly { display: flex; min-width: 0; align-items: center; justify-content: center; }.color-readonly img { display: block; width: 42px; height: 36px; object-fit: contain; }.spectator-color { color: #6f8499; }
.ready-button { width: 100%; margin-top: 14px; padding: 12px; border: 0; border-radius: 11px; background: linear-gradient(90deg, #5eead4, #60a5fa); color: #071626; font-weight: 900; cursor: pointer; }.ready-button.active { background: #223b52; color: #c5d6e7; }.spectator-note, .settings-hint { margin: 13px 0 0; color: #7f98b1; font-size: 11px; line-height: 1.55; }
.ready-button:disabled { cursor: not-allowed; background: #344a5e; color: #c3d0dd; }
.dependency-warning { margin: 10px 0 0; padding: 9px 11px; border: 1px solid rgba(251, 191, 146, .4); border-radius: 9px; color: #ffd8ba; background: rgba(109, 60, 39, .24); font-size: 11px; line-height: 1.5; }
.toggle-row { justify-content: space-between; gap: 16px; padding: 11px 0; border-bottom: 1px solid rgba(122, 157, 191, .16); }.toggle-row strong, .toggle-row small { display: block; }.toggle-row strong { color: #dce9f7; font-size: 13px; }.toggle-row small { margin-top: 2px; color: #8299b0; font-size: 10px; }.toggle-row input { width: 18px; height: 18px; accent-color: #67e8f9; }
.number-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-top: 14px; }.number-field { min-width: 0; }.number-field label, .number-field small { display: block; }.number-field label { margin-bottom: 5px; color: #aabed2; font-size: 11px; }.number-field small { margin-top: 4px; color: #647c94; font-size: 9px; }
.map-setting { display: grid; gap: 10px; padding: 14px; border: 1px solid rgba(103, 232, 249, .22); border-radius: 14px; background: rgba(32, 72, 88, .27); }
.map-setting strong, .map-setting small { display: block; }
.map-setting strong { color: #f1fbff; font-size: 14px; }
.map-setting small { margin-top: 3px; color: #a1b9c9; font-size: 11px; line-height: 1.5; }
.map-select, .map-selected-name { box-sizing: border-box; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid rgba(129, 201, 223, .43); border-radius: 10px; background: #102b3d; color: #eefaff; font: inherit; font-size: 13px; }
.map-select { cursor: pointer; }
.map-select:focus-visible, .seat-select:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
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
.mod-setting-controls .number-stepper, .mod-setting-controls select { box-sizing: border-box; width: 100%; min-height: 37px; }
.mod-setting-controls input[type="checkbox"] { width: 18px; height: 18px; accent-color: #67e8f9; }
.mod-setting-controls input:disabled, .mod-setting-controls select:disabled { opacity: .72; }
.reset-mod-setting { padding: 3px 0; border: 0; background: transparent; color: #8de4ed; font-size: 10px; cursor: pointer; }
.mod-setting-source { grid-column: 1 / -1; color: #7995aa; font-size: 10px; }
@media (max-width: 800px) { .lobby-shell { padding: 15px; }.lobby-header { display: grid; }.lobby-header-side { width: 100%; grid-template-columns: minmax(0, 1fr) 130px; align-items: stretch; }.map-preview-board { height: clamp(250px, 70vw, 340px); }.lobby-grid { grid-template-columns: 1fr; }.member-row { grid-template-columns: minmax(115px, 1fr) minmax(105px, .7fr) minmax(58px, .32fr) 58px; }.number-grid { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .lobby-header-side { grid-template-columns: 1fr; }.map-preview-card { padding: 7px; }.map-preview-board { height: clamp(280px, 100vw, 380px); }.member-row { grid-template-columns: minmax(0, 1fr) 118px; }.color-picker, .color-readonly { grid-column: 1; justify-content: flex-start; padding-left: 5px; }.ready-state { grid-column: 2; grid-row: 2; text-align: right; }.color-picker-menu { left: 0; }.mod-setting-row { grid-template-columns: minmax(0, 1fr) 105px; } }

/* The preparation room uses a clear work area with persistent map context. */
.lobby-shell { display: flex; min-height: min(760px, calc(100dvh - 110px)); flex-direction: column; gap: 18px; padding: clamp(16px, 2vw, 28px); }
.lobby-header { align-items: center; margin: 0; }
.lobby-header > div:first-child { min-width: 0; flex: 1 1 auto; }
.lobby-header h2 { font-size: clamp(25px, 2.7vw, 36px); letter-spacing: -.025em; }
.lobby-header > div:first-child > p:last-of-type { max-width: 720px; line-height: 1.55; }
.lobby-layout { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(0, 1fr) minmax(290px, clamp(300px, 31vw, 420px)); align-items: start; gap: clamp(14px, 2vw, 24px); }
.lobby-main { display: grid; min-width: 0; align-content: start; gap: 12px; }
.lobby-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 7px; border: 1px solid rgba(130, 167, 204, .22); border-radius: 15px; background: rgba(5, 16, 27, .52); }
.lobby-tabs button { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 3px 9px; padding: 10px 12px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: #a6bbce; text-align: left; cursor: pointer; transition: background .16s ease, border-color .16s ease, color .16s ease; }
.lobby-tabs button:hover { background: rgba(40, 76, 99, .32); color: #e7f6ff; }
.lobby-tabs button.active { border-color: rgba(103, 232, 249, .38); background: linear-gradient(110deg, rgba(37, 106, 110, .34), rgba(34, 74, 111, .35)); color: #f1fcff; box-shadow: inset 0 -2px #64d9d0; }
.tab-index { grid-row: 1 / span 2; color: #55d7ca; font: 800 10px/1 ui-monospace, monospace; letter-spacing: .06em; }
.lobby-tabs button > span:nth-child(2) { overflow: hidden; font-size: 13px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
.lobby-tabs button small { grid-column: 2 / -1; overflow: hidden; color: #829bb2; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.lobby-tabs button.active small { color: #9bd9dc; }
.tab-page { min-height: 390px; padding: clamp(15px, 2vw, 22px); animation: lobby-tab-enter .18s ease-out; }
@keyframes lobby-tab-enter { from { opacity: .55; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.section-title { margin-bottom: 15px; }
.section-title h3 { font-size: 18px; }
.section-title .section-subtitle { display: block; margin-top: 5px; color: #8299b0; font-size: 10px; }
.member-card .section-title { align-items: center; margin-bottom: 18px; }
.member-card .section-title h3 { letter-spacing: -.025em; }
.member-card .section-title > span { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border: 1px solid rgba(100, 184, 167, .2); border-radius: 999px; color: #a8d6cb; background: rgba(30, 82, 75, .18); font-size: 10px; font-weight: 650; letter-spacing: .02em; }
.member-card .section-title > span::before { width: 6px; height: 6px; border-radius: 50%; background: #68d6a7; box-shadow: 0 0 9px rgba(104, 214, 167, .55); content: ""; }
.member-list { grid-template-columns: minmax(0, 1fr); align-items: stretch; gap: 9px; }
.member-card { display: flex; flex-direction: column; }
.member-row { grid-template-columns: minmax(0, 1fr) minmax(128px, .38fr) 44px 12px; grid-template-areas: "identity seat color status"; align-items: center; gap: 10px 14px; min-width: 0; min-height: 76px; padding: 13px 16px; border-color: rgba(111, 157, 195, .22); border-radius: 15px; background: linear-gradient(110deg, rgba(22, 43, 61, .92), rgba(13, 29, 44, .92)); box-shadow: inset 0 1px rgba(255,255,255,.025), 0 6px 18px rgba(0,0,0,.08); isolation: isolate; transition: border-color .18s ease, background .18s ease, box-shadow .18s ease, transform .18s ease; }
.member-row::before { position: absolute; z-index: -1; top: 13px; bottom: 13px; left: 0; width: 2px; border-radius: 0 2px 2px 0; background: #71869a; content: ""; opacity: .55; }
.member-row::after { position: absolute; top: 0; right: 16px; left: 16px; height: 1px; background: linear-gradient(90deg, transparent, rgba(210, 235, 245, .12), transparent); content: ""; pointer-events: none; }
.member-row.member-self::before { background: #65d6c8; box-shadow: 0 0 11px rgba(101, 214, 200, .42); opacity: 1; }
.member-row.member-ready::before { background: #72d69a; box-shadow: 0 0 11px rgba(114, 214, 154, .36); opacity: 1; }
.member-row:hover { transform: translateY(-1px); border-color: rgba(122, 184, 205, .38); background: linear-gradient(110deg, rgba(25, 50, 68, .96), rgba(14, 33, 49, .96)); box-shadow: inset 0 1px rgba(255,255,255,.035), 0 10px 24px rgba(0,0,0,.16); }
.member-row:focus-within { border-color: rgba(103, 210, 205, .5); box-shadow: 0 0 0 3px rgba(79, 190, 184, .08), 0 10px 24px rgba(0,0,0,.16); }
.member-name { grid-area: identity; gap: 11px; }
.member-name strong { font-size: 13px; font-weight: 750; letter-spacing: -.01em; }
.member-name small { margin-top: 2px; color: #8fa9bd; }
.presence { width: 8px; height: 8px; margin: 0 1px; box-shadow: 0 0 0 4px rgba(74, 222, 128, .08), 0 0 11px rgba(74, 222, 128, .48); }
.disconnected .presence { box-shadow: 0 0 0 4px rgba(100, 116, 139, .08); }
.seat-picker { position: relative; z-index: 1; grid-area: seat; min-width: 0; }
.seat-select { display: flex; width: 100%; min-height: 40px; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid rgba(121, 160, 184, .25); border-radius: 11px; color: #e5f2f9; background: linear-gradient(145deg, rgba(14, 33, 49, .96), rgba(8, 22, 35, .96)); font: inherit; font-size: 12px; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.seat-select:hover, .seat-select[aria-expanded="true"] { border-color: rgba(113, 198, 192, .52); background: linear-gradient(145deg, rgba(19, 47, 61, .98), rgba(10, 29, 42, .98)); }
.seat-select:focus-visible { outline: 2px solid rgba(103, 232, 249, .78); outline-offset: 2px; }
.seat-select > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seat-select-chevron { width: 7px; height: 7px; flex: 0 0 auto; margin: -4px 2px 0 0; transform: rotate(45deg); border-right: 1.5px solid #9ab6c8; border-bottom: 1.5px solid #9ab6c8; transition: transform .16s ease, margin .16s ease; }
.seat-select[aria-expanded="true"] .seat-select-chevron { margin-top: 4px; transform: rotate(225deg); }
.seat-picker-menu { position: absolute; z-index: 12; top: calc(100% + 6px); left: 0; display: grid; width: max(100%, 168px); gap: 3px; padding: 5px; border: 1px solid rgba(105, 163, 183, .34); border-radius: 12px; background: linear-gradient(155deg, #132b3e, #0a1b2a); box-shadow: 0 14px 32px rgba(0, 0, 0, .42), inset 0 1px rgba(255,255,255,.04); animation: seat-menu-enter .12s ease-out; }
.seat-option { display: flex; width: 100%; min-height: 34px; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 9px; border: 1px solid transparent; border-radius: 8px; color: #c2d4e0; background: transparent; font: inherit; font-size: 11px; text-align: left; cursor: pointer; transition: border-color .14s ease, color .14s ease, background .14s ease; }
.seat-option:hover:not(:disabled), .seat-option:focus-visible { border-color: rgba(103, 204, 197, .18); color: #effffc; background: rgba(44, 112, 112, .22); outline: none; }
.seat-option.selected { border-color: rgba(103, 204, 197, .2); color: #a8f0e2; background: rgba(41, 112, 108, .2); }
.seat-option:disabled { color: #5d7486; cursor: not-allowed; }
.seat-option-mark { min-width: 20px; color: #71d9ca; font-size: 10px; text-align: right; }
.seat-option:disabled .seat-option-mark { color: #5d7486; font-size: 9px; }
.seat-readonly { grid-area: seat; color: #bfd0df; font-size: 11px; }
@keyframes seat-menu-enter { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
.color-picker, .color-readonly { grid-area: color; justify-self: end; }
.color-preview-button { width: 42px; height: 42px; border: 1px solid rgba(121, 160, 184, .18); border-radius: 12px; background: rgba(5, 17, 28, .34); transition: border-color .16s ease, background .16s ease, transform .16s ease; }
.color-preview-button:hover, .color-preview-button:focus-visible { transform: translateY(-1px); border-color: rgba(111, 212, 196, .6); background: rgba(15, 42, 54, .72); }
.color-preview-button img { width: 34px; height: 34px; }
.color-readonly img { width: 34px; height: 34px; }
.ready-state { grid-area: status; justify-self: center; display: grid; width: 12px; height: 12px; place-items: center; }
.ready-state::before { width: 8px; height: 8px; border: 1px solid #93a8b7; border-radius: 50%; background: rgba(147, 168, 183, .2); content: ""; }
.ready-state.ready::before { border-color: #69d99a; background: #69d99a; box-shadow: 0 0 8px rgba(105, 217, 154, .52); }
.ready-state.warning::before { border-color: #f0b176; background: #f0b176; box-shadow: 0 0 7px rgba(240, 177, 118, .3); }
.ready-state.offline::before { border-color: #667b8e; background: #667b8e; box-shadow: none; }
.ready-state.spectator::before { border-color: #73bdda; background: #73bdda; box-shadow: none; }
.open-seat-card { display: flex; min-width: 0; min-height: 72px; align-items: center; gap: 13px; padding: 11px 15px; border: 1px solid rgba(104, 151, 177, .2); border-radius: 15px; background: radial-gradient(ellipse at 0 50%, rgba(37, 90, 94, .12), transparent 52%), rgba(12, 29, 44, .42); }
.open-seat-icon { display: grid; width: 38px; height: 38px; flex: 0 0 auto; place-items: center; border: 1px solid rgba(103, 232, 249, .22); border-radius: 12px; color: #74d8cf; background: linear-gradient(145deg, rgba(47, 121, 119, .22), rgba(20, 55, 69, .2)); font-size: 22px; font-weight: 300; box-shadow: inset 0 1px rgba(255,255,255,.045); }
.open-seat-card strong, .open-seat-card small { display: block; }
.open-seat-card strong { color: #d4e3ed; font-size: 12px; font-weight: 700; }
.open-seat-card small { margin-top: 4px; color: #8099ad; font-size: 10px; }
.open-seat-state { margin-left: auto; padding: 5px 9px; border: 1px solid rgba(93, 191, 177, .16); border-radius: 999px; color: #84dace; background: rgba(37, 101, 97, .14); font-size: 9px; font-weight: 650; white-space: nowrap; }
.member-card .ready-button { margin-top: 16px; }
.member-actions { display: flex; justify-content: flex-end; margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(111, 157, 195, .16); }
.member-card .member-prepare-button { display: inline-flex; width: auto; min-width: 110px; min-height: 40px; align-items: center; justify-content: center; gap: 8px; margin: 0; padding: 8px 14px; border: 1px solid rgba(129, 235, 219, .35); border-radius: 11px; background: linear-gradient(145deg, #6ce0c8, #4bc9c3); box-shadow: 0 5px 14px rgba(61, 194, 181, .14), inset 0 1px rgba(255,255,255,.3); color: #082128; font-size: 11px; font-weight: 800; transition: transform .16s ease, filter .16s ease, box-shadow .16s ease; }
.member-card .member-prepare-button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 8px 18px rgba(61, 194, 181, .2), inset 0 1px rgba(255,255,255,.34); }
.member-card .member-prepare-button.active { border-color: rgba(138, 166, 185, .2); background: linear-gradient(145deg, #233c4e, #1a3041); box-shadow: inset 0 1px rgba(255,255,255,.045); color: #c7d8e3; }
.member-card .member-prepare-button:disabled { opacity: .54; box-shadow: none; }
.ready-button-icon { font-size: 14px; line-height: 1; }
.lobby-aside { position: sticky; top: 12px; display: grid; min-width: 0; gap: 10px; }
.lobby-aside .map-preview-card { padding: 0; }
.lobby-aside .map-preview-board { height: clamp(285px, 40vh, 430px); }
.header-copy-invite { display: inline-flex; width: auto; min-height: 36px; flex: 0 0 auto; align-items: center; justify-content: center; gap: 7px; margin: 0 0 0 auto; padding: 7px 11px; border: 1px solid rgba(103, 232, 249, .27); border-radius: 9px; color: #a7f3ed; background: rgba(15, 57, 68, .45); font: inherit; font-size: 10px; font-weight: 700; white-space: nowrap; cursor: pointer; transition: border-color .16s ease, background .16s ease, transform .16s ease; }
.header-copy-invite:hover { transform: translateY(-1px); border-color: rgba(103, 232, 249, .5); background: rgba(19, 73, 81, .58); }
.header-copy-invite:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
.aside-tip { margin: 0; padding: 0 4px; color: #7891a9; font-size: 10px; line-height: 1.5; }
.settings-card, .mod-settings-card { display: grid; align-content: start; gap: 10px; }
.settings-card .section-title, .mod-settings-card .section-title { margin-bottom: 2px; }
.settings-card .map-setting { grid-template-columns: minmax(180px, .65fr) minmax(240px, 1fr); align-items: center; }
.settings-card .map-setting label { align-self: center; }
.settings-card .toggle-row { padding: 15px 4px; }
.settings-card .number-grid { margin-top: 2px; }
.settings-card .settings-hint, .mod-settings-card .settings-hint { margin-top: 4px; }
.mod-settings-card { grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }
.mod-settings-card > .section-title, .mod-settings-card > .mod-empty, .mod-settings-card > .settings-hint { grid-column: 1 / -1; }
.mod-settings-card .mod-group { align-self: start; min-width: 0; }

@media (max-width: 900px) {
  .lobby-shell { min-height: 0; }
  .lobby-layout { grid-template-columns: minmax(0, 1fr); }
  .lobby-aside { position: static; grid-template-columns: minmax(0, 1.3fr) minmax(150px, .7fr); align-items: start; }
  .lobby-aside .map-preview-card { grid-row: span 3; }
  .lobby-aside .map-preview-board { height: clamp(230px, 40vw, 340px); }
  .settings-card .map-setting { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .lobby-shell { gap: 12px; padding: 12px; border-radius: 16px; }
  .lobby-header { display: block; margin-bottom: 0; }
  .lobby-header .kicker, .lobby-header > div:first-child > p:not(.lobby-error) { display: none; }
  .lobby-header h2 { font-size: 20px; }
  .header-copy-invite { margin-top: 8px; }
  .lobby-tabs { gap: 4px; padding: 5px; border-radius: 12px; }
  .lobby-tabs button { display: flex; justify-content: center; padding: 8px 4px; }
  .lobby-tabs .tab-index, .lobby-tabs button small { display: none; }
  .lobby-tabs button > span:nth-child(2) { font-size: 10px; }
  .tab-page { min-height: 0; padding: 12px; }
  .section-title { margin-bottom: 9px; }
  .section-title h3 { font-size: 14px; }
  .section-title > span, .section-title .section-subtitle { display: none; }
  .member-list { grid-template-columns: 1fr; }
  .member-row { grid-template-columns: minmax(0, 1fr) 52px 30px 12px; grid-template-areas: "identity seat color status"; gap: 4px; min-height: 48px; padding: 6px 8px; }
  .member-name { gap: 6px; }
  .member-name > div { min-width: 0; }
  .member-name strong { font-size: 11px; }
  .member-name small { display: none; }
  .seat-select, .seat-readonly { min-width: 0; overflow: hidden; padding: 4px 1px; font-size: 9px; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  .seat-select { min-height: 30px; gap: 5px; padding: 4px 5px; text-align: left; }
  .color-preview-button { width: 30px; height: 30px; }
  .color-preview-button img, .color-readonly img { width: 27px; height: 27px; }
  .color-picker, .color-readonly { justify-self: center; }
  .color-readonly { width: 30px; height: 30px; border-radius: 9px; }
  .member-actions { padding-top: 10px; }
  .member-card .member-prepare-button { width: 100%; min-width: 0; }
  .open-seat-card { min-height: 48px; gap: 8px; padding: 6px 8px; }
  .open-seat-icon { width: 29px; height: 29px; border-radius: 8px; font-size: 18px; }
  .open-seat-card strong { font-size: 10px; }
  .open-seat-card small { display: none; }
  .open-seat-state { padding: 3px 6px; font-size: 8px; }
  .dependency-scope-note, .aside-tip { display: none; }
  .lobby-layout { display: flex; flex-direction: column; gap: 9px; }
  .lobby-main { order: 2; width: 100%; gap: 8px; }
  .lobby-aside { display: contents; }
  .lobby-aside .map-preview-card { grid-row: auto; width: 100%; }
  .map-preview-picker { gap: 6px; margin: 0 0 8px; padding: 0; }
  .map-preview-picker-heading strong { font-size: 10px; }
  .map-preview-picker-heading small { font-size: 8px; }
  .map-picker-options { max-height: min(52vh, 340px); }
  .map-picker-option { min-height: 66px; grid-template-columns: minmax(64px, 28%) minmax(0, 1fr) 15px; gap: 7px; padding: 5px; }
  .map-picker-option-preview { height: 54px; }
  .map-picker-option-copy strong { font-size: 10px; }
  .lobby-aside .map-preview-board { height: clamp(175px, 58vw, 245px); margin: 0 8px 8px; }
  .settings-card .map-setting { grid-template-columns: 1fr; }
  .settings-card .number-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mod-settings-card { grid-template-columns: 1fr; }
  .mod-settings-card > .section-title, .mod-settings-card > .mod-empty, .mod-settings-card > .settings-hint { grid-column: 1; }
}

@media (orientation: portrait) {
  .map-preview-stage:not(.is-modal) { display: none; }
  .map-preview-open { display: inline-flex; width: 100%; min-height: 38px; align-items: center; justify-content: center; gap: 7px; margin: 0 0 10px; padding: 7px 10px; border: 1px solid rgba(103, 232, 249, .25); border-radius: 9px; color: #a7f3ed; background: rgba(15, 57, 68, .32); font: inherit; font-size: 10px; font-weight: 700; cursor: pointer; }
  .map-preview-open:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
}

@media (orientation: landscape) and (min-width: 601px) and (max-width: 900px) {
  .lobby-header { display: flex; }
  .lobby-layout { grid-template-columns: minmax(0, 1.25fr) minmax(270px, .75fr); }
  .lobby-aside { position: sticky; grid-template-columns: minmax(0, 1fr); }
  .lobby-aside .map-preview-card { grid-row: auto; }
  .lobby-aside .map-preview-board { height: clamp(190px, 55dvh, 340px); }
}

@media (orientation: landscape) and (min-width: 480px) and (max-width: 600px) {
  .lobby-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(205px, .9fr); align-items: start; gap: 10px; }
  .lobby-main { order: initial; width: auto; }
  .lobby-aside { position: static; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .lobby-aside .map-preview-card { grid-row: auto; }
  .lobby-aside .map-preview-board { height: clamp(145px, 48dvh, 230px); margin: 0; }
}
</style>
