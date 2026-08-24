from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core import get_db
from ..core.cache import cached, invalidate_cache
from ..api.dependencies import get_current_user
from ..models import User, UserSetting
from ..schemas import UserSettingUpdate

router = APIRouter(prefix="/api/users/me", tags=["user-settings"])

_SILLY_TAVERN_MODE_ALIASES = {
    "iframe": "compat",
    "native": "palink-native",
}

# [MODE-SEALED] 2026-08-24 用户拍板：除 palink-native 外的模式运行时封存不可达。
# GET 一律报告 palink-native（前端分支自然走主攻模式）；PUT 提交封存值时直接
# 重定向为 palink-native 落库。DB 存量值不回写（可逆封存）。与 roleplay_prompt_
# assembly.SEALED_ST_MODES 保持同步；解封 = 移除本守卫并恢复下方合法集判定。
_SEALED_ST_MODES = {"compat", "st-compat", "st-native"}
_LEGAL_ST_MODES = {"compat", "st-compat", "st-native", "palink-native"}  # 解封后恢复使用


def _normalize_silly_tavern_mode(mode: str | None) -> str:
    raw = str(mode or "palink-native").strip() or "palink-native"
    normalized = _SILLY_TAVERN_MODE_ALIASES.get(raw, raw)
    if normalized in _LEGAL_ST_MODES and normalized not in _SEALED_ST_MODES:
        return normalized
    return "palink-native"

def _get_or_create_settings(user: User, db: Session) -> UserSetting:
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if not setting:
        setting = UserSetting(user_id=user.id)
        db.add(setting)
        db.flush()
    return setting


@router.get("/settings")
@cached(ttl_seconds=30, key_prefix="user_settings")
async def get_user_settings(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = _get_or_create_settings(user, db)
    return {
        "memory_mode": setting.memory_mode or "rule",
        "memory_model": setting.memory_model,
        "show_model_reasoning": setting.show_model_reasoning if setting.show_model_reasoning is not None else True,
        "developer_mode": setting.developer_mode if setting.developer_mode is not None else False,
        "prompt_language": setting.prompt_language or "auto",
        "character_display_mode": setting.character_display_mode or "framed",
        "author_note": setting.author_note or "",
        "author_note_position": setting.author_note_position if setting.author_note_position is not None else 1,
        "author_note_frequency": setting.author_note_frequency if setting.author_note_frequency is not None else 0,
        "author_note_depth": setting.author_note_depth if setting.author_note_depth is not None else 4,
        "show_character_status": setting.show_character_status if setting.show_character_status is not None else False,
        "auto_generate_chat_images": setting.auto_generate_chat_images if setting.auto_generate_chat_images is not None else False,
        "silly_tavern_mode": _normalize_silly_tavern_mode(setting.silly_tavern_mode),
        "silly_tavern_theme": setting.silly_tavern_theme or "palink",
        "active_persona_id": setting.active_persona_id,
        "power_user": setting.power_user if setting.power_user is not None else "{}",
        "mvu_secondary_model": setting.mvu_secondary_model,
        "mvu_secondary_enabled": setting.mvu_secondary_enabled if setting.mvu_secondary_enabled is not None else False,
    }


@router.put("/settings")
async def update_user_settings(req: UserSettingUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = _get_or_create_settings(user, db)
    if req.memory_mode is not None:
        setting.memory_mode = req.memory_mode
    if req.memory_model is not None:
        setting.memory_model = req.memory_model
    if req.show_model_reasoning is not None:
        setting.show_model_reasoning = req.show_model_reasoning
    if req.developer_mode is not None:
        setting.developer_mode = req.developer_mode
    if req.prompt_language is not None:
        setting.prompt_language = req.prompt_language
    if req.character_display_mode is not None:
        setting.character_display_mode = req.character_display_mode
    if req.author_note is not None:
        setting.author_note = req.author_note
    if req.author_note_position is not None:
        setting.author_note_position = req.author_note_position
    if req.author_note_frequency is not None:
     setting.author_note_frequency = req.author_note_frequency
    if req.author_note_depth is not None:
        setting.author_note_depth = req.author_note_depth
    if req.custom_chat_prompt_zh is not None:
        setting.custom_chat_prompt_zh = req.custom_chat_prompt_zh
    if req.custom_chat_prompt_en is not None:
        setting.custom_chat_prompt_en = req.custom_chat_prompt_en
    if req.custom_character_prompt_zh is not None:
        setting.custom_character_prompt_zh = req.custom_character_prompt_zh
    if req.custom_character_prompt_en is not None:
        setting.custom_character_prompt_en = req.custom_character_prompt_en
    if req.use_custom_prompts is not None:
        setting.use_custom_prompts = req.use_custom_prompts
    if req.show_character_status is not None:
        setting.show_character_status = req.show_character_status
    if req.auto_generate_chat_images is not None:
        setting.auto_generate_chat_images = req.auto_generate_chat_images
    if req.silly_tavern_mode is not None:
        setting.silly_tavern_mode = _normalize_silly_tavern_mode(req.silly_tavern_mode)
    if req.silly_tavern_theme is not None:
        setting.silly_tavern_theme = req.silly_tavern_theme
    if req.active_persona_id is not None:
        setting.active_persona_id = req.active_persona_id or None
    if req.power_user is not None:
        setting.power_user = req.power_user
    if req.mvu_secondary_model is not None:
        setting.mvu_secondary_model = req.mvu_secondary_model or None
    if req.mvu_secondary_enabled is not None:
        setting.mvu_secondary_enabled = req.mvu_secondary_enabled
    db.commit()
    # Phase 7 SubTask 7.1: 缓存失效 prefix 必须与 _build_key 生成的 key 完全匹配。
    # _build_key 在 kwargs 路径下使用 f"{k}={v.id}" 格式（cache.py:81），
    # FastAPI 通过 **kwargs 传入 Depends() 解析后的 user，所以实际缓存 key 为
    # "user_settings:user=<id>"。仅用 "user_settings:<id>" 作为 prefix 不会匹配，
    # 导致 30s TTL 内 PUT 后 GET 返回旧值。修复：补上 "user=" 前缀。
    invalidate_cache(f"user_settings:user={user.id}")
    if req.developer_mode is not None:
        # developer_mode 切换只影响该用户的 /api/models 返回值（添加/移除 test_model）
        # 因此只清自己的 models 缓存，避免误伤其他用户
        invalidate_cache(f"models:user={user.id}")
    return {"status": "ok"}
