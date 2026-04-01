import logging
from typing import List, Optional
from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)

class Settings(BaseSettings):
    """应用配置"""
    
    APP_ENV: str = "development"
    
    SECRET_KEY: Optional[str] = None
    ADMIN_PASSWORD: Optional[str] = None

    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24
    PASSWORD_MIN_LENGTH: int = 8
    REQUIRE_PASSWORD_MIXED_CASE: bool = True
    REQUIRE_PASSWORD_DIGIT: bool = True

    LOGIN_RATE_LIMIT_REQUESTS: int = 10
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: int = 60
    REGISTER_RATE_LIMIT_REQUESTS: int = 5
    REGISTER_RATE_LIMIT_WINDOW_SECONDS: int = 300
    CHAT_RATE_LIMIT_REQUESTS: int = 30
    CHAT_RATE_LIMIT_WINDOW_SECONDS: int = 60
    CHARACTER_CHAT_RATE_LIMIT_REQUESTS: int = 20
    CHARACTER_CHAT_RATE_LIMIT_WINDOW_SECONDS: int = 60
    CHAT_HISTORY_LIMIT: int = 24
    CHARACTER_CHAT_HISTORY_LIMIT: int = 24
    TRUST_PROXY_HEADERS: bool = False
    RUN_MIGRATIONS_ON_STARTUP: bool = False
    MIGRATIONS_FAIL_FAST: bool = True
    PROVIDER_SECRET_CHECK_STRICT: bool = False
    
    DATABASE_URL: str = "sqlite:///./data/palink.db"
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_POOL_RECYCLE_SECONDS: int = 1800
    
    CORS_ORIGINS: str = "*"
    
    DATA_DIR: str = "./data"
    UPLOAD_DIR: str = "./data/uploads"
    WORKSPACE_DIR: str = "./data/workspace"
    WORKSPACE_MAX_FILE_SIZE_MB: int = 20
    WORKSPACE_MAX_USER_STORAGE_MB: int = 1024
    WORKSPACE_ALLOWED_EXTENSIONS: str = ".txt,.md,.py,.js,.ts,.tsx,.json,.csv,.html,.css,.yaml,.yml,.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
    WORKSPACE_ANALYZE_MAX_CHARS: int = 12000
    
    class Config:
        env_file = ".env"
        case_sensitive = True
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._validate_config()
    
    def _validate_config(self):
        if not self.SECRET_KEY:
            if self.APP_ENV == "development":
                self.SECRET_KEY = "palink-dev-secret-change-in-production"
                logger.warning(
                    "[SECURITY] Using default SECRET_KEY in development mode. "
                    "Set SECRET_KEY environment variable for production."
                )
            else:
                raise RuntimeError(
                    "SECRET_KEY environment variable is required when APP_ENV != 'development'."
                )

        if not self.ADMIN_PASSWORD:
            if self.APP_ENV == "development":
                self.ADMIN_PASSWORD = "admin"
                logger.warning(
                    "[SECURITY] Using default ADMIN_PASSWORD in development mode. "
                    "Set ADMIN_PASSWORD environment variable for production."
                )
            else:
                raise RuntimeError(
                    "ADMIN_PASSWORD environment variable is required when APP_ENV != 'development'."
                )

        if self.APP_ENV != "development" and (not self.CORS_ORIGINS or self.CORS_ORIGINS.strip() == "*"):
            raise RuntimeError(
                "CORS_ORIGINS must be explicitly configured when APP_ENV != 'development'."
            )
    
    @property
    def cors_origins_list(self) -> List[str]:
        if not self.CORS_ORIGINS or self.CORS_ORIGINS == "*":
            return ["*"]
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

settings = Settings()
