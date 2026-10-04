# BACKUP_INFO — 2026-09-23_pre-deadcode-full

## 备份日期
2026-09-23（备份产出时间 2026-09-24 01:19:43，与 manifest 内置时间一致）

## 原始来源
`D:\项目\Palink-AI-backup-pre-deadcode-20260923`（项目根目录之外，`D:\项目\` 直属）

## 备份原因
「死代码清理」批次的**物理备份（完整版）**。manifest 首行自述：对应 git tag `pre-deadcode-20260923`（指向 `9fde679`）。
本目录带 `_manifest.tsv`，逐文件记录 sha256 / 字节数 / 备份内路径 / 恢复目标仓库相对路径，是可直接校验、可直接还原的完整备份。

> 与 `2026-09-23_pre-deadcode` 的区别：那份只有 backend 子树、无 manifest；**本份才是权威备份**，两者共存，勿混淆。

## 内容清单
- `_manifest.tsv`（19KB，清单：group / sha256 / bytes / 备份内路径 / 恢复目标路径）
- `backend/`（app/api、app/llama_service.py、app/memory_module、app/model_manager.py、requirements.txt 等）
- `frontend/`（src/components、src/hooks 等）
- `repo/`（new-ui-demo、v2-runtime-debug.js、微信图片_20260430021110_106_87.png 等仓库内杂项）

## 后续待办清单（备份之后需修复或修改的任务）
- [ ] 如需回滚死代码清理：按 `_manifest.tsv` 第 5 列「恢复目标(仓库相对路径)」逐文件拷回，并用第 2 列 sha256 校验
- [ ] 确认备份对应的 `9fde679` 是否已在主线；若已远超该点，本目录可降为「仅留 manifest 存档」
- [ ] 与 `2026-09-23_pre-deadcode` 二选一长期保留，另一份可删（避免同一时点两份备份误用）

## 归置信息
- 归置日期：2026-09-30
- 归置动作：由 `D:\项目\Palink-AI-backup-pre-deadcode-20260923` 整体移入本目录，**内容未做任何修改或删除**
- 还原方式：按上方「原始来源」路径拷回原位即可
