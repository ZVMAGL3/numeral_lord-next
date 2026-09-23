import { defineMod, type CapabilityBinding } from "@numeral-lord/game-sdk";
import type { TerrainCatalog } from "@numeral-lord/game-core";

// `id` 是能力的稳定标识；地图和 Mod 不依赖中文名称来判断规则。
// 选择此能力后，单位可以绑定在该地形格上。
const occupiable: CapabilityBinding = { id: "core/occupiable" };

// 选择此能力后，该格会被 `power-network` 当作可传递电力的路径。
const powerConductor: CapabilityBinding = { id: "core/power-conductor" };

/**
 * A source belongs to whichever player occupies this terrain. An empty
 * stronghold is not a source, so it cannot power any units.
 */
const occupiedPowerSource: CapabilityBinding = {
  // 该地形是供电网络的起点。
  id: "core/power-source",
  config: {
    // `occupied` 表示必须有单位占据据点才会供电；空据点不供电。
    activation: "occupied"
  }
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
  id: "core/adjacent-hostile-exhaustion",
  config: {
    // 以据点所在格为中心，检查一圈六边形相邻格。
    radius: 1,
    // 据点必须被单位占据才会形成封锁区。
    activation: "occupied",
    // 同队为友方；非同队单位才受封锁影响。
    friendlyRelation: "same-team",
    // 据点自身不在影响范围中，符合“据点周围但不包括据点本身”。
    excludeSourceCell: true,
    // 命中后产生的规则事件；它会写入 turn.exhaustedUnitIds。
    effect: "exhaust-unit"
  }
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
  // Mod 的稳定标识；地图会锁定此 id、版本和内容哈希。
  id: "core-terrain",
  // 修改既有规则时必须提升版本，避免旧地图规则被悄悄改变。
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
      // 供电源：在满足 activation 条件时成为供电网络的起点。
      id: "core/power-source",
      target: "terrain",
      // 未单独配置时，默认必须被单位占据才激活。
      defaultConfig: { activation: "occupied" }
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
      defaultConfig: {
        radius: 1,
        activation: "occupied",
        friendlyRelation: "same-team",
        excludeSourceCell: true,
        effect: "exhaust-unit"
      }
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
      capabilities: [occupiable, oceanDepartureExhaustion]
    },
    {
      id: "core/plain",
      displayName: "平原",
      // 可驻兵且可传电；平原本身不产点。
      capabilities: [occupiable, powerConductor]
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
        adjacentHostileExhaustion
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
