# BACKUP_INFO — 2026-10-24_dist重建前_三面一致Wave1

## ① 备份日期

2026-10-24（本地，Flash 波次 1 收口后）

## ② 原始来源路径

`frontend/dist`（nginx bind mount 在用产物，17MB 级）→ `dist_before.tar.gz`（7,268,777 B）

## ③ 备份原因

上线「三面一致 Wave 1」前端批：API-2（extension_settings 子键默认，`90e4f16`）+ ASM-3（getWorldInfoPrompt 接后端同源扫描，`9d14fdf`）+ UI-2（style_removal 父侧聚合，`e90ef9c`）+ UI-1 钉死测试。改前入口 `assets/index-0pSC1Vx8.js`。

上线后读数：入口 `assets/index-DQu5RlVR.js`（dist/站点/容器三处一致），站点 200，三特征烤入验证（`minLongMemory` / `StyleRemovalAgg` / `worldbook-scan` 均命中新入口 chunk），gzip 139 份。构建中间目录 `dist_new_20261024` 已隔离至 `_BACKUPS/_QUARANTINE_2026-10-24_distnew_三面Wave1/`。

⚠️ **已知半态窗口**：ASM-3 前端调用的 `POST /api/character-sessions/{sid}/worldbook-scan` 端点在旧后端镜像中不存在（404 → 插件拿到空结果，按设计不回退旧引擎防双真相源）。后端重建因「全池普查正在打后端只读探针」暂缓，普查完成（run dwfrun-a3ac559e）后立即 `docker compose build backend && up -d backend` 消除窗口。

## ④ 后续待办清单

1. 普查完成 → 重建后端镜像 → 容器内验证 `worldbook-scan` 端点在位（`grep` 命中）+ healthy → 半态窗口关闭
2. 后端重建后跑一次真机冒烟：插件面 `getWorldInfoPrompt` 返回非空（worldInfoString 非空或 entries 对账字段在）
3. 已打开但未刷新的页面在旧 chunk 懒加载时可能白屏，F5 即恢复（历次重建已知代价）
