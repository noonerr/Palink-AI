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

from .core import settings, engine, run_migrations, get_password_hash
from .core.exceptions import ServiceError
from .api import api_router
from .models import Base, User, SystemSetting
from .services.provider_registry import get_missing_provider_secret_refs

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("PalinkAI")


def _initialize_database_once() -> None:
    lock_file = settings.STARTUP_INIT_LOCK_FILE
    done_file = settings.STARTUP_INIT_DONE_FILE

    if fcntl is None:
        logger.warning("fcntl 不可用，按单进程模式执行数据库初始化")
        Base.metadata.create_all(bind=engine)
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
            return

        Base.metadata.create_all(bind=engine)
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


def _init_default_data() -> None:
    """初始化默认数据：admin 用户和系统设置"""
    from .core import SessionLocal
    
    db = SessionLocal()
    try:
        # 创建默认 admin 用户
        if not db.query(User).filter(User.username == "admin").first():
            admin = User(
                username="admin",
                hashed_password=get_password_hash(settings.ADMIN_PASSWORD),
                role="admin"
            )
            db.add(admin)
            logger.info("已创建默认 admin 用户，请尽快修改默认密码")
        
        # 创建默认 starter questions
        if not db.query(SystemSetting).filter(SystemSetting.key == "starter_questions").first():
            defaults = ["写一篇关于人工智能发展的报告", "解释量子纠缠", "帮我制定一个Python学习计划", "分析一下当前的经济形势"]
            db.add(SystemSetting(key="starter_questions", value=json.dumps(defaults)))
        
        # 初始化默认 model config
        if not db.query(SystemSetting).filter(SystemSetting.key == "default_model_config").first():
             db.add(SystemSetting(key="default_model_config", value=json.dumps({})))
        
        db.commit()
    except Exception as e:
        logger.error(f"初始化默认数据失败: {e}")
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

app.include_router(api_router)


async def _verify_upload_access(
    request: Request,
    token: str = Query(None, alias="token"),
) -> None:
    if token:
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"], options={"verify_signature": True})
            username: str = payload.get("sub")
            if username is None:
                raise HTTPException(status_code=401, detail="Invalid token")
            exp = payload.get("exp")
            if exp is not None:
                from datetime import datetime, timezone
                if datetime.now(timezone.utc).timestamp() > exp:
                    raise HTTPException(status_code=401, detail="Token expired")
        except jwt.PyJWTError:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        return

    from .api.dependencies import get_current_user
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    from .core import SessionLocal
    db = SessionLocal()
    try:
        bearer_token = auth_header.split(" ", 1)[1]
        payload = jwt.decode(bearer_token, settings.SECRET_KEY, algorithms=["HS256"], options={"verify_signature": True})
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        from .models import User
        user = db.query(User).filter(User.username == username).first()
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="Invalid credentials")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    finally:
        db.close()


def _safe_serve_upload(file_path: str) -> FileResponse:
    safe_dir = os.path.realpath(settings.UPLOAD_DIR)
    full_path = os.path.realpath(os.path.join(safe_dir, file_path))
    if not (full_path == safe_dir or full_path.startswith(safe_dir + os.sep)):
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(full_path)


@app.get("/api/uploads/{file_path:path}")
async def serve_api_upload_file(
    file_path: str,
    request: Request,
    token: str = Query(None, alias="token"),
):
    await _verify_upload_access(request, token)
    return _safe_serve_upload(file_path)


@app.get("/uploads/{file_path:path}")
async def serve_upload_file(
    file_path: str,
    request: Request,
    token: str = Query(None, alias="token"),
):
    await _verify_upload_access(request, token)
    return _safe_serve_upload(file_path)


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
        checks["database"] = f"error: {str(e)[:100]}"
        overall = "not_ready"

    try:
        upload_dir = settings.UPLOAD_DIR
        if os.path.isdir(upload_dir) and os.access(upload_dir, os.W_OK):
            checks["disk_space"] = "ok"
        else:
            checks["disk_space"] = "upload_dir_not_writable"
            overall = "degraded"
    except Exception as e:
        checks["disk_space"] = f"error: {str(e)[:100]}"
        overall = "degraded"

    status_code = 200 if overall in ("ready", "degraded") else 503
    return JSONResponse(
        status_code=status_code,
        content={"status": overall, "checks": checks},
    )
