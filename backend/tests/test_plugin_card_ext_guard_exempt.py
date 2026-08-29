"""[GUARD-TH-EXEMPT] 卡内扩展作用域守卫的 tavern_helper 豁免回归。

背景：51991d6（8-23）将 [CARD-EXT-SCOPE-GUARD] 置于 runtime/config 装配循环首位，
source_type=character_card_extension 的插件全部拦停——「酒馆助手」（内含对话渲染/
数据库界面面板脚本）被误伤，正文下方角色面板静默消失 5 天（前端拿到空 plugins，
#bam-container 不再挂载）。2026-08-28 用户拍板豁免 tavern_helper 型插件：
用户显式启用的全局扩展语义（对齐 ST），泄漏面收敛到脚本级 plugin_scripts.enabled。

钉死语义：
1. tavern_helper + character_card_extension 来源 → runtime/config 照常下发（豁免生效）
2. 非 tavern_helper + character_card_extension 来源 → 维持拦截（守卫不松，防泄漏语义保持）

运行: python -m pytest tests/test_plugin_card_ext_guard_exempt.py -q
"""
from __future__ import annotations

import json

import pytest


@pytest.fixture()
def admin_client(client, db_session):
    """把 get_current_user 覆盖为 admin 用户，使 runtime/config 端点可用。"""
    from app.api.dependencies import get_current_user
    from app.core.security import get_password_hash
    from app.models import User

    admin = User(
        username="card_ext_guard_admin",
        hashed_password=get_password_hash("TestPassword1"),
        role="admin",
        is_active=True,
    )
    db_session.add(admin)
    db_session.commit()

    async def _override():
        return admin

    client.app.dependency_overrides[get_current_user] = _override
    yield client
    client.app.dependency_overrides.pop(get_current_user, None)
    # 测试表每例重建、自增 id 复用，残留的 user_id 键缓存会污染后续用例
    # （隔离测试的 user_a 可能与本文件 admin 同 id），teardown 必须清缓存。
    from app.api.plugins import _invalidate_runtime_config_cache

    _invalidate_runtime_config_cache()


def _add_card_extension_plugin(
    db_session,
    *,
    plugin_id: str,
    name: str,
    plugin_type: str,
    script_content: str | None = None,
):
    """按 7-30 卡内扩展导入的真实形态落库（source_type + config 标记双命中守卫判定）。"""
    from app.models.plugin import Plugin, PluginScript

    plugin = Plugin(
        id=plugin_id,
        name=name,
        plugin_type=plugin_type,
        enabled=True,
        source_type="character_card_extension",
        config=json.dumps({"character_card_extension": True, "global_runtime": False}),
    )
    db_session.add(plugin)
    if script_content is not None:
        db_session.add(
            PluginScript(
                plugin_id=plugin_id,
                script_name=f"{name}-脚本",
                script_type="script",
                enabled=True,
                content=script_content,
            )
        )
    db_session.commit()
    return plugin


def _get_runtime_plugin_names(client) -> set:
    from app.api.plugins import _invalidate_runtime_config_cache

    _invalidate_runtime_config_cache()
    resp = client.get("/api/plugins/runtime/config")
    assert resp.status_code == 200, resp.text
    return {p["name"] for p in resp.json()["plugins"]}


def test_tavern_helper_card_extension_plugin_is_delivered(admin_client, db_session):
    """豁免生效：tavern_helper 型卡内扩展来源插件正常下发（面板脚本可达前端）。"""
    _add_card_extension_plugin(
        db_session,
        plugin_id="th-guard-exempt-1",
        name="酒馆助手（守卫豁免测试）",
        plugin_type="tavern_helper",
        script_content="console.log('panel script');",
    )
    names = _get_runtime_plugin_names(admin_client)
    assert "酒馆助手（守卫豁免测试）" in names


def test_tavern_helper_scripts_synthesized_into_payload(admin_client, db_session):
    """下发 payload 携带脚本拼接入口（resources.js/index.js），前端沙箱可加载执行。"""
    _add_card_extension_plugin(
        db_session,
        plugin_id="th-guard-exempt-2",
        name="酒馆助手（payload 拼接测试）",
        plugin_type="tavern_helper",
        script_content="window.__panel_marker__ = true;",
    )
    from app.api.plugins import _invalidate_runtime_config_cache

    _invalidate_runtime_config_cache()
    resp = admin_client.get("/api/plugins/runtime/config")
    payload = next(
        p for p in resp.json()["plugins"] if p["name"] == "酒馆助手（payload 拼接测试）"
    )
    js_entries = (payload.get("resources") or {}).get("js") or []
    assert any(
        "window.__panel_marker__ = true;" in (e.get("content") or "") for e in js_entries
    )


def test_non_tavern_helper_card_extension_plugin_still_blocked(admin_client, db_session):
    """守卫不松：非 tavern_helper 的卡内扩展来源插件仍被拦截（防 @bubble 泄漏语义保持）。"""
    _add_card_extension_plugin(
        db_session,
        plugin_id="th-guard-blocked-1",
        name="BubbleDialogue 注入脚本（守卫保持测试）",
        plugin_type="regex_scripts",
        script_content=None,
    )
    names = _get_runtime_plugin_names(admin_client)
    assert not any("守卫保持测试" in n for n in names)
