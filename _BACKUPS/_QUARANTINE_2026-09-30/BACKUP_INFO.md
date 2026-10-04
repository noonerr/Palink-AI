# BACKUP_INFO — _QUARANTINE_2026-09-30（隔离区，非备份）

## 隔离日期
2026-09-30

## 原始来源
- `D:\项目\Palink-AI\` 根级临时日志 ×10
- `D:\项目\Palink-AI\frontend\` 旧构建日志、`.next`、`dev/`、`frontend/`、`dist_old_*`、`dist_prebuild_*`
- `D:\项目\Palink-AI\backend\` 一次性调试脚本 ×4
- `D:\项目\Palink-AI\scripts\` 一次性探针脚本 ×10

## 隔离原因
2026-09-30 工作区清理行动：这些是临时日志、旧构建产物与一次性调试脚本，**尚未删除**，先隔离观察。

## 内容清单
- `_logs/` — 构建/类型检查日志共 18 个（约 300KB）
- `frontend/` — `.next`（空壳）、`frontend/tmp-delete-check`、`dev/null`、`dist_old_20260927_imgproxy`、`dist_old_20260929`、`dist_old_20260930`、`dist_old_20260930_wbvec`、`dist_prebuild_20260923`（合计约 48MB）
- `backend/` — `_tmp_check_embedder.py`、`_tmp_verify_engine.py`、`tmp_api_check.py`、`tmp_fix_admin.py`
- `scripts/` — `s1.js`~`s6.js`、`check-dom.js`、`check-inline.js`、`check-style.js`、`render_script.txt`、`test-dompurify-style.js`
- `_empty-shells/` — 备份搬走后留下的空目录：`backup/`、`backups/`、`Palink-AI-backups/`、`_palink_backups/`

## 后续待办清单
- [ ] 确认前端容器 `palink-ai-frontend-1` 页面正常（dist 未被误移）
- [ ] 确认 `npx vitest run` 仍为 32 文件 / 444 passed
- [ ] 确认 `npx tsc --noEmit` 0 错误
- [ ] 上述三项通过后再删除本目录
- [ ] 删除动作属不可逆操作，须由用户确认后执行

## 归置信息
- 归置日期：2026-09-30
- 保留原始相对路径结构（`frontend/`、`backend/`、`scripts/`），随时可按路径拷回原位
