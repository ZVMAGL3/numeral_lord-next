# 跨设备备份与恢复

公开源码仓库：<https://github.com/ZVMAGL3/numeral_lord-next>

Git 中保存完整源码、规则、AI 训练代码、配置说明和当前模型检查点。当前检查点是第 20 代 `iteration-20.pt`，作为测试和续训起点；它通过 Git LFS 管理，约 2.1 MB。新设备克隆后执行 `git lfs pull` 即可取回模型。

约 35 GiB 的历史自博弈样本、逐局棋谱、旧检查点和运行日志不进入公网备份。这些文件已被本机 `runs/` 忽略，既不是运行游戏所必需，也不是从当前模型继续自博弈训练所必需。新设备会从第 20 代权重重新开始第 21 代自博弈，因此不会依赖旧设备尚未完成的第 21 代数据。训练局列表和旧棋谱也不会随本次代码与模型备份出现在新设备上。

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

可直接交给新设备 AI 执行的测试、设备检测、试玩与续训步骤见 [`AI_START_CHECKLIST.md`](AI_START_CHECKLIST.md)。XPU/PyTorch 环境安装说明见 [`experiments/hunxiao-ai/README.md`](experiments/hunxiao-ai/README.md)。连续训练默认使用 16 个 worker，可按新机器内存通过 `-Workers` 调整。`node_modules/`、Python `.venv/`、私密 `.env` 和本机数据库不公开；依赖目录可按 README 在新设备重建，私密配置需要单独设置。
