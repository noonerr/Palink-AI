"""分离存储写入侧断言（Step 2）。

两部分：
1. 功能单测：StreamResult.final_text 纯正文、apply_message_extra_patch 合并语义、
   ChatMessage.extra 列存在、运行时兼容清单含 messages.extra。
2. 源码级守卫：锁定「写入侧不再内联包裹思考」的契约（沿用仓库源码断言先例），
   防止后续改动回退包裹行为；Step 4 前端迁移完成后可按需放宽。
"""

import json
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.stream_builder import StreamResult
    from app.utils import apply_message_extra_patch
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _read(rel_path: str) -> str:
    with open(os.path.join(_BACKEND_DIR, rel_path), encoding="utf-8") as f:
        return f.read()


# ---------- 功能单测 ----------

def _make_result(content="", reasoning=""):
    r = StreamResult()
    r.full_content = content
    r.full_reasoning = reasoning
    return r


def test_final_text_returns_pure_content_with_reasoning():
    assert _make_result("正文", "思考").final_text() == "正文"


def test_final_text_returns_pure_content_without_reasoning():
    assert _make_result("正文", "").final_text() == "正文"


class _Msg:
    def __init__(self, extra=None):
        self.extra = extra


def test_extra_patch_creates_on_none():
    msg = _Msg(None)
    apply_message_extra_patch(msg, {"reasoning": "r"})
    assert json.loads(msg.extra) == {"reasoning": "r"}


def test_extra_patch_merges_preserving_existing_keys():
    msg = _Msg(json.dumps({"gen_id": "g1", "model": "m"}, ensure_ascii=False))
    apply_message_extra_patch(msg, {"reasoning": "r"})
    data = json.loads(msg.extra)
    assert data["gen_id"] == "g1" and data["model"] == "m" and data["reasoning"] == "r"


def test_extra_patch_overwrites_reasoning_value():
    msg = _Msg(json.dumps({"reasoning": "旧"}, ensure_ascii=False))
    apply_message_extra_patch(msg, {"reasoning": "新"})
    assert json.loads(msg.extra)["reasoning"] == "新"


def test_extra_patch_empty_is_noop():
    msg = _Msg(None)
    apply_message_extra_patch(msg, {})
    assert msg.extra is None


def test_extra_patch_recovers_from_invalid_existing_json():
    msg = _Msg("{not-json")
    apply_message_extra_patch(msg, {"reasoning": "r"})
    assert json.loads(msg.extra) == {"reasoning": "r"}


def test_chat_message_model_has_extra_column():
    from app.models.message import ChatMessage

    assert hasattr(ChatMessage, "extra")


def test_runtime_compat_columns_include_messages_extra():
    from app.core import migrations as mz

    assert any(
        table == "messages" and column == "extra"
        for table, column, _col_type in mz._RUNTIME_COMPAT_COLUMNS
    )


# ---------- 源码级守卫 ----------

def test_stream_builder_no_inline_wrap_left():
    src = _read(os.path.join("app", "services", "stream_builder.py"))
    assert '"<think"' not in src


def test_websocket_persist_no_wrap_and_wired():
    src = _read(os.path.join("app", "api", "websocket.py"))
    assert "+ regexed_reasoning +" not in src
    assert "result.final_text()" not in src
    assert "apply_message_extra_patch" in src


def test_character_ext_no_wrap_and_tuple_unpacks():
    src = _read(os.path.join("app", "api", "character_ext.py"))
    assert "+ regexed_reasoning +" not in src
    assert "_regexed_reasoning(" in src
    # regenerate 型两处 + continue 一处 = 3 个调用方全部解包二元组
    assert src.count("= _apply_reasoning_regex(") == 3


def test_chat_rest_persist_wired():
    src = _read(os.path.join("app", "api", "chat.py"))
    assert "result.final_text()" not in src
    assert "extra_payload" in src
    assert "apply_message_extra_patch" in src


def test_save_stream_to_db_dead_code_removed():
    """[REASONING-SEPARATE] 死代码 save_stream_to_db/update_stream_in_db 已删除（零调用方）。"""
    src = _read(os.path.join("app", "services", "websocket_manager.py"))
    assert "save_stream_to_db" not in src
    assert "update_stream_in_db" not in src
