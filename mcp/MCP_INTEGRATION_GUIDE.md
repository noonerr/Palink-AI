# MCP (Model Context Protocol) 接入指南

## 什么是 MCP？

MCP 是 Anthropic 推出的开放协议，让 AI 助手能够安全地连接外部数据源和工具。

### 核心概念

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Claude    │ ◄─MCP──►│ MCP Server  │ ◄──────►│  数据源     │
│   (Client)  │         │  (中间层)   │         │ (GitHub等)  │
└───────┘         └─────────────┘         └────────┘
```

- **MCP Client**: Claude Code（你正在使用的）
- **MCP Server**: 提供特定功能的服务（如 GitHub、文件系统）
- **数据源**: 实际的数据或服务（API、数据库、文件等）

## 为什么需要 MCP？

### 传统方式的问题
```typescript
// ❌ 传统方式：Claude 直接调用 API
async function getGitHubIssues() {
  const response = await fetch('https://api.github.com/repos/...');
  // Claude 需要知道 GitHub API 的所有细节
}
```

### MCP 方式的优势
```typescript
// ✅ MCP 方式：Claude 通过标准协议调用
// MCP Server 处理所有 API 细节
await mcp.call('github', 'list_issues', { repo: 'owner/repo' });
```

**优势**：
- 🔒 **安全**: 凭证由 MCP Server 管理，不暴露给 Claude
- 🔌 **标准化**: 统一的接口，易于扩展
- 🎯 **专注**: Claude 只需知道"做什么"，不需要知道"怎么做"

## 适合你项目的 MCP 服务器

### 1. **文件系统 MCP** (推荐首选)

**用途**: 让 Claude 安全地访问项目文件

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\Pall\\OneDrive\\桌面\\Palink-AI"
      ],
      "description": "项目文件访问"
    }
  }
}
```

**功能**：
- 读取文件内容
- 列出目录
- 搜索文件
- **限制**: 只能访问指定目录

**使用场景**：
- 分析项目结构
- 查找特定文件
- 读取配置文件

### 2. **GitHub MCP** (如果你用 GitHub)

**用途**: 管理 GitHub 仓库、PR、Issues

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token_here"
      },
      "description": "GitHub 操作"
    }
  }
}
```

**功能**：
- 创建/查看 Issues
- 管理 Pull Requests
- 搜索代码
- 查看提交历史

**使用场景**：
- 自动创建 Issue
- 审查 PR
- 搜索代码示例

### 3. **Memory MCP** (推荐)

**用途**: 跨会话记忆，让 Claude 记住之前的对话

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "持久化记忆"
    }
  }
}
```

**功能**：
- 存储关键信息
- 跨会话检索
- 上下文关联

**使用场景**：
- 记住项目约定
- 保存常用命令
- 记录决策历史

### 4. **Context7 MCP** (文档查询)

**用途**: 实时查询技术文档

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "description": "技术文档查询"
    }
  }
}
```

**功能**：
- 查询 React、Vue、TypeScript 等官方文档
- 获取最新 API 信息
- 查找最佳实践

**使用场景**：
- 学习新 API
- 查找正确用法
- 解决技术问题

## 接入步骤

### 方案 A: 项目级配置（推荐）

**适用**: 只在当前项目使用 MCP

#### 步骤 1: 创建配置文件

```bash
# 在项目根目录创建
nano .claude/.mcp.json
```

#### 步骤 2: 添加配置

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\Pall\\OneDrive\\桌面\\Palink-AI"
      ],
      "description": "项目文件访问（限制在当前目录）"
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "跨会话记忆"
    }
  }
}
```

#### 步骤 3: 重启 Claude Code
```bash
# 退出当前会话，重新启动
claude
```

### 方案 B: 全局配置

**适用**: 所有项目都使用相同的 MCP

#### 步骤 1: 编辑全局配置

```bash
nano ~/.claude/settings.json
```

#### 步骤 2: 添加 MCP 配置

```json
{
  "env": {},
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "全局记忆"
  }
  },
  "includeCoAuthoredBy": false,
  "enabledPlugins": {
    "everything-claude-code@everything-claude-code": true
  }
}
```

## 推荐配置（针对你的项目）

### 最小配置（安全起步）

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "记住项目上下文"
  }
  }
}
```

**优点**：
- ✅ 无需额外配置
- ✅ 无安全风险
- ✅ 立即可用

### 标准配置（推荐）

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\Pall\\OneDrive\\桌面\\Palink-AI"
      ],
      "description": "项目文件访问"
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "持久化记忆"
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "description": "技术文档查询"
    }
  }
}
```

**优点**：
- ✅ 覆盖常用场景
- ✅ 安全可控
- ✅ 提升开发效率

### 完整配置（高级用户）

如果你使用 GitHub 并需要更多功能：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\Pall\\OneDrive\\桌面\\Palink-AI"
      ]
    },
    "memory": {
      "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

**注意**: GitHub token 需要在 `~/.claude/.env` 中配置：

```bash
# ~/.claude/.env
GITHUB_TOKEN=ghp_your_token_here
```

## 验证 MCP 是否工作

### 方法 1: 查看启动日志

```bash
claude
# 启动时会显示：
# ✓ MCP server 'memory' connected
# ✓ MCP server 'filesystem' connected
```

### 方法 2: 测试功能

```bash
# 在 Claude Code 中测试
/help mcp

# 或者直接问 Claude
"列出当前项目的所有 TypeScript 文件"
```

如果 filesystem MCP 工作正常，Claude 会使用 MCP 而不是 Bash 命令。

## 常见问题

### Q1: MCP Server 启动失败？

**原因**: 可能是 Node.js 版本过低或网络问题

**解决**:
```bash
# 检查 Node.js 版本（需要 >= 18）
node --version

# 手动安装 MCP Server
npx -y @modelcontextprotocol/server-memory
```

### Q2: 路径配置错误？

**Windows 路径格式**:
```json
// ✅ 正确
"C:\\Users\\Pall\\OneDrive\\桌面\\Palink-AI"

// ❌ 错误
"C:/Users/Pall/OneDrive/桌面/Palink-AI"
```

### Q3: 如何禁用某个 MCP？

**临时禁用**: 在配置中注释掉
```json
{
  "mcpServers": {
    // "filesystem": { ... }  // 已禁用
    "memory": { ... }
  }
}
```

**永久删除**: 直接删除配置项

### Q4: MCP 会影响性能吗？

**不会**。MCP Server 是按需启动的：
- 只在需要时才调用
- 不使用时不占用资源
- 比直接调用 API 更高效

## 安全建议

### ✅ 推荐做法

1. **限制文件系统访问**
   ```json
   // 只允许访问项目目录
   "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"]
   ```

2. **使用环境变量存储凭证**
   ```json
   "env": {
     "GITHUB_TOKEN": "${GITHUB_TOKEN}"  // 从 .env 读取
   }
   ```

3. **最小权限原则**
   - 只启用真正需要的 MCP
   - 定期审查配置

### ❌ 避免做法

1. **不要给文件系统 MCP 根目录访问**
   ```json
   // ❌ 危险
   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/"]
   ```

2. **不要在配置文件中硬编码 Token**
   ```json
   // ❌ 不安全
   "env": {
     "GITHUB_TOKEN": "ghp_hardcoded_token"
   }
   ```

3. **不要启用不需要的外部 MCP**
   - Vercel、Cloudflare 等外部 MCP 会发送数据到远程服务器
   - 只在确实需要时启用

## 下一步

### 立即开始（推荐）

1. **创建最小配置**
   ```bash
   cp .claude/.mcp.json.example .claude/.mcp.json
   ```

2. **重启 Claude Code**
   ```bash
   claude
   ```

3. **测试功能**
   ```
   "帮我记住：这个项目使用 React + TypeScript + FastAPI"
   ```

### 进阶使用

- 探索更多 MCP Server: https://github.com/modelcontextprotocol/servers
- 自定义 MCP Server: https://modelcontextprotocol.io/docs
- 集成到 CI/CD 流程

## 总结

| MCP Server | 优先级 | 用途 | 安全性 |
|-----------|--------|------|--------|
| memory | ⭐⭐⭐ | 跨会话记忆 | ✅ 高 |
| filesystem | ⭐⭐⭐ | 项目文件访问 | ✅ 高（限制目录） |
| context7 | ⭐⭐ | 文档查询 | ✅ 高 |
| github | ⭐ | GitHub 操作 | ⚠️ 中（需要 Token） |

**建议**: 从 `memory` 开始，逐步添加其他 MCP。
