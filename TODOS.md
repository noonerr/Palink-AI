# TODOS.md — 跨 agent 待办与决策记录

> 本项目所有 agent（Claude Code / Codex / TRAE / 其他）在动工改代码前，请先阅读本文件。
> 这是跨会话/跨 agent 的遗留任务、方向决策与进行中工作项的唯一入口。修改前先同步，完成后更新状态。

---

## 待办任务（进行中 / 未完成）

### [已完成] 运行时强制封存 st-compat / st-native（[MODE-SEALED] 2026-08-24 用户拍板）
- **决策**: 除 palink-native 外的模式暂时全部封存不许调用，隐患排除后完全删除
- **封存机制**（三层，标签 [MODE-SEALED]）:
  1. 装配入口: `roleplay_prompt_assembly.py` 新增 `SEALED_ST_MODES` + `_st_mode_effective()`，三个消费点（世界书扫描 L3552 / 主装配分支 L3728 / 群聊策略 L2697）归一化——DB 存量值 st-compat 也强制走 palink-native 管线。**注意：`_is_st_compat_mode` 函数契约保持原样**（st-compat 函数族是被固化测试直调的纯函数，随代码一起待删）
  2. API 出口/入口: `users.py` 与 `silly_tavern.py` 的 `_normalize_silly_tavern_mode` 封存重定向——GET 一律报告 palink-native（前端分支自然走主攻模式），PUT 提交封存值直接落库为 palink-native
  3. 设置 UI: `SettingsView.tsx` 模式选择器禁用 st-compat/st-native 两项（灰化+toast 提示）
- **可逆性**: DB 存量值不回写（admin 仍存 st-compat 但运行时等效 palink-native）；解封 = 从各 `SEALED_ST_MODES` 移除对应值并恢复 normalize 合法集
- **测试**: `test_st_mode_normalization.py` 重写为封存语义（normalize 重定向 + 入口归一化 + 三处集合一致性守卫）；`test_group_speaker_selection.py` 两个 TALKATIVE/VOTING 降级测试改写为封存语义正向验证；e2e phase6 subtask_6_1_4 与 convergence 测试同步更新
- **验证**: 定向 82 过；全量 pytest **905 过/4 存量失败零新增**（mvu_engine/p1_fixes/st_contract/st_plugin_import 与基线逐一对应）；tsc 干净；容器重建 healthy；容器内运行时验证 11/11 PASS（存量不回写+GET/PUT/入口三处封死）
- **附带效果**: 原计划 R2「admin 切 palink-native 实测」被本机制自动涵盖——admin 存量 st-compat 已在装配入口归一化为 palink-native，死循环诱因层（无 balance_custom_tags 守卫的装配管线）已不可达
- **AGENTS.md** 状态表与约定已同步更新

### [已完成·已验收] 角色扮演动作流 reasoning-only 防护（思考链死循环落库，2026-08-24）
- **spec**: `docs/SPEC_动作流reasoning_only防护_2026-08-24.md`（含完整证据链/方案/测试要求/验收清单）
- **事故**: 2026-08-23 消息 2248——「我被猫娘包围了！」卡 swipe 重roll 落库空正文 + 2060 字复读思考链
- **根因三层**: ① st-compat 装配无 balance_custom_tags 守卫 + 卡主体字段全空/EJS 条目被剥空/脏标签裸进 prompt → 模型身份锚点真空自发复读（诱因层，已被 MODE-SEALED 封存消除）；② `StreamResult.has_content` 把 reasoning 计入"有内容"；③ `_run_action_stream` finally 判定放行 → `/swipe`、`/regenerate` 的 persist_fn 无校验落库空 final（websocket 主路径有 [NO-CONTENT-FINAL] 守卫，SSE 动作流是唯一漏网出口）
- **R1（代码，修复 agent 施工，审计线 2026-08-24 验收通过）**: character_ext.py `_run_action_stream` finally 改为仅正文才持久化 + reasoning-only 发 N12 格式 error 事件（`[NO-CONTENT-FINAL-ACTION]` 日志标签）；单点覆盖 continue/regenerate/swipe 三端点；has_content 本身未动。前端 useCharacterChat.ts 三处 action SSE 回调补 `type:'error'` toast 消费（原解析器静默吞掉该事件，顺带修复 N12 error 此前同样被吞的问题）
- **R2（运维）**: 已被 MODE-SEALED 自动涵盖——admin 存量 st-compat 在装配入口归一化为 palink-native，死循环诱因层不可达
- **R3（数据）**: ✅ 已删除（2026-08-24 用户拍板「直接删了吧」）——消息 2248 经 DB 脚本 `_delete_msg_2248.py` 删除并验证归零；其所属会话 76732b7d 随之成为空会话（0 条消息），可留可删
- **⏸ 挂起项（2026-08-24 用户指示暂不动，后续择机处理）**: ① 全部未提交改动分批 git commit（封存 MODE-SEALED + R1 防护 + 测试 + 文档）；② 「我被猫娘包围了！」卡同卡 swipe 重roll 体感实测（守卫已上线，实测仅作体感确认）
- **验收记录（2026-08-24 审计线）**: git diff 核对 spec §R1 逐行一致 + 红线四文件零改动 ✓；新测试 3 例复跑全过 ✓；全量 pytest 905 过/4 存量失败零新增 ✓；tsc 干净 ✓；后端守卫已在运行镜像内（GUARD-IN-IMAGE: True）✓
- **⚠️ 部署知识（重要）**: frontend 服务是 `./frontend/dist:/usr/share/nginx/html:ro` bind mount——**重建 frontend 镜像不更新前端**；更新前端唯一正确方式 = 本地 `cd frontend && npm run build`（卷直挂即时生效）。本次验收发现修复 agent 未跑本地 build 导致前端改动未上线，已补构建并 HTTP 冒烟通过（SettingsView chunk 新 hash 2WpH_asK 在线服务正常）。另注意：ripgrep/Grep 工具对 minified 长行 JS 有 binary 误判，搜 dist 产物请用 PowerShell Select-String
- **施工记录（2026-08-24 修复 agent）**: R1 已完成——character_ext.py `_run_action_stream` finally 单点守卫 + 前端 useCharacterChat.ts 三处 action SSE 回调补 `type:'error'` toast（解析器原本不识别该事件）；新增 `backend/tests/test_action_stream_no_content_guard.py` 3 例（TDD 先红后绿）；全量回归 905 passed / 4 存量失败零新增；tsc 干净。未 commit，待审计线按 §5 验收

### [已完成·已验收] 安全加固第二批 N-6/N-7（2026-08-24 施工 + 当日验收通过）
- **spec**: `docs/SPEC_安全加固第二批_N6_N7_N8_2026-08-24.md`（N-8 仅设计确认零代码）
- **N-6 验收记录**: security.py `sign/verify_service_user_id`（HMAC-SHA256 + compare_digest 防时序）+ openai_compat 消费侧（伪造→warning 忽略落 admin 回退，不 403 无探测信号）+ sidecar 注入侧三处生产者全配对 Sig 头（silly_tavern.py auth 响应/后端→ST 代理 + nginx.conf auth_request_set+proxy_set_header）——全链路头名统一 X-Palink-User-Id/-Sig 实证一致。test_n6_service_user_sig.py 8 例
- **N-7 验收记录**: POST /api/uploads/token 签发 upload-scope 短令牌（claims 仅 sub/scope/exp:300s，无 jti 无长效）；_verify_upload_access 强制 scope=="upload"（主 JWT 从此不得出现在附件 URL），N-14 黑名单检查原样保留；uploadUrls.ts 整文件重写（缓存+in-flight 去重+提前 100s 刷新+失败退裸路径）；12 调用点全适配（AsyncUploadImg/AsyncUploadPreview/resolvedImageSrc 等）；MarkdownRenderer `<a href>` 永不带 token（点击复制路径）。test_n7_upload_scope_token.py 7 例 + 前端契约 upload-url-contract.test.ts 15 例
- **审计线独立复验**: 新测试定向 14 过；宿主全量 **952 passed / 0 failed 全绿**（历史性时刻——三契约漂移亦被测试归零批并行清偿）；tsc 干净；后端容器重建 healthy，镜像内五项运行时验证全过（含 create_upload_token 解码 scope/jti 断言）
- **影响面确认**: 存量外发的旧附件 URL 部署后即 401（scope 强制）=修复目的；前端渲染链路动态重构造不受影响
- ⏸ 前端 dist 统一构建待性能批落地后执行（避免构建竞态）

### [进行中] 测试归零批次（三契约漂移甄别 + U-3 端点级回归，2026-08-24 spec 就绪）
- **spec**: `docs/SPEC_测试归零批次_三契约漂移与U3_2026-08-24.md`——与安全批/性能批**三线并行**（禁改清单九文件互斥），主战场 backend/tests/
- **T-1**: 三失败 A/B/C 决策树甄别——F1 p1_fixes（倾向断言未跟随 _p1-split.mjs 机械拆分）/ F2 st_contract（倾向 bridge.js 白名单真缺 20 端点，补前抽查端点存在性）/ F3 st_plugin_import（需 git 历史对照甄别）
- **T-2**: U-3 封存端点级回归——PUT 落库重定向 / GET 报告不回写两场景 DB fixture 测试
- **目标**: 宿主全量 0 failed 全绿；派修复 agent

### [已完成·已验收→归档] 性能与体验批次（N-3/N-9/N-12，2026-08-24 spec 就绪，同日验收通过——详见下方「性能与体验批次」完成条目）
- **spec**: `docs/SPEC_性能与体验批次_N3_N9_N12_2026-08-24.md`——文件级零重叠设计（禁改 N-6/7 占用的 8 个文件），纯前端后端零改动
- **P-1[N-9]**: 切换会话即中止旧流（abort + wsSendCancel + 生成态复位）+ 回调代次比对双保险
- **P-2[N-3]**: 三重 memo 击穿修复——smartCardChatMessages 稳定切片（历史冻结快照+尾部 K 条实时）/ sanitizeStCompatHtml 入 useMemo / memo 比较器维持现状
- **P-3[N-12]**: 出视口智能卡 iframe 休眠（IntersectionObserver + 等高占位防跳动）
- **约束**: 不执行 npm run build 不 commit（审计线在两并行批次落地后统一构建，避免构建竞态）
- **派单**: 与 N-6/N-7 同步交修复 agent

### [进行中] N-8 本体立项：JWT 迁移 HttpOnly Cookie + CSRF 配套（N8-a/N8-b 均已验收，仅剩 N8-c 终态切换）
- **spec**: `docs/SPEC_N8_HttpOnly_Cookie_立项_2026-08-25.md`（目标架构/后端前端改动清单/18 处直读分派表/三批提交时间线/安全评审清单）
- **架构**: 登录双发（响应体保留+Set-Cookie palink_session HttpOnly）→ 双轨鉴权（Bearer 与 Cookie 并存）→ CSRF 中间件（mutating 要求 X-CSRF-Token==cookie 配对）→ 续期 Cookie 化 → 终态移除 localStorage 兼容
- **[已完成·已验收] N8-a 后端全量（2026-08-25 施工 + 当日验收通过）**: auth.py 登录双 Set-Cookie（palink_session HttpOnly/Max-Age=43200/SameSite=lax + palink_csrf 非 HttpOnly token_urlsafe(32)，响应体保留 access_token）/登出清两枚 Cookie+jti 拉黑双通道；dependencies.py 双轨提取（Bearer 优先、显式无效 Bearer 不回退 Cookie、续期收窄仅 Bearer 通道）；main.py CSRF 中间件（准入收窄：仅携带 palink_session 才进强制区，OWASP 口径；Bearer 豁免对齐 csrf_guard.py；Origin 兜底 host 相等+CORS 白名单显式项，* 不参与、Origin:null 拒）+ 续期中间件 set_session_cookie 同步下发。新增 test_n8_cookie_auth.py 29 例。**验收实证**: 宿主全量 pytest 1050 passed / 0 failed；容器重建 healthy；端到端冒烟 26/26 全绿（登录双 Cookie 属性/Cookie 通路 /api/users/me/CSRF 五态/Bearer 豁免与优先级/续期双出/登出清理+jti replay 401）。备份 backup/2026-08-25_n8a-backend/（3×.bak+MANIFEST sha256，随批入库）。甄别记录: CSRF 准入收窄系首跑 24 failed 后按 OWASP 口径修正的合理取舍；遗留风险移交 N8-c（开发模式 CORS_ORIGINS=* 下 vite 直连同源兜底失配需 proxy 或显式白名单配合）
- **[已完成·已验收] N8-b 前端适配（2026-08-25 施工 + 当日验收通过）**: api.ts 收口三出口（request/stream/raw）credentials:'include'（尊重调用方显式值）+ mutating 自动注入 X-CSRF-Token（getCsrfToken 读 palink_csrf cookie，显式头不覆盖，GET 豁免）；六通道 credentials 化（ws ticket/SillyTavernIframe:84/getContext 同步XHR+merge-attributes/usePushToTalk/tts/CharacterView XHR 上传/sillyTavernPluginRuntime guardedFetch 含 Request credentials 不可变重建分支），Bearer 拼接全部保留（只增不删）。**甄别记录**: SillyTavernIframe:120 系 st-native 封存态 iframe URL query 拼接非 fetch 不处理；CharacterView:67 实为 /api/characters/import XHR 上传；primitives:746 经执行链核实为主窗口父文档组件代码（非 iframe 内）、fetch 已显式 credentials:'same-origin' 同源自动带 Cookie——维持现状，TODOS 旧表述「iframe 内无法依赖父域 Cookie」作废。新增 api-csrf-credentials-contract.test.ts 15 例（含防整文件回退守卫）挂入 test:contract 链。**验收实证**: tsc --noEmit 干净、test:contract 全绿（15/15）、build 成功产物落 dist 生效于 :13000。**验收线补充修复①**: App.tsx handleLogout 原为纯本地清理（前端从未调用 /api/auth/logout，Cookie 双件套残留至自然过期）——已补 best-effort api.post('/api/auth/logout')（失败不阻塞本地清理）。**验收线补充修复②（组件/插件兼容关键）**: 追加经 nginx 全链路 CSRF 冒烟时抓到 Origin 同源兜底失效——nginx `$host` 变量不含端口，非标端口部署下后端 `_origin_same_site` 的 Origin netloc==Host 判定必失配 → 登录态下无 Bearer 的组件/插件 mutating 请求全部 403；已将 8080 server 四处 API 反代（token|register、uploads、smart-card-assets、/api/）的 Host/X-Forwarded-Host 改为 `$http_host`（含端口），复跑 8/8 全绿（同源裸 POST 兜底放行/外站 Origin 拦截/双提交/登出清理均验证）；8081 st-native 封存链路未动
- **[待派发] N8-c 终态切换**: 移除 localStorage 兼容、grep 归零、CORS_ORIGINS 遗留风险处理；**新增遗留清单**: ① 手动 mutating 通道无 CSRF 注入（getContext:2160 同步XHR/:3013 merge-attributes、CharacterView import XHR、usePushToTalk /api/stt、tts /api/tts/audio|preview、pluginRuntime guardedFetch 插件请求）——双轨期靠 Bearer 豁免零缺口，终态删 Bearer 后将全部 403，需补 X-CSRF-Token 注入或改走 api.ts 收口；② primitives:746 若确认保留 token 直读须书面取舍归档；③ 登出服务端调用已于 N8-b 补齐无需重做
- **特殊通道**: smart-card primitives:746 经 N8-b 核实为主窗口执行链（非 iframe 内），同源请求自动携带 Cookie，无需特殊通道处理
- **风险已评估**: CORS credentials 组合/SameSite 升级条件/第三方 WebView 盘点（spec §6）
- **基线**: 宿主 pytest **1050 passed / 0 failed** 全绿
- **环境注意**: Windows WinNAT 动态保留段曾吞 frontend 容器 3000 端口映射（2934-3033，Docker 引擎崩溃重启后遗症）；用户暂无管理员权限，**frontend 已临时改用 13000 端口**（http://localhost:13000，compose 有 [TEMP-PORT] 标记）。管理员在场时执行修复并改回 3000：`net stop winnat` → `netsh int ipv4 add excludedportrange protocol=tcp startport=3000 numberofports=1 store=persistent` → `net start winnat` → compose 改回 "3000:8080" 并 `docker compose up -d frontend`

### [已完成·已验收] 二期批次：世界书 vectorized 接线 + N-8 止血滑动续期（2026-08-25 施工 + 当日验收通过）
- **spec**: `docs/SPEC_二期_vectorized接线与N8止血_2026-08-25.md`（含强制备份要求 §4）
- **V 线 vectorized 接线**（孤岛激活）: V-1 同步触发三处（编辑 API commit 后/导入对齐/装配兜底懒同步二选一）/ V-2 检索注入（最近 4 条对话为查询，top5 阈值 0.25 命中跳关键词直进激活管线，嵌入失败静默降级）/ V-3 开关 vectorized_enabled 默认 false 存量零突变——基建三件套早已就绪只缺两个调用点
- **S 线 N-8 止血滑动续期**: 后端 get_current_user 剩余寿命 <1/3 时签发新 token 走 X-Palink-Token-Refresh 响应头 + 前端拦截器落地 localStorage——活跃用户永不掉线、被盗窗口有界 12h、零 refresh 架构成本；12h 默认保持 env 可配
- **备份强制**: backup/2026-08-25_vectorized-n8-stopgap/ + MANIFEST sha256
- **基线**: 宿主 996 passed / 0 failed；容器内 988 passed / 0 failed（C7 对齐达成）
- **派单**: 单 agent 施工

### [已完成·已验收] 清理批次总案（除 N-8 外全部存量，2026-08-24 三线并行施工 + 当日验收通过）
- **spec**: `docs/SPEC_清理批次总案_除N8_2026-08-24.md`（互斥矩阵/报告精简格式/统一冻结）
- **A 线 世界书与示例域**（7 子项）: useProbability 接线（DB列+导入+扫描判定，ST 语义 false=必现）/ mes_example 拆块移植 palink-native / prevent_recursion 语义修正（排除出递归 buffer 而非整条跳过）/ WI 全局设置补接线（world_info_depth 对齐 ST=2 等）/ 百分比预算基数传真实 max_context / V3 卡独立 jailbreak 消费 / creator_notes 退出 prompt——修复 agent
- **B 线 前端卫生**（5 子项）: N-19 构建期 drop_console+重灾区手清(VAR-DBG) / N-20 Popup 轮询改事件 / N-21 timer 清理对齐 / N-22 postMessage origin 收紧 / A-5 symbols 键名对齐——修复 agent
- **C 线 后端安全卫生与二期尾巴**（7 子项）: PATCH/swipe 记忆同步钩子(message_id 二期) / N-13 四xx文案×15 / N-15 日志脱敏 sk-pk / N-16 上传上限 / N-17 无limit限幅(silly_tavern.py 一处顺延) / N-18 prod 弱密码阻断 / 容器 pytest 对齐(compose 只读挂载 frontend + skipif 候选路径)——审计线或修复 agent
- **待拍板**: vectorized 孤岛接线 or 删除；N-8 止血 token 有效期数值
- **基线**: 952 passed / 0 failed 全绿；三线禁改矩阵见 spec §0
- **验收记录（2026-08-24 审计线独立复核）**:
  - A 线 7 项 diff 核验全合格（A1 None 回退 True 保旧数据行为 + RNG 短路等价注释；A4 附带修正导入 scanDepth 强写 4 使全局深度失效的隐藏缺陷；A6 V2 拷贝去重守卫防 PHI 双注入）；test_batch_a 24 例
  - B 线 5 项核验合格；甄别合理（VAR-DBG 实际分布在 CharacterChat×1+SillyTavernCompatRuntime×5 而非派单所写文件，按实况清除；PANEL-DBG 同类脚手架连带删除）
  - C 线 7 项核验合格；C1 swipe 切换记忆镜像语义与编辑钩子一致；C7 compose 挂载路径纠偏（./frontend 相对 compose 所在目录）
  - 终态：宿主 pytest **996 passed / 0 failed 全绿**（952+44 新增精确勾稽）；tsc 干净；统一 build 成功
- **⚠️ formatting.ts 第二次未授权回退已拦截**: 与 hotfix 批次同模式（F-1 LaTeX 修复整文件被旧版覆写，-81 行）。已再次 git checkout 还原。**根因对策落地**：新增前端源码契约守卫 frontend/src/lib/__tests__/formatting-katex-contract.test.ts（3 例：renderMathInHtml 存在/MathML 白名单/管线调用先于消毒），此后任何回退立即红灯
- **顺延项（下批处理）**: silly_tavern.py:1425 无 limit 一处（本轮 silly_tavern.py 全员禁改）；character_ext 导入导出 f-string 宽异常站 3 处（5237/5303/5336，N-13 同类）；silly_tavern.py 导出侧 useProbability 为 probability<100 推导近似（A1 只读未改）
- **施工过程披露**: C 线 N-13 在制品曾致 image_generation.py 缺 import 使 app.api 不可导入，A 线机械解堵（补 stdlib import）——跨线协作互救案例；B 线遭遇并行编辑竞态改动丢失，tsc 抓到后重放修复

### [已完成·已验收] 性能与体验批次 N-3/N-9/N-12（2026-08-24 施工 + 当日验收通过）
- **spec**: `docs/SPEC_性能与体验批次_N3_N9_N12_2026-08-24.md`（与安全批三线并行零冲突）
- **验收记录**: 纯前端 3 文件 284+/75-，禁改清单未触碰；N-9 代次守卫 25 处布点核验（三条 SSE 路径+WS 槽位双轨+suppress 豁免流内回写）；N-3 sanitize 入 memo + render 只读 stCompatSanitizedHtml；N-12 SmartCardDormancyGate 一屏缓冲等高占位；tsc 干净；统一构建产物 palink-card-dormancy 在位
- **施工亮点**: isGenerating 相位翻转作快照提交点（防插件上下文永久停在流起始值）；O(N) 逐位引用比对捕获同长度编辑

### [已完成·已验收] 测试归零批次（2026-08-24 施工 + 当日达成全绿）
- **成果**: 宿主全量 pytest **952 passed / 0 failed 历史性全绿**（F1 断言跟随 _p1-split 拆分【B】/ F2 bridge.js 白名单补 20 端点【A】/ F3 settings.html 断言更新【B】+ U-3 封存端点级回归 PUT 重定向/GET 不回写两场景）
- **意义**: 此后所有批次验收不再背存量失败豁免清单

### [已完成·已验收→归档] 安全加固第二批（N-5/N-6/N-7/N-14 均落地；N-8 升级为独立立项线——见上方「N-8 本体立项」）
- **spec**: `docs/SPEC_安全加固第二批_N6_N7_N8_2026-08-24.md`
- **N-6**: openai_compat service_key 分支的 X-Palink-User-Id 改 HMAC-SHA256 签名头校验（未签名视为伪造忽略落 admin 回退；sidecar 注入侧同步）——派修复 agent
- **N-7**: 附件 URL 去主 JWT 化——新增 upload-scope 短时效令牌端点（5min），_verify_upload_access 强制 scope 检查，appendUploadToken 12 调用点适配，MarkdownRenderer `<a href>` 去 token——派修复 agent
- **N-8**: JWT localStorage → HttpOnly Cookie 架构级迁移，本批仅设计确认（双轨过渡+CSRF 配套+短期止血），实施前单独细化
- **已完成前置（审计线直接修复，2026-08-24）**:
  - [N-5] WS tool_call_response 归属校验——StreamSession 落 user_id（create_stream_session 传入），handler 按 _tc_ss.user_id != user.id 拒绝投递并 warning；test_n5_tool_response_ownership.py 2 例守卫
  - [N-14] _verify_upload_access 补 jti 黑名单检查（登出/封禁后旧 query token 失效）
  - 验证：py_compile 过；宿主全量 **932 passed / 4 存量失败零新增**；后端容器重建 healthy，镜像内 N5/N14 在位
- **已推送远端**: 分支 st-plugin-compat-20260727 于 2026-08-24 首次推送 GitHub（含 MODE-SEALED/R1/记忆体系/HOTFIX 等全部积压成果）

### [已完成·已验收] HOTFIX 安全批次六项（N-1 XSS / N-2 NameError / U-1 / U-2 / U-5 / U-7，2026-08-24）
- **spec**: `docs/SPEC_修复验证与系统检查_2026-08-24.md` §6（含审计线复核修正横幅与 §6.3「容器内 pytest 不可作基线」纠偏）
- **完工报告**: `docs/HOTFIX完工报告_安全批次六项_2026-08-24.md`
- **验收记录（2026-08-24 审计线独立复核）**:
  - N-1 XSS 四入口逐一核验合格：Popup.tsx DISPLAY 分支 DOMPurify 消费点兜底 + SmartCardCompatController/getContext/sandbox 三入口仅 DISPLAY 条件消毒，TEXT/CONFIRM/INPUT 未动 ✓
  - N-2 三 hunk 合格：签名补 reasoning_effort/provider_id + ws_chat 解析 + _gen 透传；新增 test_ws_chat_generation_signature.py 4 例守卫 ✓
  - U-1 persist 失败补 error 事件 / U-5 两分支统一 type:'error' 契约 / U-2 三模块封存集合一致性断言 / U-7 九探针删除+两工具保留 ✓
  - 宿主全量 **930 passed / 4 failed 零新增**（勾稽 925+5=930）；定向 23 过；tsc 干净
- **⚠️ 验收中拦截一次未授权回归**: 工作区 formatting.ts 被静默回退掉 F-1 LaTeX 修复（renderMathInHtml + KaTeX MathML 白名单整体删除，P1#4/commit 70ef261 的成果），不在任何任务书内且完工报告未提及——审计线已 `git checkout` 还原至 HEAD 并重新 `npm run build`（修复 agent 此前的 build 是在回退态做的，产物缺 LaTeX）。还原零风险（内容即 HEAD 已提交代码）。**教训：多 agent 并行时验收必须 diff 全量改动面，报告未列的文件也要查**
- **运行时终检**: ✅ 已闭环（2026-08-24）——后端容器重建 **healthy**；镜像内 N2 签名/U-5×2+U-1 标签在位，`run_chat_generation` 运行时签名含 reasoning_effort/provider_id 实测通过

### [已完成·已验收] 消息编辑 × 向量记忆同步：message_id 关联体系（2026-08-24 spec 就绪 + 当日施工验收通过）
- **spec**: `docs/SPEC_消息编辑与向量记忆同步_2026-08-24.md`（ST 对照研究 + 完整方案 + 测试要求 + 验收清单）
- **动机**: 用户后期开放 ST 式消息编辑；现状编辑后旧文本记忆残留且持续被召回（左右脑互搏素材）
- **核心不变式**: 记忆 = 消息当前内容的镜像。conversation_memories 加 message_id 列，所有内容变化操作（生成/续写/swipe 写入/重试）统一「upsert by message_id」，编辑钩子删旧+后台重嵌
- **顺带修复**: P3 continue 记忆重叠双份、P4 swipe 重roll 旧内容残留、单条消息删除记忆级联（第五条删除路径补全）
- **关键决策**: 用真实主键 message_id 而非 ST 式内容 hash（我们有 DB 主键）；存量 NULL 行不回填（声明边界）；turn_hash 不动（P2 放弃修复，理由在 spec §5）
- **分工**: 施工归修复 agent；审计线验收
- **施工记录（2026-08-24 修复 agent）**: A-E 五块全部落地——storage.py（message_id 列迁移幂等 + idx_memory_message_id 索引 + delete_by_message_id 统一助手；顺带修复 _init_tables 迁移先于索引的顺序缺陷与 SQLite 探测/ALTER 异常路径 rollback 波及同连接在途数据的问题）+ store/store_chunks/store_memory 透传；四处写入点 [MEM-UPSERT]（run_chat_generation / run_character_chat_generation / SSE 主对话流 finally / _run_action_stream persist_fn 后，后三者含 continue(P3)/swipe 重roll(P4) 收敛）；编辑钩子 [MEM-SYNC-ON-EDIT] ×2（edit_character_message + sessions.update_message，删旧→后台 asyncio.to_thread 重嵌、失败宁缺勿错、branch_id 随消息原值回写）；delete_character_message 单条删除级联。**复核修正（同日）**: ws_character_chat finally 的 assistant 记忆源由 result.full_content（续写场景=仅增量）改为读 DB 消息最终显示内容，确保 P3 场景记忆=合并全文符合 spec §4 不变式。swipe 切换路径验证结论：重roll（POST /swipe）已被动作流 upsert 覆盖 ✓；**插件路径 PATCH /messages/{mid}/swipe 与主 UI 本地 messageManager.swipe() 均不经 PUT messages/{mid}**——PATCH 会改 DB content 使记忆过时，按 spec §3.4 登记二期。新增 backend/tests/test_memory_message_link.py 20 例（TDD 先红后绿）；复核后复跑全量回归 925 passed / 4 存量失败零新增；py_compile 通过。未 commit，待审计线验收；**后端镜像需重建方可生效**
- **二期候选**: swipe 切换 PATCH /messages/{mid}/swipe 端点（switch_message_swipe）的记忆同步钩子
- **验收记录（2026-08-24 审计线独立复核）**: git diff 逐块核查 A–E 全合格（含发现1 continue 记忆源改读 DB 最终内容——对 spec 不变式的正确捍卫；发现2/3 基建修复合理）；定向 38 passed + 全量 pytest **925 passed / 4 存量失败零新增**（勾稽 905+20=925 ✓）；5 文件 py_compile 过；红线七条全过（无 content_hash/turn_hash 未动/get_context 未碰/st-vec 零改动）；后端容器重建 **healthy**，镜像内三标签在位，DB 实测 message_id 列 + idx_memory_message_id 索引迁移生效、记忆表归零。⏸ 剩余：真实对话体感实测（编辑消息→记忆替换）待用户择机

### [已完成] 记忆向量孤儿数据：角色扮演三条删除路径级联清理（2026-08-24 排查实锤 + 当日修复上线）
- **现象**: 全库 44 条 conversation_memories **100% 为孤儿**（所属会话均已删除），来自冒烟测试员二(2)/冒烟测试员(2)/桃汐卡会话(9)/更早两个会话(31)；content 约 10KB + embedding text 列（每条 1024 维 JSON 文本约 15-25KB），合计约 1MB 且持续增长
- **根因**: `conversation_memories` 表 session_id/branch_id 均为裸 TEXT 无外键；角色扮演三条删除路径全部漏清——① `character_service.delete_character`（整角色，L116-192 只清 messages/branches/chat_variables/sessions/世界书/群聊引用/ST 文件）② `character_ext.delete_character_session`（单会话 L2719+）③ `character_ext.delete_branch`(L3887-3954)。对照组：普通聊天 `sessions.py:130 delete_session_memories` 有清理——角色扮演路径漏抄
- **功能影响**: 零——记忆检索按 user_id+session_id 过滤（storage.py get_context），死记忆永不召回；纯存储占用 + 隐私残留
- **已排除的嫌疑**: 消息/分支/变量/世界书/会话孤儿 = 0（手动级联完整）；Ollama 纯计算无持久存储；ST DATA_ROOT 未配置（st_sync 未启用，文件侧干净）；silly_tavern.py 的 DELETE 均为 ST vectors 插件手动 purge 端点非级联
- **修复方案（待用户拍板）**: ① 三处删除路径补 `DELETE FROM conversation_memories WHERE session_id IN (...)`（分支删除按 branch_id 圈定）② 一次性清现存 44 条孤儿 ③ 可选长期机制：FK ON DELETE CASCADE 或定期孤儿清扫
- **实施记录（2026-08-24，用户拍板「直接动手」）**: 三处级联已上线（标签 [ORPHAN-MEM-FIX]）——① `character_ext.delete_character_session` 按 session_id 清 ② `character_ext.delete_branch` 按被删分支集合 branch_id 清 ③ `character_service.delete_character` 批量循环内按 session 批量清（`character_service.py` 补 `from sqlalchemy import text`）。存量清理脚本 `_cleanup_orphan_memories.py` 已执行：44 条全删、记忆表归零。验证：py_compile 过；全量 pytest 905/4 零新增；后端容器重建 healthy 且 GUARD-IN-IMAGE: True。此后删角色/会话/分支不再产生记忆孤儿
- **诊断脚本留档**: `backend/scripts/_diag_orphan_scan.py`（全库引用完整性扫描）、`_diag_orphan_detail.py`（孤儿明细）、`_diag_stdata_stale.py`（ST 文件差集）

### [已完成] 思考/正文分离存储（2026-08-23 六步实施 + 四项遗留处置全部收尾）
- **实施交接文件**: `HANDOFF_分离存储实施_2026-08-22.md`（六步全部执行完毕）
- **Step 0 备份** ✅: `_backup/20260823_separate_storage/`（DB 26 行全量导出 SHA256 校验一致 + 12 文件快照）
- **Step 1 访问器** ✅: `utils.py` `[REASONING-ACCESSOR]` get_message_extra/get_message_reasoning/get_display_content + strip_inline_think_full（多块+未闭合尾全量剥离）；13 单测
- **Step 2 写入侧切换** ✅: stream_builder.final_text 纯正文；websocket.py/character_ext.py 包裹拼接删除；`_apply_reasoning_regex` 二元组重构（regenerate 思考丢失修复、continue 追加进 extra）；chat.py 与 api/websocket.py 普通聊天切纯正文+extra；websocket_manager 双分支接线（该函数当前为死代码无调用方）；messages 表新增 extra 列
- **检查点联调冒烟** ✅: 真实 deepseek-v4-flash 全链路（流式→持久化→历史加载→折叠展开）+ 存量混合行不变形 + 控制台零错误
- **Step 3 存量迁移** ✅: `_migrate_messages_separate_storage.py` 用户批准 --apply——1292 swipes 清洗落库；2241/2242 剥离后正文为空按保守策略跳过（维持原状，前端 parse 路径正常显示）
- **Step 4 前端消费点** ✅: useCharacterChat 5 处拼接删除（流式 pending 分离携带 reasoning → extra）、onSync 追赶动画只作用正文、useChatMessages 快照分离持有、messageUtils.buildAssistantContent 废弃删除；Message.tsx memo 兜底直读 message.extra.reasoning（唯一渲染挂点，新旧双兼容）
- **Step 5 插件边界** ✅: CharacterChat.smartCardChatMessages 与 NativeRoleplayChat.toStMessages 预剥离 think 并把提取思考注入 extra.reasoning 兜底（源码不可改的随卡插件靠此保兼容）
- **Step 6 回归** ✅: 后端全量 887 过/4 存量失败零新增；前端 tsc 零错误；dist 重建；后端镜像定稿重建 healthy；真实对话复验（新格式行 DB 干净+历史加载双块渲染+插件边界零泄露）
- **验收标准对照**: 新消息 content=纯正文+extra.reasoning 单份 ✅ / 存量显示导出不变形 ✅ / 折叠展示正常 ✅ / 插件边界剥离生效 ✅ / 测试零新增失败+容器 healthy ✅
- **遗留事项**: ① ~~websocket_manager.save_stream_to_db 死代码~~ → **已删除（2026-08-23 用户拍板）**：save_stream_to_db/update_stream_in_db 两方法及 SessionLocal/ChatMessage/CharacterChatMessage 导入一并移除，守卫测试改写为断言已删除；② ~~2241/2242 病例行~~ → **已删除（2026-08-23 用户拍板）**：2241 经消息删除 API 删除，2242 随「冒烟测试员二」角色级联删除；③ ~~「冒烟测试员二」角色~~ → **已整角色删除（2026-08-23 用户拍板）**：角色+会话+消息级联清除，角色列表仅剩「我被猫娘包围了！」；④ 容器 /tmp root 脚本残留 → **已清除（2026-08-23 docker 恢复后镜像重建完成）**：/tmp 仅剩运行时产物，死代码删除已生效于运行镜像（grep 复核 0 匹配），容器 healthy
- **插件影响审计已完成**（2026-08-22）: 唯一风险点为读 chat[i].mes 的 iframe 类插件（BubbleDialogue 等），缓冲方案=传给 iframe 边界处用 extractReasoningTags 预剥离；ST 生态插件反而更兼容；自研渲染组件正面收益（提取补丁退役）
- **背景**: 当前 assistant 消息 content 列混存 `<think>` 包裹体，且 extra.reasoning 双写同一思维链——同一份思考存两份
- **收益测算**: 典型推理回复（思维链2000字/正文500字）省约 60% 该消息体积；模型思维链越长省越多；存量数据需一次性迁移脚本拆冗余
- **前置条件**（缺一不可，故列为远期）:
  1. 后端访问器封装 `get_display_content(msg)` / `get_message_reasoning(msg)`，所有消费方改走访问器
  2. 前端 8 处消费点迁移（useCharacterChat.ts ×5 / useChatMessages.ts L123 / messageUtils.ts L20 / 渲染层提取逻辑）
  3. 存量数据一次性拆分脚本
- **架构决策记录**: 见 `.trae/specs/separate-reasoning-pipeline/tasks.md` 底部；`<think>` 内联格式是前后端契约（前端主动拼接+渲染层提取），不可单方面后端改造
- **关联**: ST 参照实现 `reasoning.js`（五层体系）；本期已完成的来源归一化/统一解析器为其第 1/2 层基础
- **实施进展（2026-08-23）**: 用户批准动工。Step 0 备份完成（`_backup/20260823_separate_storage/`：DB 全量 26 行导出+SHA256 校验一致；文件快照 12 个）。摸底：content 含内联块行=2、extra 带 reasoning 行=0（存量全为单写形态）。Step 1 完成：`utils.py` 新增 `[REASONING-ACCESSOR]` 三访问器（get_message_extra/get_message_reasoning/get_display_content，extra 权威+未闭合块截尾语义），11 单测全过；全量 871 过/4 存量失败零新增。写入点审计补充发现：`websocket_manager.save_stream_to_db` 为 assistant 写入点但历来只存纯正文不写 reasoning（Step 2 需补接线）；`slash_command_service._cmd_send` 仅写 user 消息无需改
- **实施进展二（2026-08-23，Step 2+冒烟检查点完成）**: Step 2 写入侧切换完成——stream_builder.final_text 改纯正文；websocket.py L651 / character_ext.py L4580 包裹拼接删除；continue/regenerate 经重构的 `_apply_reasoning_regex`（二元组返回）写入 extra.reasoning（regenerate 此前思考只进包裹体属丢失，已修复）；chat.py 与 api/websocket.py 普通聊天路径切纯正文+extra 接线；websocket_manager 双分支接线（**注意：该函数全库无调用方，当前为死代码**）；messages 表新增 extra 列（模型+_RUNTIME_COMPAT_COLUMNS 自动建列）。前端 formatting.ts 兜底直读 extra.reasoning（Step 4 表格该项前置落地，pipeline+Message.tsx 三层打通，dist 已重建）。新增 14 单测，全量 885 过/4 存量失败零新增。联调冒烟检查点全过（真实 deepseek-v4-flash 对话：DB content 无包裹体+extra.reasoning 223 字+swipes 干净；刷新后「模型思考」折叠正常、内容与 DB 一致；存量混合行显示不变形；控制台零错误；测试角色/消息已删）。Step 3 脚本 `_migrate_messages_separate_storage.py` 就绪，dry-run 结果：匹配 3 行=A 类 0+B 类 3，其中 id=1292 仅 swipes 含块可清、id=2241/2242 剥离后正文为空按保守策略跳过；**--apply 待用户批准**

### [已完成] 思考链路对齐 ST：来源归一化 + 统一解析器（spec: separate-reasoning-pipeline，2026-08-22）
- **背景**: 研究 ST reasoning 五层体系后对齐；实施前复核发现 `<think>` 内联格式是前后端存储契约（前端 8 处消费点），原"持久化分离"方案降级为架构决策记录
- **改动**:
  - `stream_builder.py` ×2 + `websocket.py` ×1: 推理 delta 归一化，同时识别 `reasoning` 与 `reasoning_content` 字段（OpenAI 兼容生态两大变体）
  - `utils.py`: 新增 `split_inline_think` / `strip_inline_think` 统一解析器（与历史清洗正则同语义，未闭合兜底全归思考）
  - `character_message_builder.py`: 历史注入的临时正则改用统一解析器（行为等价）
- **验证**: 新增 10 单测全过（`test_reasoning_parse.py`）；全量 860 过/4 存量失败（基线一致）；容器 healthy 镜像冒烟通过；备份 `_backup/20260822_reasoning_pipeline/`
- **架构决策存档**: content 列 `<think>` 内联格式为前后端契约不做分离改造；ST 第 5 层"思考回填 prompt"列为未来可选项

### [已完成] 修复推理模型"一直在思考"无正文（标签平衡守卫，2026-08-22）
- **症状**: 新导入角色卡生成时模型把全部输出写进 `<think>`、正文为空；思维链复读尾部指令出不来（用户视角=一直在思考）。实测两条坏消息：id=2241（think 内 4868 字含指令无限复读+`</Input>` 补关）、id=2242（`<think></p>` + 剧情在 think 内被截断）
- **根因**（日志+DB 实证）: 角色卡「我被猫娘包围了！」自带不平衡标签——世界书「猫神说话格式」（constant）`<猫神>` 开标签无配对闭合、「角色总览」（constant）裸 `<user>`；叠加 Galgame 类插件注入的 `<Input>/<Admin's recent behavior>/<世界状态>` 结构。推理模型遇未闭合标签先"补关"再认为后续都在结构内 → 死循环
- **与同日改动无关的判定**: 坏消息均为新卡导入后第一轮生成（记忆库空、问题标签不经过当日改动的 depth 队列路径），旧注入逻辑同样会把这些标签送入 prompt
- **修复**: `utils.py` 新增 `balance_custom_tags()` [TAG-BALANCE-GUARD]——开>闭补齐文末闭合（后开先闭）、闭>开剥离孤立闭合、void 元素豁免、支持中文标签名；应用到全部注入出口（世界书 8 位置/AN/persona//inject/插件三态/smart_card/记忆行）
- **验证**: 新增 9 单测全过（含真实卡组合复现）；全量 850 过/4 存量失败（基线一致）；容器 healthy 镜像内冒烟通过
- **注意**: 卡数据本身的脏标签建议作者侧修正（引擎守卫只保证不触发死循环，不改变条目原意）

### [已完成] 向量记忆语义切分（方案 B，2026-08-22；存量迁移 2026-08-23 执行完毕）
- **状态**: 代码已上线（容器 healthy）；存量迁移经用户批准于 2026-08-23 执行 `--apply`
- **交付**: `SPEC_向量记忆语义切分_2026-08-22.md`（完整规格）+ 实施代码
- **已完成改动**:
  - `backend/app/memory_module/semantic_chunker.py`（新建）: 语义切分（批量嵌入 1 次调用/缓冲窗口±1/**局部峰值断点检测**/尺寸整形 120~450 字）
  - `storage.py`: `store_chunks()`（批量嵌入+单事务直写 embedding+失败降级逐条）、`get_adjacent_chunks()`（turn_hash 定位 idx±1）、`_chunk_topics/_parse_chunk_meta`（topics JSON 编码块元数据，**免 schema 迁移**）
  - `service.py`: `store_memory` 内部接线（assistant 长回复 ≥250 字自动切分，4 调用点零改动）；`get_context` 邻居扩展（命中块带 idx±1，受 max_tokens 预算约束）
  - `utils.py`: `build_memory_context` 废除 200 字砍头 → 命中块完整注入；预算不足整条跳过；遗留巨物兜底截断
  - 3 个调用点传预算（assembly 1500 / websocket 2000 / chat 2000）
  - `backend/scripts/_rechunk_memories_semantic.py`: 存量重切脚本（默认 dry-run）
  - 新测试 24 个全过；全量 841 过/4 存量失败（与基线一致）
- **⚠️ 算法二次修正（2026-08-22 复核）**: 初版 percentile-95 与 mean+std 全局阈值在"多处话题跳变"的短文本上漏切（跳变越多阈值被抬越高，只认唯一最强跳变，实测 4 场景只切出 2 块）。已改为**局部峰值法**（TextTiling 谱系）：距离为相邻局部最大且 ≥ max(绝对下限 0.12, 全体均值) 即断开，对跳变数量不敏感。参数 `MEMORY_CHUNK_DIST_EPSILON` 可调。
- **参数**（env 可调）: `MEMORY_SEMANTIC_CHUNKING=false` 一键回滚；TRIGGER 250 / MIN 120 / MAX 450 / DIST_EPSILON 0.12 / BUFFER 1 / NEIGHBOR_EXPAND true
- **dry-run 实测（2026-08-22, 局部峰值法）**: 12 条存量长记忆（573~1204 字）→ 切成 2~4 块，边界落在场景/情绪转折处
- **已知小瑕疵**: 长对话段可能从「」引号中间切开（」不在句终止符集），块仍完整可读；后续可将闭合引号纳入切分参考
- **存量迁移执行记录（2026-08-23）**: 用户批准后 `--apply` 落库——12 行 → 29 块（2~4 块/行），0 跳过 0 失败；验证全过：旧 id 无残留、全部带 #chunk 标记、created_at/session/branch/importance 按组保留（12 组与原行一一对应）、抽查块完整可读、全库向量 1024 维一致无维度警告、检索命中正常、全量测试基线不变（860 过/4 存量失败）。临时验证脚本已清理
- **备份**: `_backup/20260822_semantic_chunk/`（7 个改动文件的原状副本）

### [已完成] SPEC 9 项 P1 修复（2026-08-23，docs/SILLYTAVERN_COMPAT_SPEC_2026-08-23.md §11）
- **范围**: §11 全部 9 项 P1 + 指定同批 P2/P3；st-compat/st-native 冻结未动
- **#1 世界书 delay 死锁**: 废弃「激活才初始化计数」模型，对齐 ST chat_length 绝对语义（world-info.js:665-676）——can_activate 按 `chat_length < entry.delay` 判定（worldbook_service.py），build_worldbook_context 新增 chat_length 透传（roleplay_prompt_assembly 计数口径=全量消息数+本轮未落库 user）；state.delay_remaining 不再读写（列保留兼容）。顺带 P3：RECURSION 轮跳过 exclude_recursion 条目（sticky 豁免，ST:4758-4760）。测试 test_p1_worldbook_delay.py 7 用例
- **#2 前端正则三分支**: pipeline.ts shouldSkipStScript 照抄后端 character_ext.py:929-937 语义（普通脚本仅在双 flag 均否的上下文运行=后端 persist 单点）；同批 C-3 空 placement 反义、C-4a minDepth>=-1/maxDepth>=0 守卫、C-4b trimStrings 宏替换。CharacterChat.tsx 下降沿回写删除（三重叠加消除：persist 单点+显示层只跑 markdownOnly）。测试 regex-pipeline-contract.test.ts 13 例 + 后端 swipes 干净锁定（test_regex_p2.py 2 例）
- **#3 $N 双反斜杠**: **SPEC 误报**——SillyTavernCompatRuntime.ts:2296 位于模板字符串内，`\\$` 经转义折叠生成产物实为正确的 `/\$(\d+)|\$<([^>]+)>/g`（探针实测）。加回归锁定测试防重构破坏转义（regex-replace-contract.test.ts 3 例）
- **#4 LaTeX 完成态**: formatting.ts 新增 renderMathInHtml（Showdown 后、DOMPurify 前，$$..$/$..$/\(\)/\[\] 四形态，code/pre 豁免），DOMPurify 白名单放行 KaTeX HTML/MathML 标签与属性、class 前缀化豁免 katex*。流式/完成态引擎切换不再塌回原文。测试 formatting-latex-contract.test.ts 6 例
- **#5 worldbooks/import 字段映射补齐**: 方案 A（补映射列，弃 extensions_json 兜底方案——列已齐备且与 ST 契约路径同构，避免扫描热路径双轨复杂度）。order/sticky/cooldown/delay/depth/selectiveLogic/caseSensitive/matchWholeWords/excludeRecursion/preventRecursion/group 系/scanDepth/vectorized/ignoreBudget/role/useGroupScoring/automationId/match* 六项全量映射，语义对齐 silly_tavern.py:1618-1670。测试 test_p1_worldbook_import_fields.py 2 例
- **#6 经典轨 getContext 补齐**: sillyTavernPluginRuntime.ts getContext 返回对象新增 eventSource/event_types（编译期注入 ST_TO_PALINK_EVENT_MAP）/toastr/getRequestHeaders/substituteParams/saveSettingsDebounced/getChatMessages 等 16 成员 + renderExtensionTemplateAsync 最小插值实现（模板源=resources.templates）
- **#7 沙箱 stub 倒挂**: sandbox.ts triggerSlash/openCharacterChat/setChatMessages/generate/injectPrompts/uninjectPrompts 改为调用时转发主 window 同名真实现（经典轨桥接），缺失时诚实降级 warn；deleteChatMessages 两轨均无底层实现保留桩
- **#8 writeExtensionField 三轨统一**: 共享 writeExtensionFieldCompat（getContext.ts 尾部）——ST 角色卡语义优先（characterId 解析成功→merge-attributes），模块名调用回退旧命名空间语义（存量插件不受影响）。getContext.ts/sandbox.ts×3 处收敛单实现
- **#9 scanner selectiveLogic 错位**: scanner.ts 重构为 evaluateEntryMatch——主键 plain 匹配、logic 只作用于副键层、主键命中+无副键=直接激活（ST world-info.js:4800-4866 权威）。NOT_ANY 排除型条目前端恢复可用。测试 scanner-logic-contract.test.ts 8 例
- **验证**: 后端全量 pytest 898 过/4 存量失败零新增（基线逐一对应 mvu_engine/p1_fixes/st_contract/st_plugin_import）；前端 tsc 零错误 + npm run test:contract 扩至 7 文件 119 用例全过；docker compose up -d --build backend 后容器 healthy
- **勘误记录**: spec §12 的「分离存储进行中」已过时（当日完工）；§11 #3 为误报（见上）；交接文件行号漂移不影响结论

### [进行中] ST 1.18.0 对比分析的后续实施（2026-08-20）
- **状态**: 分析已完成（报告落盘）；待办 3（depth 队列排序权重）已于 2026-08-22 实施 ✅，其余待办未开始
- **交付**: `PALINK_VS_SILLYTAVERN_COMPARISON.md`（完整对比）+ `HANDOFF_ST对比分析_2026-08-20.md`（交接）
- **待办**（按优先级）:
  1. ~~仅补 `{{time}}` 本地时区支持~~ → **已完成（2026-08-25）**：macro_service 六宏本地化（time/date/datetime/weekday/isotime/time_format 改 `datetime.now()`），并修正 `{{time}}` 与 `{{time_utc}}` 被误并为同一 UTC 分支的历史错误（ST 语义本就前者本地/后者 UTC，现拆分）；compose backend 加 `TZ=${TZ:-Asia/Shanghai}`（.env 可覆盖）；`{{idle_duration}}` 差值计算与显式 UTC 宏按设计保留 utcnow。容器镜像重建后实测 `{{time}}`=22:52 本地 / `{{time_utc}}`=14:52 UTC；宿主全量 pytest 1050/0 保持
  2. ~~补 chara note 三态~~ → **已完成（2026-08-23 核对关闭）**：roleplay_prompt_assembly L3155-3186 已覆盖 -1(NONE 跳过)/1(IN_CHAT+DepthInjection)/0、2(prompt 相对) 全枚举 + frequency 门控；builder L1006 注释确认 ST 枚举语义
  3. ~~depth 队列补 ST 一致的顺序权重~~ → **已完成（2026-08-22）**：palink-native 引入统一 `DepthInjection` 队列（`roleplay_prompt_assembly.py`），5 来源（世界书 atDepth/AN/persona//inject/插件 IN_CHAT/角色卡 depth_prompt）汇入单管线，三级确定序 depth↓→order↑→role(assistant→user→system)→key 字母序（对齐 ST `populationInjectionPrompts`/`getExtensionPrompt`/`doChatInject`；key 等价物 `0_palink_injection`/`1_persona_description`/`2_floating_prompt`/`DEPTH_PROMPT`/`customDepthWI_{d}_{r}`/插件 identifier），同 (depth,order,role) 合并单条 join('\n')；删除 ext_depth_entries 第二遍插入；st-compat 分支未动（clear() 守卫保留）。新测试 `backend/tests/test_depth_injection_order.py` 7 用例全过；全量 817 过/4 存量失败（stash 基线对照确认与本次无关）；容器已重建 healthy
  4. ~~核对 `setExtensionPrompt` 沙箱签名与 ST 七参一致性~~ → **已完成（2026-08-23 核对关闭）**：sandbox.ts:3199 七参与 ST script.js:8866 一致（identifier/content/position/depth/scan/role/filter）；role 兼容字符串为超集；prompt-injection.ts:30-37 同构
  5. 补齐未覆盖对比：memory_module/、worldbook_vector_service.py、前端 regex、sillyTavernPluginRuntime.ts、st-plugins/、plugins.py（memory_module 代码虽经语义切分演进，「与 ST vectors 对比」本身仍未做）
- **⚠️ 新增待办池（2026-08-23）**: 见 `docs/SILLYTAVERN_COMPAT_SPEC_2026-08-23.md` §11 —— 9 项 P1 问题（世界书 delay 条目永久沉默死锁、前端正则三分支漏判、智能卡 $N 双反斜杠损坏、LaTeX 流式/完成态断裂、worldbooks/import 字段丢失、经典轨 getContext 缩水、triggerSlash stub 倒挂、writeExtensionField 三轨三义、scanner selectiveLogic 错位）+ P2 批次择要；§12 要求分离存储完工后复核模块 C persist 正则与模块 F 渲染剥离消费点（已于同日复核通过：persist 侧三层正则链在 `_apply_reasoning_regex` 重构中完整保留且思考正则只作用于 extra.reasoning；渲染侧 Message.tsx memo 新格式直读 extra.reasoning 不再重复提取，旧格式 parse 路径不变）。**分工（2026-08-23 用户指定）：该 SPEC 的 P1/P2 修复由其他 agent 执行；本线 agent 只承担审计复核与提示词/交接撰写，不直接改 P1**
- ✅ **上述 9 项 P1 已全部修复（2026-08-23，见顶部「SPEC 9 项 P1 修复」条目；#3 经复核为 SPEC 误报）**
- **P2 存活性甄别（2026-08-25 审计线逐项核对代码现状）**:
  - **已顺带修复无需再做（10 项）**: B-2 mes_example 拆块/B-3 V3 jailbreak/B-5 creator_notes/D-3 prevent_recursion/D-4 useProbability/D-5 WI 全局设置/D-6 预算基数（清理批次总案）；D-7 vectorized（二期接线）；C-3 空 placement 语义 + C-4 深度豁免 ST 主链路（P1 批顺带，pipeline.ts shouldSkipStScript）；F-1 LaTeX（hotfix+契约守卫）
  - **本次直接修（B-6）**: character_book 导入条目级保真——insertion_order 双读排序、extensions 子字段 snake_case/camelCase 全量双读（case_sensitive/match_whole_words/selective_logic/exclude|prevent_recursion/match_*×6/scan_depth/probability/group_*/delay_until_recursion），raw_content 预览顺序同步统一；新增 test_b6_charbook_import_fidelity.py 3 例；基线升至 1053/0
  - **仍开放·需拍板或按需做**: A-4 addOneMessage 双事件同发（getContext.ts:1507）/ A-5 半兼容字段集（tokenizers 枚举等六字段）/ A-6 经典轨缺 window.setExtensionPrompt 全局 / A-7 多租户隔离 M-3（单用户自部署无害，多用户部署才有意义——设计决策）/ B-4 system_prompt 合并注入 vs main 槽 override（设计取舍确认）/ C-4 后半 trimStrings 宏替换（前端 engine.ts）/ C-5 ESCAPED 宏子集 + 卡内正则白名单默认放行（安全向）/ D-9 前后端并行注入结构性风险（需实测触发频率）/ F-2 rehypeRaw 兜底分支未消毒（窄触发 `<object>` 理论穿透）
  - **建议不做（设计权衡/收益低）**: C-6 流式不实时应用正则（结果收敛已文档化）/ F-3 消毒严于 ST（安全更优是特性）/ F-4 流式中间态突变（改动面大收益小）/ F-5 ST media 体系（新功能非兼容债）
- **约束**: st-compat 已封存保持冻结；主攻 palink-native
- ⚠️ **已更正（2026-08-20 核对）**：对比报告原"缺失宏 `{{banned}}`/`{{reverse}}`/`{{roll}}`"结论错误——三者均已在 `backend/app/services/macro_service.py` 实现（L570/705/673）。请勿据此重复实现。
- ⚠️ **报告 §8/§9/§10 部分缺失项声明已过时（2026-08-22 核对）**：`renderExtensionTemplateAsync` 已实现（sandbox.ts P-8）；tokenizers 已实现（K-9）；jailbreak 在 palink-native 有 PHI+模板等价物（st-compat 有完整 D1 合并链）；`{{/regex}}` 宏两边源码均不存在。实施前请勿照抄报告缺失清单。

### [进行中] Palink 本体无限加载排查（backend 内存飙升卡死）
- **状态**: 排查中（2026-08-19），根因未定位
- **现象**: 前端登录页/主界面无限加载；frontend nginx 日志 `/api/auth/config` 反复 499；backend 不响应 /health
- **已确认**: backend 内存飙到 1.975GiB/2GiB 卡死，事件循环阻塞；重启后恢复（177MB）
- **时间线**: backend 重建(19:08) → 导入角色卡(19:15:04) → WebSocket 连接+StreamSession(19:15:28) → tokenizer 下载超时(19:15:40) → backend 卡死 → 重启恢复(19:24)
- **已排除**: tokenizer 下载（后台线程）、Ollama embedding（卡死期间无 /api/embed 请求）、本地 GGUF 加载（无日志）、sentence-transformers（未安装）
- **待办**: 修复/重启 `backend/scripts/_monitor_backend.py` 监控脚本，复现并抓线程栈定位内存来源
- **详见**: `HANDOFF_Ollama部署与无限加载排查_2026-08-19.md`

### [进行中] 统一向量引擎 / 换库（跨两个项目）
- **状态**: Ollama 已 Docker 部署并激活（2026-08-19），存量记忆已全部清除（用户决策，不再重算）
- **来源**: 与用户讨论第二轮对话思维链死循环时由用户提出
- **目标**: 统一 Palink-AI 与另一个项目（奈酱/hemers 助手）的向量引擎
- **决策（2026-08-18 用户拍板）**:
  - 部署拓扑: Palink 与奈酱**同机部署在 NAS**（i3-1315U / UHD 32EU 核显已透传 Ollama Vulkan / 16GB 单通道）
  - 引擎: **Ollama + bge-m3（1024 维）**——核显已验证加速 +57%，效果最强，两项目共享同一常驻模型（内存最优）
  - 存储: Palink 保留 PostgreSQL（多租户刚需），奈酱保留 JSON（集中只读够用）——只统一嵌入层
- **已完成改动**:
  - `backend/app/memory_module/embedder.py`: 新增 `OllamaEmbedder`（httpx 调 `/api/embed`，bge-m3 1024 维），**运行时降级**：Ollama 不可达自动回退 fastembed（不崩溃）
  - `backend/app/memory_module/config.py`: 新增 `OLLAMA_HOST` / `OLLAMA_MODEL`（bge-m3）/ `OLLAMA_TIMEOUT`
  - `docker-compose.yml`（2026-08-19）: 新增 `ollama` 服务（`ollama/ollama:latest`，绑定 `frontend-backend` 网络，端口 11434 映射宿主机便于调试，`ollama_data` 卷持久化模型，`OLLAMA_KEEP_ALIVE=24h` 常驻）；backend `OLLAMA_HOST` 改为 **`http://ollama:11434`（compose 网络服务名直连）**，`depends_on` 加 `ollama: service_healthy`
  - 容器已重建 healthy；backend 容器内实测 `OllamaEmbedder` 激活（dim=1024，`/api/embed` 返回 200）
  - bge-m3 模型已 `ollama pull` 就绪（1.2GB，`ollama list` 可见）
- **⚠️ 其他 agent 的误改（2026-08-18 已纠正）**:
  - 其他 agent 声称"无法安装 Ollama"，改走 SentenceTransformer 加载 bge-m3，并在 requirements.txt 加了
    `sentence-transformers==6.0.0 / torch==2.13.0 / transformers==5.15.0`——**这些版本不存在且容器 Python 3.10
    装不上，导致 docker build 失败**。已移除这些依赖，compose 改回 `MEMORY_EMBEDDING_PROVIDER=ollama`。
    正确路径就是 Ollama（Docker 部署，绑定 palink 网络）。
- **待办（NAS 部署后）**:
  1. ~~存量记忆重算~~ → **已取消（2026-08-19 用户决策：不重算，全部清除）**。`conversation_memories` 已 `TRUNCATE` 清空（0 条），新对话将直接用 Ollama bge-m3 写入 1024 维向量，无需迁移
  2. 奈酱侧无需改动（本就是 bge-m3），两边自动统一
- **验收**: 两项目向量维度（1024）、语义基准一致；Ollama 故障时 Palink 记忆功能不崩溃

### [已完成] 存量脏记忆数据清理
- **状态**: 已完成（2026-08-18）
- **背景**: 历史 assistant 回复中的 `<UpdateVariable>` 块 / 残缺标签可能已写入记忆库
- **动作**: 一次性脚本 `backend/scripts/_clean_memory_pollution.py`（容器内执行），
  扫描 `conversation_memories` 中 role='assistant' 的记录，用 `clean_memory_content()` 清洗
  并重算 embedding（`embed_text`）
- **结果**: 扫描 543 条 assistant 记忆 → 清洗 17 条（剥离功能块后重 embedding），
  526 条本就干净，0 删除，0 失败；数据库残留脏标签 0 条（剩余 3 条为 user 角色用户
  手动输入的状态指令，属用户内容，不在清洗范围）

---

## 已完成工作（记录留档）

### [已完成] MVU 副 AI 变量更新（2026-08-19，解决面板时间/角色信息空白）
- **背景**: 空响应修复后，正文正常输出，但角色面板"时间/角色信息"仍空白。实测根因：deepseek-v4-flash 对"每条回复末尾输出 `<UpdateVariable>` 变量块"的遵循率不稳定（约 50%），主模型没输出块 → stat_data 中时间/天气/地点/服饰/内心想法等字段保持初始空 → 面板空白。这是模型能力问题，非 Palink bug（ST 生态同样存在，社区推荐"副 AI"方案）。
- **方案（用户拍板）**: 副 AI 兜底——主模型未输出变量块时，用独立副模型解析剧情 + 当前 stat_data，生成 `<UpdateVariable>` 块补写变量。适配所有带变量系统的角色卡（schema 从角色卡 tavern_helper 自动提取，不特调）。
- **改动**:
  - `backend/app/models/system.py`: UserSetting 新增 `mvu_secondary_model`（副模型 ID，空=不启用）+ `mvu_secondary_enabled`（开关）
  - `backend/app/schemas/user.py` + `backend/app/api/users.py`: 新字段读写
  - `backend/app/services/mvu_secondary.py`（新建）: 副 AI 服务——构造 prompt（系统指令 + 当前 stat_data + schema 结构 + 剧情），调 `complete_text_completion`（temperature 0.2），解析 `<UpdateVariable>` 块
  - `backend/app/api/websocket.py`: `_run_secondary_mvu_sync` 辅助函数（查询配置 + 跨线程调副 AI）+ persist_snapshot MVU 分支：主模型 `mvu_logs` 为空且副 AI 开启时，用 `apply_patches` 应用副 AI patches
  - `backend/alembic/versions/0060_add_user_setting_mvu_secondary.py`: 迁移（手动执行 `python -m alembic upgrade head`，因 RUN_MIGRATIONS_ON_STARTUP=false）
  - `frontend/src/components/views/SettingsView.tsx`: 设置 UI（副 AI 开关 + 副模型 ID 输入）
- **验证**: 副 AI 服务单测（真实角色 schema + 真实剧情）生成 6-7 个 patches，完整填充世界信息（日期/天气/风力/地点）+ 桃汐（服饰/好感度 50→53/内心想法）；端到端 `_run_secondary_mvu_sync` 链路正常；配置读写正常；前端 tsc 无错误
- **守卫（不特调 + 不乱输出）**: `[MVU-SECONDARY-GUARD]`——`_run_secondary_mvu_sync` 与 `run_secondary_mvu` 均检查：无 schema 且无 stat_data 结构（= 角色卡无变量系统/面板）时副 AI 完全不介入，返回空，不调副模型。仅当卡定义了 tavern_helper schema（z.object）或已有 stat_data 时才触发。实测：有 schema → 介入（2 patches）；无 schema 无 stat → 不介入（0 patches）；无 schema 但有 stat_data → 介入。通用适配所有卡，不特调，无面板的卡不乱输出
- **使用**: 设置 → 开启"副 AI 变量更新" → 填副模型 ID（建议比主模型强，如 deepseek-v4-pro）→ 保存。主模型正常输出变量块时以主模型为准，副 AI 仅在主模型没输出时兜底
- **注意**: 副 AI 每轮多一次模型调用（仅主模型没输出块时），有 token 成本；副模型需在模型列表可用

### [已完成] 修复第二轮对话 100% 空响应（真正根因：IN_PROMPT 注入 append 到 prompt 末尾，2026-08-19 二次定位）
- **日期**: 2026-08-19（两次排查：第一次修错了分支，第二次定位真正根因）
- **背景**: 2026-08-18"记忆污染修复"正确且已生效（本轮实测记忆库数据干净）。2026-08-19 上午第一次排查误将根因定位为"in_chat depth=0 注入"，修了 `_collect_extension_prompts` 的 IN_CHAT depth=0 防护——**用户实测"依旧如此"**。二次排查发现真正根因在另一条分支。
- **真正根因（对照实验 100% 复现）**:
  1. 用户 `silly_tavern_mode = 'st-compat'`（DB user_settings 实测），装配走 `build_st_compat_messages`，而非 palink-native——第一次排查的修复点（roleplay_prompt_assembly 的 palink-native 分支）根本不执行
  2. 前端"对话渲染系统 v7.1"（BubbleDialogue）插件的 `injectPrompts` 在 Palink 是 stub（sandbox.ts），回退走 `setExtensionPrompt(key, content, **position=0(IN_PROMPT)**, 0, false, 0)` → WS extension_prompts(position=0) → st-compat builder 内部把 IN_PROMPT 条目 **append 到 messages 最末尾**（jailbreak 之后 = prompt 最后一条 system 注入，紧贴模型续写位置）
  3. 对照实验（基于真实第二轮 prompt，各 3 次真实调用）：append 末尾 0/3（`</now_plot>` 结尾 → completion=1 立即 EOS；普通结尾 → 模型把剧情正文写进 reasoning 不写 content，与用户日志 attempt 1 的 343 字符剧情 reasoning 完全吻合）；追加到 system prompt 末尾 3/3 正常
- **为什么第一轮正常、第二轮必挂**: 插件异步初始化（applyInjection）——第一轮发出时注入尚未就绪（正常），第二轮注入已生效（必挂）
- **改动**（IN_PROMPT 注入位置修正，对齐 ST 1.18.0 getPromptPosition(IN_PROMPT)='end' = system prompt 末尾语义）:
  - `backend/app/services/character_message_builder.py`（st-compat 路径，**用户实际在用**）: `build_st_compat_messages` 的 ep_in_prompt 处理从"append 到 messages 末尾"改为"并入 messages[0]（system prompt）文本末尾"
  - `backend/app/services/roleplay_prompt_assembly.py`（palink-native 路径，防御同源 bug）: IN_PROMPT 注入同样改为并入 messages[0]
  - 保留第一次的 IN_CHAT depth=0 防护（`_collect_extension_prompts` 的 depth 0→1 + 剥离结尾裸闭合标签，对两条装配路径共用，属合理防御）
  - `backend/tests/test_extension_prompts_st_compat.py`: 7 个断言旧行为的测试更新为新语义（IN_PROMPT 并入 system prompt；role 归一化改在 IN_CHAT 场景验证）
- **验证**: 装配断言（注入进 messages[0]、末尾无注入）+ 真实模型 3/3 正常（且模型正确按 @bubble 格式输出——插件注入真正生效）；相关 pytest 150 全过（全量 798 过/1 失败为 mvu_engine 存量问题，与本次无关）；容器已重建，镜像内复验通过
- **附带清理**: 删除 conversation_memories 中 3 条占位向量 `[1.0,0.0,0.0]` 脏数据（造成检索维度警告）
- **实验脚本留档**: `backend/scripts/_experiment_in_prompt.py`（IN_PROMPT 根因复现）、`_verify_in_prompt_fix.py`（修复验证）、`_debug_inj_location.py`（注入定位）、`_dump_second_turn_prompt.py`（prompt dump）
- **教训**: ① 修 bug 前必须确认用户实际运行模式（本次 st-compat vs palink-native 分支差异导致第一次修错）；② ST 对齐注释声称的行为要与 ST 源码实际语义核对（'end' 指 system prompt 末尾，不是 messages 数组末尾）

### [已完成] 修复第二轮对话思维链死循环（记忆污染）
- **日期**: 2026-08-18
- **根因**: assistant 记忆入库不干净——`<UpdateVariable>`(含内嵌 `<Analysis>`/`<JSONPatch>`) 大 XML 功能块、以及 `<thinking>` 思维链块整块进向量记忆库；注入 prompt 时又被 `content[:200]` 硬截断，切出残缺半截标签 → 推理模型思维链反复自我审查 → 死循环/空响应
- **改动**:
  - `backend/app/utils.py`: 新增 `clean_memory_content()`（剥离 UpdateVariable/thinking 块与孤立标签残余）、`_truncate_by_sentence()`（按句边界安全截断）；`build_memory_context()` 注入前清洗+按句截断
  - `backend/app/api/websocket.py`: 两处 `store_memory(role="assistant")` 改传 `clean_memory_content(full_content)`
  - `backend/app/api/character_ext.py`: SSE 链路同类 assistant 入库也做清洗
- **验证**: 清洗/截断定向单测全过；`py_compile` 三个改动文件通过
- **容器验证**: 已 `docker compose up -d --build backend` 重建，容器内实测
  `clean_memory_content()` 完整剥离 `<UpdateVariable>` 块只留剧情正文，容器 healthy

---

## 决策记录
- 2026-08-18: 死循环修复 = 入库清洗 + 注入按句截断，不依赖换库即可解决；换库是独立的"统一两项目"诉求，后置。