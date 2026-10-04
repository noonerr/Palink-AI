# BACKUP_INFO — 2026-06-08_source-snapshot
## 备份日期
2026-06-08
## 原始来源
`D:\项目\Palink-AI-backups\20260608-001219`
## 备份原因
全仓库源码快照（动大手术前的整树打包），当时工作区有大量改动。
## 内容清单
source-snapshot.tar.gz（5.2GB 整树快照）、git-diff.patch、git-diff-cached.patch、git-status-short.txt、untracked-files.txt
## 后续待办清单（备份之后需修复或修改的任务）
- [ ] 体积 5.2GB，是本次归置中最大的单文件；如磁盘紧张可在确认当前版本稳定后单独删除
- [ ] 回滚方式：解包取文件 + 参考 git-diff.patch / untracked-files.txt 还原当时状态

## 归置信息
- 归置日期：2026-09-30
- 归置动作：由历史散落位置整体移入 `D:\项目\Palink-AI\_BACKUPS\2026-06-08_source-snapshot`，**目录内内容未做任何修改或删除**
- 还原方式：按上方「原始来源」路径拷回原位即可
