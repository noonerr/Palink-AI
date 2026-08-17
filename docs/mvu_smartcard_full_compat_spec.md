# MVU / 酒馆助手智能卡「通用全解」兼容规格书

> 版本：v1.0（2026-08-01）
> 目标读者：直接实施本方案的工程师（含未来的我自己）
> 交付性质：**可 100% 照做执行**的技术规格，精确到文件 / 函数 / 行号锚点、数据结构与验收标准。

---

## 0. 背景与目标

### 0.1 「全解」的定义（本文档承诺的范围）

本规格解决的是**通用能力**：让 Palink 前端能够正确渲染并驱动**任意遵循「酒馆助手 / MVU 协议」的角色卡**，而不是给某一张卡（如「我被猫娘包围了！」）打补丁。

「MVU 协议」在本文档中被明确界定为以下 4 个可枚举的机制组合，任意卡只要用到其中若干，都应被支持：

| 机制 | 载体 | 说明 |
|---|---|---|
| M1 变量 schema | `data.extensions.tavern_helper.scripts[?].content` 内 `registerMvuSchema` + zod `.prefault()` | 定义变量结构与初始默认值 |
| M2 变量更新 | AI 回复正文内 `<UpdateVariable>…<JSONPatch>[…]</JSONPatch></UpdateVariable>` | RFC 6902 JSON Patch 超集（+`delta`），驱动 `stat_data` 演进 |
| M3 显示改写 | `data.extensions.regex_scripts[]`（placement 含 `2`=AI_OUTPUT） | 把占位符 / 标签替换为 HTML（如 `<StatusPlaceHolderImpl/>` → 状态栏 HTML） |
| M4 界面运行时 | M3 产出的 HTML 文档 `<script>` | 依赖宿主注入的 `Mvu / lodash(_) / eventOn / errorCatched / jQuery / Vue / FontAwesome` 等全局与资源 |

**成功判据**：任取一张 MVU 卡导入 Palink，用户在原生聊天 UI 内即可看到状态栏正确渲染、变量随剧情实时更新、无需依赖任何外部 CDN 可用性、无需 opt-in ST sidecar。

### 0.2 非目标（明确排除）

- 不实现「小白X / 酒馆助手」这类**深度插件**在 Palink 原生 UI 内 100% 运行（这类仍走既有 opt-in st-native 逃生舱，见项目记忆的战略原则）。
- 不引入真实 ST 后端 / 运行时作为主路径（违反项目已拍板的自主性约束）。
- 不追求 zod schema 的 `.refine()` / 复杂 `.transform()` 100% 语义复刻；只保证 `.prefault()` 默认值提取 + 数值 clamp 常见场景（见 §3.7）。

### 0.3 架构原则（本方案的取舍）

1. **变量权威在后端**：`<UpdateVariable>` 的解析、JSON Patch 应用、`stat_data` 落库全部由 Palink 后端原生 Python 实现，**彻底移除对 CDN `MagVarUpdate/bundle.js` 的依赖**。前端只做「渲染 + 只读展示 + 可选乐观更新」。
2. **前端只是渲染器**：iframe 内 `Mvu.getAllVariables()` 返回的是「后端下发的会话真实变量」，而非硬编码或前端自行推导。
3. **去 CDN 化**：schema 默认值走后端提取（§3.7 方案 A）；M4 运行时依赖（jQuery/Vue/FontAwesome）走既有 `/api/smart-card-assets` 代理并加本地缓存（§3.6）。
4. **可开关、可回滚**：整套能力由单一 feature flag 控制（§8），默认可灰度。

---

## 1. 现状根因总览（已逆向核实，带证据）

| # | 断裂点 | 证据（文件:行） | 影响 |
|---|---|---|---|
| R1 | 卡内 `tavern_helper.scripts` 从不在角色加载时执行 | `grep extensions.tavern_helper / tavern_helper.scripts` 在 `frontend/src` **零命中**；`character_import_service.py` 不创建 tavern_helper 插件 | M1 schema 未注册、M2 解析器（MagVarUpdate）未加载 |
| R2 | `<UpdateVariable>` 无解析器 | 全前端仅 `utils/sillyTavernDisplayPipeline.ts:221` 用它做正则**检测**；后端 grep `UpdateVariable` 仅出现在 `api/plugins.py` 的类型名 | M2 完全不生效，`stat_data` 永不更新 |
| R3 | 会话变量与 iframe 变量不贯通 | 后端有 `ChatVariable` 表、`CharacterChatSession.chat_metadata`（models/character.py:68），但无 stat_data 写入路径；前端 iframe 有独立 `window.Mvu` shim（CharacterCardRenderer.tsx:2947） | 即使后端有变量也到不了状态栏 iframe |
| R4 | `defaultVariables` 硬编码为**另一张卡**的数据 | `CharacterCardRenderer.tsx:2556-2576`（世界/玩家/魔法少女结社/七罪魔女） | 状态栏 `refreshFromMVU()` 读到错误路径 → 全 `undefined` |
| R5 | 主渲染路径**不注入 context** | `Message.tsx:795-798` 仅传 `content`+`onAction`；`buildShim` 序列化白名单（CharacterCardRenderer.tsx:2175-2197）无 `variables` 字段 | `ctx` 恒空 → `allVariables`（tsx:2582）恒等于 R4 的硬编码值 |
| R6 | 副路径 placement 错误 | `NativeRoleplayChat.tsx:375` AI 消息用 `MD_DISPLAY(0)`，而 M3 脚本 placement=`[2]` | 开 `useNativeStRendering` 时状态栏 HTML 根本不生成 |
| R7 | M4 运行时依赖外部 CDN | 状态栏 HTML `<head>` 引用 jsdelivr 的 jQuery/Vue/FontAwesome；schema 脚本 `import` `mvu_zod.js`；MVU 脚本 `import` `MagVarUpdate/bundle.js` | 离线 / 墙内环境静默失败 |

> 补充事实：本卡 `<StatusPlaceHolderImpl/>` 占位符在 `alternate_greetings[0]`（非 `first_mes`），测试须切到该问候语；zod schema 默认值即初始 `stat_data`（如 `桃汐.好感度=50`）。

---

## 2. 目标架构与数据流

```
┌──────────────────────────────────────────────────────────────────────┐
│ 导入期 (character_import_service.py)                                    │
│   角色卡 PNG → extensions{regex_scripts, tavern_helper, character_book} │
│   → 落库 character.extensions (JSON)   [已就绪, 无需改]                 │
│   → 新增: 从 tavern_helper schema 提取初始 stat_data 骨架并缓存         │  §3.7
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 会话初始化 (首条消息 / 新建 session)                                    │
│   MvuEngine.init_session_variables(character, session)                  │  §3.1
│   → chat_metadata.variables.stat_data = 初始骨架                        │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 生成期 (websocket.py :: run_character_chat_generation :: persist_snapshot)│
│   final_raw = result.final_text()                    (L481, 已存在)     │
│   patches = MvuEngine.extract_update_variable(final_raw)                │  §3.1
│   new_stat = MvuEngine.apply_patches(cur_stat, patches, schema)         │  §3.1
│   → 写 session.chat_metadata.variables.stat_data (权威)                 │  §3.2
│   → 写 msg.extra.variables = 本轮快照 (审计/回放)                       │  §3.2
└──────────────────────────────────────────────────────────────────────┘
                              │  下发
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 下发 (character_ext.py 序列化 + websocket final_content)               │  §3.2
│   消息 payload.extra.variables  +  会话级 variables (新增字段/复用接口) │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 前端注入 (CharacterChat → Message → pipeline → CharacterCardRenderer)  │  §3.3
│   构造完整 ctx，含 ctx.variables = 会话 stat_data                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 渲染 (CharacterCardRenderer iframe)                                    │  §3.4
│   allVariables ← ctx.variables (废弃硬编码 defaultVariables)            │
│   window.Mvu.getAllVariables() → allVariables                          │
│   M3 正则已把 <StatusPlaceHolderImpl/> 替换为 HTML → refreshFromMVU() OK │
│   M4 依赖经 /api/smart-card-assets 代理 (去 CDN)                        │  §3.6
└──────────────────────────────────────────────────────────────────────┘
```

**职责边界**：后端 = 变量真源 + Patch 引擎 + schema 默认值；前端 = 正则显示改写（已有）+ iframe 渲染（已有）+ 变量注入（新增）。

---

## 3. 详细设计

### 3.1 后端核心：MVU 变量引擎（新模块）

**新建文件**：`backend/app/services/mvu_engine.py`

职责：无状态纯函数集合 + 一个薄封装类。**不碰 DB**（DB 由集成层调用，便于单测）。

#### 3.1.1 数据结构

- 变量容器统一为：`{"stat_data": {<任意嵌套 dict/list/scalar>}, "_schema_meta": {...可选...}}`。
- 会话持久化位置：`CharacterChatSession.chat_metadata`（JSON 字符串）内 `variables` 键，即
  `chat_metadata = {"variables": {"stat_data": {...}}, ...其他既有键...}`。
  与 `st_sync_service.py` 现有 `chat_metadata.variables` 约定一致（见后端调研：st_sync_service.py:474-501、silly_tavern.py:1443-1458），**复用不新造**。

#### 3.1.2 必须实现的函数（签名与语义固定）

```python
# --- 提取 ---
def extract_update_variable_blocks(text: str) -> list[list[dict]]:
    """
    从 AI 回复正文提取所有 <UpdateVariable> 块内的 <JSONPatch> 数组。
    - 匹配 /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi
    - 块内优先取 <JSONPatch>([\s\S]*?)<\/JSONPatch>；若无该标签，回退：
      在块内查找第一个平衡的 JSON 数组 [ ... ]。
    - 对每个候选做 json.loads；失败则尝试宽松修复（去尾逗号、单引号→双引号、
      去掉 ${...} 占位残留行）；仍失败则跳过该块并记 warning。
    - 返回 patch 数组的列表（每个 <UpdateVariable> 一个），保持出现顺序。
    """

# --- 应用 ---
def apply_patches(
    stat_data: dict,
    patches: list[dict],
    *,
    readonly_prefix: str = "_",
) -> tuple[dict, list[str]]:
    """
    在 stat_data 的深拷贝上按顺序应用 patch，返回 (新 stat_data, 变更日志)。
    支持 op:
      - replace : 覆盖已存在路径的值（路径不存在则按 add 语义创建，宽松）
      - add     : RFC6902 add（等价于卡内 insert 语义之一）
      - insert  : 卡内自定义。数组用 '-' 追加末尾；对象则等价 add
      - remove  : 删除路径
      - move     : {from, path} 移动
      - delta   : 自定义。对数字路径做 += value；目标非数字则跳过并记 warning
    约束：
      - path 为 JSON Pointer（'/a/b/0'），按 RFC6901 解析（~1→/、~0→~）
      - 路径任一段以 readonly_prefix 开头 → 跳过该 op 并记 warning（保护 _变量）
      - 单个 op 异常不得中断整体；捕获后记 warning 继续下一个
    """

def _json_pointer_get(obj, tokens): ...
def _json_pointer_set(obj, tokens, value, *, create_missing=True): ...
def _json_pointer_remove(obj, tokens): ...

# --- schema 默认值（见 §3.7）---
def extract_schema_defaults(tavern_helper: dict) -> dict:
    """从 tavern_helper.scripts 内 zod schema 的 .prefault() 提取初始 stat_data 骨架。"""

# --- 初始化 ---
def build_initial_stat_data(character_extensions: dict) -> dict:
    """
    合成会话初始 stat_data，优先级（后者覆盖前者的深合并）：
      1. schema 默认值 extract_schema_defaults(extensions.tavern_helper)
      2. extensions.tavern_helper.variables (若非空)
      3. first_mes / alternate_greetings 内 <initvar>...</initvar> 块（缩进式或 JSON）
    返回 {"stat_data": {...}}。三者皆空则返回 {"stat_data": {}}。
    """

# --- 薄封装（供集成层调用）---
class MvuEngine:
    @staticmethod
    def init_session_variables(character_extensions: dict) -> dict: ...
    @staticmethod
    def update_from_reply(current_variables: dict, reply_text: str,
                          character_extensions: dict) -> tuple[dict, list[str]]:
        """
        current_variables = {"stat_data": {...}}；返回 (新 variables, 变更日志)。
        内部：extract_update_variable_blocks → 逐块 apply_patches。
        若当前 stat_data 为空且有 schema，先用 build_initial_stat_data 兜底。
        """
```

#### 3.1.3 边界与容错（硬性要求）

- AI 未输出 `<UpdateVariable>` → 返回原变量不变、日志为空（不得报错）。
- patch JSON 非法 → 跳过该块，`update_from_reply` 仍返回可用变量。
- `delta` 目标不是 number → 跳过并 warning（不得把字符串拼接成 delta）。
- 全程 deep-copy，禁止原地修改入参（便于回滚与单测）。

---

### 3.2 后端集成点（3 处，均已定位）

#### 集成点 A：生成落库 —— `backend/app/api/websocket.py`

- 函数：`run_character_chat_generation` 内的 `persist_snapshot`（≈L465）。
- 位置：在 `final_raw = result.final_text()`（L481）之后、`strip_and_parse_status_marker`（L483）附近。
- 逻辑：
  ```python
  # 读取当前会话变量
  cur_meta = json.loads(session.chat_metadata or "{}")
  cur_vars = cur_meta.get("variables") or {"stat_data": {}}
  if not cur_vars.get("stat_data"):
      cur_vars = MvuEngine.init_session_variables(character_extensions)
  new_vars, change_log = MvuEngine.update_from_reply(cur_vars, final_raw, character_extensions)
  cur_meta["variables"] = new_vars
  session.chat_metadata = json.dumps(cur_meta, ensure_ascii=False)   # 权威落库
  # 消息级快照（审计/回放/前端下发）
  msg_extra["variables"] = new_vars           # msg_extra 见 L520-527
  ```
- `character_extensions` 来源：本函数已可访问 character；解析 `json.loads(character.extensions or "{}")`。
- 与 `force=True`（L793）/ `finally`（L851）的既有落库合流：变量写入 `session.chat_metadata` 与 `msg.extra`，随既有 commit 一并持久化，**不新增 commit 点**。
- 更新分支（L605-618 合并旧 `msg.extra`）：确保 `variables` 键参与合并（浅覆盖即可）。

#### 集成点 B：会话初始化 —— 新会话 / 首条消息

- 在创建 `CharacterChatSession` 处（`api/character_ext.py` 建会话逻辑）写入初始变量：
  ```python
  meta = {"variables": MvuEngine.init_session_variables(character_extensions)}
  session.chat_metadata = json.dumps(meta, ensure_ascii=False)
  ```
- 若历史会话无 `variables`：集成点 A 已有兜底（空则 init），无需数据迁移。

#### 集成点 C：下发前端 —— `backend/app/api/character_ext.py`

- 消息级：`_serialize_character_message`（L336）已整体下发 `extra`（L388），`extra.variables` **无需改序列化即可到达前端**。
- 会话级（推荐，供「初始渲染」用）：在 `get_character_session_messages`（L2728）返回体新增顶层字段：
  ```python
  return {"messages": [...], "variables": cur_meta.get("variables", {"stat_data": {}})}
  ```
  或复用既有 `/api/variables/local/{session_id}`；二选一，推荐前者（一次请求拿齐，减少往返）。
- WebSocket 流：`final_content`（L817）建议附带 `variables`：
  ```python
  await ws.send_json({"type": "final_content", "content": final, "message_id": mid,
                      "variables": new_vars})
  ```
  供前端实时刷新状态栏（无需重拉历史）。

---

### 3.3 前端：context 变量注入链

#### 3.3.1 类型 —— `frontend/src/types/index.ts`

- `CharacterSmartCardContext`（L326）新增字段：
  ```ts
  variables?: { stat_data?: Record<string, unknown> } & Record<string, unknown>;
  ```
  位置置于 `sessionId?`（L371）附近。

#### 3.3.2 序列化白名单 —— `CharacterCardRenderer.tsx :: buildShim`

- `buildShim` 的 `contextJson`（L2175-2197）**新增一行**：
  ```ts
  variables: (context.variables && typeof context.variables === 'object')
    ? context.variables : { stat_data: {} },
  ```
- 这是把变量送进 iframe 的唯一通道（其余字段已在白名单内）。

#### 3.3.3 主路径传参 —— `Message.tsx`

- `Message.tsx:795-798` 的 `<CharacterCardRenderer>` **补齐 `context` prop**：
  ```tsx
  <CharacterCardRenderer
    content={pipelineResult.content}
    onAction={onSmartCardAction}
    context={smartCardContext}   // 新增
  />
  ```
- `smartCardContext` 构造（在 `Message` 组件体内 useMemo）：
  ```ts
  const smartCardContext = useMemo<CharacterSmartCardContext>(() => ({
    characterId, characterName, userName,
    messageId: message.id, messageContent: displayContent,
    firstMes, alternateGreetings,
    characterExtensions,          // 已有 prop（见下）
    sessionId,
    variables: message?.extra?.variables            // 消息级快照
             ?? sessionVariables                     // 会话级兜底
             ?? { stat_data: {} },
  }), [/* deps */]);
  ```
- 这些字段的来源：`characterExtensions` 已由 `Message` 接收（用于 pipeline）；`firstMes/alternateGreetings/characterName/userName/sessionId` 需由 `CharacterChat` 透传（见 §3.3.4）。

#### 3.3.4 父级透传 —— `CharacterChat.tsx`

- `CharacterChat.tsx` 已持有 `selectedCharacter`（含 `first_mes/alternate_greetings/extensions`）与当前 `sessionId`、会话变量。
- 给 `Message` 增补 props：`firstMes / alternateGreetings / userName / sessionVariables`（会话级 stat_data，来自 §3.2-C 的下发字段），并在收到 WebSocket `final_content.variables` 时更新 `sessionVariables` state。
- `characterExtensions`（L1618 已传 `compatCharacterExtensions || selectedCharacter.extensions`）保持不变。

#### 3.3.5 pipeline 透传（如经 pipeline 构造 ctx）—— `utils/sillyTavernDisplayPipeline.ts`

- 若选择在 pipeline 内构造 ctx（替代 §3.3.3 在 Message 内构造），则 `applySillyTavernDisplayPipeline` 的入参新增 `variables`，并在其产出的 smart-card 结果里携带 ctx。**二选一，推荐 §3.3.3（在 Message 内构造，改动面最小）**。

---

### 3.4 前端渲染：变量来源改造 —— `CharacterCardRenderer.tsx`

#### 3.4.1 废弃硬编码 defaultVariables（R4）

- `defaultVariables`（L2556-2576）**改为**从 `ctx.variables` 派生：
  ```js
  const defaultVariables = (ctx.variables && typeof ctx.variables === 'object')
    ? clone(ctx.variables)
    : { stat_data: {} };
  ```
- 保留 `extractInitVariableBlocks()`（L2527）/`parseIndentedVariables()`（L2444）作为**次级兜底**（当 ctx.variables 为空且卡用 `<initvar>` 时仍可用），合成顺序：`ctx.variables` 深合并 `<initvar>` 块（L2582-2588 逻辑保留，base 换成上面的 `defaultVariables`）。

#### 3.4.2 Mvu.getAllVariables 归一（R3）

- 现状：`window.Mvu.getAllVariables = () => clone(allVariables)`（L2953）与 L2992 的 `smartCardVariableStore` 不一致。
- 改造：统一读取「同一权威源」。令 `allVariables`（L2582）为唯一真源，`smartCardVariableStore`（L2955）以 `allVariables` 为 base：
  ```js
  const smartCardVariableStore = mergePlainObjects(clone(allVariables),
                                    readStoredJson('__palink_chat_variables', {}));
  window.Mvu.getAllVariables = () => clone(smartCardVariableStore);   // 统一
  ```
- `window.getAllVariables`（L2997）同样指向 `smartCardVariableStore`。

#### 3.4.3 变量热更新（配合 §3.2-C WebSocket）

- iframe 已支持 `context-update` postMessage（L2371-2374 `Object.assign(ctx, clone(data.context))`）。
- 扩展该分支：当 `data.context.variables` 存在时，同步刷新运行时并触发事件：
  ```js
  if (data.context.variables) {
    mergePlainObjects(smartCardVariableStore, clone(data.context.variables));
    try {
      eventSource.emit('VARIABLE_UPDATE_ENDED', clone(smartCardVariableStore));
      eventSource.emit('CHAT_VARIABLES_UPDATED', clone(smartCardVariableStore));
    } catch {}
  }
  ```
- 父组件在 `sessionVariables` 变化时，向 iframe post `{source:'palink-smart-card-parent', frameId, type:'context-update', context:{variables}}`。这样**新一轮变量无需重建 iframe 即可刷新状态栏**（状态栏脚本已监听 `Mvu.events.VARIABLE_UPDATE_ENDED`）。

---

### 3.5 placement 统一（R6）—— `NativeRoleplayChat.tsx`

- `NativeRoleplayChat.tsx:375`：
  ```ts
  // before
  regexPlacement: isAiMessage ? regex_placement.MD_DISPLAY : regex_placement.USER_OUTPUT
  // after —— 与 ST 1.18.0 script.js(L1792) 及主路径 sillyTavernDisplayPipeline.ts(L259) 对齐
  regexPlacement: isAiMessage ? regex_placement.AI_OUTPUT : regex_placement.USER_OUTPUT
  ```
- 影响面：仅 `useNativeStRendering` 开关路径。改后两条渲染路径 placement 一致，M3 脚本（placement `[2]`）在任何路径都能命中。

---

### 3.6 去 CDN 化：M4 运行时依赖（R7）

- 既有基础设施：`SMART_CARD_ASSET_PROXY_ENDPOINT = '/api/smart-card-assets?url='`（CharacterCardRenderer.tsx:40）、`/api/smart-card-assets/prefetch`（L41）、warm 集合（L54-56）。
- 要求：
  1. **iframe HTML 注入前，重写外部资源 URL**为代理形式。定位 `createSrcContent`/`prepareIframeHtml` 相关逻辑（本文件内构建 `<head>` 处），对 `src=`/`href=`/`@import`/`import '...'` 的绝对 https URL 统一改写为 `${SMART_CARD_ASSET_PROXY_ENDPOINT}${encodeURIComponent(url)}`。若已有改写则仅补测；若无则新增一个 `rewriteExternalUrls(html)` 纯函数并在注入前调用。
  2. **代理端加持久缓存**：`backend`（`/api/smart-card-assets`）对 jsdelivr 等白名单域名的响应落地缓存（`data/smart_card_assets/`，记忆已知该目录存在），命中则离线可用。设置合理 TTL + SRI/大小上限。
  3. **注入 M2/M1 不再依赖 CDN**：因变量引擎已后端化，卡内 MVU 脚本 `import MagVarUpdate/bundle.js` **无需执行**（前端不执行 tavern_helper.scripts）；`mvu_zod.js` 仅在 §3.7 方案 B 时才需要（默认走方案 A，不需要）。

---

### 3.7 schema 默认值提取（M1 去 CDN）

#### 方案 A（默认，纯后端，无 CDN）—— `extract_schema_defaults`

从 `tavern_helper.scripts[?].content`（含 `registerMvuSchema`/`z.object`）用**词法解析**提取 `.prefault(默认值)`：

- 识别顶层 `z.object({ ... })` 的键，递归解析嵌套 `z.object`。
- 对每个叶子字段取其 `.prefault(X)`：
  - `.prefault('str')` → 字符串
  - `.prefault(50)` / `.prefault(0)` → 数字
  - `.prefault({})` / `.prefault([])` → 空对象/数组
  - `.prefault(true/false)` → 布尔
- `z.object({...}).prefault({})` → 递归取内部字段默认值组成 dict（`.prefault({})` 表示「无覆盖，用字段各自默认」）。
- 无 `.prefault` 的字段：按类型给零值（`z.string()`→''、`z.number()`/`z.coerce.number()`→0、`z.object()`→{}、`z.array()`→[]）。
- 实现建议：正则 + 括号平衡扫描（不引入 JS 解释器）。对本卡验证目标：应产出
  `{"世界信息":{"日期时间":"","天气":"","风力":"","地点":""},"桃汐":{"好感度":50,"关系":"青梅竹马",...}, ...}`。
- 提取失败（语法超出支持）→ 返回 `{}`，由 M2 的 `insert` 逐步建立（不阻塞）。

#### 方案 B（可选，高保真，opt-in）

前端一次性隐藏沙箱执行「变量结构」脚本（经 §3.6 代理加载 `mvu_zod.js`）→ 调 `registerMvuSchema` 得到默认 `stat_data` → POST `/api/character-chat/{session}/init-variables` 落库。仅当方案 A 对某卡失真且用户开启「高保真变量」开关时启用。**默认关闭**，符合去 CDN 原则。

---

## 4. 接口契约（数据结构，固定）

### 4.1 会话变量（后端权威，`chat_metadata.variables`）
```jsonc
{ "stat_data": { "<任意路径>": "<值/嵌套>" } }
```

### 4.2 消息 payload 扩展（`extra.variables`）
```jsonc
{ "extra": { "variables": { "stat_data": { ... } }, /* 既有键 */ } }
```

### 4.3 `<UpdateVariable>` patch（AI 输出 → 后端解析）
```jsonc
[
  { "op": "replace", "path": "/桃汐/好感度", "value": 60 },
  { "op": "delta",   "path": "/桃汐/性欲值", "value": 5 },
  { "op": "insert",  "path": "/事件日志/-", "value": "第一次约会" },
  { "op": "remove",  "path": "/临时/标记" },
  { "op": "move",    "from": "/a", "path": "/b" }
]
```
规则：JSON Pointer 路径；`_` 前缀路径段只读；`delta` 仅作用数字。

### 4.4 前端 ctx.variables（注入 iframe）
```jsonc
{ "stat_data": { ... } }   // = 4.1，原样透传
```

### 4.5 WebSocket final_content 扩展
```jsonc
{ "type": "final_content", "content": "...", "message_id": "...", "variables": { "stat_data": {...} } }
```

---

## 5. 分阶段执行计划（每阶段独立可验收）

| 阶段 | 内容 | 交付 | 验收 |
|---|---|---|---|
| P0 | `mvu_engine.py` + 单测 | §3.1 全部函数 | §7.1 单测全绿 |
| P1 | 后端集成 A/B/C | §3.2 落库+下发 | 发一轮带 `<UpdateVariable>` 的回复，DB `chat_metadata.variables.stat_data` 正确演进；消息 `extra.variables` 有快照 |
| P2 | 前端注入链 | §3.3（types/buildShim/Message/CharacterChat） | iframe 内 `console.log(ctx.variables)` 为真实会话变量 |
| P3 | 渲染改造 | §3.4（废弃硬编码 + Mvu 归一 + 热更新） | 状态栏显示真实数值；发新回复后状态栏实时刷新（无 iframe 重建） |
| P4 | placement 统一 | §3.5 | 开 `useNativeStRendering` 状态栏同样出现 |
| P5 | 去 CDN | §3.6 + §3.7A | 断网/墙内状态栏样式与脚本仍可用；schema 默认值正确 |
| P6 | 通用性回归 | 换 2 张不同 MVU 卡 | 均正确渲染+更新（证明「全解」而非单卡） |

依赖关系：P0→P1→P2→P3；P4/P5/P6 可在 P3 后并行。

---

## 6. 逐文件改造清单（精确锚点）

### 后端
| 文件 | 位置 | 改动 |
|---|---|---|
| `backend/app/services/mvu_engine.py` | 新建 | §3.1 全部函数 + `MvuEngine` |
| `backend/app/api/websocket.py` | `persist_snapshot` ≈L481 后 | 集成点 A：解析+落库 `chat_metadata.variables` 与 `msg_extra['variables']`；L605-618 合并分支纳入 `variables` |
| `backend/app/api/character_ext.py` | 建会话逻辑 | 集成点 B：init 变量 |
| `backend/app/api/character_ext.py` | `get_character_session_messages` L2728 | 集成点 C：返回体加 `variables` 顶层字段 |
| `backend/app/api/websocket.py` | `final_content` L817 | 附带 `variables` |
| `backend/app/api/smart_card_assets*`（既有） | 代理处理 | §3.6 加持久缓存 + URL 白名单 |

### 前端
| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/src/types/index.ts` | `CharacterSmartCardContext` L326（≈L371 处） | 新增 `variables?` 字段 |
| `frontend/src/components/ui/custom/CharacterCardRenderer.tsx` | `buildShim` L2175-2197 | contextJson 加 `variables` |
| 同上 | `defaultVariables` L2556-2576 | 改为源自 `ctx.variables`（废弃硬编码） |
| 同上 | `smartCardVariableStore` L2955 / `Mvu.getAllVariables` L2953,2992 | 归一到单一真源 |
| 同上 | `context-update` 分支 L2371-2374 | 支持 `variables` 热更新 + 触发事件 |
| 同上 | iframe HTML 注入处（`createSrcContent` 附近） | §3.6 外部 URL 改写为代理 |
| `frontend/src/components/ui/custom/Message.tsx` | `<CharacterCardRenderer>` L795-798 | 传 `context={smartCardContext}`；新增 useMemo 构造 ctx |
| `frontend/src/components/views/character/CharacterChat.tsx` | `<Message>` 使用处（≈L1617 区块） | 透传 `firstMes/alternateGreetings/userName/sessionVariables`；订阅 `final_content.variables` 更新 state |
| `frontend/src/components/roleplay/NativeRoleplayChat.tsx` | L375 | `MD_DISPLAY` → `AI_OUTPUT` |

---

## 7. 测试与验收

### 7.1 后端单测（`backend/tests/test_mvu_engine.py`，新建）

必测用例：
1. `extract_update_variable_blocks`：单块 / 多块 / 带 `<Analysis>` / 无 `<JSONPatch>` 标签回退 / 非法 JSON 修复 / 完全无块。
2. `apply_patches`：
   - replace 覆盖已存在数字/字符串；
   - delta 数字 +/−；delta 命中非数字 → 跳过+warning；
   - insert 数组 `-` 追加、insert 对象新键；
   - remove 存在/不存在；move 成功；
   - `_变量` 只读 → 跳过；深层 `/a/_b/c` 中间段只读 → 跳过；
   - 单 op 异常不中断后续。
3. `extract_schema_defaults`：喂入本卡「变量结构」脚本 content，断言 `桃汐.好感度==50`、`桃汐.关系=='青梅竹马'`、`世界信息.日期时间==''`。
4. `update_from_reply`：空 stat_data + 有 schema → 先兜底 init 再应用；幂等（同一回复应用两次结果一致，除 delta 外）。

### 7.2 前端

- 单测：`buildShim` 输出含 `variables`；`defaultVariables` 派生逻辑；`context-update` variables 分支触发事件。
- E2E（猫娘卡）：导入 → 切到 `alternate_greetings[0]`（含 `<StatusPlaceHolderImpl/>`）→ 状态栏出现，`桃汐.好感度` 显示 50；发一轮触发 `delta +5` 的回复 → 状态栏刷新为 55（无 iframe 重建）；断网重进 → 状态栏样式/脚本仍可用（代理缓存）。

### 7.3 通用性回归（P6，证明「全解」）

- 另取 ≥2 张结构不同的 MVU 卡（不同变量路径、不同状态栏 HTML），全流程验证渲染+更新。**这是「全解 vs 单卡补丁」的核心验收**。

---

## 8. 开关与回滚

- feature flag：`user_setting.mvu_compat_enabled`（默认灰度开）。关闭时：后端跳过集成点 A 的变量解析（不写 `variables`），前端 `ctx.variables` 为空 → 回退到既有 `<initvar>`/兜底行为。
- 回滚：各阶段改动均加法式（新增字段/新模块），关闭 flag 即恢复现状；`mvu_engine.py` 可整体移除。
- 数据安全：`chat_metadata.variables` 为新增键，不影响既有 `chat_metadata` 其他字段；无破坏性迁移。

---

## 9. 风险与合规

- **zod 复杂语义**：方案 A 不复刻 `.refine()`/复杂 `.transform()`；若某卡强依赖，走方案 B（opt-in）或接受默认值近似。已在 §0.2 声明。
- **AI 不按格式输出**：`<UpdateVariable>` 缺失/格式错 → 变量不更新但不崩溃（§3.1.3）。可选：在 system prompt 末尾追加格式提醒（本卡 character_book order=14720 已内置该指令，装配时会注入）。
- **许可**：本方案**不复用 ST/JS-Slash-Runner 的前端代码**，仅在 Palink 自有实现中支持其**数据协议**（JSON Patch/占位符/zod 默认值均为通用格式或自研解析），规避 AGPL 传播风险；MagVarUpdate/mvu_zod 默认不加载不分发。方案 B 若加载 `mvu_zod.js` 属运行期第三方脚本，需在资源代理层标注来源。
- **安全**：iframe 保持 `sandbox`；变量值来自 AI，注入状态栏时状态栏脚本自身负责转义（已有 `htmlEscapeCompat`，CharacterCardRenderer.tsx:2974）；后端不 eval 任何卡内 JS（方案 A）。

---

## 附录 A：本卡逆向速查（验收基准样本）

- 卡：「我被猫娘包围了！」 chara_card_v3 3.0。
- schema 默认值（方案 A 应产出）：`桃汐{好感度:50,关系:'青梅竹马',性欲值:20,发情期:'2026年06月13日'...}`、`苏小兰{好感度:20,关系:'邻居'...}`、`世界信息{日期时间:'',天气:'',风力:'',地点:''}`。
- 状态栏 HTML：M3 脚本 `[界面]状态栏`（placement `[2]`，48958B），`refreshFromMVU()` 读 `_.get(vars,'stat_data',{})` 的 `世界信息.日期时间`/`桃汐.好感度`。
- `<StatusPlaceHolderImpl/>` 在 `alternate_greetings[0]`。
- `<UpdateVariable>` 格式指令：character_book `[mvu_update]变量输出格式`（order 14720）。
```
