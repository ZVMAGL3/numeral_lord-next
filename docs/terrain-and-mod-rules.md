# 地皮、能力与规则触发点

地皮不是 JS 类继承树。一个地图格只保存 `terrainId`；该 ID 在运行时内容目录里找到 `{ id, displayName, capabilities }`。收益属于地块的 `core/income-source`：地块声明点数、前置条件和结算时机；己方占领是基础条件，额外前置可选占领且通电，或用受限 JSON 条件表达式自定义组合。没有收益来源或数值为 0 就不产点，不需要单独的“禁止收益”能力。平原和据点在己方回合开始时要求己方占领且通电，产生 1 点；沙漠不绑定收益来源；油田独立声明占领即可得 2 点，不要求通电。海洋有“可驻兵、跨出海洋时失活”，据点另带供电和生存锚点；敌方据点周围的压制由核心包中的空间模式和规则表达，不是可任意勾给地块的能力。山地/虚无都不带“可驻兵”，规则上都不能进入。油田在独立的 `@numeral-lord/oil-field-mod` 包里，而非核心地形包。

目前没有让 Mod 随意执行代码的通用 `onEnter`/`onLeave` 回调总线。`game-core` 是浏览器、Node 服务和将来无界面 AI 共用的纯规则内核：它在固定结算节点读取能力 ID 与配置，再产生新状态。Vue 只负责显示和点击，不能独自决定规则。当前触发顺序是：

1. 移动/攻击前验证玩家、行动阶段、单位能力、目标地形是否 `core/occupiable`，再检查点数和范围。
2. 离开原格时读取 `core/departure-garrison`。油田要求留 1 点驻兵，留下的兵本回合失活；不够留下时不能离开。海洋的 `core/exhaust-on-departure` 在移到非海洋后令行动单位失活。
3. 落到目标格后，内核处理目标地形的进入触发，再执行 Mod 的数据规则。核心据点封锁使用空间模式实时选出“敌方已占据据点周围一圈”的格；据点被夺取、清空或同队占领时，选区会跟着当前棋盘变化，不会把占领者写死在地图元数据里。普通进入/离开失活是地形能力；区域失活用空间规则描述。
4. 攻击结算时单位要有 `core/counterattack` 才能反击，随后读取防守者脚下地皮的 `core/counterattack-terrain-limit`：平原/海洋每个进攻玩家行动阶段一次，据点无限，油田零次。已用次数在进攻方的加点阶段保留，轮到下个玩家行动时清零；已失去行动力的防守单位不能反击。只有当前客户端选中的攻击单位，其合法攻击目标会显示红/白框；选中状态和可达格提示都是客户端私有状态，不进入棋局、房间转发、存档或棋谱，行动结算后清除。
5. 通电兵离开原格时按规则留 1 点驻兵；这个留兵不是给攻击增加兵力，也不是结算后返还点数。以 5 点通电兵攻击 7 点防守兵为例，攻击结算使用移动后的 4 点：攻击未能击破防守方，防守方按这 4 点损失后剩 3 点；若防守方本次仍能反击，就消耗反击次数并消灭攻击方，因此原格也不会留下那 1 点驻兵。若防守方不能反击，攻击方留在原格失去行动力，防守方仍按 4 点损失兵力。通电兵攻击成功占领时，才会在原格留下 1 点驻兵。这样先诱骗掉平原/海洋的有限反击后，后续攻击不会再触发该地块本回合的反击。
6. 每位玩家**行动回合开始**时扫描己方占领的地块，只结算地块 `core/income-source` 中 `when: "owner-turn-start"` 且满足 `requires` 与可选 `condition` 的收益。自定义 `condition` 复用有限空间条件语法，可用 `all`、`any`、`not` 组合地块能力、单位通电、队伍和单位标记；它只检查收益地块上的己方驻守单位，不执行脚本。平原/据点要求单位通电；油田只要求被占领，所以油田不需要导电。

| 想表达的“事件” | 目前的声明方式 | 实际执行位置 |
| --- | --- | --- |
| 能否进入格 | 地皮有无 `core/occupiable` | `getLegalActionDestinationIds` 与 `moveUnit` |
| 离开油田留兵 | 油田挂 `core/departure-garrison`，配置留兵强度和兵种 | `leaveDepartureGarrison` |
| 离开海洋失活 | 海洋挂 `core/exhaust-on-departure`，可配置目标地形例外 | `applyDepartureExhaustion` |
| 进入据点周围失活 | 核心 Mod 的空间模式选择敌方已占据据点六邻格，`unit-enter` 规则检查到达格是否命中 | `selectSpatialPatternCells` 与 `cell-in-pattern` |
| 被攻击时反击 | 单位挂 `core/counterattack`，地皮挂反击次数上限；本地红/白框只标注当前所选攻击者可攻击的单位目标 | `applyCounterattack`；红/白框由客户端根据权威棋盘和本地交互状态计算 |
| 己方回合开始收益 | 被己方占领地块的 `core/income-source`，再检查前置条件 | `grantReinforcementIncome` |

地形进入/离开能力仍可编译进格子的本地触发列表。区域效果则使用空间模式从地图选择一组格，并由规则判断进入/离开事件，不需要为每一个区域格生成静态链接。地图码的可选 `cellLinks: [{ trigger, source, target, relationId }]` 仍用于明确的有向格子关系：`trigger: "enter"` 把关系挂在目标格进入触发上，`trigger: "leave"` 把关系挂在源格离开触发上；格子序号为从 0 开始的行优先索引。链接本身不等于行为：`relationId` 仍需由共享规则内核/已加载规则模块解释。

这里的 `GameEvent` 只是命令执行后返回的结果通知（例如“单位失活”），**不是**给 Mod 注册任意回调的 `onEnter`/`onLeave` 接口。新增地皮若只需要已有能力，新增内容包和配置即可；若需要全新的触发时机，仍须先在共享内核定义这个时机与输入/输出契约，再让 Mod 声明如何使用。这样 Node、浏览器和将来的 AI 才会执行同一条规则。

目前 `core/power-source` 的“被占据才供电”仍是固定能力语义。`core/adjacent-hostile-exhaustion` 仅是核心据点内部使用的区域起点标记，创意工坊不会把它作为普通能力提供；核心据点的一圈范围由普通空间模式与 `unit-enter` 规则定义。Mod 也可以定义自己的起点标记和空间模式。`core/exhaust-on-entry`、`core/exhaust-on-departure` 提供进入/离开失活，并可选择“每格触发”或“仅跨入/跨出该地形触发”。

## 空间模式与区域边界

空间模式是有限、可校验的空间查询。`hex-range` 按最短六边形距离精确选择第 N 到第 M 圈；`repeat` 则用于可组合的正则路径匹配，不应与最短距离圈数混为一谈。`cell-exists` 表示不限制底图类型的任意棋盘格；`excludeStarts: true` 会把作为范围锚点的起点排除。规则条件有两种区域判定：

- `cell-in-pattern`：事件发生在选择区域内即触发；在区域内移动也会再次触发。
- `crosses-pattern-boundary`：仅在单位从区域外进入、或从区域内离开时触发；起点和终点都在区域内就不触发。

例如下面的规则表示：先在 Mod 能力列表声明 `mod/outer-zone/source`，并绑定到作为范围中心的地形；以被敌方队伍占据的中心格为起点，选中外围 1～2 圈；单位离开这个区域时失活，但在范围内部移动不受影响。工坊快捷生成会自动为当前编辑的地形添加这个中心标记。

```json
{
  "spatialPatterns": [{
    "id": "mod-outer-zone/outer-two-rings",
    "excludeStarts": true,
    "starts": { "op": "all", "items": [
      { "op": "terrain-has", "capabilityId": "mod/outer-zone/source" },
      { "op": "unit-team-is", "team": "other" }
    ] },
    "expression": {
      "op": "hex-range", "min": 1, "max": 2,
      "where": { "op": "cell-exists" }
    },
    "result": { "entity": "cell" }
  }],
  "rules": [{
    "id": "mod-outer-zone/exhaust-on-leave",
    "trigger": "unit-leave",
    "target": { "scope": "trigger-unit" },
    "conditions": [{
      "op": "crosses-pattern-boundary",
      "patternId": "mod-outer-zone/outer-two-rings",
      "direction": "leave"
    }],
    "effects": [{ "type": "exhaust-unit" }]
  }]
}
```

例如油田在 `packages/oil-field-mod/src/index.ts` 声明 `core/income-source` 的基础 `amount: 2`，同时声明可配置参数 `incomePerTurn`（整数 0～20）。地图码可选写入：

```json
"modSettings": { "mod-oil-field": { "incomePerTurn": 5 } }
```

地图值是默认值；房主可在准备房间覆盖。最终值由已安装 Mod 的设置架构验证后写进 `GameState.settings`，规则内核按地皮 ID + 能力 ID 查覆盖值。没有设置字段的旧地图继续采用 Mod 默认值。地图码只存声明式配置，不存可执行函数；公开上传的源码在工坊中也只作为文本预览，不自动运行。

对应源码：`packages/core-content/src/terrains.ts`、`packages/oil-field-mod/src/index.ts`、`packages/game-core/src/content.ts`、`packages/game-core/src/engine.ts`、`packages/core-content/src/map-code.ts`。
