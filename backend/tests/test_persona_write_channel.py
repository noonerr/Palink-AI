"""人设写通道（ST-BRIDGE-PERSONA 2026-10-20 批次B）验证测试。

spec: docs/_active/HANDOFF_提示词_已授权批次_写桥与人设角色库与getContext与服务端留痕_2026-10-20.md §B

覆盖三件事（对应任务书 §3 的安全要求）：
  1. ST persona.d.ts:6-18 的 title/role/lorebook 三字段（本批按用户拍板补列）必须
     **写进去读得回来** —— 不补列就是"写进去读不回来"的假实现；
  2. **越权被拒**：别人的 persona id 调 PUT / DELETE / PUT-active 必须 404，
     且 detail 机器可读；并复核别人的行没被改动也没被删；
  3. current 语义：/active 的设置与清除（getCurrentPersonaId 的父侧落点）。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import User  # noqa: E402
from app.models.persona import Persona  # noqa: E402


def _mk_other_user(db_session, username: str) -> User:
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


def _mk_persona(db_session, user, name, pid=None, **fields):
    p = Persona(
        id=pid or ("persona-" + name),
        user_id=user.id,
        name=name,
        character_bindings="{}",
        **fields,
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


def test_create_persona_roundtrips_st_fields(client, db_session, test_user):
    """persona.d.ts:6-18 的 title/role/lorebook：POST → GET list 必须原样读回。"""
    resp = client.post(
        "/api/personas",
        json={
            "name": "玩家甲",
            "description": "desc",
            "title": "旁白标题",
            "role": 1,
            "lorebook": "某世界书",
        },
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()
    pid = created["id"]
    assert created["title"] == "旁白标题"
    assert created["role"] == 1
    assert created["lorebook"] == "某世界书"

    listed = client.get("/api/personas").json()
    row = [r for r in listed if r["id"] == pid][0]
    assert row["title"] == "旁白标题"
    assert row["role"] == 1
    assert row["lorebook"] == "某世界书"


def test_update_persona_st_fields(client, db_session, test_user):
    """PUT /{id} 必须能改 title/role/lorebook 并读回（补列的写通道）。"""
    p = _mk_persona(db_session, test_user, "玩家乙")
    resp = client.put(
        ("/api/personas/" + p.id),
        json={"title": "新标题", "role": 2, "lorebook": "lb2"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "新标题"
    assert body["role"] == 2
    assert body["lorebook"] == "lb2"

    listed = client.get("/api/personas").json()
    row = [r for r in listed if r["id"] == p.id][0]
    assert row["title"] == "新标题"
    assert row["role"] == 2
    assert row["lorebook"] == "lb2"


def test_foreign_persona_is_rejected(client, db_session, test_user):
    """越权被拒：别人的 persona id —— PUT/DELETE/PUT-active 全 404 且 detail 机器可读。

    后端归属过滤一手核实：personas.py:182-187（PUT）与 :235-240（DELETE）均
    `Persona.user_id == user.id`；PUT /active :159-164 同。这条测试钉住它不回退。
    """
    other = _mk_other_user(db_session, "other_persona_owner")
    foreign = _mk_persona(
        db_session,
        other,
        "别人的设",
        pid="foreign-persona-id",
        title="别人的标题",
    )

    put = client.put(("/api/personas/" + foreign.id), json={"title": "越权改"})
    assert put.status_code == 404, put.text
    assert put.json()["detail"] == "Persona not found"

    dele = client.delete(("/api/personas/" + foreign.id))
    assert dele.status_code == 404, dele.text
    assert dele.json()["detail"] == "Persona not found"

    active = client.put("/api/personas/active", json={"persona_id": foreign.id})
    assert active.status_code == 404, active.text
    assert active.json()["detail"] == "Persona not found"

    # 跨请求复核：别人的行没被改动也没被删（不假成功）
    db_session.refresh(foreign)
    assert foreign.title == "别人的标题"
    still = db_session.query(Persona).filter(Persona.id == foreign.id).first()
    assert still is not None


def test_active_persona_set_and_clear(client, db_session, test_user):
    """current 语义：PUT /active 设置后 GET /active 返回该 id；清空后返 null。"""
    p = _mk_persona(db_session, test_user, "当前设")
    set_resp = client.put("/api/personas/active", json={"persona_id": p.id})
    assert set_resp.status_code == 200, set_resp.text
    active = client.get("/api/personas/active").json()
    assert active["activePersonaId"] == p.id
    assert active["persona"]["name"] == "当前设"

    clear = client.put("/api/personas/active", json={"persona_id": None})
    assert clear.status_code == 200, clear.text
    after = client.get("/api/personas/active").json()
    assert after["activePersonaId"] is None
    assert after["persona"] is None


def test_create_persona_rejects_current_name(client, db_session, test_user):
    """ST 契约（persona.d.ts:81）：名为 'current' 的 persona 建不出来。

    后端不拦这个（name 是自由字符串），父侧桥拦；这里钉住后端至少能原样落库
    供父侧判重使用 —— 真正的 'current' 拒绝在父侧测试里断言。
    """
    resp = client.post("/api/personas", json={"name": "current"})
    assert resp.status_code == 200, resp.text
    listed = client.get("/api/personas").json()
    assert any(r["name"] == "current" for r in listed)
