# BACKUP_INFO — S1 收尾（G7）与 T2 施工备份

- **日期**：2026-10-13 07:57
- **分支**：`three-tracks-merge-20261012`
- **施工前 HEAD**：`a8919ef`（docs: T1/T3 验收报告 + 剩余任务提示词）
- **施工前 git status**：0（干净树）
- **施工内容**：G7（世界书名首次为空 → MVU `initialized_lorebooks` 退化）真机验证与修复；T2（iframe 生命周期）
- **依据文档**：`docs/_active/report/REPORT_交接文档复核与T2-S5实施准备_2026-10-13.md`

## 本目录内容

| 文件 | 说明 |
|---|---|
| `shim-baseline-before-G7.txt` | `buildShim()` 产物基线快照（**改代码之前拍**，136,431 字符） |
| — | SHA256 `5a025f971f8a69289f95a786f6ed466054d1054a8c0dd39cc532499c4f075ff7` |

拍快照命令（在 `frontend/` 下）：

```bash
node scripts/verify-shim-identity.mjs snapshot \
  src/components/ui/custom/CharacterCardRenderer.tsx \
  "../_BACKUPS/2026-10-13_S1收尾G7与T2/shim-baseline-before-G7.txt"
```

改完对比（应只落在预期段落）：

```bash
node scripts/verify-shim-identity.mjs compare \
  "../_BACKUPS/2026-10-13_S1收尾G7与T2/shim-baseline-before-G7.txt" \
  <新快照.txt>
```

## 仓库外备份（R4）

| 项 | 位置 | 大小 |
|---|---|---|
| 分支全历史 bundle | `D:\项目\_palink-s0-20261012\palink_three-tracks-merge_20261013.bundle` | 75,051,405 B（含 `a8919ef`） |
| DB 全量 dump | `D:\项目\_palink-s0-20261012\palink_ai_hub_dump_20261012.sql` | 36M |
| 上传目录快照 | `D:\项目\_palink-s0-20261012\backend_data_snapshot\` | 461M |

出仓命令（重型 git 操作会被 SIGKILL，bundle 是本机唯一可靠手段；`git stash -u` 本仓禁用）：

```bash
git bundle create "D:/项目/_palink-s0-20261012/palink_three-tracks-merge_20261013.bundle" three-tracks-merge-20261012
```

## 施工前门禁基线（实测，非引用）

| 项 | 值 |
|---|---|
| vitest | 876 passed / 1 failed / 3 skipped（880）｜唯一红 = `storage-isolation-contract.test.ts:221`（S2 设计红） |
| tsc `--noEmit` | 退出码 0 |

## 回退

- R3：`git revert` 到 `merge-base`（`66672a0`）区间；DB 用上表 dump 恢复。
- R4：工作区整体回退，用上表 bundle + `_BACKUPS` 历史。
- 单点回退：每步一笔提交（`git commit -o -- <pathspec>`），删码单独一笔，逐笔 revert 即可。
