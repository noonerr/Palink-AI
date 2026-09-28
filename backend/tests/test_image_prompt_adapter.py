"""B1-T1：家族识别 + 渲染器 + 工作流模板库。

覆盖 `docs/SPEC_出图提示词智能化与多设备算力路由_2026-09-29.md` §5 的 T1 计划，
并按 §9 复核修订补齐三件别的测试套都不覆盖的事：

- **R1 往返**：三个新 provider 字段必须活过「保存 → 重读」。
  只测渲染函数本身是测不出 `_validate_provider` 白名单重建丢字段这一洞的。
- **R5 顺序**：启发表必须长名在前、先命中先返回，名字同时命中两条规则时要判对。
- **R5 negative**：style=nl 下 negative **恒为空串**（用户填的负面不进请求）。

另有两条是本署评审发现、正文没写的缺口：
- checkpoint 名必须参与家族判定（ComfyUI 场景拿不到 model 名，否则永远掉默认）；
- 自定义 workflow JSON 的占位符必须做 JSON 转义（提示词带引号时不能撑破 JSON）。

全程零网络：配置落在 tmp_path，ComfyUI 工作流只在内存里组装。
"""

import json
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

import app.services.image_generation_service as igs  # noqa: E402
from app.schemas.image_generation import ImageGenerationConfigRequest  # noqa: E402
from app.services.image_prompt_service import (  # noqa: E402
    Scene,
    build_comfyui_workflow,
    clamp_tags,
    compose_scene,
    detect_family,
    normalize_family,
    render_prompt,
    render_workflow_template,
    validate_workflow_template,
)


@pytest.fixture()
def write_config(tmp_path, monkeypatch):
    """把配置读写指向 tmp_path，返回一个「写整份配置」的 helper。"""
    path = tmp_path / "image_generation_config.json"
    monkeypatch.setattr(igs, "_config_path", lambda: str(path))
    monkeypatch.setattr(igs, "_config_cache", None)
    monkeypatch.setattr(igs, "_config_mtime", None)

    def write(config: dict) -> None:
        path.write_text(json.dumps(config), encoding="utf-8")
        igs._config_cache = None
        igs._config_mtime = None

    return write


# ════════════════════════════════════════════════════════════════════
# 1. 家族识别
# ════════════════════════════════════════════════════════════════════

def test_hint_qwen_image_is_nl_pipeline():
    family = detect_family({"type": "comfyui", "model": "qwen-image-2.1"})
    assert (family.style, family.workflow, family.key) == ("nl", "qwen_image", "qwen_image")


def test_hint_flux_is_nl_pipeline():
    family = detect_family({"type": "comfyui", "model": "flux1-dev.safetensors"})
    assert (family.style, family.workflow, family.key) == ("nl", "flux", "flux")


def test_hint_pony_and_illustrious_are_danbooru_with_distinct_prefix():
    pony = detect_family({"type": "comfyui", "model": "ponyDiffusionV6XL"})
    illus = detect_family({"type": "comfyui", "model": "illustrious-v01"})
    assert (pony.style, pony.workflow, pony.key) == ("danbooru", "sdxl", "pony")
    assert (illus.style, illus.workflow, illus.key) == ("danbooru", "sdxl", "illustrious")


def test_hint_unknown_falls_back_by_provider_type():
    # 云端端点一律 NL 派；本地服务商默认按动漫模型估计（用户可手改）
    assert detect_family({"type": "openai_compatible", "model": "some-cloud-thing"}).style == "nl"
    assert detect_family({"type": "comfyui"}).workflow == "sdxl"


def test_r5_hint_order_long_name_wins_over_short_fragment():
    """[R5] 同时命中两条规则时，长名必须在前：`xl` 不得吞掉 qwen / pony。"""
    assert detect_family({"type": "comfyui", "model": "Qwen-Image-XL-2.1"}).workflow == "qwen_image"
    assert detect_family({"type": "comfyui", "model": "pony-diffusion-v6-XL"}).key == "pony"
    assert detect_family({"type": "comfyui", "model": "illustrious-xl-early"}).key == "illustrious"


def test_checkpoint_name_is_the_identity_source_for_local_providers():
    """ComfyUI / SD WebUI 的设置页没有 model 输入框，真实模型身份是 checkpoint。

    判定源选错 = 静默掉默认（danbooru + SDXL 加载器），而 SDXL 加载器打不开
    Qwen-Image 的 checkpoint —— 这条守住「用户什么都没配错却出不了图」的路径。
    """
    provider = {"type": "comfyui", "model": "", "checkpoint_name": "qwen_image_fp8_e4m3fn.safetensors"}
    assert detect_family(provider).workflow == "qwen_image"


def test_explicit_family_overrides_hint():
    provider = {"type": "comfyui", "model": "xl-anything", "family": "qwen_image"}
    assert detect_family(provider).workflow == "qwen_image"


def test_explicit_family_style_only_values_keep_type_workflow():
    assert detect_family({"type": "comfyui", "family": "nl"}).style == "nl"
    assert detect_family({"type": "comfyui", "family": "danbooru"}).style == "danbooru"


def test_normalize_family_rejects_unknown_values():
    assert normalize_family("NOOBAI") == "noobai"
    assert normalize_family("garbage") == "auto"
    assert normalize_family(None) == "auto"


# ════════════════════════════════════════════════════════════════════
# 2. 渲染器
# ════════════════════════════════════════════════════════════════════

def test_render_danbooru_stacks_prefix_tags_and_negative():
    family = detect_family({"type": "comfyui", "model": "pony-v6"})
    rendered = render_prompt(family, Scene(tags="1girl, solo, blue eyes"), {"negative_prompt": "blurry"})
    assert rendered.positive.startswith("score_9, score_8_up, score_7_up, 1girl")
    assert "blurry" in rendered.negative
    assert "lowres" in rendered.negative


def test_render_tags_empty_falls_back_to_natural():
    family = detect_family({"type": "comfyui", "model": "pony-v6"})
    rendered = render_prompt(family, Scene(tags="", natural="a girl in the rain"))
    assert "a girl in the rain" in rendered.positive
    assert "score_9" in rendered.positive  # 前缀照加，T1 阶段只加前缀/负面


def test_r5_render_nl_always_drops_negative():
    """[R5] nl 派恒空 negative：Qwen / Flux 不吃负面，用户填的原样保留但不进请求。"""
    family = detect_family({"type": "comfyui", "model": "qwen-image-2.1"})
    rendered = render_prompt(family, Scene(natural="一段描述"), {"negative_prompt": "blurry, ugly"})
    assert rendered.negative == ""
    assert rendered.positive == "一段描述"


def test_clamp_tags_protects_77_token_window():
    long_tags = ", ".join(f"tag{i}" for i in range(200))
    clamped = clamp_tags(long_tags)
    assert len(clamped) <= 480
    assert clamped.split(", ")[0] == "tag0"  # 丢尾部，先写先留


# ════════════════════════════════════════════════════════════════════
# 3. 工作流模板
# ════════════════════════════════════════════════════════════════════

def test_sdxl_workflow_uses_configured_checkpoint():
    provider = {"type": "comfyui", "checkpoint_name": "realModel.safetensors"}
    workflow, seed = build_comfyui_workflow(
        provider=provider, positive="p", negative="n", width=512, height=512, seed=42,
    )
    loader = next(node for node in workflow.values() if node["class_type"] == "CheckpointLoaderSimple")
    assert loader["inputs"]["ckpt_name"] == "realModel.safetensors"
    assert seed == 42


def test_sdxl_workflow_keeps_legacy_default_when_no_checkpoint():
    """没有 checkpoint 时行为与改动前逐字一致（回滚对齐点）。"""
    workflow, _ = build_comfyui_workflow(provider={"type": "comfyui"}, positive="p", negative="n", width=512, height=512)
    loader = next(node for node in workflow.values() if node["class_type"] == "CheckpointLoaderSimple")
    assert loader["inputs"]["ckpt_name"] == "model.safetensors"


def test_qwen_workflow_uses_separate_loaders_not_checkpoint_loader():
    provider = {"type": "comfyui", "checkpoint_name": "qwen_image_bf16.safetensors"}
    workflow, _ = build_comfyui_workflow(provider=provider, positive="p", negative="", width=1328, height=1328)
    kinds = {node["class_type"] for node in workflow.values()}
    assert "CheckpointLoaderSimple" not in kinds
    assert {"UNETLoader", "CLIPLoader", "VAELoader", "KSampler"} <= kinds
    unet = next(node for node in workflow.values() if node["class_type"] == "UNETLoader")
    assert unet["inputs"]["unet_name"] == "qwen_image_bf16.safetensors"


def test_flux_workflow_uses_unet_dualclip_and_custom_advanced_sampler():
    provider = {"type": "comfyui", "checkpoint_name": "flux1-dev.safetensors"}
    workflow, _ = build_comfyui_workflow(provider=provider, positive="p", negative="", width=1024, height=1024)
    kinds = {node["class_type"] for node in workflow.values()}
    assert {"UNETLoader", "DualCLIPLoader", "BasicGuider", "SamplerCustomAdvanced"} <= kinds


def test_random_seed_is_fixed_once_and_returned():
    workflow, seed = build_comfyui_workflow(provider={"type": "comfyui"}, positive="p", negative="n", width=1, height=1, seed=-1)
    assert seed >= 0
    ksampler = next(node for node in workflow.values() if node["class_type"] == "KSampler")
    assert ksampler["inputs"]["seed"] == seed


# --- 自定义 workflow JSON ---

_QUOTE_HEAVY_PROMPT = 'she said "hello!" and left\\n o\'reilly'


def test_workflow_json_placeholders_survive_quotes_and_backslashes():
    """提示词里带引号/反斜杠/换行是常态；裸替换会撑破 JSON（出图时才炸的 400）。"""
    template = '{"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{PROMPT}}"}}, "5": {"class_type": "EmptyLatentImage", "inputs": {"width": {{WIDTH}}, "height": {{HEIGHT}}}}}'
    workflow, error = render_workflow_template(
        template, {"PROMPT": _QUOTE_HEAVY_PROMPT, "WIDTH": 768, "HEIGHT": 1024},
    )
    assert error is None
    node = workflow["6"]["inputs"]["text"]
    assert node == _QUOTE_HEAVY_PROMPT
    assert workflow["5"]["inputs"]["width"] == 768 and workflow["5"]["inputs"]["height"] == 1024


def test_workflow_json_numeric_placeholder_rejects_non_integer():
    _, error = render_workflow_template('{"5": {"inputs": {"width": {{WIDTH}}}}}', {"WIDTH": "abc"})
    assert error and "整数" in error


def test_workflow_json_build_path_prefers_user_template():
    provider = {"type": "comfyui", "workflow_json": '{"9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "mine-{{SEED}}"}}}'}
    workflow, seed = build_comfyui_workflow(provider=provider, positive="p", negative="n", width=1, height=1, seed=7)
    assert workflow["9"]["inputs"]["filename_prefix"] == "mine-7"
    assert seed == 7


def test_workflow_json_invalid_falls_back_to_builtin():
    provider = {"type": "comfyui", "workflow_json": "{not valid json"}
    workflow, _ = build_comfyui_workflow(provider=provider, positive="p", negative="n", width=1, height=1)
    assert any(node["class_type"] == "KSampler" for node in workflow.values())


def test_validate_workflow_template_accepts_known_placeholders_only():
    assert validate_workflow_template('{"a": {"inputs": {"text": "{{PROMPT}}"}}}') is None
    assert validate_workflow_template("{broken") is not None
    assert validate_workflow_template('{"a": {"inputs": {"x": "{{UNKNOWN}}"}}}') is not None


# ════════════════════════════════════════════════════════════════════
# 4. [R1] 配置往返：三个新字段必须活过「保存 → 重读」
# ════════════════════════════════════════════════════════════════════

def test_r1_roundtrip_new_provider_fields_survive_save(write_config):
    write_config({"enabled": True, "active_provider_id": "comfyui", "providers": [], "defaults": {}})
    payload = {
        "enabled": True,
        "active_provider_id": "comfyui",
        "providers": [{
            "id": "comfyui",
            "name": "ComfyUI",
            "type": "comfyui",
            "enabled": True,
            "execution": "browser",
            "base_url": "http://127.0.0.1:8188",
            "family": "qwen_image",
            "checkpoint_name": "qwen_image_bf16.safetensors",
            "workflow_json": '{"6": {"inputs": {"text": "{{PROMPT}}"}}}',
        }],
        "defaults": None,
    }
    igs.save_image_generation_config(ImageGenerationConfigRequest(**payload).model_dump())

    stored = igs._get_raw_config()
    provider = next(p for p in stored["providers"] if p["id"] == "comfyui")
    assert provider["family"] == "qwen_image"
    assert provider["checkpoint_name"] == "qwen_image_bf16.safetensors"
    assert "{{PROMPT}}" in provider["workflow_json"]


def test_r1_roundtrip_invalid_family_silently_normalized(write_config):
    write_config({"enabled": True, "active_provider_id": "comfyui", "providers": [], "defaults": {}})
    igs.save_image_generation_config({
        "enabled": True,
        "active_provider_id": "comfyui",
        "providers": [{"id": "comfyui", "type": "comfyui", "execution": "browser",
                       "base_url": "http://127.0.0.1:8188", "family": "totally-wrong"}],
    })
    provider = next(p for p in igs._get_raw_config()["providers"] if p["id"] == "comfyui")
    assert provider["family"] == "auto"


def test_invalid_workflow_json_is_rejected_at_save(write_config):
    write_config({"enabled": True, "active_provider_id": "comfyui", "providers": [], "defaults": {}})
    with pytest.raises(ValueError) as excinfo:
        igs.save_image_generation_config({
            "enabled": True,
            "active_provider_id": "comfyui",
            "providers": [{"id": "comfyui", "type": "comfyui", "execution": "browser",
                           "base_url": "http://127.0.0.1:8188", "workflow_json": "{broken"}],
        })
    assert "自定义工作流 JSON 无效" in str(excinfo.value)


# ════════════════════════════════════════════════════════════════════
# 5. B1-T2：副 AI 场景画像（四级降级 = 永不比现状差）
# ════════════════════════════════════════════════════════════════════

def _run(coro):
    import asyncio

    return asyncio.run(coro)


def test_compose_scene_disabled_returns_fallback_verbatim():
    scene = _run(compose_scene(
        None, None, ["Character: 桃汐"],
        secondary_enabled=False, secondary_model="deepseek-v4-flash", fallback_prompt="RAW PROMPT",
    ))
    assert scene == Scene(tags="", natural="RAW PROMPT")


def test_compose_scene_without_model_returns_fallback():
    scene = _run(compose_scene(
        None, None, ["Character: 桃汐"],
        secondary_enabled=True, secondary_model="", fallback_prompt="RAW PROMPT",
    ))
    assert scene == Scene(tags="", natural="RAW PROMPT")


def test_compose_scene_call_failure_returns_fallback():
    async def boom(**kwargs):
        raise RuntimeError("gateway down")

    scene = _run(compose_scene(
        None, None, ["x"], secondary_enabled=True, secondary_model="m",
        fallback_prompt="RAW PROMPT", complete_text_completion=boom,
    ))
    assert scene == Scene(tags="", natural="RAW PROMPT")


def test_compose_scene_unparsable_output_returns_fallback():
    async def garbage(**kwargs):
        return {"content": "我觉得应该画一张很好看的图，但是我不输出 JSON"}

    scene = _run(compose_scene(
        None, None, ["x"], secondary_enabled=True, secondary_model="m",
        fallback_prompt="RAW PROMPT", complete_text_completion=garbage,
    ))
    assert scene == Scene(tags="", natural="RAW PROMPT")


def test_compose_scene_success_parses_both_fields():
    async def ok(**kwargs):
        return {"content": '{"tags": "1girl, blue eyes, rain", "natural": "A girl standing in the rain."}'}

    scene = _run(compose_scene(
        None, None, ["x"], secondary_enabled=True, secondary_model="m",
        fallback_prompt="RAW PROMPT", complete_text_completion=ok,
    ))
    assert scene.tags == "1girl, blue eyes, rain"
    assert scene.natural == "A girl standing in the rain."
    # 落到达成：danbooru 渲染会用 tags，nl 渲染会用 natural
    danbooru = render_prompt(detect_family({"type": "comfyui", "model": "pony-v6"}), scene, {})
    assert "1girl, blue eyes, rain" in danbooru.positive
    nl = render_prompt(detect_family({"type": "comfyui", "model": "qwen-image-2.1"}), scene, {})
    assert nl.positive == "A girl standing in the rain."


def test_compose_scene_strips_code_fence():
    async def fenced(**kwargs):
        return {"content": '```json\n{"tags": "1girl", "natural": "A girl."}\n```'}

    scene = _run(compose_scene(
        None, None, ["x"], secondary_enabled=True, secondary_model="m",
        fallback_prompt="RAW", complete_text_completion=fenced,
    ))
    assert scene.tags == "1girl"


def test_compose_scene_passes_materials_to_the_model():
    captured = {}

    async def spy(**kwargs):
        captured.update(kwargs)
        return {"content": '{"tags": "1girl", "natural": "A girl."}'}

    _run(compose_scene(
        None, None, ["Character: 桃汐", "user: 下雨了"], secondary_enabled=True,
        secondary_model="m", fallback_prompt="RAW", complete_text_completion=spy,
    ))
    joined = captured["messages"][-1]["content"]
    assert "桃汐" in joined and "下雨了" in joined


def test_defaults_roundtrip_secondary_prompt_fields(write_config):
    """[R1 同源] defaults 也是白名单重建：新字段不补进 save 清单就会被静默丢掉。"""
    write_config({"enabled": True, "active_provider_id": "comfyui", "providers": [], "defaults": {}})
    igs.save_image_generation_config({
        "enabled": True,
        "active_provider_id": "comfyui",
        "providers": [{"id": "comfyui", "type": "comfyui", "execution": "browser",
                       "base_url": "http://127.0.0.1:8188"}],
        "defaults": {"secondary_prompt_enabled": True, "secondary_prompt_model": "deepseek-v4-flash"},
    })
    defaults = igs._get_raw_config()["defaults"]
    assert defaults["secondary_prompt_enabled"] is True
    assert defaults["secondary_prompt_model"] == "deepseek-v4-flash"


def test_defaults_default_to_disabled(write_config):
    write_config({"enabled": True, "active_provider_id": "comfyui", "providers": [], "defaults": {}})
    defaults = igs._get_raw_config()["defaults"]
    assert defaults.get("secondary_prompt_enabled", False) is False
    assert defaults.get("secondary_prompt_model", "") == ""


def test_collect_scene_material_is_shared_by_template_and_secondary():
    class _Msg:
        def __init__(self, mid, role, content):
            self.id = mid
            self.role = role
            self.content = content

    class _Char:
        name = "桃汐"
        description = "守塔人"
        personality = "安静"
        scenario = "雨夜"

    target = _Msg(3, "assistant", "她推开门")
    lines, target_text = igs.collect_scene_material(
        target, [_Msg(1, "user", "下雨了"), _Msg(2, "assistant", "嗯"), target], _Char(), 4
    )
    assert lines[0] == "Character: 桃汐"
    assert "下雨了" in "\n".join(lines)
    assert target_text == "她推开门"
    # 模板路径的产出与抽出前一致：行为没有被"顺手改成"
    assert "{{" not in "\n".join(lines)


def test_legacy_config_without_new_fields_gets_defaults(write_config):
    write_config({
        "enabled": True,
        "active_provider_id": "comfyui",
        "providers": [{"id": "comfyui", "type": "comfyui", "execution": "browser",
                       "base_url": "http://127.0.0.1:8188"}],
    })
    provider = igs._get_active_provider(igs._get_raw_config())
    assert provider["family"] == "auto"
    assert provider["checkpoint_name"] == ""
    assert provider["workflow_json"] == ""
    assert detect_family(provider).workflow == "sdxl"  # 兜底行为与改动前一致
