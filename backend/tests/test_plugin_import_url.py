"""插件 URL 安装（POST /api/plugins/import-url）与 runtime/config 管理面模式测试。

覆盖：
- import-url 的 SSRF 防线（scheme/host 字符串校验、DNS 解析复检、重定向逐跳复检
  的口径同 3710837 头像拉取先例——本文件对下载函数打桩，不发真实网络请求）；
- 下载内容非 ZIP / 权限校验；
- GET /api/plugins/runtime/config 的 include_disabled 管理面模式：
  默认模式只回启用插件（智能卡消费方行为不变），include_disabled=1 回全部
  已安装插件并带 enabled 标志（admin-only），禁用插件不进执行面聚合。
"""
from __future__ import annotations

import io
import json
import socket
import zipfile

import pytest

from app.api.dependencies import get_admin, get_current_user


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _mk_admin(db, username: str = "plugin_url_admin"):
    from app.core.security import get_password_hash
    from app.models import User

    user = User(
        username=username,
        hashed_password=get_password_hash("TestPassword1"),
        role="admin",
        is_active=True,
    )
    db.add(user)
    db.commit()
    return user


def _mk_plugin(db, name: str, enabled: bool = True):
    from app.models import Plugin

    plugin = Plugin(
        name=name,
        plugin_type="sillytavern_extension",
        enabled=enabled,
        config=json.dumps({"global_runtime": True}),
    )
    db.add(plugin)
    db.commit()
    return plugin


@pytest.fixture()
def admin_client(client, db_session):
    """把 get_admin / get_current_user 都覆盖为管理员。"""
    admin = _mk_admin(db_session)
    client.app.dependency_overrides[get_admin] = lambda: admin
    client.app.dependency_overrides[get_current_user] = lambda: admin
    yield client
    client.app.dependency_overrides.pop(get_admin, None)
    client.app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture(autouse=True)
def _clean_runtime_config_cache():
    """runtime/config 带 30s 进程级内存缓存（键含 user_id）。

    测试库每个用例重建、user_id 从 1 重新计数，跨用例的缓存残留会把上个
    用例的响应漏给下个用例（曾污染 test_plugin_runtime_user_isolation）。
    每个用例前后各清一次本前缀缓存。
    """
    from app.api.plugins import _RUNTIME_CONFIG_CACHE_PREFIX
    from app.core.cache import invalidate_cache

    invalidate_cache(_RUNTIME_CONFIG_CACHE_PREFIX)
    yield
    invalidate_cache(_RUNTIME_CONFIG_CACHE_PREFIX)


def _make_extension_zip(manifest: dict | None = None) -> bytes:
    """构造最小合法的 ST 扩展 ZIP（manifest.json + index.js）。"""
    mf = manifest or {
        "name": "url-install-ext",
        "display_name": "URL Install Ext",
        "version": "1.0.0",
        "js": "index.js",
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(mf))
        zf.writestr("index.js", "console.log('hi');")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# import-url：SSRF 防线与权限
# ---------------------------------------------------------------------------
class TestImportUrlSsrf:
    def test_rejects_loopback_url(self, admin_client):
        resp = admin_client.post(
            "/api/plugins/import-url", json={"url": "http://127.0.0.1:8080/ext.zip"}
        )
        assert resp.status_code == 400

    def test_rejects_private_ip_url(self, admin_client):
        resp = admin_client.post(
            "/api/plugins/import-url", json={"url": "http://192.168.1.5/ext.zip"}
        )
        assert resp.status_code == 400

    def test_rejects_link_local_metadata_url(self, admin_client):
        resp = admin_client.post(
            "/api/plugins/import-url",
            json={"url": "http://169.254.169.254/latest/meta-data/"},
        )
        assert resp.status_code == 400

    def test_rejects_non_http_scheme(self, admin_client):
        resp = admin_client.post(
            "/api/plugins/import-url", json={"url": "ftp://example.com/ext.zip"}
        )
        assert resp.status_code == 400

    def test_rejects_empty_url(self, admin_client):
        resp = admin_client.post("/api/plugins/import-url", json={"url": "  "})
        assert resp.status_code == 400

    def test_rejects_dns_resolving_to_private_ip(self, admin_client, monkeypatch):
        """域名看起来公网、但解析到内网 → 拒绝（防 DNS rebinding 跳板）。

        _is_public_http_url 自带 DNS 解析复检（utils.py），解析结果含私网地址
        即整体判非公网。
        """

        def _fake_getaddrinfo(host, port=None, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 0))]

        monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo)
        resp = admin_client.post(
            "/api/plugins/import-url", json={"url": "http://evil.example.com/ext.zip"}
        )
        assert resp.status_code == 400
        assert "公网" in resp.json()["detail"]

    def test_requires_admin(self, client):
        """默认 conftest 用户为普通用户 → 403。"""
        resp = client.post(
            "/api/plugins/import-url", json={"url": "http://example.com/ext.zip"}
        )
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# import-url：下载与入库
# ---------------------------------------------------------------------------
class TestImportUrlDownload:
    def test_imports_valid_zip(self, admin_client, db_session, monkeypatch):
        from app.api import plugins as plugins_module

        monkeypatch.setattr(
            plugins_module, "_download_public_zip", lambda url: _make_extension_zip()
        )
        resp = admin_client.post(
            "/api/plugins/import-url",
            json={"url": "https://github.com/x/y/releases/download/v1/url-install-ext.zip"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["plugin"]["name"] == "URL Install Ext"
        assert body["plugin"]["enabled"] is True
        row = (
            db_session.query(plugins_module.Plugin)
            .filter(plugins_module.Plugin.name == "URL Install Ext")
            .first()
        )
        assert row is not None

    def test_rejects_non_zip_content(self, admin_client, monkeypatch):
        from app.api import plugins as plugins_module

        monkeypatch.setattr(
            plugins_module, "_download_public_zip", lambda url: b"<html>not a zip</html>"
        )
        resp = admin_client.post(
            "/api/plugins/import-url", json={"url": "https://github.com/x/y"}
        )
        assert resp.status_code == 400
        assert "压缩包" in resp.json()["detail"]

    def test_download_http_error_maps_to_400(self, admin_client, monkeypatch):
        import urllib.error

        from app.api import plugins as plugins_module

        def _raise(url):
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        monkeypatch.setattr(plugins_module, "_download_public_zip", _raise)
        resp = admin_client.post(
            "/api/plugins/import-url", json={"url": "https://example.com/missing.zip"}
        )
        assert resp.status_code == 400
        assert "404" in resp.json()["detail"]

    def test_redirect_to_private_blocked(self, admin_client, monkeypatch):
        """重定向逐跳复检：公网首跳 302 到内网 → _PluginUrlRedirectHandler
        抛 ValueError → 端点映射 400。"""
        from app.api import plugins as plugins_module

        def _raise(url):
            raise ValueError("Redirect to non-public URL blocked: http://10.0.0.8/ext.zip")

        monkeypatch.setattr(plugins_module, "_download_public_zip", _raise)
        resp = admin_client.post(
            "/api/plugins/import-url", json={"url": "https://example.com/ext.zip"}
        )
        assert resp.status_code == 400
        assert "non-public" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# runtime/config 的 include_disabled 管理面模式
# ---------------------------------------------------------------------------
class TestRuntimeConfigIncludeDisabled:
    def test_default_mode_returns_enabled_only(self, admin_client, db_session):
        _mk_plugin(db_session, "rc-enabled-plugin", enabled=True)
        _mk_plugin(db_session, "rc-disabled-plugin", enabled=False)
        resp = admin_client.get("/api/plugins/runtime/config")
        assert resp.status_code == 200
        names = [p["name"] for p in resp.json()["plugins"]]
        assert "rc-enabled-plugin" in names
        assert "rc-disabled-plugin" not in names

    def test_include_disabled_returns_all_with_flag(self, admin_client, db_session):
        _mk_plugin(db_session, "rc2-enabled-plugin", enabled=True)
        _mk_plugin(db_session, "rc2-disabled-plugin", enabled=False)
        resp = admin_client.get("/api/plugins/runtime/config?include_disabled=1")
        assert resp.status_code == 200
        by_name = {p["name"]: p for p in resp.json()["plugins"]}
        assert by_name["rc2-enabled-plugin"]["enabled"] is True
        assert by_name["rc2-disabled-plugin"]["enabled"] is False

    def test_include_disabled_requires_admin(self, client, db_session):
        """默认 conftest 用户为普通用户 → include_disabled 模式 403。"""
        _mk_plugin(db_session, "rc3-plugin", enabled=False)
        resp = client.get("/api/plugins/runtime/config?include_disabled=1")
        assert resp.status_code == 403
        # 普通用户的默认模式不受影响
        resp2 = client.get("/api/plugins/runtime/config")
        assert resp2.status_code == 200
