<script lang="ts">
import { isSystemManagedTerrainCapability, validateTerrainModDefinition, type TerrainModDefinition, type TerrainModDefinitionAssetReferences, type TerrainModSetting, type TerrainModVisualPreview } from "@numeral-lord/content-schema";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "../workshop/types";

interface TerrainOverlayDraft {
  dataUrl: string;
  assetUrl: string;
  imageUploading: boolean;
  scale: number;
  opacity: number;
  offsetX: number;
  offsetY: number;
  whenOccupied: boolean;
}

interface TerrainDraft {
  readonly key: string;
  capabilities: string[];
  bindings: TerrainModDefinition["terrain"]["capabilities"];
  settings: TerrainModSetting[];
  baseMode: "color" | "image";
  baseColor: string;
  baseImage: string;
  baseImageUrl: string;
  baseImageUploading: boolean;
  baseOpacity: number;
  overlay: TerrainOverlayDraft | null;
  incomeAmount: number;
  incomeCustomEnabled: boolean;
  incomeConditionJson: string;
  movementEnabled: boolean;
  movementRuleAdded: boolean;
  movementExpressionJson: string;
  departureGarrisonStrength: number;
  departureGarrisonRequirement: "occupied" | "powered-occupant";
  maxCounterattacks: number;
}

</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getPoweredUnitIds, type GameState } from "@numeral-lord/game-core";
import { createMatchFromMapCode, parseMapCode } from "@numeral-lord/core-content";
import { runtimeMapCatalogs, loadedTerrainCatalog, loadedTerrainCatalogRevision, resolveMapCatalogs, terrainVisualAssetsForCatalogs } from "../content/installed-content";
import { paginate } from "../shared/list-pagination.js";
import HexBoard from "./HexBoard.vue";
import NumberStepper from "./NumberStepper.vue";
import TerrainModPreview from "./TerrainModPreview.vue";
import ConditionReferenceDialog from "./ConditionReferenceDialog.vue";
import { getTerrainArtClipPoints, getTerrainArtPlacement, TERRAIN_ART_VIEWBOX_HEIGHT } from "../board/terrain-art-geometry.js";
import { compareModVersions } from "../workshop/workshop-terrain-catalog.js";

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
const publishTerrainName = ref("");
const publishTerrainDescription = ref("");
const publishModId = ref("mod-my-terrain");
const publishModVersion = ref("1.0.0");
let terrainDraftSequence = 0;
function parseIncomeConditionJson(value: string): { readonly valid: true; readonly condition: unknown } | { readonly valid: false } {
  try { return { valid: true, condition: JSON.parse(value) as unknown }; }
  catch { return { valid: false }; }
}

function createTerrainDraft(): TerrainDraft {
  const occupiable = { id: "core/occupiable" };
  const captureExhaustion = { id: "core/exhaust-unpowered-after-capture" };
  return {
    key: `terrain-draft-${++terrainDraftSequence}`,
    capabilities: [occupiable.id, captureExhaustion.id],
    bindings: [occupiable, captureExhaustion],
    settings: [],
    baseMode: "color",
    baseColor: "#638f67",
    baseImage: "",
    baseImageUrl: "",
    baseImageUploading: false,
    baseOpacity: 1,
    overlay: null,
    incomeAmount: 2,
    incomeCustomEnabled: false,
    incomeConditionJson: "",
    movementEnabled: true,
    movementRuleAdded: false,
    movementExpressionJson: "",
    departureGarrisonStrength: 1,
    departureGarrisonRequirement: "occupied",
    maxCounterattacks: 0
  };
}
const terrainDraft = ref<TerrainDraft>(createTerrainDraft());
const selectedTerrainDraft = computed(() => terrainDraft.value);
const baseArtPlacement = getTerrainArtPlacement(50, TERRAIN_ART_VIEWBOX_HEIGHT / 2, TERRAIN_ART_VIEWBOX_HEIGHT / 2);
const overlayArtPlacement = computed(() => {
  const overlay = selectedTerrainDraft.value.overlay;
  return overlay ? getTerrainArtPlacement(50, TERRAIN_ART_VIEWBOX_HEIGHT / 2, TERRAIN_ART_VIEWBOX_HEIGHT / 2,
    overlay.scale, overlay.offsetX, overlay.offsetY) : undefined;
});
const hasOccupiedOverlay = computed(() => Boolean(selectedTerrainDraft.value.overlay?.whenOccupied));
const selectedCapabilities = computed({
  get: () => {
    const draft = selectedTerrainDraft.value;
    return !draft ? [] : draft.movementEnabled
      ? draft.capabilities
      : draft.capabilities.filter((id) => !["core/exhaust-on-departure", "core/departure-garrison"].includes(id));
  },
  set: (value: string[]) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.capabilities = value; }
});
const publishTerrainBaseColor = computed({
  get: () => selectedTerrainDraft.value?.baseColor ?? "#638f67",
  set: (value: string) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.baseColor = value; }
});
const publishBaseImage = computed({
  get: () => selectedTerrainDraft.value?.baseImage ?? "",
  set: (value: string) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.baseImage = value; }
});
const publishBaseMode = computed({
  get: () => selectedTerrainDraft.value?.baseMode ?? "color",
  set: (mode: "color" | "image") => {
    const draft = selectedTerrainDraft.value;
    if (!draft) return;
    draft.baseMode = mode;
  }
});
const publishTerrainBaseOpacity = computed({
  get: () => selectedTerrainDraft.value?.baseOpacity ?? 1,
  set: (value: number) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.baseOpacity = value; }
});
const incomeAmount = computed({
  get: () => selectedTerrainDraft.value?.incomeAmount ?? 2,
  set: (value: number) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.incomeAmount = value; }
});
const incomeCustomEnabled = computed({
  get: () => selectedTerrainDraft.value?.incomeCustomEnabled ?? false,
  set: (value: boolean) => {
    if (selectedTerrainDraft.value) selectedTerrainDraft.value.incomeCustomEnabled = value;
  }
});
const incomeConditionJson = computed({
  get: () => selectedTerrainDraft.value?.incomeConditionJson ?? "",
  set: (value: string) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.incomeConditionJson = value; }
});
const departureGarrisonStrength = computed({
  get: () => selectedTerrainDraft.value?.departureGarrisonStrength ?? 1,
  set: (value: number) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.departureGarrisonStrength = value; }
});
const departureGarrisonRequirement = computed({
  get: () => selectedTerrainDraft.value?.departureGarrisonRequirement ?? "occupied",
  set: (value: "occupied" | "powered-occupant") => {
    if (selectedTerrainDraft.value) selectedTerrainDraft.value.departureGarrisonRequirement = value;
  }
});
const movementEnabled = computed({
  get: () => selectedTerrainDraft.value.movementEnabled,
  set: (value: boolean) => { selectedTerrainDraft.value.movementEnabled = value; }
});
const movementRuleAdded = computed(() => selectedTerrainDraft.value.movementRuleAdded);
const movementRuleExpanded = ref(false);
function addCustomMovementRule(): void {
  selectedTerrainDraft.value.movementRuleAdded = true;
  movementRuleExpanded.value = true;
}
function removeCustomMovementRule(): void {
  selectedTerrainDraft.value.movementRuleAdded = false;
  movementRuleExpanded.value = false;
  movementExpressionJson.value = "";
}
function syncMovementRuleExpanded(event: Event): void {
  movementRuleExpanded.value = (event.currentTarget as HTMLDetailsElement).open;
}
const movementExpressionJson = computed({
  get: () => selectedTerrainDraft.value.movementExpressionJson,
  set: (value: string) => { selectedTerrainDraft.value.movementExpressionJson = value; }
});
const maxCounterattacks = computed({
  get: () => selectedTerrainDraft.value?.maxCounterattacks ?? 0,
  set: (value: number) => { if (selectedTerrainDraft.value) selectedTerrainDraft.value.maxCounterattacks = value; }
});
function exhaustionModeFor(capabilityId: "core/exhaust-on-entry" | "core/exhaust-on-departure") {
  return computed({
    get: () => {
      const draft = selectedTerrainDraft.value;
      const binding = draft?.bindings.find((candidate) => candidate.id === capabilityId);
      return binding?.config?.triggerMode === "terrain-transition"
        || (capabilityId === "core/exhaust-on-departure" && binding?.config?.destinationTerrainIdNot === currentTerrainId.value)
        ? "terrain-transition" : "each-cell";
    },
    set: (value: "each-cell" | "terrain-transition") => {
      const draft = selectedTerrainDraft.value;
      if (!draft) return;
      draft.bindings = draft.bindings.map((binding) => {
        if (binding.id !== capabilityId) return binding;
        const config = { ...(binding.config ?? {}) };
        delete config.destinationTerrainIdNot;
        config.triggerMode = value;
        return { ...binding, config };
      });
    }
  });
}
const entryExhaustionTriggerMode = exhaustionModeFor("core/exhaust-on-entry");
const departureExhaustionTriggerMode = exhaustionModeFor("core/exhaust-on-departure");
const publishImageError = ref("");
const uploadedImageDataByUrl = new Map<string, string>();
const editingTerrainEntryId = ref<string | null>(null);
const publishSpatialPatterns = ref("[]");
const publishRules = ref("[]");
const publishCapabilityDefinitions = ref<TerrainModDefinition["capabilities"]>([]);
const creatorMode = ref<"visual" | "json">("visual");
const previewOccupied = ref(false);
const modJsonField = ref<HTMLTextAreaElement | null>(null);
const originalSettingIds = ref<string[]>([]);
const visualAssetCount = computed(() => new Set([
  ...(terrainDraft.value.baseMode === "image" && terrainDraft.value.baseImage ? [terrainDraft.value.baseImage] : []),
  ...(terrainDraft.value.overlay?.dataUrl ? [terrainDraft.value.overlay.dataUrl] : [])
]).size);
const currentModSlug = computed(() => publishModId.value.trim().replace(/^mod-/, ""));
const currentTerrainId = computed(() => terrainIdForModId(publishModId.value.trim()) ?? "mod/invalid");
const customCapabilityOptions = computed(() => (publishCapabilityDefinitions.value ?? [])
  .filter((capability) => !isSystemManagedTerrainCapability(capability.id)
    && !terrainCapabilityOptions.some((option) => option.id === capability.id))
  .map((capability) => ({ id: capability.id, label: capability.id.split("/").at(-1) ?? capability.id,
    description: "供 Mod 配置识别的自定义地块标记。" })));
const isTerrainOccupiable = computed(() => selectedCapabilities.value.includes("core/occupiable"));
// 可占领是地块能力总开关；供电源依赖传导供电，不能单独配置。
const capabilityGroups = [
  { id: "basic", label: "基础类", ids: [
    "core/income-source", "core/counterattack-terrain-limit", "core/exhaust-unpowered-after-capture"
  ] },
  { id: "power", label: "电力类", ids: [
    "core/power-conductor", "core/power-source"
  ] },
  { id: "entry", label: "进入类", ids: ["core/exhaust-on-entry"] },
  { id: "exit", label: "离开类", ids: [
    "core/exhaust-on-departure", "core/departure-garrison"
  ] }
];
const visibleCapabilityGroups = computed(() => {
  if (!isTerrainOccupiable.value) return [];
  const optionsById = new Map(terrainCapabilityOptions.map((option) => [option.id, option]));
  const groups = capabilityGroups.map((group) => ({
    ...group,
    options: group.ids
      .filter((id) => group.id !== "exit" || selectedTerrainDraft.value.movementEnabled)
      .filter((id) => id !== "core/power-source" || selectedCapabilities.value.includes("core/power-conductor"))
      .flatMap((id) => {
        const option = optionsById.get(id);
        return option ? [option] : [];
      })
  })).filter((group) => group.options.length > 0 || group.id === "exit");
  if (customCapabilityOptions.value.length) groups.push({
    id: "custom", label: "空间标记",
    ids: [], options: customCapabilityOptions.value
  });
  return groups;
});
const totalSettingCount = computed(() => terrainDraft.value.settings.length);
const terrainArtClipPoints = getTerrainArtClipPoints();

function patchTerrainSetting(setting: TerrainModSetting, field: string, value: unknown): void {
  const draft = selectedTerrainDraft.value;
  if (!draft) return;
  draft.settings = draft.settings.map((candidate) => candidate.id === setting.id
    ? { ...candidate, [field]: value } as TerrainModSetting : candidate);
}
watch(currentModSlug, (nextSlug, previousSlug) => {
  if (!previousSlug || !nextSlug || previousSlug === nextSlug || editingTerrainEntryId.value) return;
  const previousRoot = `mod/${previousSlug}`;
  const nextRoot = `mod/${nextSlug}`;
  const remap = (id: string) => id === previousRoot || id.startsWith(`${previousRoot}/`) ? `${nextRoot}${id.slice(previousRoot.length)}` : id;
  const capabilityIds = new Map(publishCapabilityDefinitions.value.map((capability) => [capability.id, remap(capability.id)]));
  publishCapabilityDefinitions.value = publishCapabilityDefinitions.value.map((capability) => ({ ...capability, id: remap(capability.id) }));
  const draft = terrainDraft.value;
  draft.capabilities = draft.capabilities.map((id) => capabilityIds.get(id) ?? id);
  draft.bindings = draft.bindings.map((binding) => ({ ...binding, id: capabilityIds.get(binding.id) ?? binding.id }));
  draft.settings = draft.settings.map((setting) => ({ ...setting,
    target: { ...setting.target, capabilityId: capabilityIds.get(setting.target.capabilityId) ?? setting.target.capabilityId }
  }));
  publishSpatialPatterns.value = publishSpatialPatterns.value.split(previousRoot).join(nextRoot);
  publishRules.value = publishRules.value.split(previousRoot).join(nextRoot);
});
const terrainCapabilityOptions = [
  { id: "core/occupiable", label: "可占领", description: "允许单位占领该地块。" },
  { id: "core/terrain-movement", label: "可移动", description: "允许单位从该地块移动离开，并配置移动范围。" },
  { id: "core/power-conductor", label: "传导供电", description: "连接相邻供电单位。" },
  { id: "core/power-source", label: "供电源", description: "作为通电网络的供电起点。" },
  { id: "core/income-source", label: "地块收益", description: "己方回合开始时，地块满足前置条件后产生设定点数；收益为 0 时不产点。" },
  { id: "core/exhaust-on-entry", label: "进入时失活", description: "单位进入该地块后失去行动力。" },
  { id: "core/exhaust-on-departure", label: "离开时失活", description: "单位离开该地块后失去行动力。" },
  { id: "core/exhaust-unpowered-after-capture", label: "未通电游兵攻占后失活", description: "游兵通过攻击占领该地块后，如果占领后仍未通电，本回合失去行动力；占领后获得供电则不触发。" },
  { id: "core/departure-garrison", label: "离开时留兵", description: "单位离开时在原地留下游兵。" },
  { id: "core/counterattack-terrain-limit", label: "反击次数限制", description: "限制该地块每回合可反击次数。" }
];
function settingIdFor(base: string, terrainId: string): string {
  const suffix = terrainId.split("/").slice(2).join("-").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32) || "terrain";
  return `${base}-${suffix}`.slice(0, 64);
}

function createOrUpdateSetting(draft: TerrainDraft, capabilityId: string, configKey: string, baseId: string,
  displayName: string, value: number, min: number, max: number): TerrainModSetting {
  const previous = draft.settings.find((setting) => setting.target.capabilityId === capabilityId
    && setting.target.configKey === configKey);
  return {
    ...(previous ?? { id: settingIdFor(baseId, currentTerrainId.value), displayName, kind: "integer" as const, min, max }),
    id: previous?.id ?? settingIdFor(baseId, currentTerrainId.value),
    displayName: previous?.displayName ?? displayName,
    kind: "integer",
    defaultValue: value,
    min: previous?.kind === "integer" ? previous.min : min,
    max: previous?.kind === "integer" ? previous.max : max,
    target: { capabilityId, configKey }
  } as TerrainModSetting;
}

function assetIdFor(draft: TerrainDraft, slot: string): string {
  const slug = currentModSlug.value.replace(/[^a-z0-9-]/gi, "-").replace(/^-+|-+$/g, "").slice(0, 12) || "terrain";
  return `m-${slug}-${slot}`.slice(0, 32);
}

function asAssetReferenceDefinition(definition: TerrainModDefinition): TerrainModDefinitionAssetReferences {
  const urlByDataUrl = new Map<string, string>();
  const draft = terrainDraft.value;
  if (draft.baseImage && draft.baseImageUrl) urlByDataUrl.set(draft.baseImage, draft.baseImageUrl);
  if (draft.overlay?.dataUrl && draft.overlay.assetUrl) {
    urlByDataUrl.set(draft.overlay.dataUrl, draft.overlay.assetUrl);
  }
  return {
    ...definition,
    visualAssets: (definition.visualAssets ?? []).map(({ id, dataUrl }) => ({ id, url: urlByDataUrl.get(dataUrl) ?? "" }))
  };
}

function terrainIdForModId(modId: string): string | undefined {
  return /^mod-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(modId) ? `mod/${modId.slice(4)}` : undefined;
}

function terrainModAuthoringJson(
  name: string,
  description: string,
  definition: TerrainModDefinition,
  visualAssetUrls?: Readonly<Record<string, string>>
) {
  const definitionReferences = visualAssetUrls
    ? {
      ...definition,
      visualAssets: (definition.visualAssets ?? []).map(({ id, dataUrl }) => {
        const url = visualAssetUrls[id];
        return { id, url: url ?? "" };
      })
    }
    : asAssetReferenceDefinition(definition);
  const { terrain, ...definitionFields } = definitionReferences;
  return {
    name,
    description,
    definition: {
      ...definitionFields,
      terrain
    }
  };
}

function normalizeTerrainModAuthoringDefinition(
  value: TerrainModDefinition
): TerrainModDefinition {
  if (!isRecord(value) || !isRecord(value.terrain)) throw new Error("definition 必须包含单个 terrain 对象。");
  return value;
}

const guidedTerrainDefinition = computed<TerrainModDefinition>(() => {
  const draft = terrainDraft.value;
  const exitCapabilityIds = ["core/exhaust-on-departure", "core/departure-garrison"];
  const configuredCapabilityIds = draft.movementEnabled
    ? draft.capabilities
    : draft.capabilities.filter((id) => !exitCapabilityIds.includes(id));
  const settings: TerrainModSetting[] = draft.settings.filter((setting) =>
    !["core/income-source", "core/departure-garrison", "core/counterattack-terrain-limit"].includes(setting.target.capabilityId)
    && configuredCapabilityIds.includes(setting.target.capabilityId));
  if (configuredCapabilityIds.includes("core/income-source")) settings.push(createOrUpdateSetting(
    draft, "core/income-source", "amount", "incomePerTurn", "每回合收益", draft.incomeAmount, 0, 20));
  if (configuredCapabilityIds.includes("core/departure-garrison")) settings.push(createOrUpdateSetting(
    draft, "core/departure-garrison", "strength", "departureGarrisonStrength", "离开时留下的兵力", draft.departureGarrisonStrength, 1, 20));
  if (configuredCapabilityIds.includes("core/counterattack-terrain-limit")) settings.push(createOrUpdateSetting(
    draft, "core/counterattack-terrain-limit", "maxPerActionPhase", "maxCounterattacks", "每回合反击次数", draft.maxCounterattacks, 0, 6));
  const knownCapabilityIds = ["core/income-source", "core/departure-garrison", "core/counterattack-terrain-limit"];
  const capabilities = [...(publishCapabilityDefinitions.value ?? [])]
    .filter((entry) => entry.id !== "core/terrain-movement"
      && (draft.movementEnabled || !exitCapabilityIds.includes(entry.id)));
  capabilities.push({ id: "core/terrain-movement", target: "terrain", defaultConfig: { enabled: true } });
  for (const id of knownCapabilityIds) {
    if (configuredCapabilityIds.includes(id) && !capabilities.some((entry) => entry.id === id)) {
      capabilities.push({ id, target: "terrain", defaultConfig: id === "core/income-source"
        ? { amount: 0, requires: "occupied", when: "owner-turn-start" } : id === "core/departure-garrison"
          ? { strength: 1, requires: "occupied", unitDefinitionId: "core/roamer" } : { maxPerActionPhase: 0 } });
    }
  }
  const visualAssets: { id: string; dataUrl: string }[] = [];
  const registerVisualAsset = (draft: TerrainDraft, slot: string, dataUrl: string): string => {
    const existingAsset = visualAssets.find((asset) => asset.dataUrl === dataUrl);
    if (existingAsset) return existingAsset.id;
    const id = assetIdFor(draft, slot);
    visualAssets.push({ id, dataUrl });
    return id;
  };
  const overlayAssetId = draft.overlay?.dataUrl ? registerVisualAsset(draft, "overlay", draft.overlay.dataUrl) : undefined;
  const baseAssetId = draft.baseMode === "image" && draft.baseImage ? registerVisualAsset(draft, "base", draft.baseImage) : undefined;
  const overlay = draft.overlay && overlayAssetId ? {
    assetId: overlayAssetId,
    scale: draft.overlay.scale,
    opacity: draft.overlay.opacity,
    offsetX: draft.overlay.offsetX,
    offsetY: draft.overlay.offsetY,
    ...(draft.overlay.whenOccupied ? { whenOccupied: true } : {})
  } : undefined;
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
  const movementConfig: Record<string, unknown> = {};
  if (!draft.movementEnabled) movementConfig.enabled = false;
  if (draft.movementRuleAdded) {
    try { movementConfig.expression = JSON.parse(draft.movementExpressionJson) as unknown; }
    catch { /* Form validation reports an invalid path expression on submit. */ }
  }
  return {
    id: publishModId.value.trim(),
    version: publishModVersion.value.trim(),
    capabilities,
    ...(settings.length ? { settings } : {}),
    ...(spatialPatterns.length ? { spatialPatterns } : {}),
    ...(rules.length ? { rules } : {}),
    visualAssets,
    terrain: {
      capabilities: [
        { id: "core/terrain-movement", ...(Object.keys(movementConfig).length ? { config: movementConfig } : {}) },
        ...configuredCapabilityIds.map((id) => {
        const existing = draft.bindings.find((binding) => binding.id === id);
        if (id === "core/income-source") {
          const config = { ...(existing?.config ?? {}) };
          delete config.condition;
          delete config.requires;
          const customCondition = draft.incomeCustomEnabled
            ? parseIncomeConditionJson(draft.incomeConditionJson) : undefined;
          return { id, config: {
            ...config,
            amount: draft.incomeAmount,
            requires: "occupied",
            ...(draft.incomeCustomEnabled && customCondition?.valid
              ? { condition: customCondition.condition } : {}),
            when: "owner-turn-start"
          } };
        }
        if (id === "core/departure-garrison") return { id, config: {
          ...(existing?.config ?? {}), strength: draft.departureGarrisonStrength,
          requires: draft.departureGarrisonRequirement, unitDefinitionId: "core/roamer"
        } };
        if (id === "core/counterattack-terrain-limit") return { id, config: { ...(existing?.config ?? {}), maxPerActionPhase: draft.maxCounterattacks } };
        return existing ?? { id };
        })
      ],
      visuals: {
        ...(draft.baseMode === "color" ? { baseColor: draft.baseColor } : {}),
        ...(baseAssetId ? { baseAssetId } : {}),
        baseOpacity: draft.baseOpacity,
        ...(overlay ? { overlay } : {})
      }
    }
  };
});

const generatedTerrainDefinition = computed<TerrainModDefinition>(() => guidedTerrainDefinition.value);
const publishTerrainModJson = computed(() => JSON.stringify(
  terrainModAuthoringJson(publishTerrainName.value, publishTerrainDescription.value, generatedTerrainDefinition.value),
  null,
  2
));

const publishError = ref("");
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
    return JSON.stringify(terrainModAuthoringJson(entry.name, entry.description, definition, selectedDefinitionAssetUrls.value), null, 2);
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

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : "1.0.1";
}

function hydrateTerrainDrafts(
  definition: TerrainModDefinition,
  visualAssetUrls: Readonly<Record<string, string>> = {}
): void {
  const assets = new Map((definition.visualAssets ?? []).map((asset) => [asset.id, asset.dataUrl]));
  for (const [assetId, dataUrl] of assets) {
    const url = visualAssetUrls[assetId];
    if (url) uploadedImageDataByUrl.set(url, dataUrl);
  }
  const settings = definition.settings ?? [];
  originalSettingIds.value = settings.map((setting) => setting.id);
  publishCapabilityDefinitions.value = definition.capabilities.filter((capability) => !isSystemManagedTerrainCapability(capability.id));
  publishSpatialPatterns.value = JSON.stringify(definition.spatialPatterns ?? [], null, 2);
  publishRules.value = JSON.stringify(definition.rules ?? [], null, 2);
  const terrain = definition.terrain;
  const movementConfig = terrain.capabilities.find((binding) => binding.id === "core/terrain-movement")?.config;
  const bindings = terrain.capabilities.filter((binding) => !isSystemManagedTerrainCapability(binding.id)
    && binding.id !== "core/terrain-movement")
    .map((binding) => ({ ...binding }));
  const terrainSettings = settings;
  const readIntegerSetting = (capabilityId: string, configKey: string, fallback: number): number => {
    const setting = terrainSettings.find((candidate): candidate is Extract<TerrainModSetting, { kind: "integer" }> =>
      candidate.target.capabilityId === capabilityId && candidate.target.configKey === configKey && candidate.kind === "integer");
    return setting?.defaultValue ?? fallback;
  };
  const readIntegerBinding = (capabilityId: string, configKey: string, fallback: number) => {
    const value = bindings.find((binding) => binding.id === capabilityId)?.config?.[configKey];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const incomeConfig = bindings.find((binding) => binding.id === "core/income-source")?.config ?? {};
  const legacyPoweredCondition = incomeConfig.requires === "powered-occupant"
    ? { op: "unit-is-powered" } : undefined;
  const customIncomeCondition = incomeConfig.condition ?? legacyPoweredCondition;
  const visuals = terrain.visuals;
  terrainDraft.value = {
    key: `terrain-draft-${++terrainDraftSequence}`,
    capabilities: bindings.map((binding) => binding.id),
    bindings,
    settings: terrainSettings.map((setting) => ({ ...setting })),
    baseMode: visuals?.baseAssetId ? "image" : "color",
    baseColor: visuals?.baseColor ?? "#638f67",
    baseImage: visuals?.baseAssetId ? assets.get(visuals.baseAssetId) ?? "" : "",
    baseImageUrl: visuals?.baseAssetId ? visualAssetUrls[visuals.baseAssetId] ?? "" : "",
    baseImageUploading: false,
    baseOpacity: visuals?.baseTransparent === true ? 0 : visuals?.baseOpacity ?? 1,
    overlay: visuals?.overlay ? {
      dataUrl: assets.get(visuals.overlay.assetId) ?? "",
      assetUrl: visualAssetUrls[visuals.overlay.assetId] ?? "",
      imageUploading: false,
      scale: visuals.overlay.scale,
      opacity: visuals.overlay.opacity,
      offsetX: visuals.overlay.offsetX,
      offsetY: visuals.overlay.offsetY,
      whenOccupied: visuals.overlay.whenOccupied ?? false
    } : null,
    incomeAmount: readIntegerSetting("core/income-source", "amount",
      readIntegerBinding("core/income-source", "amount", 2)),
    incomeCustomEnabled: customIncomeCondition !== undefined,
    incomeConditionJson: customIncomeCondition === undefined ? "" : JSON.stringify(customIncomeCondition, null, 2) ?? "",
    movementEnabled: movementConfig?.enabled !== false,
    movementRuleAdded: movementConfig?.expression !== undefined,
    movementExpressionJson: movementConfig?.expression === undefined
      ? "" : JSON.stringify(movementConfig.expression, null, 2) ?? "",
    departureGarrisonStrength: readIntegerSetting("core/departure-garrison", "strength",
      readIntegerBinding("core/departure-garrison", "strength", 1)),
    departureGarrisonRequirement: bindings.find((binding) => binding.id === "core/departure-garrison")?.config?.requires === "powered-occupant"
      ? "powered-occupant" : "occupied",
    maxCounterattacks: readIntegerSetting("core/counterattack-terrain-limit", "maxPerActionPhase",
      readIntegerBinding("core/counterattack-terrain-limit", "maxPerActionPhase", 0))
  };
  movementRuleExpanded.value = movementConfig?.expression !== undefined;
}

function addOverlay(): void {
  const draft = selectedTerrainDraft.value;
  if (!draft || draft.overlay) return;
  draft.overlay = { dataUrl: "", assetUrl: "", imageUploading: false,
    scale: 0.64, opacity: 0.78, offsetX: 0, offsetY: 0, whenOccupied: false };
}

function removeOverlay(): void {
  const draft = selectedTerrainDraft.value;
  if (draft) draft.overlay = null;
}

function addTerrainSetting(): void {
  const draft = selectedTerrainDraft.value;
  if (!draft || totalSettingCount.value >= 32 || !draft.capabilities.length) return;
  const capabilityId = draft.capabilities[0]!;
  const idBase = `custom-${terrainDraftSequence + 1}-${totalSettingCount.value + 1}`;
  let settingId = /^[a-zA-Z]/.test(idBase) ? idBase : `setting-${idBase}`;
  let suffix = 2;
  while (draft.settings.some((setting) => setting.id === settingId)) {
    settingId = `${idBase}-${suffix++}`.slice(0, 64);
  }
  draft.settings.push({ id: settingId, displayName: "新设置", description: "房间中可由房主调整。", kind: "integer",
    defaultValue: 1, min: 0, max: 10,
    target: { capabilityId, configKey: `value${draft.settings.length + 1}` } });
}

function canRemoveSetting(setting: TerrainModSetting): boolean {
  return !originalSettingIds.value.includes(setting.id);
}

function removeTerrainSetting(setting: TerrainModSetting): void {
  const draft = selectedTerrainDraft.value;
  if (draft && canRemoveSetting(setting)) draft.settings = draft.settings.filter((candidate) => candidate.id !== setting.id);
}

function updateSettingKind(setting: TerrainModSetting, kind: string): void {
  if (!canRemoveSetting(setting)) return;
  const draft = selectedTerrainDraft.value;
  if (!draft) return;
  const base = { id: setting.id, displayName: setting.displayName, target: setting.target,
    ...(setting.description === undefined ? {} : { description: setting.description }) };
  let replacement: TerrainModSetting;
  if (kind === "boolean") replacement = { ...base, kind, defaultValue: false };
  else if (kind === "choice") replacement = { ...base, kind, defaultValue: "选项一", options: ["选项一", "选项二"] };
  else replacement = { ...base, kind: "integer", defaultValue: 1, min: 0, max: 10 };
  draft.settings = draft.settings.map((candidate) => candidate.id === setting.id ? replacement : candidate);
}

function updateChoiceOptions(setting: Extract<TerrainModSetting, { kind: "choice" }>, value: string): void {
  const options = [...new Set(value.split(/[,，\n]/).map((option) => option.trim()).filter(Boolean))].slice(0, 32);
  const defaultValue = options.includes(setting.defaultValue) ? setting.defaultValue : options[0] ?? "";
  const draft = selectedTerrainDraft.value;
  if (draft) draft.settings = draft.settings.map((candidate) => candidate.id === setting.id
    ? { ...setting, options, defaultValue } : candidate);
}

function updateSettingCapability(setting: TerrainModSetting, capabilityId: string): void {
  patchTerrainSetting(setting, "target", { ...setting.target, capabilityId });
}

function updateSettingConfigKey(setting: TerrainModSetting, configKey: string): void {
  patchTerrainSetting(setting, "target", { ...setting.target, configKey });
}

function updateBindingConfig(capabilityId: string, json: string): void {
  try {
    const config = JSON.parse(json) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    const draft = selectedTerrainDraft.value;
    if (draft) draft.bindings = draft.bindings.map((binding) => binding.id === capabilityId
      ? { ...binding, config: config as Record<string, unknown> } : binding);
    publishError.value = "";
  } catch {
    publishError.value = `能力 ${capabilityId} 的参数必须是有效 JSON 对象。`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function materializeJsonDefinition(value: unknown): Promise<{
  readonly definition: TerrainModDefinition;
  readonly visualAssetUrls: Readonly<Record<string, string>>;
}> {
  if (!isRecord(value)) throw new Error("definition 必须是 JSON 对象。");
  if (value.visualAssets === undefined) return { definition: value as unknown as TerrainModDefinition, visualAssetUrls: {} };
  if (!Array.isArray(value.visualAssets)) throw new Error("visualAssets 必须是图片资源数组。");
  const visualAssetUrls: Record<string, string> = {};
  const visualAssets: Array<{ id: string; dataUrl: string }> = [];
  for (const rawAsset of value.visualAssets) {
    if (!isRecord(rawAsset) || typeof rawAsset.id !== "string") throw new Error("图片资源必须包含 id 和 url。");
    if (typeof rawAsset.url === "string") {
      if (!/^assets\/terrain\/[a-f0-9]{64}\.(?:png|webp|svg)$/.test(rawAsset.url)) throw new Error("图片 URL 格式无效。");
      const dataUrl = uploadedImageDataByUrl.get(rawAsset.url) ?? await props.downloadTerrainAsset(rawAsset.url);
      uploadedImageDataByUrl.set(rawAsset.url, dataUrl);
      visualAssetUrls[rawAsset.id] = rawAsset.url;
      visualAssets.push({ id: rawAsset.id, dataUrl });
      continue;
    }
    if (typeof rawAsset.dataUrl === "string") {
      const assetUrl = await props.uploadTerrainAsset(rawAsset.dataUrl);
      if (!/^assets\/terrain\/[a-f0-9]{64}\.(?:png|webp|svg)$/.test(assetUrl)) throw new Error("后台返回了无效的图片地址。");
      visualAssetUrls[rawAsset.id] = assetUrl;
      uploadedImageDataByUrl.set(assetUrl, rawAsset.dataUrl);
      visualAssets.push({ id: rawAsset.id, dataUrl: rawAsset.dataUrl });
      continue;
    }
    throw new Error(`图片资源 ${rawAsset.id} 缺少后台 URL。`);
  }
  return {
    definition: { ...value, visualAssets } as unknown as TerrainModDefinition,
    visualAssetUrls
  };
}

async function applyTerrainModJsonText(value: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(value) as Partial<TerrainModSubmission>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || typeof parsed.name !== "string" || typeof parsed.description !== "string"
      || !parsed.definition || typeof parsed.definition !== "object" || Array.isArray(parsed.definition)
      || Object.keys(parsed).some((key) => !["name", "description", "definition"].includes(key))) {
      throw new Error("JSON 必须包含 name、description 和 definition 三个字段。");
    }
    const { definition: materializedDefinition, visualAssetUrls } = await materializeJsonDefinition(parsed.definition);
    const candidate = normalizeTerrainModAuthoringDefinition(materializedDefinition);
    validateTerrainModDefinition(candidate, { requireBaseLayer: true });
    publishTerrainName.value = parsed.name;
    publishTerrainDescription.value = parsed.description;
    publishModId.value = candidate.id;
    publishModVersion.value = candidate.version;
    hydrateTerrainDrafts(candidate, visualAssetUrls);
    publishError.value = "";
    return true;
  } catch (error) {
    publishError.value = error instanceof Error ? error.message : "Mod JSON 无效，请检查名称、说明、定义及图层资源。";
    return false;
  }
}

async function applyTerrainModJson(event: Event): Promise<void> {
  await applyTerrainModJsonText((event.target as HTMLTextAreaElement).value);
}

async function switchCreatorMode(mode: "visual" | "json"): Promise<void> {
  if (creatorMode.value === "json" && mode === "visual" && modJsonField.value
    && !await applyTerrainModJsonText(modJsonField.value.value)) return;
  creatorMode.value = mode;
}

function editTerrain(entry: TerrainModEntry): void {
  if (!entry.definition || !entry.modId || entry.authorName !== props.currentAuthorName.trim()) return;
  editingTerrainEntryId.value = entry.id;
  publishTerrainName.value = entry.name;
  publishTerrainDescription.value = entry.description;
  publishModId.value = entry.modId;
  publishModVersion.value = nextPatchVersion(entry.version);
  hydrateTerrainDrafts(entry.definition, entry.visualAssetUrls);
  creatorMode.value = "visual";
  publishError.value = "";
  category.value = "terrain";
  viewMode.value = "publish";
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

function openPublish(): void {
  if (!props.publishingEnabled) return;
  editingTerrainEntryId.value = null;
  publishTerrainName.value = "";
  publishTerrainDescription.value = "";
  publishModId.value = "mod-my-terrain";
  publishModVersion.value = "1.0.0";
  creatorMode.value = "visual";
  originalSettingIds.value = [];
  publishCapabilityDefinitions.value = [];
  publishSpatialPatterns.value = "[]";
  publishRules.value = "[]";
  terrainDraft.value = createTerrainDraft();
  movementRuleExpanded.value = false;
  publishImageError.value = "";
  publishError.value = "";
  viewMode.value = "publish";
}

async function readAsDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片编码失败。"));
    reader.onerror = () => reject(new Error("无法读取图片文件。"));
    reader.readAsDataURL(blob);
  });
}

async function compressTerrainImage(file: File): Promise<string> {
  const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
  if (isSvg) {
    if (file.size > 128 * 1024) throw new Error("SVG 文件不能超过 128 KiB。");
    const source = await file.text();
    if (!/<svg\b[\s\S]*<\/svg>\s*$/i.test(source)
      || /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|animate|set)\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*(["'])(?!#)|javascript:|@import|url\(\s*(['"]?)(?!#)/i.test(source)) {
      throw new Error("请上传无脚本、无外部资源的静态 SVG 图案。");
    }
    return await readAsDataUrl(file);
  }
  if (!["image/png", "image/webp", "image/jpeg"].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error("请选择 8 MiB 以内的 PNG、WebP、JPG 或 SVG 图片。");
  }
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(16, Math.round(bitmap.width * scale));
      canvas.height = Math.max(16, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法处理此图片。");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const quality = Math.max(0.4, 0.84 - attempt * 0.08);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (blob && blob.size <= 128 * 1024) return await readAsDataUrl(blob);
      scale *= 0.82;
    }
    throw new Error("图片压缩后仍超过 128 KiB，请换一张更简单的图片。");
  } finally { bitmap.close(); }
}

async function setTerrainImage(event: Event, slot: "base" | "overlay"): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  publishImageError.value = "";
  let draft: TerrainDraft | undefined;
  let uploadingOverlay: TerrainOverlayDraft | null = null;
  try {
    draft = selectedTerrainDraft.value;
    if (!draft) throw new Error("请先选择一个地块。");
    uploadingOverlay = draft.overlay;
    if (slot === "overlay" && !uploadingOverlay) throw new Error("请先添加顶部图层。");
    const dataUrl = await compressTerrainImage(file);
    const retainedImages = new Set<string>();
    if (slot !== "base" && draft.baseImage) retainedImages.add(draft.baseImage);
    if (slot !== "overlay" && draft.overlay?.dataUrl) retainedImages.add(draft.overlay.dataUrl);
    if (!retainedImages.has(dataUrl) && retainedImages.size >= 4) {
      throw new Error("一个 Mod 最多使用 4 张不同的图片资源；相同图片可以复用。");
    }
    if (slot === "base") draft.baseImageUploading = true;
    else if (uploadingOverlay) uploadingOverlay.imageUploading = true;
    const assetUrl = await props.uploadTerrainAsset(dataUrl);
    if (!/^assets\/terrain\/[a-f0-9]{64}\.(?:png|webp|svg)$/.test(assetUrl)) throw new Error("后台返回了无效的图片地址。");
    uploadedImageDataByUrl.set(assetUrl, dataUrl);
    if (slot === "base") {
      draft.baseImage = dataUrl;
      draft.baseImageUrl = assetUrl;
      draft.baseMode = "image";
    } else if (draft.overlay === uploadingOverlay && uploadingOverlay) {
      uploadingOverlay.dataUrl = dataUrl;
      uploadingOverlay.assetUrl = assetUrl;
    }
  } catch (error) {
    publishImageError.value = error instanceof Error ? error.message : "地块图片处理失败。";
  } finally {
    if (draft && slot === "base") draft.baseImageUploading = false;
    else if (uploadingOverlay) uploadingOverlay.imageUploading = false;
  }
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

async function submitTerrainMod(): Promise<void> {
  if (creatorMode.value === "json" && modJsonField.value
    && !await applyTerrainModJsonText(modJsonField.value.value)) return;
  const name = publishTerrainName.value.trim();
  const description = publishTerrainDescription.value.trim();
  if (!name) { publishError.value = "请填写 Mod 名称。"; return; }
  if (publishImageError.value) { publishError.value = publishImageError.value; return; }
  if (totalSettingCount.value > 32) { publishError.value = "一个 Mod 最多定义 32 个可配置项。"; return; }
  if (visualAssetCount.value > 4) { publishError.value = "一个 Mod 最多使用 4 张图片资源。"; return; }
  if (terrainDraft.value.baseImageUploading || terrainDraft.value.overlay?.imageUploading) {
    publishError.value = "图片还在上传，请稍后再发布。";
    return;
  }
  const invalidIncomeCondition = terrainDraft.value.capabilities.includes("core/income-source")
    && terrainDraft.value.incomeCustomEnabled && !parseIncomeConditionJson(terrainDraft.value.incomeConditionJson).valid;
  if (invalidIncomeCondition) {
    publishError.value = `地块「${publishTerrainName.value.trim() || "未命名地块"}」已启用自定义收益条件，请填写有效 JSON；不需要额外条件时请关闭开关。`;
    return;
  }
  if (terrainDraft.value.movementEnabled && terrainDraft.value.movementRuleAdded) {
    try { JSON.parse(terrainDraft.value.movementExpressionJson); }
    catch {
      publishError.value = "已添加自定义移动规则，请填写有效表达式；如需沿用单位默认范围，请移除自定义规则。";
      return;
    }
  }
  const definition = generatedTerrainDefinition.value;
  if (!definition.id || !definition.version) {
    publishError.value = "请填写 Mod ID 和版本。";
    return;
  }
  const assetIds = new Set((definition.visualAssets ?? []).map((asset) => asset.id));
  if (definition.terrain.visuals?.baseTransparent !== true
    && !/^#[0-9a-fA-F]{6}$/.test(definition.terrain.visuals?.baseColor ?? "")
    && (!definition.terrain.visuals?.baseAssetId || !assetIds.has(definition.terrain.visuals.baseAssetId))) {
    publishError.value = "地块必须选择纯色、有效图片或透明底作为底部外观。";
    return;
  }
  try {
    validateTerrainModDefinition(definition, { requireBaseLayer: true });
  } catch (error) {
    publishError.value = error instanceof Error ? error.message : "Mod 配置无效，请检查地块、设置和图片引用。";
    return;
  }
  const definitionReferences = asAssetReferenceDefinition(definition);
  if (definitionReferences.visualAssets?.some((reference) => !reference.url)) {
    publishError.value = "请等待图片上传完成；如果图片地址无效，请重新选择图片。";
    return;
  }
  if (editingTerrainEntryId.value) {
    const current = props.terrainMods.find((entry) => entry.id === editingTerrainEntryId.value);
    if (!current || definition.id !== current.modId || compareModVersions(definition.version, current.version) <= 0) {
      publishError.value = "Mod ID 必须保持不变，且更新版本必须高于当前版本。";
      return;
    }
    publishError.value = "";
    emit("publish-terrain-mod", { updateId: editingTerrainEntryId.value, name, description, definition: definitionReferences });
    return;
  }
  publishError.value = "";
  emit("publish-terrain-mod", { name, description, definition: definitionReferences });
}

function toggleCapability(id: string): void {
  const draft = selectedTerrainDraft.value;
  if (!draft) return;
  const isSelected = draft.capabilities.includes(id);
  if (id === "core/power-source" && !isSelected && !draft.capabilities.includes("core/power-conductor")) {
    publishError.value = "供电源必须同时选择传导供电。";
    return;
  }
  const removedIds = id === "core/power-conductor" && isSelected
    ? [id, "core/power-source"] : [id];
  if (id === "core/power-conductor" && isSelected
    && draft.capabilities.includes("core/departure-garrison")
    && draft.departureGarrisonRequirement === "powered-occupant") {
    publishError.value = "这个地块的留兵条件依赖传导供电；请先改为无条件留兵，再关闭传导供电。";
    return;
  }
  if (isSelected && draft.settings.some((setting) => removedIds.includes(setting.target.capabilityId))) {
    publishError.value = "先移除此能力关联的可配置项，再取消能力；已发布版本中的旧设置不能删除。";
    return;
  }
  draft.capabilities = isSelected
    ? draft.capabilities.filter((candidate) => !removedIds.includes(candidate))
    : [...draft.capabilities, id];
  if (isSelected) draft.bindings = draft.bindings.filter((binding) => !removedIds.includes(binding.id));
  else {
    const definition = publishCapabilityDefinitions.value.find((capability) => capability.id === id);
    draft.bindings = [...draft.bindings, definition
      ? { id, config: { ...definition.defaultConfig } } : { id }];
  }
  publishError.value = "";
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

        <article v-else class="publish-card mod-creator">
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
    </div>
  </section>
  <ConditionReferenceDialog v-if="showConditionReference" @close="showConditionReference = false" />
</template>

<style scoped>
.workshop-heading-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.workshop-heading-actions>button{width:auto;margin:0;padding:8px 11px;font-size:10px}.condition-reference-entry{border:1px solid rgba(117,211,198,.28);color:#9bddd5;background:rgba(28,76,79,.2)}
.workshop{padding:clamp(18px,3vw,34px);border:1px solid rgba(134,177,205,.3);border-radius:24px;background:linear-gradient(145deg,#1a2c40,#101f31);box-shadow:0 24px 65px rgba(0,6,17,.25)}
.release-history{display:grid;gap:8px}.release-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 11px;border:1px solid rgba(135,175,202,.18);border-radius:9px;background:rgba(4,14,24,.35)}.release-row span,.release-row small{display:block;min-width:0}.release-row b{color:#e1eff8;font-size:12px}.release-row small{margin-top:3px;color:#8298aa;font-size:10px}.release-row button{flex:none;padding:5px 9px;border:1px solid rgba(134,177,205,.25);border-radius:7px;color:#b6d1df;background:#142538;font-size:10px}.release-row button.active{color:#87ead8;border-color:#4eaea9}.terrain-art-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:14px;border:1px solid rgba(118,176,196,.22);border-radius:12px;background:rgba(5,18,30,.35)}.terrain-art-form>div:first-child{grid-column:1/-1}.terrain-art-form>div:first-child strong,.terrain-art-form>div:first-child small,.terrain-art-form label small{display:block}.terrain-art-form>div:first-child strong{color:#e3f3fb;font-size:12px}.terrain-art-form>div:first-child small,.terrain-art-form label small{margin-top:4px;color:#8fa7b9;font-size:10px;line-height:1.5}.terrain-art-form label{display:grid;gap:6px;color:#c6dce8;font-size:11px}.terrain-art-form input[type=file]{width:100%;min-width:0;padding:7px;border:1px solid rgba(127,169,193,.22);border-radius:8px;color:#aec2d0;background:rgba(17,34,49,.8);font-size:10px}.terrain-art-form .terrain-color-label{display:flex;align-items:center;justify-content:space-between}.terrain-color-label input{width:52px;height:31px;padding:2px;border:1px solid rgba(127,169,193,.3);border-radius:7px;background:#0d1c2a}.terrain-art-status{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:7px;color:#91b7bd;font-size:10px}.terrain-art-status button{margin:0;padding:3px 7px;border:1px solid rgba(127,169,193,.25);border-radius:6px;color:#e7adb3;background:rgba(94,38,50,.22);font-size:10px}.terrain-art-form>.form-error{grid-column:1/-1}
.workshop-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:22px}.eyebrow{margin:0 0 5px;color:#7de6d3;font-size:10px;font-weight:900;letter-spacing:.18em}.workshop-heading h2{margin:0;color:#f4f9ff;font-size:clamp(28px,4vw,42px);letter-spacing:-.035em}.workshop-heading p:not(.eyebrow){max-width:650px;margin:7px 0 0;color:#91a9be;font-size:12px;line-height:1.65}.back-button{width:auto;min-width:130px;margin:0;border:1px solid rgba(143,188,206,.32);color:#cde6f1;background:rgba(18,47,65,.5)}
.category-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:16px}.category-nav button{display:flex;align-items:center;gap:12px;min-height:72px;margin:0;padding:13px 17px;border:1px solid rgba(134,177,205,.27);border-radius:14px;color:#cde4f2;background:rgba(8,22,35,.45);text-align:left}.category-nav button.active{border-color:#75dccc;background:rgba(44,103,111,.32);box-shadow:inset 0 -3px #75dccc}.category-icon{font-size:27px;color:#88dcca;line-height:1}.category-nav strong,.category-nav small{display:block}.category-nav strong{font-size:15px}.category-nav small{margin-top:3px;color:#8faabb;font-size:10px}.action-message{padding:10px 13px;border:1px solid rgba(109,221,176,.32);border-radius:10px;color:#9ee9bd;background:rgba(51,106,83,.2);font-size:12px}.action-message.error{border-color:rgba(241,132,149,.4);color:#f4b1ba;background:rgba(112,48,66,.2)}
.workshop-grid{display:grid;grid-template-columns:minmax(240px,.33fr) minmax(0,.67fr);gap:16px;align-items:start}.entry-list-card,.detail-card,.publish-card{min-width:0;padding:18px;border:1px solid rgba(135,175,202,.24);border-radius:18px;background:rgba(8,22,35,.58)}.section-heading{display:flex;justify-content:space-between;gap:10px;align-items:center}.section-heading strong{color:#e6f2fb;font-size:14px}.section-heading span{color:#718da5;font-size:10px}.entry-list{display:grid;gap:8px;margin-top:15px}.entry-button{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:9px;align-items:center;min-height:65px;margin:0;padding:9px 11px;border:1px solid rgba(128,172,195,.2);color:#dbe9f2;background:rgba(32,59,77,.38);text-align:left}.entry-button.selected{border-color:#74dfcf;background:rgba(42,111,116,.25);box-shadow:inset 3px 0 #74dfcf}.entry-symbol{font-size:23px;line-height:1}.terrain-symbol{color:#d8b77e}.map-symbol{color:#88cde5}.entry-copy{min-width:0}.entry-copy strong,.entry-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entry-copy strong{font-size:13px}.entry-copy small{margin-top:4px;color:#8da7b9;font-size:10px}.entry-status{color:#e1a6ad;font-size:10px;white-space:nowrap}.entry-status.installed{color:#99e9bd}.empty-list{margin:17px 0 0;color:#91a8ba;font-size:12px;line-height:1.6}.detail-stack{display:grid;gap:15px}.detail-overline,.title-row,.source-heading,.detail-actions,.submit-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.detail-overline{color:#78b9c7;font-size:9px;font-weight:900;letter-spacing:.12em;overflow-wrap:anywhere}.detail-overline span:last-child{text-align:right}.title-row{align-items:start;margin:12px 0 14px}.title-row h3{margin:0;color:#f3f9ff;font-size:26px}.title-row p{margin:4px 0 0;color:#8eabba;font-size:11px}.status-pill{padding:5px 8px;border:1px solid rgba(243,159,169,.28);border-radius:7px;color:#eba8b1;font-size:10px;white-space:nowrap}.status-pill.installed{border-color:rgba(125,230,175,.32);color:#9ee9be}.description,.readme{margin:12px 0;color:#b6c9d7;font-size:12px;line-height:1.7;white-space:pre-wrap}.terrain-preview-image{display:block;max-width:100%;max-height:250px;margin:15px auto;border:1px solid rgba(138,179,203,.25);border-radius:12px;object-fit:contain}.metadata-block{padding:12px 0;border-top:1px solid rgba(140,180,202,.15)}.metadata-block>strong,.source-heading strong{color:#dcebf4;font-size:12px}.token-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}.token-list code{padding:5px 8px;border:1px solid rgba(126,198,194,.25);border-radius:7px;color:#9adfd9;background:rgba(34,84,89,.2);font-size:10px}.quiet{margin:9px 0 0;color:#829db1;font-size:11px;line-height:1.5}.source-heading{padding-top:14px;border-top:1px solid rgba(140,180,202,.15)}.source-heading span{color:#7997a9;font-size:10px}.source-tabs{display:flex;gap:6px;max-width:100%;overflow:auto;margin-top:10px}.source-tabs button{width:auto;min-width:max-content;margin:0;padding:6px 9px;border:1px solid rgba(127,172,193,.3);color:#a7c1d1;background:#152c3d;font:10px ui-monospace,Consolas,monospace}.source-tabs button.active{border-color:#78dfd0;color:#c7f4ee}.source-code{max-height:330px;overflow:auto;margin:9px 0 0;padding:13px;border:1px solid rgba(125,167,191,.26);border-radius:10px;background:#0b1928;color:#d7e9f1;font:11px/1.6 ui-monospace,Consolas,monospace;white-space:pre}.source-empty{margin:12px 0 0;color:#819db0;font-size:11px}
.map-preview{display:grid;place-items:center;height:clamp(245px,30vw,370px);overflow:hidden;border:1px solid rgba(128,170,194,.27);border-radius:14px;background:#19293a}.map-preview svg{width:100%;height:100%;padding:12px}.preview-unavailable{display:grid;place-items:center;min-height:200px;padding:20px;border:1px solid rgba(128,170,194,.27);border-radius:14px;color:#8fa7ba;text-align:center;font-size:12px}.preview-caption{margin:8px 0 13px;color:#8da7b9;font-size:10px}.dependency-block{border-bottom:1px solid rgba(140,180,202,.15)}.dependency-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.dependency{display:grid;gap:3px;min-width:150px;padding:8px 10px;border:1px solid rgba(121,211,181,.28);border-radius:9px;background:rgba(38,92,76,.19)}.dependency.missing{border-color:rgba(239,157,164,.3);background:rgba(108,46,62,.18)}.dependency b{color:#e6f1ef;font-size:11px}.dependency code{color:#86b0bc;font-size:10px}.dependency em{color:#9fe2b7;font-size:10px;font-style:normal}.dependency.missing em{color:#f0a7b2}.dependency-warning{margin:10px 0;color:#f0a7b2;font-size:11px;line-height:1.6}.detail-actions{justify-content:flex-start;flex-wrap:wrap;margin-top:13px}.detail-actions button{width:auto;min-height:41px;margin:0}.primary-button{background:linear-gradient(120deg,#81e9ce,#70c9e7)}.outline-button{border:1px solid rgba(141,184,205,.3);color:#b9d4e4;background:rgba(27,54,73,.55)}.copy-message{margin:8px 0 0;color:#8de6bd;font-size:11px}.code-field,.publish-card input{box-sizing:border-box;width:100%;border:1px solid rgba(136,177,204,.31);border-radius:10px;outline:none;background:#0c1b2b;color:#d6e8f0;font:11px/1.6 ui-monospace,Consolas,monospace}.code-field{min-height:110px;padding:11px;resize:vertical}.code-field:focus,.publish-card input:focus{border-color:#76ddcc;box-shadow:0 0 0 3px rgba(118,221,204,.08)}.map-code{margin-top:10px}.publish-card>p{margin:10px 0 15px;color:#91adbd;font-size:11px;line-height:1.6}.publish-card label{display:grid;gap:6px;margin-top:11px;color:#b7ceda;font-size:11px;font-weight:700}.publish-card input{height:39px;padding:0 10px;font:12px system-ui,sans-serif}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.small-field{min-height:72px}.source-input{min-height:180px}.submit-row{justify-content:flex-end;align-items:flex-end;margin-top:12px}.submit-row .primary-button{width:auto;min-width:135px;margin:0}.form-error{flex:1;color:#f2a9b4;font-size:11px;line-height:1.5}
@media(max-width:850px){.workshop-grid{grid-template-columns:1fr}.entry-list{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}}@media(max-width:570px){.workshop{padding:15px}.workshop-heading{display:grid}.workshop-heading-actions{justify-content:flex-start}.back-button{min-height:42px}.category-nav button{padding:11px;min-height:64px}.category-icon{font-size:21px}.category-nav strong{font-size:13px}.entry-list-card,.detail-card,.publish-card{padding:13px}.title-row h3{font-size:23px}.form-grid{grid-template-columns:1fr}.detail-actions button{width:100%}.map-preview{height:250px}}
.workshop-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:18px 0 13px}.workshop-toolbar strong{color:#e6f2fb;font-size:16px}.workshop-toolbar p{max-width:750px;margin:5px 0 0;color:#93adbf;font-size:11px;line-height:1.6}.publish-entry{width:auto;min-width:160px;margin:0;padding:9px 13px;white-space:nowrap}.read-only-note{color:#aac5d5;font-size:11px}
.workshop-catalog{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}.workshop-work-card{display:block;width:100%;min-width:0;margin:0;padding:0;overflow:hidden;border:1px solid rgba(135,175,202,.24);border-radius:17px;color:#e8f2f9;background:rgba(8,22,35,.67);text-align:left;transition:border-color .18s,transform .18s,background .18s}.workshop-work-card:hover,.workshop-work-card:focus-visible{border-color:#79ddcd;background:rgba(16,40,55,.87);transform:translateY(-2px)}.core-terrain-card{cursor:default}.core-terrain-card:hover{border-color:rgba(135,175,202,.34);background:rgba(8,22,35,.75);transform:none}.work-card-preview{display:grid;place-items:center;height:165px;overflow:hidden;background:#182638}.work-card-preview svg{width:100%;height:100%;padding:13px}.terrain-card-preview{background:radial-gradient(circle at 50% 45%,rgba(238,178,93,.22),transparent 46%),#182638}.terrain-card-preview :deep(.terrain-art-tile){width:78px;height:88px}.terrain-card-preview :deep(.custom-art){max-width:160px;max-height:145px;object-fit:contain}.generic-terrain-mark{color:#dba861;font-size:100px;line-height:1}.thumbnail-placeholder{color:#86a7bb;font-size:11px}.work-card-info{display:grid;gap:8px;padding:13px 14px 15px}.work-card-title{display:flex;justify-content:space-between;align-items:center;gap:9px}.work-card-title strong{overflow:hidden;color:#eef6fb;font-size:16px;text-overflow:ellipsis;white-space:nowrap}.work-card-title em{flex:none;color:#efadb7;font-size:10px;font-style:normal}.work-card-title em.installed{color:#a1eabc}.core-terrain-badge{padding:3px 7px;border:1px solid rgba(222,188,122,.28);border-radius:99px;color:#e3c88d!important;background:rgba(164,117,49,.12);font-size:9px!important;white-space:nowrap}.work-card-description{display:-webkit-box;min-height:35px;overflow:hidden;color:#b4c9d7;font-size:11px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:2}.work-card-info small{color:#86a3b5;font-size:10px}.workshop-catalog>.empty-list{grid-column:1/-1;padding:28px;border:1px dashed rgba(135,175,202,.3);border-radius:14px;text-align:center}
.detail-stack{max-width:920px;margin:0 auto}.catalog-back{width:auto;justify-self:start;margin:0;padding:7px 12px;border:1px solid rgba(143,188,206,.28);color:#c6e3ef;background:rgba(18,47,65,.45);font-size:11px}.map-preview{height:clamp(270px,34vw,450px)}.map-preview :deep(.board-canvas){height:100%;border:none;border-radius:0}.install-unavailable{color:#e6bba7;font-size:11px;line-height:1.5}.dependency-warning{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:11px;border:1px solid rgba(239,157,164,.3);border-radius:10px;background:rgba(108,46,62,.16)}.dependency-warning button{width:auto;margin:0;padding:7px 10px;font-size:11px}
@media(max-width:570px){.workshop-toolbar{align-items:stretch;flex-direction:column}.publish-entry{width:100%}.workshop-catalog{grid-template-columns:1fr}.work-card-preview{height:155px}.map-preview{height:280px}}
.terrain-card-preview{position:relative;isolation:isolate;height:112px;background:#182638}.terrain-card-preview::before{display:none}.terrain-preview-image{max-width:min(100%,180px);max-height:140px;margin:12px auto}
.terrain-card-preview :deep(.terrain-art-collection){gap:8px;padding:6px}.terrain-card-preview :deep(.terrain-art-item){width:68px;font-size:8px}.terrain-card-preview :deep(.terrain-art-svg){width:68px;height:79px}
.capability-label{margin-top:16px;color:#b7ceda;font-size:11px;font-weight:700}.capability-picker{position:relative;margin-top:7px;border:1px solid rgba(136,177,204,.31);border-radius:10px;background:#0c1b2b}.capability-picker>summary,.definition-details>summary{display:flex;justify-content:space-between;align-items:center;min-height:40px;padding:0 12px;color:#cce1ec;font-size:12px;cursor:pointer;list-style:none}.capability-picker>summary::-webkit-details-marker,.definition-details>summary::-webkit-details-marker{display:none}.capability-picker[open]>summary{border-bottom:1px solid rgba(136,177,204,.2)}.capability-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:10px}.capability-option{display:flex!important;align-items:flex-start;gap:9px;margin:0!important;padding:9px;border:1px solid rgba(136,177,204,.17);border-radius:8px;background:rgba(29,51,69,.55)}.capability-option input{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:#75dccc}.capability-option span{display:grid;gap:3px}.capability-option strong{color:#dcebf4;font-size:11px}.capability-option small{color:#8eaabc;font-size:10px;font-weight:400;line-height:1.4}.capability-option code{color:#7ccfc7;font-size:9px}.definition-details{margin-top:12px;border:1px solid rgba(136,177,204,.2);border-radius:9px;background:rgba(12,27,43,.5)}.definition-details>summary{justify-content:flex-start;min-height:36px;color:#9fded7;font-size:11px}.definition-details .definition-preview{margin:0 10px 10px}.publish-card .form-grid{margin-top:2px}.publish-card .form-grid label{min-width:0}
.capability-config{margin-top:10px;padding:12px;border:1px solid rgba(136,177,204,.18);border-radius:10px;background:rgba(15,32,48,.55)}.capability-config p{grid-column:1/-1;margin:2px 0 0;color:#8eaabc;font-size:10px}.pattern-input{min-height:300px}
@media(max-width:570px){.capability-options{grid-template-columns:1fr}}
@media(max-width:570px){}
</style>

<style scoped>
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
</style>

<style scoped>
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
.release-row{align-items:center}.release-row>span{flex:1;min-width:0}.release-row button{width:auto;min-width:96px;flex:none;margin:0;white-space:nowrap}
.release-row button:hover{border-color:#75dccc;color:#9af2df}
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
.required-tag,.optional-tag{display:inline-flex;align-items:center;margin-left:5px;padding:2px 6px;border:1px solid;border-radius:999px;font-size:8px;font-weight:800;line-height:1.35;vertical-align:1px}
.required-tag{border-color:rgba(236,142,147,.35);color:#f0afb5;background:rgba(130,47,58,.19)}
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
