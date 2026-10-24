"""[ASM-2 2026-10-24] debug-prompt-assembly 的 model 必填回归测试。

被测对象：``POST /api/character-sessions/{session_id}/debug-prompt-assembly``
（backend/app/api/character_ext.py::debug_prompt_assembly 与其
PromptAssemblyDebugRequest）。

背景（T-1 堵口，REPORT_ST全量适配悲观审计_2026-10-22.md §2）：端点曾
``model: Optional[str] = None``，不传 model 会静默装配出**另一份** prompt
—— max_context_tokens 走 _get_model_context_window 的 8192 回落（预算塌到
5632），取证端点据此得出与生产不一致的假结论。

两组断言：
  1. 缺 model 的请求 → 422（pydantic 原生，端点不加自定义抛错），且响应
     detail 可定位缺失字段（loc=["body", "model"], type="missing"）；
  2. 带 model 的请求 → 200 行为不变：model 原样下发到
     assemble_roleplay_prompt（monkeypatch 间谍捕获 PromptAssemblyRequest.model），
     装配产物契约形状在场（assembly.report）。
"""

import os
import sys
import uuid

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy.orm import Session  # noqa: E402

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.character import CharacterChatMessage, CharacterChatSession  # noqa: E402

# 与既有取证调用方（test_e2e_roleplay_phase6 / scripts/debug_worldbook_hit.py）
# 同款的显式 model；必填收紧后这就是最低门槛。
TEST_MODEL = "deepseek-v4-flash"


def _mk_char(db: Session, user: User, name: str) -> Character:
    c = Character(id=f"asm2-c-{uuid.uuid4().hex[:8]}", user_id=user.id, name=name)
    db.add(c)
    db.commit()
    return c


def _mk_session(db: Session, user: User, char: Character) -> CharacterChatSession:
    s = CharacterChatSession(
        id=f"asm2-s-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        character_id=char.id,
        title="asm2",
    )
    db.add(s)
    db.commit()
    return s


def _mk_msg(db: Session, session: CharacterChatSession, role: str, content: str, name: str = "") -> None:
    db.add(CharacterChatMessage(
        session_id=session.id,
        role=role,
        content=content,
        name=name or None,
    ))
    db.commit()


class TestModelRequired:
    def test_missing_model_returns_422_locating_field(self, client):
        """① 缺 model → 422，且 detail 定位到 body.model 缺失。"""
        resp = client.post(
            "/api/character-sessions/asm2-no-such-session/debug-prompt-assembly",
            json={"message": "", "max_tokens": 2048},
        )
        assert resp.status_code == 422, f"期望 422，实际 {resp.status_code}: {resp.text[:300]}"
        detail = resp.json()["detail"]
        hits = [
            e for e in detail
            if e.get("loc") == ["body", "model"] and e.get("type") == "missing"
        ]
        assert hits, f"422 detail 未定位到 body.model 缺失: {detail}"

    def test_request_with_model_passes_model_through_and_returns_200(
        self, client, db_session, test_user, monkeypatch
    ):
        """② 带 model → 200 行为不变：model 原样进入 PromptAssemblyRequest。"""
        import app.api.character_ext as ce

        char = _mk_char(db_session, test_user, "Asm2Probe")
        session = _mk_session(db_session, test_user, char)
        _mk_msg(db_session, session, "user", "ASM2 开场一句。", name="用户")
        _mk_msg(db_session, session, "assistant", "ASM2 应答一句。", name="Asm2Probe")

        captured: dict = {}
        real_fn = ce.assemble_roleplay_prompt

        async def _spy(req, deps):
            captured["model"] = req.model
            return await real_fn(req, deps)

        monkeypatch.setattr(ce, "assemble_roleplay_prompt", _spy)

        resp = client.post(
            f"/api/character-sessions/{session.id}/debug-prompt-assembly",
            json={"message": "", "model": TEST_MODEL, "max_tokens": 2048},
        )
        assert resp.status_code == 200, resp.text[:500]
        assert captured.get("model") == TEST_MODEL, (
            f"model 未原样下发：捕获 {captured.get('model')!r}"
        )
        body = resp.json()
        assert "assembly" in body, f"响应缺 assembly: {list(body.keys())}"
        assert "report" in body["assembly"], (
            f"assembly 缺 report: {list(body['assembly'].keys())}"
        )
