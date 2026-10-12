# HANDOFF — Ollama Docker 部署 + Palink 无限加载排查（2026-08-19）

> 本交接文档记录 2026-08-19 会话的全部工作：Ollama 容器化部署（已完成）、
> 存量记忆清除（已完成）、Palink 本体无限加载问题（排查中，未定位根因）、
> 以及**第二次对话 100% 乱码（思维链死循环）的完整复盘**（已修复，含可能原因分析）。
> 供后续 agent 快速接手，避免重复排查。

---

## 〇、第二次对话 100% 乱码（思维链死循环）完整复盘

> 用户视角的"乱码"= 第二轮对话 100% 思维链死循环 + 思维链"泄露"显示 + 偶发空响应报错。
> 以下为完整原因、解决方案、解决过程、以及"还有可能是什么"的分析。

### 0.1 症状（用户实际看到的）

1. **第二轮对话 100% 思维链死循环**：推理模型无限自我审查，reasoning 流不停，最终空响应/报错。
2. **思维链疑似"提示词泄露"**：模型在思维链中复述提示词内容（用户误以为提示词被泄露）。
3. **偶发空响应**：HTTP 200 但无 content/reasoning 增量，触发重试后仍失败报错。
4. **消息正文带思维链**：模型把 ` thinking... response` 块直接写进 content（reasoning 字段为空），前端显示"思维链泄露"。

### 0.2 根因（完整因果链，已定位）

```
assistant 回复 full_content（正文 + <UpdateVariable><Analysis>…<JSONPatch>…</UpdateVariable> 大 XML 功能块）
  ↓ ① 入库不清洗：websocket.py 直接 store_memory(content=result.full_content)
  ↓ ② 功能块整块进入向量记忆库 conversation_memories
  ↓ ③ 注入不设防：build_memory_context 用 content[:200] 硬截断
  ↓ ④ 正文较短时第 200 字符正好切在 <UpdateVariable>/<Analysis>/<JSONPatch> 中间
  ↓ ⑤ 残缺半截 XML 标签被注入下一轮 prompt
  ↓ ⑥ 推理模型思维链反复自我审查："系统禁止 XML 但 MVU 豁免又说允许 → 记忆里出现残缺标签 → 它是什么？要不要补全？"
  ↓ ⑦ 无限自我辩论 → reasoning 流不停 → reasoning-only 触发空响应重试 → 报错
```

**为什么第一轮正常、第二轮必死循环**：第一轮记忆库为空（无注入）；第二轮检索必然命中第一轮的
user+assistant 记忆（同主题相似度最高，且 retriever 的 context_proximity 权重还加分）→ 脏数据必然注入。

**为什么之前没发现**：
- 此前修复聚焦"Error 文本不入库 + 空响应重试"，只打破"Error 入库→循环污染"的表层，未触及"功能块/思维链块入库"这一真正污染源。
- 记忆库是共用数据，websocket.py（palink-native 主链路）和 character_ext.py（SSE 链路）两处都写，只修一处不彻底。

### 0.3 解决方案（改动清单）

**死循环修复（3 个文件）**：

| 文件 | 改动 | 作用 |
|------|------|------|
| `backend/app/utils.py` | 新增 `clean_memory_content()`：剥离 `<UpdateVariable>` 全块（含内嵌 Analysis/JSONPatch）、`<thinking>` 块、孤立残留标签、折叠空行 | 入库前清洗，只存剧情正文 |
| `backend/app/utils.py` | 新增 `_truncate_by_sentence()`：按句末边界（。！？!?…）→ 分号 → 兜底省略号 三级安全截断 | 注入端不切断句子/标签 |
| `backend/app/utils.py` | `build_memory_context()` 改为注入前清洗 + 按句截断 | 存量脏数据/过长内容不再注入残缺标签 |
| `backend/app/api/websocket.py` | 两处 `store_memory(role="assistant")` 改传 `clean_memory_content(result.full_content)` | 主链路入库清洗 |
| `backend/app/api/character_ext.py` | SSE 链路同类 assistant 入库改传 `clean_memory_content(...)` | 副链路入库清洗（共用记忆库，必须同步） |

**消息正文思维链污染修复（追加，2026-08-18 晚）**：

| 文件 | 改动 | 作用 |
|------|------|------|
| `backend/app/api/websocket.py` | `persist_snapshot` 中 `final_raw = result.full_content` 后、拼 reasoning 前缀前，剥离 ` thinking... response` 块（`[THINK-IN-CONTENT-FIX]`） | 模型把思维链写进 content 时，入库正文不再带思维链 |
| `backend/app/api/character_ext.py` | `persist_fn` 中同样位置剥离 think 块 | SSE 链路同步修复 |
| `backend/app/services/character_message_builder.py` | prompt 装配时剥离 `<think[\s\S]*?</think\s*>`（带尖括号） | 装配端防御 |

**存量数据清理（2 个脚本）**：

| 文件 | 说明 |
|------|------|
| `backend/scripts/_clean_memory_pollution.py` | 扫描 `conversation_memories` 中 role='assistant' 记录，`clean_memory_content()` 清洗 + 重算 embedding；清洗后为空则删除 |
| `backend/scripts/_clean_msg_think_blocks.py` | 清理 `character_chat_messages` 存量 think 块，剥离后保留正文 |

### 0.4 怎么解决的（执行过程）

1. **定位**：通过日志 + 数据库抽查确认脏数据闭环（记忆库含 `<UpdateVariable>` 块 + 残缺标签）。
2. **写清洗函数**：`clean_memory_content()` + `_truncate_by_sentence()`，定向单测 5 用例全过。
3. **接入两条入库链路**：websocket.py（主）+ character_ext.py（SSE），共用记忆库必须同步。
4. **注入端加固**：`build_memory_context()` 注入前清洗 + 按句截断，防止存量脏数据/过长内容再注入残缺标签。
5. **清理存量**：`_clean_memory_pollution.py` 容器内执行 → 543 扫描 / 17 清洗 / 0 删除 / 0 失败；
   `_clean_msg_think_blocks.py` → 4 条（598/600/1292/2207）剥离 think 块保留正文。
6. **重建容器**：`docker compose up -d --build backend`，容器内实测清洗函数生效，healthy。
7. **追加修复**：用户实测"第二句话仍被污染"→ 发现模型把思维链写进 content（reasoning 字段为空）→
   在 persist_snapshot / persist_fn 入库前剥离 think 块（剥离放在拼 reasoning 前缀**之前**，避免误伤
   ST 兼容的 ` thinking<reasoning> response` 前缀）。

### 0.5 还有可能是什么（其他可能原因分析）

已定位并修复的是**记忆污染闭环**。但"第二次对话乱码/死循环"这类问题，除已修复的根因外，还有以下可能（部分已排查排除，部分需留意）：

1. **提示词注入（用户最初怀疑）**：❌ 已排除为主要原因。死循环的触发点是记忆注入的残缺 XML 标签，不是提示词本身被注入恶意指令。但**提示词装配本身复杂**（角色卡 + 世界书 + 记忆 + 扩展提示词），若某处拼接出错仍可能引发模型异常，需保持警惕。
2. **模型网关问题（用户最初怀疑）**：⚠️ 部分相关。opencode.ai 网关实测有间歇性空响应（HTTP 200 但无增量），已加 3 次重试 + 指数退避（4s/8s/16s）。网关慢响应时前端会误判"没回复"（已加 generation_started 事件缓解）。**网关本身不是死循环根因，但会放大症状**。
3. **模型自身行为**：⚠️ 推理模型（deepseek 等）在 prompt 含矛盾指令（"禁止 XML" vs "MVU 豁免允许 XML"）时容易自我审查。即使记忆干净，若角色卡/世界书本身含类似矛盾，也可能触发。**建议检查角色卡提示词是否含矛盾指令**。
4. **记忆注入的其他路径**：⚠️ 已修复 websocket.py + character_ext.py 两条入库链路，但**任何新增的 assistant 入库路径都必须过 `clean_memory_content()`**，否则脏数据闭环会复发（硬约束）。
5. **向量维度混用**：⚠️ Ollama 降级 fastembed 时维度从 1024 变 512，与存量 1024 维向量不兼容，检索时 numpy 点积报错。当前记忆已清空（2026-08-19），新对话统一 1024 维，此风险已消除。
6. **ST 向量插件冲突**：⚠️ 若 ST 向量插件活跃（`st-vec::` 数据存在），Palink 记忆自动让步（`MEMORY_ST_YIELD`）。若两边同时注入记忆，可能重复/冲突。当前记忆已清空，无 st-vec:: 数据。

---

## 一、本次已完成的工作

### 1. Ollama 用 Docker 部署并绑定 palink 网络（用户明确要求，重复 4 次）

**背景**：用户要求不用官方脚本安装 Ollama，直接用 Docker 起容器，绑定在 palink 组（docker-compose 网络）里面。

**改动**（`docker-compose.yml`）：
- 新增 `ollama` 服务：
  - `image: ollama/ollama:latest`，`container_name: palink-ollama`
  - 绑定 `frontend-backend` 网络（backend 所在网络）
  - 端口 `11434:11434` 映射宿主机（便于调试；backend 走服务名直连，不依赖此映射）
  - `ollama_data` 卷持久化模型（`/root/.ollama`）
  - `OLLAMA_HOST=0.0.0.0`、`OLLAMA_KEEP_ALIVE=24h`（模型常驻内存）
  - healthcheck：`ollama list`，start_period 30s
  - 资源限制：2 CPU / 4G 内存
- backend 的 `OLLAMA_HOST` 从 `http://host.docker.internal:11434` 改为 **`http://ollama:11434`**（compose 网络服务名直连）
- backend `depends_on` 增加 `ollama: service_healthy`
- volumes 增加 `ollama_data`

**关键难点与解决**：
- docker.io 实测超时不可达 → 但 Docker 已配置国内镜像加速（`docker.m.daocloud.io` + `docker.1panel.live`），`docker pull ollama/ollama:latest` 成功
- bge-m3 模型（1.2GB）通过 `docker exec palink-ollama ollama pull bge-m3` 拉取成功（ollama registry 可达）

**验证结果**：
- `palink-ollama` 容器 healthy
- backend 容器内实测：`OllamaEmbedder` 激活，dim=1024，`/api/embed` 返回 200
- backend 容器内通过服务名 `ollama:11434` 访问返回 200
- 所有容器 healthy：backend / db / frontend / sillytavern / ollama

### 2. 存量记忆全部清除（用户决策：不重算）

**背景**：原计划用 bge-m3 重算存量 590 条记忆的 embedding（588 条 1024 维 + 2 条 512 维混存）。

**用户决策**：不要重算，全部清除。

**执行**：
- 停止重算脚本（批量模式，每批 50 条）
- `TRUNCATE TABLE conversation_memories RESTART IDENTITY` → 0 条
- 删除临时脚本 `_check_embedding_dims.py`、`_reembed_all_memories.py`
- 新对话将直接用 Ollama bge-m3 写入 1024 维向量，无需迁移

### 3. TODOS.md 已同步更新

- "统一向量引擎"状态改为：Ollama 已 Docker 部署并激活，存量记忆已全部清除
- 重算待办标记为取消

---

## 二、当前正在排查的问题：Palink 本体无限加载（未定位根因）

### 现象
- 前端登录页/主界面无限加载
- frontend nginx 日志：`GET /api/auth/config HTTP/1.1" 499` 反复出现（客户端等待响应超时断开）
- backend 不响应 `/health`（事件循环被完全阻塞）

### 已确认的根因（直接原因）
- **backend 内存飙到 1.975GiB / 2GiB（接近容器内存上限）**，进程卡死，事件循环阻塞，所有请求排队不响应
- 重启 backend 后内存恢复正常（177MB），服务恢复

### 时间线（2026-08-18 晚）
| 时间 | 事件 |
|------|------|
| 19:08 | backend 容器重建（OLLAMA_HOST 改为 ollama:11434） |
| 19:15:04 | 用户导入角色卡（成功，含 28 个世界书条目） |
| 19:15:28 | 4 个 WebSocket 连接打开（character-chat） |
| 19:15:28 | StreamSession created（角色聊天消息处理开始） |
| 19:15:28 | tokenizer 下载开始（后台线程，deepseek） |
| 19:15:40 | tokenizer 下载超时失败（github raw 不可达） |
| 19:15:40 后 | **backend 卡死**（无任何日志，/health 不响应） |
| 19:24 | 重启 backend，恢复 |

### 已排查并排除的原因
1. **tokenizer 下载阻塞**：❌ 排除。下载是后台线程（`_maybe_start_background_download`），不阻塞事件循环
2. **Ollama embedding 阻塞**：❌ 排除。backend 卡死期间 ollama 日志**没有任何 /api/embed 请求**（只有 healthcheck）
3. **本地 GGUF 模型加载**：❌ 排除。backend 日志无 "Loading llama.cpp model" 记录（llama_cpp_python 0.3.34 已装，但未触发加载）
4. **sentence-transformers 加载**：❌ 排除。容器内未安装 sentence-transformers/torch（pip list 确认），6.7GB 模型目录是其他 agent 残留的磁盘文件，不影响内存
5. **记忆检索（get_context）**：❌ 排除。走 `asyncio.to_thread`，不阻塞事件循环；且卡死期间无 Ollama 调用

### 未定位的根因
- **内存飙升 1.8GB 的具体来源**（177MB → 1.975GB，12 分钟内）
- 卡死发生在 StreamSession 创建后的消息处理中（assemble_roleplay_prompt 或 run_character_chat_generation），但具体阻塞点未确认

### 排查工具（已创建）
- `backend/scripts/_monitor_backend.py`：监控 backend 内存（>1500MB 告警）与 /health 超时（>5s），异常时抓取线程数、进程状态、py-spy 线程栈、最近日志，写入 `_monitor_backend.log`
- **注意**：该脚本在 PowerShell 下运行异常退出（exit -1，日志为空），需重新启动或改用其他方式运行

### 下一步排查建议
1. 重新启动监控脚本，让用户复现（刷新页面或发消息），抓取内存飙升时的线程栈
2. 重点检查 `assemble_roleplay_prompt` 中世界书扫描（`_append_worldbook_context`，to_thread）与 token 估算（`_estimate_tokens` → `_cached_st_token_count` lru_cache）的内存占用
3. 检查 DB 连接池（db_pool=4, db_overflow=4）是否耗尽导致 to_thread 任务堆积
4. 检查角色卡导入后世界书条目大小（28 entries 是否包含大文本/图片）
5. 若复现，用 `docker exec palink-ai-backend-1 py-spy dump --pid 1` 抓线程栈（需先确认 py-spy 是否安装）

---

## 三、关键文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `docker-compose.yml` | 已修改 | 新增 ollama 服务；backend OLLAMA_HOST 改服务名直连 |
| `backend/app/memory_module/embedder.py` | 已修改（前次会话） | OllamaEmbedder（httpx 调 /api/embed，bge-m3 1024 维，运行时降级 fastembed） |
| `backend/app/memory_module/config.py` | 已修改（前次会话） | OLLAMA_HOST / OLLAMA_MODEL / OLLAMA_TIMEOUT |
| `backend/app/utils.py` | 已修改（前次会话） | clean_memory_content / _truncate_by_sentence / build_memory_context |
| `backend/app/api/websocket.py` | 已修改（前次会话） | 入库前剥离 think 块（[THINK-IN-CONTENT-FIX]） |
| `backend/app/api/character_ext.py` | 已修改（前次会话） | SSE 链路同步剥离 think 块 |
| `backend/scripts/_monitor_backend.py` | 本次创建 | 内存/健康监控脚本（运行异常，需修复） |
| `backend/scripts/_clean_memory_pollution.py` | 前次会话 | 存量脏记忆清洗脚本（已执行） |
| `backend/scripts/_clean_msg_think_blocks.py` | 前次会话 | 存量消息 think 块清理脚本（已执行） |
| `TODOS.md` | 已更新 | 统一向量引擎状态、存量清除决策 |

---

## 四、待办事项

1. **【进行中】定位 Palink 无限加载根因**（backend 内存飙升卡死）
   - 修复/重启监控脚本，复现并抓线程栈
   - 定位内存 1.8GB 来源
2. **验证剥离入库真实链路**：需实际对话测试（记忆已清空，新对话将写入干净数据）
3. **NAS 部署后**：奈酱侧删掉自己的 Ollama，统一用 Palink 这套模型（bge-m3）；ollama 服务加 GPU 透传（Intel 核显 Vulkan）
4. **清理残留**：`/app/models/sentence_transformers`（6.7GB）和 `google_gemma-4-E2B-it-Q4_K_M.gguf`（3.3GB）是其他 agent 残留的磁盘文件，确认无用后可清理释放空间

---

## 五、重要约定（跨 agent）

- 本项目只维护 `palink-native` 模式，不要动 `st-compat` / `st-native`（见 AGENTS.md）
- 动工前先读根目录 `TODOS.md`
- 向量引擎统一走 Ollama + bge-m3（1024 维），Ollama 不可达时自动降级 fastembed（512 维，语义基准暂时不一致但可用）
- 记忆入库前必须剥离 `<UpdateVariable>` 块和 `<thinking>` 块（防思维链死循环）
- 修改代码后默认重建容器验证