"""网关管理端点（P2-3）：指纹探测 + 用量对账。

全部为 GET 只读端点，仅管理员可用（get_admin）。对账不在推理链路上：
未探测到网关 / 未配置管理凭据 / 登录失败都返回 200 + 状态字段，由前端降级渲染。
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..api.dependencies import get_admin
from ..core import get_db
from ..models import CharacterChatMessage, ChatMessage, User
from ..services.gateway_service import (
    GatewayAuthError,
    aggregate_ledger_items,
    detect_gateway,
    fetch_gateway_logs,
    gateway_root_from_base_url,
    get_admin_access_token,
    invalidate_admin_token,
    _detect_cache,
    _ledger_cache,
)
from ..services.provider_registry import get_providers, resolve_secret_reference

router = APIRouter(prefix="/api/admin/gateway", tags=["gateway"])
logger = logging.getLogger(__name__)

LEDGER_WINDOW_HOURS = (24, 168, 720)  # 1 天 / 7 天 / 30 天


def _provider_by_id(provider_id: str) -> Optional[Dict[str, Any]]:
    for provider in get_providers():
        if provider.get("id") == provider_id:
            return provider
    return None


async def _detect_entry(base_url: str, admin_url: Optional[str]) -> Optional[Dict[str, Any]]:
    try:
        return await detect_gateway(base_url, admin_url_override=admin_url)
    except Exception:  # 单个 provider 探测失败不影响其他
        return None


@router.get("/detect")
async def detect_gateways(admin: User = Depends(get_admin)):
    """对全部 active provider 并发探测网关指纹。

    返回 ``{"providers": {id: {is_gateway, flavor, version, system_name, admin_url} | {is_gateway: false}}}``，
    结果缓存 5 分钟。
    """
    entries: List[Tuple[str, str, Optional[str]]] = []
    for provider in get_providers():
        if not provider.get("is_active", True):
            continue
        base_url = str(provider.get("base_url") or "")
        if not base_url:
            continue
        entries.append((str(provider.get("id")), base_url, provider.get("admin_url")))

    cache_key = json.dumps(sorted(entries), ensure_ascii=False)
    cached = _detect_cache.get(cache_key)
    if cached is not None:
        return cached

    probes = [_detect_entry(base_url, admin_url) for _, base_url, admin_url in entries]
    detected = await asyncio.gather(*probes)

    providers_result: Dict[str, Dict[str, Any]] = {}
    for (provider_id, _, _), info in zip(entries, detected):
        if info:
            providers_result[provider_id] = {"is_gateway": True, **info}
        else:
            providers_result[provider_id] = {"is_gateway": False}

    response = {"providers": providers_result}
    _detect_cache.set(cache_key, response)
    return response


def _palink_ledger(db: Session, start_dt: datetime, end_dt: datetime) -> Dict[str, Any]:
    """同时间窗内 Palink 自身记账（消息表）聚合，口径与 stats.py 一致。"""
    total_prompt = total_completion = total_requests = 0
    by_model: Dict[str, Dict[str, int]] = {}
    for model_cls in (CharacterChatMessage, ChatMessage):
        rows = (
            db.query(
                model_cls.model,
                func.coalesce(func.sum(model_cls.prompt_tokens), 0),
                func.coalesce(func.sum(model_cls.tokens), 0),
                func.count(model_cls.id),
            )
            .filter(
                model_cls.role == "assistant",
                model_cls.created_at >= start_dt,
                model_cls.created_at <= end_dt,
            )
            .group_by(model_cls.model)
        )
        for model_name, prompt_sum, completion_sum, request_count in rows:
            prompt = int(prompt_sum or 0)
            completion = int(completion_sum or 0)
            count = int(request_count or 0)
            total_prompt += prompt
            total_completion += completion
            total_requests += count
            bucket = by_model.setdefault(str(model_name or "未知模型"), {"prompt": 0, "completion": 0, "total": 0, "count": 0})
            bucket["prompt"] += prompt
            bucket["completion"] += completion
            bucket["total"] += prompt + completion
            bucket["count"] += count

    return {
        "request_count": total_requests,
        "prompt_tokens": total_prompt,
        "completion_tokens": total_completion,
        "total_tokens": total_prompt + total_completion,
        "by_model": [
            {"model": name, **bucket}
            for name, bucket in sorted(by_model.items(), key=lambda kv: kv[1]["total"], reverse=True)
        ],
    }


@router.get("/ledger")
async def gateway_ledger(
    provider_id: str = Query(...),
    hours: int = Query(168),
    admin: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    """网关账本 vs Palink 记账对账。

    降级链：非网关 → ``is_gateway=false``；未配置管理凭据 → ``configured=false``；
    登录失败 → ``auth_error``。全部 200，前端按字段渲染。
    """
    if hours not in LEDGER_WINDOW_HOURS:
        raise HTTPException(status_code=422, detail=f"hours 仅支持 {LEDGER_WINDOW_HOURS}")

    provider = _provider_by_id(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider 不存在")
    base_url = str(provider.get("base_url") or "")
    if not base_url:
        raise HTTPException(status_code=422, detail="Provider 未配置 base_url")

    detect_result = await _detect_entry(base_url, provider.get("admin_url"))
    if not detect_result:
        return {"provider_id": provider_id, "is_gateway": False, "hours": hours}

    cache_key = f"{provider_id}|{hours}"
    cached = _ledger_cache.get(cache_key)
    if cached is not None:
        return cached

    admin_url = detect_result["admin_url"]
    response: Dict[str, Any] = {
        "provider_id": provider_id,
        "is_gateway": True,
        "configured": True,
        "hours": hours,
        "flavor": detect_result["flavor"],
        "version": detect_result["version"],
        "system_name": detect_result["system_name"],
        "admin_url": admin_url,
    }

    username = (resolve_secret_reference(provider.get("admin_username") or "") or "").strip()
    password = (resolve_secret_reference(provider.get("admin_password") or "") or "").strip()
    if not username or not password:
        response["configured"] = False
        _ledger_cache.set(cache_key, response)
        return response

    root = gateway_root_from_base_url(base_url)
    end_dt = datetime.now(timezone.utc)
    start_dt = end_dt - timedelta(hours=hours)
    try:
        token = await get_admin_access_token(root, username, password)
        logs = await fetch_gateway_logs(root, token, int(start_dt.timestamp()), int(end_dt.timestamp()))
    except GatewayAuthError:
        # token 可能在缓存期内被网关侧吊销/过期：强制重登一次再拉取
        invalidate_admin_token(root, username)
        try:
            token = await get_admin_access_token(root, username, password)
            logs = await fetch_gateway_logs(root, token, int(start_dt.timestamp()), int(end_dt.timestamp()))
        except GatewayAuthError as exc:
            response["auth_error"] = str(exc)
            _ledger_cache.set(cache_key, response)
            return response

    response["gateway"] = aggregate_ledger_items(logs["items"])
    response["gateway"]["truncated"] = logs["truncated"]
    response["palink"] = _palink_ledger(db, start_dt, end_dt)

    gateway_total = response["gateway"]["total_tokens"]
    palink_total = response["palink"]["total_tokens"]
    response["drift"] = {
        "tokens": palink_total - gateway_total,
        "percent": round((palink_total - gateway_total) / gateway_total * 100, 2) if gateway_total else None,
    }

    _ledger_cache.set(cache_key, response)
    return response
