# MCP 快速启动

## 三种配置方案

### 1. 最小配置（推荐新手）

```bash
cp .claude/.mcp.minimal.json .claude/.mcp.json
```

**包含**：
- ✅ Memory MCP - 跨会话记忆

**优点**：
- 零配置
- 无安全风险
- 立即可用

---

### 2. 推荐配置（推荐）

```bash
cp .claude/.mcp.recommended.json .claude/.mcp.json
```

**包含**：
- ✅ Memory MCP - 跨会话记忆
- ✅ Filesystem MCP - 项目文件访问（限制在当前目录）
- ✅ Context7 MCP - 技术文档查询

**优点**：
- 覆盖常用场景
- 安全可控
- 提升开发效率

---

### 3. 自定义配置

```bash
# 复制示例配置
cp .claude/.mcp.json.example .claude/.mcp.json

# 编辑配置
nano .claude/.mcp.json
```

参考 `MCP_INTEGRATION_GUIDE.md` 了解更多选项。

---

## 启动步骤

### 1. 选择配置
```bash
# 方案 1: 最小配置
cp .claude/.mcp.minimal.json .claude/.mcp.json

# 或方案 2: 推荐配置
cp .claude/.mcp.recommended.json .claude/.mcp.json
```

### 2. 重启 Claude Code
```bash
# 退出当前会话
exit

# 重新启动
claude
```

### 3. 验证
启动时会看到：
```
✓ MCP server 'memory' connected
✓ MCP server 'filesystem' connected  # 如果使用推荐配置
✓ MCP server 'context7' connected    # 如果使用推荐配置
```

### 4. 测试
```
"帮我记住：这个项目是 Palink-AI，使用 React + TypeScript + FastAPI"
```

---

## 常见问题

### Q: 启动失败？
```bash
# 检查 Node.js 版本（需要 >= 18）
node --version

# 手动安装 MCP Server
npx -y @modelcontextprotocol/server-memory
```

### Q: 如何禁用 MCP？
```bash
# 删除或重命名配置文件
mv .claude/.mcp.json .claude/.mcp.json.disabled
```

### Q: 如何切换配置？
```bash
# 切换到最小配置
cp .claude/.mcp.minimal.json .claude/.mcp.json

# 切换到推荐配置
cp .claude/.mcp.recommended.json .claude/.mcp.json
```

---

## 下一步

- 📖 阅读完整指南: `.claude/MCP_INTEGRATION_GUIDE.md`
- 🔒 查看安全配置: `.claude/SECURITY_SETUP.md`
- 🤖 了解 Agent 权限: `.claude/AGENT_SECURITY.md`
