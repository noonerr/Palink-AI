"""[CHUNK-STRUCT] 记忆切分默认改为"结构边界切分"的回归测试（2026-10-07）。

为什么换：跨 3 个真实会话、18 条真实长回复实测（ground truth 唯一性校验）——

| 方案 | 每条回复耗时 | 真实回指查询 top1 | top3 |
|---|---|---|---|
| 旧（每句嵌入找断点 + 块再嵌入） | 3822 ms | 33% (7/21) | 57% |
| 新（结构边界切，只嵌块一次）     | 1631 ms | 43% (9/21) | 81% |

旧方案唯一占优的口径是"查询=块内某句的片段"，那个口径贴近不了生产（生产查询是
用户那句平均 29 字的话），所以不作为判据。详见今日报告。

本文件锁三件事：默认策略、**结构路径零嵌入调用**、切出的块不丢内容不超长；
并保留语义路径可用（它是 config 里那台一键回退开关）。
"""

import os
import sys

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.memory_module import semantic_chunker as SC  # noqa: E402
from app.memory_module.config import memory_config  # noqa: E402


def _para(seed: str, n: int) -> str:
    """造一段中文剧情文本（句子长短不一，贴近真实回复）。"""
    return "".join(
        f"{seed}的第{i}件事发生了，她当时并没有说话，只是看着窗外很久。" for i in range(n)
    )


LONG_TEXT = "\n\n".join([_para("窗边", 6), _para("医院", 7), _para("夜里", 5)])


class TestStrategyDefault:
    def test_default_is_structural(self):
        assert memory_config.CHUNK_STRATEGY == "structural", (
            "默认策略必须是 structural —— 它同时是更便宜(−57%)与更准(43% vs 33%)那条"
        )

    def test_target_bounds_derive_from_config(self):
        assert memory_config.CHUNK_TARGET_CHARS == 250


class TestStructuralSplit:
    def test_never_calls_embedder(self, monkeypatch):
        """★ 结构路径必须零嵌入调用（这是省掉那 2.2s/轮的全部内容）。"""
        def _boom(_):
            raise AssertionError("structural 路径不该调嵌入器")

        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "structural")
        chunks = SC.semantic_split(LONG_TEXT, embed_fn=_boom)
        assert len(chunks) > 1

    def test_blocks_within_bounds(self):
        hi = int(memory_config.CHUNK_TARGET_CHARS * 1.35)
        chunks = SC.structural_split(LONG_TEXT)
        assert all(len(c) <= hi for c in chunks), [len(c) for c in chunks]

    def test_no_content_lost(self):
        """切分只重排空白，正文一个字都不能丢（记忆=消息镜像的不变式）。"""
        chunks = SC.structural_split(LONG_TEXT)
        joined = "".join(chunks)
        for i in range(0, len(LONG_TEXT) - 20, 37):
            frag = LONG_TEXT[i:i + 20]
            if frag.strip() and "\n" not in frag:
                assert frag in joined, f"片段丢失：{frag!r}"

    def test_paragraph_boundary_is_used(self):
        """空行分段必须真的成为切点，而不是又按长度平均切。"""
        a, b = _para("第一段", 8), _para("第二段", 8)
        chunks = SC.structural_split(a + "\n\n" + b)
        assert any(c.startswith("第一段") for c in chunks)
        assert any(c.startswith("第二段") for c in chunks)
        assert not any(("第一段" in c and "第二段" in c) for c in chunks), (
            f"两段被并进了同一块：{[c[:20] for c in chunks]}"
        )

    def test_short_text_short_circuits(self):
        assert SC.semantic_split("太短了不切。") == ["太短了不切。"]

    def test_dialogy_turns_split(self):
        """对话/括号动作起句是次级边界（总量要超过块上限才会真的用上）。"""
        body = "他说完就走了。".join(
            [f'“台词{i}内容很长很长很长很长。”\n' for i in range(30)]
        )
        assert len(body) > int(memory_config.CHUNK_TARGET_CHARS * 1.35)
        chunks = SC.structural_split(body)
        assert len(chunks) >= 2


class TestSemanticRollback:
    """语义路径保留可用 —— 它是 MEMORY_CHUNK_STRATEGY=semantic 那台回退开关。"""

    def test_semantic_strategy_still_runs(self, monkeypatch):
        import numpy as np

        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "semantic")
        calls = []

        def fake_embed(sentences):
            calls.append(len(sentences))
            rng = np.arange(len(sentences), dtype=np.float32)
            base = np.tile(np.eye(4, dtype=np.float32)[[0, 1, 2, 3] * ((len(sentences) // 4) + 1)][:len(sentences)], (1, 1))
            return base

        chunks = SC.semantic_split(LONG_TEXT, embed_fn=fake_embed)
        assert chunks and calls, "语义路径必须真调了嵌入才叫回退可用"
        assert all(len(c) <= memory_config.CHUNK_MAX_CHARS * 2 for c in chunks)

    def test_structural_and_semantic_produce_comparable_sizes(self, monkeypatch):
        """两种策略块数量级要可比，否则"回退"不是等价开关而是换行为。"""
        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "structural")
        n_struct = len(SC.semantic_split(LONG_TEXT))
        monkeypatch.setattr(memory_config, "CHUNK_STRATEGY", "semantic")
        import numpy as np

        def fake_embed(sentences):
            idx = np.arange(len(sentences)) % 4
            return np.eye(4, dtype=np.float32)[idx]

        n_sem = len(SC.semantic_split(LONG_TEXT, embed_fn=fake_embed))
        assert n_struct > 1 and n_sem > 1
        assert 0.4 <= n_struct / max(n_sem, 1) <= 2.5, (n_struct, n_sem)
