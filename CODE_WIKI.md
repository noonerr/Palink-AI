# Palink-AI 项目代码百科

## 项目概述

Palink-AI 是一个企业级 AI 协作平台，支持多模型对接、角色扮演对话、工作空间管理和记忆系统等功能。项目采用前后端分离架构，后端基于 FastAPI 构建，前端使用 React + TypeScript 开发。

**项目版本**: 0.21.2 (前端) / v12.7 (后端 API)

---

## 目录结构

```
Palink-AI/
├── backend/                    # 后端服务
│   ├── alembic/               # 数据库迁移文件
│   │   └── versions/         # 迁移版本脚本
│   ├── app/                  # 主应用目录
│   │   ├── api/              # API 路由
│   │   ├── core/             # 核心配置
│   │   ├── memory_module/     # 记忆模块
│   │   ├── schemas/          # Pydantic 数据模型
│   │   └── services/         # 业务服务层
│   ├── scripts/              # 辅助脚本
│   ├── migrations/           # SQL 迁移脚本
│   ├── Dockerfile
│   ├── requirements.txt
│   └── start-server.sh
├── frontend/                  # 前端应用
│   ├── public/               # 静态资源
│   ├── src/                 # 源代码
│   │   ├── components/      # React 组件
│   │   │   ├── ui/         # UI 组件库
│   │   │   └── views/       # 页面视图
│   │   ├── hooks/           # 自定义 Hooks
│   │   ├── services/         # API 服务
│   │   ├── types/           # TypeScript 类型定义
│   │   ├── lib/              # 工具库
│   │   └── App.tsx           # 应用入口
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml         # Docker 编排配置
├── .env.example              # 环境变量模板
└── CODE_WIKI.md              # 本文档
```

---

## 后端架构

### 技术栈

| 组件 | 技术 |
|------|------|
| Web 框架 | FastAPI |
| 数据库 | PostgreSQL + pgvector (SQLite 可选) |
| ORM | SQLAlchemy |
| 认证 | JWT (PyJWT) |
| 密码加密 | bcrypt |
| 缓存 | 内存缓存 (OrderedDict) |
| 向量存储 | FastEmbed |
| 本地模型 | llama-cpp-python |

### 核心模块

#### 1. 主入口 ([main.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\main.py))

**职责**: 应用启动、生命周期管理、中间件配置

**关键函数**:

| 函数名 | 说明 |
|--------|------|
| `lifespan()` | 异步上下文管理器，处理应用启动和关闭逻辑 |
| `_initialize_database_once()` | 单次数据库初始化（使用文件锁防止多进程重复初始化） |
| `_init_default_data()` | 初始化默认数据（admin 用户、系统设置） |

**中间件**:
- CORS 中间件（可配置 origins）
- 请求 ID 中间件（追踪请求）
- 异常处理器（ServiceError、HTTPException、全局异常）

#### 2. 配置模块 ([core/config.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\core\config.py))

**Settings 类** - 应用配置管理：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `DATABASE_URL` | 数据库连接字符串 | sqlite:///./data/palink.db |
| `SECRET_KEY` | JWT 签名密钥 | 自动生成（开发模式） |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Token 过期时间 | 1440 (24小时) |
| `CHAT_HISTORY_LIMIT` | 聊天历史条数限制 | 24 |
| `MEMORY_EMBEDDING_PROVIDER` | 记忆嵌入模型 | fastembed |
| `MEMORY_VECTOR_DIMENSION` | 向量维度 | 512 |

#### 3. 数据库模块 ([core/database.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\core\database.py))

**职责**: 数据库连接管理、会话创建

```python
# 核心对象
engine           # SQLAlchemy 引擎
SessionLocal     # 会话工厂
get_db()         # 依赖注入函数
```

#### 4. 认证模块 ([api/dependencies.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\api\dependencies.py))

**依赖函数**:

| 函数名 | 说明 |
|--------|------|
| `get_current_user()` | 从 JWT token 获取当前用户 |
| `get_admin()` | 验证管理员权限 |

#### 5. API 路由模块 ([api/__init__.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\api\__init__.py))

**路由前缀**: `/api`

| 路由模块 | 路径 | 说明 |
|----------|------|------|
| chat | `/api/chat` | 普通对话 |
| character | `/api/characters` | 角色管理 |
| auth | `/api` | 认证相关 |
| users | `/api/users` | 用户管理 |
| sessions | `/api/sessions` | 会话管理 |
| workspace | `/api/workspace` | 工作空间 |
| models | `/api/models` | 模型管理 |
| admin | `/api/admin` | 管理员功能 |
| memory | `/api/memory` | 记忆系统 |
| worldbook | - | 世界书 |
| plotline | - | 剧情线 |
| stats | - | 统计信息 |
| mcp | - | MCP 集成 |
| presets | - | 生成预设 |

---

## 服务层详解

### 1. ChatService ([services/chat_service.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\chat_service.py))

**职责**: 聊天相关业务逻辑

| 方法 | 说明 |
|------|------|
| `prepare_chat_context()` | 准备聊天上下文，处理文件引用 |
| `ensure_session()` | 确保会话存在，不存在则创建 |
| `save_user_message()` | 保存用户消息 |
| `save_assistant_message()` | 保存助手消息 |
| `_process_file_references()` | 处理上传的文件内容 |

### 2. CharacterService ([services/character_service.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\character_service.py))

**职责**: 角色 CRUD 操作

| 方法 | 说明 |
|------|------|
| `create_character()` | 创建角色 |
| `update_character()` | 更新角色信息 |
| `delete_character()` | 删除角色（含级联删除会话） |
| `get_character()` | 获取单个角色 |
| `get_characters()` | 获取用户所有角色 |

### 3. CharacterImportService ([services/character_import_service.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\character_import_service.py))

**职责**: 角色卡导入（支持 PNG/JSON）

| 类名 | 说明 |
|------|------|
| `PngCharacterCardParser` | PNG 角色卡解析器 |
| `CharacterDataNormalizer` | 数据规范化器 |
| `CharacterImportService` | 导入服务主类 |

### 4. LLM Client ([services/llm_client.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\llm_client.py))

**职责**: OpenAI 兼容 API 客户端管理

```python
get_async_openai_client(api_key, base_url, timeout) -> AsyncOpenAI
```

**特性**:
- 客户端缓存（LRU，最多 50 个）
- 连接复用

### 5. Inference Dispatcher ([services/inference_dispatcher.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\inference_dispatcher.py))

**职责**: 统一推理调度（支持本地/远程模型）

| 函数 | 说明 |
|------|------|
| `ensure_model_available()` | 验证模型可用性 |
| `complete_text_completion()` | 完整文本补全 |
| `stream_text_completion()` | 流式文本补全 |

**本地模型支持**:
- llama-cpp-python
- Vision 代理（mmproj）

### 6. Llama Runtime ([services/llama_runtime.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\llama_runtime.py))

**职责**: 本地 llama.cpp 模型运行

```python
class LlamaRuntime:
    generate()           # 同步生成
    generate_stream()    # 流式生成
```

**环境变量**:
| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLAMA_CPP_N_CTX` | 上下文大小 | 4096 |
| `LLAMA_CPP_N_GPU_LAYERS` | GPU 层数 | 0 |
| `LLAMA_CPP_THREADS` | 线程数 | 0 |

### 7. Inference Queue ([services/inference_queue.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\inference_queue.py))

**职责**: 本地模型推理队列管理

```python
class ModelQueue:
    submit_request()      # 提交请求
    acquire_slot()       # 获取执行槽位
    release_slot()       # 释放执行槽位
    cancel_request()     # 取消请求

class InferenceQueueManager:
    # 管理多个模型的队列
    get_model_queue()
    submit_and_wait()    # 带重试的提交
```

### 8. Provider Registry ([services/provider_registry.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\services\provider_registry.py))

**职责**: LLM 提供商管理

| 函数 | 说明 |
|------|------|
| `get_providers()` | 获取提供商列表（带缓存） |
| `get_runtime_providers()` | 获取运行时提供商（含解析的 API Key） |
| `find_model()` | 查找模型 |
| `resolve_secret_reference()` | 解析环境变量引用 |
| `infer_supports_vision()` | 推断模型是否支持视觉 |

---

## 记忆模块 ([memory_module/](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\memory_module))

### MemoryService ([memory_module/service.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\memory_module\service.py))

**职责**: 记忆服务统一接口

| 方法 | 说明 |
|------|------|
| `store_memory()` | 存储对话记忆 |
| `get_context()` | 获取增强上下文（异步） |
| `get_user_profile()` | 获取用户画像 |
| `update_user_profile()` | 更新用户画像 |
| `search_memories()` | 语义搜索记忆 |
| `get_recent_memories()` | 获取最近记忆 |

**配置**:
```python
MEMORY_EMBEDDING_PROVIDER=fastembed  # 或 openai
MEMORY_VECTOR_DIMENSION=512
```

---

## API 端点详解

### 聊天 API ([api/chat.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\api\chat.py))

#### POST /api/chat
流式聊天接口

**请求体**:
```typescript
interface ChatRequest {
  message: string;           // 消息内容
  session_id?: string;         // 会话 ID
  model: string;              // 模型 ID
  temperature?: number;       // 温度参数
  images?: string[];          // 图片 URL 列表
  files?: string[];           // 文件 URL 列表
  session_type?: string;      // 会话类型
  display_content?: string;   // 显示内容
  web_search?: boolean;       // 是否启用网络搜索
}
```

**响应**: Server-Sent Events (SSE) 流

### 角色 API ([api/character.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\api\character.py))

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/characters | 获取角色列表 |
| GET | /api/characters/{id} | 获取角色详情 |
| POST | /api/characters | 创建角色 |
| PUT | /api/characters/{id} | 更新角色 |
| DELETE | /api/characters/{id} | 删除角色 |

### 认证 API ([api/auth.py](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\backend\app\api\auth.py))

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/token | 登录 |
| POST | /api/register | 注册 |
| GET | /api/users/me | 获取当前用户信息 |
| PUT | /api/users/me | 更新用户信息 |
| POST | /api/users/me/password | 修改密码 |

---

## 前端架构

### 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | React 19 |
| 路由 | React Router DOM 7 |
| 状态管理 | React hooks (useState/useCallback) |
| UI 组件 | Radix UI + 自定义组件 |
| 样式 | Tailwind CSS 3.4 |
| 动画 | Framer Motion |
| 状态提示 | Sonner |
| Markdown | react-markdown + remark-gfm |
| 图表 | Recharts |
| 图编辑 | @xyflow/react (流程图) |

### 核心组件

#### 1. App.tsx ([src/App.tsx](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\frontend\src\App.tsx))

**职责**: 应用入口、路由管理、布局

**路由结构**:
```
/login              # 登录页
/chat               # 对话页
/workspace          # 工作空间
/settings           # 设置页
/settings/providers/:id  # 提供商编辑
/characters         # 角色列表
/characters/:id     # 角色详情/对话
```

**核心状态**:
```typescript
token          // 认证 token
user           // 当前用户
models         // 模型列表
providers      // 提供商列表
systemDefaults // 系统默认配置
isDark         // 主题模式
lang           // 语言
```

#### 2. ChatView.tsx ([src/components/views/ChatView.tsx](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\frontend\src\components\views\ChatView.tsx))

**职责**: 普通对话界面

**核心功能**:
- 会话列表管理
- 消息展示（Markdown 渲染）
- 流式响应处理
- 文件上传
- 记忆压缩
- 消息编辑/删除

#### 3. CharacterView.tsx ([src/components/views/CharacterView.tsx](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\frontend\src\components\views\CharacterView.tsx))

**职责**: 角色扮演界面

**核心功能**:
- 角色管理（CRUD）
- 角色卡导入/导出
- 角色对话（支持分支）
- 世界书集成
- 剧情线管理

#### 4. API 服务 ([src/services/api.ts](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\frontend\src\services\api.ts))

**接口封装**:
```typescript
api.get<T>(url, options?)
api.post<T>(url, body?, options?)
api.put<T>(url, body?, options?)
api.delete<T>(url, body?, options?)
api.patch<T>(url, body?, options?)
api.stream(url, body?, options?)  // SSE 流式请求
api.raw(url, options?)             // 原始响应
```

**特性**:
- 自动注入 Authorization header
- 401 自动派发登出事件
- 统一错误处理

### 自定义 Hooks

| Hook | 说明 |
|------|------|
| `useCharacterChat` | 角色对话逻辑 |
| `useMessageSelection` | 消息选择逻辑 |
| `useWorldBook` | 世界书交互 |
| `usePlotLine` | 剧情线交互 |
| `useVirtualKeyboard` | 虚拟键盘检测 |
| `useMobileBottomPadding` | 移动端底部适配 |

### 类型定义 ([src/types/index.ts](file:///c:\Users\Pall\OneDrive\桌面\Palink-AI\frontend\src\types\index.ts))

```typescript
User            // 用户
Model           // 模型
Provider        // 提供商
Session         // 会话
Message         // 消息
Character       // 角色
WorldBook       // 世界书
PlotLine        // 剧情线
GenerationPreset // 生成预设
MemoryStats     // 记忆统计
```

---

## 依赖关系图

```
┌─────────────────────────────────────────────────────────┐
│                      前端 (React)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ ChatView │  │Character │  │    SettingsView      │  │
│  │          │  │  View    │  │                      │  │
│  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘  │
│       │             │                    │              │
│       └─────────────┴────────────────────┘              │
│                         │                               │
│               ┌─────────▼─────────┐                     │
│               │    api.ts         │                     │
│               │  (HTTP Client)    │                     │
│               └─────────┬─────────┘                     │
└─────────────────────────┼───────────────────────────────┘
                          │ REST API
┌─────────────────────────┼───────────────────────────────┐
│                         ▼                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │              main.py (FastAPI App)               │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                               │
│  ┌──────────────────────┼──────────────────────────┐   │
│  │              api/__init__.py                      │   │
│  │              (Router Aggregation)                 │   │
│  └────┬─────────┬────────┼────────┬────────┬────────┘   │
│       │         │        │        │        │            │
│  ┌────▼──┐ ┌───▼──┐ ┌───▼──┐ ┌──▼───┐ ┌──▼────┐      │
│  │ chat  │ │ char │ │ auth │ │model │ │memory │      │
│  └───┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬────┘      │
│      │        │        │        │        │              │
│      └────────┴────────┴────────┴────────┘              │
│                        │                                │
│               ┌────────▼────────┐                       │
│               │  services/      │                       │
│               │                 │                       │
│  ┌────────────┼────────────┬───┴──────────┬──────────┐  │
│  │            │            │              │          │  │
│  ▼            ▼            ▼              ▼          ▼  │
│ ChatService  Character   LLM Client   Inference  Memory │
│             Service                  Dispatcher  Module  │
│                                                    │     │
│                                       ┌────────────┼─┐   │
│                                       │            ▼ │   │
│                                       │  FastEmbed  │   │
│                                       │  (Embedding)│   │
│                                       └─────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────┐
│                         ▼                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │              PostgreSQL + pgvector               │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 数据库模型

### 主要表结构

| 表名 | 说明 |
|------|------|
| users | 用户表 |
| chat_sessions | 对话会话 |
| chat_messages | 对话消息 |
| characters | 角色 |
| character_chat_sessions | 角色会话 |
| character_chat_messages | 角色消息 |
| character_chat_branches | 对话分支 |
| world_books | 世界书 |
| world_book_stages | 世界书阶段 |
| plot_lines | 剧情线 |
| plot_stages | 剧情阶段 |
| user_settings | 用户设置 |
| user_files | 用户文件 |
| system_settings | 系统设置 |
| memory_entries | 记忆条目 |
| user_profiles | 用户画像 |

---

## 环境变量配置

### 必需配置

```bash
# 安全配置（生产环境必须设置）
SECRET_KEY=your-secret-key
ADMIN_PASSWORD=your-admin-password

# 数据库
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

### 可选配置

```bash
# 记忆模块
MEMORY_EMBEDDING_PROVIDER=fastembed
MEMORY_VECTOR_DIMENSION=512

# HuggingFace
HF_ENDPOINT=https://hf-mirror.com

# 性能配置
APP_PERFORMANCE_PROFILE=eco
APP_MAX_WORKERS=1
```

---

## 运行方式

### 开发模式

**后端**:
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

**前端**:
```bash
cd frontend
npm install
npm run dev
```

### Docker 部署

```bash
# 复制环境变量模板
cp .env.example .env
# 编辑 .env 填入实际值

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f
```

### 端口映射

| 服务 | 端口 |
|------|------|
| 前端 | 3000 → 8080 |
| 后端 | 8000 |
| PostgreSQL | 5432 |

---

## 安全特性

1. **认证**: JWT Bearer Token
2. **密码加密**: bcrypt
3. **CORS**: 可配置允许 origins
4. **速率限制**: 登录/注册/聊天接口
5. **文件上传**: MIME 类型验证、文件签名检查
6. **SSRF 防护**: 禁止内部地址访问
7. **输入验证**: Pydantic 模型验证

---

## 扩展功能

### MCP 集成
支持 Model Context Protocol 工具调用

### Web Search
集成网络搜索功能

### 本地模型
支持 llama.cpp 本地模型运行

### 记忆压缩
自动压缩对话历史，减少 token 消耗

---

## 版本历史

| 版本 | 说明 |
|------|------|
| 0.21.2 | 前端最新版本 |
| v12.7 | 后端 API 版本 |
