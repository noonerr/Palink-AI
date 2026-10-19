# 包AA 上线重建前的 dist 快照（2026-10-20）

## ① 备份日期

2026-10-20 01:44 前后。

## ② 原始来源路径

`D:\项目\Palink-AI\frontend\dist` → 本目录 `dist/`（整份拷贝）。
拷贝后逐字节校验一致：**7258 = 7258 文件**，`index.html` sha256 前 16 位
**`920f156edee4c62b`**（源与备份相同），体积 **450M**。
备份时点线上入口 = `index-qPSwXyNe.js`（包W 那一次上线的产物），HEAD = `68ad9eb` 之前的状态。

## ③ 备份原因

包AA 的三件事（斜杠命令别名进表 / `/listvar` 照 ST / `TavernHelper.registerMacroLike` 成员键）
由收尾者 pkg-AA2 补齐测试与记账并入库（`8ac5568` / `fe11053` / `e40aa65`），需重建前端产物才上线。
`dist` 是 docker nginx 的 **bind mount** 目录 ⇒ 中途出错或误删会让站点直接 500，容器内看不到源码，
只能从快照整份拷回。按 `palink-ai-repo-ops` 强制条款"重建 dist 前必须先整份备份"执行。

## ④ 后续待办清单

- [x] 重建走旁路：`VITE_OUT_DIR=dist_aa node scripts/build-vite.mjs`（42.34s）→ 校验新目录 →
      `cp -r dist_aa/. dist/`（**只增不删**）→ `node scripts/gzip-dist.cjs`（3179 个 .gz）；
      新入口 `index-qPSwXyNe.js` → **`index-DRekGjXr.js`**，`dist` 文件数 7258 → 7382。
- [x] 三步核验：站点 `200`；新入口 chunk `200 / 1,930,688 B`；入口引用的帧内 runtime
      `palink-smart-card-runtime-286e2d498064.js` `200 / 499,897 B`（就是新的那一份，不是历史残留）。
- [x] 产物字面量指纹（只认字符串字面量，标识符会被压缩）：`slashKnownAliasesCompat`、
      `__palinkSlashSeedAliasCount`、`scope=local|global|all`、`registerMacroLike: th134Bridge`
      ⇒ **旧 dist 全 0 命中，新 dist 全命中**；线上取回的 runtime chunk 里依次命中 9 / 2 / 1。
- [x] 真机读数（:16000，露缇雅 1.2，只读、零 API 成本，7 个卡片帧逐帧一致）：
      种子主名 **293**、别名 **176**、`Object.keys(commands)` **340 → 509**；
      `commands.listchatvar === commands.listvar` **true**（别名与主名是同一个对象，照 ST）；
      `imp` / `listchatvar` / `togglepanels` / `dupe` 四个别名逐帧在场；
      `TavernHelper` 键数 **121 → 122**、`registerMacroLike` 为 `function`；
      零回归面：`getContext()` **196** 键不变、插件 CSS 每帧 **5/5**、宿主记录器 1 条 / 排行空数组。
- [ ] `frontend/dist_aa`（旁路构建目录）待隔离到 `_BACKUPS/_QUARANTINE_2026-10-20/`；
      本环境对批量删除有进程级守卫，**不要 `rm -rf` 直删**；
      也不要在这一次之前跑 `clean-dist.cjs`（它在 `VITE_OUT_DIR` 未设时会删掉在用的 `./dist`）。
- [ ] 已打开的页面在新哈希 chunk 上线后需 **F5** 才生效（旧页面仍在跑 `index-qPSwXyNe.js`），属已知现象。

## 回滚方式

```bash
cp -r "_BACKUPS/2026-10-20_dist_包AA上线重建前/dist/." frontend/dist/    # 只增不删，不要先 rm dist
```

回滚后 `curl -sI http://localhost:16000/` 确认 200，并核对入口回到 `index-qPSwXyNe.js`。
