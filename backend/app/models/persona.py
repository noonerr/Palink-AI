import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean
from .base import Base


def utc_now():
    return datetime.now(timezone.utc)


class Persona(Base):
    __tablename__ = "personas"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    avatar = Column(String, nullable=True)
    character_bindings = Column(Text, nullable=True)
    is_default = Column(Boolean, default=False)
    # ST 1.18.0 persona description injection controls.
    # persona_show: whether the description is injected into the prompt.
    # persona_description_position: **ST 1.18 枚举**（personas.js:88-97）
    #   0 = IN_PROMPT   (追加到 system_prompt；ST 为独立 userPersona 块)
    #   1 = AFTER_CHAR  (已废弃，按 IN_PROMPT 处理)
    #   2 = TOP_AN      (并入作者注记顶部；AN 为空时按 AT_DEPTH 兜底)
    #   3 = BOTTOM_AN   (并入作者注记底部；AN 为空时作为最后一条 system 消息)
    #   4 = AT_DEPTH    (对话中第 depth 条前，depth=4)
    #   9 = NONE        (不注入)
    # ⚠ 2026-09-08 起由旧 Palink 值域（0=对话中/1=system尾/2=聊天尾/3=不注入）
    #   切换到 ST 枚举，两者**数值冲突**（尤其 2 和 3）。default 同步改为
    #   4(AT_DEPTH) 以维持原「对话中」的默认体验。存量行不迁移：
    #   0/1/2 只是注入位置变化，不会丢失或凭空注入。
    persona_show = Column(Boolean, default=False)
    persona_description_position = Column(Integer, default=4)
    # ST 1.18.0 persona_description_depth（personas.js:632）：仅 AT_DEPTH(4) 时生效，
    # 表示人设注入到「从消息末尾往回数第 N 条」之前。默认 4 与 ST DEFAULT_DEPTH 一致。
    persona_description_depth = Column(Integer, default=4)
    # [ST-BRIDGE-PERSONA 2026-10-20 批次B] ST persona.d.ts:6-18 的另三个字段。
    # 用户 2026-10-20 拍板「与 ST 冲突时以 ST 为准」⇒ 补列而非裁剪：
    # 不补列这三个字段就「写进去读不回来」，正是本仓最重的假实现红线。
    # title=消息上方 persona 标题；role=注入 role（ST 0=system/1=user/2=assistant）；
    # lorebook=persona 绑定的世界书名。均可空、不回填存量行（只加列）。
    title = Column(String, nullable=True)
    role = Column(Integer, nullable=True)
    lorebook = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
