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
const unlimitedCounterattacks: CapabilityBinding = {
  id: "core/counterattack-terrain-limit",
  config: { maxPerActionPhase: "unlimited" }
};

/**
 * A source belongs to whichever player occupies this terrain. An empty
 * stronghold is not a source, so it cannot power any units.
 */
const occupiedPowerSource: CapabilityBinding = {
  // 当前规则契约固定为“占据后供电”；空据点不是供电网络种子。
  id: "core/power-source"
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

/** 离开海洋进入陆地后，本次行动的单位本回合不能再次行动。 */
const oceanDepartureExhaustion: CapabilityBinding = {
  id: "core/exhaust-on-departure",
  config: {
    // 在海洋内部移动不触发；进入任意非海洋地形时触发。
    destinationTerrainIdNot: "core/ocean"
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
      // 可导电：本身不生产电，只能作为电力网络中的通路。
      id: "core/power-conductor",
      target: "terrain",
      defaultConfig: {}
    },
    {
      // 防守方在这块地皮上每个进攻回合可反击的次数。0 表示不能反击，
      // "unlimited" 表示不限次数；未设置则由兵种的反击次数能力决定。
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
      // 离开触发器：由地形声明，不绑定某个兵种。
      id: "core/exhaust-on-departure",
      target: "terrain",
      defaultConfig: { destinationTerrainIdNot: "core/ocean" }
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

  // 每项都是独立地形定义；数组顺序不表示继承关系。
  terrains: [
    {
      // 用于地图数据和程序判断的 id。
      id: "core/void",
      // 用于 UI 显示的中文名。
      displayName: "虚无",
      // 不带 occupiable，因此不能进入；其他游戏能力也一律没有。
      capabilities: []
    },
    {
      id: "core/mountain",
      displayName: "山地",
      // 规则与虚无相同，只预留不同美术表现。
      capabilities: []
    },
    {
      id: "core/ocean",
      displayName: "海洋",
      // 可驻兵，但没有 power-conductor，所以其中单位默认保持游兵。
      capabilities: [occupiable, oceanDepartureExhaustion, oneCounterattack, exhaustUnpoweredCapturingUnit]
    },
    {
      id: "core/plain",
      displayName: "平原",
      // 可驻兵且可传电；平原本身不产点。
      capabilities: [occupiable, powerConductor, oneCounterattack, exhaustUnpoweredCapturingUnit]
    },
    {
      id: "core/stronghold",
      displayName: "据点",
      capabilities: [
        // 下面四项是组合关系，彼此不继承：
        // 可驻兵、可传电、被占据时供电、相邻敌方单位耗尽。
        // 通电兵的收益属于单位能力 `core/powered-income`，不属于据点。
        occupiable,
        powerConductor,
        occupiedPowerSource,
        // 这是胜负锚点，不等同于供电能力；地图可单独选择胜负模块。
        survivalAnchor,
        adjacentHostileExhaustion,
        exhaustUnpoweredCapturingUnit,
        unlimitedCounterattacks
      ]
    },
  ],
  // 首批地皮包暂不定义新兵种；兵种在独立内容包中加入。
  units: [],
  // 具体命令规则将在阶段 A/B 实现后从这里注册。
  commandRules: [],
  // 基础胜利条件也将在独立规则包中注册。
  victoryConditions: []
});

/**
 * Runtime lookup table consumed by game-core. The same terrain declarations
 * remain available through coreTerrainMod to map editors and future Mod tools.
 */
export const coreTerrainCatalog = Object.fromEntries(
  coreTerrainMod.terrains.map((terrain) => [terrain.id, terrain])
) as TerrainCatalog;
