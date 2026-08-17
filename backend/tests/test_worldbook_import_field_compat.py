"""世界书/角色书导入字段名兼容测试.

ST 导出格式（角色卡 character_book / lorebook JSON）使用 keys / secondary_keys / enabled，
ST 前端内部格式使用 key / keysecondary / disable。导入逻辑必须同时兼容两者，
否则关键词与禁用状态在导入时丢失。
"""
import os
import sys
from unittest.mock import MagicMock

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.worldbook_import_utils import (
        entry_keys,
        entry_secondary_keys,
        entry_is_disabled,
    )
    from app.services.character_import_service import CharacterImportService
    from app.models.worldbook import WorldBookStage
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class TestEntryKeys:
    def test_st_export_format_keys(self):
        assert entry_keys({"keys": ["a", "b"]}) == ["a", "b"]

    def test_st_internal_format_key(self):
        assert entry_keys({"key": ["a"]}) == ["a"]

    def test_st_export_format_preferred(self):
        assert entry_keys({"keys": ["a"], "key": ["b"]}) == ["a"]

    def test_missing_returns_empty_list(self):
        assert entry_keys({}) == []
        assert entry_keys(None) == []

    def test_scalar_key_normalized_to_list(self):
        assert entry_keys({"key": "keyword"}) == ["keyword"]


class TestEntrySecondaryKeys:
    def test_st_export_format_secondary_keys(self):
        assert entry_secondary_keys({"secondary_keys": ["s1"]}) == ["s1"]

    def test_st_internal_format_keysecondary(self):
        assert entry_secondary_keys({"keysecondary": ["s2"]}) == ["s2"]

    def test_missing_returns_empty_list(self):
        assert entry_secondary_keys({}) == []


class TestEntryIsDisabled:
    def test_st_export_format_enabled_false(self):
        assert entry_is_disabled({"enabled": False}) is True

    def test_st_export_format_enabled_true(self):
        assert entry_is_disabled({"enabled": True}) is False

    def test_st_internal_format_disable_true(self):
        assert entry_is_disabled({"disable": True}) is True

    def test_st_internal_format_disable_false(self):
        assert entry_is_disabled({"disable": False}) is False

    def test_enabled_takes_priority_over_disable(self):
        assert entry_is_disabled({"enabled": True, "disable": True}) is False

    def test_missing_returns_false(self):
        assert entry_is_disabled({}) is False
        assert entry_is_disabled(None) is False


class TestCreateWorldbookFromCharacterBook:
    def _make_service(self):
        service = CharacterImportService.__new__(CharacterImportService)
        service.db = MagicMock()
        return service

    def _st_character_book(self):
        return {
            "name": "Test Lore",
            "entries": {
                "0": {
                    "keys": ["南方联合大学", "大学"],
                    "secondary_keys": ["SDU"],
                    "enabled": True,
                    "constant": False,
                    "comment": "地点_大学",
                    "content": "大学设定内容",
                    "position": "after_char",
                    "extensions": {},
                    "selective": True,
                },
                "1": {
                    "keys": [],
                    "enabled": False,
                    "constant": True,
                    "comment": "[initvar]变量初始化勿开",
                    "content": "<initvar>秘密指令</initvar>",
                    "extensions": {},
                },
                "2": {
                    "keys": ["city"],
                    "enabled": True,
                    "constant": False,
                    "comment": "城市",
                    "content": "城市设定",
                    "extensions": {},
                },
            },
        }

    def test_imports_keys_and_skips_disabled(self):
        service = self._make_service()
        service._create_worldbook_from_character_book(
            self._st_character_book(), "TestChar", 1, "char-1"
        )

        stages = [c for c in service.db.add.call_args_list if isinstance(c[0][0], WorldBookStage)]
        # 3 个条目中第 2 个（enabled=False）应被跳过，只导入 2 个
        assert len(stages) == 2

        # 第一条：ST keys 字段应被保留
        stage0 = stages[0][0][0]
        import json as _json
        assert _json.loads(stage0.keys) == ["南方联合大学", "大学"]
        assert _json.loads(stage0.secondary_keys) == ["SDU"]
        assert stage0.enabled is True

        # 第二条：常驻关键词条目 keys 保留
        stage1 = stages[1][0][0]
        assert _json.loads(stage1.keys) == ["city"]
        assert stage1.enabled is True

        # 断言没有导入 enabled=False 的 [initvar] 条目
        titles = [s[0][0].title for s in service.db.add.call_args_list if isinstance(s[0][0], WorldBookStage)]
        assert not any("[initvar]" in (t or "") for t in titles)

    def test_internal_format_key_and_disable_compat(self):
        """ST 内部格式（key/disable）也应兼容导入。"""
        service = self._make_service()
        character_book = {
            "name": "Legacy",
            "entries": {
                "0": {
                    "key": ["legacy"],
                    "disable": False,
                    "constant": False,
                    "comment": "旧格式",
                    "content": "旧格式内容",
                    "extensions": {},
                },
            },
        }
        service._create_worldbook_from_character_book(character_book, "C", 1, "c-1")
        stages = [c for c in service.db.add.call_args_list if isinstance(c[0][0], WorldBookStage)]
        assert len(stages) == 1
        import json as _json
        assert _json.loads(stages[0][0][0].keys) == ["legacy"]
        assert stages[0][0][0].enabled is True
