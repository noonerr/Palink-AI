# ST 兼容（st-compat）完整性审计 — 完全清单

> 对照基准：SillyTavern **1.18.0** 源码（`SillyTavern-1.18.0/SillyTavern-1.18.0/`）
> - 前端装配：`public/scripts/PromptManager.js`、`world-info.js`、`macros.js`、`templates.js`
> - 后端 API：`src/endpoints/{characters,chats,worldinfo,settings,secrets,quick-replies,extensions,groups,tokenizers,translate,search,presets}.js`
>
> Palink 被测实现：
> - `backend/app/services/roleplay_prompt_assembly.py`（装配编排 + 后处理）
> - `backend/app/services/character_message_builder.py`（`build_st_compat_messages`）
> - `backend/app/services/worldbook_service.py`（世界书扫描）
> - `backend/app/services/macro_service.py`（宏引擎）
>
> 结论速览：**隔离性成立（不影响其他模块）；但"内容层已完美适配 ST"不成立。** 共发现 **15 处** 丢失/不完善点，其中 3 处 P0（重复注入）、9 处 P1（内容丢失/错置）、3 处 P2（行为偏差）。世界书**扫描语义**已对齐 ST，缺陷集中在**装配投递层**与**后处理分类器**。

---

## 一、已确证的缺陷（按严重程度）

### P0 — 重复注入（每次生成都出错，token 翻倍 / 设定重复）

#### G1. 作者备注（Author's Note）在 st-compat 下双重注入（position 0 / 2 / 4）
- **ST 行为**：作者备注按 `author_note_position_int` 注入一次——position 0 在 chatHistory 内按 depth 插入；position 2 作为最后一条 system；position 4 作为最前一条 system。
- **Palink 行为**：`build_st_compat_messages` 内部已按 `authors_note_depth` 注入作者备注（`character_message_builder.py:524-534`）；同时外层在 if/else 之外把 `author_note_depth_entry` 重新塞回 `depth_entries` 并调用 `_insert_depth_prompt`（`roleplay_prompt_assembly.py:2438-2439`、`2449`）。`depth_entries.clear()`（`:2407`）只清了世界书 depth，没防住作者备注。
- **结果**：
  - position 0：`build_st_compat` 按 depth 插一份 + 外层 `_insert_depth_prompt` 同 depth 再插一份 = **同深度两份**。
  - position 2：`build_st_compat` 在 depth 4 插一份 + 外层 `author_note_last_message`（`:2501`）在末尾再插一份 = **两份且位置错乱**。
  - position 4：`build_st_compat` 在 depth 4 插一份 + 外层 `author_note_top_message`（`:2485`）在顶部再插一份 = **两份**。
- **证据**：`character_message_builder.py:524-534`、`roleplay_prompt_assembly.py:2438-2439,2449,2407`、`1947-1949(pos0),1965-1968(pos2),1975-1978(pos4)`。
- **修复方向**：st-compat 下让 `build_st_compat_messages` **不再**内部注入作者备注，`author_note_*` 的位置化注入（top/last/depth/system_prompt）完全交给外层统一处理（与 palink-native 共用同一套 position 分发，避免双重机制）。

#### G2. Persona 描述在 st-compat 下双重注入
- **ST 行为**：Persona（personaDescription）作为 prompt_order 的 Index 2，注入一次。
- **Palink 行为**：`build_st_compat_messages` 把 `persona_description` 作为 Index 2 注入（`:430-432`）；同时外层把 `persona_depth_entry` 追加到 `depth_entries`（`:2442-2443`）并经 `_insert_depth_prompt` 在 depth 4 再插一次。若 `persona_last_message` 也非空（`:2490-2491`），则可能出现 **Index 2 + depth 4 + last** 最多三份。
- **证据**：`character_message_builder.py:430-432`、`roleplay_prompt_assembly.py:2365-2369,2442-2443,2490-2491`。
- **修复方向**：st-compat 下 persona 也只由外层 position 分发注入，`build_st_compat_messages` 不注入 persona（或其 Index 2 注入与外层互斥）。

#### G3. 作者备注 position 1（after post-history）在 st-compat 被错置为 depth 4 且原位置丢失
- **ST 行为**：position 1 = 作者备注追加到 post-history 指令之后（prompt 末尾 system 区）。
- **Palink 行为**：position 1 分支把作者备注追加到 `system_prompt` 变量（`:1958`），但 st-compat 根本不使用 `system_prompt` 变量（走 `system_prompt_override` + `build_st_compat_messages`），该内容被丢弃。同时 `build_st_compat_messages` 因 `authors_note` 非空且 `authors_note_depth=4`（`:2372`，position≠0 时默认 4）把作者备注插到了 depth 4——**既放错了位置，又没到达用户期望的"after post-history"位置**。
- **证据**：`roleplay_prompt_assembly.py:1956-1964(pos1),2372,2387`、`character_message_builder.py:524-534`。
- **修复方向**：st-compat 下 position 1 应追加到 jailbreak/post-history 段（Index 11）之后，而非写进被丢弃的 `system_prompt`；`build_st_compat_messages` 不应再按默认 depth 4 兜底注入作者备注。

---

### P1 — 内容丢失 / 错置

#### G4. `dynamic_context_parts` 在 st-compat 被整体丢弃 → 世界书 position 2/3（ANTop/ANBottom）丢失
- **ST 行为**：世界书 position 2 = `ANTop`（包在作者备注**上方**）、position 3 = `ANBottom`（作者备注**下方**），随作者备注一起注入（`world-info.js:5111-5114`，`world_info_position` 定义见 `:855-864`：before:0/after:1/ANTop:2/ANBottom:3/atDepth:4/EMTop:5/EMBottom:6/outlet:7）。
- **Palink 行为**：`build_st_compat_messages` 接收 `dynamic_context_parts` 为参数（`:360`），但函数体内**从未引用**（grep 全文件仅此一处）。`_append_worldbook_context` 把 position 0–3 的合并文本 `wb_result.text` 追加进 `dynamic_context_parts`（`:2814`），仅把 pos 0 → `st_wi_before_parts`（`:2834-2838`）、pos 1 → `st_wi_after_parts`（`:2839-2843`）、pos 4 → `depth_entries`（`:2844-2846`）。**pos 2/3 无任何独立出口**，随 `dynamic_context_parts` 一起被丢弃。
- **影响**：ST 用户配置在 ANTop/ANBottom 的世界书条目在 st-compat 下完全不出现。报告原文的"世界书位置分离"表刻意漏列 position 2/3，属隐瞒。
- **修复方向**：在 `build_st_compat_messages` 内接收并注入 ANTop/ANBottom（紧贴作者备注的上下方）；或把 pos 2/3 并入 `st_wi_before/after` 之外的专门桶并按 ST 语义放到作者备注周围。

#### G5. 世界书 position 5/6/7（EMTop/EMBottom/Outlet）被收集却永不投放
- **ST 行为**：pos 5/6（EMTop/EMBottom）经 `{{mesExamples}}` 宏注入示例块；pos 7（Outlet）经 `{{outlet::name}}` 宏注入（`world-info.js:5093-5143`，`macros.js:668`）。
- **Palink 行为**：`_append_worldbook_context` 确实收集了 `em_top_entries`/`em_bottom_entries`/`outlet_entries` 并交给 `MacroEnv`（`roleplay_prompt_assembly.py:2850-2867`、`2582-2584`）。但 `build_st_compat_messages` 把示例**直接内联** `char.mes_example`（`:461-466`），不放置 `{{mesExamples}}` 占位符；也不放置任何 `{{outlet::name}}`。宏引擎只替换 prompt 中**已出现**的 token，因此 em_top/em_bottom/outlet 虽被收集却**没有任何 token 可触发**，永远不进 prompt。
- **影响**：EMTop/EMBottom/Outlet 世界书条目在 st-compat（以及 palink-native，因两条路径都不放 token）下整体失效。
- **修复方向**：在示例块放置 `{{mesExamples}}` 占位符（或显式拼接 `em_top + mes_example + em_bottom`）；outlet 放置 `{{outlet::<name>}}` 占位符。注意 `macro_service.py` 已支持这两个宏，只需在消息里放 token。

#### G6. 世界书 AT_DEPTH 与作者备注条目的 `role` 被硬编码为 system
- **ST 行为**：世界书条目（含 AT_DEPTH）和作者备注均可指定 `role`（system/user/assistant），按条目 role 注入（`world-info.js:5116-5127`）。
- **Palink 行为**：`_insert_depth_prompt` 对所有 depth 条目硬编码 `{"role": "system"}`（`roleplay_prompt_assembly.py:3029`）；`build_st_compat_messages` 注入世界书 depth（`:542`）与作者备注（`:530`）也硬编码 system。
- **影响**：配置了 `role=user`/`role=assistant` 的世界书 depth 条目在 st-compat 下全部变成 system 消息，角色语义丢失。
- **修复方向**：depth 条目携带 `(depth, content, role)` 三元组，`_insert_depth_prompt` 与 `build_st_compat_messages` 均按条目 role 注入。

#### G7. `skip_examples` 时 ST 删除示例、Palink 保留
- **ST 行为**：instruct 模板 `skip_examples=True` 时，示例对话（dialogueExamples）**整段从 prompt 移除**（`PromptManager` 的 `shouldIncludeExamples()` 返回 false）。
- **Palink 行为**：`build_st_compat_messages` 无条件注入示例（`:461-466`）；`_apply_instruct_formatting` 在 `skip_examples` 时仅**跳过包裹**示例消息（`:218-220`），仍把它留在 prompt 里。
- **修复方向**：`skip_examples=True` 时，st-compat 不注入 dialogueExamples（Index 9）整段。

#### G8. 分类器错配 → 核心角色字段在超预算时被当作"可裁剪世界书"删除
- **ST 行为**：prompt_order 各段有固定优先级；charDescription/personality/scenario/persona 属核心段，通常不可裁；只有世界书 depth/extension 可裁。
- **Palink 行为**：`_classify_message_identifier`（`:616-684`）用 Palink 标记识别——`"Example dialogue:"`（`:637`）、`"[Author"`（`:645`）、`"[Persona:"`（`:649`）。st-compat 消息用的是 ST 标记：示例块前缀 `[Example Chat]`（`:465`），作者备注/Persona 是纯文本无标记。于是除 index 0（main）外的所有 system 段（persona、charDescription、scenario、worldInfoBefore/After、作者备注、示例）全部落入兜底分支 `WORLD_INFO_BEFORE`（`:680-682`）。`_collect_prompt_sources` 给 `WORLD_INFO_BEFORE` 的优先级是 `_TRIM_PRIORITY_WORLDBOOK` 且 `trimmable=True`（`:740-741`）。超预算时 `_apply_dynamic_trimming`（`:2617-2619`）会**裁掉 charDescription/scenario/persona 等核心字段**。
- **影响**：长对话下，st-compat 的角色设定可能被静默丢弃，行为严重偏离 ST。
- **修复方向**：`_classify_message_identifier` 增加 ST 标记分支（`[Example Chat]`→EXAMPLE_DIALOGUE；识别 worldInfoAfter、charDescription 等并赋予高优先级/不可裁）；或 st-compat 直接跳过基于标识符的裁剪（其装配序已由 builder 固定，无需再裁核心段）。

#### G9. 作者备注 position 1 在 st-compat 完全丢失（与 G3 同源，单列以强调内容丢失）
- 见 G3：position 1 分支写入的 `system_prompt` 在 st-compat 不被消费，作者备注该位置的配置静默失效。

---

### P2 — 行为偏差

#### G10. 状态栏尾注污染 st-compat 纯净性
- **ST 行为**：st-compat 不应包含任何 Palink 特有内容。
- **Palink 行为**：状态栏尾注注入（`roleplay_prompt_assembly.py:2510-2540`）在 if/else 之外、两路都跑，向最后一条 user 消息追加 Palink 状态栏指令。而 `build_st_compat_messages` 文档明言"不包含任何 Palink 特有内容（无状态栏探测…）"（`:391-392`）——自相矛盾。
- **修复方向**：`if st_mode != "st-compat":` 包裹状态栏注入。

#### G11. `skip_examples` 时示例仍被 instruct 序列错误包裹
- **ST 行为**：`skip_examples` 的示例消息以纯文本透传（不被 input/output/system 序列包裹）。
- **Palink 行为**：`_apply_instruct_formatting` 的 `_is_example_message` 用 `"Example dialogue:"` 前缀识别（`:183`），而 st-compat 示例是 `[Example Chat]`（`:465`），不匹配 → 示例被正常包裹。即便 G7 修复后保留示例，此处仍会错误包裹。
- **修复方向**：识别标记同时涵盖 `[Example Chat]`（或直接按消息索引/标识符判定示例段）。

#### G12. 绑定 PromptPreset 时 prompt_order 重排把 st-compat 消息顺序打乱
- **ST 行为**：绑定 preset 的 `prompt_order` 时按 ST 标识符重排。
- **Palink 行为**：`_apply_full_prompt_order`（`:2609-2612`）仅在有 `prompt_preset` 时触发；因 G8 的分类错配，几乎所有 st-compat system 段都被识别为 `WORLD_INFO_BEFORE`，重排无法区分它们 → 顺序被打乱。
- **修复方向**：与 G8 同解（修正分类器）；或 st-compat 在固定装配序下默认不重排（除非用户显式绑定了与 ST 一致的 prompt_order）。

#### G13. `names_behavior='force'` 非群组时 ST 加名、Palink 不加
- **ST 行为**：`names_behavior='force'` 对非群组单角色对话也会在助手消息上加角色名（用于消歧）。
- **Palink 行为**：`include_names = 'always' or ('force' and is_group_chat)`（`:166-168`）——`'force'` 仅在群组聊天加名，单角色不加。
- **影响**：依赖 `force` 加名的 ST 预设，在 st-compat 单角色下名字缺失，输出格式偏离。
- **修复方向**：`'force'` 在单角色下也给助手消息加 `char_name`（与 ST `formatInstructModeChat` 语义对齐，建议以 ST 源码 `instruct-mode.js` 为准复核精确语义）。

#### G14. ST 专用 jailbreak 设置未应用
- **ST 行为**：jailbreak 是 `settings.jailbreak_prompt` 独立设置，注入 Index 11。
- **Palink 行为**：st-compat 传 `jailbreak=""`（`:2386`），仅用 `char.post_history_instructions` 兜底（`:553`）。ST 用户的 jailbreak 设置被忽略。
- **修复方向**：st-compat 读取并应用 ST 的 jailbreak 设置作为 Index 11（与 post_history_instructions 区分或合并）。

#### G15. 【待复核·中等置信】`char.system_prompt` 作为 main override 可能不匹配 ST
- **ST 行为**：`main` 段默认是**用户**的 Main Prompt 设置（`settings.main_prompt`），角色卡的 `data.system_prompt` 是独立字段，通常以独立 section 注入（非覆盖 main）。
- **Palink 行为**：st-compat 把 `req.char.system_prompt` 作为 `system_prompt_override` 直接变成 Index 0 的 main（`:2363,2415,415`）。
- **影响**：若 ST 把角色 `system_prompt` 作为 main 之外的独立段，则 Palink 的位置/内容语义与 ST 不一致。此项置信度为中，建议以 `PromptManager.js` 中 `main` 与角色 `system_prompt` 的实际组装逻辑二次确认。
- **修复方向**：确认 ST 语义后，将角色 `system_prompt` 放到与 ST 一致的位置（可能作为 main 之后的独立 system 段，或追加到 main 内容末尾）。

---

## 二、已确认兼容的部分（防误报）

以下各项经核对与 ST 1.18.0 对齐，**不是缺陷**：

| 项 | 证据 |
|---|---|
| st-compat 仅由 `silly_tavern_mode=="st-compat"` 激活，palink-native 不受影响 | `roleplay_prompt_assembly.py:2357-2358,2408-2434` |
| 12 位装配骨架（main→…→jailbreak）顺序对齐 | `character_message_builder.py:414-560` |
| 世界书**扫描语义**对齐：概率 `verifyProbability`、选择性逻辑 `selectiveLogic`、递归 `_recursive_scan`、粘性/冷却/延迟 `timed_mgr`、min_activations、vectorized（RAG） | `worldbook_service.py:426-753,782-822,963-975,1341-1342` 及 `worldbook_vector_service.py` |
| instruct 包裹的 system/user/assistant 序列、first/last 输入/输出序列、`system_same_as_user`、`wrap_sequences` | `roleplay_prompt_assembly.py:86-265` |
| 宏引擎/正则脚本在两条路径都调用（调用点正确） | `:2592-2593`（宏）、`:2504-2505`（正则） |
| 生成管道参数透传（temperature/top_p/max_tokens/penalty/logit_bias/stop/json_schema/SSE/推理） | `character_ext.py`（与 st 模式无关） |
| IN_PROMPT(1)/IN_CHAT(2) 扩展注入（Palink 扩展机制，功能近似 ST extension_prompts） | `:2456-2481` |
| `[Start a new Chat]` 标记、enhanceDefinitions（默认禁用跳过）、nsfw（默认空跳过） | `character_message_builder.py:491-492,446-447` |
| 世界书 pos 0/1 分离到 worldInfoBefore/After、pos 4 走 depth | `roleplay_prompt_assembly.py:2834-2846` |

---

## 三、修复优先级总表

| 优先级 | 编号 | 缺陷 | 触发条件 |
|---|---|---|---|
| P0 | G1 | 作者备注双重注入（pos 0/2/4） | 每次生成 |
| P0 | G2 | Persona 双重注入 | 每次生成 |
| P0 | G3 | 作者备注 pos1 错置为 depth4 且原位置丢失 | pos1 配置 |
| P1 | G4 | 世界书 pos2/3（ANTop/ANBottom）丢失 | 配置即丢失 |
| P1 | G5 | 世界书 pos5/6/7（EMTop/EMBottom/Outlet）收集不投放 | 配置即丢失 |
| P1 | G6 | 世界书/作者备注 depth 条目 role 硬编码 system | 配置 role≠system |
| P1 | G7 | skip_examples 时示例应删未删 | skip_examples=True |
| P1 | G8 | 分类错配→核心字段超预算被裁 | 长对话超预算 |
| P1 | G9 | 作者备注 pos1 完全丢失 | 同 G3 |
| P2 | G10 | 状态栏尾注污染 st-compat | 每次生成 |
| P2 | G11 | skip_examples 示例仍被包裹 | skip_examples=True |
| P2 | G12 | preset 重排打乱 st-compat 顺序 | 绑定 prompt_preset |
| P2 | G13 | names_behavior='force' 单角色不加名 | force+单角色 |
| P2 | G14 | ST jailbreak 设置未应用 | 配置 jailbreak |
| P2 | G15 | char.system_prompt 作 main override（待复核） | 角色有 system_prompt |

---

## 四、验证建议（修复后落地）

1. 扩展 `backend/tests/test_worldbook_em_outlet.py`：不仅测宏函数，更要测 `assemble_roleplay_prompt(..., silly_tavern_mode="st-compat")` 实际输出是否含 em_top/em_bottom/outlet。
2. 新增测试：针对 st-compat 逐个 position（作者备注 0/1/2/4、Persona 0/1/2）断言**恰好出现一次**且位置正确（无双重、无丢失）。
3. 新增测试：断言 st-compat 输出中**不含**状态栏尾注；断言 `dynamic_context_parts` 中的世界书 pos 2/3 出现在作者备注上下方。
4. 新增测试：超预算场景下核心角色字段（charDescription/scenario/persona）**不被裁剪**。
5. 新增测试：`skip_examples=True` 时 dialogueExamples 段整段缺失。

---

## 五、一句话结论

隔离干净、装配骨架对齐、世界书扫描语义已对齐——但 **st-compat 在"内容投递"与"后处理"两层是半成品**：作者备注/Persona 双重注入 + pos1 错置（P0）、世界书 pos2/3/5/6/7 与条目 role 丢失（P1）、分类器把核心字段当世界书裁（P1）、状态栏泄漏与 instruct 细节偏差（P2）。需按 G1–G15 逐项修复。

---

## 六、修复验证（2026-07-20）

用户声称已修复 P0(G1/G2/G3)+部分 P1(G5/G7)+P2(G10)。**复核结果：并非如此——存在阻断级错误。**

### 6.1 阻断级（已修复）
- **语法错误（全局阻断）**：`roleplay_prompt_assembly.py` 在 st-compat 分支把 `authors_note_position=author_note_position_int` 传了两次（约 line 2393 与 line 2408），导致 `SyntaxError: keyword argument repeated`。`py_compile` 直接失败 → **整个模块无法 import，所有角色扮演请求（含 native）全部崩溃**。"已验证语法"不成立。
  - 修复：删除重复的 line 2408。`py_compile` 现已通过。

### 6.2 作者备注 position 语义反转（已修复）
- `build_st_compat_messages` 把 position `2` 当作 "before chat"、`4` 当作 "after main"，但 Palink 自身约定（roleplay_prompt_assembly.py:1947-1984，与 ST 标准 5 值枚举一致）是 `2`=last in chat、`4`=top of chat。同一 `author_note_position_int` 在 st-compat 与 native 下位置不同 → 内部不一致。
  - 修复：position 4 → `messages.insert(0, ...)`（top of chat，在 main 之前）；position 2 → 在 jailbreak 之后 `append`（last in chat）。position 0（depth）/1（after post-history）原本正确。

### 6.3 Persona 回归（已修复）
- st-compat 分支原用 `persona_last_message` / `persona_depth_entry` 派生 `persona_desc`：position==1（after post-history）时两者皆空 → `persona_desc=""` → **Persona 整段丢失**；position==0 被错误放在固定 Index 2（应为 in-story depth4）。
- ST 无 `persona_description_position` 概念，persona 固定在 Index 2。修复：新增 `persona_full_text`，st-compat 始终注入完整 persona 文本到 Index 2（position==3 inactive 仍跳过）。既修复 position==1 丢失，又符合 ST 固定位。

### 6.4 经核对确实正确的部分
- G1/G2 双重注入：`depth_entries.clear()` + 清空 author_note/persona 注入条目，逻辑正确。
- G5/G7：示例拼接 em_top+mes_example+em_bottom、skip_examples 整段跳过，逻辑正确。
- G10：状态栏尾注被 `if st_mode != "st-compat"` 正确隔离。

### 6.5 仍待修复（用户 summary 自认未完成）
- G8/G12 分类器 `_classify_message_identifier` 用 Palink 标记，st-compat 用 ST 标记 → 核心字段被兜底 WORLD_INFO_BEFORE，超预算被裁。
- G11 skip_examples 时示例仍被 instruct 包裹。
- G13 names_behavior='force' 单角色不加名。
- G14 ST jailbreak 设置未应用。
- G15 char.system_prompt 作 main override（需 ST 语义复核）。

---

## 七、G4/G6 修复复核（2026-07-21）

用户声称 G4/G6 已修。**复核结果：生产路径正确，但 G6 的元组改形破坏了既有测试/脚本（已一并修复）。**

### 7.1 G6（depth 条目 role）——生产路径正确
- `WorldbookContextResult.depth_entries` 改为 `list[tuple[int, str, int]]`（depth, content, role），填充含 `entry.role or 0`（worldbook_service.py:105,1194）。`entry.role` 字段确存在于模型（models/worldbook.py:98，default 0）。
- 三元组一致性：`author_note_depth_entry`(1952)、`persona_depth_entry`(2031)、`palink_injection_depth_entries`(2129)、wb depth(2895) 全部为三元组；两处消费方 `_insert_depth_prompt`(3078)、`build_st_compat_messages`(573) 均按三元组解包并经 `_ROLE_MAP={0:system,1:user,2:assistant}` 映射。运行时逻辑冒烟通过（system/user/assistant 三种 role 均正确落位）。
- **回归（已修）**：元组改形破坏了仍按二元组解包的消费方 —— `test_e2e_roleplay_phase6.py:500`、`verify_worldbook_direct.py:210/220`（真实调用 → 运行时 `ValueError`），及 `test_worldbook_st_semantics.py:1234/1240`（手动构造二元组断言，过期）。已全部改为三元组。
- **注解瑕疵（已修）**：worldbook_service.py:1179、roleplay_prompt_assembly.py:1906/2002 局部注解仍写二元组（不影响运行），已同步为三元组。

### 7.2 G4（世界书 pos2/3 ANTop/ANBottom）——正确
- `_append_worldbook_context` 从 `entries_by_position.get(2/3)` 提取 → `st_wi_an_top_parts`/`st_wi_an_bottom_parts`（2882-2891）→ 传入 builder。
- builder 内以 `ANTop + author's note + ANBottom` 顺序拼接（character_message_builder.py:470-479），随 `authors_note_position`(0/1/2/4) 一并注入。运行时冒烟：顺序 top→note→bottom 正确；**无作者备注文本时仍保留 ANTop/ANBottom**（默认 position=1，注入于 post-history 后）。
- **无双重注入**：pos2/3 虽也进 `wb_result.text`→`dynamic_context_parts`，但 `build_st_compat_messages` 不消费 `dynamic_context_parts`（仅 native 路径的 `build_character_chat_messages` 用），故 st-compat 仅经 an_top/an_bottom 投放一次。
- **次要保留项（非缺陷）**：当 `author_note_position_int==3`（用户显式禁用作者备注）时，ANTop/ANBottom 随之不注入。此与 ST 语义一致（AN 锚点被禁用则挂靠其上的条目亦不注入），无需修复。

### 7.3 仍待修复
- G8/G12（分类器错配致核心字段被裁，P1，影响最大）、G11、G13、G14、G15。
- G13：用户称"审计有误"，待逐条复核 names_behavior='force' 单角色行为后确认。
- G14：用户称已通过 `context_template.jailbreak` 处理，但那是 jailbreak 文本，ST 的 jailbreak/post-history 开关（是否启用）仍未见处理，待复核。

---

## 八、G8/G12/G11/G13/G14/G15 复核（2026-07-21）

### 8.1 G8/G12（分类器错配 / preset 重排）——✅ 确认修复仍在
- `roleplay_prompt_assembly.py:2639`：`if prompt_preset is not None and st_mode != "st-compat":` 跳过 `_apply_full_prompt_order`（G12）。
- `roleplay_prompt_assembly.py:2649`：`if st_mode != "st-compat":` 跳过 `_apply_dynamic_trimming`（G8）。
- 注意：st-compat 完全跳过基于标识符的裁剪（G8），因此原 `_classify_message_identifier` 用 Palink 标记导致的"核心字段被裁"问题在 st-compat 下被规避——但同时也意味着 st-compat **不做任何 token 预算裁剪**，仅由 builder 内的 `recent_messages_budget` 限制历史条数。超预算时不会像 ST 那样按 token 裁历史。属设计取舍，非缺陷，但 golden vector 需覆盖超预算场景确认。

### 8.2 G11（skip_examples 示例仍被包裹）——✅ 确认修复
- `roleplay_prompt_assembly.py:181-185`：`_is_example_message` 同时识别 `Example dialogue:`（Palink）与 `[Example Chat]`（ST）前缀。
- `roleplay_prompt_assembly.py:220`：`if skip_examples and role=="system" and _is_example_message(content):` 时跳过 instruct 包裹。
- 叠加 G7（`build_st_compat_messages` 内 `if not skip_examples:` 整段不生成示例），st-compat 在 skip_examples 下既无示例块、也不包裹。✅

### 8.3 G13（names_behavior='force' 单角色不加名）——⚠️ 仅部分正确
- 用户引 ST `instruct-mode.js:387-393` 证明 `force` 仅在群组/forceAvatar 时加名、单角色不加 —— 此点 ST 语义正确。
- **但 `build_st_compat_messages` 根本没有 names_behavior 处理**（全文件仅 line 28 一个无关的 `match.group`）；st-compat 产出的 message 一律无 `name` 字段。
- 推论：单角色 + force → 不加名，与 ST 一致（"正确"纯属因 omission 巧合命中）；**群聊/forceAvatar + force/always → ST 会加名，st-compat 仍缺失 → 实际偏离 ST**。
- 结论：G13 对单角色场景成立，但群组场景未真正修复。建议要么在 st-compat 实现 names_behavior（群组加名），要么在审计中将其精确表述为"单角色已对齐，群组未覆盖"。

### 8.4 G14（jailbreak 设置）——✅ 大部分正确，但用户全局 jailbreak 未接线
- `build_st_compat_messages` jailbreak 优先级（character_message_builder.py:585-595）：
  1. `jailbreak` 参数（调用方 st-compat 传 `""`，roleplay_prompt_assembly.py:2390）→ 跳过
  2. `char.post_history_instructions`（ST 的"post history instructions"字段，正是 ST 的 jailbreak/post-history 来源）→ 注入
  3. `context_template.jailbreak` → 覆盖前两者（line 590-593）
- ST 的 jailbreak 主要来源是**用户全局 jailbreak**（主界面 Jailbreak 文本框，存于用户设置），而 st-compat 把 `jailbreak` 参数硬编码为空（`""`），未把用户全局 jailbreak 接入。因此：用户把 jailbreak 写在全局框里时，st-compat 不会注入。
- 结论：角色卡 `post_history_instructions` + 上下文模板 `jailbreak` 已正确注入（G14 主体成立），但**用户全局 jailbreak 这一主要 ST 来源仍缺失**，属 residual gap。

### 8.5 G15（char.system_prompt 作 main override）——✅ 实为正确 ST 行为
- `build_st_compat_messages:419`：`main_prompt = system_prompt_override or _ST_DEFAULT_MAIN_PROMPT`，而 `system_prompt_override = char.system_prompt`（roleplay_prompt_assembly.py:2363）。
- ST 角色卡的 `system_prompt` 字段（高级定义里的"Character System Prompt"）在非空时**正是覆盖 main prompt**——这与 Palink 行为一致。
- 结论：G15 不是缺陷，原审计"待复核"应改为"已确认正确（与 ST 一致）"。

### 8.6 关于"所有缺陷已修复，仅剩 golden vector 验证"的结论
- **代码层面**：G1–G14 的修复均真实存在且基本正确（仅 G13 群组、G14 用户全局 jailbreak 两处 residual）；G15 实为正确。
- **但"仅剩 golden vector"过于乐观**：
  1. 整个 st-compat 路径**从未被运行时执行**（本机无 sqlalchemy，后端跑 Docker；无任何测试调用 `assemble_roleplay_prompt(st_mode="st-compat")`）。当前所有确认均为静态阅读 + 纯逻辑冒烟。
  2. golden vector 必须**由真实 ST 1.18.0 输出派生**（源码已在 `SillyTavern-1.18.0/`），而非用 Palink 自身预期作为基准——否则只证明 Palink 自洽，不证明对 ST 忠实。
  3. 未经运行时验证的隐患：宏解析在 st-compat 的实际表现、instruct 包裹与 st-compat 的交互、消息顺序/索引偏移、超预算边界。
- 建议：在 Docker 内补一个真正跑通 `assemble_roleplay_prompt(..., silly_tavern_mode="st-compat")` 的集成测试，并以 ST 源码行为为 oracle 构造 golden vector（覆盖 author note 0/1/2/4、persona、worldbook 0/1/2/3/4/5/6/7、skip_examples、names_behavior 群组等）。
