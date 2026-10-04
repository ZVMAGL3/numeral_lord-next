import type { TerrainModDefinition } from "./workshop.js";

const MAX_MOD_DEFINITION_BYTES = 768 * 1024;
const MAX_VISUAL_ASSETS = 8;
const MAX_VISUAL_ASSET_BYTES = 128 * 1024;
const SYSTEM_MANAGED_TERRAIN_CAPABILITIES = new Set(["core/adjacent-hostile-exhaustion"]);
const EXHAUSTION_CAPABILITIES = new Set(["core/exhaust-on-entry", "core/exhaust-on-departure"]);
const SUPPORTED_TERRAIN_CAPABILITIES = new Set([
  "core/occupiable", "core/power-conductor", "core/power-source", "core/income-source",
  "core/exhaust-on-entry", "core/exhaust-on-departure", "core/adjacent-hostile-exhaustion",
  "core/exhaust-unpowered-after-capture", "core/departure-garrison", "core/counterattack-terrain-limit",
  "core/terrain-movement"
]);

/** True for core rules that are not assignable as ordinary terrain capabilities in the workshop. */
export function isSystemManagedTerrainCapability(id: string): boolean {
  return SYSTEM_MANAGED_TERRAIN_CAPABILITIES.has(id);
}

/** One structural/security boundary shared by workshop publishing and client hydration. */
export function validateTerrainModDefinition(
  input: unknown,
  options: { readonly requireBaseLayer?: boolean } = {}
): TerrainModDefinition {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    "id", "version", "capabilities", "settings", "spatialPatterns", "rules", "terrain",
    "visualAssets"
  ])) {
    throw new Error("地块 Mod 必须提交仅包含受支持字段的结构化 definition 对象。");
  }
  const { id, version, capabilities, terrain, settings } = input;
  if (typeof id !== "string" || !/^mod-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) {
    throw new Error("Mod ID 应采用 mod-名称 格式。");
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || version.length > 40) {
    throw new Error("Mod 版本应采用 1.0.0 格式。");
  }
  const slug = id.slice(4);
  const modCapabilityPattern = new RegExp(`^mod/${slug}/[a-z0-9]+(?:[/-][a-z0-9]+)*$`);
  let serialized: string | undefined;
  try { serialized = JSON.stringify(input); } catch { /* invalid cyclic data */ }
  if (serialized === undefined || byteLength(serialized) > MAX_MOD_DEFINITION_BYTES) {
    throw new Error("Mod 属性对象必须是 JSON 数据，且不能超过 768 KiB。");
  }
  const visualAssetIds = validateVisualAssets(input.visualAssets);
  if (!Array.isArray(capabilities) || capabilities.length > 32) throw new Error("Mod 能力定义无效或过多。");
  const registeredCapabilities = new Set<string>();
  for (const capability of capabilities) {
    if (!isRecord(capability) || typeof capability.id !== "string"
      || (!SUPPORTED_TERRAIN_CAPABILITIES.has(capability.id) && !modCapabilityPattern.test(capability.id))
      || capability.target !== "terrain" || registeredCapabilities.has(capability.id)
      || !hasOnlyKeys(capability, ["id", "target", "defaultConfig"])
      || !isRecord(capability.defaultConfig) || !isJsonData(capability.defaultConfig)) {
      throw new Error("Mod 含有引擎不支持或格式不正确的地块能力。");
    }
    if (options.requireBaseLayer && SYSTEM_MANAGED_TERRAIN_CAPABILITIES.has(capability.id)) {
      throw new Error("据点压制由系统固定绑定在据点上，并自动作用于周围六格，不能作为普通 Mod 能力发布。");
    }
    registeredCapabilities.add(capability.id);
  }
  const allowedCapabilityIds = new Set([...SUPPORTED_TERRAIN_CAPABILITIES, ...registeredCapabilities]);
  if (!isRecord(terrain) || !Array.isArray(terrain.capabilities) || terrain.capabilities.length > 33
    || !hasOnlyKeys(terrain, ["capabilities", "visuals"])) {
    throw new Error("一个地块 Mod 必须包含且只包含一个有效 terrain 对象。");
  }
  if (options.requireBaseLayer && (!isRecord(terrain.visuals)
    || !(terrain.visuals.baseTransparent === true
      || (typeof terrain.visuals.baseColor === "string" && /^#[0-9a-fA-F]{6}$/.test(terrain.visuals.baseColor))
      || (typeof terrain.visuals.baseAssetId === "string" && visualAssetIds.has(terrain.visuals.baseAssetId))))) {
    throw new Error("地块必须设置纯色、有效图片或透明底作为底部外观。");
  }
  if (terrain.visuals !== undefined) validateTerrainVisuals(terrain.visuals, visualAssetIds);
  const bindings = new Set<string>();
  for (const binding of terrain.capabilities) {
    if (!isRecord(binding) || typeof binding.id !== "string"
        || !allowedCapabilityIds.has(binding.id) || bindings.has(binding.id)
        || !hasOnlyKeys(binding, ["id", "config"])
        || (binding.config !== undefined && (!isRecord(binding.config) || !isJsonData(binding.config)))) {
      throw new Error("地块绑定了引擎不支持或格式不正确的能力。");
    }
    if (options.requireBaseLayer && SYSTEM_MANAGED_TERRAIN_CAPABILITIES.has(binding.id)) {
        throw new Error("据点压制由系统固定绑定在据点上，并自动作用于周围六格，不能作为普通 Mod 能力发布。");
    }
    if (EXHAUSTION_CAPABILITIES.has(binding.id) && isRecord(binding.config)
        && binding.config.triggerMode !== undefined
        && binding.config.triggerMode !== "each-cell" && binding.config.triggerMode !== "terrain-transition") {
        throw new Error("进入/离开失活的触发范围只能选择‘每格触发’或‘跨入/跨出该地形时触发’。");
    }
    if (binding.id === "core/departure-garrison" && isRecord(binding.config)
        && binding.config.requires !== undefined
        && binding.config.requires !== "occupied" && binding.config.requires !== "powered-occupant") {
        throw new Error("离开留兵条件只能选择‘无条件’或‘离开单位通电’。");
    }
    if (binding.id === "core/terrain-movement" && binding.config !== undefined) {
      const config = binding.config;
      if (!hasOnlyKeys(config, ["enabled", "expression"])
        || (config.enabled !== undefined && typeof config.enabled !== "boolean")) {
        throw new Error("地块移动配置无效。");
      }
      if (config.expression !== undefined) validateSpatialExpression(config.expression, 0, allowedCapabilityIds);
    }
    if (binding.id === "core/income-source" && isRecord(binding.config) && binding.config.condition !== undefined) {
        // 收益表达式复用空间条件语言；只有收益结算能读取单位供电状态。
        validateSpatialPredicate(binding.config.condition, 0, allowedCapabilityIds, true);
    }
    bindings.add(binding.id);
  }
  if (settings !== undefined) {
    if (!Array.isArray(settings) || settings.length > 32) throw new Error("Mod 可配置属性无效。");
    const settingIds = new Set<string>();
    for (const setting of settings) {
      if (!isRecord(setting)) throw new Error("Mod 可配置属性无效。");
      const settingTarget = setting.target;
      if (typeof setting.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(setting.id)
        || settingIds.has(setting.id) || typeof setting.displayName !== "string" || !setting.displayName.trim()
        || byteLength(setting.displayName) > 120 || !isRecord(settingTarget)
        || !hasOnlyKeys(setting, ["id", "displayName", "description", "target", "kind", "defaultValue", "min", "max", "options"])
        || !hasOnlyKeys(settingTarget, ["capabilityId", "configKey"])
        || typeof settingTarget.capabilityId !== "string" || !allowedCapabilityIds.has(settingTarget.capabilityId)
        || typeof settingTarget.configKey !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(settingTarget.configKey)) {
        throw new Error("Mod 设置项必须指向本 Mod 地块上的有效能力配置。");
      }
      if (!terrain.capabilities.some((binding) => isRecord(binding) && binding.id === settingTarget.capabilityId)) {
        throw new Error("Mod 设置项引用的地块未绑定对应能力。");
      }
      if (setting.kind === "integer") {
        if (!Number.isInteger(setting.defaultValue) || !Number.isInteger(setting.min) || !Number.isInteger(setting.max)
          || (setting.min as number) > (setting.defaultValue as number) || (setting.defaultValue as number) > (setting.max as number)
          || (setting.max as number) - (setting.min as number) > 1_000_000) {
          throw new Error("整数设置项的默认值和范围无效。");
        }
      } else if (setting.kind === "boolean") {
        if (typeof setting.defaultValue !== "boolean") throw new Error("布尔设置项必须提供布尔默认值。");
      } else if (setting.kind === "choice") {
        if (typeof setting.defaultValue !== "string" || !Array.isArray(setting.options) || setting.options.length === 0
          || setting.options.length > 32 || !setting.options.every((option) => typeof option === "string")
          || !setting.options.includes(setting.defaultValue)) {
          throw new Error("选项设置项必须包含其默认值。");
        }
      } else {
        throw new Error("Mod 设置项类型只支持整数、布尔值或选项。");
      }
      if (!isJsonData(setting)) throw new Error("Mod 设置项包含不可用的数据。");
      settingIds.add(setting.id);
    }
  }
  const patterns = input.spatialPatterns;
  if (patterns !== undefined) {
    if (!Array.isArray(patterns) || patterns.length > 32) throw new Error("空间算法最多定义 32 个。");
    const patternIds = new Set<string>();
    for (const pattern of patterns) {
      if (!isRecord(pattern) || typeof pattern.id !== "string"
        || !new RegExp(`^${id}/[a-z0-9]+(?:[/-][a-z0-9]+)*$`).test(pattern.id)
        || !isRecord(pattern.result)
        || (pattern.result.entity !== "cell" && (pattern.result.entity !== "unit" || pattern.result.distinctBy !== "id"))
        || (pattern.role !== undefined && (pattern.role !== "core/powered-units" || pattern.result.entity !== "unit"))
        || patternIds.has(pattern.id) || !isJsonData(pattern)
        || !hasOnlyKeys(pattern, ["id", "starts", "expression", "result", "excludeStarts", "role"])
        || !hasOnlyKeys(pattern.result, ["entity", "distinctBy"])) {
        throw new Error("空间算法 ID、结果类型或结构无效；单位结果必须声明按 ID 去重。");
      }
      if (pattern.excludeStarts !== undefined
        && (typeof pattern.excludeStarts !== "boolean" || (pattern.excludeStarts && pattern.result.entity !== "cell"))) {
        throw new Error("空间区域的 excludeStarts 只能用于格子结果，并且必须是布尔值。");
      }
      validateSpatialPredicate(pattern.starts, 0, allowedCapabilityIds);
      validateSpatialExpression(pattern.expression, 0, allowedCapabilityIds);
      patternIds.add(pattern.id);
    }
  }
  const patternIds = new Set<string>(
    Array.isArray(patterns)
      ? patterns.flatMap((pattern) => isRecord(pattern) && typeof pattern.id === "string" ? [pattern.id] : [])
      : []
  );
  if (input.rules !== undefined) {
    const rules = input.rules;
    if (!Array.isArray(rules) || rules.length > 64) throw new Error("Mod 规则最多定义 64 条。");
    const ruleIds = new Set<string>();
    for (const rule of rules) {
      if (!isRecord(rule) || typeof rule.id !== "string"
        || !new RegExp(`^${id}/[a-z0-9]+(?:[/-][a-z0-9]+)*$`).test(rule.id)
        || ruleIds.has(rule.id)
        || !["state-changed", "unit-enter", "unit-leave", "unit-destroyed", "turn-start"].includes(String(rule.trigger))
        || !isRecord(rule.target)
        || (rule.target.scope !== "trigger-unit" && rule.target.scope !== "pattern-units")
        || (rule.target.scope === "pattern-units" && (typeof rule.target.patternId !== "string" || !patternIds.has(rule.target.patternId)))
        || (rule.target.scope === "pattern-units" && rule.target.owner !== undefined && rule.target.owner !== "actor")
        || (rule.target.scope === "pattern-units" && rule.target.powered !== undefined && rule.target.powered !== true)
        || (rule.conditions !== undefined && (!Array.isArray(rule.conditions) || rule.conditions.length > 16))
        || !Array.isArray(rule.effects) || rule.effects.length === 0 || rule.effects.length > 32
        || !isJsonData(rule) || !hasOnlyKeys(rule, ["id", "trigger", "target", "conditions", "effects"])) {
        throw new Error("Mod 规则 ID、触发器、目标或结构无效。");
      }
      if (rule.target.scope === "pattern-units" && typeof rule.target.patternId === "string"
        && !isUnitPattern(rule.target.patternId, patterns)) {
        throw new Error("Mod 规则的单位目标必须引用单位结果空间算法。");
      }
      if (rule.target.scope === "pattern-units") {
        if (!hasOnlyKeys(rule.target, ["scope", "patternId", "owner", "powered"])) throw new Error("Mod 规则目标包含不支持的字段。");
      } else if (!hasOnlyKeys(rule.target, ["scope"])) throw new Error("Mod 规则目标包含不支持的字段。");
      for (const condition of rule.conditions ?? []) {
        if (!isRecord(condition) || typeof condition.op !== "string") throw new Error("Mod 规则条件格式无效。");
        if (condition.op === "at-cell-matches") {
          if (!hasOnlyKeys(condition, ["op", "predicate"])) throw new Error("Mod 规则条件包含不支持的字段。");
          validateSpatialPredicate(condition.predicate, 0, allowedCapabilityIds);
        }
        else if (condition.op === "cell-in-pattern") {
          if (!hasOnlyKeys(condition, ["op", "patternId"]) || typeof condition.patternId !== "string"
            || !isCellPattern(condition.patternId, patterns)) throw new Error("区域条件必须引用格子结果空间算法。");
        }
        else if (condition.op === "crosses-pattern-boundary") {
          if (!hasOnlyKeys(condition, ["op", "patternId", "direction"]) || typeof condition.patternId !== "string"
            || (condition.direction !== "enter" && condition.direction !== "leave")
            || !isCellPattern(condition.patternId, patterns)) throw new Error("区域边界条件必须引用格子结果空间算法并指定进入或离开。");
        }
        else if (condition.op === "pattern-includes-trigger-unit") {
          if (!hasOnlyKeys(condition, ["op", "patternId"])) throw new Error("Mod 规则条件包含不支持的字段。");
          if (typeof condition.patternId !== "string" || !isUnitPattern(condition.patternId, patterns)) {
            throw new Error("Mod 规则条件必须引用单位结果空间算法。");
          }
        } else if (condition.op === "mod-setting-equals") {
          if (!hasOnlyKeys(condition, ["op", "settingId", "value"]) || typeof condition.settingId !== "string") {
            throw new Error("Mod 规则条件包含不支持的字段。");
          }
          const setting = Array.isArray(settings) ? settings.find((candidate) => isRecord(candidate) && candidate.id === condition.settingId) : undefined;
          if (!isRecord(setting) || !settingAcceptsValue(setting, condition.value)) {
            throw new Error("Mod 规则比较的参数不存在，或默认值类型/选项不匹配。");
          }
        } else throw new Error("Mod 规则含有不支持的条件操作。");
      }
      for (const effect of rule.effects) {
        if (!isRecord(effect) || typeof effect.type !== "string") throw new Error("Mod 规则效果格式无效。");
        switch (effect.type) {
          case "change-strength":
            if (!Number.isInteger(effect.amount) || Math.abs(effect.amount as number) > 100
              || !hasOnlyKeys(effect, ["type", "amount"])) throw new Error("兵力变化必须是 -100 到 100 的整数。");
            break;
          case "grant-points":
            if (!Number.isInteger(effect.amount) || (effect.amount as number) < 0 || (effect.amount as number) > 100
              || !hasOnlyKeys(effect, ["type", "amount"])) throw new Error("点数奖励必须是 0 到 100 的整数。");
            break;
          case "change-strength-from-setting":
          case "grant-points-from-setting": {
            if (!hasOnlyKeys(effect, ["type", "settingId"]) || typeof effect.settingId !== "string") {
              throw new Error("Mod 规则效果包含不支持的字段。");
            }
            const setting = Array.isArray(settings) ? settings.find((candidate) => isRecord(candidate) && candidate.id === effect.settingId) : undefined;
            if (!isRecord(setting) || setting.kind !== "integer") {
              throw new Error("Mod 规则效果必须引用本 Mod 的整数设置。");
            }
            if (effect.type === "grant-points-from-setting" && ((setting.min as number) < 0 || (setting.max as number) > 100)) {
              throw new Error("点数奖励设置的范围必须在 0 到 100 之间。");
            }
            if (effect.type === "change-strength-from-setting" && ((setting.min as number) < -100 || (setting.max as number) > 100)) {
              throw new Error("兵力变化设置的范围必须在 -100 到 100 之间。");
            }
            break;
          }
          case "exhaust-unit":
            if (!hasOnlyKeys(effect, ["type"])) throw new Error("Mod 规则效果包含不支持的字段。");
            break;
          case "set-unit-marker":
          case "remove-unit-marker":
            if (!hasOnlyKeys(effect, ["type", "marker"])) throw new Error("Mod 规则效果包含不支持的字段。");
            validateMarker(effect.marker);
            break;
          case "sync-unit-marker":
            if (!hasOnlyKeys(effect, ["type", "marker", "patternId"])) throw new Error("Mod 规则效果包含不支持的字段。");
            validateMarker(effect.marker);
            if (typeof effect.patternId !== "string" || !isUnitPattern(effect.patternId, patterns)) {
              throw new Error("标记同步效果必须引用单位结果空间算法。");
            }
            break;
          default:
            throw new Error("Mod 规则包含不支持的效果。");
        }
      }
      ruleIds.add(rule.id);
    }
  }
  return input as unknown as TerrainModDefinition;
}

function settingAcceptsValue(setting: Record<string, unknown>, value: unknown): boolean {
  if (setting.kind === "integer") return typeof value === "number" && Number.isInteger(value)
    && typeof setting.min === "number" && value >= setting.min
    && typeof setting.max === "number" && value <= setting.max;
  if (setting.kind === "boolean") return typeof value === "boolean";
  if (setting.kind === "choice") return typeof value === "string" && Array.isArray(setting.options) && setting.options.includes(value);
  return false;
}

function validateVisualAssets(value: unknown): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > MAX_VISUAL_ASSETS) throw new Error("地块美术最多包含 8 张 PNG/WebP 图片。");
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const asset of value) {
    if (!isRecord(asset) || !hasOnlyKeys(asset, ["id", "dataUrl"])
      || typeof asset.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(asset.id)
      || ids.has(asset.id) || typeof asset.dataUrl !== "string") {
      throw new Error("地块图片资源格式无效或 ID 重复。");
    }
    const bytes = decodeTerrainImage(asset.dataUrl);
    const isSvg = asset.dataUrl.startsWith("data:image/svg+xml;base64,");
    if (bytes.byteLength > MAX_VISUAL_ASSET_BYTES || (!isSvg && !validImageDimensions(bytes))) {
      throw new Error("地块图片必须是小于 128 KiB、尺寸为 16–1024 像素的 PNG、WebP 或安全 SVG。");
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > 4 * MAX_VISUAL_ASSET_BYTES) throw new Error("地块图片资源总大小超过限制。");
    ids.add(asset.id);
  }
  return ids;
}

function validateTerrainVisuals(input: unknown, assetIds: ReadonlySet<string>): void {
  if (!isRecord(input) || !hasOnlyKeys(input, ["baseColor", "baseAssetId", "baseOpacity", "baseTransparent", "overlay"])
    || (input.baseColor !== undefined && (typeof input.baseColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input.baseColor)))
    || (input.baseAssetId !== undefined && (typeof input.baseAssetId !== "string" || !assetIds.has(input.baseAssetId)))
    || (input.baseOpacity !== undefined && (typeof input.baseOpacity !== "number" || input.baseOpacity < 0 || input.baseOpacity > 1))
    || (input.baseTransparent !== undefined && typeof input.baseTransparent !== "boolean")
    || (input.baseTransparent === true && input.baseAssetId !== undefined)
    || (input.baseColor === undefined && input.baseAssetId === undefined && input.baseTransparent !== true)) {
    throw new Error("地块底图颜色或图片引用无效。");
  }
  const overlay = input.overlay;
  if (overlay !== undefined && (!isRecord(overlay)
    || !hasOnlyKeys(overlay, ["assetId", "scale", "opacity", "offsetX", "offsetY", "whenOccupied"])
    || typeof overlay.assetId !== "string" || !assetIds.has(overlay.assetId)
    || typeof overlay.scale !== "number" || overlay.scale < 0.2 || overlay.scale > 1.5
    || typeof overlay.opacity !== "number" || overlay.opacity < 0.1 || overlay.opacity > 1
    || typeof overlay.offsetX !== "number" || overlay.offsetX < -0.45 || overlay.offsetX > 0.45
    || typeof overlay.offsetY !== "number" || overlay.offsetY < -0.45 || overlay.offsetY > 0.45
    || overlay.whenOccupied !== undefined && typeof overlay.whenOccupied !== "boolean")) {
    throw new Error("地块顶部图层的图片、大小、透明度、位置或占领条件无效。");
  }
}

function decodeTerrainImage(dataUrl: string): Uint8Array {
  const match = /^data:image\/(png|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2]!.length > Math.ceil(MAX_VISUAL_ASSET_BYTES * 4 / 3) + 4) {
    throw new Error("地块图片必须使用 PNG、WebP 或 SVG 格式。");
  }
  let binary: string;
  try { binary = atob(match[2]!); } catch { throw new Error("地块图片编码无效。"); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const png = match[1] === "png";
  const webp = match[1] === "webp";
  const svg = match[1] === "svg+xml";
  if (png) {
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
      || bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a
      || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
      throw new Error("PNG 图片文件头无效。");
    }
  } else if (webp) {
    if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
      throw new Error("WebP 图片文件头无效。");
    }
  } else if (svg) {
    const source = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[a-z][\w.-]*:)?svg\b[\s\S]*<\/(?:[a-z][\w.-]*:)?svg>\s*$/i.test(source)
      || /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|animate|set)\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*(["'])(?!#)|javascript:|@import|url\(\s*(['"]?)(?!#)/i.test(source)) {
      throw new Error("SVG 必须是无脚本、无外部资源的静态图案。");
    }
  }
  return bytes;
}

function validImageDimensions(bytes: Uint8Array): boolean {
  if (ascii(bytes, 12, 4) !== "VP8X" && ascii(bytes, 12, 4) !== "VP8 " && ascii(bytes, 12, 4) !== "VP8L") {
    const width = readBigEndian32(bytes, 16);
    const height = readBigEndian32(bytes, 20);
    return width >= 16 && height >= 16 && width <= 1024 && height <= 1024;
  }
  const chunk = ascii(bytes, 12, 4);
  let width: number;
  let height: number;
  if (chunk === "VP8X") {
    width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
  } else if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f || bytes.length < 25) return false;
    width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    height = 1 + ((bytes[22]! >> 6) & 0x03) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
  } else {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return false;
    width = ((bytes[26]! | (bytes[27]! << 8)) & 0x3fff);
    height = ((bytes[28]! | (bytes[29]! << 8)) & 0x3fff);
  }
  return width >= 16 && height >= 16 && width <= 1024 && height <= 1024;
}

function readBigEndian32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, count: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + count));
}

function validateSpatialPredicate(
  input: unknown,
  depth: number,
  allowedCapabilityIds: ReadonlySet<string>,
  allowPoweredUnit = false
): void {
  if (depth > 12 || !isRecord(input) || typeof input.op !== "string") throw new Error("空间算法条件格式无效或嵌套过深。");
  switch (input.op) {
    case "cell-exists":
      if (!hasOnlyKeys(input, ["op"])) throw new Error("任意棋盘格条件包含不支持的字段。");
      return;
    case "terrain-has":
      if (typeof input.capabilityId !== "string" || !allowedCapabilityIds.has(input.capabilityId)
        || !hasOnlyKeys(input, ["op", "capabilityId"])) throw new Error("空间算法引用了 Mod 未声明的地块能力。");
      return;
    case "terrain-is":
      if (typeof input.terrainId !== "string"
        || !/^[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/.test(input.terrainId)
        || !hasOnlyKeys(input, ["op", "terrainId"])) {
        throw new Error("空间算法引用的地块 ID 无效。");
      }
      return;
    case "unit-owner-is":
      if ((input.owner !== "actor" && input.owner !== "other") || !hasOnlyKeys(input, ["op", "owner"])) throw new Error("空间算法所属方条件无效。");
      return;
    case "unit-team-is":
      if ((input.team !== "actor" && input.team !== "other") || !hasOnlyKeys(input, ["op", "team"])) throw new Error("空间算法队伍条件无效。");
      return;
    case "unit-has-marker":
      if (!hasOnlyKeys(input, ["op", "marker"])) throw new Error("空间算法标记条件无效。");
      validateMarker(input.marker);
      return;
    case "unit-is-powered":
      if (!allowPoweredUnit) throw new Error("单位供电条件只能用于地块收益前置条件。");
      if (!hasOnlyKeys(input, ["op"])) throw new Error("单位供电条件格式无效。");
      return;
    case "all":
    case "any":
      if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 16
        || !hasOnlyKeys(input, ["op", "items"])) throw new Error("空间算法条件组不能为空或过多。");
      for (const item of input.items) validateSpatialPredicate(item, depth + 1, allowedCapabilityIds, allowPoweredUnit);
      return;
    case "not":
      if (!hasOnlyKeys(input, ["op", "item"])) throw new Error("空间算法否定条件无效。");
      validateSpatialPredicate(input.item, depth + 1, allowedCapabilityIds, allowPoweredUnit);
      return;
    default:
      throw new Error("空间算法包含不支持的条件操作。");
  }
}

function validateMarker(value: unknown): void {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9/_-]{0,79}$/.test(value)) {
    throw new Error("单位标记必须是小写字母、数字、斜线、短横线或下划线组成的 ID。");
  }
}

function isUnitPattern(patternId: string, patterns: unknown): boolean {
  return Array.isArray(patterns) && patterns.some((pattern) => isRecord(pattern)
    && pattern.id === patternId && isRecord(pattern.result) && pattern.result.entity === "unit" && pattern.result.distinctBy === "id");
}

function isCellPattern(patternId: string, patterns: unknown): boolean {
  return Array.isArray(patterns) && patterns.some((pattern) => isRecord(pattern)
    && pattern.id === patternId && isRecord(pattern.result) && pattern.result.entity === "cell");
}

function validateSpatialExpression(input: unknown, depth: number, allowedCapabilityIds: ReadonlySet<string>): void {
  if (depth > 12 || !isRecord(input) || typeof input.op !== "string") throw new Error("空间算法表达式格式无效或嵌套过深。");
  switch (input.op) {
    case "step":
      if (input.relation !== "hex-neighbor" || !hasOnlyKeys(input, ["op", "relation", "where"])) throw new Error("当前空间算法只支持六边形相邻关系。");
      validateSpatialPredicate(input.where, 0, allowedCapabilityIds);
      return;
    case "hex-offsets": {
      if (!Array.isArray(input.offsets) || input.offsets.length === 0 || input.offsets.length > 256
        || !hasOnlyKeys(input, ["op", "offsets", "where"])) throw new Error("六边格相对坐标列表无效或过多。");
      const seenOffsets = new Set<string>();
      for (const offset of input.offsets) {
        if (!Array.isArray(offset) || offset.length !== 2
          || !Number.isInteger(offset[0]) || !Number.isInteger(offset[1])
          || Math.abs(offset[0] as number) > 4096 || Math.abs(offset[1] as number) > 4096
          || (offset[0] === 0 && offset[1] === 0)) {
          throw new Error("六边格相对坐标必须是非零的 [Δq, Δr] 整数组。");
        }
        const key = `${offset[0]},${offset[1]}`;
        if (seenOffsets.has(key)) throw new Error("六边格相对坐标不能重复。");
        seenOffsets.add(key);
      }
      if (input.where !== undefined) validateSpatialPredicate(input.where, 0, allowedCapabilityIds);
      return;
    }
    case "hex-range":
      if (!Number.isInteger(input.min) || !Number.isInteger(input.max) || (input.min as number) < 0
        || (input.max as number) < (input.min as number) || (input.max as number) > 4096
        || !hasOnlyKeys(input, ["op", "min", "max", "where"])) {
        throw new Error("空间算法六边形距离范围无效。");
      }
      validateSpatialPredicate(input.where, 0, allowedCapabilityIds);
      return;
    case "sequence":
    case "either":
      if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 16
        || !hasOnlyKeys(input, ["op", "items"])) throw new Error("空间算法组合不能为空或过多。");
      for (const item of input.items) validateSpatialExpression(item, depth + 1, allowedCapabilityIds);
      return;
    case "repeat":
      if (!Number.isInteger(input.min) || !Number.isInteger(input.max) || (input.min as number) < 0
        || (input.max as number) < (input.min as number) || (input.max as number) > 4096
        || !hasOnlyKeys(input, ["op", "item", "min", "max"])) {
        throw new Error("空间算法重复次数范围无效。");
      }
      validateSpatialExpression(input.item, depth + 1, allowedCapabilityIds);
      return;
    default:
      throw new Error("空间算法包含不支持的路径操作。");
  }
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

function isJsonData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => isJsonData(item, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 256 && entries.every(([key, item]) => key !== "__proto__" && isJsonData(item, depth + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
