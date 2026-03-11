import os
import logging
import asyncio
from typing import List, Dict, Optional, AsyncGenerator

try:
    from llama_cpp import Llama
    LLAMA_AVAILABLE = True
except ImportError:
    logging.warning("llama_cpp模块未找到，本地模型功能将不可用")
    LLAMA_AVAILABLE = False
    Llama = None

logger = logging.getLogger("LlamaService")

class LlamaService:
    def __init__(self):
        self.models = {}
        self.default_params = {
            "temperature": 0.7,
            "max_tokens": 1024,
            "top_p": 0.95,
            "repeat_penalty": 1.1,
            "top_k": 40
        }
    
    def load_model(self, model_path: str, model_id: str) -> bool:
        """加载模型"""
        try:
            if not LLAMA_AVAILABLE:
                logger.error("llama_cpp模块未找到，无法加载模型")
                return False
                
            if model_id in self.models:
                return True
            
            logger.info(f"加载模型: {model_path}")
            
            # 加载模型
            llm = Llama(
                model_path=model_path,
                n_ctx=4096,
                n_batch=512,
                n_gpu_layers=0  # 可以根据GPU情况调整
            )
            
            self.models[model_id] = llm
            logger.info(f"模型加载成功: {model_id}")
            return True
        except Exception as e:
            logger.error(f"加载模型失败: {e}")
            return False
    
    def unload_model(self, model_id: str) -> bool:
        """卸载模型"""
        try:
            if model_id in self.models:
                del self.models[model_id]
                logger.info(f"模型卸载成功: {model_id}")
                return True
            return False
        except Exception as e:
            logger.error(f"卸载模型失败: {e}")
            return False
    
    async def generate(self, model_id: str, prompt: str, **kwargs) -> str:
        """生成文本"""
        try:
            if not LLAMA_AVAILABLE:
                raise Exception("llama_cpp模块未找到，无法生成文本")
                
            if model_id not in self.models:
                raise Exception(f"模型未加载: {model_id}")
            
            params = self.default_params.copy()
            params.update(kwargs)
            
            llm = self.models[model_id]
            result = llm(prompt, **params)
            
            return result["choices"][0]["text"]
        except Exception as e:
            logger.error(f"生成文本失败: {e}")
            raise
    
    async def generate_stream(self, model_id: str, prompt: str, **kwargs) -> AsyncGenerator[str, None]:
        """流式生成文本"""
        try:
            if not LLAMA_AVAILABLE:
                raise Exception("llama_cpp模块未找到，无法流式生成文本")
                
            if model_id not in self.models:
                raise Exception(f"模型未加载: {model_id}")
            
            params = self.default_params.copy()
            params.update(kwargs)
            params["stream"] = True
            
            llm = self.models[model_id]
            
            for chunk in llm(prompt, **params):
                if "choices" in chunk and chunk["choices"]:
                    text = chunk["choices"][0]["text"]
                    if text:
                        yield text
                    await asyncio.sleep(0.01)  # 避免阻塞
        except Exception as e:
            logger.error(f"流式生成失败: {e}")
            raise
    
    def get_model_info(self, model_id: str) -> Optional[Dict]:
        """获取模型信息"""
        try:
            if model_id not in self.models:
                return None
            
            llm = self.models[model_id]
            info = {
                "model_id": model_id,
                "n_ctx": llm.n_ctx,
                "n_batch": llm.n_batch,
                "n_gpu_layers": llm.n_gpu_layers,
                "is_loaded": True
            }
            
            return info
        except Exception as e:
            logger.error(f"获取模型信息失败: {e}")
            return None
    
    def list_loaded_models(self) -> List[str]:
        """列出已加载的模型"""
        return list(self.models.keys())
    
    def is_model_loaded(self, model_id: str) -> bool:
        """检查模型是否已加载"""
        return model_id in self.models

# 全局Llama服务实例
llama_service = None

def init_llama_service():
    """初始化Llama服务"""
    global llama_service
    llama_service = LlamaService()
    return llama_service

def get_llama_service() -> LlamaService:
    """获取Llama服务实例"""
    global llama_service
    if not llama_service:
        raise Exception("Llama服务未初始化")
    return llama_service
