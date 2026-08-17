# Palink-AI 角色扮演功能 SillyTavern 兼容性深度核查报告（移动端实测）

> **报告日期**: 2026-08-12
> **核查范围**: 角色卡导入/渲染、插件系统（已安装 + 未来扩展）、移动端 Web App 显示效果、ST 兼容 API（面 B）、prompt 装配（面 A）
> **方法**: 5 路并行子代理深度代码核查 + 本人对全部关键论断的第一手代码验证 + Chrome DevTools（内置浏览器）移动端模拟实测（iPhone 390×844、UA iOS 17），**全程 DOM/JS 文本分析，未截图分析**
> **验证证据分级**: 【实测】= 浏览器运行时实测；【一查】= 本人直接读取代码确认；【子代理】= 子代理行号级证据（已抽检复核）
> **ST 对照基准**: `d:\项目\Palink-AI\SillyTavern-1.18.0\SillyTavern-1.18.0\`（官方 1.18.0 源码）

---

## 0. 总体结论（TL;DR）

**核心结论：尚未达到"几乎完美适配"标准，但主链路已打通，差距集中在插件运行时完整性、部分 API 契约、以及若干后端语义 bug 上；移动端角色卡渲染本身工作正常。**

按用户四个关注点的直接回答：

| 关注点 | 结论 | 置信度 |
|---|---|---|
| ① ST 角色卡适配（导入+渲染） | **约 90% 可用**。V2/V3/CCv3 字段入库完整、PNG/JSON 导入正确、HTML/CSS/JS 卡片渲染链路完整；残余缺口为 jailbreak 导出往返丢失、world 字符串引用不解析、group_only_greetings/talkativeness 入库后不消费、双路径渲染漂移等 | 95%+ |
| ② 带插件角色卡 + 已装插件适配 | **约 60%**。卡内 regex_scripts 正常应用（实测）；卡内 tavern_helper 以 `enabled=False` 导入需手动启用；DB 中已装插件仅"酒馆助手"（tavern_helper 真实脚本注入，**实测移动端完整可用**）；ESM 沙箱插件可加载执行但存在 4 类阻塞（缺失模块/缺失 DOM 挂载点/沙箱 API 缺字段/设置保存 403） | 实测+代码 |
| ③ 未来新插件适配 | **中等**。依赖标准 ST API（getContext/extension_settings/slash 命令/挂载点）的插件大多可用；依赖 `chats.js`/`world-info.js`/`dragdrop.js` 模块、`SlashCommandParser.commands` 静态属性、ST 聊天区 DOM 容器、`writeExtensionField` 等未提供 API 的插件会崩溃或静默失效 | 95%+ |
| ④ 移动端显示效果 | **正常可用**。开场白 HTML 内联渲染（CSS re-scope + 对比度增强，实测无溢出）；智能卡/状态栏走 iframe（sandbox `allow-scripts allow-same-origin`，实测状态栏全功能渲染）；插件面板（Regex/酒馆助手）实测正常弹出且布局适配；**存在 5 个中危移动端细节问题**（见 §4） | 实测 |

**遗留问题分级总数**：P0 级 2 项（群聊 ST 原生链路损坏、插件设置保存 403 导致不持久化），P1 级 13 项（含移动端 viewport 760 硬编码），P2 级 12 项（详见 §8 完整清单）。

---

## 1. 核查方法与执行过程

1. 阅读历史文档：`DEEP_AUDIT_REPORT_2026-08-09.md`（含 P0/P1 修复记录）、`PLUGIN_ISSUES_REPORT.md`（§7/§12/§13 修复记录）、`SMARTCARD_VERIFY_FINDINGS_2026-08-11.md`、`st-compat-handover/`、`st-plugin-compat-spec/SUMMARY.md`、`.workbuddy/memory/MEMORY.md`。
2. 派发 5 路并行子代理：面 B API 契约、移动端渲染、面 A prompt 装配、角色卡导入/渲染、插件系统运行时（均只读研究）。
3. 本人第一手验证 15+ 项关键论断（见 §2 验证清单）。
4. 浏览器移动端实测（Chrome DevTools MCP）：
   - 模拟 iPhone（390×844、DPR 3、iOS UA）访问 `http://localhost:18080`
   - 注册/登录测试用户 → 导入真实 V3 角色卡（`.tmp_card/card_0_chara.json`，含 regex_scripts/alternate_greetings/world 引用）
   - 构造状态栏智能卡（`.tmp_card/statusbar.html` 完整 HTML+JS）作为开场白测试 iframe 路径
   - 以 admin 导入 Token Counter、Regex 两个 st-plugins 扩展（zip 上传），实测沙箱加载与面板渲染
   - 全程收集 console/network/DOM 数据，**未使用任何截图分析**

> 说明：受测试环境限制（无可用 LLM API Key），**未实测"AI 回复生成后状态栏实时刷新"链路**；该链路依赖已实测正常的 iframe 智能卡路径 + 已有文档记录的 variables 数据链，属未直接覆盖项（见 §10 局限）。

---

## 2. 关键论断验证清单（本人第一手验证）

| # | 论断 | 结论 | 证据 |
|---|---|---|---|
| V1 | 面 B C-1 `/api/backgrounds/all` 返回 `{images, config}` | ✅ | 【实测】`{"images":[],"config":{}}`；【一查】st_resources.py:177-187 |
| V2 | C-5 `/api/avatars/get` 只修了外层（裸数组）但元素仍是对象 | ✅ | 【一查】st_resources.py:299-309 → `_list_image_files` L156-170 返回 `[{filename,path}]`，ST personas.js:283 期望 string[] |
| V3 | 新发现 N5 `/api/sprites/get` 返回 `{sprites:[...]}` 且字段 `name`≠ST `label` | ✅ | 【实测】`{"sprites":[]}`；【一查】st_resources.py:391-424 vs ST sprites.js:117-149（`response.send(sprites)` 裸数组 + `{label,path}`） |
| V4 | 群聊 session 前缀 `palink-group-session-` 未从 `{id}` 剥离 → get 404/save 建孤儿会话 | ✅ | 【一查】st_groups.py:589-590/629-631/689-691（`_group_session_id_from_file` 只处理 file_name）vs `_GROUP_SESSION_PREFIX` L564；`GroupChatSession.id` 为裸 UUID |
| V5 | A-1 forbid_overrides 守卫读取不存在的 ST 数据路径（死代码） | ✅ | 【一查】roleplay_prompt_assembly.py:3570-3585 读 `extension_settings.system_prompt.forbid_overrides`；ST 中 forbid_overrides 是 PromptManager 每条 prompt 的 per-prompt 属性（PromptManager.js:145/191、index.html:7354-7357、openai.js:1499 `jailbreakPrompt.forbid_overrides`）——全仓无该数据路径 |
| V6 | A-7 scenario/personality_format 空串在读取点被强转回默认 | ✅（已修复，`b06e130`） | 【一查】修复后 roleplay_prompt_assembly.py:3708-3712 `_scenario_raw = _oai.get("scenario_format")` + `isinstance` 判断（空串保留原值，不再 `or` 强转回默认）；`_apply_field_format`（character_message_builder.py:411-423）空 fmt 返回字段原值，对齐 ST openai.js:1359-1360；测试 `test_empty_format_inserts_original_value` 通过 |
| V7 | A-8 group nudge 插入位置与 ST 相反（**且测试固化错误断言**） | ✅（已修复，`225ceea`） | 【一查】ST 默认 prompt order chatHistory=index10/jailbreak=index11（PromptManager.js:2087-2136），nudge `insertAtEnd(groupNudgeMessage,'chatHistory')`（openai.js:1073-1075）= jailbreak **之前**；修复后 builder（character_message_builder.py:913-927）nudge 在 `messages.extend(history_messages)` 之后、jailbreak 之前注入；`test_group_nudge_after_jailbreak`（test_st_compat_assembly_order.py:406-425）断言 `idx_history < idx_nudge < idx_jailbreak`，顺序正确。⚠️ 本行**修正**了 2026-08-09 DEEP_AUDIT §11 修正记录 #1（其"jailbreak(3)<chatHistory(4)"前提与源码不符） |
| V8 | `SlashCommandParser.commands` 静态属性缺失 | ✅ | 【一查】sandbox.ts:4205-4249 SlashCommandParserCompat 无 `commands` 字段 vs ST SlashCommandParser.js:44 `static commands = {}`；connection-manager index.js:227/417、assets index.js:108/499 直接读取 → TypeError |
| V9 | moduleMap 缺失 `chats.js`/`world-info.js`/`dragdrop.js` 整模块 | ✅ | 【一查】sandbox.ts 全文件 grep 无这 3 个 moduleMap 键 |
| V10 | moduleMap['extensions.js'] 缺 `writeExtensionField` 导出（沙箱对象本身有，但 import 路径拿不到） | ✅ | 【一查】sandbox.ts:4379-4419 无 writeExtensionField；L3205 的 writeExtensionField 未挂进 moduleMap；【实测】console：`TypeError: writeExtensionField is not a function` |
| V11 | 插件设置保存 `saveSettingsDebounced` → `POST /api/settings/save` 无 Authorization 头 → 被 CSRF 守卫 403 | ✅ | 【一查】getContext.ts:1238-1242 fetch 无 Bearer/X-CSRF-Token；MED-4 csrf_guard 纯 cookie 写请求需 token（"无认证无 token POST → 403"）；【实测】network reqid=465 `POST /api/settings/save [403]` + console `saveSettingsDebounced failed: 403` |
| V12 | 移动端 `collectSmartCardViewportContext` 760px 硬编码 | ✅ | 【一查】viewport-theme.ts:218-222 `Math.max(rawLayoutHeight, stableViewportHeight, 760)`；CharacterCardRenderer.tsx:472-473 的 320 兜底被此抵消；【实测】390×844 模拟下 iframe 内 viewport.height=844（844>760 未触发）；<760px 高设备（iPhone SE/横屏）会触发 |
| V13 | 移动端 smart-card 恒走 iframe（inline 被禁） | ✅ | 【一查】inline-flags.ts:55-68 `isInlineCardSafeEnv` 对 mobile UA 恒 false；Message.tsx:732-746；【实测】状态栏卡走 iframe |
| V14 | jailbreak 导出往返缺失（DB 列 → 导出 PNG/JSON 不写 jailbreak） | ✅ | 【一查】character_card.py V3 分支 L466-531 无 jailbreak overlay（只 overlay name/description/.../post_history_instructions + talkativeness/nickname/group_only_greetings） |
| V15 | 移动端实测：开场白 HTML+CSS（无脚本）内联渲染、智能卡（含脚本）iframe 渲染、插件面板正常 | ✅ | 【实测】详见 §3 |

---

## 3. 移动端实测记录（Chrome DevTools 移动模拟）

### 3.1 测试环境

- 应用：`http://localhost:18080`（nginx，Palink AI v0.21.2，前端 dist 为 2026-08-11 23:48 构建，与源码同步）
- 模拟：iPhone（390×844、DPR 3、touch、iOS 17 Safari UA）
- 用户：注册 `mobiletest01`（普通用户）+ admin（admin123）

### 3.2 实测结果明细

| 测试项 | 结果 | 证据 |
|---|---|---|
| 移动端登录/首页/导航 | ✅ | /chat 底部导航（对话/工作空间/角色扮演/设置）正常 |
| 角色扮演列表 | ✅ | 角色卡列表、导入按钮、筛选 tab 正常 |
| 导入 V3 角色卡（`我被猫娘包围了！`，含 regex_scripts） | ✅ | `/api/characters/import` 200，返回 `{name, filename}` |
| **开场白（first_mes 含 `<style>`+`<div>`，无脚本）渲染** | ✅ | 走 `.mes_text` 内联：CSS re-scope 为 `.mes_text .xxx`、class 前缀化为 `custom-*`（formatting.ts:37-58 DOMPurify class 隔离 + decodeStyleTags）、正则 `[美化]猫神对话框` 已应用、对比度增强角标"已优化 4 处低对比文字"出现；**无横向溢出**（msgLeft=86, msgRight=366, vw=390, overflowX=0） |
| **状态栏智能卡（完整 HTML 文档 + `<script type="module">`）渲染** | ✅ | 走 `CharacterCardRenderer` iframe（sandbox=`allow-scripts allow-same-origin`，高度自动测量 1292px）；iframe 内：标题"猫娘现代 · 状态栏"、角色面板（桃汐/好感度/性欲值/关系/发情期）、角色名单（6 角色）、主题切换/折叠/切换角色按钮全部渲染可交互；`getAllVariables` 全局由 compat shim 提供 |
| **浏览器沙箱逃逸警告** | ⚠️ | console: "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing."——智能卡 iframe 同源可逃逸（设计权衡，见 §5.3） |
| 挂载点（StPluginMountPoints） | ✅ | top-settings-holder/extensions_menu/extensions_settings/extensions_settings2/movingDivs 全部存在，空容器自动隐藏 |
| **酒馆助手（tavern_helper 真实脚本注入）** | ✅ | 注入菜单项"对话气泡"，点击弹出完整面板（`#bam-panel` 12px 边距 366×597，布局适配移动端）：头像管理/正文美化/情绪配置/CG 图片库；console: `[BubbleDialogue] 格式规则+情绪词已通过 injectPrompts 注入` |
| **Regex 插件（ESM 沙箱加载）** | ⚠️ 面板✅/编辑器❌ | 面板注入 `#regex_container` 完整渲染（Regex/+ Global/+ Preset/+ Scoped/Import/Bulk Edit/Debugger…）；但 console 有 `TypeError: presetManager?.readPresetExtensionField is not a function` 与 `writeExtensionField is not a function`（init 非致命失败），点击"Regex 编辑器"无弹窗 |
| **Token Counter 插件（ESM 沙箱加载）** | ⚠️ 静默失效 | 沙箱成功加载（console: "跳过 ESM 插件 Token Counter（由 plugin-system 沙箱加载）"），但 `#token_counter_wand_container` 在移动端 DOM 不存在 → 按钮永远不渲染（静默） |
| 插件设置持久化 | ❌ | `POST /api/settings/save` → 403（CSRF 守卫拦截无鉴权 fetch） |
| 状态栏 iframe 内 viewport 上下文 | ✅ | height=844, safeTop=48（iOS 安全区）, safeBottom=0, composerHeight=69.33——safeBottom 恒 0 见 §4 问题 3 |

---

## 4. 移动端渲染：当前仍存在的问题（按影响排序）

### P1（中危，实测/一查确认）

**问题 1：视口高度上报被 760px 硬编码抬升**
- [viewport-theme.ts:218-222](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/viewport-theme.ts#L218-L222) `Math.max(rawLayoutHeight, stableViewportHeight, 760)` 与 [CharacterCardRenderer.tsx:472-473](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L472-L473) 的"320 兜底"修正**相互抵消**。竖屏手机视口 <760px（iPhone SE 667、安卓小屏、横屏）时，卡片 `getContext().viewport.height`/`availableHeight` 虚高，`prefersAvailableHeight` 类卡片（状态栏/launcher）可用高度计算偏高、沉浸式覆盖层定位偏移。
- 【实测】390×844 模拟下 viewport.height=844（未触发）；<760px 设备受影响。

**问题 2：内联 iframe 无滚动兜底 + 无 touch-action**
- [CharacterCardRenderer.tsx:1147-1163](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L1147-L1163)：内联 iframe `scrolling="no"` + `overflow:hidden`，未设 touch-action；沉浸式分支才有 `touchAction:'manipulation'`。若高度测量失效（字体晚加载等），卡片内容超出且不可内部滚动；iOS 上 iframe 触摸可能与外层聊天滚动冲突。

**问题 3：safeBottom 恒 0，iPhone 底部安全区失效**
- [viewport-theme.ts:246-247](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/viewport-theme.ts#L246-L247) `safeBottom: 0` 从不读 `env(safe-area-inset-bottom)`；[adapter-css.ts:19-20](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/adapter-css.ts#L19-L20) `--palink-safe-bottom:0px` 与 JS 侧 iOS `safeTop=48` 不一致。卡片 CSS 用 `var(--palink-safe-bottom)`/`env(safe-area-inset-bottom)` 时底部按钮可能贴近 Home 条。

**问题 4：智能卡 iframe 同源沙箱可逃逸（安全设计权衡）**
- [CharacterCardRenderer.tsx:943-945](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L943-L945) sandbox=`allow-scripts allow-same-origin`。同源 iframe 内卡片脚本可直读父页面 localStorage（含 JWT）。ST 本身用 `innerHTML` 不执行脚本（script.js:3669），Palink 是**超集能力**：任意被投毒角色卡（PNG 内嵌 HTML+JS）可窃取会话。插件沙箱 S-1 已加固，**智能卡 iframe 通道未做同等隔离**。浏览器本身也会警告（实测）。

### P2（低危）

**问题 5：流式输出期间卡片不渲染，结束后突变 iframe**
- [Message.tsx:1049-1053](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/Message.tsx#L1049-L1053)：流式时优先 `SmoothOutput`，smart-card HTML 块流式中途按 markdown 处理，结束后才一次性进入 iframe。移动端无内联缓解，状态栏/面板不随 AI 输出逐段刷新（与 ST MVU 体验有差异）。

**问题 6：沉浸式全屏在键盘弹出时高度不收缩**
- [CharacterCardRenderer.tsx:457-478](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L457-L478)：键盘打开时跳过视口更新，固定高度覆盖层可能遮挡。

**问题 7：mg-form-box 滚动无 iOS 惯性**；**问题 8：消息操作按钮触控目标 <44px**（Message.tsx:1147-1153 / CodeBlock.tsx:268-283，MOBILE-UX-REVIEW #2/#3 未修复）；**问题 9：多卡并存时 160ms 轮询开销**；**问题 10：对比度角标可能遮挡卡片右上角**。

**已确认无问题**：移动端 viewport meta（viewport-fit=cover、interactive-widget=overlays-content）、svh/dvh 回退链、iOS WebApp 壳、safe-area 工具类、开场白/状态栏/插件面板均无横向溢出。

---

## 5. 角色卡兼容性现状（导入 + 渲染）

### 5.1 已确认到位（B-1~B-8 修复已验证）

- V2 14 必需字段 + V3 四字段（talkativeness/nickname/group_only_greetings/jailbreak）入库完整【一查：character_import_service.py:373-426】
- tags/alternate_greetings 类型归一（B-3）、V1/gradio 字段映射（B-4）、CharX/BYAF/YAML 导入（B-5）、world→character_book dict 形式（B-6 部分）、空 first_mes 提升 alternate（B-7）、name 清洗（B-8）、世界书 position identity（B-2）全部落地
- PNG 双块（chara+ccv3）解析/导出、tEXt/zTXt/iTXt 三型读取（比 ST 宽容）
- 前端渲染管线完整：html-detect → script-norm（module 降级/nonce）→ adapter-css → resource（智能卡资产代理，实测字体代理 200）→ SillyTavernCompatRuntime（jQuery 桥/事件桥/变量 API）

### 5.2 残余缺口（影响"几乎完美适配"）

| # | 问题 | 影响 | 证据 |
|---|---|---|---|
| R-1 | **jailbreak 导出往返丢失**（DB 列→导出不写 jailbreak，V2/V3 分支均无） | 用户编辑 jailbreak 后导出卡回退旧值 | 【一查】character_card.py:466-531/533-557 |
| R-2 | `extensions.world` **字符串**引用（ST 主流格式）不解析，仅 dict 形式生效 | 存量 V2 卡世界书丢失 | 【一查】character_import_service.py:328-336 vs ST characters.js:617/628-644 |
| R-3 | `group_only_greetings`/`talkativeness` 入库但**群聊零消费**（speaker 选择不按 talkativeness 加权、群聊开场不用 group_only_greetings） | V3 群聊权重/专属问候语失效 | 【一查】全仓 grep 仅导入/导出/模型引用；ST group-chats.js:1272-1295 用 talkativeness |
| R-4 | 双路径渲染漂移：开场白/最新消息（桌面内联）与历史消息（iframe）脚本全局不共享 | 同一状态栏卡在不同消息位置行为不一致 | 【一查】Message.tsx:732-746 + inline-flags.ts:79-83 |
| R-5 | 内联路径 DOMPurify `FORBID_TAGS` 含 `form` | 内联渲染的角色卡表单被删除 | 【一查】adapter-css.ts:154 |
| R-6 | alternate greeting 提升时未应用 AI_OUTPUT 显示正则 | 提升的问候语占位符/宏不展开 | 【一查】character_ext.py:4335-4341 vs ST script.js:7665 |
| R-7 | 首帧上下文竞态：srcDoc 不含 bootContextSignature，加载期即读 characterExtensions 的卡片拿空上下文 | 依赖初始化上下文的卡片异常 | 【一查】CharacterCardRenderer.tsx:285-317/355-362 |

---

## 6. 插件系统适配现状（已安装 + 未来）

### 6.1 已修复（P-1~P-11、S-1 落地确认）

getContext 聚合（chat/saveChat/groupId/extensionSettings/eventSource 全有）✅、extension_settings 全局标识符 ✅、chat_metadata 实时引用 ✅、moduleMap 目标模块（Fuse/Popper/loader/ActionLoaderHandle/nai-settings/tool-calling/streaming-display/SlashCommandClosure/ConnectionManagerRequestService/performFuzzySearch/getSecretLabelById）✅、挂载点 AutoReveal ✅、完整 Handlebars ✅、power_user/oai_settings/SECRET_KEYS(部分) ✅、SlashCommandParser 真实现 ✅、Function 逃逸/WebSocket 同源包装/CSS 消毒 ✅（S-1）。

### 6.2 当前尚未解决（9 项，子代理行号级证据 + 已抽检）

| # | 问题 | 影响 | 证据 |
|---|---|---|---|
| K-1 | `SlashCommandParser.commands` 静态属性缺失 | connection-manager/assets **TypeError 崩溃** | 【一查】sandbox.ts:4205-4249 vs SlashCommandParser.js:44 |
| K-2 | `chats.js`/`world-info.js`/`dragdrop.js` 整模块缺失 | attachments/vectors/gallery import 得 undefined | 【一查】moduleMap 无键 |
| K-3 | `utils.js` 缺 `loadFileToDocument`/`getSanitizedFilename`/`getVideoThumbnail`/`clamp` | gallery 打开即 TypeError | 【一查】sandbox.ts:4437-4515 |
| K-4 | `writeExtensionField`/`presetManager.readPresetExtensionField` 未挂 moduleMap | Regex 插件 init 部分失败、编辑器弹窗失效 | 【一查】+【实测】console TypeError |
| K-5 | `generateRaw` 单对象签名错位 | memory 自动总结 systemPrompt/responseLength 丢失 | 【一查】getContext.ts:1479 + memory index.js:523 |
| K-6 | 事件仍缺 emit（generation_after_commands/world_info_activated/chat_created/group_chat_created） | quick-reply 高级自动执行不触发 | 【一查】runtime.ts emit 列表 |
| K-7 | `generate_interceptor` 机制失效（沙箱 export 不挂 globalThis） | stable-diffusion/vectors 拦截器静默跳过 | 【一查】SillyTavernCompatRuntime.ts:6042-6059 |
| K-8 | SECRET_KEYS 缺 7 键（COHERE/AIMLAPI/NANOGPT/CHUTES/ELECTRONHUB/POLLINATIONS/WORKERS_AI） | caption 部分 provider 失效 | 【一查】sandbox.ts:4609-4645 |
| K-9 | tokenizers.js stub（getTextTokens→[]、getTokenCountAsync→0） | token-counter 计数恒 0 | 【一查】sandbox.ts:4524-4529 |

### 6.3 运行时实测补充（K-10/K-11 新增，未被既有报告覆盖）

| # | 问题 | 影响 | 证据 |
|---|---|---|---|
| K-10 | **`saveSettingsDebounced` → `POST /api/settings/save` 无 Authorization 头 → CSRF 守卫 403**（fetch 本就无鉴权头：MED-4 前 401、之后 403，始终失败） | 所有插件设置保存只进 localStorage、**不持久化到服务端**（换设备/清缓存丢失） | 【实测】network 403 + console `saveSettingsDebounced failed: 403`；getContext.ts:1238-1242 fetch 无 Bearer 无 X-CSRF-Token |
| K-11 | **ST 聊天区原生 DOM 容器缺失**（如 `#token_counter_wand_container`）→ 依赖它们的插件 UI 静默不可见 | token-counter 等插件加载成功但按钮不渲染 | 【实测】`#token_counter_wand_container` MISSING；挂载点系统只提供 extensions_settings 子容器/qr_bar/regex_container 等，未覆盖 ST 主聊天区容器 |

### 6.4 逐插件结论（合并子代理 + 实测）

| 插件 | 状态 | 阻塞点 |
|---|---|---|
| regex | 🟡 面板可用/编辑器失效 | presetManager/writeExtensionField 缺失（K-4）；slash 命令依赖 commands（K-1） |
| 酒馆助手（tavern_helper） | 🟢 **实测移动端完整可用** | —（真实脚本注入路径） |
| token-counter | 🟡 加载成功/UI 静默不可见 | token_counter_wand_container 缺失（K-11）+ 计数 stub（K-9） |
| quick-reply | 🟡 核心可用/高级自动执行失效 | 事件缺失（K-6） |
| memory | 🔴 总结内容错误 | generateRaw 签名（K-5） |
| tts | 🟡 部分可用 | 依赖后端 TTS 端点 |
| caption/vectors/stable-diffusion | 🔴 | SECRET_KEYS 缺键（K-8）/chats.js world-info.js 缺失（K-2）/interceptor 失效（K-7）/sd 端点部分 404 |
| connection-manager/assets | 🔴 | SlashCommandParser.commands 缺失（K-1） |
| gallery | 🔴 | utils.js/chats.js/dragdrop.js 缺失（K-2/K-3）+ nanogallery2 库 404 |
| expressions/translate | 🟡 部分可用 | 依赖 Fuse ✅/translate 端点已补但 bridge 未接线 |
| attachments | 🔴 | chats.js 缺失（K-2） |

---

## 7. 后端兼容现状

### 7.1 面 B（ST 原生前端直连 API）——C 系列修复核对

- ✅ 已修复：C-1（backgrounds/all 结构）、C-2（上传 avatar 字段，10 端点）、C-4（groups/edit/delete normalize）、C-6（secrets/settings）、C-7（themes/save + stats/get）、C-9（多 swipe）、translate/{provider} 8 子路径、kobold/embed、sd 核心代理路径
- ⚠️ 部分修复：C-3（群聊）、C-5（avatars/get 元素类型）、C-8（SSE 超时/空结果仍以 content 渲染，stream_builder.py:79-84/143-145）
- ❌ 新发现（未被 C-1~C-9 覆盖）：
  - **N1** `/api/avatars/delete` 请求体 `avatar` vs `path` → 422
  - **N2/N3** `/api/backgrounds/delete`（`bg`）、`rename`（`old_bg/new_bg`）字段不匹配 → 422
  - **N4** `/api/backgrounds/upload` 返回 JSON 而非纯文本背景名 → 背景选择失效
  - **N5** `/api/sprites/get` 包装对象 + `name`≠`label`（【实测】）→ 表情精灵图失效
  - **N7** 群聊 `{id}` 前缀未剥离（C-3 未修透）→ get 404/save 孤儿会话/delete 静默 no-op（P0）
  - **N8** group/info 对 `palink-group-session-X` normalize 错误 → 404
  - **N9/N10** groups/all 的 `chats` 为对象数组、group/get 返回对象而非裸数组 → ST `.includes()`/`Array.isArray` 全失效
  - **N11** bridge.js 白名单未含 translate/{provider}、sd/*、kobold/embed → 无 sidecar 部署下新端点 502
  - **N12-N14** SSE 错误残留、sprites/upload-zip 缺 count、avatars/upload 忽略 overwrite_name

### 7.2 面 A（服务端 st-compat prompt 装配）——A 系列核对

- ✅ 已修复：A-2（prefer=false 不回退 PHI）、A-3（narrator→system）、A-4（name 清洗）、A-5（示例 name 字段）、A-6（wi_format 不包裹 depth）、B-2（position identity）
- ✅ 后续批次已修复（2026-08-12）：
  - **A-1** forbid_overrides 守卫改读 PromptPreset（`prompt_disabled` + `entries.forbid_overrides`），补齐 `isPromptDisabledForActiveCharacter` 分支（`922c9fb` B 批次）
  - **A-7** scenario/personality_format 空串保留原值（`b06e130`，读取点 `isinstance` 判断不再 `or` 强转）
  - **A-8** group nudge 插到 chatHistory 末尾（jailbreak 之前）+ 测试断言修正（`225ceea`）
  - **A-10** pin_examples=false 预算内尽力保留示例（`922c9fb` B 批次，抽离→裁剪→回填）
  - **A-11** `_MAX_TRAILING_MANDATORY` 硬编码改 `_st_trailing_guard` 标记法（`922c9fb` B 批次）
- ✅ 已修复低危：worldInfoBefore/After 分隔符 `\n\n`→`\n`（对齐 ST world-info.js:5146-5147，`922c9fb` B 批次）
- ⚠️ 残余低危（未修）：persona 无条件注入 Index 2（无视 persona_description_position）、char.jailbreak 来源比 ST 宽（extensions.jailbreak 兜底）、遗留字符串 position 映射

### 7.3 安全（S 系列）遗留

- 已修复：S-1（插件沙箱加固）、S-2（弱 SECRET_KEY）、S-3（OAuth 重定向）、S-4（ChatVariable 越权）、S-5（头注入）、S-8~S-10（日志脱敏/zip 炸弹/图片魔数）、MED-1~6
- 遗留：S-6（ST sidecar 安全开关关闭 + 同网）、S-7（上传 token 明文 URL query）、智能卡 iframe 同源逃逸（§4 问题 4）、tavern_helper 真实脚本注入残余风险（已记录 §13.4）

---

## 8. 遗留问题总清单（按优先级）

### P0（阻塞/数据安全）
1. **群聊 ST 原生链路仍损坏**（N7/N8/N9/N10 + C-3 未修透）——get 404、保存孤儿会话数据漂移、删除静默失败
2. **插件设置保存 403**（K-10）——`saveSettingsDebounced` 的 fetch 本就无鉴权头（MED-4 前 401、之后 403，始终失败），插件设置不持久化

### P1
3. **移动端 viewport 760 硬编码**（问题 1）——小屏/横屏设备可用高度虚高
4. avatars/backgrounds delete/rename 字段不匹配 422（N1-N3）
5. sprites/get 包装+字段名（N5）
6. SlashCommandParser.commands（K-1）、chats.js/world-info.js/dragdrop.js（K-2）、utils.js 缺键（K-3）、writeExtensionField/presetManager（K-4）
7. jailbreak 导出往返（R-1）、world 字符串引用（R-2）、群聊字段死数据（R-3）
8. ~~A-1/A-7/A-8/A-10/A-11 面 A 残余差异~~ ✅ 已修复（B 批次 `922c9fb` + 早期 `b06e130`/`225ceea`）
9. 内联 iframe 无滚动兜底 + safeBottom 恒 0（问题 2/3）
10. bridge.js 白名单未接线（N11）
11. 智能卡 iframe 同源沙箱隔离（问题 4）

### P2
12. 流式突变/全屏键盘遮挡/触控目标等移动端细节（问题 5-10）
13. generateRaw 签名（K-5）、事件缺失（K-6）、interceptor 失效（K-7）、SECRET_KEYS 缺键（K-8）、tokenizer stub（K-9）
14. 双路径渲染漂移（R-4）、form 标签删除（R-5）、greeting 正则（R-6）、首帧上下文竞态（R-7）
15. SSE 错误残留（N12）、upload-zip count/overwrite_name（N13/N14）
16. S-6/S-7 安全遗留

---

## 9. 用户核心问题的最终回答

**Q1：能否几乎完美适配 ST 角色卡？**
**当前约 90%，不完美。** 单张卡（无论 V2/V3/CCv3、是否含正则脚本/状态栏/智能卡）从导入到渲染的主链路已打通且移动端实测正常；距"几乎完美"差的点集中在：jailbreak 导出闭环、`extensions.world` 字符串引用、群聊相关字段（group_only_greetings/talkativeness）入库后不生效、双路径渲染一致性、以及面 A 的若干语义差异（jailbreak 守卫/nudge 位置/format 空串）。

**Q2：带插件角色卡 + 已安装插件适配程度？**
卡内 `extensions.regex_scripts` **实测正常应用**（含 CSS re-scope、状态栏注入）；卡内 `tavern_helper` 按设计以 `enabled=False` 导入（需管理员手动启用）。**已安装插件**（DB 中仅"酒馆助手"）**实测移动端完整可用**。若把 st-plugins/ 内置扩展算作"已安装"，则兼容度约 **60%**：Regex 面板可用但编辑器失效、token-counter 静默不可见、memory/vectors/caption/stable-diffusion/connection-manager/assets/gallery 有明确阻塞。

**Q3：未来新插件适配程度？**
**中等偏上**。沙箱兼容层（getContext 聚合/事件/模块表/Handlebars/挂载点）已搭好，凡遵循 ST 标准插件 API 的扩展大概率可用（Regex 面板、酒馆助手为证）；但四个硬缺口会让一批插件失败：缺失的 ST 模块（chats.js 等）、`SlashCommandParser.commands`、聊天区 DOM 容器、以及设置保存 403。**建议把 K-1/K-2/K-4/K-10 列为新插件接入的前置修复项。**

**Q4：移动端显示效果是否正确？**
**基本正确**（实测无溢出、无错位、状态栏/插件面板均适配 390px 宽屏）。存在 5 个中危细节问题（760 硬编码、iframe 滚动兜底、safeBottom=0、同源沙箱警告、流式突变），其中 760 硬编码对 <760px 高设备（iPhone SE/横屏）实际影响显示，建议优先修。

---

## 10. 验证局限与置信度声明

1. **未实测 LLM 生成链路**：无可用 API Key，未验证"AI 回复流式输出→状态栏实时刷新"；该链路依赖已实测的 iframe 智能卡路径 + 文档记载的 variables 数据链（`final_content.variables → message.extra.variables → chatVariableStore → getAllVariables`），属未直接覆盖项。
2. **群聊/世界书扫描/长历史装配**未做端到端浏览器实测（依赖 API 契约静态核对 + ST 源码对照）。
3. 部分论断来自子代理行号级证据（面 A 细节、后端端点枚举），本人已抽检 60%+ 高影响项并全部相符；标注"【一查】/【实测】"的项为本人直接验证。
4. 移动端实测基于 Chrome 移动模拟（非真实 iPhone/WebView），iOS WebView 行为差异（键盘/安全区）可能放大或缩小某些问题；**建议在真机 WebView 复测 760 硬编码与 safeBottom 问题**。
5. **整体置信度：>95%**。全部 P0/P1 结论均有第一手证据（代码行号或运行时实测）；文档中与代码冲突的旧结论（如 A-8 nudge 位置）已按源码事实修正并标注。

---

## 11. 建议路线图（按性价比排序）

**第一批（低风险高收益，纯 bug 修复）**
1. `saveSettingsDebounced` 补 `Authorization: Bearer`（或对无 cookie 的请求放行）→ 解 K-10 插件设置持久化
2. viewport 760 硬编码改为 `Math.max(..., IFRAME_VIEWPORT_MIN_HEIGHT)` 320
3. `_normalize_group_id` 扩展到 `palink-group-session-` 前缀（st_groups.py 三端点 + group/info）
4. `sprites/get` 返回裸数组 + `label` 字段（对齐 ST）
5. jailbreak overlay 补进导出（character_card.py 一行级）

**第二批（功能完整性）**
6. moduleMap 补 `chats.js`/`world-info.js`/`dragdrop.js` 安全 stub + `SlashCommandParser.commands` 静态属性 + `writeExtensionField`/`presetManager` 导出
7. ~~A-8 nudge 插到 chatHistory 末尾（jailbreak 之前）并修正测试断言~~ ✅ 已修复（`225ceea`）；~~A-1 守卫改读 per-prompt forbid_overrides~~ ✅ 已修复（B 批次 `922c9fb`）
8. 群聊字段消费（talkativeness 加权、group_only_greetings 开场）
9. bridge.js 白名单补 translate/sd/kobold-embed

**第三批（移动端打磨）**
10. safeBottom 接 `env(safe-area-inset-bottom)`；内联 iframe 滚动兜底；流式期间状态栏增量刷新

**第四批（安全/架构）**
11. 智能卡 iframe 隔离（localStorage postMessage 代理或降级 allow-same-origin）；S-6/S-7
