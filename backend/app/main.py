from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import logging
import os
import anyio.to_thread

try:
    import fcntl
except ImportError:
    fcntl = None

from .core import settings, engine, run_migrations
from .api import api_router
from .models import Base
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

        with open(done_file, "w", encoding="utf-8") as done_fp:
            done_fp.write(str(os.getpid()))

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
    lifespan=lifespan
)

app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

app.include_router(api_router)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if exc.status_code >= 500:
        logger.error(
            "HTTP %s at %s: %s",
            exc.status_code,
            request.url.path,
            exc.detail,
        )
        return JSONResponse(status_code=exc.status_code, content={"detail": "Internal server error"})

    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=exc.headers,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled server error at %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

@app.get("/")
async def root():
    return {"message": "Palink AI API is running"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}
