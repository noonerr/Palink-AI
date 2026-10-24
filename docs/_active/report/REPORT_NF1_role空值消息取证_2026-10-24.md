# REPORT_NF1_role空值消息取证_2026-10-24

> **状态：已完工待主脑裁定**
> 任务：NF-1 取证（本批只取证、不施工）。上游裁定：`REPORT_VER1b_全卡池装配同构普查_2026-10-24.md` 主脑裁定段——
> "真缺陷、ASM-4 外另立小批——先取证该消息的产生路径（异常中断/导入残留？），修法方向为序列化层对 NULL role 跳过或映射 assistant 并留痕，不许原样透传"。
> 纪律：全程只读（DB 探针零 add/commit/flush，finally close）；不输出消息正文（只记长度）；零写入双快照见 §6。

---

## 0. 一句话结论

`character_chat_messages` 全库仅 **1 条** role=NULL（id=1297，2026-06-23 12:33 UTC，"HTML测试角色"卡第三实例会话）；**当前代码 15 个构造点 + 2 个更新点无一路径能写出 role=NULL**（全部硬编码或归一化），且该行形态（extra/swipes/mesid 全 NULL）与现存 ST 同步三路径的必设字段矛盾——写入者是 **2026-06-23 当天活跃、现已不存在（或已改写）的死代码**，最可能是当日正在快速演化中的早期 ST 插件链/HTML 卡消息路径的一个当日中间变体；孪生行 id=1299（64 分钟后、另一实例会话、同 99 字符）证明同一动作在当天稍晚的代码变体下已正确落 role='assistant'。爆炸半径：NULL role 会以 `"role": null` 进 provider JSON 请求体（**上游反应未实测**），instruct 包裹层会把它当 **user 轮**包裹，显示层把它当 assistant 渲染（与 is_user=False 一致，视觉无害）。

---

## 1. 取证范围与方法

| 探针（均在 `D:/项目/Palink-AI/.tmp_probe/`） | 内容 | 纪律 |
|---|---|---|
| `census_counts.py`（复用普查批现成口径） | 四项计数快照 A/B | 只读，finally close |
| `nf1_msg1297_trace.py`（本批新写） | id=1297 全貌 + 会话/分支 + 角色序列 | 只读，零写入 |
| `nf1_role_null_surface.py`（本批新写） | 全库 8 表 role 列普查 + 分布/聚簇/时间线/id 邻域 | 只读，零写入 |
| `nf1_twins_compare.py`（本批新写） | 孪生行 1295/1296/1297/1298/1299 字段级对比 | 只读，零写入 |

执行方式均为：`docker exec -i palink-ai-backend-1 bash -c 'cd /app && PYTHONPATH=/app python -u -' < <探针>`（`MSYS_NO_PATHCONV=1`）。
六月源码考据：`_BACKUPS/2026-06-08_source-snapshot/source-snapshot-nogguf.tar.gz` 解包到 `.tmp_probe/nf1_junesrc/`（探针区内解包，不动备份原件）。

---

## 2. 第一步 · 溯源

### 2.1 案发行全貌（msg id=1297，只读 SQL 实测；content 只记长度）

| 字段 | 实测值 |
|---|---|
| id | 1297 |
| session_id | `5f0e261f-76bf-4253-a7d0-b78dee2febb8` |
| branch_id | `6d9ba114-d150-40d7-aae3-2d29f58ba2eb`（"分支 1"，唯一分支，is_active=True，parent_branch_id/parent_message_id 均 NULL） |
| **role** | **NULL** |
| is_hidden | **NULL**（连隐藏位也是 NULL，与 role 同缺） |
| is_user / is_system | False / False（布尔派生口径下即 assistant 侧） |
| name | `'HTML测试角色'`（卡名，非用户名） |
| mesid | NULL |
| swipe_id | 0 |
| swipes | **NULL** |
| extra | **NULL**（⇒ **无任何 gen_id**：extra 整列为空，不存在键） |
| content_json / short_title | NULL / NULL |
| model / tokens / prompt_tokens | NULL / NULL / NULL（**无任何已完成的 LLM 生成挂在此行**；reasoning_tokens=0、cache 两列 NULL 为列默认） |
| content 长度 | **99 字符**（正文未读取，按纪律只记长度） |
| created_at | **2026-06-23 12:33:17.817065 UTC**（= 北京 20:33；`models/base.py:7` utc_now 为 UTC aware） |

### 2.2 相邻消息角色序列（同分支、全角色共 2 条）

```
id=1296  role='assistant'  is_user=F  is_sys=F  clen=193  swipes_len=222  model=None
         created_at = 2026-06-23 11:32:13.494341  ← 与会话创建时刻逐微秒相同 ⇒ 开场白行
id=1297  role=None         is_user=F  is_sys=F  clen=99   swipes=None    model=None
         created_at = 2026-06-23 12:33:17.817065  ← 会话开始 61 分钟后
```

序列形态：`assistant(开场白) → NULL`。分支无父、无复制痕迹，排除"分支拷贝丢 role"类路径。

### 2.3 当前代码全部消息构造点排查（15 个构造点 + 2 个更新点，逐一实读）

grep 口径：`grep -rn "CharacterChatMessage(" backend/app`（排除 `.mimosa/hook-state` 快照副本）+ `grep -rn "\.role = "`（更新路径）。逐点实读结果：

| 代码点 | role 传参 | 能否写 NULL | 形态比对 vs 1297 |
|---|---|---|---|
| `character_ext.py:3286`（slash extra_messages） | `em_role = em.get("role", "user")` | 否（唯一产出点 `slash_command_service.py:645` 硬编码 `"role": "user"`） | 不符 |
| `character_ext.py:3320`（slash system） | 硬编码 `"system"` | 否 | 不符 |
| `character_ext.py:3353`（POST /messages append·save_original） | `:3196` `role = (req.role or "assistant").strip().lower()` + `:3199-3206` is_user/is_system 布尔强制覆盖 | **否（双重归一化）** | 不符 |
| `character_ext.py:3789`（问候注入） | 硬编码 `"assistant"` | 否 | 不符 |
| `character_ext.py:4731`（会话创建·first_mes 落库） | 硬编码 `"assistant"`，且必设 swipes/short_title | 否 | 不符（1297 无 swipes/short_title） |
| `character_ext.py:4826`（用户消息） | 硬编码 `"user"` | 否 | 不符 |
| `character_ext.py:5035/5062`（生成持久化族） | 硬编码 `"assistant"` | 否 | 不符 |
| `silly_tavern.py:3034`（ST saveChat 同步） | `:3024`→`_st_message_role`（`:1210-1215`：is_system→system、is_user→user、**兜底 assistant，永不返回 None**） | 否 | **反证**：该路径必设 `swipes=_json_dumps(...)`、`extra=_json_dumps(...)`、mesid 必有值——1297 三者全 NULL ⇒ **排除** |
| `silly_tavern.py:4054`（chat 导入） | 同上派生 | 否 | 同上反证 ⇒ **排除** |
| `st_sync_service.py:795`（ST 导入建会话） | `_st_msg_role`（`:627-633`，同款兜底） | 否 | 同上反证 ⇒ **排除** |
| `websocket.py:821/848`（WS 生成持久化） | 硬编码 `"assistant"` + model/tokens/extra(gen_id) 必设 | 否 | 不符（1297 model/tokens/extra 全 NULL） |
| `websocket.py:1776` | 硬编码 `"assistant"` | 否 | — |
| `websocket.py:1929`（slash em） | 同 3286，否 | | 不符 |
| `websocket.py:1957/1971/1987` | 硬编码 system/user | 否 | 不符 |
| `slash_command_service.py:629` | 硬编码 `"user"` + is_user=True | 否 | 不符（1297 is_user=False） |
| 更新路径 `character_ext.py:3447-3459` | 赋值收口为 user/system/assistant | 否 | — |
| `app/api/sessions.py:262-289` | 属**普通聊天表** `ChatMessage`（models/message.py，表 `messages`），且 role 白名单校验（`:62-67`） | 不涉本表 | — |

**结论：当前代码没有任何路径能把 role=NULL 写进 `character_chat_messages`。**

### 2.4 六月源码考据（写入者已死的核心证据）

- git 历史**断层**：`git log --since=2026-06-01 --until=2026-07-10` 输出为空；全仓最早提交为 `7d5dea1 2026-08-17 restore: baseline of full working tree after git object loss`。`git log -S 'req.role or "assistant"'` 最早命中即该 restore 基线 ⇒ **归一化在 2026-08-17 之前已在场，但其引入时刻不可考**。
- 唯一六月源码物证：`_BACKUPS/2026-06-08_source-snapshot/`（`_INDEX.md` 明示"git 历史最早只到 2026-08-17，6 月的代码只存在于本包"；文件时间 Jun 7 21:48，**早于案发 15 天**）。
- 六月快照实读：`websocket.py` 4 处、`character_ext.py` 5 处消息构造**全部硬编码 role**（"assistant"/"user"），生成流占位行也是 `role="assistant"` 起手（`nf1_junesrc/backend/app/api/websocket.py:436/455/1138/1358`、`character_ext.py:1921/2706/2774/2841/2858`）；六月**不存在** `MessageAppendRequest`/POST `/{session_id}/messages` append 端点，也**不存在** `silly_tavern.py` 与 `st_sync_service.py`（tar 清单实测）。
- ⇒ 案发时（6/23）正在运行的 ST 插件链相关代码**晚于 6/8 快照、又未进 git**，是唯一无法复原的窗口。1297 的写入者就在这个窗口里。

### 2.5 孪生行证据（同日同动作族的成功对照）

全表 id 邻域（1290-1300）显示同一天三张同卡实例被连续导入（典型开发自测节奏，均为 user 13）：

| id | 会话(卡实例) | role | clen | swipes | model | created(UTC) |
|---|---|---|---|---|---|---|
| 1295 | e62c3403（卡 1 实例 ed9c7049） | assistant | 193 | 222B | None | 11:14:57（开场白） |
| 1296 | 5f0e261f（卡 2 实例 **77491574，本案**） | assistant | 193 | 222B | None | 11:32:13（开场白） |
| **1297** | 5f0e261f（同上） | **None** | **99** | **NULL** | None | **12:33:17** |
| 1298 | bbc8175b（卡 3 实例 e126eac8） | assistant | 193 | 222B | None | 13:33:52（开场白） |
| **1299** | bbc8175b（同上） | **assistant** | **99** | **105B** | None | **13:37:40** |

- **id=1299 是 1297 的孪生兄弟**：同为 99 字符、is_user=F、is_sys=F、name=卡名、mesid/extra/model/tokens 全 NULL、swipe_id=0、会话开始 4 分钟后出现（1297 是 61 分钟后）；唯一差异是 **role（None vs 'assistant'）与 swipes（NULL vs `[content]` 105B）**。
- 两行其余字段逐项相同 ⇒ 同一动作族的两个代码变体产物；12:33 的变体漏初始化 role/swipes，13:37 的变体已补上。**同一开发日下午边改边测，写入函数在 64 分钟内被改过一次**，这与三张卡 11:14/11:32/13:33 连续导入的自测节奏自洽。
- VER1b 曾核对"e126eac8（HTML测试角色 第二实例）本分支 role 正常"——即 1299 那条，与本取证吻合。

### 2.6 最可能路径判断（按证据强度排序）

1. **最可能（与全部在场证据自洽）**：2026-06-23 当天正在编写的**早期 ST 插件链 / HTML 卡消息写入路径的一个当日中间变体**，以"逐字段直拷 ST chat item"的方式插入单条 assistant 侧消息：`role=item.get("role")`（ST chat item 无 role 键 → None）、`is_user/is_system/name` 直拷（→ False/False/卡名）、swipes/extra/mesid 尚未实现初始化（→ 全 NULL）、model/tokens 未挂（无生成）。当天稍晚同函数补上 role 兜底与 swipes 初始化后即产出 1299；最终演化成今天 `silly_tavern.py`/`st_sync_service.py` 里"派生+兜底+三字段必设"的安全形态（`_st_message_role`/`_st_msg_role` 即其化石层）。
2. **不能指认到具体死函数名**：6/15–6/23 源码无任何存本（git 断层 + 快照止于 6/8），此为证据边界，不是证据缺失的托词——凡声称"找到该函数"都需要先拿出该窗口的源码。
3. **可排除**：异常中断/生成占位（当前与六月的占位行均硬编码 role="assistant" 且必挂 model/tokens，1297 全无）；导入器（现役三路径字段形态反证）；开场白（1296 形态吻合会话创建路径，1297 不吻合）；PATCH/编辑（更新路径两处均收口）；分支拷贝（案发分支无父）；普通聊天表链路（另一张表）。

---

## 3. 第二步 · 全库 role IS NULL 面（只读 SQL 实测）

### 3.1 全库含 role 列的 8 张表普查（information_schema 实测）

| 表 | 总行数 | role IS NULL | 判定 |
|---|---|---|---|
| **character_chat_messages** | **248** | **1**（id=1297） | **本案，唯一真缺陷行** |
| messages（普通聊天） | 84 | 0 | 干净 |
| conversation_memories | 900 | 0 | 干净 |
| extension_prompts | 3 | 0 | 干净 |
| tts_voice_bindings | 3 | 0 | 干净 |
| users | 23 | 0 | 干净 |
| world_book_stages | 347 | 0 | 干净 |
| personas | 1 | 1 | **非缺陷**：`models/persona.py:39` `role = Column(Integer, nullable=True)`，语义为 ST 注入 role（0=system/1=user/2=assistant），设计即可空，与消息 role 无关 |

### 3.2 character_chat_messages 角色分布与聚簇

- 分布：assistant=133，user=114，**NULL=1**（合计 248）。
- 按会话聚簇：NULL 全部集中在 `5f0e261f`（该会话共 2 条消息，1 NULL + 1 开场白）——**单会话孤立事件，无扩散**。
- 按日时间线（全表）：消息写入驻留 2026-05-25 → 2026-10-23 共 17 个活跃日；**NULL 仅出现在 2026-06-23（当日 8 条中 1 条）**。10 月高频写入日（10-04/05/06 各 50~59 条）零 NULL ⇒ **现行代码无持续产生源**，与 §2.3 排除表互证。

---

## 4. 第三步 · 爆炸半径（NULL role 走到下游会发生什么）

### 4.1 透传点本身（`character_message_builder.py:260-290` 实读）

`:275` `messages.append({"role": m.role, "content": msg_content})` 直取 DB 字段。对 1297 而言还有三个二级行为：

- `:255` `m.role == "user"` 不命中 → 不走 legacy smart-card context 提取（无害）；
- `:264` `m.role == "assistant"` 不命中 → **跳过 `strip_inline_think` + `clean_display_markup_for_prompt`**，其 content 比"正常 assistant 行"更原样地进 payload（99 字符内容里若有思考框/标记将不剥）；
- `:271-274` 群聊 name 前缀分支 `m.role != "user"` 会命中（若为群聊且 name≠user_name 会加名前缀）；本案非群聊，未触发。

### 4.2 下游消费方逐一实读

| 消费方 | 代码点 | NULL role 的实际遭遇 | 风险 |
|---|---|---|---|
| **provider 请求体** | `inference_dispatcher.py:441`、`:786`（`"messages": messages` 直进 dict → JSON） | 以 **`"role": null`** 上线发给 OpenAI 兼容上游。上游按 schema 要求 role ∈ {system,user,assistant,tool}，**预期 400 拒整单**。**未实测**（本批不发请求，沿用 VER1b 同款边界声明） | **高（发请求即炸）** |
| **instruct 文本包裹**（text completion 源） | `roleplay_prompt_assembly.py:284` `role = m.get("role", "user")`（键存在值为 None → **get 默认值不生效**）→ `:312-313` else 分支 | 被**当 user 轮包裹**（in_prefix/in_suffix + user_name），99 字符 assistant 侧内容在展平 prompt 里被归为用户发言 | 中（内容归属错位） |
| **包裹前的锚定定位** | `roleplay_prompt_assembly.py:260-283`（first/last assistant/user/system 索引扫描） | None 与三种 role 全不匹配 → 不参与 first/last 锚定；若它落在收尾位，last_assistant_idx 会锚到更早的行，first_output/last_output 序列错位 | 中（instruct 源下错锚） |
| **WI 激活扫描** | `roleplay_prompt_assembly.py:4827`、`worldbook.py:1039`（recent_msgs 直拷 role） | 同款 None 条目进扫描集；role 相等比较全不中，按非 user/assistant 处理，content 仍进 haystack（扫描不炸，行为轻度漂移） | 低 |
| **plotline 阶段判定** | `character_ext.py:5384-5406`（最近 8 条直拷 role 进判定上下文） | None 渲染进判定提示文本 | 低 |
| **WS 轨同病透传** | `websocket.py:1454` | 同 `:275` 形态；WS 角色扮演生产已被 SSE 取代（`websocket.py:815` 附近注释自述"生产上被 SSE 取代而无人触发"） | 低（休眠同病灶） |
| **token 估算** | `st_tokenizer_service.py` 全文 grep 无 role 引用（实测） | 只吃 content，不受影响 | 无 |
| **显示侧（第一方 UI）** | `useChatMessages.ts:120`（`role === 'user' ? 'User' : 'Assistant'`）、`Message.tsx:834`（`isUser = message.role === 'user'`）、`:1433` | None ⇒ 判为 Assistant 侧渲染——与 is_user=False 的布尔口径一致，**视觉无异常** | 无（恰逢一致） |
| **显示侧（ST 插件）** | VER1b 已核：`script.js:2593` role 由 is_user/is_system 布尔派生 | 不存在 NULL role 形态 | 无 |
| **记忆镜像** | `mirror.py:57-64,124`（role=='assistant' 才做清洗） | None 走 raw 路径，轻度漂移；`conversation_memories.role` 实测 0 NULL，未受染 | 无 |

**半径小结**：唯一硬炸点是**发请求**（`"role": null` 进 provider JSON，预期上游 400，未实测）；其余全部是"被当 user 或 assistant 处理"级别的行为漂移。本案卡 77491574 的会话每次装配都带伤上行——只要该会话再发起生成且该分支消息仍入上下文，就会命中 4.2 第一行。

---

## 5. 建议修法（两选项，均读侧、零迁移、即时生效）

> 主脑已给方向："序列化层对 NULL role 跳过**或**映射 assistant 并留痕"。两选项即该方向的两个分支。

### 选项一：装配层跳过 + 留痕（保守）

- 做法：`character_message_builder.py` 在 `:225` is_hidden 过滤同段落加一道 `role is None` 过滤（该处已有"装配路径滤行"先例），并 `logger.warning` 留痕（含 msg id/session/长度，不含正文）。
- 影响面：仅装配读侧；1297 的 99 字符消息**不进 prompt**（对生成效果无实质损失——它是无生成挂载的测试残行）；不动 DB、不动显示侧（显示层本就按 is_user 正常渲染）。同病灶透传点 `websocket.py:1454`、`chat.py:177`、`character_ext.py:5385`、`worldbook.py:1039`、`roleplay_prompt_assembly.py:4827` 是否同批加防线，建议**只加装配主链 + WS 轨 1454**（生产可达面），其余留在后续清扫。
- 残留风险：写侧不变量未修复——未来新写入者若再产出 NULL 行会被静默跳过（有 warning 留痕兜底）。

### 选项二：装配层映射 assistant + 留痕（ST 对齐，推荐）

- 做法：在历史循环**开头**（`:242` 前后）归一化 `role = m.role or "assistant"`，后续 `:255/:264/:271` 分支与 `:275` 全部改用归一化后的局部变量（**注意必须提前归一**：若只在 `:275` 映射，`:264` 的 assistant 清洗分支仍然不命中，think/标记照样漏剥）。warning 留痕同选项一。
- 影响面：1297 回归"正常 assistant 行"待遇（补上 strip/clean，内容归属正确）；与 `_st_message_role`/`_st_msg_role` 的兜底 assistant 口径、ST 布尔派生口径（is_user=F ⇒ assistant）三面对齐；显示侧不变。
- 残留风险：同选项一（写侧不变量）；且对"is_user=NULL 的理论行"会一律按 assistant 处理——当前全库无此形态（is_user 仅 1297 一处 NULL 且同为 assistant 侧），影响面可忽略。
- **附带加固（可选尾巴，需另批授权，本批不施工）**：① 存量一次性 `UPDATE ... SET role='assistant' WHERE role IS NULL AND (is_user IS NOT TRUE) AND (is_system IS NOT TRUE)`（今日实测恰命中 1 行=id 1297；动业务库须先按备份规范归档）；② alembic 加 CHECK 约束 `role IN ('user','assistant','system')` 或列级 nullable=False + server_default，把"写侧永不 NULL"变成硬不变量。两案择一即可，②更彻底但动 schema，留主脑裁定。

---

## 6. 零写入双快照（四项计数，`census_counts.py` 实测）

| 时点 | chars | sess | msg | wb | 判定 |
|---|---|---|---|---|---|
| 快照 A（全部探针前） | 29 | 32 | 248 | 16 | 与普查基线一致 |
| 快照 B（全部探针后） | 29 | 32 | 248 | 16 | **A=B，零写入得证** |

DB 探针全部 `finally: db.close()`，零 add/commit/flush；六月快照仅解包到探针区 `.tmp_probe/nf1_junesrc/`，未动 `_BACKUPS/` 原件。

## 7. 边界声明（未做/不能做）

1. **未实测**上游对 `"role": null` 的真实反应（不发请求是本批纪律，与 VER1b 同边界）——"预期 400"是基于 OpenAI 兼容 schema 的推断，不是实测。
2. **无法指认** 6/23 当天写入函数的具体名字：git 历史止于 2026-08-17（对象丢失重建），六月源码快照止于 06-08，6/08–6/23 窗口无存本。§2.6 第 1 条是"与全部在场证据自洽的最可能路径"，不是已证事实。
3. personas 表那 1 条 role NULL 已核实为**另一语义、设计即可空**（`models/persona.py:39`），不计入缺陷。
4. 本报告不含任何消息正文、卡文、密钥值；content 一律以长度记。
