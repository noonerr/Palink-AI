"""ST 兼容装配模式归一化与判断测试.

验证:
  - _normalize_silly_tavern_mode 允许 st-compat / compat 作为合法值保留
  - 装配层 _is_st_compat_mode 识别 st-compat / compat 两种模式
"""
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api.users import _normalize_silly_tavern_mode as _normalize_users
    from app.api.silly_tavern import _normalize_silly_tavern_mode as _normalize_st
    from app.services.roleplay_prompt_assembly import _is_st_compat_mode
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class TestNormalizeSillyTavernMode:
    def test_st_compat_preserved_users_api(self):
        assert _normalize_users("st-compat") == "st-compat"

    def test_st_compat_preserved_st_api(self):
        assert _normalize_st("st-compat") == "st-compat"

    def test_compat_preserved(self):
        assert _normalize_users("compat") == "compat"

    def test_palink_native_default(self):
        assert _normalize_users("palink-native") == "palink-native"

    def test_st_native_preserved(self):
        assert _normalize_users("st-native") == "st-native"

    def test_legacy_aliases(self):
        assert _normalize_users("iframe") == "compat"
        assert _normalize_users("native") == "palink-native"

    def test_invalid_falls_back(self):
        assert _normalize_users("classic") == "palink-native"
        assert _normalize_users("") == "palink-native"
        assert _normalize_users(None) == "palink-native"


class TestIsStCompatMode:
    def test_st_compat_true(self):
        assert _is_st_compat_mode("st-compat") is True

    def test_compat_true(self):
        assert _is_st_compat_mode("compat") is True

    def test_palink_native_false(self):
        assert _is_st_compat_mode("palink-native") is False

    def test_st_native_false(self):
        assert _is_st_compat_mode("st-native") is False

    def test_none_false(self):
        assert _is_st_compat_mode(None) is False

    def test_empty_false(self):
        assert _is_st_compat_mode("") is False

    def test_case_insensitive(self):
        assert _is_st_compat_mode("ST-COMPAT") is True
