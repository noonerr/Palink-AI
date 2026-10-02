# _BACKUPS 统一备份台账
> 本文件是 Palink-AI 项目所有备份的唯一索引。建立日期：2026-09-30。
> 规则：今后所有代码备份**必须**放入 `D:\项目\Palink-AI\_BACKUPS\`，禁止在项目根目录、`D:\`、`D:\项目\` 或任何其他位置新建备份。详见 AGENTS.md「备份与清理规范」。

| 备份日期 | 目录名 | 原始来源 | 备份原因 |
|---|---|---|---|
| 2026-04-06 | [`2026-04-06_全量代码打包zip`](./2026-04-06_全量代码打包zip) | `D:\项目\backup` | 早期（4 月）由 backup_script.ps1 生成的代码+配置全量打包，最后一个包时间点 2026-04-06 19:18。 |
| 2026-06-08 | [`2026-06-08_source-snapshot`](./2026-06-08_source-snapshot) | `D:\项目\Palink-AI-backups\20260608-001219` | 全仓库源码快照（动大手术前的整树打包），当时工作区有大量改动。 |
| 2026-08-17 | [`2026-08-17_worktree-safety`](./2026-08-17_worktree-safety) | `D:\项目\Palink-AI-worktree-safety-20260817-1211` | 在一次高风险 git 操作前做的全量目录拷贝备份（同期发生过 .git 损坏事故，此目录即当时的安全网）。 |
| 2026-09-02 | [`2026-09-02_mimosa-scan-snapshot`](./2026-09-02_mimosa-scan-snapshot) | `D:\mimosa-scan-snapshot-palink-20260902` | 外部扫描工具（mimosa）对项目的一次全量快照，快照内容以根目录 md 文档为主。 |
| 2026-09-03 | [`2026-09-03_pre-memory`](./2026-09-03_pre-memory) | `D:\项目\Palink-AI-backup-pre-memory-20260903` | 记忆相关改动施工前的工作区 git 状态备份，与 ST 双轨删除（091023e / aeb8348 / 4eadb86）同期。 |
| 2026-09-06 | [`2026-09-06_pre-ui-p0`](./2026-09-06_pre-ui-p0) | `D:\项目\Palink-AI-backup-pre-ui-p0-20260906` | 前端 UI P0 批次改动前的源码整包备份。 |
| 2026-09-07 | [`2026-09-07_ui-backup`](./2026-09-07_ui-backup) | `D:\项目\Palink-AI\frontend\.ui-backup-2026-09-07` | 前端 UI 改动前的前端备份（隐藏目录形式留在 frontend/ 下）。 |
| 2026-09-15 | [`2026-09-15_perf-p0`](./2026-09-15_perf-p0) | `D:\项目\Palink-AI-backups\perf-p0-20260915-1205` | 性能 P0 批次改动前的前端备份（含已构建产物，便于直接对比效果）。 |
| 2026-09-23 | [`2026-09-23_pre-deadcode`](./2026-09-23_pre-deadcode) | `D:\项目\Palink-AI\Palink-AI-backup-pre-deadcode-20260923` | 死代码清理施工前备份（项目内副本，仅 backend 子树，无 manifest）。 |
| 2026-09-23 | [`2026-09-23_pre-deadcode-full`](./2026-09-23_pre-deadcode-full) | `D:\项目\Palink-AI-backup-pre-deadcode-20260923` | **死代码清理权威物理备份**：带 `_manifest.tsv`（sha256 + 恢复目标路径），对应 git tag `pre-deadcode-20260923`(9fde679)。含 backend + frontend + repo 三组。 |
| 2026-09-23 | [`2026-09-23_vitest-infra-loader`](./2026-09-23_vitest-infra-loader) | `D:\项目\Palink-AI\backup\2026-09-23_vitest-infra` | 删除 `npm run test:contract` 契约测试入口与 `_tsx-loader.mjs` 之前的备份（契约测试整体迁入 vitest）。 |
| 2026-09-23 | [`2026-09-23_记忆清理-sql`](./2026-09-23_记忆清理-sql) | `D:\项目\Palink-AI\backups\2026-09-23-记忆清理` | 对 `conversation_memories` / `user_settings` 做清理前的数据库导出备份。 |
| 2026-09-24 | [`2026-09-24_tts-merge`](./2026-09-24_tts-merge) | `D:\项目\_palink_backups\2026-09-24_tts_merge` | TTS（语音）相关改动合并前的备份，对应 2026-09-24 语音复核与出图交接。 |
| 2026-09-26 | [`2026-09-26_L0-插件按需启用`](./2026-09-26_L0-插件按需启用) | `D:\_palink_backup_20260926_L0` | 「插件按角色卡按需启用」施工 L0 批次前的备份，对应 docs/SPEC_插件按角色卡按需启用_2026-09-26.md。 |
| 2026-09-26 | [`2026-09-26_L1-装配defer与插件隔离`](./2026-09-26_L1-装配defer与插件隔离) | `D:\_palink_backup_20260926_L1` | 同 SPEC 的 L1 批次备份：装配链 defer 改造与插件角色隔离。 |
| 2026-09-27 | [`2026-09-27_P1-截图证据`](./2026-09-27_P1-截图证据) | `D:\_palink_backup_20260927_P1` | 某次 UI/功能验证的截图证据目录（P1 批次），仅含 shots。 |
| 2026-09-27 | [`2026-09-27_promptST-身份层ST化`](./2026-09-27_promptST-身份层ST化) | `D:\_palink_backup_20260927_promptST` | 「提示词身份层 ST 化 / 删除第一第三人称切换」施工前备份，对应 docs/SPEC_提示词身份层ST化_删除第一第三人称切换_2026-09-27.md。 |
| 2026-09-27 | [`2026-09-27_角色卡导出-csv`](./2026-09-27_角色卡导出-csv) | `D:\项目\Palink-AI\backups\*.csv` | 测试角色卡与其插件状态的一次性数据导出（从数据库导出为 csv 后散落在 backups/ 根目录）。 |
| 2026-09-28 | [`2026-09-28_depthfloor-注入落点`](./2026-09-28_depthfloor-注入落点) | `D:\_palink_backup_20260928_depthfloor` | 「注入落点对齐 ST depth 下限与漏删清理」施工前备份，对应 docs/SPEC_注入落点对齐ST_depth下限与漏删清理_2026-09-28.md。 |
| 2026-09-28 | [`2026-09-28_localimg-本机出图`](./2026-09-28_localimg-本机出图) | `D:\_palink_backup_20260928_localimg` | 「文生图浏览器桥接 / 本机 ComfyUI」方案落地前的 git 状态备份，对应 docs/SPEC_文生图浏览器桥接执行_本机ComfyUI_2026-09-28.md。 |
| 2026-09-28 | [`2026-09-28_mvuprompt-screen`](./2026-09-28_mvuprompt-screen) | `D:\_palink_mvuprompt_screen_20260928` | MVU 提示词筛查的实验产物（非源码备份），用于多组提示词变体打分。 |
| 2026-09-28 | [`2026-09-28_mvuprompt-依从性筛查`](./2026-09-28_mvuprompt-依从性筛查) | `D:\_palink_backup_20260928_mvuprompt` | 「MVU 提示词依从性零成本筛查」施工前的整仓 git bundle 备份，对应 docs/SPEC_MVU提示词依从性零成本筛查_2026-09-28.md。 |
| 2026-09-28 | [`2026-09-28_mvusse-SSE补齐`](./2026-09-28_mvusse-SSE补齐) | `D:\_palink_backup_20260928_mvusse` | 「MVU 变量更新 SSE 侧补齐与取证」施工前的整仓备份，对应 docs/SPEC_MVU变量更新SSE侧补齐与取证_2026-09-28.md。 |
| 2026-09-28 | [`2026-09-28_review-装配比对`](./2026-09-28_review-装配比对) | `D:\_palink_review_20260928` | 装配链路人工比对用的临时脚本集（character / default_prompts 的 head 版对照）。 |
| 2026-09-29 | [`2026-09-29_imageprompt-提示词智能化`](./2026-09-29_imageprompt-提示词智能化) | `D:\_palink_backup_20260929_imageprompt` | 「出图提示词智能化与多设备算力路由」施工前备份，对应 docs/SPEC_出图提示词智能化与多设备算力路由_2026-09-29.md。 |
| 2026-09-29 | [`2026-09-29_review-世界书探针`](./2026-09-29_review-世界书探针) | `D:\_palink_review_20260929` | 世界书向量接入口的一次性探针脚本。 |
| 2026-09-29 | [`2026-09-29_worldbookvec-向量召回`](./2026-09-29_worldbookvec-向量召回) | `D:\_palink_backup_20260929_worldbookvec` | 「世界书向量召回接通与防护」施工前的文档副本备份，对应 docs/SPEC_世界书向量召回接通与防护_2026-09-29.md。 |
| 2026-09-30 | [`2026-09-30_probe-UI截图`](./2026-09-30_probe-UI截图) | `D:\_palink_probe_20260930` | UI 排查过程中的一次性截图探针产物（凌晨批次），非代码备份。 |
| 2026-09-30 | [`2026-09-30_plugininject-注入断点修复前`](./2026-09-30_plugininject-注入断点修复前) | `D:\项目\Palink-AI\frontend\src\utils\sillyTavernPluginRuntime.ts` | 修复「插件 setup 脚本模板里正则被模板字符串吃掉反斜杠 → 整批插件注入中断」前的原件备份。（由并行 agent 于归置完成后按新规范新建，未参与本次搬迁。） |
| 2026-09-30 | [`2026-09-30_plugininject-dist重build前`](./2026-09-30_plugininject-dist重build前) | `D:\项目\Palink-AI\frontend\dist` | 上述修复落地后要重跑 `npm run build`；vite 会清空在用的 dist，故先整目录留档（入口 `index-DaNDTfV8.js`）。 |
| 2026-09-30 | [`2026-09-30_P0P1-帧错误插桩与nginx兜底`](./2026-09-30_P0P1-帧错误插桩与nginx兜底) | `D:\项目\Palink-AI\frontend\dist` + 3 个 git tracked 文件（CharacterCardRenderer.tsx / frame-shim/legacy-st-sim.ts / nginx.conf，与 HEAD `15dc75c` 字节一致，恢复命令在 BACKUP_INFO） | 接手 HANDOFF_卡片正文空白与卡脚本执行 的 P0 插桩（frame-error 透传 filename + 脚本资源失败上报）与 P1 nginx 资源 404 兜底前的备份；dist 为物理快照（重建前在用产物）。 |
| 2026-09-30 | [`2026-09-30_卡片可用高度解锁批`](./2026-09-30_卡片可用高度解锁批) | `CharacterCardRenderer.tsx` + `smart-card-runtime/shared.ts`（工作区在途态；stash 快照 `0ac0ec86`，恢复命令在 BACKUP_INFO） | 故事卡正文截断修复（prefersAvailableHeight 分支消费 realContent）施工前备份；Mimosa 钩子禁 Bash 直写 .tsx/.ts，故以 git stash create+store 全工作区快照替代物理拷贝。 |
| 2026-09-30 | [`2026-09-30_mvu-initvar-修复前`](./2026-09-30_mvu-initvar-修复前) | 全工作区在途态，以 git stash 快照保存（sha `e5d0d07`，tag `pre-mvu-initvar-fix-20260930` = HEAD `15dc75c`；恢复命令在 BACKUP_INFO） | 「MVU 初始变量断链（过度思考根因）+ 输出 tag 裸显」修复批次动工前备份。SPEC `docs/SPEC_MVU初始变量断链与输出tag裸显修复_2026-09-30.md`；施工前复核报告 `docs/复核_MVU初始变量断链与输出tag裸显_2026-09-30.md`（含 10 项修正）。同因 Mimosa 钩子禁 Bash 直写 .py/.tsx，走 stash create+store。 |
| 2026-09-30 | [`2026-09-30_dsh-源码版清理`](./2026-09-30_dsh-源码版清理) | `D:\app\tool\`（7 个 dsh 散装启动/垫片脚本 + `deepseek-harness\` 内本地补丁）、`C:\Users\Pall\OneDrive\桌面\`（3 个启动器）、`C:\Users\Pall\.dsh\`（settings/凭据/会话/侧边栏配置）、`C:\Users\Pall\.npmrc` | 卸载本机**源码版 dsh（DeepSeek Harness 0.1.0-rc.5）**换官方 npm 版前的备份。只入档不可再生的自制脚本与用户配置（11M / manifest 170 行 sha256）；1.6G 源码克隆、134M pnpm-store、34M `_npmtest`、383M 插件 node_modules 均可重下，未备份。WorkBuddy 的 Node 22（341M）经查为它在用运行时，**未删**。 |
| 2026-10-02 | [`2026-10-02_卡脚本本地存储隔离施工前`](./2026-10-02_卡脚本本地存储隔离施工前) | `D:\项目\Palink-AI\` 下 12 个待改源文件（`pre/` 按原相对路径摆放，附 `_manifest.tsv` sha256 校验 12/12 一致） | 「卡脚本本地存储按角色与账号隔离」批次（P1 UUID 派生 → P0 localStorage 命名空间 → P2 服务端落库）动工前备份。对应 SPEC `docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md`、PROMPT 同名文档。含 4 个 P0/P1 主战场文件 + 5 个 [二手] 待复核通道文件；红线区（dist / backend/data / 素材）未碰。BACKUP_INFO 附录记录了复核中新增发现：`dialog_render_v7.1.js` 的 IDB `cg_group__` 主键缺 charId 导致**写覆盖丢数据**（比 SPEC 描述的读污染更重）。 |

| 2026-10-02 | [`2026-10-02_甲-IDB按角色分库施工前`](./2026-10-02_甲-IDB按角色分库施工前) | `D:\项目\Palink-AI\` 下 2 个待改文件（`pre/` 按原相对路径摆放，附 `_manifest.tsv` sha256 校验 2/2 一致） | Q2 走**甲（IndexedDB 按角色分库）**施工前备份。对应 SPEC `docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md §8.1`。改的是**所有智能卡共用的 iframe 运行时**，爆半径大于上一批。BACKUP_INFO 附录记了三条摸底结论：shim 装在 iframe realm 且**不向嵌套 srcdoc 子帧传播**；全仓无传播机制；`GalgameUIPluginDB` 为父帧 Live2D 面板与帧内插件共用，故**只能白名单定向分库、不能一刀切**。 |
| 2026-10-02 | [`2026-10-02_格式规范残本修复`](./2026-10-02_格式规范残本修复) | `D:\项目\Palink-AI\` 下 3 个待改文件（`pre/` 按原相对路径摆放，BACKUP_INFO 逐文件记 sha256；仓库基线 `d84a758`，工作区在途态） | 「格式规范注入残本修复 + A/B 重测」批次动工前备份。对应 `docs/PROMPT_接手批_格式规范残本与A_B重测_2026-10-02.md`。改 `_strip_bubble_marker_instructions` 段落丢弃判据（标题字面量 → 内容判定）、新增 `PALINK_BUBBLE_LEGACY_SECTION_STRIP` 调试开关（A/B 的 B 组）、补 `extra.ext_prompts.applied` 三项证据计数。⚠️ BACKUP_INFO 记了文档与库中事实的两处偏差：DB 行 `source_key` 实为 `fnv1a-pggfwp`、`content` 实为 **1796** 字符（文档写 752/`fnv1a-v71-selftest`，已过期），故 31.5% 口径作废，实跑为 **21.4%**。 |
| 2026-10-02 | [`2026-10-02_prompt每轮必到与擦标签例外`](./2026-10-02_prompt每轮必到与擦标签例外) | 全工作区在途态，以 git stash 快照保存（sha `7eb3dd0`，tag `pre-prompt-every-turn-20261002`；恢复命令在 BACKUP_INFO） | 「格式规范每轮必到 + 历史擦标签变量块例外」批次（主方案：规范持久化 extension_prompts 表 + 每轮装配无条件带；P2 白名单清洗；⑤ 降级路径单层改写）动工前备份。对应 `docs/PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md`。同因 Mimosa 钩子禁 Bash 直写 .py/.tsx，走 stash create+store。 |
| 2026-10-02 | [`2026-10-02_dist正式重建前`](./2026-10-02_dist正式重建前) | `D:\项目\Palink-AI\frontend\dist\` **整目录全量拷贝**（1892 文件 / 111M，入口 `assets/index-1P0pz-de.js`，三处计数与原目录逐项一致） | 正式上线「卡脚本本地存储按角色与账号隔离」批次而**重建前端产物**前的回滚点。需要物理备份的理由：`npm run build` 第一步 `clean-dist.cjs` 会先清空 `./dist`，而 `frontend/dist` 被 `.gitignore` 排除（`git ls-files` = 0 条）→ **git 不是回滚路径**。重建前已用 `VITE_OUT_DIR=dist_audit` 零风险预验（构建成功 + 三处新标记均在产物中）。BACKUP_INFO 记了回滚命令、"不要 mv dist 本身否则 bind mount 失效"、以及止血开关 `localStorage.palink_idb_namespace='0'`（免重构建即关）。⚠️ 本次重建会把三批在途代码一起上线（存储隔离 / 移动端 / 扩展提示词持久化），其中移动端批次仅能证明不破坏构建与测试，功能完成度不在本次验证范围。 |

| 2026-10-02 | [`2026-10-02_dist重建前_卡脚本隔离P0返工`](./2026-10-02_dist重建前_卡脚本隔离P0返工) | `D:\项目\Palink-AI\frontend\dist\` **整目录全量拷贝**（280 文件 / 14M / 0 字节文件 0 个，入口 `assets/index-Bx3kP9zq.js`，与原目录逐项一致） | 「卡脚本存储隔离 P0 未生效」返工批次替换在用产物前的回滚点。返工改了 `card-script-runner.ts`（链式宿主覆盖 + 逐处回退 + 降级唤痕），而 `frontend/dist` 不入 git → git 不是回滚路径。本次**刻意不跑 `npm run build`**（其 `clean-dist.cjs` 会清空在用 dist 并删掉历史 hashed 资源），改走 `VITE_OUT_DIR=dist_new_2` → 校验 → `cp -r` 原地覆盖 → `gzip-dist`。对应文档 `docs/提测_卡脚本存储隔离P0未生效_2026-10-02.md`（本次按复核结果改写）。⚠️ BACKUP_INFO 记了 4 条待办：删两个暂存目录、真机验收未做（docker 未启动）、pytest 基线 1621/1612 两处冲突待统一、禁用 `npm run build` 上线。 |

| 2026-10-03 | [`2026-10-03_报错提示模板落地`](./2026-10-03_报错提示模板落地) | `D:\项目\Palink-AI\` 下 23 个待改文件（`pre/` 按原相对路径摆放，附 `_manifest.tsv` sha256 校验 23/23 一致）+ 工作区 git stash 快照 sha `b570f14`（tag `snapshot-pre-error-notify-20261003`，基线 HEAD `d153009`） | 「报错提示模板落地」批次动工前备份，对应 `docs/PROMPT_报错提示模板落地_2026-10-03.md`（上游权威件 `docs/PROMPT_报错提示系统重写_2026-09-30.md`）。改前端提示通道（App.tsx Toaster / ErrorToast / NetworkStatus / CharacterChat / useCharacterChat / useChatView / 两套 errorHandler）与后端 SSE 落库守卫（`character_ext.py` `persist_snapshot` / `websocket.py` / `character_message_builder.py`）。⚠️ BACKUP_INFO 记了两处**待用户拍板的文档冲突**：① 10-03 落地文档 §1 K1「报错卡内联、不许浮层」 vs 09-30 权威件 §3 D2 推荐 (b) 顶部常驻（且 `报错提示系统UI设计原型_2026-10-03.html` 已按 (b) 出图）；② 后端 1.6(c) 动装配层前需先在容器内跑 SQL 量影响面，本机不直连生产库。红线区（dist / backend/data / 素材）未碰。 |

| 2026-10-03 | [`2026-10-03_dist重建前_报错批上线`](./2026-10-03_dist重建前_报错批上线) | `D:\项目\Palink-AI\frontend\dist\` **整目录全量拷贝**（404 文件 / 22M，0 字节文件 0 个，入口 `assets/index-DMlQT9yx.js` + `assets/index-DAHj4yWK-18f17586.css`）+ 逐文件 `dist_manifest.sha256`（404 行，与文件数一致） | 源码比产物新约 3.5 小时（源码最新 mtime 10-03 02:08 / 产物 10-02 22:20），且 `dist/assets` 内同时存在多组指纹而 `index.html` 只引用旧的那组 —— 10-02 那次构建中途断过，新产物已落盘但入口未切换。致多条「已完成」实际未上线：卡脚本本地存储隔离 P0（`319d6d4`）、可用高度解锁（`cb89a1d`）、格式规范前端中继、报错提示模板落地批（8 文件 +245/-62）。`frontend/dist` 是容器 nginx bind mount 在用产物且不入 git（`git ls-files` = 0）→ git 不是回滚路径，故必须物理备份。同 10-02 两批口径：**禁用 `npm run build`**，改走 `VITE_OUT_DIR=dist_new_3` → 校验 → 原地覆盖 → `gzip-dist`（`clean-dist.cjs` 会在第一步清空在用 dist）。⚠️ BACKUP_INFO 记了 6 条待办，其中两条易被忽略：① `assetContentHashPlugin` 曾在 commit `8005394` 被补回过（曾「引用了但从未入库」），丢失即 iOS 侧 CSS 改动重新送不到手机、且无测试护栏；② 构建后须复查 `extension_prompts` 持久化行未被摘（期望 `source_key=fnv1a-pggfwp` / `length=1796` / `identifier=bubble-dialogue-format`），被摘即格式规范再次缺席。 |

### 2026-10-03 补登记（4 份此前漏登记 + 漏说明书者）

> 这 4 份备份**一直在磁盘上，但既未登记台账、也无 `BACKUP_INFO.md`** —— 按 AGENTS.md 第 2 条
> 属「无效备份」、按第 3 条属「台账缺口」。2026-10-03 核查发现并补齐。
> **补写说明时未改动各目录内任何原有文件**（内容零改动，仅新增 `BACKUP_INFO.md`），
> 符合第 4 条「禁止改写存量备份」——补的是新增文件，不是改写。
> ⚠️ 四份的「原始来源路径」**均为据内容推断，原记录已佚**，已在各自 BACKUP_INFO 首屏显著标注，
> 引用时不得当权威来源。

| 备份日期 | 目录名 | 原始来源 | 备份原因 |
|---|---|---|---|
| 2026-09-30 | [`2026-09-30_MVU会话变量重置`](./2026-09-30_MVU会话变量重置) | `D:\项目\Palink-AI\backend\data\`（**推断**；MVU 变量 chat metadata 导出，对象形态 `{会话UUID: {variables: {stat_data: {...}}}}`） | MVU 会话变量重置前的整份导出留档（1 文件 / 3.3KB）。⚠️ 与 09-30 MVU 初始变量断链批的关联**未证实**（该 SPEC 未提及本备份）。 |
| 2026-09-30 | [`2026-09-30_plugininject-csp改前`](./2026-09-30_plugininject-csp改前) | `D:\项目\Palink-AI\frontend\security-headers.conf`（**推断**） | nginx 安全响应头（CSP）改动前留档（1 文件）。夹在 `plugininject-注入断点修复前` / `plugininject-dist重build前` 两个已登记备份之间，属同批中间留档。⚠️ **`TODOS.md` 全文检索 `csp改前` 零命中**，该批施工记录未写进待办文件，追溯需靠 git 历史 + 另两个同批备份。 |
| 2026-10-01 | [`2026-10-01_hist-cleanup`](./2026-10-01_hist-cleanup) | 由 `pg_dump` 从 Palink 生产库直接导出，**不经文件系统路径** | 历史消息 `@bubble` 标记与正文包裹标签清洗前的整表留档（932KB SQL + 1.9KB 清洗脚本 + 0 字节 `dump.err`）。⚠️ **该清洗方向已被 10-02 决策推翻**（改为保留历史外壳），故本备份是「推翻后」状态，**恢复会倒退决策**。0 字节 `dump.err` 是无 stderr 的正常产物，勿当坏文件清理。 |
| 2026-10-01 | [`2026-10-01_pre-bubble-render-fix`](./2026-10-01_pre-bubble-render-fix) | 3 个前端文件（`Message.tsx` 路径可确证，另两个**目录层级已摆平不可确证**）+ `backend/app/services/roleplay_prompt_assembly.py` + 卡内 TavernHelper 脚本原文（DB 字段导出，非文件系统文件） | @bubble 渲染断链修复批次动工前留档，横跨前端渲染层 / 后端装配层 / 卡内脚本三处。⚠️ `roleplay_prompt_assembly.py` 在 10-02 批又被大改，**回捞应优先用 `2026-10-02_格式规范残本修复`**；`src/` 内路径已摆平，回捞须按文件名定位勿直接覆盖。含卡内脚本原文，引用时只取结构/长度/键名。 |

> **本次归置的 28 份**（2026-04-06 起至 2026-09-30_probe）由 2026-09-30 统一搬迁，原始来源见上表「原始来源」列。
> 表中 `2026-09-30_plugininject-注入断点修复前` 一行由**另一个 agent 在归置完成后**按新规范新建，原位置即仓库内，**未参与本次搬迁**（它的来源列是仓库文件路径而非外部目录，据此可区分）。

## 隔离区（待确认后删除，尚未删除）

`_QUARANTINE_2026-10-03/frontend__dist_new_3/` — 2026-10-03「报错批上线」dist 重建的**试构建产物**（`VITE_OUT_DIR=dist_new_3` 产出，195 文件 / 12M，入口 `index-BCg8tP2l.js` + `index-ZklcfZSV-dff66ed5.css`）。**其内容已完整覆盖进在用 `dist`**，故移入隔离区而非删除；若线上无异常，可整份删除。

`_QUARANTINE_2026-10-02/frontend__dist_new/` — 原 `frontend/dist_new/`，「卡脚本存储隔离 P0 返工」批次的**中间版试构建产物**（入口 `index-C59-QM1Y.js`，195 文件 / 12M）。移入而非删除的理由：其中 **70 个 chunk 在线上 `dist` 里不存在**（旧哈希版本），而产出它们的源码状态未提交、已往前走，这版产物不可再生。同批的 `frontend/dist_new_2/` 经比对**独有文件数 = 0**（纯冗余副本，入口与线上一致），已直接删除。确认无需回捞后，此目录可整份删除。

`_QUARANTINE_2026-09-30/` — 2026-09-30 清理行动中识别出的临时/废弃文件，**只移入未删除**，确认系统运行无异常后可自行删除。内含：根级 `.tmp_build_*.log` ×10、frontend 旧构建日志与 `.next`、4 个 `dist_old_*` + 1 个 `dist_prebuild_*`（约 48MB）、`frontend/frontend`、`frontend/dev`、一次性调试脚本（backend `tmp_*.py` ×4、scripts 探针 js ×10）、空备份壳目录 ×4。

## 严禁事项

- 禁止删除或修改任何 `BACKUP_INFO.md`（新缺失说明的备份视为无效备份）
- 禁止删除 `frontend/dist`（容器 nginx bind mount 的在用产物，删除即前端白屏）
- 任何清理动作必须先列清单并取得用户确认
- 每个新备份目录创建后，必须在下表追加一行
