# 前端UI调整 - 详细说明

## 文件：`frontend/src/components/ui/custom/StorylineMap.tsx`

### 1. 更新类型定义（已完成）

```typescript
export interface StoryBranch {
  id: string;
  branch_name: string;
  parent_branch_id: string | null;
  parent_message_id: number | null;
  is_active: boolean;
  is_frozen: boolean;          // 新增
  is_favorited: boolean;        // 新增
  last_message_at: string | null; // 新增
  created_at: string | null;
  nodes: StoryNode[];
}

interface StoryNodeData {
  node: StoryNode;
  branchId: string;
  branchName: string;
  pairIndex: number;
  isLeaf: boolean;
  isOnActivePath: boolean;
  isActiveBranch: boolean;
  isFrozen: boolean;            // 新增
  isFavorited: boolean;         // 新增
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void;
  isDark: boolean;
}
```

### 2. 导入新图标（已完成）

```typescript
import { ..., Star, Snowflake } from 'lucide-react';
```

### 3. 修改 StoryNodeComponent 函数

需要在第143-265行之间修改：

#### 3.1 解构新字段
```typescript
const { node, branchId, branchName, pairIndex, isLeaf, isOnActivePath, isActiveBranch, isFrozen, isFavorited, isDark } = d;
```

#### 3.2 修改卡片样式（支持冻结状态）
```typescript
const cardBg = isFrozen
  ? isDark
    ? 'bg-gray-800/40 border-gray-700/30'
    : 'bg-gray-100/60 border-gray-300/40'
  : isOnActivePath
  ? isDark
    ? 'bg-gradient-to-br from-indigo-900/80 to-blue-900/80 border-blue-400/60'
    : 'bg-gradient-to-br from-indigo-50 to-blue-50 border-blue-400/70'
  : isDark
  ? 'bg-gray-800/70 border-gray-600/40'
  : 'bg-white/80 border-gray-200/70';

const shadowStyle = isFrozen
  ? '0 1px 4px rgba(0,0,0,0.08)'
  : isOnActivePath
  ? '0 0 14px 2px rgba(99,102,241,0.35)'
  : '0 2px 8px rgba(0,0,0,0.12)';
```

#### 3.3 优先显示对话总结标题
```typescript
const primaryTitle = node.node_title || node.ai_summary || node.user_summary || '未命名节点';
```

#### 3.4 添加冻结透明度
```typescript
<div
  className={`rounded-xl border-2 cursor-pointer select-none transition-all duration-200 hover:scale-[1.03] hover:shadow-xl ${cardBg} ${isFrozen ? 'opacity-60' : ''}`}
  ...
>
```

#### 3.5 在分支标签中添加收藏和冻结图标
```typescript
{pairIndex === 0 && (
  <div className={...}>
    <GitBranch size={11} />
    <span className="truncate max-w-[120px]">{branchName}</span>
    {isFavorited && (
      <Star size={10} className="text-yellow-400 fill-yellow-400" />
    )}
    {isFrozen && (
      <Snowflake size={10} className="text-blue-300" />
    )}
    {isActiveBranch && (
      <span className="ml-auto text-[10px] bg-indigo-500/30 text-indigo-300 px-1.5 py-0.5 rounded-full">当前</span>
    )}
  </div>
)}
```

#### 3.6 为冻结分支的文本添加透明度
```typescript
<p className={`text-xs font-semibold leading-relaxed line-clamp-1 ${isDark ? 'text-gray-100' : 'text-gray-900'} ${isFrozen ? 'opacity-70' : ''}`}>
  {primaryTitle}
</p>

// 用户消息和AI消息也添加 ${isFrozen ? 'opacity-70' : ''}
```

### 4. 修改 buildGraph 函数（第425-561行）

在创建节点数据时传入新字段：

```typescript
branches.forEach((branch) => {
  const isActiveBranch = branch.id === active_branch_id;
  const isFrozen = branch.is_frozen || false;
  const isFavorited = branch.is_favorited || false;

  branch.nodes.forEach((node, idx) => {
    // ...
    rawNodes.push({
      id: nid,
      type: 'storyNode',
      position: { x: 0, y: 0 },
      data: {
        node,
        branchId: branch.id,
        branchName: branch.branch_name,
        pairIndex: idx,
        isLeaf,
        isOnActivePath,
        isActiveBranch,
        isFrozen,        // 新增
        isFavorited,     // 新增
        onNavigate,
        isDark,
      } satisfies StoryNodeData,
      draggable: true,
    });
    // ...
  });
});
```

## 文件：`frontend/src/components/views/CharacterView.tsx`

### 添加分支收藏和解冻功能

需要添加以下API调用函数：

```typescript
const toggleFavoriteBranch = async (branchId: string) => {
  try {
    await fetch(`/api/character-sessions/${sessionId}/branches/${branchId}/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    // 重新加载分支树
    await loadBranchTree();
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
  }
};

const unfreezeBranch = async (branchId: string) => {
  try {
    await fetch(`/api/character-sessions/${sessionId}/branches/${branchId}/unfreeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    // 重新加载分支树
    await loadBranchTree();
  } catch (error) {
  console.error('Failed to unfreeze branch:', error);
  }
};

const checkFrozenBranches = async () => {
  try {
    await fetch(`/api/character-sessions/${sessionId}/check-frozen-branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    // 重新加载分支树
    await loadBranchTree();
  } catch (error) {
    console.error('Failed to check frozen branches:', error);
  }
};
```

### 在加载分支树时调用检查冻结分支

```typescript
useEffect(() => {
  if (sessionId) {
    loadBranchTree();
    checkFrozenBranches(); // 自动检查冻结分支
  }
}, [sessionId]);
```

## 文件：`frontend/src/components/ui/custom/StorylinePanel.tsx`

### 添加分支统计（可选）

在顶部栏显示冻结和收藏的分支数量：

```typescript
const frozenCount = branchTree.branches.filter(b => b.is_frozen).length;
const favoritedCount = branchTree.branches.filter(b => b.is_favorited).length;

// 在统计pills中添加
<span className={...}>
  <Snowflake size={11} />
  {frozenCount} 冻结
</span>
<span className={...}>
  <Star size={11} />
  {favoritedCount} 收藏
</span>
```

## 测试要点

1. ✅ 冻结分支显示为灰色且半透明
2. ✅ 收藏的分支显示星标图标
3. ✅ 冻结的分支显示雪花图标
4. ✅ 对话总结标题（node_title）优先显示
5. ✅ 点击冻结分支时自动解冻
6. ✅ 收藏的分支不会被自动冻结
7. ✅ 分支名称显示为"分支 1/2/3"而不是"Main"
