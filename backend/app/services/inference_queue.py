import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class RequestPriority(IntEnum):
    LOW = 0
    NORMAL = 1
    HIGH = 2


@dataclass
class QueueRequest:
    request_id: str
    model_key: str
    priority: RequestPriority
    created_at: float = field(default_factory=time.monotonic)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    cancelled: bool = False
    user_id: Optional[int] = None
    _acquire_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _cancel_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    @property
    def wait_time(self) -> float:
        end = self.started_at or time.monotonic()
        return end - self.created_at

    @property
    def is_cancelled(self) -> bool:
        return self.cancelled or self._cancel_event.is_set()


class ModelQueue:
    def __init__(self, model_key: str, max_concurrent: int = 1) -> None:
        self.model_key = model_key
        self._max_concurrent = max_concurrent
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._queue: List[QueueRequest] = []
        self._active: Dict[str, QueueRequest] = {}
        self._avg_duration: float = 5.0
        self._duration_samples: List[float] = []
        self._max_samples = 20

    @property
    def max_concurrent(self) -> int:
        return self._max_concurrent

    @max_concurrent.setter
    def max_concurrent(self, value: int) -> None:
        value = max(1, min(value, 8))
        if value == self._max_concurrent:
            return
        self._max_concurrent = value
        self._semaphore = asyncio.Semaphore(value)
        logger.info("ModelQueue[%s] max_concurrent changed to %d", self.model_key, value)

    @property
    def queue_length(self) -> int:
        return len(self._queue)

    @property
    def active_count(self) -> int:
        return len(self._active)

    @property
    def avg_duration(self) -> float:
        return self._avg_duration

    def _update_avg_duration(self, duration: float) -> None:
        self._duration_samples.append(duration)
        if len(self._duration_samples) > self._max_samples:
            self._duration_samples = self._duration_samples[-self._max_samples:]
        if self._duration_samples:
            self._avg_duration = sum(self._duration_samples) / len(self._duration_samples)

    def _estimate_wait(self, position: int) -> float:
        if position <= 0:
            return 0.0
        slots = max(self._max_concurrent, 1)
        batches = (position + slots - 1) // slots
        return batches * self._avg_duration

    def _get_position(self, request_id: str) -> int:
        for i, req in enumerate(self._queue):
            if req.request_id == request_id:
                return i
        return -1

    def get_queue_status(self, request_id: str) -> Dict[str, Any]:
        position = self._get_position(request_id)
        if position >= 0:
            return {
                "status": "queued",
                "position": position,
                "queue_length": len(self._queue),
                "estimated_wait": self._estimate_wait(position),
            }
        if request_id in self._active:
            req = self._active[request_id]
            return {
                "status": "running",
                "position": 0,
                "elapsed": time.monotonic() - (req.started_at or req.created_at),
            }
        return {"status": "unknown", "position": -1}

    def get_status_summary(self) -> Dict[str, Any]:
        return {
            "model_key": self.model_key,
            "max_concurrent": self._max_concurrent,
            "active_count": len(self._active),
            "queue_length": len(self._queue),
            "avg_duration": round(self._avg_duration, 2),
            "active_requests": [
                {
                    "request_id": r.request_id,
                    "user_id": r.user_id,
                    "elapsed": round(time.monotonic() - (r.started_at or r.created_at), 1),
                }
                for r in self._active.values()
            ],
            "queued_requests": [
                {
                    "request_id": r.request_id,
                    "user_id": r.user_id,
                    "position": i,
                    "estimated_wait": round(self._estimate_wait(i), 1),
                }
                for i, r in enumerate(self._queue)
            ],
        }

    def cancel_request(self, request_id: str) -> bool:
        for i, req in enumerate(self._queue):
            if req.request_id == request_id:
                req.cancelled = True
                req._cancel_event.set()
                req._acquire_event.set()
                self._queue.pop(i)
                logger.info("Cancelled queued request %s for model %s", request_id, self.model_key)
                return True

        if request_id in self._active:
            req = self._active[request_id]
            req.cancelled = True
            req._cancel_event.set()
            logger.info("Cancellation signalled for active request %s on model %s", request_id, self.model_key)
            return True

        return False

    def submit_request(
        self,
        user_id: Optional[int] = None,
        priority: RequestPriority = RequestPriority.NORMAL,
    ) -> str:
        request_id = uuid.uuid4().hex[:12]
        req = QueueRequest(
            request_id=request_id,
            model_key=self.model_key,
            priority=priority,
            user_id=user_id,
        )
        self._queue.append(req)
        self._queue.sort(key=lambda r: (-r.priority, r.created_at))
        
        # 立即检查是否有可用槽位，如果有则唤醒队列中的第一个请求
        if self._semaphore.locked() is False and len(self._active) < self._max_concurrent:
            # 找到队列中第一个未被取消的请求
            for next_req in self._queue:
                if not next_req.is_cancelled:
                    next_req._acquire_event.set()
                    break
        
        return request_id

    def get_cancel_event(self, request_id: str) -> Optional[asyncio.Event]:
        for req in self._queue:
            if req.request_id == request_id:
                return req._cancel_event
        if request_id in self._active:
            return self._active[request_id]._cancel_event
        return None

    async def acquire_slot(self, request_id: str, timeout: float = 300.0) -> bool:
        req = None
        for r in self._queue:
            if r.request_id == request_id:
                req = r
                break

        if req is None:
            if request_id in self._active:
                return True
            return False

        try:
            await asyncio.wait_for(req._acquire_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return False

        if req.is_cancelled:
            return False

        await self._semaphore.acquire()

        if req.is_cancelled:
            self._semaphore.release()
            return False

        self._queue = [r for r in self._queue if r.request_id != request_id]
        req.started_at = time.monotonic()
        self._active[request_id] = req

        for next_req in self._queue:
            if not next_req.is_cancelled:
                next_req._acquire_event.set()
                break

        return True

    def release_slot(self, request_id: str) -> None:
        if request_id in self._active:
            req = self._active.pop(request_id)
            req.completed_at = time.monotonic()
            if req.started_at:
                duration = req.completed_at - req.started_at
                self._update_avg_duration(duration)
            self._semaphore.release()
            logger.info("Released slot for request %s on model %s", request_id, self.model_key)

            for next_req in self._queue:
                if not next_req.is_cancelled:
                    next_req._acquire_event.set()
                    break


class InferenceQueueManager:
    def __init__(self, max_queue_size: int = 100) -> None:
        self._model_queues: Dict[str, ModelQueue] = {}
        self._default_max_concurrent = 2
        self._max_queue_size = max_queue_size

    def get_model_queue(self, model_key: str, max_concurrent: Optional[int] = None) -> ModelQueue:
        if model_key not in self._model_queues:
            mc = max_concurrent if max_concurrent is not None else self._default_max_concurrent
            self._model_queues[model_key] = ModelQueue(model_key, max_concurrent=mc)
        elif max_concurrent is not None:
            self._model_queues[model_key].max_concurrent = max_concurrent
        return self._model_queues[model_key]

    def set_model_max_concurrent(self, model_key: str, max_concurrent: int) -> None:
        q = self.get_model_queue(model_key, max_concurrent)
        q.max_concurrent = max_concurrent

    def get_model_max_concurrent(self, model_key: str) -> int:
        if model_key in self._model_queues:
            return self._model_queues[model_key].max_concurrent
        return self._default_max_concurrent

    def submit_request(
        self,
        model_key: str,
        user_id: Optional[int] = None,
        priority: RequestPriority = RequestPriority.NORMAL,
        max_concurrent: Optional[int] = None,
    ) -> str:
        q = self.get_model_queue(model_key, max_concurrent)
        total_queued = sum(mq.queue_length for mq in self._model_queues.values())
        if total_queued >= self._max_queue_size:
            raise RuntimeError(f"Inference queue is full (max_queue_size={self._max_queue_size})")
        return q.submit_request(user_id=user_id, priority=priority)

    def get_queue_status(self, request_id: str) -> Dict[str, Any]:
        for q in self._model_queues.values():
            status = q.get_queue_status(request_id)
            if status.get("status") != "unknown":
                return status
        return {"status": "unknown", "position": -1}

    def cancel_request(self, request_id: str) -> bool:
        for q in self._model_queues.values():
            if q.cancel_request(request_id):
                return True
        return False

    def get_cancel_event(self, request_id: str) -> Optional[asyncio.Event]:
        for q in self._model_queues.values():
            ev = q.get_cancel_event(request_id)
            if ev is not None:
                return ev
        return None

    async def acquire_slot(self, request_id: str, model_key: str, timeout: float = 300.0) -> bool:
        q = self.get_model_queue(model_key)
        return await q.acquire_slot(request_id, timeout=timeout)

    def release_slot(self, request_id: str, model_key: str) -> None:
        q = self.get_model_queue(model_key)
        q.release_slot(request_id)

    def get_full_status(self) -> Dict[str, Any]:
        all_active = 0
        all_queued = 0
        model_statuses = {}
        for key, q in self._model_queues.items():
            s = q.get_status_summary()
            all_active += s["active_count"]
            all_queued += s["queue_length"]
            model_statuses[key] = s
        return {
            "total_active": all_active,
            "total_queued": all_queued,
            "models": model_statuses,
        }

    @property
    def queue_size(self) -> int:
        """返回当前所有模型队列中的排队总数"""
        return sum(mq.queue_length for mq in self._model_queues.values())

    async def submit_and_wait(
        self,
        model_id: str,
        func: Callable,
        *args: Any,
        max_retries: int = 3,
        retry_delay: float = 2.0,
        queue_timeout: float = 120.0,
        **kwargs: Any,
    ) -> Any:
        """
        提交推理请求并等待结果（带重试机制）

        类似 ModelQueueService 的 execute_with_queue_and_retry 接口。

        Args:
            model_id: 模型ID
            func: 要执行的异步函数
            *args: 函数位置参数
            max_retries: 最大重试次数
            retry_delay: 重试基础延迟（指数退避）
            queue_timeout: 排队超时时间
            **kwargs: 函数关键字参数

        Returns:
            函数执行结果

        Raises:
            最后一次重试的异常
        """
        last_exception: Optional[Exception] = None

        for attempt in range(max_retries):
            try:
                request_id = self.submit_request(
                    model_key=model_id,
                    priority=RequestPriority.NORMAL,
                )

                acquired = await self.acquire_slot(
                    request_id, model_id, timeout=queue_timeout
                )
                if not acquired:
                    raise RuntimeError(
                        f"Failed to acquire slot for model {model_id} after queue timeout"
                    )

                try:
                    result = await func(*args, **kwargs)
                    return result
                finally:
                    self.release_slot(request_id, model_id)

            except Exception as e:
                last_exception = e
                logger.warning(
                    "Model %s request failed (attempt %d/%d): %s",
                    model_id,
                    attempt + 1,
                    max_retries,
                    e,
                )

                if attempt < max_retries - 1:
                    delay = retry_delay * (2 ** attempt)
                    logger.info("Retrying in %.2fs...", delay)
                    await asyncio.sleep(delay)

        logger.error(
            "Model %s request failed after %d attempts", model_id, max_retries
        )
        raise last_exception


inference_queue = InferenceQueueManager()
