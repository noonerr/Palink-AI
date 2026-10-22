# BACKUP_INFO · 密钥链路不再假成功 上线前 dist 归档

## ① 备份日期

2026-10-22 05:1x（本地时间）

## ② 原始来源

- `D:\项目\Palink-AI\frontend\dist`
- `dist_before.tar.gz`：**267,418,601 B**，改前入口 `assets/index-CHK4yxNm.js`

## ③ 备份原因

外部审计 F-2b 实测：`/api/secrets` 的帧内垫片对**非 GET** 请求一律回 `{result:'ok', ok:true}`，
且不留痕 ⇒ 插件以为密钥存上了、读回来恒空、全程无告警（双层静默失败）。
本批改为：写类请求回**明确失败**（`ok:false` + `palink_stub:true` + 说明文字），GET 保留空值但带
`palink_stub:true`，两种方法都调用 `reportStubApi('fetch:/api/secrets')` 留痕。
⚠️ 按模板串纪律：本段只能老式语法、禁反引号与花括号插值、反斜杠成对（编辑时我自己先犯了
一次"注释里写插值符号"的错，被 `tsc` 的 TS1109 当场抓住，已改）。

## ④ 后续待办清单

1. 上线判据：入口 `assets/index-BF-FlhTz.js`；产物字面量 `密钥存储未接入` 命中 1 个 js；
   `runtime-body-template-literal-guard` + `generated-script-parse-guard` 11 例通过、`tsc` 干净。
2. ⚠️ 行为变化：原本靠"假成功"降级运行的插件，现在会**显式报错**。这是诚实化代价；
   若老板觉得体感变差，可加一个兼容开关回退到"回 ok 但继续留痕"（不建议默认开）。
3. 尚未做：真接密钥存储（需加密落盘 + 按用户隔离 + 不进日志），属独立设计项。
4. 回退：`tar -xzf dist_before.tar.gz -C frontend/` 即生效（仅前端）。
