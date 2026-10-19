"""
MVU (MagVarUpdate) 变量引擎 —— 酒馆助手智能卡通用兼容核心。

职责：
  - 解析 AI 回复中的变量更新块（标签别名 <update> / <updatevariable> /
    <variableupdate>，含不被包裹的裸 <JSONPatch> 块）里的 JSON Patch
    （RFC 6902 超集 + delta）
  - 在会话 stat_data 上应用 patch
  - 从角色卡 tavern_helper zod schema 提取初始默认变量

设计原则：
  - 纯函数 / 无状态，不碰 DB（DB 由集成层调用）
  - deep-copy 入参，禁止原地修改
  - 单个 op 异常不中断整体
  - 不依赖任何外部 CDN（MagVarUpdate/bundle.js 的等价 Python 实现）

对应规格书：docs/mvu_smartcard_full_compat_spec.md §3.1
"""

from __future__ import annotations

import json
import re
import copy
import logging
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "extract_update_variable_blocks",
    "strip_update_variable_blocks",
    "apply_patches",
    "extract_schema_defaults",
    "build_initial_stat_data",
    "MvuEngine",
]

# ---------------------------------------------------------------------------
# 1. 变量更新块提取
# ---------------------------------------------------------------------------
# [包Q 2026-10-19] 标签别名与闭合语义对齐上游 MVU。一手取证文件
# .tmp_probe/mvu_bundle.js（卡侧引用的 MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js，
# jsdelivr 公开代码，611598 字节；该文件是压缩产物、全文仅 3 行，故引用给
# 「行:列」并附可 grep 的字面 needle）：
#   · 展示层剥离正则（函数 Dr，2:462098，needle '/\n<(update(?:variable)?'）逐字为
#       /\n<(update(?:variable)?|variableupdate)>(?:(?!<\1>).)*<\/\1?>/gis
#   · 解析层标签记号正则（函数 Ut，2:360326，needle 'updatevariable|variableupdate|update|json_?patch'）
#       /^<(\/?)\s*(updatevariable|variableupdate|update|json_?patch|think|…)\b[^>]*>/i
#     并按桶分派（2:360600，needle "/^json/.test(e)?'patch':'update'"）、
#     再由 Rt（2:361540，needle 'function Rt('）把开/闭标签配对成块。
# ⇒ 上游认三种别名 <update> / <updatevariable> / <variableupdate>（大小写不敏感），
#   闭合标签用反引用 \1? —— 必须与开标签同名（或上游允许的裸 </>），
#   且块内不得再出现同名开标签（(?!<\1>)）。**不是**属性式 / 自闭合式写法。
#
# Palink 相对上游的两点**有意**差异（勿"顺手对齐"造成回归）：
#   1. 不要求块前必有换行。上游 \n< 是它展示层的限制；Palink 要支持内联块
#      （既有测试 test_multiple_blocks 即两个内联块紧邻，补 \n 会红）。
#   2. 块体用 group(2) 捕获，供 extract 解析其中的 JSON Patch；上游剥离正则
#      只看形状、group(1) 是标签名，不需要内容。
#   ⚠️ 上游自身两处不一致：解析层 Ut/Rt 按**桶**（update|patch）配对，跨别名
#      <update>…</UpdateVariable> 也能配上；展示层 Dr 按**反引用**要求同名。
#      Palink 的 extract 与 strip 共用同一条正则（不一致就会出现「剥了但没解析」
#      或「解析了但留在正文」），故按主控规格取**严格的反引用语义**。
_MVU_UPDATE_TAG_ALIAS = r"update(?:variable)?|variableupdate"
_MVU_JSONPATCH_TAG_ALIAS = r"json_?patch"
# group(1)=标签名、group(2)=块体；(?:(?!<\1>)[\s\S])*? 复刻上游 (?!<\1>) 的禁嵌套语义
_MVU_BLOCK_BODY = r"((?:(?!<\1>)[\s\S])*?)"
_MVU_BLOCK_PATTERN = r"<(%s)>%s</\1?>"
_UPDATE_BLOCK_SRC = _MVU_BLOCK_PATTERN % (_MVU_UPDATE_TAG_ALIAS, _MVU_BLOCK_BODY)
_JSONPATCH_BLOCK_SRC = _MVU_BLOCK_PATTERN % (_MVU_JSONPATCH_TAG_ALIAS, _MVU_BLOCK_BODY)

_UPDATE_VAR_RE = re.compile(_UPDATE_BLOCK_SRC, re.IGNORECASE)
_JSONPATCH_RE = re.compile(_JSONPATCH_BLOCK_SRC, re.IGNORECASE)
# 块独占整行时连同块后换行一并移除（strip 第一遍用），避免正文留下孤立空行。
_UPDATE_VAR_LINE_RE = re.compile(
    r"(?m)^[ \t]*" + _UPDATE_BLOCK_SRC + r"[ \t]*$\n?", re.IGNORECASE
)
_JSONPATCH_LINE_RE = re.compile(
    r"(?m)^[ \t]*" + _JSONPATCH_BLOCK_SRC + r"[ \t]*$\n?", re.IGNORECASE
)


def _find_first_json_array(text: str) -> list | None:
    """在 *text* 中查找第一个平衡的 JSON 数组并解析。失败返回 None。"""
    start = text.find("[")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                candidate = text[start : i + 1]
                return _safe_json_loads_list(candidate)
    return None


# ── 裸 JSON Patch 容错（2026-08-18）──
# ST 的 MVU 是前端扩展、解析有容错；Palink 后端此前只认 <UpdateVariable> 包裹块，
# AI 偶发不包裹、直接输出 JSON Patch 数组（如 2160 消息）时提取不到 → stat_data 永不更新。
# 这里按结构特征（op+path）识别"像 stat_data JSON Patch"的数组，防误解析正文 JSON。
_JSONPATCH_OPS = {"replace", "delta", "insert", "remove", "move"}


def _looks_like_stat_data_patch(data) -> bool:
    """判断解析出的 JSON 数组是否像 stat_data JSON Patch。

    判据：至少 1 个条目为 {op: replace/delta/insert/remove/move, path: /xxx/yyy}，
    path 首段非空、不以 `_` 开头（readonly 字段）、不含 < >（防 HTML/XML 误判）。
    """
    if not isinstance(data, list) or not data:
        return False
    legit = 0
    for p in data:
        if not isinstance(p, dict):
            continue
        op = p.get("op")
        path = p.get("path")
        if op in _JSONPATCH_OPS and isinstance(path, str):
            stripped = path.strip()
            if not stripped.startswith("/"):
                continue
            first = stripped.lstrip("/").split("/", 1)[0]
            if not first or first.startswith("_") or "<" in stripped or ">" in stripped:
                continue
            legit += 1
    return legit > 0


def _find_stat_data_patch_spans(text: str):
    """扫描全文，返回所有「像 stat_data JSON Patch」数组的 (start, end, parsed) 列表。

    按出现顺序返回；end 为闭区间后一位。平衡括号扫描 + _safe_json_loads_list 解析
    + _looks_like_stat_data_patch 结构校验三重保障，最大限度降低误伤正文。
    """
    spans = []
    idx = 0
    while True:
        start = text.find("[", idx)
        if start == -1:
            break
        depth = 0
        in_string = False
        escape = False
        end = -1
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end == -1:
            break
        candidate = text[start : end + 1]
        parsed = _safe_json_loads_list(candidate)
        if parsed is not None and _looks_like_stat_data_patch(parsed):
            spans.append((start, end + 1, parsed))
        idx = end + 1
    return spans


_PLACEHOLDER_VALUE_RE = re.compile(r"^\$\{[^}]+\}$")


def _filter_placeholder_patches(patches: list) -> list:
    """过滤掉 value 为 ${...} 未替换占位符的 patch 条目。"""
    result = []
    for p in patches:
        if isinstance(p, dict):
            val = p.get("value")
            if isinstance(val, str) and _PLACEHOLDER_VALUE_RE.match(val.strip()):
                continue
        result.append(p)
    return result


def _safe_json_loads_list(raw: str) -> list | None:
    """尝试 json.loads；失败则做宽松修复后重试。最后过滤占位符条目。"""
    data = None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        pass
    if data is None:
        # 宽松修复：去尾逗号、单引号→双引号、移除 ${...} 占位残留行
        fixed = raw
        fixed = re.sub(r",\s*([}\]])", r"\1", fixed)  # 尾逗号
        fixed = fixed.replace("'", '"')  # 单引号
        # 移除整行的 ${...} 占位符（AI 偶发未替换模板变量）
        fixed = "\n".join(
            line for line in fixed.splitlines() if "${" not in line
        )
        try:
            data = json.loads(fixed)
        except (json.JSONDecodeError, ValueError):
            return None
    if not isinstance(data, list):
        return None
    return _filter_placeholder_patches(data)


def extract_update_variable_blocks(text: str) -> list[list[dict]]:
    """从 AI 回复正文提取所有变量更新块内的 JSON Patch 数组。

    块标签认三种别名 ``<update>`` / ``<updatevariable>`` / ``<variableupdate>``
    （大小写不敏感，开闭必须同名，见本节头部取证）。
    另认**不被包裹的裸 ``<JSONPatch>`` 块**（上游 ``tn()`` 对全文取 patch 块，
    bundle:2:365913），多个块按正文出现顺序返回（上游同口径 sortBy('$index')）。
    无法解析的块会被跳过并记 warning。
    """
    if not text or not isinstance(text, str):
        return []
    items: list[tuple[int, list[dict]]] = []   # (块起点, 解析出的 patch 数组)
    wrapped_spans: list[tuple[int, int]] = []
    for m in _UPDATE_VAR_RE.finditer(text):
        wrapped_spans.append(m.span())
        inner = m.group(2)
        # 优先取 <JSONPatch> / <json_patch>...</...>
        jp = _JSONPATCH_RE.search(inner)
        if jp:
            patches = _safe_json_loads_list(jp.group(2))
        else:
            patches = _find_first_json_array(inner)
        if patches is not None:
            items.append((m.start(), patches))
        else:
            logger.warning("MVU: skipped unparseable variable-update block")
    # [包Q② 2026-10-19] 裸 <JSONPatch> 块（无 <UpdateVariable> 包裹）。此前只靠
    # [BARE-JSONPATCH] 兜底捞**第一个**数组，且 op="add" 会被
    # _looks_like_stat_data_patch 的 op 白名单挡掉 ⇒ 这类块解析不全、却要被
    # strip 剥掉（剥了但没解析）。改走与包裹块同一条解析路径，块体形状仍限 JSON 数组。
    for m in _JSONPATCH_RE.finditer(text):
        s, e = m.span()
        if any(ws <= s and e <= we for ws, we in wrapped_spans):
            continue  # 已被外层包裹块处理，避免同一块体重复计数
        patches = _safe_json_loads_list(m.group(2))
        if patches is not None:
            items.append((s, patches))
        else:
            logger.warning("MVU: skipped unparseable bare <JSONPatch> block")
    blocks = [p for _s, p in sorted(items, key=lambda it: it[0])]
    # [BARE-JSONPATCH] 模型偶发不包 <UpdateVariable> 直接输出裸 JSON Patch 数组
    # （2026-08-18 实测：world book 指令要求包裹但 AI 输出裸数组，后端提取不到
    # → stat_data 永不更新）。一个块都没解析到时，扫描全文采纳第一个结构校验
    # 通过的裸数组。（触发条件与改动前逐字一致：仍是 `not blocks`，不收紧成
    # "无标签级命中"，以免"包裹块解析失败"这一既有路径的行为被顺手改掉。）
    if not blocks:
        try:
            for _s, _e, parsed in _find_stat_data_patch_spans(text):
                if parsed is not None:
                    blocks.append(parsed)
                    break
        except Exception:
            pass
    return blocks


def strip_update_variable_blocks(text: str) -> str:
    """从消息正文剥离变量更新块（``<update>`` / ``<updatevariable>`` /
    ``<variableupdate>`` 三种别名，大小写不敏感；含内部 Analysis/JSONPatch）。

    这些块是 stat_data 更新的**指令**而非对话内容：ST 中由前端 MVU 扩展解析后
    从消息显示中隐藏，Palink 后端已在 update_from_reply 解析并落库 stat_data，
    正文中不应再残留指令块（否则显示为泄漏的 JSON patch 文本）。剥离仅作用于
    消息正文，不影响 stat_data 更新（后者基于剥离前的原文解析）。

    ⚠️ 与 extract_update_variable_blocks 共用 _UPDATE_VAR_RE / _JSONPATCH_RE：
    两者必须同一套标签别名与同一套块形状，否则会出现「剥了但没解析」或
    「解析了但留在正文」。故这里除包裹块外也剥裸 ``<JSONPatch>`` 块。
    """
    if not text or not isinstance(text, str):
        return text
    # 第一遍：块独占整行时连同单侧换行一并移除（`\n<block>\n` → 无残留），
    # 避免在正文中留下孤立空行；块体允许跨多行（含 Analysis/JSONPatch）。
    cleaned = _UPDATE_VAR_LINE_RE.sub("", text)
    # 第二遍：处理内联在正文中的块（不独占行，两侧保留原有换行）。
    cleaned = _UPDATE_VAR_RE.sub("", cleaned)
    # [包Q② 2026-10-19] 不被更新块包裹的裸 <JSONPatch> 块：上游 tn() 同样把它当
    # 指令采纳（bundle:2:365913），渲染时又把 patch 标签从正文里抹掉
    # （bundle:2:366950，for(const t of Rt(e,'patch')) n.fill(' ', t.start, t.end)）。
    # extract 既然认它，strip 就必须同批剥掉，否则正是「解析了但标签留在正文」。
    cleaned = _JSONPATCH_LINE_RE.sub("", cleaned)
    cleaned = _JSONPATCH_RE.sub("", cleaned)
    # 模型常把 <UpdateVariable> 块包在 markdown 代码围栏内输出（```html … ```），
    # 剥离块后围栏行残留（表现为正文泄漏 ``` / ```html）；一并清理，语义同前端
    # stripHtmlFenceLeftovers。
    cleaned = _strip_markdown_fence_leftovers(cleaned)
    # [BARE-JSONPATCH] 剥离结构校验通过的裸 JSON Patch 数组（AI 未包裹时的残留，
    # 避免正文显示泄漏的 JSON patch 文本）。从后往前删，避免索引错位。
    try:
        for _s, _e, _p in reversed(_find_stat_data_patch_spans(cleaned)):
            cleaned = cleaned[:_s] + cleaned[_e:]
    except Exception:
        pass
    # 清理块移除后可能留下的孤立空行（相邻块之间留一行即可）
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _strip_markdown_fence_leftovers(text: str) -> str:
    """清理剥离 <UpdateVariable> 块后残留的 markdown 代码围栏。

    ① 移除「内层为空」的围栏块（```lang … ``` 中间只剩空白）；
    ② 移除「孤立」围栏标记行（无配对开/闭围栏）。配对的真实 markdown 代码块
    （```xxx … ``` 内含实质内容）保留不动。
    """
    if not text:
        return text
    # ① 内层为空的围栏块整体移除：开围栏行 + 零个/多个空白行 + 闭围栏行，
    #    并连带吃掉开围栏行前的一个换行，避免在正文中留下孤立空行。
    #    （```html\n``` 即围栏包裹块被剥离后的残留；含实质内容的围栏块不匹配，保留。）
    result = re.sub(
        r"[ \t]*\n?`{3,}[a-zA-Z0-9_-]*[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*`{3,}[ \t]*",
        "",
        text,
    )
    # ② 配对围栏保留，孤立围栏标记行移除（含未闭合的开围栏：状态机结束后
    #    若 in_fence 仍为 True，回退删除最后进入的围栏行）。
    lines = result.split("\n")
    out: list[str] = []
    in_fence = False
    last_open_idx = -1
    for line in lines:
        is_open = bool(re.match(r"^[ \t]*`{3,}[a-zA-Z0-9_-]*[ \t]*$", line))
        is_close = bool(re.match(r"^[ \t]*`{3,}[ \t]*$", line))
        if in_fence:
            if is_close:
                in_fence = False
            out.append(line)
            continue
        if is_open:
            in_fence = True
            last_open_idx = len(out)
            out.append(line)
            continue
        out.append(line)
    if in_fence and last_open_idx >= 0:
        out.pop(last_open_idx)
    return "\n".join(out)



# ---------------------------------------------------------------------------
# 2. JSON Pointer (RFC 6901) 工具
# ---------------------------------------------------------------------------


def _parse_pointer(path: str) -> list[str]:
    """RFC 6901 JSON Pointer → token 列表。"""
    if not path or path == "/":
        return []
    if not path.startswith("/"):
        # 宽松：不以 / 开头也接受（当单段处理）
        return [path]
    tokens = path[1:].split("/")
    return [t.replace("~1", "/").replace("~0", "~") for t in tokens]


def _is_readonly(token: str, prefix: str) -> bool:
    return token.startswith(prefix)


def _pointer_get(obj: Any, tokens: list[str]) -> tuple[bool, Any]:
    found, val = True, obj
    for tok in tokens:
        if isinstance(val, list):
            if tok == "-":
                return False, None
            try:
                idx = int(tok)
            except (ValueError, TypeError):
                return False, None
            if 0 <= idx < len(val):
                val = val[idx]
            else:
                return False, None
        elif isinstance(val, dict):
            if tok in val:
                val = val[tok]
            else:
                return False, None
        else:
            return False, None
    return found, val


def _pointer_set(
    obj: Any, tokens: list[str], value: Any, *, create_missing: bool = True
) -> bool:
    """在 *obj* 上沿 *tokens* 设置 *value*。返回是否成功。"""
    if not tokens:
        return False  # 根替换无意义
    cur = obj
    for i, tok in enumerate(tokens[:-1]):
        nxt_tok = tokens[i + 1]
        want_list = nxt_tok == "-" or nxt_tok.lstrip("-").isdigit()
        if isinstance(cur, list):
            if tok == "-":
                placeholder: Any = [] if want_list else {}
                cur.append(placeholder)
                cur = placeholder
                continue
            try:
                idx = int(tok)
            except (ValueError, TypeError):
                return False
            if 0 <= idx < len(cur):
                if cur[idx] is None and create_missing:
                    cur[idx] = [] if want_list else {}
                cur = cur[idx]
            elif create_missing and idx == len(cur):
                cur.append([] if want_list else {})
                cur = cur[-1]
            else:
                return False
        elif isinstance(cur, dict):
            if tok not in cur:
                if create_missing:
                    cur[tok] = [] if want_list else {}
                else:
                    return False
            cur = cur[tok]
        else:
            return False
    # 最后一个 token
    last = tokens[-1]
    if isinstance(cur, list):
        if last == "-":
            cur.append(value)
        else:
            try:
                idx = int(last)
            except (ValueError, TypeError):
                return False
            while len(cur) <= idx:
                cur.append(None)
            cur[idx] = value
    elif isinstance(cur, dict):
        cur[last] = value
    else:
        return False
    return True


def _pointer_remove(obj: Any, tokens: list[str]) -> bool:
    if not tokens:
        return False
    parent_tokens = tokens[:-1]
    last = tokens[-1]
    ok, parent = _pointer_get(obj, parent_tokens)
    if not ok:
        return False
    if isinstance(parent, list):
        try:
            idx = int(last)
        except (ValueError, TypeError):
            return False
        if 0 <= idx < len(parent):
            parent.pop(idx)
            return True
        return False
    if isinstance(parent, dict):
        return parent.pop(last, None) is not None
    return False


# ---------------------------------------------------------------------------
# 3. apply_patches —— RFC 6902 超集（replace/add/insert/remove/move/delta）
# ---------------------------------------------------------------------------


def _path_readonly(tokens: list[str], prefix: str) -> bool:
    return any(_is_readonly(t, prefix) for t in tokens)


def _coerce_number(val: Any) -> float | None:
    if isinstance(val, bool):  # bool 是 int 子类，排除
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        try:
            return float(val)
        except (ValueError, TypeError):
            return None
    return None


def apply_patches(
    stat_data: dict,
    patches: list[dict],
    *,
    readonly_prefix: str = "_",
) -> tuple[dict, list[str]]:
    """在 *stat_data* 的深拷贝上按顺序应用 *patches*。

    支持 op: replace / add / insert / remove / move / delta。
    返回 (新 stat_data, 变更日志列表)。
    """
    if not isinstance(stat_data, dict):
        stat_data = {"stat_data": stat_data} if stat_data else {}
    # 操作目标：stat_data 内部的 "stat_data" 子树（若有），否则直接 stat_data
    target = copy.deepcopy(stat_data.get("stat_data", stat_data))
    if not isinstance(target, dict):
        target = {} if target is None else target
    logs: list[str] = []

    for i, patch in enumerate(patches):
        if not isinstance(patch, dict):
            logs.append(f"[{i}] skip non-dict patch")
            continue
        op = str(patch.get("op", "")).lower().strip()
        path = patch.get("path")
        if not op or not path:
            logs.append(f"[{i}] skip patch missing op/path")
            continue
        tokens = _parse_pointer(str(path))
        if _path_readonly(tokens, readonly_prefix):
            logs.append(f"[{i}] skip readonly path {path}")
            continue

        try:
            if op == "replace":
                val = patch.get("value")
                ok = _pointer_set(target, tokens, copy.deepcopy(val))
                logs.append(f"[{i}] replace {path} → {'ok' if ok else 'fail'}")

            elif op == "add":
                val = patch.get("value")
                ok = _pointer_set(target, tokens, copy.deepcopy(val))
                logs.append(f"[{i}] add {path} → {'ok' if ok else 'fail'}")

            elif op == "insert":
                val = patch.get("value")
                # insert 语义：数组 '-' 追加；对象则等价 add
                ok, existing = _pointer_get(target, tokens)
                if isinstance(existing, list) and tokens and tokens[-1] == "-":
                    existing.append(copy.deepcopy(val))
                    ok = True
                else:
                    ok = _pointer_set(target, tokens, copy.deepcopy(val))
                logs.append(f"[{i}] insert {path} → {'ok' if ok else 'fail'}")

            elif op == "remove":
                ok = _pointer_remove(target, tokens)
                logs.append(f"[{i}] remove {path} → {'ok' if ok else 'fail'}")

            elif op == "move":
                from_tokens = _parse_pointer(str(patch.get("from", "")))
                if _path_readonly(from_tokens, readonly_prefix):
                    logs.append(f"[{i}] skip move from readonly {patch.get('from')}")
                    continue
                ok, val = _pointer_get(target, from_tokens)
                if ok:
                    _pointer_remove(target, from_tokens)
                    ok2 = _pointer_set(target, tokens, val)
                    logs.append(f"[{i}] move {patch.get('from')}→{path} → {'ok' if ok2 else 'fail'}")
                else:
                    logs.append(f"[{i}] move source not found {patch.get('from')}")

            elif op == "delta":
                delta_val = _coerce_number(patch.get("value"))
                ok, cur = _pointer_get(target, tokens)
                cur_num = _coerce_number(cur) if ok else None
                if cur_num is not None and delta_val is not None:
                    new_val = cur_num + delta_val
                    # 保持 int 类型（若原值是 int 且 delta 是 int）
                    if isinstance(cur, int) and isinstance(patch.get("value"), int):
                        new_val = int(new_val)
                    _pointer_set(target, tokens, new_val)
                    logs.append(f"[{i}] delta {path} {cur}+{delta_val}={new_val}")
                else:
                    logs.append(
                        f"[{i}] delta skip {path} (cur={cur!r} delta={patch.get('value')!r})"
                    )

            else:
                logs.append(f"[{i}] unknown op {op!r}")

        except Exception as exc:  # 单 op 异常不中断
            logs.append(f"[{i}] error op={op} path={path}: {exc}")
            logger.warning("MVU apply_patches op error: %s", exc, exc_info=True)

    result = copy.deepcopy(stat_data)
    result["stat_data"] = target
    return result, logs


# ---------------------------------------------------------------------------
# 4. zod schema 默认值提取（去 CDN，不执行 JS）
# ---------------------------------------------------------------------------

_Z_OBJECT_RE = re.compile(r"z\.object\s*\(")
_PREFAULT_RE = re.compile(r"\.prefault\s*\(")


def _match_braces(text: str, start: int, open_ch: str = "{", close_ch: str = "}") -> int:
    """从 *start*（指向 open_ch）开始匹配括号，返回 close_ch 的索引。未找到返回 -1。"""
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
    return -1


def _split_top_level_commas(text: str) -> list[str]:
    """按顶层逗号分割（忽略嵌套括号/引号内的逗号）。"""
    parts: list[str] = []
    depth = 0
    in_string = False
    escape = False
    buf: list[str] = []
    for ch in text:
        if in_string:
            buf.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            buf.append(ch)
        elif ch in "{[(":
            depth += 1
            buf.append(ch)
        elif ch in ")]}":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    last = "".join(buf).strip()
    if last:
        parts.append(last)
    return parts


def _parse_zod_value(expr: str) -> Any:
    """解析单个 zod 表达式，返回 Python 默认值。

    支持的 zod 形态：
      z.string().prefault('x')          → 'x'
      z.coerce.number()...prefault(50)   → 50
      z.number().prefault(0)             → 0
      z.boolean().prefault(true)         → True
      z.array(...)                       → []
      z.object({...}).prefault({})       → {嵌套字段各自的默认}
      无 .prefault                       → 类型零值
    """
    expr = expr.strip()
    if not expr:
        return None

    # 嵌套 z.object
    m = _Z_OBJECT_RE.search(expr)
    if m:
        # 找到 z.object( 后的第一个 {
        paren_start = expr.find("(", m.end() - 1)
        if paren_start == -1:
            return {}
        brace_start = expr.find("{", paren_start)
        if brace_start == -1:
            return {}
        brace_end = _match_braces(expr, brace_start)
        if brace_end == -1:
            return {}
        inner = expr[brace_start + 1 : brace_end]
        defaults = _parse_zod_object_body(inner)

        # 检查 .prefault({...}) 是否有显式覆盖
        after = expr[brace_end + 1 :]
        pm = _PREFAULT_RE.search(after)
        if pm:
            paren = after.find("(", pm.end() - 1)
            if paren != -1:
                arg_start = after.find("{", paren)
                if arg_start != -1:
                    arg_end = _match_braces(after, arg_start)
                    if arg_end != -1:
                        arg_str = after[arg_start : arg_end + 1]
                        explicit = _parse_js_object_literal(arg_str)
                        if isinstance(explicit, dict):
                            _deep_merge(defaults, explicit)
        return defaults

    # 标量类型 —— 用前缀匹配避免 z.array(z.string()) 误匹配 z.string
    is_array = bool(re.match(r"^z\.array\b", expr))
    is_string = not is_array and bool(re.match(r"^(z\.string|z\.coerce\.string)\b", expr))
    is_number = bool(re.match(r"^(z\.number|z\.coerce\.number)\b", expr))
    is_boolean = bool(re.match(r"^z\.boolean\b", expr))

    # 提取 .prefault(参数)
    prefault_val: Any = _UNSET
    pm = _PREFAULT_RE.search(expr)
    if pm:
        paren_start = expr.find("(", pm.end() - 1)
        if paren_start != -1:
            prefault_val = _extract_prefault_arg(expr, paren_start)

    if prefault_val is not _UNSET:
        return prefault_val
    # 无 prefault → 类型零值
    if is_string:
        return ""
    if is_number:
        return 0
    if is_boolean:
        return False
    if is_array:
        return []
    return None


_UNSET = object()


def _parse_js_object_literal(raw: str) -> dict | None:
    """解析 JS 对象字面量（key 可无引号），返回 dict。"""
    raw = raw.strip()
    if not raw.startswith("{") or not raw.endswith("}"):
        return None
    # 先试标准 JSON
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, ValueError):
        pass
    # 修复：给无引号的 key 加双引号
    # 匹配 { key: 或 , key: （key 不带引号；key 允许中文等 Unicode 词字符——
    # 此前 [A-Za-z_$][\w$]* 不认中文 key，prefault({ 中文名: ... }) 解析失败
    # 静默返回 {} 导致显式覆盖丢失，2026-08-24 存量失败根因）
    fixed = re.sub(r'([{,]\s*)([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*:', r'\1"\2":', raw)
    # 修复二：单引号字符串值 → 双引号（JS 对象字面量常用单引号，如
    # prefault({ 名字: '覆盖名' })——只修 key 不修 value 时 json.loads 仍失败，
    # 同样静默返回 {} 导致覆盖丢失）
    fixed = re.sub(
        r"'([^'\\]*(?:\\.[^'\\]*)*)'",
        lambda m: '"' + m.group(1).replace('"', '\\"') + '"',
        fixed,
    )
    # 去尾逗号
    fixed = re.sub(r",\s*}", "}", fixed)
    try:
        data = json.loads(fixed)
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, ValueError):
        return {}


def _extract_prefault_arg(expr: str, paren_start: int) -> Any:
    """从 .prefault( 后提取第一个参数值。"""
    rest = expr[paren_start + 1 :]
    rest_stripped = rest.lstrip()
    # 字符串字面量
    if rest_stripped.startswith("'"):
        end = rest.find("'", 1)
        if end != -1:
            return rest[1:end]
    if rest_stripped.startswith('"'):
        end = rest.find('"', 1)
        if end != -1:
            return rest[1:end]
    # 布尔
    if rest_stripped.startswith("true"):
        return True
    if rest_stripped.startswith("false"):
        return False
    # 对象/数组
    if rest_stripped.startswith("{"):
        end = _match_braces(rest, 0, "{", "}")
        if end != -1:
            try:
                return json.loads(rest[: end + 1])
            except (json.JSONDecodeError, ValueError):
                return {}
        return {}
    if rest_stripped.startswith("["):
        end = _match_braces(rest, 0, "[", "]")
        if end != -1:
            try:
                return json.loads(rest[: end + 1])
            except (json.JSONDecodeError, ValueError):
                return []
        return []
    # 数字
    num_match = re.match(r"(-?\d+\.?\d*)", rest_stripped)
    if num_match:
        s = num_match.group(1)
        if "." in s:
            return float(s)
        return int(s)
    return _UNSET


def _parse_zod_object_body(body: str) -> dict:
    """解析 z.object({...}) 内部 body，返回 {key: default_value}。"""
    result: dict[str, Any] = {}
    parts = _split_top_level_commas(body)
    for part in parts:
        if not part.strip():
            continue
        # key: value  （key 可能带引号）
        colon = _find_top_level_colon(part)
        if colon == -1:
            continue
        key_raw = part[:colon].strip()
        val_expr = part[colon + 1 :].strip()
        key = _unquote_key(key_raw)
        if not key:
            continue
        result[key] = _parse_zod_value(val_expr)
    return result


def _find_top_level_colon(text: str) -> int:
    """找到顶层冒号（不在嵌套括号/引号内）。"""
    depth = 0
    in_string = False
    escape = False
    for i, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[(":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == ":" and depth == 0:
            return i
    return -1


def _unquote_key(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] in "'\"" and raw[-1] == raw[0]:
        return raw[1:-1]
    # 去掉尾逗号
    return raw.rstrip(",").strip()


def _deep_merge(target: dict, source: dict) -> dict:
    """将 source 深合并到 target（source 覆盖）。"""
    for k, v in source.items():
        if (
            isinstance(v, dict)
            and isinstance(target.get(k), dict)
        ):
            _deep_merge(target[k], v)
        else:
            target[k] = v
    return target


def extract_schema_defaults(tavern_helper: dict) -> dict:
    """从 tavern_helper.scripts 内 zod schema 的 .prefault() 提取初始 stat_data 骨架。

    返回 stat_data dict（不含 "stat_data" 外层包裹）。
    提取失败返回 {}。
    """
    if not isinstance(tavern_helper, dict):
        return {}
    scripts = tavern_helper.get("scripts")
    if not isinstance(scripts, list):
        return {}
    for script in scripts:
        if not isinstance(script, dict):
            continue
        content = script.get("content", "")
        if not isinstance(content, str) or "z.object" not in content:
            continue
        try:
            # 找到 z.object( 后的 {
            for m in _Z_OBJECT_RE.finditer(content):
                paren_start = content.find("(", m.end() - 1)
                if paren_start == -1:
                    continue
                brace_start = content.find("{", paren_start)
                if brace_start == -1:
                    continue
                brace_end = _match_braces(content, brace_start)
                if brace_end == -1:
                    continue
                body = content[brace_start + 1 : brace_end]
                defaults = _parse_zod_object_body(body)
                if defaults:
                    return defaults
        except Exception:
            logger.warning("MVU: schema defaults extraction failed", exc_info=True)
            continue
    return {}


# ---------------------------------------------------------------------------
# 5. 初始变量合成
# ---------------------------------------------------------------------------

_INITVAR_RE = re.compile(r"<initvar>([\s\S]*?)</initvar>", re.IGNORECASE)


def _parse_initvar_block(block: str) -> dict:
    """解析 <initvar> 块内容。优先 JSON，否则缩进式。"""
    block = block.strip()
    # 尝试 JSON
    if block.startswith("{"):
        try:
            data = json.loads(block)
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, ValueError):
            pass
    # 缩进式解析
    return _parse_indented(block)


def _parse_indented(text: str) -> dict:
    """简单缩进式变量解析（兼容 ST getVariablesType）。"""
    lines = [l.replace("\t", "  ") for l in text.splitlines() if l.strip()]
    if not lines:
        return {}

    def indent_of(s: str) -> int:
        return len(s) - len(s.lstrip())

    def parse_block(idx: int, indent: int) -> tuple[dict, int]:
        result: dict = {}
        while idx < len(lines):
            line = lines[idx]
            li = indent_of(line)
            if li < indent:
                break
            if li > indent:
                idx += 1
                continue
            trimmed = line.strip()
            if trimmed.startswith("- "):
                break
            if ":" in trimmed:
                key, _, val = trimmed.partition(":")
                key = key.strip()
                val = val.strip()
                if val:
                    result[key] = _parse_scalar(val)
                    idx += 1
                else:
                    # 看下一行是否有更深缩进
                    if idx + 1 < len(lines) and indent_of(lines[idx + 1]) > indent:
                        child, idx = parse_block(idx + 1, indent_of(lines[idx + 1]))
                        result[key] = child
                    else:
                        result[key] = {}
                        idx += 1
            else:
                idx += 1
        return result, idx

    first_indent = indent_of(lines[0])
    result, _ = parse_block(0, first_indent)
    return result


def _parse_scalar(val: str) -> Any:
    val = val.strip()
    if not val:
        return ""
    if val.startswith('"') and val.endswith('"'):
        return val[1:-1]
    if val.startswith("'") and val.endswith("'"):
        return val[1:-1]
    if val.lower() == "true":
        return True
    if val.lower() == "false":
        return False
    if val.lower() in ("null", "none"):
        return None
    try:
        if "." in val:
            return float(val)
        return int(val)
    except (ValueError, TypeError):
        return val


def _extract_initvar_from_text(text: str) -> dict:
    """从 *text* 提取所有 <initvar> 块并深合并为一个 dict（后者覆盖前者）。"""
    result: dict = {}
    if not isinstance(text, str):
        return result
    for block in _INITVAR_RE.findall(text):
        parsed = _parse_initvar_block(block)
        if not parsed:
            continue
        normalized = parsed.get("stat_data", parsed)
        if isinstance(normalized, dict):
            result = _deep_merge(result, copy.deepcopy(normalized))
    return result


def merge_character_book_entries(
    character_extensions: dict, world_book_entries: list | None
) -> dict:
    """将角色的 character_book entries（WorldBookStage.content 列表）合并进 extensions。

    角色卡内嵌的 world book 在导入时存入 world_books（type='character_book'）表，
    并不在 char.extensions 中。调用点需从 world_books 取出全部 entry content，
    注入到传入的 character_extensions，供 build_initial_stat_data 提取 <initvar>。
    返回新的 dict（不改动入参）。
    """
    if not isinstance(character_extensions, dict):
        character_extensions = {}
    merged = copy.deepcopy(character_extensions)
    if not world_book_entries:
        return merged
    cb = merged.get("character_book")
    if not isinstance(cb, dict):
        cb = {}
        merged["character_book"] = cb
    entries = cb.get("entries")
    if not isinstance(entries, dict):
        entries = {}
        cb["entries"] = entries
    for idx, content in enumerate(world_book_entries):
        if not isinstance(content, str):
            continue
        entries[str(idx)] = {"content": content}
    return merged


def _raw_card_data(character_extensions: dict) -> dict:
    """取 `palink_raw_card_data`（导入时写入的原始卡快照，v2/v3 结构）。"""
    raw = character_extensions.get("palink_raw_card_data")
    return raw if isinstance(raw, dict) else {}


def _raw_card_data_payload(raw: dict) -> dict:
    """raw 卡的 `data` 层（v3 结构；v2 无此层则返回空 dict）。"""
    data = raw.get("data")
    return data if isinstance(data, dict) else {}


def _card_field_variants(character_extensions: dict, field: str) -> list:
    """收集某问候字段（first_mes / alternate_greetings）的**全部**可用形态，按优先级升序返回。

    [T1 2026-09-30] 历史 BUG：这里以前只读 `character_extensions` **顶层**，
    而真实卡（palink_raw_card_data 结构）的 first_mes/alternate_greetings 在
    `palink_raw_card_data.data.*`（v3）或 `palink_raw_card_data.*`（v2）嵌套层 →
    提取扑空 → 卡 schema 的 zod prefault 占位值（年=1/月=1/魔力值=100/饥饿度=0/
    当前位置=未知）成了会话初始变量 → 注入提示词后与剧情上下文全面矛盾 → 模型
    思考死循环（2026-09-30 实测 10605 reasoning tokens / 正文 1005 字符）。
    权威取证：docs/SPEC_MVU初始变量断链与输出tag裸显修复_2026-09-30.md。

    优先级（后者覆盖前者，与 `_deep_merge` 语义一致）：
      1. extensions 顶层（legacy 结构，先于 raw 快照的老存储位）
      2. palink_sillytavern.card_fields.*（导入时保留的深水区副本）
      3. palink_raw_card_data.*（v2 快照顶层）
      4. palink_raw_card_data.data.*（v3 快照权威层）
      → 调用点传入的数据库列值（见 build_initial_stat_data 的显式参数）优先级最高，
        由调用方追加在末尾。
    """
    variants: list = []
    ext = character_extensions

    def _push(value) -> None:
        # 空串/空列表视为"该来源没有"，不参与合并（避免用空值覆盖有效来源）
        if isinstance(value, str):
            if value.strip():
                variants.append(value)
            return
        if isinstance(value, list) and value:
            variants.append(value)

    _push(ext.get(field))

    st = ext.get("palink_sillytavern")
    if isinstance(st, dict):
        card_fields = st.get("card_fields")
        if isinstance(card_fields, dict):
            _push(card_fields.get(field))

    raw = _raw_card_data(ext)
    if raw:
        _push(raw.get(field))
        _push(_raw_card_data_payload(raw).get(field))

    return variants


def _coerce_greeting_values(value) -> list:
    """把调用点传来的列值规整为 list（JSON 字符串 / list / 单条字符串 / None）。"""
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if text[0] in "[{":
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                return [value]
            return _coerce_greeting_values(parsed)
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item.strip()]
    return []


def _character_book_variants(character_extensions: dict) -> list[list]:
    """收集 character_book 的 entries（多个存储形态），按优先级升序返回。

    同 first_mes 的历史问题：卡内嵌 world book 有三个落点——导入快照的
    `palink_raw_card_data.data.character_book`（v3）/ `palink_raw_card_data.character_book`（v2）、
    导入保留副本 `palink_sillytavern.card_fields.character_book`，以及**权威落点**
    `character_extensions.character_book`（由 `merge_character_book_entries` 从
    world_books 表合并而来，用户可编辑）。前两者只做兜底，权威落点必须排最后（覆盖）。
    """
    groups: list[list] = []

    def _push_entries(container) -> None:
        if not isinstance(container, dict):
            return
        entries = container.get("entries")
        if isinstance(entries, dict):
            entries = list(entries.values())
        if isinstance(entries, list) and entries:
            groups.append(entries)

    ext = character_extensions
    raw = _raw_card_data(ext)
    if raw:
        _push_entries(raw.get("character_book"))
        payload = _raw_card_data_payload(raw)
        if payload:
            _push_entries(payload.get("character_book"))

    st = ext.get("palink_sillytavern")
    if isinstance(st, dict):
        card_fields = st.get("card_fields")
        if isinstance(card_fields, dict):
            _push_entries(card_fields.get("character_book"))

    # 权威落点（world_books 合并结果）最后 → 优先级最高
    _push_entries(ext.get("character_book"))
    return groups


def _extract_initvar_from_character_book(character_extensions: dict) -> dict:
    """从角色的 character_book entries 提取 <initvar> 块（多存储形态，后者覆盖前者）。

    角色卡内嵌的 world book（character_book）常以禁用状态携带 <initvar> 初始变量
    （作者注释"变量初始化勿开"），用于提供头像 URL、服饰、内心想法等初始值。
    这里仅提取其内容用于初始化 stat_data，不参与 prompt 注入（enabled 保持原样）。
    """
    result: dict = {}
    if not isinstance(character_extensions, dict):
        return result
    for entries in _character_book_variants(character_extensions):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            content = entry.get("content")
            if isinstance(content, str):
                result = _deep_merge(result, _extract_initvar_from_text(content))
    return result


def build_initial_stat_data(
    character_extensions: dict,
    *,
    first_mes: str | None = None,
    alternate_greetings=None,
) -> dict:
    """合成会话初始 stat_data。

    优先级（后者深合并覆盖前者）：
      1. schema 默认值
      2. tavern_helper.variables
      3. first_mes / alternate_greetings 内 <initvar> 块（按存储形态多源，见 `_card_field_variants`）
      4. character_book.entries 内 <initvar> 块（头像 URL、服饰、内心想法等初始值）

    [T1 2026-09-30] 新增可选入参 `first_mes` / `alternate_greetings`：调用点应传
    `characters` 表**列值**（live 值，用户可在卡编辑器里改），它优先于
    `palink_raw_card_data` 里的导入快照（该快照只在导入时写一次，永不回写）。

    返回 {"stat_data": {...}}。
    """
    if not isinstance(character_extensions, dict):
        character_extensions = {}

    stat_data: dict = {}

    # 1. schema 默认值
    th = character_extensions.get("tavern_helper")
    if isinstance(th, dict):
        schema_defaults = extract_schema_defaults(th)
        if schema_defaults:
            stat_data = _deep_merge(stat_data, copy.deepcopy(schema_defaults))
        # 2. tavern_helper.variables
        variables = th.get("variables")
        if isinstance(variables, dict) and variables:
            stat_data = _deep_merge(stat_data, copy.deepcopy(variables))

    # 3. <initvar> 块（从 first_mes / alternate_greetings 提取，多存储形态按优先级升序合并）
    for text in _card_field_variants(character_extensions, "first_mes"):
        stat_data = _deep_merge(stat_data, _extract_initvar_from_text(text))
    # 显式入参（数据库列值）优先级最高，追加在末尾
    for text in _coerce_greeting_values(first_mes):
        stat_data = _deep_merge(stat_data, _extract_initvar_from_text(text))

    for greetings in _card_field_variants(character_extensions, "alternate_greetings"):
        for greeting in greetings:
            stat_data = _deep_merge(stat_data, _extract_initvar_from_text(greeting))
    for greeting in _coerce_greeting_values(alternate_greetings):
        stat_data = _deep_merge(stat_data, _extract_initvar_from_text(greeting))

    # 4. character_book.entries 内 <initvar> 块（最后合并，覆盖 schema 空默认值）
    stat_data = _deep_merge(
        stat_data, _extract_initvar_from_character_book(character_extensions)
    )

    return {"stat_data": stat_data}


# ---------------------------------------------------------------------------
# 6. MvuEngine 薄封装（供集成层调用）
# ---------------------------------------------------------------------------


class MvuEngine:
    """无状态封装，供 websocket.py / character_ext.py 集成层调用。"""

    @staticmethod
    def init_session_variables(
        character_extensions: dict,
        *,
        first_mes: str | None = None,
        alternate_greetings=None,
    ) -> dict:
        """返回会话初始变量 {"stat_data": {...}}。

        [T1 2026-09-30] 调用点应传角色卡的**列值**（`characters.first_mes` /
        `characters.alternate_greetings`），它优先于 extensions 里的导入快照。
        """
        return build_initial_stat_data(
            character_extensions,
            first_mes=first_mes,
            alternate_greetings=alternate_greetings,
        )

    @staticmethod
    def update_from_reply(
        current_variables: dict,
        reply_text: str,
        character_extensions: dict,
        *,
        first_mes: str | None = None,
        alternate_greetings=None,
    ) -> tuple[dict, list[str], list[dict]]:
        """解析 AI 回复中的 <UpdateVariable> 并应用到 *current_variables*。

        返回 ``(新 variables, 变更日志, 应用的补丁)``。

        第三个返回值是**按顺序展平的 JSON Patch 列表**（多块时按块序拼接 ——
        与逐块 apply 等价，因为 apply_patches 本身就是顺序处理）。
        它的用途是**留存补丁以支撑「清理后重演恢复」**：正文里的
        ``<UpdateVariable>`` 在后端落库前会被剥离且不留原文，所以恢复不能像
        MVU 插件那样重新解析正文（见 ``mvu_cleanup.py`` 文件头）。
        调用方把它写进 ``msg.extra["mvu_patch"]``；清理只动 ``extra["variables"]``，
        天然不会碰到补丁。

        若 current_variables 为空且有 schema，先兜底初始化（同样接受列值入参）。
        """
        if not isinstance(current_variables, dict):
            current_variables = {"stat_data": {}}

        # 兜底初始化
        if not current_variables.get("stat_data"):
            current_variables = build_initial_stat_data(
                character_extensions,
                first_mes=first_mes,
                alternate_greetings=alternate_greetings,
            )

        blocks = extract_update_variable_blocks(reply_text)
        if not blocks:
            return current_variables, [], []

        new_vars = current_variables
        all_logs: list[str] = []
        applied: list[dict] = []
        for block_idx, patches in enumerate(blocks):
            new_vars, logs = apply_patches(new_vars, patches)
            all_logs.extend(f"[block{block_idx}] {l}" for l in logs)
            applied.extend(patches)
        return new_vars, all_logs, applied
