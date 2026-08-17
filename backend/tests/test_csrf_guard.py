"""MED-4: ST 兼容端点 CSRF guard 验证。

验证点：
- 无 Authorization + 无 X-CSRF-Token 的写请求 → 403（跨站攻击场景被拦）；
- 带正确 X-CSRF-Token 的写请求 → guard 放行（进入后续认证层，非 403）；
- 带 Authorization: Bearer 的写请求 → 放行（Bearer 免疫 CSRF）；
- 安全方法（OPTIONS 预检）→ 不校验。
"""
from fastapi import status
from fastapi.testclient import TestClient


def test_csrf_guard_blocks_post_without_token(client: TestClient) -> None:
    resp = client.post("/api/settings/get")
    assert resp.status_code == status.HTTP_403_FORBIDDEN


def test_csrf_guard_allows_valid_token(client: TestClient) -> None:
    resp = client.post("/api/settings/get", headers={"X-CSRF-Token": "palink-csrf"})
    # guard 放行后进入认证层（无凭据 → 401/403），但不应是 CSRF 403
    assert resp.status_code != status.HTTP_403_FORBIDDEN


def test_csrf_guard_allows_bearer_auth(client: TestClient, auth_headers) -> None:
    resp = client.post("/api/settings/get", headers=auth_headers)
    assert resp.status_code == status.HTTP_200_OK


def test_csrf_guard_skips_safe_methods(client: TestClient) -> None:
    # OPTIONS 预检不带任何 token，guard 应放行（非 CSRF 403）
    resp = client.options("/api/settings/get")
    assert resp.status_code != status.HTTP_403_FORBIDDEN
