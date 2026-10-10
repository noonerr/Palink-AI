# REPORT — MVU 变量框架 × Palink 自有变量体系：重叠专题

- 日期：2026-10-04（会话 10-04 23:49 起，跨 10-05 00:00 落盘；沿用会话起始日，与批次 15 文档同日）
- 范围：只做**研究**（读码 + 后端测试复现），未改任何产品代码
- 上游输入：另一 agent 的交付报告（批次 15，`59e7ad1` + `4aa481f`）及其「MVU 冲突专题」口头结论
- 结论一句话：**重叠是真的，但"两份实现"说轻了 —— 同一份 stat_data 在本仓有 8 个存储位点、5 套解析/供给实现、0 个单一真源。其中两条已在本次研究中跑测试证实为真缺陷。**

---

## 0. 三十秒速览

| # | 结论 | 证据强度 |
|---|---|---|
| 1 | MVU 插件（MagVarUpdate）与我们的变量体系**在 7 个环节上逐项重叠**：说明书 / 解析器 / schema / 初始化 / 副模型 / 存储 / 渲染 | 静态读码，高 |
| 2 | 插件那条「随 AI 输出」在 Palink **是被设计性关死的**（后端 + 前端共 **4 处**剥 `<UpdateVariable>`），不是配置问题 | 静态读码，高 |
| 3 | **新发现（已跑测试证实）**：后端两套变量存储 + **读优先级倒挂** → MVU 引擎写进 `chat_metadata.variables` 的新值，会被 `ChatVariable` 表里的旧行**遮蔽** | pytest 实测，**确证** |
| 4 | **新发现（已跑测试证实）**：`POST /api/chats/save` 在 payload 不带 `chat_metadata` 条目时，会把 `session.chat_metadata` **整份清掉**（只保 `palink_injections`）—— 而插件 `setChatMessages` 恰好就是这种 payload | pytest 实测，**确证** |
| 5 | 建议：**不要把 MVU 那份接回来当写入口**。保留后端 `mvu_engine` 为唯一真源，把插件降级为「只读消费 + 渲染」 | 判断 |
| 6 | 你列的六个决定项里，**先做第 3 项（关整包覆写门）和第 1 项（修读优先级倒挂）**，两者都比"让 MVU 真能写"更急 | 判断 |

---

## 1. 结论先行

「MVU 的变量功能和我们自己在做的是同一件事」——这句话成立，而且可以更精确：

> 我们做的是 **MagVarUpdate（MVU）协议的 Palink 服务端实现**（`backend/app/services/mvu_engine.py`，1279 行），
> 插件做的是 **同一份协议的第三方浏览器实现**。
> 两份实现解的是同一个问题（把 AI 回复里的 `<UpdateVariable>` 解析成 stat_data 并持久化），
> 但**各自持有解析器、各自持有存储、各自注入说明书**。

因此这不是「功能撞车需要取舍」，而是**协议级重复实现**。取舍点不在"要不要 MVU"，而在**哪一份是权威**。

**我的判断：后端那份必须是权威。** 理由三条（都可验证）：

1. **它是提示词装配的消费方**。`roleplay_prompt_assembly.py` / `character_message_builder.py` 读的是后端 `chat_metadata.variables`。插件写在哪，都不会进提示词。
2. **它是唯一被 SSE/WS 四入口共用、且写了 3 份 SPEC + 3 份测试的链路**（`test_mvu_engine.py` / `test_mvu_sse_wiring.py` / `test_mvu_initial_stat_data_sources.py`）。插件那份在本仓**零测试**。
3. **它是无头可跑的**。插件那份依赖 CDN + Vue + 卡脚本运行时，任何一环挂掉变量系统整体失效（2026-10-03 已实测复现过一次，见 `st-third-party-globals.ts` 文件头）。

---

## 2. 重叠清单（逐环节对照）

| 环节 | Palink 自有（服务端权威） | 插件 MVU（MagVarUpdate，CDN） | 重叠 | 判定 |
|---|---|---|---|---|
| **① 说明书**（告诉模型怎么输出变量块） | `default_prompts.py:263-281` MVU-EXEMPT 例外规则；`character_message_builder.py` 变量块保留 | 插件自带 `setExtensionPrompt` 注入变量规则说明 | ✅ | **两份说明书**，同时注入 → 模型收到两套措辞 |
| **② 解析器** | `mvu_engine.py`：`extract_update_variable_blocks`（196）+ `apply_patches`（456）+ `_JSONPATCH_OPS`（83） | 插件自己解析 `<UpdateVariable>` / `_.set()` | ✅ | **两份解析器**，同一段文本 |
| **③ schema 提取** | `mvu_engine.extract_schema_defaults`（850）解析 `z.object` | `registerMvuSchema`（插件侧） | ✅ | **两份**，且我们前端还有**第三份移植**：`utils/mvuSchemaParser.ts`（303 行，文件头自述"前端移植自后端 mvu_engine.py"） |
| **④ 初始化（initvar）** | `_extract_initvar_from_text`（979）+ `_extract_initvar_from_character_book`（1142）+ `build_initial_stat_data`（1162） | 插件 `VARIABLE_INITIALIZED` 事件 + 自己的 initvar 扫描 | ✅ | **两份**，都对同一批 `<initvar>` 世界书条目做扫描 |
| **⑤ 副模型解析** | `mvu_secondary.py`（148 行）走服务端 `complete_text_completion`，受额度/审计约束 | 插件「额外模型解析」自己直连（`isDuringExtraAnalysis()`） | ✅ | **两份**，且**插件那份绕过我们的额度与审计** |
| **⑥ 存储** | `chat_metadata.variables` + `ChatVariable` 表 + `msg.extra.variables` | TavernHelper 变量表（`getVariables/replaceVariables`，按 chat/message/character/global 分作用域） | ✅ | **两套**（实际是 8 个位点，见 §5.2） |
| **⑦ 渲染** | `TavernHelperPanel.tsx`（179 行）+ `CharacterChat` 的 `stat_data` 下发 | 插件自带状态栏 / 好感度面板 | ✅ | 两份，但这份**重叠无害**（都读同一份数据就能一致） |
| **⑧ 设置面板** | 无（本次批次才给插件开 `SillyTavern.extensionSettings`） | `mvu_settings` 存 `extensionSettings` | ❌ | **不重叠**，这是插件独有、我们必须供给的面 |
| **⑨ 事件总线** | 无 | `Mvu.events`（VARIABLE_INITIALIZED / COMMAND_PARSED / VARIABLE_UPDATE_ENDED / BEFORE_MESSAGE_UPDATE） | ❌ | **不重叠**，卡脚本扩展点，需供给 |

**读法**：①②③④⑤⑥ 是重复劳动（可收敛），⑧⑨ 是真缺口（该补）。

---

## 3. 我们自己的变量体系全貌

按「权威性」分四层，不是按文件分：

### 3.1 真源层（后端，唯一权威）

| 位置 | 行数 | 职责 |
|---|---|---|
| `backend/app/services/mvu_engine.py` | 1279 | 解析 `<UpdateVariable>` → JSON Patch → 应用；zod schema 提取；`<initvar>` 初始化 |
| `backend/app/services/mvu_secondary.py` | 148 | 副模型兜底（主模型未输出变量块时） |
| `backend/app/services/character_message_builder.py:555+` | — | `apply_mvu_reply_to_session` 共用入口（WS + SSE 四入口） |
| `backend/app/api/websocket.py:753-785` | — | WS 主路径：先解析落库 → 再剥正文 |
| `backend/app/api/character_ext.py:4780-4801 / 5984-6019 / 6129-6157` | — | SSE 三入口同构 |
| `backend/app/api/character_ext.py:6195` | — | `POST /{session_id}/mvu-secondary` 手动触发副模型 |

### 3.2 派生物层（读时拼装，非独立真源）

| 位置 | 职责 |
|---|---|
| `chat_metadata.variables.stat_data` | 会话级变量包（MVU 引擎写） |
| `ChatVariable` 表 | ST 客户端侧的 key/value 镜像（saveChat 写，**读时优先**，见 §5.2） |
| `CharacterChatMessage.extra.variables` | 每楼快照（`character_ext.py:4791`） |

### 3.3 兼容供给层（给插件/卡脚本看的）

| 位置 | 提供 | 备注 |
|---|---|---|
| `lib/sillytavern/getContext.ts:1736` | `ctx.variables.{local,global}` | ⚠️ **只有 local/global，没有 chat** |
| `lib/plugin-system/sandbox.ts:3476-3544` | `getVariables/replaceVariables/setVariables/...` + 内存 `tavernVariableStore`（`sandbox.ts:43`） | 沙箱轨；**纯内存 Map，不落库** |
| `lib/sillytavern/card-script-runner.ts:305-343` | `getVariables`（读桥）+ `setVariables`/`setVariable`（**recordStubHit 桩**） | **卡脚本轨**；注释原文：「卡内脚本回写会话变量未开放（Palink 变量更新走后端 MVU 链路）」 |
| `smart-card-runtime/SillyTavernCompatRuntime.ts:6393-6527` | `window.Mvu.{getAllVariables,getMvuData}` + stat_data 归一化 + UUID 绝对化 | 智能卡 iframe 轨 |
| `smart-card-runtime/frame-shim/legacy-st-sim.ts:1126-1215` | 又一份 `window.Mvu` + `getVariables/replaceVariables` | 第三份 |
| `smart-card-runtime/inline/inline-st-globals.ts:443-473` | 又一份 `getVariables` + Mvu 补刀 | 第四份 |
| `utils/sillyTavernPluginRuntime.ts:1228-1233` | `registerMvuSchema` 捕获桩（只存 `window.__palinkMvuSchemas`） | 经典轨 |

### 3.4 消费层

- 提示词装配：`roleplay_prompt_assembly.py`（后端）
- 前端面板：`TavernHelperPanel.tsx`（`parseMvuSchema` 正则解析 z.object，**不执行 ESM、不依赖 zod**）
- 卡脚本读：`ctx.stat_data`（`CharacterChat.tsx:1726`）+ `getVariables()` 桥（`CharacterChat.tsx:1665`）

---

## 4. 插件侧 MVU 的能力面（MagVarUpdate 契约）

权威定义在本仓就有：`st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.mvu.d.ts`

| 契约成员 | 用途 | 当前 Palink 卡脚本轨 | 判定 |
|---|---|---|---|
| `Mvu.getMvuData({type,message_id})` | 读变量 | ❌ 无（仅智能卡 iframe 轨有同名实现） | **缺口** |
| `Mvu.replaceMvuData(data, opt)` | **写变量** | ❌ 无 | **缺口（有意）** |
| `Mvu.parseMessage(msg, old)` | 解析 `_.set()` | ❌ 无 | 缺口 |
| `Mvu.isDuringExtraAnalysis()` | 副模型解析中 | ❌ 无 | 缺口 |
| `Mvu.events.*` | 4 个事件 | ❌ 无 | 缺口 |
| `Mvu.MvuData` 结构（`initialized_lorebooks` + `stat_data`） | 数据形状 | ✅ 我们下发的是这个形状 | 一致 |
| `TavernHelper.getVariables/replaceVariables` | 读写变量表 | 读 ✅ / 写 ❌（桩） | 半缺口 |
| `SillyTavern.extensionSettings` + `saveSettingsDebounced` | 设置面板 | ✅ 批次 15 已挂（按卡） | 已通 |
| `SillyTavern.chatCompletionSettings` | 额外模型解析配置 | ✅ 批次 15 已挂影子副本 | 已通 |
| `getScriptId` / `getTavernHelperVersion` 等模块顶层依赖 | 让 bundle 不抛错 | ✅ `MVU-UNBLOCK 2026-10-04` 已补 | 已通 |

**这就是「MVU 写不了变量」的准确根因**：不是能力缺失，是**供给装错了轨**。

- `replaceVariables` 在 `sandbox.ts`（沙箱轨）与 `legacy-st-sim.ts`（智能卡轨）都有 → 卡脚本轨没有
- `window.Mvu` 在 `SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` 都有 → 卡脚本轨没有
- 卡脚本轨反而**显式把写口做成了桩**（`card-script-runner.ts:330-343`，带 `recordStubHit`）

所以「3 个未定义错误」高度吻合 `TavernHelper` / `replaceVariables` / `Mvu` 三项（**具体是哪三个以真机 console 为准，本次未复现**）。

---

## 5. 三处「不是重叠，而是冲突」

### 5.1 顺序冲突：剥标签（4 处）

我们的落库顺序是**「先解析、后剥离」**（`character_message_builder.py:560` 注释明确写死）：

```
AI 输出原文（含 <UpdateVariable>）
  → 后端 mvu_engine 解析 → 写 chat_metadata.variables
  → strip_update_variable_blocks() 剥掉整块
  → 落库的正文已无变量块
```

剥离点共 **4 处**：

| # | 位置 |
|---|---|
| 1 | `backend/app/api/websocket.py:785`（WS 主路径） |
| 2 | `backend/app/api/character_ext.py:4801`（force 快照） |
| 3 | `backend/app/api/character_ext.py:6002` |
| 4 | `backend/app/api/character_ext.py:6138` |
| +前端 | `components/ui/custom/Message.tsx:873-874`（显示层再剥一次，兜底） |

**后果**：插件无论监听 `MESSAGE_RECEIVED` 还是读消息正文，拿到的都是**已剥离**的文本 → 它的解析器恒空转。这正是另一 agent 说的「实测它看到的文本里 0 个块」。

**要点**：这是**故意设计**（避免变量指令泄漏进正文，也让插件不能绕过后端改变量）。所以：
- 不要为了"让 MVU 能解析"去取消剥离 —— 那会同时打开**双写**（后端 + 插件各写一次）。
- 正确方向是 §8 的「读我们的、写走补丁」。

### 5.2 存储冲突：8 个位点 + 读优先级倒挂【本次已实测确证】

同一份逻辑上的 stat_data，在本仓有 **8 个位点**：

| # | 位点 | 层 | 谁写 |
|---|---|---|---|
| 1 | `CharacterChatSession.chat_metadata.variables` | DB | **MVU 引擎**（`apply_mvu_reply_to_session`） |
| 2 | `ChatVariable` 表（key/value 行） | DB | `saveChat`(`silly_tavern.py:2961`) / `api/variables.py:152` / `macro_service.py:277` |
| 3 | `CharacterChatMessage.extra.variables` | DB | MVU 引擎（每楼快照） |
| 4 | `window.chat_metadata` | 浏览器内存 | `getContext.ts:2259` |
| 5 | `localStorage.__palink_chat_metadata` | 浏览器持久 | `legacy-st-sim.ts:1114` |
| 6 | React `sessionVariables` / `sessionVariablesRef` | 浏览器内存 | `CharacterChat.tsx:1665` |
| 7 | `tavernVariableStore`（Map） | 插件沙箱 | `sandbox.ts:43` |
| 8 | `smartCardVariableStore`（Map）+ 第三方 MVU 自己的表 | 智能卡轨 / 插件 | 各自 |

**倒挂点**在 `silly_tavern.py:1317-1341`：

```python
# _chat_header()：读时把 ChatVariable 行 merge 进 chat_metadata.variables
merged_variables = dict(base_variables)   # base = chat_metadata.variables（MVU 引擎写的）
merged_variables.update(db_variables)     # ← ChatVariable 行「后写覆盖」，即优先级更高
```

**实测（pytest，临时用例已删）**：

```
[H1] 首次读回 好感度 = 1
[H1] PUT /metadata 写 99 后读回 = 1          ← 读到的还是旧值
[H1] DB chat_metadata = {"variables": {"stat_data": {"桃汐": {"好感度": 99}}}, ...}
       ↑ DB 里明明是 99，但 GET /api/chats/get 返回 1
AssertionError: H1 成立：ChatVariable 行遮蔽了 MVU 更新，读回旧值 1
```

**机制**：只要历史上任何一次 `saveChat` 带着 `variables` 落过一行 `ChatVariable(key="stat_data")`，那行的值就**永久遮蔽**此后 MVU 引擎对 `chat_metadata.variables` 的所有更新（直到下一次 saveChat 覆盖该行）。而插件面读变量走的正是 `_chat_header`（`/api/chats/get`）→ **插件看到的是冻结值**。

这条是本次研究最值钱的发现之一：它同时解释了「为什么有些卡的 stat_data 看起来"更新了但面板不动"」。

### 5.3 整包覆写门 ×2【本次已实测确证】

**门 A：`PUT /api/character-sessions/{id}/metadata`（`character_ext.py:2708-2734`）**

```python
existing = json.loads(session.chat_metadata) if session.chat_metadata else {}
existing.update(body)                      # ← 顶层浅合并：body 带 "variables" 键 = 整包替换 variables 子树
existing["palink_session_id"] = session.id
session.chat_metadata = json.dumps(existing, ensure_ascii=False)
```

无键白名单、无大小限制、无 schema 校验。而前端调用方 `getContext.ts:1515-1523` 送的是**整个** `window.chat_metadata`：

```ts
const metadata = (window as any).chat_metadata ?? {};
await api.put(`/api/character-sessions/${chatId}/metadata`, metadata);
```

→ 任何让 `window.chat_metadata.variables` 变成"插件局部视图"的路径，都会把整份 stat_data 换掉。**这就是你问的那扇门。**

**门 B（更严重，本次新发现）：`POST /api/chats/save`（`silly_tavern.py:2888-3010`）**

```python
persisted_metadata = {}                    # 默认空
for item in incoming:
    if "chat_metadata" in item and "mes" not in item:
        persisted_metadata = raw_meta      # ← 只有显式带条目才取
        continue
    chat_items.append(item)
...
# 只保留 palink_injections 一项，其余一律不保
if "palink_injections" in existing_meta and "palink_injections" not in persisted_metadata:
    persisted_metadata["palink_injections"] = existing_meta["palink_injections"]
session.chat_metadata = json.dumps(persisted_metadata, ensure_ascii=False)   # ← 整份替换
```

而插件的 `setChatMessages`（`sillyTavernPluginRuntime.ts:541/573`）送的 payload **恰好不带 `chat_metadata` 条目**：

```ts
let chatItems = (Array.isArray(current) ? current : []).slice(1);   // ← slice(1) 把 header 切掉了
const resp = await api.post('/api/chats/save', { avatar_url, chat: chatItems });
```

**实测**：

```
[H2] 种下后 DB chat_metadata = {"variables": {"stat_data": {...好感度:1}}, "note_prompt": "作者注", ...}
[H2] saveChat(无 chat_metadata) 后 DB chat_metadata = {'palink_session_id': ..., 'palink_character_id': ..., 'palink_branch_id': ...}
AssertionError: H2 成立：saveChat 把 chat_metadata.variables 整份清掉了
```

→ **`variables` 和 `note_prompt` 被清空，只留三个 `palink_*` 路由字段。**

**为什么至今没爆**：因为 `ChatVariable` 行（位点 2）还在，读时又会把它 merge 回来 → 表面上"变量还在"，只是**冻结**在最后一次带 `variables` 的 saveChat 那一刻（= §5.2 的倒挂）。两个缺陷互相掩盖，这正是它们能潜伏这么久的原因。

---

## 6. 对另一 agent 那份报告的复核

| 它的说法 | 我的复核 | 依据 |
|---|---|---|
| 三道检查数字属实（tsc 0 / 前端 718 / 后端 1796） | **本次未复跑**（你说你复跑过，采信） | 我只做了静态读码 + 两条定向测试 |
| 「设置保存打空号(404)」「注册命令必抛错」是真修 | **属实** | `plugins.py` 已有 `POST /api/plugins/runtime/settings`；`registerSlashCommand` 改走 `window.__palinkRecordStubHit` 转交（`sillyTavernPluginRuntime.ts:1296-1304`） |
| 标题写「按卡隔离」但没实现；切卡后设置静默丢 | **属实**，且根因描述准确 | `59e7ad1` commit message 自己订正了；`1337-1356` 的「无条件重指向」就是修复 |
| 把「设置抽屉」算成自己的活儿 | **属实（是别的会话的）** | `4aa481f` 已在交付报告顶部加订正段 |
| 「MVU 变量功能和我们完全是同一件事」 | **成立，但低估了规模** | 见 §2：不是"两份"，是 7 环节重叠 + 8 个存储位点 + 5 套供给 |
| 「随 AI 输出必然空手，它看到 0 个块」 | **成立** | 4 处剥离点（§5.1） |
| 「有个改会话元数据的接口整包覆写、不校验」 | **成立** | `character_ext.py:2729` `existing.update(body)` |
| 「这也是我故意没把"保存聊天"真接后端的原因」 | **判断正确，但理由还差一条** | 除了覆写门，`saveChat` 本身还会**清空** metadata（§5.3 门 B）—— 比它说的更危险 |

**它没发现的两条**（本次新增）：§5.2 读优先级倒挂、§5.3 门 B 的整份清空。

---

## 7. 边界与代价（复述 + 补充）

它给的边界地图我复核后同意：

- **放出去的是"说什么"**：往提示词塞话、改消息、写世界书条目、自己发起生成、外部网址默认放行
- **守住的是"能拿多少、能改谁"**：不给生成参数无上限、不给全局层、不给装插件、不给登录凭据、不给万能兜底

**我补充一条它没说的代价**：

> **变量这一层现在是"放出去写、但写不到我们的真源"** —— 插件能写进 `tavernVariableStore`（内存 Map），写得"成功"，刷新即丢，且**不留痕迹**（因为 `replaceVariables` 是"成功返回"而不是 recordStubHit）。这比"明确拒绝"更危险：卡作者会以为变量系统在工作。

建议：**要么把写口接到真源，要么明确登记降级**。当前"半开半闭"是最坏的状态。

---

## 8. 建议（对应你列的六个决定项）

按**急迫度**重排，并给出我的理由：

### P0-1 · 修读优先级倒挂（新增，你没列）
`silly_tavern.py:1339` 的 `merged_variables.update(db_variables)` 让镜像行压过真源。最小改法：**`variables.stat_data` 这类整包键以 `chat_metadata` 为准，`ChatVariable` 行只补 `chat_metadata` 里没有的键**。理由：这条现在就在制造"面板不动"的现场故障，且改动面极小。

### P0-2 · 关那扇整包覆写门（你列的第 3 项）
你列的「关那扇整包覆写的门」应该**扩成两扇**：
- 门 A：`PUT /{session_id}/metadata` 加键白名单（至少禁 `variables` / `palink_injections`，或改成"只允许插件自己的命名空间键"）
- 门 B：`POST /api/chats/save` 的保留清单从「只保 `palink_injections`」扩到「保全部 `palink_*` + `variables` + `note_prompt` + `hidden_bots`」——**或**改成"payload 无 chat_metadata 条目时不碰 metadata"

理由：门 B 是**插件热路径**（`setChatMessages` 必走），比门 A 更容易被触发。

### P1 · 封「卡片自带外部接口地址」（你列的第 2 项，建议封）
同意封。理由：这是"能拿多少"的边界，不是兼容性缺口；不封 = 任何卡能指定对话去向并绕过额度与审计。

### P2 · 变量写入接口挂到卡脚本轨（你列的第 1 项，建议**不要**照它的做法做）
同意你的判断：**让它读我们的、写走补丁**。具体：

1. **读**：把 `Mvu.getMvuData` / `TavernHelper.getVariables` 挂到卡脚本轨，数据源指向 `sessionVariablesRef`（已有）—— 这是纯搬运，零风险。
2. **写**：**不挂** `replaceVariables` 真实现。改成：
   - 卡脚本调用 `replaceVariables(vars, {type:'chat'})` → 走一个新的**补丁入口**（生成 JSON Patch → 复用 `mvu_engine.apply_patches` → 写 `chat_metadata.variables`）
   - 这样写口只有一条，且经过我们的 `_` 只读前缀校验、pointer 安全、事务提交
3. **事件**：补 `Mvu.events` 四件套（纯通知，让卡脚本扩展点活起来）

**动变量链路必须单独做、单独验** —— 同意，而且要**先做 P0-1/P0-2**，否则补丁写进去也会被旧行遮蔽。

### P3 · `dist_new_b15`（12M 构建中间件）
建议**删**。理由：它是构建中间产物不是发布产物；真回滚件在 `_BACKUPS/2026-10-04_插件设置按卡隔离适配/`（台账已登记）。磁盘 94% 满的收益比留着大。**但删之前请你自己确认一次**（我不动 `frontend/dist` 边界内的东西）。

### P4 · admin 默认密码
**这条风险确实比插件大**。建议立刻改，并加环境变量。与本次研究无关，但优先级最高。

---

## 9. 复现命令

```bash
# ① 变量存储位点清单（8 个）
grep -rn "ChatVariable(" backend/app --include=*.py
grep -rn "tavernVariableStore\|smartCardVariableStore" frontend/src --include=*.ts | head

# ② 读优先级倒挂（问题代码）
sed -n '1317,1341p' backend/app/api/silly_tavern.py

# ③ 整包覆写门 A
sed -n '2728,2732p' backend/app/api/character_ext.py

# ④ 整包覆写门 B + 保留清单只有 palink_injections
sed -n '2932,2944p' backend/app/api/silly_tavern.py
sed -n '538,576p' frontend/src/utils/sillyTavernPluginRuntime.ts

# ⑤ 剥离点（4 处 + 前端兜底）
grep -rn "strip_update_variable_blocks" backend/app --include=*.py
sed -n '873,874p' frontend/src/components/ui/custom/Message.tsx

# ⑥ 卡脚本轨把写口做成桩（"MVU 写不了变量"的直接原因）
sed -n '326,344p' frontend/src/lib/sillytavern/card-script-runner.ts

# ⑦ 插件 MVU 权威契约
sed -n '1,60p' st-plugins/third-party/JS-Slash-Runner-main/@types/iframe/exported.mvu.d.ts
```

本次两条实测（临时 pytest 用例已删除，仅留步骤描述）：
1. 建角色 → `POST /api/chats/save` 带 `chat_metadata.variables.stat_data.桃汐.好感度=1` → `PUT /api/character-sessions/{id}/metadata` 写 99 → `POST /api/chats/get` 读回 **1**（期望 99）→ 倒挂成立
2. 同上种值 → `POST /api/chats/save` 不带 `chat_metadata` 条目 → 查 DB `session.chat_metadata` → 只剩三个 `palink_*` 键 → 清空成立

---

## 10. 局限与未验证

1. **未跑全量门禁**。本次只做了静态读码 + 2 条定向测试；`tsc` / `vitest` / 全量 `pytest` 未复跑（你已复跑过，采信其数字）。
2. **未真机复现插件侧**。`localhost:14000` 未由我打开；「3 个未定义错误具体是哪三个」是按供给轨差异推断的，**需真机 console 确认**。
3. **§5.2 / §5.3 是测试级确证，不是线上确证**。测试用 SQLite in-memory + TestClient，与生产 PostgreSQL 的差异不影响这两条逻辑（都是应用层合并顺序问题），但**生产现场是否存在"带 variables 的 saveChat"取决于实际调用方**，未在线上库核查。
4. **未清点存量数据影响面**。`ChatVariable` 表里有多少 session 存在 `stat_data` 键的行、有多少卡受影响，未查（需连生产库）。
5. **`ChatVariable` 行的 key 粒度未穷举**。§5.2 假设顶层键 `stat_data`；若历史数据是扁平键（`桃汐.好感度`）则倒挂形态不同，需查实际数据分布。

---

## 11. 追加议题：能不能整体换成插件那套、删掉我们自己的？

> 用户提问（2026-10-05）：插件有独立的变量对话框/面板显示模型输出的变量信息，我们是直接隐藏的；
> 插件设置里有「跟随 AI 一起出」和「副 AI」，与我们的功能重叠。
> 能不能把插件功能全部启用、把我们的删掉，既瘦身又补功能落差？

### 11.1 先纠正一个事实前提（部分对、部分不对）

| 你的印象 | 实际情况 | 证据 |
|---|---|---|
| 「插件有独立对话框显示变量信息」 | ✅ 对。插件有变量查看/编辑面板，我们**没有**这个 diff 查看器 | 契约 `exported.mvu.d.ts`；我们侧无对应组件 |
| 「我们是直接隐藏的」 | ⚠️ **半对**。`<UpdateVariable>` 原文我们确实剥掉不显示（**这是对的**，那是机器指令不是给人看的）；但**状态面板我们有**，而且有两条渲染路径 | `Message.tsx:1651-1666`：原生 `StatusBarPanel` 优先，`TavernHelperPanel` 兜底 |
| 「我们完全没有变量展示」 | ❌ 不对。`TavernHelperPanel.tsx`（179 行）复刻了酒馆助手状态栏外观：分组强调色、数值进度条按值变色、头像缩略图、布尔转是/否 | `TavernHelperPanel.tsx:100-178` |

**所以我们真正缺的不是"面板"，是"变量变更的 diff 查看器"**（每轮改了哪些字段、从什么变成什么）。这是纯前端活儿。

### 11.2 判定：**不能整体替换。** 六条硬约束，按硬度排序

**① 变量必须进提示词，而提示词在后端装配 —— 这条是决定性的**

```
roleplay_prompt_assembly.py:5116  _load_session_stat_data()     ← 读 DB 里的 stat_data
roleplay_prompt_assembly.py:5148  _load_effective_stat_data()   ← 消息级快照优先，回落会话级
roleplay_prompt_assembly.py:5019  _flatten_stat_data()          ← 压平成中文键值行
roleplay_prompt_assembly.py:4243  MVU 变量更新指令注入
```

插件的变量住在**浏览器内存**（`tavernVariableStore`，`sandbox.ts:43`）。**它永远到不了服务端装配**。
删掉后端引擎 = 模型再也看不到「当前好感度 37 / 现在是第 3 天下午」= **整个变量系统的存在意义消失**（只剩一个给人看的面板）。

**② swipe / 重生成 / 分支回退的语义，插件没有**

`_load_effective_stat_data` 的文档注释（`5154-5170`）写得很清楚：变量镜像存在**每条消息**的 `extra.variables`，swipe 回退时取该楼对应的版本。
插件是 **chat 级单一 store**，没有"变量随分支回退"这个语义。删掉后端 = 用户 swipe 回去，变量不跟着回退。

**③ 副 AI 走插件 = 绕过我们的额度与审计**

插件的「额外模型解析」自己直连 `generateRaw`。服务端**不知道这次调用是"变量解析"** → 无法计费、无法审计、无法限流。
这与你自己定的底线冲突：「后端归属权必须属于我们」。

**④ 剥离必须在服务端，否则回到 2026-09-30 的坑**

我们靠服务端剥 `<UpdateVariable>` 保证正文干净（4 处剥离点，§5.1）。
若解析搬到浏览器：流式正文已经发给前端了，标签会**裸显**（`HANDOFF_MVU初始变量断链与输出tag裸显_2026-09-30.md` 就是修这个）。
而且会**双写**（我们剥之前已解析一次，插件再解析一次）。

**⑤ 插件那份在本仓零测试，且依赖 CDN**

后端引擎有 3 份测试（`test_mvu_engine` / `test_mvu_sse_wiring` / `test_mvu_initial_stat_data_sources`），无头可跑。
插件依赖 `z / Vue / lodash / YAML` 从 CDN 拉，**2026-10-03 已实测挂过一次**：`z is not defined` + `Vue is not defined` → `window.Mvu` 为 undefined → 变量系统整体失效（`st-third-party-globals.ts` 文件头记录）。

**⑥ 跨设备 / 刷新持久**

后端存 DB（session 级）→ 换设备、刷新都在。插件 store 是内存 Map，刷新即丢。

### 11.3 有一个地方必须二选一，绕不过去

插件的「跟随 AI 一起出」= **它自己解析 AI 回复**。要让它生效，就必须**不剥标签**。

| 选项 | 后果 |
|---|---|
| **A. 我们解析（现状）** | 标签不外显 ✅ / 变量进提示词 ✅ / 插件那条路空转 ❌ |
| **B. 插件解析** | 插件面板活 ✅ / **标签裸显** ❌ / **双写** ❌ / 变量仍进不了提示词 ❌ |

**B 是净亏。** 所以"跟随 AI 一起出"这条**不能靠让路给插件来实现** —— 它本质是"谁来解析"，而不是"开关没打开"。

### 11.4 但你的三个诉求都对，且都有解 —— 换的是收敛方向

| 你的诉求 | 正解 | 不是 |
|---|---|---|
| **补显示落差** | ① 补「变量变更 diff 查看器」（纯前端，照 `TavernHelperPanel` 同一路子）② 让插件面板读我们的数据（见 §11.5） | 不是删后端引擎 |
| **不臃肿** | 删**前端那 3 套冗余 Mvu 壳**（`legacy-st-sim` / `inline-st-globals` / `sandbox` 的变量层），收敛成 **1 套只读 shim** | 不是删后端 1279 行引擎 |
| **补功能落差** | 插件「**说什么**」那半张地图全开：它自己的面板、`Mvu.events` 四件套、slash 命令、额外模型解析 UI | 「**能拿多少、能改谁**」那半张不开（生成参数无上限、全局层、装插件、凭据） |

**一句话**：冗余在前端，权威在后端。瘦身要砍前端，不是砍后端。

### 11.5 一个具体的接线坑（想做"插件面板显示我们的数据"必须先修）

`smart-card-runtime/SillyTavernCompatRuntime.ts:6509-6515`：

```js
window.Mvu.getAllVariables = mvuGetAllVariablesFinal;          // ← 无条件覆盖（对）
if (typeof window.Mvu.getMvuData !== 'function') {             // ← 只在"插件没提供"时才覆盖
  window.Mvu.getMvuData = mvuGetMvuDataFinal;
}
```

插件的面板用的是 `Mvu.getMvuData`。因为它是"插件已提供就不覆盖"，**面板读的是插件自己的（空的）store，不是我们的 stat_data**。
→ 要让插件面板显示我们的数据，必须把 `getMvuData` 也改成**无条件覆盖**（同 `getAllVariables` 的处理）。
这条不改，接多少显示层都是白接。

### 11.6 结论

**不要整体替换。** 正确形态是：

> **后端 `mvu_engine` 是唯一权威（写 + 进提示词 + 剥离 + 分支回退）；插件降级为只读渲染器与扩展点供给方（面板、事件、slash 命令）。**
> 冗余从前端 5 套供给里砍掉 3 套。插件"说什么"全开，"能拿多少/能改谁"不开。

这是唯一能同时满足「不臃肿 + 补落差 + 守住后端归属权」三条的形态。整体替换会同时丢掉提示词注入、分支回退、额度审计和标签剥离 —— 换来的只是一个面板。

---

## 12. 施工记录（2026-10-05 凌晨 · 用户拍板后）

用户拍板先做两件低风险的事，本批已施工完成（**未提交、未真机验证、未重建 dist**）。

### 12.1 一条决定性侦察证据（本批最有价值的一条）

**MVU 的变量 API 就是裸全局的薄包装。** 实测卡脚本
`backend/data/smart_card_assets/0c646fb31a…js`（307,179 B，MVU bundle）原文：

```js
getMvuData:function(e){return getVariables(e)},
replaceMvuData:function(e,t){return replaceVariables(e,t)}
```

该脚本真实调用计数（`grep -o` 实测）：

| API | 次数 | API | 次数 |
|---|---|---|---|
| `updateVariablesWith` | 8 | `getChatMessages` | 7 |
| `replaceVariables` | 7 | `setChatMessages` | 7 |
| `getVariables` | 4 | `deleteVariable` | 1 |
| `insertOrAssignVariables` | 1 | `setChatMessage` | 1 |
| `getMvuData` | 1 | | |

**这推翻了「面板接不上数据是因为缺读口」的假设**：页面轨 `window.getVariables` 早已由
`card-script-runner.ts` 桥到我们的会话变量。真正的问题是**写口族内部不一致** ——
`setVariables` / `setVariable` 已是 `recordStubHit` 显式降级，而 `replaceVariables` /
`updateVariablesWith` / `deleteVariable` / `insertOrAssignVariables` / `setChatMessage`
是**裸 undefined** → MVU 的更新管线每轮抛 `ReferenceError`（是"崩溃"而不是"降级"，
且不进 `__palinkCompatStats`，用户与开发者都看不见）。

另外确认：MVU 面板挂载点是 `#extensions_settings2`，展示入口为
`StPluginSettingsDrawer`（三个点菜单 → 插件设置）。

### 12.2 改了什么（3 改 2 增，全部前端）

| # | 文件 | 改动 |
|---|---|---|
| 1 | **新增** `components/ui/custom/VariableChangePanel.tsx` + `.css` | **变量变化记录**面板：旧值 → 新值，区分 新增 / 变化 / 移除 |
| 2 | `components/ui/custom/Message.tsx` | 在助手消息区（`TavernHelperPanel` 旁）挂上面板 |
| 3 | `components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts` | `Mvu.getMvuData` 由条件覆盖改**无条件覆盖**（含延时补刀处） |
| 4 | `lib/sillytavern/card-script-runner.ts` | 回写族从 2 个名字补到 7 个，一律显式降级、只登记不写入 |

### 12.3 三条设计口径（后续 agent 请勿推翻）

1. **变量变化面板两边都必须来自「消息级快照」。**
   不复用 `Message.tsx` 里那个带 `_sessionVariables` 兜底的 `statData` —— 若用它做"本楼"、
   用消息级做"上一楼"，无快照的历史消息会显示出一份**虚假的差异**。
   取不到基准（会话首楼 / 历史消息未落快照）**就不渲染**：宁可不显示，也不谎报变化。

2. **变化面板不受 `hasStatusBarScript` 限制。**
   现有 `TavernHelperPanel` 与原生状态栏是互斥的（有原生状态栏就不渲染兜底面板），
   但"这一轮改了什么"是**独立需求** —— 带原生状态栏的卡同样需要看到。二者互补，不替代。

3. **写口只登记、不写入。**
   Palink 的变量更新走后端 `mvu_engine`（生成时解析 `<UpdateVariable>` 并落库）、正文也由后端剥离后写入；
   卡脚本再写一遍会形成**双写**。异步族返回 resolved Promise、`deleteVariable` 返回
   `{variables, delete_occurred}` 同形状空结果 —— 避免调用方 `await`/`.then()`/读字段炸出第二个错。

### 12.4 门禁（本人独立复跑）

| 检查 | 结果 | 对比基线 |
|---|---|---|
| `npx tsc --noEmit` | **exit 0** | — |
| `npx vitest run` | **56 文件 / 751 passed / 3 skipped / 0 failed** | 53 文件 / 718 passed → **+3 文件 +33 例** |
| `py -3 -m pytest tests/ -q` | **1796 passed / 51 skipped / 0 failed** | 与基线一致（后端未改，无连带） |

**变量/插件专项子集**（用户 2026-10-05 要求单独跑一次）：

| 范围 | 结果 |
|---|---|
| 前端（33 个文件：variable / mvu / plugin / sillytavern / smart-card-runtime / status / macro / compat） | **483 passed / 3 skipped / 0 failed** |
| 后端（26 个文件：mvu / plugin / variable / regex / macro / extension_prompt / storage / ctx_hard_floor / l2_card_shadow / st_contract / st_plugin 等） | **542 passed / 16 skipped / 0 failed** |

新增测试 3 个文件共 33 例：

1. `variable-change-panel.test.ts`(18) —— 变化判定的五种情形（新增/变化/移除/不变/只读字段/空对象/数组/深层嵌套）。
2. `card-script-bridge-write-degradation.test.ts`(10) —— 钉住四条：① 回写族名字必须存在（消灭 ReferenceError）
   ② 每次调用必须进降级统计 ③ 返回值与 TavernHelper 契约同形状 ④ 幂等（不覆盖别人已挂的真实现）。
3. `mvu-panel-data-override.test.ts`(5) —— 结构断言 `getMvuData` 是无条件覆盖、且不碰 `replaceMvuData`/`parseMessage`。
   **已做反证**：把 `SillyTavernCompatRuntime.ts` 的赋值翻回条件守卫，其中 **2 条立即变红**，恢复后复绿。

⚠️ 新增测试 3 的存在本身是一个发现：`Mvu.getMvuData` / `getAllVariables` 此前在本仓**零测试覆盖**
（`grep -rn "getMvuData" src --include=*.test.ts` 命中 0）—— 即"面板读谁的数据"这条链路一直是无人守的。

### 12.5 环境坑（本轮复现，已记入 skill）

`SillyTavernCompatRuntime.ts` 是**大模板字符串**，注释里写反引号会提前终止模板 →
esbuild 报 `Expected ";" but found "if"`，vitest 连配置都加载不了。**改该文件前先确认注释无反引号。**

### 12.6 未做（交还用户）

1. **未提交**（3 改 2 增，逐项 pathspec 待办）。
2. **未真机验证** —— 需开站点确认三件事：① MVU 面板经「插件设置」抽屉可见 ② 面板显示的是我们的
   stat_data ③ 变量变化面板在有 `<UpdateVariable>` 的卡上正确。
3. **未重建 dist、未重建容器** —— 提交 ≠ 上线，改前端须重建 dist 并确认容器服务新指纹。
4. `replaceVariables` 的**真实写入**（走补丁入口 → `mvu_engine.apply_patches`）属变量链路改动，
   **须另立批次单独做单独验**（本报告 §8 的 P2）。
5. 前端 5 套变量供给里 3 套冗余壳（`legacy-st-sim` / `inline-st-globals` / `sandbox` 变量层）的收敛未做
   （本报告 §11.4）。

备份：`_BACKUPS/2026-10-05_变量面板与插件变量接线/`（`pre/` 3 文件 + `_manifest.tsv`，四要素齐，台账已登记）。
