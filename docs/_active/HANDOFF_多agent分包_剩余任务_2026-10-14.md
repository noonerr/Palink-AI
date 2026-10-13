# 多 Agent 分包：剩余任务提示词

> 用法：每个任务的提示词**整段复制**，分别发给不同 agent。**第一波三个任务可同时发**（文件零重叠），后续波等前一波完工。
> 分包原则：**文件不重叠 + 各自开分支 + 禁危险 git 操作 + 公共文件只由主控改**。
> 日期：2026-10-14｜分支 `three-tracks-merge-20261012`｜当前 HEAD `52d1755`｜tag：`merge-base`、`s1-done`
> 门禁现值：vitest **958 passed / 1 failed / 3 skipped（962）**；tsc 0。唯一红 = `storage-isolation-contract.test.ts:221`（S2 的设计信号，S2 未做完前必须保持红）。

---

## 一、任务分级与模型匹配

| 档 | 任务 | 改什么 | 风险 | 推荐模型 |
|---|---|---|---|---|
| **甲1** | backend 内存老账静态排查 | 只读 `backend/`，产出 1 份新报告 | 结论错判会误导后续 | **Step5 或我**（要跨文件推理 + 谨慎下结论） |
| **甲2** | 消息窗口化 | 3 个渲染点 + 滚动位置 | 高（红线 3 条，会改到"显示哪些消息"） | **Step5 或我**（要设计权衡） |
| **甲3** | S3 切换默认 | 默认执行路径 + 真机验收 | **最高**（改默认行为） | **你手上最强的那个** |
| 乙1 | S2 存储迁移 | `storage.ts` + `card-script-storage.ts` | 中（模式明确但要守"只加不删"） | Hy4 / Step5 |
| 乙2 | S4 拆大文件 | `SillyTavernCompatRuntime.ts` / `legacy-st-sim.ts` | 中（机械，但踩模板字符串雷区会很痛） | Hy4 / Step5 |
| 丙1 | 只读现状盘点 + G9 测量 | 只读，产出 1 份新报告 | 零 | **DeepSeek V4.1 Flash**（省额度） |

**模型使用原则**：
- **DeepSeek V4.1 Flash 只配干只读/机械活**，且必须有强模型或你本人复核它的结论 —— 它偶发空响应，且这次的教训（我判错过一次 API 契约）说明"看着合理的推断"最容易错。
- **甲3（S3）必须用最强模型**：它改默认行为，错了直接影响所有用户，且要真机验收 3 张卡 + 5 个插件。
- 甲2 目前**卡在你拍板**（做不做 / 默认显示几条 / 按钮还是自动），拍板前别发。

---

## 二、通用前缀（每个提示词都要原样贴在最前面）

```
你在 D:/项目/Palink-AI 上工作，分支 three-tracks-merge-20261012，当前 HEAD 52d1755。

⚠️ 本机同时有多个 agent 在不同任务上干活。为防止互相影响，以下规约**必须遵守**：

【分支隔离】
1. 第一步就执行：git checkout -b <你的任务slug>   （例如 s2-storage-migration）
2. **禁止**：git checkout / switch 到别的分支、git pull / fetch / rebase / merge / reset --hard
   —— 你要的代码当前工作区已经有，动 git 历史会毁掉别人的进度。
3. 完工后**不要 merge**，留在自己分支上等主控统一合。

【提交纪律】
4. 提交一律 git commit -o -- <pathspec>（-o = 只提交指定文件）。不用 -o 会把别人暂存的内容吞掉。
5. 禁止 git add -A、禁止 git stash（尤其 stash -u，本机会被杀且会留损坏的 .git）。
6. 未跟踪的新文件先 git add <该文件>，再 commit -o。

【文件边界】
7. 只改本任务「你能改的文件」清单里的文件。清单外的一律不碰，包括看起来相关的。
8. **不准改这些公共文件**（改了必冲突，由主控统一维护）：
   - TODOS.md
   - docs/_CATALOG.md（也**不要**跑 py scripts/docs/gen_docs_catalog.py）
   - .workbuddy/ 下任何文件
   - docs/_active/report/ 和 docs/_active/HANDOFF_ 下**别人**的文档
   ⇒ 你的产出文档请新建，命名带你的任务slug，例如 docs/_active/report/REPORT_<slug>_2026-10-14.md
9. 你的新文档入库时**不要**重新生成文档目录（会和别人的生成结果冲突）。

【验证纪律】
10. **不要跑全量门禁**（npx vitest run / pytest 全量 / tsc 全量），会和别人抢机器导致数字不可信。
   只跑你改动直接相关的测试文件，例如：
   npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/<你的测试文件>.ts
   必须跑 npx tsc --noEmit 时，接受它可能因为别人的未提交改动而报错，别去"修"不是你引入的错。
11. 门禁基线（供参考，不是你造成的）：958 passed / 1 failed / 3 skipped；唯一红是
   storage-isolation-contract.test.ts:221，那是 S2 的设计信号，**不是 bug，不要修它**。

【本机环境坑（会让你命令静默失败）】
12. python/python3 是微软商店空壳，一律用 py。
13. git 重型操作会被 SIGKILL：git fetch / clone / stash -u / 整树 tar 全中招，且 stash -u 被杀会
    永久损坏 .git。分支出仓只用 git bundle create（安全，1秒）。
14. 控制台中文输出是 GBK，判定只认 ASCII 结构化行和退出码。
15. curl 用 /c/Windows/System32/curl.exe，访问本机服务加 --noproxy '*'（Clash 拦 localhost）。

【红线（违反即返工）】
16. 不按文件名删任何东西，删前先 grep 全仓消费链。名字带 st_ 不等于要删。
17. SillyTavernCompatRuntime.ts / legacy-st-sim.ts / api/silly_tavern.py 只拆不改语义。
18. legacy-st-sim.ts 里禁止出现反引号和 ${（整文件是模板字符串，踩了报 TS1005 且报错指向注释行，
    极易误判成配置坏）。正则一律 new RegExp()。改完跑 node scripts/verify-shim-identity.mjs。
19. 不改后端接口语义、不改正则管线、不动提示词装配链 roleplay_prompt_assembly.py。
20. 不要动 frontend/dist、backend/data、根级 图片/ 记忆/、两个 mp4。
```

---

## 三、第一波（三个任务文件零重叠，可同时发）

### 甲1 — backend 内存老账静态排查（只读，零写入风险）

```
【你的任务slug】be-oom-static
【任务性质】只读排查 + 产出一份报告。**不许改任何生产代码。**

【背景】TODOS.md「[进行中] Palink 本体无限加载排查（backend 内存飙升卡死）」，2026-08-19 挂到现在。
已确认事实：
- 现象：前端登录页/主界面无限加载；/api/auth/config 反复 499；backend 不响应 /health
- 实锤：backend 内存飙到 1.975GiB/2GiB 卡死，事件循环阻塞，只能重启（重启后 177MB）
- 时间线：backend 重建(19:08) → 导入角色卡(19:15:04) → WebSocket 连接+StreamSession(19:15:28)
  → tokenizer 下载超时(19:15:40) → backend 卡死 → 重启恢复(19:24)
- 已排除：tokenizer 下载（后台线程）、Ollama embedding、本地 GGUF、sentence-transformers
- 交接单：docs/_archive/handoff/HANDOFF_Ollama部署与无限加载排查_2026-08-19.md
- 监控脚本（待修）：backend/scripts/_monitor_backend.py

【两条我认为没排除干净的线索，请重点查】
1. 「tokenizer 下载超时」只排除了"后台线程"，但**超时本身**可能触发重试风暴/连接堆积，没查过。
2. **WebSocket + StreamSession 完全没被排除**，而从导入角色卡到卡死只有 36 秒，这条链最可疑。

【你要做的】
1. 静态读代码，只聚焦这条链：导入角色卡 → WebSocket 连接 → StreamSession → 卡死。
   找：未关闭的连接/会话、无上限的缓存或队列、循环里累积的大对象、异常分支没释放资源。
2. 给出**带 file:line 的可疑点清单**，按可疑度排序，每条写清"为什么会吃内存"和"怎么验证"。
3. 明确指出哪些是"已证实"、哪些是"疑似"、哪些"查不到需要复现"——**不许把疑似写成结论**。
4. 报告写到 docs/_active/report/REPORT_be-oom-static_2026-10-14.md
5. 附一节「复现时需要抓什么」：容器内怎么抓线程栈 / 内存快照（给具体命令），供将来真机复现用。

【验收】报告含可疑点清单（带 file:line）+ 真伪分级 + 复现抓取方案。零生产代码改动。
【注意】Docker 当前没跑，你**不要**尝试启动 Docker 或真机复现，只做静态分析。
```

### 乙1 — S2 存储迁移（B1 转绿）

```
【你的任务slug】s2-storage-migration
【任务】把智能卡存储从旧键迁到新键，让 storage-isolation-contract.test.ts:221 转绿。

【关键约束：只加不删】
- 只允许「读新键 → 无则读旧键 → 写新键」，**绝不准删旧键**
  （要保证切回开关后旧键仍完好，这是回退完整性要求）。
- 旧键前缀：palink:card-storage:v1:（定义 lib/sillytavern/card-script-storage.ts:24）
- 新键前缀：palink:smart-card-storage:v1:（定义 smart-card-runtime/storage.ts）

【B1 转绿判据（本步骤的完工信号）】
storage-isolation-contract.test.ts:221 断言 storage.ts 源码里必须出现旧键前缀字面量。
S2 实现后它自动转绿。⚠️ 如果你做完了它还红，说明实现里没出现这个字面量，去查实现位置，
**不要改测试**。⚠️ 反过来说，除这条外 failed 必须为 0。

【你能改的文件】
- frontend/src/components/ui/custom/smart-card-runtime/storage.ts
- frontend/src/lib/sillytavern/card-script-storage.ts
- frontend/src/lib/sillytavern/card-idb-namespace.ts（如需）
- 可在上述目录 __tests__/ 下新增你自己的测试文件（命名带 s2）

【不准碰】任何渲染组件、Message.tsx、CharacterChat.tsx、SillyTavernCompatRuntime.ts、
legacy-st-sim.ts、TODOS.md、docs/_CATALOG.md、.workbuddy/、别人的文档。

【验收】
1. B1 转绿，其余 failed = 0
2. 新增一条测试钉住「旧键不被删」（迁移后旧键原样存在）
3. 补一条测试：无新键时能读到旧键的值
4. 跑：npx vitest run <你新增/相关的测试文件> + npx tsc --noEmit
```

### 丙1 — 只读现状盘点 + G9 测量（适合 DeepSeek V4.1 Flash）

```
【你的任务slug】ro-survey
【任务性质】**纯只读**，只产出一份报告，不许改任何文件（包括新建生产代码）。

【背景】三轨并一轨工程，S0/S1 已完成，S2-S5 未做。需要一份准确的现状盘点，并测一个数。

【你要做的】
1. 盘点当前实际状态，逐项给证据（commit hash / tag / 测试文件名）：
   - git log --oneline -20、git tag -l "*s?-done*"
   - 六步各自状态：S0 备料 / S1 补功能 / S2 存储迁移 / S3 切换默认 / S4 拆单间 / S5 删大堂
   - 已知缺口 G2/G4/G7/G8/G9 各自当前状态（去 docs/_active/ 下找最新报告交叉核对）
2. **测一个数（这是本任务最重要的产出）**：
   frontend/src/utils/sillyTavernPluginRuntime.ts 共约 2477 行。
   请测出其中「大堂轨注入段」（会被 S5 删掉的那部分）占多少行、占百分之几。
   方法建议：找出 S5 要删的函数/段落边界，算行数；说明你的切分依据。
   如果测不出来，明确说"测不出 + 为什么"，**不要编数字**。
3. 报告写到 docs/_active/report/REPORT_ro-survey_2026-10-14.md

【验收】六步状态表（带证据）+ G2/G4/G7/G8/G9 状态 + 大堂轨注入段行数占比（或明确说测不出）。
【铁律】没有证据的一律写"未核实"，不许推测填空。你的结论会被强模型复核，错了要返工。
```

---

## 四、第二波（等第一波完工后再发）

### 甲3 — S3 切换默认（**必须用最强模型**，且要真机）

```
【你的任务slug】s3-switch-default
【前置】必须等 S2 完工且 B1 已转绿。开工前先 git log 确认 S2 的提交已在。

【任务】把默认执行路径切到单间轨，并按方案验收标准逐项验。

【必须做：kill switch 真机验证】
现有两个开关（代码在、单测覆盖，但真机验证状态以最新报告为准，先去 docs/_active/ 查）：
- lib/sillytavern/card-script-runner.ts:34  CARD_SCRIPT_KILL_SWITCH_KEY='palink_card_tavern_helper_scripts'
- lib/sillytavern/card-idb-namespace.ts:45  IDB_NS_KILL_SWITCH_KEY='palink_idb_namespace'
真机验证"切回旧执行有效"，留现场日志与截图证据。Docker 需要先启动（docker compose up -d）。

【验收标准（方案原文）】
1. 3 张代表卡（图鉴卡 / 变量卡 / 纯 HTML 卡）切换前后逐项一致，**旧解锁状态保留**
2. 5 个真实插件功能可用率 ≥95%（st-plugins/ 下先确认存在）
3. 50 条智能卡消息会话：首屏/滚动/内存劣化 ≤15%（对照 S0 基线，见档案 §6.1）
4. 故意抛错的卡脚本不影响其他消息与页面
5. 所有静默失效落降级统计且插件管理页可见
6. kill switch 有效

【红线】切换必须可回退；保留开关到下一个版本；打 tag s3-done。
【注意】真机验收涉及真实数据，动手前先确认 D:\项目\_palink-s0-20261012\ 里的备份还在。
```

### 甲2 — 消息窗口化（**需先拍板**：做不做 / 默认几条 / 按钮还是自动）

立项依据在 TODOS.md「[未开工·建议] 消息窗口化」，ST 源码证据在 `.codex/st-source/script.js`：
12570 行 0 处 iframe；`:1478` 默认只渲染最后 N 条 + 顶部 Show more 按钮；`:1435` 点按钮只往前追加、已渲染的不删。

【任务】默认只渲染最后 N 条（建议 40，做成用户设置项），顶部"显示更早的 N 条"按钮，点一次往上追加一批，**已渲染的一律不销毁**。

【红线（动工前必读）】
① 窗口只能作用于**渲染**：正则 / 提示词装配仍须按**全量聊天**算（本仓有"深度按距末尾距离算"的事故，
   改尾部结构会让带深度窗的脚本整体漂移，"改 A 处、B 处静默变"）
② 已渲染消息**不允许**因滚动销毁（否则苹果手机那个坑原样回来）
③ 三个渲染点都要改 + 滚动位置保持：CharacterChat.tsx / ChatViewMobile.tsx / ChatViewDesktop.tsx
   （现状 CharacterChat.tsx 的 displayedMessages 是全量渲染，无分页）
④ 不推荐虚拟列表（回收式）：同样销毁重建，且我们重建成本是 884KB，比 ST 更不该做

【连带收益】落地后 G8（苹果手机档位）可直接关掉 —— 产生那个坑的机制整个消失。

---

## 五、第三波（S3 完工后）

### 乙2 — S4 拆大文件

【任务】把单间轨超大文件拆到单文件 ≤1200 行。

⚠️ **先确认 G4 门禁范围**：「单文件 ≤1200 行」若按整个 frontend/src 字面执行，当前已有 14 个文件超限
且多数与并轨无关（sandbox.ts 5612、ModelManagementTab.tsx 1973 等）。**没拍板就别拆无关文件。**

【拆谁】SillyTavernCompatRuntime.ts（约 6984）/ legacy-st-sim.ts（约 2480）。
⚠️ `sillyTavernPluginRuntime.ts`（约 2477）**先别拆** —— G9 存疑：S5 可能要删它的大堂注入段，
拆完再删 = 白做。等丙1 测出占比再定。

【最大风险】模板字符串雷区：SillyTavernCompatRuntime.ts 全文约 44 个反引号 / 26 个 `${`，
新增注释或代码出现反引号 / ${ 会提前终止模板 → TS1005，且 vitest 配置都加载不了。
拆完必跑 npx tsc --noEmit + 相关 vitest。改 legacy-st-sim.ts 必跑 verify-shim-identity.mjs。

【硬要求】只拆不改语义。

### 甲3' — S5 删大堂（**风险最高，用最强模型**）

【前置】S2 + S3 + S4 全完工。

【删除面前必须 grep 消费链（已核实的，动之前重新确认）】
- emitClassicPluginEvent：CharacterView.tsx:28 / :1645 ← 角色页，不在聊天页，最容易漏
- lib/sillytavern/card-script-runner.ts：CharacterChat.tsx:36-40
- 同页 :44 card-script-storage-sync、:48 st-third-party-globals

【这 7 个测试文件必须随迁不许随删】
lib/sillytavern/__tests__/card-script-runner.test.ts、card-script-storage.test.ts、
card-script-bridge-write-degradation.test.ts
utils/__tests__/plugin-runtime-diff-hotswap.test.ts、plugin-runtime-extprompt-contract.test.ts、
plugin-runtime-l1-settings.test.ts、plugin-runtime-setup-script-parses.test.ts

【窗口化留下的两个文件】若消息窗口化已落地，InlineCardRenderer.tsx 与
smart-card-runtime/inline/inline-script-replay.ts 可一并处理（InlineCardRenderer.tsx:41 有 import，
删 replay 必须同步处理它，否则 tsc 悬空）。

【要求】删码 commit 单独一笔。打 tag s5-done。
【验收】门禁绿 + grep 确认无悬空引用 + 方案验收标准 4/5/6。

---

## 六、主控（你或我）统一收口清单

各分支完工后，由主控按顺序做，**不要让 agent 互相 merge**：

1. 逐个 review 分支 diff（重点看有没有越界改公共文件）
2. 合并顺序：丙1（只读，随时可合）→ 乙1（S2）→ 甲3（S3）→ 乙2（S4）→ 甲3'（S5）→ 甲2（窗口化，若立项）
3. 每次合并后跑一次全量门禁，确认 failed 数只减不增
4. 统一更新 TODOS.md / docs/_CATALOG.md / .workbuddy/memory/
5. 更新分支 bundle：`git bundle create "D:/项目/_palink-s0-20261012/palink_three-tracks-merge_20261013.bundle" three-tracks-merge-20261012`
6. 按进度补 tag：s2-done / s3-done / s4-done / s5-done
