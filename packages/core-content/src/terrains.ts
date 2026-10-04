import { defineMod, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";

// `id` 是能力的稳定标识；地图和 Mod 不依赖中文名称来判断规则。
// 选择此能力后，单位可以绑定在该地形格上。
const occupiable: CapabilityBinding = { id: "core/occupiable" };

// 选择此能力后，该格会被 `power-network` 当作可传递电力的路径。
const powerConductor: CapabilityBinding = { id: "core/power-conductor" };

/**
 * Terrain controls how many times an occupying unit may counterattack during
 * one opponent action phase. This is separate from the unit's ability to
 * counterattack at all (`core/counterattack`). The count resets at the next
 * player's action phase, so attacking a plain/ocean defender with a small
 * stack can consume its sole counterattack before a second attack.
 */
const oneCounterattack: CapabilityBinding = {
  id: "core/counterattack-terrain-limit",
  config: { maxPerActionPhase: 1 }
};
const strongholdCounterattackLimit: CapabilityBinding = {
  id: "core/counterattack-terrain-limit",
  config: { maxPerActionPhase: 6 }
};

/**
 * A source belongs to whichever player occupies this terrain. An empty
 * stronghold is not a source, so it cannot power any units.
 */
const occupiedPowerSource: CapabilityBinding = {
  // 当前规则契约固定为“占据后供电”；空据点不是供电网络种子。
  id: "core/power-source"
};

/** 平原和据点在己方回合开始时，为被占领且通电的地块提供 1 点收益。 */
const poweredTerrainIncome: CapabilityBinding = {
  id: "core/income-source",
  config: { amount: 1, requires: "powered-occupant", when: "owner-turn-start" }
};

/**
 * A survival anchor is deliberately distinct from power production. A map may
 * put a power source on a generator without making it a "lose this and die"
 * stronghold; the selected match-condition module reads this marker instead.
 */
const survivalAnchor: CapabilityBinding = { id: "core/survival-anchor" };

/**
 * 据点的封锁区与供电完全无关。只要敌对单位完成一次移动或近战攻击并
 * 落在据点相邻的格子，就会在本回合被标记为 exhausted；据点自身所在格
 * 不属于这个范围。`same-team` 的单位不受影响，友伤地图设置也不会改变
 * 这个关系。
 */
const adjacentHostileExhaustion: CapabilityBinding = {
  // 当前能力契约固定为“被占据时封锁六邻格的非同队单位”；
  // game-core 暂不读取半径等配置，不在这里写会被忽略的假参数。
  id: "core/adjacent-hostile-exhaustion"
};

/** Capture exhaustion is an enter reaction; post-capture power is checked by the engine. */
const exhaustUnpoweredCapturingUnit: CapabilityBinding = {
  id: "core/exhaust-unpowered-after-capture"
};

// 平原和沙漠共享驻兵、导电与战斗行为；收益由各地形单独声明。
const plainCapabilities = [occupiable, powerConductor, oneCounterattack, exhaustUnpoweredCapturingUnit] as const;

/** 离开海洋进入陆地后，本次行动的单位本回合不能再次行动。 */
const oceanDepartureExhaustion: CapabilityBinding = {
  id: "core/exhaust-on-departure",
  config: {
    // 只在离开海洋地形时触发；海洋格之间移动不触发。
    triggerMode: "terrain-transition"
  }
};

/**
 * This is ordinary content, not an inheritance hierarchy.
 *
 * `void` and `mountain` deliberately have the same game behaviour: neither
 * includes `core/occupiable`, so the global movement rule rejects both. They
 * remain separate ids solely to allow map authors to give them different art.
 */
export const coreTerrainMod = defineMod({
  // Mod 的稳定标识；当前地图码只记录所需 Mod id。版本/哈希锁定仍待实现。
  id: "core-terrain",
  // 内容包版本供将来的版本锁定使用；当前地图码还未记录它。
  version: "0.1.0",

  // 向引擎注册本内容包可使用的公共能力。
  capabilities: [
    {
      // 可驻兵：这是全局移动规则唯一检查的地形能力。
      id: "core/occupiable",
      // 该能力只能附加到 terrain（地形），不能附加到单位。
      target: "terrain",
      // 空对象表示它本身不需要额外参数。
      defaultConfig: {}
    },
    {
      // 移动默认沿用兵种范围；仅绑定中的 expression 存在时使用自定义目标。
      id: "core/terrain-movement",
      target: "terrain",
      defaultConfig: { enabled: true }
    },
    {
      // 可导电：本身不生产电，只能作为电力网络中的通路。
      id: "core/power-conductor",
      target: "terrain",
      defaultConfig: {}
    },
    {
      // 地块收益由占领关系、通电前置条件和结算时机共同决定。
      id: "core/income-source",
      target: "terrain",
      defaultConfig: { amount: 0, requires: "occupied", when: "owner-turn-start" }
    },
    {
      // 防守方在这块地皮上每个进攻回合可反击的次数。0 表示不能反击，
      id: "core/counterattack-terrain-limit",
      target: "terrain",
      defaultConfig: { maxPerActionPhase: 1 }
    },
    {
      // 供电源：当前规则固定要求该格有己方单位占据。
      id: "core/power-source",
      target: "terrain",
      defaultConfig: {}
    },
    {
      // 生存据点：用于“失去全部据点，其余单位阵亡”这一胜负规则。
      id: "core/survival-anchor",
      target: "terrain",
      defaultConfig: {}
    },
    {
      // 进入地形后的失活反应；触发范围由 binding 的 triggerMode 选择。
      id: "core/exhaust-on-entry",
      target: "terrain",
      defaultConfig: { triggerMode: "each-cell" }
    },
    {
      // 离开触发器：由地形声明，不绑定某个兵种。
      id: "core/exhaust-on-departure",
      target: "terrain",
      defaultConfig: { triggerMode: "each-cell" }
    },
    {
      // 封锁区：据点占据时，敌方单位走入其相邻格后会失去当前回合行动力。
      id: "core/adjacent-hostile-exhaustion",
      target: "terrain",
      // 六邻格、占据条件、队伍关系是当前能力的固定契约。
      defaultConfig: {}
    },
    {
      // 进入地块时处理攻击占领后的游兵失活，供电状态按占领后重新计算。
      id: "core/exhaust-unpowered-after-capture",
      target: "terrain",
      defaultConfig: {}
    },
  ],
  // Built-in stronghold suppression is expressed through the same spatial
  // pattern and transition rule available to data-only Mods, rather than as a
  // special engine movement branch.
  spatialPatterns: [{
    id: "core-terrain/hostile-stronghold-zone",
    starts: {
      op: "all",
      items: [
        { op: "terrain-has", capabilityId: "core/adjacent-hostile-exhaustion" },
        { op: "unit-team-is", team: "other" }
      ]
    },
    expression: {
      op: "repeat",
      min: 1,
      max: 1,
      item: { op: "step", relation: "hex-neighbor", where: { op: "cell-exists" } }
    },
    result: { entity: "cell" }
  }],
  rules: [{
    id: "core-terrain/hostile-stronghold-exhaustion",
    trigger: "unit-enter",
    target: { scope: "trigger-unit" },
    conditions: [{ op: "cell-in-pattern", patternId: "core-terrain/hostile-stronghold-zone" }],
    effects: [{ type: "exhaust-unit" }]
  }],

  // 首批地皮包暂不定义新兵种；兵种在独立内容包中加入。
  units: [],
  // 具体命令规则将在阶段 A/B 实现后从这里注册。
  commandRules: [],
  // 基础胜利条件也将在独立规则包中注册。
  victoryConditions: []
});

/**
 * Runtime lookup table consumed by game-core. Core terrain types are engine
 * catalog entries, not a multi-terrain Mod package.
 */
export const coreTerrainCatalog: TerrainCatalog = {
  "core/void": { id: "core/void", displayName: "虚无", capabilities: [] },
  "core/mountain": { id: "core/mountain", displayName: "山地", capabilities: [] },
  "core/ocean": {
    id: "core/ocean", displayName: "海洋",
    capabilities: [occupiable, oceanDepartureExhaustion, oneCounterattack, exhaustUnpoweredCapturingUnit]
  },
  "core/plain": {
    id: "core/plain", displayName: "平原",
    capabilities: [...plainCapabilities, poweredTerrainIncome]
  },
  "core/stronghold": {
    id: "core/stronghold", displayName: "据点",
    capabilities: [occupiable, powerConductor, occupiedPowerSource, poweredTerrainIncome, survivalAnchor,
      adjacentHostileExhaustion, exhaustUnpoweredCapturingUnit, strongholdCounterattackLimit]
  }
};
