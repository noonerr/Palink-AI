# 方向1：原生ST保底方案完美实现计划

> 生成时间: 2026-06-17
> 目标: 让原生SillyTavern作为保底方案完美可用，从Palink导入的角色卡数据100%完全导入同步ST，包括前端卡、插件对话记录等

---

## 一、当前状态评估

### 已完成（约75-80%）
- ✅ 双模式ST嵌入架构（内嵌模式 + ST Native sidecar模式）
- ✅ 完整的ST API兼容层（19+端点，覆盖角色/会话/世界书/生成）
- ✅ 角色卡V2/V3双规范转换（约90%）
- ✅ 双向消息同步（Palink DB ↔ ST格式）
- ✅ 桥接通信机制（bridge.js 627行）
- ✅ 完整ST 1.18.0前端资源

### 关键缺口
1. ❌ ST Native同步层未实现（Palink DB ↔ ST DATA_ROOT）
2. ❌ 插件对话记录同步缺失
3. ❌ SmartCard渲染层标签清理不完整
4. ❌ 群组聊天API未实现
5. ❌ 双向编辑回写未实现（ST Native → Palink DB）

---

## 二、完美实现目标

### 2.1 核心目标
- **角色卡100%同步**：Palink角色卡的所有字段（含extensions、depth_prompt、alternate_greetings、creator_notes、tags）完整同步到ST
- **前端卡（SmartCard）完整导入**：SmartCard的UI状态、渲染层标签、触发消息完整处理
- **插件对话记录同步**：插件产生的对话记录、系统消息、临时消息完整同步
- **双向编辑回写**：在ST中编辑角色/会话后，变更回写到Palink DB
- **群组聊天兼容**：支持ST群组聊天功能

### 2.2 验收标准
- [ ] Palink角色卡导入ST后，所有字段无丢失
- [ ] SmartCard启动后的对话历史在ST中无UI噪音
- [ ] 插件产生的对话记录可在ST中完整查看
- [ ] ST Native模式下编辑角色卡，Palink DB同步更新
- [ ] ST Native模式下编辑会话消息，Palink DB同步更新
- [ ] 群组聊天功能在ST兼容层可用

---

## 三、实现方案

### 3.1 ST Native同步层（P0）

**目标**：实现Palink DB与ST DATA_ROOT的双向同步

**方案**：采用"Palink DB为权威源 + ST DATA_ROOT为镜像"模式

**新增文件**：
- `backend/app/services/st_sync_service.py` - 同步服务核心
- `backend/app/api/st_sync.py` - 同步API端点

**同步策略**：
1. **角色卡同步**：Palink Character → ST character PNG文件
2. **会话同步**：Palink CharacterChatSession → ST jsonl文件
3. **世界书同步**：Palink WorldBook → ST worldinfo JSON文件
4. **变量同步**：Palink ChatVariable → ST chat_metadata.variables
5. **增量同步**：基于updated_at时间戳的增量推送

**同步触发时机**：
- 角色卡创建/更新/删除时
- 会话消息新增/编辑/删除时
- 世界书条目变更时
- 用户手动触发同步时
- ST Native启动时全量同步

### 3.2 插件对话记录同步（P0）

**目标**：将Palink插件产生的对话记录同步到ST

**方案**：扩展消息转换器，识别并处理插件消息

**实现**：
- 识别插件消息类型（系统消息、临时消息、工具调用消息）
- 转换为ST兼容的消息格式（is_system=true 或 extra字段标记）
- 保留插件元数据到extra字段

**修改文件**：
- `backend/app/api/silly_tavern.py` - 扩展`_message_to_st`和`_st_message_content`
- `backend/app/models/character.py` - 添加消息类型字段（如未存在）

### 3.3 SmartCard渲染层标签清理（P0）

**目标**：确保SmartCard的HTML标签在同步到ST时被正确清理

**方案**：实现完整的SmartCard标签清理器

**新增文件**：
- `backend/app/services/smart_card_cleaner.py` - SmartCard标签清理服务

**清理规则**：
- 移除 `<GameStart>...</GameStart>` 标签
- 移除 `<palink-html>...</palink-html>` 标签
- 移除 `<palink-ui>...</palink-ui>` 标签
- 保留标签内的纯文本内容（可选配置）
- 清理SmartCard触发短语

**修改文件**：
- `backend/app/api/silly_tavern.py` - 在消息同步时调用清理器
- `backend/app/services/character_message_builder.py` - 增强现有清理逻辑

### 3.4 群组聊天API兼容层（P1）

**目标**：实现ST群组聊天功能在Palink中的兼容

**方案**：基于Palink现有GroupChat模型实现ST兼容API

**新增端点**：
- `POST /api/groups/get` - 获取群组列表
- `POST /api/groups/create` - 创建群组
- `POST /api/groups/edit` - 编辑群组
- `POST /api/groups/delete` - 删除群组
- `POST /api/groups/member-get` - 获取成员
- `POST /api/groups/member-add` - 添加成员
- `POST /api/groups/member-remove` - 移除成员
- `POST /api/groups/chats` - 获取群组会话

**修改文件**：
- `backend/app/api/silly_tavern.py` - 添加群组端点
- `backend/app/models/character.py` - 添加GroupChat模型（如未存在）

### 3.5 双向编辑回写（P0）

**目标**：ST Native模式下的编辑操作回写到Palink DB

**方案**：拦截ST的保存API，同步回Palink DB

**实现**：
- 角色卡编辑回写：`/api/characters/edit` → 更新Palink Character
- 会话保存回写：`/api/chats/save` → 已实现，增强字段同步
- 世界书编辑回写：`/api/worldinfo/edit` → 已实现，验证完整性
- 变量变更回写：监听ST变量变更 → 更新Palink ChatVariable

**修改文件**：
- `backend/app/api/silly_tavern.py` - 添加`/api/characters/edit`端点
- `backend/app/character_card.py` - 添加ST格式转Palink Character的函数

---

## 四、实施阶段

### 阶段1：核心同步层（P0）
1. 创建`st_sync_service.py`同步服务
2. 实现角色卡双向同步
3. 实现会话双向同步
4. 实现世界书双向同步

### 阶段2：数据完整性（P0）
5. 实现SmartCard标签清理器
6. 实现插件对话记录同步
7. 实现变量同步

### 阶段3：功能补齐（P1）
8. 实现群组聊天API
9. 实现双向编辑回写
10. 实现增量同步优化

### 阶段4：验证与优化
11. 类型检查
12. 容器重建验证
13. 端到端测试

---

## 五、技术决策

### 5.1 同步模式选择
**选择**：Palink DB为权威源 + ST DATA_ROOT为镜像
**原因**：
- Palink DB已有完整数据模型和业务逻辑
- ST DATA_ROOT文件系统易于重建
- 避免双向同步冲突

### 5.2 同步触发机制
**选择**：事件驱动 + 手动触发
**原因**：
- 事件驱动保证实时性
- 手动触发提供兜底保障
- 避免轮询性能开销

### 5.3 数据一致性保障
- 同步操作幂等设计
- 基于时间戳的增量同步
- 同步失败重试机制
- 同步状态日志记录

---

## 六、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 同步冲突 | Palink DB为权威源，ST编辑触发回写 |
| 性能问题 | 增量同步 + 异步处理 |
| 数据丢失 | 同步前备份 + 同步日志 |
| 字段映射错误 | 完整的字段映射测试 |

---

## 七、验收清单

- [ ] 角色卡同步：所有字段完整保留
- [ ] SmartCard同步：UI标签正确清理
- [ ] 插件记录同步：对话历史完整
- [ ] 双向编辑：ST编辑回写Palink DB
- [ ] 群组聊天：ST群组功能可用
- [ ] 类型检查通过
- [ ] 容器重建成功
- [ ] 端到端功能验证
