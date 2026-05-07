import json
import logging
from typing import List, Optional
from sqlalchemy.orm import Session

from ..models import Character, CharacterChatSession, CharacterChatMessage, CharacterChatSessionBranch

logger = logging.getLogger(__name__)

class CharacterService:
    """角色服务 - 处理角色相关的业务逻辑"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def create_character(self, user_id: int, character_data) -> Character:
        """创建角色"""
        character = Character(
            user_id=user_id,
            name=character_data.name,
            description=character_data.description,
            background=character_data.background,
            personality=character_data.personality,
            avatar=character_data.avatar,
            scenario=character_data.scenario,
            first_mes=character_data.first_mes,
            mes_example=character_data.mes_example,
            system_prompt=character_data.system_prompt,
            tags=json.dumps(character_data.tags, ensure_ascii=False) if character_data.tags is not None else None,
            creator=character_data.creator,
            character_version=character_data.character_version,
            extensions=json.dumps(character_data.extensions, ensure_ascii=False) if character_data.extensions is not None else None,
            user_nickname=character_data.user_nickname
        )
        self.db.add(character)
        self.db.commit()
        self.db.refresh(character)
        return character
    
    def update_character(self, character_id: str, user_id: int, character_data) -> Optional[Character]:
        """更新角色"""
        character = self.db.query(Character).filter(
            Character.id == character_id,
            Character.user_id == user_id
        ).first()
        
        if not character:
            return None
        
        if character_data.name is not None:
            character.name = character_data.name
        if character_data.description is not None:
            character.description = character_data.description
        if character_data.background is not None:
            character.background = character_data.background
        if character_data.personality is not None:
            character.personality = character_data.personality
        if character_data.avatar is not None:
            character.avatar = character_data.avatar
        if character_data.scenario is not None:
            character.scenario = character_data.scenario
        if character_data.first_mes is not None:
            character.first_mes = character_data.first_mes
        if character_data.mes_example is not None:
            character.mes_example = character_data.mes_example
        if character_data.system_prompt is not None:
            character.system_prompt = character_data.system_prompt
        if character_data.tags is not None:
            character.tags = json.dumps(character_data.tags, ensure_ascii=False)
        if character_data.creator is not None:
            character.creator = character_data.creator
        if character_data.character_version is not None:
            character.character_version = character_data.character_version
        if character_data.extensions is not None:
            character.extensions = json.dumps(character_data.extensions, ensure_ascii=False)
        if character_data.user_nickname is not None:
            character.user_nickname = character_data.user_nickname
        
        self.db.commit()
        self.db.refresh(character)
        return character
    
    def delete_character(self, character_id: str, user_id: int) -> bool:
        """删除角色"""
        character = self.db.query(Character).filter(
            Character.id == character_id,
            Character.user_id == user_id
        ).first()
        
        if not character:
            return False
        
        try:
            sessions = self.db.query(CharacterChatSession).filter(
                CharacterChatSession.character_id == character_id
            ).all()
            session_ids = [s.id for s in sessions]
            
            if session_ids:
                batch_size = 500
                for i in range(0, len(session_ids), batch_size):
                    batch = session_ids[i:i + batch_size]
                    self.db.query(CharacterChatMessage).filter(
                        CharacterChatMessage.session_id.in_(batch)
                    ).delete(synchronize_session=False)
                    
                    self.db.query(CharacterChatSessionBranch).filter(
                        CharacterChatSessionBranch.session_id.in_(batch)
                    ).delete(synchronize_session=False)
                    
                    self.db.query(CharacterChatSession).filter(
                        CharacterChatSession.id.in_(batch)
                    ).delete(synchronize_session=False)
            
            self.db.delete(character)
            self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error deleting character: {e}")
            self.db.rollback()
            return False
    
    def get_character(self, character_id: str, user_id: int) -> Optional[Character]:
        """获取角色信息"""
        return self.db.query(Character).filter(
            Character.id == character_id,
            Character.user_id == user_id
        ).first()
    
    def get_characters(self, user_id: int) -> List[Character]:
        """获取用户的所有角色"""
        return self.db.query(Character).filter(
            Character.user_id == user_id
        ).order_by(Character.updated_at.desc()).all()
