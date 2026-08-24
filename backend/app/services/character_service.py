import json
import logging
import shutil
from pathlib import Path
from typing import List, Optional
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..models import (
    Character,
    CharacterChatSession,
    CharacterChatMessage,
    CharacterChatSessionBranch,
    ChatVariable,
    GroupChat,
    User,
)

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
            user_nickname=character_data.user_nickname,
            alternate_greetings=json.dumps(character_data.alternate_greetings, ensure_ascii=False) if character_data.alternate_greetings is not None else None,
            creator_notes=character_data.creator_notes,
            post_history_instructions=character_data.post_history_instructions,
            ui_config=json.dumps(character_data.ui_config, ensure_ascii=False) if character_data.ui_config is not None else None,
            talkativeness=character_data.talkativeness,
            nickname=character_data.nickname,
            group_only_greetings=json.dumps(character_data.group_only_greetings, ensure_ascii=False) if getattr(character_data, 'group_only_greetings', None) is not None else None
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
        if character_data.preset_data is not None:
            character.preset_data = json.dumps(character_data.preset_data, ensure_ascii=False)
        if character_data.alternate_greetings is not None:
            character.alternate_greetings = json.dumps(character_data.alternate_greetings, ensure_ascii=False)
        if character_data.creator_notes is not None:
            character.creator_notes = character_data.creator_notes
        if character_data.post_history_instructions is not None:
            character.post_history_instructions = character_data.post_history_instructions
        if character_data.ui_config is not None:
            character.ui_config = json.dumps(character_data.ui_config, ensure_ascii=False)
        if getattr(character_data, 'talkativeness', None) is not None:
            character.talkativeness = character_data.talkativeness
        if getattr(character_data, 'nickname', None) is not None:
            character.nickname = character_data.nickname
        if getattr(character_data, 'group_only_greetings', None) is not None:
            character.group_only_greetings = json.dumps(character_data.group_only_greetings, ensure_ascii=False)

        self.db.commit()
        self.db.refresh(character)
        return character
    
    def delete_character(self, character_id: str, user_id: int) -> bool:
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

                    # 清理 ChatVariable 孤儿记录（无 ForeignKey，需手动删除）
                    self.db.query(ChatVariable).filter(
                        ChatVariable.session_id.in_(batch)
                    ).delete(synchronize_session=False)

                    # [ORPHAN-MEM-FIX] 级联清理向量记忆（conversation_memories.session_id
                    # 为裸 TEXT 无 ForeignKey，不删则随角色删除留下孤儿记忆。
                    # 2026-08-24 排查实锤：44 条全量孤儿均源于此）
                    _mem_ph = ", ".join([f":s{j}" for j in range(len(batch))])
                    _mem_params = {f"s{j}": sid for j, sid in enumerate(batch)}
                    self.db.execute(
                        text(f"DELETE FROM conversation_memories WHERE session_id IN ({_mem_ph})"),
                        _mem_params,
                    )

                    self.db.query(CharacterChatSession).filter(
                        CharacterChatSession.id.in_(batch)
                    ).delete(synchronize_session=False)

            # 清理 GroupChat.member_ids / disabled_members 中的引用
            groups = self.db.query(GroupChat).filter(GroupChat.user_id == user_id).all()
            for g in groups:
                member_ids = json.loads(g.member_ids or "[]")
                disabled = json.loads(g.disabled_members or "[]")
                changed = False
                if character_id in member_ids:
                    member_ids.remove(character_id)
                    g.member_ids = json.dumps(member_ids)
                    changed = True
                if character_id in disabled:
                    disabled.remove(character_id)
                    g.disabled_members = json.dumps(disabled)
                    changed = True
                if changed:
                    self.db.add(g)

            # 缓存角色名用于后续文件清理
            char_name = character.name or "character"

            # 缓存角色的世界书 ID，用于后续 ST DATA_ROOT worlds 文件清理
            # （WorldBook 与 Character 是 cascade 关系，commit 后记录会被删除）
            from ..models.worldbook import WorldBook
            world_book_ids = [
                wb.id for wb in
                self.db.query(WorldBook).filter(WorldBook.character_id == character_id).all()
            ]

            self.db.delete(character)
            self.db.commit()

            # 清理 ST DATA_ROOT 文件（提交后执行，避免回滚后文件已删）
            self._cleanup_st_data_root_files(
                user_id, character_id, char_name, session_ids, world_book_ids,
            )

            return True
        except Exception as e:
            logger.error(f"Error deleting character: {e}")
            self.db.rollback()
            raise

    def _cleanup_st_data_root_files(
        self,
        user_id: int,
        character_id: str,
        char_name: str,
        session_ids: list[str],
        world_book_ids: list[str] | None = None,
    ) -> None:
        """清理 ST DATA_ROOT 中与角色相关的文件。

        删除：角色卡 PNG/JSON、聊天目录、变量文件、世界书文件（含角色书）。
        失败不影响主请求（仅 log warning）。
        """
        try:
            # 查找用户的 ST DATA_ROOT
            user = self.db.query(User).filter(User.id == user_id).first()
            if not user:
                return

            # 复用 st_sync_service 的路径函数
            from ..services.st_sync_service import _st_data_root_for_user, _avatar_key, _world_file_name

            data_root = _st_data_root_for_user(user)
            if not data_root or not Path(data_root).exists():
                return

            data_root = Path(data_root)
            avatar_key = _avatar_key(character_id)

            # 删除角色卡文件（.png 和 .png.json）
            for ext in (".png", ".png.json"):
                p = data_root / "characters" / f"{avatar_key}{ext}"
                if p.exists():
                    try:
                        p.unlink()
                    except OSError as e:
                        logger.warning("Failed to delete %s: %s", p, e)

            # 删除聊天目录（以角色名命名）
            chat_dir = data_root / "chats" / char_name
            if chat_dir.exists():
                try:
                    shutil.rmtree(chat_dir, ignore_errors=True)
                except OSError as e:
                    logger.warning("Failed to delete chat dir %s: %s", chat_dir, e)

            # 删除变量文件
            for s_id in session_ids:
                var_path = data_root / "variables" / f"palink-session-{s_id}.json"
                if var_path.exists():
                    try:
                        var_path.unlink()
                    except OSError as e:
                        logger.warning("Failed to delete %s: %s", var_path, e)

            # 删除世界书文件（含角色书 world_book / character_book）。
            # sync_worldbook_to_st 会为非 character_book 类型的世界书落盘
            # worlds/palink-world-{id}.json；character_book 嵌入角色卡 JSON，
            # 删除角色卡时已一并清理。这里清理独立的 worlds 文件。
            if world_book_ids:
                worlds_dir = data_root / "worlds"
                for wb_id in world_book_ids:
                    world_path = worlds_dir / _world_file_name(wb_id)
                    if world_path.exists():
                        try:
                            world_path.unlink()
                        except OSError as e:
                            logger.warning("Failed to delete %s: %s", world_path, e)
        except Exception as e:
            logger.warning("ST DATA_ROOT cleanup failed for character %s: %s", character_id, e)
    
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
