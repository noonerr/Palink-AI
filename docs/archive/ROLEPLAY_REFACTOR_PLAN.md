# 角色扮演聊天优化 —— 详细实施方案

> **目标**：优化AI回复格式、统一消息气泡、修复故事线跳转与记忆隔离、调整头像/模型名显示，为后续多角色同台对话做好架构准备。

---

## 一、概述（给你看的"人话版"）

### 现在有什么问题？

1. **AI回复格式浪费tokens**：现在我们在系统提示词里要求AI用 `<action>...</action>`、`<thinking>...</thinking>` 这种XML标签来区分"动作"和"思考"，这些标签本身就占不少tokens。
2. **一条回复被拆成多个框**：action一个框、thinking一个框、对话又一个框，看起来碎片化，后期多角色对话时更容易看花眼。
3. **头像显示错误**：AI回复显示的是模型图标（如GPT的logo），而不是角色的头像（比如"时雨"的立绘）。
4. **故事线跳转坏了**：点击故事线地图上的节点，无法正确跳转到对应分支的对话，且记忆(memory)是按session_id存储的，不区分branch，导致不同分支的记忆会互相污染。

### 改成什么样？

**学习SillyTavern的做法**：
- `"引号里的内容"` = 角色说的话（语言）→ 白色/默认色
- `*星号里的内容*` = 动作/叙述 → 斜体+淡黄色
- 无标记的内容 = 旁白/叙述 → 普通灰色
- 模型自带的 `<think>` 深度思考 → 折叠/紫色（保留，但合并到同一气泡内）

**一个气泡搞定一切**：不再拆成多个框，而是在一个消息气泡内部用不同的颜色和样式区分内容类型。

**头像**：AI消息显示角色头像，模型名写在气泡下方的工具栏里（复制按钮旁边）。

**故事线**：修复分支跳转 + 记忆按branch隔离。

---

## 二、详细技术方案

### 模块A：AI回复格式改革（节省tokens + 统一气泡）

#### A1. 后端 —— 精简系统提示词

**文件**：`backend/app/api/character_ext.py` → `_build_char_system_prompt()`

**现状**：系统提示词没有明确要求格式标签（标签是前端解析的），但有些角色卡的system_prompt或mes_example里可能包含了旧的标签格式指导。

**改动**：在系统提示词末尾追加一段统一的输出格式指引（取代旧标签方案）：

```python
def _build_char_system_prompt(char, user_nickname="用户") -> str:
    parts = []
    if char.system_prompt:
        parts.append(char.system_prompt)
    parts.append(f"You are {char.name}. Stay in character at all times.")
    if char.personality:
        parts.append(f"Personality: {char.personality}")
    if char.background:
        parts.append(f"Background: {char.background}")
    if char.scenario:
        parts.append(f"Scenario: {char.scenario}")
    if char.description:
        parts.append(f"Description: {char.description}")
    parts.append(f'The user\'s name is "{user_nickname}".')
    
    # ★ 新增：统一输出格式（类SillyTavern，节省tokens）
    parts.append(
        'Format rules:\n'
        '- Wrap spoken dialogue in double quotes: "Hello!"\n'
        '- Wrap actions, narration, and internal thoughts in asterisks: *she smiled softly*\n'
        '- Do NOT use XML tags like <action> or <thinking>.\n'
        '- Write naturally, mixing dialogue and actions in the same response.'
    )
    return "\n\n".join(parts)
```

**为什么这样做**：
- `"双引号"` 和 `*星号*` 是角色扮演社区（SillyTavern、NovelAI 等）的事实标准
- 这些标记极短（每次只多2-4个字符），比 `<action>...</action>` 省很多tokens
- 大部分LLM本身就会自然使用这种格式，有时连指令都不用加

#### A2. 前端 —— 新解析器（一个气泡，多色内联）

**文件**：`frontend/src/components/ui/custom/Message.tsx`

**核心思路**：把现有的"按标签拆分成多个MessagePart → 渲染多个独立框"改为"解析成内联片段 → 在一个气泡内用span着色"。

##### 新的解析逻辑

```typescript
type InlineSegment = {
  type: 'speech' | 'action' | 'narration' | 'model_reasoning';
  content: string;
};

function parseRoleplayContent(raw: string, showModelReasoning: boolean): InlineSegment[] {
  const segments: InlineSegment[] = [];
  
  // 第一步：提取 <model_reasoning>（模型深度思考，如DeepSeek-R1的<think>）
  // 这个保留，从主内容中剥离
  let content = raw;
  const reasoningRegex = /<(?:model_reasoning|think)>([\s\S]*?)<\/(?:model_reasoning|think)>/gi;
  const reasonings: string[] = [];
  content = content.replace(reasoningRegex, (_, inner) => {
    reasonings.push(inner.trim());
    return '';
  });
  
  if (showModelReasoning && reasonings.length > 0) {
    for (const r of reasonings) {
      segments.push({ type: 'model_reasoning', content: r });
    }
  }
  
  // 第二步：兼容旧标签 —— 把旧的 <action>X</action> 转为 *X*
  content = content.replace(/<action>([\s\S]*?)<\/action>/gi, '*$1*');
  content = content.replace(/\[action\]([\s\S]*?)\[\/action\]/gi, '*$1*');
  content = content.replace(/<thinking>([\s\S]*?)<\/thinking>/gi, '*$1*');
  content = content.replace(/<\|a\|>([\s\S]*?)<\/?\|a\|>/gi, '*$1*');
  content = content.replace(/<\|t\|>([\s\S]*?)<\/?\|t\|>/gi, '*$1*');
  
  // 第三步：按行内标记解析
  // 正则匹配："引号内容" 和 *星号内容*
  // 其他内容视为旁白(narration)
  const tokenRegex = /("(?:[^"\\]|\\.)*")|(\*(?:[^*\\]|\\.)+\*)/g;
  let lastIndex = 0;
  let match;
  
  while ((match = tokenRegex.exec(content)) !== null) {
    // 先把match前面的内容作为narration
    if (match.index > lastIndex) {
      const before = content.slice(lastIndex, match.index).trim();
      if (before) segments.push({ type: 'narration', content: before });
    }
    
    if (match[1]) {
      // "引号" → speech（去掉外层引号）
      segments.push({ type: 'speech', content: match[1].slice(1, -1) });
    } else if (match[2]) {
      // *星号* → action（去掉外层星号）
      segments.push({ type: 'action', content: match[2].slice(1, -1) });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // 剩余尾部内容
  if (lastIndex < content.length) {
    const tail = content.slice(lastIndex).trim();
    if (tail) segments.push({ type: 'narration', content: tail });
  }
  
  return segments;
}
```

##### 渲染方式（一个气泡，内联着色）

```tsx
// 在 Message 组件的 AI 消息渲染中
<div className="message-bubble-ai px-4 py-3 rounded-xl shadow-sm">
  {/* 模型深度思考 - 折叠展示 */}
  {segments.filter(s => s.type === 'model_reasoning').length > 0 && (
    <details className="mb-2 border-l-2 border-purple-400 pl-3">
      <summary className="text-xs text-purple-500 cursor-pointer">
        <Zap size={10} className="inline mr-1" /> 模型深度思考
      </summary>
      <div className="text-xs text-purple-700 dark:text-purple-300 mt-1 font-mono">
        <ReactMarkdown>{reasoningContent}</ReactMarkdown>
      </div>
    </details>
  )}
  
  {/* 主要内容 - 内联着色 */}
  <div className="leading-relaxed whitespace-pre-wrap">
    {segments.filter(s => s.type !== 'model_reasoning').map((seg, i) => {
      switch (seg.type) {
        case 'speech':
          return (
            <span key={i} className="text-foreground">
              "{seg.content}"
            </span>
          );
        case 'action':
          return (
            <span key={i} className="text-amber-700 dark:text-amber-300 italic">
              *{seg.content}*
            </span>
          );
        case 'narration':
          return (
            <span key={i} className="text-muted-foreground">
              {seg.content}
            </span>
          );
      }
    })}
  </div>
</div>
```

##### 颜色方案对照表

| 内容类型 | 标记方式 | 显示样式 | 颜色 |
|---------|---------|---------|------|
| 语言（对话） | `"双引号"` | 正常字体 | 白色/前景色（默认） |
| 动作/叙述 | `*星号*` | 斜体 | 琥珀色 `amber-700/300` |
| 旁白（无标记） | 无 | 正常 | 次要前景色 `muted-foreground` |
| 深度思考 | `<think>` | 折叠面板 | 紫色 `purple-500/300` |

#### A3. 兼容性处理

现有历史消息可能包含旧的XML标签格式。解析器已内置兼容层（A2第二步），会自动把旧标签转换为新格式后再解析。因此**不需要迁移历史数据**。

---

### 模块B：头像 & 模型名显示调整

**文件**：`frontend/src/components/ui/custom/Message.tsx`

#### B1. AI消息头像 → 角色头像

**现状问题**：
- Message组件收到 `userAvatar` 和 `userName` 两个props
- CharacterView传值时（第1634行）：assistant消息传了 `selectedCharacter.avatar` 给 `userAvatar`
- 但Message组件内部对AI消息用的是 `aiIcon`（从`models`列表中查找model icon），完全没用传入的avatar

**改动**：给Message组件新增一个 `characterAvatar` prop（或者复用已传入的props）：

```typescript
// Message.tsx 的 props 新增
interface MessageProps {
  // ...已有props
  characterAvatar?: string;   // 角色头像URL（角色扮演模式专用）
  characterName?: string;     // 角色名称
}
```

Avatar渲染逻辑修改：

```tsx
// 原来的 AI 头像逻辑：
{aiIcon?.startsWith('http') ? <img src={aiIcon} /> : <span>{aiIcon || '🤖'}</span>}

// 改为（角色扮演模式优先显示角色头像）：
{isCharacterChat && characterAvatar ? (
  <img src={characterAvatar} alt="" className="w-full h-full object-cover rounded-full" />
) : aiIcon?.startsWith('http') || aiIcon?.startsWith('/') || aiIcon?.startsWith('data:') ? (
  <img src={aiIcon} alt="" className="w-full h-full object-cover rounded-full" />
) : (
  <span className="text-xs sm:text-sm">{aiIcon || '🤖'}</span>
)}
```

#### B2. 模型名显示位置

**移到气泡下方工具栏**（复制按钮旁边）：

```tsx
// 在 !isUser 的底部工具栏区域添加
{!isUser && (
  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
    {/* 模型名标识 */}
    {isCharacterChat && messageModel && (
      <span className="text-[10px] text-muted-foreground/60 font-mono">
        {messageModel.alias || messageModel.id}
      </span>
    )}
    
    {/* 原有的复制/重新生成等按钮 */}
    <div className="flex items-center gap-0.5 bg-muted/30 rounded px-1 py-0.5">
      {/* ... 按钮 ... */}
    </div>
  </div>
)}
```

#### B3. CharacterView 传参调整

在 CharacterView.tsx 渲染 Message 组件时：

```tsx
<Message
  message={msg}
  // 用户消息用用户头像，AI消息也传用户头像（Message组件自己处理）
  userAvatar={user.avatar}
  userName={user.username}
  // 新增：角色扮演专属props
  characterAvatar={selectedCharacter.avatar}
  characterName={selectedCharacter.name}
  isCharacterChat={true}
  // ...其他props不变
/>
```

---

### 模块C：故事线跳转 & 记忆隔离修复

这是最复杂的部分。

#### C1. 问题分析

**故事线跳转不工作**：
- CharacterView.tsx 中定义了 `handleStorylineNavigate` 和 `fetchBranchTree`
- `handleStorylineNavigate` 内部调用 `switchBranch`，但**没有同步更新记忆统计(memoryStats)**
- 更关键的是，`switchBranch` 只更新了 `messages` 和 `selectedBranch`，但没有重新加载记忆上下文

**记忆不隔离**：
- 后端 `/api/memory/stats` 只接收 `session_id`，不区分 `branch_id`
- `MemoryCompressionService.check_compression_needed()` 也是按 `session_id` 查询
- `conversation_memories` 表没有 `branch_id` 字段
- 结果：同一个session下所有分支共享同一套记忆，分支A的对话记忆会混进分支B

#### C2. 后端修复 —— 记忆按分支隔离

##### 数据库迁移（新增branch_id字段）

**文件**：新建 `backend/alembic/versions/xxxx_add_branch_id_to_memory.py`

```python
"""add branch_id to conversation_memories"""

def upgrade():
    # conversation_memories 表新增 branch_id 列
    op.add_column('conversation_memories', 
        sa.Column('branch_id', sa.String, nullable=True))
    op.create_index('idx_memory_branch_id', 'conversation_memories', ['branch_id'])
```

由于记忆是存在独立的SQLite里（memory_module/storage.py），需要在 `MemoryStorage.__init__` 的建表语句中也加 `branch_id`。

##### API修改

**`/api/memory/stats`** 和 **`/api/memory/compress`**：增加可选参数 `branch_id`

```python
@router.get("/stats")
def get_memory_stats(
    session_id: str,
    branch_id: str = None,  # ★ 新增
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    service = MemoryCompressionService(db)
    result = service.check_compression_needed(
        current_user.id, session_id, branch_id=branch_id
    )
    return { ... }
```

##### 聊天API修改

`character_chat` 端点中保存记忆时添加 `branch_id`：

```python
# 在 character_ext.py character_chat() 中
# 存储记忆时传入 branch_id
if memory_mode != "disabled":
    mem_svc.store_memory(
        user_id=user.id,
        session_id=session_id,
        branch_id=branch_id,  # ★ 新增
        role="user",
        content=req.message,
    )
```

#### C3. 前端修复 —— 故事线跳转逻辑

**文件**：`frontend/src/components/views/CharacterView.tsx`

修复 `handleStorylineNavigate`：

```typescript
const handleStorylineNavigate = useCallback(async (
  branchId: string, 
  _messageId: number | null, 
  _isLeaf: boolean
) => {
  if (!selectedSession) return;
  try {
    // 1. 切换分支（后端返回该分支的完整消息历史）
    const data = await api.post(
      `/api/character-sessions/${selectedSession.id}/branches/${branchId}/switch`
    );
    
    // 2. 更新消息列表
    setMessages(data.messages || []);
    
    // 3. 更新选中的分支
    const targetBranch = branches.find(b => b.id === branchId);
    if (targetBranch) {
      setSelectedBranch(targetBranch);
    }
    
    // 4. ★ 重新加载该分支的记忆统计（关键修复！）
    await loadMemoryStats(selectedSession.id, branchId);
    
    // 5. 重新加载分支列表（更新活跃状态）
    await loadBranches(selectedSession.id);
    
  } catch (e) {
    console.error('Failed to navigate storyline:', e);
  }
}, [selectedSession, branches, loadMemoryStats, loadBranches]);
```

修复 `switchBranch`（同样需要加载记忆统计）：

```typescript
const switchBranch = async (branch: CharacterChatSessionBranch) => {
  if (!selectedSession) return;
  try {
    const data = await api.post(
      `/api/character-sessions/${selectedSession.id}/branches/${branch.id}/switch`
    );
    setSelectedBranch(branch);
    setMessages(data.messages || []);
    await loadBranches(selectedSession.id);
    await loadMemoryStats(selectedSession.id, branch.id); // ★ 新增
  } catch (e) {
    console.error('Failed to switch branch:', e);
  }
};
```

修复 `loadMemoryStats` 支持 `branchId` 参数：

```typescript
const loadMemoryStats = useCallback(async (sessionId: string, branchId?: string) => {
  if (!sessionId) return;
  loadingSessionRef.current = sessionId;
  try {
    const params = new URLSearchParams({ session_id: sessionId });
    if (branchId) params.append('branch_id', branchId);
    
    const data = await api.get(`/api/memory/stats?${params.toString()}`);
    if (loadingSessionRef.current === sessionId) {
      setMemoryStats(data);
      if (data.compression_needed) {
        await autoCompressMemory(sessionId);
      }
    }
  } catch (e) {
    console.error('Failed to load memory stats:', e);
  }
}, []);
```

#### C4. 发送消息时也传branch_id到记忆API

在 `useCharacterChat.ts` 的 `handleSendMessage` 中，确保 `branch_id` 被正确传递（当前已经传了 `branch_id: selectedBranch?.id`，这部分是OK的）。

---

### 模块D：为多角色对话做架构准备

虽然这次不实现多角色同台，但要在设计上预留扩展点。

#### D1. 消息数据结构预留

当前 `CharacterChatMessage` 模型只有 `role: user|assistant`。多角色模式下需要知道是**哪个角色**在说话。

**建议**：在消息模型中预留 `character_id` 字段（当前为null，未来多角色时填入具体角色ID）。

```python
# 数据库迁移
op.add_column('character_chat_messages',
    sa.Column('character_id', sa.String, nullable=True))
```

#### D2. 消息组件接口预留

Message组件的 `characterAvatar` 和 `characterName` 已经是按消息传入的，未来多角色时每条消息可以传不同的角色头像，无需改组件结构。

#### D3. 单消息气泡设计优势

新的"一个气泡+内联着色"设计在多角色场景下的好处：
- 每个角色一个气泡，气泡左侧是该角色头像 → **一看就知道谁在说话**
- 不会出现"A角色的动作框"紧跟着"B角色的对话框"导致混淆
- 气泡下方可以显示角色名（目前位置显示模型名，未来可替换为角色名）

---

## 三、改动文件清单

| 文件 | 改动内容 | 优先级 |
|------|---------|-------|
| `backend/app/api/character_ext.py` | 修改 `_build_char_system_prompt` 添加格式指引 | P0 |
| `frontend/src/components/ui/custom/Message.tsx` | 新解析器 + 一体化气泡 + 角色头像 + 模型名位置 | P0 |
| `frontend/src/components/views/CharacterView.tsx` | 调整Message传参、修复storyline导航 | P0 |
| `backend/app/memory_module/storage.py` | 添加 `branch_id` 字段支持 | P1 |
| `backend/app/api/memory.py` | 接口增加 `branch_id` 参数 | P1 |
| `backend/app/memory_module/compression_service.py` | 压缩服务支持按分支过滤 | P1 |
| `backend/alembic/versions/新迁移文件` | 数据库schema更新 | P1 |
| `frontend/src/hooks/useCharacterChat.ts` | 确保branch_id在记忆操作中传递 | P1 |
| `backend/app/models/character.py` | 预留 character_id 字段（可选） | P2 |

---

## 四、实施顺序

1. **第一步**：改Message.tsx的解析器和渲染（纯前端，不影响后端，立即可见效果）
2. **第二步**：改后端`_build_char_system_prompt`（新的格式指引）
3. **第三步**：改头像显示和模型名位置
4. **第四步**：修复故事线跳转逻辑（前端）
5. **第五步**：后端记忆隔离（数据库迁移 + API修改）
6. **第六步**：前后端联调记忆隔离

---

## 五、Tokens节省对比

| 格式 | 每次标记开销 |
|------|------------|
| `<action>...</action>` | 约 8 tokens |
| `<thinking>...</thinking>` | 约 8 tokens |
| `[action]...[/action]` | 约 6 tokens |
| `"..."` (双引号) | 约 2 tokens |
| `*...*` (星号) | 约 2 tokens |

按平均每条AI回复包含3个标记计算：
- 旧方案：~22 tokens/条 × 30条历史 = **660 tokens浪费**
- 新方案：~6 tokens/条 × 30条历史 = **180 tokens浪费**
- **节省约73%的格式标记tokens**

---

## 六、风险与回退

1. **旧消息兼容**：解析器内置旧标签→新格式的转换层，零风险
2. **LLM不遵守新格式**：大部分LLM天然使用引号+星号格式，且我们添加了格式指引。万一不遵守，解析器会把所有内容当做narration显示，不会出错，只是没有颜色区分
3. **记忆迁移**：现有记忆没有branch_id，查询时 `branch_id IS NULL` 的记忆会被视为属于所有分支（向后兼容）
