# REPORT — 包AI · 批次 P（预设分身 / 写时复制）· 2026-10-20

> **状态：P-1 模型 + 后端落地完成（无表结构改动，未触发审批门）；P-2 帧内桥与 P-3 UI 未做（预算转收尾）。**
> 执行方：零上下文执行方（分支 `three-tracks-merge-20261012`，HEAD `2c4c049` 起）。
> 复核方：Qoder「分配分包派遣任务」会话（主脑）。
> 依据：`docs/_active/prompt/PROMPT_对话包_批次P预设分身与Q沙箱放开与R插件_2026-10-20.md`（只做 P）、
> 用户 2026-10-20 三条裁定、台账 `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` §2.2 / 本次新增 §2.3。
> Q / R 未触碰；`CharacterCardRenderer.tsx` 的 sandbox 一行未动（Q 批结论：同源=交出账号）。

## 0. 结论先说

1. **P-1 用"无迁移"方案落地**：会话覆盖层存进既有 `chat_variables`（`session_id`+`key` 唯一）的一行 JSON，
   **没有新建表、没有加列、没有 alembic 迁移** ⇒ 按硬规矩不需要主脑审批即可写码（审批门针对的是不可逆的表结构改动）。
   若要改成独立表，另开一单，本方案的接口形状可原样复用。
2. **写时复制语义已可执行验证**：未改动 ⇒ 不落行、读全局；首次写 ⇒ 生成副本；连写不回写全局；删除 ⇒ 回全局。
3. **P-2 / P-3 未做**：帧内 19 键要注册进 `TavernHelper`，会动 `13 + C + D = 134` 的三层账
   （`h-tavernhelper-134-contract` 的 D 名单 + `st-gap-ledger-reconcile.mjs` 的 `MOVES` + 包H 族表），
   预算内做不完整 ⇒ 按"不许删键、不许放宽名单、不许改产品码凑绿"的红线**整段留到下一批**，不半做。
4. **破甲槽定案**：`ContextTemplate` 确有 `jailbreak` 列（`models/system.py:142`），但装配链**没读它**
   （`roleplay_prompt_assembly.py:4153` 只有一行注释）⇒ "卡覆盖破甲"**当前不可达**，且不是"另造第二套"的问题，
   而是**第一套没接上**。补它要动装配链 + 会话覆盖层，建议单独立项（见 §5）。

## 1. P-1 模型（已落地）

### 1.1 为什么不用新建表

任务书原话："`session 只存'我在哪份之上做了哪些改动'` 或 `fork 时按需复制`（copy-on-write）"。
本仓已有**会话级 KV 存储** `chat_variables`（`models/chat_variable.py:11-22`，`UniqueConstraint(session_id,key)`），
语义正好是"这个会话自己的一份数据"⇒ 直接复用，零迁移。

| 项 | 值 |
|---|---|
| 存储位置 | `chat_variables` 表，`session_id` = 会话 id，`key` = `__palink_internal_preset_overlay_v1` |
| 值形状 | `{name, base_preset_id, base_name, entries, config, created_at, updated_at}` |
| 副本产生时机 | **首次 PUT**（读路径一行都不写） |
| 回写全局 | **永不**：`prompt_presets` 只在 `base_*` 解析时被 **SELECT** |
| 回到全局 | `DELETE /sessions/{id}/preset` 删覆盖层行 |

### 1.2 新增接口（`backend/app/api/prompt_manager.py`）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/prompt-manager/sessions/{session_id}/preset` | 本对话**生效**预设 + `source`（`global`/`session`）+ `is_session_copy` |
| PUT | `/api/prompt-manager/sessions/{session_id}/preset` | 写本对话副本（首次写触发 COW）；可带 `base_preset_id`/`base_name` 换基（仍是复制） |
| DELETE | `/api/prompt-manager/sessions/{session_id}/preset` | 丢弃副本 ⇒ 回全局默认 |

`source` / `is_session_copy` 就是 **P-3 的可见性字段**（"当前用的是全局默认 还是 本对话副本"）。
服务层：`backend/app/services/preset_overlay.py`（模块 docstring 写明这是**有意偏离 ST**）。

### 1.3 顺手修掉的一个污染面

覆盖层行住在 `chat_variables` 里，而 ST 兼容层会把**整张表**合进 `chat_metadata.variables`
（`api/silly_tavern.py` 的合并循环）⇒ 内部簿记会变成卡可见变量。
已在合并处加**前缀让路**：`__palink_internal_` 开头的行不进 `variables`（`silly_tavern.py` 同段注释说明）。
这是"新增宿主自己的行"必须配套的一步，不是顺手改 ST 语义。

## 2. ST 侧一手核对（P-4 要求，逐条带行号）

| 问题 | 一手答案 | 锚点 |
|---|---|---|
| 预管理器真实路径 | `public/scripts/preset-manager.js`（`getPresetManager` 在 `:83`） | `preset-manager.js:83`、`:403` `getSelectedPresetName()` |
| 预设**内容**存哪 | 全局对象表 `openai_settings[openai_setting_names[name]]` | `public/scripts/openai.js:4750` |
| **选中**哪份记在哪 | 全局 settings 字段 `oai_settings.preset_settings_openai`（默认 `'Default'`，载入/导入时写入） | `openai.js:404`、`:4509`、`:4728` |
| 有没有 per-chat 维度 | **没有**（`chat_metadata.preset` 全仓 0 命中） | 故本仓 COW 属**有意偏离** |

⇒ 台账 §2.3 已补登记（ST 锚点 + 本仓做法 + 取舍 + "不要修回去"），代码侧见 `preset_overlay.py` docstring。

## 3. 门禁与测试

### 3.1 门禁退出码

```
$ bash scripts/gate.sh backend
GATE_RC=0
2256 passed, 23 skipped, 431 warnings in 179.01s (0:02:59)
ℹ️ junitxml 显示 failures=0 errors=0
```

（`failed=0`、`errors=0`；23 skipped 为既有环境跳过项，与本批无关。）

### 3.2 新测试（逐文件单跑）

`backend/tests/test_session_preset_overlay.py` — **6 passed**（`--basetemp=/tmp/pb_p5`，仓库外）：

| 用例 | 钉住什么 |
|---|---|
| `test_read_without_overlay_does_not_create_copy` | 未改动 ⇒ `source=global`，且 `chat_variables` **零行**（COW 的"不写不复制"） |
| `test_first_write_copies_and_never_writes_global` | 首次写 ⇒ `source=session`；`prompt_presets` 行**逐字段不变**；行 key 走内部前缀 |
| `test_second_write_still_does_not_touch_global` | 连写两次仍不回写全局 |
| `test_delete_returns_to_global` | 删副本 ⇒ 回全局，全局行仍不变 |
| `test_other_users_session_is_404_and_writes_nothing` | 越权：他人 session 的读/写/删全 404，且**不落行** |
| `test_other_users_preset_cannot_be_used_as_base` | 拿他人 preset 换基 ⇒ 404（否则等于读别人预设内容） |

### 3.3 两组反证（原始输出）

**反证 A —— 让写路径回写全局**（在 `write_overlay` 末尾把 entries 同步写进全局行）⇒ 必须红：

```
A_RC=1
FAILED tests/test_session_preset_overlay.py::test_first_write_copies_and_never_writes_global
FAILED tests/test_session_preset_overlay.py::test_second_write_still_does_not_touch_global
FAILED tests/test_session_preset_overlay.py::test_delete_returns_to_global
3 failed, 3 passed, 21 warnings in 8.68s
```

**反证 B —— 去掉会话归属过滤**（`require_owned_session` 只按 id 查）⇒ 越权用例必须红：

```
B_RC=1
FAILED tests/test_session_preset_overlay.py::test_other_users_session_is_404_and_writes_nothing
1 failed, 5 passed, 21 warnings in 8.61s
```

**还原后**：

```
RESTORED_RC=0
6 passed, 21 warnings in 7.66s
```

## 4. 交回读数

- 门禁：见 `bash scripts/gate.sh backend`（退出码与 `failed=0/errors=0` 原始行随提交记录）。
- 逐文件用例数：`backend/tests/test_session_preset_overlay.py` = **6**（单跑 6 passed）。
- 两组反证：见 §3.3（A 3 红 / B 1 红 / 还原全绿）。
- 边界比对：`git show --stat` 见提交（仅 `preset_overlay.py` 新增、`prompt_manager.py` +3 路由、
  `silly_tavern.py` 前缀让路、新测试、台账 §2.3、目录清单）。
- **真机读数：未取**。`http://localhost:16000/` 实测 `curl` 返回 `000`，且本机 Docker 守护进程未运行
  （`docker ps` → `dockerDesktopLinuxEngine` 管道不存在）；"禁重启 Docker"⇒ 无法拉起后端，
  旁路构建 5222 也就没有可连的后端。故 `TavernHelper=144` / `getContext()=196` / `commands=509` /
  每帧 CSS 5/5 / `window.context===undefined` **全部标"未取"**，不以记忆值充数。
- 前端一行未动 ⇒ 上述零回归面在代码层**没有变化面**（本批只碰后端 + 文档）。

## 5. 未做 / 做不到

| 项 | 状态 | 原因 / 下一步 |
|---|---|---|
| P-2 帧内 19 键（读类 6 + 写类 8…） | **未做** | 注册即改 `13+C+D=134` 三层账：`h-tavernhelper-134-contract.test.ts` 的 `forbidden` 名单、`st-gap-ledger-reconcile.mjs` 的 `MOVES`（含 `cite.lines` 指向文档行号）、包H §3 族表。必须**三层同批**，预算内做不完整 ⇒ 不半做。建议单独排一个"预设族进表"批次 |
| 父侧 `requestParent` 动作（`presetGet/Put/Delete`） | **未做** | 依赖上一条；接口形状已定（§1.2），接线即可 |
| P-3 卡片设置 UI | **部分**：数据面已给（`source`/`is_session_copy`） | UI 未做；卡片设置面板要读这两个字段 |
| P-4 台账 | **已做** | 新增 §2.3 偏离登记 + 代码注释 |
| 破甲槽（`jailbreak_slot`） | **定案：不可达** | `ContextTemplate.jailbreak` 列存在（`system.py:142`），但装配链没读（`roleplay_prompt_assembly.py:4153` 仅注释）⇒ 补它要动装配链，且要与会话覆盖层同源，建议单独立项；**不另造第二套** |
| 真机读数 | **做不到** | 见 §4：16000 不通 + Docker 未运行 + 禁重启 |
| 表结构 / 迁移 | **不需要** | 复用 `chat_variables`，零迁移 |

## 6. 等主脑拍的两件事

1. 覆盖层落点是否接受"复用 `chat_variables` + 内部前缀"（零迁移）；若要求独立表，本方案接口不变、只换存储层。
2. P-2 是否按"预设族进表"单独开批（含三层账 + 父侧动作 + P-3 UI 一起做），还是拆成"读类先上、写类后上"两批。
