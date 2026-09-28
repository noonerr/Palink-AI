"""B2-T3：多设备算力路由（设备登记 + 派单过滤 + 心跳续期 + 失败文案分级）。

SPEC §3。锁三件事：

1. **controller 不接单**：手机当遥控器时，认领请求只登记心跳、恒返回空，且绝不把
   任务置 dispatched —— 这就是「手机抢了任务却画不出来」的根因。
2. **[§9 R2] 45s 回收 < 120s 渲染**：处置选 ①「认领后每轮 poll 顺带心跳续期」。
   同一台设备重复认领 = 续期，不再下发一次；只有心跳真的停了（关页/断网）才会被
   别的设备接手。多机不是重复出图，也不是负载均衡，而是"谁先接谁画完"。
3. **失败文案分级**：`dispatched_at is None`（从没人认领过）要给「去开电脑」的
   指引，已认领未回传才是「本机服务没回传」。混成一句，用户不知道下一步干嘛。

设备心跳 TTL 只用于内存清扫，不参与在线判据 —— 浏览器后台节流是分钟级的，
拿 TTL 判在线会把"电脑开着但在后台"误报成离线（那恰是本特性的主场景）。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import asyncio  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app.services import local_image_bridge as bridge  # noqa: E402

DEVICE_A = "device-aaaa"
DEVICE_B = "device-bbbb"


@pytest.fixture(autouse=True)
def _isolated():
    bridge.reset_for_tests()
    yield
    bridge.reset_for_tests()


def _task(**kwargs: Any):
    params: dict[str, Any] = {
        "user_id": 1,
        "kind": "comfyui",
        "message_kind": "chat",
        "session_id": None,
        "message_id": None,
        "media_id": "m1",
        "prompt": "p",
        "base_url": "http://127.0.0.1:8188",
        "workflow": {},
        "seed": 1,
        "timeout_seconds": 120,
    }
    params.update(kwargs)
    return bridge.create_local_task(**params)


# ════════════════════════════════════════════════════════════════════
# 1. controller 不接单
# ════════════════════════════════════════════════════════════════════

def test_controller_claim_returns_empty_and_leaves_task_pending():
    task = _task()
    claimed = bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_CONTROLLER)
    assert claimed == []
    assert task.status == bridge.TASK_STATUS_PENDING
    assert task.dispatched_at is None  # 关键：没被任何人抢走


def test_controller_heartbeat_is_still_recorded():
    _task()
    bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_CONTROLLER)
    assert DEVICE_A in bridge.device_snapshot(1)
    assert bridge.device_snapshot(1)[DEVICE_A]["capability"] == bridge.DEVICE_CAPABILITY_CONTROLLER


def test_provider_claim_dispatches_task():
    task = _task()
    claimed = bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)
    assert len(claimed) == 1
    assert task.status == bridge.TASK_STATUS_DISPATCHED
    assert task.claimed_device_id == DEVICE_A


def test_legacy_client_without_device_id_still_works():
    """不传 device_id 的旧执行器保持改动前的行为（一台设备的语义）。"""
    task = _task()
    claimed = bridge.claim_pending_tasks(1)
    assert len(claimed) == 1 and task.status == bridge.TASK_STATUS_DISPATCHED


def test_unknown_capability_falls_back_to_provider():
    task = _task()
    assert len(bridge.claim_pending_tasks(1, DEVICE_A, "garbage")) == 1
    assert task.status == bridge.TASK_STATUS_DISPATCHED


# ════════════════════════════════════════════════════════════════════
# 2. [§9 R2] 心跳续期：渲染中不被别人抢
# ════════════════════════════════════════════════════════════════════

def test_same_device_renews_instead_of_duplicating():
    """R2 选项①：A 还在画，A 再来认领 = 续期，不会拿到同一张图的第二份。"""
    task = _task()
    first = bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)
    first_dispatched_at = task.dispatched_at

    # 把时间拨到刚过 45s 回收线：没有续期的话，B 就有资格抢了
    stale = first_dispatched_at - (bridge._CLAIM_TTL_SECONDS + 1)
    task.dispatched_at = stale
    second = bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)

    assert second == []  # 不再下发
    assert task.dispatched_at > stale  # 被续期到"现在"


def test_other_device_cannot_steal_while_renewing():
    task = _task()
    bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)
    # A 持续心跳（dispatched_at 一直是最新）
    stolen = bridge.claim_pending_tasks(1, DEVICE_B, bridge.DEVICE_CAPABILITY_PROVIDER)
    assert stolen == []


def test_other_device_can_reclaim_after_heartbeat_stops():
    task = _task()
    bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)
    task.dispatched_at = task.dispatched_at - (bridge._CLAIM_TTL_SECONDS + 1)  # A 死了
    reclaimed = bridge.claim_pending_tasks(1, DEVICE_B, bridge.DEVICE_CAPABILITY_PROVIDER)
    assert len(reclaimed) == 1
    assert task.claimed_device_id == DEVICE_B


def test_two_providers_race_first_wins():
    """两台算力设备同时在线：先到先得（不是"负载均衡"，也不重复出图）。"""
    task = _task()
    assert len(bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)) == 1
    assert bridge.claim_pending_tasks(1, DEVICE_B, bridge.DEVICE_CAPABILITY_PROVIDER) == []


# ════════════════════════════════════════════════════════════════════
# 3. 设备心跳表（内存卫生）
# ════════════════════════════════════════════════════════════════════

def test_device_heartbeat_is_swept_after_ttl():
    _task()
    bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)
    snapshot = bridge.device_snapshot(1)
    snapshot[DEVICE_A]["last_seen"] -= (bridge._DEVICE_HEARTBEAT_TTL_SECONDS + 1)
    bridge._sweep_devices()
    assert bridge.device_snapshot(1) == {}


def test_device_ttl_is_longer_than_browser_background_throttling():
    """后台标签页可能被浏览器钳到分钟级轮询；TTL 必须大于它，否则一直"离线"。"""
    assert bridge._DEVICE_HEARTBEAT_TTL_SECONDS > 60


def test_has_provider_device_reports_capability():
    _task()
    bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)
    bridge.claim_pending_tasks(1, DEVICE_B, bridge.DEVICE_CAPABILITY_CONTROLLER)
    assert bridge.has_provider_device(1) is True
    assert bridge.device_snapshot(1)[DEVICE_B]["capability"] == bridge.DEVICE_CAPABILITY_CONTROLLER


# ════════════════════════════════════════════════════════════════════
# 4. 失败文案分级（SPEC §3.2）
# ════════════════════════════════════════════════════════════════════

def _await_timeout(task) -> str:
    try:
        asyncio.run(bridge.await_local_task(task))
    except HTTPException as exc:
        return str(exc.detail)
    raise AssertionError("should have timed out")


def test_timeout_never_dispatched_tells_user_to_open_computer():
    task = _task(timeout_seconds=0)
    detail = _await_timeout(task)
    assert "没有在线的算力设备" in detail
    assert "打开 Palink" in detail


def test_timeout_after_dispatch_keeps_original_message():
    task = _task(timeout_seconds=0)
    bridge.claim_pending_tasks(1, DEVICE_A, bridge.DEVICE_CAPABILITY_PROVIDER)
    detail = _await_timeout(task)
    assert "未在时限内回传" in detail
    assert "没有在线的算力设备" not in detail
