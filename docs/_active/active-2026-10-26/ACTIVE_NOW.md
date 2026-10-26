# ACTIVE_NOW — 活跃/进行中文档路标（2026-10-26）

> 维护人：整理员（GLM-5.3-Flash）。数据来源：分片员 shard-1~6 判 active 的 75 份（B-2）
> + 终审员裁成 B 留置的 21 份（B-1）+ 终审员留原地待主脑的 17 份（C）。
> 「一句话状态」直接摘自分片/终审依据列（有证据会话），本文件不改写结论。
> 判读纪律：文档自述状态 ≠ 事实，动工前按 AGENTS.md 验证纪律找硬证据。
> 同日大整理：28 份零引用完工件已搬 docs/_archive/2026-10/（去向账见
> docs/_active/SPEC_文档大整理与项目状态总账_2026-10-26.md）。**本路标所列文件一律未动。**

## B-1 终审裁成 B 留置（21 份，unknown→B，带终审依据）

路径 | 一句话状态 | 下一步 | 归属
---|---|---|---
docs/REPORT_安全检测_Mimosa深度扫描_2026-09-02.md | 遗留项(全仓扫描+react-router/mermaid/showdown 升级)仍活在 TODOS.md:1505④；package.json 实测 react-router-dom ^7.13.1/mermaid ^11.14.0/showdown ^2.1.0 未升——活引用，留活跃 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_上下文注入最优解_追加式长记忆线_2026-10-11.md | 被活跃 SPEC_自适应上下文注入_2026-10-11 引用(grep 实测唯一引用者；该 SPEC 未落地，shard-5 grep adaptive 0 命中实证)——与其 SPEC 同生命周期 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_包D_信任分级最后一公里_2026-10-18.md | OPEN_ISSUES.md:541『信任分级最后一公里(包D，用户已拍板时机=四包收工后)』——已排期未启动，在途 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_包K_富卡生态扩样_2026-10-18.md | §8 被现行派单入口 SPEC_ST兼容适配待办分层:84 引用为扩样决策依据；OPEN_ISSUES.md:541 已排期(等用户给卡源)——活引用 | 用户拍板后推进/排期 | 用户
docs/_active/report/REPORT_卡片存储shim收益实测_2026-10-21.md | 决策已下(10-22 交接书:177『卡片存储维持 shim 不换真存储』)但报告 §1.1 仍被 OPEN_ISSUES.md:534 行16 在办项引用为取证源——活引用留置 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_卡状态面板取不到数据_可行性核验与施工决策_2026-10-07.md | OPEN_ISSUES.md:123 [P1-0] 在办项引用(核验完成待拍板)——活引用 | 用户拍板后推进/排期 | 用户
docs/_active/report/REPORT_悲观审计_项目可信度体检_2026-10-10.md | 验证纪律主张已制度化为 gate.sh/CI(c7ef194/ddcef2e git 实测)，但 AGENTS.md:161 现行引用本件为纪律依据——归档需先改 AGENTS.md 引用，宁留 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/_active/report/REPORT_第三方真实插件实验与链接安装_2026-10-21.md | OPEN_ISSUES.md:650 [P2-13] 引用为实验全文——活引用 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_记忆与上下文注入_配置调优研究_2026-10-11.md | TODOS.md:248 拍板项引用为权威件；上游 SPEC_记忆降本增效_对比实验设计 active——随链留置 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/_active/report/REPORT_记忆分项基线实测_2026-10-11.md | SPEC_记忆体系降本增强路线图:7/:34/:74 三处引用，0.6 项标 ✅ 已完成消化——路线图 active 随链留置 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_记忆预算与历史配比_全记录_2026-10-10.md | OPEN_ISSUES.md:626 [P4-5] 订正引用为档位表现行权威——活引用 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/_active/report/REPORT_酒馆助手API适配度复查与100%适配判定_2026-10-06.md | OPEN_ISSUES.md:414 [P2-6] 按其 §7 动工顺序排剩余缺口——活引用 | 主脑排期/裁定 | 主脑
docs/_reference/CASDOOR_INTEGRATION_CHECKLIST.md | _reference 目录宪法『不过期的常备资料』——按宪法留置原位 | 按需查阅（_reference 宪法：不过期） | 常备资料
docs/_reference/CASDOOR_INTEGRATION_PRD.md | 同上 | 主脑排期/裁定 | 主脑
docs/_reference/CASDOOR_INTEGRATION_TECHNICAL_ARCHITECTURE.md | 同上 | 主脑排期/裁定 | 主脑
docs/_reference/SEARXNG_ANTI_BAN.md | 同上 | 主脑排期/裁定 | 主脑
docs/_reference/SEARXNG_GUIDE.md | 同上 | 主脑排期/裁定 | 主脑
docs/_reference/prompt_config_guide.md | 同上 | 主脑排期/裁定 | 主脑
docs/_reference/prompts_zh.md | 同上 | 主脑排期/裁定 | 主脑
docs/改皮交付_报错提示原型Palink风格_2026-10-03.md | P1-9 报错提示模板落地[已施工·待真机验收](OPEN_ISSUES.md:228)在途；TODOS.md:519 记『阶段一改皮补做，严格按 PROMPT 文件名』——交付记录随在途议题留置 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/评审_出图能力预检与参考图分档SPEC可执行度_2026-09-29.md | 其评审对象 SPEC_出图能力预检与参考图分档 在册(TODOS.md:887 未开工·待排期 用户拍板 09-29)——随 SPEC 留置 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链

## B-2 分片判 active 原样留置（75 份）

路径 | 自述状态 | 一句话依据（=状态） | 下一步 | 归属
---|---|---|---|---
docs/HANDOFF_相册与渲染问题_2026-10-03.md | 交接件；首部二次核对后 D 节留「新增疑点（未证实，需浏览器实跑）」 | 未被更晚文档点名接班（全仓仅 docs/_active/_README.md:23 当存放示例引用），D 节疑点未见闭环记录 | 主脑排期/裁定 | 主脑
docs/OPEN_ISSUES.md | 跨 agent 优先级台账（今日在改） | git log lastcommit=2026-10-26 且工作区 M；AGENTS.md 现行指定的问题优先级入口 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/OPEN_ISSUES_窄屏卡片三修已上线_首屏入口包未解决_2026-10-05.md | 问题快照清单（5 项已修/1 项未解决） | 被现行 OPEN_ISSUES.md:355 点名引用为 P2-2「完整清单」，议题未关闭（OPEN_ISSUES.md:331） | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/PLUGIN_SECURITY_MODEL.md | 自述「状态：2026-08-17 阶段2落地」；现行信任边界参考件 | 无作废标记且末次提交 2026-10-21 仍在维护，是插件信任边界的现行描述件 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/PROMPT_报错提示模板落地_2026-10-03.md | 派活件 | OPEN_ISSUES.md:228 [P1-9]「报错提示模板落地 阶段一改皮 + 批1止血 · [已施工·待真机验收]」在途 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/PROMPT_报错提示系统重写_2026-09-30.md | 派活件 | 同一在途项 P1-9（OPEN_ISSUES.md:228）覆盖本件的施工与验收 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/PROMPT_接手批_格式规范残本与A_B重测_2026-10-02.md | 派活件 | OPEN_ISSUES.md:321 [P2-1]「格式规范每轮注入 · 真机验收被网关余额挡住」在途 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md | 派活件 | 同上 P2-1 在途（OPEN_ISSUES.md:321-327） | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/REFERENCE_ST上游锚定_2026-10-15.md | 现行锚定制度件 | 配套 scripts/check_st_citations.py 已接入 scripts/gate.sh docs（首部自述），是现行引用可复核性制度件 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/REPORT_移动端UI精致度调研_2026-09-06.md | 自称「移动端精致度议题的唯一权威底稿」，§八为施工记录 | TODOS.md:1368「[P0已施工·待体感验收] 移动端 UI 精致度提升三档方案」在途，验收未闭环 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/SOP_Agent交付自查清单.md | 现行 SOP（两次修订记录在首部） | AGENTS.md「声称已完成前必读」现行引用；末次提交 2026-10-16 仍在维护 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/SPEC_MVU插件能力补齐_P0-P2_2026-10-05.md | 自述「待拍板，未开工」 | 自述过期（部分已施工：mag_* 4 事件已落地）；OPEN_ISSUES.md:371-379 [P2-4]「SPEC 承诺但代码零对应的 4 项（无人认领）」仍以本件为承诺源，尾项开放 | 用户拍板后推进/排期 | 用户
docs/SPEC_世界书向量召回接通与防护_2026-09-29.md | 施工中（:4，09-29 用户拍板 D1=A，前端另批） | 自述施工中→active；主脑交接10-25:177 记世界书向量"三次反转、两开关仍无 UI"，该链仍在迭代 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/SPEC_出图提示词智能化与多设备算力路由_2026-09-29.md | 设计稿，未施工（:4） | 自述未施工→active；TODOS.md:910 仍列为「方向决策·未来路线图」项 | 主脑排期/裁定 | 主脑
docs/SPEC_出图桥接可用性修复批_2026-09-29.md | 本身无状态标记 | TODOS.md:881「[进行中·已派单] 出图桥接可用性修复批」点名本 SPEC 为在途施工件 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/SPEC_出图能力预检与参考图分档_2026-09-29.md | 设计稿，未施工（:3-4） | 自述未施工→active；TODOS.md:887「[未开工·待排期]」（用户拍板 2026-09-29） | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/SPEC_副任务轨迹只读留痕与展示_2026-09-29.md | 设计稿，未施工；等前置（:4-5） | 自述未施工→active；TODOS.md:935「[未开工·待排期] 副任务轨迹」点名本 SPEC | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md | 待施工（:4，含 2 个待拍板决策点） | 自述待施工→active；主脑交接10-25:177 记卡脚本仍能写全局 localStorage（隔离未做） | 用户拍板后推进/排期 | 用户
docs/SPEC_变量自动清理_MVU对齐_2026-10-05.md | 待拍板，未开工（:4） | 自述已过时：OPEN_ISSUES.md:142 [P1-2] 记"已施工、已烤进运行中的容器、零真机验证，默认值危险"——在途待验证 | 用户拍板后推进/排期 | 用户
docs/SPEC_架构审查修复_2026-10-03.md | 待施工，只写方案未动代码（:12） | 自述待施工→active；OPEN_ISSUES rg"架构审查"0 命中（无完工/否决回填） | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/SPEC_重新生成与分支记忆隔离修复_2026-10-05.md | 排查完成、施工图纸（:5）；§8 待拍板 | OPEN_ISSUES.md:425-428 [P2-7]：f006b09 已修 RC-1~3，RC-4 未做无守卫——图纸仍被引用施工 | 用户拍板后推进/排期 | 用户
docs/_active/HANDOFF_2026-10-23_减重与流式改造.md | 交接单（git 最后提交 2026-10-24） | R1：10-24 仍在改；P2-17/18 减重项已上线（OPEN_ISSUES:758/769），余项"减重 L3"列主脑交接10-25 §3.3 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/HANDOFF_D5b与审计尾巴批施工交付_2026-10-25.md | 已完工，待主脑复验（:3） | R1：10-25 在途交付物，待复验 | 主脑复验/裁定后收口 | 主脑
docs/_active/HANDOFF_主脑交接_ST三面一致工程_2026-10-25.md | 当前权威交接书（:3） | 自述当前权威交接书；git 10-25；对照材料本体 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/_active/HANDOFF_全量交接_2026-10-22.md | 交接书（全项目记忆+待办，:3-5） | R6：rg 实测主脑交接10-25 全文无"全量交接"引用（未点名接班），仍为跨项目记忆交接件 | 主脑排期/裁定 | 主脑
docs/_active/HANDOFF_分包派遣提示词_2026-10-18.md | 包系列派遣总表（F/G/H/I/E/J/K/L/M/D 已完工，N/O 可派，:13-24） | 当前包系列派遣总表仍在用：包O 未回执、REPORT_包H 今日仍在工作区被改（git status ` M` 实测），链在途 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/HANDOFF_四问题修复收尾与复核_2026-10-07.md | 已完工待真机验收（:3） | 交付物验收尾巴未清（自述待真机验收），未接班 | 主脑排期/裁定 | 主脑
docs/_active/HANDOFF_审计修复完工_2026-10-10-new.md | 已完工（14 提交落地）·一处验收被环境阻塞（:3） | 阻塞的验收项未见回填收口，交付仍挂尾 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/HANDOFF_提示词_包H_TavernHelper广度_2026-10-18.md | 派单件（P1） | 派遣表标已完工，但 REPORT_包H_TavernHelper广度_2026-10-18.md 今日仍在工作区被改（git status ` M` 实测），H 链今日有尾随施工 | 主脑排期/裁定 | 主脑
docs/_active/HANDOFF_提示词_包O_帧内错误取证_2026-10-19.md | 派单件（P1，~15 行取证） | 派遣表 :24 标"✅ 可派"（非完工）；无 REPORT_包O，OPEN_ISSUES rg"包O"0 命中；注：REPORT_包N_帧内报错取证…文件名与 O 的取证范围重叠，是否并单执行待主脑裁定 | 主脑复验/裁定后收口 | 主脑
docs/_active/HANDOFF_提示词_包X_甲类第一批六键_2026-10-19.md | 待派（等包W收工后再派） | 无 REPORT_包X；六键中 4 键已由包AB（批次A写桥）交付，registerMacroLike 有 z-package-macro-register.test.ts 实现痕迹，stopGenerationById 仍只见于 palink-diag.ts 缺口登记——无整体接班点名，剩余项未交付 | 主脑排期/裁定 | 主脑
docs/_active/IMPL_项目减重_2026-10-23.md | 无标记（执行手册） | L1/L2 已落地（2ed4362/63b9168/d9d913a/a9d282b），L3 未做且主脑交接书 §3.3 在册「可做可不做」——执行手册仍活 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/PLAN_项目减重_2026-10-23.md | 无标记（计划） | 同上；交接单 6b7d617 将剩余项并入减重与流式改造线，L3 未收官 | 主脑排期/裁定 | 主脑
docs/_active/SPEC_下一程计划_用户裁定与排期_2026-10-26.md | 施工中 | git status 为未跟踪新件（??）；今日用户裁定批的权威排期，§0 点名在跑链 dwfrun-9ee566c0 | 用户拍板后推进/排期 | 用户
docs/_active/_README.md | （目录规矩文件） | AGENTS.md「文档存放规范」引用的现行规矩，长期有效 | 按现行制度使用与维护 | 全体 agent（主脑维护）
docs/_active/report/REPORT_API4_媒体落库取证_2026-10-24.md | 已完工待验收 | 2026-10-24 三面一致施工链在途交付物（主脑交接书 §1.3 消费中，765022c） | 验收回填（复验通过即可归档） | 主脑
docs/_active/report/REPORT_ASM1_卡内正则与预算双算定性_2026-10-24.md | 已完工待主脑裁定 | 同上；S-1/S-3 证伪结论已被 D5b 尾巴批 S-1s 项消费 | 主脑复验/裁定后收口 | 主脑
docs/_active/report/REPORT_NF1_role空值消息取证_2026-10-24.md | 已完工待主脑裁定 | 同上；NF-1 修复已落（884b542），报告属在途工程底账（a0c40e1） | 主脑复验/裁定后收口 | 主脑
docs/_active/report/REPORT_P224内容层四件施工_2026-10-25.md | 已完工·已上线·终验通过 | 10-25 交付（d2d74eb/1172b0b/e1e471c/787dfc4），今日工程链产物 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_ST三面一致性差距评估_装配显示与插件API_2026-10-24.md | 已完工（只读评估） | 10-24 在途工程的差距底账，配套 SPEC_ST三面一致对齐施工计划 仍在执行 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_ST全量适配悲观审计_2026-10-22.md | v2 订正版 | 10-24/25 链的 FAIL/BLOCKED 底账（三面评估/VER1/D5b F 族均引其 §），在途消费中 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_ST设置前端可达性盘点_2026-10-21.md | 待施工（盘点，非施工单） | 部分已被批次UI1（c72bb23）与 UI-1b（36f75fa）消费；设置控件余项仍在 SPEC_下一程 §3.5 排期 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_ST配置文件与默认值缺口盘点_2026-10-21.md | 主脑一手比数 | ①默认状态对象已由 API-2 落地（90e4f16）；②预设模板库/导入器仍待拍板并已排期（SPEC_下一程 §3.12、T8 调研中） | 用户拍板后推进/排期 | 用户
docs/_active/report/REPORT_VER1_装配同构差异_猫娘卡补跑_2026-10-24.md | 已完工待主脑复验 | 10-24 在途链（VER1b 判例来源，765022c） | 主脑复验/裁定后收口 | 主脑
docs/_active/report/REPORT_VER1_装配同构差异首版_2026-10-24.md | 已完工（主脑复验收讫） | 复验收讫但它是 ASM-4/D-5b 的施工图（§7 裁定表），属在途工程基准（c694bc6） | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_VER1b_全卡池装配同构普查_2026-10-24.md | 已完工待主脑复验 | ef39407 主脑复验裁定=ASM-4 施工图定稿，在途链判例库 | 主脑复验/裁定后收口 | 主脑
docs/_active/report/REPORT_VER2_事件往返对齐_2026-10-25.md | 已完工待验收 | dd93509/d8a6556 入账；真机层仍在下一程（交接书 §3.1.2 需浏览器） | 验收回填（复验通过即可归档） | 主脑
docs/_active/report/REPORT_VER3_插件兼容矩阵_安装面首版_2026-10-24.md | 已完工待主脑复验 | a0c40e1 入库，10-24 链在途（外部富卡扩样 VER-1c 相关排期） | 主脑复验/裁定后收口 | 主脑
docs/_active/report/REPORT_style_removal机制研究_2026-10-21.md | 只读研究·待用户裁定降噪档位 | 裁定已下=降噪（SPEC_下一程 §1 #7），施工排在 §3.8——仍是待施工依据 | 用户拍板后推进/排期 | 用户
docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md | 已完工待验收（分类全表+fixture+契约测试…） | ⚠️ 2026-10-26 02:25 工作区被施工链追加 53 行（`git diff --stat`=53 insertions、mtime 实测），按规则 10-24 后修改一律 active | 验收回填（复验通过即可归档） | 主脑
docs/_active/report/REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md | （无状态行）更新版，自述取代旧版路线图 | L7 自述「旧版，本文件取代它」＝现役最新路线图；git 最后提交 10-20；未见被更新版本取代 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_提示词体检_新鲜眼审读_2026-10-25.md | 已完工待主脑裁定 | 10-24 后修改/创建（git 最后提交 2026-10-25，61ae2b0）；交接书 §1.6 现役消费（结构层验收闭合、内容层转 P2-24 已施工 d2d74eb/1172b0b） | 主脑复验/裁定后收口 | 主脑
docs/_active/report/REPORT_方案_记忆搜索查询稀释修法_2026-10-26.md | 已完工待审读（只读查验·2026-10-26） | git 未跟踪新文件，mtime 2026-10-26 02:50（stat 实测）；今日施工链在途交付物，规则强制 active | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_查验_MVU变量快照体量与清理必要性_2026-10-26.md | 已完工待审读（只读查验·2026-10-26） | git 未跟踪新文件，mtime 2026-10-26 02:48（stat 实测）；今日在途交付物 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_查验_TestInstruct12行来龙去脉_2026-10-26.md | 已完工待审读（只读查验·2026-10-26） | git 未跟踪新文件，mtime 2026-10-26 02:54（stat 实测）；与交接书 §2「无 TestInstruct 变化（仍 12 行，等点头）」对应的在途查验 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_查验_ollama日志通道失效_2026-10-26.md | 已完工待审读 | mtime 2026-10-26、git untracked，10-24 后新建的在途交付物 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_查验_worldbook四件引用复核_2026-10-26.md | 已完工待审读 | 同上，untracked 新建；引用 HANDOFF_主脑交接_2026-10-25:66 在办事项 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_查验_刷新即丢_setChatMessages落库_2026-10-26.md | 已完工待审读 | mtime 2026-10-26 untracked，对应 OPEN_ISSUES [P2-9]/[P2-10] 在办 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_查验_网关DeepSeek渠道与采样模型切换_2026-10-26.md | 已完工待审读 | mtime 2026-10-26 untracked，承接 HANDOFF_2026-10-25:52/69-70 挡点 | 主脑排期/裁定 | 主脑
docs/_active/report/REPORT_调研_SD预设模板机制与Palink方案_2026-10-26.md | 已完工待审读 | mtime 2026-10-26 untracked，主脑任务 T8 在途 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/report/REPORT_重复造轮子审计_2026-10-23.md | 无状态行 | 无状态标记但被 10-24 差距评估、10-23 PLAN_项目减重、10-26 worldbook 查验引用为活底账（grep 实证） | 主脑排期/裁定 | 主脑
docs/_active/spec/SPEC_ST三面一致对齐施工计划_2026-10-24.md | 待施工（首部） | HANDOFF_主脑交接_2026-10-25.md:5/119 点名其为「施工总纲」且已有 §0.1 拍板、§11 Wave3 交付记录——自述待施工已过期，实际在途 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/spec/SPEC_ST兼容层修复计划_承接S5评审_2026-10-16.md | 批1/2 完工，未闭环 T5/T7/T1 | 首部明写未闭环项（T5 待实现、T7 阻塞、T1 方案③未做）= 施工中 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/spec/SPEC_ST兼容适配待办分层与排期_2026-10-19.md | 生效中（唯一派单入口） | 自述生效中，全部未完项的派单入口 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/spec/SPEC_低性能服务器架构缺陷与优化_2026-10-07.md | 待施工（未动一行代码） | 反证未修：docker-compose.yml 与 backend/app/core/config.py grep shared_buffers/threadpool/gzip_static/stop_grace_period 均 0 命中 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/spec/SPEC_卡状态面板取不到数据_三层根因修复_2026-10-06.md | 待拍板，未开工 | docs/OPEN_ISSUES.md:121 [P1-0] 最新回填「核验完成，待拍板，未开工」，议题存活 | 用户拍板后推进/排期 | 用户
docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md | 台账生效中（§1 落地，§2 待施工） | mtime 2026-10-26（git status modified），施工链在改（本片实测元数据）；台账型文件生效中 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/spec/SPEC_审计后综合治理方案_2026-10-10-new.md | 待施工 | 自述待施工；grep 综合治理/臃肿 无取代证据，10-19 排期未点名接管 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/spec/SPEC_自适应上下文注入_2026-10-11.md | 未落地 | 自述未落地；反证未修：roleplay_prompt_assembly.py 与 config.py grep adaptive 0 命中 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/_active/spec/SPEC_记忆体系降本增强路线图_2026-10-11.md | 待拍板（未开工） | 自述待拍板未开工，无被取代证据 | 用户拍板后推进/排期 | 用户
docs/_active/spec/SPEC_记忆降本增效_对比实验设计_2026-10-11.md | 待拍板（未开工） | 自述待拍板；TODOS.md:236 仍引用其 §九 删除清单，在用 | 用户拍板后推进/排期 | 用户
docs/_active/spec/SPEC_酒馆助手API三分类与实施指南_2026-10-06.md | 待施工（等用户拍板动工） | 自述待施工；其 10-08 首部订正称方案「仍有效」且 A-0 投影已实测有效，剩余逐项实施无取代证据 | 用户拍板后推进/排期 | 用户
docs/_reference/_README.md | 目录宪法：不过期的常备资料 | 自述「这里的东西不过期，是随时可能需要查的常备资料」（首部实测） | 按需查阅（_reference 宪法：不过期） | 常备资料
docs/smart-card-runtime-rewrite-spec.md | 自述「DRAFT（待其他 agent 接手执行）」 | SPEC 自述待施工且无文档点名取代（grep _active/OPEN_ISSUES/TODOS/_INDEX 零命中）；其目标（消除手写 ST 兼容层）未达成——AGENTS.md 2026-10-22 实测兼容层仍 10085+2590 行在场 | 随在途施工链推进（SPEC_下一程 §0 点名 dwfrun-9ee566c0） | 在途施工链
docs/待验收项判据补齐_2026-10-03.md | 自述「状态一律维持待验收，补判据不等于验过」 | TODOS.md:1345/1369 现行引用它作为两条在途「待容器验证/待体感验收」项的判据来源 | 验收回填（复验通过即可归档） | 主脑

## C 留原地待主脑（17 份，判定已到证据极限、只差归属决策，一律不许硬判）

路径 | 已查明的事实 | 待主脑裁的问题 | 归属
---|---|---|---
docs/PERF_低风险修复批次_移交_2026-09-02.md | §4 剩余 12 项参差：B7 预压缩已施工（nginx.conf:25 [性能 2026-09-21 N5]）；A1 分页接线实测未做；B6 字体瘦身未做；首屏线已被 10-22 交接书:177 否决 | 剩余项是立账进 OPEN_ISSUES、并入减重线、还是整体作废关闭 TODOS.md:1506 | 主脑
docs/_active/report/REPORT_包AE_ST-GAP总账对账_2026-10-20.md | 主 FAIL 已被包AG_I 转 PASS；剩 2 WARN（F-2 声明计数差 2 键、F-3 口径与 st289 fixture 缺失）显式『需主脑定』，全仓无回填 | 2 WARN 怎么裁：改声明、补 289 fixture、还是缩口径到 134 面 | 主脑
docs/_active/report/REPORT_包AG_D前端静默与后端留痕_2026-10-20.md | 代码已入库（71beb49），首部『真机未做（容器内 JSONL 对账）』无补做回填 | 真机对账是补做、排期，还是接受单测覆盖关单 | 主脑
docs/_active/report/REPORT_批次小尾巴_CSS生成器与沙箱读写同域_2026-10-21.md | ①③-B4 已修真机复验；② 通道级实机验已补（39cd74e/3cb3980）但 UI 步『如实挂起』；③-A④ 只出证据未动手 | 挂起项是否立账；还是随 Q1 同源放开口径关闭 | 主脑
docs/_active/report/REPORT_悲观刻薄审计_第三次独立全仓体检_2026-10-11.md | 零活引用（仅 _CATALOG）、无验收回填；其前作（第二次体检）已是 AGENTS.md 权威依据 | 是否承认其结论已被后续线消化而归档，还是逐条复核后处置 | 主脑
docs/_active/report/REPORT_智能卡休眠唤醒自激闪烁_2026-10-07.md | 已定位+已施工+离线实证，『待真机复测』无回填（git --grep=休眠 仅命中主题不同的 10-06 线） | 真机复测是否值得排队（与 P4-1 iOS 幽灵历史线交叉） | 主脑
docs/_active/report/REPORT_服务器性能实测与优化_2026-10-08.md | 2 项零风险优化生效有读数；其余未动；与 SPEC_低性能服务器架构缺陷与优化_2026-10-07 同域但互不引用 | 未动部分并入该 SPEC、还是单独立项 | 主脑
docs/_active/report/REPORT_真实角色卡兼容性实测_酒馆助手卡_2026-10-18.md | 上游已供 包H/包I 消费；自身 §4/§5『需用户决策的架构取舍』无下文 | 该取舍是否已被包H 分类全表隐式回答；没有则立账 | 主脑
docs/_active/report/REPORT_纯代码级全仓审计_2026-10-12.md | 零引用孤儿，发现项消费去向不可考 | 逐条对账后发现归档，还是按过时快照直接归档 | 主脑
docs/_active/report/REPORT_记忆切分A与B复核_改口丢失实测_2026-10-08.md | §6 五项待办判据写死（时间序号标注/邻居放宽/改口取代标记/importance 加权/召回实验），无台账归属 | 五项是立账 P4、并入记忆降本路线图、还是随句级回退作废 | 主脑
docs/_active/report/REPORT_线上三问题排查_变量展示_记忆注入_功能按钮_2026-10-07.md | 问题2=已闭的 P0-0；问题1（变量展示：SSE/WS 契约不对称+结构性）未动代码无归属；问题3a=网关余额非代码 | 问题1 是否立账 | 主脑
docs/_active/report/REPORT_角色卡对话页性能四问题排查_2026-10-07.md | 问题4 P0/P1 未做、repaintKick 修复已撤回；被 C 簇两报告引用 | 与 #6/#7 同簇打包处置 | 主脑
docs/SPEC_插件设置按卡隔离适配_2026-10-04.md | 仅批次0-1 有交付记录（REPORT_插件设置按卡隔离_批次0-1交付，复核订正四缺陷全 ✅）；主题域今日正被并行链触碰（extension-settings-store.ts 等在改）；10-22 交接书:177 记卡脚本仍可写全局 localStorage | 剩余批次是否仍要做、由谁做；与今日在途改动是否同一件事 | 主脑
docs/_active/spec/SPEC_臃肿治理施工_复核版_2026-10-12.md | 未施工（git log 0 命中）；后继治理线（综合治理方案/项目减重）均不引用它 | 并入减重线、保留待排期、还是作废 | 主脑
docs/_active/prompt/PLAN_ST适配修复计划_仅供参考_2026-10-22.md | 自述非施工令+证据分级；P3『帧内先取证』已被 10-24 三面一致工程执行；P0-P2 无交付对应 | 未被覆盖的【单证】【推断】条目由谁接管；无则归档 | 主脑
docs/st-plugin-compat-spec/phase-4-palink-native-yield.md | _INDEX.md:124-125 明示『phase-4 是 palink-native、不能整目录封杀』；但本文双轨前提（sidecar 代理）已随 09-03 删轨过期，五个双轨冲突均已另行演进（装配让位 2026-09-26 等） | 主题活着但文本旧：加失效横幅后归档，还是重写一份现行版让位说明 | 主脑
docs/评估_前端渲染层待议项_2026-09-22.md | 四项待议（虚拟化/SW 等）只评估未决，无任何台账登记；其 P0/P1 前置批次均已完成 | 是否按其『先测量再决定』立项，还是登记为 P4 方向决策 | 主脑

## 统计

- B-1：21 份；B-2：75 份；C：17 份；合计 113 份。
- 数据源文件：.tmp_probe/doc_triage/{shard-1..6.md, final-plan.md}（分诊/终审原始会话产物）。

