<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MapDefinition } from "@numeral-lord/core-content";
import { installedTerrainMods, installedTerrainCatalog } from "../installed-content";

const props = defineProps<{ initial?: MapDefinition | null }>();
const emit = defineEmits<{ save: [definition: MapDefinition]; cancel: [] }>();

type TerrainOption = { id: string; name: string; color: string; blocked?: boolean; modId?: string };
const coreTerrains: TerrainOption[] = [
  { id: "core/plain", name: "平原", color: "#63985d" },
  { id: "core/ocean", name: "海洋", color: "#2f72c8" },
  { id: "core/stronghold", name: "据点", color: "#bf5d68" },
  { id: "core/mountain", name: "山地 · 阻挡", color: "#52627b", blocked: true },
  { id: "core/void", name: "虚无 · 阻挡", color: "#101927", blocked: true }
];
const terrainOptions = computed<TerrainOption[]>(() => [
  ...coreTerrains,
  ...installedTerrainMods.flatMap((mod) => mod.terrains.map((terrain) => ({
    id: terrain.id,
    name: terrain.displayName,
    color: terrain.id === "mod/oil-field" ? "#9a6338" : "#8173ac",
    modId: mod.id
  })))
]);
const width = ref(props.initial?.columns ?? 9);
const height = ref(props.initial ? props.initial.terrain.length / props.initial.columns : 9);
const players = ref(props.initial?.players ?? 2);
const name = ref(props.initial?.name ?? "新地图");
const terrain = ref<string[]>([]);
const soldiers = ref<Array<{ index: number; seat: number; strength: number }>>([]);
const teams = ref<number[]>([]);
const selectedTerrain = ref("core/plain");
const placementMode = ref<"terrain" | "unit" | "erase">("terrain");
const selectedSeat = ref(1);
const strength = ref(1);
const formError = ref("");
const isBusy = ref(false);
const terrainLookup = computed(() => new Map(terrainOptions.value.map((entry) => [entry.id, entry])));

function resetFromDefinition(definition?: MapDefinition | null): void {
  width.value = definition?.columns ?? 9;
  height.value = definition ? definition.terrain.length / definition.columns : 9;
  players.value = definition?.players ?? 2;
  name.value = definition?.name ?? "新地图";
  const count = width.value * height.value;
  terrain.value = Array.from({ length: count }, (_, index) => {
    if (!definition) return "core/plain";
    const terrainId = definition.terrainLegend[definition.terrain[index]!] ?? "core/plain";
    return terrainLookup.value.has(terrainId) ? terrainId : "core/plain";
  });
  soldiers.value = (definition?.soldiers ?? []).map(([index, seat, unitStrength]) => ({ index, seat, strength: unitStrength }));
  teams.value = Array.from({ length: players.value }, (_, index) => definition?.teams[index] ?? index + 1);
  selectedSeat.value = Math.min(selectedSeat.value, players.value);
}
watch(() => props.initial, (value) => resetFromDefinition(value), { immediate: true });
watch([width, height], () => {
  const count = Math.max(1, Math.min(4096, width.value * height.value));
  terrain.value = Array.from({ length: count }, (_, index) => terrain.value[index] ?? "core/plain");
  soldiers.value = soldiers.value.filter((unit) => unit.index < count);
});
watch(players, (value) => {
  selectedSeat.value = Math.min(selectedSeat.value, value);
  teams.value = Array.from({ length: value }, (_, index) => teams.value[index] ?? index + 1);
  soldiers.value = soldiers.value.filter((unit) => unit.seat <= value);
});

const cells = computed(() => terrain.value.map((id, index) => ({ index, terrain: terrainLookup.value.get(id) })));
function paintCell(index: number): void {
  if (placementMode.value === "terrain") {
    terrain.value[index] = selectedTerrain.value;
    if (terrainLookup.value.get(selectedTerrain.value)?.blocked) soldiers.value = soldiers.value.filter((unit) => unit.index !== index);
  } else if (placementMode.value === "erase") {
    terrain.value[index] = "core/plain";
    soldiers.value = soldiers.value.filter((unit) => unit.index !== index);
  } else {
    if (terrainLookup.value.get(terrain.value[index]!)?.blocked) return;
    const existing = soldiers.value.find((unit) => unit.index === index);
    if (existing) Object.assign(existing, { seat: selectedSeat.value, strength: strength.value });
    else soldiers.value.push({ index, seat: selectedSeat.value, strength: strength.value });
  }
}

function saveMap(): void {
  if (isBusy.value) return;
  isBusy.value = true;
  formError.value = "";
  try {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const terrainLegend: Record<string, string> = {};
    const byTerrain = new Map<string, string>();
    for (const id of terrain.value) {
      if (byTerrain.has(id)) continue;
      const symbol = alphabet[byTerrain.size];
      if (!symbol) throw new Error("地形种类超过地图格式上限。");
      byTerrain.set(id, symbol);
      terrainLegend[symbol] = id;
    }
    const definition: MapDefinition = {
      version: 1,
      id: props.initial?.id ?? `custom-${createId()}`,
      name: name.value.trim() || "未命名地图",
      columns: width.value,
      terrain: terrain.value.map((id) => byTerrain.get(id)!).join(""),
      terrainLegend,
      requiredTerrainModIds: [...new Set(terrain.value.map((id) => terrainLookup.value.get(id)?.modId).filter((id): id is string => Boolean(id)))],
      players: players.value,
      soldiers: soldiers.value.map((unit) => [unit.index, unit.seat, unit.strength] as const),
      teams: teams.value,
      matchConditionIds: props.initial?.matchConditionIds ?? ["core/lose-all-survival-anchors", "core/last-team-standing"]
    };
    emit("save", definition);
  } catch (error) {
    formError.value = error instanceof Error ? error.message : "地图无法保存。";
  } finally {
    isBusy.value = false;
  }
}
function createId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
</script>

<template>
  <section class="editor-shell">
    <header class="editor-head">
      <div><p class="eyebrow">MAP EDITOR</p><h2>{{ initial ? '编辑地图' : '创建地图' }}</h2><p>点击棋盘格绘制地形或放置初始单位。蓝色/灰色不可驻兵地形会阻挡单位。</p></div>
      <button class="quiet-button" @click="emit('cancel')">返回地图库</button>
    </header>
    <div class="editor-layout">
      <div class="editor-board-wrap">
        <div class="editor-board" :style="{ '--columns': width, '--rows': height }">
          <button v-for="cell in cells" :key="cell.index" class="edit-cell" :style="{ background: cell.terrain?.color ?? '#63985d' }" :title="`${cell.index + 1} · ${cell.terrain?.name ?? '平原'}`" @click="paintCell(cell.index)">
            <span v-if="soldiers.find((unit) => unit.index === cell.index)" class="edit-unit" :class="`seat-${soldiers.find((unit) => unit.index === cell.index)?.seat}`">{{ soldiers.find((unit) => unit.index === cell.index)?.strength }}</span>
            <span v-else-if="cell.terrain?.blocked" class="blocked-mark">×</span>
          </button>
        </div>
        <div class="board-caption">{{ width }} × {{ height }} 格 · {{ soldiers.length }} 个初始单位</div>
      </div>
      <aside class="editor-tools">
        <label>地图名称<input v-model="name" maxlength="60" /></label>
        <div class="form-grid">
          <label>宽度<input v-model.number="width" type="number" min="1" max="64" @change="width = Math.max(1, Math.min(64, Math.trunc(width || 1))); height = Math.min(height, Math.floor(4096 / width))" /></label>
          <label>高度<input v-model.number="height" type="number" min="1" max="64" @change="height = Math.max(1, Math.min(64, Math.trunc(height || 1), Math.floor(4096 / width)))" /></label>
          <label>玩家位<input v-model.number="players" type="number" min="1" max="64" @change="players = Math.max(1, Math.min(64, Math.trunc(players || 1)))" /></label>
          <label>初始点数<input v-model.number="strength" type="number" min="1" max="65535" @change="strength = Math.max(1, Math.min(65535, Math.trunc(strength || 1)))" /></label>
        </div>
        <div class="tool-tabs"><button :class="{ active: placementMode === 'terrain' }" @click="placementMode = 'terrain'">绘制地形</button><button :class="{ active: placementMode === 'unit' }" @click="placementMode = 'unit'">放置单位</button><button :class="{ active: placementMode === 'erase' }" @click="placementMode = 'erase'">擦除</button></div>
        <div v-if="placementMode === 'terrain'" class="terrain-picker"><button v-for="option in terrainOptions" :key="option.id" :class="{ active: selectedTerrain === option.id }" @click="selectedTerrain = option.id"><i :style="{ background: option.color }" />{{ option.name }}<small v-if="option.modId">Mod</small></button></div>
        <div v-if="placementMode === 'unit'" class="unit-tools"><label>所属玩家<select v-model.number="selectedSeat"><option v-for="seat in players" :key="seat" :value="seat">玩家 {{ seat }}</option></select></label><p>选择玩家后点击棋盘放置/替换单位；再次设置即可修改点数。</p></div>
        <details class="team-settings"><summary>玩家队伍设置</summary><label v-for="(_, index) in teams" :key="index">玩家 {{ index + 1 }}<input v-model.number="teams[index]" type="number" min="1" max="64" /></label><small>相同队伍号表示同队；留空以外都视为数字队伍。</small></details>
        <p class="compat-note">当前地图格式支持玩家初始单位与阻挡地形；“野生中立单位”尚未纳入核心规则格式，暂不可保存为地图内容。</p>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <div class="editor-actions"><button class="quiet-button" @click="emit('cancel')">取消</button><button class="save-button" @click="saveMap">保存到本机地图</button></div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.editor-shell{padding:clamp(16px,2.5vw,28px);border:1px solid rgba(134,177,205,.3);border-radius:22px;background:linear-gradient(145deg,#1a2c40,#101f31)}.editor-head{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:18px}.eyebrow{margin:0 0 5px;color:#7de6d3;font-size:10px;font-weight:900;letter-spacing:.18em}.editor-head h2{margin:0;color:#f4f9ff;font-size:clamp(25px,3vw,34px)}.editor-head p:last-child{margin:6px 0 0;color:#91a9be;font-size:12px;line-height:1.6}.quiet-button,.save-button{width:auto;margin:0;padding:10px 14px;border:1px solid rgba(143,188,206,.32);color:#cde6f1;background:rgba(18,47,65,.5)}.editor-layout{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:16px;align-items:start}.editor-board-wrap,.editor-tools{min-width:0;padding:14px;border:1px solid rgba(135,175,202,.24);border-radius:15px;background:rgba(8,22,35,.58)}.editor-board{display:grid;grid-template-columns:repeat(var(--columns),minmax(13px,1fr));grid-template-rows:repeat(var(--rows),minmax(14px,1fr));gap:2px;max-height:65vh;overflow:auto;aspect-ratio:1.15;padding:5px}.edit-cell{position:relative;display:grid;min-width:0;min-height:0;place-items:center;margin:0;padding:0;border:1px solid rgba(7,21,32,.6);clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);cursor:pointer}.edit-cell:hover{filter:brightness(1.3);outline:1px solid #a9f1e4}.edit-unit{display:grid;width:65%;height:65%;place-items:center;border:2px solid #ccecff;border-radius:50%;color:white;font-weight:900;text-shadow:0 1px 3px #111}.seat-1{background:#be5f6a}.seat-2{background:#69aa57}.seat-3{background:#5688cd}.seat-4{background:#c4984a}.blocked-mark{color:#b6c5d5;font-size:19px;font-weight:900}.board-caption{padding:7px 3px 0;color:#7f9cb2;font-size:10px}.editor-tools{display:grid;gap:12px}.editor-tools label{display:grid;gap:5px;color:#b7ceda;font-size:11px}.editor-tools input,.editor-tools select{box-sizing:border-box;width:100%;min-height:38px;padding:8px;border:1px solid rgba(136,177,204,.31);border-radius:8px;background:#0c1b2b;color:#d6e8f0}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.tool-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.tool-tabs button{margin:0;padding:8px 5px;color:#a9bdcf;background:#152b3d;font-size:10px}.tool-tabs button.active{border-color:#78dfd0;color:#cdf7ef;background:#22545b}.terrain-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:210px;overflow:auto}.terrain-picker button{display:flex;align-items:center;gap:7px;margin:0;padding:7px;border:1px solid rgba(128,172,195,.2);color:#dbe9f2;background:rgba(32,59,77,.38);font-size:10px;text-align:left}.terrain-picker button.active{border-color:#74dfcf}.terrain-picker i{width:18px;height:18px;flex:none;border:1px solid rgba(255,255,255,.2);border-radius:5px}.terrain-picker small{margin-left:auto;color:#82bdbb}.unit-tools p,.compat-note{margin:0;color:#8fa9bc;font-size:10px;line-height:1.6}.team-settings{padding-top:8px;border-top:1px solid rgba(140,180,202,.15);color:#dcebf4;font-size:11px}.team-settings summary{cursor:pointer}.team-settings label{grid-template-columns:1fr 90px;align-items:center;margin-top:7px}.team-settings input{min-height:30px}.team-settings small{display:block;margin-top:7px;color:#8199ad}.compat-note{padding:9px;border-radius:8px;background:rgba(176,135,71,.1);color:#d8bc8d}.form-error{margin:0;color:#f2a9b4;font-size:11px}.editor-actions{display:flex;justify-content:flex-end;gap:8px}.save-button{border:0;color:#092332;background:linear-gradient(120deg,#81e9ce,#70c9e7);font-weight:800}.save-button:hover,.quiet-button:hover{filter:brightness(1.08)}@media(max-width:850px){.editor-layout{grid-template-columns:1fr}.editor-board{max-height:50vh;aspect-ratio:1.05}}@media(max-width:520px){.editor-head{display:grid}.editor-board{aspect-ratio:.9}.editor-tools{padding:11px}}
</style>
