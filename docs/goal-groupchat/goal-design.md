# 目标设计：群聊后端对 ST 1.18.0 高保真适配 + 1:1 非回归

> 工作区：`D:\项目\Palink-AI\docs\goal-groupchat`
> 取向（用户确认）：① 严格对齐 ST 1.18.0；② 1:1 验证 = 专项直测 + 全量零回归
> 修改边界：仅 `backend/app/services/roleplay_prompt_assembly.py` + 新增/调整测试；不涉及模型迁移、前端。

---

## 一、ST 1.18.0 群聊算法基线（逐字提取自 `SillyTavern-1.18.0/.../public/scripts/group-chats.js`）

### 1.1 激活策略（仅 0–3）
- `group_activation_strategy` 枚举：`NATURAL=0, LIST=1, MANUAL=2, POOLED=3`（:122）。`TALKATIVE=4 / VOTING=5` 为 ST **之后**版本扩展，1.18.0 **无** → st-compat 收到 4/5 回退 NATURAL(0) 为正确对齐。
- `activateNaturalOrder(members, input, lastMessage, allowSelfResponses, isUserInput)`（:1242-1316）：
  - `bannedUser = !isUserInput && lastMessage && !lastMessage.is_user && lastMessage.name`（:1246），`allowSelfResponses` 时置空（:1249）。
  - **提及强制**：遍历 `extractAllWords(input)`，对每个成员 `extractAllWords(character.name).includes(inputWord)`，命中且 `character.name !== bannedUser` 则加入 `activatedMembers`（:1254-1269）。提及**尊重 bannedUser 回避**。
  - **概率激活**：`shuffledMembers = shuffle([...members])`（:1273），对每个 `talkativeness >= Math.random()` 且 `name !== bannedUser` 加入（:1274-1291）。`chattyMembers` = `talkativeness>0`（:1288）。
  - **回退**：`activatedMembers` 空时从 `chattyMembers.length>0 ? chattyMembers : members` 随机取（:1296-1306）。
  - 去重 → 映射 characterId（:1309-1315）。
- `activatePooledOrder(members, lastMessage, isUserInput)`（:1197-1231）：反向扫描 `chat`，遇 user/isUserInput 停止；收集 `message.original_avatar` 入 `spokenSinceUser`；`haveNotSpoken = members.filter(x => !spokenSinceUser.includes(x))`；取其一随机；皆已发言则从 `members.filter(x => x !== lastMessage.original_avatar)` 随机。
- `activateListOrder(members)`（:1180-1188）：返回全部启用成员（roster 顺序），无旋转。
- **禁用成员跳过**：`enabledMembers = group.members.filter(x => !group.disabled_members.includes(x))`（:1003）。SWAP 模式直接用各成员自己卡；APPEND/APPEND_DISABLED 用合并卡。

### 1.2 合并卡（C2）
- `getGroupCharacterCardsLazy`（:497-571）返回 lazy：`description / personality / scenario / mesExamples`。
- `customTransform(value, fieldName, characterName, trim)`（:513-518）：`value.replace(/<FIELDNAME>/gi, fieldName)` → 可选 trim → `baseChatReplace(value, null, characterName)`（替换 `{{char}}`→characterName）。
- `replaceAndPrepareForJoin(value, characterName, fieldName, preprocess)`（:528-538）：`value=trim`；`preprocess` 先处理；`prefix=customTransform(group.generation_mode_join_prefix, fieldName, characterName, false)`；`suffix=customTransform(group.generation_mode_join_suffix, fieldName, characterName, false)`；`value=customTransform(value, fieldName, characterName, true)`；返回 `prefix+value+suffix`。**关键：成员名不自动前缀**，前缀/后缀来自 `generation_mode_join_prefix/suffix`。
- `collectField(fieldName, getter, preprocess)`（:547-559）：遍历 `group.members`，跳过 `index===-1 || !character`；跳过 `disabled_members.includes(member) && characterId !== index && generation_mode !== APPEND_DISABLED`；对每个有效成员 push `replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess)`；`values.filter(x=>x.length).join('\n')`。
- **字段组装**（:564-570）：
  - `description = collectField('Description', c=>c.description)`
  - `personality = collectField('Personality', c=>c.personality)`
  - `scenario = baseChatReplace(chat_metadata.scenario?.trim()) || collectField('Scenario', c=>c.scenario)` ← **chat_metadata.scenario 覆盖优先**
  - `mesExamples = baseChatReplace(chat_metadata.mes_example?.trim()) || collectField('Example Messages', c=>c.mes_example, x => !x.startsWith('<START>') ? '<START>\n'+x : x)` ← **chat_metadata.mes_example 覆盖优先；逐成员 mes_example 未以 `<START>` 开头则补 `<START>\n`**
- 合并卡仅在 `generation_mode ∈ {APPEND=1, APPEND_DISABLED=2}` 生效；SWAP(0) 时返回 null，各成员用自己卡。
- **Name 前缀规则（history）**：`openai.js:585-596` `${chat[j].name}: ${content}`，由 `names_behavior` 门控（D2 已对齐）。

---

## 二、逐项差异矩阵（吻合 / 偏离 / 扩展）

| 项 | 现状 | ST 1.18.0 | 判定 | 严重度 | 修复归属 |
|----|------|-----------|------|--------|----------|
| 激活枚举 0–3 | `_GROUP_ACTIVATION_*` 含 4/5 | 仅 0–3 | 扩展（st-compat 回退 NATURAL 正确） | — | 保留；st-compat 回退已落地（:2069-2075） |
| NATURAL 提及强制 | `_members_mentioned_in_text` 词边界+子串 | `extractAllWords(name).includes(word)` | 吻合（超集，含中文） | — | 保留；补充 bannedUser 回避（偏离→修复 S4.2） |
| NATURAL 提及尊重 bannedUser | 提及命中**包含**最后发言者 | 提及循环 `character.name === bannedUser → continue` | **偏离** | 中 | S4.2 修复 |
| NATURAL follower 衰减 | `_eff(m)=t*FOLLOWER_DAMPING(0.3)` 始终生效 | ST 无 follower 概念 | **偏离（仅 st-compat）** | 中 | S4.1 st-compat 忽略 follower |
| NATURAL 概率 `random()<=eff` | `random.random() <= eff` | `talkativeness >= rollValue` | 吻合 | — | 保留 |
| NATURAL 回退池 | `chatty if chatty else members`（:1732） | `chattyMembers.length>0 ? chattyMembers : members` | 吻合 | — | 保留 |
| NATURAL 防连续 | `allow_self or m.id != last` | `bannedUser` 规避 | 吻合 | — | 保留 |
| POOLED | `_select_pooled_speaker` | `activatePooledOrder` | 吻合（:1785-1803） | — | 保留 |
| LIST | `_resolve_group_speaker` 单发言者 fallback + F1 队列 | `activateListOrder` 全量 | 吻合（F1 已落地多成员串联） | — | 保留 |
| MANUAL(2) 无选角 | 跳过 AI 生成（F1 空队列） | ST 无自动选角 | 吻合 | — | 保留 |
| 合并卡 字段 | description/personality/scenario/mesExample | 同 | 吻合 | — | 保留 |
| 合并卡 **成员名前缀** | `f"{prefix}{m.name}: {val}{suffix}"`（:1643） | **无**自动名前缀，仅 prefix/suffix | **偏离（高）** | 高 | S3 移除名前缀，改 prefix/suffix 包裹 |
| 合并卡 **mes_example `<START>`** | 未包裹 | 逐成员补 `<START>\n` | **偏离（高）** | 高 | S3 补包裹 |
| 合并卡 **chat_metadata 覆盖** | 未读 scenario/mes_example 覆盖 | `chat_metadata.scenario/mes_example` 优先 | **偏离（中）** | 中 | S3 加覆盖 |
| 合并卡 **`<FIELDNAME>`/{{char}}** | 未做 token 替换 | `customTransform` 替换 | **偏离（中）** | 中 | S3 复刻 |
| 合并卡 disabled 跳过 | 调用方预选（APPEND 排除/APPEND_DISABLED 含） | collectField 内跳过逻辑 | 吻合 | — | 保留（回归确认） |
| SWAP 发言者卡绑定 | D3 `_resolve_group_speaker` 回填 `req.char=speaker_char` | SWAP 用发言者自己卡 | 吻合 | — | 保留 |
| history Name 前缀 | D2 `names_behavior` 四态 | openai.js:585-596 | 吻合 | — | 保留 |
| 1:1 路径（group_id=None） | 守卫在所有群聊分支入口 | N/A | 吻合 | — | S5 专项直测加固 |
| worldbook 群策略 | E1/E2 已落地 | `match_chat_metadata` 等 | 吻合 | — | 保留 |

**结论**：差异集中在 **S3（合并卡 4 处保真）** 与 **S4（NATURAL 2 处保真）**；1:1 路径经 S5 直测证明零泄漏。

---

## 三、修复设计

### S3. 合并卡保真（`_build_group_combined_card`，:1619-1651）
重写为对齐 `collectField`/`customTransform`/`replaceAndPrepareForJoin`：

1. **读取**：`meta = group.chat_metadata`；`prefix = meta.get('generation_mode_join_prefix') or ''`；`suffix = meta.get('generation_mode_join_suffix') or ''`。
2. **`_custom_transform(value, field_name, char_name)`**：`value` 空→`''`；`re.sub(r'<FIELDNAME>', field_name, value, IGNORECASE)`；`value.replace('{{char}}', char_name)`；返回。**不处理 `{{user}}`**（留给下游 `_sub`）。
3. **`_prepare(value, char_name, field_name, preprocess)`**：`value=trim`；空→`''`；`preprocess` 先处理；`pre = _custom_transform(prefix, field_name, char_name)`；`suf = _custom_transform(suffix, field_name, char_name)`；`body = _custom_transform(value, field_name, char_name)`；返回 `pre+body+suf`。**不再拼接 `m.name: `**。
4. **字段组装**：
   - `description = _field('Description', lambda m: m.description)`
   - `personality = _field('Personality', lambda m: m.personality)`
   - `scenario`：`override = (meta.get('scenario') or '').strip()`；若非空 → 用 `override`（经 `_custom_transform(override, 'Scenario', firstMemberName?)`（字符名取发言者由下游解析，此处保留 `{{char}}` 留给下游））；否则 `_field('Scenario', lambda m: m.scenario)`。
   - `mes_example`：`override = (meta.get('mes_example') or '').strip()`；若非空 → 用 `override`；否则 `_field('Example Messages', lambda m: m.mes_example, preprocess=lambda x: x if x.startswith('<START>') else '<START>\n'+x)`。
5. **`_field(field_name, getter, preprocess=None)`**：遍历 `members`，`val=getter(m)`；`part = _prepare(val, m.name, field_name, preprocess)`；非空 append；`'\n'.join(parts)`。
6. 调用方预选成员逻辑不变（APPEND=启用 / APPEND_DISABLED=全量）。
7. 签名不变（无测试直接 import 此函数；仅 :3017 调用）。

> 注意：`test_st_compat_group_generation_mode.py` 的 `_combined_card` 为**独立 mock 助手**，不调用真实函数，断言 `"Alice: desc A"` 仅测消费逻辑，不受本修复影响 → 无需改。新增 `test_group_chat_combined_card.py` 直测真实函数（无 `Name: `、`<START>`、覆盖、token 替换）。

### S4. NATURAL / follower 保真（模式感知）
1. **S4.1 follower 衰减仅 palink-native**：`_select_natural_speaker` 新增参数 `st_mode="palink-native"`；当 `st_mode == "st-compat"` 时 `follower_ids = set()`（忽略 `group.follower_members`），保证严格对齐。`_resolve_group_speaker` 的 `strategy==0` 分支透传已算出的 `st_mode`（:2062-2068）。默认 `"palink-native"` 保持现有测试行为。
2. **S4.2 提及尊重 bannedUser**：`_select_natural_speaker` 步骤(1) 在提及命中后过滤 `last`（除非 `allow_self`）：`mentioned = [m for m in mentioned if allow_self or m.id != last]`；为空则回落到步骤(2)。与 ST 提及循环 `character.name === bannedUser → continue`（:1259）一致。
3. **S4.3 顺序**：ST 在概率循环前 `shuffle(members)`，但本实现用 `random.choice(activated)`/`randomPool[idx]` 均匀选取，顺序不影响分布 → **等价，不改动**（降低风险）。

### S5. 1:1 非回归直测（`tests/test_single_chat_no_group_leakage.py`，新建）
复用 `test_st_compat_group_chat_e2e.py` 的 mock 基建（`_make_request/_make_mock_db/_run_assembly`），新增断言：
- `group_id=None` 装配后：
  - `result.report` 中无 `group_member_profiles`（included）且无 `group_combined_card` 相关项；
  - `result.system_prompt` 不含 `[当前发言者身份]`、不含合并卡内容；
  - 直接调用 `build_st_compat_messages(..., is_group=False, generation_mode=1, group_combined_card={...})` 断言合并卡**不**生效（description 取 `char.description` 而非合并卡）；
  - 历史消息无 `"Name: "` 群前缀（用 `names_behavior` 默认）；
  - `worldbook` 组策略不走 group 分支（解析 `group_chars=None`）。
- 另起一条 `group_id="g"` 对照，证明同函数两条路径隔离。

### S6. 群聊合并卡保真测试（`tests/test_group_chat_combined_card.py`，新建）
直测 `_build_group_combined_card`：
- 默认 prefix/suffix → 各字段**不含** `Name: ` 前缀，且逐成员值按 `\n` 连接；
- `mes_example` 未以 `<START>` 开头 → 补 `<START>\n`；已开头则保持；
- `chat_metadata.scenario` / `chat_metadata.mes_example` 非空 → 覆盖逐成员收集；
- `generation_mode_join_prefix/suffix` 含 `<FIELDNAME>` / `{{char}}` → 被正确替换；
- `disabled_members` 在 APPEND（启用成员传入）不出现、APPEND_DISABLED（全量传入）出现。

### S7. 全量验证与报告
- 运行 `python tests/ -q`（系统 python 3.13，pytest 9.1.1），目标 **0 失败**。
- 输出 `goal-verification-report.md`：修复清单、差异矩阵闭合情况、已知限制（palink-native 扩展 TALKATIVE/VOTING/follower 保留但 st-compat 严格对齐）。

---

## 四、风险与回归护栏
- S3 不改 `_build_group_combined_card` 签名 → 无调用方断点；消费侧 builder 已按 `generation_mode in (1,2) and group_combined_card` 分流，无需改。
- S4.1 默认 `palink-native` → 现有 follower 测试零回归；新增 st-compat 忽略断言。
- 全量测试前先单跑新增测试，再跑全量确保 0 失败。
