# BACKUP_INFO — TestInstruct 12 行删除快照

- **备份日期**：2026-10-26
- **原始来源路径**：生产库 `ai_hub` 表 `instruct_templates`（id 6–17，name 全部 = TestInstruct，user_id=4 测试账号 hacker_test）
- **备份原因**：用户 2026-10-26 点头删除（原话「第一个你帮我删了」）。这 12 行是 2026-07-19~08-11 间已删除的测试脚本 `palink_golden_vector.py` 直连生产库跑测试的残留（脚本每跑一次建一行 TestInstruct、清理段唯独漏删 instruct 行）；当前零前端入口、API 仅属主可见、全库零引用。取证全链：`docs/_active/report/REPORT_查验_TestInstruct12行来龙去脉_2026-10-26.md`
- **快照内容**：`instruct_TestInstruct_id6-17_snapshot.json`（删前全行 JSON，10,269 B；尾行 CHECK count|min|max = 12|6|17 与取证预期一致）
- **后续待办清单**：
  1. 无功能性待办（删除零影响，已验证：deleted_rows=12、remaining_TestInstruct=0、表余 5 行正常模板未动）。
  2. 如需回滚：按快照 JSON 逐行 INSERT 回 `instruct_templates` 即可（字段以快照为准）。
