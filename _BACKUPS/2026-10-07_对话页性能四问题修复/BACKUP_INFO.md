# BACKUP_INFO

## ① 备份日期
2026-10-07 02:17（GMT+8）

## ② 原始来源路径
全部位于 `D:\项目\Palink-AI\frontend\src\`：

| 文件 | 大小 |
|---|---|
| `components/views/CharacterView.tsx` | 74,389 B |
| `components/views/character/CharacterChat.tsx` | 108,218 B |
| `components/ui/custom/Message.tsx` | 107,267 B |
| `components/ui/custom/CharacterCardRenderer.tsx` | 90,696 B |
| `hooks/useSessionSwitchAnimation.ts` | 5,181 B |

## ③ 备份原因
「角色卡对话页性能四问题」修复施工前备份。对应排查报告
`docs/_active/report/REPORT_角色卡对话页性能四问题排查_2026-10-07.md`。
四项待修：①点击进入对话无 loading 反馈；②历史消息补渲染导致滚动跳动；
③请求与缓存（重复请求 / TTL 过短 / 后端全量回退）；④分支切换卡死 3-5s 与正文空白。

这五个文件均为**在用生产源码**，且 `CharacterChat.tsx` / `Message.tsx` 历史上混有未提交批次改动
（见 10-06 报告 §5.5 的 hunk 切分说明），改动前必须先留物理备份以便逐文件回滚。

## ④ 后续待办清单
- [ ] 问题 1：新增 `switchingSessionId` state，点击会话入口即点亮 spinner；`handleSelectSession` 的非首屏请求改为后台并发；删除重复的 `loadMemoryStats`
- [ ] 问题 2：`loadOlderMessages` prepend 后补 `scrollTop`；`#chat` 加 `overflow-anchor: none`；初始底锁去掉 1.5s 硬时限
- [ ] 问题 3：删除 `CharacterChat.tsx:787` 的 `?limit=1` 多余请求（variables 复用 messages 响应）；messages/branch-tree TTL 10s/15s → 60s
- [ ] 问题 4：卡片 iframe 首屏懒挂载；正文渲染与 4MB 插件脚本执行解耦；修复 `repaintKick`（transform 翻转可能不触发重绘）
- [ ] 门禁：`npx tsc --noEmit` + `npx vitest run`（failed=0）
- [ ] 改后重建 dist 并确认容器在服务新指纹（14000 端口）

## 回滚方式
```bash
cp _BACKUPS/2026-10-07_对话页性能四问题修复/src/<文件名> frontend/src/<对应目录>/
```
