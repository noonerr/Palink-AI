"""
语义切分器（方案 B，2026-08-22）

将 assistant 长回复按"话题转换断点"切成语义块入库，替代整段单向量。
算法：Kamradt 百分位断点法（LlamaIndex/LangChain/Bedrock 收敛的标准实现）
  1. 句子切分（保留分隔符，join 后可还原原文）
  2. 批量嵌入（embed_fn 接受 List[str]，Ollama /api/embed 单次调用）
  3. 缓冲窗口（默认 ±1 句）合并向量后算相邻余弦距离
  4. 距离 > 第 P 百分位（默认95）处 = 话题转换断点
  5. 尺寸整形：过碎(<MIN)并邻居，超长(>MAX)句边界强制再分

设计约束：
- 纯 numpy 断点计算，无新依赖
- embed_fn 可注入（测试无需真实 Ollama）
- 短文本短路返回单块，零额外成本
"""

import logging
import re
from typing import Callable, List, Optional

import numpy as np

from .config import memory_config

logger = logging.getLogger("MemoryModule")

# 句终止符 + 换行；非贪婪匹配到终止符串或文本结尾
# 使用 finditer 捕获 span，块内 join('') 可精确还原原文片段
_SENTENCE_RE = re.compile(r"[^。！？!?…；;\n]*(?:[。！？!?…；;]+|\n+|$)")

_TERMINAL_BOUNDARY = "。！？!?…"
_WEAK_BOUNDARY = "。！？!?…；;\n"


def split_sentences(text: str) -> List[str]:
    """把文本切成句子单元（保留终止符与换行，''.join 可还原原文）。

    - 过滤空片段
    - 长度 < CHUNK_MIN_SENTENCE_CHARS 的碎句并入下一句（末尾碎句并入前一句）
    - 超长句（> MAX）在句边界强制再分（无边界时硬切）
    """
    if not text:
        return []
    max_chars = memory_config.CHUNK_MAX_CHARS
    min_sent = memory_config.CHUNK_MIN_SENTENCE_CHARS

    pieces = [m.group(0) for m in _SENTENCE_RE.finditer(text)]
    # 保留纯换行片段（保证 join 可还原原文）；仅丢弃真正的空串
    pieces = [p for p in pieces if p != ""]

    # 超长片段强制再分
    bounded: List[str] = []
    for piece in pieces:
        while len(piece) > max_chars:
            cut = _find_cut_index(piece, max_chars)
            if cut <= 0:
                break
            bounded.append(piece[:cut])
            piece = piece[cut:]
        if piece:
            bounded.append(piece)

    # 碎句并入下一句（末尾碎句并入前一句）
    merged: List[str] = []
    pending = ""
    for s in bounded:
        pending += s
        if len(pending.rstrip()) >= min_sent:
            merged.append(pending)
            pending = ""
        # 否则继续累积到下一句
    if pending:
        if merged:
            merged[-1] += pending
        else:
            merged.append(pending)
    return merged


def _find_cut_index(text: str, max_len: int) -> int:
    """在 max_len 内找最靠后的句边界作为切割点；找不到则硬切。

    返回切割下标（>0 才有效；返回 0 表示无法切，调用方应放弃再分）。
    """
    head = text[:max_len]
    for boundary in (_TERMINAL_BOUNDARY, _WEAK_BOUNDARY):
        idx = max(head.rfind(ch) for ch in boundary)
        if idx > 0:
            return idx + 1
    return max_len if len(text) > max_len else 0


def _normalize_rows(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vectors / norms


def _buffer_combined(embeddings: np.ndarray, buffer: int) -> np.ndarray:
    """句 i 的比较向量 = 归一化(emb[i-B : i+B+1] 求和)，消除短句噪声。"""
    n = embeddings.shape[0]
    combined = np.empty_like(embeddings)
    for i in range(n):
        lo = max(0, i - buffer)
        hi = min(n, i + buffer + 1)
        vec = embeddings[lo:hi].sum(axis=0)
        norm = float(np.linalg.norm(vec))
        combined[i] = vec / norm if norm > 0 else vec
    return combined


def _adjacent_distances(combined: np.ndarray) -> np.ndarray:
    """相邻比较向量的余弦距离数组，长度 n-1。"""
    sims = np.sum(combined[:-1] * combined[1:], axis=1)
    return 1.0 - sims


def _detect_breakpoints(dists: np.ndarray, epsilon: float) -> set:
    """局部峰值断点检测（对话题跳变数量不敏感）。

    dists[i] 度量句 i 与句 i+1 的间隙；返回值 b 表示在索引 b 之前切。
    峰值条件：d[i] ≥ 左右邻居（边缘视为 -inf，永不在数组边缘切）
              且 d[i] ≥ max(epsilon, mean(dists))（过滤噪声峰与低于平均的缓坡）。
    """
    n = len(dists)
    if n == 0:
        return set()
    floor = max(float(epsilon), float(np.mean(dists)))
    cuts: set = set()
    for i in range(n):
        left = float(dists[i - 1]) if i > 0 else float("-inf")
        right = float(dists[i + 1]) if i < n - 1 else float("-inf")
        d = float(dists[i])
        if d >= left and d >= right and d >= floor:
            cuts.add(i + 1)
    return cuts


def _group_at_breaks(sentences: List[str], breakpoints: set) -> List[List[str]]:
    """按断点分组。

    断点语义：dist[i] 度量句 i 与句 i+1 的间隙，breakpoint 值 b 表示
    在索引 b **之前**切开（即 b 是新组的首句下标）。
    """
    groups: List[List[str]] = []
    start = 0
    for b in sorted(breakpoints):
        if b <= start:
            continue
        groups.append(sentences[start:b])
        start = b
    if start < len(sentences):
        groups.append(sentences[start:])
    return [
        g for g in groups
        if any(s.strip() for s in g)
    ]


def _shape_sizes(groups: List[List[str]]) -> List[List[str]]:
    """尺寸整形：过碎组并入可行邻居（优先字符更少一侧且合并后不超上限）。"""
    min_chars = memory_config.CHUNK_MIN_CHARS
    max_chars = memory_config.CHUNK_MAX_CHARS

    def group_len(g: List[str]) -> int:
        return sum(len(s) for s in g)

    changed = True
    while changed and len(groups) > 1:
        changed = False
        for gi, group in enumerate(groups):
            if group_len(group) >= min_chars:
                continue
            prev_ok = (
                gi > 0
                and group_len(groups[gi - 1]) + group_len(group) <= max_chars
            )
            next_ok = (
                gi + 1 < len(groups)
                and group_len(groups[gi + 1]) + group_len(group) <= max_chars
            )
            if prev_ok and next_ok:
                target = gi - 1 if group_len(groups[gi - 1]) <= group_len(groups[gi + 1]) else gi + 1
            elif prev_ok:
                target = gi - 1
            elif next_ok:
                target = gi + 1
            else:
                continue
            if target <= gi:
                groups[target].extend(group)
            else:
                groups[target] = group + groups[target]
            del groups[gi]
            changed = True
            break
    return groups


def semantic_split(
    text: str,
    embed_fn: Optional[Callable[[List[str]], "np.ndarray"]] = None,
) -> List[str]:
    """语义切分主入口。

    Args:
        text: 已清洗的 assistant 回复正文
        embed_fn: 批量嵌入函数（List[str] -> ndarray [n, d]）；
                  None 时惰性使用全局 embed_text

    Returns:
        语义块列表（保序，''.join(chunks) ≈ 原文去空白）
    """
    text = (text or "").strip()
    if not text:
        return []
    trigger = memory_config.CHUNK_TRIGGER_CHARS
    if not memory_config.SEMANTIC_CHUNKING or len(text) < trigger:
        return [text]

    sentences = split_sentences(text)
    # 句子太少（统计不可靠）或整体仍不超触发阈值 → 不切
    if len(sentences) < 4 or sum(len(s) for s in sentences) < trigger:
        return [text]

    if embed_fn is None:
        from .embedder import embed_text as embed_fn

    try:
        embeddings = np.array(embed_fn(sentences), dtype=np.float32)
    except Exception as exc:
        logger.warning("semantic_split 嵌入失败，退化为单块: %s", exc)
        return [text]
    if embeddings.ndim != 2 or embeddings.shape[0] != len(sentences):
        logger.warning(
            "semantic_split 嵌入形状异常 (%s)，退化为单块", embeddings.shape
        )
        return [text]

    embeddings = _normalize_rows(embeddings)
    combined = _buffer_combined(embeddings, memory_config.CHUNK_BUFFER_WINDOW)
    dists = _adjacent_distances(combined)

    # 断点检测：局部峰值法（TextTiling 谱系）。
    # 全局阈值（percentile / mean+std）在"多处话题跳变"的短文本上会漏切
    # （跳变越多阈值被抬得越高，只认唯一最强跳变）；局部峰值对跳变数量不敏感。
    # 判定条件（同时满足）：
    #   1. d[i] 是相邻局部最大（≥左右邻居；数组两端视为 -inf，不在边缘切）
    #   2. d[i] >= max(绝对下限, 全体均值)  —— 过滤噪声峰
    breakpoints = _detect_breakpoints(
        dists,
        epsilon=memory_config.CHUNK_DISTANCE_EPSILON,
    )

    groups = _group_at_breaks(sentences, breakpoints)
    groups = _shape_sizes(groups)

    chunks = ["".join(g).strip() for g in groups]
    chunks = [c for c in chunks if c]
    # 最终保险：任何块仍超上限的强制再分（合并阶段理论上不会超，防御性保留）
    final: List[str] = []
    for chunk in chunks:
        while len(chunk) > memory_config.CHUNK_MAX_CHARS:
            cut = _find_cut_index(chunk, memory_config.CHUNK_MAX_CHARS)
            if cut <= 0:
                break
            final.append(chunk[:cut].strip())
            chunk = chunk[cut:]
        if chunk.strip():
            final.append(chunk.strip())
    return final or [text]
