# SearXNG 反爬虫风险分析与解决方案

## 🚨 风险分析

### 你的担心是对的

**SearXNG 确实可能被识别为爬虫**，因为：

1. **频繁请求多个搜索引擎**
   ```
   一次 SearXNG 搜索 = 同时查询 5-10 个搜索引擎
   → Google、Bing、DuckDuckGo 等都会收到请求
   → 来自同一个 IP（你的香港服务器）
   ```

2. **请求特征明显**
   - User-Agent 可能暴露是 SearXNG
   - 请求模式规律（自动化特征）
   - 没有浏览器指纹（cookies、JavaScript 等）

3. **可能的后果**
   - ⚠️ Google：触发验证码（CAPTCHA）
   - ⚠️ Bing：临时封禁 IP
   - ⚠️ 百度：要求验证码
   - ⚠️ 其他引擎：速率限制

### 香港服务器的特殊风险

| 风险因素 | 说明 |
|---------|------|
| **IP 信誉** | 香港 VPS IP 段常被滥用，可能已在黑名单 |
| **地理位置** | 某些服务对香港 IP 更严格（防止代理） |
| **共享 IP** | VPS 可能与其他用户共享 IP 段 |
| **GFW 相关** | 某些服务可能对中国周边 IP 更警惕 |

## 📊 实际风险等级

### 不同搜索引擎的反爬虫强度

| 搜索引擎 | 反爬虫强度 | 被封风险 | 说明 |
|---------|-----------|---------|------|
| **Google** | 🔴 很高 | 高 | 最严格，容易触发验证码 |
| **百度** | 🔴 很高 | 高 | 对境外 IP 特别严格 |
| **Bing** | 🟡 中等 | 中 | 有速率限制，但相对宽松 |
| **DuckDuckGo** | 🟢 低 | 低 | 对隐私友好，限制较少 |
| **Brave Search** | 🟢 低 | 低 | 官方 API，不会被封 |
| **Qwant** | 🟢 低 | 低 | 欧洲引擎，限制少 |

### 使用场景风险评估

| 场景 | 每日查询量 | 被封风险 | 建议 |
|------|-----------|---------|------|
| **个人使用** | < 50 | 🟢 低 | 可以用 |
| **小团队** | 50-200 | 🟡 中 | 需要优化 |
| **生产环境** | > 200 | 🔴 高 | 不推荐 |

## ✅ 解决方案

### 方案 1: 只用官方 API（推荐）

**使用 Brave Search API**，完全避免反爬虫问题：

```yaml
# 不用 SearXNG，直接用 Brave API
WebSearch 配置:
  引擎: Brave Search
  API Key: BSA_your_key
```

**优点**：
- ✅ 官方 API，不会被封
- ✅ 稳定可靠
- ✅ 免费 2000次/月
- ✅ 无需担心 IP 问题

**缺点**：
- ⚠️ 有查询限制（2000次/月）

**适合**：
- 查询量 < 2000次/月
- 需要稳定性
- 不想处理反爬虫问题

---

### 方案 2: SearXNG + 反爬虫优化

如果你坚持用 SearXNG，需要做这些优化：

#### 2.1 只使用友好的搜索引擎

```yaml
# searxng/settings.yml
engines:
  # ❌ 不要用这些（反爬虫严格）
  # - name: google
  # - name: baidu
  
  # ✅ 只用这些（反爬虫宽松）
  - name: duckduckgo
    weight: 2
  - name: brave
    weight: 2
  - name: qwant
    weight: 1
  - name: startpage  # 代理 Google，但更安全
    weight: 1
  - name: github
    weight: 2
  - name: stackoverflow
    weight: 2
```

#### 2.2 配置请求延迟

```yaml
# searxng/settings.yml
outgoing:
  request_timeout: 10.0
  max_request_timeout: 15.0
  
  # 添加随机延迟（模拟人类行为）
  pool_connections: 10
  pool_maxsize: 20
  
  # 限制并发请求
  max_redirects: 5
```

#### 2.3 使用代理池（高级）

```yaml
# searxng/settings.yml
outgoing:
  proxies:
    http:
      - http://proxy1:8080
      - http://proxy2:8080
      - http://proxy3:8080
    https:
      - http://proxy1:8080
      - http://proxy2:8080
      - http://proxy3:8080
  
  # 随机选择代理
  using_tor_proxy: false
```

#### 2.4 自定义 User-Agent

```yaml
# searxng/settings.yml
outgoing:
  useragent_suffix: ""  # 移除 SearXNG 标识
  
  # 使用真实浏览器 UA
  request_headers:
    User-Agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
```

#### 2.5 启用缓存

```yaml
# searxng/settings.yml
search:
  # 缓存搜索结果（减少实际请求）
  default_lang: "zh-CN"
  
server:
  # 启用结果缓存
  limiter: true
  
  # 限制每个 IP 的请求频率
  rate_limit:
    window: 60  # 60秒
    max_requests: 10  # 最多10次
```

---

### 方案 3: 混合方案（最佳）

**Brave API（主力） + SearXNG（备用）**

```python
# backend/app/services/web_search.py

async def search_web(query: str, num_results: int = 5) -> list:
    config = _get_raw_config()
    
    # 优先使用 Brave API（官方，不会被封）
    if config.get("brave_api_key"):
      try:
            results = await _search_brave(query, config["brave_api_key"], num_results)
            if results:
           logger.info(f"Used Brave API for search: {query}")
                return results
      except Exception as e:
            logger.warning(f"Brave API failed, falling back to SearXNG: {e}")
    
    # 备用：SearXNG（只用友好的引擎）
    if config.get("searxng_url"):
        try:
          results = await _search_searxng(query, config["searxng_url"], num_results)
            logger.info(f"Used SearXNG for search: {query}")
        return results
        except Exception as e:
            logger.error(f"SearXNG also failed: {e}")
    
    return []
```

**优点**：
- ✅ Brave API 稳定可靠（2000次/月）
- ✅ SearXNG 作为备用（超过限额时使用）
- ✅ 降低 SearXNG 的请求量（减少被封风险）

---

### 方案 4: 使用代理服务

如果你真的需要大量搜索，可以使用代理服务：

#### 4.1 住宅代理（推荐）

```yaml
# 使用住宅 IP 代理（模拟真实用户）
代理服务商:
  - Bright Data (luminati.io)
  - Smartproxy (smartproxy.com)
  - Oxylabs (oxylabs.io)

成本: $50-200/月
优点: 不会被封，IP 池大
缺点: 贵
```

#### 4.2 轮换代理

```python
# 使用代理池轮换 IP
import random

PROXY_POOL = [
    "http://proxy1:8080",
    "http://proxy2:8080",
    "http://proxy3:8080",
]

async def _search_with_proxy(query: str):
    proxy = random.choice(PROXY_POOL)
    # 使用代理发送请求
```

---

## 🎯 针对你的情况的建议

### 你的情况：
- ✅ 有香港服务器
- ⚠️ 担心被封
- ❓ 查询量未知

### 我的推荐：

#### 推荐方案：Brave API + SearXNG（只用友好引擎）

**配置步骤**：

1. **主力：Brave Search API**
   ```
   - 免费 2000次/月
   - 官方 API，不会被封
   - 质量高
   ```

2. **备用：SearXNG（优化配置）**
   ```yaml
   # 只用这些引擎（不会被封）
   engines:
     - duckduckgo
     - brave
     - qwant
     - github
     - stackoverflow
   
   # 不用这些（容易被封）
   # - google
   # - baidu
   # - bing
   ```

3. **添加缓存层**
   ```python
   # 缓存搜索结果 1 小时
   # 减少实际请求次数
   ```

4. **添加速率限制**
   ```python
   # 每个用户每小时最多 10 次搜索
   # 防止滥用
   ```

**预期效果**：
- ✅ 每月 2000 次高质量搜索（Brave）
- ✅ 超过限额后自动切换到 SearXNG
- ✅ SearXNG 只用友好引擎，被封风险低
- ✅ 缓存减少重复请求

---

## 📊 风险对比

| 方案 | 被封风险 | 成本 | 查询限制 | 推荐度 |
|------|---------|------|-------|--------|
| **只用 Brave API** | 🟢 无 | $0 | 2000次/月 | ⭐⭐⭐⭐ |
| **Brave + SearXNG（优化）** | 🟢 低 | $5-10/月 | 无限制 | ⭐⭐⭐⭐⭐ |
| **SearXNG（含 Google）** | 🔴 高 | $5-10/月 | 无限制 | ⭐⭐ |
| **SearXNG + 代理池** | 🟢 低 | $50-200/月 | 无限制 | ⭐⭐⭐ |

## 🛡️ 防封最佳实践

### 1. 监控被封情况

```python
# 添加错误监控
async def _search_with_monitoring(query: str):
    try:
      results = await _search(query)
        return results
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:  # 速率限制
            logger.warning(f"Rate limited by search engine")
            # 切换到备用引擎
        elif e.response.status_code == 403:  # 被封
            logger.error(f"IP blocked by search engine")
        # 发送告警
```

### 2. 自动降级

```python
# 被封后自动切换引擎
FALLBACK_CHAIN = [
    "brave",      # 优先
    "duckduckgo", # 备用1
    "qwant",      # 备用2
    "startpage",  # 备用3
]
```

### 3. 添加重试机制

```python
# 失败后等待重试
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=10)
)
async def _search_with_retry(query: str):
    return await _search(query)
```

### 4. 使用 Tor（终极方案）

```yaml
# searxng/settings.yml
outgoing:
  using_tor_proxy: true
  tor_proxy_url: "socks5://127.0.0.1:9050"
```

**优点**：
- ✅ IP 不断变化
- ✅ 很难被封

**缺点**：
- ⚠️ 速度慢
- ⚠️ 某些网站屏蔽 Tor

---

## 🎉 最终建议

### 对于你的香港服务器

**推荐配置**：

```yaml
主力: Brave Search API
  - 2000次/月免费
  - 不会被封
  - 质量高

备用: SearXNG（只用友好引擎）
  - DuckDuckGo
  - Brave
  - Qwant
  - GitHub
  - Stack Overflow
  
优化:
  - 添加缓存（1小时）
  - 添加速率限制（10次/小时/用户）
  - 监控被封情况
```

**预期**：
- ✅ 被封风险：低
- ✅ 成本：$5-10/月（服务器）
- ✅ 查询限制：基本无限制
- ✅ 质量：高

**不推荐**：
- ❌ SearXNG 使用 Google/百度（被封风险高）
- ❌ 高频率请求（容易触发限制）
- ❌ 不加缓存（浪费配额）

---

**需要我帮你配置吗？** 我可以帮你：
1. 配置 Brave + SearXNG 混合方案
2. 添加缓存和速率限制
3. 设置监控和告警
