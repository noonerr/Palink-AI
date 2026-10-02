# BACKUP_INFO

> ⚠️ **本说明为 2026-10-03 补写**（原备份未留说明，按 AGENTS.md 第 2 条本应属无效备份）。
> **补写时未改动本目录内任何原有文件**，内容零改动，仅新增本文件。
> ①②④ 三项中凡标注「据内容推断」者，均为原记录已佚后的还原，非原始记录。

## ① 备份日期

**2026-10-01**（据目录名与文件 mtime）

## ② 原始来源路径

| 备份内相对路径 | 原始绝对路径（据内容推断） | sha256 |
|---|---|---|
| `src/Message.tsx` | `D:\项目\Palink-AI\frontend\src\components\ui\custom\Message.tsx` | `21a2102c9037f65b91538f55bbed99adfba6005b940490a5b925295aaa481474` |
| `src/formatting.ts` | `D:\项目\Palink-AI\frontend\src\lib\formatting.ts`（**路径层级未确证**） | `a090a0abafb38bf3ea399f454546c332337dc1911fca5fd172c5bf9fe6a7721e` |
| `src/sillyTavernDisplayPipeline.ts` | `D:\项目\Palink-AI\frontend\src\lib\sillytavern\sillyTavernDisplayPipeline.ts`（**路径层级未确证**） | `369763d8645e15cf48a6f9450a21bace504e6e9dcd283ef035a125287e6abf13` |
| `src/roleplay_prompt_assembly.py.bak` | `D:\项目\Palink-AI\backend\app\services\roleplay_prompt_assembly.py` | `429ee55f595236359fc5f84d36b9bdf489574bc2fb220512bd8732d706dcca65` |
| `plugin-script-dbui-before.js` | DB 内 `plugin_scripts.content` 字段导出（卡内 TavernHelper 脚本原文，**非文件系统文件**） | `b8cafc589e373728a120456530ea199655efa3c41baf7aa857903970dc68c213` |

- `src/` 下三个前端文件的**原始目录层级未确证**（备份时未保留原相对路径，只摆平放在 `src/`）。
  按文件名与当前仓库比对定位，`Message.tsx` 路径可确证，另两个仅推断。
- `roleplay_prompt_assembly.py.bak` 路径可确证（与仓库现路径同名）。

## ③ 备份原因

**@bubble 渲染断链修复批次动工前的留档**。备份内容横跨前后端与数据库三处，
与该批的改动面对应：

- 前端渲染层：`Message.tsx`（消息渲染）、`sillyTavernDisplayPipeline.ts`（ST 显示管线）、
  `formatting.ts`（格式化）
- 后端装配层：`roleplay_prompt_assembly.py`（提示词装配，裸标签剥离/降级逻辑所在）
- 卡内脚本：`plugin-script-dbui-before.js`（卡内 TavernHelper 脚本原文，改装配前先留底）

对应文档：`docs/PROMPT_卡脚本本地存储按角色与账号隔离_2026-10-02.md`
（同源施工线）与 `TODOS.md` 2026-09-30~10-01 的 @bubble 系列条目。
该批的收尾提交可见 git：`bd07eab`（施工前工作树快照）、
`c1e0c5d` / `9bfa21c` / `80861b8` / `e532d14` 等 @bubble / 裸标签系列。

## ④ 后续待办清单

1. **原始路径层级待查**：`formatting.ts` 与 `sillyTavernDisplayPipeline.ts`
   的备份内路径已摆平，回捞时**必须按文件名在仓库内定位**，不要按 `src/` 直接覆盖。
2. **本备份与 10-02/10-03 两批有重叠**：`roleplay_prompt_assembly.py` 在
   10-02「格式规范残本修复」批中又被大改（见 `2026-10-02_格式规范残本修复/`）。
   **本备份是「10-01 之前」的状态，比它更新的锚点应优先用 10-02 那份**，
   除非明确要回到 10-01 那一刻。
3. **决策已两次反转，回捞前务必确认口径**：
   10-01 清洗方向（擦 @bubble）→ 10-02 改为保留历史外壳 → 10-02 又改默认落地。
   恢复任一状态前，先读 `TODOS.md` 顶部 2026-10-02 条目的最终结论。
4. **卡内脚本原文属隐私内容**：本目录含卡内 TavernHelper 脚本原文，
   引用时**只取结构/长度/键名，不要整段贴出正文**。
