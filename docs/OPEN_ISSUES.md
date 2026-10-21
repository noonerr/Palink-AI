# OPEN_ISSUES.md — 待解决问题清单（按危险程度分级）

> 建立日期：2026-10-05。**本文档只装"知道有问题、但还没解决/还没做完"的东西。**
> 已完成的条目请回填到 `TODOS.md`，完成后从本文移除。
>
> 🔖 **找文档先看** [`docs/_INDEX.md`](./_INDEX.md) —— 那是 docs/ 的检索入口与可信度分级。
> 本文只管"还没解决的事"，不管"哪份文档还能信"。
>
> ## 为什么不写进 TODOS.md
> `TODOS.md` 同时是"任务列表"和"历史档案"，双重身份会让状态标签僵尸化——
> 决策已在别处关闭、原条目仍标"待拍板"，后来 agent 照着重做。
> （已确认的三种僵尸形态见项目记忆 `project-todos-zombie-status`。）
> **本文档只进不出的短期台账**：每条都有"现在该做什么"，没有"历史包袱"。
>
> ## 分级口径
> 分级看**后果严重度 × 发生概率**，不是看修复难度。
>
> | 档位 | 含义 | 该怎么对待 |
> |---|---|---|
> | **P0 火烧眉毛** | 正在造成数据损失、封控风险、或用户完全无法使用 | 立刻停下手上的事做这个 |
> | **P1 高危待做** | 明确有缺陷，用户可感知，但有绕行方式或损失有限 | 排进近期批次 |
> | **P2 有更重要的事先放着** | 知道有缺陷，但当前有更高优先级的事项占用精力 | 不主动开工，被问到时如实说明 |
> | **P3 已知·主动不做** | 看过、评估过，**主动决定**暂时不修 | 不要反复提议；只有条件变化才重开 |
> | **P4 待查** | 只是怀疑/观察到异常，**尚未定性**，甚至可能不是 bug | 不要当 bug 修；先取证 |
>
> ⚠️ **P2 与 P3 的区别**：P2 是"优先级问题"（迟早要做），P3 是"决定不做"（已关闭）。
> 混用会导致已关闭的事被反复捡回来。

---

## P0 火烧眉毛

> ⚠️ **P0 段的信息时效性最强。接手前先确认"核实时点"是否已过期。**

### ~~[P0-0] 记忆注入恒为 0：`retriever.py` 一行元组解包写错~~ · ✅ **已修复、已入库（2026-10-17 复核）**

> 本条**已施工完毕并入库**。修复代码在 HEAD（`retriever.py:205-213` 带 `[TUPLE-UNPACK-FIX 2026-10-07]` 标记，随 `9e9692d` 等提交在主干）。
> 原文“未提交 git”已作废。唯一历史剩余项“真机验收”已被 2026-10-15/16 的 S5 实机评估批次覆盖（生产对话流正常，未见检索异常）。
> 修复/验证/变异对照全过程见报告 §1.7。备份 `_BACKUPS/2026-10-07_记忆注入元组解包修复/`。

- **核实时点**：2026-10-07（一手实测，见 [`docs/_active/report/REPORT_线上三问题排查_变量展示_记忆注入_功能按钮_2026-10-07.md`](./_active/report/REPORT_线上三问题排查_变量展示_记忆注入_功能按钮_2026-10-07.md) §1）。
- **事实**：`backend/app/memory_module/retriever.py:134-137` 对 `semantic_search` 的返回值
  （`List[Tuple[MemoryEntry, float]]`）按 `m.message_id` 取字段 ⇒ 必然 `AttributeError`；
  异常被同函数 `:181-190` 兜住并返回空结果 ⇒ **动态上下文一个字都不注入**（连 STM 一起丢）。
- **证据（生产日志原文）**：
  `语义检索完成: 找到 50 条记忆，最低相似度: 0.5983…` 紧接 `检索记忆失败: 'tuple' object has no attribute 'message_id'`。
  ⇒ **向量引擎是好的**（Ollama bge-m3 1024 维在位、665/723 条带向量），坏的只是组装。
- **触发条件**：`exclude_message_ids` 非空（正常聊天必非空，取最近 5 条消息 id）+ 语义候选非空
  ⇒ **任何有历史的会话，记忆注入恒为 0**。
- **引入**：2026-08-29 `ff9c1e7`（"记忆 STM 去重"）。
- **接手动作**：改成 `(mem, sim) for mem, sim in semantic_candidates if mem.message_id not in exclude_ids`；
  补一条"候选非空 + exclude 非空"的回归用例（该链路目前零测试覆盖）。
- **✅ 已完成**：改完；补 `test_memory_exclude_recent.py::TestLtmExcludeWithRealEmbeddings`（2 例）；
  变异验证通过（回退后**恰好新增 2 例红、原有 5 例仍绿**）；
  `pytest tests/` **1924 passed / 44 skipped / 0 failed**；
  `docker compose build backend && up -d backend` 已执行，容器内 grep 命中（`TUPLE-UNPACK-FIX`）。
- **⭐ 值得记的教训**：既有 5 条测试**全绿却没拦住这个 P0** —— 它们插入的记忆 embedding 全为 NULL，
  而 `semantic_search` 的 SQL 带 `AND embedding IS NOT NULL` ⇒ 候选恒空 ⇒ 出错行从未执行。
  测试注释还把它写成"嵌入不可用 → LTM 为空属预期"，**把 bug 的触发条件当成了预期行为**。
  ⇒ 判据：写"降级/空"类断言前先问一句"这条是不是正好绕开了我要测的分支"。

---

### [P4-4] DB 里有 8 条保留着 `<UpdateVariable>` 原块 · **A 组（5 条）已确证、B 组（3 条）未定性**

- **事实**：`SELECT … WHERE content LIKE '%<UpdateVariable>%'` → **8 条**。按落库特征裂成两组：

| 组 | 条数 | 长度 | 位置 | extra | 定性 |
|---|---|---|---|---|---|
| A | 5 | **2385 完全相同** | 4 条是会话第 1 条 | 只有 `swipe_info` | ✅ **确证 = 开场白路径不跑剥离** |
| B | 3 | 3130/3171/3458 | 第 82/74/64 条 | `variables`+`mvu_patch`+`gen_id`+`model` 齐全 | ⚠️ 未定性 |

**A 组（已定性，不用再查）**：开场白走 `character_ext.py:3065 POST /messages`，
**既不跑 MVU 解析也不调 `strip_update_variable_blocks`**。这与
`SPEC_卡状态面板取不到数据_三层根因修复_2026-10-06.md` §2.1「层三｜写入口不对称」
**逐字吻合**——那份 SPEC 当时就点名了 2740/2741，而 2741 正在本组。
⇒ **它不是新 bug，就是那份 SPEC 里的 F-A2（写入口收敛），尚未施工。**

**B 组（未定性，不要凭推测改代码）**：MVU 明明解析成功了（有 `variables`+`mvu_patch`），
正文却没剥。**已实测排除 4 种直觉假设**：①标签未闭合（8 条全部 open=1/close=1 配对）；
②被 ``` 围栏包住（块前 60 字符全部无围栏）；③剥离点覆盖不到（5 个生成入口
`websocket.py:791` + `character_ext.py:4880/6098/6237/6592` 全都有调，且第二遍是
可跨行的内联正则，本形态必然命中）；④块在文中难剥（实际几乎贴着文末，最好剥的形态）。
⇒ 只剩"这条 content 不是由剥离后的内容写入的"这一种可能。**下一步**：查 3 条的 `gen_id`
与相邻消息关系，确认是否对应一次被中断/被 PATCH 覆盖的生成；或在 4 处剥离点加
「剥离前后长度」日志跑一轮。

**⚠️ 剥离机制本身（回答"是不是按语义剥离"）**：**不是语义，是纯正则/模板匹配。**
`strip_update_variable_blocks` 四道工序里三道是纯字符串匹配
（整行正则 / 内联正则 / 围栏配对状态机），只有"裸 JSON Patch"那道带
`_looks_like_stat_data_patch` 结构校验（判断"像不像补丁"以降低误伤，仍非语义）。
⇒ 模型只要换写法（`<update variable>` 带空格、HTML 实体转义、标签未闭合）就会漏。
详见报告 §7.4。
- 顺带：**"AI 输出入库截断"经实测证伪**（content == swipes[-1] 12/12、列无上限、max_tokens=16384、
  结尾字符无半截特征）；体感来源是**落库前剥离**导致"刷新后变短"，不是截断。见报告 §7。

### ~~[P0-1] alembic 0068 迁移脚本未入库，但生产库**已经**升到 0068~~ · ✅ **已修复（2026-10-17 复核关闭）**

- **核实时点**：2026-10-05。**2026-10-17 复核**：脚本已入库（`85aa3ca`，2026-10-10 23:34「fix(db): 修复 P0-1 —— alembic 0068 迁移脚本入库（迁移链断裂）」），`git ls-files` 命中；DB 实测 `alembic_version = 0068_add_mvu_secondary_params` 与脚本一致 ⇒ **脚本与生产库已对齐，本条关闭**。
- 历史（留档）：DB 曾实测已升 0068 而脚本在 `git status` 里是 `??` 未跟踪 ⇒ 脚本一旦丢失，新环境无法重建到 0068。现风险已消除。

---

### [P0-2] 工作区文件级归属已不可辨 · ⚠️ `git checkout -- <file>` 在本仓库会连带回滚别人的在制品

- **核实时点**：2026-10-05。
- **事实**：已提交的三波 MVU 成果（`c24017d` / `4c512d8` / `a877013`）**本身就是从脏工作区里用 hunk 过滤、
  手工构造索引 blob 挑出来的**（见 `REPORT_MVU补齐第三波…md` §6，用了 `_stage_only_mine.py` 等脚本）。
  同节记录了一次真实事故：`02:54:48` 另一个 agent 重建 dist 时**抓走了改到一半的源码**。
  工作区里 `Message.tsx`、`character_ext.py`、`CharacterChat.tsx` 等文件**同时存在于已提交与未提交两侧**。
- **为什么是 P0**：这是一条**纪律红线**，不是功能缺陷。任何 agent 照着 `REPORT_MVU补齐第三波` §6.5 的
  "文件级零重叠"复核命令行事都会误判——**那条命令现在期望为空已经不成立**（`comm -12` 必然有输出）。
- **现在该做什么**：接手前**先重跑那条 `comm` 对比**再决定动作；
  提交一律带 pathspec，**禁止 `git add -A` / `git add .`**（多 agent 合住仓库）。
  `TODOS.md` 早就写了这条禁令，至今仍成立。

---

## P1 高危待做

### [P1-0] 卡自带状态面板取不到数据（读侧不供给 `data`）· ⚠️ 核验完成，待拍板，未开工

- **核实时点**：2026-10-07（可行性核验见 [`docs/_active/report/REPORT_卡状态面板取不到数据_可行性核验与施工决策_2026-10-07.md`](./_active/report/REPORT_卡状态面板取不到数据_可行性核验与施工决策_2026-10-07.md)）。
- **一句话**：后端把状态算出来了，但前端把消息交给卡的 5 处出口**都不输出 `data` 键**，
  而卡读的是 `chat[楼].data.stat_data`（ST 生态存放位）。⇒ 这类卡的面板**永远出不来**，
  不是某张卡的偶发。
- **为什么是 P1**：用户可感知（导入即红字 `无法加载状态数据 (messages empty)`），
  且**结构性**（聊下去也不会好）。
- **现在该做什么**：等老板拍 3 个决策点（F-D1 落点改判 / F-E1 空壳 vs 提示 / 后端是否等收工）后开工。
  规格书 [`SPEC_卡状态面板取不到数据_三层根因修复_2026-10-06.md`](./_active/spec/SPEC_卡状态面板取不到数据_三层根因修复_2026-10-06.md)。
  ⚠️ **F-A2/F-B1/F-C1 撞另一条 MVU 工作流**（`mvu_engine.py`/`mvu_secondary.py`/`character_message_builder.py`/`websocket.py` 均脏）⇒ 建议等其收工。

---

### [P1-1] 出图桥接三道外部关卡 + 三个坑 · ⚠️ 2026-10-03 复核确认仍未修

- **一句话**：文生图功能卡在外部依赖上，链路走不通。
- **为什么是 P1**：用户已拍板要做，且"装了 ComfyUI、登录网站就能直接出图"是产品底线。
- **⚠️ 用户裁定「功能未完工前暂缓」——别主动重提这条。** 解除暂缓后再按此开工。
- 证据/详情见 `TODOS.md` 出图桥接相关条目与项目记忆 `project-imagegen-bridge-gates`。

### [P1-2] MVU 变量自动清理：已施工、**已烤进运行中的容器**、零真机验证，且默认值危险

- **核实时点**：2026-10-05。
- **做什么**：1:1 照抄 MVU 插件的 `Za()`/`Ya()` 清理+恢复算法，三触发入口
  （WS + SSE 自动清理、删消息后恢复、`POST /{sid}/mvu-cleanup` 手动）。
- **代码**：`backend/app/services/mvu_cleanup.py` —— ⚠️ **2026-10-17 复核**：已入库（`aecf216` 批次A，2026-10-10），原文「未跟踪」作废；后端镜像（10-11 构建）包含本文件，**线上跑的就是入库后的这份代码**（不是"未提交代码"）。
- **两个具体危险**：
  1. **未真机验证**：每 5 楼清理真发生 / 删消息后恢复真补回 / 手动端点，**三项仍未验**（2026-10-17 复核状态未变）。
  2. **默认值与设计文档直接冲突（仍在）**：`mvu_cleanup.py:46-49` 是 `DEFAULT_ENABLED = True` /
     `DEFAULT_KEEP_RECENT_FLOORS = 20`；而 `SPEC_变量自动清理_MVU对齐_2026-10-05.md` §5 + 红线 5
     明确要求**默认关闭 + 保留 ≥30（建议 50）**，因为 `roleplay_prompt_assembly.py:5232` 的
     `MVU_STAT_LOOKBACK_LIMIT = 30`。**回看窗口 30 > 保留 20 ⇒ 第 21–30 楼快照被清 ⇒ 静默回落到会话级，分支状态不一致。**
     2026-10-17 实测两个默认值一字未改。
- **⚠️ 这条曾被明确标为"须先问用户，不要自作主张"**（`PROMPT_MVU兼容补齐_交给Agent_2026-10-05.md` §3 P3-e），
  **然后就没有下文——没人问、没人改、也没人记。** 清理是**不可逆破坏性操作**，测试
  `test_defaults_match_plugin_schema` 还把危险默认值钉住了。
- **未做**：插件首次启用的「三选一弹窗」与 `ignore_cleanup` 标记位。
- **接手动作**：先问用户拍板默认值（关闭还是开启、保留多少层），再动代码；真机验证三项。

---

### [P1-3] 清理默认值待拍板：见 [P1-2] 第二点（单列，因为它是**决策**不是代码问题）

- **为什么单列**：`P1-2` 是"代码状态"，这条是"没人做那个决定"。
  修代码容易，**没人拍板才是真堵点**。

---

### [P1-4] 变量变化面板 + 插件变量接线 · 已烤进 dist 但全部未提交

- **核实时点**：2026-10-05。
- **做什么**：新建 `VariableChangePanel.tsx/.css`、`cardVariables.ts`；把卡脚本的写口族从 2 个补到 7 个
  （`replaceVariables`/`updateVariablesWith`/`insertOrAssignVariables`/`setChatMessage`/`deleteVariable`
  原本是裸 `undefined`，MVU 管线每轮抛 ReferenceError）。
- **状态**：⚠️ **2026-10-17 复核**：文件已入库（`8df6ebe` 批次B，2026-10-10 23:17），原文「全部未跟踪/未提交」作废；当前 dist（今日重建）中面板已接线（`Message.tsx` import 在），旧条目所称 `index-DOHGrsVB.js` 为历史残留 chunk。
- **未做**（2026-10-17 复核仍成立）：① `replaceVariables` 的**真实写入**未开放（仍只登记不写）；
  ② 前端 3 套冗余变量壳（`legacy-st-sim`/`inline-st-globals`/`sandbox`）未收敛；③ 未真机验证面板是否可见。
- **接手动作**：先提交，再开真实写入，最后真机验收。

---

### [P1-5] 副模型参数放开 + 重试（含 alembic 0068）· 已施工未提交

- **做什么**：`mvu_secondary_temperature/max_tokens/retries` 三列贯通
  `models/system.py` → `schemas/user.py` → `api/users.py` → `api/character_ext.py`，含防呆夹紧
  （temp 0–2 / tokens 256–8192 / retries 0–3）。
- **状态**：⚠️ **2026-10-17 复核**：8 个文件均已入库（`aecf216` 批次A 等，2026-10-10；含迁移脚本 `0068`，即已关闭的 [P0-1]），原文「8 个文件未提交」作废。防呆夹紧（temp 0–2 / tokens 256–8192 / retries 0–3）随入库保留。**真机验证仍未做**。
- **接手动作**：真机验证三列贯通（保存→回读→生成生效）。

---

### [P1-6] `mag_command_parsed` 事件从未实现 —— 卡作者唯一官方纠错钩子

- **承诺**：`SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md` §4⑤ 列为 P0 最值钱项，
  理由是它是"卡作者修正模型输出错误的唯一官方钩子"。
- **实际**：`REPORT_MVU补齐第一波` §7 明确写「**未实现**」。其余 4 个 `mag_*` 事件已全部落地
  （含契约里 `mag_variable_initiailized` 的原始拼写错误也照抄）。
- **卡点**：需 patches 下发到前端，而 SPEC §7 局限 2 写明「**是否随消息接口下发到前端未确认**」
  （需查消息序列化是否白名单过滤 `extra` 键）。
- **为什么不是 P4**：这是**唯一查实"文档承诺 P0、代码零对应"**的一条。承诺悬空 = 卡作者体感缺失。

---

### [P1-7] 变量编辑面板只写会话级 · 回看历史楼层仍显示改前值（已知限制，未处理）

- **事实**：`4c512d8` 的写入端点已上线。`REPORT_MVU补齐第三波` §7 遗留 3 记载：
  手动改值只写会话级 `chat_metadata.variables`，**不回写消息级快照** ⇒ 往前翻历史楼层仍是改前值。
- **文档判定"设计上正确"**，但**用户手动改完变量、往前翻楼层看到旧值，几乎必然被当成 bug 报**。
- **接手动作**：要么改实现，要么显式登记为已知限制并在 UI 上说明。

---

### [P1-8] ~~首屏弱网白屏~~ · ➡️ **已由并行 agent 登记为 [P2-2]，本条作废勿重复做**

- 首屏 638KB 入口那条，另一位 agent 已完整登记在 **[P2-2]**（含实测方法、KaTeX 已否决的三个理由、下一步三选项）。
  本条于 2026-10-05 撤回，**以 [P2-2] 为准**。

---

### [P1-9] 报错提示模板落地 阶段一改皮 + 批1止血 · `[已施工·待真机验收]`

- **来源**：`TODOS.md`（标 `[已施工·待真机验收]`）。
- **⚠️ 引用旧数字前先重跑基线**：口径已从 1599 → 1673 → 1688 三连跳。

---

### [P1-10] 插件设置轴复核 + 批次1/2修复 · 标签僵尸（代码已上线但记录说"未上线"）

- **来源**：`TODOS.md` 标 `[已施工·⚠未上线·⚠未真机验证]`，自述"后端未 rebuild、前端 dist 未重建"。
- **⚠️ 该状态已过时**：实测容器里 grep 到 `mvu_secondary_temperature` 等新标记，且容器 md5 == 宿主 md5
  ⇒ **代码已上线**，只是**没人回来改标签**。典型僵尸条目。
- **接手动作**：**不是重新施工**，是重新验证 + 改标签。

---

### [P1-11] 记忆语义切分**完全失效** · ✅ 已改配置，待真机验收

- **核实时点**：2026-10-07（一手实测）。
- **事实**：`CHUNK_DISTANCE_EPSILON = 0.12`，而 bge-m3 在本项目语料上相邻句余弦距离实测
  **max=0.1010 / mean=0.0703 / p99=0.0976（n=191）** ⇒ 命中率 **0.0%** ⇒
  `_detect_breakpoints` **断点恒为 0** ⇒ `semantic_split` 返回单块（1322~1700 字）
  ⇒ 实际由末尾「超 `CHUNK_MAX_CHARS` 强制再分」切成 440 字块
  ⇒ **退化成"按 450 字在句边界硬切"，语义切分形同虚设**。
- **根因公式**：判定下限是 `floor = max(epsilon, mean(dists))`，epsilon 一旦低于文本 mean
  就由 mean 主导（自适应）。0.12 高于实测 max，等于**把自适应机制废掉**。
  实测：阈值 0.075 一路降到 0.050，结果**完全不动**（6.8 块/均 230/134~441），证明此时由 mean 主导
  ⇒ **epsilon 只该当"兜底下限"，不该当主阈值**。
- **已改**：默认值 `0.12 → 0.05` + 重写误导注释（`config.py:45`）；已重建后端容器。
  备份 `_BACKUPS/2026-10-07_记忆语义切分阈值/`。测试 219 passed。
- **离线正反对照（同批消息只换阈值）**：
  - 块内内聚度 0.5467 → 0.5534（**仅 +1.2%**，**推翻"块内更聚焦"的预期**——连续剧情本就语义渐变）
  - **话题分离度 margin 0.0376 → 0.0638（+69.9%）** ← 真正收益是"块与块更分得开"
  - 块数 24 → 43（**+79%** 存储增长）
- ⚠️ **局限**：样本仅 6 条、margin 是代理指标 ⇒ **真机召回质量待验收**（改回 0.12 做反向对照）。
- 📌 **存量 723 条按用户裁定暂不重算**（仍按 450 硬切）；将来要一致可参照
  `backend/scripts/reembed_all_to_bge_m3.py` 做"重切+重嵌"，低峰做且先备份记忆表。
- 报告 §8。

---

### [P1-12] 后端容器镜像落后 6 笔提交（10-11 构建，未重建）· 2026-10-17 实测

> ✅ **2026-10-18 已关闭（包 C 施工）**：镜像已重建 4 次（`docker compose build backend` +
> `up -d backend`），上表 6 笔提交全部上线，且包 C 追加了 13 条 ST Extras 端点。
> 真机复验：`/api/summarize`、`/api/translate/*` 均 200（不再是 404，也不再是 502）。
> 报告 `docs/_active/report/REPORT_包C_后端Extras端点_2026-10-18.md`。
> ⚠️ 下方「Extras 转发」相关内容（404 / 恒 502）是**重建前的历史事实，已不成立**。

- **核实时点**：2026-10-17（一手实测）。
- **事实**：运行中的 `palink-ai-backend-1` 镜像构建于 **2026-10-11 13:19:56**（`docker image inspect` 实证）；
  而 `backend/app` 此后有 **6 笔提交未上线**（`AGENTS.md` 纪律：`backend/app` 未挂载进容器 ⇒ 改宿主代码必须
  `docker compose build backend && up -d backend`）：

  | 提交 | 日期 | 内容 | 未上线的实测后果 |
  |---|---|---|---|
  | `85012cb` | 10-12 | 上传读取限额收口 | 内部重构，无外部可观测差 |
  | `37034a8` | 10-12 | 缓存命中数可观测 CACHE-OBS | 无可观测性 |
  | `052c2f4` | 10-12 | 中文 token 估算 TOK-ZH（替代 cl100k） | token 计数偏大 ⇒ 上下文截断偏激进（中文场景） |
  | `9e9692d` | 10-12 | 记忆阶段0 定标与诊断 D1-D6 | 记忆模块诊断能力缺失 |
  | `6477167` | 10-12 | 自造 ST 端点假成功→明确失败 | 卡脚本调 ST 端点仍拿**假成功**（应报错的静默通过） |
  | `69a472b` | 10-15 | Extras 转发 `/api/summarize` + translate | **实测 404**（TODOS 记载的"恒 502"是上线后的设计形态，现在连端点都不存在） |

- **影响解读**：S5 实机评估（10-15/16）与 T5 修复（10-16）全部跑在这份**落后镜像**上 —— 它们验的是前端轨与既有端点，
  结论不受影响；但上表 6 项后端行为至今未生效。前端 dist 是当前的（今日 11:22 重建），**前后端版本不一致**。
- **修法**：`docker compose build backend && up -d backend`（约数分钟；会重启后端容器，当前无活跃会话）。
  ⚠️ 属部署动作，按项目规矩** rebuild 前确认**（容器重启影响面：进行中的生成会中断）。
- **顺带**：TODOS.md「Extras 转发」条目所载"默认部署恒 502"需在此 rebuild 后才成立；rebuild 前端点实测为 404。

---

## P2 有更重要的事先放着

### [P2-6] 向量记忆检索查询把问题稀释到 4% · **2026-10-09 实测，零成本可修，未施工**

- **核实时点**：2026-10-09（一手实测，真实会话 `f25daab6…` + 生产 `assemble_roleplay_prompt`）。
- **事实**：`_build_memory_query`（`roleplay_prompt_assembly.py`）把最近 4 条消息 + 本轮消息拼接后
  **从尾部截断到 600 字**。实测那 600 字里**本轮问题只占 4.0%**，
  其余 96% 是上一条 assistant 回复的尾巴（还混着 `<UpdateVariable>` 指令与 `【声音：…】` 标签）。
- **后果（检索层 26 题实测）**：目标记忆 `top1` **8.3%**、注入命中 **33.3%**、平均排名 **第 16 名**
  （预算只装得下 6 条 ⇒ 大部分时候根本进不去）。改成"只用问题本身"后
  `top1` **25.0%**、排名**第 4**、嵌入 **424ms vs 1652ms（快 3.9 倍）**。
- ⚠️ **否证既有结论**：`REPORT_记忆向量提取与注入改造_2026-10-07.md` §3 的两条论断
  （"查询太薄故改为最近 4 条拼接"、"零额外嵌入调用"）**均不成立**。
- **未施工原因**：该函数在**装配链**上，`AGENTS.md` 规定"禁无授权改动"。
- **修法**：问题置尾且**不参与截断**（或对历史部分单独截断），保持"查不到就退回单句"的既有兜底。
- **同批结论**：`MIN_SIMILARITY` 0.5→0.3 **完全无效**（数字一行没动）；预算 1500→6000 才有效
  （注入命中 33%→67%）。记忆改句级（每句一条向量）是另一条独立可做项，端到端 0.210→0.340。
- 📌 完整数据与四步落地清单：
  [`docs/_active/report/REPORT_向量记忆替代上下文_结论摘要与落地清单_2026-10-09.md`](_active/report/REPORT_向量记忆替代上下文_结论摘要与落地清单_2026-10-09.md)

### [P2-1] 格式规范每轮注入 · 真机验收被网关余额挡住

- **一句话**：功能已落地，但真机验收做不了——网关余额不足。
- **卡点**：需要充值（记录时：需 ¥17.74，余 ¥11.55）。**只有用户能处理。**
- **顺带待办**：核对 40 次失败请求的预扣额度是否已退回。
- **验收须在新会话进行**（规范每轮注入，旧会话可能已有缓存）。
- 详情见 `TODOS.md` 格式规范条目 + 项目记忆 `project-format-spec-per-request-injection`。

---

### [P2-2] 首屏入口包 638KB 阻塞 · 弱网 60 秒白屏 · ⛔ KaTeX 动态加载已实施并回退

- **一句话**：首次打开要下的入口 JS 达 638KB（gzip），弱网下 26 秒传完、60 秒时页面完全白屏。
- **实测（一手，2026-10-05）**：临时限速代理 300kbps + 300ms 延迟 + 共享令牌桶。
  60 秒时 `document.body === null`；60 秒内实际只下载 **5 KB**（6 个首屏请求互抢带宽、无一先完成）。
  测完脚本已删。
- **已排除**：3 个 CSS 已是异步加载（`media="print"` + `onload`）；`modulepreload` 标签数 = 0。
  ⇒ **唯一真阻塞项就是那一个 638KB 入口 JS**。
- **入口构成**（字符串字面量锚点切分；terser 只改标识符故只能用字符串归因）：
  smart-card-runtime ~470KB / DOMPurify ~322KB / **KaTeX ~341KB**（度量表 53KB）/ ST getContext ~257KB / 其余 ~150KB。
- **⛔ 已否决并回退：KaTeX 动态加载。** 实施后 **6 测试红**（`failed=0` 是硬门禁），三个理由：
  ① `renderMathInHtml` 是**同步导出**（唯一调用点 `formatting.ts:1224`，无外部调用方），
     同步函数等不了异步加载 ⇒ 首条公式消息**先显示原始符号、再跳变成公式**；
  ② `formatting.ts:1220-1223` 原注释明写该处预渲染就是为消除"完成态塌回原文"，
     动态加载**恰好倒退 F-1 修复**；
  ③ `formatting-katex-contract.test.ts` 文件头明写该修复**曾两次被静默回退**故立此守卫，
     其 `:29` 断言源码含 `from 'katex'` 字面量 —— 让它变绿的唯一方式是改断言= 它要阻止的行为。
  已还原，`git diff` 空，`vitest run` 60 文件 / 781 passed + 3 skipped。**后续 agent 不要重做此路。**
- **下一步（按收益/风险，均未执行）**：
  1. 加加载态（`<div id="root"></div>` 现为空）—— 零风险，但**不减少字节**，只改善观感；
  2. **验证那~150KB**（sonner / lucide / 路由）—— 此前仅粗略标注"部分可摘"、**从未验证**，可能是干净收益；
  3. 拆 smart-card-runtime ~470KB —— 收益最大风险最高（模板字符串打包器无法裁剪，与插件链路深度耦合）。
- **权威文档**：`docs/SPEC_首屏入口包瘦身_执行与禁则_2026-10-05.md`
  （含归因方法论与可复制的正则、已否决方案全文、构建流程特殊约束、§8「我核实过的错误结论」5 条避坑）。
- **完整清单**：`docs/OPEN_ISSUES_窄屏卡片三修已上线_首屏入口包未解决_2026-10-05.md`。

---

### [P2-3] AI 正文列与用户气泡宽度不齐 · ⚠️ 本轮修复引入

- **现象**：396px 屏下 AI 正文列 **388px**（屏宽 98%）vs 用户气泡 **349px**（88%），差 39px。
- **根因**：为修"窄屏太窄"把居中补偿（`index.css` 的 `:has(.rp-mes-avatar)` 规则）改成宽屏也生效，
  AI 内容列因此撑到 388px；用户气泡仍被 `max-w-[90%]` 限制。
- **影响**：仅宽度不齐，**不导致**样式消失或内容截断。
- **两个选项待用户定**：① AI 列也限 90%（两边齐，但卡片 iframe 349px→约314px）；
  ② 去掉用户气泡的 90% 上限（两边都 98%，卡片保持 349px）。
- ⚠️ `Message.tsx` 已被并行 agent 改动，动前需协调。

---

### [P2-4] MVU 批次：SPEC 承诺但代码零对应的 4 项（无人认领"我没做"）

**核实时点 2026-10-05。** 这四项在 SPEC 与 PROMPT 里都有，**唯独没有任何一份 REPORT 认领**。
这是"半途而废"里最容易被漏掉的一类——**没人说自己没做，就等于没人做**。

| # | 承诺 | 实况 | 档位 |
|---|---|---|---|
| a | 变量重新初始化入口 `POST /{session_id}/mvu-reinit`（SPEC §4⑦） | `grep -rn "mvu-reinit" backend/app` → **零命中** | P2 |
| b | 角色卡级 MVU 设置覆盖，三层优先级（卡影子 > 用户设置 > 默认）（SPEC §3④） | `grep -rn "_get_mvu_secondary_override" backend/app` → **零命中**。阻塞理由（文档自己写的）：namespace 名 `mvu_secondary` 是拟的，**需先从卡 bundle 核真实键名，别自己拟** | P2 |
| c | 世界书白/黑名单正则过滤（第二步）（SPEC §4⑧） | 第一步（跳 `enabled=false`）已做并提交 `a877013`；**第二步未做** | P2 |
| d | 自动生成链路的变量失败通知（SPEC §5 批次 C） | 手动路径已修（`mvuSecondaryFeedback.ts`）；**自动链路方案乙未做**（需新增 SSE/WS 事件类型带 `mvu_status`） | P2 |

---

### [P2-5] 三元组返回值属破坏性签名变更，死代码未同步（定时炸弹）

- **事实**：`mvu_engine.py` / `character_message_builder.py` 的返回值从 `tuple[dict, list[str]]`
  改成三元组（加 patch 列表）。已同步 5 处调用方（`character_ext.py:4861/6083/6231/6586`、`websocket.py:760`）+ 3 个测试文件。
- **未同步**：`websocket.py:564` 的 `_run_secondary_mvu_sync` 仍按旧的 2 元组解包。
  SPEC §1.1 已确认它是**死代码**（全仓零调用点），所以现在不炸。
- **为什么是 P2 不是 P1**：不炸，但它是定时炸弹——哪天有人"顺手复活"这个函数就 TypeError。
  **删掉死代码是零风险的净收益。**
- 附带：SPEC §1.1 已建议顺手删，**至今无人接手**。

---

### [P2-6] 酒馆助手（JS-Slash-Runner）适配 · 代码在、链路通，剩局部缺口（2026-10-17 复核订正）

- **⚠️ 订正本表 2026-10-17 上午的错误记载**：当时本条被改写成「适配代码全仓找不到、实质已丢失」——
  **该结论错误**（复核者搜的是**文件名**，而适配代码在 `sandbox.ts`/`plugins.py` 等内容里，文件名不含"酒馆"）。
  当日深夜按**内容**复核，代码全部在场（明细见下），原条目已恢复订正。
- **代码现状（2026-10-17 逐点核实）**：
  - `frontend/src/lib/plugin-system/sandbox.ts`：`tavernVariableStore`（:54）、`TavernHelper` 全局对象
    （:3914 对照 JS-Slash-Runner `getTavernHelper()` 结构）、`getVariables`/`replaceVariables` 真实现
    （:3487+，klona 深拷贝/整体替换语义，对齐 `src/function/variables.ts`）、`buildWrappedCode` 全局声明（:2803-2840）
  - `backend/app/api/plugins.py`：tavern_helper 下发豁免（:506-509）+ `_synthesize_tavern_helper_js_content`
    （:535，script_type='script' 的 IIFE 拼接）
  - `frontend/security-headers.conf`：CSP `unsafe-eval`（:10）
  - 守卫：`backend/tests/test_plugin_card_ext_guard_exempt.py`（GUARD-TH-EXEMPT，`ae61ee2`）
  - 历史：代码经 2026-08-17 git object loss 后由全树 restore（`7d5dea1`）幸存，此后一直在主干
- **链路现状（10-06/10-08 真机检测 + 10-15/16 e2e）**：插件**能跑、主链路通**
  （`window.Mvu` 活着、事件桥通、7 个脚本按钮已注册）；实际调用面 47 项（保守口径 31 项）中大部分真可用；
  e2e 中该插件记 `no-init-export` 属**预期**（tavern_helper 型不走 `pluginManager.init()`，走下发豁免链）。
- **仍开放的缺口**（按 `REPORT_酒馆助手API适配度复查与100%适配判定_2026-10-06.md` §7 动工顺序）：
  ① 主页面 `SillyTavern` 全局字段投影（chat/name2/characterId）——A/B 实测 ~20 行只读补丁可修（报错 1→0），
  **未落地**（iframe 侧 proxy 已有 `chat`，卡内 MVU 崩溃已覆盖；主页面侧仍缺）；
  ② `getCharacterNames` 仍对稀疏数组 `.map()`（`sandbox.ts:3745`，10-06 §3.3 冻结风险未修）；
  ③ 世界书全局绑定 2 项、变量写通道（需用户授权）。
  ④ 插件两条脚本（242KB + 4MB）在 DB 的现状需 Docker 起来后复核（10-17 23:xx Docker daemon 已停）。
- ⚠️ 查验结论本身可信：`REPORT_酒馆助手API适配查验` 系列（10-06/10-08，证据密度最高的文档之一）。

---

### [P2-7] 记忆隔离 RC-4：`memory_mode=disabled` 无守卫

- **事实**：`SPEC_重新生成与分支记忆隔离修复_2026-10-05.md` 列 RC-1~RC-4，
  `f006b09` 修了 RC-1/RC-2/RC-3，**RC-4 未做**——`memory_mode=disabled` 在编辑/切换路径无守卫，
  **三条写入路径行为不一致**。
- 交接文档已补真机验收与判据自检脚本（`143fe6c`），**但那只覆盖 RC-1~RC-3**。

---

### [P2-8] ~~记忆向量链已改造，但**后端镜像未重建 ⇒ 线上仍跑旧代码**~~ · ✅ 2026-10-07 20:5x 已重建上线并核验

- **收尾**：用户选「立即重建」（知情同意会夹带并行会话 40+ 项在途后端改动）。
  `build backend` + `up -d` 后容器 `healthy`，产物级 grep 命中
  （`VEC-PG` 17 处 / `CHUNK_STRATEGY=structural` / `_build_memory_query` 3 处），
  启动日志无 `[VEC-PG]` 失败与 Traceback，对已部署镜像重跑探针：
  列 `vector` 729 行 / 670 向量 / 用户级 top50 23.5ms / 幂等 12.8ms。
  详见 `REPORT_记忆向量提取与注入改造_2026-10-07.md` §5.4。
- ⚠️ **仍待真机验收**：重建后 `语义检索完成` 命中数依旧是 **0**（没人聊过），
  所以"元组解包 P0 + 本批三项改造"都还没有一次真实对话流量的验证。判据在原报告 §5.2。
- 历史（保留，别再来一遍"要不要重建"的讨论）：改造完成时 DB 已转 `vector(1024)` 而服务跑旧镜像，
  该中间态**实测安全**（旧代码对 vector 列检索仍返 50 条/64ms；pgvector 文本输出恰好是合法 JSON）。

### [P2-9] 三轨并一轨 S5 剩余项：扩展 UI 不可见 + 8 条命令未下沉 + 2 处能力缺口 · **2026-10-15 登记**

- **核实时点**：2026-10-15（主控实测：三支合并后门禁全绿 —— 前端 1012/0/3 + tsc 0、后端 2060/0；S4 字节同一性在主干复核成立）。
- **现在该做什么**：S5（删大堂）前置已清（沙箱轨解耦 `aa106eb` 已合入），下列各项在 S5 前后逐条处理：

| # | 项 | 档位 | 现在该做什么 |
|---|---|---|---|
| 1 | ST 扩展 UI 可见性：11 个挂载容器是 iframe 内**离屏桩** ⇒ 插件能跑、命令能用，但用户在卡内**看不到面板** | **P2** | 用户 2026-10-15 拍板暂用 (c)「接受不可见、只保留命令/API 能力」；**(b) 单间轨自立门户（面板在卡内可见）登记为未做项**，待真实需求再开。(a) 挂载点桥回主页面与 S5 方向矛盾，已排除。**2026-10-16 已把该口径写进用户向文档** `st-plugins/ADAPTATION.md` §六（含容器清单 + 得/不得清单），防止被当 bug 报 |
| 3 | `setChatMessages` 未落库（原桥会 `POST /api/chats/save`，COT 格式化 swipe 靠它持久） | **P2** | **2026-10-17 进展（`6d720fd`）**：调用留痕已由逐次登记升级为**会话级**（`recordStubHitOnce`，消 MVU 每轮计数噪音），`deleteChatMessages` 补留痕（此前静默返回 false）；插件管理页可见。e2e 实机（2026-10-16）未发现相关回归。**落库（持久化）缺口仍在**，是否下沉 `/api/chats/save` 待影响评估后决定 |
| 4 | ~~MVU 世界书读取失败（默认态 14 次/会话）~~ | — | ✅ **2026-10-16 已修并真机复验**：根因从真机卡 bundle 挖实 —— `runtime-body/part-08.ts` 的 `loadWorldInfo` 是恒返 `{}` 的空桩，命中 MVU `!_.isPlainObject(_.get(n,'entries'))` 判据必抛。现改为经 `getCharWorldbook` 桥取真实条目（`entries` 为**对象**形状，数组会假阴性）。**真机实测：`entryCount: 19`、`firstEntryComment: "尾巴与翅膀状态"`，`worldbookReadFailed` 66 → 0** |
| 5 | quick-reply 未通（`SettingsUi.render()` 内 iframe 侧 `Failed to fetch`） | **P2** | 与第 1 条同源（UI 落在离屏容器）⇒ **维持阻塞**：用户 2026-10-16 再次确认口径 c，修好 fetch 白名单其 UI 也仍不可见，投入不值 |
| 6 | ~~`triggerSlash` 返回值复验（大堂 `sillyTavernPluginRuntime.ts:711` 的 `String(result)` 实产 `"[object Object]"`）~~ | — | ✅ **已随大堂删除而关闭**：该文件已于 S5 整文件删除（`f5c1a86`），bug 对象不存在；新共享实现本就取 `result.output` |

- ✅ **2026-10-15 已关闭原表第 2 项**：「8 条大堂前置命令未下沉」已施工并合入主干（merge `6688343`，`slash-commands-compat.ts` + 三轨共调），已回填 TODOS.md「三轨并一轨」条目。
- ✅ **2026-10-16 新增关闭一项**：**卡内 `triggerSlash` 缺口已修并真机复验**（本表 [P2-10] 第 1 项同源）。帧侧 `getContext().triggerSlash` + `window.triggerSlash` 已桥到宿主 `runPalinkSlash` action，命中走 `runPalinkSlashCommands`、未命中回落 `executeSlashCommandCompat`（与沙箱轨/getContext 轨同源）。单测 22 例覆盖；**真机实测两者均为 function，`/getchatname` 返回优雅降级空串**。
- ✅ **S5 已于 2026-10-15 完工并合入主干**（删码 `f5c1a86` + 测试 `fc6aa9a` + 报告 `f8288db`，tag `s5-done`，merge `e86ad9a`），**A–H 八组实机评估全过**（`REPORT_s5-arch-e2e_2026-10-15.md`，2026-10-16 提交；C/D 两张口子已真跑）。本表**第 3 项仍开放**（落库缺口），第 4/5/6 项已关闭或阻塞；S5 新发现的两处后续项均已关闭，见 **[P2-10]**。
- **背景与证据**：交接 `docs/_active/HANDOFF_S4-S5剩余任务_2026-10-15.md`；补测报告 §7.4/§7.5；TODOS.md「三轨并一轨」条目下的同名单。
- ⚠️ **本条已过时（2026-10-18）**：Extras 4 条端点不再是「恒 502 的设计形态」——包 C 把它们从
  「转发到已删 sidecar」改成「原生上游优先 + LLM 兜底」，真机实测 200。现在恒 502 的只剩
  `/api/speech/elevenlabs/*` 七个端点（Palink 不持有 ElevenLabs key，`silly_tavern.py:6318`
  的转发器仍在服务它们）。详见 `REPORT_包C_后端Extras端点_2026-10-18.md`。
- **5 个测试插件**：用户 2026-10-15 拍板**保留**（复测靶子；删除路径见补测报告 §2.4）。

### [P2-10] S5 删大堂后的两处后续项（2026-10-16 登记 · 非 S5 回归）

- **核实时点**：2026-10-15 S5 完工后（分支 `s5-delete-lobby`，删码 `f5c1a86`，tag `s5-done`）由主控独立复核确认。

| # | 项 | 档位 | 现在该做什么 |
|---|---|---|---|
| 1 | **单间轨 iframe 的 `SillyTavern.getContext()` 不暴露 `triggerSlash`** | **P2** | ✅ **2026-10-16 已修并真机复验**：帧侧 `getContextCompat` 新增 `triggerSlash`（宿主桥 → `runPalinkSlash` action → `runPalinkSlashCommands`，未命中回落 `executeSlashCommandCompat`），`window.triggerSlash` 同步注册。真机实测帧内两者均为 function。设计与证据见 `SPEC_ST兼容层修复计划_承接S5评审_2026-10-16.md` §3.2/§8.5 |
| 2 | **`setExtensionPrompt` 的行为测试随大堂专测删除后无存活轨等价覆盖** | **P2** | ✅ **2026-10-16 已补**：新增 `frontend/src/components/ui/custom/smart-card-runtime/__tests__/st-compat-fix-batch-contract.test.ts`（D 组 5 例），覆盖 set→get 闭环 + `extensionPrompts` postMessage 上报 + 宿主 `promptInjection.setSourcePrompts` 消费 + 按 position/depth/role 过滤 |

- **背景**：S5 报告 `docs/_active/report/REPORT_s5-delete-lobby_2026-10-15.md` §9；删码与测试清理提交 `f5c1a86` / `fc6aa9a`。
- ✅ S5 本体已通过主控复核（门禁 74 文件 / 960 passed / 3 skipped / 0 failed + tsc 0；后端 2060/23/0；真机入口 chunk 的大堂指纹 0 命中、存活指纹命中）。
- 📌 **2026-10-16 同批新增未闭环项**（用户已拍板口径 A，实现待下批）：
  `setChatMessage`/`deleteMessage` 不在手势闸门集合内 —— 经论证**不加剧门**（opaque-origin iframe 感知不到父页面点击，
  而 MVU 每轮都在无手势上下文里调 `setChatMessage`，加剧门会打断变量更新主链路，见
  `SmartCardCompatController.ts:67-79` 的兼容性论证），改为**调用留痕**：宿主侧 `recordStubHit` 登记，
  插件管理页可见「卡在无人点击时改了消息」。
  ✅ **2026-10-17 已实现（主控 `6d720fd`）**：落点两处 —— ① `getContext.ts` 的 `setChatMessages:persist`
  由**逐次**登记改为**会话级**（`recordStubHitOnce`，消 MVU 每轮调用造成的计数膨胀噪音）；
  ② `sandbox.ts` 的 `deleteChatMessages` 补留痕（其桥 `window.deleteChatMessages` 由大堂轨注入，
  S5 后已无赋值 ⇒ 现恒定返回 false，此前只 `console.warn`，属静默失效）。
  守卫见 `frontend/src/lib/plugin-system/__tests__/compat-stub-registry-once.test.ts`（7 例）。
  ⚠️ 注意：本项只做「留痕」，**落库（持久化）缺口仍在**（重载后丢失），是否下沉 `/api/chats/save`
  仍待 S5 真机影响评估后决定。

### [P2-11] 审计遗留两项（2026-10-17 登记 · 均有前置依赖，勿直接开工）

| # | 项 | 档位 | 现在该做什么 |
|---|---|---|---|
| 1 | **Phase5 39 个主页面桩登记进 stats**（T1 方案③） | **P2** | ⛔ **有前置**：会把 `getcontext-parity.test.ts` 的 `PALINK_ALLOWED_NO_OPS` 从 19 推过预算 20 ⇒ 必须**先单独立项评估**（要么扩预算并说明，要么分批登记），评估前不动手 |
| 2 | ~~**T5 口径 A：`setChatMessage` / `deleteMessage` 调用留痕**（不加闸门）~~ | — | ✅ **已做（2026-10-17，主控 `6d720fd`）**：新增 `recordStubHitOnce`（每桩名**每会话只登记一次**，后续静默）；落点两处 —— `getContext.ts` 的 `setChatMessages:persist` 由逐次改为会话级（消噪音），`sandbox.ts` 的 `deleteChatMessages` 补留痕（S5 后其桥 `window.deleteChatMessages` 已无注入方 ⇒ 恒定返回 false，此前只 `console.warn`，属静默失效）。守卫 7 用例 + 改坏证明 2 红/还原 7 绿 |

- **来源**：并行 agent 的收尾审计（2026-10-17），四项"明确没做"中本表收录两项；
  另两项：**T7 quick-reply** 已按口径 c 决定不做（UI 仍落在离屏容器，投入不值）、
  **pre-commit hook** 已修（见下）。
- ✅ **已修（不计入待办）**：`.githooks/pre-commit` 原先试 `python`，而本机 `python` 是微软商店空壳
  （`AGENTS.md` §3：exit=49、零输出）⇒ 其他 agent 的 shell 里 `command -v python` 命中空壳、
  扫描静默失败、`git commit` 被拦下且无提示。已改为 **`py -3` 优先、`python` 兜底且带功能校验**
  （提交 `a8d684e`，该笔提交即由新 hook 端到端验证通过）。
  ⚠️ 其余"裸 `python`"只出现在 `scripts/autotune.py` / `scripts/browser_smoke_test.py` 的
  **用法注释**里（非可执行代码），按 `AGENTS.md` §3 口径应改成 `py`，属可选清理。

---

### [P2-12] 分包批次 F/G/H/I/E/L 收尾遗留（2026-10-18 登记 · 已排期的只列不重复展开）

| # | 项 | 档位 | 现在该做什么 |
|---|---|---|---|
| 1 | **202 条 ST 命令"枚举里有、执行静默返空串"要不要加可诊断信号** | **P2** | ⛔ **等用户拍板**（产品取舍：维持现状对卡最像 ST；加标记则插件/卡能分辨"没实现"）。现状：`part-07.ts` 把 `Error: Unknown command` 折成空串、`synthesize` 的 entry `helpString` 为空 ⇒ 探测面说"有"，执行无痕。见 `REPORT_包F_ST命令补全_2026-10-18.md` §4.2 |
| 2 | **动态 import 型死链的 reason 不在 I-2 分类口径内** | **P2** | 包I 留的问题：`TypeError: Failed to fetch` 形态不属于「Event / target 是资源元素」⇒ 仍会弹 toast。要拍板是否扩口径（扩了就有"一刀切吞 error"的反例风险） |
| 3 | **`legacy-st-sim-parts/part-c.ts:362-363` 同款转义 + 产物含 5 个退格控制字符** | **P2** | 包L 顺带扫出但**未擅动**：`[\s>+~]` 在 legacy 产物里被模板求值吞掉反斜杠（`parentSelectorMatches` 的 send_textarea/send_but 分支），另有单反斜杠 `b` 落成退格符。legacy 侧载体本身保真 ⇒ 属"无人断言"，需先补断言再改码 |
| 4 | **srcdoc 单帧 ≤50,000 这条判据本身失效** | **P3** | 改前旧码就已 57,356 超线，大头是卡自带 `body-html` 24,796 + 内联卡脚本 22,539 + `style` 11,608，运行时体在外部资产 ⇒ **别再拿 50,000 当包间验收线**；要治的是"卡自带内容"的预算策略，另立议题 |
| 5 | 包G 三项：`appendMediaToMessage` 端到端落库未证实（父侧恒回 success，根因线索在报告）、`libs` 里 DOMPurify/lodash 实测是垫片、宿主缺 `power_user` 真偏好源 | **P2** | 各自独立可立项，勿混；DOMPurify 若真是垫片会影响净化语义，**优先核这条** |
| 6 | 包F 三项：176 个命令别名未下发、`caption` 缺消息媒体入参、`listvar scope=global` | **P3** | 别名未下发意味着卡脚本按别名探测仍看不到；剩余量级小，可与第 1 项合并处理 |
| 7 | ~~**上线状态**：F/G/H/I/L 六包**已提交未上线**（16000 仍服务旧 dist）~~ | **P0** | ✅ **2026-10-18 深夜已上线并逐包复跑**（主控两次重建：`dist_new` → `cp -r` 合并 → gzip；旧 dist 整份备份见 `_BACKUPS/2026-10-18_dist_批次FJ重建前/`）。回 :16000 实测：命令枚举 340 键 / 289 命中、`ctxMissing=[]`、`ctxNotReal` 只剩 6 项合法值、libs 30 键、TH 121 键、插件 CSS **t8→t16 全 7 帧 5/5 存活**、`guardSnapshot=8`、未授信 **7/7 opaque origin**、猫娘卡 nk style **1 份 / 3,156 字节**且美化仍生效、toast 0；帧内 `characterIdString` = 真 UUID（getContext 键数 194→196） |
| 8 | ~~`.gitignore` 的 `_BACKUPS` 规则自相矛盾~~ → ✅ **2026-10-19 已修（主控判断后执行，本笔提交）** | **P2 闭环** | 根因：第 241 行的**目录级**排除 `_BACKUPS/` 会让 git 不再进入该目录，其后 300-317 行「放行 `_INDEX.md` 与各 `BACKUP_INFO.md`」的 allowlist **永远拿不到机会**，新增台账只能 `git add -f`，与 `AGENTS.md` §备份与清理规范第 7 条相冲。修法：把 241 行注释掉（排除职责交给后面的 `_BACKUPS/**`，它不排除目录本身，所以 `!` 能生效）。**实测校验**：新建备份目录里的 `BACKUP_INFO.md` 不再被忽略；`dist/index.html` 之类大产物仍被 `_BACKUPS/**` 忽略；`.git` 体积无变化。⚠️ 已知代价（不是缺陷）：`git status` 现在会列出 33 个 `_BACKUPS/<日期>_主题/` 未跟踪目录行——因为"放行目录"是放行其台账文件的前提，见 `.gitignore` 307-322 注释；已核实最深处 `2026-09-30_dsh-源码版清理/`（自嵌套 node_modules）**没有**导致状态输出爆量（最长路径 179 字符，未出现超长 ERROR）。**后面的人看到这些未跟踪行不要当脏文件处理**。 |
| 9 | **卡帧内不存在 `window.context` 全局**（2026-10-18 包M 取证登记 · 包J 报告 §5 顺带查出） | **P2 → ✅ 已按裁定撤（2026-10-20 批次H）** | ~~boot 的 ctx 是 `const`（`SillyTavernCompatRuntime.ts:264`），不挂 window ⇒ ST 侧插件里常见的 `window.context.xxx` 直读全部拿不到（不是"值为 0"，是**整个对象不存在**）。补法要先定语义：镜像 `getContext()` 快照？还是活引用？ST 里 `window.context` 是**可写**的（卡脚本会改 `context.chat`），照抄=允许卡改父侧数据，属安全/契约面 ⇒ **先拍板再动**，别顺手 `window.context = ctx`~~ ⇒ **拍板结果：不摆**。① 一手核实（两棵 ST 1.18 树 + 酒馆助手插件全仓）：`window.context` / `globalThis.context` **0 命中**；`st-context.js` 只有 `export function getContext()` 与 `export default`，**没有 `export const context`** ⇒ 包N B-2 当年依据的「ST 1.18 的 context 是 st-context.js 里的一次性快照」是**误读**，ST 真实用法是文件内部 `const context = getContext()`（两树各 57 处）。② 真机探针（2026-10-20 :16000 露缇雅 7/7 帧）：每帧唯一记录 `frame_compat:global_shape_absent:window.context` 且 count=1，无任何 `name='context'` 的 error 轨记录 ⇒ 没有在跑的卡依赖这个面。③ 施工（批次H）：帧内定义已撤（`part-08.ts` 原位留撤销注记），启动留痕二改为「Palink 帧内同样不提供 + 卡应调 getContext()」，包N B-2 断言**改判**（非删除）见 `n-package-context-rename-media-trust.test.tsx` / `c-getcontext-six-keys-and-diag-wording.test.ts`，报告 `report/REPORT_包AG_H_window.context撤留钉事实_2026-10-20.md`。⚠️ 沙箱轨 `sandbox.ts:2767` 的 `var context = getContext()`（与 ST 同款的局部常量，**不在本批范围、未动**）与 `:4624` 的 script.js 模块映射 `context` 键（其依据「ST 的 script.js 导出 context」同样与一手事实不符——`script.js` 只 re-export `getContext`，:294）**另行登记待批** |
| 10 | **K-1 归因反转：卡侧样式不是被删，是被 Palink 自家 jQuery 兼容层"搬走后失联"**（2026-10-19 登记 · 包N 取证 + 主控复核） | **P1 → ✅ 已修并上线，见第 12 条**（本行的归因是**部分正确**：方向对、机制错，别再照它施工）| 用户裁定走 b（先修取证、不扩守护）⇒ 包N 的取证面已交付并上线（父侧能报 `style_removal[node_removed] … target=HEAD … textLen=3903` 带节点身份）。归因定案：163 次命中**单一调用方**（卡自带 `MagVarUpdate@beta` CDN bundle，`DOMContentLoaded` 时 `$(容器).append($('head 里的 style'))`），走 `part-04` 的 `collection.append` → `appendChild` **搬运**进一张随后脱离文档的 DIV；6 种删除 API 的同步钩子命中全 0。**⇒ 修法在兼容层，不在守护**：已派包P，先离线用真 jQuery 作 oracle 做 A/B 定位 stranded 的确切环节，⛔ 禁改 `STYLE-GUARD` 恢复范围。红基线（上线产物实测）：`tavern-cg-album-style` **ABSENT 7/7 帧**、`galgame-ui-plugin-styles` 2/7 丢，见 `.tmp_probe/MASTER_K1_base.txt` |
| 11 | **K-3：露缇雅主实例 4.5–7.5s 弹 `Failed to fetch` toast（仅主实例，克隆不弹）** | **P2** | 包N 复现了现象（`billedHits=0` ⇒ 不是计费端点），但**该 rejection 走 toast 通道、不进帧内取证面** ⇒ 证据不足以定责，包N 明确写"定不了"没猜。下一步要么给 unhandled-rejection 轨也接上进 `__palinkFrameErrors`，要么用 devtools network 面板人工抓一次；⚠️ 别把它和包I 已分类的"资源加载失败"混为一谈（那条已经不弹了） |
| 12 | **K-1 真根因与修复（包P2 `24c7706`，2026-10-19 上线）** + 三处未对齐遗留 | **P1 已闭环 / 遗留 P2-P3** | **根因两层，第 10 行的归因已被线上取证推翻一半**：三条候选（卡自带 jQuery 覆盖 / `document` 被遮蔽 / 注入了外来文档的 jQuery）**全部否证**——帧内 `$` 就是未接管的兼容层桥（`$.fn` undefined、`{get,set}` 描述符），`createElementsFromHtmlCompat` 确实在 live document 上 `createElement('template')`，那个 `href=null / nodeCount=0` 的外来文档是 **HTMLTemplateElement 的模板内容文档**（`createHTMLDocument`、`DOMParser` hook 零命中）；**致命点在搬运**：`appendTo`/`prependTo` 把整条 **nativeFallback Proxy** 集合交给 `append`，Proxy 取未知属性恒返回函数 ⇒ `value?.nodeType` 判真 ⇒ `appendChild(Proxy)` 抛错被 **`catch{}` 静默吞掉** ⇒ 空转，连原生建的 live 节点都搬不进 head（原生 `head.appendChild` 同容器却成功）。修复=创建结果 `importNode` 归本帧文档 + `append/prepend` 严格判节点并摊平集合（⛔ 未动 `STYLE-GUARD`）。**主控独立复跑上线实测**：cg 与 galgame 样式 **ABSENT 7/7 → PRESENT 7/7**、head style **8 → 24**、`sameDoc=true`、`wrapperInLiveHead=true`、帧内报错 0；零回归 getContext **196**、TH **121**、libs **31**、`guardSnapshot=8`、插件 CSS t8→t16 恒 **5/5**、未授信 **7/7 opaque**、猫娘 nk **1 份 / 3,156 字节**；`gate.sh frontend` rc=0（93 files / 1224 passed）。**遗留三条**：① 多目标 `append`/`appendTo` 的 **clone 语义仍未对齐 jQuery**（真 jQuery 对非最后目标克隆，Palink 现在不克隆 ⇒ 同一节点 append 两处会被第二个容器拿走）；② 兼容层 **`try/catch{}` 静默吞异常**是这次"无感失效"的放大器，建议给搬运路径加一次性留痕（复用包N 取证面，不弹 toast）；③ A/B oracle 只有 **jquery@4.0.0**，**缺 3.x 对照**（卡侧 bundle 可能按 3.x 写） |
| 13 | **向 ST 学习的子系统缺口已建台账**（2026-10-19 用户裁定：能照 ST 学的先标记，再尽量学） | **P2（乙类按排行）** | 台账：`docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md`。**17 个 id**（订正 2026-10-19：初稿 14 个，主控按包H §7.2 的实测改判补 `script_button_store`/`model_list`/`chat_reorder` 三族，否则这三族在排行里恒为 `unknown`、无法派单）覆盖 D 类 76 键 + 202 条未实现命令的归因，分**甲类**（ST 有、我们只差桥/槽位：`wb_delete`、`chat_binding`、`stop_by_id`、`persona_crud`、`macro_register`、`jailbreak_slot`、`charlib_write`）、**乙类**（要整套子系统，先标记不做：`preset_prompt`、`audio_player`、`ext_install`、`raw_import`、`regex_object`、`inject_slot`）、⛔**不学**（`opaque_dom`，沙箱红线）〔⚠️ 2026-10-20 深夜订正：这一格已被**用户第三次裁定覆盖** —— `opaque_dom`
改为"**分场合放开**"（本机/内网默认给同源、公网访客仍走逐卡信任），不再是"不学"；判据与新暴露面见台账 §2.4，
执行件 `PROMPT_对话包_批次Q1_本机默认放开卡片读主页面_2026-10-20.md`。同一轮里"乙类 = 要整套子系统"对
`preset_prompt`/`audio_player` 也不成立（两处都有现成落点，见 §2.2 最后一行）。**旧原文保留不删，以订正为准。**〕。**标记机制是双向守门**：代码里 `[ST-GAP:<id>]` token + 运行时记录带 `missingStSubsystem:<id>` + 一条测试同时断言"台账有→代码标了"和"代码标了→台账记了"（单向检查会让台账先烂）。已验证锚点只列主控亲自 grep 过的行（如 `PromptManager.js:1723` 系统提示词判定式、`openai.js:1232` 破甲属系统提示词家族且卡可覆盖、`personas.js:462/515/154/551`、`extensions.js:1698`），**未核实的一律写"待核"**（参照树缺 worldbook/regex 两份文件）。✅ 2026-10-19 已接上（不再是"待补一小包"）：`palink-diag.ts` 的 `classifyStGap`（名单逐条抄自包H §3/§7.2 与包F §4.2，没核到的一律落 `unknown`，不自造归族）+ `palinkDiagStGapRanking()` + 导出 JSON 直接带 `stGapRanking`；双向守门测试 `__tests__/st-gap-ledger-guard.test.ts`（A 台账↔代码清单、B `[ST-GAP:<id>]` token 双向、C 键名必须在 th134/st289 权威 fixture 里、D 包H 的每条 D 类键不得静默落 `unknown`、E 字段与排行行为）。**"排行出数据之前不投入乙类"这条裁定不变。** |
| 14 | **帧可以替宿主决定"是哪个会话"（`__palinkContext.sessionId` 顶包）**（2026-10-21 批次P2 主脑复核实测登记） | **P1（违反用户"卡片只能读自己这一份对话分身"的裁定，但不是跨账号）** | 合并点在 `frontend/src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts:1926`：`sessionId: context.sessionId || payload.__palinkContext?.sessionId` ⇒ **宿主没有会话时，帧自己塞的 id 生效**。✅ 预设面已收口（`resolveSmartCardPresetSessionId` 改为只认宿主构造的 `selectedSession.id`，`SmartCardCompatController.ts:971`；反证用例 `p2-preset-read-keys-parent.test.ts` 的"真实通道"那例，改前实测红）。⚠️ **还剩两处同一通道的未收口面**：① `generateRaw` / `generateQuietPrompt`（`:2120-2125`）仍回落到可被顶包的 `requestContext.sessionId` ⇒ 一张卡可指名用户另一个会话去取历史进提示词；② `__palinkContext` 是通用通道，世界书导出/绑定等动作是否也依赖它，需逐动作清点后再决定"要不要整体取消帧侧回落"（属行为变更，先量影响面）。⚠️ 另记一条方法论：**守卫往 `payload.sessionId` 塞伪造值是测空气** —— 那个键没有代码读，用例恒绿；测顶包必须走 `payload.__palinkContext.sessionId`。见 `docs/_active/report/REPORT_批次P2_*.md` §7.2/§7.4 |
| 15 | **预设读类三键"键在、语义错"：对外是 Promise 而 ST 是同步，且数据源是一张空表**（2026-10-21 上线实机取证） | **P1（卡片不报错、门禁全绿，但真卡永远拿不到东西）** | 实机形状：`getPresetNames`/`getLoadedPresetName`/`getPreset` 全部 `tag=[object Promise] thenable=true`；权威契约 `st-plugins/.../@types/function/preset.d.ts:150` 是 `declare function getPresetNames(): string[]`（同步返数组）。数据源：`prompt_presets` **0 行**（全库）、`/api/prompt-manager/presets` → `[]`、`selection` → `source:"none"`；用户在用的那份在 **`generation_presets`（27 行）**，走 `/api/roleplay/presets`（`backend/app/api/presets.py:14` → `GenerationPreset`），第一方界面是 `PresetManager.tsx`/`PresetSelector.tsx`。**除新加的卡片桥之外没有任何代码消费 `/api/prompt-manager/presets*`** ⇒ 包P 的覆盖层 + P2-2 选中名 + P2-3 三键整条链建在无数据、无界面的表上，违反用户"默认刚进卡是设置里自己那份"的裁定。⚠️ 单测为何没抓到：用例 `await` 了返回值，而 `await` 对同步值与 Promise 同样成立 ⇒ 修法必须断 `thenable=false`，不能只断值。⚠️ 附带红线：`presets.py:114-115` 的列表含 `user_id IS NULL` 的**跨用户共享行**，卡片侧任何写/删通道严禁落到共享行。执行件：`docs/_active/prompt/PROMPT_对话包_批次P3_预设三键改同步并接到用户在用的那份表_2026-10-21.md`；取证全文：`docs/_active/report/REPORT_上线实测_包P与批次Q1与批次P2_2026-10-21.md` §2 |
| 16 | **父页面 `postMessage` 被第三方包装时，卡片整条通道会被静默丢弃**（2026-10-21 存储测量 agent 的附带发现，主脑已一手复核代码） | **P2（触发条件是用户装了会包装 `postMessage` 的浏览器扩展；一旦触发是"卡片全哑"且零留痕）** | 守卫在 `frontend/src/components/ui/custom/CharacterCardRenderer.tsx:970-971`：`if (!iframeRef.current?.contentWindow) return; if (event.source !== iframeRef.current.contentWindow) return;` —— **fail-closed 且只认 `event.source` 恒等**。帧内一律走 `window.parent.postMessage(...)`（`runtime-body/part-08.ts:1181/1194/1521/1842`），该属性在调用时解析到**父 realm** 的 `postMessage`；若扩展在父页面替换了它并用自己的窗口转发，`event.source` 就变成主窗口 ⇒ 守卫 `return` ⇒ **storage 落库 / resize / RPC 全部静默丢弃**（不报错、不留痕、卡看起来"点了没反应"）。测量 agent 的第一版探针自己就踩了这个观察者效应（v1 数据作废）。修法方向（⛔ 不要顺手改，先定口径）：① 丢弃前必须 `palinkDiag` 留痕（本仓主题就是"让静默失败可见"）；② 来源判定不要只靠 `event.source` 恒等——已有 `frameSecret` + `frameId` 两道校验可作为回落判据（`CharacterCardRenderer.tsx:972-985` 起的手势令牌裁决就在用它们）；③ 加一条守卫测试模拟"父 realm 包装 postMessage"。取证：`docs/_active/report/REPORT_卡片存储shim收益实测_2026-10-21.md` §1.1 |
| 17 | **实机控制台 9 类报错已定性：6 类是我们的锅、3 类是卡/插件自己的、1 类环境噪音**（2026-10-21 只读取证 agent + 主脑抽查） | **P2（按下列排序修，前两条最便宜）** | 取证全文 `docs/_active/report/REPORT_控制台报错九类定性_2026-10-21.md`（探针 `.tmp_probe/errtriage_full.js`、`errtriage_regexpresets.js` 可复跑）。**我们的锅 6 类**：① Chat Translation init `Object.hasOwn(undefined)` —— 宿主沙箱 `extension_settings` 缺 ST 预置命名空间（`sandbox.ts:3065/3081`），而**帧内同一处早已修**（`runtime-body/part-01.ts:751`）⇒ 宿主照抄即可；② Summarize `Cannot access 'MODULE_NAME' before initialization` —— 宿主转译器规则 11 就地赋值造成 TDZ（`sandbox.ts:2621-2635`），帧内已用活绑定修好（`part-02.ts:707`）；③ RegexPresetManager 找不到预设下拉 —— 宿主"init 先跑、面板后挂"竞态（专项探针实锤 `SELECT#regex_presets` 现在存在但监听器永远没挂上）；④ 快速回复保存 404 —— 后端**没有** `/api/quick-replies/save` 路由（只在 `silly_tavern.py:6049` 的注释里被提到，主脑已抽查确认）；⑤ `/st/locales/zh-cn.json` 404 —— i18n 去取一个不存在的资产；⑥ `debugger.css` MIME —— `st-plugins/regex/style.css:1` 的 `@import "debugger.css";` 无人重写（主脑已抽查确认该行存在）。**卡/插件自己的锅 3 类**：`style_removal`×168（卡自己搬样式 + 我们取证面每帧 24 条顶格上报，样式实际健在）、Music.js 外链失败族、Galgame `PIXI.live2d`（本仓零命中）。**环境噪音 1 类**：登录前 bootstrap 的 401。⚠️ **本次上线唯一新增的可见报错**是 ⑥（14 次/轮）：A/B 对照实锤 opaque 帧不发该请求、same-origin 帧才发 ⇒ 批次Q1 放开同源的**良性副作用**，零功能损害。⚠️ 114→209 那个差值是探针口径差（拦截策略不同），**不可相减**。修复排序建议：①②（帧内已修、宿主照抄）→ ⑥（模板串内改，注意 ES5 纪律）→ ④⑤ → `style_removal` 降噪（属产品决策，与本表第 12 行遗留②方向冲突，需用户裁定） |
| 18 | **第 17 行的落地结果：① ② 已上线归零；⑥ 没修好且方向要换；并暴露出两条更靠后的缺口**（2026-10-21 批次E2 上线后实机复验） | **下一跳 P2；⑥ 的修法重定向 P3** | 实机计数（`.tmp_probe/errtriage_full.js`，7 帧同页）：`CNT_B3_translate_init=0`、`CNT_B5_summarize_tdz=0`（改前各 14 次量级），`FRAME0` 里 `esTranslate/esMemory` 已从 `undefined` 变成 `object` ⇒ 第 17 行的 ① ② 真修好了。**⑥ 仍是 14 次**：帧内 CSS 首行确实被重写成绝对路径了（`@import url("/api/plugins/db0c6324-…/asset/debugger.css")`，新产物字面量 `@import url(` 0→1 命中），但**目标不存在** —— 主脑一手核实：资产端点对该插件返回 `404 text/html`，该插件 `source_data` 里**没有** `debugger.css`（`like '%debugger.css%'` → `f`），而 `/st-plugins/regex/*` 经站点访问也是 404 ⇒ **"改 URL"这条路只能改形式**，正确修法是在宿主注入插件 CSS 时把 `@import` 内容**内联**（构建期把捆绑插件资产当资源读入），或把捆绑插件的 assets 正式导入 `plugins.source_data`。⚠️ 修好 ① ② 后出现两条**性质不同**的新错，别混为一谈：`macros.register is not a function` 是"修一跳露下一跳"（宿主 `'macros/macro-system.js'` 的 `macros` 是空对象，`sandbox.ts:5399-5419`；ST 的 macros 带 `registry/register/registerAlias`）；而 `getScriptsByType(...).forEach is not a function` **是 E2-1 自己引入的回归**——预置命名空间被一律补成 `{}`，`regex` 也在其中，但 ST 的 regex 扩展要求 `extension_settings.regex` 是**数组**（`st-plugins/regex/engine.js:108-112` 之后直接 `.forEach`）⇒ 必须按类型补，不能一律对象。两处都并入批次E2b。零回归：7 帧、`styles=25 nonEmpty=25`、`th=148`、`ctx=196` 全不变〔✅ **2026-10-21 下午已收口并上线**（批次E2b，`1c28e87`）：`CNT_B10_debugger_css_mime` **14→0**、`CNT_OTHER` **→0**（`macros.register` 与 `getScriptsByType(...).forEach` 两条都消失）、`FRAME0.regexCssHasImport=false` 且首行已是内联后的 debugger 样式；零回归复跑同判据全绿。⚠️ 覆盖边界：本批只修了**捆绑插件 CSS** 这条路，synthetic/第三方 CSS 里不可解析的 `@import` 仍会报同样的 MIME。取证：`docs/_active/report/REPORT_第三次上线实测_批次E2b与UI1_2026-10-21.md` §1〕 |
| 19 | **ST 设置的前端可达性盘点：73 项里 30 项"有接口没控件"**（2026-10-21 只读盘点 agent） | **P2（用户点名"以后要补"）** | 取证全文 `docs/_active/report/REPORT_ST设置前端可达性盘点_2026-10-21.md`（A/B/C/D = **31/30/10/2**）。**最该先补的三个**：① `author_note` + `position`/`frequency`/`depth` —— 后端读写与装配读取**全都已通**（`roleplay_prompt_assembly.py:3523-3627`），只差控件，而 `/note` slash 只写"逐会话"改不到全局；② `jailbreak` —— 批次JB 刚把它接进装配（`character_message_builder.py:357-372`），但 `UserSettingUpdate` 里**没有这个字段**，唯一写入路径是整块 `/api/settings/save`，属"接上了但改不了"；③ 预设 `selection`（`/prompts-manager/presets/selection`）与会话覆盖层 —— 目前**全局零 PUT**，且第一方"当前预设"是组件 state，与后端 `in_use` 是两套口径。⚠️ **反直觉结论：B 类里有一部分补 UI 会造出假控件**。⚠️ 主脑粗筛被推翻的 9 个字段（`custom_*_prompt` 四件套、`use_custom_prompts`、`memory_budget_level`、`mvu_secondary_enabled/model`、`active_persona_id`）其实**都有真控件**。⚠️ `show_character_status` **应删不应补**：`build_default_character_prompt` 收了参数从不使用、`build_status_instruction` 生产零调用，而 `PromptSettings.tsx:148` 还在教用户点一个不存在的开关。⚠️ 历史结论"世界书两个向量开关无 UI"**已作废**（`WorldBookManager.tsx:394-407`、`RoleplayEngineTab.tsx:377-450` 都有）。⚠️ `WorldBookStage` 有 30 个高级列连**读**都没暴露（`_stage_to_response` 白名单）⇒ 补 UI 前必须先补接口 |

- **已排期不在本表展开**：插件 CSS 守护竞态（包J J-1）、`getContext().characterId` 恒 0（包J J-2）、
  part-08 两处转义（包J J-3，已登记在 `runtime-source-carrier-fidelity.test.ts` 的 `KNOWN_ESCAPE_LOSS`）、
  富卡生态扩样（包K）、信任分级最后一公里（包D，用户已拍板时机=四包收工后）。

---

## P3 已知 · 主动不做

_（当前无）_

---

## P4 待查（尚未定性，可能不是 bug）

### [P4-1] iOS 返回手势：卡在"上一次对话"、闪几下才回上一层 · ⚠️ 2026-10-05 调查未定性

**用户报的现象**（记忆可能不准，以真机为准）：
在角色扮演对话页点返回、或 iOS 从左往右滑返回时，**不进入角色卡评估界面**，
先卡在**上一次**对话的记录里，闪几下后才回到上一层。

**已查实的（代码结构层面，一手）**
- 角色卡列表与对话页**不是两条 history**，是同一组件的两个视图态
  （`frontend/src/components/views/CharacterView.tsx:125` 的 `viewState`），
  URL 只有 `/characters` → `/characters/:id` 一跳。
- 进入对话时有**无条件**的会话恢复：`:1255-1258` 直接载入 `loadedSessions[0]`（最近一次会话）全部消息。
  ⇒ 只要这段被重新执行，画面上就先渲染"上一次对话"——与症状细节吻合。
- 路由同步 effect（`:1274-1294`）有 `routeCharacterSyncRef` 防线防重复进入，
  但重置只发生在角色 ID 变空时（`:1279`）。

**已否证的（一手实测，2026-10-05 真实 Chrome）**
- 仓库里 `hooks/useGhostHistoryProbe.ts` 与 `CharacterCardRenderer.tsx:1666-1689`
  的注释都声称"iframe srcdoc 重建 → Safari 联合历史幽灵条目 → 返回时闪过 N 帧"。
- **实测：同源 srcdoc iframe 连续重建 12 次，`history.length` 恒为 2 不变；连续 `history.back()` 10 次只产生 1 次真实 pop，幽灵条目 = 0。**
  ⇒ **该机制在 Chromium 上不成立。**
- ⚠️ 但这**不能外推到 WebKit**（该现象本就可能是 Safari 特有）。所以是"未证实"，不是"已排除"。

**⚠️ 与既有结论冲突（引用前务必知道）**
`TODOS.md` 的「删除离屏跳绘机制」条目写着"卸载致 iframe 重导航 → iOS 联合历史幽灵条目"，
那是**推理式结论**；本条是**实测否证**。两者冲突未裁决。

**⚠️ 冲突不止在文档里，代码注释也是反方**：`frontend/src/index.css` 删除 `mes-render-skip` 那段注释里
仍写着「卸载会让 iframe 重导航，**iOS 会攒幽灵历史条目**」。后来 agent 读注释会得到与本条相反的结论。
**改代码时顺手把这段注释口径订正掉。**

**缺什么证据才能定性**
1. 真机（Safari 远程调试）看 `[GHOST-HISTORY] 穿过一条幽灵历史条目（累计 N）`：
   - N 明显 > 0 → 主因是 iframe 那条，现有防抖没盖住全部来源。
   - N = 0 但仍卡 → 是上面 `viewState`/会话重算那条，按 `:1279` 防线泄漏方向查。
2. 或：桌面 Chrome 走一遍"进对话 → 返回"看能否复现。
   能复现 = 应用自身状态逻辑问题，与 Safari 无关，可一路查到根因。

**现在该做什么**：**不要改代码**。缺真机读数，改了是盲改。
实验脚本与说明：`_BACKUPS/2026-10-05_ios历史回退复现/BACKUP_INFO.md`（台账已登记）。

---

### [P4-2] 跨会话记忆召回的公开端点易漏

- **一句话**：`api/memory` 与 `st/vectors` 是两个独立的跨卡召回入口，最容易漏改。
- **现状**：会话内召回工作正常；**跨会话**维度的覆盖是否完整，未做全量核对。
- **为什么是 P4**：只是怀疑覆盖面有缺口，**没有实测过漏了哪个**，可能不是 bug。
- 证据见项目记忆 `project-memory-retrieval-is-per-session`。

---

### [P4-3] 某卡片 iframe 高度虚高（50000px 但气泡仅 516px）

- **现象**（2026-10-05 一手实测）：一张卡的 iframe 高度被顶到 **50000px**
  （正好是本轮把 `IFRAME_MAX_HEIGHT` 从 5000 抬上去的新上限），
  但其消息气泡容器实测只有 **516px** —— 超出部分被 `overflow:hidden` 裁掉，**不影响版面显示**。
- **性质**：高度虚高，疑似测量重复上报。**未定位根因，未修改。**
- **为什么是 P4**：不影响用户可见内容（气泡正常），只是高度算错，尚未定性是不是 bug。
- ⛔ **排查禁手**：读 iframe 静态 `srcDoc` 的字数是**无效手段** ——
  脚本卡内容运行时才渲染，且 iframe `sandbox="allow-scripts"`（无 same-origin）
  **读不到 `contentDocument`**。我曾据此误报"37 字撑 5 万像素的vh 正反馈"，被用户当场否证。

### [P4-5] `MIN_SIMILARITY=0.5` 是在「200 行窗口」的年代标的，窗口拆掉后可能偏松

- **背景**（2026-10-07）：该阈值的标定依据写在 `memory_module/config.py:25-29`——
  "0.3 对 bge-m3 中文语料基本失效（无关查询 top1=0.459 且 75/77 条过阈值），0.5 是经验分界"。
  那轮实测的候选面是**旧实现的最近 200 行窗口**。现在检索已覆盖整个作用域
  （实测用户级候选 614 行 ⇒ 过阈值的 151 条全都能进候选，旧窗口只见 79 条）。
- **未定性**：候选面变大后 0.5 是否仍挡得住无关查询，**没有重新实测**。
  实测里已经出现苗头：同一查询 top50 的第 50 名相似度 = 0.5333（贴着阈值线）。
- **为什么是 P4**：没有证据说它现在坏了；只有证据说标定它的前提变了。
- **下一步**：拿一批"明显无关"的查询与"确实相关"的查询各跑一轮，重新画分界；
  注意 `memory_mode`、注入预算档位（750/4000/6000/8000）会一起影响观感，别一次改两个变量。
  〔2026-10-10 订正：原文写作 750/1500/3000/6000。档位表已于 2026-10-09 重定为
  (750, 4000, 6000, 8000)、默认档 1 = 4000，见 `_active/report/REPORT_记忆预算与历史配比_全记录_2026-10-10.md`。〕

### [P4-6] ST 向量集合检索仍是同款「LIMIT 500 + Python 余弦」，本批刻意没动

- **事实**：`api/silly_tavern.py:5281` 的 `_st_vec_query_collection` 走的是
  `ORDER BY created_at DESC LIMIT 500` 再逐行算余弦——与 §P4-5 背景里那条被拆掉的旧通路同形。
- **为什么没动**：它不在第一方注入链上，且**当前库里 `st-vec::` 前缀行数 = 0**（实测），
  改了也没有可验证的收益面；本批刻意不扩面（避免"顺手改一片"）。
- **要做的话**：`conversation_memories.embedding` 已是 `vector(1024)`，
  直接复用 `storage._semantic_search_pgvector` 的 `<=>` 写法即可，注意别建向量索引
  （理由见 `REPORT_记忆向量提取与注入改造_2026-10-07.md` §2.4）。

---

## 维护规则

1. 新发现的问题先进这里，**分好档位**，再决定要不要动 `TODOS.md`。
2. 状态变化（有人开工了 / 查清了 / 关掉了）**必须回来改这一条**，否则本文档也会僵尸化。
3. **P3 不要为了清空列表而往里塞**——"决定不做"要有理由，否则它会变成垃圾桶。
4. 引用本文档结论前，⚠️ 先看条目标注的日期与证据层级（一手实测 / 二手 / 仅代码推理）。

### [P2-13] 第三方真实插件实验暴露的两条通用缺口（2026-10-21 · 一手实测）

> 实验全文：`docs/_active/report/REPORT_第三方真实插件实验与链接安装_2026-10-21.md`。
> 测试对象是三个真实 GitHub 扩展（Kimi Thinking Prefill 1.1.0 / ComfyInject 0.3.0 / Smart Memory 1.8.3），
> 链接安装与上传安装**都能跑通**；三个里 1 个干净加载，2 个撞在下面两条上。测试插件**已全部禁用**。

| # | 缺口 | 档位 | 证据与影响 |
|---|---|---|---|
| 1 | **没有 `SillyTavern` 全局对象** | **P1（ST 生态最常见的入口之一）** | Kimi Thinking Prefill 第一行 `const { eventSource, event_types } = SillyTavern.getContext();` ⇒ 页面级 `ReferenceError: SillyTavern is not defined`（initSetting + PAGEERROR 两处）。我们只有模块化 shim 与 `TavernHelper`，没有这个全局。⚠️ 补它**不能直接暴露宿主对象**，要按现有 shim 口径包一层并评估沙箱红线（`SillyTavern.getContext()` 至少要能给出 eventSource/event_types/chat 等只读面） |
| 2 | **每卡插件 allowlist 无前端入口** | **P1（安装功能对"卡内使用"不可达）** | 测试角色库内实测 `plugin_scope_mode=allowlist`；后端 `_filter_runtime_config_for_character` 的 allowlist 分支只放 "allowlist ∪ exempt" ⇒ 新装插件不进任何卡的帧（7/7 帧实测 `hasNewCss=0`，但 `isInstalledExtension` 仍为 true）。〔⚠️ **主脑订正 2026-10-21**：这条说错了。每卡插件白名单**有 UI** —— 在**角色编辑器的「插件」Tab**（`frontend/src/components/views/character/CharacterPluginsTab.tsx`，挂载于 `CharacterEditor.tsx:476`，走 `GET/PUT /api/characters/{id}/plugin-state`，支持 `inherit`/`allowlist` + 逐插件勾选）。`grep plugin_scope_mode` 0 命中是因为前端用的是 `mode` 字段名，不是 DB 列名——我搜错了关键词。⇒ 新装插件进不了卡**不是缺 UI**，是那张卡处于 allowlist 模式且没把新插件勾进去；**用户可自行在角色编辑器里勾选**。原文保留：〕~~`grep frontend/src` 对 `plugin_scope_mode` **0 命中**（后端 `character.py:150` 能写）⇒ 用户装完在卡里用不上，也没有界面能把它加进某张卡。~~修法与 [P2-12] 第 19 行的"设置没 UI"同源 |
| 3 | Smart Memory 的 `registerSmartMemoryMacros is not a function` | P2 | 其 31 个模块的导出链里有一个函数没挂上；与 E2b 修的规则 11/8b 属同类但形态不同（不是 TDZ，是"根本没导出"）。需按该插件自己的模块结构定位 |

验收建议：① 用**真实插件**（不许自造）复跑，判据写进报告；② `SillyTavern.getContext()` 补上后，
Kimi 的那两条报错必须消失，且**沙箱里读不到父站凭据**不能退；③ allowlist UI 落地后，
"给某卡加一个插件 → 刷新 → 帧内 `hasNewCss` 从 0 变 1"作为端到端判据。

### [P2-14] 真实插件 Smart Memory 修好模块链后露出的两条"下一跳"（2026-10-21 · 一手实测）

> 背景：批次MC（`c1eb693`）修了"相对路径 import 被 ST 白名单抢先匹配"的加载器缺陷，
> 真插件 27 个模块全部求值、宏注册成功；`registerSmartMemoryMacros is not a function` 已消失。
> 下面是它加载后立刻撞上的两堵墙，**都不是模块链问题**。

| # | 现象 | 档位 | 根因与建议 |
|---|---|---|---|
| 1 | `Embedding model fetch failed … url=http://localhost:11434/api/tags` | **P1（安全口径 vs 兼容性，需用户拍板）** | 插件要直连本机 Ollama（11434），被**插件沙箱网络守卫**拦掉。ST 是单机、插件可直连本机服务；我们是多用户站点，默认拦本机/内网地址（SSRF 防护）。可选：① 给本机 AI 服务端口（11434 Ollama / 7860 SD WebUI / 8188 ComfyUI …）开**显式 allowlist**（配置项，默认空）；② 要求插件改走我们的代理端点；③ 维持拦截、在 UI 明说"本机插件联网被禁止"。⛔ 不要默认放开内网。 |
| 2 | `TypeError: Cannot set properties of undefined (setting 'lastActive')` | P2 | 插件期望 `extension_settings.memory` 里已有子键（ST 里 memory 扩展默认 38 个键）；我们只给空对象 `{}`。修法：按**扩展名**补默认子键（可从对应 bundled 扩展的 loadSettings 默认值生成），不要为单个插件写死。⚠️ 与 D1/D1b 的"命名空间级默认"是两层，别混。 |

验收：① 真插件复跑，`Embedding model fetch failed` 消失（若选 allowlist）；② `lastActive` 那条消失；
③ 两条都存在时，插件仍不得影响其他插件（隔离性）；④ 任何放宽都要有"未授权时仍被拦"的失败测试。

### [P2-14] 补记（2026-10-21 傍晚 · 主脑实测）
**第 1 条（本机 AI 服务被拦）已实测：机制存在且可用，缺的只是 UI。**
- 落点：`frontend/src/lib/plugin-system/sandbox.ts` 的 `readPluginFetchWhitelist()`（`:1378`）
  读 **localStorage 键 `palink_plugin_fetch_whitelist`**，格式是**逗号分隔的 hostname**（不是 JSON 数组！）；
  判定 `isUrlAllowedByPluginWhitelist()`（`:1401`）：同源恒放行，跨源只看 hostname 是否命中。
- 实测：把该键写成 `localhost,127.0.0.1` → 真插件 Smart Memory 的
  `Embedding model fetch failed (url=http://localhost:11434/api/tags)` **消失**（只剩 `lastActive` 那条）。
  ⚠️ 我先写成 JSON `["localhost","127.0.0.1"]` 时**不生效**——解析器按逗号切，引号和方括号会留在 hostname 里。
- ⇒ 用户裁定"要开白名单"后，要做的是**给这个键补 UI**（插件管理页：列表增删 + 本机 AI 服务一键预设
  `localhost` / `127.0.0.1`，写入时用逗号格式），**默认保持空**（恶意插件探测用户本机服务是真风险）。

### [P2-14] 补记 2（2026-10-21 夜 · 批次WU 已做完第 1 条的 UI）

UI 已落地：**设置 → 插件 → 「插件网络白名单」**（`AdminPluginsTab.tsx`）。
解析/读写抽到 `frontend/src/lib/plugin-system/plugin-fetch-whitelist.ts`，
沙箱判定改为共用它（同一份格式契约，不再有第二套解析器）。
行号锚点（**本批后有效，上面 :1378/:1401 已因抽模块漂移**）：
`plugin-fetch-whitelist.ts:17` 键名 / `:108` 写入 / `:127` 生效名单，
`sandbox.ts:1369` 读取入口 / `:1379` 判定函数。
守卫两文件：`__tests__/wu-plugin-fetch-whitelist.test.ts`（格式契约 + 真判定函数）、
`settings-tabs/__tests__/wu-plugin-whitelist-ui.test.tsx`（点 UI → 落盘 → 判定放行 整链）。
**第 2 条（`extension_settings.memory` 缺子键）仍未动**，与本批无关，继续挂 P2。

⚠️ 实测中纠正一条本批写文档时的想当然：**"畸形 URL 判 false"是不对的**。
`isUrlAllowedByPluginWhitelist('not a url')` 返回 **true** —— 因为判定时带了
`new URL(url, window.location.href)` 基址，相对写法一律解析成同源并被放行
（插件 fetch 自己的 `/scripts/...` 模板正依赖这条）。真返回 false 的只有"URL 构造本身失败"（如 `http://`）。

### [P2-14] 补记 3（2026-10-21 夜 · WU 上线后真机读数，验收① **未闭环**）

UI 已上线（第九次窗口，入口 `index-B1gYRfbW.js`）。真机取到的判据全绿：
该栏在 设置→插件管理 可见、五个默认 CDN 只读、粘贴 `http://localhost:11434/api/tags`
落盘为 `localhost`、一键预置得 `localhost,127.0.0.1`、非法输入报错且不写盘、
存储值确认是**逗号不是 JSON**（`storedIsCommaNotJson=true`）。

**但验收① 这一轮无法判定**：跑了 A/B（一臂删空白名单、一臂填 `localhost,127.0.0.1`），
**双臂的 `Embedding model fetch failed`/`lastActive` 都是 0 次** —— 不是修复生效，是
**Smart Memory 插件现在是 `enabled=false`**（`ComfyInject`、`Kimi Thinking Prefill` 同样关着）。
⇒ 它不发请求，就没有对照组。**不是本批关的**（WU 全部探针只读 + 重建 dist，没发过 `PUT /toggle`）。
⇒ 谁关的未知，**需用户确认**：如果那是他自己关的，验收① 就要等他重新打开再跑；
   如果不是，那是另一条待查（插件启停状态被谁改了，与 R1 的作用域收紧有关吗）。
   复跑脚本现成：`.tmp_probe/wu_ab.js`（会话 `wu_live1`，约 40s，不花钱）。
