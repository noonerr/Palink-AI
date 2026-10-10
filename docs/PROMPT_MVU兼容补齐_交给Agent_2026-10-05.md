# 交接提示词 — Palink 补齐 MVU 插件能力差距

> 用法：把本文件**整份**交给执行的 Agent（或直接把路径给它）。文件是自包含的，
> 执行者不需要任何额外上下文。仓库：`D:\项目\Palink-AI`。

---

## 0. 你的任务

在一个 AI 角色扮演平台（Palink-AI）上，补齐**第三方 MVU 变量插件（MagVarUpdate）**已有、
但我们还没做到的能力。上一批已经做完主干（解析 / 存储 / 进提示词 / 分支回退 / 副模型参数 / 变量清理），
**本批要补的是剩下的 6 项**，按 P0 → P3 优先级执行。

**先做 P0，再做 P1。P0 是 P2 的前置条件，不修 P2 白做。**

---

## 1. 开工前必读（按顺序）

1. `AGENTS.md` —— 主攻方向 + **§备份与清理规范（强制）** + 门禁基线
2. `docs/SOP_Agent交付自查清单.md` —— **声称「已完成」前必读**
3. `docs/REPORT_MVU插件设置项与Palink对应关系_2026-10-05.md` —— 差距清单的出处
4. `docs/SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md` —— 本批的详细方案
5. `docs/REPORT_MVU变量框架与Palink自有变量体系重叠专题_2026-10-04.md` §5、§8 —— **P0 两扇门的原始取证**

---

## 2. 铁律（违反即事故，不要问「能不能通融」）

### 2.1 备份

1. 唯一备份区 `_BACKUPS/YYYY-MM-DD_主题名/`，**禁止**在根目录 / `D:\` / `D:\项目\` 另建。
2. 每个备份目录**必须**含 `BACKUP_INFO.md`，四要素缺一不可：① 备份日期 ② 原始来源路径 ③ 备份原因 ④ 后续待办清单。
3. 备份完成后**必须**在 `_BACKUPS/_INDEX.md` 追加一行。
4. **禁止改写已有备份的内容**。需要补说明就**新增文件**（如 `_POST_WORK_NOTE.md`），不要改 `BACKUP_INFO.md`。
5. 改动类备份用 `pre/`（按原相对路径）+ `_manifest.tsv`（sha256）。
6. **清理三步**：列清单 → 隔离到 `_BACKUPS/_QUARANTINE_<日期>/`（保留原相对路径）→ 门禁通过且用户确认后才删。**禁止直删**。

### 2.2 提交

- 逐项 `git add -- <path>`。**严禁 `git add -A` / `git add .`**（多 agent 合住仓库）。
- **提交 ≠ 上线**：改后端要 `docker compose build backend && docker compose up -d backend`；
  改前端要重建 dist 并确认容器服务**新指纹**。

### 2.3 环境坑（全部实测踩过，别重犯）

| 坑 | 表现 | 正确做法 |
|---|---|---|
| ★ **`npm run build` 会损坏 dist** | 首步 `clean-dist` 先删后建，被 safe-delete 守卫在第 50 个文件处中断 → **dist 被删掉一部分，站点白屏** | **禁止直接 `npm run build`**。必须：`VITE_OUT_DIR=dist_new_<批次> node scripts/build-vite.mjs` → `cp -r dist_new_<批次>/. dist/`（纯增量）→ `node scripts/gzip-dist.cjs`。**重建前先整份备份 `frontend/dist`** |
| **safe-delete 守卫** | 按「agent 轮次」计数，阈值 50，报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。被拦时抛 `SystemExit` → **依赖删文件的用例直接变红** | 已知 3 例会因此红（`test_admin_image_cleanup.py` 2 例 + `test_c_batch_security_hygiene.py` 1 例），**它们单独跑全绿，别当成代码回归**。`--basetemp` **躲不掉**（计数与路径无关） |
| **`docker exec` 路径** | Git Bash 下路径被转换，`pg_dump` 报 No such file | 加 `MSYS_NO_PATHCONV=1`；但 `docker cp` 的宿主路径**不能加** |
| ★ **模板字符串禁反引号** | `SillyTavernCompatRuntime.ts` / `sillyTavernPluginRuntime.ts` 把整段 setup 脚本写成一个大模板字符串，注释里写反引号会**提前终止模板** → esbuild 报 `Expected ";" but found "if"`，**vitest 连配置都加载不了** | 改这两个文件前，扫一遍新写的注释里有没有反引号；描述代码用「」代替。模板字符串内也不要写 `${` |
| **`extra` 是 JSON 字符串不是 dict** | `character_chat_messages.extra` 列类型是 `Text`，取出来是 `str`。直接 `isinstance(extra, dict)` **恒为 False** | 判空/取值前先 `json.loads`。同类字段：`swipes`、`chat_metadata`、`silly_tavern_settings` |
| **后端用系统 `py -3`** | WorkBuddy 托管 python 没装 pytest | `cd backend && py -3 -m pytest tests/ -q` |
| **heredoc 吃反斜杠** | `py -3 - <<'PY'` 跑含 `\r?\n`、`\n` 的脚本会静默匹配不上 | 多行字符串替换 / 正则 / 路径拼接，**写成脚本文件再 `py -3 <file>` 跑** |

---

## 3. 任务清单

### P0-1 · 修「读优先级倒挂」【**必须先做，否则 P2 白做**】

**现状（已核实未修）**：`backend/app/api/silly_tavern.py:1337-1339`

```python
merged_variables = dict(base_variables)      # base = chat_metadata.variables（MVU 引擎写的，真源）
merged_variables.update(db_variables)        # ← ChatVariable 表「后写覆盖」，优先级反而更高
metadata["variables"] = merged_variables
```

**后果**：只要历史上任何一次 `saveChat` 带着 `variables` 落过一行 `ChatVariable(key="stat_data")`，
那行的值就**永久遮蔽**此后 MVU 引擎对 `chat_metadata.variables` 的所有更新。
现场表现就是「**变量明明更新了，但面板/读接口拿到的是旧值**」。

**改法**：整包键（`variables` / `variables.stat_data`）**以 `chat_metadata` 为准**；
`ChatVariable` 行**只补 `chat_metadata` 里没有的键**（不要整体 update）。

**验收（反证，必做）**：
1. 建会话 → 让 `ChatVariable` 落一行 `stat_data`
2. 直接改 `chat_metadata.variables.stat_data.某字段 = 新值`
3. 读回**必须是新值**（改前会读回旧值）
4. 把修改还原 → 断言必须重新变红

---

### P0-2 · 关掉两扇「整包覆写门」【**P2 的前置**】

**门 A（已核实未修）**：`backend/app/api/character_ext.py:2729` `PUT /api/character-sessions/{id}/metadata`

```python
existing = json.loads(session.chat_metadata) if session.chat_metadata else {}
existing.update(body)        # ← 顶层浅合并：body 带 "variables" 键 = 整包替换 variables 子树
```

无键白名单、无大小限制、无 schema 校验。而前端调用方（`getContext.ts:1515-1523`）送的是**整个**
`window.chat_metadata` → 任何让 `window.chat_metadata.variables` 变成「插件局部视图」的路径，都会把整份 stat_data 换掉。

**改法**：加键白名单（至少禁 `variables` / `palink_injections`），或只允许插件自己的命名空间键。

**门 B（已核实未修，更危险）**：`backend/app/api/silly_tavern.py:2932-2940` `POST /api/chats/save`

```python
persisted_metadata = {}
...
if "palink_injections" in existing_meta and "palink_injections" not in persisted_metadata:
    persisted_metadata["palink_injections"] = existing_meta["palink_injections"]
session.chat_metadata = json.dumps(persisted_metadata)   # ← 只保 palink_injections，其余整份丢弃
```

而插件的 `setChatMessages`（`frontend/src/utils/sillyTavernPluginRuntime.ts:541/573`）送的 payload
**恰好不带 `chat_metadata` 条目**（`slice(1)` 把 header 切掉了）→ 一调用就把 `variables` / `note_prompt` **整份清空**。
这是**插件热路径**，比门 A 更容易触发。

**改法**：保留清单从「只保 `palink_injections`」扩到「保全部 `palink_*` + `variables` + `note_prompt` + `hidden_bots`」，
**或**改成「payload 无 `chat_metadata` 条目时**不碰** metadata」。

**验收**：两条都要有 pytest 复现（种值 → 触发 → 断言仍在），并做反证。

---

### P1 · 卡脚本事件钩子：名字对齐 + 补齐【性价比最高，改动最小】

**问题**：插件契约的 5 个事件值是 **`mag_` 前缀**，而我们 emit 的是另一套名字。
事件总线（`window.eventSource.on(type, cb)`，`SillyTavernCompatRuntime.ts:5657`）**以事件字符串本身为 key**
→ 卡作者写 `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, ...)` **永远收不到**。
**全仓 `frontend/src` 零命中 `mag_`** —— 这些事件是「假活」。

**契约原文**：`st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.mvu.d.ts`（约 57-118 行）

| 事件 | 契约真值 |
|---|---|
| VARIABLE_INITIALIZED | `mag_variable_initiailized` ⚠️ **契约里就是这么拼的（initiailized），照抄，别"修正"** |
| VARIABLE_UPDATE_STARTED | `mag_variable_update_started` |
| COMMAND_PARSED | `mag_command_parsed` |
| VARIABLE_UPDATE_ENDED | `mag_variable_update_ended` |
| BEFORE_MESSAGE_UPDATE | `mag_before_message_update` |

**要改的位置（常量 3 处）**
- `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts:6013-6014`
- `frontend/src/components/ui/custom/smart-card-runtime/frame-shim/legacy-st-sim.ts:1128-1129`
- `frontend/src/components/ui/custom/smart-card-runtime/inline/inline-st-globals.ts:464-465`

**要改的位置（emit 5 处）**
- `SillyTavernCompatRuntime.ts:4493`
- `legacy-st-sim.ts:560`、`legacy-st-sim.ts:1161`
- `inline-st-globals.ts:331`、`inline-st-globals.ts:434`

**补齐 3 个缺失事件**
- `mag_variable_initiailized`：会话初始化拿到 stat_data 时（前端现成时机：`palink:mvuVariablesUpdated`，
  见 `frontend/src/hooks/useCharacterChat.ts:466-482`，另有 833 / 1031 / 1402 三处同源）
- `mag_before_message_update`：紧邻 `mag_variable_update_ended` 的 emit 点
- `mag_command_parsed`：**需要 patches**。后端已在落库时留存 `msg.extra["mvu_patch"]`
  （`backend/app/api/websocket.py:772-778`，由变量清理批次加入）——
  **先确认它是否随消息接口下发到前端**（查 `character_ext.py` 的消息序列化是否白名单过滤 `extra` 键）；拿不到就先留空实现并登记。

**不要动**：`CHAT_VARIABLES_UPDATED`（三处都有，那是自家事件）。

**安全性**：已 grep `st-plugins/` 全量，**无硬编码** `'VARIABLE_UPDATE_ENDED'` 字符串（订阅方都走常量取用）
→ 常量与 emit 同步改即一致，**不会打断现有订阅者**。

**验收**：新增单测，断言「常量值与契约一致」+「emit 时用的 key 与常量一致」。
**反证**：把某个 emit 的 key 改回旧值 → 断言必须变红。

---

### P2 · 变量编辑面板（**依赖 P0-1 + P0-2**）

**现状**：`frontend/src/components/ui/custom/TavernHelperPanel.tsx` 纯只读（全文件只有一个折叠 `onClick`）。
插件有「变量查看**兼编辑**」面板，我们只能看不能改。

**后端新端点**：`POST /api/character-sessions/{id}/variables/patch`
- body：`{ patches: list[dict] }`
- 复用 `backend/app/services/mvu_engine.py` 的
  `apply_patches(stat_data: dict, patches: list[dict], *, readonly_prefix="_") -> tuple[dict, list[str]]`
  （深拷贝上顺序应用，支持 `replace/add/insert/remove/move/delta`，`_` 前缀路径只读跳过）
- 鉴权 + 校验 session 归属 → 读 `chat_metadata.variables` → `apply_patches` → 回写 → commit
- **不要**复用 `apply_mvu_reply_to_session` 整函数（它会强制走 init 兜底并解析正文）；
  只抽它「读 session / 解 chat_metadata / 回写」的片段共用

**前端挂载**：`frontend/src/components/ui/custom/Message.tsx` 约 1680-1701，
紧跟 `VariableChangePanel` 之后。条件用 `tavernHelper &&`，**不要**带 `!hasStatusBarScript`
（理由同 `VariableChangePanel` 的注释：这是独立需求，带原生状态栏的卡同样需要）。

**数据链**：`CharacterChat.tsx:377` 的 `sessionVariables` state → `:2100` 传给 `Message`
→ `Message.tsx:175` prop → `:751` 解构 → `:847` 算出 `statData`。
写回需**新增 `onVariablesChange` prop 沿这条链反向传回 `setCurrentVariables`**。

**这是变量写入链路改动，必须单独做、单独验**，且**必须在 P0-1 / P0-2 之后**。

---

### P3 · 剩余 4 项（可分批）

**P3-a 世界书条目过滤**（`backend/app/services/mvu_engine.py`）
- `merge_character_book_entries`（约 994-1021）全量合并，**且连 `enabled=false` 的条目都参与**
  （`_extract_initvar_from_character_book` 约 1142-1159 同样遍历全部）
- **先做零风险的第一步**：跳过 `enabled=false` —— 用户已经点了"禁用"，我们却还在用，这算 bug
- 第二步再加白/黑名单正则（可参考「卡影子 > 用户设置 > 默认」的三层模式，
  见 `roleplay_prompt_assembly.py:684-727` 的 `_get_openai_max_context_override`）

**P3-b 重新初始化入口**
- 现状：`MvuEngine.init_session_variables` 只在**建会话时**跑一次（`character_ext.py:4405-4418`）；
  改了角色卡的 `<initvar>` 只能删会话重建
- 新端点 `POST /{session_id}/mvu-reinit`。⚠️ **破坏性**：加 `mode`（`replace` / `merge`，**默认 merge**），
  仅在无 variables 或 body 带 `force=true` 时才允许 `replace`，并返回前后 diff

**P3-c 角色卡级 MVU 设置覆盖**
- 机制已存在（`backend/app/api/plugins.py:1551` `plugin_extension_settings_by_character`，
  写 `:1582`、读 `:1686`），但后端**只读一项**（`roleplay_prompt_assembly.py:705,723` 只取 `chatCompletionSettings`）
- 照抄「卡影子 > 用户设置 > 默认」三层模式新增读取函数。⚠️ **命名空间名要与插件面板实际键名对齐**
  （面板中文文案与代码键名**不完全一一对应**，先从卡脚本 bundle 里核出真实键名，别自己拟）

**P3-d 生成链路失败通知**
- 现状：所有变量链路失败**只进服务端日志**，用户完全无感
- 手动路径已有通道（响应字段 `reason`）；**自动生成链路无通道**，需新增 SSE/WS 事件类型
- 基础设施现成：sonner（`App.tsx:4,1160`）+ 插件运行时桥（`sillyTavernPluginRuntime.ts:500-512`
  `window.__palinkToastSuccess/Error/Info`）

**P3-e 变量清理的默认值（需用户拍板，不要自己决定）**
- `backend/app/services/mvu_cleanup.py:46-49` 现在用**插件原值**：`DEFAULT_ENABLED=True`、`DEFAULT_KEEP_RECENT_FLOORS=20`
- 但清理方案（`docs/SPEC_变量自动清理_MVU对齐_2026-10-05.md` §5 与红线 5）明确要求
  **默认关闭** + 保留 **≥30（建议 50）**，因为回看窗口是 30
- 实测路径：用户没开过插件设置面板 → 读不到设置 → 回落默认 → **清理默认就会跑，且保留楼层比安全线短**
- 有测试钉住现状（`test_defaults_match_plugin_schema`），**改的话要连那条测试一起改**。
  **此项须先问用户，不要自作主张。**

---

## 4. 明确不要做的事（红线）

| 项 | 为什么 |
|---|---|
| 自定义 **API 地址 / API 密钥** | 会把对话内容发去任意地址 + 绕过额度与审计 |
| **破限方案**（内置破限 / 任意预设） | 语义就是「往上游请求塞任意内容」 |
| 请求方式里的**并行多次请求** | 成倍消耗额度，服务端无法计费归类 |

这三项**不是「没来得及做」，是刻意不给**。不要因为"插件有"就补上。

---

## 5. 门禁（只认 `failed = 0`，数字会漂，别当验收线）

```bash
cd frontend && npx tsc --noEmit        # 期望 exit 0
cd frontend && npx vitest run          # 期望 failed = 0
cd backend  && py -3 -m pytest tests/ -q   # 期望 failed = 0
```

⚠️ 全量 pytest 可能出现 **3 个已知红**（都是删文件类用例被 safe-delete 守卫拦截）：
`test_admin_image_cleanup.py::TestRecursiveCleanup::{test_nested_generated_images_get_cleaned, test_empty_dirs_removed_but_root_kept}`、
`test_c_batch_security_hygiene.py::TestLocalModelUploadLimit::test_over_limit_rejected_413_and_no_partial_file`。
**它们单独跑全绿 → 不是代码回归**，不要为它们改代码。

**反证是硬要求**：每个修复都要「改坏 → 断言变红 → 还原 → 复绿」跑一遍，把输出贴进交付说明。

---

## 6. 交付要求

1. 一份交付报告（`docs/` 下），写清：**做了什么 / 没做什么 / 怎么验的 / 反证输出**。
2. 备份目录 + `BACKUP_INFO.md`（四要素）+ `_INDEX.md` 登记。
3. **如实标注未做项**。特别是：
   - 是否真机验证过（改了前端要重建 dist 并确认新指纹；本环境**不能直接 `npm run build`**，见 §2.3）
   - `mag_command_parsed` 若因拿不到 patches 而未实现，必须写明
4. 逐项 `git add -- <path>` 提交（**禁 `-A` / `.`**）。

**最后一条，也是最重要的一条**：
**不要在没有证据的情况下说「已完成」。** 上一批的教训是——
一个端点因为漏了一行 import 而 `恒 500`，静态读码和单测都没发现，**只有真机跑才暴露**。
交付前请按 `docs/SOP_Agent交付自查清单.md` 逐条自查。
