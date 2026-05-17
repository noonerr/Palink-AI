# MCP 接入决策树

## 我应该接入 MCP 吗？

```
开始
  │
  ├─ 你需要 Claude 记住之前的对话吗？
  │   ├─ 是 → 接入 Memory MCP ✅
  │   └─ 否 → 继续
  │
  ├─ 你需要 Claude 分析项目文件吗？
  │   ├─ 是 → 接入 Filesystem MCP ✅
  │   └─ 否 → 继续
  │
  ├─ 你需要查询技术文档吗？
  │   ├─ 是 → 接入 Context7 MCP ✅
  │   └─ 否 → 继续
  │
  ├─ 你需要管理 GitHub Issues/PRs 吗？
  │   ├─ 是 → 接入 GitHub MCP ✅
  │   └─ 否 → 继续
  │
  └─ 暂时不需要 MCP
```

## 推荐配置选择

### 场景 1: 日常开发（推荐 90% 用户）

**需求**：
- ✅ Claude 记住项目约定
- ✅ 分析项目文件
- ✅ 查询技术文档

**配置**：
```bash
cp .claude/.mcp.recommended.json .claude/.mcp.json
```

**包含**：Memory + Filesystem + Context7

---

### 场景 2: 轻量使用（新手友好）

**需求**：
- ✅ 只需要基本的记忆功能
- ❌ 不需要文件访问
- ❌ 不需要文档查询

**配置**：
```bash
cp .claude/.mcp.minimal.json .claude/.mcp.json
```

**包含**：Memory

---

### 场景 3: 团队协作（GitHub 集成）

**需求**：
- ✅ 所有日常开发功能
- ✅ 管理 GitHub Issues
- ✅ 审查 Pull Requests

**配置**：
```bash
# 1. 复制推荐配置
cp .claude/.mcp.recommended.json .claude/.mcp.json

# 2. 添加 GitHub 配置
nano .claude/.mcp.json
```

添加：
```json
{
  "mcpServers": {
    "memory": { ... },
    "filesystem": { ... },
    "context7": { ... },
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

然后在 `~/.claude/.env` 添加：
```bash
GITHUB_TOKEN=ghp_your_token_here
```

---

### 场景 4: 暂不接入

**情况**：
- 还在评估 MCP
- 担心安全问题
- 不确定需求

**建议**：
- 先阅读 `MCP_INTEGRATION_GUIDE.md`
- 了解每个 MCP 的功能
- 随时可以接入，不影响现有功能

---

## 功能对比表

| 功能 | 无 MCP | Memory | + Filesystem | + Context7 | + GitHub |
|------|--------|--------|--------------|------------|----------|
| 基本对话 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 跨会话记忆 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 项目文件分析 | 🟡 | 🟡 | ✅ | ✅ | ✅ |
| 技术文档查询 | 🟡 | 🟡 | 🟡 | ✅ | ✅ |
| GitHub 操作 | ❌ | ❌ | ❌ | ❌ | ✅ |

**图例**：
- ✅ 完全支持
- 🟡 部分支持（通过 Bash 命令）
- ❌ 不支持

---

## 性能影响

| 配置 | 启动时间 | 内存占用 | 响应速度 |
|------|----------|----------|----------|
| 无 MCP | 1s | 50MB | 快 |
| Memory | 2s | 60MB | 快 |
| 推荐配置 | 3s | 80MB | 快 |
| 完整配置 | 4s | 100MB | 中等 |

**结论**: 性能影响很小，可以放心使用。

---

## 安全性对比

| MCP Server | 数据存储 | 网络访问 | 风险等级 |
|-----------|----------|----------|----------|
| Memory | 本地 | 无 | 🟢 低 |
| Filesystem | 本地 | 无 | 🟢 低 |
| Context7 | 远程 | 是 | 🟡 中 |
| GitHub | 远程 | 是 | 🟡 中 |
| Vercel/CF | 远程 | 是 | 🔴 高 |

**建议**：
- 🟢 低风险：可以放心使用
- 🟡 中风险：需要配置 Token，注意权限
- 🔴 高风险：谨慎使用，评估必要性

---

## 快速决策

### 如果你是...

**🎓 学习者/新手**
→ 使用最小配置（Memory）

**👨‍💻 日常开发者**
→ 使用推荐配置（Memory + Filesystem + Context7）

**👥 团队协作者**
→ 使用完整配置（+ GitHub）

**🔒 安全优先者**
→ 只使用本地 MCP（Memory + Filesystem）

---

## 立即开始

### 1 分钟快速启动

```bash
# 选择推荐配置（适合 90% 用户）
cp .claude/.mcp.recommended.json .claude/.mcp.json

# 重启 Claude Code
exit
claude
```

### 5 分钟完整配置

1. 阅读 `MCP_INTEGRATION_GUIDE.md`
2. 选择适合的配置
3. 配置环境变量（如需要）
4. 测试功能

---

## 需要帮助？

- 📖 完整指南: `.claude/MCP_INTEGRATION_GUIDE.md`
- 🚀 快速启动: `.claude/MCP_QUICKSTART.md`
- 🔒 安全配置: `.claude/SECURITY_SETUP.md`
