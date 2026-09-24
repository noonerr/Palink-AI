"""内置工具注册表（PLAN_模型自主出图 的 S1/S2：模型在角色扮演里自己决定配图）。

服务端执行回路（inference_dispatcher）原本只能执行外部 MCP server 的工具
（`_tool_name_registry` + `_active_connections`）；本模块让**进程内能力**（出图）
以 OpenAI function tool 的形状暴露给模型，并在 dispatcher 的分派链里被精确
匹配执行。不建 MCP 服务（一个常驻进程 + JSON-RPC + 连接管理收益为零），
也不放宽 `MCP_ALLOWED_ROLES` 全局闸——内置工具的权限在暴露端逐用户判定。

命名空间约定：内置工具以 `palink__` 前缀注册，但分派按**精确名**匹配
（非前缀通配），避免误吞前端插件可能注册的同前缀工具。

时序契约（S2 的关键决策）：工具调用发生在流式生成的**中途**，此时 assistant
消息尚未落库（persist_snapshot 首增量才建行），`extra.media` 无处可挂。因此
handler 不当场出图，只做门控 + 暂存（`ModelImageRequestGate`），真正的生成
延后到消息落库后由调用方的出图钩子执行——与既有自动出图（P1）同一时机，
事件契约与前端收敛逻辑完全复用。
"""

import json
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

BUILTIN_TOOL_PREFIX = "palink__"

GENERATE_IMAGE_TOOL_NAME = f"{BUILTIN_TOOL_PREFIX}generate_image"

# 单轮（一次生成）最多接受的配图请求数；超出直接拒绝，防模型反复调用打爆额度
MAX_IMAGE_REQUESTS_PER_GENERATION = 1

# 模型给出的画面描述上限（超出截断，不拒绝——模型偶尔话痨不该让配图失败）
MAX_IMAGE_PROMPT_CHARS = 2000

# 合并后 tools 的总量上限（前端插件工具 + 内置工具），防异常膨胀打爆请求体
MAX_MERGED_TOOLS = 64

GENERATE_IMAGE_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": GENERATE_IMAGE_TOOL_NAME,
        "description": (
            "为本条回复配一张插图。仅当画面对当前回复明显增色时调用（如场景"
            "描写、外貌登场），日常对话不要调用。prompt 用第三人称的画面描述"
            "（场景 / 人物外貌与动作 / 构图与氛围），不要要求图中出现文字。"
            "每次回复最多调用一次，图片会在回复结束后生成并附在本条消息上。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "画面描述（关键词或短句，具体、可视化、不含对话）",
                },
            },
            "required": ["prompt"],
        },
    },
}

_BUILTIN_TOOLS: Dict[str, Dict[str, Any]] = {
    GENERATE_IMAGE_TOOL_NAME: GENERATE_IMAGE_SCHEMA,
}


def is_builtin_tool(name: str) -> bool:
    """精确名匹配（勿改成前缀判断：同前缀名可能是前端插件工具）。"""
    return name in _BUILTIN_TOOLS


def get_builtin_tools_openai_format() -> List[Dict[str, Any]]:
    return [json.loads(json.dumps(schema)) for schema in _BUILTIN_TOOLS.values()]


def merge_builtin_tools(tools: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """前端插件工具 + 内置工具合并：内置在前，按 function.name 去重（内置优先）。

    总量超过 MAX_MERGED_TOOLS 时优先保留内置工具与先到的插件工具。
    """
    merged: List[Dict[str, Any]] = get_builtin_tools_openai_format()
    seen = {t.get("function", {}).get("name") for t in merged}
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        name = tool.get("function", {}).get("name") if isinstance(tool.get("function"), dict) else None
        if not name or name in seen:
            continue
        seen.add(name)
        merged.append(tool)
        if len(merged) >= MAX_MERGED_TOOLS:
            break
    return merged


class ModelImageRequestGate:
    """一次生成内的配图请求暂存与限额（S4 护栏：每轮最多 1 张）。

    handler 在流中写入，调用方在消息落库后 `take()` 消费；生成失败或
    消息未落库时请求被静默丢弃（用户看到的是没有图，而不是报错）。
    """

    def __init__(self) -> None:
        self._prompt: Optional[str] = None

    def submit(self, prompt: str) -> bool:
        """返回 False 表示本轮已满额（调用方据此回结构化拒绝）。"""
        if self._prompt is not None:
            return False
        self._prompt = prompt[:MAX_IMAGE_PROMPT_CHARS]
        return True

    def take(self) -> Optional[str]:
        prompt = self._prompt
        self._prompt = None
        return prompt


# handler 返回给模型的统一话术：拒绝必须可读、可继续（模型据此回到纯文本，
# 而不是把工具失败当剧情素材继续编）。
_REFUSE_UNAVAILABLE = "配图功能当前不可用，请直接以纯文本继续回复，不要再调用本工具。"
_REFUSE_DUPLICATE = "本轮已接受过一次配图请求，本次调用被忽略。请继续以纯文本完成回复。"
_REFUSE_EMPTY_PROMPT = "配图请求被拒绝：prompt 为空。请直接以纯文本继续回复。"
_ACCEPT = (
    "配图请求已接受：本条回复结束后将按 prompt 生成图片并附在本条消息上。"
    "请继续以纯文本完成回复，不要再调用本工具，也不要向用户复述工具细节。"
)


def make_builtin_tool_handler(
    gate: ModelImageRequestGate,
) -> Callable[[str, Dict[str, Any]], Awaitable[str]]:
    """构造 dispatcher 用的内置工具执行回调：(tool_name, tool_args) -> 结果短文本。

    只做门控 + 校验 + 暂存，**不当场出图**（时序契约见模块 docstring）。
    权限在暴露端已判定（工具只在开关+服务商就绪时合并进 tools），此处不再
    重复查库——未授权用户根本看不到这个工具。
    """

    async def handler(tool_name: str, tool_args: Dict[str, Any]) -> str:
        if tool_name != GENERATE_IMAGE_TOOL_NAME:
            return f"未知内置工具：{tool_name}。请以纯文本继续回复。"
        prompt = str((tool_args or {}).get("prompt") or "").strip()
        if not prompt:
            return _REFUSE_EMPTY_PROMPT
        if not gate.submit(prompt):
            return _REFUSE_DUPLICATE
        return _ACCEPT

    return handler


def resolve_generation_tools(
    tools: Optional[List[Dict[str, Any]]],
    *,
    image_enabled: bool,
) -> Tuple[List[Dict[str, Any]], Optional[ModelImageRequestGate], Optional[Callable[..., Awaitable[str]]]]:
    """S3 的合并决策点：按 image_enabled 决定 tools 形状与内置 handler。

    - 关闭：`(tools, None, None)`——tools 是**原对象**原样透传，保证与改前
      逐字节一致（回滚证据）；
    - 开启：合并内置出图工具 + 配套 gate/handler。

    `image_enabled` 由调用方判定（用户级开关 + 服务商就绪），本函数不查库。
    """
    if not image_enabled:
        return tools, None, None
    gate = ModelImageRequestGate()
    return merge_builtin_tools(tools), gate, make_builtin_tool_handler(gate)
