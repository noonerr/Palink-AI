"""语义切分器单测（纯函数，mock embed_fn，无需真实 Ollama）。

覆盖：短路触发、句子切分还原性、话题断点、自适应百分位、
尺寸整形（碎块合并/超长强切）、批量嵌入调用次数、嵌入失败退化。
"""

import os
import sys

import numpy as np
import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.memory_module import semantic_chunker as sc
    from app.memory_module.config import memory_config
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


def _sent(i: int, topic_mark: str = "") -> str:
    """造一句 ~60 字的中文句子（保证超过碎句阈值）。"""
    body = (
        f"这是第{i}句话，讲述了一段情节发展的细节内容，"
        "包含足够的字符长度来通过碎句阈值的检查判断逻辑。"
    )
    return body + topic_mark


@pytest.fixture
def fast_config(monkeypatch):
    """放宽长度参数便于用短句构造测试场景。"""
    monkeypatch.setattr(memory_config, "CHUNK_TRIGGER_CHARS", 100)
    monkeypatch.setattr(memory_config, "CHUNK_MIN_CHARS", 30)
    monkeypatch.setattr(memory_config, "CHUNK_MAX_CHARS", 400)
    monkeypatch.setattr(memory_config, "CHUNK_MIN_SENTENCE_CHARS", 10)
    monkeypatch.setattr(memory_config, "SEMANTIC_CHUNKING", True)
    monkeypatch.setattr(memory_config, "CHUNK_BUFFER_WINDOW", 1)
    monkeypatch.setattr(memory_config, "CHUNK_DISTANCE_EPSILON", 0.12)


def _two_topic_vectors(n_a: int, n_b: int, dim: int = 64):
    """前 n_a 句返回向量 a，后 n_b 句返回正交向量 b。"""
    rng = np.random.default_rng(42)
    va = rng.normal(size=dim)
    vb = rng.normal(size=dim)
    va /= np.linalg.norm(va)
    vb /= np.linalg.norm(vb)

    def embed(sentences):
        out = []
        for idx in range(len(sentences)):
            out.append(va if idx < n_a else vb)
        # 断言恰好调用一次由测试内的计数器另行包装
        return np.array(out, dtype=np.float32)

    return embed


def test_short_text_short_circuit(fast_config):
    calls = []

    def embed(s):
        calls.append(1)
        return np.zeros((len(s), 8))

    text = "短文本，不触发切分。" * 3
    assert len(text) < memory_config.CHUNK_TRIGGER_CHARS
    chunks = sc.semantic_split(text, embed_fn=embed)
    assert chunks == [text]
    assert not calls  # 短路：不应发生任何嵌入调用


def test_switch_off_returns_single(fast_config, monkeypatch):
    monkeypatch.setattr(memory_config, "SEMANTIC_CHUNKING", False)
    text = _sent(1) * 10
    chunks = sc.semantic_split(text, embed_fn=lambda s: np.zeros((len(s), 8)))
    assert chunks == [text]


def test_sentence_split_join_reconstructs_original(fast_config, monkeypatch):
    monkeypatch.setattr(memory_config, "CHUNK_MIN_SENTENCE_CHARS", 2)
    text = "第一句在这里。第二句！第三句呢？\n换行后的第四句；第五句…"
    sentences = sc.split_sentences(text)
    assert "".join(sentences) == text
    assert len(sentences) >= 5


def test_tiny_sentences_merged_forward():
    text = "嗯。好的。这是一句足够长的正常句子，包含了很多有效信息与内容。"
    sentences = sc.split_sentences(text)
    # "嗯。""好的。" 是碎句，应并入后续长句而非独立存在
    assert any(s.startswith("嗯。") and len(s) > 10 for s in sentences)
    assert "".join(sentences) == text


def test_breakpoint_exactly_at_topic_boundary(fast_config):
    sentences = [_sent(i) for i in range(3)] + [_sent(i, "(B)") for i in range(3, 6)]
    text = "".join(sentences)
    embed = _two_topic_vectors(3, 3)

    counter = {"n": 0}

    def counting_embed(s):
        counter["n"] += 1
        return embed(s)

    chunks = sc.semantic_split(text, embed_fn=counting_embed)
    # 批量嵌入恰被调用 1 次
    assert counter["n"] == 1
    # 在话题边界切成 2 块
    assert len(chunks) == 2
    assert chunks[0] == "".join(sentences[:3]).strip()
    assert chunks[1] == "".join(sentences[3:]).strip()
    # 每块内部只含单一话题标记
    assert all("(B)" not in c for c in chunks[:1])
    assert all("(B)" in c for c in chunks[1:])


def test_uniform_similarity_no_oversplit(fast_config):
    """全部同话题（距离全 0）：不应产生断点。"""
    sentences = [_sent(i) for i in range(6)]
    text = "".join(sentences)
    vec = np.array([[1.0, 0.0]] * len(sentences), dtype=np.float32)
    chunks = sc.semantic_split(text, embed_fn=lambda s: vec.copy())
    assert len(chunks) == 1


def test_oversized_chunk_force_split(fast_config, monkeypatch):
    monkeypatch.setattr(memory_config, "CHUNK_MAX_CHARS", 80)
    # 无任何标点的超长文本：只能硬切，但每块 ≤ MAX
    text = "这是一个没有任何终止标点符号的超长文本" * 30
    chunks = sc.semantic_split(
        text,
        embed_fn=lambda s: np.eye(len(s), dtype=np.float32)[:, :8]
        if len(s) <= 8
        else np.ones((len(s), 8), dtype=np.float32),
    )
    assert len(chunks) >= 2
    assert all(len(c) <= memory_config.CHUNK_MAX_CHARS for c in chunks)


def test_embed_failure_degrades_to_single_chunk(fast_config):
    text = "".join(_sent(i) for i in range(6))

    def broken_embed(_s):
        raise RuntimeError("ollama down")

    chunks = sc.semantic_split(text, embed_fn=broken_embed)
    assert chunks == [text]


def test_content_coverage_after_chunking(fast_config):
    sentences = [_sent(i) for i in range(3)] + [_sent(i, "(B)") for i in range(3, 6)]
    text = "".join(sentences)
    chunks = sc.semantic_split(text, embed_fn=_two_topic_vectors(3, 3))
    # 切分不丢内容：所有块的拼接 == 原文去首尾空白
    assert "".join(c.strip() for c in chunks) == text.strip()
