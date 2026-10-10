# AGENTS.md — Palink-AI 开发方向声明

> 所有 agent（Claude Code / Codex / TRAE / 其他）在修改本项目前，请先阅读本文件。
> 本文件描述**当前主攻方向**，避免误解代码意图。

## 当前主攻：palink-native 模式

本项目目前**只维护和优化** **`palink-native`** **模式**（Palink 原生提示词装配 + Palink 前端插件体系）。

### 三种 silly\_tavern\_mode 的状态

| 模式              | 含义                                                 | 状态                                  |
| --------------- | -------------------------------------------------- | ----------------------------------- |
| `palink-native` | Palink 原生提示词装配（后端 `build_character_chat_messages`） | **主攻、唯一维护、唯一可达**                    |
| `st-compat`     | 服务端 ST 1.18 对齐装配（后端 `build_st_compat_messages`）    | **已于 2026-09-03 删除**（091023e）        |
| `st-native`     | iframe 嵌入完整 SillyTavern（前后端 ST sidecar 链路）         | **已于 2026-09-03 删除**（aeb8348/4eadb86） |

### 重要约定

1. **ST 双轨已于 2026-09-03 删除完毕**（用户授权，三笔 commit：`091023e` 阶段1 后端装配、`aeb8348` 阶段2 前端/静态/nginx、`4eadb86` 阶段3 路由/部署/源码副本）。权威施工 spec：`docs/SPEC_ST双轨剥离删除_st-compat与st-native_2026-09-03.md`。
   - 历史脉络：2026-08-24 运行时强制封存（MODE-SEALED）→ 2026-09-03 代码剥离删除。封存守卫（`SEALED_ST_MODES`/`_st_mode_effective`/`_is_st_compat_mode`）已随删除消失，无解封开关。
   - `silly_tavern_mode` / `silly_tavern_theme` 字段已于 2026-09-04 A1 收尾全链删除（`bbfe0f0`，alembic 0062 drop 列，DB 已迁移）。**T1 红线：`backend/app/core/migrations.py` 的 `_RUNTIME_COMPAT_COLUMNS` 补列清单禁止回填这两列**（否则后端重启把列重建回来）。PUT 请求体携带这两个旧键会被 pydantic 静默忽略（合法行为，非 bug）。
2. **残留清理未完成的部分**（后续如要动，需另立议题）：
   - `st_groups.py` 虽名为 st_ 前缀，实为 **Palink 自有群聊后端**。**勿按名字误删**。
     ⚠️ 消费链已于 2026-09-20 变更（原描述"消费方 `NativeRoleplayChat` 的 groupChatManager"已失效）：该组件已删除（其 import 在删除前早已注释于 `CharacterChat.tsx:69`）。现 `lib/group-chat/*` 的唯一存活消费者是 **`lib/sillytavern/getContext.ts:21`**（向 ST 插件提供 `groupId`/`groups`，并经 `sandbox.ts` 的 `group-chats.js` 模块名下发）。口径：**群聊数据链路仅经插件面可达，第一方群聊 UI 目前为空**；`overview.md` 记录的 ≈85% 后端群聊对齐属该插件面能力。动 `st_groups.py` 前按此评估影响面。
   - `st_sync_service.py` 为共用模块，被 character/personas/worldbook/character_ext 等主链路引用，**保留**。
   - `backend/app/core/config.py` 的 `ST_NATIVE_*` 字段仍在用（`silly_tavern.py` 的 sidecar 转发函数——现仅 elevenlabs 语音三端点消费、`st_sync_service.py`、`core/security.py` 的 N-6 HMAC 签名），2026-09-05 端点瘦身已删 extensions 死代理族；`ST_NATIVE_SERVICE_URL` 的唯一消费链是 elevenlabs 转发，后续如删 elevenlabs 需同批清理。
   - ~~`api/st/native/proxy`、`/csrf-token`、`/api/st/csrf-token` 保留~~ → **均已删除**（第三/四批端点瘦身，2026-09-04/05）。
3. **Palink 前端插件体系（插件沙箱、regex 引擎、generate\_interceptor、`st-plugins/`** **目录）全部属于** **`palink-native`**，与已删的 st-native 无关。
4. 提示词装配唯一模式是 `palink-native`（`silly_tavern_mode` 列已删，装配无模式分支），不要无授权改动装配链。
5. 遇到 `silly_tavern_mode` / `st-compat` / `st-native` 相关代码时，优先按"palink-native 主攻"的立场评估修改影响面。**命名陷阱（勿因名字删）**：`synthesize_tts_st_compat`（Palink TTS 端点，在用）、`'st-compat-v2'`（智能卡 runtime 版本标签）、`st-vec::`（记忆向量前缀）、`get_st_current_user`（共享认证依赖）、`lib/group-chat/`（第一方 UI 已删但它经 `getContext.ts` 活着，勿连带误删）。
6. ⚠️ **「ST 双轨已删」≠「ST 兼容层可删」**（2026-10-10 订正，依据：
   `docs/_active/report/REPORT_悲观刻薄审计_第二次全仓体检_2026-10-10-new.md` 文首订正）。
   已删除的是 **st-native（iframe 嵌入完整 ST）** 与 **st-compat（服务端 ST 1.18 装配）**
   两个**模式**；但 **"Palink 原生模式"的卡片渲染底座，本身就是一个 SillyTavern 兼容运行时**，
   后端仍在提供卡片 runtime 所需的 ST 风格端点。这些是**在用的生产代码，不是残留**。
   引用链（动它们之前**必须**先查）：
   - `CharacterCardRenderer.tsx:10` → import `buildSillyTavernCompatRuntimeV2Shim`（`:435` 调用）
   - `smart-card-runtime/helpers.ts:6` → import `LEGACY_ST_SIM_SEGMENT`
   - `api/__init__.py:37/55` → 注册 `silly_tavern_router`（带 `csrf_guard`）
   - `RoleplayEngineTab.tsx:173` → 实调 `POST /api/settings/get`
   ⇒ **禁止以"ST 已删"为由删除** `SillyTavernCompatRuntime.ts`(6961 行)、
     `legacy-st-sim.ts`(2452 行)、`api/silly_tavern.py`(6247 行)。
     要做瘦身就**逐个端点查调用方**（`grep -rn "<path>" frontend/src backend/app`），
     **不要按名字删、不要整文件删**。
   ⇒ 同理，审计报告里凡涉及"删"的建议，动工前先做引用链复核 ——
     **"看起来像残留"和"真的是残留"之间，隔着一个 grep。**

## 待办（跨 agent 协作）

- **所有 agent 在动工前请先阅读根目录** **`TODOS.md`**（遗留任务、方向决策、进行中的工作项）。

- 它是本项目跨会话/跨 agent 的待办与决策记录，修改前先同步，完成后按其状态更新。

## 核心代码位置

- 后端提示词装配：`backend/app/services/roleplay_prompt_assembly.py`

- 后端消息构建：`backend/app/services/character_message_builder.py`

- 前端插件沙箱：`frontend/src/lib/plugin-system/`

- 前端 ST 插件 runtime：`frontend/src/utils/sillyTavernPluginRuntime.ts`

## 验证

### ⚠️ 验证纪律（2026-10-10 立 · 强制 · 违反视为事故）

> **为什么立这条**：本仓曾出现 `backend/pytest_gate3.log` 末行
> `1903 passed, 48 skipped, 384 warnings, 84 errors` 被当作「门禁通过」存档。
> **工具一直在报警（pytest 退出码 = 1），是人只读了 passed 数字。**
> 详见 `docs/_active/report/REPORT_悲观审计_项目可信度体检_2026-10-10.md`、
> 施工方案见 `docs/_active/spec/SPEC_验证体系修复_2026-10-10.md`。

1. **唯一门禁入口**：`bash scripts/gate.sh`（全跑）／`bash scripts/gate.sh backend|frontend|docs`。
   任一阶段非 0 → 脚本退出 1。**不要用散装命令自己拼门禁。**
2. **退出码就是结论**。实测（2026-10-10）：pytest 在 `1 passed, 1 error` 时退出码 = **1**。
   所以下列三种写法一律禁止，**谁加回去谁就是把门禁变回安慰剂**：
   - `|| true`
   - `continue-on-error: true`
   - `--continue-on-collection-errors`
3. **验收口径只认两个数**：`failed = 0` 且 `errors = 0`。
   **passed 的数字不是验收线**（它随并行会话增长而漂，今天 1999 明天可能 2100）。
4. **遇到批量 setup error，先查守卫，不要先猜外部依赖**（2026-10-10 血的教训）：
   第一步就是 `grep -n "SystemExit\|safe-delete" <日志>`。
   本仓已知机制：安全删除守卫按**单次批量删除 ≥ 50 个文件**拦截并抛 `SystemExit`，
   临时目录被删到一半 → 后续用例在 setup 阶段连带崩
   （历史上一次产生 **1 个 SystemExit + 83 个 AssertionError**）。
   **永远不要把 pytest 的 `--basetemp` 指进仓库内** —— `backend/.pytest_tmp` 已入 `.gitignore`，
   它就是上述 84 errors 的病灶。
5. **禁止用 skip 掩盖失败**。下列三样是历史遗留（正在清理），**不得新增同款**：
   - 「import 失败 → 整文件 `pytestmark = skipif(not _IMPORT_OK)`」——曾覆盖 38 个文件，
     等于把**编译错误降级为 skip**，模块一改名整个文件静默消失。
   - 「源码文件不存在 → `pytest.skip`」——曾 46 处，Python 测试去 grep 前端文件在不在，
     **测的是「文件在不在」，不是「行为对不对」**。
   - 「假理由空壳」——曾 28 处，写 `requires DB session`，
     而 `backend/tests/conftest.py:84` 的 `db_session` fixture 有 55 个文件正在正常用。
   **真跑不了就删掉用例，不要留 skip 占位充数。**
6. **改了 `docs/` 就跑 `python scripts/docs/gen_docs_catalog.py`**（提交前），
   至少 `--check` 必须是 `OK`。CI 有 docs job，STALE 会让它红。
7. **CI**：`.github/workflows/ci.yml`（后端 pytest / 前端 tsc+vitest / 文档目录）。
   ⚠️ **2026-10-10 订正**：该文件**此前从未进过版本库**（`git ls-files .github` 返回空），
   只存在于本地磁盘 ⇒ 在任何 CI 平台上**从未真正运行过**。
   这是"200+ 项改动长期未提交却无人拦下"的直接原因之一：**当时根本没有门禁在跑**。
   已于 2026-10-10 批次 C（`c7ef194`）首次入库；`scripts/gate.sh` 同样是从未入库过的
   （同批发现），已在 `ddcef2e` 入库。
   ⇒ 判据：**不要因为"文档写了有 CI"就以为有 CI**。
   验证方式：`git ls-files .github` 与 `git ls-files scripts/gate.sh`。
   后端 CI 用 `backend/requirements-test.txt`（已剥离需 C++ 编译的 `llama-cpp-python`
   与体积大的 `faster-whisper`，依据是二者在 `app/` 里均为**函数内惰性** import、`tests/` 零引用）。
   **生产镜像仍用 `requirements.txt` 完整版** —— 两份都要维护，往 test 版加依赖前先确认是顶层还是惰性 import。
8. **判定「修好了」必须用与生产一致的入口复核**，不能用单点探针。
   （2026-10-10 踩过：单独跑两个文件 28 passed 就宣布「84 errors 已修复」，全量跑照样红。）

- 后端：`cd backend && python -m pytest tests/`

- 前端：`cd frontend && npx tsc --noEmit`

- 前端自动检查：`cd frontend && npx vitest run`（2026-09-23 起为唯一入口；2026-10-03 实测基线：**50 文件 / 665 passed + 3 skipped**，其中 3 例是转换前既有的 `it.skip`。⚠️ 文件与用例数随并行会话增长，别把固定数字当验收线，只认 `failed = 0`）

  > `npm run test:contract` 与 `frontend/src/lib/sillytavern/__tests__/_tsx-loader.mjs` **已删除**：契约测试全部转入 vitest，浏览器环境由 `vitest.config.ts` 的 `environment: 'jsdom'` + `frontend/src/test/setup-browser-globals.ts` 提供。docs/ 下 2026-09-22 及更早的 spec、报告仍把 `test:contract`（162/173 项）写成回归门禁口径，一律按本条作废并改跑 vitest。

- ⚠️ **提交 ≠ 上线**：改了后端必须 `docker compose build backend && up -d backend`，
  改了前端必须重建 dist 并确认容器在服务新指纹。**提交完不重建容器 = 用户跑的是旧代码**
  （2026-10-03 踩过：提交了 ST 世界书绑定修复却忘重建，容器内 grep 命中数为 0）。

- ⚠️ **声称「已完成」前必读** `docs/SOP_Agent交付自查清单.md`（2026-10-03 立）。
  那一轮审查发现：承诺 12 项实测 9 真修 / 2 未做 / 3 假修，另有 4 条记录本身写错、3 次日期写成次日。
  重点是这几条容易复发的：**①「文件消失」要先回原目录确认，消失≠被删（可能压根没复制）**
  **② 改数据契约后测试集体红属预期连带成本，先看同批测试在来源工作区是否绿，别急着回退源码**
  **③ 按清单改完必须再全仓 grep 一次（清单本身会漏）**。

- ⚠️ **离线探针的参数必须与生产调用点一致，否则「修复生效」是假阳性**（2026-10-05 踩过）：
  验证世界书修复时直调 `build_worldbook_context`，漏传 `max_context_tokens`
  → 服务内回退 `DEFAULT_BUDGET`（16000），预算变成 4000 而非生产的 1024
  → 探针报「5 条条目到位」，真实装配是 0 条。**修复被预算裁剪完全遮蔽，
  这个假结论还写进了交接文档**，下一个人会照着它继续做。
  判据：能走真实入口（如 `assemble_roleplay_prompt`）就不要手工重建中间步骤；
  探针必须打印它实际收到的参数，并与生产调用点逐项对照后再采信结论。
  同一轮另有 4 个结论被我自己的复核否证（sandbox/IndexedDB/「点信任可验证」/
  「刷爱意即可解锁」），**读代码得到的绝对结论一律先实测**。

- 📄 **动了 `docs/` 就刷目录**：`python scripts/docs/gen_docs_catalog.py --check`
  （退出码 0 = 目录与磁盘一致；1 = 有人加了文档没刷新）。
  详见「文档存放规范 → 目录自动化」。**这条替代了"手工维护 `_CATALOG.md`"的老规矩。**

## 文档存放规范（强制 · 2026-10-05 起施行）

> 适用于所有 agent。**新建文档一律放 `docs/_active/`，不要放 `docs/` 顶层。**

背景：2026-10-05 清理时 `docs/` 顶层堆了 **166 份** markdown，34 份是做完即过期的一次性记录。
根因不是没人整理，是**没有归档规矩**——写完就留原地，后来的人分不清"还在用"还是"早作废"，
只能靠文件名猜。

1. **放哪里**（详见 [`docs/_active/_README.md`](./docs/_active/_README.md)）：
   施工规格书 → `_active/spec/`；排查/审计结论 → `_active/report/`；
   交给下一 agent 的提示词 → `_active/prompt/`；交接书/提测单 → `_active/`。
   判断依据是"读它的人要干嘛"：要照着做的、要信它结论的、要派活的。
2. **保留现有多段前缀**（`SPEC_` / `REPORT_` / `PROMPT_` / `HANDOFF_` 等）**且前缀必须在开头**。
   全仓文档靠前缀分类，索引按它统计——**不要改这套前缀**。日期写在文件名里，格式 `_YYYY-MM-DD`。
3. **首部自述状态**（待施工/施工中/已完工待验收/已作废+被谁取代）。这是别人唯一能免费判断新旧的地方。
4. **完工后下沉**：一批做完且过保鲜期，按 `docs/_archive/_README.md` 判据收进 `_archive/YYYY-MM/`。
   **按内容真实日期归月，不信文件名**（实测 `CODE_QUALITY_AUDIT_REPORT.md` 内容是 2026-05，
   `ST_COMPAT_FORK_AUDIT_2026-08-17.md` 内容首次提及却是 09 月）。
5. **只进不出**：不删、不改写已有内容，纠错在标题下**加订正说明**；作废的保留并写明被谁取代。
6. **零入链才可搬**：搬之前全仓 grep 文件名，无任何引用才动；有引用的先改引用再搬
   （全仓引用几乎都是裸文件名，移动造成的断链是**静默的**）。
7. **待办不塞这里**：`docs/_active/` 管文件放哪，`docs/OPEN_ISSUES.md` 管优先级，两件事分开。
8. ⚠️ **找文件时顶层和 `_active/` 都要搜**。2026-10-05 迁移只搬已过期的，活文件仍在顶层。
   检索入口见 [`docs/_INDEX.md`](./docs/_INDEX.md)（可信度分级）、
   [`docs/_CATALOG.md`](./docs/_CATALOG.md)（文件清单，按前缀/状态统计）。
9. ⚠️ **`_CATALOG.md` 由脚本生成，不要手工编辑**（见下节「目录自动化」）。
   它只回答"有没有这份文件、在哪、是什么前缀"，**不回答"这份能不能照做"**。
   要状态和可信度，**必须打开那份文档读首部**，别信目录里的数字。
10. **交付前刷新目录**：只要你新增/移动/改名了任何文档，提交前必须跑
   `python scripts/docs/gen_docs_catalog.py`（见下节）。

### 目录自动化（2026-10-05 起 · 替代手工维护）

`docs/_CATALOG.md` 是**自动生成**的，生成器在 `scripts/docs/gen_docs_catalog.py`。
理由：手工维护的目录当天就写明"会立刻过时"，实测 222 份文档里 187 份首部没写状态标记，
靠人维护一份 200+ 条的清单不现实。

| 你要做的 | 命令 |
|---|---|
| 刷新目录 | `python scripts/docs/gen_docs_catalog.py` |
| 只校验是否过期（不改文件） | `python scripts/docs/gen_docs_catalog.py --check` |

**规矩**：
- **改了 `docs/` 就必须跑一次**（新建 / 移动 / 改名 / 归档都算），这条是强制的。
  跑完把 `--check` 的输出（`OK ...` 或 `STALE ...`）贴进你的交付记录当证据。
- **不要手工编辑 `_CATALOG.md`** —— 下次生成会被覆盖。要改内容改生成器，
  或改它指向的 `_INDEX.md`（可信度分级）/ `OPEN_ISSUES.md`（优先级）。
- **"文档状态"和"文档可信度"仍然只能人写**，脚本不猜。
  结论写进 [`docs/_INDEX.md`](./docs/_INDEX.md)（分级）和 [`docs/OPEN_ISSUES.md`](./docs/OPEN_ISSUES.md)（待办），
  脚本只提供原料。这条边界不许被"自动化"三个字抹掉。
- ⚠️ **没有挂进 `.githooks/`**：§备份与清理规范 第 6 条把 `.githooks/` 列为红线目录
  「一律不动」，且共享工作区里 hook 自动写文件会碰到别人的暂存区。
  **所以这一步靠每个 agent 自己跑，不是 hook 强制。**

## 备份与清理规范（强制 · 2026-09-30 起施行）

> 适用于所有 agent（Claude Code / Codex / TRAE / WorkBuddy / 其他）。违反第 1、2、4、5 条视为事故。

1. **唯一备份区**：所有代码/数据备份一律放入 `D:\项目\Palink-AI\_BACKUPS\YYYY-MM-DD_主题名\`。
   **禁止**在项目根目录、`D:\`、`D:\项目\` 或任何其他位置新建备份目录或备份文件。
   2026-09-30 之前散落在上述位置的备份已全部归置进来（详见 `_BACKUPS/_INDEX.md`），此后新出现的区外备份一律按违规残留处理。
2. **说明文件强制**：每个备份目录必须含 `BACKUP_INFO.md`，四项要素缺一不可 ——
   ① 备份日期 ② 原始来源路径 ③ 备份原因 ④ **后续待办清单**（备份之后需要修复或修改的任务）。
   **没有说明文件的备份视为无效备份**，不被承认，也不得引用其结论。
3. **台账登记**：每次备份完成后必须更新 `_BACKUPS/_INDEX.md`，登记「备份日期 / 目录名 / 原始来源 / 备份原因」。
   台账的目的是可追溯：任何人都能从新位置找回原来的东西。
4. **禁止动存量备份**：任何 agent **不得删除或改写已有备份的内容**。
   本次归置只改变位置，目录内部零改动、零重命名。需要历史文件时，**复制**出来用，不要在原备份上改。
5. **清理三步，禁止直删**：清理工作区前必须先输出明确待删清单并取得用户确认，流程固定为
   **① 列清单 → ② 隔离到 `_BACKUPS/_QUARANTINE_<日期>/`（保留原相对路径，随时可拷回）→ ③ 门禁验证通过且用户确认后再删除**。
   禁止跨过确认直接删除任何文件。
6. **红线，一律不动**：
   - `frontend/dist` —— 容器 nginx bind mount 的在用产物，**删除或改名即前端白屏**（2026-09-30 清理已确认此边界）。
   - `backend/data` —— 412MB 业务数据（上传物、历史库）。
   - 根级 `图片/`、`记忆/`、两个 `屏幕录制*.mp4` —— 用户私人素材，非产出物。
   - `.claude/` `.codex/` `.trae/` `.workbuddy/` `.githooks/` 等 agent 与钩子配置目录。
7. **git 边界**：`.gitignore` 已配置「`_BACKUPS/**` 全部排除 → 仅放行 `_INDEX.md` 与各 `BACKUP_INFO.md`」。
   备份产物（repo.bundle / *.tar.gz / *.tgz / 源码全量拷贝等约 12GB）**永不入库**，
   但台账与说明文件**必须入库**。禁止用 `git add -A` / `git add .` 绕过该规则（多 agent 合住仓库，一律逐项 pathspec 暂存）。
8. **同步范围**：本规范同步记录于 `.workbuddy/memory/MEMORY.md`，两处保持一致，改一处即改另一处。

