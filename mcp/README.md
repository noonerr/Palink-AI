# MCP 配置与文档

这个文件夹包含了 MCP (Model Context Protocol) 的完整接入指南和配置文件。

## 📁 文件说明

### 📖 文档（按阅读顺序）

1. **MCP_QUICKSTART.md** 🚀
   - 快速启动指南（2 分钟）
   - 3 步完成配置
   - **推荐先看这个**

2. **MCP_DECISION_TREE.md** 🎯
   - 决策树（3 分钟）
   - 帮你选择合适的配置
   - 包含场景对比

3. **MCP_INTEGRATION_GUIDE.md** 📚
   - 完整接入指南（10 分钟）
   - 详细的功能说明
   - 常见问题解答

### ⚙️ 配置文件

1. **mcp.minimal.json**
   - 最小配置（只有 Memory）
   - 适合新手
   - 零配置，立即可用

2. **mcp.recommended.json** ⭐
   - 推荐配置（Memory + Filesystem + Context7）
   - 适合 90% 用户
   - 覆盖常用场景

3. **mcp.json.example**
   - 自定义配置示例
   - 包含更多选项
   - 可根据需求修改

### 🔒 安全文档

1. **SECURITY_SETUP.md**
   - 安全配置总览
   - 已实施的安全措施
   - 验证方法

2. **AGENT_SECURITY.md**
   - Agent 权限管理
   - 最小权限原则
   - 安全检查清单

## 🚀 快速开始

### 方案 1: 推荐配置（适合大多数人）

```bash
# 1. 复制推荐配置到项目 .claude 目录
cp mcp/mcp.recommended.json .claude/.mcp.json

# 2. 重启 Claude Code
exit
claude
```

### 方案 2: 最小配置（新手友好）

```bash
# 1. 复制最小配置
cp mcp/mcp.minimal.json .claude/.mcp.json

# 2. 重启 Claude Code
exit
claude
```

### 方案 3: 自定义配置

```bash
# 1. 复制示例配置
cp mcp/mcp.json.example .claude/.mcp.json

# 2. 编辑配置
nano .claude/.mcp.json

# 3. 重启 Claude Code
exit
claude
```

## 📖 推荐阅读顺序

```
1. MCP_QUICKSTART.md        (2 分钟) - 快速了解
   ↓
2. MCP_DECISION_TREE.md     (3 分钟) - 选择配置
   ↓
3. 复制配置文件并重启
   ↓
4. MCP_INTEGRATION_GUIDE.md (10 分钟) - 深入学习（可选）
```

## ❓ 常见问题

### Q: MCP 是什么？
**A**: Model Context Protocol，让 Claude 能够安全地连接外部工具和数据源。

### Q: 必须接入 MCP 吗？
**A**: 不是必须的。不接入 MCP，Claude Code 仍然可以正常工作。

### Q: 推荐哪个配置？
**A**: 推荐使用 `mcp.recommended.json`，包含：
- ✅ Memory（跨会话记忆）
- ✅ Filesystem（项目文件访问，限制在当前目录）
- ✅ Context7（技术文档查询）

### Q: 如何禁用 MCP？
**A**: 删除或重命名 `.claude/.mcp.json` 文件即可。

```bash
# 禁用 MCP
rm .claude/.mcp.json

# 或者重命名
mv .claude/.mcp.json .claude/.mcp.json.disabled
```

### Q: 安全吗？
**A**: 是的。所有配置都遵循最小权限原则：
- Filesystem MCP 只能访问项目目录
- 凭证存储在环境变量中
- 敏感文件已添加到 .gitignore

## 🎯 MCP 功能对比

| 功能 | 无 MCP | + Memory | + Filesystem | + Context7 |
|------|--------|--------|------------|------------|
| 基本对话 | ✅ | ✅ | ✅ |
| 跨会话记忆 | ❌ | ✅ | ✅ | ✅ |
| 项目文件分析 | 🟡 | 🟡 | ✅ | ✅ |
| 技术文档查询 | 🟡 | 🟡 | 🟡 | ✅ |

**图例**：
- ✅ 完全支持
- 🟡 部分支持（通过 Bash 命令）
- ❌ 不支持

## 📊 配置对比

| 配置 | 包含功能 | 适合人群 | 启动时间 |
|------|----------|----------|----------|
| minimal | Memory | 新手 | 2s |
| recommended | Memory + Filesystem + Context7 | 大多数用户 | 3s |
| custom | 自定义 | 高级用户 | 视配置而定 |

## 🔗 相关链接

- [MCP 官方文档](https://modelcontextprotocol.io/)
- [Claude Code 文档](https://docs.anthropic.com/claude/docs)
- [MCP Servers 列表](https://github.com/modelcontextprotocol/servers)

## 💡 提示

- 所有配置都是可选的，不会影响现有功能
- 可以随时启用或禁用 MCP
- 遇到问题可以查看对应的详细文档
- 配置文件使用 JSON 格式，注意语法正确

## 📝 更新日志

- 2026-05-11: 创建 MCP 接入指南和配置文件
- 2026-05-11: 实施安全修复（移除硬编码凭证、限制 MCP 权限）

---

**需要帮助？** 查看 `MCP_QUICKSTART.md` 或 `MCP_INTEGRATION_GUIDE.md`
