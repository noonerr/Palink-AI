"""会话级预设覆盖层（写时复制）验证测试 —— 批次P / 包AI，2026-10-20。

对应任务书 `PROMPT_对话包_批次P预设分身与Q沙箱放开与R插件_2026-10-20.md` §P-1 / §P-3：
  1. **未改动不产生副本**：GET 只有 source=global，且 `chat_variables` 里**不落行**；
  2. **首次写才复制**（COW）：PUT 之后 source=session，且 `prompt_presets` 那行**一个字节都没动**；
  3. **永不回写全局**：连写两次，全局行仍与写前逐字段相同；
  4. **丢弃副本回到全局**：DELETE 之后 source=global，全局行仍不变；
  5. **越权失败**：别人的 session 一律 404（不泄露存在性），且不落任何行；
     拿别人的 preset 当 base 也 404。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import ChatSession, ChatVariable, User  # noqa: E402
from app.models.prompt_preset import PromptPreset  # noqa: E402
from app.services.preset_overlay import OVERLAY_KEY, INTERNAL_KEY_PREFIX  # noqa: E402


def _mk_user(db_session, username: str) -> User:
    user = User(
        username=username,
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _mk_session(db_session, user, sid: str) -> ChatSession:
    session = ChatSession(id=sid, user_id=user.id, title="t-" + sid, type="chat")
    db_session.add(session)
    db_session.commit()
    return session


def _mk_preset(db_session, user, name: str, entries: str, pid: str = None) -> PromptPreset:
    preset = PromptPreset(
        id=pid or ("preset-" + name),
        user_id=user.id,
        name=name,
        entries=entries,
        config='{"temperature": 0.7}',
    )
    db_session.add(preset)
    db_session.commit()
    db_session.refresh(preset)
    return preset


def _global_snapshot(db_session, preset_id: str) -> dict:
    row = db_session.query(PromptPreset).filter(PromptPreset.id == preset_id).first()
    return {"name": row.name, "entries": row.entries, "config": row.config}


def test_read_without_overlay_does_not_create_copy(db_session, client, test_user):
    """COW 的"不写就不复制"：读路径一行都不许落。"""
    _mk_session(db_session, test_user, "sess-cow-read")
    _mk_preset(db_session, test_user, "global-one", '[{"id": "main", "content": "g"}]')

    res = client.get("/api/prompt-manager/sessions/sess-cow-read/preset")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["source"] == "global"
    assert body["is_session_copy"] is False
    assert body["name"] == "global-one"
    assert body["entries"] == [{"id": "main", "content": "g"}]
    # 关键：没有产生副本行
    rows = db_session.query(ChatVariable).filter(ChatVariable.session_id == "sess-cow-read").all()
    assert rows == []


def test_first_write_copies_and_never_writes_global(db_session, client, test_user):
    """首次写 = 复制那一刻；全局行逐字段不变。"""
    _mk_session(db_session, test_user, "sess-cow-write")
    preset = _mk_preset(db_session, test_user, "global-two", '[{"id": "main", "content": "orig"}]')
    before = _global_snapshot(db_session, preset.id)

    res = client.put(
        "/api/prompt-manager/sessions/sess-cow-write/preset",
        json={"entries": [{"id": "main", "content": "session-only"}]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["source"] == "session"
    assert body["is_session_copy"] is True
    assert body["base_name"] == "global-two"
    assert body["entries"] == [{"id": "main", "content": "session-only"}]

    # 全局一行都没动
    assert _global_snapshot(db_session, preset.id) == before

    # 副本落在 chat_variables，且 key 走内部前缀（不进卡可见变量表）
    rows = db_session.query(ChatVariable).filter(ChatVariable.session_id == "sess-cow-write").all()
    assert len(rows) == 1
    assert rows[0].key == OVERLAY_KEY
    assert rows[0].key.startswith(INTERNAL_KEY_PREFIX)


def test_second_write_still_does_not_touch_global(db_session, client, test_user):
    """连写两次也不回写全局 —— "改了不回写全局"的正面锚点。"""
    _mk_session(db_session, test_user, "sess-cow-twice")
    preset = _mk_preset(db_session, test_user, "global-three", '[{"id": "main", "content": "orig"}]')
    before = _global_snapshot(db_session, preset.id)

    client.put(
        "/api/prompt-manager/sessions/sess-cow-twice/preset",
        json={"entries": [{"id": "main", "content": "v1"}]},
    )
    res = client.put(
        "/api/prompt-manager/sessions/sess-cow-twice/preset",
        json={"entries": [{"id": "main", "content": "v2"}], "name": "本对话副本"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["entries"] == [{"id": "main", "content": "v2"}]
    assert res.json()["name"] == "本对话副本"
    assert _global_snapshot(db_session, preset.id) == before


def test_delete_returns_to_global(db_session, client, test_user):
    _mk_session(db_session, test_user, "sess-cow-drop")
    preset = _mk_preset(db_session, test_user, "global-four", '[{"id": "main", "content": "orig"}]')
    before = _global_snapshot(db_session, preset.id)

    client.put(
        "/api/prompt-manager/sessions/sess-cow-drop/preset",
        json={"entries": [{"id": "main", "content": "tmp"}]},
    )
    res = client.delete("/api/prompt-manager/sessions/sess-cow-drop/preset")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["dropped"] is True
    assert body["source"] == "global"
    assert _global_snapshot(db_session, preset.id) == before

    # 回到全局后，再读仍是 global（副本确实没了）
    again = client.get("/api/prompt-manager/sessions/sess-cow-drop/preset")
    assert again.json()["source"] == "global"


def test_other_users_session_is_404_and_writes_nothing(db_session, client, test_user):
    """越权失败测试：他人 session 的读/写/删全部 404，且不落行。"""
    other = _mk_user(db_session, "preset_other_user")
    _mk_session(db_session, other, "sess-other")

    assert client.get("/api/prompt-manager/sessions/sess-other/preset").status_code == 404
    put = client.put(
        "/api/prompt-manager/sessions/sess-other/preset",
        json={"entries": [{"id": "main", "content": "hacked"}]},
    )
    assert put.status_code == 404
    assert client.delete("/api/prompt-manager/sessions/sess-other/preset").status_code == 404

    rows = db_session.query(ChatVariable).filter(ChatVariable.session_id == "sess-other").all()
    assert rows == []


def test_other_users_preset_cannot_be_used_as_base(db_session, client, test_user):
    """拿别人的 preset 当换基底座也要 404（否则等于读别人的预设内容）。"""
    other = _mk_user(db_session, "preset_other_user_2")
    _mk_session(db_session, test_user, "sess-base-guard")
    foreign = _mk_preset(db_session, other, "foreign-preset", '[{"id": "main", "content": "secret"}]')

    res = client.put(
        "/api/prompt-manager/sessions/sess-base-guard/preset",
        json={"base_preset_id": foreign.id},
    )
    assert res.status_code == 404
    assert "not found" in res.json()["detail"].lower()
    rows = db_session.query(ChatVariable).filter(ChatVariable.session_id == "sess-base-guard").all()
    assert rows == []
