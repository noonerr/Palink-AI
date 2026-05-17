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
    API_THREADPOOL_TOKENS: int = 16
    STARTUP_INIT_LOCK_FILE: str = "/tmp/palink_startup.lock"
    STARTUP_INIT_DONE_FILE: str = "/tmp/palink_startup.done"
    
    DATABASE_URL: str = "sqlite:///./data/palink.db"
    DB_POOL_SIZE: int = 4
    DB_MAX_OVERFLOW: int = 8
    DB_POOL_RECYCLE_SECONDS: int = 1800
    
    CORS_ORIGINS: str = "*"  # 生产环境必须设置为具体域名，多个用逗号分隔，如 "https://app.example.com,https://admin.example.com"
    
    DATA_DIR: str = "./data"
    UPLOAD_DIR: str = "./data/uploads"
    CHAT_UPLOAD_MAX_FILE_SIZE_MB: int = 20
    CHAT_UPLOAD_MAX_USER_STORAGE_MB: int = 1024
    CHAT_UPLOAD_ALLOWED_EXTENSIONS: str = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar,.7z,.tar,.gz,.csv,.json,.md,.css,.js,.ts,.jsx,.tsx,.py,.java,.cpp,.c,.h,.go,.rs,.rb,.php,.swift,.kt,.xml,.yaml,.yml,.toml,.ini,.cfg"
    CHAT_UPLOAD_BLOCKED_EXTENSIONS: str = ".exe,.dll,.bat,.cmd,.com,.msi,.scr,.ps1,.psm1,.vbs,.vbe,.jse,.wsf,.wsh,.hta,.jar,.apk,.html,.htm,.svg"
    WORKSPACE_DIR: str = "./data/workspace"
    WORKSPACE_MAX_FILE_SIZE_MB: int = 20
    WORKSPACE_MAX_USER_STORAGE_MB: int = 1024
    WORKSPACE_ALLOWED_EXTENSIONS: str = ".txt,.md,.py,.js,.ts,.tsx,.json,.csv,.css,.yaml,.yml,.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
    WORKSPACE_ANALYZE_MAX_CHARS: int = 12000
    SUMMARY_MODEL: Optional[str] = None
    
    class Config:
        env_file = ".env"
        case_sensitive = True
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._validate_config()
    
    def _validate_config(self):
        if not self.SECRET_KEY:
            if self.APP_ENV == "development":
                import secrets
                self.SECRET_KEY = secrets.token_urlsafe(32)
                logger.warning(
                    "[SECURITY] Auto-generated random SECRET_KEY for development mode. "
                    "This key changes on restart."
                )
            else:
                raise RuntimeError(
                    "SECRET_KEY environment variable is required when APP_ENV != 'development'."
                )

        if not self.ADMIN_PASSWORD:
            if self.APP_ENV == "development":
                self.ADMIN_PASSWORD = "admin123"
                logger.warning(
                    "[SECURITY] Using default ADMIN_PASSWORD in development mode. "
                    "Set ADMIN_PASSWORD environment variable for production."
                )
            else:
                raise RuntimeError(
                    "ADMIN_PASSWORD environment variable is required when APP_ENV != 'development'."
                )

        if self.APP_ENV == "production":
            if self.SECRET_KEY == "palink-dev-secret-change-in-production":
                raise ValueError(
                    "SECRET_KEY must not use the default value 'palink-dev-secret-change-in-production' "
                    "in production. Please set a strong, unique SECRET_KEY via environment variable."
                )
            if self.ADMIN_PASSWORD == "admin123":
                raise ValueError(
                    "ADMIN_PASSWORD must not use the default value 'admin123' "
                    "in production. Please set a strong, unique ADMIN_PASSWORD via environment variable."
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
