import json
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean
from sqlalchemy.orm import validates
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


# ST 1.18.0 extension_prompt position 枚举（与 script.js:491-496 完全对齐）
# -1 = NONE          不注入
#  0 = IN_PROMPT     作为 system prompt 追加到末尾（position='end'），不按 depth
#  1 = IN_CHAT       按 depth 插入到 chat history
#  2 = BEFORE_PROMPT 作为 system prompt 插入到最前（position='start'），不按 depth
EXTENSION_PROMPT_POSITION_NONE = -1
EXTENSION_PROMPT_POSITION_IN_PROMPT = 0
EXTENSION_PROMPT_POSITION_IN_CHAT = 1
EXTENSION_PROMPT_POSITION_BEFORE_PROMPT = 2
EXTENSION_PROMPT_POSITION_MIN = -1
EXTENSION_PROMPT_POSITION_MAX = 2


class ExtensionPrompt(Base):
    __tablename__ = "extension_prompts"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, nullable=False)
    session_id = Column(String, nullable=True)
    identifier = Column(String, nullable=False)
    content = Column(Text, nullable=True)
    position = Column(Integer, default=-1)
    depth = Column(Integer, default=4)
    # role 在 DB 中统一存储为 String（向后兼容）。
    # ST extension_prompt_roles: 0=SYSTEM, 1=USER, 2=ASSISTANT（int 值由 API/collect 层归一化为 str）。
    role = Column(String, default="system")
    enabled = Column(Boolean, default=True)
    # P2-7 修复: scan 字段 — 对齐 ST 1.18.0 extension_prompt.scan 语义
    # (openai.js: setExtensionPrompt)。当 scan=true 时，extension_prompt 的 content
    # 会在注入前执行 macro 替换（{{char}}/{{user}}/{{pick}} 等），使其能动态求值。
    # 默认 False：保持 ST 默认行为（不扫描）。
    scan = Column(Boolean, default=False, nullable=False)
    # filter 字段：JSON 文本存储 character_ids / session_ids 过滤配置。
    # 结构：{"character_ids": [...], "session_ids": [...]}
    # 兼容旧版前端发送的 List[str] 形式（仅 character_ids）。
    filter = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)

    @validates("position")
    def _validate_position(self, key, value):
        if value is None:
            return EXTENSION_PROMPT_POSITION_NONE
        try:
            pos = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"extension_prompts.position must be an integer, got {value!r}")
        if pos < EXTENSION_PROMPT_POSITION_MIN or pos > EXTENSION_PROMPT_POSITION_MAX:
            raise ValueError(
                f"extension_prompts.position must be in [{EXTENSION_PROMPT_POSITION_MIN}, {EXTENSION_PROMPT_POSITION_MAX}], got {pos}"
            )
        return pos

    def get_filter(self) -> dict:
        """解析 filter 字段为 dict。返回空 dict 表示无过滤。"""
        raw = self.filter
        if not raw:
            return {}
        if isinstance(raw, dict):
            return raw
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}

    def set_filter(self, value) -> None:
        """将 dict 序列化为 JSON 文本存储。None / 空 / list 时按兼容规则存储。"""
        if value is None:
            self.filter = None
            return
        if isinstance(value, list):
            # 兼容旧版 List[str] 形式：视为 character_ids
            value = {"character_ids": list(value)}
        if not isinstance(value, dict):
            raise ValueError(f"extension_prompts.filter must be dict or list, got {type(value).__name__}")
        self.filter = json.dumps(value, ensure_ascii=False)
