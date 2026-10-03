"""[XCHAR-PROMPT-BLEED 2026-10-03] 跨角色提示词串味修复 —— filter 的来源分流回归。

用户报告：在角色 A 的卡上生成时，提示词里混进了角色 B 的内容。

根因（两条，本文件只锁后端这一条）：
  extension_prompts 的 filter 为空时，旧语义是「全局放行」（不限制）。而插件
  注册的提示词走的是 session_id IS NULL 的全局行（api/extension_prompts.py:83），
  两张卡共用一个池子，合并点 merged[row.identifier] 后写顶掉先写 —— 角色 B
  注册的空 filter 规范就跟着进了角色 A 的提示词。

修复口径：按 ExtensionPrompt.source_key 的既有语义一分为二（不新增字段）。
  - source_key 非 NULL = 插件/卡脚本运行时上报的快照行 → 空 filter **拒绝**
    （注册却没绑卡 = 配置错误，让它暴露，不静默放行）；
  - source_key 为 NULL = 用户手写/历史行 → 「空 filter = 全局」**逐字节不变**。
  - 请求侧条目（前端运行时现场注册）无 source_key → 按插件来源处理，并在过滤
    阶段按当前角色重新绑定 character_ids。

存量行全为 NULL，故本修复对存量数据零回归 —— 这一点由 test_manual_* 用例锁住。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

from app.models import Character  # noqa: E402
from app.models.extension_prompt import ExtensionPrompt  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyRequest,
    _collect_extension_prompts,
    _ext_filter_allows,
)


# ───────────────────────────────────────────────────────────────
# 纯函数层：_ext_filter_allows 的来源分流
# ───────────────────────────────────────────────────────────────
class TestExtFilterAllowsSourceKey:
    def test_manual_null_source_key_empty_filter_is_global(self):
        """用户手写行（source_key=NULL）：空 filter 仍放行 —— 零回归红线。"""
        assert _ext_filter_allows({}, "card-a", "sess-1", None) is True
        assert _ext_filter_allows({"session_ids": []}, "card-a", "sess-1", None) is True

    def test_plugin_source_key_empty_filter_is_rejected(self):
        """插件来源且未绑卡 → 拒绝，不静默放行到所有卡。"""
        assert _ext_filter_allows({}, "card-a", "sess-1", "fnv1a-abc") is False
        assert _ext_filter_allows({"character_ids": []}, "card-a", "sess-1", "fnv1a-abc") is False

    def test_plugin_source_key_bound_card_allows(self):
        assert _ext_filter_allows(
            {"character_ids": ["card-a"]}, "card-a", "sess-1", "fnv1a-abc"
        ) is True

    def test_plugin_source_key_other_card_rejected(self):
        """本次串味的核心断言：B 的规范不得进 A 的提示词。"""
        assert _ext_filter_allows(
            {"character_ids": ["card-b"]}, "card-a", "sess-1", "fnv1a-abc"
        ) is False

    def test_session_gate_still_applies_to_plugin_source(self):
        assert _ext_filter_allows(
            {"character_ids": ["card-a"], "session_ids": ["sess-9"]}, "card-a", "sess-1", "fnv1a-abc"
        ) is False

    def test_manual_row_character_gate_unchanged(self):
        assert _ext_filter_allows({"character_ids": ["card-b"]}, "card-a", "sess-1", None) is False


# ───────────────────────────────────────────────────────────────
# 装配层：DB 行按 source_key 分流
# ───────────────────────────────────────────────────────────────
@pytest.fixture()
def card_a(db_session, test_user):
    c = Character(user_id=test_user.id, name="角色A")
    db_session.add(c)
    db_session.commit()
    db_session.refresh(c)
    return c


@pytest.fixture()
def card_b(db_session, test_user):
    c = Character(user_id=test_user.id, name="角色B")
    db_session.add(c)
    db_session.commit()
    db_session.refresh(c)
    return c


def _req(db_session, test_user, char, live=None):
    return PromptAssemblyRequest(
        db=db_session,
        user=test_user,
        char=char,
        session_id="sess-1",
        branch_id=None,
        message="hi",
        extension_prompts=live or [],
    )


def _add_row(db_session, test_user, identifier, source_key, char_ids, content):
    row = ExtensionPrompt(
        user_id=test_user.id,
        session_id=None,
        identifier=identifier,
        content=content,
        position=0,
        depth=4,
        role="system",
        enabled=True,
        source_key=source_key,
    )
    flt = {}
    if char_ids is not None:
        flt["character_ids"] = list(char_ids)
    row.set_filter(flt)
    db_session.add(row)
    db_session.commit()
    return row


class TestDbRowsBySourceKey:
    def test_plugin_row_bound_to_b_not_injected_into_a(
        self, db_session, test_user, card_a, card_b
    ):
        """本次修复的正题：B 的插件行不得出现在 A 的提示词里。"""
        _add_row(db_session, test_user, "fmt-b", "fnv1a-cardB", [str(card_b.id)], "B 卡格式规范")
        result = _collect_extension_prompts(_req(db_session, test_user, card_a))
        assert [e["identifier"] for e in result] == []

    def test_plugin_row_injected_into_its_own_card(
        self, db_session, test_user, card_a, card_b
    ):
        _add_row(db_session, test_user, "fmt-b", "fnv1a-cardB", [str(card_b.id)], "B 卡格式规范")
        result = _collect_extension_prompts(_req(db_session, test_user, card_b))
        assert [e["identifier"] for e in result] == ["fmt-b"]

    def test_plugin_row_with_empty_filter_rejected_for_everyone(
        self, db_session, test_user, card_a, card_b
    ):
        """插件来源却没绑卡 = 配置错误 → 对所有卡都拒绝，让它暴露。"""
        _add_row(db_session, test_user, "fmt-unbound", "fnv1a-unbound", [], "没绑卡的规范")
        for card in (card_a, card_b):
            assert _collect_extension_prompts(_req(db_session, test_user, card)) == []

    def test_manual_row_empty_filter_stays_global(
        self, db_session, test_user, card_a, card_b
    ):
        """用户手写行（source_key=NULL）：空 filter 仍是全局 —— 零回归红线。"""
        _add_row(db_session, test_user, "manual-fmt", None, [], "用户手写的全局规范")
        for card in (card_a, card_b):
            result = _collect_extension_prompts(_req(db_session, test_user, card))
            assert [e["identifier"] for e in result] == ["manual-fmt"]

    def test_existing_persisted_rows_keep_working(
        self, db_session, test_user, card_a
    ):
        """存量行（source_key 非 NULL + character_ids 命中）行为不变。"""
        _add_row(db_session, test_user, "fmt-a", "fnv1a-cardA", [str(card_a.id)], "A 卡格式规范")
        result = _collect_extension_prompts(_req(db_session, test_user, card_a))
        assert [e["identifier"] for e in result] == ["fmt-a"]
        assert result[0]["content"] == "A 卡格式规范"


# ───────────────────────────────────────────────────────────────
# 装配层：请求侧（前端运行时现场注册）条目
# ───────────────────────────────────────────────────────────────
class TestRequestSideEntries:
    def test_request_side_entry_bound_to_current_card(
        self, db_session, test_user, card_a, card_b
    ):
        live = [{"identifier": "live-fmt", "content": "现场注册", "position": 0,
                 "depth": 4, "role": 0, "scan": False, "filter": None}]
        result = _collect_extension_prompts(_req(db_session, test_user, card_a, live))
        assert [e["identifier"] for e in result] == ["live-fmt"]
        # 过滤阶段已按当前角色重绑 character_ids
        assert result[0]["filter"]["character_ids"] == [str(card_a.id)]

    def test_request_side_entry_never_leaks_across_cards(
        self, db_session, test_user, card_a, card_b
    ):
        """请求侧条目按本轮角色重绑：A 轮拿到的规范不会对 B 轮生效。"""
        live = [{"identifier": "live-fmt", "content": "A 的现场注册", "position": 0,
                 "depth": 4, "role": 0, "scan": False, "filter": None}]
        result = _collect_extension_prompts(_req(db_session, test_user, card_a, live))
        assert result[0]["filter"]["character_ids"] == [str(card_a.id)]
        # 同一份 live 条目若被别的卡复用，其重绑目标是那张卡，与 A 无交集
        result_b = _collect_extension_prompts(_req(db_session, test_user, card_b, live))
        assert result_b[0]["filter"]["character_ids"] == [str(card_b.id)]

    def test_request_side_entry_rejected_without_character(
        self, db_session, test_user, card_a
    ):
        """拿不到角色 id（char 为空）时插件来源条目不放行，避免退化成全局。"""
        req = _req(db_session, test_user, card_a, [])
        req.char = None
        live = [{"identifier": "live-fmt", "content": "现场注册", "position": 0,
                 "depth": 4, "role": 0, "scan": False, "filter": None}]
        req.extension_prompts = live
        assert _collect_extension_prompts(req) == []
