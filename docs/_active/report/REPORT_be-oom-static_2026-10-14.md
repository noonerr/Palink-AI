# REPORT — backend OOM 静态排查（be-oom-static）

> 任务 slug: be-oom-static | 分支: be-oom-static（HEAD 0251b89 = 52d1755 + 他人 docs 1 条）
> 日期: 2026-10-14 | 性质: **只读静态分析，零生产代码改动**
> 对象: TODOS.md「[进行中] Palink 本体无限加载排查（backend 内存飙升卡死）」
> 交接单: docs/_archive/handoff/HANDOFF_Ollama部署与无限加载排查_2026-08-19.md

> ⚠️ **主控核验订正（2026-10-14 02:35）—— 不改写原文，仅补充实测事实**
>
> §3 的 S1【最可疑】列了两个档位，需要按**实际配置**区分，否则容易把"极端档"当主嫌：
>
> - 实测 `.env` 中**不存在** `MEMORY_EMBEDDING_PROVIDER`（`grep -i EMBED .env` 零命中）
>   ⇒ 走 `backend/app/memory_module/config.py:14` 默认值 `fastembed`，模型取 `:15` 默认
>   `BAAI/bge-small-zh-v1.5` ⇒ 兜底实际加载的是 **bge-small ONNX（约 91MB）**，**打不满 2GiB**。
> - 文中"极端档"（`SentenceTransformer("BAAI/bge-m3")` ≈2.27GB）**需要有人显式设置**
>   `MEMORY_EMBEDDING_PROVIDER=sentencetransformer` 才会触发。当晚 env 是否被改过，本次核验
>   **未取到**（容器当时未运行，`docker exec ... env` 无法执行）——待真机复现时补测。
> - ⚠️ **`bge-m3` 另有其人**：它是 **Ollama 容器**的模型（`config.py:19 OLLAMA_MODEL` 默认
>   `bge-m3`），跑在 `palink-ollama` 里，**不吃 backend 的内存**。别把两者混为一个。
>
> ⇒ **结论调整**：S1 的"进程内加载嵌入模型"这个**机制成立**，而且它顺带证伪了旧排查用
> "卡死期无 /api/embed 请求"排除 embedding 的理由（进程内兜底根本不发 Ollama 请求）——
> 这是本条排查最有价值的产出。但**默认配置下量级差一个数量级**，不足以单独解释 1.975GiB。
> ⇒ 真正的第一证据缺口仍是 **S3（`memory.stat` 未拆 anon/file）**：**复现时先做 S3 的拆分，
> 再决定要不要深挖 S1**，不要一上来就奔着 2.2GB 去。

## 结论摘要

**三个已证实的核心结论**（读码/grep 可复验，详见 §2）：

1. **`start_heartbeat()` 全仓无调用点 → StreamSession 清理是死代码**
   `backend/app/services/websocket_manager.py:351` 定义了 `start_heartbeat`
   （其内才启动清理循环 :368-369），但 `grep -rn "start_heartbeat" backend/`
   只有定义本身。⇒ `_start_cleanup`/`_cleanup_completed`（:414-444）从不执行，
   `stream_sessions` 字典只增不减（唯一 pop 在 :441）。这是一个**已证实的内存泄漏**，
   但每条会话只残留一份 full_content/full_reasoning（几十 KB），速度慢，
   **不足以解释 36 秒打到 1.975GiB**。

2. **tokenizer 重试风暴已证伪**
   `st_tokenizer_service.py:477-488` 有单飞守卫（`_download_started`），
   :429-445 有 600s 失败冷却（`_REMOTE_DL_RETRY_AFTER`）。下载失败后 10 分钟内
   不再重试，不存在「超时→疯狂重试→连接堆积」的路径。下载本身
   （:500-502 `resp.read()` + `gzip.decompress`）峰值约 2× 文件大小（~10MB），
   吃不满 2GB。

3. **`docker stats` 的 1.975GiB 含 page cache —— 旧排查有口径盲点**
   监控脚本 `backend/scripts/_monitor_backend.py:27-40` 读的是 `docker stats`，
   该数字 = cgroup memory.current（**匿名内存 + page cache + 内核内存**）；
   backend 容器是 2GiB 硬限（`docker-compose.yml:235`
   `memory: ${PALINK_BACKEND_MEMORY:-2G}`）。逼近上限时内核进入 direct reclaim
   → 全容器 syscall 变慢 → 事件循环阻塞、/health 无响应、无日志——
   与现象吻合。**「内存飙升」未必是 Python 进程分配，anon/file 分解是复现第一要务。**

（后续章节：§1 排查范围与方法 / §2 已证实证据链 / §3 六个可疑点 / §4 真伪分级 /
 §5 复现抓取方案 —— 逐节追加中。）

---

## §1 排查范围与方法

### 1.1 聚焦链路（时间线对齐）

```
19:08 backend 重建（OLLAMA_HOST 改服务名）
19:15:04 导入角色卡（PNG，含 28 个世界书条目）——成功返回
   └─ backend/app/api/character.py:607-650 POST /import
      → character_import_service.py:524-581 import_from_file
19:15:28 4 个 WS 连接打开 + StreamSession created + tokenizer 后台下载开始
   └─ backend/app/api/websocket.py:1542+ ws_character_chat
      → :2333 create_stream_session → _gen → assemble_roleplay_prompt
19:15:40 tokenizer 下载超时失败（github raw 不可达）
19:15:40 后 backend 卡死（无日志、/health 不响应）
19:24 重启恢复（内存回落到 177MB）
```

### 1.2 方法

- 纯静态：只读代码 + 全仓 grep 交叉验证（未启动 Docker、未真机复现）。
- 每个结论尽量锚定 `file:line`，可复现命令随文给出。
- 纪律：疑似不写成结论；旧交接单的「已排除」项只在其证据真正覆盖时才算排除
  （§4 有一条旧排除证据被修正）。

### 1.3 已通读的关键文件

| 文件 | 行数 | 关注点 |
|---|---|---|
| backend/app/api/websocket.py | 2396 | WS 入口、生成重试、记忆入库 |
| backend/app/services/websocket_manager.py | 467 | StreamSession/ChatRoom 生命周期 |
| backend/app/services/inference_dispatcher.py | 1072 | 网关流式调用、tool 轮次 |
| backend/app/services/inference_queue.py | 413 | 推理队列（有界，max=100） |
| backend/app/services/roleplay_prompt_assembly.py | 5965 | 装配主链、token 预算裁剪 |
| backend/app/services/worldbook_service.py | ~2250 | 世界书扫描/向量检索 |
| backend/app/services/character_message_builder.py | 680 | 消息组装（to_thread） |
| backend/app/api/character_ext.py | ~2300 | 卡内正则脚本应用 |
| backend/app/memory_module/{service,storage,embedder}.py | — | 记忆检索/入库/嵌入器 |
| backend/app/services/{st_tokenizer_service,tokenizer_service,token_counter_service}.py | — | 两套 tokenizer 子系统 |

---

## §2 三个已证实结论的详细证据

### F1 `start_heartbeat()` 无调用点 → 清理循环是死代码（已证实）

证据链：
- `backend/app/services/websocket_manager.py:351` `def start_heartbeat(self)` 定义；
  :368-369 其内才 `self._start_cleanup()`；:414-425 `_cleanup_loop`；
  :427-444 `_cleanup_completed`（`stream_sessions.pop` 的**唯一**出口，:441）。
- `grep -rn "start_heartbeat" backend/ --include=*.py` 输出**只有定义行本身**
  （2026-10-14 实测）。⇒ 心跳与清理循环在生产永不启动。
- `stream_sessions` 写入口：`create_stream_session` :209，按 session_id 覆盖式写入；
  断开连接只清 room（`websocket.py:129-143 _remove_conn_from_room`，
  :2395-2397 finally），**不动 stream_sessions**。

后果（确切表述）：每个聊过天的 session 在进程内永久残留一个 StreamSession，
含 full_content + full_reasoning（长回复可达数十 KB）+ subscribers + generation_task。
量级估算：1.8GB 需约 2-4 万条会话 ⇒ **这是慢漏，不是 36 秒卡死的凶手**，
但它会持续推高基线内存，且「泄漏存在」本身已被证实。
另注：`_ping_all`（:380-409，含 missed_pongs 逐出）同样从未运行，
死连接只能靠 WS 自身 receive 超时（300s，`websocket.py:1561`）回收。

### F2 tokenizer 下载无重试风暴（已证实）

`backend/app/services/st_tokenizer_service.py`：
- :477-488 `_maybe_start_background_download`：`_download_started` 单飞守卫，
  下载中重复调用直接返回，不会起第二个线程。
- :429-445 `_REMOTE_DL_RETRY_AFTER = 600`：失败后写入时间戳，冷却期内
  `_remote_download_failed()` 恒真，:467-468 直接返回 None。
- :491-524 worker：`urllib.request.urlopen(url, timeout=10)`，
  :501 `resp.read()` 整读 + :502 `gzip.decompress`；deepseek.json.gz 数 MB，
  峰值约 2× 文件大小（~10MB 量级）。失败 finally 解除单飞标记（:522-524）。
⇒ 结论：19:15:40 的「下载超时」是一次性事件，之后 10 分钟静默；
既不阻塞事件循环（守护线程），也不会因重试堆积内存。

### F3 docker stats 口径含 page cache（已证实）

- `backend/scripts/_monitor_backend.py:27-40 get_mem_mb()` 解析
  `docker stats --format {{.MemUsage}}`，格式 `1.975GiB / 2GiB`。
  docker stats 的 MemUsage = cgroup `memory.current` = **anon + file(page cache)
  + slab + sock + kernel stack**。
- `docker-compose.yml:235`：backend `limits.memory: ${PALINK_BACKEND_MEMORY:-2G}`
  是 cgroup v2 硬限。usage 逼近上限时内核 direct reclaim， reclaimed 跟不上就整体
   stall：表现为事件循环不转、/health 无响应、无任何日志——与交接单现象吻合。
- ⇒ 「1.975GiB」这个数字**没有区分**「Python 分配了 1.9GB」和「读了 1.9GB 文件」
  两种完全不同的成因。复现第一件事是拆 anon/file（见 §5）。

---

## §3 可疑点清单（按可疑度排序）

每条格式：位置 / 为什么吃内存（或卡死）/ 怎么验证 / 当前判定。

### S1【最可疑】嵌入模型进程内加载（fastembed ONNX，极端情况 bge-m3 ≈2.2GB）

位置：
- `backend/app/memory_module/embedder.py:242-258` `OllamaEmbedder._get_fallback()`
  惰性创建 `FastEmbedEmbedder`（:108-127 `TextEmbedding(...)` 进程内加载 ONNX）。
- 触发点：装配期检索 `roleplay_prompt_assembly.py:5806 mem_svc.get_context`
  （→ `service.py:221 asyncio.to_thread(retriever.retrieve)` → embed）；
  生成后入库 `websocket.py:1248 store_memory` → `storage.py:678 create_task`
  → :874 `asyncio.to_thread(embed_text, content)`。
- 极端档：`embedder.py:325-329` `SentenceTransformerEmbedder` —— 若
  `MEMORY_EMBEDDING_PROVIDER=sentencetransformer`，`SentenceTransformer("BAAI/bge-m3")`
  权重约 2.27GB，**一个模型正好打满 2GiB 容器限**。

为什么吃内存：BAAI/bge-m3 fp32 ≈2.2GB / bge-small ONNX 91MB 文件 + ONNX Runtime
运行时，加载即常驻。08-19 当晚 19:08 刚重建 backend（OLLAMA_HOST 变更），
19:15:28 首条消息触发 3 次嵌入（1 检索 + 2 入库）；若此刻 ollama 不可达，
**每一次都走进程内兜底且模型只加载一次、常驻不释放**（`_fallback` 缓存 :243）。

怎么验证：复现时对比 embed 前后 `VmRSS`/`memory.stat`；查容器 env
`docker exec palink-ai-backend-1 env | grep -E "MEMORY_|OLLAMA_"`；
看 backend 日志有无 `Ollama 嵌入失败，降级 fastembed`（embedder.py:283）。
判定：**疑似**（机制成立、时间线吻合，缺当晚 env 实测值）。

### S2 卡内正则脚本在主事件循环同步执行（ReDoS / GIL 封锁）

位置：`roleplay_prompt_assembly.py:4352` `deps.apply_prompt_regex_to_messages(...)`
（默认开启，:436 `include_prompt_regex: bool = True`）——**不在 to_thread 里**
（对比 worldbook :4019、消息组装 :4219 都进了线程池）。
落到 `character_ext.py:1647+ _apply_prompt_regex_to_messages` → :1234
`re.sub(pattern, replacer, text)`，pattern 来自卡 `extensions.regex_scripts`
（19:15:04 新导入的卡！脚本上限 100 条 :1271）。

为什么卡死：用户可控正则 + 嵌套量词 → 灾难性回溯，单线程 100% CPU 持 GIL
⇒ 事件循环完全阻塞、无日志、/health 不应——与「无任何日志」现象吻合；
replacer 展开文本时还叠加内存膨胀。世界书侧同款调用在 :4937（to_thread 内，
只吃 CPU 不封锁循环）。

怎么验证：复现 `py-spy dump` 看栈是否停在 `_run_regex_script`/`re.sub`；
把该卡 regex_scripts 摘出来对等文本离线计时（几十秒不退 ≈ 实锤）。
判定：**疑似**（完美解释「阻塞无日志」，但纯回溯不吃 1.8GB；可与 S1 叠加）。

### S3 1.975GiB 的口径未拆 anon/file（最大证据缺口）

位置/证据：见 F3。复现前无法排除「读大文件把 page cache 顶到上限」路径。
已知可读大文件：`/app/models/fastembed` 91MB（S1）、tokenizer ~10MB（F2）、
以及交接单 §四.4 记录的**遗留 6.7GB sentence_transformers 目录 + 3.3GB GGUF**
（若复现时仍在且被读到，page cache 可瞬间顶穿 2GiB）。
怎么验证：见 §5 第 1 项（memory.stat 拆 anon/file + 每秒采样看曲线形状）。
判定：**疑似/待复现**（这是排查路径问题，不是代码缺陷结论）。

### S4 流式累积无上限 + `+=` O(n²) 拷贝（加剧因素）

位置：`websocket.py:1078-1080` `result.full_reasoning += reasoning` /
`result.full_content += content`（StreamResult 是普通属性，非局部变量，
**不享受 CPython 原位拼接优化**，每 chunk 全量拷贝）；`inference_dispatcher.py:935/979`
`assistant_content_parts.append(content)` 同样无上限。客户端 30s 超时
（dispatcher :762）是**读超时**而非总时长，网关涓流续流可让流永开。

为什么吃内存：模型/网关进入无限生成（08-18 当晚正是 reasoning 死循环事故，
交接单 §〇）时 full_content/full_reasoning 无上限增长；单流速率约需
~150MB/s 才能在 12s 内填满 1.8GB，**单流不可能这么快** ⇒ 它不是首因，
但一旦循环开始，`+=` 拷贝会同时烧 CPU（持 GIL）与内存，加速卡死。
怎么验证：复现时看 `[STREAM-CALL]` 日志后是否伴随 `EMPTY-RESP-RETRY`
（websocket.py:1094）与 usage 缺失；对网关响应计时。
判定：**疑似（加剧因素）**，速率测算表明不足以单独解释 36 秒。

### S5 两套 tokenizer 子系统的第二个下载源（HF from_pretrained）

位置：`token_counter_service.py:163-165` `Tokenizer.from_pretrained(
"hf:deepseek-ai/DeepSeek-V3")`，由 `quota_service.py:176-185
compute_deduct_tokens` 在**供应商未上报 usage 时**（生成结束后）调用；
失败有负缓存（:170-174）不会重试。另有 `tokenizer_service.py:17-20`
import 期 `tiktoken.get_encoding("cl100k_base")` 外网下载（~1.6MB）。
为什么列出来：它与 F2 是两条独立下载路径，旧交接单只提了前者；
复现时要确认当晚是否走到了 HF 下载（ Decide 了「tokenizer 下载超时」的确切身份）。
判定：**已证实存在该路径，是否事发未证实**（需复现/日志）。

### S6 StreamSession 累积泄漏（F1）与推理队列背压的交互

位置：`inference_queue.py:278-289` 满 100 抛 RuntimeError（有界，证实无害）；
`websocket_manager.py:433` 清理只收 `done/error` 且**要 subscribers 为空**——
一个卡在 "streaming" 的 session（生成任务丢失/未调度）即使清理循环活着也永不回收。
判定：**已证实结构缺陷**（慢漏）+ 一个理论死角；对本案贡献低。

---

## §4 真伪分级

### 4.1 已证实（静态可复验，非推测）

| # | 结论 | 证据 |
|---|---|---|
| A1 | `start_heartbeat()` 全仓无调用点，StreamSession 清理/心跳是死代码 | grep 仅命中定义；websocket_manager.py:351/368/414/441 |
| A2 | stream_sessions 只增不减（慢漏，每条会话残留一份 full_content） | 唯一 pop :441 不可达；写入 :209 无 TTL |
| A3 | tokenizer 下载无重试风暴：单飞守卫 + 600s 冷却，峰值 ~10MB | st_tokenizer_service.py:429/477/500-502 |
| A4 | docker stats 的 1.975GiB 含 page cache；backend 为 2GiB cgroup 硬限 | _monitor_backend.py:27-40；docker-compose.yml:235 |
| A5 | WS 连接层有界：room 断开即清、`_remove_conn_from_room` :129-143；4 连接无害 | websocket.py:1558-1596/2395-2397 |
| A6 | 装配三大重活（worldbook :4019、消息组装 :4219、记忆检索 service.py:221）均已 to_thread；prompt 正则 :4352 与大量 _estimate_tokens 仍在事件循环内同步跑 | 逐点读码 |
| A7 | 推理队列有 100 上限背压；LLM client LRU 有界 | inference_queue.py:278-289；llm_client.py:37-46 |
| A8 | 生成重试有界：3 次 × (30s 超时 + 4/8/16s 退避) ≈ 最坏 ~2 分钟 | websocket.py:1007-1107 |

### 4.2 疑似（机制成立/时间线吻合，但缺最后一步实证）

| # | 疑点 | 缺什么 |
|---|---|---|
| B1 | 嵌入模型进程内加载（fastembed；极端 bge-m3≈2.2GB 正好打满限额） | 当晚 `MEMORY_EMBEDDING_PROVIDER` 实配值 + 内存曲线的 anon/file 分解 |
| B2 | 卡内正则脚本在主循环同步执行（ReDoS/GIL 封锁） | py-spy 栈落在 `re.sub`/`_run_regex_script` 的实证 |
| B3 | 「1.975GiB」可能是 page cache 而非进程分配 | memory.stat 采样（S3） |
| B4 | 无限流式累积 + `+=` O(n²) 拷贝（速率测算不足以单独解释 36 秒） | 网关响应行为记录 |

### 4.3 查不到 / 需要复现（静态分析给不出答案）

| # | 问题 | 去哪查 |
|---|---|---|
| C1 | 08-19 当晚 .env/容器 env：`MEMORY_EMBEDDING_PROVIDER`、`SUMMARY_MODEL`、`PALINK_TOKENIZER_CACHE_DIR`、`OLLAMA_HOST` | `docker exec palink-ai-backend-1 env`；仓库根 `.env`（gitignored，本任务只读未查看） |
| C2 | 用户导入的那张卡：regex_scripts 内容、28 条世界书体积、头像 PNG 大小 | 该用户的 DB / 原卡片文件 |
| C3 | 当晚网关（opencode.ai）对首条消息的实际响应（是否无限 reasoning 流） | 网关侧日志；复现 |
| C4 | 内存曲线形状：阶跃（加载模型）还是斜坡（持续分配） | 复现时每秒采样（§5-1） |
| C5 | 遗留 6.7GB sentence_transformers / 3.3GB GGUF 事发时是否仍在、是否被读 | 复现时 `ls -la /app/models` |
| C6 | 前端 `/api/auth/config` 499 是卡死后的**症状**（前端轮询超时断开），不是原因 | 时间线已自证（卡死先于 499） |

### 4.4 对旧交接单「已排除」项的一条修正

旧排查以「卡死期间 ollama 无 /api/embed 请求（只有 healthcheck）」排除
embedding 阻塞。该证据**不能排除进程内 fastembed 兜底**：兜底路径
（embedder.py:282-284）根本不向 ollama 发请求，直接在进程内加载 ONNX。
⇒ 「Ollama embedding 阻塞」的排除范围应缩小为「排除了 ollama 网络调用阻塞」，
进程内降级加载未被排除。**S1 的疑似度因此上调。**

---

## §5 复现时需要抓什么（命令级，供将来真机复现用）

> 前提：Docker 运行、backend 容器名 `palink-ai-backend-1`。
> Git Bash 下 `docker exec` 前加 `MSYS_NO_PATHCONV=1`（AGENTS.md §5.1）；
> 宿主机 curl 走 `/c/Windows/System32/curl.exe --noproxy '*'`。

### 5-1 内存分解与曲线（第一优先，先分 anon vs file）

```bash
# 一次性快照：cgroup 上限 + anon/file 分解
MSYS_NO_PATHCONV=1 docker exec palink-ai-backend-1 sh -c \
  'cat /sys/fs/cgroup/memory.max; echo ---; cat /sys/fs/cgroup/memory.stat | grep -E "^(anon|file|slab|sock) "; echo ---; grep -E "VmRSS|Threads" /proc/1/status'

# 每秒采样到宿主机文件（复现全程挂着，看形状：anon 阶跃=加载模型；file 阶跃=读大文件）
MSYS_NO_PATHCONV=1 docker exec palink-ai-backend-1 sh -c \
  'while true; do date +%T; grep -E "^(anon|file) " /sys/fs/cgroup/memory.stat; sleep 1; done' \
  > /d/tmp/palink_mem_curve.log 2>&1 &
```

判读：anon 主导 → S1/S4（进程分配）；file 主导 → S3（page cache/大文件读取）。

### 5-2 线程栈（卡死瞬间）

```bash
# 容器在宿主机的 PID（宿主机侧 py-spy attach 用）
docker inspect -f '{{.State.Pid}}' palink-ai-backend-1

# 有 py-spy（宿主机 pip install py-spy）时：线程栈 + 各线程在跑什么
py-spy dump --pid <上面的PID>

# 无 py-spy 时（容器内兜底）：线程数 + 各线程内核等待点
MSYS_NO_PATHCONV=1 docker exec palink-ai-backend-1 sh -c \
  'ls /proc/1/task | wc -l; for t in /proc/1/task/*; do echo "== $t"; cut -d" " -f1-3 $t/stat; cat $t/wchan 2>/dev/null; echo; done'
```

线程数远超平时（>50）+ 多线程卡在同一函数 = 线程泄漏或 GIL 热点；
单线程 CPU 100% 且栈在 `re.sub` = S2 实锤；栈在 `onnxruntime`/fastembed = S1 实锤。

### 5-3 内存快照（保留现场，事后分析）

```bash
# 宿主机侧（需要 gdb；core 文件数 GB，先确认磁盘空间）
gcore <容器PID>            # 产完整内存镜像
pmap -x <容器PID> > /d/tmp/pmap.txt     # 轻量：各区段 Rss/Anonymous/文件映射
cat /proc/<容器PID>/smaps_rollup > /d/tmp/smaps.txt   # anon/file/shared 分解
```

轻量优先：`smaps_rollup` + `pmap -x` 通常已足够区分「模型映射」与「堆分配」。

### 5-4 日志锚点（backend 已有结构化日志，grep 即可）

```bash
grep -E "Downloading remote tokenizer|StreamSession created|\[STREAM-CALL\]|EMPTY-RESP-RETRY|Tokenizer load failed|Ollama 嵌入失败|记忆存储成功" <backend日志>
```

### 5-5 分阶段灰度（不抓栈也能缩小范围）

1. `MEMORY_EMBEDDING_PROVIDER=ollama`（ollama healthy）复现一次；再
   `=fastembed` 复现一次 —— 两者行为分叉即可锁定 S1。
2. 测试卡 `extensions.regex_scripts` 清空后再复现 —— 锁定/排除 S2。
3. 全程断外网（与当晚 github raw 不可达一致）复现 —— 观察是否仍卡死。
4. 换无世界书、无正则、无插件的极简卡复现 —— 确认「卡相关」还是「系统相关」。
5. 复现前 `ls -la /app/models`（确认 6.7GB/3.3GB 遗留是否仍在）—— S3/C5。

### 5-6 可选但需另立任务（本任务零改动约束下不做）

- `faulthandler.register(signal.SIGUSR1)` / `tracemalloc.start()` 需要改生产代码
  才能常驻生效 —— 若为复现需要，单独提任务，勿混入排查。

---

## §6 本任务边界声明

- 零生产代码改动：本报告为唯一产出（`git status` 仅此一个未跟踪文件）。
- 未启动 Docker、未真机复现、未跑任何门禁。
- 未触碰：TODOS.md、docs/_CATALOG.md、.workbuddy/、他人文档、frontend/dist、
  backend/data；未 merge、未 stash、未 add -A。
