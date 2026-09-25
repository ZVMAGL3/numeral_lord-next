<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MapDefinition } from "@numeral-lord/core-content";
import { getPoweredUnitIds, fromCellId, type CellId } from "@numeral-lord/game-core";
import { createMatchFromMapDefinition } from "@numeral-lord/core-content";
import HexBoard from "./HexBoard.vue";
import MapEditorToolbar from "./MapEditorToolbar.vue";
import { getMapCellRangeIndices } from "./map-cell-range";
import { installedMapCatalogs, installedTerrainMods } from "../installed-content";

const props = defineProps<{ initial?: MapDefinition | null }>();
const emit = defineEmits<{ save: [definition: MapDefinition]; draft: [definition: MapDefinition]; cancel: [] }>();
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
const widthInput = ref(String(width.value)), heightInput = ref(String(height.value));
const players = ref(props.initial?.players ?? 2), name = ref(props.initial?.name ?? "新地图");
const playersInput = ref(String(players.value));
const terrain = ref<string[]>([]), soldiers = ref<Array<{ index: number; seat: number; strength: number }>>([]);
const specialUnits = ref<Array<{ index: number; kind: "wild" | "blocker"; strength: number }>>([]), teams = ref<number[]>([]);
const selectedTerrain = ref("core/plain"), placementMode = ref<"terrain" | "unit" | "erase">("terrain");
const unitKind = ref<"player" | "wild" | "blocker">("player"), selectedSeat = ref(1), strength = ref(1);
const fillRadius = ref(0);
const unitPreset = computed<string>({
  get: () => unitKind.value === "player" ? `player:${selectedSeat.value}` : unitKind.value,
  set: (value) => {
    if (value === "wild" || value === "blocker") {
      unitKind.value = value;
      return;
    }
    const seat = Number(value.slice("player:".length));
    if (Number.isInteger(seat) && seat >= 1 && seat <= players.value) {
      unitKind.value = "player";
      selectedSeat.value = seat;
    }
  }
});
const settingsOpen = ref(false);
const formError = ref(""), terrainLookup = computed(() => new Map(terrainOptions.value.map((entry) => [entry.id, entry])));
const editorZoom = ref(1), editorPan = ref({ x: 0, y: 0 });
const editorPointers = new Map<number, { x: number; y: number }>();
let editorDrag: { x: number; y: number; panX: number; panY: number } | undefined;
let editorPinch: { distance: number; zoom: number; x: number; y: number; panX: number; panY: number } | undefined;
let editorDraggingAt = 0;
let editorAltPainting = false;
let lastAltPaintIndex = -1;

function resetFromDefinition(definition?: MapDefinition | null): void {
  width.value = definition?.columns ?? 9; height.value = definition ? definition.terrain.length / definition.columns : 9;
  widthInput.value = String(width.value); heightInput.value = String(height.value);
  players.value = definition?.players ?? 2; playersInput.value = String(players.value); name.value = definition?.name ?? "新地图";
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
}, { flush: "sync" });
function applyBoardSize(): void {
  const nextWidth = Math.max(1, Math.min(64, Math.trunc(Number(widthInput.value) || 1)));
  const nextHeight = Math.max(1, Math.min(64, Math.floor(4096 / nextWidth), Math.trunc(Number(heightInput.value) || 1)));
  widthInput.value = String(nextWidth);
  heightInput.value = String(nextHeight);
  width.value = nextWidth;
  height.value = nextHeight;
}
function applyPlayerCount(): void {
  const next = Math.max(1, Math.min(64, Math.trunc(Number(playersInput.value) || 1)));
  playersInput.value = String(next);
  players.value = next;
}
const previewDefinition = computed<MapDefinition>(() => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const legend: Record<string, string> = {}, terrainSymbols = new Map<string, string>();
  const terrainCode = terrain.value.map((terrainId) => {
    let symbol = terrainSymbols.get(terrainId);
    if (!symbol) {
      symbol = alphabet[terrainSymbols.size] ?? "A";
      terrainSymbols.set(terrainId, symbol);
      legend[symbol] = terrainId;
    }
    return symbol;
  }).join("");
  return {
    version: 1,
    id: props.initial?.id ?? "map-editor-preview",
    name: name.value || "地图预览",
    columns: width.value,
    terrain: terrainCode,
    terrainLegend: legend,
    requiredTerrainModIds: [...new Set(terrain.value.map((terrainId) => terrainLookup.value.get(terrainId)?.modId).filter((id): id is string => Boolean(id)))],
    ...(props.initial?.modSettings ? { modSettings: props.initial.modSettings } : {}),
    ...(props.initial?.cellLinks ? { cellLinks: props.initial.cellLinks } : {}),
    players: players.value,
    soldiers: soldiers.value.map(({ index, seat, strength }) => [index, seat, strength] as const),
    ...(specialUnits.value.length ? { specialUnits: specialUnits.value.map(({ index, kind, strength }) => [index, kind, strength] as const) } : {}),
    teams: Array.from({ length: players.value }, (_, index) => {
      const team = Number(teams.value[index]);
      return Number.isInteger(team) && team >= 1 && team <= 64 ? team : index + 1;
    }),
    matchConditionIds: []
  };
});
const previewState = computed(() => createMatchFromMapDefinition(previewDefinition.value, installedMapCatalogs));
const previewPoweredUnitIds = computed(() => [...getPoweredUnitIds(previewState.value, installedMapCatalogs.terrains)]);
watch(previewDefinition, (definition) => emit("draft", definition), { immediate: true });

function paintCellId(cellId: CellId): void {
  const { column, row } = fromCellId(cellId);
  const index = row * width.value + column;
  if (index >= 0 && index < terrain.value.length) paintCell(index);
}
function paintCell(index: number): void {
  if (!editorAltPainting && performance.now() - editorDraggingAt < 220) return;
  for (const target of indexesInRange(index, fillRadius.value)) paintOneCell(target);
}
function paintOneCell(index: number): void {
  if (placementMode.value === "terrain") {
    terrain.value[index] = selectedTerrain.value;
    if (terrainLookup.value.get(selectedTerrain.value)?.blocked) {
      soldiers.value = soldiers.value.filter((u) => u.index !== index);
      specialUnits.value = specialUnits.value.filter((u) => u.index !== index);
    }
    return;
  }
  if (placementMode.value === "erase") {
    soldiers.value = soldiers.value.filter((u) => u.index !== index);
    specialUnits.value = specialUnits.value.filter((u) => u.index !== index);
    return;
  }
  if (terrainLookup.value.get(terrain.value[index]!)?.blocked) return;
  if (unitKind.value === "player") {
    specialUnits.value = specialUnits.value.filter((u) => u.index !== index);
    const current = soldiers.value.find((u) => u.index === index);
    if (current) Object.assign(current, { seat: selectedSeat.value, strength: strength.value });
    else soldiers.value.push({ index, seat: selectedSeat.value, strength: strength.value });
  } else {
    soldiers.value = soldiers.value.filter((u) => u.index !== index);
    specialUnits.value = specialUnits.value.filter((u) => u.index !== index);
    specialUnits.value.push({ index, kind: unitKind.value, strength: strength.value });
  }
}
function indexesInRange(centerIndex: number, radius: number): number[] {
  return getMapCellRangeIndices(centerIndex, width.value, terrain.value.length, radius);
}
function onCellPressStart(cellId: CellId): void {
  if (!editorAltPainting) return;
  const { column, row } = fromCellId(cellId);
  const index = row * width.value + column;
  if (index < 0 || index >= terrain.value.length) return;
  lastAltPaintIndex = index;
  paintCell(index);
}
function onCellPointerEnter(cellId: CellId): void {
  if (!editorAltPainting) return;
  const { column, row } = fromCellId(cellId);
  const index = row * width.value + column;
  if (index < 0 || index >= terrain.value.length || index === lastAltPaintIndex) return;
  lastAltPaintIndex = index;
  editorDraggingAt = performance.now();
  paintCell(index);
}
function onEditorPointerDown(event: PointerEvent): void {
  if (event.altKey) {
    editorAltPainting = true;
    lastAltPaintIndex = -1;
    editorDraggingAt = performance.now();
    // Keep pointer events targeted at the Pixi canvas so its hex hit-testing
    // continues to report cells while Alt-dragging; only listen globally for release.
    window.addEventListener("pointerup", onEditorPointerUp, { once: true });
    window.addEventListener("pointercancel", onEditorPointerUp, { once: true });
    return;
  }
  editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  // Leave pointer ownership with the Pixi canvas as well so its cell tap can
  // be delivered while this wrapper tracks pan and pinch gestures.
  if (editorPointers.size === 1) editorDrag = { x: event.clientX, y: event.clientY, panX: editorPan.value.x, panY: editorPan.value.y };
  else if (editorPointers.size === 2) {
    const [a, b] = [...editorPointers.values()];
    if (a && b) editorPinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: editorZoom.value,
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, panX: editorPan.value.x, panY: editorPan.value.y };
    editorDrag = undefined;
  }
}
function onEditorPointerMove(event: PointerEvent): void {
  if (editorAltPainting) {
    editorDraggingAt = performance.now();
    return;
  }
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
  window.removeEventListener("pointerup", onEditorPointerUp);
  window.removeEventListener("pointercancel", onEditorPointerUp);
  if (editorAltPainting) {
    editorAltPainting = false;
    lastAltPaintIndex = -1;
    return;
  }
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
      teams: Array.from({ length: players.value }, (_, index) => {
        const team = Number(teams.value[index]);
        return Number.isInteger(team) && team >= 1 && team <= 64 ? team : index + 1;
      }), matchConditionIds: props.initial?.matchConditionIds ?? ["core/lose-all-survival-anchors", "core/last-team-standing"]
    };
    emit("save", definition);
  } catch (error) { formError.value = error instanceof Error ? error.message : "地图无法保存。"; }
}
function createId(): string { return typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
</script>

<template>
  <section class="editor-shell">
    <header class="editor-head"><div class="editor-title"><p class="eyebrow">MAP EDITOR</p><h2>{{ initial ? '编辑地图' : '创建地图' }}</h2></div><div class="editor-head-actions"><button class="quiet-button" @click="settingsOpen = !settingsOpen">⚙ <span>地图设置</span></button><button class="quiet-button" @click="emit('cancel')">返回地图库</button><button class="save-button" @click="saveMap">保存地图</button></div></header>
    <div class="editor-layout">
      <div class="board-workspace" @pointerdown="onEditorPointerDown" @pointermove="onEditorPointerMove" @pointerup="onEditorPointerUp" @pointercancel="onEditorPointerUp" @wheel.prevent="onEditorWheel">
        <div class="editor-board">
          <HexBoard preview editable :view-zoom="editorZoom" :view-pan="editorPan" :state="previewState" :selected-unit-id="null" :legal-action-cell-ids="[]" :actionable-unit-ids="[]" :powered-unit-ids="previewPoweredUnitIds" @cell-click="paintCellId" @cell-pointer-enter="onCellPointerEnter" @cell-press-start="onCellPressStart" />
        </div>
        <div class="board-caption">{{ width }} × {{ height }} 格 <span>·</span> {{ soldiers.length + specialUnits.length }} 个初始单位 <span>·</span> 点击绘制，按住 Alt 拖动批量绘制</div>
      </div>
      <MapEditorToolbar v-model:mode="placementMode" v-model:selected-terrain="selectedTerrain" v-model:unit-preset="unitPreset" v-model:strength="strength" v-model:fill-radius="fillRadius" :terrain-options="terrainOptions" :player-count="players" />
      <aside v-if="settingsOpen" class="editor-settings" role="dialog" aria-label="地图设置">
        <div class="side-title"><span>地图设置</span><button class="settings-close" aria-label="关闭设置" @click="settingsOpen = false">×</button></div>
        <label>地图名称<input v-model="name" maxlength="60" /></label>
        <div class="form-grid"><label>宽度<input v-model="widthInput" type="number" min="1" max="64" @change="applyBoardSize" /></label><label>高度<input v-model="heightInput" type="number" min="1" max="64" @change="applyBoardSize" /></label></div>
        <details class="advanced-settings" open><summary>对局规则 <small>{{ players }} 位玩家 · 初始 {{ strength }} 点</small></summary><div class="form-grid"><label>玩家位<input v-model="playersInput" type="number" min="1" max="64" @change="applyPlayerCount" /></label><label>初始点数<input v-model.number="strength" type="number" min="1" max="65535" @change="strength = Math.max(1, Math.min(65535, Math.trunc(strength || 1)))" /></label></div><div class="team-settings"><label v-for="(_, index) in teams" :key="index">玩家 {{ index + 1 }}<input v-model.number="teams[index]" type="number" min="1" max="64" /></label><small>相同队伍号表示同队。</small></div><p class="compat-note">阻挡不反击；野怪会反击，次数取决于所在地皮。</p></details>
      </aside>
      <p v-if="formError" class="form-error editor-error" role="alert">{{ formError }}</p>
    </div>
  </section>
</template>

<style scoped>
.editor-shell{--ink:#e8f2f9;min-height:min(82vh,900px);padding:clamp(14px,2vw,24px);border:1px solid rgba(134,177,205,.27);border-radius:20px;background:#101723;color:var(--ink);overflow:hidden}.editor-head{position:relative;z-index:2;display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:12px}.eyebrow{margin:0 0 4px;color:#7de6d3;font-size:10px;font-weight:900;letter-spacing:.18em}.editor-head h2{margin:0;font-size:clamp(24px,3vw,34px)}.editor-head p:last-child{margin:5px 0 0;color:#8ba2b9;font-size:11px}.quiet-button,.save-button{width:auto;margin:0;padding:9px 13px;border:1px solid rgba(143,188,206,.32);border-radius:9px;color:#cde6f1;background:rgba(18,47,65,.76);white-space:nowrap}.editor-layout{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:14px;min-height:650px;height:min(74vh,800px)}.board-workspace{position:relative;display:grid;place-items:center;min-width:0;min-height:0;overflow:hidden;border-radius:13px;background-color:#0b111b;background-image:radial-gradient(ellipse at center,rgba(38,60,83,.45),transparent 70%),repeating-linear-gradient(0deg,transparent 0 17px,rgba(124,152,178,.028) 18px 19px)}.editor-board{position:absolute;inset:0;width:100%;height:100%;transform-origin:center center;transition:transform .04s linear}.board-caption{position:absolute;left:15px;bottom:12px;color:#90a8bd;font-size:10px;pointer-events:none}.board-caption span{padding:0 4px;color:#536a80}.editor-tools{display:flex;flex-direction:column;gap:11px;min-width:0;max-height:100%;overflow:auto;padding:14px;border:1px solid rgba(135,175,202,.24);border-radius:14px;background:rgba(10,22,35,.94)}.side-title{display:flex;justify-content:space-between;color:#e7f3fa;font-size:14px;font-weight:800}.side-title small{color:#6698b5;font-size:9px;letter-spacing:.12em}.editor-tools label{display:grid;gap:5px;color:#a9c1d2;font-size:10px}.editor-tools input,.editor-tools select{box-sizing:border-box;width:100%;min-height:36px;padding:7px;border:1px solid rgba(136,177,204,.31);border-radius:8px;background:#0c1b2b;color:#d6e8f0}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.tool-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.tool-tabs button{margin:0;padding:8px 4px;color:#a9bdcf;background:#152b3d;font-size:10px}.tool-tabs button.active{border-color:#78dfd0;color:#cdf7ef;background:#22545b}.terrain-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:190px;overflow:auto}.terrain-picker button{display:flex;align-items:center;gap:7px;margin:0;padding:7px;border:1px solid rgba(128,172,195,.2);border-radius:8px;color:#dbe9f2;background:rgba(32,59,77,.38);font-size:10px;text-align:left}.terrain-picker button.active{border-color:#74dfcf}.terrain-picker i{width:18px;height:18px;flex:none;border:1px solid rgba(255,255,255,.2);border-radius:50%}.terrain-picker small{margin-left:auto;color:#82bdbb}.unit-tools{display:grid;gap:9px}.unit-tools p,.compat-note{margin:0;color:#8fa9bc;font-size:10px;line-height:1.55}.team-settings{padding-top:8px;border-top:1px solid rgba(140,180,202,.15);color:#dcebf4;font-size:11px}.team-settings summary{cursor:pointer}.team-settings label{grid-template-columns:1fr 90px;align-items:center;margin-top:7px}.team-settings input{min-height:30px}.team-settings small{display:block;margin-top:7px;color:#8199ad}.compat-note{padding:9px;border-radius:8px;background:rgba(176,135,71,.1);color:#d8bc8d}.form-error{margin:0;color:#f2a9b4;font-size:11px}.editor-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:auto}.save-button{border:0;color:#092332;background:linear-gradient(120deg,#81e9ce,#70c9e7);font-weight:800}.save-button:hover,.quiet-button:hover{filter:brightness(1.08)}@media(max-width:900px){.editor-layout{grid-template-columns:minmax(0,1fr) 280px}}@media(max-width:720px){.editor-shell{padding:12px}.editor-head{align-items:center}.editor-head p:last-child{max-width:42ch}.editor-layout{display:flex;height:auto;min-height:0;flex-direction:column}.board-workspace{height:min(58vh,560px);min-height:320px}.editor-tools{width:auto;max-height:none}.terrain-picker{max-height:160px}}@media(max-width:480px){.editor-head{align-items:flex-start}.editor-head>button{padding:8px;font-size:10px}.board-workspace{min-height:280px}}
.board-workspace{touch-action:none;cursor:grab}.board-workspace:active{cursor:grabbing}.editor-board :deep(.board-canvas){width:100%;height:100%;min-height:0;background:transparent}.editor-board :deep(canvas){width:100%;height:100%}
.editor-shell{position:fixed;z-index:20;inset:0;width:100vw;height:100dvh;box-sizing:border-box;min-height:0;padding:0;border:0;border-radius:0;background:#080d16;overflow:hidden}.editor-head{position:absolute;z-index:3;top:12px;left:16px;right:16px;align-items:center;margin:0;pointer-events:none}.editor-head>div{pointer-events:none}.editor-head h2{font-size:clamp(20px,2.5vw,29px);text-shadow:0 2px 12px #080d16}.editor-head p:last-child{display:none}.editor-head>button{pointer-events:auto}.editor-layout{position:absolute;inset:0;display:block;width:100%;height:100%;min-height:0}.board-workspace{position:absolute;inset:0;display:block;border-radius:0;background-color:#080d16;background-image:radial-gradient(ellipse at center,rgba(23,39,58,.48),transparent 70%),url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='32' viewBox='0 0 42 32'%3E%3Cpath d='M1 8q4-4 8 0t8 0m3 0q4-4 8 0t8 0M-8 24q4-4 8 0t8 0m3 0q4-4 8 0t8 0m3 0q4-4 8 0t8 0' fill='none' stroke='%23233145' stroke-width='3'/%3E%3C/svg%3E")}.editor-board{inset:0 clamp(230px,24vw,290px) 0 0;width:auto;height:auto}.editor-tools{position:absolute;z-index:2;top:68px;right:12px;bottom:12px;width:clamp(230px,24vw,290px);max-height:none;box-sizing:border-box;background:rgba(7,18,31,.94);box-shadow:0 12px 38px rgba(0,0,0,.3);backdrop-filter:blur(12px)}.board-caption{z-index:1;bottom:12px;left:16px;padding:5px 9px;border:1px solid rgba(135,175,202,.16);border-radius:8px;background:rgba(7,18,31,.72)}.editor-board :deep(.board-canvas){border:0;border-radius:0;background:transparent}
@media(max-width:720px){.editor-head{top:8px;left:10px;right:10px}.editor-head h2{font-size:19px}.editor-head>button{padding:7px 9px;font-size:10px}.editor-board{inset:48px 0 38vh;width:auto;height:auto}.editor-tools{top:auto;right:8px;bottom:8px;left:8px;width:auto;max-height:36vh;padding:10px}.board-workspace{background-position:center,center center}.board-caption{bottom:calc(36vh + 11px);left:8px;font-size:9px}}
.board-workspace{height:auto;min-height:0}
.editor-tools{top:68px;bottom:auto;max-height:calc(100dvh - 84px);gap:9px;padding:12px}.side-title{font-size:13px}.side-title small{font-size:10px;font-weight:600;letter-spacing:0;color:#8aa5ba}.editor-tools label{gap:4px}.editor-tools input,.editor-tools select{min-height:34px;padding:6px 8px}.form-grid{gap:7px}.tool-tabs{gap:5px}.tool-tabs button{min-height:34px;padding:6px 4px}.terrain-picker{max-height:min(28dvh,220px);gap:5px}.terrain-picker button{min-height:34px;padding:5px 7px}.terrain-picker i{width:16px;height:16px}.advanced-settings{padding-top:8px;border-top:1px solid rgba(140,180,202,.15);color:#dcebf4;font-size:11px}.advanced-settings>summary{display:flex;justify-content:space-between;gap:8px;cursor:pointer;list-style:disclosure-closed}.advanced-settings[open]>summary{margin-bottom:8px;list-style:disclosure-open}.advanced-settings>summary small{color:#8099ad;font-size:10px}.advanced-settings .team-settings{margin-top:8px}.advanced-settings .compat-note{margin-top:8px;padding:7px;font-size:9px}.editor-actions{margin-top:2px}.editor-actions .quiet-button,.editor-actions .save-button{padding:8px 11px;font-size:11px}
@media(max-width:720px){.editor-tools{top:auto;bottom:8px;left:8px;right:8px;max-height:min(62dvh,560px);padding:10px}.terrain-picker{max-height:min(22dvh,170px)}.editor-actions{position:sticky;bottom:-10px;padding-top:7px;padding-bottom:2px;background:rgba(7,18,31,.96)}}
.editor-head{pointer-events:none}.editor-title,.editor-head-actions{pointer-events:auto}.editor-head-actions{display:flex;align-items:center;gap:7px}.editor-head-actions .quiet-button,.editor-head-actions .save-button{padding:8px 11px;font-size:11px}.editor-head-actions .quiet-button:first-child{font-size:14px}.editor-head-actions .quiet-button:first-child span{font-size:11px}
.editor-board{inset:68px clamp(230px,24vw,290px) 72px 0;width:auto;height:auto}.editor-settings label{display:grid;gap:4px;color:#a9c1d2;font-size:10px}.editor-settings input,.editor-settings select{box-sizing:border-box;width:100%;min-height:34px;padding:6px 8px;border:1px solid rgba(136,177,204,.31);border-radius:8px;background:#0c1b2b;color:#d6e8f0}.editor-settings .form-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.editor-settings .advanced-settings{padding-top:8px;border-top:1px solid rgba(140,180,202,.15)}.editor-settings .advanced-settings>summary{cursor:pointer}.editor-settings .team-settings{padding-top:8px;border-top:1px solid rgba(140,180,202,.15)}.editor-settings .compat-note{margin:0;padding:7px;border-radius:8px;background:rgba(176,135,71,.1);color:#d8bc8d;font-size:9px;line-height:1.45}
.editor-tools{position:absolute;z-index:3;top:auto;right:auto;bottom:clamp(12px,2.4vh,28px);left:50%;display:flex;flex-direction:row;align-items:center;gap:7px;width:max-content;max-width:calc(100vw - 24px);max-height:none;overflow:visible;padding:8px;border:1px solid rgba(143,188,206,.25);border-radius:12px;background:rgba(7,13,23,.92);box-shadow:0 10px 34px rgba(0,0,0,.38);backdrop-filter:blur(12px);transform:translateX(-50%)}.tool-tabs{display:flex;flex:none;gap:4px;padding-right:6px;border-right:1px solid rgba(143,188,206,.17)}.tool-tabs button{min-width:54px;min-height:36px;padding:6px 8px}.tool-tabs button:last-child{min-width:42px;font-size:19px;line-height:1}.tool-tabs button small{display:block;font-size:8px;line-height:1}.terrain-choice{display:flex;align-items:center;gap:6px}.terrain-choice i{width:21px;height:21px;flex:none;border:1px solid rgba(255,255,255,.3);border-radius:50%}.editor-tools>select,.terrain-choice select{width:auto;min-width:96px;max-width:150px;min-height:36px;padding:6px 24px 6px 8px}.editor-tools>select[aria-label="单位类型"]{min-width:132px}.editor-tools>select[aria-label="所属玩家"]{min-width:84px}.strength-control{display:flex;align-items:center;gap:3px;margin-left:2px;padding-left:7px;border-left:1px solid rgba(143,188,206,.17)}.strength-control button{width:34px;height:36px;margin:0;padding:0;color:#e7f4fb;background:#152b3d;font-size:20px;line-height:1}.strength-control input{width:42px;min-height:36px;padding:4px;text-align:center;font-weight:800}.strength-control small{color:#95aec0;font-size:9px}.editor-settings{position:absolute;z-index:4;top:64px;right:12px;display:flex;flex-direction:column;gap:10px;width:min(290px,calc(100vw - 24px));max-height:calc(100dvh - 82px);box-sizing:border-box;overflow:auto;padding:14px;border:1px solid rgba(135,175,202,.26);border-radius:13px;background:rgba(7,18,31,.96);box-shadow:0 14px 40px rgba(0,0,0,.4);backdrop-filter:blur(14px)}.editor-settings .side-title{align-items:center}.settings-close{width:28px;height:28px;margin:0;padding:0;color:#cde6f1;background:rgba(18,47,65,.76);font-size:20px}.editor-settings .advanced-settings{display:grid;gap:8px}.editor-settings .team-settings{display:grid;grid-template-columns:1fr 1fr;gap:6px}.editor-settings .team-settings label{grid-template-columns:1fr 54px;gap:5px;margin:0}.editor-settings .team-settings input{min-height:30px}.editor-settings .team-settings small{grid-column:1/-1}.editor-error{position:absolute;z-index:5;right:12px;bottom:70px;max-width:min(340px,calc(100vw - 24px));padding:9px 12px;border:1px solid rgba(238,142,160,.32);border-radius:9px;background:rgba(47,19,32,.94)}.board-caption{bottom:clamp(68px,11vh,104px)}
@media(max-width:720px){.editor-head{top:8px;left:10px;right:10px}.editor-head h2{font-size:19px}.editor-head-actions{gap:4px}.editor-head-actions .quiet-button,.editor-head-actions .save-button{padding:7px 8px;font-size:9px}.editor-head-actions .quiet-button:first-child{font-size:12px}.editor-head-actions .quiet-button:first-child span{font-size:9px}.editor-board{inset:48px 0 112px;width:auto;height:auto}.editor-tools{right:8px;bottom:8px;left:8px;flex-wrap:wrap;justify-content:center;width:auto;max-width:none;gap:5px;padding:6px;transform:none}.tool-tabs{gap:3px;padding-right:4px}.tool-tabs button{min-width:44px;min-height:33px;padding:5px}.tool-tabs button:last-child{min-width:36px}.terrain-choice{gap:4px}.terrain-choice i{width:17px;height:17px}.editor-tools>select,.terrain-choice select{min-width:80px;max-width:116px;min-height:33px;padding:5px 19px 5px 6px;font-size:10px}.editor-tools>select[aria-label="单位类型"]{min-width:110px;max-width:130px}.editor-tools>select[aria-label="所属玩家"]{min-width:74px;max-width:85px}.strength-control{gap:2px;padding-left:4px}.strength-control button{width:28px;height:33px;font-size:17px}.strength-control input{width:34px;min-height:33px}.strength-control small{display:none}.editor-settings{top:52px;right:8px;max-height:calc(100dvh - 65px);padding:11px}.board-caption{bottom:94px;left:8px;font-size:9px}.editor-error{bottom:90px;right:8px}}
.editor-head>div.editor-head-actions{pointer-events:auto}.editor-board{isolation:isolate}
.board-workspace{background:#10141d!important;background-image:none!important}.editor-board :deep(.board-canvas),.editor-board :deep(canvas:not(.unit-label-layer)){background:#10141d!important}.editor-board :deep(canvas.unit-label-layer){background:transparent!important}
.toolbar-choice{position:relative;display:flex;align-items:center}.choice-trigger{display:flex;align-items:center;justify-content:space-between;gap:9px;min-width:100px;height:36px;margin:0;padding:5px 9px;border:1px solid rgba(143,188,206,.25);border-radius:7px;color:#e4edf4;background:#090d13;font-size:12px;white-space:nowrap}.choice-trigger i,.choice-popover i{width:18px;height:18px;flex:none;border:1px solid rgba(255,255,255,.28);border-radius:50%}.choice-trigger span{color:#91a8b7;font-size:14px}.choice-popover{position:absolute;z-index:10;bottom:calc(100% + 9px);left:0;display:grid;gap:3px;width:190px;max-height:min(44dvh,340px);box-sizing:border-box;overflow:auto;padding:6px;border:1px solid rgba(143,188,206,.28);border-radius:9px;background:#0a121d;box-shadow:0 12px 32px rgba(0,0,0,.55)}.choice-popover button{display:flex;align-items:center;gap:9px;min-height:33px;margin:0;padding:5px 8px;border:0;border-radius:5px;color:#dbe8f0;background:transparent;text-align:left;font-size:11px}.choice-popover button:hover,.choice-popover button[aria-selected="true"]{background:#17364a;color:#fff}.choice-popover small{margin-left:auto;color:#80c9c5;font-size:9px}.choice-popover .choice-group-title{padding:5px 8px 3px;color:#83a0b5;font-size:9px;font-weight:800}.unit-choice .choice-trigger{min-width:110px}.erase-button{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:42px;height:36px;margin:0;padding:1px 5px;border:1px solid rgba(143,188,206,.22);border-radius:7px;color:#d9e6ef;background:#101923;font-size:18px;line-height:1}.erase-button small{font-size:8px;line-height:1.2}.erase-button.active{border-color:#f07883;color:#ffc3ca;background:#492631}
@media(max-width:720px){.choice-trigger{min-width:84px;height:33px;padding:4px 6px;font-size:10px}.choice-trigger i,.choice-popover i{width:16px;height:16px}.choice-popover{width:min(190px,calc(100vw - 24px));max-height:min(38dvh,280px)}.unit-choice .choice-trigger{min-width:92px}.erase-button{min-width:35px;height:33px}.erase-button small{font-size:7px}}
</style>
