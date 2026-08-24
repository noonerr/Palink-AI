from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from sqlalchemy import text
import logging
import os
import uuid
import anyio.to_thread
import json
import jwt

try:
    import fcntl
except ImportError:
    fcntl = None

from .core import settings, engine, run_migrations, ensure_runtime_schema_compat, get_password_hash, verify_password, SessionLocal
from .core.exceptions import ServiceError
from .core.log_sanitizer import setup_sanitized_logging
from .api import api_router
from .models import Base, User, SystemSetting
from .services.provider_registry import get_missing_provider_secret_refs

# S-8 修复: 启用日志脱敏组件（替换裸 basicConfig）。setup_sanitized_logging
# 挂载 SanitizingFormatter，自动对 JWT/密钥/手机号/邮箱/身份证等敏感信息
# 打码后再写日志，避免 API key、token 泄漏到容器日志。
setup_sanitized_logging(level=logging.INFO)
logger = logging.getLogger("PalinkAI")


def _initialize_database_once() -> None:
    lock_file = settings.STARTUP_INIT_LOCK_FILE
    done_file = settings.STARTUP_INIT_DONE_FILE

    if fcntl is None:
        logger.warning("fcntl 不可用，按单进程模式执行数据库初始化")
        Base.metadata.create_all(bind=engine)
        ensure_runtime_schema_compat(engine)
        logger.info("数据库表创建完成")
        if settings.RUN_MIGRATIONS_ON_STARTUP:
            logger.info("RUN_MIGRATIONS_ON_STARTUP=true，开始执行数据库迁移")
            run_migrations(engine)
            logger.info("数据库迁移完成")
        else:
            logger.info("跳过启动时数据库迁移（RUN_MIGRATIONS_ON_STARTUP=false）")
        # 初始化默认数据
        _init_default_data()
        return

    os.makedirs(os.path.dirname(lock_file), exist_ok=True)
    os.makedirs(os.path.dirname(done_file), exist_ok=True)

    with open(lock_file, "w", encoding="utf-8") as lock_fp:
        fcntl.flock(lock_fp, fcntl.LOCK_EX)

        if os.path.exists(done_file):
            logger.info("数据库初始化已由其他 worker 完成，当前 worker 跳过")
            ensure_runtime_schema_compat(engine)
            return

        Base.metadata.create_all(bind=engine)
        ensure_runtime_schema_compat(engine)
        logger.info("数据库表创建完成")

        if settings.RUN_MIGRATIONS_ON_STARTUP:
            logger.info("RUN_MIGRATIONS_ON_STARTUP=true，开始执行数据库迁移")
            run_migrations(engine)
            logger.info("数据库迁移完成")
        else:
            logger.info("跳过启动时数据库迁移（RUN_MIGRATIONS_ON_STARTUP=false）")
        
        # 初始化默认数据
        _init_default_data()

        with open(done_file, "w", encoding="utf-8") as done_fp:
            done_fp.write(str(os.getpid()))


def _seed_builtin_context_templates(db) -> None:
    """Idempotently insert built-in context templates (ST 1.18.0).

    Existing rows are updated in place so seed changes (e.g. typo fixes)
    propagate without wiping user-created templates. Built-in templates
    cannot be deleted by users.
    """
    from .core.context_template_seeds import BUILTIN_CONTEXT_TEMPLATES
    from .models import ContextTemplate

    for seed in BUILTIN_CONTEXT_TEMPLATES:
        existing = db.query(ContextTemplate).filter(ContextTemplate.name == seed["name"]).first()
        if existing is None:
            db.add(ContextTemplate(**seed))
        else:
            # Refresh built-in fields but preserve id / timestamps.
            for key, value in seed.items():
                setattr(existing, key, value)


def _seed_builtin_instruct_templates(db) -> None:
    """Idempotently insert built-in instruct templates (ST 1.18.0).

    System-preset rows (user_id NULL) are inserted or refreshed in place.
    User-created templates are never touched. System presets cannot be
    deleted by users, only updated.
    """
    from .core.instruct_template_seeds import BUILTIN_INSTRUCT_TEMPLATES
    from .models import InstructTemplate

    for seed in BUILTIN_INSTRUCT_TEMPLATES:
        existing = (
            db.query(InstructTemplate)
            .filter(
                InstructTemplate.user_id.is_(None),
                InstructTemplate.name == seed["name"],
            )
            .first()
        )
        if existing is None:
            db.add(InstructTemplate(**seed))
        else:
            # Refresh preset fields but preserve id / timestamps.
            for key, value in seed.items():
                setattr(existing, key, value)


def _init_default_data() -> None:
    """初始化默认数据：admin 用户和系统设置"""
    from .core import SessionLocal
    
    db = SessionLocal()
    try:
        # 创建默认 admin 用户
        admin_user = db.query(User).filter(User.username == "admin").first()
        if not admin_user:
            if settings.ADMIN_PASSWORD:
                admin = User(
                    username="admin",
                    hashed_password=get_password_hash(settings.ADMIN_PASSWORD),
                    role="admin"
                )
                db.add(admin)
                logger.info("已创建 admin 用户，请尽快修改初始密码")
            else:
                logger.warning(
                    "[SECURITY] ADMIN_PASSWORD 未配置，跳过默认 admin 用户创建"
                )
        elif admin_user.hashed_password and verify_password("admin123", admin_user.hashed_password):
            if settings.ADMIN_PASSWORD and settings.ADMIN_PASSWORD != "admin123":
                admin_user.hashed_password = get_password_hash(settings.ADMIN_PASSWORD)
                logger.warning(
                    "[SECURITY] 已检测到默认 admin 密码并自动旋转为 ADMIN_PASSWORD"
                )

        # 创建默认 starter questions
        if not db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first():
            defaults = ["写一篇关于人工智能发展的报告", "解释量子纠缠", "帮我制定一个Python学习计划", "分析一下当前的经济形势"]
            db.add(SystemSetting(key="starter_questions", value=json.dumps(defaults)))
        
        # 初始化默认 model config
        if not db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first():
             db.add(SystemSetting(key="default_model_config", value=json.dumps({})))

        # 初始化内置 context templates (ST 1.18.0)
        _seed_builtin_context_templates(db)

        # 初始化内置 instruct templates (ST 1.18.0)
        _seed_builtin_instruct_templates(db)

        db.commit()
    except Exception as e:
        logger.error(f"初始化默认数据失败: {e}")
        db.rollback()
    finally:
        db.close()


def _migrate_plaintext_api_keys_to_profiles() -> None:
    """一次性迁移：将 providers.json 中的明文 API Key 加密存入 admin 的 ConnectionProfile。

    实际项目中 API Key 存储在全局 providers.json（非 UserSetting）。本迁移仅在
    admin 用户没有任何 ConnectionProfile 时执行：扫描 providers.json，对未使用
    环境变量引用（即明文）的 api_key 加密后创建 profile，第一个标记为激活。
    迁移后不清除 providers.json（保留作为备份）。幂等：admin 已有 profile 时跳过。
    """
    from datetime import datetime, timezone
    from .core import SessionLocal
    from .models import User, ConnectionProfile
    from .services.provider_registry import get_providers, extract_secret_reference
    from .services.crypto_service import encrypt_api_key

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == "admin").first()
        if admin is None:
            return

        existing = db.query(ConnectionProfile).filter(
            ConnectionProfile.user_id == admin.id
        ).count()
        if existing > 0:
            return

        now = datetime.now(timezone.utc)
        providers = get_providers()
        created_any = False
        first_active_set = False
        for provider in providers:
            raw_key = provider.get("api_key")
            if not isinstance(raw_key, str) or not raw_key.strip():
                continue
            # 仅迁移明文 key，跳过环境变量引用（env:VAR / ${VAR}）
            if extract_secret_reference(raw_key) is not None:
                continue

            profile = ConnectionProfile(
                user_id=admin.id,
                name=provider.get("name") or provider.get("id") or "Default",
                provider=provider.get("id") or "custom",
                api_key_encrypted=encrypt_api_key(raw_key.strip()),
                base_url=provider.get("base_url"),
                model_mapping="{}",
                is_active=not first_active_set,
                created_at=now,
                updated_at=now,
            )
            db.add(profile)
            created_any = True
            first_active_set = True

        if created_any:
            db.commit()
            logger.info("已将 providers.json 中的明文 API Key 迁移到 admin 的 ConnectionProfile（原数据保留）")
        else:
            db.rollback()
    except Exception as e:
        logger.error(f"迁移明文 API Key 到 ConnectionProfile 失败: {e}")
        db.rollback()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    logger.info("应用启动中...")
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = max(settings.API_THREADPOOL_TOKENS, 1)
    logger.info("AnyIO 线程池并发令牌设置为: %s", limiter.total_tokens)

    try:
        _initialize_database_once()
    except Exception:
        logger.exception("数据库迁移失败")
        if settings.MIGRATIONS_FAIL_FAST:
            raise
        logger.warning("MIGRATIONS_FAIL_FAST=false，继续启动应用（谨慎）")

    # 一次性迁移：将 providers.json 中的明文 API Key 加密存入 admin 的
    # ConnectionProfile（幂等，失败不阻断启动）
    try:
        _migrate_plaintext_api_keys_to_profiles()
    except Exception:
        logger.exception("明文 API Key 迁移失败（非致命）")

    missing_secret_refs = get_missing_provider_secret_refs()
    if missing_secret_refs:
        refs = ", ".join(
            f"{item['provider_name'] or item['provider_id']} -> {item['env']}"
            for item in missing_secret_refs
        )
        msg = f"Provider env secrets missing: {refs}"
        if settings.PROVIDER_SECRET_CHECK_STRICT:
            logger.error(msg)
            raise RuntimeError(msg)
        logger.warning(msg)

    logger.info("应用启动完成")
    yield
    logger.info("应用关闭中...")

app = FastAPI(
    title="Palink AI Enterprise API v12.7",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# MED-2: CORS 收紧。allow_origins=["*"] 时关闭 allow_credentials——
# 浏览器规定 `*` 与 credentials 不可同时使用，Starlette 会回退为"反射任意 Origin"，
# 等于允许任何网站携带凭据请求本后端。development 模式保持 `*`（直连调试），
# 但不带 credentials（前端认证走 Authorization header，不受影响）；
# 显式域名（APP_ENV != development 时 config 已强制）正常启用 credentials。
_cors_origins = settings.cors_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=not (len(_cors_origins) == 1 and _cors_origins[0] == "*"),
    allow_methods=["*"],
    allow_headers=["*"]
)

app.include_router(api_router)


async def _verify_upload_access(
    request: Request,
    token: str = Query(None, alias="token"),
) -> User:
    auth_token = token
    if not auth_token:
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Authentication required")
        auth_token = auth_header.split(" ", 1)[1]

    try:
        payload = jwt.decode(
            auth_token,
            settings.SECRET_KEY,
            algorithms=["HS256"],
            options={"verify_signature": True},
        )
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        # [N-14] query token 同样受 jti 黑名单约束——登出/封禁后旧 token
        # 不得继续拉取附件（对齐 dependencies.get_current_user 行为）
        from .core.token_blacklist import is_blacklisted
        _jti = payload.get("jti")
        if _jti and is_blacklisted(_jti):
            raise HTTPException(status_code=401, detail="Token has been revoked")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="Invalid credentials")
        db.expunge(user)
        return user
    finally:
        db.close()


def _safe_serve_upload(file_path: str, user_id: int) -> FileResponse:
    safe_dir = os.path.realpath(settings.UPLOAD_DIR)
    user_dir = os.path.realpath(os.path.join(safe_dir, str(user_id)))
    normalized_path = file_path.replace("\\", "/").lstrip("/")
    if normalized_path == str(user_id) or normalized_path.startswith(f"{user_id}/"):
        relative_path = normalized_path
    else:
        relative_path = os.path.join(str(user_id), normalized_path)
    full_path = os.path.realpath(os.path.join(safe_dir, relative_path))
    if not (full_path == user_dir or full_path.startswith(user_dir + os.sep)):
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    # 上传文件按用户目录隔离、文件名唯一；FileResponse 自带 ETag/Last-Modified，
    # 过期后可 304 协商。private 禁止共享代理缓存（内容按用户鉴权），max-age 让
    # 头像等资源免于每个请求都执行 JWT 解码 + 用户查询。
    return FileResponse(full_path, headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/uploads/{file_path:path}")
async def serve_api_upload_file(
    file_path: str,
    request: Request,
    token: str = Query(None, alias="token"),
):
    user = await _verify_upload_access(request, token)
    return _safe_serve_upload(file_path, user.id)


@app.get("/uploads/{file_path:path}")
async def serve_upload_file(
    file_path: str,
    request: Request,
    token: str = Query(None, alias="token"),
):
    user = await _verify_upload_access(request, token)
    return _safe_serve_upload(file_path, user.id)


@app.exception_handler(ServiceError)
async def service_error_handler(request: Request, exc):
    request_id = getattr(request.state, "request_id", "unknown")
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.message,
            "code": exc.code,
            "request_id": request_id,
        },
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    request_id = getattr(request.state, "request_id", "unknown")
    if exc.status_code >= 500:
        logger.error(
            "HTTP %s at %s: %s request_id=%s",
            exc.status_code,
            request.url.path,
            exc.detail,
            request_id,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": "Internal server error", "request_id": request_id},
        )

    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "request_id": request_id},
        headers=exc.headers,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    request_id = getattr(request.state, "request_id", "unknown")
    logger.exception("Unhandled server error at %s request_id=%s", request.url.path, request_id)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
    )


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID", uuid.uuid4().hex[:16])
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response

@app.get("/")
async def root():
    return {"message": "Palink AI API is running"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.get("/ready")
async def readiness_check():
    checks = {}
    overall = "ready"

    try:
        from .core import SessionLocal
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            checks["database"] = "ok"
        finally:
            db.close()
    except Exception as e:
        checks["database"] = "error"
        logger.error("Database health check failed: %s", e)
        overall = "not_ready"

    try:
        upload_dir = settings.UPLOAD_DIR
        if os.path.isdir(upload_dir) and os.access(upload_dir, os.W_OK):
            checks["disk_space"] = "ok"
        else:
            checks["disk_space"] = "upload_dir_not_writable"
            overall = "degraded"
    except Exception as e:
        checks["disk_space"] = "error"
        logger.error("Disk space health check failed: %s", e)
        overall = "degraded"

    status_code = 200 if overall in ("ready", "degraded") else 503
    return JSONResponse(
        status_code=status_code,
        content={"status": overall, "checks": checks},
    )
