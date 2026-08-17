# Palink-AI Claude Code 配置

这个目录包含了 Claude Code 的项目级配置和文档。

## 📁 文件结构

```
.claude/
├── README.md                  # 本文件 - 总览
│
├── MCP 配置（Model Context Protocol）
│   ├── MCP_QUICKSTART.md        # 🚀 快速启动（推荐先看这个）
│   ├── MCP_DECISION_TREE.md     # 🎯 决策树（帮你选择配置）
│   ├── MCP_INTEGRATION_GUIDE.md # 📖 完整指南（详细说明）
│   ├── .mcp.minimal.json     # 最小配置模板
│   ├── .mcp.recommended.json    # 推荐配置模板
│   └── .mcp.json.example        # 自定义配置示例
│
└── 安全配置
    ├── SECURITY_SETUP.md        # 🔒 安全配置总览
  └── AGENT_SECURITY.md        # 🤖 Agent 权限指南
```

## 🚀 快速开始

### 1. MCP 接入（可选但推荐）

让 Claude 拥有更强大的能力：记忆、文件访问、文档查询等。

```bash
# 方案 1: 推荐配置（适合 90% 用户）
cp .claude/.mcp.recommended.json .claude/.mcp.json

# 方案 2: 最小配置（只有记忆功能）
cp .claude/.mcp.minimal.json .claude/.mcp.json

# 重启 Claude Code
exit
claude
```

**详细说明**: 查看 `MCP_QUICKSTART.md`

### 2. 安全配置（已完成）

项目已经配置了基本的安全措施：
- ✅ API 凭证已移至环境变量
- ✅ 敏感文件已添加到 .gitignore
- ✅ MCP 服务器权限已限制

**详细说明**: 查看 `SECURITY_SETUP.md`

## 📖 文档说明

### MCP 相关

| 文档 | 用途 | 阅读时间 |
|------|------|--------|
| `MCP_QUICKSTART.md` | 3 步快速启动 | 2 分钟 |
| `MCP_DECISION_TREE.md` | 帮你选择配置 | 3 分钟 |
| `MCP_INTEGRATION_GUIDE.md` | 完整接入指南 | 10 分钟 |

### 安全相关

| 文档 | 用途 | 阅读时间 |
|------|------|----------|
| `SECURITY_SETUP.md` | 安全配置总览 | 5 分钟 |
| `AGENT_SECURITY.md` | Agent 权限管理 | 3 分钟 |

## 🎯 推荐阅读顺序

### 如果你想接入 MCP
1. `MCP_QUICKSTART.md` - 快速了解
2. `MCP_DECISION_TREE.md` - 选择配置
3. 复制配置文件并重启
4. `MCP_INTEGRATION_GUIDE.md` - 深入学习（可选）

### 如果你关心安全
1. `SECURITY_SETUP.md` - 了解已实施的安全措施
2. `AGENT_SECURITY.md` - 了解 Agent 权限管理

## ❓ 常见问题

### Q: MCP 是什么？
A: Model Context Protocol，让 Claude 能够安全地连接外部工具和数据源。

### Q: 必须接入 MCP 吗？
A: 不是必须的。不接入 MCP，Claude Code 仍然可以正常工作。

### Q: 推荐哪个配置？
A: 推荐使用 `.mcp.recommended.json`，包含：
- Memory（记忆）
- Filesystem（文件访问）
- Context7（文档查询）

### Q: 如何禁用 MCP？
A: 删除或重命名 `.claude/.mcp.json` 文件即可。

### Q: 安全吗？
A: 是的。所有配置都遵循最小权限原则：
- Filesystem MCP 只能访问项目目录
- 凭证存储在环境变量中
- 敏感文件已添加到 .gitignore

## 🔗 相关链接

- [MCP 官方文档](https://modelcontextprotocol.io/)
- [Claude Code 文档](https://docs.anthropic.com/claude/docs)
- [Everything Claude Code 插件](https://github.com/affaan-m/everything-claude-code)

## 📝 更新日志

- 2026-05-11: 创建 MCP 接入指南和安全配置文档
- 2026-05-11: 实施安全修复（移除硬编码凭证、限制 MCP 权限）

## 💡 提示

- 所有配置都是可选的，不会影响现有功能
- 可以随时启用或禁用 MCP
- 遇到问题可以查看对应的详细文档
