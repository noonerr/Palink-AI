"""分支命名：会话内全局序号，不因分叉点不同而重名（R5 收尾 2026-10-23）。

改「从当前进度分叉」后，每个分叉点都可能是新节点；旧的「同一父节点下第几个」算法
会让列表里出现多个「分支 1」。这里钉住：编号取已有「分支 N」的最大 N + 1，
且删除后不复用编号。

运行: cd backend && py -3 -m pytest tests/test_branch_naming.py -q
"""
from __future__ import annotations

from app.models import (
    Character,
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
)


def _make_session(db, user):
    char = Character(user_id=user.id, name="命名测试卡", description="d", first_mes="hi")
    db.add(char)
    db.flush()
    session = CharacterChatSession(character_id=char.id, user_id=user.id)
    db.add(session)
    db.flush()
    db.commit()
    return session


def _create(client, auth_headers, session_id):
    resp = client.post(
        f"/api/character-sessions/{session_id}/branches",
        json={"session_id": session_id},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["branch"]


def test_branch_names_are_session_global(db_session, test_user, client, auth_headers):
    session = _make_session(db_session, test_user)

    names = [_create(client, auth_headers, session.id)["branch_name"] for _ in range(3)]

    assert names == ["分支 1", "分支 2", "分支 3"], names


def test_deleted_number_is_not_reused(db_session, test_user, client, auth_headers):
    session = _make_session(db_session, test_user)
    for _ in range(3):
        _create(client, auth_headers, session.id)

    branches = (
        db_session.query(CharacterChatSessionBranch)
        .filter(CharacterChatSessionBranch.session_id == session.id)
        .all()
    )
    middle = next(b for b in branches if b.branch_name == "分支 2")
    # 直接删行而不走 DELETE 端点：测试库没有 conversation_memories 表，delete_branch 会 500；
    # 本用例只钉「命名不复用编号」，先把该分支的问候消息删掉绕开外键。
    db_session.query(CharacterChatMessage).filter(
        CharacterChatMessage.branch_id == middle.id
    ).delete()
    db_session.delete(middle)
    db_session.commit()

    created = _create(client, auth_headers, session.id)
    assert created["branch_name"] == "分支 4", created
