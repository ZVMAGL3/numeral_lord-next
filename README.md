# Numeral Lord Next

新版多人六边形战棋平台。项目采用 TypeScript 单仓库：客户端负责本地即时规则与渲染，服务端负责账户/房间、席位、断线重连和低延迟数据中继；联网对局由房主广播权威快照。

## 工作区

- `apps/web`：Vue 用户界面与 PixiJS 棋盘渲染器。
- `apps/server`：账户/房间、匹配、席位、断线重连和房主权威快照中继。
- `packages/game-core`：不依赖框架或网络的确定性规则内核。
- `packages/game-sdk`：地图与 Mod 作者使用的稳定扩展 API。
- `packages/content-schema`：内容包、地图和资源清单的校验模型。
- `docs`：游戏规则和架构决策。

详细边界见 [架构基线](docs/architecture-baseline.md)。
当前阿里云中继的目录、服务和测试入口见 [部署说明](docs/deployment.md)。

## 本地运行

```powershell
corepack pnpm install
corepack pnpm dev:web
```

打开 `http://127.0.0.1:5173/`。当前页面是可点击的规则原型：包含移动、基础攻击、据点封锁、供电、通电单位/油田收益、点数强化与自动或主动的阶段推进。页面默认连接本机 `:2567` 的 Colyseus 中继；服务端未启动时仍可离线操作。

规则包不依赖页面：浏览器使用 `@numeral-lord/game-core`，Node 服务端或训练程序使用编译后的 `@numeral-lord/game-core/node`。房主客户端和 AI 模拟调用同一套状态与命令规则；当前 PvP 中继只传递命令与房主快照，不在服务端重复校验对局规则。

油田不是核心地形，而是 `packages/oil-field-mod/` 中的可选 Mod；如何在地图装配时安装它，以及如何照此新增自己的 Mod，见 [Mod 示例](docs/mod-example.md)。

## PvP / Mod 联调准备

当前页面已能无网络地验证规则和 Mod 视觉效果，也可以启动 `apps/server` 后用两个浏览器标签加入同一个 PvP 房间。远程联调可在地址后加 `?relay=ws://服务器:2567`；非房主提交命令，房主本地执行后广播快照，冲突以房主快照为准。Mod 测试只需把 Mod 的 catalog 在地图装配时合并进去，规则内核和 AI 不需要绑定 Vue。
