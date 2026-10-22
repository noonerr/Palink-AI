# BACKUP_INFO

1. **备份日期**：2026-10-06 02:56（GMT+8）
2. **原始来源路径**：`D:\项目\Palink-AI\frontend\dist`（容器 nginx bind mount 的**在用产物**，12M）
3. **备份原因**：重建 dist 前留存可回滚快照。本批两处前端改动需要重新打包才能生效：
   - `frontend/src/components/ui/custom/CharacterCardRenderer.tsx`：沙箱补齐
     `allow-modals allow-forms allow-popups allow-downloads`（原两种模式都只有脚本权限，
     卡内 `alert/confirm/prompt` 静默失效 → 表现为「按钮点了没反应」）
   - `frontend/src/utils/sillyTavernPluginRuntime.ts`：`worldbookGetEntries` 请求体带上
     `characterId`（同名世界书去重偏好，配合后端 `prefer_character_id`）
   备份用于指纹对照与回滚（旧 chunk 哈希仍可从此目录取回对比）。
4. **后续待办清单**：
   - 重建后验证线上 `index.html` 引用的入口 chunk 已换、且新 chunk 内可 grep 到
     `allow-modals`（标识符会被压缩，**只认字符串字面量**）
   - 真机验收：那张 Galgame 卡的设置按钮是否可点开（P3，根因仍未定性）
   - 未提交：后端三处 + 前端两处 + 一条回归测试都还在工作区，需逐项 pathspec 提交
   - 后端已于 02:40 重建并确认生效；**本目录只覆盖前端 dist**

## 重建前比对结论（安全检查）

`frontend/src` 中 mtime 晚于上次 dist 构建时间（2026-10-05 21:07）的 `.ts/.tsx` 文件
**只有 2 个**，且都是本批自己改的（上面那两个）。⇒ 本次构建**不会**把并行会话的在途改动
一起固化进产物。
