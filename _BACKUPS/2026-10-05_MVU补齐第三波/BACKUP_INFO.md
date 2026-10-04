# BACKUP_INFO — 2026-10-05 MVU 补齐第三波

## ① 备份日期

2026-10-05（当日 03:4x ~ 04:0x，GMT+8）

## ② 原始来源路径

| 备份内相对路径 | 原始来源 |
|---|---|
| `pre/backend/app/api/character_ext.py` | `backend/app/api/character_ext.py` |
| `pre/backend/app/services/character_message_builder.py` | `backend/app/services/character_message_builder.py` |
| `pre/frontend/src/components/ui/custom/Message.tsx` | `frontend/src/components/ui/custom/Message.tsx` |

校验清单：`_manifest.tsv`。另含本波新增的流程工具（`_stage_only_mine.py` /
`_stage_message_mine.py` / `_stage_insert_only.py`）与对照快照目录 `_tmp/`。

## ③ 备份原因

用户放行「继续做第二波，只提交你自己的」后开工的第三波，动了**三个同时被另一 agent
改动、且未提交**的文件。备份用于：① 回滚；② **做归属判定**（见 ④-3 的教训）。

三项改动：

- **P0-2 门 A**：`PUT /{sid}/metadata` 加写入闸门（剔 `palink_*`、`variables` 非 dict
  忽略、空 dict 且库里非空忽略）。
- **P3-a**：世界书 `enabled=false` 条目原先照旧参与 `<initvar>`/schema 提取，
  抽 `mvu_entry_filter.select_character_book_contents` 统一筛选，改 3 处调用方。
- **P2 前端**：`TavernHelperPanel` 加编辑能力 + `Message.tsx` 传 `sessionId`。

## ④ 后续待办清单

1. **本波未做**：P3-b（重新初始化端点）、P3-c（卡级设置覆盖，需先核 bundle 真实键名）、
   P3-d（生成链路失败通知，需与清理 agent 划边界）。P3-a 的第二步（白/黑名单正则）未做。
2. **P2 端点的已知限制**：手动改值只写 `chat_metadata.variables`（会话级），
   **不回写消息级快照** ⇒ 往回看历史楼层仍是改前的值（设计上正确，但需知悉）。
3. **归属判定的教训（本波踩到，成本约 20 分钟）**：
   我一度判定「4 例 `TestMemSyncOnSwitch` 红是我的改动引起」，方法是「把文件还原成
   备份快照再跑」。**结论错了** —— 因为那份备份是 03:47 的快照，而对方在 03:47~03:52
   之间**又改过该文件**（`store_memory` 5 处 → 3 处，正在做「记忆镜像隔离修复」），
   所以「还原后变绿」其实是回到了**对方的旧版本**，与我的改动无关。
   正确做法（已执行）：构造「**对方当前版**」= 我的版本精确减去我的两处改动，
   用它跑同一批用例 —— 同样 4 例红 ⇒ 归属为对方在改的中间态。
   **判据：A/B 对照必须在同一基线上做，不能用陈旧快照。**
4. **另一个本波修掉的自伤**：`TavernHelperPanel.tsx` 里我误写入 2 个**字面 NUL 字节**
   （本该是空格），导致 git 把整个文件判成二进制（`Bin 7341 -> 10584`）。
   已改用 `JSON.stringify([group, field])` 作 draft 键，NUL 清零、diff 恢复正常文本。
   **教训：写完含分隔符的代码后，必须查一次 `NUL count`。**
5. **`_stage_only_mine.py` 的粒度局限**：按 hunk 过滤时，若我的改动与对方的改动
   **相邻**（中间上下文不足以切开），git 会把二者并进同一 hunk，按 hunk 过滤必然
   把对方改动带上。`Message.tsx` 与 `_BACKUPS/_INDEX.md` 都是这种情况，
   已改用「HEAD + 我的插入」直接构造索引 blob（`_stage_message_mine.py` /
   `_stage_insert_only.py`）。
6. **提交纪律**：本波一律 `git commit -- <我的路径>`（带 pathspec），
   **不 `git reset` 对方的暂存内容**，避免打断对方在进行中的提交准备。
   注意当前索引里还躺着对方的 `roleplay_prompt_assembly.py`（整文件行尾差异），
   本波提交**刻意排除**它。
