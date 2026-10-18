# BACKUP_INFO — 2026-10-18_dist_批次FJ重建前

## ① 备份日期
2026-10-18（约 23:0x，Git Bash 实测）。

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist` 整份拷贝（`cp -pR`，**6386 个文件 / 394M**）。
拷贝后 `index.html` sha256 前 16 位 = `375f570ab13b1214`，与源目录逐字节一致（实测双算）。
入口 chunk = `index-DCSbMwxd.js`；智能卡运行时体为外部资产
`dist/assets/palink-smart-card-runtime-*.js`（Vite 插件把 `runtime-body/part-*.ts` 外部化）。
备份时点 HEAD = `1a79c0a`（包J 报告），容器 `palink-ai-frontend-1` 宿主端口 **16000**。

## ③ 备份原因
ST 兼容分包批次（包F/G/H/I/L/D/J，共 15 笔提交）**全部只改了 `frontend/src`、从未上线**
（子 agent 一律按红线不碰 dist、不 `npm run build`），本轮由主控合并成**一次**重建：
`VITE_OUT_DIR=dist_new node scripts/build-vite.mjs` → `cp -r dist_new/. dist/` → 清孤儿 → `node scripts/gzip-dist.cjs`。
按既有规范（重建 dist 前整份备份；见 `_INDEX.md` 2026-10-15 / 10-17 三条同类记录）留这份快照的目的是：
**nginx 是 bind mount，`dist` 被删或被改坏 = 站点直接 500/白屏**，回滚只有一条命令
`cp -r <本目录>/dist/. frontend/dist/`（⚠️ **不要先删 dist**，删的瞬间就是故障）。
另需注意：清孤儿步骤会删除旧哈希 chunk ⇒ **用户已打开的页面会白屏**（旧 chunk 消失），F5 即解；
本仓 2026-10-18 已有并行重建造成白屏的先例记录。

## ④ 后续待办清单
1. 重建成功后必须做**三步核验**才算上线：站点 `curl :16000/` = 200、新入口 chunk `curl` = 200、
   新代码指纹在产物里 grep 命中（**只能 grep 字符串字面量**，标识符/路径会被压缩抹掉）。
   本批可用的指纹串：`__palinkStyleGuardAddNode`（包J J-1）、`resource_load_failed`（包I I-2）、
   `getStCompatCommandNames`（包F F-1）、`characterIdString`（包J J-2）、`trust-control` 相关中文按钮文案（包D D-2）。
2. 上线后按各包报告点名的探针回 **16000** 复跑（这是它们唯一未能自证的判据）：
   包F/G/H 的 `probe-parity3.js`、包J 的 styleid 探针（建议把 t6 采样推到 8s）、包D 的 sandbox/contentDocument 三项。
   复跑数字才是能写进基线的数。
3. 站点服务的是**外部用户**（Cloudflare 隧道 + 注册开关仍开着），重建窗口内可能有人正在对话页 ⇒
   若用户报告白屏，先比 `index.html` 哈希与报错堆栈里的 chunk 名，F5 即解。
4. 核验通过并稳定后，本目录降级为隔离/清理候选（走 `_QUARANTINE_<日期>`，**禁直删**；
   注意本目录是**构建产物**，可由源码重建，清理优先级高于源码类备份）。
5. ~~`dist_new` 构建中间目录在本次收尾中已 mv 进 `_QUARANTINE_2026-10-18/`，与本备份同源、可一并评估清理。~~
   ⚠️ **2026-10-19 订正**：主控复核发现 `_QUARANTINE_2026-10-18/dist_new_包M后`（545 文件）与
   `_QUARANTINE_2026-10-19/dist_new_包N后`、`dist_new_包P2后`（各约 392 文件）**都是残缺快照**，
   而完整 `dist` 有 6884 个文件 —— 那三次 `cp -r` 没拷全（当时只核了站点 200 与产物指纹，没核文件数，属我的复核漏项）。
   **⇒ 它们不能当回滚点用**，只能当清理候选；本目录这份 **6386 文件 / 394M、`index.html` sha 校验一致的全量快照
   是唯一可用的回滚基线**（回滚 = `cp -r <本目录>/dist/. frontend/dist/`，勿先删 dist）。
   今后收尾自查加一条：**隔离/归档构建目录后必须 `find -type f | wc -l` 与源目录对比**，不能只看退出码。
