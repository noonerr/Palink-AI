# REPORT：MVU 提示词依从性零成本筛查 + 两项只读调研

日期：2026-09-28
施工：按 `docs/SPEC_MVU提示词依从性零成本筛查_2026-09-28.md` 全量执行（T1 筛查 + T2/T3 只读调研 + 门禁）。
备份：tag `pre-mvu-prompt-screen-20260928` + `D:\_palink_backup_20260928_mvuprompt\repo.bundle`（136MB 全历史）+ 同目录 `evidence\`（本单全部物证副本）。

---

## 0. 一句话结论

**T1 无法区分：5 变体 × 2 互不知情子模型实例 = 10/10 全部合格交单，与 V0 基线零差异**——提示词对强模型在四种结构性改动下都能照样交单，无法在零成本面上判断哪个变体能救 deepseek-v4-flash；缺的证据是付费模型对照轮（等授权）。T2 推荐方案 A 轻量版（生成收尾后台任务）+ 顺带清理孤儿函数；T3 实锤 Palink 与 ST 两处口径不对齐，全库爆炸半径 = 唯一 1 条深度窗脚本。**付费模型调用 0 次；零生产代码/提示词改动。**

---

## 1. T1 零成本筛查（主件）

### 1.1 方法与执行

- **导出**：新探针 `backend/scripts/probe_assemble_dump.py`（commit `0e499b7`，SPEC §6 允许的落点），依赖注入写法与 `probe_mvu_block_origin.py` 一致（同卡 7b064410 / 同会话 2cb171bf / `message="开始"` / `include_prompt_regex=True`），容器内跑（镜像已按 F4 先重建）。产出 4 条消息 / **19789 字符**（`backend/data/mvu_screen/prompt_dump.json|.txt`）：
  - `[0] system 510` ST 默认 main prompt；`[1] system 15159` 【当前变量状态】块（内含 2899 字符 `${new_value}` 原文模板，位于 m1[11811:14710]，F3 数字精确复现）；`[2] system 3489` World Lore；`[3] user 631` "开始"+【变量更新指令】尾。
- **变体**（字符串级改动，全部落 `variants\`，精确编辑记录见 `variants\manifest.json`）：
  - V0 原样；V1 删变量块内 `format: |-` 起至 `</UpdateVariable>` 止共 **2911 字符**（=2899 模板 + 12 字符 YAML 键行，`${new_value}`×28 全部随之消失）；V2 把用户消息尾部 605 字符【变量更新指令】整段移到末条 system（World Lore）最末，user 只剩"开始"；V3 用户消息最末追加一行硬指令"- 回复的最后一行之后必须紧跟一个完整的 <UpdateVariable> 块"；V4 消息序改为 `[0]main → [1]WorldLore → [2]状态块 → [3]user`（状态块退出开场、紧贴 user）。
  - **V4 口径备注**：SPEC 字面"移到主提示词之后（即旧布局 [1] 位）"在当前 HEAD 是**现状本身**（2204691 深度下限修复后状态块就在 [1]、紧随主提示词），照字面执行等于 V0 复制。故按该行假设文本"开场大段数据稀释了任务指令"执行为上述后置改动。若 Qoder 原意另有所指，见 manifest 记录可低成本重跑。
- **子模型实例**：每变体 2 个、V0 即对照重跑（F1 的 2/2 之外再取 2 份），共 **10 个互不知情 ZCode 子代理**（GLM-5.3-Flash，同一会话模型派生，互相不可见、不知道测试目的），指令只有 SPEC §1.1 那一句。子模型产出原样落 `out\V*_*.txt`。
  - 执行备注：ZCode 子代理并发上限=1（首批 10 并发 9 个秒失败未做任何工作），改串行后 10/10 成功；无重试、无提示词补偿。
- **机器判定**：`judge.py` 按 SPEC §1.3 四规则逐份判定，原始输出 `out\verdict.json`。

### 1.2 合格矩阵（§1.3 四规则全过才算合格）

| 变体 | 实例 a | 实例 b | 小计 | 每份 JSONPatch 条数 |
| --- | --- | --- | --- | --- |
| V0 原样 | PASS | PASS | 2/2 | 3 / 2 |
| V1 删 2899 模板 | PASS | PASS | 2/2 | 2 / 2 |
| V2 指令移系末 | PASS | PASS | 2/2 | 3 / 3 |
| V3 尾部硬指令 | PASS | PASS | 2/2 | 3 / 2 |
| V4 状态块后置 | PASS | PASS | 2/2 | 3 / 3 |

十份产出的 R1（配对标签）/R2（JSONPatch 可解析数组）/R3（逐条含 op/path 且无 `${` 占位符）/R4（正文无 `${new_value}`）**逐项全 True**，且每份都以 `</UpdateVariable>` 收尾、正文含【声音】行与 11 字 [标题]，格式纪律完好。

### 1.3 结论（§1.4 分支二：全部与 V0 无差异）

**无法区分。** V0 对照 2/2 与 F1（Qoder 侧两个较强模型 2/2）互相校准，harness 可信；四种结构性改动对强模型的依从性都没有增量收益。也就是说：

1. **提示词的"可读性"不是短板**——问题复现只在 deepseek-v4-flash 上，零成本面无法再往下切。
2. **缺什么证据**：deepseek-v4-flash 的真机（或直调 API）对照轮——把 `variants\V0..V4.txt` 逐个喂给真实生产链路 regenerate 各 1-2 次，看 `<UpdateVariable>` 出现率。这是付费调用（估 5-10 次 regenerate），**等授权**，本单一次都没跑。
3. **下一步零付费可查的静态项**（按性价比排序）：
   - **采样/预算参数审计**：生产链路对该模型实际生效的 `temperature` / `reasoning_effort` / `max_tokens`（网关 model_mapping + 用户生成预设），对照 T3 取证样本（正文 553 字 + reasoning 519 字）核对 max_tokens 预算——若预算贴地，模型可能在"起块之前"就截停（0 个 `<U` 字符更像"没起意"，截断假设列待查不做结论）；
   - **网关日志面**：new-api 侧该模型的历史调用里有没有出现过 `<UpdateVariable>` 字样（一次查询，零成本，能直接回答"从来不会"还是"偶尔会"）；
   - 若上述都平：提示词侧只剩"给 deepseek 换写法"这一类真机实验（few-shot 示例前置、把 2899 模板换成一条已填充的真实样例块等），全部需要授权真机。

### 1.4 物证位置

- 变体文件与精确编辑：`D:\_palink_backup_20260928_mvuprompt\evidence\variants\`（工作副本 `D:\_palink_mvuprompt_screen_20260928\variants\`）
- 10 份子模型产出 + 判定原始输出：`evidence\out\`（含 `verdict.json` 逐份明细）
- 提示词导出原件：`evidence\prompt_dump.json`
- 判定脚本：`evidence\judge.py`

---

## 2. T2：副 AI 兜底处置调研（只读）

### 2.1 现状事实（读码实锤）

- `_run_secondary_mvu_sync`（`websocket.py:523-573`）：同步包装，`run_coroutine_threadsafe` + **`future.result(timeout=90)`**——当年"生成完一直转圈"的痛点本体。全仓**零生产调用**（唯一调用者 `backend/scripts/_verify_secondary_e2e.py:82`）；连带 `_main_loop`（`websocket.py:632`，专为它捕获）现在也是**零消费的死捕获**。`websocket.py:755-759` 的 `[MVU-SECONDARY-MANUAL]` 注释记录了改全手动的原因。
- 手动端点 `trigger_mvu_secondary`（`character_ext.py:6124-6247`）**完全自包含**：自己查 UserSetting（:6198-6203）、自己过 schema GUARD（:6206-6212）、直调 `run_secondary_mvu`（:6215）、自己 `apply_patches`+持久化（:6228-6241）——**不 import、不调用 `_run_secondary_mvu_sync`**。
- 服务层 `run_secondary_mvu`（`mvu_secondary.py:96-171`）：自带 `timeout=60` 秒、内部 GUARD、**任何失败返回 `([], [])` 静默降级**；温度 0.2、max_tokens 2048。
- 前端手动链路在位：`Message.tsx`（消息按钮）、`CharacterChat.tsx`、`AppearanceTab.tsx`（开关）。

### 2.2 两方案对比与推荐

**推荐：A 的轻量版（生成收尾后的进程内后台任务），同时保留手动端点；孤儿函数清理（B 的安全部分）作为独立小清理随时可做。**

- **B 会失去什么**：几乎为零——手动端点自包含（见上），删 `_run_secondary_mvu_sync` + `_main_loop` 死捕获不影响任何用户可见功能。但 B **不解决痛点**：TODOS 09-28 两条真机取证（WS 1 次 + regenerate 2 次 = 3/3 无块）证明"模型自觉"这条路线在 deepseek-v4-flash 上现在就是死的，纯手动=用户每轮都要点一下。
- **A 怎么做才不炸**（要点全部有现成代码背书）：
  1. **挂点**：不放 persist_snapshot（`to_thread` 线程上下文，需跨线程提交）。放异步侧生成收尾处——WS 在 `await asyncio.to_thread(persist_snapshot)`（websocket.py:1051）返回后，SSE 四入口在各自 persist_fn 驱动完毕后——直接 `asyncio.create_task`，天然在事件循环内，`run_coroutine_threadsafe`/90s 阻塞这两个老坑整条绕开。
  2. **防重复**：每代一次（nonlocal 布尔，仿 `mvu_variables_saved`）；同会话连点 regenerate/swipe 用 per-session `asyncio.Lock`，或直接复用手动端点的"任务启动时重读最新 `chat_metadata.variables`、apply 到最新态"的 last-writer-wins 语义（character_ext.py:6184-6194），与手动兜底互不踩。
  3. **失败重试**：**不做重试队列**。服务层已 60s 超时 + 全失败路径静默返回，后台任务单次即止 + `logger.warning`，失败时用户仍有手动按钮——重试收益低、复杂度高。
  4. **DB**：任务内自开 `SessionLocal`、事务自包，绝不复用已 close 的 `save_db`。
  5. **触发条件照抄 GUARD**：force 快照解析后 mvu_logs 为空（模型没交单）+ `mvu_secondary_enabled` + `sec_model` 非空 + `extract_schema_defaults` 非空。
  6. 基建参照：`local_image_bridge.py` 的进程内任务桥（claim/complete/fail + 每用户积压上限）如需防堆积可借用，但单会话一次最多 1 个在途任务，非必需。
- 本单**未动任何代码**，以上是设计候选。

---

## 3. T3：正则深度窗口径调研（只读）

### 3.1 ST 权威口径（`D:\SillyTavern-release` 源码行号）

1. **深度基数 = 聊天历史（滤掉 system）**：`public/script.js:4441-4447`（Generate 主链）——`coreChat = chat.filter(x => !x.is_system || ...)`，提示词路径对每条历史消息 `depth = coreChat.length - index - (isContinue ? 2 : 1)`（末条=0）。**system 类消息被过滤出这个数组，根本不进提示词正则**；placement 只有两分法 `is_user ? USER_INPUT : AI_OUTPUT`。
2. **深度闸**：`extensions/regex/engine.js:363-371`——`depth < minDepth` 或 `depth > maxDepth` 即跳过该脚本（仅当调用方传了 depth）。
3. **世界书单独一路**：`world-info.js:5085-5086`——WI 条目正文走 `WORLD_INFO` placement，depth 只对 `atDepth` 位条目传**条目自身注入深度** `entry.depth`，其余传 `null`（深度窗不适用）。
4. 枚举：`engine.js:285-291`（USER_INPUT=1 / AI_OUTPUT=2 / WORLD_INFO=5 / REASONING=6，4=legacy sendAs）——与 Palink `character_ext.py:808-813` 常量值一致。

### 3.2 Palink 现状与两处不对齐（`character_ext.py:1603-1636`）

- `depth = max(0, total - 1 - index)` 作用在**整份装配结果**（main prompt / 变量块 / World Lore 这些 system 消息全算进基数）——ST 的基数只有聊天历史。
- system 消息归 `REGEX_PLACEMENT_USER_INPUT(1)`（:1630-1636）——ST 里 system 类内容不进 USER_INPUT/AI_OUTPUT 正则，WI 内容另有 placement=5 专用通道。

**方向性后果（不对称点）**：真 ST 里，本卡「[不发送]去除变量更新」（placement `[1,2]`，无 WORLD_INFO）**从来打不到世界书内容**；Palink 把 WI 来源的变量块当 system→USER_INPUT(1) 送进了它 placement=[1,2] 的射程——今天只靠 minDepth=4 挡着（当前 depth=2）。哪天有人把 minDepth 调小，两边行为会彻底分叉。

### 3.3 "改装配尾部→深度窗整体漂移"的具体后果（实例在案）

身份层 T2 砍尾部（total 6→4）让所有消息深度 -2：唯一深度窗脚本 minDepth=4 从命中（旧布局块 depth=4，模板被删，块 12260）变跌出窗口（块 depth=2，模板回归，15159）——即已结案的 **2899 字符差**（`docs/调查_MVU变量块2899字符差成因_2026-09-28.md`）。这类"改 A 处、B 处静默变"耦合已登记 TODOS 遗留 3；today 的爆炸半径见 3.4。

### 3.4 影响面实查（库内实查，非猜测）

- `characters.extensions.regex_scripts`：5 张卡带脚本（同名卡「我被猫娘包围了！」5 个副本，各 6 条）。
- **全库唯一带深度窗的脚本 = 「[不发送]去除变量更新」**：`minDepth=4`、`maxDepth=空`、`placement=[1,2]`、`promptOnly=true`、`findRegex = /<UpdateVariable>(.*?)<\/UpdateVariable>/gis`（×5 副本）。
- `plugin_scripts` 表 2 条，均无深度窗。
- 其余 5 条脚本：4 条 `markdownOnly=true`（不进 prompt 路径）、1 条「[不发送]界面占位符」promptOnly 且 placement=[2]（system→1 映射不影响它）。

### 3.5 对齐方案候选（只列不改）

- **C1（推荐，ST 忠实）**：装配结果分桶——聊天消息（user/assistant）子序列上算 depth（对齐 coreChat）；system 消息不做 USER_INPUT/AI_OUTPUT 的 prompt 正则（对齐 script.js 过滤）；WI 来源内容如需保留正则，走 placement=WORLD_INFO 独立一遍、depth 用条目自身注入深度（对齐 world-info.js）。影响面：唯一深度窗脚本从"打变量块"变为"只打聊天层 <UpdateVariable> 块"（其 promptOnly 语义在 ST 本就指向聊天层）；其余脚本行为不变。实施前需一次装配报告前后比对（含 worldbook_depth 注入消息的归属确认）。
- C2（WI 来源深度版）：system 消息保留正则但改用注入深度元数据——装配层要传元数据，改动大，且 main prompt 等无来源 system 仍无 ST 对应物。不推荐。
- C3（只换深度基数、保留 system→USER_INPUT 映射）：混合口径，语义更乱。不推荐。

---

## 4. 门禁

- **镜像先行**（F4）：`docker compose build backend && up -d` 后 healthy，`tests/test_local_image_bridge.py` 收集正常。
- **后端**：容器内全量 `pytest tests/ -q` = **1494 passed / 42 skipped / 0 failed**（284s）。比 SPEC 基线 1468 多 26 例 = 并行会话已入库的 local_image_bridge 22 例 + 工作树未提交的 image_proxy 13 例等，**零失败**。
- **前端**：`npx tsc --noEmit` = 0 错（本单未碰前端）。

## 5. 自陈：动了 §4 之外的什么

1. `backend/scripts/probe_assemble_dump.py` 新增并**单独 commit `0e499b7`**（SPEC §6 明文允许的探针落点，只读装配零模型调用）。
2. `git tag pre-mvu-prompt-screen-20260928` + `repo.bundle`（§5 备份动作）。
3. `backend/data/mvu_screen/`（gitignored 数据目录）探针 dump 输出。
4. `D:\_palink_mvuprompt_screen_20260928\`（仓库外工作目录）与 `D:\_palink_backup_20260928_mvuprompt\evidence\`（仓库外物证归档）。
5. 本报告 `docs/REPORT_MVU提示词依从性零成本筛查_2026-09-28.md` + TODOS.md 登记条目。

**没动的**：任何生产代码/提示词/装配链/正则逻辑（T1 只产出候选文本）；付费模型（**调用 0 次**）；会话残留消息 2365-2368；Qoder 侧 5 份未跟踪文档（git status 原样）；其他会话的未提交产物（api/__init__.py 等）。
