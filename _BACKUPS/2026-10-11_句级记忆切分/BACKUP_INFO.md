# BACKUP_INFO — 2026-10-11 句级记忆切分

## ① 备份日期

2026-10-11（施工前 `pre/` 快照）

## ② 原始来源路径

按原相对路径存于 `pre/`，共 6 份（sha256 见 `_manifest.tsv`）：

| 相对路径 | 说明 |
|---|---|
| `backend/app/memory_module/semantic_chunker.py` | 切分器（本次新增 `sentence_split` 与分派分支） |
| `backend/app/memory_module/config.py` | 记忆配置（本次改默认策略 + 新增 6 个参数） |
| `backend/app/memory_module/storage.py` | 存储层（本次 `get_adjacent_chunks` 加 `radius` 参数） |
| `backend/app/memory_module/retriever.py` | 检索器（本次 STM 条数与候选池改走配置） |
| `backend/app/memory_module/service.py` | 写入服务（预计不改，纳入备份以防实施中需要） |
| `backend/tests/test_memory_chunk_strategy.py` | 既有策略测试（默认策略断言需同步更新） |

## ③ 备份原因

用户 2026-10-11 授权施工「向量记忆替代上下文」四步清单的**第 2 步：记忆改句级**
（`TODOS.md:20` 登记为唯一未开工且需写代码的一步）。

- 权威依据：`docs/_active/report/REPORT_向量记忆替代上下文_结论摘要与落地清单_2026-10-09.md` §四
- 施工依据：`docs/_active/spec/SPEC_句级记忆切分_2026-10-11.md`
- 预期收益：端到端 0.210 → 0.340（+0.130，超过跑间噪声 ±0.09）
- **行为变更**：`MEMORY_CHUNK_STRATEGY` 默认值由 `structural` 改为 `sentence`

## ④ 后续待办清单

1. 回退方式（二选一）：
   - 环境变量：`MEMORY_CHUNK_STRATEGY=structural`（写入侧回块级，检索侧参数随属性自动回块级值）
   - 文件级：`cp -r pre/backend/. backend/`（再跑门禁）
2. **后端非 bind mount**，改完必须 `docker compose build backend && docker compose up -d backend` 才生效。
3. 门禁：`cd backend && py -3 -m pytest tests/ -q`，只认 `failed = 0 且 errors = 0`。
4. 未做的事（登记在 SPEC §十）：
   - 存量 764 条块级记忆**不重切**（新旧混存，可接受）；
   - 不放宽 `NEIGHBOR_MAX_ADDS`（现 4，句级下可能是瓶颈，需实测）；
   - 未实测「24 条历史 + 句级记忆」的端到端得分（0.340 是 6 条历史条件下的数）。
5. 生产效果需观测后再决定是否调整 `SENTENCE_*` 参数。
