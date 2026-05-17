# 故事线分支功能测试指南

## 修复内容

### 1. 移除了 isLeaf 检查
- **之前**: 只有非叶子节点（分支中间的节点）才能设置 forkPoint
- **现在**: 任何节点都可以设置 forkPoint

### 2. 修改的文件
- `frontend/src/components/views/CharacterView.tsx` - handleStorylineNavigate 函数
- 已重新构建并部署

## 测试步骤

### 测试1: 从叶子节点创建分支

1. 访问 http://localhost:3000
2. 进入角色对话页面
3. 发送 3-5 轮对话
4. 点击左上角「故事线」按钮，打开故事线面板
5. **点击最后一个节点**（叶子节点，应该显示"进行中"标签）
6. 点击「新分支」按钮
7. **预期结果**: 
   - 显示 toast 提示"从节点创建分支 '分支 X'"
   - 新分支从该节点分叉出来
   - 故事线图更新，显示新分支

### 测试2: 从中间节点创建分支

1. 在故事线面板中
2. **点击中间的某个节点**（不是最后一个）
3. 点击「新分支」按钮
4. **预期结果**: 
   - 显示 toast 提示"从节点创建分支 '分支 X'"
   - 新分支从该节点分叉出来

### 测试3: 创建同级分支

1. 在故事线面板中
2. **不点击任何节点**
3. 直接点击「新分支」按钮
4. **预期结果**: 
   - 显示 toast 提示"分支 '分支 X' 已创建"
   - 创建与当前分支同级的新分支

### 测试4: 分支限制（每个节点最多3个分支）

1. 点击某个节点
2. 连续创建3个分支
3. 再次点击同一个节点
4. 尝试创建第4个分支
5. **预期结果**: 
   - 显示错误提示"每个节点最多只能创建3个分支"

## 调试方法

### 检查 forkPoint 是否设置

打开浏览器开发者工具（F12），在 Console 中输入：

```javascript
// 查看 React DevTools 中的 CharacterView 组件状态
// 或者在代码中添加 console.log

// 点击节点后，应该看到类似的日志：
// forkPoint: { branchId: "xxx", messageId: 123 }
```

### 检查网络请求

1. 打开开发者工具 → Network 标签
2. 点击节点后点击「新分支」
3. 查找 POST 请求到 `/api/character-sessions/{sessionId}/branches`
4. 检查请求 payload:
   ```json
   {
     "session_id": "xxx",
     "parent_branch_id": "xxx",  // 应该有值
     "parent_message_id": 123,    // 应该有值
     "same_level": false          // 应该是 false
   }
   ```

### 如果还是不行

1. **清除浏览器缓存**: Ctrl+Shift+Delete → 清除缓存
2. **硬刷新**: Ctrl+F5 或 Cmd+Shift+R
3. **检查容器**: `docker-compose ps` 确认都是 healthy
4. **查看前端日志**: `docker-compose logs frontend --tail 50`
5. **查看后端日志**: `docker-compose logs backend --tail 50`

## 预期行为

### 点击节点时
- 节点高亮显示（蓝色发光）
- 消息列表加载到该节点为止
- forkPoint 被设置为 `{ branchId, messageId }`

### 点击「新分支」时
- 如果有 forkPoint: 从该节点创建子分支
- 如果没有 forkPoint: 创建同级分支
- 创建后 forkPoint 被清除

### 节点样式
- **蓝色发光节点**: 当前激活路径上的节点
- **灰色/白色节点**: 非激活路径的节点
- 这是正常的设计，用于显示当前所在的分支路径

## 已知问题

如果测试后发现问题，请提供：
1. 具体的操作步骤
2. 实际发生的结果
3. 浏览器控制台的错误信息
4. Network 标签中的请求详情
