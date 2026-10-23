# HANDOFF · 变量视点 / 分支不变量批次（交给接手"减重与流式改造"的 Agent）

> 状态：本批**已上线、已提交**。你接手的是下面的"剩余项"，不是重做。
> 基线：`c51f50e`（含本批全部提交）。与你的 `HANDOFF_2026-10-23_减重与流式改造.md` 并列阅读。
> 判据分级：[一手] = 我亲自跑出的读数；[交接] = 需要你自己复现的。

---

## 0. 我这批已经做了什么（别重做、别回退）

| commit | 内容 | 线上验证 [一手] |
|---|---|---|
| `82d5a26` | 变量取值带「视点」：新增 `backend/app/services/mvu_state.py`；装配注入单聊轨改走它；历史消息接口逐楼补值；前端 `resolveCardVariables(…, isViewpoint)` | 7 个卡片窗口逐层哈希与接口逐层值一一对上；最新页 5 层值未变 |
| `69fc9eb` | `/branch-create` 取不到锚点 ⇒ 不建分支（堵住父指针双空的谱系丢失） | 产物字面量 + 3 例测试 |
| `96bc6aa` | 移除卡片内「信任此卡」开关（老板裁定：信任只在上传时勾选决定） | 主文档 + 7 帧 `aria-label` 含"信任"的按钮 **全 0** |
| `32101cf` | `/api/secrets` 垫片不再假成功：写类回 `ok:false + palink_stub`，两种方法都 `reportStubApi` | 真机实测写/读响应体如上 |
| `999f667` | WebSocket 票据改**无状态 HMAC 自签名**（原进程内一次性票据 × `--workers 4` ⇒ 约 3/4 握手 403） | 真机连开 8 次 **8/8 open**；后端日志无 403 |
| `bdbc97f` | 分支不变量：读路径不再改 `is_active`；`chats/save` 不再落盘切分支；"该用哪条分支"统一到 `services/branch_resolution.py`，经 `active_branch_id` 下发 | `/branches` 实测 `active_branch_id=30251f44…`、`source=flagged_active` |
| `c51f50e` | 补交半成品现场的 `BACKUP_INFO.md` | — |

**门禁基线 [一手]**：后端 **2433 passed / 0 failed / 0 errors**；前端 **135 文件 / 1707 通过 / 3 skipped**；`tsc` 干净；`gate.sh` 退出 0。
**线上入口 [一手]**：`assets/index-Bn0prgjj.js`（这个包里**只有我的批次**，不含你的 SSE/错误文案改动 —— 你的那两份仍未提交）。

---

## 1. 剩余项（按优先级，都是我这条线挂着的）

### R1｜`replaceVariables` 同名不同义 —— 唯一纯只读、零风险、必须先做
**要证的问题**：上游 MVU 插件写回变量调的是 `replaceVariables`（ST 语义：整体替换 `chat_metadata.variables`）；
而我们帧内同名符号是**模板文字展开**（`runtime-body/part-07.ts:1956`、`frame-legacy-sim-parts/part-b.ts:376`）。
两处同名不同义，上游本就并存 —— **到底哪一条被插件踩到、有没有落地、落到哪一格，至今没人实测**。
**做法**：用求值后的载体（`COMPAT_V2_RUNTIME_ARTIFACT`）在离线探针里调用，打印"调用前后 `chat_metadata.variables` 的键集合与哈希"，**不要读正文**。
**判据**：能说清"插件那次写回落到了 X"或"测不出 + 原因"；测不出就如实写，不许推测填空。

### R2｜插件词条键 `smart_memory_long`（真机实测暴露，未修）
现象（我 2026-10-22 用真实第三方插件 Smart Memory 1.8.3 实测）：
`TypeError: Cannot read properties of undefined (reading 'smart_memory_long')` at `updateTokenDisplay`。
**不是**旧记录里的 `lastActive`。要修得先临时导入一次真实插件看它读哪张表，修完再删（老板已同意"按需临时导入"）。
**注意**：该插件已按老板令删除，库里现在**只有酒馆助手**；恢复用
`_BACKUPS/2026-10-22_插件清理前DB快照/plugins_three_tables.sql`（只捞一行，别整包恢复）。
同批还有一条**预期内**的拦：`http://localhost:11434` 不在插件联网白名单（设置页可加白，不改代码）。

### R3｜切分支接口不补逐楼变量
`switch_branch` 的响应里**没有**页面级 `variables`、也不做逐楼补值（我只把补值接在"读历史消息"接口）。
若前端切换后完全依赖该响应，刚切完的一瞬老楼层可能是空。**先查前端是否随后重新拉 `/messages`**；是则无需改。

### R4｜群组轨仍回落会话级（有意留的不对称）
`roleplay_prompt_assembly` 里群组仍走 `_load_effective_stat_data`（含会话级回落）。要收口需**改判**
`backend/tests/test_mvu_cleanup_safety.py:357` 那条守卫 —— 动别人的守卫前先报备老板。

### R5｜历史 32 行分支父指针仍是 NULL（只堵住新增）
`create_branch` 的"同级分支"路径会照抄当前分支的父指针，从根分叉即得 NULL ⇒ 这些老分支只能当独立新故事线。
是否按"当前进度分叉"补父指针属**产品语义**，等老板拍板（见 §4）。

### R6｜真机视觉复核被工具挡住（不是代码问题）
我最后一次要验"进角色页默认显示 91 条那条主分支 + 7 帧逐层值不变"，内嵌浏览器返回
`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE (viewport=0x0, hidden)`，`click` 被拒。
**谁打开可视浏览器窗口，用一条 evaluate 就能补完**：进 `http://localhost:16000/characters/c28061bb-a9b7-46a9-a255-2692d57001fc`，
读 `/api/character-sessions/f25daab6-fc7b-4223-abdb-6dea4c2eb284/branches` 的 `active_branch_id`
（应为 `30251f44-94ae-4726-b0f6-7882f78db2e5`）与 7 个 iframe 的 `stat_data` 哈希。

### R7｜可选：202 条命令的"缺失"做进插件管理页
留痕早就有了（`part-07.ts:1468-1478` 记 `slash_command_unimplemented`，`exportPalinkDiag` 能导出）。
缺的只是"管理页能直接看"，纯前端展示。

---

## 2. 与你的改动同文件 / 同包的地方（务必先看）

1. **`frontend/src/components/views/CharacterView.tsx`** —— 你改了 SSE 读取，我在 `bdbc97f` 里改了两处分支选择
   （消费 `active_branch_id`，新增 `src/lib/branch-selection.ts`）。我核过**零符号冲突**。
   ⚠️ 如果你的本地改动是基于 `bdbc97f` 之前的工作区，请把 SSE 那两处**重新应用到新文件**上，不要整文件覆盖。
2. **前端包耦合**：一旦有人重建 dist，你的 SSE/错误文案与我的分支改动会**一起上线**。验收时两批一起看。
3. **`docs/_CATALOG.md`**：先 `git add` 新文档，**再**跑 `py scripts/docs/gen_docs_catalog.py`，最后 `--check`（顺序反了恒红，你自己那份交接书里写过）。

---

## 3. 我这批留下的"红线与口径"（改到就别改错）

- **变量取值绝不回落会话级**：`chat_metadata.variables` 里那份值与全库 48 条消息级 `stat_data` 哈希比对**相等 0 条**；
  它既不属于当前分支也不属于任何楼层。唯一例外：**会话≤1 条分支 且 视点=最新楼**（`mvu_state._trunk_live_fallback_allowed`）。
- **上游清理四参数一律不动**：`启用=true / 快照保留间隔=50 / 保留最近楼层=20 / 触发恢复楼层=10`（老板裁定）。
- **锚点全库从未打成功过**（`snapshot`/`schema` 在 94 行里出现 0 次）⇒ 清理**不可逆**；"补算"已撤销（读侧重演替代）。
- **信任开关不得加回**：卡片 UI 里不许再出现任何信任入口；`shared.ts` 的文案键保留不算残留。
- **WS 票据**：无状态 HMAC，`settings.SECRET_KEY` 签名，TTL 30s；单次使用仅进程内 best-effort，
  **跨 worker 30 秒内重放是已接受的残余风险**（写进了 `ws_ticket.py` 文件头，别当 bug 改）。
- **`silent_failure.record`**：新增 try/except 必须走它；热点用 once/去重（我在 `_active_branch` 回落处按 session 去重）。
- **别改 `backend/app/services/slash_command_service.py` 去迁就分支规则** —— 上一版 agent 这么干改红了 3 条既有用例。

---

## 4. 需要老板拍板的两件（我未擅自做）

1. **推远端 / 出仓备份**：`three-tracks-merge-20261012` 全部提交仍只在本机，`origin/master` 停在 2026-05-19；
   本仓 8 月已丢过一次 git 对象。这是唯一"出事即全丢"的项。
2. **"同级分支/从这条继续"的语义**：是"从当前进度分叉"还是"从零开新故事"？两种共用 `same_level` 开关，
   猜错会改坏另一边；也是 R5 与"消息可写进非活动分支"那条的前置。

---

## 5. 参考

- 本批取证与前后对照：`docs/_active/report/REPORT_变量清理与故事线回跳_取证_2026-10-22.md`（§9 上线读数、§10 MS-3）。
- 半成品现场与教训：`_BACKUPS/2026-10-22_分支不变量半成品现场/BACKUP_INFO.md`
  （另一个 agent 写坏过一次：反向证明没还原 + 顺手改红别人用例 ⇒ 中途退回）。
- 备份台账：`_BACKUPS/_INDEX.md`（含本批两次 dist 归档与一次插件 DB 快照）。
