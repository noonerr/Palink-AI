from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import json

from ..schemas.character import CharacterCreate, CharacterUpdate
from ..services.character_service import CharacterService
from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User

router = APIRouter(prefix="/api/characters", tags=["characters"])

@router.get("")
async def get_characters(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取用户的所有角色"""
    character_service = CharacterService(db)
    characters = character_service.get_characters(user.id)
    
    result = []
    for c in characters:
        char_data = {
            "id": c.id,
            "name": c.name,
            "description": c.description,
            "avatar": c.avatar,
            "created_at": c.created_at,
            "updated_at": c.updated_at,
            "background": c.background,
            "personality": c.personality,
            "scenario": c.scenario,
            "first_mes": c.first_mes,
            "mes_example": c.mes_example,
            "system_prompt": c.system_prompt,
            "creator": c.creator,
            "character_version": c.character_version,
            "is_processing": c.is_processing or False,
            "processing_status": c.processing_status or ""
        }
        try:
            if c.tags:
                char_data["tags"] = json.loads(c.tags)
            else:
                char_data["tags"] = []
            if c.extensions:
                char_data["extensions"] = json.loads(c.extensions)
            else:
                char_data["extensions"] = {}
        except:
            char_data["tags"] = []
            char_data["extensions"] = {}
        result.append(char_data)
    return result

@router.get("/{character_id}")
async def get_character(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取角色详情"""
    character_service = CharacterService(db)
    character = character_service.get_character(character_id, user.id)
    
    if not character:
        raise HTTPException(404, "Character not found")
    
    user_nickname = character.user_nickname or user.username or "用户"
    
    char_data = {
        "id": character.id,
        "name": character.name,
        "description": character.description,
        "background": character.background,
        "personality": character.personality,
        "avatar": character.avatar,
        "created_at": character.created_at,
        "updated_at": character.updated_at,
        "scenario": character.scenario,
        "first_mes": character.first_mes,
        "mes_example": character.mes_example,
        "system_prompt": character.system_prompt,
        "creator": character.creator,
        "character_version": character.character_version,
        "user_nickname": character.user_nickname,
        "is_processing": character.is_processing or False
    }
    try:
        if character.tags:
            char_data["tags"] = json.loads(character.tags)
        else:
            char_data["tags"] = []
        if character.extensions:
            char_data["extensions"] = json.loads(character.extensions)
        else:
            char_data["extensions"] = {}
    except:
        char_data["tags"] = []
        char_data["extensions"] = {}
    return char_data

@router.post("")
async def create_character(
    req: CharacterCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """创建角色"""
    character_service = CharacterService(db)
    character = character_service.create_character(user.id, req)
    return {"status": "ok", "character": {"id": character.id, "name": character.name}}

@router.put("/{character_id}")
async def update_character(
    character_id: str,
    req: CharacterUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """更新角色"""
    character_service = CharacterService(db)
    character = character_service.update_character(character_id, user.id, req)
    
    if not character:
        raise HTTPException(404, "Character not found")
    
    return {"status": "ok"}

@router.delete("/{character_id}")
async def delete_character(
    character_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除角色"""
    character_service = CharacterService(db)
    success = character_service.delete_character(character_id, user.id)
    
    if not success:
        raise HTTPException(404, "Character not found")
    
    return {"status": "ok"}
