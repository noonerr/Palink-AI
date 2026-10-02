# BACKUP_INFO — dist 重建前（报错批上线）

## ① 备份日期

2026-10-03 02:37（构建开始前）

## ② 原始来源路径

`D:\项目\Palink-AI\frontend\dist`

- 产物生成时间：**2026-10-02 22:20**
- 备份时文件数：404，体积 22MB
- `index.html` 引用：`/assets/index-DMlQT9yx.js` + `/assets/index-DAHj4yWK-18f17586.css`
- 逐文件 sha256：见同目录 `dist_manifest.sha256`（404 行，与文件数一致）

## ③ 备份原因

源码比产物新约 3.5 小时（源码最新 mtime 2026-10-03 02:08，产物 10-02 22:20），
且 `dist/assets` 内同时存在多组不同指纹的 `index-*.js` / `index-*.css` 而 `index.html`
只引用旧的那一组 —— 说明 10-02 22:20 那次构建中途断过，新产物已落盘但入口未切换。

导致多条「已完成」实际未上线，本次重建前必须留可回滚锚点：

- 卡脚本本地存储隔离（P0/P1/P2，commit `319d6d4`）
- 可用高度解锁模块（commit `cb89a1d`）
- 格式规范前端中继（DB 行 `source_key=fnv1a-pggfwp`、`length=1796`、
  `identifier=bubble-dialogue-format` 依赖新 bundle 哈希自愈）
- 报错提示模板落地批（ErrorToast / NetworkStatus / Message 等 8 文件，+245/-62）

`frontend/dist` 是容器 nginx 的 bind mount 在用产物，按 AGENTS.md 第 6 条属红线，
按第 5 条删除前必须先备份。

## ④ 后续待办清单

1. **构建后必查**：`index.html` 引用的指纹与 `dist/assets` 实际产物一致，无孤儿产物残留
   （10-02 那次的症状就是有孤儿却没切换入口）。
2. **必须按 `build → mv → gzip-dist` 顺序**。顺序颠倒会把 gz 写进旧 dist。
3. **确认 `assetContentHashPlugin` 仍在 `vite.config.ts` 生效**（commit `8005394` 补回过
   一个「引用了但从未入库」的插件）。一旦丢失，iOS 侧 CSS 改动会重新送不到手机，
   K20b 问题全面复发，且该护栏目前只有注释、无测试保护。
4. **复查 extension_prompts 持久化行未被摘掉**：期望 `source_key=fnv1a-pggfwp`、
   `length=1796`、`identifier=bubble-dialogue-format`。被摘或换键 = 格式规范再次缺席。
5. **真机验收**：报错提示批与卡脚本隔离批至今无真机读数，重建只解决「上线」，
   不等于「好用」。
6. **构建约定无护栏**：`assetContentHashPlugin` 与构建顺序两条约定目前只靠注释，
   建议补一条构建后自检（入口指纹一致性），否则同类半成品构建会再次发生。

## 备注（未改动存量）

本目录为新增备份，未删除或改写任何既有备份内容。
