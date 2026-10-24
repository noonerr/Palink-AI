# REPORT — VER1b 全卡池装配同构普查（26 卡逐卡取证汇总）· 2026-10-24

> **状态：已完工待主脑复验。**
> **判例依据**：`REPORT_VER1_装配同构差异首版_2026-10-24.md` §4 差异表 + §7 裁定表；`REPORT_VER1_装配同构差异_猫娘卡补跑_2026-10-24.md`（含 D-C1 判例）。编号口径沿用首版 D-1~D-12 + 猫娘补跑 D-C1，共 **13 个编号**。
> **数据来源**：26 张卡的片级取证结果（逐卡 JSON，存档于 `.tmp_probe/ver1b_cards.json`）。复现率由 `py .tmp_probe/ver1b_tally.py` **机械清点**（非人工点数），脚本校验 26 卡 × 13 编号覆盖完整、dItems/notTriggered 无交集（输出 `COVERAGE_OK`）。
> **隐私红线**：本报告只记 索引/role/长度/结构标记 与角色名，不含卡正文。

---

## 0. 摘要

- **26/26 卡完成**装配三变体取证（W1 基线 / W2 depth 族 / W3 闭合标签守卫），片级失败 0，零写入（§7）。
- **6 个编号全池无条件复现**（26/26）：D-5、D-6、D-7、D-10、D-11、D-12。
- **条件触发即必现**：D-1（有绑定世界书 14/14）、D-4（personality 非空 7/7）、D-8（有 atDepth 条目 10/10，一致确认）、D-3（实体卡块适用 8/8）。
- **稀疏观测**（条件稀缺，非机制缺席）：D-2（2/26，全池仅 2 卡过记忆门）、D-C1（1/26，唯一 bcf12cd3 满足判例双条件）、D-9（11/26，15 张未触发全是钳制掩蔽）。
- **新发现 3 条，全部待主脑裁定**：NF-1 历史消息 role=NULL 原样透传（1 卡，汇总员已独立复跑核实）、NF-2 无 MVU 状态时 `{{get_message}}` 宏原文直送模型（2 卡）、NF-3 WI position=2（ANTop→作者注通道）被压平进 [World Lore] 尾块（1 卡）。
- **对 ASM-4 的影响**：首版 §7.3 施工范围八条（D-1~D-5、D-7、D-9、D-12）全部得到多实例支撑，施工图不变；D-8 不回归判据在全池 10/10 同构下成立。NF-1/NF-2/NF-3 裁定前不计入施工图（沿 D-C1 同口径）。

---

## 1. 总账（完成/总数、跳过原因）

| 项 | 值 |
|---|---|
| 完成 / 总数 | **26 / 26**（片级失败：无——任务书原文） |
| 取证方式 | 每卡 dump 三变体（W1/W2/W3），全部只读；budget 全池同值 997440 |
| 四件套核验 | 26 卡由片级逐一核验（character/session/branch/branch_msgs 与任务书相符，记录在各片 notes）；f03aa553 为合成 id 特例（cc-inline-test-0001-…）但四件套在库、VERIFY 通过（user=card_test_user，branch_msgs=3），非 dump 失败 |
| 跳过原因 | 无跳过卡 |

**不计差异的数据形状项**（片级已定性，供主脑知情，不动 ASM-4 账）：
- 实体卡截断行为随 stat_data 体量变化：c28061bb/c44f2ae6/7a3a5dfc/bcf12cd3/6c2103a4 = tok 54 truncated；3c732087 = 358 未截断；8b851ded = 362 未截断（同族克隆状态不同，数据差异非装配差异）。
- 170af4f2 首条为 user（卡有 first_mes 但该会话历史未存开场白楼）——会话数据状态，不计账。
- 世界书条目 primary_keys_mismatch skipped：552e750a 7 条、c795d62a 4 条（pos1 角色关系）、943f434b glade 1 条——关键词激活数据面。
- 2687f81d vs 66418966：同激活集 bulk 条目顺序不同（合并本就丢 before/after 语义，D-1 域内）。
- desc `{{user}}` 宏展开随用户名伸缩：+6（c364414c）/ +12（943f434b）/ −668（2687f81d/66418966，DESCCHK 实测）。

**已知伪影与观察项**（沿判例口径，未计差异）：
- `memory error: This transaction is closed`：仅在记忆注入在场的 2 卡（c28061bb/c44f2ae6）在报——首版 §1.3 已记载非新问题；gate skipped 卡无此回显（与猫娘补跑 §0『生产入口无此回显』一致）。
- O-1 `[WB-UNBOUND] galgame界面插件 未绑定` 警告：片级明示在报 4 卡（c28061bb/c44f2ae6/3c732087/bcf12cd3），明示不在报 4 卡（81f45de1/170af4f2/552e750a/6c2103a4）；6c2103a4 附归属维度证据（census_final.py：该书 user_id=1(admin)、character_id=None，本卡会话属 user=mobileaudit 不在可见域）——O-1 的可见性随会话归属变化。其余 18 卡片级 notes 未提及。
- `[MVU-STATE-UNAVAILABLE]` 重演无原料信息行：6c2103a4/2687f81d/66418966/08add991 在报，信息行非异常。
- 4ed108d4 前部 `[Example Chat]` 示例块（M1–M3，system 14/37/71）= ST dialogueExamples 同构（openai.js:1113/:1099，位于 chatHistory 前）——首版 §6.3『对话示例无实例』的**首个实例**，不构成差异。

---

## 2. 逐卡索引（26 卡）

> 形状速记：S0=前部 system（M0，len）/ S1=历史区 / S2=尾部混合块（len，构成）/ S3=user「继续」/ S4=WI atDepth 块（len，条件）。缺失记「缺」。

| # | 卡（charId 前 8） | msgs | est | 形状速记 | D 计数 | 关键备注 |
|--|--|--|--|--|--|--|
| 1 | c28061bb（露缇雅原卡） | 28 | 31875 | S0=2165 · S1=24 窗口 · S2=25656（WL+实体卡54trunc+记忆7127+校准四段）· S4=5491@depth0×6 | 12 | 首版原卡 branch 91→101；memory 伪影在报；O-1 在报 |
| 2 | c44f2ae6（露缇雅克隆） | 28 | 33018 | S0=506 · S2=25317（WL+实体卡+记忆7181）· S4=6045×6 | 11 | 世界书副本 0d10b4a2；memory 伪影在报；O-1 在报 |
| 3 | 7a3a5dfc | 21 | 20696 | S0=506 · S1=17 全量 · S2=14585（WL+实体卡）· S4=5359×6 | 10 | 无 memory 伪影（gate skip）；O-1 在报 |
| 4 | 81f45de1 | 16 | 5371 | S0=499 · S2=62（仅【角色校准】单段）· S4 缺 | 8 | D-4 最纯形态（校准段独占尾块位）；无 O-1 |
| 5 | 170af4f2 | 9 | 2370 | S0=463 · S2=62（仅校准）· S4 缺 | 8 | 首条 user 属会话数据状态，不计账 |
| 6 | 552e750a | 8 | 3125 | S0=415 · S2=3316（仅 [World Lore] before+after 合并）· S4 缺 | 8 | **D-1 最纯实例**（无 atDepth/记忆/实体卡干扰仍合并单块） |
| 7 | 3c732087（露缇雅克隆） | 9 | 14797 | S0=506 · S2=14974（WL+实体卡 358 未截断）· S4=5308×6 | 10 | 世界书副本 5a5cc99a；dcp=2 |
| 8 | 4ed108d4（英文卡） | 9 | 375 | S0=1186 · 前部示例块 M1–M3 · S2=校准 en 195 独立条 · S4 缺 | 8 | [Example Chat] 同构首实例；en 标记经 census_marks.py 补测证实 |
| 9 | 08236cc4 | 6 | 378 | S0=484 · S2=校准 60 独立条 · S4 缺 | 8 | D-9 证据：W2 depth=4 落 M2=splice(6−4)，ST 应落历史区头，偏移 1 槽 |
| 10 | bcf12cd3（猫娘判例卡） | 7 | 11619 | S0=510 · S2=2871（WL+实体卡）· S4=15159×4 | 11（含 D-C1） | **D-C1 全池唯一复现**（末楼 2181→684 面板被剥）；O-1 在报 |
| 11 | f03aa553 | 5 | 340 | S0=434 · S2 缺（零尾部槽）· S4 缺 | 6 | 合成 id 但四件套在库 VERIFY 通过 |
| 12 | 77491574 | 4 | 345 | S0=430 · S2 缺 · S4 缺 | 6 | **NF-1 role=NULL 楼**（msg id=1297）；汇总员复跑核实 |
| 13 | e126eac8（HTML测试角色 第二实例） | 4 | 317 | S0=430 · S2 缺 · S4 缺 | 6 | 本分支 role 正常，无 NULL 形态 |
| 14 | 6c2103a4（猫娘克隆） | 6 | 10210 | S0=516 · S2=2818（WL+实体卡）· S4=15396×4 | 9 | 无 O-1 警告（书属 admin 不在可见域=O-1 归属证据）；dcp=2 |
| 15 | 811c9211 | 5 | 387 | S0=443 · S2=60（仅校准）· S4 缺 | 8 | D-9 算式吻合但判别力弱，**片级标待主脑裁定** |
| 16 | ed9c7049 | 3 | 305 | S0=430 · S2 缺（全片唯一无任何尾部 system）· S4 缺 | 6 | 最小装配（M0+开场白+user） |
| 17 | 1741555d（英文卡） | 4 | 290 | S0=1064 · S2=148（[Character Calibration] en）· S4 缺 | 7 | D-4 英文分支复现（en 标记补测证实在场） |
| 18 | 943f434b（英文卡） | 4 | 1884 | S0=3851 · S2=3213（WL bulk 3 条激活）· S4 缺 | 7 | **唯一 before 桶数据实例**（全 before×4，Eldoria 书 352e0466）；bulk 内宏已展开 |
| 19 | c364414c | 4 | 1865 | S0=3842 · S2=3201（WL bulk）· S4 缺 | 7 | 与 943f434b 同源克隆、独立世界书 d69a2a94，结构逐段同构 |
| 20 | 2687f81d（MVU 卡） | 5 | 16591 | S0=13881 · S2=11542（WL bulk 8 条激活）· S4=891@depth1（**落 S3 之前**） | 8 | **NF-2 宏残留**；D-8 depth=1 变体合并算式 910/923 逐字吻合 |
| 21 | 66418966 | 5 | 16591 | 同 20 逐段同构（bulk 顺序不同） | 8 | NF-2 同复现（独立世界书 605cdd18） |
| 22 | 08add991（猫娘克隆） | 5 | 10737 | S0=524 · S2=3121（WL+实体卡）· S4=15740×4 | 9 | WI 4/20/4 与判例同分布 |
| 23 | cc-inline-char-b…b1 | 3 | 263 | S0=431 · S2 缺 · S4 缺 | 6 | 极简智能卡测试夹具（desc 9 字/first 8 字） |
| 24 | 51ccb693 | 3 | 228 | S0=413 · S2 缺 · S4 缺 | 6 | 极简卡（desc 5 字/first 3 字） |
| 25 | c795d62a | 4 | 5170 | S0=390 · S2=7237（WL 单 flag，**含 pos2 条目**）· S4 缺 | 7 | **NF-3 pos2 AN 通道压平**；片级勘误已纠正（条目在装配中非被丢弃） |
| 26 | 8b851ded（露缇雅克隆） | 5 | 14529 | S0=1631（**含真实用户级 IN_PROMPT 扩展**）· S2=14924（WL+实体卡 362）· S4=5312×6 | 9 | **D-12 真实实例**（bubble-dialogue-format tok=708 并入 M0；W2 复测 +22 同判例） |

---

## 3. 全池复现率表（13 编号 × 26 卡）

> 复现数由 `py .tmp_probe/ver1b_tally.py` 机械清点（26 卡 × 13 编号覆盖完整、dItems/notTriggered 无交集，脚本输出 `COVERAGE_OK`）。

| 编号 | 机制一句话（判例口径） | 复现 | 未触发 | 未触发最常见原因 | 判例裁定状态（首版 §7 / 猫娘判例） |
|--|--|--|--|--|--|
| **D-1** | 世界书 before/after 合并为历史后单条 [World Lore]（ST 应然前部两条夹 main） | **14/26** | 12 | 卡无绑定世界书（worldbook skipped no matched entries）→ 无尾块可观测（12/12 唯一原因） | A-1 已知未裁定，ASM-4 主项 |
| **D-2** | 记忆混进 S2 尾部混合块（ST 应然前部独立消息） | 2/26 | 24 | 记忆门控 skip（gate msgs≤17/24）→ 记忆未注入（24/24 唯一原因）；长会话第二实例仍缺 | A-1 已知未裁定 |
| **D-3** | MVU stat_data 压平实体卡落 S2 尾块 | 8/26 | 18 | 非 MVU 卡（16/18）；另 2 张 MVU 卡更新规范由卡 prompt 自带、无实体卡块（2687f81d/66418966） | 归 ASM-4（首版 §7.2） |
| **D-4** | 【角色校准】personality 摘要尾部二次注入（zh/en 双语分支） | 7/26 | 19 | personality 空（len=0 或 None）→ builder 空则不追加（19/19 唯一原因；判据 `character_message_builder.py:294-301` 汇总员实读在场） | 保留+随 ASM-4 拆独立消息（P-DEC-5） |
| **D-5** | S0 main+卡字段+标题指令合并单条（ST 应然分立） | **26/26** | 0 | — | 归 ASM-4（拆） |
| **D-6** | 标题指令并入 S0（zh ×22 + en ×4 同机制白名单件） | 26/26 | 0 | — | 白名单确认（不再计差异） |
| **D-7** | 历史区头无 newMainChat 引导 | **26/26** | 0 | — | 归 ASM-4（补，P-DEC-6） |
| **D-8** | WI atDepth 合并条落数组最末、user 之后（**与 ST 同构 = 一致确认项**） | 10/26 | 16 | 无 atDepth（position=4）条目：无世界书 12 卡 + 有书但全 before/after 分布 4 卡（552e750a/943f434b/c364414c/c795d62a） | 一致确认（ASM-4 验收不回归判据） |
| **D-9** | depth 锚定数组含尾部块 → Palink depth N ≈ ST depth N+1 | 11/26 | 15 | 短历史/零尾槽下 floor 钳制或饱和使两侧落点同位、偏移不可观测（15/15 同族；判别实例仅 c28061bb/c44f2ae6 的 24 楼窗口） | A-1 派生，随 ASM-4 消化，⛔ 禁单独修 |
| **D-10** | depth=0 守卫改写 depth=1，落末条 user 之前 | 26/26 | 0 | — | 已裁定（白名单；DEC-1 拍板回退与否） |
| **D-11** | 同行闭合标签 len=31 原样存活（守卫②行粒度边界） | 26/26 | 0 | — | 观察项（记录在案不修） |
| **D-12** | IN_PROMPT 条目字符串级 append 进 S0（+22） | **26/26** | 0 | — | D-5 派生，随 ASM-4 消解 |
| **D-C1** | prompt regex minDepth 锚定数组含尾部块/注入 → 面板有无随注入翻转 | 1/26 | 25 | 卡无 regex 脚本 16 + 脚本在场但 minDepth 全 null 无深度作用域 7（c28061bb/c44f2ae6/7a3a5dfc/3c732087/2687f81d/66418966/8b851ded）+ scoped 在场但判例条件不成立 2（6c2103a4 历史无匹配内容、08add991 末楼为开场白无面板） | 新发现待主脑裁定（猫娘判例全链取证） |

**表注（待裁定项，未硬编）**：
1. D-9 的 811c9211 片级标注「算式吻合（5−4=1）但 2 楼历史上判别力弱，是否计复现待主脑裁定」——本表按片级 dItems 原样计入（11/26）；若主脑裁定剔除则为 10/26。
2. D-8 的 2687f81d/66418966 为 depth=1 变体（S4 落 user 前一位、且与 W2/W3 注入同 depth/role 合并 891+18+1=910 / 891+31+1=923 逐字吻合），片级判「一致确认复现」，本表采信。
3. 条件触发即必现的四条（D-1/D-3/D-4/D-8）在各自数据前提成立的卡上**零例外**：D-1 = 14/14（有世界书卡）、D-4 = 7/7（personality 非空卡）、D-8 = 10/10（有 atDepth 条目卡）、D-3 = 8/8（实体卡块适用卡）。

---

## 4. 新发现清单（3 条，均待主脑裁定）

| # | 现象 | 证据 | 涉及卡数 | 建议归宿 |
|--|--|--|--|--|
| **NF-1**（片级未编号，片级声明既有 D-1~D-12/D-C1 均不覆盖） | 历史消息 role=NULL **原样透传**进最终装配 payload（发往 LLM 的 messages 含 `role: null` 条目） | ① 片级 dump：M2 role=None len=99，三变体一致；② 落库形态只读 SQL——片级 census_roles2.py + **汇总员本轮复跑** `ver1b_nf1_recheck.py`：该卡会话域 role IS NULL 全库仅 1 条（msg id=1297，len=99，created 2026-06-23），分支 6d9ba114 共 2 条 = assistant×1 + NULL×1，与片级证据逐字吻合；③ 透传点 `character_message_builder.py:275` `messages.append({"role": m.role, "content": msg_content})` 直取 DB 字段无归一化（**汇总员 sed 实读在场**）。ST 侧 chat 数组 role 由 is_user/is_system 布尔派生（script.js:2593），不存在 NULL role 形态。影响：role=null 随 messages 发往 LLM（下游 API 是否报错**未实测**——本普查不发请求）；深度锚定数组把它当普通历史槽计数 | **1**（77491574） | **另立新号**（如 D-13）。附带建议：全库 `role IS NULL` 清点只查了该卡会话域，收口前宜全表清点一次（只读） |
| **NF-2**（片级标注 N-3片-1） | 无 MVU 变量状态时，WI 条目内 `{{get_message}}` 族宏**不展开、宏原文直送模型** | 片级 census3_meta.out：W1CHK raw_getmsg_macro=1（M3 len=891 内 1 处）；每变体打印 [MVU-STATE-UNAVAILABLE]（重演无原料）。对照猫娘判例：变量状态在场时同族宏在 macro_eval 环节正常展开（S4 10117→15159） | **2**（2687f81d + 66418966，同源克隆、独立世界书实例，独立复现） | ST 无此宏族，**非 ST 结构差异，不进 ASM-4 ST 对齐账**；待主脑裁定属预期降级还是缺陷（应占位/省略该块） |
| **NF-3** | WI position=2（WI_POS_BEFORE_AN，ST 语义 = ANTop→作者注通道）条目被**压平进 [World Lore] 尾部混合块**，AN 通道语义丢失 | 片级 census_c795d62a_wi3.py：pos2 条目「玲珑玉女宗 - 特殊机制」（enabled、激活 tok=510 计入 entries=14）经 strip_template_syntax+宏替换后 head/mid/tail 三切片全部 in_M2=True。代码锚点（**汇总员 sed 实读在场**）：`worldbook_service.py:2165-2187`（pos2 走 else 分支入 entries_by_position，:2186-2187 全部 position join 进一条 text）+ `roleplay_prompt_assembly.py:4954-4988`（wb_result.text 整体入 dynamic_context_parts）。ST 侧该类条目应并入作者注随 AN 落位（world-info.js:5151-5152，判例首版 §3.1 锚） | **1**（c795d62a） | 片级建议：**D-1 机制面的扩展证据**（D-1 原文只记 before/after 双桶合并，未覆盖 pos2/3 的 AN 语义压平）——归 D-1 扩展或另立，待主脑裁定。若归 D-1 扩展，ASM-4 的 D-1 修复须把 pos2/pos3 从「全 position join」拆出单独落位，施工图需增补此面。**勘误**（片级自纠，记录在案）：初判「条目内容被整体丢弃」系探针假阴性（strip 与宏替换使原文切片不匹配），已由 wi3 探针证伪——条目在装配中，只是落位同 D-1 |

---

## 5. 结论：结构性 vs 条件性

### 5.1 全池结构性 —— ASM-4 必修面（普查后**加固**，施工图不变）

- **无条件复现（26/26，任何卡都逃不掉）**：D-5（前部单条合并）、D-7（无 newMainChat 引导）、D-12（IN_PROMPT 字符串级 append）——此三条是 ASM-4 施工范围内无条件结构性差异；D-12 还获得 8b851ded 的**真实用户级 IN_PROMPT 扩展**实例（非仅合成标记）。
- **条件触发即必现（前提成立时零例外）**：D-1（有绑定世界书 14/14）、D-3（实体卡块适用 8/8）、D-4（personality 非空 7/7）、D-9（判别实例 2 + 算式吻合 9）——同属装配机制差异，前提是卡数据形状，不是偶发。
- 首版 §7.3 的 ASM-4 施工范围（D-1~D-5、D-7、D-9、D-12 八条一起动）经 26 卡普查**无一被推翻**，全部得到第 3~第 26 实例支撑；D-8 不回归判据在全池 10/10 同构（含 depth=1 变体合并算式 910/923 逐字吻合）下成立。

### 5.2 全池复现但**不构成待修**（裁定/白名单/观察项，普查只证明机制普遍在场）

- D-6（26/26，白名单确认；zh ×22 + en ×4 同机制）、D-10（26/26，已裁定白名单）、D-11（26/26，观察项）。ASM-4 施工后回归时，这三条应保持行为不变。

### 5.3 条件性/稀疏观测（低复现率 = 观测条件稀缺，非机制缺席）

- **D-2（2/26）**：全池仅 c28061bb/c44f2ae6 过记忆门（28 楼窗口）；机制面（落位+粒度）在两卡稳定同构。「长会话第二实例」沿判例遗留仍缺。
- **D-C1（1/26）**：唯一 bcf12cd3 同时满足判例双条件（scoped minDepth 脚本 + 历史含 UpdateVariable 面板）。25 张未触发中 7 张 minDepth=null 说明：该差异只在卡作者**按 ST 语义显式设置 minDepth** 时可见——全链取证见猫娘判例，机制存在性无争议。
- **D-9（11/26）**：15 张未触发全部是观测掩蔽（短历史 floor 钳制/饱和/零尾槽使两侧落点同位），不是机制缺席；判别实例 = 24 楼窗口两卡（c28061bb/c44f2ae6）。

### 5.4 个别卡数据形状（不计装配差异，但回归测试设计需知情）

实体卡截断阈值行为（54 truncated ↔ 358/362 未截断）随 stat_data 体量变化；同激活集 bulk 条目顺序可不同；desc 宏展开随用户名伸缩（+6/+12/−668）；首条是否开场白楼属会话数据状态。这些在 ASM-4 回归断言里应做形状归一化，不能当装配回归信号。

### 5.5 新发现对 ASM-4 的影响

NF-1/NF-2/NF-3 均待主脑裁定，裁定前不计入 ASM-4 施工图（沿 D-C1 同口径）。其中 NF-3 若归 D-1 扩展，D-1 修复面需增补 pos2/pos3 AN 通道拆分；NF-1 属 builder 直出链路（与装配同构无关但同链路），是否随 ASM-4 同批做 role 归一化待裁定。

---

## 6. 复跑命令与探针清单

**主命令模式**（容器内只读，stdin 进容器；探针全部在 `.tmp_probe/`）：

```bash
docker exec -i palink-ai-backend-1 bash -c 'cd /app && PYTHONPATH=/app python -u -' < .tmp_probe/census_<charId前8>.py
```

**逐卡主探针（26 个，全部实测在盘）**：

| 卡 | 主探针 | 片级引用的补测探针 |
|--|--|--|
| c28061bb | census_c28061bb.py（ver1_dump.py 逐字节改参，片级明示） | census_meta.py（6 脚本 minDepth=null） |
| c44f2ae6 | census_c44f2ae6.py * | — |
| 7a3a5dfc | census_7a3a5dfc.py * | — |
| 81f45de1 | census_81f45de1.py * | — |
| 170af4f2 | census_170af4f2.py * | — |
| 552e750a | census_552e750a.py * | — |
| 3c732087 | census_3c732087.py * | — |
| 4ed108d4 | census_4ed108d4.py * | census_marks.py（en 标记补测，片级明示） |
| 08236cc4 | census_08236cc4.py * | — |
| bcf12cd3 | census_bcf12cd3.py * | census_regexmeta.py（scoped=6，片级明示） |
| f03aa553 | census_f03aa553.py * | — |
| 77491574 | census_77491574.py * | census_roles.py（首版误带 type 列报 UndefinedColumn，只读无写入）→ census_roles2.py（复查成功，片级明示）；**汇总员复跑** ver1b_nf1_recheck.py |
| e126eac8 | census_e126eac8.py * | — |
| 6c2103a4 | census_6c2103a4.py * | census_final.py（O-1 归属证据，片级明示） |
| 811c9211 | census_811c9211.py（片级明示，与 ver1_dump.py 仅差 4 行，diff 实测） | — |
| ed9c7049 | census_ed9c7049.py（片级明示） | — |
| 1741555d | census_1741555d.py（片级明示） | — |
| 943f434b | census_943f434b.py（片级明示） | — |

---

## 主脑复验与裁定（2026-10-24 · 复验收讖）

- 复验采信：26/26 机械清点（ver1b_tally.py + 覆盖完整性 COVERAGE_OK）、零写入双快照（29/32/248/16 两次逐字同）、D-8 十卡一致确认与 VER-1 首卡判例吻合。D-9 的 811c9211 判别力弱点与 D-C1 仅 1 卡复现如实入册，采信其低基率定性。
- **ASM-4 施工图更新**：适用即全复现的结构项（D-1 于有书卡 14/14、D-3 8/8、D-4 7/7、D-5/D-6/D-7/D-12 全池 26/26）确认为全池结构性；D-2/D-8/D-9/D-C1 属条件性/低频。首版 §7.2 的八条范围不变，优先级按复现率重排：D-5/D-12/D-7（全池）→ D-1+**NF-3 并入**（有书卡零例外 + AN 通道丢失同根）→ D-3/D-4 → D-9/D-C1 随拆分自然消解。
- **NF-1（role=NULL 历史消息透传进装配 payload，77491574，1/26）**：裁定为**真缺陷、ASM-4 外另立小批**——先取证该消息的产生路径（异常中断/导入残留？），修法方向为序列化层对 NULL role 跳过或映射 assistant 并留痕，不许原样透传。
- **NF-2（`{{get_message}}` 宏无 MVU 状态时原文直送模型，2/26）**：裁定**不进 ST 对齐账**（ST 无此宏族）；登记为宏降级缺口——上游 MVU 的 get_message 语义待核，未核前至少应降级为空串而非原文直送（防止模型把宏当指令）。P2。
- **NF-3（WI position=2/3 ANTop/ANBottom 被压平进尾部 [World Lore]，1/26）**：裁定**并入 D-1 作扩展项**——ASM-4 拆尾块时 AN 位条目走 anBefore/anAfter 通道（ASM-3 的 worldbook-scan 端点已按 ST 形状返回这两字段，后端 entries_by_position 已分位，缺的是装配落位）。
| c364414c | census_c364414c.py（片级明示） | — |
| 2687f81d | census_2687f81d.py（片级明示） | census3_meta.py（宏残留 W1CHK，片级明示）、census3_descchk.py（desc −668） |
| 66418966 | census_66418966.py（片级明示） | — |
| 08add991 | census_08add991.py * | census_facts.py（四件套/脚本/WI 分布） |
| cc-inline-char-b…b1 | census_cc-inlin.py * | census_facts.py |
| 51ccb693 | census_51ccb693.py * | census_facts.py |
| c795d62a | census_c795d62a.py * | census_facts.py；pos2 取证链 census_c795d62a_wi.py → _wi2.py → **_wi3.py（最终证实）** |
| 8b851ded | census_8b851ded.py * | census_facts.py |

\* = 片级 JSON 未显式命名主探针的卡（18 张），按 `census_<charId 前 8>.py` 命名与盘上文件一一对应——**对应关系由文件名推断，汇总员未逐个 diff 内容**，如实标注。

**模板与汇总辅助**：
- dump 模板：`.tmp_probe/ver1_dump.py`、`.tmp_probe/ver1_dump_cat.py`（改参复用，别重写逻辑——纪律原文）。
- 汇总核算（本轮汇总员新增，纯本地不进容器）：`.tmp_probe/ver1b_cards.json`（26 卡片级结果存档）+ `.tmp_probe/ver1b_tally.py`（复现率机械清点；运行 `py .tmp_probe/ver1b_tally.py`，输出 `COVERAGE_OK` + 13 行计数）。
- 零写入快照：`.tmp_probe/census_counts.py`（四项计数）。
- 盘上另有 `ver1_census_chars.py` 未被任何片级结果引用（记录在案，用途未考）。
- 多数卡留有 `census_<charId 前 8>.out.txt` 输出存档（c28061bb/c44f2ae6/7a3a5dfc/81f45de1/170af4f2/552e750a/3c732087/ed9c7049/943f434b/c364414c/2687f81d/66418966/811c9211/1741555d 实测在盘）。

---

## 7. 零写入计数（汇总员开工/收尾快照）

| 时点 | chars | sess | msg | wb | 手段 |
|--|--|--|--|--|--|
| 开工 | 29 | 32 | 248 | 16 | `docker exec -i palink-ai-backend-1 bash -c 'cd /app && PYTHONPATH=/app python -u -' < .tmp_probe/census_counts.py` |
| 收尾 | 见下 | | | | 同上 |

- 开工快照与纪律基线（29/32/248/16）逐字一致。
- 汇总员本轮容器内只运行了 2 个只读探针：`census_counts.py`（×2，开工/收尾）与 `ver1b_nf1_recheck.py`（×1，NF-1 复核；无 add/commit/flush，finally db.close()）。
- 26 张片级 notes 均各自记录跑前跑后四项计数一致（多数明示 29/32/248/16）。
- 收尾快照值：见报告生成后追加的最终行（若与开工行不同即为违规，以实测为准）。

> **收尾快照（汇总员落笔后实测追加）**：chars=29 / sess=32 / msg=248 / wb=16 —— 与开工逐字相同，零写入成立。
