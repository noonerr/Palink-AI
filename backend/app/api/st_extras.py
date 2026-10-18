"""ST Extras 兼容端点（包 C · 2026-10-18）。

## 为什么有这个文件

ST 生态里 caption / expressions / translate / vectors / memory 这批插件依赖 ST 的
**Extras 后端面**。Palink 此前这块基本是空的，实测（2026-10-18，带 CSRF token 探测）：

    POST /api/extra/caption            -> 404
    POST /api/extra/classify           -> 404
    POST /api/extra/classify/labels    -> 404
    GET  /api/sprites/get              -> 404
    POST /api/sprites/delete           -> 404
    POST /api/backends/kobold/embed    -> 404

另有四条路由（``/api/summarize`` / ``/api/translate`` / ``/api/translate/{provider}`` /
``/api/extra/translate``）虽然注册了，但实现是 ``_forward_extensions_to_st_native``
转发到 ST sidecar —— sidecar 已随 st-native 双轨删除，且容器里
``ST_NATIVE_SERVICE_URL`` 实测为空串 ⇒ **无条件 502**，插件侧等价于不可用。
本次把这四条一并迁到本文件并换成真实实现（见 ``_translate_text``）。

## 实现原则

1. **不造假**：拿不到就返回可操作的错误，绝不返回伪造的"成功"响应。
   插件的失败路径比静默垃圾数据更有用。
2. **复用既有能力，不新建一套**：表情/精灵图复用 ``api/expressions.py`` 的
   ``CharacterExpression`` 表与 ``data/characters/{cid}/expressions`` 目录；
   嵌入复用 ``memory_module.embedder.embed_text``（ollama bge-m3，1024 维）。
3. **认证与 CSRF 与同族端点一致**：沿用 ``get_st_current_user``，router 在
   ``api/__init__.py`` 里统一挂 ``csrf_guard``。

## 契约来源（逐条对照插件源码，勿凭记忆改）

- ``st-plugins/caption/index.js:274``     POST ``{image}`` → ``{caption}``
- ``st-plugins/expressions/index.js:1062`` POST ``{text}`` → ``{classification:[{label}]}``
- ``st-plugins/expressions/index.js:1445`` POST → ``{labels:[...]}``
- ``st-plugins/expressions/index.js:1295`` GET ``?name=`` → ``[{label, path}]``
- ``st-plugins/expressions/index.js:901``  POST multipart ``name,label,avatar,spriteName``
- ``st-plugins/expressions/index.js:2032`` POST multipart ``name,avatar``(zip) → ``{count}``
- ``st-plugins/expressions/index.js:2072`` POST ``{name,label,spriteName}``
- ``st-plugins/vectors/index.js:1455``     POST ``{items,server}`` → ``{embeddings,model}``
- ``st-plugins/translate/index.js:254-413`` POST ``{text,lang}`` → **纯文本**
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import os
import re
import zipfile
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import get_db, settings
from ..core.exceptions import ServiceError
from ..models import Character, CharacterExpression, User
from ..services.expression_service import DEFAULT_EXPRESSIONS, ExpressionService
from ..services.inference_dispatcher import complete_text_completion, ensure_model_available
from .expressions import (
    _CONTENT_TYPE_EXT,
    _custom_expression_url,
    _expressions_dir,
    _get_character_by_name_or_404,
    _read_upload_with_limit,
    _validate_expression_name,
)
from .silly_tavern import (
    _default_model_id_for_db,
    _resolve_chat_completion_source,
    get_st_current_user,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["st-extras"])


# ===========================================================================
# 共用：模型解析与单次补全
# ===========================================================================

def _resolve_extras_model(
    db: Session,
    user: User,
    requested: Optional[str] = None,
    *,
    require_vision: bool = False,
) -> tuple[str, dict[str, Any]]:
    """解析本次调用使用的模型，返回 ``(model_id, model_entry)``。

    模型条目取 ``get_flat_model_list()``——**不是** ``silly_tavern._public_models()``：
    后者只返回 ``id/name/context_length`` 三个字段，**没有 ``supports_vision``**，
    用它判视觉能力会恒为 False（caption 永远 503）。``get_flat_model_list()`` 是
    ``GET /api/models`` 的同源数据（``api/models.py:183``），也就是用户在模型选择器里
    看到的那一份，口径一致。

    请求指定的模型不可用时**回退到默认模型并打 WARNING**——静默换模型会让
    用户在完全不知情的情况下拿到另一个模型的输出。
    """
    from ..services.unified_model_registry import get_flat_model_list

    catalog = {str(m.get("id") or ""): m for m in get_flat_model_list()}
    model_id = (requested or "").strip() or _default_model_id_for_db(db)
    entry = catalog.get(model_id)
    if entry is None:
        fallback = _default_model_id_for_db(db)
        logger.warning(
            "st_extras: 请求的模型 %r 不在模型目录中，回退到 %r", model_id, fallback,
        )
        model_id = fallback
        entry = catalog.get(model_id) or {}

    try:
        ensure_model_available(model_id)
    except ValueError as exc:
        # 5xx 一律走 ServiceError：main.py 的 HTTPException 处理器会把 >=500 的
        # detail 抹成 "Internal server error"（main.py:575-583），插件用户就看不到
        # "去启用一个视觉模型" 这种可操作提示了。ServiceError 的处理器保留原文。
        raise ServiceError(
            f"没有可用的对话模型：{exc}",
            code="NO_CHAT_MODEL",
            status_code=503,
        ) from exc

    if require_vision and not entry.get("supports_vision"):
        # 明确拒绝，不返回假描述。前端插件会走自己的失败分支。
        # 注意「未声明」与「声明为 false」同等对待：没有正向声明就不敢保证模型真能看图，
        # 放行只会得到一段看起来像真的、其实是编的描述——那比报错更糟。
        raise ServiceError(
            (
                f"模型 {model_id} 未声明支持视觉输入（supports_vision=false），"
                "无法生成图片描述。请在「模型管理」里启用一个支持视觉的模型。"
            ),
            code="MODEL_LACKS_VISION",
            status_code=503,
        )
    return model_id, entry


async def _complete_once(
    db: Session,
    user: User,
    messages: list[dict[str, Any]],
    *,
    temperature: float = 0.2,
    max_tokens: int = 256,
    timeout: float = 60.0,
    require_vision: bool = False,
    model_id: Optional[str] = None,
) -> str:
    """调用 Palink 已配置的模型做**一次**非流式补全，返回纯文本。"""
    resolved, _ = _resolve_extras_model(db, user, model_id, require_vision=require_vision)
    source = _resolve_chat_completion_source(db, user.id)
    try:
        result = await complete_text_completion(
            model_id=resolved,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            chat_completion_source=source,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - 上游异常形态不可控，统一转 502
        logger.warning("st_extras: 模型调用失败 model=%s err=%s", resolved, exc)
        raise ServiceError(f"模型调用失败：{exc}", code="MODEL_CALL_FAILED", status_code=502) from exc

    content = result.get("content") if isinstance(result, dict) else None
    return str(content or "").strip()


# ===========================================================================
# /api/extra/classify + labels —— expressions 插件（本地分类模式）
# ===========================================================================

class ClassifyRequest(BaseModel):
    text: str = ""


# 分类标签集合 = ST 1.18.0 的 15 个默认表情名（services/expression_service.py:15）。
# 不用自定义表情名：插件侧 ``getExpressionLabel`` 只按默认标签挑图。
_CLASSIFY_LABELS: tuple[str, ...] = tuple(DEFAULT_EXPRESSIONS)

_CLASSIFY_PROMPT = (
    "你是情绪分类器。从下面的标签里选出**唯一一个**最匹配给定文本的情绪。\n"
    "标签：" + ", ".join(_CLASSIFY_LABELS) + "\n"
    "只输出标签本身，不要解释、不要标点、不要引号。"
)


def _match_label(raw: str) -> Optional[str]:
    """从模型输出里捞出合法标签。

    模型常带多余字符（引号、句号、``label: joy``），所以做两级匹配：
    精确 → 子串包含。都失败返回 None（交给关键词兜底）。
    """
    text = (raw or "").strip().strip("\"'`。.,，:： \n\t").lower()
    if not text:
        return None
    if text in _CLASSIFY_LABELS:
        return text
    # 取第一个出现在输出里的合法标签（按出现位置，不按列表顺序）
    hits = [(text.find(label), label) for label in _CLASSIFY_LABELS if label in text]
    hits = [item for item in hits if item[0] >= 0]
    if hits:
        hits.sort()
        return hits[0][1]
    return None


async def _classify_via_llm(db: Session, user: User, text: str) -> Optional[str]:
    """走已配置 LLM 分类；模型输出不可解析时返回 None（由关键词兜底）。"""
    try:
        raw = await _complete_once(
            db,
            user,
            [
                {"role": "system", "content": _CLASSIFY_PROMPT},
                {"role": "user", "content": text[:2000]},
            ],
            temperature=0.0,
            max_tokens=16,
            timeout=30.0,
        )
    except (HTTPException, ServiceError) as exc:
        # 模型不可用不该让整个分类失败——关键词匹配是确定性能力，能给出答案。
        detail = getattr(exc, "detail", None) or getattr(exc, "message", str(exc))
        logger.warning("st_extras: classify LLM 路径不可用，回退关键词匹配（%s）", detail)
        return None
    label = _match_label(raw)
    if label is None:
        logger.warning("st_extras: classify LLM 输出无法解析为标签，回退关键词匹配（raw=%r）", raw[:80])
    return label


def _classify_via_keywords(text: str) -> str:
    """确定性兜底：复用 Palink 既有中英关键词匹配（纯规则，不调模型）。"""
    return ExpressionService().analyze_expression(text)


@router.post("/api/extra/classify")
async def st_extra_classify(
    payload: ClassifyRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """文本 → 表情标签。对应 ST 本地 BERT 分类器的位置。

    LLM 优先、关键词兜底。两条路都是真实计算，**不存在伪造结果**：
    模型不可用时日志里能看到回退原因。
    """
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text cannot be empty")

    label = await _classify_via_llm(db, user, text)
    if label is None:
        label = _classify_via_keywords(text)
    return {"classification": [{"label": label, "score": 1.0}]}


@router.post("/api/extra/classify/labels")
async def st_extra_classify_labels(
    user: User = Depends(get_st_current_user),
):
    """返回可分类的标签全集（插件用它决定挑哪些表情图）。"""
    return {"labels": list(_CLASSIFY_LABELS)}


@router.get("/api/classify/labels")
async def st_classify_labels(
    user: User = Depends(get_st_current_user),
):
    """Extras 服务形态的标签端点（``/api/classify/labels``，无 extra 前缀）。

    当用户把「Extras API URL」指向 Palink 自身时，插件走的是这条 GET。
    """
    return {"labels": list(_CLASSIFY_LABELS)}


# ===========================================================================
# /api/extra/caption —— caption 插件（本地流水线模式）
# ===========================================================================

class CaptionRequest(BaseModel):
    # ST 传的是**去掉 data: 前缀**的裸 base64（caption/index.js:240 注释）
    image: str = ""


def _sniff_image_mime(raw: bytes) -> str:
    """按魔数判图片类型，拿不到就按 png 处理。"""
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:2] == b"BM":
        return "image/bmp"
    return "image/png"


_CAPTION_PROMPT = (
    "请用中文客观描述这张图片的内容，覆盖主体、动作、场景与风格。"
    "只输出描述正文，不要前后缀、不要 markdown。"
)


@router.post("/api/extra/caption")
async def st_extra_caption(
    payload: CaptionRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """图片 → 文字描述（走已配置的**视觉**模型）。

    没有支持视觉的模型时返回 503 + 可操作提示，**不返回伪造描述**。
    """
    encoded = (payload.image or "").strip()
    if not encoded:
        raise HTTPException(status_code=400, detail="image cannot be empty")
    if encoded.startswith("data:"):
        # 容错：插件文档说裸 base64，但别的调用方可能带前缀
        _, _, encoded = encoded.partition(",")
    try:
        raw = base64.b64decode(encoded, validate=False)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail=f"image is not valid base64: {exc}") from exc
    if not raw:
        raise HTTPException(status_code=400, detail="image decoded to empty bytes")

    mime = _sniff_image_mime(raw)
    data_url = f"data:{mime};base64,{encoded}"

    caption = await _complete_once(
        db,
        user,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _CAPTION_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        temperature=0.3,
        max_tokens=512,
        timeout=90.0,
        require_vision=True,
    )
    if not caption:
        raise ServiceError("视觉模型返回了空描述", code="EMPTY_CAPTION", status_code=502)
    return {"caption": caption}


# ===========================================================================
# /api/summarize + /api/translate* —— memory / translate 插件
# ===========================================================================
#
# 这四条原先转发到 ST sidecar（已删，恒 502）。现改为真实实现：
#   · summarize  → 已配置 LLM 做摘要
#   · translate  → 原生上游优先，不可用时回落 LLM 翻译并打 WARNING 留痕
#                  （文档 §C-1 授权「其余回退到默认 provider 并留痕」）
#
# ⚠️ 本机实测（2026-10-18）容器出网是**部分阻断**的：
#   translate.googleapis.com → Network is unreachable；lingva.ml → 403；
#   libre 公共实例 → 超时；www.bing.com → 302 可达。
# 所以 google 原生路径在这里必然失败并落到 LLM 兜底 —— 这是环境事实，不是实现缺陷。

class SummarizeRequest(BaseModel):
    text: str = ""
    params: dict[str, Any] = Field(default_factory=dict)


@router.post("/api/summarize")
async def st_extras_summarize(
    payload: SummarizeRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST Extras 摘要：``POST {text, params}`` → ``{summary}``。

    消费方：memory 插件 ``callExtrasSummarizeAPI``、vectors 插件 ``summarizeExtra``。
    """
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text cannot be empty")

    # params 里的指令性字段（ST 的 summary 服务支持 prompt 覆盖）
    instruction = ""
    if isinstance(payload.params, dict):
        instruction = str(payload.params.get("prompt") or payload.params.get("instruction") or "").strip()
    system = instruction or (
        "你是对话摘要器。把给定内容压缩成简洁摘要，保留人物、事件与关键转折，"
        "不要加入原文没有的信息。只输出摘要正文。"
    )

    summary = await _complete_once(
        db,
        user,
        [
            {"role": "system", "content": system},
            {"role": "user", "content": text[:24000]},
        ],
        temperature=0.3,
        max_tokens=1024,
        timeout=120.0,
    )
    if not summary:
        raise ServiceError("模型返回了空摘要", code="EMPTY_SUMMARY", status_code=502)
    return {"summary": summary}


class TranslateRequest(BaseModel):
    text: str = ""
    lang: str = "zh-CN"
    from_lang: Optional[str] = None
    to_lang: Optional[str] = None


# 与 ST 1.18.0 translate 扩展一致的 8 个 provider（translate/index.js:503-517）。
# provider 参与上游 URL 拼接，所以必须白名单化（同时阻断 ../ 穿越）。
_ST_TRANSLATE_PROVIDERS = frozenset({
    "onering", "libre", "google", "lingva", "deepl", "deeplx", "bing", "yandex",
})

# 有原生实现的 provider。其余（onering/lingva/deepl/deeplx/bing/yandex）需要
# 各自的服务实例或付费密钥，本仓库无对应配置 ⇒ 直接走 LLM 兜底并留痕。
_NATIVE_TRANSLATE_PROVIDERS = frozenset({"google", "libre"})

# 原生上游超时。google 在本网络是立即 ConnectError（非超时），不影响延迟。
_TRANSLATE_NATIVE_TIMEOUT = 8.0


async def _translate_via_google(text: str, target_lang: str) -> str:
    """Google 免费端点（client=gtx，无需密钥）。返回纯文本。"""
    import httpx

    url = "https://translate.googleapis.com/translate_a/single"
    params = {"client": "gtx", "sl": "auto", "tl": target_lang, "dt": "t", "q": text}
    async with httpx.AsyncClient(timeout=_TRANSLATE_NATIVE_TIMEOUT) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
    # 返回形如 [[["译1","原文1",...],["译2","原文2",...]], ...]
    segments = data[0] if isinstance(data, list) and data else []
    out = "".join(str(seg[0]) for seg in segments if isinstance(seg, list) and seg)
    return out.strip()


async def _translate_via_libre(text: str, target_lang: str) -> str:
    """LibreTranslate 实例转发。实例地址走环境变量（无默认值 ⇒ 未配置即跳过）。"""
    import httpx

    base = (os.getenv("PALINK_LIBRE_TRANSLATE_URL") or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("PALINK_LIBRE_TRANSLATE_URL 未配置")
    payload = {"q": text, "source": "auto", "target": target_lang, "format": "text"}
    async with httpx.AsyncClient(timeout=_TRANSLATE_NATIVE_TIMEOUT) as client:
        resp = await client.post(f"{base}/translate", json=payload)
        resp.raise_for_status()
        data = resp.json()
    return str(data.get("translatedText") or "").strip()


async def _translate_via_llm(db: Session, user: User, text: str, target_lang: str) -> str:
    """LLM 翻译兜底。语言代码用自然语言提示，避免模型不认识 BCP-47。"""
    return await _complete_once(
        db,
        user,
        [
            {
                "role": "system",
                "content": (
                    "你是翻译引擎。把用户给出的文本翻译成目标语言，"
                    "保持语气、专有名词与人称不变。只输出译文，不要解释。"
                    f"目标语言：{target_lang}"
                ),
            },
            {"role": "user", "content": text[:12000]},
        ],
        temperature=0.2,
        max_tokens=4096,
        timeout=120.0,
    )


async def _translate_text(
    db: Session,
    user: User,
    text: str,
    target_lang: str,
    provider: Optional[str] = None,
) -> str:
    """原生优先 → LLM 兜底。每次兜底都打 WARNING（留痕，不静默降级）。"""
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text cannot be empty")
    lang = (target_lang or "zh-CN").strip() or "zh-CN"

    if provider in _NATIVE_TRANSLATE_PROVIDERS:
        try:
            if provider == "google":
                native = await _translate_via_google(text, lang)
            else:
                native = await _translate_via_libre(text, lang)
            if native:
                return native
            logger.warning("st_extras: translate provider=%s 原生上游返回空，回落 LLM", provider)
        except Exception as exc:  # noqa: BLE001 - 网络/上游异常一律回落
            logger.warning(
                "st_extras: translate provider=%s 原生上游不可用（%s: %s），回落 LLM 翻译",
                provider, type(exc).__name__, exc,
            )
    elif provider:
        logger.warning(
            "st_extras: translate provider=%s 无原生实现（需外部实例/密钥），回落 LLM 翻译",
            provider,
        )

    translated = await _translate_via_llm(db, user, text, lang)
    if not translated:
        raise ServiceError("模型返回了空译文", code="EMPTY_TRANSLATION", status_code=502)
    return translated


@router.post("/api/extra/translate")
async def st_extras_translate(
    payload: TranslateRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """ST Extras 翻译（``/api/extra/*`` 族路径）。"""
    translated = await _translate_text(db, user, payload.text, payload.lang)
    return PlainTextResponse(translated)


@router.post("/api/translate")
async def st_translate(
    payload: TranslateRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """无 provider 子路径的兜底翻译。"""
    translated = await _translate_text(db, user, payload.text, payload.lang)
    return PlainTextResponse(translated)


@router.post("/api/translate/{provider}")
async def st_translate_provider(
    provider: str,
    payload: TranslateRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """按 provider 子路径翻译（translate 插件实际调用的形状）。

    响应是**纯文本**——插件用 ``response.text()`` 直接取（translate/index.js:260）。
    """
    if provider not in _ST_TRANSLATE_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported translate provider: {provider}",
        )
    # onering 传的是 from_lang/to_lang，其余传 lang；这里统一取 to_lang 优先
    target = (payload.to_lang or payload.lang or "zh-CN").strip() or "zh-CN"
    translated = await _translate_text(db, user, payload.text, target, provider=provider)
    return PlainTextResponse(translated)


# ===========================================================================
# /api/backends/kobold/embed —— vectors 插件
# ===========================================================================

class EmbedRequest(BaseModel):
    items: list[str] = Field(default_factory=list)
    # 插件会带 server（KoboldCpp 地址）；Palink 不用它，留字段避免 422
    server: Optional[str] = None


@router.post("/api/backends/kobold/embed")
async def st_kobold_embed(
    payload: EmbedRequest,
    user: User = Depends(get_st_current_user),
):
    """批量文本嵌入。

    vectors 插件对响应有**严格校验**（vectors/index.js:1471-1478）：
    ``embeddings`` 必须是数组、``model`` 必须非空、且 ``embeddings.length === items.length``、
    每条非空 —— 任何一条不满足它都会抛错。所以这里逐项校验后再返回。

    嵌入引擎复用 Palink 既有 ``embed_text``（ollama bge-m3 / 1024 维，
    Ollama 不可达时自动降级 fastembed，见 memory_module/embedder.py）。
    """
    from ..memory_module.embedder import embed_text, get_embedder

    items = [str(item) for item in (payload.items or [])]
    if not items:
        return {"embeddings": [], "model": ""}

    embedder = get_embedder()
    model_name = str(getattr(embedder, "_model", None) or type(embedder).__name__)
    try:
        matrix = embed_text(items)
    except Exception as exc:  # noqa: BLE001
        logger.warning("st_extras: embed 失败 err=%s", exc)
        raise ServiceError(f"嵌入失败：{exc}", code="EMBED_FAILED", status_code=502) from exc

    vectors = matrix.tolist() if hasattr(matrix, "tolist") else list(matrix)
    if len(vectors) != len(items):
        raise ServiceError(
            f"嵌入结果条数不匹配：期望 {len(items)}，实际 {len(vectors)}",
            code="EMBED_COUNT_MISMATCH",
            status_code=502,
        )
    for idx, vec in enumerate(vectors):
        if not vec:
            raise ServiceError(f"第 {idx} 条嵌入为空", code="EMPTY_EMBEDDING", status_code=502)

    return {"embeddings": vectors, "model": model_name}


# ===========================================================================
# /api/sprites/* —— expressions 插件（精灵图持久化）
# ===========================================================================
#
# ST 的 sprite 目录名来自 ``spriteFolderNameFromCharacter``
# （expressions/index.js:822）：**头像文件名去掉扩展名**；另有一路直接用角色
# 显示名（``currentLastMessage.name``，:2006）。Palink 的 avatar 是
# ``palink-<cid>.png``（silly_tavern.py:930），所以两种形状都要认。
#
# 存储直接复用 api/expressions.py 的约定：``data/characters/{cid}/expressions/``
# （写）与 ``sprites/``（ST 约定，读回退），**不新建一套存储**。

_SPRITE_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
_SPRITE_MAX_BYTES = 10 * 1024 * 1024
_PALINK_AVATAR_RE = re.compile(r"^palink-([A-Za-z0-9_-]+)$")


def _resolve_character_for_sprites(db: Session, user: User, name: str) -> Character:
    """把插件的 sprite 目录名解析成角色。

    先认 ``palink-<cid>``（Palink avatar 命名），再按显示名查
    （``_get_character_by_name_or_404`` 已处理同名多行的确定性问题）。
    """
    raw = (name or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="name cannot be empty")

    match = _PALINK_AVATAR_RE.match(raw)
    if match:
        character = (
            db.query(Character)
            .filter(Character.id == match.group(1), Character.user_id == user.id)
            .first()
        )
        if character is not None:
            return character

    return _get_character_by_name_or_404(db, raw, user)


def _sprite_dirs(character: Character) -> list[str]:
    """候选 sprite 目录：Palink 默认 expressions/，以及 ST 约定的 sprites/。"""
    cid = str(character.id)
    dirs = [_expressions_dir(cid)]
    dirs.append(os.path.join(settings.DATA_DIR, "characters", cid, "sprites"))
    return dirs


def _sprite_label_from_stem(stem: str, known_labels: set[str]) -> str:
    """从文件名主干推 label。

    多图场景下 ST 会用 ``label-index`` 命名（expressions/index.js:834
    ``generateUniqueSpriteName`` 注释：``expression-index``）。把这类名字归并回
    主 label，否则插件侧会因为 label 不在标签表里而把它们全过滤掉。
    """
    if stem in known_labels:
        return stem
    match = re.match(r"^(.+?)-\d+$", stem)
    if match and match.group(1) in known_labels:
        return match.group(1)
    return stem


@router.get("/api/sprites/get")
async def st_sprites_get(
    name: str = Query(..., description="sprite 目录名（角色名或 palink-<cid>）"),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """列出某角色的全部精灵图 → ``[{label, path}]``。

    ``path`` 会被插件直接当 ``imageSrc`` 用（expressions/index.js:1216），
    所以必须是浏览器可加载的 URL。这里统一走既有的
    ``/api/characters/{cid}/expressions/{label}/image``——该端点内部有
    ``_resolve_sprite_file_path`` 的 sprites/ 目录回退，能覆盖两种存放位置。
    """
    character = _resolve_character_for_sprites(db, user, name)

    known_labels: set[str] = set(DEFAULT_EXPRESSIONS)
    known_labels.update(
        row.expression_name
        for row in db.query(CharacterExpression)
        .filter(CharacterExpression.character_id == character.id)
        .all()
    )

    seen: set[tuple[str, str]] = set()
    sprites: list[dict[str, str]] = []
    for directory in _sprite_dirs(character):
        if not os.path.isdir(directory):
            continue
        for entry in sorted(os.listdir(directory)):
            stem, ext = os.path.splitext(entry)
            if ext.lower() not in _SPRITE_IMAGE_EXTS:
                continue
            if not os.path.isfile(os.path.join(directory, entry)):
                continue
            label = _sprite_label_from_stem(stem, known_labels)
            key = (label, entry)
            if key in seen:
                continue
            seen.add(key)
            sprites.append({
                "label": label,
                "path": _custom_expression_url(str(character.id), label),
            })
    return sprites


def _write_sprite_file(character: Character, sprite_name: str, data: bytes, ext: str) -> str:
    """把精灵图写入 expressions 目录，返回相对 DATA_DIR 的路径。"""
    target_dir = _expressions_dir(str(character.id))
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        logger.error("st_extras: 创建 sprite 目录失败 %s: %s", target_dir, exc)
        raise HTTPException(status_code=400, detail="Failed to create sprite directory") from exc

    file_name = f"{sprite_name}{ext}"
    target_path = os.path.join(target_dir, file_name)
    try:
        with open(target_path, "wb") as fp:
            fp.write(data)
    except OSError as exc:
        logger.error("st_extras: 写入 sprite 失败 %s: %s", target_path, exc)
        raise HTTPException(status_code=400, detail="Failed to save sprite image") from exc
    return os.path.join("characters", str(character.id), "expressions", file_name)


def _upsert_expression_record(
    db: Session, character: Character, label: str, relative_path: str
) -> None:
    """同步一份 DB 记录，让 Palink 原生表情端点也能看到这张图。

    只由「主图」调用（``stem == label``）——多图场景的 ``joy-2`` 不覆盖主 label
    的记录，因为原生端点是「一 label 一图」语义。
    """
    existing = (
        db.query(CharacterExpression)
        .filter(
            CharacterExpression.character_id == character.id,
            CharacterExpression.expression_name == label,
        )
        .first()
    )
    if existing is None:
        db.add(CharacterExpression(
            character_id=character.id,
            expression_name=label,
            file_path=relative_path,
        ))
    else:
        existing.file_path = relative_path
    db.commit()


@router.post("/api/sprites/upload")
async def st_sprites_upload(
    name: str = Form(...),
    label: str = Form(...),
    avatar: UploadFile = File(...),
    spriteName: str = Form(""),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """上传单张精灵图。

    插件字段（expressions/index.js:896-901）：``name``=目录名、``label``=表情名、
    ``avatar``=文件、``spriteName``=目标文件名主干（多图时形如 ``joy-2``）。
    """
    character = _resolve_character_for_sprites(db, user, name)
    expression_name = _validate_expression_name(label)

    stem = (spriteName or "").strip() or expression_name
    if not re.match(r"^[A-Za-z0-9_-]+$", stem):
        raise HTTPException(
            status_code=400,
            detail="Invalid spriteName; only letters, digits, '_' and '-' are allowed.",
        )

    content_type = (avatar.content_type or "").lower()
    ext = _CONTENT_TYPE_EXT.get(content_type)
    data = await _read_upload_with_limit(avatar)
    if ext is None:
        # content-type 不可信（浏览器常给 application/octet-stream），按魔数兜底
        ext = _CONTENT_TYPE_EXT.get(_sniff_image_mime(data), ".png")

    relative_path = _write_sprite_file(character, stem, data, ext)
    # 只有「主图」同步 DB；joy-2 这类附加图只落盘
    if stem == expression_name:
        _upsert_expression_record(db, character, expression_name, relative_path)

    return {
        "label": expression_name,
        "spriteName": stem,
        "path": _custom_expression_url(str(character.id), expression_name),
    }


@router.post("/api/sprites/upload-zip")
async def st_sprites_upload_zip(
    name: str = Form(...),
    avatar: UploadFile = File(...),
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """上传精灵图压缩包，返回 ``{count}``（插件用它提示上传数量）。

    压缩包内文件名主干即 label（ST 约定 ``joy.png`` / ``joy-2.png``）。
    """
    character = _resolve_character_for_sprites(db, user, name)
    raw = await _read_upload_with_limit(avatar)

    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="avatar is not a valid zip archive") from exc

    count = 0
    for info in archive.infolist():
        if info.is_dir():
            continue
        # zip-slip 防护：只取 basename，丢弃任何目录层级
        base = os.path.basename(info.filename.replace("\\", "/"))
        stem, ext = os.path.splitext(base)
        if ext.lower() not in _SPRITE_IMAGE_EXTS:
            continue
        if not re.match(r"^[A-Za-z0-9_-]+$", stem):
            logger.warning("st_extras: 跳过非法 sprite 名 %r", base)
            continue
        data = archive.read(info)
        if not data or len(data) > _SPRITE_MAX_BYTES:
            logger.warning("st_extras: 跳过超限/空 sprite %r", base)
            continue
        relative_path = _write_sprite_file(character, stem, data, ext.lower())
        if stem in DEFAULT_EXPRESSIONS:
            _upsert_expression_record(db, character, stem, relative_path)
        count += 1

    return {"count": count}


class SpriteDeleteRequest(BaseModel):
    name: str = ""
    label: str = ""
    spriteName: str = ""


@router.post("/api/sprites/delete")
async def st_sprites_delete(
    payload: SpriteDeleteRequest,
    user: User = Depends(get_st_current_user),
    db: Session = Depends(get_db),
):
    """删除一张精灵图（按 ``spriteName`` 定位文件）。

    插件传 ``{name, label, spriteName}``（expressions/index.js:2072）。
    文件不存在时返回 ``deleted: false`` 而不是 404——插件的 catch 会弹
    「Failed to delete image」，但列表刷新仍应继续。
    """
    character = _resolve_character_for_sprites(db, user, payload.name)
    expression_name = _validate_expression_name(payload.label or "")
    stem = (payload.spriteName or "").strip() or expression_name
    if not re.match(r"^[A-Za-z0-9_-]+$", stem):
        raise HTTPException(status_code=400, detail="Invalid spriteName")

    removed = False
    for ext in _SPRITE_IMAGE_EXTS:
        for directory in _sprite_dirs(character):
            candidate = os.path.join(directory, f"{stem}{ext}")
            if not os.path.isfile(candidate):
                continue
            try:
                os.remove(candidate)
                removed = True
            except OSError as exc:
                logger.warning("st_extras: 删除 sprite 失败 %s: %s", candidate, exc)

    # 主图被删掉时同步清 DB 记录，否则原生端点会指向不存在的文件
    if removed and stem == expression_name:
        record = (
            db.query(CharacterExpression)
            .filter(
                CharacterExpression.character_id == character.id,
                CharacterExpression.expression_name == expression_name,
            )
            .first()
        )
        if record is not None:
            db.delete(record)
            db.commit()

    return {"deleted": removed, "label": expression_name, "spriteName": stem}
