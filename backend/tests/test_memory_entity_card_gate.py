"""分层记忆 Phase 1 + 1b 测试（2026-09-03）：实体卡注入 / 长会话门控 / 注入档位。

spec: docs/SPEC_分层记忆注入_2026-09-02.md §4.1 / §4.1b。

覆盖面：
纯函数：
1. _flatten_stat_data：嵌套压平 / _ 开头跳过 / 空值跳过 / list 连接 / 非 dict 输入
2. _resolve_memory_max_tokens：0-3 档 → 750/4000/6000/8000（2026-10-09 p55 细扫重定，
   默认档 1 由 1500 改为实测最优的 4000）；NULL/越界/无属性 → 4000
3. _memory_gate_should_skip：装得下跳过 / 装不下检索 / 等值边界跳过（保守）
4. 迁移条目：_RUNTIME_COMPAT_COLUMNS 含 user_settings.memory_budget_level
集成（_append_memory_context，Fake MemoryService 隔离检索层）：
5. MVU 卡 + stat_data → 实体卡进 parts + report included + 检索照常
6. 非 MVU 卡 → 无实体卡
7. memory_mode=disabled → 全跳
8. 门控：预算充裕跳过检索并 report；预算紧张照常检索；token_budget=None 兼容
9. 档位透传：level=2 → get_context 收到 max_tokens=6000（2026-10-10 订正：原写 3000，
   档位表 2026-10-09 重定为 (750,4000,6000,8000)）
10. 实体卡超限截断 → report detail=truncated
"""

import asyncio
import json
import os
import sys
from types import SimpleNamespace

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    import sqlalchemy as sa

    from app.core import migrations as migrations_mod
    from app.models import CharacterChatMessage, CharacterChatSession, CharacterChatSessionBranch, GroupChat
    from app.services import roleplay_prompt_assembly as rpa
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

_SESSION_ID = "s-entity-gate"


# ---------------------------------------------------------------------------
# Fake 检索层：隔离 MemoryService，只验证调用参数与门控行为
# ---------------------------------------------------------------------------
class _FakeMemoryService:
    calls: list = []

    def __init__(self, db):
        self.db = db

    def is_available(self):
        return True

    async def get_context(self, **kwargs):
        _FakeMemoryService.calls.append(kwargs)
        return None


@pytest.fixture()
def gate_env(db_session, monkeypatch):
    _FakeMemoryService.calls = []
    monkeypatch.setattr(rpa, "MemoryService", _FakeMemoryService)
    # ST 向量让步关闭（默认无 st-vec 数据，显式隔离）
    monkeypatch.setattr(rpa, "_st_vector_data_active", lambda db, uid: False)
    return db_session


def _make_req(db, char_ext=None, session_id=_SESSION_ID, group_id=None):
    if char_ext is None:
        # MVU 卡真身：extensions.regex_scripts[].findRegex 含 UpdateVariable
        # （_card_has_mvu_scripts 的判定形态，见 status_bar_detector.py:347）
        char_ext = json.dumps({"regex_scripts": [{"findRegex": "/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/"}]})
    return rpa.PromptAssemblyRequest(
        db=db,
        user=SimpleNamespace(id=1, username="tester"),
        char=SimpleNamespace(name="桃汐", extensions=char_ext),
        session_id=session_id,
        branch_id=None,
        message="你好",
        group_id=group_id,
    )


_DEPS = SimpleNamespace(replace_placeholders=lambda text, nick, char_name: text)


def _seed_session(db, stat_data=None, msgs=()):
    db.add(CharacterChatSession(
        id=_SESSION_ID,
        chat_metadata=json.dumps({"variables": {"stat_data": stat_data or {}}}),
    ))
    for role, content in msgs:
        db.add(CharacterChatMessage(session_id=_SESSION_ID, role=role, content=content))
    db.commit()


def _run_append(db, parts, report, memory_mode="rule", char_ext=None, session_id=_SESSION_ID, group_id=None, **kwargs):
    req = _make_req(db, char_ext=char_ext, session_id=session_id, group_id=group_id)
    return asyncio.run(rpa._append_memory_context(
        req, _DEPS, memory_mode, parts, report, **kwargs
    ))


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------
class TestFlattenStatData:
    def test_nested_flatten(self):
        stat = {
            "世界信息": {"日期时间": "第一天", "地点": "咖啡馆", "天气": ""},
            "桃汐": {"好感度": 50, "_inner": "x", "tags": ["傲娇", "猫耳"]},
        }
        out = rpa._flatten_stat_data(stat)
        assert "世界信息：日期时间=第一天；地点=咖啡馆" in out
        assert "天气" not in out  # 空值跳过
        assert "好感度=50" in out
        assert "_inner" not in out  # 只读字段跳过
        assert "tags=傲娇、猫耳" in out

    def test_non_dict_input(self):
        assert rpa._flatten_stat_data(None) == ""
        assert rpa._flatten_stat_data("str") == ""
        assert rpa._flatten_stat_data([1, 2]) == ""
        assert rpa._flatten_stat_data({}) == ""

    def test_scalar_group(self):
        out = rpa._flatten_stat_data({"主线": "进行中"})
        assert out == "主线：进行中"


class TestResolveMemoryMaxTokens:
    # 档位表 2026-10-09 重定：(750, 4000, 6000, 8000)，默认档（index 1）= 4000。
    # 依据 p55 细扫：4000 实测最优（见 roleplay_prompt_assembly 该常量处注释）。
    @pytest.mark.parametrize("level,expected", [(0, 750), (1, 4000), (2, 6000), (3, 8000)])
    def test_levels(self, level, expected):
        assert rpa._resolve_memory_max_tokens(SimpleNamespace(memory_budget_level=level)) == expected

    @pytest.mark.parametrize("bad", [None, 99, -1, "2"])
    def test_fallbacks(self, bad):
        assert rpa._resolve_memory_max_tokens(SimpleNamespace(memory_budget_level=bad)) == 4000

    def test_no_attr_and_none_setting(self):
        assert rpa._resolve_memory_max_tokens(SimpleNamespace()) == 4000
        assert rpa._resolve_memory_max_tokens(None) == 4000


class TestMemoryGate:
    def test_within_budget_skips(self):
        # 系统提示 500 + 已注入 300 + 历史 2000 字 + 预留 1024 = 3824 << 100000
        assert rpa._memory_gate_should_skip(500, 300, 2000, 1024, 100000) is True

    def test_over_budget_retrieves(self):
        assert rpa._memory_gate_should_skip(500, 300, 20000, 1024, 10000) is False

    def test_boundary_equal_skips(self):
        # 恰好等值 → 判定"装得下"跳过（保守：宁可误开是往检索方向偏，等值偏跳过
        # 与 1 字≈1 token 的高估共同构成整体保守方向）
        assert rpa._memory_gate_should_skip(500, 300, 2000, 1024, 3824) is True

    # ── 2026-09-22 修正：历史被窗口裁剪时必须检索 ──
    # 原判据只比"历史字符数 vs 模型上下文预算"，对 context_length=1_000_000 的
    # 模型预算高达 995392，实测全库最大会话仅 2321 字符 → 恒真跳过，
    # 向量记忆从未注入（且 rule 模式的最近 N 条也被一并砍掉）。
    def test_truncated_history_always_retrieves(self):
        # 预算极其宽裕，但历史已被窗口裁剪 → 不能跳过
        assert rpa._memory_gate_should_skip(
            500, 300, 2000, 1024, 100000, history_truncated=True) is False

    def test_untruncated_history_still_skips(self):
        assert rpa._memory_gate_should_skip(
            500, 300, 2000, 1024, 100000, history_truncated=False) is True

    def test_truncated_beats_budget(self):
        # 裁剪优先级高于预算比较：即便装得下也必须检索
        assert rpa._memory_gate_should_skip(
            0, 0, 0, 0, 10 ** 9, history_truncated=True) is False

    def test_migration_column_registered(self):
        cols = {(t, c) for t, c, _ in migrations_mod._RUNTIME_COMPAT_COLUMNS}
        assert ("user_settings", "memory_budget_level") in cols


# ---------------------------------------------------------------------------
# 集成：_append_memory_context
# ---------------------------------------------------------------------------
class TestEntityCardIntegration:
    def test_mvu_card_injects_entity_card(self, gate_env):
        db = gate_env
        _seed_session(db, stat_data={"世界信息": {"日期时间": "第一天", "地点": "咖啡馆"}})
        parts, report = [], []
        _run_append(db, parts, report)
        assert any("当前状态" in p and "日期时间=第一天" in p for p in parts)
        item = next(i for i in report if i.key == "memory_entity_card")
        assert item.status == "included"
        # 检索照常发生（实体卡不受门控影响，此处 token_budget=None 不门控）
        assert len(_FakeMemoryService.calls) == 1

    def test_non_mvu_card_skipped(self, gate_env):
        db = gate_env
        _seed_session(db, stat_data={"世界信息": {"日期时间": "第一天"}})
        parts, report = [], []
        _run_append(db, parts, report, char_ext="{}")
        assert not any("当前状态" in p for p in parts)
        assert not any(i.key == "memory_entity_card" and i.status == "included" for i in report)

    def test_disabled_mode_skips_all(self, gate_env):
        db = gate_env
        _seed_session(db, stat_data={"世界信息": {"日期时间": "第一天"}})
        parts, report = [], []
        _run_append(db, parts, report, memory_mode="disabled")
        assert parts == []
        assert len(_FakeMemoryService.calls) == 0

    def test_truncated_report(self, gate_env):
        db = gate_env
        big = {f"组{i}": {f"字段{j}": "长" * 120 for j in range(5)} for i in range(4)}
        _seed_session(db, stat_data=big)
        parts, report = [], []
        _run_append(db, parts, report)
        item = next(i for i in report if i.key == "memory_entity_card")
        assert item.status == "included"
        assert "truncated" in (item.detail or "")


class TestGateIntegration:
    def test_within_budget_skips_retrieval(self, gate_env):
        db = gate_env
        _seed_session(db, msgs=[("user", "短"), ("assistant", "短")])
        parts, report = [], []
        _run_append(db, parts, report, token_budget=10**9, system_prompt="sys", history_reserve=1024)
        assert len(_FakeMemoryService.calls) == 0
        item = next(i for i in report if i.key == "memory")
        assert item.status == "skipped"
        assert "gate" in (item.detail or "")

    def test_tight_budget_retrieves(self, gate_env):
        db = gate_env
        _seed_session(db, msgs=[("user", "短"), ("assistant", "短")])
        parts, report = [], []
        _run_append(db, parts, report, token_budget=1, system_prompt="sys", history_reserve=1024)
        assert len(_FakeMemoryService.calls) == 1

    def test_none_budget_compat(self, gate_env):
        db = gate_env
        _seed_session(db, msgs=[("user", "短"), ("assistant", "短")])
        parts, report = [], []
        _run_append(db, parts, report)  # token_budget=None → 不门控（兼容路径）
        assert len(_FakeMemoryService.calls) == 1

    # ── 2026-09-22 修正：历史被窗口裁剪时必须检索 ──
    def test_truncated_history_retrieves_despite_huge_budget(self, gate_env, monkeypatch):
        """回归：1M 上下文模型下预算极高，旧判据恒真跳过，记忆从未注入。

        窗口上限压到 2 条、实际 5 条历史 → 已裁剪 → 必须检索。
        """
        db = gate_env
        _seed_session(db, msgs=[("user", f"第{i}轮") for i in range(5)])
        monkeypatch.setattr(rpa, "_resolve_history_window_limit", lambda req: 2)
        parts, report = [], []
        _run_append(db, parts, report, token_budget=10**9, system_prompt="sys", history_reserve=1024)
        assert len(_FakeMemoryService.calls) == 1, "历史被裁剪时必须检索"

    def test_untruncated_history_still_skips(self, gate_env, monkeypatch):
        """未裁剪且装得进预算 → 保留原有的省 token 行为。"""
        db = gate_env
        _seed_session(db, msgs=[("user", "短"), ("assistant", "短")])
        monkeypatch.setattr(rpa, "_resolve_history_window_limit", lambda req: 10)
        parts, report = [], []
        _run_append(db, parts, report, token_budget=10**9, system_prompt="sys", history_reserve=1024)
        assert len(_FakeMemoryService.calls) == 0
        item = next(i for i in report if i.key == "memory")
        assert "gate" in (item.detail or "")
        assert "2/10" in (item.detail or ""), "report 应带上消息数/窗口上限"

    def test_window_limit_prefers_group_budget(self, gate_env, monkeypatch):
        """群聊取 GroupChat.recent_messages_budget，否则回退全局限制。"""
        db = gate_env
        fake_group = SimpleNamespace(recent_messages_budget=7)
        monkeypatch.setattr(rpa, "_cached_request_group", lambda req, gid: fake_group)
        assert rpa._resolve_history_window_limit(
            SimpleNamespace(db=db, group_id="g-1")) == 7

        monkeypatch.setattr(rpa, "_cached_request_group", lambda req, gid: None)
        assert rpa._resolve_history_window_limit(
            SimpleNamespace(db=db, group_id="g-1")) == int(
                rpa._memory_settings().CHARACTER_CHAT_HISTORY_LIMIT)

        assert rpa._resolve_history_window_limit(
            SimpleNamespace(db=db, group_id=None)) == int(
                rpa._memory_settings().CHARACTER_CHAT_HISTORY_LIMIT)

    def test_estimate_failure_retrieves(self, gate_env, monkeypatch):
        db = gate_env
        _seed_session(db, msgs=[("user", "短"), ("assistant", "短")])
        # 历史估算失败 → 视为超预算，照常检索（宁误开勿误关）
        monkeypatch.setattr(rpa.func, "sum", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
        parts, report = [], []
        _run_append(db, parts, report, token_budget=10**9, system_prompt="sys", history_reserve=1024)
        assert len(_FakeMemoryService.calls) == 1

    def test_real_db_failure_recovers_session(self, gate_env):
        """真 DB 异常（非 Python 层 mock）：删表让聚合查询抛 OperationalError。

        修复前：裸查询异常会把 session 打成 failed 状态，后续 begin_nested /
        任何 DB 查询连锁抛 PendingRollbackError。修复后：SAVEPOINT 回滚，
        session 保持干净，检索照常、装配继续。"""
        from sqlalchemy import text
        db = gate_env
        _seed_session(db)
        db.commit()
        db.execute(text("DROP TABLE character_chat_messages"))
        parts, report = [], []
        # 不应抛异常；实体卡/门控各自降级，检索（Fake 不查表）照常
        _run_append(db, parts, report, token_budget=10**9, system_prompt="sys", history_reserve=1024)
        assert len(_FakeMemoryService.calls) == 1
        # session 未被污染：仍能执行查询（修复前此处抛 PendingRollbackError）
        assert db.execute(text("SELECT 1")).scalar() == 1


class TestLevelPassthrough:
    @pytest.mark.parametrize("level,expected", [(0, 750), (2, 6000), (3, 8000)])
    def test_level_reaches_get_context(self, gate_env, level, expected):
        db = gate_env
        _seed_session(db)
        parts, report = [], []
        _run_append(
            db, parts, report,
            memory_max_tokens=rpa._resolve_memory_max_tokens(SimpleNamespace(memory_budget_level=level)),
            token_budget=1,  # 预算紧张保证走到检索
        )
        assert _FakeMemoryService.calls, "检索应被调用"
        assert _FakeMemoryService.calls[0]["max_tokens"] == expected


# ---------------------------------------------------------------------------
# 脏数据全矩阵（小概率事件加固，2026-09-03 用户要求）：任何畸形输入都必须
# 静默跳过、不抛异常、检索链路照常；实体卡只读、绝不写库。
# ---------------------------------------------------------------------------
class TestDirtyDataMatrix:
    def _seed_raw(self, db, chat_metadata_text, session_id="s-dirty"):
        db.add(CharacterChatSession(id=session_id, chat_metadata=chat_metadata_text))
        db.commit()
        return session_id

    @pytest.mark.parametrize("meta_text", [
        "not-json{",                            # 非法 JSON（被截断/手改坏）
        "[]",                                   # JSON 但不是 dict
        '"just-a-string"',                      # JSON 字符串
        '{"variables": "not-a-dict"}',          # variables 非 dict
        '{"variables": {"stat_data": "x"}}',    # stat_data 非 dict
        '{"variables": {}}',                    # 缺 stat_data
        '{"other": 1}',                         # 无关键
        "{}",                                   # 空 metadata
        "null",                                 # JSON null
    ])
    def test_dirty_metadata_silent_skip(self, gate_env, meta_text):
        db = gate_env
        sid = self._seed_raw(db, meta_text)
        parts, report = [], []
        _run_append(db, parts, report, session_id=sid)
        assert not any("当前状态" in p for p in parts)  # 无实体卡
        assert len(_FakeMemoryService.calls) == 1       # 检索链路照常

    def test_null_metadata_column(self, gate_env):
        db = gate_env
        db.add(CharacterChatSession(id="s-nullmeta", chat_metadata=None))
        db.commit()
        parts, report = [], []
        _run_append(db, parts, report, session_id="s-nullmeta")
        assert not any("当前状态" in p for p in parts)
        assert len(_FakeMemoryService.calls) == 1

    def test_missing_session_row(self, gate_env):
        db = gate_env
        parts, report = [], []
        _run_append(db, parts, report, session_id="no-such-session")
        assert not any("当前状态" in p for p in parts)
        assert len(_FakeMemoryService.calls) == 1

    def test_deep_nested_stat(self, gate_env):
        db = gate_env
        deep = {"a": {"b": {"c": {"d": {"e": "太深"}}}}, "顶层": "ok"}
        _seed_session(db, stat_data=deep)
        parts, report = [], []
        _run_append(db, parts, report)
        assert any("顶层：ok" in p for p in parts)  # 组级标量用全角冒号
        assert not any("太深" in p for p in parts)  # 超深层被整支丢弃，不崩

    def test_dirty_values_sanitized(self, gate_env):
        db = gate_env
        stat = {
            "世界信息": {
                "长文本": "字" * 500,               # 超长叶子 → 120 截断
                "带换行": "第一行\n第二行",           # 换行 → 空格
                "带标签": "<UpdateVariable>脏</UpdateVariable>",  # 标签配平
                "none值": None,                      # None 跳过
            },
        }
        _seed_session(db, stat_data=stat)
        parts, report = [], []
        _run_append(db, parts, report)
        card = next(p for p in parts if "当前状态" in p)
        # [2026-10-10 修复] 原断言是 `assert X or True` —— 恒真，什么都不测。
        # 而且即便去掉 or True 它仍是**重言式**：`.split("\n")[0]` 按定义就不含换行，
        # 所以那条断言无论如何都成立。改为直接验证真实行为：
        # _flatten_stat_value 末尾的 text.replace("\n", " ")[:120]（RPA:5167）。
        assert "第一行 第二行" in card               # 换行 → 空格
        assert "第一行\n第二行" not in card          # 原始换行不残留
        assert "字" * 121 not in card               # 长度截断生效
        assert "none值" not in card

    def test_readonly_never_writes(self, gate_env):
        db = gate_env
        meta = json.dumps({"variables": {"stat_data": {"世界信息": {"地点": "咖啡馆"}}}})
        db.add(CharacterChatSession(id=_SESSION_ID, chat_metadata=meta))
        db.commit()
        parts, report = [], []
        _run_append(db, parts, report)
        row = db.query(CharacterChatSession).filter(CharacterChatSession.id == _SESSION_ID).first()
        assert row.chat_metadata == meta  # 只读：入库数据分毫未动


class TestGateDirtyData:
    def test_null_content_rows_ignored(self, gate_env):
        db = gate_env
        db.add(CharacterChatSession(id=_SESSION_ID, chat_metadata="{}"))
        db.add(CharacterChatMessage(session_id=_SESSION_ID, role="user", content="正常消息"))
        db.add(CharacterChatMessage(session_id=_SESSION_ID, role="assistant", content=None))  # 脏 NULL
        db.commit()
        parts, report = [], []
        # NULL content 不占窗口（无文本），SUM 忽略之；小历史+大预算 → 跳过
        _run_append(db, parts, report, token_budget=10**9, system_prompt="s", history_reserve=1024)
        assert len(_FakeMemoryService.calls) == 0

    def test_branch_scope_estimates_branch_only(self, gate_env):
        db = gate_env
        db.add(CharacterChatSession(id=_SESSION_ID, chat_metadata="{}"))
        db.add(CharacterChatSessionBranch(id="br1", session_id=_SESSION_ID))
        db.commit()
        # 主聊天大量历史（分支视角下不应计入）+ 分支少量消息
        db.add(CharacterChatMessage(session_id=_SESSION_ID, branch_id=None, role="user", content="主" * 5000))
        db.add(CharacterChatMessage(session_id=_SESSION_ID, branch_id="br1", role="user", content="支" * 10))
        db.commit()
        parts, report = [], []
        # 分支内历史≈10字 + 当前消息≈2字，预算 2000 → 应判定装得下跳过
        # （若分支口径失效，主聊天 5000 字会被计入 → 超预算 → 检索）
        req = _make_req(db, session_id=_SESSION_ID)
        from dataclasses import replace
        req_br = replace(req, branch_id="br1")
        asyncio.run(rpa._append_memory_context(
            req_br, _DEPS, "rule", parts, report, token_budget=2000, system_prompt="", history_reserve=1024,
        ))
        assert len(_FakeMemoryService.calls) == 0


class TestGroupEntityCard:
    def test_group_variables_take_priority(self, gate_env):
        db = gate_env
        db.add(CharacterChatSession(id="s-g", chat_metadata=json.dumps({"variables": {"stat_data": {"世界信息": {"地点": "会话级"}}}})))
        db.add(GroupChat(id="g1", name="群", member_ids="[]", chat_metadata=json.dumps({"variables": {"stat_data": {"世界信息": {"地点": "群聊别墅"}}}})))
        db.commit()
        parts, report = [], []
        _run_append(db, parts, report, session_id="s-g", group_id="g1")
        card = next(p for p in parts if "当前状态" in p)
        assert "群聊别墅" in card
        assert "会话级" not in card

    def test_missing_group_falls_back_to_session(self, gate_env):
        db = gate_env
        _seed_session(db, stat_data={"世界信息": {"地点": "会话级"}})
        parts, report = [], []
        _run_append(db, parts, report, group_id="no-such-group")
        card = next(p for p in parts if "当前状态" in p)
        assert "会话级" in card

    def test_group_without_variables_falls_back(self, gate_env):
        db = gate_env
        db.add(CharacterChatSession(id="s-g2", chat_metadata=json.dumps({"variables": {"stat_data": {"世界信息": {"地点": "回退值"}}}})))
        db.add(GroupChat(id="g2", name="空群", member_ids="[]", chat_metadata=json.dumps({"other": 1})))
        db.commit()
        parts, report = [], []
        _run_append(db, parts, report, session_id="s-g2", group_id="g2")
        card = next(p for p in parts if "当前状态" in p)
        assert "回退值" in card


class TestSchemaDefense:
    def test_string_level_coerced(self):
        from app.schemas.user import UserSettingUpdate
        assert UserSettingUpdate(memory_budget_level="2").memory_budget_level == 2

    def test_fractional_float_rejected(self):
        from pydantic import ValidationError
        from app.schemas.user import UserSettingUpdate
        with pytest.raises(ValidationError):
            UserSettingUpdate(memory_budget_level=2.5)

    def test_out_of_range_normalized_by_api(self):
        # API 层防呆在 users.py PUT（99→1），读侧 _resolve_memory_max_tokens 再兜一层
        assert rpa._resolve_memory_max_tokens(SimpleNamespace(memory_budget_level=99)) == 4000
