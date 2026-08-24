"""清理批次 A（ST 世界书与示例域兼容债 7 项）验证测试。

spec: docs/SPEC_清理批次总案_除N8_2026-08-24.md §1
- A1: 条目级 useProbability 接线（DB 列 / 导入映射 / 扫描判定 / 报告字段）
- A2: mes_example <START> 拆块移植到 palink-native 装配段
- A3: prevent_recursion 语义修正（内容排除出递归 buffer，条目本身正常激活）
- A4: world_info_depth 全局扫描深度穿透 + recursive 总开关
- A5: 世界书百分比预算基数传真实上下文上限（16000 仅兜底）
- A6: V3 卡独立 jailbreak 消费进 jailbreak 槽（context_template > 卡自带 > 无）
- A7: creator_notes 退出 system prompt 装配层
"""

import json
import os
import sys
import uuid
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import update as sa_update  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.default_prompts import build_default_character_prompt  # noqa: E402
from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.character_message_builder import (  # noqa: E402
    build_character_chat_messages,
)
from app.services.worldbook_service import (  # noqa: E402
    DEFAULT_BUDGET,
    WorldbookEntryReport,
    _recursive_scan,
    _scan_entries,
    build_worldbook_context,
)

WI_POS_AT_DEPTH = 4


def _result_all_text(result) -> str:
    """汇总 WorldbookContextResult 的全部注入文本（含 atDepth 条目）。"""
    parts = [result.text or ""]
    parts.extend(c for _, c, _ in result.depth_entries)
    for contents in result.entries_by_position.values():
        parts.extend(contents)
    return "\n".join(parts)


def _mk_stage(
    eid: str,
    key: str,
    content: str,
    *,
    probability: int = 100,
    use_probability=None,
    prevent_recursion: bool = False,
    exclude_recursion: bool = False,
) -> WorldBookStage:
    kwargs = dict(
        id=eid,
        world_book_id="wb",
        stage_index=0,
        title=eid,
        content=content,
        keys=json.dumps([key]),
        secondary_keys=json.dumps([]),
        position=WI_POS_AT_DEPTH,
        depth=4,
        selective=False,
        selective_logic=0,
        probability=probability,
        constant=False,
        enabled=True,
        sticky=0,
        cooldown=0,
        delay=0,
        exclude_recursion=exclude_recursion,
        prevent_recursion=prevent_recursion,
        scan_depth=None,
    )
    if use_probability is not None:
        kwargs["use_probability"] = use_probability
    return WorldBookStage(**kwargs)


# ---------------------------------------------------------------------------
# A1: useProbability 扫描判定 + 报告字段
# ---------------------------------------------------------------------------
class TestA1UseProbability:
    def test_false_ignores_probability_always_fires(self):
        """useProbability=False：无视 probability 必现（ST 语义）。"""
        entries = [_mk_stage("u1", "dragon", "Dragon lore", probability=50, use_probability=False)]
        msgs = [{"role": "user", "content": "A dragon appears."}]
        for i in range(20):
            report: list[WorldbookEntryReport] = []
            activated = _scan_entries(
                list(entries), msgs, None, None, message_index=0,
                visited=set(), recursion_depth=0, report=report,
            )
            assert "u1" in {e.id for e in activated}, f"round {i}: false 应必现"

    def test_true_with_probability_zero_never_fires(self):
        """useProbability=True + probability=0：现行滚动逻辑永不激活。"""
        entry = _mk_stage("u2", "dragon", "Dragon lore", probability=0, use_probability=True)
        msgs = [{"role": "user", "content": "A dragon appears."}]
        report: list[WorldbookEntryReport] = []
        activated = _scan_entries(
            [entry], msgs, None, None, message_index=0,
            visited=set(), recursion_depth=0, report=report,
        )
        assert "u2" not in {e.id for e in activated}

    def test_true_rolls_statistically(self):
        """useProbability=True + probability=50：既有滚动行为回归（有出有不出）。"""
        outcomes = set()
        for _ in range(200):
            entry = _mk_stage("u3", "dragon", "Dragon lore", probability=50, use_probability=True)
            report: list[WorldbookEntryReport] = []
            activated = _scan_entries(
                [entry], [{"role": "user", "content": "A dragon appears."}], None, None,
                message_index=0, visited=set(), recursion_depth=0, report=report,
            )
            outcomes.add("u3" in {e.id for e in activated})
        assert outcomes == {True, False}, "probability=50 滚动应存在两种结果"

    def test_report_carries_use_probability(self):
        entry = _mk_stage("u4", "dragon", "Dragon lore", probability=50, use_probability=False)
        report: list[WorldbookEntryReport] = []
        activated = _scan_entries(
            [entry], [{"role": "user", "content": "A dragon appears."}], None, None,
            message_index=0, visited=set(), recursion_depth=0, report=report,
        )
        assert any(r.use_probability is False for r in report), "报告应带出开关状态"

    def test_model_column_exists(self):
        """WorldBookStage.use_probability 列声明存在且默认 True。"""
        assert hasattr(WorldBookStage, "use_probability")
        col = WorldBookStage.__table__.columns.get("use_probability")
        assert col is not None
        assert bool(col.default.arg) is True


class TestA1ImportRoundTrip:
    LOREBOOK = {
        "uid": 0,
        "key": ["dragon"],
        "keysecondary": [],
        "comment": "a1 entry",
        "content": "Dragon lore",
        "constant": False,
        "selective": False,
        "order": 0,
        "position": 4,
        "probability": 80,
        "useProbability": False,
        "disable": False,
    }

    def _import(self, client: TestClient, auth_headers: dict, entries: dict) -> str:
        payload = {"name": "A1 Book", "entries": entries}
        resp = client.post(
            "/api/worldbooks/import",
            headers=auth_headers,
            files={"file": ("a1.json", json.dumps(payload).encode("utf-8"))},
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["id"]

    def test_import_preserves_use_probability(
        self, client: TestClient, db_session: Session, auth_headers: dict
    ):
        book_id = self._import(client, auth_headers, {"0": self.LOREBOOK})
        stage = (
            db_session.query(WorldBookStage)
            .filter(WorldBookStage.world_book_id == book_id)
            .first()
        )
        assert stage is not None
        assert stage.probability == 80
        assert stage.use_probability is False, "useProbability=false 应映射落库"

    def test_import_defaults_true_when_missing(
        self, client: TestClient, db_session: Session, auth_headers: dict
    ):
        entry = dict(self.LOREBOOK, uid=1)
        entry.pop("useProbability")
        book_id = self._import(client, auth_headers, {"0": entry})
        stage = (
            db_session.query(WorldBookStage)
            .filter(WorldBookStage.world_book_id == book_id)
            .first()
        )
        assert stage.use_probability is True, "缺省时应落库为 true（ST 默认）"

    def test_detail_response_carries_use_probability(
        self, client: TestClient, auth_headers: dict
    ):
        book_id = self._import(client, auth_headers, {"0": self.LOREBOOK})
        detail = client.get(f"/api/worldbooks/{book_id}", headers=auth_headers).json()
        stages = detail["stages"]
        assert stages, "导入后应有条目"
        assert stages[0]["use_probability"] is False


# ---------------------------------------------------------------------------
# A2: mes_example <START> 拆块移植到 palink-native
# ---------------------------------------------------------------------------
class TestA2NativeExampleBlocks:
    @pytest.fixture()
    def _builder_env(self, db_session: Session):
        user = User(
            username=f"a2user-{uuid.uuid4().hex[:8]}",
            hashed_password=get_password_hash("TestPassword1"),
            is_active=True,
        )
        db_session.add(user)
        db_session.commit()
        char = Character(
            id=f"a2char-{uuid.uuid4().hex[:8]}",
            user_id=user.id,
            name="A2Char",
            description="A test character",
        )
        db_session.add(char)
        db_session.commit()

        def run(mes_example: str, **overrides):
            char.mes_example = mes_example
            return build_character_chat_messages(
                db=db_session,
                char=char,
                user_nickname="Tester",
                session_id="a2-session",
                branch_id="a2-branch",
                message="hello",
                images=[],
                system_prompt="SYS PROMPT",
                dynamic_context_parts=[],
                prompt_lang="en",
                user_setting=None,
                _replace_placeholders=lambda text, u, c: (
                    str(text).replace("{{user}}", u).replace("{{char}}", c)
                ),
                _get_full_branch_history=lambda *a, **k: [],
                _contains_chinese=lambda t: False,
                normalize_image_url=lambda url, check_size=False: url,
                include_user_message=False,
                include_title_instruction=False,
                **overrides,
            )

        return run

    def test_multi_start_blocks_expanded(self, _builder_env):
        """多组 <START> 示例按 ST 方式展开：每组 [Example Chat] 标记 + 多条消息。"""
        mes_example = (
            "<START>\n{{user}}: Hi there\n{{char}}: Hello, traveler.\n"
            "<START>\n{{user}}: Bye\n{{char}}: Farewell."
        )
        msgs = _builder_env(mes_example)
        markers = [m for m in msgs if m.get("content") == "[Example Chat]"]
        assert len(markers) == 2, f"应有两组 [Example Chat]，实际 {len(markers)}"
        names = [m.get("name") for m in msgs if m.get("name")]
        assert "example_user" in names and "example_assistant" in names
        joined = json.dumps(msgs, ensure_ascii=False)
        assert "{{user}}" not in joined and "{{char}}" not in joined, "宏应已替换"
        assert "Hello, traveler." in joined and "Farewell." in joined
        # 不再使用旧的单条 "Example dialogue:" 前缀
        assert not any(
            str(m.get("content", "")).startswith("Example dialogue:") for m in msgs
        )

    def test_single_block_regression(self, _builder_env):
        """单组示例回归：一个 [Example Chat] 标记，消息内容保留。"""
        msgs = _builder_env("<START>\n{{user}}: Only one\n{{char}}: Single block.")
        markers = [m for m in msgs if m.get("content") == "[Example Chat]"]
        assert len(markers) == 1
        joined = json.dumps(msgs, ensure_ascii=False)
        assert "Single block." in joined

    def test_no_example_no_marker(self, _builder_env):
        msgs = _builder_env("")
        assert not any(m.get("content") == "[Example Chat]" for m in msgs)


# ---------------------------------------------------------------------------
# A3: prevent_recursion 语义修正
# ---------------------------------------------------------------------------
class TestA3PreventRecursion:
    def test_prevent_recursion_entry_activates_via_recursion_buffer(self):
        """递归轮中 prevent_recursion 条目正常激活（旧实现整条跳过）。"""
        entry_a = _mk_stage("pa", "dragon", "The griffin flies high")
        entry_p = _mk_stage("pp", "griffin", "Griffin lore", prevent_recursion=True)
        recent = [{"role": "user", "content": "I saw a dragon."}]
        activated, _report = _recursive_scan(
            entries=[entry_a, entry_p],
            recent_messages=recent,
            char=None, timed_mgr=None, message_index=0,
        )
        ids = {e.id for e in activated}
        assert "pa" in ids and "pp" in ids, (
            f"prevent_recursion 条目应经递归 buffer 正常激活: {ids}"
        )

    def test_prevent_recursion_content_not_seeding_further_activation(self):
        """prevent_recursion 条目内容不进入递归 buffer，不触发后续条目。"""
        entry_p = _mk_stage(
            "pc", "dragon", "secret griffin lore", prevent_recursion=True
        )
        entry_c = _mk_stage("pd", "griffin", "Chained entry")
        activated, _report = _recursive_scan(
            entries=[entry_p, entry_c],
            recent_messages=[{"role": "user", "content": "I saw a dragon."}],
            char=None, timed_mgr=None, message_index=0,
        )
        ids = {e.id for e in activated}
        assert "pc" in ids, "prevent_recursion 条目自身应激活"
        assert "pd" not in ids, "其内容不应触发其他条目"

    def test_exclude_recursion_still_blocks_entry_in_recursion_round(self):
        """对照回归：exclude_recursion 条目在 RECURSION 轮仍被跳过。"""
        entry_x = _mk_stage(
            "pe", "griffin", "X lore", exclude_recursion=True
        )
        report: list[WorldbookEntryReport] = []
        activated = _scan_entries(
            [entry_x],
            [{"role": "user", "content": "text"}],
            None, None, message_index=0,
            visited=set(), recursion_depth=1, report=report,
            recurse_buffer=["the griffin flies"],
        )
        assert "pe" not in {e.id for e in activated}


# ---------------------------------------------------------------------------
# A4: world_info_depth 穿透 + recursive 总开关
# ---------------------------------------------------------------------------
class TestA4WorldInfoGlobals:
    def _db_parents(self, db_session: Session, sess_id: str, book_id: str = "wb-a4"):
        user = User(
            username=f"a4user-{uuid.uuid4().hex[:8]}",
            hashed_password=get_password_hash("TestPassword1"),
            is_active=True,
        )
        db_session.add(user)
        db_session.flush()
        char = Character(
            id=f"a4char-{uuid.uuid4().hex[:8]}",
            user_id=user.id,
            name="A4Char",
            description="desc",
        )
        db_session.add(char)
        db_session.flush()
        db_session.add(CharacterChatSession(
            id=sess_id, user_id=user.id, character_id=char.id, title="a4",
        ))
        db_session.add(WorldBook(id=book_id, user_id=user.id, name="a4-book"))
        db_session.commit()
        return user, char

    def test_global_scan_depth_threads_through_recursive_scan(self):
        """global_scan_depth 仅影响未设置自定义 scan_depth 的条目（ST getDepth）。"""
        # 关键词在最旧一条消息中：depth=2 只看最近 2 条看不到，depth=3 可见
        msgs = [
            {"role": "assistant", "content": "A dragon appears here."},
            {"role": "user", "content": "filler one"},
            {"role": "assistant", "content": "filler two"},
        ]
        report1: list[WorldbookEntryReport] = []
        activated_shallow = _scan_entries(
            [_mk_stage("wd1", "dragon", "Dragon lore")], msgs, None, None,
            message_index=2, visited=set(), recursion_depth=0, report=report1,
            global_scan_depth=2,
        )
        report2: list[WorldbookEntryReport] = []
        activated_deep = _scan_entries(
            [_mk_stage("wd1", "dragon", "Dragon lore")], msgs, None, None,
            message_index=2, visited=set(), recursion_depth=0, report=report2,
            global_scan_depth=3,
        )
        assert not activated_shallow, "depth=2 不应看到最旧一条历史"
        assert "wd1" in {e.id for e in activated_deep}, "depth=3 应命中"

    def test_build_worldbook_context_world_info_depth(self, db_session: Session):
        user, char = self._db_parents(db_session, "sess-a4-depth")
        stage = _mk_stage("wd2", "dragon", "Dragon lore")
        stage.world_book_id = "wb-a4"
        db_session.add(stage)
        db_session.commit()
        # ORM 列默认会在 INSERT 时把 scan_depth 填成 4；用 Core update 强制 NULL，
        # 表示「未设置自定义扫描深度」（ST entry.scanDepth ?? world_info_depth）。
        db_session.execute(
            sa_update(WorldBookStage)
            .where(WorldBookStage.id == "wd2")
            .values(scan_depth=None)
        )
        db_session.commit()
        db_session.expire_all()
        msgs = [
            {"role": "assistant", "content": "A dragon appears here."},
            {"role": "user", "content": "filler one"},
            {"role": "assistant", "content": "filler two"},
        ]
        shallow = build_worldbook_context(
            db=db_session, session_id="sess-a4-depth", user_id=user.id,
            recent_messages=msgs, character=char,
            enable_timed_effects=False, world_info_depth=2,
        )
        deep = build_worldbook_context(
            db=db_session, session_id="sess-a4-depth", user_id=user.id,
            recent_messages=msgs, character=char,
            enable_timed_effects=False, world_info_depth=3,
        )
        assert "Dragon lore" not in _result_all_text(shallow), "world_info_depth=2 不应激活"
        assert "Dragon lore" in _result_all_text(deep), "world_info_depth=3 应命中"

    def test_recursive_switch_disables_chained_activation(self, db_session: Session):
        user, char = self._db_parents(db_session, "sess-a4-rec")
        entry_a = _mk_stage("wa", "dragon", "The griffin flies high")
        entry_b = _mk_stage("wb2", "griffin", "Griffin lore discovered")
        entry_a.world_book_id = "wb-a4"
        entry_b.world_book_id = "wb-a4"
        db_session.add_all([entry_a, entry_b])
        db_session.commit()
        msgs = [{"role": "user", "content": "I saw a dragon."}]
        recursive_on = build_worldbook_context(
            db=db_session, session_id="sess-a4-rec", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, enable_recursive=True,
        )
        recursive_off = build_worldbook_context(
            db=db_session, session_id="sess-a4-rec", user_id=user.id,
            recent_messages=list(msgs), character=char,
            enable_timed_effects=False, enable_recursive=False,
        )
        on_text = _result_all_text(recursive_on)
        off_text = _result_all_text(recursive_off)
        assert "The griffin flies high" in on_text, "递归开时 A 激活"
        assert "Griffin lore discovered" in on_text, "递归开时 B 经链式激活"
        assert "Griffin lore discovered" not in off_text, "递归关时 B 不激活"


# ---------------------------------------------------------------------------
# A5: 百分比预算基数传真实上下文上限
# ---------------------------------------------------------------------------
class TestA5BudgetBase:
    def test_percentage_uses_passed_max_context(self, db_session: Session):
        user = User(
            username=f"a5user-{uuid.uuid4().hex[:8]}",
            hashed_password=get_password_hash("TestPassword1"),
            is_active=True,
        )
        db_session.add(user)
        db_session.flush()
        char = Character(id=f"a5char-{uuid.uuid4().hex[:8]}", user_id=user.id, name="A5Char")
        db_session.add(char)
        db_session.flush()
        db_session.add(CharacterChatSession(
            id="sess-a5", user_id=user.id, character_id=char.id, title="a5",
        ))
        wb = WorldBook(id="wb-a5", user_id=user.id, name="a5-book", budget_tokens="10%")
        db_session.add(wb)
        stage = _mk_stage("a5s", "dragon", "Dragon lore")
        stage.world_book_id = "wb-a5"
        db_session.add(stage)
        db_session.commit()
        msgs = [{"role": "user", "content": "A dragon appears."}]

        real = build_worldbook_context(
            db=db_session, session_id="sess-a5", user_id=user.id,
            recent_messages=msgs, character=char,
            enable_timed_effects=False, max_context_tokens=50000,
        )
        fallback = build_worldbook_context(
            db=db_session, session_id="sess-a5", user_id=user.id,
            recent_messages=msgs, character=char,
            enable_timed_effects=False, max_context_tokens=None,
        )
        assert real.budget_used == 5000, "10% × 50000 = 5000（真实基数）"
        assert fallback.budget_used == int(DEFAULT_BUDGET * 0.10), (
            "未传入时回退 16000 兜底基数"
        )


# ---------------------------------------------------------------------------
# A6: V3 卡独立 jailbreak 消费进 jailbreak 槽
# ---------------------------------------------------------------------------
class TestA6CardJailbreak:
    @pytest.fixture()
    def _run_builder(self, db_session: Session):
        def run(char_kwargs: dict, context_template=None):
            _defaults = dict(
                id="a6-char", name="A6Char", description="D", personality="",
                scenario="", mes_example="", post_history_instructions=None,
            )
            _defaults.update(char_kwargs)
            char = SimpleNamespace(**_defaults)
            return build_character_chat_messages(
                db=db_session,
                char=char,
                user_nickname="Tester",
                session_id="a6-sess",
                branch_id="a6-branch",
                message="hi",
                images=[],
                system_prompt="SYS",
                dynamic_context_parts=[],
                prompt_lang="en",
                user_setting=None,
                _replace_placeholders=lambda text, u, c: text,
                _get_full_branch_history=lambda *a, **k: [],
                _contains_chinese=lambda t: False,
                normalize_image_url=lambda url, check_size=False: url,
                include_user_message=False,
                include_title_instruction=False,
                context_template=context_template,
            )
        return run

    def test_card_jailbreak_consumed_into_slot(self, _run_builder):
        """卡自带独立 jailbreak → 注入 jailbreak 槽（前导 system 块之后）。"""
        msgs = _run_builder({"jailbreak": "CARD JB"})
        jb_indices = [
            i for i, m in enumerate(msgs) if m.get("content") == "CARD JB"
        ]
        assert len(jb_indices) == 1, "卡 jailbreak 应恰好注入一次"
        jb_idx = jb_indices[0]
        assert msgs[0]["content"] == "SYS"
        assert jb_idx >= 1, "jailbreak 槽位应在前导 system 块之后"
        assert all(m["role"] == "system" for m in msgs[: jb_idx + 1])

    def test_template_jailbreak_wins_over_card(self, _run_builder):
        tmpl = SimpleNamespace(name="Custom", system_prompt="", jailbreak="TMPL JB", chat_start="")
        msgs = _run_builder({"jailbreak": "CARD JB"}, context_template=tmpl)
        contents = [m.get("content") for m in msgs]
        assert "TMPL JB" in contents
        assert "CARD JB" not in contents, "context_template 优先于卡自带"

    def test_v2_duplicate_jailbreak_not_double_consumed(self, _run_builder):
        """V2 回退拷贝（jailbreak==PHI）不重复消费进槽位。"""
        char_kwargs = {
            "jailbreak": "SAME PHI TEXT",
            "post_history_instructions": "SAME PHI TEXT",
        }
        msgs = _run_builder(char_kwargs)
        count = sum(
            1 for m in msgs if m.get("content") == "SAME PHI TEXT"
        )
        assert count == 1, f"PHI 拷贝只应出现一次（原 PHI 注入），实际 {count}"

    def test_no_jailbreak_no_slot_message(self, _run_builder):
        msgs = _run_builder({"jailbreak": None})
        assert not any(m.get("content") == "CARD JB" for m in msgs)


# ---------------------------------------------------------------------------
# A7: creator_notes 退出 system prompt
# ---------------------------------------------------------------------------
class TestA7CreatorNotes:
    def test_creator_notes_not_injected(self):
        prompt = build_default_character_prompt(
            char_name="A7Char",
            user_nickname="Tester",
            dialogue_mode="first_person",
            lang="zh",
            personality="活泼",
            description="描述内容XYZ",
            creator_notes="CREATOR_SECRET_NOTES_XYZ",
        )
        assert "CREATOR_SECRET_NOTES_XYZ" not in prompt, "creator_notes 不应再注入 prompt"
        assert "创作者备注" not in prompt
        assert "描述内容XYZ" in prompt, "其余属性装配不受影响"

    def test_creator_notes_en_not_injected(self):
        prompt = build_default_character_prompt(
            char_name="A7Char",
            user_nickname="Tester",
            dialogue_mode="first_person",
            lang="en",
            description="plain description",
            creator_notes="CREATOR_SECRET_EN_XYZ",
        )
        assert "CREATOR_SECRET_EN_XYZ" not in prompt
        assert "Creator Notes" not in prompt
