# REPORT — MVU 补齐第一波（P1 / P0-1 / P0-2 门 B）

- 日期：2026-10-05
- 批次：第一波（零冲突三项）
- 上游：`docs/PROMPT_MVU兼容补齐_交给Agent_2026-10-05.md`
- 相关：`docs/SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md`
- 一句话：**事件名对齐 + 读优先级 + save 覆写门，三项全做；`mag_command_parsed` 按用户裁定的理由留空；P3-e 经取证维持插件原值。**

---

## 0. 三十秒速览

| 项 | 结果 | 证据 |
|---|---|---|
| **P1** 卡脚本 MVU 事件名对齐契约 | ✅ 已做 | 3 常量处 + 5 emit 处全改；新增 8 例（含真行为断言） |
| **P1** 补 `mag_variable_initiailized` | ✅ 已做 | iframe 轨由父页面首次 context-update 打 `mvuInit` 触发；内联轨由挂载后首次变量下发触发 |
| **P1** 补 `mag_before_message_update` | ✅ 已做 | 紧邻 `mag_variable_update_ended` 之后 emit |
| **P1** `mag_command_parsed` | ⛔ **刻意留空** | 用户 2026-10-05 裁定：补丁 ≠ 命令、时序已晚，emit 是假活 |
| **P0-1** 读优先级倒挂 | ✅ 已做 | `silly_tavern.py` `_chat_header`，5 例 + 反证 |
| **P0-2 门 B** save 整包覆写 | ✅ 已做 | `silly_tavern.py` `POST /api/chats/save`，含反向守卫 |
| **P3-e** 清理默认值 | ⛔ **不改** | 用户裁定「与 ST 一致」；取证见 §4 |
| 门禁 | 见 §5 | `failed = 0` |

**未做（本批范围外）**：P0-2 门 A、P2 编辑面板、P3-a/b/c/d —— 理由见 §6。

---

## 1. 开工前核对：SPEC 说的对不对

SPEC 是上一轮只读研究写的。动手前逐条回源码核对（SOP §三），结论：

| SPEC 断言 | 核对结果 |
|---|---|
| P0-1 倒挂 `silly_tavern.py:1337` | ✅ 属实未修。**另有一处同名 `_chat_header`（`st_sync_service.py:282`）不合并 ChatVariable，无此问题 → 是单点，改了不牵连** |
| P0-2 门 A `character_ext.py:2708` | ✅ 属实（`existing.update(body)`，无白名单） |
| P0-2 门 B | ✅ 属实，**且比 SPEC 写的更狠**：payload 无 `chat_metadata` 条目时 `persisted_metadata` 保持 `{}`，只回填 `palink_*`，`variables`/`note_prompt` 整份丢 |
| P1 事件名 | ✅ 属实，frontend/src 零 `mag_` |
| P2 端点 | ✅ 全仓零命中 |
| **P3-a 世界书过滤** | ❌ **SPEC 写错**：`merge_character_book_entries:994` 入参是 `list[str]`（entry 正文），**函数内根本没有 `enabled` 字段**。过滤点在 3 个调用方 |
| P3-e 默认值 | ✅ 属实 |

### 1.1 三个前提变化（SPEC 写完之后发生的）

1. **批次 A 已被并行 agent 做完并上线**（未提交）：`mvu_secondary.py` 三参数+重试、`alembic 0068`、`MVU_STAT_LOOKBACK_LIMIT`、`mvuSecondaryFeedback.ts`。**本批没有重做。**
2. 它还修了两个真 bug：`trigger_mvu_secondary` 缺 `WorldBook` 导入 → 端点**恒 500**；`_load_effective_stat_data` 里 `extra` 是 Text 字符串、`isinstance(extra, dict)` 恒 False → **消息级快照从未取到过，一直静默回落会话级**。
3. 它的改动**尚未提交**。这是本批只挑零冲突三项的直接原因（见 §6）。

---

## 2. P1 做了什么

### 2.1 事件名对齐

契约出处（仓内可复核）：`st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.mvu.d.ts`。
事件总线以**事件字符串本身**为 key，值不对 = 卡脚本 `eventOn(Mvu.events.X)` 永远收不到。

| 常量 | 契约真值 |
|---|---|
| VARIABLE_INITIALIZED | `mag_variable_initiailized` ⚠️ 原文拼写，照抄未「修正」 |
| VARIABLE_UPDATE_STARTED | `mag_variable_update_started` |
| COMMAND_PARSED | `mag_command_parsed` |
| VARIABLE_UPDATE_ENDED | `mag_variable_update_ended` |
| BEFORE_MESSAGE_UPDATE | `mag_before_message_update` |

改动位置：

| 文件 | 改了什么 |
|---|---|
| `SillyTavernCompatRuntime.ts` | 顶部新增 `MVU_EVENT_KEYS` 常量；emit 点 3 处（INITIALIZED / STARTED / ENDED / BEFORE_MESSAGE_UPDATE）；`window.Mvu.events` 由 `window.Mvu.events \|\| {...}` 改为 `Object.assign({}, window.Mvu.events, MVU_EVENT_KEYS, ...)` |
| `legacy-st-sim.ts` | 顶部新增 `MVU_EVENT_KEYS`；emit 点 2 处；`window.Mvu.events` 改同款合并 |
| `inline-st-globals.ts` | 导出 `MVU_EVENT_KEYS`；`setInlineStVariables` 按 started→ended→before_message_update 顺序 emit；新增 `emitInlineStVariablesInitialized()` |

**顺带修好一个 SPEC 没点出的问题**：`SillyTavernCompatRuntime.ts` 原写法是
`events: window.Mvu.events || {...}` —— 插件装过 MVU 时我们**完全不注入**，
契约值能否生效全看插件给不给。改为合并且契约值在最后（常量不是实现，必须以契约为准）。

**`CHAT_VARIABLES_UPDATED` 未动**（三处都有，是自家事件，有守卫用例钉住）。

### 2.2 `mag_variable_initiailized` 的时机（不靠猜）

SPEC 建议的钩子点是 `palink:mvuVariablesUpdated`，但那 4 处都是**每轮消息**触发，不是会话初始化。
若按「本帧第一次收到 variables」来判定，iframe 重载/重挂时会误发，让卡脚本以为要重新初始化。

改为**父页面显式打标记**：

- `CharacterCardRenderer.tsx`：新增 `mvuInitPendingRef`，帧加载后的**首次** `context-update` 带 `mvuInit: true`；`handleFrameLoad` 复位（文档重建 = 帧内运行时是新实例）。
- `SillyTavernCompatRuntime.ts`：收到 `data.mvuInit` 置 `mvuInitPendingCompat`，下一轮带 variables 的更新据此 emit 一次后自清。
- 内联轨：`InlineCardRenderer.tsx` 用 `mvuInitPendingRef` 在挂载后首次变量下发时调 `emitInlineStVariablesInitialized()`。

### 2.3 `mag_command_parsed` 为什么留空（已登记）

数据其实拿得到 —— SPEC §7 担心消息序列化白名单过滤 `extra`，实测
`_extra_without_swipe_info`（`character_ext.py:272`）是**黑名单**（只剔 `swipe_info`），
`mvu_patch` 会随消息下发到前端。**但拿到也不能用**：

| 维度 | 契约要求 | 我们的实际 |
|---|---|---|
| 载荷结构 | 命令对象 `{type, full_match, args:[路径,值], reason}` | 已应用完的 JSON Patch `{op, path, value}` |
| 时序 | **应用前**拦截改写（卡脚本靠 `command.args[0].replace()` 修 Gemini 插的横杠） | 事件到达时变量早已落库 |

卡脚本改了 commands 不会有任何效果。emit 出来是一个「看起来能用」的钩子 —— 比不做更糟。
用户 2026-10-05 裁定：**留空并登记**。要真实现，需把解析搬到事件可拦截的位置，属独立议题。

---

## 3. P0-1 / P0-2 门 B 做了什么

### 3.1 P0-1 读优先级（`silly_tavern.py` `_chat_header`）

```python
# 改前（ChatVariable 行后写覆盖，优先级反而更高）
merged_variables = dict(base_variables)
merged_variables.update(db_variables)

# 改后（chat_metadata 真源胜出，DB 行只补缺）
merged_variables = dict(db_variables)
merged_variables.update(base_variables)
```

只改了这一处。已确认 `st_sync_service.py:282` 的同名 `_chat_header` **不合并 ChatVariable**，
无同类问题（SOP §三：按符号名 grep，确认没有遗漏的第二处实现）。

### 3.2 P0-2 门 B（`POST /api/chats/save`）

payload 没带 `chat_metadata` 条目 = 客户端不是在做整包覆盖（插件 `setChatMessages` 走
`slice(1)` 把 header 切掉，天然不带）。此时改成**不碰 metadata**（把既有值回填进
`persisted_metadata`），而不是只回填 `palink_*`。

配了一条**反向守卫** `test_save_with_metadata_entry_still_replaces`：带了条目时仍照常整包替换 ——
防止「修过头」把合法的整包覆盖也禁掉。

---

## 4. P3-e 取证：为什么不改

用户口径「我们要和 ST 保持一致，所以看他们是怎么做的」。从插件 bundle
（`backend/data/smart_card_assets/0c646fb31a…js`）提取到的 schema 原文：

```js
自动清理变量: At.object({
  启用:                   At.boolean().default(!0),   // true
  快照保留间隔:           At.number().default(50),     // 50
  要保留变量的最近楼层数:  At.number().default(20),     // 20
  触发恢复变量的最近楼层数: At.number().default(10)     // 10
}).loose().prefault({})
```

且首次运行会弹通知后**显式** `settings.自动清理变量.启用 = !0`。

⇒ `mvu_cleanup.py:46-49` 的 `True / 20` **与插件逐项一致**。**P3-e 维持现状不改**，
`SPEC_变量自动清理_MVU对齐` 里「默认关闭 + ≥30」那条按用户口径作废。

⚠️ **但有一条不变量要盯**：保留 20 < 回看窗口 30（`MVU_STAT_LOOKBACK_LIMIT`）。
安全依赖「删除/回退时从最近锚点重演恢复」（`mvu_cleanup.run_restore_for_session`，
清理 agent 已实现并在删楼处接入）。**若那条恢复链路失效，被清过的楼层会滑进回看窗口，
找不到快照 → 静默回落会话级。** 建议后续补一条针对该不变量的端到端用例。

取证脚本留档：`backend/scripts/_probe_mvu_plugin_defaults.py`（只读探针，可复跑）。

---

## 5. 门禁与反证

### 5.1 反证（改坏 → 变红 → 还原 → 复绿）

后端（`tests/test_mvu_read_priority_and_save_gate.py`）：

```
# 改回旧写法后
FAILED tests/test_mvu_read_priority_and_save_gate.py::test_chat_metadata_wins_over_chat_variable_rows
FAILED tests/test_mvu_read_priority_and_save_gate.py::test_save_without_metadata_entry_keeps_variables
2 failed, 3 passed

# 还原后
5 passed
```

两条主回归精确变红，另 3 条守卫/反向守卫仍绿 —— 说明断言确实指向被改的那两处行为。

前端（`__tests__/mvu-event-names.test.ts`）：

```
# 把 inline 模块的 VARIABLE_UPDATE_ENDED 改回旧值后
× inline 模块导出的常量与契约逐字一致
× window.Mvu.events 暴露契约值（卡脚本按常量订阅能取到）
× setInlineStVariables 会按 started → ended → before_message_update 顺序派发契约事件
Tests  3 failed | 5 passed (8)

# 还原后
Tests  8 passed (8)
```

第三条是**真行为断言**（装 globals → 按契约常量订阅 → 触发 → 断言回调被调用），不是字符串匹配。

### 5.2 门禁

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **59 文件 / 773 passed / 3 skipped / 0 failed** |
| `py -3 -m pytest tests/ -q` | 见下 |

⚠️ 后端全量跑完时 safe-delete 守卫拦截了 pytest 临时目录的批量删除（count=62 > 50），
截断汇总行并把退出码带成 1。已按 SOP §12.5 改用 junit 报告取权威数字（结果见交付说明）。

### 5.3 全仓复查（SOP §8.3）

按清单改完再 grep 一遍：`frontend/src` 内已**无** `'VARIABLE_UPDATE_ENDED'` 形式的旧字面量，
残留命中全是注释或 `MVU_EVENT_KEYS.X` 引用。

顺带发现两条佐证（说明这个修复打到了真痛点）：

- `cardVariables.ts:9` 卡脚本原文就是 `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => populateLutiyaData())`
- `Message.tsx:1645-1648` 已有注释记录了「context-update → VARIABLE_UPDATE_ENDED 不 emit → 面板停在首帧」的排查链

---

## 6. 没做什么，为什么

| 项 | 状态 | 原因 |
|---|---|---|
| **P0-2 门 A**（`character_ext.py:2708`） | 未做 | 该文件有并行 agent 的**未提交**改动（+123 行）。叠加编辑就是自找冲突 |
| **P2** 变量编辑面板 | 未做 | 新端点落 `character_ext.py`（同上），且 SPEC 明确要求「必须在 P0-1 / P0-2 之后」—— 门 A 还没修 |
| **P3-a** 世界书过滤 | 未做 | 落 `mvu_engine.py`（已被并行 agent 改动）；且 SPEC 给的落点是错的（见 §1） |
| **P3-b** 重新初始化端点 | 未做 | 落 `character_ext.py` |
| **P3-c** 角色卡级设置覆盖 | 未做 | 需先从卡 bundle 核出真实键名（面板中文文案与代码键名不一一对应） |
| **P3-d** 生成链路失败通知 | 未做 | 需新增 SSE/WS 事件类型，与清理 agent 的「阶段 4 通知」有重叠，需先划边界 |
| **P3-e** 清理默认值 | ⛔ 不改 | 用户裁定，见 §4 |
| **真机验证** | ⚠️ **本批未做** | 未重建 dist、未重启容器。见 §7 |

---

## 7. 如实标注

1. **未做真机验证。** 本批改了前端（`SillyTavernCompatRuntime.ts`、`legacy-st-sim.ts`、
   `inline-st-globals.ts`、`CharacterCardRenderer.tsx`、`InlineCardRenderer.tsx`），
   **按 AGENTS.md 必须重建 dist 并确认容器服务新指纹**。本批**没有做 dist 重建**，
   所以这些改动**目前未上线**。重建要走 `VITE_OUT_DIR=dist_new_*` → 原地覆盖 → gzip，
   **不能直接 `npm run build`**（首步 clean-dist 会被 safe-delete 守卫拦到一半，站点白屏）。
2. 后端改动（`silly_tavern.py`）同理需 `docker compose build backend && up -d backend` 才生效。
3. `mag_command_parsed` **未实现**，原因已登记在 §2.3 与三处代码注释里，不等同于「遗漏」。
4. 本批未触碰变量写入链路（`replaceMvuData` / `setVariable` 等），变量真源与写入语义未变。
