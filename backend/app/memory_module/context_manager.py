"""
智能上下文管理器 - Token 预算分配和滑动窗口

核心功能：
1. 智能分配 Token 预算
2. 滑动窗口管理近期消息
3. 优先级消息保留
4. 自动摘要旧消息
"""

import logging
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
from datetime import datetime

logger = logging.getLogger("ContextManager")


class MessagePriority(Enum):
    """消息优先级"""
    CRITICAL = 0    # 绝对不能丢（如设定、关键信息）
    HIGH = 1        # 重要信息
    MEDIUM = 2      # 普通信息
    LOW = 3         # 可以优先压缩


@dataclass
class TokenBudget:
    """Token 预算配置"""
    total: int = 8192
    
    # 各部分预算（比例）
    system_prompt_ratio: float = 0.12    # ~1000
    world_book_ratio: float = 0.12       # ~1000
    plot_line_ratio: float = 0.025        # ~200
    short_term_ratio: float = 0.37        # ~3000
    medium_term_ratio: float = 0.18       # ~1500
    long_term_ratio: float = 0.06          # ~500
    reserve_ratio: float = 0.125            # ~1000 留给生成
    
    @property
    def system_prompt_tokens(self) -> int:
        return int(self.total * self.system_prompt_ratio)
    
    @property
    def world_book_tokens(self) -> int:
        return int(self.total * self.world_book_ratio)
    
    @property
    def plot_line_tokens(self) -> int:
        return int(self.total * self.plot_line_ratio)
    
    @property
    def short_term_tokens(self) -> int:
        return int(self.total * self.short_term_ratio)
    
    @property
    def medium_term_tokens(self) -> int:
        return int(self.total * self.medium_term_ratio)
    
    @property
    def long_term_tokens(self) -> int:
        return int(self.total * self.long_term_ratio)
    
    @property
    def reserve_tokens(self) -> int:
        return int(self.total * self.reserve_ratio)


@dataclass
class ContextMessage:
    """上下文消息"""
    id: int
    role: str  # 'user' | 'assistant'
    content: str
    priority: MessagePriority
    created_at: datetime
    token_count: int
    is_summarized: bool = False
    original_id: Optional[int] = None  # 如果是摘要，指向原消息


class SmartContextManager:
    """智能上下文管理器"""
    
    def __init__(self, budget: Optional[TokenBudget] = None):
        self.budget = budget or TokenBudget()
        self.messages: List[ContextMessage] = []
        self.summaries: Dict[int, str] = {}  # 消息ID -> 摘要
        
    def add_message(
        self,
        message_id: int,
        role: str,
        content: str,
        priority: Optional[MessagePriority] = None,
        created_at: Optional[datetime] = None
    ) -> ContextMessage:
        """添加消息到上下文"""
        if priority is None:
            priority = self._infer_priority(role, content)
        
        if created_at is None:
            created_at = datetime.utcnow()
        
        token_count = self._estimate_tokens(content)
        
        msg = ContextMessage(
            id=message_id,
            role=role,
            content=content,
            priority=priority,
            created_at=created_at,
            token_count=token_count
        )
        
        self.messages.append(msg)
        self.messages.sort(key=lambda x: x.created_at)
        
        return msg
    
    def build_context(
        self,
        system_prompt: str,
        world_book_entries: List[Dict],
        plot_line_context: str,
        long_term_memories: List[Dict]
    ) -> Tuple[List[Dict], int, Dict]:
        """
        构建优化后的上下文
        
        返回:
        (messages_list, total_tokens, stats)
        """
        context_parts = []
        stats = {
            "system_prompt_tokens": 0,
            "world_book_tokens": 0,
            "plot_line_tokens": 0,
            "short_term_tokens": 0,
            "medium_term_tokens": 0,
            "long_term_tokens": 0,
            "total_tokens": 0,
            "messages_included": 0,
            "messages_summarized": 0
        }
        
        # 1. 添加系统提示词
        sys_tokens = self._estimate_tokens(system_prompt)
        if sys_tokens <= self.budget.system_prompt_tokens:
            context_parts.append({"role": "system", "content": system_prompt})
            stats["system_prompt_tokens"] = sys_tokens
        else:
            # 截断系统提示词
            truncated = self._truncate_to_tokens(system_prompt, self.budget.system_prompt_tokens)
            context_parts.append({"role": "system", "content": truncated})
            stats["system_prompt_tokens"] = self.budget.system_prompt_tokens
        
        # 2. 添加世界书（智能裁剪）
        wb_context = self._build_world_book_context(world_book_entries, stats)
        if wb_context:
            context_parts.append({"role": "system", "content": f"【世界信息】\n{wb_context}"})
        
        # 3. 添加剧情线
        if plot_line_context:
            pl_tokens = self._estimate_tokens(plot_line_context)
            if pl_tokens <= self.budget.plot_line_tokens:
                context_parts.append({"role": "system", "content": f"【剧情阶段】\n{plot_line_context}"})
                stats["plot_line_tokens"] = pl_tokens
        
        # 4. 添加长期记忆（向量检索结果）
        lt_context = self._build_long_term_context(long_term_memories, stats)
        if lt_context:
            context_parts.append({"role": "system", "content": f"【相关记忆】\n{lt_context}"})
        
        # 5. 添加对话历史（滑动窗口 + 优先级）
        history_messages, history_stats = self._select_history_messages()
        context_parts.extend(history_messages)
        stats.update(history_stats)
        
        # 计算总 token
        total_tokens = sum(stats[k] for k in stats if k.endswith("_tokens"))
        stats["total_tokens"] = total_tokens
        stats["messages_included"] = len(history_messages)
        
        return context_parts, total_tokens, stats
    
    def _build_world_book_context(self, entries: List[Dict], stats: Dict) -> str:
        """构建世界书上下文（智能裁剪）"""
        if not entries:
            return ""

        budget = self.budget.world_book_tokens
        used_tokens = 0
        selected_parts: List[str] = []

        # 优先保留高优先级词条，避免挤占全部预算
        sorted_entries = sorted(entries, key=lambda x: int(x.get("priority", 0)), reverse=True)

        for entry in sorted_entries:
            title = str(entry.get("title") or entry.get("name") or "未命名词条").strip()
            body = str(entry.get("content") or entry.get("text") or entry.get("raw_content") or "").strip()
            if not body:
                continue

            chunk = f"[{title}]\n{body}"
            chunk_tokens = self._estimate_tokens(chunk)

            if used_tokens + chunk_tokens <= budget:
                selected_parts.append(chunk)
                used_tokens += chunk_tokens
                continue

            remaining = budget - used_tokens
            if remaining <= 0:
                break

            truncated = self._truncate_to_tokens(chunk, remaining)
            if truncated:
                selected_parts.append(truncated)
                used_tokens = budget
            break

        stats["world_book_tokens"] = used_tokens
        return "\n\n".join(selected_parts)

    def _build_long_term_context(self, memories: List[Dict], stats: Dict) -> str:
        """构建长期记忆上下文（预算受限）"""
        if not memories:
            return ""

        budget = self.budget.long_term_tokens
        used_tokens = 0
        selected_parts: List[str] = []

        for idx, memory in enumerate(memories, start=1):
            text = str(memory.get("content") or memory.get("summary") or memory.get("text") or "").strip()
            if not text:
                continue

            chunk = f"{idx}. {text}"
            chunk_tokens = self._estimate_tokens(chunk)

            if used_tokens + chunk_tokens <= budget:
                selected_parts.append(chunk)
                used_tokens += chunk_tokens
                continue

            remaining = budget - used_tokens
            if remaining <= 0:
                break

            truncated = self._truncate_to_tokens(chunk, remaining)
            if truncated:
                selected_parts.append(truncated)
                used_tokens = budget
            break

        stats["long_term_tokens"] = used_tokens
        return "\n".join(selected_parts)

    def _select_history_messages(self) -> Tuple[List[Dict], Dict]:
        """按预算选取历史消息：近期优先，其次补充高优先级旧消息。"""
        if not self.messages:
            return [], {
                "short_term_tokens": 0,
                "medium_term_tokens": 0,
                "messages_summarized": 0,
            }

        selected: List[ContextMessage] = []
        selected_ids = set()
        short_used = 0
        medium_used = 0

        # 先按时间倒序保留近期消息
        for msg in reversed(self.messages):
            if short_used + msg.token_count > self.budget.short_term_tokens:
                break
            selected.append(msg)
            selected_ids.add(msg.id)
            short_used += msg.token_count

        # 再从较旧消息补充高优先级内容
        for msg in sorted(self.messages, key=lambda m: m.created_at):
            if msg.id in selected_ids:
                continue
            if msg.priority not in (MessagePriority.CRITICAL, MessagePriority.HIGH):
                continue
            if medium_used + msg.token_count > self.budget.medium_term_tokens:
                continue
            selected.append(msg)
            selected_ids.add(msg.id)
            medium_used += msg.token_count

        selected.sort(key=lambda m: m.created_at)
        payload = [{"role": m.role, "content": m.content} for m in selected]

        return payload, {
            "short_term_tokens": short_used,
            "medium_term_tokens": medium_used,
            "messages_summarized": 0,
        }

    def _infer_priority(self, role: str, content: str) -> MessagePriority:
        """根据角色和关键词做轻量优先级推断。"""
        text = (content or "").lower()

        if role == "system":
            return MessagePriority.CRITICAL

        critical_keywords = ["设定", "规则", "必须", "重要", "禁止", "worldbook", "plot"]
        if any(k in text for k in critical_keywords):
            return MessagePriority.HIGH

        if len(text) < 40:
            return MessagePriority.LOW

        return MessagePriority.MEDIUM

    def _estimate_tokens(self, text: str) -> int:
        """粗略 token 估算：中英文混合场景按约 4 字符/Token。"""
        if not text:
            return 0
        return max(1, len(text) // 4)

    def _truncate_to_tokens(self, text: str, max_tokens: int) -> str:
        """按估算 token 截断文本。"""
        if max_tokens <= 0:
            return ""

        char_limit = max_tokens * 4
        if len(text) <= char_limit:
            return text

        if char_limit <= 3:
            return text[:char_limit]

        return text[: char_limit - 3] + "..."

