# 数字领主完整项目：新设备启动清单

把本文件交给新设备上的 AI，要求它在本机恢复并启动整个《数字领主》项目，而不是只启动昏晓 AI 训练。按步骤执行，遇到错误先定位并修复；不要删除旧目录、数据库或其他进程，也不要把本地数据上传到公开仓库。

## 项目内容

这是完整的 pnpm 单仓库，公开 Git 仓库包含：

- `apps/web`：Vue、PixiJS 网页客户端、地图编辑器、联机大厅和创意工坊界面。
- `apps/server`：Colyseus 房间中继服务和创意工坊 API/存储。
- `packages/`：共享规则内核、SDK、地图/Mod 内容、校验和示例 Mod。
- `docs/`、`deploy/`：产品/架构文档和服务器部署脚本。
- `experiments/hunxiao-ai`：昏晓 AI 训练与试玩工具，以及第 20 代模型检查点。

本清单的目标是先启动网页和本地中继。AI 训练是可选任务，用户要求时再按 [`AI_START_CHECKLIST.md`](AI_START_CHECKLIST.md) 启动。

## 1. 检查工具

需要 Git、Git LFS、Node.js 24 或更新版本，以及 Corepack/pnpm。先检查：

```powershell
git --version
git lfs version
node --version
corepack --version
```

如果 `git lfs` 不可用，先安装 Git LFS 并执行 `git lfs install`。Node 主版本低于 24 时，先安装兼容版本，不要尝试降级项目依赖。

## 2. 克隆完整仓库

在准备好的工作目录中执行。若 `numeral_lord-next` 目录已经存在，先检查其 Git 状态和内容，不要覆盖或删除：

```powershell
git lfs install
git clone https://github.com/ZVMAGL3/numeral_lord-next.git
Set-Location numeral_lord-next
git lfs pull
corepack pnpm install --frozen-lockfile
```

检查当前版本与模型文件：

```powershell
git status --short
git lfs ls-files
Get-Item .\experiments\hunxiao-ai\checkpoints\hunxiao-iteration-20.pt
```

`apps/web/public/` 的贴图、源码、地图/Mod 示例和文档都在普通 Git 文件中；LFS 只用于 AI 检查点。

## 3. 验证整个项目

在仓库根目录运行：

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

这些命令覆盖工作区的前端、服务端、规则包和共享内容。记录任何失败的包和错误，修好后再启动，不要把单个 AI 测试通过当作整个项目验证通过。

## 4. 启动本地联机游戏

打开两个 PowerShell 终端，工作目录都设为仓库根目录。

终端一启动本地房间中继服务（默认端口 `2567`）：

```powershell
corepack pnpm dev:server
```

终端二启动网页客户端（Vite 默认端口 `5173`）：

```powershell
corepack pnpm dev:web
```

浏览器打开 `http://127.0.0.1:5173/`。本地网页默认连接本机 `2567` 中继；服务端本地数据库会在 `apps/server/data/` 下创建。检查网页能加载、联机大厅能连接，并用两个浏览器标签页创建/加入测试房间；不要连接或改动线上数据库。

## 5. 本机数据与线上服务边界

- 本地开发默认使用 SQLite，首次启动会创建新的本机数据库。公开仓库不含旧设备的 `apps/server/data/`。
- 个人地图、玩家名和 Mod 订阅保存在浏览器本机存储中，不会随 Git 克隆迁移。
- 当前线上房间和创意工坊数据库由既有服务器管理；本机启动的服务使用本机存储，不会自动连线上数据库。
- `.env`、数据库、训练棋谱、`node_modules/`、构建产物和 Python 虚拟环境均不公开。不要把凭据写入仓库。
- 这份清单启动本地开发版本，不会部署或覆盖公网服务。公网发布需另按 [`docs/deployment.md`](docs/deployment.md) 执行。

## 6. 启动结果回报

完成后向用户报告：克隆路径和 Git 提交、Node/pnpm 版本、全仓库检查结果、网页和中继的运行状态/端口，以及尚未解决的问题。若用户还要启动 AI，再单独按 [`AI_START_CHECKLIST.md`](AI_START_CHECKLIST.md) 操作；第 21 代训练会从第 20 代检查点重新开始，不会恢复旧机器的历史棋谱或半成品批次。
