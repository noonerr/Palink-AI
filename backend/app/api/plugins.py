import json
import uuid
import re
import base64
import io
import zipfile
import hashlib
from datetime import datetime, timezone
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Response, Request
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..models.plugin import Plugin, PluginScript
from ..models.character import Character
from ..models.user import User
from ..api.dependencies import get_admin, get_current_user
from ..database import get_db
# 正则脚本导入到角色/预设时清除 character_ext 中的预编译缓存
from .character_ext import invalidate_regex_pattern_cache
from ..core.cache import cached, invalidate_cache

router = APIRouter(prefix="/api/plugins", tags=["plugins"])

# S-9 修复: 插件 zip 导入的防 zip 炸弹限制。
# - 上传文件总大小上限（防止 file.read() 无上限读入内存）
# - 单 zip 条目数上限（防止海量小文件耗尽内存/CPU）
# - 解压总字节上限（防止 zip 炸弹：小压缩包解压出超大内容）
_PLUGIN_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024      # 50MB 上传文件
_PLUGIN_IMPORT_MAX_ENTRIES = 2000                     # 最多 2000 个条目
_PLUGIN_IMPORT_MAX_UNCOMPRESSED = 100 * 1024 * 1024   # 解压总量 100MB


async def _read_upload_limited(file: UploadFile, max_bytes: int = _PLUGIN_IMPORT_MAX_FILE_BYTES) -> bytes:
    """S-9 修复: 分块读取上传文件并限制总大小，避免 file.read() 无上限。"""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Uploaded file too large (max {max_bytes // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


class RegexImportPayload(BaseModel):
    scripts: list | dict
    target: str = "global"
    character_id: Optional[str] = None
    preset_name: Optional[str] = None


class PluginConfigPatchPayload(BaseModel):
    config: Optional[dict[str, Any]] = None
    settings: Optional[dict[str, Any]] = None
    extension_settings: Optional[dict[str, Any]] = None
    manifest: Optional[dict[str, Any]] = None
    runtime: Optional[dict[str, Any]] = None
    capabilities: Optional[Any] = None
    scope: Optional[str] = None
    global_runtime: Optional[bool] = None
    description: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None


def _plugin_to_dict(p: Plugin) -> dict:
    scripts_count = len(p.scripts) if p.scripts else 0
    enabled_scripts = sum(1 for s in (p.scripts or []) if s.enabled)
    config = _plugin_config(p)
    if isinstance(config.get("runtime"), dict):
        config = dict(config)
        config["runtime"] = _effective_runtime_for_plugin(p, _safe_dict(config.get("runtime")))
    return {
        "id": p.id,
        "name": p.name,
        "plugin_type": p.plugin_type,
        "description": p.description,
        "version": p.version,
        "author": p.author,
        "enabled": p.enabled,
        "source_type": p.source_type,
        "config": config,
        "scripts_count": scripts_count,
        "enabled_scripts": enabled_scripts,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


def _script_to_dict(s: PluginScript) -> dict:
    original = _script_original_data(s)
    find_regex = original.get("findRegex") or original.get("find_regex") or s.find_regex
    replace_string = original.get("replaceString") or original.get("replace_string") or s.replace_string
    placement = original.get("placement") if "placement" in original else s.placement
    markdown_only = original.get("markdownOnly", original.get("markdown_only", s.markdown_only))
    prompt_only = original.get("promptOnly", original.get("prompt_only", s.prompt_only))
    run_on_edit = original.get("runOnEdit", original.get("run_on_edit", s.run_on_edit))
    substitute_regex = original.get("substituteRegex", original.get("substitute_regex", s.substitute_regex))
    min_depth = original.get("minDepth", original.get("min_depth", s.min_depth))
    max_depth = original.get("maxDepth", original.get("max_depth", s.max_depth))
    return {
        "id": s.id,
        "plugin_id": s.plugin_id,
        "script_name": s.script_name,
        "script_type": s.script_type,
        "enabled": s.enabled,
        "content_length": len(s.content) if s.content else 0,
        "find_regex": find_regex,
        "replace_string_length": len(replace_string) if replace_string else 0,
        "placement": placement,
        "markdown_only": bool(markdown_only),
        "prompt_only": bool(prompt_only),
        "run_on_edit": bool(run_on_edit),
        "substitute_regex": substitute_regex,
        "min_depth": min_depth,
        "max_depth": max_depth,
        "order_no": s.order_no,
    }


def _script_original_data(s: PluginScript) -> dict:
    if not s.content:
        return {}
    try:
        parsed = json.loads(s.content)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _detect_plugin_type(data) -> str:
    if isinstance(data, list):
        if len(data) > 0 and isinstance(data[0], dict):
            if data[0].get("scriptName") or data[0].get("findRegex"):
                return "regex_scripts"
            if data[0].get("prompts") or data[0].get("promptGroup") or data[0].get("plotTasks"):
                return "preset"
        return "unknown"
    if isinstance(data, dict):
        if _looks_like_sillytavern_extension_manifest(data):
            return "sillytavern_extension"
        if data.get("mate") and data["mate"].get("type") in ("chatSheets",):
            return "chatsheets"
        if data.get("spec") in ("chara_card_v2", "chara_card_v3"):
            return "character_card"
        if data.get("prompts") or data.get("promptGroup") or data.get("plotTasks"):
            return "preset"
        if data.get("scripts") and isinstance(data["scripts"], list):
            return "tavern_helper"
        if any(k.startswith("sheet_") for k in data.keys()):
            return "chatsheets"
        if data.get("scriptName") or data.get("findRegex"):
            return "regex_script_single"
    return "unknown"


def _looks_like_sillytavern_extension_manifest(data: dict) -> bool:
    if not isinstance(data, dict):
        return False
    manifest_markers = {
        "display_name",
        "loading_order",
        "js",
        "css",
        "requires",
        "optional",
        "homePage",
        "auto_update",
        # P0-2: ST 1.18.0 manifest 还可能仅含以下标记字段（extensions.js:2024/:579）
        "generate_interceptor",
        "dependencies",
    }
    has_name = any(isinstance(data.get(key), str) and data.get(key) for key in ("name", "display_name", "id"))
    has_extension_marker = any(key in data for key in manifest_markers)
    return bool(has_name and has_extension_marker)


def _normalize_extension_resource_list(value) -> list[str]:
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


# 明显非模板目录（依赖/构建产物），其中的 .html 不应被当作扩展模板抽取
_NON_TEMPLATE_DIRS = {"node_modules", "dist", "build", "vendor", ".git", "__pycache__"}


def _is_extension_template_resource(path: str) -> bool:
    lower = str(path or "").lower()
    if not lower.endswith((".html", ".hbs", ".handlebars", ".mustache")):
        return False
    parts = [part for part in lower.split("/") if part]
    # 排除依赖/构建产物目录下的 html（如 node_modules 内的演示页）
    if any(seg in _NON_TEMPLATE_DIRS for seg in parts[:-1]):
        return False
    # ST 1.18.0 官方扩展的模板布局并不统一：
    # - caption / memory / tts / vectors 把 settings.html 放在扩展根目录
    # - regex / stable-diffusion / expressions 把多个模板（scriptTemplate.html、
    #   dropdown.html 等）也放在根目录，或 html/ 子目录
    # - quick-reply 放在 html/ 子目录
    # 因此「扩展内的任何 .html 都是 Handlebars 模板」——统一抽取，由前端
    # renderExtensionTemplateAsync 按名按需取用（不匹配则不会被引用，安全）。
    return True


def _is_extension_js_module_resource(path: str) -> bool:
    lower = str(path or "").lower()
    return lower.endswith((".js", ".mjs"))


def _safe_zip_member_name(name: str) -> str:
    normalized = str(name or "").replace("\\", "/").lstrip("/")
    parts = [part for part in normalized.split("/") if part and part not in {".", ".."}]
    return "/".join(parts)


def _candidate_manifest_paths(zip_file: zipfile.ZipFile) -> list[str]:
    candidates = []
    for info in zip_file.infolist():
        if info.is_dir():
            continue
        path = _safe_zip_member_name(info.filename)
        if path.lower().endswith("manifest.json"):
            candidates.append(path)
    return sorted(candidates, key=lambda item: (item.count("/"), len(item), item.lower()))


def _zip_name_map(zip_file: zipfile.ZipFile) -> dict[str, str]:
    result = {}
    for info in zip_file.infolist():
        if info.is_dir():
            continue
        safe_name = _safe_zip_member_name(info.filename)
        if safe_name:
            result.setdefault(safe_name, info.filename)
    return result


def _resource_path_candidates(manifest_path: str, resource_path: str) -> list[str]:
    resource = _safe_zip_member_name(resource_path)
    if not resource:
        return []
    base_dir = manifest_path.rsplit("/", 1)[0] if "/" in manifest_path else ""
    candidates = []
    if base_dir:
        candidates.append(_safe_zip_member_name(f"{base_dir}/{resource}"))
    candidates.append(resource)
    return list(dict.fromkeys(candidates))


def _zip_read_text(zip_file: zipfile.ZipFile, path: str, max_bytes: int = 1_000_000) -> str:
    info = zip_file.getinfo(path)
    if info.file_size > max_bytes:
        raise HTTPException(status_code=413, detail=f"扩展资源过大: {path}")
    return zip_file.read(path).decode("utf-8")


def _zip_read_base64(zip_file: zipfile.ZipFile, path: str, max_bytes: int = 5_000_000) -> str:
    info = zip_file.getinfo(path)
    if info.file_size > max_bytes:
        raise HTTPException(status_code=413, detail=f"扩展资源过大: {path}")
    return base64.b64encode(zip_file.read(path)).decode("ascii")


def _mime_for_extension_resource(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".js") or lower.endswith(".mjs"):
        return "text/javascript; charset=utf-8"
    if lower.endswith(".css"):
        return "text/css; charset=utf-8"
    if lower.endswith(".json"):
        return "application/json; charset=utf-8"
    if lower.endswith(".svg"):
        return "image/svg+xml"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".gif"):
        return "image/gif"
    if lower.endswith(".woff2"):
        return "font/woff2"
    if lower.endswith(".woff"):
        return "font/woff"
    return "application/octet-stream"


def _inline_extension_css_urls(css: str, assets: dict[str, Any], manifest_path: str, plugin_id: str = "") -> str:
    def replace_url(match):
        quote = match.group(1) or ""
        raw_url = str(match.group(2) or "").strip()
        if not raw_url or re.match(r"^(?:data:|blob:|https?:|/|#)", raw_url, re.I):
            return match.group(0)
        for candidate in _resource_path_candidates(manifest_path, raw_url):
            asset = assets.get(candidate)
            if isinstance(asset, dict) and isinstance(asset.get("base64"), str):
                mime = asset.get("mime") or _mime_for_extension_resource(candidate)
                return f'url("data:{mime};base64,{asset["base64"]}")'
        if plugin_id:
            encoded = "/".join(part for part in raw_url.split("/") if part and part not in {".", ".."})
            if encoded:
                return f'url("/api/plugins/{plugin_id}/asset/{encoded}")'
        return match.group(0)

    return re.sub(r"url\(\s*(['\"]?)([^)'\"\s]+)\1\s*\)", replace_url, str(css or ""), flags=re.I)


def _import_sillytavern_extension_zip(db: Session, content: bytes, source_name: str) -> Plugin:
    try:
        zip_file = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="无法读取扩展压缩包")

    # S-9 修复: zip 炸弹防护——条目总数与解压总量限制。
    infos = [info for info in zip_file.infolist() if not info.is_dir()]
    if len(infos) > _PLUGIN_IMPORT_MAX_ENTRIES:
        raise HTTPException(
            status_code=413,
            detail=f"ZIP 内文件数过多（最多 {_PLUGIN_IMPORT_MAX_ENTRIES} 个）",
        )
    total_uncompressed = sum(info.file_size for info in infos)
    if total_uncompressed > _PLUGIN_IMPORT_MAX_UNCOMPRESSED:
        raise HTTPException(
            status_code=413,
            detail=f"ZIP 解压总量过大（最多 {_PLUGIN_IMPORT_MAX_UNCOMPRESSED // (1024 * 1024)}MB）",
        )

    name_map = _zip_name_map(zip_file)
    manifest_paths = _candidate_manifest_paths(zip_file)
    if not manifest_paths:
        raise HTTPException(status_code=400, detail="压缩包中未找到 SillyTavern manifest.json")

    manifest_path = manifest_paths[0]
    manifest_zip_path = name_map.get(manifest_path, manifest_path)
    try:
        manifest = json.loads(_zip_read_text(zip_file, manifest_zip_path))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="manifest.json 不是有效的 UTF-8 JSON")

    if not _looks_like_sillytavern_extension_manifest(manifest):
        raise HTTPException(status_code=400, detail="manifest.json 不是可识别的 SillyTavern 扩展清单")

    resources: dict[str, Any] = {"js": [], "css": [], "templates": [], "modules": [], "assets": {}}
    for kind in ("css", "js"):
        for declared_path in _normalize_extension_resource_list(manifest.get(kind)):
            resolved_path = next((candidate for candidate in _resource_path_candidates(manifest_path, declared_path) if candidate in name_map), None)
            if not resolved_path:
                resources[kind].append({"path": declared_path, "missing": True})
                continue
            zip_path = name_map[resolved_path]
            resources[kind].append({
                "path": declared_path,
                "zip_path": resolved_path,
                "content": _zip_read_text(zip_file, zip_path),
            })

    referenced = set()
    for item in resources["css"] + resources["js"]:
        if item.get("zip_path"):
            referenced.add(item["zip_path"])
    referenced.add(manifest_path)
    for info in zip_file.infolist():
        if info.is_dir():
            continue
        path = _safe_zip_member_name(info.filename)
        if not path or path in referenced:
            continue
        if _is_extension_template_resource(path):
            try:
                resources["templates"].append({
                    "path": path,
                    "zip_path": path,
                    "content": _zip_read_text(zip_file, info.filename),
                })
            except UnicodeDecodeError:
                pass
            continue
        if _is_extension_js_module_resource(path):
            try:
                resources["modules"].append({
                    "path": path,
                    "zip_path": path,
                    "content": _zip_read_text(zip_file, info.filename),
                })
            except UnicodeDecodeError:
                pass
            continue
        if info.file_size > 5_000_000:
            continue
        resources["assets"][path] = {
            "mime": _mime_for_extension_resource(path),
            "base64": _zip_read_base64(zip_file, path),
        }

    plugin = _import_sillytavern_extension_manifest(db, manifest, source_name)
    for item in resources["css"]:
        if isinstance(item, dict) and isinstance(item.get("content"), str):
            item["content"] = _inline_extension_css_urls(item["content"], resources["assets"], manifest_path, plugin.id)
    config = _plugin_config(plugin)
    config.update({
        "resources": resources,
        "runtime": {
            **_safe_dict(config.get("runtime")),
            "enabled": True,
            "execute_scripts": True,
            "source": "zip",
        },
        "source_package": {
            "filename": source_name,
            "manifest_path": manifest_path,
        },
    })
    plugin.config = _json_config(config)
    plugin.source_data = json.dumps({"manifest": manifest, "package": config["source_package"]}, ensure_ascii=False)
    db.commit()
    db.refresh(plugin)
    return plugin


def _json_config(config: Optional[dict]) -> Optional[str]:
    return json.dumps(config, ensure_ascii=False) if config else None


def _merge_config(config: Optional[dict], **values) -> dict:
    merged = dict(config or {})
    merged.update({k: v for k, v in values.items() if v is not None})
    return merged


def _safe_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _safe_runtime_value(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return value
    return None


def _merge_extension_settings(target: dict, source: dict) -> dict:
    for key, value in source.items():
        if not isinstance(key, str) or not key:
            continue
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            merged = dict(target[key])
            merged.update(value)
            target[key] = merged
        else:
            target[key] = value
    return target


def _runtime_namespace_for_plugin(plugin: Plugin, config: dict) -> str:
    for source in (
        config.get("extension_name"),
        config.get("namespace"),
        config.get("id"),
        config.get("name"),
    ):
        if isinstance(source, str) and source.strip():
            return source.strip()
    manifest = config.get("manifest")
    if isinstance(manifest, dict):
        for source in (manifest.get("id"), manifest.get("name"), manifest.get("display_name")):
            if isinstance(source, str) and source.strip():
                return source.strip()
    return (plugin.name or plugin.id).strip()


def _effective_runtime_for_plugin(plugin: Plugin, runtime: dict[str, Any]) -> dict[str, Any]:
    result = dict(runtime or {})
    if plugin.plugin_type == "sillytavern_extension":
        explicitly_disabled = (
            result.get("execute_scripts") is False
            and (
                result.get("script_execution_overridden") is True
                or result.get("script_policy") in {"disabled", "manual_disabled"}
            )
        )
        if not explicitly_disabled:
            result["execute_scripts"] = True
            result.setdefault("script_policy", "sandbox")
    elif plugin.plugin_type == "tavern_helper":
        # tavern_helper 脚本（酒馆助手扩展）需在沙箱执行才能生效；
        # 导入时 global_runtime=False 只是阻止全局自动加载（已由 /runtime/config 的
        # tavern_helper 例外放行），这里强制 execute_scripts=True 使 content 真正下发。
        result["execute_scripts"] = True
        result.setdefault("script_policy", "sandbox")
        result.setdefault("enabled", True)
    return result


def _extension_loading_sort_key(payload: dict) -> tuple:
    """P0-1: 按 ST 1.18.0 loading_order 语义排序（extensions.js:49 sortManifestsByOrder）。

    ST 规则: parseInt(a.loading_order) - parseInt(b.loading_order) || display_name localeCompare。
    Palink 语义:
      - 有可解析 loading_order 的插件排前，按数值升序，数值相同按 display_name；
      - 无 loading_order 的插件（含非 ST 插件）排后，保持原 created_at 稳定顺序
        （Python sort 稳定，常量 key 不改变相对顺序）。
    """
    manifest = payload.get("manifest") if isinstance(payload.get("manifest"), dict) else {}
    raw_order = manifest.get("loading_order")
    try:
        order = int(str(raw_order).strip())
    except (TypeError, ValueError):
        return (1, 0, "")
    display_name = str(manifest.get("display_name") or payload.get("name") or "")
    return (0, order, display_name)


def _synthesize_tavern_helper_js_content(plugin: Plugin) -> Optional[str]:
    """tavern_helper 类型：脚本存在 plugin_scripts 表（不在 config.resources），
    按 loading 顺序把所有脚本用 IIFE 拼接成一个 js 入口（避免顶层 const/let 同名冲突）。
    与 _plugin_runtime_payload 的下发内容保持一致；无启用脚本时返回 None。
    """
    scripts = sorted(
        [
            s for s in (plugin.scripts or [])
            if s.enabled and s.script_type == "script" and s.content
        ],
        key=lambda s: s.order_no or 0,
    )
    if not scripts:
        return None
    return ";\n".join(
        f"(function(){{\n/* {s.script_name} */\n{s.content}\n}})();"
        for s in scripts
    )


def _plugin_runtime_payload(plugin: Plugin) -> dict:
    config = _plugin_config(plugin)
    manifest = _safe_dict(config.get("manifest"))
    if plugin.plugin_type == "sillytavern_extension" and not manifest:
        source_data = _load_json_object(plugin.source_data, {})
        manifest = _safe_dict(source_data)
    settings = _safe_dict(config.get("settings"))
    extension_settings = _safe_dict(config.get("extension_settings"))
    runtime = _effective_runtime_for_plugin(plugin, _safe_dict(config.get("runtime")))
    capabilities = _safe_runtime_value(config.get("capabilities"))
    resources = _safe_dict(config.get("resources"))
    assets = _safe_dict(resources.get("assets"))
    namespace = _runtime_namespace_for_plugin(plugin, config)
    # tavern_helper 类型：脚本存在 plugin_scripts 表（不在 config.resources），
    # 需映射进 resources.js 才能被前端沙箱加载执行。
    # 酒馆助手脚本是独立执行的（非模块关系），前端 load() 只执行单入口，
    # 因此把所有脚本用 IIFE 拼接成一个 js 入口，避免顶层 const/let 同名冲突。
    if plugin.plugin_type == "tavern_helper" and not resources.get("js"):
        combined_content = _synthesize_tavern_helper_js_content(plugin)
        if combined_content:
            resources = dict(resources)
            resources["js"] = [
                {
                    "path": "index.js",
                    "zip_path": "index.js",
                    "content": combined_content,
                    "missing": False,
                }
            ]
            # tavern_helper 无 ST manifest，构造最小清单让前端 load() 能识别入口
            if not manifest:
                manifest = {
                    "name": plugin.name,
                    "display_name": plugin.name,
                    "version": plugin.version or "1.0.0",
                    "js": "index.js",
                    "loading_order": 100,
                }
    if settings and namespace and namespace not in extension_settings:
        extension_settings = dict(extension_settings)
        extension_settings[namespace] = settings
    # P0-2: generate_interceptor 显式透传（ST extensions.js:2015-2040 契约）。
    # 前端沙箱在生成前按 loading_order 顺序调用 globalThis[generate_interceptor](chat, contextSize, abort, type)。
    generate_interceptor = manifest.get("generate_interceptor")
    if not (isinstance(generate_interceptor, str) and generate_interceptor.strip()):
        generate_interceptor = None
    return {
        "id": plugin.id,
        "name": plugin.name,
        "plugin_type": plugin.plugin_type,
        "version": plugin.version,
        "author": plugin.author,
        "source_type": plugin.source_type,
        "settings": settings,
        "manifest": manifest,
        "namespace": namespace,
        "generate_interceptor": generate_interceptor,
        "runtime": runtime,
        "capabilities": capabilities if capabilities is not None else {},
        "extension_settings": extension_settings,
        "resources": {
            "css": [
                {"path": item.get("path"), "content": item.get("content"), "missing": item.get("missing")}
                for item in resources.get("css", [])
                if isinstance(item, dict)
            ],
            "js": [
                {
                    "path": item.get("path"),
                    "zip_path": item.get("zip_path"),
                    "content": item.get("content") if runtime.get("execute_scripts") is True else None,
                    "missing": item.get("missing"),
                    "execute": runtime.get("execute_scripts") is True,
                }
                for item in resources.get("js", [])
                if isinstance(item, dict)
            ],
            "templates": [
                {"path": item.get("path"), "zip_path": item.get("zip_path"), "content": item.get("content"), "missing": item.get("missing")}
                for item in resources.get("templates", [])
                if isinstance(item, dict)
            ],
            "modules": [
                {"path": item.get("path"), "zip_path": item.get("zip_path"), "content": item.get("content"), "missing": item.get("missing")}
                for item in resources.get("modules", [])
                if isinstance(item, dict) and runtime.get("execute_scripts") is True
            ],
            "assets": [
                {"path": path, "mime": asset.get("mime")}
                for path, asset in assets.items()
                if isinstance(path, str) and isinstance(asset, dict)
            ],
        },
    }


def _import_sillytavern_extension_manifest(db: Session, data: dict, source_name: str) -> Plugin:
    name = data.get("display_name") or data.get("name") or data.get("id") or source_name
    config = {
        "manifest": data,
        "settings": {},
        "extension_settings": {},
        "runtime": {
            "enabled": True,
            "execute_scripts": True,
            "source": "manifest",
        },
        "capabilities": data.get("capabilities") if isinstance(data.get("capabilities"), (dict, list)) else {},
        "scope": "global",
        "global_runtime": True,
    }
    plugin = Plugin(
        id=str(uuid.uuid4()),
        name=str(name),
        plugin_type="sillytavern_extension",
        description=data.get("description") or "SillyTavern 第三方扩展清单",
        version=str(data.get("version")) if data.get("version") is not None else None,
        author=data.get("author") if isinstance(data.get("author"), str) else None,
        source_type="sillytavern_extension",
        source_data=json.dumps(data, ensure_ascii=False),
        enabled=True,
        config=_json_config(config),
    )
    db.add(plugin)
    db.commit()
    db.refresh(plugin)
    return plugin


def _regex_source_scope_from_config(config: Optional[dict], source_type: str) -> str:
    if config and isinstance(config.get("scope"), str):
        return config["scope"]
    if source_type == "character_card_extension":
        return "scoped"
    return "global"


def _normalize_regex_script(script: dict, index: int) -> dict:
    normalized = dict(script)
    normalized.setdefault("id", str(uuid.uuid4()))
    normalized.setdefault("scriptName", normalized.get("script_name") or f"Rule {index + 1}")
    normalized.setdefault("findRegex", normalized.get("find_regex") or normalized.get("find") or "")
    normalized.setdefault("replaceString", normalized.get("replace_string") or normalized.get("replace") or "")
    normalized.setdefault("trimStrings", normalized.get("trim_strings") or [])
    normalized.setdefault("placement", normalized.get("placement") or [1])
    normalized.setdefault("markdownOnly", normalized.get("markdown_only", False))
    normalized.setdefault("promptOnly", normalized.get("prompt_only", False))
    normalized.setdefault("runOnEdit", normalized.get("run_on_edit", False))
    normalized.setdefault("substituteRegex", normalized.get("substitute_regex", 0))
    normalized.setdefault("minDepth", normalized.get("min_depth"))
    normalized.setdefault("maxDepth", normalized.get("max_depth"))
    return normalized


def _normalize_regex_script_payload(data) -> list[dict]:
    raw_scripts = data if isinstance(data, list) else [data]
    result = []
    for index, script in enumerate(raw_scripts):
        if isinstance(script, dict):
            result.append(_normalize_regex_script(script, index))
    return result


def _load_json_object(raw, fallback):
    if raw is None or raw == "":
        return fallback
    if isinstance(raw, (dict, list)):
        return raw
    try:
        parsed = json.loads(raw)
        return parsed if parsed is not None else fallback
    except (json.JSONDecodeError, TypeError):
        return fallback


def _append_unique_regex_scripts(existing, incoming: list[dict]) -> list[dict]:
    existing_list = existing if isinstance(existing, list) else []
    seen = {
        (
            str(item.get("findRegex") or item.get("find_regex") or ""),
            str(item.get("replaceString") or item.get("replace_string") or ""),
            str(item.get("scriptName") or item.get("script_name") or ""),
        )
        for item in existing_list
        if isinstance(item, dict)
    }
    merged = list(existing_list)
    for script in incoming:
        signature = (
            str(script.get("findRegex") or ""),
            str(script.get("replaceString") or ""),
            str(script.get("scriptName") or ""),
        )
        if signature in seen:
            continue
        seen.add(signature)
        merged.append(script)
    return merged


def _install_regex_scripts_to_character(db: Session, character: Character, scripts: list[dict]) -> Character:
    extensions = _load_json_object(character.extensions, {})
    if not isinstance(extensions, dict):
        extensions = {}
    extensions["regex_scripts"] = _append_unique_regex_scripts(extensions.get("regex_scripts"), scripts)
    character.extensions = json.dumps(extensions, ensure_ascii=False)
    db.commit()
    db.refresh(character)
    return character


def _install_regex_scripts_to_character_preset(db: Session, character: Character, scripts: list[dict]) -> Character:
    preset_data = _load_json_object(character.preset_data, {})
    if not isinstance(preset_data, dict):
        preset_data = {}
    extensions = preset_data.get("extensions")
    if not isinstance(extensions, dict):
        extensions = {}
    extensions["regex_scripts"] = _append_unique_regex_scripts(extensions.get("regex_scripts"), scripts)
    preset_data["extensions"] = extensions
    character.preset_data = json.dumps(preset_data, ensure_ascii=False)
    db.commit()
    db.refresh(character)
    return character


def _is_character_card_extension_plugin(plugin: Plugin) -> bool:
    if plugin.source_type == "character_card_extension":
        return True
    if plugin.config:
        try:
            config = json.loads(plugin.config) if isinstance(plugin.config, str) else plugin.config
            if isinstance(config, dict) and config.get("character_card_extension") is True:
                return True
        except (json.JSONDecodeError, TypeError):
            pass
    if (
        plugin.plugin_type == "regex_scripts"
        and plugin.source_type == "sillytavern"
        and isinstance(plugin.name, str)
        and (plugin.name.endswith(" - 正则脚本") or plugin.name.endswith(" - 姝ｅ垯鑴氭湰"))
    ):
        return True
    return False


def _plugin_config(plugin: Optional[Plugin]) -> dict:
    if not plugin or not plugin.config:
        return {}
    try:
        parsed = json.loads(plugin.config) if isinstance(plugin.config, str) else plugin.config
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _plugin_scope(plugin: Optional[Plugin]) -> str:
    config = _plugin_config(plugin)
    if isinstance(config.get("scope"), str):
        return config["scope"]
    if plugin and plugin.source_type == "character_card_extension":
        return "scoped"
    return "global"


def _plugin_allows_global_runtime(plugin: Optional[Plugin]) -> bool:
    if not plugin:
        return False
    config = _plugin_config(plugin)
    if config.get("global_runtime") is False:
        return False
    return _plugin_scope(plugin) == "global" and not _is_character_card_extension_plugin(plugin)


def _script_to_regex_payload(s: PluginScript) -> dict:
    original = _script_original_data(s)
    payload = dict(original) if original else {}
    payload.setdefault("id", s.id)
    payload.setdefault("plugin_name", s.plugin.name if s.plugin else "")
    payload.setdefault("script_name", s.script_name)
    payload.setdefault("scriptName", s.script_name)
    payload.setdefault("findRegex", s.find_regex or "")
    payload.setdefault("replaceString", s.replace_string or "")
    payload.setdefault("placement", s.placement)
    payload.setdefault("markdownOnly", bool(s.markdown_only))
    payload.setdefault("promptOnly", bool(s.prompt_only))
    payload.setdefault("runOnEdit", bool(s.run_on_edit))
    payload.setdefault("substituteRegex", s.substitute_regex)
    payload.setdefault("minDepth", s.min_depth)
    payload.setdefault("maxDepth", s.max_depth)
    payload["find_regex"] = payload.get("findRegex", "")
    payload["replace_string"] = payload.get("replaceString", "")
    payload["markdown_only"] = payload.get("markdownOnly", False)
    payload["prompt_only"] = payload.get("promptOnly", False)
    payload["run_on_edit"] = payload.get("runOnEdit", False)
    payload["substitute_regex"] = payload.get("substituteRegex", 0)
    payload["min_depth"] = payload.get("minDepth")
    payload["max_depth"] = payload.get("maxDepth")
    payload["order"] = s.order_no
    payload["scope"] = _plugin_scope(s.plugin)
    return payload


def _import_regex_scripts(
    db: Session,
    data: list,
    source_name: str,
    *,
    source_type: str = "sillytavern",
    enabled: bool = True,
    config: Optional[dict] = None,
) -> Plugin:
    scope = _regex_source_scope_from_config(config, source_type)
    plugin_config = _merge_config(config, scope=scope)
    plugin = Plugin(
        id=str(uuid.uuid4()),
        name=source_name,
        plugin_type="regex_scripts",
        description=f"正则脚本插件，包含 {len(data)} 条规则",
        source_type=source_type,
        source_data=json.dumps(data, ensure_ascii=False),
        enabled=enabled,
        config=_json_config(plugin_config),
    )
    db.add(plugin)
    db.flush()
    for i, script in enumerate(data):
        if not isinstance(script, dict):
            continue
        normalized = _normalize_regex_script(script, i)
        ps = PluginScript(
            id=str(uuid.uuid4()),
            plugin_id=plugin.id,
            script_name=normalized.get("scriptName", f"Rule {i+1}"),
            script_type="regex",
            enabled=not bool(normalized.get("disabled", False)),
            content=json.dumps(normalized, ensure_ascii=False),
            find_regex=normalized.get("findRegex", ""),
            replace_string=normalized.get("replaceString", ""),
            trim_strings=json.dumps(normalized.get("trimStrings", []), ensure_ascii=False),
            placement=json.dumps(normalized.get("placement", [1]), ensure_ascii=False),
            markdown_only=bool(normalized.get("markdownOnly", False)),
            prompt_only=bool(normalized.get("promptOnly", False)),
            run_on_edit=bool(normalized.get("runOnEdit", False)),
            substitute_regex=int(normalized.get("substituteRegex", 0) or 0),
            min_depth=normalized.get("minDepth"),
            max_depth=normalized.get("maxDepth"),
            order_no=i,
        )
        db.add(ps)
    db.commit()
    db.refresh(plugin)
    return plugin


def _import_tavern_helper(
    db: Session,
    data: dict,
    source_name: str,
    *,
    source_type: str = "sillytavern",
    enabled: bool = True,
    config: Optional[dict] = None,
) -> Plugin:
    scripts_list = data.get("scripts", [])
    plugin = Plugin(
        id=str(uuid.uuid4()),
        name=source_name,
        plugin_type="tavern_helper",
        description=f"酒馆助手插件，包含 {len(scripts_list)} 个脚本",
        source_type=source_type,
        source_data=json.dumps(data, ensure_ascii=False)[:100000],
        enabled=enabled,
        config=_json_config(config),
    )
    db.add(plugin)
    db.flush()
    for i, script in enumerate(scripts_list):
        if not isinstance(script, dict):
            continue
        ps = PluginScript(
            id=str(uuid.uuid4()),
            plugin_id=plugin.id,
            script_name=script.get("name", f"Script {i+1}"),
            script_type=script.get("type", "script"),
            enabled=script.get("enabled", True),
            content=script.get("content", ""),
            order_no=i,
        )
        db.add(ps)
    db.commit()
    db.refresh(plugin)
    return plugin


def _import_preset(db: Session, data, source_name: str) -> Plugin:
    if isinstance(data, list) and len(data) > 0:
        data = data[0]
    prompts = data.get("prompts", [])
    plugin = Plugin(
        id=str(uuid.uuid4()),
        name=data.get("name", source_name),
        plugin_type="preset",
        description=f"推进预设，包含 {len(prompts)} 条提示词",
        source_type="sillytavern",
        source_data=json.dumps(data, ensure_ascii=False),
        enabled=True,
    )
    db.add(plugin)
    db.flush()
    for i, prompt in enumerate(prompts):
        if not isinstance(prompt, dict):
            continue
        ps = PluginScript(
            id=str(uuid.uuid4()),
            plugin_id=plugin.id,
            script_name=prompt.get("name", f"Prompt {i+1}"),
            script_type="preset_prompt",
            enabled=prompt.get("enabled", True) if prompt.get("enabled") is not None else True,
            content=prompt.get("content", ""),
            find_regex=None,
            replace_string=None,
            order_no=i,
        )
        db.add(ps)
    db.commit()
    db.refresh(plugin)
    return plugin


def _import_chatsheets(db: Session, data: dict, source_name: str) -> Plugin:
    mate = data.get("mate", {})
    version = mate.get("version", 1)
    sheet_keys = [k for k in data.keys() if k.startswith("sheet_")]
    plugin = Plugin(
        id=str(uuid.uuid4()),
        name=source_name,
        plugin_type="chatsheets",
        description=f"chatSheets v{version} 表格模板，包含 {len(sheet_keys)} 个表",
        version=str(version),
        source_type="sillytavern",
        source_data=json.dumps(data, ensure_ascii=False),
        enabled=True,
        config=json.dumps(mate, ensure_ascii=False),
    )
    db.add(plugin)
    db.flush()
    for i, sheet_key in enumerate(sheet_keys):
        sheet = data[sheet_key]
        if not isinstance(sheet, dict):
            continue
        ps = PluginScript(
            id=str(uuid.uuid4()),
            plugin_id=plugin.id,
            script_name=sheet.get("name", sheet_key),
            script_type="chatsheet",
            enabled=True,
            content=json.dumps(sheet, ensure_ascii=False),
            order_no=sheet.get("orderNo", i),
        )
        db.add(ps)
    db.commit()
    db.refresh(plugin)
    return plugin


def _import_from_character_card_extensions(db: Session, data: dict, source_name: str) -> list:
    plugins = []
    char_data = data.get("data", data)
    extensions = char_data.get("extensions", {})
    if not isinstance(extensions, dict):
        extensions = {}

    if extensions.get("regex_scripts") and isinstance(extensions["regex_scripts"], list):
        p = _import_regex_scripts(
            db,
            extensions["regex_scripts"],
            f"{source_name} - 正则脚本",
            source_type="character_card_extension",
            enabled=False,
            config={"character_card_extension": True, "global_runtime": False},
        )
        plugins.append(p)

    if extensions.get("tavern_helper") and isinstance(extensions["tavern_helper"], dict):
        p = _import_tavern_helper(
            db,
            extensions["tavern_helper"],
            f"{source_name} - 酒馆助手",
            source_type="character_card_extension",
            enabled=False,
            config={"character_card_extension": True, "global_runtime": False},
        )
        plugins.append(p)

    return plugins


@router.get("")
async def list_plugins(
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    plugins = db.query(Plugin).order_by(Plugin.created_at.desc()).all()
    return [_plugin_to_dict(p) for p in plugins]


# ── runtime/config 缓存与 HTTP 协商缓存 ─────────────────────────────
_RUNTIME_CONFIG_CACHE_PREFIX = "plugin_runtime_config"


def _invalidate_runtime_config_cache() -> None:
    """插件 CRUD / 启用状态 / 配置变更后清除 runtime config 拼装缓存。"""
    invalidate_cache(_RUNTIME_CONFIG_CACHE_PREFIX)


def _runtime_config_etag(payload: dict) -> str:
    """基于拼装 payload（排除动态 generated_at）计算稳定强 ETag。

    插件内容未变化时 ETag 保持不变，浏览器可用 If-None-Match 命中 304，
    弱网下二次进入对话无需重新下载全部插件代码。
    """
    stable = {k: v for k, v in payload.items() if k != "generated_at"}
    digest = hashlib.sha256(
        json.dumps(stable, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()
    return f'"{digest[:32]}"'


def _etag_matches(client_header: str | None, current_etag: str) -> bool:
    """比较 If-None-Match 与当前 ETag，兼容 nginx gzip 的弱校验 W/ 前缀。

    nginx 对 gzip 响应会把强 ETag 改写为弱校验 W/"..."；浏览器随后原样
    回传 W/"..."，若不剥离前缀则永远匹配不上、每次全量返回 200。
    """
    if not client_header:
        return False
    current = current_etag.strip().strip('"')
    for part in client_header.split(","):
        part = part.strip()
        if part.startswith("W/"):
            part = part[2:].strip()
        if part.strip().strip('"') == current:
            return True
    return False


@cached(ttl_seconds=30, key_prefix=_RUNTIME_CONFIG_CACHE_PREFIX)
def _build_sillytavern_runtime_config(db: Session, user_id: int | None = None) -> dict:
    """拼装启用插件的 runtime payload（30s 内存缓存，插件 CRUD 时失效）。

    [A-7 多租户插件隔离] runtime config 按用户作用域隔离：
    - 插件 user_id IS NULL（全局插件）对所有用户可见；
    - 插件 user_id == 当前用户 仅该用户可见；
    - 其他用户的插件不在此用户的 runtime 中。
    单用户部署下存量插件全部为 NULL，行为与改造前完全一致（当前用户即全部）。
    缓存键含 user_id（_build_key 对 int 参数自动入键），多用户互不串扰；
    插件 CRUD 时 invalidate_cache(prefix) 仍能清掉全部用户变体。
    """
    scope_filter = or_(Plugin.user_id == user_id, Plugin.user_id.is_(None))
    plugins = (
        db.query(Plugin)
        .filter(Plugin.enabled == True, scope_filter)
        .order_by(Plugin.created_at.asc())
        .all()
    )
    runtime_plugins = []
    extension_settings: dict[str, Any] = {}

    for plugin in plugins:
        # [CARD-EXT-SCOPE-GUARD] 卡内扩展来源插件禁止下发至前端全局运行时。
        # ST 对照（frontend/public/st/）：ST 核心不存在"卡内脚本提升为全局扩展"的路径
        # ——卡内 tavern_helper 脚本由酒馆助手随卡执行；卡内正则走 GLOBAL/SCOPED/PRESET
        # 三层挂载且 scoped 默认拒绝、需按角色显式授权（regex/engine.js getScriptsByType
        # 的 allowedOnly + character_allowed_regex 白名单）。Palink 的"导入卡内扩展为
        # 全局插件"缺少这条作用域边界：2026-08-21 实测泄漏——「酒馆助手」插件
        # （source_type=character_card_extension）将 BubbleDialogue 注入脚本常驻下发至
        # 所有角色，模型对无配套渲染正则的卡输出 @bubble 原始标记。复用现成三重判定
        # 函数（source_type / config 标记 / regex_scripts 命名模式）拦截，置于循环首位，
        # 优先于下方 tavern_helper 的 global_runtime 绕过逻辑。
        if _is_character_card_extension_plugin(plugin):
            continue
        config = _plugin_config(plugin)
        # tavern_helper 类型绑定角色卡扩展，不走 global_runtime 开关，
        # 它的脚本需要在角色扮演时下发到前端沙箱执行（否则酒馆助手脚本永远不生效）。
        if config.get("global_runtime") is False and plugin.plugin_type != "tavern_helper":
            continue
        if config.get("runtime") is False:
            continue
        if isinstance(config.get("runtime"), dict) and config["runtime"].get("enabled") is False:
            continue

        payload = _plugin_runtime_payload(plugin)
        runtime_plugins.append(payload)
        _merge_extension_settings(extension_settings, _safe_dict(payload.get("extension_settings")))

    # P0-1: 按 ST loading_order 语义排序下发（前端须按此顺序注入 JS）。
    runtime_plugins.sort(key=_extension_loading_sort_key)

    # P0-2: 生成拦截器有序清单（仅 execute_scripts 生效的插件）。
    # 前端沙箱在每次生成前按此顺序调用 globalThis[function](chat, contextSize, abort, type)，
    # 并将结果通过 chat_request.interceptor_result 回传后端（见 docs/st_plugin_frontend_bridge_protocol.md）。
    generation_interceptors = [
        {
            "plugin_id": payload["id"],
            "namespace": payload.get("namespace") or payload.get("name") or payload["id"],
            "function": payload["generate_interceptor"],
        }
        for payload in runtime_plugins
        if payload.get("generate_interceptor")
        and _safe_dict(payload.get("runtime")).get("execute_scripts") is True
    ]

    return {
        "plugins": runtime_plugins,
        "extension_settings": extension_settings,
        "generation_interceptors": generation_interceptors,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/runtime/config")
async def get_sillytavern_runtime_config(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return enabled plugin runtime payloads for smart-card rendering.

    Security note: This endpoint is intentionally accessible to all authenticated
    users because the frontend (CharacterCardRenderer, SillyTavernPluginRuntime)
    needs plugin runtime data (CSS/JS resources, extension_settings, manifest) to
    render smart-card content. Do NOT store raw secrets (API keys, passwords) in
    plugin extension_settings — use environment variables or the encrypted
    provider config instead.

    响应带强 ETag + Cache-Control(private, max-age=300)：插件内容未变时浏览器
    二次请求直接 304，弱网下不再重复下载全部插件代码。
    """
    payload = _build_sillytavern_runtime_config(db, user.id)
    etag = _runtime_config_etag(payload)
    headers = {
        "Cache-Control": "private, max-age=300",
        "ETag": etag,
        "Vary": "Authorization",
    }
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=payload, headers=headers)


@router.get("/{plugin_id}")
async def get_plugin(
    plugin_id: str,
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    plugin = db.query(Plugin).filter(Plugin.id == plugin_id).first()
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")
    result = _plugin_to_dict(plugin)
    result["scripts"] = [_script_to_dict(s) for s in (plugin.scripts or [])]
    return result


@router.post("/import")
async def import_plugin(
    file: UploadFile = File(...),
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    # S-9 修复: 限流读取上传文件（替代 file.read() 无上限）
    content = await _read_upload_limited(file)
    source_name = file.filename or "Unknown"
    if source_name.lower().endswith(".zip"):
        plugin = _import_sillytavern_extension_zip(db, content, source_name)
        _invalidate_runtime_config_cache()
        return {"message": "SillyTavern 扩展包导入成功", "plugin": _plugin_to_dict(plugin)}

    try:
        data = json.loads(content.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid JSON file")

    plugin_type = _detect_plugin_type(data)

    if plugin_type == "regex_scripts":
        plugin = _import_regex_scripts(db, data, source_name)
        _invalidate_runtime_config_cache()
        return {"message": "正则脚本插件导入成功", "plugin": _plugin_to_dict(plugin)}
    elif plugin_type == "tavern_helper":
        plugin = _import_tavern_helper(db, data, source_name)
        _invalidate_runtime_config_cache()
        return {"message": "酒馆助手插件导入成功", "plugin": _plugin_to_dict(plugin)}
    elif plugin_type == "preset":
        plugin = _import_preset(db, data, source_name)
        _invalidate_runtime_config_cache()
        return {"message": "预设插件导入成功", "plugin": _plugin_to_dict(plugin)}
    elif plugin_type == "chatsheets":
        plugin = _import_chatsheets(db, data, source_name)
        _invalidate_runtime_config_cache()
        return {"message": "表格模板导入成功", "plugin": _plugin_to_dict(plugin)}
    elif plugin_type == "sillytavern_extension":
        plugin = _import_sillytavern_extension_manifest(db, data, source_name)
        _invalidate_runtime_config_cache()
        return {"message": "SillyTavern 扩展清单导入成功", "plugin": _plugin_to_dict(plugin)}
    elif plugin_type == "character_card":
        plugins = _import_from_character_card_extensions(db, data, source_name)
        if plugins:
            _invalidate_runtime_config_cache()
            return {"message": f"角色卡插件导入成功，共 {len(plugins)} 个插件", "plugins": [_plugin_to_dict(p) for p in plugins]}
        else:
            return {"message": "角色卡中未发现可导入的插件（正则脚本/酒馆助手）"}
    elif plugin_type == "regex_script_single":
        plugin = _import_regex_scripts(db, [data], source_name)
        _invalidate_runtime_config_cache()
        return {"message": "正则脚本导入成功", "plugin": _plugin_to_dict(plugin)}
    else:
        raise HTTPException(status_code=400, detail=f"无法识别的文件格式。检测到的类型: {plugin_type}")


@router.get("/{plugin_id}/asset/{asset_path:path}")
async def get_plugin_asset(
    plugin_id: str,
    asset_path: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # [A-7 多租户插件隔离] 资源访问同样按用户作用域过滤
    plugin = db.query(Plugin).filter(
        Plugin.id == plugin_id,
        Plugin.enabled == True,
        or_(Plugin.user_id == user.id, Plugin.user_id.is_(None)),
    ).first()
    if not plugin:
        raise HTTPException(status_code=404, detail="插件不存在或已禁用")
    config = _plugin_config(plugin)
    resources = _safe_dict(config.get("resources"))
    assets = _safe_dict(resources.get("assets"))
    key = _safe_zip_member_name(asset_path)
    asset = assets.get(key)
    if not isinstance(asset, dict) or not isinstance(asset.get("base64"), str):
        raise HTTPException(status_code=404, detail="插件资源不存在")
    try:
        content = base64.b64decode(asset["base64"])
    except Exception:
        raise HTTPException(status_code=500, detail="插件资源损坏")
    return Response(
        content=content,
        media_type=asset.get("mime") or _mime_for_extension_resource(key),
        headers={
            "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{plugin_id}/source/{source_path:path}")
async def get_plugin_script_source(
    plugin_id: str,
    source_path: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """返回插件 js/modules 源码，带强 ETag + 协商缓存。

    [P1-SRCDOC-SLIM] 智能卡插件脚本「源码 HTTP 化」：父页面按 URL 定位插件源码
    （不再把 ~4.4MB 内容随 postMessage 全量推送），iframe 按需向父页面取内容，
    父页面经本端点走浏览器/服务端 HTTP 缓存，插件未变化时 304 免重复下载。
    仅匹配 resources.js / resources.modules（zip 解包得到的源码成员），
    不暴露 assets（含 base64 的二进制资源走 /{plugin_id}/asset/{path}）。
    """
    plugin = db.query(Plugin).filter(
        Plugin.id == plugin_id,
        Plugin.enabled == True,
        or_(Plugin.user_id == user.id, Plugin.user_id.is_(None)),
    ).first()
    if not plugin:
        raise HTTPException(status_code=404, detail="插件不存在或已禁用")
    config = _plugin_config(plugin)
    resources = _safe_dict(config.get("resources"))
    key = _safe_zip_member_name(source_path)
    for kind in ("js", "modules"):
        items = resources.get(kind)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            candidate = _safe_zip_member_name(str(item.get("zip_path") or item.get("path") or ""))
            if candidate != key or not isinstance(item.get("content"), str):
                continue
            content = item["content"].encode("utf-8")
            etag = f'"{hashlib.sha1(content).hexdigest()}"'
            headers = {
                "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
                "X-Content-Type-Options": "nosniff",
                "ETag": etag,
            }
            if _etag_matches(request.headers.get("if-none-match"), etag):
                return Response(status_code=304, headers=headers)
            return Response(
                content=content,
                media_type="application/javascript",
                headers=headers,
            )
    # tavern_helper 类型：js 由 plugin_scripts 表动态合成（config.resources.js 为空），
    # 与 _plugin_runtime_payload 下发内容一致，命中 index.js 时按同一逻辑合成。
    if key == "index.js" and plugin.plugin_type == "tavern_helper":
        combined_content = _synthesize_tavern_helper_js_content(plugin)
        if combined_content:
            content = combined_content.encode("utf-8")
            etag = f'"{hashlib.sha1(content).hexdigest()}"'
            headers = {
                "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
                "X-Content-Type-Options": "nosniff",
                "ETag": etag,
            }
            if _etag_matches(request.headers.get("if-none-match"), etag):
                return Response(status_code=304, headers=headers)
            return Response(
                content=content,
                media_type="application/javascript",
                headers=headers,
            )
    raise HTTPException(status_code=404, detail="插件脚本源码不存在")


@router.post("/import/regex-target")
async def import_regex_to_target(
    payload: RegexImportPayload,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    scripts = _normalize_regex_script_payload(payload.scripts)
    if not scripts:
        raise HTTPException(status_code=422, detail="没有可导入的正则脚本")

    target = (payload.target or "global").strip().lower()
    if target == "global":
        if user.role != "admin":
            raise HTTPException(status_code=403, detail="只有管理员可以导入全局正则脚本")
        plugin = _import_regex_scripts(
            db,
            scripts,
            payload.preset_name or "Imported Regex Scripts",
            source_type="sillytavern",
            enabled=True,
            config={"scope": "global", "global_runtime": True},
        )
        invalidate_regex_pattern_cache()
        _invalidate_runtime_config_cache()
        return {"status": "ok", "target": "global", "plugin": _plugin_to_dict(plugin)}

    if target not in {"scoped", "preset"}:
        raise HTTPException(status_code=422, detail="target 必须是 global、scoped 或 preset")

    if not payload.character_id:
        raise HTTPException(status_code=422, detail="导入到角色或预设时必须提供 character_id")

    character = db.query(Character).filter(
        Character.id == payload.character_id,
        Character.user_id == user.id,
    ).first()
    if not character:
        raise HTTPException(status_code=404, detail="角色不存在")

    if target == "scoped":
        _install_regex_scripts_to_character(db, character, scripts)
        invalidate_regex_pattern_cache()
        _invalidate_runtime_config_cache()
        return {"status": "ok", "target": "scoped", "character_id": character.id, "count": len(scripts)}

    _install_regex_scripts_to_character_preset(db, character, scripts)
    invalidate_regex_pattern_cache()
    _invalidate_runtime_config_cache()
    return {"status": "ok", "target": "preset", "character_id": character.id, "count": len(scripts)}


@router.put("/{plugin_id}/toggle")
async def toggle_plugin(
    plugin_id: str,
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    plugin = db.query(Plugin).filter(Plugin.id == plugin_id).first()
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")
    plugin.enabled = not plugin.enabled
    plugin.updated_at = datetime.now(timezone.utc)
    db.commit()
    _invalidate_runtime_config_cache()
    return {"message": f"插件已{'启用' if plugin.enabled else '禁用'}", "enabled": plugin.enabled}


@router.patch("/{plugin_id}/config")
async def update_plugin_config(
    plugin_id: str,
    payload: PluginConfigPatchPayload,
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    plugin = db.query(Plugin).filter(Plugin.id == plugin_id).first()
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")

    config = _plugin_config(plugin)
    if payload.config is not None:
        allowed_keys = {
            "scope",
            "global_runtime",
            "settings",
            "extension_settings",
            "manifest",
            "runtime",
            "capabilities",
            "namespace",
            "extension_name",
        }
        config.update({k: v for k, v in payload.config.items() if k in allowed_keys})
        runtime_config = config.get("runtime")
        if isinstance(runtime_config, dict) and "execute_scripts" in runtime_config:
            runtime_config["script_execution_overridden"] = True
    if payload.settings is not None:
        config["settings"] = payload.settings
    if payload.extension_settings is not None:
        config["extension_settings"] = payload.extension_settings
    if payload.manifest is not None:
        config["manifest"] = payload.manifest
    if payload.runtime is not None:
        config["runtime"] = payload.runtime
        if isinstance(config["runtime"], dict) and "execute_scripts" in config["runtime"]:
            config["runtime"]["script_execution_overridden"] = True
    if payload.capabilities is not None:
        config["capabilities"] = payload.capabilities
    if payload.scope is not None:
        scope = payload.scope.strip().lower()
        if scope not in {"global", "scoped", "preset"}:
            raise HTTPException(status_code=422, detail="scope 必须是 global、scoped 或 preset")
        config["scope"] = scope
    if payload.global_runtime is not None:
        config["global_runtime"] = payload.global_runtime
    if payload.description is not None:
        plugin.description = payload.description
    if payload.version is not None:
        plugin.version = payload.version
    if payload.author is not None:
        plugin.author = payload.author

    plugin.config = _json_config(config)
    plugin.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(plugin)
    _invalidate_runtime_config_cache()
    return {"message": "插件设置已保存", "plugin": _plugin_to_dict(plugin)}


@router.put("/{plugin_id}/scripts/{script_id}/toggle")
async def toggle_script(
    plugin_id: str,
    script_id: str,
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    script = db.query(PluginScript).filter(
        PluginScript.plugin_id == plugin_id,
        PluginScript.id == script_id,
    ).first()
    if not script:
        raise HTTPException(status_code=404, detail="Script not found")
    script.enabled = not script.enabled
    db.commit()
    _invalidate_runtime_config_cache()
    return {"message": f"脚本已{'启用' if script.enabled else '禁用'}", "enabled": script.enabled}


@router.delete("/{plugin_id}")
async def delete_plugin(
    plugin_id: str,
    user: User = Depends(get_admin),
    db: Session = Depends(get_db),
):
    plugin = db.query(Plugin).filter(Plugin.id == plugin_id).first()
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")
    db.query(PluginScript).filter(PluginScript.plugin_id == plugin_id).delete()
    db.delete(plugin)
    db.commit()
    _invalidate_runtime_config_cache()
    return {"message": "插件已删除"}


@router.get("/active/regex")
async def get_active_regex_scripts(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # [A-7 多租户插件隔离] 正则脚本同样按用户作用域过滤（NULL=全局 + 本人）
    scripts = db.query(PluginScript).join(Plugin).filter(
        Plugin.enabled == True,
        or_(Plugin.user_id == user.id, Plugin.user_id.is_(None)),
        PluginScript.enabled == True,
        PluginScript.script_type == "regex",
        PluginScript.find_regex != None,
    ).order_by(PluginScript.order_no).all()
    result = []
    for s in scripts:
        if not _plugin_allows_global_runtime(s.plugin):
            continue
        result.append(_script_to_regex_payload(s))
    return result


@router.api_route(
    "/{plugin_id}/{endpoint_path:path}",
    methods=["GET", "POST", "PUT", "DELETE"],
)
async def call_plugin_endpoint(
    plugin_id: str,
    endpoint_path: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    插件端点 fallback 路由。

    插件通过 registerEndpoint 注册的 HTTP 端点 handler 在前端沙箱中执行，
    后端无法直接调用。此路由作为 fallback，仅当请求未在前端拦截时触发。

    正常流程：前端 bridge.js 拦截 /api/plugins/{plugin_id}/{endpoint_path} 请求，
    调用前端注册的 handler。此路由返回 404 提示端点未在前端注册或需通过前端调用。
    """
    plugin = db.query(Plugin).filter(Plugin.id == plugin_id).first()
    if not plugin:
        raise HTTPException(status_code=404, detail="插件不存在")
    raise HTTPException(
        status_code=404,
        detail=(
            f"端点 /api/plugins/{plugin_id}/{endpoint_path} 未注册。"
            "插件端点需在前端通过 registerEndpoint 注册，并由前端 fetch 拦截层调用。"
        ),
    )
