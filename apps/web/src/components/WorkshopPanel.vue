<script lang="ts">
/** A workshop entry is data only. Displaying source never installs or executes it. */
export interface WorkshopSourceFile {
  readonly path: string;
  readonly content: string;
}

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
  readonly sourceFiles?: readonly WorkshopSourceFile[];
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
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly terrainIds: readonly string[];
  readonly sourceFiles: readonly WorkshopSourceFile[];
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
}>();

type Category = "terrain" | "maps";
type ViewMode = "browse" | "detail" | "publish";
const category = ref<Category>("terrain");
const viewMode = ref<ViewMode>("browse");
const selectedTerrainId = ref("");
const selectedMapId = ref("");
const selectedSourcePath = ref("");
const showMapCode = ref(false);
const copyMessage = ref("");
const codeField = ref<HTMLTextAreaElement | null>(null);
const publishMapCode = ref("");
const publishMapDescription = ref("");
const publishTerrainId = ref("");
const publishTerrainName = ref("");
const publishTerrainVersion = ref("1.0.0");
const publishTerrainDescription = ref("");
const publishTerrainIds = ref("");
const publishSourcePath = ref("src/index.ts");
const publishSourceContent = ref("");
const publishError = ref("");
const downloadMessage = ref("");

const selectedTerrain = computed(() => props.terrainMods.find((entry) => entry.id === selectedTerrainId.value));
const selectedMap = computed(() => props.mapEntries.find((entry) => entry.id === selectedMapId.value));
const selectedSource = computed(() => selectedTerrain.value?.sourceFiles?.find((file) => file.path === selectedSourcePath.value)
  ?? selectedTerrain.value?.sourceFiles?.[0]);

watch(() => selectedTerrain.value?.id, () => {
  selectedSourcePath.value = "";
});
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
const oilFieldArtworkUrl = `${import.meta.env.BASE_URL}legacy/TSF.png`;

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
  if (!entry.sourceFiles) emit("select-terrain-mod", entry.id);
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

function downloadTerrainSource(): void {
  const entry = selectedTerrain.value;
  if (!entry?.sourceFiles?.length) return;
  // Downloading an inert JSON archive is distinct from installing a Mod.
  // Runtime execution needs a separately verified, versioned content format.
  const archive = { modId: entry.modId ?? entry.id, version: entry.version, sourceFiles: entry.sourceFiles };
  const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `${(entry.modId ?? entry.id).replace(/[^a-zA-Z0-9-]/g, "-")}-${entry.version.replace(/[^a-zA-Z0-9.-]/g, "-")}-source.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  downloadMessage.value = "已下载源码归档；这不会安装或运行该 Mod。";
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
  const id = publishTerrainId.value.trim();
  const name = publishTerrainName.value.trim();
  const version = publishTerrainVersion.value.trim();
  const description = publishTerrainDescription.value.trim();
  const terrainIds = [...new Set(publishTerrainIds.value.split(/[\s,，]+/).map((value) => value.trim()).filter(Boolean))];
  const sourcePath = publishSourcePath.value.trim();
  const content = publishSourceContent.value;
  if (!/^mod-[a-z0-9-]+$/.test(id) || !name || !version || !description || !terrainIds.length || !sourcePath || !content.trim()) {
    publishError.value = "请填写 Mod 包 ID（如 mod-oil-field）、名称、版本、说明、地形 ID 和源码。";
    return;
  }
  const sourceFiles: WorkshopSourceFile[] = [{ path: sourcePath, content }];
  publishError.value = "";
  emit("publish-terrain-mod", { id, name, version, description, terrainIds, sourceFiles });
}
</script>

<template>
  <section class="workshop" aria-label="创意工坊">
    <header class="workshop-heading">
      <div>
        <p class="eyebrow">COMMUNITY WORKSHOP</p>
        <h2>创意工坊</h2>
        <p>浏览地块扩展和地图作品。地图码可以保存到「地图配置」；地块源码仅供预览，不会在这里自动执行。</p>
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
      <div><strong>{{ category === 'terrain' ? '地块扩展' : '地图作品' }}</strong><p>{{ category === 'terrain' ? '查看规则、包含地块与源码。安装需要受校验的 Mod 格式，当前不会执行社区源码。' : '地图作品是一段可保存的地图码；开局前需要装齐所依赖的地块 Mod。' }}</p></div>
      <button v-if="publishingEnabled && viewMode === 'browse'" class="outline-button publish-entry" type="button" @click="openPublish">＋ {{ category === 'terrain' ? '发布地块 Mod' : '发布地图作品' }}</button>
      <span v-else-if="!publishingEnabled" class="read-only-note">公网测试版仅开放浏览，暂不接受发布</span>
    </div>

    <div v-if="viewMode === 'browse'" class="workshop-catalog">
      <template v-if="category === 'terrain'">
        <button v-for="entry in terrainMods" :key="entry.id" class="workshop-work-card" type="button" @click="openTerrain(entry)">
          <span class="work-card-preview terrain-card-preview" aria-hidden="true">
            <img v-if="entry.previewImageUrl" class="custom-terrain-art" :src="entry.previewImageUrl" alt="" />
            <span v-else-if="entry.terrainIds.includes('mod/oil-field')" class="oil-field-art">
              <img :src="oilFieldArtworkUrl" alt="" />
            </span>
            <span v-else class="generic-terrain-mark">⬡</span>
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
          <img v-if="selectedTerrain.previewImageUrl" class="terrain-preview-image" :src="selectedTerrain.previewImageUrl" :alt="`${selectedTerrain.name}预览`" />
          <p class="description">{{ selectedTerrain.description }}</p>
          <div class="metadata-block"><strong>包含地块</strong><div class="token-list"><code v-for="id in selectedTerrain.terrainIds" :key="id">{{ id }}</code><span v-if="!selectedTerrain.terrainIds.length" class="quiet">未声明地块 ID</span></div></div>
          <p v-if="selectedTerrain.readme" class="readme">{{ selectedTerrain.readme }}</p>
          <div class="detail-actions">
            <button v-if="selectedTerrain.sourceFiles?.length" class="outline-button" type="button" @click="downloadTerrainSource">下载源码归档（不安装）</button>
            <span v-if="!selectedTerrain.installed" class="install-unavailable">自动安装暂未开放：需要先完成版本、依赖和规则校验。</span>
          </div>
          <p v-if="downloadMessage" class="copy-message" role="status">{{ downloadMessage }}</p>
          <div class="source-heading"><strong>源码预览</strong><span>仅展示文本，不执行代码</span></div>
          <template v-if="selectedTerrain.sourceFiles?.length">
            <div class="source-tabs" aria-label="源码文件">
              <button v-for="file in selectedTerrain.sourceFiles" :key="file.path" type="button" :class="{ active: selectedSource?.path === file.path }" @click="selectedSourcePath = file.path">{{ file.path }}</button>
            </div>
            <pre class="source-code"><code>{{ selectedSource?.content }}</code></pre>
          </template>
          <p v-else class="source-empty">{{ selectedTerrain.sourceFiles ? '该作品未附带公开源码文件。' : '正在加载作品详情…' }}</p>
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
          <div class="section-heading"><strong>发布地块 Mod</strong><span>元信息与源码</span></div>
          <p>这里提交的源码只作为作品文本展示，不会自动加载或在其他玩家设备上执行。</p>
          <div class="form-grid">
            <label>Mod 包 ID<input v-model="publishTerrainId" type="text" maxlength="100" placeholder="mod-my-terrain" /></label>
            <label>名称<input v-model="publishTerrainName" type="text" maxlength="60" placeholder="地块名称" /></label>
            <label>版本<input v-model="publishTerrainVersion" type="text" maxlength="32" placeholder="1.0.0" /></label>
            <label>地形 ID<input v-model="publishTerrainIds" type="text" placeholder="mod/my-terrain，可用逗号分隔" /></label>
          </div>
          <label>作品说明<textarea v-model="publishTerrainDescription" class="code-field small-field" maxlength="1000" placeholder="说明这个地块如何影响规则…" /></label>
          <label>源码文件路径<input v-model="publishSourcePath" type="text" maxlength="160" placeholder="src/index.ts" /></label>
          <label>源码文本<textarea v-model="publishSourceContent" class="code-field source-input" spellcheck="false" placeholder="粘贴地块 Mod 的源码…" /></label>
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
</style>
