"""[IMAGE-PROXY] 图片代理端点：被阻断图床的 <img> 改走此处（仅认证用户）。"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from ..core import get_db
from ..models.user import User
from ..services.image_proxy_service import proxy_image_bytes
from .dependencies import get_current_user

router = APIRouter(prefix="/api/image-proxy", tags=["image-proxy"])
logger = logging.getLogger(__name__)


@router.get("")
async def proxy_image(
    url: str = Query(..., description="要代理的原始图片地址"),
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    try:
        payload, content_type = await proxy_image_bytes(url)
    except ValueError as exc:
        # 校验失败（非 http(s)/内网地址/超长）：静态文案，N-13 契约（4xx 不直传 str(exc)）
        logger.info("image-proxy rejected url %s: %s", url[:200], exc)
        raise HTTPException(status_code=400, detail="仅允许公网 http(s) 图片地址") from exc
    except Exception as exc:
        logger.warning("image-proxy download failed for %s: %s", url[:200], exc)
        raise HTTPException(status_code=502, detail="图片代理下载失败（源站与镜像均不可达）") from exc

    return Response(
        content=payload,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "Content-Disposition": "inline",
        },
    )
