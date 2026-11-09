# 昏晓 AI 训练：交给 AI 的执行清单

本文件只用于用户明确要启动昏晓 AI 试玩或训练时。若要恢复并启动整个《数字领主》游戏项目，请先用仓库根目录的 [`PROJECT_START_CHECKLIST.md`](PROJECT_START_CHECKLIST.md)。2026-11-09 训练主线已切换到健康的 Hex 空间模型；旧第 20 代仅保留为对照，不再原样启动旧 MLP 连续训练。依据和实测见[重新评估](docs/ai-training-reassessment-2026-11-08.md)。

## 已知状态

- 公开 Git 仓库：`https://github.com/ZVMAGL3/numeral_lord-next`
- 当前空间模型训练 seed：`experiments/hunxiao-ai/checkpoints/hunxiao-hex-healthy-seed-20261109.pt`（健康初版，尚未证明高手棋力）。
- 旧 MLP 试玩/评测基线：`experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt`。
- 权重基于“昏晓”固定地图和核心默认胜负规则。
- 历史棋谱、未完成的旧第 21 代数据和本机新运行目录不随仓库迁移。新设备从 Hex seed 重新采集新节点，不冒充恢复旧机的半成品批次。
- supervisor 默认每节点 100 局、训练、健康检查与换边评测；没有改善时转入复核，不自动无限增加弱样本。详见[自主训练说明](experiments/hunxiao-ai/AUTONOMOUS_TRAINING.md)。

## 给执行 AI 的任务

按顺序完成，遇到环境错误先修环境；不要下载或上传旧设备的 `runs/`，也不要覆盖第 20 代检查点。

1. 检查新机器的操作系统、内存和 GPU 型号。项目要求 Node.js 24+、Corepack/pnpm；训练设备需有可用的 PyTorch XPU 后端。当前连续训练脚本使用 `--device xpu`，若新机器不是 Intel Arc/XPU，先验证可用后端并调整设备参数，再启动训练。不要让不支持的后端进入长任务。

2. 克隆并拉取模型：

   ```powershell
   git lfs install
   git clone https://github.com/ZVMAGL3/numeral_lord-next.git
   Set-Location numeral_lord-next
   git lfs pull
   corepack pnpm install
   ```

3. 确认模型文件存在且 LFS 已下载实际文件，而不是文本指针：

   ```powershell
   Get-Item .\experiments\hunxiao-ai\checkpoints\hunxiao-iteration-20.pt
   Get-Item .\experiments\hunxiao-ai\checkpoints\hunxiao-hex-healthy-seed-20261109.pt
   git lfs ls-files
   ```

4. 检查 AI 环境并运行测试：

   ```powershell
   pnpm ai inspect
   pnpm ai:test
   pnpm ai:typecheck
   ```

5. 如果机器是 Intel Arc，按训练 README 建立 Python 3.12 XPU 环境并确认设备检测通过：

   ```powershell
   py -3.12 -m venv experiments/hunxiao-ai/.venv
   experiments/hunxiao-ai/.venv/Scripts/python.exe -m pip install -r experiments/hunxiao-ai/python/requirements-xpu.txt
   experiments/hunxiao-ai/.venv/Scripts/python.exe experiments/hunxiao-ai/python/environment_check.py
   ```

   其他 GPU 请先配置对应 PyTorch 后端，并确认训练脚本中的 `--device` 与该后端匹配。若没有可用 GPU，可用 CPU 做短测试；完整训练可能会很慢。

6. 可先启动旧第 20 代基线试玩页。此命令的 MLP 页面不是新 Hex 模型的棋力验证：

   ```powershell
   pnpm ai play `
     --checkpoint experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt `
     --device xpu --simulations 16 --think-ms 100 --port 8060
   ```

   浏览器打开 `http://127.0.0.1:8060/`。CPU 试玩时将 `--device xpu` 改成 `--device cpu`。

7. 确认第 2–5 步通过、XPU 正常且没有另一条训练任务后，从新 Hex seed 启动独立 supervisor；默认 8 个 worker，不再启动旧 `train-continuous.ps1`：

   ```powershell
   experiments/hunxiao-ai/.venv/Scripts/python.exe -u experiments/hunxiao-ai/python/train_autonomous.py --run-root experiments/hunxiao-ai/runs/spatial-autonomous-local --checkpoint experiments/hunxiao-ai/checkpoints/hunxiao-hex-healthy-seed-20261109.pt
   ```

   这是独立的本地循环，按健康检查和预声明的小规模评测选择冠军，旧权重与候选分开保存。启动前检查内存；停止、恢复、REVIEW_REQUIRED 状态见自主训练说明。Codex 定时分析任务需要在新设备另行配置；本地 supervisor 不依赖聊天额度。

8. 把启动结果回报给用户：GPU/后端、检查点路径、测试结果、训练 PID、当前代数和输出目录。不要公开 `.env`、访问令牌或其他本机凭据。

## 已知限制

本次备份不包含旧局棋谱和训练对局列表；那些内容只在旧设备的 `experiments/hunxiao-ai/runs/` 中。新训练生成的棋谱会写入新设备本地 `runs/`，不会自动上传公网。
