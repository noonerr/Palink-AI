# 备份说明

## ① 备份日期

2026-10-05

## ② 原始来源路径

`D:\项目\Palink-AI\frontend\dist\`（前端构建产物，容器 `palink-ai-frontend-1` nginx 的 bind mount 在用产物）

备份位置：`dist/`（用 `cp -r` 复制，**未移动** —— 移动会让 bind mount 失效导致 nginx 500）

校验清单：`sha256-manifest.txt`（281 个文件的 sha256）

## ③ 备份原因

窄屏（396px 等窄视口）两个问题的修复上线前备份，便于回滚：

1. **正文被截断**：iframe 高度硬上限 `IFRAME_MAX_HEIGHT = 5000`（`shared.ts:16`），
   窄屏折行暴涨导致长卡内容超过 5000 后被 `overflow:hidden` 永久裁掉，且完整网页文档卡
   走 `injectIntoFullDocument` 没有片段卡那条 `body{overflow-y:auto}` 内部滚动兜底，尾部永远看不到。
   修复：上限抬到 50000。
2. **正文列被挤窄**：三处固定 padding（正文列 `px-5`、移动端头像补偿 `36px`、聊天区 `px-1`）
   改为百分比，窄屏正文列从屏宽 70% 提到约 90%。

⚠ 备份时发现 dist 已是**半成品构建**状态：`assets/` 下有 4 组 `index-*.js` 指纹
（`4S6UkaWH` / `CCLB1sS6` / `DqWaM-dT` / `OVaxcVhT`），而 `index.html` 只引用 `index-OVaxcVhT.js`。
即上一次构建中途断过。其余 3 组是历史残留，**这份备份本身就是混着旧残留的状态**，
不要拿它当"干净基线"比较。

## ④ 后续待办清单

- [ ] 重建 dist 后，按项目规范验证产物：`index.html` 引用的资源全部存在 +
      `assets/` 里 `index-*.js` 只剩一个指纹（本次构建后应只剩一个，旧 4 组全消失）
- [ ] 重建后确认容器在服务新指纹（`docker compose restart frontend` + 比对 mtime）
- [ ] 真机窄屏验收：正文末尾完整可见（不再停在 5000/50000 处）、正文列宽度约占屏宽 90%
- [ ] 宽屏回归：确认百分比内边距在宽屏下观感无明显变化
- [ ] 若需回滚：把本目录 `dist/` 整份拷回 `frontend/dist/`（覆盖，不删 dist 本身），再重启 frontend 容器