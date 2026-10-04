# BACKUP_INFO — 2026-10-03 清理未绑定世界书

## ① 备份日期

2026-10-03

## ② 原始来源路径

`D:\项目\palink-new` 的**测试栈数据库**（容器 `palink-new-db-1`，卷 `palinknew_pgdata`，
端口仅容器内 5432）。

| 备份物 | 内容 | 状态 |
|---|---|---|
| `worldbooks_after_cleanup.csv` | 删除**后** `world_books` 全量 11 本的 CSV（380KB） | ✅ 有效 |
| `worldbook_stages_after_cleanup.csv` | 删除**后** `world_book_stages` 全量 CSV（1.07MB） | ✅ 有效 |
| `deleted_worldbooks.csv` | 原拟导出两条**待删**记录 | ⚠️ **仅表头，无数据行** |

⚠️ **诚实说明一处失效**：删除前导出的 `unbound_worldbooks.sql`（1.4MB）与
`unbound_worldbooks.csv`（含两条待删记录全字段）**在改名操作中丢失**，
本目录现在只有「删除后」的快照。原因是先建备份、后改名，中途只搬动了
`BACKUP_INFO.md`，两个数据文件未随目录一起移动。

**影响**：
- 「删掉了什么」有完整记录（见下节表格 + `deleted_worldbooks.csv` 的表头结构）
- 「删之前长什么样」的数据快照**已不可恢复**
- 但两条记录的内容特征仍完整记在下方表格里（书名 / id / 类型 / 条目长度 / 判定依据），
  且**原项目 Palink-AI 生产库（`:13000`）里同样的两条还在**，
  需要原始数据时从生产库导出即可（`WHERE id IN ('0d2b7115…','216be880…')`）

⚠️ **本备份是 palink-new 测试栈的，不是原 Palink-AI 生产库**（生产库 `:13000` 全程未动）。

## ③ 备份原因

用户裁定：「世界书基本上都是角色卡自带的，没有全局世界书这个概念」——
查库印证：12 本里 10 本已绑角色（含用户报的场景：两张「露缇雅1.2」各绑自己那本，
id `3e31f857…` / `ff5e7ae1…`）。仅 2 本未绑定，判定为「之前删东西没删干净的残留」，
经用户两次确认后删除。

## ④ 删除清单与依据

| 书名 | source_type | 创建时间 | 条目内容 | 删除依据 |
|---|---|---|---|---|
| `Magical Fairy / 群星的资料库 v1.0`<br>`0d2b7115-313d-4946-9cf8-e02d333faeac` | upload | 2026-08-07 | 1 条（234 字符） | 从某游戏存档导出的模板：姓名"1"、属性全 100、设定"未填写"；`type=world_book`（其余 10 本全是 `character_book`）。非用户资产 |
| `galgame界面插件`<br>`216be880-5478-4191-b1d2-6fccc2ec7244` | online_edit | 2026-08-13 | 1 条（1060 字符） | Galgame 视觉小说前端的功能规范（`<bgm>` / `<pixiPerform>` / `<styled>` / `<background>`）。**其描述的渲染代码已全部不存在**：`pixiPerform` 与 `bgm` 在 `frontend/src` 各命中 **0 个文件**，`styled` 的 1 个命中亦为 CSS 类名误检。与已装插件（仅「酒馆助手」）无关 |

**排除的担心**：`galgame界面插件` 曾一度被判断「不能删」（内含 BGM/TTS/背景格式说明）。
**该判断已被推翻** —— 逐个 grep 渲染代码后确认三类标签的渲染器均已删除，规范本身是孤儿，
且因未绑角色自 2026-10-03 起本就不注入（早已失效状态）。

## ⑤ 后续待办

- [x] 两条记录 + 各自条目已删（`DELETE 1` ×2 ×2 表）
- [x] `world_book_entry_vectors` 关联向量已先清（`DELETE 0` = 本无向量）
- [x] 确认 `character_id IS NULL` 的书 = **0 本**
- [ ] ⚠️ **原项目 Palink-AI（:13000）的同名两条尚未删除** —— 本次只清理了 palink-new。
      若要同步清理，需单独确认（原项目生产数据，按规范「清理三步」走）。
- [ ] 观察是否有用户反馈「某角色世界书内容不见了」——理论上不会：本批删的两本都是
      未绑定的孤儿，从未对任何角色生效过（2026-10-03 之前它们以「全局」身份对所有角色注入，
      属串味源头之一，删除即为修复）

## 恢复方式

两条记录已从 palink-new 测试库删除，需要恢复时**从原项目生产库导出**（内容相同）：

```bash
docker exec palink-ai-db-1 psql -U ai_user -d ai_hub -c "\copy (SELECT * FROM world_books WHERE id IN ('0d2b7115-313d-4946-9cf8-e02d333faeac','216be880-5478-4191-b1d2-6fccc2ec7244')) TO STDOUT WITH CSV HEADER" > restore_worldbooks.csv
```

然后插入 palink-new 库（先插 `world_books` 再插 `world_book_stages`，
条目按 `world_book_id` 关联）。⚠️ 恢复后两本 `character_id` 仍为 NULL，
即「未绑定」—— 按 2026-10-03 起的新逻辑**不会注入任何对话**。

## 状态

- 删除完成度：2/2 已删，0 本未绑定书残留
- ⚠️ 依 AGENTS.md 规范第 4 条，**本目录内容不得删除或改写**。