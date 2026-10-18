# 包 C 完工报告 · ST Extras 后端端点补齐

> 施工日期：2026-10-18
> 分支 `three-tracks-merge-20261012`，开工 HEAD `07b7a62`（提示词写的 `94107db` 是其父提交）
> 对应提示词：`docs/_active/HANDOFF_提示词_包C_后端Extras端点_2026-10-18.md`
> 范围：**仅后端**。全程未改任何 `frontend/` 文件（见 §10 并发说明）。

---

## 0. 先说结论

| 项 | 结果 |
|---|---|
| 新增/迁移端点 | **13 条**（classify×3、caption、summarize、translate×3、embed、sprites×4） |
| 真机状态码 | 提示词清单里 **9 条从 404 → 200**；`/api/sd/*` 本来就有（见 §2） |
| 端到端跑通 | **6 条**（classify / translate / summarize / caption / embed / sprites 全闭环） |
| 后端全量 pytest | **`2117 passed, 16 skipped, 0 failed, 0 errors`**（原样输出见 §5） |
| 改坏证明 | 守卫级 ✅ 会红；接线级 ✅ 端点回 404 |
| 是否执行 rebuild | **是**，共 4 次（`docker compose build backend` + `up -d backend`），开工前已获主控授权 |
| 提示词的事实错误 | **6 处**，见 §1 —— 其中 2 处会直接导致验收造假 |

---

## 1. 提示词现状表已过时（开工前实测复核）

提示词 §1.1 的状态表是 2026-09-05 的口径。逐条复跑后**有 6 处不成立**：

| # | 提示词声称 | 实测 | 证据 |
|---|---|---|---|
| 1 | HEAD `94107db` | 实际 `07b7a62`（多一个 docs 提交） | `git log -1` |
| 2 | `/api/sd/*` 缺失，C-3 整节要做 | **已完整实现**：523 行 / 18 条路由 / SD WebUI + ComfyUI 双 provider；真机 `GET /api/sd/status` → `{"available":false,"type":"sd_webui","base_url":""}` | `backend/app/api/sd.py:30,127,175,224`；`services/image_generation_service.py:539,566` |
| 3 | `/api/summarize`、`/api/translate`、`/api/translate/{provider}`、`/api/extra/translate` = 404「未实现」 | **源码里早已存在**（`69a472b`，2026-10-15 补的）；容器里 404 是**镜像落后**，不是缺代码。且它们的实现是转发到已删的 ST sidecar ⇒ 就算 rebuild 也只会变 **502**，插件照样不可用 | `silly_tavern.py`（改前 5158-5227 段）；旧镜像 `2026-10-11T05:19` |
| 4 | `/api/sprites/*` 只需 `get` + `delete` | 插件实际用 **4 个**：`upload`(:901)、`upload-zip`(:2032)、`get`(:1295)、`delete`(:2072)。只做 get/delete ⇒ 表情永远存不进去，get 恒空 | `st-plugins/expressions/index.js` |
| 5 | `classify` + `/labels` | 实际是 **3 条**：`/api/extra/classify`(POST)、`/api/extra/classify/labels`(POST)、`/api/classify/labels`(GET，Extras 服务形态) | `st-plugins/expressions/index.js:1062,1445,1429` |
| 6 | `power_user` 别名要改 `runtime-body/part-08.ts` | `powerUserSettings` 实际在 **`frontend/src/lib/sillytavern/getContext.ts:3225`**，不是 part-08 | 源码 |

### ⚠️ 两处会直接导致验收造假

**(a) 403 不能证明路由存在。** 提示词 §4 写「401/403 说明路由在、只是认证没带，也算路由存在」。
但本项目 `backend/app/main.py:386` 有一个**全局 CSRF 中间件，跑在路由匹配之前**。
开工第一轮不带 token 探测时，连**根本不存在**的 `/api/openai/generate-image`、
`/api/backends/kobold/embed` 也全部返回 **403**：

```
POST /api/openai/generate-image   rc=403   ← 路由不存在
POST /api/backends/kobold/embed   rc=403   ← 路由不存在
```

带上 `X-CSRF-Token` 后同一批请求才给出真 404。**按提示词口径验收 = 假阳性全覆盖。**

**(b) rebuild 后 summarize/translate 会变 502，仍然不能用。** 这四条的实现是
`_forward_extensions_to_st_native`（`silly_tavern.py:6318`），转发目标
`ST_NATIVE_SERVICE_URL` 在容器里实测是**空串**（`docker compose exec backend` 读到 `[]`），
而 sidecar 容器已随 st-native 双轨删除（2026-09-03）。所以「补路由」不是真问题，
**「路由指向一个已删的服务」才是**。本次一并换掉（§3）。

---

## 2. 环境边界实测（决定哪些端点根本不可能跑通）

容器出网是**部分阻断**的，不是全通也不是全断：

| 目标 | 结果 |
|---|---|
| `api.deepseek.com` | ✅ 通（401） |
| `new-api:3000` / `ollama:11434` | ✅ 通 |
| `translate.googleapis.com` | ❌ `Network is unreachable`（Google 段被墙） |
| `lingva.ml` | ❌ 403 |
| LibreTranslate 公共实例 | ❌ 超时 |
| `www.bing.com` | ✅ 302 |

可用能力实测全绿：
- LLM 生成：`POST /api/backends/chat-completions/generate` + `deepseek-flash` → 200 `"OK"`
- **视觉**：同端点传 `image_url` → 200（prompt_tokens 226 证明图真进去了）
- 嵌入：`embed_text(['hello','world'])` → `(2, 1024) float32`，`OllamaEmbedder / bge-m3`

⇒ **原生翻译上游在本机基本不可用**，所以 translate 采用「原生优先 + LLM 兜底 + 留痕」
（提示词 §C-1 已授权「其余回退到默认 provider 并留痕」，此处把兜底面扩到全部 8 个 provider）。

---

## 3. 改动清单（文件:行号）

### 3.1 新增 `backend/app/api/st_extras.py`（923 行）

| 端点 | 行号 | 实现 |
|---|---|---|
| `POST /api/extra/classify` | `:248` | LLM 分类（提示词内嵌 15 个标签）→ 关键词兜底 |
| `POST /api/extra/classify/labels` | `:269` | 返回 15 个默认表情名 |
| `GET /api/classify/labels` | `:277` | 同上（Extras 服务形态） |
| `POST /api/extra/caption` | `:316` | 视觉模型描述；无视觉模型 → 503（不造假） |
| `POST /api/summarize` | `:383` | LLM 摘要，支持 `params.prompt` 覆盖 |
| `POST /api/extra/translate` | `:535` | 原生优先 + LLM 兜底 |
| `POST /api/translate` | `:546` | 同上 |
| `POST /api/translate/{provider}` | `:557` | 8 provider 白名单 + 路径穿越阻断 |
| `POST /api/backends/kobold/embed` | `:589` | `embed_text` 批量，严格按插件校验 |
| `GET /api/sprites/get` | `:694` | 枚举 expressions/ + sprites/ 目录 |
| `POST /api/sprites/upload` | `:787` | 落盘 + 主图同步 DB |
| `POST /api/sprites/upload-zip` | `:830` | zip 解包（basename 压平，防 zip-slip） |
| `POST /api/sprites/delete` | `:879` | 删文件 + 主图清 DB |

关键内部函数：`_resolve_extras_model`(`:88`)、`_complete_once`(`:146`)、`_translate_text`(`:496`)。

### 3.2 修改 `backend/app/api/silly_tavern.py`

删除改前的 5158-5227 整段（4 条死转发路由 + `_ST_TRANSLATE_PROVIDERS`），
原位留迁移说明（`:5158`）。**保留** `_forward_extensions_to_st_native`（`:6318`），
因为 `/api/speech/elevenlabs/*` 七个端点仍在用它。

### 3.3 修改 `backend/app/api/__init__.py`

`:41` import、`:63` `include_router(..., dependencies=[Depends(csrf_guard)])`。
与同族 ST 兼容路由同一安全边界。

### 3.4 测试

| 文件 | 说明 |
|---|---|
| `backend/tests/test_st_extras_endpoints.py`（新增） | 49 项，覆盖 13 条端点的形状/安全/防伪 |
| `backend/tests/test_st_extras_proxy.py`（重写） | 原文件锁的是 summarize/translate 的 sidecar 透传契约，该契约已被本包**主动废弃**。改为锁定仍在用转发器的 elevenlabs 七端点，并新增「迁移的四条不得在 silly_tavern 残留」守卫（防重复注册） |

---

## 4. 改动前后 HTTP 状态码对比（真机 curl，端口 16000，带 `X-CSRF-Token`）

| 端点 | 改前 | 改后 | 备注 |
|---|---|---|---|
| `POST /api/summarize` | **404** | **200** | 从死转发改为 LLM 摘要 |
| `POST /api/translate` | **404** | **200** | |
| `POST /api/translate/{provider}` ×8 | **404** | **200**（8/8） | onering/libre/google/lingva/deepl/deeplx/bing/yandex |
| `POST /api/extra/translate` | **404** | **200** | |
| `POST /api/extra/classify` | **404** | **200** | |
| `POST /api/extra/classify/labels` | **404** | **200** | |
| `GET /api/classify/labels` | **404** | **200** | |
| `POST /api/extra/caption` | **404** | **200** | 有视觉模型时；无则 503 |
| `POST /api/backends/kobold/embed` | **404** | **200** | |
| `GET /api/sprites/get` | **404** | **200** / 404 | 404=角色不存在（正确语义） |
| `POST /api/sprites/upload` | **404** | **200** | |
| `POST /api/sprites/upload-zip` | **404** | **200** | |
| `POST /api/sprites/delete` | **404** | **200** | |
| `GET /api/sd/status` | 200 | 200 | 本来就有（提示词误标缺失） |
| `POST /api/backends/text-completions/generate` | 404 | **404** | 未做，见 §6 |
| `POST /api/openai/generate-image` | 404 | **404** | 未做，见 §6 |
| `POST /api/openai/generate-voice` | 404 | **404** | 未做，见 §6 |
| `POST /api/labels` | 404 | **404** | ST 不调这个路径，见 §6 |

---

## 5. 真实请求/响应样例（脱敏，真机）

### 5.1 `POST /api/backends/kobold/embed`（真实 ollama bge-m3）

```bash
curl --noproxy '*' -b ck.txt -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -X POST -d '{"items":["hello world","你好世界"]}' \
  http://localhost:16000/api/backends/kobold/embed
```

```json
{
  "model": "bge-m3",
  "embeddings": [
    [-0.0402, 0.0369, -0.0291, 0.0162, -0.0358, -0.0408, ... 共 1024 维],
    [...]
  ]
}
```
`count = 2`、`dim = 1024`，满足插件严格校验（`st-plugins/vectors/index.js:1471-1478`：
`embeddings.length === items.length`、每条非空、`model` 非空）。

### 5.2 `POST /api/extra/caption`（真实视觉模型）

请求：1×1 PNG 的裸 base64。响应：

```json
{"caption":"图片整体为单一的浅粉红色纯色背景，画面中没有任何具体的主体、物体或人物，也没有发生任何动作。场景呈现出一种无空间感的平面状态，缺乏具体的环境元素。风格上属于极简主义，色彩均匀平铺，没有纹理、阴影、渐变或任何视觉焦点。"}
```

### 5.3 `POST /api/translate/google`（原生被墙 → LLM 兜底，有日志留痕）

```
请求  {"text":"Hello, how are you today?","lang":"zh-CN"}
响应  你好，你今天怎么样？            (text/plain, rc=200)

日志  [WARNING] app.api.st_extras: st_extras: translate provider=google
      原生上游不可用（ConnectTimeout: ），回落 LLM 翻译
```

### 5.4 `POST /api/extra/classify`

```
请求  {"text":"I am absolutely furious right now"}
响应  {"classification":[{"label":"rage","score":1.0}]}
```

### 5.5 `POST /api/summarize`

```
请求  {"text":"用户问天气。助手说今天晴，25度。用户说谢谢。助手说不客气。","params":{}}
响应  {"summary":"用户询问天气，助手答今日晴、25度；用户致谢，助手回应不客气。"}
```

### 5.6 已知行为（非 bug，防假数据的一个真实案例）

同一请求偶发 502 后重试成功：

```
POST /api/summarize  {"text":"smoke test", ...}   → 502  {"detail":"模型返回了空摘要","code":"EMPTY_SUMMARY"}
POST /api/summarize  {"text":"smoke test", ...}   → 200  {"summary":"提供的原文仅为"smoke test"一词，不含任何人物、事件或对话内容，无法生成摘要。"}
```

**根因**：`_complete_once` 拿到的 `content` 为空 ⇒ 抛 `ServiceError("模型返回了空摘要", code="EMPTY_SUMMARY")`
（`st_extras.py:402`）。这是**刻意设计**：如果改成返回 `{"summary": ""}`，memory 插件会把空串当真摘要存库，
比报错更糟。温度 0.3 下模型对极短输入偶发空回复，属上游行为，重试即有结果。

日志佐证（`docker compose logs backend`）：`POST /api/summarize` 在生产日志里 **1 次 502 / 3 次 200**，
且**没有** `模型调用失败` 的 WARNING ⇒ 上游通、是模型回了空。

### 5.7 sprites 完整闭环（真机）

```
POST /api/sprites/upload        → 200 {"label":"joy","spriteName":"joy",
                                       "path":"/api/characters/c44f2ae6-.../expressions/joy/image"}
GET  /api/sprites/get?name=…    → 200 [{"label":"joy","path":"/api/characters/c44f2ae6-.../expressions/joy/image"}]
GET  …/expressions/joy/image    → 200  bytes=70          ← 插件直接当 imageSrc 用
GET  /api/characters/{cid}/expressions → custom=["joy"]  ← DB 同步生效，原生端点也看得到
POST /api/sprites/delete        → 200 {"deleted":true,...}
GET  /api/characters/{cid}/expressions → custom=[]       ← DB 同步清理
GET  /api/sprites/get?name=…    → 200 []
```

zip 上传与 zip-slip 防护（真机）：

```
POST /api/sprites/upload-zip（包内含 joy.png / sadness.png / ../../escape.png / readme.txt）
→ 200 {"count":3}                       ← txt 被跳过
→ 目录内实际为 escape.png / joy.png / sadness.png（../../ 已被 basename 压平）
→ find backend/data -maxdepth 1 -name escape.png  无结果（未逃逸）
```

---

## 6. 后端 pytest 原样输出

### 6.1 本包两个测试文件

```
$ docker compose exec -T backend python -m pytest \
    tests/test_st_extras_endpoints.py tests/test_st_extras_proxy.py -q \
    --basetemp=/tmp/pb_c8
67 passed, 81 warnings in 24.87s
```

### 6.2 全量（最终镜像，`--basetemp` 必须带，否则拿不到汇总行）

```
$ docker compose exec -T backend python -m pytest tests/ -q --basetemp=/tmp/pb_full_final
2117 passed, 16 skipped, 375 warnings in 290.00s (0:04:50)
```

**`failed = 0` 且 `errors = 0`。** 基线（2026-10-17 复验）为 `2060 passed / 23 skipped`，
本次 `+57 passed / -7 skipped`（新增 49 + 重写 18，净增 57；skip 数变化来自既有用例的运行条件）。

> 该全量在**最终镜像**上跑了两轮（`_resolve_extras_model` 从 `_public_models()` 改到
> `get_flat_model_list()` 的前后各一轮），两轮计数完全一致：`2117 passed / 16 skipped`。
> 前一轮耗时 387.68s、后一轮 290.00s（机器负载差异，与用例数无关）。

> ⚠️ 两个环境坑，都踩过：
> 1. `docker exec` 传 `--basetemp=/tmp/...` **必须** `export MSYS_NO_PATHCONV=1`，
>    否则路径被 MSYS 改写成 `/app/C:/Users/...`，`tmp_path` 类用例全部 `FileNotFoundError`。
> 2. `backend/app` **未挂载进容器**，改宿主代码后容器里跑测试仍是旧代码。迭代期用
>    `docker cp`（宿主路径**不能**加 `MSYS_NO_PATHCONV`）同步，收尾必须 rebuild。

---

## 7. 改坏证明（两项）

### 7.1 守卫级：视觉门禁（防伪造 caption）

**改坏**：把 `st_extras.py:131` 的
`if require_vision and not entry.get("supports_vision"):` 改成 `if False and ...`

```
$ pytest tests/test_st_extras_endpoints.py -q
FAILED tests/test_st_extras_endpoints.py::TestCaption::test_non_vision_model_rejected_without_fake_caption
1 failed, 48 passed
```

**还原**（`grep -c "if False and require_vision"` → `0`）：

```
$ pytest tests/test_st_extras_endpoints.py -q
49 passed
```

### 7.2 接线级：路由注册（提示词 §4 要求的口径）

**改坏**：注释掉 `backend/app/api/__init__.py:63` 的
`api_router.include_router(st_extras_router, ...)`，`docker cp` + 重启后端，真机 curl：

```
/api/extra/classify        rc=404
/api/extra/caption         rc=404
/api/summarize             rc=404
/api/backends/kobold/embed rc=404
```

**还原**（`grep -c "BREAK-PROOF"` → `0`）+ 重启：

```
/api/extra/classify        rc=200
/api/extra/caption         rc=400   ← 路由在；400 是因为测试体 "x" 不是合法 base64
/api/summarize             rc=200
/api/backends/kobold/embed rc=200
```

---

## 8. 没做的项 + 原因

| 未做 | 原因 |
|---|---|
| `/api/backends/text-completions/generate` | 提示词 C-1/C-2/C-3 均未列入。`STTextCompletionRequest` 模型在 `silly_tavern.py:2091` 存在但无路由（同「孤立模型」病灶），底层 `complete_text_completion` 已具备，**补起来约 30 行**，建议立 P2 |
| `/api/openai/generate-image`、`/api/openai/generate-voice` | 提示词仅在 §1.1 表格提及，未列入 C 任务。生图走 Palink 自有 `/api/images/generate`（`services/image_generation_service.py`），语音走 `/api/tts`。补这两个是「双份能力」而非「补缺口」，需主控决定 |
| `/api/sd/*` 的其余 28 个 provider | 提示词 §3 明确「只做实际接入的」。现状 SD WebUI + ComfyUI 双 provider 已在 `sd.py` 完整实现，**C-3 无需施工** |
| `/api/labels` | ST 1.18.0 插件不调这个路径（实际是 `/api/extra/classify/labels` 与 `/api/classify/labels`，两条都已补）。补一条没人调的路径等于造死端点 |
| `/api/horde/caption-image` | `st-plugins/caption/index.js:294` 是 Horde 兜底分支。需要 AI Horde 账号，且该分支在 `/api/extra/caption` 成功时不会走到 |
| translate 的原生实现（deepl/deeplx/bing/yandex/lingva/onering） | 各需服务实例或付费密钥，仓库无对应配置。当前走 LLM 兜底 + WARNING 留痕。`libre` 的原生实现已写（`st_extras.py:463`），只需配 `PALINK_LIBRE_TRANSLATE_URL` 即生效 |
| **C-4 `power_user` 前端别名** | 主控拍板「不做，交包 B」。原因：会与包 B 撞 `runtime-body/part-08.ts`。**另注：`powerUserSettings` 实际在 `frontend/src/lib/sillytavern/getContext.ts:3225`，不是 part-08.ts**，包 B 改的时候按这个位置找 |
| `/api/images/list`（gallery） | `STImagesListRequest`（`silly_tavern.py:5122`）是另一个孤立模型，gallery 插件的端点。不在本包范围，建议立 P2 |

### 顺带查出的存量问题（未动，仅登记）

`silly_tavern.py` 有 **5 个孤立 pydantic 模型、0 处使用**：

| 模型 | 行号 |
|---|---|
| `STTextCompletionRequest` | `:2091` |
| `STOpenAIVoiceRequest` | `:5013` |
| `STSummarizeRequest` | `:5114` |
| `STImagesListRequest` | `:5122` |
| `STGenerateImageRequest` | `:5147` |

这正是当初 summarize/translate 长期 404 的同一个病灶：**只写了模型和占位注释，从未注册路由**。
其中 `silly_tavern.py:5107-5120` 的「P1-9 classify / P1-12 caption / P1-11 summarize / P1-10 gallery」
四段**全是纯注释占位**，没有任何实现——而旧代码注释里却写着「与同批 P1-9 classify /
P1-12 caption 完全同构」，是**引用不存在实现的假陈述**，本次已在新模块里补上真实实现。

---

## 9. 是否执行了 rebuild

**是。** 开工前已就「rebuild 会重启 backend 容器」取得主控授权。全程共执行 4 次
`docker compose build backend` + `docker compose up -d backend`。

最终状态：镜像与宿主源码一致（收尾那次 rebuild 之后未再改任何 `backend/app` 代码），
容器 `healthy`，`/api/sd/status` 等既有端点无回归。

---

## 10. 并发说明（重要）

开工时 `git status --porcelain` 只有 1 个变更（提示词文件本身的换行符）。
施工过程中**包 A / 包 B 并发修改前端并各自提交**：

| 提交 | 内容 |
|---|---|
| `3bc9cb7` | 包 A —— srcdoc 单帧 893KB → 46KB |
| `3012820` | 包 B —— 命令引擎启动 + 帧内桥接 + getContext 补 9 键 |
| `2ea39c7` / `762dd18` | 两份报告入库 + 重生成目录 |

⇒ 本包**未提交任何 `frontend/` 文件**，也未运行前端门禁：
- 我改动的 pathspec 里没有任何前端文件（`git status --porcelain -- frontend/` 为空）；
- 包 A/B 改了 `runtime-body/part-06..08.ts`、`main.tsx`、`lib/slash-engine/*` 并新增测试，
  **前端测试基线已被它们改变**（不是提示词写的「78 文件 / 1000 passed」）。此时跑 `vitest`
  测的是包 A/B 的新代码，拿它当「包 C 前端不回归」的证据是错归因。

**前端门禁由包 A/B 负责。** 本包的回归边界是后端，已由 §6.2 全量 pytest 守住
（`2117 passed / 0 failed / 0 errors`，其中包含包 A/B 未触碰的后端全部用例）。

> 补一句给主控：本包的 `docker compose build backend` 发生在包 A/B 的前端提交之后，
> 因此当前运行镜像 = 本包后端代码 + 包 A/B 前端（前端是 nginx bind mount，与后端镜像解耦）。

---

## 11. 复验入口（给下一位 agent）

```bash
# 1. 端点是否在（带 CSRF token，否则 403 是假的）
cd .tmp_probe
curl --noproxy '*' -s -c ck.txt -X POST http://localhost:16000/api/token \
  -d "username=admin&password=admin123"
CSRF=$(awk '$6=="palink_csrf"{print $7}' ck.txt)
curl --noproxy '*' -s -b ck.txt -H "X-CSRF-Token: $CSRF" \
  -H 'Content-Type: application/json' -X POST -d '{"text":"hi"}' \
  http://localhost:16000/api/extra/classify -w '\nrc=%{http_code}\n'

# 2. 测试（--basetemp 必须带，且必须关掉 MSYS 路径转换）
export MSYS_NO_PATHCONV=1
docker compose exec -T backend python -m pytest tests/test_st_extras_endpoints.py \
  -q --basetemp=/tmp/pb_$RANDOM

# 3. 改完宿主 backend 代码后：要么 docker cp 进容器（迭代），要么 rebuild（收尾）
```

**判据只认 `failed = 0` 且 `errors = 0`，passed 数字不是验收线。**
