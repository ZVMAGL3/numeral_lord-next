import type { GameState, PlayerId, TeamId } from "./state.js";

/**
 * The core only knows stable capability ids and configuration data. Concrete
 * terrain packages live outside the engine, so new terrain does not require a
 * new class or a change to GameState.
 */
export interface TerrainCapability {
  readonly id: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Capability bindings are shared by terrain and unit definitions. */
export interface UnitCapability {
  readonly id: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface TerrainSpec {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly TerrainCapability[];
}

export type TerrainCatalog = Readonly<Record<string, TerrainSpec>>;

/**
 * A unit's mechanics are composed from independent capability bindings.
 * `UnitState.definitionId` resolves into this catalog and never encodes rules
 * through a class hierarchy.
 */
export interface UnitSpec {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly UnitCapability[];
}

export type UnitCatalog = Readonly<Record<string, UnitSpec>>;

/**
 * A map selects condition modules by id in `MatchSettings.matchConditionIds`.
 * Modules only inspect immutable state and return declarative effects; the
 * engine owns every mutation so the same rules work in browsers, servers and
 * headless training runs.
 */
export interface MatchConditionResult {
  /** Remove every remaining unit of these players before later conditions run. */
  readonly eliminatePlayerIds?: readonly PlayerId[];
  /** Finish the match, optionally naming one or more winning teams. */
  readonly finish?: {
    readonly winningTeamIds: readonly TeamId[];
    readonly message?: string;
  };
}

export interface MatchConditionModule {
  readonly id: string;
  readonly displayName: string;
  readonly evaluate: (state: GameState, terrains: TerrainCatalog) => MatchConditionResult | undefined;
}

export type MatchConditionCatalog = Readonly<Record<string, MatchConditionModule>>;

export function hasTerrainCapability(
  terrain: TerrainSpec,
  capabilityId: string
): boolean {
  return terrain.capabilities.some((capability) => capability.id === capabilityId);
}

export function getTerrainCapability(
  terrain: TerrainSpec,
  capabilityId: string
): TerrainCapability | undefined {
  return terrain.capabilities.find((capability) => capability.id === capabilityId);
}

/** A match may pin Mod-authored capability values without changing global content. */
export function getMatchTerrainCapability(
  state: GameState,
  terrain: TerrainSpec,
  capabilityId: string
): TerrainCapability | undefined {
  const binding = getTerrainCapability(terrain, capabilityId);
  if (!binding) return undefined;
  const override = state.settings.terrainCapabilityOverrides?.[terrain.id]?.[capabilityId];
  if (!override) return binding;
  return { ...binding, config: { ...binding.config, ...override } };
}

export function hasUnitCapability(unit: UnitSpec, capabilityId: string): boolean {
  return unit.capabilities.some((capability) => capability.id === capabilityId);
}

export function getUnitCapability(
  unit: UnitSpec,
  capabilityId: string
): UnitCapability | undefined {
  return unit.capabilities.find((capability) => capability.id === capabilityId);
}
