# BACKUP_INFO — 2026-10-05_dist重建前_MVU批次A

## ① 备份日期

**2026-10-05 02:06**（重建**前**，时序合规）。

## ② 原始来源路径

| # | 原路径 | 备份内容 | 体积 |
|---|---|---|---|
| 1 | `frontend/dist/` | 整份在用构建产物 → 本目录 `dist/` | **67 MB** |
| 2 | `palink-ai-db-1`（容器内 PostgreSQL） | `pg_dump` 全量 SQL → `pre-migration-0068.sql` | **23,892,344 B（23.9 MB）** |
| 3 | — | `dist-entry-before.txt`：重建前 `dist/assets/index-*.js` 指纹清单（40 条） | — |

## ③ 备份原因

用户要求对 `docs/SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md` 批次 A 的成果做**真机测试**。

而本仓铁律是「**提交 ≠ 上线**」：改后端须 `docker compose build backend && up -d`，
改前端须**重建 dist** 并确认容器服务新指纹。当前运行的容器是 4 小时前的旧代码，
**三个批次的成果一个都没上线** → 不重建就无法做真机验证。

本次要动的两件不可逆/高风险操作，各自需要一个安全网：

1. **重建 dist** → `frontend/dist` 是**容器 nginx 的 bind mount 在用产物**（`./frontend/dist:/usr/share/nginx/html:ro`）。
   `npm run build` 的第一步就是 `scripts/clean-dist.cjs`（**先删后建**）——
   一旦构建中途失败，dist 被清空且未重建 → **站点直接白屏**。
   → 故整份备份 67 MB，可整体拷回。
2. **应用 alembic 迁移 `0068_add_mvu_secondary_params`** → 对**线上库**做 schema 变更
   （给 `user_settings` 加 3 列，全部 nullable）。
   虽然按设计是纯增量、可回滚（迁移自带 `downgrade`），但改线上 schema 属不可逆操作。
   → 故先 `pg_dump` 全量导出。

## ④ 后续待办清单

### A. 本次真机测试要验证的

| # | 验证项 | 判定 |
|---|---|---|
| 1 | 站点可访问（`http://localhost:14000`） | HTTP 200 |
| 2 | 前端容器服务**新指纹**（`dist-entry-after.txt` 与 before 不同） | 指纹变化 |
| 3 | 后端容器起来且健康 | `healthy` |
| 4 | 迁移 0068 已应用（`user_settings` 有 3 个新列） | 列存在 |
| 5 | **① 的修复**：副 AI 调用失败时不再显示「变量更新完成（无变化）」 | 手动触发副模型（模型不可用时）应出现**报错**提示 |
| 6 | 变量清理接线未把站点跑挂（另两批的成果一并上线） | 会话可正常生成 |

### B. 出问题时的回滚路径（**必须先与用户确认再执行**）

- **dist 白屏** → `rm -rf frontend/dist && cp -r _BACKUPS/2026-10-05_dist重建前_MVU批次A/dist frontend/dist`
- **迁移要退** → `cd backend && py -3 -m alembic downgrade 0067_add_memory_character_id`
- **库要整体还原** → `psql < pre-migration-0068.sql`（**会丢备份点之后的写入，慎用**）
- **后端要退** → `git checkout -- <文件>`（本批 `pre-batch2/` 有 7 个文件的原样副本）

### C. 红线与注意事项

1. **不要删 `frontend/dist`**（nginx 在用）。重建是「替换」，不是「删除」。
2. **`docker exec` 在 Git Bash 下要加 `MSYS_NO_PATHCONV=1`**（本次实测：不加则 `pg_dump` 报
   "No such file or directory"）。
3. **本备份目录的 `dist/` 有 67 MB**，按 git 边界规则**不入库**（`_BACKUPS/**` 已 gitignore），
   仅本 `BACKUP_INFO.md` 与 `_INDEX.md` 入库。
4. ⚠️ **本次上线会把另两个会话的未提交成果一并带上线**（「变量面板与插件变量接线」3 文件、
   「变量自动清理_MVU对齐」8 文件及新增件）—— 因为它们同在工作区、同一次构建。
   若只想上线本批 ①，**不可行**（无法只挑一个文件的改动进 dist）。此事须让用户知悉。
