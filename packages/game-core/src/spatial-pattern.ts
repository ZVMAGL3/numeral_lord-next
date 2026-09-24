import { getTerrainCapability, type TerrainCatalog } from "./content.js";
import { getHexNeighbours, toCellId } from "./hex.js";
import type { CellId, GameState, PlayerId, UnitId } from "./state.js";

/** JSON-safe vocabulary for author-defined spatial patterns (regular paths on the hex graph). */
export type SpatialPredicate =
  | { readonly op: "terrain-has"; readonly capabilityId: string }
  | { readonly op: "unit-owner-is"; readonly owner: "actor" | "other" }
  | { readonly op: "unit-has-marker"; readonly marker: string }
  | { readonly op: "all"; readonly items: readonly SpatialPredicate[] }
  | { readonly op: "any"; readonly items: readonly SpatialPredicate[] }
  | { readonly op: "not"; readonly item: SpatialPredicate };

export type SpatialExpression =
  | { readonly op: "step"; readonly relation: "hex-neighbor"; readonly where: SpatialPredicate }
  | { readonly op: "sequence"; readonly items: readonly SpatialExpression[] }
  | { readonly op: "either"; readonly items: readonly SpatialExpression[] }
  | { readonly op: "repeat"; readonly item: SpatialExpression; readonly min: number; readonly max: number };

export interface SpatialPatternDefinition {
  readonly id: string;
  /** Candidate start cells are tested with `starts`; the pattern returns reachable endpoints. */
  readonly starts: SpatialPredicate;
  readonly expression: SpatialExpression;
  readonly result: { readonly entity: "cell" } | { readonly entity: "unit"; readonly distinctBy: "id" };
  /** When present, this pattern provides the board's derived powered-unit set. */
  readonly role?: "core/powered-units";
}

const MAX_PATTERN_STEPS = 4096;

/**
 * Interpret a bounded regular-path pattern over the board's hex-neighbor graph.
 * This returns a derived set only; it never mutates GameState.
 */
export function selectSpatialPatternCells(
  state: GameState,
  terrains: TerrainCatalog,
  pattern: SpatialPatternDefinition,
  actorOwnerId: PlayerId
): ReadonlySet<CellId> {
  if (pattern.result.entity !== "cell") throw new Error("Spatial pattern result is not a cell selection.");
  return matchSpatialPatternCells(state, terrains, pattern, actorOwnerId);
}

/** Resolve matched cells to units and deduplicate by stable unit ID. */
export function selectSpatialPatternUnits(
  state: GameState,
  terrains: TerrainCatalog,
  pattern: SpatialPatternDefinition,
  actorOwnerId: PlayerId
): ReadonlySet<UnitId> {
  if (pattern.result.entity !== "unit" || pattern.result.distinctBy !== "id") {
    throw new Error("Spatial unit selections must declare distinctBy: id.");
  }
  const units = new Set<UnitId>();
  for (const cellId of matchSpatialPatternCells(state, terrains, pattern, actorOwnerId)) {
    const unitId = state.cells[cellId]?.unitId;
    if (unitId && state.units[unitId]) units.add(unitId);
  }
  return units;
}

function matchSpatialPatternCells(
  state: GameState,
  terrains: TerrainCatalog,
  pattern: SpatialPatternDefinition,
  actorOwnerId: PlayerId
): ReadonlySet<CellId> {
  const cellIds = Object.keys(state.cells) as CellId[];
  const starts = new Set<CellId>();
  const budget = { remaining: Math.min(100_000, Math.max(128, cellIds.length * 64)) };
  for (const startId of cellIds) {
    if (matchesSpatialPredicate(state, terrains, startId, actorOwnerId, pattern.starts)) starts.add(startId);
  }
  return starts.size === 0 ? starts : evaluateExpression(state, terrains, starts, actorOwnerId, pattern.expression, budget);
}

function evaluateExpression(
  state: GameState,
  terrains: TerrainCatalog,
  from: ReadonlySet<CellId>,
  actorOwnerId: PlayerId,
  expression: SpatialExpression,
  budget: { remaining: number }
): Set<CellId> {
  switch (expression.op) {
    case "step": {
      const result = new Set<CellId>();
      for (const cellId of from) {
        const cell = state.cells[cellId];
        if (!cell) continue;
        for (const coordinate of getHexNeighbours(cell.coordinate, state.board)) {
          if (--budget.remaining < 0) throw new Error("Spatial pattern exceeded its evaluation budget.");
          const destinationId = toCellId(coordinate);
          if (state.cells[destinationId] && matchesSpatialPredicate(state, terrains, destinationId, actorOwnerId, expression.where)) {
            result.add(destinationId);
          }
        }
      }
      return result;
    }
    case "sequence": {
      let result = new Set(from);
      for (const item of expression.items) {
        result = evaluateExpression(state, terrains, result, actorOwnerId, item, budget);
        if (result.size === 0) break;
      }
      return result;
    }
    case "either": {
      const result = new Set<CellId>();
      for (const item of expression.items) {
        for (const cellId of evaluateExpression(state, terrains, from, actorOwnerId, item, budget)) result.add(cellId);
      }
      return result;
    }
    case "repeat": {
      if (!Number.isInteger(expression.min) || !Number.isInteger(expression.max)
        || expression.min < 0 || expression.max < expression.min || expression.max > MAX_PATTERN_STEPS) {
        throw new Error("Spatial pattern repeat bounds are invalid.");
      }
      let frontier = new Set(from);
      const result = expression.min === 0 ? new Set(from) : new Set<CellId>();
      const discovered = new Set(from);
      for (let step = 1; step <= expression.max; step += 1) {
        frontier = evaluateExpression(state, terrains, frontier, actorOwnerId, expression.item, budget);
        if (frontier.size === 0) break;
        if (step >= expression.min) for (const cellId of frontier) result.add(cellId);
        const hasNewCell = [...frontier].some((cellId) => !discovered.has(cellId));
        for (const cellId of frontier) discovered.add(cellId);
        if (!hasNewCell && step >= expression.min) break;
      }
      return result;
    }
  }
}

export function matchesSpatialPredicate(
  state: GameState,
  terrains: TerrainCatalog,
  cellId: CellId,
  actorOwnerId: PlayerId,
  predicate: SpatialPredicate
): boolean {
  switch (predicate.op) {
    case "terrain-has": {
      const cell = state.cells[cellId];
      const terrain = cell ? terrains[cell.terrainId] : undefined;
      return !!terrain && !!getTerrainCapability(terrain, predicate.capabilityId);
    }
    case "unit-owner-is": {
      const cell = state.cells[cellId];
      const unit = cell?.unitId ? state.units[cell.unitId] : undefined;
      return !!unit && (predicate.owner === "actor" ? unit.ownerId === actorOwnerId : unit.ownerId !== actorOwnerId);
    }
    case "unit-has-marker": {
      const cell = state.cells[cellId];
      const unit = cell?.unitId ? state.units[cell.unitId] : undefined;
      return !!unit?.markers?.includes(predicate.marker);
    }
    case "all": return predicate.items.every((item) => matchesSpatialPredicate(state, terrains, cellId, actorOwnerId, item));
    case "any": return predicate.items.some((item) => matchesSpatialPredicate(state, terrains, cellId, actorOwnerId, item));
    case "not": return !matchesSpatialPredicate(state, terrains, cellId, actorOwnerId, predicate.item);
  }
}
