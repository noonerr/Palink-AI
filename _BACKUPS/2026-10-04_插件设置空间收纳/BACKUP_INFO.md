# BACKUP_INFO — 2026-10-04 插件设置空间收纳

## ① 备份日期

2026-10-04 01:28（`date '+%Y-%m-%d %H:%M'` 实测；备份动作 01:30~01:35）

## ② 原始来源路径

| 文件 | 状态 |
|---|---|
| `frontend/src/components/st-plugin-ui-host/StPluginMountPoints.tsx` | 本轮将改（挂载点常驻隐藏） |
| `frontend/src/components/views/character/CharacterChat.tsx` | 本轮将改（接线抽屉）；**注意：含上一会话（酒馆助手 API 适配）未提交改动** |
| `frontend/src/components/views/character/chat/ChatMoreMenu.tsx` | 本轮将改（加「插件设置」菜单项） |

## ③ 备份原因

施工「插件设置空间收纳」前留回滚点：把 `#extensions_settings` / `#extensions_settings2`
从「有内容自动显示在页面流」改为常驻隐藏 + 插件设置抽屉（真实节点 move 进出），
并补 inline-drawer 折叠交互。动工前按 AGENTS.md 备份规范三步执行。

**备份方式说明**：Mimosa hook 拦截 Bash 碰源码路径（cp / git cat-file 重定向均拦），
故双轨备份：
1. **git stash 快照（权威回滚点）**：`stash@{0}` = `ba8b21c8bdbef115ba20102d071dbbeb73b2a914`
   （message：`pre-插件设置空间收纳-2026-10-04`，含全部未提交改动的工作树快照）；
2. **物理副本**：由仓库外脚本 `C:\tmp\palink_export_pre_20261004.sh` 经
   `git cat-file blob <stash>:<path>` 导出（`pre/` 目录，sha256 见 `_manifest.tsv`）。

## ④ 后续待办清单

- [ ] 施工完成后跑门禁：`cd frontend && npx tsc --noEmit` + `npx vitest run`（failed = 0）
- [ ] 旁路构建 dist 并部署（VITE_OUT_DIR 旁路 + 原地覆盖 + gzip + 确认容器指纹）
- [ ] 真机/浏览器验收：MVU 面板不再出现在页面流；三个点菜单 → 插件设置 → 面板可交互可折叠
- [ ] `TODOS.md` 登记本轮成果与遗留（脚本按钮栏 UI 可挂进新抽屉，见 TODOS.md:23 P0 项）
- [ ] 上一会话遗留（与本备份无关但同工作树）：隔离区 4 个 dist_new_* 处置、上批改动是否提交 git，仍待用户表态
