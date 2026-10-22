# BACKUP_INFO · 插件清理前 DB 快照

## ① 备份日期

2026-10-22 01:39（本地时间）

## ② 原始来源

- 容器：`palink-ai-db-1`（`pgvector/pgvector:pg15`，库 `ai_hub`，用户 `ai_user`）
- 表：`plugins`、`plugin_scripts`、`character_plugin_state`
  → `plugins_three_tables.sql`（7,315,642 B，`pg_dump` rc=0，stderr 0 字节）
- 站点接口快照：`GET http://localhost:16000/api/plugins`（admin Bearer）
  → `api_plugins_snapshot.json`（2,673,480 B，9 个插件的完整 config 视图）
- `dump.err` 为空文件（无告警）

## ③ 备份原因

老板 2026-10-22 裁定：**除「酒馆助手」（id `eb1d50e9-9f19-43ea-a362-75e4266b4991`）外，其余插件全部删除**，
今后插件兼容测试一律用真实第三方插件按需重新导入。删除属不可逆数据操作，故先落物理快照。

删除前名册（`GET /api/plugins` 实测，enabled 状态照实记录）：

| # | 名称 | id 前缀 | enabled | 脚本数 | 归类 |
|---|---|---|---|---|---|
| 1 | Smart Memory | `3bdb0b2a` | false | 0 | 真实第三方（链接导入） |
| 2 | ComfyInject | `0108b6a2` | false | 0 | 真实第三方 |
| 3 | Kimi Thinking Prefill | `e7f62410` | false | 0 | 真实第三方 |
| 4 | Regex | `db0c6324` | true | 0 | 5 个测试插件之一 |
| 5 | Summarize | `ffb782eb` | true | 0 | 5 个测试插件之一 |
| 6 | Token Counter | `6a8725df` | true | 0 | 5 个测试插件之一 |
| 7 | Chat Translation | `ff625696` | true | 0 | 5 个测试插件之一 |
| 8 | Quick Replies | `228185ea` | true | 0 | 5 个测试插件之一 |
| 9 | **酒馆助手** | `eb1d50e9` | true | **2** | **保留** |

删除前实测的外键真相（`pg_constraint`）：`plugin_scripts_plugin_id_fkey → plugins`，
`confdeltype = c`（**库里真有 ON DELETE CASCADE**，脚本行会随插件行自动消失）；
`character_plugin_state` 对该表**无外键** ⇒ 删完会留孤儿行（共 34 行，其中 10 行属被删插件），需显式清。

## ④ 后续待办清单

1. 逐 id 走应用端点 `DELETE /api/plugins/<id>`（会跑 `_invalidate_runtime_config_cache()`），**禁止脚本通配批量打**。
2. 清孤儿：`DELETE FROM character_plugin_state WHERE plugin_id IN (<已删 8 个 id>)`。
3. 判据：`GET /api/plugins` 应为 1 条且为酒馆助手（`enabled=true`、脚本 2 条）；
   `character_plugin_state` 仅剩酒馆助手相关行；`bash scripts/gate.sh` 只认 `failed=0 且 errors=0`。
4. 纯数据操作，**不需要** `docker compose build`。
5. 回退方式：`MSYS_NO_PATHCONV=1 docker exec -i palink-ai-db-1 psql -U ai_user -d ai_hub < plugins_three_tables.sql`
   （先按需 truncate 这三表，避免主键冲突），随后重启后端容器。
6. 待老板一行确认的取舍：#1–#3 这三个"真实第三方"是**同批删掉**（今后按需重新导入），
   还是**留作复测载具**（`[P2-14]` 验收① 目前正因 Smart Memory=`false` 而闭不了环）。
   注意：#4–#8 删除会作废 `TODOS.md:105` 记的 e2e 基线（init 4/5 + 7 条斜杠命令）。
7. ⛔ 红线：`st-plugins/` 目录**不许删** —— `scripts/gen-bundled-plugin-css.mjs` 与
   vitest 从磁盘读 `st-plugins/regex/debugger.css|style.css`；`st-plugins/third-party/JS-Slash-Runner-main/`
   是酒馆助手契约的一手依据。本次删除仅动数据库，不动仓内文件。
