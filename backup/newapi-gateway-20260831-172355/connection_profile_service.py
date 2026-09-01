"""ConnectionProfile 凭证解析 —— 推理路径优先使用用户激活 profile 的解密凭证。

向后兼容：若用户没有激活的 ConnectionProfile，回退到全局 providers.json
提供的 api_key/base_url（由调用方传入默认值）。
"""
import json
import logging
from typing import Dict, Optional, Tuple

from sqlalchemy.orm import Session

from .crypto_service import decrypt_api_key

logger = logging.getLogger(__name__)


def get_active_profile(db: Session, user_id: int):
    """返回用户当前激活的 ConnectionProfile，无则返回 None。"""
    if user_id is None:
        return None
    # 懒加载以规避模块加载阶段的循环导入（inference_dispatcher 在 models
    # 初始化链中导入本模块，顶层导入 ConnectionProfile 会触发循环）。
    from ..models import ConnectionProfile
    return (
        db.query(ConnectionProfile)
        .filter(
            ConnectionProfile.user_id == user_id,
            ConnectionProfile.is_active == True,  # noqa: E712
        )
        .first()
    )


def get_decrypted_api_key(profile) -> str:
    """解密 profile 的 API Key。无密文或解密失败返回空串。"""
    if not profile or not profile.api_key_encrypted:
        return ""
    return decrypt_api_key(profile.api_key_encrypted)


def get_model_mapping(profile) -> Dict[str, str]:
    """解析 profile 的 model_mapping JSON，失败或无 profile 返回空 dict。"""
    if not profile or not profile.model_mapping:
        return {}
    try:
        data = json.loads(profile.model_mapping)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def resolve_credentials(
    db: Session,
    user_id: Optional[int],
    default_api_key: str = "",
    default_base_url: str = "",
) -> Tuple[str, str, Dict[str, str]]:
    """解析推理使用的 (api_key, base_url, model_mapping)。

    优先使用用户激活 profile 的解密凭证；若 profile 未设置 base_url，则保留
    调用方传入的 default_base_url（保持端点回退）。无激活 profile 时完全回退
    到默认值（model_mapping 为空 dict）。
    """
    if user_id is None:
        return default_api_key, default_base_url, {}

    profile = get_active_profile(db, user_id)
    if profile is None:
        return default_api_key, default_base_url, {}

    decrypted = get_decrypted_api_key(profile)
    api_key = decrypted if decrypted else default_api_key
    # profile 显式配置的 base_url 优先；为空时回退到默认端点
    base_url = profile.base_url if profile.base_url else default_base_url
    return api_key, base_url, get_model_mapping(profile)
