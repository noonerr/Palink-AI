"""API Key 对称加密工具 —— 基于 cryptography.Fernet。

密钥来源优先级：
1. settings.API_KEY_ENCRYPTION_KEY（环境变量配置，推荐生产环境使用）
2. DATA_DIR 下的持久化密钥文件（首次自动生成，后续复用）

密钥必须持久化，否则重启后已加密的 API Key 将无法解密。
"""
import logging
import os
import threading
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from ..core.config import settings

logger = logging.getLogger(__name__)

_KEY_FILE_NAME = ".api_key_encryption_key"
_fernet_lock = threading.Lock()
_fernet: Optional[Fernet] = None


def _key_file_path() -> str:
    return os.path.join(settings.DATA_DIR, _KEY_FILE_NAME)


def _load_or_create_key() -> str:
    """返回 Fernet 密钥字符串。优先用配置，否则读写密钥文件。"""
    configured = (settings.API_KEY_ENCRYPTION_KEY or "").strip()
    if configured:
        return configured

    # MED-6: 生产环境使用"数据目录内文件密钥"时告警——密钥与加密数据同目录，
    # 备份数据 = 拿到全部明文 API Key。推荐通过环境变量 API_KEY_ENCRYPTION_KEY 注入。
    if getattr(settings, "APP_ENV", "development") == "production":
        logger.warning(
            "[SECURITY] 生产环境正在使用 DATA_DIR 下的文件密钥（.api_key_encryption_key）。"
            "该文件与加密数据同目录，拿到备份即可解密全部 API Key。"
            "建议通过环境变量 API_KEY_ENCRYPTION_KEY 注入强随机密钥，并确保文件不随数据备份分发。"
        )

    path = _key_file_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except Exception:
        # DATA_DIR 可能已存在，忽略创建错误
        pass

    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fp:
                existing = fp.read().strip()
            if existing:
                return existing
        except Exception as exc:
            logger.warning("读取 API Key 加密密钥文件失败，将重新生成: %s", exc)

    new_key = Fernet.generate_key().decode("utf-8")
    try:
        with open(path, "w", encoding="utf-8") as fp:
            fp.write(new_key)
        try:
            os.chmod(path, 0o600)
        except Exception:
            # Windows 上 chmod 限制，忽略
            pass
        logger.info("已生成并持久化 API Key 加密密钥: %s", path)
    except Exception as exc:
        logger.error("持久化 API Key 加密密钥失败: %s", exc)
    return new_key


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is not None:
        return _fernet
    with _fernet_lock:
        if _fernet is None:
            _fernet = Fernet(_load_or_create_key().encode("utf-8"))
    return _fernet


def encrypt_api_key(api_key: str) -> str:
    """加密明文 API Key，返回可存储的密文字符串。空串原样返回。"""
    if api_key is None or api_key == "":
        return ""
    token = _get_fernet().encrypt(api_key.encode("utf-8"))
    return token.decode("utf-8")


def decrypt_api_key(encrypted: str) -> str:
    """解密密文 API Key，返回明文。空串或解密失败返回空串。"""
    if not encrypted:
        return ""
    try:
        plain = _get_fernet().decrypt(encrypted.encode("utf-8"))
        return plain.decode("utf-8")
    except InvalidToken:
        logger.error("API Key 解密失败：密钥不匹配或数据已损坏")
        return ""
    except Exception as exc:
        logger.error("API Key 解密异常: %s", exc)
        return ""
