# HANDOFF — 包N：B 类三个补丁 + 导入时信任提示（C 类）

> 派发对象：子 agent｜优先级：**P1**｜预估：B 三补丁合计 <100 行 + C 约 120 行 + 测试
> 前置：`REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`、MEMORY.md 的「智能卡关键接缝」
> **只做功能代码，不改 `frontend/dist`、不重建后端镜像**（收尾由主脑做）。

---

## 0. 四个补丁一览（按风险递增，建议按此顺序做）

| # | 补丁 | 一句话 | 坐标 |
|---|---|---|---|
| B-2 | `window.context` 全局 | 帧内/沙箱补 ST 的 `context` 快照 | `part-08.ts`、`sandbox.ts:2760` |
| B-3 | `renameChat` 桥 | 帧内 → 父侧 action → 已有后端端点 | `part-08.ts:399`、`SmartCardCompatController.ts` |
| B-1 | SD 出图落库 | 沙箱 `appendMediaToMessage` 空函数改成写 `extra.media` | `sandbox.ts:4723` |
| C-1 | 导入时信任提示 | 导入带脚本的卡时提示，点信任即默认信任（TOFU 指纹绑定） | `CharacterView.tsx:990`、`CharacterCardRenderer.tsx:270` |

---

## 1. B-2：补 `window.context`（最便宜）

### 1.1 事实

ST 1.18 的 `context` 是 **`export const context = getContext()` 的一次性快照**（`st-context.js`），
不是实时对象 ⇒ **快照实现就是忠实实现**，不必强求实时。

### 1.2 做法

- **帧内**（`runtime-body/part-08.ts`，`getContextCompat` 定义之后）：用 getter 挂，比 ST 更实时且无副作用：
  ```js
  try {
    Object.defineProperty(window, 'context', {
      configurable: true,
      get: () => getContextCompat(),
    });
  } catch (e) { /* 静默 */ }
  ```
  ⚠️ 模板字符串约束：禁裸反引号 / `${}` / 注释里裸 `\n`。
- **插件沙箱**（`lib/plugin-system/sandbox.ts:2760` 附近，`var getContext = __sandbox.getContext;` 那一批）：
  ```js
  var context = getContext();
  ```
  与 ST 语义一致（快照）。若担心插件加载早于上下文就绪，可先给 `{}` 并在
  `registerContextSetter` 的刷新回调里重算一次 —— **但不要做成每次访问都重算**（ST 不是）。

### 1.3 验收

- 帧内：`typeof window.context === 'object'` 且 `context.chat` / `context.name1` 可读；
  与 `getContext()` 同源。
- 沙箱：插件作用域内 `context.characterId` 等可读；不得抛错。

---

## 2. B-3：`renameChat` 接桥

### 2.1 事实

- 帧内现在是**诚实失败**：`part-08.ts:399-408`，返回 `false` + 一次性 warn。
- 后端端点是**存在且真改库**的：`backend/app/api/silly_tavern.py:5839`
  `POST /api/chats/rename-session`（`ChatRenameSessionRequest`，走 `get_st_current_user`）。
- 缺的只是**帧内 → 父侧的 requestParent 动作**。

### 2.2 做法

1. `SmartCardCompatController.ts` 的 action 链（`:763+` 那一串 `else if (action.action === '…')`）
   加一个 `renameChat` 分支，**照抄宿主轨现成实现**（`lib/sillytavern/getContext.ts:2465-2495`）：
   ```js
   const body = {
     file_name: 'palink-session-' + chatId,
     new_name: newName,
   };
   if (characterId) body.avatar_url = 'palink-' + characterId + '.png';
   await api.post('/api/chats/rename-session', body);   // CSRF 由 services/api 自动注入
   emitEvent('session:renamed', { sessionId: chatId, newName });
   ```
   ⚠️ **请求契约别写错**（我已核过）：body 是 `{ file_name, new_name, avatar_url? }`，
   **不是** `{ session_id, title }`；会话标识走 `file_name = palink-session-<chatId>` 约定
   （后端 `_session_for_file` 据此解析），成功返回 `{"result":"ok"}`，失败 400/404。
   CSRF 头由 `services/api` 对 mutating 方法自动注入（`api.ts:182-184`），**别自己拼**。
   返回值统一成 `{ success: boolean, error?: string }` 再回给帧内。
2. `part-08.ts:399-408` 的 `renameChatCompat` 改成：
   `const r = await requestParent('renameChat', { title }); return Boolean(r && r.success);`
   失败仍返回 `false`（不许假成功），但去掉"未接通道"的一次性 warn 文案（改成功路径）。
3. ⚠️ `requestParent` v2 会把数组和字符串展开（`SillyTavernCompatRuntime.ts:4659`
   `{ok:true, ...data.result}`）⇒ 这里返回对象，安全；但测试桩必须照抄真机形状。

### 2.3 验收

- 卡脚本 `await renameChat('新名字')` → 返回 `true`，刷新后会话标题仍是新名字。
- 后端失败（如无权限）→ 返回 `false`，不弹假成功。
- 现有"诚实 false"的契约测试同步改（别只删测试）。

---

## 3. B-1：SD 出图落库（沙箱轨 `appendMediaToMessage`）

### 3.1 事实（先读懂现状再动手）

`sandbox.ts:4723-4726` 的空实现**是有理由的**，原注释写着：

> ST 语义是把消息内媒体渲染进**消息 DOM 元素**，Palink 消息渲染是 React 管线且插件拿不到
> 真实消息元素 → 无法正确桥接，强行实现只会让插件误以为渲染成功。

⇒ **不要改成"往 DOM 里插节点"**。正确解法是**换一条等价的落库通道**：

- Palink 的消息图只认 `message.extra.media`（`Message.tsx:1682` + `MessageMedia.tsx`，服务端权威快照）；
- 沙箱已经有**真**的消息写入能力：`sandbox.ts:3692` 的
  `setChatMessages → applyStChatMessages`（`lib/sillytavern/getContext.ts:1676`），
  它会写 `runtime.context.chat` + `messageManager` + 派发 `palink:chatMessagesUpdated` 触发 UI 刷新。

### 3.2 做法（照抄帧内已验收的实现）

帧内已有正确实现可抄：`part-08.ts:338-357`（`appendMediaToMessageCompat`），要点：
1. 解析目标消息（ST 第一参是 `mes` 消息对象，第二参是 DOM 元素）；
2. 只认第二参为媒体来源，第二参缺省才回退看第一参 —— **映射不出来一律 `false`**，
   不许"把消息 id 当 URL 写进 extra.media"（那是假成功）；
3. 媒体项形状按 `lib/messageMedia.ts:18` 的 `MediaItem`
   （`{ id, status, url, width, height, prompt?, seed?, … }`）；
4. 推入 `extra.media`，`media_index` 缺省时指向新增项；
5. 落库：帧内走 `setChatMessage(undefined, id, { extra })`；
   **沙箱轨**走 `applyStChatMessages(nextChatArray)`（整数组替换语义，见 `getContext.ts:1676-1720`）。

### 3.3 验收

- 沙箱里调 `appendMediaToMessage(msg, {url:'/api/uploads/xxx.png'})` → 消息下方出现图；
- **刷新后图还在**（证明真落库，不是只改了内存）；
- 传无法映射的参数 → 返回 `false` 且**不写脏数据**；
- 契约测试：断言空实现已被替换 + 假成功路径不存在。

---

## 4. C-1：导入时信任提示（用户已拍板方向）

### 4.1 关键约束（先说清楚，否则会做出"点了不生效"的东西）

**信任指纹是渲染时算的，导入时拿不到**：

```
CharacterCardRenderer.tsx:270-273
const sourceFingerprint = useMemo(() => hashSmartCardSource(`${html}\n${customCss || ''}`), [html, customCss]);
```

`html` 是**该条消息**的智能卡 HTML，`customCss` 是卡的自定义样式 ⇒ 导入阶段无从计算。
而且现有授权是**会话级 + 30 分钟 TTL**（`shared.ts:56` `SMART_CARD_TRUST_SESSION_TTL_MS`，
`storage.ts:29` 写 sessionStorage 并主动清 localStorage）。

⇒ **不能"导入时直接写 grant"**（指纹对不上，写了也不生效）。用 **TOFU（首次使用即绑定）**：

### 4.2 做法

1. **检测**：`CharacterView.tsx:990 handleImportCharacter` 里，`uploadCharacterCardWithProgress`
   返回 `result` 之后、`openImportedCharacter` **之前**，判断这张卡是否会执行脚本：
   - `result.data.extensions.tavern_helper.scripts` 非空，或
   - `result.data.first_mes` / `alternate_greetings` 含 `<script` / `<html`，或
   - `result.data.extensions.regex_scripts` 的 `replaceString` 含 HTML/script。
   命中才弹提示（纯文本卡不打扰）。
2. **提示**：复用现有确认弹窗样式（与 `CharacterCardRenderer` 的「信任此卡」同款文案口径）：
   > 这张卡会执行自带脚本。信任后，它的内容可以和本页共享同源（插件可读其 DOM）。
   > 你随时可以在卡片的「信任」开关里撤销。
3. **写 optin**：用户点信任 ⇒ 写**新键**（localStorage，持久）：
   ```
   palink:card-trust-optin:v1:<cid>  →  { pending: true, at: <ts> }
   ```
   ⚠️ 新键，别复用 `getSmartCardTrustKey`（那个是 `cid:fingerprint` + sessionStorage + TTL）。
4. **采纳**：`CharacterCardRenderer.tsx:276` 的信任解析改成三级：
   ```
   mode === 'trusted-native'
     || readSmartCardTrustGrant(cid, sourceFingerprint)          // 现有：会话级 TTL
     || readTrustOptIn(cid, sourceFingerprint)                    // 新增：TOFU
   ```
   `readTrustOptIn` 语义：读到 `{pending:true}` ⇒ 把**当前** `sourceFingerprint` 写进去并视为已授信；
   读到 `{fingerprint: X}` ⇒ 仅当 `X === sourceFingerprint` 才授信（**卡内容一改，信任自动失效**）。
5. **撤销**：`trust-control.tsx` / `CharacterCardRenderer` 的撤销动作里，**同时清 optin 键**
   （否则用户撤了又自动授信，是 bug）。
6. **安全口径变更必须写进报告**：这是从"30 分钟会话级"改成"持久 + 指纹绑定"。
   理由与补偿：绑定源码指纹（卡改即失效）+ 可撤销 + 仅对用户显式点过的卡生效。

### 4.3 验收

- 导入**带脚本**的卡 → 弹一次提示；纯文本卡 → 不弹。
- 点信任 → 打开该卡，帧 `sandbox` 属性含 `allow-same-origin`，父侧可读 `contentDocument`。
- **改卡内容**（换一张同 cid 的卡）→ 信任失效，回到 opaque origin。
- 点撤销 → 立即回 opaque origin，且刷新后不再自动授信。
- **未点信任的卡行为零变化**（P1-1 红线）：仍是 `allow-scripts` only、7/7 opaque origin。

---

## 5. 红线（全部适用）

1. **不许假成功**：映射不出来就 `false`，写不进去就 `false`。
2. `runtime-body/part-*.ts` 是**模板字符串**：禁裸反引号、`${}`、注释里裸 `\n`（写 `\\n`）；
   改完必须过 `generated-script-parse-guard.test.ts`。
3. **不动** `sanitizeStCompatCss`、STYLE-GUARD-INFRAME、`getRequestHeaders` 的 `{}` 决策、
   `getPresetManager`（不补）。
4. **未授信卡的 sandbox 属性不许变**（P1-1 安全红线）。
5. 不碰 `frontend/dist`、不跑 `npm run build`、不重建后端镜像；零 API 成本（探针本地 fulfill 不转发）。

---

## 6. 验收总则

```
frontend/: npx tsc --noEmit 与 npx vitest run 全绿 ⇒ 只认 failed=0 且 errors=0（passed 会漂）
真机探针：入口 /characters/<cid>；playwright-cli 的 open+run-code 同一条命令；
          ### Result 在输出顶部，重定向到文件再读
反证：每个补丁取 1 处改坏 ⇒ 测试必红；还原 ⇒ 必绿；两次输出贴报告
```

## 7. 交付物

1. 代码 + 测试，`git commit -o -- <pathspec>` 只提自己的文件；
   消息含代码标识用 `-F <消息文件>`（反引号会被 bash 吃掉），`-F` 在 `-o --` 之前。
2. `docs/_active/report/REPORT_包N_B类补丁与导入信任_2026-10-19.md`：
   - 四个补丁逐条"改前 → 改后 + 证据"
   - SD 出图的端到端证据（出图 → 消息显示 → 刷新仍在）
   - C-1 的**安全口径变更说明**（会话级 TTL → 持久 TOFU + 指纹绑定 + 撤销）
   - 未授信卡 7/7 opaque origin 未变的证据
   - 反证两次输出

---

## 8. 派遣提示词（整段复制粘贴即可）

```
你是 Palink-AI 项目（工作目录 D:\项目\Palink-AI，Git Bash 环境）的执行 agent。
你看不到之前的对话，一切技术规格以交接单为准。

【必读，按顺序】
1. docs/_active/HANDOFF_提示词_包N_B类三补丁与导入信任提示_2026-10-19.md（你的任务书，四个补丁都有精确坐标）
2. .workbuddy-ai/memory/MEMORY.md 的「验证纪律」「智能卡关键接缝」「命令行环境」三节（红线）

【任务】按交接单顺序做四个补丁：
B-2 window.context（帧内 getter + 沙箱快照）
B-3 renameChat 桥（控制器加 action → POST /api/chats/rename-session；帧内改调 requestParent）
B-1 沙箱 appendMediaToMessage（不碰 DOM，改写 message.extra.media + applyStChatMessages 落库，
    形状照 lib/messageMedia.ts:18 的 MediaItem，实现照 part-08.ts:338-357）
C-1 导入时信任提示（TOFU：导入检测到脚本才弹 → 写 palink:card-trust-optin:v1:<cid> 持久键 →
    首次渲染采纳当前 sourceFingerprint；指纹变化即失效；撤销要同时清 optin）

【红线】不许假成功（映射不出来返回 false）；part-*.ts 是模板字符串（禁裸反引号/${}/裸 \n）；
未授信卡的 sandbox 属性不许变（P1-1）；不动 sanitizeStCompatCss / STYLE-GUARD /
getRequestHeaders 的 {} / getPresetManager；不碰 frontend/dist、不 npm run build、不重建后端镜像；
零 API 成本（探针计费端点一律 page.route 本地 fulfill 不转发）。

【验收】tsc + vitest 全绿（只认 failed=0 且 errors=0）；SD 出图端到端（出图→显示→刷新仍在）；
C-1 四种情形（弹/不弹/信任生效/改卡失效/撤销生效）；未授信卡 7/7 opaque origin 未变；
反证：每补丁取 1 处改坏必红、还原必绿，两次输出贴报告。

【交付】docs/_active/report/REPORT_包N_B类补丁与导入信任_2026-10-19.md；
git commit -o -- <pathspec> 只提自己的文件，消息含代码标识用 -F <消息文件>；
最终回复 ≤300 字：四补丁各自结论、C-1 的安全口径变更、反证结果、遗留项。
```

