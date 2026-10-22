# BACKUP_INFO

1. **备份日期**：2026-10-05
2. **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（nginx bind mount 在用产物）
3. **备份原因**：修复 MVU 初始化报错（补主页面 getCharWorldbookNames / getCharWorldbook /
   getCurrentCharacterId）前，先留存当前在用产物，便于回滚与对照指纹。
4. **后续待办清单**：
   - 本批改动仅动 `frontend/src/utils/sillyTavernPluginRuntime.ts`（+64 行，纯新增三个 API）
   - 重建后需真机验收：① MVU 初始化两条报错是否消失 ② 相册能否解锁 ③ 面板变量是否跟随
   - 尚未提交 git（工作树含并行会话的 MVU 相关改动，非本批独有）
