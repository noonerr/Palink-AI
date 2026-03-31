from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import logging

from .core import settings, engine, run_migrations
from .api import api_router
from .models import Base

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("PalinkAI")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    logger.info("应用启动中...")
    Base.metadata.create_all(bind=engine)
    logger.info("数据库表创建完成")
    run_migrations(engine)
    logger.info("数据库迁移完成")
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
