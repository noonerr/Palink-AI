# BACKUP_INFO — 2026-09-30_plugininject-dist重build前

## 备份日期
2026-09-30

## 原始来源
`D:\项目\Palink-AI\frontend\dist`（入口产物 `assets/index-DaNDTfV8.js`，12MB）

## 备份原因
修复「插件 setup 脚本语法错误导致整批插件注入中断」后需要重跑 `npm run build`。
`frontend/dist` 是容器 nginx bind mount 的在用产物，vite 构建会先清空输出目录，
浏览中的页面会瞬间失去旧哈希 chunk（实测旧文件返回 404）。按「删改前落物理备份」的规矩先整目录留档。

## 内容清单
- `frontend/dist/` 全目录快照（含 assets / st / icons / bootstrap.js / manifest*.json）

## 后续待办清单（备份之后需修复或修改的任务）
- [ ] 新 dist 构建完成后，在浏览器复验：控制台无 `appendChild ... Unexpected token ']'`
- [ ] 复验卡片扩展是否注入成功（`tavern_helper.scripts[2]` 的 CG 悬浮按钮 `#tavern-cg-float-btn`）
- [ ] 若用户反馈新产物有问题，可整目录拷回 `frontend/dist` 即刻还原（无需重新构建）

## 还原方式
`cp -r _BACKUPS/2026-09-30_plugininject-dist重build前/frontend/dist/. frontend/dist/`（或整目录替换）。
