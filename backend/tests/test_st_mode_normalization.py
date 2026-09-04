"""ST 模式字段 A1 收尾测试（2026-09-04：silly_tavern_mode/theme 列已 drop）。

演进史：2026-08-24 封存（MODE-SEALED）→ 2026-09-03 双轨代码删除（A2 死摆设）
→ 2026-09-04 字段全链删除（alembic 0062 drop 列）。

A1 契约：
  - GET /api/users/me/settings 响应不再包含 silly_tavern_mode / silly_tavern_theme 键
  - PUT 请求体携带这两个键时被 pydantic 忽略（200 OK，不落库、不报错）
  - UserSetting 模型不再有 silly_tavern_mode 属性
  - core/migrations.py 补列清单不含这两列（T1：回填会导致重启复活列）
"""
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api import users as users_api
    from app.api import silly_tavern as st_api
    from app.models import UserSetting
    from app.core import migrations as migrations_mod
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


class TestModelColumnDropped:
    """A1：模型与补列清单不再包含 silly_tavern_mode/theme。"""

    def test_user_setting_model_has_no_st_mode_column(self):
        """UserSetting 模型不应再有 silly_tavern_mode / silly_tavern_theme 列。"""
        cols = {c.name for c in UserSetting.__table__.columns}
        assert "silly_tavern_mode" not in cols, "silly_tavern_mode 列应已删除（alembic 0062）"
        assert "silly_tavern_theme" not in cols, "silly_tavern_theme 列应已删除（alembic 0062）"

    def test_runtime_compat_columns_not_backfilled(self):
        """T1 陷阱守卫：自动补列清单不得回填已删列（否则重启复活列）。"""
        names = {c[1] for c in migrations_mod._RUNTIME_COMPAT_COLUMNS}
        assert "silly_tavern_mode" not in names
        assert "silly_tavern_theme" not in names

    def test_normalize_function_removed(self):
        """_normalize_silly_tavern_mode 死函数应已从两个 API 模块移除。"""
        assert not hasattr(users_api, "_normalize_silly_tavern_mode")
        assert not hasattr(st_api, "_normalize_silly_tavern_mode")


# ---------------------------------------------------------------------------
# 端点级回归：GET 不再报告字段；PUT 携带旧键被静默忽略
# 认证依赖复用仓库既有端点测试 fixture 模式（conftest 的 client/auth_headers，
# 内部 dependency_overrides 注入 get_current_user / get_db）。
# ---------------------------------------------------------------------------
class TestA1EndpointContract:
    """A1 端点契约：字段从 API 形状中消失，旧客户端携带键不报错。"""

    def _clear_settings_cache(self) -> None:
        # GET 端点带 @cached(30s)，按 user id 键控；清空进程级缓存防止跨用例污染
        from app.core.cache import _cache

        _cache.clear()

    def test_get_settings_omits_st_mode_and_theme(self, client, auth_headers):
        """GET 响应不再包含 silly_tavern_mode / silly_tavern_theme 键。"""
        self._clear_settings_cache()
        resp = client.get("/api/users/me/settings", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "silly_tavern_mode" not in data
        assert "silly_tavern_theme" not in data

    def test_put_with_legacy_keys_is_ignored_not_error(self, client, auth_headers):
        """旧客户端 PUT 携带 silly_tavern_mode/theme 键：200 OK 且被 pydantic 忽略。"""
        self._clear_settings_cache()
        resp = client.put(
            "/api/users/me/settings",
            headers=auth_headers,
            json={"silly_tavern_mode": "st-native", "silly_tavern_theme": "dark"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "ok"
        # 响应同样不含这两个键
        assert "silly_tavern_mode" not in resp.json()
