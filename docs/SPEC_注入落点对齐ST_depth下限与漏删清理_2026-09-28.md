# SPEC：注入落点对齐 ST（depth 下限）+ dialogue_mode 漏删清理

日期：2026-09-28
交接方：Qoder（审查方）｜施工方：另一个 agent
上游：`docs/SPEC_提示词身份层ST化_删除第一第三人称切换_2026-09-27.md`（已完工）
本单依据：`docs/复核_提示词身份层ST化施工_T0-T3_2026-09-28.md` §3.1、§3.4、附录 A

---

## 0. 开工提示词（复制这段给施工 agent）

```
按 d:/项目/palink-ai/docs/SPEC_注入落点对齐ST_depth下限与漏删清理_2026-09-28.md 施工。

要求：
1. 先读根目录 AGENTS.md、TODOS.md，再读上面这份 SPEC 全文，
   然后读 docs/复核_提示词身份层ST化施工_T0-T3_2026-09-28.md 的附录 A（ST 源码依据，已核完，别再重查）。
2. 只有三个 Task：T1 补注入下限、T2 清三处漏删、T3 查明 2899 字符差（只查不改）。
   按 T1→T2→T3 顺序，各一笔 commit。
3. T1 只加下限，禁止改 depth 算术本身（SPEC §4 陷阱 P1，改了会让所有卡的注入位置全体位移）。
4. T3 是只读调查：不许为了"顺手修好"改任何生产代码；查不出来就交"已排除清单 + 下一步"，这算合格交付。
5. 动手前做 §5 的备份与 tag。
6. 每个 Task 跑 §6 门禁（后端测试必须进容器跑）。
7. 完成后按 §7 格式交回物证，不要只写"已完成"。
8. 同步更新 TODOS.md：销项 + 新遗留。
```

---

## 1. 授权范围

| Task | 内容 | 允许动的文件 |
| --- | --- | --- |
| **T1** | 给 in-chat 注入落点加"不越过主提示词"的下限（对齐 ST） | `backend/app/services/roleplay_prompt_assembly.py`（仅 `_insert_depth_prompt` 内锚点那几行）、`backend/tests/test_depth_injection_order.py`（加用例） |
| **T2** | 清掉 `dialogue_mode` 三处漏删（其中两处会让脚本直接报错） | `scripts/seed-inline-card-test.sql`、`scripts/seed-inline-charb.sql`、`scripts/smart-card-compat-smoke.cjs` |
| **T3** | 查明 MVU 注入块那 2899 字符差的成因 | **零改动**（只读；产物写 `docs/` 或 `backend/scripts/` 新文件） |

明确不授权：改 `depth` 语义/算术、改装配尾部结构、改世界书召回与扫描、改正则深度窗、放宽任何既有断言、
把 ST 没有的护栏加回提示词。

---

## 2. T1：注入下限（本单主件）

### 2.1 现状与错处

`backend/app/services/roleplay_prompt_assembly.py:5097`

```python
insert_index = max(0, len(next_messages) - head.depth)
```

`next_messages` = `[system_prompt] + 世界书/历史 + …`，主提示词被算进了锚点长度；下限只挡到 `0`，
于是 `depth ≥ len(messages)` 时注入块落到 `[0]`，**跑到角色主提示词前面**：15000 字的变量块开场，
"你来写这条回复"排第二。

2026-09-28 实测（容器内 A/B，同 DB、只改装配尾部）：

```
A 当前态                       [0] 15159 变量块 / [1] 510 主提示词 / [2] 3047 世界书 / [3] user
B 人为补回旧的尾部 2 条 system   [0] 510 主提示词 / [1] 12260 变量块 / [2] 3047 / [3] user / [4][5] system
```

### 2.2 ST 的规矩（已核完，源码 `D:\SillyTavern-release\public\scripts\openai.js`）

- In-chat 注入只操作**倒序的聊天历史数组**（`populationInjectionPrompts`，openai.js:800-866），
  主提示词/世界书/卡字段在另一个容器 `chatCompletion` 里，直到 `populateChatHistory`（:1331-1336）才合流
  → **ST 结构上不可能让注入越过主提示词**。
- 锚点：`injectIdx = i + totalInserted`（:858）作用在倒序数组上，最后 `messages.reverse()`（:864）。
  UI 原话（index.html:7337）：**"0 = after the last message, 1 = before the last message, etc."**
- 历史比 depth 短时，倒序 `splice` 只会在末尾追加 → 转回正序 = **落到聊天历史第一条之前，仍在主提示词之后**。
  这就是 ST 的天然下限：**锚"聊天历史头部"，不锚"整个数组头部"**。

### 2.3 要做的改动

只在锚点上补下限，**其余算术一个字符都不动**：

```python
# ST: in-chat 注入只锚在聊天历史上，永不越过主提示词块（openai.js:800-866 + :1331 合流）
_floor = 1 if next_messages and next_messages[0].get("role") == "system" else 0
insert_index = max(_floor, len(next_messages) - head.depth)
```

注释里带上这条依据，便于后人不再怀疑是拍脑袋。

### 2.4 必须加的用例（写进 `backend/tests/test_depth_injection_order.py`）

该文件已有 `BASE_MESSAGES`（首条 system，共 6 条）与"插入点 = 6-depth"的既有用例，沿用同一夹具：

1. `depth` 大于等于消息总数（例如 depth=99 与 depth=6 各一例）→ 注入落点必须是 **1**，
   且 `messages[0]` 仍是原主提示词（断言内容而不是只断言下标）。
2. `depth=1` → 仍落在最后一条之前（**证明正常路径没被动过**）。
3. 首条不是 system 时 → 允许落到 0（保住兜底分支）。

---

## 3. T2：三处漏删（`dialogue_mode` 整链删除的尾巴）

| 文件:行 | 现状 | 后果 | 处置 |
| --- | --- | --- | --- |
| `scripts/seed-inline-card-test.sql:8` | `INSERT INTO character_chat_sessions (id, character_id, user_id, title, dialogue_mode, created_at, updated_at, chat_metadata)` 且 VALUES 里对应一个 `NULL` | 列已被 alembic 0065 drop → **执行即 `column "dialogue_mode" does not exist`** | 删列名 + 删对应那个 `NULL` 值，两边必须同步（少删一边会串列插错，见 §4 P2） |
| `scripts/seed-inline-charb.sql:22` | 同上 | 同上 | 同上 |
| `scripts/smart-card-compat-smoke.cjs:118` | 请求体 `dialogue_mode: 'normal'` | 无害（Pydantic 静默丢），但值从来不在枚举内 | 删这一行 |

改完自查（必须贴输出）：

```
grep -rn "dialogue_mode\|first_person\|third_person\|扮演方式" backend/app frontend/src scripts backend/scripts \
  | grep -v "\.mimosa/\|__pycache__"
```

允许剩下的只有：`backend/app/api/character_ext.py:795-798`（宏兜底正则本体）、
`roleplay_prompt_assembly.py:2904` 与 `getContext.ts:3154` 的说明注释。**多一行就是没删净。**

两个 seed 脚本改完要**真跑一遍**（容器内 psql 执行），贴插入成功与 `SELECT` 回查结果，
别只改不验——它们本来就是给智能卡内联渲染测试铺数据的。

---

## 4. 陷阱（会让改动静默失效）

- **P1｜不要顺手"修正"depth 语义。** 正确做法只加下限。若改成"跳过 system 后再数 depth"，
  等于把**所有卡的所有注入位置整体位移一格**，那是行为变更，需要单独论证与单独授权。
- **P2｜SQL 是位置对应的 INSERT。** 删列名不删值（或反之）会把 `title` 插进 `created_at`，
  轻则报错、重则数据错位还"执行成功"。改完必须 `SELECT` 回查每一列。
- **P3｜容器代码是烤镜像 + tar/cp 同步的。** 改完 `roleplay_prompt_assembly.py` 不 cp 进容器，
  测的还是旧代码；容器内文件是 CRLF，跟 `git show HEAD:<path> | md5sum` 比会**假性不等**，
  要比先去 CR（`sed 's/\r$//'`）。
- **P4｜后端测试必须进容器跑。** `MSYS_NO_PATHCONV=1 docker exec -w /app palink-ai-backend-1 python -m pytest tests/ -q`。
  宿主机跑会静默少 9 例。容器内**没有 pytest-timeout**，别加 `--timeout`。
- **P5｜既有测试断言里有"插入点 = 6-depth"。** 加下限可能让某些夹具期望值变化。
  **禁止放宽断言迁就实现**：若有用例红了，先判断是夹具本来就在测越界场景（那它该更新为 1），
  还是你把正常路径改坏了。两种情况都要在 commit message 里写清是哪一种。
- **P6｜注入落点变化会连带改变下游可见结果**（本次 §2.1 的 15159/12260 就是例子：块在 `[0]` 与 `[1]`
  时，同一份卡文本的宏展开结果不同）。所以 T1 改完必须重跑探针并**逐条比较块长度**，
  不能只看顺序对了就收工。

---

## 5. 动手前：备份与 tag

```
git tag pre-depth-floor-20260928
mkdir -p /d/_palink_backup_20260928_depthfloor
git archive --format=tar HEAD | gzip > /d/_palink_backup_20260928_depthfloor/worktree.tar.gz
```

物理备份必须落 D 盘独立目录，不能只靠 git（本项目历史上丢过一次对象）。

⚠️ 当前工作树有**别的会话未提交的活**（`backend/app/api/image_proxy.py`、`image_proxy_service.py`、
`test_image_proxy.py`、`frontend/.../cdn-image-proxy-rewrite.test.ts` 未跟踪；
`api/__init__.py`、`formatting.ts`、`sillyTavernPluginRuntime.ts` 已改未提交）。
**禁止 `git add -A` / `git add .`**，一律按路径暂存，提交前用 `git diff --cached --name-status` 核对。

---

## 6. 门禁（每个 Task 都要跑，贴原始输出）

1. `MSYS_NO_PATHCONV=1 docker exec -w /app palink-ai-backend-1 python -m pytest tests/ -q` → 基线
   **1457 passed / 42 skipped / 0 failed**，只准更高不准低。
2. 容器内跑 `scripts/probe_assemble_dump.py`（cp 进去，跑完删掉），贴 `### MESSAGE ROLES IN ORDER` 全表
   + 变量块长度。**期望**：`[0]` 是主提示词（510 字符、开头 `Write …next reply…`），变量块回到 `[1]`，末条仍是 user。
3. `cd frontend && npx tsc --noEmit` → 0 错（本单前端不动，跑一次确认没波及）。
4. T1 额外：新加的 3 条用例单独跑 `pytest tests/test_depth_injection_order.py -q` 并贴全绿。
5. T3 额外：调查产物落文件，不要求门禁。

---

## 7. 交回物证格式

1. commit 清单（一 Task 一笔）+ 每笔 `git show --stat`。
2. T1：改动 diff 原文 + 新用例名与其断言 + 前后两次探针的 `[i] role | len | head` 全表对比。
3. T2：§3 那条 grep 的完整输出 + 两个 seed 脚本真跑的成功回查。
4. T3：结论一段 + **已排除清单**（预算裁剪、卡 scoped 正则深度窗、插件正则深度窗这三项我已经排除过，
   别重复劳动，从"宏展开链为什么依赖消息位置"入手：`backend/app/services/macro_service.py`，
   重点看 `evaluate_macros_in_messages` 与展开时能拿到的消息上下文）+ 查不出就写"未结案 + 下一步"。
5. 门禁原始统计行。
6. 有没有动 §1 授权范围外的文件（必须逐条自陈，包括"我以为顺手没事"的那种）。
7. 主动列出没做干净的地方。

## 8. 回滚

`git reset --hard pre-depth-floor-20260928` + 从备份 tgz 恢复未跟踪产物；
T1 是纯下限钳制，无迁移、无数据变更，回滚零成本。
