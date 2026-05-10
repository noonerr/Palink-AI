# 当前故事线分支逻辑图解

## 数据结构

### CharacterChatSessionBranch (分支表)
```
id: string (主键)
session_id: string (会话ID)
parent_branch_id: string | null (父分支ID)
parent_message_id: int | null (父消息ID - 分叉点)
branch_name: string (分支名称)
is_active: boolean (是否激活)
is_frozen: boolean (是否冻结)
is_favorited: boolean (是否收藏)
```

### CharacterChatMessage (消息表)
```
id: int (主键)
session_id: string (会话ID)
branch_id: string (所属分支ID)
role: 'user' | 'assistant'
content: text (消息内容)
short_title: string (节点标题)
```

## 当前逻辑示意图

```
Session (会话)
│
├─ Branch 1 (root)
│   parent_branch_id: null
│   parent_message_id: null
│   │
│   ├─ Message 1 (user) [id=1]
│   ├─ Message 2 (assistant) [id=2] ← 节点1 = (msg1 + msg2)
│   │   │
│   │   ├─ Branch 2 (从 msg2 分叉)
│   │   │   parent_branch_id: Branch1
│   │   │   parent_message_id: 2
│   │   │   │
│   │   │   ├─ Message 3 (user) [id=3]
│   │   └─ Message 4 (assistant) [id=4] ← 节点2 = (msg3 + msg4)
│   │   │       │
│   │   │       ├─ Branch 4 (从 msg4 分叉)
│   │   │       │   parent_branch_id: Branch2
│   │   │       │   parent_message_id: 4
│   │       │
│   │   │       ├─ Branch 5 (从 msg4 分叉)
│   │   │       │   parent_branch_id: Branch2
│   │   │       │   parent_message_id: 4
│   │   │       │
│   │   │       └─ Branch 6 (从 msg4 分叉) ← 最多3个
│   │   │         parent_branch_id: Branch2
│   │           parent_message_id: 4
│   │   │
│   │   ├─ Branch 3 (从 msg2 分叉)
│   │   │   parent_branch_id: Branch1
│   │   │   parent_message_id: 2
│   │   │
│   │   └─ (最多3个分支)
│   │
│   ├─ Message 5 (user) [id=5]
│   └─ Message 6 (assistant) [id=6] ← 节点3 = (msg5 + msg6)
│
└─ (可以有多个根分支)
```

## 关键约定

### 1. 节点定义
- **节点 = user消息 + assistant消息对**
- 前端显示：一个节点包含一轮对话
- 节点标题：使用 `short_title` 或 AI 回复的前20字

### 2. 分叉点
- `parent_message_id` 指向 **assistant 消息ID**（对话对的结束点）
- 从一个节点分叉 = 从该节点的 assistant 消息分叉

### 3. 分支限制
- **每个节点最多3个子分支**
- 检查逻辑：统计 `parent_branch_id` 和 `parent_message_id` 相同的分支数

### 4. 分支层级
- 支持无限层级嵌套
- Branch → Branch → Branch → ...
- 通过 `parent_branch_id` 形成树状结构

## 前端渲染逻辑

### StorylineMap.tsx
```typescript
// 1. 将 user+assistant 配对为节点
for (msg in messages) {
  if (msg.role === "user") {
    pending_user = msg
  } else if (msg.role === "assistant") {
    if (pending_user) {
      pairs.push({
        pair_id: `pair_${pending_user.id}`,
        user_msg_id: pending_user.id,
        ai_msg_id: msg.id,  // ← 这个ID用于分叉
     node_title: msg.short_title || ai_display[:20],
        user_summary: pending_user.content[:80],
        ai_summary: ai_display[:80],
      })
    }
  }
}

// 2. 构建分支树
branches.forEach(branch => {
  // 每个分支包含多个节点(pairs)
  // 通过 parent_message_id 连接到父分支的某个节点
})

// 3. 计算激活路径
function computeActivePath(branches, activeBranchId) {
  // 从当前分支向上追溯到根分支
  // 标记路径上的所有节点为激活状态
}
```

## 分支创建流程

### 用户点击节点 → 创建分支
```
1. 用户点击节点 (ai_msg_id = 4)
2. 前端调用: POST /branches
   {
     parent_branch_id: "Branch2",
     parent_message_id: 4,  // assistant 消息ID
     same_level: false
   }
3. 后端验证:
   - parent_message_id 必须指向 assistant 消息
   - 统计从 (Branch2, msg4) 分叉的分支数
   - 如果 < 3，允许创建
4. 创建新分支:
   Branch7 {
     parent_branch_id: "Branch2",
     parent_message_id: 4,
   branch_name: "分支 4"
   }
5. 新分支自动添加角色的 first_mes (如果是根分支或浅层分支)
```

## 消息加载逻辑

### 切换分支时加载消息
```
function _get_full_branch_history(branch_id):
  1. 获取目标分支
  2. 向上追溯父分支链: Branch7 → Branch2 → Branch1
  3. 对于每个分支:
     - 目标分支: 加载所有消息
     - 父分支: 只加载到 parent_message_id 为止
  4. 合并并去重
  5. 返回完整历史
```

### 示例
```
切换到 Branch7:
1. Branch1 的消息: msg1, msg2 (到 parent_message_id=2 为止)
2. Branch2 的消息: msg3, msg4 (到 parent_message_id=4 为止)
3. Branch7 的消息: msg7, msg8, msg9 (全部)

最终历史: [msg1, msg2, msg3, msg4, msg7, msg8, msg9]
```

## 向量记忆支持

```python
# 获取分支链
ancestor_branch_ids = _get_ancestor_branch_ids(db, session_id, branch_id)
# 结果: [Branch1, Branch2, Branch7]

# 查询记忆时只查询这些分支的消息
mem_ctx = await mem_svc.get_context(
    user_id=user.id,
    query=req.message,
    session_id=session_id,
    branch_ids=ancestor_branch_ids  # 只查询当前分支链
)
```

## 性能优化

### 索引
```sql
-- 查找子分支
CREATE INDEX idx_branch_parent_lookup 
ON character_chat_session_branches(session_id, parent_branch_id, parent_message_id);

-- 查找激活分支
CREATE INDEX idx_branch_session_active 
ON character_chat_session_branches(session_id, is_active);

-- 查找分支消息
CREATE INDEX idx_message_branch_lookup 
ON character_chat_messages(session_id, branch_id, created_at);

-- 查找 assistant 消息
CREATE INDEX idx_message_role_lookup 
ON character_chat_messages(session_id, branch_id, role, id);
```

---

## 问题点（请指出需要修改的地方）

1. **节点定义是否正确？**
   - 当前: 节点 = user + assistant 消息对
   - 分叉点: assistant 消息ID

2. **分支限制是否正确？**
   - 当前: 每个 assistant 消息最多3个子分支
   - 检查: parent_branch_id + parent_message_id 相同的分支数

3. **分支嵌套是否正确？**
   - 当前: 通过 parent_branch_id 形成树状结构
   - 支持无限层级

4. **消息加载是否正确？**
   - 当前: 追溯父分支链，只加载到分叉点

5. **前端显示是否正确？**
   - 当前: 将 user+assistant 配对显示为一个节点
   - 通过 parent_message_id 连接分支

**请告诉我哪里理解错了，应该怎么改？**
