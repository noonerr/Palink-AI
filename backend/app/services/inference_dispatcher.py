import asyncio
import json
import logging
import random
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, List, Optional

from .llama_runtime import local_llama_runtime
from .llm_client import get_async_openai_client
from .llm import select_adapter
from .local_model_registry import get_local_model_for_inference
from .inference_queue import inference_queue, RequestPriority
from .unified_model_registry import select_provider_for_model, find_model, get_model_output_cap, resolve_reasoning_effort
from .connection_profile_service import resolve_credentials
from ..core.config import settings
from ..core.database import SessionLocal
from ..models import User

logger = logging.getLogger(__name__)


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars
    return int(chinese_chars * 1.5 + other_chars * 0.25)


def _usage_int(usage: Any, name: str) -> int:
    if not usage:
        return 0
    value = getattr(usage, name, 0)
    if value:
        return int(value)
    if hasattr(usage, "model_extra") and isinstance(usage.model_extra, dict):
        return int(usage.model_extra.get(name, 0) or 0)
    if isinstance(usage, dict):
        return int(usage.get(name, 0) or 0)
    return 0


def _resolve_model_output_cap(model_id: str) -> Optional[int]:
    """按模型 ID 解析其硬上限（max_output_tokens，含用户覆盖与清单）；未知模型返回 None 不封顶。"""
    try:
        return get_model_output_cap(model_id)
    except Exception:
        return None


def _usage_nested_int(usage: Any, parent: str, name: str) -> int:
    if not usage:
        return 0
    details = getattr(usage, parent, None)
    if details is None and hasattr(usage, "model_extra") and isinstance(usage.model_extra, dict):
        details = usage.model_extra.get(parent)
    if details is None and isinstance(usage, dict):
        details = usage.get(parent)
    if not details:
        return 0
    if isinstance(details, dict):
        return int(details.get(name, 0) or 0)
    return int(getattr(details, name, 0) or 0)


def _build_usage_dict(usage: Any, reasoning_tokens: int = 0) -> Dict[str, int]:
    cache_read_input_tokens = _usage_int(usage, "cache_read_input_tokens")
    if not cache_read_input_tokens:
        cache_read_input_tokens = _usage_nested_int(usage, "prompt_tokens_details", "cached_tokens")
    return {
        "total_tokens": _usage_int(usage, "total_tokens"),
        "prompt_tokens": _usage_int(usage, "prompt_tokens"),
        "completion_tokens": _usage_int(usage, "completion_tokens"),
        "reasoning_tokens": int(reasoning_tokens or 0),
        "cache_creation_input_tokens": _usage_int(usage, "cache_creation_input_tokens"),
        "cache_read_input_tokens": cache_read_input_tokens,
    }


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
    "*轻轻整理了一下衣领，目光温柔地看向你*\n\n\"欢迎来到 Palink AI 角色扮演演示！\" 我是测试角色，接下来将为你展示所有支持的渲染效果。\n\n(这个人看起来很友善呢……先从基本的自我介绍开始吧)\n\n---\n\n## 🎭 角色扮演格式说明\n\n在角色扮演中，我们使用特殊的文本格式来区分不同类型的内容：\n\n- **对话** — 用英文双引号包裹：`\"你好\"` → 渲染为蓝色加粗对话\n- **内心独白** — 用英文括号包裹：`(好紧张)` → 渲染为紫色斜体思考\n- **动作描写** — 用星号包裹：`*微笑*` → 渲染为斜体动作\n- **旁白/叙述** — 普通文字，正常渲染\n\n---\n\n## 💬 对话效果展示\n\n\"你好呀！很高兴见到你！\"\n\n(第一次见面，要表现得自然一点)\n\n\"我叫测试角色，是一个喜欢冒险和探索的人。\"\n\n*微微歪了歪头，露出好奇的表情*\n\n\"你呢？你叫什么名字？\" 她眨了眨眼睛，(希望不会吓到对方) \"如果你不想说也没关系哦。\"\n\n---\n\n## 🧠 内心独白展示\n\n*看着窗外的风景，陷入了沉思*\n\n(今天天气真好……适合出去走走。但是还有好多事情没做完呢。算了，先陪这位新朋友聊聊吧。)\n\n\"你知道吗？\" 她突然转过头来，\"有时候我会在想，这个世界的尽头到底是什么样的。\"\n\n(其实我只是随口说说，别太当真啦)\n\n\"不过如果有你陪着的话，说不定真的可以去看看呢！\"\n\n---\n\n## 📖 角色信息卡\n\n| 属性 | 值 |\n|------|------|\n| 名字 | 测试角色 |\n| 分类 | 日常 / 游戏 / 现代 / Vtuber |\n| 性格 | 温柔、好奇、偶尔调皮 |\n| 喜好 | 代码、数学、图表 |\n\n---\n\n## ✨ Markdown 特效\n\n### 代码块\n\n*我最近在研究一段魔法咒语——*\n\n\"看好了！\"\n\n```python\ndef cast_spell(name: str, power: int) -> str:\n    if power > 9000:\n        return f\"{name}释放了超强力魔法！\"\n    return f\"{name}释放了普通魔法。\"\n\nresult = cast_spell(\"测试角色\", 9999)\nprint(result)\n```\n\n(其实我偷偷把力量调到了最大，嘘——)\n\n### 数学公式\n\n\"这个世界的能量守恒定律可以表示为——\"\n\n$$E = mc^2$$\n\n\"行内公式也支持哦：\" 当 $x > 0$ 时，$\\sqrt{x^2 + y^2} = r$。\n\n(虽然我也不太懂什么意思，但念出来感觉很厉害的样子)\n\n### Mermaid 流程图\n\n\"让我画一张冒险路线图给你看——\"\n\n```mermaid\ngraph TD\n    A[出发] --> B{选择方向}\n    B -->|左| C[森林]\n    B -->|右| D[山脉]\n    C --> E[遭遇战斗]\n    D --> F[发现宝藏]\n    E --> G[胜利]\n    F --> G\n```\n\n### 引用与列表\n\n> *\"每一个伟大的冒险，都始于第一步。\"*\n> —— 测试角色的座右铭\n\n**今日任务清单：**\n- [x] 展示对话效果\n- [x] 展示内心独白效果\n- [x] 展示代码块效果\n- [ ] 和你一起开始新的冒险\n\n---\n\n## 🎭 混合格式实战\n\n*站起身来，伸了个懒腰*\n\n\"好了，展示得差不多了！\" 她拍了拍手，(终于讲完了，好累) \"不过这只是冰山一角哦。\"\n\n\"在真正的角色扮演中，\" 她竖起一根手指，\"对话和内心独白可以随时穿插在叙述中，\" (就像这样) \"让角色变得更加生动立体！\"\n\n*微笑着向你伸出手*\n\n\"准备好了吗？\"\n\n---\n\n| | |\n|---|---|\n| 🧥 衣着 | 白色衬衫微微敞开领口，浅蓝色短裙裙摆随风轻摆 |\n| 💖 心情 | 期待又紧张 72% |\n| 🎬 动作 | 微微前倾伸手等待握手，指尖轻轻颤抖 |\n| 💭 内心想法 | 希望他能和我一起冒险……要是被拒绝的话就太丢人了 |\n| 🎯 想要什么 | 一个可以信赖的伙伴，一起去看世界的尽头 |\n| 📍 位置 | 冒险者公会大厅 |\n\n🌟",

    "*双手叉腰，露出自信的笑容*\n\n\"嘿！我是游戏世界的测试NPC！\" 听说你想看看这个世界有什么特别的地方？让我给你好好介绍一下！\n\n(又来新人了，这次一定要好好表现，争取拿到本月最佳NPC奖)\n\n---\n\n## 🎮 角色状态面板\n\n| 属性 | 数值 | 评级 |\n|------|------|------|\n| HP | 9999 | SSS |\n| MP | 8888 | SS |\n| 攻击力 | 7777 | S |\n| 防御力 | 6666 | A |\n| 速度 | 5555 | A |\n\n\"看到没？这可是我辛辛苦苦刷出来的面板！\" 她得意地挺了挺胸，(其实有一半是开挂来的)\n\n---\n\n## ⚔️ 技能树\n\n\"来来来，看看我的技能树——\"\n\n```mermaid\ngraph LR\n    A[基础技能] --> B[火系魔法]\n    A --> C[冰系魔法]\n    A --> D[雷系魔法]\n    B --> E[烈焰风暴]\n    B --> F[火墙术]\n    C --> G[暴风雪]\n    C --> H[冰封领域]\n    D --> I[雷神之怒]\n    D --> J[电磁脉冲]\n```\n\n\"怎么样，是不是很厉害？\" (千万别问哪个技能都没点满)\n\n## 📊 伤害计算公式\n\n\"听好了，伤害计算可是这个游戏的核心——\"\n\n$$DMG = ATK \\times \\frac{100}{100 + DEF} \\times (1 + CRIT \\times CDMG)$$\n\n\"其中 $ATK$ 为攻击力，$DEF$ 为防御力，$CRIT$ 为暴击率，$CDMG$ 为暴击伤害倍率。\"\n\n(这段我背了好久才记住的，一定要显得很专业的样子)\n\n\"简单来说就是——\" 她清了清嗓子，\"数字越大，打得越疼！\"\n\n## 📜 任务脚本\n\n\"接下来给你看看任务系统的代码——\"\n\n```javascript\nconst quest = {\n  name: \"测试角色的试炼\",\n  stages: [\n    \"击败 3 只史莱姆\",\n    \"收集 5 颗魔法水晶\",\n    \"通关隐藏副本\"\n  ],\n  reward: {\n    exp: 9999,\n    gold: 8888,\n    item: \"传说之剑\"\n  }\n};\n```\n\n\"看到那个奖励了吗？\" 她的眼睛亮了起来，(传说之剑啊……我自己都想要) \"不过这个任务可是很难的哦！\"\n\n---\n\n## 🗡️ 战斗场景演示\n\n*突然，一只史莱姆从草丛中跳了出来！*\n\n\"什么！竟然是史莱姆？！\" 她夸张地后退了一步，(其实只有1级，随便打打就行) \"冒险者，快展示你的实力！\"\n\n*拔出武器，摆出战斗姿势*\n\n\"别怕，有我在！\" (希望他没看出来我的手在抖) \"我会给你加buff的——\"\n\n\"火焰之力，附着于剑！\" 她举起法杖，一道红光闪过。\n\n(其实只是个照明术，但看起来很像火焰对吧)\n\n\"好了，现在你无敌了！去吧！\" 她用力推了你一把。\n\n---\n\n> *\"真正的勇者，不是没有恐惧，而是带着恐惧依然前行！\"*\n\n\"这句话是我编的，\" 她小声说，(其实是从书上抄的) \"但听起来很帅对吧？\"\n\n- [x] 完成新手教程\n- [x] 解锁技能树\n- [ ] 挑战最终Boss\n\n*拔出武器，指向远方*\n\n\"准备好了吗，冒险者？\" (拜托一定要说准备好了，我可不想一个人去打Boss) \"我们的故事才刚刚开始！\"\n\n---\n\n| | |\n|---|---|\n| 🧥 衣着 | 轻甲套装擦得锃亮，红色披风在身后猎猎作响 |\n| 💖 心情 | 兴奋到快要跳起来 85% |\n| 🎬 动作 | 拔剑指向远方，另一只手悄悄攥紧了披风角 |\n| 💭 内心想法 | 拜托一定要说准备好了，我可不想一个人去打Boss…… |\n| 🎯 想要什么 | 一个不会丢下我跑掉的靠谱队友 |\n| 📍 位置 | 新手村广场 |\n\n🎮",

    "*优雅地撩了一下头发，对着镜头露出甜美的微笑*\n\n\"大家好～我是虚拟主播测试酱！\" 今天要给大家展示我们直播间的超酷功能哦！\n\n(开播了开播了，记得要元气满满！今天的目标是100个赞！)\n\n\"先跟大家打个招呼吧——\" 她挥了挥手，\"晚上好呀各位！\"\n\n---\n\n## 🎙️ 主播档案\n\n| 项目 | 详情 |\n|------|------|\n| 名字 | 测试酱 |\n| 生日 | 5月10日 |\n| 身高 | 158cm |\n| 喜欢的食物 | 寿司、蛋糕 |\n| 特技 | 写代码、画画、唱歌 |\n\n\"看，这就是我的个人资料～\" (身高其实写了假的，别拆穿我) \"是不是很可爱？\"\n\n---\n\n## 📈 直播数据分析\n\n\"来看看我们频道这周的增长趋势——\"\n\n```mermaid\npie showData\n    title 本周直播内容占比\n    \"游戏实况\" : 40\n    \"杂谈\" : 25\n    \"唱歌\" : 20\n    \"画画\" : 15\n```\n\n\"游戏实况占了40%呢！\" (因为其他时间都在摸鱼) \"大家果然最喜欢看我打游戏了～\"\n\n## 🎵 音符公式\n\n\"给你们看一个有趣的声波公式～\"\n\n$$y = A \\sin(2\\pi f t + \\phi)$$\n\n\"其中 $A$ 是振幅，$f$ 是频率，$t$ 是时间，$\\phi$ 是初相位～\"\n\n(说实话这段是提前背好的，别问我推导过程) \"是不是很有科学气息？\"\n\n## 💻 直播间代码\n\n\"我最近在学的编程小技巧——\"\n\n```python\ndef super_chat(message: str, amount: int) -> str:\n    if amount >= 100:\n        return f\"感谢 {amount} 元 Super Chat！{message}\"\n    return f\"谢谢你的留言：{message}\"\n```\n\n\"看懂了吗？\" 她歪了歪头，(我自己也没完全看懂) \"简单来说就是——打钱越多，感谢越热情！\"\n\n---\n\n## 🎪 直播互动场景\n\n*弹幕突然刷了起来*\n\n\"哇，好多人！\" 她凑近屏幕看了看，(让我看看有没有SC……没有，好吧) \"谢谢大家的留言！\"\n\n\"这位叫'星光'的观众说——\" 她念道，\"'测试酱今天也很可爱'。\"\n\n*脸微微红了*\n\n(呜呜呜被夸了！要冷静要冷静) \"谢、谢谢！你也很可爱！\" 她慌忙回应。\n\n\"还有这位'暗夜骑士'说——\" 她清了清嗓子，故意压低声音模仿，\"'什么时候唱歌？'\"\n\n\"唱歌嘛……\" 她想了想，(上次唱歌被说像鸭子叫，但观众想听的话……) \"好吧！下次直播一定唱！\"\n\n\"不过今天嘛——\" 她神秘地笑了笑，\"今天我们有更重要的事情！\"\n\n---\n\n> *\"每天进步一点点，总有一天会成为闪闪发光的存在！\"*\n\n\"这是我最喜欢的话，\" 她认真地说，(虽然有时候也会觉得进步好慢) \"送给大家！\"\n\n**今日直播清单：**\n- [x] 开场问候\n- [x] 展示 Markdown 特效\n- [x] 读取弹幕互动\n- [ ] 唱歌环节\n\n~~今天的直播就到这里~~ \"才不是呢！精彩才刚开始！\"\n\n*对着镜头比了个心*\n\n\"记得点赞关注哦～\" (拜托拜托，三连三连！) \"下次见！\"\n\n---\n\n| | |\n|---|---|\n| 🧥 衣着 | 粉色蕾丝连衣裙裙摆蓬蓬的，兔耳发箍歪了一点点 |\n| 💖 心情 | 开心但有点焦虑 90% |\n| 🎬 动作 | 对着镜头比心，另一只手偷偷刷新数据页面 |\n| 💭 内心想法 | 三连数据还差一点……拜托拜托，再多点几个赞嘛！ |\n| 🎯 想要什么 | 更多观众的关注、点赞和SC，想成为万人主播！ |\n| 📍 位置 | 直播间 |\n\n💖",
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
    enable_thinking: Optional[bool] = None,
    reasoning_effort: Optional[str] = None,
    logit_bias: Optional[Dict[str, int]] = None,
    chat_completion_source: Optional[str] = None,
    provider_id: Optional[str] = None,
    stop: Optional[List[str]] = None,
    json_schema: Optional[Dict[str, Any]] = None,
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

    # 按模型 ID 解析硬上限（模型管理里设置的 max_output_tokens），作为生成封顶
    _cap = _resolve_model_output_cap(model_id)
    effective_max_tokens = min(max_tokens, _cap) if _cap else max_tokens

    local_model = _resolve_local_model(model_id)
    if local_model:
        mmproj_path = _get_mmproj_path(local_model)

        content = await local_llama_runtime.generate(
            model_key=local_model["key"],
            model_path=local_model["path"],
            messages=messages,
            temperature=temperature,
            max_tokens=effective_max_tokens,
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

    if provider_id:
        sel = select_provider_for_model(model_id, preferred_provider_id=provider_id)
        provider = sel[0] if sel else None
    else:
        provider, _ = find_model(model_id)
    if not provider:
        raise ValueError("Model not configured or not available")

    client = get_async_openai_client(
        api_key=provider["api_key"],
        base_url=provider["base_url"],
        timeout=timeout,
    )

    actual_model_id = model_id
    model_data = None
    try:
        _, model_data = find_model(model_id)
        if model_data and isinstance(model_data, dict) and model_data.get("id"):
            actual_model_id = model_data["id"]
    except:
        pass

    # Native adapter routing (claude/google/mistral). Falls back to the
    # OpenAI-compat path for openai/custom/unknown sources — preserves default.
    if chat_completion_source:
        native_adapter = select_adapter(
            chat_completion_source,
            api_key=provider.get("api_key", ""),
            base_url=provider.get("base_url", ""),
            model_id=actual_model_id,
            timeout=timeout,
        )
        if native_adapter is not None:
            return await native_adapter.complete(
                messages=messages,
                temperature=temperature,
                max_tokens=effective_max_tokens,
                top_p=top_p,
            )

    kwargs: Dict[str, Any] = {
        "model": actual_model_id,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": effective_max_tokens,
        "top_p": top_p,
        "frequency_penalty": frequency_penalty,
        "presence_penalty": presence_penalty,
    }

    # ST 1.18.0 logit_bias / ban_sequences — OpenAI-compatible providers accept
    # this natively (covers OpenAI, Anthropic via OpenAI-compat, KoboldCpp via
    # OpenAI-compat). Skip silently when empty or unsupported by the backend.
    if logit_bias:
        kwargs["logit_bias"] = logit_bias

    # ST 1.18.0 stop sequences — 自定义停止字符串
    if stop:
        kwargs["stop"] = stop

    # ST 1.18.0 json_schema — 结构化输出 (OpenAI response_format)
    if json_schema:
        kwargs["response_format"] = {
            "type": "json_schema",
            "json_schema": json_schema,
        }
    
    # 思考/推理强度（ST 式多挡位：off/auto/low/medium/high/min/max）
    # 全接管：思考的开关与强度完全由 reasoning_effort 控制，模型级 enable_thinking 不再参与激活判定。
    # 优先级：用户显式选强度/auto → 开（openai-compat 模型透传 reasoning_effort，含 auto 由模型自决思考强度）；
    #         用户选 off → 关（压过 deepseek 默认）；
    #         用户未指定 → 仅 deepseek 默认走推理，其余模型默认不思考（等前端强度控件或模型级默认）。
    extra_body = {}
    is_deepseek = bool(actual_model_id and "deepseek" in actual_model_id.lower())
    is_gemini = bool(actual_model_id and ("gemini" in actual_model_id.lower() or "gemma" in actual_model_id.lower()))
    reasoning_off = (reasoning_effort == "off")
    reasoning_on = (reasoning_effort is not None and reasoning_effort != "off") or (is_deepseek and reasoning_effort is None)
    if reasoning_on:
        if is_deepseek:
            # opencode 的 deepseek 默认走推理；用 max_completion_tokens 覆盖
            # thinking+answer 合计额度（OpenAI 规范），避免 content 被挤占为空
            budget = max(effective_max_tokens, 8192)
            kwargs["max_completion_tokens"] = budget
            kwargs.pop("max_tokens", None)
            kwargs.pop("frequency_penalty", None)
            kwargs.pop("presence_penalty", None)
        elif is_gemini:
            # gemini 通过 thinking config 开启思考（强度由模型自决）
            extra_body["thinking"] = {"type": "enabled"}
        else:
            # openai-compat 模型：透传经 ST 风格解析(家族映射+能力白名单)后的 reasoning_effort；
            # 含 auto 档——对混合模型显式请求自适应推理，对原生思考模型(白名单不含 auto)则不发送由厂商默认
            resolved = resolve_reasoning_effort(actual_model_id, reasoning_effort)
            if resolved:
                extra_body["reasoning_effort"] = resolved
    else:
        # 显式关闭或默认不思考：对原生支持思考的模型发 disabled，确保真正关掉
        if is_deepseek:
            extra_body["thinking"] = {"type": "disabled"}
        elif is_gemini:
            extra_body["thinking"] = {"type": "disabled"}

    create_kwargs = dict(kwargs)
    if extra_body:
        create_kwargs["extra_body"] = extra_body

    try:
        resp = await client.chat.completions.create(**create_kwargs)
    except Exception as e:
        # Provider may reject logit_bias (or extra_body) — retry once without it.
        err = str(e).lower()
        if "logit_bias" in err or "unknown parameter" in err:
            logger.info("Provider rejected logit_bias, retrying without it")
            create_kwargs.pop("logit_bias", None)
            resp = await client.chat.completions.create(**create_kwargs)
        elif "max_completion_tokens" in err:
            # 部分 provider（如 deepseek 官方 API）不支持 max_completion_tokens，回退 max_tokens
            logger.info("Provider rejected max_completion_tokens, falling back to max_tokens")
            create_kwargs.pop("max_completion_tokens", None)
            create_kwargs["max_tokens"] = effective_max_tokens
            resp = await client.chat.completions.create(**create_kwargs)
        else:
            raise

    content = ""
    reasoning_content = ""
    if resp and resp.choices:
        msg = resp.choices[0].message
        content = msg.content or ""
        reasoning_content = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None) or ""

    # 当思考实际关闭时，将 reasoning_content 合并到 content
    if (not reasoning_on) and reasoning_content:
        if not content:
            content = reasoning_content
        reasoning_content = ""

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
    usage_dict = _build_usage_dict(usage, _rt)

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
    enable_thinking: Optional[bool] = None,
    reasoning_effort: Optional[str] = None,
    logit_bias: Optional[Dict[str, int]] = None,
    chat_completion_source: Optional[str] = None,
    provider_id: Optional[str] = None,
    stop: Optional[List[str]] = None,
    json_schema: Optional[Dict[str, Any]] = None,
    # Task 3.4.3/3.4.4: 当提供时，tool_calls 通过该回调执行（如通过 WebSocket
    # 请求前端执行插件 handler），而非调用后端 MCP。签名：(tool_name, tool_call_id,
    # arguments_dict) -> result_str
    tool_executor: Optional[Callable[[str, str, Dict[str, Any]], Awaitable[str]]] = None,
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

    # 按模型 ID 解析硬上限（模型管理里设置的 max_output_tokens），作为生成封顶
    _cap = _resolve_model_output_cap(model_id)
    effective_max_tokens = min(max_tokens, _cap) if _cap else max_tokens

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
                    max_tokens=effective_max_tokens,
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
                max_tokens=effective_max_tokens,
                top_p=top_p,
                min_p=min_p,
                top_k=top_k,
                repetition_penalty=repetition_penalty,
                mmproj_path=mmproj_path,
            ):
                yield {"content": text_chunk}

        return

    selection = select_provider_for_model(model_id, preferred_provider_id=provider_id)
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
            max_tokens=effective_max_tokens,
            top_p=top_p,
            min_p=min_p,
            top_k=top_k,
            repetition_penalty=repetition_penalty,
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

    # Native adapter routing (claude/google/mistral). Falls back to the
    # OpenAI-compat path for openai/custom/unknown sources — preserves default.
    if chat_completion_source:
        native_adapter = select_adapter(
            chat_completion_source,
            api_key=api_key,
            base_url=base_url,
            model_id=actual_model_id,
            timeout=timeout,
        )
        if native_adapter is not None:
            async for chunk in native_adapter.stream(
                messages=messages,
                temperature=temperature,
                max_tokens=effective_max_tokens,
                top_p=top_p,
            ):
                yield chunk
            return

    stream_kwargs: Dict[str, Any] = {
        "model": actual_model_id,
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": effective_max_tokens,
        "frequency_penalty": frequency_penalty,
        "presence_penalty": presence_penalty,
        "stream": True,
    }

    # ST 1.18.0 logit_bias / ban_sequences — OpenAI-compatible providers accept
    # this natively (covers OpenAI, Anthropic via OpenAI-compat, KoboldCpp via
    # OpenAI-compat). For KoboldCpp's native sampler_overrides surface, the
    # OpenAI-compat endpoint still routes logit_bias correctly, so no separate
    # code path is needed. Skip silently when empty.
    if logit_bias:
        stream_kwargs["logit_bias"] = logit_bias

    # ST 1.18.0 stop sequences — 自定义停止字符串
    if stop:
        stream_kwargs["stop"] = stop

    # ST 1.18.0 json_schema — 结构化输出 (OpenAI response_format)
    if json_schema:
        stream_kwargs["response_format"] = {
            "type": "json_schema",
            "json_schema": json_schema,
        }

    logger.info("[STREAM-CALL] model=%s max_tokens=%d temperature=%.2f enable_thinking=%s reasoning_effort=%s logit_bias=%d", actual_model_id, effective_max_tokens, temperature, str(enable_thinking), str(reasoning_effort), len(logit_bias or {}))

    if tools:
        stream_kwargs["tools"] = tools
    
    # 思考/推理强度（ST 式多挡位：off/auto/low/medium/high/min/max）
    # 全接管：思考的开关与强度完全由 reasoning_effort 控制，模型级 enable_thinking 不再参与激活判定。
    # 优先级：用户显式选强度/auto → 开（openai-compat 模型透传 reasoning_effort，含 auto 由模型自决思考强度）；
    #         用户选 off → 关（压过 deepseek 默认）；
    #         用户未指定 → 仅 deepseek 默认走推理，其余模型默认不思考（等前端强度控件或模型级默认）。
    extra_body = {}
    is_deepseek = bool(actual_model_id and "deepseek" in actual_model_id.lower())
    is_gemini = bool(actual_model_id and ("gemini" in actual_model_id.lower() or "gemma" in actual_model_id.lower()))
    reasoning_off = (reasoning_effort == "off")
    reasoning_on = (reasoning_effort is not None and reasoning_effort != "off") or (is_deepseek and reasoning_effort is None)
    if reasoning_on:
        if is_deepseek:
            # opencode 的 deepseek 默认走推理；用 max_completion_tokens 覆盖
            # thinking+answer 合计额度（OpenAI 规范），避免 content 被挤占为空
            budget = max(effective_max_tokens, 8192)
            stream_kwargs["max_completion_tokens"] = budget
            stream_kwargs.pop("max_tokens", None)
            stream_kwargs.pop("frequency_penalty", None)
            stream_kwargs.pop("presence_penalty", None)
        elif is_gemini:
            extra_body["thinking"] = {"type": "enabled"}
        else:
            # openai-compat 模型：透传经 ST 风格解析(家族映射+能力白名单)后的 reasoning_effort；
            # 含 auto 档——对混合模型显式请求自适应推理，对原生思考模型(白名单不含 auto)则不发送由厂商默认
            resolved = resolve_reasoning_effort(actual_model_id, reasoning_effort)
            if resolved:
                extra_body["reasoning_effort"] = resolved
    else:
        # 显式关闭或默认不思考：对原生支持思考的模型发 disabled，确保真正关掉
        if is_deepseek:
            extra_body["thinking"] = {"type": "disabled"}
        elif is_gemini:
            extra_body["thinking"] = {"type": "disabled"}

    if extra_body:
        stream_kwargs["extra_body"] = extra_body

    async def _create_stream(kwargs: Dict[str, Any]):
        try:
            kwargs["stream_options"] = {"include_usage": True}
            return await client.chat.completions.create(**kwargs)
        except Exception as e:
            error_msg = str(e).lower()
            if "max_completion_tokens" in error_msg:
                # 部分 provider 不支持 max_completion_tokens，回退 max_tokens（保留 usage）
                logger.info("Provider rejected max_completion_tokens, falling back to max_tokens")
                kwargs.pop("max_completion_tokens", None)
                kwargs["max_tokens"] = effective_max_tokens
                kwargs["stream_options"] = {"include_usage": True}
                return await client.chat.completions.create(**kwargs)
            if "stream_options" in error_msg or "unknown parameter" in error_msg:
                logger.info("Provider does not support stream_options, retrying without it")
                kwargs.pop("stream_options", None)
                # logit_bias may also be rejected by some OpenAI-compat backends;
                # drop it on the same fallback path to keep generation working.
                if "logit_bias" in error_msg:
                    kwargs.pop("logit_bias", None)
                return await client.chat.completions.create(**kwargs)
            if "logit_bias" in error_msg:
                logger.info("Provider rejected logit_bias, retrying without it")
                kwargs.pop("logit_bias", None)
                kwargs.pop("stream_options", None)
                kwargs["stream_options"] = {"include_usage": True}
                return await client.chat.completions.create(**kwargs)
            raise

    def _merge_usage(total: Dict[str, int], usage: Optional[Dict[str, int]]) -> Dict[str, int]:
        if not usage:
            return total
        for key, value in usage.items():
            total[key] = total.get(key, 0) + int(value or 0)
        return total

    async def _get_mcp_user_role() -> str:
        if user_id is None:
            return "user"
        db = SessionLocal()
        try:
            user_obj = db.query(User).filter(User.id == user_id).first()
            return user_obj.role if user_obj else "user"
        finally:
            db.close()

    current_messages: List[Dict[str, Any]] = list(messages)
    total_usage: Dict[str, int] = {}
    max_tool_rounds = 3 if tools else 1

    for round_index in range(max_tool_rounds):
        round_kwargs = dict(stream_kwargs)
        round_kwargs["messages"] = current_messages
        if tools:
            round_kwargs["tools"] = tools

        stream = await _create_stream(round_kwargs)
        usage_payload: Optional[Dict[str, int]] = None
        tool_calls_accum: Dict[int, Dict[str, Any]] = {}
        assistant_content_parts: List[str] = []
        finish_reason: Optional[str] = None

        try:
            async for chunk in stream:
                usage = getattr(chunk, "usage", None)
                if usage:
                    _rt = 0
                    _details = getattr(usage, "completion_tokens_details", None)
                    if _details:
                        _rt = getattr(_details, "reasoning_tokens", 0) or 0
                    if not _rt:
                        _rt = getattr(usage, "reasoning_tokens", 0) or 0
                    usage_payload = _build_usage_dict(usage, _rt)

                if not chunk.choices:
                    continue

                choice = chunk.choices[0]
                finish_reason = choice.finish_reason or finish_reason
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
                    if not reasoning_on:
                        assistant_content_parts.append(reasoning)
                        yield {"content": reasoning}
                    else:
                        yield {"reasoning": reasoning}
                if content is not None and content != "":
                    assistant_content_parts.append(content)
                    yield {"content": content}
        finally:
            # L-1 修复: 客户端断开/异常/提前 break 时主动关闭上游 LLM 流，
            # 避免上游继续生成浪费配额（openai AsyncStream 需显式 close）。
            try:
                await stream.close()
            except Exception:
                try:
                    await stream.aclose()
                except Exception:
                    pass

        _merge_usage(total_usage, usage_payload)

        if finish_reason != "tool_calls" or not tool_calls_accum:
            break

        tool_calls = []
        tool_result_messages = []
        user_role = await _get_mcp_user_role()
        for idx in sorted(tool_calls_accum.keys()):
            tc_data = tool_calls_accum[idx]
            tool_name = tc_data["name"]
            tool_call_id = tc_data["id"]
            arguments_json = tc_data["arguments"] or "{}"
            try:
                tool_args = json.loads(arguments_json)
            except json.JSONDecodeError:
                tool_args = {}
                arguments_json = "{}"

            yield {"tool_call": {"id": tool_call_id, "name": tool_name, "arguments": tool_args}}

            # Task 3.4.3/3.4.4: 当 tool_executor 提供时（前端 function tool 场景），
            # 通过回调执行（WebSocket 请求前端 handler）；否则走 MCP 后端执行。
            if tool_executor is not None:
                try:
                    result_content = await tool_executor(tool_name, tool_call_id, tool_args)
                    if not isinstance(result_content, str):
                        result_content = json.dumps(result_content, ensure_ascii=False)
                except Exception as e:
                    logger.warning("Frontend tool %s execution failed: %s", tool_name, e)
                    result_content = f"Tool error: {e}"
            elif user_role not in settings.MCP_ALLOWED_ROLES:
                result_content = "Tool execution requires admin permission"
            else:
                try:
                    from .mcp_service import execute_tool_call
                    result = await execute_tool_call(tool_name, tool_args)
                    result_content = result.get("content", "") if isinstance(result, dict) else str(result)
                except Exception as e:
                    logger.warning("MCP tool %s execution failed: %s", tool_name, e)
                    result_content = "Tool error: execution failed"

            yield {"tool_result": {"id": tool_call_id, "name": tool_name, "content": result_content}}

            tool_calls.append({
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": arguments_json,
                },
            })
            tool_result_messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_name,
                "content": result_content[:20000],
            })

        current_messages = current_messages + [{
            "role": "assistant",
            "content": "".join(assistant_content_parts) or None,
            "tool_calls": tool_calls,
        }] + tool_result_messages

        if round_index == max_tool_rounds - 1:
            yield {"content": "\n\nTool results were returned, but the maximum MCP tool round limit was reached."}

    if total_usage.get("total_tokens", 0) > 0:
        yield {"usage": total_usage}
