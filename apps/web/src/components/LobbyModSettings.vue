<script setup lang="ts">
import { computed } from "vue";
import type { LobbyModSettings, LobbyRoomState } from "@numeral-lord/game-core";
import { loadedTerrainMods } from "../content/installed-content";
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
  amHost: boolean;
  mapModSettings: LobbyModSettings | undefined;
}>();

const emit = defineEmits<{
  "mod-settings": [settings: LobbyModSettings];
}>();

const requiredMods = computed(() => props.room.requiredTerrainModIds.map((id) => ({
  id,
  definition: (loadedTerrainMods as readonly InstalledMod[]).find((mod) => mod.id === id)
})));

function modDisplayName(mod: InstalledMod | undefined, id: string): string {
  return mod?.terrain?.displayName || id;
}

function hasRoomOverride(modId: string, settingId: string): boolean {
  return Object.prototype.hasOwnProperty.call(props.room.roomModSettings[modId] ?? {}, settingId);
}

function settingValue(modId: string, setting: ModSetting): number | boolean | string {
  return props.room.roomModSettings[modId]?.[setting.id]
    ?? props.mapModSettings?.[modId]?.[setting.id]
    ?? setting.defaultValue;
}

function settingSource(modId: string, setting: ModSetting): string {
  if (hasRoomOverride(modId, setting.id)) return "房主设置";
  if (Object.prototype.hasOwnProperty.call(props.mapModSettings?.[modId] ?? {}, setting.id)) return "地图作者默认";
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
  <section class="lobby-card mod-settings-card tab-page" role="tabpanel" aria-labelledby="lobby-tab-mods">
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
</template>

<style scoped>
.section-title { display: flex; align-items: center; }
.lobby-card { padding: 18px; border: 1px solid rgba(130, 167, 204, .25); border-radius: 18px; background: rgba(8, 21, 34, .67); }
.section-title { justify-content: space-between; gap: 12px; margin-bottom: 14px; }.section-title h3 { margin: 0; color: #eaf4ff; font-size: 16px; }.section-title span { color: #7892ad; font-size: 11px; }.settings-hint { margin: 13px 0 0; color: #7f98b1; font-size: 11px; line-height: 1.55; }
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
.mod-setting-controls .number-stepper { box-sizing: border-box; width: 100%; min-height: 37px; }
.mod-setting-controls select { box-sizing: border-box; width: 100%; min-height: 37px; }
.mod-setting-controls input[type="checkbox"] { width: 18px; height: 18px; accent-color: #67e8f9; }
.mod-setting-controls input:disabled, .mod-setting-controls select:disabled { opacity: .72; }
.reset-mod-setting { padding: 3px 0; border: 0; background: transparent; color: #8de4ed; font-size: 10px; cursor: pointer; }
.mod-setting-source { grid-column: 1 / -1; color: #7995aa; font-size: 10px; }
@media (max-width: 520px) {.mod-setting-row { grid-template-columns: minmax(0, 1fr) 105px; } }

/* The preparation room uses a clear work area with persistent map context. */
.tab-page { min-height: 390px; padding: clamp(15px, 2vw, 22px); animation: lobby-tab-enter .18s ease-out; }
@keyframes lobby-tab-enter { from { opacity: .55; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.section-title { margin-bottom: 15px; }
.section-title h3 { font-size: 18px; }
.mod-settings-card { display: grid; align-content: start; gap: 10px; }
.mod-settings-card .section-title { margin-bottom: 2px; }
.mod-settings-card .settings-hint { margin-top: 4px; }
.mod-settings-card { grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }
.mod-settings-card > .section-title, .mod-settings-card > .mod-empty, .mod-settings-card > .settings-hint { grid-column: 1 / -1; }
.mod-settings-card .mod-group { align-self: start; min-width: 0; }
@media (max-width: 600px) {
  .tab-page { min-height: 0; padding: 12px; }
  .section-title { margin-bottom: 9px; }
  .section-title h3 { font-size: 14px; }
  .section-title > span { display: none; }
  .mod-settings-card { grid-template-columns: 1fr; }
  .mod-settings-card > .section-title, .mod-settings-card > .mod-empty, .mod-settings-card > .settings-hint { grid-column: 1; }
}
</style>
