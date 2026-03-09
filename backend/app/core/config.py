from typing import List, Optional
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    """应用配置"""
    
    APP_ENV: str = "development"
    
    SECRET_KEY: Optional[str] = None
    ADMIN_PASSWORD: Optional[str] = None
    
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
                self.SECRET_KEY = "palink-secret-v35-stable"
            else:
                raise RuntimeError("SECRET_KEY is required when APP_ENV is not development.")
        
        if not self.ADMIN_PASSWORD:
            if self.APP_ENV == "development":
                self.ADMIN_PASSWORD = "admin123"
            else:
                raise RuntimeError("ADMIN_PASSWORD is required when APP_ENV is not development.")
    
    @property
    def cors_origins_list(self) -> List[str]:
        if not self.CORS_ORIGINS or self.CORS_ORIGINS == "*":
            return ["*"]
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

settings = Settings()
