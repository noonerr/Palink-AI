import os
import json
import logging
from typing import List, Dict, Optional

logger = logging.getLogger("ModelManager")

class ModelManager:
    def __init__(self, model_dir: str):
        self.model_dir = model_dir
        self.models = []
        self.loaded_models = {}
        
        # 状态文件路径（保存在模型目录外，避免被扫描）
        self.state_file = os.path.join(os.path.dirname(model_dir), 'model_states.json')
        self.model_states = {}  # 缓存模型状态
        
        # 确保模型目录存在
        if not os.path.exists(self.model_dir):
            os.makedirs(self.model_dir)
        
        # 加载保存的状态
        self._load_states()
        
        self.scan_models()
    
    def _load_states(self):
        """从文件加载模型状态"""
        try:
            if os.path.exists(self.state_file):
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    self.model_states = json.load(f)
                logger.info(f"已加载 {len(self.model_states)} 个模型状态")
        except Exception as e:
            logger.error(f"加载模型状态失败: {e}")
            self.model_states = {}
    
    def _save_states(self):
        """保存模型状态到文件"""
        try:
            with open(self.state_file, 'w', encoding='utf-8') as f:
                json.dump(self.model_states, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"保存模型状态失败: {e}")
    
    def _get_model_state(self, model_id: str) -> dict:
        """获取模型的保存状态"""
        return self.model_states.get(model_id, {})
    
    def scan_models(self) -> List[Dict]:
        """扫描模型目录，返回可用模型列表"""
        self.models = []
        
        try:
            # 扫描主模型目录
            for filename in os.listdir(self.model_dir):
                file_path = os.path.join(self.model_dir, filename)
                if os.path.isfile(file_path) and self._is_model_file(filename):
                    model_info = self._get_model_info(filename, file_path)
                    if model_info:
                        self.models.append(model_info)
            
            # 扫描子目录
            for dirname in os.listdir(self.model_dir):
                dir_path = os.path.join(self.model_dir, dirname)
                if os.path.isdir(dir_path):
                    for filename in os.listdir(dir_path):
                        file_path = os.path.join(dir_path, filename)
                        if os.path.isfile(file_path) and self._is_model_file(filename):
                            model_info = self._get_model_info(filename, file_path, dirname)
                            if model_info:
                                self.models.append(model_info)
        except Exception as e:
            logger.error(f"扫描模型失败: {e}")
        
        return self.models
    
    def _is_model_file(self, filename: str) -> bool:
        """判断是否为模型文件"""
        model_extensions = ['.gguf', '.ggml', '.bin', '.safetensors']
        return any(filename.lower().endswith(ext) for ext in model_extensions)
    
    def _get_model_info(self, filename: str, file_path: str, subdir: Optional[str] = None) -> Dict:
        """获取模型信息"""
        try:
            file_size = os.path.getsize(file_path)
            size_gb = round(file_size / (1024 * 1024 * 1024), 2)
            
            model_id = f"local:{filename}"
            
            # 从保存的状态中获取启用状态（默认启用）
            saved_state = self._get_model_state(model_id)
            enabled = saved_state.get('enabled', True)
            
            model_info = {
                "id": model_id,
                "name": filename,
                "path": file_path,
                "size": size_gb,
                "size_bytes": file_size,
                "subdir": subdir,
                "status": "available",
                "type": "local",
                "enabled": enabled  # 使用保存的状态
            }
            
            return model_info
        except Exception as e:
            logger.error(f"获取模型信息失败: {e}")
            return None
    
    def set_model_enabled(self, model_id: str, enabled: bool) -> bool:
        """设置模型启用/禁用状态"""
        model = self.get_model_by_id(model_id)
        if not model:
            return False
        
        try:
            # 更新内存中的状态
            model["enabled"] = enabled
            
            # 保存到状态文件
            self.model_states[model_id] = {'enabled': enabled}
            self._save_states()
            
            logger.info(f"模型 {model_id} 已{'启用' if enabled else '禁用'}")
            return True
        except Exception as e:
            logger.error(f"设置模型状态失败: {e}")
            return False
    
    def get_enabled_models(self) -> List[Dict]:
        """获取已启用的模型列表"""
        return [model for model in self.models if model.get("enabled", True)]
    
    def get_model_by_id(self, model_id: str) -> Optional[Dict]:
        """根据ID获取模型"""
        for model in self.models:
            if model["id"] == model_id:
                return model
        return None
    
    def load_model(self, model_id: str) -> bool:
        """加载模型"""
        model = self.get_model_by_id(model_id)
        if not model:
            return False
        
        try:
            # 这里只是记录模型状态，实际加载会在使用时进行
            model["status"] = "loaded"
            self.loaded_models[model_id] = model
            return True
        except Exception as e:
            logger.error(f"加载模型失败: {e}")
            return False
    
    def unload_model(self, model_id: str) -> bool:
        """卸载模型"""
        if model_id in self.loaded_models:
            del self.loaded_models[model_id]
            for model in self.models:
                if model["id"] == model_id:
                    model["status"] = "available"
                    return True
        return False
    
    def upload_model(self, file_path: str, model_name: str) -> bool:
        """上传模型文件"""
        try:
            dest_path = os.path.join(self.model_dir, model_name)
            import shutil
            shutil.copy(file_path, dest_path)
            
            # 重新扫描模型
            self.scan_models()
            return True
        except Exception as e:
            logger.error(f"上传模型失败: {e}")
            return False
    
    def delete_model(self, model_id: str) -> bool:
        """删除模型"""
        model = self.get_model_by_id(model_id)
        if not model:
            return False
        
        try:
            os.remove(model["path"])
            # 删除状态记录
            if model_id in self.model_states:
                del self.model_states[model_id]
                self._save_states()
            # 重新扫描模型
            self.scan_models()
            # 如果模型已加载，卸载它
            if model_id in self.loaded_models:
                del self.loaded_models[model_id]
            return True
        except Exception as e:
            logger.error(f"删除模型失败: {e}")
            return False
    
    def get_loaded_models(self) -> Dict[str, Dict]:
        """获取已加载的模型"""
        return self.loaded_models
    
    def get_available_models(self) -> List[Dict]:
        """获取可用模型列表"""
        return self.models

# 全局模型管理器实例
model_manager = None

def init_model_manager(model_dir: str):
    """初始化模型管理器"""
    global model_manager
    model_manager = ModelManager(model_dir)
    return model_manager

def get_model_manager() -> ModelManager:
    """获取模型管理器实例"""
    global model_manager
    if not model_manager:
        raise Exception("模型管理器未初始化")
    return model_manager
