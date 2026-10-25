"""[p224 2026-10-25] 记忆排除窗对齐历史窗口（审计 L3 主修）。

背景：``_append_memory_context`` 的排除窗原先硬编码 ``.limit(5)``，而聊天历史
窗口是 ``_resolve_history_window_limit(req)``（单聊 24 / 群聊
``GroupChat.recent_messages_budget``）——第 6~23 楼处在「原文已逐字进历史、
记忆镜像却不被排除」的缝隙里被重复注入（p224 实测：M27/M26 在第 6/7 楼、
M20 在第 13 楼，全部落缝）。

本文件直接驱动 ``_append_memory_context``，捕获 ``MemoryService.get_context``
的 kwargs 断言 ``exclude_message_ids`` 的条数与内容：
- 单聊 = 最近 24 楼（不是 5）；
- 群聊 = recent_messages_budget；budget 未设置 → 回退全局 24；
- 窗外老楼不排除（其镜像须靠检索补回）。
"""

import asyncio
import os
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.memory_module import storage as mem_storage_mod  # noqa: E402
from app.memory_module.config import memory_config  # noqa: E402
from app.models.character import CharacterChatMessage, CharacterChatSession  # noqa: E402
from app.services import roleplay_prompt_assembly as rpa  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyRequest,
    _append_memory_context,
)

SESSION_ID = "p224-window-session"


@pytest.fixture()
def mem_env(db_session, monkeypatch):
    """记忆表初始化到当前测试引擎（复用 test_memory_exclude_recent 的接管模式）。"""
    monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
    monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
    monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
    monkeypatch.setattr(memory_config, "ENABLED", True)
    # 预建记忆表：st-vec 让步探测等前置查询不再走异常兜底
    mem_storage_mod.MemoryStorage(db_session)
    return db_session


def _insert_messages(db, count=30):
    """按时间递增插入 count 条消息，返回 {序号: id}（序号越大越新）。"""
    # 先建会话行（character_chat_messages.session_id 有 FK）
    db.add(CharacterChatSession(id=SESSION_ID))
    db.flush()
    base = datetime(2026, 10, 25, 12, 0, 0)
    ids = {}
    for i in range(1, count + 1):
        msg = CharacterChatMessage(
            session_id=SESSION_ID,
            branch_id=None,
            role="user" if i % 2 else "assistant",
            content=f"第{i}楼的消息内容。",
            created_at=base + timedelta(minutes=i),
        )
        db.add(msg)
        db.flush()
        ids[i] = msg.id
    return ids


def _run_capture_exclude(db, test_user, monkeypatch, group_budget="nostub"):
    """驱动 _append_memory_context，捕获传给 MemoryService.get_context 的排除集。

    group_budget="nostub" 不碰 _cached_request_group（走真实查询）；
    其余值（含 None）stub 成返回 recent_messages_budget=<该值> 的群对象。
    """
    captured = {}

    async def fake_get_context(self, **kwargs):
        captured.update(kwargs)
        return None

    monkeypatch.setattr(rpa.MemoryService, "get_context", fake_get_context)
    if group_budget != "nostub":
        monkeypatch.setattr(
            rpa,
            "_cached_request_group",
            lambda req, gid: SimpleNamespace(recent_messages_budget=group_budget),
        )

    req = PromptAssemblyRequest(
        db=db,
        user=test_user,
        char=None,
        session_id=SESSION_ID,
        branch_id=None,
        message="本轮用户输入",
        group_id="g1" if group_budget != "nostub" else None,
    )
    deps = SimpleNamespace(replace_placeholders=lambda text, *a, **k: text)
    asyncio.run(_append_memory_context(req, deps, "rule", [], [], token_budget=None))
    return captured


class TestExcludeWindowAlignsHistoryWindow:
    def test_single_chat_excludes_full_history_window(self, mem_env, test_user, monkeypatch):
        """★ 单聊：排除集 = 最近 24 楼（历史窗口口径），不再是硬编码 5 条。"""
        ids = _insert_messages(mem_env, count=30)
        captured = _run_capture_exclude(mem_env, test_user, monkeypatch)
        exclude = captured.get("exclude_message_ids") or []
        assert len(exclude) == 24, f"排除窗应等于历史窗口 24 条，实际 {len(exclude)}"
        latest_24 = {ids[i] for i in range(7, 31)}
        assert set(exclude) == latest_24
        # p224 缝隙带：旧 5 条口径下「原文已进历史却不被排除」的第 6~24 新楼
        gap_zone = {ids[i] for i in range(7, 26)}
        assert gap_zone <= set(exclude), "第 6~24 新楼（原缝隙带）未被排除"
        # 窗外老楼不排除（其镜像须靠检索补回）
        outside = {ids[i] for i in range(1, 7)}
        assert not (outside & set(exclude))

    def test_exclude_window_is_not_legacy_five(self, mem_env, test_user, monkeypatch):
        """回归方向锁：排除集条数必须大于旧硬编码 5（防回退）。"""
        _insert_messages(mem_env, count=30)
        captured = _run_capture_exclude(mem_env, test_user, monkeypatch)
        assert len(captured.get("exclude_message_ids") or []) > 5

    def test_group_chat_uses_recent_messages_budget(self, mem_env, test_user, monkeypatch):
        """群聊：排除窗取 GroupChat.recent_messages_budget（与历史窗口同源）。"""
        ids = _insert_messages(mem_env, count=30)
        captured = _run_capture_exclude(mem_env, test_user, monkeypatch, group_budget=10)
        exclude = captured.get("exclude_message_ids") or []
        assert len(exclude) == 10
        assert set(exclude) == {ids[i] for i in range(21, 31)}

    def test_group_budget_unset_falls_back_to_global(self, mem_env, test_user, monkeypatch):
        """群聊 budget 未设置（None）→ 回退全局 24（_resolve_history_window_limit 口径）。"""
        _insert_messages(mem_env, count=30)
        captured = _run_capture_exclude(mem_env, test_user, monkeypatch, group_budget=None)
        exclude = captured.get("exclude_message_ids") or []
        assert len(exclude) == 24
