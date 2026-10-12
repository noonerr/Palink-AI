# 交接提示词：Palink-AI 模型网关（New API）接入项目

> 使用方式：把下方「给接手 Agent 的提示词」整段复制给新会话/新 Agent 即可。上面的背景说明是给你（用户）看的，可不贴。

---

## 给接手 Agent 的提示词（复制以下全文）

```
你是接手 Palink-AI 项目的开发 Agent。当前任务：模型网关接入的后续工作（已完成 P0，待推进 P1/P2，并补验故障转移）。

【必读前置文件】
1. 先读项目根目录 `SPEC_model_gateway_new_api.md`（权威进度源，含 §1 决策背景 / §4 任务清单 / §6 坑与红线 / §7 代码坐标 / §8 验收 / §9 接手总结）。
2. 再读 `AGENTS.md`（确认当前主攻 `palink-native` 模式，不要碰 st-compat / st-native 封存代码）。
3. 集群状态与密钥：见根目录 `.env` 与 `backend/data/providers.json`。

【当前已完成的进度（P0，2026-09-02 全部打通并验证）】
- 网关选型：New API（QuantumNous/new-api，Go 单容器，AGPL-3.0 原样部署不改源码）。它是外部 LLM 渠道层，OpenRouter 只是它的渠道之一。
- 双模式：网关可选。直连模式（默认，无新容器）／网关模式（`docker compose --profile gateway up -d` 启动 new-api）。Palink 代码零模式开关，靠 compose `profiles` + `depends_on.required:false` 实现。
- 已落地：compose 新增 new-api 服务、.env 注入变量、后台完成管理员初始化 + OpenRouter 渠道、建了令牌、providers.json 切换为网关条。
- 当前生效链路：
  backend/data/providers.json（模型逻辑名 `deepseek-v4-flash`，api_key=`env:PALINK_NEWAPI_TOKEN`）
  → http://new-api:3000/v1
  → new-api 渠道 001（OpenRouter，model_mapping 把 `deepseek-v4-flash` 映射成 `deepseek/deepseek-v4-flash-0731`）
- 端到端验证已通过：Palink 代码路径实发对话成功，网关落账，上下文规格 100 万正确命中。

【架构铁律——务必遵守】
- Palink 侧只写逻辑模型名（如 `deepseek-v4-flash`），模型 ID 映射交给网关的 model_mapping。不要直填上游真实 ID 到 providers.json（会让 model_specs.json 失配，上下文退化为 4096）。
- 推理入口 30 处调用点**禁止加 db/user_id 参数改调用链**。要注入用户身份用 ContextVar（见 P1）。

【必看的坑（§6 全文，最致命的三条）】
1. new-api 的 `tokens.key` 列存的是**不带 `sk-` 前缀**的 48 位串——它收到 `Bearer sk-XXX` 会剥离前缀再查库。直接 INSERT 写 `sk-` 前缀永远 record not found。
2. 管理端点（/api/channel/、/api/token/）要**会话 Cookie**，Bearer 只通 /v1/* relay 端点。用 Bearer 调管理端 401 是正常，验证令牌请调 /v1/models。
3. INITIAL_ROOT_TOKEN 仅在"系统未初始化且无 root 用户"时生效；用户 Web 自建的 admin 跟它非同一身份。
4. 改 new-api 的 SQLite 卷（palink-ai_newapi_data，文件 /data/one-api.db）必须 `docker run --user root`；group 是保留字要加引号。
5. tokens 表改完立即生效（懒加载）；abilities 表改完必须重启容器。
6. 改 .env 后 `docker compose up -d backend`（recreate，restart 不重读 env_file）；改 providers.json 按 mtime 自动生效。

【下一步选项（按优先级）】
- 选项 A（建议先做的验证）：在后台再加 1 条渠道（DeepSeek 官方/硅基流动/火山方舟），然后把渠道 A 的 status 改成 2（禁用）验证请求仍成功，确认故障转移生效。这是 P0 唯一未验证项。
- 选项 B：P1 双轨凭证（BYOK + 管理员额度）—— 改 6 处 Python：新增 request_identity.py（ContextVar）、dependencies.py 注入点、inference_dispatcher.py 两处 client 构建前覆盖凭证、llm_client.py 缓存键改造、ConnectionProfile.provider 枚举加 palink 值、补测试。完整清单见 SPEC §4 P1-1~P1-6。
- 选项 C：P2 管理员额度签发自动化（调 new-api 管理 API 懒签发令牌写 ConnectionProfile + 后台 UI）。

【接手第一步】
执行 `docker ps | grep -E "palink-new-api|palink-ai-backend"` 确认容器健康，再 `grep "^PALINK_NEWAPI_TOKEN=" .env` 确认密钥在位，然后回到 SPEC 看具体任务清单，从用户指定的下一步开始。不要重复初始化或重建渠道——它们已经在工作了。
```

---

## 给你（用户）的备注

- 这份提示词是**自包含**的，新 agent 不需要你补充背景，复制即能用。
- 它刻意**不内联任何密钥明文**——接手 agent 自己读 `.env` 和 new-api 数据库即可，避免密钥泄露在聊天记录里。
- 配套权威文档是 `SPEC_model_gateway_new_api.md`（会随进度持续更新勾选）；本文件只在交接时复制使用，不要求长期维护。
- 如果接手 agent 要改代码（P1），务必让它先读 `AGENTS.md` 确认 `palink-native` 主攻立场。
