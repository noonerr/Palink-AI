# BACKUP_INFO — 2026-10-26 预设库 0072 迁移前生产库快照

## ① 备份日期
2026-10-26

## ② 原始来源路径
`palink-ai-db-1` 容器，库 `ai_hub`（PostgreSQL 15 + pgvector）

## ③ 备份原因
上线「预设模板库」前，需应用 alembic `0072_ctx_template_user_id`（`context_templates.user_id` 可空列 + 索引）。
这是生产库结构变更，按惯例先做整库快照；若迁移/上线异常，用本快照回滚数据，再用 git 回退代码。

## ④ 后续待办清单
- [ ] 迁移成功后核对 `alembic_version = 0072_ctx_template_user_id`，并确认 `context_templates.user_id` 与索引在场。
- [ ] 核对 `GET /api/preset-library` 能返回四类清单；`context_templates` 自带条数增加 2。
- [ ] 本快照保留到下一轮数据迁移；确认无回滚需求后再清理。
- [ ] 回滚命令（谨慎）：`gunzip -c ai_hub_before_0072.sql.gz | docker exec -i palink-ai-db-1 psql -U ai_user -d ai_hub`；执行前先停后端写流量。
