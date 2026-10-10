# 简单到中级问题修复 Spec（2026-08-12）

> 范围：不影响现有功能与 UI 的问题和 bug。每项含：目的/预期效果、实现方式、注意事项、修复风险、验证方法。
> 证据分级：【实测】=浏览器运行时、【一查】=本人直接读码、【ST】=ST 1.18.0 源码对照。
> 前置调研报告：[MOBILE_ST_COMPAT_VERIFY_2026-08-12.md](./MOBILE_ST_COMPAT_VERIFY_2026-08-12.md)

---

## 总体原则（所有修复项共同遵守）

1. **只改 bug**，不重构、不清理无关代码；改动保持在最小范围。
2. **不动 UI**：所有前端改动只涉及请求鉴权、契约形状、沙箱导出，不触碰任何组件样式与布局。
3. **向后兼容**：后端请求体/响应形状变化均做「双字段兼容」或「原形状保留」，避免破坏既有调用方。
4. 每批修改后验证（见各项验证方法），前端 `npx tsc --noEmit` + `npm run build`（dist 挂载自动同步）；后端 `pytest` + `docker compose build backend && docker compose up -d backend` 重建容器。
5. **记忆文档警告**：`SillyTavernCompatRuntime.ts` 模板字符串内禁用含转义反斜杠的正则字面量，用 `new RegExp`。
6. 修改 sandbox.ts 后必须通过 `npx tsc --noEmit` 与 `npm run build`。

---

## A 组：简单修复（契约/鉴权/导出缺口，无行为语义变化）

### F1. 插件设置保存 403（K-10，P0）

- **目的**：修复 `saveSettingsDebounced()` 被 CSRF 守卫拦截（403），插件设置（Regex、酒馆助手等）无法持久化。
- **现状证据**：【一查】[getContext.ts](file:///d:/项目/Palink-AI/frontend/src/lib/sillytavern/getContext.ts#L1226-L1250) 裸 `fetch('/api/settings/save')` 无 `Authorization` 头；MED-4 引入的 CSRF 守卫要求纯 cookie 写请求带 `X-CSRF-Token`，带 Authorization 放行。【实测】`POST /api/settings/save` 返回 403。
- **实现**：getContext.ts 已 import `api`（L34，来自 `@/services/api`，其 `post` 自动注入 `Authorization: Bearer <palink_token>`，见 services/api.ts L110-114）。将 L1238-1242 的裸 fetch 替换为 `await api.post('/api/settings/save', {})`（保留 try/catch 与失败仅 warn 语义）。若担心 `api.post` 对空 body 的处理，也可手动加头：
  ```ts
  const token = localStorage.getItem('palink_token');
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  ```
  优先用 `api.post`（与项目其它请求一致，自动带 token）。
- **注意事项**：`saveExtensionSettingsDebounced(delay)`（Phase 1，localStorage 持久化）保持不变；不要改动防抖逻辑与失败静默语义。
- **修复风险**：低。仅补鉴权头，无行为变化；即使 token 缺失，行为退化到与现状一致（403 + warn）。
- **验证**：浏览器加载任一插件，改一项设置触发 `saveSettingsDebounced()`，Network 面板 `/api/settings/save` 状态 200；刷新页面设置保留。

### F2. viewport 高度硬编码 760（移动端小屏适配）

- **目的**：智能卡状态栏在窗口高度 <760 或移动端时不再把视口撑到 760px（底部被裁剪）。
- **现状证据**：【一查】[viewport-theme.ts](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/viewport-theme.ts#L218-L222) `Math.max(rawLayoutHeight, …, 760)`；同目录 [shared.ts](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/smart-card-runtime/shared.ts#L18) 已有 `IFRAME_VIEWPORT_MIN_HEIGHT = 320`，且 [CharacterCardRenderer.tsx](file:///d:/项目/Palink-AI/frontend/src/components/ui/custom/CharacterCardRenderer.tsx#L472) 已用 320 兜底——viewport-theme.ts 是遗留未同步处。
- **实现**：将 `760` 改为导入的 `IFRAME_VIEWPORT_MIN_HEIGHT`（若该常量可从此文件/同目录导入；否则字面量 320）。SSR 分支 L197 的 `height: 760` 同步改为 320。
- **注意事项**：只改兜底最小值；`stableViewportHeight` 的其它语义（visualViewport 优先）不动。
- **修复风险**：低。桌面端正常高度远大于 320，行为不变；仅小屏受益。
- **验证**：DevTools 移动端模拟（如 iPhone 390×844）渲染智能卡，视口高度不再为 760。

### F3. 资源端点请求体双字段兼容（N1/N2/N3）

- **目的**：让 ST 原生前端/插件的删除、重命名操作不再 422。ST 1.18.0 实际发送字段与 Palink 期望不一致：
  | 端点 | Palink 期望 | ST 实际发送 | 证据 |
  |---|---|---|---|
  | `POST /api/backgrounds/rename` | `old_path/new_path` | `old_bg/new_bg` | [ST backgrounds.js:511](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/backgrounds.js#L511) |
  | `POST /api/backgrounds/delete` | `path` | `bg` | [ST backgrounds.js:1453-1454](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/backgrounds.js#L1453-L1454) |
  | `POST /api/avatars/delete` | `path` | `avatar` | [ST personas.js:1173-1174](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/personas.js#L1173-L1174) |
- **实现**：[st_resources.py](file:///d:/项目/Palink-AI/backend/app/api/st_resources.py)：
  - `BackgroundRenameRequest`（L246-248）加可选 `old_bg: str | None = None` / `new_bg: str | None = None`；handler 内 `old = req.old_path or req.old_bg`、`new = req.new_path or req.new_bg`，两者任一为空则 400。
  - `BackgroundDeleteRequest`（L272-273）加 `bg: str | None = None`；`target = req.path or req.bg`。
  - `AvatarDeleteRequest`（L356-357）加 `avatar: str | None = None`；`target = req.path or req.avatar`。
- **注意事项**：Pydantic 可选字段不影响旧字段；空值统一 400（避免误删）。路径穿越校验 `_resolve_within_data` 保持不变。
- **修复风险**：低。纯新增兼容分支。
- **验证**：pytest（补 3 个用例：ST 字段名删除/重命名成功）+ curl 模拟 ST 请求体。

### F4. avatars/upload 支持 overwrite_name 覆盖（N13）

- **目的**：ST personas 覆盖上传（改名/裁切后覆盖同名头像）时按指定名覆盖，而不是追加随机后缀。
- **现状证据**：【ST】avatars.js:41-60 —— `request.body.overwrite_name` 作为最终文件名；【一查】[st_resources.py](file:///d:/项目/Palink-AI/backend/app/api/st_resources.py#L312-L341) 不接收 `overwrite_name`，冲突时追加随机串。
- **实现**：`st_avatars_upload` 增加 `overwrite_name: str | None = Form(None)`；若提供且非空，用 `os.path.basename(overwrite_name)` 作为文件名（保留其扩展名；若 `overwrite_name` 无扩展名则用 `_resolve_extension` 结果），并**覆盖**已存在文件（跳过「冲突追加随机串」分支）。未提供时保持现状逻辑。
- **注意事项**：`overwrite_name` 需做 `os.path.basename` 防路径穿越，并校验最终扩展名在白名单内；不要影响 Palink 前端现有上传（其发 `file` 字段、无 overwrite_name）。
- **修复风险**：中低。覆盖写为 ST 语义，风险点是防穿越校验，已在实现内处理。
- **验证**：curl 带 `overwrite_name` 上传两次同名 → 文件数不增、内容更新；pytest 用例。

### F5. avatars/get 返回 string[]（C-5 修透）

- **目的**：ST personas.js 用 `Array.isArray` 判定，返回的元素应为字符串（文件名），当前返回对象数组 → 人设列表渲染为空/异常。
- **现状证据**：【ST】personas.js:281-289 `Array.isArray(allEntities)` 后按字符串处理；ST avatars.js:17-19 返回 `getImages()`（字符串数组）。【一查】[st_resources.py](file:///d:/项目/Palink-AI/backend/app/api/st_resources.py#L299-L309) 虽注释"返回 string[]"但实际 `return avatars`（`_list_image_files` 返回 `[{filename,path}]`）。
- **实现**：`st_avatars_get` 将 `_list_image_files` 结果映射为字符串数组：`return [f"avatars/{item['filename']}" for item in avatars]`（与 ST 的 `avatars/xxx.png` 相对路径格式一致，含子路径前缀）。
- **注意事项**：已确认 Palink 前端无此端点调用方（grep 无命中），形状变化无内部影响；`backend/tests/test_st_contract.py` 若有断言需同步更新。
- **修复风险**：中低。返回形状从「对象数组」变「字符串数组」——仅 ST 侧消费者，且是正确方向。
- **验证**：pytest + ST 前端人设列表正常显示头像。

### F6. sprites/get 返回裸数组 + label（N5）

- **目的**：ST expressions 插件 `getSpritesList` 直接 `result.json()` 并 reduce 出 `sprite.label`/`sprite.path`，当前返回 `{"sprites":[{name,path}]}` → 表情面板空。
- **现状证据**：【ST】sprites.js:118-150 返回裸数组 `[{label, path}]`，path 为 `/characters/{name}/{file}`；expressions/index.js:1295-1300 直接消费。【一查】[st_resources.py](file:///d:/项目/Palink-AI/backend/app/api/st_resources.py#L391-L424) 返回 `{"sprites": [...]}` 且字段为 `name`。
- **实现**：`st_sprites_get` 改为返回裸数组 `[{label, path}]`：`label` 用现有 `name` 逻辑；`path` 改为可被前端直接加载的 URL（对齐 Palink 静态资源服务格式——实现时确认 Palink 如何提供 `data/characters/{name}/sprites/...` 图片，复用现有字符立绘/资产 URL 生成方式；若无现成服务则保持 `_to_rel_data` 相对路径并标注）。
- **注意事项**：这是形状+字段双变化，属于 ST 契约对齐；无 Palink 前端调用方（已确认）。需同步检查后端 assets 相关静态服务是否已覆盖 sprites 目录。
- **修复风险**：中。返回形状变化 + path 格式依赖静态资源可达性；若静态资源不可达，面板仍空但不报错——实现时优先复用已有可用的图片 URL 模式。
- **验证**：ST expressions 插件表情面板列出立绘、缩略图可加载。

### F7. 角色卡导出补 jailbreak 覆盖（R-1）

- **目的**：V3 卡导出时 `jailbreak` 字段丢失（保留的是原始卡值而非编辑后值）。
- **现状证据**：【一查】[character_card.py](file:///d:/项目/Palink-AI/backend/app/character_card.py#L466-L476) `_overlay_field` 覆盖了 name/…/post_history_instructions 但**漏了 `jailbreak`**；Character 模型已有 `jailbreak` 字段（models/character.py:42）。
- **实现**：在 L476 后追加一行 `_overlay_field("jailbreak", character.jailbreak)`。
- **注意事项**：仅导出路径；不影响导入与渲染。V2 分支（非 v3）无需处理（字段天然透传）。
- **修复风险**：低。一行级。
- **验证**：编辑角色 jailbreak → 导出 JSON → `data.jailbreak` 为新值；pytest 用例。

### F8. bridge.js 补 `/api/translate/` 动态前缀（N11 修正版）

- **目的**：ST translate 插件调用 `/api/translate/{provider}`（onering/libre/google/lingva/deepl/deeplx/bing/yandex），当前 bridge.js 只有精确匹配 `/api/translate` → 该系列请求被代理到 ST sidecar（或 404），绕过了 Palink 已实现的 LLM 翻译。
- **现状证据**：【一查】[bridge.js](file:///d:/项目/Palink-AI/frontend/public/st/bridge.js#L29-L172) `REAL_API_PATHS` 无 `/api/translate/` 前缀，`REAL_API_PREFIXES`（L169-172）无它；Palink 后端已实现 `/api/translate/{provider}`（silly_tavern.py:7824-7844，provider 白名单一致）。
- **实现**：在 `REAL_API_PREFIXES` 追加 `/api/translate/`。
- **重要修正**：**不要**把 `/api/sd/*`、`/api/kobold/*` 加入白名单——Palink 后端未实现这些端点（已 grep 确认只有 `/api/translate/{provider}` 与 `/api/backends/kobold/embed`），加入反而会把原本可用的 sidecar 代理变成 404。ST stable-diffusion 插件的 `/api/sd/*`、`/api/image/*` 保持代理到 sidecar。
- **注意事项**：与 `backend/tests/test_st_contract.py` 的 ST_ENDPOINTS 保持同步。
- **修复风险**：低。仅把已实现端点的路由收归 Palink。
- **验证**：加载 translate 插件，调用翻译 → Network 请求打到 Palink 并返回译文文本。

### F9. SlashCommandParser.commands 静态属性（K-1）

- **目的**：修复 connection-manager / assets 插件 `SlashCommandParser.commands[xxx].callback(...)` 的 TypeError 崩溃。
- **现状证据**：【一查】sandbox.ts:4205-4249 `SlashCommandParserCompat` 无 `commands`；【ST】SlashCommandParser.js:44 `static commands = {}`，addCommandObjectUnsafe（L78-102）写 `commands[name]` 与 `commands[alias]`；使用方 connection-manager/index.js:227/417、assets/index.js:108/499 直接索引。
- **实现**：sandbox.ts `SlashCommandParserCompat`：
  - 加 `static commands: Record<string, any> = {};`（或用 getter 委托 `registeredSlashCommands`）；
  - `addCommandObject`/`addCommand` 成功注册后同步 `SlashCommandParserCompat.commands[command.name] = command; aliases.forEach(a => commands[a] = command)`；
  - `removeCommand` 同步删除 name 与 aliases。
- **注意事项**：`registeredSlashCommands` 已是 Map（L4138），若用 getter 需保证返回对象形如 ST（name→command），供 `Object.keys`/`commands[key].name` 使用；不要破坏现有 `getCommand/getAllCommands`。
- **修复风险**：低。纯新增导出。
- **验证**：加载 connection-manager 插件不再抛 TypeError；`SlashCommandParser.commands['regex']` 可访问；`npx tsc --noEmit`。

### F10. moduleMap 补 writeExtensionField + presetManager 接口（K-4）

- **目的**：修复 regex 插件 init 报 `writeExtensionField is not a function` 与 `presetManager?.readPresetExtensionField is not a function`，恢复 Regex 编辑器/Scoped 脚本保存。
- **现状证据**：
  - 【ST】extensions.js:2061-2111 `writeExtensionField(characterId, key, value)` 内部 `setValueByPath` 改 `data.extensions.{key}` 后 `POST /api/characters/merge-attributes`（body `{avatar, data:{extensions:{[key]:value}}}`）；Palink bridge 白名单已有 `/api/characters/merge-attributes`（后端已实现）。
  - 【ST】preset-manager.js:846 `readPresetExtensionField({name, path})`、:876 `writePresetExtensionField({name, path, value})`；regex/index.js:1680-1685 调 `getPresetManager(apiId).readPresetExtensionField({path:'regex_scripts'})`。
  - 【一查】sandbox.ts moduleMap['extensions.js']（L4379-4419）无 `writeExtensionField`；moduleMap['preset-manager.js']（L4594-4601）仅 getPresets/selectPreset/getPreset。
- **实现**：
  - moduleMap['extensions.js'] 追加：
    ```ts
    writeExtensionField: async (characterId, key, value) => {
      // 经后端 merge-attributes 持久化角色卡 extensions（对齐 ST 语义）
      // characterId → context.characters[characterId].avatar；UNSET 语义可选支持
    },
    ```
    实现时复用 sandbox 内已有的角色卡访问方式（如 `context.characters`），发送 `POST /api/characters/merge-attributes`。
  - moduleMap['preset-manager.js'] 的 `getPresetManager` 返回值补：`getSelectedPresetName: () => ''`、`readPresetExtensionField: () => null`、`writePresetExtensionField: async () => {}`（安全兜底，不崩溃；regex 面板可渲染，preset 读写因无 ST 预设数据归 no-op）。
- **注意事项**：`merge-attributes` 需 CSRF/Auth 头——用 sandbox 内现有 fetch 包装或注入 token 的方式（实现时确认 sandbox 的 fetch 是否已带鉴权；若没有，手动加 Bearer 头）。writeExtensionField 语义是**角色卡**字段而非全局扩展设置，勿误接到 `writeExtensionSettingsField`。
- **修复风险**：中低。新增导出不影响既有路径；若 merge-attributes 调用失败仅 warn。
- **验证**：regex 插件 init 无 TypeError；Regex 编辑器弹窗可用；Scoped 脚本保存后重新加载仍存在；`npx tsc --noEmit`。

### F11. tokenizers.js stub 委托真实实现（K-9）

- **目的**：修复 token-counter / memory 插件的 token 计数恒 0 / 空数组。
- **现状证据**：【一查】sandbox.ts:4524-4529 stub 返回 `[]`/`0`；getContext 已有真实 `getTokenCountAsync`（L1734，调后端 `/api/tokenizers/count`）与 `getTextTokens`（L2139）。
- **实现**：sandbox.ts tokenizers.js stub 改为委托：
  ```ts
  getTextTokens: (text, tokenizer) => sandbox.getContext?.().getTextTokens?.(text, tokenizer) ?? [],
  getTokenCountAsync: async (text, tokenizer) => sandbox.getContext?.().getTokenCountAsync?.(text, tokenizer) ?? 0,
  ```
- **注意事项**：保持 `tokenizers` 枚举与 `getFriendlyTokenizerName` 现状；委托失败静默回退。
- **修复风险**：低。
- **验证**：token-counter 面板计数非 0；memory 插件上下文 token 估算正常。

---

## B 组：中级修复（影响 prompt 输出，属 ST 语义对齐；实现前请确认）

### F12. scenario/personality_format 与 group_nudge_prompt 空串失效（A-7）

- **目的**：用户显式把 scenario_format/personality_format 设为空（表示不用该字段）、或把 group_nudge_prompt 清空（禁用群聊 nudge）时，当前被 `or` 强转回默认值 → 设置无效。
- **现状证据**：【一查】[roleplay_prompt_assembly.py](file:///d:/项目/Palink-AI/backend/app/services/roleplay_prompt_assembly.py#L3611-L3614) `_oai.get("scenario_format", "{{scenario}}") or "{{scenario}}"` 等三处。
- **实现**：改为「键存在且为 str 时取值，否则默认」：
  ```python
  _scenario_raw = _oai.get("scenario_format")
  _scenario_format = _scenario_raw if isinstance(_scenario_raw, str) else "{{scenario}}"
  ```
  同理 `_personality_format`、`_group_nudge`（`_group_nudge` 取 `_oai.get("group_nudge_prompt")`，str 时原样，非 str/缺失用默认）。
- **注意事项**：下游 builder 对空 scenario/personality 已能正确跳过（现有 `if _scenario_format` 类判断，实现时确认）；空 group_nudge 在 builder L945 已不注入。需跑 st-compat 相关 pytest，避免破坏现有断言。
- **修复风险**：中。影响 prompt 装配（但为正确语义）；改动仅限空串边缘情况，非空值行为不变。
- **验证**：pytest（新增：空串场景断言不注入 scenario/nudge）+ 浏览器实测。

### F13. 群聊 nudge 注入位置（A-8）

- **目的**：ST 中 `insertAtEnd(groupNudgeMessage,'chatHistory')` 使 nudge 位于 chatHistory 之后、jailbreak（索引 11）之前；Palink 当前把 nudge 追加到 messages 最末（IN_PROMPT extension_prompts 之后）→ prompt 顺序与 ST 不一致。
- **现状证据**：【ST】openai.js:883-894（nudge 注入 chatHistory 末尾）；PromptManager.js:2087-2136（chatHistory=index 10 < jailbreak=index 11）。【一查】[character_message_builder.py](file:///d:/项目/Palink-AI/backend/app/services/character_message_builder.py#L943-L950) nudge 在 L941 IN_PROMPT ep 之后追加；测试 `test_group_nudge_after_jailbreak`（test_st_compat_assembly_order.py:407-422）断言当前（错误）顺序。
- **实现**：将 nudge 注入块从 L943-950 移到 jailbreak 注入（L929-930）**之前**、chatHistory 之后（即在 `if jailbreak_content:` 前插入 nudge）；同步修正测试断言为「nudge 在 jailbreak 之前」。
- **注意事项**：impersonate 不注入的既有逻辑保留；空 nudge 不注入保留。此改动会改变群聊生成 prompt，属行为对齐修复。
- **修复风险**：中（影响生成输出；但与 ST 对齐是正确方向）。需用户确认后再实施。
- **验证**：`pytest backend/tests/test_st_compat_assembly_order.py` 全部通过；浏览器群聊生成验证 prompt 顺序。

---

## 后续批次（需决策，本轮不动）

| 编号 | 问题 | 原因 |
|---|---|---|
| N7-N10 | 群聊会话 ID 前缀/返回形状（P0） | 结构性改动，涉及 `{id}` 与 `palink-group-session-` 全链路归一，需单独方案 |
| A-1 | forbid_overrides 守卫读不存在数据路径 | 死代码无害；是否按 ST per-prompt 语义重接需决策 |
| K-2 | chats.js / world-info.js / dragdrop.js 整模块缺失 | 安全 stub 方案需决策（哪些 API 提供真实能力 vs no-op） |
| generateRaw 签名 | memory 插件单对象调用错位 | 涉及兼容层语义决策 |
| S-6/S-7、智能卡沙箱隔离 | 安全与隔离深化 | 需专项方案 |

---

## 实施批次顺序建议

1. **批次 A1（纯后端契约，F3/F4/F5/F6/F7）** — 一个容器重建周期内完成，pytest 全绿。
2. **批次 A2（前端鉴权/沙箱，F1/F8/F9/F10/F11）** — `npx tsc --noEmit` + `npm run build`，dist 自动同步。
3. **批次 A3（视口，F2）** — 并入 A2 或独立，dev 容器 HMR 验证。
4. **批次 B（F12/F13）** — 用户确认后实施，pytest + 浏览器实测。
