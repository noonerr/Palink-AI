# BACKUP_INFO — 甲：IndexedDB 按角色分库 · 施工前备份

## ① 备份日期

2026-10-02

## ② 原始来源路径

原始根目录：`D:\项目\Palink-AI\`
只备份本次甲批次会动到的文件，**不整仓拷贝**。
存放位置（相对 `D:\项目\Palink-AI\`）：

```
_BACKUPS/2026-10-02_甲-IDB按角色分库施工前/pre/<下述相对路径>
_BACKUPS/2026-10-02_甲-IDB按角色分库施工前/_manifest.tsv   # sha256 + 字节数 + 校验结果
```

| # | 原始相对路径 | 关联施工项 |
|---|---|---|
| 1 | `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | **甲的主战场**。存储 shim 装在 525-526 行（`Object.defineProperty(window,'localStorage',…)`），甲的 IDB 分库与子帧传播都接在它旁边 |
| 2 | `frontend/src/components/st-plugin-ui-host/Live2DPoolPanel.tsx` | 甲的白名单决策直接受它约束：它写的是**不带后缀**的 `GalgameUIPluginDB`，一刀切分库会打断 Live2D 绑定 |

**未备份（红线，AGENTS.md 第 6 条）**：`frontend/dist`（容器 nginx bind mount 在用产物）、`backend/data`、根级 `图片/` `记忆/` `*.mp4`、各 agent 配置目录 —— 本次一律不碰。

## ③ 备份原因

对应 `docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md §8.1`（Q2 项），用户 2026-10-02 拍板走 **甲 —— IDB 按角色分库**，不采纳乙。

原始缺陷：气泡插件（BubbleDialogue v7.1）的 IndexedDB `BubbleDialogueAvatars` 库里，
`cg_groups` 的主键是 `'cg_group__' + group`，**不含角色标识**。两张卡若用了同名 CG 分组，
后写的会 `_put` 整条覆盖前者，且 `listCgGroups` 按 `charId` 过滤后前者永久不可见 —— 是**数据丢失**，不只是串读。

本次备份的原因：改动落在**所有智能卡共用的 iframe 运行时**（不是单张卡），爆半径比上一批 P0 大一个数量级；
且工作区仍是多 agent 合住、81 项脏、无法靠 git 单一回滚点，必须先留可原地回滚的副本。

## ④ 后续待办清单

### 施工前已完成的摸底（结论进本文档附录）

- [x] 确认 shim 装在 iframe realm，嵌套 srcdoc 子帧**不继承**
- [x] 确认全仓**无任何** shim 传播机制（`frame-shim/` 只有 `frame-measure.ts`，仅量高度）
- [x] 确认必须走**白名单定向分库**而非全局分库（见附录第 2 条）

### 施工项（按序）—— 2026-10-02 全部完成

- [x] **甲-3**：在 `SillyTavernCompatRuntime.ts` 存储 shim 旁加 IDB 分库：
      - 白名单 `CARD_SCOPED_IDB_DBS = ['BubbleDialogueAvatars']`，加后缀 `__<characterId>`
      - 拦截 `indexedDB.open` / `deleteDatabase`，`cmp` 原样转发
      - **子帧传播**：拦截 `HTMLIFrameElement.prototype.srcdoc` 与 `setAttribute('srcdoc')` 两条路径，
        在 srcdoc 前插入自举脚本，让 dcRoot 那个 realm 也拿到分库 shim
      - 全流程 try/catch 兜底，异常一律静默，不影响卡片渲染
      - 额外加了**止血开关**（主框架 `localStorage.palink_idb_namespace = '0'` + 刷新即整体关闭，
        不需要重新构建）—— 因为改的是所有智能卡共用的运行时，出事不该还要 rebuild 才能关
- [x] **甲-4**：vitest 用例 24 例，覆盖：白名单内外的取舍 / 后缀安全化 / 子帧自举脚本行为 /
      srcdoc 两条写入路径 / 安装幂等（不套娃）/ 止血开关；并把 `IDB_NS_RUNTIME_SOURCE` 丢进 `node:vm`
      真跑一遍，断言 vm 内实现与 TS 实现语义一致（防两边漂移）
- [x] **验收**：`npx tsc --noEmit` 0 错；`npx vitest run` = **45 文件 / 607 passed / 3 skipped / 0 failed**；
      后端容器内 pytest = **1621 passed / 42 skipped / 0 failed**（甲是纯前端，后端仅回归）

### 已知代价（选甲时已认）

- 每张卡会重建自己的头像/CG 缓存 → 存储空间与流量上升
- `_global_` 共享头像表退化为「按卡共享」
- 本次**不做**旧库数据迁移（复制 IDB 需读全表重写，且受版本/schema 影响，风险大于收益），
  旧 `BubbleDialogueAvatars` 数据对该卡视为不存在

### 未做（需要用户在岗）

- [ ] `frontend/dist` 未重构建（会同时带上他人未 review 的移动端 UI 批次，用户已决定等）

---

## 附录：摸底三条结论

**1. shim 不传播。** 存储 shim 用 `Object.defineProperty(window,'localStorage',{...})` 装在 iframe 那个 realm
（`SillyTavernCompatRuntime.ts:525-526`）。嵌套的 srcdoc 子帧拿到的是浏览器给的全新 realm，
**不继承**任何父帧属性 —— 这正是用户侧已记录的「dcRoot shim 未传播」问题。

**2. 不能全局分库。** `GalgameUIPluginDB` 这个库名是**两边共用**的：
`Live2DPoolPanel.tsx`（父帧、`indexedDB.open('GalgameUIPluginDB')`、不带后缀）与帧内 galgame 插件。
若一刀切给所有库加后缀，帧内插件会去读 `GalgameUIPluginDB__<id>`，而面板写的是不带后缀的那个
→ **Live2D 绑定直接失效**。故甲只能是白名单定向分库。

**3. dcRoot 的宿主是卡运行时。** `Message.tsx:935-937` 记载「卡运行时若没产出 dcRoot 宿主」，
说明它是帧内卡脚本创建的，因此**在帧内拦截 iframe 创建能覆盖到它**。

## 恢复方法

```bash
cd "D:\项目\Palink-AI"
tail -n +2 "_BACKUPS/2026-10-02_甲-IDB按角色分库施工前/_manifest.tsv" | cut -f1 | while read -r rel; do
  cp "_BACKUPS/2026-10-02_甲-IDB按角色分库施工前/pre/$rel" "$rel"
done
```

校验当前文件是否已被改动：

```bash
cd "D:\项目\Palink-AI"
tail -n +2 "_BACKUPS/2026-10-02_甲-IDB按角色分库施工前/_manifest.tsv" | awk -F'\t' '{print $3"  "$1}' | sha256sum -c -
```
