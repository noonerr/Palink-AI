# 查验报告：卡片改聊天记录「保存成功、刷新即丢」——setChatMessages 落库链路取证

> 状态：已完工待审读（只读查验·2026-10-26）

## 背景

卡片/插件在 iframe 里调 `setChatMessages`（典型：美化卡把格式化后的内容写回楼层），宿主侧返回成功，刷新页面后修改丢失。`docs/OPEN_ISSUES.md` [P2-9] 第 3 项与 [P2-10] 记载：现桥 `recordStubHitOnce` 只「留痕」不落库，落库缺口仍在；旧大堂轨当年是 `POST /api/chats/save`。

本报告为只读查验（任务 T1），未修改任何代码。

## 方法

- 通读 `frontend/src/lib/sillytavern/getContext.ts`（3741 行，重点 1749-1846 共享写入实现、2660-2720 getContext 入口段）；
- `grep -n "setChatMessages" -r frontend/src`（22 处命中，逐一定性）；
- 读 `frontend/src/services/message-manager.ts` 全文（225 行）；
- 读 `backend/app/api/silly_tavern.py` 的 chats 路由段（grep `/api/chats` 命中后精读 `st_save_chat` 3011-3169）与请求模型 80-115；
- 读 `backend/app/api/character_ext.py` 消息级端点（PUT 3446-3560、PATCH 3574-3605、`_sync_message_content_to_active_swipe` 472-505）；
- 读 `frontend/src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts`（160-200 类型、2130-2175 执行段）、`runtime-body/part-07.ts`（560-700 th134SetChatMessages）、`frontend/src/components/views/character/CharacterChat.tsx`（900-1090 applySmartCardMessageUpdate、447 解构）、`frontend/src/hooks/useCharacterChat.ts`（145-165、1667-1760 handleEditMessage）、`frontend/src/components/views/CharacterView.tsx`（1681-1715 事件监听）；
- 读 `docs/OPEN_ISSUES.md` 439-475（[P2-9]/[P2-10] 原文核对）；
- 实跑行为测试：`cd frontend && npx vitest run src/lib/sillytavern/__tests__/sandbox-dep-decouple.test.ts src/components/ui/custom/smart-card-runtime/__tests__/h-tavernhelper-134-contract.test.ts` → **2 passed (2 files) / 87 passed (87 tests)**，且 stderr 实际打出降级桩文案：`降级桩被调用: setChatMessages:persist (仅写内存态（runtime.context.chat + messageManager），未经 /api/chats/save 落库，重载后丢失…)`。

## 发现

### 1. getContext 轨 setChatMessages 现实现：只写内存、无任何网络请求、「成功」是前端自返回值

调用链：`getContext().setChatMessages`（`frontend/src/lib/sillytavern/getContext.ts:2697-2698`）→ `applyStChatMessages(messages, { runtime })`。

`applyStChatMessages`（`getContext.ts:1765-1846`）逐段：

- **入参两形态**：完整消息数组 → 整体替换；`[{message_id, swipes, swipe_id}]` → 按楼层只改 swipes（`:1779-1803`）。基础数组取 `runtime.context.chat`，为空时回退 `messageManager.messages.map(toStMessage)`（`:1773-1777`）。
- **① 写内存层一**：`runtime.context.chat = next`（`:1806-1808`）——全局 ST runtime 的内存副本。
- **② 写内存层二**：对齐写 `messageManager`（`:1814-1827`，update/add/delete 组合）。但 `messageManager` 是**纯内存 stub**：文件头自述「stub 实现」（`frontend/src/services/message-manager.ts:1-7`），`addMessage/deleteMessage/updateMessage` 三个方法体均无任何 api 调用（`:62-90`）；全仓 grep 也没有任何订阅者把它的变更同步到后端（`messageManager.onMessage` 非测试代码 0 命中；喂食方仅 `getContext.ts:1821`/`:2022` 两处自身写入）。
- **③ 通知 UI**：派发 `palink:chatMessagesUpdated`（`:1830-1832`）→ `CharacterView.tsx:1702-1706` 监听该事件后执行 `loadMessages(selectedSession.id)` ——**从服务端重拉**。即内存写的 UI 效果随后会被服务端旧数据覆盖（`frontend/src/lib/plugin-system/sandbox.ts:4865` 注释明确记载这一行为：「不用 applyStChatMessages：它只写内存态，且会派发 palink:chatMessagesUpdated 让 CharacterView 从服务端重载 ⇒ 图会立刻消失」）。
- **④ 留痕不落库**：`recordStubHitOnce('setChatMessages:persist', '仅写内存态…未经 /api/chats/save 落库，重载后丢失…')`（`:1837-1840`）；`recordStubHitOnce` 是会话级去重登记，仅写 `window.__palinkCompatStats`，不做任何持久化（`frontend/src/lib/plugin-system/compat-stub-registry.ts:77-82`）。
- **⑤ 返回 true**（`:1841`）——**前端假成功**：全程没有发出任何 HTTP 请求，「保存成功」是函数自己的布尔返回值，不是后端写确认。

结论：getContext 轨（沙箱插件 `getContext().setChatMessages`）的写入止步于两份内存副本，刷新即丢是必然；「成功」是前端自返回值。

### 2. 后端 /api/chats/save：**存在**，缺口不在后端

`backend/app/api/silly_tavern.py:3011`：`@router.post("/api/chats/save")` → `async def st_save_chat(...)`，返回 `{"ok": True}`（`:3167-3169`）。实现要点：

- 会话/分支定位：`_ensure_session`（消费 `X-Palink-Session-Id` 头，`:3016`）+ `_branch_for_context(ensure=True)`（`:3018`）；
- 入参 `ChatSaveRequest`（`:100-113`）= `{avatar_url?, avatar?, ch_name?, file_name?, file?, chatfile?, chat: Any, force?}`，`chat` 同时接受真实数组与 ST 的 JSON 字符串（`:3025-3031`）；
- chat_metadata 条目持久化 + **[MVU-SAVE-GATE]**：payload 没带 metadata 条目就不碰 metadata（防插件热路径抹掉 stat_data，`:3090-3106`）；
- **全删重插**：`db.query(CharacterChatMessage).filter(session_id, branch_id).delete()` 后逐条 `db.add`（`:3128-3161`）；
- **swipes 原样保存，不强制 swipes[swipe_id]=content**（`:3147-3150` 注释，明确为保住 Galgame 的 COT 双版本机制）；
- 提交后广播 WebSocket、触发 ST DATA_ROOT 后台同步。

同文件其余 chats 路由（grep 实测）：`/api/chats/get` :2979、`/delete` :3171、`/import` :3975、`/export` :4179、`/rename-session` :5974、`/messages` :6142 等。

**所以「后端没有落库端点」不成立**——端点在产、语义完整（[P2-9] 第 3 项 `docs/OPEN_ISSUES.md:451` 也写明「原桥会 POST /api/chats/save」）。缺口只在 getContext 轨前端不调它。

### 3. 智能卡 iframe 轨与宿主 controller：改「正文」真落库，改 swipes/name/extra/is_hidden 只镜像

**帧内（iframe 卡内 TavernHelper 1.34 兼容轨）** `th134SetChatMessages`（`frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-07.ts:646-666`）：

- `item.message`（正文）→ 调帧内 `setChatMessage(content, index, {})`（`:657`，**options 为空对象**）→ 经 requestParent 发到宿主 → 走真写路径（`:646-648` 注释自述）；
- `name/role/is_hidden/extra/data/swipe_id/swipes/swipes_data/swipes_info` → **只更新帧内镜像 `compatChat`**（`:659-663`），并显式 warn「父侧无 name/extra/variables 写通道」（`:661-665`）——不假装写成功，但也确实不落库，刷新即丢。

**宿主 controller** `SmartCardCompatController.ts`：

- action 分发：正则 `(?:set|update|edit|replace)(?:chat)?message` / `updateMessageBlock` 命中后调 `context.setChatMessage({content, messageId, index, options})`（`frontend/src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts:2149-2160`，另一处入口 `:2513-2519`）；
- `context.setChatMessage` 由宿主页注入：`CharacterChat.tsx:1088` → `setChatMessage: applySmartCardMessageUpdate`。

**宿主真写路径** `applySmartCardMessageUpdate`（`frontend/src/components/views/character/CharacterChat.tsx:943-1067`）：

- 默认持久化（`localOnly === true || persist === false || save === false` 才豁免，`:979-983`）；
- 持久化时 → `handleEditMessage`（`:1006`）→ `useCharacterChat.ts:1667` 定义，体内 `:1722`：`api.put('/api/character-sessions/${selectedSession.id}/messages/${persistedMessageId}', { content, role, name, swipes, swipe_id, swipe_info, extra, … })`，且仅当消息 id 为正整数（后端真实 id）才发；
- 帧内 content 路径 options 为空 ⇒ swipes 从宿主权威 messages 兜底展开、新 content 写进激活 swipe 槽位（`:987-999`），PUT 请求带完整 swipes ⇒ **正文写回会落库** ✅。

**既有消息更新端点清单**（`backend/app/api/character_ext.py`，grep 实测）：

| 端点 | 行号 | 覆盖字段 |
|---|---|---|
| PUT `/{session_id}/messages/{message_id}` | :3446 | content、role/name/is_user/is_system、swipe_id、swipes、extra 族、swipe_info；is_locked 403；[MEM-SYNC-ON-EDIT] 记忆同步（:3522-3528） |
| PATCH `/{session_id}/messages/{message_id}` | :3574 | **仅 is_hidden / is_locked**（visibility） |
| DELETE `/{session_id}/messages/{message_id}` | :3110 | 删楼 |
| GET/PATCH `…/messages/{message_id}/swipes` | :6879 / :6929 | swipe 读 / 单 swipe 更新 |

### 「刷新即丢」机理小结（分轨定性）

| 轨 | 调用面 | 写到哪 | 落库？ |
|---|---|---|---|
| 沙箱/getContext 轨（MVU 等插件脚本） | `getContext().setChatMessages`（getContext.ts:2697） | runtime.context.chat + messageManager（两份内存） | ❌ 无请求，返回 true 为假成功 |
| 智能卡 iframe 轨·正文 | `setChatMessages([{message_id, message}])` / `setChatMessage(content,…)` | requestParent → controller → applySmartCardMessageUpdate | ✅ PUT :3446 真落库 |
| 智能卡 iframe 轨·swipes/name/extra/is_hidden | `setChatMessages` 的非 message 字段 | 帧内镜像 compatChat | ❌ 显式 warn，无父侧写通道 |

与 `docs/OPEN_ISSUES.md:451`（[P2-9] 第 3 项「落库（持久化）缺口仍在，是否下沉 /api/chats/save 待影响评估后决定」）记载一致。

## 修复方案（建议，落点与风险）

### 推荐：a) getContext 轨补调既有 `POST /api/chats/save`（后端零改动）

- **落点**：`frontend/src/lib/sillytavern/getContext.ts:1834-1841`——把 `recordStubHitOnce('setChatMessages:persist', …)` 段替换为：持久化成功才静默、失败才登记降级。在该函数内直接复用已构建的完整楼层数组 `next`（两种入参形态都已展开为整包）作为 `chat` 字段。
- **入参**：`{ avatar, ch_name, file_name, chat: next }`（ChatSaveRequest 字段见 silly_tavern.py:100-113）；会话定位优先带 `X-Palink-Session-Id` 头（`st_save_chat` :3016 消费），避免 avatar/file_name 推断歧义。
- **swipe 数组冲突风险：低**。save 端点「原样保存 swipes，不强制 swipes[swipe_id]=content」（:3147-3150），Galgame「格式化文本写非当前 swipe、mes 保持原文」的 COT 双版本语义保真——这正是旧大堂轨选它的原因。
- **必须加的护栏（风险项）**：
  1. **空读源 gate**：`runtime.context.chat` 为空、落到 messageManager 兜底时**禁止**发整包 save——messageManager 在真实会话无人喂食（本报告发现 1 的 grep 证据），拿它整包覆盖等于全删重插清空会话。
  2. **全删重插换主键**：save 会 delete + reinsert（:3128-3161），`CharacterChatMessage.id` 全部变化 ⇒ 前端 `setMessages` 里的旧 id 全部失效，必须 save 成功后重拉消息（现有 `palink:chatMessagesUpdated` → loadMessages 通道正好承担）；**记忆行按 message_id 挂接，而 save 端点没有 PUT 端点的 [MEM-SYNC-ON-EDIT] 等价物**（:3111-3169 全文无 memory 调用）——高频批量写场景的记忆镜像影响面，本查验未深挖记忆表关联结构，**待主脑裁定**（可能需要后端在 save 路径补记忆重挂，或至少评估）。
  3. **并发覆盖**：整包覆盖以读源为准，读源陈旧会回滚其他轨刚写的消息；建议 save 前以会话为键校验楼层计数，或至少在文档标注该语义。
- **为什么不用 b) 逐楼 PUT 作为主通道**：PUT 端点无条件执行 `_sync_message_content_to_active_swipe`（`character_ext.py:3515`），该函数把 content 强制写入激活 swipe 槽（`:472-505`）——与 COT「mes 与激活 swipe 文本不同」语义**冲突**，会破坏双版本机制；且 setChatMessages 的整数组形态需要自行 diff 出增/删/改再逐楼调用（无批量端点），复杂度高。PATCH :3574 只管 is_hidden/is_locked，覆盖不了正文/swipes。
- **第二个独立缺口（不阻塞 a）**：智能卡 th134 轨的 `name/extra/is_hidden` 镜像-only（part-07.ts:659-665）。既有 PUT :3446 其实支持 name/extra、PATCH :3574 支持 is_hidden，缺的只是帧侧→父侧的写通道；可后续在 requestParent action 族加一个「按楼层号落库」分支，与 a 分头施工。

### 验收判据

1. 卡内/插件 `setChatMessages` 改一条消息 → 刷新页面 → 内容仍在（`GET /api/chats/get` 或会话重进后可见）。
2. COT 双版本：mes 与非激活 swipe 文本不同 → 保存后两者都保留，激活 swipe 不被 mes 覆写。
3. 空读源保护：runtime chat 为空时不发整包 save，既有会话不被清空。
4. 降级桩 `setChatMessages:persist` 从「每会话必现」变为仅持久化失败时出现（`window.__palinkCompatStats` 可验证）。
5. 现有契约测试需同步更新：`sandbox-dep-decouple.test.ts:199-204`（「未落库降级被登记」用例）与 `h-tavernhelper-134-contract.test.ts:757-798`（th134 写族契约）。

## 结论与建议

1. 「刷新即丢」根因确认：getContext 轨 `applyStChatMessages` 只写两份内存副本且返回 true（前端假成功），全程无网络请求；UI 上短暂可见只是因为事件触发了一次服务端重拉前的内存态渲染。
2. 后端 `POST /api/chats/save` **已存在且语义完备**（silly_tavern.py:3011，返回 {ok:true}，swipe 保真），修复缺口纯在前端——推荐方案 a，落点 getContext.ts:1834-1841，需带空读源 gate。
3. 智能卡 iframe 轨改「正文」已真落库；改 swipes/name/extra/is_hidden 仍只帧内镜像+warn，是第二个独立缺口。
4. 待主脑裁定：/api/chats/save 全删重插会更换消息主键，其对按 message_id 挂接的记忆镜像的影响面未深挖（save 路径无 [MEM-SYNC-ON-EDIT] 等价物），拍板前需评估。
