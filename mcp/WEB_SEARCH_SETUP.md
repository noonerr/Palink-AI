# MCP Web Search 配置指南

## 🎯 目标

为 Claude Code 添加免费的网络搜索功能，替代项目中昂贵的 WebSearch API。

## 📊 方案对比

| 方案 | 成本 | 免费额度 | 质量 | 推荐度 |
|------|------|----------|------|--------|
| **Brave Search** | 免费 | 2000次/月 | ⭐⭐⭐⭐⭐ | ✅ 推荐 |
| **Tavily** | 付费 | 1000次/月 | ⭐⭐⭐⭐⭐ | ⭐ 备选 |
| **Exa** | 付费 | 1000次/月 | ⭐⭐⭐⭐ | ⭐ 备选 |
| **项目现有 API** | 昂贵 | 无 | ⭐⭐⭐⭐⭐ | ❌ 太贵 |

## ✅ 已启用配置

我已经为你启用了 **Brave Search MCP**，配置如下：

```json
{
  "mcpServers": {
    "memory": { ... },
    "filesystem": { ... },
    "context7": { ... },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}"
      },
      "description": "Brave 搜索 - 免费额度：每月 2000 次查询"
    }
  }
}
```

## 🔑 获取 Brave API Key（免费）

### 步骤 1: 注册 Brave Search API

1. 访问：https://brave.com/search/api/
2. 点击 "Get Started" 或 "Sign Up"
3. 使用 GitHub 或 Email 注册
4. 选择 **Free Plan**（每月 2000 次免费查询）

### 步骤 2: 获取 API Key

1. 登录后进入 Dashboard
2. 找到 "API Keys" 部分
3. 点击 "Create API Key"
4. 复制生成的 API Key（格式：`BSA...`）

### 步骤 3: 配置环境变量

```bash
# 编辑环境变量文件
nano ~/.claude/.env
```

添加以下内容：
```bash
# Brave Search API Key（免费，每月 2000 次）
BRAVE_API_KEY=BSA_your_api_key_here
```

保存并退出（Ctrl+X, Y, Enter）

## 🚀 启用 MCP

### 重启 Claude Code

```bash
exit
claude
```

### 验证是否成功

启动时应该看到：
```
✓ MCP server 'memory' connected
✓ MCP server 'filesystem' connected
✓ MCP server 'context7' connected
✓ MCP server 'brave-search' connected
```

## 💡 使用方法

### 在 Claude Code 中使用

启用后，你可以直接在对话中要求搜索：

```
"搜索一下 React 19 的新特性"
"查找 FastAPI 的最佳实践"
"搜索 TypeScript 5.0 有什么变化"
```

Claude 会自动使用 Brave Search MCP 进行搜索。

### 与项目 WebSearch 的区别

| 特性 | 项目 WebSearch | MCP Brave Search |
|----|---------------|------------------|
| **使用场景** | 前端 UI 按钮 | Claude Code 对话 |
| **成本** | 昂贵 | 免费（2000次/月） |
| **集成方式** | 后端 API | MCP 协议 |
| **适用范围** | 用户聊天 | 开发辅助 |

**重要**：
- MCP 搜索只在 Claude Code 中可用（开发时使用）
- 项目的 WebSearch 功能保持不变（用户使用）
- 两者互不影响

## 📊 免费额度管理

### Brave Search 免费计划

- **每月额度**：2000 次查询
- **重置时间**：每月 1 号
- **超额后**：需要升级付费计划或等待下月

### 监控用量

1. 登录 Brave Search Dashboard
2. 查看 "Usage" 部分
3. 可以看到当月使用情况

### 节省额度的技巧

1. **只在需要时搜索**
   - 不要频繁搜索相同内容
   - 优先使用 Context7 查询文档

2. **使用 Memory MCP**
   - 让 Claude 记住搜索结果
   - 避免重复搜索

3. **合并查询**
   - 一次搜索多个关键词
   - 而不是分多次搜索

## 🔄 备选方案

### 如果 Brave 额度用完

#### 方案 1: Tavily Search（推荐）

```json
{
  "tavily": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-tavily"],
    "env": {
      "TAVILY_API_KEY": "${TAVILY_API_KEY}"
    },
    "description": "Tavily 搜索 - 1000次/月免费"
  }
}
```

注册：https://tavily.com/

#### 方案 2: Exa Search

```json
{
  "exa": {
    "command": "npx",
    "args": ["-y", "exa-mcp-server"],
    "env": {
      "EXA_API_KEY": "${EXA_API_KEY}"
    },
    "description": "Exa 搜索 - 1000次/月免费"
  }
}
```

注册：https://exa.ai/

#### 方案 3: 使用多个服务

同时配置多个搜索服务，轮流使用：

```json
{
  "mcpServers": {
    "brave-search": { ... },
    "tavily": { ... },
    "exa": { ... }
  }
}
```

## 🔒 安全性

### API Key 保护

- ✅ 存储在 `~/.claude/.env`（已添加到 .gitignore）
- ✅ 不会提交到 Git
- ✅ 只在本地使用

### 权限范围

- Brave Search MCP 只能搜索网络
- 无法访问你的文件或代码
- 无法修改任何内容

## ❓ 常见问题

### Q: 会影响项目的 WebSearch 功能吗？
**A**: 不会。MCP 搜索只在 Claude Code 中使用，项目的 WebSearch API 保持不变。

### Q: 免费额度够用吗？
**A**: 对于开发使用，2000次/月通常足够。如果不够，可以添加其他免费服务。

### Q: 搜索质量如何？
**A**: Brave Search 质量很高，基于独立索引，不依赖 Google。

### Q: 如何禁用搜索？
**A**: 编辑 `.claude/.mcp.json`，删除或注释掉 `brave-search` 部分。

### Q: 可以同时使用多个搜索服务吗？
**A**: 可以。Claude 会根据需要选择合适的服务。
## 📝 下一步

### 1. 获取 API Key（5 分钟）

```bash
# 访问 Brave Search API
https://brave.com/search/api/

# 注册并获取免费 API Key
```

### 2. 配置环境变量

```bash
# 编辑 .env 文件
nano ~/.claude/.env

# 添加
BRAVE_API_KEY=BSA_your_key_here
```

### 3. 重启 Claude Code

```bash
exit
claude
```

### 4. 测试搜索

```
"搜索一下 React 19 的新特性"
```

## 💰 成本对比

### 每月 2000 次搜索

| 服务 | 成本 |
|------|------|
| **Brave Search (MCP)** | $0（免费） |
| **项目现有 API** | $50-200（估算） |
| **节省** | **100%** |

### 年度节省

- 使用 MCP：$0
- 使用现有 API：$600-2400
- **年度节省：$600-2400**

## 🎉 总结

✅ **已启用**：
- Memory MCP（记忆）
- Filesystem MCP（文件访问）
- Context7 MCP（文档查询）
- Brave Search MCP（网络搜索）

⏳ **待完成**：
1. 获取 Brave API Key
2. 配置环境变量
3. 重启 Claude Code

💡 **优势**：
- 免费（每月 2000 次）
- 不影响项目功能
- 质量高
- 易于扩展

---

**需要帮助？** 查看 `mcp/MCP_INTEGRATION_GUIDE.md` 或询问我。
