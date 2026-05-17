# Palink-AI 实施计划（Phase 6 + Phase 7）

> 本文件是给执行对话用的完整计划，请直接交给新对话执行，勿修改。

---

## 背景与决策记录

- **世界书** → 改为 SillyTavern 原版**关键词触发**模式（不再是线性阶段）
- **剧情线（PlotLine）** → 独立为新功能，归属于用户，手动挂到会话（与世界书一致），保留 AI 解析 + 线性阶段翻页
- **⋮ 菜单** → 世界书控制 + 剧情线控制合并在同一菜单区块
- **AI 解析按钮** → 世界书删掉，剧情线保留
- **Token 统计** → 新增"用量统计"设置 Tab，普通聊天 + 角色聊天分栏预览，点击进详情（recharts 折线图 + 模型 badge + 按角色聚合）

---

## Phase 6：世界书关键词化 + 剧情线独立

### Phase 6A — 世界书后端重构（关键词引擎）

**Step 1** — 新建迁移 `backend/alembic/versions/0003_worldbook_keyword_mode.py`

```python
# 依赖: 0002_add_worldbook_tables
# world_book_stages 表 ADD 列:
#   keys          TEXT nullable        (JSON 数组，关键词列表)
#   secondary_keys TEXT nullable       (JSON 数组，二级关键词)
#   scan_depth    INTEGER default 4    (扫描最近 N 条消息)
#   position      INTEGER default 4    (注入位置，SillyTavern 兼容，0-4)
#   selective     BOOLEAN default 0    (true = 同时需要 secondary_keys 命中)
#   probability   INTEGER default 100  (0-100 触发概率)
#   constant      BOOLEAN default 0    (true = 无条件注入)
#
# session_world_books 表:
#   current_stage_index    → 改为 nullable (SQLite 不能 DROP，保留为 nullable)
#   stage_transition_mode  → 改为 nullable
```

SQLite 中 ALTER TABLE ADD COLUMN 语法，注意 Boolean 用 INTEGER 实现。

---

**Step 2** — 修改 `backend/app/models/worldbook.py`

`WorldBookStage` 类加 7 个新字段：
```python
keys = Column(Text, nullable=True)           # JSON array string
secondary_keys = Column(Text, nullable=True) # JSON array string
scan_depth = Column(Integer, default=4)
position = Column(Integer, default=4)
selective = Column(Boolean, default=False)
probability = Column(Integer, default=100)
constant = Column(Boolean, default=False)
```

`WorldBook.stages` 关系名改为 `entries`（back_populates 同步改）：
```python
entries = relationship("WorldBookStage", back_populates="world_book", ...)
```

`SessionWorldBook`：两字段改为 nullable：
```python
current_stage_index = Column(Integer, nullable=True)
stage_transition_mode = Column(String, nullable=True)
```

---

**Step 3** — 修改 `backend/app/schemas/worldbook.py`

- `WorldBookStageUpdate` / `WorldBookStageResponse` 加字段：
  `keys: Optional[List[str]]`, `secondary_keys: Optional[List[str]]`, `scan_depth: int = 4`, `position: int = 4`, `selective: bool = False`, `probability: int = 100`, `constant: bool = False`
- 删除 `StageTransitionRequest`, `StageTransitionResponse`
- `SessionWorldBookCreate` 删除 `stage_transition_mode` 字段
- `SessionWorldBookResponse` 删除 `current_stage_index`, `stage_transition_mode` 字段
- `WorldBookStatus` 响应改为：
  ```python
  active: bool
  world_book_id: Optional[str]
  world_book_name: Optional[str]
  active_entries_count: int = 0   # 替代 current_stage_index
  entries_overview: List[dict]    # [{id, title, keys_preview}]
  ```

---

**Step 4** — 大改 `backend/app/services/worldbook_service.py`

删除：
- `parse_worldbook_into_stages()` 整个函数
- `check_stage_transition()` 整个函数
- 相关 PARSE_SYSTEM_PROMPT, TRANSITION_CHECK_PROMPT 常量

重写 `build_worldbook_context` 函数签名和逻辑：

```python
def build_worldbook_context(
    db: DBSession,
    session_id: str,
    recent_messages: list[dict]   # [{"role": "user"|"assistant", "content": "..."}]
) -> Optional[str]:
    """
    关键词触发引擎：
    1. 查 SessionWorldBook 得 world_book_id（无则返回 None）
    2. 查 WorldBookStage 所有词条（该 world_book_id 下）
    3. 对每条词条：
       a. constant=True → 直接收录
       b. 否则扫描 recent_messages 最后 entry.scan_depth 条，
          在 content 中查找 entry.keys 里任意关键词（不区分大小写）
       c. 若 selective=True：还需命中 entry.secondary_keys 至少一个
       d. 命中后按 entry.probability/100 概率过滤（random.random() * 100 < probability）
    4. 收集命中 entries，按 priority DESC, stage_index ASC 排序
    5. 贪心注入 token 预算（默认上限 4000 token，len(content)//4 估算）
    6. 拼接注入文本：
       [World Lore]
       {entry1.content}

       {entry2.content}
    7. 无命中返回 None
    """
```

注意：`keys` 字段从数据库取出是 JSON 字符串，需要 `json.loads()` 解析。

---

**Step 5** — 修改 `backend/app/api/worldbook.py`

**更新 import 端点**（`POST /api/worldbooks/import`）中的字段映射：
```python
# SillyTavern V2 entry 字段 → 数据库字段
entry_data = {
    "title":          entry.get("comment", ""),           # comment → title
    "content":        entry.get("content", ""),
    "keys":           json.dumps(entry.get("key", [])),   # key → keys (JSON)
    "secondary_keys": json.dumps(entry.get("keysecondary", [])),
    "scan_depth":     entry.get("scanDepth", 4),
    "position":       entry.get("position", 4),
    "selective":      entry.get("selective", False),
    "probability":    entry.get("probability", 100),
    "constant":       entry.get("constant", False),
    "priority":       10 if entry.get("constant") else 5,
    "stage_index":    order_index,                        # order → stage_index
    # 跳过 disable=True 的词条: if entry.get("disable"): continue
}
```

**删除以下端点：**
- `POST /api/worldbooks/{id}/parse`
- `POST /api/character-sessions/{session_id}/worldbook/transition`

**更新 session status 端点** `GET /api/character-sessions/{session_id}/worldbook/status`：
返回 `active_entries_count`（count all entries for the world book），不再返回 `current_stage_index`。

---

**Step 6** — 修改 `backend/app/api/character_ext.py`

**顶部 import（约 line 25）**：
```python
# 删除: from ..services.worldbook_service import build_worldbook_context, check_stage_transition
# 改为:
from ..services.worldbook_service import build_worldbook_context
```

**注入点（约 line 1020-1030）**：
```python
# 修改 build_worldbook_context 调用，传入 recent_messages
# 需要在此处取最近 8 条消息
try:
    from ..models.character import CharacterChatMessage as CCM
    recent_for_wb = db.query(CCM).filter(
        CCM.session_id == session_id
    ).order_by(CCM.created_at.desc()).limit(8).all()[::-1]
    recent_msgs_for_wb = [{"role": m.role, "content": m.content} for m in recent_for_wb]
    wb_context = build_worldbook_context(db, session_id, recent_msgs_for_wb)
    if wb_context:
        system_prompt += "\n\n" + wb_context
except Exception as e:
    logger.warning(f"World book context injection failed: {e}")
```

**删除 stage transition 调用段（约 line 1200-1215）**：
```python
# 删除整段（约 15 行）:
# try:
#     from ..models.character import CharacterChatMessage as CCM
#     recent = new_db.query(...).limit(6)...
#     transition = asyncio.get_event_loop().run_until_complete(
#         check_stage_transition(...)
#     )
#     ...
# except Exception as e:
#     logger.warning(f"Stage transition check failed: {e}")
```

---

### Phase 6B — 世界书前端更新（依赖 6A）

**Step 7** — 修改 `frontend/src/types/index.ts`

`WorldBookStage` 接口加字段：
```typescript
keys?: string[];
secondary_keys?: string[];
scan_depth: number;        // default 4
position: number;          // default 4
selective: boolean;
probability: number;       // 0-100, default 100
constant: boolean;
```
删除 `transition_hint?: string`（或保留为 optional 兼容）

`SessionWorldBook` 接口：删除 `current_stage_index` 和 `stage_transition_mode`

`WorldBookStatus` 接口改为：
```typescript
export interface WorldBookStatus {
  active: boolean;
  world_book_id?: string;
  world_book_name?: string;
  active_entries_count: number;
  entries_overview?: Array<{ id: string; title?: string; keys_preview: string }>;
}
```

删除 `StageTransitionResult` 接口

---

**Step 8** — 修改 `frontend/src/services/worldbookApi.ts`

删除以下方法：
- `parse(id, model?)` — AI 解析
- `nextStage(sessionId)`
- `prevStage(sessionId)`
- `jumpToStage(sessionId, index)`
- `transitionStage(sessionId, action, targetIndex?)`

保留：CRUD、import、updateStage、associateSession、disassociateSession、getSessionStatus

---

**Step 9** — 修改 `frontend/src/hooks/useWorldBook.ts`

删除以下方法：
- `parseWorldBook(id, model?)`
- `nextStage(sessionId)`
- `prevStage(sessionId)`
- `jumpToStage(sessionId, index)`

删除 `parsing` state（解析 loading 状态）  
保留其他所有 state 和方法

---

**Step 10** — 修改 `frontend/src/components/ui/custom/StageIndicator.tsx`

改为世界书"激活词条"数量 badge，**不再显示进度点阵**：

```tsx
// 输入: status: WorldBookStatus
// 显示: BookOpen 图标 + 世界书名 + "N 条激活" badge
// 隐藏条件: !status.active
// 样式: 小型内联 badge，放在 CharacterChat header 中
```

组件大幅简化，大约 30 行。

---

**Step 11** — 修改 `frontend/src/components/ui/custom/StageControls.tsx`

此文件在 6D 中被 PlotLine 复用，**现在先保留文件但清空世界书相关逻辑**，改为接受 PlotLineStatus（Step 24 完成）。若两步同时做则直接在此处改为 PlotLine 版本。

---

**Step 12** — 修改 `frontend/src/components/ui/custom/WorldBookManager.tsx`

词条列表/编辑区域的改动：
1. **删除 AI 解析按钮**（调用 `parseWorldBook` 的按钮）
2. 词条编辑区新增字段：
   - **关键词**：逗号分隔的 tag 输入框（解析为 `keys` 数组）
   - **二级关键词**（可折叠）：`secondary_keys`
   - **Constant 开关**：`<Switch>` 控件，开启时无需关键词
   - **概率**（0-100）：数字输入框，仅当非 constant 时显示
   - **扫描深度**：数字输入框（默认 4）
3. 词条列表行显示：关键词标签 preview（超出截断为"k1, k2..."）+ constant badge

---

**Step 13** — 修改 `frontend/src/components/views/character/CharacterChat.tsx`

⋮ 菜单改动：
- 删除所有 `StageControls` / `prevStage` / `nextStage` / `jumpToStage` 相关代码
- 世界书区块保留：关联世界书、世界书管理器按钮
- Step 26 完成后在同一区块新增剧情线条目

Header 改动：
- `StageIndicator` 改传 `worldBookStatus`（新 badge 样式）

---

### Phase 6C — 剧情线后端（新建，与 6A 并行）

**Step 14** — 新建 `backend/app/models/plotline.py`

```python
class PlotLine(Base):
    __tablename__ = "plot_lines"
    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    raw_content = Column(Text, nullable=True)
    tags = Column(Text, nullable=True)   # JSON array string
    is_parsed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    user = relationship("User")
    stages = relationship("PlotStage", back_populates="plot_line", cascade="all, delete-orphan", order_by="PlotStage.stage_index")

class PlotStage(Base):
    __tablename__ = "plot_stages"
    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    plot_line_id = Column(String, ForeignKey("plot_lines.id", ondelete="CASCADE"), nullable=False)
    stage_index = Column(Integer, default=0, nullable=False)
    title = Column(String, nullable=True)
    content = Column(Text, nullable=False)
    summary = Column(Text, nullable=True)
    transition_hint = Column(Text, nullable=True)
    priority = Column(Integer, default=5)
    token_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)
    plot_line = relationship("PlotLine", back_populates="stages")

class SessionPlotLine(Base):
    __tablename__ = "session_plot_lines"
    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    session_id = Column(String, ForeignKey("character_chat_sessions.id", ondelete="CASCADE"), nullable=False, unique=True)
    plot_line_id = Column(String, ForeignKey("plot_lines.id", ondelete="CASCADE"), nullable=False)
    current_stage_index = Column(Integer, default=0)
    stage_transition_mode = Column(String, default="auto")  # "auto" | "manual"
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    plot_line = relationship("PlotLine")
    UniqueConstraint("session_id")
```

在 `backend/app/models/__init__.py` 中添加导入。

---

**Step 15** — 新建 `backend/app/schemas/plotline.py`

完整镜像旧世界书 schemas，把 `WorldBook*` 改为 `PlotLine*`：

```python
class PlotLineCreate(BaseModel):
    name: str
    description: Optional[str]
    raw_content: Optional[str]
    tags: Optional[List[str]]

class PlotLineUpdate(BaseModel):
    name: Optional[str]
    description: Optional[str]
    raw_content: Optional[str]
    tags: Optional[List[str]]

class PlotLineResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    tags: Optional[List[str]]
    is_parsed: bool
    stage_count: int
    created_at: datetime
    updated_at: datetime

class PlotLineDetailResponse(PlotLineResponse):
    stages: List[PlotStageResponse]
    raw_content: Optional[str]

class PlotStageUpdate(BaseModel):
    title: Optional[str]
    content: Optional[str]
    summary: Optional[str]
    transition_hint: Optional[str]
    priority: Optional[int]

class PlotStageResponse(BaseModel):
    id: str
    plot_line_id: str
    stage_index: int
    title: Optional[str]
    content: str
    summary: Optional[str]
    transition_hint: Optional[str]
    priority: int
    token_count: int

class SessionPlotLineCreate(BaseModel):
    plot_line_id: str
    stage_transition_mode: Optional[str] = "auto"

class SessionPlotLineResponse(BaseModel):
    id: str
    session_id: str
    plot_line_id: str
    current_stage_index: int
    stage_transition_mode: str
    plot_line: Optional[PlotLineResponse]
    stages: Optional[List[PlotStageResponse]]
    created_at: datetime
    updated_at: datetime

class PlotStageTransitionRequest(BaseModel):
    action: str  # "next" | "prev" | "jump"
    target_stage_index: Optional[int]

class PlotStageTransitionResponse(BaseModel):
    previous_stage_index: int
    current_stage_index: int
    stage_title: Optional[str]
    total_stages: int

class PlotLineParseRequest(BaseModel):
    model: Optional[str]

class PlotLineStatus(BaseModel):
    active: bool
    plot_line_id: Optional[str]
    plot_line_name: Optional[str]
    current_stage_index: Optional[int]
    total_stages: Optional[int]
    stage_transition_mode: Optional[str]
    current_stage: Optional[PlotStageResponse]
    stages_overview: Optional[List[dict]]
```

---

**Step 16** — 新建 `backend/app/services/plotline_service.py`

从旧 `worldbook_service.py` **移植**（修改表/类引用）：

1. `parse_plotline_into_stages(db, plot_line_id, model_id?)` — 将 `WorldBookStage` 改为 `PlotStage`，`world_book_id` 改为 `plot_line_id`，逻辑完全相同
2. `check_plotline_transition(db, session_id, recent_messages, model_id?)` — 将 `SessionWorldBook`/`WorldBookStage` 改为 `SessionPlotLine`/`PlotStage`，逻辑完全相同
3. `build_plotline_context(db, session_id) -> Optional[str]` — 将旧 `build_worldbook_context` 的**线性阶段逻辑**（注入当前阶段全文 + 历史摘要）移植过来，引用 `SessionPlotLine`/`PlotStage`

注意：此服务中的 `build_plotline_context` 是**同步函数**，不需要 recent_messages 参数（线性模式直接用 current_stage_index）。

---

**Step 17** — 新建 `backend/app/api/plotline.py`

完整复刻旧 `worldbook.py` 的端点结构，改为 PlotLine：

```
# PlotLine CRUD
GET    /api/plotlines                          → 列出用户所有剧情线
POST   /api/plotlines                          → 创建新剧情线
GET    /api/plotlines/{id}                     → 获取详情（含 stages）
PUT    /api/plotlines/{id}                     → 更新
DELETE /api/plotlines/{id}                     → 删除（级联）

# Import & Parse
POST   /api/plotlines/{id}/parse               → AI 解析 raw_content 为阶段

# Stage Editing
PUT    /api/plotlines/{id}/stages/{stage_id}   → 编辑单个阶段

# Session Association
POST   /api/character-sessions/{session_id}/plotline           → 挂载
DELETE /api/character-sessions/{session_id}/plotline           → 卸载
GET    /api/character-sessions/{session_id}/plotline/status    → 状态
POST   /api/character-sessions/{session_id}/plotline/transition → 手动翻页
```

注意：Session 相关端点用 `router_session_pl = APIRouter()` 分开定义，与主 router 分开注册。

---

**Step 18** — 新建 `backend/alembic/versions/0004_add_plotline_tables.py`

```python
# 依赖: 0003_worldbook_keyword_mode
# 创建三张表: plot_lines, plot_stages, session_plot_lines
# plot_lines: id/user_id/name/description/raw_content/tags/is_parsed/created_at/updated_at
# plot_stages: id/plot_line_id(FK CASCADE)/stage_index/title/content/summary/transition_hint/priority/token_count/created_at
# session_plot_lines: id/session_id(FK CASCADE UNIQUE)/plot_line_id(FK CASCADE)/current_stage_index/stage_transition_mode/created_at/updated_at
```

---

**Step 19** — 修改 `backend/app/api/__init__.py` 和 `backend/app/main.py`

在 `__init__.py` 中添加：
```python
from .plotline import router as plotline_router, router_session_pl
```

在 `main.py` 的 router 注册区域添加：
```python
app.include_router(plotline_router)
app.include_router(router_session_pl)
```

---

**Step 20** — 修改 `backend/app/api/character_ext.py`（6A 和 6C 全部完成后做）

顶部 import 新增：
```python
from ..services.plotline_service import build_plotline_context, check_plotline_transition
```

在世界书 context 注入之后（约 line 1033）新增剧情线注入：
```python
# ── Inject plot line context ─────────────────────────────────────────
try:
    pl_context = build_plotline_context(db, session_id)
    if pl_context:
        system_prompt += "\n\n" + pl_context
except Exception as e:
    logger.warning(f"Plot line context injection failed: {e}")
```

在 assistant 消息保存后（约 line 1215 区域），替代被删除的 worldbook transition，新增 plotline transition：
```python
# Check plot line stage transition (auto mode)
try:
    import asyncio
    pl_transition = asyncio.get_event_loop().run_until_complete(
        check_plotline_transition(new_db, session_id, recent_msgs, req.model)
    )
    if pl_transition and pl_transition.get("should_transition"):
        logger.info(f"Plot line stage transition: {pl_transition}")
except Exception as e:
    logger.warning(f"Plot line transition check failed: {e}")
```

---

### Phase 6D — 剧情线前端（新建，依赖 6C）

**Step 21** — 修改 `frontend/src/types/index.ts`

新增接口（在 WorldBook 接口之后）：
```typescript
export interface PlotLine {
  id: string;
  name: string;
  description?: string;
  raw_content?: string;
  tags?: string[];
  is_parsed: boolean;
  stage_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlotStage {
  id: string;
  plot_line_id: string;
  stage_index: number;
  title?: string;
  content: string;
  summary?: string;
  transition_hint?: string;
  priority: number;
  token_count: number;
}

export interface PlotLineDetail extends Omit<PlotLine, 'stage_count'> {
  stages: PlotStage[];
}

export interface SessionPlotLine {
  id: string;
  session_id: string;
  plot_line_id: string;
  current_stage_index: number;
  stage_transition_mode: 'auto' | 'manual';
  plot_line?: PlotLine;
  stages?: PlotStage[];
  created_at: string;
  updated_at: string;
}

export interface PlotLineStatus {
  active: boolean;
  plot_line_id?: string;
  plot_line_name?: string;
  current_stage_index?: number;
  total_stages?: number;
  stage_transition_mode?: string;
  current_stage?: PlotStage;
  stages_overview?: Array<{ index: number; title?: string; summary?: string }>;
}

export interface PlotStageTransitionResult {
  previous_stage_index: number;
  current_stage_index: number;
  stage_title?: string;
  total_stages: number;
}
```

---

**Step 22** — 新建 `frontend/src/services/plotlineApi.ts`

完整镜像 `worldbookApi.ts`，把端点路径从 `/api/worldbooks` 改为 `/api/plotlines`，类型从 `WorldBook*` 改为 `PlotLine*`：

```typescript
export const plotlineApi = {
  list: () => api.get<PlotLine[]>('/api/plotlines'),
  create: (data: {...}) => api.post<PlotLine>('/api/plotlines', data),
  get: (id: string) => api.get<PlotLineDetail>(`/api/plotlines/${id}`),
  update: (id: string, data: {...}) => api.put<PlotLine>(`/api/plotlines/${id}`, data),
  delete: (id: string) => api.delete(`/api/plotlines/${id}`),
  parse: (id: string, model?: string) => api.post(`/api/plotlines/${id}/parse`, { model }),
  updateStage: (plotLineId: string, stageId: string, data: {...}) =>
    api.put(`/api/plotlines/${plotLineId}/stages/${stageId}`, data),
  associateSession: (sessionId: string, data: { plot_line_id: string; stage_transition_mode?: string }) =>
    api.post<SessionPlotLine>(`/api/character-sessions/${sessionId}/plotline`, data),
  disassociateSession: (sessionId: string) =>
    api.delete(`/api/character-sessions/${sessionId}/plotline`),
  getSessionStatus: (sessionId: string) =>
    api.get<PlotLineStatus>(`/api/character-sessions/${sessionId}/plotline/status`),
  transitionStage: (sessionId: string, action: string, targetIndex?: number) =>
    api.post<PlotStageTransitionResult>(
      `/api/character-sessions/${sessionId}/plotline/transition`,
      { action, target_stage_index: targetIndex }
    ),
};
```

---

**Step 23** — 新建 `frontend/src/hooks/usePlotLine.ts`

完整镜像 `useWorldBook.ts`，引用 plotlineApi、PlotLine* 类型：

State：
- `plotLines: PlotLine[]`
- `selectedPlotLine: PlotLineDetail | null`
- `sessionStatus: PlotLineStatus | null`
- `loading: boolean`, `parsing: boolean`

Methods：
- `loadPlotLines()`, `createPlotLine(data)`, `updatePlotLine(id, data)`, `deletePlotLine(id)`
- `loadPlotLineDetail(id)`, `parsePlotLine(id, model?)`（保留 AI 解析）
- `associateSession(sessionId, plotLineId, mode?)`, `disassociateSession(sessionId)`, `loadSessionStatus(sessionId)`
- `nextStage(sessionId)`, `prevStage(sessionId)`, `jumpToStage(sessionId, index)`

---

**Step 24** — 修改 `frontend/src/components/ui/custom/StageIndicator.tsx`

Props 改为接受 `PlotLineStatus`（专服剧情线，不再用于世界书）：
```tsx
interface StageIndicatorProps {
  status: PlotLineStatus;
  onStageClick?: (index: number) => void;
}
```
显示逻辑不变（进度点阵、当前阶段名、阶段计数），只是类型引用从 WorldBookStatus 改为 PlotLineStatus，字段名同步。

修改 `frontend/src/components/ui/custom/StageControls.tsx`（Step 11 中被保留）：
Props 类型从 WorldBookStatus 改为 PlotLineStatus，callbacks 类型同步。

---

**Step 25** — 新建 `frontend/src/components/ui/custom/PlotLineManager.tsx`

复用 `WorldBookManager.tsx` 组件结构：
- 剧情线列表（名称、阶段数、is_parsed badge）
- 选中后展示阶段列表（可折叠）
- 每个阶段可编辑：title, content, summary, transition_hint, priority
- 底部：**AI 解析按钮**（调用 `parsePlotLine(id)`，显示 `parsing` loading 状态）
- 关联/解除关联当前会话的按钮

---

**Step 26** — 修改 `frontend/src/components/views/character/CharacterChat.tsx`

⋮ 菜单新增剧情线区块，与世界书区块相邻（同一分隔符内）：

```
──────────────────────────
📖 世界书 & 剧情线
  ·关联世界书…
  ·世界书管理器
  ·关联剧情线…          ← 新增
  ·剧情线管理器         ← 新增
  ─ 剧情线进度 ─        ← 新增（仅在关联了剧情线时显示）
  [←上一阶段] [N/Total] [下一阶段→]   ← StageControls 内联
──────────────────────────
🧠 记忆 & 统计
  ...
```

Header 区域：
- 保留世界书 badge（Step 10 的新版 StageIndicator WorldBook badge）
- 新增剧情线 StageIndicator（PlotLineStatus，点阵进度条）

Props/hook 新增：
- `plotLineStatus: PlotLineStatus | null`
- `usePlotLine()` hook 引入

---

## Phase 7：Token 消耗统计面板

### Phase 7A — 后端

**Step 27** — 新建 `backend/alembic/versions/0005_add_prompt_tokens.py`

```python
# 依赖: 0004_add_plotline_tables
# character_chat_messages ADD: prompt_tokens INTEGER DEFAULT 0
# messages ADD: prompt_tokens INTEGER DEFAULT 0
```

---

**Step 28** — 修改 `backend/app/models/character.py`

`CharacterChatMessage` 加字段：
```python
prompt_tokens = Column(Integer, default=0)
```

修改 `backend/app/models/message.py`：
```python
prompt_tokens = Column(Integer, default=0)
```

---

**Step 29** — 修改 `backend/app/api/character_ext.py`（约 line 1192）

保存 assistant 消息时补写 prompt_tokens：
```python
new_db.add(CharacterChatMessage(
    session_id=session_id,
    branch_id=branch_id,
    role="assistant",
    content=final,
    model=req.model,
    tokens=token_count,          # completion_tokens（已有）
    prompt_tokens=prompt_tokens,  # 新增
))
```

---

**Step 30** — 新建 `backend/app/api/stats.py`

```python
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta, timezone

router = APIRouter(prefix="/api/stats", tags=["stats"])

@router.get("/usage")
async def get_usage_stats(
    period: str = Query("month", regex="^(day|week|month|all)$"),
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    """
    返回 character_chat 和 regular_chat 两部分的 token 统计
    period: day=最近24h, week=最近7天, month=最近30天, all=全部
    """
    # 计算时间范围
    now = datetime.now(timezone.utc)
    if period == "day":
        since = now - timedelta(days=1)
    elif period == "week":
        since = now - timedelta(weeks=1)
    elif period == "month":
        since = now - timedelta(days=30)
    else:
        since = None  # all time

    # 查 character_chat_messages（含 character name join）
    # 查 messages（普通聊天）
    # 两者都按 user_id 过滤
    # 返回结构:
    # {
    #   "character_chat": {
    #     "summary": { "requests": N, "input": N, "output": N, "total": N },
    #     "by_model": [ { "model": str, "input": N, "output": N, "requests": N } ],
    #     "by_character": [ { "character_name": str, "input": N, "output": N, "requests": N } ],
    #     "daily": [ { "date": "YYYY-MM-DD", "input": N, "output": N } ]
    #   },
    #   "regular_chat": {
    #     "summary": {...},
    #     "by_model": [...],
    #     "daily": [...]
    #   }
    # }
```

**Character_chat SQL 逻辑：**
- JOIN `character_chat_sessions` → JOIN `characters`（获取 character name）
- WHERE `character_chat_sessions.user_id = user.id`
- GROUP BY model（by_model）, character name（by_character）, DATE(created_at)（daily）
- SUM(prompt_tokens) as input, SUM(tokens) as output, COUNT(*) WHERE role='assistant' as requests

**Regular_chat SQL 逻辑：**
- JOIN `sessions` WHERE `sessions.user_id = user.id`
- 同上聚合

---

**Step 31** — 修改 `backend/app/api/__init__.py` 和 `main.py`

注册 stats router：
```python
from .stats import router as stats_router
app.include_router(stats_router)
```

---

### Phase 7B — 前端

**Step 32** — 安装 recharts

```bash
cd frontend && npm install recharts
```
（在 package.json 中会自动添加）

---

**Step 33** — 修改 `frontend/src/components/views/SettingsView.tsx`

```typescript
// line 55: SettingsTab union 加 'usage'
type SettingsTab = 'profile' | 'appearance' | 'language' | 'models' | 'memory' | 'oc' | 'admin_users' | 'admin_defaults' | 'admin_starters' | 'about' | 'usage';

// tabs 数组（line ~536）加入：
{ id: 'usage' as SettingsTab, label: '用量统计', icon: Zap }

// 内容区域加入（与其他 activeTab === '...' 并列）：
{activeTab === 'usage' && <TokenUsagePanel />}
```

在 imports 中添加：
```typescript
import { TokenUsagePanel } from '@/components/ui/custom/TokenUsagePanel';
```

---

**Step 34** — 新建 `frontend/src/components/ui/custom/TokenUsagePanel.tsx`

完整组件，包含：

**a. 数据获取**
```typescript
const [period, setPeriod] = useState<'day'|'week'|'month'|'all'>('month');
const [data, setData] = useState<UsageData | null>(null);
const [detail, setDetail] = useState<'character' | 'regular' | null>(null);

useEffect(() => {
  api.get(`/api/stats/usage?period=${period}`).then(setData);
}, [period]);
```

**b. 预览层（detail === null）**

```tsx
// 时间范围选择器（4个 Button Toggle）
// 两列 GlassCard:
//   左卡: 💬 普通聊天
//     ArrowUpCircle 输入: 18,000
//     ArrowDownCircle 输出: 4,000
//     MessageSquare 请求: 40 次
//     点击 → setDetail('regular')
//   右卡: ✨ 角色聊天
//     ArrowUpCircle 输入: 30,000
//     ArrowDownCircle 输出: 8,000
//     Sparkles 请求: 80 次
//     点击 → setDetail('character')
```

**c. 详情层（detail !== null）**

```tsx
// 返回按钮 (← 返回)
// 标题: "角色聊天详情" / "普通聊天详情"
//
// 1. 统计卡片行（3个小卡片：输入总计 / 输出总计 / 请求次数）
//
// 2. 折线趋势图（Recharts LineChart）
//    - X轴: date
//    - Y轴: token 数
//    - 两条线: input（蓝色, ArrowUpCircle 图例）/ output（绿色, ArrowDownCircle 图例）
//    - Tooltip 显示具体数值
//    - ResponsiveContainer 自适应宽度
//
// 3. 按模型 Badge 列表
//    每个模型一个 badge（可点击高亮过滤图表）:
//    "gpt-4o  ↑20,000  ↓5,000  50次"
//
// 4. 若 detail === 'character': 显示按角色聚合表格
//    表头: 角色名 | 请求数 | 输入 Token | 输出 Token
//    每行一个角色
```

**d. 数字格式化工具函数**
```typescript
const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n/1_000).toFixed(1)}k`;
  return n.toString();
};
```

**e. Skeleton 加载状态**：data === null 时显示 Skeleton 占位

---

## 执行顺序与依赖

```
6A (后端世界书) ──┐
                  ├──→ 6B (前端世界书)
6C (后端剧情线) ──┤
                  ├──→ 6D (前端剧情线)
                  └──→ Step 20 (character_ext.py 双注入)
7A (后端统计) ────→ 7B (前端统计面板)
```

Phase 6A 和 6C 可并行执行；7A/7B 独立，可与 6 并行。

---

## 验证清单

### Phase 6 验证
- [ ] `alembic upgrade head` — 迁移 0003 / 0004 均成功
- [ ] 后端 `uvicorn app.main:app --reload` 启动无报错
- [ ] `POST /api/worldbooks/import` 导入 SillyTavern V2 JSON → `keys`/`constant`/`probability` 字段正确写入
- [ ] 发送聊天消息，命中关键词 → `build_worldbook_context` 只注入匹配词条，不注入未命中词条
- [ ] Constant=True 词条每次都被注入
- [ ] 创建剧情线 → AI 解析 → 生成阶段（测试 `POST /api/plotlines/{id}/parse`）
- [ ] 会话挂载剧情线后 `buildPlotlineContext` 注入当前阶段
- [ ] 前端 `vite build` 无 TS 报错
- [ ] UI：⋮ 菜单世界书区块 + 剧情线区块在同一分隔符内并存
- [ ] Header：世界书 "N 条激活" badge + 剧情线 StageIndicator 点阵并存

### Phase 7 验证
- [ ] `alembic upgrade head` — 迁移 0005 成功
- [ ] 发一条角色聊天 → `SELECT prompt_tokens FROM character_chat_messages ORDER BY id DESC LIMIT 1` 有值
- [ ] `GET /api/stats/usage?period=month` 返回 `character_chat` + `regular_chat` 双结构
- [ ] 设置页 → 用量统计 Tab → 两列预览卡片显示
- [ ] 点击 "角色聊天" → 详情页：折线图 + 模型 badge + 角色分组表
- [ ] 时间范围切换（今天/本周/本月/全部）→ 数据刷新
- [ ] `vite build` 无报错

---

## 关键已知代码位置

| 位置 | 说明 |
|------|------|
| `character_ext.py` line 25 | worldbook service import |
| `character_ext.py` line 1020-1030 | worldbook context 注入点 |
| `character_ext.py` line 1175-1185 | SSE usage event（含 prompt_tokens）|
| `character_ext.py` line 1190-1202 | 保存 assistant 消息 |
| `character_ext.py` line 1200-1215 | 旧 stage transition 调用（需删除）|
| `WorldBookStage.keys` | JSON TEXT 字段，读取需 `json.loads()` |
| SillyTavern V2 `entry.key` | 已是 list，直接 `json.dumps()` 存入 |
| `SettingsView.tsx` line 55 | SettingsTab type |
| `SettingsView.tsx` line 536 | tabs 数组 |
| `CharacterChat.tsx` line 590-605 | ⋮ 菜单 memoryStats 区块（参考结构）|
