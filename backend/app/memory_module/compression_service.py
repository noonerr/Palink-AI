"""
记忆压缩服务
提供自动和手动记忆压缩功能
"""

import asyncio
import logging
from typing import List, Dict, Optional, Tuple
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import text

from .storage import MemoryStorage
from .models import MemoryEntry

logger = logging.getLogger("MemoryCompression")


class MemoryCompressionService:
    """
    记忆压缩服务
    
    功能：
    1. 自动检测记忆长度并触发压缩
    2. 手动触发记忆压缩
    3. 智能选择保留的记忆内容
    """
    
    # 默认阈值配置
    DEFAULT_THRESHOLDS = {
        "message_count": 50,      # 消息数量阈值
        "token_count": 8000,      # Token数量阈值
        "time_range_hours": 24,   # 时间范围阈值（小时）
    }
    
    def __init__(self, db_session: Session):
        self.db = db_session
        self.storage = MemoryStorage(db_session)
    
    def check_compression_needed(self, user_id: int, session_id: str) -> Dict:
        """
        检查是否需要压缩记忆
        
        返回: {
            "needed": bool,
            "reason": str,
            "stats": {
                "message_count": int,
                "token_count": int,
                "oldest_message_hours": float
            }
        }
        """
        try:
            # 获取当前会话的统计信息
            stats = self._get_session_stats(user_id, session_id)
            
            reasons = []
            
            # 检查消息数量
            if stats["message_count"] > self.DEFAULT_THRESHOLDS["message_count"]:
                reasons.append(f"消息数量({stats['message_count']})超过阈值({self.DEFAULT_THRESHOLDS['message_count']})")
            
            # 检查Token数量
            if stats["token_count"] > self.DEFAULT_THRESHOLDS["token_count"]:
                reasons.append(f"Token数量({stats['token_count']})超过阈值({self.DEFAULT_THRESHOLDS['token_count']})")
            
            # 检查时间范围
            if stats["oldest_message_hours"] > self.DEFAULT_THRESHOLDS["time_range_hours"]:
                reasons.append(f"对话时长({stats['oldest_message_hours']:.1f}小时)超过阈值({self.DEFAULT_THRESHOLDS['time_range_hours']}小时)")
            
            return {
                "needed": len(reasons) > 0,
                "reason": "; ".join(reasons) if reasons else "",
                "stats": stats
            }
            
        except Exception as e:
            logger.error(f"检查压缩需求失败: {e}")
            return {"needed": False, "reason": f"检查失败: {e}", "stats": {}}
    
    def _get_session_stats(self, user_id: int, session_id: str) -> Dict:
        """获取会话统计信息"""
        try:
            # 查询消息数量
            count_sql = text("""
                SELECT COUNT(*) as count, 
                       SUM(LENGTH(content) / 4) as estimated_tokens,
                       MIN(created_at) as oldest_message
                FROM conversation_memories
                WHERE user_id = :user_id AND session_id = :session_id
            """)
            result = self.db.execute(count_sql, {
                "user_id": user_id,
                "session_id": session_id
            }).fetchone()
            
            message_count = result.count or 0
            token_count = int(result.estimated_tokens or 0)
            
            # 计算最旧消息的时间
            oldest_hours = 0
            if result.oldest_message:
                oldest_hours = (datetime.utcnow() - result.oldest_message).total_seconds() / 3600
            
            return {
                "message_count": message_count,
                "token_count": token_count,
                "oldest_message_hours": oldest_hours
            }
            
        except Exception as e:
            logger.error(f"获取会话统计失败: {e}")
            return {
                "message_count": 0,
                "token_count": 0,
                "oldest_message_hours": 0
            }
    
    async def compress_memory(self, user_id: int, session_id: str, 
                              compression_ratio: float = 0.5) -> Dict:
        """
        压缩记忆
        
        参数:
            compression_ratio: 压缩比例（保留多少比例的记忆），默认0.5保留50%
        
        返回: {
            "success": bool,
            "compressed_count": int,
            "remaining_count": int,
            "summary": str
        }
        """
        try:
            # 获取所有记忆
            all_memories = await asyncio.to_thread(
                self.storage.get_recent,
                user_id=user_id,
                session_id=session_id,
                limit=1000  # 获取大量记忆
            )
            
            if len(all_memories) < 10:
                return {
                    "success": False,
                    "message": "记忆数量太少，无需压缩",
                    "compressed_count": 0,
                    "remaining_count": len(all_memories)
                }
            
            # 智能选择要保留的记忆
            keep_count = max(int(len(all_memories) * compression_ratio), 10)
            memories_to_keep = self._select_memories_to_keep(all_memories, keep_count)
            
            # 删除不需要的记忆
            memories_to_delete = [m for m in all_memories if m.id not in 
                                 [keep.id for keep in memories_to_keep]]
            
            deleted_count = 0
            for memory in memories_to_delete:
                try:
                    delete_sql = text("""
                        DELETE FROM conversation_memories
                        WHERE id = :id
                    """)
                    self.db.execute(delete_sql, {"id": memory.id})
                    deleted_count += 1
                except Exception as e:
                    logger.error(f"删除记忆失败 {memory.id}: {e}")
            
            self.db.commit()
            
            # 生成压缩摘要
            summary = self._generate_compression_summary(all_memories, memories_to_keep)
            
            logger.info(f"记忆压缩完成: 删除{deleted_count}条，保留{len(memories_to_keep)}条")
            
            return {
                "success": True,
                "compressed_count": deleted_count,
                "remaining_count": len(memories_to_keep),
                "summary": summary
            }
            
        except Exception as e:
            logger.error(f"压缩记忆失败: {e}")
            self.db.rollback()
            return {
                "success": False,
                "message": f"压缩失败: {e}",
                "compressed_count": 0,
                "remaining_count": 0
            }
    
    def _select_memories_to_keep(self, memories: List[MemoryEntry], keep_count: int) -> List[MemoryEntry]:
        """
        智能选择要保留的记忆
        
        策略：
        1. 保留最近的消息（30%）
        2. 保留重要的消息（包含关键信息的）（40%）
        3. 保留有代表性的消息（30%）
        """
        if len(memories) <= keep_count:
            return memories
        
        # 按时间排序（最新的在前）
        sorted_memories = sorted(memories, key=lambda x: x.created_at or datetime.min, reverse=True)
        
        # 1. 保留最近的消息
        recent_count = int(keep_count * 0.3)
        recent_memories = sorted_memories[:recent_count]
        
        # 2. 从剩余消息中选择重要的
        remaining = sorted_memories[recent_count:]
        important_memories = self._select_important_memories(remaining, int(keep_count * 0.4))
        
        # 3. 从剩余消息中选择有代表性的
        remaining_after_important = [m for m in remaining if m not in important_memories]
        representative_count = keep_count - len(recent_memories) - len(important_memories)
        representative_memories = self._select_representative_memories(
            remaining_after_important, representative_count
        )
        
        return recent_memories + important_memories + representative_memories
    
    def _select_important_memories(self, memories: List[MemoryEntry], count: int) -> List[MemoryEntry]:
        """选择重要的记忆（包含关键信息）"""
        important_keywords = [
            "喜欢", "爱", "讨厌", "不喜欢", "想要", "需要",
            "目标", "计划", "重要", "关键", "必须",
            "I like", "I love", "I hate", "I want", "I need",
            "goal", "plan", "important", "key", "must"
        ]
        
        # 计算每条记忆的重要性分数
        scored_memories = []
        for memory in memories:
            score = 0
            content_lower = memory.content.lower()
            for keyword in important_keywords:
                if keyword.lower() in content_lower:
                    score += 1
            # 用户消息更重要
            if memory.role == "user":
                score += 0.5
            scored_memories.append((memory, score))
        
        # 按分数排序，选择高分记忆
        scored_memories.sort(key=lambda x: x[1], reverse=True)
        return [m for m, _ in scored_memories[:count]]
    
    def _select_representative_memories(self, memories: List[MemoryEntry], count: int) -> List[MemoryEntry]:
        """选择有代表性的记忆（均匀分布）"""
        if len(memories) <= count:
            return memories
        
        # 按时间均匀选择
        step = len(memories) / count
        selected = []
        for i in range(count):
            index = int(i * step)
            selected.append(memories[index])
        
        return selected
    
    def _generate_compression_summary(self, all_memories: List[MemoryEntry], 
                                     kept_memories: List[MemoryEntry]) -> str:
        """生成压缩摘要"""
        total = len(all_memories)
        kept = len(kept_memories)
        ratio = (kept / total * 100) if total > 0 else 0
        
        # 提取关键主题
        topics = self._extract_topics(kept_memories)
        
        return f"记忆已压缩: 从{total}条保留到{kept}条({ratio:.1f}%)。主要话题: {', '.join(topics[:3])}"
    
    def _extract_topics(self, memories: List[MemoryEntry]) -> List[str]:
        """从记忆中提取话题"""
        # 简单的关键词提取
        topic_keywords = {
            "python": "Python编程",
            "javascript": "JavaScript",
            "代码": "编程",
            "code": "Programming",
            "学习": "学习",
            "learn": "Learning",
            "工作": "工作",
            "work": "Work",
            "项目": "项目",
            "project": "Project"
        }
        
        topics_found = []
        for memory in memories:
            content_lower = memory.content.lower()
            for keyword, topic in topic_keywords.items():
                if keyword in content_lower and topic not in topics_found:
                    topics_found.append(topic)
        
        return topics_found if topics_found else ["一般对话"]


# 便捷函数
async def check_and_auto_compress(db: Session, user_id: int, session_id: str) -> Optional[Dict]:
    """
    检查并自动压缩记忆
    
    如果记忆超过阈值，自动触发压缩
    """
    service = MemoryCompressionService(db)
    
    # 检查是否需要压缩
    check_result = service.check_compression_needed(user_id, session_id)
    
    if check_result["needed"]:
        logger.info(f"自动触发记忆压缩: {check_result['reason']}")
        # 执行压缩
        compression_result = await service.compress_memory(user_id, session_id)
        return {
            "auto_compressed": True,
            "check": check_result,
            "compression": compression_result
        }
    
    return None


def get_memory_stats(db: Session, user_id: int, session_id: str) -> Dict:
    """获取记忆统计信息（用于UI显示）"""
    service = MemoryCompressionService(db)
    stats = service._get_session_stats(user_id, session_id)
    check = service.check_compression_needed(user_id, session_id)
    
    return {
        **stats,
        "compression_needed": check["needed"],
        "compression_reason": check["reason"]
    }
