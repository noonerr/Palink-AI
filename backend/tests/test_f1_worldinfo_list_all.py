"""F-1 回归锁：/api/worldinfo/list 与顶层 world_names 必须列出该用户全部世界书（2026-10-25）。

出处：docs/_active/report/REPORT_ST全量适配悲观审计_2026-10-22.md §2 F-1
     ——三处 `character_id.is_(None)` 使**绑定到角色的世界书在插件面完全不可见**。

ST 侧口径（一手参照树，非推测）：_reference/sillytavern-1.18.0/src/endpoints/
worldinfo.js 列的是用户世界目录下的全部 jsonl，它压根没有"全局 / 角色绑定"这个
维度。所以 Palink 的过滤不是"平台差异"，是把一类数据藏掉了。

本批只动两处（第三处 `_resolve_worldbook` 的默认全局语义**保持不动是刻意的**，
它的 docstring 写明只给读端点开 include_character_bound，/edit /delete 不开——
否则会把"删角色绑定书"变成可达操作；本文件用行为测试钉住这条）：
  - POST /api/worldinfo/list（改为全列 + 每条带 character_id）
  - /api/settings/get 顶层 world_names（改为全列）

运行: cd backend && py -3 -m pytest tests/test_f1_worldinfo_list_all.py -q
"""

import os
import sys
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.models import Character, WorldBook  # noqa: E402


def _seed_books(db, user, *, bound_suffix="F1-BOUND", global_suffix="F1-GLOBAL"):
    """造一本绑定书 + 一本全局书，返回 (char, bound_id, global_id)。"""
    char = Character(
        id=f"f1char-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name="F1 Char",
        description="d",
    )
    db.add(char)
    db.flush()
    bound_id = f"f1wb-bound-{uuid.uuid4().hex[:8]}"
    global_id = f"f1wb-glob-{uuid.uuid4().hex[:8]}"
    db.add(WorldBook(id=bound_id, user_id=user.id, name=bound_suffix, character_id=char.id))
    db.add(WorldBook(id=global_id, user_id=user.id, name=global_suffix, character_id=None))
    db.commit()
    return char, bound_id, global_id


class TestWorldinfoListIncludesBound:
    def test_list_includes_character_bound_book(self, client, auth_headers, db_session, test_user):
        char, bound_id, global_id = _seed_books(db_session, test_user)
        data = client.post("/api/worldinfo/list", headers=auth_headers).json()
        assert bound_id in data, f"绑定书仍被隐藏：keys={list(data)[:5]}"
        assert global_id in data, "全局书必须在（本批只放宽，不收窄）"

    def test_each_entry_carries_character_id(self, client, auth_headers, db_session, test_user):
        char, bound_id, global_id = _seed_books(db_session, test_user)
        data = client.post("/api/worldinfo/list", headers=auth_headers).json()
        assert data[bound_id]["character_id"] == char.id
        assert data[global_id]["character_id"] is None, (
            "前端靠 character_id=None 分辨全局书，这个键不许缺省成别的值"
        )

    def test_v2_shape_also_carries_character_id(self, client, auth_headers, db_session, test_user):
        """?version=2 走 V2 分支，同样要带这个键（否则前端在 V2 下又看不见绑定关系）。"""
        char, bound_id, _ = _seed_books(db_session, test_user)
        data = client.post("/api/worldinfo/list?version=2", headers=auth_headers).json()
        assert data[bound_id]["character_id"] == char.id

    def test_original_data_keeps_st_v2_charbook_shape(
        self, client, auth_headers, db_session, test_user,
    ):
        """Palink 扩展键只加在外层，`originalData` 必须保持 V2 charbook 形状
        （ST 编辑器按那份回查原始字段，塞私有键会污染它）。"""
        char, bound_id, _ = _seed_books(db_session, test_user)
        data = client.post("/api/worldinfo/list", headers=auth_headers).json()
        assert "character_id" not in data[bound_id]["originalData"]

    def test_other_users_books_still_hidden(self, client, auth_headers, db_session):
        """越权口径不变：别人的书（含别人绑定给别人的）一律不进列表。"""
        from app.core.security import get_password_hash
        from app.models import User

        other = User(
            username=f"f1-other-{uuid.uuid4().hex[:8]}",
            hashed_password=get_password_hash("x"),
            role="user",
            is_active=True,
        )
        db_session.add(other)
        db_session.flush()
        other_char = Character(
            id=f"f1otherchar-{uuid.uuid4().hex[:8]}",
            user_id=other.id, name="Other Char", description="d",
        )
        db_session.add(other_char)
        db_session.flush()
        foreign_book_id = f"f1wb-foreign-{uuid.uuid4().hex[:8]}"
        db_session.add(WorldBook(
            id=foreign_book_id, user_id=other.id,
            name="F1-FOREIGN", character_id=other_char.id,
        ))
        db_session.commit()

        data = client.post("/api/worldinfo/list", headers=auth_headers).json()
        assert foreign_book_id not in data


class TestSettingsWorldNamesIncludesBound:
    def test_world_names_includes_both(self, client, auth_headers, db_session, test_user):
        _seed_books(db_session, test_user, bound_suffix="F1W-NAMES-BOUND",
                    global_suffix="F1W-NAMES-GLOBAL")
        data = client.post("/api/settings/get", headers=auth_headers).json()
        names = data.get("world_names") or (data.get("data") or {}).get("world_names")
        assert isinstance(names, list), f"world_names 形状变了：{type(names)}"
        assert "F1W-NAMES-BOUND" in names, "顶层 world_names 仍只列未绑定的书"
        assert "F1W-NAMES-GLOBAL" in names

    def test_world_names_not_deduplicated_by_choice(self, client, auth_headers, db_session, test_user):
        """同名两本书应给出两次——库里确实是两条记录，去重会把这件事藏掉。
        本用例是"决定不去重"这条口径的说明，改主意时必须同步改这里。"""
        char = Character(
            id=f"f1dupchar-{uuid.uuid4().hex[:8]}",
            user_id=test_user.id, name="F1 Dup Char", description="d",
        )
        db_session.add(char)
        db_session.flush()
        for tag in ("A", "B"):
            db_session.add(WorldBook(
                id=f"f1wb-dup{tag}-{uuid.uuid4().hex[:8]}",
                user_id=test_user.id, name="F1W-DUPNAME", character_id=char.id,
            ))
        db_session.commit()
        data = client.post("/api/settings/get", headers=auth_headers).json()
        names = data.get("world_names") or (data.get("data") or {}).get("world_names") or []
        assert names.count("F1W-DUPNAME") == 2, names


class TestDeleteEditStayGlobalScoped:
    """F-1 只放宽"列"。删/改可达面不许被顺手放宽。

    行为断言而不是源码断言：源码断言会被自家注释打穿（本文件第一版就这么红过
    一次——注释里写了被删掉的旧代码串，"不许再出现 X"于是永远红）。
    """

    def test_bound_only_book_survives_worldinfo_delete(
        self, client, auth_headers, db_session, test_user,
    ):
        """按名删书仍只命中全局书：只绑了角色的那本删不掉。

        /api/worldinfo/delete 走 `_resolve_worldbook(...)` 的默认
        （include_character_bound=False，silly_tavern.py:3580）。若有人把
        那个默认一起放宽，"插件在列表里看见一本绑定书 → 顺手删掉它"
        就变成可达操作——那不是 F-1 要求的东西。
        """
        char = Character(
            id=f"f1delchar-{uuid.uuid4().hex[:8]}",
            user_id=test_user.id, name="F1 Del Char", description="d",
        )
        db_session.add(char)
        db_session.flush()
        bound_id = f"f1wb-delbound-{uuid.uuid4().hex[:8]}"
        db_session.add(WorldBook(
            id=bound_id, user_id=test_user.id,
            name="F1-DELETE-SHIELD", character_id=char.id,
        ))
        db_session.commit()

        resp = client.post(
            "/api/worldinfo/delete", headers=auth_headers,
            json={"name": "F1-DELETE-SHIELD"},
        )
        # ST 侧 delete 恒返 200（sendStatus(200)），所以判据不能看状态码，
        # 只能看库里那本还在不在。
        assert resp.status_code == 200, resp.text
        assert db_session.query(WorldBook).filter(WorldBook.id == bound_id).first() is not None, (
            "绑定书被 /api/worldinfo/delete 删掉了：删/改可达面被顺手放宽"
        )

    def test_global_book_is_deletable_by_name(self, client, auth_headers, db_session, test_user):
        """对照组：上一若只因"根本没找到书"而成立，就得证明全局书确实能删掉。"""
        glob_id = f"f1wb-delglob-{uuid.uuid4().hex[:8]}"
        db_session.add(WorldBook(
            id=glob_id, user_id=test_user.id, name="F1-DELETE-GLOBAL", character_id=None,
        ))
        db_session.commit()
        client.post(
            "/api/worldinfo/delete", headers=auth_headers,
            json={"name": "F1-DELETE-GLOBAL"},
        )
        db_session.expire_all()
        assert db_session.query(WorldBook).filter(WorldBook.id == glob_id).first() is None, (
            "全局书也删不掉了 ⇒ 上一用例的「幸存」不是放宽造成的，是端点坏了"
        )
