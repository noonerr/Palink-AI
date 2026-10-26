# REPORT — MVU 变量快照体量实测与自动清理必要性查验（T3）

> 状态：已完工待审读（只读查验·2026-10-26）

## 背景

- 任务：实测 MVU 变量快照体量，回答「自动清理到底需不需要」。
- 任务给出的前提：`mvu_cleanup.py` 出厂默认 `ENABLED=True` 只保留 20 层；装配回看窗口 `MVU_STAT_LOOKBACK_LIMIT=30`；设计文档 §5 要求默认关+保留至少 30。
- 本仓纪律：只读查验，全部结论带 `路径:行号` 或实际命令输出；查不到的如实说明。

## 方法

1. 读代码：`backend/app/services/mvu_cleanup.py`（清理器全文）、`backend/app/services/roleplay_prompt_assembly.py`（装配读侧 5740-5850、6080-6134）、`backend/app/services/mvu_state.py`（全文，单聊轨读侧唯一出口）、`backend/app/models/character.py:67-161`（表结构）、`backend/app/core/config.py:39`。
2. 读设计文档：`docs/SPEC_变量自动清理_MVU对齐_2026-10-05.md` §2/§5/§6/§8（注意：实际在 `docs/` 顶层，**不在**任务所述的 `docs/_active/spec/`）。
3. 数据实测：`docker exec -i palink-ai-backend-1 python -u -` + heredoc，经 `app.core.database.SessionLocal` 跑 **只读 SELECT**（全部静态 SQL，仅两处外部值用 `text()` 绑定参数传入，无拼接），在容器内用 Python 解析 JSON 后统计字节。共 6 个探针，关键命令与输出摘录见各发现。
4. 辅证：`git log -- backend/app/services/mvu_cleanup.py`（默认值翻转时间）、`docker logs palink-ai-backend-1 | grep -c MVU-...`（只覆盖容器存活期，见「未能查验」）。
5. 未执行任何写操作：无 git 提交/暂存、无 DB 写、无容器状态变更。

## 发现（逐条带证据）

### 1. 任务前提已过期：默认值 2026-10-25 已改为「关 + 保留 50」，且当前实际处于关闭状态

- `backend/app/services/mvu_cleanup.py:62-65`：`DEFAULT_ENABLED = False`、`DEFAULT_SNAPSHOT_INTERVAL = 50`、`DEFAULT_KEEP_RECENT_FLOORS = 50`、`DEFAULT_RESTORE_FLOORS = 10`；`:53-61` 注释明说这是 [MC-D 2026-10-25] 有意偏离插件默认（原「启用=true / 保留 20」），理由是 SPEC §6 红线与 [P1-2] 实害（回看 30 > 保留 20 ⇒ 第 21~30 楼快照被静默吃掉）。
- 翻转时间佐证：`git log` → `36f75fa 2026-10-25 01:26:13 +0800 feat(杂项批): … MC-D 清理危险默认 …`。
- 显式设置覆盖面实测（探针 F）：全表扫 `user_settings.silly_tavern_settings` → `plugin_extension_settings_by_character[<卡>].mvu_settings.自动清理变量`，输出 `F_USERS_WITH_EXPLICIT_CLEANUP n=0` ⇒ **没有任何用户显式配置过**，生效参数就是默认值 ⇒ `enabled=False`，**自动清理现在不跑**。
- 设计文档 §5 建议的「启用=false（先默认关）、保留最近楼层数=50」**已经落地**，不是待办。

### 2. 楼层分布实测：最大 102 层，不存在「两三百层」的会话（探针 A，2026-10-26）

命令：按 `session_id, branch_id` 与单 `session_id` 两个口径 GROUP BY 计数（楼层/分支是清理与读侧的真实分区口径，`mvu_cleanup.py:366-385`、`mvu_state.py:126-162` 均按分支过滤）。

```
A_TOTAL_MESSAGES = 248
A_BRANCHES  n=33 max=101 median=2.0 avg=7.5
A_SESSIONS  n=32 max=102 median=2.0 avg=7.8
A_BRANCH_gt_50 = 2    A_SESSION_gt_50 = 2
A_BRANCH_gt_100 = 1   A_SESSION_gt_100 = 1
A_BRANCH_gt_200 = 0   A_SESSION_gt_200 = 0
A_BRANCH_gt_300 = 0   A_SESSION_gt_300 = 0
```

- 用户「对话最多两三百层」的印象与现状不符：超过 100 层的会话**只有 1 个**（102 层），200+ 为 0。中位数 2 层。
- 增长速度（探针 E4）：总消息 248，其中 `created_at >= 2026-10-05` 的 142 条 —— 21 天涨 142 条 ≈ **7 条/天**。SPEC §2（10-05 实测）为 91 条，口径吻合。

### 3. 快照体量实测：变量全库 84 kB，补丁 74.6 kB；占 extra 的 7%，占库的 0.1%（探针 B/C/E2）

表结构（先查后算）：`character_chat_messages.extra` 为 **Text** 列（`backend/app/models/character.py:151`，JSON 字符串），快照在 `extra["variables"]`，重演原料在 `extra["mvu_patch"]`；会话级在 `character_chat_sessions.chat_metadata`（`character.py:80`）。

探针 B 输出（字节 = UTF-8 序列化长度）：

```
B_MESSAGES_WITH_EXTRA n=230 total_extra_bytes=1200385 avg=5219
B_WITH_VARIABLES      n=101 total_vars_bytes=84375  avg=835  max=5729
B_WITH_STAT_DATA      n=38  total_stat_bytes=82785  avg=2179 max=5714
B_ANCHORS n=0  PRUNED n=51  PATCH n=71 total_patch_bytes=74555 max_patch_bytes=2152
B_TOTAL_CONTENT_BYTES = 180917
B_TABLE_SIZES msg=3608 kB sess=280 kB
B_TOP_SESSIONS_VARS_BYTES = [('40d9b7cc', 31571), ('f25daab6', 21549), ('c6182e89', 11381), ('c976912e', 11225), ('b9e7e92a', 5729)]
C_SESSION_META_WITH_VARS n=15 total=34159 max=5729 with_stat_data n=11
```

- 全库大小（探针 1）：`db_size: 79 MB`（SPEC §2 十天前为 44 MB）。
- 变量快照（`variables` 含 `stat_data`）合计 **84,375 B ≈ 82 kB**；单楼最大 5,729 B。会话级 `chat_metadata.variables` 合计 34 kB（不随楼层累积，每会话一份）。
- **extra 的大头根本不是变量**（探针 E2，按 extra 最大的 8 条消息聚合）：`swipe_info` 169,897 B + `reasoning` 135,831 B 遥遥领先，`variables` 只有 6,726 B；全库口径：extra 1.2 MB ≈ 变量 84 kB（7%）+ 补丁 74.6 kB（6%）+ **其余 ~87% 是 swipe_info/reasoning/ext_prompts 等清理根本不碰的东西**。
- 对照 SPEC §2 的旧实测（10-05）：extra 289 kB / 变量 33 kB → 现在 1.2 MB / 84 kB，涨的主要也是 swipe_info/reasoning，不是变量。

### 4. 「保留 20 < 回看 30」的实害不是理论，库里就有（探针 D1/D2/D3）

探针 D1：51 条带 `variables.pruned=true` 标记的消息，分布 `{'f25daab6': 39, '40d9b7cc': 12}` —— **自动清理在旧默认期（~10-05 接线至 10-25 翻转）真实运行过**（`pruned` 标记只由 `prune_variables` 写入，`mvu_cleanup.py:226`）。

探针 D2（最大分支 `f25daab6`/分支 `30251f44`，101 层，从尾数 30 条逐位标注：S=有 stat_data，P=pruned 标记，p=有 mvu_patch）：

```
D2_BRANCH sess=f25daab6 bid=30251f44 floors=101 whole_extra_bytes=674477
D2_LAST30_POS1:Sp 2:- 3:Sp 4:- 5:Sp 6:- ... 21:Sp 22:- 23:-Pp 24:- 25:-Pp 26:- 27:-Pp 28:- 29:-Pp 30:-
```

- **从尾数第 23/25/27/29 位（正落在回看 30 窗口内的 21-30 段）的助手楼已被清掉 `stat_data`**，第 21 位及更新仍在。边界与 `keep=20` 逐楼吻合：最后一次自动触发在 F=100（`should_auto_prune` 要求楼数是 5 的倍数，`mvu_cleanup.py:288-290`），窗口终点 `n = 100-20 = 80`（`auto_prune_window`，`mvu_cleanup.py:281-285`）⇒ 楼号 ≤80 被清、81 保留，与「尾数 23 位=楼 79 被清、尾数 21 位=楼 81 保留」完全一致。
- 即：**若旧默认仍在，用户往回翻 21-30 楼看到的就是被清空的变量** —— [P1-2] 描述的实害在真实数据里可复核。

探针 D3（被清且**无补丁**的楼层）：

```
D3_PRUNED_WITHOUT_PATCH n=8
D3_ROW (2616, '40d9b7cc', 'a9718a0b', 3, 54, 2646, ['pruned'])
D3_ROW (2618, …, 5, 54, 2646, ['pruned'])   D3_ROW (2620, …, 7, …)  D3_ROW (2622, …, 9, …)
D3_ROW (2629, …, 13, …)  D3_ROW (2631, …, 15, …)  D3_ROW (2640, …, 21, …)  D3_ROW (2644, …, 25, …)
```

- `40d9b7cc` 分支第 3~25 楼位共 **8 楼被清后既无 `mvu_patch` 也无更早的 stat_data 基线**（探针 E1：该分支开头 msgid 2612/2615 的 `varstat=False`），重演原料为零 ⇒ 对这些楼位的 as-of 取值永久返回空（见发现 6 的行为）。清后 `varkeys=['pruned']` 反推它们原本持有完整 `stat_data` 等字段 —— **这部分按楼显示的状态数据已被清理不可逆地抹掉**（仅显示层面；生成注入有下一基线兜底）。
- 探针 D4 反常点：全库锚点（`variables.snapshot=true`）**为 0**。原因是 101 层分支的第 50/100 楼恰好都是无变量的用户消息（`varkeys=None`），而打锚只发生在「有 variables 且 floor%50==0」的楼上（`mvu_cleanup.py:216-219`）⇒ **锚点机制在本库实际从未提供过保护**，可恢复性完全靠 `mvu_patch` 补丁重演（补丁不被清理：`PRUNED_FIELDS` 只是 `variables` 内的字段清单，`mvu_cleanup.py:68-74`；docstring `:19-20` 明示 prune 不碰补丁；实测 71 条补丁都在）。

### 5. 楼层/回看窗口读侧的行为：群聊轨静默回落，单聊轨重演+留痕（代码行号）

- **群聊轨** `_load_effective_stat_data`（`roleplay_prompt_assembly.py:5773`，仅 `group_id` 在场时走，`:6105-6111`）：按 `created_at desc` 取最近 `_lookback` 条（默认 30，`backend/app/core/config.py:39` `MVU_STAT_LOOKBACK_LIMIT: int = 30`；`:5812-5817`），窗口内无非空 `stat_data` ⇒ **静默回落** `_load_session_stat_data`（`:5850` → `:5741-5770` 读 `chat_metadata.variables.stat_data`）——不报错；只有抛异常才 `logger.warning`（`:5841-5848`）。按 `mvu_state.py:11-14` 的取证，那份会话级值与任何楼层真实状态都不等，属「无来源的当前值」。**当前暴露面 = 0**：探针 E3 `E3_GROUP_CHATS total=1 with_vars=0`。
- **单聊轨**（2026-10-22 批次 MS-1 起，`roleplay_prompt_assembly.py:6112-6121`）：`resolve_stat_data_as_of`（`mvu_state.py:232-338`）逐楼推进：有非空 `stat_data` ⇒ 权威基线（`:282-288`）；否则有 `mvu_patch` ⇒ 应用补丁（`:290-301`）；两者都无 ⇒ 记入 `missing_floors`（`:303`）。全程无原料 ⇒ `stat_data=None`（`reason=empty`，`:305-313`），调用方拿 None ⇒ `_flatten_stat_data` 为空 ⇒ **不注入，静默跳过**（`roleplay_prompt_assembly.py:6122-6123` `if _flat:`）。部分缺原料 ⇒ `reason=replay_partial` 并 `logger.warning("[MVU-STATE-UNAVAILABLE] …")`（`:315-326`），**绝不回落会话级**（`:20-27` 三条硬规则；仅「单分支会话+最新视点」允许 trunk_live 兜底，`:165-192`）。
- 回答任务问句「静默回落还是报错」：**都不报错**。群聊轨是静默回落（危险形态，好在当前无群聊变量数据）；单聊轨是重演优先、降级留痕（可 grep 到 `[MVU-STATE-UNAVAILABLE]`）、末端不注入。

### 6. 查询/生成侧的真实成本：全分支重演扫描，清理只能减 ~5%，与清理基本无关

- `resolve_stat_data_as_of` 的取数 `_effective_rows`（`mvu_state.py:126-162`）**没有任何 LIMIT**，加载整个分支（含可确认祖先链）全部行并逐行 `json.loads` extra。实测（探针 D2）：101 层分支 `whole_extra_bytes=674477` —— **每轮生成解析 674 kB JSON**；会话越长成本线性涨。
- 但这 674 kB 里变量只占 31,571 B（4.7%，探针 B_TOP_SESSIONS），补丁约 10 kB，**其余 ~95% 是 swipe_info/reasoning** —— 即使把清理开到满、把所有非锚变量全摘光，扫描字节也几乎不变。**「不清理的查询代价」与「清理」是两条不相交的曲线**：清理保护的是存储（而存储里变量又只占 7%），不解决重演扫描成本。
- 真要降扫描成本，有效做法是裁扫描起点（重演只需从「最后一个 stat_data 基线」开始，基线是权威完整态，之前的行对最新视点无贡献）——这是读侧代码优化议题，不属于清理议题，是否立项待主脑裁定。

### 7. 文档矛盾一处，待主脑裁定

- `mvu_state.py:37-40` 文档串仍写：「上游四项参数一律不动：`启用=true / 快照保留间隔=50 / 保留最近楼层=20 / 触发恢复楼层=10` 由老板裁定保持上游默认值」。
- `mvu_cleanup.py:53-65`（提交 `36f75fa`，2026-10-25 01:26）却是 [MC-D] 改为 `False / 50`，并援引 SPEC §6 红线。
- 按时间顺序 MC-D（10-25）晚于 mvu_state 文档串（10-22），且 `resolve_cleanup_settings` 实际返回的是 False/50（`:123-179` 读不到显式设置时落 `CleanupSettings()` 默认值）——**运行行为以 False/50 为准**，但这属于两处文档对同一裁定的记载冲突，哪份是老板最终口径请主脑裁定（只影响文档订正，不影响本次实测数字）。

## 结论与建议（大白话）

1. **自动清理现在就是关着的，而且应该保持关。** 默认 `ENABLED=False`（`mvu_cleanup.py:62`）+ 全库无人显式开启（探针 F n=0）⇒ 生产当前不发生任何清理。任务前提「出厂默认 True/保留 20」是 2026-10-25 之前的旧状态。
2. **按实测数字，清理的收益 ≈ 无足轻重。** 全库变量快照 84 kB + 补丁 74.6 kB ≈ 159 kB，在 79 MB 的库里占 0.2%；即使按 SPEC §2.4 的增长模型外推，300 层会话 ≈ 150 个助手楼 × (2.2 kB 快照 + 1 kB 补丁) ≈ **0.5 MB/会话**，Postgres 毫无压力。而清理只省变量那部分（extra 的 7%），extra 的 87% 是 swipe_info/reasoning，清理碰不到。
3. **「保留 20 < 回看 30 曾真实造成状态不一致」——成立，有实物证据。** 101 层分支从尾数 23-29 位的快照被清（边界与 keep=20 逐楼吻合）；更严重的是 `40d9b7cc` 有 **8 楼被清且无补丁无先前基线，永久不可还原**。这套实害正是 [MC-D] 把默认改关/改 50 的依据，改得对。
4. **推荐：维持「默认关 + 保留 50」，不要再调参。** 50 ≥ 群聊轨回看窗口 30（SPEC §5 建议、§3.2 硬约束）已满足；单聊轨读路径（MS-1 重演）根本不依赖 30 楼窗口，所以对单聊轨而言保留值只影响「无补丁楼」的显示可还原面——真正的安全键是**补丁留存**（清理不碰补丁），不是快照保留数。把保留改成 100/200 收益同样趋近于零。
5. **如果未来真出现 300+ 层常驻会话**，优先级应为：① 重演扫描起点裁剪（从最后一个 stat_data 基线起扫，消掉 O(全分支) 的每轮成本，待立项）；② 要省存储先盯 swipe_info/reasoning（extra 的 87%）；③ MVU 清理排在最后——它既不省大头也不省查询，且已被证明会制造不可还原空洞。
6. **顺手要修的账**：① SPEC 文档实际在 `docs/` 顶层，任务与 `mvu_cleanup.py:12` 引用的 `docs/_active/spec/…` 路径不存在（按文档规范属待归档位）；② `mvu_state.py:37-40` 的「上游默认不动」文档串与 [MC-D] 矛盾，待主脑裁定后订正。

## 未能查验

- **历史清理/重演的发生频次无法从日志证实**：`docker logs palink-ai-backend-1` 只覆盖容器存活期（当前实例 Up 3 小时），`grep -c "MVU-CLEANUP"` 与 `grep -c "MVU-STATE-UNAVAILABLE"` 均为 0，只能说明最近 3 小时没有发生，不能证明历史上没发生——历史发生已改用数据侧 `pruned` 标记（51 条）证实，见发现 4。
- `docs/_CATALOG.md` 因新增本报告必然 STALE，但目录刷新会写 `_CATALOG.md`（超出本任务「只许写报告文件」的边界），未执行；留待有写权限的 agent 跑 `py scripts/docs/gen_docs_catalog.py`。
- 其余任务所列事项（楼层分布/快照体量/回看空洞/装配行为/结论建议）均已实测查验。
