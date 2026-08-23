# SillyTavern 兼容性查验 Spec（2026-08-23）

> **性质**：只读兼容性排查报告，本次**未修改任何业务代码**。
> **模式立场**：按 AGENTS.md，主攻 `palink-native`；`st-compat` / `st-native` 已封存冷处理，本报告仅在其作为"对齐参照实现"时提及。
> **ST 参照基准**：仓库内自带 SillyTavern 1.18.0 源码——`frontend/public/st/script.js`、`frontend/public/st/scripts/*.js`（含 world-info.js、macros.js）、`.codex/st-source/`（st-context.js / events.js / regex-engine.js / script.js 提取件）。
> **排查方法**：静态代码走读 + 与 ST 1.18.0 逐函数/逐字段比对 + 复核既有审计文档结论（过时项已标注）。
> **约束遵守**：涉及「思考/正文分离存储」（其他 agent 进行中）的内容仅标记、未深入验证，见 §12。

---

## 1. 总览结论

严重度定义：**P0 致命**（核心功能完全不可用）/ **P1 严重**（功能失效或行为明显错误）/ **P2 一般**（特定场景行为偏差）/ **P3 轻微**（边缘差异/体验问题）。

| # | 模块 | 兼容度 | 最高严重度 | 一句话结论 |
|---|------|--------|-----------|-----------|
| A | 插件系统 | ★★★☆☆ | **P1** | 沙箱轨 P0 结构性问题已大面积闭环；经典轨与沙箱轨能力倒挂是当前最大短板 |
| B | 角色卡解析 | ★★★★☆ | P2 | 解析/导入层成熟度最高（V1/V2/V3 超集）；palink-native 装配层有 4 处语义差异 |
| C | 正则系统 | ★★★☆☆ | **P1** | 后端引擎对齐质量最高；前端主链路存在普通脚本重复应用等叠加风险 |
| D | 世界书 | ★★★★☆ | **P1** | 后端扫描状态机高对齐；delay 死锁 bug 与导入入口字段丢失需修 |
| E | 提示词注入机制 | ★★★★★ | P3 | 宏系统近乎完整覆盖 ST 1.18.0；装配管线（depth 队列/prompt_order/instruct）成熟 |
| F | 回复渲染系统 | ★★★★☆ | **P1** | showdown 管线对齐 ST；LaTeX 流式/完成态自相矛盾为主要缺陷 |
| G | 数据存储 | ★★★★☆ | P2 | ST 消息字段全覆盖；缺 ST media 附件体系（多模态走 content_json 替代） |
| H | 变量系统与角色面板 | ★★★★☆ | P2 | MVU 链路自洽完整；useProbability 类开关缺失影响变量卡概率条目 |
| I | 副 AI 功能 | ★★★★☆ | P3 | 全手动触发按钮已接线，守卫完备 |

**总体判断**：无 P0 级问题。核心链路（角色卡导入 → 提示词装配 → 生成 → 正则 → 渲染 → 变量面板）端到端可跑通且多数子系统有意识对标 ST 1.18.0 并带测试背书。当前兼容性债务集中在：①前端插件兼容层的双轨不对称；②正则显示层与持久化层的多次叠加风险；③世界书 delay 计时条目失效。

---

## 2. 模块 A：插件系统

### 2.1 架构事实

Palink 存在**三条插件执行轨道**（ST 只有一条"直注 window"）：
1. **沙箱轨**（`frontend/src/lib/plugin-system/sandbox.ts`）：`new Function` 词法遮蔽 + Proxy DOM 边界，六批安全加固；
2. **经典轨**（`frontend/src/utils/sillyTavernPluginRuntime.ts`）：真实 `<script>` 注入主 window + fetch 守卫；
3. **tavern_helper 直注轨**（`frontend/src/lib/plugin-system/manager.ts:167-176`）：4MB+ 大脚本完全绕过沙箱直接注入主 window。

### 2.2 主要发现

#### A-1【P1】经典轨 getContext 返回对象严重缩水
`sillyTavernPluginRuntime.ts:649-662` 注入的 `SillyTavern.getContext()` 只返回 name/character/chat/chatId 等数据字段；`eventSource`、`toastr`、`getRequestHeaders`、`substituteParams`、`renderExtensionTemplateAsync` 等仅以 window 全局存在。ST 插件惯用的解构写法：

```js
const { eventSource, getRequestHeaders } = getContext(); // 经典轨下均为 undefined
```

沙箱轨已用惰性聚合 Proxy 解决（sandbox.ts:3057-3067，PLUGIN_ISSUES_REPORT P-1 已修复并核实），两轨不一致。

#### A-2【P1】沙箱内酒馆助手 API 能力倒挂（stub vs 真桥接）
`sandbox.ts:3504-3622` 中 `triggerSlash`、`setChatMessages`、`deleteChatMessages`、`openCharacterChat`、`injectPrompts`、`generate` 等仍是 no-op stub 并 `console.warn`；而同样的 API 在经典轨已有真桥接（sillyTavernPluginRuntime.ts:680-699）。后果：跑在沙箱里的酒馆助手脚本调用这些 API 静默失效，而同代码注入主 window 反而能工作。

```ts
// sandbox.ts:3504-3508
triggerSlash: (...args) => {
  console.warn('[PluginSandbox] triggerSlash stub', ...args);
  return Promise.resolve('').as_report_id...
}
```

#### A-3【P1】writeExtensionField 同名三义
ST 签名 `(characterId, key, value)` 写角色卡 extensions。Palink 三处实现三种语义：沙箱 moduleMap 版已按 ST 对齐（sandbox.ts:4465-4488）；getContext 轨（getContext.ts:1690-1702）与 sandbox 顶层全局（sandbox.ts:3243-3245）却是"扩展设置命名空间"语义。同名不同义，插件按 ST 用法在两条轨道得到不同结果。

#### A-4【P2】事件面偏差
- `addOneMessage`（getContext.ts:1506-1513）一次同时 emit `message_received` + `message_sent`，而 ST 中两者分别只在 AI 回复/用户发送时触发——订阅方区分收发方向会被误导；
- 经典轨事件发射面明显薄于沙箱轨（app_ready/generation_started 在经典 listeners 上未见发射点，待运行时验证）；
- 约 15 个小众 ST 事件未定义（SECRET_WRITTEN、ITEMIZED_PROMPTS_* 等，P3）；另有一批 Palink 自造事件无害共存。

#### A-5【P2】半兼容字段集（getContext）
| 字段 | 问题 | 位置 |
|---|---|---|
| `tokenizers` | ST 是数字枚举对象；Palink 是 `{getTokenCount,...}` 方法集，`ctx.tokenizers.OPENAI === undefined` | getContext.ts:1711-1723 |
| `getRequestHeaders` | 安全化改写，不含 Authorization，插件拿去调 XHR 无凭据 | getContext.ts:1679-1684 |
| `symbols.ignore` / `constants.unset` | 键名不匹配（Palink 给 IGNORE_SYMBOL/SWIPE_COUNT_DEFAULT） | getContext.ts:2688-2699 |
| `executeSlashCommandsWithOptions` 返回形状 | getContext 轨直接返回引擎结果（无 `.pipe`），沙箱轨有映射——两轨又不一致 | getContext.ts:2168-2172 |
| `messageFormatter` | 缺失 | — |
| `registerFunctionTool` | 注册表真实但生成管线从不消费；getContext 轨显式 stub | getContext.ts:2592-2614 |

#### A-6【P2】经典轨缺 window.setExtensionPrompt 全局
`sillyTavernPluginRuntime.ts:883-893` 只有 `window.injectPrompts` 桩；BubbleDialogue 类卡内脚本引用全局 `setExtensionPrompt(...)` 会 ReferenceError。七参签名与 position/role 枚举本身已完全对齐 ST（prompt-injection.ts:30-37 ↔ script.js:484-505）。

#### A-7【P2】多租户隔离缺失（M-3，已知遗留）
`backend/app/api/plugins.py:1097` runtime 配置查询仅 `enabled==True` 无 user 过滤——插件内容作用于所有用户。PLUGIN_ISSUES_REPORT §11.2 明确延后，维持未解决。

#### A-8 正面确认
- `generate_interceptor` **真实生效非 stub**：generation-engine.ts:105-139 三生成入口统一挂拦截器；vectors_rearrangeChat 的消息重排经 message_order 真正落到后端 palink-native 装配（plugins.py:1134-1143 下发有序清单）；
- `renderExtensionTemplateAsync` 完整实现（Handlebars + DOMPurify + 本地 fetch 路由，TODOS.md 所述 P-8 属实）；
- slash 命令注册真实现（fromProps/addCommandObject/parse 均可用，K-1/P-11）；
- 安装/激活/禁用/卸载链路完整，loading_order 排序对齐 ST（plugins.py:507-522）；
- zip 导入限制、模板抽取放宽、power_user/oai_settings/SECRET_KEYS 等 P-9/P-10 均已闭环。

### 2.3 模块小结
2026-08-09 PLUGIN_ISSUES_REPORT 的 P0 批次已基本闭环且有代码实证。当前残余重心 = **轨道间 API 不对称**（A-1/A-2/A-3/A-6）+ **安全债**（A-7、tavern_helper 绕沙箱、经典轨 XHR/WS 不设防）。

---

## 3. 模块 B：角色卡格式及属性解析

### 3.1 主要发现

#### B-1【正面】解析层为 ST 超集
`backend/app/character_card.py` 支持 tEXt/zTXt/iTXt 三种 PNG chunk（:74-108）、base64/裸 JSON/zlib（:111-123）、ccv3 优先于 chara（:134-141）；JSON/CharX/BYAF/YAML 直导；导出同时写 chara(V2)+ccv3(V3) 双 chunk（ST 1.18 只写 chara）。截断损坏检测优于 ST。

#### B-2【P2】mes_example `<START>` 不拆块（palink-native）
`character_message_builder.py:143-147` 将 mes_example 整块作为单条 system 文本注入，`<START>` 作为字面量保留；ST 会拆成带 `[Example Chat]` 标记的多条消息。st-compat 分支反而有完整的 parseMesExamples 等价实现（character_message_builder.py:421-432、758-793，已封存但可作参照）。

#### B-3【P2】V3 独立 jailbreak 字段 palink-native 不消费
jailbreak 已正确提取落库（character_card.py:331-340：extensions.jailbreak > data.jailbreak > PHI 兜底），但 palink-native 装配只追加 post_history_instructions（character_message_builder.py:224-226）；独立 jailbreak 仅 st-compat 合并链消费（roleplay_prompt_assembly.py:3731-3820）。若 V3 卡 jailbreak ≠ PHI，该内容在主攻模式下丢失。

#### B-4【P2】卡 system_prompt 是"合并注入"而非 ST 的 main 槽 override
`default_prompts.py:272-273` 把卡 system_prompt 作为带标签属性并入 system prompt；ST 语义是替换 main 槽（受 prefer_character_prompt/forbid_overrides 开关控制）。内容保留但语义不同，属 palink-native 设计取舍，建议确认是否有意为之。

#### B-5【P2】creator_notes 进入提示词
`default_prompts.py:282-283` 将 creator_notes 注入 system prompt；ST 中它是纯 UI 字段不进 prompt。作者面向用户的注记文本会被模型看到。

#### B-6【P2】character_book 导入条目级保真缺口
- **insertion_order 丢失**：`character_import_service.py:680、745` 读 `entry.get("order", 0)`，而 V2 charbook 规范字段名是 `insertion_order`（ST world-info.js:5516 `order: entry.insertion_order`）→ 所有条目排序归 0；
- **extensions 子字段命名错位**：import_service.py:738-743 读 camelCase（caseSensitive/matchWholeWords），规范是 snake_case（world-info.js:5533-5534）；probability 规范位于 extensions 下而 Palink 读顶层（:5524 vs import_service 顶层读取）→ 静默回默认值；
- 默认 position=4(atDepth)，ST 无 position 时默认 before_char(0)（P3）。

#### B-7【P2→正面】alternate_greetings / depth_prompt / PHI 达标
first_mes 为空时提升首个 alt greeting 进 swipes（character_ext.py:4375-4381，B-7/R-6 有测试）；depth_prompt 进入统一 DepthInjection 队列（roleplay_prompt_assembly.py:4858-4917，sort_key="DEPTH_PROMPT" 对齐 ST constants.js L50）；PHI 作为 history 后 system 消息生效。

#### B-8【P3】其余小项
creation/modification_date 未持久化；更新路径 5 万字符硬校验抛错而导入不清洗（不对称，编辑保存可能 422）；卡文本 8MB 上限；V3 assets 仅存 JSON 不处理文件；`{{user}}/{{char}}` 宏为末端统一替换而非逐字段（结果覆盖面一致，时序差异 P3）。

### 3.2 字段覆盖矩阵（摘要）

| 字段 | 导入 | 落库 | palink-native 消费 | 备注 |
|---|---|---|---|---|
| name/description/personality/scenario/first_mes | ✅ | ✅ | ✅ | V1 别名兜底齐全 |
| mes_example | ✅ | ✅ | ⚠ 单条原文 | `<START>` 不拆块 |
| system_prompt | ✅ | ✅ | ⚠ 合并非 override | |
| post_history_instructions | ✅ | ✅ | ✅ | |
| jailbreak（独立） | ✅提取 | ✅ | ❌ 仅 st-compat 消费 | |
| alternate_greetings | ✅ | ✅ swipes | ✅ | |
| character_book | ✅ | ✅ WorldBook | ✅ | 条目级保真缺口 B-6 |
| extensions.depth_prompt | ✅ | ✅ | ✅ depth 队列 | |
| creator_notes | ✅ | ✅ | ⚠ 注入 prompt（ST 不注入） | |
| tags/creator/character_version | ✅ | ✅ | UI only | |
| assets(V3)/group_only_greetings/nickname | ✅ | ✅ | ❌/仅存/❌ | |
| creation/modification_date(V3) | ❌丢弃 | ❌ | ❌ | |

---

## 4. 模块 C：正则表达式功能

### 4.1 架构事实

项目内有 **5 套正则相关实现**：
1. `st-plugins/regex/engine.js`：ST 官方扩展原样拷贝（与 `.codex/st-source/regex-engine.js` 一致），仅作移植参照，**未被运行时加载**；
2. **后端引擎** `backend/app/api/character_ext.py:792-1731`：主力，对齐质量最高；
3. **前端主链路** `frontend/src/lib/sillytavern/regex/{engine,adapter}.ts` + `frontend/src/lib/regex-pipeline/pipeline.ts`；
4. `frontend/src/utils/regexEngine.ts`：早期实现（功能最接近 ST）却近乎闲置，仅剩 type import；
5. 智能卡沙箱内嵌 `SillyTavernCompatRuntime.ts:2273-2321`。

### 4.2 主要发现

#### C-1【P1】前端显示管线漏掉 ST 三分支判定 → 普通脚本在显示层重复应用
ST 权威语义（regex-engine.js:347-355）三分支：

```js
(script.markdownOnly && isMarkdown) ||
(script.promptOnly && isPrompt) ||
(!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
```

后端已完整复刻（character_ext.py:928-936 含 ephemeral 门控）；但前端 `pipeline.ts:248-249` 只有两个 only 分支：

```ts
if (script.markdownOnly && !options.isMarkdown) return true;
if (script.promptOnly && !options.isPrompt) return true;
```

普通脚本（两个 only 均 false）在 isMarkdown=true 的显示渲染中不会被跳过。而后端 persist_snapshot（websocket.py:627-634）已在入库时应用过普通脚本——**同一脚本对同一消息最多三重叠加**（后端 persist 入库 + 前端完成态渲染 + 前端下降沿钩子回写 CharacterChat.tsx:1510-1519），非幂等替换（追加/包标签类）会双重变形。

#### C-2【P1】智能卡运行时 `$N` 捕获组正则损坏
`SillyTavernCompatRuntime.ts:2296`：

```ts
return result.replace(/\\$(\\d+)|\\$<([^>]+)>/g, ...)
```

字面量写成 `\\$`（匹配"反斜杠+$"），正确写法应如 regexEngine.ts:299 `/\$(\d+)|\$<([^>]+)>/g`。沙箱内 replaceString 的 `$1`/`$<name>` 占位符不被替换、原样残留输出。

#### C-3【P2】空 placement 语义相反
后端已对齐 ST"空数组=不匹配任何位置"（character_ext.py:904-909）；前端 pipeline.ts:241-246 `if (script.placement.length > 0)` 才检查 → 空数组被视为匹配全部位置。

#### C-4【P2】深度豁免与 trimStrings 宏缺失（前端主链路）
- minDepth/maxDepth 缺 `-1/0` 边界豁免（pipeline.ts:251-254；regex-engine.js:362-372 及闲置版 regexEngine.ts:348-353 都正确）；
- trimStrings/filterString 不做宏替换，含 `{{user}}` 的 trim 串在前端失效（engine.ts:120-129；后端已对齐 character_ext.py:1125-1139）。

#### C-5【P2】ESCAPED 宏子集 + scoped 白名单默认放行
- substituteRegex=2（ESCAPED）时 ST 对全量宏替换结果整体转义（regex-engine.js:404）；后端仅处理 5 个名字宏（character_ext.py:1154-1160）；
- ST 强制角色卡内嵌正则须经 `character_allowed_regex` 白名单（engine.js:346 allowedOnly）；Palink 前后端白名单参数默认 None=放行（character_ext.py:1204）——恶意/破坏性卡内正则默认即生效（安全向）。

#### C-6【P2】流式期间不实时应用正则（设计权衡）
chunk 直接透传（websocket.py:988-994），前端流式 fallback 显式跳过 regex hooks（sillyTavernDisplayPipeline.ts:447-468 注释自述），结束后靠 final_content 广播 + isGenerating 下降沿钩子收敛。markdownOnly 状态栏卡片打字期间不逐步出现，结束时一次性成型——与 ST 每 token 重跑渲染时机不同，结果收敛。

#### C-7 正面确认
- placement 枚举 0/1/2/3/5/6 语义逐一对齐（含 WORLD_INFO=5、REASONING=6）；7/8/9 为 Palink 自有扩展位，ST 卡不会命中；
- `{{match}}`→`$0`、$N/$<name>、末尾 substituteParams 三步流程四处实现均复刻；
- GLOBAL(plugin+extension_settings) → SCOPED(char.extensions) → PRESET(preset_data) 三层顺序对齐 ST（character_ext.py:1615-1665）;
- prompt 层逐消息按 depth 应用（role→placement 映射 :1609-1613）；REASONING 层独立处理；
- alterChat：ST 1.18.0 引擎本就无此字段（双方源码 0 命中），Palink 以 persist 层改写入库文本等效实现，**不算缺陷**；
- 存储/API 高保真：RegexScriptCreateRequest 与 ST 导出 JSON 一一对应，批量导入 + 四处 CRUD 缓存失效齐全；仅缺导出端点与 legacy placement 4→3 迁移（P3）。

---

## 5. 模块 D：世界书（World Info / Lorebook）

### 5.1 架构事实

两套并行引擎：
- **后端引擎**（palink-native 主链路）：`worldbook_service.py` → `_append_worldbook_context` → DepthInjection 队列；
- **前端引擎**（插件兼容层）：`frontend/src/lib/worldbook/*`，且 `useCharacterChat.ts:1139-1153` 会把前端扫描结果拼进 user message 发送——与后端注入并行，存在双份风险（D-9）。

### 5.2 主要发现

#### D-1【P1】delay>0 条目永久沉默（状态机死锁）
`worldbook_service.py:191-195`：

```python
state = self.get_state(entry.id)
if not state:
    if entry.delay and entry.delay > 0:
        return False   # can_activate 永久拒绝
```

状态行唯一创建点是激活时的 `record_activation`（:220），而 delay 条目被 can_activate 永久拦截、永远到不了 record_activation → `update_after_message`(:258) 无行可递减 → delay 条目**整个会话生命周期不可激活**。ST 的 delay 是基于 chat_length 的绝对判定（开局 N 条内禁用，之后正常激活）。所有带 delay 的导入条目静默失效。

#### D-2【P1】`/api/worldbooks/import` 独立上传入口字段大量丢失
三条导入入口成熟度割裂：
- 角色卡 character_book 路径（character_import_service.py:693-767）：V3 extensions 子字段完整映射 ✅；
- ST 契约路径 `/api/worldinfo/import|edit`（silly_tavern.py:4480-4574）：最全（仅漏 useProbability）✅；
- **UI 直接上传 lorebook JSON 的 `/api/worldbooks/import`（worldbook.py:366-385）**：只映射 8 项，丢弃 order/enabled/selectiveLogic/sticky/cooldown/delay/depth/match×6/recursion 控制等十余个字段（模型列均有支撑却未填）。用户从 UI 导入 ST 世界书是高频操作。

#### D-3【P2】prevent_recursion 递归轮误跳整条目
`worldbook_service.py:723-731` 在 recursion_depth>0 时直接 skip prevent_recursion 条目；ST 中它只把条目内容排除出递归 buffer（world-info.js:4961），条目本身照常激活。文件内注释（:1029 Bug #E2）自己也写明正确语义，代码与注释矛盾。

#### D-4【P2】useProbability 开关全线缺失
模型无 `use_probability` 列（models/worldbook.py:55 仅 probability default=100）；worldinfo 契约导入不读 `entry.get("useProbability")`；扫描时 `prob < 100` 即掷骰（worldbook_service.py:898-914）。ST 语义：`!useProbability || probability===100` 免 roll，且 sticky 期间免重掷（world-info.js:4911-4920）。useProbability=false 且 probability<100 的卡在 Palink 必然出现"不该掷骰却在掷骰"的行为偏差。

#### D-5【P2】全局设置仅 3 项接线
`_append_worldbook_context` 只读 silly_tavern_settings 中的 min_activations×2 + character_strategy（:4494-4500）；`world_info_depth`（ST 默认 2，Palink 硬编码 DEFAULT_SCAN_DEPTH=4）、`world_info_recursive`（Palink 固定 True 总开递归，ST 默认 false）、`world_info_case_sensitive/match_whole_words/use_group_scoring/budget(_cap)` 均无后端读取。条目级 null 继承因此被 `or False` 吞掉退化为 False（:515）。

#### D-6【P2】百分比 token 预算基数失真
装配调用点不传 max_tokens → `_resolve_budget`(:1152) 回退 default_tokens=16000，"10%" 实际算 1600 而非当前模型 maxContext 的 10%（ST world-info.js:4624 按真实上下文算）。

#### D-7【P2】vectorized 向量检索整体不可达
字段链路完整（模型列/两种导入均映射），向量服务自身完备（worldbook_vector_service.py:87 sync / :188 query），但全库 grep 证实**零调用方**——没有任何 API 或扫描路径触发向量化；ST 的"向量命中→强制激活"无对应实现。功能声明存在但整体是孤岛。

#### D-8【P1·限前端层】scanner selectiveLogic 错位作用于 primary
`frontend/src/lib/worldbook/scanner.ts:177-189` 把 selectiveLogic 应用到 primary keys（NOT_ANY 分支在 primary 命中时恒返回 null = 条目永不激活）；副键匹配硬编码 ANY（:195-209）。ST 中 logic 只作用于 secondary（world-info.js:4827）。后端四态实现正确（worldbook_service.py:544-574），此问题仅影响前端插件兼容层与预览面板。

#### D-9【P2】前后端并行注入的结构性风险
SSE 路径下前端把自家扫描结果拼进 user message（useCharacterChat.ts:1139-1153），后端又对同一批 DB 世界书扫描注入，且拼接文本还会进入后端 haystack 参与二次关键词匹配。叠加前端引擎的 D-8/timed-effects 缺陷，同一条目可能双份或前后端判定不一致。（WS 路径未见拼接；实际触发频率取决于两引擎书籍集合重叠度。）

#### D-10 正面确认（高对齐部分）
- 关键词匹配：多词 key includes、单词 key `\W` 边界 + re.ASCII 复刻 JS 语义（修复中文 `\b` 问题）、`/pattern/flags` 正则 key、key 宏替换（:401-489）↔ world-info.js:340-366；
- selectiveLogic 四态短路求值正确（后端）；
- MIN_ACTIVATIONS advanceScan 扩深状态机（强制 max_depth=0 → 扩深 → RECURSION 回退）↔ world-info.js:4991-5005；
- sticky/cooldown 主链路（sticky 强制激活跳关键词、结束转 cooldown、SessionWorldBookEntryState 持久化对应 chat_metadata.timedWorldInfo）；
- position 8 档位枚举逐一对应（:88-95 ↔ world-info.js:855-864）；atDepth 已并入统一 DepthInjection 队列（depth↓→order↑→role→sort_key，2026-08-22 完成）；pos0-3 分离注入、EM/outlet 经宏注入；
- ignoreBudget 豁免 + overflow 裁剪对齐；
- 书籍分层 session→character→global 与插入策略三态对齐 getSortedEntries；
- ⚠️ 文档修正：docs/st_roleplay_alignment_report.md §2.6 "ST 为 1=AT_DEPTH、4=AFTER_PROMPT 枚举偏移"的结论**已被仓库内 ST 参照证伪**（两侧枚举一致），勿据此改造。

---

## 6. 模块 E：AI 提示词注入机制

### 6.1 宏系统（variable substitution）— 近乎完整覆盖

对照 ST `frontend/public/st/scripts/macros.js`（evaluateMacros preEnv/postEnv 清单 :622-673）逐宏核对 `backend/app/services/macro_service.py`：

| ST 宏 | Palink 状态 | 证据 |
|---|---|---|
| `{{char}}/{{user}}/{{description}}/{{persona}}/{{personality}}/{{scenario}}/{{mesExamples}}/{{first_mes}}/{{post_history_instructions}}` | ✅ | macro_service.py:420-502 |
| `{{setvar/getvar/addvar/getglobalvar/setglobalvar}}`（`::` 分参修正） | ✅ | :582-605、:169-174 |
| `{{roll}}/{{random}}/{{pick}}`（pick 确定性种子 chat_id_hash） | ✅ | :673/:796/:805 + roleplay_prompt_assembly.py:4229-4244 |
| `{{time/date/weekday/isotime/isodate/datetimeformat/time_UTC±n/idle_duration/timeDiff}}` | ✅ | :368-406/:578/:710/:726 |
| `{{banned "w"}}/{{reverse}}/{{outlet::name}}/{{format_message_variable::stat_data}}` | ✅ | :570/:705/:535/:547（TODOS.md 已更正"缺失"旧结论属实） |
| `{{newline/noop/trim/{{//注释}}/<USER>/<BOT>/<CHAR>/<GROUP>` | ✅ | :142-152/:356-364 |
| `{{input/lastMessage/lastMessageId/lastUserMessage/lastCharMessage/allChatRange/maxPrompt/maxContext/maxResponse/lastSwipeId/currentSwipeId/firstIncludedMessageId/firstDisplayedMessageId/lastGenerationType}}` | ✅ | :348-406 + roleplay_prompt_assembly.py:4181-4282 |
| `{{maxContext}} 语义` | ⚠ 近似 | = token_budget + effective_max_tokens（非模型真实 context_length；getContext.maxContext getter 反而是动态读的） |
| `{{storyStringPrefix/Suffix}}` | ⚠ 恒空串 | chat completion 模式不用 story_string，低优先级（:4249-4251） |
| `{{trim}}` 吞换行语义 | ✅ 按 ST `(?:\r?\n)*{{trim}}(?:\r?\n)*` | |

宏求值时机为装配末端统一遍历 + 最多 10 次迭代至稳定（roleplay_prompt_assembly.py:4149-4176、4284-4285），ST 为逐字段 substituteParams——最终覆盖面一致，仅时序差异（P3）。

### 6.2 模板格式与优先级

- **prompt_order 重排**：绑定 PromptPreset 时按 prompt_order 重排 messages 数组 + 低优先级源动态裁剪（roleplay_prompt_assembly.py:4288-4300、1100 起），角色卡字段可经 P1-1 抽取为独立 system 消息参与重排（:760-861）——对齐 ST Prompt Manager 行为；
- **裁剪优先级常量**：PHI=60 等（:902-987）；
- **instruct 模式**：模板加载 + 前后缀包装 + 示例对话跳过 + stop sequences（:125-290、:506-507）；`chat_completion_sources` 枚举对齐 openai.js 决定是否套 instruct（:340-392）；
- **context templates**：`backend/app/models/system.py:114-122` 有 story_string/chat_start/system_prompt 列，`api/context_templates.py` 提供 API；
- **系统提示优先级链**：system_prompt（main 槽）→ 世界书 pos0 → 角色描述/属性 → persona → AN（pos2/3）→ depth 队列（世界书 atDepth/AN/persona//inject/插件 IN_CHAT/卡 depth_prompt 六来源单管线，三级确定序 depth↓→order↑→role→key）→ PHI → jailbreak（仅 st-compat）。与 ST populationInjectionPrompts/getExtensionPrompt/doChatInject 的合成顺序一致（TODOS.md 2026-08-22 待办 3 已验证）；
- **IN_PROMPT 位置语义**：并入 messages[0]（system prompt 末尾）而非数组末尾——2026-08-19 二次定位修复，与 ST getPromptPosition(IN_PROMPT)='end' 语义一致。

### 6.3 差异点汇总
E-1【P3】mes_example 单条注入（同 B-2）；E-2【P2】独立 jailbreak 不消费（同 B-3）；E-3【P3】宏末端统一替换时序；E-4【P3】`{{maxContext}}` 近似值；E-5【P3】story_string 前后缀恒空。

---

## 7. 模块 F：AI 回复文本渲染系统

### 7.1 架构事实

双引擎并存：AI 完成态主链路用 showdown（`formatting.ts:580` 配置与 ST script.js:529-539 逐项一致：emoji/literalMidWordUnderscores/tables/underline/simpleLineBreaks/strikethrough/underscoreExt…）；流式与用户消息分支用 react-markdown v10（remark-gfm/math + rehype-katex/raw）。完成态经 `formatMessage` 全流程：正则→宏→fixMarkdown→六种引号 `<q>`→showdown→DOMPurify→CSS scoping，容器类名 `.mes_text` 对齐 ST。

### 7.2 主要发现

#### F-1【P1】LaTeX 渲染流式/完成态自相矛盾
流式期 MarkdownRenderer 挂 rehypeKatex 可渲染公式（MarkdownRenderer.tsx:28-29）；切到完成态 showdown 管线后 formatting.ts 全文件无 katex 处理，`protectMathBlocks` 只是保护 `$$` 不被 collapseNlines 破坏（:169），输出瞬间公式塌回 `$x^2$` 原文。ST 基线同样不带 katex（需扩展），但 Palink 自身的前后突变是明确体验缺陷。

#### F-2【P2】rehypeRaw 兜底分支未经 DOMPurify
`Message.tsx:1319` 最终兜底分支 `rehypePlugins={[...REHYPE_PLUGINS, rehypeRaw]}` 直通 ReactMarkdown 无消毒；触发条件窄（kind='markdown' 且无结构标签，而 object/embed 不在 isHtmlCardContent:183 的检测表），react-markdown URL 协议过滤兜底大部分场景，但 `<object data=...>` 理论可穿透。

#### F-3【P2】消毒策略严于 ST 的兼容性代价
主链路 FORBID form/iframe/object/embed + on* hook + class 前缀化 + `<style>` 物理外迁 body（formatting.ts:118-133、Message.tsx:218-264/875-903）；ST 允许 sanitizerOverrides 放行标签（script.js:1930）且 style 留在消息内。依赖 override 或从 `.mes_text` 读 innerHTML 的严格复刻型插件/角色卡会降级。完整 HTML 文档 + 脚本的产物路由 iframe sandbox（formatting.ts:1104-1106），架构级替代成立。

#### F-4【P2】流式中间态问题
未闭合 ``` 围栏保护已随分段器停用（Message.tsx:339-346 死代码），MarkdownRenderer 围栏正则要求闭合（:115）→ 未闭合期间后续全文被当代码块；streaming(react-markdown)→完成态(showdown+DOMPurify) 引擎切换伴随 CSS scoping 前缀与 katex 有无双突变。中断半成品永久固化按完成态渲染（P3，与 ST 同源）。

#### F-5【P2】ST media 附件体系缺失
ST 有 `extra.media` + appendMediaToMessage/GALLERY 展示（script.js:2400-2442）；Palink 消息级媒体只有 markdown 内联图 + content_json 多模态（image_url/input_audio）。用 ST media API 生成的图不会显示。

#### F-6 正面确认
- 六种引号包裹（半角/弯/«»/「」/『』/＂）与 ST script.js:1870-1896 逐一对应，历史编码损坏 bug 已修（formatting.ts:397-413）；
- em/q 主题色 CSS 对齐（index.css:997-1013 `.mes_text i/em/q`）；
- 名字前缀剥离 allowName2Display:false 对齐默认；
- reasoning `<details>` 折叠、`<summary>` 原生支持；
- emoji：showdown `emoji:true` 双方一致，无 twemoji；
- 表格/列表/引用块双引擎覆盖 + `.mes_text td/th` 样式齐备；
- 纯文本场景正确（PlainTextContent whitespace-pre-wrap；simpleLineBreaks 单换行→br 与 ST 一致；空串短路）；
- 代码块 hljs core 子集 23 语言（ST 全量 bundle 的子集，P3）；
- 状态栏/智能卡 iframe srcdoc+sandbox 方案为架构级替代（安全更优），MVU 占位符注入对齐 ST 卡片管线（Message.tsx:794-818）。

---

## 8. 模块 G：数据存储方式

### 8.1 对话历史

`CharacterChatMessage`（models/character.py:96-131）ST 字段全覆盖：`swipe_id/swipes/is_system/is_hidden/is_locked/name/mesid/extra`，外加 Palink 分支体系 `branch_id`（CharacterChatSessionBranch 树状分支，替代 ST 的聊天文件复制模型）与 `content_json`（OpenAI 多模态 content schema，NULL 回退 legacy content 列）。会话级 `chat_metadata` JSON 持久化 note_prompt/variables/timedWorldInfo 等（对应 ST chat_metadata）。

⚠️ **交叉标记（不深入验证）**：`extra` 列正是「思考/正文分离存储」工作的目标（content 内联 `<think>` + extra.reasoning 双写冗余），models/message.py:21-23 已出现 `[REASONING-SEPARATE]` 新注释，说明该 agent 的 Step 1 访问器已落地。本报告不对 reasoning 存储形态做进一步判断，避免干扰。

### 8.2 用户设置与偏好

`UserSetting`（models/system.py:16-72）：`silly_tavern_settings`（JSON text，承载 WI 设置/power_user 片段）、`power_user`、`ui_settings`、instruct 三件套、mvu secondary 两项、`silly_tavern_mode` 默认 palink-native（勿动，AGENTS.md 约束）。采样参数与 prompt_order 在 PromptPreset（prompts_data/ban_sequences/logit_bias/context_template_name）。ST 的 power_user 海量 UI 偏好并未全量建模，仅按需挑拣（P3 记录性差异）。

### 8.3 媒体与附件

- `/api/uploads/{user_id}/{filename}` 带 token 鉴权与用户目录隔离（main.py:361、chat_service.py:168 strict isolation）；背景图/表情包/模型文件均有独立 upload 端点（backgrounds.py/expressions.py/admin.py）；
- 图片生成落 `/api/uploads/generated-images/`（image_generation_service.py:288）；
- **缺口（同 F-5）**：无 ST `extra.media` 消息附件通道；头像以 base64 data URL 整图入库而非文件系统（导入大卡时 DB 体积敏感，P3）。

---

## 9. 模块 H：变量系统与角色面板集成（MVU）

### 9.1 链路完整性确认（自洽）

```
角色卡 tavern_helper(zod schema 文本)
  → extract_schema_defaults / build_initial_stat_data（mvu_engine.py:840/1041，含 InitVar 块解析）
  → 会话初始化 stat_data → chat_metadata.variables（websocket.py:504-513、729）
  → 模型输出 <UpdateVariable> 块 → MvuEngine.update_from_reply（JSON Patch 应用，readonly 路径守卫 :326-456）
  → persist：msg_extra["variables"] + sess.chat_metadata 双写（websocket.py:738-741）
  → 正文剥离 UpdateVariable 指令块（:754-755 strip_update_variable_blocks）
  → 前端 extra.variables/sessionVariables 兜底链（Message.tsx:718-719、1316）
  → 面板：<StatusPlaceHolderImpl/> 占位符 + 「状态栏」正则脚本（replaceString=完整<html>）→ iframe smart-card
     （Message.tsx:701-718、804-818；无正则时用 stat_data+schema 生成通用面板补位）
  → 变量热更新：palink:mvuVariablesUpdated 自定义事件驱动面板刷新（useCharacterChat.ts:404-409 等 4 处）
```

### 9.2 发现

- 【正面】占位符管线注释自述并经核实"完全对齐 ST——状态栏只有占位符+界面正则一条管线"；iframe sandbox 隔离为架构增强；
- 【正面】前端 mvuSchemaParser.ts 与后端 extract_schema_defaults 同源移植，schema 解析双端一致；
- 【正面】`{{format_message_variable::stat_data}}` 宏（macro_service.py:547）+ MVU user-tail 指令注入（roleplay_prompt_assembly.py:4101-4147）让模型每轮拿到当前面板状态；
- 【P2·关联 D-4】世界书 probability/useProbability 缺口同样影响"变量卡常用的高概率触发世界书条目"场景（跨模块引用，见 §5 D-4）；
- 【P2】插件侧变量支持：沙箱提供 variables Proxy + VARIABLE_SET/DELETED/ADDED 自造事件（ST 无对应事件名，插件若监听 ST 标准变量事件将收不到——ST 本身亦无常设变量事件，实害有限，P3 修正记录）；
- 【P3】ChatVariable/UserVariable 值统一 Text 存字符串，数值型变量比较需消费方自行转型（ST 变量同为弱类型，等价）。

---

## 10. 模块 I：副 AI 功能（低优先级）

- **架构现状**：副 AI 已改为**全手动模式**——persist 阶段不再自动调副模型（此前 90s 同步阻塞导致"生成完一直转圈"，websocket.py:733-737 注释留档）；由用户在助手消息上手动触发按钮 → `handleManualMvuSecondary`（CharacterChat.tsx:1238-1273）→ `POST /api/character-sessions/{id}/mvu-secondary` → 成功后 setSessionVariables + 事件广播刷新面板；
- **按钮可用性**：✅ 已接线（CharacterChat.tsx:1828 `onManualMvuSecondary={msg.role === 'assistant' ? handleManualMvuSecondary : undefined}`），含 mvuSecondaryRunning 防重入与四种失败原因的用户提示（未配置副模型/无 schema/无 patches/无变化）；
- **守卫**：`[MVU-SECONDARY-GUARD]` 无 schema 且无 stat_data 时完全不介入（websocket.py:504-513），通用适配所有变量卡；
- **逻辑完整性**：`run_secondary_mvu`（mvu_secondary.py:96）构造 系统指令+当前 stat_data+schema+剧情 的 prompt，temperature 0.2 解析 `<UpdateVariable>` 块，patches 走与主链路相同的 apply_patches；
- 结论：**无阻塞性兼容问题**；唯一提示是"重新生成 AI 变量"目前没有独立于消息重生成的批量刷新入口（P3，产品取舍）。

---

## 11. P1 问题清单（跨模块汇总，建议修复排序）

| # | 模块 | 问题 | 位置 | 影响 |
|---|------|------|------|------|
| 1 | D 世界书 | delay 条目永久沉默死锁 | worldbook_service.py:191-195 | 所有带 delay 的导入条目静默失效 |
| 2 | C 正则 | 前端显示管线漏三分支判定 → 普通脚本最多三重叠加 | pipeline.ts:248-249 + CharacterChat.tsx:1510-1519 + websocket.py:627 | 非幂等正则双重变形 |
| 3 | C 正则 | 智能卡运行时 `$N` 双反斜杠正则损坏 | SillyTavernCompatRuntime.ts:2296 | 沙箱内捕获组替换失效 |
| 4 | F 渲染 | LaTeX 流式可渲染/完成态塌回原文 | MarkdownRenderer.tsx:28-29 vs formatting.ts | 公式类输出体验断裂 |
| 5 | D 世界书 | /api/worldbooks/import 字段大量丢失 | worldbook.py:366-385 | UI 导入高级条目静默降级 |
| 6 | A 插件 | 经典轨 getContext 成员缩水 | sillyTavernPluginRuntime.ts:649-662 | 解构式插件经典轨必挂 |
| 7 | A 插件 | 沙箱内 triggerSlash 等 stub 能力倒挂 | sandbox.ts:3504-3622 | 酒馆助手脚本静默失效 |
| 8 | A 插件 | writeExtensionField 三轨三义 | getContext.ts:1690 / sandbox.ts:3243 / sandbox.ts:4465 | 同名 API 行为不一致 |
| 9 | D 世界书 | 前端 scanner selectiveLogic 错位 primary（限前端层） | scanner.ts:177-209 | NOT_ANY 条目前端永不激活 |

P2 批次（择要）：prevent_recursion 递归轮误跳、useProbability 全线缺失、全局 WI 设置 6 项未接线、预算百分比基数 16000、vectorized 孤岛、前后端世界书并行注入、正则空 placement 语义相反、深度豁免/trimStrings 宏缺失（前端）、ESCAPED 宏子集、scoped 白名单默认放行、mes_example 不拆块、jailbreak 不消费、system_prompt 合并语义、creator_notes 入 prompt、character_book insertion_order/extensions 命名错位、rehypeRaw 兜底无消毒、ST media 附件缺失、tokenizers/writeExtensionField 形状、registerFunctionTool 不消费、tavern_helper 绕沙箱 + M-3 多租户隔离。

---

## 12. 与「思考/正文分离存储」工作的交叉标记（不深入验证）

按工作要求仅标记，未做验证：
- models/message.py:21-23 已出现 `[REASONING-SEPARATE]` 注释与 `extra` 列新约定，说明分离存储 Step 1 访问器已在落地中；
- 本报告所有涉及 `extra.reasoning` / `<think>` 内联契约的观察（G-8.1、C-6 思维链正则层 REASONING placement）以该 agent 完工后的形态为准；
- 若分离存储改变 content 列形态，模块 C 的"persist 层正则改写入库文本"与模块 F 的"渲染层 think 剥离"消费点需要同步复核（其交接文档 HANDOFF_分离存储实施_2026-08-22.md 已列出前端 8 处消费点迁移表）。

## 13. 过时文档结论修正清单（防止后续 agent 照抄）

| 旧结论出处 | 修正 |
|---|---|
| docs/st_roleplay_alignment_report.md §2.6 "position 枚举偏移（1=AT_DEPTH）" | **已被仓库内 ST world-info.js:855-864 证伪**，两侧枚举一致 |
| PALINK_VS_SILLYTAVERN_COMPARISON.md "缺失 {{banned}}/{{reverse}}/{{roll}}" | 三者均已实现（macro_service.py L570/705/673），TODOS.md 2026-08-20 已更正 |
| 同报告 "renderExtensionTemplateAsync/tokenizers/jailbreak 缺失" | renderExtensionTemplateAsync 已实现（sandbox.ts:96-115）；tokenizers 有实现但形状错位（§2 A-5）；jailbreak 在 palink-native 有 PHI 等价物但独立字段仍不消费（B-3） |
| docs/st-compat-gap.md 关于 wi_format/预算差距 | 与当前代码大体相符，但 atDepth 部分已被 2026-08-22 DepthInjection 统一超越 |
| PLUGIN_ISSUES_REPORT P-1~P-11/S-9 | 本次逐一复核全部确认已修复（§2 A-8） |

---

## 附：证据索引（关键文件行号速查）

- 插件沙箱聚合 getContext：frontend/src/lib/plugin-system/sandbox.ts:3047-3067
- 经典轨 getContext 缩水对象：frontend/src/utils/sillyTavernPluginRuntime.ts:649-662
- 七参 setExtensionPrompt 对齐：frontend/src/lib/sillytavern/prompt-injection.ts:30-37 ↔ .codex/st-source/script.js:8899
- ST 事件权威清单：.codex/st-source/events.js:3-111
- 正则三分支 ST 原文：.codex/st-source/regex-engine.js:347-355；后端复刻 backend/app/api/character_ext.py:928-936
- 世界书 delay 拦截：backend/app/services/worldbook_service.py:191-195；record_activation 唯一创建点 :220
- ST world-info 参照：frontend/public/st/scripts/world-info.js（position :855-864、selectiveLogic :4827-4866、probability :4890-4958）
- 宏 evaluateMacros ST 参照：frontend/public/st/scripts/macros.js:610-715
- 宏环境装配：backend/app/services/roleplay_prompt_assembly.py:4150-4286
- DepthInjection 统一队列：backend/app/services/roleplay_prompt_assembly.py:81、4881-4917；builder 插入 character_message_builder.py:917-932
- 渲染 formatMessage：frontend/src/lib/sillytavern/display/formatting.ts:921 起；DOMPurify 配置 :118-133
- 消息模型：backend/app/models/character.py:96-131
- MVU 持久化：backend/app/api/websocket.py:725-755
- 副 AI 手动触发：frontend/src/components/views/character/CharacterChat.tsx:1234-1273、1828
