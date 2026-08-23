"""ST 1.18.0 depth 注入统一队列排序测试。

验证 ``_insert_depth_prompt``（palink-native）的三级确定序与合并语义，
对齐 ST openai.js ``populationInjectionPrompts`` / script.js ``doChatInject``
/ ``getExtensionPrompt``：

    1. depth 降序（深的先插，锚定从末尾数第 depth 条之前）
    2. 同 depth 内 order 升序（低 order 时间序靠前，高 order 靠近最新消息）
    3. 同 (depth, order) 内 role: assistant → user → system
    4. 同 (depth, order, role) 内 sort_key 字母序，并合并为单条消息 join('\\n')

直接单测 _insert_depth_prompt，mock 掉 req/deps 的最小依赖。
"""

import json
import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.roleplay_prompt_assembly import (
        DepthInjection,
        PromptAssemblyDeps,
        PromptAssemblyRequest,
        _insert_depth_prompt,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - 依赖缺失时跳过
    _IMPORT_OK = False
    _IMPORT_ERROR = exc


pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


BASE_MESSAGES = [
    {"role": "system", "content": "sys"},
    {"role": "user", "content": "u1"},
    {"role": "assistant", "content": "a1"},
    {"role": "user", "content": "u2"},
    {"role": "assistant", "content": "a2"},
    {"role": "user", "content": "u3"},
]


def _make_req(char_extensions=None):
    char = SimpleNamespace(
        id="char-1",
        name="TestChar",
        description="",
        extensions=char_extensions,
        post_history_instructions=None,
    )
    user = SimpleNamespace(id=1, username="TestUser")
    db = SimpleNamespace()
    return PromptAssemblyRequest(
        db=db,
        user=user,
        char=char,
        session_id="s",
        branch_id=None,
        message="m",
        images=[],
        include_prompt_regex=False,
        include_title_instruction=False,
        include_user_message=True,
        is_init=False,
        is_continue=False,
        smart_card_trigger=False,
        group_id=None,
    )


def _make_deps():
    return PromptAssemblyDeps(
        build_system_prompt=lambda *a, **kw: "",
        replace_placeholders=lambda text, *a, **kw: text,
        get_full_branch_history=lambda *a, **kw: [],
        get_ancestor_branch_ids=lambda *a, **kw: [],
        contains_chinese=lambda text: False,
        apply_plugin_regex_scripts=lambda text, *a, **kw: text,
        apply_regex_scripts=lambda text, *a, **kw: text,
        apply_prompt_regex_to_messages=lambda messages, *a, **kw: messages,
    )


def _contents(messages):
    return [m["content"] for m in messages]


def test_same_depth_sources_merge_in_st_key_order():
    """同 depth 全部 system：按 ST 注册表 key 字母序合并为单条消息。

    key ASCII 序: 0_palink_injection < 1_persona_description < 2_floating_prompt
                  < DEPTH_PROMPT < customDepthWI_4_0 < vectors_ext
    """
    entries = [
        DepthInjection(depth=4, content="PLUGIN", role=0, source="extension_prompt", sort_key="vectors_ext"),
        DepthInjection(depth=4, content="AN", role=0, source="author_note", sort_key="2_floating_prompt"),
        DepthInjection(depth=4, content="WI_2", role=0, source="worldbook_depth", sort_key="customDepthWI_4_0"),
        DepthInjection(depth=4, content="INJECT", role=0, source="palink_injection", sort_key="0_palink_injection"),
        DepthInjection(depth=4, content="PERSONA", role=0, source="persona_description", sort_key="1_persona_description"),
        DepthInjection(depth=4, content="WI_1", role=0, source="worldbook_depth", sort_key="customDepthWI_4_0"),
    ]
    report = []
    out = _insert_depth_prompt(list(BASE_MESSAGES), _make_req(), _make_deps(), entries, report)

    # 插入后总长 7（6 基础 + 1 合并消息），单条插入点 = 6-4 = 2，其后剩 4 条原始消息
    assert len(out) == 7
    merged = out[2]
    assert merged["role"] == "system"
    # 同 key 的两条世界书按收集序稳定排列（夹具中 WI_2 先于 WI_1）；跨 key 按 ST 字母序
    assert merged["content"] == "INJECT\nPERSONA\nAN\nWI_2\nWI_1\nPLUGIN"
    assert out[3]["content"] == "a1"
    assert out[4]["content"] == "u2"
    assert out[5]["content"] == "a2"
    assert out[6]["content"] == "u3"


def test_role_order_assistant_user_system_at_same_depth():
    """同 (depth, order) 不同 role：时间序应为 assistant → user → system。"""
    entries = [
        DepthInjection(depth=4, content="SYS_MSG", role=0, source="t", sort_key="a"),
        DepthInjection(depth=4, content="USER_MSG", role=1, source="t", sort_key="b"),
        DepthInjection(depth=4, content="ASSISTANT_MSG", role=2, source="t", sort_key="c"),
    ]
    out = _insert_depth_prompt(list(BASE_MESSAGES), _make_req(), _make_deps(), entries, [])
    # 三组各自成消息，顺序 ASSISTANT → USER → SYSTEM；块尾（system 组）落点后
    # 恰剩原基础消息末尾 4 条（depth=4 锚定）
    contents = _contents(out)
    assert len(out) == 9
    idx_a = contents.index("ASSISTANT_MSG")
    idx_u = contents.index("USER_MSG")
    idx_s = contents.index("SYS_MSG")
    assert idx_a < idx_u < idx_s
    assert idx_s == 4
    assert contents[5:] == ["a1", "u2", "a2", "u3"]


def test_lower_order_appears_earlier_higher_order_near_end():
    """同 depth 同 role 不同 order：低 order 靠前，高 order 靠近最新消息（对齐 ST）。"""
    entries = [
        DepthInjection(depth=4, content="HIGH_ORDER", role=0, source="t", sort_key="h", order=200),
        DepthInjection(depth=4, content="LOW_ORDER", role=0, source="t", sort_key="l", order=50),
    ]
    out = _insert_depth_prompt(list(BASE_MESSAGES), _make_req(), _make_deps(), entries, [])
    contents = _contents(out)
    assert contents.index("LOW_ORDER") < contents.index("HIGH_ORDER")


def test_cross_depth_insert_positions():
    """不同 depth：深者先插靠前，浅者锚定更靠近末尾；depth=0 追加到最末。"""
    entries = [
        DepthInjection(depth=0, content="D0", role=0, source="t", sort_key="a"),
        DepthInjection(depth=3, content="D3", role=0, source="t", sort_key="b"),
    ]
    out = _insert_depth_prompt(list(BASE_MESSAGES), _make_req(), _make_deps(), entries, [])
    contents = _contents(out)
    # D3 先插于 6-3=3；D0 后插于 7-0=7（追加到末尾）
    assert contents[3] == "D3"
    assert contents[-1] == "D0"


def test_char_depth_prompt_joins_unified_queue():
    """角色卡 extensions.depth_prompt 并入统一队列，key='DEPTH_PROMPT'
    排在 '2_floating_prompt'（AN）之后、小写 key 世界书之前。"""
    ext = json.dumps({"depth_prompt": {"prompt": "CHAR_DP", "depth": 4, "role": "system"}})
    entries = [
        DepthInjection(depth=4, content="WB", role=0, source="worldbook_depth", sort_key="customDepthWI_4_0"),
        DepthInjection(depth=4, content="AN", role=0, source="author_note", sort_key="2_floating_prompt"),
    ]
    out = _insert_depth_prompt(list(BASE_MESSAGES), _make_req(char_extensions=ext), _make_deps(), entries, [])
    merged = out[2]
    # ASCII: '2_' < 'DEPTH_PROMPT' < 'customDepthWI'
    assert merged["content"] == "AN\nCHAR_DP\nWB"


def test_empty_queue_noop_and_report_skipped():
    report = []
    out = _insert_depth_prompt(list(BASE_MESSAGES), _make_req(), _make_deps(), [], report)
    assert out == BASE_MESSAGES
    assert any(item.key == "depth_prompt" and item.status == "skipped" for item in report)


def test_merge_joins_multiline_and_skips_empty_parts():
    """同组多条以 \\n 连接；空内容不产生孤立分隔符。"""
    entries = [
        DepthInjection(depth=2, content="", role=0, source="t", sort_key="a"),
        DepthInjection(depth=2, content="L1", role=0, source="t", sort_key="b"),
        DepthInjection(depth=2, content="L2", role=0, source="t", sort_key="c"),
    ]
    out = _insert_depth_prompt(list(BASE_MESSAGES), _make_req(), _make_deps(), entries, [])
    merged = [m for m in out if m["content"] in ("L1\nL2", "L1\nL2\n")]
    assert len(merged) == 1
    assert merged[0]["content"] == "L1\nL2"
