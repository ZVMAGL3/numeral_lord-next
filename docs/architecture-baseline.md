# 架构基线

## 已确认的产品规则

- 棋盘维持旧版的六边形网格和单格单棋子规则。
- 玩家严格按座位编号依次行动；队伍只绑定胜负关系。
- 默认关闭友伤；地图可显式开启 `friendlyFire`，让同队单位成为合法攻击目标。
- 每位玩家的回合固定为“行动 → 加点”两阶段：手动结束或所有单位都无合法行动时进入加点；点数耗尽时自动轮到下一座位，仍可手动提前结束并保留未使用点数。
- 地图和 Mod 可以使用受 SDK 约束的 TypeScript 代码定义内容与规则，默认视为可信。

## 对局一致性

客户端提交的是命令（如 `move-unit`、`end-action-phase` 或 `end-reinforcement-phase`），绝不提交“修改后的完整棋盘”。规则和状态计算仍由共享的 `game-core` 在本地执行。

当前 PvP 中继模式的流程是：

1. 客户端以共享的 `game-core` 立即执行命令并渲染。
2. 非房主只把 `player-intent` 发给房主；房主在自己的规则内核中执行后广播 `host-snapshot`。
3. 非房主收到快照后覆盖本地对局状态；发生冲突时以房主快照为准。

这样可以保留本地即时响应，同时把服务端缩减为房间、账户席位、断线重连和数据传输。`apps/server` 仍导出 `validateIntent`，用于将来需要反作弊或权威部署时复用，但当前中继房间不会调用它。

## 棋谱与续选结果

本地原型使用三元坐标记谱：`[行, 列, 点击次数]`。一次成功的移动或攻击会记录用户真实点击的格：手动选中的源格为 `1`、目标格为 `1`；动作后的自动续选不是点击，不记源格。因此试选、取消选择、自动续选和非法点击都不记录。加点时，连续对同一格的实际投入合并为一条，第三项就是累计投入次数。`[-1,-1,-1]` 与 `[-1,-1,-2]` 分别是结束行动和结束加点。

规则动作还返回独立的 `continuation`（`unitId` 和 `cellId`）。客户端只有在该单位仍有合法行动时才自动续选。这个字段不能由“行动目标”推断：例如日后的大炮可以攻击目标格，却继续选中原地单位。

## 不使用地形继承链

海洋、平原、据点和油田都是地形定义；它们由能力模块组合，而不是相互继承。单位默认是“游兵”状态，供电网络计算后才派生为“通电兵”。山地与虚无在规则内核中都是不可驻兵格，只允许有不同的美术表现，不参与额外的进入条件判断。

| 地形 | 能力模块 | 收益规则 |
| --- | --- | --- |
| 海洋 | `occupiable` | 无 |
| 平原 | `occupiable`、`power-conductor` | 无 |
| 据点 | `occupiable`、`power-conductor`、`power-source`、`adjacent-hostile-exhaustion` | 本身不产点；为连接单位供电 |
| 油田（可选 `mod-oil-field`） | `occupiable`、`income-source`、`departure-garrison` | 任意己方占据单位：2 点/回合；离开时留下 1 点游兵 |

移动只有一条全局规则：单位必须绑定在带有 `occupiable` 的格子；缺少该能力的山地、虚无等格子一律不能进入。`power-network` 是公共规则模块：它读取地形的 `power-conductor`、`power-source` 和单位的供电接收能力，计算连接结果。`powered` 与 `roaming` 是派生状态，不作为独立兵种存档。`adjacent-hostile-exhaustion` 是另一套独立规则：被占据据点的六个相邻格会令非同队、刚完成移动或近战攻击并落入该范围的单位在本回合耗尽行动力；据点格自身不受此效果影响。

示例地图码维护在 `packages/core-content/src/legacy-demo-map.ts`：地形使用旧版 `map.js` 的行优先字符串（`M/P/S/O/F/V`，其中 `F` 是可选 Mod 提供的油田），兵力使用 `[格索引, 玩家序号, 兵力]` 数组。`demo-match.ts` 只负责把这份数据转换为通用 `GameState`，并显式安装演示需要的 Mod，因此以后新增地图只需要增加数据和装配目录，不需要改引擎或 Vue 组件。

收益也不再绑死在据点：`core/powered-income` 是单位能力，`core/roamer` 配置为每个通电单位在拥有者行动回合开始时产生 1 点；油田继续以地形的 `income-source` 独立提供 2 点。油田刻意不带 `power-conductor`，因此其中的单位始终不因油田而通电；其 `core/departure-garrison` 则在占据者离开时生成一名 1 点 `core/roamer`，并立即把该留守兵写入本回合的 `turn.exhaustedUnitIds`。行动过程中占领、断电或失去单位只影响下一次该玩家行动开始时的结算，不能改写本回合已经拿到的点数。

## 单位战斗能力组合

兵种同样不使用继承。当前核心包将以下离散能力挂到 `core/roamer`：

| 能力 | 独立职责 |
| --- | --- |
| `core/move` | 可移动距离；只能落在空的可驻兵格。 |
| `core/attack` | 是否可主动攻击，以及攻击成功后是否进入目标格。 |
| `core/attack-range` | 最小、最大攻击距离；可与移动距离不同。 |
| `core/counterattack` | 受到攻击后是否可以反击。 |
| `core/counterattack-limit` | 每个行动阶段最多反击次数。 |
| `core/action-strength-decay` | 行动后的兵力变化；基础游兵为减 1、最低保留 1，若行动前已是 1 则在动作完成后本回合失活。 |
| `core/exhaust-after-attack` | 攻击完成后让该单位本回合失活；基础游兵拥有此能力，通电状态由引擎跳过该规则。 |
| `core/powered-action-threshold` | 通电状态下可行动的最小兵力；基础游兵为 2，因此通电 1 点兵不可移动或攻击。 |
| `core/powered-income` | 通电状态下每回合产生的点数；基础游兵为 1。 |

这些能力由规则内核在命令结算中统一处理，而不是由 Vue 的选中状态处理。游兵攻击后的失活只由 `core/exhaust-after-attack` 触发；通电兵可以继续攻击。无论单位是否通电，只要完成移动或近战攻击后落在“已占据敌方据点”的六邻格，`core/adjacent-hostile-exhaustion` 优先写入同一个 `turn.exhaustedUnitIds`；空据点、友方据点和据点自身所在格都不会触发。这个数组是每个行动阶段自动清空的权威状态，因此 AI、回放、浏览器预测和 Node 服务端得到完全相同的“能否继续行动”结果。

合法目标由移动目标和攻击目标合并计算：关闭友伤时，同队单位不会被列为攻击目标，也会被引擎再次拒绝。远程单位可把 `core/attack.movesIntoTarget` 设为 `false`，从而攻击后仍留在原格；因此自动续选由动作结果的 `continuation` 决定，而非攻击目标坐标。

## Node、服务端与 AI 边界

`game-core` 不依赖 Vue、Pixi、DOM、网络或真实时间。它提供两种调用入口：网页开发使用源码入口；Node 服务端、模拟器和训练任务使用编译后的 `@numeral-lord/game-core/node`。两者执行同一套规则。

AI 不需要驱动页面：给定可 JSON 序列化的 `GameState`，调用 `getLegalIntents(state, terrains, units)` 获得当前动作空间；策略选出一个 `GameIntent` 后，用 `applyIntent(state, intent, commandId, terrains, units)` 获得与前端预测、服务端校验相同的结果状态和事件。地图夹具也放在 `core-content`，不再位于网页目录。

## Mod 运行边界

Mod 以有版本号和内容哈希的 TypeScript 包发布。地图固定其依赖的 Mod 版本；服务器只加载与该地图锁定的版本。

Mod 能声明地形、兵种、能力、命令处理器、触发器和胜利条件；规则处理器只能读取规则上下文并发出受类型约束的事件。它不可访问网络、文件系统、真实时间或未注入的随机数，以保证回放和服务端复算保持确定。

即使默认可信，Mod 仍将在独立 Worker 执行单个规则步骤，以便终止超时、异常或内存失控的 Mod，而不影响整个对局服务。
