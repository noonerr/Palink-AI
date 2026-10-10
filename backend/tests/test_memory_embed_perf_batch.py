"""[PERF-EMB-NONBLOCK] + [EMB-DEDUP] 向量 A 批（2026-10-09）回归测试。

这批只做一件事：**在不改变检索语义的前提下砍掉嵌入的浪费**，所以测试也只钉两件事：

1. **A1 事件循环不再被嵌入卡住**
   实测单次嵌入约 160ms 是固定开销（1 个字 163ms / 21 字 194ms），一条长回复切 4 块
   批量嵌约 1 秒。原先这 1 秒是在 `async def event_generator()` 里**同步**跑的，
   后果不是"这条连接慢"，是**整个 worker 的事件循环停 1 秒**，同 worker 上其他用户的
   流一起卡。改法是挪进 `asyncio.to_thread`。
   这里用 AST 把规则钉死，而不是断言某一行代码形状 —— 形状守卫在本项目已经翻过车
   （`test_memory_scope_guard.py` 的两条源码形状守卫就是因此改成行为断言的）。
   规则：**流式入口里出现的 `store_memory(...)`，必须位于某个被 `asyncio.to_thread`
   调用的局部函数体内**。将来谁再加一处内联写入，测试会红。

2. **A2 同文本去重**
   `POST /api/st/vectors` 的 query-multi 对 N 个集合各嵌一次**同一个 searchText**；
   swipe/regenerate 的 [MEM-UPSERT] 正文没变也重嵌一遍。去重只认「完全相同的字符串」，
   ⇒ 同输入必同输出，不改任何检索语义与阈值口径。
   ⚠️ 缓存键必须含 provider 身份与**维度**：OllamaEmbedder 降级到 fastembed 时维度
   1024→512，两套向量互不兼容（历史上出过「存得进召不回」的死向量）。

⚠️ 本文件**不依赖 ollama 容器**（全部用桩嵌入器计数），故在无 GPU/无模型的 CI 上也能跑。
"""

import ast
import os
import sys
import time

import numpy as np
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.memory_module import embedder as emb_mod  # noqa: E402
from app.memory_module.embedder import (  # noqa: E402
    EmbedderFactory,
    embed_text,
    reset_embed_dedup_cache,
)


class _StubEmbedder(emb_mod.BaseEmbedder):
    """计数桩：记录每次到底层真正发生了几个**唯一**文本。"""

    def __init__(self, dimension: int = 8, name: str = "stub-model"):
        self._dimension = dimension
        self._model = name
        self.calls = 0
        self.embedded_texts: list = []

    def embed(self, text):
        self.calls += 1
        items = [text] if isinstance(text, str) else list(text)
        self.embedded_texts.extend(items)
        # 与真实 provider 一致：str 也归一成 [str]，产出恒为 (n, dim)
        return np.array(
            [[float(len(t) + i)] * self._dimension for i, t in enumerate(items)],
            dtype=np.float32,
        )

    @property
    def dimension(self) -> int:
        return self._dimension


@pytest.fixture()
def stub():
    """把桩嵌入器装进单例，用例结束还原（含缓存）。"""
    prev = EmbedderFactory._instance
    s = _StubEmbedder()
    EmbedderFactory._instance = s
    reset_embed_dedup_cache()
    yield s
    EmbedderFactory._instance = prev
    reset_embed_dedup_cache()


# ── A2：同文本去重 ──────────────────────────────────────────────────────────

class TestEmbedDedup:
    def test_dedup_survives_a_full_turn_gap(self, stub, monkeypatch):
        """去重必须跨得过「一轮生成的时长」——这是本批真正的收益点。

        第一次嵌在装配提示词时（生成前），第二次在把这句话写进记忆时（生成后）。
        生产库实测该间隔 中位 3.6s / p95 20.7s（n=98），原 TTL=20s 恰好卡在 p95 上。
        本例把缓存条目伪造成 60 秒前写入，仍必须命中。
        """
        embed_text("这句要跨一轮生成")
        assert stub.calls == 1
        key = emb_mod._embed_dedup_key(stub, "这句要跨一轮生成")
        vec, _ = emb_mod._embed_dedup_cache[key]
        emb_mod._embed_dedup_cache[key] = (vec, time.monotonic() - 60.0)
        embed_text("这句要跨一轮生成")
        assert stub.calls == 1, "TTL 必须覆盖一轮生成时长（实测 p95 20.7s，取 120s）"
        # 再拨到 TTL 之外，必须失效（防止变成永不过期的脏缓存）
        emb_mod._embed_dedup_cache[key] = (
            vec, time.monotonic() - emb_mod._EMBED_DEDUP_TTL_SECONDS - 1
        )
        embed_text("这句要跨一轮生成")
        assert stub.calls == 2, "超过 TTL 必须重新嵌入，不得无限期复用"

    def test_same_text_twice_only_embeds_once(self, stub):
        first = embed_text("露缇雅昨天答应的那件事后来怎么样了")
        second = embed_text("露缇雅昨天答应的那件事后来怎么样了")
        assert stub.calls == 1, f"同文本二次调用应命中去重，实际下沉 {stub.calls} 次"
        np.testing.assert_allclose(first, second)

    def test_batch_only_embeds_unique_members(self, stub):
        out = embed_text(["甲", "乙", "甲", "乙", "甲"])
        assert stub.calls == 1
        assert set(stub.embedded_texts) == {"甲", "乙"}, "只该把未命中的唯一文本交给底层（批内重复也只嵌一次）"
        assert len(stub.embedded_texts) == 2
        assert out.shape == (5, 8), "返回必须按输入顺序还原成 (n, dim)，条数不能少"
        np.testing.assert_allclose(out[0], out[2])
        np.testing.assert_allclose(out[1], out[3])

    def test_str_input_still_returns_2d(self, stub):
        # 各 provider 都把 str 归一成 [str] ⇒ 产出 (1, dim)。调用方大量依赖
        # `embedding.tolist()[0] if len(shape) > 1`，形状契约不能改。
        assert embed_text("一句话").shape == (1, 8)

    def test_cached_array_is_a_copy(self, stub):
        got = embed_text("可变的")
        got[0][0] = 999.0
        again = embed_text("可变的")
        assert again[0][0] != 999.0, "返回副本，调用方就地改写不得污染缓存"

    def test_dimension_change_does_not_reuse_cache(self, stub):
        """降级路径（Ollama 1024 → fastembed 512）不得冒用另一套维度的向量。"""
        embed_text("同一句")
        EmbedderFactory._instance = _StubEmbedder(dimension=4, name="stub-model")
        embed_text("同一句")
        assert stub.calls == 1
        assert EmbedderFactory._instance.embedded_texts == ["同一句"], "维度不同 ⇒ 键不同 ⇒ 重新嵌"

    def test_provider_identity_separates_keys(self, stub):
        embed_text("同一句")
        other = _StubEmbedder(dimension=8, name="another-model")
        EmbedderFactory._instance = other
        embed_text("同一句")
        assert other.calls == 1, "换模型（维度相同）不得复用上一个模型的向量"

    def test_reset_clears_cache(self, stub):
        embed_text("清一下")
        embed_text("清一下")
        assert stub.calls == 1, "前置条件：不 reset 时第二次应命中缓存"
        EmbedderFactory.reset()
        EmbedderFactory._instance = stub
        embed_text("清一下")
        assert stub.calls == 2, "EmbedderFactory.reset() 必须清空去重缓存"

    def test_ttl_zero_is_passthrough(self, stub, monkeypatch):
        monkeypatch.setattr(emb_mod, "_EMBED_DEDUP_TTL_SECONDS", 0.0)
        embed_text("关缓存")
        embed_text("关缓存")
        assert stub.calls == 2, "TTL<=0 时行为退回改造前：完全不拦"

    def test_short_result_from_underlying_refalls_whole_batch(self, stub):
        """底层返回条数少于请求条数 ⇒ 不做无根据的对位猜测，退回改造前语义整批重发。"""
        seen: list = []

        def _lie(text):
            items = [text] if isinstance(text, str) else list(text)
            seen.append(list(items))
            return np.zeros((max(len(items) - 1, 1), 8), dtype=np.float32)

        stub.embed = _lie  # type: ignore[assignment]
        embed_text(["全新甲", "全新乙"])
        assert seen[0] == ["全新甲", "全新乙"], "首轮按唯一文本下发"
        assert seen[-1] == ["全新甲", "全新乙"], "对位不可靠时必须退回整批原样下发（含顺序）"
        assert len(seen) == 2, "回退只补发一次，不得反复重试"


# ── A1：嵌入不得占着事件循环跑 ──────────────────────────────────────────────

def _threaded_helper_names(fn) -> set:
    """某函数体里被 `asyncio.to_thread(<局部函数>)` 调走的函数名集合。"""
    names = set()
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        is_to_thread = (
            isinstance(f, ast.Attribute) and f.attr == "to_thread"
            and isinstance(f.value, ast.Name) and f.value.id == "asyncio"
        )
        if is_to_thread and node.args and isinstance(node.args[0], ast.Name):
            names.add(node.args[0].id)
    return names


def find_offenders(src: str, filename: str) -> list:
    """返回「在 async 函数里内联调用 store_memory」的位置（这类写法会卡事件循环）。

    判定规则：`store_memory(...)` 最近的 enclosing 函数若是 `async def`，
    则该调用必须位于**被 `asyncio.to_thread` 调走的局部函数**体内。
    """
    tree = ast.parse(src)
    parent: dict = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parent[child] = node

    threaded_by_fn = {
        id(fn): _threaded_helper_names(fn)
        for fn in ast.walk(tree)
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    offenders = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "store_memory"):
            continue
        cur = node
        while cur is not None and not isinstance(
            cur, (ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            cur = parent.get(cur)
        if cur is None:
            offenders.append(f"{filename}:? 模块级调用 store_memory")
            continue
        if not isinstance(cur, ast.AsyncFunctionDef):
            continue  # 同步函数里没有"事件循环"可阻塞
        if cur.name not in threaded_by_fn.get(id(cur), set()):
            offenders.append(
                f"{filename}:{getattr(cur, 'lineno', '?')} {cur.name}() 内联调用 "
                "store_memory（内含同步嵌入）"
            )
    return offenders


class TestEmbeddingOffEventLoop:
    """钉住：流式入口的记忆写入都在线程里执行。

    ⚠️ 范围刻意只含本批改过的两个文件。`api/websocket.py` 另有 4 处 store_memory，
    该文件当日在并行会话手上（工作区 +未提交改动），本批不动它，故不纳入断言，
    已记入 BACKUP_INFO 待办。
    """

    TARGETS = [
        os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py"),
        os.path.join(_BACKEND_DIR, "app", "api", "chat.py"),
    ]

    @pytest.mark.parametrize("path", TARGETS)
    def test_no_store_memory_runs_directly_in_async_generator(self, path):
        offenders = find_offenders(
            open(path, encoding="utf-8").read(), os.path.basename(path)
        )
        assert not offenders, (
            "记忆写入会把事件循环卡住约 1 秒，必须挪进 asyncio.to_thread：\n"
            + "\n".join(offenders)
        )

    def test_guard_actually_detects_inline_call(self):
        """反证守卫：内联写法必须被判红，线程写法必须放行 —— 否则上面那条是死代码。"""
        bad = (
            "async def event_generator():\n"
            "    svc = MemoryService(db)\n"
            "    svc.store_memory(1, 's', 'assistant', 'x')\n"
        )
        good = (
            "import asyncio\n"
            "async def event_generator():\n"
            "    def _write_turn_memory():\n"
            "        svc.store_memory(1, 's', 'assistant', 'x')\n"
            "    await asyncio.to_thread(_write_turn_memory)\n"
        )
        assert find_offenders(bad, "bad.py"), "内联写法必须被这条规则抓到"
        assert not find_offenders(good, "good.py"), "已挪进线程的写法必须放行"

    def test_sse_paths_actually_await_to_thread(self):
        """字面量复核（不被压缩/改名影响的最小证据）。"""
        path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        src = open(path, encoding="utf-8").read()
        assert "await asyncio.to_thread(_write_turn_memory)" in src
        assert "await asyncio.to_thread(_write_action_memory)" in src
        chat_src = open(os.path.join(_BACKEND_DIR, "app", "api", "chat.py"), encoding="utf-8").read()
        assert "await asyncio.to_thread(_write_turn_memory)" in chat_src
