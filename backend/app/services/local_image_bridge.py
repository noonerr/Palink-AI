"""文生图「浏览器桥接执行」的进程内任务桥。

服务端在远端（托管部署）够不到用户本机的 ComfyUI，出图改为：后端组好工作流
→ 创建任务 → 用户浏览器执行器轮询认领 → 浏览器 fetch 用户本机 ComfyUI → 结果
回传本模块 → 唤醒等待中的出图协程（`image_generation_service` 的既有成功/失败
收敛链原样复用）。

边界约定：
- **不持久化**：后端重启 = 任务与等待协程同亡，渲染层 120s pending 超时兜底
  （与云服务商模式下"后端重启悬挂占位"同级，见 SPEC 已知限制）。
- **不管媒体**：`extra.media` 的唯一属主是等待中的 `generate_image_for_message`
  协程，本模块只搬运字节与错误文案，绝不直接写库。
- **SSRF 语义分层**：本模块对 `base_url` 发起零请求（它只经浏览器之手），
  因此不受 `_is_safe_mcp_url` 内网守卫约束——那是后端出站面的守卫，两层
  语义不得"顺手统一"。
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import HTTPException

# 任务状态机：pending（待认领）→ dispatched（已下发给某个浏览器标签页）
# → completed / failed / expired。dispatched 超过 _CLAIM_TTL_SECONDS 未回传
# 视为标签页失联，回收为 pending 允许重新认领（刷新/关页场景）。
TASK_STATUS_PENDING = "pending"
TASK_STATUS_DISPATCHED = "dispatched"
TASK_STATUS_COMPLETED = "completed"
TASK_STATUS_FAILED = "failed"
TASK_STATUS_EXPIRED = "expired"

_CLAIM_TTL_SECONDS = 45.0
_MAX_ACTIVE_TASKS_PER_USER = 8
_SWEEP_INTERVAL_SECONDS = 60.0


@dataclass
class LocalImageTask:
    task_id: str
    user_id: int
    kind: str                     # "comfyui"（v1 唯一；sd_webui 浏览器执行二期照抄）
    message_kind: str             # "chat" | "character"，仅供前端定位，后端不消费
    session_id: Optional[str]
    message_id: Optional[int]
    media_id: str
    prompt: str
    base_url: str                 # 浏览器视角可达地址（如 http://127.0.0.1:8188）
    workflow: dict[str, Any]      # 完整 POST /prompt body，后端组装
    seed: int                     # 组装工作流时已定死的实际 seed
    timeout_seconds: int
    status: str = TASK_STATUS_PENDING
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.monotonic)
    dispatched_at: Optional[float] = None
    done: asyncio.Event = field(default_factory=asyncio.Event)


_tasks: dict[str, LocalImageTask] = {}
_sweeper_task: Optional[asyncio.Task] = None


def _get_sweeper() -> Optional[asyncio.Task]:
    """惰性启动清扫协程：把过时任务置 expired，防内存缓慢累积。

    无运行中事件循环时（测试同步调用桥函数）跳过——超时强约束由
    `await_local_task` 的 wait_for 保证，清扫只是内存卫生。
    """
    global _sweeper_task
    if _sweeper_task is not None and not _sweeper_task.done():
        return _sweeper_task
    try:
        _sweeper_task = asyncio.create_task(_sweep_loop())
    except RuntimeError:
        _sweeper_task = None
    return _sweeper_task


async def _sweep_loop() -> None:
    while True:
        await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)
        now = time.monotonic()
        for task in list(_tasks.values()):
            if task.status in (TASK_STATUS_PENDING, TASK_STATUS_DISPATCHED) and not task.done.is_set():
                if now - task.created_at > task.timeout_seconds + _CLAIM_TTL_SECONDS:
                    task.status = TASK_STATUS_EXPIRED
                    task.error = "本地出图任务超时未回传"
                    task.done.set()


def _drop_oldest_if_overflow(user_id: int) -> None:
    active = [
        t for t in _tasks.values()
        if t.user_id == user_id and t.status in (TASK_STATUS_PENDING, TASK_STATUS_DISPATCHED)
    ]
    if len(active) < _MAX_ACTIVE_TASKS_PER_USER:
        return
    active.sort(key=lambda t: t.created_at)
    for victim in active[: len(active) - _MAX_ACTIVE_TASKS_PER_USER + 1]:
        victim.status = TASK_STATUS_FAILED
        victim.error = "本地出图任务积压，最早的任务已被取消"
        victim.done.set()


def create_local_task(
    *,
    user_id: int,
    kind: str,
    message_kind: str,
    session_id: Optional[str],
    message_id: Optional[int],
    media_id: str,
    prompt: str,
    base_url: str,
    workflow: dict[str, Any],
    seed: int,
    timeout_seconds: int,
) -> LocalImageTask:
    _get_sweeper()
    _drop_oldest_if_overflow(user_id)
    task = LocalImageTask(
        task_id=f"lt_{uuid.uuid4().hex[:16]}",
        user_id=user_id,
        kind=kind,
        message_kind=message_kind,
        session_id=session_id,
        message_id=message_id,
        media_id=media_id,
        prompt=prompt,
        base_url=base_url.rstrip("/"),
        workflow=workflow,
        seed=seed,
        timeout_seconds=timeout_seconds,
    )
    _tasks[task.task_id] = task
    return task


def _get_task_for_user(task_id: str, user_id: int) -> Optional[LocalImageTask]:
    task = _tasks.get(task_id)
    # 归属不符按不存在处理（404），不泄露他人任务的存在性。
    if task is None or task.user_id != user_id:
        return None
    return task


def claim_pending_tasks(user_id: int) -> list[dict[str, Any]]:
    """认领该用户可执行的任务：pending、以及 dispatched 超过 TTL 未回传的（标签页失联回收）。"""
    now = time.monotonic()
    claimed: list[dict[str, Any]] = []
    for task in _tasks.values():
        if task.user_id != user_id or task.done.is_set():
            continue
        reclaimable = (
            task.status == TASK_STATUS_DISPATCHED
            and task.dispatched_at is not None
            and now - task.dispatched_at > _CLAIM_TTL_SECONDS
        )
        if task.status != TASK_STATUS_PENDING and not reclaimable:
            continue
        task.status = TASK_STATUS_DISPATCHED
        task.dispatched_at = now
        claimed.append(task_to_client_payload(task))
    claimed.sort(key=lambda item: item["created_at"])
    return claimed


def task_to_client_payload(task: LocalImageTask) -> dict[str, Any]:
    return {
        "task_id": task.task_id,
        "kind": task.kind,
        "message_kind": task.message_kind,
        "session_id": task.session_id,
        "message_id": task.message_id,
        "media_id": task.media_id,
        "prompt": task.prompt,
        "base_url": task.base_url,
        "workflow": task.workflow,
        "timeout_ms": int(task.timeout_seconds * 1000),
        "created_at": task.created_at,
    }


def _settle(task: LocalImageTask, *, result: Optional[dict[str, Any]], error: Optional[str], status: str) -> str:
    """幂等收敛：第一个到达的结果生效，后续回传（双标签竞速）无副作用。"""
    if task.done.is_set():
        return "already_done"
    task.result = result
    task.error = error
    task.status = status
    task.done.set()
    return "ok"


def complete_local_task(task_id: str, user_id: int, base64_images: list[str]) -> str:
    task = _get_task_for_user(task_id, user_id)
    if task is None:
        raise HTTPException(status_code=404, detail="本地出图任务不存在")
    return _settle(task, result={"base64": base64_images, "seed": task.seed}, error=None, status=TASK_STATUS_COMPLETED)


def fail_local_task(task_id: str, user_id: int, error: str) -> str:
    task = _get_task_for_user(task_id, user_id)
    if task is None:
        raise HTTPException(status_code=404, detail="本地出图任务不存在")
    return _settle(task, result=None, error=error, status=TASK_STATUS_FAILED)


async def await_local_task(task: LocalImageTask) -> dict[str, Any]:
    """等待浏览器回传。失败/超时抛 HTTPException，由调用方的既有 except 收敛 media。"""
    try:
        await asyncio.wait_for(task.done.wait(), timeout=float(task.timeout_seconds))
    except asyncio.TimeoutError as exc:
        if not task.done.is_set():
            task.status = TASK_STATUS_EXPIRED
            task.error = "本地出图任务超时未回传"
            task.done.set()
        raise HTTPException(status_code=504, detail="本机 ComfyUI 未在时限内回传结果") from exc
    if task.status == TASK_STATUS_EXPIRED:
        # 清扫器先行置 expired（如等待协程尚未到点）：语义仍是超时
        raise HTTPException(status_code=504, detail="本机 ComfyUI 未在时限内回传结果")
    if task.error:
        raise HTTPException(status_code=502, detail=f"本机 ComfyUI 执行失败: {task.error}")
    if not task.result or not task.result.get("base64"):
        raise HTTPException(status_code=502, detail="本机 ComfyUI 未返回图片数据")
    return task.result


def reset_for_tests() -> None:
    """测试隔离：清空任务表与清扫协程句柄（仅测试调用）。"""
    global _sweeper_task
    for task in _tasks.values():
        task.done.set()
    _tasks.clear()
    _sweeper_task = None
