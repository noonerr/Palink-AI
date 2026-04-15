import asyncio
import logging
from typing import Any, Dict, Optional, Callable
from collections import defaultdict

logger = logging.getLogger(__name__)


class ModelQueueService:
    """
    模型排队服务，用于处理模型繁忙时的请求排队和重试
    """
    
    _instance: Optional['ModelQueueService'] = None
    _initialized: bool = False
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self):
        if ModelQueueService._initialized:
            return
        ModelQueueService._initialized = True
        
        self.queues: Dict[str, asyncio.Queue] = defaultdict(asyncio.Queue)
        self.active_requests: Dict[str, int] = defaultdict(int)
        self.max_concurrent_per_model: int = 1
        self.max_retries: int = 3
        self.retry_delay: float = 2.0
        self.queue_timeout: float = 60.0
    
    async def acquire(self, model_id: str) -> bool:
        """
        获取模型使用权，如果模型繁忙则等待
        """
        queue = self.queues[model_id]
        event = asyncio.Event()
        
        await queue.put(event)
        
        try:
            await asyncio.wait_for(event.wait(), timeout=self.queue_timeout)
            self.active_requests[model_id] += 1
            return True
        except asyncio.TimeoutError:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            logger.warning(f"Model {model_id} queue timeout after {self.queue_timeout}s")
            return False
    
    def release(self, model_id: str):
        """
        释放模型使用权
        """
        if self.active_requests[model_id] > 0:
            self.active_requests[model_id] -= 1
        
        queue = self.queues[model_id]
        if not queue.empty():
            try:
                event = queue.get_nowait()
                event.set()
            except asyncio.QueueEmpty:
                pass
    
    async def execute_with_queue_and_retry(
        self,
        model_id: str,
        func: Callable,
        *args,
        **kwargs
    ) -> Any:
        """
        使用排队和重试机制执行函数
        
        Args:
            model_id: 模型ID
            func: 要执行的异步函数
            *args: 函数参数
            **kwargs: 函数关键字参数
            
        Returns:
            函数执行结果
            
        Raises:
            最后一次重试的异常
        """
        last_exception = None
        
        for attempt in range(self.max_retries):
            try:
                acquired = await self.acquire(model_id)
                if not acquired:
                    raise RuntimeError(f"Failed to acquire model {model_id} after queue timeout")
                
                try:
                    result = await func(*args, **kwargs)
                    return result
                finally:
                    self.release(model_id)
                    
            except Exception as e:
                last_exception = e
                logger.warning(f"Model {model_id} request failed (attempt {attempt + 1}/{self.max_retries}): {e}")
                
                if attempt < self.max_retries - 1:
                    delay = self.retry_delay * (2 ** attempt)
                    logger.info(f"Retrying in {delay:.2f}s...")
                    await asyncio.sleep(delay)
        
        logger.error(f"Model {model_id} request failed after {self.max_retries} attempts")
        raise last_exception


def get_model_queue_service() -> ModelQueueService:
    """获取模型排队服务单例"""
    return ModelQueueService()
