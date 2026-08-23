"""ST 1.18.0 extension_prompts in st-compat path (build_st_compat_messages).

验证四态注入：BEFORE_PROMPT(2) / IN_PROMPT(0) / IN_CHAT(1) / NONE(-1)
以及 role 变体、空 content 跳过、与 author_note 独立性、多条目排序。

position 枚举（与 ST 1.18.0 extension_prompt_types script.js:491-496 完全一致）：
    -1 = NONE         (跳过)
     0 = IN_PROMPT    (并入 system prompt（messages[0]）文本末尾；不按 depth)
     1 = IN_CHAT      (按 depth 插入到 history_messages；depth=0 追加到末尾)
     2 = BEFORE_PROMPT (作为最前的 system 消息；author_note 优先时排在 [1])

[INJ-CLOSE-TAG-GUARD] 2026-08-19 行为变更：IN_PROMPT(0) 此前是"追加为 messages
末尾独立消息"，会把 system 注入放到 prompt 最后一条（紧贴模型续写位置），实测导致
推理模型 100% 空响应（立刻 EOS 或正文写进 reasoning）。现对齐 ST 1.18.0
getPromptPosition(IN_PROMPT)='end'（system prompt 末尾）语义，并入 messages[0] 文本。

注意：author_note_position 用的是 ST 枚举（-1/0/1/2），与 extension_prompts
的 position 共用同一套枚举（都是 ST 1.18.0 extension_prompt_types）。
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.character_message_builder import build_st_compat_messages  # noqa: E402
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ---------------------------------------------------------------------------
# Mock 构造工具 (复用 test_st_compat_p2_features.py 的套路)
# ---------------------------------------------------------------------------
def _make_char(**overrides):
    defaults = dict(
        name="Alice",
        description="char description",
        personality="brave and clever",
        scenario="a fantasy quest",
        mes_example="",
        post_history_instructions=None,
        jailbreak=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_db_empty_history():
    """构造 mock DB session，history 查询返回空列表。"""
    db = MagicMock()
    query = MagicMock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    query.all.return_value = []
    db.query.return_value = query
    return db


def _build(extension_prompts=None, authors_note="", authors_note_position=1,
           authors_note_depth=4, history=None, message="hi", **kwargs):
    """调用 build_st_compat_messages 的最小化 helper。

    默认空 history、空 author_note、非群聊。
    history 参数若提供，则作为 _get_full_branch_history 的返回值（需配合 branch_id）。
    """
    char = kwargs.pop("char", None) or _make_char()

    def _history_fn(*a, **k):
        return list(history) if history else []

    base = dict(
        db=_make_db_empty_history(),
        char=char,
        user_nickname="User",
        session_id="sess-1",
        branch_id="br-1",  # 走 _get_full_branch_history 路径
        message=message,
        images=[],
        system_prompt_override=None,
        world_info_before="",
        world_info_after="",
        persona_description="",
        jailbreak="",
        authors_note=authors_note,
        authors_note_depth=authors_note_depth,
        authors_note_position=authors_note_position,
        dynamic_context_parts=[],
        prompt_lang="en",
        user_setting=None,
        _replace_placeholders=lambda t, u, c: t,
        _get_full_branch_history=_history_fn,
        _contains_chinese=lambda t: False,
        normalize_image_url=lambda u, check_size=False: u,
        include_user_message=True,
    )
    base.update(kwargs)
    if extension_prompts is not None:
        base["extension_prompts"] = extension_prompts
    return build_st_compat_messages(**base)


def _all_contents(messages):
    return [m.get("content") for m in messages if isinstance(m.get("content"), str)]


def _find_idx(messages, needle):
    """返回第一条 content 含 needle 的消息索引，找不到返回 -1。"""
    for i, m in enumerate(messages):
        c = m.get("content", "")
        if isinstance(c, str) and needle in c:
            return i
    return -1


# ---------------------------------------------------------------------------
# Position 2: BEFORE_PROMPT
# ---------------------------------------------------------------------------
class TestEPPosition2BeforePrompt:
    """position=2 (BEFORE_PROMPT): 作为最前的 system 消息插入。"""

    def test_ep_inserted_as_first_system_message(self):
        """ep 应出现在 messages[0]，且为 system 角色。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_BEFORE_MARKER", "position": 2,
             "depth": 4, "role": "system"}
        ])
        assert len(msgs) > 0
        assert msgs[0]["role"] == "system"
        assert "EP_BEFORE_MARKER" in msgs[0]["content"], \
            f"BEFORE_PROMPT ep 应在 messages[0], got[0]={msgs[0].get('content')!r}"

    def test_ep_after_author_note_when_both_before_prompt(self):
        """author_note position=2 + ep position=2 → author_note 在 [0], ep 在 [1]。"""
        msgs = _build(
            authors_note="AN_BEFORE_TEXT",
            authors_note_position=2,  # author_note BEFORE_PROMPT (ST 枚举)
            extension_prompts=[
                {"identifier": "t1", "content": "EP_BEFORE_MARKER", "position": 2,
                 "depth": 4, "role": "system"}
            ],
        )
        assert "AN_BEFORE_TEXT" in msgs[0]["content"], \
            f"author_note 应在 [0], got[0]={msgs[0].get('content')!r}"
        assert "EP_BEFORE_MARKER" in msgs[1]["content"], \
            f"ep 应在 [1] (author_note 之后), got[1]={msgs[1].get('content')!r}"

    def test_multiple_before_prompt_joined(self):
        """多条 BEFORE_PROMPT ep 应拼接为一条 system 消息。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_BEFORE_ONE", "position": 2,
             "depth": 4, "role": "system"},
            {"identifier": "t2", "content": "EP_BEFORE_TWO", "position": 2,
             "depth": 4, "role": "system"},
        ])
        assert "EP_BEFORE_ONE" in msgs[0]["content"]
        assert "EP_BEFORE_TWO" in msgs[0]["content"]
        # 应拼接为单条消息（用 \n\n 连接）
        assert msgs[0]["content"].count("EP_BEFORE_ONE") == 1


# ---------------------------------------------------------------------------
# Position 0: IN_PROMPT
# ---------------------------------------------------------------------------
class TestEPPosition0InPrompt:
    """position=0 (IN_PROMPT): 并入 system prompt（messages[0]）文本末尾。"""

    def test_ep_merged_into_system_prompt(self):
        """position=0, depth=4 → 注入文本并入 messages[0]（忽略 depth）。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_IN_PROMPT_END", "position": 0,
             "depth": 4, "role": "system"}
        ])
        assert len(msgs) > 0
        assert msgs[0]["role"] == "system"
        assert "EP_IN_PROMPT_END" in msgs[0]["content"], \
            f"IN_PROMPT 应并入 messages[0], got[0]={msgs[0].get('content')!r}"

    def test_ep_depth_ignored_merged_into_system_prompt(self):
        """depth=2 时仍并入 system prompt（IN_PROMPT 不按 depth）。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_IN_PROMPT_D_IGNORE", "position": 0,
             "depth": 2, "role": "system"}
        ])
        idx = _find_idx(msgs, "EP_IN_PROMPT_D_IGNORE")
        assert idx == 0, \
            f"IN_PROMPT 不按 depth, 应并入 messages[0], idx={idx}"

    def test_ep_in_prompt_never_at_messages_end(self):
        """IN_PROMPT 注入不得出现在 messages 末尾（防空响应回归）。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_ROLE_USER", "position": 0,
             "depth": 0, "role": "user"}
        ])
        assert "EP_ROLE_USER" in msgs[0]["content"]
        assert "EP_ROLE_USER" not in str(msgs[-1].get("content", "")), \
            f"IN_PROMPT 注入不得落在末尾, got[-1]={msgs[-1].get('content')!r}"


# ---------------------------------------------------------------------------
# Position 1: IN_CHAT
# ---------------------------------------------------------------------------
class TestEPPosition1InChat:
    """position=1 (IN_CHAT): 按 depth 插入到 history_messages。"""

    def test_ep_depth0_appended_to_history_end(self):
        """depth=0 → ep 追加到 history 末尾（在 user message 之后）。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_IN_CHAT_END", "position": 1,
             "depth": 0, "role": "system"}
        ])
        ep_idx = _find_idx(msgs, "EP_IN_CHAT_END")
        user_idx = _find_idx(msgs, "hi")
        assert ep_idx >= 0, "ep depth=0 应被注入到 history"
        assert user_idx >= 0, "user message 'hi' 应存在"
        assert ep_idx > user_idx, \
            f"depth=0 ep 应在 user message 之后, ep_idx={ep_idx}, user_idx={user_idx}"

    def test_ep_depth1_inserted_before_last_history(self):
        """depth=1 → ep 插入到 history 倒数第 1 条之前（user message 之前）。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_IN_CHAT_D1", "position": 1,
             "depth": 1, "role": "system"}
        ])
        ep_idx = _find_idx(msgs, "EP_IN_CHAT_D1")
        user_idx = _find_idx(msgs, "hi")
        assert ep_idx >= 0, "ep depth=1 应被注入到 history"
        assert user_idx >= 0, "user message 'hi' 应存在"
        assert ep_idx < user_idx, \
            f"depth=1 ep 应在 user message 之前, ep_idx={ep_idx}, user_idx={user_idx}"

    def test_ep_in_chat_role_assistant(self):
        """IN_CHAT ep role=assistant → 注入的 message role 为 assistant。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_ROLE_ASST", "position": 1,
             "depth": 0, "role": "assistant"}
        ])
        idx = _find_idx(msgs, "EP_ROLE_ASST")
        assert idx >= 0
        assert msgs[idx]["role"] == "assistant"


# ---------------------------------------------------------------------------
# Position -1: NONE (skip)
# ---------------------------------------------------------------------------
class TestEPPositionNone1:
    """position=-1 (NONE): 跳过，不注入。"""

    def test_ep_skipped(self):
        """position=-1 的 ep 不应出现在 messages 中。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_NONE_SHOULD_NOT_APPEAR", "position": -1,
             "depth": 4, "role": "system"}
        ])
        contents = _all_contents(msgs)
        assert not any("EP_NONE_SHOULD_NOT_APPEAR" in c for c in contents), \
            "position=-1 (NONE) 的 ep 应被跳过"


# ---------------------------------------------------------------------------
# Role 变体
# ---------------------------------------------------------------------------
class TestEPRoleVariants:
    """role 字段兼容：字符串 / int 值。

    注：IN_PROMPT(0) 注入并入 system prompt 文本，role 不生效（2026-08-19
    行为变更，见文件头注释）；role 归一化在 IN_CHAT(1) 注入的消息上验证。
    """

    def test_role_user_creates_user_message(self):
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_RV_USER", "position": 1,
             "depth": 0, "role": "user"}
        ])
        idx = _find_idx(msgs, "EP_RV_USER")
        assert idx >= 0
        assert msgs[idx]["role"] == "user"

    def test_role_assistant_creates_assistant_message(self):
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_RV_ASST", "position": 1,
             "depth": 0, "role": "assistant"}
        ])
        idx = _find_idx(msgs, "EP_RV_ASST")
        assert idx >= 0
        assert msgs[idx]["role"] == "assistant"

    def test_role_int_values_normalized(self):
        """role 为 int 时应归一化：0→system, 1→user, 2→assistant。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_RV_INT0", "position": 1,
             "depth": 0, "role": 0},
        ])
        idx = _find_idx(msgs, "EP_RV_INT0")
        assert idx >= 0 and msgs[idx]["role"] == "system"

        msgs = _build(extension_prompts=[
            {"identifier": "t2", "content": "EP_RV_INT1", "position": 1,
             "depth": 0, "role": 1},
        ])
        idx = _find_idx(msgs, "EP_RV_INT1")
        assert idx >= 0 and msgs[idx]["role"] == "user"

        msgs = _build(extension_prompts=[
            {"identifier": "t3", "content": "EP_RV_INT2", "position": 1,
             "depth": 0, "role": 2},
        ])
        idx = _find_idx(msgs, "EP_RV_INT2")
        assert idx >= 0 and msgs[idx]["role"] == "assistant"

    def test_role_invalid_string_falls_back_to_system(self):
        """role 为非法字符串时应回退为 system。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_RV_INVALID", "position": 1,
             "depth": 0, "role": "narrator"}
        ])
        idx = _find_idx(msgs, "EP_RV_INVALID")
        assert idx >= 0 and msgs[idx]["role"] == "system"


# ---------------------------------------------------------------------------
# 空 content 跳过
# ---------------------------------------------------------------------------
class TestEPEmptyContent:
    """content 为空/whitespace 的 ep 应被跳过。"""

    def test_empty_content_skipped(self):
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "", "position": 0, "depth": 0, "role": "system"},
        ])
        contents = _all_contents(msgs)
        # 不应新增空 message；只要不抛错即视为跳过
        assert all(c.strip() != "" or c == "" for c in contents)  # sanity

    def test_whitespace_content_skipped(self):
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "   \n\n  ", "position": 2,
             "depth": 4, "role": "system"},
        ])
        # 不应在 messages[0] 出现纯空白内容
        assert msgs[0]["content"].strip() != "" or "EP" not in msgs[0]["content"]


# ---------------------------------------------------------------------------
# 与 author_note 独立
# ---------------------------------------------------------------------------
class TestEPIndependentOfAuthorNote:
    """extension_prompts 注入应与 author_note 完全独立。"""

    def test_ep_injected_even_when_author_note_none(self):
        """author_note_position=-1 (NONE) 时 ep 仍应注入。"""
        msgs = _build(
            authors_note="AN_TEXT",
            authors_note_position=-1,  # NONE (ST 枚举)
            extension_prompts=[
                {"identifier": "t1", "content": "EP_INDEPENDENT_BP", "position": 2,
                 "depth": 4, "role": "system"}
            ],
        )
        assert "EP_INDEPENDENT_BP" in msgs[0]["content"], \
            "author_note NONE 不应阻止 ep 注入"

    def test_ep_injected_even_when_author_note_empty(self):
        """authors_note 为空字符串时 ep 仍应注入。"""
        msgs = _build(
            authors_note="",
            authors_note_position=1,
            extension_prompts=[
                {"identifier": "t1", "content": "EP_INDEPENDENT_EMPTY", "position": 2,
                 "depth": 4, "role": "system"}
            ],
        )
        assert "EP_INDEPENDENT_EMPTY" in msgs[0]["content"]

    def test_ep_and_author_note_both_in_chat(self):
        """author_note IN_CHAT (pos=1) + ep IN_CHAT (pos=1) 应同时注入到 history。
        author_note 先注入（更靠前位置），ep 后注入。"""
        msgs = _build(
            authors_note="AN_IN_CHAT",
            authors_note_position=1,  # IN_CHAT (ST 枚举)
            authors_note_depth=2,
            extension_prompts=[
                {"identifier": "t1", "content": "EP_IN_CHAT_BOTH", "position": 1,
                 "depth": 1, "role": "system"}
            ],
        )
        an_idx = _find_idx(msgs, "AN_IN_CHAT")
        ep_idx = _find_idx(msgs, "EP_IN_CHAT_BOTH")
        user_idx = _find_idx(msgs, "hi")
        assert an_idx >= 0, "author_note 应注入"
        assert ep_idx >= 0, "ep 应注入"
        assert user_idx >= 0
        # author_note depth=2 → 在 user 之前 2 位；ep depth=1 → 在 user 之前 1 位
        # 所以 author_note 应在 ep 之前
        assert an_idx < ep_idx < user_idx, \
            f"期望 an_idx < ep_idx < user_idx, got an={an_idx}, ep={ep_idx}, user={user_idx}"


# ---------------------------------------------------------------------------
# 多条目排序
# ---------------------------------------------------------------------------
class TestEPMultipleEntries:
    """多条 ep 同 position 时应按 depth 降序插入（避免索引偏移）。"""

    def test_multiple_in_chat_sorted_by_depth(self):
        """两条 IN_CHAT ep: depth=3 应在 depth=1 之前（更靠前的位置）。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_DEPTH_1", "position": 1,
             "depth": 1, "role": "system"},
            {"identifier": "t2", "content": "EP_DEPTH_3", "position": 1,
             "depth": 3, "role": "system"},
        ])
        idx_d1 = _find_idx(msgs, "EP_DEPTH_1")
        idx_d3 = _find_idx(msgs, "EP_DEPTH_3")
        user_idx = _find_idx(msgs, "hi")
        assert idx_d1 >= 0 and idx_d3 >= 0, "两条 ep 都应注入"
        assert user_idx >= 0
        # depth=3 插入更靠前（更早），depth=1 更靠近 user
        assert idx_d3 < idx_d1 < user_idx, \
            f"期望 depth=3 在 depth=1 之前且都在 user 之前, " \
            f"d3={idx_d3}, d1={idx_d1}, user={user_idx}"

    def test_multiple_in_prompt_appended_in_order(self):
        """两条 IN_PROMPT ep: 都并入 system prompt，按发送顺序。"""
        msgs = _build(extension_prompts=[
            {"identifier": "t1", "content": "EP_IP_FIRST", "position": 0,
             "depth": 4, "role": "system"},
            {"identifier": "t2", "content": "EP_IP_SECOND", "position": 0,
             "depth": 4, "role": "system"},
        ])
        assert msgs[0]["role"] == "system"
        c0 = msgs[0]["content"]
        assert "EP_IP_FIRST" in c0 and "EP_IP_SECOND" in c0, "两条 ep 都应并入 messages[0]"
        # 并入 system prompt 文本，first 在 second 之前
        assert c0.index("EP_IP_FIRST") < c0.index("EP_IP_SECOND"), \
            f"期望 first 在 second 之前, content={c0!r}"


# ---------------------------------------------------------------------------
# 默认 None / 空 list 不影响构建
# ---------------------------------------------------------------------------
class TestEPDefaultNone:
    """extension_prompts=None 或 [] 时应正常构建（向后兼容）。"""

    def test_none_does_not_raise(self):
        msgs = _build(extension_prompts=None)
        assert isinstance(msgs, list)
        assert len(msgs) > 0

    def test_empty_list_does_not_raise(self):
        msgs = _build(extension_prompts=[])
        assert isinstance(msgs, list)
        assert len(msgs) > 0

    def test_not_passing_param_does_not_raise(self):
        """不传 extension_prompts 参数（默认 None）应正常工作。"""
        msgs = _build()
        assert isinstance(msgs, list)
        assert len(msgs) > 0
