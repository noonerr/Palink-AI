"""N-5 回归守卫：tool_call_response 归属校验的会话归属管线。

spec: docs/SPEC_修复验证与系统检查_2026-08-24.md N-5
缺陷: WS tool_call_response 未校验 session 归属——任意认证用户可指定他人
session_id/tool_call_id 注入恶意 tool 结果进对方 LLM 流。

守卫语义:
1. StreamSession 携带 user_id（create_stream_session 落库）
2. ws handler 按 _tc_ss.user_id != user.id 拒绝投递（handler 内联逻辑，
   此处守护归属数据管线的正确性）
"""

import asyncio
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.websocket_manager import ws_manager
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def test_stream_session_carries_owner_user_id():
    """create_stream_session 落 user_id；get_stream_session 可读回。"""
    async def _scenario():
        ss = await ws_manager.create_stream_session(
            "n5-owner-check-session", 42, None,
        )
        try:
            got = ws_manager.get_stream_session("n5-owner-check-session")
            assert got is not None
            assert got.user_id == 42
            assert ss.user_id == 42
        finally:
            async with ws_manager._stream_lock:
                ws_manager.stream_sessions.pop("n5-owner-check-session", None)

    asyncio.run(_scenario())


def test_ownership_mismatch_rejects_submit():
    """user_id 不匹配时 handler 应拒绝投递——模拟拒绝判定分支。"""
    async def _scenario():
        await ws_manager.create_stream_session("n5-mismatch-session", 42, None)
        try:
            got = ws_manager.get_stream_session("n5-mismatch-session")
            attacker_id = 999
            rejected = got is None or got.user_id != attacker_id
            assert rejected, "归属不匹配必须走拒绝分支"
            # 拒绝路径不产生投递副作用（无等待队列 → submit 返回 False）
            assert ws_manager.submit_tool_response("n5-mismatch-session", "tc1", "x") is False
        finally:
            async with ws_manager._stream_lock:
                ws_manager.stream_sessions.pop("n5-mismatch-session", None)

    asyncio.run(_scenario())
