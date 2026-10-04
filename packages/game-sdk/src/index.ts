import type { GameCommand, GameState, MatchConditionModule, PlayerId } from "@numeral-lord/game-core";
import type { SpatialPatternDefinition } from "@numeral-lord/game-core";
import type { ModRuleDefinition } from "@numeral-lord/game-core";

export { hashModContent } from "./content-hash.js";

export type CapabilityTarget = "terrain" | "unit" | "match";

export interface CapabilityDefinition<Config = unknown> {
  /** 能力的全局稳定标识，例如 `core/power-conductor`。 */
  readonly id: string;
  /** 此能力可附加到地形、单位，或整局对局规则。 */
  readonly target: CapabilityTarget;
  /** 作者未写配置时，引擎应使用的默认配置。 */
  readonly defaultConfig: Config;
}

/** A terrain or unit opts into a capability by adding one of these bindings. */
export interface CapabilityBinding {
  /** 已注册能力的 id；必须与某个 CapabilityDefinition.id 对应。 */
  readonly id: string;
  /** 此地形/单位对该能力的专属配置；省略时使用能力的默认配置。 */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Serializable options a map author may set and a room host may override. */
export type ModSettingValue = number | boolean | string;

interface ModSettingBase {
  /** Stable key within the Mod package, e.g. `incomePerTurn`. */
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  /** The public capability field this option configures at runtime. */
  readonly target: {
    readonly capabilityId: string;
    readonly configKey: string;
  };
}

export type ModSettingDefinition = ModSettingBase & (
  | { readonly kind: "integer"; readonly defaultValue: number; readonly min: number; readonly max: number }
  | { readonly kind: "boolean"; readonly defaultValue: boolean }
  | { readonly kind: "choice"; readonly defaultValue: string; readonly options: readonly string[] }
);

export type ModSettings = Readonly<Record<string, Readonly<Record<string, ModSettingValue>>>>;

export interface TerrainDefinition {
  /** 地形的稳定 id，地图保存时记录它，不使用可翻译的显示名称。 */
  readonly id: string;
  /** 编辑器和游戏界面显示的名称。 */
  readonly displayName: string;
  /** 此地形从公共能力池中选中的能力；空数组表示没有游戏能力。 */
  readonly capabilities: readonly CapabilityBinding[];
  /** Optional data-only art; it cannot affect simulation rules. */
  readonly visuals?: TerrainVisualDefinition;
}

/** A small, immutable image asset embedded in a versioned terrain Mod release. */
export interface TerrainVisualAsset {
  readonly id: string;
  /** Validated PNG, WebP, or SVG data URL; assets are part of the release content hash. */
  readonly dataUrl: string;
}

/** Load a packaged SVG file into the data URL used by the shared Mod definition. */
export async function loadTerrainSvgAsset(url: URL): Promise<string> {
  let bytes: Uint8Array;
  if (url.protocol === "file:") {
    const nodeProcess = (globalThis as typeof globalThis & {
      process?: { getBuiltinModule?: (specifier: string) => unknown };
    }).process;
    const fileSystem = nodeProcess?.getBuiltinModule?.("node:fs/promises") as {
      readFile(path: URL): Promise<Uint8Array>;
    } | undefined;
    if (!fileSystem) throw new Error("Cannot load a packaged SVG file in this runtime.");
    bytes = await fileSystem.readFile(url);
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load packaged SVG asset: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export interface TerrainVisualLayer {
  readonly assetId: string;
  readonly scale: number;
  readonly opacity: number;
  /** Normalized offsets relative to the tile radius. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Only show this overlay while a unit occupies the terrain cell. */
  readonly whenOccupied?: boolean;
}

export interface TerrainVisualDefinition {
  readonly baseColor?: string;
  readonly baseAssetId?: string;
  /** Opacity of the base color or image, from fully transparent to opaque. */
  readonly baseOpacity?: number;
  /** Leave the base layer transparent; the optional top layer may still be drawn. */
  readonly baseTransparent?: boolean;
  readonly overlay?: TerrainVisualLayer;
}

export interface UnitDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly CapabilityBinding[];
}

export interface RuleEvent {
  /** 事件的稳定类型，例如 `unit-exhausted`；客户端据此播放表现。 */
  readonly type: string;
  /** 事件的数据。客户端不能自行伪造，必须由规则内核或 Mod 返回。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DeterministicRandom {
  nextInt(upperExclusive: number): number;
}

export interface RuleContext {
  readonly state: GameState;
  readonly actorId: PlayerId;
  readonly random: DeterministicRandom;
}

export interface CommandRule {
  readonly commandType: GameCommand["type"] | string;
  resolve(context: RuleContext, command: GameCommand): readonly RuleEvent[];
}

/** Mod victory rules use the same executable interface as the shared engine. */
export type VictoryCondition = MatchConditionModule;

export interface TeamVictory {
  readonly teamId: string;
  readonly reason: string;
}

export interface ModDefinition {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly CapabilityDefinition[];
  /** Optional, schema-validated map/room options; never arbitrary executable code. */
  readonly settings?: readonly ModSettingDefinition[];
  /** Data-only regular path queries over the board graph. */
  readonly spatialPatterns?: readonly SpatialPatternDefinition[];
  /** Serializable event rules interpreted by game-core. */
  readonly rules?: readonly ModRuleDefinition[];
  /** Immutable, validated raster assets referenced by terrain visual definitions. */
  readonly visualAssets?: readonly TerrainVisualAsset[];
  /** A terrain Mod has one terrain; unit and rules Mods may omit it. */
  readonly terrain?: TerrainDefinition;
  readonly units: readonly UnitDefinition[];
  readonly commandRules: readonly CommandRule[];
  readonly victoryConditions: readonly VictoryCondition[];
}

/** Authoring shape for an ordinary Mod, which owns at most one terrain. */
export interface TerrainModAuthoringDefinition extends Omit<ModDefinition, "terrain" | "settings"> {
  readonly name: string;
  readonly settings?: readonly ModSettingDefinition[];
  readonly terrain: Omit<TerrainDefinition, "id" | "displayName">;
}

export interface TerrainModRuntimeDefinition extends ModDefinition {
  readonly terrain: TerrainDefinition;
}

/** Canonical simulation/art fields shared by map locks, workshop releases, and clients. */
export type ModContentIdentitySource = Pick<ModDefinition,
  "id" | "version" | "capabilities" | "settings" | "spatialPatterns" | "rules" | "visualAssets" | "terrain">;

export function modContentIdentity(mod: ModContentIdentitySource): unknown {
  const terrain = mod.terrain;
  const terrainContent = terrain ? {
    capabilities: terrain.capabilities,
    ...(terrain.visuals ? { visuals: terrain.visuals } : {})
  } : undefined;
  return {
    id: mod.id,
    version: mod.version,
    capabilities: mod.capabilities,
    ...(mod.settings ? { settings: mod.settings } : {}),
    ...(mod.spatialPatterns ? { spatialPatterns: mod.spatialPatterns } : {}),
    ...(mod.rules ? { rules: mod.rules } : {}),
    ...(mod.visualAssets ? { visualAssets: mod.visualAssets } : {}),
    ...(terrainContent ? { terrain: terrainContent } : {})
  };
}

export function defineMod(definition: ModDefinition): ModDefinition {
  return definition;
}

/**
 * Build a one-terrain Mod from its single source of truth. Runtime terrain IDs
 * are derived from the Mod ID, and the terrain display name follows the Mod name.
 */
export function defineTerrainMod(definition: TerrainModAuthoringDefinition): TerrainModRuntimeDefinition {
  const match = /^mod-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(definition.id);
  if (!match) throw new Error("Terrain Mod ID must use the mod-name format.");
  if (!definition.name.trim()) throw new Error("Terrain Mod name is required.");
  const { name, terrain, settings, ...mod } = definition;
  const terrainId = `mod/${match[1]}`;
  return {
    ...mod,
    ...(settings ? { settings } : {}),
    terrain: { ...terrain, id: terrainId, displayName: name }
  };
}
