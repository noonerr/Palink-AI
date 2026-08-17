"""ST 1.18.0 聊天导入格式转换器。

将多种第三方聊天格式（Oobabooga / Agnai / CAI Tools / Kobold Lite / RisuAI）
转换为 Palink 内部消息列表（与 _parse_jsonl_chat 输出格式一致）。

参考: SillyTavern-1.18.0/src/endpoints/chats.js:110-308
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Union


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_header() -> dict[str, Any]:
    """构造 ST JSONL 头部（metadata 行）。"""
    return {
        "chat_metadata": {},
        "user_name": "unused",
        "character_name": "unused",
    }


def _make_message(
    *,
    name: str,
    is_user: bool,
    mes: str,
    send_date: str | None = None,
) -> dict[str, Any]:
    """构造单条 ST 消息对象。"""
    return {
        "name": name,
        "is_user": is_user,
        "send_date": send_date or _now_iso(),
        "mes": mes,
        "extra": {},
    }


def import_ooba_chat(
    user_name: str,
    character_name: str,
    json_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Oobabooga 格式转换。

    输入: ``{"data_visible": [[user_msg, char_msg], ...]}``
    输出: 头部 + user/char 交替的消息列表

    参考: ST 1.18.0 chats.js:110-142
    """
    chat: list[dict[str, Any]] = [_make_header()]
    data_visible = json_data.get("data_visible") or []
    if not isinstance(data_visible, list):
        return chat

    for arr in data_visible:
        if not isinstance(arr, (list, tuple)) or len(arr) < 1:
            continue
        if arr[0]:
            chat.append(
                _make_message(name=user_name, is_user=True, mes=str(arr[0]))
            )
        if len(arr) > 1 and arr[1]:
            chat.append(
                _make_message(name=character_name, is_user=False, mes=str(arr[1]))
            )
    return chat


def import_agnai_chat(
    user_name: str,
    character_name: str,
    json_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Agnai 格式转换。

    输入: ``{"messages": [{userId, msg}, ...]}``，userId 非空表示用户
    输出: 头部 + 消息列表

    参考: ST 1.18.0 chats.js:151-171
    """
    chat: list[dict[str, Any]] = [_make_header()]
    messages = json_data.get("messages") or []
    if not isinstance(messages, list):
        return chat

    for message in messages:
        if not isinstance(message, dict):
            continue
        is_user = bool(message.get("userId"))
        msg_text = message.get("msg")
        if msg_text is None:
            continue
        chat.append(
            _make_message(
                name=user_name if is_user else character_name,
                is_user=is_user,
                mes=str(msg_text),
            )
        )
    return chat


def _convert_cai_history(
    user_name: str,
    character_name: str,
    history: dict[str, Any],
) -> list[dict[str, Any]]:
    """转换单个 CAI history 为消息列表（不含头部）。"""
    starter = _make_header()
    msgs = history.get("msgs") or []
    if not isinstance(msgs, list):
        return [starter]

    history_data: list[dict[str, Any]] = []
    for msg in msgs:
        if not isinstance(msg, dict):
            continue
        src = msg.get("src") or {}
        if not isinstance(src, dict):
            src = {}
        is_human = bool(src.get("is_human"))
        text = msg.get("text")
        if text is None:
            continue
        history_data.append(
            _make_message(
                name=user_name if is_human else character_name,
                is_user=is_human,
                mes=str(text),
            )
        )
    return [starter, *history_data]


def import_cai_chat(
    user_name: str,
    character_name: str,
    json_data: dict[str, Any],
) -> list[list[dict[str, Any]]]:
    """CAI Tools 格式转换。

    输入: ``{"histories": {"histories": [{msgs: [{src: {is_human}, text}]}, ...]}}``
    输出: 多个独立聊天列表（每个 history 一个 chat）

    参考: ST 1.18.0 chats.js:180-206
    """
    histories_obj = json_data.get("histories") or {}
    if not isinstance(histories_obj, dict):
        return []
    histories = histories_obj.get("histories") or []
    if not isinstance(histories, list):
        return []

    return [
        _convert_cai_history(user_name, character_name, history)
        for history in histories
        if isinstance(history, dict)
    ]


def import_kobold_lite_chat(
    user_name: str,
    character_name: str,
    data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Kobold Lite 格式转换。

    输入: ``{"savedsettings": {chatname, chatopponent}, "actions": [msg, ...], "prompt": msg?}``
    其中消息通过 ``{{[INPUT]}}`` / ``{{[OUTPUT]}}`` 标识用户/角色

    输出: 头部 + 消息列表

    参考: ST 1.18.0 chats.js:215-248
    """
    input_token = "{{[INPUT]}}"
    output_token = "{{[OUTPUT]}}"

    def process_kobold_message(msg: str) -> dict[str, Any]:
        is_user = input_token in msg
        return _make_message(
            name=user_name if is_user else character_name,
            is_user=is_user,
            mes=msg.replace(input_token, "").replace(output_token, "").strip(),
        )

    # ST 实现: userName / characterName 来自 savedsettings（覆盖传入参数）
    saved = data.get("savedsettings") or {}
    if isinstance(saved, dict):
        if saved.get("chatname"):
            user_name = str(saved["chatname"])
        chatopponent = saved.get("chatopponent")
        if chatopponent:
            character_name = str(chatopponent).split("||$||")[0]

    chat: list[dict[str, Any]] = [_make_header()]
    actions = data.get("actions") or []
    if isinstance(actions, list):
        formatted: list[dict[str, Any]] = []
        for action in actions:
            if isinstance(action, str):
                formatted.append(process_kobold_message(action))
        # prompt 在最前
        prompt = data.get("prompt")
        if isinstance(prompt, str):
            formatted.insert(0, process_kobold_message(prompt))
        chat.extend(formatted)
    return chat


def import_risu_chat(
    user_name: str,
    character_name: str,
    json_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """RisuAI 格式转换。

    输入: ``{"type": "risuChat", "data": {"message": [{role, name, time, data}]}}``
    输出: 头部 + 消息列表

    参考: ST 1.18.0 chats.js:288-308
    """
    chat: list[dict[str, Any]] = [_make_header()]
    data_obj = json_data.get("data") or {}
    if not isinstance(data_obj, dict):
        return chat
    messages = data_obj.get("message") or []
    if not isinstance(messages, list):
        return chat

    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        is_user = role == "user"
        name = message.get("name")
        if not name:
            name = user_name if is_user else character_name
        # ST 使用 Number(message.time ?? Date.now())
        time_val = message.get("time")
        send_date: str | None = None
        if isinstance(time_val, (int, float)):
            send_date = datetime.fromtimestamp(
                int(time_val) / 1000.0, tz=timezone.utc
            ).isoformat()
        mes = message.get("data") or ""
        chat.append(
            _make_message(
                name=str(name),
                is_user=is_user,
                mes=str(mes),
                send_date=send_date,
            )
        )
    return chat


def detect_and_convert(
    user_name: str,
    character_name: str,
    json_data: dict[str, Any],
) -> Union[list[dict[str, Any]], list[list[dict[str, Any]]]]:
    """根据 jsonData 字段自动检测格式并调用对应转换器。

    返回:
    - 单聊天: list[dict]（与 _parse_jsonl_chat 输出格式一致）
    - 多聊天: list[list[dict]]（CAI Tools 格式可能返回多个独立聊天）

    参考: ST 1.18.0 chats.js:725-738
    """
    if "savedsettings" in json_data:
        return import_kobold_lite_chat(user_name, character_name, json_data)
    if "histories" in json_data:
        return import_cai_chat(user_name, character_name, json_data)
    if isinstance(json_data.get("data_visible"), list):
        return import_ooba_chat(user_name, character_name, json_data)
    if isinstance(json_data.get("messages"), list):
        return import_agnai_chat(user_name, character_name, json_data)
    if json_data.get("type") == "risuChat":
        return import_risu_chat(user_name, character_name, json_data)
    raise ValueError("Incorrect chat format .json")


__all__ = [
    "import_ooba_chat",
    "import_agnai_chat",
    "import_cai_chat",
    "import_kobold_lite_chat",
    "import_risu_chat",
    "detect_and_convert",
]
