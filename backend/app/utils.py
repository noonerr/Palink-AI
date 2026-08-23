import base64
import ipaddress
import json
import logging
import mimetypes
import os
import re
import socket
import uuid
from typing import Optional

from fastapi import HTTPException

from .core import settings

logger = logging.getLogger(__name__)


def normalize_image_url(img_url: str, check_size: bool = False, user_id: Optional[int] = None) -> str:
    if not isinstance(img_url, str) or not img_url.strip():
        if check_size:
            raise HTTPException(status_code=400, detail="Invalid image URL")
        return img_url

    normalized = img_url.strip()
    if not normalized:
        if check_size:
            raise HTTPException(status_code=400, detail="Invalid image URL")
        return img_url

    if normalized.startswith("data:image"):
        return normalized

    upload_prefix = None
    if normalized.startswith("/api/uploads/"):
        upload_prefix = "/api/uploads/"
    elif normalized.startswith("/uploads/"):
        upload_prefix = "/uploads/"

    if upload_prefix:
        relative_path = normalized.split(upload_prefix, 1)[1]
        relative_path = relative_path.split("?", 1)[0].split("#", 1)[0]
        normalized_relative = os.path.normpath(relative_path).replace("\\", "/").lstrip("/")
        if not normalized_relative or normalized_relative.startswith("../"):
            if check_size:
                raise HTTPException(status_code=400, detail="Invalid uploaded image path")
            return img_url

        upload_root = os.path.abspath(settings.UPLOAD_DIR)
        file_path = os.path.abspath(os.path.join(upload_root, normalized_relative))
        if os.path.commonpath([upload_root, file_path]) != upload_root:
            if check_size:
                raise HTTPException(status_code=400, detail="Invalid uploaded image path")
            return img_url

        if user_id is not None:
            user_dir = os.path.abspath(os.path.join(upload_root, str(user_id)))
            if not (file_path == user_dir or file_path.startswith(user_dir + os.sep)):
                if check_size:
                    raise HTTPException(status_code=403, detail="Image does not belong to current user")
                return img_url

        if not os.path.exists(file_path):
            if check_size:
                raise HTTPException(status_code=404, detail="Uploaded image not found")
            return img_url

        if check_size:
            file_size = os.path.getsize(file_path)
            if file_size > 10 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Image too large (max 10MB)")

        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type or not mime_type.startswith("image/"):
            mime_type = "image/png"

        with open(file_path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("ascii")

        return f"data:{mime_type};base64,{encoded}"

    if check_size:
        if not _is_public_http_url(normalized):
            raise HTTPException(status_code=400, detail="Only public http(s) image URLs are allowed")

    if normalized.startswith("http://") or normalized.startswith("https://"):
        return normalized

    return img_url


def _is_public_http_url(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    host = parsed.hostname
    if not host:
        return False

    lowered_host = host.lower()
    if lowered_host in {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::]", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"} or lowered_host.endswith(".local"):
        return False

    def _is_private_or_local_ip(ip_str: str) -> bool:
        try:
            ip_obj = ipaddress.ip_address(ip_str)
            return (
                ip_obj.is_private
                or ip_obj.is_loopback
                or ip_obj.is_link_local
                or ip_obj.is_multicast
                or ip_obj.is_reserved
                or ip_obj.is_unspecified
                or _is_carrier_grade_nat(ip_obj)
            )
        except ValueError:
            return False

    def _is_carrier_grade_nat(ip_obj) -> bool:
        try:
            return ip_obj in ipaddress.ip_network("100.64.0.0/10")
        except Exception:
            return False

    if _is_private_or_local_ip(host):
        return False

    try:
        target_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addr_info = socket.getaddrinfo(host, target_port, proto=socket.IPPROTO_TCP)
    except Exception:
        return False

    for info in addr_info:
        ip_addr = info[4][0]
        if _is_private_or_local_ip(ip_addr):
            return False

    return True


def clean_memory_content(text: Optional[str]) -> str:
    """清洗记忆入库文本：剥离功能标签与思维链块，只保留剧情正文。

    背景：此前 assistant 回复的 full_content 未经清洗直接写入向量记忆库，
    <UpdateVariable>（及其内嵌 <Analysis>/<JSONPatch>）大 XML 功能块、以及可能的
    <thinking> 思维链块会整块进入记忆；注入 prompt 时又被 content[:200] 硬截断，
    切出残缺的半截标签，推理模型在思维链中反复自我审查这些标签 → 第二轮死循环。
    因此入库前先剥离功能块/思维链块，只存剧情正文。
    """
    if not text:
        return ""
    s = str(text)
    # 1) 剥离完整 <UpdateVariable> 功能块（含内嵌 <Analysis>/<JSONPatch>，跨行）
    s = re.sub(r"<UpdateVariable(?:\s[^>]*)?[\s\S]*?</UpdateVariable\s*>", "", s, flags=re.IGNORECASE)
    # 2) 剥离思维链块（推理模型常见的 <thinking> 或 <think>）
    s = re.sub(r"<(?:think|thinking)(?:\s[^>]*)?[\s\S]*?</(?:think|thinking)\s*>", "", s, flags=re.IGNORECASE)
    # 3) 清扫因截断而残留的孤立功能标签（防止残缺标签进入记忆）
    s = re.sub(r"</?(?:UpdateVariable|Analysis|JSONPatch|Patch|think|thinking)\b[^>]*>", "", s, flags=re.IGNORECASE)
    # 4) 折叠多余空行
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


_SENTENCE_BOUNDARY = "。！？；!?;…"
_TERMINAL_BOUNDARY = "。！？!?…"

# HTML void 元素（自闭合，无需配对）；按小写精确比较
_VOID_HTML_TAGS = {
    "br", "hr", "img", "input", "meta", "link", "area", "base",
    "col", "embed", "source", "track", "wbr",
}
_OPEN_TAG_RE = re.compile(r"<([A-Za-z\u4e00-\u9fff][^\s<>/!]*)(?:\s[^<>]*)?>")
_CLOSE_TAG_RE = re.compile(r"</\s*([A-Za-z\u4e00-\u9fff][^\s<>/!]*)\s*>")

# [TAG-BALANCE-GUARD] 注入文本标签平衡守卫（2026-08-22）。
# 背景：角色卡世界书/插件注入常带不平衡的自定义标签（实测「猫娘」卡：
# 「猫神说话格式」条目 <猫神> 开标签无配对闭合、「角色总览」裸 <user>；
# 推理模型 deepseek-v4-flash 遇到未闭合标签会把全部输出写进 <think>
# 并复读尾部指令 → 正文为空，用户侧表现为"一直在思考"）。
# 策略：开>闭的标签在文末补齐闭合；闭>开的孤立闭合标签剥离。


def balance_custom_tags(text: Optional[str]) -> str:
    """让注入文本中的自定义/HTML 标签开闭平衡。

    - 开 > 闭：在文本末尾按出现顺序补齐缺失的闭合标签
    - 闭 > 开：剥离孤立的闭合标签
    - HTML void 元素（br/hr/img/input 等）不参与配对
    - 已平衡的文本原样返回
    """
    if not text:
        return text or ""
    if "<" not in text:
        return text

    opens_counter: dict = {}
    closes_counter: dict = {}
    for m in _OPEN_TAG_RE.finditer(text):
        tag = m.group(1)
        if tag.lower() in _VOID_HTML_TAGS:
            continue
        opens_counter[tag] = opens_counter.get(tag, 0) + 1
    close_spans = [(m.span(), m.group(1)) for m in _CLOSE_TAG_RE.finditer(text)]
    for _, tag in close_spans:
        closes_counter[tag] = closes_counter.get(tag, 0) + 1

    needs_fix = any(
        opens_counter.get(t, 0) != closes_counter.get(t, 0)
        for t in set(opens_counter) | set(closes_counter)
    )
    if not needs_fix:
        return text

    result = text
    # 1) 剥离孤立闭合标签（该标签闭数量超过开数量的部分）
    orphan_closes = {
        t: closes_counter[t] - opens_counter.get(t, 0)
        for t in closes_counter
        if closes_counter[t] > opens_counter.get(t, 0)
    }
    for tag, excess in orphan_closes.items():
        pattern = re.compile(r"</\s*" + re.escape(tag) + r"\s*>")
        result = pattern.sub("", result, count=excess)

    # 2) 文末补齐缺失的闭合标签（后开的先闭，尽量保持嵌套合理）
    missing_closes = [
        t for t in opens_counter
        if opens_counter[t] > closes_counter.get(t, 0)
    ]
    if missing_closes:
        # 嵌套正确性无法完全保证，但推理模型只需看到结构闭合即可停止"补关"行为
        result = result + "".join(f"</{t}>" for t in reversed(missing_closes))
    return result


# [REASONING-PARSE] 内联 <think> 统一解析器（2026-08-22，spec: separate-reasoning-pipeline）
# 与 character_message_builder 历史清洗保持同一匹配语义（<think...>...</think>，忽略大小写）。
_THINK_STRIP_RE = re.compile(r"<think[\s\S]*?</think\s*>", re.IGNORECASE)
_THINK_OPEN_RE = re.compile(r"<think(?:\s[^>]*)?>", re.IGNORECASE)


def split_inline_think(text: Optional[str]):
    """从文本中提取首个内联 <think> 块。

    Returns:
        (reasoning, content) 二元组：
        - 无 think 块 → ("", 原文)
        - 未闭合 <think>（无 </think>）→ 全部剩余文本视为思考，content 为空串
        - 正常 → (思考内容, 首块前后拼接的正文)
    """
    if not text:
        return "", text or ""
    open_m = _THINK_OPEN_RE.search(text)
    if not open_m:
        return "", text
    close_match = re.search(r"</think\s*>", text[open_m.end():], flags=re.IGNORECASE)
    if not close_match:
        return text[open_m.end():].strip(), ""
    reasoning = text[open_m.end():open_m.end() + close_match.start()].strip()
    content = (text[:open_m.start()] + text[open_m.end() + close_match.end():]).strip()
    return reasoning, content


def strip_inline_think(text: Optional[str]) -> str:
    """剥离文本中全部 <think>...</think> 块（与历史清洗正则语义一致，未闭合不动）。"""
    if not text:
        return text or ""
    return _THINK_STRIP_RE.sub("", text)


def strip_inline_think_full(text: Optional[str]) -> str:
    """[REASONING-SEPARATE] 全量剥离：全部闭合块 + 残留未闭合开标签截尾。

    与 get_display_content 同语义的文本级版本（供迁移脚本等无消息对象的场景使用）。
    """
    if not text:
        return text or ""
    if not _THINK_OPEN_RE.search(text):
        return text
    stripped = _THINK_STRIP_RE.sub("", text)
    leftover_open = _THINK_OPEN_RE.search(stripped)
    if leftover_open:
        stripped = stripped[: leftover_open.start()]
    return stripped.strip()


# [REASONING-ACCESSOR] 分离存储访问器（2026-08-23，思考/正文分离存储 Step 1）
# 兼容三形态：新格式行（extra.reasoning=思考、content=纯正文）、存量混存行
# （content 含内联块）、普通行（无思考）。存量双写行以 extra.reasoning 为权威。
def get_message_extra(msg) -> dict:
    """安全解析消息 extra 字段（Text 列存 JSON 字符串）为 dict；None/非法输入返回空 dict。"""
    raw = msg.get("extra") if isinstance(msg, dict) else getattr(msg, "extra", None)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def get_message_reasoning(msg) -> str:
    """取消息思维链：优先 extra.reasoning（权威），否则从 content 内联块拆出（存量单写行兜底）。"""
    reasoning = get_message_extra(msg).get("reasoning")
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    if content and _THINK_OPEN_RE.search(content):
        return split_inline_think(content)[0]
    return ""


def get_display_content(msg) -> str:
    """取消息展示正文：无内联块原样返回；有块时全量剥离（含未闭合尾截断）。"""
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    return strip_inline_think_full(content)


def apply_message_extra_patch(msg, patch: dict) -> None:
    """[REASONING-SEPARATE] 把 patch 合并进消息 extra（Text 列 JSON 字符串），空 patch 不动。"""
    if not patch:
        return
    current = get_message_extra(msg)
    current.update(patch)
    msg.extra = json.dumps(current, ensure_ascii=False)


def _truncate_by_sentence(text: str, max_len: int) -> str:
    """在 max_len 内按句子边界安全截断，避免切断句子或残留脏标签。

    优先回退到最近的句末边界（句号/叹号/问号/省略号），找不到再用次弱的分号边界，
    仍找不到才硬截断并追加省略号（入库前已清洗，正常不会残留半截标签）。
    """
    text = text.strip()
    if len(text) <= max_len:
        return text
    head = text[:max_len]
    # 先找句末边界（.。！！？？!?...），后找分号，保证语义完整性优先
    for boundary, append in ((_TERMINAL_BOUNDARY, ""), (_SENTENCE_BOUNDARY, "")):
        for i in range(len(head) - 1, -1, -1):
            if head[i] in boundary:
                return head[: i + 1]
    return head + "…"


def build_memory_context(memory_ctx, max_tokens: Optional[int] = None) -> str:
    """把检索到的记忆格式化为注入文本（方案 B，2026-08-22）。

    变更：废除每条 200 字砍头 —— 语义块命中即完整注入；
    预算（max_tokens，估算口径 len//2 与 retriever 一致）不足时
    按"整条跳过"处理而非截断文本。
    兜底：无 #chunk 标记的超长遗留条目仍按句边界截到 CHUNK_MAX_CHARS，
    防止存量整段巨物撑爆预算（随迁移脚本重切后自然消失）。
    """
    from .memory_module.config import memory_config as _mem_cfg

    parts = []
    if memory_ctx.user_profile and memory_ctx.user_profile.summary:
        parts.append(f"[User Profile]\n{memory_ctx.user_profile.summary}")
    if memory_ctx.memories:
        mem_lines = []
        used = 0
        max_chars = _mem_cfg.CHUNK_MAX_CHARS
        for mem in memory_ctx.memories:
            text = clean_memory_content(mem.content)
            if not text:
                continue
            is_chunk = "#chunk" in (mem.topics or [])
            if not is_chunk and len(text) > max_chars:
                # 存量遗留整段条目兜底截断（新写入不会产生此类条目）
                text = _truncate_by_sentence(text, max_chars)
            # [TAG-BALANCE-GUARD] 记忆块可能从标签中间切开，注入前修平
            text = balance_custom_tags(text)
            cost = len(text) // 2
            if max_tokens is not None and used + cost > max_tokens and mem_lines:
                continue  # 预算不足：整条跳过，不制造残缺片段
            prefix = "User" if mem.role == "user" else "Assistant"
            mem_lines.append(f"- {prefix}: {text}")
            used += cost
        if mem_lines:
            parts.append("[Relevant Memories]\n" + "\n".join(mem_lines))
    return "\n\n".join(parts)


def normalize_upload_filename(filename: Optional[str]) -> str:
    raw = (filename or "").strip()
    raw = raw.replace("\x00", "")
    raw = raw.replace("../", "").replace("..\\", "")
    base_name = os.path.basename(raw)
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", base_name)
    cleaned = re.sub(r"[^\w.\- ()\[\]]", "_", cleaned)
    cleaned = cleaned.strip(" .")
    if not cleaned or cleaned in {".", ".."}:
        cleaned = f"upload_{uuid.uuid4().hex}.bin"
    name_part, ext_part = os.path.splitext(cleaned)
    while True:
        inner_ext = os.path.splitext(name_part)[1].lower()
        if inner_ext and inner_ext in _DANGEROUS_EXTENSIONS:
            name_part = os.path.splitext(name_part)[0]
        else:
            break
    cleaned = name_part + ext_part
    max_name_len = 255
    if len(cleaned) > max_name_len:
        name_part, ext_part = os.path.splitext(cleaned)
        name_part = name_part[: max_name_len - len(ext_part)]
        cleaned = name_part + ext_part
    return cleaned


_DANGEROUS_EXTENSIONS = {
    ".php", ".php3", ".php4", ".php5", ".phtml",
    ".pht", ".shtml", ".cfm", ".cfc", ".asa", ".cer", ".cdx",
    ".jsp", ".jspx", ".asp", ".aspx",
    ".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".scr",
    ".ps1", ".psm1", ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".hta",
    ".jar", ".apk", ".cgi", ".pl", ".py", ".rb", ".sh", ".bash",
}

_MAGIC_SIGNATURES = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),
    (b"Rar!\x1a\x07", "application/vnd.rar"),
    (b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
    (b"BM", "image/bmp"),
    (b"RIFF", None),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
    (b"<?xml", "text/xml"),
]

_COMPATIBLE_MIME_GROUPS = [
    {"image/jpeg", "image/jpg"},
    {"application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
     "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
    {"text/plain", "text/csv", "text/html", "text/xml", "application/xml"},
]


def _is_mime_compatible(detected: str, declared: str) -> bool:
    if detected == declared:
        return True
    for group in _COMPATIBLE_MIME_GROUPS:
        if detected in group and declared in group:
            return True
    return False


def get_default_ai_model(db=None) -> str:
    from .services.provider_registry import get_runtime_providers
    from .services.local_model_registry import list_enabled_chat_models
    from fastapi import HTTPException

    providers = get_runtime_providers()
    provider = next((p for p in providers if p.get("is_active") and p.get("models")), None)
    if provider and provider["models"]:
        model_id = provider["models"][0]["id"] if isinstance(provider["models"][0], dict) else provider["models"][0]
        return model_id

    local_models = list_enabled_chat_models()
    if not local_models:
        raise HTTPException(status_code=400, detail="No AI model configured")
    return local_models[0]["id"]
