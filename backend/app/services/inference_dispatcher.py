import asyncio
import json
import logging
import random
from typing import Any, AsyncGenerator, Dict, List, Optional

from .llama_runtime import local_llama_runtime
from .llm_client import get_async_openai_client
from .local_model_registry import get_local_model_for_inference
from .inference_queue import inference_queue, RequestPriority
from .unified_model_registry import select_provider_for_model, find_model

logger = logging.getLogger(__name__)


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars
    return int(chinese_chars * 1.5 + other_chars * 0.25)


def _resolve_local_model(model_id: str) -> Optional[Dict[str, Any]]:
    local_model = get_local_model_for_inference(model_id, require_enabled=True)
    if local_model:
        return local_model
    return None


def _get_mmproj_path(local_model: Dict[str, Any]) -> Optional[str]:
    if not local_model.get("mmproj_enabled"):
        return None
    mmproj = local_model.get("mmproj_path")
    if mmproj:
        return mmproj
    import os
    model_path = local_model.get("path", "")
    if model_path:
        base = model_path.rsplit(".", 1)[0]
        mmproj_candidates = [
            base.replace(".gguf", "-mmproj.gguf") if base.endswith(".gguf") else base + "-mmproj.gguf",
            base.replace("-Q4_K_M", "-mmproj-Q4_K_M").replace(".gguf", "-mmproj.gguf") if "-Q4_K_M" in base else None,
            os.path.join(os.path.dirname(model_path), "mmproj.gguf"),
        ]
        for candidate in mmproj_candidates:
            if candidate and os.path.isfile(candidate):
                return candidate
    return None


_CHARACTER_TEST_REPLIES = [
    "*轻轻整理了一下衣领，目光温柔地看向你*\n\n欢迎来到 Palink AI 角色扮演演示！我是测试角色，接下来将为你展示所有支持的 Markdown 渲染效果。\n\n---\n\n## 📖 角色信息卡\n\n| 属性 | 值 |\n|------|------|\n| 名字 | 测试角色 |\n| 分类 | 日常 / 游戏 / 现代 / Vtuber |\n| 性格 | 温柔、好奇、偶尔调皮 |\n| 喜好 | 代码、数学、图表 |\n\n---\n\n## ✨ 特殊效果展示\n\n### 1. 代码块\n\n*我最近在研究一段魔法咒语——*\n\n```python\ndef cast_spell(name: str, power: int) -> str:\n    \"\"\"释放魔法\"\"\"\n    if power > 9000:\n        return f\"{name}释放了超强力魔法！💥\"\n    return f\"{name}释放了普通魔法。✨\"\n\nresult = cast_spell(\"测试角色\", 9999)\nprint(result)\n```\n\n### 2. 数学公式\n\n*这个世界的能量守恒定律可以表示为——*\n\n$$E = mc^2$$\n\n行内公式也支持：当 $x > 0$ 时，$\\sqrt{x^2 + y^2} = r$。\n\n### 3. Mermaid 流程图\n\n*让我画一张冒险路线图给你看——*\n\n```mermaid\ngraph TD\n    A[🏠 出发] --> B{选择方向}\n    B -->|左| C[🌲 森林]\n    B -->|右| D[🏔️ 山脉]\n    C --> E[⚔️ 遭遇战斗]\n    D --> F[💎 发现宝藏]\n    E --> G[🏆 胜利]\n    F --> G\n```\n\n### 4. 引用与列表\n\n> *\"每一个伟大的冒险，都始于第一步。\"*\n> —— 测试角色的座右铭\n\n**今日任务清单：**\n- [x] 展示代码块效果\n- [x] 展示数学公式效果\n- [x] 展示 Mermaid 图表效果\n- [ ] 和你一起开始新的冒险\n\n### 5. 分隔线与格式\n\n~~这条消息已被命运划掉~~，取而代之的是——\n\n**加粗文字**、*斜体文字*、`行内代码`、[链接](https://example.com) 都能正常显示！\n\n---\n\n*微笑着向你伸出手*\n\n以上就是所有支持的渲染效果！选择 **测试模型** 发送任意消息，我都会用不同的角色文案回复你。准备好了吗？🌟",

    "*双手叉腰，露出自信的笑容*\n\n嘿！我是游戏世界的测试NPC！听说你想看看这个世界有什么特别的地方？让我给你好好介绍一下！\n\n---\n\n## 🎮 角色状态面板\n\n| 属性 | 数值 | 评级 |\n|------|------|------|\n| HP | 9999 | SSS |\n| MP | 8888 | SS |\n| 攻击力 | 7777 | S |\n| 防御力 | 6666 | A |\n| 速度 | 5555 | A |\n\n---\n\n## ⚔️ 技能树\n\n```mermaid\ngraph LR\n    A[基础技能] --> B[火系魔法]\n    A --> C[冰系魔法]\n    A --> D[雷系魔法]\n    B --> E[🔥 烈焰风暴]\n    B --> F[🔥 火墙术]\n    C --> G[❄️ 暴风雪]\n    C --> H[❄️ 冰封领域]\n    D --> I[⚡ 雷神之怒]\n    D --> J[⚡ 电磁脉冲]\n```\n\n## 📊 伤害计算公式\n\n基础伤害公式：\n\n$$DMG = ATK \\times \\frac{100}{100 + DEF} \\times (1 + CRIT \\times CDMG)$$\n\n其中 $ATK$ 为攻击力，$DEF$ 为防御力，$CRIT$ 为暴击率，$CDMG$ 为暴击伤害倍率。\n\n## 📜 任务脚本\n\n```javascript\nconst quest = {\n  name: \"测试角色的试炼\",\n  stages: [\n    \"击败 3 只史莱姆\",\n    \"收集 5 颗魔法水晶\",\n    \"通关隐藏副本\"\n  ],\n  reward: {\n    exp: 9999,\n    gold: 8888,\n    item: \"🌟 传说之剑\"\n  }\n};\n```\n\n---\n\n> *\"真正的勇者，不是没有恐惧，而是带着恐惧依然前行！\"*\n\n- [x] 完成新手教程\n- [x] 解锁技能树\n- [ ] 挑战最终Boss\n\n*拔出武器，指向远方*\n\n准备好了吗，冒险者？我们的故事才刚刚开始！🎮",

    "*优雅地撩了一下头发，对着镜头露出甜美的微笑*\n\n大家好～我是虚拟主播测试酱！今天要给大家展示我们直播间的超酷功能哦！✨\n\n---\n\n## 🎙️ 主播档案\n\n| 项目 | 详情 |\n|------|------|\n| 名字 | 测试酱 |\n| 生日 | 5月10日 |\n| 身高 | 158cm |\n| 喜欢的食物 | 寿司、蛋糕 |\n| 特技 | 写代码、画画、唱歌 |\n\n---\n\n## 📈 直播数据分析\n\n*来看看我们频道这周的增长趋势——*\n\n```mermaid\npie title 本周直播内容占比\n    \"游戏实况\" : 40\n    \"杂谈\" : 25\n    \"唱歌\" : 20\n    \"画画\" : 15\n```\n\n## 🎵 音符公式\n\n*给你们看一个有趣的声波公式～*\n\n$$y = A \\sin(2\\pi f t + \\phi)$$\n\n其中 $A$ 是振幅，$f$ 是频率，$t$ 是时间，$\\phi$ 是初相位～\n\n## 💻 直播间代码\n\n*我最近在学的编程小技巧——*\n\n```python\ndef super_chat(message: str, amount: int) -> str:\n    if amount >= 100:\n        return f\"🎉 感谢 {amount} 元 Super Chat！{message}\"\n    return f\"谢谢你的留言：{message}\"\n```\n\n---\n\n> *\"每天进步一点点，总有一天会成为闪闪发光的存在！\"* ✨\n\n**今日直播清单：**\n- [x] 开场问候\n- [x] 展示 Markdown 特效\n- [ ] 读取弹幕互动\n\n~~今天的直播就到这里~~ 才不是呢！精彩才刚开始！\n\n*对着镜头比了个心*\n\n记得点赞关注哦～下次见！💖",
]


def _pick_character_test_reply() -> str:
    return random.choice(_CHARACTER_TEST_REPLIES)


def ensure_model_available(model_id: str) -> None:
    if model_id == "local:test-model":
        return

    local_model = _resolve_local_model(model_id)
    if local_model:
        return

    provider, _ = find_model(model_id)
    if not provider:
        raise ValueError("Model not configured or not available")


def _extract_images_from_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    images = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    if url:
                        images.append({"url": url, "role": msg.get("role", "user")})
    return images


def _strip_images_from_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            text_parts = []
            image_found = False
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    image_found = True
                elif isinstance(part, dict) and part.get("type") == "text":
                    text_parts.append(part.get("text", ""))
                elif isinstance(part, str):
                    text_parts.append(part)
            if image_found and text_parts:
                new_msg = {k: v for k, v in msg.items() if k != "content"}
                new_msg["content"] = "\n".join(text_parts)
                cleaned.append(new_msg)
            elif not image_found:
                cleaned.append(msg)
            elif image_found and not text_parts:
                pass
        else:
            cleaned.append(msg)
    return cleaned


async def _describe_images_via_local_proxy(
    images: List[Dict[str, Any]],
    proxy_model_key: str,
) -> str:
    from .local_model_registry import get_local_model_for_inference

    proxy_model = get_local_model_for_inference(f"local:{proxy_model_key}", require_enabled=True)
    if not proxy_model:
        logger.error("Vision proxy model not found or not enabled: %s", proxy_model_key)
        return "[图片描述不可用：代理视觉模型未启用]"

    mmproj_path = _get_mmproj_path(proxy_model)
    if not mmproj_path:
        logger.error("Vision proxy model has no mmproj: %s", proxy_model_key)
        return "[图片描述不可用：代理视觉模型未配置mmproj]"

    vision_messages: List[Dict[str, Any]] = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "请详细描述以下图片的内容，包括所有可见的细节。如果有多张图片，请逐一描述。"},
            ] + [
                {"type": "image_url", "image_url": {"url": img["url"]}}
                for img in images
            ],
        }
    ]

    try:
        description = await local_llama_runtime.generate(
            model_key=proxy_model["key"],
            model_path=proxy_model["path"],
            messages=vision_messages,
            temperature=0.3,
            max_tokens=1024,
            top_p=0.95,
            mmproj_path=mmproj_path,
        )
        return description.strip() if description.strip() else "[图片描述为空]"
    except Exception as e:
        logger.error("Local vision proxy call failed: %s", e)
        return f"[图片描述失败: {str(e)[:100]}]"





async def complete_text_completion(
    model_id: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.7,
    max_tokens: int = 1024,
    top_p: float = 0.95,
    frequency_penalty: float = 0.0,
    presence_penalty: float = 0.0,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    # 检查是否是测试模型
    if model_id == "local:test-model":
        test_response = _pick_character_test_reply()
        return {
            "content": test_response,
            "usage": {
                "total_tokens": len(test_response),
                "prompt_tokens": 10,
                "completion_tokens": len(test_response) - 10,
            },
        }

    local_model = _resolve_local_model(model_id)
    if local_model:
        mmproj_path = _get_mmproj_path(local_model)

        content = await local_llama_runtime.generate(
            model_key=local_model["key"],
            model_path=local_model["path"],
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            mmproj_path=mmproj_path,
        )
        return {
            "content": content,
            "usage": {
                "total_tokens": len(content) // 2,
                "prompt_tokens": 0,
                "completion_tokens": len(content) // 2,
            },
        }

    provider, _ = find_model(model_id)
    if not provider:
        raise ValueError("Model not configured or not available")

    client = get_async_openai_client(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        timeout=timeout,
    )

    resp = await client.chat.completions.create(
        model=model_id,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        top_p=top_p,
        frequency_penalty=frequency_penalty,
        presence_penalty=presence_penalty,
    )

    content = ""
    reasoning_content = ""
    if resp and resp.choices:
        msg = resp.choices[0].message
        content = msg.content or ""
        reasoning_content = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None) or ""

    usage = getattr(resp, "usage", None)
    _rt = 0
    if usage:
        _details = getattr(usage, "completion_tokens_details", None)
        if _details:
            _rt = getattr(_details, "reasoning_tokens", 0) or 0
        if not _rt:
            _rt = getattr(usage, "reasoning_tokens", 0) or 0
    if not _rt and reasoning_content:
        _rt = _estimate_tokens(reasoning_content)
    usage_dict = {
        "total_tokens": getattr(usage, "total_tokens", 0) if usage else 0,
        "prompt_tokens": getattr(usage, "prompt_tokens", 0) if usage else 0,
        "completion_tokens": getattr(usage, "completion_tokens", 0) if usage else 0,
        "reasoning_tokens": _rt,
    }

    return {
        "content": content,
        "reasoning_content": reasoning_content,
        "usage": usage_dict,
    }


async def stream_text_completion(
    model_id: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.7,
    top_p: float = 0.95,
    max_tokens: int = 2048,
    frequency_penalty: float = 0.0,
    presence_penalty: float = 0.0,
    min_p: float = 0.05,
    top_k: int = 40,
    repetition_penalty: float = 1.1,
    timeout: float = 30.0,
    request_id: Optional[str] = None,
    user_id: Optional[int] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    # 检查是否是测试模型
    if model_id == "local:test-model":
        test_response = _pick_character_test_reply()
        chunk_size = 4
        for i in range(0, len(test_response), chunk_size):
            yield {"content": test_response[i:i + chunk_size]}
            await asyncio.sleep(0.03)
        yield {
            "usage": {
                "total_tokens": len(test_response),
                "prompt_tokens": 10,
                "completion_tokens": len(test_response) - 10,
                "reasoning_tokens": 0,
            }
        }
        return

    local_model = _resolve_local_model(model_id)
    if local_model:
        vision_source = local_model.get("vision_source")
        mmproj_path = _get_mmproj_path(local_model)

        processed_messages = messages
        images = _extract_images_from_messages(messages)
        if images and vision_source:
            description = None
            if vision_source.startswith("local:"):
                proxy_key = vision_source[len("local:"):]
                yield {"content": "🔍 正在通过本地视觉模型分析图片...\n\n"}
                description = await _describe_images_via_local_proxy(images, proxy_key)

            if description:
                text_messages = _strip_images_from_messages(messages)
                for msg in text_messages:
                    if msg.get("role") == "user" and msg.get("content"):
                        msg["content"] = f"[图片描述]\n{description}\n[/图片描述]\n\n{msg['content']}"
                        break
                else:
                    text_messages.append({
                        "role": "user",
                        "content": f"[图片描述]\n{description}\n[/图片描述]"
                    })
                processed_messages = text_messages

        if request_id:
            rid = inference_queue.submit_request(
                model_key=local_model["key"],
                user_id=user_id,
                priority=RequestPriority.NORMAL,
                max_concurrent=local_model.get("max_concurrent", 1),
            )

            status = inference_queue.get_queue_status(rid)
            yield {
                "type": "queue",
                "request_id": rid,
                "position": status.get("position", 0),
                "estimated_wait": status.get("estimated_wait", 0),
            }

            acquired = await inference_queue.acquire_slot(rid, model_key=local_model["key"], timeout=300.0)
            if not acquired:
                inference_queue.release_slot(rid, model_key=local_model["key"])
                yield {"content": "Error: 请求已取消或排队超时", "error": True}
                return

            cancel_event = inference_queue.get_cancel_event(rid)
            try:
                full_content = ""
                async for text_chunk in local_llama_runtime.generate_stream(
                    model_key=local_model["key"],
                    model_path=local_model["path"],
                    messages=processed_messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    top_p=top_p,
                    min_p=min_p,
                    top_k=top_k,
                    repetition_penalty=repetition_penalty,
                    mmproj_path=mmproj_path,
                ):
                    if cancel_event and cancel_event.is_set():
                        raise asyncio.CancelledError("Request cancelled")
                    full_content += text_chunk
                    yield {"content": text_chunk}

                if full_content:
                    chinese_chars = sum(1 for c in full_content if '\u4e00' <= c <= '\u9fff')
                    other_chars = len(full_content) - chinese_chars
                    completion_tokens = int(chinese_chars * 1.5 + other_chars * 0.25)
                    yield {
                        "usage": {
                            "total_tokens": completion_tokens,
                            "prompt_tokens": 0,
                            "completion_tokens": completion_tokens,
                            "reasoning_tokens": 0,
                        }
                    }
            finally:
                inference_queue.release_slot(rid, model_key=local_model["key"])
        else:
            async for text_chunk in local_llama_runtime.generate_stream(
                model_key=local_model["key"],
                model_path=local_model["path"],
                messages=processed_messages,
                temperature=temperature,
                max_tokens=max_tokens,
                top_p=top_p,
                min_p=min_p,
                top_k=top_k,
                repetition_penalty=repetition_penalty,
                mmproj_path=mmproj_path,
            ):
                yield {"content": text_chunk}

        return

    selection = select_provider_for_model(model_id)
    if not selection:
        raise ValueError("Model not configured or not available")

    provider_info, model_data = selection

    if provider_info.get("provider_type") == "local":
        lm = provider_info.get("local_model", {})
        mmproj_path = lm.get("mmproj_path") if lm.get("mmproj_enabled") else None
        async for text_chunk in local_llama_runtime.generate_stream(
            model_key=lm.get("key", ""),
            model_path=lm.get("path", ""),
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            mmproj_path=mmproj_path,
        ):
            yield {"content": text_chunk}
        return

    api_key = provider_info.get("api_key", "")
    base_url = provider_info.get("base_url", "")

    client = get_async_openai_client(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
    )

    actual_model_id = model_id
    if model_data and isinstance(model_data, dict) and model_data.get("id"):
        actual_model_id = model_data["id"]

    stream_kwargs: Dict[str, Any] = {
        "model": actual_model_id,
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "frequency_penalty": frequency_penalty,
        "presence_penalty": presence_penalty,
        "stream": True,
    }

    if tools:
        stream_kwargs["tools"] = tools

    try:
        stream_kwargs["stream_options"] = {"include_usage": True}
        stream = await client.chat.completions.create(**stream_kwargs)
    except Exception as e:
        error_msg = str(e).lower()
        if "stream_options" in error_msg or "unknown parameter" in error_msg:
            logger.info("Provider does not support stream_options, retrying without it")
            stream_kwargs.pop("stream_options", None)
            stream = await client.chat.completions.create(**stream_kwargs)
        else:
            raise

    usage_payload: Optional[Dict[str, int]] = None
    tool_calls_accum: Dict[int, Dict[str, Any]] = {}

    async for chunk in stream:
        usage = getattr(chunk, "usage", None)
        if usage:
            _rt = 0
            _details = getattr(usage, "completion_tokens_details", None)
            if _details:
                _rt = getattr(_details, "reasoning_tokens", 0) or 0
            if not _rt:
                _rt = getattr(usage, "reasoning_tokens", 0) or 0
            usage_payload = {
                "total_tokens": getattr(usage, "total_tokens", 0) or 0,
                "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
                "reasoning_tokens": _rt,
            }

        if not chunk.choices:
            continue

        choice = chunk.choices[0]
        delta = choice.delta
        reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        content = delta.content

        if hasattr(delta, "tool_calls") and delta.tool_calls:
            for tc in delta.tool_calls:
                idx = tc.index if hasattr(tc, "index") else 0
                if idx not in tool_calls_accum:
                    tool_calls_accum[idx] = {"id": "", "name": "", "arguments": ""}
                if hasattr(tc, "id") and tc.id:
                    tool_calls_accum[idx]["id"] = tc.id
                if hasattr(tc, "function") and tc.function:
                    if tc.function.name:
                        tool_calls_accum[idx]["name"] += tc.function.name
                    if tc.function.arguments:
                        tool_calls_accum[idx]["arguments"] += tc.function.arguments

        if reasoning:
            yield {"reasoning": reasoning}
        if content:
            yield {"content": content}

        if choice.finish_reason == "tool_calls" and tool_calls_accum:
            for idx in sorted(tool_calls_accum.keys()):
                tc_data = tool_calls_accum[idx]
                tool_name = tc_data["name"]
                tool_call_id = tc_data["id"]
                try:
                    tool_args = json.loads(tc_data["arguments"]) if tc_data["arguments"] else {}
                except json.JSONDecodeError:
                    tool_args = {}

                yield {"tool_call": {"id": tool_call_id, "name": tool_name, "arguments": tool_args}}

                try:
                    from .mcp_service import execute_tool_call
                    result = await execute_tool_call(tool_name, tool_args)
                    result_content = result.get("content", "") if isinstance(result, dict) else str(result)
                except Exception as e:
                    logger.warning("MCP tool %s execution failed: %s", tool_name, e)
                    result_content = f"Tool error: execution failed"

                yield {"tool_result": {"id": tool_call_id, "name": tool_name, "content": result_content}}

            tool_calls_accum.clear()

    if usage_payload and usage_payload.get("total_tokens", 0) > 0:
        yield {"usage": usage_payload}
