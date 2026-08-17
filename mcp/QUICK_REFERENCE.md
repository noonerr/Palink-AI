# MCP 快速参考卡

## 🚀 一分钟快速启动

```bash
# 推荐配置（适合 90% 用户）
cp mcp/mcp.recommended.json .claude/.mcp.json
exit
claude
```

## 📁 文件位置

```
项目根目录/mcp/
```

在 Windows 文件管理器中打开：
```
C:\Users\Pall\OneDrive\桌面\Palink-AI\mcp\
```

## 📖 文档速查

| 文件 | 用途 | 时间 |
|------|------|------|
| **README.md** | 总览 | 5 分钟 |
| **MCP_QUICKSTART.md** | 快速启动 | 2 分钟 |
| **MCP_DECISION_TREE.md** | 选择配置 | 3 分钟 |
| **MCP_INTEGRATION_GUIDE.md** | 完整指南 | 10 分钟 |

## ⚙️ 配置文件速查

| 文件 | 包含功能 | 适合 |
|------|----------|------|
| **mcp.minimal.json** | Memory | 新手 |
| **mcp.recommended.json** ⭐ | Memory + Filesystem + Context7 | 大多数人 |
| **mcp.json.example** | 自定义 | 高级用户 |

## 🎯 三步启用 MCP

### 步骤 1: 选择配置
```bash
# 方案 A: 推荐配置
cp mcp/mcp.recommended.json .claude/.mcp.json

# 方案 B: 最小配置
cp mcp/mcp.minimal.json .claude/.mcp.json
```

### 步骤 2: 重启 Claude
```bash
exit
claude
```

### 步骤 3: 验证
启动时会看到：
```
✓ MCP server 'memory' connected
✓ MCP server 'filesystem' connected
✓ MCP server 'context7' connected
```

## 🔧 常用命令

```bash
# 查看文档
cat mcp/README.md

# 启用推荐配置
cp mcp/mcp.recommended.json .claude/.mcp.json
# 启用最小配置
cp mcp/mcp.minimal.json .claude/.mcp.json

# 禁用 MCP
rm .claude/.mcp.json

# 查看当前配置
cat .claude/.mcp.json
```

## ❓ 快速问答

**Q: MCP 是什么？**
A: 让 Claude 连接外部工具的协议

**Q: 必须用吗？**
A: 不是，可选

**Q: 推荐哪个？**
A: `mcp.recommended.json`

**Q: 如何禁用？**
A: `rm .claude/.mcp.json`

**Q: 安全吗？**
A: 是的，限制在项目目录

## 🎁 MCP 功能

### Memory（记忆）
- ✅ 跨会话记住信息
- ✅ 记住项目约定
- ✅ 保存决策历史

### Filesystem（文件系统）
- ✅ 分析项目文件
- ✅ 搜索代码
- ✅ 限制在项目目录

### Context7（文档查询）
- ✅ 查询技术文档
- ✅ React、TypeScript、FastAPI 等
- ✅ 获取最新 API 信息

## 💡 提示

- 从 `mcp.recommended.json` 开始
- 遇到问题查看 `MCP_QUICKSTART.md`
- 可以随时启用/禁用
- 不影响现有功能

---

**详细文档**: 查看 `mcp/README.md`
