# 胜负模块与断电结算

已实现：地图可选胜负模块，浏览器、Node 服务端和 AI 的 `applyIntent` 共用同一内核。

## 地图配置

`settings.matchConditionIds` 是要启用的模块 ID 列表。省略时默认启用 `core/last-team-standing`；空数组表示不启用胜负条件。

- `core/last-team-standing`：场上仅剩一个队伍时结束对局；没有单位存活时也结束。
- `core/lose-all-survival-anchors`：玩家没有任何被自己单位占据的生存据点时，其余单位全部阵亡。仅清除该玩家的军队，队友仍可继续战斗。

演示地图已启用以上两个模块。新地图应为每位玩家安排初始据点，否则启用第二个模块后，该玩家开局就会被淘汰。

## 据点与供电

地形能力 `core/survival-anchor` 表示生存据点，独立于 `core/power-source` 发电能力。普通据点同时选择两者；未来的发电站可以只选择发电能力。

断电遵循旧版 `src/store/map.js` 的规则：只有单位被消灭、导致供电网络出现断点时，才从断点周围的己方通电单位开始遍历受影响连通块；能重新连到据点的分支不处理，无法连到据点的分支立即减 1 点，原本只有 1 点则直接阵亡。移动、加点和结束回合不会无条件重扫整张地图，持续处于断电状态也不会重复扣点。

## 编写模块

实现 `MatchConditionModule.evaluate(state, terrains)`，返回 `eliminatePlayerIds`（淘汰哪些玩家）或 `finish`（获胜队伍与结束消息）。命中 `finish` 后，内核会把 `winningTeamIds` 和消息持久化到 `GameState.result`，并将 `turn.phase` 改为 `finished`；所以前端、服务端和 AI 都能读取同一份结算结果。模块不应修改输入状态，也不应依赖页面、时间或随机外部数据。

将模块放入 `MatchConditionCatalog`，通过 `startMatch`、`applyCommand` 或 `applyIntent` 的最后一个参数传入；地图用 ID 选择模块。内容包示例在 `packages/core-content/src/match-conditions.ts`。

内核先应用淘汰效果，再判断胜负。客户端必须与服务器、AI 使用相同的模块目录和地图配置。未注册的模块 ID 会报错，避免静默漏掉规则。
