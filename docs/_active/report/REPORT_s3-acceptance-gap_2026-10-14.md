# S3 验收补测报告（s3-acceptance-gap）

> 执行：S3 补测 agent（2026-10-14 08:03–09:43，主工作区串行）
> 复核：主控（2026-10-14 13:41 起）——**本报告所有数字均经主控独立复核**：
> 重跑脚本、读源码、查数据库、核对留底 JSON，不采信转述。
> 分支 `s3-acceptance-gap`（= 578dd80，与主分支同点，**零代码改动**，只新增本报告）。
> 证据留底：`D:\项目\_palink-s0-20261012\`（含自备库备份 `pre-acceptance-gap_20261014_0808.sql`）。

## 结论摘要

| # | 验收标准（任务书原文） | 结果 | 一句话结论 |
|---|---|---|---|
| 1 | 5 个真实插件端到端可用率 ≥95% | ❌ **未通过** | 注册 5/5 成功，但启用后 **5/5 全部语法错误无法运行**，端到端可用率 **0/5**；根因是兼容 runtime 的 import 变换与 wrapper 参数表撞名（既有缺陷，非 S3 回归） |
| 2 | 降级统计在插件管理页可见 | ✅ **通过** | 总闸置 1 后 `__palinkCompatStats` 落 1 条记录，插件管理页卡片**确认渲染可见**（有截图） |
| 3 | 三张代表卡旧解锁状态保留（扩样本） | ✅ **通过（限首次迁移）** | 种子迁移逐值比对 **15/15 PASS**、既有状态 **18/18**；覆盖 2 个真实解锁键 + 3 个探针种子键；三卡分类复核属实 |

**总判定：三项验收 2 过 1 不过。任务 1 不过，但不过的方式是"发现了真 bug"而非"没测"** ——
补测第一次让真实 ST 扩展插件进入 Palink 执行链，立刻暴露出兼容层缺陷（详见 §2）。
另核出 **3 项转述未提及的新发现**（§5），其中 MVU 世界书读取失败建议立项跟进。

**S5 前置评估**：任务书要求"补测是 S5 阻塞项"。现状 = 验收标准 2/5 已补齐、
标准 1 明确失败。S5 删大堂前需主控决策：是接受"已知缺陷 + 总闸兜底"放行，
还是先修 §2 的 wrapper 撞名 bug。**本报告不代拍板**。

---

（以下各节为详细证据：§1 验证方法 §2 任务1 §3 任务2 §4 任务3 §5 新发现 §6 证据索引 §7 后续建议）

## 1. 验证方法（主控复核口径）

| 手段 | 覆盖 |
|---|---|
| 重跑 `_verify_wrapper_collision.mjs`（Node 复刻，只读） | 任务 1 的 5 条 SyntaxError |
| 逐行比对复刻脚本与 `SillyTavernCompatRuntime.ts` 真实源码（wrapper 1896 行 / import 变换 1850-1858 行 / 辅助函数 1786-1814 行 / 执行标记 1880-1912 行） | 复刻保真度 ⇒ Node 结论可外推到浏览器 |
| 读 `executeSlashCommandCompat`（5843-5916 行） | 触发器"假通过"判定（未注册命令 `return ''` 不抛错） |
| 直查 PostgreSQL（`plugins` / `world_books` / `world_book_stages` 表） | 测试插件残留现状、MVU 世界书存在性 |
| 解析 `characters_all.json` / `char_full_*.json` | 三卡分类（名称/脚本/regex/完整度） |
| 重读 seed 比对脚本 + 输出、15 项探针 JSON、控制台日志、截图 | 任务 2/3 全部数字 |
| `git log -L` 追溯冲突代码引入提交 | 回归归属 |

门禁说明：本分支相对主分支**零代码改动**（`git diff three-tracks-merge-20261012..s3-acceptance-gap` 为空），
按任务书"若改了 src 才跑 vitest/tsc"的条款，无需重跑门禁。

## 2. 任务 1：5 插件端到端 —— ❌ 未通过（0/5 可用）

### 2.1 验了什么 / 怎么验的
- 注册：`_acceptance_gap_register.py` 把 st-plugins/ 下 5 个目录打包（zip 留证 `_ext_zips/`）POST 到 `/api/plugins/import`；
- 默认态探针（`_probe_s3_plugins_default.js`，08:28）：卡 c28061bb 页面，采主页面注入态 + 卡内 iframe 执行态；
- 启用态探针（`_probe_s3_plugins_enabled.js`，08:37）：先经允许单（allowlist）启用 6 个插件再采；
- 主页面总闸探针（`_probe_s3_plugins_mainpage.js`，08:50）：kill switch 置 1 的对照态；
- 语法复刻（`_verify_wrapper_collision.mjs`）：复刻 runtime 的 import 变换 + wrapper，Node 解析验证。

### 2.2 结果（全部经主控复核）

**注册：5/5 成功**（HTTP 200）：Quick Replies / Chat Translation / Token Counter / Summarize / Regex，
均为 `sillytavern_extension` 型、`user_id=null`（全局测试数据）。

**默认态：0/5 执行**。主页面 `pluginHostExists=false`（S3"默认不注入"✅ 生效）；
卡内 iframe 仅酒馆助手（tavern_helper 型）执行，5 个扩展插件 `enabled=null`（不在允许单即不执行）。

**启用态（允许单显式启用后）：5/5 被注入，但 5/5 语法错误**：

| 插件 | 导入语句（源码原文） | Node 复刻结果（主控重跑一致） |
|---|---|---|
| quick-reply / translate / regex | `import { …, eventSource, … } from '…/script.js'` | `SyntaxError: Identifier 'eventSource' has already been declared` |
| token-counter / memory | `import { getContext } from '…/extensions.js'` | `SyntaxError: Identifier 'getContext' has already been declared` |

**根因（读真实源码确认，非推测）**：
`normalizeStPluginScriptSourceCompat` 把命名 import 变换为 `const <名> = window.__palinkStModuleImport(...)`
前置插入（`SillyTavernCompatRuntime.ts:1850-1858`），而 wrapper 参数表同样持有这些名
（`:1896` `async function(window,document,SillyTavern,getContext,extension_settings,TavernHelper,eventSource)`）
⇒ 同一函数作用域内 `const eventSource` 与参数 `eventSource` 重复声明 ⇒ 整段脚本解析失败。
主控已逐行确认 Node 复刻与真实代码一致（wrapper、变换、两个辅助函数均无差异），
故该结论对外推浏览器有效。

**"已执行"是假信号（读代码确认）**：`__palinkExecutedStPlugins[key]=true` 在注入**前**设置（:1882），
`st_plugin_script_executed` 诊断在注入**后**无条件发送（:1907）——两者都不代表脚本运行成功。
探针里 `pluginIdExecuted: true` 仅说明"注入过"。

**功能面全败（与语法错误互相印证）**：
- `slashCommandCount=0`、`slashOf` 全 false——斜杠命令一条都没注册；
- 挂载容器（qr_container 等）在卡内 iframe **不存在**；
- 4 个触发器 `/count` `/translate` `/summarize` `/regex` 全部 `ok:true` 但**返回空串**——
  经读 `executeSlashCommandCompat`（:5915）确认：未注册命令静默 `return ''` 不抛错，
  **这是假通过**，不能作为"插件可用"的证据。

⇒ **端到端可用率 0/5，距 ≥95% 验收标准差 95 个百分点。任务 1 未通过。**

### 2.3 回归归属：既有缺陷，非 S3 回归
`git log -L` 追溯：冲突两行（wrapper :1896 / import 变换 :1855）最早可见提交为
`7d5dea1`（2026-08-17"git 对象丢失后整树恢复"基线）——**早于并轨工程全部工作**。
该缺陷此前从未暴露的原因：史上没有把真实 sillytavern_extension 插件注册进实例并执行过
（补测前全实例仅 1 个 tavern_helper 型插件）。S3 把卡脚本默认改道 iframe 只是让这条
既有路径变成默认路径，缺陷本身不是 S3 引入的。

### 2.4 环境现状（需主控决策）
5 个测试插件**仍注册在生产库**（`plugins` 表，created 2026-10-14，enabled=t，全局）。
任务书要求"必须可回退、记录怎么删"——注册侧已完整留证（脚本+zip+结果 JSON），
但**删除尚未执行**。且由于 §2.2 的缺陷，它们留着也跑不起来，不影响现网行为；
删不删请主控拍板（删除路径：按 plugin id 调插件删除 API，5 个 id 见 §6）。

## 3. 任务 2：降级统计在插件管理页可见 —— ✅ 通过

### 3.1 验了什么 / 怎么验的
- Phase A（`_probe_s3_stubstats.js`，09:01）：经 addInitScript 把总闸
  `palink_st_plugin_main_page_injection` 置 1（恢复大堂注入）⇒ 制造静默失效场景 ⇒
  读 `window.__palinkCompatStats` + 导航到 /settings 插件管理页抓取渲染结果，并截图；
- Phase B（`_probe_s3_stubstats_default.js`，09:03）：清空 localStorage 回默认态，
  确认"无数据源时不应有展示"；
- 另有一次干净的默认态复采（`_probe_s3_stubstats_default_out.json`，settings 页直采）。

### 3.2 结果（经主控复核 JSON + 截图）
- **Phase A 通过**：`__palinkCompatStats` 落 1 条记录——
  `getGlobalWorldbookNames` / count=1 / "Palink 暂不支持世界书全局绑定"；
  插件管理页"ST 兼容层降级统计"卡片**确认渲染**：
  标题在、卡片在、行数据在（`mesPalink 暂不支持世界书全局绑定1 次`）。
  截图实锤：`_evidence_stubstats_card.png`（主控已阅，页面清晰显示该条统计与 1 次计数）。
- **Phase B 通过（无数据源 = 无展示）**：默认态 `stats.defined=false`、卡片不渲染、rows 为空。
  Phase B 探针本身有导航类报错（清 localStorage 后跳登录页，evaluate 上下文被销毁），
  但结论由另一次干净的默认态直采独立佐证，不受影响。
- 附证：插件管理页同时正常展示 Regex / Summarize 等已注册扩展卡片。

⇒ **验收标准 2 补齐：recordStubHit → 落库 → 管理页展示链路真机打通。**

## 4. 任务 3：三张代表卡旧解锁状态保留 —— ✅ 通过（限"首次迁移正确"）

### 4.1 验了什么 / 怎么验的
- 种子迁移（`_probe_s3_storage_seed.js` + `_probe_s3_storage_seed_compare.py`，09:18–09:24）：
  向三张卡的 localStorage/sessionStorage 写入种子旧键（含 2 个真实解锁键 + 2 个进度种子 + 1 个 session 种子），
  触发首次迁移后，对**旧键 vs 新桶逐值字节比对** + 不串桶 + 旧键原地保留三项判定；
- 既有状态比对（`_probe_s3_storage_compare.js`，09:13–09:26）：不写种子，直接比对现网既有旧键与新桶；
- 分类核对：解析 `characters_all.json` 与三份 `char_full_*.json` 全量导出。

### 4.2 结果（全部经主控复核）
- **种子迁移 15/15 PASS**（3 卡 × 每卡 4 local 旧键 + 1 session 旧键）：
  逐值字节一致 15/15、不一致/缺失 0、串桶 0、旧键丢失 0。
  覆盖键：`tavern_cg_album_unlocked`、`tavern_cg_album_pos_v2`（两个真实解锁/进度键）
  + `__probe_seed_unlocked_1`、`__probe_seed_progress_2`、`__probe_seed_session_1`（探针种子）
  ⇒ 样本量从 S3 那轮的 1 个键扩到 5 个键/卡，满足"别只验 1 个键"的任务要求。
- **既有状态 18/18**（3 卡 × 2 个真实旧键 × 3 个 localStorage 型新桶）。
- **三卡分类复核属实**：

| 卡 | 名称 | 卡脚本（tavern_helper.scripts） | regex | 数据完整度差异 |
|---|---|---|---|---|
| c28061bb | 露缇雅1.2 | 3：MVUbeta / 露缇雅变量结构 / 相册（全 enabled） | 6（名单三卡一致） | description 508 字，first_mes 1588 字 |
| 7a3a5dfc | 露缇雅1.2 | 3：同上 | 6 | description 0，first_mes 2387 字 |
| c44f2ae6 | 露缇雅1.2 | 3：同上 | 6 | description 0，first_mes 2387 字 |

- 按任务书提醒，**双写窗口（大堂轨后续增量不同步）未被当作新 bug 上报**——它是 S3 已真机复现的已知事实，
  本任务只验"首次迁移正确"，该口径内通过。

⇒ **验收标准 3 补齐。**

## 5. 新发现（补测转述未提及，主控核出）

### 5.1 🔴 MVU 读取角色世界书失败（建议立项）
默认态探针控制台 14 次报错：
`[MVU]读取角色卡配置失败 Error: 无法读取角色世界书"露缇雅1.2"`，
堆栈为 CDN 加载的 MVUbeta bundle 自身抛出（`Ar.init → Ar.reload → Cr`），
并伴随 `Character smart card error` 与卡内未处理异步错误。
主控定性核查：
- **不是数据缺失**：三卡在 `world_books` 表各绑一本"露缇雅1.2"，`world_book_stages` 三本合计 57 条（非空）；
- **不是 S3 回归**：该错误在 10-14 06:59（S3 合并前的旧 dist 会话）已大量出现（252 次），
  S3 新 dist 会话（07:19 / 07:32 / 08:28）持续存在；
- ⇒ **既有功能缺口**（iframe 轨世界书读取链路，MVU 拿得到书名、读不到内容）。
  S3 自验收报告曾将其归为"测试角色世界书缺失等已有环境噪声"——对这三张卡该定性不准确。
  不影响本次三项验收判定，但会让变量系统初始化失败，**建议单独立项**排查
  （第一嫌疑：iframe 内世界书内容读取 API 的名字→id 解析或内容下发环节）。

### 5.2 🟡 5 个测试插件残留生产库
见 §2.4。注册可回退性已留证，删除未执行，待主控拍板。

### 5.3 🟢 插件管理页对已注册扩展显示"0/0 脚本"
截图中 Regex / Summarize 卡片显示"0/0 脚本"，而探针证实其 `index.js` 资源存在且被注入。
显示语义待查（疑为仅统计某类脚本），不影响验收标准 2 的判定，记录备查。

## 6. 证据索引（全部留底于 `D:\项目\_palink-s0-20261012\`）

| 文件 | 内容 |
|---|---|
| `pre-acceptance-gap_20261014_0808.sql` | 补测方自备库备份（37.6M，动手前 dump，合规） |
| `_acceptance_gap_register.py` / `register_result.json` / `_ext_zips/*.zip` | 5 插件注册全过程与产物 |
| `plugins_before.json` / `plugins_after_register.json` | 注册前后插件清单 |
| `plugin_state_before_enable.json` / `_enable_payload.json` / `_after_enable.json` | 允许单启用前后状态 |
| `_probe_s3_plugins_default_out.json` / `_enabled_out.json` / `_mainpage_out.json`（+ `_raw.txt`） | 三态端到端探针结果 |
| `_verify_wrapper_collision.mjs` | import/wrapper 语法冲突 Node 复刻（主控已重跑，5/5 SyntaxError） |
| `_probe_s3_stubstats*.js/_out.json/_raw.txt` / `_evidence_stubstats_card.png` | 任务 2 探针 + 降级统计截图 |
| `_probe_s3_storage_keys*.js/json` / `_compare*.js/json` / `_seed*.js/json` / `_seed_compare.py` + `_out.txt` | 任务 3 存储比对全套 |
| `characters_all.json` / `char_full_*.json` / `character_c28061bb.json` | 三卡全量导出（分类核对用） |
| `palink_admin_token.txt` / `tmp_token.txt` | 探针用临时 admin JWT（6 小时过期，已失效） |

测试插件 id（如需回退删除）：
Quick Replies `228185ea-c9f4-4163-a45c-4d61e879d0c5`｜Chat Translation `ff625696-96c9-47bc-98ff-2e1fa886b439`｜
Token Counter `6a8725df-6466-4aaa-9ca7-ca0611884034`｜Summarize `ffb782eb-1a3b-47d6-b544-01db1f12ddd0`｜
Regex `db0c6324-2b5e-41ae-9221-43ef24b1a3ba`。

## 7. 后续建议（供主控决策，本报告不代拍板）

1. **任务 1 的 bug 修不修，直接决定 S5 放行方式**。wrapper 撞名缺陷的修法有两种：
   a) 变换时对与 wrapper 参数同名的 import 本地名加前缀重命名（最小改动，在 `normalizeStPluginScriptSourceCompat` 内解决）；
   b) wrapper 参数表改名。建议 a)——改完需回归 `plugin-runtime-*` 与 `card-script-*` 测试 +
   用同一套 5 插件探针复测端到端。
2. **MVU 世界书读取失败（§5.1）建议单独立项**，它与 S5 删大堂同属 iframe 轨依赖，宜在 S5 前弄清。
3. **测试插件去留**（§5.2）请主控拍板；若留，需在 TODOS 登记；若删，删后跑一次默认态探针确认无副作用。
4. 本分支仅含本报告与文档目录同步，**未 merge**，留在 `s3-acceptance-gap` 等主控合；
   bundle 已按任务书重打（含主分支 + 本分支，`git bundle verify` 后已 grep refs/heads 确认）。
