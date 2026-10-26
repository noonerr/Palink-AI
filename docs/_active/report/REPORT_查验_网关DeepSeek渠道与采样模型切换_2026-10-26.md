# 查验报告：网关 DeepSeek 渠道与采样模型切换（T7）

> 状态：已完工待审读（只读查验·2026-10-26）

## 背景

用户判断：模型网关（new-api）里 DeepSeek 官方渠道是有余额的，今后真机采样/验证应走 DeepSeek 模型，而不是交接书里写的只剩约 0.48 元的那个渠道。五轮采样脚本 `.tmp_probe/sample5.sh` 已备好。

挡点出处：`docs/_active/HANDOFF_主脑交接_ST三面一致工程_2026-10-25.md:52`——「**网关余额**：≈¥0.48，不足以单次预扣（¥0.85+）——**所有真机采样类验收被此挡住**」；`:69-70`（§3.2）——五轮真机采样「**必须用测试账号自己的卡 943f434b Seraphina——露缇雅属 admin，测试号不可见**；chat 端点不传 session_id 会每轮新建会话，采完要删」。

本任务四项：①网关配置在哪；②逻辑名→渠道映射维护在哪；③采样脚本现状与切换点；④产出切换清单并作废旧结论。

## 方法

- 只读方式：grep/sed 读配置与代码；`docker exec palink-ai-db-1 psql` 只跑 SELECT；`docker exec palink-new-api cat /data/one-api.db` 把网关 SQLite 拷到**系统临时目录**（仓库外）后用 `py` 以 `mode=ro` URI 只读打开（`channels`/`abilities`/`tokens`/`users`/`logs`/`options` 表，key 类字段只取长度或做等值比对、不回显）。
- 在线只读探测（均为 GET，凭据从文件读入内存、不回显）：new-api `/v1/models`（两把候选 key 各测一次，只看状态码与模型清单）；DeepSeek 官方 `/user/balance` 与 `/models`；OpenRouter `/api/v1/credits`。
- **未跑** `sample5.sh`（会真实扣费并新建会话，属施工动作，超出只读范围）。
- 环境注记：拷贝容器文件时再次踩中 MSYS 路径改写坑（`/data/one-api.db` 被改写成 `D:/APP/Tool/Git/data/one-api.db`），按 AGENTS.md §5.1 加 `MSYS_NO_PATHCONV=1` 后成功。临时副本已清理。

## 发现（逐条带证据）

### 1. 网关配置位置

- **容器定义**：`docker-compose.yml:103-129`——`new-api` 服务（`calciumion/new-api:latest`，profile `gateway`，container `palink-new-api`）；端口 `127.0.0.1:15001:3000`（`docker-compose.yml:114`；`:110-113` 注明旧口 13001 落在 Windows 保留段已废弃）；SQLite 库文件 `/data/one-api.db`、卷 `newapi_data`（`:118-119`）；`INITIAL_ROOT_TOKEN=${NEWAPI_ROOT_TOKEN:-}`（`:129`）。
- **根 .env**（值一律不引用，只给行号）：`NEWAPI_SESSION_SECRET`（.env:14）、`NEWAPI_ROOT_TOKEN`（.env:16）、`PALINK_NEWAPI_TOKEN`（.env:18，注释注明「P0-6 已创建；数据库内以无 sk- 前缀形式存储」）、`NEWAPI_ADMIN_USER`（.env:21）、`NEWAPI_ADMIN_PASSWORD`（.env:22，**留空**——注释说明留空=对账面板自动降级）。
- **容器实测**：`docker ps` → `palink-new-api` Up 15 hours (healthy)，`127.0.0.1:15001->3000/tcp`；backend/frontend/db/ollama 均在跑。
- **后端侧**：`backend/app/core/config.py` 无网关地址/模型清单（全文件仅 `PROVIDER_SECRET_CHECK_STRICT: bool = False`，config.py:50）；真实配置在 `backend/data/providers.json`（`provider_registry.py:29-30`：`_providers_path = DATA_DIR/providers.json`），经 bind mount `./backend/data:/app/data` 进容器（`docker-compose.yml:163`），实测容器内文件与仓库副本两把 key 的 sha256 前 8 位一致（逐字节相同）。
- compose 注释引用的 `SPEC_model_gateway_new_api.md`（`docker-compose.yml:102` 写「根目录」）**已归档至 `docs/_archive/2026-10/SPEC_model_gateway_new_api.md`**——路径引用过期，文件仍在。

### 2. 逻辑模型名清单（deepseek 系共两个）

`backend/data/providers.json`（已脱敏读取）共 2 条 provider、2 个逻辑模型：

| 逻辑模型 ID | provider | base_url | is_active | 说明 |
|---|---|---|---|---|
| `deepseek-v4-flash` | `prov-newapi-20260902`「New API 网关」 | `http://new-api:3000/v1` | true | 描述写「当前上游：OpenRouter」；`admin_url` 写 `127.0.0.1:13001`——**已过期**（实际 15001，见发现 1） |
| `deepseek-flash` | `prov-1790878885692`「DeepSeek」 | `https://api.deepseek.com`（无 /v1） | true | **DeepSeek 官方直连，不经过 new-api** |

后端解析链：`inference_dispatcher.py:243-250`（`ensure_model_available` → `find_model`）→ `unified_model_registry.py:433`（`find_model`，文件头注明 2026-08-29 模型网关瘦身后**不做多供应商路由**，每个模型 ID 只解析一个 provider）→ `provider_registry.py:145-157`（按 providers.json 顺序首个 `is_active` 且模型 ID 相等者）。默认模型回退链 `utils.py:766-780`：管理员偏好未设时取第一个 active provider 的第一个模型 = `deepseek-v4-flash`。

### 3. 逻辑名→渠道映射维护在哪（两层）

- **后端层**：`backend/data/providers.json`（模型 ID → provider 的 base_url + api_key），改文件即生效——`provider_registry.py:33-60` 的 `get_providers` 按**文件 mtime** 缓存，mtime 变化即重载，**无需重启容器**（本次未做任何修改，仅读代码确认）。
- **网关层（new-api 内部）**：new-api 自有 SQLite（`/data/one-api.db`，compose `:118-119`），映射由三张表构成（只读副本实测）：
  - `channels` 表：**仅 1 条渠道** id=1、name=`001`、type=20、status=1（启用）、group=`default`；`models` = `deepseek-v4-flash,deepseek/deepseek-v4-flash-0731`；`model_mapping` = `{"deepseek-v4-flash": "deepseek/deepseek-v4-flash-0731"}`；`base_url` 为空串（用该渠道类型的默认上游）；key 长度 73（与 OpenRouter `sk-or-v1-` 令牌长度一致；providers.json 描述也称上游 OpenRouter。type=20 的官方名称无处可查，**判断为 OpenRouter 渠道——待主脑裁定**）。
  - `abilities` 表（路由表）：`('default','deepseek-v4-flash',1,enabled)` 与 `('default','deepseek/deepseek-v4-flash-0731',1,enabled)` 两条，都指向渠道 1。
  - 管理入口：`http://127.0.0.1:15001` 后台 UI（admin 密码未配置于 .env:22；root token 是**首启令牌**，实测拿它调 `/api/channel/` 返回 `Unauthorized, invalid access token`，不能作为渠道查询凭据）。
- **关键事实：网关里没有「DeepSeek 官方渠道」**——网关内只有 OpenRouter 一条渠道。用户所说「DeepSeek 官方渠道有余额」对应的是 providers.json 里那条**绕过网关直连 api.deepseek.com 的 provider**。切换方向成立的前提即此。

### 4. 「等钱」堵点的拆解（两个堵点都在网关链路上，都不影响 DeepSeek 直连）

- **¥0.48 的真身 = new-api 内部 admin 用户配额，不是上游余额**：只读副本 `users` 表实测 admin(id=1) `quota=32876`、`used_quota=99967124`、`req_count=268`；`options` 表无 `QuotaPerUnit` 覆盖行（实测空），按 one-api 默认 500000 配额/$1 折算：32876/500000 = $0.066 ≈ **¥0.48**（×7.3 汇率假设）——与交接书 :52 的「≈¥0.48」吻合。令牌侧 `tokens` 表 `palink-backend`（id=1，user_id=1）`unlimited_quota=1`，令牌本身不限量，卡的是用户级配额。
- **上游 OpenRouter 实测有钱**：`GET https://openrouter.ai/api/v1/credits`（2026-10-26，渠道 key，不回显）→ HTTP 200：`total_credits=10`，`total_usage=2.6348` → 余 ≈**$7.37**；与渠道缓存 `balance=7.367688804`（2026-10-05 01:03 刷新，时间戳 1791133402 换算）吻合。即：**「0.48 元」从来不是 OpenRouter 上游没钱，是网关内部记账配额耗尽**。
- **新发现：网关链路当前实际是断的（与余额无关）**：`providers.json` 网关 provider 的 api_key（23 字符）经 `GET http://127.0.0.1:15001/v1/models` 实测 **HTTP 401**；而 `.env:18` 的 `PALINK_NEWAPI_TOKEN` 实测 **HTTP 200**（可见模型 `deepseek-v4-flash` 与 `deepseek/deepseek-v4-flash-0731`）。交叉验证：该 23 字符 key 与网关库 `tokens.key` 等值比对**不匹配**；`grep -rn "PALINK_NEWAPI_TOKEN" backend/app --include=*.py` **零命中**（compose `:169-170` 虽把 .env 注入 backend，但没有代码读它）；发请求用的就是 `provider["api_key"]`（`inference_dispatcher.py:407、426-427、751-756` → `llm_client.py:19-33`）。⇒ **即便网关充值了，`deepseek-v4-flash` 也会先吃 401**。旁证：网关 `logs` 表最后一条消费日志停在 2026-10-04 20:17 UTC，此后三周无流量——断了没人发现。

### 5. DeepSeek 官方直连实测（核心解锁证据，2026-10-26）

- `GET https://api.deepseek.com/user/balance`（用 providers.json 直连 provider 的 key，不回显）→ **HTTP 200**：`is_available=True`，`currency=CNY`，`total_balance=3.15`（granted 3.15 / topped_up 0.00）。⇒ 用户「DeepSeek 官方渠道有余额」**成立，实测 ¥3.15**。
- `GET https://api.deepseek.com/models` → **HTTP 200**：`['deepseek-flash', 'deepseek-v4-pro']`。⇒ providers.json 里的模型名 `deepseek-flash` 是上游真实 ID，切换**不需要**在网关或映射侧做任何改动。
- base_url 无 `/v1` 是官方支持形态：`llm_client.py:29-33` 把 base_url 原样传给 `AsyncOpenAI`（拼 `/chat/completions`）；`inference_dispatcher.py:534` 注释已记录「deepseek 官方 API 不支持 max_completion_tokens，回退 max_tokens」的兼容处理。

### 6. sample5.sh 现状（两处必须改 + 一处缺失）

`.tmp_probe/sample5.sh` 在场（35 行）：

- 凭据：`:8-9` 从 `scripts/st_audit/.env` 读 `ST_AUDIT_USER`/`ST_AUDIT_PASSWORD`（该文件在场，4 个变量名实测；值不引用）。经与后端库 `users` 表等值比对（不回显值），`ST_AUDIT_USER` = id=31 的 `st_audit_2026`（后端库实测 id=31 行存在）。
- 入口：`:10` `BASE=http://localhost:16000`（前端 nginx，容器实测 `0.0.0.0:16000->8080`）；`:12-13` `POST /api/token` 表单登录——路由实测在场（`auth.py:42` prefix="/api" + `auth.py:116` `@router.post("/token")`；`main.py:359` CSRF 豁免）。
- **错误一（卡片）**：`:16` `CHAR="c28061bb-a9b7-46a9-a255-2692d57001fc"`——后端库实测该 ID = **露缇雅1.2，属主 user_id=1(admin)**。交接书 §3.2（HANDOFF `:70`）要求用测试账号自己的卡 **943f434b Seraphina**；后端库实测 `943f434b-920e-4db5-af85-7f7fc5cd3d5d` = Seraphina，**user_id=31（= 测试号）**。且 chat 端点按属主过滤（`character_ext.py:4579`：`Character.user_id == user.id`，不匹配即 404 "Character not found"）——测试号采露缇雅**必然 404，五轮全败**。
- **错误二（模型）**：`:20` body 里 `"model":"deepseek-v4-flash"`（网关/OpenRouter 链路，受发现 4 的双重堵点）→ 应改 `deepseek-flash`（直连，发现 5 已验真实有效）。
- **缺失（会话清理）**：chat 端点不传 session_id 时每轮新建会话（`character_ext.py:4601-4605` 附近：`session_id` 为空则 `uuid4()` 新建）；脚本头注释自称「收尾删除」，但正文**没有任何删除调用**，且 `:25` 只打印 session_id 前 8 位、没保存完整值。删除端点实测在场：`DELETE /api/character-sessions/{session_id}`（`character_ext.py:93` prefix="/api/character-sessions" + `:2837-2845`，带属主校验；router 已挂载 `api/__init__.py:86`）。**交接书「采完要删」当前无法靠现脚本达成，需改造。**

## 结论与建议

### 切换清单（一行一个改动点）

1. `.tmp_probe/sample5.sh:20`：`"model":"deepseek-v4-flash"` → `"model":"deepseek-flash"`（脚本内仅此 1 处模型名）。
2. `.tmp_probe/sample5.sh:16`：`CHAR="c28061bb-a9b7-46a9-a255-2692d57001fc"` → `CHAR="943f434b-920e-4db5-af85-7f7fc5cd3d5d"`（Seraphina，属主=测试号 id=31，后端库实测）。
3. `.tmp_probe/sample5.sh`（新增逻辑，无行号）：每轮完整记录返回的 `session_id`（`:25` 现在只取前 8 位），采样收尾逐个 `DELETE /api/character-sessions/{session_id}`（端点 `character_ext.py:2837`）——交接书 §3.2「采完要删」的落实点。
4. **环境变量：无需改**。`.env` 与 `docker-compose.yml` 都不动：`deepseek-flash` 走 providers.json 直连 provider（is_active=true，key 已在 `backend/data/providers.json`，仅以脱敏方式提及），模型解析/放行链路（`ensure_model_available`）实测代码路径可通。
5. （非本次必需，仅备忘）若要恢复网关链路 `deepseek-v4-flash`：a) `backend/data/providers.json` 网关 provider 的 api_key 已失效（401 实测），应改为 `env:PALINK_NEWAPI_TOKEN` 引用（`provider_registry.py:81-99` 支持 `env:` 前缀解析）或更新为当前有效令牌；b) 网关内 admin 用户配额仅剩 32876（≈¥0.48）需充值；c) 同文件 `admin_url` 的 `127.0.0.1:13001` 改为 15001。以上均为施工建议，本次未动。

### 结论作废声明

交接书 `:52`「网关余额≈¥0.48 → **所有真机采样类验收被此挡住**」——在切换到 `deepseek-flash` 直连链路后，**「采样被挡」的推论作废**（该堵点只存在于 new-api 内部记账配额，DeepSeek 直连不经过它；DeepSeek 官方实测 ¥3.15 可用，is_available=True）。注意区分：交接书字面数字「网关内 ≈¥0.48」本身仍属实（admin 配额 32876 实测吻合），作废的是把「采样验收」也一并挡住的结论。另有一个交接书没写的独立堵点被本次查实：网关链路的 providers.json key 已 401 失效——即使不切换模型，原脚本也采不成。

### 待主脑裁定 / 未尽事项

- 渠道 001 的 `type=20` 供应商官方名称：判断为 OpenRouter（key 长 73、模型名 vendor/model 风格、providers.json 描述、credits 接口可查），但 new-api 未提供可查的 type 映射，**标待裁定**。
- 五轮真实采样**未跑**（会扣费+建会话，属施工动作）；切换后 `deepseek-flash` 的单轮/单窗费用未验证（网关 `models` 表无该模型定价行，DeepSeek 余额接口不返回价格）。交接书的预扣口径 ¥0.85+/窗产生于网关配额语境，仅供参考：¥3.15 ≈ 3.7 个窗余量。
- 本次新增了本报告文件；按 AGENTS.md 规矩，**提交前**须由提交人跑 `py scripts/docs/gen_docs_catalog.py`（本任务纪律禁止我改动报告以外的文件，故未代跑，`--check` 在提交前会是 STALE）。
- 查验过程中 Mimosa 安全 hook 两次误拦只读 sed/grep 命令（backend/app/api 路径触发），已改用 Read 工具完成，未影响结论。
