# BACKUP_INFO — 卡脚本本地存储按角色与账号隔离 · 施工前备份

## ① 备份日期

2026-10-02

## ② 原始来源路径

原始根目录：`D:\项目\Palink-AI\`
本次只备份「本次施工会动到的那些文件的原始副本」，不整仓拷贝。
存放位置（相对 `D:\项目\Palink-AI\`）：

```
_BACKUPS/2026-10-02_卡脚本本地存储隔离施工前/pre/<下述相对路径>
_BACKUPS/2026-10-02_卡脚本本地存储隔离施工前/_manifest.tsv   # sha256 + 字节数 + 校验结果
```

备份清单（12 个文件，`pre/` 下按仓库原相对路径摆放）：

| # | 原始相对路径 | 关联施工项 |
|---|---|---|
| 1 | `frontend/src/lib/sillytavern/card-script-runner.ts` | **P0 主战场** —— 裸 `<script>` 注入通道，要加 localStorage 命名空间拦截 |
| 2 | `frontend/src/lib/sillytavern/__tests__/card-script-runner.test.ts` | P0 既有用例，会被扩展，改坏要能回滚比对 |
| 3 | `frontend/src/components/ui/custom/smart-card-runtime/storage.ts` | P0 复用其 `SMART_CARD_STORAGE_PREFIX` 桶语义 |
| 4 | `frontend/src/components/views/character/CharacterChat.tsx` | **P1** 名字哈希改 UUID 派生；同时是卡脚本调用点 |
| 5 | `frontend/src/components/st-plugin-ui-host/Live2DPoolPanel.tsx` | **P1** 重复的第二份哈希实现，要收敛 |
| 6 | `backend/app/api/expressions.py` | **P2** `_get_character_by_name_or_404` 无 ORDER BY 的名字查隐患 |
| 7 | `backend/app/core/migrations.py` | **P2** 建表迁移会碰它；红线：禁止回填 `silly_tavern_mode` / `silly_tavern_theme` |
| 8 | `frontend/src/lib/sillytavern/extension-settings-store.ts` | [二手] `__palink_extension_settings` 全局单例（SPEC §2.9） |
| 9 | `frontend/src/lib/plugin-system/storage.ts` | [二手] `palink_plugin_${插件名}` 按插件名分键（SPEC §2.9） |
| 10 | `frontend/src/utils/sillyTavernPluginRuntime.ts` | [二手] `galgame-ui-plugin_char_enabled` 整键删除兜底（SPEC §2.9） |
| 11 | `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | [二手] `window.this_chid = 0`（SPEC §2.9，多处） |
| 12 | `scripts/dialog_render_v7.1.js` | [二手] IndexedDB `BubbleDialogueAvatars` 主键不含 charId（SPEC §2.9） |

**未备份（红线，AGENTS.md 第 6 条）**：`frontend/dist`（容器 nginx 在用产物）、`backend/data`（412MB 业务数据）、
根级 `图片/` `记忆/` `*.mp4`、各 agent 配置目录 —— 本次施工一律不碰。

## ③ 备份原因

对应两份同源文档：

- 施工任务书：`docs/PROMPT_卡脚本本地存储按角色与账号隔离_2026-10-02.md`
- 详规与取证：`docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md`

修复的数据隔离缺陷：角色卡自带脚本写在本机浏览器里的状态（CG 立绘解锁、图鉴面板位置等）
**不带任何角色标识**，导致删卡重导、同名多卡、同浏览器多账号之间互相污染。用户口径原话：
「这玩意跟着卡的 ID 走，卡的 ID 跟着用户走。」

拆出的三个独立缺陷：**D1** 无角色命名空间 / **D2** 角色身份用名字哈希而非 UUID / **D3** 完全不落库。
对应施工批次 **P1（UUID 派生）→ P0（localStorage 命名空间）→ P2（服务端落库 + 删卡清理）→ 迁移**。

本次备份的原因：上述 12 个文件全部处于**被多个并行 agent 共用的工作区在途态**（`git status` 共 81 项脏），
无法依靠 git 单一回滚点；且 P0 的源码改写一旦把某张生产卡的脚本改死，就是「整页内容空白」级别事故
（2026-09-30 已有同类先例，见 `_BACKUPS/2026-09-30_plugininject-注入断点修复前/`）。
故必须在改动第一行之前留下可原地回滚的原始副本。

## ④ 后续待办清单

### 本次会话已完成（动工前的准备）

- [x] 逐条复核 SPEC §2 的一手取证（§2.1–2.8）—— 全部属实
- [x] 逐条复核 SPEC §2.9 的 6 条二手取证 —— 全部属实，并额外发现 1 条更重的问题（见文末「新发现」）
- [x] 12 个待改文件已备份，`_manifest.tsv` sha256 校验 12/12 一致

### 待用户答复后才能动工（对应 SPEC §8 / PROMPT「必须先问用户」）

- [ ] **Q1**：按角色隔离后，重新导入同一张卡会丢失图鉴进度 —— 是否接受？
- [ ] **Q2**：IndexedDB 通道本期是否一起做？（已确认也串，**建议本期合流**，理由见文末）
- [ ] **Q3**：P2 服务端落库是否与 P0 同期上线而非分期？（建议同期）

### 工程待办（拿到答复后按 P1 → P0 → P2 → 迁移顺序执行）

- [ ] **P1**：在 `frontend/src/lib/sillytavern/` 下新增共用函数 `pluginCharacterIdFromUuid(uuid): number`
      —— 确定性、非零、跨会话跨设备稳定；把 `CharacterChat.tsx:1647` 与 `Live2DPoolPanel.tsx:45-48` 两份重复实现收敛为一处
      ⚠️ 后者返回值是 **string**，前者是 **number**，收敛时必须同步调整调用处
- [ ] **P0**：`card-script-runner.ts` 走路线甲（源码改写），覆盖 `localStorage` / `sessionStorage` /
      `window.localStorage` / `topWin.localStorage` / `parent.localStorage`；
      不确定的分支一律**放行原样并打点**，绝不让卡脚本抛错。**不要走路线乙全局劫持。**
- [ ] **P0 前端**：以 `characterUuid`（`selectedCharacter.id`）为命名空间，复用 `SMART_CARD_STORAGE_PREFIX` 语义，
      新增并列常量 `CARD_SCRIPT_STORAGE_PREFIX = 'palink:card-storage:v1:'`
- [ ] **P2 后端**：新表 `character_plugin_storage(character_id, user_id, ns, key, value)`，
      `UNIQUE(character_id, ns, key)`，FK 随删卡级联；端点复用 `get_st_current_user`，越权返回 **404 而非 403**
- [ ] **P2 前端**：写穿同步，本地永远先命中，同步失败**静默降级为纯本地**
- [ ] **P2 顺带**：修 `expressions.py` 的 `_get_character_by_name_or_404`（优先按 id 查；只有 name 时加 `ORDER BY created_at` 并 `logger.warning` 登记）
- [ ] **迁移**：新键读不到时回读一次旧全局键，命中则写入新键并删旧键；同名多卡只迁给该用户最近对话的那张卡（此规则写进 PR 描述）
- [ ] **验收**：后端 pytest **必须进容器跑**（宿主机静默少 9 例），基线 1612 passed / 42 skipped / **0 failed**；
      前端 `npx tsc --noEmit` 通过、`npx vitest run` failed=0（用例数会随并行会话增长，只认 failed=0）

---

## 附一：本次复核发现的新事实（SPEC 未记录，动工时要用）

复核 `scripts/dialog_render_v7.1.js:1354-1385` 时发现，IndexedDB 这条通道的问题**比 SPEC §2.9 描述的更重**：

```js
async addCgGroup(group, albumUrl, charId) {
  const id = 'cg_group__' + group;          // ← 主键里没有 charId
  const record = { id, group, albumUrl, charId: String(charId || GLOBAL_CHAR_ID), count: 0, imageUrls: [], ... };
  return this._put(STORE_CG_GROUPS, record); // ← put = 已存在则整条覆盖
}
// listCgGroups：getAll() 之后 filter(g => g.charId === safeCharId)
```
```js
async updateCgGroup(group, updates) {            // ← 参数里根本没有 charId
  const existing = await this.getCgGroup(group); // ← 按组名查，跨角色命中
  const record = { ...existing, ...updates, updatedAt: Date.now() };
  return this._put(STORE_CG_GROUPS, record);
}
```

SPEC 只写「主键不含角色」，据此得出的结论是「读污染」。实际还多两条：

1. **写覆盖 = 数据丢失**：角色 A、B 各有一个同名 CG 分组（例如都叫「默认」），后者的 `put` 会把前者的记录
   **整条覆盖**，记录里的 `charId` 翻到 B，`listCgGroups` 按 charId 过滤后 **A 再也看不到自己那个分组**。
2. **跨角色改写**：`updateCgGroup` 不认 charId 只认组名，A 去改会把 B 的记录改掉。

结论：IDB 这条不是「要不要顺便做」的锦上添花，它**正在丢数据**。
建议 Q2 答「本期合流」，至少先把 `cg_group__` 主键加上 charId 维度（`(charId, group)`），
`updateCgGroup` 补 charId 参数并加归属校验。**此条需向用户回报。**

## 附二：动工时的两个易错点

1. `Live2DPoolPanel.tsx:45-48` 的 `pluginCharacterId` 返回 **string**，而 `CharacterChat.tsx:1647` 返回 **number**。
   P1「收敛为一个共用函数」时不能只统一返回值类型，必须同步改调用处，否则 Live2D 面板的 `modelId` 会静默变成另一种字符串格式。
2. `CharacterChat.tsx` 里卡脚本 effect 的依赖数组目前是 `[selectedCharacter?.id, compatCharacterExtensions]`，
   `selectedCharacter.id` 就是真 UUID，P0 可直接在作用域内取用，不必另加数据源。

---

## 恢复方法

单个文件回滚（示例）：

```bash
cp "_BACKUPS/2026-10-02_卡脚本本地存储隔离施工前/pre/<相对路径>" "<相对路径>"
```

全量回滚（`pre/` 下所有文件，用 manifest 里的相对路径）：

```bash
cd "D:\项目\Palink-AI"
tail -n +2 "_BACKUPS/2026-10-02_卡脚本本地存储隔离施工前/_manifest.tsv" | cut -f1 | while read -r rel; do
  cp "_BACKUPS/2026-10-02_卡脚本本地存储隔离施工前/pre/$rel" "$rel"
done
```

用 manifest 校验当前文件是否已被改动：

```bash
cd "D:\项目\Palink-AI"
tail -n +2 "_BACKUPS/2026-10-02_卡脚本本地存储隔离施工前/_manifest.tsv" | awk -F'\t' '{print $3"  "$1}' | sha256sum -c -
```
