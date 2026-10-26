# BACKUP_INFO — 2026-10-26 插件矩阵残留清理前（三表快照）

## ① 备份日期
2026-10-26

## ② 原始来源路径
`palink-ai-db-1` 库 `ai_hub` 的三张表：`plugins` / `plugin_scripts` / `character_plugin_state`
（`pg_dump -t plugins -t plugin_scripts -t character_plugin_state | gzip`，**17.9M**，`gzip -t` 通过）

## ③ 备份原因
删除 2026-10-24 VER-3 插件兼容矩阵批次自行导入并批量置 `enabled=false` 的 **15 个测试插件**
（WorldsApart / Smart Memory / 酒馆建筑师 / TokenSaving / DeepLore / Kimi Thinking Prefill 等，
`created_at` 全在 10-24 09:44~11:15）。
依据：用户 2026-10-26 确认「不是我关的」+ 2026-10-22 既有裁定「除酒馆助手外全部删除测试插件，
今后只按需导入真实第三方插件复测」。
删前核对：plugins=15、plugin_scripts=0、character_plugin_state=0；删后 **plugins=1**（酒馆助手，enabled=true）。

## ④ 后续待办清单
- [ ] 回滚（如需复测矩阵）：
      `gunzip -c plugins_three_tables_pre_cleanup.sql.gz | docker exec -i palink-ai-db-1 psql -U ai_user -d ai_hub`
      （表内含 DROP/CREATE，执行前先确认不会覆盖线上后来的改动；更稳的做法是只按 dump 里的 INSERT 逐行回灌）。
- [ ] 今后真实第三方插件复测一律「按需导入 → 测完删除」，不要留批量样本在库里（本次残留就是这么来的）。
- [ ] 本快照保留一个保鲜期（至 2026-11-02）后由用户确认清理。
