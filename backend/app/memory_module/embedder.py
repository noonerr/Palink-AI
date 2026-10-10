"""
嵌入模型封装
支持多种后端：SimpleHash(默认) / FastEmbed(轻量级ONNX) / OpenAI
纯CPU优化，无CUDA依赖
"""

import numpy as np
from typing import Union, List, Optional
from collections import OrderedDict
from abc import ABC, abstractmethod
import logging
import os
import time
import hashlib
import threading

from .config import memory_config

logger = logging.getLogger("MemoryModule")


def _stable_bucket_index(value: str, modulo: int) -> int:
    """Generate a stable bucket index without using weak MD5."""
    digest = hashlib.blake2b(value.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") % modulo


class BaseEmbedder(ABC):
    """嵌入模型基类"""
    
    @abstractmethod
    def embed(self, text: Union[str, List[str]]) -> np.ndarray:
        """将文本转换为向量"""
        pass
    
    @property
    @abstractmethod
    def dimension(self) -> int:
        """向量维度"""
        pass


class SimpleHashEmbedder(BaseEmbedder):
    """
    简单的哈希嵌入器 - 无需外部模型
    基于文本特征的确定性哈希，适合测试和离线环境
    """
    
    def __init__(self, dimension: int = 384):
        self._dimension = dimension
        logger.info(f"使用简单哈希嵌入器，维度: {dimension}")
    
    def embed(self, text: Union[str, List[str]]) -> np.ndarray:
        """
        基于文本特征的简单嵌入
        使用多个哈希函数生成确定性向量
        """
        if isinstance(text, str):
            text = [text]
        
        embeddings = []
        for t in text:
            features = self._extract_features(t)
            embeddings.append(features)
        
        return np.array(embeddings, dtype=np.float32)
    
    def _extract_features(self, text: str) -> np.ndarray:
        """提取文本特征生成向量"""
        text = text.lower().strip()
        
        vec = np.zeros(self._dimension, dtype=np.float32)
        bucket_size = max(self._dimension // 3, 1)
        
        if not text:
            return vec
        
        for i in range(len(text) - 2):
            ngram = text[i:i+3]
            idx = _stable_bucket_index(ngram, bucket_size)
            vec[idx] += 1.0
        
        words = text.split()
        for word in words:
            idx = _stable_bucket_index(word, bucket_size)
            vec[idx + bucket_size] += 1.0
            
            length_idx = min(len(word), 20)
            vec[bucket_size * 2 + length_idx] += 0.5
        
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        
        return vec
    
    @property
    def dimension(self) -> int:
        return self._dimension


class FastEmbedEmbedder(BaseEmbedder):
    """
    FastEmbed 轻量级嵌入模型
    基于 ONNX Runtime，纯CPU，无PyTorch依赖
    """
    
    def __init__(self):
        try:
            from fastembed import TextEmbedding
            
            model_name = "BAAI/bge-small-zh-v1.5"
            
            cache_dir = "/app/models/fastembed"
            os.makedirs(cache_dir, exist_ok=True)
            
            self.model = TextEmbedding(
                model_name=model_name,
                cache_dir=cache_dir
            )
            self._dimension = 512
            
            logger.info(f"FastEmbed 模型加载成功: {model_name}, 维度: {self._dimension}")
            
        except Exception as e:
            logger.warning(f"加载 FastEmbed 模型失败: {e}，使用简单哈希嵌入器")
            raise
    
    def embed(self, text: Union[str, List[str]]) -> np.ndarray:
        if isinstance(text, str):
            text = [text]
        
        embeddings = list(self.model.embed(text))
        return np.array(embeddings)
    
    @property
    def dimension(self) -> int:
        return self._dimension


class SentenceTransformerEmbedder(BaseEmbedder):
    """
    SentenceTransformer 嵌入模型
    使用sentence-transformers加载 BAAI/bge-m3（1024维，中文强，与另一项目统一语义基准）
    注：本环境无法安装 Ollama（GitHub 被封锁、docker.io 不可达），故改用 SentenceTransformer
    直接加载 bge-m3，产出与 Ollama+bge-m3 同维度(1024)的向量。模型经 HF_ENDPOINT 镜像拉取。
    """

    def __init__(self):
        try:
            from sentence_transformers import SentenceTransformer

            model_name = "BAAI/bge-m3"
            
            cache_dir = "/app/models/sentence_transformers"
            os.makedirs(cache_dir, exist_ok=True)
            
            old_hf_endpoint = os.environ.get("HF_ENDPOINT")
            os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
            try:
                self.model = SentenceTransformer(
                    model_name,
                    cache_folder=cache_dir
                )
            finally:
                if old_hf_endpoint is not None:
                    os.environ["HF_ENDPOINT"] = old_hf_endpoint
                else:
                    os.environ.pop("HF_ENDPOINT", None)
            self._dimension = 1024
            
            logger.info(f"SentenceTransformer 模型加载成功: {model_name}, 维度: {self._dimension}")
            
        except Exception as e:
            logger.warning(f"加载 SentenceTransformer 模型失败: {e}，使用简单哈希嵌入器")
            raise
    
    def embed(self, text: Union[str, List[str]]) -> np.ndarray:
        if isinstance(text, str):
            text = [text]
        
        embeddings = self.model.encode(text, normalize_embeddings=True)
        return np.array(embeddings)
    
    @property
    def dimension(self) -> int:
        return self._dimension


class OpenAIEmbedder(BaseEmbedder):
    """OpenAI API 嵌入"""
    
    def __init__(self):
        try:
            import openai
            self.client = openai.OpenAI()
            self._dimension = 1536
            logger.info("OpenAI 嵌入模型初始化成功")
        except ImportError:
            logger.error("openai 未安装")
            raise
    
    def embed(self, text: Union[str, List[str]]) -> np.ndarray:
        if isinstance(text, str):
            text = [text]
        
        response = self.client.embeddings.create(
            model=memory_config.OPENAI_MODEL,
            input=text
        )
        
        embeddings = [item.embedding for item in response.data]
        return np.array(embeddings)
    
    @property
    def dimension(self) -> int:
        return self._dimension


class OllamaEmbedder(BaseEmbedder):
    """
    Ollama 嵌入模型（与另一个项目统一向量引擎，2026-08-18）

    通过 Ollama 的 /api/embed 接口调用 bge-m3（1024 维，中文强）。
    复用已有 httpx 依赖，无新增第三方库。

    运行时降级：Ollama 不可达/报错时自动回退 fastembed（bge-small-zh），
    保证记忆功能不因 Ollama 故障而崩溃（语义基准暂时不一致，但可用）。
    """

    def __init__(self):
        import httpx
        self._client = httpx.Client(timeout=memory_config.OLLAMA_TIMEOUT)
        self._host = memory_config.OLLAMA_HOST.rstrip("/")
        self._model = memory_config.OLLAMA_MODEL
        self._dimension = 1024  # bge-m3 固定 1024 维
        self._fallback = None  # 惰性创建 fastembed 兜底
        # 降级生效后实际产出的维度（与 self._dimension 不同），供写入侧校验
        self._degraded_dim: Optional[int] = None
        logger.info(f"Ollama 嵌入器初始化: host={self._host} model={self._model} 维度: {self._dimension}")

    def _get_fallback(self) -> BaseEmbedder:
        if self._fallback is None:
            try:
                self._fallback = FastEmbedEmbedder()
            except Exception as e:
                logger.warning(f"Ollama 降级 fastembed 创建失败: {e}")
                self._fallback = SimpleHashEmbedder()
            # [DIM-CONTRACT] 降级后真实维度与 bge-m3 的 1024 不同（fastembed=512 /
            # SimpleHash=384）。必须同步暴露，否则调用方按 1024 校验会把坏向量
            # 当正常数据写入；历史上因此产出"存得进召不回"的死向量。
            self._degraded_dim = self._fallback.dimension
            logger.warning(
                "Ollama 嵌入已降级为 %s，实际维度 %d（bge-m3 为 %d）；"
                "降级期写入的向量与 Ollama 期不兼容，按宁缺勿错原则不再写入。",
                type(self._fallback).__name__, self._degraded_dim, self._dimension,
            )
        return self._fallback

    def embed(self, text: Union[str, List[str]]) -> np.ndarray:
        if isinstance(text, str):
            text = [text]
        if not text:
            return np.zeros((0, self._dimension), dtype=np.float32)
        try:
            resp = self._client.post(
                f"{self._host}/api/embed",
                json={"model": self._model, "input": text},
            )
            resp.raise_for_status()
            data = resp.json()
            embeddings = data.get("embeddings") or []
            if not embeddings:
                raise ValueError("Ollama 返回空 embeddings")
            out = np.array(embeddings, dtype=np.float32)
            # Ollama 恢复后抹掉降级标记，维度回归 bge-m3
            if self._degraded_dim is not None:
                self._degraded_dim = None
                logger.info("Ollama 嵌入恢复，维度回到 %d", self._dimension)
            self._dimension = int(out.shape[-1]) if out.ndim > 1 else self._dimension
            return out
        except Exception as e:
            logger.warning(f"Ollama 嵌入失败，降级 fastembed: {e}")
            return self._get_fallback().embed(text)

    @property
    def dimension(self) -> int:
        return self._degraded_dim if self._degraded_dim is not None else self._dimension


class EmbedderFactory:
    """嵌入模型工厂 - 优先级: Ollama > SimpleHash > SentenceTransformer > FastEmbed > OpenAI"""
    
    _instance: BaseEmbedder = None
    _lock = threading.Lock()
    
    @classmethod
    def get_embedder(cls) -> BaseEmbedder:
        """获取或创建嵌入器实例（单例模式）"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls._create_embedder()
        return cls._instance
    
    @classmethod
    def _create_embedder(cls) -> BaseEmbedder:
        """创建嵌入器 - 优先使用 Ollama（统一向量引擎），失败降级 fastembed，最后简单哈希"""
        
        if memory_config.EMBEDDING_PROVIDER == "ollama":
            try:
                return OllamaEmbedder()
            except Exception as e:
                logger.warning(f"Ollama 嵌入器创建失败: {e}，降级 fastembed")
        
        if memory_config.EMBEDDING_PROVIDER == "openai":
            if memory_config.validate():
                try:
                    return OpenAIEmbedder()
                except Exception as e:
                    logger.warning(f"OpenAI 嵌入器创建失败: {e}")
            else:
                logger.warning("OpenAI API Key 未配置")
        
        if memory_config.EMBEDDING_PROVIDER == "sentencetransformer":
            try:
                return SentenceTransformerEmbedder()
            except Exception as e:
                logger.warning(f"SentenceTransformer 创建失败: {e}")
        
        if memory_config.EMBEDDING_PROVIDER == "fastembed":
            try:
                return FastEmbedEmbedder()
            except Exception as e:
                logger.warning(f"FastEmbed 创建失败: {e}")
        
        logger.info("使用简单哈希嵌入器（无需外部模型）")
        return SimpleHashEmbedder()
    
    @classmethod
    def reset(cls):
        """重置嵌入器（用于测试）"""
        cls._instance = None
        # [EMB-DEDUP] 换嵌入器必须连去重缓存一起换，
        # 否则上一个用例（或上一个 provider）的向量会喂给下一个用例。
        reset_embed_dedup_cache()


def get_embedder() -> BaseEmbedder:
    """获取全局嵌入器实例"""
    return EmbedderFactory.get_embedder()


# ── [EMB-DEDUP] 同文本嵌入去重（2026-10-09 向量 A 批）──────────────────────
# 为什么要去重：实测单次嵌入代价里 **约 160ms 是固定开销**——嵌 1 个字 163ms、
# 嵌 21 个字 194ms（对照容器内 HTTP 往返仅 0.9ms，说明这 160ms 全花在模型自己身上）。
# 于是「同一个文本被嵌第二遍」就是白付一整份固定开销。生产里真实存在的重复：
#   · `POST /api/st/vectors` 的 query-multi：N 个集合各嵌一次**同一个 searchText**
#     （api/silly_tavern.py 里是循环调用），N 个集合 = N 份固定开销；
#   · swipe / regenerate 的 [MEM-UPSERT] 先删后写：正文未变时把原句再嵌一遍；
#   · 检索/写入失败重试路径（storage._async_update_embedding 最多 3 次）。
# 只认「完全相同的字符串」⇒ 同输入必同输出（各 provider 的 embed 内部都把 str 归一成
# [str]，产出恒为 (n, dim)），**不改任何检索语义与阈值口径**。
# TTL 刻意很短：跨模型/跨降级态的陈旧向量风险远大于收益，且嵌入本身是可重算的。
# TTL 取 120 秒的依据（2026-10-10 生产库实测，n=98 轮）：同一会话里 user 消息到
# assistant 消息的间隔 **中位 3.6 秒 / p95 20.7 秒**。第一次嵌入发生在装配提示词时
# （生成前），第二次发生在把这句话写进记忆时（生成后），两者相隔正是一轮生成的时长。
# 原来给 20 秒 ⇒ 恰好卡在 p95 上，**多数轮次差一点点没接住**，白付一次固定开销。
# 取 120 秒 = p95 的 6 倍余量；缓存上限 128 条 ×1024 维 ≈ 512KB，且键含 provider 与
# 维度，换模型/降级都会自然失效，不存在跨模型冒用。
_EMBED_DEDUP_TTL_SECONDS: float = float(os.getenv("MEMORY_EMBED_DEDUP_TTL_SECONDS", "120"))
_EMBED_DEDUP_MAX_ENTRIES: int = int(os.getenv("MEMORY_EMBED_DEDUP_MAX_ENTRIES", "128"))
_embed_dedup_cache: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_embed_dedup_lock = threading.Lock()


def _embed_dedup_key(embedder: BaseEmbedder, text: str) -> tuple:
    """缓存键含 provider 身份 + 模型名 + 当前维度。

    维度必须在键里：`OllamaEmbedder` 降级到 fastembed 时 `dimension` 从 1024 变 512，
    两套向量互不兼容（历史上出过「存得进召不回」的死向量），绝不能互相冒用缓存。
    """
    return (
        type(embedder).__name__,
        getattr(embedder, "_model", None) or "",
        int(embedder.dimension),
        text,
    )


def _embed_dedup_get(key: tuple) -> Optional[np.ndarray]:
    if _EMBED_DEDUP_TTL_SECONDS <= 0:
        return None
    now = time.monotonic()
    with _embed_dedup_lock:
        hit = _embed_dedup_cache.get(key)
        if hit is None:
            return None
        vec, ts = hit
        if now - ts > _EMBED_DEDUP_TTL_SECONDS:
            _embed_dedup_cache.pop(key, None)
            return None
        _embed_dedup_cache.move_to_end(key)
        # 返回副本：调用方拿到的是可自由 tolist()/切片的数据，不许改到缓存
        return vec.copy()


def _embed_dedup_put(key: tuple, vector: np.ndarray) -> None:
    if _EMBED_DEDUP_TTL_SECONDS <= 0:
        return
    with _embed_dedup_lock:
        _embed_dedup_cache[key] = (vector.copy(), time.monotonic())
        _embed_dedup_cache.move_to_end(key)
        while len(_embed_dedup_cache) > _EMBED_DEDUP_MAX_ENTRIES:
            _embed_dedup_cache.popitem(last=False)


def reset_embed_dedup_cache() -> None:
    """清空去重缓存。`EmbedderFactory.reset()` 会调它——
    测试里换嵌入器必须连缓存一起换，否则上一个用例的向量会喂给下一个用例。
    """
    with _embed_dedup_lock:
        _embed_dedup_cache.clear()


def embed_text(text: Union[str, List[str]]) -> np.ndarray:
    """快速嵌入文本（带同文本去重，见上方 [EMB-DEDUP] 注释）。

    返回形状与各 provider 的 `embed()` 一致：恒为 (n, dim) 二维
    （传 str 也是 (1, dim)），空输入原样透传给底层实现。
    """
    embedder = get_embedder()

    items = [text] if isinstance(text, str) else list(text)
    # 空输入 / 混入非字符串 / 缓存关闭 ⇒ 原样透传，不碰底层行为
    if not items or not all(isinstance(t, str) for t in items) or _EMBED_DEDUP_TTL_SECONDS <= 0:
        return embedder.embed(text)

    dim = int(embedder.dimension)
    slots: List[Optional[np.ndarray]] = [None] * len(items)
    # 未命中的文本按「首次出现顺序」去重收集；同一文本落在哪几个位置都记下来，
    # 这样**同一批内部的重复**（同轮出现两段一模一样的块）也只嵌一次。
    uniq_texts: List[str] = []
    uniq_slots: List[List[int]] = []
    uniq_pos: dict = {}
    for i, t in enumerate(items):
        cached = _embed_dedup_get(_embed_dedup_key(embedder, t))
        if cached is not None and cached.shape[-1] == dim:
            slots[i] = cached
            continue
        pos = uniq_pos.get(t)
        if pos is None:
            uniq_pos[t] = len(uniq_texts)
            uniq_texts.append(t)
            uniq_slots.append([i])
        else:
            uniq_slots[pos].append(i)

    if not uniq_texts:
        return np.stack(slots)

    fresh = embedder.embed(uniq_texts)
    fresh = np.asarray(fresh, dtype=np.float32)
    if fresh.ndim == 1:
        # 底层对单条输入偶尔给出一维，补齐成 (1, dim) 再分发
        fresh = fresh.reshape(1, -1)
    if len(fresh) < len(uniq_texts):
        # 底层返回条数少于请求条数 ⇒ 不做无根据的对位猜测，
        # 退回改造前的语义：整批原样交给底层（宁可多算，不可错位的向量进库）
        logger.warning("嵌入返回条数 %d < 请求 %d，放弃本批去重", len(fresh), len(uniq_texts))
        return embedder.embed(items)

    for j, t in enumerate(uniq_texts):
        vec = fresh[j]
        _embed_dedup_put(_embed_dedup_key(embedder, t), vec)
        for i in uniq_slots[j]:
            slots[i] = vec

    return np.stack(slots)
