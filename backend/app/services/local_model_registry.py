import json
import os
import re
import shutil
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, UploadFile

from ..core import settings


LOCAL_MODEL_PREFIX = "local:"
_ALLOWED_MODEL_EXTENSIONS = {".gguf"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _models_dir() -> str:
    return os.path.join(settings.DATA_DIR, "models")


def _registry_path() -> str:
    return os.path.join(settings.DATA_DIR, "local_models.json")


def _slugify(value: str) -> str:
    raw = (value or "").strip().lower()
    raw = re.sub(r"[^a-z0-9._-]+", "-", raw)
    raw = raw.strip("-._")
    return raw or "model"


def _parse_model_key(model_ref: str) -> str:
    raw = (model_ref or "").strip()
    if raw.startswith(LOCAL_MODEL_PREFIX):
        return raw[len(LOCAL_MODEL_PREFIX):]
    return raw


def _local_model_id(model_key: str) -> str:
    return f"{LOCAL_MODEL_PREFIX}{model_key}"


def _safe_size_gb(size_bytes: int) -> float:
    gb = float(size_bytes) / (1024.0 * 1024.0 * 1024.0)
    return round(gb, 3)


def _ensure_registry_file() -> None:
    os.makedirs(settings.DATA_DIR, exist_ok=True)
    os.makedirs(_models_dir(), exist_ok=True)
    path = _registry_path()
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as registry_file:
            json.dump({"version": 1, "models": []}, registry_file, ensure_ascii=False, indent=2)


def _load_registry() -> Dict[str, Any]:
    _ensure_registry_file()
    path = _registry_path()
    try:
        with open(path, "r", encoding="utf-8") as registry_file:
            data = json.load(registry_file)
    except Exception:
        data = {"version": 1, "models": []}

    if not isinstance(data, dict):
        data = {"version": 1, "models": []}

    models = data.get("models")
    if not isinstance(models, list):
        models = []
    data["models"] = models

    if "version" not in data:
        data["version"] = 1

    return data


def _save_registry(data: Dict[str, Any]) -> None:
    _ensure_registry_file()
    with open(_registry_path(), "w", encoding="utf-8") as registry_file:
        json.dump(data, registry_file, ensure_ascii=False, indent=2)


def _sync_disk_models(data: Dict[str, Any]) -> bool:
    changed = False
    models = data.get("models", [])
    model_index: Dict[str, Dict[str, Any]] = {}

    for model in models:
        if not isinstance(model, dict):
            continue
        key = str(model.get("key") or "").strip()
        if key:
            model_index[key] = model

    models_dir = _models_dir()
    if not os.path.exists(models_dir):
        return False

    for filename in os.listdir(models_dir):
        file_path = os.path.join(models_dir, filename)
        if not os.path.isfile(file_path):
            continue

        ext = os.path.splitext(filename)[1].lower()
        if ext not in _ALLOWED_MODEL_EXTENSIONS:
            continue

        key_base = _slugify(os.path.splitext(filename)[0])
        key = key_base
        suffix = 2
        while key in model_index and os.path.abspath(model_index[key].get("path", "")) != os.path.abspath(file_path):
            key = f"{key_base}-{suffix}"
            suffix += 1

        if key in model_index:
            model = model_index[key]
            updated = False
            if model.get("filename") != filename:
                model["filename"] = filename
                updated = True
            if model.get("path") != file_path:
                model["path"] = file_path
                updated = True
            size_bytes = os.path.getsize(file_path)
            if int(model.get("size_bytes") or 0) != size_bytes:
                model["size_bytes"] = size_bytes
                updated = True
            if updated:
                model["updated_at"] = _now_iso()
                changed = True
            continue

        model = {
            "key": key,
            "filename": filename,
            "display_name": os.path.splitext(filename)[0],
            "path": file_path,
            "size_bytes": os.path.getsize(file_path),
            "enabled": False,
            "context_length": 4096,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        models.append(model)
        model_index[key] = model
        changed = True

    existing_paths = {
        os.path.abspath(os.path.join(models_dir, item))
        for item in os.listdir(models_dir)
        if os.path.isfile(os.path.join(models_dir, item))
    }
    kept_models: List[Dict[str, Any]] = []
    for model in models:
        path = os.path.abspath(str(model.get("path") or ""))
        if path and path in existing_paths:
            kept_models.append(model)
        else:
            changed = True

    if len(kept_models) != len(models):
        data["models"] = kept_models

    return changed


def _normalize_model_view(model: Dict[str, Any]) -> Dict[str, Any]:
    size_bytes = int(model.get("size_bytes") or 0)
    key = str(model.get("key") or "").strip()
    model_id = _local_model_id(key) if key else ""
    return {
        "id": model_id,
        "key": key,
        "name": model.get("display_name") or model.get("filename") or key,
        "filename": model.get("filename") or "",
        "size": _safe_size_gb(size_bytes),
        "size_bytes": size_bytes,
        "path": model.get("path") or "",
        "enabled": bool(model.get("enabled", False)),
        "type": "gguf",
        "context_length": int(model.get("context_length") or 4096),
        "created_at": model.get("created_at"),
        "updated_at": model.get("updated_at"),
    }


def is_local_model_id(model_id: str) -> bool:
    return isinstance(model_id, str) and model_id.startswith(LOCAL_MODEL_PREFIX)


def list_local_models(include_disabled: bool = True) -> List[Dict[str, Any]]:
    data = _load_registry()
    if _sync_disk_models(data):
        _save_registry(data)

    result = []
    for model in data.get("models", []):
        if not isinstance(model, dict):
            continue
        enabled = bool(model.get("enabled", False))
        if not include_disabled and not enabled:
            continue
        result.append(_normalize_model_view(model))

    result.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return result


def list_enabled_chat_models() -> List[Dict[str, Any]]:
    models = list_local_models(include_disabled=False)
    result = []
    for model in models:
        result.append({
            "id": model["id"],
            "name": model["name"],
            "alias": model["name"],
            "icon": "🦙",
            "description": "Local GGUF model via llama.cpp",
            "context_length": model.get("context_length") or 4096,
            "avatar": "",
            "provider": "Local (llama.cpp)",
        })
    return result


def _find_model_entry(data: Dict[str, Any], model_ref: str) -> Optional[Dict[str, Any]]:
    key = _parse_model_key(model_ref)
    filename_ref = model_ref.strip()

    for model in data.get("models", []):
        if not isinstance(model, dict):
            continue
        model_key = str(model.get("key") or "").strip()
        filename = str(model.get("filename") or "").strip()
        local_id = _local_model_id(model_key) if model_key else ""

        if key and model_key == key:
            return model
        if filename_ref and filename == filename_ref:
            return model
        if filename_ref and local_id == filename_ref:
            return model

    return None


def get_local_model_for_inference(model_id: str, require_enabled: bool = True) -> Optional[Dict[str, Any]]:
    data = _load_registry()
    if _sync_disk_models(data):
        _save_registry(data)

    model = _find_model_entry(data, model_id)
    if not model:
        return None

    if require_enabled and not bool(model.get("enabled", False)):
        return None

    model_path = str(model.get("path") or "")
    if not model_path or not os.path.exists(model_path):
        return None

    return {
        "id": _local_model_id(str(model.get("key") or "")),
        "key": str(model.get("key") or ""),
        "name": model.get("display_name") or model.get("filename") or model.get("key"),
        "path": model_path,
        "context_length": int(model.get("context_length") or 4096),
        "size_bytes": int(model.get("size_bytes") or 0),
        "enabled": bool(model.get("enabled", False)),
    }


def upload_local_model(file: UploadFile) -> Dict[str, Any]:
    filename = os.path.basename(file.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="Invalid file name")

    ext = os.path.splitext(filename)[1].lower()
    if ext not in _ALLOWED_MODEL_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only .gguf files are supported")

    models_dir = _models_dir()
    os.makedirs(models_dir, exist_ok=True)

    desired_path = os.path.join(models_dir, filename)
    final_path = desired_path
    if os.path.exists(final_path):
        stem, ext_name = os.path.splitext(filename)
        suffix = datetime.now().strftime("%Y%m%d%H%M%S")
        final_path = os.path.join(models_dir, f"{stem}-{suffix}{ext_name}")

    try:
        with open(final_path, "wb") as output_file:
            file.file.seek(0)
            shutil.copyfileobj(file.file, output_file)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {exc}")

    size_bytes = os.path.getsize(final_path) if os.path.exists(final_path) else 0
    if size_bytes <= 0:
        if os.path.exists(final_path):
            os.remove(final_path)
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    saved_filename = os.path.basename(final_path)
    key_base = _slugify(os.path.splitext(saved_filename)[0])

    data = _load_registry()
    models = data.get("models", [])

    key = key_base
    suffix = 2
    used_keys = {str(item.get("key") or "").strip() for item in models if isinstance(item, dict)}
    while key in used_keys:
        key = f"{key_base}-{suffix}"
        suffix += 1

    entry = {
        "key": key,
        "filename": saved_filename,
        "display_name": os.path.splitext(saved_filename)[0],
        "path": final_path,
        "size_bytes": size_bytes,
        "enabled": False,
        "context_length": 4096,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }

    models.append(entry)
    data["models"] = models
    _save_registry(data)

    return {
        "message": "模型上传成功，请手动启用后使用",
        "model": _normalize_model_view(entry),
    }


def set_local_model_enabled(model_ref: str, enabled: bool) -> Dict[str, Any]:
    data = _load_registry()
    model = _find_model_entry(data, model_ref)
    if not model:
        raise HTTPException(status_code=404, detail="Local model not found")

    model["enabled"] = bool(enabled)
    model["updated_at"] = _now_iso()
    _save_registry(data)
    return _normalize_model_view(model)


def delete_local_model(model_ref: str) -> Dict[str, Any]:
    data = _load_registry()
    models = data.get("models", [])

    target_index = -1
    target_model: Optional[Dict[str, Any]] = None
    for idx, model in enumerate(models):
        if not isinstance(model, dict):
            continue
        key = str(model.get("key") or "").strip()
        filename = str(model.get("filename") or "").strip()
        local_id = _local_model_id(key) if key else ""
        ref_key = _parse_model_key(model_ref)

        if (ref_key and key == ref_key) or model_ref == filename or model_ref == local_id:
            target_index = idx
            target_model = model
            break

    if target_index < 0 or not target_model:
        raise HTTPException(status_code=404, detail="Local model not found")

    model_path = str(target_model.get("path") or "")
    if model_path and os.path.exists(model_path):
        try:
            os.remove(model_path)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to delete model file: {exc}")

    removed = models.pop(target_index)
    data["models"] = models
    _save_registry(data)

    return {
        "id": _local_model_id(str(removed.get("key") or "")),
        "name": removed.get("display_name") or removed.get("filename") or removed.get("key"),
    }
