"""N-7 回归守卫：附件 URL 去主 JWT 化（upload-scope 短时效令牌）。

spec: docs/SPEC_安全加固第二批_N6_N7_N8_2026-08-24.md §2
缺陷: 主 JWT 出现在附件 URL query（12 处拼接 + MarkdownRenderer <a href>），
浏览器历史/日志/分享链接中的 URL 即为长效凭据。

守卫语义:
1. POST /api/uploads/token（认证后）签发 {sub, scope:"upload", exp:now+300}
   专用短令牌——不放长效 exp
2. _verify_upload_access 强制 payload.scope == "upload"：
   upload 令牌过 / 主 JWT（无 scope）401 / 黑名单令牌 401（N-14 回归）
"""

import asyncio
import os
import sys
import time

import jwt as pyjwt
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from fastapi import HTTPException, Request

    from app.core import settings
    from app.core.security import (
        UPLOAD_TOKEN_TTL_SECONDS,
        create_access_token,
        create_upload_token,
    )
    from app.core.token_blacklist import add_to_blacklist
    from app.models import User

    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _make_request(headers: dict[str, str] | None = None) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/uploads/n7.png",
        "headers": [
            (k.lower().encode("latin-1"), v.encode("latin-1"))
            for k, v in (headers or {}).items()
        ],
        "query_string": b"",
    }
    return Request(scope)


def _call_verify(token: str | None, monkeypatch, db_session):
    """直接调用 main._verify_upload_access，SessionLocal 指向测试会话。"""
    import app.main as main_module
    from sqlalchemy.orm import Session

    def _session_factory():
        return Session(bind=db_session.get_bind())

    monkeypatch.setattr(main_module, "SessionLocal", _session_factory)
    request = _make_request()
    return asyncio.run(main_module._verify_upload_access(request, token=token))


@pytest.fixture()
def n7_user(db_session):
    from app.core.security import get_password_hash

    user = User(
        username="n7_uploader",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def test_create_upload_token_claims(n7_user):
    """解码断言 scope/exp：仅 {sub, scope:"upload", 短效 exp}，无长效字段。"""
    token = create_upload_token(n7_user.username)
    payload = pyjwt.decode(
        token,
        settings.SECRET_KEY,
        algorithms=["HS256"],
        options={"verify_signature": True},
    )
    assert payload["scope"] == "upload"
    assert payload["sub"] == n7_user.username
    remaining = payload["exp"] - time.time()
    assert 0 < remaining <= UPLOAD_TOKEN_TTL_SECONDS
    # 不放长效 exp 相关 claim；jti 亦无需（5 分钟自然过期）
    assert "jti" not in payload


def test_token_endpoint_returns_upload_scope_token(client, test_user):
    """POST /api/uploads/token 认证后返回可解码的 upload-scope 短令牌。

    注：client 夹具将 get_current_user 覆盖为返回 test_user，故断言
    sub 与 test_user 对齐（验证的是端点→签发→claims 管线）。
    """
    resp = client.post("/api/uploads/token", headers={"Authorization": "Bearer x"})
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) >= {"token", "expires_in"}
    assert data["expires_in"] == UPLOAD_TOKEN_TTL_SECONDS
    payload = pyjwt.decode(
        data["token"],
        settings.SECRET_KEY,
        algorithms=["HS256"],
        options={"verify_signature": True},
    )
    assert payload["scope"] == "upload"
    assert payload["sub"] == test_user.username


def test_verify_accepts_upload_scope_token(monkeypatch, db_session, n7_user):
    """三态之一：upload 令牌 → 通过并解析到对应用户。"""
    user = _call_verify(create_upload_token(n7_user.username), monkeypatch, db_session)
    assert user.id == n7_user.id
    assert user.username == n7_user.username


def test_verify_rejects_main_jwt_without_scope(monkeypatch, db_session, n7_user):
    """三态之二：主 JWT（无 scope claim）→ 401，不再可作为附件凭据。"""
    main_jwt = create_access_token({"sub": n7_user.username})
    with pytest.raises(HTTPException) as exc_info:
        _call_verify(main_jwt, monkeypatch, db_session)
    assert exc_info.value.status_code == 401


def test_verify_rejects_blacklisted_upload_token(monkeypatch, db_session, n7_user):
    """三态之三（N-14 回归）：带 jti 且被拉黑的 upload 令牌 → 401。"""
    expires_at = int(time.time()) + 300
    token = pyjwt.encode(
        {
            "sub": n7_user.username,
            "scope": "upload",
            "exp": expires_at,
            "jti": "n7-blacklisted-jti",
        },
        settings.SECRET_KEY,
        algorithm="HS256",
    )
    add_to_blacklist("n7-blacklisted-jti", float(expires_at))
    with pytest.raises(HTTPException) as exc_info:
        _call_verify(token, monkeypatch, db_session)
    assert exc_info.value.status_code == 401


def test_verify_rejects_garbage_token(monkeypatch, db_session):
    """垃圾/过期令牌 → 401。"""
    with pytest.raises(HTTPException) as exc_info:
        _call_verify("not-a-jwt", monkeypatch, db_session)
    assert exc_info.value.status_code == 401


def test_main_jwt_query_via_http_is_401(client, n7_user):
    """HTTP 层回归：主 JWT 拼 query 访问附件端点 → 401（scope 检查在查库前生效）。"""
    main_jwt = create_access_token({"sub": n7_user.username})
    resp = client.get(f"/api/uploads/some.png?token={main_jwt}")
    assert resp.status_code == 401
