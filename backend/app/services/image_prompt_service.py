"""出图提示词适配层：模型家族识别 → 提示词渲染 → ComfyUI 工作流模板。

SPEC：`docs/SPEC_出图提示词智能化与多设备算力路由_2026-09-29.md` §1（B1-T1），
并按其 §9 的 R1/R5 落实：

- **R1**：`family` / `checkpoint_name` / `workflow_json` 的最终归宿是
  `image_generation_service._validate_provider` 的**白名单重建返回**，
  本模块只负责语义与渲染，不负责配置持久化。
- **R5**：启发表**长名在前、先命中先返回**（避免 `xl` / `1.5` 这类短片段误吞）；
  style=nl 下 negative **恒为空串**。

设计边界：
- 本模块是**纯函数**集合（除 random 取 seed 外无副作用、无 IO），便于离线单测；
- 不认识的东西一律回落，绝不让渲染层抛异常打穿出图主流程。
"""

from __future__ import annotations

import json
import logging
import random
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

# ============================================================
# 家族口径
# ============================================================

STYLE_NL = "nl"
STYLE_DANBOORU = "danbooru"

WORKFLOW_SDXL = "sdxl"
WORKFLOW_FLUX = "flux"
WORKFLOW_QWEN_IMAGE = "qwen_image"

#: provider.family 的合法取值。`auto` = 交给启发表推断。
FAMILY_AUTO = "auto"
_VALID_FAMILIES: frozenset[str] = frozenset(
    {FAMILY_AUTO, STYLE_NL, STYLE_DANBOORU, WORKFLOW_FLUX, WORKFLOW_QWEN_IMAGE,
     WORKFLOW_SDXL, "pony", "illustrious", "noobai"}
)


@dataclass(frozen=True)
class ImageFamily:
    """一个模型家族的渲染口径。

    style    —— 提示词书写口味（自然语言长句 / danbooru 逗号标签串）；
    workflow —— ComfyUI 工作流套（SD 系 checkpoint 加载 / Flux / Qwen-Image 分离加载）；
    key      —— 家族键，决定用哪一套质量前缀（同一 workflow 下不同社区惯例）。
    """

    style: str
    workflow: str
    key: str


@dataclass(frozen=True)
class Scene:
    """画面素材：副 AI（T2）产出 tag 串 + NL 段；T1 阶段只有 natural。"""

    tags: str = ""
    natural: str = ""


@dataclass(frozen=True)
class RenderedPrompt:
    positive: str
    negative: str


# provider.type → 默认家族。本地服务商（ComfyUI / SD WebUI）默认装动漫模型的概率
# 最高，且用户可在设置页手改；云端端点几乎全是自然语言派 —— 与 SPEC §1.1 同口径。
_DEFAULT_BY_TYPE: dict[str, ImageFamily] = {
    "openai_compatible": ImageFamily(STYLE_NL, WORKFLOW_SDXL, "generic_nl"),
    "sd_webui": ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "sdxl"),
    "comfyui": ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "sdxl"),
}

#: 显式家族下拉 → 渲染口径（KEY 必须同时出现在 `_VALID_FAMILIES` 里）。
_FAMILY_PRESETS: dict[str, ImageFamily] = {
    STYLE_NL: ImageFamily(STYLE_NL, WORKFLOW_SDXL, "generic_nl"),
    STYLE_DANBOORU: ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "sdxl"),
    WORKFLOW_FLUX: ImageFamily(STYLE_NL, WORKFLOW_FLUX, "flux"),
    WORKFLOW_QWEN_IMAGE: ImageFamily(STYLE_NL, WORKFLOW_QWEN_IMAGE, "qwen_image"),
    WORKFLOW_SDXL: ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "sdxl"),
    "pony": ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "pony"),
    "illustrious": ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "illustrious"),
    "noobai": ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "noobai"),
}

# [R5] 启发表：**长名在前**，命中即返回。
# 顺序就是契约——`qwen-image-xl` 同时命中 qwen 段与 xl 段，必须判成 Qwen-Image，
# 否则会被短片段 `xl` 抢走变成 danbooru 口味 + SDXL 加载器（架构不对，直接报错）。
_FAMILY_HINTS: tuple[tuple[tuple[str, ...], ImageFamily], ...] = (
    (("qwen-image", "qwen_image", "qwenimage"), ImageFamily(STYLE_NL, WORKFLOW_QWEN_IMAGE, "qwen_image")),
    (("hunyuan-image", "seedream", "gpt-image", "gptimage", "dall-e", "dalle", "imagen"),
     ImageFamily(STYLE_NL, WORKFLOW_SDXL, "generic_nl")),
    (("flux",), ImageFamily(STYLE_NL, WORKFLOW_FLUX, "flux")),
    (("pony",), ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "pony")),
    (("illustrious",), ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "illustrious")),
    (("noobai",), ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "noobai")),
    (("sdxl", "xl"), ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "sdxl")),
    (("v1-5", "sd15", "1.5"), ImageFamily(STYLE_DANBOORU, WORKFLOW_SDXL, "sdxl")),
)


def normalize_family(value: Any) -> str:
    """把外部传入的 family 归一化到白名单；非法值一律回落 `auto`（永不让前端写坏配置）。"""
    text = str(value or "").strip().lower()
    return text if text in _VALID_FAMILIES else FAMILY_AUTO


def _model_identity(provider: Mapping[str, Any]) -> str:
    """用于启发表匹配的模型身份串。

    **checkpoint 名优先于 model 字段**：ComfyUI / SD WebUI 的真实模型身份是工作流
    加载的 checkpoint 文件；设置页对这两类服务商根本没有 `model` 输入框（只有云端
    服务商有），靠 `model` 推断在用户的主力拓扑上永远判不出来 —— 会静默掉到默认辣
    （danbooru + SDXL），而 SDXL 加载器打不开 Qwen-Image 的 checkpoint。
    """
    for key in ("checkpoint_name", "model"):
        text = str(provider.get(key) or "").strip()
        if text:
            return text
    return ""


def detect_family(provider: Mapping[str, Any]) -> ImageFamily:
    """判定 provider 的家族口径。优先级：显式 family > 名称启发表 > 类型默认。"""
    provider_type = str(provider.get("type") or "").strip().lower()
    default = _DEFAULT_BY_TYPE.get(provider_type) or _DEFAULT_BY_TYPE["openai_compatible"]

    explicit = normalize_family(provider.get("family"))
    if explicit != FAMILY_AUTO and explicit in _FAMILY_PRESETS:
        preset = _FAMILY_PRESETS[explicit]
        return ImageFamily(preset.style, preset.workflow or default.workflow, preset.key)

    low = _model_identity(provider).lower()
    if low:
        for fragments, family in _FAMILY_HINTS:
            if any(fragment in low for fragment in fragments):
                return ImageFamily(family.style, family.workflow or default.workflow, family.key)

    return default


# ============================================================
# 渲染器（确定性代码，不劳驾 LLM）
# ============================================================

#: 质量前缀（社区惯例内置；需要精确控制的用户请用自定义 workflow JSON）。
_QUALITY_PREFIXES: dict[str, str] = {
    "pony": "score_9, score_8_up, score_7_up",
    "illustrious": "masterpiece, best quality, very aesthetic, absurdres",
    "noobai": "masterpiece, best quality, very aesthetic, absurdres",
    "sdxl": "masterpiece, best quality, very aesthetic, absurdres",
    "flux": "",
    "qwen_image": "",
    "generic_nl": "",
}

#: danbooru 系通用负面预设（EasyNegative 风格起步）。
_NEGATIVE_PRESET = "lowres, bad anatomy, bad hands, watermark, worst quality, low quality"

# [SPEC §7] SD1.5 的 CLIP 只有 77 token 窗口，tag 串超长会被静默截断、尾部字段全丢。
# 这里做长度保护：超预算时按原始顺序丢尾部（先写先留）。预算按字符近似，宁保守。
_TAGS_MAX_FIELDS = 40
_TAGS_MAX_CHARS = 480


def clamp_tags(tags: str) -> str:
    fields = [item.strip() for item in str(tags or "").split(",")]
    fields = [item for item in fields if item]
    kept: list[str] = []
    total = 0
    for item in fields:
        if len(kept) >= _TAGS_MAX_FIELDS:
            break
        addition = len(item) + (2 if kept else 0)
        if total + addition > _TAGS_MAX_CHARS:
            break
        kept.append(item)
        total += addition
    return ", ".join(kept)


def render_prompt(family: ImageFamily, scene: Scene, provider: Optional[Mapping[str, Any]] = None) -> RenderedPrompt:
    """把 Scene 渲染成 (positive, negative)。

    style=nl       → positive = natural 原样，negative **恒为空串**（R5 定死）：
                     Qwen / Flux 属自然语言派，负面词实测无用甚至有害；用户在设置页
                     填的 negative_prompt 原样保留，只是不进请求。
    style=danbooru → positive = 质量前缀 + tags；tags 为空则回退 natural
                     （T1 阶段副 AI 还没上，tags 恒空 → 行为 = 现状 + 前缀 + 负面预设）。
    """
    provider = provider or {}
    if family.style == STYLE_NL:
        return RenderedPrompt(str(scene.natural or ""), "")

    tags = clamp_tags(scene.tags)
    prefix = _QUALITY_PREFIXES.get(family.key) or _QUALITY_PREFIXES["sdxl"]
    natural = str(scene.natural or "")
    if tags:
        positive = f"{prefix}, {tags}" if prefix else tags
    else:
        positive = f"{prefix}, {natural}" if (prefix and natural) else (natural or prefix)

    negative = _NEGATIVE_PRESET
    user_negative = str(provider.get("negative_prompt") or "").strip()
    if user_negative:
        negative = f"{negative}, {user_negative}"
    return RenderedPrompt(positive, negative)


# ============================================================
# B1-T2：副 AI 场景画像（一次调用同时产出 tag 串与自然语言段）
# ============================================================

_SECONDARY_SYSTEM_PROMPT = """你是一个文生图提示词编辑器。你的唯一任务：把给定的聊天上下文改写成一段画面描述，并用**严格 JSON** 输出。

要求：
1. 只输出 JSON，不要解释、不要 Markdown 代码块标记。
2. JSON 形如：{"tags": "...", "natural": "..."}
3. tags：英文 danbooru 风格、**逗号分隔**的字段串，覆盖人物数量/发色/瞳色/发型/服饰/动作/表情/构图/场景/光线，15~30 个字段。
   **不要写质量词**（masterpiece / best quality / score_9 之类）——质量前缀由渲染器按模型家族自动添加。
4. natural：一段可直接喂给自然语言类模型（如 Qwen-Image / Flux）的完整英文描述，80~150 词，包含主体、服饰、动作、环境、光线与氛围。
5. 只描述画面，不写情节发展与对话内容。
"""

#: 副 AI 调用上限。出图是异步侧挂，副 AI 再慢也不能把整条配图拖到骨架超时之后。
SECONDARY_TIMEOUT_SECONDS = 30.0


def parse_scene_payload(text: str) -> Optional[dict[str, Any]]:
    """从副 AI 回复里抠出 JSON 对象：剥 code fence → 取第一个配平的花括号片段。"""
    if not text:
        return None
    cleaned = re.sub(r"```[A-Za-z]*", "", text).replace("```", "")
    start = cleaned.find("{")
    if start < 0:
        return None
    depth = 0
    for index in range(start, len(cleaned)):
        char = cleaned[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    payload = json.loads(cleaned[start:index + 1])
                except ValueError:
                    return None
                return payload if isinstance(payload, dict) else None
    return None


async def compose_scene(
    db: Any,
    user: Any,
    materials: Sequence[str],
    *,
    secondary_enabled: bool,
    secondary_model: str,
    fallback_prompt: str = "",
    model_prompt: str = "",
    timeout: float = SECONDARY_TIMEOUT_SECONDS,
    complete_text_completion: Optional[Any] = None,
) -> Scene:
    """调副 AI 把上下文改写为 Scene。**任何失败都与"没配副 AI"等价**。

    降级不是返回空，而是返回 `Scene(natural=fallback_prompt, tags="")`——渲染器对空
    tags 的处理就是整段回退 natural，于是最坏情况的输出与今天逐字一致
    （SPEC §2.2「永不比现状差」）。

    四个降级点：开关关 / 未配模型 / 调用失败或超时 / JSON 解析不出来。
    降级只打一行 info 日志，不 toast——出图是聊天外的侧挂，别打扰对话。

    `complete_text_completion` 可注入（测试用）；不注入时走真实网关客户端。
    素材由调用方收集好后传进来：这一层不反向依赖 ORM 模型。
    """
    fallback = Scene(tags="", natural=fallback_prompt or model_prompt or "")
    if not secondary_enabled or not str(secondary_model or "").strip():
        return fallback

    user_content = "\n".join(str(line) for line in materials if str(line).strip())
    if not user_content.strip():
        return fallback

    caller = complete_text_completion
    try:
        if caller is None:
            # 与 MVU 副 AI 同一取模型方式；函数内 import 为避免与推理层的循环依赖。
            from .inference_dispatcher import complete_text_completion as caller  # type: ignore[no-redef]
        response = await caller(
            model_id=str(secondary_model).strip(),
            messages=[
                {"role": "system", "content": _SECONDARY_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.4,
            max_tokens=1200,
            timeout=float(timeout),
        )
    except Exception as exc:
        logger.info("Image scene composer unavailable, fallback to raw prompt (model=%s): %s", secondary_model, exc)
        return fallback

    payload = parse_scene_payload(str((response or {}).get("content") or ""))
    if not payload:
        logger.info("Image scene composer returned unparsable output, fallback to raw prompt")
        return fallback

    tags = str(payload.get("tags") or "").strip()
    natural = str(payload.get("natural") or "").strip()
    if not tags and not natural:
        return fallback
    # 两个字段互为兜底：只有 tags 时 NL 渲染需要点东西；只有 natural 时 danbooru
    # 渲染会因空 tags 自动回退 natural，无需额外处理。
    return Scene(tags=tags, natural=natural or tags.replace(",", " "))


# ============================================================
# ComfyUI 工作流模板库
# ============================================================

# 占位符分两类，混用会破坏 JSON：
# - 字符串类必须按 JSON 字符串转义后再嵌入（提示词里带引号/反斜杠/换行是常态）；
# - 数值类必须嵌裸数字（用户工作流里通常写成 "width": {{WIDTH}}）。
_STRING_PLACEHOLDERS = ("PROMPT", "NEGATIVE", "CKPT")
_NUMERIC_PLACEHOLDERS = ("WIDTH", "HEIGHT", "SEED", "STEPS", "CFG")

_DEFAULT_CKPT_NAME = "model.safetensors"
_DEFAULT_FLUX_UNET = "flux1-dev.safetensors"
_DEFAULT_FLUX_CLIP_L = "clip_l.safetensors"
_DEFAULT_FLUX_T5 = "t5xxl_fp8_e4m3fn.safetensors"
_DEFAULT_FLUX_VAE = "ae.safetensors"
_DEFAULT_QWEN_UNET = "qwen_image_bf16.safetensors"
_DEFAULT_QWEN_CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
_DEFAULT_QWEN_VAE = "qwen_image_vae.safetensors"

# ComfyUI 的 seed 是整数，但本项目既有约定上限是 2**32-1（image_generation_service
# 引用的是同一个常量，不要另起一套值，否则两边会对同一字段给出不同量程）。
_COMFYUI_SEED_MAX = 2**32 - 1


def _json_body(value: Any) -> str:
    """把一个值转成**可安全嵌入 JSON 字符串内部**的片段（吃掉两侧引号）。"""
    return json.dumps(str(value), ensure_ascii=False)[1:-1]


def render_workflow_template(
    template_text: str,
    values: Mapping[str, Any],
) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    """占位符替换 → json.loads。返回 (workflow, error)。

    替换前对字符串类占位符做 JSON 转义、对数值类做整数校验，于是「保存时通过、
    出图时被用户提示词里的引号撑破」这条最难复现的 400 被前置消除。
    """
    text = str(template_text or "")
    for key in _STRING_PLACEHOLDERS:
        token = "{{%s}}" % key
        if token in text:
            text = text.replace(token, _json_body(values.get(key, "")))
    for key in _NUMERIC_PLACEHOLDERS:
        token = "{{%s}}" % key
        if token not in text:
            continue
        raw = values.get(key, 0)
        try:
            number = int(raw)
        except (TypeError, ValueError):
            return None, f"占位符 {token} 的值不是整数：{raw!r}"
        text = text.replace(token, str(number))
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError) as exc:
        return None, f"工作流 JSON 解析失败：{exc}"
    if not isinstance(parsed, dict):
        return None, "工作流 JSON 顶层必须是对象"
    return parsed, None


def _collect_placeholders(text: str) -> set[str]:
    found: set[str] = set()
    index = 0
    while True:
        start = text.find("{{", index)
        if start < 0:
            break
        end = text.find("}}", start + 2)
        if end < 0:
            break
        found.add(text[start + 2:end].strip())
        index = end + 2
    return found


def validate_workflow_template(template_text: str) -> Optional[str]:
    """设置页保存时的校验：JSON 合法性 + 占位符受支持。返回错误原因或 None。"""
    text = (template_text or "").strip()
    if not text:
        return None
    known = set(_STRING_PLACEHOLDERS) | set(_NUMERIC_PLACEHOLDERS)
    probe: dict[str, Any] = {name: "" for name in _STRING_PLACEHOLDERS}
    probe.update({name: 1 for name in _NUMERIC_PLACEHOLDERS})
    _, error = render_workflow_template(text, probe)
    if error:
        return error
    for token in _collect_placeholders(text):
        if token not in known:
            return f"存在未支持的占位符 {{{{ {token} }}}}（支持：{', '.join(sorted(known))}）"
    return None


def _sdxl_workflow(ckpt_name: str, positive: str, negative: str, width: int, height: int,
                   steps: int, cfg_scale: float, seed: int) -> dict[str, Any]:
    """SD1.5 / SDXL / Pony / Illustrious 通用：单 checkpoint 加载 + KSampler。"""
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg_scale,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt_name}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }


def _flux_workflow(unet_name: str, positive: str, negative: str, width: int, height: int,
                   steps: int, cfg_scale: float, seed: int) -> dict[str, Any]:
    """Flux dev/schnell：UNET + 双 CLIP + VAE 分离加载 + 流匹配调度。

    结构对齐 ComfyUI 官方 flux 示例工作流（BasicGuider + SamplerCustomAdvanced）。
    CLIP/VAE 文件名是内置兜底值 —— Flux 系要三个文件，而设置页只有一个 checkpoint
    选择框；需要精确指定时请用「自定义工作流 JSON」。
    """
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
        "2": {
            "class_type": "DualCLIPLoader",
            "inputs": {"clip_name1": _DEFAULT_FLUX_T5, "clip_name2": _DEFAULT_FLUX_CLIP_L, "type": "flux"},
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": _DEFAULT_FLUX_VAE}},
        "4": {
            "class_type": "ModelSamplingFlux",
            "inputs": {"model": ["1", 0], "max_shift": 1.15, "base_shift": 0.5, "width": width, "height": height},
        },
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 0]}},
        "7": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["5", 0], "guidance": cfg_scale}},
        "8": {"class_type": "BasicGuider", "inputs": {"model": ["4", 0], "conditioning": ["7", 0]}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "10": {
            "class_type": "BasicScheduler",
            "inputs": {"model": ["4", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0},
        },
        "11": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "12": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "13": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["11", 0],
                "guider": ["8", 0],
                "sampler": ["9", 0],
                "sigmas": ["10", 0],
                "latent_image": ["12", 0],
            },
        },
        "14": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["3", 0]}},
        "15": {"class_type": "SaveImage", "inputs": {"images": ["14", 0]}},
    }


def _qwen_image_workflow(unet_name: str, positive: str, negative: str, width: int, height: int,
                         steps: int, cfg_scale: float, seed: int) -> dict[str, Any]:
    """Qwen-Image：UNET + Qwen2.5-VL 文本编码器 + 专用 VAE 分离加载。

    与 SDXL 的 `CheckpointLoaderSimple` **架构不同**，拿错加载器会直接报错，这就是
    必须分家族的原因。流匹配口径（ModelSamplingAuraFlow shift=3.1）取自社区通行
    工作流；官方推荐 40 步左右（现有 provider 默认 20 步会欠采样 —— 属参数建议，
    本模块不擅自改 provider 默认值，也不进 SPEC 之外的行为变更）。
    """
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": _DEFAULT_QWEN_CLIP, "type": "qwen_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": _DEFAULT_QWEN_VAE}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 0]}},
        "7": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "8": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg_scale,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["5", 0],
                "negative": ["6", 0],
                "latent_image": ["7", 0],
            },
        },
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0]}},
    }


def build_comfyui_workflow(
    *,
    provider: Optional[Mapping[str, Any]] = None,
    positive: str,
    negative: str,
    width: int,
    height: int,
    steps: int = 20,
    cfg_scale: float = 7.0,
    seed: int = -1,
) -> tuple[dict[str, Any], int]:
    """按家族组装 ComfyUI 工作流，返回 (workflow, 实际使用的 seed)。

    - provider 给了 `workflow_json`：**以它为底**做占位符替换（`{{SEED}}` 未出现在
      模板里时，随机种子由用户工作流自己管，后端不注入）；
    - 否则走内置模板三键分发（sdxl / flux / qwen_image）。

    ComfyUI 没有 seed=-1 的"随机"约定：不取随机值会恒用 0（每次同一张图），
    故在此一次性定死并回传实际值。
    """
    provider = provider or {}
    used_seed = int(seed) if int(seed) >= 0 else random.randint(0, _COMFYUI_SEED_MAX)

    template_text = str(provider.get("workflow_json") or "").strip()
    if template_text:
        workflow, error = render_workflow_template(
            template_text,
            {
                "PROMPT": positive,
                "NEGATIVE": negative,
                "CKPT": str(provider.get("checkpoint_name") or "").strip() or _DEFAULT_CKPT_NAME,
                "WIDTH": width,
                "HEIGHT": height,
                "SEED": used_seed,
                "STEPS": steps,
                "CFG": cfg_scale,
            },
        )
        if workflow is not None:
            return workflow, used_seed
        logger.warning("Image workflow_json invalid, falling back to builtin template: %s", error)

    return _build_builtin_workflow(provider, positive, negative, width, height, steps, cfg_scale, used_seed)


def _build_builtin_workflow(
    provider: Mapping[str, Any],
    positive: str,
    negative: str,
    width: int,
    height: int,
    steps: int,
    cfg_scale: float,
    seed: int,
) -> tuple[dict[str, Any], int]:
    family = detect_family(provider)
    ckpt_name = str(provider.get("checkpoint_name") or "").strip()
    if family.workflow == WORKFLOW_FLUX:
        return _flux_workflow(ckpt_name or _DEFAULT_FLUX_UNET, positive, negative, width, height, steps, cfg_scale, seed), seed
    if family.workflow == WORKFLOW_QWEN_IMAGE:
        return _qwen_image_workflow(ckpt_name or _DEFAULT_QWEN_UNET, positive, negative, width, height, steps, cfg_scale, seed), seed
    # 默认 sdxl 套（SD1.5 共用这张图，steps/cfg 由 provider 配置覆盖）。
    return _sdxl_workflow(ckpt_name or _DEFAULT_CKPT_NAME, positive, negative, width, height, steps, cfg_scale, seed), seed
