"""ST 模式归一化与封存测试.

验证（[MODE-SEALED] 2026-08-24 封存语义）:
  - _normalize_silly_tavern_mode 将封存模式（st-compat/compat/st-native 及别名 iframe）
    一律重定向为 palink-native；GET 报告与 PUT 落库均不可达封存模式
  - 装配入口 _st_mode_effective 把封存模式归一化，st-compat 装配管线运行时不可达；
    _is_st_compat_mode 函数级契约保持原样（固化测试直调，不经封存层）
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
    from app.services.roleplay_prompt_assembly import (
        SEALED_ST_MODES,
        ST_COMPAT_MODES,
        _is_st_compat_mode,
        _st_mode_effective,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class TestNormalizeSillyTavernModeSealed:
    """[MODE-SEALED] 封存模式重定向：所有非 palink-native 输入一律收敛。"""

    def test_st_compat_sealed_users_api(self):
        assert _normalize_users("st-compat") == "palink-native"

    def test_st_compat_sealed_st_api(self):
        assert _normalize_st("st-compat") == "palink-native"

    def test_compat_sealed(self):
        assert _normalize_users("compat") == "palink-native"
        assert _normalize_st("compat") == "palink-native"

    def test_st_native_sealed(self):
        assert _normalize_users("st-native") == "palink-native"
        assert _normalize_st("st-native") == "palink-native"

    def test_iframe_alias_sealed(self):
        # iframe → compat → 命中封存集 → palink-native
        assert _normalize_users("iframe") == "palink-native"
        assert _normalize_st("iframe") == "palink-native"

    def test_palink_native_passes(self):
        assert _normalize_users("palink-native") == "palink-native"
        assert _normalize_st("palink-native") == "palink-native"

    def test_native_alias_passes(self):
        assert _normalize_users("native") == "palink-native"

    def test_invalid_falls_back(self):
        assert _normalize_users("classic") == "palink-native"
        assert _normalize_users("") == "palink-native"
        assert _normalize_users(None) == "palink-native"


class TestIsStCompatMode:
    """函数级契约保持原样（固化测试直调，不经过封存层）。"""

    def test_st_compat_true(self):
        assert _is_st_compat_mode("st-compat") is True

    def test_compat_true(self):
        assert _is_st_compat_mode("compat") is True

    def test_palink_native_false(self):
        assert _is_st_compat_mode("palink-native") is False

    def test_none_false(self):
        assert _is_st_compat_mode(None) is False

    def test_empty_false(self):
        assert _is_st_compat_mode("") is False


class TestStModeEffectiveEntrance:
    """[MODE-SEALED] 入口归一化：封存模式在装配入口按 palink-native 处理。"""

    def test_sealed_modes_normalized_to_empty(self):
        # 归一化为空串 → _is_st_compat_mode(空) = False → 装配走 palink-native 分支
        for sealed in ("st-compat", "compat", "st-native", "ST-COMPAT", " Compat "):
            effective = _st_mode_effective(sealed)
            assert _is_st_compat_mode(effective or "") is False, sealed

    def test_palink_native_passthrough(self):
        assert _st_mode_effective("palink-native") == "palink-native"

    def test_none_and_empty(self):
        assert _st_mode_effective(None) == ""
        assert _st_mode_effective("") == ""


class TestSealConsistency:
    """三处封存集合定义一致性守卫（防止将来只改一处导致漏封）。"""

    def test_seal_covers_all_legacy_modes(self):
        # 合法历史模式全集必须被封存集合完全覆盖（palink-native 除外）
        legacy = {"compat", "st-compat", "st-native"}
        assert SEALED_ST_MODES >= legacy

    def test_seal_does_not_touch_palink_native(self):
        assert "palink-native" not in SEALED_ST_MODES
        assert ST_COMPAT_MODES <= SEALED_ST_MODES, "ST_COMPAT_MODES 必须是封存集的子集，否则装配判定存在绕过"

    def test_seal_sets_identical_across_modules(self):
        # U-2 修复: users / silly_tavern 两 API 模块的 _SEALED_ST_MODES 独立字面量
        # 必须与装配层 SEALED_ST_MODES 完全一致——解封时漏改任一处即半封存
        from app.api.users import _SEALED_ST_MODES as _USERS_SEALED
        from app.api.silly_tavern import _SEALED_ST_MODES as _ST_SEALED

        assert _USERS_SEALED == _ST_SEALED == SEALED_ST_MODES


# ---------------------------------------------------------------------------
# [MODE-SEALED] U-3 封存机制端点级回归（spec §T-2）
# 现有守卫全是函数级；本组补 DB fixture 的 HTTP 端点级测试：
#   1) PUT 提交封存值 → 落库值被重定向为 palink-native
#   2) GET 对 DB 存量封存值报告 palink-native，且不回写 DB 原值
# 认证依赖复用仓库既有端点测试 fixture 模式（conftest 的 client/auth_headers，
# 内部 dependency_overrides 注入 get_current_user / get_db）。
# ---------------------------------------------------------------------------
class TestSealedModeEndpointRegression:
    """端点级封存回归：PUT 落库重定向 / GET 报告不回写。"""

    def _seed_st_mode(self, db_session, user, mode: str) -> None:
        """直接在 DB 造一个指定 silly_tavern_mode 的 user_settings 行。"""
        from app.models import UserSetting

        setting = db_session.query(UserSetting).filter(UserSetting.user_id == user.id).first()
        if not setting:
            setting = UserSetting(user_id=user.id, silly_tavern_mode=mode)
            db_session.add(setting)
        else:
            setting.silly_tavern_mode = mode
        db_session.commit()
        # 该测试 session expire_on_commit=False，强制失效身份映射，
        # 保证后续直查读到的是落库值而非内存对象缓存
        db_session.expire_all()

    def _clear_settings_cache(self) -> None:
        # GET 端点带 @cached(30s)，按 user id 键控；清空进程级缓存防止跨用例污染
        from app.core.cache import _cache

        _cache.clear()

    def test_put_sealed_mode_persists_as_palink_native(self, client, auth_headers, db_session, test_user):
        """场景 1（PUT 落库重定向）：DB 存量 st-compat → PUT 提交 st-native →
        直查 DB 断言落库值为 palink-native。"""
        self._clear_settings_cache()
        self._seed_st_mode(db_session, test_user, "st-compat")

        resp = client.put(
            "/api/users/me/settings",
            headers=auth_headers,
            json={"silly_tavern_mode": "st-native"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ok"

        # 直查 DB（绕过 API 归一化层）验证落库值
        db_session.expire_all()
        from app.models import UserSetting

        setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
        assert setting is not None
        assert setting.silly_tavern_mode == "palink-native", (
            f"PUT 提交封存值 st-native 应落库为 palink-native，实际落库: "
            f"{setting.silly_tavern_mode!r}"
        )

    def test_get_reports_palink_native_without_write_back(self, client, auth_headers, db_session, test_user):
        """场景 2（GET 报告重定向且不回写）：DB 存量保持 st-compat →
        GET 返回 palink-native → 再查 DB 原值未被改写。"""
        self._clear_settings_cache()
        self._seed_st_mode(db_session, test_user, "st-compat")

        resp = client.get("/api/users/me/settings", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["silly_tavern_mode"] == "palink-native", (
            f"GET 应把存量封存模式报告为 palink-native，实际返回: "
            f"{resp.json()['silly_tavern_mode']!r}"
        )

        # 可逆封存核心断言：GET 只改报告不改存储
        db_session.expire_all()
        from app.models import UserSetting

        setting = db_session.query(UserSetting).filter(UserSetting.user_id == test_user.id).first()
        assert setting is not None
        assert setting.silly_tavern_mode == "st-compat", (
            f"GET 不得回写 DB 存量值，实际被改写为: {setting.silly_tavern_mode!r}"
        )
