from fastapi import APIRouter, Depends

from ..core.csrf_guard import csrf_guard
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
from .worldbook_blueprints import router as worldbook_blueprints_router
from .plotline import router as plotline_router, router_session_pl as plotline_session_router
from .stats import router as stats_router
from .mcp import router as mcp_router
from .presets import router as presets_router
from .context_templates import router as context_templates_router
from .instruct_templates import router as instruct_templates_router
from .variables import router as variables_router
from .prompt_manager import router as prompt_manager_router
from .personas import router as personas_router
from .extension_prompts import router as extension_prompts_router
from .websocket import router as websocket_router
from .tts import router as tts_router
from .image_generation import router as image_generation_router
from .plugins import router as plugins_router
from .smart_card_assets import router as smart_card_assets_router
from .openai_compat import router as openai_compat_router
from .silly_tavern import router as silly_tavern_router
from .st_sync import router as st_sync_router
from .st_groups import router as st_groups_router
from .regex_scripts import router as regex_scripts_router
from .tokenizer import router as tokenizer_router
from .expressions import router as expressions_router
from .sd import router as sd_router
from .backgrounds import router as backgrounds_router
from .st_resources import router as st_resources_router
from .stt import router as stt_router
from .connection_profiles import router as connection_profiles_router
from .themes import router as themes_router
from .live2d_pool import router as live2d_pool_router

api_router = APIRouter()

api_router.include_router(chat_router)
# MED-4: ST 兼容 router 统一挂 CSRF guard。ST 原生前端以 cookie 认证并携带
# X-CSRF-Token；guard 对安全方法/带 Bearer 的请求放行，只拦"纯 cookie 跨站写请求"。
api_router.include_router(silly_tavern_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(st_sync_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(st_groups_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(regex_scripts_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(expressions_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(sd_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(st_resources_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(backgrounds_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(stt_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(connection_profiles_router, dependencies=[Depends(csrf_guard)])
api_router.include_router(themes_router, dependencies=[Depends(csrf_guard)])
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
api_router.include_router(worldbook_blueprints_router)
api_router.include_router(plotline_router)
api_router.include_router(plotline_session_router)
api_router.include_router(stats_router)
api_router.include_router(mcp_router)
api_router.include_router(presets_router)
api_router.include_router(context_templates_router)
api_router.include_router(instruct_templates_router)
api_router.include_router(variables_router)
api_router.include_router(prompt_manager_router)
api_router.include_router(personas_router)
api_router.include_router(extension_prompts_router)
api_router.include_router(websocket_router)
api_router.include_router(tts_router)
api_router.include_router(image_generation_router)
api_router.include_router(plugins_router)
api_router.include_router(smart_card_assets_router)
api_router.include_router(openai_compat_router)
api_router.include_router(regex_scripts_router)
api_router.include_router(tokenizer_router)
api_router.include_router(expressions_router)
api_router.include_router(sd_router)
api_router.include_router(st_resources_router)
api_router.include_router(backgrounds_router)
api_router.include_router(stt_router)
api_router.include_router(connection_profiles_router)
api_router.include_router(themes_router)
api_router.include_router(live2d_pool_router)
