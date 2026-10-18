# MEMORY.md — Palink-AI 长期项目约定

> 只记跨会话必须遵守的硬约定。过程细节看 `.workbuddy-ai/memory/YYYY-MM-DD.md` 与 `docs/_active/report/`。

## 技术方向（用户拍板）

- **本地 LLM 一律不做生成**（ollama qwen2.5:0.5b / llama.cpp `local:` gguf 不可调用）。唯一保留的本地模型 =
  **向量嵌入**（ollama `bge-m3`，1024 维）。永久出局：HyDE/查询改写、LLM 摘要与记忆压缩、上下文锚定重嵌、
  任何 LLM 参与的 rerank/扩展/标注。替代只能是 bge-m3 + 关键词检索（pg_trgm/bigram）+ RRF + **纯规则**。
- **零付费约束**：评测/优化不得调用任何付费 API。
- 待删对象（大手术，动刀前须用户确认范围 + 逐条查引用链）：`local_model_registry.py`、`llama_runtime.py`、
  `inference_queue.py`/`inference_dispatcher.py` 本地分支、`unified_model_registry.py` 本地段、
  `api/admin.py`/`models.py`/`silly_tavern.py` 引用、`SUMMARY_MODEL`（`core/config.py:83`）、`compact_title_service.py:110`。

## 命令行环境（本机实测，详见 AGENTS.md）

- 唯一 shell = **Git Bash**。Python 一律 **`py`**（`python`/`python3` 是商店空壳，exit=49）。后端依赖在容器里。
- 不可用：powershell（重启后可用）、wget、jq、**make**、7z、gh、yarn、sqlite3、psql、redis-cli、choco、scoop。
- Windows 程序输出 **GBK**：加 `| iconv -f GBK -t UTF-8`，或只认结构化 ASCII 行（`OK`/`failed = 0`/`rc=`）。
  `reg.exe`/`sc.exe` 前先 `export MSYS_NO_PATHCONV=1`；`docker exec` 要加，`docker cp` 宿主路径**不能**加。
- **`git commit -m` 里的反引号会被 bash 吃掉** ⇒ 含代码标识的提交信息用 **`-F <消息文件>`**。
  消息文件路径也会被 MSYS 改写 ⇒ 放仓库内（`.tmp_probe/`）用相对路径；`-F` 必须在 `-o -- <paths>` **之前**。
- curl 用 `/c/Windows/System32/curl.exe --noproxy '*'`（Clash 拦 localhost）。

## 验证纪律

- 只认 `failed = 0` 且 `errors = 0`；passed 数字不是验收线（会漂）。
- 声称"测试守住某行为"须做**改坏证明会红 + 还原证明回绿**，两项写进报告。
- 声称完成前必读 `docs/SOP_Agent交付自查清单.md`。报告里的"收益数字"先实测再采信；
  离线探针参数必须与生产调用点逐项一致，否则是假阳性。
- ⚠️ 全量 `pytest tests/ -q` 拿不到汇总行 ⇒ 必须 `pytest tests/ -q --basetemp=/tmp/pb_$RANDOM`。
  `docker exec` 传 `/tmp` 路径必须 `export MSYS_NO_PATHCONV=1`。
- ⚠️ **`backend/app` 未挂载进容器** ⇒ 改宿主代码后容器内 pytest 仍是旧代码；迭代期用 `docker cp`，
  收尾必须 `docker compose build backend && up -d backend`，否则镜像与源码不一致。
- ⚠️ **403 ≠ 路由存在**：`main.py:386` 全局 CSRF 中间件跑在路由匹配**之前**，不带 `X-CSRF-Token`
  时连不存在的端点也返 403。真探测路由必须带 token（判据：404 才证明不存在）。
- ⚠️ **5xx 的可操作消息会被抹掉**：`main.py:575-583` 把 ≥500 的 `HTTPException.detail` 换成
  `"Internal server error"` ⇒ 5xx 要带提示**必须抛 `ServiceError`**（`core/exceptions.py`）。
- 找重复代码按**行为模式**扫，别只按函数名。清理产物：已入库=可归档；**未入库=在途工作，别碰**。
- **合并窗口纪律**：合并前 `git status --porcelain`；只用 `git commit -o -- <pathspec>` 提交自己的文件。
- 动过 `docs/` 就重跑 `py scripts/docs/gen_docs_catalog.py`；其退出码不能用管道测（拿到 tail 的 0），判 `OK`/`STALE` 文本。

## 前端部署路径（2026-10-13 实测）

- `dist` 是 nginx bind mount ⇒ `docker compose build frontend` 对站点内容**完全无效**，也**永不直接动**。
- ⚠️ `npm run build` 先跑 `clean-dist.cjs`，会被安全删除守卫拦下 ⇒ **dist 被删一半** ⇒ chunk 404。
- ⇒ 正确姿势：`VITE_OUT_DIR=dist_new node scripts/build-vite.mjs` → `cp -r dist_new/. dist/`（只增不删）
  → `node scripts/gzip-dist.cjs` → 把 `dist_new` **mv** 进 `frontend/_QUARANTINE_*/`（`rm -rf` 会被守卫拦）。

## 真机（浏览器）验证

- 工具 `playwright-cli`（0.1.17）。会话可跨 bash 持久（`-s=<名>`）。`run-code` 用 `--filename=./x.js`
  传箭头函数源码（`async page => {...}`），**别拼引号**。上下文无 `setTimeout`。
- 认证：`POST /api/token`（FormData `username=admin&password=admin123`）→ 双 Set-Cookie
  （`palink_session` HttpOnly + `palink_csrf`）。mutating 请求带 `X-CSRF-Token`。
  判登录成功 = `GET /api/users/me` 返回 `admin`。**前端已不读 `localStorage.palink_token`（禁字守卫测试）**。
- 前端端口 **16000**。生产包 console 被 terser `drop_console` 剥光 ⇒ 取证靠 **DOM / 运行时对象**信号。
- ⚠️ `page.frames()[0]` 是主页面本身；摸 srcdoc 卡帧必须 `for (const f of page.frames())`。
- ⚠️ `__palinkCompatStats` 是 `recordStubHit` 里惰性创建 ⇒ 读 `undefined` 只说明没触发过降级桩。
  `page.goto` 会重置模块级 stats ⇒ 触发与查看须同一 SPA 会话。
- ⚠️ **卡片宿主高度不是可靠验收判据**：宿主高 = 故事 iframe 实测高 + 操作栏，故事高取决于外链图片
  （`i.postimg.cc`）加载 ⇒ 同一构建多次运行即 2284/4160 抖动。改用键集合双向 diff + 数据到达计数 + 截图。

## ST 兼容层（勿按名字删）

- 「ST 双轨已删」≠「ST 兼容层可删」。Palink 原生卡片渲染底座本身就是 ST 兼容运行时，**在用生产代码**。
  禁止整文件删 `SillyTavernCompatRuntime.ts`、`legacy-st-sim.ts`、`api/silly_tavern.py`。
- 命名陷阱：`synthesize_tts_st_compat`（在用 TTS 端点）、`'st-compat-v2'`（runtime 版本标签）、
  `st-vec::`（记忆向量前缀）、`get_st_current_user`（共享认证依赖）、`lib/group-chat/`（经 `getContext.ts` 活着）。
- T1 红线：`core/migrations.py` 的 `_RUNTIME_COMPAT_COLUMNS` **禁止回填** `silly_tavern_mode`/`silly_tavern_theme`。
- **ST 扩展 UI 可见性**：口径 c（卡内不可见、只留命令/API 能力），用户 2026-10-15 拍板；(a) 桥回主页面已排除。

## 智能卡关键接缝

- ⚠️ **未信任卡 iframe 是 opaque origin**（sandbox 只给 `allow-scripts`）⇒ 父页面 `contentDocument === null`。
  要读写卡 iframe DOM 的逻辑**必须写在帧内**（`runtime-body/part-*.ts`），父侧对未信任卡全盲。
- **卡片样式会被帧内插件掏空**（插件 ~3~5s 后做 head 节点级替换，`<style>` 全消失；父侧四组拦截 0 命中）。
  由帧内 `STYLE-GUARD-INFRAME`（`part-08.ts`）守护；观测面 `__palinkStyleGuardSnapshot`/`Restored`。
- ⚠️ **`runtime-body/part-*.ts` 是模板字符串**：禁止裸反引号、`${}` 插值、字符串/注释里的裸 `\n`（写 `\\n`）。
  唯一守卫 `generated-script-parse-guard.test.ts`（只剥首个 `<script>` 和末个 `</script>`，双标签产物会误报）。
  `legacy-st-sim-parts/part-*.ts` 注释会串进产物 ⇒ 别写被删模块标识符字面量。
- **存储键双兼容**：旧 `palink:card-storage:v1:<cid>:<local|session>:<rawKey>`；新
  `palink:smart-card-storage:v1:<type>:<cid>:<sid>:<fp>`。读新→回读旧→抄进新，**只加不删**。
  旧键字面量必须**写死在 `storage.ts`**（隔离契约测试对源码文本 `toContain`）。无 cid 时落 `__anonymous__` 桶。
- **kill switch**：`palink_card_tavern_helper_scripts='0'` 有效；`palink_idb_namespace='0'` 已修（`4cb5d29`）。
- **世界书权威源**：`GET /api/worldbooks?character_id=<cid>&type=character_book` → `names[0]=primary`。
  ⚠️ 后端把 ST 的 `comment` 存成 `title`（`worldbook.py:597`），**必须映射回 `comment`**，否则 MVU 匹配不到 `[initvar]`。
- ⚠️ **帧内两套 `requestParent`**：legacy（`legacy-st-sim.ts:489`）数组原样；v2（`SillyTavernCompatRuntime.ts:4659`）
  `{ok:true, ...data.result}` ⇒ **数组和字符串都会被展开**（`part-06.ts:149` 曾因此让 `triggerSlash` 恒返 `''`）。
  测试桩必须照抄真机形状。
- **iframe 配额（T2）**：单位是**门**（`[data-palink-card-gate-id]`），别数 `iframe`。LRU 逐出须内核统一执行 + 通知受害者；
  wake 须 `register + markVisible(true)`。默认 cap=16，**无 setCap**。观测面 `window.__palinkIframeLru` +
  `data-palink-card-evicted`/`-dormancy`。
- **纪律**：策略内核单测全绿 ≠ 接线生效。埋在巨型组件里就**先抽出来**再写 jsdom 集成测试，**反证要做**。

## 卡片渲染：iframe vs ST 直渲染（2026-10-18，`94107db`）

- **ST 1.18.0 核心根本不执行卡内脚本**（`tavern_helper`/`runScript` 全仓 0 命中；`<script>` 被 DOMPurify 剥掉）
  ⇒ Palink 在 iframe 跑卡脚本是**超集能力**，隔离是代价。消息渲染 ST 是裸 `innerHTML` 进 `.mes_text`，**无 iframe**。
- ST **做了** CSS 作用域（`script.js:1907-1909` + `chats.js:536/551/556-595`）：选择器强制 `.mes_text ` 前缀、
  类名加 `custom-` 前缀 ⇒ `body{}` 变 `.mes_text body{}` 不生效。⚠️ `inline/inline-sanitize.ts` 决策 C4
  「不 scope，与 ST 一致」**前提已证伪**——走直渲染必须先补这三件套。
- ST 的 CSP 被显式关闭（`server-main.js:104-105`），防御全靠客户端 DOMPurify 单点；Palink 用 opaque origin
  是**不把 DOMPurify 当可信边界**。⛔ 完全直渲染 = 必须放弃执行卡内脚本，硬性取舍。
- 架构备选：C 档（瘦身，已做）/ D 档（信任分级 `allow-same-origin`）/ A 档（静态卡直渲染）/ B 档（脚本沙箱单例化）。

## srcdoc 瘦身（包A 完工 2026-10-18 `3bc9cb7`）

- 单帧 srcdoc **893,604 → 46,167**，7 帧 6.26MB → 326KB。两块外部资产：
  `assets/palink-smart-card-runtime-<hash>.js`（compat v2）与 `assets/palink-smart-card-legacy-<hash>.js`。
  两个 virtual module：`virtual:palink-smart-card-{runtime,legacy}-url`。
- 那 495KB legacyShim 里**只有 ~135KB 是代码**，其余 ~356KB 是 `ctx.characterExtensions` 的**第二份副本**
  ⇒ 同一份 extensions 在单帧内被内联两次（711,784 = 79.6%）。只做外部化最多省 15%。
- **`frame-shim/legacy-shim-source.ts` 必须保持零 `@/` 依赖**：它被 `vite-plugins/smart-card-runtime-asset.ts`
  在「加载 vite/vitest 配置」时 import，那时 `@` 别名还没生效 ⇒ 引入 `@/…` 会让整个 vitest 在配置加载阶段崩。
- **P0 红线**：`CharacterCardRenderer.handleFrameLoad` 首行必须 `lastPostedContextSignatureRef.current = ''`。
  `postNow` 按 signature 去重，新文档的 message 监听器是全新实例 ⇒ 不重置则 srcdoc 重建 / LRU 唤醒后
  唯一补投被静默丢弃（boot 里已不含 extensions/chatMessages，没有任何兜底）。
- **`ctx.characterExtensions` 不在 boot 里**（两份都不在）。靠 context-update +
  `refreshDerivedContextStoresCompat`（part-05:884）补齐。帧内 5 个读取点：
  part-b:215（getContext 内，惰性）｜part-03:436 / part-04:119（启动期同步，靠 refresh 自愈）｜part-05:885/888（refresh 本身）。
- **外部化后不能用「整份产物 SHA256 一致」当等价判据**（必然多两个 script 标签）。用
  `node scripts/verify-shim-identity.mjs legacy-identity <helpers.ts>`：body 逐字节一致 + 引导 ctx/frameId 同值。

## ST 兼容度实测基线（2026-10-18 包B 完工 `3012820`，已覆盖 10-18 早前的旧数字）

- 权威目标面（`_reference/sillytavern-1.18.0`）：getContext **145 键**、`parent.SillyTavern` 2 字段、libs ~17、
  slash 命令 **289**（核心 222 + 扩展 67）+ 175 别名、内置扩展 15 目录、挂载点 9。
- 包B 后真机（iframe 单间轨）：getContext **145/145 存在、缺 0、非真可用 14**；TavernHelper 76；Mvu 6；
  **ST 289 命令注册覆盖 87**（宿主引擎 66 + 卡内插件 21），未达 180/222 —— 缺口逐类归因见包B 报告 §7。
- 包B 前的旧结论（**已被推翻，勿再引用**）：「`SlashCommandParser.commands` = 0」——实际是 `Map` 且已有 7 条，
  旧探针用 `Object.keys` 读 Map 恒为 0；「Palink 已有 92 条命令」——`initSlashCommands()` 全仓 **0 调用点**、
  `mod.ts` **0 importer**，运行时是空的（精确扫 register 块 = 75 唯一名 + 23 别名）。
- ⚠️ `getcontext-parity.test.ts` 的 145/145 是 **jsdom 口径**，不是线上数字。
- ⚠️ 桩判定不能用花括号空体判（`async (...) => ( expr )` 圆括号箭头会误判）。判据：源码含 `reportStubApi(` / 空 class / 空体。
- **命令要写在宿主 `lib/slash-engine/`（三条轨共享）**，别写帧内（只有单间轨受益）。
  ⚠️ `chatCompletionSettings` 不能给空对象——`part-08.ts:536` MVU 会写 `runtimes.is_function_call_enabled`。
- `getRequestHeaders` 维持 `{}`：给真实头 = 把 `palink_session`/`palink_csrf` 送进 opaque origin 帧，与 P1-1 沙箱红线冲突。

## 后端 ST Extras（2026-10-18 包C 完工 `910cce6`/`decb453`）

- **唯一实现文件 = `backend/app/api/st_extras.py`（13 端点）**。勿在 `silly_tavern.py` 重注册同名路由
  （重复注册 ⇒ 先注册者静默胜出，本仓 2026-09-05 踩过）。覆盖 classify×3、caption、summarize、translate×3、
  `kobold/embed`、sprites×4。原 `silly_tavern.py` 4 条死转发路由已删。
- **仍在用 `_forward_extensions_to_st_native` 的只剩 `/api/speech/elevenlabs/*` 七端点**
  （`silly_tavern.py:6318`，Palink 不持有 ElevenLabs key ⇒ 恒 502 是设计使然，不是 bug）。
- ⚠️ **`silly_tavern._public_models()` 不含 `supports_vision`** ⇒ 判视觉必须用
  `services.unified_model_registry.get_flat_model_list()`（与 `/api/models` 同源）。拿它判视觉恒 False ⇒ caption 永久 503。
  这个 bug 单测没抓到，因为**测试桩比生产数据字段更全**——夹具"更完整"会掩盖真缺陷。
- **容器出网部分阻断**（实测）：`api.deepseek.com`/`new-api:3000`/`ollama:11434` 可达；
  `translate.googleapis.com` 不可达、`lingva.ml` 403、libre 公共实例超时 ⇒ translate 走
  「原生优先 + LLM 兜底 + WARNING 留痕」，配 `PALINK_LIBRE_TRANSLATE_URL` 即生效。
- **ST 插件调用契约**（勿凭记忆改，看 `st-plugins/*/index.js`）：translate 用 `response.text()` 取纯文本；
  classify 读 `data.classification[0].label`；embed 校验 `embeddings.length === items.length` + 每条非空 +
  `model` 非空（`vectors/index.js:1471-1478`）；sprite `path` 被直接当 `imageSrc`（`expressions/index.js:1216`）
  ⇒ 必须浏览器可加载 URL；sprite 目录名 = **avatar 去扩展名**（`palink-<cid>`）或角色显示名，两种都要认。
- **存量孤立 pydantic 模型（0 处使用，待立 P2）**：`silly_tavern.py:2091 STTextCompletionRequest`、
  `:5013 STOpenAIVoiceRequest`、`:5114 STSummarizeRequest`、`:5122 STImagesListRequest`、
  `:5147 STGenerateImageRequest`。5107-5120 四段「P1-9/10/11/12」全是纯注释占位，旧注释称"与 classify 同构"是假陈述。

## S5 完工（2026-10-15 `e86ad9a`，删码 `f5c1a86`，tag `s5-done`）

- `frontend/src/utils/sillyTavernPluginRuntime.ts` 已整文件删除（2447 行）+ 总闸
  `palink_st_plugin_main_page_injection` 一并删除 ⇒ grep 命中该名只可能是注释/文档。
- 存活轨：沙箱轨（`sandbox.ts`）+ getContext 轨（`getContext.ts`）+ 单间轨 iframe（`smart-card-runtime/`）。
- ⚠️ `card-script-runner.ts` **不能整文件删**：`CharacterCardRenderer.tsx:14-16` 还在 import `buildCardScriptFrameBootstrap`。
- **G-dep2 是死表达式**：`window.__palinkStRuntime` 恒 `{}`。父侧等价通道 = `context.variables`。
- 5 个测试插件保留（复测靶子：2e1fa886b439/43ef24b1a3ba/01db1f12ddd0/4d61e879d0c5/ca0611884034）。

## 其他踩实坑

- worktree 生成的 `docs/_CATALOG.md` 不能直接带回主干 ⇒ 并入后重跑再 `--check`。
- `_BACKUPS/**` 被 gitignore，但 `_INDEX.md` 与 `BACKUP_INFO.md` 要入库 ⇒ `git add -f`。
