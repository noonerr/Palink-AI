"""Phase 7 SubTask 7.1 回归测试：user_settings 缓存失效 bug。

背景：
- ``get_user_settings`` 使用 ``@cached(ttl_seconds=30, key_prefix="user_settings")``
- FastAPI 调用 endpoint 时所有 ``Depends()`` 参数通过 ``**kwargs`` 传入
- ``cache.py:_build_key`` 的 kwargs 循环使用 ``f"{k}={v.id}"`` 格式
  → 实际缓存 key 形如 ``"user_settings:user=1"``
- 修复前：``invalidate_cache(f"user_settings:{user.id}")`` 生成 prefix
  ``"user_settings:1"``，``k.startswith("user_settings:1")`` 对
  ``"user_settings:user=1"`` 返回 False，**失效无效**
- 修复后：``invalidate_cache(f"user_settings:user={user.id}")`` 生成 prefix
  ``"user_settings:user=1"``，与缓存 key 完全匹配，失效生效

本测试：
1. 清空进程级 TTLCache（避免其他测试残留污染）
2. GET /api/users/me/settings —— 触发缓存写入（默认值）
3. PUT /api/users/me/settings —— 更新 author_note
4. GET /api/users/me/settings —— 必须返回新值（缓存失效成功）

修复前预期：第 4 步返回旧值（缓存未失效），测试 FAIL
修复后预期：第 4 步返回新值，测试 PASS
"""
from __future__ import annotations


def test_user_settings_cache_invalidated_after_put(client, auth_headers):
    """PUT 后立即 GET 必须返回新值，证明缓存被正确失效。"""
    # 1. 清空进程级缓存，确保起始状态干净
    from app.core.cache import _cache
    _cache.clear()

    # 2. 首次 GET：触发缓存写入默认值
    resp1 = client.get("/api/users/me/settings", headers=auth_headers)
    assert resp1.status_code == 200, f"GET 1 failed: {resp1.status_code} {resp1.text}"
    body1 = resp1.json()
    assert "author_note" in body1, f"unexpected body: {body1}"

    # 3. PUT：更新 author_note 为新值
    marker = "phase7-cache-test-marker"
    resp_put = client.put(
        "/api/users/me/settings",
        headers=auth_headers,
        json={"author_note": marker},
    )
    assert resp_put.status_code == 200, f"PUT failed: {resp_put.status_code} {resp_put.text}"

    # 4. 第二次 GET：必须返回新值（缓存失效成功）
    resp2 = client.get("/api/users/me/settings", headers=auth_headers)
    assert resp2.status_code == 200, f"GET 2 failed: {resp2.status_code} {resp2.text}"
    body2 = resp2.json()

    # 关键断言：author_note 必须是新写入的值，而不是缓存中的旧值
    assert body2["author_note"] == marker, (
        f"Cache invalidation FAILED: expected author_note={marker!r}, "
        f"got {body2['author_note']!r} (stale cached value). "
        f"This indicates invalidate_cache() prefix does not match "
        f"the actual cache key built by _build_key()."
    )


def test_user_settings_cache_key_format_matches_invalidation(client, auth_headers):
    """验证缓存 key 格式与失效 prefix 完全匹配。

    通过直接调用 _build_key 验证：当 user 通过 kwargs 传入时，
    缓存 key 形如 "user_settings:user=<id>"，所以 invalidate_cache
    必须使用 "user_settings:user=<id>" 作为 prefix。
    """
    from app.core.cache import _build_key, _cache
    from app.models import User

    _cache.clear()

    # 模拟 FastAPI 调用 get_user_settings 时的 kwargs 传参方式
    # （FastAPI 把 Depends() 解析后通过 **kwargs 调用 endpoint）
    fake_user = User(id=99999, username="cache_key_probe", hashed_password="x", role="user", is_active=True)

    # kwargs 形式：user 与 db 都通过 kwargs 传入
    key_via_kwargs = _build_key(
        "user_settings",
        get_user_settings_dummy,
        args=(),
        kwargs={"user": fake_user, "db": None},
    )
    # 期望：缓存 key 以 "user_settings:user=99999" 开头（kwargs 路径加 "user=" 前缀）
    assert key_via_kwargs.startswith("user_settings:user=99999"), (
        f"Cache key via kwargs does not match expected format. "
        f"Got: {key_via_kwargs!r}"
    )

    # 验证：使用 "user_settings:user=99999" 作为 prefix 能匹配
    # 而使用 "user_settings:99999"（修复前的 bug 写法）不能匹配
    assert key_via_kwargs.startswith("user_settings:user=99999"), "prefix match should succeed"
    assert not key_via_kwargs.startswith("user_settings:99999"), (
        f"Bug repro: 'user_settings:99999' should NOT match cache key "
        f"'{key_via_kwargs}' because the kwargs-built key has 'user=' prefix"
    )


# 占位 dummy function（_build_key 需要 func 参数取 __name__）
async def get_user_settings_dummy():
    pass
