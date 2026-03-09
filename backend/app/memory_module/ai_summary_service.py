"""
AI 摘要记忆服务
使用轻量级 AI 模型生成对话摘要
"""

import asyncio
import logging
from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from openai import AsyncOpenAI

from .storage import MemoryStorage
from .models import MemoryEntry

logger = logging.getLogger("AISummaryMemory")


class AISummaryMemoryService:
    """
    AI 摘要记忆服务
    
    特点：
    1. 使用轻量级模型（如 GPT-3.5, DeepSeek-chat）生成摘要
    2. 异步处理，不阻塞主请求
    3. 智能提取关键信息和用户偏好
    """
    
    def __init__(self, db_session: Session, api_key: str, base_url: str, model: str):
        self.db = db_session
        self.storage = MemoryStorage(db_session)
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self.model = model
    
    async def generate_summary(self, user_id: int, session_id: str) -> Optional[str]:
        """
        生成对话摘要
        
        耗时: 500ms - 2s (异步，不阻塞主流程)
        """
        try:
            # 获取最近10条消息
            messages = await asyncio.to_thread(
                self.storage.get_recent,
                user_id=user_id,
                session_id=session_id,
                limit=10
            )
            
            if len(messages) < 3:
                return None  # 消息太少，不生成摘要
            
            # 构建对话文本
            conversation_text = "\n".join([
                f"{'用户' if m.role == 'user' else 'AI'}: {m.content[:200]}"
                for m in messages
            ])
            
            # 调用 AI 生成摘要
            prompt = f"""请总结以下对话的关键信息，提取：
1. 用户的主要关注点/话题
2. 用户的明确偏好（如"我喜欢Python"）
3. 任何重要的上下文信息

请用2-3句话简洁总结：

{conversation_text}
"""
            
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=150
            )
            
            summary = response.choices[0].message.content.strip()
            logger.debug(f"生成摘要: {summary[:100]}...")
            
            return summary
            
        except Exception as e:
            logger.error(f"生成摘要失败: {e}")
            return None
    
    async def extract_key_facts(self, user_id: int, user_msg: str, assistant_msg: str) -> List[str]:
        """
        从单条对话中提取关键事实
        
        耗时: 300ms - 1s (异步)
        """
        try:
            prompt = f"""从以下对话中提取用户的关键信息（如偏好、身份、需求）。
只提取明确的事实，不要推测。
如果没有明确信息，返回"无"。

用户: {user_msg[:300]}
AI: {assistant_msg[:200]}

提取的关键信息（每行一条）："""
            
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=100
            )
            
            content = response.choices[0].message.content.strip()
            
            # 解析结果
            facts = []
            for line in content.split('\n'):
                line = line.strip()
                if line and line != '无' and not line.startswith('提取'):
                    # 去除序号标记
                    if line[0].isdigit() and line[1] == '.':
                        line = line[2:].strip()
                    facts.append(line[:100])  # 限制长度
            
            return facts[:3]  # 最多3条
            
        except Exception as e:
            logger.error(f"提取关键事实失败: {e}")
            return []
    
    async def get_context_with_summary(self, user_id: int, session_id: str, 
                                        current_query: str) -> dict:
        """
        获取包含 AI 摘要的上下文
        
        返回: {
            "summary": "对话摘要",
            "key_facts": ["事实1", "事实2"],
            "latency_ms": 500
        }
        """
        start_time = datetime.utcnow()
        
        result = {
            "summary": "",
            "key_facts": [],
            "latency_ms": 0
        }
        
        try:
            # 生成摘要（如果缓存中没有）
            summary = await self.generate_summary(user_id, session_id)
            if summary:
                result["summary"] = summary
            
            # 计算延迟
            result["latency_ms"] = (datetime.utcnow() - start_time).total_seconds() * 1000
            
        except Exception as e:
            logger.error(f"获取 AI 摘要上下文失败: {e}")
        
        return result


# 便捷函数
async def generate_ai_summary_background(db: Session, user_id: int, session_id: str,
                                          api_key: str, base_url: str, model: str):
    """后台生成 AI 摘要"""
    service = AISummaryMemoryService(db, api_key, base_url, model)
    summary = await service.generate_summary(user_id, session_id)
    
    if summary:
        # 存储摘要到内存缓存（这里简化处理，实际可以存到数据库）
        from .optimized_service import OptimizedMemoryService
        cache_key = f"ai_summary:{user_id}:{session_id}"
        OptimizedMemoryService._set_cache(cache_key, summary, ttl=600)  # 10分钟缓存
        
    return summary
