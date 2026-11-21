# 前端组件目录与维护约定

页面由 `apps/web/src/routes` 装配。可交互界面在 `apps/web/src/components`，与页面无关的规则、计算和状态流程放在对应领域目录。

## 组件目录

| 入口 | 组件 | 负责的内容 |
| --- | --- | --- |
| `HomeRoute` | `HomeScreen` | 首页入口与布局 |
| `RoomsRoute` | `LobbyPanel` | 房间页签、成员、座位、棋子颜色、邀请及地图预览 |
| `LobbyPanel` | `LobbyRoomSettings` | 地图选择、友伤、随机座位和时间设置表单 |
| `LobbyPanel` | `LobbyModSettings` | 展示 Mod 默认值、地图默认值和房间覆盖值，提交设置变更 |
| `MapsRoute` | `MapLibrary`、`MapEditor` | 地图库导入与浏览、地图编辑草稿 |
| `MapEditor` | `MapEditorToolbar`、`MapTerrainIcon`、`MapEditorUnitIcon` | 编辑工具操作和地形、单位图标 |
| `WorkshopRoute` | `WorkshopPanel` | 工坊分类、列表、详情、订阅以及发布入口 |
| `WorkshopPanel` | `WorkshopTerrainEditor` | Mod 创建与更新表单、视觉和 JSON 编辑 |
| 工坊相关入口 | `TerrainModPreview`、`ConditionReferenceDialog` | 地块展示、条件语法参考 |
| 对局、预览、地图编辑 | `HexBoard` | Pixi 画布、图层、命中与相机 |
| 多个界面 | `NumberStepper`、`FullscreenControl` | 数值输入、全屏控制 |

## 状态归属

- `app/app-runtime.ts` 装配跨路由的连接和共享状态。路由从应用运行时获取页面所需的状态和动作。
- 大厅父组件管理页签、成员交互与地图上下文。设置子组件接收已确认的房间状态，经具名事件提出变更，服务端回包负责更新房间状态。
- 工坊父组件管理分类、详情和当前待编辑的作品。编辑器通过 `workshop/use-workshop-terrain-editor.ts` 持有表单草稿、资源处理和发布校验，经事件把已校验的发布载荷交回父组件。关闭发布界面后草稿随编辑器销毁，再次创建从默认值开始，再次更新从所选作品开始。
- 棋盘相关算法放在 `board/`，可脱离模板测试。对局规则使用共享的 `game-core`。
- `rooms/deferred-snapshot-cache.ts` 负责合并待发送的房主恢复快照，在浏览器绘制后写入，并为后台标签页提供定时回退。离开房间或卸载运行时会取消待写入的快照。

## 新增或调整组件

1. 按能够独立描述和测试的界面职责拆分。表单、卡片、页签、对话框和预览通常有明确边界。单个元素只有在存在复用或独立状态时才值得抽出。
2. 用类型化 props 接收数据，用具名 emits 返回用户动作。组件内部保存焦点、展开状态和编辑草稿，已确认的房间或服务器数据由上层更新。
3. 组件持有自己的 scoped 样式。父组件处理子组件外部的布局，子组件维护其内部排列、响应式规则和可访问性关系。拆分时保留根节点结构、键盘操作、ARIA 标识和媒体查询。
4. Vue 组件中保留模板、事件绑定和界面状态。纯转换、校验、协议处理及 Pixi 渲染辅助逻辑放在领域目录。能复用已有组件时，沿用它的事件和样式接口。
5. 新增组件后更新本表。验证 typecheck、现有测试及正式路径构建。移动模板或样式后检查桌面、手机横屏和手机竖屏，并检查焦点、滚动和浮层。

## 后续拆分

- `LobbyPanel` 的成员列表和地图预览是独立的后续拆分点。地图选择弹层与房间点击、Escape 关闭逻辑目前共享状态，抽出时应保留这些交互。
- `WorkshopTerrainEditor` 后续可按外观、能力配置和 JSON 编辑划分子区域。先明确草稿字段、上传生命周期和配置联动的边界，再抽出跨区逻辑。
- `MapEditor` 可沿现有草稿及工具栏边界继续拆分属性面板。 `HexBoard` 应优先按 Pixi 图层、输入和资源生命周期把代码迁入 `board/`。
- `app-runtime.ts` 后续可抽出房间会话与命令确认、个人地图同步、工坊目录加载。每块状态应有明确的启动与清理入口。
