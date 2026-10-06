# 昏晓 AI 本地训练

本实验固定使用用户确认的“昏晓”9×9地图、初始摆子和双人两队。训练和本地试玩都从仓库中的 `packages/game-core`、`packages/core-content` 读取本地共享 TypeScript 规则；不会调用线上内核，也不会改写正式地图。地图文件仍保存 `matchConditionIds: []`，实验加载时只挂载游戏核心默认条件：失去全部据点淘汰、最后存活队伍获胜。

## 当前训练规则

不启用任何十回合结算、兵力比例判胜、占地判胜或强制快速结束规则。自然对局继续到核心规则判胜；运行器的 `--max-actions` 只是计算预算，耗尽时只记录为截断局，不把它伪装成胜、负或平局。

默认 `--max-learning-rounds 30` 是训练数据筛选条件：第 31 回合及之后的局面不采集训练样本，对局仍按正常规则继续并保存结果/棋谱。第 1 至 30 回合保留的样本会在整盘自然结束后使用真实胜负标签；若在 30 回合内被动作预算截断，价值标签按所选 bootstrap 策略处理。长局的前 30 回合仍然能教会模型如何从早期局面走向之后的真实胜负。`--max-actions` 默认提高到 10,000，只作为防止异常漫长对局耗尽机器时间的安全停止；达到它仍是无胜负的截断局。

每局都有可检查的 `learningEligible` 和 `trainingFilteredAfterRound` 字段。回合过滤会显示在训练对局列表中；被过滤的后段棋谱仍可用于复盘。规则/特征更改会改变 fingerprint，因此临时规则产生的旧样本和旧模型不会与当前训练混用。

## 运行

在仓库根目录执行：

```powershell
pnpm ai inspect
pnpm ai:test
pnpm ai:typecheck
```

验证一轮训练闭环：

```powershell
pnpm ai pilot --name b580-normal-smoke --iterations 1 --games 2 --workers 2 --simulations 8 --max-actions 800 --max-learning-rounds 30 --max-samples 128 --steps 100 --batch-size 64 --device xpu --replay
```

`pilot` 顺序执行搜索老师示范、PyTorch/XPU 训练、网络自博弈、继续训练和固定对手评测。所有棋局在 Node worker 无界面运行。`--replay` 会保存精确动作，可在本地试玩页中逐步前进/后退、自动播放、暂停或拖动进度条。

本机训练环境使用 Intel Arc B580 的 PyTorch XPU 后端。首次配置可运行：

```powershell
py -3.12 -m venv experiments/hunxiao-ai/.venv
experiments/hunxiao-ai/.venv/Scripts/python.exe -m pip install -r experiments/hunxiao-ai/python/requirements-xpu.txt
experiments/hunxiao-ai/.venv/Scripts/python.exe experiments/hunxiao-ai/python/environment_check.py
```

如 XPU 检查失败，可先用 `--device cpu` 验证流程。Node 负责共享规则仿真、搜索与推理批处理；PyTorch 负责神经网络训练和前向推理。

## 大规模训练目标与快速原型

长期目标仍是 1,000 局搜索老师数据、100 轮各 1,000 局的自博弈、每轮保存 checkpoint，最后做固定对手评测。最初的 100k 任务按 32 次 MCTS 模拟、8 个 worker 运行；它在老师数据阶段完成 13 局后暂停，以优先拿到可试玩初版。已生成的 2,727 个局面、棋谱和元数据都保留在 `runs/hunxiao-100k-normal-window30-a10000-s32-20261006-teacher/`，没有把这批结果当作 100k 训练完成。

当前快速原型位于 `runs/hunxiao-fast-prototype-20261006/`：用上述老师数据在 XPU 上训练 600 步，做一轮自博弈，再训练 600 步。自博弈最多 8 次模拟；4 局里 1 局自然结束，3 局达到 10,000 动作安全上限并以截断局保存，未伪造胜负。产物权重为 `iteration-1.pt`。

同一权重以每步最多 8 次模拟、50 毫秒软时限对阵搜索基线：首批 4 局胜 3 局，追加 8 局胜 8 局；追加评测里先手、后手各 4 胜。12 局都自然结束。样本规模仍小，结果只能说明它是可试玩的早期原型，不能证明稳定或顶级棋力。快速对局参数和评测记录在 `runs/hunxiao-fast-prototype-20261006-arena/` 与 `runs/hunxiao-fast-prototype-20261006-arena-extended/`。

## 1,000 局自博弈迭代

`runs/hunxiao-selfplay-1000-20261006-v3/` 从快速原型 `iteration-1.pt` 采集 1,000 局，16 个 Node worker 并行，XPU 推理，搜索最多 4 次模拟、每步 10 毫秒软时限。为避免持续随机噪声把对局带入循环，只在开局前 80 个行动命令加入 0.12 根噪声；评测模式完全关闭探索。1,000 份棋谱的前 20 个行动序列均不同。

本次单局耗时平均 23.47 秒，中位数 20.85 秒，P95 为 40.52 秒；989 局在一分钟内，最长 214.56 秒。993 局自然结束，7 局达到 10,000 动作安全上限并保留为截断局。总计 255,896 条样本，其中 254,104 条带真实终局价值标签，1,792 条截断局样本只训练策略。每局最多保留 256 个样本；第 31 回合及之后的局面不采集。

基于这批数据续训 1,200 步，产物为 `iteration-2.pt`。留出集总损失从 3.82 降到 3.31，策略损失从 2.17 降到 1.65，价值损失约 1.66、基本持平。32 局新旧权重对局中新版 19 胜、13 负；新版作为先手 16/16 获胜、作为后手 3/16 获胜。旧版自对弈基线 32 局全部由先手获胜，说明先后手偏差很大；目前的对局数量不足以证明新版整体棋力稳定提升。完整棋谱、逐局结果和摘要都保存在对应 run 目录。

从已有 checkpoint 连续训练、每 1,000 局保存一个新 checkpoint，可启动：

```powershell
.\experiments\hunxiao-ai\train-continuous.ps1 -StartIteration 3 -CheckpointPath experiments/hunxiao-ai/runs/hunxiao-selfplay-1000-20261006-v3/iteration-2.pt
```

该脚本按单主模型迭代；每个节点先生成 1,000 局对局数据，再从上一节点权重续训 1,200 步并保存到该节点目录，随后自动进入下一个节点。从连续训练第 4 个节点起，按每 20 局中的 8 局让主模型对战两个冻结快照（最近兼容快照与最初原型），其余 12 局仍做当前模型自博弈；对历史模型对局只把主模型一侧的行动用于训练，并在每对对局中交换主模型席位。每轮续训后会让新权重、上一轮权重和可用的历史快照进行换边循环赛，再把得分最高的检查点作为下一轮主模型；循环赛不进行梯度训练。这样只保留一个正在更新的模型，不会同时运行多套梯度训练；历史模型只做陪练和选优。

训练样本按先后手分别做蓄水池抽样，训练损失也会平衡两边的样本权重。终局价值按棋谱终局胜者和样本席位重新核对，避免先前按动作顺序排序样本时把价值视角错配给另一边。席位仍作为输入特征之一，让同一模型能根据自己当前的行动顺序调整策略。

生成长局数据时建议显式设置 `--think-ms 50`：它把每次搜索限制在约 50 毫秒，单盘 800 至 3,300 步的评测耗时约 41 至 196 秒；这是软时限，单次网络评估仍可能超时。达到 `--max-actions` 仍只算截断，不产生胜负。学习窗口继续只采集前 30 回合局面，对局按核心规则自然继续。

运行数据保存在 `experiments/hunxiao-ai/runs/`，该目录为本机数据，模型、日志和虚拟环境不作为源码提交。旧临时规则 run 保留作历史复盘；其 checkpoint/fingerprint 不属于当前正常规则模型。

## 查看与接入

启动本地试玩/回放页面：

```powershell
pnpm ai play --device xpu --simulations 16 --think-ms 100 --port 8060
```

浏览器访问 `http://127.0.0.1:8060/`。训练模型仅保存在训练机器本地。未来接入线上系统时，需要将同 fingerprint 的模型和推理 runtime 部署到服务器或房主机器，再由现有房间规则内核校验并执行动作；本地训练结果不会自动出现在服务器上。

## 历史记录说明

早期 `hunxiao-round10-pilot`、`ratio-*`、`hunxiao-100k-territory-*` 以及 `hunxiao-100k-territory-r11-s32-20261006` 都曾使用临时终局条件或临时塑形目标，只保留查看，不混入当前规则训练。`hunxiao-100k-normal-r30-s32-20261006` 和 `hunxiao-100k-normal-window30-s32-20261006` 分别是整盘过滤、800 动作预算下的短烟测；数据保留供复盘，不混入当前 10,000 动作预算任务。
