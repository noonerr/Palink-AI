# SPEC：MVU 初始变量断链（过度思考根因）与输出 tag 裸显修复

> 日期：2026-09-30
> 状态：待施工
> 取证会话：`93cee77b-fad1-43b9-92a2-8fe17c2ad099`（卡「露缇雅1.2」`be906232-8e46-4a37-b5a8-33d9b40ef5ab`，模型 deepseek-v4-flash）
> 本文全部结论基于实库取证 + 代码走读，无推测项；唯一无法取证项（§R5）已明示。

---

## 修订记录（2026-09-30 17:5x · 施工前复核后）

> 复核报告：`docs/复核_MVU初始变量断链与输出tag裸显_2026-09-30.md`（含全部证据与可复现命令）。
> **施工以本节为准**；与下文原描述冲突时，按本节执行。

**仍然成立、照做**：R1/T1 根因与修复方向（已在生产容器内实跑复现：当前 `build_initial_stat_data` 输出 = 消息 2382 思考原文引用的占位值，逐项吻合；补 `palink_raw_card_data.data.first_mes` 或 `characters.first_mes` 均可得到真实 initvar 2026/7/8、爱意5/魔力60/饥饿60）。§2.4 的行号与调用点清单核对无误。

**必须修改的 5 处**（编号对应复核报告）：

- **【B1 · T3 落点必改】** 原写「落点在 `Message.tsx:853-864` 附近兜底剥离区或 `formatting.ts` 现有标签隐藏列表，按现有架构选其一」——**`Message.tsx` 一侧不可用**：`Message.tsx:1112` 把 `displayContent` 传给 `ttsService.playMessage`，而 `tts.ts:635` 从**该入参**提取声线（`extractVoiceDescription`）。在 `displayContent` 里剥【声音】⇒ 声线恒为 `null`，直接复现 2026-09-25 修过的旧故障，违反本节自设的「不得影响 tts.ts 提取路径」和 §5 验收第 2 条。
  **改法**：落点放 **formatter / `frontend/src/lib/sillytavern/formatting.ts`（或显示管线 hook）侧**，`displayContent` 保持原样。另需覆盖 3 处回退路径（`Message.tsx:1080`、`1086`、`1582` 的 `pipelineResult?.… || displayContent`）。

- **【B2 · R2 重定性】** 原 §2.6 把「中文引号」归到消息 **2382**——**实测 2382 的 7 条 `@bubble` 全是标准方括号格式**，引号格式出现在 **2384/2387/2389/2393**。2382（过度思考那条）裸显的直接原因是**缺 `<now_plot><content>` 包裹**：卡正则「正文美化」(`/(story|Lnterleaving|now_plot|content|正文)>…<\/\1>/gi`，要求闭合) 不命中 ⇒ 无正文美化卡 ⇒ 无 `dcRoot` iframe ⇒ 而 BubbleDialogue 的 `_getBubbleRenderFrames()` **只认 `dcRoot`** ⇒ 标记无宿主可渲染，必然裸显（同源解释 `<cg>` 裸显）。
  **拆成两条**：**R2-a（主因）结构不合规 / 缺渲染宿主**；**R2-b（次因）方括号→引号漂移**。修复优先级随之翻转。

- **【B3 · T2a 落点无效】** 原写「给 @bubble 格式规则加『内容必须方括号 `[...]`，禁止引号包裹』的显式约束」——该约束**已存在**（脚本 `DEFAULT_FORMAT_RULE` 第 6 条原文「台词必须用 [ ] 方括号包裹」）；且注入文本**不是**取自 `plugin_scripts`：脚本运行时 `buildInjectionPrompt()` 优先读 **IndexedDB `config.format_rule`**（用户可编辑），DEFAULT 仅兜底；注入由客户端每请求组装（`prompt-injection.getPromptsForGeneration` → `extension_prompts` 随请求上传），DB 中 `extension_prompts` 0 行、`user_settings` 无 `@bubble`。
  **改法**：落点改为 ①**渲染侧容错**（解析器同时接受 `[...]`/`"..."`/`“...”`，缺包裹时降级渲染）为主，②装配层纯增量强调为辅；不再改 `plugin_scripts` 内容。

- **【B4 · §2.2 表述纠正】** 「会话 `chat_metadata.variables` 在 2382 生成时为空」不成立：`{{format_message_variable::stat_data}}` 只读会话变量（`macro_service.py:581-598`），为空则输出 `{}`，模型不可能引用占位值；实为「**会话变量 = schema 占位值**」（`character_ext.py:4378` 建会话即写入）。另注：WS 路径（`websocket.py:1639`）与 ST 导入路径建会话**不初始化变量**，只有 REST 路径会——验收须注明用哪条入口。

- **【B6/B7/B8 · T1 补充三点】**
  1. **数据源优先级**：`palink_raw_card_data` 只在导入时写一次（`character_import_service.py:293`），编辑器改 `first_mes` 只更新列 ⇒ 优先取 **`characters.first_mes` 列**，raw 快照兜底；raw **顶层** `first_mes` 亦需纳入（v3 卡双份，v2 卡只有顶层）。
  2. 嵌套 `character_book` 必须是 **fallback-only**（顶层 `character_book` 取不到/为空时才回退 raw），否则导入快照会盖掉 `world_books`（用户可编辑）来源。本卡嵌套 19 条无 `<initvar>`，暂无症状，需补回归用例。
  3. **§5 验收口径改**：「首条消息后 stat_data == initvar」会被首轮回复自带的 `<UpdateVariable>` 打破（2382 就推进了时间）⇒ 改为「**会话创建完成、首轮生成开始前**断言 == initvar」或「断言不含占位指纹（年≠1 / 爱意≠0 / 魔力值≠100 / 位置≠未知 / `穿着` 非空）」。

**门禁数字更新**：后端为 `1623 tests collected`（2026-09-30 实测），约 **1581 passed / 42 skipped**；文中「约 1566」作废。
**无效断言**：§5 第 4 条「顶层 first_mes 的老结构卡行为不变」——实库 0/24 命中该结构，保留无害但不能作为验收证据。

---

## 0. TL;DR

| 编号 | 问题 | 根因 | 优先级 | 修复落点 |
| --- | --- | --- | --- | --- |
| R1 | 模型过度思考（思考=正文 10 倍）+ 会话变量基线错乱 | `build_initial_stat_data` 提取不到嵌套在 `palink_raw_card_data.data.first_mes` 里的 `<initvar>`，schema 占位 prefault 成了会话初始变量 | **P0** | `backend/app/services/mvu_engine.py` |
| R2 | `@bubble:` 裸显 | 模型输出中文引号格式，渲染脚本只认方括号格式 | P1 | 渲染脚本提示词段 / 前端兜底（方案见 §T2） |
| R3 | 【声音：…】每条裸显 | 提示词主动要求输出、仅 TTS 播放路径剥除、显示层不剥 | P1 | 前端 displayContent 管线 |
| R4 | `<now_plot>`/`<content>`/`<cg>` 裸显 | 卡正则（正文美化）未跑完时的中间态裸露；与 09-30 正文美化卡排查关联 | P2 | 关联既有议题，不重复立项 |
| R5 | `<\connect>` 一闪而过 | 流式中间态瞬态脏内容，持久数据全链无踪（已取证） | P3 | 观察，不立项 |

---

## 1. 背景与症状

用户报告（2026-09-30 上午，deepseek-v4-flash 实际对话）：

1. 模型有时**过度思考**，思考长度是输出的四五倍（实测一次为 10 倍）。
2. 输出里出现**不存在的 @bubble**（裸显标记）。
3. 出现**奇怪的 tag**（`<now_plot>`、`<content>`、`<cg>` 等）。
4. 出现**书名号/尖括号里杠 connect**（`<\connect>` 之类）一闪而过。
5. 结尾出现**中括号【声音：…】里面有内容**，裸显在正文里。

对应实库消息（`character_chat_messages` 表）：

| id | 时间 | content 长度 | reasoning_tokens | 备注 |
| --- | --- | --- | --- | --- |
| 2380 | 09-30 08:55:02 | 2385 | 0 | AI 生成开场卡（`<story>` + `<UpdateVariable><initvar>` + `<StatusPlaceHolderImpl/>`） |
| 2382 | 09-30 08:56:48 | 1005 | **10605** | 症状主力：思考 17870 字符 / 93.9 秒，正文 1005 字符 |
| 2384 | 09-30 09:06:33 | 582 | 141 | 恢复正常（因 2382 里模型自己把变量改回了 2026/7/8） |

---

## 2. 取证证据（可复现）

### 2.1 思考原文中的矛盾死循环（2382 `extra->reasoning`）

思考 17870 字符全文存于 `character_chat_messages.extra`（JSON 的 `reasoning` 字段）。关键段落：

> 「从状态设置来看：她的魔力值：60（较低），饥饿度：60（中等——她确实很饿），爱意：5」
> 「**等一下**，看最后的系统提示：环境：时间=年=1，季节=春，月=1，日=1，星期=一，小时=12，分钟=0；天气=☀️；温度=20；露缇雅：状态=爱意=0，魔力值=100，饥饿度=0，当前位置=未知，当前动作或体位=站立」
> 「**不对，让我重新思考**。……」

统计：`让我`×14、`等等`×6、`重新`×3。思考结尾还在纠结 `<cg>` 标签放置规则，并**把正文完整写了两遍草稿**（「重新写好并修正……」后跟全文第二稿）。

读取命令：

```bash
docker exec palink-ai-db-1 bash -c "psql -U ai_user -d ai_hub -t -A -c \"SELECT replace(encode(convert_to(extra,'UTF8'),'base64')::text, E'\\\\n','') FROM character_chat_messages WHERE id=2382;\"" \
  | python -c "import base64,sys,json; d=json.loads(base64.b64decode(sys.stdin.read().strip()).decode('utf-8')); print(d['reasoning'])"
```

### 2.2 会话变量链断点

- 会话 `chat_metadata.variables` 在 2382 生成时为空（生成后才有 2382/2384 模型自己补写的值）：
  当前值 `爱意=1，魔力值=100，饥饿度=5，位置=admin的卧室床边`——**与卡设定 `爱意=5，魔力值=60，饥饿度=60` 永久偏离**。
- 开场卡（2380）`<initvar>` 声明的真实初始值：

```yaml
环境.时间: 年=2026, 季节="夏", 月=7, 日=8, 星期="二", 小时=7, 分钟=0
露缇雅.状态: 爱意=5, 魔力值=60, 饥饿度=60, 当前位置="哥哥的卧室"
```

- 该 initvar 存在于卡 extensions 的 **`palink_raw_card_data.data.first_mes`**（嵌套），且消息 2380 正文里也完整保留。

### 2.3 schema 占位值与模型所见完全吻合

卡 extensions `tavern_helper.scripts` 中脚本「**露缇雅变量结构**」（2403 字符）的 zod schema：

```js
年: z.coerce.number().prefault(1),
季节: z.string().prefault('春'),
月: z.coerce.number().prefault(1),
魔力值: ... .prefault(100),
饥饿度: ... .prefault(0),
当前位置: z.string().prefault('未知'),
当前动作或体位: z.string().prefault('站立'),
```

与思考原文里模型看到的「年=1，季节=春，月=1，小时=12……魔力值=100，饥饿度=0，当前位置=未知」逐项吻合。

### 2.4 代码断点

`backend/app/services/mvu_engine.py:1051` `build_initial_stat_data(character_extensions)` 的提取范围（§1051-1093）：

1. `tavern_helper` schema defaults（`extract_schema_defaults`）→ 本卡命中，产出占位值
2. `tavern_helper.variables` → 本卡为空
3. **顶层** `character_extensions.get("first_mes")` / `alternate_greetings` 的 `<initvar>` → **顶层无此键，扑空**
4. `character_book.entries` 的 `<initvar>` → 无

而本卡 extensions 顶层键实测为：

```
depth_prompt, fav, narramem_identity, regex_scripts, talkativeness,
tavern_helper, world, odysseia_trace, palink_raw_card_data, palink_sillytavern
```

`first_mes`（含 initvar）在 `palink_raw_card_data.data.first_mes`；`alternate_greetings`、`character_book`（19 条，含「[mvu_update]变量更新规则」等）同样在 `palink_raw_card_data.data` 下。**步骤 3/4 全部按顶层取值，故扑空。**

调用链：`apply_mvu_reply_to_session`（`backend/app/services/character_message_builder.py:512`，行 584-585：会话变量无 stat_data 时才调 `MvuEngine.init_session_variables(char_ext_raw)`）→ 所有调用点（`character_ext.py:4740/5927/6066/6331`、`websocket.py:749`）共用同一 `build_initial_stat_data`，一处修复全链生效。

### 2.5 R3【声音】链路

- 要求输出：`backend/app/core/default_prompts.py:55-59`（「在回复的最后，用一行文字描述当前回复适合的声音特点，格式：【声音：描述】」；43-44 行注释明确其消费方是 tts.ts 与 compact_title_service）。
- 剥除位置：`frontend/src/services/tts.ts:210`（`cleanTextForTTS` 内 `/【(?:声音|语音)[：:]\s*[^】]+】/g`）与 `:199`（`extractVoiceDescription`）——**仅在播放语音路径调用**（`playMessage`，tts.ts:623-638，且特意从原始正文提取）。
- 显示层（`Message.tsx` displayContent 管线）无对应隐藏 → 每条回复末尾裸显。

### 2.6 R2 @bubble 格式

- 渲染脚本（`plugin_scripts` 表，「对话渲染系统 v7.1」，enabled）的提示词段规定：`@bubble:角色名|情绪|[对白]`，方括号格式，「@bubble: 是固定前缀，不可更改」。
- 2382 实际输出：`@bubble:露缇雅|不安|"嗯……好像是，肚子里面空空的……"`（中文引号）→ 渲染正则不匹配 → 裸显。
- 插件链路本身是通的：`plugins` 表「酒馆助手」（`eb1d50e9`，tavern_helper，enabled，source_type=character_card_extension）+ 两个脚本（「数据库界面插件(@bubble改造版)」「对话渲染系统 v7.1」）均 enabled。守卫背景见 `frontend/src/utils/sillyTavernPluginRuntime.ts:1407-1419`（[CARD-EXT-SCOPE-GUARD] 注释即「模型输出 @bubble 却无人渲染」这一分裂态的成因记录）。

### 2.7 R4 卡正则链

卡 extensions `regex_scripts` 共 6 条：状态栏、隐藏变量更新、状态栏标签隐藏、变量更新美化、**正文美化**（`/<(story|Lnterleaving|now_plot|content|正文)>([\s\S]*?)<\/\1>/gi` → 替换为 30181 字符自建 HTML 卡）、对ai隐藏cg标签。前端兜底注释：`Message.tsx:853-864`（「后端已剥离，此处兜底旧消息/流式中间态」）；标签清单见 `frontend/src/lib/sillytavern/formatting.ts:125/306`、`html-detect.ts:35`。

### 2.8 R5 connect 取证范围（全空）

以下位置均无 `connect` 字样：全库 `content`、该会话全部消息的 `swipes`/`content_json`/`extra`（含 2382 思考 17870 字符）、`chat_variables` 表（0 行）、会话 `chat_metadata`、卡 extensions 全 JSON（351573 字符，唯二命中为 `observer.disconnect()` 子串）、两份渲染脚本（249KB + 4MB，后者命中为 cytoscape 内部函数名）、世界书 raw_content、`regex_scripts` 表（0 行）。结论：瞬态流式内容，不落库。

---

## 3. 根因分析

### R1（P0）MVU 初始变量断链 → 过度思考 + 变量基线错乱

因果链：

1. 卡 schema 的 prefault 占位值（年=1/月=1/魔力=100/饥饿=0/位置=未知）因 first_mes 嵌套取不到而成为会话初始变量；
2. 装配时 `<status_current_variable>`（`macro_service.py:581-598`，`{{format_message_variable::stat_data}}`）把占位值注入提示词；
3. 模型发现占位值与剧情上下文（七月/她很饿/爱意 5，来自开场卡正文与世界书）全面冲突 → 思考中反复重读调和 → 把正文草稿完整重写两遍 → 思考 10605 tokens（正文 10 倍）、93.9 秒；
4. 模型最终在回复里输出 `<UpdateVariable>` 按剧情猜变量（时间改对，幅度错）→ 应用后基线永久偏离卡设定（5/60/60 → 1/100/5）。

次要放大器（修复 R1 后仍会存在，属推理模型固有行为，**验收预期要设对**）：本卡输出格式规范多层叠加（@bubble 格式、`<cg>` 放置、【声音】行、变量更新指令、`<now_plot>` 包裹），推理模型倾向在思考区打草稿复核。装配层已有针对性处理先例：`roleplay_prompt_assembly.py:1493-1505`（剥离结尾裸闭合标签行，防 deepseek-v4-flash 提前停止）。R1 修复目标是**消除变量矛盾引发的死循环**，不是把思考量压到 1:1。

影响面：所有 extensions 为 `palink_raw_card_data` 嵌套结构的卡（含「AI 生成开场卡反向保存」路径的卡）。

### R2（P1）@bubble 格式漂移

模型把「正文对白用中文引号」泛化到了 @bubble 内容上；渲染器只认方括号。渲染器启用正常，属格式不匹配而非渲染缺失。

### R3（P1）【声音】显示层不剥

设计上该行是 TTS 声线参数（09-25 批次 [AUDIT-2026-09-25] 修复后从原始正文提取），显示层从未加隐藏——提示词要求输出 + 显示层不剥 = 必然裸显。

### R4（P2）tag 裸露中间态

卡正则「正文美化」整体替换 `<now_plot>/<content>` 包裹段；美化卡渲染失败降级原文、或流式中间态兜底未覆盖时裸露。**与 2026-09-30 已在排查的「露缇雅正文美化卡 min-height:100vh 高度切片、realContent 上报被 `CharacterCardRenderer.tsx:868` 丢弃」议题同源**，见根目录 `HANDOFF_卡片正文空白与卡脚本执行_2026-09-30.md`，本 SPEC 不重复立项，仅登记关联。

### R5（P3）`<\connect>` 瞬态

持久数据全链无踪（§2.8），判定为流式输出中间态的瞬态脏内容（推理模型流式期间偶发吐出错误开合标记，随后被自己改写或被最终文本覆盖）。不立项；若复现，让用户立即复制原文取证。

---

## 4. 修复任务

### T1（P0）：`build_initial_stat_data` 补嵌套层级 fallback

**文件**：`backend/app/services/mvu_engine.py`

1. `build_initial_stat_data`（§1051）步骤 3：顶层 `first_mes`/`alternate_greetings` 取不到时，依次回退读 `character_extensions["palink_raw_card_data"]["data"]["first_mes"]` / `["alternate_greetings"]`；
2. `_extract_initvar_from_character_book`（§1024）同理补 `palink_raw_card_data.data.character_book` 层级；
3. 深合并顺序保持不变（schema → tavern_helper.variables → first_mes initvar → character_book initvar，后者覆盖前者）——initvar 必须覆盖 prefault 占位值；
4. 核对全部调用点行为不受影响：`apply_mvu_reply_to_session`（character_message_builder.py:512，行 584 兜底 init 仅在变量为空时触发）、`character_ext.py:4370` 附近注释引用处、`mvu_engine.py:1107/1125`；
5. `extract_schema_defaults` 不动。

**不做**（防 scope 膨胀）：存量错乱会话的自动迁移。会话变量非空不会触发兜底 init，属预期行为；存量会话由用户重开会话或后续单独立项。

**验证**：

```bash
# 修复后新会话生成开场卡 → 首条消息后检查会话变量应等于 initvar：
docker exec palink-ai-db-1 psql -U ai_user -d ai_hub -t -A -c \
  "SELECT chat_metadata FROM character_chat_sessions WHERE id='<新会话id>';"
# 期望 stat_data 含 年=2026/月=7/爱意=5/魔力值=60/饥饿度=60/当前位置=哥哥的卧室
```

### T2（P1）：@bubble 引号格式

按优先级两步：

> **[复核修订 B2/B3 · 本任务重心变更]** 复核证明 2382（过度思考那条）的 `@bubble` **格式完全合规**，裸显真因是**缺 `<now_plot><content>` 包裹 → 卡正则不命中 → 无 `dcRoot` iframe → 无渲染宿主**（见「修订记录 R2-a」）。
> 且「方括号」约束在脚本规则第 6 条**早已存在**；注入文本由客户端 IndexedDB `format_rule` 每请求组装，**改 `plugin_scripts` 内容无效**（见「修订记录 B3」）。
> 因此：**T2a 原方案作废**，改为 ①渲染侧格式容错（接受 `[...]`/`"..."`/`“...”`，缺包裹时降级渲染）+ ②装配层纯增量结构强调；施工时以「修订记录」为准。

- **T2a（原方案，已作废 · 保留备查）**：提示词强化。落点二选一（施工时评估）：改 `plugin_scripts` 表「对话渲染系统 v7.1」content 的提示词段，明确「内容一律用方括号 `[...]`，禁止用引号包裹」（缺点：卡更新会丢）；或在 Palink 装配链对该类卡追加一条格式强调（缺点：动装配链，需谨慎、纯增量不改结构）。
- **T2c（复核新增，替代 T2a）**：结构合规与渲染兜底——(a) 渲染侧解析器容错三种引号；(b) 消息缺 `<now_plot><content>` 包裹时，让 `@bubble` 行降级为可读文本/弱渲染，而不是把原始标记漏进正文。
- **T2b（待拍板，默认不做）**：前端显示层兜底——对未被渲染脚本消费的裸 `@bubble:` 行降级为普通对白文本。风险：难以可靠判断「标记未被消费」，误伤正常渲染路径。先观察 T2a 效果再定。

### T3（P1）：【声音】显示层隐藏

> **[复核修订 B1 · 落点已定]** 只走 **`formatting.ts` / formatter 显示管线**，**禁止**改 `Message.tsx` 的 `displayContent`：
> `Message.tsx:1112` 把 `displayContent` 传给 `playMessage`、`tts.ts:635` 从该入参提取声线，在此剥离会让声线恒为 `null`。
> 另需一并覆盖 `Message.tsx:1080 / 1086 / 1582` 三处 `pipelineResult?.… || displayContent` 回退路径。

**文件**：前端显示管线 —— `frontend/src/lib/sillytavern/formatting.ts` 的标签隐藏列表（或 `sillyTavernDisplayPipeline` 的 hook 侧），**不要两处都加**。

- 正则与 tts.ts 保持同源：`/【(?:声音|语音)[：:]\s*[^】]+】/g`（完整闭合才隐藏；流式半截 `【声音：xx` 不匹配属正确行为，闭合后整体消失）；
- 只影响显示，不动 `tts.ts` 从原始正文提取的路径（`playMessage` 收到的仍是原文）；
- 注意 `[[声音]]` 双括号变体如卡内存在需一并核对（搜卡数据确认，勿臆测）。

### T4（P2）：R4/R5 不立项，登记观察

- R4 归入正文美化卡既有排查（HANDOFF_卡片正文空白与卡脚本执行_2026-09-30.md）；
- R5 保持观察：复现时立即复制流式原文，再定是否需要流式清洗（需防误伤合法标签，默认不做）。

---

## 5. 验收标准

1. **R1 核心验收**：新建会话（用「露缇雅1.2」或任一 palink_raw_card_data 结构含 initvar 的卡）生成开场卡后，首轮对话：
   - 会话 `chat_metadata.variables.stat_data` 与开场卡 initvar 一致（本卡即 2026/7/8、爱意 5、魔力 60、饥饿 60）；
     **[复核修订 B8]** 断言点必须在**会话创建完成、首轮 AI 回复落库之前**（首轮回复自带 `<UpdateVariable>` 会改值，实测 2382 就推进了时间）；若要在多轮后断言，改判「不含占位指纹」：年≠1 / 爱意≠0 / 魔力值≠100 / 当前位置≠未知 / `穿着` 非空。
     **并注明建会话入口**：REST 路径（`character_ext.py:4350`）会初始化变量，WS 路径（`websocket.py:1639`）与 ST 导入路径不会。
   - 首轮 reasoning_tokens 对比基线 10605 显著回落（预期量级：与正文同数量级或数倍以内；无变量矛盾即无死循环）；
   - 思考原文中不再出现「变量与剧情冲突」的调和段落。
2. **R3 验收**：消息 UI 不再显示【声音：…】行；点播放语音仍能正确提取声线（voice_description 生效）。
3. **R2 验收**：模型输出 @bubble 使用方括号格式（抽多轮观察）；无新增裸显。
4. **回归**：`apply_mvu_reply_to_session` 四入口（普通对话/regenerate/swipe/continue）+ WS 路径的「先解析后剥标签」契约不变；`tests/` 中 MVU 相关用例全绿；存量非嵌套结构卡（顶层 first_mes）行为不变。

---

## 6. 门禁与红线

- 后端：`cd backend && python -m pytest tests/`（当前基线约 1566 通过 / 42 skip，以动工时实跑为准）。
- 前端：`cd frontend && npx tsc --noEmit`；`cd frontend && npx vitest run`（唯一前端门禁入口）。
- 遵守根目录 `AGENTS.md`：动工前读 `TODOS.md` 并登记本 SPEC；MVU 装配链为增量修改、不做结构性改动；多 agent 合住仓库，git 逐项 pathspec 暂存，禁止 `git add -A`。
- 已知施工坑（历史实测）：Mimosa hook 会拦截触碰备份目录 `.py` / `docker cp .py`，同步代码走 `compose build`、容器探针走 stdin heredoc；`_card_has_mvu_scripts` 类局部导入被 try 吞 NameError = 静默失效，改动后必须实弹验证；PUT settings 响应不回显字段，需 GET 回读。

---

## 7. 关联文档

- `HANDOFF_MVU初始变量断链与输出tag裸显_2026-09-30.md`（根目录，自包含交接提示词）
- `HANDOFF_卡片正文空白与卡脚本执行_2026-09-30.md`（正文美化卡渲染排查，R4 同源）
- `docs/SPEC_MVU变量更新SSE侧补齐与取证_2026-09-28.md`（apply_mvu_reply_to_session 四入口契约出处）
- `docs/SPEC_MVU提示词依从性零成本筛查_2026-09-28.md`（T3 深度窗对齐背景）
