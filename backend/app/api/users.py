from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core import get_db
from ..core.cache import cached, invalidate_cache
from ..api.dependencies import get_current_user
from ..models import User, UserSetting
from ..schemas import UserSettingUpdate
# [MVU-SECONDARY-PARAMS 2026-10-05] 副模型采样参数的默认值与夹紧函数取自
# services/mvu_secondary.py（唯一真源），本文件不另抄一份常量。
from ..services.mvu_secondary import (
    DEFAULT_SECONDARY_MAX_TOKENS,
    DEFAULT_SECONDARY_RETRIES,
    DEFAULT_SECONDARY_TEMPERATURE,
    clamp_secondary_max_tokens,
    clamp_secondary_retries,
    clamp_secondary_temperature,
)

router = APIRouter(prefix="/api/users/me", tags=["user-settings"])

def _get_or_create_settings(user: User, db: Session) -> UserSetting:
    setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
    if not setting:
        setting = UserSetting(user_id=user.id)
        db.add(setting)
        try:
            db.flush()
        except IntegrityError:
            # 反向验证修复（批次 F）: 并发首建竞态防护（详见 silly_tavern.py
            # _get_or_create_user_setting 注释）——回滚后改读既有行。
            db.rollback()
            setting = db.query(UserSetting).filter(UserSetting.user_id == user.id).first()
            if setting is None:
                raise
    return setting


@router.get("/quota")
async def get_my_quota(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """当前用户的 token 额度状态（供用量统计页展示）。无行/NULL = 不限。"""
    from ..services.quota_service import get_quota_state

    return get_quota_state(db, user.id)


@router.get("/settings")
@cached(ttl_seconds=30, key_prefix="user_settings")
async def get_user_settings(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = _get_or_create_settings(user, db)
    return {
        "memory_mode": setting.memory_mode or "vector",
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
        # silly_tavern_mode/silly_tavern_theme 已于 2026-09-04 A1 删除（alembic 0062）
        "active_persona_id": setting.active_persona_id,
        "power_user": setting.power_user if setting.power_user is not None else "{}",
        "mvu_secondary_model": setting.mvu_secondary_model,
        "mvu_secondary_enabled": setting.mvu_secondary_enabled if setting.mvu_secondary_enabled is not None else False,
        # [MVU-SECONDARY-PARAMS 2026-10-05] 未设置时回落到代码内默认值，
        # 前端可直接展示"当前实际生效值"。
        "mvu_secondary_temperature": setting.mvu_secondary_temperature if setting.mvu_secondary_temperature is not None else DEFAULT_SECONDARY_TEMPERATURE,
        "mvu_secondary_max_tokens": setting.mvu_secondary_max_tokens if setting.mvu_secondary_max_tokens is not None else DEFAULT_SECONDARY_MAX_TOKENS,
        "mvu_secondary_retries": setting.mvu_secondary_retries if setting.mvu_secondary_retries is not None else DEFAULT_SECONDARY_RETRIES,
        "memory_budget_level": setting.memory_budget_level if setting.memory_budget_level is not None else 1,
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
    # silly_tavern_mode/silly_tavern_theme PUT 写入已随 A1 删除（schema 不再接受）
    if req.active_persona_id is not None:
        setting.active_persona_id = req.active_persona_id or None
    if req.power_user is not None:
        setting.power_user = req.power_user
    if req.mvu_secondary_model is not None:
        setting.mvu_secondary_model = req.mvu_secondary_model or None
    if req.mvu_secondary_enabled is not None:
        setting.mvu_secondary_enabled = req.mvu_secondary_enabled
    # [MVU-SECONDARY-PARAMS 2026-10-05] 采样参数防呆夹紧（同 memory_budget_level 口径）：
    # temperature 0-2 / max_tokens 256-8192 / retries 0-3。
    # 越界或不可解析一律夹/回落到默认值，避免手滑把 token 拉到爆额度。
    if req.mvu_secondary_temperature is not None:
        setting.mvu_secondary_temperature = clamp_secondary_temperature(req.mvu_secondary_temperature)
    if req.mvu_secondary_max_tokens is not None:
        setting.mvu_secondary_max_tokens = clamp_secondary_max_tokens(req.mvu_secondary_max_tokens)
    if req.mvu_secondary_retries is not None:
        setting.mvu_secondary_retries = clamp_secondary_retries(req.mvu_secondary_retries)
    if req.memory_budget_level is not None:
        # 分层记忆 Phase 1：档位防呆，越界值归标准档 1
        setting.memory_budget_level = req.memory_budget_level if req.memory_budget_level in (0, 1, 2, 3) else 1
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
