"""批次R1（2026-10-21）· 插件启停的作用域边界。

改前 `PUT /api/plugins/{id}/toggle` 是 `get_admin` + 只按 id 查库：
管理员可以切到**别人**的私有插件，且普通用户连自己的插件都切不了。
本文件钉住收紧后的口径（与 runtime/config / asset / source 三处既有作用域过滤对齐）：

  - 本人私有插件（user_id == 当前用户）⇒ 允许；
  - 全局插件（user_id IS NULL）⇒ 仅管理员允许（ST 的全局扩展是共享状态）；
  - 他人私有插件 ⇒ 404（不暴露"这个 id 存在"）。

同时钉住 runtime/config 新下发的 `owner_scope` 位 —— 帧内 getExtensionType 的
local/global 判据（全局 = user_id NULL，本地 = 当前用户私有）。
"""
from __future__ import annotations

import json

import pytest


def _mk_user(db, username: str, role: str = "user"):
    from app.core.security import get_password_hash
    from app.models import User

    user = User(
        username=username,
        hashed_password=get_password_hash("TestPassword1"),
        role=role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _mk_plugin(db, name: str, user_id=None, enabled: bool = True):
    from app.models import Plugin

    plugin = Plugin(
        name=name,
        plugin_type="sillytavern_extension",
        enabled=enabled,
        config=json.dumps({"global_runtime": True}),
        user_id=user_id,
    )
    db.add(plugin)
    db.commit()
    db.refresh(plugin)
    return plugin


def _enabled(db, plugin) -> bool:
    from app.models import Plugin

    db.expire_all()
    row = db.query(Plugin).filter(Plugin.id == plugin.id).first()
    assert row is not None
    return bool(row.enabled)


@pytest.fixture()
def plugin_scope_env(client, db_session):
    """管理员 / 用户A / 用户B + 全局插件 + 各自的私有插件。"""
    from app.api.dependencies import get_current_user

    admin = _mk_user(db_session, "r1_admin", role="admin")
    user_a = _mk_user(db_session, "r1_user_a")
    user_b = _mk_user(db_session, "r1_user_b")

    plugin_global = _mk_plugin(db_session, "r1-global-plugin")
    plugin_admin = _mk_plugin(db_session, "r1-admin-plugin", user_id=admin.id)
    plugin_a = _mk_plugin(db_session, "r1-user-a-plugin", user_id=user_a.id)
    plugin_b = _mk_plugin(db_session, "r1-user-b-plugin", user_id=user_b.id)

    # [批次R1 主脑补 2026-10-21] `runtime/config` 有 30s 内存缓存（按 user_id 入键，
    # 见 plugins.py 的 `_build_sillytavern_runtime_config`）。本 fixture 直接写库、不经 API，
    # 不会触发 `_invalidate_runtime_config_cache()` ⇒ 全量跑时若前面的用例已缓存过同一
    # user_id 的快照，这里就会读到"没有这些插件 / 没有 owner_scope"的旧值。
    # 单跑绿、全量红就是这么来的（主脑实测：单跑 6 passed，全量 1 failed）。
    from app.api.plugins import _invalidate_runtime_config_cache
    _invalidate_runtime_config_cache()

    def switch_to(user) -> None:
        client.app.dependency_overrides[get_current_user] = lambda: user

    yield (
        client, db_session, admin, user_a, user_b,
        plugin_global, plugin_admin, plugin_a, plugin_b, switch_to,
    )

    client.app.dependency_overrides.pop(get_current_user, None)
    # 收尾也清一次：别把本用例的 payload 留给后面的用例（缓存是按 user_id 入键的，
    # 但 fixture 每轮会新建用户，留着也只会占内存）。
    from app.api.plugins import _invalidate_runtime_config_cache as _drop_rt_cache
    _drop_rt_cache()


def test_runtime_config_exposes_owner_scope(plugin_scope_env):
    """runtime/config 必须下发 owner_scope：全局 vs 本人私有分得开。"""
    client, _db, _admin, user_a, _user_b, plugin_global, _plugin_admin, plugin_a, _plugin_b, switch_to = plugin_scope_env

    switch_to(user_a)
    body = client.get("/api/plugins/runtime/config").json()
    by_id = {item["id"]: item for item in body["plugins"]}

    assert by_id[plugin_global.id]["owner_scope"] == "global"
    assert by_id[plugin_a.id]["owner_scope"] == "local"
    # 他人插件不出现在本人的 runtime config 里（既有 A-7 隔离不变）
    assert all(item["id"] != "r1-user-b-plugin" for item in body["plugins"])


def test_toggle_own_plugin_is_allowed_for_regular_user(plugin_scope_env):
    """普通用户能启停自己的私有插件（ST 语义：local 扩展由本人控制）。"""
    client, db, _admin, user_a, _user_b, _plugin_global, _plugin_admin, plugin_a, _plugin_b, switch_to = plugin_scope_env

    switch_to(user_a)
    resp = client.put(f"/api/plugins/{plugin_a.id}/toggle")
    assert resp.status_code == 200, resp.text
    assert resp.json()["enabled"] is False
    assert _enabled(db, plugin_a) is False

    resp_back = client.put(f"/api/plugins/{plugin_a.id}/toggle")
    assert resp_back.status_code == 200, resp_back.text
    assert resp_back.json()["enabled"] is True
    assert _enabled(db, plugin_a) is True


def test_toggle_global_plugin_requires_admin(plugin_scope_env):
    """全局插件是共享状态：普通用户切 => 403，且状态不变；管理员切 => 200。"""
    client, db, admin, user_a, _user_b, plugin_global, _plugin_admin, _plugin_a, _plugin_b, switch_to = plugin_scope_env

    switch_to(user_a)
    resp = client.put(f"/api/plugins/{plugin_global.id}/toggle")
    assert resp.status_code == 403, resp.text
    assert _enabled(db, plugin_global) is True

    switch_to(admin)
    resp_admin = client.put(f"/api/plugins/{plugin_global.id}/toggle")
    assert resp_admin.status_code == 200, resp_admin.text
    assert resp_admin.json()["enabled"] is False
    assert _enabled(db, plugin_global) is False


def test_toggle_other_users_private_plugin_is_404(plugin_scope_env):
    """他人私有插件 => 404（不暴露 id 是否存在），且状态不变 —— 管理员也不例外。"""
    client, db, admin, user_a, _user_b, _plugin_global, _plugin_admin, _plugin_a, plugin_b, switch_to = plugin_scope_env

    switch_to(user_a)
    resp = client.put(f"/api/plugins/{plugin_b.id}/toggle")
    assert resp.status_code == 404, resp.text
    assert _enabled(db, plugin_b) is True

    switch_to(admin)
    resp_admin = client.put(f"/api/plugins/{plugin_b.id}/toggle")
    assert resp_admin.status_code == 404, resp_admin.text
    assert _enabled(db, plugin_b) is True


def test_toggle_admin_own_plugin_is_allowed(plugin_scope_env):
    client, db, admin, _user_a, _user_b, _plugin_global, plugin_admin, _plugin_a, _plugin_b, switch_to = plugin_scope_env

    switch_to(admin)
    resp = client.put(f"/api/plugins/{plugin_admin.id}/toggle")
    assert resp.status_code == 200, resp.text
    assert resp.json()["enabled"] is False
    assert _enabled(db, plugin_admin) is False


def test_toggle_missing_plugin_is_404(plugin_scope_env):
    client, _db, _admin, user_a, _user_b, _plugin_global, _plugin_admin, _plugin_a, _plugin_b, switch_to = plugin_scope_env
    switch_to(user_a)
    resp = client.put("/api/plugins/does-not-exist/toggle")
    assert resp.status_code == 404, resp.text
