<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MapDefinition } from "@numeral-lord/core-content";
import { installedTerrainMods } from "../installed-content";

const props = defineProps<{ initial?: MapDefinition | null }>();
const emit = defineEmits<{ save: [definition: MapDefinition]; cancel: [] }>();
type TerrainOption = { id: string; name: string; color: string; blocked?: boolean; modId?: string };
const coreTerrains: TerrainOption[] = [
  { id: "core/plain", name: "平原", color: "#63985d" }, { id: "core/ocean", name: "海洋", color: "#2f72c8" },
  { id: "core/stronghold", name: "据点", color: "#63985d" }, { id: "core/mountain", name: "山地", color: "#52627b", blocked: true },
  { id: "core/void", name: "虚无", color: "#101927", blocked: true }
];
const terrainOptions = computed<TerrainOption[]>(() => [...coreTerrains, ...installedTerrainMods.flatMap((mod) => mod.terrains.map((t) => ({
  id: t.id, name: t.displayName, color: t.id === "mod/oil-field" ? "#9a6338" : "#8173ac", modId: mod.id
})))]);
const width = ref(props.initial?.columns ?? 9), height = ref(props.initial ? props.initial.terrain.length / props.initial.columns : 9);
const players = ref(props.initial?.players ?? 2), name = ref(props.initial?.name ?? "新地图");
const terrain = ref<string[]>([]), soldiers = ref<Array<{ index: number; seat: number; strength: number }>>([]);
const specialUnits = ref<Array<{ index: number; kind: "wild" | "blocker"; strength: number }>>([]), teams = ref<number[]>([]);
const selectedTerrain = ref("core/plain"), placementMode = ref<"terrain" | "unit" | "erase">("terrain");
const unitKind = ref<"player" | "wild" | "blocker">("player"), selectedSeat = ref(1), strength = ref(1);
const formError = ref(""), terrainLookup = computed(() => new Map(terrainOptions.value.map((entry) => [entry.id, entry])));
const editorZoom = ref(1), editorPan = ref({ x: 0, y: 0 });
const editorPointers = new Map<number, { x: number; y: number }>();
let editorDrag: { x: number; y: number; panX: number; panY: number } | undefined;
let editorPinch: { distance: number; zoom: number; x: number; y: number; panX: number; panY: number } | undefined;
let editorDraggingAt = 0;

function resetFromDefinition(definition?: MapDefinition | null): void {
  width.value = definition?.columns ?? 9; height.value = definition ? definition.terrain.length / definition.columns : 9;
  players.value = definition?.players ?? 2; name.value = definition?.name ?? "新地图";
  const count = width.value * height.value;
  terrain.value = Array.from({ length: count }, (_, i) => {
    if (!definition) return "core/plain";
    const id = definition.terrainLegend[definition.terrain[i]!] ?? "core/plain";
    return terrainLookup.value.has(id) ? id : "core/plain";
  });
  soldiers.value = (definition?.soldiers ?? []).map(([index, seat, value]) => ({ index, seat, strength: value }));
  specialUnits.value = (definition?.specialUnits ?? []).map(([index, kind, value]) => ({ index, kind, strength: value }));
  teams.value = Array.from({ length: players.value }, (_, i) => definition?.teams[i] ?? i + 1);
  selectedSeat.value = Math.min(selectedSeat.value, players.value);
}
watch(() => props.initial, (value) => resetFromDefinition(value), { immediate: true });
watch([width, height], () => {
  const count = Math.max(1, Math.min(4096, width.value * height.value));
  terrain.value = Array.from({ length: count }, (_, i) => terrain.value[i] ?? "core/plain");
  soldiers.value = soldiers.value.filter((u) => u.index < count); specialUnits.value = specialUnits.value.filter((u) => u.index < count);
});
watch(players, (value) => {
  selectedSeat.value = Math.min(selectedSeat.value, value);
  teams.value = Array.from({ length: value }, (_, i) => teams.value[i] ?? i + 1);
  soldiers.value = soldiers.value.filter((u) => u.seat <= value);
});
const radius = computed(() => Math.min(30, 720 / (Math.sqrt(3) * (width.value + .5)), 560 / (1.5 * (height.value - 1) + 2)));
const boardMetrics = computed(() => {
  const r = radius.value, w = Math.sqrt(3) * r * (width.value + .5), h = 2 * r + 1.5 * r * (height.value - 1);
  return { viewBox: `0 0 ${w + r} ${h + 2 * r}`, r, offsetX: r + (w - Math.sqrt(3) * r * width.value) / 2, offsetY: r };
});
const cells = computed(() => terrain.value.map((id, index) => {
  const row = Math.floor(index / width.value), column = index % width.value, { r, offsetX, offsetY } = boardMetrics.value;
  const x = offsetX + Math.sqrt(3) * r * (column + ((row + 1) % 2) * .5), y = offsetY + 1.5 * r * row;
  const points = Array.from({ length: 6 }, (_, n) => `${x + r * Math.cos(Math.PI / 180 * (60 * n - 30))},${y + r * Math.sin(Math.PI / 180 * (60 * n - 30))}`).join(" ");
  return { index, x, y, points, terrain: terrainLookup.value.get(id), soldier: soldiers.value.find((u) => u.index === index), special: specialUnits.value.find((u) => u.index === index) };
}));
function paintCell(index: number): void {
  if (performance.now() - editorDraggingAt < 220) return;
  if (placementMode.value === "terrain") {
    terrain.value[index] = selectedTerrain.value;
    if (terrainLookup.value.get(selectedTerrain.value)?.blocked) { soldiers.value = soldiers.value.filter((u) => u.index !== index); specialUnits.value = specialUnits.value.filter((u) => u.index !== index); }
    return;
  }
  if (placementMode.value === "erase") {
    terrain.value[index] = "core/plain"; soldiers.value = soldiers.value.filter((u) => u.index !== index); specialUnits.value = specialUnits.value.filter((u) => u.index !== index); return;
  }
  if (terrainLookup.value.get(terrain.value[index]!)?.blocked) return;
  if (unitKind.value === "player") {
    specialUnits.value = specialUnits.value.filter((u) => u.index !== index);
    const current = soldiers.value.find((u) => u.index === index);
    if (current) Object.assign(current, { seat: selectedSeat.value, strength: strength.value }); else soldiers.value.push({ index, seat: selectedSeat.value, strength: strength.value });
  } else {
    soldiers.value = soldiers.value.filter((u) => u.index !== index);
    specialUnits.value = specialUnits.value.filter((u) => u.index !== index);
    specialUnits.value.push({ index, kind: unitKind.value, strength: strength.value });
  }
}
function onEditorPointerDown(event: PointerEvent): void {
  editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  if (editorPointers.size === 1) editorDrag = { x: event.clientX, y: event.clientY, panX: editorPan.value.x, panY: editorPan.value.y };
  else if (editorPointers.size === 2) {
    const [a, b] = [...editorPointers.values()];
    if (a && b) editorPinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: editorZoom.value,
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, panX: editorPan.value.x, panY: editorPan.value.y };
    editorDrag = undefined;
  }
}
function onEditorPointerMove(event: PointerEvent): void {
  if (!editorPointers.has(event.pointerId)) return;
  editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const points = [...editorPointers.values()];
  if (points.length > 1 && editorPinch) {
    const [a, b] = points;
    if (a && b) {
      if (editorPinch.distance > 0) editorZoom.value = Math.max(.6, Math.min(3, editorPinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / editorPinch.distance));
      editorPan.value = { x: editorPinch.panX + (a.x + b.x) / 2 - editorPinch.x, y: editorPinch.panY + (a.y + b.y) / 2 - editorPinch.y };
    }
    editorDraggingAt = performance.now();
  } else if (points.length === 1 && editorDrag) {
    const point = points[0]!;
    const dx = point.x - editorDrag.x, dy = point.y - editorDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) editorDraggingAt = performance.now();
    editorPan.value = { x: editorDrag.panX + dx, y: editorDrag.panY + dy };
  }
}
function onEditorPointerUp(event: PointerEvent): void {
  editorPointers.delete(event.pointerId);
  if (editorPointers.size < 2) editorPinch = undefined;
  const point = [...editorPointers.values()][0];
  editorDrag = point ? { x: point.x, y: point.y, panX: editorPan.value.x, panY: editorPan.value.y } : undefined;
}
function onEditorWheel(event: WheelEvent): void {
  editorZoom.value = Math.max(.6, Math.min(3, editorZoom.value * (event.deltaY < 0 ? 1.1 : .91)));
}
function saveMap(): void {
  formError.value = "";
  try {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", legend: Record<string, string> = {}, byTerrain = new Map<string, string>();
    for (const id of terrain.value) { if (byTerrain.has(id)) continue; const symbol = alphabet[byTerrain.size]; if (!symbol) throw new Error("地形种类超过地图格式上限。"); byTerrain.set(id, symbol); legend[symbol] = id; }
    const definition: MapDefinition = {
      version: 1, id: props.initial?.id ?? `custom-${createId()}`, name: name.value.trim() || "未命名地图", columns: width.value,
      terrain: terrain.value.map((id) => byTerrain.get(id)!).join(""), terrainLegend: legend,
      requiredTerrainModIds: [...new Set(terrain.value.map((id) => terrainLookup.value.get(id)?.modId).filter((id): id is string => Boolean(id)))],
      players: players.value, soldiers: soldiers.value.map((u) => [u.index, u.seat, u.strength] as const),
      ...(specialUnits.value.length ? { specialUnits: specialUnits.value.map((u) => [u.index, u.kind, u.strength] as const) } : {}),
      teams: teams.value, matchConditionIds: props.initial?.matchConditionIds ?? ["core/lose-all-survival-anchors", "core/last-team-standing"]
    };
    emit("save", definition);
  } catch (error) { formError.value = error instanceof Error ? error.message : "地图无法保存。"; }
}
function createId(): string { return typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
</script>

<template>
  <section class="editor-shell">
    <header class="editor-head"><div><p class="eyebrow">MAP EDITOR</p><h2>{{ initial ? '编辑地图' : '创建地图' }}</h2><p>地图铺展在工作区；绘制工具和规则设置固定在侧栏。</p></div><button class="quiet-button" @click="emit('cancel')">返回地图库</button></header>
    <div class="editor-layout">
      <div class="board-workspace" :style="{ '--columns': width, '--rows': height }" @pointerdown="onEditorPointerDown" @pointermove="onEditorPointerMove" @pointerup="onEditorPointerUp" @pointercancel="onEditorPointerUp" @wheel.prevent="onEditorWheel">
        <svg class="editor-board" :style="{ transform: `translate(${editorPan.x}px, ${editorPan.y}px) scale(${editorZoom})` }" :viewBox="boardMetrics.viewBox" role="img" aria-label="六边形地图编辑棋盘">
          <g v-for="cell in cells" :key="cell.index" class="hex-cell" @click="paintCell(cell.index)">
            <polygon :points="cell.points" :fill="cell.terrain?.color ?? '#63985d'" :class="{ blocked: cell.terrain?.blocked }" />
            <polygon v-if="cell.terrain?.id === 'core/ocean'" :points="cell.points" class="water-mark" />
            <g v-if="cell.soldier" class="unit-marker" :transform="`translate(${cell.x} ${cell.y})`"><polygon :points="`0,${-boardMetrics.r*.62} ${boardMetrics.r*.54},${-boardMetrics.r*.31} ${boardMetrics.r*.54},${boardMetrics.r*.31} 0,${boardMetrics.r*.62} ${-boardMetrics.r*.54},${boardMetrics.r*.31} ${-boardMetrics.r*.54},${-boardMetrics.r*.31}`" :class="`seat-${cell.soldier.seat}`"/><text y="4">{{ cell.soldier.strength }}</text></g>
            <g v-else-if="cell.special" class="unit-marker" :transform="`translate(${cell.x} ${cell.y})`"><polygon :points="`0,${-boardMetrics.r*.62} ${boardMetrics.r*.54},${-boardMetrics.r*.31} ${boardMetrics.r*.54},${boardMetrics.r*.31} 0,${boardMetrics.r*.62} ${-boardMetrics.r*.54},${boardMetrics.r*.31} ${-boardMetrics.r*.54},${-boardMetrics.r*.31}`" :class="cell.special.kind"/><text y="4">{{ cell.special.kind === 'wild' ? '野' : '挡' }}</text><text class="unit-strength" :y="boardMetrics.r*.56">{{ cell.special.strength }}</text></g>
            <text v-else-if="cell.terrain?.blocked" class="blocked-mark" :x="cell.x" :y="cell.y + 4">×</text>
          </g>
        </svg>
        <div class="board-caption">{{ width }} × {{ height }} 格 <span>·</span> {{ soldiers.length + specialUnits.length }} 个初始单位 <span>·</span> 点击六边格应用当前工具</div>
      </div>
      <aside class="editor-tools">
        <div class="side-title"><span>地图设置</span><small>EDITOR</small></div>
        <label>地图名称<input v-model="name" maxlength="60" /></label>
        <div class="form-grid"><label>宽度<input v-model.number="width" type="number" min="1" max="64" @change="width = Math.max(1, Math.min(64, Math.trunc(width || 1))); height = Math.min(height, Math.floor(4096 / width))" /></label><label>高度<input v-model.number="height" type="number" min="1" max="64" @change="height = Math.max(1, Math.min(64, Math.trunc(height || 1), Math.floor(4096 / width)))" /></label><label>玩家位<input v-model.number="players" type="number" min="1" max="64" @change="players = Math.max(1, Math.min(64, Math.trunc(players || 1)))" /></label><label>放置点数<input v-model.number="strength" type="number" min="1" max="65535" @change="strength = Math.max(1, Math.min(65535, Math.trunc(strength || 1)))" /></label></div>
        <div class="tool-tabs"><button :class="{ active: placementMode === 'terrain' }" @click="placementMode = 'terrain'">地形</button><button :class="{ active: placementMode === 'unit' }" @click="placementMode = 'unit'">单位</button><button :class="{ active: placementMode === 'erase' }" @click="placementMode = 'erase'">擦除</button></div>
        <div v-if="placementMode === 'terrain'" class="terrain-picker"><button v-for="option in terrainOptions" :key="option.id" :class="{ active: selectedTerrain === option.id }" @click="selectedTerrain = option.id"><i :style="{ background: option.color }" />{{ option.name }}<small v-if="option.modId">Mod</small></button></div>
        <div v-if="placementMode === 'unit'" class="unit-tools"><label>单位类型<select v-model="unitKind"><option value="player">玩家单位</option><option value="wild">野怪（会反击）</option><option value="blocker">阻挡（不反击）</option></select></label><label v-if="unitKind === 'player'">所属玩家<select v-model.number="selectedSeat"><option v-for="seat in players" :key="seat" :value="seat">玩家 {{ seat }}</option></select></label><p v-if="unitKind === 'wild'">野怪会反击；可反击次数由所在格地形决定。</p><p v-else-if="unitKind === 'blocker'">阻挡不会反击；进攻未能击破时，攻击单位失去行动力。</p><p v-else>放置或替换玩家单位；再次点击可以修改点数。</p></div>
        <details class="team-settings"><summary>玩家队伍设置</summary><label v-for="(_, index) in teams" :key="index">玩家 {{ index + 1 }}<input v-model.number="teams[index]" type="number" min="1" max="64" /></label><small>相同队伍号表示同队。</small></details>
        <p class="compat-note">阻挡不反击；野怪的反击次数取决于所在地皮，每个进攻回合独立记录。</p>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <div class="editor-actions"><button class="quiet-button" @click="emit('cancel')">取消</button><button class="save-button" @click="saveMap">保存地图</button></div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.editor-shell{--ink:#e8f2f9;min-height:min(82vh,900px);padding:clamp(14px,2vw,24px);border:1px solid rgba(134,177,205,.27);border-radius:20px;background:#101723;color:var(--ink);overflow:hidden}.editor-head{position:relative;z-index:2;display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:12px}.eyebrow{margin:0 0 4px;color:#7de6d3;font-size:10px;font-weight:900;letter-spacing:.18em}.editor-head h2{margin:0;font-size:clamp(24px,3vw,34px)}.editor-head p:last-child{margin:5px 0 0;color:#8ba2b9;font-size:11px}.quiet-button,.save-button{width:auto;margin:0;padding:9px 13px;border:1px solid rgba(143,188,206,.32);border-radius:9px;color:#cde6f1;background:rgba(18,47,65,.76);white-space:nowrap}.editor-layout{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:14px;min-height:650px;height:min(74vh,800px)}.board-workspace{position:relative;display:grid;place-items:center;min-width:0;min-height:0;overflow:hidden;border-radius:13px;background-color:#0b111b;background-image:radial-gradient(ellipse at center,rgba(38,60,83,.45),transparent 70%),repeating-linear-gradient(0deg,transparent 0 17px,rgba(124,152,178,.028) 18px 19px)}.editor-board{width:100%;height:100%;padding:10px;overflow:visible}.hex-cell{cursor:pointer}.hex-cell polygon:first-child{stroke:#25344a;stroke-width:1;transition:filter .12s}.hex-cell:hover polygon:first-child{filter:brightness(1.28);stroke:#a5f5e3;stroke-width:2}.hex-cell polygon.blocked{stroke:#111b2b}.water-mark{fill:none;stroke:#72b5fb;stroke-width:2;stroke-dasharray:5 4;opacity:.32;pointer-events:none}.unit-marker{pointer-events:none}.unit-marker polygon{stroke:#b9e5ff;stroke-width:1.8}.unit-marker text{fill:white;text-anchor:middle;font-weight:900;font-size:12px;paint-order:stroke;stroke:#223044;stroke-width:2px}.unit-marker .seat-1{fill:#be5f6a}.unit-marker .seat-2{fill:#69aa57}.unit-marker .seat-3{fill:#5688cd}.unit-marker .seat-4{fill:#c4984a}.unit-marker .wild{fill:#a56d36;stroke:#f4d08d}.unit-marker .blocker{fill:#4c586d;stroke:#c2ccd9}.unit-marker .unit-strength{font-size:8px;stroke-width:1px}.blocked-mark{fill:#c5d2e1;text-anchor:middle;font-size:18px;font-weight:900;pointer-events:none}.board-caption{position:absolute;left:15px;bottom:12px;color:#90a8bd;font-size:10px}.board-caption span{padding:0 4px;color:#536a80}.editor-tools{display:flex;flex-direction:column;gap:11px;min-width:0;max-height:100%;overflow:auto;padding:14px;border:1px solid rgba(135,175,202,.24);border-radius:14px;background:rgba(10,22,35,.94)}.side-title{display:flex;justify-content:space-between;color:#e7f3fa;font-size:14px;font-weight:800}.side-title small{color:#6698b5;font-size:9px;letter-spacing:.12em}.editor-tools label{display:grid;gap:5px;color:#a9c1d2;font-size:10px}.editor-tools input,.editor-tools select{box-sizing:border-box;width:100%;min-height:36px;padding:7px;border:1px solid rgba(136,177,204,.31);border-radius:8px;background:#0c1b2b;color:#d6e8f0}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.tool-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.tool-tabs button{margin:0;padding:8px 4px;color:#a9bdcf;background:#152b3d;font-size:10px}.tool-tabs button.active{border-color:#78dfd0;color:#cdf7ef;background:#22545b}.terrain-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:190px;overflow:auto}.terrain-picker button{display:flex;align-items:center;gap:7px;margin:0;padding:7px;border:1px solid rgba(128,172,195,.2);border-radius:8px;color:#dbe9f2;background:rgba(32,59,77,.38);font-size:10px;text-align:left}.terrain-picker button.active{border-color:#74dfcf}.terrain-picker i{width:18px;height:18px;flex:none;border:1px solid rgba(255,255,255,.2);border-radius:50%}.terrain-picker small{margin-left:auto;color:#82bdbb}.unit-tools{display:grid;gap:9px}.unit-tools p,.compat-note{margin:0;color:#8fa9bc;font-size:10px;line-height:1.55}.team-settings{padding-top:8px;border-top:1px solid rgba(140,180,202,.15);color:#dcebf4;font-size:11px}.team-settings summary{cursor:pointer}.team-settings label{grid-template-columns:1fr 90px;align-items:center;margin-top:7px}.team-settings input{min-height:30px}.team-settings small{display:block;margin-top:7px;color:#8199ad}.compat-note{padding:9px;border-radius:8px;background:rgba(176,135,71,.1);color:#d8bc8d}.form-error{margin:0;color:#f2a9b4;font-size:11px}.editor-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:auto}.save-button{border:0;color:#092332;background:linear-gradient(120deg,#81e9ce,#70c9e7);font-weight:800}.save-button:hover,.quiet-button:hover{filter:brightness(1.08)}@media(max-width:900px){.editor-layout{grid-template-columns:minmax(0,1fr) 280px}}@media(max-width:720px){.editor-shell{padding:12px}.editor-head{align-items:center}.editor-head p:last-child{max-width:42ch}.editor-layout{display:flex;height:auto;min-height:0;flex-direction:column}.board-workspace{height:min(58vh,560px);min-height:320px}.editor-tools{width:auto;max-height:none}.terrain-picker{max-height:160px}}@media(max-width:480px){.editor-head{align-items:flex-start}.editor-head>button{padding:8px;font-size:10px}.board-workspace{min-height:280px}.editor-board{padding:4px}}
.board-workspace{touch-action:none;cursor:grab}.editor-board{transform-origin:center center;transition:transform .04s linear}
</style>
