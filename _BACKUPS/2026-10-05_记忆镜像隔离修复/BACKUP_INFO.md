# 记忆镜像与分支隔离修复 · 施工前备份

## 1. 备份日期

2026-10-05

## 2. 原始来源路径

`D:\项目\Palink-AI`（分支 `st-plugin-compat-20260727`，基线 `HEAD` = `fe9cca3d61faf618cfa09e1e42ad8a83a2226d6d`，
见 `HEAD.txt`）。

本批施工（`docs/SPEC_重新生成与分支记忆隔离修复_2026-10-05.md`）将要修改的 8 个文件，
按原相对路径存于 `files/`，sha256 前 16 位见 `_manifest.tsv`：

```
backend/app/api/character_ext.py
backend/app/api/sessions.py
backend/app/memory_module/storage.py
backend/app/memory_module/service.py
backend/app/services/roleplay_prompt_assembly.py
backend/tests/test_memory_message_link.py
frontend/src/components/views/character/CharacterChat.tsx
frontend/src/lib/sillytavern/getContext.ts
```

另存 `worktree-uncommitted.patch`（**79,046 B**）= 备份时刻**整个工作区的未提交改动全量**
（含**并行 agent** 的 MVU 变量/清理批次，与本批无关的 `mvu_engine.py`、`websocket.py`、
`Message.tsx`、`worldbook_service.py`、`docker-compose.yml` 等）。⚠️ 该 patch 含别人在途成果，
**本批不代提交、不代回滚**，仅作兜底回捞用。

## 3. 备份原因

修「重新生成(swipe)/编辑后向量记忆残留旧版本文本」与「分支召回缺分叉点截断」，
属改写记忆写入时序与召回 SQL 的高风险施工：
- 要动 `delete_by_message_id` 的调用时机（从请求内提前提交 → 挪进后台事务）；
- 要给召回 SQL 加分叉点截断条件（改召回范围 = 可能让某些记忆突然召不到）；
- 三份后台重嵌闭包要合并成 1 个公共 helper（跨 `character_ext.py`/`sessions.py`）；
- 之后还要清理**生产库** `conversation_memories` 的残留行（按规范需先隔离导出再删）。

工作区同时存在并行 agent 的未提交改动（19 文件），故必须先把「谁在改什么」固化下来，
避免回滚本批时连带退掉别人的成果。

## 4. 后续待办清单

1. **P0 / RC-1 删写不原子**：`store_chunks` 是「先嵌入(Ollama,秒级)后插入」，
   而切换/编辑路径「请求内立即 DELETE + 后台线程数秒后 INSERT」→ 窗口内二次操作的 DELETE 空删，
   旧版本文本永久残留。修法：抽 `memory_module/mirror.py`，DELETE 挪进后台事务与 INSERT 同事务，
   并在写前重读消息当前正文做**新鲜度校验（CAS on content）**，正文已被更新则放弃写入。
2. **P1 / RC-2 召回缺分叉截断**：`_get_ancestor_branch_ids`(character_ext.py:598-614) 无 message_id 截断，
   而消息历史 `_get_full_branch_history_paged`(:617-698) 有 fork_limits。给记忆召回对齐加 `parent_message_id` 截断。
3. **P1 / RC-3 静默降级**：`roleplay_prompt_assembly.py:5481` 祖先为空时传 `None` →
   `storage.py:749-759` 整会话全分支召回且无告警。改为显式作用域 + 告警。
4. **P0 统一 memory_mode 守卫**（RC-4）：动作流(`:5877`)有 `memory_mode!=disabled` 判断，
   编辑(`:3316`)/切换(`:6663`)路径无 → 行为不一致，统一进 mirror helper。
5. **测试**：扩 `tests/test_memory_message_link.py`（T1 竞态 / T2 过期放弃 / T3 原子 / T4 memory_mode / T5 分叉截断 / T6 无静默降级 / T7 NULL message_id）。
6. **存量清理**（需用户确认后才动生产库）：出待删清单 → 导出到本目录 → 删残留 → 按当前 content 重嵌 → 判据归零。
7. **上线**（AGENTS.md 铁律「提交≠上线」）：pytest + tsc + vitest 过后，
   `docker compose build backend && up -d backend` 并在容器内 grep 新代码指纹。

### 与并行 agent 的重叠区（开工前已核，写明以免后人在此误判「冲突」）

- `character_ext.py`：并行 agent 的 MVU-CLEANUP 加在 `_run_action_stream`:5939-5945、
  `delete_character_message`:2966+、`regenerate_message`:6203+、`swipe_message`:6558+、
  `continue_session`:6055+ 等；本批改的是**记忆 upsert 块 `:5877-5938`** 与
  编辑/切换路径的删除/重嵌。**两块相邻但不重叠**，编辑时用唯一字符串定位、不按行号。
- `roleplay_prompt_assembly.py`：并行 agent 动 `:3275-3329`(新增)与 `_load_effective_stat_data`:5221+；
  本批只动**记忆召回块 :5446-5505**(现文件内)。不重叠。
- `CharacterChat.tsx`：并行 agent 动 `mvuSecondaryFeedback` 提示链 `:1359-1370`；
  本批只动 `handleSwipeAt` `:1390-1412` 加 in-flight 去重。不重叠。
- `storage.py` / `sessions.py`：备份时刻**并行 agent 未碰**（0 hunk），本批自由编辑。

## 5. 回滚路径

- 单文件：`cp files/<相对路径> <仓库对应位置>`
- 整批（含并行 agent 未提交成果）：`git apply worktree-uncommitted.patch`（⚠️ 会一并退掉本批之后的改动，按需）
- 数据：本批对**生产库**的清理在导出文件就绪前不执行；执行前把
  `conversation_memories` 待删行导出为本目录下 `stale_rows.json`。