import json
import logging
import os

from sqlalchemy.orm import Session

from ..models import SystemSetting

logger = logging.getLogger(__name__)

_DEFAULT_AUTH_CONFIG = {
    "local_login_enabled": True,
    "local_register_enabled": True,
}


def get_auth_config(db: Session) -> dict:
    setting = db.query(SystemSetting).filter(SystemSetting.key == "auth_config").first()
    if setting:
        try:
            config = json.loads(setting.value)
            config = {k: v for k, v in config.items() if k in _DEFAULT_AUTH_CONFIG}
            return {**_DEFAULT_AUTH_CONFIG, **config}
        except (json.JSONDecodeError, TypeError):
            logger.warning("Corrupted auth_config in database, falling back to defaults")

    config = dict(_DEFAULT_AUTH_CONFIG)

    env_mapping = {
        "local_login_enabled": ("LOCAL_LOGIN_ENABLED", True),
        "local_register_enabled": ("LOCAL_REGISTER_ENABLED", True),
    }

    for key, (env_var, default) in env_mapping.items():
        val = os.getenv(env_var)
        if val is not None:
            if isinstance(default, bool):
                config[key] = val.lower() in ("true", "1", "yes")
            else:
                config[key] = val
        else:
            config[key] = default

    return config


def save_auth_config(db: Session, config: dict) -> None:
    setting = db.query(SystemSetting).filter(SystemSetting.key == "auth_config").first()
    value = json.dumps(config, ensure_ascii=False)
    if setting:
        setting.value = value
    else:
        db.add(SystemSetting(key="auth_config", value=value))
    db.commit()


def get_public_auth_config(db: Session) -> dict:
    config = get_auth_config(db)
    from ..services.oauth_service import get_oauth_providers_config
    providers = get_oauth_providers_config(db)
    available_providers = []
    for p in providers:
        if p.get("enabled", False):
            available_providers.append({
                "name": p.get("name", ""),
                "display_name": p.get("display_name", p.get("name", "")),
            })
    return {
        "local_login_enabled": config.get("local_login_enabled", True),
        "local_register_enabled": config.get("local_register_enabled", True),
        "oauth_providers": available_providers,
    }
