"""批次 C：世界书行为收敛（后端）验证测试。

spec: docs/PLAN_ST兼容修复批次_2026-08-28.md 批次 C（P1-3 + P2-1/2/3/4）
- C1: 全局百分比预算 25%（书级优先 / cap 钳制 / 无配置回退 16000）
- C2: world_info_recursive 装配层默认翻转 false（ST world-info.js:75）
- C3: world_info_include_names 消费（haystack 按 "name: content" 拼接，
      对齐 ST script.js:4565 / world-info.js:74 默认 true）
- C4a: WI 正则 is_prompt=True（promptOnly 脚本作用于 WI 内容，
      对齐 ST world-info.js:5086）
- C4b: ST 契约导入 useProbability 映射落库（对齐 worldbook.py 导入路径写法）
- C5: case_sensitive / match_whole_words 全局继承
      （entry null ?? global，对齐 ST world-info.js:269/:347）

ST 真值（SillyTavern-1.18.0/public/scripts/world-info.js）：
- L69-81 默认值区: depth=2 / recursive=false / budget=25 / budget_cap=0 /
  include_names=true / case_sensitive=false / match_whole_words=false /
  use_group_scoring=false
- L4624-4629: budget = round(world_info_budget * maxContext / 100)，cap>0 时钳制
- L5085-5086: WI 内容正则 { depth: regexDepth, isMarkdown: false, isPrompt: true }
- L268-269 / L347: entry.caseSensitive ?? global / entry.matchWholeWords ?? global
"""

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

# 让 ``backend`` 目录可被导入（测试可位于 backend/tests/ 下独立运行）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy import update as sa_update  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User, UserSetting  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    PromptAssemblyDeps,
    PromptAssemblyRequest,
    _append_worldbook_context,
)
from app.services.worldbook_service import (  # noqa: E402
    DEFAULT_BUDGET,
    WorldbookContextResult,
    _match_primary_keys,
    _match_secondary_keys,
    _scan_entries,
    build_worldbook_context,
)


# ---------------------------------------------------------------------------
# 工具：DB 基建（user / char / session / worldbook / stage）
# ---------------------------------------------------------------------------
def _mk_parents(db: Session, sess_id: str, book_id: str | None = None):
    """创建 user + character + session（+ 可选全局世界书）。"""
    user = User(
        username=f"cuser-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        is_active=True,
    )
    db.add(user)
    db.flush()
    char = Character(
        id=f"cchar-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name="Alice",
        description="A test character",
    )
    db.add(char)
    db.flush()
    db.add(CharacterChatSession(
        id=sess_id, user_id=user.id, character_id=char.id, title="batch-c",
    ))
    if book_id:
        db.add(WorldBook(id=book_id, user_id=user.id, name="batch-c-book"))
    db.commit()
    return user, char


def _mk_stage(
    eid: str,
    keys: list[str],
    content: str,
    book_id: str,
    *,
    position: int = 0,
) -> WorldBookStage:
    """内存 WorldBookStage（position 默认 0=before，内容进 result.text）。"""
    return WorldBookStage(
        id=eid,
        world_book_id=book_id,
        stage_index=0,
        title=eid,
        content=content,
        keys=json.dumps(keys),
        secondary_keys=json.dumps([]),
        position=position,
        depth=4,
        selective=False,
        selective_logic=0,
        probability=100,
        constant=False,
        enabled=True,
        sticky=0,
        cooldown=0,
        delay=0,
        exclude_recursion=False,
        prevent_recursion=False,
        scan_depth=None,
    )


def _result_text(result: WorldbookContextResult) -> str:
    parts = [result.text or ""]
    parts.extend(c for _, c, _ in result.depth_entries)
    for contents in result.entries_by_position.values():
        parts.extend(contents)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# 工具：装配层直调（spy build_worldbook_context 捕获透传参数）
# ---------------------------------------------------------------------------
def _mk_deps() -> PromptAssemblyDeps:
    return PromptAssemblyDeps(
        build_system_prompt=lambda *a, **k: "",
        replace_placeholders=lambda text, u, c: text,
        get_full_branch_history=lambda *a, **k: [],
        get_ancestor_branch_ids=lambda *a, **k: [],
        contains_chinese=lambda t: False,
        apply_plugin_regex_scripts=lambda text, *a, **k: text,
        apply_regex_scripts=lambda text, *a, **k: text,
        apply_prompt_regex_to_messages=lambda msgs, *a, **k: msgs,
    )


def _mk_req(db: Session, user: User, char: Character, message: str = "hello") -> PromptAssemblyRequest:
    return PromptAssemblyRequest(
        db=db,
        user=user,
        char=char,
        session_id="sess-c-assembly",
        branch_id=None,
        message=message,
        is_init=True,
        user_nickname="Tester",
    )


def _run_append(req: PromptAssemblyRequest, deps: PromptAssemblyDeps | None = None,
                wb_text: str | None = None) -> tuple[dict, list[str]]:
    """直调 _append_worldbook_context，spy 捕获 build_worldbook_context 的 kwargs。

    返回 (captured_kwargs, dynamic_context_parts)。
    """
    captured: dict = {}
    canned = WorldbookContextResult(
        text=wb_text, debug_report=[], total_tokens=0, budget_used=0,
    )

    def _spy(**kwargs):
        captured.update(kwargs)
        return canned

    dynamic_parts: list[str] = []
    with patch("app.services.roleplay_prompt_assembly.build_worldbook_context", new=_spy):
        _append_worldbook_context(
            req, deps or _mk_deps(), dynamic_parts, [], [],
        )
    return captured, dynamic_parts


def _set_wi_settings(db: Session, user: User, wis: dict) -> None:
    db.add(UserSetting(
        user_id=user.id,
        silly_tavern_settings=json.dumps({"world_info_settings": wis}),
    ))
    db.commit()


# ---------------------------------------------------------------------------
# C1: 全局百分比预算（服务层）
# ---------------------------------------------------------------------------
class TestC1GlobalBudget:
    def _setup(self, db: Session, book_budget=None, book_cap=None):
        user, char = _mk_parents(db, "sess-c1", book_id="wb-c1")
        if book_budget is not None or book_cap is not None:
            wb = db.query(WorldBook).filter(WorldBook.id == "wb-c1").first()
            if book_budget is not None:
                wb.budget_tokens = book_budget
            if book_cap is not None:
                wb.budget_cap = book_cap
        db.add(_mk_stage("c1s", ["dragon"], "Dragon lore", "wb-c1"))
        db.commit()
        return user, char

    def test_global_budget_25_percent_of_max_context(self, db_session: Session):
        """全局 25% × max_context 生效（书级 budget_tokens 全空时兜底）。"""
        user, char = self._setup(db_session)
        result = build_worldbook_context(
            db=db_session, session_id="sess-c1", user_id=user.id,
            recent_messages=[{"role": "user", "content": "a dragon appears"}],
            character=char, enable_timed_effects=False,
            max_context_tokens=40000, world_info_budget=25,
        )
        assert result.budget_used == 10000, "25% × 40000 = 10000"

    def test_book_level_budget_wins_over_global(self, db_session: Session):
        """书级 budget_tokens 优先于全局百分比。"""
        user, char = self._setup(db_session, book_budget="10%")
        result = build_worldbook_context(
            db=db_session, session_id="sess-c1", user_id=user.id,
            recent_messages=[{"role": "user", "content": "a dragon appears"}],
            character=char, enable_timed_effects=False,
            max_context_tokens=40000, world_info_budget=25,
        )
        assert result.budget_used == 4000, "书级 10% × 40000 = 4000 优先"

    def test_global_cap_clamps_budget(self, db_session: Session):
        """全局 budget_cap>0 时钳制预算上限。"""
        user, char = self._setup(db_session)
        result = build_worldbook_context(
            db=db_session, session_id="sess-c1", user_id=user.id,
            recent_messages=[{"role": "user", "content": "a dragon appears"}],
            character=char, enable_timed_effects=False,
            max_context_tokens=40000, world_info_budget=25,
            world_info_budget_cap=3000,
        )
        assert result.budget_used == 3000, "cap=3000 钳制 10000 → 3000"

    def test_book_cap_wins_over_global_cap(self, db_session: Session):
        """书级 budget_cap 优先于全局 cap。"""
        user, char = self._setup(db_session, book_budget="10%", book_cap=2000)
        result = build_worldbook_context(
            db=db_session, session_id="sess-c1", user_id=user.id,
            recent_messages=[{"role": "user", "content": "a dragon appears"}],
            character=char, enable_timed_effects=False,
            max_context_tokens=40000, world_info_budget=25,
            world_info_budget_cap=3000,
        )
        assert result.budget_used == 2000, "书级 cap=2000 优先于全局 3000"

    def test_no_config_falls_back_16000(self, db_session: Session):
        """无书级预算且未传全局预算参数：回退 16000（存量直接调用方行为不变）。"""
        user, char = self._setup(db_session)
        result = build_worldbook_context(
            db=db_session, session_id="sess-c1", user_id=user.id,
            recent_messages=[{"role": "user", "content": "a dragon appears"}],
            character=char, enable_timed_effects=False,
            max_context_tokens=40000,
        )
        assert result.budget_used == DEFAULT_BUDGET, "无配置回退 16000 兜底"


# ---------------------------------------------------------------------------
# C1: 装配层读取透传
# ---------------------------------------------------------------------------
class TestC1AssemblyRead:
    def test_unconfigured_defaults_25_and_zero_cap(self, db_session: Session):
        """未配置用户：全局预算默认 25（ST world-info.js:73）、cap 默认 0。"""
        user, char = _mk_parents(db_session, "sess-c1a")
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["world_info_budget"] == 25
        assert captured["world_info_budget_cap"] == 0

    def test_configured_budget_passthrough(self, db_session: Session):
        """显式配置的预算值原样透传。"""
        user, char = _mk_parents(db_session, "sess-c1b")
        _set_wi_settings(db_session, user, {
            "world_info_budget": 40, "world_info_budget_cap": 5000,
        })
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["world_info_budget"] == 40
        assert captured["world_info_budget_cap"] == 5000


# ---------------------------------------------------------------------------
# C2: recursive 默认翻转（装配层）
# ---------------------------------------------------------------------------
class TestC2RecursiveDefault:
    def test_unconfigured_defaults_false(self, db_session: Session):
        """未配置用户：递归默认 False（ST world-info.js:75，C2 修正）。"""
        user, char = _mk_parents(db_session, "sess-c2a")
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["enable_recursive"] is False

    def test_user_setting_without_wi_settings_defaults_false(self, db_session: Session):
        """有 UserSetting 行但无 world_info_settings：同样取默认 False。"""
        user, char = _mk_parents(db_session, "sess-c2a2")
        db_session.add(UserSetting(user_id=user.id, silly_tavern_settings=None))
        db_session.commit()
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["enable_recursive"] is False

    def test_explicit_true_respected(self, db_session: Session):
        """存量显式 true 配置原样生效。"""
        user, char = _mk_parents(db_session, "sess-c2b")
        _set_wi_settings(db_session, user, {"world_info_recursive": True})
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["enable_recursive"] is True

    def test_explicit_false_respected(self, db_session: Session):
        """显式 false 配置原样生效。"""
        user, char = _mk_parents(db_session, "sess-c2c")
        _set_wi_settings(db_session, user, {"world_info_recursive": False})
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["enable_recursive"] is False


# ---------------------------------------------------------------------------
# C3: include_names 消费
# ---------------------------------------------------------------------------
class TestC3IncludeNames:
    def test_include_names_true_prefix_key_hits(self, db_session: Session):
        """include_names=True：消息按 "name: content" 拼接，"Alice:" 类 key 命中。"""
        user, char = _mk_parents(db_session, "sess-c3", book_id="wb-c3")
        db_session.add(_mk_stage("c3s", ["Alice:"], "Name-keyed lore", "wb-c3"))
        db_session.commit()
        msgs = [
            {"role": "assistant", "content": "hello there", "name": "Alice"},
            {"role": "user", "content": "hi", "name": "Tester"},
        ]
        result = build_worldbook_context(
            db=db_session, session_id="sess-c3", user_id=user.id,
            recent_messages=msgs, character=char, enable_timed_effects=False,
            include_names=True,
        )
        assert "Name-keyed lore" in _result_text(result), "带名字前缀应命中 Alice: key"

    def test_include_names_false_no_prefix_miss(self, db_session: Session):
        """include_names=False：纯 content，"Alice:" 类 key 不命中。"""
        user, char = _mk_parents(db_session, "sess-c3b", book_id="wb-c3b")
        db_session.add(_mk_stage("c3s", ["Alice:"], "Name-keyed lore", "wb-c3b"))
        db_session.commit()
        msgs = [
            {"role": "assistant", "content": "hello there", "name": "Alice"},
            {"role": "user", "content": "hi", "name": "Tester"},
        ]
        result = build_worldbook_context(
            db=db_session, session_id="sess-c3b", user_id=user.id,
            recent_messages=msgs, character=char, enable_timed_effects=False,
            include_names=False,
        )
        assert "Name-keyed lore" not in _result_text(result), "纯 content 不应命中 Alice: key"

    def test_nameless_message_falls_back_to_content(self, db_session: Session):
        """无 name 字段的消息退化为纯 content（存量消息零突变）。"""
        user, char = _mk_parents(db_session, "sess-c3c", book_id="wb-c3c")
        db_session.add(_mk_stage("c3s", ["hello"], "Plain lore", "wb-c3c"))
        db_session.commit()
        msgs = [{"role": "user", "content": "hello world"}]
        result = build_worldbook_context(
            db=db_session, session_id="sess-c3c", user_id=user.id,
            recent_messages=msgs, character=char, enable_timed_effects=False,
            include_names=True,
        )
        assert "Plain lore" in _result_text(result), "无 name 消息仍按纯 content 命中"

    def test_assembly_reads_and_passes_include_names(self, db_session: Session):
        """装配层读取 world_info_include_names 透传 + 消息 dict 带 name 字段。"""
        user, char = _mk_parents(db_session, "sess-c3d")
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["include_names"] is True, "ST 默认 true（world-info.js:74）"
        # is_init 路径：当前用户消息应携带 name（user_nickname）
        assert captured["recent_messages"][0].get("name") == "Tester"

    def test_assembly_configured_false_passthrough(self, db_session: Session):
        user, char = _mk_parents(db_session, "sess-c3e")
        _set_wi_settings(db_session, user, {"world_info_include_names": False})
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["include_names"] is False


# ---------------------------------------------------------------------------
# C4a: WI 正则 is_prompt=True
# ---------------------------------------------------------------------------
class TestC4aWIRegexIsPrompt:
    def _char_with_prompt_only_wi_script(self, db: Session, user: User) -> Character:
        char = Character(
            id=f"c4achar-{uuid.uuid4().hex[:8]}",
            user_id=user.id,
            name="Alice",
            extensions=json.dumps({
                "regex_scripts": [{
                    "scriptName": "wi-prompt-only-strip",
                    "findRegex": "SECRET_",
                    "replaceString": "",
                    "placement": [5],  # WORLD_INFO
                    "promptOnly": True,
                    "disabled": False,
                }],
            }),
        )
        db.add(char)
        db.commit()
        return char

    def test_prompt_only_script_applies_to_wi_content(self, db_session: Session):
        """promptOnly 脚本应作用于 WI 内容（ST world-info.js:5086 isPrompt:true）。"""
        from app.api.character_ext import _apply_regex_scripts

        user = User(
            username=f"c4a-{uuid.uuid4().hex[:8]}",
            hashed_password=get_password_hash("TestPassword1"),
            is_active=True,
        )
        db_session.add(user)
        db_session.commit()
        char = self._char_with_prompt_only_wi_script(db_session, user)

        deps = _mk_deps()
        # 接线真实正则实现：promptOnly 过滤由 is_prompt 参数驱动
        deps.apply_regex_scripts = _apply_regex_scripts
        req = _mk_req(db_session, user, char)
        _, dynamic_parts = _run_append(req, deps, wb_text="SECRET_lore content tail")
        assert dynamic_parts, "WI 文本应注入 dynamic_context_parts"
        assert "SECRET_" not in dynamic_parts[0], (
            "promptOnly 脚本未作用于 WI 内容（is_prompt 应为 True）"
        )
        assert "lore content tail" in dynamic_parts[0]


# ---------------------------------------------------------------------------
# C4b: ST 契约导入 useProbability 映射
# ---------------------------------------------------------------------------
class TestC4bUseProbabilityImport:
    def test_use_probability_false_persisted(self):
        """useProbability=false 落库（此前契约路径静默丢失，回退列默认 true）。"""
        from app.api.silly_tavern import _create_stage_from_st_entry

        now = datetime.now(timezone.utc)
        entry = {
            "uid": 0, "key": ["alpha"], "content": "alpha content",
            "comment": "a", "probability": 50, "useProbability": False,
        }
        stage = _create_stage_from_st_entry("wb-c4b", entry, 0, now)
        assert stage.use_probability is False, "useProbability=false 应映射落库"
        assert stage.probability == 50

    def test_use_probability_default_true_when_missing(self):
        """缺省回退 True（ST 默认）。"""
        from app.api.silly_tavern import _create_stage_from_st_entry

        now = datetime.now(timezone.utc)
        entry = {"uid": 0, "key": ["alpha"], "content": "alpha content", "comment": "a"}
        stage = _create_stage_from_st_entry("wb-c4b", entry, 0, now)
        assert stage.use_probability is True

    def test_imported_false_entry_fires_despite_zero_probability(self):
        """useProbability=false + probability=0：契约导入条目无视掷骰必现。"""
        from app.api.silly_tavern import _create_stage_from_st_entry

        now = datetime.now(timezone.utc)
        entry = {
            "uid": 0, "key": ["alpha"], "content": "alpha content",
            "comment": "a", "probability": 0, "useProbability": False,
        }
        stage = _create_stage_from_st_entry("wb-c4b", entry, 0, now)
        report = []
        activated = _scan_entries(
            [stage], [{"role": "user", "content": "alpha appears"}], None, None,
            message_index=0, visited=set(), recursion_depth=0, report=report,
        )
        assert stage.id in {e.id for e in activated}, (
            "useProbability=false 应无视 probability=0 必现"
        )


# ---------------------------------------------------------------------------
# C5: case_sensitive / match_whole_words 全局继承（matcher 单测）
# ---------------------------------------------------------------------------
def _mem_stage(keys: list[str], **kw) -> WorldBookStage:
    """内存条目（不经 DB，未设置的字段保持 None=继承全局）。"""
    return WorldBookStage(
        id=kw.pop("id", "mem-1"),
        world_book_id="wb-mem",
        stage_index=0,
        title="mem",
        content="mem content",
        keys=json.dumps(keys),
        secondary_keys=json.dumps(kw.pop("secondary_keys", [])),
        selective=kw.pop("selective", False),
        selective_logic=0,
        probability=100,
        constant=False,
        enabled=True,
        **kw,
    )


class TestC5GlobalInheritMatchers:
    def test_primary_case_sensitive_null_inherits_global_true(self):
        """entry.case_sensitive=None + 全局 true → 大小写敏感（world-info.js:269）。"""
        entry = _mem_stage(["Dragon"], case_sensitive=None)
        ok_on, _ = _match_primary_keys(
            entry, "a dragon appears", global_case_sensitive=True,
        )
        assert not ok_on, "全局 true 继承后 Dragon 不应命中小写 haystack"
        ok_off, _ = _match_primary_keys(
            entry, "a dragon appears", global_case_sensitive=False,
        )
        assert ok_off, "全局 false（默认）时大小写不敏感命中"

    def test_primary_entry_explicit_false_overrides_global_true(self):
        """entry 显式 False 覆盖全局 True（entry 值优先于继承）。"""
        entry = _mem_stage(["Dragon"], case_sensitive=False)
        ok, _ = _match_primary_keys(
            entry, "a dragon appears", global_case_sensitive=True,
        )
        assert ok, "条目显式 false 应覆盖全局 true"

    def test_primary_match_whole_words_null_inherits_global_true(self):
        """entry.match_whole_words=None + 全局 true → 全词匹配（world-info.js:347）。"""
        entry = _mem_stage(["drag"], match_whole_words=None)
        ok_on, _ = _match_primary_keys(
            entry, "a dragon appears", global_match_whole_words=True,
        )
        assert not ok_on, "全局 true 继承后 drag 不应子串命中 dragon"
        ok_off, _ = _match_primary_keys(
            entry, "a dragon appears", global_match_whole_words=False,
        )
        assert ok_off, "全局 false（默认）时子串命中"

    def test_secondary_case_sensitive_null_inherits_global(self):
        """secondary keys 同样继承全局大小写设置。"""
        entry = _mem_stage(
            ["dragon"], secondary_keys=["Fire"], case_sensitive=None,
            selective=True,
        )
        ok_on, _ = _match_secondary_keys(
            entry, "a dragon breathes fire", global_case_sensitive=True,
        )
        assert not ok_on, "全局 true 继承后 Fire 不应命中小写 fire"
        ok_off, _ = _match_secondary_keys(
            entry, "a dragon breathes fire", global_case_sensitive=False,
        )
        assert ok_off, "全局 false 时命中"


# ---------------------------------------------------------------------------
# C5: 全局继承（服务层 + 装配层）
# ---------------------------------------------------------------------------
class TestC5GlobalInheritService:
    def _setup_null_flag(self, db: Session, sess_id: str, book_id: str, column: str):
        user, char = _mk_parents(db, sess_id, book_id=book_id)
        db.add(_mk_stage("c5s", ["Dragon"], "Case lore", book_id))
        db.commit()
        # ORM 列默认会把布尔列填成 False；用 Core update 强制 NULL（=继承全局）
        db.execute(
            sa_update(WorldBookStage)
            .where(WorldBookStage.id == "c5s")
            .values(**{column: None})
        )
        db.commit()
        db.expire_all()
        return user, char

    def test_case_sensitive_global_true_blocks_lowercase_match(self, db_session: Session):
        """entry NULL + 全局 true → 大小写敏感生效（服务层全链路）。"""
        user, char = self._setup_null_flag(
            db_session, "sess-c5a", "wb-c5a", "case_sensitive",
        )
        msgs = [{"role": "user", "content": "a dragon appears"}]
        off = build_worldbook_context(
            db=db_session, session_id="sess-c5a", user_id=user.id,
            recent_messages=msgs, character=char, enable_timed_effects=False,
            world_info_case_sensitive=False,
        )
        assert "Case lore" in _result_text(off), "全局 false（默认）命中"
        on = build_worldbook_context(
            db=db_session, session_id="sess-c5a", user_id=user.id,
            recent_messages=msgs, character=char, enable_timed_effects=False,
            world_info_case_sensitive=True,
        )
        assert "Case lore" not in _result_text(on), "全局 true 继承 → 大小写敏感不命中"

    def test_match_whole_words_global_true_blocks_substring(self, db_session: Session):
        """entry NULL + 全局 true → 全词匹配生效（服务层全链路）。"""
        user, char = self._setup_null_flag(
            db_session, "sess-c5b", "wb-c5b", "match_whole_words",
        )
        db_session.execute(
            sa_update(WorldBookStage)
            .where(WorldBookStage.id == "c5s")
            .values(keys=json.dumps(["drag"]))
        )
        db_session.commit()
        msgs = [{"role": "user", "content": "a dragon appears"}]
        off = build_worldbook_context(
            db=db_session, session_id="sess-c5b", user_id=user.id,
            recent_messages=msgs, character=char, enable_timed_effects=False,
            world_info_match_whole_words=False,
        )
        assert "Case lore" in _result_text(off), "全局 false（默认）子串命中"
        on = build_worldbook_context(
            db=db_session, session_id="sess-c5b", user_id=user.id,
            recent_messages=msgs, character=char, enable_timed_effects=False,
            world_info_match_whole_words=True,
        )
        assert "Case lore" not in _result_text(on), "全局 true 继承 → 全词匹配不命中"


class TestC5AssemblyRead:
    def test_unconfigured_defaults_false(self, db_session: Session):
        """未配置用户：全局大小写敏感/全词匹配默认 False（现行为不变）。"""
        user, char = _mk_parents(db_session, "sess-c5c")
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["world_info_case_sensitive"] is False
        assert captured["world_info_match_whole_words"] is False

    def test_configured_true_passthrough(self, db_session: Session):
        """显式 true 配置透传（entry NULL 时将继承 true）。"""
        user, char = _mk_parents(db_session, "sess-c5d")
        _set_wi_settings(db_session, user, {
            "world_info_case_sensitive": True,
            "world_info_match_whole_words": True,
        })
        captured, _ = _run_append(_mk_req(db_session, user, char))
        assert captured["world_info_case_sensitive"] is True
        assert captured["world_info_match_whole_words"] is True
