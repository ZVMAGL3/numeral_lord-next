<script setup lang="ts">
import { computed } from "vue";
import type { LobbyRoomState } from "@numeral-lord/game-core";
import { missingTerrainMods, type ConfiguredMap } from "../maps/map-library";
import NumberStepper from "./NumberStepper.vue";

const props = defineProps<{
  room: LobbyRoomState;
  amHost: boolean;
  mapOptions: readonly ConfiguredMap[];
  selectedMapIndex: number;
}>();

const emit = defineEmits<{
  settings: [settings: Record<string, boolean | number>];
  map: [mapCode: string];
}>();

const maximumTurnSeconds = computed(() => props.room.settings.matchTimeMinutes === 0
  ? 300
  : Math.min(300, props.room.settings.matchTimeMinutes * 60));

function onMapSelect(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const index = Number(select.value);
  const map = props.mapOptions[index];
  if (map && missingTerrainMods(map).length === 0 && map.code !== props.room.mapCode) emit("map", map.code);
  // Server acknowledgement owns the committed value. A rejected map choice
  // must not appear selected merely because the native select changed.
  select.value = String(props.selectedMapIndex);
}

function emitNumberSetting(key: "turnTimeSeconds" | "matchTimeMinutes", value: number): void {
  emit("settings", { [key]: value });
}

function emitBooleanSetting(key: "friendlyFire" | "randomizePositions", event: Event): void {
  emit("settings", { [key]: (event.target as HTMLInputElement).checked });
}

</script>

<template>
  <section class="lobby-card settings-card tab-page" role="tabpanel" aria-labelledby="lobby-tab-settings">
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
</template>

<style scoped>
.section-title, .toggle-row { display: flex; align-items: center; }
.lobby-card { padding: 18px; border: 1px solid rgba(130, 167, 204, .25); border-radius: 18px; background: rgba(8, 21, 34, .67); }
.section-title { justify-content: space-between; gap: 12px; margin-bottom: 14px; }.section-title h3 { margin: 0; color: #eaf4ff; font-size: 16px; }.section-title span { color: #7892ad; font-size: 11px; }.settings-hint { margin: 13px 0 0; color: #7f98b1; font-size: 11px; line-height: 1.55; }
.toggle-row { justify-content: space-between; gap: 16px; padding: 11px 0; border-bottom: 1px solid rgba(122, 157, 191, .16); }.toggle-row strong, .toggle-row small { display: block; }.toggle-row strong { color: #dce9f7; font-size: 13px; }.toggle-row small { margin-top: 2px; color: #8299b0; font-size: 10px; }.toggle-row input { width: 18px; height: 18px; accent-color: #67e8f9; }
.number-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-top: 14px; }.number-field { min-width: 0; }.number-field label, .number-field small { display: block; }.number-field label { margin-bottom: 5px; color: #aabed2; font-size: 11px; }.number-field small { margin-top: 4px; color: #647c94; font-size: 9px; }
.map-setting { display: grid; gap: 10px; padding: 14px; border: 1px solid rgba(103, 232, 249, .22); border-radius: 14px; background: rgba(32, 72, 88, .27); }
.map-setting strong, .map-setting small { display: block; }
.map-setting strong { color: #f1fbff; font-size: 14px; }
.map-setting small { margin-top: 3px; color: #a1b9c9; font-size: 11px; line-height: 1.5; }
.map-select, .map-selected-name { box-sizing: border-box; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid rgba(129, 201, 223, .43); border-radius: 10px; background: #102b3d; color: #eefaff; font: inherit; font-size: 13px; }
.map-select { cursor: pointer; }
.map-select:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
.map-selected-name { display: flex; align-items: center; color: #a8eaf5; }
@media (max-width: 800px) {.number-grid { grid-template-columns: 1fr; } }

/* The preparation room uses a clear work area with persistent map context. */
.tab-page { min-height: 390px; padding: clamp(15px, 2vw, 22px); animation: lobby-tab-enter .18s ease-out; }
@keyframes lobby-tab-enter { from { opacity: .55; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.section-title { margin-bottom: 15px; }
.section-title h3 { font-size: 18px; }
.settings-card { display: grid; align-content: start; gap: 10px; }
.settings-card .section-title { margin-bottom: 2px; }
.settings-card .map-setting { grid-template-columns: minmax(180px, .65fr) minmax(240px, 1fr); align-items: center; }
.settings-card .map-setting label { align-self: center; }
.settings-card .toggle-row { padding: 15px 4px; }
.settings-card .number-grid { margin-top: 2px; }
.settings-card .settings-hint { margin-top: 4px; }

@media (max-width: 900px) {
  .settings-card .map-setting { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .tab-page { min-height: 0; padding: 12px; }
  .section-title { margin-bottom: 9px; }
  .section-title h3 { font-size: 14px; }
  .section-title > span { display: none; }
  .settings-card .map-setting { grid-template-columns: 1fr; }
  .settings-card .number-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
