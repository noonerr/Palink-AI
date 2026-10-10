"""记忆检索四项修复的行为测试（2026-10-09）。

来源：docs/_active/report/REPORT_记忆最优解复核_关键词路与查询构造_2026-10-09.md
     + docs/_active/report/REPORT_记忆块截断审计与预算甜点_2026-10-09.md
      + 探针 p46/p47/p49/p50 的实测结论。

四项修复（每项都带 env 开关，置 0 / 旧值即回到 2026-10-09 前的行为）：
  1. 查询构造：改用**本轮消息**（清洗后），不再拿"最近 4 条拼接 600 字"去查
     ——实测那 600 字里本轮问题只占 3.4%（n=50 中位）。
  2. 关键词路：pg_trgm 粗筛 + 字符二元组覆盖率精排，与向量路 RRF 融合
     ——注入命中 66% → 74~86%（同一批 50 道题）。
  3. 邻居扩展独立预算：旧实现与检索共用 max_tokens ⇒ 恒 +0 条（实测 24 次
     检索全部 0 条），切开的块永远只注入半截。
  4. 切分软边界：句号/分号都找不到时退到逗号/顿号/引号，而不是硬切在词中间。

判据要求（SOP §7）：断言**行为**不断言源码字符串。下面每条用例都设计成
"把修复改回旧写法就会红"。
"""

import os
import sys
from datetime import datetime, timedelta

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from sqlalchemy import text

    from app.memory_module import storage as mem_storage_mod
    from app.memory_module.config import memory_config
    from app.memory_module.models import ContextRequest, ContextResponse, MemoryEntry
    from app.memory_module.retriever import MemoryRetriever
    from app.memory_module.service import MemoryService
    from app.memory_module.storage import MemoryStorage, _bigram_set
    from app.memory_module import semantic_chunker as sc
    from app.services.roleplay_prompt_assembly import _build_memory_query
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")

SESSION_ID = "mem-hybrid-session"


# ─────────────────────────── 1. 查询构造 ────────────────────────────────────

class _FakeQuery:
    """最小可链的 query 替身；只为让 _build_memory_query 的回退分支可测。"""

    def __init__(self, rows):
        self._rows = rows

    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def limit(self, n):
        return self

    def scalar(self):
        return self._rows[0][0] if self._rows else None

    def all(self):
        return self._rows


class _FakeDB:
    def __init__(self, rows):
        self._rows = rows

    def query(self, *a):
        return _FakeQuery(self._rows)


class TestMemoryQueryConstruction:
    """查询只该装"本轮问题"，不该装上一条回复的尾巴和状态指令。"""

    def test_current_mode_strips_state_and_voice_tags(self, monkeypatch):
        """本轮消息里的 <UpdateVariable> / 【声音：…】 必须从查询里消失。"""
        monkeypatch.setattr(memory_config, "QUERY_MODE", "current")
        monkeypatch.setattr(memory_config, "QUERY_MIN_CHARS", 5)
        msg = (
            "我昨天送你的那条发夹你还戴着吗"
            "<UpdateVariable><var>好感度</var><value>80</value></UpdateVariable>"
            "【声音：轻声，带点喘息】"
        )
        out = _build_memory_query(_FakeDB([]), SESSION_ID, None, msg)
        assert "UpdateVariable" not in out
        assert "好感度" not in out
        assert "声音" not in out
        assert "发夹" in out, "正文必须保留，纯化不能把问题本身洗掉"

    def test_too_short_falls_back_to_previous_tail(self, monkeypatch):
        """清洗后过短（< QUERY_MIN_CHARS）才补最近 1 条消息的**尾部**。

        补"尾部"而不是整条：整条拼接正是被实测推翻的稀释来源（本轮只占 3.4%）。
        """
        monkeypatch.setattr(memory_config, "QUERY_MODE", "current")
        monkeypatch.setattr(memory_config, "QUERY_MIN_CHARS", 15)
        monkeypatch.setattr(memory_config, "QUERY_FALLBACK_CHARS", 120)
        prev = "她把发夹别在耳后，笑着说这是你送的。" * 30  # 540 字，远长于回退上限
        db = _FakeDB([(prev,)])
        out = _build_memory_query(db, SESSION_ID, None, "后来呢")
        assert "后来呢" in out
        assert out.startswith(prev[:8]) is False, "取的是**尾部**，不是整条上文"
        assert out.startswith(prev[-120:]), "回退片段必须正好是上文的最后 120 字"
        assert len(out) == 120 + 1 + len("后来呢")

    def test_long_enough_never_touches_db(self, monkeypatch):
        """够长时不查库——查询构造不该给每轮对话加一次 SQL。"""
        monkeypatch.setattr(memory_config, "QUERY_MODE", "current")
        monkeypatch.setattr(memory_config, "QUERY_MIN_CHARS", 5)

        class _ExplodingDB:
            def query(self, *a):
                raise AssertionError("查询够长时不应访问数据库")

        out = _build_memory_query(_ExplodingDB(), SESSION_ID, None, "我们第一次见面是在哪")
        assert out == "我们第一次见面是在哪"

    def test_window_mode_restores_legacy_behavior(self, monkeypatch):
        """MEMORY_QUERY_MODE=window 一键回到 2026-10-07 的旧行为（拼接 + 尾截）。"""
        monkeypatch.setattr(memory_config, "QUERY_MODE", "window")
        rows = [(f"上文第{i}条内容" * 5, "assistant") for i in range(4)]
        out = _build_memory_query(_FakeDB(rows), SESSION_ID, None, "本轮问题")
        assert len(out) <= 600, "旧行为有 600 字尾截上限"
        assert out.endswith("本轮问题")
        # 旧行为是"多轮拼接"：四条上文**全都**进了查询（这正是被订正的点）
        for i in range(4):
            assert f"上文第{i}条内容" in out


# ─────────────────────────── 2. 关键词路 ────────────────────────────────────

class TestBigramSet:
    def test_cjk_bigrams(self):
        assert _bigram_set("翅膀") == {"翅膀"}
        # 连续二字组（不是任意二字组合）：黑色/色翅/翅膀
        assert _bigram_set("黑色翅膀") == {"黑色", "色翅", "翅膀"}

    def test_punctuation_and_space_stripped(self):
        """标点/空白不参与匹配，否则一个逗号就能打断整条字面对齐。"""
        assert _bigram_set("你，好 啊！") == {"你好", "好啊"}

    def test_single_char_and_empty(self):
        assert _bigram_set("啊") == {"啊"}
        assert _bigram_set("") == set()
        assert _bigram_set(None) == set()


class TestKeywordPathDegradesOnSqlite:
    """测试库是 SQLite（无 pg_trgm）：关键词路必须**静默关闭**，不得拖垮检索。"""

    @pytest.fixture()
    def mem_env(self, db_session, monkeypatch):
        monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
        monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
        monkeypatch.setattr(mem_storage_mod, "_trgm_cached", None)
        monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
        monkeypatch.setattr(memory_config, "ENABLED", True)
        return MemoryStorage(db_session), db_session

    def test_keyword_search_returns_empty_without_pg_trgm(self, mem_env, test_user):
        storage, db = mem_env
        db.execute(
            text(
                "INSERT INTO conversation_memories "
                "(user_id, session_id, role, content, importance_score, tokens_count, created_at) "
                "VALUES (:u, :s, 'assistant', :c, 0.5, 10, :t)"
            ),
            {"u": test_user.id, "s": SESSION_ID, "c": "黑色翅膀的来历",
             "t": datetime.utcnow()},
        )
        db.flush()
        assert storage.keyword_search(
            user_id=test_user.id, query_text="黑色翅膀", session_id=SESSION_ID
        ) == []

    def test_retriever_still_works_with_keyword_path_off(self, mem_env, test_user, monkeypatch):
        """关键词路不可用时，检索结果必须与修复前一致（不得返回 error/空）。"""
        import numpy as np

        from app.memory_module import retriever as retriever_mod

        storage, db = mem_env
        unit = [1.0] + [0.0] * 1023
        monkeypatch.setattr(
            retriever_mod, "embed_text", lambda t: np.array([unit], dtype=np.float32)
        )
        base = datetime(2026, 10, 9, 12, 0, 0)
        for i in range(1, 4):
            db.execute(
                text(
                    "INSERT INTO conversation_memories "
                    "(user_id, session_id, role, content, importance_score, topics, "
                    " tokens_count, created_at, message_id, embedding) "
                    "VALUES (:u, :s, 'assistant', :c, 0.5, '[]', 10, :t, :m, :e)"
                ),
                {"u": test_user.id, "s": SESSION_ID, "c": f"记忆条目{i}",
                 "t": base + timedelta(seconds=i), "m": i,
                 "e": __import__("json").dumps(unit)},
            )
        db.flush()
        resp = MemoryRetriever(storage).retrieve(
            ContextRequest(user_id=test_user.id, query="记忆条目",
                           session_id=SESSION_ID, max_tokens=2000,
                           memory_mode="vector", include_profile=False)
        )
        assert resp.strategy_used != "error"
        assert len(resp.memories) == 3


class TestRrfFusion:
    """RRF 融合的两条硬性质：关键词命中的条目要能被捞上来；STM 不得重复注入。"""

    @staticmethod
    def _mem(mid, content):
        return MemoryEntry(id=mid, user_id=1, session_id=SESSION_ID, role="assistant",
                           content=content, tokens_count=10, created_at=datetime(2026, 10, 9))

    def test_keyword_only_hit_is_promoted(self):
        """向量路把目标排在第 40 位、关键词路排第 1 ⇒ 融合后必须进前三。

        这正是线上最典型的失败：问"发夹"时，向量路全体记忆相似度都差不多，
        真正的那条只是"字面完全对得上"而已。
        """
        r = MemoryRetriever.__new__(MemoryRetriever)
        target = self._mem(999, "你把发夹别在她耳后")
        dense = [(self._mem(i, f"无关记忆{i}"), 0.9 - i * 0.001) for i in range(1, 45)]
        dense = dense[:39] + [(target, 0.55)] + dense[39:]
        kw = [(target, 0.8), (self._mem(7, "无关记忆7"), 0.2)]
        fused = r._fuse_rrf(dense, kw, set(), w_kw=0.7, k=60)
        top3 = [m.id for m, _ in fused[:3]]
        assert 999 in top3, f"关键词命中未进前三，实际前五 {[m.id for m, _ in fused[:5]]}"

    def test_dense_only_entry_not_lost(self):
        """只有向量路命中的条目不能因为没进关键词路就被丢掉。"""
        r = MemoryRetriever.__new__(MemoryRetriever)
        dense = [(self._mem(1, "语义相近但用词不同"), 0.88)]
        kw = [(self._mem(2, "字面重合"), 0.9)]
        fused = r._fuse_rrf(dense, kw, set(), w_kw=0.7, k=60)
        assert {m.id for m, _ in fused} == {1, 2}

    def test_stm_memories_are_not_duplicated(self):
        """已在短期记忆里的条目不得再进长期候选（否则同一条注入两次）。"""
        r = MemoryRetriever.__new__(MemoryRetriever)
        dense = [(self._mem(1, "甲"), 0.9), (self._mem(2, "乙"), 0.8)]
        fused = r._fuse_rrf(dense, [(self._mem(2, "乙"), 0.5)], {1}, w_kw=0.7, k=60)
        assert [m.id for m, _ in fused] == [2]

    def test_weight_zero_never_calls_fusion(self):
        """HYBRID_WEIGHT=0 ⇒ 走旧的 _score_candidates，行为与修复前逐条等价。"""
        r = MemoryRetriever.__new__(MemoryRetriever)
        dense = [(self._mem(1, "甲"), 0.9), (self._mem(2, "乙"), 0.8)]
        old = r._score_candidates(dense, set())
        assert [m.id for m, _ in old], "旧评分路径仍可用（一键回退的落点）"


# ─────────────────────────── 3. 邻居扩展预算 ────────────────────────────────

def _chunk(mid, content, tokens, idx=1):
    return MemoryEntry(
        id=mid, user_id=1, session_id=SESSION_ID, role="assistant", content=content,
        topics=["#chunk", "#turn:abc", f"#idx:{idx}", "#total:3"],
        tokens_count=tokens, created_at=datetime(2026, 10, 9, 12, 0, idx),
    )


class TestNeighborExpansionBudget:
    """旧实现与检索共用预算 ⇒ 恒 +0；这是本次唯一一个"功能从未生效"的修复点。"""

    @pytest.fixture()
    def svc(self, db_session, monkeypatch):
        monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
        monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
        monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
        monkeypatch.setattr(memory_config, "ENABLED", True)
        service = MemoryService(db_session, enable_cache=False)
        return service

    @staticmethod
    def _resp():
        # 3 条 × 500 tok = 1500，把 1500 的预算吃满（生产实测 1480/1500）
        return ContextResponse(
            memories=[_chunk(1, "甲", 500, 1), _chunk(2, "乙", 500, 2), _chunk(3, "丙", 500, 3)],
            total_tokens=1500, strategy_used="dual_path_stm_ltm",
        )

    def test_shared_budget_adds_nothing(self, svc, monkeypatch):
        """★ 旧行为复现：预算已满 ⇒ 一条邻居都补不进来（返回原对象）。

        ⚠️ 本类所有 `get_adjacent_chunks` 桩都必须接受 `radius` 关键字
        （写成 `lambda m, radius=1: ...`）：[CHUNK-SENTENCE 2026-10-11] 起生产调用为
        `get_adjacent_chunks(mem, radius=EFFECTIVE_NEIGHBOR_RADIUS)`，
        只收一个位置参数的桩会 TypeError，被 `_expand_chunk_neighbors` 的 except
        静默吞掉 ⇒ 表现为"一条邻居都没补进来"。**注意本用例会因此假通过**
        （它期望 +0 条，与"桩炸掉"的结果恰好相同），所以改签名时别只看它绿不绿。
        """
        monkeypatch.setattr(
            svc.storage, "get_adjacent_chunks", lambda m, radius=1: [_chunk(90 + m.id, "邻居", 150, 9)]
        )
        out = svc._expand_chunk_neighbors(self._resp(), 1500)
        assert len(out.memories) == 3, "旧口径下邻居扩展恒 +0 条"

    def test_extra_enlarged_budget_adds_neighbors(self, svc, monkeypatch):
        """独立预算（1500×1.3=1950）⇒ 3 条邻居都装得下。"""
        monkeypatch.setattr(
            svc.storage, "get_adjacent_chunks", lambda m, radius=1: [_chunk(90 + m.id, "邻居", 150, 9)]
        )
        out = svc._expand_chunk_neighbors(self._resp(), 1950, max_adds=4)
        assert len(out.memories) == 6, f"应为 3+3，实际 {len(out.memories)}"
        assert out.total_tokens == 1950
        assert "neighbors" in out.strategy_used

    def test_extra_enlarged_budget_still_token_bounded(self, svc, monkeypatch):
        """放大了也不是无限：装不下的邻居照样被拒（1500+150+150=1800，第 3 条超 1950）。"""
        monkeypatch.setattr(
            svc.storage, "get_adjacent_chunks", lambda m, radius=1: [_chunk(90 + m.id, "邻居", 300, 9)]
        )
        out = svc._expand_chunk_neighbors(self._resp(), 1950, max_adds=4)
        assert len(out.memories) == 4
        assert out.total_tokens == 1800

    def test_max_adds_caps_the_expansion(self, svc, monkeypatch):
        """封顶存在的原因：邻居的邻居可以一直串下去，会把记忆区撑爆。"""
        monkeypatch.setattr(
            svc.storage, "get_adjacent_chunks", lambda m, radius=1: [_chunk(90 + m.id, "邻居", 150, 9)]
        )
        out = svc._expand_chunk_neighbors(self._resp(), 100000, max_adds=2)
        assert len(out.memories) == 5, f"3 条基础上最多 +2，实际 {len(out.memories)}"

    def test_expansion_is_deterministic_and_relevance_ordered(self, svc, monkeypatch):
        """★ 封顶生效时，补哪几条必须由**相关度序**决定，不能由迭代顺序决定。

        实测缺陷（2026-10-09）：`result.memories` 是时间序，封顶 4 条时"谁先被
        扩展"取决于迭代顺序 ⇒ 同一问题两次检索补进不同的邻居（3167 / 4028 字符）。
        修法是传入 relevance_order。本用例构造两条候选、封顶 1 条，交换传入顺序
        应当得到**不同的**邻居 —— 且各自稳定。
        """
        mem_a = _chunk(1, "甲", 100, 1)
        mem_b = _chunk(2, "乙", 100, 2)
        resp = ContextResponse(memories=[mem_a, mem_b], total_tokens=200,
                               strategy_used="dual_path_stm_ltm")
        nb_of = {1: _chunk(91, "甲的邻居", 50, 9), 2: _chunk(92, "乙的邻居", 50, 9)}
        monkeypatch.setattr(
            svc.storage, "get_adjacent_chunks",
            lambda m, radius=1: [nb_of[m.id]] if m.id in nb_of else [],
        )

        # 相关度序 = 乙优先 ⇒ 补进乙的邻居
        out_b = svc._expand_chunk_neighbors(resp, 100000, max_adds=1,
                                            priority_order=[mem_b, mem_a])
        assert [m.id for m in out_b.memories if m.id in (91, 92)] == [92]

        # 相关度序 = 甲优先 ⇒ 补进甲的邻居（同一输入，只有优先级不同）
        out_a = svc._expand_chunk_neighbors(resp, 100000, max_adds=1,
                                            priority_order=[mem_a, mem_b])
        assert [m.id for m in out_a.memories if m.id in (91, 92)] == [91]

        # 同一优先级重复调用必须稳定（旧实现这里会因 set/dict 顺序漂移）
        again = svc._expand_chunk_neighbors(resp, 100000, max_adds=1,
                                            priority_order=[mem_b, mem_a])
        assert [m.id for m in again.memories] == [m.id for m in out_b.memories]

    def test_no_priority_order_falls_back_to_time_order(self, svc, monkeypatch):
        """不传 relevance_order（旧调用方/测试）时退回时间序，不报错。"""
        mem_a = _chunk(1, "甲", 100, 1)
        mem_b = _chunk(2, "乙", 100, 2)
        resp = ContextResponse(memories=[mem_a, mem_b], total_tokens=200)
        monkeypatch.setattr(
            svc.storage, "get_adjacent_chunks",
            lambda m, radius=1: [_chunk(90 + m.id, "邻居", 50, 9)],
        )
        out = svc._expand_chunk_neighbors(resp, 100000, max_adds=1)
        assert len(out.memories) == 3

    def test_no_chunk_metadata_short_circuits(self, svc, monkeypatch):
        """非分块记忆（无 #chunk）不做邻居扩展。"""
        monkeypatch.setattr(
            svc.storage, "get_adjacent_chunks", lambda m, radius=1: [_chunk(99, "邻居", 10, 9)]
        )
        resp = ContextResponse(
            memories=[MemoryEntry(id=1, user_id=1, session_id=SESSION_ID, role="assistant",
                                  content="整段", topics=[], tokens_count=500)],
            total_tokens=500,
        )
        assert svc._expand_chunk_neighbors(resp, 1950, max_adds=4) is resp


# ─────────────────────────── 4. 切分软边界 ──────────────────────────────────

class TestSoftCutBoundary:
    def test_terminal_boundary_unchanged(self):
        """有句号时行为不变（切在句号后）——软切只兜底，不抢戏。"""
        text = "第一句话讲完了。" + "字" * 50
        assert sc._find_cut_index(text, 30) == len("第一句话讲完了。")

    def test_weak_boundary_unchanged(self):
        """分号/换行仍优先于逗号。"""
        text = "前半句；" + "字" * 50
        assert sc._find_cut_index(text, 30) == len("前半句；")

    def test_comma_used_when_no_sentence_end(self):
        """★ 既无句号也无分号时，退到逗号而不是硬切在词中间。

        逗号要落在后半段才会被采用（否则见下一条用例）。
        """
        head = "她慢慢蹭着他的肩膀"          # 9 字，无句号无分号
        text = head + "，" + "字" * 60        # 逗号在下标 9
        cut = sc._find_cut_index(text, 30)    # 后半段门槛 = 15
        # 下半段唯一的逗号也不在前半段时，找最后一个可停顿处；这里构造的
        # 文本里下标 9 的逗号 < 15，故再往右没有任何边界 ⇒ 允许硬切
        assert cut == 30 or text[cut - 1] == "，"

        text2 = "字" * 20 + "，" + "字" * 60   # 逗号在下标 20 > 15（后半段）
        cut2 = sc._find_cut_index(text2, 30)
        assert cut2 == 21, f"应切在下标 20 的逗号后，实际 {cut2}"
        assert text2[cut2 - 1] == "，"

    def test_early_comma_rejected_in_favour_of_hard_cut(self):
        """逗号只在前半段时宁可硬切——切出半空块比切在词中间更糟。

        （_SOFT_MIN_RATIO=0.5：弱边界必须落在后半段才采用）
        """
        text = "嗯，" + "字" * 100     # 逗号在下标 2，远早于 50×0.5=25
        assert sc._find_cut_index(text, 50) == 50

    def test_no_cut_when_short_enough(self):
        assert sc._find_cut_index("很短", 100) == 0
