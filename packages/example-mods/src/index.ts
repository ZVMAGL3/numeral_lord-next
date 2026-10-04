import { defineTerrainMod, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { SpatialPatternDefinition } from "@numeral-lord/game-core";

export const GROVE_MOD_ID = "mod-sample-grove";
const GROVE_CAPABILITY_ID = "mod/sample-grove/grove-source";

const occupiable: CapabilityBinding = { id: "core/occupiable" };
const conductor: CapabilityBinding = { id: "core/power-conductor" };
const groveSource: CapabilityBinding = { id: GROVE_CAPABILITY_ID, config: { points: 1 } };

const occupiedGroves: SpatialPatternDefinition = {
  id: `${GROVE_MOD_ID}/occupied-groves`,
  starts: {
    op: "all",
    items: [
      { op: "terrain-has", capabilityId: GROVE_CAPABILITY_ID },
      { op: "unit-owner-is", owner: "actor" }
    ]
  },
  expression: {
    op: "repeat",
    min: 0,
    max: 0,
    item: { op: "step", relation: "hex-neighbor", where: { op: "cell-exists" } }
  },
  result: { entity: "unit", distinctBy: "id" }
};

/** Occupying a Grove yields configurable income at the owner's next turn start. */
export const verdantGroveMod = defineTerrainMod({
  id: GROVE_MOD_ID,
  name: "生息林",
  version: "1.0.0",
  capabilities: [{ id: GROVE_CAPABILITY_ID, target: "terrain", defaultConfig: { points: 1 } }],
  settings: [{
    id: "pointsPerTurn",
    displayName: "每回合收益",
    description: "己方单位占据生息林时，在己方回合开始获得的点数。",
    kind: "integer",
    defaultValue: 1,
    min: 0,
    max: 4,
    target: { capabilityId: GROVE_CAPABILITY_ID, configKey: "points" }
  }],
  spatialPatterns: [occupiedGroves],
  rules: [{
    id: `${GROVE_MOD_ID}/occupied-income`,
    trigger: "turn-start",
    target: { scope: "pattern-units", patternId: occupiedGroves.id, owner: "actor" },
    effects: [{ type: "grant-points-from-setting", settingId: "pointsPerTurn" }]
  }],
  terrain: {
    capabilities: [occupiable, conductor, groveSource],
    visuals: { baseColor: "#5f8d64" }
  },
  units: [],
  commandRules: [],
  victoryConditions: []
});

export const GROVE_TERRAIN_ID = verdantGroveMod.terrain.id;

export const WARD_MOD_ID = "mod-sample-ward";
const WARD_CAPABILITY_ID = "mod/sample-ward/ward-source";
const wardSource: CapabilityBinding = {
  id: WARD_CAPABILITY_ID,
  config: { radius: "2", exhaustOnEnter: true, exhaustOnLeave: false }
};

const wardRadiusOptions = ["1", "2", "3"] as const;
const wardPatterns = wardRadiusOptions.map((radius) => ({
  id: `${WARD_MOD_ID}/hostile-ring-${radius}`,
  starts: {
    op: "all" as const,
    items: [
      { op: "terrain-has" as const, capabilityId: WARD_CAPABILITY_ID },
      { op: "unit-team-is" as const, team: "other" as const }
    ]
  },
  expression: {
    op: "hex-range" as const,
    min: 1,
    max: Number(radius),
    where: { op: "cell-exists" as const }
  },
  result: { entity: "cell" as const },
  excludeStarts: true
})) satisfies readonly SpatialPatternDefinition[];

const wardRules = wardRadiusOptions.flatMap((radius) => ([
  {
    id: `${WARD_MOD_ID}/enter-ring-${radius}`,
    trigger: "unit-enter" as const,
    direction: "enter" as const,
    settingId: "exhaustOnEnter"
  },
  {
    id: `${WARD_MOD_ID}/leave-ring-${radius}`,
    trigger: "unit-leave" as const,
    direction: "leave" as const,
    settingId: "exhaustOnLeave"
  }
].map(({ id, trigger, direction, settingId }) => ({
  id,
  trigger,
  target: { scope: "trigger-unit" as const },
  conditions: [
    { op: "crosses-pattern-boundary" as const, patternId: `${WARD_MOD_ID}/hostile-ring-${radius}`, direction },
    { op: "mod-setting-equals" as const, settingId: "radius", value: radius },
    { op: "mod-setting-equals" as const, settingId, value: true }
  ],
  effects: [{ type: "exhaust-unit" as const }]
}))));

/**
 * A captured ward suppresses hostile units when they cross its configurable
 * 1–3 ring boundary. Movement wholly inside that area remains unaffected.
 */
export const borderWardMod = defineTerrainMod({
  id: WARD_MOD_ID,
  name: "边境屏障",
  version: "1.0.0",
  capabilities: [{ id: WARD_CAPABILITY_ID, target: "terrain", defaultConfig: {
    radius: "2", exhaustOnEnter: true, exhaustOnLeave: false
  } }],
  settings: [
    {
      id: "radius",
      displayName: "压制范围",
      description: "以敌方占据的边境据点为中心，作用于外围几圈。",
      kind: "choice",
      defaultValue: "2",
      options: [...wardRadiusOptions],
      target: { capabilityId: WARD_CAPABILITY_ID, configKey: "radius" }
    },
    {
      id: "exhaustOnEnter",
      displayName: "进入范围时失活",
      kind: "boolean",
      defaultValue: true,
      target: { capabilityId: WARD_CAPABILITY_ID, configKey: "exhaustOnEnter" }
    },
    {
      id: "exhaustOnLeave",
      displayName: "离开范围时失活",
      kind: "boolean",
      defaultValue: false,
      target: { capabilityId: WARD_CAPABILITY_ID, configKey: "exhaustOnLeave" }
    }
  ],
  spatialPatterns: wardPatterns,
  rules: wardRules,
  terrain: {
    capabilities: [occupiable, conductor, wardSource],
    visuals: { baseColor: "#79628c" }
  },
  units: [],
  commandRules: [],
  victoryConditions: []
});

export const WARD_TERRAIN_ID = borderWardMod.terrain.id;

export const exampleTerrainMods = [verdantGroveMod, borderWardMod] as const;
export const exampleTerrainCatalog = Object.fromEntries(
  exampleTerrainMods.map((mod) => [mod.terrain.id, mod.terrain])
);
