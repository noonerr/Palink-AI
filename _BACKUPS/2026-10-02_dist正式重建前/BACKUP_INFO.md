# BACKUP_INFO — dist 正式重建前 · 在用产物回滚点

## ① 备份日期

2026-10-02

## ② 原始来源路径

原始：`D:\项目\Palink-AI\frontend\dist\`（容器 nginx bind mount 的**在用**前端产物）
备份到：`D:\项目\Palink-AI\_BACKUPS\2026-10-02_dist正式重建前\dist\`

整目录全量拷贝（`cp -a`），**非只备份改动文件** —— 因为这份产物的用途是"线上坏了立刻退回去"，
部分备份退不回去。

拷贝后校验：

| 项 | 备份 | 原目录 |
|---|---|---|
| 文件数 | 1892 | 1892 |
| 体积 | 111M | 111M |
| `index.html` 入口 chunk | `assets/index-1P0pz-de.js` | `assets/index-1P0pz-de.js` |

## ③ 备份原因

「卡脚本本地存储按角色与账号隔离」批次（P0 localStorage 命名空间 + P1 UUID 派生身份 +
P2 服务端落库 + Q2 甲：IndexedDB 按角色分库）的代码已全部落进源码并通过门禁，
但**前端产物 `dist` 一直没重建**，所以这些改动在页面上是零生效。

本次要执行 `npm run build` 正式上线。该命令的第一步是 `scripts/clean-dist.cjs`
**先清空 `./dist` 再构建**，中间存在一个 dist 为空的窗口；且 `frontend/dist` 被
`.gitignore` 排除（`git ls-files frontend/dist` = 0 条），**git 不是回滚路径**。
因此按 AGENTS.md 规范先落一个物理回滚点。

对应 SPEC：`docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md`
对应 PROMPT：`docs/PROMPT_卡脚本本地存储按角色与账号隔离_2026-10-02.md`

### 重建前已做的零风险预验

先以 `VITE_OUT_DIR=dist_audit` 构建到临时目录（该环境变量会让 clean-dist **跳过** `./dist`），
确认两件事后才动线上产物：

1. 构建成功（44.46s，787 个 .gz 副本正常生成）。
2. 产物里确有本批次标记：
   - `palink:card-storage:v1` → 命中 1 个文件
   - `palink_idb_namespace` → 命中 2 个文件
   - `palink:card-storage:legacy-claim:v1` → 命中 1 个文件

## ④ 后续待办清单

1. **本次重建会把三批在途代码一起上线**（构建自同一工作树，无法只挑一批）：
   - 卡脚本存储隔离批次（P0/P1/P2/甲）— 已验，0 failed
   - 移动端批次（`App.tsx`、`Sidebar.tsx`、`CharacterList.tsx`、`useVirtualKeyboard.ts`、
     删除 `viewportDebug.ts`）— **由并行 agent 完成，其功能是否"做完"只有该 agent 与用户知道**，
     我只能证明它不破坏构建与测试
   - `CharacterCardRenderer.tsx` 的扩展提示词持久化 / 显示标签白名单 / bubble 单层降级批次
2. **重建后需人工验收**（构建与测试证明不了功能正确）：
   - 卡 A 解锁 CG → 删卡 → 导新卡 B → B 图鉴应为**空**
     （注意：本期**不做旧 IDB 数据迁移**，所以各卡头像/CG 缓存会重建一遍，这是选甲时认过的代价）
   - 同名不同 id 的多张卡互不污染
   - 露缇雅卡的 CG 悬浮按钮、图鉴面板拖动位置、状态栏、MVU 面板仍正常
   - 含全屏 launcher 的智能卡不白屏
   - Live2D 绑定不失效（甲的白名单**故意不含** `GalgameUIPluginDB`，就是为了保它）
3. **止血开关**：若线上异常，在主框架执行 `localStorage.palink_idb_namespace='0'` 后刷新，
   即整体关闭按角色分库，**不需要重新构建**。
4. **回滚命令**（仅在线上确认不可用时执行）：
   ```
   rm -rf frontend/dist/* && cp -a "_BACKUPS/2026-10-02_dist正式重建前/dist/." frontend/dist/
   ```
   ⚠️ 用 `rm -rf dist/*` + 回填，**不要 `mv`/`rmdir` dist 本身** —— docker bind mount 指向
   该目录，换目录会让挂载失效（`clean-dist.cjs` 注释里记过一次这个事故：nginx 500）。
5. 临时审计目录 `frontend/dist_audit/` 属本次构建产物，验证完即可删，不必长期保留。
6. 后端**不需要**随本次重建重启：已在 2026-10-02 03:53 重启过，
   新路由 `/api/characters/{id}/plugin-storage` 实测返回 401（要鉴权）而非 404，即已注册生效。
