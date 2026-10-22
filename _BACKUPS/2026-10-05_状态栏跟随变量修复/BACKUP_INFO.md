# BACKUP_INFO — 2026-10-05_状态栏跟随变量修复

## ① 备份日期

**2026-10-05 02:51**（动工**前**，时序合规）。

## ② 原始来源路径

| # | 原路径 | 用途 |
|---|---|---|
| 1 | `frontend/src/components/ui/custom/Message.tsx` | 卡片 iframe 上下文的变量取值优先级（本次修复点） |

`pre/` 按原相对路径存放，`_manifest.tsv` 记 sha256 1 行：
`c9ed8e6d198cad50df80ca633c67957da38f5bab05d1140b3de50c2d0a1323f3`

**新增文件（无备份必要，回滚时删除即可）**：
- `frontend/src/components/ui/custom/cardVariables.ts`（取值优先级纯函数）
- `frontend/src/components/ui/custom/__tests__/card-variables-live-preference.test.ts`（6 例）

## ③ 备份原因

用户真机实测报障：**卡片自带的状态栏不跟随变量更新**（所有楼层都是），而 ST 里正常。
用户明确要求「改成和 ST 那样」。

### 根因（代码级确证，非推测）

该卡的「状态栏」regex 把 `<StatusPlaceHolderImpl/>` 换成一份 28KB 的 HTML，其脚本为：

```js
await waitGlobalInitialized('Mvu');
populateLutiyaData();                              // 首帧画一次
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {  // 变量更新后重画
  populateLutiyaData();
});
```

**事件能不能来，取决于父窗口有没有把新变量推进 iframe**，而这条链断在第一跳：

| 环 | 状态 |
|---|---|
| 卡片 HTML 被识别（`Message.tsx:355`） | ✅ |
| 走 iframe 沙箱、不过 DOMPurify（`:1608`） | ✅ |
| `type="module"` 被降级成普通脚本（`script-norm.ts:15-23`） | ✅ |
| 依赖全局 `Mvu`/`eventOn`/`waitGlobalInitialized`/`_`/`$`/`toastr` 均供上 | ✅ |
| **父窗口把新变量推进 iframe** | ❌ **断点** |

断点细节：`Message.tsx` 构造卡片 context 时写的是

```ts
variables: (message.extra?.variables) ?? _sessionVariables ?? { stat_data: {} }
```

**该楼冻结快照优先**。变量更新后 `message.extra.variables` 不变
→ `liveContext` 不变 → `postContextToFrame`（`CharacterCardRenderer.tsx:493-515`，**按签名去重**）判定
「没变化」**不发** `context-update` → iframe 内 `deepMergeVariablesCompat`（`SillyTavernCompatRuntime.ts:4488-4493`）
不跑 → `VARIABLE_UPDATE_ENDED` 不 emit → 卡片的 `eventOn` 回调永不执行 → **面板停在首帧**。

**为什么所有楼层都不对**：iframe 启动时的 context 刻意轻量（`SillyTavernCompatRuntime.ts:4503-4506` 注释），
卡片 `init()` 只跑一次，首帧读到的变量是空的/默认的，之后再无更新。

**旁证**：`frontend/src/hooks/useCharacterChat.ts:474-476` 的注释自己写着
「否则旧消息 iframe（面板常驻处）只能靠 isGenerating 翻转后的异步 refetch 兜底，
面板拿到的是旧 stat_data —— **"变量进不了面板"的前端侧根因之一**」。
即此前**已发现**该问题并加了 `palink:mvuVariablesUpdated` 事件去更新 `sessionVariables`，
**但没修 context 的取值优先级** → 事件更新了 React 状态，却没让 context 签名变化 → 推送仍不发生。
**本次修复正是补上这最后一跳。**

### 语义依据

ST 语义下 MVU 变量存在 **chat 级单一 store**，每楼状态栏读同一份实时值，变量一变全部刷新。
「按楼冻结快照」是 Palink 为**提示词装配 / 分支回退**加的，属另一条消费链，不该喂给卡片渲染。
**状态栏是「当前状态」显示，不是「那一楼的历史状态」。**

## ④ 后续待办清单

1. **门禁**：`npx tsc --noEmit`（exit 0）+ `npx vitest run`（failed = 0）。
   **反证已做**：把 `cardVariables.ts` 的两段优先级对调 → 3 例变红（含 2 条核心断言），恢复即绿。
2. **重建 dist 并真机验证**（本次修复是纯前端运行时行为，单测覆盖有限，**真机验证是关键**）：
   - ⚠️ **禁止直接 `npm run build`**（首步 `clean-dist` 会被 safe-delete 守卫中断、损坏 dist，站点白屏）。
     必须：`VITE_OUT_DIR=dist_new_xxx node scripts/build-vite.mjs` → `cp -r` 增量合并 → `node scripts/gzip-dist.cjs`。
   - 验证点：① 状态栏首帧就显示真实日期/时间（不是默认值）；② 触发一次变量更新后**状态栏数字跟着变**；
     ③ 其他卡的状态栏未回归。
3. **未提交** —— 逐项 `git add -- <path>`（禁 `-A` / `.`）。
4. **本次未覆盖**：该卡脚本还依赖 `露缇雅.状态.爱意/魔力值/饥饿度`（对象），
   但模型实际把 `露缇雅.状态` 写成了**字符串** → 那三条进度条即使事件触发也只能显示卡里硬编码的默认值。
   **属「模型没按卡片声明的结构写」，是另一个问题（卡片/提示词侧），不在本次修复范围。**
