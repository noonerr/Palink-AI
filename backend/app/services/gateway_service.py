"""New API / One API 网关探测与对账（P2-3，SPEC_model_gateway_new_api.md §4）。

旁路服务：不进推理链路、无常驻任务、无新表。所有对外请求惰性触发 + 内存 TTL 缓存：
- 探测结果缓存 5 分钟（管理员打开模型管理页才探测）
- 对账结果缓存 60 秒（管理员打开对账面板才拉取）

外网兼容：一切以 provider 的 ``base_url`` 推导（去掉 ``/v1`` 后缀即网关根），
不区分内网容器名 / 公网域名 / https；``admin_url`` 字段仅在网关后台与 API
端点不同源时用于覆盖。

指纹依据（2026-09-02 实测 v1.0.0-rc.30）：
- ``GET {root}/api/status`` 公开返回 ``data.version`` + one-api 系特有字段组
- 管理 API 鉴权：``POST /api/user/login``（JSON）→ ``data.access_token``，
  后续管理端点用 ``Authorization: Bearer <access_token>``（rc.30 起不再依赖会话 Cookie）
- ``GET /api/log/`` 分页参数是 ``p``（不是 ``page``），``page_size`` 上限 100
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

# ─── 常量 ────────────────────────────────────────────────────────────────────

DETECT_TIMEOUT_SECONDS = 4.0
DETECT_CACHE_TTL_SECONDS = 300
LEDGER_CACHE_TTL_SECONDS = 60
LEDGER_MAX_PAGES = 20          # page_size=100 → 单窗口最多统计 2000 条，超出标记 truncated
LEDGER_PAGE_SIZE = 100
LOG_TYPE_CONSUME = 2           # model/log.go：1=topup 2=consume 3=manage 4=system 5=error...

# one-api / new-api 系 /api/status 特有字段，命中 ≥2 视为该系网关
_STATUS_FINGERPRINT_FIELDS = (
    "docs_link",
    "quota_per_unit",
    "start_time",
    "system_name",
    "data_export_default_time",
    "enable_data_export",
    "setup",
)


class GatewayAuthError(Exception):
    """网关管理凭据登录失败（含 2FA 拦截），message 面向管理员展示。"""


# ─── 简易 TTL 缓存（照 provider_registry 的模块级缓存先例） ─────────────────

class _TTLCache:
    def __init__(self, ttl_seconds: int) -> None:
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._data: Dict[str, Tuple[float, Any]] = {}

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            hit = self._data.get(key)
            if not hit:
                return None
            expire_at, value = hit
            if time.monotonic() >= expire_at:
                self._data.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = (time.monotonic() + self._ttl, value)


_detect_cache = _TTLCache(DETECT_CACHE_TTL_SECONDS)
_ledger_cache = _TTLCache(LEDGER_CACHE_TTL_SECONDS)
_access_token_cache = _TTLCache(3600)  # 实际过期以 access_expires_at 为准，见 admin_login


def clear_gateway_caches() -> None:
    """测试与排障用：清空全部内存缓存。"""
    _detect_cache._data.clear()
    _ledger_cache._data.clear()
    _access_token_cache._data.clear()


# ─── URL 帮手 ────────────────────────────────────────────────────────────────

def gateway_root_from_base_url(base_url: str) -> str:
    """``http://host:3000/v1`` → ``http://host:3000``；无 /v1 后缀则原样（去尾斜杠）。"""
    root = (base_url or "").strip().rstrip("/")
    if root.endswith("/v1"):
        root = root[: -len("/v1")]
    return root


def _normalize_admin_url(admin_url: Optional[str], base_url: str) -> str:
    root = gateway_root_from_base_url(base_url)
    override = (admin_url or "").strip().rstrip("/")
    return override or root


# ─── HTTP 薄包装（测试 monkeypatch 点） ──────────────────────────────────────

async def _http_get_json(url: str, *, headers: Optional[Dict[str, str]] = None,
                         params: Optional[Dict[str, Any]] = None,
                         timeout: float = DETECT_TIMEOUT_SECONDS) -> Any:
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
        resp = await client.get(url, headers=headers, params=params)
        resp.raise_for_status()
        return resp.json()


async def _http_post_json(url: str, *, payload: Dict[str, Any],
                          timeout: float = 10.0) -> Any:
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()


# ─── 指纹探测 ────────────────────────────────────────────────────────────────

async def detect_gateway(base_url: str, admin_url_override: Optional[str] = None,
                         timeout: float = DETECT_TIMEOUT_SECONDS) -> Optional[Dict[str, Any]]:
    """探测 base_url 是否指向 one-api/new-api 系网关。

    返回 ``{"flavor", "version", "system_name", "admin_url"}``；非网关 / 不可达
    / 超时一律返回 None（调用方无需区分失败原因）。
    """
    if not (base_url or "").strip():
        return None
    root = gateway_root_from_base_url(base_url)
    try:
        payload = await _http_get_json(f"{root}/api/status", timeout=timeout)
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("success") is not True:
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    version = str(data.get("version") or "").strip()
    if not version:
        return None
    hits = sum(1 for field in _STATUS_FINGERPRINT_FIELDS if data.get(field) not in (None, ""))
    if hits < 2:
        return None

    flavor = "one-api"
    if version.startswith("v1.") or "newapi" in str(data.get("docs_link") or "").lower():
        flavor = "new-api"

    admin_url = _normalize_admin_url(admin_url_override, base_url)
    return {
        "flavor": flavor,
        "version": version,
        "system_name": str(data.get("system_name") or ""),
        "admin_url": admin_url,
    }


# ─── 管理 API 登录（rc.30：access_token Bearer） ─────────────────────────────

async def admin_login(root: str, username: str, password: str) -> str:
    """登录网关管理后台，返回 access_token；失败抛 GatewayAuthError。"""
    if not username or not password:
        raise GatewayAuthError("未配置网关管理员用户名或密码")
    try:
        payload = await _http_post_json(
            f"{root}/api/user/login",
            payload={"username": username, "password": password},
        )
    except Exception as exc:  # 网络 / 5xx / 非 JSON
        raise GatewayAuthError(f"无法连接网关登录接口：{exc}") from exc
    if not isinstance(payload, dict) or payload.get("success") is not True:
        message = payload.get("message") if isinstance(payload, dict) else None
        raise GatewayAuthError(str(message or "网关拒绝登录（用户名或密码错误）"))
    data = payload.get("data") or {}
    if data.get("require_2fa"):
        raise GatewayAuthError("该管理员账号开启了两步验证，请改用未开启 2FA 的管理员账号")
    token = str(data.get("access_token") or "").strip()
    if not token:
        raise GatewayAuthError("网关登录成功但未返回 access_token（网关版本可能过旧）")
    return token


async def get_admin_access_token(root: str, username: str, password: str) -> str:
    """带缓存取 access_token；缓存随 access_expires_at 的近似余量过期。"""
    cache_key = f"{root}|{username}"
    cached = _access_token_cache.get(cache_key)
    if cached:
        return cached
    token = await admin_login(root, username, password)
    _access_token_cache.set(cache_key, token)
    return token


def invalidate_admin_token(root: str, username: str) -> None:
    """token 在缓存期内被网关侧吊销/过期时强制重登。"""
    _access_token_cache._data.pop(f"{root}|{username}", None)


# ─── 用量日志拉取与聚合 ──────────────────────────────────────────────────────

async def fetch_gateway_logs(root: str, token: str, start_ts: int, end_ts: int,
                             max_pages: int = LEDGER_MAX_PAGES) -> Dict[str, Any]:
    """拉取窗口内全部消费日志（type=2），自动翻页。

    返回 ``{"items": [...], "truncated": bool}``。老版本网关 data 为裸数组时
    也能兼容，但那种情况无法判断截断，按未截断处理。
    """
    headers = {"Authorization": f"Bearer {token}"}
    items: List[Dict[str, Any]] = []
    truncated = False
    for page in range(1, max_pages + 1):
        payload = await _http_get_json(
            f"{root}/api/log/",
            headers=headers,
            params={
                "p": page,
                "page_size": LEDGER_PAGE_SIZE,
                "type": LOG_TYPE_CONSUME,
                "start_timestamp": int(start_ts),
                "end_timestamp": int(end_ts),
            },
        )
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise GatewayAuthError(str(payload.get("message") or "网关日志接口返回异常"))
        data = payload.get("data")
        if isinstance(data, dict):
            batch = data.get("items") or []
            total = int(data.get("total") or 0)
        elif isinstance(data, list):  # 老版本兼容
            batch = data
            total = 0
        else:
            batch, total = [], 0
        items.extend(batch)
        fetched = page * LEDGER_PAGE_SIZE
        if not batch or (total and fetched >= total) or len(batch) < LEDGER_PAGE_SIZE:
            break
        if page == max_pages and total and fetched < total:
            truncated = True
    return {"items": items, "truncated": truncated}


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def aggregate_ledger_items(items: List[Dict[str, Any]], recent_limit: int = 20) -> Dict[str, Any]:
    """把网关消费日志聚合为对账面板所需结构。"""
    total_prompt = total_completion = total_quota = 0
    by_model: Dict[str, Dict[str, int]] = {}
    for item in items:
        prompt = _safe_int(item.get("prompt_tokens"))
        completion = _safe_int(item.get("completion_tokens"))
        quota = _safe_int(item.get("quota"))
        model = str(item.get("model_name") or "未知模型")
        total_prompt += prompt
        total_completion += completion
        total_quota += quota
        bucket = by_model.setdefault(
            model, {"prompt": 0, "completion": 0, "total": 0, "quota": 0, "count": 0}
        )
        bucket["prompt"] += prompt
        bucket["completion"] += completion
        bucket["total"] += prompt + completion
        bucket["quota"] += quota
        bucket["count"] += 1

    recent = sorted(items, key=lambda x: _safe_int(x.get("created_at")), reverse=True)[:recent_limit]
    return {
        "request_count": len(items),
        "prompt_tokens": total_prompt,
        "completion_tokens": total_completion,
        "total_tokens": total_prompt + total_completion,
        "total_quota": total_quota,
        "by_model": [
            {"model": name, **bucket}
            for name, bucket in sorted(by_model.items(), key=lambda kv: kv[1]["total"], reverse=True)
        ],
        "recent": recent,
    }
