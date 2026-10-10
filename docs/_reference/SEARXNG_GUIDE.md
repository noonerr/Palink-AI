# SearXNG 完全指南

## 🤔 什么是 SearXNG？

**SearXNG** 是一个免费、开源的**元搜索引擎**（metasearch engine）。

### 元搜索引擎是什么？

简单来说：
- **普通搜索引擎**（Google、Bing）：自己爬取网页，建立索引
- **元搜索引擎**（SearXNG）：聚合多个搜索引擎的结果

```
用户查询 "React 19"
    ↓
SearXNG 同时查询：
    ├─ Google
    ├─ Bing
    ├─ DuckDuckGo
    ├─ Wikipedia
    └─ GitHub
    ↓
聚合并去重
    ↓
返回综合结果
```

## 🎯 核心特点

### 1. 完全免费
- ✅ 无 API 费用
- ✅ 无查询次数限制
- ✅ 无需注册账号
- ✅ 开源（AGPLv3 许可证）

### 2. 隐私保护
- ✅ 不追踪用户
- ✅ 不记录搜索历史
- ✅ 不使用 Cookie
- ✅ 可以自托管（数据完全掌控）

### 3. 聚合多个搜索引擎
支持 **70+ 搜索引擎**，包括：

| 类别 | 支持的引擎 |
|------|-------|
| **通用搜索** | Google, Bing, DuckDuckGo, Brave, Qwant |
| **开发相关** | GitHub, Stack Overflow, GitLab |
| **学术** | Google Scholar, arXiv, PubMed |
| **视频** | YouTube, Vimeo, Dailymotion |
| **图片** | Google Images, Bing Images, Unsplash |
| **新闻** | Google News, Bing News |
| **地图** | OpenStreetMap, Google Maps |
| **购物** | Amazon, eBay |
| **社交** | Reddit, Twitter |

### 4. 高度可定制
- 选择使用哪些搜索引擎
- 设置每个引擎的权重
- 自定义界面主题
- 配置搜索类别

## 💰 成本对比

| 方案 | 每月成本 | 查询限制 | 质量 |
|------|----------|--------|------|
| **SearXNG（自托管）** | $5-10（服务器） | 无限制 | ⭐⭐⭐⭐ |
| **SearXNG（公共实例）** | $0 | 无限制 | ⭐⭐⭐ |
| **Brave Search 免费** | $0 | 2000次/月 | ⭐⭐⭐⭐⭐ |
| **Google Custom Search** | $5/1000次 | 按量付费 | ⭐⭐⭐⭐⭐ |

## 🚀 使用方式

### 方式 1: 使用公共实例（最简单）

有很多免费的公共 SearXNG 实例可以直接使用：

```python
# 在你的项目中配置
SEARXNG_URL = "https://search.bus-hit.me"  # 公共实例
```

**公共实例列表**：
- https://search.bus-hit.me
- https://searx.be
- https://searx.tiekoetter.com
- https://search.sapti.me
- 更多：https://searx.space/

**优点**：
- ✅ 零成本
- ✅ 零配置
- ✅ 立即可用

**缺点**：
- ⚠️ 可能不稳定（依赖他人维护）
- ⚠️ 可能有速率限制
- ⚠️ 隐私风险（虽然 SearXNG 不记录，但你不能 100% 确定）

### 方式 2: Docker 自托管（推荐）

在你的服务器上运行 SearXNG：

```yaml
# docker-compose.yml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    ports:
      - "8080:8080"
    volumes:
      - ./searxng:/etc/searxng
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080
    restart: unless-stopped
```

启动：
```bash
docker-compose up -d searxng
```

**优点**：
- ✅ 完全掌控
- ✅ 无限制
- ✅ 隐私保护
- ✅ 可定制

**缺点**：
- ⚠️ 需要服务器（$5-10/月）
- ⚠️ 需要维护

### 方式 3: 集成到 Palink-AI

你的项目已经支持 SearXNG！

**配置方法**：

1. **启动 SearXNG**（如果自托管）：
   ```bash
   docker-compose up -d searxng
   ```

2. **在管理后台配置**：
   ```
   登录 → 设置 → WebSearch 配置
   → 选择 SearXNG
   → 填写 URL: http://localhost:8080
   → 保存
   ```

3. **或者使用公共实例**：
   ```
   URL: https://search.bus-hit.me
   ```

## 📊 SearXNG vs Brave Search

### 适合 SearXNG 的场景

✅ **查询量大**（> 2000次/月）
✅ **需要完全免费**
✅ **关心隐私**
✅ **需要聚合多个来源**
✅ **有服务器资源**

### 适合 Brave Search 的场景

✅ **查询量小**（< 2000次/月）
✅ **需要高质量结果**
✅ **不想维护服务器**
✅ **需要官方支持**

### 混合方案（推荐）

同时配置两者，根据情况切换：

```
日常使用 → SearXNG（免费无限制）
高质量需求 → Brave Search（质量更好）
```

## 🔧 集成到 Palink-AI

### 方案 A: 使用公共实例（5 分钟）

```bash
# 1. 在管理后台配置
登录 → 设置 → WebSearch
→ 引擎: SearXNG
→ URL: https://search.bus-hit.me
→ 保存

# 2. 测试
前端 → 启用 WebSearch → 搜索测试
```

### 方案 B: Docker 自托管（15 分钟）

**步骤 1: 添加到 docker-compose.yml**

```yaml
services:
  # ... 现有服务 ...

  searxng:
    image: searxng/searxng:latest
    container_name: palink-ai-searxng
    ports:
      - "8080:8080"
    volumes:
      - ./searxng:/etc/searxng
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080
    restart: unless-stopped
    networks:
      - palink-network
```
**步骤 2: 创建配置文件**

```bash
mkdir -p searxng
cat > searxng/settings.yml << 'EOF'
use_default_settings: true
server:
  secret_key: "your-secret-key-here"  # 随机生成
  limiter: false  # 禁用速率限制
  image_proxy: true
search:
  safe_search: 0
  autocomplete: "google"
  default_lang: "zh-CN"
engines:
  - name: google
    weight: 1
  - name: bing
    weight: 1
  - name: duckduckgo
    weight: 1
  - name: brave
    weight: 1
  - name: github
    weight: 2  # 开发相关，权重更高
  - name: stackoverflow
    weight: 2
EOF
```

**步骤 3: 启动服务**

```bash
docker-compose up -d searxng
```

**步骤 4: 验证**

```bash
# 测试 SearXNG 是否正常
curl "http://localhost:8080/search?q=test&format=json"
```

**步骤 5: 配置到项目**

```
管理后台 → WebSearch 配置
→ 引擎: SearXNG
→ URL: http://searxng:8080  # Docker 内部网络
→ 保存
```

## 🎨 高级配置

### 1. 自定义搜索引擎

```yaml
# searxng/settings.yml
engines:
  # 只使用开发相关的引擎
  - name: github
    weight: 3
    shortcut: gh
  - name: stackoverflow
    weight: 3
    shortcut: so
  - name: mdn
    weight: 2
  - name: npm
    weight: 2
  - name: pypi
    weight: 2
```

### 2. 设置搜索类别

```yaml
categories_as_tabs:
  general:
    - google
    - bing
    - duckduckgo
  it:
    - github
    - stackoverflow
    - gitlab
  science:
    - google scholar
    - arxiv
```

### 3. 启用自动完成

```yaml
search:
  autocomplete: "google"  # 或 "duckduckgo", "wikipedia"
```

### 4. 配置代理（如果需要）

```yaml
outgoing:
  request_timeout: 10.0
  proxies:
    http: http://proxy:8080
    https: http://proxy:8080
```

## 📊 性能对比

### 响应时间

| 引擎 | 平均响应时间 |
|------|-------------|
| **Brave Search** | 200-500ms |
| **SearXNG（自托管）** | 500-1500ms |
| **SearXNG（公共实例）** | 1000-3000ms |

**为什么 SearXNG 慢？**
- 需要查询多个搜索引擎
- 需要聚合和去重结果
- 公共实例可能有负载

**优化方法**：
1. 减少查询的引擎数量
2. 使用自托管实例
3. 添加缓存层

### 结果质量

| 引擎 | 质量 | 说明 |
|------|------|------|
| **Brave Search** | ⭐⭐⭐⭐⭐ | 独立索引，质量高 |
| **SearXNG** | ⭐⭐⭐⭐ | 聚合多个来源，覆盖广 |
| **Google** | ⭐⭐⭐⭐⭐ | 最好，但有隐私问题 |

## 🔒 隐私对比

| 引擎 | 追踪 | 记录 | 隐私评分 |
|------|------|------|----------|
| **SearXNG（自托管）** | ❌ | ❌ | ⭐⭐⭐⭐⭐ |
| **Brave Search** | ❌ | ❌ | ⭐⭐⭐⭐⭐ |
| **DuckDuckGo** | ❌ | ⭐⭐⭐⭐ |
| **Google** | ✅ | ✅ | ⭐ |

## 💡 推荐方案

### 对于 Palink-AI 项目

**方案 1: Brave + SearXNG 公共实例**（推荐新手）

```
主力: Brave Search（2000次/月免费）
备用: SearXNG 公共实例（无限制）
```

**优点**：
- 零成本
- 零维护
- 高质量 + 无限制

**方案 2: Brave + SearXNG 自托管**（推荐生产环境）

```
主力: Brave Search（高质量）
备用: SearXNG 自托管（无限制 + 隐私）
```

**优点**：
- 完全掌控
- 高质量 + 无限制
- 隐私保护

**成本**：$5-10/月（服务器）

**方案 3: 纯 SearXNG 自托管**（推荐高查询量）

```
唯一: SearXNG 自托管
```

**优点**：
- 完全免费（除服务器）
- 无限制
- 完全掌控

**适合**：查询量 > 2000次/月

## 📝 快速决策

### 你应该选择 SearXNG 如果：

- ✅ 每月查询 > 2000 次
- ✅ 需要完全免费
- ✅ 关心隐私
- ✅ 有服务器资源
- ✅ 愿意维护

### 你应该选择 Brave Search 如果：

- ✅ 每月查询 < 2000 次
- ✅ 需要高质量结果
- ✅ 不想维护服务器
- ✅ 需要稳定性

### 你应该两者都用如果：

- ✅ 想要最佳体验
- ✅ 需要备用方案
- ✅ 查询量不确定

## 🎉 总结

**SearXNG 是什么？**
- 免费开源的元搜索引擎
- 聚合 70+ 搜索引擎
- 无限制、重隐私

**适合你吗？**
- 如果查询量大 → 是
- 如果关心隐私 → 是
- 如果想零成本 → 是
- 如果不想维护 → 考虑公共实例

**如何开始？**
1. 最简单：使用公共实例（5 分钟）
2. 推荐：Docker 自托管（15 分钟）
3. 最佳：Brave + SearXNG 混合

---

**需要帮助？** 告诉我你想用哪种方案，我帮你配置。
