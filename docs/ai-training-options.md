# Numeral Lord：AI 对战与训练方案评估

调研日期：2026-10-04（北京时间）。

审计对象：`C:/app/numeral-lord-next` 当前磁盘源码；另对照 `C:/app/numeral-lord-next-staging-20260930` 导出目录。主目录有未提交修改，因此本报告以实际文件为准，不以旧 Git HEAD 代表当前实现。结论适用于本地代码；线上部署版本是否一致未在本次验证。

阅读建议：先看第 1、4、10 节决定路线；准备实施时再看第 2、5～9 节。论文、官方源码和文档链接位于相关判断旁及第 11 节。文中的方案优先级、工期和参数是针对本项目的工程建议，不是论文已经验证了本游戏。

## 1. 结论与建议

**当前框架可以作为 AI 对 AI、AI 对人的规则与模拟基础，但还没有完整的 AI 策略、训练器和在线机器人席位系统。** 最有价值的基础已经存在：游戏规则独立于 UI、状态可序列化、合法动作能枚举、AI 与人类可以通过同一个命令入口结算。无需重写游戏规则，也无需通过截图和鼠标控制网页来训练。

建议路线：

1. 建立离线对战环境、规则 AI 和固定评测集，先得到可玩的对手。
2. 加入有限搜索，提高战术能力，并用它生成示范数据。
3. 在固定的小地图、双人两队、冻结规则上，尝试 **带合法动作掩码的 PPO + 历史对手池**。
4. 根据数据条件，用行为克隆预训练；根据竞技目标，再升级到策略/价值网络 + MCTS。
5. 在基础学习有效后，再扩展多人、团队、多地图和 Mod。

目前不知道训练机器的 CPU/GPU 配置，也没有收到对“陪玩、竞技、自博弈测试”的进一步选择。本报告按“普通电脑先做可玩 AI，保留训练变强的路径”排序，同时给出其他目标的分支。此处不需要预先采购 GPU。

## 2. 当前框架具备什么，缺少什么

### 2.1 已有实现与证据

下列链接与行号指向主目录本次读取的实际源码。

| 能力 | 实现证据 | 对 AI 的意义 |
| --- | --- | --- |
| 无 UI 的规则内核 | [game-core/package.json](C:/app/numeral-lord-next/packages/game-core/package.json:6)，提供编译后的 `@numeral-lord/game-core/node` | Node 可运行对局，不依赖 Vue、Pixi 或 DOM |
| 状态结构 | [state.ts](C:/app/numeral-lord-next/packages/game-core/src/state.ts:104) | 有棋盘、单位、玩家、队伍、阶段、失活状态、反击次数、序列号和结算结果 |
| 合法动作枚举 | [simulation.ts](C:/app/numeral-lord-next/packages/game-core/src/simulation.ts:24) | 返回移动、攻击、加点、结束行动、结束加点五类 `GameIntent` |
| 统一动作执行 | [simulation.ts](C:/app/numeral-lord-next/packages/game-core/src/simulation.ts:56)，[engine.ts](C:/app/numeral-lord-next/packages/game-core/src/engine.ts:221) | `applyIntent` 最终进入共享命令验证，返回 accepted/state/events 或失败原因 |
| 地图构造与开局 | [map-code.ts](C:/app/numeral-lord-next/packages/core-content/src/map-code.ts:159)，[engine.ts](C:/app/numeral-lord-next/packages/game-core/src/engine.ts:310) | 地图与内容目录可构造同一套对局；地图工厂默认已经调用 `startMatch`，不要重复发开局收益 |
| 终局和队伍胜负 | [state.ts](C:/app/numeral-lord-next/packages/game-core/src/state.ts:94)，[engine.ts](C:/app/numeral-lord-next/packages/game-core/src/engine.ts:1537) | 可从 `finished` 与 `result.winningTeamIds` 映射训练奖励 |
| 外部控制终局 | [engine.ts](C:/app/numeral-lord-next/packages/game-core/src/engine.ts:334) | `finishMatch` 可供比赛控制器使用；训练器截断仍应单独记录其性质 |
| 不可变快照与缓存 | [engine.ts](C:/app/numeral-lord-next/packages/game-core/src/engine.ts:146)，[engine.ts](C:/app/numeral-lord-next/packages/game-core/src/engine.ts:1595) | 可以对同一状态尝试多个分支；保留旧状态引用供搜索，遵守不可变契约 |
| 联机房间、席位、准备、开局 | [lobby.ts](C:/app/numeral-lord-next/packages/game-core/src/lobby.ts:23)，[server/index.ts](C:/app/numeral-lord-next/apps/server/src/index.ts:940) | 可扩展为人类与机器人混合席位 |
| Mod 版本/指纹核验 | [server/index.ts](C:/app/numeral-lord-next/apps/server/src/index.ts:550) | 核验参与者 Mod 版本与指纹一致；训练与模型也必须绑定相同规则集 |

注意：`game-core/node` 的 dist 需要构建。`core-content` 当前导出 TypeScript 源码，其 build 是类型检查；Node 加载地图/内容时需要现有 `tsx` 流程，或为新增 AI 包安排编译与运行时导出。不能仅看到 game-core 的 Node 入口，就认为所有内容包已经有可供普通 Node 直接加载的 JS 产物。

### 2.2 实际 headless 验证

使用主目录当前 TypeScript 源码、已有 tsx 和 Node v24.19.0，加载内置“昏晓”地图及核心/油田内容，运行按种子选择合法动作的随机策略。执行过程中检查旧状态序列化结果是否被改变。

| 检查 | 结果 |
| --- | --- |
| 6 个随机种子，每局上限 1,000 个原子动作 | 1 局在 203 个动作、round 9 时自然结束，team-2 获胜；其余 5 局达到截断上限 |
| 重跑 seed 1 | 最终状态 JSON 与第一次相同 |
| 总执行量，包含 seed 1 复跑 | 6,203 个动作，全部 accepted，0 次拒绝，0 次旧快照变异 |
| 此小地图的候选动作数量 | 各局平均约 14～17，峰值 27～38 |
| 单次本机 smoke 耗时 | 约 2.516 秒，约 2,465 个原子动作/秒 |

这证明现有引擎可以运行无页面模拟，并提示随机 rollout 经常无法及时结束。上述速度包含状态 JSON 比较，但不包含神经网络、IPC、MCTS、训练更新和网络；它不是完整训练吞吐或任意 Mod 的性能保证。本次没有训练模型，也没有完成整套性能基准。

### 2.3 需要新增的组件

| 缺口 | 要做的工作 |
| --- | --- |
| AI 策略 | 规则评分、搜索或训练出的策略网络 |
| 训练环境 | `reset/observe/step`、动作编码/掩码、奖励、terminated/truncated、种子控制 |
| 训练桥与采样 | 常驻 Node 模拟 worker，Python 训练适配、批量通信、多环境 |
| 自博弈管理 | 冻结历史模型、对手抽样、晋级、地图课程 |
| 数据与评估 | 逐步轨迹、版本元数据、回放复现、独立对手与地图评测 |
| 在线 AI | Bot 控制器、可信席位权限、推理调度、截止时间与合法兜底 |
| 模型交付 | 冻结权重、观测/动作编码版本、兼容规则范围、推理校验 |

目前网络对局是**浏览器房主权威、服务端中继**。服务端导出的 `validateIntent` 并未用于当前 PvP 房间的逐步规则结算，见 [server/index.ts](C:/app/numeral-lord-next/apps/server/src/index.ts:1031)。已有共享引擎不等于已经实现服务器权威 AI 房间。

比赛快照与开局载荷保存在房间内存，见 [server/index.ts](C:/app/numeral-lord-next/apps/server/src/index.ts:113)。现有数据库主要存工坊地图、Mod 和资源；未发现比赛逐步轨迹存储。已有 [notation.ts](C:/app/numeral-lord-next/packages/game-core/src/notation.ts:3) 和导出的坐标点击棋谱，也不等于包含观测、合法动作、奖励和规则版本的训练数据。

## 3. 先把概念分清楚

“机器学习还是神经网络”不是同一级别的选择。

| 概念 | 在这个项目中的含义 |
| --- | --- |
| 人工智能 | 能选择游戏动作的系统总称；规则和搜索也属于 AI |
| 机器学习 | 用数据或对局结果调整策略/参数，而非全部手工指定 |
| 神经网络 | 表示策略或局面价值的一种模型；小型网络即可开始 |
| 监督/模仿学习 | 从玩家或搜索 AI 的观测—动作示范学玩法 |
| 强化学习 | 通过模拟对局及奖励调整策略，PPO 是可选算法之一 |
| 自博弈 | 策略相互对战产生数据；单纯运行 AI 对 AI 不会自动学习 |
| MCTS/其他搜索 | 决策时尝试未来分支，可配规则评分，也可配神经网络 |
| 大语言模型 | 适合自然语言解释与辅助规划；不是此游戏第一版逐步动作控制器的优先选择 |

因此可以使用“强化学习 + 神经网络 + 自博弈”，也可以使用“规则策略 + 搜索”，或“搜索生成数据 + 监督训练 + 强化学习”。[PPO 论文](https://arxiv.org/abs/1707.06347)研究的是学习算法；[AlphaZero 论文](https://arxiv.org/abs/1712.01815)展示的是学习、网络和搜索结合的路线。

这里更重要的选择是：**有无优质示范、能模拟多少对局、每次决策有多少时间、是否先限定规则和地图。**

## 4. 五个可行方案

以下所有方案都能被接入 AI 对 AI 或 AI 对人；共用第 7 节的对战接入基础。表中“成本”同时考虑实现和实验，不代表已经测得的棋力。

| 方案 | 是否学习 | 首版资源 | 优点 | 主要限制 | 建议用途 |
| --- | --- | --- | --- | --- | --- |
| A. 规则评分 + 有限搜索 | 可完全不训练 | CPU | 最快做出可玩版本、容易解释和调难度 | 长期战略依赖评价函数，搜索容易膨胀 | 首选起点，始终保留作基线 |
| B. 自动调规则权重 | 学习少量参数，通常不用网络 | CPU、多局评测 | 低成本自动改进、实现比深度 RL 小 | 能力受人工特征限制，可能只适合训练地图 | 没有 GPU，想先体验自动变强 |
| C. Maskable PPO + 历史对手池 | 深度强化学习 | CPU 可验证；GPU 可用于扩大训练 | 推理便宜，能从胜负中学习 | 样本需求、奖励、动作设计和自博弈稳定性 | 默认的第一条神经网络训练路线 |
| D. 行为克隆 → 强化学习 | 监督学习 + RL | 示范数据；CPU/GPU | 初始就有基本玩法，可复用搜索 AI | 示范质量及状态分布偏移 | 有较好人类/搜索示范时优先于纯随机起步 |
| E. 策略/价值网络 + MCTS | 搜索辅助学习 | 多核 CPU + GPU 更适合规模实验 | 长期适合固定规则竞技研究 | 实现与采样成本最高，多人需专门改造 | 固定双人对局的后续进阶 |

### 方案 A：规则评分 + 有限搜索

先从 `getLegalIntents` 获得候选动作，使用 `applyIntent` 模拟结果，比较终局、兵力交换、供电、下回合收益、据点安全、关键路径与目标完成度。

设计两个相对独立的策略部分：

- 行动阶段：优先直接胜利、避免立即败局；再考虑攻击交换、占领和接电，并为“结束行动”保留评分。
- 加点阶段：比较给各单位加 1 点后的价值，也允许“保留点数、结束加点”。不能默认必须把点数全部花完。

第一版可采用 1～数层的候选搜索/束搜索，再尝试有预算的 MCTS。简单贪心只看一次动作结果，很容易错过断电、牺牲攻击消耗反击次数、连续行动等组合；搜索至少要覆盖这些专门的战术夹具。

**本游戏的重要改造：** 一名玩家的回合包含多个原子命令，行动后还要加点。树深度增加一次不代表轮到敌人；双人零和搜索的值只在评价视角真正切换时改变符号。多人自由混战应使用多方价值或明确对手模型；同队按共同目标评价。不能直接照搬“每走一步都交换 max/min”的棋类代码。

搜索要有节点/耗时上限、启发式排序、受控扩展和局面缓存。局面 key 应包含阶段、行动者、兵力、资源、失活/反击状态、规则上下文等，避免只按单位位置合并。屏幕外 worker 运行搜索，在线截止时使用已找到的最佳合法动作。

[MCTS 综述](https://repository.essex.ac.uk/4117/1/MCTS-Survey.pdf)可用于理解搜索变体；[OpenSpiel MCTS 源码](https://github.com/google-deepmind/open_spiel/blob/master/open_spiel/python/algorithms/mcts.py)可参考多玩家价值回传。后者接受 OpenSpiel 状态 API，不会直接接受本项目 GameState；本项目第一版直接用 TS 实现搜索更省接口工作。

**取舍：** 这是目前最容易落实的方案，也能作为训练老师、对手和地图测试器。它在新 Mod 上仍能由引擎保证动作合法，但评价函数未必理解新增效果；“合法通用”不等于“战略通用”。

### 方案 B：自动优化规则权重

把方案 A 的评价函数写成 `score(s,a) = Σ w_i × feature_i(s,a)`，通过交叉熵搜索、随机搜索或进化优化试验不同权重。这里优化的是少量策略参数，并非游戏引擎规则。

每组参数对战多个固定基线、历史参数和不同地图；先后手/席位配对，然后依据胜率、失败类型及耗时挑选候选。保留验证地图，避免针对一张地图把“接电收益”等权重调成过拟合捷径。

这个方案能提供实际的“AI 对 AI、通过结果自动变强”，无需马上建立深度学习堆栈。若特征只有眼前兵力与收益，它很难自行发明人工特征无法表达的战略；参数调优结果也必须通过独立评测才能称为改进。

**取舍：** 无 GPU 时值得考虑，且可与 A 共用全部基础。若后续明确采用 C/D，不必强制先完成 B；它是一条低成本分支。

### 方案 C：带合法动作约束的 PPO + 历史对手池

模型输入结构化局面，输出策略分布与局面价值。规则引擎给出动作掩码，策略仅在合法动作中采样。PPO 根据新收集的轨迹更新网络；旧历史数据不能未经设计就作为 PPO 的无限重放缓冲。

[非法动作掩码论文](https://arxiv.org/abs/2006.14171)给出策略梯度下的依据并研究大量非法动作的影响；[SB3-Contrib 官方 MaskablePPO](https://sb3-contrib.readthedocs.io/en/master/modules/ppo_mask.html)提供可复用实现。掩码解决动作合规和无效探索，棋力仍要学习。

**最小实验：** 固定小地图、双人两队、固定内容与观测尺寸。一局选定学习席位，另一个席位由冻结的规则 AI/历史 checkpoint 控制；reset 随机分配席位，并先推进至学习者首次决策或终局。Gymnasium 环境执行学习者的一条命令后，在必要时自动运行对手，直到学习者下一次可决策或终局；同一玩家还有行动时立即返回。之后定期更新对手池。

至少区分三件事：多个玩家共用网络参数、策略相互对战、保存并抽样冻结历史策略。三者不是同一功能。只让最新模型一直打最新模型，50% 左右的对战结果不能证明实力上升。

对手池加入规则 AI、搜索 AI、不同历史模型；每局开始固定对手版本，晋级依据独立评测。可以参考 [RLlib 自博弈示例](https://github.com/ray-project/ray/blob/master/rllib/examples/multi_agent/self_play_with_open_spiel.py)及其 [历史策略 callback](https://github.com/ray-project/ray/blob/master/rllib/examples/multi_agent/utils/self_play_callback.py)。它们展示冻结策略与抽样，不是本游戏即插即用训练器，也不是动作掩码教程。

**库的具体边界：** 当前 MaskablePPO 支持离散动作和 Dict 观测，但不直接支持 Dict 动作或 recurrent policy。多进程环境内要实现 `action_masks`，评估使用专用 MaskableEvalCallback/evaluate_policy；详见前述官方文档。需要可变候选评分网络或更复杂团队训练时，考虑自定义 PyTorch/TorchRL 或 RLlib，而非勉强套默认接口。

多人扩展按“玩家席位”为 agent，一名玩家控制其全部单位。采用 [PettingZoo AEC](https://pettingzoo.farama.org/api/aec/) 表达严格顺序决策。真正需要团队中央价值网络时才引入 MAPPO；[MAPPO 论文](https://arxiv.org/abs/2103.01955)的合作环境结果不能作为自由混战效果保证。

**取舍：** 这是我推荐的首条可训练网络路线。先验证在固定基线上学习有效，再扩大地图/队伍/Mod，避免调试问题与学习问题混在一起。

### 方案 D：行为克隆，再做自博弈强化学习

先采集规则/搜索 AI 或较好玩家的结构化观测与动作，训练网络模仿。可以先克隆方案 A 的搜索结果，无需等待大量真人棋谱；随后以 C 的学习流程微调。

数据必须覆盖行动与加点、失败局面、不同席位，以及何时选择结束阶段。人类点击 tuple 需要借助正确版本的初始地图和命令轨迹重建，单独一份点击文件不能直接喂给网络。

行为克隆在偏离示范的局面上容易连续犯错，可使用 DAgger 思路：让当前模型走到自己的局面，再由搜索老师给纠正标签，并迭代补充数据。[DAgger 论文](https://proceedings.mlr.press/v15/ross11a.html)讨论了这种序列决策分布偏移；[imitation BC 文档](https://imitation.readthedocs.io/en/latest/algorithms/bc.html)和 [实现仓库](https://github.com/HumanCompatibleAI/imitation)可供参考。

工程上必须明确网络与损失兼容：imitation 的默认 BC 使用 SB3 ActorCriticPolicy，不能承诺任意 MaskablePPO 模型直接无缝预训练。对于自定义候选动作网络，直接编写 PyTorch 的掩码交叉熵损失可能更清楚；价值网络再用对局结果/搜索标签单独初始化。

**取舍：** 有较好老师时可以缩短无意义随机探索，也适合训练不同风格的陪玩 AI。普通 BC 的目标是模仿老师；想超过老师仍需搜索、强化学习或更强示范。

### 方案 E：AlphaZero 类策略/价值网络 + MCTS

自博弈时，每次决策通过 MCTS 改进网络先验；以搜索访问分布作为策略标签，以最终胜负作为价值标签，迭代训练。它与“PPO 自博弈”是不同的训练方法。

项目有真实、可无界面调用的规则模型，因此有条件使用这种路线。但首版应限定双人两队、明确胜负、固定规则的小地图。[AlphaZero 论文](https://arxiv.org/abs/1712.01815)可作方法依据；[Expert Iteration 论文](https://arxiv.org/abs/1705.08439)可参考搜索老师与网络学生相互提高。

[OpenSpiel AlphaZero 源码](https://github.com/google-deepmind/open_spiel/blob/master/open_spiel/python/algorithms/alpha_zero/alpha_zero.py)是官方项目中的教学重实现，不是论文实验原始代码。当前入口显式限制两名玩家；[项目说明](https://github.com/google-deepmind/open_spiel/blob/master/docs/alpha_zero.md)也说明其教学定位。框架支持 n-player 不代表此 AlphaZero 训练实现支持 n-player。

接入需要实现 OpenSpiel Game/State 适配（玩家索引、clone、legal_actions、apply_action、returns、观测与固定动作编码），或者直接复用本项目 TS 搜索、自己建立 Python learner。为保持规则一致，首阶段不建议把复杂 Mod 引擎重新写一遍 Python。

多人/团队拓展应有多方价值与匹配机制；同一玩家连续行动不能每个树边都反转价值。大动作空间需要受控扩展/候选先验，单线程逐节点跨进程调用神经网络也可能成为瓶颈，应考虑批量叶节点评估与缓存。

**取舍：** 值得作为竞技路线，但不适合作为当前成本最低的起点。MuZero 还要学习环境动态；本项目已有可调用规则，首阶段增加这项学习负担收益不明确。这个判断是本项目的工程取舍，参见 [MuZero 论文](https://arxiv.org/abs/1911.08265)了解其目标。

## 5. 学习环境要怎样设计

### 5.1 使用规则状态，不使用棋盘图片

第一版采用数值/类别特征，避免让模型重新学习贴图、文本和点击位置。

| 特征组 | 至少包含 |
| --- | --- |
| 棋盘拓扑 | 格坐标、有效格、六邻接、地形能力、地图中有意义的定向连接 |
| 单位 | 所属玩家/队伍、兵力、兵种能力、位置、markers、是否通电/失活 |
| 回合 | 当前玩家、行动/加点阶段、回合数、反击次数 |
| 资源 | 各玩家剩余加点、收益来源与条件、关键目标状态 |
| 规则上下文 | 友伤、胜负条件、modSettings/能力覆盖与训练允许的特殊规则 |
| 候选动作 | 动作类型、源/目标、有关单位与格子的特征、有效候选 mask |

以当前决策者为参照编码“自己、同队其他玩家、敌方、无所属/中立”，但保留玩家关系；供电等规则可能依赖单位的具体 owner，不能把所有同队玩家混为一个 owner。当前源码支持地图中立特殊单位，它们不应错误地当作另一个主动玩家 agent。

从源码看当前有完整局面快照，未发现为训练定义的迷雾/部分可见观测层，可先按完全可见局面研究。未来加入战争迷雾时，策略只能看到该玩家可见信息，需要重新设计观测、记忆与评测。

固定小图用 MLP/小 CNN 即可验证；六边形关系可通过显式邻接特征或六邻消息传递编码。准备跨尺寸时再考虑集合/图网络和池化。**GNN 或 Transformer 并不自动理解未知 Mod 规则。** 首版不要把网络结构复杂度当作效果保证。

### 5.2 动作编码：第一版简单，扩展版避免平方爆炸

`getLegalIntents` 输出的是命令对象，而训练库需要动作空间。建议两种实现：

- **固定小图基线：** 为源格—目标格移动/攻击、源格加点、两个结束命令建立固定 ID 表；每次按引擎合法列表填 mask，解码回真实 unitId 和 cellId。它容易接 MaskablePPO，但只适合受限尺寸。
- **长期版本：** 对当前合法候选动作计算特征，网络逐候选评分，再对有效候选 softmax。批处理可填充到固定容量并带 mask；每条采样保存当时的候选及编码。超过容量应明确拒绝不支持的场景或扩容，不能悄悄丢失合法动作。

若为 N 格穷举移动/攻击格对，约有 `2N² + N + 2` 个动作槽。64 格约 8,258；源码地图格式最大可表示 4,096 格，此时约 3,356 万槽，显然不适合直接套一个大固定输出层。地图格式上限见 [map-code.ts](C:/app/numeral-lord-next/packages/core-content/src/map-code.ts:103)，不是首版训练必须支持的规模。

候选列表的长度和顺序会变化，索引 3 不是固定的游戏动作。必须把候选特征和该次映射作为观测/轨迹的一部分，并固定排序约定；只对变长列表的裸索引训练会产生语义混乱。候选评分需要自定义 policy，并非默认 MaskablePPO 自动提供。

`MultiDiscrete(单位, 类型, 目标)` 的独立分支 mask 不能自动表达联合约束；可以采用完整动作候选或条件化逐级选择，不能把合法单位和合法目标分别勾选后任意组合。

### 5.3 奖励、终局、截断

双人两队基线先用真实终局的赢 +1、输 -1、明确平局 0。奖励依据 `winningTeamIds`，不是玩家名字、总兵力或 AI 自己判断“应该赢了”。多人有多获胜队伍或空获胜集合时，需要明确映射约定；自由混战不假设所有其他玩家奖励恰好等于自己的负值。

稀疏奖励学习困难时，可小幅增加潜势差分，例如 `r' = r + γΦ(s') - Φ(s)`，Φ 综合队伍兵力、安全收益与目标进度。使用与训练一致的折扣，真正吸收终局令 Φ=0；外部截断保留最终非终局状态的潜势并正确 bootstrap。不能持续发“占地一次加分、丢地不扣分”的可刷奖励。[奖励塑形论文](https://people.eecs.berkeley.edu/~russell/papers/icml99-shaping.pdf)提供单智能体 MDP 的理论依据；此处是设计参考，不宣称在任意多人混合博弈中保留全部均衡性质。

每局设置最大命令数/轮数，允许检测停滞。训练预算耗尽记 `truncated=true`，规则自然结束记 `terminated=true`；前者不要虚构 winningTeamIds。PPO 等 TD/GAE 值学习在外部预算截断时，应以截断前的最终观测 bootstrap，真正 terminated 不 bootstrap；不能使用自动 reset 后的首帧代替最终观测，见 [Gymnasium 时间限制说明](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/)。若把固定回合限制定义成任务规则，需在观测中提供剩余预算并按该有限时域任务处理；AlphaZero 等依赖最终胜负标签的轨迹，也不能把未结束截断局当作真实平局标签。

一名玩家可能连续执行许多命令；一个学习者决策之间也可能跨过多条对手命令。先约定折扣的时间单位是“学习者的一次决策”，并在论文/日志中明确；若按引擎原子步计时，则推进 k 步的转换应正确累计奖励与 `γ^k`，不能混用。

单学习席位包装中，常规采样预算最好在学习者逻辑决策边界触发，以取得 critic 适用的最终观测；若为防止卡死而在对手推进中强行中断，需要专门处理该中间状态，不能直接把只在学习者决策状态训练的价值估计当作可靠 bootstrap。

玩家淘汰后，团队可能仍获胜：单学习席位环境要继续运行其余对局以取得团队结果，或使用明确的多智能体终止与奖励协议。不能把个人被淘汰直接当作队伍失败。

### 5.4 训练桥和规则版本

建议保持 **TypeScript game-core 为唯一规则源，Python/PyTorch 负责训练**：

```mermaid
flowchart LR
  MAP[冻结的地图与 Mod] --> CORE[Node game-core 模拟 worker]
  CORE --> ENV[训练环境适配与批量观测]
  ENV --> TRAIN[Python 学习器]
  TRAIN --> POOL[冻结 checkpoint / 对手池]
  POOL --> CORE
  POOL --> EVAL[固定地图与对手评测]
  EVAL --> MODEL[通过评测的模型]
  MODEL --> ONLINE[在线推理 worker]
  ONLINE --> CTRL[对局控制器校验并提交命令]
```

先用常驻 Node worker + stdin/stdout JSONL 或本地 IPC 验证；stdout 专用于协议，日志走 stderr。多个环境一起处理 reset/step/observe；测量传完整 JSON 的开销后，再考虑紧凑二进制张量。不要每条动作启动一个 Node 进程，也不要经公网房间生成训练数据。

规则内核没有内置训练种子状态，当前规则也未发现依赖 Math.random/真实时间的战斗采样。种子应管理环境的地图抽样、席位抽样、策略采样与对手选择；将来有随机规则时，把 RNG 状态显式纳入可复现上下文。

每个模型/数据集记录 core 版本或源码指纹、地图 hash、Mod version/contentHash、解析后的 settings、观测/动作编码版本、reward 版本、seed 和对手版本。main 与 staging 的引擎已有规则差异，不能混合并标称同一环境。

`GameState` 并未封存全部外部规则：执行仍需 terrain/unit/match-condition catalogs。数据集要保存完整、可恢复的内容包/catalog 快照，或指向不可变且可取得的版本化产物，不能只保存状态 JSON 与几条 hash。state 与 catalog 都应按不可变对象使用；就地修改后继续用原对象身份，会让现有 WeakMap 缓存失效假设被破坏。

## 6. 多人、团队与 Mod 的扩展顺序

1. 双人两队、固定小图、无额外 Mod 或固定核心内容。
2. 加入更多同规则地图，随机先后手/席位，留出未训练地图评估。
3. 引入油田等已冻结 Mod，单独验证合法动作、收益和战术。
4. 固定人数的多人/团队，增加相应奖励与对手/队友池。
5. 有需要再支持可变人数、尺寸和更多规则族。

“能在工坊任意 Mod 上正常走棋”与“能在任意 Mod 上走得好”是两个验收目标。未知能力、胜负条件和空间规则可能改变策略语义；上线时声明模型适用范围，不匹配时退回规则基线或标明此规则未受支持。

团队场景也要先辨认控制粒度：每个玩家控制自己的所有单位，通常一个玩家一个 agent 即可。为每个棋子单独建 agent 会增加通信、信用分配和动作冲突工作，目前收益不明确。

[PettingZoo](https://github.com/Farama-Foundation/PettingZoo)提供环境 API，[RLlib](https://docs.ray.io/en/latest/rllib/multi-agent-envs.html)/[TorchRL](https://docs.pytorch.org/rl/main/tutorials/multiagent_ppo.html)提供训练组织能力。它们能表达多智能体，不会自动解决变长张量、复杂 Mod 或历史对手池。TorchRL 中 AEC 的玩家可行动 mask 与合法动作 action_mask 是两种约束，使用时分别处理，见 [PettingZooWrapper](https://docs.pytorch.org/rl/stable/reference/generated/torchrl.envs.PettingZooWrapper.html)。

训练环境建议采用 Linux/WSL2；PettingZoo 官方仓库目前正式维护 Linux/macOS，Windows 不作为正式支持平台。游戏前端与 Node 推理可以继续在现有 Windows 项目中开发。

## 7. AI 对 AI、AI 对人怎样接入

### 7.1 离线 AI 对 AI：首先做这个

新增对战运行器：加载地图和冻结内容，按 currentPlayerId 找该席位的策略，取得一个合法 intent，通过 applyIntent 执行，保存轨迹，直到终局或截断。允许同一策略、不同策略和不同 checkpoint 互相对战。

初始接口建议如下，**这些是拟新增接口，不是仓库已有 API**：

```ts
interface AiPolicy {
  decide(context: {
    state: GameState;
    legalIntents: readonly GameIntent[];
    playerId: PlayerId;
    policyVersion: string;
    budget: { maxNodes?: number; deadlineMs?: number };
  }): Promise<GameIntent>;
}
```

传入策略的 state/candidate 不可修改；决策输出仍需走引擎验证。离线用确定性节点/命令预算，线上再使用实际耗时预算。

### 7.2 联机原型：独立 Bot 客户端

每个机器人用独立连接占一个现有席位，加载相同内容，接收开局与房主快照，维护状态同步，轮到自己时提交意图。这样可较少修改席位身份规则。

策略可以输出裸 `GameIntent`，但网络现有 `player-intent` 的 `payload.command` 要求带 `commandId/actorId/expectedSequence` 等信息的 `GameCommand`。Bot 需要按最新同步状态构造命令并保持时间线关联，不能把离线 `applyIntent` 的参数对象原样发上网。

但 Bot 可能成为房主；原型可以明确限制人类房主，完整版本必须支持 Bot 发布快照、房主迁移和时钟。只写“收快照、发动作”的循环不能覆盖所有现有房间生命周期。

### 7.3 产品化：正式机器人席位与控制器

为房间增加 `human/bot controller`、难度、策略版本和添加/移除 Bot 操作，把连接身份与棋盘席位分开。由权威对局控制器调度机器人推理，并在提交前复核：行动玩家、phase、sequence/command head、合法性与截止时间。状态变更或迁移后丢弃旧结果。

现有服务端会按发送连接席位重写 actorId，见 [server/index.ts](C:/app/numeral-lord-next/apps/server/src/index.ts:165) 与 [sanitizeRelayedCommand](C:/app/numeral-lord-next/apps/server/src/index.ts:1224)。因此房主不能直接通过当前 player-intent 通道代替任意 AI 席位行动。正式席位需要受控的授权路径；客户端可传 accountId 的现状也不能当作可信机器人服务身份。

如果主要是本地陪玩，可以由本地控制器/worker 执行；如果要持续在线、无人值守 AI 对 AI 或竞技排名，更适合新增服务端权威房间模式：server 调用同一 game-core 结算，人类与 AI 都只提交意图。这是部署架构扩展，不是开始离线训练的前置条件。

### 7.4 推理与时钟

训练与在线服务分开。搜索或神经网络推理放 worker/独立进程，不阻塞 relay 事件循环。正常玩家对战中加载冻结模型，模型更新经过离线评测后切换版本。

当前时钟是每名玩家累计时间银行，加上阶段步时；原子命令不会重新获得一份完整步时，加点阶段有宽限，银行耗尽后也有短时机制，见 [match-clock.ts](C:/app/numeral-lord-next/apps/web/src/rooms/match-clock.ts:39)。当前由浏览器房主处理超时，见 [app-runtime.ts](C:/app/numeral-lord-next/apps/web/src/app/app-runtime.ts:2290)。推理预算应取实际剩余时间并留出提交余量，不能硬编码为“每个动作都有一分钟”。

失败/超时兜底使用当前状态下的低成本合法策略，必要时结束当前阶段；不要连续提交非法动作等待模型修正。神经网络可先在 Python 服务推理，之后考虑导出 ONNX 到 Node 或浏览器：[ONNX Runtime Node 文档](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)、[Web 文档](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)。导出是后续部署选项，需要逐局面对齐预处理、logits、mask 与解码，不能默认任意训练模型导出即兼容。

## 8. 如何知道 AI 真的变强

建立固定基线：随机合法策略、贪心规则策略、带搜索策略、冻结历史模型。评测集独立于训练抽样和晋级调参。

| 检查项 | 建议记录/验收方式 |
| --- | --- |
| 基本正确性 | 已选合法动作均经引擎接受；训练桥与线上编码一致 |
| 复现 | 同一 seed、规则/地图/策略版本的命令轨迹及状态 hash 可复现 |
| 棋力 | 对固定对手的胜/负/平与截断率，交换席位/先后手；报告样本数与区间 |
| 战术 | 接电、断电、据点安全、反击次数、连续攻击、远程不入格、保留加点等夹具 |
| 泛化 | 未训练地图、不同席位、声明支持范围内的 Mod/设置 |
| 运行成本 | 引擎吞吐、IPC 吞吐、训练更新耗时、在线 P50/P95 决策时间和内存 |
| 陪玩体验 | 不同难度、风格差异、等待时间与反复无效行为 |
| 平衡性测试 | 多策略交叉对战矩阵；地图席位优势，避免把单一 AI 的偏好当规则不平衡 |

起步可安排每个固定对手 200～500 局的配对评估，并采用至少 3 个训练随机种子检查稳定性；它们是规划起点，不是已有结果或足够性保证。胜率差异很小时需扩大样本。大量截断必须单独显示，不能统一按输/赢处理后隐去。

多个策略可能相互克制；不要只用一个 Elo 数字或自博弈胜率解释多人强弱。保存完整交叉对战矩阵和规则范围。

数据格式至少有：episode/run ID、地图和内容版本、初始状态/恢复快照、决策前观测与候选、真实 intent、commandId/sequence、规则事件、奖励、terminated/truncated、结果、策略/对手版本及 seed。胜负标签只从引擎结果生成。

## 9. 资源、时间与工程划分

以下为单名熟悉项目开发者的粗略工程量估计，按工作日计；不包含达到特定竞技水平所需的未知实验时间，阶段有依赖也有可复用部分，不能机械相加作为承诺交付期。

| 阶段 | 粗略工作量 | 可交付结果 | 资源判断 |
| --- | --- | --- | --- |
| 离线环境、轨迹、随机/规则基线 | 3～7 天 | 可复现 AI 对 AI、固定评测报告 | 普通 CPU 即可 |
| 有限搜索与人机原型 | 5～10 天 | 可玩 AI、预算/难度、原型席位 | 多核 CPU 更有利 |
| 自动权重优化（可选） | 3～7 天 | 经独立评测的参数候选 | CPU 并行评测 |
| 固定规则 MaskablePPO 首次闭环 | 7～15 天 | 环境适配、训练日志、checkpoint、真实胜率比较 | CPU 可验证；GPU 的收益先测再决定 |
| 示范预训练（可选） | 3～10 天，加数据准备 | 数据集、BC 模型与 RL 衔接 | 取决于老师和数据量 |
| AlphaZero 类及多人泛化 | 数周至更长 | 专门的搜索训练与评测系统 | 多核采样、批量推理与 GPU 需实验规划 |
| 正式在线 Bot/权威模式 | 单独评估 | 迁移、重连、时钟、权限与模型交付 | 涉及房间生命周期，不计作训练库安装工作 |

小模型可能主要受模拟、JSON/IPC 和 rollout 长度限制，购买更强 GPU 并不会自动提速。先以一批固定地图测 `getLegalIntents/applyIntent → 批量传输 → 模型推理 → 更新` 的分段耗时，再制定并行度和训练预算。不开训练时，普通 CPU 仍可服务规则 AI 或轻量模型推理。

建议新增职责（拟定路径，尚未创建这些实现）：

```text
packages/ai-policy/  策略接口、规则/搜索策略
packages/ai-env/     引擎封装、观测/动作编码、批量 Node worker
apps/ai-runner/      离线赛程、评测、轨迹记录
training/           独立 Python 环境、BC/PPO、自博弈池与模型元数据
```

继续复用 game-core/core-content/game-sdk；把训练产物与运行日志放独立产物目录，模型/数据不要混入工坊 Mod 内容。生产 relay 不承担大批自博弈或梯度更新。

## 10. 按目标做最终选择

| 你的优先目标 | 推荐顺序 |
| --- | --- |
| 尽快有 AI 陪人玩 | A → 联机/本地 Bot 接入 → D 或 C |
| 普通电脑上尝试自动变强 | A → B；有数据和预算再 C |
| 从零训练一个网络策略 | 离线环境 + A 基线 → C；有好老师就先 D |
| 固定双人竞技棋力 | A 搜索与评测 → D/C 建立学习基础 → E |
| AI 对 AI 测地图/平衡性 | 多种 A/B 基线 + 赛程/轨迹/对战矩阵，再补学习模型 |
| 多人团队合作 | C 的 AEC 多智能体适配；有必要再中央价值网络/MAPPO |
| 工坊任意新 Mod | 先合法性与规则基线；学习模型声明支持范围，逐规则族扩展 |

**本项目的默认选型：A 做第一版，C 做第一条学习路线；有搜索示范时用 D 加速，E 保留为进阶目标。** 第一项实施任务应是“离线可复现 AI 对战环境 + 规则基线 + 评测”，完成后才有可靠依据比较学习方法与硬件成本。

暂不把普通表格 Q-learning、未经设计的 DQN 或 LLM 逐步选动作作为首选：状态/动作规模、多玩家对手变化、命令正确性与推理成本需要额外处理；这是当前工程优先级，不表示这些方法理论上不能用于游戏。未来有部分信息博弈时，也可以另评 CFR 等路线，而不是提前为尚不存在的隐藏信息改造整个系统。

## 11. 论文与 GitHub 源码阅读清单

### 11.1 论文：优先读与本项目问题直接相关的部分

| 论文 | 重点阅读目的 | 本项目中的使用边界 |
| --- | --- | --- |
| [A Survey of Monte Carlo Tree Search Methods — Browne 等，2012](https://repository.essex.ac.uk/4117/1/MCTS-Survey.pdf) | MCTS、扩展控制、rollout 与评价函数 | 参考搜索设计，不把其他游戏的棋力当本项目结果 |
| [Proximal Policy Optimization Algorithms — Schulman 等，2017](https://arxiv.org/abs/1707.06347) | 策略更新与采样流程 | PPO 基线，仍需本项目环境与奖励 |
| [A Closer Look at Invalid Action Masking in Policy Gradient Algorithms — Huang、Ontañón，2020/2022](https://arxiv.org/abs/2006.14171) | 非法动作很多时如何限制策略分布 | 直接对应 getLegalIntents |
| [A Reduction of Imitation Learning and Structured Prediction to No-Regret Online Learning — Ross 等，2011](https://proceedings.mlr.press/v15/ross11a.html) | DAgger 与模仿分布偏移 | 需要能对新局面给动作标签的老师 |
| [Thinking Fast and Slow with Deep Learning and Tree Search — Anthony 等，2017](https://arxiv.org/abs/1705.08439) | 搜索与网络的 Expert Iteration | 适合从规则搜索逐步走向学习搜索 |
| [Mastering Chess and Shogi by Self-Play with a General Reinforcement Learning Algorithm — Silver 等，2017](https://arxiv.org/abs/1712.01815) | AlphaZero 网络、搜索、自博弈思路 | 首先限定双人两队；没有本项目棋力/资源保证 |
| [PettingZoo: A Standard API for Multi-Agent Reinforcement Learning — Terry 等，2020](https://arxiv.org/abs/2009.14471) | 顺序多智能体接口 | AEC 是接口，训练算法另选 |
| [The Surprising Effectiveness of PPO in Cooperative Multi-Agent Games — Yu 等，2021](https://arxiv.org/abs/2103.01955) | IPPO/MAPPO 与合作训练 | 合作实验不能直接推广到自由混战 |
| [Policy Invariance Under Reward Transformations — Ng 等，1999](https://people.eecs.berkeley.edu/~russell/papers/icml99-shaping.pdf) | 潜势奖励塑形 | 注意原假设、终局、折扣和多玩家边界 |

### 11.2 源码：哪些可复用，哪些只作参考

许可证栏是查阅时官方 LICENSE 的声明，不代表附带第三方组件全部使用同一许可证；落地时固定版本并保留相应声明。

| 仓库/入口 | 可用部分 | 接入成本与注意点 | 官方许可 |
| --- | --- | --- | --- |
| [SB3-Contrib](https://github.com/Stable-Baselines-Team/stable-baselines3-contrib)，[ppo_mask.py](https://github.com/Stable-Baselines-Team/stable-baselines3-contrib/blob/master/sb3_contrib/ppo_mask/ppo_mask.py) | 带动作掩码的 PPO | 最适合受限尺寸的首个学习实验；对手池需自建 | [MIT](https://github.com/Stable-Baselines-Team/stable-baselines3-contrib/blob/master/LICENSE) |
| [PettingZoo](https://github.com/Farama-Foundation/PettingZoo) | AEC 环境规范、API 测试与例子 | 需封装 Node 引擎；不提供本游戏学习器 | [MIT](https://github.com/Farama-Foundation/PettingZoo/blob/main/LICENSE) |
| [Ray/RLlib 自博弈入口](https://github.com/ray-project/ray/blob/master/rllib/examples/multi_agent/self_play_with_open_spiel.py) | 冻结策略、历史对手、人机演示 | 基于两人 Connect Four，多人和动作掩码自己适配；框架较重 | [Apache-2.0 及第三方声明](https://github.com/ray-project/ray/blob/master/LICENSE) |
| [TorchRL](https://github.com/pytorch/rl) | 多智能体 PPO、masked distribution、自定义网络 | 适合后期候选动作/团队网络；仍需训练桥与池 | [MIT](https://github.com/pytorch/rl/blob/main/LICENSE) |
| [OpenSpiel](https://github.com/google-deepmind/open_spiel) | MCTS、多方评价和 AlphaZero 参考 | 原 API 以 C++/Python 为主；此游戏需适配，AlphaZero 教学实现限双人 | [Apache-2.0](https://github.com/google-deepmind/open_spiel/blob/master/LICENSE) |
| [imitation](https://github.com/HumanCompatibleAI/imitation) | BC/DAgger 数据与训练参考 | 明确与所选 policy 的兼容性 | [MIT](https://github.com/HumanCompatibleAI/imitation/blob/master/LICENSE) |
| [MAPPO 作者实现](https://github.com/marlbenchmark/on-policy) | 论文复现和团队训练设计 | README 的 Python/Torch/CUDA 示例较旧，适合作研究参考 | [MIT](https://github.com/marlbenchmark/on-policy/blob/main/LICENSE) |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | Node/Web 推理部署 | 需要导出模型与数值/动作对齐验证 | [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) |

依赖落地时选择相容的稳定发行版并锁定版本。链接中的 master/main/latest 是阅读入口；它们会继续变化，本报告没有安装或测试上述训练库与本项目的组合兼容性。

## 12. 本次审计范围与可追溯信息

已完成：本地源码检查、main/staging 关键接口对照、headless 随机模拟与重复种子复现、论文与官方仓库/文档调研。本次交付为决策文档；策略系统、训练环境、在线 Bot 和学习模型均属于后续实施。

main/staging 的 state/commands/simulation、lobby、时钟和命令同步接口基本一致；main 的规则引擎另有地形移动表达式、收益条件等变化。训练必须使用要服务玩家的确切规则版本。

本次读取的三个关键文件 SHA-256（后续编辑将变化）：

```text
packages/game-core/src/engine.ts
E2A5667F0FBADBA5213FBA67F22E910D5A7E12F990FD396A3338B9990E2A469A

packages/game-core/src/simulation.ts
56655BFA2795169A42B13AC24681C851F90A6D2AC41EF2150AE2A544309AD7E2

packages/core-content/src/map-code.ts
D2CCA5393A212CAC2DD617081AAFB73E02915E671F3BBA7A0D6A14BABABFD409
```
