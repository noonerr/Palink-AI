# REPORT — MVU 补齐第二波（P2 后端写入端点）

- 日期：2026-10-05
- 批次：第二波（受「不耽误另一个 Agent」约束后的重新排期）
- 上游：`docs/PROMPT_MVU兼容补齐_交给Agent_2026-10-05.md`
- 前置：第一波（`c24017d`，已上线）
- 一句话：**本波只交付 P2 的后端写入端点（落新文件，零占用）；门 A / P2 前端 / P3-a~d 全部因文件被并行 agent 占用而顺延，且其中两项是「刻意不做」而非「来不及」。**

---

## 0. 三十秒速览

| 项 | 结果 |
|---|---|
| **P2 后端端点** `POST /character-sessions/{sid}/variables/patch` | ✅ 已做并上线 |
| **P2 前端编辑面板** | ⛔ 未做 —— 挂载点在被占用文件，且面板无法自取 sessionId |
| **P0-2 门 A** | ⛔ **刻意未做** —— 唯一可行的前端变通会造成回归，理由见 §3 |
| **P3-a / P3-b / P3-c / P3-d** | ⛔ 顺延 —— 落点全在被占用文件 |

---

## 1. 为什么第二波只做了这么一点

开工复核 `git status`：并行 agent 的「变量自动清理 + 批次 A」**仍未提交**，占用：

```
backend/app/api/character_ext.py            backend/app/api/websocket.py
backend/app/services/mvu_engine.py          backend/app/services/character_message_builder.py
backend/app/services/mvu_secondary.py       backend/app/services/roleplay_prompt_assembly.py
frontend/src/components/ui/custom/Message.tsx   frontend/src/components/views/character/CharacterChat.tsx
```

而第二波的**每一个**原定落点都在其中：

| 项 | 原定落点 | 状态 |
|---|---|---|
| P0-2 门 A | `character_ext.py:2708` | 被占 |
| P2 端点 | `character_ext.py`（新端点） | 被占 → **改落新文件** |
| P2 面板挂载 | `Message.tsx:1680-1701` | 被占 |
| P3-a 世界书过滤 | `mvu_engine.py` + 3 个调用方 | 被占 |
| P3-b 重新初始化 | `character_ext.py` | 被占 |
| P3-d 失败通知 | `character_ext.py` / `websocket.py` | 被占 |

空闲的文件只有：`backend/app/api/__init__.py`、`backend/app/api/variables.py`、
`backend/app/api/plugins.py`、`backend/app/main.py`、`frontend/src/lib/sillytavern/getContext.ts`、
`frontend/src/components/ui/custom/TavernHelperPanel.tsx`。

---

## 2. 交付内容：P2 后端写入端点

**新文件** `backend/app/api/mvu_variables_api.py`，经 `api/__init__.py` 两行注册。
路径 `POST /api/character-sessions/{session_id}/variables/patch` 是**全新**的，
与任何既有路由不冲突，因此不需要碰 `character_ext.py`。

| 特性 | 实现 |
|---|---|
| 鉴权 | `get_current_user` + session 归属校验（`user_id` 过滤），不存在/不属于自己一律 404（与 `variables.py` 同口径，防水平越权） |
| 写入对象 | `chat_metadata.variables`（与第一波的 P0-1 读侧同源 —— **读写同源**，改完读得回来） |
| 补丁引擎 | 复用 `mvu_engine.apply_patches` 纯函数，支持 `replace/add/insert/remove/move/delta` |
| 只读保护 | `_` 前缀路径跳过（`readonly_prefix="_"`） |
| **不做的两件事** | ① **不做 init 兜底**：会话未初始化 → 409，而不是用 `<initvar>` 凭空造一份；② **不解析正文**：不复用 `apply_mvu_reply_to_session` 整函数（它会强制 init 兜底并解析 AI 回复） |
| 返回 | `{ok, variables, logs, skipped}` —— 面板可直接拿返回值刷新，不必再读一次 |

### 2.1 为什么「不做 init 兜底」

`apply_mvu_reply_to_session` 会在 variables 为空时用角色卡 `<initvar>` 初始化。
但那是「AI 刚回复完、顺带初始化」的语义；本端点是「用户/面板主动改值」——
会话没初始化过就**不该**凭空造一份，否则会把「空」和「未初始化」这两种状态混为一谈。
故返回 409 让调用方显式先初始化。

---

## 3. 刻意没做的两项（不是「来不及」，是判断后不做）

### 3.1 门 A 不从前端硬凑

门 A 的风险源头在前端：`getContext.ts:1515-1523` 把**整个** `window.chat_metadata`
（含 `variables`）PUT 给那个 `existing.update(body)` 端点 → 整包替换 `variables`。

自然的想法是「从前端把 `variables` 剥掉」。**实测后否决**：

```
前端写 /api/character-sessions/*/metadata 的地方：只有 getContext.ts:1519 一处
会话变量的独立写入端点：无（/api/variables/global 是全局量，不是会话 stat_data）
```

即**这条 PUT 是卡脚本变量写入的唯一落库通道**。剥掉 `variables` = 卡脚本改的变量不再落库 = 回归。
后端键白名单必须在 `character_ext.py` 空出后再补。

### 3.2 P2 前端不做

`TavernHelperPanel` 本身是空闲文件，理论上可以直接改。但编辑需要 sessionId，而它拿不到：

- 无会话 Context（`frontend/src/contexts/` 只有 `RoleplayThemeContext`）
- 无全局 session id（`window.__palink*` 里没有）
- `messageManager` 只有私有的 `_currentSessionId`

要拿到就得改被占用的 `Message.tsx` 传参。**不做半截子**：与其塞一个「永远拿不到 sessionId、
编辑功能恒不生效」的面板（就是第一波刚修掉的那种「假活」），不如等文件空出后一行传参点亮。

---

## 4. 门禁与反证

### 4.1 反证（改坏 → 变红 → 还原 → 复绿）

把 `readonly_prefix="_"` 改成 `""`：

```
FAILED test_patch_applies_and_persists
FAILED test_patch_does_not_touch_sibling_keys
FAILED test_readonly_underscore_prefix_is_skipped
3 failed, 3 passed
```

还原后 `6 passed`。

⚠️ **过程中修正了自己一个不严谨的断言**：最初 `test_readonly_underscore_prefix_is_skipped`
只断言「`_` 前缀的值没变」。但 `readonly_prefix=""` 会导致**所有**路径被跳过，
值同样不变 → 该用例**照样绿**，无法证伪（违反 SOP §7.3）。
改为**同一批发两条补丁**（一条只读 `/_meta/v`、一条正常 `/角色/络络/好感度`），
同时要求「只读的没变」且「正常的确实变了」，该用例才单独变红。

### 4.2 门禁

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **59 文件 / 773 passed / 3 skipped / 0 failed** |
| `py -3 -m pytest tests/ -q` | **1920 tests / 0 failures / 0 errors / 51 skipped**（较上轮 1914 +6） |

### 4.3 上线验证（2026-10-05 03:4x）

| 步骤 | 结果 |
|---|---|
| 后端重建 | `docker compose build backend` → `up -d backend` → Up (healthy) |
| 端点注册（容器内） | `app.openapi()['paths']` 命中 `/api/character-sessions/{session_id}/variables/patch` |
| 后端日志 | 重启后无 traceback / error |
| 前端 dist | **本波未改前端文件，无需重建** |

---

## 5. 两条踩坑留档（可复跑验证）

1. **`apply_patches` 的 path 是相对 `stat_data` 的。**
   内部 `target = stat_data.get("stat_data", stat_data)`，应用完再 `result["stat_data"] = target`。
   写成 `/stat_data/角色/好感度` 会多套一层 `stat_data.stat_data.角色`。
   探针：`backend/scripts/_probe_apply_patches.py`。

2. **本仓 FastAPI 版本下 `router.routes` 不展平**，元素是 `_IncludedRouter`，
   `getattr(r, 'path', '')` 得到一堆空串 —— 我据此误判过一次「端点未注册」。
   验证路由注册要用 **`app.openapi()['paths']`**。

---

## 6. 跨 agent 协调说明（2026-10-05 03:4x 复核）

用户问「另一个 Agent 和你的工作冲突吗」，用证据回答而非印象。

### 6.1 文件级：零重叠 ✅

```
我三次提交动过的文件  ∩  对方当前仍未提交的文件  =  ∅
```

（计算方式见 §6.5 的复核命令。我这边 9 个源文件 + 4 个新增测试/脚本；
对方 20+ 个文件，全部落在 MVU 清理与批次 A 那条线上。）

### 6.2 但有一件事我做得不干净：吸收了对方两处改动 ⚠️

`c24017d` 提交时，有两个文件的工作区状态里**还带着对方的未提交内容**，
我用 `git add -- <path>` 把整个文件提交了进去：

| 文件 | 吸收的内容 | 现状 |
|---|---|---|
| `smart-card-runtime/SillyTavernCompatRuntime.ts` | 对方的 `Mvu.getMvuData` 无条件覆盖（变量面板读我们的数据） | 已随 `c24017d` 入库并上线 |
| `_BACKUPS/_INDEX.md` | 对方两条备份台账行（`2026-10-05_变量面板与插件变量接线`、`2026-10-05_变量自动清理_MVU对齐`） | 已随 `c24017d` 入库 |

**后果评估**：内容**没有丢失也没有被改写**，且已经在线上正常运行；
坏处是**归属混乱** —— 对方的成果记在了我的提交下，且他们 `git status` 里
这两个文件会「消失」（已提交），可能误以为改动丢了。

**正确做法**（本该如此，供后续参考）：多 agent 同工作区时，提交前应
`git diff -- <path>` 确认该文件的改动**全部是自己做的**；
若混有他人改动，应只暂存自己的 hunk（`git add -p`）或让对方先提交。

### 6.3 语义层：无冲突，但有一处需知悉的交互

- 对方的 `mvu_cleanup.py` **只动 `msg.extra["variables"]`**（消息级快照），
  从不碰 `chat_metadata.variables`。与我新端点的写入目标**不重叠**。
- 但 `_load_effective_stat_data` 是**消息级快照优先、会话级回落**。
  我的端点写的是会话级 ⇒ **手动改值后往回看（切分支 / swipe 回旧楼）时，
  历史快照仍是改前的值**。
  这在设计上是**正确的**（那本就是历史快照），且下一轮 AI 回复会把编辑后的值
  写进新快照自然向前传播。**不作为缺陷处理，但记录在此。**

### 6.4 真正的冲突点不在代码，在部署资源

两套改动共用同一个 `frontend/dist` 与同一批容器。已发生过一次：
**02:54:48 对方重建 dist 时抓走了我改到一半的源码**（漏掉 9 秒后的
`InlineCardRenderer.tsx`，详见第一波报告 §6.5）。
⇒ 建议：**避免同时发起 dist 重建 / 容器重建**；重建前先确认对方不在构建中。

### 6.5 复核命令

```bash
cd "D:/项目/Palink-AI"
comm -12 \
  <(git show --name-only --format="" c24017d 9eda04b 4c512d8 | sort -u) \
  <(git status --porcelain | grep -v "^?? _BACKUPS" | sed 's/^ M //; s/^?? //' | sort -u)
# 期望输出为空 = 文件级零重叠
```

---

## 7. 遗留待办

1. **P2 前端**：`Message.tsx` 空出后加一行 `sessionId={_sessionId}` 传参，
   再把 `TavernHelperPanel` 的编辑 UI 接上（端点已就绪）。
2. **P0-2 门 A**：`character_ext.py` 空出后加键白名单（至少禁 `variables` / `palink_injections`）。
3. **P3-a**：过滤点要改**调用方**（`character_ext.py:4409`/`:6290`、
   `character_message_builder.py:611`）—— 不是 `mvu_engine.py` 本身，
   `merge_character_book_entries` 的入参是 entry 正文列表，函数内没有 `enabled` 字段。
4. **P3-b / P3-c / P3-d**：等文件交回。P3-c 需先核卡 bundle 里的真实键名。
5. **第一波遗留不变量**：保留楼层 20 < 回看窗口 30，靠 `mvu_cleanup.run_restore_for_session`
   兜底；建议补一条端到端用例钉住该链路。
