"""ST 模式归一化测试（st-compat/st-native 双轨删除后，A2 死字段口径）。

2026-09 st-compat/st-native 双轨已删除，silly_tavern_mode 字段保留为纯摆设：
  - 两个 API 模块的 _normalize_silly_tavern_mode 对任意输入恒返回 "palink-native"
  - PUT 落库与 GET 报告均收敛为 palink-native

历史守卫契约（SEALED_ST_MODES/_st_mode_effective/_is_st_compat_mode 等
函数级测试）随对应符号删除，不再保留。
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
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class TestNormalizeAlwaysPalinkNative:
    """A2 死字段口径：任意输入一律归一为 palink-native。"""

    @pytest.mark.parametrize("mode", [
        "st-compat", "compat", "st-native", "iframe", "native",
        "palink-native", "classic", "", None, "ST-COMPAT", " Compat ",
    ])
    def test_normalize_returns_palink_native(self, mode):
        assert _normalize_users(mode) == "palink-native"
        assert _normalize_st(mode) == "palink-native"


# ---------------------------------------------------------------------------
# 端点级回归：PUT 落库 / GET 报告在 A2 口径下均收敛为 palink-native
# 认证依赖复用仓库既有端点测试 fixture 模式（conftest 的 client/auth_headers，
# 内部 dependency_overrides 注入 get_current_user / get_db）。
# ---------------------------------------------------------------------------
class TestSealedModeEndpointRegression:
    """端点级回归：PUT 落库收敛 / GET 报告收敛，且 GET 不回写 DB 存量值。"""

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
        """场景 1（PUT 落库收敛）：DB 存量 st-compat → PUT 提交 st-native →
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
            f"PUT 提交 st-native 应落库为 palink-native，实际落库: "
            f"{setting.silly_tavern_mode!r}"
        )

    def test_get_reports_palink_native_without_write_back(self, client, auth_headers, db_session, test_user):
        """场景 2（GET 报告收敛且不回写）：DB 存量保持 st-compat →
        GET 返回 palink-native → 再查 DB 原值未被改写。"""
        self._clear_settings_cache()
        self._seed_st_mode(db_session, test_user, "st-compat")

        resp = client.get("/api/users/me/settings", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["silly_tavern_mode"] == "palink-native", (
            f"GET 应把存量值报告为 palink-native，实际返回: "
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
