"""分支「该用哪一条」的唯一规则 + 读不写库 回归（批次 BRANCH-1）。

## 两个缺陷

**缺陷 1（读路径写库）**：`_active_branch()` 在会话没人标 `is_active` 时会把
**最新建的**分支 `is_active = True` 并 `flush()`。`get_db` 不 commit ⇒ 改动蒸发；
但 `POST /api/chats/save` 自带 `db.commit()` ⇒ 存一次盘就切了故事线。

**缺陷 2（三套规则 + 两处无 ORDER BY）**：消息端点 `created_at.desc()`、前端
`max(last_message_at||created_at)`、分支树 `None`、`delete_branch` 无 ORDER BY 的
`first()`。本文件把唯一规则钉死：

    有 is_active=true ⇒ 用它；
    否则 ⇒ 装着最新一条消息的那条分支；
    再否则 ⇒ created_at 最新建的分支（id 决胜）。

布景刻意让「最新建的」与「装着最新消息的」**不是同一条**，否则新旧规则给出同一答案，
用例无法区分。

运行: cd backend && py -3 -m pytest tests/test_branch_resolution_single_owner.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

from sqlalchemy import text

from app.models import (
    Character,
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
)

T0 = datetime(2026, 10, 20, 12, 0, 0)
T1 = T0 + timedelta(hours=1)
T2 = T0 + timedelta(hours=2)
T3 = T0 + timedelta(hours=3)
T5 = T0 + timedelta(hours=5)


# ─────────────────────────────────────────────────────────────────────────────
# 布景
# ─────────────────────────────────────────────────────────────────────────────
def _seed(db, user, *, active_branch):
    """一个会话三条分支，返回 (character, session_id, ids)。

    A: T0 建，消息 T5（**装着最新消息**）
    B: T1 建，消息 T2
    C: T3 建，**没有消息**（= 旧兜底 created_at.desc() 的胜者）

    ``active_branch`` 为空串表示一条都不标。
    """
    ids = {"A": f"brA-{uuid.uuid4().hex[:6]}", "B": f"brB-{uuid.uuid4().hex[:6]}",
           "C": f"brC-{uuid.uuid4().hex[:6]}"}
    char = Character(id=str(uuid.uuid4()), user_id=user.id, name="分支规则卡")
    db.add(char)
    db.flush()
    sess = CharacterChatSession(
        id=str(uuid.uuid4()),
        character_id=char.id,
        user_id=user.id,
        title="分支规则",
        chat_metadata="{}",
        created_at=T0,
        updated_at=T0,
    )
    db.add(sess)
    db.flush()

    layout = [
        ("A", T0, T5),
        ("B", T1, T2),
        ("C", T3, None),
    ]
    for key, created, _msg_at in layout:
        db.add(
            CharacterChatSessionBranch(
                id=ids[key],
                session_id=sess.id,
                branch_name=key,
                is_active=(key == active_branch),
                created_at=created,
                last_message_at=created,
            )
        )
    db.flush()
    for key, _created, msg_at in layout:
        if msg_at is None:
            continue
        db.add(
            CharacterChatMessage(
                session_id=sess.id,
                branch_id=ids[key],
                role="user",
                content=f"楼在 {key}",
                is_user=True,
                is_system=False,
                is_hidden=False,
                is_locked=False,
                swipe_id=0,
                swipes=json.dumps([key], ensure_ascii=False),
                created_at=msg_at,
            )
        )
    db.commit()
    return char, sess.id, ids


def _active_ids(db, session_id):
    """直读库（expire_all 后重查），返回该会话所有 is_active 的分支 id（已排序）。"""
    db.expire_all()
    rows = (
        db.query(CharacterChatSessionBranch)
        .filter(CharacterChatSessionBranch.session_id == session_id)
        .all()
    )
    return sorted(r.id for r in rows if r.is_active)


def _ensure_memory_table(db):
    """delete_branch 里有裸 SQL `DELETE FROM conversation_memories`；该表不是 ORM 表，
    conftest 的 create_all 不会造它。补空壳属测试脚手架，不是产品缺陷。"""
    db.execute(
        text(
            "CREATE TABLE IF NOT EXISTS conversation_memories "
            "(id INTEGER PRIMARY KEY, session_id TEXT, branch_id TEXT)"
        )
    )
    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# 1. 读路径：有 active 标记就用它，且一个字节都不写
# ─────────────────────────────────────────────────────────────────────────────
def test_flagged_branch_wins_and_read_does_not_write(client, auth_headers, db_session, test_user):
    """A（早建、带标记）vs B（装着最新消息）⇒ 必须用 A，且读完后库里的标记不变。"""
    _char, sid, ids = _seed(db_session, test_user, active_branch="A")
    before = _active_ids(db_session, sid)
    assert before == [ids["A"]], before

    r = client.get(f"/api/character-sessions/{sid}/messages?limit=50", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["active_branch_id"] == ids["A"], (
        f"有 active 标记时 /messages 用了 {body.get('active_branch_id')!r}，期望 A={ids['A']!r}"
    )
    assert {m.get("branch_id") for m in body["messages"]} == {ids["A"]}, (
        f"消息页码跨到了别的分支：{ {m.get('branch_id') for m in body['messages']} }"
    )

    # ST 列表（POST /api/characters/chats）是历史病灶的入口：它经 `_active_branch()`。
    r2 = client.post("/api/characters/chats", headers=auth_headers, json={"avatar_url": _char.id})
    assert r2.status_code == 200, r2.text

    after = _active_ids(db_session, sid)
    assert after == before, (
        f"GET /messages + ST chats 列表之后 is_active 从 {before} 变成 {after} —— 读路径写库"
    )


def test_branch_list_carries_active_branch_id(client, auth_headers, db_session, test_user):
    """GET /branches 显式下发 active_branch_id，列表顺序确定（created_at ASC）。"""
    _char, sid, ids = _seed(db_session, test_user, active_branch="A")
    r = client.get(f"/api/character-sessions/{sid}/branches", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["active_branch_id"] == ids["A"], body.get("active_branch_id")
    assert body["active_branch_source"] == "flagged_active", body.get("active_branch_source")
    assert [b["id"] for b in body["branches"]] == [ids["A"], ids["B"], ids["C"]], (
        f"分支列表顺序不确定：{[b['id'] for b in body['branches']]}"
    )
    assert _active_ids(db_session, sid) == [ids["A"]], "GET /branches 改了 is_active"


# ─────────────────────────────────────────────────────────────────────────────
# 2. 无 active 标记：选「装着最新消息」的那条，不是最新建的
# ─────────────────────────────────────────────────────────────────────────────
def test_fallback_uses_newest_message_not_newest_created(client, auth_headers, db_session, test_user):
    """A（消息 T5，最新）vs C（T3 建、无消息）⇒ 必须 A，且响应带 active_branch_id。"""
    _char, sid, ids = _seed(db_session, test_user, active_branch="")
    assert _active_ids(db_session, sid) == []

    r = client.get(f"/api/character-sessions/{sid}/messages?limit=50", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("active_branch_id") == ids["A"], (
        f"无标记时 /messages 的 active_branch_id = {body.get('active_branch_id')!r}，"
        f"期望装着最新消息的 A={ids['A']!r}（旧兜底 created_at.desc() 会给 C={ids['C']!r}）"
    )
    assert {m.get("branch_id") for m in body["messages"]} == {ids["A"]}, (
        "无标记时消息页不是来自装着最新消息的分支"
    )

    # 读三次（列表/树/再来一次消息）都不得把标记写进库
    client.get(f"/api/character-sessions/{sid}/branches", headers=auth_headers)
    client.get(f"/api/character-sessions/{sid}/branch-tree", headers=auth_headers)
    assert _active_ids(db_session, sid) == [], (
        f"无标记会话读完变成了 {_active_ids(db_session, sid)} —— 读路径写库"
    )


def test_branch_tree_agrees_with_messages_when_unflagged(client, auth_headers, db_session, test_user):
    """分支树旧实现在无标记时给 None，与 /messages 互相矛盾；现在必须同源同答案。"""
    _char, sid, ids = _seed(db_session, test_user, active_branch="")
    tree = client.get(f"/api/character-sessions/{sid}/branch-tree", headers=auth_headers)
    assert tree.status_code == 200, tree.text
    assert tree.json().get("active_branch_id") == ids["A"], (
        f"branch-tree 的 active_branch_id = {tree.json().get('active_branch_id')!r}，期望 A"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 3. chats/save 的 commit 不得顺带切换故事线
# ─────────────────────────────────────────────────────────────────────────────
def test_chat_save_does_not_flip_is_active(client, auth_headers, db_session, test_user):
    """活动分支是 A，存盘（后端会 commit）前后 is_active 必须一字不变。"""
    char, sid, ids = _seed(db_session, test_user, active_branch="A")
    before = _active_ids(db_session, sid)
    assert before == [ids["A"]], before

    r = client.post(
        "/api/chats/save",
        headers={**auth_headers, "X-Palink-Session-Id": sid},
        json={
            "avatar_url": char.id,
            "ch_name": "分支规则存档",
            "chat": [
                {"name": "User", "is_user": True, "mes": "存盘第一句", "send_date": T0.isoformat()},
                {"name": "分支规则卡", "is_user": False, "mes": "存盘第二句", "send_date": T0.isoformat()},
            ],
        },
    )
    assert r.status_code == 200, r.text

    after = _active_ids(db_session, sid)
    assert after == before, (
        f"POST /api/chats/save 把 is_active 从 {before} 改成了 {after} —— 存盘顺带切了故事线"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 4. delete_branch 的接管者必须确定
# ─────────────────────────────────────────────────────────────────────────────
def test_delete_active_branch_reactivation_is_deterministic(client, auth_headers, db_session, test_user):
    """删掉 active(A) ⇒ 存活分支里装着最新消息的是 B（T2）⇒ **B** 接管，写死断言。"""
    _char, sid, ids = _seed(db_session, test_user, active_branch="A")
    _ensure_memory_table(db_session)
    assert _active_ids(db_session, sid) == [ids["A"]]

    r = client.delete(
        f"/api/character-sessions/{sid}/branches/{ids['A']}", headers=auth_headers
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["was_active"] is True
    assert body.get("activated_branch_id") == ids["B"], (
        f"接管者应为装着最新存活消息的 B={ids['B']!r}，响应给的是 {body.get('activated_branch_id')!r}"
    )
    assert _active_ids(db_session, sid) == [ids["B"]], (
        f"删活动分支后库里的标记是 {_active_ids(db_session, sid)}，期望 B"
    )
