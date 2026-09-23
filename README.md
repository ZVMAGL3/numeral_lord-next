# Numeral Lord Next

新版多人六边形战棋平台。项目采用 TypeScript 单仓库：客户端负责本地即时预测与渲染，服务端负责重放同一套规则、校验并提交权威事件。

## 工作区

- `apps/web`：Vue 用户界面与 PixiJS 棋盘渲染器。
- `apps/server`：房间、匹配、断线重连和权威规则校验。
- `packages/game-core`：不依赖框架或网络的确定性规则内核。
- `packages/game-sdk`：地图与 Mod 作者使用的稳定扩展 API。
- `packages/content-schema`：内容包、地图和资源清单的校验模型。
- `docs`：游戏规则和架构决策。

详细边界见 [架构基线](docs/architecture-baseline.md)。

## 本地运行

```powershell
corepack pnpm install
corepack pnpm dev:web
```

打开 `http://127.0.0.1:5173/`。当前页面是可点击的本地规则原型：包含移动、基础攻击、据点封锁、供电、通电单位/油田收益、点数强化与自动或主动的阶段推进；它尚未连接联机服务端。

规则包不依赖页面：浏览器使用 `@numeral-lord/game-core`，Node 服务端或训练程序使用编译后的 `@numeral-lord/game-core/node`。前端预测、服务端校验和 AI 模拟均调用相同的状态与命令规则。
