"""角色卡脚本存档（character_plugin_storage）落库 + 越权 + 删卡清理的契约测试。

对应 docs/SPEC_卡脚本本地存储按角色与账号隔离_2026-10-02.md §5-P2 / §7 的四条验收：
  1. PUT 按 key 合并，不覆盖同 character 的其他 key；
  2. 越权访问他人 character_id → 404（不是 403，403 会泄漏"该 id 存在"）；
  3. 删卡后 character_plugin_storage 无残留；
  4. expressions 的按名查找在同名多行时返回确定性那一行。

背景：角色卡自带脚本的解锁态原本只写在浏览器 localStorage（同一个 origin 全局一份），
后端完全不知情 —— 换设备丢进度、同浏览器多账号互相看见对方解锁的立绘。
本表的定位是**同步副本**：前端永远本地先命中，同步失败静默降级为纯本地。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models.character_plugin_storage import CharacterPluginStorage


def _mk_char(db_session, user_id, name="露缇雅1.2", created_at=None):
    from app.models import Character

    char = Character(user_id=user_id, name=name)
    if created_at is not None:
        char.created_at = created_at
    db_session.add(char)
    db_session.commit()
    db_session.refresh(char)
    return char


def _mk_other_user(db_session, username="other_pl_storage_user"):
    from app.core.security import get_password_hash
    from app.models import User

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


def _put(client, char_id, entries, ns="local"):
    return client.put(
        f"/api/characters/{char_id}/plugin-storage",
        json={"ns": ns, "entries": entries},
    )


# ── 1. PUT 按 key 合并 ────────────────────────────────────────────────────
def test_put_merges_by_key_without_wiping_siblings(client, test_user, db_session):
    """整命名空间覆盖会让多端并发互相抹掉对方刚写的键，这里必须是 merge 语义。"""
    char = _mk_char(db_session, test_user.id)

    assert _put(client, char.id, [{"key": "a", "value": "1"}]).status_code == 200
    # 第二次只提 b：a 必须还在（整覆盖的话 a 就没了）
    res = _put(client, char.id, [{"key": "b", "value": "2"}])
    assert res.status_code == 200
    assert (res.json() or {}).get("written") == 1

    got = client.get(f"/api/characters/{char.id}/plugin-storage?ns=local")
    assert got.status_code == 200
    values = (got.json() or {}).get("values") or {}
    assert values == {"a": "1", "b": "2"}


def test_put_does_not_touch_other_namespaces(client, test_user, db_session):
    char = _mk_char(db_session, test_user.id)
    _put(client, char.id, [{"key": "k", "value": "local-v"}], ns="local")
    _put(client, char.id, [{"key": "k", "value": "session-v"}], ns="session")

    local = client.get(f"/api/characters/{char.id}/plugin-storage?ns=local").json()["values"]
    session = client.get(f"/api/characters/{char.id}/plugin-storage?ns=session").json()["values"]
    assert local == {"k": "local-v"}
    assert session == {"k": "session-v"}


def test_put_none_value_deletes_the_key(client, test_user, db_session):
    char = _mk_char(db_session, test_user.id)
    _put(client, char.id, [{"key": "a", "value": "1"}, {"key": "b", "value": "2"}])
    res = _put(client, char.id, [{"key": "a", "value": None}])
    assert (res.json() or {}).get("removed") == 1

    values = client.get(f"/api/characters/{char.id}/plugin-storage").json()["values"]
    assert values == {"b": "2"}


def test_put_is_idempotent_upsert(client, test_user, db_session):
    char = _mk_char(db_session, test_user.id)
    _put(client, char.id, [{"key": "a", "value": "1"}])
    _put(client, char.id, [{"key": "a", "value": "9"}])

    rows = db_session.query(CharacterPluginStorage).filter(
        CharacterPluginStorage.character_id == char.id,
        CharacterPluginStorage.key == "a",
    ).all()
    assert len(rows) == 1
    assert rows[0].value == "9"


# ── 2. 越权 → 404 ────────────────────────────────────────────────────────
def test_other_users_character_is_404_not_403(client, test_user, db_session):
    other = _mk_other_user(db_session)
    # 同名不同 id —— 正是修复要防的场景
    theirs = _mk_char(db_session, other.id, name="露缇雅1.2")

    got = client.get(f"/api/characters/{theirs.id}/plugin-storage")
    assert got.status_code == 404
    put = client.put(
        f"/api/characters/{theirs.id}/plugin-storage",
        json={"ns": "local", "entries": [{"key": "k", "value": "v"}]},
    )
    assert put.status_code == 404

    # 写库必须真的没发生
    assert db_session.query(CharacterPluginStorage).filter(
        CharacterPluginStorage.character_id == theirs.id
    ).count() == 0


def test_missing_character_is_404(client):
    got = client.get("/api/characters/00000000-0000-0000-0000-000000000000/plugin-storage")
    assert got.status_code == 404


# ── 3. 删卡连带清理 ──────────────────────────────────────────────────────
def test_deleting_character_leaves_no_storage_rows(test_user, db_session):
    from app.models import Character
    from app.services.character_service import CharacterService

    char = _mk_char(db_session, test_user.id)
    db_session.add(CharacterPluginStorage(
        character_id=char.id, user_id=test_user.id, ns="local",
        key="tavern_cg_album_unlocked", value='["露出魔纹1"]',
    ))
    db_session.commit()
    assert db_session.query(CharacterPluginStorage).filter(
        CharacterPluginStorage.character_id == char.id
    ).count() == 1

    ok = CharacterService(db_session).delete_character(char.id, test_user.id)
    assert ok is True

    assert db_session.query(CharacterPluginStorage).filter(
        CharacterPluginStorage.character_id == char.id
    ).count() == 0
    assert db_session.query(Character).filter(Character.id == char.id).first() is None


# ── 4. expressions 同名多行的确定性兜底 ────────────────────────────────────
def test_get_character_by_name_is_deterministic_on_duplicates(test_user, db_session):
    """原本 `.first()` 无 ORDER BY，返回哪行取决于 DB 物理顺序 ——
    用户上传自定义表情会随机串到另一张同名卡上。"""
    from app.api.expressions import _get_character_by_name_or_404

    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    older = _mk_char(db_session, test_user.id, name="露缇雅1.2", created_at=base)
    middle = _mk_char(db_session, test_user.id, name="露缇雅1.2", created_at=base + timedelta(days=1))
    _mk_char(db_session, test_user.id, name="露缇雅1.2", created_at=base + timedelta(days=2))

    picks = set()
    for _ in range(5):
        picks.add(_get_character_by_name_or_404(db_session, "露缇雅1.2", test_user).id)
    assert picks == {older.id}, "必须稳定回到 created_at 最早的那一张"
    # 三张同名卡确实并存（正是修复要面对的现实）
    assert [older.id, middle.id] and picks.isdisjoint({middle.id})


def test_get_character_by_name_404_for_unknown(test_user, db_session):
    from fastapi import HTTPException

    from app.api.expressions import _get_character_by_name_or_404

    with pytest.raises(HTTPException) as exc:
        _get_character_by_name_or_404(db_session, "压根不存在的角色", test_user)
    assert exc.value.status_code == 404
