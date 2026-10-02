"""[PROMPT-EVERY-TURN 2026-10-02] 卡脚本上报快照持久化回归。

SPEC：docs/PROMPT_格式规范每轮必到与历史擦标签例外_2026-10-02.md 主方案。
- 帧上报 → POST /api/extension-prompts/persist → extension_prompts 表落行
  （现网 0 行的表第一次有了持久化用途）；
- 键 = (user, identifier, source_key)，source_key 由前端按插件脚本包内容计算
  ——重导入换 char id 不失效、同名不同卡不串（用户拍板 b）；
- 装配层 _collect_extension_prompts 零改动：user 级行 + filter.character_ids
  过滤 + 请求侧按 identifier 高优覆盖，全部既有语义。
"""

import os
import sys
import uuid

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

from app.models import Character  # noqa: E402
from app.models.extension_prompt import ExtensionPrompt  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyRequest,
    _collect_extension_prompts,
)

SPEC_V71 = "[正文标签规则]\n正文必须整体包裹在一对 <now_plot> 标签内（单层）。"


@pytest.fixture()
def char(db_session, test_user):
    c = Character(user_id=test_user.id, name="露缇雅1.2")
    db_session.add(c)
    db_session.commit()
    db_session.refresh(c)
    return c


def _persist(client, auth_headers, char_id, source_key="fnv1a-abc12345", identifier="bubble-dialogue-format",
             content=SPEC_V71, position=0, depth=0, scan=False, role=0):
    return client.post(
        "/api/extension-prompts/persist",
        headers=auth_headers,
        json={
            "character_id": char_id,
            "source_key": source_key,
            "prompts": {
                identifier: {"content": content, "position": position, "depth": depth,
                             "role": role, "scan": scan},
            },
        },
    )


class TestPersistEndpoint:
    def test_persist_creates_row(self, client, auth_headers, char):
        resp = _persist(client, auth_headers, char.id)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["ok"] is True and data["upserted"] == 1

        rows = client.get("/api/extension-prompts", headers=auth_headers).json()
        row = next(r for r in rows if r["identifier"] == "bubble-dialogue-format")
        assert row["content"] == SPEC_V71
        assert row["position"] == 0
        assert row["enabled"] is True

    def test_persist_idempotent_no_duplicate(self, client, auth_headers, char, db_session):
        _persist(client, auth_headers, char.id)
        _persist(client, auth_headers, char.id)
        rows = db_session.query(ExtensionPrompt).filter(
            ExtensionPrompt.identifier == "bubble-dialogue-format").all()
        assert len(rows) == 1
        assert rows[0].source_key == "fnv1a-abc12345"

    def test_persist_content_change_updates_same_row(self, client, auth_headers, char, db_session):
        _persist(client, auth_headers, char.id, content="旧文本")
        _persist(client, auth_headers, char.id, content="新文本")
        rows = db_session.query(ExtensionPrompt).all()
        assert len(rows) == 1 and rows[0].content == "新文本"

    def test_filter_scoped_to_character(self, client, auth_headers, char, db_session):
        _persist(client, auth_headers, char.id)
        row = db_session.query(ExtensionPrompt).first()
        assert str(char.id) in [str(x) for x in row.get_filter().get("character_ids", [])]

    def test_reimported_card_same_content_same_row(self, client, auth_headers, char, db_session, test_user):
        # 重导入：新 char id、同脚本内容 → 同 source_key → 复用同一行，filter 追加新卡
        other = Character(user_id=test_user.id, name="露缇雅1.2-重导入")
        db_session.add(other)
        db_session.commit()
        db_session.refresh(other)
        _persist(client, auth_headers, char.id)
        _persist(client, auth_headers, other.id)
        rows = db_session.query(ExtensionPrompt).all()
        assert len(rows) == 1
        ids = [str(x) for x in rows[0].get_filter().get("character_ids", [])]
        assert str(char.id) in ids and str(other.id) in ids

    def test_same_name_different_content_no_cross_card(self, client, auth_headers, char, db_session, test_user):
        # 同名不同内容卡：不同 source_key → 两行互不串扰
        other = Character(user_id=test_user.id, name="露缇雅1.2")
        db_session.add(other)
        db_session.commit()
        db_session.refresh(other)
        _persist(client, auth_headers, char.id, source_key="fnv1a-cardA1234", content="A 卡规范")
        _persist(client, auth_headers, other.id, source_key="fnv1a-cardB1234", content="B 卡规范")
        rows = db_session.query(ExtensionPrompt).order_by(ExtensionPrompt.content).all()
        assert len(rows) == 2
        assert {r.content for r in rows} == {"A 卡规范", "B 卡规范"}

    def test_script_edit_detaches_old_snapshot(self, client, auth_headers, char, db_session):
        # 卡脚本被编辑：新 source_key 上报后，旧行摘掉本卡（摘空即删）
        _persist(client, auth_headers, char.id, source_key="fnv1a-oldversi", content="旧版规范")
        _persist(client, auth_headers, char.id, source_key="fnv1a-newversi", content="新版规范")
        rows = db_session.query(ExtensionPrompt).all()
        assert [r.content for r in rows] == ["新版规范"]
        resp = _persist(client, auth_headers, char.id, source_key="fnv1a-newversi")
        assert resp.json()["detached"] == 0

    def test_manual_row_never_touched(self, client, auth_headers, char, db_session):
        # source_key=NULL 的手动行（用户在设置里配的）不允许被上报摘除
        manual = ExtensionPrompt(user_id=1, session_id=None, identifier="bubble-dialogue-format",
                                 content="手动配置", position=0, depth=4, role="system", enabled=True)
        manual.set_filter({"character_ids": [str(char.id)]})
        db_session.add(manual)
        db_session.commit()
        resp = _persist(client, auth_headers, char.id, source_key="fnv1a-cardsnap")
        assert resp.status_code == 200
        rows = db_session.query(ExtensionPrompt).all()
        assert len(rows) == 2
        manual_row = next(r for r in rows if r.source_key is None)
        assert manual_row.content == "手动配置"

    def test_rejects_bad_source_key(self, client, auth_headers, char):
        resp = _persist(client, auth_headers, char.id, source_key="short")
        assert resp.status_code == 400

    def test_rejects_foreign_character(self, client, auth_headers, db_session):
        resp = _persist(client, auth_headers, str(uuid.uuid4()))
        assert resp.status_code == 404

    def test_empty_content_skipped(self, client, auth_headers, char, db_session):
        resp = _persist(client, auth_headers, char.id, content="   ")
        assert resp.status_code == 200 and resp.json()["upserted"] == 0
        assert db_session.query(ExtensionPrompt).count() == 0

    def test_unresolved_macro_logs_warning(self, client, auth_headers, char, caplog):
        import logging
        with caplog.at_level(logging.WARNING, logger="app.api.extension_prompts"):
            resp = _persist(client, auth_headers, char.id,
                            content="[情绪词约束]\n可选词：{{mood_groups}}")
        assert resp.status_code == 200
        assert any("unresolved macro" in r.message for r in caplog.records)


class TestCollectionIntegration:
    """装配层零改动的存在性证明：持久化行每轮到场，live 上报按 identifier 覆盖。"""

    def _make_req(self, db_session, test_user, char, live_prompts):
        return PromptAssemblyRequest(
            db=db_session,
            user=test_user,
            char=char,
            session_id="sess-1",
            branch_id=None,
            message="hi",
            extension_prompts=live_prompts,
        )

    def test_persisted_row_present_every_turn(self, client, auth_headers, char, db_session, test_user):
        _persist(client, auth_headers, char.id)
        result = _collect_extension_prompts(self._make_req(db_session, test_user, char, []))
        assert [e["identifier"] for e in result] == ["bubble-dialogue-format"]
        assert result[0]["content"] == SPEC_V71

    def test_other_character_not_polluted(self, client, auth_headers, char, db_session, test_user):
        _persist(client, auth_headers, char.id)
        stranger = Character(user_id=test_user.id, name="别人家的卡")
        db_session.add(stranger)
        db_session.commit()
        db_session.refresh(stranger)
        result = _collect_extension_prompts(self._make_req(db_session, test_user, stranger, []))
        assert result == []

    def test_live_snapshot_overrides_persisted(self, client, auth_headers, char, db_session, test_user):
        _persist(client, auth_headers, char.id)
        live = [{"identifier": "bubble-dialogue-format", "content": "现场新版本", "position": 0,
                 "depth": 0, "role": "system", "scan": False, "filter": None}]
        result = _collect_extension_prompts(self._make_req(db_session, test_user, char, live))
        assert len(result) == 1
        assert result[0]["content"] == "现场新版本"

    def test_disabled_row_not_injected(self, client, auth_headers, char, db_session, test_user):
        _persist(client, auth_headers, char.id)
        row = db_session.query(ExtensionPrompt).first()
        row.enabled = False
        db_session.commit()
        result = _collect_extension_prompts(self._make_req(db_session, test_user, char, []))
        assert result == []


class TestEvidenceShape:
    def test_assembly_result_has_evidence_field(self):
        from app.services.roleplay_prompt_assembly import PromptAssemblyResult
        r = PromptAssemblyResult(messages=[], system_prompt="", dynamic_context_parts=[],
                                 effective_max_tokens=0, memory_mode="", prompt_language="",
                                 report=[], stop_sequences=[])
        assert r.ext_prompts_evidence == {}

    def test_stream_result_evidence_slot(self):
        from app.services.stream_builder import StreamResult
        r = StreamResult()
        assert r.ext_prompts_evidence is None
        r.ext_prompts_evidence = {"received": {"count": 0, "total_chars": 0}}
        assert r.ext_prompts_evidence["received"]["count"] == 0
