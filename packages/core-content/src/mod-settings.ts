import type { ModDefinition, ModSettingDefinition, ModSettings, ModSettingValue } from "@numeral-lord/game-sdk";

export type ModCatalog = Readonly<Record<string, ModDefinition>>;
export type TerrainCapabilityOverrides = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>>;

/** Validate data in a map code or a room request; unknown Mods are preview-only. */
export function validateModSettings(
  input: unknown,
  requiredModIds: readonly string[],
  mods: ModCatalog | undefined,
  allowUnknownMods: boolean
): ModSettings | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || Object.keys(input).length > 16) throw new Error("Mod 配置必须是对象，且最多包含 16 个 Mod。");
  const values: Record<string, Record<string, ModSettingValue>> = Object.create(null);
  for (const [modId, rawSettings] of Object.entries(input)) {
    if (!requiredModIds.includes(modId) || !isRecord(rawSettings) || Object.keys(rawSettings).length > 32) {
      throw new Error(`Mod 配置无效：${modId}`);
    }
    const mod = mods?.[modId];
    if (!mod && !allowUnknownMods) throw new Error(`尚未安装地块 Mod：${modId}`);
    const settings: Record<string, ModSettingValue> = Object.create(null);
    for (const [settingId, value] of Object.entries(rawSettings)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(settingId)) throw new Error(`Mod 参数名称无效：${settingId}`);
      const definition = mod?.settings?.find((candidate) => candidate.id === settingId);
      if (mod && !definition) throw new Error(`Mod ${modId} 没有参数：${settingId}`);
      if (definition) validateSettingValue(definition, value);
      else if (!allowUnknownMods || !isSafeUnknownValue(value)) throw new Error(`Mod 参数值无效：${modId}/${settingId}`);
      settings[settingId] = value as ModSettingValue;
    }
    values[modId] = settings;
  }
  return values;
}

/** Map values are defaults. A room host may override only declared fields. */
export function resolveModSettings(
  requiredModIds: readonly string[],
  mapValues: ModSettings | undefined,
  roomValues: ModSettings | undefined,
  mods: ModCatalog | undefined
): { values: ModSettings; terrainCapabilityOverrides: TerrainCapabilityOverrides } {
  const validRoom = validateModSettings(roomValues, requiredModIds, mods, false);
  const values: Record<string, Record<string, ModSettingValue>> = Object.create(null);
  const overrides: Record<string, Record<string, Record<string, unknown>>> = Object.create(null);
  for (const modId of requiredModIds) {
    const mod = mods?.[modId];
    if (!mod) continue;
    if (!mod.settings?.length) continue;
    const resolved: Record<string, ModSettingValue> = Object.create(null);
    for (const setting of mod.settings) {
      const value = validRoom?.[modId]?.[setting.id] ?? mapValues?.[modId]?.[setting.id] ?? setting.defaultValue;
      validateSettingValue(setting, value);
      resolved[setting.id] = value;
      const terrain = mod.terrains.find((candidate) => candidate.id === setting.target.terrainId);
      if (!terrain?.capabilities.some((capability) => capability.id === setting.target.capabilityId)) {
        throw new Error(`Mod 参数 ${modId}/${setting.id} 没有对应地形能力。`);
      }
      const byCapability = overrides[setting.target.terrainId] ??= Object.create(null);
      const config = byCapability[setting.target.capabilityId] ??= Object.create(null);
      config[setting.target.configKey] = value;
    }
    values[modId] = resolved;
  }
  return { values, terrainCapabilityOverrides: overrides };
}

export function validateSettingValue(definition: ModSettingDefinition, value: unknown): void {
  switch (definition.kind) {
    case "integer":
      if (!Number.isInteger(value) || (value as number) < definition.min || (value as number) > definition.max) {
        throw new Error(`${definition.displayName} 必须是 ${definition.min}～${definition.max} 的整数。`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${definition.displayName} 必须是布尔值。`);
      break;
    case "choice":
      if (typeof value !== "string" || !definition.options.includes(value)) {
        throw new Error(`${definition.displayName} 不在允许的选项中。`);
      }
      break;
  }
}

function isSafeUnknownValue(value: unknown): value is ModSettingValue {
  return typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000)
    || (typeof value === "string" && value.length <= 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
