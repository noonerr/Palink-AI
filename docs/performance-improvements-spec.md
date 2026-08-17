# Palink-AI 性能提升规格文档

## 项目概述

Palink-AI 是一个全栈 AI 聊天/角色扮演平台，前端使用 React 19 + TypeScript + Vite 7，后端使用 FastAPI (Python 3.10) + PostgreSQL/pgvector，通过 Docker Compose 部署。本文档是对项目代码进行全面性能审计后，识别出的可落地性能提升项。

---

## 一、前端性能提升项

### P0-01：useChatView 流式更新缺少 requestAnimationFrame 节流

**问题**：`useChatView.ts` 中的 `setAssistantMessageSnapshot` 在每个 WebSocket chunk 到达时都直接调用 `setMessages`，高频场景下（每秒 30-50 个 chunk）会导致每帧创建新的消息数组副本并触发所有消息组件的重渲染对比。而 `useCharacterChat.ts` 已经使用了 `requestAnimationFrame` 节流策略，两者不一致。

**文件**：`frontend/src/hooks/useChatView.ts` 第 181-204 行

**方案**：参照 `useCharacterChat.ts` 第 83-102 行的 `scheduleStreamUpdate` 实现，在 `useChatView.ts` 中引入相同的 rAF 节流机制，将多个 chunk 合并为一次 state 更新。

**预期收益**：流式输出期间 CPU 使用率降低 60-80%，渲染帧率从不稳定降至稳定 60fps。

---

### P0-02：消息列表内联箭头函数导致 React.memo 失效

**问题**：`ChatViewDesktop.tsx` 中为每条消息创建了 4 个内联箭头函数（`onRegenerate`、`onDelete`、`onEdit`、条件判断），每次渲染时这些函数引用都变化，导致 `Message` 组件的 `React.memo` 精确比较完全失效，所有消息每帧都重渲染。

**文件**：`frontend/src/components/views/ChatViewDesktop.tsx` 第 136-159 行

**方案**：采用事件委托模式，将消息操作（重新生成、删除、编辑）通过 `data-attribute` 传递消息 ID 和索引，在父组件层面统一处理，避免为每条消息创建独立回调。或者创建一个 `MessageActions` Context，将稳定的操作函数注入。

**预期收益**：流式输出期间消息组件重渲染次数从 N 条/帧 降至 1 条/帧。

---

### P1-01：handleSend/handleRegenerate 依赖项过多导致函数频繁重建

**问题**：`useChatView.ts` 的 `handleSend` 依赖了 12 个值，其中 `input` 每次按键都变化，导致函数每次按键都重建。`useCharacterChat.ts` 的 `handleSendMessage` 更是依赖了 21 个值。这些函数作为 prop 传递给子组件，触发不必要的重渲染。

**文件**：
- `frontend/src/hooks/useChatView.ts` 第 846 行
- `frontend/src/hooks/useCharacterChat.ts` 第 648 行

**方案**：使用 `useRef` 存储高频变化的值（`input`、`attachments`），从 `useCallback` 的依赖项中移除它们，在函数体内通过 `ref.current` 读取最新值。

**预期收益**：减少子组件（ChatInput 等）的不必要重渲染，提升输入流畅度。

---

### P1-02：useCharacterChat 的 handleRegenerate 直接依赖 messages state

**问题**：`useCharacterChat.ts` 的 `handleRegenerate` 直接依赖 `messages` state，而流式传输期间 `messages` 通过 `scheduleStreamUpdate` 每帧更新一次，导致 `handleRegenerate` 每帧重建。`useChatView.ts` 已经正确使用了 `messagesRef` 来避免此问题，两者不一致。

**文件**：`frontend/src/hooks/useCharacterChat.ts` 第 429 行

**方案**：与 `useChatView.ts` 保持一致，使用 `messagesRef` 代替直接依赖 `messages`。

**预期收益**：消除流式传输期间 `handleRegenerate` 的每帧重建。

---

### P1-03：MarkdownRenderer 与 Message 存在大量重复的工具函数和常量

**问题**：`MarkdownRenderer.tsx` 和 `Message.tsx` 各自独立定义了完全相同的 `IMAGE_HOSTING_DOMAINS`、`IMAGE_EXT_PATTERN`、`isImageUrl`、`preprocessImageUrls`、`REMARK_PLUGINS`、`REHYPE_PLUGINS` 等。这些重复代码增加了包体积和维护成本。

**文件**：
- `frontend/src/components/ui/custom/MarkdownRenderer.tsx` 第 20-74 行
- `frontend/src/components/ui/custom/Message.tsx` 第 33-74 行

**方案**：将重复的工具函数和常量提取到共享模块 `lib/markdownUtils.ts` 中，两个文件统一引用。

**预期收益**：减少约 1-2KB 的重复代码，提升可维护性。

---

### P2-01：KaTeX 字体文件冗余格式

**问题**：`public/fonts/` 目录下有 66 个 KaTeX 字体文件，包含 `.woff2`、`.woff`、`.ttf` 三种格式。现代浏览器（2023 年以后）均支持 `.woff2`，`.woff` 和 `.ttf` 是冗余的，约占字体总体积的 60%。

**文件**：`frontend/public/fonts/` 目录

**方案**：
1. 仅保留 `.woff2` 格式，删除 `.woff` 和 `.ttf` 文件
2. 修改 `public/katex.min.css` 中的 `@font-face` 声明，仅保留 `.woff2` 的 `src`
3. 考虑在检测到数学公式内容时才动态加载 KaTeX CSS（按需加载）

**预期收益**：减少约 60% 的字体文件体积（预计节省数百 KB），降低首次加载带宽。

---

### P2-02：ThinkingProcess 模块级 Map 无限增长

**问题**：`ThinkingProcess.tsx` 中使用模块级全局 `Map<string, boolean>` 记住每个消息的思考过程展开/折叠状态，随着聊天增多无限增长，永远不会被清理。

**文件**：`frontend/src/components/ui/custom/ThinkingProcess.tsx` 第 13 行

**方案**：添加 LRU 缓存机制，限制 Map 大小（如最多保留 500 条），超出时淘汰最旧的条目。

**预期收益**：防止长时间使用后的内存缓慢增长。

---

### P2-03：index.css 中存在重复的 .code-block 样式定义

**问题**：`index.css` 第 458-480 行和第 1024-1062 行分别定义了 `.code-block`、`.code-block-header`、`.code-block pre` 等样式，后者覆盖前者。应合并为一份。

**文件**：`frontend/src/index.css` 第 458-480 行、第 1024-1062 行

**方案**：合并两处定义，保留更完整的版本，删除重复部分。

**预期收益**：减少约 500 字节 CSS 体积，消除样式覆盖带来的不确定性。

---

### P2-04：appendUploadToken 每次调用都读取 localStorage

**问题**：`MarkdownRenderer.tsx` 中的 `appendUploadToken` 函数在渲染每个链接和图片时都调用 `localStorage.getItem('palink_token')`，在高频流式渲染中造成不必要的同步 I/O。

**文件**：`frontend/src/components/ui/custom/MarkdownRenderer.tsx` 第 33-43 行

**方案**：将 token 缓存在模块级变量中，通过事件监听（`storage` 事件或自定义事件）在 token 变化时更新缓存。

**预期收益**：消除高频渲染中的同步 localStorage 读取。

---

### P3-01：App.tsx 中 sidebarProps 对象每次渲染都重新创建

**问题**：`App.tsx` 中 `sidebarProps` 对象在每次渲染时都重新创建，导致 `DesktopSidebar` 和 `MobileBottomNav` 在任何 state 变化时都重渲染。`toggleTheme` 和 `toggleLang` 也缺少 `useCallback`。

**文件**：`frontend/src/App.tsx` 第 489-522 行

**方案**：使用 `useMemo` 包裹 `sidebarProps`，使用 `useCallback` 包裹 `toggleTheme` 和 `toggleLang`。

**预期收益**：减少侧边栏和底部导航的不必要重渲染。

---

### P3-02：ChatViewDesktop 中 handleSend 包装函数缺少 useCallback

**问题**：`ChatViewDesktop.tsx` 中的 `handleSend` 包装函数在每次渲染时都重新创建，作为 prop 传递给 `WelcomeContent` 和 `ChatInput`。

**文件**：`frontend/src/components/views/ChatViewDesktop.tsx` 第 38-40 行

**方案**：直接传递 `chat.handleSend`（已经是 `useCallback` 包裹的），或用 `useCallback` 包裹包装函数。

**预期收益**：减少 ChatInput 组件的不必要重渲染。

---

### P3-03：WebSocket 主动断开时的重连竞态条件

**问题**：`useChatWebSocket.ts` 的 `ws.onclose` 无条件触发重连。虽然 `disconnect()` 通过设置 `reconnectAttemptsRef.current = MAX_RECONNECT_ATTEMPTS` 来阻止重连，但存在理论上的竞态条件。

**文件**：`frontend/src/hooks/useChatWebSocket.ts` 第 145-160 行

**方案**：添加 `intentionalCloseRef` 标志，在 `disconnect()` 中设置为 `true`，在 `onclose` 中检查后再决定是否重连。

**预期收益**：消除潜在的无效重连。

---

## 二、后端性能提升项

### P0-03：聊天消息加载无分页

**问题**：`sessions.py` 的 `get_session_messages` 端点没有 `limit`/`offset` 参数，对长对话会一次性加载全部消息到内存。虽然会话列表有分页，但消息加载没有。长对话（数百条消息）场景下可能导致内存压力和响应延迟。

**文件**：`backend/app/api/sessions.py` 第 96-127 行

**方案**：添加 `limit` 和 `before_id` 参数，实现游标分页。前端配合实现滚动加载（向上滚动时加载更早的消息）。

**预期收益**：长对话加载时间从 O(n) 降至 O(1)，内存占用显著降低。

---

### P0-04：语义搜索在 Python 中逐条计算余弦相似度

**问题**：`storage.py` 的语义搜索从数据库加载最多 200 条记录的 embedding（JSON 字符串），在 Python 中逐条反序列化并计算余弦相似度。每条 embedding 的 JSON 解析开销很大（384-1536 维向量约占 3-12KB），且没有利用向量化计算。

**文件**：`backend/app/memory_module/storage.py` 第 367-409 行

**方案**：
1. 短期：使用 numpy 批量矩阵运算替代逐条循环计算（一次 `np.dot` 计算所有相似度）
2. 中期：使用 `sqlite-vss` 或 `faiss` 做本地向量索引
3. 长期：PostgreSQL + pgvector 在数据库层面完成向量搜索（已有 pgvector 基础设施）

**预期收益**：语义搜索延迟从数百毫秒降至数十毫秒，CPU 使用率大幅降低。

---

### P1-04：分支历史遍历中的 N+1 查询

**问题**：`character_ext.py` 的 `_get_full_branch_history` 在 `while` 循环中逐条查询父分支，分支链越长，查询次数越多。项目中已有 `_get_ancestor_branch_ids` 使用 CTE 递归查询，但未被充分利用。

**文件**：`backend/app/api/character_ext.py` 第 159-172 行

**方案**：使用已有的 CTE 递归查询一次性获取所有祖先分支 ID，然后用 `IN` 查询批量加载，将 N 次查询减少为 2 次。

**预期收益**：深层分支链的加载时间从 O(n) 次数据库往返降至 2 次。

---

### P1-05：角色聊天无分支时全量加载消息

**问题**：当没有分支时，先 `.all()` 加载全部消息到内存，再在 Python 中截取最后 `limit` 条。应该使用 SQL 的 `ORDER BY ... DESC LIMIT ...` 然后反转。

**文件**：`backend/app/api/character_ext.py` 第 1202-1213 行

**方案**：改为 `query.order_by(CharacterChatMessage.created_at.desc()).limit(limit).all()` 然后反转列表。

**预期收益**：避免将全部历史消息加载到内存，长对话场景下内存和响应时间显著改善。

---

### P1-06：StreamSession 清理延迟过长（5 分钟）

**问题**：已完成的 `StreamSession` 需要等待 5 分钟且无订阅者才清理。每个 `StreamSession` 持有完整的生成内容（`full_content`、`full_reasoning`），长篇回复会占用大量内存。

**文件**：`backend/app/services/websocket_manager.py` 第 422-436 行

**方案**：
- `status == "done"` 的 StreamSession：无订阅者后 30-60 秒清理
- `status == "error"` 的：无订阅者后立即清理

**预期收益**：内存占用峰值降低，避免高频聊天时的内存持续增长。

---

### P2-05：高频查询缺少缓存

**问题**：项目实现了 `TTLCache` 装饰器，但仅有 2 处使用（用户设置 30s TTL、模型列表 5s TTL）。以下高频操作每次都查数据库：
- 角色信息查询（每次聊天请求都查角色数据）
- 世界书词条查询（每次角色聊天都查）
- 剧情线阶段查询（每次角色聊天都查）
- 系统设置查询（每次生成标题都查）

**文件**：
- `backend/app/core/cache.py`
- `backend/app/api/users.py` 第 23 行
- `backend/app/api/models.py` 第 142 行

**方案**：为角色信息（60s TTL）、世界书词条（120s TTL，修改时主动失效）、剧情线阶段（120s TTL）、系统设置（300s TTL）添加 `@cached` 装饰器。

**预期收益**：每次聊天请求减少 3-5 次数据库查询，降低数据库负载。

---

### P2-06：WebSocket 广播和心跳串行发送

**问题**：`WebSocketManager` 的 `broadcast` 和 `_ping_all` 对同一房间内的多个连接串行发送消息。如果某个连接发送缓慢，会阻塞其他连接。

**文件**：`backend/app/services/websocket_manager.py` 第 78-88 行、第 385-404 行

**方案**：使用 `asyncio.gather` 并行发送，为每次发送设置 `asyncio.wait_for` 超时（如 5 秒），超时则标记为死连接。

**预期收益**：多用户同时在线时消息广播延迟降低。

---

### P2-07：embedding 存储为 JSON 字符串效率低

**问题**：embedding 向量以 JSON 字符串存储在数据库中。384 维 float32 向量序列化为 JSON 约占 6KB，相比二进制存储（numpy `.tobytes()`）体积大约 3-5 倍，且解析速度慢得多。

**文件**：`backend/app/memory_module/storage.py` 第 277 行

**方案**：使用 `base64` 编码的二进制格式存储，或使用 SQLite 的 BLOB 类型。配合 numpy 的 `frombuffer`/`tobytes` 实现高效序列化/反序列化。

**预期收益**：存储空间减少 60-80%，embedding 解析速度提升 3-5 倍。

---

### P2-08：角色导入使用同步阻塞的 urllib.request

**问题**：`character_import_service.py` 使用 `urllib.request.urlopen` 同步下载角色头像，15 秒超时意味着最坏情况下事件循环被阻塞 15 秒。

**文件**：`backend/app/services/character_import_service.py` 第 266 行、第 280 行

**方案**：使用 `asyncio.to_thread(urllib.request.urlopen, ...)` 或改用 `httpx.AsyncClient`。

**预期收益**：消除角色导入期间的事件循环阻塞。

---

### P2-09：上下文邻近度计算的 O(n^2) 复杂度

**问题**：`retriever.py` 中对候选记忆计算上下文邻近度时使用 O(n^2) 的双重循环，候选集最多 50 条，最坏情况需要 1225 次向量点积运算。

**文件**：`backend/app/memory_module/retriever.py` 第 230-245 行

**方案**：使用 numpy 预计算相似度矩阵（批量矩阵运算），一次 `np.dot` 完成所有两两比较。

**预期收益**：邻近度计算从 O(n^2) 次单独运算降至一次矩阵乘法。

---

### P3-04：推理队列使用线性搜索

**问题**：`InferenceQueue` 的 `_get_position`、`cancel_request`、`get_cancel_event` 都使用线性搜索遍历队列。`InferenceQueueManager` 的 `get_queue_status` 等方法遍历所有模型队列。

**文件**：`backend/app/services/inference_queue.py` 第 91-95 行、第 291-309 行

**方案**：
1. 在队列中维护 `Dict[str, int]` 映射 `request_id -> queue_index`
2. 在管理器中维护 `Dict[str, str]` 映射 `request_id -> model_key`

**预期收益**：队列操作从 O(n) 降至 O(1)。当前队列上限 100，影响有限，但属于低成本的改进。

---

### P3-05：UVICORN_KEEPALIVE_TIMEOUT 设置过长

**问题**：`start-server.sh` 中 `UVICORN_KEEPALIVE_TIMEOUT=600`（10 分钟），空闲 HTTP 连接会占用 worker 长达 10 分钟。

**文件**：`backend/start-server.sh`

**方案**：降低到 120 秒。聊天应用的交互模式是高频请求后空闲，120 秒足够覆盖正常的请求间隔。

**预期收益**：减少空闲连接对 worker 的占用，提升并发处理能力。

---

### P3-06：SQLite 连接池未显式配置

**问题**：SQLite 引擎没有配置 `pool_size` 和 `max_overflow`，使用 SQLAlchemy 默认值（`pool_size=5`）。SQLite WAL 模式下写操作是串行的，过多的连接没有意义。

**文件**：`backend/app/core/database.py` 第 6-11 行

**方案**：对 SQLite 显式设置 `pool_size=2, max_overflow=3`。

**预期收益**：减少 SQLite 模式下的空闲连接数。

---

### P3-07：MemoryService 独立缓存与全局 TTLCache 不统一

**问题**：`MemoryService` 实现了自己的一套缓存（使用 `asyncio.Lock`），与全局 `TTLCache`（使用 `threading.Lock`）完全独立，增加了维护复杂度。且 MemoryService 的缓存只在访问时惰性清理过期条目，没有定期清理。

**文件**：`backend/app/memory_module/service.py` 第 32-36 行

**方案**：统一使用全局 `TTLCache`，或为 MemoryService 的缓存添加定期清理逻辑。

**预期收益**：降低代码维护复杂度，确保过期缓存被及时清理。

---

## 三、基础设施提升项

### P2-10：embedding 计算缺少批量处理

**问题**：每条消息存储后都触发一次独立的 embedding 计算（通过后台任务），高频聊天时可能积压大量后台任务，每次嵌入计算 50-200ms。

**文件**：`backend/app/memory_module/storage.py` 第 256-261 行

**方案**：实现批量 embedding 更新队列，将多条待计算的 embedding 合并为一次批量推理（fastembed 和 SentenceTransformers 均支持批量推理）。

**预期收益**：embedding 计算吞吐量提升 3-5 倍。

---

### P3-08：Admin 删除用户时多次级联查询

**问题**：`admin.py` 删除用户时多次查询获取 ID 列表再级联删除，可以合并为更少的 SQL 语句。

**文件**：`backend/app/api/admin.py` 第 198-231 行

**方案**：使用子查询删除（`DELETE FROM ... WHERE user_id IN (SELECT id FROM users WHERE ...)`)，减少数据库往返次数。

**预期收益**：删除操作从 5-6 次查询降至 2-3 次。低频操作，优先级低。

---

## 四、优先级总览

| 优先级 | 编号 | 类别 | 简述 | 预期影响 |
|--------|------|------|------|---------|
| P0 | P0-01 | 前端 | useChatView 流式更新缺少 RAF 节流 | 流式输出卡顿 |
| P0 | P0-02 | 前端 | 消息列表内联函数导致 memo 失效 | 所有消息每帧重渲染 |
| P0 | P0-03 | 后端 | 聊天消息加载无分页 | 长对话内存溢出风险 |
| P0 | P0-04 | 后端 | 语义搜索逐条计算余弦相似度 | 记忆检索延迟高 |
| P1 | P1-01 | 前端 | handleSend 依赖项过多 | 输入卡顿 |
| P1 | P1-02 | 前端 | handleRegenerate 依赖 messages state | 函数每帧重建 |
| P1 | P1-03 | 前端 | MarkdownRenderer/Message 重复代码 | 维护性和包体积 |
| P1 | P1-04 | 后端 | 分支历史 N+1 查询 | 角色聊天加载慢 |
| P1 | P1-05 | 后端 | 无分支时全量加载消息 | 长对话加载慢 |
| P1 | P1-06 | 后端 | StreamSession 清理延迟 5 分钟 | 内存持续增长 |
| P2 | P2-01 | 前端 | KaTeX 字体冗余格式 | 首次加载带宽浪费 |
| P2 | P2-02 | 前端 | ThinkingProcess 全局 Map 无限增长 | 长时间使用内存增长 |
| P2 | P2-03 | 前端 | index.css 重复样式定义 | CSS 体积 |
| P2 | P2-04 | 前端 | appendUploadToken 频繁读 localStorage | 同步 I/O 开销 |
| P2 | P2-05 | 后端 | 高频查询缺少缓存 | 数据库负载高 |
| P2 | P2-06 | 后端 | WebSocket 广播串行发送 | 多用户延迟 |
| P2 | P2-07 | 后端 | embedding JSON 存储效率低 | 存储和解析开销 |
| P2 | P2-08 | 后端 | 角色导入同步阻塞 | 事件循环阻塞 |
| P2 | P2-09 | 后端 | 上下文邻近度 O(n^2) 计算 | CPU 开销 |
| P2 | P2-10 | 后端 | embedding 缺少批量处理 | 计算吞吐量低 |
| P3 | P3-01 | 前端 | sidebarProps 每次渲染重建 | 侧边栏重渲染 |
| P3 | P3-02 | 前端 | handleSend 包装缺 useCallback | ChatInput 重渲染 |
| P3 | P3-03 | 前端 | WebSocket 重连竞态条件 | 潜在无效重连 |
| P3 | P3-04 | 后端 | 推理队列线性搜索 | 队列操作效率 |
| P3 | P3-05 | 后端 | keepalive 超时过长 | worker 占用 |
| P3 | P3-06 | 后端 | SQLite 连接池未配置 | 空闲连接浪费 |
| P3 | P3-07 | 后端 | 缓存策略不统一 | 维护复杂度 |
| P3 | P3-08 | 后端 | Admin 删除多次级联查询 | 低频操作效率 |

---

## 五、实施建议

**第一阶段（P0，建议立即实施）**：
- P0-01 和 P0-02 是前端流式体验的核心瓶颈，改动范围可控，风险低
- P0-03 消息分页是长对话场景的必要功能
- P0-04 语义搜索优化对记忆模块性能至关重要

**第二阶段（P1，建议短期内实施）**：
- P1-01/P1-02 是 P0-01 的补充优化
- P1-04/P1-05 改善角色聊天加载性能
- P1-06 防止内存泄漏

**第三阶段（P2，按需实施）**：
- P2-05 缓存策略对数据库负载影响最大
- P2-07/P2-10 是记忆模块的存储层优化
- 其余为渐进式改善

**第四阶段（P3，低优先级）**：
- 代码质量和边缘情况改善，可随日常维护逐步完成
