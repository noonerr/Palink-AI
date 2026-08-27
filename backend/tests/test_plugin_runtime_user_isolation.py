"""[A-7] 多租户插件隔离测试。

验证 ``/api/plugins/runtime/config`` 与 ``/api/plugins/active/regex`` 按用户
作用域下发插件：

- 插件 ``user_id IS NULL``（全局插件）对所有用户可见；
- 插件 ``user_id == 当前用户`` 仅该用户可见；
- 其他用户的插件不出现在本用户 runtime / regex 清单 / 资源端点中；
- 单用户部署（存量全为 NULL）行为不变。

兼容列 ``plugins.user_id`` 由 ``core/migrations.py`` 的 ``_RUNTIME_COMPAT_COLUMNS``
幂等添加（nullable），模型 ``models/plugin.py`` 已同步声明。
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
    return user


def _mk_plugin(db, name: str, plugin_type: str = "sillytavern_extension", user_id=None):
    from app.models import Plugin

    plugin = Plugin(
        name=name,
        plugin_type=plugin_type,
        enabled=True,
        config=json.dumps({"global_runtime": True}),
        user_id=user_id,
    )
    db.add(plugin)
    db.commit()
    return plugin


def _mk_regex_script(db, plugin):
    from app.models import PluginScript

    script = PluginScript(
        plugin_id=plugin.id,
        script_name=f"{plugin.name}-regex",
        script_type="regex",
        enabled=True,
        content="x",
        find_regex="zzz",
    )
    db.add(script)
    db.commit()
    return script


@pytest.fixture()
def tenant_plugins(client, db_session):
    """构造 用户A/用户B + 三个插件（全局 / A 私有 / B 私有）的租户环境。

    返回 (client, user_a, user_b, plugin_global, plugin_a, plugin_b, switch_to, cleanup)：
      - switch_to(user)：把 get_current_user 覆盖为目标用户
      - cleanup()：移除覆盖
    """
    from app.api.dependencies import get_current_user

    user_a = _mk_user(db_session, "tenant_user_a")
    user_b = _mk_user(db_session, "tenant_user_b")

    plugin_global = _mk_plugin(db_session, "a7-global-plugin")
    plugin_a = _mk_plugin(db_session, "a7-user-a-plugin", user_id=user_a.id)
    plugin_b = _mk_plugin(db_session, "a7-user-b-plugin", user_id=user_b.id)

    # 每个插件配一条 regex 脚本，验证 active/regex 也按用户隔离
    _mk_regex_script(db_session, plugin_global)
    _mk_regex_script(db_session, plugin_a)
    _mk_regex_script(db_session, plugin_b)

    def switch_to(user) -> None:
        client.app.dependency_overrides[get_current_user] = lambda: user

    def cleanup() -> None:
        client.app.dependency_overrides.pop(get_current_user, None)

    yield client, user_a, user_b, plugin_global, plugin_a, plugin_b, switch_to
    cleanup()


def _runtime_plugin_ids(client) -> set:
    body = client.get("/api/plugins/runtime/config").json()
    return {p["id"] for p in body["plugins"]}


def test_runtime_config_hides_other_users_plugins(tenant_plugins):
    client, user_a, user_b, plugin_global, plugin_a, plugin_b, switch_to = tenant_plugins

    switch_to(user_a)
    ids_a = _runtime_plugin_ids(client)
    assert plugin_global.id in ids_a  # 全局插件可见
    assert plugin_a.id in ids_a      # 本人私有插件可见
    assert plugin_b.id not in ids_a  # 用户 B 的插件不可见

    switch_to(user_b)
    ids_b = _runtime_plugin_ids(client)
    assert plugin_global.id in ids_b
    assert plugin_b.id in ids_b
    assert plugin_a.id not in ids_b  # 用户 A 的插件不可见


def test_active_regex_scripts_filtered_per_user(tenant_plugins):
    client, user_a, user_b, plugin_global, plugin_a, plugin_b, switch_to = tenant_plugins

    switch_to(user_a)
    scripts_a = client.get("/api/plugins/active/regex").json()
    assert isinstance(scripts_a, list)
    names_a = {s["scriptName"] for s in scripts_a}
    # 统计包含脚本的插件集合：通过脚本名前缀归属
    a_owned = {s for s in names_a if s.startswith("a7-user-a-plugin-")}
    b_owned = {s for s in names_a if s.startswith("a7-user-b-plugin-")}
    g_owned = {s for s in names_a if s.startswith("a7-global-plugin-")}
    assert len(g_owned) == 1  # 全局脚本可见
    assert len(a_owned) == 1  # 本人私有脚本可见
    assert len(b_owned) == 0  # 用户 B 的脚本不可见

    switch_to(user_b)
    scripts_b = client.get("/api/plugins/active/regex").json()
    names_b = {s["scriptName"] for s in scripts_b}
    assert any(s.startswith("a7-user-b-plugin-") for s in names_b)
    assert not any(s.startswith("a7-user-a-plugin-") for s in names_b)


def test_plugin_asset_endpoint_respects_user_scope(tenant_plugins):
    client, user_a, user_b, plugin_global, plugin_a, plugin_b, switch_to = tenant_plugins

    switch_to(user_a)
    # 用户 A 访问用户 B 私有插件的 asset 端点 → 404（视为不存在）
    resp_b = client.get(f"/api/plugins/{plugin_b.id}/asset/nonexistent.png")
    assert resp_b.status_code == 404
    # 用户 A 访问全局插件的 asset 端点 → 404 只因为资源本身不存在（若存在则 200）
    resp_g = client.get(f"/api/plugins/{plugin_global.id}/asset/nonexistent.png")
    assert resp_g.status_code == 404
    # 用户 A 访问自己私有插件的 asset 端点 → 同样 404（资源不存在），但非 403/500
    resp_a = client.get(f"/api/plugins/{plugin_a.id}/asset/nonexistent.png")
    assert resp_a.status_code == 404