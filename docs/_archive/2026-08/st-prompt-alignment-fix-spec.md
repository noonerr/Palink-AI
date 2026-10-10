# 角色扮演提示词与 SillyTavern 对齐性修复 Spec

> 日期：2026-08-13
> 范围：修复本项目中角色扮演提示词装配、角色卡世界书导入、模板语法泄漏等与 SillyTavern 1.18.0 不对齐的问题。
> 证据分级：【实测】= 容器内运行验证、【一查】= 直接读码、【ST】= ST 1.18.0 源码对照、【DB】= 数据库实况。

---

## 1. 背景与问题总览

用户反馈"AI 回复驴唇不对马嘴"。经对照 ST 1.18.0 源码 + 数据库实况审计，确认存在 3 个致命缺陷和 1 个严重偏差：

| # | 问题 | 级别 | 直接后果 |
|---|------|------|---------|
| P1 | ST 对齐装配路径（st-compat）对正常用户不可达 | 致命 | 精心实现的 ST 对齐装配器是死代码，用户实际走旧管线 |
| P2 | 角色卡内嵌世界书导入字段名错误（`keys`/`enabled` 丢失） | 致命 | 世界书关键词全部丢失、禁用条目泄漏进 prompt |
| P3 | 世界书条目内 EJS/underscore 模板语法（`<%_ %>`）未渲染 | 致命 | 模型上下文出现模板代码残骸 |
| P4 | palink-native 提示词结构与 ST 差异巨大（额外指令消息） | 严重 | 扮演质量下降（本次仅修 P1 通道，不改造 palink-native 结构） |

---

## 2. 现状证据

### P1. st-compat 装配路径不可达

- 【一查】装配层只在 `silly_tavern_mode == "st-compat"` 时启用 ST 对齐装配器
  [roleplay_prompt_assembly.py:3573](file:///d:/项目/Palink-AI/backend/app/services/roleplay_prompt_assembly.py#L3573)；
  模式归一化把 `"st-compat"` 改写成 `"palink-native"`
  [users.py:18-21](file:///d:/项目/Palink-AI/backend/app/api/users.py#L18-L21)，
  [silly_tavern.py:554-561](file:///d:/项目/Palink-AI/backend/app/api/silly_tavern.py#L554-L561)。
- 【实测】容器内运行归一化验证：`st-compat -> palink-native`。
- 【一查】前端仅发送 `st-native` / `palink-native` / `classic`
  [SettingsView.tsx:228-229](file:///d:/项目/Palink-AI/frontend/src/components/views/SettingsView.tsx#L224-L241)。
- 【DB】`user_settings.silly_tavern_mode`：admin=1 为 `palink-native`；仅 hacker_test=4 被手工写入 `st-compat`。
- 【一查】装配层共 10 处 `"st-compat"` 字面量判断：756 / 2184 / 2580 / 3402 / 3574 / 3859 / 3961 / 4162 / 4167 / 4178。

### P2. 世界书导入字段名错误

- 【ST】ST V2/V3 角色卡 `character_book` 条目规范字段为 `keys` / `secondary_keys` / `enabled`
  [spec-v2.d.ts:35-51](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/src/types/spec-v2.d.ts#L35-L51)。
- 【一查】ST 前端**内部** worldinfo 条目用 `key` / `keysecondary` / `disable`
  [world-info.js:4003-4014](file:///d:/项目/Palink-AI/SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/world-info.js#L4003-L4014)；
  **导出/导入**格式（lorebook JSON、角色卡 character_book）用 `keys` / `secondary_keys` / `enabled`。
- 【一查】4 处导入代码按内部格式 `key`/`keysecondary`/`disable` 读取 ST 导出格式，导致字段丢失：
  1. [character_import_service.py:649/678/686/722-723](file:///d:/项目/Palink-AI/backend/app/services/character_import_service.py#L712-L762)（角色卡导入，最常用）
  2. [worldbook.py:311/353/371-372](file:///d:/项目/Palink-AI/backend/app/api/worldbook.py#L311-L372)（世界书 JSON 文件导入）
  3. [silly_tavern.py:5837/5851-5852/5860](file:///d:/项目/Palink-AI/backend/app/api/silly_tavern.py#L5837-L5860)（ST `/api/worldinfo/import`）
  4. [silly_tavern.py:4503-4504/4512](file:///d:/项目/Palink-AI/backend/app/api/silly_tavern.py#L4503-L4512)（`_create_stage_from_st_entry`，ST `/api/worldinfo/edit`）
- 【DB】"我被猫娘包围了！"卡原始 `palink_raw_card_data` 有 9 个带 `keys` 的条目（如 `南方联合大学`→keys=`['南方联合大学']`，position=`after_char`），导入后 `world_book_stages.keys` 全部为 `[]`；原始 `enabled=False` 的 `[initvar]变量初始化勿开` 条目导入后变成 `enabled=True`。
- 【一查】`normalize()` 把 character_book 原样透传，无字段名转换
  [character_import_service.py:470](file:///d:/项目/Palink-AI/backend/app/services/character_import_service.py#L470)。

### P3. EJS 模板语法泄漏

- 【DB】"请成为我的母亲吧！魔女小姐！XBX"卡常驻世界书条目内容为 `<%_ if (v('世界.妈妈.璐法.在队状态') === '是') { _%>...<%_ } _%>`。
- 【一查】后端无任何 JS 模板渲染器（全局搜不到 `<%_`/`_.template`/embedded JS 处理），仅做 `{{char}}`/`{{user}}` 宏替换；注入前不做剥离 → 模板代码残骸原样进入 prompt。
- 【一查】worldbook 引擎支持 ST 的 `@@activate`/`@@exclude` 等装饰器，但无 EJS 渲染能力
  [worldbook_service.py:325-368](file:///d:/项目/Palink-AI/backend/app/services/worldbook_service.py#L325-L368)。

### P4. palink-native 结构差异（仅记录，不在本次修改范围）

- 【一查】palink-native 的 system prompt 为中文三层模板（身份锁定/角色卡/回复格式/声音描述）
  [default_prompts.py:21-103](file:///d:/项目/Palink-AI/backend/app/core/default_prompts.py#L21-L103)；
  世界书以 `[World Lore]` 大 blob 注入到聊天历史之后
  [character_message_builder.py:244-252](file:///d:/项目/Palink-AI/backend/app/services/character_message_builder.py#L244-L252)；
  ST 则是 `main` 短句 + 独立 description/personality/scenario 消息 + worldInfoBefore(位置1)/worldInfoAfter(位置8)。
- 修复方向：**不改造 palink-native 结构**，而是接通 st-compat 通道供用户显式选择；palink-native 仍受益于 P2/P3 修复。

---

## 3. 修复目标

1. **P1**：让 `silly_tavern_mode` 的 `st-compat` 和 `compat` 都走 ST 对齐装配路径；后端归一化允许 `st-compat`；前端设置页提供三态选择（Palink 原生 / ST 兼容装配 / ST 原生界面）。
2. **P2**：世界书/角色书导入时兼容 ST 导出格式（`keys`/`secondary_keys`/`enabled`）与 ST 内部格式（`key`/`keysecondary`/`disable`），关键词与禁用状态不再丢失。
3. **P3**：世界书条目注入 prompt 前剥离 EJS/underscore 模板语法（`<%_ %>`/`<% %>`/`<%= %>` 等），两种模式均生效。
4. **数据回填**：提供一次性脚本，从已导入角色的 `palink_raw_card_data` 回填 `world_book_stages.keys/secondary_keys/enabled`，修复现有卡。
5. **切换**：修复后把 admin 用户（id=1）模式从 `palink-native` 切到 `st-compat`（admin 未开状态栏/自定义提示词，切换无功能损失），使修复立即可见。

---

## 4. 详细实现方案

### 4.1 P1：接通 st-compat 装配路径

#### 4.1.1 后端：模式归一化允许 `st-compat`

文件：[users.py](file:///d:/项目/Palink-AI/backend/app/api/users.py#L18-L21)、[silly_tavern.py](file:///d:/项目/Palink-AI/backend/app/api/silly_tavern.py#L554-L561)

```python
_SILLY_TAVERN_MODE_ALIASES = {"iframe": "compat", "native": "palink-native"}
def _normalize_silly_tavern_mode(mode: str | None) -> str:
    raw = str(mode or "palink-native").strip() or "palink-native"
    normalized = _SILLY_TAVERN_MODE_ALIASES.get(raw, raw)
    return normalized if normalized in {"compat", "st-compat", "st-native", "palink-native"} else "palink-native"
```

同时 [schemas/user.py:33](file:///d:/项目/Palink-AI/backend/app/schemas/user.py#L33) 的 `Literal` 加入 `"st-compat"`。

#### 4.1.2 后端：装配层统一判断

在 [roleplay_prompt_assembly.py](file:///d:/项目/Palink-AI/backend/app/services/roleplay_prompt_assembly.py) 顶部新增：

```python
ST_COMPAT_MODES = {"st-compat", "compat"}

def _is_st_compat_mode(st_mode: Optional[str]) -> bool:
    return (st_mode or "").strip().lower() in ST_COMPAT_MODES
```

将全部 10 处 `st_mode == "st-compat"` / `!= "st-compat"` 判断替换为 `_is_st_compat_mode(st_mode)` / `not _is_st_compat_mode(st_mode)`（含 3402 的 `_is_st_compat` 表达式）。涉及行：756、2184、2580、3402、3574、3859、3961、4162、4167、4178。

#### 4.1.3 前端：设置页三态选择

文件：[SettingsView.tsx](file:///d:/项目/Palink-AI/frontend/src/components/views/SettingsView.tsx#L208-L259)

将 `SillyTavernSettingsPanel` 的二元 `Switch` 改为三态按钮组（复用该文件已有的分段按钮风格，见 L190-204）：
- `palink-native`（Palink 原生）
- `st-compat`（ST 兼容装配，推荐）
- `st-native`（ST 原生界面）

`handleModeChange(mode)` 调 `PUT /api/users/me/settings { silly_tavern_mode: mode }`，并派发 `userSettingsUpdated` 事件。原有 `nativeStEnabled` 状态改为 `stMode: string`。

#### 4.1.4 前端：类型扩展

- [CharacterView.tsx:141](file:///d:/项目/Palink-AI/frontend/src/components/views/CharacterView.tsx#L141)：state 类型加 `'st-compat'`。
- [CharacterChat.tsx:264](file:///d:/项目/Palink-AI/frontend/src/components/views/character/CharacterChat.tsx#L264)：prop 类型加 `'st-compat'`。
- 视图分流不变：`sillyTavernMode === 'st-native'` 才渲染 ST iframe，`st-compat` 走 Palink 聊天 UI（装配在服务端生效）。

### 4.2 P2：世界书导入字段名兼容

#### 4.2.1 新增共享解析 helper

文件：[worldbook_import_utils.py](file:///d:/项目/Palink-AI/backend/app/services/worldbook_import_utils.py)（已有 `normalize_worldbook_position`）

```python
def entry_keys(entry: dict) -> list:
    """ST 导出格式 keys / 内部格式 key 兼容。"""
    if not isinstance(entry, dict):
        return []
    v = entry.get("keys", entry.get("key"))
    if isinstance(v, list):
        return v
    return [] if v is None else [v]

def entry_secondary_keys(entry: dict) -> list:
    if not isinstance(entry, dict):
        return []
    v = entry.get("secondary_keys", entry.get("keysecondary"))
    if isinstance(v, list):
        return v
    return [] if v is None else [v]

def entry_is_disabled(entry: dict) -> bool:
    """enabled=False（ST 导出格式）或 disable=True（ST 内部格式）均视为禁用。"""
    if not isinstance(entry, dict):
        return False
    if "enabled" in entry:
        return not bool(entry["enabled"])
    return bool(entry.get("disable", False))
```

#### 4.2.2 应用到 4 处导入代码

| 文件/函数 | 改动 |
|---|---|
| `character_import_service.py:_create_worldbook_from_character_book` L649/678 | `if entry_is_disabled(entry): continue` |
| 同 L686 | `is_disabled = entry_is_disabled(entry)` |
| 同 L722-723 | `keys=json.dumps(entry_keys(entry))`、`secondary_keys=json.dumps(entry_secondary_keys(entry))` |
| `worldbook.py` L311/353 | `if entry_is_disabled(entry): continue` |
| 同 L371-372 | `keys=json.dumps(entry_keys(entry))`、`secondary_keys=json.dumps(entry_secondary_keys(entry))` |
| `silly_tavern.py:_persist_worldbook_from_data` L5837 | `if entry_is_disabled(entry): continue` |
| 同 L5851-5852 | `keys=_json_dumps(entry_keys(entry))`、`secondary_keys=_json_dumps(entry_secondary_keys(entry))` |
| 同 L5860 | `enabled=not entry_is_disabled(entry)` |
| `silly_tavern.py:_create_stage_from_st_entry` L4503-4504 | `keys=_json_dumps(entry_keys(entry))`、`secondary_keys=_json_dumps(entry_secondary_keys(entry))` |
| 同 L4512 | `enabled=not entry_is_disabled(entry)` |

注：`_create_stage_from_st_entry` 处理 ST 前端内部格式，helper 兼容后行为不变（内部格式无 `keys`/`enabled` 时回退到 `key`/`disable`）。

### 4.3 P3：EJS 模板语法剥离

#### 4.3.1 新增剥离函数

文件：[worldbook_service.py](file:///d:/项目/Palink-AI/backend/app/services/worldbook_service.py)（引擎层，两模式均生效）

```python
_EJS_BLOCK_RE = re.compile(r"<%(?:_|=|-|#|!)?[\s\S]*?%>", re.IGNORECASE)

def strip_template_syntax(text: str) -> str:
    """剥离 EJS/underscore 模板语法块（<%_ ... _%> / <% ... %> / <%= ... %> 等）。
    剥离后清理残留空行，保留其余内容原样。"""
    if not text:
        return text
    cleaned = _EJS_BLOCK_RE.sub("", str(text))
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()
```

#### 4.3.2 应用位置

在 `build_worldbook_context` 的"按位置分组"循环（[worldbook_service.py:1537-1557](file:///d:/项目/Palink-AI/backend/app/services/worldbook_service.py#L1537-L1557)）中，对每个激活条目做一次 `content = strip_template_syntax(entry.content or "")`，再按 position 分组，覆盖 `entries_by_position` / `depth_entries` / `em_top/bottom` / `outlet_entries` 全部注入路径。**扫描匹配用原始 content 不变**（避免影响 `@@` 装饰器解析与递归缓冲语义）。

### 4.4 数据回填脚本

文件：[backend/scripts/backfill_worldbook_from_raw_card.py](file:///d:/项目/Palink-AI/backend/scripts/)

逻辑：
1. 遍历 `characters`，读取 `extensions.palink_raw_card_data`（优先）或 `extensions.character_book`。
2. 解析 `character_book.entries`（dict 或 list），按 `comment` 匹配同名 `world_book_stages` 条目（按 `character_id` → `world_books.character_id` 关联）。
3. 回填：`keys`、`secondary_keys`、`enabled`（用 4.2.1 的 helper 解析原始条目）。
4. 幂等：重复运行安全；只更新匹配到的条目，输出变更统计。

运行方式：`docker exec palink-ai-backend-1 python -m scripts.backfill_worldbook_from_raw_card`。

### 4.5 切换 admin 模式

修复验证通过后执行 SQL（**有意的修复动作，非误改**）：

```sql
UPDATE user_settings SET silly_tavern_mode='st-compat' WHERE user_id=1;
```

理由：admin 未开启 `show_character_status`、未启用 `use_custom_prompts`、`instruct_enabled` 为空，切换到 st-compat 无功能损失；且这是让用户立即体验 ST 对齐装配的必要步骤。

---

## 5. 测试计划（TDD：先写失败测试）

新增/修改测试文件（`backend/tests/`），逐项先跑红再跑绿：

| 测试 | 内容 |
|---|---|
| `test_st_mode_normalization.py` | `_normalize_silly_tavern_mode("st-compat") == "st-compat"`；`"compat"` 保留；`_is_st_compat_mode("compat") is True`；`_is_st_compat_mode("palink-native") is False` |
| `test_worldbook_import_field_compat.py` | `entry_keys`/`entry_secondary_keys`/`entry_is_disabled`：ST 导出格式（`keys`/`enabled`）与内部格式（`key`/`disable`）均正确解析；`_create_worldbook_from_character_book` 导入后 `keys` 非空、禁用条目 `enabled=False` |
| `test_worldbook_template_strip.py` | `strip_template_syntax` 剥离 `<%_ if (...) { _%>...<%_ } _%>`、保留正文、清理空行；`build_worldbook_context` 注入文本不含 `<%` |
| `test_st_compat_assembly_order.py`（已有） | 回归：确认不破坏 |

运行：`docker exec palink-ai-backend-1 python -m pytest tests/ -q`。

前端验证：`npx tsc --noEmit` + `npm run build`。

---

## 6. 验证计划

1. 后端：pytest 全绿。
2. 前端：`tsc --noEmit` 通过、build 成功。
3. 重建后端容器（`docker compose build backend && docker compose up -d backend`），重导/回填数据后：
   - `world_book_stages` 中"我被猫娘包围了！"条目 `keys` 非空、`[initvar]变量初始化勿开` 为 `enabled=False`。
   - 对"猫娘"会话运行 worldbook 扫描，关键词条目按 `keyword_match` 激活，`[initvar]` 条目跳过。
   - 对"妈妈文学"卡扫描，注入文本不再含 `<%_`/`<%`。
4. 手工验证：admin 切换到 st-compat 后发起一条角色对话，打开模型日志确认 prompt 顺序为 main→worldInfoBefore→persona→description→personality→scenario→worldInfoAfter→examples→history→jailbreak，且无 Palink 特有指令（角色校准/最后提醒/声音描述/标题/状态栏）。

---

## 7. 风险与回滚

| 项 | 风险 | 缓解 |
|---|---|---|
| P1 改动影响装配层 10 处判断 | 中 | 抽公共 helper、统一替换；`palink-native` 行为完全不变；仅 `st-compat`/`compat` 模式改变 |
| 前端三态 UI | 低 | 参照已有分段按钮风格；类型扩展向后兼容 |
| P2 导入行为变化 | 低 | 仅修正字段解析，不改变存储结构；旧数据由回填脚本修复 |
| P3 剥离模板 | 低 | 仅剥离 `<%...%>` 语法块，正文保留；扫描匹配不受影响 |
| admin 切换 st-compat | 中 | 切换前确认 admin 未用 Palink 特有功能（已验证）；可随时切回 |

回滚：各改动独立成 commit；如需回退，`git revert` 对应 commit + 重建容器即可。

---

## 8. 实施顺序

1. 写 spec（本文档）✅
2. TDD 红：新增 3 个测试文件
3. 实现 P1（后端归一化 + 装配层 helper + 前端）
4. 实现 P2（helper + 4 处导入）
5. 实现 P3（剥离函数 + worldbook_service 应用）
6. 跑绿 + 回归
7. 回填脚本 + 执行
8. 重建容器、切换 admin、最终验证
