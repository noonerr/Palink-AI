# BACKUP_INFO — SOP 清单修复与遗留项处置前

## ① 备份日期

**2026-10-03 22:04**（实际创建时间，`date '+%Y-%m-%d %H:%M'` 核对）

## ② 原始来源路径

- **主区**：`D:\项目\Palink-AI\`（待改文件按原相对路径存于 `pre/`，共 44 个）
- **测试栈**：`D:\项目\palink-new\_BACKUPS\2026-10-04_清理未绑定世界书\BACKUP_INFO.md`（存于 `pre/palink-new/...`）
- **git 历史**：`main-repo.bundle`（`--all`，131M）
- **未提交状态**：`worktree-uncommitted.patch`（`git diff HEAD --binary`，17,746 B）
- **未跟踪文件清单**：`untracked-list.txt`（69 路径）

## ③ 备份原因

用户裁定「**修复 `docs/SOP_Agent交付自查清单.md` 文档 + 处置其记录的仓库遗留项**」动工前的物理快照。
本批要改/要动的对象跨文档、前后端代码、历史记忆、测试栈，均为可回退需留档者：

| 类别 | 数量 | 说明 |
|---|---|---|
| SOP 文档自身 | 1 | 订正 8 处结构/表述缺陷 |
| 代码/配置（错误日期） | 16 文件 / 34 处 | `2026-10-04` → `2026-10-03`（契约标签/注释） |
| 历史文档（加作废横幅） | 26 | 含 `test:contract` 旧口径的主仓 md |
| 测试栈备份说明书 | 1 | palink-new 备份目录改名 + 补 `_INDEX.md` |

⚠️ 另有两项**清理**（不进本 `pre/`，走隔离区流程）：
`test_attack/`（10 文件，已隔离）、`.mimosa/`（1.6G / 50967 文件，拟隔离后删）。

## ④ 后续待办清单

- [x] 备份 44 个待改文件 + `_manifest.tsv`（sha256 校验）
- [x] 保存 git bundle + 未提交 patch + 未跟踪清单
- [ ] 订正 SOP 文档 8 处缺陷
- [ ] 订正 16 文件 34 处 `2026-10-04` 错误日期
- [ ] `test_attack/` 删除（已隔离，待确认）
- [ ] `.mimosa/` 隔离后删除（工具会自建，用户已裁定）
- [ ] 26 份文档逐份加 `test:contract` 作废横幅
- [ ] palink-new 备份目录改名 + 补 `_INDEX.md`
- [ ] 门禁：`tsc --noEmit` / `vitest run` / `pytest`（只认 `failed = 0`）
- [ ] 逐项 pathspec 暂存提交（禁 `git add -A`）

## 恢复方式

```bash
# 单文件回捞（以 SOP 文档为例）
cp -p "_BACKUPS/2026-10-03_SOP修复与遗留处置/pre/docs/SOP_Agent交付自查清单.md" \
      "docs/SOP_Agent交付自查清单.md"

# 校验备份完整性
cd "_BACKUPS/2026-10-03_SOP修复与遗留处置/pre" && sha256sum -c ../_manifest.tsv

# 从 bundle 恢复 git 历史（如仓库损坏）
git clone "_BACKUPS/2026-10-03_SOP修复与遗留处置/main-repo.bundle" <目标目录>

# 回放未提交改动
git apply "_BACKUPS/2026-10-03_SOP修复与遗留处置/worktree-uncommitted.patch"
```

## 快照内容

| 文件 | 大小 | 说明 |
|---|---|---|
| `pre/` | 44 文件 | 待改文件按原相对路径摆放 |
| `_manifest.tsv` | 44 行 | 每文件 sha256 |
| `main-repo.bundle` | 131 M | 主区全量 git 历史（`--all`） |
| `worktree-uncommitted.patch` | 17,746 B | HEAD 与工作区差异（含 SOP 未提交修订） |
| `untracked-list.txt` | 69 行 | 未跟踪文件路径清单 |
