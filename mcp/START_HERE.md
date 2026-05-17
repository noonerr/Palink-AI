# 🚀 MCP 已启用 - 还差最后一步！

## ✅ 已完成

- ✅ MCP 配置文件已创建（`.claude/.mcp.json`）
- ✅ 环境变量文件已准备（`~/.claude/.env`）
- ✅ 包含 4 个 MCP 服务：
  - Memory（记忆）
  - Filesystem（文件访问）
  - Context7（文档查询）
  - **Brave Search（网络搜索）** ⭐

## ⏳ 还需要做什么

### 获取免费的 Brave Search API Key（5 分钟）

#### 步骤 1: 注册 Brave Search API

1. 打开浏览器，访问：
   ```
   https://brave.com/search/api/
   ```

2. 点击 **"Get Started"** 或 **"Sign Up"**

3. 选择注册方式：
   - GitHub 账号（推荐，快速）
   - Email 注册

4. 选择 **Free Plan**
   - ✅ 每月 2000 次免费查询
   - ✅ 无需信用卡
   - ✅ 永久免费

#### 步骤 2: 获取 API Key

1. 登录后进入 Dashboard
2. 找到 **"API Keys"** 部分
3. 点击 **"Create API Key"**
4. 复制生成的 Key（格式：`BSA...`）

#### 步骤 3: 配置 API Key

**方法 1: 使用命令行（推荐）**

```bash
# 编辑环境变量文件
nano ~/.claude/.env

# 找到这一行：
BRAVE_API_KEY=your_brave_api_key_here

# 替换为你的真实 API Key：
BRAVE_API_KEY=BSA_your_actual_key_here

# 保存并退出（Ctrl+X, Y, Enter）
```

**方法 2: 使用文本编辑器**

1. 打开文件：`C:\Users\Pall\.claude\.env`
2. 找到 `BRAVE_API_KEY=your_brave_api_key_here`
3. 替换为你的真实 API Key
4. 保存文件

#### 步骤 4: 重启 Claude Code

```bash
exit
claude
```

## ✅ 验证是否成功

重启后，你应该看到：

```
✓ MCP server 'memory' connected
✓ MCP server 'filesystem' connected
✓ MCP server 'context7' connected
✓ MCP server 'brave-search' connected
```

如果看到 4 个 ✓，说明全部成功！

## 🎯 如何使用

### 在 Claude Code 中搜索

启用后，直接在对话中要求搜索：

```
"搜索一下 React 19 的新特性"
"查找 TypeScript 5.0 有什么变化"
"搜索 FastAPI 异步最佳实践"
```

Claude 会自动使用 Brave Search 进行搜索。

### 与项目 WebSearch 的区别

| 特性 | 项目 WebSearch | MCP Brave Search |
|------|-------|----------|
| **使用场景** | 前端 UI（用户使用） | Claude Code（开发使用） |
| **成本** | 昂贵 💰 | 免费 ✅ |
| **每月额度** | 按量付费 | 2000 次免费 |
| **适用范围** | 生产环境 | 开发环境 |
**重要**：两者互不影响，各司其职！

## 💰 成本节省

### 开发阶段使用 MCP 搜索

- **每月成本**：$0（免费 2000 次）
- **vs 使用项目 API**：$50-200/月
- **年度节省**：$600-2400

### 免费额度管理

- **每月额度**：2000 次查询
- **重置时间**：每月 1 号
- **监控用量**：https://brave.com/search/api/dashboard

**节省技巧**：
1. 优先使用 Context7 查询技术文档
2. 使用 Memory 记住搜索结果
3. 避免重复搜索相同内容

## ❓ 常见问题

### Q: 如果不想获取 API Key 怎么办？
**A**: 可以暂时不配置，其他 3 个 MCP（Memory、Filesystem、Context7）仍然可用。

### Q: 会影响项目的 WebSearch 功能吗？
**A**: 完全不会。MCP 只在 Claude Code 中使用，项目功能保持不变。

### Q: 免费额度用完了怎么办？
**A**: 可以添加其他免费搜索服务（Tavily、Exa），或等待下月重置。

### Q: 搜索质量如何？
**A**: Brave Search 质量很高，基于独立索引，不依赖 Google。

## 📚 详细文档

- **完整设置指南**：`mcp/WEB_SEARCH_SETUP.md`
- **MCP 总览**：`mcp/README.md`
- **快速参考**：`mcp/QUICK_REFERENCE.md`

## 🎉 总结

你现在有了：
- ✅ 免费的网络搜索（2000次/月）
- ✅ 跨会话记忆
- ✅ 项目文件访问
- ✅ 技术文档查询

只需要：
1. 获取 Brave API Key（5 分钟）
2. 配置到 `.env` 文件
3. 重启 Claude Code

**开始使用**：https://brave.com/search/api/

---

**需要帮助？** 查看 `mcp/WEB_SEARCH_SETUP.md` 获取详细说明。
