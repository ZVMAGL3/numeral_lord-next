<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import MapTerrainIcon from "./MapTerrainIcon.vue";

export interface MapEditorTerrainOption {
  id: string;
  name: string;
  color: string;
  modId?: string;
}

const props = defineProps<{
  mode: "terrain" | "unit" | "erase";
  terrainOptions: MapEditorTerrainOption[];
  selectedTerrain: string;
  unitPreset: string;
  playerCount: number;
  strength: number;
  fillRadius: number;
}>();
const emit = defineEmits<{
  "update:mode": [value: "terrain" | "unit" | "erase"];
  "update:selectedTerrain": [value: string];
  "update:unitPreset": [value: string];
  "update:strength": [value: number];
  "update:fillRadius": [value: number];
}>();

const terrain = computed(() => props.terrainOptions.find((entry) => entry.id === props.selectedTerrain));
const terrainPickerOpen = ref(false);
const toolbarRoot = ref<HTMLDivElement | null>(null);
const unitLabel = computed(() => props.unitPreset.startsWith("player:")
  ? `玩家 ${props.unitPreset.slice("player:".length)}`
  : props.unitPreset === "wild" ? "野怪" : "阻挡");
function changeMode(event: Event): void {
  terrainPickerOpen.value = false;
  emit("update:mode", (event.target as HTMLSelectElement).value as "terrain" | "unit");
}
function changeStrength(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  emit("update:strength", Math.max(1, Math.min(65535, Math.trunc(value || 1))));
}
function selectTerrain(id: string): void {
  emit("update:selectedTerrain", id);
  terrainPickerOpen.value = false;
}
function closeTerrainPicker(event: PointerEvent): void {
  if (!toolbarRoot.value?.contains(event.target as Node)) terrainPickerOpen.value = false;
}
function onToolbarKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") terrainPickerOpen.value = false;
}
onMounted(() => {
  document.addEventListener("pointerdown", closeTerrainPicker);
  document.addEventListener("keydown", onToolbarKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeTerrainPicker);
  document.removeEventListener("keydown", onToolbarKeydown);
});
</script>

<template>
  <div ref="toolbarRoot" class="map-editor-toolbar" aria-label="地图绘制工具">
    <label class="mode-control" aria-label="绘制类型">
      <select :value="mode === 'terrain' ? 'terrain' : 'unit'" @change="changeMode">
        <option value="terrain">地形</option>
        <option value="unit">单位</option>
      </select>
    </label>

    <div v-if="mode === 'terrain'" class="terrain-picker">
      <button class="terrain-trigger" aria-label="选择地形" aria-haspopup="listbox" :aria-expanded="terrainPickerOpen" @click="terrainPickerOpen = !terrainPickerOpen">
        <MapTerrainIcon :terrain-id="terrain?.id ?? 'core/plain'" :color="terrain?.color ?? '#63985d'" :size="20" />
        <span class="terrain-name">{{ terrain?.name ?? '平原' }}</span><span class="picker-chevron">⌃</span>
      </button>
      <div v-if="terrainPickerOpen" class="terrain-options" role="listbox" aria-label="地形选项">
        <button v-for="option in terrainOptions" :key="option.id" role="option" :aria-selected="selectedTerrain === option.id" @click="selectTerrain(option.id)">
          <MapTerrainIcon :terrain-id="option.id" :color="option.color" :size="25" />
          <span class="terrain-option-name">{{ option.name }}</span><small v-if="option.modId">Mod</small>
        </button>
      </div>
    </div>

    <template v-else>
      <label v-if="mode === 'unit'" class="choice-control unit-control" aria-label="选择单位">
        <select :value="unitPreset" @change="emit('update:unitPreset', ($event.target as HTMLSelectElement).value)">
          <optgroup label="玩家单位">
            <option v-for="seat in playerCount" :key="seat" :value="`player:${seat}`">玩家 {{ seat }}</option>
          </optgroup>
          <optgroup label="特殊单位">
            <option value="wild">野怪</option>
            <option value="blocker">阻挡</option>
          </optgroup>
        </select>
        <span class="sr-only">{{ unitLabel }}</span>
      </label>
      <button class="erase-button" :class="{ active: mode === 'erase' }" :aria-pressed="mode === 'erase'"
        aria-label="擦除单位" title="擦除单位" @click="emit('update:mode', mode === 'erase' ? 'unit' : 'erase')">×</button>
    </template>

    <label v-if="mode !== 'erase'" class="range-control" aria-label="填充范围">
      <span>范围</span>
      <select :value="fillRadius" @change="emit('update:fillRadius', Number(($event.target as HTMLSelectElement).value))">
        <option :value="0">1 格</option>
        <option :value="1">7 格</option>
        <option :value="2">19 格</option>
        <option :value="3">37 格</option>
      </select>
    </label>

    <div v-if="mode === 'unit'" class="strength-control" aria-label="单位点数">
      <button :disabled="strength <= 1" aria-label="减少点数" @click="emit('update:strength', Math.max(1, strength - 1))">−</button>
      <input :value="strength" type="number" min="1" max="65535" aria-label="放置点数" @change="changeStrength" />
      <button aria-label="增加点数" @click="emit('update:strength', Math.min(65535, strength + 1))">＋</button>
    </div>
  </div>
</template>

<style scoped>
.map-editor-toolbar{position:absolute;z-index:3;bottom:clamp(12px,2.4vh,28px);left:50%;display:flex;align-items:center;gap:7px;width:max-content;max-width:calc(100vw - 24px);box-sizing:border-box;padding:8px;border:1px solid rgba(143,188,206,.25);border-radius:12px;background:rgba(7,13,23,.94);box-shadow:0 10px 34px rgba(0,0,0,.38);transform:translateX(-50%);font:12px/1.2 Arial,"Microsoft YaHei",sans-serif;color:#e4edf4}
.map-editor-toolbar select,.map-editor-toolbar button,.map-editor-toolbar input{box-sizing:border-box;min-height:36px;margin:0;border:1px solid rgba(143,188,206,.25);border-radius:7px;background:#090d13;color:#e4edf4;font:inherit}
.map-editor-toolbar select{max-width:180px;padding:6px 26px 6px 9px;cursor:pointer}
.mode-control select{min-width:70px}
.terrain-picker{position:relative;display:flex;align-items:center}
.terrain-trigger{display:flex;align-items:center;gap:8px;min-width:108px;padding:4px 8px!important;text-align:left;white-space:nowrap}
.terrain-name{flex:1;overflow:hidden;text-overflow:ellipsis}
.picker-chevron{color:#91a8b7;font-size:13px}
.terrain-options{position:absolute;z-index:8;bottom:calc(100% + 9px);left:0;display:grid;gap:3px;width:190px;max-height:min(48dvh,360px);box-sizing:border-box;overflow:auto;padding:6px;border:1px solid rgba(143,188,206,.3);border-radius:9px;background:#0a121d;box-shadow:0 12px 32px rgba(0,0,0,.58)}
.terrain-options button{display:flex;align-items:center;gap:9px;min-height:39px;padding:5px 8px;text-align:left}
.terrain-options button:hover,.terrain-options button[aria-selected="true"]{background:#17364a;color:#fff}
.terrain-options button>.terrain-option-name{flex:1}
.terrain-options small{color:#80c9c5;font-size:9px}
.choice-control{display:flex;align-items:center;gap:6px}
.choice-control i{width:19px;height:19px;flex:none;border:1px solid rgba(255,255,255,.3);border-radius:50%}
.terrain-control select{min-width:105px;max-width:150px}
.unit-control select{min-width:115px;max-width:155px}
.range-control{display:flex;align-items:center;gap:5px;padding-left:7px;border-left:1px solid rgba(143,188,206,.17);color:#9ab0c2;font-size:10px}
.range-control select{min-width:64px;padding:5px 20px 5px 7px}
.strength-control{display:flex;align-items:center;gap:3px;padding-left:7px;border-left:1px solid rgba(143,188,206,.17)}
.strength-control button{width:32px;padding:0;font-size:18px}.strength-control input{width:42px;padding:4px;text-align:center;font-weight:700}
.erase-button{width:36px;padding:0!important;font-size:21px!important}.erase-button.active{border-color:#f07883!important;color:#ffc3ca!important;background:#492631!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:720px){.map-editor-toolbar{right:8px;bottom:8px;left:8px;flex-wrap:wrap;justify-content:center;width:auto;max-width:none;gap:5px;padding:6px;transform:none}.map-editor-toolbar select{min-height:33px;max-width:130px;padding:5px 20px 5px 7px;font-size:11px}.mode-control select{min-width:64px}.choice-control i{width:16px;height:16px}.terrain-control select{min-width:86px;max-width:115px}.unit-control select{min-width:96px;max-width:120px}.range-control{gap:3px;padding-left:4px}.range-control select{min-width:56px}.strength-control{gap:2px;padding-left:4px}.strength-control button{width:28px;min-height:33px}.strength-control input{width:34px;min-height:33px}.erase-button{width:33px;min-height:33px}}
@media(max-width:720px){.terrain-trigger{min-width:100px;padding:3px 6px!important}.terrain-options{width:min(190px,calc(100vw - 20px));max-height:min(45dvh,320px)}.terrain-options button{min-height:36px}}
</style>
