<script lang="ts">
import type { TerrainModDefinition } from "@numeral-lord/content-schema";

export interface TerrainModEntry {
  /** Workshop publication ID; may differ from the package ID. */
  readonly id: string;
  readonly modId?: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly terrainIds: readonly string[];
  readonly installed: boolean;
  readonly author?: string;
  readonly authorName?: string;
  readonly createdAt?: string;
  readonly readme?: string;
  readonly definition?: TerrainModDefinition;
  readonly previewImageUrl?: string;
}

export interface MapWorkshopEntry {
  readonly id: string;
  readonly name: string;
  /** Present after loading detail; list responses may contain metadata only. */
  readonly code?: string;
  readonly description: string;
  readonly author?: string;
  readonly authorName?: string;
  readonly createdAt?: string;
  /** Map ID embedded in code; entry id may be a workshop publication ID. */
  readonly mapId?: string;
  readonly players?: number;
  readonly version?: string;
  /** Package IDs in addition to dependencies inferred from terrainLegend. */
  readonly requiredTerrainModIds?: readonly string[];
}

export interface TerrainModSubmission {
  readonly name: string;
  readonly description: string;
  readonly definition: TerrainModDefinition;
}

export interface MapSubmission {
  readonly code: string;
  readonly description: string;
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getPoweredUnitIds, type GameState } from "@numeral-lord/game-core";
import { createMatchFromMapCode, parseMapCode } from "@numeral-lord/core-content";
import { installedMapCatalogs, installedTerrainCatalog } from "../installed-content";
import HexBoard from "./HexBoard.vue";
import TerrainModPreview from "./TerrainModPreview.vue";

const props = withDefaults(defineProps<{
  terrainMods: readonly TerrainModEntry[];
  mapEntries: readonly MapWorkshopEntry[];
  savedMapIds: readonly string[];
  actionMessage?: string;
  actionError?: boolean;
  working?: boolean;
  /** Public staging can browse community work without anonymous publishing. */
  publishingEnabled?: boolean;
}>(), {
  actionMessage: "",
  actionError: false,
  working: false,
  publishingEnabled: true
});

const emit = defineEmits<{
  back: [];
  "select-map": [id: string];
  "select-terrain-mod": [id: string];
  "save-map": [code: string];
  "publish-map": [entry: MapSubmission];
  "publish-terrain-mod": [entry: TerrainModSubmission];
  "install-terrain-mod": [definition: TerrainModDefinition];
}>();

type Category = "terrain" | "maps";
type ViewMode = "browse" | "detail" | "publish";
const category = ref<Category>("terrain");
const viewMode = ref<ViewMode>("browse");
const selectedTerrainId = ref("");
const selectedMapId = ref("");
const showMapCode = ref(false);
const copyMessage = ref("");
const codeField = ref<HTMLTextAreaElement | null>(null);
const publishMapCode = ref("");
const publishMapDescription = ref("");
const publishTerrainName = ref("");
const publishTerrainDescription = ref("");
const publishModId = ref("mod-my-terrain");
const publishModVersion = ref("1.0.0");
const publishTerrainId = ref("mod/my-terrain");
const publishTerrainDisplayName = ref("我的地块");
const selectedCapabilities = ref<string[]>(["core/occupiable"]);
const incomeAmount = ref(2);
const departureGarrisonStrength = ref(1);
const maxCounterattacks = ref(0);
const publishSpatialPatterns = ref(JSON.stringify([{
  id: "mod-my-terrain/conductive-network",
  role: "core/powered-units",
  result: { entity: "unit", distinctBy: "id" },
  starts: {
    op: "all",
    items: [
      { op: "terrain-has", capabilityId: "core/power-source" },
      { op: "unit-owner-is", owner: "actor" }
    ]
  },
  expression: {
    op: "repeat",
    min: 0,
    max: 128,
    item: {
      op: "step",
      relation: "hex-neighbor",
      where: {
        op: "all",
        items: [
          { op: "terrain-has", capabilityId: "core/power-conductor" },
          { op: "unit-owner-is", owner: "actor" }
        ]
      }
    }
  }
}], null, 2));
const publishRules = ref(JSON.stringify([{
  id: "mod-my-terrain/oilfield-income-on-enter",
  trigger: "unit-enter",
  target: { scope: "trigger-unit" },
  conditions: [{ op: "at-cell-matches", predicate: { op: "terrain-has", capabilityId: "core/income-source" } }],
  effects: [{ type: "grant-points", amount: 2 }]
}], null, 2));
const terrainCapabilityOptions = [
  { id: "core/occupiable", label: "可占领", description: "允许单位占领该地块。" },
  { id: "core/power-conductor", label: "传导供电", description: "连接相邻供电单位。" },
  { id: "core/power-source", label: "供电源", description: "作为通电网络的供电起点。" },
  { id: "core/income-source", label: "回合收益", description: "满足驻守条件时提供点数。" },
  { id: "core/exhaust-on-departure", label: "离开时失活", description: "单位离开该地块时失去行动力。" },
  { id: "core/adjacent-hostile-exhaustion", label: "敌方据点压制", description: "受相邻敌方据点影响时失去行动力。" },
  { id: "core/exhaust-unpowered-after-capture", label: "占领后失活", description: "未通电单位占领后失去行动力。" },
  { id: "core/departure-garrison", label: "离开时留兵", description: "单位离开时在原地留下游兵。" },
  { id: "core/counterattack-terrain-limit", label: "反击次数限制", description: "限制该地块每回合可反击次数。" }
];
const generatedTerrainDefinition = computed<TerrainModDefinition>(() => {
  const bindings = selectedCapabilities.value.map((id) => ({
    id,
    ...(id === "core/income-source" ? { config: { amount: incomeAmount.value } } : {}),
    ...(id === "core/departure-garrison" ? { config: { strength: departureGarrisonStrength.value, unitDefinitionId: "core/roamer" } } : {}),
    ...(id === "core/counterattack-terrain-limit" ? { config: { maxPerActionPhase: maxCounterattacks.value } } : {})
  }));
  const registered = selectedCapabilities.value
    .filter((id) => id === "core/income-source" || id === "core/departure-garrison")
    .map((id) => ({
      id,
      target: "terrain" as const,
      defaultConfig: id === "core/income-source" ? { amount: 0 } : { strength: 1, unitDefinitionId: "core/roamer" }
    }));
  const settings = [
    ...(selectedCapabilities.value.includes("core/income-source") ? [{
      id: "incomePerTurn", displayName: "每回合收益", kind: "integer" as const,
      defaultValue: incomeAmount.value, min: 0, max: 20,
      target: { terrainId: publishTerrainId.value.trim(), capabilityId: "core/income-source", configKey: "amount" }
    }] : []),
    ...(selectedCapabilities.value.includes("core/departure-garrison") ? [{
      id: "departureGarrisonStrength", displayName: "离开时留下的兵力", kind: "integer" as const,
      defaultValue: departureGarrisonStrength.value, min: 1, max: 20,
      target: { terrainId: publishTerrainId.value.trim(), capabilityId: "core/departure-garrison", configKey: "strength" }
    }] : []),
    ...(selectedCapabilities.value.includes("core/counterattack-terrain-limit") ? [{
      id: "maxCounterattacks", displayName: "每回合反击次数", kind: "integer" as const,
      defaultValue: maxCounterattacks.value, min: 0, max: 6,
      target: { terrainId: publishTerrainId.value.trim(), capabilityId: "core/counterattack-terrain-limit", configKey: "maxPerActionPhase" }
    }] : [])
  ];
  let spatialPatterns: TerrainModDefinition["spatialPatterns"] = [];
  let rules: TerrainModDefinition["rules"] = [];
  try {
    const parsed = JSON.parse(publishSpatialPatterns.value) as unknown;
    if (Array.isArray(parsed)) spatialPatterns = parsed as NonNullable<TerrainModDefinition["spatialPatterns"]>;
  } catch { /* Form validation reports malformed patterns on submit. */ }
  try {
    const parsed = JSON.parse(publishRules.value) as unknown;
    if (Array.isArray(parsed)) rules = parsed as NonNullable<TerrainModDefinition["rules"]>;
  } catch { /* Form validation reports malformed rules on submit. */ }
  return {
    id: publishModId.value.trim(),
    version: publishModVersion.value.trim(),
    capabilities: registered,
    ...(settings.length ? { settings } : {}),
    ...(spatialPatterns.length ? { spatialPatterns } : {}),
    ...(rules.length ? { rules } : {}),
    terrains: [{ id: publishTerrainId.value.trim(), displayName: publishTerrainDisplayName.value.trim(), capabilities: bindings }]
  };
});
const publishError = ref("");
const downloadMessage = ref("");

const selectedTerrain = computed(() => props.terrainMods.find((entry) => entry.id === selectedTerrainId.value));
const selectedMap = computed(() => props.mapEntries.find((entry) => entry.id === selectedMapId.value));
const selectedDefinitionJson = computed(() => selectedTerrain.value?.definition
  ? JSON.stringify(selectedTerrain.value.definition, null, 2) : "");
watch(() => selectedMap.value?.id, () => {
  showMapCode.value = false;
  copyMessage.value = "";
});

// List replies contain summaries but not map codes. Fetch only the first page
// of thumbnail data up front; opening any later card requests its full detail.
const thumbnailRequested = new Set<string>();
watch(() => props.mapEntries, (entries) => {
  for (const entry of entries.slice(0, 24)) {
    if (!entry.code && !thumbnailRequested.has(entry.id)) {
      thumbnailRequested.add(entry.id);
      emit("select-map", entry.id);
    }
  }
}, { immediate: true });

interface Dependency {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
}

function resolveTerrainMod(id: string): TerrainModEntry | undefined {
  return props.terrainMods.find((entry) => entry.modId === id || entry.id === id || entry.terrainIds.includes(id));
}

function mapDependencies(map: MapWorkshopEntry): Dependency[] {
  const ids = new Set(map.requiredTerrainModIds ?? []);
  // A server-supplied package list is authoritative. The legend only stores
  // terrain IDs, which must not appear as additional package dependencies.
  if (map.requiredTerrainModIds === undefined) {
    try {
      const decoded = JSON.parse(map.code ?? "") as Record<string, unknown>;
      const terrain = typeof decoded.terrain === "string" ? decoded.terrain : "";
      const legend = decoded.terrainLegend;
      if (legend && typeof legend === "object" && !Array.isArray(legend)) {
        for (const symbol of new Set(terrain)) {
          const terrainId = (legend as Record<string, unknown>)[symbol];
          if (typeof terrainId === "string" && !terrainId.startsWith("core/")) ids.add(terrainId);
        }
      }
    } catch { /* Invalid codes remain visible; save-time validation will explain the error. */ }
  }
  const result = new Map<string, Dependency>();
  for (const id of ids) {
    const mod = resolveTerrainMod(id);
    const key = mod?.modId ?? mod?.id ?? id;
    result.set(key, { id: key, name: mod?.name ?? id, installed: mod?.installed ?? false });
  }
  return [...result.values()];
}

const selectedDependencies = computed(() => selectedMap.value ? mapDependencies(selectedMap.value) : []);
const missingDependency = computed(() => selectedDependencies.value.some((entry) => !entry.installed));
const mapIsSaved = computed(() => !!selectedMap.value && props.savedMapIds.includes(selectedMap.value.mapId ?? selectedMap.value.id));

// The detail preview uses the very same Pixi board as the lobby and match.
// An unavailable Mod must not be silently replaced by an invented rule tile.
const previewState = computed<GameState | null>(() => {
  if (!selectedMap.value?.code) return null;
  try { return createMatchFromMapCode(selectedMap.value.code, installedMapCatalogs); }
  catch { return null; }
});
const previewPoweredUnitIds = computed(() => previewState.value
  ? [...getPoweredUnitIds(previewState.value, installedTerrainCatalog)] : []);
const previewDefinition = computed(() => {
  if (!selectedMap.value?.code) return null;
  try { return parseMapCode(selectedMap.value.code, { ...installedMapCatalogs, allowUnknownTerrainMods: true }); }
  catch { return null; }
});

interface ThumbnailCell {
  readonly points: string;
  readonly fill: string;
  readonly unitFill?: string;
}
interface MapThumbnail { readonly viewBox: string; readonly cells: readonly ThumbnailCell[]; }
const thumbnailColors: Record<string, string> = {
  "core/plain": "#63985d", "core/stronghold": "#63985d", "core/ocean": "#2f72c8",
  "core/mountain": "#71809c", "mod/oil-field": "#9a6338"
};
const seatColors = ["#fb7185", "#60a5fa", "#fbbf24", "#a78bfa", "#34d399"];
function hexPoints(x: number, y: number, radius: number): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 30);
    return `${(x + radius * Math.cos(angle)).toFixed(2)},${(y + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(" ");
}
function makeThumbnail(code?: string): MapThumbnail | null {
  if (!code) return null;
  try {
    const map = parseMapCode(code, { ...installedMapCatalogs, allowUnknownTerrainMods: true });
    const radius = 8;
    const pitch = Math.sqrt(3) * radius;
    const rows = map.terrain.length / map.columns;
    const soldiers = new Map(map.soldiers.map(([index, seat]) => [index, seat]));
    const cells: ThumbnailCell[] = [];
    for (let index = 0; index < map.terrain.length; index += 1) {
      const row = Math.floor(index / map.columns);
      const column = index % map.columns;
      const terrainId = map.terrainLegend[map.terrain[index]!];
      if (terrainId === "core/void") continue;
      // Exact odd-row alignment and pointy hexagon geometry from HexBoard.
      const x = 2 + pitch * (column + ((row + 1) % 2) * 0.5) + pitch / 2;
      const y = 2 + radius + 1.5 * radius * row;
      const seat = soldiers.get(index);
      cells.push({
        points: hexPoints(x, y, radius * 0.98),
        fill: (terrainId ? thumbnailColors[terrainId] : undefined) ?? "#8069a2",
        ...(seat ? { unitFill: seatColors[(seat - 1) % seatColors.length] } : {})
      });
    }
    return {
      viewBox: `0 0 ${(pitch * (map.columns + 0.5) + 4).toFixed(2)} ${(2 * radius + 1.5 * radius * (rows - 1) + 4).toFixed(2)}`,
      cells
    };
  } catch { return null; }
}
const mapThumbnails = computed(() => new Map(props.mapEntries.map((entry) => [entry.id, makeThumbnail(entry.code)])));
function selectCategory(next: Category): void {
  category.value = next;
  viewMode.value = "browse";
  publishError.value = "";
  copyMessage.value = "";
}

function openMap(entry: MapWorkshopEntry): void {
  selectedMapId.value = entry.id;
  category.value = "maps";
  viewMode.value = "detail";
  if (!entry.code) emit("select-map", entry.id);
}

function openTerrain(entry: TerrainModEntry): void {
  selectedTerrainId.value = entry.id;
  downloadMessage.value = "";
  category.value = "terrain";
  viewMode.value = "detail";
  if (!entry.definition) emit("select-terrain-mod", entry.id);
}

function openDependency(id: string): void {
  const mod = resolveTerrainMod(id);
  if (mod) openTerrain(mod);
  else selectCategory("terrain");
}

function openPublish(): void {
  if (!props.publishingEnabled) return;
  publishError.value = "";
  viewMode.value = "publish";
}

async function copyMapCode(): Promise<void> {
  if (!selectedMap.value?.code) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(selectedMap.value.code);
    copyMessage.value = "地图码已复制";
  } catch {
    showMapCode.value = true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    codeField.value?.focus();
    codeField.value?.select();
    try {
      if (document.execCommand("copy")) {
        copyMessage.value = "地图码已复制";
        return;
      }
    } catch { /* Keep text selected for manual copying on HTTP. */ }
    copyMessage.value = "已选中地图码，请手动复制";
  }
}

function submitMap(): void {
  const code = publishMapCode.value.trim();
  if (!code) { publishError.value = "请先粘贴地图码。"; return; }
  try {
    const decoded = JSON.parse(code) as Record<string, unknown>;
    if (typeof decoded.id !== "string" || typeof decoded.name !== "string") throw new Error();
  } catch {
    publishError.value = "地图码不是有效的地图 JSON。";
    return;
  }
  publishError.value = "";
  emit("publish-map", { code, description: publishMapDescription.value.trim() });
}

function submitTerrainMod(): void {
  const name = publishTerrainName.value.trim();
  const description = publishTerrainDescription.value.trim();
  if (!name || !publishTerrainDisplayName.value.trim()) { publishError.value = "请填写 Mod 名称和地块名称。"; return; }
  const definition = generatedTerrainDefinition.value;
  if (!definition.id || !definition.version || !definition.terrains[0]?.id) { publishError.value = "请填写 Mod ID、版本和地块 ID。"; return; }
  try {
    const patterns = JSON.parse(publishSpatialPatterns.value) as unknown;
    if (!Array.isArray(patterns)) throw new Error();
    if (patterns.some((pattern) => !pattern || typeof pattern !== "object" || typeof (pattern as { id?: unknown }).id !== "string")) throw new Error();
  } catch {
    publishError.value = "空间算法必须是有效的 JSON 数组；请检查括号、逗号和算法 ID。";
    return;
  }
  try {
    const rules = JSON.parse(publishRules.value) as unknown;
    if (!Array.isArray(rules) || rules.some((rule) => !rule || typeof rule !== "object" || typeof (rule as { id?: unknown }).id !== "string")) throw new Error();
  } catch {
    publishError.value = "触发规则必须是有效的 JSON 数组；请检查括号、逗号和规则 ID。";
    return;
  }
  publishError.value = "";
  emit("publish-terrain-mod", { name, description, definition });
}

function toggleCapability(id: string): void {
  selectedCapabilities.value = selectedCapabilities.value.includes(id)
    ? selectedCapabilities.value.filter((candidate) => candidate !== id)
    : [...selectedCapabilities.value, id];
}

function installSelectedTerrain(): void {
  if (selectedTerrain.value?.definition && !selectedTerrain.value.installed) {
    emit("install-terrain-mod", selectedTerrain.value.definition);
  }
}
</script>

<template>
  <section class="workshop" aria-label="创意工坊">
    <header class="workshop-heading">
      <div>
        <p class="eyebrow">COMMUNITY WORKSHOP</p>
        <h2>创意工坊</h2>
        <p>浏览地图与结构化地块 Mod。订阅并安装的地块 Mod 会保存在本机数据库；每天首次连接工坊时检查新版本。</p>
      </div>
      <button class="back-button" type="button" @click="emit('back')">← 返回主页</button>
    </header>

    <nav class="category-nav" aria-label="创意工坊分类">
      <button type="button" :class="{ active: category === 'terrain' }" :aria-current="category === 'terrain' ? 'page' : undefined" @click="selectCategory('terrain')">
        <span class="category-icon" aria-hidden="true">⬡</span><span><strong>地块 Mod</strong><small>{{ terrainMods.length }} 个扩展</small></span>
      </button>
      <button type="button" :class="{ active: category === 'maps' }" :aria-current="category === 'maps' ? 'page' : undefined" @click="selectCategory('maps')">
        <span class="category-icon" aria-hidden="true">▧</span><span><strong>地图作品</strong><small>{{ mapEntries.length }} 张地图</small></span>
      </button>
    </nav>

    <p v-if="actionMessage" class="action-message" :class="{ error: actionError }" role="status">{{ actionMessage }}</p>

    <div class="workshop-toolbar">
      <div><strong>{{ category === 'terrain' ? '地块扩展' : '地图作品' }}</strong><p>{{ category === 'terrain' ? '查看结构化属性与包含地块。订阅并安装后每日检查版本，由游戏内核执行已支持的能力。' : '地图作品是一段可保存的地图码；开局前需要装齐所依赖的地块 Mod。' }}</p></div>
      <button v-if="publishingEnabled && viewMode === 'browse'" class="outline-button publish-entry" type="button" @click="openPublish">＋ {{ category === 'terrain' ? '发布地块 Mod' : '发布地图作品' }}</button>
      <span v-else-if="!publishingEnabled" class="read-only-note">公网测试版仅开放浏览，暂不接受发布</span>
    </div>

    <div v-if="viewMode === 'browse'" class="workshop-catalog">
      <template v-if="category === 'terrain'">
        <button v-for="entry in terrainMods" :key="entry.id" class="workshop-work-card" type="button" @click="openTerrain(entry)">
          <span class="work-card-preview terrain-card-preview" aria-hidden="true">
            <TerrainModPreview :terrain-ids="entry.terrainIds" :image-url="entry.previewImageUrl" />
          </span>
          <span class="work-card-info"><span class="work-card-title"><strong>{{ entry.name }}</strong><em :class="{ installed: entry.installed }">{{ entry.installed ? '已安装' : '未安装' }}</em></span><span class="work-card-description">{{ entry.description || '暂无作品简介' }}</span><small>{{ entry.authorName || entry.author || '社区作者' }} · {{ entry.terrainIds.length }} 个地块</small></span>
        </button>
        <p v-if="!terrainMods.length" class="empty-list">暂无地块 Mod 作品。</p>
      </template>
      <template v-else>
        <button v-for="entry in mapEntries" :key="entry.id" class="workshop-work-card" type="button" @click="openMap(entry)">
          <span class="work-card-preview map-card-preview" aria-hidden="true">
            <svg v-if="mapThumbnails.get(entry.id)" :viewBox="mapThumbnails.get(entry.id)?.viewBox ?? '0 0 1 1'">
              <g v-for="(cell, index) in mapThumbnails.get(entry.id)?.cells ?? []" :key="index">
                <polygon :points="cell.points" :fill="cell.fill" stroke="#263a4b" stroke-width=".45" />
                <polygon v-if="cell.unitFill" :points="cell.points" :fill="cell.unitFill" fill-opacity=".9" stroke="#d9e5ef" stroke-width=".65" />
              </g>
            </svg>
            <span v-else class="thumbnail-placeholder">地图预览载入中</span>
          </span>
          <span class="work-card-info"><span class="work-card-title"><strong>{{ entry.name }}</strong><em :class="{ installed: savedMapIds.includes(entry.mapId ?? entry.id) }">{{ savedMapIds.includes(entry.mapId ?? entry.id) ? '已保存' : '地图码' }}</em></span><span class="work-card-description">{{ entry.description || '暂无作品简介' }}</span><small>{{ entry.authorName || entry.author || '社区作者' }} · {{ entry.players ?? '?' }} 人地图 · {{ mapDependencies(entry).length }} 个地块依赖</small></span>
        </button>
        <p v-if="!mapEntries.length" class="empty-list">暂无地图作品。</p>
      </template>
    </div>

    <div v-else-if="viewMode === 'detail'" class="detail-stack">
      <button class="catalog-back" type="button" @click="viewMode = 'browse'">← 返回{{ category === 'terrain' ? '地块 Mod' : '地图作品' }}列表</button>
        <article v-if="category === 'terrain' && selectedTerrain" class="detail-card">
          <div class="detail-overline"><span>TERRAIN MOD</span><span>{{ selectedTerrain.modId || selectedTerrain.id }}</span></div>
          <div class="title-row"><div><h3>{{ selectedTerrain.name }}</h3><p>{{ selectedTerrain.authorName || selectedTerrain.author || '社区作者' }} · v{{ selectedTerrain.version }}</p></div><span class="status-pill" :class="{ installed: selectedTerrain.installed }">{{ selectedTerrain.installed ? '已安装' : '未安装' }}</span></div>
          <div class="terrain-detail-preview"><TerrainModPreview large :terrain-ids="selectedTerrain.terrainIds" :image-url="selectedTerrain.previewImageUrl" /></div>
          <p class="description">{{ selectedTerrain.description }}</p>
          <div class="metadata-block"><strong>包含地块</strong><div class="token-list"><code v-for="id in selectedTerrain.terrainIds" :key="id">{{ id }}</code><span v-if="!selectedTerrain.terrainIds.length" class="quiet">未声明地块 ID</span></div></div>
          <p v-if="selectedTerrain.readme" class="readme">{{ selectedTerrain.readme }}</p>
          <div class="metadata-block"><strong>Mod 属性对象</strong><p class="quiet">这些是存入数据库并安装到本机的 JSON 属性；行为由游戏内核中对应的能力处理器执行，不运行上传脚本。</p></div>
          <pre v-if="selectedDefinitionJson" class="definition-preview"><code>{{ selectedDefinitionJson }}</code></pre>
          <p v-else class="source-empty">{{ selectedTerrain.definition === undefined ? '此旧版作品没有结构化属性对象，暂时无法安装；作者可以按新格式重新发布。' : '正在加载作品详情…' }}</p>
          <div class="detail-actions">
            <button class="primary-button" type="button" :disabled="selectedTerrain.installed || !selectedTerrain.definition || working" @click="installSelectedTerrain">{{ selectedTerrain.installed ? '已订阅并安装' : selectedTerrain.definition ? '订阅并安装 Mod' : '需要重新发布' }}</button>
          </div>
          <p v-if="downloadMessage" class="copy-message" role="status">{{ downloadMessage }}</p>
        </article>

        <article v-else-if="category === 'maps' && selectedMap" class="detail-card">
          <div class="detail-overline"><span>MAP WORK</span><span>ID {{ selectedMap.mapId || selectedMap.id }}</span></div>
          <div class="title-row"><div><h3>{{ selectedMap.name }}</h3><p>{{ selectedMap.authorName || selectedMap.author || '社区作者' }}{{ selectedMap.version ? ` · v${selectedMap.version}` : '' }}</p></div><span class="status-pill" :class="{ installed: mapIsSaved }">{{ mapIsSaved ? '已保存' : '可保存' }}</span></div>
          <p v-if="selectedMap.description" class="description">{{ selectedMap.description }}</p>
          <div v-if="previewState" class="map-preview">
            <HexBoard preview :state="previewState" :selected-unit-id="null" :legal-action-cell-ids="[]" :actionable-unit-ids="[]" :powered-unit-ids="previewPoweredUnitIds" />
          </div>
          <div v-else class="preview-unavailable">{{ selectedMap.code ? missingDependency ? '尚未安装所需地块 Mod，无法使用真实棋盘预览。' : '地图格式暂时无法预览，仍可查看地图码。' : '正在加载地图详情与预览…' }}</div>
          <p v-if="previewDefinition" class="preview-caption">{{ previewDefinition.columns }} × {{ previewDefinition.terrain.length / previewDefinition.columns }} 格 · {{ previewDefinition.players }} 个玩家位</p>
          <div class="metadata-block dependency-block"><strong>需要的地块 Mod</strong><div v-if="selectedDependencies.length" class="dependency-list"><span v-for="dependency in selectedDependencies" :key="dependency.id" class="dependency" :class="{ missing: !dependency.installed }"><b>{{ dependency.name }}</b><code>{{ dependency.id }}</code><em>{{ dependency.installed ? '已安装' : '缺失' }}</em></span></div><p v-else class="quiet">仅使用原生地块，无额外地块 Mod 依赖。</p></div>
          <div v-if="missingDependency" class="dependency-warning" role="status">缺少依赖的地块 Mod。可以先保存地图码，但安装依赖前不能开局。<button class="outline-button" type="button" @click="openDependency(selectedDependencies.find((item) => !item.installed)?.id ?? '')">查看所需地块 Mod</button></div>
          <div class="detail-actions">
            <button class="primary-button" type="button" :disabled="mapIsSaved || !selectedMap.code || working" @click="selectedMap.code && emit('save-map', selectedMap.code)">{{ mapIsSaved ? '已在我的地图配置' : missingDependency ? '仅保存地图码（暂不可开局）' : '保存到我的地图配置' }}</button>
            <button class="outline-button" type="button" :disabled="!selectedMap.code" @click="copyMapCode">复制地图码</button>
            <button class="outline-button" type="button" :disabled="!selectedMap.code" @click="showMapCode = !showMapCode">{{ showMapCode ? '收起地图码' : '查看地图码' }}</button>
          </div>
          <p v-if="copyMessage" class="copy-message" role="status">{{ copyMessage }}</p>
          <textarea v-if="showMapCode" ref="codeField" class="code-field map-code" readonly :value="selectedMap.code" aria-label="地图作品地图码" @focus="($event.target as HTMLTextAreaElement).select()" />
        </article>
    </div>

    <div v-else-if="viewMode === 'publish' && publishingEnabled" class="detail-stack">
        <button class="catalog-back" type="button" @click="viewMode = 'browse'">← 返回{{ category === 'terrain' ? '地块 Mod' : '地图作品' }}列表</button>
        <article v-if="category === 'maps'" class="publish-card">
          <div class="section-heading"><strong>发布地图作品</strong><span>分享地图码</span></div>
          <p>地图作品不需要安装。其他玩家保存地图码后，可以在「地图配置」和准备房间中使用。</p>
          <label>地图码<textarea v-model="publishMapCode" class="code-field" spellcheck="false" placeholder="粘贴完整地图码 JSON…" /></label>
          <label>作品说明（可选）<input v-model="publishMapDescription" type="text" maxlength="300" placeholder="介绍玩法、人数或特色" /></label>
          <div class="submit-row"><span v-if="publishError" class="form-error" role="alert">{{ publishError }}</span><button class="primary-button" type="button" :disabled="working" @click="submitMap">发布地图码</button></div>
        </article>

        <article v-else class="publish-card">
          <div class="section-heading"><strong>发布地块 Mod</strong><span>版本化属性对象</span></div>
          <p>填写基本信息，再从能力列表中选择地块功能。提交的是结构化属性对象；安装后由游戏内核执行，不会运行上传脚本。</p>
          <label>Mod 名称<input v-model="publishTerrainName" type="text" maxlength="60" placeholder="地块扩展名称" /></label>
          <label>作品说明<textarea v-model="publishTerrainDescription" class="code-field small-field" maxlength="1000" placeholder="说明这个地块如何影响规则…" /></label>
          <div class="form-grid">
            <label>Mod ID<input v-model="publishModId" type="text" maxlength="80" placeholder="mod-my-mod" /></label>
            <label>版本<input v-model="publishModVersion" type="text" maxlength="40" placeholder="1.0.0" /></label>
            <label>地块 ID<input v-model="publishTerrainId" type="text" maxlength="100" placeholder="mod/my-terrain" /></label>
            <label>地块名称<input v-model="publishTerrainDisplayName" type="text" maxlength="40" placeholder="新地块" /></label>
          </div>
          <label class="capability-label">地块功能（可多选）</label>
          <details class="capability-picker">
            <summary>{{ selectedCapabilities.length ? `已选择 ${selectedCapabilities.length} 项功能` : '选择要添加的地块功能' }}<span>▾</span></summary>
            <div class="capability-options">
              <label v-for="option in terrainCapabilityOptions" :key="option.id" class="capability-option">
                <input type="checkbox" :checked="selectedCapabilities.includes(option.id)" @change="toggleCapability(option.id)" />
                <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small><code>{{ option.id }}</code></span>
              </label>
            </div>
          </details>
          <div v-if="selectedCapabilities.includes('core/income-source') || selectedCapabilities.includes('core/departure-garrison') || selectedCapabilities.includes('core/counterattack-terrain-limit')" class="form-grid capability-config">
            <label v-if="selectedCapabilities.includes('core/income-source')">每回合收益<input v-model.number="incomeAmount" type="number" min="0" max="20" /></label>
            <label v-if="selectedCapabilities.includes('core/departure-garrison')">离开留下的兵力<input v-model.number="departureGarrisonStrength" type="number" min="1" max="20" /></label>
            <label v-if="selectedCapabilities.includes('core/counterattack-terrain-limit')">每回合反击次数<input v-model.number="maxCounterattacks" type="number" min="0" max="6" /></label>
            <p>这些是 Mod 默认值；房间设置中可再由房主调整。</p>
          </div>
          <label class="spatial-pattern-label">空间算法（JSON）<textarea v-model="publishSpatialPatterns" class="code-field pattern-input" spellcheck="false" /></label>
          <p class="pattern-help">表达式支持 step（相邻一步）、sequence（依次匹配）、either（任选一种）和 repeat（重复范围）；条件支持地块能力、己方/敌方单位、单位标记及 all / any / not。result 可选择格子或单位；单位结果必须按 id 去重。role 为 core/powered-units 时会用此算法替换内核默认供电网络。示例从供电源出发，沿己方占据的导电地块递归扩展。</p>
          <label class="spatial-pattern-label">触发规则（JSON）<textarea v-model="publishRules" class="code-field pattern-input" spellcheck="false" /></label>
          <p class="pattern-help">规则以事件触发：state-changed、unit-enter、unit-leave、unit-destroyed、turn-start。目标可以是触发单位，或空间算法选中的单位；条件可检查事件格地块能力或单位是否匹配算法。效果支持加减兵力、奖励点数、失活、设置/移除标记及按算法同步标记。上传内容只接受受限 JSON 数据，不会执行脚本。</p>
          <details class="capability-help">
            <summary>现在可以自定义哪些功能？</summary>
            <p>不必为每一种规则组合单独改内核：可以在上方用 JSON 组合空间路径、触发事件、条件与效果，例如“单位进入带某种能力的地块时奖励点数”或“按匹配网络给单位同步标记”。路径支持相邻、顺序、分支和有界重复；效果目前包括兵力变化、奖励点数、失活和标记操作。边界是：Mod 仍是声明式数据，不执行上传脚本；如果需要全新的效果原语或更复杂的计算，才需要扩展共享规则解释器，这样双方客户端才能得到相同结果。</p>
          </details>
          <details class="definition-details"><summary>查看将发布的属性对象</summary><pre class="definition-preview"><code>{{ JSON.stringify(generatedTerrainDefinition, null, 2) }}</code></pre></details>
          <div class="submit-row"><span v-if="publishError" class="form-error" role="alert">{{ publishError }}</span><button class="primary-button" type="button" :disabled="working" @click="submitTerrainMod">发布地块 Mod</button></div>
        </article>
    </div>
  </section>
</template>

<style scoped>
.workshop{padding:clamp(18px,3vw,34px);border:1px solid rgba(134,177,205,.3);border-radius:24px;background:linear-gradient(145deg,#1a2c40,#101f31);box-shadow:0 24px 65px rgba(0,6,17,.25)}
.workshop-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:22px}.eyebrow{margin:0 0 5px;color:#7de6d3;font-size:10px;font-weight:900;letter-spacing:.18em}.workshop-heading h2{margin:0;color:#f4f9ff;font-size:clamp(28px,4vw,42px);letter-spacing:-.035em}.workshop-heading p:not(.eyebrow){max-width:650px;margin:7px 0 0;color:#91a9be;font-size:12px;line-height:1.65}.back-button{width:auto;min-width:130px;margin:0;border:1px solid rgba(143,188,206,.32);color:#cde6f1;background:rgba(18,47,65,.5)}
.category-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:16px}.category-nav button{display:flex;align-items:center;gap:12px;min-height:72px;margin:0;padding:13px 17px;border:1px solid rgba(134,177,205,.27);border-radius:14px;color:#cde4f2;background:rgba(8,22,35,.45);text-align:left}.category-nav button.active{border-color:#75dccc;background:rgba(44,103,111,.32);box-shadow:inset 0 -3px #75dccc}.category-icon{font-size:27px;color:#88dcca;line-height:1}.category-nav strong,.category-nav small{display:block}.category-nav strong{font-size:15px}.category-nav small{margin-top:3px;color:#8faabb;font-size:10px}.action-message{padding:10px 13px;border:1px solid rgba(109,221,176,.32);border-radius:10px;color:#9ee9bd;background:rgba(51,106,83,.2);font-size:12px}.action-message.error{border-color:rgba(241,132,149,.4);color:#f4b1ba;background:rgba(112,48,66,.2)}
.workshop-grid{display:grid;grid-template-columns:minmax(240px,.33fr) minmax(0,.67fr);gap:16px;align-items:start}.entry-list-card,.detail-card,.publish-card{min-width:0;padding:18px;border:1px solid rgba(135,175,202,.24);border-radius:18px;background:rgba(8,22,35,.58)}.section-heading{display:flex;justify-content:space-between;gap:10px;align-items:center}.section-heading strong{color:#e6f2fb;font-size:14px}.section-heading span{color:#718da5;font-size:10px}.entry-list{display:grid;gap:8px;margin-top:15px}.entry-button{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:9px;align-items:center;min-height:65px;margin:0;padding:9px 11px;border:1px solid rgba(128,172,195,.2);color:#dbe9f2;background:rgba(32,59,77,.38);text-align:left}.entry-button.selected{border-color:#74dfcf;background:rgba(42,111,116,.25);box-shadow:inset 3px 0 #74dfcf}.entry-symbol{font-size:23px;line-height:1}.terrain-symbol{color:#d8b77e}.map-symbol{color:#88cde5}.entry-copy{min-width:0}.entry-copy strong,.entry-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entry-copy strong{font-size:13px}.entry-copy small{margin-top:4px;color:#8da7b9;font-size:10px}.entry-status{color:#e1a6ad;font-size:10px;white-space:nowrap}.entry-status.installed{color:#99e9bd}.empty-list{margin:17px 0 0;color:#91a8ba;font-size:12px;line-height:1.6}.detail-stack{display:grid;gap:15px}.detail-overline,.title-row,.source-heading,.detail-actions,.submit-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.detail-overline{color:#78b9c7;font-size:9px;font-weight:900;letter-spacing:.12em;overflow-wrap:anywhere}.detail-overline span:last-child{text-align:right}.title-row{align-items:start;margin:12px 0 14px}.title-row h3{margin:0;color:#f3f9ff;font-size:26px}.title-row p{margin:4px 0 0;color:#8eabba;font-size:11px}.status-pill{padding:5px 8px;border:1px solid rgba(243,159,169,.28);border-radius:7px;color:#eba8b1;font-size:10px;white-space:nowrap}.status-pill.installed{border-color:rgba(125,230,175,.32);color:#9ee9be}.description,.readme{margin:12px 0;color:#b6c9d7;font-size:12px;line-height:1.7;white-space:pre-wrap}.terrain-preview-image{display:block;max-width:100%;max-height:250px;margin:15px auto;border:1px solid rgba(138,179,203,.25);border-radius:12px;object-fit:contain}.metadata-block{padding:12px 0;border-top:1px solid rgba(140,180,202,.15)}.metadata-block>strong,.source-heading strong{color:#dcebf4;font-size:12px}.token-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}.token-list code{padding:5px 8px;border:1px solid rgba(126,198,194,.25);border-radius:7px;color:#9adfd9;background:rgba(34,84,89,.2);font-size:10px}.quiet{margin:9px 0 0;color:#829db1;font-size:11px;line-height:1.5}.source-heading{padding-top:14px;border-top:1px solid rgba(140,180,202,.15)}.source-heading span{color:#7997a9;font-size:10px}.source-tabs{display:flex;gap:6px;max-width:100%;overflow:auto;margin-top:10px}.source-tabs button{width:auto;min-width:max-content;margin:0;padding:6px 9px;border:1px solid rgba(127,172,193,.3);color:#a7c1d1;background:#152c3d;font:10px ui-monospace,Consolas,monospace}.source-tabs button.active{border-color:#78dfd0;color:#c7f4ee}.source-code{max-height:330px;overflow:auto;margin:9px 0 0;padding:13px;border:1px solid rgba(125,167,191,.26);border-radius:10px;background:#0b1928;color:#d7e9f1;font:11px/1.6 ui-monospace,Consolas,monospace;white-space:pre}.source-empty{margin:12px 0 0;color:#819db0;font-size:11px}
.map-preview{display:grid;place-items:center;height:clamp(245px,30vw,370px);overflow:hidden;border:1px solid rgba(128,170,194,.27);border-radius:14px;background:#19293a}.map-preview svg{width:100%;height:100%;padding:12px}.preview-unavailable{display:grid;place-items:center;min-height:200px;padding:20px;border:1px solid rgba(128,170,194,.27);border-radius:14px;color:#8fa7ba;text-align:center;font-size:12px}.preview-caption{margin:8px 0 13px;color:#8da7b9;font-size:10px}.dependency-block{border-bottom:1px solid rgba(140,180,202,.15)}.dependency-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.dependency{display:grid;gap:3px;min-width:150px;padding:8px 10px;border:1px solid rgba(121,211,181,.28);border-radius:9px;background:rgba(38,92,76,.19)}.dependency.missing{border-color:rgba(239,157,164,.3);background:rgba(108,46,62,.18)}.dependency b{color:#e6f1ef;font-size:11px}.dependency code{color:#86b0bc;font-size:10px}.dependency em{color:#9fe2b7;font-size:10px;font-style:normal}.dependency.missing em{color:#f0a7b2}.dependency-warning{margin:10px 0;color:#f0a7b2;font-size:11px;line-height:1.6}.detail-actions{justify-content:flex-start;flex-wrap:wrap;margin-top:13px}.detail-actions button{width:auto;min-height:41px;margin:0}.primary-button{background:linear-gradient(120deg,#81e9ce,#70c9e7)}.outline-button{border:1px solid rgba(141,184,205,.3);color:#b9d4e4;background:rgba(27,54,73,.55)}.copy-message{margin:8px 0 0;color:#8de6bd;font-size:11px}.code-field,.publish-card input{box-sizing:border-box;width:100%;border:1px solid rgba(136,177,204,.31);border-radius:10px;outline:none;background:#0c1b2b;color:#d6e8f0;font:11px/1.6 ui-monospace,Consolas,monospace}.code-field{min-height:110px;padding:11px;resize:vertical}.code-field:focus,.publish-card input:focus{border-color:#76ddcc;box-shadow:0 0 0 3px rgba(118,221,204,.08)}.map-code{margin-top:10px}.publish-card>p{margin:10px 0 15px;color:#91adbd;font-size:11px;line-height:1.6}.publish-card label{display:grid;gap:6px;margin-top:11px;color:#b7ceda;font-size:11px;font-weight:700}.publish-card input{height:39px;padding:0 10px;font:12px system-ui,sans-serif}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.small-field{min-height:72px}.source-input{min-height:180px}.submit-row{justify-content:flex-end;align-items:flex-end;margin-top:12px}.submit-row .primary-button{width:auto;min-width:135px;margin:0}.form-error{flex:1;color:#f2a9b4;font-size:11px;line-height:1.5}
@media(max-width:850px){.workshop-grid{grid-template-columns:1fr}.entry-list{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}}@media(max-width:570px){.workshop{padding:15px}.workshop-heading{display:grid}.back-button{min-height:42px}.category-nav button{padding:11px;min-height:64px}.category-icon{font-size:21px}.category-nav strong{font-size:13px}.entry-list-card,.detail-card,.publish-card{padding:13px}.title-row h3{font-size:23px}.form-grid{grid-template-columns:1fr}.detail-actions button{width:100%}.map-preview{height:250px}}
.workshop-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:18px 0 13px}.workshop-toolbar strong{color:#e6f2fb;font-size:16px}.workshop-toolbar p{max-width:750px;margin:5px 0 0;color:#93adbf;font-size:11px;line-height:1.6}.publish-entry{width:auto;min-width:160px;margin:0;padding:9px 13px;white-space:nowrap}.read-only-note{color:#aac5d5;font-size:11px}
.workshop-catalog{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}.workshop-work-card{display:block;width:100%;min-width:0;margin:0;padding:0;overflow:hidden;border:1px solid rgba(135,175,202,.24);border-radius:17px;color:#e8f2f9;background:rgba(8,22,35,.67);text-align:left;transition:border-color .18s,transform .18s,background .18s}.workshop-work-card:hover,.workshop-work-card:focus-visible{border-color:#79ddcd;background:rgba(16,40,55,.87);transform:translateY(-2px)}.work-card-preview{display:grid;place-items:center;height:165px;overflow:hidden;background:#182638}.work-card-preview svg{width:100%;height:100%;padding:13px}.terrain-card-preview{background:radial-gradient(circle at 50% 45%,rgba(238,178,93,.22),transparent 46%),#182638}.terrain-card-preview img{display:block;max-width:160px;max-height:145px;object-fit:contain}.generic-terrain-mark{color:#dba861;font-size:100px;line-height:1}.thumbnail-placeholder{color:#86a7bb;font-size:11px}.work-card-info{display:grid;gap:8px;padding:13px 14px 15px}.work-card-title{display:flex;justify-content:space-between;align-items:center;gap:9px}.work-card-title strong{overflow:hidden;color:#eef6fb;font-size:16px;text-overflow:ellipsis;white-space:nowrap}.work-card-title em{flex:none;color:#efadb7;font-size:10px;font-style:normal}.work-card-title em.installed{color:#a1eabc}.work-card-description{display:-webkit-box;min-height:35px;overflow:hidden;color:#b4c9d7;font-size:11px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:2}.work-card-info small{color:#86a3b5;font-size:10px}.workshop-catalog>.empty-list{grid-column:1/-1;padding:28px;border:1px dashed rgba(135,175,202,.3);border-radius:14px;text-align:center}
.detail-stack{max-width:920px;margin:0 auto}.catalog-back{width:auto;justify-self:start;margin:0;padding:7px 12px;border:1px solid rgba(143,188,206,.28);color:#c6e3ef;background:rgba(18,47,65,.45);font-size:11px}.map-preview{height:clamp(270px,34vw,450px)}.map-preview :deep(.board-canvas){height:100%;border:none;border-radius:0}.install-unavailable{color:#e6bba7;font-size:11px;line-height:1.5}.dependency-warning{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:11px;border:1px solid rgba(239,157,164,.3);border-radius:10px;background:rgba(108,46,62,.16)}.dependency-warning button{width:auto;margin:0;padding:7px 10px;font-size:11px}
@media(max-width:570px){.workshop-toolbar{align-items:stretch;flex-direction:column}.publish-entry{width:100%}.workshop-catalog{grid-template-columns:1fr}.work-card-preview{height:155px}.map-preview{height:280px}}
.terrain-card-preview{position:relative;isolation:isolate;height:112px;background:#182638}.terrain-card-preview::before{display:none}.terrain-card-preview img{position:relative;z-index:1;filter:none}.terrain-card-preview .custom-terrain-art{max-width:94px;max-height:88px;object-fit:contain}.terrain-card-preview .oil-field-art{position:relative;display:grid;place-items:center;width:72px;height:80px;clip-path:polygon(50% 0,93% 24%,93% 76%,50% 100%,7% 76%,7% 24%);background:linear-gradient(145deg,#b77b43,#684024);box-shadow:inset 0 0 0 3px #f0ba69}.terrain-card-preview .oil-field-art img{width:65px;height:72px;object-fit:contain;opacity:.25;mix-blend-mode:screen}.terrain-card-preview .generic-terrain-mark{position:relative;z-index:1;color:#d9c99b;font-size:48px;line-height:1}.terrain-preview-image{max-width:min(100%,180px);max-height:140px;margin:12px auto}
.capability-label{margin-top:16px;color:#b7ceda;font-size:11px;font-weight:700}.capability-picker{position:relative;margin-top:7px;border:1px solid rgba(136,177,204,.31);border-radius:10px;background:#0c1b2b}.capability-picker>summary,.capability-help>summary,.definition-details>summary{display:flex;justify-content:space-between;align-items:center;min-height:40px;padding:0 12px;color:#cce1ec;font-size:12px;cursor:pointer;list-style:none}.capability-picker>summary::-webkit-details-marker,.capability-help>summary::-webkit-details-marker,.definition-details>summary::-webkit-details-marker{display:none}.capability-picker[open]>summary{border-bottom:1px solid rgba(136,177,204,.2)}.capability-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:10px}.capability-option{display:flex!important;align-items:flex-start;gap:9px;margin:0!important;padding:9px;border:1px solid rgba(136,177,204,.17);border-radius:8px;background:rgba(29,51,69,.55)}.capability-option input{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:#75dccc}.capability-option span{display:grid;gap:3px}.capability-option strong{color:#dcebf4;font-size:11px}.capability-option small{color:#8eaabc;font-size:10px;font-weight:400;line-height:1.4}.capability-option code{color:#7ccfc7;font-size:9px}.capability-help,.definition-details{margin-top:12px;border:1px solid rgba(136,177,204,.2);border-radius:9px;background:rgba(12,27,43,.5)}.capability-help>summary,.definition-details>summary{justify-content:flex-start;min-height:36px;color:#9fded7;font-size:11px}.capability-help p{margin:0;padding:0 12px 12px;color:#a8bdcc;font-size:11px;line-height:1.6}.definition-details .definition-preview{margin:0 10px 10px}.publish-card .form-grid{margin-top:2px}.publish-card .form-grid label{min-width:0}
.capability-config{margin-top:10px;padding:12px;border:1px solid rgba(136,177,204,.18);border-radius:10px;background:rgba(15,32,48,.55)}.capability-config p{grid-column:1/-1;margin:2px 0 0;color:#8eaabc;font-size:10px}.spatial-pattern-label{margin-top:16px!important}.pattern-input{min-height:300px}.pattern-help{margin:7px 0 0;color:#91adbd;font-size:10px;line-height:1.6}
@media(max-width:570px){.capability-options{grid-template-columns:1fr}}
</style>

<style scoped>
.definition-preview { max-height: 360px; overflow: auto; margin: 10px 0; padding: 14px; border: 1px solid rgba(125,167,191,.26); border-radius: 10px; background: #0b1928; color: #d7e9f1; font: 11px/1.6 ui-monospace, Consolas, monospace; white-space: pre; }
.terrain-detail-preview { display: grid; place-items: center; min-height: 176px; margin: 13px 0; border: 1px solid rgba(138,179,203,.25); border-radius: 12px; background: radial-gradient(circle at 50% 42%,rgba(238,178,93,.16),transparent 48%),#182638; }
.terrain-detail-preview :deep(.terrain-art-tile) { width: 100px; height: 112px; }
</style>
