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
    TRUST_PROXY_HEADERS: bool = False
    
    DATABASE_URL: str = "sqlite:///./data/palink.db"
    
    CORS_ORIGINS: str = "*"
    
    DATA_DIR: str = "./data"
    UPLOAD_DIR: str = "./data/uploads"
    WORKSPACE_DIR: str = "./data/workspace"
    
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
