# 原版地图码导入规范

原版格式只在网页“导入地图”入口转换：`apps/web/src/maps/legacy-map-code.ts` 的 `normalizeImportedMapCode` 解码，再由 `app-runtime.ts` 交给现有地图校验、个人地图库和账号同步。共享 `parseMapCode` 仍只接受显式 `version: 1` 的当前 JSON 地图，不接受无版本 JSON，也不根据旧字符猜测 Mod。

这是单向导入。导入后保存、编辑、复制和导出使用当前 `version: 1` JSON，不生成原版编码；运行时不依赖外部参考文件。

## 二进制格式

输入为标准 Base64，允许夹带空白；解码后是 zlib 数据，通过浏览器 `DecompressionStream("deflate")` 解压。输入字符串和解压结果各限制为 64 KiB；浏览器不支持该 API 时明确报错。仅接受原版二进制版本 1，拒绝截断、非法 UTF-8、额外尾部数据和不一致的格数或玩家数。

多字节整数均为无符号 little-endian。字符串为 7-bit varint **UTF-8 字节长度**加对应字节，长度不是字符数；例如 128 为 `80 01`、255 为 `FF 01`、256 为 `80 02`。当前读取器最多读取三个长度前缀字节，并受总解压大小限制。

字段按下表顺序连续排列，无对齐填充：

| 字段 | 字节数与处理 |
| --- | --- |
| version | 4，必须为 1 |
| title、description、author | 三个长度前缀 UTF-8 字符串 |
| timestamp | 8，原版 .NET 时间戳，跳过 |
| player_num、row、column | 各 4 |
| 保留字段 | 4，跳过 |
| cylindrical_map、random_spawn | 各 1 |
| 保留字节、triple_star_turn、double_star_turn | 各 1，跳过 |
| star_mode | 1 |
| 保留字段 | 4，跳过 |
| area | 4，必须等于 `row * column` |
| battlefield | `area` 个四字节记录：`terrain, owner, strength, reserved` |
| 保留字段 | 24，跳过 |
| fog_mode | 1 |
| round_time、total_time | 各 4，跳过 |
| 重复 player_num | 4，必须与头部一致 |
| player_list | `player_num` 个记录：`seat` 1 字节、`team_mask` 4 字节、`name` 长度前缀字符串、`computer` 4 字节、`flag` 4 字节 |

## 地形、单位与玩家转换

原版地形数字成为当前地图的字符代码，并生成显式 `terrainLegend`：

| 数字 | 当前地形 |
| --- | --- |
| 0 | `core/void` |
| 1 | `core/plain` |
| 2 | `core/stronghold` |
| 3 | `core/mountain` |
| 4 | `core/ocean` |

未知数字直接拒绝，不推测 Mod。转换结果不声明额外地块 Mod 依赖。行、列和玩家位数各为 1–64。

`owner = 128` 或 `strength = 0` 不生成单位。正兵力的 `owner = 0` 转为 `wild`，`owner = 255` 转为 `blocker`；其它归属必须引用存在的原版玩家座位。玩家按原版 `seat` 升序排列，重排成连续的当前玩家位 1–N，兵力归属同步转换。座位必须唯一且在 1–127 内，虚空和山地上有单位时拒绝导入。

`team_mask` 必须恰好有一个位为 1，队伍号为 `log2(team_mask) + 1`，范围 1–32；例如 `1 → 队伍 1`、`2 → 队伍 2`、`4 → 队伍 3`。零值和多位掩码拒绝导入。

旗帜 1001–1009 对应当前 `legacy-1`–`legacy-9` 色块，依次为 `#BB5F5F`、`#7BBB5E`、`#4769C8`、`#C4B43B`、`#57AB8A`、`#CC3563`、`#53AEBB`、`#CC8138`、`#915BBF`。其它旗帜使用按重排后玩家位循环分配的九色默认色块；原旗帜身份不保存。

原版记录按 `originalIndex = row * columns + column` 排列，原版布局从底部起算、奇数行右移；当前布局从顶部起算、偶数行右移。转换先翻转行，高度为奇数时还翻转列，地形和单位使用同一转换，以保留六邻格关系：

```text
currentRow = rows - 1 - originalRow
currentColumn = rows % 2 ? columns - 1 - originalColumn : originalColumn
currentIndex = currentRow * columns + currentColumn
```

## 当前限制与提示

地图名称保留首尾去空白后的前 60 个 UTF-16 单元，玩家名称保留前 24 个；避免截断代理对，发生缩短时提示。空名称分别使用“原版地图”和“玩家 N”。地图 ID 根据完整解压数据的内容哈希生成，因此相同原版数据得到相同 ID。

原版循环地图、随机出生、星星、迷雾、电脑难度和计时不导入，使用当前系统设置；导入界面明确说明这一点，启用的原版玩法设置还会出现在导入结果提示中。作者、说明和时间戳没有当前地图字段，读取后跳过。当前胜负条件固定为 `core/lose-all-survival-anchors` 与 `core/last-team-standing`。

## “临渊”示例

用户提供的原版示例解压后为 501 字节，地图为 9 × 9、2 玩家，名称“临渊”，玩家名称 `繁星，如意`、`玩家1`，队伍 `[1, 2]`，色块 `#BB5F5F`、`#7BBB5E`。转换后单位索引如下；表中索引均从 0 开始：

| 原版索引 | 当前索引 | 当前单位 |
| --- | --- | --- |
| 37 | 43 | 玩家 1，兵力 2 |
| 43 | 37 | 玩家 2，兵力 3 |
| 4 | 76 | wild，兵力 3 |
| 30 | 50 | wild，兵力 5 |
| 49 | 31 | wild，兵力 5 |
| 76 | 4 | wild，兵力 3 |

该示例没有 blocker；原版玩法开关均关闭。原版玩家 2 的电脑难度 3、步时 60、局时 300 不进入当前地图 JSON。
