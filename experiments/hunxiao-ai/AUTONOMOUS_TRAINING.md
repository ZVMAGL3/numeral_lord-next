# 自主训练与效果观察

当前路线：健康初始化的 `hex-graph-v1` 空间网络，正常昏晓规则，Node 共享内核采局，B580/XPU 推理和梯度更新。原始地图、初始兵力和自然据点胜负保持不变。

## 已完成与正在进行

2026-11-09 已完成 4,096 条自然终局样本上的 300 步 XPU 热启动；留出整局验证，旧策略模仿损失权重 0.25。此阶段只用于建立健康初版，不把模仿旧策略或 loss 下降视为棋力证明。

- seed：`runs/hunxiao-hex-healthy-seed-20261109/seed.pt`
- 可通过 Git LFS 恢复的同哈希副本：`checkpoints/hunxiao-hex-healthy-seed-20261109.pt`，新设备无需历史 samples 就能以它开始新自博弈节点。
- seed SHA256：`dd520d3e5722d0b6474995c3fbea5cc68744ad2faf1b9e52b15650a63a0770f6`
- 初始 / 最终留出总损失：约 1.6265 / 0.6867（策略项乘 0.25）。
- 最终价值 Tanh 饱和率 0；单独交换棋盘 observation 的策略概率变化约 0.5816，错误价值目标存在梯度；只证明数值/结构可学习。
- 2/2 局 smoke 自博弈自然结束，0 截断，随后 100 步续训和独立审计成功。两局 smoke candidate 没有被当作更强冠军。

已启动主运行根目录：`runs/spatial-autonomous-20261109/`。它按 100 局一个小节点继续采局、训练和评测，结果充分后再决定是否扩量。

2026-11-10 首轮外部对照：选定的 Hex 节点 2 对冻结旧 MLP20，在双方固定 16 次模拟的 32 局中仅 7 胜、25 负。内部两次晋级没有传递为胜过旧模型。已在节点 4 完整结束后安全切换节点 5 的对手分布试验：60% 自身对局、40% 对冻结旧 MLP20，其余参数不变。证据与边界见[首轮效果复核](../../docs/ai-training-observations-2026-11-10.md)。这是待验证调整，不宣称棋力已修好。

## 无需载入模型的进度查看

在仓库根目录运行：

```powershell
Get-Content .\experiments\hunxiao-ai\runs\spatial-autonomous-20261109\progress.json -Raw | ConvertFrom-Json | Select-Object status,generation,attempt,completedGames,champion,currentJob,resources,updatedAt
Get-Content .\experiments\hunxiao-ai\runs\spatial-autonomous-20261109\events.jsonl -Tail 5
```

`status=selfplay` 表示采集训练对局，GPU 做网络推理；`training` 才是梯度更新；`health_check` 是 CPU 有界审计；`evaluation` 是固定预算对局。低占用也可能是 CPU 检查、读数据或阶段切换；应同时看阶段、实际 GPU 引擎、进程与日志增长。

每个节点都有独立 selfplay/train/health/evaluation 日志。每局棋谱在相邻的 `runs/spatial-autonomous-20261109-gNNNN-aNNN/`；candidate、latest、metrics、selection 保存在主运行根目录对应的 `gNNNN-aNNN/`。旧冠军不会被候选覆盖。

## 本地 supervisor

入口：[`python/train_autonomous.py`](python/train_autonomous.py)。训练运行不调用语言模型 API，也不依赖 Codex 持续在线。聊天额度限制只会暂时影响自主分析与代码改进。

当前配置：

- 8 workers，100 局；每命令最多 16 次、至少 4 次搜索，100ms 软预算。
- 当前本机节点 5 起使用 `--opponent-pool experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt --opponent-model-family mlp --league-ratio 0.4`（实际保存的是绝对路径）；100 局精确分为 40 局陪练和 60 局纯自身对战。陪练局只采集学习方，不把旧对手走法当最佳标签。新建 supervisor 不配置对手池时仍默认纯自博弈。
- 每局最多保留 256 个局面；10,000 原子动作只是安全计算预算，截断不判胜、不伪造平局。
- 新采样阶段只学习自然完成、非截断对局。所有回合可学习，实际使用局长/短胜与席位权重。
- 每节点 300 步、batch 32、最多 16,384 条有界样本，学习率 0.0001；每 100 步保存 latest。
- candidate 经健康审计后，与上一保留 Hex 模型进行 32 局换边试验；每步固定 32 次模拟，无墙钟截断，记录成对 bootstrap 区间。这个小规模试验门槛不等于最终人类水平验收。
- 候选未通过门槛时保留旧冠军及新候选。连续 5 个节点不改善或连续 3 次失败，会设置 `REVIEW_REQUIRED.json`，等自主分析做出有依据的调整，不无限刷弱样本。

## 单实例、资源与恢复

- OS 独占锁限制同一实验下只能运行一个此类 supervisor；不用依靠 PID 文件当锁。
- 每 10 秒检查状态，保留约 5 GiB 可用系统内存、15 GiB 磁盘余量；连续触线会停止自己启动的子进程，等待资源恢复。
- 阶段日志 30 分钟不增长或单任务超过 6 小时会失败并有限重试；仅终止自己创建的进程树。
- 每个尝试独立命名，失败/半成品目录保留；恢复以最后选定检查点为起点。当前实现不声称恢复未完成棋局或逐优化器步的精确现场。
- 异常退出后重启前会检查旧任务 PID，仍存在时拒绝启动另一套 GPU 工作，需先核实进程身份。
- 不自动删除历史训练数据、不上传 raw samples，不碰线上房间服务。

重新启动本地 supervisor（先检查 progress 中的 PID 已退出，且不存在 STOP 标记）：

```powershell
experiments/hunxiao-ai/.venv/Scripts/python.exe -u experiments/hunxiao-ai/python/train_autonomous.py --run-root experiments/hunxiao-ai/runs/spatial-autonomous-20261109 --checkpoint experiments/hunxiao-ai/runs/hunxiao-hex-healthy-seed-20261109/seed.pt
```

已有 progress 会使用保存的冠军与代数。

已有 progress 的对手池、模型族和混合比例也会在未显式传入时恢复；矛盾配置会拒绝启动，不能静默回到纯自身对战。新设备要复现当前混合试验时，显式追加 `--opponent-pool experiments/hunxiao-ai/checkpoints/hunxiao-iteration-20.pt --opponent-model-family mlp --league-ratio 0.4`。

停止请求：

```powershell
New-Item -ItemType File -Force .\experiments\hunxiao-ai\runs\spatial-autonomous-20261109\STOP
```

supervisor 在下一次轮询停止自己创建的任务，保留检查点与文件。恢复时只删除该明确的 STOP 文件再重新启动。系统关机、休眠或驱动故障仍可能中断计算；重启后根据保存状态恢复，不能保证物理环境永不中断。

## 自主观察的判断标准

当前线程每 30 分钟检查小摘要。执行者优先为用户指定的 GPT-5.6 Sol，额度不可用时记录并等待，不换模型、不买额度。已有健康任务运行中不再启动 GPU 实验。

观察顺序：数值健康 → 真实终局/截断率 → 固定预算两席位结果 → 对冻结第 20 代和合法战术局面的验证 → 棋谱里的投点兑现、铺场、海路、供电、进攻与防守。重复用于调参的对局是开发证据，最终仍需独立评测。

只有数值健康和 loss 下降时，报告“可学习流程恢复”；有足够同预算对局与具体走棋支持时才报告棋力进步。没有改善就分析价值校准、标签质量与规划跨度，逐项对照，不只增加局数、时间或网络大小。
