"""F-8 回归锁：/api/characters/all 的 shallow `data` 对齐 ST toShallow（2026-10-25）。

出处：docs/_active/report/REPORT_ST全量适配悲观审计_2026-10-22.md §2 F-8
一手判据：_reference/sillytavern-1.18.0/src/endpoints/characters.js:369-394 `toShallow`

此前 Palink 的 shallow 项里 `data` 只有 `{"name": ...}`，插件按 ST 形状取
`data.character_version / data.creator / data.creator_notes / data.tags /
data.extensions.world` 全部拿到 undefined。

类型裁定（与派单单据字面不同，已在代码注释里写明理由，**别改回数组**）：
`data.extensions.world` 是**标量**。ST 侧 world-info.js:1128 直接
`books.push(character.data.extensions.world)`；Palink 自己的导入契约也只认
str/dict（character_import_service.py:420-425 "world 为世界书名"）。
塞数组会让所有按名比较的消费方静默失配。多本书的完整事实放在扩展键 `worlds`。

运行: cd backend && py -3 -m pytest tests/test_f8_shallow_characters.py -q
"""

import json
import os
import sys
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.models import Character, WorldBook  # noqa: E402

# ST toShallow 的 data 子对象键集（照抄参照树，不是我们想要的形状）
ST_SHALLOW_DATA_KEYS = {
    "name", "character_version", "creator", "creator_notes", "tags", "extensions",
}
ST_SHALLOW_DATA_EXTENSION_KEYS = {"fav", "world"}


def _seed_character(db, user, **over):
    params = dict(
        id=f"f8char-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name="F8 Char",
        description="d",
        creator="F8-CREATOR",
        character_version="1.2.3",
        creator_notes="F8-CREATOR-NOTES",
        tags=json.dumps(["tagA", "tagB"]),
    )
    params.update(over)
    char = Character(**params)
    db.add(char)
    db.commit()
    return char


def _all_items(client, auth_headers):
    data = client.post("/api/characters/all", headers=auth_headers).json()
    assert isinstance(data, list), type(data)
    return data


class TestShallowDataKeys:
    def test_data_has_the_st_keys(self, client, auth_headers, db_session, test_user):
        char = _seed_character(db_session, test_user)
        item = next(i for i in _all_items(client, auth_headers) if i["palink_id"] == char.id)
        got = set(item["data"].keys())
        assert ST_SHALLOW_DATA_KEYS <= got, f"data 缺 ST 键：{ST_SHALLOW_DATA_KEYS - got}"

    def test_data_values_are_the_card_columns(self, client, auth_headers, db_session, test_user):
        char = _seed_character(db_session, test_user, name="F8 Val Char")
        item = next(i for i in _all_items(client, auth_headers) if i["palink_id"] == char.id)
        d = item["data"]
        assert d["name"] == "F8 Val Char"
        assert d["character_version"] == "1.2.3"
        assert d["creator"] == "F8-CREATOR"
        assert d["creator_notes"] == "F8-CREATOR-NOTES"
        assert d["tags"] == ["tagA", "tagB"]

    def test_extensions_world_present_and_scalar(self, client, auth_headers, db_session, test_user):
        char = _seed_character(db_session, test_user, name="F8 World Char")
        db_session.add(WorldBook(
            id=f"f8wb-{uuid.uuid4().hex[:8]}", user_id=test_user.id,
            name="F8-BOOK-PRIMARY", character_id=char.id,
        ))
        db_session.commit()
        item = next(i for i in _all_items(client, auth_headers) if i["palink_id"] == char.id)
        ext = item["data"]["extensions"]
        assert ST_SHALLOW_DATA_EXTENSION_KEYS <= set(ext.keys())
        assert ext["world"] == "F8-BOOK-PRIMARY"
        assert isinstance(ext["world"], str), (
            "world 必须是标量：ST 直接 books.push(extensions.world)，"
            "Palink 导入侧也只认 str/dict（见 character_import_service.py:420-425）"
        )

    def test_unbound_card_gives_empty_world_string_not_none(self, client, auth_headers, db_session, test_user):
        """空值形状：ST 用 _.get(...,'') 兜空串。给 None 会让插件拼出 'null'。"""
        char = _seed_character(db_session, test_user, name="F8 NoBook Char")
        item = next(i for i in _all_items(client, auth_headers) if i["palink_id"] == char.id)
        assert item["data"]["extensions"]["world"] == ""
        assert item["data"]["extensions"]["worlds"] == []

    def test_multiple_bound_books_are_all_listed_via_palink_key(self, client, auth_headers, db_session, test_user):
        """多本书：标量 `world` 取按名排序的第一本（稳定），全部书名走 `worlds`。"""
        char = _seed_character(db_session, test_user, name="F8 Multi Char")
        for nm in ("Zeta-Book", "Alpha-Book"):
            db_session.add(WorldBook(
                id=f"f8wb-{uuid.uuid4().hex[:8]}", user_id=test_user.id,
                name=nm, character_id=char.id,
            ))
        db_session.commit()
        item = next(i for i in _all_items(client, auth_headers) if i["palink_id"] == char.id)
        ext = item["data"]["extensions"]
        assert ext["world"] == "Alpha-Book", "标量主书取值不稳定 ⇒ 同一份数据刷新会换书"
        assert ext["worlds"] == ["Alpha-Book", "Zeta-Book"]

    def test_shallow_markers_unchanged(self, client, auth_headers, db_session, test_user):
        """本批只填 data，别动 shallow 标记与顶层那批空字符串（那是"浅"的契约）。"""
        char = _seed_character(db_session, test_user, name="F8 Shallow Char")
        item = next(i for i in _all_items(client, auth_headers) if i["palink_id"] == char.id)
        assert item["shallow"] is True
        assert item["description"] == ""
        assert item["personality"] == ""
        assert item["first_mes"] == ""

    def test_missing_columns_degrade_to_empty_strings(self, client, auth_headers, db_session, test_user):
        """老卡这三列常为 NULL：必须落成 ST 的兜底空串/空数组，不许是 None。"""
        char = _seed_character(
            db_session, test_user, name="F8 Nulls Char",
            creator=None, character_version=None, creator_notes=None, tags=None,
        )
        item = next(i for i in _all_items(client, auth_headers) if i["palink_id"] == char.id)
        d = item["data"]
        assert d["creator"] == "" and d["character_version"] == "" and d["creator_notes"] == ""
        assert d["tags"] == []


class TestNoPerCharacterQuery:
    def test_world_books_are_batch_fetched(self):
        """绑定书必须一次 IN 查询取，不许逐角色查（E-6 刚清掉的那种 N+1）。

        这条是结构断言而非计数断言：本机能跑通的真库只有测试库，测不到
        查询次数（SQLAlchemy event 在 SQLite 夹具上不稳），所以退一步锁
        "批取代码在场 + 逐角色查书的路径没被引入"。
        """
        import inspect
        from app.api import silly_tavern as st

        src = inspect.getsource(st.st_all_characters)
        assert "WorldBook.character_id.in_(character_ids)" in src
        assert "db.query(WorldBook).filter(WorldBook.character_id == c" not in src

    def test_frontend_list_consumers_only_read_known_keys(self):
        """前端消费方兼容：角色列表用到的 data 键必须仍在场（本批只加不减）。"""
        import inspect
        from app.api import silly_tavern as st

        item = st._character_to_st_list_item(
            Character(id="x", user_id=1, name="Probe"), None, [],
        )
        for key in ("name", "avatar", "chat", "create_date", "date_added",
                    "tags", "creator", "character_version", "fav", "shallow", "palink_id"):
            assert key in item, f"顶层键 {key} 不见了（前端列表依赖它）"
        assert item["data"]["name"] == "Probe"
