# S5 架构实机评估与全量测试报告（s5-arch-e2e）

> 日期：2026-10-15｜性质：**评估 + 测试（未改生产代码）**｜方式：真机（主工作区）
> 对象：三轨并一轨收官（大堂轨 `utils/sillyTavernPluginRuntime.ts` 2447 行已删）后的架构，
> 插件运行只经**单间轨（iframe）**与**沙箱轨（sandbox.ts）**
> 报告口径：每项给「验了什么 / 怎么验的 / 结果 / 证据」。未验成的明确写未通过或无法验证。

## 0. 三十秒速览

| 项 | 结果 |
|---|---|
| 白盒门禁（起点线） | vitest **74 文件 / 960 passed / 3 skipped / 0 failed**；`tsc --noEmit` **exit 0**；pytest **2060 passed / 23 skipped / 0 failed** |
| A 组 5 插件复测 | ✅ **init 4/5 + 7 条斜杠命令**，与历史基线逐项一致（quick-reply 仍 `Failed to fetch`，已知未通） |
| B 组 9 条 Palink 命令 | ✅ **逐条实跑全部命中共享实现**（返回值形状 + 事件 + 分支增减 + 降级登记四路证据 + 未知命令对照）；成功路径与优雅降级路径都验到 |
| C 组 故意抛错卡脚本 | ✅ 其他消息/插件/页面零影响；错误落 `__palinkFrameErrors`（带 frameId + `about:srcdoc:3077`） |
| D 组 降级统计可见性 | ✅ `/profile-list` → `__palinkCompatStats` 落条 + 插件管理页卡片实渲染 |
| E 组 LRU / bootstrap | ✅ 默认 cap=16 两轮实测、全程 0 逐出、bootstrap 四信号全 true（cap=3 按主裁裁决引用单测+T2 历史数据，见 §6） |
| F 组 存储双兼容 | ✅ 大堂轨遗留真实旧键自动迁入新桶、CG 解锁态原样恢复、旧键全部原地保留（只加不删） |
| G 组 冒烟主链路 | ✅ 登录→选卡→发消息→流式回复→切分支（DB 实测）→换角色卡→历史完整 |
| H 组 已知缺口 | ✅ 三项现象均在、未恶化（MVU 世界书 66 次累计；iframe 无 triggerSlash；11 离屏挂载桩 + 4 个已挂载不可见） |
| 红线 | ✅ 未改生产代码、未动 `frontend/dist`（入口 chunk 未变）、测试数据已清理、基线恢复已验证 |

**结论：S5 删大堂后的双轨架构真机表现符合预期，无回归；C/D 两个唯一未真机复验的验收项本次均真跑通过。**

---

## 1. 环境与白盒门禁（起点线）

**环境复核**（派发前 P0：Docker 引擎未起，已由用户启动后复核）：

```
docker ps → 5 容器全部 healthy：
  palink-ai-frontend-1 | 0.0.0.0:16000->8080/tcp
  palink-ai-backend-1 / palink-ai-db-1 / palink-ollama / palink-new-api | healthy
curl --noproxy '*' http://localhost:16000/            → 200
curl --noproxy '*' -X POST http://localhost:16000/api/token → 422（缺表单字段，端点存活）
```

**登录态实证**（订正交接提示词的 P1：`localStorage.palink_token` 已退役，实际走 Cookie）：
`POST /api/token`（admin/admin123）→ `tokenStatus:200`、`/api/users/me` 返回 `admin`；
JS 侧仅见 `palink_csrf`（`palink_session` 为 HttpOnly，符合 N8-c 终态设计）。

**门禁**（均本机自跑，原始输出）：

| 门禁 | 命令 | 结果 |
|---|---|---|
| 前端单测 | `cd frontend && npx vitest run` | **74 passed (74) / 960 passed / 3 skipped / 0 failed**（22.55s） |
| 前端类型 | `cd frontend && npx tsc --noEmit` | **exit 0** |
| 后端 | `cd backend && py -3 -m pytest tests/ -q --basetemp=/tmp/pb_$RANDOM` | **2060 passed, 23 skipped, 0 failed**（139.51s） |

三项与 S5 完工报告基线逐项一致 ⇒ 起点线成立。

**收尾复跑（2026-10-16 07:56，全部测试与清理做完后）**：vitest **960/0/3**（22.76s）、tsc **exit 0**、
pytest **2060/23/0**（139.89s）——与开跑前逐项一致，三次门禁零波动（本轮零代码改动）。

---

## 2. A 组：5 个测试插件复测

**验了什么**：init 4/5 + 7 条斜杠命令与历史基线逐项一致；页面实载的 iframe runtime 是 S5 后构建。
**怎么验的**：复用 `_probe_s5_delete_lobby.js`（端口按 P4 订正 14700→16000），playwright 帧级探针逐插件调 `init()`、读 `SlashCommandParser.commands`。
**结果**：✅ 通过。

| 插件 | 结果 | 基线 |
|---|---|---|
| 2e1fa886b439（Chat Translation） | ok | ok ✅ |
| 43ef24b1a3ba（Regex） | ok | ok ✅ |
| 01db1f12ddd0（Summarize） | ok | ok ✅ |
| 4d61e879d0c5（Quick Replies） | throw `Failed to fetch` | throw `Failed to fetch` ✅（已知未通，栈与 S3/S5 记录同款：`SettingsUi.render` → iframe fetch） |
| ca0611884034（Token Counter） | ok | ok ✅ |
| 75e4266b4991（酒馆助手） | no-init-export | no-init-export ✅ |
| 斜杠命令 | **7**：translate/regex/regex-state/regex-toggle/regex-preset/summarize/count | 逐项相同 ✅ |

附加证据：页面实载 iframe runtime = `palink-smart-card-runtime-1a15e6820ae7.js`（与 S5 报告记载的“删大堂前后字节一致”同一 sha）。
**清理后复跑**：B 组测试插件删除后重跑本探针，回到 6 holder / 4/5 init / 7 命令，与基线逐项一致 ⇒ 测试数据零残留。

---

## 3. B 组：9 条 Palink 专有命令逐条实跑（本次最重要项）

**验了什么**：S5 删大堂后，9 条命令只由 `lib/sillytavern/slash-commands-compat.ts` 一份实现承载，它一旦失效说明下沉有洞。
**怎么验的**：按主控裁决注册沙箱轨测试插件（`S5-E2E-Slash-Probe`，sillytavern_extension 类型，入口 JS 在沙箱内经 `triggerSlash` 逐条调用），配四路证据 + 未知命令对照。**关键实测发现**：沙箱插件的函数值全局会经 `set` 处理镜像到 `window.__stPluginGlobalBridge`（generate_interceptor 既有通道），这是真机回传通道；`globalThis` 在沙箱 wrapper 内被遮蔽，直接挂 window 不可见。
**结果**：✅ **9 条全部命中 Palink 实现**（非引擎兜底）。

### 3.1 上下文解析（无 deps 注入路径）

探针读沙箱 `getContext()`：`chatId=f25daab6-fc7b-4223-abdb-6dea4c2eb284`、`characterId=2039469051`、`name2=露缇雅1.2` ⇒ 共享模块经全局 ST runtime 自行解析会话，**不依赖任何大堂注入物**（S5-GDEP2 设计目标实证）。

### 3.2 逐条结果（第一轮：mesId=1）

| 命令 | 返回值 | 旁证 |
|---|---|---|
| `/branch-create 1` | `''` | console：`ApiError: parent_message_id must point to an assistant message`（floor 1 是用户消息，后端校验拒） |
| `/checkpoint-create mesId=1 e2e-probe` | `''` | 同上（优雅降级） |
| `/checkpoint-go 1` | `''` | `palink:switchBranch` 事件带 branchId+messageId |
| `/chat-fork` | `''` | 事件（branchId null）+ **分支 2→3** |
| `/getchatname` | `palink-session-f25daab6-….jsonl` | **独有 Palink 形状**，引擎不可能产出 |
| `/model` | `Current model: deepseek-flash` | Palink 分支形状 |
| `/profile` | `deepseek-flash` | 同上 |
| `/preset` | `deepseek-flash` | 同上 |
| `/profile-list` | `''` | `__palinkCompatStats` 落 `slash:profile-list`（D 组） |
| 对照 `/__palink_e2e_unknown_command__` | `Error: Unknown command: …` | 引擎形状 ⇒ 证明上表 9 条不是引擎兜底 |

两条创建命令的失败是**数据相关的后端校验**（floor 1 = 用户消息），且走 `runPalinkSlashCommands` 的 catch 分支（`console.error` + 返 `''`）——与大堂旧实现同款优雅降级，**不是回归**。

### 3.3 成功路径补跑（mesId=0，assistant 楼层）

| 命令 | 返回值 | 旁证 |
|---|---|---|
| `/branch-create 0` | `''` | 事件 + **新分支 291d588c** |
| `/checkpoint-create mesId=0 e2e-probe-ok` | `''` | 事件 + **新分支 7777ad00** |
| `/checkpoint-go 0` | `''` | 事件带 branchId=291d588c（切到刚建分支） |

分支 3→5，`newBranchIds` 与事件 detail 一一对应 ⇒ 创建/切换全链路真通。

### 3.4 轨道可达性实证（报告用）

- **沙箱轨**：`sandbox.ts:3606 triggerSlash → runPalinkSlashCommands`，本次 9 命令的唯一真机载具；
- **getContext 轨**（`getContext.ts:2517` 已接共享实现）：主页面 `window.SillyTavern` 无 `getContext`（只注册了 `getExtensionPrompts`），真机不可达，仅单测覆盖；
- **iframe 轨**：卡帧内 `typeof window.triggerSlash === 'undefined'`（C/H 组复证），且 iframe 产物 chunk 内 `runPalinkSlashCommands`/`profile-list` 0 命中 ⇒ iframe 插件只能拿自注册 7 条（既有缺口，S5 报告 §9 已登记）。

---

## 4. C 组：故意抛错的卡脚本不影响他人

**验了什么**：运行期 throw 的卡脚本被隔离——其他消息正常渲染、其他插件不崩、页面不白屏、错误可观测。
**怎么验的**：造测试会话（`cccc0001-…`，3 条消息：正常卡[带 `data-ran` 标记脚本] + 抛错卡[顶层 `throw new Error('S5-E2E-C-PROBE-THROW')`] + 纯文本），playwright 帧级断言。种子脚本幂等留档 `D:\项目\_s5-e2e-2026-10-15\c_seed.sql`。
**结果**：✅ 通过。

| 断言 | 证据 |
|---|---|
| 正常卡脚本照跑 | 帧内 `#s5e2e-c-ok[data-ran=yes]` = true |
| 抛错卡内容照渲 | 帧内 `#s5e2e-c-bad` 存在（文本 C-BAD-CARD） |
| 其他插件不崩 | **3 个卡帧全部 `holderCount=6` + `slashCount=7`** |
| 错误可观测 | `__palinkFrameErrors` 落条：`Error: S5-E2E-C-PROBE-THROW at about:srcdoc:3077:9`，带 frameId `palink-smart-card-c5b97d82-…`（P0 契约的 message+filename+lineno 三要素齐全） |
| 页面不白屏 | 聊天输入框在、外壳 38 个可点元素、纯文本消息正常 |

**既有噪音登记**（非本次回归）：同页 `__palinkFrameErrors` 另有 3 条 `unknown error` + 3 条 `script resource failed to load (HTML-as-JS suspect): https://drive.baibai.cv/f/ZKEBuW/Music.js`——来自角色卡自身扩展的外部脚本（卡内容写死的 URL），且均被正确上报。建议并入“卡外部依赖健康检查”议题，本任务不动。

---

## 5. D 组：静默失效降级统计与可见性

**验了什么**：触发一次降级桩后，`window.__palinkCompatStats` 出现该条目且插件管理页可见。
**怎么验的**：B 组沙箱探针在 /settings 页内触发 `/profile-list`（沙箱轨 → `recordStubHit('slash:profile-list')`），再点「插件管理」tab 读 DOM。**注意**：`page.goto` 整页重载会重置模块级 stats（提示词预告的“惰性创建”），故触发与查看必须在同一 SPA 会话内。
**结果**：✅ 通过。

- 触发前 `statsBefore: null`（惰性创建，未触发时 undefined 属正常）；
- 触发后 `statsAfter: [["slash:profile-list", 1, "Palink 无独立 profile/preset 概念，返回空列表"]]`；
- 插件管理页卡片实渲染（DOM 原文）：`ST 兼容层降级统计｜本会话共 1 次降级桩调用 — 这些 ST API 在 Palink 中为无操作/部分实现…｜slash:profile-list Palink 无独立 profile/preset 概念，返回空列表 1 次｜也可在浏览器控制台访问 window.__palinkCompatStats`；
- 顺带实证：插件管理页能列出探针插件自身（注册链路正常）。

---

## 6. E 组：iframe 生命周期与挂载

**验了什么**：默认 cap=16 仍生效、iframe 首帧 bootstrap 仍工作。
**怎么验的**：T2 口径（内层滚动容器筛选、800px/步、140ms 等待）+ 帧级信号。
**结果**：✅ 通过（cap=3 部分按主控 2026-10-15 裁决处理，见下）。

| 轮次 | 会话 | cap | size 变化 | 逐出 | 帧数 |
|---|---|---|---|---|---|
| 1 | C 组会话（3 门） | **16** | 1→2（滚动登记） | **0** | 3→3 |
| 2 | 露缇雅会话（现 1 门） | **16** | 0（唯一卡片全程在视野内） | **0** | 2→2（滚完全程 9584px） |

- **bootstrap 四信号**（帧内）：`getScriptId` / `insertOrAssignVariables` / `tavern_events` / `getScriptName` 全 true；
- **size=0 的解释**（非缺陷）：登记发生在**首次出视野**时（`shouldSleep === dormantNow`  continue），露缇雅会话现仅渲染 1 个卡门（消息窗口化/maxDepth 深度窗效应，T2 当年的 5 门已变）且它始终在视野内；
- **cap=3 逐出实验**：按主裁裁决未做（window 投影 `__palinkIframeLru` 只有 cap/size/visibleCount/snapshot 只读接口，无 setCap；本轮禁重建 dist）。引用证据：现存单测 `iframe-lru.test.ts`（含 `setCap(3)` 内核断言，在 960 passed 内）+ T2 报告 §8.3 历史真机数据（修复后 cap=3：size 恒 3、逐出 2、帧 7→5；cap=16：行为零变化）。

---

## 7. F 组：存储双兼容（S2 成果未被 S3–S5 改坏）

**验了什么**：旧键/新键双读、迁移只加不删、解锁态不回退、session 旧键兼容仍在。
**怎么验的**：删掉全部新键 → 重载（逼迁移路径）→ 帧内 compat storage 双读 + 主页核对旧键去留。
**结果**：✅ 通过。

- **迁移实证**：大堂轨遗留的**真实旧键**（UUID 前缀：`palink:card-storage:v1:c28061bb-…:local:tavern_cg_album_unlocked`、`…:local:tavern_cg_album_pos_v2`）被自动迁入新键，帧内原样读到 **`tavern_cg_album_unlocked = ["露出魔纹1","摸脸"]`** ⇒ **CG 解锁态不回退**（F 组核心断言）；
- **只加不删**：迁移后 4 个旧 local 键 + 1 个旧 session 键全部原地保留；
- **session 兼容**：sessionStorage 旧键原地保留（`legacyStoreFor` 口径：旧 session 键在 sessionStorage、新桶统一在 localStorage，代码注释已声明）；
- **口径备注**（非缺陷）：渲染 context 的 `characterId` 是 UUID（新键 key 可见），沙箱 ST context 的是 numeric（`2039469051`）——迁移候选按渲染 context 走（raw+normalized 双候选），行为正确；我种的 numeric 前缀合成 marker 不被迁即因此故，已清理；
- **已知边角**（登记不修）：卡挂载后会把自身存储视图写回新桶（`inline-st-globals.ts:227` 的“挂载时主动写回”），迁移进来但卡本身不持有的额外键会被覆盖——旧键仍在，删新键可复迁。

---

## 8. G 组：冒烟主链路

**验了什么**：登录 → 选角色卡 → 发消息 → 收流式回复 → 切分支 → 换角色卡 → 历史正常。
**怎么验的**：playwright 全 UI 操作（textarea + Enter 发送；故事线图 react-flow 节点切分支；角色列表“开始对话”换卡）+ DB 旁证。
**结果**：✅ 通过。

| 步骤 | 证据 |
|---|---|
| 发消息 | 用户消息上屏（`S5-E2E-G 冒烟测试：请用一句话回答`） |
| 流式回复 | 页面文本 462→1237 字节增长，收到完整角色回复（露缇雅…），模型署名 deepseek-flash |
| 切分支 | 故事线图节点点击 → **DB `is_active` 实测 30251f44 → 327f3d97**；`POST /branches/{id}/switch` 200；聊天区随分支重渲染 |
| 换角色卡 | 角色列表点「开始对话」→ URL 切到 `/characters/c44f2ae6-…`（另一露缇雅副本），页面正常（9024 字节） |
| 历史正常 | 换回测试角色：13 消息气泡 + 7 iframe、DB 主分支 `30251f44` 91 条消息原样、我的 G 消息在图谱可见 |

**过程备注**（非缺陷）：点故事线**非叶节点**进入“已截断至此节点 · 输入新消息将从这里分叉”预览态（onNavigate 的设计语义），点“取消”即恢复；`/checkpoint-go` 的分支切换不跨页面重载保留（应用加载时默认回主分支），属既有行为。

---

## 9. H 组：已知缺口确认（不当新 bug，只确认现象仍在、未恶化）

| 缺口 | 确认证据 | 判定 |
|---|---|---|
| MVU 世界书读取失败 | console 累计 `无法读取角色世界书"露缇雅1.2"` **66 次**（每次开会话十几次，与 S3 报告“默认态约 14 次/会话”口径一致） | ✅ 仍在，未恶化 |
| iframe `getContext()` 不暴露 `triggerSlash` | 卡帧内 `typeof window.triggerSlash === 'undefined'`（C 组帧级断言复证） | ✅ 仍在 |
| ST 扩展 UI 卡内不可见（口径 c 已接受） | 帧内 **11 个挂载桩全在**（`data-palink-st-mount-stub="iframe"`，`position:fixed;top:-9999px;visibility:hidden`，rect.top=-9999），且 **4 个桩已有实际挂载内容**（translation/summarize/translate_wand/token_counter_wand）——插件“挂得上”但用户看不到 | ✅ 现象与口径 c 描述一致 |

---

## 10. 偏离与副作用登记

**对交接提示词的落实/订正**：

| # | 事项 | 处置 |
|---|---|---|
| 1 | P1 认证指令过时（`localStorage.palink_token` 已退役） | 按 Cookie 口径执行并实证（§1） |
| 2 | P4 探针端口 14700 硬编码 | 订正 16000 后复用 |
| 3 | P2 E 组 cap=3 无可执行手段 | 按主裁裁决：只真机验默认 cap16，cap=3 引单测+T2 历史数据并如实标注（§6） |
| 4 | P3 B/D 缺实操载具 | 按主裁裁决注册沙箱轨测试插件，跑完已删、基线恢复已验证（§2/§10） |
| 5 | 提示词未给数据前置 | 测试角色卡 `c28061bb-a9b7-46a9-a255-2692d57001fc`、会话 `f25daab6-…`（探针同款，本报告已补全） |

**测试副作用（均已登记，可按需清理）**：

| 副作用 | 状态 |
|---|---|
| 测试会话新增 3 个分支（B 组：chat-fork / branch-create / checkpoint-create，2→5，含 1 个名为 e2e-probe-ok） | **已于 2026-10-16 删除**（主控裁决全删；单事务 + 删前备份） |
| 测试会话新增 1 条用户消息 + 1 条回复（G 组） | **已删除**。订正上一版口径：这对消息落在分支 `291d588c` 上（2 条），**不在**原始主分支 `30251f44`（91 条始终未被动过） |
| C 组测试会话 `cccc0001-…` | **已删除**（幂等种子脚本留档可复现） |
| 测试插件 `S5-E2E-Slash-Probe` | **已删除**，A 组探针复跑确认基线恢复 |
| F 组合成存储种子键（numeric 前缀） | **已清理**；真实旧键（UUID 前缀）原样保留 |
| `/checkpoint-go` 切换过的活动分支 | 页面重载后默认回主分支（30251f44  active），无残留 |

**清理执行记录（2026-10-16，主控裁决“全删”）**：单事务执行 `cleanup_test_records.sql`（消息 2842/2843 → 分支 291d588c → 消息 2838 → 分支 7777ad00 → 分支 718dc3b0，顺序按 FK 依赖排）；删前备份 3 份 CSV（branches / messages / 各分支消息数）到 `_s5-e2e-2026-10-15/_backup_before_cleanup/`。
清理后校验：分支 **2 条**（30251f44 活动 + 327f3d97，与开测前一致）、`30251f44` 消息 **91 条未动**、`content LIKE 'S5-E2E%'` **0**、S5-E2E 标题会话 **0**、15:50 后新建分支 **0**、S5-E2E 插件 **0**。

**红线遵守**：未改任何生产代码（`git status` 仅新增本报告）；未动 `frontend/dist`（入口 chunk 仍 `index-2sAXca_F.js`，未重建）；未 `rm`、未 `git add -A`；临时文件全在仓库外 `D:\项目\_s5-e2e-2026-10-15\`。

---

## 11. 总表

| 组 | 项 | 结果（通过/未通过/已知缺口确认） | 证据 |
|---|---|---|---|
| 门禁 | vitest / tsc / pytest | **通过** | 74 文件 960/0/3；tsc exit 0；2060/23/0（§1） |
| A | 5 插件 init 4/5 + 7 命令 | **通过**（quick-reply 失败=已知未通） | 帧级探针逐项对齐基线；runtime sha 1a15e6820ae7；删插件后复跑恢复（§2） |
| A | 7 条斜杠命令注册可用 | **通过** | slashNames 逐项相同（§2） |
| B | 9 条命令逐条实跑 | **通过** | 返回值形状 + switchBranch 事件 + 分支增减 + stub 登记 + 未知命令对照（§3） |
| B | 创建类命令成功路径 | **通过** | mesId=0：新建 291d588c/7777ad00，checkpoint-go 切换带 branchId（§3.3） |
| B | 降级路径（数据校验失败） | **通过**（符合设计的优雅降级） | mesId=1：ApiError → catch 返 ''，与大堂同款（§3.2） |
| C | 抛错卡不影响他人 | **通过** | 3 帧全 6 holder+7 命令；正常卡 data-ran=yes；抛错卡内容照渲（§4） |
| C | 错误可观测 | **通过** | `__palinkFrameErrors`：message+about:srcdoc:3077+frameId（§4） |
| D | `/profile-list` → compat stats | **通过** | `slash:profile-list` 计数 1 + detail 文案（§5） |
| D | 插件管理页可见 | **通过** | 卡片 DOM 实渲染（§5） |
| E | 默认 cap=16 | **通过** | 两轮 cap()=16、0 逐出、帧数稳定（§6） |
| E | iframe bootstrap | **通过** | 帧内四信号全 true（§6） |
| E | cap=3 逐出 2、帧 7→5 | **已知缺口确认**（主裁裁决：非本轮真机） | 引单测 iframe-lru.test.ts + T2 §8.3 历史数据（§6） |
| F | 旧/新键双读 + 迁移 | **通过** | 真实旧键迁入新桶、帧内读到（§7） |
| F | 解锁态/CG 不回退 | **通过** | `tavern_cg_album_unlocked=["露出魔纹1","摸脸"]` 原样恢复（§7） |
| F | 只加不删 + session 旧键 | **通过** | 4 旧 local + 1 旧 session 键全保留（§7） |
| G | 冒烟主链路全步骤 | **通过** | 流式回复、DB 级分支切换实证、换卡、91 条历史完整（§8） |
| H | MVU 世界书失败 | **已知缺口确认** | 66 次累计，口径与 S3 一致（§9） |
| H | iframe 无 triggerSlash | **已知缺口确认** | 帧内 typeof undefined（§9） |
| H | ST 扩展 UI 不可见 | **已知缺口确认**（口径 c 已接受） | 11 离屏桩 + 4 个已挂载不可见（§9） |
| 红线 | 未改生产代码/未动 dist/工作区干净 | **通过** | git status 仅新增本报告；dist 入口未变（§10） |

---

## 11.5 未做 / 弱化项（诚实登记，防止“看起来都过了”）

按本机规矩：没验成的必须明确写，不许含糊带过。以下 8 项属**有意取舍或能力边界**，不是遗漏：

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | `/model` `/profile` `/preset` 的 **set 形态**（带参数） | **未跑** | 只跑 get 形态。set 会改 `generationEngine` 的当前模型（用户可见配置），本轮不碰用户配置；命中判据（正则 + 返回值形状）在 get 形态已充分体现 |
| 2 | 切分支的 **UI 显示刷新** | **未直接证** | DB `is_active` 实测翻转（30251f44→327f3d97）+ switch API 200 是硬证据；但页面上“当前分支”标签的刷新我没抓到确定性读数（页面同时开着故事线图，标签元素有多个同名候选，读数不可靠）。⇒ **结论按“切换发生”成立，UI 刷新表现另案** |
| 3 | F 组 **session 型旧键的迁移** | **无合成证据** | 只证到“session 旧键原地保留”+ 代码按 `legacyStoreFor` 读 sessionStorage；因我种的 numeric 前缀种子不匹配迁移候选（UUID 口径），session 型新桶的迁移未端到端证到。local 型迁移有真实旧键实证 |
| 4 | E 组 cap=3（逐出 2 / 帧 7→5） | **未真机** | 主裁裁决（window 投影无 setCap + 禁重建 dist）。引用单测与 T2 §8.3 历史数据 |
| 5 | T2 当年的 **5 门/7 帧样本** | **已变化** | 消息窗口化/maxDepth 深度窗落地后，露缇雅会话现只渲染 1 个卡门（换回页面时仍可见 13 气泡/7 iframe）。T2 的历史数字不能直接当现状 |
| 6 | 门禁 **收尾复跑** | ✅ **已补（2026-10-16 07:56）** | 收尾复跑与开跑前逐项一致：vitest 74 文件 **960 passed / 3 skipped / 0 failed**（22.76s）、`tsc --noEmit` **exit 0**、pytest **2060 passed / 23 skipped / 0 failed**（139.89s）。三次门禁（开跑前 + 收尾）零波动 |
| 7 | 交接提示词文档的 P1/P2/P3/P4 缺陷 | **已回写（2026-10-16 07:55）** | 报告提交（07:53）后两分钟即由 `c04fd82` 按执行结果回写订正（认证 Cookie / playwright 会话 / B·D 组真机载具 / E 组 cap3 口径 / 数据前置 / 收尾清理），原文"未回写"已作废 |
| 8 | C 组证据的**库内留存** | **已删** | 测试会话已删除，C 组结论**只能靠 `c_seed.sql` 复现**（脚本幂等留档） |

**报告里登记的既有瑕疵（只登记、本任务不修）**：① 卡挂载写回会把迁移桶里非卡持有的键覆盖（旧键仍在，删新键可复迁）；② 角色卡扩展的外部脚本 `drive.baibai.cv/…/Music.js` 404（卡内容写死 URL，已 3 条上报）；③ `/checkpoint-go` 的分支切换不跨页面重载保留（加载时默认回主分支）。

## 12. 复现指南

全部探针/脚本/种子留档于 `D:\项目\_s5-e2e-2026-10-15\`（仓库外）：
`probe_a_plugins.js`（A 组，端口已订正）、`step_b_run*.js` + `probe_plugin/`（B 组沙箱探针，含 zip）、
`c_seed.sql`（C 组幂等种子）、`step_d_check3.js`（D 组）、`step_e_run*.js`（E 组）、
`step_f_run.js`（F 组）、`step_g_*.js`（G 组）、`step_h3.js`（H3）、`step_cleanup_plugin.js`（收尾）。
浏览器会话：`playwright-cli -s=<name>`（0.1.17，`-s=` 旗标可跨命令持久，比提示词假设的乐观）。
