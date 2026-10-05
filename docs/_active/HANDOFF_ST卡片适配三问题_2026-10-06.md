# HANDOFF：ST 卡片适配三问题 — 完工交接（2026-10-06）

> **状态：三个问题已修已上线并真机验收通过；一个问题（设置按钮）挂起待取证。**
> 作者：ST 适配排查会话。分支 `st-plugin-compat-20260727`。
>
> **本文件取代** [`HANDOFF_ST卡片适配三问题_2026-10-05.md`](./HANDOFF_ST卡片适配三问题_2026-10-05.md)
> 的结论主体（10-05 版仅其「订正说明」块仍有效，正文四节结论已被本版覆盖）。
> 配套规格：[`spec/SPEC_ST卡片适配核查与修复_2026-10-05.md`](./spec/SPEC_ST卡片适配核查与修复_2026-10-05.md)
>
> ⚠️ **不要相信任何早于本文件的口头汇报或记录**。本轮共 **5 次自我推翻**，
> 其中第 5 次是「修复已实测生效」的假阳性，连交接文档都被它写错过一次。

---

## 0. 一分钟版

| 用户反馈 | 结论 | 状态 |
|---|---|---|
| 是不是定向适配（传几张卡适配几张） | **不是**。全仓零卡 UUID / 卡名硬编码 | ✅ 排除，无需改 |
| 回忆相册解锁不了立绘 | 三层原因：① 装配把 at-depth 条目连坐丢弃（**我们的 bug**）② 注入后被当世界书正文裁掉（**我们的 bug**）③ 预算基数取了兜底假值 4096（**配置**） | ✅ ①② 已修已上线；③ 用户已把窗口改为 1048576 |
| 面板变量全是默认值 | 主页面缺 5 个 ST 全局 + 后端按名取书对角色绑定书恒空 | ✅ 已修已上线（19 条恢复） |
| iframe 正文里的设置按钮点不动 | **根因未定位** | ⛔ 挂起，见第 4 节 |

**相册链路已真机闭环**：新会话 3 条回复中 2 条落库含完整 `<cg>…</cg>`，
卡脚本 `tavern_cg_album_unlocked` 数组长度 = 2（与标签条数对应）。

---

## 1. 相册：三层原因，前两层是真缺陷

### 层 1 — at-depth 条目被正文块连坐丢弃（已修 `f23eeb0`）

`backend/app/services/roleplay_prompt_assembly.py` 的 `_append_worldbook_context` 里，
`depth_entries` / `em_top_entries` / `em_bottom_entries` / `outlet_entries` 四段被写在
`if wb_result.text:` **内侧**（同缩进整块吞进去）。正文一旦被 token 预算裁空，
这四类内容**静默全丢**，报告只显示误导性的 `no matched entries`。

ST 权威口径：`getWorldInfoPrompt` 一次返回**六个互不依赖**的结果
（`d:/SillyTavern-release/public/script.js:4575`），at-depth 走扩展注册表 `IN_CHAT`
（`:4612` `setExtensionPrompt(CUSTOM_WI_DEPTH_ROLE, …)`），从不被 before/after 是否为空左右。

### 层 2 — 注入后被当「世界书正文」优先裁掉（已修 `f23eeb0`）

depth 条目插进 `messages` 之后，`_classify_message_identifier` **没有对应分支**，
落到末尾兜底 → 被标成 `worldInfoBefore`（priority 80，`trimmable=True`）参与动态裁剪。
卡片自己声明的格式规范，超预算时和早期聊天历史一起优先出局。

ST 口径：in-chat 注入排在聊天历史预算裁剪**之前**完成
（`openai.js:1325` 先 `populationInjectionPrompts`，`:1331` 才 `populateChatHistory`），
而 `script.js:4834` 的裁剪只遍历聊天历史数组 —— 注入条目不在其中，**结构上永不被裁**。

修法：`_insert_depth_prompt` 插入时打 `_palink_in_chat_injection` 标记 →
分类器认出它 → priority 100 + `trimmable=False`。
identifier 沿用 `chatHistory`（ST 的 `prompt_order` 枚举里没有 in-chat 注入这一槽位，
借用可避免破坏既有 `PromptPreset.prompt_order` 配置）。

### 层 3 — 预算基数取了兜底假值（配置，非代码缺陷）

世界书 token 预算 = **模型窗口 × `world_info_budget`%**（默认 25）。

⚠️ **这一层差点被我误判成「卡太长，物理上无解」——那个结论是错的。**

`deepseek-flash` 这个 id **不在 `model_specs.json` 清单里**（清单只有 `deepseek-v4-flash`），
于是取 `_DEFAULT_FALLBACK_CONTEXT = 4096`（`unified_model_registry.py:48`）
→ 预算仅 1024，而该书 at-depth 常驻合计 14664 token，首条 2685 即溢出、
一票否决（ST 同语义 `world-info.js:4942`，外部复核确认）。

**4096 是兜底假值，不是真实窗口。** 用户已于 2026-10-05 把 `providers.json`
里该模型改为 1048576，改完立刻正常 —— **不用换模型、不用改卡、不用拆书**。

⚠️ **同一个坑的结构性成因，务必记住**：项目里有两条取窗口的路径，口径不一致——

| 路径 | 函数 | 对假 4096 的处理 |
|---|---|---|
| 管理页面 | `resolve_model_token_limits`（`:90` 优先级注释写得很清楚） | **丢弃假 4096**，去找清单真值 |
| 提示词装配 | `_get_model_context_window` | **直接当真实窗口用** ← 坑在这 |

### ⛔ 三条禁做（我差点都做了）

1. **不要改预算算法去迁就卡** —— 排序（`sortFn = b.order - a.order`）、
   百分比预算、`ignore_budget` 我们已与 ST 一致，改了就是偏离 ST + 对其他卡回退。
2. **不要把 ST 的 `context - replyLength` 口径搬进来** —— 我核过 `script.js:5927`
   方向确实没错，但套上去会让预算从 1024 降到 512，**反而更糟**，已撤回。
3. **不要恢复 `if wb_result.text:` 那层包裹** —— 它是层 1 的根因。

---

## 2. 面板变量恒为默认值（已修 `8275064`，已上线）

两个真 bug 串联：

**① 主页面缺 5 个 ST 全局** —— `getCharWorldbookNames` / `getCharWorldbook` /
`getCurrentCharacterId` / `getAllVariables` / `getChatVariables`。
只有 iframe 轨有，主页面轨从未实现。脚本卡的 `tavern_helper.scripts[]` 由
`card-script-runner` 注入**主页面**执行 ⇒ 受害的正是主页面轨，MVU init 抛
`ReferenceError: getCharWorldbookNames is not defined`。

⚠️ 三个实现陷阱（都是我踩过的）：
- `SUPPLIED` 白名单只决定 `TavernHelper` Proxy **认不认这个键**，不负责实现
- 桥缓存惰性 + MVU 在模块顶层 `await` ⇒ 首版直接读缓存返回 `[]`，
  **冷缓存时必须自己 `refreshCharLorebooks` 一次再答**
- 别用 `messageManager.getCurrentCharacterId()`（零调用方、恒返回空串），
  真源只有 `runtime.context.characterUuid`
- 该文件主体是**注入 iframe 的 JS 模板字符串**，注释里出现反引号会炸一堆 `TS1443`

**② 后端 `/api/worldinfo/get` 对角色绑定书恒返回 `{entries:{}}`** ——
`_resolve_worldbook` 硬过滤 `character_id.is_(None)`。
加 `include_character_bound` 参数，**只开在读端点**。
⛔ **`/edit` 与 `/delete` 必须保持「只认全局书」语义** —— 一并放开会把
「删掉角色绑定世界书」变成可达操作，这是刻意留的红线。

上线实测：`getLorebookEntries('露缇雅1.2')` 0 → **19 条**，控制台报错消失。

---

## 3. 附带堵掉的一个独立隐患（值得警惕）

装配往 message dict 里塞 `_palink_*` 私有标记键（`_palink_prompt_id`、
`_palink_char_field_proxy`，加上我这次新用的 `_palink_in_chat_injection`），
而**全仓原本没有任何剥离机制** —— 这些键会原样随 messages 发给推理 API，
OpenAI 兼容端对 message 对象的未知字段**不保证容忍**（严格实现直接 400）。

已在装配 `return` 前统一剥离全部 `_palink_*` 键。实测 27 条消息零泄漏，
且 `<cg>` 等规范内容不受影响（剥离只删键不删内容）。

发现路径本身值得记：我是因为**改测试**才发现的 —— 两处 `assert out[1] == {"role":…, "content":…}`
整 dict 相等断言变红，顺着查才问出「这键会不会发出去」。

---

## 4. 挂起：iframe 正文里的设置按钮点不动 ⛔

**根因未定位。三条假设已被我自己逐一否证，别再重复走：**

| 假设 | 结果 |
|---|---|
| opaque origin 阻断 IndexedDB | ❌ 否证。`legacy-st-sim.ts:180-257` 有 **80 行内存 IndexedDB 垫片**（我 grep 到 API 名就断言"没实现"，是错的） |
| 让用户点「信任」开关来验证 | ❌ 无效。该开关被 `prefersImmersive` 门控（`CharacterCardRenderer.tsx:1258`），**这张卡上根本不显示**，我给的法子不可执行 |
| 卡脚本在 DB 里被截断到 100000 字符 | ❌ **误报**（外部复核抓出）。截断的只是 `plugins.source_data` 快照字段，脚本本体 **4.2MB 完整**在 `plugin_scripts` 表，`tavern_helper` 运行时链路（`_synthesize_tavern_helper_js_content` → `resources.js`）**只读后者、从不读 `source_data`**。该线索已划掉 |

⛔ **不得放宽 sandbox**（`CharacterCardRenderer.tsx:1237`，P1-1 安全决策）：
同源 iframe 内卡脚本可直读 `parent.localStorage` / cookie 会话凭据 ⇒ 任意被投毒角色卡可窃取会话。

**新怀疑方向**：4.2MB 脚本塞进 iframe 后执行中途失败（比"数据不完整"更可能）。

**推进它只缺一个东西 —— 需要用户提供**：按钮长什么样、在卡 UI 的什么位置，
或一张只框住按钮本身、不带正文的截图。技术上取证的阻塞是跨源 iframe 读不到
`contentDocument`，所以内部 console 报错拿不到；
唯一旁路是临时硬编码 `trustedNative = true`（`CharacterCardRenderer.tsx:257/422`）
做一次性验证 —— **属改代码，需用户明确授权**。

---

## 5. 待办（按优先级，都可独立开工）

### P1 给「窗口未知」的模型补清单，别让下一个人再踩 4096
`model_specs.json` 里**没有 `deepseek-flash`**，任何没登记的模型都会静默拿到 4096
→ 世界书被整本裁光。修法二选一（或都做）：
- 把常用模型补进 `model_specs.json`
- ⚠️ 更治本：让装配走 `_get_model_context_window` 的两处（`:646`、`:3991`）
  改用 `resolve_model_token_limits`，与管理页口径统一 —— **但要先确认这两处的
  语义是否真该丢假值**，别照抄。

### P2 让「世界书被裁」这件事对用户可见（用户已认同该做）
现在的真实行为是**静默全裁 + 一句误导性的 `no matched entries`**。两级落点：
1. **装配报告**已有 `status=trimmed, reason='budget_exceeded (est=2685, used=0, max=1024)'`
   的逐条明细 —— 前端把 trimmed 条目亮出来即可，成本最低
2. 世界书管理页书籍行显示「本书常驻约 X tok / 当前预算基数 Y」——
   `_estimate_tokens` 与 `_resolve_budget` 都是现成函数

### P3 问题 3（设置按钮）取证 —— 见第 4 节

---

## 6. 交付与部署状态

**4 笔提交**（`st-plugin-compat-20260727`）：

| commit | 内容 |
|---|---|
| `f23eeb0` | 装配两处丢失（层 1 + 层 2）+ 私有键剥离 + 测试断言放宽 |
| `8275064` | 变量面板两处真 bug |
| `1017d6e` | AGENTS.md（新增探针自查条；连带并行会话的「文档存放规范」58 行，用户裁定一并提交） |
| `f583616` | SPEC + 10-05 交接书（含 7 条订正） |

**门禁**：前端 `tsc` 干净、`vitest` 60 文件 / **781 passed, 0 failed**；
后端 worldbook+prompt+depth 子集 **280 passed, 0 failed**。
⚠️ 后端**第一轮是 2 failed** —— 是我引入的回归（整 dict 相等断言撞上新增标记键），
已修。别把"最终绿"当成"一次过"。

**部署**：
- 后端已 `docker compose build backend && up -d backend`，`healthy`，服务在**容器内 8000**
  （`docker port` 无输出是正常的，后端不映射宿主端口，由前端 nginx 反代）
- 库在 `0068 (head)`，`RUN_MIGRATIONS_ON_STARTUP=false` → 启动**不改库**
- 前端 `runtime.ts` 那批**早已随 dist 上线**，本轮**未重建 dist**
  （判据：用**独有字符串字面量**从 `:14000` 抓 `CharacterView-BYm08pKQ.js` 命中，
  且入口 `index-BBJkM2rq.js` 引用该 chunk ×2 —— 不是孤儿文件）。
  验产物**只能 grep 字符串字面量**，标识符会被压缩抹掉。
- ⚠️ 站点端口是 **14000**（不是 13000/8000/3000）
- ⚠️ `Dockerfile:67` 是 `COPY . .`，build 会连带把工作区里**别人未提交的后端在途改动**
  一起固化进镜像。本轮无害（那 5 个文件此前已在容器可写层以同内容运行，
  逐个 md5 比对过），但**下次 build 前仍要先做这个比对**。

**工作区遗留（不属于本轮，勿误扫）**：并行会话的 MVU 在途改动
（`mvu_engine.py`/`mvu_secondary.py`/`mvu_cleanup.py`/`VariableChangePanel.tsx`/
`cardVariables.ts`/`mvuSecondaryFeedback.ts`/alembic `0068`/相关测试）、
`docs/` 顶层→`_active`/`_archive` 那批搬迁、`scripts/docs/gen_docs_catalog.py`。
本轮全程用**逐项 pathspec** 提交，`git add -A` 一次也没用过。

**临时探针**：`backend/scripts/_probe_*.py` 共 24 个，其中**只有一部分是我建的**
（`_probe_assembly_v3..v9`、`_probe_order`、`_probe_total`、`_probe_overlay`、
`_probe_classify`、`_probe_final`、`_probe_ctx`、`_probe_model`、`_probe_budget100`、
`_probe_assembly_e2e`、`_new_block`、`_apply_block`）。
⛔ **绝对不要 `rm backend/scripts/_probe_*.py` 一把删** —— 会连带清掉别人的
`_probe_gateway.py`、`_probe_sdk_reuse.py`、`_probe_mvu_plugin_defaults.py`、
`_probe_real_prompt_5x.py`、`_probe_param_matrix.py`、`_probe_wb_activation.py` 等。
其中 `_probe_assembly_v9.py`（逐参数 bisect）和 `_probe_overlay.py`（真实入口端到端）
有复现价值，建议保留或改造进测试。

---

## 7. 方法学教训（给下一个 agent 的真东西）

本轮 **5 次自我推翻**，记下来是因为每一次都可能被重犯：

1. 「`<cg>` 规范没进提示词」—— 只查 `result.text`，而该条目 `position=4`（at-depth）
   **本就不进 text**。读代码得到的绝对结论一律先实测。
2. 「卡内 promptOnly 正则删了规范」—— placement 用错（我拿 `AI_OUTPUT=2` 测，
   而 ST 对世界书内容实际用 `WORLD_INFO(5)`：`d:/SillyTavern-release/public/scripts/world-info.js:5086`）。
   同一条 ext 用 placement=2 会把 `<cg>` 删掉、用 placement=5 则完好。
3. 「爱意=0 < 200 ⇒ 卡设计如此、非 bug」—— 没做越过阈值的实测就下结论。
4. 「刷爱意就能开相册」—— 用**能推动的指标**代替真正原因，且只查了两条并列路径中的一条。
   用户的机制断言（「这个卡是根据互动解锁某一特定场景」）优先级高于我的代码推论。
5. **「修复已实测生效」是假阳性，最严重的一次** —— 探针直调 `build_worldbook_context`
   时**漏传 `max_context_tokens`** → 服务内回退 `DEFAULT_BUDGET=16000` →
   预算 4000 而非生产的 1024 → 我看到「5 条到位」并把它写进了交接文档。
   **真实装配当时是 0 条。** 是外部 agent 复核才抓出来的。
   ⇒ 判据：**能走真实入口（`assemble_roleplay_prompt`）就不要手工重建中间步骤；
   探针必须打印它实际收到的参数，并与生产调用点逐项对照。**
   这条已写进 `AGENTS.md`（`1017d6e`）。

**还有一条**：第 3 层我一度结论成「卡太长、物理上无解、ST 下同样失效」，
用户一句「现在的模型基本都 1M 上下文吧？再不济 128K」直接把它打回 ——
**4096 是我们自己的兜底假值**。我的"无解"结论建立在没核实的一个数字上。
⇒ 给"做不到"的结论前，先确认那个数是从哪来的。
