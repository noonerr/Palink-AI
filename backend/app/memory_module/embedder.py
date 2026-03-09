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

from .config import memory_config

logger = logging.getLogger("MemoryModule")


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
        
        if not text:
            return vec
        
        for i in range(len(text) - 2):
            ngram = text[i:i+3]
            idx = int(hashlib.md5(ngram.encode()).hexdigest(), 16) % (self._dimension // 3)
            vec[idx] += 1.0
        
        words = text.split()
        for word in words:
            idx = int(hashlib.md5(word.encode()).hexdigest(), 16) % (self._dimension // 3)
            vec[idx + self._dimension // 3] += 1.0
            
            length_idx = min(len(word), 20)
            vec[self._dimension // 3 * 2 + length_idx] += 0.5
        
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
    使用sentence-transformers加载BGE-Large-zh-v1.5
    """
    
    def __init__(self):
        try:
            from sentence_transformers import SentenceTransformer
            
            model_name = "BAAI/bge-large-zh-v1.5"
            
            cache_dir = "/app/models/sentence_transformers"
            os.makedirs(cache_dir, exist_ok=True)
            
            os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
            
            self.model = SentenceTransformer(
                model_name,
                cache_folder=cache_dir
            )
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
            self.client = openai.AsyncOpenAI()
            self._dimension = 1536
            logger.info("OpenAI 嵌入模型初始化成功")
        except ImportError:
            logger.error("openai 未安装")
            raise
    
    def embed(self, text: Union[str, List[str]]) -> np.ndarray:
        import asyncio
        
        if isinstance(text, str):
            text = [text]
        
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        response = loop.run_until_complete(
            self.client.embeddings.create(
                model=memory_config.OPENAI_MODEL,
                input=text
            )
        )
        
        embeddings = [item.embedding for item in response.data]
        return np.array(embeddings)
    
    @property
    def dimension(self) -> int:
        return self._dimension


class EmbedderFactory:
    """嵌入模型工厂 - 优先级: SimpleHash > SentenceTransformer > FastEmbed > OpenAI"""
    
    _instance: BaseEmbedder = None
    
    @classmethod
    def get_embedder(cls) -> BaseEmbedder:
        """获取或创建嵌入器实例（单例模式）"""
        if cls._instance is None:
            cls._instance = cls._create_embedder()
        return cls._instance
    
    @classmethod
    def _create_embedder(cls) -> BaseEmbedder:
        """创建嵌入器 - 优先使用简单哈希，无需外部依赖"""
        
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
