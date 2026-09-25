<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getPoweredUnitIds, type GameState, type UnitId } from "@numeral-lord/game-core";
import { createMatchFromMapCode, type MapDefinition } from "@numeral-lord/core-content";
import { missingTerrainMods, type ConfiguredMap } from "../map-library";
import { installedMapCatalogs, installedTerrainCatalog } from "../installed-content";
import HexBoard from "./HexBoard.vue";
import MapEditor from "./MapEditor.vue";

const props = defineProps<{ maps: readonly ConfiguredMap[]; selectedId: string; actionMessage: string; actionError: boolean }>();
const emit = defineEmits<{
  back: []; select: [id: string]; add: [code: string]; save: [definition: MapDefinition]; remove: [id: string];
}>();

type View = "library" | "detail" | "import" | "editor";
const view = ref<View>("library");
const codeDraft = ref("");
const showCode = ref(false);
const confirmRemoveId = ref<string | null>(null);
const copyStatus = ref("");
const codeField = ref<HTMLTextAreaElement | null>(null);
const editingDefinition = ref<MapDefinition | null>(null);
const selected = computed(() => props.maps.find((map) => map.definition.id === props.selectedId) ?? props.maps[0]);
const selectedMissingMods = computed(() => selected.value ? missingTerrainMods(selected.value) : []);
watch(() => props.selectedId, () => { showCode.value = false; copyStatus.value = ""; });
const previewState = computed<GameState | null>(() => {
  if (!selected.value) return null;
  try { return createMatchFromMapCode(selected.value.code, installedMapCatalogs); } catch { return null; }
});
const previewPoweredUnitIds = computed(() => previewState.value ? [...getPoweredUnitIds(previewState.value, installedTerrainCatalog)] : []);
const cardPreviews = computed(() => new Map(props.maps.flatMap((map) => {
  try {
    const state = createMatchFromMapCode(map.code, installedMapCatalogs);
    return [[map.definition.id, { state, poweredUnitIds: [...getPoweredUnitIds(state, installedTerrainCatalog)] }] as const];
  } catch {
    // Unknown terrain Mod data cannot be rendered faithfully. Show an explicit
    // dependency placeholder instead of drawing a misleading substitute map.
    return [];
  }
})));
function cardPreview(map: ConfiguredMap): { state: GameState; poweredUnitIds: readonly UnitId[] } | undefined {
  return cardPreviews.value.get(map.definition.id);
}
function selectMap(id: string): void { emit("select", id); view.value = "detail"; }
function startCreate(): void { editingDefinition.value = null; view.value = "editor"; }
function startEdit(): void {
  if (!selected.value) return;
  editingDefinition.value = selected.value.isDefault
    ? { ...selected.value.definition, id: `custom-${Date.now().toString(36)}`, name: `${selected.value.definition.name} 副本` }
    : selected.value.definition;
  view.value = "editor";
}
function saveDefinition(definition: MapDefinition): void { emit("save", definition); view.value = "library"; }
function addMap(): void { emit("add", codeDraft.value.trim()); }
function clearCodeDraft(): void { codeDraft.value = ""; }
async function copyCode(): Promise<void> {
  if (!selected.value) return;
  try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(selected.value.code); copyStatus.value = "地图码已复制"; return; }
  catch { showCode.value = true; await new Promise((resolve) => requestAnimationFrame(resolve)); codeField.value?.focus(); codeField.value?.select();
    try { if (document.execCommand("copy")) { copyStatus.value = "地图码已复制"; return; } } catch { /* Keep the selected code visible. */ }
    copyStatus.value = "已选中地图码，请手动复制"; }
}
function requestRemove(): void { if (selected.value && !selected.value.isDefault) confirmRemoveId.value = selected.value.definition.id; }
function confirmRemove(): void { if (confirmRemoveId.value) emit("remove", confirmRemoveId.value); confirmRemoveId.value = null; view.value = "library"; }
defineExpose({ clearCodeDraft });
</script>

<template>
  <section class="map-library" :class="{ 'editing-map': view === 'editor' }">
    <header class="library-heading">
      <div><p class="kicker">MAP LIBRARY</p><h2>地图配置</h2><p>地图保存在当前浏览器；你可以导入地图码，或直接创建和编辑地图。</p></div>
      <div class="heading-actions"><button v-if="view !== 'library'" class="outline-button" @click="view = 'library'">← 返回地图库</button><button class="back-link" @click="emit('back')">返回主页</button></div>
    </header>

    <template v-if="view === 'library'">
      <div class="library-toolbar"><div><strong>我的地图</strong><span>{{ maps.length }} 张 · 仅保存在本机</span></div><div><button class="outline-button" @click="view = 'import'">导入地图</button><button class="primary-button" @click="startCreate">＋ 创建地图</button></div></div>
      <p v-if="actionMessage" class="action-message" :class="{ error: actionError }" role="status">{{ actionMessage }}</p>
      <div class="map-cards">
        <button v-for="map in maps" :key="map.definition.id" class="map-card" @click="selectMap(map.definition.id)">
          <span class="map-card-preview" role="img" :aria-label="`${map.definition.name} 地图预览`"><template v-if="cardPreview(map)"><HexBoard preview :show-unit-labels="false" :state="cardPreview(map)!.state" :selected-unit-id="null" :legal-action-cell-ids="[]" :actionable-unit-ids="[]" :powered-unit-ids="cardPreview(map)!.poweredUnitIds" /></template><span v-else class="thumbnail-missing-mod">安装地图依赖的 Mod 后可预览</span><em>{{ map.definition.columns }} × {{ map.definition.terrain.length / map.definition.columns }}</em></span>
          <span class="map-card-body"><span class="card-title"><strong>{{ map.definition.name }}</strong><small>个人地图</small></span><span class="card-description">{{ map.definition.players }} 个玩家位 · {{ map.definition.requiredTerrainModIds.length ? `依赖 ${map.definition.requiredTerrainModIds.length} 个 Mod` : '无需额外 Mod' }}</span><span v-if="missingTerrainMods(map).length" class="card-warning">缺少 Mod：{{ missingTerrainMods(map).join('、') }}</span><span class="card-footer">地图 v{{ map.definition.version }}<span>查看详情 →</span></span></span>
        </button>
        <div v-if="maps.length === 0" class="empty-card"><strong>还没有个人地图</strong><p>导入地图码，或创建并绘制一张地图。创建对战房间前需要先准备至少一张地图。</p><div><button class="outline-button" @click="view = 'import'">导入地图</button><button class="outline-button" @click="startCreate">创建地图</button></div></div>
      </div>
    </template>

    <template v-else-if="view === 'detail' && selected">
      <article class="map-detail">
        <div class="detail-topline"><span>{{ selected.isDefault ? 'BUILT-IN MAP' : 'PERSONAL MAP' }}</span><span>ID {{ selected.definition.id }}</span></div>
        <div class="detail-title"><div><h3>{{ selected.definition.name }}</h3><p>{{ selected.definition.columns }} × {{ selected.definition.terrain.length / selected.definition.columns }} 格 · {{ selected.definition.players }} 个玩家位 · {{ selected.definition.soldiers.length }} 个初始单位</p></div><span class="version-badge">地图码 v{{ selected.definition.version }}</span></div>
        <p class="dependency-line">需要地块 Mod：{{ selected.definition.requiredTerrainModIds.length ? selected.definition.requiredTerrainModIds.join('、') : '无' }}</p>
        <p v-if="selectedMissingMods.length" class="missing-mod-note" role="status">尚未安装 {{ selectedMissingMods.join('、') }}；安装所需 Mod 后即可完整预览和开局。</p>
        <div v-if="previewState" class="detail-board"><HexBoard preview :state="previewState" :selected-unit-id="null" :legal-action-cell-ids="[]" :actionable-unit-ids="[]" :powered-unit-ids="previewPoweredUnitIds" /></div><div v-else class="preview-fallback">暂时无法完整预览；请先安装地图依赖的 Mod。</div>
        <div class="detail-actions"><button class="primary-button" @click="copyCode">复制地图码 ↗</button><button class="outline-button" :disabled="selectedMissingMods.length > 0" :title="selectedMissingMods.length ? '先安装地图依赖的 Mod，避免编辑时丢失未知地形' : ''" @click="startEdit">编辑地图</button><button class="outline-button" @click="showCode = !showCode">{{ showCode ? '收起地图码' : '显示地图码' }}</button><button v-if="!selected.isDefault" class="remove-button" @click="requestRemove">删除</button></div>
        <p v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</p><textarea v-if="showCode" ref="codeField" class="code-output" readonly :value="selected.code" aria-label="地图码" @focus="($event.target as HTMLTextAreaElement).select()" />
      </article>
    </template>

    <template v-else-if="view === 'import'">
      <article class="import-card"><div class="import-head"><div><h3>导入地图</h3><p>地图码只在你点击“显示地图码”或“复制地图码”时出现，不会占据地图库页面。</p></div><button class="outline-button" @click="startCreate">打开地图编辑器</button></div><label for="map-code">地图码</label><textarea id="map-code" v-model="codeDraft" class="code-input" spellcheck="false" placeholder="粘贴地图码 JSON…" /><div class="import-bottom"><span :class="{ error: actionError }" role="status">{{ actionMessage }}</span><button class="primary-button" :disabled="!codeDraft.trim()" @click="addMap">导入到我的地图</button></div></article>
    </template>
    <MapEditor v-else-if="view === 'editor'" :initial="editingDefinition" @save="saveDefinition" @cancel="view = 'library'" />

    <div v-if="confirmRemoveId" class="confirm-backdrop" @click.self="confirmRemoveId = null"><div class="confirm-dialog" role="dialog" aria-modal="true" aria-label="移除地图"><h3>从本机移除地图？</h3><p>这只会删除当前浏览器中的个人地图，不会影响已复制的地图码或创意工坊作品。</p><div><button class="outline-button" @click="confirmRemoveId = null">取消</button><button class="danger-button" @click="confirmRemove">移除地图</button></div></div></div>
  </section>
</template>

<style scoped>
.map-library{padding:clamp(18px,3vw,34px);border:1px solid rgba(134,177,205,.3);border-radius:24px;background:linear-gradient(145deg,#1a2c40,#101f31);box-shadow:0 24px 65px rgba(0,6,17,.25)}.library-heading,.heading-actions,.library-toolbar,.library-toolbar>div,.detail-topline,.detail-title,.detail-actions,.import-head,.import-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px}.library-heading{align-items:flex-start;margin-bottom:21px}.kicker{margin:0 0 5px;color:#7de6d3;font-size:10px;font-weight:900;letter-spacing:.18em}.library-heading h2{margin:0;color:#f4f9ff;font-size:clamp(28px,4vw,42px);letter-spacing:-.035em}.library-heading p:not(.kicker){margin:7px 0 0;color:#91a9be;font-size:12px;line-height:1.6}.back-link,.outline-button,.primary-button,.danger-button{width:auto;min-height:39px;margin:0;padding:8px 13px;border:1px solid rgba(143,188,206,.32);border-radius:9px;color:#cde6f1;background:rgba(18,47,65,.5);white-space:nowrap}.primary-button{border:0;color:#092332;background:linear-gradient(120deg,#81e9ce,#70c9e7);font-weight:800}.library-toolbar{padding:12px 14px;border:1px solid rgba(135,175,202,.2);border-radius:13px;background:rgba(8,22,35,.48)}.library-toolbar>div:first-child{align-items:flex-start;flex-direction:column;gap:3px}.library-toolbar strong{color:#e6f2fb;font-size:14px}.library-toolbar span{color:#829db1;font-size:10px}.map-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:14px;margin-top:15px}.map-card{display:block;overflow:hidden;width:100%;margin:0;padding:0;border:1px solid rgba(135,175,202,.24);border-radius:16px;color:#e8f2f9;background:rgba(8,22,35,.67);text-align:left;transition:border-color .18s,transform .18s}.map-card:hover,.map-card:focus-visible{border-color:#79ddcd;transform:translateY(-2px);outline:none}.map-card-preview{position:relative;display:grid;place-items:center;height:170px;overflow:hidden;background:#182638}.map-card-preview svg{width:100%;height:100%;padding:14px}.map-card-preview em{position:absolute;right:9px;bottom:8px;padding:4px 7px;border:1px solid rgba(150,193,214,.24);border-radius:6px;color:#a9c5d5;background:#0d1b2a;font-size:9px;font-style:normal}.map-card-body{display:grid;gap:9px;padding:13px 14px 14px}.card-title,.card-footer{display:flex;align-items:center;justify-content:space-between;gap:9px}.card-title strong{overflow:hidden;color:#eef6fb;font-size:16px;text-overflow:ellipsis;white-space:nowrap}.card-title small{flex:none;color:#8edec9;font-size:9px}.card-description{color:#b4c9d7;font-size:11px}.card-warning{overflow:hidden;color:#efba7e;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.card-footer{padding-top:7px;border-top:1px solid rgba(140,180,202,.13);color:#829db1;font-size:9px}.card-footer span{color:#8ce1d0;font-size:10px}.empty-card{display:grid;align-content:center;justify-items:start;min-height:270px;padding:22px;border:1px dashed rgba(135,175,202,.3);border-radius:15px;background:rgba(8,22,35,.27)}.empty-card strong{color:#e6f2fb;font-size:15px}.empty-card p{color:#8fa9bc;font-size:11px;line-height:1.6}.map-detail,.import-card{padding:clamp(14px,2vw,21px);border:1px solid rgba(135,175,202,.24);border-radius:17px;background:rgba(8,22,35,.58)}.detail-topline{color:#78b9c7;font-size:9px;font-weight:900;letter-spacing:.16em}.detail-title{align-items:end;margin:11px 0 12px}.detail-title h3{margin:0;color:#f3f9ff;font-size:27px}.detail-title p{margin:5px 0 0;color:#8eabba;font-size:11px}.version-badge{padding:5px 8px;border:1px solid rgba(133,190,201,.25);border-radius:7px;color:#86d9cf;font-size:9px;white-space:nowrap}.dependency-line,.missing-mod-note{margin:0 0 11px;color:#b4d9e5;font-size:11px}.missing-mod-note{color:#f0c38a;line-height:1.6}.detail-board{height:clamp(245px,32vw,460px);padding:5px;border:1px solid rgba(138,179,203,.25);border-radius:12px;background:#19293a}.preview-fallback{display:grid;place-items:center;min-height:190px;color:#8fa3b9}.detail-actions{justify-content:flex-start;flex-wrap:wrap;margin-top:13px}.remove-button{margin-left:auto;border-color:rgba(251,153,158,.22);color:#eaa1aa;background:rgba(100,39,52,.2)}.copy-status{color:#8de6bd;font-size:11px}.code-output,.code-input{box-sizing:border-box;width:100%;resize:vertical;border:1px solid rgba(136,177,204,.31);border-radius:10px;outline:none;background:#0c1b2b;color:#c9e3ed;font:11px/1.6 ui-monospace,Consolas,monospace}.code-output{min-height:92px;margin-top:10px;padding:11px}.import-head{align-items:flex-start}.import-head h3{margin:0;color:#f3f9ff;font-size:22px}.import-head p,.import-card label{color:#8fa9bc;font-size:11px;line-height:1.6}.import-card label{display:block;margin:13px 0 6px}.code-input{min-height:210px;padding:12px}.import-bottom{margin-top:10px}.import-bottom span{color:#8faaa9;font-size:11px}.import-bottom span.error,.action-message.error{color:#f4a3ab}.import-bottom button:disabled{opacity:.45}.action-message{padding:10px 13px;border:1px solid rgba(109,221,176,.32);border-radius:10px;color:#9ee9bd;background:rgba(51,106,83,.2);font-size:12px}.confirm-backdrop{position:fixed;z-index:30;inset:0;display:grid;place-items:center;padding:15px;background:rgba(2,11,21,.7)}.confirm-dialog{width:min(430px,100%);padding:21px;border:1px solid rgba(145,184,204,.4);border-radius:16px;background:#1a2b3f;box-shadow:0 26px 70px rgba(0,0,0,.4)}.confirm-dialog h3{margin:0;color:#f4f8ff}.confirm-dialog p{color:#a9bdd0;font-size:12px;line-height:1.7}.confirm-dialog>div{display:flex;gap:10px}.danger-button{color:#fff;background:#a14d61}@media(max-width:620px){.library-heading{display:grid}.heading-actions{flex-wrap:wrap}.library-toolbar{align-items:flex-start}.library-toolbar>div:last-child{align-items:flex-end;flex-direction:column}.map-cards{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}.map-card-preview{height:145px}.detail-board{height:270px}.import-head{display:grid}.import-bottom{align-items:stretch;flex-direction:column}.import-bottom button{width:100%}}
.empty-card>div{display:flex;gap:8px;flex-wrap:wrap}.map-card-preview{display:block}.map-card-preview :deep(.board-canvas){width:100%;height:100%;min-height:0;border:0;border-radius:0;background:#182638}.thumbnail-missing-mod{display:grid;height:100%;place-items:center;padding:12px;color:#a9bdd0;text-align:center;font-size:10px;background:#182638}.map-library.editing-map{position:static;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}.map-library.editing-map>.library-heading{display:none}
</style>
