# Palink-AI 免费 WebSearch 配置指南

## 🎯 目标

为 Palink-AI 项目配置免费的 Brave Search API，替代昂贵的付费方案。

## 📊 好消息

你的项目**已经支持 Brave Search**！代码已经写好了，只需要配置 API Key。

## 💰 Brave Search 免费计划

| 项目 | 免费计划 | 付费计划 |
|------|----------|----------|
| **每月查询次数** | 2,000 次 | 无限制 |
| **成本** | $0 | $5-50/月 |
| **需要信用卡** | ❌ 不需要 | ✅ 需要 |
| **质量** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |

**免费额度足够吗？**
- 如果每天 < 70 次搜索 → 完全够用
- 如果超过 → 可以添加其他免费服务（Tavily、SearXNG）

## 🔑 获取免费 Brave API Key

### 步骤 1: 注册 Brave Search API
1. 访问：https://brave.com/search/api/
2. 点击 **"Get Started"** 或 **"Sign Up"**
3. 使用 GitHub 或 Email 注册
4. 选择 **"Free Plan"**（每月 2000 次免费）

### 步骤 2: 获取 API Key

1. 登录后进入 Dashboard
2. 找到 **"API Keys"** 部分
3. 点击 **"Create API Key"**
4. 复制生成的 Key（格式：`BSA...`）

### 步骤 3: 配置到项目

#### 方法 1: 使用环境变量（推荐）

```bash
# 编辑后端环境变量
nano backend/.env

# 添加以下内容
BRAVE_API_KEY=BSA_your_api_key_here
```

然后修改 `backend/app/services/web_search.py`，让它从环境变量读取：

```python
# 在文件顶部添加
import os

# 修改默认配置
def _get_raw_config() -> dict:
    # ... 现有代码 ...
    return {
        "enabled": False,
        "engine": "searxng",
        "searxng_url": SEARXNG_DEFAULT_URL,
        "brave_api_key": os.getenv("BRAVE_API_KEY", ""),  # 从环境变量读取
        "baidu_cookie": "",
        "custom_url": "",
        "custom_engine": "searxng",
    }
```

#### 方法 2: 使用管理后台配置（更简单）

1. 启动项目
2. 登录管理后台
3. 进入 **设置 → WebSearch 配置**
4. 选择 **Brave Search**
5. 粘贴 API Key
6. 点击保存

配置会保存在：`data/web_search.json`

## 🚀 启用 WebSearch

### 在前端启用

你的前端已经有 WebSearch 开关了！

**位置**：`frontend/src/components/ui/custom/ChatInput.tsx`

用户可以通过 UI 切换 WebSearch 功能。

### 测试是否工作

1. 启动项目：
   ```bash
   docker-compose up -d
   ```

2. 打开前端，在聊天输入框启用 WebSearch

3. 发送消息测试：
   ```
   "搜索一下 React 19 的新特性"
   ```

4. 检查后端日志：
   ```bash
   docker logs palink-ai-backend-1 --tail 50
   ```

## 📊 监控用量

### 查看 Brave API 用量

1. 登录 Brave Search Dashboard
2. 查看 **"Usage"** 部分
3. 可以看到：
   - 当月已使用次数
   - 剩余次数
   - 重置日期（每月 1 号）

### 在项目中监控

你可以在后端添加用量统计：

```python
# backend/app/services/web_search.py

# 添加计数器
_search_count = 0

async def search_web(query: str, num_results: int = 5) -> list:
    global _search_count
    config = _get_raw_config()
    
    if not config.get("enabled"):
        return []
    
    engine = config.get("engine", "searxng")
    
    # 记录搜索次数
    _search_count += 1
    logger.info(f"Web search #{_search_count}: engine={engine}, query={query}")
    
    # ... 现有代码 ...
```

## 🔄 备选方案

### 如果 Brave 额度不够

你的项目已经支持多个搜索引擎，可以配置多个免费服务：

#### 1. SearXNG（完全免费，自托管）

```yaml
# docker-compose.yml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8080:8080"
    volumes:
      - ./searxng:/etc/searxng
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080
```

**优点**：
- 完全免费
- 无限制
- 聚合多个搜索引擎

**缺点**：
- 需要自己部署
- 需要维护

#### 2. 百度千帆 AI 搜索

你的项目已经支持！配置方法：

```bash
# 获取 API Key
https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application

# 配置
BAIDU_QIANFAN_API_KEY=bce-v3/your_key_here
```

#### 3. 混合方案（推荐）

同时配置多个搜索引擎，轮流使用：

1. **Brave Search**（2000次/月）- 主力
2. **SearXNG**（无限制）- 备用
3. **百度千帆**（有免费额度）- 备用

在管理后台可以随时切换。

## 💡 节省额度的技巧

### 1. 缓存搜索结果

在 `backend/app/services/web_search.py` 添加缓存：

```python
from functools import lru_cache
from datetime import datetime, timedelta

# 简单的内存缓存（1小时过期）
_search_cache = {}

async def search_web(query: str, num_results: int = 5) -> list:
    # 检查缓存
    cache_key = f"{query}:{num_results}"
    if cache_key in _search_cache:
        cached_result, cached_time = _search_cache[cache_key]
        if datetime.now() - cached_time < timedelta(hours=1):
            logger.info(f"Using cached search result for: {query}")
            return cached_result
    
    # 执行搜索
    results = await _do_search(query, num_results)
    
    # 保存到缓存
    _search_cache[cache_key] = (results, datetime.now())
    
    return results
```

### 2. 限制搜索频率

添加速率限制：

```python
from collections import defaultdict
from datetime import datetime

_user_search_count = defaultdict(list)

def check_rate_limit(user_id: str, max_per_hour: int = 10) -> bool:
    now = datetime.now()
    one_hour_ago = now - timedelta(hours=1)
    
    # 清理过期记录
    _user_search_count[user_id] = [
        t for t in _user_search_count[user_id] 
        if t > one_hour_ago
    ]
    
    # 检查是否超限
    if len(_user_search_count[user_id]) >= max_per_hour:
        return False
    
    _user_search_count[user_id].append(now)
    return True
```

### 3. 智能搜索

只在真正需要时搜索：

```python
def should_search(message: str) -> bool:
    """判断是否需要搜索"""
    # 检查是否包含搜索关键词
    search_keywords = ["搜索", "查找", "search", "find", "最新", "latest"]
    return any(keyword in message.lower() for keyword in search_keywords)
```

## 🔒 安全建议

### 1. 保护 API Key

```bash
# backend/.env
BRAVE_API_KEY=BSA_your_key_here

# backend/.gitignore
.env
data/web_search.json
```

### 2. 限制访问

只允许登录用户使用 WebSearch：

```python
# backend/app/api/chat.py

@router.post("/api/chat")
async def chat(
    request: ChatRequest,
    user: User = Depends(get_current_user),  # 需要登录
    db: Session = Depends(get_db)
):
    # ... 现有代码 ...
```

### 3. 监控异常使用

```python
# 检测异常搜索行为
if _search_count > 100:  # 每小时超过100次
    logger.warning(f"Unusual search activity detected: {_search_count} searches")
    # 发送告警邮件
```

## 📝 完整配置步骤

### 1. 获取 Brave API Key（5 分钟）

```
https://brave.com/search/api/
→ 注册 → 选择 Free Plan → 获取 API Key
```

### 2. 配置到项目（2 分钟）

**方法 A: 环境变量**
```bash
echo "BRAVE_API_KEY=BSA_your_key_here" >> backend/.env
```

**方法 B: 管理后台**
```
登录 → 设置 → WebSearch → Brave Search → 粘贴 Key → 保存
```

### 3. 重启项目（1 分钟）

```bash
docker-compose restart backend
```

### 4. 测试（1 分钟）

```
前端 → 启用 WebSearch → 发送消息 → 检查是否返回搜索结果
```

## ❓ 常见问题

### Q: Brave 免费额度够用吗？
**A**: 对于个人项目或小团队，2000次/月通常足够。如果不够，可以添加 SearXNG 作为备用。

### Q: 如何切换搜索引擎？
**A**: 在管理后台的 WebSearch 配置中切换，支持：
- Brave Search
- SearXNG
- 百度搜索
- 百度千帆 AI 搜索
- 自定义搜索引擎

### Q: 搜索结果质量如何？
**A**: Brave Search 质量很高，基于独立索引，不依赖 Google。
### Q: 可以同时使用多个搜索引擎吗？
**A**: 目前一次只能选择一个。但你可以实现负载均衡逻辑，轮流使用多个引擎。

### Q: 如何查看搜索日志？
**A**: 
```bash
docker logs palink-ai-backend-1 | grep "Web search"
```

## 💰 成本对比

### 使用 Brave 免费计划

| 场景 | 每月搜索次数 | 成本 |
|------|----------|------|
| **个人使用** | < 500 | $0 |
| **小团队（5人）** | < 2000 | $0 |
| **中型团队** | 2000-5000 | $0-15 |

### vs 其他方案

| 方案 | 每月成本 | 限制 |
|------|----------|------|
| **Brave 免费** | $0 | 2000次 |
| **Brave 付费** | $5-50 | 无限制 |
| **Google Custom Search** | $5/1000次 | 按量付费 |
| **SearXNG 自托管** | $5-10（服务器） | 无限制 |

## 🎉 总结

✅ **你的项目已经支持 Brave Search**
✅ **只需要配置 API Key**
✅ **免费额度：2000次/月**
✅ **可以添加多个备用搜索引擎**

### 立即开始

1. 获取 API Key：https://brave.com/search/api/
2. 配置到项目：`backend/.env` 或管理后台
3. 重启后端：`docker-compose restart backend`
4. 测试搜索功能
---

**需要帮助？** 告诉我你遇到的问题。
