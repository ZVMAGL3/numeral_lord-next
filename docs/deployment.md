# 当前部署说明

## 公网路径

- 游戏页面：`http://39.107.250.161/numeral-lord-play/`
- 中继健康检查：`http://39.107.250.161/numeral-lord/`
- 本地网页连接公网中继：`http://127.0.0.1:5173/?relay=ws://39.107.250.161/numeral-lord`

默认地址显示简洁主页：玩家名字，以及“联机大厅”“地图配置”两个同级入口，没有地图预览。首次访问会随机生成名字并保存在浏览器 `localStorage`；选择“联机大厅”后进入“创建新房间 / 输入房间号加入”页面。地图库和准备房间仍展示地图预览。邀请链接在页面地址上附加 `?room=房间号`，会直接加入指定房间；若已经开局则以观战者身份同步当前快照。刷新时以本机保存的账户标识接管原成员，保留座位，不新增同名观战者。

本版房间功能已于 2026-09-23 部署到上述公网路径。后续代码或文档变更仍需重新发布服务端源码和网页 `dist` 才会生效。

## 服务器布局

- 系统：Debian 12。
- 独立运行时：`/opt/numeral-lord-runtime/current`，当前为 Node 24.21.0、pnpm 12.5.1，不修改服务器已有的 Node 20 环境。
- 项目目录：`/opt/numeral-lord-next`。
- systemd 服务：`numeral-lord.service`，启用开机自启和失败重启。
- Colyseus 只监听 `127.0.0.1:2567`，不直接暴露内部端口。
- Nginx `/numeral-lord/` 转发 HTTP、匹配请求与 WebSocket；`/numeral-lord-play/` 以 alias 提供 `apps/web/dist/`。

后端维护创建/房间号加入、准备房间、地图位与观战成员、房主身份、断线窗口和消息传输。地图玩家位限制参战者数量，不限制观战者；当前服务端的 64 连接安全上限是传输保护，不是可配置房间人数。开始对局后加入的连接只能观战。

玩家名字是浏览器本地偏好，不是正式账户资料；客户端加入房间时将其作为成员显示名发送给中继。准备房间的地图预览复用真实 `HexBoard` 与初始 `GameState`，是不可操作的紧凑渲染，不需要额外部署截图文件。

个人地图在当前浏览器本机保存为版本化地图码；地图配置以预览卡片展示，支持地图码导入和可视化编辑。已安装 Mod 的结构化对象与订阅版本保存在浏览器 IndexedDB；打开创意工坊或进入战斗大厅/准备房间时检查订阅 Mod 更新，普通首页不建立工坊连接；准备阶段下载更新时会要求本机重新准备，且更新不会在对局中途应用。当前没有登录账户，因此订阅记录不会跨浏览器/设备同步；普通个人地图不会写入服务端数据库，只有用户主动发布的作品才进入创意工坊数据库。

棋盘规则仍由无界面的 `game-core` 在房主客户端执行。服务端把命令绑定到发送者实际占用的地图位，只接受房主快照；冲突时以房主为准。

## 网页子路径与贴图

公网网页不是部署在站点根目录，必须用专用脚本构建：

```bash
corepack pnpm --filter @numeral-lord/web build:deploy
```

该命令向 Vite 传入 `--base=/numeral-lord-play/`。JS/CSS 入口和 `public/legacy` 中的棋盘贴图都必须遵循这个 base：运行时地址应为 `/numeral-lord-play/legacy/TS0.png`、`/numeral-lord-play/legacy/TS_Water.png` 等，而不是 `/legacy/…`。网页通过 `import.meta.env.BASE_URL` 拼接贴图地址，所以同一代码既能在本地根路径运行，也能部署到上述子路径。

发布前至少检查：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm --filter @numeral-lord/web build:deploy
```

然后确认 `apps/web/dist/index.html` 和 `apps/web/dist/legacy/` 同时存在。部署后在浏览器网络面板检查页面资源与贴图均从 `/numeral-lord-play/` 返回 200。

## 创意工坊地块图片

地块 Mod 的图片以内容哈希文件保存在 `apps/server/data/workshop/assets/terrain/`；PostgreSQL 发布记录只保存相对资源 URL，不保存 Base64 图片。工坊列表和预览消息只传递正在展示地块引用的图片地址，浏览器通过中继同源 HTTP 路由 `/numeral-lord/assets/terrain/<sha256>.png`（或 `.webp`、`.svg`）单独加载，响应带一年期 immutable 缓存。完整 Mod 详情同样只返回图片地址，客户端下载各图后再写入本机 IndexedDB 所需的格式。图片由 Mod 作者在作品中上传，服务端校验后保存文件并将相对 URL 写入对应数据库记录；工坊启动流程不再从仓库文件清单推断或播种 Mod 预览图。

服务更新会保留 `apps/server/data/`，因此已发布图片与数据库记录一起留存。服务器启动时会把旧记录中内嵌的 Base64 图片一次性写到内容哈希文件并将数据库记录改为 URL；若检查存储或迁移故障，应先修复存储访问问题，不要清空作品记录。

地块外观属于作者发布的 Mod 定义，工坊启动与数据库迁移不得推断图片用途、改写既有定义或自动创建新 Mod 版本。服务启动前会完成必要的数据库结构和资源存储初始化；只有格式迁移可以转换存储表示，不能改变规则、视觉层级或版本号。需要更改地块外观时，由作者在工坊编辑并明确发布新版本。准备房间会要求参战客户端使用房主所选的 Mod 版本及对应内容指纹，缺少指纹也不能开始对局。

## 运维命令

```bash
systemctl status numeral-lord.service
journalctl -u numeral-lord.service -f
systemctl restart numeral-lord.service
curl http://127.0.0.1:2567/
nginx -t
```

仓库中的 `deploy/install-server.sh` 校验并安装独立 Node 运行时、依赖和 systemd 服务；`deploy/configure-nginx.sh` 以可回滚方式添加 Nginx 路由。网页产物仍需先按上一节使用 `build:deploy` 构建并随发布内容放入 `apps/web/dist/`。

## 当前边界

已实现本地持久名字、临时访客、创建房间、房间号加入、真实地图预览、准备/位置分配、晚加入观战、基础断线重连、友伤和本地计时控制。创意工坊数据已使用 PostgreSQL 持久化；正式账户、对局状态/棋谱持久化、战绩、HTTPS/WSS 和域名仍未接入。公网长期使用前应补上 HTTPS/WSS，并轮换曾通过聊天传递过的服务器密码。
