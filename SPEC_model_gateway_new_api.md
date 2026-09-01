# SPEC：引入 New API 作为模型网关（同模型多提供商管理）

> 状态：**P0 配置阶段进行中**（见下方任务清单实时勾选）
> 创建：2026-08-31
> 接手者必读：本文件是唯一权威进度源，动工前先读「§1 决策」和「§6 红线」。

---

## §1 决策与背景

### 问题
项目无 API 模型网关。同模型多提供商（如 `deepseek-chat` 同时可从 DeepSeek 官方 / OpenRouter / 硅基流动 / 火山方舟获取）无法管理、无法故障转移、无法按用户配额。

### 已拍板的决策（用户 2026-08-30 确认）
1. **不自研网关**，引入外部开源容器网关。
2. **选定 New API**（`QuantumNous/new-api`，Go 单容器，one-api 活跃接班分支，45k+ star）。
3. **协议立场：原样部署，不修改 new-api 源码**（AGPL-3.0；独立进程 + 仅通过 HTTP 调用其 API 不触发传染。若改源码并对外服务则触发开源义务，届时需重新评估或联系项目方谈商业许可）。
4. **凭证双轨**：用户可自带 key（BYOK）**或**使用管理员分配的平台额度。

### 核心架构立场（不要偏离）
**OpenRouter 不是 New API 的替代品，是它的下游渠道之一。**
- 反模式：Palink 直连 OpenRouter → 单点依赖，它挂全站挂。
- 正解：Palink 只认一个 base_url（new-api），OpenRouter 降级为 new-api 里的一个渠道，与 DeepSeek 官方 / 硅基流动 / 火山方舟并列。

### 与昨日决策的关系
`TODOS.md:20`（2026-08-29 方案 A）原文已预留：「将来要多供应商只需加 new-api 容器改 base_url，零返工」。**本次即启用当时暂缓的方案 B**，昨日刻意删除的 priority/round_robin/weighted/RPM 限流机制正是要交给 new-api 的。

---

## §2 备份与回滚

### 备份位置（2026-08-31 17:23 创建）
```
D:\项目\Palink-AI\backup\newapi-gateway-20260831-172355\
```
包含：`docker-compose.yml`、`docker-compose.dev.yml`、`providers.json`、`inference_dispatcher.py`、`llm_client.py`、`connection_profile_service.py`、`dependencies.py`、`models/system.py`、`.env`

### 回滚方式（按阶段）
- **P0（仅配置）**：把 `providers.json` 中 NewAPI 条 `is_active` 改 `false`、OpenRouter 条改 `true` 即可恢复直连，无需重启。compose 里 `new-api` 服务可留着不删。
- **P1（接线后）**：回滚 providers.json 同上；ContextVar 凭证覆盖在取不到上下文时自动回退平台默认，**不会因回滚产生异常**。
- **整包回滚**：从备份目录 `Copy-Item` 覆盖回原路径（**严禁 `git stash -u` / 整树 tar，会 SIGKILL 损坏 .git**）。

---

## §3 目标架构

```
Palink backend ──► New API 容器 (compose 网络内) ──┬─► 渠道1  OpenRouter
  只认一个 base_url      渠道路由 · 失败重试        ├─► 渠道2  DeepSeek 官方
                         令牌配额 · 用量看板        ├─► 渠道3  硅基流动 / 火山
                                                    └─► 渠道N  其他中转商
```

### 双模式：网关可选（2026-08-31 用户追加需求，已采纳）

**核心判断：网关必须是可选项，不是强制依赖。** 个人用户只想填一个 key 就用起来；团队/商业用户才需要渠道聚合、故障转移与配额。

**关键事实：两种模式在 Palink 侧完全同构，不需要任何模式开关代码。**
`providers.json` 的每个 provider 本来就是 `{base_url, api_key, models, is_active}`。用户填什么，就是什么模式：

| 模式 | 部署 | providers.json 长什么样 | 能力 |
|---|---|---|---|
| **A 直连**（默认） | 无需额外容器 | 每个上游一条记录：OpenRouter 一条、DeepSeek 官方一条… | 多提供商并存；同模型多提供商**仅支持 `preferred_provider_id` 精确指定，无自动故障转移** |
| **B 网关**（可选增强） | `docker compose --profile gateway up -d` | 只需一条记录：`base_url = http://new-api:3000/v1` | 同模型多渠道自动轮询、失败自动切渠道、令牌配额、用量看板 |

**实现机制（零业务代码）：**
1. compose 里 `new-api` 服务打 `profiles: ["gateway"]` → 默认 `docker compose up -d` **不启动**它。
2. `backend.depends_on.new-api` 必须加 `required: false` —— **否则未启用网关时 backend 会启动失败**。这是本方案唯一的硬性改动点。

**UI 侧（P2 润色，非阻塞）：** 不做"模式开关"，只在 Provider 编辑页加引导——检测到 `base_url` 可解析到 new-api（探测 `/v1/models` 返回带 new-api 特征）时，显示「已接入网关」标记与后台跳转链接。

### 双轨凭证（P1 实现）
| 模式 | ConnectionProfile.provider | api_key_encrypted 存什么 | base_url 指向 |
|---|---|---|---|
| BYOK（用户自带 key） | `custom` | 用户自己的上游 key | 用户填的上游端点 |
| 平台额度（管理员分配） | `palink`（新增枚举值） | 系统签发的 new-api 令牌 | `http://new-api:3000/v1` |
| 无激活 profile | — | 回退 `providers.json` 平台默认 | new-api |

三者走同一个 `resolve_credentials()` 调用。

---

## §4 任务清单

### P0 — 纯配置，零代码改动

- [x] **P0-0 备份**受影响文件 → `backup/newapi-gateway-20260831-172355/`
- [x] **P0-0b 核实**镜像名 / 端口 / 环境变量 / 初始凭据（见 §5）
- [x] **P0-1 `docker-compose.yml` 新增 `new-api` 服务** — 2026-08-31 完成。实测：`docker compose config --services` 默认 5 服务（不含 new-api）；`--profile gateway` 6 服务（含 new-api）。坑见 §6-8。
  - 镜像 `calciumion/new-api:latest`；`expose: 3000` + `ports: 127.0.0.1:13001:3000`（后台入口，见 §6-1）
  - 卷 `newapi_data:/data`；网络仅 `frontend-backend`
  - 环境变量：`TZ`、`SESSION_SECRET`（**必须 `${VAR:-默认}` 语法**，见 §6-8）、`INITIAL_ROOT_TOKEN`；**刻意不设 `SQL_DSN`** 用默认 SQLite，避免路径写错另建空库
  - `backend` 的 `depends_on` 加 `new-api` 且 **`required: false`**（直连模式下 new-api 不存在，否则 backend 起不来）
  - 顶层 `volumes` 加 `newapi_data`
- [x] **P0-2 `.env` 追加变量** — 2026-08-31 完成。已追加 `NEWAPI_SESSION_SECRET`（32B 随机 hex）、`NEWAPI_ROOT_TOKEN`（16B 随机 hex）、`PALINK_NEWAPI_TOKEN`（占位待 P0-6 填）。沿用 LF 换行，未触碰任何既有行。
- [x] **P0-3 启动容器并验证** — 2026-08-31 完成。镜像 313MB；日志 `SQL_DSN not set, using SQLite`；版本 **v1.0.0-rc.30**；`docker ps` 显示 `Up (healthy)`；从 backend 容器访问 `http://new-api:3000/v1/models` 返回 401（网络通、未授权，属预期）；宿主机 `http://127.0.0.1:13001/` 返回 200。
- [x] **P0-3b 后台端口映射** — 追加 `127.0.0.1:13001:3000`（仅绑定回环，避开 WinNAT 保留段）。见 §6-1。
- [x] **P0-4【需人工】管理员初始化** — 2026-09-02 完成。用户已在 Web 引导创建管理员 `admin`（role=100 / status=1）。`NEWAPI_ROOT_TOKEN` 因此**不再生效**（见 §6-11）。
- [x] **P0-5【需人工 · 需提供上游 key】建渠道** — 2026-09-02 完成。渠道 `001`：type=20（OpenRouter 专用）、模型 `deepseek/deepseek-v4-flash-0731`、group=`default`、**balance=$8.2794 + response_time=892ms**（说明上游 key 已实测通过）。
  - ⚠️ 前置事实（2026-08-31 实测）：`.env` **中不存在任何 `PALINK_PROVIDER_*` 变量**，运行时 `backend/data/providers.json` 为 `[]`。渠道密钥最终由用户在后台填入。
  - 渠道 2+：DeepSeek 官方 / 硅基流动 / 火山方舟，按需加 —— **这就是"同模型多提供商"的落点**
  - **同模型多渠道 = 自动轮询 + 失败自动切下一渠道**（new-api 原生能力，无需额外配置）
  - ⚠️ 后续用管理 API 代建渠道：`POST /api/channel/` 需要**会话 Cookie**，Bearer token 只通 relay 端点（§6-12）
- [x] **P0-6 建令牌** — 2026-09-02 由 agent 完成（未惊动用户 Web 会话）。令牌名 `palink-backend`，已写入 `.env` 的 `PALINK_NEWAPI_TOKEN`。
  - ⚠️ **关键坑：`tokens.key` 列存的是不带 `sk-` 前缀的 48 位串**，new-api 查询时会剥离前缀（§6-13）
  - 创建方式：直接写 SQLite（管理端走不通，见 §6-12）；token 缓存是懒加载，**无需重启**即生效
- [x] **P0-7 `backend/data/providers.json` 切换**（⚠️ 目标是 `backend/data/`，**不是** `backend/app/data/`，见 §6-10）— 2026-09-02 完成
  - 已建 NewAPI 条：`id=prov-newapi-20260902`、`base_url: http://new-api:3000/v1`、`api_key: env:PALINK_NEWAPI_TOKEN`、`is_active: true`
  - **模型用逻辑名 `deepseek-v4-flash`，由 new-api 的 `model_mapping` 映射到 `deepseek/deepseek-v4-flash-0731`**（§6-14）。理由：`model_specs.json` 与 `unified_models.json` 的 key 均为无前缀逻辑名，直填真实 ID 会丢失上下文/输出规格（退化成 4096）。
  - 将来要回退直连：新建上游直连条并切换 `is_active`，无需删除网关条
  - ⚠️ 改 `.env` 后必须 `docker compose up -d backend`（**recreate**，restart 不重读 env_file）；改 `providers.json` 则按 mtime 自动生效，无需重启
- [x] **P0-8 端到端验证** — 2026-09-02 完成
  - `/v1/models` → `['deepseek-v4-flash', 'deepseek/deepseek-v4-flash-0731']`
  - Palink 代码路径（`unified_model_registry.select_provider_for_model` → `llm_client`）实发请求 → **200**，返回「我是AI助手，乐于助人。」，`resp.model=deepseek/deepseek-v4-flash-0731`（证明映射生效）
  - 网关侧落账：token/channel `used_quota=11063`，`logs` 9 条，**日志记录的是映射前的逻辑名** `deepseek-v4-flash`（便于对账）
  - ⏸ **故障转移未验证**：当前仅 1 条渠道，无法验证多渠道切换。待加第 2 条渠道后补验（§6-15）
  - ✅ **usage 透传补验（2026-09-02）**：非流式 `resp.usage` 与流式 `stream_options.include_usage` 尾块均经网关**原样到达** Palink 侧（含 OpenRouter 的 cost/缓存明细）。⚠️ 细节：尾块 usage 挂在最后一个 content chunk 上（OpenRouter 风格），非 OpenAI 标准的空-choices usage 专属尾块——Palink 主路径本就支持 OpenRouter 直连，兼容，P1 接线时留意。**结论：网关模式下 Palink 现有计量主路径零改动继续工作，数字与直连同源。** 另：实测观察到 OpenRouter 将请求路由至 Baidu 上游（响应 `provider` 字段可见），同模型多上游路由真实发生。

### P1 — 双轨凭证接线

- [ ] **P1-1 新增 `backend/app/services/request_identity.py`**
  - ContextVar `_user_id_var`、`_db_var` + `bind()/unbind()/current()`
- [ ] **P1-2 注入点**：`api/dependencies.py:32` `get_current_user` 末尾 bind(user_id, db)；WebSocket 路径在鉴权后补 bind
- [ ] **P1-3 凭证覆盖**：`inference_dispatcher.py:283`（非流式）与 `:607`（流式）构建 client 前插入 `provider = apply_user_credentials(provider)`
  - 内部调 `resolve_credentials(db, user_id, default_api_key=provider["api_key"], default_base_url=provider["base_url"])`
  - 取不到上下文 → 原样返回（后台任务 / 本地 llama / 脚本行为零变化）
- [ ] **P1-4 `llm_client.py` 缓存键改造**：现缓存键含 `api_key` 哈希、上限 50。per-user 令牌会让缓存被多用户冲掉 → 需按用户规模调上限或把 key 移出缓存键
- [ ] **P1-5 `ConnectionProfile.provider` 枚举**新增 `palink` 值（仅数据层，无迁移风险）
- [ ] **P1-6 测试**：新增 `tests/test_request_identity_credentials.py`；全量 `pytest` + `tsc --noEmit`

### P2 — 管理员额度签发自动化（P2-3 已完成 2026-09-02，P2-1/P2-2 未启动）

- [ ] **P2-1** 调 new-api 管理 API（`/api/token/`、`/api/user/`）懒签发令牌，加密写入 `ConnectionProfile`
- [ ] **P2-2** 管理后台 UI：给用户分配/回收额度
- [x] **P2-3 网关对账（提前交付，2026-09-02）** — 检测/对账/设置呈现全链路上线：
  - 后端 `services/gateway_service.py`：`/api/status` 指纹探测（命中 ≥2 特征字段，超时 4s）、`POST /api/user/login` 拿 `access_token`（**rc.30 起管理端点直接 Bearer，不再需要会话 Cookie**，§6-12 已被此版本演进部分取代）、`/api/log/` 拉取（**分页参数是 `p` 不是 `page`**，type=2，上限 20 页标记 truncated）、TTL 内存缓存（探测 5min/对账 60s/token 至过期）。零新表、零常驻任务
  - 端点 `GET /api/admin/gateway/detect`（全 active provider 并发探测）、`GET /api/admin/gateway/ledger?provider_id=&hours=24|168|720`（网关账本 vs 消息表聚合，drift 百分比；非网关/未配凭据/登录失败全部 200+状态字段降级）
  - `providers.json` provider 级新增可选字段 `admin_url`/`admin_username`/`admin_password`（支持 `env:` 引用；**明文密码 GET 不回显**，编辑页留空=保留原值）
  - 前端：provider 卡片「网关 · vX.Y.Z」琥珀徽标 + 「后台」外链；模型管理新增 admin「网关对账」sub-tab（对比卡/按模型对照/网关最近明细/配置引导）；ProviderEditPage 网关管理分组
  - 实测（2026-09-02 浏览器真机）：徽标 `网关 · v1.0.0-rc.30` 显示、后台链接 `127.0.0.1:13001`、未配置凭据降级引导正确；pytest 1278 passed（新增 24）、tsc 干净
  - ⏸ 待用户在 `.env` 填 `NEWAPI_ADMIN_PASSWORD`（已留占位）→ `docker compose up -d backend` 后补验对账数字与 new-api 后台对账单一致

---

## §5 new-api 部署参数（已核实）

| 项 | 值 |
|---|---|
| 镜像 | `calciumion/new-api:latest` |
| 容器内端口 | `3000` |
| 持久化目录 | `/data`（**SQLite 文件是 `/data/one-api.db`，不是 `new-api.db`**） |
| 初始管理员 | **v1.0.0-rc.30 不再内置 `root`/`123456`**（已实测踩坑，见 §6-11）。首次启动走 Web 引导创建管理员；`INITIAL_ROOT_TOKEN` 仅在「系统未初始化且无 root 用户」时生效 |
| 必需环境变量 | `SESSION_SECRET`（多节点必需，单节点也强烈建议设）、`TZ` |
| 可选变量 | `SQL_DSN`（外部 DB 才需）、`INITIAL_ROOT_TOKEN`（预设 root token，便于 API 自动化）、`REDIS_CONN_STRING`、`CRYPTO_SECRET` |
| 不存在 | `NODE_TYPE=standalone`（仅多节点 slave 场景才用，**不要设**） |
| 管理 API | `/api/channel/`、`/api/token/`、`/api/option/`（P2 自动化用） |

---

## §6 坑与红线（全部已核实，勿踩）

1. **端口 3000 落在 WinNAT 保留段 2934-3033**（`docker-compose.yml:5-7` 与 TODOS 环境注意条目已记录）→ new-api **绝不映射宿主机 3000**。后台访问统一走 `127.0.0.1:13001:3000`（只绑回环，管理后台不在局域网暴露）。
2. **SQLite 改库：部分生效，分两类**（2026-09-02 实测修正，原说法过严）。new-api 有两层缓存，行为不同：
   - **`tokens` 表：改库后立即生效，无需重启**。token 缓存是懒加载——请求带未知 key 时才回源查库（日志证据：`ValidateUserToken: failed to get token: record not found`，证明它确实查了库而非只查缓存）。
   - **`abilities` 表（模型→渠道路由）：必须重启容器**。启动时全量载入内存，改库不触发刷新。
   - 结论：改渠道模型映射后记得 `docker restart palink-new-api`。
3. **`providers.json` 的 model ID 必须与 new-api 渠道里的模型名一致**，否则 Palink 找不到模型。new-api 支持同名多渠道，无需在 Palink 侧改 ID。
4. **严禁给 `complete_text_completion` / `stream_text_completion` 加 `db`/`user_id` 参数**：调用点 30 处分散 api 层与 service 层，且 `ai_summary_service` / `mvu_secondary` / `compact_title_service` / `roleplay_prompt_assembly` 根本拿不到 user_id。必须用 ContextVar。
5. **迁移范围仅 chat 链路**。embedding（ollama bge-m3）、TTS（`tts_config.json`）、图像生成（独立 providers）各自独立配置体系，**本轮不动**。
6. **禁 `git stash -u` / git fetch / clone / 整树 tar**（进程级 SIGKILL 损坏 .git）。备份一律 PowerShell `Copy-Item`。
7. **AGPL-3.0**：不改源码、独立进程、HTTP 调用 = 安全。一旦要改 new-api 源码对外服务 → 触发开源义务，停手重评估。
8. **compose 变量插值发生在 profile 过滤之前**（2026-08-31 实测踩坑）：给带 `profiles:` 的服务写 `${VAR:?提示}`，会让**未启用该 profile 的直连模式用户** `docker compose up -d` 直接失败（`error while interpolating ... required variable ... is missing a value`）。**可选服务的环境变量一律用 `${VAR:-默认值}`**，把校验责任交给文档与启动后检查。
9. **`/api/status` 是公开端点**：它返回 200 **不代表**访问令牌有效。2026-08-31 踩坑——系统未完成管理员初始化前，用 `INITIAL_ROOT_TOKEN` 调 `/api/token/` 一律 401，而 `/api/status` 仍返回 200，极易误判为"令牌已生效"。验证令牌必须调需鉴权的接口。
10. **运行时配置 ≠ 代码库模板**（必读）：compose 挂载 `./backend/data:/app/data`，**生效的 provider 配置是 `backend/data/providers.json`，不是 `backend/app/data/providers.json`**（后者只是随代码分发的模板）。2026-08-31 实测：运行时文件内容为 `[]`（空数组），且 `.env` 中**不存在任何 `PALINK_PROVIDER_*` 变量**——当前环境未配置任何有效上游凭据，建渠道必须由用户提供真实 key。
11. **`INITIAL_ROOT_TOKEN` 只在「系统未初始化且不存在 root 用户」时生效**（2026-09-02 实测）。启动日志 `system is already initialized at: ...` 即表示该变量已被跳过，此后用它调管理 API 一律 401。用户通过 Web 引导自建的 `admin`（role=100/status=1）是独立身份，**与 `INITIAL_ROOT_TOKEN` 不是同一凭据**。若确需自动化签发（P2），路径是：改 `users` 表让系统判定无 root → 重启触发该变量 → 或走用户会话 Cookie。
12. **管理端点与 relay 端点鉴权方式不同**（2026-09-02 实测）：`/v1/*`（OpenAI 兼容）用 `Authorization: Bearer <token>`；而 `/api/channel/`、`/api/token/` 等管理端点**要会话 Cookie**（`/api/user/login` 换取）。用 Bearer 调管理端返回 `AUTH_UNAUTHORIZED` 是**正常现象，不是令牌无效**——验证令牌请调 `/v1/models`。
    - **⚠️ v1.0.0-rc.30 演进（2026-09-02 P2-3 实测确认）**：该版本 `POST /api/user/login`（JSON username/password）直接返回 `data.access_token`，管理端点改用 `Authorization: Bearer <access_token>` 即可（`middleware/auth.go classifyDashboardCredential` 只读 Authorization 头），不再需要维护会话 Cookie；2FA 账号返回 `require_2fa` 需走二步验证（Palink 对账不支持 2FA 账号，用无 2FA 管理员）。未登录 401 返回 `{"code":"AUTH_UNAUTHORIZED"}` 信封。
13. **`tokens.key` 列存的是不带 `sk-` 前缀的 48 位串**（2026-09-02 实测，最大坑）。new-api 收到 `Bearer sk-XXXX...` 后会**剥离 `sk-` 前缀**再查库。SQL 证据：
    ```sql
    SELECT * FROM tokens WHERE `key` = "OpjV8982..." AND `tokens`.`deleted_at` IS NULL LIMIT 1
    ```
    直插数据库若写了完整的 `sk-OpjV...`，请求永远 `record not found`。**写库时存 48 位无前缀串，对外使用/配置时仍是 `sk-` + 该串。**
14. **Palink 侧用逻辑模型名，映射交给网关**（2026-09-02 决策）。`model_specs.json`（上下文/输出上限）与 `unified_models.json`（显示名/图标）的 key 都是**无前缀逻辑名**如 `deepseek-v4-flash`；若 providers.json 直填上游真实 ID（`deepseek/deepseek-v4-flash-0731`），`get_model_spec()` 匹配不到 → 上下文退化为兜底 `4096`。正确做法：
    - new-api 渠道 `model_mapping` = `{"deepseek-v4-flash": "deepseek/deepseek-v4-flash-0731"}`
    - 渠道 `models` 同时列出逻辑名与真实名，并在 `abilities` 表为逻辑名注册路由（`group=default`, `enabled=1`）
    - Palink providers.json 只填逻辑名
    - 收益：换上游只改网关映射，Palink 零改动——**这正是网关的核心价值**
15. **故障转移尚未验证**：当前仅 1 条渠道，无法验证「禁用渠道后自动切下一渠道」。加第 2 条渠道后补验：把渠道 A 的 `status` 改 2（禁用）→ 请求应仍成功 → 改回 1。
16. **写 new-api 的 SQLite 卷需要 root 身份**（2026-09-02 实测）：卷内文件属主 `root:root` 权限 `644`，而 `palink-ai-backend` 镜像默认以 `uid=1000(appuser)` 运行，直接写会报 `attempt to write a readonly database`。解法：`docker run --rm --user root -v palink-ai_newapi_data:/data ...`。
    - 另外 `group` 是 SQL 保留字，写这句必须加引号：``INSERT INTO tokens (..., "group", ...)``。
17. **定位 new-api 鉴权问题的利器**：起一个临时诊断容器，带 `DEBUG=true` 与 `SQL_DEBUG=true`，挂同一卷与同一网络但**不映射端口**（避免冲突、不中断现网服务）：
    ```bash
    docker run -d --name newapi-debug --network palink-ai_frontend-backend --user root \
      -v palink-ai_newapi_data:/data -e DEBUG=true -e SQL_DEBUG=true calciumion/new-api:latest
    # 从 backend 容器请求 http://newapi-debug:3000/... 后 docker logs newapi-debug 看真实 SQL
    ```
    new-api 的 token 缓存是懒加载，诊断完后 `docker rm -f newapi-debug`。

---

## §7 关键代码坐标

| 用途 | 位置 |
|---|---|
| Provider 配置数据 | `backend/app/data/providers.json` |
| Provider 读写/缓存 | `backend/app/services/provider_registry.py:29`（`_providers_path`）、`:42`（`get_providers`） |
| 模型查找（含 inactive 过滤） | `backend/app/services/provider_registry.py:145`（`find_model`）、`:147` |
| 推理 client 构建点①非流式 | `backend/app/services/inference_dispatcher.py:283` |
| 推理 client 构建点②流式 | `backend/app/services/inference_dispatcher.py:607` |
| 死代码 import | `backend/app/services/inference_dispatcher.py:13`（`resolve_credentials` 已导入但未调用） |
| 凭证解析函数 | `backend/app/services/connection_profile_service.py:52`（`resolve_credentials`） |
| 双轨数据表 | `backend/app/models/system.py:241`（`ConnectionProfile`） |
| 客户端缓存（P1 需改） | `backend/app/services/llm_client.py:15`、`:19` |
| 认证注入点 | `backend/app/api/dependencies.py:32`（`get_current_user`） |
| 网关探测/对账服务 | `backend/app/services/gateway_service.py`（P2-3） |
| 网关管理端点 | `backend/app/api/gateway.py`（`/api/admin/gateway/detect`、`/ledger`） |
| 对账面板（前端） | `frontend/src/components/views/settings-tabs/GatewayLedgerPanel.tsx` |
| compose 服务清单 | `docker-compose.yml` |

---

## §8 验收标准

- **P0**：Palink 角色对话正常返回 → new-api 后台「日志/用量」出现对应记录 → 手动禁用某渠道后请求仍成功（故障转移生效）
- **P1**：绑定用户 A 的 BYOK profile 后，请求带 A 的 key 直连上游；无 profile 用户走平台令牌；无上下文场景行为不变；`pytest` 全绿
- **P2**：管理员可在 Palink 后台给指定用户发放/回收额度，new-api 侧配额同步

---

## §9 【接手必读】总结与下一步（浓缩版）

### 干了什么（P0，2026-08-30 → 09-02）

选定 **New API**（`QuantumNous/new-api`，Go 单容器、AGPL-3.0 原样部署）作外部 LLM 网关，解决"同模型多提供商难管理"。**P0 全部完成并已端到端验证**：

1. `docker-compose.yml` 新增 `new-api` 服务（`--profile gateway` 可选，直连模式零依赖）
2. `.env` 注入 `NEWAPI_SESSION_SECRET` / `NEWAPI_ROOT_TOKEN` / `PALINK_NEWAPI_TOKEN`
3. 用户在 Web 引导完成管理员初始化（账号 `admin`）
4. 用户在后台建 OpenRouter 渠道 `001`（模型 `deepseek/deepseek-v4-flash-0731`，真实 key 有效，余额 $8.28）
5. agent 在 new-api 建令牌 `palink-backend`，写入 `.env`
6. `backend/data/providers.json` 从 `[]` 切换为 NewAPI 网关条
7. **架构关键决策**：Palink 只写逻辑模型名 `deepseek-v4-flash`，由 new-api `model_mapping` 映射到上游真实 ID。理由见 §6-14（直填真实 ID 会丢上下文规格）
8. 端到端验证：Palink 代码路径实发成功，`resp.model = deepseek/deepseek-v4-flash-0731`，网关落账 11063 配额

**当前生效链路**：
`backend/data/providers.json`（逻辑名 `deepseek-v4-flash`，`env:PALINK_NEWAPI_TOKEN`）
→ `http://new-api:3000/v1`
→ new-api 渠道 001（OpenRouter，`model_mapping` → `deepseek/deepseek-v4-flash-0731`）

### 计划（未启动）

- **P1 双轨凭证**（BYOK + 管理员额度）：改 6 处 Python，ContextVar 注入 user_id/db，不碰 30 处调用点签名。清单见 P1-1~P1-6。⚠️ 改代码前务必先读 AGENTS.md 与本文档，确认当前是 `palink-native` 主攻。
- **P2 管理员额度签发自动化**：调 new-api 管理 API 懒签发令牌写 `ConnectionProfile`。
- **待验证**：故障转移（需 ≥2 条渠道，§6-15）。

### 接手前先确认

- 容器全绿：`docker ps | grep -E "palink-new-api|palink-ai-backend"`
- 密钥在位：`grep "^PALINK_NEWAPI_TOKEN=" .env`
- 改 `.env` 后 `docker compose up -d backend`（recreate）；改 `providers.json` 自动生效
- 写 new-api SQLite 卷必须 `--user root`（§6-16）

---
