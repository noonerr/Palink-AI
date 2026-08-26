"""B-6 回归：character_book 导入条目级保真。

spec: docs/SILLYTAVERN_COMPAT_SPEC_2026-08-23.md §3 B-6
锁定三件事：
1. V2 规范排序字段 ``insertion_order`` 生效（旧字段 ``order`` 兼容回退）；
2. extensions 子字段规范 snake_case（world-info.js:5533-5534）正确落库，
   旧导出器的 camelCase 同样兼容；
3. 多条目按插入序号排序进入 stage_index。
"""

import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.character_import_service import CharacterImportService  # noqa: E402


def _base_content(comment: str) -> dict:
    return {
        "key": ["alpha"],
        "keysecondary": [],
        "content": f"content of {comment}",
        "comment": comment,
        "constant": False,
        "selective": True,
        "position": 0,
        "disable": False,
    }


def _spec_entry() -> dict:
    """V2 规范写法：insertion_order + extensions 全 snake_case。"""
    entry = _base_content("SpecEntry")
    entry.update({"insertion_order": 77, "probability": 60})
    entry["extensions"] = {
        "case_sensitive": True,
        "match_whole_words": True,
        "selective_logic": 3,
        "exclude_recursion": True,
        "prevent_recursion": True,
        "scan_depth": 2,
        "sticky": 4,
        "cooldown": 6,
        "delay": 9,
        "depth": 1,
    }
    return entry


def _legacy_entry() -> dict:
    """旧导出器写法：顶层 order + extensions 全 camelCase。"""
    entry = _base_content("LegacyEntry")
    entry.update({"order": 42, "probability": 80})
    entry["extensions"] = {
        "caseSensitive": True,
        "matchWholeWords": True,
        "selectiveLogic": 2,
        "excludeRecursion": True,
        "preventRecursion": True,
        "sticky": 3,
        "delay": 7,
        "depth": 5,
    }
    return entry


@pytest.fixture()
def _imported_stages(db_session, test_user):
    from app.models import Character

    character = Character(
        name="CharA",
        description="d",
        personality="p",
        scenario="s",
        first_mes="f",
        mes_example="",
        user_id=test_user.id,
    )
    db_session.add(character)
    db_session.commit()

    def _run(book: dict):
        service = CharacterImportService(db_session)
        wb = service._create_worldbook_from_character_book(
            book, "CharA", test_user.id, str(character.id)
        )
        assert wb is not None
        return (
            db_session.query(WorldBookStage)
            .filter(WorldBookStage.world_book_id == wb.id)
            .order_by(WorldBookStage.stage_index.asc())
            .all(),
            wb,
        )

    return _run


def test_spec_snake_case_fields_imported(_imported_stages):
    stages, _wb = _imported_stages(
        {"name": "spec book", "entries": {"0": _spec_entry()}}
    )
    assert len(stages) == 1
    st = stages[0]
    assert st.order == 77
    assert st.probability == 60
    assert st.case_sensitive is True
    assert st.match_whole_words is True
    assert st.selective_logic == 3
    assert st.exclude_recursion is True
    assert st.prevent_recursion is True
    assert st.scan_depth == 2
    assert st.sticky == 4
    assert st.cooldown == 6
    assert st.delay == 9
    assert st.depth == 1


def test_legacy_camel_case_still_imported(_imported_stages):
    """既有 camelCase 卡不得因本次修复而回退。"""
    stages, _wb = _imported_stages(
        {"name": "legacy book", "entries": {"0": _legacy_entry()}}
    )
    assert len(stages) == 1
    st = stages[0]
    assert st.order == 42
    assert st.probability == 80
    assert st.case_sensitive is True
    assert st.match_whole_words is True
    assert st.selective_logic == 2
    assert st.exclude_recursion is True
    assert st.prevent_recursion is True
    assert st.sticky == 3
    assert st.delay == 7
    assert st.depth == 5


def test_entries_sorted_by_insertion_order(_imported_stages):
    late = _base_content("Late")
    late.update({"insertion_order": 90, "extensions": {}})
    early = _base_content("Early")
    early.update({"insertion_order": 10, "extensions": {}})
    # dict 声明顺序故意与 insertion_order 相反，验证排序真实生效
    stages, wb = _imported_stages(
        {"name": "sorted book", "entries": {"0": late, "1": early}}
    )
    titles = [s.title for s in stages]
    assert titles == ["Early", "Late"]
    assert wb.raw_content is not None
    assert wb.raw_content.index("Early") < wb.raw_content.index("Late")
