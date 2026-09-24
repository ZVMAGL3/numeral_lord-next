# 地皮、能力与规则触发点

地皮不是 JS 类继承树。一个地图格只保存 `terrainId`；该 ID 在运行时内容目录里找到 `{ id, displayName, capabilities }`。例如平原有“可驻兵、导电”，海洋有“可驻兵、离开海洋后失活”，据点在平原常见能力之外另带供电、生存锚点和邻格封锁；山地/虚无都不带“可驻兵”，规则上都不能进入。油田在独立的 `@numeral-lord/oil-field-mod` 包里，而非核心地形包。

目前没有让 Mod 随意执行代码的通用 `onEnter`/`onLeave` 回调总线。`game-core` 是浏览器、Node 服务和将来无界面 AI 共用的纯规则内核：它在固定结算节点读取能力 ID 与配置，再产生新状态。Vue 只负责显示和点击，不能独自决定规则。当前触发顺序是：

1. 移动/攻击前验证玩家、行动阶段、单位能力、目标地形是否 `core/occupiable`，再检查点数和范围。
2. 离开原格时读取 `core/departure-garrison`。油田要求留 1 点驻兵，留下的兵本回合失活；不够留下时不能离开。海洋的 `core/exhaust-on-departure` 在移到非海洋后令行动单位失活。
3. 落到目标格后，内核读取地图加载时编译好的 `GameState.cellTriggers[targetCell].enter` 列表，逐项检查所有关联源格。一个格周围可以同时关联多个据点：空据点和同队据点跳过，仍会继续检查后续来源，直到确认是否有敌方已占据据点。因此据点被夺取、清空或同队占领时结果会立即跟着当前棋盘变化，不会把占领者/旧占领者写死在地图元数据里。该失活优先于普通的点数不足/离开地形失活。
4. 攻击结算时单位要有 `core/counterattack` 才能反击，随后读取防守者脚下地皮的 `core/counterattack-terrain-limit`：平原/海洋每个进攻玩家行动阶段一次，据点无限，油田零次。已用次数在进攻方的加点阶段保留，轮到下个玩家行动时清零；已失去行动力的防守单位不能反击。只有当前玩家选中的攻击单位，其合法攻击目标会显示红/白框；联网时这个临时选中状态由房间转发，因此房主和玩家看到相同提示。它不进入棋局状态、存档或棋谱，行动结算后清除。
5. 通电兵离开原格时按规则留 1 点驻兵；这个留兵不是给攻击增加兵力，也不是结算后返还点数。以 5 点通电兵攻击 7 点防守兵为例，攻击结算使用移动后的 4 点：攻击未能击破防守方，防守方按这 4 点损失后剩 3 点；若防守方本次仍能反击，就消耗反击次数并消灭攻击方，因此原格也不会留下那 1 点驻兵。若防守方不能反击，攻击方留在原格失去行动力，防守方仍按 4 点损失兵力。通电兵攻击成功占领时，才会在原格留下 1 点驻兵。这样先诱骗掉平原/海洋的有限反击后，后续攻击不会再触发该地块本回合的反击。
6. 每位玩家**行动回合开始**时读取单位的通电收益和驻守地皮的 `core/income-source`，只计算一次。油田不导电，但可独立产生收益。

| 想表达的“事件” | 目前的声明方式 | 实际执行位置 |
| --- | --- | --- |
| 能否进入格 | 地皮有无 `core/occupiable` | `getLegalActionDestinationIds` 与 `moveUnit` |
| 离开油田留兵 | 油田挂 `core/departure-garrison`，配置留兵强度和兵种 | `leaveDepartureGarrison` |
| 离开海洋失活 | 海洋挂 `core/exhaust-on-departure`，可配置目标地形例外 | `applyDepartureExhaustion` |
| 进入据点周围失活 | 地图装载时把据点与六邻格编译到目标格的 `enter` 触发列表；每项保存来源格 ID 与关系 ID | `applyAdjacentHostileExhaustion` 遍历到达格全部 `enter` 关联，读取当前占据者和队伍 |
| 被攻击时反击 | 单位挂 `core/counterattack`，地皮挂反击次数上限；红/白框只标注当前所选攻击者可攻击的单位目标 | `applyCounterattack`；联网框提示经房间转发，行动状态仍只由房主快照同步 |
| 回合开始收入 | 单位 `core/powered-income` 或地皮 `core/income-source` | `grantReinforcementIncome` |

格子触发是静态拓扑，分为 `enter` 与 `leave` 两个列表；同一格可保存任意多个关联，不会因多个据点相邻而覆盖。地图码可用可选 `cellLinks: [{ trigger, source, target, relationId }]` 声明任意两格的有向关联：`trigger: "enter"` 把关系挂在目标格进入触发上，`trigger: "leave"` 把关系挂在源格离开触发上；格子序号为从 0 开始的行优先索引。据点关系由地形能力自动生成，海洋离开失活和油田离开留兵则编译进来源格的 `leave` 触发列表。链接本身不等于行为：`relationId` 仍需由共享规则内核/已加载规则模块解释。这样可以把棋盘拓扑和规则语义分开，为传送点、供能点、警戒区等关系复用同一套索引。

这里的 `GameEvent` 只是命令执行后返回的结果通知（例如“单位失活”），**不是**给 Mod 注册任意回调的 `onEnter`/`onLeave` 接口。新增地皮若只需要已有能力，新增内容包和配置即可；若需要全新的触发时机，仍须先在共享内核定义这个时机与输入/输出契约，再让 Mod 声明如何使用。这样 Node、浏览器和将来的 AI 才会执行同一条规则。

目前 `core/power-source` 的“被占据才供电”和 `core/adjacent-hostile-exhaustion` 的“六邻格、非同队、占据才封锁”是**能力的固定语义**，不是能在地图码里随意改的参数；源码已去掉以前写了但引擎不读取的半径等伪配置。真正开放且被引擎读取的地皮参数，例如油田收益 `amount`，才会声明为 Mod setting 并可供地图作者、房主配置。

例如油田在 `packages/oil-field-mod/src/index.ts` 声明 `core/income-source` 的基础 `amount: 2`，同时声明可配置参数 `incomePerTurn`（整数 0～20）。地图码可选写入：

```json
"modSettings": { "mod-oil-field": { "incomePerTurn": 5 } }
```

地图值是默认值；房主可在准备房间覆盖。最终值由已安装 Mod 的设置架构验证后写进 `GameState.settings`，规则内核按地皮 ID + 能力 ID 查覆盖值。没有设置字段的旧地图继续采用 Mod 默认值。地图码只存声明式配置，不存可执行函数；公开上传的源码在工坊中也只作为文本预览，不自动运行。

对应源码：`packages/core-content/src/terrains.ts`、`packages/oil-field-mod/src/index.ts`、`packages/game-core/src/content.ts`、`packages/game-core/src/engine.ts`、`packages/core-content/src/map-code.ts`。
