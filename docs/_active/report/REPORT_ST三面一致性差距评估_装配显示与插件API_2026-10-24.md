# REPORT — ST 三面一致性差距评估（提示词装配 / 插件前端显示 / 插件 API）· 2026-10-24

> **状态：已完工（只读评估，零生产代码改动）。**
> 触发：用户 2026-10-24 收窄目标——不求"完美兼容 ST"，但**提示词装配、插件前端显示、插件 API 支持这三面要与 ST 做到一致**，问还差多少。
> 基线：`HEAD 08de9ac`（工作区干净，`_BACKUPS/` 未跟踪行属预期）；门禁与部署一致性为本日一手实测。
> 上游文档：
> `REPORT_完美兼容ST_现状天花板与路线图_2026-10-18更新版.md`（§0.0–0.7 为权威基线流水，本文引用其数字不再重测）、
> `REPORT_ST全量适配悲观审计_2026-10-22.md`（FAIL / BLOCKED 底账，本文对其挂账项逐条 grep 复核）、
> `SPEC_ST兼容适配待办分层与排期_2026-10-19.md`（原全量排期；三面相关条目由本文配套施工件接管）、
> `HANDOFF_2026-10-23_减重与流式改造.md`（减重批现状）。
> 配套施工件：`SPEC_ST三面一致对齐施工计划_2026-10-24.md`（下称**施工 SPEC**）。

---

## 0. 一页结论

| 面 | 现状（实测口径） | 距"与 ST 一致" | 工作量 |
|---|---|---|---|
| 提示词装配 | **约 2/3**：内容层已对齐（条目、宏、槽位、预算），**结构层没动**（世界书/记忆混成尾部独立 system） | 3–4 个批次，含 1 个 L 级装配链重构 | 中 |
| 插件前端显示 | **约 1/2**：渲染管道全通（样式存活/去重/作用域），**扩展面板"不可见"是用户拍板的结果** | 3–5 个批次，最大单项是翻案口径 c 走 (b) 单间轨 | 中大 |
| 插件 API | 读面 **~95%**（getContext 145/145 在场、真可用 ~130）；动面 **83/134（62%）**；命令真实现 **93/289**（现实天花板 ≈180/222） | 5–7 个批次，大头是纯工程量（命令 + TH 乙类落点） | 中（量大） |

**合计：8–14 个批次，按本仓近一周节奏（每天 2–4 个 S/M 批次 + 主脑复验）约 2–4 周。** 其中真正的硬骨头只有三块：
F-5 装配结构重构、(b) 单间轨面板可见、乙类小子系统三件（regex_object / raw_import / inject_slot）。

**三条必须先说清的事实**：
1. **有四条"不一致"是用户自己的裁定，不是技术债**（见 §6，DEC-1~4）。不翻案，三面做完也各缺一角；翻案则每条都是小改动。
2. **事件面是纸面超集**：事件名 117 项 ≥ ST 104，但 `mag_command_parsed` 从未实现（本日 grep 复核零命中），五组"发没发、订阅到不到"的真机判据至今 BLOCKED——**这面按"没验过"计，不能算已支持**。
3. **"一致"目前没有客观裁判**：验证地基只有 3 个真实插件、1 张富卡、≥61 项真机判据 BLOCKED。不先建可测契约（施工 SPEC §1），做完得到的只是一个更大的自评分。

---

## 1. 方法与证据强度

本文证据分三档，行文中以〔本日实测〕〔复验采信〕〔挂账复核〕标注：

- **〔本日实测〕** 2026-10-24 在 HEAD `08de9ac` 上重跑：`bash scripts/gate.sh backend|frontend|docs`、`docker ps`、dist 指纹比对、`grep` 抽查、只读 SQL。原始读数见 §1.1。
- **〔复验采信〕** 近 15 天（10-09 起 381 笔提交、751 文件、+123,384/−15,816）各交付报告的实测读数。采信理由：这批报告普遍带一手探针 + 反证（改坏会红）+ 主脑独立复验，且 10-22 悲观审计证明该流程能自我纠错（v1 被复核打穿 15 处后出 v2 订正版）。
- **〔挂账复核〕** 悲观审计开出的 FAIL 清单，本日逐条 grep 当前 HEAD 确认"仍未修"（防审计后已被并行批次悄悄修掉）。

### 1.1 本日实测读数（可复跑）

| 项 | 命令 | 读数 |
|---|---|---|
| 后端门禁 | `bash scripts/gate.sh backend` | **2437 passed / 23 skipped / 0 failed / 0 errors**，rc=0（192.73s） |
| 前端门禁 | `bash scripts/gate.sh frontend` | tsc 0 错 + vitest **141 文件 / 1742 passed / 3 skipped / 0 failed**，rc=0 |
| 文档门禁 | `bash scripts/gate.sh docs` | 目录一致 + ST 上游引用可复核，rc=0 |
| 容器 | `docker ps` | 5 容器全 healthy；backend Up ~1h（= 10-24 00:45 P2-20 重建） |
| 前端部署一致 | dist 与容器 `index.html` 指纹 | 均为 `assets/index-0pSC1Vx8.js`（= P2-20 上线产物） |
| F-3 复核 | `grep -c rate_limit backend/app/api/silly_tavern.py` | **0**（ST 端点族仍零限流） |
| F-7 复核 | `grep -n _ensure_session silly_tavern.py` | 仍在 `:2911/:2931`（chats/get 读接口仍会写库） |
| F-1 复核 | `grep -n character_id.is_\(None\) silly_tavern.py` | 仍 3 处（世界书面仍只列未绑定书） |
| F-8 复核 | `silly_tavern.py:1632` | shallow `data` 仍只 `{"name": …}` |
| F-6 复核 | `roleplay_prompt_assembly.py:5952` | 首装配丢记忆仍是裸 `logger.warning` |
| mvu_cleanup 复核 | `mvu_cleanup.py:46/48` | 默认仍 `True` / `keep=20`（vs 回看窗口 30，P1-2 无人拍板） |
| 数据卫生 | 只读 SQL | `TestInstruct` 仍 **12 行**污染生产库；`prompt_presets`/`themes` **0 行**；`characters=28` |
| depth 0→1 | `roleplay_prompt_assembly.py:2226-2243` | 强制改写仍在（已裁定维持） |
| 事件名面 | `getContext.ts:796-949` 计数 | `ST_EVENT_TYPES` **117 项** ≥ ST 1.18 `events.js` **104 项**（超集） |
| `mag_command_parsed` | grep backend/app + plugin-system | **零命中**（P1-6 成立：从未实现） |
| `<status_current_variable>` 锚点 | `TODOS.md:1011` | 09-27 遗留仍挂着"另立议题"，未结 |

---

## 2. 装配面：内容对了，位置不对

### 2.1 已对齐〔复验采信，出处：悲观审计 §4 档 A 实测 + 各批次报告〕

- 系统提示词首位唯一（`system_at=[0,25,27]`，中段两条有明确来源）；卡字段 4 段进 `messages[0]`、无重复（`dup_long_msgs=[]`）。
- 宏全替换：`{{user}}/{{char}}/{{time}}` 8 变体残留 0；`{{getvar::}}/{{getglobalvar::}}` 已补（P2-19，`5ccd75e`）。
- 越狱槽三层覆盖（卡 > 模板 > 用户全局，批次JB `a6b52d2`）；作者注后端读写与装配读取全通（只差控件）；格式规范追加进 `messages[0]` 末尾不叠加。
- 历史窗 24 条实测恒定；预算裁剪在 5632 口径下真生效；带图末条 user 变 `[{text},{image_url}]`。
- 世界书**内容级**正确：绑定维度 `character_id+user_id`，未绑定书不注入且留告警，18 条全 `source=character`，constant/disabled 可观测。
- 传 `model` 时 debug 端点与生产装配逐数相同。

### 2.2 差距（按大小排）

| # | 差距 | 证据 | 尺寸 | 为何还在 |
|---|---|---|---|---|
| A-1 | **世界书+记忆+实体卡混成"历史之后的独立 system"**（`messages[25]` 一条 25678 字符），ST 是按 worldInfoBefore/After 语义落位。新旧容器两次 dump 完全一致 | 悲观审计 F-5；生成点 `character_message_builder.py:304` 与 `roleplay_prompt_assembly.py:4975`；ST 参照 `openai.js:1367` | **L**（动装配链，所有深度锚点平移） | 审计建议"只登记不改"（P1-3），至今没立项 |
| A-2 | **两套世界书引擎两套答案**：插件经 `getWorldInfoPrompt()` 看到的激活列表/预算与后端实际装配不是同一份（前端按中文字×2 计、默认预算 16000；后端 `smart_guesstimate` 校准口径）。前端引擎约 1105 行，`getContext.ts:2355` 注释自述"仅供 ST 插件显示兼容"——设计双轨，但双轨=两个真相源 | 重复造轮子审计 Must-fix #3 | **M**（前端改调后端，约 −1100 行） | 属 L3 减重范围，刻意未动 |
| A-3 | **插件 `IN_CHAT depth=0` 被强制改 1**（落点与 ST 相反方向） | `roleplay_prompt_assembly.py:2226-2243`（本日 grep 仍在）；ST `script.js:5572/:5607` | **S**（但要翻裁定，见 DEC-1） | 2026-10 已裁定"平台适配"维持 |
| A-4 | **卡内正则 prompt 侧疑似一条没生效**：report `prompt_regex included tok=0`（0 token = 没改到任何东西）。display 侧是好的 | 悲观审计 S-1（疑似未定性） | 先取证（探针），修复量未知 | 无人认领定性 |
| A-5 | **世界书 depth 条目疑似预算双算**：`worldbook included tok=9476` 里可能已含 6 条 depth 条目，另又在 `worldbook_depth` 计一次 | 悲观审计 S-3（疑似未定性） | 先取证，可能零修复 | 同上 |
| A-6 | `<status_current_variable>` depth 锚点随尾部结构漂移（[1]→[0]，展开体 12260→15159 字符，交叉实验四跑复现） | `TODOS.md:1011`（09-27 遗留） | S（但依赖 A-1 落定后重验） | 另立议题至今 |
| A-7 | debug 端点不传 `model` 产出另一份装配（预算塌 5632、历史裁到 7 条）——工具口径陷阱，易出假结论 | 悲观审计 T-1 | S（收紧缺省或强制警告） | 未派单 |

**小结**：装配面"选哪些内容、宏替换、槽位覆盖"已对齐；**"这些内容以什么形状放在哪"没对齐**。A-1 是结构性重构，A-2 是把插件可见视图接到唯一真相源，A-3 是一条裁定的翻转，A-4/A-5 是两个没定性的疑点。**现状约 2/3。**

---

## 3. 插件前端显示：管道全通，"面板可见"被自己的裁定挡住

### 3.1 已对齐〔复验采信〕

- **消息内渲染**：卡内美化/状态栏真渲染（`custom-` 前缀 + `.mes_text` 作用域，实测 `custom-nk-msg`）；插件 CSS 每帧 5/5 存活（包J 守护快照）；卡自带样式 PRESENT 7/7（包P2 `24c7706` 修掉兼容层 append 搬运致命 bug）；内联 CSS 去重 47,340B→3,156B（包I）；外链失败不弹 toast、取证保留。
- **插件设置空间**：设置抽屉（真节点搬移保 Vue/jQuery 绑定，2026-10-04 批）。
- **语言**：`/st/locales/zh-cn.json` 3645 条 404→200（批次I18N）。
- **控制台错误治理**：9 类定性 → 6 类是我们的锅 → E2/E2b 逐类归零（translate init / summarize TDZ / regex 数组形状 / macros.register / getScriptsByType / debugger.css 内联 14→0）。
- **设置控件**：批次UI1 补作者注四项/破甲/预设选中；D1/D1b 把 `power_user` 对齐到运行时 134 键、`extension_settings` 补到 35 命名空间。

### 3.2 差距（按大小排）

| # | 差距 | 证据 | 尺寸 | 为何还在 |
|---|---|---|---|---|
| D-1 | **ST 扩展面板不可见**：9+ 个挂载容器（qr/regex/tts/vectors/caption/translation/summarize/sd/expressions）是 iframe 内**离屏桩**——插件能跑、命令能用，但用户看不到面板 | `HANDOFF_S4-S5剩余任务_2026-10-15.md`；口径 c 拍板记录；ADAPTATION.md §六 | **L~XL**（(b) 单间轨自立门户，已登记未做） | 2026-10-15 用户拍板口径 c"接受不可见"——**这是本面最大的"差距"，且是裁定** |
| D-2 | **30 项 ST 设置"有接口没控件"**（盘点 A/B/C/D = 31/30/10/2；B 类 30 项无控件） | `REPORT_ST设置前端可达性盘点_2026-10-21.md` | 2–3 个 S/M 批次（用户已点名"以后要补"） | 未派单 |
| D-3 | QR 面板、正则管理器预设下拉等具体 UI **维持阻塞**（落在离屏容器，修好 fetch 也看不见） | OPEN_ISSUES [P2-9] #5 | 依赖 D-1 | 同 D-1 |
| D-4 | `style_removal` 取证噪音 168 条/轮（每帧 24 条顶格上报，样式实际健在）——降噪与"让静默失败可见"的主题冲突 | 控制台九类定性 + E2b 后残留 | S（会话级聚合降噪）+ 小拍板 | 待用户裁定 |
| D-5 | 杂项：`show_character_status` 假控件该删不该补（`PromptSettings.tsx:148` 教用户点不存在的开关）；WorldBookStage 30 个高级列连**读接口**都没暴露（`_stage_to_response` 白名单） | 可达性盘点 §D | S | 未派单 |

**小结**：渲染管道这一半已经做完且经真机复验；**"面板像 ST 一样看得见"这一半被口径 c 明确放弃了**。不翻 D-1，本面的"一致"上限就是"消息内显示一致 + 控件补齐"。**现状约 1/2。**

---

## 4. 插件 API：读面基本完工，动面和命令是工程量

### 4.1 已对齐〔复验采信 + 真插件背书〕

- **getContext**：145/145 顶层键在场、真可用 ~130；6 个非真项全为合法（`chatMetadata` 已改稳定可写单例并落库——P2-20；`tokenizers`/`getRequestHeaders` 批次C 落地成真；`tagMap`/`CONNECT_API_MAP` 合法空容器；`getPresetManager` 架构红线不补）。
- **真实插件撞出来又修掉的通用缺口**：`SillyTavern` 全局（批次SG，Kimi 两条报错消失）；多文件模块链相对导入（批次MC，Smart Memory 27 模块全部求值）；`extension_prompts` 实时视图（R2）；`chatMetadata` 稳定引用 + `saveMetadata` 落库（P2-20，`lastActive` 真机落库实证）。**三个真实 GitHub 扩展目前均可干净加载**（ComfyInject 天生干净；Kimi/Smart Memory 各自的坑逐个修掉；残余：Smart Memory 直连本机 Ollama 被白名单拦属预期，见 DEC-4）。
- **写通道**：人设 11 键 + 角色库写侧 7 键 + 世界书桥 4 键 = 22 键全链路（批次B/A，越权有失败测试）；TavernHelper 满足 **83/134**（A13+C70，D 51）。
- **斜杠命令**：枚举键 509（293 权威主名 ∪ 176 别名，与 ST 同对象）；**真实现 ≈93**；`/listvar` scope、别名进表、宏注册（包Z/AA）已对齐 ST。
- **配置默认**：`power_user` 134 键与 ST 运行时对象逐键一致；`extension_settings` 35 命名空间；快捷回复 save/delete 落库（批次QR）；i18n 资产在场。
- **鉴权与续期**：ST 面滑动续期补齐（L2-2，23 条测试）；`X-Palink-Token` 通道真机验证。
- **服务端**：13 个 ST Extras 端点真实现（包C）；上传/链接安装通道 + 护栏（内网拒绝、非 ZIP 拒绝）真插件跑通。
- **事件名面**：117 项 ≥ ST 104（超集）。

### 4.2 差距（按真实插件会踩的顺序排）

| # | 差距 | 证据 | 尺寸 | 为何还在 |
|---|---|---|---|---|
| P-1 | **secrets 后端 7 端点整条 stub**：插件存/读 API key 链路死（前端垫片已改诚实失败 `32101cf`，后端一直没做）。随仓插件虽零依赖，但"插件 API 一致"这条是硬缺口 | F-2/F-2b；`silly_tavern.py:6394-6449` | M + 存储口径小拍板（存哪/加密/作用域） | 未派单 |
| P-2 | **事件行为面没验过**：`mag_command_parsed` 从未实现（本日 grep 零命中，卡作者唯一官方纠错钩子）；ST-EVT-01..05"发没发、订阅到不到"真机判据 BLOCKED | P1-6 + 悲观审计 §3 | 1 批实现 + 1 批真机点放 | 无浏览器真机面 |
| P-3 | **TavernHelper 剩余 51 键**：`preset_prompt` 19 / `audio_player` 8（订正过"有现成落点"，非 XL）；`regex_object` 5 / `raw_import` 4 / `inject_slot` 2 要搬小子系统（raw_import 还要先定"卡能往库里灌什么"的安全口径） | SPEC 向ST学习台账 §2/§4 | 3–5 个批次 | 乙类"等排行数据"，而排行机制上线后自然数据 ≈0（空转） |
| P-4 | **命令真实现 93 → ≈180**：60–80 条纯逻辑命令（addswipe/delswipe/comment/cut/del/abort/beep/context/createentry/clipboard-*/css-var/db-* 等），无架构风险 | 路线图 §2.1 分类 | 3–5 个批次（纯量） | 未排期 |
| P-5 | **extension_settings 按扩展补子键默认值**：命名空间级默认已做，但扩展内子键（如 memory 的 38 键）没做——`lastActive` 那类崩溃的同族隐患还在 | P2-14 #2 | 1 批（从 bundled 扩展 loadSettings 生成） | 未派单 |
| P-6 | **落库/持久化缺口**：`setChatMessages` 只留痕不落库（COT 格式化 swipe 重载即丢）；`appendMediaToMessage` 父侧恒回 success、端到端落库未证实 | P2-10 #3 + 包G 遗留 | 1–2 批（先证后修） | 待影响评估 |
| P-7 | **libs 垫片语义未核**：DOMPurify/lodash 实测是垫片，涉及消毒语义（安全敏感），排期里标"建议插队"没插 | P2-12 #5 | 1 批（只取证） | 未派单 |
| P-8 | **本机 AI 直连默认被拦**：ST 生态插件习惯直连 `localhost:11434` 等，白名单机制+UI 已做但默认空 | P2-14 补记 1–3 | S（默认值变更，见 DEC-4） | 待拍板 |

**小结**：读面基本完工（~95%）；动面 83/134；命令 93/289。**这一面的剩余项几乎全是"知道、可做、没排"的工程量，只有 P-1/P-2/P-7 需要先定口径或先取证。**

---

## 5. 四条待翻案裁定（不翻案则三面各缺一角）

| 编号 | 现行裁定 | 与"一致"的冲突 | 翻案代价 |
|---|---|---|---|
| **DEC-1** | 插件 `IN_CHAT depth=0` 强制改 1（2026-10 裁定"平台适配"维持） | ST 的 depth=0 落数组末尾（最后一条 user 之后），我们落在之前 | S 级改动 + 5 轮采样级回归验证 |
| **DEC-2** | 口径 c（2026-10-15）：ST 扩展面板**接受不可见**，只保留命令/API 能力 | "插件前端显示一致"的直观含义就是面板看得见 | 走 (b) 单间轨自立门户，L~XL（本面最大单项） |
| **DEC-3** | 202 条命令"探测说有、执行折空串"（对卡最像 ST，配合记录器可诊断） | 与 ST 一致的诚实形态要么补实现、要么可分辨"未实现" | 补实现是大头（P-4）；加诊断信号是 S |
| **DEC-4** | 插件网络白名单**默认空**（SSRF 防护，恶意插件探测本机是真风险） | ST 生态习惯插件直连本机 Ollama/SD/ComfyUI | S（默认放行本机 AI 端口 + 保持外网拦截），或维持并接受这一处不一致 |

**建议**：DEC-1/DEC-3 建议翻（改动小、收益直接）；DEC-2 由用户定（这是产品形态决策，代价最大）；DEC-4 建议折中（本机/内网部署默认放行 loopback AI 端口，公网部署维持默认空——与批次Q1"分场合放开"的既有口径同构）。

---

## 6. 验证地基（悲观的最后一层）

即便 §2–§5 全部做完，仍存在三个不能用代码补的洞：

1. **样本量**：真实第三方插件 N=3、真·富卡 1 张（包K 结论：任何"整体几成能用"不可外推）。
2. **真机判据欠账**：悲观审计 ≥61 项判因无浏览器真机 BLOCKED；事件行为面（P-2）整组在内。
3. **乙类排行空转**：`missingStSubsystem` 排行机制已上线，但自然记录 ≈0，"按真实使用决定投入"的机制没有数据可依。

⇒ 施工 SPEC 把"可测契约"（装配同构 diff、事件真机对齐表、≥20 插件兼容矩阵）列为第一梯队，先于一切修复。

---

## 7. 工作量估计

- **核心一致性闭环**（不含命令长尾与乙类子系统全清）：**8–14 个批次 ≈ 2–4 周**。硬骨头：A-1 装配结构重构、D-1 单间轨（若 DEC-2 翻案）、P-1 secrets。
- **长尾工程量**（P-4 命令 3–5 批 + P-3 乙类 3–5 批）：可并行、无架构风险，随核心批穿插。
- 顺序与依赖、每批验收判据见 `SPEC_ST三面一致对齐施工计划_2026-10-24.md`。

## 8. 本报告的可信度边界

- 三面"现状百分比"是**分级估算**（按已对齐判据 / 总判据的档位比例），不是精确测量；引用时按档理解。
- 15 天交付读数属二手，但其流程带反证与主脑复验，且本日抽查（门禁/部署/挂账 grep）全部吻合，未发现"报告绿、实际红"的样本。
- 事件行为面（P-2）与 61 项 BLOCKED 判据**本报告同样没有补验**——这本身是结论的一部分，不是遗漏。

---

## 9. 复验记录（2026-10-24 开工前主脑复验 · 逐条对源码/参照树）

> 复验范围：本报告全部承重结论。方法：ST 参照树锚点逐行比对 + Palink 源码实读 + 守卫测试实跑。
> **结论：主干成立，订正 4 处**（按"只进不出"规矩原文保留，以本节为准）。

### 9.1 成立项（抽验锚点）

- ST 参照锚点**全部属实**：`script.js:5572` `messages.reverse()` / `:5606-5607` `injectIdx = Math.min(depth + totalInsertedMessages, messages.length)`；`openai.js:1367` worldInfoBefore/After 以带 identifier 的 system 进 systemPrompts 数组；`PromptManager.js:1723` isSystemPrompt 判定式。两棵参照树（`/d/SillyTavern-release`、`_reference/sillytavern-1.18.0`）均在场。
- `character_message_builder.py:304` 尾部 system 追加（`dynamic_parts` join 后 append）属实。
- 前端世界书公式属实：`budget.ts:15-20` `chineseChars * 2 + englishWords`（减重 L1 合并后仍是该公式）；`getWorldInfoPrompt` 帧内可达（`getContext.ts:2380`）。
- `extension_settings` 仅命名空间级默认（OBJECT/ARRAY/STRING/BOOLEAN 四组常量，无按扩展子键）属实；`recordStubHitOnce` 在场（`getContext.ts:38/1778`）。
- TH 83/134（D 51）由守卫测试钉住：`st-gap-ledger-guard`（17 passed）+ `h-tavernhelper-134-contract`（47 passed）本日实跑全绿。
- 帧内 libs 垫片属实（见 9.2-4，严重度上调）。

### 9.2 订正 4 处

1. **DEC-1 / A-3 的成因描述不准**。depth 0→1 不是"平台适配偏好"，是 `[INJ-CLOSE-TAG-GUARD]`（`roleplay_prompt_assembly.py:2218-2243` 实读）：2026-08-19 实证 deepseek 类推理模型在"最后一条消息是 depth=0 system 注入"时高概率空响应（5 采样 3 空；注入以裸闭合标签结尾则 100% 停止），防护是**双重**的——① depth 0→1 + ② 剥离结尾裸闭合标签行。⇒ **ASM-5 不能简单"撤改写"**：正确做法是保留 ②、A/B 撤 ① 后五轮真机采样；若空响应复现，DEC-1 维持原裁定并把该差异列入 VER-1 白名单（"有实证的平台差异"）。风险等级从"S 级小改"上调为"S 级改动 + 真机采样硬门槛"。
2. **P-1 secrets 端点数：7 → 8**。实数 `settings/write/read/view/find/delete/rotate/rename`（`silly_tavern.py:6373-6439` 逐行数出）。
3. **D-1 离屏容器数：统一为 13 个**（不是"9+"或"11"）：9 个插件容器（qr/regex/tts/vectors/caption/translation/summarize/sd/expressions）+ 2 个浮标 wand（translate/token_counter）+ 2 个设置容器（extensions_settings/2），出处 `st-plugins/ADAPTATION.md:184-188`。
4. **P-7 严重度上调**：帧内 DOMPurify 兜底是**零消毒透传**——`part-02.ts:59` `window.DOMPurify || { sanitize: (value) => String(value ?? '') }`。opaque 帧内大概率没有真 DOMPurify ⇒ 卡若经 `SillyTavern.libs.DOMPurify` 消毒不可信 HTML，得到的是**零保护**。从"取证项"升为**安全敏感优先项**（注意：宿主轨 getContext.ts:42 用的是真 dompurify 包，此条仅指帧内）。
