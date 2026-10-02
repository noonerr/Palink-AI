# SPEC：MVU 变量不更新——补齐 SSE 侧解析 + 一次取证

日期：2026-09-28
交接方：Qoder（审查方）
上游记录：`docs/复核_提示词身份层ST化施工_T0-T3_2026-09-28.md`、`TODOS.md`（0020734 那条）
现象：生态卡（MVU 变量卡）的好感度/时间/地点等数值**长期不动**。admin 会话 2cb171bf 实测：
stat_data 69 个键在多轮生成后逐字段 diff = 0。

---

## 0. 开工提示词（复制给施工 agent）

```
按 d:/项目/palink-ai/docs/SPEC_MVU变量更新SSE侧补齐与取证_2026-09-28.md 施工。

要求：
1. 先读根目录 AGENTS.md、TODOS.md，再读这份 SPEC 全文（§1 是已证事实，别重复劳动、别重新怀疑）。
2. 顺序 T1（补 SSE 侧解析，含 4 个入口）→ T2（离线单测锁行为）→ T3（一次真机取证）。各一笔 commit。
3. 真机调用最多 2 次（deepseek 上游刚限流过 429，失败的那次不计费；先跑 SPEC §5 给的脚本）。
4. 禁止顺手改提示词、禁止改 _run_secondary_mvu_sync 的自动/手动策略（那是 §6 待拍板项）。
5. 动手前做 §7 备份与 tag；工作树有别的会话未提交的活，禁止 git add -A。
6. 每个 Task 跑 §8 门禁（后端测试必须进容器跑，且改完后端代码要先重建镜像或确认容器内文件已同步）。
7. 按 §9 交回物证。
```

---

## 1. 已经证完的事实（**不要重做这些实验**）

| # | 结论 | 怎么证的 |
| --- | --- | --- |
| F1 | **现网提示词足够清楚**：把下一次要发的完整提示词原样导出（19384 字符 / 4 段），交给两个互不知情的模型按提示词扮演"下一条回复"，**两份都输出了格式完全正确的 `<UpdateVariable><Analysis>…<JSONPatch>[4 条 patch]</JSONPatch></UpdateVariable>`** | 零成本，2026-09-28 |
| F2 | **解析器没问题**：把同样结构的块喂给真实 `MvuEngine.update_from_reply`（真卡 extensions + 真会话 cur_vars，内存内、不写库）→ 返回 4 条 `ok`，好感度 51→54、性欲值 20→24、replace 与文本字段全部落地 | 零成本，2026-09-28 |
| F3 | **WS 主路径已接解析**：`backend/app/api/websocket.py:795` 调 `update_from_reply`，随后 `:820` 才 `strip_update_variable_blocks` 剥正文（顺序正确：先解析后剥离） | 读码 |
| F4 | **SSE 全链路一处都没接**：`MvuEngine.update_from_reply` 全仓**唯一**调用点就是 F3 那处；`backend/app/api/character_ext.py` 里既不调它、也不调 `strip_update_variable_blocks` | 读码 + grep |
| F5 | **前端会在 WS 不可用时静默走 SSE**：`frontend/src/hooks/useCharacterChat.ts:1224` 的分支是 `if (useWebSocket && wsConnected && …) 走 WS else 走 SSE`；且重新生成/滑动/续写本就是 SSE 端点，插件生成（`getContext.ts:2386/2400`、`generation-engine.ts:258`、`CharacterView.tsx:1340`）也是 SSE | 读码 |
| F6 | 副 AI 兜底 `_run_secondary_mvu_sync`（websocket.py:519）确实零生产调用点，但**这是有意改成手动的**：同 commit e39f298 在 websocket.py:798-803 留了理由（自动调用同步阻塞 90s，界面"生成完还一直转圈"），前端有按钮（`Message.tsx:1711`、`useCharacterChat.ts` → `POST /api/character-sessions/{id}/mvu-secondary`）。**不是"从未生效"** | 读码 + git log -S |
| F7 | 那条卡自带正则「[不发送]去除变量更新」（在 `characters.extensions.regex_scripts`，camelCase `minDepth=4`）与变量不更新**无关**——F4 才是原因；此前"它洗清嫌疑"的判断成立，但给出的理由不对 | 读码 |
| F8 | 2026-09-28 的一次 WS 真机尝试**没跑成**：上游 429（`deepseek-v4-flash-0731 temporarily rate-limited`，Baidu 共享池 `tpm_rate_limit_exceeded`），未产生 token 消费；该次在会话里留下一条 user 消息 **2365**（46 字，无对应回复） | 容器日志 + DB |

**因此仍未证伪的唯一分歧点**：走 WS 时，线上那个模型到底有没有输出那个块。WS 落库前会剥标签（F3），所以**事后从库里看不出来**——必须抓流式原始文本，这就是 T3。

---

## 2. 要修什么（本单主件 T1）

给 SSE 侧补上与 WS **完全同源**的 MVU 处理，顺序必须是"先解析落库、再剥正文"：

- 解析入口：`MvuEngine.update_from_reply(cur_vars, 原始回复, char.extensions)`
- 落库：会话 `chat_metadata.variables` + 该条消息 `extra.variables`
- 剥离：`strip_update_variable_blocks(正文)` 之后再落库/再推给前端
- 日志：与 WS 一致打 `MVU variables updated: …`，便于以后取证

**四个入口都要覆盖**（漏一个就是现在这种"半条命"状态）：

| 入口 | 位置 |
| --- | --- |
| 普通对话 | `character_ext.py` `_character_chat_impl`（SSE 生成收尾处） |
| 重新生成 | `character_ext.py` `regenerate_message` |
| 滑动 swipe | `character_ext.py` `swipe_message` |
| 续写 continue | `character_ext.py` `continue_session` |

建议做法：把 WS 里那段"解析→写会话→写 extra→剥离→打日志"抽成一个共用函数（放 `mvu_engine` 或 `character_message_builder`），WS 与 SSE 同调，**别再留两份实现**。抽函数时不得改变 WS 现有行为（它有 1460 个用例兜着）。

⚠️ 顺带修的一致性缺口：SSE 目前**既不解析也不剥离**，所以模型只要输出标签，用户就会在正文里看到一整段 `<UpdateVariable>` 泄漏。T1 落地时把"落库正文不含标签"一起验掉。

---

## 3. T2：离线单测锁住行为（零成本，必须先写）

照 F2 的手法写单测，**不打网络**：

1. 构造一份含 4 条 patch（replace/delta/文本）的假回复 + 真结构的最小 stat_data，
   断言 `update_from_reply` 后数值变化、且剥离后的正文不含 `<UpdateVariable>`。
2. 断言 SSE 四个入口都调到了这个共用函数（可用 monkeypatch 计数的桩函数，参照
   `backend/tests/test_author_note_position.py:131` 那种注入 deps 的写法）。
3. 变异验证：把共用函数从某个入口摘掉 → 该用例必须变红。

## 4. T3：一次真机取证（回答"模型到底有没有输出"）

取证脚本已写好并跑通过连通性部分：`D:\_palink_review_20260928\mvu_capture.py`
（容器内跑；签 admin JWT → `POST /api/ws/ticket` → `ws://127.0.0.1:8000/api/ws/character-chat`
→ 累加 `{"type":"chunk"}` 的原始 content → 打印是否含 `<UpdateVariable>` / `${new_value}`、
stat_data 逐字段 diff、新消息落库正文）。

要求：
- 只在 T1+T2 完成后跑，**一次**；若上游 429，等 60s 重试一次，仍失败就记录失败并停（别烧次数）。
- 跑完必须报：原始流里标签出现次数、`update_from_reply` 的 logs 内容、stat_data 变化字段数、
  落库正文是否还含标签（应为否）。
- 结论只允许三种写法：模型输出了且变量变了 / 模型输出了但解析失败（附 logs）/ 模型没输出（则另立提示词议题，**本单不改提示词**）。

## 5. T3 之后：清理取证产物（需授权）

会话 2cb171bf 里已留下：user 2365（429 失败残留）、以及本单 T3 新增的一轮。
默认**保留**（留给用户复现），只在报告里登记 id；要删必须先问。

## 6. 待用户拍板（本单不做）

`_run_secondary_mvu_sync` 的处置：A) 异步后台化接回自动兜底（解决 90s 阻塞：生成收尾后另起任务，
不卡界面）；B) 删掉孤儿函数，文档写清"变量更新靠模型自觉 + 手动按钮兜底"。
两个方案代价不同，别自选。

## 7. 备份与红线

```
git tag pre-mvu-sse-20260928
git bundle create D:\_palink_backup_20260928_mvusse\repo.bundle --all
```
工作树当前有别的会话未提交产物（`backend/app/api/image_proxy.py` 等未跟踪文件、
`api/__init__.py`/`formatting.ts`/`sillyTavernPluginRuntime.ts` 已改未提交）——
**禁止 `git add -A`/`.`**，按路径暂存，提交前 `git diff --cached --name-status` 核对。
红线：`backend/app/core/migrations.py` 的 `_RUNTIME_COMPAT_COLUMNS` 禁止回填
`silly_tavern_mode` / `silly_tavern_theme` / `dialogue_mode`。

## 8. 门禁

1. 容器内全量：`MSYS_NO_PATHCONV=1 docker exec -w /app palink-ai-backend-1 python -m pytest tests/ -q`
   → 基线 **1460 passed / 42 skipped / 0 failed**（只准更高）。容器内无 pytest-timeout，别加 `--timeout`。
2. 改完后端代码后，**先 `docker compose build backend && docker compose up -d backend`**（或 tar/cp 同步并
   `md5sum` 对 `git show HEAD:<path>`，注意 CRLF 要去 CR 再比）——否则测的是旧代码。
3. `cd frontend && npx tsc --noEmit` 0 错；`npx vitest run` 保持 `27 passed / 393 passed | 3 skipped`
   （6 个 unhandled errors 来自 `plugin-runtime-diff-hotswap.test.ts`，是既有噪声，别去修）。
4. T3 真机脚本输出（见 §4）。

## 9. 交回物证

1. commit 清单（一 Task 一笔）+ 每笔 `git show --stat`。
2. T1：共用函数签名 + 四个入口各自的调用行（贴代码，别只说"已接"）+ WS 行为未变的证据
   （WS 相关用例前后对照）。
3. T2：新用例名 + 变异验证（摘掉入口 → 变红）的原始输出。
4. T3：原始流是否含标签、logs、stat_data diff、落库正文是否干净；付费调用实际用了几次。
5. 门禁原始统计行。
6. 有没有动 §6/§2 之外的东西（逐条自陈）。
7. 主动列出没做干净的地方。
