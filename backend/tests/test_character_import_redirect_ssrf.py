"""PENTEST-2026-09-02 P1-3 修复回归：角色卡头像拉取的重定向逐跳 SSRF 复检。

修复前：_open_public_url 前身为裸 urlopen，首跳 URL 经 _is_public_http_url 校验，
但 301/302 跳转目标不复查——公网 URL 可被 302 跳板引向内网/云元数据
（TODOS 已登记的「_download_image 重定向 SSRF」同模式遗留）。
修复后：每跳复检 _is_public_http_url，非公网目标中止（ValueError，由调用方
except 捕获降级为"头像拉取失败"，不中断导入）。
"""

import os
import sys
import urllib.request

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.services.character_import_service import _PublicUrlRedirectHandler
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _redirect(target: str):
    """构造一次 302 重定向裁决调用（req/fp/code/msg/headers/newurl）。"""
    handler = _PublicUrlRedirectHandler()
    req = urllib.request.Request("http://example.com/avatar")
    return handler.redirect_request(
        req, None, 302, "Found", email_message_with_location(target), target
    )


def email_message_with_location(url: str):
    import email.message
    m = email.message.Message()
    m["Location"] = url
    return m


class TestPublicUrlRedirectHandler:
    def test_redirect_to_private_ip_blocked(self):
        with pytest.raises(ValueError):
            _redirect("http://169.254.169.254/latest/meta-data/")

    def test_redirect_to_loopback_blocked(self):
        with pytest.raises(ValueError):
            _redirect("http://127.0.0.1:8080/admin")

    def test_redirect_to_lan_hostname_blocked(self):
        with pytest.raises(ValueError):
            _redirect("http://192.168.1.10/internal")

    def test_redirect_to_public_url_allowed(self):
        new_req = _redirect("https://example.com/real-avatar.png")
        assert new_req is not None
        assert new_req.full_url == "https://example.com/real-avatar.png"

    def test_redirect_to_file_scheme_blocked(self):
        with pytest.raises(ValueError):
            _redirect("file:///etc/passwd")
