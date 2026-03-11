from fastapi import APIRouter

from .chat import router as chat_router
from .character import router as character_router
from .auth import router as auth_router
from .users import router as users_router
from .sessions import router as sessions_router
from .workspace import router as workspace_router
from .models import router as models_router
from .admin import router as admin_router
from .recommendations import router as recommendations_router
from .memory import router as memory_router
from .character_ext import router_characters, router_sessions as char_sessions_router, router_chat
from .worldbook import router as worldbook_router, router_session_wb as worldbook_session_router
from .plotline import router as plotline_router, router_session_pl as plotline_session_router
from .stats import router as stats_router

api_router = APIRouter()

api_router.include_router(chat_router)
api_router.include_router(character_router)
api_router.include_router(auth_router)
api_router.include_router(users_router)
api_router.include_router(sessions_router)
api_router.include_router(workspace_router)
api_router.include_router(models_router)
api_router.include_router(admin_router)
api_router.include_router(recommendations_router)
api_router.include_router(memory_router)
api_router.include_router(router_characters)
api_router.include_router(char_sessions_router)
api_router.include_router(router_chat)
api_router.include_router(worldbook_router)
api_router.include_router(worldbook_session_router)
api_router.include_router(plotline_router)
api_router.include_router(plotline_session_router)
api_router.include_router(stats_router)
