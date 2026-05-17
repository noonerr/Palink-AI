# Palink AI 代码审查报告 - 高风险问题

> 审查日期: 2026-05-07
> 审查范围: 全项目后端、前端、Docker/Nginx 配置
> 以下为风险较高、暂未修复的问题，需评估后再决定修复方案

---

## 一、安全漏洞 (高风险)

### S-01. SSRF - web_search.py 自定义 URL 无限制

- **文件**: `backend/app/services/web_search.py` 第 71-80 行
- **风险**: 用户可通过配置 `custom_url` 让服务器发起请求到任意内网地址（如 `http://169.254.169.254` 获取云元数据、`http://localhost:xxxx` 扫描内网端口）
- **影响**: 内网信息泄露、端口扫描、云环境元数据窃取
- **建议修复**: 对 `custom_url` 进行 URL 白名单/黑名单校验，禁止访问私有 IP 地址段（参考 `utils.py` 中 `_is_public_http_url` 的实现）

### S-02. 授权绕过 - plotline.py 会话关联接口未验证会话归属

- **文件**: `backend/app/api/plotline.py` 第 258-370 行
- **风险**: `associate_plot_line`、`remove_plot_line`、`get_plot_line_status`、`transition_stage` 四个接口只验证了 PlotLine 归属当前用户，但未验证 `session_id` 是否属于当前用户
- **影响**: 攻击者可将 PlotLine 关联到其他用户的会话，或操纵其他用户的剧情阶段
- **建议修复**: 在每个接口中添加 `session_id` 归属校验，查询 `CharacterChatSession` 确认 `user_id == current_user.id`

### S-03. API Key 明文存储 - provider_registry.py

- **文件**: `backend/app/services/provider_registry.py` 第 73-90 行
- **风险**: `providers.json` 文件中存储的 API Key 是明文的，如果文件被泄露（如备份、日志），所有密钥将暴露
- **影响**: 密钥泄露导致第三方服务被未授权使用
- **建议修复**: 强制所有 API Key 使用 `env:VAR_NAME` 格式，在非开发模式下拒绝明文密钥（当前 `admin.py` 已有部分校验，但 `resolve_secret_reference` 仍返回明文）

---

## 二、Bug / 逻辑错误 (中高风险)

### B-01. 语义搜索全量加载性能问题 - storage.py

- **文件**: `backend/app/memory_module/storage.py` 第 304-408 行
- **风险**: `semantic_search` 方法从数据库加载最多 200 条记录，然后在 Python 中逐一计算余弦相似度
- **影响**: 随着数据量增长，性能急剧下降；每次搜索需要反序列化 200 条 embedding JSON
- **建议修复**: 使用 pgvector 等数据库原生向量搜索，或至少使用 numpy 批量计算替代逐条计算

### B-02. Embedding 异步更新 fire-and-forget 无重试

- **文件**: `backend/app/memory_module/storage.py` 第 254-258 行
- **风险**: `store` 方法通过 `loop.create_task` 触发异步 embedding 更新，如果任务失败，记忆条目的 embedding 将永远为 NULL
- **影响**: 记忆条目无法被语义搜索检索到，导致"丢失"记忆
- **建议修复**: 添加重试机制，或在后续 `semantic_search` 时检测 NULL embedding 并触发重新计算

### B-03. SQLite 用户画像更新非原子操作

- **文件**: `backend/app/memory_module/storage.py` 第 573-597 行
- **风险**: 使用 try-INSERT/catch-UPDATE 模式，在并发场景下可能导致竞态条件
- **影响**: 数据覆盖或更新丢失
- **建议修复**: 使用 `INSERT ... ON CONFLICT UPDATE` (UPSERT) 语句

### B-04. 推理队列信号量与活跃计数不一致

- **文件**: `backend/app/services/inference_queue.py` 第 176 行
- **风险**: 同时检查 `_semaphore.locked()` 和 `len(self._active) < self._max_concurrent`，两个条件可能不一致
- **影响**: 请求可能被错误阻塞或跳过
- **建议修复**: 统一使用信号量或活跃计数作为并发控制手段，移除双重检查

### B-05. 全局环境变量污染 - embedder.py

- **文件**: `backend/app/memory_module/embedder.py` 第 154 行
- **风险**: `SentenceTransformerEmbedder` 设置全局 `os.environ["HF_ENDPOINT"]`
- **影响**: 影响整个进程中所有使用 HuggingFace 的代码
- **建议修复**: 在初始化前保存原始值，初始化后恢复；或使用 HuggingFace 库提供的配置方式

---

## 三、Docker / 基础设施 (高风险)

### D-01. 根目录 Dockerfile 以 root 用户运行

- **文件**: `Dockerfile` (根目录) 第 20-23 行
- **风险**: 使用 `FROM nginx:alpine` 后直接 `EXPOSE 80`，没有创建非 root 用户、没有 `USER` 指令
- **影响**: 容器被攻破后攻击者获得 root 权限
- **建议**: 统一使用 `frontend/Dockerfile`（已正确配置非 root 用户），废弃根目录 Dockerfile

### D-02. 根目录 Dockerfile 缺少安全头配置

- **文件**: `Dockerfile` (根目录) 第 22 行
- **风险**: 只复制了 `nginx.conf`，没有复制 `security-headers.conf`
- **影响**: 缺少 CSP、X-Frame-Options 等安全响应头
- **建议**: 同 D-01，统一使用 `frontend/Dockerfile`

### D-03. start-server.sh 中 chown 命令在非 root 用户下静默失败

- **文件**: `backend/start-server.sh` 第 318-323 行
- **风险**: Dockerfile 已切换到 `USER appuser`，但 `start-server.sh` 中执行 `chown -R appuser:appuser`，非 root 用户无法执行 chown
- **影响**: 如果卷挂载导致文件权限不正确，数据目录将无法被正确写入
- **建议**: 在 Dockerfile 的 root 阶段完成 chown，移除 start-server.sh 中的 chown 命令

### D-04. 管道执行远程脚本

- **文件**: `backend/Dockerfile` 第 62-63 行
- **风险**: `curl -fsSL https://deb.nodesource.com/setup_20.x | bash -` 将远程脚本直接管道到 bash 执行
- **影响**: 如果 nodesource.com 被入侵或遭受中间人攻击，攻击者可以在构建阶段执行任意代码
- **建议**: 先下载脚本、验证其完整性后再执行，或直接手动配置 NodeSource 仓库

---

## 四、Nginx 配置 (中风险)

### N-01. HSTS 头在纯 HTTP 下无效且有风险

- **文件**: `frontend/security-headers.conf` 第 6 行（已移除）
- **说明**: 已在本次修复中移除 `Strict-Transport-Security` 头，因为当前 Nginx 仅监听 HTTP。如果未来启用 HTTPS，需重新添加

### N-02. CSP 策略过于宽松 - unsafe-inline

- **文件**: `frontend/security-headers.conf` 第 5 行
- **风险**: `script-src 'self' 'unsafe-inline'` 中的 `unsafe-inline` 严重削弱了 CSP 的 XSS 防护能力
- **影响**: 攻击者可通过注入内联脚本执行任意代码
- **建议**: 使用 nonce 或 hash 替代 `unsafe-inline`（需要前端构建工具配合）

### N-03. CSP connect-src 允许任意 HTTPS 源

- **文件**: `frontend/security-headers.conf` 第 5 行
- **风险**: `connect-src 'self' https:` 允许前端向任意 HTTPS URL 发起请求
- **影响**: 可能导致数据泄露到攻击者控制的服务器
- **建议**: 限制为具体的 API 域名（需要确认所有外部 API 端点）

### N-04. Nginx 缺少请求速率限制

- **文件**: `frontend/nginx.conf`
- **风险**: 未配置 `limit_req_zone` 和 `limit_req` 指令
- **影响**: API 端点没有 Nginx 层面的速率限制，容易遭受暴力破解和 DDoS 攻击
- **建议**: 添加 Nginx 层面的速率限制作为第一道防线

---

## 五、性能问题 (中风险)

### P-01. 每次搜索请求创建新的 httpx 客户端

- **文件**: `backend/app/services/web_search.py` 多处
- **风险**: 每次搜索都 `async with httpx.AsyncClient()` 创建新客户端，建立新的 TCP 连接和 TLS 握手
- **建议**: 复用客户端实例以利用连接池

### P-02. 记忆检索同步阻塞事件循环

- **文件**: `backend/app/memory_module/retriever.py` 第 73 行
- **风险**: `embed_text` 是同步调用（可能涉及模型推理），在 async 上下文中直接调用会阻塞事件循环
- **建议**: 使用 `asyncio.to_thread()` 包装同步调用

### P-03. 缓存 LRU 实现效率低

- **文件**: `backend/app/memory_module/service.py` 第 219-247 行
- **风险**: 使用 `list.remove()` 实现 LRU，时间复杂度 O(n)
- **建议**: 使用 `OrderedDict` 替代

---

## 已修复问题清单

| # | 问题 | 文件 | 修复内容 |
|---|------|------|----------|
| 1 | 路径遍历边界检查 | `main.py` | `_safe_serve_upload` 添加 `os.sep` 边界检查 |
| 2 | Token 过期未显式检查 | `main.py` | `_verify_upload_access` 添加 exp 过期检查 |
| 3 | 空列表 SQL 错误 | `sessions.py` | `delete_session_memories` 添加空列表提前返回 |
| 4 | 批量删除无长度限制 | `sessions.py` | `BatchDeleteRequest.session_ids` 添加 `max_length=100` |
| 5 | AsyncOpenAI 资源泄漏 | `llm_client.py` | 使用 `asyncio.get_running_loop().create_task()` 正确关闭 |
| 6 | compression_ratio 无验证 | `memory.py` | 添加 `Field(ge=0.1, le=0.9)` 范围限制 |
| 7 | .dockerignore 未排除 .env | `backend/.dockerignore` | 添加 `.env` 和 `.env.*` 排除规则 |
| 8 | X-XSS-Protection 过时 | `security-headers.conf` | 更新为 `0`，移除 HSTS（纯 HTTP 下无效） |
| 9 | CSP 缺少 base-uri/form-action | `security-headers.conf` | 添加 `base-uri 'self'; form-action 'self';` |
| 10 | 参数名遮蔽内置函数 | `models.py` | `all` 参数改用 `Query(False)` |
| 11 | 上传无大小限制 | `worldbook.py`, `presets.py` | 添加 5MB 文件大小限制 |
| 12 | 工具执行错误信息泄露 | `inference_dispatcher.py` | 移除 `str(e)` 返回，改为通用错误消息 |
| 13 | 缓存键截断导致命中错误 | `memory_module/service.py` | 使用 SHA256 hash 替代截断 |
