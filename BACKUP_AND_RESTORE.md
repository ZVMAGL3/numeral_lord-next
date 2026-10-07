# 跨设备备份与恢复

公开的完整项目仓库：<https://github.com/ZVMAGL3/numeral_lord-next>

Git 中保存整个《数字领主》项目：Vue/PixiJS 前端、Colyseus 房间中继服务、共享游戏规则与 SDK、核心内容和 Mod、网页图片资源、部署脚本、测试、项目文档，以及昏晓 AI 训练代码。当前 AI 检查点是第 20 代 `iteration-20.pt`，作为试玩和续训起点；它通过 Git LFS 管理，约 2.1 MB。新设备克隆后执行 `git lfs pull` 即可取回模型。

约 35 GiB 的历史自博弈样本、逐局棋谱、旧检查点和运行日志不进入公网备份。这些文件已被本机 `runs/` 忽略，既不是运行游戏所必需，也不是从当前模型继续自博弈训练所必需。新设备会从第 20 代权重重新开始第 21 代自博弈，因此不会依赖旧设备尚未完成的第 21 代数据。训练局列表和旧棋谱也不会随本次代码与模型备份出现在新设备上。

本机依赖目录、构建产物、`.env`、`apps/server/data/` 中的 SQLite/工坊运行数据，以及浏览器本地保存的个人地图和订阅不在公开 Git 备份里。新设备可按项目清单重新安装依赖并启动前后端；本地 SQLite 会重新创建。线上房间/工坊数据库仍由已部署的服务管理，不会因为克隆仓库而迁移或覆盖。

## 新设备恢复

需要 Git、Git LFS、Node.js 24 或更新版本，以及 Corepack/pnpm。运行：

```powershell
git lfs install
git clone https://github.com/ZVMAGL3/numeral_lord-next.git
Set-Location numeral_lord-next
git lfs pull
corepack pnpm install
```

源码和模型路径：

```text
experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt
```

完整游戏项目的启动步骤见 [`PROJECT_START_CHECKLIST.md`](PROJECT_START_CHECKLIST.md)。AI 训练、设备检测、试玩与续训步骤见 [`AI_START_CHECKLIST.md`](AI_START_CHECKLIST.md)。XPU/PyTorch 环境安装说明见 [`experiments/hunxiao-ai/README.md`](experiments/hunxiao-ai/README.md)。连续训练默认使用 16 个 worker，可按新机器内存通过 `-Workers` 调整。
