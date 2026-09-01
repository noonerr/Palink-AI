# REPORT_安全检测_Mimosa深度扫描_2026-09-02

> **⚠️ 阅读前必读：扫描期间代码在并行变动**
>
> 本次扫描（2026-09-01 深夜 ~ 09-02 凌晨）执行期间，**用户正在同一工作区并行进行其他修复工作**（分支 `st-plugin-compat-20260727` 有大量未提交改动）。因此：
> 1. 本报告对应的是**扫描启动时刻的工作树快照**，不是某个 git commit；
> 2. 报告中引用的文件名/行号**可能已因并行修复而漂移**，整改前请先在当前代码里重新定位；
> 3. 若某条 finding 指向的代码已被用户顺手修掉，以现状为准，本报告仅作存档。
> 4. 扫描快照目录 `D:\mimosa-scan-snapshot-palink-20260902` 已保留，可复现扫描口径。

---

## 1. 扫描元数据

| 项 | 值 |
|---|---|
| 引擎 | Mimosa MCP security-scan（producer version 0.1.0） |
| 深度 | deep（威胁建模 → 发现 → 验证 → 路径分析 → 报告 五阶段） |
| 实际扫描目标 | **工作树快照** `D:\mimosa-scan-snapshot-palink-20260902`（2,038 文件 / 72MB；选中源码 1,123 文件全部解析成功，0 读失败 0 解析失败） |
| 首次全仓扫描 | `scan-job-mtj14vzb-82023b053ccd7b7f` —— **失败（worker 堆内存不足 code 134）**，见 §2 |
| 本次 scanId | `scan-2026-09-01T20-09-15.665Z-8a025b1f7c74` |
| jobId | `scan-job-mtj3mxm3-ac1392f5c00d3cc5` |
| Seal | `sha256:d97b0ef376fff9e0dfc1418ce0379a82b666c63157b98a468a2cf33b57056c5a` |
| 产物目录 | `C:\Users\Pall\.mimosa\security-scans\project-568323fc4d88fe04cffe279c\scan-2026-09-01T20-09-15.665Z-8a025b1f7c74`（scan-manifest.json / findings.json / coverage.json / seal.json / report.md） |
| Run status | **inconclusive**，completeness=**partial**（threatModel / findingDiscovery / pathAnalysis 三阶段 partial；validation / reporting completed）——**按密封契约，本次不得宣称"项目整体安全"**，只报告已证实/存疑的条目 |

## 2. 扫描口径说明（为什么不是整仓直接扫）

1. **首次对 `D:\项目\Palink-AI` 全仓 deep 扫描在运行约 56 分钟后 OOM 失败**：磁盘上需遍历约 17 万文件、`backend` 目录 17GB（data/models/hf_cache 等运行数据）。错误建议降 `MIMOSA_PROJECT_MAXFILES` / `MIMOSA_CALLGRAPH_MAXEDGES` 或调 `MIMOSA_SCAN_WORKER_HEAP_MB`（宿主侧环境变量，会话内不可调）。
2. 等效缩小范围方案：按 **git 追踪清单**（tracked + untracked-not-ignored）拷贝工作树到仓库外快照，自动排除 `node_modules`（14.4 万文件）、`backend/data`（17GB 运行数据）、`.mimosa` 插件缓存（5,004 文件）；再剔除 `SillyTavern-1.18.0/`（vendored 上游源码，运行时已 [MODE-SEALED] 封存，非 Palink 攻击面）、`tmp/`、`dev_archive/`。
3. 快照内仍包含 `frontend/public/st/**`（内嵌于前端 public 的另一份 ST 静态资产，st-native 封存链路用）与 `st-plugins/**`，这两部分在报告中**单独分桶**，不计入 Palink 一等代码整改面。
4. tar 拷贝因中文文件名编码缺失 57 个非代码文件（`记忆/` 下的图片笔记等），不影响代码扫描。

## 3. 总量与分桶

**336 条 finding**：high 85 / medium 222 / low 29（另 business-logic 候选 3 条已计入 medium）。

| 分桶 | 数量 | 严重度构成 | 定性 |
|---|---|---|---|
| **Palink 一等代码**（backend/app、backend 顶层脚本、frontend/src、scripts/、根目录配置） | **111** | high 77 / medium 5 / low 29 | 本报告主体，逐档见 §5 |
| **vendored ST 前端资产** `frontend/public/st/**` | 208 | medium 202 / high 6 | st-native 封存链路的静态文件（上游 SillyTavern 1.18.0 代码），随上游走，不纳入整改；`sandbox.ts` 污点跨文件链大量落在桶间引用上 |
| **vendored 插件** `st-plugins/**`（如 tts/kokoro.web.js） | 17 | medium 15 / high 2 | 同上，第三方插件源码 |

CWE 分布头部：CWE-22 路径穿越 ×39、CWE-330 随机性不足 ×29、CWE-918 SSRF ×18、CWE-78 命令注入 ×7、CWE-798 硬编码凭据 ×5、CWE-89 SQL 注入 ×3、CWE-95 代码注入 ×2。

## 4. 依赖风险摘要

- 扫描依赖包 **1,084** 个（前端 package.json + 后端 requirements 汇总）。
- 离线通告库命中：**6 个包 / 17 条安全通告**；另有 **220 个包在离线库中无法识别**（unknown）。
- ⚠️ 引擎产物**只返回了聚合计数，未展开包名与 CVE/GHSA 明细**（findings.json 与 report.md 均无）。整改建议：用 `pip-audit`（backend/requirements.txt）与 `npm audit`（frontend/package.json）跑一遍真源核对，把 17 条通告落到具体包。

## 5. Palink 一等代码 finding 分档（含人工抽查三角验证）

> 方法：先全量列出，再对高价值条目逐一到当前工作区源码抽查核实（标注 ✅已复核）。用户并行修复可能已改动部分代码，行号为扫描时点。

### 5.1 真实/需处理（按优先级）

**P1-1 硬编码测试账号密码入仓（CWE-798，2 处，✅已复核为真实）**
- `scripts/st_audit/audit_api.py:11` — `USER="st_audit_2026" / PASSWORD="Audit2026Palink"`
- `scripts/st_audit/compare_worldbook.py:8` — 同款账号密码
- 影响评估：均为本地审查脚本，但 **TODOS.md 记录该测试账号在库内有效**（`fv_browser / FvBrowser2026!`、`st_audit_2026` 等留存），且分支已于 2026-08-24 推送 GitHub——**凭据已随仓库出网**。
- 建议：①轮换/停用这些测试账号；②脚本改从环境变量读凭据；③如仓库为公开或半公开，评估是否需要清理历史。

**P1-2 context_templates 改删端点缺属主/角色校验（business-logic candidate，✅已复核证实）**
- `backend/app/api/context_templates.py:146` `DELETE /{template_id}`：仅 `get_current_user` 登录校验 + 内置模板保护，**任意登录用户可删除/更新任意非内置模板**（同文件 PUT 同样无属主校验）。
- 对比同项目姊妹端点：`instruct_templates.py:170` 删除有完整属主校验（`user_id != user.id` → 404，系统预设保护）✅；`image_generation.py:54` `GET /config` 有登录 + `mask_secrets=True` 密钥掩码、PUT 走 `get_admin` ✅——三选一恰好是漏网的那个。
- 影响评估：多用户部署下属横向越权（改删他人/全局模板）；单用户/家庭实例影响有限。`ContextTemplate` 无 `user_id` 字段属"全局共享资源"，若产品语义就是全局共享，则只需把写操作收口到 `get_admin`。

**P1-3 SSRF 守卫的已知残余面（CWE-918，运行时 2 处，✅已复核为"有防护+登记在案的残余"）**
- `backend/app/services/character_import_service.py:1058/1072`（角色卡头像 URL 拉取）：已有 `_is_public_http_url` 前置校验（scheme 白名单 + localhost 黑名单 + 私网/环回/链路本地/CGNAT IP 全拦截，✅实现核实于 `backend/app/utils.py`），og:image 二次跳转也复查。
- **残余风险**：`urllib.request.urlopen` 默认**跟随重定向且不复查目标**——与 TODOS.md 已登记的「_download_image 重定向 SSRF」同一模式；另 DNS rebinding 理论面未设防。
- 建议：登记过的遗留项顺延处理即可——禁用自动重定向逐跳校验，或以自定义 opener 在每跳套 `_is_public_http_url`。
- 其余 16 条 SSRF 全部在 `backend/scripts/`、`scripts/st_audit/`、`scripts/st-compat/` 等**开发/审计脚本**（请求 localhost:3000 的本地工具），非运行时面，可接受。

**P1-4 SQL f-string 拼接（CWE-89，3 处，均在一次性迁移脚本）**
- `backend/add_columns.py:39`、`backend/migrate_db.py:23`、`backend/migrate_prompts.py:38` —— 启动期/手工维护脚本，无外部输入入口，实际可利用性低。
- 另 cross-file high `st_vector_delete`（`backend/app/api/silly_tavern.py:7621`）✅已复核为**误报**：全部 `sa_text` + 绑定参数（含 `bindparam expanding`），无字符串拼接。
- 建议：迁移脚本改参数化或至少加注释说明输入来源受控；不紧急。

**P1-5 依赖通告落地（见 §4）**：pip-audit / npm audit 各跑一轮，把 17 条命中落到具体包与版本。

### 5.2 设计使然（接受现状，建议写入口径）

**插件沙箱的代码/命令执行面（CWE-95 ×2 + CWE-78 ×7，全部在 `frontend/src/lib/plugin-system/sandbox.ts`）✅已复核**
- 抽查 2480-2537 行：所谓"命令注入"实为插件的 **ESM→CJS 转换器**（`import/export` → `require()` 的正则改写，`JSON.stringify(path)` 安全内插），2664/2883 为沙箱内动态执行插件代码的固有设施。
- 插件体系（AGENTS.md：插件沙箱属于 palink-native 主攻方向）**本质就是运行第三方代码**，这些 finding 是能力描述而非漏洞；真正的问题是**沙箱隔离强度是否兜得住**（iframe srcdoc + postMessage 白名单 + 事件桥），属独立的"沙箱逃逸面评估"议题，建议另立批次做逃逸测试（postMessage origin 校验、DOM 桥面、fetch 代理面）。
- cross-file medium `createSandboxedJQuery xss 入口`（sandbox.ts:2927）同桶：插件容器内的"XSS"对插件自身而言是能力，不是漏洞。

### 5.3 误报为主、抽查已证伪的簇

**路径穿越 CWE-22 ×39（high）**
- backend/app 运行时 26 处中 ✅已复核 12 处，**全部为误报或已有防护**：
  - 配置路径类（`settings.DATA_DIR` 拼接，无用户输入）：`admin.py:90/589`、`crypto_service.py:62`（Fernet 密钥文件读写）、`main.py:63/85`（启动锁文件）、`local_model_registry.py:61/90`、`mcp_service.py:213`、`registry_base.py`、`web_search.py:128`（键白名单+掩码）；
  - 上传防护类：`models.py:240`（`_validate_chat_upload` + uuid 前缀落盘）、`st_resources.py:235/378/499/550`（`os.path.basename` 剥目录 + 冲突加 uuid + sprite zip 解压有显式 zip-slip 守卫 `dest.startswith(root+os.sep)`）。
- 未逐条复核的余量（`backgrounds/expressions/live2d_pool/tts/workspace/model_manager/image_generation_service/tts_service/silly_tavern.py:6617` 等）与已复核样本同模式（`os.path.join` + 受控变量），大概率同判；建议整改时顺手批量过一遍即可，不必当高危对待。
- 其余 13 处在 `backend/scripts/`（5）、`scripts/st-compat|st_audit|debug`（7）、`frontend/vite.config.js`（1）——开发工具链，可接受。
- 另注：`frontend/vite.config.js:40` 为构建配置路径，误报。

**硬编码凭据 5 处中 3 处误报 ✅已复核**
- `frontend/src/i18n/translations.ts:91` 与 `src/App.jsx:113`（根目录遗留旧代码副本）：都是 i18n 文案 `"API 密钥 (Key)"`，非凭据。
- `scripts/deploy_searxng.sh:113`：`secret_key: "$SECRET_KEY"` 是模板变量，非硬编码。

**跨文件污点 219 条 medium 中的桶间误挂**：引擎把 `frontend/public/st/script.js`（vendored ST）与 `plugin-system/sandbox.ts` 的调用关系连成跨文件链（如 "HTTP 请求输入 → sandbox.ts:1517 innerHTML"），本质仍是封存资产与沙箱设施的组合，不构成 Palink 运行时漏洞。

### 5.4 low 档（29 条，全部"不安全的随机数"）

分布：`roleplay_prompt_assembly.py` ×14、`macro_service.py` ×5、`character.py` ×2、`search_rotator.py` ×2、`inference_dispatcher.py` 等。抽查语义均为**剧情随机（骰子/变量宏/选项洗牌）与搜索引擎轮换**这类功能性随机，不承载安全属性（不生成令牌/密钥/会话 ID），**可整体豁免**；仅建议在注释中标注"非安全用途"防止未来被复用到安全场景。另会话/令牌生成若用了 `secrets`/`token_urlsafe`（N8 实现如此）则不受影响。

### 5.5 vendored 资产桶（208 + 17 条）

`frontend/public/st/**`（202 medium / 6 high）与 `st-plugins/**`（15 medium / 2 high）是 SillyTavern 上游代码与其插件的固有模式（`$()`、`html()`、mongo-sort-injection、kokoro TTS 的 eval 链等）。**运行时已封存**（st-native MODE-SEALED；`st-plugins` 属 palink-native 插件目录但文件本身为第三方插件源码，受 5.2 沙箱口径约束）。处理策略：不整改、跟随上游；待用户拍板清理封存代码时一并消失。若未来解封 st-native，需对该桶单独再做一轮扫描。

## 6. 与既往安全加固批次的关系

本扫描未推翻既有批次成果：N-1 XSS 四入口消毒、N-5 WS 归属校验、N-6 HMAC 签名、N-7 上传短令牌、N-8 HttpOnly Cookie + CSRF 双层守卫、N-14 jti 黑名单、上传大小上限、日志脱敏等在扫描中**均未出现对应告警**——静态证据与既有加固面一致。本次新增的真实动作项集中在 §5.1（凭据入仓、context_templates 越权、SSRF 重定向残余、迁移脚本 SQL、依赖通告落地）。

## 7. 建议行动清单（按优先级）

| # | 动作 | 优先级 | 预估 |
|---|---|---|---|
| 1 | 轮换/停用仓内测试账号（st_audit_2026、fv_browser 等），审查脚本改环境变量读凭据 | **P1**（凭据已随分支出网） | 小 |
| 2 | `context_templates` PUT/DELETE 补属主或 admin 收口（对齐 instruct_templates 的做法） | **P1**（多用户越权） | 小 |
| 3 | pip-audit + npm audit 落地 17 条依赖通告明细 | P1.5 | 小 |
| 4 | 角色卡 URL 拉取禁自动重定向/逐跳校验（顺带清偿 TODOS 已登记的 _download_image 重定向 SSRF） | P2 | 中 |
| 5 | 迁移脚本 SQL 参数化或加来源受控注释 | P3 | 小 |
| 6 | 插件沙箱逃逸面专项评估（postMessage origin/DOM 桥/fetch 代理），把"设计使然"变成"有评估背书" | P2（另立批次） | 大 |
| 7 | 路径穿越余量（约 14 处未逐条复核的 backend/app 条目）批量人工过一遍 | P3 | 小 |
| 8 | （可选）向宿主申请调 `MIMOSA_SCAN_WORKER_HEAP_MB` / 降 `MIMOSA_PROJECT_MAXFILES` 后做一次真全仓扫描，覆盖本次快照未含的 vendored ST 全量与数据目录元数据 | P3 | 中 |

## 8. 复现与产物

- 扫描快照：`D:\mimosa-scan-snapshot-palink-20260902`（保留）
- 密封产物：`C:\Users\Pall\.mimosa\security-scans\project-568323fc4d88fe04cffe279c\scan-2026-09-01T20-09-15.665Z-8a025b1f7c74`
- 失败任务记录（全仓 OOM）：jobId `scan-job-mtj14vzb-82023b053ccd7b7f`
- 本报告的人工抽查均在 2026-09-02 凌晨对工作区现状执行；若用户并行修复已触及上述文件，以现工作区为准。

---

*报告生成：ZCode（Mimosa 密封扫描 + 人工抽查三角验证）。结论纪律：coverage=partial，本报告不构成"项目整体安全"断言。*
