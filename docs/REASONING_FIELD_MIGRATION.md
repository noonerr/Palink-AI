# Reasoning 字段迁移指南 (双写兼容方案)

> **目的**：本文档说明 Palink 后端在 ST 1.18.0 对齐过程中，对 LLM 思考链 (reasoning) 字段的双写兼容实现，为前端渐进迁移到 ST Native 渲染面板提供契约说明。

---

## 1. 背景

### 1.1 ST 1.18.0 行为
SillyTavern 1.18.0 把 LLM 思考链存放在消息 `extra.reasoning` 字段，配套字段：
- `extra.reasoning_type`: `"thinking"` | `"analysis"` | `"redacted"` (默认 `"thinking"`)
- `extra.reasoning_duration`: 思考耗时（秒，float）
- `extra.reasoning_display_text`: 用户可编辑的思考链显示文本（可选）

前端 reasoning 面板直接从 `extra.reasoning` 读取，并在 UI 上展示耗时与类型。

### 1.2 Palink 历史实现
在 ST 1.18.0 对齐之前，Palink 把 reasoning 内联到 `content` 中，用 Unicode 包裹符号 `⋇` (U+22C7) 和 `⋑` (U+22D1) 包裹：
```
⋇<reasoning text>⋑\n<actual content>
```
渲染层解析 `⋇...⋑` 提取思考链展示。

### 1.3 双写兼容方案
本次对齐采用 **双写兼容** 策略，不破坏现有 chat：
- **新消息生成时**：同时写入 content 内联（`⋇...⋑` 包裹，保持现状）和 `extra.reasoning`/`extra.reasoning_type`/`extra.reasoning_duration`
- **读取消息时**：优先读 `extra.reasoning`，回退到解析 content 中的 `⋇...⋑`
- **历史消息无需迁移**：自动向后兼容（读取时 fallback 到 content 解析）

---

## 2. 字段定义

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `extra.reasoning` | string | (无) | LLM 思考链原文（已应用正则脚本处理） |
| `extra.reasoning_type` | enum string | `"thinking"` | 思考链类型: `"thinking"` \| `"analysis"` \| `"redacted"` |
| `extra.reasoning_duration` | float | (无) | 思考耗时（秒，3 位小数） |
| `extra.reasoning_display_text` | string | (无) | 用户可编辑的思考链显示文本（可选，当前不主动生成） |

### 2.1 字段持久化位置
- 数据库列：`character_chat_messages.extra` (Text, JSON 字符串)
- 透传元组：`_ST_MESSAGE_EXTRA_FIELDS` (`backend/app/api/character_ext.py:191-225`)
- ST 同步提取：`_st_message_extra` (`backend/app/api/silly_tavern.py:1300-1332`)

### 2.2 写入路径
**character_ext.py 的 `persist_snapshot` 函数** (`backend/app/api/character_ext.py:4207-4219`):
```python
msg_extra: dict = {}
msg_extra["gen_id"] = stream_gen_id
if result.full_reasoning:
    msg_extra["reasoning"] = regexed_reasoning
    msg_extra["reasoning_type"] = "thinking"
    msg_extra["reasoning_duration"] = round(time.monotonic() - stream_start_ts, 3)
msg_extra["model"] = req.model
msg_extra["token_count"] = token_count
```

**websocket.py 的 `persist_snapshot` 函数** (`backend/app/api/websocket.py:500-510`):
同样的双写逻辑。

---

## 3. 前端契约

### 3.1 渲染 reasoning 时的优先级
```typescript
function getReasoning(message: ChatMessage): string | null {
  // 1. 优先读 extra.reasoning (ST 1.18.0 标准路径)
  if (message.extra?.reasoning) {
    return message.extra.reasoning;
  }
  // 2. 回退到 content 解析 ⋇...⋑ (兼容历史消息)
  const match = message.content.match(/⋇([^⋇⋑]+)⋑/);
  return match ? match[1] : null;
}
```

### 3.2 渲染 reasoning 元数据
```typescript
function getReasoningMeta(message: ChatMessage) {
  return {
    type: message.extra?.reasoning_type ?? "thinking",
    duration: message.extra?.reasoning_duration ?? null,
    displayText: message.extra?.reasoning_display_text ?? null,
  };
}
```

### 3.3 编辑 reasoning_display_text
当前后端不主动生成 `reasoning_display_text`。前端可以提供编辑 UI，让用户为思考链添加自定义显示文本。保存时通过 `/api/chats/save` 写入 `extra.reasoning_display_text`。

---

## 4. 兼容性说明

### 4.1 已有 chat 无需迁移脚本
- 读取路径自动 fallback：若 `extra.reasoning` 不存在，则解析 `content` 中的 `⋇...⋑`
- 新消息生成时双写：content 内联 + extra.reasoning 同时写入
- 历史消息的 `extra` 字段保持不变（若没有 reasoning 字段则读取时 fallback）

### 4.2 字段 round-trip 保障
- ST 卡片导入时：`_st_message_extra` (`silly_tavern.py:1300-1332`) 提取所有 21 个 extra 字段（含 reasoning 系列），保证 round-trip 不丢字段
- ST 卡片导出时：`_ST_MESSAGE_EXTRA_FIELDS` 元组 (`character_ext.py:191-225`) 包含 reasoning 系列字段

### 4.3 per-swipe 元数据
ST 1.18.0 每个 swipe 有独立的 `swipe_info[N].extra.{model, token_count, reasoning, reasoning_duration}`。本次实现通过 `msg_extra` 写入消息级 extra，由 `_compose_message_extra_with_swipe_info` 自动同步到当前 swipe 的 extra。

---

## 5. 未来清理路径

### 5.1 短期 (本次完成后)
- 前端可同时支持两种渲染路径（`extra.reasoning` 优先，回退 content 内联）
- 新消息会同时存在两份数据，确保兼容

### 5.2 中期 (所有前端切换到 ST Native 后)
- 移除 content 内联 `⋇...⋑` 写入逻辑（`character_ext.py:4204` 和 `websocket.py:497`）
- 仅保留 `extra.reasoning` 写入
- 写一个数据迁移脚本：扫描所有 `content` 包含 `⋇...⋑` 的消息，提取 reasoning 写入 `extra.reasoning`，然后从 content 中剥离

### 5.3 长期 (ST 2.0+)
- 完全移除 `⋇...⋑` 解析逻辑
- 仅保留 `extra.reasoning` 路径

---

## 6. 相关代码位置

### 6.1 后端写入
| 文件 | 位置 | 说明 |
|------|------|------|
| `backend/app/api/character_ext.py` | `:4127-4132` | `stream_gen_id` 和 `stream_start_ts` 初始化 |
| `backend/app/api/character_ext.py` | `:4207-4219` | `msg_extra` 构造 (reasoning 双写 + gen_id + per-swipe 元数据) |
| `backend/app/api/character_ext.py` | `:4232-4239`, `:4257-4264` | 两个 `_st_message_kwargs` 调用传递 `extra=msg_extra, gen_id=stream_gen_id` |
| `backend/app/api/character_ext.py` | `:4279` | `_sync_message_content_to_active_swipe(msg, final, extra=msg_extra)` |
| `backend/app/api/websocket.py` | `:440-444` | `stream_gen_id` 和 `stream_start_ts` 初始化 |
| `backend/app/api/websocket.py` | `:500-510` | `msg_extra` 构造 |
| `backend/app/api/websocket.py` | `:523-529`, `:550-556` | 两个 `_st_message_kwargs` 调用传递 extra/gen_id |
| `backend/app/api/websocket.py` | `:579-594` | else 分支 msg.extra 合并 (保留 swipe_info) |

### 6.2 后端读取/透传
| 文件 | 位置 | 说明 |
|------|------|------|
| `backend/app/api/character_ext.py` | `:191-225` | `_ST_MESSAGE_EXTRA_FIELDS` 元组 (21 字段) |
| `backend/app/api/silly_tavern.py` | `:1300-1332` | `_st_message_extra` 提取 21 字段 |
| `backend/app/services/character_message_builder.py` | `:155-167` | IGNORE_SYMBOL 过滤 (跳过 `extra.ignore=true` 的消息) |

### 6.3 数据库
| 表/列 | 说明 |
|-------|------|
| `character_chat_messages.extra` (Text, nullable) | JSON 字符串，存储所有 extra 字段 |
| `character_chat_messages.reasoning_tokens` (Integer) | 思考链 token 数（已有列） |

**注**：无需 DB 迁移，`extra` 列已存在且为 Text 类型，可存储任意 JSON。

---

## 7. 测试覆盖

`backend/tests/test_reasoning_field_dual_write.py` 包含 3 个测试：
1. **streaming 完成后双写一致性**：断言 `extra.reasoning` 非空且与 content 中 `⋇...⋑` 内容一致
2. **历史消息读取 fallback**：构造仅有 content 内联（无 extra.reasoning）的消息，通过读取路径 fallback 解析
3. **IGNORE_SYMBOL 过滤**：构造 `extra.ignore=true` 的消息，断言它不出现在 prompt 中

---

## 8. 变更历史

- **2026-07-19**：初版创建，实现 reasoning 双写兼容方案 (Stage 2 of ST 核心模块对齐完整收尾)
- 关联 commit: `feat(st-parity): Phase 3 extra 字段补齐 (reasoning 双写 + tool_invocations + media + gen_id + IGNORE_SYMBOL)`
