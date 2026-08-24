"""N-6 回归守卫：openai_compat service_key 分支的 X-Palink-User-Id HMAC 签名校验。

spec: docs/SPEC_安全加固第二批_N6_N7_N8_2026-08-24.md §1
缺陷: service_key 认证后按未签名 X-Palk-User-Id 头解析任意用户身份
→ SERVICE_KEY 泄漏 = 全站任意身份接管。

守卫语义（兼容式渐进升级）:
1. 带 X-Palink-User-Id 头时必须同时携带
   X-Palink-User-Sig: hex(hmac_sha256(key=SERVICE_KEY, msg=f"palink-user:{uid}"))
2. 签名不符/缺失 → 视为伪造，忽略该头并记 warning，落入无头回退路径
   （admin），不返回 403（不给探测信号）
3. 无头 → 维持回退 admin 现状（向后兼容直连调用）
4. 时序安全：verify_service_user_id 使用 hmac.compare_digest
"""

import asyncio
import inspect
import logging
import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from fastapi import Request

    from app.api.openai_compat import get_openai_compat_user
    from app.core import settings
    from app.core.security import (
        SERVICE_USER_MSG_PREFIX,
        sign_service_user_id,
        verify_service_user_id,
    )
    from app.models import User

    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

SERVICE_KEY_VALUE = "n6-unit-test-service-key"


def _make_request(headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/openai/v1/chat/completions",
        "headers": [
            (k.lower().encode("latin-1"), v.encode("latin-1"))
            for k, v in headers.items()
        ],
        "query_string": b"",
    }
    return Request(scope)


def _call(request: Request, db):
    return asyncio.run(get_openai_compat_user(request=request, db=db))


@pytest.fixture()
def n6_users(db_session):
    """admin（回退目标）+ 普通用户（签名解析目标）。"""
    from app.core.security import get_password_hash

    target = User(
        username="n6_target",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    admin = User(
        username="admin",
        hashed_password=get_password_hash("AdminPassword1"),
        role="admin",
        is_active=True,
    )
    db_session.add_all([target, admin])
    db_session.commit()
    db_session.refresh(target)
    db_session.refresh(admin)
    return target, admin


@pytest.fixture()
def n6_service_key(monkeypatch):
    monkeypatch.setattr(settings, "ST_NATIVE_SERVICE_KEY", SERVICE_KEY_VALUE)
    return SERVICE_KEY_VALUE


def test_correct_signature_resolves_scoped_user(db_session, n6_users, n6_service_key):
    """正确签名 → 身份解析成功（不再固定 admin）。"""
    target, _admin = n6_users
    headers = {
        "Authorization": f"Bearer {n6_service_key}",
        "X-Palink-User-Id": str(target.id),
        "X-Palink-User-Sig": sign_service_user_id(target.id),
    }
    user = _call(_make_request(headers), db_session)
    assert user.id == target.id
    assert user.username == "n6_target"


def test_wrong_signature_ignored_falls_back_to_admin(db_session, n6_users, n6_service_key, caplog):
    """错误签名 → 视为伪造忽略该头，落 admin 回退，且有 warning 日志；不 403。"""
    target, admin = n6_users
    headers = {
        "Authorization": f"Bearer {n6_service_key}",
        "X-Palink-User-Id": str(target.id),
        "X-Palink-User-Sig": "0" * 64,
    }
    with caplog.at_level(logging.WARNING, logger="app.api.openai_compat"):
        user = _call(_make_request(headers), db_session)
    assert user.id == admin.id
    assert user.username == "admin"
    assert any("forged X-Palink-User-Id" in r.message for r in caplog.records)


def test_missing_signature_with_header_falls_back_to_admin(db_session, n6_users, n6_service_key):
    """带头但缺签名 → 同样视为伪造，落 admin 回退。"""
    target, admin = n6_users
    headers = {
        "Authorization": f"Bearer {n6_service_key}",
        "X-Palink-User-Id": str(target.id),
    }
    user = _call(_make_request(headers), db_session)
    assert user.id == admin.id


def test_no_header_regression_falls_back_to_admin(db_session, n6_users, n6_service_key):
    """无头回归：维持原状回退 admin（向后兼容直连调用）。"""
    _target, admin = n6_users
    headers = {"Authorization": f"Bearer {n6_service_key}"}
    user = _call(_make_request(headers), db_session)
    assert user.id == admin.id


def test_verify_rejects_garbage_and_empty_sig(n6_service_key):
    """verify 对空/垃圾签名返回 False（不抛异常）。"""
    uid = 42
    assert verify_service_user_id(uid, sign_service_user_id(uid)) is True
    assert verify_service_user_id(uid, "") is False
    assert verify_service_user_id(uid, None) is False
    assert verify_service_user_id(uid, "deadbeef") is False
    # 换 uid 的签名不可复用
    assert verify_service_user_id(uid + 1, sign_service_user_id(uid)) is False


def test_sign_message_format_contract(n6_service_key):
    """签名消息格式契约: f"palink-user:{uid}" + hex hmac-sha256。"""
    import hashlib
    import hmac as hmac_mod

    expected = hmac_mod.new(
        n6_service_key.encode("utf-8"),
        f"{SERVICE_USER_MSG_PREFIX}7".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    assert sign_service_user_id(7) == expected
    assert len(expected) == 64


def test_compare_digest_is_used():
    """时序安全（代码审查项）：verify 必须经由 hmac.compare_digest 比较。"""
    from app.core import security as security_module

    src = inspect.getsource(security_module.verify_service_user_id)
    assert "compare_digest" in src
