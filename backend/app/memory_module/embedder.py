"""
嵌入模型封装
支持多种后端：SimpleHash(默认) / FastEmbed(轻量级ONNX) / OpenAI
纯CPU优化，无CUDA依赖
"""

import numpy as np
from typing import Union, List
from abc import ABC, abstractmethod
import logging
import os
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
        logger.info(f"Ollama 嵌入器初始化: host={self._host} model={self._model} 维度: {self._dimension}")

    def _get_fallback(self) -> BaseEmbedder:
        if self._fallback is None:
            try:
                self._fallback = FastEmbedEmbedder()
            except Exception as e:
                logger.warning(f"Ollama 降级 fastembed 创建失败: {e}")
                self._fallback = SimpleHashEmbedder()
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
            return np.array(embeddings, dtype=np.float32)
        except Exception as e:
            logger.warning(f"Ollama 嵌入失败，降级 fastembed: {e}")
            return self._get_fallback().embed(text)

    @property
    def dimension(self) -> int:
        return self._dimension


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


def get_embedder() -> BaseEmbedder:
    """获取全局嵌入器实例"""
    return EmbedderFactory.get_embedder()


def embed_text(text: Union[str, List[str]]) -> np.ndarray:
    """快速嵌入文本"""
    embedder = get_embedder()
    return embedder.embed(text)
