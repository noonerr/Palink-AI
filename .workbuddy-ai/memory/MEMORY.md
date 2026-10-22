# MEMORY.md — Palink-AI 长期项目约定

> 跨会话硬约定。过程细节看 `memory/YYYY-MM-DD.md` 与 `docs/_active/report/`。

## 技术方向（用户拍板）
- 本地 LLM 一律不做生成；唯一本地模型=向量嵌入（ollama bge-m3）。永久出局：HyDE/查询改写、LLM 摘要/记忆压缩、锚定重嵌、LLM 参与 rerank/扩展/标注。
- 零付费：评测不调付费 API；真机测卡 `page.route` 本地 fulfill。
- 待删（动刀前须用户确认+查引用链）：local_model_registry.py、llama_runtime.py、inference_queue/dispatcher 本地分支、unified_model_registry 本地段、SUMMARY_MODEL、compact_title_service.py:110。

## 命令行环境
- 唯一 shell=Git Bash；Python 一律 `py`（python 空壳 exit=49）。不可用：powershell、wget、jq、make、7z、gh、yarn、sqlite3、psql、redis-cli。
- Windows 输出 GBK ⇒ `| iconv -f GBK -t UTF-8` 或只认 ASCII 行。`reg.exe`/`docker exec` 前 `export MSYS_NO_PATHCONV=1`；`docker cp` 宿主路径不能加。
- `git commit -m` 反引号被 bash 吃 ⇒ 用 `-F <消息文件>`（`.tmp_probe/` 相对路径），`-F` 须在 `-o -- <paths>` 前。curl 用 `/c/Windows/System32/curl.exe --noproxy '*'`。
- `backend/app` 未挂载容器 ⇒ 迭代期 `docker cp`；动容器/重建镜像权限已移出施工方，先问主脑。

## 验证纪律
- 只认 `failed = 0` 且 `errors = 0`；passed 会漂。全量 pytest 必须 `--basetemp=/tmp/pb_$RANDOM` 才有汇总行。退出码不能管道测，判 `OK`/`STALE` 文本。
- "测试守住行为"须改坏证明会红+还原证明回绿；策略内核单测全绿≠接线生效，埋巨型组件里先抽出再写 jsdom 测试。
- 探针口径先核再用（sessions 分页不过滤、`extra:{}` no-op、`custom-` 前缀都栽过）；403≠路由存在（CSRF 中间件先于路由，`main.py:386`；404 才证不存在）；5xx detail 被抹（:575-583）⇒ 抛 `ServiceError`。
- 已入库=可归档；未入库=在途工作别碰。只用 `git commit -o -- <pathspec>` 提交自己的文件，禁 `add -A`/`commit -a`。
- **门禁快照必须带时刻**：多 agent 合住时工作区与镜像都会在分钟级变化（2026-10-22 02:08 工作区新增 5 个改动、02:19 后端镜像被重建 ⇒ 容器从 `==HEAD` 变 `==工作区`）。`git status` 别用 `head -N` 截断（`?? _BACKUPS/` 会挤掉 `M` 行）；任何"容器==HEAD"结论都要写清测量时刻，并在收尾时复测。
- 容器内文件是 **CRLF** ⇒ 与 `git show HEAD:` 比 sha256 必然不等，必须 `diff --strip-trailing-cr` 比内容。
- 动 `docs/` 就重跑 `py scripts/docs/gen_docs_catalog.py` 再 `--check`；生成物内嵌时间与跟踪状态，**提交后必然再变一次**，提交完复跑带走。

## 前端部署（dist 归主脑）
- dist 是 nginx bind mount ⇒ `build frontend` 完全无效，永不直接动；`npm run build` 的 clean-dist.cjs 被守卫拦 ⇒ dist 删半 ⇒ chunk 404。
- 正确姿势：`VITE_OUT_DIR=dist_new node scripts/build-vite.mjs` → `cp -r dist_new/. dist/`（只增不删）→ `node scripts/gzip-dist.cjs` → dist_new **mv** 进 `frontend/_QUARANTINE_*/`。真机新代码 ⇒ 旁路 `VITE_OUT_DIR=dist_<代号>` + vite dev 探针（5213/5215，`-s=pkg-<代号>`）。

## 真机验证
- playwright-cli；`run-code` 用 `--filename=./x.js`；会话不跨 bash 持久 ⇒ 同命令 `open`+`run-code` 连写；输出重定向到文件再读。
- 认证 `POST /api/token`（admin/admin123）→ 双 Set-Cookie；mutating 带 `X-CSRF-Token`；前端已不读 `localStorage.palink_token`。
- 端口 **16000**；生产包 console 被剥 ⇒ 取证靠 DOM/运行时对象；`page.frames()[0]` 是主页面，srcdoc 卡帧 `for (const f of page.frames())`。
- `__palinkCompatStats` 惰性创建且 goto 重置 ⇒ 触发与查看同一 SPA 会话。卡测试入口=`/characters/<cid>`；`/chat?character_id=` 死路。

## ST 兼容层（勿按名字删）
- ST 双轨已删≠兼容层可删（Palink 卡片渲染底座就是它）。禁整文件删 `SillyTavernCompatRuntime.ts`、`legacy-st-sim.ts`、`api/silly_tavern.py`、`card-script-runner.ts`（`CharacterCardRenderer.tsx:14-16` 还 import）。
- 命名陷阱：`synthesize_tts_st_compat`、`'st-compat-v2'`、`st-vec::`、`get_st_current_user`、`lib/group-chat/`。T1 红线：`migrations.py` 的 `_RUNTIME_COMPAT_COLUMNS` 禁回填 `silly_tavern_mode`/`_theme`。
- TavernHelper「121 键」是探测面（proxy 合成函数），诚实实现值 58/134，两数必须成对。判存在=①`Object.keys` 自有 or ②调用后无 `tavernhelper_key_unimplemented`/`missing_api`。判命令实现三种注册形态：`name:'x'`、`register('x',…)`、别名。
- `ST_GAP_BY_NAME` 键名禁删（`st-gap-ledger-guard` D 组会红），实现了只注释标"已实现于 <提交>"。包H D 类禁注册是诚实红线；唯一例外=能力真落地，须三层同批：正向锚点+台账行+包H计数（13+C+D=134 闭合）。
- 帧内 `requestParent` 两套：legacy 数组原样；v2 `{ok:true,...data.result}` 展开数组/字符串 ⇒ 帧内桥返回要包对象。
- 权威面（`_reference/sillytavern-1.18.0`）：getContext 145 键、slash 289+175 别名、TavernHelper 134（来源=JS-Slash-Runner `@types/function/` grep `readonly \w+ :`）。

## 智能卡关键接缝
- 未信任卡 iframe 是 opaque origin（父侧 `contentDocument===null`）⇒ 读写卡 DOM 必须写在帧内 `part-*.ts`；授信按 cid+源指纹（`CharacterCardRenderer.tsx:1360`）。
- ⚠ `runtime-body/part-*.ts` 是模板字符串：禁裸反引号、禁 `${`（注释里也炸编译）、反斜杠成对写；tsc 不查内部 ⇒ `generated-script-parse-guard` 必过。测试注释禁 `*/`（提前闭合块注释 ⇒ 整份变 no tests）。执行型断言只能用 `COMPAT_V2_RUNTIME_ARTIFACT`。
- 世界书绑定=**两列合取** `character_id`+`type=='character_book'`（写通道 `55ce619` 已补）；后端把 ST `comment` 存成 `title` 须映射回。存储键双兼容（读新→回读旧→抄新，只加不删）。iframe 配额单位是门 `[data-palink-card-gate-id]`，cap=16 无 setCap。
- **沙箱三档（批次Q1 `7f225c8`）**：`static-html`=''；`trustedNative || hostOriginPolicy.grantsSameOrigin` ⇒ 加 `allow-same-origin`；否则只 `allow-scripts`+四能力令牌。判据唯一来源 `smart-card-runtime/host-origin-policy.ts`（白名单：localhost/127.0.0.1/::1/[::1]/RFC1918 三段/.local，**默认不放开**）。`allow-top-navigation` 任何情况不给。
- **帧内读父文档唯一可信入口 = `window.frameElement.ownerDocument`**：未授信帧的 `window.parent` 被 PARENT-ALIAS 代理（`legacy-st-sim-parts/part-a.ts:41-165`），`parent.document` 是模拟控件不是真文档；opaque origin 时 `frameElement` 恒 null，正好当"读不到"判据。
- 帧内 `$` 两轨**不等价**：legacy 轨（part-c）集合有 `.text/.html/.append`，v2 轨（part-05 `createParentDollarCollectionCompat`）**没有**，其 nativeFallback 会把 `.text()` 委托给 DOM 上不存在的 text 方法 ⇒ 静默返回集合本身（形状对语义错）。
- **"放开同源" ≠ "卡能用真存储"**：帧内 localStorage/sessionStorage shim 与 IDB 内存垫片的开关是 `ctx.trustedNative`（`part-01.ts:601`、`part-a.ts:542`），不是 sandbox 属性 ⇒ 本机档放开后卡拿到的仍是按卡桶 shim。卡间隔离的命名空间**不是安全边界**（同源可走 `frameElement.ownerDocument.defaultView.localStorage` 绕过）。
- `shared.ts` 的 zh 文案有**三份副本**（字面量 / `SMART_CARD_UI_TEXT.zh =` / `Object.assign`），后写覆盖先写 ⇒ 改文案必须三份同批。

## 基线数字（引用前看路线图报告 §0.0/§0.4 最新）
- 最佳回归靶子=露缇雅1.2 `c28061bb-a9b7-46a9-a255-2692d57001fc`：7 iframe、帧内 7/7 getContext 194 键 + TavernHelper 76 + Mvu 6。
- 真机零回归面（批次B 派包口径）：`Object.keys(TavernHelper)`=126、getContext 196 键、每帧插件 CSS 5/5、`Object.keys(commands)` 509。
- 写桥四键 `da18b2a` 上线后 C 50/D 71。
