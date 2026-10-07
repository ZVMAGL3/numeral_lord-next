# 新设备启动昏晓 AI：交给 AI 的执行清单

把本文件交给新设备上的 AI，并让它按清单执行。目标是恢复当前模型、先验证能运行，再从第 20 代权重重新开始第 21 代自博弈训练。

## 已知状态

- 公开 Git 仓库：`https://github.com/ZVMAGL3/numeral_lord-next`
- 当前可试玩、可续训权重：`experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt`
- 权重基于“昏晓”固定地图和核心默认胜负规则。
- 旧设备当时正在采集第 21 代数据；这批未完成的局面、棋谱和所有历史训练数据都不随仓库迁移。新设备从第 20 代检查点重新采集第 21 代，不要尝试恢复旧设备的半成品目录。
- 训练脚本会一直循环，每代采集 1,000 局后训练并保存新检查点。新设备的 `runs/` 是本地新目录。

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

6. 可先启动试玩页，让用户检查当前棋力：

   ```powershell
   pnpm ai play `
     --checkpoint experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt `
     --device xpu --simulations 16 --think-ms 100 --port 8060
   ```

   浏览器打开 `http://127.0.0.1:8060/`。CPU 试玩时将 `--device xpu` 改成 `--device cpu`。

7. 确认第 2–5 步通过、训练设备正常后，从第 21 代开始连续训练。默认使用 16 个 worker；新机器内存紧张时可以传入 `-Workers 8` 或更低，内存充足且实测稳定后再提高：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass `
     -File .\experiments\hunxiao-ai\train-continuous.ps1 `
     -StartIteration 21 `
     -CheckpointPath experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt `
     -Workers 16
   ```

   这是持续循环任务，会在每代结束时保存权重，并自动用新权重进入下一代。启动前检查内存余量和 worker 设置；训练过程不需要保持试玩页打开。不要把试玩服务误认为训练进程。

8. 把启动结果回报给用户：GPU/后端、检查点路径、测试结果、训练 PID、当前代数和输出目录。不要公开 `.env`、访问令牌或其他本机凭据。

## 已知限制

本次备份不包含旧局棋谱和训练对局列表；那些内容只在旧设备的 `experiments/hunxiao-ai/runs/` 中。新训练生成的棋谱会写入新设备本地 `runs/`，不会自动上传公网。
