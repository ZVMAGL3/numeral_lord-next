<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getPoweredUnitIds, type GameState } from "@numeral-lord/game-core";
import {
  createMatchFromMapCode
} from "@numeral-lord/core-content";
import { missingTerrainMods, type ConfiguredMap } from "../map-library";
import { installedMapCatalogs, installedTerrainCatalog } from "../installed-content";
import HexBoard from "./HexBoard.vue";

const props = defineProps<{
  maps: readonly ConfiguredMap[];
  selectedId: string;
  actionMessage: string;
  actionError: boolean;
}>();

const emit = defineEmits<{
  back: [];
  select: [id: string];
  add: [code: string];
  remove: [id: string];
}>();

const codeDraft = ref("");
const showCode = ref(false);
const confirmRemoveId = ref<string | null>(null);
const copyStatus = ref("");
const codeField = ref<HTMLTextAreaElement | null>(null);
const selected = computed(() => props.maps.find((map) => map.definition.id === props.selectedId) ?? props.maps[0]);
const selectedMissingMods = computed(() => selected.value ? missingTerrainMods(selected.value) : []);
watch(() => props.selectedId, () => {
  showCode.value = false;
  copyStatus.value = "";
  confirmRemoveId.value = null;
});
const previewState = computed<GameState | null>(() => {
  if (!selected.value) return null;
  try { return createMatchFromMapCode(selected.value.code, installedMapCatalogs); } catch { return null; }
});
const previewPoweredUnitIds = computed(() => previewState.value
  ? [...getPoweredUnitIds(previewState.value, installedTerrainCatalog)]
  : []);

function selectMap(id: string): void {
  showCode.value = false;
  copyStatus.value = "";
  confirmRemoveId.value = null;
  emit("select", id);
}

function addMap(): void {
  emit("add", codeDraft.value.trim());
}

function clearCodeDraft(): void {
  codeDraft.value = "";
}

async function copyCode(): Promise<void> {
  if (!selected.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(selected.value.code);
    copyStatus.value = "地图码已复制";
    return;
  } catch {
    // HTTP public previews may not expose navigator.clipboard.
    showCode.value = true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    codeField.value?.focus();
    codeField.value?.select();
    try {
      if (document.execCommand("copy")) {
        copyStatus.value = "地图码已复制";
        return;
      }
    } catch { /* Keep the selected text visible for manual copying. */ }
    copyStatus.value = "已选中地图码，请手动复制";
  }
}

function requestRemove(): void {
  if (!selected.value || selected.value.isDefault) return;
  confirmRemoveId.value = selected.value.definition.id;
}

function confirmRemove(): void {
  if (!confirmRemoveId.value) return;
  emit("remove", confirmRemoveId.value);
  confirmRemoveId.value = null;
}

defineExpose({ clearCodeDraft });
</script>

<template>
  <section class="map-library">
    <header class="library-heading">
      <div>
        <p class="kicker">MAP LIBRARY</p>
        <h2>地图配置</h2>
        <p>保存自己的地图码，在准备房间中选择。地图编辑器会在后续加入。</p>
      </div>
      <button class="back-link" @click="emit('back')"><span aria-hidden="true">←</span> 返回主页</button>
    </header>

    <div class="library-grid">
      <aside class="map-list-panel">
        <div class="section-line"><strong>我的地图</strong><span>{{ maps.length }} 张</span></div>
        <div class="map-list">
          <button
            v-for="map in maps"
            :key="map.definition.id"
            class="map-list-item"
            :class="{ active: map.definition.id === selected?.definition.id }"
            @click="selectMap(map.definition.id)"
          >
            <span class="map-icon" aria-hidden="true">⬡</span>
            <span class="map-list-copy"><strong>{{ map.definition.name }}</strong><small>{{ map.isDefault ? '内置地图' : '我的地图' }} · {{ map.definition.players }} 个玩家位</small></span>
            <span class="map-chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <p class="local-note">自定义地图保存在当前浏览器。开房时选择地图，房间会将完整地图码同步给其他玩家。</p>
      </aside>

      <div class="map-detail-column">
        <article v-if="selected" class="map-detail">
          <div class="detail-topline"><span>{{ selected.isDefault ? 'BUILT-IN MAP' : 'CUSTOM MAP' }}</span><span>ID {{ selected.definition.id }}</span></div>
          <div class="detail-title"><div><h3>{{ selected.definition.name }}</h3><p>{{ selected.definition.columns }} × {{ selected.definition.terrain.length / selected.definition.columns }} 格 · {{ selected.definition.players }} 个玩家位</p></div><span class="version-badge">地图码 v{{ selected.definition.version }}</span></div>
          <p class="dependency-line">需要地块 Mod：{{ selected.definition.requiredTerrainModIds.length ? selected.definition.requiredTerrainModIds.join('、') : '无' }}</p>
          <p v-if="selectedMissingMods.length" class="missing-mod-note" role="status">尚未安装 {{ selectedMissingMods.join('、') }}；地图码可以保存，安装地块 Mod 后才能预览和对局。</p>
          <div v-if="previewState" class="detail-board">
            <HexBoard
              preview
              :state="previewState"
              :selected-unit-id="null"
              :legal-action-cell-ids="[]"
              :actionable-unit-ids="[]"
              :powered-unit-ids="previewPoweredUnitIds"
            />
          </div>
          <div v-else class="preview-fallback">这张地图暂时无法预览。</div>
          <div class="detail-actions">
            <button class="copy-button" @click="copyCode">复制地图码 <span aria-hidden="true">↗</span></button>
            <button class="outline-button" @click="showCode = !showCode">{{ showCode ? '收起地图码' : '查看地图码' }}</button>
            <button v-if="!selected.isDefault" class="remove-button" @click="requestRemove">移除</button>
          </div>
          <p v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</p>
          <textarea v-if="showCode" ref="codeField" class="code-output" readonly :value="selected.code" aria-label="当前地图码" @focus="($event.target as HTMLTextAreaElement).select()" />
        </article>

        <article class="import-card">
          <div class="section-line"><strong>导入地图码</strong><span>暂不支持可视化编辑</span></div>
          <p>粘贴完整地图码，验证成功后保存在本机。房主可在准备房间中切换。</p>
          <textarea v-model="codeDraft" class="code-input" spellcheck="false" placeholder="在这里粘贴地图码…" aria-label="导入地图码" />
          <div class="import-bottom"><span :class="{ error: actionError }" role="status">{{ actionMessage }}</span><button :disabled="!codeDraft.trim()" @click="addMap">添加到我的地图</button></div>
        </article>
      </div>
    </div>

    <div v-if="confirmRemoveId" class="confirm-backdrop" @click.self="confirmRemoveId = null">
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-label="移除地图">
        <h3>从本机移除地图？</h3>
        <p>这只会移除浏览器保存的配置。已复制的地图码仍可重新导入。</p>
        <div><button class="outline-button" @click="confirmRemoveId = null">取消</button><button class="danger-button" @click="confirmRemove">移除地图</button></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.map-library { padding: clamp(18px, 3vw, 34px); border: 1px solid rgba(134, 177, 205, .3); border-radius: 24px; background: linear-gradient(145deg, #1a2c40, #101f31); box-shadow: 0 24px 65px rgba(0,6,17,.25); }
.library-heading, .section-line, .detail-topline, .detail-title, .detail-actions, .import-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.library-heading { align-items: flex-start; margin-bottom: 24px; }.kicker { margin: 0 0 5px; color: #7de6d3; font-size: 10px; font-weight: 900; letter-spacing: .18em; }.library-heading h2 { margin: 0; color: #f4f9ff; font-size: clamp(28px, 4vw, 42px); letter-spacing: -.035em; }.library-heading p:not(.kicker) { margin: 7px 0 0; color: #91a9be; font-size: 12px; line-height: 1.6; }
.back-link { width: auto; min-width: 130px; margin: 0; border: 1px solid rgba(143, 188, 206, .32); color: #cde6f1; background: rgba(18,47,65,.5); }
.back-link span { margin-right: 5px; }
.library-grid { display: grid; grid-template-columns: minmax(240px, .32fr) minmax(0, .68fr); gap: 17px; align-items: start; }
.map-list-panel, .map-detail, .import-card { padding: 18px; border: 1px solid rgba(135, 175, 202, .24); border-radius: 18px; background: rgba(8, 22, 35, .58); }
.section-line strong { color: #e6f2fb; font-size: 14px; }.section-line span { color: #718da5; font-size: 10px; }
.map-list { display: grid; gap: 8px; margin-top: 15px; }.map-list-item { display: grid; grid-template-columns: 28px 1fr 12px; gap: 9px; align-items: center; min-height: 65px; margin: 0; padding: 9px 11px; border: 1px solid rgba(128, 172, 195, .2); text-align: left; color: #dbe9f2; background: rgba(32,59,77,.38); }.map-list-item.active { border-color: #74dfcf; background: rgba(42, 111, 116, .25); box-shadow: inset 3px 0 #74dfcf; }.map-icon { color: #78dfd1; font-size: 22px; }.map-list-copy { min-width: 0; }.map-list-copy strong,.map-list-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.map-list-copy strong { font-size: 13px; }.map-list-copy small { margin-top: 4px; color: #7f9cb2; font-size: 10px; }.map-chevron { color: #83a5b5; font-size: 22px; }
.local-note { margin: 17px 2px 0; color: #738fa6; font-size: 10px; line-height: 1.7; }
.map-detail-column { display: grid; gap: 15px; min-width: 0; }.detail-topline { color: #78b9c7; font-size: 9px; font-weight: 900; letter-spacing: .16em; }.detail-title { align-items: end; margin: 11px 0 14px; }.detail-title h3 { margin: 0; color: #f3f9ff; font-size: 27px; }.detail-title p { margin: 5px 0 0; color: #8eabba; font-size: 11px; }.version-badge { padding: 5px 8px; border: 1px solid rgba(133, 190, 201, .25); border-radius: 7px; color: #86d9cf; font-size: 9px; white-space: nowrap; }
.detail-board { height: clamp(240px, 29vw, 370px); }.preview-fallback { display: grid; place-items: center; height: 240px; color: #8fa3b9; }.detail-actions { justify-content: flex-start; flex-wrap: wrap; margin-top: 13px; }.detail-actions button { width: auto; min-height: 40px; margin: 0; }.copy-button { min-width: 145px; background: linear-gradient(120deg, #81e9ce, #70c9e7); }.copy-button span { margin-left: 7px; }.outline-button { border: 1px solid rgba(141, 184, 205, .3); color: #b9d4e4; background: rgba(27, 54, 73, .55); }.remove-button { margin-left: auto !important; border: 1px solid rgba(251, 153, 158, .22); color: #eaa1aa; background: rgba(100, 39, 52, .2); }.copy-status { margin: 8px 0 0; color: #8de6bd; font-size: 11px; }.code-output,.code-input { width: 100%; resize: vertical; border: 1px solid rgba(136, 177, 204, .31); border-radius: 10px; outline: none; background: #0c1b2b; color: #c9e3ed; font: 11px/1.6 ui-monospace, Consolas, monospace; }.code-output { min-height: 92px; margin-top: 10px; padding: 11px; }
.dependency-line { margin: 0 0 11px; color: #b4d9e5; font-size: 11px; }.missing-mod-note { margin: 0 0 11px; color: #f0c38a; font-size: 11px; line-height: 1.6; }
.import-card p { margin: 10px 0 12px; color: #8fa9bc; font-size: 11px; line-height: 1.6; }.code-input { min-height: 112px; padding: 12px; }.code-input:focus { border-color: #76ddcc; box-shadow: 0 0 0 3px rgba(118, 221, 204, .08); }.import-bottom { margin-top: 10px; }.import-bottom span { color: #8faaa9; font-size: 11px; }.import-bottom span.error { color: #f4a3ab; }.import-bottom button { width: auto; min-width: 150px; margin: 0; background: linear-gradient(120deg, #81e9ce, #70c9e7); }
.confirm-backdrop { position: fixed; z-index: 30; inset: 0; display: grid; place-items: center; padding: 15px; background: rgba(2, 11, 21, .7); }.confirm-dialog { width: min(430px, 100%); padding: 21px; border: 1px solid rgba(145, 184, 204, .4); border-radius: 16px; background: #1a2b3f; box-shadow: 0 26px 70px rgba(0,0,0,.4); }.confirm-dialog h3 { margin: 0; color: #f4f8ff; }.confirm-dialog p { color: #a9bdd0; font-size: 12px; line-height: 1.7; }.confirm-dialog > div { display: flex; gap: 10px; }.confirm-dialog button { margin: 0; }.danger-button { color: #fff; background: #a14d61; }
@media (max-width: 800px) { .library-grid { grid-template-columns: 1fr; }.map-list { grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); }.local-note { margin-top: 12px; } }
@media (max-width: 560px) { .map-library { padding: 15px; }.library-heading { display: grid; }.back-link { min-height: 43px; }.map-list-panel,.map-detail,.import-card { padding: 13px; }.detail-board { height: 245px; }.detail-title h3 { font-size: 23px; }.import-bottom { align-items: stretch; flex-direction: column; }.import-bottom button { width: 100%; min-height: 44px; } }
</style>
