# HANDOFF 提示词 — 已授权批次（写桥四键 / 人设与角色库 / getContext 六个空壳 / 服务端留痕）2026-10-20

> **状态：待施工。用户已逐条拍板，本文件是执行底本。**
> 撰写：主控（主脑）2026-10-20。缺口明细见 `SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md`（台账），
> 难度分层见 `SPEC_ST兼容适配待办分层与排期_2026-10-19.md`（排期）。
> ⛔ **开工前置条件（必须自查，不满足就停手回报）**：`git log --oneline -8` 里要能看到 pkg-AA 的三笔
> （别名进表 / listvar 照 ST / 宏成员键）。它们与本文件的批次 A、B **同改 `runtime-body/part-07.ts`**，
> 串行是硬约束，不能并行两个写者。

## 0. 用户裁决原文与由此推出的口径（2026-10-20）

| 序 | 用户裁决 | 执行口径 |
|---|---|---|
| 1 | 删世界书 + 卡↔书绑定：**允许**，可参考 ST，**我的与 ST 冲突则用 ST 的** | 批次 A 放行；语义一律以 ST/酒馆助手的一手声明为准 |
| 2 | 人设 + 角色库写通道：**允许**，同上 | 批次 B 放行；同上 |
| 3 | 历史脏正文回填：**不着急，我可以直接把卡删了** | ⛔ **不做**。只在台账/排期留"已搁置+原因"，不要顺手写迁移脚本 |
| 4 | `window.context`：**按 ST 来设置/适配** | 见批次 C 的一手结论：**ST 里根本没有这个全局** ⇒ 不摆它；改做 getContext 的 6 个"有名字没实物"键 |
| 5 | 202 条命令：**前端不报错，后端日志记录**（开发阶段允许后台自动保存便于查验） | 批次 D 放行，含"W 记录器零网络红线"的**授权变更**（见 D 的红线段） |
| 6 | 上线时机：**看你可以，不着急** | 重建 dist 只由主脑做；施工方**禁止**动 `frontend/dist` |

**总原则（用户明说）**：与 ST 冲突时**以 ST 为准**，不以我们既有行为为准。
这条推翻了本仓过去几处"照抄自己旧实现"的保守做法，写进代码注释里，别只在报告里说。

**通用红线（每条都踩过）**

- ⛔ 禁止空壳实现（返回像样的空对象/空串当实现）。做不到就写做不到 + 缺的是哪一层。
- ⛔ `runtime-body/part-*.ts` 是注入 iframe 的**模板字符串**：不许反引号、不许 `${`（会真触发插值把编译炸掉）、
  反斜杠成对写；`tsc` 不检查其内部 ⇒ 必须让 `generated-script-parse-guard` 过；
  执行型断言只能用 `COMPAT_V2_RUNTIME_ARTIFACT`（求值后载体）。
- ⛔ 测试注释里不许出现 `*/`（会提前闭合块注释 ⇒ 整份测试变 `no tests`）；交回来前自己数用例数，**0 用例=不存在**。
- ⛔ 提交逐项 pathspec，禁 `git add -A` / `git commit -a`；`.workbuddy-ai/**`、`_BACKUPS/` 存量、`.githooks/`、
  `frontend/dist`、`backend/data` 一律不碰。
- ⛔ **不许为了让守卫变绿而改守卫**。唯一例外：能力**真的实现了**，此时改判要连带台账行 + 报告计数订正一起做（见 §5）。
- ⛔ 破坏性验证只在**本包自建的测试对象**上做（测试世界书/测试人设/测试角色），建之前先列清单、用完先列清单再清理，
  **禁止直删用户既有数据**。
- 真机：`http://localhost:16000`；⛔ 不许点生成、不许花用户 API 余额；计费端点用 `page.route` 本地 fulfill。
  需要真机读数又禁止重建 dist ⇒ 用旁路：`VITE_OUT_DIR=dist_<代号> node scripts/build-vite.mjs` + vite dev 探针
  （端口 5213 起，playwright 会话名 `-s=pkg-<代号>`），**不要覆盖 `frontend/dist`**。
- 门禁：`bash scripts/gate.sh frontend`（碰后端加 `backend`），只认 `failed=0 / errors=0` 与退出码；
  禁 `|| true`、`continue-on-error`、新增 skip。passed 总数不是判据。
- Python 用 `py`（`python` 是商店空壳 exit=49）；shell 是 Git Bash；判定只认结构化 ASCII 行。

---

## A · 写桥四键：删整本世界书 + 卡↔书绑定（已授权，建议第一个做）

**目标键**：`deleteLorebook`、`deleteWorldbook`、`setCurrentCharLorebooks`、`rebindCharWorldbooks`。

**注意事项**

- 后端删除路由**已由主脑一手核实存在**：`backend/app/api/worldbook.py:439` `@router.delete("/{world_book_id}")`。
  绑定的写侧要先自己核实端点（`grep -rn "charLore\|world_info" backend/app/api/`），核不到就停手写"缺后端能力"，别在前端造假。
- 契约以**酒馆助手的一手声明**为准：`st-plugins/third-party/JS-Slash-Runner-main/@types/function/` 下
  lorebook 相关 d.ts（读参数、返回值、失败时抛错还是返回值）。**把文件:行号写进报告。**
- ST 侧同名函数在 `_reference/sillytavern-1.18.0/public/scripts/world-info.js`（若该文件在参照树里不存在，
  就只认 d.ts，并在报告里写明"参照树缺 world-info.js"）。
- 删书是**不可逆**：帧内实现必须先经父侧确认会话与书的归属（不能拿别的角色的书 id 删），
  失败一律返回诚实的失败值（不许假成功）。

**怎么做**

1. 读 d.ts 与后端路由，列出四键的完整契约表（入参/返回/失败语义），贴进报告。
2. 父侧动作：在 `SmartCardCompatController.ts` 里按既有动作的写法加（对照 `renameSmartCardChatSession`
   那份的注释风格：契约写在函数头上，每个提前返回都带机器可读 error 码）。
3. 帧内：在 `part-07.ts` 的 TavernHelper 区域加成员，**指向同一份实现**（不要两份逻辑）。
4. 破坏性验证：脚本自建一本测试世界书（记下 id）→ 绑定 → 解绑 → 删除 → 断言库内确实没了；
   全过程 id 与清单写进报告。

**验收标准**

- 四个键在真机帧内 `typeof === 'function'` 且**实调形状与 d.ts 一致**（贴帧内读数原文）。
- 删除后**跨进程复核**：用 SQL/接口再查一次该书 id 不存在（`synced` 计数会骗人，本仓踩过）。
- 绑定/解绑后，重新加载会话仍是新绑定（不是只在内存里变了）。
- 新增执行型测试（用求值后载体）+ **反证**：把父侧动作短路 ⇒ 测试红；贴原始输出后还原。
- `bash scripts/gate.sh frontend` rc=0；动了后端就 `gate.sh backend` 也 rc=0。
- 记账连带（见 §5）：这四键从 D 改判 C，台账行加订正，包H 报告的计数加订正说明。

---

## B · 人设 11 键 + 角色库写侧 7 键（已授权，语义照 ST）

**目标键**：人设 `createOrReplacePersona` `createPersona` `deletePersona` `getPersona` `getPersonaAvatarPath`
`getPersonaIds` `getPersonaNames` `getCurrentPersonaId` `getCurrentPersonaName` `replacePersona` `updatePersonaWith`；
角色库 `createCharacter` `createOrReplaceCharacter` `deleteCharacter` `replaceCharacter` `updateCharacterWith`
`importRawCharacter` `RawCharacter`。

**注意事项**

- 后端人设端点**已核实**：`backend/app/api/personas.py:87` `POST ""`、`:150` `PUT /active`、`:175` `PUT /{persona_id}`。
  删除/读取端点自己 grep 核实；角色库端点同理（`backend/app/api/characters.py`）。**核不到就停手**，
  并在报告里写"缺后端能力"，不要在前端造一个只在内存里生效的假通道。
- 写侧一律**限定当前登录用户自己的数据**（本仓是多用户产品，不是自用玩具；零配置是硬线，但越权是红线）。
- `importRawCharacter` / `RawCharacter` 属"卡能往库里灌任意对象"：先读 ST/助手的一手声明确定它接受的原始形状，
  **只按声明的字段落库**，多余字段丢弃并留痕（别整包塞进 JSON 字段）。
- ⚠️ 本仓已知陷阱：合并 palink-new 时曾出现"helper 建书没传 `character_id` 导致 34 个测试红"
  ⇒ 建人设/角色时必须把归属字段传全，写测试要覆盖"缺归属字段"的失败路径。

**怎么做**

1. 先把 18 键的 d.ts 契约与后端端点做一张对照表（键 → 入参 → 后端方法/路径 → 是否可达），
   **不可达的那几行直接标"缺后端"**，不要硬凑。
2. 能落地的按 A 的同一套路子做（父侧动作 + 帧内成员指向同一实现）。
3. 写侧全部走"自建测试对象 → 验 → 列清单 → 清理"的循环，报告里贴清单。

**验收标准**

- 每个键：真机帧内实调读数（形状/类型/失败语义），**枚举命中不算实现**（本仓 `covered_in` 恒满分的教训）。
- 越权防护有测试：用另一个用户的 id 调用必须失败（不是静默成功）。
- 删除类跨进程复核（同 A）。
- 反证 + 门禁 rc=0 + 记账连带（§5）。
- 报告里给一张**18 键的落地表**：已实现 N / 缺后端 M / 契约不明 K，三数相加=18，不许含糊。

---

## C · `window.context` 的一手结论与真正该做的事

**主脑一手核实（两棵树 + 酒馆助手插件源码都查过）**：

- ST 里 `context` **永远是局部变量**：`const context = getContext();`
  （`authors-note.js:325/444`、`extensions.js:90/2062/2144`、`slash-commands.js:3892`、`utils.js:1344`、
  `world-info.js:1116` 等多处同形）。
- `grep -rn "window.context" /d/SillyTavern-release/public/scripts/*.js` ⇒ **0 命中**；
  `window.getContext` / `globalThis.getContext` ⇒ **0 命中**；酒馆助手插件全仓 `window.context` ⇒ **0 命中**，
  其 `@types` 里也没有 `context` 这个名字。

⇒ **按用户的"冲突以 ST 为准"，结论是：不要摆 `window.context`**（摆出来才是造 ST 没有的形状）。
要做的是两件事：

1. **改 W 记录器那条启动留痕的措辞**：现在写的是"我们未提供这个全局"，读起来像我们的缺陷；
   事实是 **ST 亦无此全局**，卡的这种写法本身不合规。改成如实措辞（保留记录，别删——它正是"哪张卡在这么写"的证据）。
   ⚠️ 这条改的是 `palink-diag.ts` 与 `runtime-body/part-01.ts` 里那段启动留痕的**文案**，不要改判定逻辑。
2. **把 getContext 那 6 个"有名字没实物"的键逐个处理**：`CONNECT_API_MAP`、`chatMetadata`、
   `getPresetManager`、`getRequestHeaders`、`tagMap`、`tokenizers`（真机实测清单，`ctxMissing=[]`、`ctxNotReal=6`）。
   逐个一手核 ST：能真做的做（如 `getRequestHeaders` 只是返回一个带头信息的对象）；
   做不到的（如 `getPresetManager` 依附 ST 预设对象模型 = 台账乙类 XL）就留 `// [ST-GAP:preset_prompt]` 说明
   并在报告里写"为什么现在不做"。

**验收标准**：6 键逐个给"做了/没做 + 一手锚点 + 帧内实调读数"；记录器文案改动有测试钉住
（断言新措辞在场、旧措辞不在场）；门禁 rc=0。

---

## D · 前端不弹错 + 服务端自动留痕（用户已授权，含一条红线变更）

**用户原话**：可以在前端不报错，后端日志记录（我们处于开发状态，允许后台记录报错自动保存，方便以后查验）。

**红线变更（必须写进代码注释与报告）**：包W 的记录器原红线是"零网络：不 fetch、不上传，导出只在本地下载"。
2026-10-20 用户**明确授权放开**为：**在记录器已启用的前提下**（本机站点或手动开关）允许把记录上传到自家后端留痕。
放开是有条件的，三条硬约束不许放宽：

1. **上传闸门沿用 `palinkDiagEnabled()`**（本机/内网/手动开）；外部站点默认关 ⇒ 公网访客不会往我们后端灌日志。
   ⚠️ 现实风险：站点注册开关仍开着且公网可达（`docs/OPEN_ISSUES.md` 第 19 条）⇒ 必须再加**服务端侧**的限流与体积上限。
2. **只上传结构化字段**：owner/kind/name/count/filename/lineno/missingStSubsystem/frameId/cardId/textLength。
   ⛔ **正文一个字都不许上传**（用户明令不看自己的卡内容；`detail`/`stack` 里可能含正文片段 ⇒ 服务端只存长度与摘要哈希）。
3. **失败必须静默**：上传失败不许弹框、不许重试风暴（最多一次，失败就只留本地），也不许影响页面。

**怎么做**

1. 后端：新增一个只追加的留痕端点（建议 `POST /api/diagnostics/records`，走既有鉴权与 CSRF），
   落**文件**而不是库（JSONL 追加 + 按天切分 + 单文件上限与轮转），位置放 `backend/data/diagnostics/`
   （该目录已是红线保护区，只增不删），并写清"这是开发期留痕，不是产品功能"。
2. 前端：`palink-diag.ts` 里加节流上传（建议：每 N 条或每 M 秒一批，且总量封顶），
   开关关闭时**连组装都不做**（零开销原则，沿用现有实现风格）。
3. 202 条未实现命令：维持"执行返回空串、前端不弹框"现状（用户裁决 5），
   但确保每一条都进记录器（`slash_command_unimplemented`）并随批次上传 ⇒ 以后能查"哪条命令真被踩过"。

**验收标准**

- 后端测试：鉴权失败 401/403、超大体积被拒、非 JSON 被拒、同一批重复上传不重复计数（幂等键或去重）。
- 前端测试：开关关闭 ⇒ **零 fetch**（用 spy 断言调用次数为 0）；开关开启 ⇒ 上传体里**不含** `detail`/`stack` 原文
  （断言字段白名单，逐个键比对，不许用"包含某串"糊过去）。
- 真机：本机页面产生记录后，`backend/data/diagnostics/` 下当天文件里能读到同样条数（贴行数对账）。
- 反证：把上传闸门改成恒开 ⇒ "外部站点不上传"的测试必须红。
- 门禁 rc=0（前后端都跑）。

---

## E · 已搁置（不要做）

历史脏正文回填：用户裁定"不着急，我可以直接把卡删了"⇒ **本批不做**。
若将来要做：先备份、只跑一个会话、行数对账、且不许读用户聊天正文（只读结构）。

---

## 5. 每个批次交回时必须连带的记账（不做等于没做完）

1. **台账行订正**：`SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` §2 对应行加"已实现（日期/提交）"，
   原文不删（只进不出）。`registerMacroLike` 那行由 pkg-AA 处理，别重复改。
2. ⚠️ **不要从 `palink-diag.ts` 的 `ST_GAP_BY_NAME` 里删名字**：守门测试
   `st-gap-ledger-guard.test.ts` 的 D 组断言"包H §3 的每个 D 类键都能归类"，删名字会让它红。
   已实现的键留在表里是无害的（实现了就不会再产生那条记录），只在注释里标"已实现于 <提交>"。
3. **包H 报告计数订正**：D→C 改判后，A/C/D 三个数（13/45→/76→）要在 `REPORT_包H_*` 加订正说明。
4. **三个口径分开报**：权威名数 / 表内键数 / 真实现数。`covered_in` 恒 289 已作废为判据，别拿它当成果。
5. 报告落 `docs/_active/report/REPORT_包<代号>_<主题>_2026-10-20.md`，首部写状态；动了 `docs/` 就刷目录
   （`py scripts/docs/gen_docs_catalog.py` 后 `--check`，把 `OK ... docs` 那行贴进报告；注意提交后目录可能再变一次）。

## 6. 交验口径（主脑会独立复跑这六项，不看"我认为没问题"）

1. `bash scripts/gate.sh frontend`（+`backend`）退出码与 `failed=0 / errors=0`；
2. 每个新测试文件**单独跑**并报用例数（0 用例=不存在）；
3. 至少一次反证的**原始输出** + 还原后 `git status` 干净；
4. `git show --stat` 文件清单逐条对照本文件的批次边界，越界退回；
5. 动过 `runtime-body/part-*.ts` ⇒ `generated-script-parse-guard` 绿，且执行型断言用求值后载体；
6. 真机读数（:16000 或旁路 dev 探针）原文，含"改前/改后"两次的数字。

**串行顺序建议**：A → B → C → D（A/B 同改 `part-07.ts` 必须串行；C 改 `part-01.ts`/`palink-diag.ts`；
D 改 `palink-diag.ts` + 后端 ⇒ C 与 D 也要串行）。一批交回、主脑验完再开下一批，**不要四批一起动**。
