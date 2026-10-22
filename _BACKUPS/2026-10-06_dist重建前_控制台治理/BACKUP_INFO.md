# BACKUP_INFO

## ① 备份日期
2026-10-06（04:2x 本地时间，GMT+8）

## ② 原始来源路径
`D:\项目\Palink-AI\frontend\dist\`

（该目录是 docker nginx 的 **bind mount 在用产物**，不是构建缓存。
 备份动作 = 整目录 `cp -r`，未改名、未改动内部任何文件。）

## ③ 备份原因
本批要把「F12 控制台噪音治理 + 卡崩溃可见性守卫」上线，需重建 dist。
按项目规范，重建前必须先整份留存当前在用产物，以便：
- 上线后出现异常可**逐字节回滚**（直接 `cp -r` 回去即可，无需重新构建）；
- 事后可比对「改动前后哪些分块变了」，确认新代码确实进了产物。

备份时的在用入口：`index.html` → `index-CRLrDW-J.js`（该分块是 2026-10-06 02:58 构建的
「沙箱权限四项 + 同名书修复」那一批）。

## ④ 后续待办清单
1. 重建 dist 后**必须**核对：`index.html` 引用的入口 hash 已变化；从站点抓回新入口，
   确认 `allow-modals` 仍在（上一批的修复不能被覆盖掉）。
2. 确认新产物的 `palink-smart-card-runtime-<hash>.js` 分块包含本批新增字面量：
   `__palinkConsoleGovernor`、`card_bootstrap_incomplete`、
   `card_settings_entry_unresponsive`、`palink-card-crash-notice`。
   （该分块是独立 emit 的资产，hash 会随源码变化——**必须确认新 hash 文件已产出**。）
3. 真机验收（用户侧）：
   - F12 里卡脚本的重复日志应显著变少（同一条只留首次 + 每 20 次一条折叠提示）；
   - 若那张卡的设置按钮仍点不动，**这次会看到明确提示**
     （浮层「卡片初始化失败…」+ console 搜「卡内错误」），不再是静默无反应。
4. 若上线后发现异常：`cp -r _BACKUPS/2026-10-06_dist重建前_控制台治理/dist frontend/dist`
   即可回到本备份状态（注意先清掉新产物，避免新旧分块混杂）。

## 备注
- 本轮**未做**的、登记备查的两项（详见 `.workbuddy-ai/memory/2026-10-06.md`）：
  ① `ChatViewDesktop.tsx:177` / `ChatViewMobile.tsx:520,644` 的内联 `contentVisibility: 'auto'`
     是 `content-visibility` 警告（37 行）的来源，属**别的会话的文件**，本轮未动；
  ② `legacy-st-sim.ts:157` parent 别名代理白名单漏项（`setTimeout`/`PIXI`/`ResizeObserver` 等），
     属 **legacy 轨**，跨轨影响面需单独评估，本轮未动。
