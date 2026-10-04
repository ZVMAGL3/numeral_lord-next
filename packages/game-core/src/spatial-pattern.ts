import { getTerrainCapability, type TerrainCatalog } from "./content.js";
import { fromAxialCoordinate, getHexNeighbours, isWithinHexBounds, toAxialCoordinate, toCellId } from "./hex.js";
import type { CellId, GameState, PlayerId, UnitId } from "./state.js";

/** JSON-safe vocabulary for author-defined spatial patterns (regular paths on the hex graph). */
export type SpatialPredicate =
  | { readonly op: "cell-exists" }
  | { readonly op: "terrain-has"; readonly capabilityId: string }
  | { readonly op: "terrain-is"; readonly terrainId: string }
  | { readonly op: "unit-owner-is"; readonly owner: "actor" | "other" }
  | { readonly op: "unit-team-is"; readonly team: "actor" | "other" }
  | { readonly op: "unit-has-marker"; readonly marker: string }
  /** 收益前置条件使用：当前格驻守单位是否已接入供电网络。 */
  | { readonly op: "unit-is-powered" }
  | { readonly op: "all"; readonly items: readonly SpatialPredicate[] }
  | { readonly op: "any"; readonly items: readonly SpatialPredicate[] }
  | { readonly op: "not"; readonly item: SpatialPredicate };

export type SpatialExpression =
  | { readonly op: "step"; readonly relation: "hex-neighbor"; readonly where: SpatialPredicate }
  | { readonly op: "hex-offsets"; readonly offsets: readonly (readonly [number, number])[]; readonly where?: SpatialPredicate }
  | { readonly op: "hex-range"; readonly min: number; readonly max: number; readonly where: SpatialPredicate }
  | { readonly op: "sequence"; readonly items: readonly SpatialExpression[] }
  | { readonly op: "either"; readonly items: readonly SpatialExpression[] }
  | { readonly op: "repeat"; readonly item: SpatialExpression; readonly min: number; readonly max: number };

export interface SpatialPatternDefinition {
  readonly id: string;
  /** Candidate start cells are tested with `starts`; the pattern returns reachable endpoints. */
  readonly starts: SpatialPredicate;
  readonly expression: SpatialExpression;
  readonly result: { readonly entity: "cell" } | { readonly entity: "unit"; readonly distinctBy: "id" };
  /** For area queries, omit anchor cells from the matched region. */
  readonly excludeStarts?: boolean;
  /** When present, this pattern provides the board's derived powered-unit set. */
  readonly role?: "core/powered-units";
}

const MAX_PATTERN_STEPS = 4096;

/** Evaluate an existing spatial path from explicit cells, using the same bounded interpreter as Mod patterns. */
export function selectSpatialExpressionCellsFrom(
  state: GameState,
  terrains: TerrainCatalog,
  startCellIds: readonly CellId[],
  expression: SpatialExpression,
  actorOwnerId: PlayerId
): ReadonlySet<CellId> {
  const starts = new Set(startCellIds.filter((cellId) => !!state.cells[cellId]));
  if (starts.size === 0) return starts;
  const budget = { remaining: Math.min(500_000, Math.max(256, Object.keys(state.cells).length * 128)) };
  return evaluateExpression(state, terrains, starts, actorOwnerId, expression, budget);
}

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
  // A regular path can legitimately fan out into several alternatives. Keep a
  // hard ceiling for hostile definitions, but budget against total board size
  // so a large (valid) board is not rejected just because it needs a few broad
  // scans. The caller also catches budget exhaustion and leaves the command
  // unapplied.
  const budget = { remaining: Math.min(500_000, Math.max(256, cellIds.length * 128)) };
  for (const startId of cellIds) {
    if (matchesSpatialPredicate(state, terrains, startId, actorOwnerId, pattern.starts)) starts.add(startId);
  }
  if (starts.size === 0) return starts;
  const result = evaluateExpression(state, terrains, starts, actorOwnerId, pattern.expression, budget);
  if (pattern.excludeStarts && pattern.result.entity === "cell") {
    for (const startId of starts) result.delete(startId);
  }
  return result;
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
    case "hex-offsets": {
      const result = new Set<CellId>();
      for (const cellId of from) {
        const cell = state.cells[cellId];
        if (!cell) continue;
        const origin = toAxialCoordinate(cell.coordinate);
        for (const [deltaQ, deltaR] of expression.offsets) {
          if (--budget.remaining < 0) throw new Error("Spatial pattern exceeded its evaluation budget.");
          const coordinate = fromAxialCoordinate({ q: origin.q + deltaQ, r: origin.r + deltaR });
          if (!isWithinHexBounds(coordinate, state.board)) continue;
          const destinationId = toCellId(coordinate);
          if (!state.cells[destinationId]) continue;
          if (expression.where && !matchesSpatialPredicate(state, terrains, destinationId, actorOwnerId, expression.where)) continue;
          result.add(destinationId);
        }
      }
      return result;
    }
    case "hex-range": {
      if (!Number.isInteger(expression.min) || !Number.isInteger(expression.max)
        || expression.min < 0 || expression.max < expression.min || expression.max > MAX_PATTERN_STEPS) {
        throw new Error("Spatial pattern hex-range bounds are invalid.");
      }
      const result = new Set<CellId>();
      const distances = new Map<CellId, number>();
      const queue: { readonly cellId: CellId; readonly distance: number }[] = [];
      for (const cellId of from) {
        distances.set(cellId, 0);
        queue.push({ cellId, distance: 0 });
        if (expression.min === 0 && matchesSpatialPredicate(state, terrains, cellId, actorOwnerId, expression.where)) {
          result.add(cellId);
        }
      }
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor]!;
        if (current.distance >= expression.max) continue;
        const cell = state.cells[current.cellId];
        if (!cell) continue;
        for (const coordinate of getHexNeighbours(cell.coordinate, state.board)) {
          if (--budget.remaining < 0) throw new Error("Spatial pattern exceeded its evaluation budget.");
          const destinationId = toCellId(coordinate);
          if (!state.cells[destinationId]) continue;
          const distance = current.distance + 1;
          const knownDistance = distances.get(destinationId);
          if (knownDistance !== undefined && knownDistance <= distance) continue;
          distances.set(destinationId, distance);
          queue.push({ cellId: destinationId, distance });
          if (distance >= expression.min
            && matchesSpatialPredicate(state, terrains, destinationId, actorOwnerId, expression.where)) {
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
  predicate: SpatialPredicate,
  poweredUnitIds?: ReadonlySet<UnitId>
): boolean {
  switch (predicate.op) {
    case "cell-exists":
      return !!state.cells[cellId];
    case "terrain-has": {
      const cell = state.cells[cellId];
      const terrain = cell ? terrains[cell.terrainId] : undefined;
      return !!terrain && !!getTerrainCapability(terrain, predicate.capabilityId);
    }
    case "terrain-is":
      return state.cells[cellId]?.terrainId === predicate.terrainId;
    case "unit-owner-is": {
      const cell = state.cells[cellId];
      const unit = cell?.unitId ? state.units[cell.unitId] : undefined;
      return !!unit && (predicate.owner === "actor" ? unit.ownerId === actorOwnerId : unit.ownerId !== actorOwnerId);
    }
    case "unit-team-is": {
      const cell = state.cells[cellId];
      const unit = cell?.unitId ? state.units[cell.unitId] : undefined;
      const unitTeam = unit ? state.players[unit.ownerId]?.teamId : undefined;
      const actorTeam = state.players[actorOwnerId]?.teamId;
      return !!unitTeam && !!actorTeam
        && (predicate.team === "actor" ? unitTeam === actorTeam : unitTeam !== actorTeam);
    }
    case "unit-has-marker": {
      const cell = state.cells[cellId];
      const unit = cell?.unitId ? state.units[cell.unitId] : undefined;
      return !!unit?.markers?.includes(predicate.marker);
    }
    case "unit-is-powered": {
      const unitId = state.cells[cellId]?.unitId;
      return !!unitId && !!poweredUnitIds?.has(unitId);
    }
    case "all": return predicate.items.every((item) => matchesSpatialPredicate(state, terrains, cellId, actorOwnerId, item, poweredUnitIds));
    case "any": return predicate.items.some((item) => matchesSpatialPredicate(state, terrains, cellId, actorOwnerId, item, poweredUnitIds));
    case "not": return !matchesSpatialPredicate(state, terrains, cellId, actorOwnerId, predicate.item, poweredUnitIds);
  }
}
