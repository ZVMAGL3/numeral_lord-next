<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import type { TerrainModDefinition } from "@numeral-lord/content-schema";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "../workshop/types";
import { terrainModAuthoringJson } from "../workshop/terrain-mod-authoring";
import WorkshopTerrainEditor from "./WorkshopTerrainEditor.vue";
import { getPoweredUnitIds, type GameState } from "@numeral-lord/game-core";
import { createMatchFromMapCode, parseMapCode } from "@numeral-lord/core-content";
import { runtimeMapCatalogs, loadedTerrainCatalog, loadedTerrainCatalogRevision, resolveMapCatalogs, terrainVisualAssetsForCatalogs } from "../content/installed-content";
import { paginate } from "../shared/list-pagination.js";
import HexBoard from "./HexBoard.vue";
import TerrainModPreview from "./TerrainModPreview.vue";
import ConditionReferenceDialog from "./ConditionReferenceDialog.vue";

const props = withDefaults(defineProps<{
  terrainMods: readonly TerrainModEntry[];
  mapEntries: readonly MapWorkshopEntry[];
  savedMapIds: readonly string[];
  subscribedTerrainModIds?: readonly string[];
  currentAuthorName?: string;
  pendingTerrainModId?: string | null;
  actionMessage?: string;
  actionError?: boolean;
  working?: boolean;
  /** 由应用运行时按环境控制发布入口。 */
  publishingEnabled?: boolean;
  uploadTerrainAsset: (dataUrl: string) => Promise<string>;
  downloadTerrainAsset: (url: string) => Promise<string>;
}>(), {
  actionMessage: "",
  actionError: false,
  working: false,
  publishingEnabled: true,
  currentAuthorName: ""
});

const emit = defineEmits<{
  back: [];
  "select-map": [id: string];
  "select-terrain-mod": [id: string];
  "save-map": [code: string];
  "publish-map": [entry: MapSubmission];
  "publish-terrain-mod": [entry: TerrainModSubmission];
  "subscribe-terrain-mod": [definition: TerrainModDefinition];
  "unsubscribe-terrain-mod": [id: string];
  "terrain-mod-opened": [id: string];
  "request-terrain-mod-preview": [id: string];
}>();

type Category = "terrain" | "maps";
type ViewMode = "browse" | "detail" | "publish";
const category = ref<Category>("terrain");
const viewMode = ref<ViewMode>("browse");
const CATALOG_PAGE_SIZE = 12;
const terrainPage = ref(1);
const mapPage = ref(1);
const terrainPageSlice = computed(() => paginate(props.terrainMods, terrainPage.value, CATALOG_PAGE_SIZE));
const mapPageSlice = computed(() => paginate(props.mapEntries, mapPage.value, CATALOG_PAGE_SIZE));
watch(() => props.terrainMods.length, (currentLength, previousLength) => {
  terrainPage.value = currentLength > previousLength ? Math.ceil(currentLength / CATALOG_PAGE_SIZE) : terrainPageSlice.value.currentPage;
});
watch(() => props.mapEntries.length, (currentLength, previousLength) => {
  mapPage.value = currentLength > previousLength ? Math.ceil(currentLength / CATALOG_PAGE_SIZE) : mapPageSlice.value.currentPage;
});
const selectedTerrainId = ref("");
const selectedMapId = ref("");
const showMapCode = ref(false);
const showConditionReference = ref(false);
const copyMessage = ref("");
const codeField = ref<HTMLTextAreaElement | null>(null);
const publishMapCode = ref("");
const publishMapDescription = ref("");
const publishError = ref("");
const editingTerrainEntry = shallowRef<TerrainModEntry | null>(null);
const downloadMessage = ref("");

const selectedTerrain = computed(() => props.terrainMods.find((entry) => entry.id === selectedTerrainId.value)
  ?? props.terrainMods.find((entry) => entry.id === selectedTerrainId.value));
const selectedTerrainModId = computed(() => selectedTerrain.value?.modId ?? selectedTerrain.value?.id ?? "");
const selectedTerrainIsSubscribed = computed(() => props.subscribedTerrainModIds?.includes(selectedTerrainModId.value) ?? false);
const selectedMap = computed(() => props.mapEntries.find((entry) => entry.id === selectedMapId.value));
const selectedDefinitionAssetUrls = ref<Readonly<Record<string, string>>>({});
const selectedDefinitionAssetStatus = ref("");
const authoringAssetUrlByDataUrl = new Map<string, string>();
watch(() => selectedTerrain.value, async (entry) => {
  const selectedId = entry?.id;
  selectedDefinitionAssetUrls.value = entry?.visualAssetUrls ?? {};
  selectedDefinitionAssetStatus.value = "";
  const definition = entry?.definition;
  if (!definition) return;
  const referencedIds = [definition.terrain.visuals?.baseAssetId, definition.terrain.visuals?.overlay?.assetId]
    .filter((id): id is string => typeof id === "string");
  const assetIds = new Set((definition.visualAssets ?? []).map((asset) => asset.id));
  const missingBindings = referencedIds.filter((id) => !assetIds.has(id));
  if (missingBindings.length) {
    selectedDefinitionAssetStatus.value = `图层绑定缺少 SVG 资源：${missingBindings.join("、")}`;
    return;
  }
  const missingUrls = (definition.visualAssets ?? []).filter((asset) => !entry.visualAssetUrls?.[asset.id]);
  if (!missingUrls.length) return;

  selectedDefinitionAssetStatus.value = "正在保存 SVG 并生成后台图片地址…";
  try {
    const urls: Record<string, string> = { ...entry?.visualAssetUrls };
    for (const asset of missingUrls) {
      const url = authoringAssetUrlByDataUrl.get(asset.dataUrl) ?? await props.uploadTerrainAsset(asset.dataUrl);
      authoringAssetUrlByDataUrl.set(asset.dataUrl, url);
      urls[asset.id] = url;
    }
    if (selectedTerrain.value?.id === selectedId) {
      selectedDefinitionAssetUrls.value = urls;
      selectedDefinitionAssetStatus.value = "";
    }
  } catch (error) {
    if (selectedTerrain.value?.id === selectedId) {
      selectedDefinitionAssetStatus.value = `SVG 保存失败：${error instanceof Error ? error.message : "图片地址生成失败。"}`;
    }
  }
}, { immediate: true });
const selectedDefinitionJson = computed(() => {
  const entry = selectedTerrain.value;
  const definition = entry?.definition;
  if (!definition || selectedDefinitionAssetStatus.value) return "";
  try {
    return JSON.stringify(terrainModAuthoringJson(entry.name, entry.description, {
      ...definition,
      visualAssets: (definition.visualAssets ?? []).map(({ id }) => ({ id, url: selectedDefinitionAssetUrls.value[id] ?? "" }))
    }), null, 2);
  } catch {
    return "";
  }
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
  readonly available: boolean;
}

function resolveTerrainMod(id: string): TerrainModEntry | undefined {
  return props.terrainMods.find((entry) => entry.modId === id || entry.id === id || entry.terrainId === id);
}

function requestTerrainModPreview(id: string): void {
  const entry = props.terrainMods.find((candidate) => candidate.id === id);
  if (entry && !entry.preview) emit("request-terrain-mod-preview", id);
}

function mapDependencies(map: MapWorkshopEntry): Dependency[] {
  void loadedTerrainCatalogRevision.value;
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
  const activeCatalogs = map.code ? resolveMapCatalogs(map.code) : undefined;
  const activeMods = activeCatalogs?.mods;
  for (const id of ids) {
    const mod = resolveTerrainMod(id);
    const key = mod?.modId ?? mod?.id ?? id;
    result.set(key, { id: key, name: mod?.name ?? id, available: Boolean(activeMods?.[key]) });
  }
  return [...result.values()];
}

const selectedDependencies = computed(() => selectedMap.value ? mapDependencies(selectedMap.value) : []);
const missingDependency = computed(() => selectedDependencies.value.some((entry) => !entry.available));
const mapIsSaved = computed(() => !!selectedMap.value && props.savedMapIds.includes(selectedMap.value.mapId ?? selectedMap.value.id));

// The detail preview uses the very same Pixi board as the lobby and match.
// An unavailable Mod must not be silently replaced by an invented rule tile.
const previewState = computed<GameState | null>(() => {
  void loadedTerrainCatalogRevision.value;
  if (!selectedMap.value?.code) return null;
  try {
    const catalogs = resolveMapCatalogs(selectedMap.value.code);
    return catalogs ? createMatchFromMapCode(selectedMap.value.code, catalogs) : null;
  }
  catch { return null; }
});
const previewCatalogs = computed(() => {
  void loadedTerrainCatalogRevision.value;
  return selectedMap.value?.code ? resolveMapCatalogs(selectedMap.value.code) : null;
});
const previewTerrainVisualAssets = computed(() => terrainVisualAssetsForCatalogs(previewCatalogs.value));
const previewPoweredUnitIds = computed(() => previewState.value
  ? [...getPoweredUnitIds(previewState.value, previewCatalogs.value?.terrains ?? loadedTerrainCatalog)] : []);
const previewDefinition = computed(() => {
  void loadedTerrainCatalogRevision.value;
  if (!selectedMap.value?.code) return null;
  try { return parseMapCode(selectedMap.value.code, previewCatalogs.value ?? { ...runtimeMapCatalogs, allowUnknownTerrainMods: true }); }
  catch { return null; }
});

const mapCardPreviews = computed(() => {
  void loadedTerrainCatalogRevision.value;
  return new Map(props.mapEntries.flatMap((entry) => {
    if (!entry.code) return [];
    try {
      const catalogs = resolveMapCatalogs(entry.code);
      if (!catalogs) return [];
      const state = createMatchFromMapCode(entry.code, catalogs);
      return [[entry.id, {
        state,
        poweredUnitIds: [...getPoweredUnitIds(state, catalogs.terrains ?? loadedTerrainCatalog)],
        terrainCatalog: catalogs.terrains ?? loadedTerrainCatalog,
        terrainVisualAssets: terrainVisualAssetsForCatalogs(catalogs)
      }] as const];
    } catch {
      // Maps with missing Mod dependencies cannot be shown faithfully.
      return [];
    }
  }));
});
function selectCategory(next: Category): void {
  category.value = next;
  if (next === "terrain") terrainPage.value = 1;
  else mapPage.value = 1;
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

watch([() => props.pendingTerrainModId, () => props.terrainMods], () => {
  const requestedId = props.pendingTerrainModId;
  if (!requestedId) return;
  const entry = resolveTerrainMod(requestedId);
  if (!entry) return;
  openTerrain(entry);
  emit("terrain-mod-opened", requestedId);
}, { immediate: true });

function openDependency(id: string): void {
  const mod = resolveTerrainMod(id);
  if (mod) openTerrain(mod);
  else selectCategory("terrain");
}

function editTerrain(entry: TerrainModEntry): void {
  if (!entry.definition || !entry.modId || entry.authorName !== props.currentAuthorName.trim()) return;
  editingTerrainEntry.value = entry;
  category.value = "terrain";
  viewMode.value = "publish";
}

function openPublish(): void {
  if (!props.publishingEnabled) return;
  editingTerrainEntry.value = null;
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

function subscribeSelectedTerrain(): void {
  const definition = selectedTerrain.value?.definition;
  if (!definition) return;
  if (!selectedTerrainIsSubscribed.value) emit("subscribe-terrain-mod", definition);
}
</script>

<template>
  <section class="workshop" aria-label="创意工坊">
    <header class="workshop-heading">
      <div>
        <p class="eyebrow">COMMUNITY WORKSHOP</p>
        <h2>创意工坊</h2>
        <p>地图与地块 Mod 保存在服务器数据库。订阅状态绑定到玩家名称对应的服务器账号；订阅只决定地图编辑器可选项。</p>
      </div>
      <div class="workshop-heading-actions">
        <button class="outline-button condition-reference-entry" type="button" @click="showConditionReference = true">条件语法参考</button>
        <button class="back-button" type="button" @click="emit('back')">← 返回主页</button>
      </div>
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
      <div><strong>{{ category === 'terrain' ? '地块扩展' : '地图作品' }}</strong><p>{{ category === 'terrain' ? '查看结构化属性与当前地块定义。订阅只影响地图编辑器可选地块；地图和房间始终从服务器读取当前定义。' : '地图作品是一段可保存的地图码；地图依赖在加载时从服务器数据库读取。' }}</p></div>
      <button v-if="publishingEnabled && viewMode === 'browse'" class="outline-button publish-entry" type="button" @click="openPublish">＋ {{ category === 'terrain' ? '发布地块 Mod' : '发布地图作品' }}</button>
      <span v-else-if="!publishingEnabled" class="read-only-note">此环境暂不接受工坊发布</span>
    </div>

    <template v-if="viewMode === 'browse'">
    <div class="workshop-catalog">
      <template v-if="category === 'terrain'">
        <button v-for="entry in terrainPageSlice.items" :key="entry.id" class="workshop-work-card" type="button" @click="openTerrain(entry)">
          <span class="work-card-preview terrain-card-preview" aria-hidden="true">
            <TerrainModPreview :terrain-id="entry.terrainId" :name="entry.name" :definition="entry.definition" :preview="entry.preview" :publication-id="entry.id" @preview-requested="requestTerrainModPreview" />
          </span>
          <span class="work-card-info"><span class="work-card-title"><strong>{{ entry.name }}</strong><em :class="{ installed: entry.subscribed }">{{ entry.subscribed ? '已订阅' : '未订阅' }}</em></span><span class="work-card-description">{{ entry.description || '暂无作品简介' }}</span><small>{{ entry.authorName || entry.author || '社区作者' }} · {{ entry.terrainId }}</small></span>
        </button>
        <p v-if="!terrainMods.length" class="empty-list">暂无地块 Mod 作品。</p>
      </template>
      <template v-else>
        <button v-for="entry in mapPageSlice.items" :key="entry.id" class="workshop-work-card" type="button" @click="openMap(entry)">
          <div class="work-card-preview map-card-preview" aria-hidden="true">
            <HexBoard v-if="mapCardPreviews.get(entry.id)" preview :show-unit-labels="false"
              :state="mapCardPreviews.get(entry.id)!.state" :selected-unit-id="null"
              :legal-action-cell-ids="[]" :actionable-unit-ids="[]"
              :powered-unit-ids="mapCardPreviews.get(entry.id)!.poweredUnitIds"
              :terrain-catalog="mapCardPreviews.get(entry.id)!.terrainCatalog"
              :terrain-visual-assets="mapCardPreviews.get(entry.id)!.terrainVisualAssets" />
            <span v-else class="thumbnail-placeholder">正在从服务器加载地图依赖</span>
          </div>
          <span class="work-card-info"><span class="work-card-title"><strong>{{ entry.name }}</strong><em :class="{ installed: savedMapIds.includes(entry.mapId ?? entry.id) }">{{ savedMapIds.includes(entry.mapId ?? entry.id) ? '已保存' : '地图码' }}</em></span><span class="work-card-description">{{ entry.description || '暂无作品简介' }}</span><small>{{ entry.authorName || entry.author || '社区作者' }} · {{ entry.players ?? '?' }} 人地图 · {{ mapDependencies(entry).length }} 个地块依赖</small></span>
        </button>
        <p v-if="!mapEntries.length" class="empty-list">暂无地图作品。</p>
      </template>
    </div>
    <nav v-if="viewMode === 'browse' && (category === 'terrain' ? terrainPageSlice.pageCount : mapPageSlice.pageCount) > 1" class="list-pagination" :aria-label="category === 'terrain' ? '地块 Mod 分页' : '地图作品分页'">
      <button type="button" :disabled="(category === 'terrain' ? terrainPageSlice.currentPage : mapPageSlice.currentPage) === 1" @click="category === 'terrain' ? terrainPage = terrainPageSlice.currentPage - 1 : mapPage = mapPageSlice.currentPage - 1">上一页</button>
      <span role="status">第 {{ category === 'terrain' ? terrainPageSlice.currentPage : mapPageSlice.currentPage }} / {{ category === 'terrain' ? terrainPageSlice.pageCount : mapPageSlice.pageCount }} 页 · 共 {{ category === 'terrain' ? terrainPageSlice.totalItems : mapPageSlice.totalItems }} 项</span>
      <button type="button" :disabled="(category === 'terrain' ? terrainPageSlice.currentPage : mapPageSlice.currentPage) === (category === 'terrain' ? terrainPageSlice.pageCount : mapPageSlice.pageCount)" @click="category === 'terrain' ? terrainPage = terrainPageSlice.currentPage + 1 : mapPage = mapPageSlice.currentPage + 1">下一页</button>
    </nav>
    </template>

    <div v-else-if="viewMode === 'detail'" class="detail-stack">
      <button class="catalog-back" type="button" @click="viewMode = 'browse'">← 返回{{ category === 'terrain' ? '地块 Mod' : '地图作品' }}列表</button>
        <article v-if="category === 'terrain' && selectedTerrain" class="detail-card">
          <div class="detail-overline"><span>TERRAIN MOD</span><span>{{ selectedTerrain.modId || selectedTerrain.id }}</span></div>
          <div class="title-row"><div><h3>{{ selectedTerrain.name }}</h3><p>{{ selectedTerrain.authorName || selectedTerrain.author || '社区作者' }} · 当前版本 v{{ selectedTerrain.version }}</p></div><span class="status-pill" :class="{ installed: selectedTerrainIsSubscribed }">{{ selectedTerrainIsSubscribed ? '已订阅' : '未订阅' }}</span></div>
          <div class="terrain-detail-preview"><TerrainModPreview large :terrain-id="selectedTerrain.terrainId" :name="selectedTerrain.name" :definition="selectedTerrain.definition" :preview="selectedTerrain.preview" :publication-id="selectedTerrain.id" @preview-requested="requestTerrainModPreview" /></div>
          <p class="description">{{ selectedTerrain.description }}</p>
          <div class="metadata-block"><strong>地块 ID</strong><div class="token-list"><code>{{ selectedTerrain.terrainId }}</code></div></div>
          <p v-if="selectedTerrain.readme" class="readme">{{ selectedTerrain.readme }}</p>
          <div class="metadata-block"><strong>Mod 属性对象</strong><p class="quiet">这是服务器数据库中的当前 JSON 定义；规则由游戏内核中对应的能力处理器执行，不运行上传脚本。</p></div>
          <p v-if="selectedDefinitionAssetStatus" class="quiet" role="status">{{ selectedDefinitionAssetStatus }}</p>
          <pre v-if="selectedDefinitionJson" class="definition-preview"><code>{{ selectedDefinitionJson }}</code></pre>
          <p v-else class="source-empty">{{ selectedTerrain.definition === undefined ? '此作品使用旧版多地块格式，仍可浏览作品信息，但当前版本无法用于地图；作者可以按新格式重新发布。' : '正在加载作品详情…' }}</p>
          <div class="detail-actions">
            <button class="primary-button" type="button" :disabled="selectedTerrainIsSubscribed || !selectedTerrain.definition || working" @click="subscribeSelectedTerrain">{{ !selectedTerrain.definition ? '当前定义暂不可用' : selectedTerrainIsSubscribed ? '已订阅' : '订阅（用于地图编辑）' }}</button>
            <button v-if="selectedTerrainIsSubscribed" class="unsubscribe-button" type="button" :disabled="working" @click="emit('unsubscribe-terrain-mod', selectedTerrainModId)">取消订阅</button>
            <button v-if="publishingEnabled && selectedTerrain.definition && selectedTerrain.authorName === currentAuthorName.trim()" class="outline-button" type="button" :disabled="working" @click="editTerrain(selectedTerrain)">更新 Mod</button>
          </div>
          <p v-if="downloadMessage" class="copy-message" role="status">{{ downloadMessage }}</p>
        </article>

        <article v-else-if="category === 'maps' && selectedMap" class="detail-card">
          <div class="detail-overline"><span>MAP WORK</span><span>ID {{ selectedMap.mapId || selectedMap.id }}</span></div>
          <div class="title-row"><div><h3>{{ selectedMap.name }}</h3><p>{{ selectedMap.authorName || selectedMap.author || '社区作者' }}{{ selectedMap.version ? ` · v${selectedMap.version}` : '' }}</p></div><span class="status-pill" :class="{ installed: mapIsSaved }">{{ mapIsSaved ? '已保存' : '可保存' }}</span></div>
          <p v-if="selectedMap.description" class="description">{{ selectedMap.description }}</p>
          <div v-if="previewState" class="map-preview">
            <HexBoard preview :state="previewState" :selected-unit-id="null" :legal-action-cell-ids="[]" :actionable-unit-ids="[]" :powered-unit-ids="previewPoweredUnitIds" :terrain-catalog="previewCatalogs?.terrains" :terrain-visual-assets="previewTerrainVisualAssets" />
          </div>
          <div v-else class="preview-unavailable">{{ selectedMap.code ? missingDependency ? '正在等待服务器提供所需地块 Mod，暂时无法预览。' : '地图格式暂时无法预览，仍可查看地图码。' : '正在加载地图详情与预览…' }}</div>
          <p v-if="previewDefinition" class="preview-caption">{{ previewDefinition.columns }} × {{ previewDefinition.terrain.length / previewDefinition.columns }} 格 · {{ previewDefinition.players }} 个玩家位</p>
          <div class="metadata-block dependency-block"><strong>需要的地块 Mod</strong><div v-if="selectedDependencies.length" class="dependency-list"><span v-for="dependency in selectedDependencies" :key="dependency.id" class="dependency" :class="{ missing: !dependency.available }"><b>{{ dependency.name }}</b><code>{{ dependency.id }}</code><em>{{ dependency.available ? '服务器可用' : '服务器未找到' }}</em></span></div><p v-else class="quiet">仅使用原生地块，无额外地块 Mod 依赖。</p></div>
          <div v-if="missingDependency" class="dependency-warning" role="status">正在加载或服务器中不存在地图依赖的地块 Mod。地图码仍可保存；对局会按服务器当前定义加载。<button class="outline-button" type="button" @click="openDependency(selectedDependencies.find((item) => !item.available)?.id ?? '')">查看所需地块 Mod</button></div>
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

        <WorkshopTerrainEditor
          v-else
          :editing-entry="editingTerrainEntry"
          :terrain-mods="terrainMods"
          :working="working"
          :upload-terrain-asset="uploadTerrainAsset"
          :download-terrain-asset="downloadTerrainAsset"
          @publish-terrain-mod="emit('publish-terrain-mod', $event)"
        />
    </div>
  </section>
  <ConditionReferenceDialog v-if="showConditionReference" @close="showConditionReference = false" />
</template>

<style scoped>
.workshop-heading-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.workshop-heading-actions>button{width:auto;margin:0;padding:8px 11px;font-size:10px}.condition-reference-entry{border:1px solid rgba(117,211,198,.28);color:#9bddd5;background:rgba(28,76,79,.2)}
.workshop{padding:clamp(18px,3vw,34px);border:1px solid rgba(134,177,205,.3);border-radius:24px;background:linear-gradient(145deg,#1a2c40,#101f31);box-shadow:0 24px 65px rgba(0,6,17,.25)}
.release-history{display:grid;gap:8px}.release-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 11px;border:1px solid rgba(135,175,202,.18);border-radius:9px;background:rgba(4,14,24,.35)}.release-row span,.release-row small{display:block;min-width:0}.release-row b{color:#e1eff8;font-size:12px}.release-row small{margin-top:3px;color:#8298aa;font-size:10px}.release-row button{flex:none;padding:5px 9px;border:1px solid rgba(134,177,205,.25);border-radius:7px;color:#b6d1df;background:#142538;font-size:10px}.release-row button.active{color:#87ead8;border-color:#4eaea9}.terrain-art-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:14px;border:1px solid rgba(118,176,196,.22);border-radius:12px;background:rgba(5,18,30,.35)}.terrain-art-form>div:first-child{grid-column:1/-1}.terrain-art-form>div:first-child strong,.terrain-art-form>div:first-child small,.terrain-art-form label small{display:block}.terrain-art-form>div:first-child strong{color:#e3f3fb;font-size:12px}.terrain-art-form>div:first-child small,.terrain-art-form label small{margin-top:4px;color:#8fa7b9;font-size:10px;line-height:1.5}.terrain-art-form label{display:grid;gap:6px;color:#c6dce8;font-size:11px}.terrain-art-form input[type=file]{width:100%;min-width:0;padding:7px;border:1px solid rgba(127,169,193,.22);border-radius:8px;color:#aec2d0;background:rgba(17,34,49,.8);font-size:10px}.terrain-art-form .terrain-color-label{display:flex;align-items:center;justify-content:space-between}.terrain-art-status{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:7px;color:#91b7bd;font-size:10px}.terrain-art-status button{margin:0;padding:3px 7px;border:1px solid rgba(127,169,193,.25);border-radius:6px;color:#e7adb3;background:rgba(94,38,50,.22);font-size:10px}.terrain-art-form>.form-error{grid-column:1/-1}
.workshop-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:22px}.eyebrow{margin:0 0 5px;color:#7de6d3;font-size:10px;font-weight:900;letter-spacing:.18em}.workshop-heading h2{margin:0;color:#f4f9ff;font-size:clamp(28px,4vw,42px);letter-spacing:-.035em}.workshop-heading p:not(.eyebrow){max-width:650px;margin:7px 0 0;color:#91a9be;font-size:12px;line-height:1.65}.back-button{width:auto;min-width:130px;margin:0;border:1px solid rgba(143,188,206,.32);color:#cde6f1;background:rgba(18,47,65,.5)}
.category-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:16px}.category-nav button{display:flex;align-items:center;gap:12px;min-height:72px;margin:0;padding:13px 17px;border:1px solid rgba(134,177,205,.27);border-radius:14px;color:#cde4f2;background:rgba(8,22,35,.45);text-align:left}.category-nav button.active{border-color:#75dccc;background:rgba(44,103,111,.32);box-shadow:inset 0 -3px #75dccc}.category-icon{font-size:27px;color:#88dcca;line-height:1}.category-nav strong,.category-nav small{display:block}.category-nav strong{font-size:15px}.category-nav small{margin-top:3px;color:#8faabb;font-size:10px}.action-message{padding:10px 13px;border:1px solid rgba(109,221,176,.32);border-radius:10px;color:#9ee9bd;background:rgba(51,106,83,.2);font-size:12px}.action-message.error{border-color:rgba(241,132,149,.4);color:#f4b1ba;background:rgba(112,48,66,.2)}
.workshop-grid{display:grid;grid-template-columns:minmax(240px,.33fr) minmax(0,.67fr);gap:16px;align-items:start}.entry-list-card,.detail-card,.publish-card{min-width:0;padding:18px;border:1px solid rgba(135,175,202,.24);border-radius:18px;background:rgba(8,22,35,.58)}.section-heading{display:flex;justify-content:space-between;gap:10px;align-items:center}.section-heading strong{color:#e6f2fb;font-size:14px}.section-heading span{color:#718da5;font-size:10px}.entry-list{display:grid;gap:8px;margin-top:15px}.entry-button{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:9px;align-items:center;min-height:65px;margin:0;padding:9px 11px;border:1px solid rgba(128,172,195,.2);color:#dbe9f2;background:rgba(32,59,77,.38);text-align:left}.entry-button.selected{border-color:#74dfcf;background:rgba(42,111,116,.25);box-shadow:inset 3px 0 #74dfcf}.entry-symbol{font-size:23px;line-height:1}.terrain-symbol{color:#d8b77e}.map-symbol{color:#88cde5}.entry-copy{min-width:0}.entry-copy strong,.entry-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entry-copy strong{font-size:13px}.entry-copy small{margin-top:4px;color:#8da7b9;font-size:10px}.entry-status{color:#e1a6ad;font-size:10px;white-space:nowrap}.entry-status.installed{color:#99e9bd}.empty-list{margin:17px 0 0;color:#91a8ba;font-size:12px;line-height:1.6}.detail-stack{display:grid;gap:15px}.detail-overline,.title-row,.source-heading,.detail-actions,.submit-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.detail-overline{color:#78b9c7;font-size:9px;font-weight:900;letter-spacing:.12em;overflow-wrap:anywhere}.detail-overline span:last-child{text-align:right}.title-row{align-items:start;margin:12px 0 14px}.title-row h3{margin:0;color:#f3f9ff;font-size:26px}.title-row p{margin:4px 0 0;color:#8eabba;font-size:11px}.status-pill{padding:5px 8px;border:1px solid rgba(243,159,169,.28);border-radius:7px;color:#eba8b1;font-size:10px;white-space:nowrap}.status-pill.installed{border-color:rgba(125,230,175,.32);color:#9ee9be}.description,.readme{margin:12px 0;color:#b6c9d7;font-size:12px;line-height:1.7;white-space:pre-wrap}.terrain-preview-image{display:block;max-width:100%;max-height:250px;margin:15px auto;border:1px solid rgba(138,179,203,.25);border-radius:12px;object-fit:contain}.metadata-block{padding:12px 0;border-top:1px solid rgba(140,180,202,.15)}.metadata-block>strong,.source-heading strong{color:#dcebf4;font-size:12px}.token-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}.token-list code{padding:5px 8px;border:1px solid rgba(126,198,194,.25);border-radius:7px;color:#9adfd9;background:rgba(34,84,89,.2);font-size:10px}.quiet{margin:9px 0 0;color:#829db1;font-size:11px;line-height:1.5}.source-heading{padding-top:14px;border-top:1px solid rgba(140,180,202,.15)}.source-heading span{color:#7997a9;font-size:10px}.source-tabs{display:flex;gap:6px;max-width:100%;overflow:auto;margin-top:10px}.source-tabs button{width:auto;min-width:max-content;margin:0;padding:6px 9px;border:1px solid rgba(127,172,193,.3);color:#a7c1d1;background:#152c3d;font:10px ui-monospace,Consolas,monospace}.source-tabs button.active{border-color:#78dfd0;color:#c7f4ee}.source-code{max-height:330px;overflow:auto;margin:9px 0 0;padding:13px;border:1px solid rgba(125,167,191,.26);border-radius:10px;background:#0b1928;color:#d7e9f1;font:11px/1.6 ui-monospace,Consolas,monospace;white-space:pre}.source-empty{margin:12px 0 0;color:#819db0;font-size:11px}
.map-preview{display:grid;place-items:center;height:clamp(245px,30vw,370px);overflow:hidden;border:1px solid rgba(128,170,194,.27);border-radius:14px;background:#19293a}.map-preview svg{width:100%;height:100%;padding:12px}.preview-unavailable{display:grid;place-items:center;min-height:200px;padding:20px;border:1px solid rgba(128,170,194,.27);border-radius:14px;color:#8fa7ba;text-align:center;font-size:12px}.preview-caption{margin:8px 0 13px;color:#8da7b9;font-size:10px}.dependency-block{border-bottom:1px solid rgba(140,180,202,.15)}.dependency-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.dependency{display:grid;gap:3px;min-width:150px;padding:8px 10px;border:1px solid rgba(121,211,181,.28);border-radius:9px;background:rgba(38,92,76,.19)}.dependency.missing{border-color:rgba(239,157,164,.3);background:rgba(108,46,62,.18)}.dependency b{color:#e6f1ef;font-size:11px}.dependency code{color:#86b0bc;font-size:10px}.dependency em{color:#9fe2b7;font-size:10px;font-style:normal}.dependency.missing em{color:#f0a7b2}.dependency-warning{margin:10px 0;color:#f0a7b2;font-size:11px;line-height:1.6}.detail-actions{justify-content:flex-start;flex-wrap:wrap;margin-top:13px}.detail-actions button{width:auto;min-height:41px;margin:0}.primary-button{background:linear-gradient(120deg,#81e9ce,#70c9e7)}.outline-button{border:1px solid rgba(141,184,205,.3);color:#b9d4e4;background:rgba(27,54,73,.55)}.copy-message{margin:8px 0 0;color:#8de6bd;font-size:11px}.code-field,.publish-card input{box-sizing:border-box;width:100%;border:1px solid rgba(136,177,204,.31);border-radius:10px;outline:none;background:#0c1b2b;color:#d6e8f0;font:11px/1.6 ui-monospace,Consolas,monospace}.code-field{min-height:110px;padding:11px;resize:vertical}.code-field:focus,.publish-card input:focus{border-color:#76ddcc;box-shadow:0 0 0 3px rgba(118,221,204,.08)}.map-code{margin-top:10px}.publish-card>p{margin:10px 0 15px;color:#91adbd;font-size:11px;line-height:1.6}.publish-card label{display:grid;gap:6px;margin-top:11px;color:#b7ceda;font-size:11px;font-weight:700}.publish-card input{height:39px;padding:0 10px;font:12px system-ui,sans-serif}.source-input{min-height:180px}.submit-row{justify-content:flex-end;align-items:flex-end;margin-top:12px}.submit-row .primary-button{width:auto;min-width:135px;margin:0}.form-error{flex:1;color:#f2a9b4;font-size:11px;line-height:1.5}
@media(max-width:850px){.workshop-grid{grid-template-columns:1fr}.entry-list{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}}@media(max-width:570px){.workshop{padding:15px}.workshop-heading{display:grid}.workshop-heading-actions{justify-content:flex-start}.back-button{min-height:42px}.category-nav button{padding:11px;min-height:64px}.category-icon{font-size:21px}.category-nav strong{font-size:13px}.entry-list-card,.detail-card,.publish-card{padding:13px}.title-row h3{font-size:23px}.detail-actions button{width:100%}.map-preview{height:250px}}
.workshop-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:18px 0 13px}.workshop-toolbar strong{color:#e6f2fb;font-size:16px}.workshop-toolbar p{max-width:750px;margin:5px 0 0;color:#93adbf;font-size:11px;line-height:1.6}.publish-entry{width:auto;min-width:160px;margin:0;padding:9px 13px;white-space:nowrap}.read-only-note{color:#aac5d5;font-size:11px}
.workshop-catalog{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}.workshop-work-card{display:block;width:100%;min-width:0;margin:0;padding:0;overflow:hidden;border:1px solid rgba(135,175,202,.24);border-radius:17px;color:#e8f2f9;background:rgba(8,22,35,.67);text-align:left;transition:border-color .18s,transform .18s,background .18s}.workshop-work-card:hover,.workshop-work-card:focus-visible{border-color:#79ddcd;background:rgba(16,40,55,.87);transform:translateY(-2px)}.core-terrain-card{cursor:default}.core-terrain-card:hover{border-color:rgba(135,175,202,.34);background:rgba(8,22,35,.75);transform:none}.work-card-preview{display:grid;place-items:center;height:165px;overflow:hidden;background:#182638}.work-card-preview svg{width:100%;height:100%;padding:13px}.terrain-card-preview{background:radial-gradient(circle at 50% 45%,rgba(238,178,93,.22),transparent 46%),#182638}.terrain-card-preview :deep(.terrain-art-tile){width:78px;height:88px}.terrain-card-preview :deep(.custom-art){max-width:160px;max-height:145px;object-fit:contain}.generic-terrain-mark{color:#dba861;font-size:100px;line-height:1}.thumbnail-placeholder{color:#86a7bb;font-size:11px}.work-card-info{display:grid;gap:8px;padding:13px 14px 15px}.work-card-title{display:flex;justify-content:space-between;align-items:center;gap:9px}.work-card-title strong{overflow:hidden;color:#eef6fb;font-size:16px;text-overflow:ellipsis;white-space:nowrap}.work-card-title em{flex:none;color:#efadb7;font-size:10px;font-style:normal}.work-card-title em.installed{color:#a1eabc}.core-terrain-badge{padding:3px 7px;border:1px solid rgba(222,188,122,.28);border-radius:99px;color:#e3c88d!important;background:rgba(164,117,49,.12);font-size:9px!important;white-space:nowrap}.work-card-description{display:-webkit-box;min-height:35px;overflow:hidden;color:#b4c9d7;font-size:11px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:2}.work-card-info small{color:#86a3b5;font-size:10px}.workshop-catalog>.empty-list{grid-column:1/-1;padding:28px;border:1px dashed rgba(135,175,202,.3);border-radius:14px;text-align:center}
.detail-stack{max-width:920px;margin:0 auto}.catalog-back{width:auto;justify-self:start;margin:0;padding:7px 12px;border:1px solid rgba(143,188,206,.28);color:#c6e3ef;background:rgba(18,47,65,.45);font-size:11px}.map-preview{height:clamp(270px,34vw,450px)}.map-preview :deep(.board-canvas){height:100%;border:none;border-radius:0}.install-unavailable{color:#e6bba7;font-size:11px;line-height:1.5}.dependency-warning{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:11px;border:1px solid rgba(239,157,164,.3);border-radius:10px;background:rgba(108,46,62,.16)}.dependency-warning button{width:auto;margin:0;padding:7px 10px;font-size:11px}
@media(max-width:570px){.workshop-toolbar{align-items:stretch;flex-direction:column}.publish-entry{width:100%}.workshop-catalog{grid-template-columns:1fr}.work-card-preview{height:155px}.map-preview{height:280px}}
.terrain-card-preview{position:relative;isolation:isolate;height:112px;background:#182638}.terrain-card-preview::before{display:none}.terrain-preview-image{max-width:min(100%,180px);max-height:140px;margin:12px auto}
.terrain-card-preview :deep(.terrain-art-collection){gap:8px;padding:6px}.terrain-card-preview :deep(.terrain-art-item){width:68px;font-size:8px}.terrain-card-preview :deep(.terrain-art-svg){width:68px;height:79px}.capability-picker{position:relative;margin-top:7px;border:1px solid rgba(136,177,204,.31);border-radius:10px;background:#0c1b2b}.capability-picker>summary{display:flex;justify-content:space-between;align-items:center;min-height:40px;padding:0 12px;color:#cce1ec;font-size:12px;cursor:pointer;list-style:none}.capability-picker>summary::-webkit-details-marker{display:none}.capability-picker[open]>summary{border-bottom:1px solid rgba(136,177,204,.2)}

.definition-preview { max-height: 360px; overflow: auto; margin: 10px 0; padding: 14px; border: 1px solid rgba(125,167,191,.26); border-radius: 10px; background: #0b1928; color: #d7e9f1; font: 11px/1.6 ui-monospace, Consolas, monospace; white-space: pre; }
.terrain-detail-preview { display: grid; place-items: center; min-height: 176px; margin: 13px 0; border: 1px solid rgba(138,179,203,.25); border-radius: 12px; background: radial-gradient(circle at 50% 42%,rgba(238,178,93,.16),transparent 48%),#182638; }
.terrain-detail-preview :deep(.terrain-art-collection) { align-self: stretch; }
.unsubscribe-button{width:auto;min-height:41px;margin:0;padding:8px 12px;border:1px solid rgba(238,151,164,.35);border-radius:9px;color:#f0b4bd;background:rgba(112,48,66,.24)}
.unsubscribe-button:disabled{opacity:.5;cursor:not-allowed}
.list-pagination{display:flex;justify-content:center;align-items:center;gap:12px;margin:18px auto 0;color:#9db3c4;font-size:11px}
.list-pagination button{min-height:34px;padding:6px 12px;border:1px solid rgba(143,188,206,.28);border-radius:8px;color:#cde6f1;background:rgba(18,47,65,.58)}
.list-pagination button:disabled{opacity:.42;cursor:not-allowed}
.list-pagination span{min-width:145px;text-align:center}
.map-card-preview :deep(.board-canvas){width:100%;height:100%;min-height:0;border:0;border-radius:0;background:#182638}

.release-row{align-items:center}.release-row>span{flex:1;min-width:0}.release-row button{width:auto;min-width:96px;flex:none;margin:0;white-space:nowrap}
.release-row button:hover{border-color:#75dccc;color:#9af2df}
.required-tag{display:inline-flex;align-items:center;margin-left:5px;padding:2px 6px;border:1px solid;border-radius:999px;font-size:8px;font-weight:800;line-height:1.35;vertical-align:1px}
.required-tag{border-color:rgba(236,142,147,.35);color:#f0afb5;background:rgba(130,47,58,.19)}
</style>
