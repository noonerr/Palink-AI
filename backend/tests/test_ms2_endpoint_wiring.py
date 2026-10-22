"""接口级接线测试：`GET /api/character-sessions/{sid}/messages` 必须真的把
「被清理摘掉明细的楼层」用补丁重演补回 `extra.variables.stat_data`。

为什么必须有这个文件（采纳 2026-10-22 外部审计 R-1 / P2-3）：
`test_mvu_state_as_of.py` 测的是**策略内核**（`mvu_state` 的取值规则），
把这个端点里那行 `_materialize_floor_variables_for_display(...)` 调用**注释掉，
那些用例依然全绿** —— 这是本仓的老坑「策略内核单测全绿 ≠ 接线生效」。
本文件用真实 HTTP 调用 + **内建反向证明**（把接线改成空操作，断言必须变红）补上这一环。
"""

from __future__ import annotations

import json

import pytest

from app.models import (
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
)


@pytest.fixture()
def client(db_session, test_user):
    from fastapi.testclient import TestClient

    import app.api.dependencies as deps
    from app.core.database import get_db
    from app.main import app

    def _override_get_db():
        yield db_session

    async def _override_user():
        return test_user

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[deps.get_current_user] = _override_user
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(deps.get_current_user, None)


def _seed(db, user):
    sess = CharacterChatSession(user_id=user.id, title="t-wiring", chat_metadata="{}")
    db.add(sess)
    db.flush()
    br = CharacterChatSessionBranch(
        id="br-wiring", session_id=sess.id, branch_name="主线", is_active=True
    )
    db.add(br)
    db.flush()

    def add(extra_obj):
        m = CharacterChatMessage(
            session_id=sess.id, branch_id=br.id, role="assistant", content="x",
            is_user=False, is_system=False, is_locked=False, swipe_id=0,
            swipes=json.dumps(["x"], ensure_ascii=False),
            extra=json.dumps(extra_obj, ensure_ascii=False),
        )
        db.add(m)
        db.flush()
        return m

    add({"variables": {"stat_data": {"好感度": 1}}})
    f2 = add({
        "variables": {"pruned": True},
        "mvu_patch": [{"op": "replace", "path": "/好感度", "value": 2}],
    })
    db.commit()
    return sess, f2


def _get_msg(client, sid, mid):
    r = client.get(f"/api/character-sessions/{sid}/messages?limit=10")
    assert r.status_code == 200, r.text
    for m in r.json().get("messages", []):
        if int(m.get("id")) == int(mid):
            return m, r.json()
    raise AssertionError(f"第 {mid} 楼不在响应里")


def test_pruned_floor_is_materialized_by_the_endpoint(client, db_session, test_user):
    sess, f2 = _seed(db_session, test_user)

    m, payload = _get_msg(client, sess.id, f2.id)
    assert (m.get("extra") or {}).get("mvu_state_source") == "replay"
    assert ((m.get("extra") or {}).get("variables") or {}).get("stat_data") == {"好感度": 2}
    # 页面级那份也必须是最新视点的值（该楼被摘 ⇒ 重演值），而不是空
    assert (payload.get("variables") or {}).get("stat_data") == {"好感度": 2}


def test_wiring_is_load_bearing(client, db_session, test_user, monkeypatch):
    """★ 反向证明：把接线改成空操作，同一断言必须变红。

    这一条证明的是**接线本身**是承重的，而不是内核能算出来而已。
    """
    sess, f2 = _seed(db_session, test_user)

    import app.api.character_ext as ce

    monkeypatch.setattr(ce, "_materialize_floor_variables_for_display", lambda *a, **k: None)

    m, _payload = _get_msg(client, sess.id, f2.id)
    assert ((m.get("extra") or {}).get("variables") or {}).get("stat_data") in (None, {}), (
        "接线被拔掉后该楼仍有值 ⇒ 说明这个断言测不到接线"
    )
