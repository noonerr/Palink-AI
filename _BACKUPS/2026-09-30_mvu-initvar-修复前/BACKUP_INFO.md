# BACKUP_INFO

- **备份日期**：2026-09-30（17:5x，Asia/Shanghai）
- **原始来源路径**：
  - 工作区当前在途状态（tracked 文件全部） → 以 `git stash` 快照形式保存
  - 快照 sha：`e5d0d077b358aaba7ca5f41023a7313e27e9a128`
  - 登记名（`git stash list` 可见）：`pre-mvu-initvar-fix snapshot 2026-09-30 (MVU 初始变量断链修复前)`
  - 参照提交：`HEAD = 15dc75c9ed5c49a19e2f7edc7e0371c88d88a838`，同名轻量 tag `pre-mvu-initvar-fix-20260930`
- **备份原因**：
  修复「MVU 初始变量断链（过度思考根因）+ 输出 tag 裸显」批次**动工前**的安全网。
  权威施工 SPEC：`docs/SPEC_MVU初始变量断链与输出tag裸显修复_2026-09-30.md`；
  复核报告（本批复核的 10 项修正）：`docs/复核_MVU初始变量断链与输出tag裸显_2026-09-30.md`。
  本批将改动：后端 `mvu_engine.py`（补 `palink_raw_card_data` 嵌套 initvar fallback）、
  前端显示层（【声音】行隐藏，落点见 SPEC 修订）、可能触及 `character_ext.py` / `character_message_builder.py`（数据源取列值）。

- **为何不是物理文件拷贝**：本仓 Mimosa 钩子禁止 Bash 直写/拷贝 `.py`、`.tsx`、`.ts` 文件到备份区
  （先例：`_BACKUPS/2026-09-30_卡片可用高度解锁批` 同样改用 `git stash create` 快照）。
  故本备份以 **git 对象**形式保存，逐字节可还原，且不产生任何 `.py` 落盘副本。

- **后续待办清单（备份之后要做的修改）**：
  1. **T1（P0）**：`backend/app/services/mvu_engine.py` `build_initial_stat_data` / `_extract_initvar_from_character_book`
     补 `palink_raw_card_data.data.*`（并含 raw 顶层 `first_mes`）fallback；数据源优先级改为 **`characters.first_mes` 列 > raw 快照**；
     嵌套 `character_book` 写成 fallback-only（避免盖掉 world_books 来源）。
  2. **T2（P1）**：@bubble 裸显重定性——**主因是消息缺 `<now_plot><content>` 包裹导致卡正则不命中、无 `dcRoot` 渲染宿主**；
     次因是引号漂移。落点不得沿用"改 `plugin_scripts` 内容"（注入文本由客户端每请求组装）。
  3. **T3（P1）**：【声音】行显示层隐藏。**禁止落在 `Message.tsx` 的 `displayContent`** ——
     `Message.tsx:1112` 把 `displayContent` 传给 `playMessage`，`tts.ts:635` 从该入参提取声线，
     在此剥离会打断 TTS 声线提取（复现 2026-09-25 旧故障）。落点改 formatter / `formatting.ts` 侧。
  4. 补测试：后端 pytest（嵌套结构 + 顶层结构 + 列优先）、前端 vitest（【声音】隐藏 + 声线提取不回归）。
  5. 门禁：容器全量 `python -m pytest tests/ -q`（2026-09-30 实测 **1623 collected**）、`npx tsc --noEmit`、`npx vitest run`。
  6. 施工完成后更新 `docs/SPEC_...` 施工结果段与 `TODOS.md` 状态。

- **恢复命令**：
  ```bash
  # 只看备份内容（不改工作区）
  git stash show -p 'stash@{0}' | less          # 若索引已变，用 sha 直取：
  git show e5d0d077b358aaba7ca5f41023a7313e27e9a128 --stat
  # 取单个文件的历史版本（不改工作区）
  git show e5d0d077b358aaba7ca5f41023a7313e27e9a128:backend/app/services/mvu_engine.py > /tmp/mvu_engine.py.bak
  # 与 HEAD 对比
  git diff 15dc75c9ed5c49a19e2f7edc7e0371c88d88a838 e5d0d077b358aaba7ca5f41023a7313e27e9a128
  ```
  > 注意：**不要** `git stash pop/apply` —— 该快照是"动工前状态"，直接应用会覆盖当前工作区。
  > 恢复单文件时务必显式指定路径。

- **同目录附带文件**：
  - `manifest.tsv` —— HEAD/tag/stash 标识 + 本批可能触及文件的**工作区 blob 哈希**（修复前）
  - `worktree-status.txt` —— 备份时刻 `git status --porcelain` 全量输出（59 行，含其他 agent 的在途改动）
  > 这两个文件在 `_BACKUPS/**` 的 gitignore 范围内，不入库，属本地物理留档。
