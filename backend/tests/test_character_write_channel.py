"""角色库写侧（ST-BRIDGE-CHARLIB 2026-10-20 批次B 段②）后端验证测试。

spec: docs/_active/report/REPORT_包AC_人设与角色库写通道_2026-10-20.md §7A（字段映射表）

覆盖：
  1. 越权被拒：别人的 character id 调 PUT / DELETE 必须 404 且 detail 机器可读
     （character_service.py:59-67 / :118-125 均按 user_id 过滤）；
  2. 字段保真：first_messages 的落点（first_mes + alternate_greetings）写进去读得回来；
  3. Palink 专有列不被 replace 清空（CharacterUpdate 是「传了才改」）——
     这是「只补前端会做成假实现」的另一面：替换卡不能把 UI 配置/预设抹掉。
"""

import json
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import User  # noqa: E402
from app.models.character import Character  # noqa: E402


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


def _mk_character(db_session, user, name, cid=None, **fields):
    c = Character(
        id=cid or ("char-" + name),
        user_id=user.id,
        name=name,
        **fields,
    )
    db_session.add(c)
    db_session.commit()
    db_session.refresh(c)
    return c


def test_foreign_character_is_rejected(client, db_session, test_user):
    """越权被拒：别人的 character id —— PUT / DELETE 全 404 且 detail 机器可读。"""
    other = _mk_user(db_session, "other_character_owner")
    foreign = _mk_character(db_session, other, "别人的角色", cid="foreign-character-id", description="原文")

    put = client.put("/api/characters/foreign-character-id", json={"description": "越权改"})
    assert put.status_code == 404, put.text
    assert put.json()["detail"] == "Character not found"

    dele = client.delete("/api/characters/foreign-character-id")
    assert dele.status_code == 404, dele.text
    assert dele.json()["detail"] == "Character not found"

    # 跨请求复核：别人的行没被改也没被删
    db_session.refresh(foreign)
    assert foreign.description == "原文"
    assert db_session.query(Character).filter(Character.id == "foreign-character-id").first() is not None


def test_first_messages_roundtrip(client, db_session, test_user):
    """first_messages 的落点：first_mes + alternate_greetings，写进去读得回来。"""
    c = _mk_character(db_session, test_user, "角色甲")
    resp = client.put(
        ("/api/characters/" + c.id),
        json={"first_mes": "开场0", "alternate_greetings": ["开场1", "开场2"]},
    )
    assert resp.status_code == 200, resp.text

    listed = client.get("/api/characters").json()
    row = [r for r in listed if r["id"] == c.id][0]
    assert row["first_mes"] == "开场0"
    assert row["alternate_greetings"] == ["开场1", "开场2"]


def test_replace_preserves_palink_only_columns(client, db_session, test_user):
    """replace 只改传入字段：ui_config / preset_data / assets 不被清空。"""
    c = _mk_character(
        db_session,
        test_user,
        "角色乙",
        ui_config=json.dumps({"theme": "x"}),
        preset_data=json.dumps({"p": 1}),
        assets=json.dumps([{"type": "icon"}]),
        description="旧描述",
    )
    resp = client.put(("/api/characters/" + c.id), json={"description": "新描述"})
    assert resp.status_code == 200, resp.text

    db_session.refresh(c)
    assert c.description == "新描述"
    assert json.loads(c.ui_config) == {"theme": "x"}
    assert json.loads(c.preset_data) == {"p": 1}
    assert json.loads(c.assets) == [{"type": "icon"}]


def test_create_then_delete_removes_row(client, db_session, test_user):
    """建→删闭环：DELETE 后行确实没了（不假成功），且会话级联清理不报错。"""
    resp = client.post("/api/characters", json={"name": "临时角色丙", "description": "d"})
    assert resp.status_code == 200, resp.text
    cid = resp.json()["character"]["id"]

    dele = client.delete(("/api/characters/" + cid))
    assert dele.status_code == 200, dele.text
    assert db_session.query(Character).filter(Character.id == cid).first() is None
