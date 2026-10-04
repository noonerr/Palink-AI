# BACKUP_INFO — 2026-09-23_记忆清理-sql
## 备份日期
2026-09-23
## 原始来源
`D:\项目\Palink-AI\backups\2026-09-23-记忆清理`
## 备份原因
对 `conversation_memories` / `user_settings` 做清理前的数据库导出备份。
## 内容清单
conversation_memories_before.sql、user_settings_before.sql、err1.txt、err2.txt（导出过程日志）
## 后续待办清单（备份之后需修复或修改的任务）
- [ ] 若出现记忆丢失或设置被改坏，用两份 _before.sql 做行级比对还原
- [ ] 两个 err*.txt 记录导出时的报错，核实导出是否完整

## 归置信息
- 归置日期：2026-09-30
- 归置动作：由历史散落位置整体移入 `D:\项目\Palink-AI\_BACKUPS\2026-09-23_记忆清理-sql`，**目录内内容未做任何修改或删除**
- 还原方式：按上方「原始来源」路径拷回原位即可
