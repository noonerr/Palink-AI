# 审计报告：MCP 服务 / 文生图 / TTS 支持度 + 浏览器直连本地服务可行性

- 日期：2026-09-25
- 方式：**静态审计 + 容器内实机验证**（真实后端进程、真实 PostgreSQL、本地虚拟上游，0 付费）
- 标注约定：**【实测】**= 本次亲自跑出的原始输出；**【代码】**= 源码事实（附文件:行号）；**【未验】**= 未实测，需注意

---

## 0. 结论速览

| 主题 | 结论 | 关键阻塞 |
|---|---|---|
| 第三方 MCP：stdio | 能用（有硬伤） | 工具 schema 全丢、错误标志失效 |
| 第三方 MCP：SSE | 能用（兜底分支） | 无超时、无重试、连接泄漏 |
| 第三方 MCP：streamable-http | **不能用** | 【实测】导入即 ImportError |
| 第三方 MCP 在角色扮演 | **不生效** | 主路径根本不注入 MCP 工具 |
| 文生图：OpenAI 兼容 | 可用 | — |
| 文生图：SD WebUI（本地） | **可用** | 参数全硬编码；生产模式被 SSRF 拦 |
| 文生图：ComfyUI（本地） | **不可用** | 只提交工作流、不取图，恒 501 |
| TTS：6 个 provider | 4 可用 / 2 有条件 / coqui 不可用 | 音频格式标注错配 |
| 浏览器直连本地服务 | **技术可行** | 取决于本地服务是否开 CORS（已闭环实测） |

---

## 1. 实机验证原始记录

### 1.1 MCP：起了一个真的 MCP server 连进去

自建 stdio MCP server（手写 JSON-RPC，提供 `add` 与 `boom` 两个工具，后者服务端明确返回 `isError: true`），通过 `mcp_service` 走完整链路：

```
配置到的 server: [('e2e-stdio', 'stdio')]
connect_server: {'status': 'connected', 'server_id': 'e2e-stdio'}
list_server_tools 返回 2 个:
   - mcp_e2e-stdi_add_0055d9d6fcf9 | name: add | inputSchema: {}
   - mcp_e2e-stdi_boom_9f04a982d993 | name: boom | inputSchema: {}
call add: {'content': '7', 'isError': False}
call boom: {'content': 'EXPECTED_FAILURE', 'isError': False}   <-- 服务端返回的是 isError=true
OpenAI 格式工具数: 2
   工具: mcp_e2e-stdi_add_0055d9d6fcf9 | parameters: {}
   工具: mcp_e2e-stdi_boom_9f04a982d993 | parameters: {}
```

**读法**：连接与调用本身是通的（`call add` 正确返回 7），但 ① 两个工具的 `inputSchema` 全是 `{}`；② 服务端说失败的那个，客户端报 `isError: False`。

### 1.2 三类出图服务商 + SSRF 行为

```
A. 三类服务商出图实测（上游指向本地模拟器）
  openai_compatible    -> OK  url=/api/uploads/generated-images/6d3544d4...png seed=None provider=p
  sd_webui             -> OK  url=/api/uploads/generated-images/7dbcc5b2...png seed=4242 provider=p
  comfyui              -> HTTP 501: ComfyUI 出图尚未实现取图（当前仅提交工作流），请改用 OpenAI 兼容或 SD WebUI

B. SSRF 校验（APP_ENV=development 默认值下）
  openai_compatible    -> 放行（未拦截内网地址）
  sd_webui             -> 放行
  comfyui              -> 放行

C. 关闭开发放行后（模拟生产）
  openai_compatible    -> 拦截: ...must not point to a private/internal network address
  sd_webui             -> 拦截: 同上
  comfyui              -> 拦截: 同上
  _is_safe_mcp_url(127.0.0.1) = False
  _is_safe_mcp_url(公网)      = True
  TTS custom_api 内网          -> 拦截: Only public http(s) TTS API URLs are allowed
```

上游侧实际收到的请求（证明参数是硬编码的）：

```
[SD-WEBUI] size=768x1024 steps=20 sampler='Euler a' cfg=7.0 neg='' prompt='a lighthouse in a storm [sd_webui]'
[COMFYUI]  workflow nodes=['3','4','5','6','7','8','9']
```

### 1.3 TTS：音频字节 vs 声明类型

```
上游返回字节数: 38444
前 12 字节: b'RIFF$\x96\x00\x00WAVE'
魔数判定: RIFF/WAV
后端 synthesize_audio 的 custom_api 分支声明给前端的是: return "audio/mpeg", audio_bytes
```

### 1.4 浏览器直连本地服务（真实浏览器同源策略）

在真实浏览器页面（origin `http://127.0.0.1:3000`）内发起 fetch：

```
{ "same_origin":        "OK 404",
  "local_mock_no_cors": "BLOCKED: Failed to fetch",
  "ollama_11434":       "OK 200" }
```

给同一服务加上 `Access-Control-Allow-Origin` 与 OPTIONS 预检之后：

```
{ "get_with_cors":   "OK 200",
  "post_preflight":  "OK 200 bytes=4592" }

服务端日志：
[OPTIONS] /v1/images/generations (预检)
[OPENAI-IMG] size=512x512 prompt='browser direct test' bytes=3421
```

---

## 2. 第三方 MCP 服务

### 2.1 传输方式【实测 + 代码】

| 传输 | 状态 | 依据 |
|---|---|---|
| stdio | 可用 | 【实测】connect/call 成功 |
| SSE | 可用（else 兜底） | 【代码】`mcp_service.py:287-292` |
| streamable-http | **不可用** | 【实测】`from mcp.client.streamable_http import streamablehttp_client` → `ImportError`；2.0.0 已改名 `streamable_http_client` |
| websocket | 不支持 | 【代码】全文件零引用 |

### 2.2 🔴 工具 schema 与错误标志静默失效（实测确证）

- 【实测】`Tool` 字段是 `input_schema`（2.x 改名），代码读 `tool.inputSchema` + `hasattr` 兜底 → **所有 MCP 工具以空 parameters 暴露给模型**，模型不知道该填什么参数。
- 【实测】`CallToolResult` 字段是 `is_error`，代码读 `result.isError` + 兜底 → **工具真失败时报告为成功**，模型会拿错误文本当事实继续编。
- 两者都是**无声失败**，日志里没有任何线索。

### 2.3 🔴 角色扮演主路径完全不注入 MCP 工具

- 【代码】`get_all_tools_openai_format()` 只在通用聊天路径被调用（`websocket.py:334-352`、`chat.py:355-368`）。
- `run_character_chat_generation`（角色聊天主路径）全函数零处引用 → **palink-native 的角色扮演下，第三方 MCP 工具对模型不可见**。
- 结论：MCP 目前只在「通用聊天」里对 admin 生效。

### 2.4 其他问题【代码】

| 级别 | 问题 | 位置 |
|---|---|---|
| P0 | SSRF 防护默认失效（`APP_ENV` 默认 `development` → 直接 return True） | `mcp_service.py:99-104,135-136`、`config.py:11` |
| P1 | stdio `env` 硬白名单只放 10 个键，`GITHUB_TOKEN` 等**静默丢弃** | `mcp_service.py:22-27,335-336` |
| P1 | 连接/列工具/调用**全无超时**（前端插件路径反而有 60s） | `mcp_service.py:297,396,433` |
| P1 | 无 `disconnect_all`、无 lifespan 钩子 → stdio 子进程常驻；生成路径只连不断 | 全仓零命中 |
| P1 | `_active_connections` 无锁，check-then-act 竞态（后到者可能掐断先到者的 session） | `mcp_service.py:269-270,417-420` |
| P2 | `type` 无枚举校验，任意值静默落到 SSE 分支 | `mcp_service.py:263-292` |
| P2 | 工具名注册表永不清理；工具名把 server_id 截到 12 字符（实测 `e2e-stdio`→`e2e-stdi`）→ 撞名风险 | `mcp_service.py:52-65` |
| P2 | 配置读取 `except: pass`（JSON 损坏静默返回空）；写入非原子 | `mcp_service.py:198-207,210-214` |
| P2 | MCP 异常被压成固定文案，原始错误既不回传模型也不上抛 | `inference_dispatcher.py:898-900` |

**测试覆盖：后端零覆盖**（`backend/tests/` 无 MCP 测试；仅 `test_sd_provider_ssrf.py` 借用其私有函数做 fixture）。

---

## 3. 文生图支持度

### 3.1 支持矩阵

| type | 状态 | 端点 | 响应解析 | 备注 |
|---|---|---|---|---|
| `openai_compatible` | ✅ 可用【实测】 | `{base}/v1/images/generations` | `data[0].b64_json` / `url` / data URL | URL 拼接规则武断：非 `/v1` 结尾会追加 `/v1/...` |
| `sd_webui`（本地 A1111） | ✅ **可用**【实测】 | `{base}/sdapi/v1/txt2img` | `images[0]` + `info.seed` | 参数全硬编码 |
| `comfyui`（本地） | ❌ **不可用**【实测 501】 | 仅 `POST /prompt` | 不取图 | 缺 `/history/{id}` 与 `/view` |

### 3.2 本地文生图的两个关键事实

1. **SD WebUI 真的能接** —— 端点、参数名（`prompt/negative_prompt/steps/cfg_scale/width/height/sampler_name`）、响应字段（`images[]`、`info.seed`）与 A1111 实际接口一致，出图后落盘、返回可访问 URL 全通。
2. **但它在生产模式下配不进去** —— 本地 SD 必然是内网地址（`http://127.0.0.1:7860`），而 `_validate_provider` 在**非 development** 时一律拒绝内网（【实测】拦截文案见 1.2）。即「开发能配、生产被自家安全策略挡住」，且没有白名单机制。

### 3.3 SD 路径的可配置性 = 0【实测】

上游实收 `steps=20 sampler='Euler a' cfg=7.0 neg=''` —— 全部硬编码：
- `negative_prompt` 恒空、`steps` 恒 20、`cfg_scale` 恒 7.0、`sampler_name` 恒 `Euler a`
- `provider.model`（想切 checkpoint）**完全不被读取**
- 鉴权只发 `Authorization: Bearer`，而 A1111 原生是 **HTTP Basic** → 开了 `--api-auth` 就连不上
- 前端 schema 里也没有这些字段（`schemas/image_generation.py:11-23`），填了也不生效

### 3.4 其他问题【代码】

- **前端没有图片生成设置页**：`api.imageGeneration.updateConfig` 全仓零调用 → 只能靠管理员直接 PUT 或手改 JSON。
- **磁盘清理形同虚设**：`api/admin.py:792-807` 只遍历一层，遇 `generated-images` 目录 `os.remove` 抛 `IsADirectoryError` 被吞 → 生成图永不清理。
- **无图片配额**：`quota_service.py` 无 image 计数。
- 只校验 base64 合法性，不校验字节是不是真图片；一律存成 `.png`。
- `_download_image` 开 `follow_redirects=True` 且不复查目标（代码注释已自认是残留风险），且无下载大小上限。
- `attach_message_media` 读改写无锁，同消息并发出图会互相覆盖。

---

## 4. TTS 支持度

### 4.1 provider 矩阵（6 个内置）

| provider | 状态 | 真实调用 | 返回类型 | 备注 |
|---|---|---|---|---|
| `xiaomi_mimo` | ✅ 可用（有实测履历） | `POST api.xiaomimimo.com/v1/chat/completions` | `audio/wav` | 鉴权用 `api-key` 头；实测出过 130KB 真音频 |
| `browser` | ✅ 可用（纯前端） | 无网络 | — | Web Speech API；两个 voice_id 是占位符，男女声只靠 pitch 区分 |
| `edge` | ⚠️ 有条件可用 | edge-tts 库 → 微软在线 | `audio/mpeg` | 【实测】容器内 `edge_tts 7.2.8` 可导入 ✅；需外网 |
| `elevenlabs` | ⚠️ 有条件可用（未实测） | `api.elevenlabs.io/v1/text-to-speech/{voice}` | `audio/mpeg` | 鉴权 `xi-api-key` 正确；未传 `output_format` |
| `custom_api` | ⚠️ 有条件可用 | `POST {base_url}` | **硬编码 `audio/mpeg`** | 🔴 内网地址被拒（双层校验）；格式错配 |
| `coqui` | ❌ 基本不可用 | `GET {base}/api/tts` | `audio/wav` | 缺 `language_id`、speaker 传 `default` 非法、**无 URL 校验** |
| `gpt_sovits` | ❌ 不存在 | — | — | 全仓零匹配 |

### 4.2 🔴 音频格式标注错配（实测确证）

【实测】上游返回的是 `RIFF/WAVE` 字节，而 `custom_api` 分支声明 `audio/mpeg`（`tts_service.py:908`），且**完全丢弃上游的 `Content-Type`**（`:550` 只取 `response.content`）。后果：前端 `blob.type` 继承错误类型，**Chrome 靠嗅探大概率能播，Safari / iOS 严格按类型解码会直接不出声**。同类硬编码还在 ST 兼容端点（`api/tts.py:378-382`、`silly_tavern.py:4846-4856`）。

### 4.3 其他问题【代码】

- **音色绑定优先级会"吞掉"配置**：`provider_id = binding.provider_id or provider_id`（`tts_service.py:761`），global 绑定在首次落库时**冻结**当时的 `active_provider_id`。管理员之后切换服务商只改配置文件 → UI 显示"当前使用 X"，实际仍走旧服务商。（我上一轮验收时正是被这条咬到）
- **voice_description 链路是断的**：模型输出 `【声音：温柔】` 会被静默删除（`tts_service.py:347`），21 条声线映射与 MiMo 的 style 前缀**在真实播放路径上永不生效**（前端 `extractVoiceDescription` 零调用方）。
- **分段播放开关拿不到**：`loadSegmentedPlaybackConfig()` 零调用方；该字段也不在普通用户可见的配置返回里 → 只能手写 localStorage。
- **400 脱敏把有用文案全吞**：`tts_service.py` 里那些写给人看的中文提示（"请先去模型管理→语音中设置"）被统一替换成「语音合成请求无法处理 (request_id: xxx)」，用户无法自助修复。
- **sequenceActive 泄漏**：`stop()` 先把 `abortController` 置 null，`runSequence` 的 finally 判等失败 → 标志位永久为 true，之后非序列播放播完不回 idle、也不弹错误（默认开关关闭，影响面有限）。
- **前端音频 GET 无超时**（后端 httpx 有 60/90s）。
- 前端缓存只有条数上限（20 条）、无字节上限，源码自述单条最长约 11MB。
- **后端零测试**：`backend/tests/` 无任何 TTS 测试；前端仅 `tts-player.test.ts`（16 例，未覆盖上述缺陷）。

---

## 5. 浏览器直连本地 API 提供商：可行性（用户问题）

### 5.1 实测结论

**技术可行，唯一硬门槛是跨域。** 实测三组：

| 场景 | 结果 |
|---|---|
| 本地服务**不带** CORS 头 | ❌ `BLOCKED: Failed to fetch` |
| **Ollama**（11434，默认策略） | ✅ `OK 200` —— 默认可直连，无需额外配置 |
| 本地服务**带** CORS + 响应 OPTIONS 预检 | ✅ `POST 200`，浏览器直接拿到出图结果 |

要点：直连**不是 GET 就够** —— 出图/AI 回复都是 `POST + application/json`，浏览器会先发 `OPTIONS` 预检，本地服务必须正确应答（实测服务端确实收到了预检）。

### 5.2 若要做，需要满足的前提

1. 本地服务允许本页 origin：Ollama 默认可以；A1111 需 `--cors-allow-origins`、ComfyUI 需 `--enable-cors-header`（**【未验】**本机未安装这两者，依据官方文档）。
2. 混合内容：若 Palink 页面走 https 而本地是 http，需确认目标浏览器对 loopback 的豁免策略（**【未验】**需针对实际浏览器测）。
3. 密钥边界：本地服务一般无鉴权，风险低；但**云端 API 的 key 放浏览器会被任意 XSS 读取**，且服务端失去审计/限流能力 —— 这类应继续走后端。
4. 现状基础：项目已有"前端不经过网络"的先例（TTS 的 `browser` 引擎走 Web Speech），但**不存在任何"前端直连外部 HTTP 服务"的代码**，要做属于新增能力。

### 5.3 建议形态（不施工，仅建议）

按"能力来源"分三类处理，而不是一刀切：

- **浏览器原生能力**（Web Speech 朗读、可能的本地模型 WebGPU）：纯前端即可，已有先例。
- **本地无鉴权服务**（Ollama / SD WebUI / ComfyUI）：可做"直连模式" —— 前端探测可达性 + 提示用户开启 CORS；失败则回落到后端代理。
- **云端带密钥的 API**：继续走后端，不要下放浏览器。

---

## 6. 建议修复优先级（按性价比）

| # | 事项 | 理由 |
|---|---|---|
| 1 | MCP 改读 `input_schema` / `is_error`（兼容 2.x 与 1.x） | 一行 `hasattr` 改动，修掉两个无声失败；当前所有 MCP 工具对模型都是"无参数黑盒" |
| 2 | TTS 音频类型按上游 `Content-Type` 或魔数推导 | iOS/Safari 直接失声，属用户可感知故障 |
| 3 | TTS 绑定优先级：让 `active_provider_id` 优先，或切换时同步刷 global 绑定 | 当前 UI 与实际行为不一致 |
| 4 | MCP 补超时（对齐前端插件路径的 60s） | 一个挂死的 MCP server 会无限期挂住整条生成流 |
| 5 | 给 streamable-http 做兼容或从 UI 摘掉 | 现在用户能配、配了必崩 |
| 6 | 决定 MCP 是否要进角色扮演路径 | 这是产品决策，不只是技术 |
| 7 | 本地文生图的生产可用性（内网白名单机制） | 否则"支持本地 SD"只在开发模式成立 |
| 8 | 补 MCP / TTS 的后端测试 | 两块目前零覆盖 |

---

## 7. 未验 / 存疑（如实标注）

- SD WebUI 与 ComfyUI 的**真实**服务未参与测试（本机未安装），验证用的是严格按其官方接口形状构造的本地模拟上游；结论"端点/参数/响应字段匹配"建立在此之上。
- A1111 `--api-auth`（Basic）与项目只发 Bearer 的不兼容、以及 ComfyUI 强制 `--enable-cors-header`，均依据官方文档，**【未验】**。
- 浏览器直连的 https 混合内容行为**【未验】**（需要 https 环境）。
- iOS/Safari 因 Content-Type 错配而失声**【未验】**（本机无 iOS 设备），依据的是格式与类型不一致这一实测事实 + 浏览器解码策略常识。
- 上一轮我实测过 `deepseek-v4-flash` 会主动发起工具调用，但**不是每次都调**：同一意图下它可能选择不调工具而回纯文本。
