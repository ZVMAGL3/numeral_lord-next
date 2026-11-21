import { isSystemManagedTerrainCapability, validateTerrainModDefinition, type TerrainModDefinition, type TerrainModDefinitionAssetReferences, type TerrainModSetting } from "@numeral-lord/content-schema";
import { computed, ref, watch } from "vue";
import type { TerrainModEntry, TerrainModSubmission } from "./types";
import { terrainModAuthoringJson } from "./terrain-mod-authoring";
import { getTerrainArtClipPoints, getTerrainArtPlacement, TERRAIN_ART_VIEWBOX_HEIGHT } from "../board/terrain-art-geometry.js";
import { compareModVersions } from "./workshop-terrain-catalog.js";

interface WorkshopTerrainEditorOptions {
  editingEntry: TerrainModEntry | null;
  terrainMods: readonly TerrainModEntry[];
  uploadTerrainAsset: (dataUrl: string) => Promise<string>;
  downloadTerrainAsset: (url: string) => Promise<string>;
}

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

export function useWorkshopTerrainEditor(
  props: WorkshopTerrainEditorOptions,
  publish: (entry: TerrainModSubmission) => void
) {
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
    terrainModAuthoringJson(publishTerrainName.value, publishTerrainDescription.value, asAssetReferenceDefinition(generatedTerrainDefinition.value)),
    null,
    2
  ));

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
      publish({ updateId: editingTerrainEntryId.value, name, description, definition: definitionReferences });
      return;
    }
    publishError.value = "";
    publish({ name, description, definition: definitionReferences });
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

  const publishError = ref("");

  const entry = props.editingEntry;
  if (entry?.definition && entry.modId) {
    editingTerrainEntryId.value = entry.id;
    publishTerrainName.value = entry.name;
    publishTerrainDescription.value = entry.description;
    publishModId.value = entry.modId;
    publishModVersion.value = nextPatchVersion(entry.version);
    hydrateTerrainDrafts(entry.definition, entry.visualAssetUrls);
  }

  return {
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
  };
}
