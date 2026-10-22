# BACKUP_INFO — 2026-10-07_记忆向量pgvector迁移

## 1. 备份日期

2026-10-07（19:13，GMT+8）—— 拷贝时间点为**动工前**，`storage.py.bak` 与改前文件逐字节一致。

## 2. 原始来源路径

```
D:\项目\Palink-AI\backend\app\memory_module\storage.py              → storage.py.bak              (51461 字节)
D:\项目\Palink-AI\backend\app\services\roleplay_prompt_assembly.py  → roleplay_prompt_assembly.py.bak (277069 字节)
D:\项目\Palink-AI\backend\tests\test_memory_scope_guard.py          → test_memory_scope_guard.py.bak
```

本批新增文件（不在备份内，回滚时直接删）：

- `backend/alembic/versions/0069_memory_embedding_vector.py`
- `backend/tests/test_memory_vector_search.py`

## 3. 备份原因

修「向量记忆的提取与注入」这条链上的两处结构性缺陷，动工前留存原文件。

**缺陷一：语义检索其实只在"最近 200 条"里做**（`storage.semantic_search` 旧实现
是 `ORDER BY created_at DESC LIMIT 200` 把 200 行 JSON 向量文本搬进 Python 逐行算余弦）。

容器内实测（探针 `probe4.py`，只读）：

```
[Q1] 用户级候选总数=614 行，SQL 窗口=200
     相似度>=0.5 的行：全量 151 条 / 窗口内 79 条 → 被窗口吞掉 72 条本该召回的
     top50 里有 22 条是窗口取不到的（44%）
     全量 numpy 扫 614 行: （实测 2 ms）
```

主力会话 `f25daab6` 现有 **192 行带向量**，距 200 天花板只剩 **8 行**；
而 10-07 早些时候把切分阈值 0.12→0.05 让行数增速 **+79%** —— 那个天花板马上就要撞上。

性能侧实测（探针 `probe2.py` / `probe3.py`）：

```
[A] 查询嵌入(1 句) = 166.3 ms
[B] SQL 取 192 行 = 29.9 ms，payload=4.17 MB（每行 22747 字节的 JSON 文本）
[C] Python json.loads+余弦 192 行 = 42.0 ms
[H] pgvector brute-force top50 = 2.6 ms
[J] HNSW 索引查询 = 1.9 ms
[G] 建表+灌 192 行 = 78.2 ms（一次性回填成本参考）
```

⇒ "扫全部"根本不贵（2~3 ms），贵的是每轮把 4.17MB 文本从库里搬到后端。

**缺陷二：检索查询只有本轮用户一句话**。实测 `character_chat_messages` 里用户消息
**平均 29 字**（101 条中 12 条不足 10 字）。同一轮换成"最近 4 条拼接"：

```
仅本轮用户消息（33 字）: top8 区间 1.0000~0.6208   ← 1.0000 = 命中自己的镜像，白烧预算
最近 4 条拼接（444 字）: top8 区间 0.8869~0.7668
两种查询的 top8 重合=2/8
```

**本批改动**：

1. `conversation_memories.embedding` 由 TEXT → pgvector `vector(1024)`，运行时通道
   `MemoryStorage._migrate_embedding_column()`（生产 `RUN_MIGRATIONS_ON_STARTUP=false`，
   启动时 alembic 不执行，所以真正落库靠这条；alembic 0069 只记 schema 历史）。
2. `semantic_search` 在列真是 `vector(N)` 时走库内 `<=>` 精确 top-K，**去掉时间预筛窗口**；
   列还是 TEXT / SQLite 时自动退回 Python 余弦（上限 5000 行且触顶告警，不再静默少召回）。
   检索路径由 `_detect_vector_column()` **按列的真实类型**决定，不看方言猜 ——
   猜错会让 `<=>` 抛异常被 except 吞掉，复现"明明有记忆却召回 0"。
   **故意不建 HNSW/IVFFlat**：pgvector 索引扫描是"先取近邻再套 WHERE"，
   在 user/session 高选择性过滤下会少返甚至返 0 条，会伪装成"用户没历史"。
3. 作用域 WHERE 从三条 if/elif 抽成 `_build_scope_filter()` 一份（两条检索路共用）。
   ⚠️ 这使 `tests/test_memory_scope_guard.py` 的两条**源码形状守卫**失效，已改为行为断言。
4. 写侧 `store_chunks` / `_update_embedding_in_db` 加 `CAST(:embedding AS vector)`。
5. 装配层新增 `_build_memory_query()`：查询取最近 4 条消息拼接（≤600 字、保尾部），
   分支隔离口径与召回一致，DB 异常原样退回本轮消息。

## 4. 后续待办清单

- [x] **后端镜像已重建上线**（2026-10-07 20:5x，用户选「立即重建」并知情会夹带并行会话在途改动）：
      容器 `healthy`；产物级 grep `VEC-PG`=17 / `CHUNK_STRATEGY=structural` / `_build_memory_query`=3；
      启动日志无 `[VEC-PG]` 失败；对已部署镜像重跑探针通过（列 vector、729 行/670 向量、幂等 12.8ms）。
- [x] 已跑 `probe5_verify_pg.py` 验收（迁移后 + 重建后各一次）：列类型 = `vector(1024)`、
      行数/带向量数零丢失、用户级召回从 79 条量级升到 151 条量级、
      写侧 CAST 在事务内跑通且回滚不留行。
- [ ] 真机验收（只有用户能做）：发一轮对话，日志应出现「语义检索完成: 找到 N 条」且
      **不再有**「检索记忆失败」；装配报告 `memory` 项 = `included`。
      ⚠️ 10-07 那个元组解包修复上线后**至今 0 条检索日志**（容器重启后没人聊过），
      也就是说那个修复也还没被真实流量验证过。
- [ ] 步骤 3（写侧切分）：先跑三方案对比探针（450 硬切 / 语义 0.05 / 结构性切 ~250）
      再定走"结构性切分"还是"句向量合成块向量"。实测写入侧成本：
      句嵌入 2.1~2.5s + 块嵌入 1.7~2.1s ≈ **4.3s/轮**（另一份报告在负载下量到 13s）。
- [ ] 同款缺陷的遗留一处：`app/api/silly_tavern.py:5281` ST 向量集合检索也是
      `LIMIT 500` + Python 余弦，本批未动（它不在第一方注入链路上）。
- [ ] 若回滚：`cp` 三个 `.bak` 回原位 + 删两个新增文件 + 执行
      `alembic downgrade 0068`（或 `ALTER TABLE conversation_memories ALTER COLUMN
      embedding TYPE text USING embedding::text`），再重建后端。
