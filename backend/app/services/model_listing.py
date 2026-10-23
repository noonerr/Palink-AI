"""供应商模型列表（providers + 本地启用模型）的单一实现。

2026-10-23 从 `api/silly_tavern.py::_public_models` 原样搬出，供两处共用：
- ST 兼容面（`_public_models` 保留原名作为别名）；
- `utils.get_default_ai_model` 校验「管理员设置的默认模型是否仍然可用」。

⚠️ 与 `api/models.py::get_models` **不是**同一份计算：后者走 `get_flat_model_list()`
（统一模型表，同名模型合并 + `unified_models.json` 展示层覆盖，返回 12 个字段）。
本模块只做「providers 顺序 + 本地启用模型」的朴素投影（3 个字段），
两者用途不同，**不要**为了「去重」把它们合并。
"""
from typing import Any

from .local_model_registry import list_enabled_chat_models
from .provider_registry import get_providers


def list_provider_models() -> list[dict[str, Any]]:
    """按 providers 顺序列出可用模型，再追加本地启用模型（按 id 去重）。

    返回字段：``id`` / ``name`` / ``context_length``（缺省 4096）。
    """
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for provider in get_providers():
        if provider.get("is_active") is not None and not provider.get("is_active"):
            continue
        for model in provider.get("models", []):
            if isinstance(model, dict):
                model_id = str(model.get("id") or "")
                display_name = model.get("name") or model.get("alias") or model_id
                context_length = model.get("context_length") or 4096
            else:
                model_id = str(model or "")
                display_name = model_id
                context_length = 4096
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            result.append({
                "id": model_id,
                "name": display_name,
                "context_length": context_length,
            })
    for model in list_enabled_chat_models():
        model_id = str(model.get("id") or "")
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        result.append({
            "id": model_id,
            "name": model.get("name") or model_id,
            "context_length": model.get("context_length") or 4096,
        })
    return result
