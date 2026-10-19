# 包W 上线重建前的 dist 快照（2026-10-19）

## ① 备份日期

2026-10-19 18:41 前后。

## ② 原始来源路径

`D:\项目\Palink-AI\frontend\dist` → 本目录 `dist/`（整份拷贝）。

拷贝后逐字节校验一致：文件数 **7134 = 7134**，`index.html` sha256 前 16 位
**`c00a65aae0daece8`**（源与备份相同），体积 **442M**。
备份时点线上入口 = `index-DJ-JpT4g.js`，HEAD = `4155eaa`（不含包W 的任何改动）。

## ③ 备份原因

包W（静默失败统一记录器 + 缺口排行）交付后要上线，必须重建 `frontend/dist`。
`dist` 是 docker nginx 的 **bind mount** 目录 ⇒ 一旦中途出错或被误删，站点直接 500，
且容器内看不到源码，只能从快照整份拷回。按 `palink-ai-repo-ops` 的强制条款"重建 dist 前必须先整份备份"执行。

本次上线内容（全部在 `frontend/src`，一笔都没进过产物）：

| 提交 | 内容 |
|---|---|
| `9956117` | 记录器本体 `palink-diag.ts` + `main.tsx` 挂全局入口与主文档 rejection/error 轨 |
| `b238464` | 静默点接入：slash 未实现 / TavernHelper 未实现键 / 23 处被吞 catch / rejection / 卡脚本注入失败 / 变量块残留 / `window.context` 形状缺口 |
| `55de6e3` | 中断现场收尾：栈位置行解析 + 语法类错误按包V 裁决归 `card_authored` + 守卫测试修到能跑（28 例） |
| `4155eaa` | 缺口标记机制：`missingStSubsystem` 字段 + `stGapRanking` 排行 + 双向守门测试（16 例） |

## ④ 后续待办清单

- [x] 重建走旁路：`VITE_OUT_DIR=dist_w node scripts/build-vite.mjs` → 校验新目录 →
      `cp -r dist_w/. dist/`（**只增不删**，绝不清空 dist，避免 bind mount 失效）→ `node scripts/gzip-dist.cjs`。
- [x] 三步核验：站点 200 / 新入口 200 / 产物里 grep **字符串字面量**指纹
      （标识符会被压缩抹掉，只有字面量可信）：`palink-diag/v1`、`palinkDiag:`、
      `tavernhelper_key_unimplemented`、`missingStSubsystem`、`stGapRanking`。
      ⚠️ 判据必须同时看"旧 dist 里 0 命中、新 dist 里 >0"，否则分不清是不是本来就有。
- [x] 真机读数（:16000 露缇雅 1.2 会话页，只读不生成）：`enabled=true`、`iframes=7`、
      自然记录 1 条 `frame_compat/global_shape_absent/window.context`（`origin=frame`、count=7 跨帧合并），
      父侧写一条 `TavernHelper.deleteLorebook` ⇒ 归到 `wb_delete` events=1。详见包W 报告 §5。
- [ ] `frontend/dist_w` 用完后隔离到 `_BACKUPS/_QUARANTINE_2026-10-19/`（本环境对批量删除有进程级守卫，
      不要 `rm -rf` 直删；也不要跑 `clean-dist.cjs` —— 它在 `VITE_OUT_DIR` 未设时会删掉在用的 `./dist`）。
- [ ] 已打开的页面在清孤儿/覆盖后可能白屏（旧哈希 chunk 不在），**F5 即解**，属已知现象，不是本批回归。

## 回滚方式

```bash
cp -r "_BACKUPS/2026-10-19_dist_包W上线重建前/dist/." frontend/dist/    # 只增不删，不要先 rm dist
```

回滚后需再 `curl -sI http://localhost:16000/` 确认 200，并核对 `index.html` 里入口仍是 `index-DJ-JpT4g.js`。
