"""Regex Scripts API routes — CRUD + import for SillyTavern-compatible regex scripts."""
import json
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db
from ..api.dependencies import get_current_user
from ..models import User
from ..models.regex_script import RegexScript
# 正则脚本写入时清除 character_ext 中的预编译缓存，避免使用过期模式
from .character_ext import invalidate_regex_pattern_cache

router = APIRouter(prefix="/api/regex-scripts", tags=["regex-scripts"])


def _utc_now():
    return datetime.now(timezone.utc)


def _parse_json_array(raw: Optional[str], default=None):
    if default is None:
        default = []
    if not raw:
        return default
    try:
        result = json.loads(raw)
        return result if isinstance(result, list) else default
    except (json.JSONDecodeError, TypeError):
        return default


class RegexScriptCreateRequest(BaseModel):
    scriptName: str = Field(..., max_length=255)
    findRegex: str
    replaceString: str = ""
    trimStrings: List[str] = []
    placement: List[int] = []
    disabled: bool = False
    markdownOnly: bool = False
    promptOnly: bool = False
    runOnEdit: bool = False
    substituteRegex: int = 0
    minDepth: Optional[int] = None
    maxDepth: Optional[int] = None
    order: int = 0
    isScope: bool = False
    scopeId: Optional[str] = None


class RegexScriptUpdateRequest(BaseModel):
    scriptName: Optional[str] = Field(default=None, max_length=255)
    findRegex: Optional[str] = None
    replaceString: Optional[str] = None
    trimStrings: Optional[List[str]] = None
    placement: Optional[List[int]] = None
    disabled: Optional[bool] = None
    markdownOnly: Optional[bool] = None
    promptOnly: Optional[bool] = None
    runOnEdit: Optional[bool] = None
    substituteRegex: Optional[int] = None
    minDepth: Optional[int] = None
    maxDepth: Optional[int] = None
    order: Optional[int] = None
    isScope: Optional[bool] = None
    scopeId: Optional[str] = None


class RegexScriptImportRequest(BaseModel):
    scripts: List[RegexScriptCreateRequest]
    scopeId: Optional[str] = None


def _script_to_dict(s: RegexScript) -> dict:
    return {
        "id": s.id,
        "scriptName": s.name,
        "findRegex": s.find_regex,
        "replaceString": s.replace_string,
        "trimStrings": _parse_json_array(s.trim_strings),
        "placement": _parse_json_array(s.placement),
        "disabled": bool(s.disabled),
        "markdownOnly": bool(s.markdown_only),
        "promptOnly": bool(s.prompt_only),
        "runOnEdit": bool(s.run_on_edit),
        "substituteRegex": int(s.substitute_regex or 0),
        "minDepth": s.min_depth,
        "maxDepth": s.max_depth,
        "order": int(s.order or 0),
        "isScope": bool(s.is_scope),
        "scopeId": s.scope_id,
        "createdAt": s.created_at.isoformat() if s.created_at else None,
        "updatedAt": s.updated_at.isoformat() if s.updated_at else None,
    }


@router.get("")
def list_regex_scripts(
    scope_id: Optional[str] = Query(default=None, description="按 scope_id 过滤"),
    is_scope: Optional[bool] = Query(default=None, description="是否仅返回 scoped 脚本"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(RegexScript).filter(RegexScript.user_id == user.id)
    if scope_id is not None:
        q = q.filter(RegexScript.scope_id == scope_id)
    if is_scope is not None:
        q = q.filter(RegexScript.is_scope == is_scope)
    scripts = q.order_by(RegexScript.order.asc(), RegexScript.created_at.asc()).all()
    return [_script_to_dict(s) for s in scripts]


@router.post("")
def create_regex_script(
    req: RegexScriptCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = RegexScript(
        user_id=user.id,
        name=req.scriptName,
        find_regex=req.findRegex,
        replace_string=req.replaceString,
        trim_strings=json.dumps(req.trimStrings, ensure_ascii=False) if req.trimStrings else None,
        placement=json.dumps(req.placement, ensure_ascii=False) if req.placement else None,
        disabled=req.disabled,
        markdown_only=req.markdownOnly,
        prompt_only=req.promptOnly,
        run_on_edit=req.runOnEdit,
        substitute_regex=req.substituteRegex,
        min_depth=req.minDepth,
        max_depth=req.maxDepth,
        order=req.order,
        is_scope=req.isScope,
        scope_id=req.scopeId,
        created_at=_utc_now(),
        updated_at=_utc_now(),
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    invalidate_regex_pattern_cache()
    return _script_to_dict(s)


@router.put("/{script_id}")
def update_regex_script(
    script_id: str,
    req: RegexScriptUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = db.query(RegexScript).filter(
        RegexScript.id == script_id,
        RegexScript.user_id == user.id,
    ).first()
    if not s:
        raise HTTPException(404, "Regex script not found")

    if req.scriptName is not None:
        s.name = req.scriptName
    if req.findRegex is not None:
        s.find_regex = req.findRegex
    if req.replaceString is not None:
        s.replace_string = req.replaceString
    if req.trimStrings is not None:
        s.trim_strings = json.dumps(req.trimStrings, ensure_ascii=False) if req.trimStrings else None
    if req.placement is not None:
        s.placement = json.dumps(req.placement, ensure_ascii=False) if req.placement else None
    if req.disabled is not None:
        s.disabled = req.disabled
    if req.markdownOnly is not None:
        s.markdown_only = req.markdownOnly
    if req.promptOnly is not None:
        s.prompt_only = req.promptOnly
    if req.runOnEdit is not None:
        s.run_on_edit = req.runOnEdit
    if req.substituteRegex is not None:
        s.substitute_regex = req.substituteRegex
    if req.minDepth is not None:
        s.min_depth = req.minDepth
    if req.maxDepth is not None:
        s.max_depth = req.maxDepth
    if req.order is not None:
        s.order = req.order
    if req.isScope is not None:
        s.is_scope = req.isScope
    if req.scopeId is not None:
        s.scope_id = req.scopeId
    s.updated_at = _utc_now()
    db.commit()
    db.refresh(s)
    invalidate_regex_pattern_cache()
    return _script_to_dict(s)


@router.delete("/{script_id}")
def delete_regex_script(
    script_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = db.query(RegexScript).filter(
        RegexScript.id == script_id,
        RegexScript.user_id == user.id,
    ).first()
    if not s:
        raise HTTPException(404, "Regex script not found")
    db.delete(s)
    db.commit()
    invalidate_regex_pattern_cache()
    return {"ok": True}


@router.post("/import")
def import_regex_scripts(
    req: RegexScriptImportRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    created = []
    now = _utc_now()
    for item in req.scripts:
        scope_id = item.scopeId if item.scopeId is not None else req.scopeId
        is_scope = item.isScope or (scope_id is not None)
        s = RegexScript(
            user_id=user.id,
            name=item.scriptName,
            find_regex=item.findRegex,
            replace_string=item.replaceString,
            trim_strings=json.dumps(item.trimStrings, ensure_ascii=False) if item.trimStrings else None,
            placement=json.dumps(item.placement, ensure_ascii=False) if item.placement else None,
            disabled=item.disabled,
            markdown_only=item.markdownOnly,
            prompt_only=item.promptOnly,
            run_on_edit=item.runOnEdit,
            substitute_regex=item.substituteRegex,
            min_depth=item.minDepth,
            max_depth=item.maxDepth,
            order=item.order,
            is_scope=is_scope,
            scope_id=scope_id,
            created_at=now,
            updated_at=now,
        )
        db.add(s)
        created.append(s)
    db.commit()
    for s in created:
        db.refresh(s)
    invalidate_regex_pattern_cache()
    return {"imported": len(created), "scripts": [_script_to_dict(s) for s in created]}
