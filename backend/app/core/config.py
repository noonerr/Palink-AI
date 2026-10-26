import logging
import secrets
from typing import List, Optional
from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)

class Settings(BaseSettings):
    """应用配置"""
    
    APP_ENV: str = "development"
    
    SECRET_KEY: Optional[str] = None
    ADMIN_PASSWORD: Optional[str] = None

    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 12
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

    # [MVU-LOOKBACK 2026-10-05] 提示词装配回溯「消息级变量快照」的楼层上限。
    # 变量镜像存在每条消息的 extra.variables，装配时从最新往前找最近一个非空快照
    # （见 roleplay_prompt_assembly._load_effective_stat_data）。
    # 此前该值是硬编码的 30（同文件 CHARACTER_CHAT_HISTORY_LIMIT 反而是可配置的，口径不一致）。
    # ⚠️ 与变量清理联动：mvu_cleanup 的「要保留变量的最近楼层数」必须 ≥ 本值，
    # 否则被清理的楼层会滑进回看窗口 → 找不到快照 → 静默回落到会话级。
    # 改本值时必须同步核对清理侧保留楼层数，两者不可各写各的常量。
    MVU_STAT_LOOKBACK_LIMIT: int = 30

    # [ST-ALIGN P0-1] 记忆自动封存开关。
    # ST 1.18 由 memory 扩展按 promptInterval / context 阈值滚动摘要，长会话不会无限涨。
    # Palink 此前 check_and_auto_compress 只有定义、零调用方，记忆只增不减直到撞上下文窗口。
    # 开启后：每轮对话落库后按阈值自动压缩（删除低权重记忆 + 生成压缩摘要）。
    # 置 False 可全局熔断，仅保留手动端点 /api/memory/compress。
    AUTO_MEMORY_COMPRESS: bool = True

    # [OLLAMA-PREWARM 2026-10-26] P2-26 冷启动记忆塌缩的修法①：定期发一次小 embed，
    # 让 ollama 的 bge-m3 保持驻留，避免它被 24h 空闲卸载 / 容器重启逐出后，
    # 冷轮首请求超过 OLLAMA_TIMEOUT=30s → 降级 fastembed(512 维) → 维度门吞掉
    # → 记忆注入塌约九成（机制链见 docs/OPEN_ISSUES.md [P2-26]）。
    # 默认开；置 false 即完全不启动预热线程（回到改动前行为）。
    OLLAMA_PREWARM_ENABLED: bool = True
    # 预热间隔（小时）。必须 < ollama 的 OLLAMA_KEEP_ALIVE（compose 口径 24h），
    # 否则刚过保留期才预热一次、中间仍会被卸载。<=0 视为关闭（不启动线程）。
    # 注意：它只影响「定时」那一次次，启动后总会先预热一次。
    OLLAMA_PREWARM_INTERVAL_HOURS: int = 6
    # 预热用的极短文本。嵌入开销与文本长度弱相关（bge-m3 固定开销约 160ms/次），
    # 取一两个字即可，目的是「让模型被调用」而不是产出有用向量。
    OLLAMA_PREWARM_TEXT: str = "预热"

    TRUST_PROXY_HEADERS: bool = False
    RUN_MIGRATIONS_ON_STARTUP: bool = False
    MIGRATIONS_FAIL_FAST: bool = True
    PROVIDER_SECRET_CHECK_STRICT: bool = False
    MCP_ALLOWED_ROLES: list = ["admin"]
    # [AUDIT-2026-09-25] 生产/测试环境下放行内网服务地址的显式总开关。
    # 背景：本地 SD WebUI / ComfyUI / Coqui / MCP server 必然是内网地址，
    # 而 SSRF 校验在非 development 环境一律拒绝 → "开发能配、生产被自家
    # 规则挡住"。默认 False（保持拦截）；部署本地 AI 服务时置 true 显式放行。
    ALLOW_INTERNAL_SERVICE_URLS: bool = False
    API_THREADPOOL_TOKENS: int = 16
    STARTUP_INIT_LOCK_FILE: str = "/tmp/palink_startup.lock"
    STARTUP_INIT_DONE_FILE: str = "/tmp/palink_startup.done"
    
    DATABASE_URL: str = "sqlite:///./data/palink.db"
    DB_POOL_SIZE: int = 4
    DB_MAX_OVERFLOW: int = 8
    DB_POOL_RECYCLE_SECONDS: int = 1800
    DB_POOL_AUTO_TUNE: bool = False
    DB_CONNECTION_BUDGET: int = 40
    
    CORS_ORIGINS: str = "*"  # 生产环境必须设置为具体域名，多个用逗号分隔，如 "https://app.example.com,https://admin.example.com"
    
    DATA_DIR: str = "./data"
    UPLOAD_DIR: str = "./data/uploads"
    CHAT_UPLOAD_MAX_FILE_SIZE_MB: int = 20
    # N-16: 本地模型（llama.cpp .gguf）上传单文件上限，超限返回 413。默认 10GB。
    LOCAL_MODEL_UPLOAD_MAX_FILE_SIZE_MB: int = 10240
    CHAT_UPLOAD_MAX_USER_STORAGE_MB: int = 1024
    CHAT_UPLOAD_ALLOWED_EXTENSIONS: str = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar,.7z,.tar,.gz,.csv,.json,.md,.css,.js,.ts,.jsx,.tsx,.py,.java,.cpp,.c,.h,.go,.rs,.rb,.php,.swift,.kt,.xml,.yaml,.yml,.toml,.ini,.cfg"
    CHAT_UPLOAD_BLOCKED_EXTENSIONS: str = ".exe,.dll,.bat,.cmd,.com,.msi,.scr,.ps1,.psm1,.vbs,.vbe,.jse,.wsf,.wsh,.hta,.jar,.apk,.html,.htm,.svg"
    WORKSPACE_DIR: str = "./data/workspace"
    WORKSPACE_MAX_FILE_SIZE_MB: int = 20
    WORKSPACE_MAX_USER_STORAGE_MB: int = 1024
    WORKSPACE_ALLOWED_EXTENSIONS: str = ".txt,.md,.py,.js,.ts,.tsx,.json,.csv,.css,.yaml,.yml,.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
    WORKSPACE_ANALYZE_MAX_CHARS: int = 12000
    SUMMARY_MODEL: Optional[str] = None

    # ST-native 遗留配置（st-compat/st-native 已于 2026-09 删除）。仅保留仍有
    # 消费方的字段：SERVICE_URL/SERVICE_KEY 被 silly_tavern.py 的 /api/extensions/*
    # sidecar 转发链使用；DATA_ROOT 被 st_sync_service.py 使用。
    ST_NATIVE_SERVICE_URL: str = "http://sillytavern:8000"
    ST_NATIVE_SERVICE_KEY: Optional[str] = None
    ST_NATIVE_DATA_ROOT: Optional[str] = None
    STATIC_DIR: str = "static"

    # API Key 加密密钥（Fernet）。为空时 crypto_service 会自动生成并持久化到
    # DATA_DIR 下的密钥文件，避免重启后丢失导致已加密数据无法解密。
    API_KEY_ENCRYPTION_KEY: str = ""
    
    class Config:
        env_file = ".env"
        case_sensitive = True
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._validate_config()
    
    def _validate_config(self):
        if not self.SECRET_KEY:
            if self.APP_ENV == "development":
                self.SECRET_KEY = secrets.token_hex(32)
                logger.warning(
                    "[SECURITY] Using randomly generated SECRET_KEY for development mode. "
                    "Key will change on restart — set SECRET_KEY env var for persistence."
                )
            else:
                raise RuntimeError(
                    "SECRET_KEY environment variable is required when APP_ENV != 'development'."
                )

        if not self.ADMIN_PASSWORD:
            if self.APP_ENV == "development":
                logger.warning(
                    "[SECURITY] ADMIN_PASSWORD is not set. "
                    "Default admin user will not be created automatically."
                )
            else:
                raise RuntimeError(
                    "ADMIN_PASSWORD environment variable is required when APP_ENV != 'development'."
                )
        elif self.ADMIN_PASSWORD == "admin123":
            # N-18: prod 环境弱管理员密码从告警升级为启动阻断。
            if self.APP_ENV == "production":
                raise RuntimeError(
                    "ADMIN_PASSWORD is set to the default value 'admin123' in production. "
                    "Refusing to start — set a strong ADMIN_PASSWORD via environment variable."
                )
            logger.warning(
                "[SECURITY] ADMIN_PASSWORD is set to the default value 'admin123'. "
                "This is not recommended for production use."
            )

        if self.APP_ENV == "production":
            # 拒绝已知弱/模板 SECRET_KEY（含 .env.example 提供的占位值）。
            # 这些值公开可见，攻击者可直接伪造 JWT / ST native session cookie。
            weak_secret_keys = {
                "palink-dev-secret-change-in-production",
                "change-me-to-a-strong-random-string",
            }
            if self.SECRET_KEY in weak_secret_keys:
                raise ValueError(
                    "SECRET_KEY must not use a known weak/template value "
                    "in production. Please set a strong, unique SECRET_KEY via environment variable."
                )

        if self.APP_ENV != "development" and (not self.CORS_ORIGINS or self.CORS_ORIGINS.strip() == "*"):
            raise RuntimeError(
                "CORS_ORIGINS must be explicitly configured when APP_ENV != 'development'."
            )

        # MED-5: ST_NATIVE_SERVICE_KEY 弱值告警（不阻断——空值合法，表示不启用该分支）。
        # 配置了过短/已知弱值时，docker 网络内进程可持 key 以 admin 身份调用
        # /api/openai/v1（openai_compat.py service key 分支）。
        service_key = (self.ST_NATIVE_SERVICE_KEY or "").strip()
        if service_key:
            weak_service_keys = {"palink", "service", "changeme", "secret", "password"}
            if len(service_key) < 16 or service_key.lower() in weak_service_keys:
                logger.warning(
                    "[SECURITY] ST_NATIVE_SERVICE_KEY 为弱值（过短或常见字符串），"
                    "docker 网络内任何进程都可持它冒充 admin 调用 /api/openai/v1。"
                    "建议设置为 32+ 字符的随机串，或保持为空禁用该认证分支。"
                )
    
    @property
    def cors_origins_list(self) -> List[str]:
        if not self.CORS_ORIGINS or self.CORS_ORIGINS == "*":
            return ["*"]
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

settings = Settings()
