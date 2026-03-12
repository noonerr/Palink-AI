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
        if