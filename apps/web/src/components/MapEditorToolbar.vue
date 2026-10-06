<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import MapTerrainIcon from "./MapTerrainIcon.vue";
import MapEditorUnitIcon from "./MapEditorUnitIcon.vue";
import NumberStepper from "./NumberStepper.vue";
import type { MapTerrainIconLayer } from "./MapTerrainIcon.vue";

export interface MapEditorTerrainOption {
  id: string;
  name: string;
  color: string;
  baseOpacity?: number;
  transparent?: boolean;
  artwork?: readonly MapTerrainIconLayer[];
  modId?: string;
}
export interface MapEditorPlayerOption { seat: number; name: string; color: string }

const props = defineProps<{
  mode: "terrain" | "unit" | "erase";
  terrainOptions: MapEditorTerrainOption[];
  selectedTerrain: string;
  unitPreset: string;
  playerOptions: MapEditorPlayerOption[];
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
const unitPickerOpen = ref(false);
const toolbarRoot = ref<HTMLDivElement | null>(null);
const selectedPlayer = computed(() => props.playerOptions.find((option) => props.unitPreset === `player:${option.seat}`));
const selectedUnitKind = computed(() => props.unitPreset.startsWith("player:") ? "player" : props.unitPreset === "wild" ? "wild" : "blocker");
const selectedUnitName = computed(() => selectedPlayer.value?.name ?? (props.unitPreset === "wild" ? "野怪" : "阻挡"));
function changeMode(event: Event): void {
  terrainPickerOpen.value = false;
  unitPickerOpen.value = false;
  emit("update:mode", (event.target as HTMLSelectElement).value as "terrain" | "unit");
}
function selectTerrain(id: string): void {
  emit("update:selectedTerrain", id);
  terrainPickerOpen.value = false;
}
function selectUnit(preset: string): void {
  emit("update:unitPreset", preset);
  unitPickerOpen.value = false;
}
function toggleErase(): void {
  terrainPickerOpen.value = false;
  unitPickerOpen.value = false;
  emit("update:mode", props.mode === "erase" ? "unit" : "erase");
}
function closeTerrainPicker(event: PointerEvent): void {
  if (!toolbarRoot.value?.contains(event.target as Node)) {
    terrainPickerOpen.value = false;
    unitPickerOpen.value = false;
  }
}
function onToolbarKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") { terrainPickerOpen.value = false; unitPickerOpen.value = false; }
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
        <MapTerrainIcon :terrain-id="terrain?.id ?? 'core/plain'" :color="terrain?.color ?? '#63985d'" :base-opacity="terrain?.baseOpacity ?? 1" :transparent="terrain?.transparent ?? false" :artwork="terrain?.artwork ?? []" :size="20" />
        <span class="terrain-name">{{ terrain?.name ?? '平原' }}</span><span class="picker-chevron">⌃</span>
      </button>
      <div v-if="terrainPickerOpen" class="terrain-options" role="listbox" aria-label="地形选项">
        <button v-for="option in terrainOptions" :key="option.id" role="option" :aria-selected="selectedTerrain === option.id" @click="selectTerrain(option.id)">
          <MapTerrainIcon :terrain-id="option.id" :color="option.color" :base-opacity="option.baseOpacity ?? 1" :transparent="option.transparent ?? false" :artwork="option.artwork ?? []" :size="25" />
          <span class="terrain-option-name">{{ option.name }}</span><small v-if="option.modId">Mod</small>
        </button>
      </div>
    </div>

    <template v-else>
      <div class="toolbar-choice unit-choice">
        <button class="choice-trigger" :class="{ 'player-choice-trigger': !!selectedPlayer }" type="button" :aria-label="`选择单位，当前：${selectedUnitName}`" :title="selectedUnitName" aria-haspopup="listbox" :aria-expanded="unitPickerOpen" @click="unitPickerOpen = !unitPickerOpen">
          <MapEditorUnitIcon :kind="selectedUnitKind" :color="selectedPlayer?.color ?? '#668fb8'" :size="22" />
          <span v-if="!selectedPlayer" class="choice-name">{{ selectedUnitName }}</span><span v-if="!selectedPlayer" class="picker-chevron" aria-hidden="true">⌃</span>
        </button>
        <div v-if="unitPickerOpen" class="choice-popover unit-popover" role="listbox" aria-label="玩家位置和单位类型">
          <button v-for="option in playerOptions" :key="option.seat" type="button" role="option" :aria-selected="unitPreset === `player:${option.seat}`" @click="selectUnit(`player:${option.seat}`)">
            <MapEditorUnitIcon kind="player" :color="option.color" :size="26" /><span>{{ option.name }}</span><small>{{ option.seat }}</small>
          </button>
          <span class="choice-divider" aria-hidden="true"></span>
          <button type="button" role="option" :aria-selected="unitPreset === 'wild'" @click="selectUnit('wild')"><MapEditorUnitIcon kind="wild" :size="26" /><span>野怪</span></button>
          <button type="button" role="option" :aria-selected="unitPreset === 'blocker'" @click="selectUnit('blocker')"><MapEditorUnitIcon kind="blocker" :size="26" /><span>阻挡</span></button>
        </div>
      </div>
      <button class="erase-button" :class="{ active: mode === 'erase' }" :aria-pressed="mode === 'erase'"
        aria-label="擦除单位" title="擦除单位" @click="toggleErase">×</button>
    </template>

    <label v-if="mode !== 'terrain'" class="range-control">
      <select aria-label="填充范围" :value="fillRadius" @change="emit('update:fillRadius', Number(($event.target as HTMLSelectElement).value))">
        <option :value="0">1 格</option>
        <option :value="1">7 格</option>
        <option :value="2">19 格</option>
        <option :value="3">37 格</option>
      </select>
    </label>

    <div v-if="mode !== 'terrain'" class="strength-control" aria-label="单位点数">
      <NumberStepper :model-value="strength" :min="1" :max="65535" aria-label="放置点数" size="compact" @update:model-value="emit('update:strength', $event)" />
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
.strength-control .number-stepper{width:108px}
.erase-button{width:36px;padding:0!important;font-size:21px!important}.erase-button.active{border-color:#f07883!important;color:#ffc3ca!important;background:#492631!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:720px){.map-editor-toolbar{right:8px;bottom:8px;left:8px;flex-wrap:wrap;justify-content:center;width:auto;max-width:none;gap:5px;padding:6px;transform:none}.map-editor-toolbar select{min-height:33px;max-width:130px;padding:5px 20px 5px 7px;font-size:11px}.mode-control select{min-width:64px}.choice-control i{width:16px;height:16px}.terrain-control select{min-width:86px;max-width:115px}.unit-control select{min-width:96px;max-width:120px}.range-control{gap:3px;padding-left:4px}.range-control select{min-width:56px}.strength-control{gap:2px;padding-left:4px}.strength-control .number-stepper{width:98px}.erase-button{width:33px;min-height:33px}}
@media(max-width:720px){.terrain-trigger{min-width:100px;padding:3px 6px!important}.terrain-options{width:min(190px,calc(100vw - 20px));max-height:min(45dvh,320px)}.terrain-options button{min-height:36px}}
.toolbar-choice{position:relative;display:flex;align-items:center}.choice-trigger{display:flex;align-items:center;justify-content:flex-start;gap:8px;min-width:64px;height:36px;margin:0;padding:4px 8px;border:1px solid rgba(143,188,206,.25);border-radius:7px;color:#e4edf4;background:#090d13;font-size:12px;white-space:nowrap}.choice-trigger:not(.player-choice-trigger){min-width:118px}.choice-name{flex:1;min-width:0;max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.choice-popover{position:absolute;z-index:10;bottom:calc(100% + 9px);left:0;display:grid;gap:3px;width:220px;max-height:min(48dvh,390px);box-sizing:border-box;overflow:auto;padding:6px;border:1px solid rgba(143,188,206,.28);border-radius:9px;background:#0a121d;box-shadow:0 12px 32px rgba(0,0,0,.55)}.choice-popover button{display:flex;align-items:center;gap:9px;min-height:39px;margin:0;padding:4px 8px;border:0;border-radius:5px;color:#dbe8f0;background:transparent;text-align:left;font-size:11px}.choice-popover button:hover,.choice-popover button[aria-selected="true"]{background:#17364a;color:#fff}.choice-popover button>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.choice-popover small{margin-left:auto;color:#80c9c5;font-size:9px}.choice-divider{height:1px;margin:3px 5px;background:rgba(143,188,206,.16)}
@media(max-width:720px){.choice-trigger{min-width:92px;height:33px;padding:4px 6px;font-size:10px}.choice-popover{width:min(220px,calc(100vw - 24px));max-height:min(42dvh,320px)}}
.choice-trigger.player-choice-trigger{width:max-content;min-width:0;gap:0}
@media(max-width:720px){.map-editor-toolbar{flex-wrap:nowrap;justify-content:flex-start}.map-editor-toolbar>*{flex:0 0 auto}.choice-trigger.player-choice-trigger{min-width:0;gap:0;padding-right:5px;padding-left:5px}.range-control{gap:0;padding-left:4px}.range-control select{min-width:56px}.strength-control .number-stepper{width:88px}}
@media(max-width:380px){.map-editor-toolbar{gap:4px;padding:5px}.mode-control select{min-width:56px}.choice-trigger:not(.player-choice-trigger){min-width:72px}.choice-trigger.player-choice-trigger{min-width:0;gap:0;padding-right:4px;padding-left:4px}.erase-button{width:30px;min-height:32px}.range-control select{min-width:50px;padding-right:16px;padding-left:5px}.strength-control .number-stepper{width:78px}}
</style>
