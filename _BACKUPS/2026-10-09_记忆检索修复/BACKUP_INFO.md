# BACKUP_INFO — 2026-10-09 记忆检索修复（动工前备份）

## ① 备份日期
2026-10-09 18:20（GMT+8）

## ② 原始来源路径
| 文件 | 原始路径 |
|---|---|
| `pre/backend/app/services/roleplay_prompt_assembly.py` | `backend/app/services/roleplay_prompt_assembly.py` |
| `pre/backend/app/memory_module/config.py` | `backend/app/memory_module/config.py` |
| `pre/backend/app/memory_module/retriever.py` | `backend/app/memory_module/retriever.py` |
| `pre/backend/app/memory_module/storage.py` | `backend/app/memory_module/storage.py` |
| `pre/backend/app/memory_module/service.py` | `backend/app/memory_module/service.py` |
| `pre/backend/app/memory_module/semantic_chunker.py` | `backend/app/memory_module/semantic_chunker.py` |

## ③ 备份原因
按 2026-10-09 当日实测结论（`docs/_active/report/REPORT_记忆最优解复核_关键词路与查询构造_2026-10-09.md`
与 `REPORT_记忆块截断审计与预算甜点_2026-10-09.md`）落地四项修复，改前留物理副本以便一键回退：

1. **修查询构造**：`_build_memory_query` 由「最近 4 条拼接 + 尾截 600」改为「本轮用户消息（清洗后）」，
   短消息才回退拼接。实测检索 top1 6.2%→22.9%，单次耗时 3009ms→619ms。
2. **加关键词路**：retriever 增加关键词（pg_trgm）候选并与向量路做 RRF 融合。
   与第 1 项叠加后 top1 6.2%→47.9%，注入命中 31.2%→81.2%。
3. **邻居扩展独立预算**：`_expand_chunk_neighbors` 不再与检索抢同一份 `max_tokens`
   （实测此情况下补进 0 条，被切开的块另一半永远回不来）。
4. **切点回退弱边界**：`_find_cut_index` 找不到句终止符时退回逗号/顿号等弱边界，
   消灭 4.4% 的「句子中间硬切」。

⚠️ 工作区在备份时**已有他人的大量未提交改动**（`git status` 60+ 条 M/D），
本次只动上表 6 个文件的相关片段，其余改动与我无关，回退时请按文件 **diff 级别**回退，
不要用 `git checkout .` 之类会连坐他人改动的命令。

## ④ 后续待办清单
- [ ] 后端门禁：`cd backend && py -3 -m pytest tests/ -q`（只认 failed=0）
- [ ] 重建容器：`docker compose build backend && docker compose up -d backend`
  （⚠️ 提交 ≠ 上线，容器内必须 grep 到新代码特征）
- [ ] 冒烟：真实会话跑一次装配，确认记忆注入条数/耗时与预期一致、无异常日志
- [ ] 待复测（本次未做）：邻居扩展比例 0.3 的端到端影响 ——
      已知「记忆区变大会掉分」（6000 档 −0.080），该开关若效果为负就调回 0
- [ ] 待复测：关键词路落地用的是 pg_trgm SQL 粗筛 + Python bigram 精排，
      与探针口径（纯 Python bigram）需在真实会话上对齐一次
- [ ] 未做（第二阶段）：句级索引 small-to-big、历史 24→8~12
