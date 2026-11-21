<script setup lang="ts">
import type { TerrainModEntry, TerrainModSubmission } from "../workshop/types";
import { useWorkshopTerrainEditor } from "../workshop/use-workshop-terrain-editor";
import NumberStepper from "./NumberStepper.vue";

const props = defineProps<{
  editingEntry: TerrainModEntry | null;
  terrainMods: readonly TerrainModEntry[];
  working: boolean;
  uploadTerrainAsset: (dataUrl: string) => Promise<string>;
  downloadTerrainAsset: (url: string) => Promise<string>;
}>();

const emit = defineEmits<{
  "publish-terrain-mod": [entry: TerrainModSubmission];
}>();

const {
  publishTerrainName,
  publishTerrainDescription,
  publishModId,
  publishModVersion,
  selectedTerrainDraft,
  baseArtPlacement,
  overlayArtPlacement,
  hasOccupiedOverlay,
  selectedCapabilities,
  publishTerrainBaseColor,
  publishBaseImage,
  publishBaseMode,
  publishTerrainBaseOpacity,
  incomeAmount,
  incomeCustomEnabled,
  incomeConditionJson,
  departureGarrisonStrength,
  departureGarrisonRequirement,
  movementEnabled,
  movementRuleAdded,
  movementRuleExpanded,
  addCustomMovementRule,
  removeCustomMovementRule,
  syncMovementRuleExpanded,
  movementExpressionJson,
  maxCounterattacks,
  entryExhaustionTriggerMode,
  departureExhaustionTriggerMode,
  publishImageError,
  editingTerrainEntryId,
  creatorMode,
  previewOccupied,
  modJsonField,
  originalSettingIds,
  visualAssetCount,
  customCapabilityOptions,
  isTerrainOccupiable,
  visibleCapabilityGroups,
  totalSettingCount,
  terrainArtClipPoints,
  patchTerrainSetting,
  publishTerrainModJson,
  addOverlay,
  removeOverlay,
  addTerrainSetting,
  canRemoveSetting,
  removeTerrainSetting,
  updateSettingKind,
  updateChoiceOptions,
  updateSettingCapability,
  updateSettingConfigKey,
  updateBindingConfig,
  applyTerrainModJson,
  switchCreatorMode,
  setTerrainImage,
  submitTerrainMod,
  toggleCapability,
  publishError,
} = useWorkshopTerrainEditor(props, (entry) => emit("publish-terrain-mod", entry));
</script>

<template>
  <article class="publish-card mod-creator">
    <div class="creator-heading">
      <div><div class="section-heading"><strong>{{ editingTerrainEntryId ? '更新地块 Mod' : '创建地块 Mod' }}</strong><span>{{ editingTerrainEntryId ? '更新会自动应用到使用此 Mod 的地图' : '下方可切换预设功能或 JSON 编写' }}</span></div>
        <p>Mod 是声明式数据，不执行上传脚本。地图会跟随当前 Mod 版本；已开始的对局继续使用开局时版本。</p>
      </div>
      <div class="creator-mode" role="group" aria-label="编辑模式">
        <button type="button" :class="{ active: creatorMode === 'visual' }" @click="switchCreatorMode('visual')">可视化</button>
        <button type="button" :class="{ active: creatorMode === 'json' }" @click="switchCreatorMode('json')">JSON 编辑</button>
      </div>
    </div>

    <div class="creator-setup-layout visual">
    <div class="creator-basics">
      <label>Mod 名称<input v-model="publishTerrainName" type="text" maxlength="60" placeholder="例如：衰蚀荒原" /></label>
      <label>Mod ID<input v-model="publishModId" type="text" maxlength="80" placeholder="mod-my-mod" :readonly="Boolean(editingTerrainEntryId)" /></label>
      <label>发布版本<input v-model="publishModVersion" type="text" maxlength="40" placeholder="1.0.0" /></label>
      <label>作品说明<textarea v-model="publishTerrainDescription" class="code-field small-field" maxlength="1000" placeholder="说明玩法、地块能力和规则…" /></label>
    </div>

      <section class="terrain-appearance">
        <div class="appearance-heading"><div><strong>外观与图层</strong><small>图片 {{ visualAssetCount }}/4 · 单图最大 128 KiB · 一个可选顶部图层</small></div></div>
        <div class="terrain-appearance-content">
          <div class="base-appearance-controls">
            <fieldset class="base-appearance-mode">
              <legend>底部外观（必选）</legend>
              <label><input v-model="publishBaseMode" type="radio" value="color" />纯色</label>
              <label><input v-model="publishBaseMode" type="radio" value="image" />图片</label>
            </fieldset>
            <label v-if="publishBaseMode === 'color'" class="terrain-color-label">地块纯色 <input v-model="publishTerrainBaseColor" type="color" aria-label="地块纯色" /></label>
            <label v-else-if="publishBaseMode === 'image'">底部图片<input type="file" accept="image/svg+xml,image/png,image/webp,image/jpeg,.svg" :disabled="selectedTerrainDraft.baseImageUploading" @change="setTerrainImage($event, 'base')" /><small>{{ selectedTerrainDraft.baseImageUploading ? '正在上传到创意工坊…' : publishBaseImage ? '✓ 已上传并保存（再次选择可替换）' : '请选择一张基础纹理；SVG 保留矢量格式，位图会优化为 WebP。' }}</small></label>
            <label class="base-opacity-control"><span>底部不透明度 <output>{{ Math.round(publishTerrainBaseOpacity * 100) }}%</output></span><input v-model.number="publishTerrainBaseOpacity" type="range" min="0" max="1" step="0.01" aria-label="底部不透明度" /></label>
          </div>
          <svg class="terrain-art-live-preview" viewBox="0 0 100 115.47" role="img" aria-label="地块实时外观预览">
            <defs><clipPath id="mod-terrain-art-clip"><polygon :points="terrainArtClipPoints" /></clipPath></defs>
            <polygon v-if="publishBaseMode === 'color'" :points="terrainArtClipPoints" :fill="publishTerrainBaseColor" :fill-opacity="publishTerrainBaseOpacity" />
            <g clip-path="url(#mod-terrain-art-clip)">
              <image v-if="publishBaseMode === 'image' && publishBaseImage" :href="publishBaseImage" :x="baseArtPlacement.x - baseArtPlacement.width / 2" :y="baseArtPlacement.y - baseArtPlacement.height / 2" :width="baseArtPlacement.width" :height="baseArtPlacement.height" preserveAspectRatio="none" :opacity="publishTerrainBaseOpacity" />
            </g>
            <circle v-if="previewOccupied" cx="50" cy="57.735" r="15" fill="#d7e5e9" stroke="#26384c" stroke-width="2.5" />
            <g clip-path="url(#mod-terrain-art-clip)">
              <image v-if="selectedTerrainDraft.overlay && selectedTerrainDraft.overlay.dataUrl && (!selectedTerrainDraft.overlay.whenOccupied || previewOccupied)" :href="selectedTerrainDraft.overlay.dataUrl"
                :x="overlayArtPlacement && overlayArtPlacement.x - overlayArtPlacement.width / 2" :y="overlayArtPlacement && overlayArtPlacement.y - overlayArtPlacement.height / 2"
                :width="overlayArtPlacement?.width" :height="overlayArtPlacement?.height" preserveAspectRatio="none" :opacity="selectedTerrainDraft.overlay.opacity" />
            </g>
            <polygon :points="terrainArtClipPoints" fill="none" :stroke="publishBaseMode === 'color' ? '#26384c' : 'transparent'" stroke-width="2" />
          </svg>
          <div class="overlay-list">
            <div v-if="selectedTerrainDraft.overlay" class="overlay-editor">
              <div class="overlay-heading"><strong>顶部图层</strong><button type="button" class="remove-button" @click="removeOverlay">移除图层</button></div>
              <label>顶部图层图片 <span class="optional-tag">可选</span><input type="file" accept="image/svg+xml,image/png,image/webp,image/jpeg,.svg" :disabled="selectedTerrainDraft.overlay.imageUploading" @change="setTerrainImage($event, 'overlay')" /><small>{{ selectedTerrainDraft.overlay.imageUploading ? '正在上传到创意工坊…' : selectedTerrainDraft.overlay.dataUrl ? '已上传并保存（再次选择可替换）' : '可留空，只在需要叠加裂纹、边框等装饰时添加。支持 SVG、PNG、WebP 和 JPG。' }}</small></label>
              <div class="overlay-visibility-controls">
                <label class="overlay-occupied-toggle"><input v-model="selectedTerrainDraft.overlay.whenOccupied" type="checkbox" /><span>仅在有单位占领时显示</span></label>
                <label v-if="hasOccupiedOverlay" class="occupied-preview-toggle"><input v-model="previewOccupied" type="checkbox" /><span>模拟占领</span></label>
              </div>
              <template v-if="selectedTerrainDraft.overlay.dataUrl">
                <label>大小 <output>{{ Math.round(selectedTerrainDraft.overlay.scale * 100) }}%</output><input v-model.number="selectedTerrainDraft.overlay.scale" type="range" min="0.2" max="1.5" step="0.01" /></label>
                <label>不透明度 <output>{{ Math.round(selectedTerrainDraft.overlay.opacity * 100) }}%</output><input v-model.number="selectedTerrainDraft.overlay.opacity" type="range" min="0.1" max="1" step="0.01" /></label>
                <label>水平位置 <output>{{ selectedTerrainDraft.overlay.offsetX.toFixed(2) }}</output><input v-model.number="selectedTerrainDraft.overlay.offsetX" type="range" min="-0.45" max="0.45" step="0.01" /></label>
                <label>垂直位置 <output>{{ selectedTerrainDraft.overlay.offsetY.toFixed(2) }}</output><input v-model.number="selectedTerrainDraft.overlay.offsetY" type="range" min="-0.45" max="0.45" step="0.01" /></label>
              </template>
            </div>
            <button v-else type="button" class="outline-button add-layer" @click="addOverlay">＋ 添加顶部图层</button>
          </div>
        </div>
        <p v-if="publishImageError" class="form-error" role="alert">{{ publishImageError }}</p>
      </section>
    </div>

    <template v-if="creatorMode === 'visual'">
      <section class="terrain-collection" aria-label="Mod 地块设置">
        <div class="collection-heading"><div><strong>地块设置</strong><small>一个 Mod 对应一个地块；名称沿用 Mod 名称，地块 ID 根据 Mod ID 自动生成。</small></div></div>
        <div v-if="selectedTerrainDraft" class="terrain-editor">
          <div class="terrain-editor-main">
            <label class="occupiable-toggle capability-option">
              <input type="checkbox" :checked="isTerrainOccupiable" @change="toggleCapability('core/occupiable')" />
              <span><strong>可占领</strong><small>默认开启。关闭后，其他地块能力与规划能力暂时隐藏；再次开启会恢复当前配置。</small><code>core/occupiable</code></span>
            </label>
            <template v-if="isTerrainOccupiable">
              <label class="capability-label">地块能力分级 <span>{{ selectedCapabilities.length - 1 }} 项</span></label>
              <section v-for="group in visibleCapabilityGroups" :key="group.id" class="capability-group">
                <header>
                  <strong>{{ group.label }}</strong>
                  <label v-if="group.id === 'exit'" class="movement-toggle"><input v-model="movementEnabled" type="checkbox" /><span>可移动</span></label>
                </header>
                <div v-if="group.options.length" class="capability-options capability-options-expanded">
                  <label v-for="option in group.options" :key="option.id" class="capability-option">
                    <input type="checkbox" :checked="selectedCapabilities.includes(option.id)" @change="toggleCapability(option.id)" />
                    <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small><code>{{ option.id }}</code></span>
                  </label>
                </div>
                <template v-if="group.id === 'exit' && movementEnabled">
                  <button v-if="!movementRuleAdded" type="button" class="movement-rule-trigger" @click="addCustomMovementRule">
                    <span><strong>＋ 添加自定义移动规则</strong><small>未添加时，沿用单位默认移动范围。</small></span>
                    <span class="movement-rule-trigger-action">添加</span>
                  </button>
                  <section v-else class="movement-rule-panel">
                    <details class="movement-expression-editor" :open="movementRuleExpanded" @toggle="syncMovementRuleExpanded">
                      <summary>自定义移动规则</summary>
                      <textarea v-model="movementExpressionJson" class="code-field" spellcheck="false" aria-label="空间表达式" placeholder='{"op":"hex-range","min":1,"max":2,"where":{"op":"cell-exists"}}' />
                    </details>
                    <button class="movement-rule-remove" type="button" @click="removeCustomMovementRule">移除规则</button>
                  </section>
                </template>
              </section>
            <div v-if="selectedCapabilities.some((id) => ['core/income-source','core/counterattack-terrain-limit','core/exhaust-on-entry'].includes(id)) || (movementEnabled && selectedCapabilities.some((id) => ['core/departure-garrison','core/exhaust-on-departure'].includes(id)))" class="form-grid capability-config">
              <div class="capability-config-heading">能力参数</div>
              <div v-if="selectedCapabilities.includes('core/income-source')" class="config-number-field income-config-field">
                <label for="mod-income-amount">地块收益（点数）</label>
                <NumberStepper id="mod-income-amount" v-model.number="incomeAmount" :min="0" :max="20" size="compact" aria-label="地块收益点数" />
                <label class="income-condition-toggle"><input v-model="incomeCustomEnabled" type="checkbox" role="switch" aria-label="启用自定义收益条件" /><span>自定义触发条件（默认占领触发）</span></label>
              </div>
              <div v-if="selectedCapabilities.includes('core/income-source') && incomeCustomEnabled" class="config-number-field income-condition-editor">
                <textarea id="mod-income-condition" v-model="incomeConditionJson" rows="2" class="code-field income-condition-json" spellcheck="false" placeholder='收益前置条件 JSON，例如：{"op":"unit-is-powered"}' aria-label="自定义收益前置条件 JSON" />
              </div>
              <div v-if="movementEnabled && selectedCapabilities.includes('core/departure-garrison')" class="config-number-field"><label for="mod-departure-garrison">离开留下的兵力</label><NumberStepper id="mod-departure-garrison" v-model.number="departureGarrisonStrength" :min="1" :max="20" aria-label="离开留下的兵力" /></div>
              <label v-if="movementEnabled && selectedCapabilities.includes('core/departure-garrison')" class="config-number-field">留兵条件<select v-model="departureGarrisonRequirement"><option value="occupied">无条件留兵（离开时强制留兵）</option><option v-if="selectedCapabilities.includes('core/power-conductor')" value="powered-occupant">离开单位通电时才留兵</option></select><small>条件不满足时不生成留守兵；兵力不足以留下设定点数时不能离开。</small></label>
              <div v-if="selectedCapabilities.includes('core/counterattack-terrain-limit')" class="config-number-field"><label for="mod-max-counterattacks">每回合反击次数</label><NumberStepper id="mod-max-counterattacks" v-model.number="maxCounterattacks" :min="0" :max="6" aria-label="每回合反击次数" /></div>
              <div v-if="selectedCapabilities.includes('core/exhaust-on-entry')" class="config-number-field exhaustion-trigger-field"><label for="mod-entry-exhaustion-trigger-mode">进入失活触发范围</label><select id="mod-entry-exhaustion-trigger-mode" v-model="entryExhaustionTriggerMode"><option value="each-cell">每次进入该地形格</option><option value="terrain-transition">仅从其他地形跨入</option></select><small>跨地形模式下，同类地形格之间移动不会触发。</small></div>
              <div v-if="movementEnabled && selectedCapabilities.includes('core/exhaust-on-departure')" class="config-number-field exhaustion-trigger-field"><label for="mod-departure-exhaustion-trigger-mode">离开失活触发范围</label><select id="mod-departure-exhaustion-trigger-mode" v-model="departureExhaustionTriggerMode"><option value="each-cell">每次离开该地形格</option><option value="terrain-transition">仅跨到其他地形</option></select><small>跨地形模式下，同类地形格之间移动不会触发。</small></div>
            </div>
            <details v-if="selectedCapabilities.some((id) => customCapabilityOptions.some((capability) => capability.id === id))" class="binding-config">
              <summary>自定义能力参数</summary>
              <label v-for="id in selectedCapabilities.filter((candidate) => customCapabilityOptions.some((capability) => capability.id === candidate))" :key="id">{{ id }}（JSON 对象）
                <textarea class="code-field" spellcheck="false" :value="JSON.stringify(selectedTerrainDraft.bindings.find((binding) => binding.id === id)?.config ?? {}, null, 2)" @change="updateBindingConfig(id, ($event.target as HTMLTextAreaElement).value)" />
              </label>
            </details>
            <section class="terrain-settings">
              <div class="setting-section-heading"><div><strong>房间可调设置</strong><small>这是房间开局前的可选覆盖值，不是地块规则；例如房主可临时调整 Mod 声明的收益数值。</small></div>
                <div class="setting-heading-actions"><span class="setting-count">{{ totalSettingCount }} / 32</span><button type="button" class="outline-button" :disabled="totalSettingCount >= 32 || !selectedCapabilities.length" @click="addTerrainSetting">＋ 新增设置</button></div></div>
              <div v-if="selectedTerrainDraft.settings.length" class="setting-list">
                <fieldset v-for="setting in selectedTerrainDraft.settings" :key="setting.id" class="setting-editor">
                  <legend class="setting-editor-legend"><span>{{ setting.displayName || setting.id }}</span><span v-if="originalSettingIds.includes(setting.id)" class="setting-published-badge">已发布</span></legend>
                  <div class="setting-editor-body">
                    <div class="setting-card-meta"><code>{{ setting.id }}</code><button v-if="canRemoveSetting(setting)" type="button" class="setting-remove-button" :aria-label="`移除设置 ${setting.displayName || setting.id}`" @click="removeTerrainSetting(setting)">移除设置</button></div>
                    <div class="setting-fields">
                      <label>显示名称<input :value="setting.displayName" type="text" maxlength="60" @input="patchTerrainSetting(setting, 'displayName', ($event.target as HTMLInputElement).value)" /></label>
                      <label>说明<input :value="setting.description ?? ''" type="text" maxlength="120" @input="patchTerrainSetting(setting, 'description', ($event.target as HTMLInputElement).value)" /></label>
                      <label>应用能力<select :value="setting.target.capabilityId" :disabled="originalSettingIds.includes(setting.id)" @change="updateSettingCapability(setting, ($event.target as HTMLSelectElement).value)"><option v-for="id in selectedCapabilities" :key="id" :value="id">{{ id }}</option></select></label>
                      <label>配置键<input class="setting-config-key" :value="setting.target.configKey" type="text" maxlength="64" :disabled="originalSettingIds.includes(setting.id)" @input="updateSettingConfigKey(setting, ($event.target as HTMLInputElement).value)" /></label>
                      <label>类型<select :value="setting.kind" :disabled="originalSettingIds.includes(setting.id)" @change="updateSettingKind(setting, ($event.target as HTMLSelectElement).value)"><option value="integer">整数</option><option value="boolean">开关</option><option value="choice">选项</option></select></label>
                    </div>
                    <div v-if="setting.kind === 'integer'" class="setting-value-layout">
                      <div class="setting-default-field"><div><strong>默认值</strong><small>房主未覆盖时使用</small></div><NumberStepper :model-value="setting.defaultValue" :min="setting.min" :max="setting.max" aria-label="设置默认值" @update:model-value="patchTerrainSetting(setting, 'defaultValue', $event)" /></div>
                      <div class="setting-range-fields"><div class="setting-range-heading"><strong>可调范围</strong><small>房主可将数值设在此区间内</small></div><label><span>最小值</span><NumberStepper size="compact" :model-value="setting.min" :min="-10000000" :max="10000000" aria-label="设置最小值" @update:model-value="patchTerrainSetting(setting, 'min', $event)" /></label><label><span>最大值</span><NumberStepper size="compact" :model-value="setting.max" :min="-10000000" :max="10000000" aria-label="设置最大值" @update:model-value="patchTerrainSetting(setting, 'max', $event)" /></label></div>
                    </div>
                    <label v-else-if="setting.kind === 'boolean'" class="setting-boolean-default"><span><strong>默认值</strong><small>房主未覆盖时的开关状态</small></span><span class="setting-switch"><input type="checkbox" :checked="setting.defaultValue" @change="patchTerrainSetting(setting, 'defaultValue', ($event.target as HTMLInputElement).checked)" /><b>{{ setting.defaultValue ? '开启' : '关闭' }}</b></span></label>
                    <div v-else class="setting-choice-fields"><label>选项（逗号分隔）<input :value="setting.options.join(', ')" :disabled="originalSettingIds.includes(setting.id)" @change="updateChoiceOptions(setting, ($event.target as HTMLInputElement).value)" /></label><label>默认选项<select :value="setting.defaultValue" @change="patchTerrainSetting(setting, 'defaultValue', ($event.target as HTMLSelectElement).value)"><option v-for="option in setting.options" :key="option" :value="option">{{ option }}</option></select></label></div>
                  </div>
                </fieldset>
              </div>
              <p v-else class="empty-settings">这个地块还没有房间可调设置。选择一种能力后可以添加整数、开关或多选项。</p>
            </section>
            </template>
            <p v-else class="capability-hidden-note">这个地块不可占领，因此地块能力与空间规划配置已收起；现有配置会保留，重新勾选可继续编辑。</p>
          </div>

        </div>
      </section>

      <details class="definition-details"><summary>检查最终发布内容</summary><pre class="definition-preview"><code>{{ publishTerrainModJson }}</code></pre></details>
    </template>

    <label v-else class="mod-json-editor">完整 Mod 配置（JSON）<small class="mod-json-help">单个地块只用一个 terrain 对象；地块 ID 和名称会从 Mod ID 与名称自动生成。图片以后台 URL 引用，不会把 base64 图片内容写进 JSON。可视化修改会即时更新这里；编辑 JSON 后切回可视化或发布即可应用。</small><textarea ref="modJsonField" :value="publishTerrainModJson" class="code-field pattern-input" spellcheck="false" @change="applyTerrainModJson" /></label>

    <div class="creator-footer"><div><span class="limit-chip">{{ visualAssetCount }}/4 图片</span><span class="limit-chip">{{ totalSettingCount }}/32 设置</span></div>
      <span v-if="publishError" class="form-error" role="alert">{{ publishError }}</span><button class="primary-button" type="button" :disabled="working" @click="submitTerrainMod">{{ editingTerrainEntryId ? '验证并发布更新' : '验证并发布 Mod' }}</button>
    </div>
  </article>
</template>

<style scoped>
.terrain-color-label input{width:52px;height:31px;padding:2px;border:1px solid rgba(127,169,193,.3);border-radius:7px;background:#0d1c2a}.publish-card{min-width:0;padding:18px;border:1px solid rgba(135,175,202,.24);border-radius:18px;background:rgba(8,22,35,.58)}.section-heading{display:flex;justify-content:space-between;gap:10px;align-items:center}.section-heading strong{color:#e6f2fb;font-size:14px}.section-heading span{color:#718da5;font-size:10px}.primary-button{background:linear-gradient(120deg,#81e9ce,#70c9e7)}.outline-button{border:1px solid rgba(141,184,205,.3);color:#b9d4e4;background:rgba(27,54,73,.55)}.code-field,.publish-card input{box-sizing:border-box;width:100%;border:1px solid rgba(136,177,204,.31);border-radius:10px;outline:none;background:#0c1b2b;color:#d6e8f0;font:11px/1.6 ui-monospace,Consolas,monospace}.code-field{min-height:110px;padding:11px;resize:vertical}.code-field:focus,.publish-card input:focus{border-color:#76ddcc;box-shadow:0 0 0 3px rgba(118,221,204,.08)}.publish-card>p{margin:10px 0 15px;color:#91adbd;font-size:11px;line-height:1.6}.publish-card label{display:grid;gap:6px;margin-top:11px;color:#b7ceda;font-size:11px;font-weight:700}.publish-card input{height:39px;padding:0 10px;font:12px system-ui,sans-serif}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.small-field{min-height:72px}.form-error{flex:1;color:#f2a9b4;font-size:11px;line-height:1.5}@media(max-width:570px){.publish-card{padding:13px}.form-grid{grid-template-columns:1fr}}
.capability-label{margin-top:16px;color:#b7ceda;font-size:11px;font-weight:700}.definition-details>summary{display:flex;justify-content:space-between;align-items:center;min-height:40px;padding:0 12px;color:#cce1ec;font-size:12px;cursor:pointer;list-style:none}.definition-details>summary::-webkit-details-marker{display:none}.capability-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:10px}.capability-option{display:flex!important;align-items:flex-start;gap:9px;margin:0!important;padding:9px;border:1px solid rgba(136,177,204,.17);border-radius:8px;background:rgba(29,51,69,.55)}.capability-option input{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:#75dccc}.capability-option span{display:grid;gap:3px}.capability-option strong{color:#dcebf4;font-size:11px}.capability-option small{color:#8eaabc;font-size:10px;font-weight:400;line-height:1.4}.capability-option code{color:#7ccfc7;font-size:9px}.definition-details{margin-top:12px;border:1px solid rgba(136,177,204,.2);border-radius:9px;background:rgba(12,27,43,.5)}.definition-details>summary{justify-content:flex-start;min-height:36px;color:#9fded7;font-size:11px}.definition-details .definition-preview{margin:0 10px 10px}.publish-card .form-grid{margin-top:2px}.publish-card .form-grid label{min-width:0}
.capability-config{margin-top:10px;padding:12px;border:1px solid rgba(136,177,204,.18);border-radius:10px;background:rgba(15,32,48,.55)}.capability-config p{grid-column:1/-1;margin:2px 0 0;color:#8eaabc;font-size:10px}.pattern-input{min-height:300px}
@media(max-width:570px){.capability-options{grid-template-columns:1fr}}

.definition-preview { max-height: 360px; overflow: auto; margin: 10px 0; padding: 14px; border: 1px solid rgba(125,167,191,.26); border-radius: 10px; background: #0b1928; color: #d7e9f1; font: 11px/1.6 ui-monospace, Consolas, monospace; white-space: pre; }

.config-number-field{display:grid;min-width:0;gap:6px;margin-top:11px}
.config-number-field>label{color:#b7ceda;font-size:11px;font-weight:700}
.config-number-field .number-stepper{min-height:39px}
.movement-toggle{display:flex!important;align-items:center;gap:6px;margin:0 0 0 auto!important;color:#bfece4!important;font-size:11px!important;font-weight:700!important}
.movement-toggle input{width:14px!important;height:14px;margin:0;accent-color:#75dccc}
.movement-rule-trigger{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:48px;margin:0;padding:8px 11px;border:1px solid rgba(117,220,204,.25);border-radius:9px;color:#d9edf0;background:rgba(16,42,54,.66);text-align:left;cursor:pointer;transition:border-color .16s,background .16s}
.movement-rule-trigger:hover{border-color:rgba(117,220,204,.52);background:rgba(24,58,67,.72)}
.movement-rule-trigger>span:first-child{display:grid;gap:3px}
.movement-rule-trigger strong{font-size:11px}
.movement-rule-trigger small{color:#91aebe;font-size:9px;font-weight:400}
.movement-rule-trigger-action{display:flex;align-items:center;gap:7px;color:#8edbd0;font-size:10px}
.movement-rule-trigger-action b{font-size:14px;font-weight:500}
.movement-rule-panel{position:relative}
.movement-expression-editor{border:0;border-radius:0;background:transparent}
.movement-expression-editor>summary{display:flex;align-items:center;min-height:30px;padding:0 82px 0 0;color:#b9f0e4;font-size:11px;font-weight:750;line-height:1.3;cursor:pointer;list-style:none;user-select:none}
.movement-expression-editor>summary::-webkit-details-marker{display:none}
.movement-expression-editor>summary::after{position:absolute;top:11px;right:65px;width:6px;height:6px;border-right:1.5px solid #7fa2b3;border-bottom:1.5px solid #7fa2b3;content:"";transform:rotate(45deg);transition:transform .16s,top .16s}
.movement-expression-editor[open]>summary::after{top:14px;transform:rotate(225deg)}
.movement-rule-remove{position:absolute;top:0;right:0;width:auto;min-height:30px;margin:0;padding:5px 9px;border:1px solid rgba(227,140,151,.25);border-radius:7px;color:#e6acb5;background:rgba(91,43,56,.22);font-size:9px;cursor:pointer;transition:border-color .16s,background .16s}
.movement-rule-remove:hover{border-color:rgba(227,140,151,.55);background:rgba(112,49,63,.36)}
.movement-expression-editor textarea{display:block;width:100%;min-height:126px;margin:7px 0 0;font:10px/1.55 ui-monospace,Consolas,monospace}
.terrain-art-live-preview{grid-row:span 3;align-self:center;width:min(100%,104px);height:118px;filter:drop-shadow(0 7px 10px rgba(0,0,0,.25))}
.terrain-art-live-preview image{pointer-events:none}
.mod-creator{display:grid;gap:13px;max-width:1120px;margin:0 auto;padding:clamp(14px,2vw,22px);background:linear-gradient(150deg,rgba(12,29,44,.95),rgba(7,18,30,.95))}
.creator-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding-bottom:15px;border-bottom:1px solid rgba(138,181,201,.15)}
.creator-heading p{margin:7px 0 0;color:#8faabd;font-size:11px;line-height:1.6}
.creator-mode{display:flex;flex:none;padding:3px;border:1px solid rgba(132,177,199,.23);border-radius:10px;background:#091827}
.creator-mode button{width:auto;min-width:86px;min-height:32px;margin:0;padding:5px 10px;border:0;border-radius:7px;color:#8eaabd;background:transparent;font-size:10px}
.creator-mode button.active{color:#d9f8f0;background:rgba(81,176,164,.23);box-shadow:inset 0 0 0 1px rgba(108,221,201,.22)}
.creator-basics{display:grid;grid-template-columns:minmax(0,1fr);align-self:stretch;align-content:space-between;gap:8px;padding:0;border:0;border-radius:0;background:transparent}
.creator-setup-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-items:start;padding:12px;border:1px solid rgba(129,175,199,.2);border-radius:13px;background:rgba(7,20,33,.5)}
.creator-setup-layout.visual{grid-template-columns:minmax(0,1.2fr) minmax(285px,.8fr)}
.creator-basics>label{gap:4px;margin:0;font-size:10px}
.creator-basics input[type=text]{height:33px!important;min-height:33px!important;padding:0 9px!important;font-size:11px!important}
.creator-basics textarea.small-field{min-height:54px;padding:7px 9px;font:10px/1.4 system-ui,sans-serif}
.terrain-collection{padding:12px;border:1px solid rgba(129,175,199,.2);border-radius:15px;background:rgba(7,20,33,.5)}
.collection-heading,.appearance-heading,.overlay-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}
.collection-heading strong,.appearance-heading strong{display:block;color:#e4f1f8;font-size:13px}
.collection-heading small,.appearance-heading small{display:block;margin-top:4px;color:#89a5b8;font-size:10px;line-height:1.5}
.terrain-editor{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-items:start}
.terrain-editor-main{min-width:0;padding:0;border:0;background:transparent}
.terrain-appearance{min-width:0;padding:0 0 0 14px;border:0;border-left:1px solid rgba(130,177,199,.2);border-radius:0;background:transparent}
.base-appearance-controls{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:7px 12px;margin:0;padding:0}
.base-appearance-controls>label{grid-column:1/-1;display:grid;gap:6px;margin:0;color:#a9c1ce;font-size:10px;font-weight:650}
.base-appearance-controls>.terrain-color-label{display:flex;justify-content:space-between;align-items:center;gap:12px}
.base-appearance-controls input[type=color]{width:42px;height:26px!important;padding:2px!important}
.base-appearance-controls input[type=file]{height:auto!important;padding:4px!important;font-size:9px!important}
.base-appearance-controls label small{color:#819caf;font-size:9px;font-weight:400;line-height:1.45}
.capability-label{display:flex;justify-content:space-between;align-items:center;margin-top:15px}
.capability-label span{color:#79cfca;font-size:10px;font-weight:500}
.capability-options-expanded{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding:0;margin:0}
.capability-options-expanded .capability-option{min-width:0;min-height:82px;padding:11px;border-color:rgba(136,177,204,.2);background:linear-gradient(145deg,rgba(27,49,66,.82),rgba(17,36,52,.82));transition:border-color .16s,background .16s,transform .16s}
.capability-options-expanded .capability-option:hover{transform:translateY(-1px);border-color:rgba(117,220,204,.42);background:linear-gradient(145deg,rgba(34,62,78,.94),rgba(20,43,58,.94))}
.capability-options-expanded .capability-option:focus-within{outline:2px solid rgba(117,220,204,.52);outline-offset:2px}
.capability-options-expanded .capability-option:has(input:checked){border-color:rgba(104,217,202,.62);background:linear-gradient(145deg,rgba(38,91,91,.48),rgba(25,60,67,.56));box-shadow:inset 3px 0 rgba(104,217,202,.78)}
.capability-options-expanded .capability-option span{gap:4px}
.capability-options-expanded .capability-option strong{font-size:12px;line-height:1.35}
.capability-options-expanded .capability-option small{color:#a5bac8;font-size:10px;line-height:1.5}
.capability-options-expanded .capability-option code{overflow-wrap:anywhere;color:#80d9cf;font-size:9px;line-height:1.4}
.capability-config{margin-top:8px;padding:8px 10px}
.income-config-field{grid-column:1/-1;display:flex;flex-direction:row;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px;width:100%;max-width:100%;margin:0}
.income-config-field>label{align-self:center;margin:0;line-height:1.25}
.income-config-field>.number-stepper.compact{flex:0 1 128px;width:128px;max-width:100%;min-height:36px}
.income-condition-toggle{display:flex!important;align-items:center;gap:6px;width:max-content;max-width:100%;min-height:24px;margin:0!important;padding:0 2px;border:0;background:transparent;cursor:pointer}
.income-condition-toggle>input{appearance:none;position:relative;flex:none;width:28px;height:16px!important;margin:0;padding:0!important;border:1px solid rgba(130,166,184,.5);border-radius:99px;background:#172b3c;cursor:pointer;transition:background .16s,border-color .16s}
.income-condition-toggle>input::after{position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;background:#9aafbc;content:"";transition:transform .16s,background .16s}
.income-condition-toggle>input:checked{border-color:#59cbbd;background:#238e85}
.income-condition-toggle>input:checked::after{transform:translateX(12px);background:#effffc}
.income-condition-toggle>input:focus-visible{outline:2px solid #75e5d0;outline-offset:3px}
.income-condition-toggle>span{color:#b8ced8;font-size:10px;font-weight:600;white-space:nowrap}
.income-condition-editor{grid-column:1/-1;display:block;margin-top:0;padding:0;border:0;border-radius:0;background:transparent}
.income-condition-editor .income-condition-json{min-height:46px;padding:6px 8px;border-color:rgba(122,183,204,.28);background:#091827;font:10px/1.35 ui-monospace,Consolas,monospace}
.income-condition-editor .income-condition-json::placeholder{color:#6e8799}
.terrain-settings{margin-top:19px;padding:16px 13px 13px;border:1px solid rgba(130,177,199,.17);border-radius:12px;background:linear-gradient(145deg,rgba(11,27,41,.48),rgba(7,19,31,.32))}
.setting-section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}
.setting-section-heading strong{display:block;color:#e4f1f8;font-size:13px;letter-spacing:.01em}
.setting-section-heading small{display:block;margin-top:4px;color:#8fa9bb;font-size:10px;line-height:1.5}
.setting-heading-actions{display:flex;flex:none;align-items:center;gap:8px}
.setting-count{padding:4px 8px;border:1px solid rgba(114,200,190,.19);border-radius:99px;color:#93d9cf;background:rgba(37,93,89,.17);font:10px ui-monospace,Consolas,monospace;white-space:nowrap}
.setting-heading-actions .outline-button{width:auto;min-height:34px;margin:0;padding:6px 10px;font-size:10px;white-space:nowrap}
.setting-list{display:grid;gap:11px;margin-top:12px}
.setting-editor{display:block;min-width:0;min-inline-size:0;margin:0;padding:0;border:1px solid rgba(131,177,201,.2);border-radius:11px;background:linear-gradient(145deg,rgba(17,38,55,.74),rgba(9,25,39,.75));box-shadow:inset 0 1px rgba(255,255,255,.025)}
.setting-editor-legend{display:flex;align-items:center;gap:8px;max-width:calc(100% - 24px);margin-left:12px;padding:0 7px;color:#d8eef3;font-size:11px;font-weight:800;overflow-wrap:anywhere}
.setting-published-badge{padding:2px 6px;border:1px solid rgba(111,205,183,.22);border-radius:99px;color:#90d9c9;background:rgba(39,109,91,.17);font-size:8px;font-weight:700;white-space:nowrap}
.setting-editor-body{display:grid;gap:12px;padding:2px 13px 13px}
.setting-card-meta{display:flex;justify-content:space-between;align-items:center;gap:10px;min-width:0;padding-bottom:8px;border-bottom:1px solid rgba(132,175,197,.1)}
.setting-card-meta code{overflow:hidden;color:#7697aa;font:9px ui-monospace,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.setting-remove-button{flex:none;width:auto;min-height:26px;margin:0;padding:4px 8px;border:1px solid rgba(231,137,154,.24);border-radius:7px;color:#e3a2af;background:rgba(103,43,59,.13);font-size:9px}
.setting-remove-button:hover{border-color:rgba(242,151,166,.55);color:#ffc0ca;background:rgba(126,48,66,.3)}
.setting-fields,.setting-choice-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;align-items:end}
.setting-editor label{display:grid;gap:5px;min-width:0;color:#a9c1ce;font-size:10px;font-weight:650}
.setting-fields input,.setting-fields select,.setting-choice-fields input,.setting-choice-fields select{width:100%;min-width:0;height:39px!important;box-sizing:border-box;padding:0 10px!important;border-radius:9px;font-size:11px!important}
.setting-fields .setting-config-key{font:10px ui-monospace,Consolas,monospace!important;color:#a8cfcf}
.setting-fields input:disabled,.setting-fields select:disabled,.setting-choice-fields input:disabled{opacity:.58;cursor:not-allowed}
.setting-value-layout{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(0,1.2fr);gap:10px;align-items:stretch}
.setting-default-field,.setting-range-fields{min-width:0;padding:10px;border:1px solid rgba(127,177,196,.15);border-radius:9px;background:rgba(6,19,31,.4)}
.setting-default-field{display:grid;gap:9px;align-content:center;border-color:rgba(104,199,186,.2);background:linear-gradient(140deg,rgba(31,82,83,.18),rgba(6,19,31,.43))}
.setting-default-field>div,.setting-range-heading{display:grid;gap:3px}
.setting-default-field strong,.setting-range-heading strong,.setting-boolean-default strong{color:#c8e2e8;font-size:10px}
.setting-default-field small,.setting-range-heading small,.setting-boolean-default small{color:#819daf;font-size:9px;font-weight:400;line-height:1.4}
.setting-default-field>.number-stepper{min-height:40px}
.setting-range-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.setting-range-heading{grid-column:1/-1}
.setting-range-fields label{gap:5px;color:#8faab9;font-size:9px;font-weight:600}
.setting-range-fields .number-stepper{min-height:36px}
.setting-boolean-default{display:flex!important;justify-content:space-between;align-items:center;gap:12px;padding:11px 12px;border:1px solid rgba(130,177,199,.15);border-radius:9px;background:rgba(6,19,31,.4)}
.setting-boolean-default>span:first-child{display:grid;gap:3px}
.setting-switch{display:flex;align-items:center;gap:8px;color:#9cb3c1;font-size:10px}
.setting-switch input{width:16px;height:16px!important;margin:0;accent-color:#65d5c3}
.setting-switch:has(input:checked){color:#90e2d2}
.setting-choice-fields{padding:10px;border:1px solid rgba(127,177,196,.15);border-radius:9px;background:rgba(6,19,31,.4)}
.empty-settings{margin:12px 0 0;padding:14px;border:1px dashed rgba(133,176,196,.2);border-radius:9px;color:#91aabc;background:rgba(6,19,31,.2);font-size:10px;line-height:1.55}
.terrain-appearance{display:grid;gap:8px;margin-top:0}
.terrain-appearance .appearance-heading{margin-bottom:0}
.terrain-appearance-content{display:grid;grid-template-columns:minmax(0,1fr) 88px;gap:8px 12px;align-items:center}
.terrain-appearance .terrain-art-live-preview{grid-column:2;grid-row:1;justify-self:center;width:88px;height:102px;margin:0 auto}
.occupied-preview-toggle{display:flex!important;align-items:center;gap:5px;color:#b5ced8;font-size:9px!important;white-space:nowrap;cursor:pointer}
.occupied-preview-toggle input,.overlay-occupied-toggle input{flex:none;width:13px;height:13px!important;margin:0;padding:0!important;accent-color:#74dccc}
.overlay-editor>label{margin-top:0;font-size:10px}
.optional-tag{display:inline-flex;align-items:center;margin-left:5px;padding:2px 6px;border:1px solid;border-radius:999px;font-size:8px;font-weight:800;line-height:1.35;vertical-align:1px}
.optional-tag{border-color:rgba(121,205,187,.28);color:#91d8c5;background:rgba(41,105,88,.16)}
.overlay-editor input[type=file]{height:auto!important;padding:4px!important;font-size:9px!important}
.base-appearance-mode{grid-column:1/-1;display:flex;flex-wrap:nowrap;gap:5px;min-width:0;margin:0;padding:0;border:0}
.base-appearance-mode legend{width:100%;padding:0;margin-bottom:2px;color:#c6dce8;font-size:9px}
.base-appearance-mode label{display:flex;flex:none;align-items:center;gap:5px;padding:4px 6px;border:1px solid rgba(127,169,193,.15);border-radius:6px;color:#b6d4df;font-size:9px;white-space:nowrap;cursor:pointer}
.base-appearance-mode input{flex:none;width:13px;min-width:13px;height:13px!important;margin:0;padding:0!important;accent-color:#73dec9}
.base-opacity-control{grid-column:1/-1;display:grid!important;gap:3px!important;color:#a9c1ce;font-size:9px!important}
.base-opacity-control>span{display:flex;justify-content:space-between;align-items:center;gap:8px}
.base-opacity-control output{color:#85d9d1;font:9px ui-monospace,Consolas,monospace}
.base-opacity-control input[type=range]{width:100%;height:15px!important;margin:0;padding:0!important;accent-color:#73dec9}
.base-appearance-controls input[type=color]:disabled,.base-appearance-controls input[type=file]:disabled{opacity:.45;cursor:not-allowed}
.terrain-appearance label small,.overlay-editor label small{color:#819caf;font-size:9px;font-weight:400;line-height:1.45}
.overlay-list{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding-top:7px;border-top:1px solid rgba(140,180,202,.12)}
.overlay-editor{display:grid;flex:1;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 12px;min-width:0;padding:0;border:0;border-radius:0;background:transparent}
.overlay-editor>.overlay-heading,.overlay-editor>label:first-of-type{grid-column:1/-1}
.overlay-heading strong{color:#cae1ec;font-size:10px}
.overlay-heading .remove-button{width:auto;margin:0;padding:4px 7px;font-size:9px}
.overlay-editor input[type=range]{grid-column:3;grid-row:1;width:100%;height:14px!important;padding:0!important;accent-color:#74dccc}
.overlay-editor label{grid-template-columns:minmax(58px,auto) auto minmax(60px,1fr);align-items:center;gap:4px;margin:0;font-size:9px}
.overlay-visibility-controls{grid-column:1/-1;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.overlay-visibility-controls .overlay-occupied-toggle,.overlay-visibility-controls .occupied-preview-toggle{display:flex;align-items:center;gap:6px;margin:0;font-size:9px;white-space:nowrap;cursor:pointer}
.overlay-visibility-controls .overlay-occupied-toggle{color:#a9c4d1}
.overlay-editor label input[type=file],.overlay-editor label small{grid-column:1/-1}
.overlay-editor output{color:#86d8cd;font:9px ui-monospace,Consolas,monospace}
.add-layer{width:auto;min-height:27px;margin:0;padding:4px 9px;font-size:9px}
.remove-button{width:auto;min-height:26px;margin:0;padding:4px 8px;border:1px solid rgba(232,139,155,.28);border-radius:7px;color:#e7aab5;background:rgba(97,43,57,.18);font-size:9px}
.remove-button:hover{border-color:rgba(245,153,169,.62);background:rgba(115,47,64,.35)}.binding-config{padding:12px 14px;border:1px solid rgba(119,188,184,.2);border-radius:12px;background:rgba(10,28,42,.42)}.binding-config>summary{color:#9adbd3;font-size:11px;font-weight:750;cursor:pointer;list-style:none}.binding-config>summary::-webkit-details-marker{display:none}
.binding-config{display:grid;gap:9px;margin-top:12px}
.binding-config label{font-size:10px}
.binding-config .code-field{min-height:90px}
.mod-json-editor{display:grid;gap:7px;min-width:0;margin:0;font-size:11px}
.mod-json-editor .pattern-input{min-height:300px;max-height:500px}
.mod-json-help{color:#89a5b8;font-size:10px;font-weight:400;line-height:1.5}
.creator-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-top:14px;border-top:1px solid rgba(140,180,202,.15)}
.creator-footer>div{display:flex;flex-wrap:wrap;gap:6px}
.limit-chip{padding:5px 8px;border:1px solid rgba(121,191,186,.2);border-radius:99px;color:#91cfc9;background:rgba(28,76,79,.18);font-size:9px}
.creator-footer .primary-button{width:auto;flex:none;min-width:165px;margin:0;padding:10px 13px}
.creator-footer .form-error{max-width:360px}
.mod-creator .definition-details{margin:0}
.mod-creator .definition-preview{max-height:440px}
.mod-creator input:read-only{opacity:.72}
.mod-creator button:disabled{opacity:.45;cursor:not-allowed}
.occupiable-toggle{margin-top:13px!important;border-color:rgba(117,220,204,.32)!important;background:rgba(32,83,82,.22)!important}
.occupiable-toggle:has(input:checked){border-color:rgba(117,220,204,.58)!important;background:rgba(43,101,103,.32)!important}
.capability-group{display:grid;grid-template-columns:minmax(0,1fr);gap:9px;align-items:start;margin-top:11px;padding:12px;border:1px solid rgba(136,177,204,.17);border-radius:12px;background:linear-gradient(145deg,rgba(10,26,39,.48),rgba(12,29,43,.32))}
.capability-group>header{display:flex;align-items:center;gap:9px;min-height:22px;margin:0;padding-left:9px;border-left:2px solid rgba(104,217,202,.72)}
.capability-group>header strong{color:#d8eaf2;font-size:12px;letter-spacing:.01em}
.capability-config-heading{grid-column:1/-1;padding-bottom:5px;border-bottom:1px solid rgba(136,177,204,.14);color:#cfe3ed;font-size:11px;font-weight:700}
.capability-hidden-note{margin:10px 0 0;padding:10px 12px;border:1px dashed rgba(136,177,204,.24);border-radius:8px;color:#94aebe;font-size:10px;line-height:1.55}
@media(max-width:800px){.creator-heading{display:grid}.creator-mode{justify-self:start}}
@media(max-width:760px){.creator-setup-layout.visual{grid-template-columns:minmax(0,1fr)}.terrain-appearance{padding:12px 0 0;border-top:1px solid rgba(130,177,199,.2);border-left:0}.mod-json-editor{padding-top:12px}}
@media(max-width:480px){.capability-options-expanded{grid-template-columns:1fr}}
@media(max-width:650px){.creator-basics{grid-template-columns:1fr;align-content:start}.terrain-appearance-content{grid-template-columns:minmax(0,1fr) 72px}.base-appearance-controls{grid-template-columns:1fr}.terrain-appearance .terrain-art-live-preview{grid-column:2;grid-row:1;width:72px;height:83px}.overlay-editor{grid-template-columns:1fr}.overlay-editor>.overlay-heading,.overlay-editor>label:first-of-type{grid-column:1}.overlay-editor label{grid-template-columns:minmax(58px,auto) auto minmax(60px,1fr)}.creator-footer{align-items:stretch;flex-direction:column}.creator-footer .primary-button{width:100%}.creator-footer .form-error{max-width:none}.collection-heading{align-items:flex-start}.setting-section-heading{align-items:flex-start}.setting-section-heading>div:first-child{min-width:0}.setting-heading-actions{align-items:flex-start}}
@media(max-width:520px){.setting-value-layout{grid-template-columns:1fr}.setting-range-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:440px){.creator-mode{width:100%}.creator-mode button{flex:1}.collection-heading{display:grid}.setting-section-heading{display:grid}.setting-heading-actions{justify-content:space-between}.setting-fields,.setting-choice-fields{grid-template-columns:1fr}.setting-editor-body{padding-inline:10px}.setting-range-fields{grid-template-columns:1fr 1fr}}
</style>
