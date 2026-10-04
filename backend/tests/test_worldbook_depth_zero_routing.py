"""MVU 变量更新指令让位卡片自带声明（2026-10-05）的两处回归。

1. `worldbook_service` 的 atDepth 路由：`entry.depth or 4` 会把 ST 的合法值
   depth=0（= 插到对话最末尾，紧贴模型下一次输出）吃成 4，使卡片自带的
   `[mvu_update]变量输出格式` 落不到尾部，被后端写死的变量指令抢位。
2. `roleplay_prompt_assembly` 的 user-tail：卡片已声明规范时不再叠加我们的模板；
   兜底模板里**不允许出现任何具体角色名/字段名**（旧模板的 `/桃汐/好感度`、
   `/世界信息/日期时间` 曾被模型当成结构定义照抄，把卡片声明的对象覆盖成字符串）。
"""

import json
import os
import sys
import uuid

import pytest
from sqlalchemy.orm import Session

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    _MVU_GENERIC_TAIL,
    _messages_declare_mvu_update_spec,
)
from app.services.worldbook_service import (  # noqa: E402
    WI_POS_AT_DEPTH,
    build_worldbook_context,
)


def _mk_stage(eid: str, content: str, *, depth, constant: bool = True) -> WorldBookStage:
    kwargs = dict(
        id=eid,
        world_book_id="wb-d0",
        stage_index=0,
        title=eid,
        content=content,
        keys=json.dumps([]),
        secondary_keys=json.dumps([]),
        position=WI_POS_AT_DEPTH,
        constant=constant,
        enabled=True,
        selective=False,
        selective_logic=0,
        probability=100,
        order=100,
        role=0,
    )
    if depth is not None:
        kwargs["depth"] = depth
    return WorldBookStage(**kwargs)


@pytest.fixture()
def d0_parents(db_session: Session):
    user = User(
        username=f"d0user-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        is_active=True,
    )
    db_session.add(user)
    db_session.flush()
    char = Character(
        id=f"d0char-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name="D0Char",
        description="desc",
    )
    db_session.add(char)
    db_session.flush()
    db_session.add(CharacterChatSession(
        id="sess-d0", user_id=user.id, character_id=char.id, title="d0",
    ))
    db_session.add(WorldBook(
        id="wb-d0", user_id=user.id, name="d0-book", character_id=char.id,
    ))
    db_session.commit()
    return user, char


def _scan(db_session: Session, user, char) -> list[tuple[int, str, int]]:
    result = build_worldbook_context(
        db=db_session,
        session_id="sess-d0",
        user_id=user.id,
        recent_messages=[{"role": "user", "content": "hi"}],
        character=char,
        enable_timed_effects=False,
    )
    return list(result.depth_entries)


class TestAtDepthZeroRouting:
    def test_real_depth_zero(self, db_session: Session, d0_parents):
        user, char = d0_parents
        db_session.add(_mk_stage("e-zero", "变量输出格式规范", depth=0))
        db_session.commit()
        depth_entries = _scan(db_session, user, char)
        assert depth_entries, "constant 条目应激活并进入 atDepth 队列"
        assert [d for d, _c, _r in depth_entries] == [0], (
            f"depth=0 被改写成 {depth_entries[0][0]}（`or 4` 真值判断回归）"
        )

    def test_depth_none_falls_back_to_four(self, db_session: Session, d0_parents):
        user, char = d0_parents
        stage = _mk_stage("e-null", "规范内容", depth=4)
        db_session.add(stage)
        db_session.commit()
        # ORM 列默认会在 INSERT 时填 4，用 Core update 强制 NULL 表示"未设置"
        from sqlalchemy import update as sa_update
        db_session.execute(
            sa_update(WorldBookStage).where(WorldBookStage.id == "e-null").values(depth=None)
        )
        db_session.commit()
        db_session.expire_all()
        depth_entries = _scan(db_session, user, char)
        assert [d for d, _c, _r in depth_entries] == [4], "未设置时才兜 ST 默认深度 4"


class TestCardDeclaresUpdateSpec:
    def test_declared_spec_is_detected(self):
        messages = [
            {"role": "system", "content": "主提示词"},
            {"role": "user", "content": "玩家输入"},
            {"role": "system", "content": (
                "变量输出格式: rule: you must output the update commands in the end of "
                'the reply, like the **JSON Patch (RFC 6902)** standard … <UpdateVariable>'
            )},
        ]
        assert _messages_declare_mvu_update_spec(messages) is True

    def test_plain_chat_has_no_spec(self):
        messages = [
            {"role": "system", "content": "主提示词"},
            {"role": "user", "content": "玩家输入里提到 JSON Patch 但没有变量协议"},
        ]
        assert _messages_declare_mvu_update_spec(messages) is False

    def test_multimodal_parts_are_scanned(self):
        messages = [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "x"}},
            {"type": "text", "text": "<UpdateVariable> 与 JSONPatch 规范"},
        ]}]
        assert _messages_declare_mvu_update_spec(messages) is True


class TestGenericTailHasNoCardNames:
    """守门狗：兜底模板不得含任何具体角色名/字段名（本次事故的真凶）。"""

    @pytest.mark.parametrize("forbidden", [
        "桃汐", "世界信息", "好感度", "性欲值", "发情期", "内心想法", "服饰",
    ])
    def test_forbidden_literal_absent(self, forbidden):
        assert forbidden not in _MVU_GENERIC_TAIL, (
            f"兜底模板混入了具体字段名 {forbidden!r}，模型会照它自创结构"
        )

    def test_tail_forbids_new_top_level_keys(self):
        assert "禁止新建顶层分组" in _MVU_GENERIC_TAIL
