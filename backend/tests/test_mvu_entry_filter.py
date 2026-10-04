"""世界书条目筛选回归（P3-a 第一步，2026-10-05）。

用户在角色卡里把某条世界书点成「禁用」，我们原先照旧把它喂进 MVU 的
<initvar> / schema 提取 —— 用户已经表达了「这条不要」，属明确 bug。

本文件钉住三件事：跳过 enabled=False、只认 character_book 类型、缺省视为启用。
同时钉住「**别改坏**」：启用条目与空正文的处理必须与改前一致。

运行: cd backend && py -3 -m pytest tests/test_mvu_entry_filter.py -q
"""
from types import SimpleNamespace

from app.services.mvu_entry_filter import select_character_book_contents


def _stage(content, enabled=True):
    return SimpleNamespace(content=content, enabled=enabled)


def _book(entries, type_="character_book"):
    return SimpleNamespace(type=type_, entries=entries)


def test_disabled_entries_are_skipped():
    """★ 主回归：enabled=False 的条目不得参与。

    改坏方式：去掉 `is False` 那条判断，本用例会读到被禁用的正文而变红。
    """
    books = [
        _book([
            _stage("启用的条目"),
            _stage("被禁用的条目", enabled=False),
        ])
    ]
    assert select_character_book_contents(books) == ["启用的条目"]


def test_disabled_entries_do_not_leak_via_merge_shape():
    """被禁用条目的正文一个字都不该出现（防止将来改成「标记但保留」）。"""
    books = [_book([_stage("SECRET-INITVAR", enabled=False)])]
    out = select_character_book_contents(books)
    assert out == []
    assert all("SECRET-INITVAR" not in c for c in out)


def test_non_character_book_worlds_are_ignored():
    """只认 character_book —— 用户自建/导入的普通世界书不参与 MVU 提取（改前行为）。"""
    books = [
        _book([_stage("角色卡内嵌")], type_="character_book"),
        _book([_stage("用户自建世界书")], type_="user"),
    ]
    assert select_character_book_contents(books) == ["角色卡内嵌"]


def test_enabled_missing_defaults_to_true():
    """enabled 属性缺失视为启用 —— 手工构造/历史对象不能因此被静默丢弃。"""
    stage = SimpleNamespace(content="没有 enabled 字段")
    books = [_book([stage])]
    assert select_character_book_contents(books) == ["没有 enabled 字段"]


def test_empty_and_none_contents_are_skipped():
    """空正文与 None 不产出条目（改前 str(None or '') 会产出空串，这里更严但等价于无用。"""
    books = [_book([_stage(""), _stage(None), _stage("有内容")])]
    assert select_character_book_contents(books) == ["有内容"]


def test_multiple_books_and_order_preserved():
    """多本世界书按原顺序拼接 —— 顺序会影响 initvar 的覆盖优先级，不能乱。"""
    books = [
        _book([_stage("A1"), _stage("A2", enabled=False)]),
        _book([_stage("B1")]),
    ]
    assert select_character_book_contents(books) == ["A1", "B1"]


def test_empty_inputs_are_safe():
    assert select_character_book_contents(None) == []
    assert select_character_book_contents([]) == []
    assert select_character_book_contents([_book([])]) == []
    assert select_character_book_contents([SimpleNamespace(type="character_book", entries=None)]) == []
