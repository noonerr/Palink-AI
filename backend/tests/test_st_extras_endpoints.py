"""ST Extras 端点契约（2026-10-18 包 C）。

覆盖 ``backend/app/api/st_extras.py`` 里新增/迁移的全部端点：

    POST /api/extra/classify            POST /api/extra/classify/labels
    GET  /api/classify/labels           POST /api/extra/caption
    POST /api/summarize                 POST /api/extra/translate
    POST /api/translate                 POST /api/translate/{provider}
    POST /api/backends/kobold/embed     GET  /api/sprites/get
    POST /api/sprites/upload            POST /api/sprites/upload-zip
    POST /api/sprites/delete

契约来源逐条对照 ``st-plugins/`` 下的插件源码（见 st_extras.py 文件头）。

## 本文件锁定的两条硬约束

1. **不造假**：拿不到能力时必须返回可操作的错误（503/502），
   绝不返回伪造的成功响应。caption 的视觉能力门禁专门有一个测试。
2. **响应形状必须与插件读取路径逐字段一致**：插件用 ``response.text()`` 取译文、
   用 ``data.classification[0].label`` 取标签、用 ``data.embeddings.length === items.length``
   校验嵌入——形状错一位就是运行时抛错。
"""

import io
import os
import sys
import zipfile

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

import app.api.st_extras as st_extras  # noqa: E402
from app.models import Character  # noqa: E402

# 1x1 红点 PNG（用于 caption / sprite 上传）
_PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\xdac\xf8\xcf"
    b"\xc0\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82"
)

_ALL_ROUTES = (
    "/api/extra/classify",
    "/api/extra/classify/labels",
    "/api/classify/labels",
    "/api/extra/caption",
    "/api/summarize",
    "/api/extra/translate",
    "/api/translate",
    "/api/translate/{provider}",
    "/api/backends/kobold/embed",
    "/api/sprites/get",
    "/api/sprites/upload",
    "/api/sprites/upload-zip",
    "/api/sprites/delete",
)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def fake_model(monkeypatch):
    """把模型解析固定成假模型，避免测试依赖真实 providers.json。

    默认声明 supports_vision=True；需要测视觉门禁的用例自己改。

    注意打的是 ``unified_model_registry.get_flat_model_list``：``st_extras`` 在
    函数体内 import 它（延迟导入避免启动期循环依赖），所以必须打源模块属性，
    打 ``st_extras.get_flat_model_list`` 不会生效。
    """
    entry = {"id": "test-vision", "supports_vision": True}
    monkeypatch.setattr(
        "app.services.unified_model_registry.get_flat_model_list", lambda: [entry]
    )
    monkeypatch.setattr(st_extras, "_default_model_id_for_db", lambda db: "test-vision")
    monkeypatch.setattr(st_extras, "ensure_model_available", lambda model_id: None)
    monkeypatch.setattr(
        st_extras, "_resolve_chat_completion_source", lambda db, user_id: "custom"
    )
    return entry


@pytest.fixture
def llm(monkeypatch):
    """替换单次补全，记录调用参数并返回固定文本。"""
    captured = {"calls": [], "content": "MOCKED"}

    async def fake_complete(model_id, messages, **kwargs):
        captured["calls"].append(
            {"model_id": model_id, "messages": messages, "kwargs": kwargs}
        )
        return {"content": captured["content"]}

    monkeypatch.setattr(st_extras, "complete_text_completion", fake_complete)
    return captured


@pytest.fixture
def data_dir(monkeypatch, tmp_path):
    """把 DATA_DIR 指到临时目录，避免测试往真实 /app/data 写精灵图。

    ``st_extras.settings`` 与 ``expressions.settings`` 是同一个对象
    （都从 ``app.core`` import），所以改一次两边都生效。
    """
    monkeypatch.setattr(st_extras.settings, "DATA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def character(db_session, test_user):
    char = Character(
        id="char-sprites-1",
        user_id=test_user.id,
        name="露缇雅",
        avatar="palink-char-sprites-1.png",
    )
    db_session.add(char)
    db_session.commit()
    return char


# ---------------------------------------------------------------------------
# 路由注册
# ---------------------------------------------------------------------------
class TestRouteRegistration:
    def test_all_routes_registered(self):
        registered = {getattr(r, "path", "") for r in st_extras.router.routes}
        for path in _ALL_ROUTES:
            assert path in registered, f"{path} 未注册"

    def test_router_is_mounted_on_app(self):
        """router 注册了不等于挂到 app 上。

        断言用 ``app.openapi()["paths"]``：``app.routes`` 里 api 路由被包在自定义的
        ``_IncludedRouter`` 容器下（该容器**没有** ``.routes`` 属性，只有
        ``original_router``，且嵌套一层），直接枚举取不到真实路径。
        """
        from app.main import app

        paths = set(app.openapi()["paths"])
        for path in _ALL_ROUTES:
            assert path in paths, f"{path} 未挂到 app"


# ---------------------------------------------------------------------------
# classify
# ---------------------------------------------------------------------------
class TestClassify:
    def test_llm_label_returned(self, client, auth_headers, fake_model, llm):
        llm["content"] = "joy"

        resp = client.post(
            "/api/extra/classify", json={"text": "我好开心"}, headers=auth_headers
        )

        assert resp.status_code == 200
        # 插件读 data.classification[0].label（expressions/index.js:1068）
        assert resp.json()["classification"][0]["label"] == "joy"

    def test_llm_output_with_noise_is_parsed(self, client, auth_headers, fake_model, llm):
        """模型常带引号/句号，解析必须容错，否则表情永远落到 fallback。"""
        llm["content"] = '  "anger"。 '

        resp = client.post(
            "/api/extra/classify", json={"text": "我生气了"}, headers=auth_headers
        )

        assert resp.json()["classification"][0]["label"] == "anger"

    def test_llm_failure_falls_back_to_keywords(self, client, auth_headers, fake_model, monkeypatch):
        """模型不可用时用确定性关键词匹配兜底——这是真实计算，不是伪造。"""

        async def boom(*args, **kwargs):
            raise RuntimeError("upstream down")

        monkeypatch.setattr(st_extras, "complete_text_completion", boom)

        resp = client.post(
            "/api/extra/classify", json={"text": "I am furious"}, headers=auth_headers
        )

        assert resp.status_code == 200
        # "furious" 在 rage 的关键词表里（expression_service.py:35-39）
        assert resp.json()["classification"][0]["label"] == "rage"

    def test_unparseable_llm_output_falls_back(self, client, auth_headers, fake_model, llm):
        llm["content"] = "我无法判断"

        resp = client.post(
            "/api/extra/classify", json={"text": "I am furious"}, headers=auth_headers
        )

        assert resp.json()["classification"][0]["label"] == "rage"

    def test_empty_text_rejected(self, client, auth_headers, fake_model, llm):
        resp = client.post("/api/extra/classify", json={"text": "  "}, headers=auth_headers)

        assert resp.status_code == 400
        assert llm["calls"] == []

    def test_labels_post(self, client, auth_headers):
        resp = client.post("/api/extra/classify/labels", headers=auth_headers)

        assert resp.status_code == 200
        labels = resp.json()["labels"]
        assert len(labels) == 15
        assert "joy" in labels and "neutral" in labels

    def test_labels_get(self, client, auth_headers):
        """Extras 服务形态的 GET 变体（插件把 Extras URL 指向 Palink 时走这条）。"""
        resp = client.get("/api/classify/labels", headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["labels"][0] in resp.json()["labels"]


# ---------------------------------------------------------------------------
# caption
# ---------------------------------------------------------------------------
class TestCaption:
    def test_vision_model_returns_caption(self, client, auth_headers, fake_model, llm):
        llm["content"] = "一个红色的像素点"

        resp = client.post(
            "/api/extra/caption",
            json={"image": _b64(_PNG_1PX)},
            headers=auth_headers,
        )

        assert resp.status_code == 200
        assert resp.json()["caption"] == "一个红色的像素点"
        # 必须把图片作为 image_url part 传给模型，否则视觉模型看到的是纯文本
        parts = llm["calls"][0]["messages"][0]["content"]
        assert any(p.get("type") == "image_url" for p in parts)
        assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")

    def test_non_vision_model_rejected_without_fake_caption(
        self, client, auth_headers, fake_model, llm
    ):
        """核心防伪测试：模型不支持视觉时**必须** 503，且绝不调用模型。"""
        fake_model["supports_vision"] = False

        resp = client.post(
            "/api/extra/caption",
            json={"image": _b64(_PNG_1PX)},
            headers=auth_headers,
        )

        assert resp.status_code == 503
        assert "supports_vision" in resp.json()["detail"]
        assert llm["calls"] == [], "不支持视觉时不得调用模型"

    def test_data_url_prefix_tolerated(self, client, auth_headers, fake_model, llm):
        """插件文档说裸 base64，但别的调用方可能带前缀——两种都要能吃。"""
        llm["content"] = "ok"

        resp = client.post(
            "/api/extra/caption",
            json={"image": f"data:image/png;base64,{_b64(_PNG_1PX)}"},
            headers=auth_headers,
        )

        assert resp.status_code == 200

    def test_empty_image_rejected(self, client, auth_headers, fake_model, llm):
        resp = client.post("/api/extra/caption", json={"image": ""}, headers=auth_headers)

        assert resp.status_code == 400

    def test_invalid_base64_rejected(self, client, auth_headers, fake_model, llm):
        resp = client.post(
            "/api/extra/caption", json={"image": "!!!not-base64!!!"}, headers=auth_headers
        )

        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# summarize / translate
# ---------------------------------------------------------------------------
class TestSummarize:
    def test_returns_summary_shape(self, client, auth_headers, fake_model, llm):
        """memory 插件读 data.summary（memory/index.js:901 附近）。"""
        llm["content"] = "摘要正文"

        resp = client.post(
            "/api/summarize", json={"text": "很长的一段对话", "params": {}}, headers=auth_headers
        )

        assert resp.status_code == 200
        assert resp.json() == {"summary": "摘要正文"}

    def test_custom_prompt_from_params_is_used(self, client, auth_headers, fake_model, llm):
        llm["content"] = "x"

        client.post(
            "/api/summarize",
            json={"text": "t", "params": {"prompt": "只用五个字总结"}},
            headers=auth_headers,
        )

        assert llm["calls"][0]["messages"][0]["content"] == "只用五个字总结"

    def test_empty_text_rejected(self, client, auth_headers, fake_model, llm):
        resp = client.post("/api/summarize", json={"text": ""}, headers=auth_headers)

        assert resp.status_code == 400


class TestTranslate:
    @pytest.mark.parametrize("provider", sorted(st_extras._ST_TRANSLATE_PROVIDERS))
    def test_all_eight_providers_accepted(
        self, client, auth_headers, fake_model, llm, monkeypatch, provider
    ):
        """8 个 provider 全部可达（原生不可用时回落 LLM，仍是 200 + 纯文本）。"""
        # 强制原生路径失败，专测回落链路，避免依赖真实网络
        monkeypatch.setattr(
            st_extras, "_translate_via_google", _failing_native
        )
        monkeypatch.setattr(
            st_extras, "_translate_via_libre", _failing_native
        )
        llm["content"] = "译文"

        resp = client.post(
            f"/api/translate/{provider}",
            json={"text": "hello", "lang": "zh-CN"},
            headers=auth_headers,
        )

        assert resp.status_code == 200
        # 插件用 response.text() 取译文（translate/index.js:260）
        assert resp.text == "译文"
        assert resp.headers["content-type"].startswith("text/plain")

    def test_unknown_provider_rejected(self, client, auth_headers, fake_model, llm):
        resp = client.post(
            "/api/translate/evilprovider", json={"text": "x"}, headers=auth_headers
        )

        assert resp.status_code == 400
        assert llm["calls"] == []

    @pytest.mark.parametrize("bad", ("../../evil", "%2e%2e", "google/../admin"))
    def test_provider_path_traversal_never_200(
        self, client, auth_headers, fake_model, llm, bad
    ):
        """provider 参与上游 URL 拼接，穿越段一律不得 200、不得调模型。"""
        resp = client.post(f"/api/translate/{bad}", json={"text": "x"}, headers=auth_headers)

        assert resp.status_code != 200, bad
        assert llm["calls"] == []

    def test_plain_translate_without_provider(self, client, auth_headers, fake_model, llm):
        llm["content"] = "你好"

        resp = client.post("/api/translate", json={"text": "hello"}, headers=auth_headers)

        assert resp.status_code == 200
        assert resp.text == "你好"

    def test_extra_translate_path(self, client, auth_headers, fake_model, llm):
        llm["content"] = "你好"

        resp = client.post(
            "/api/extra/translate", json={"text": "hello"}, headers=auth_headers
        )

        assert resp.status_code == 200
        assert resp.text == "你好"

    def test_native_success_skips_llm(self, client, auth_headers, fake_model, llm, monkeypatch):
        """原生上游可用时**不应**调 LLM——否则等于白花钱。"""

        async def native_ok(text, target_lang):
            return "原生译文"

        monkeypatch.setattr(st_extras, "_translate_via_google", native_ok)

        resp = client.post(
            "/api/translate/google", json={"text": "hello", "lang": "zh-CN"}, headers=auth_headers
        )

        assert resp.text == "原生译文"
        assert llm["calls"] == []


# ---------------------------------------------------------------------------
# kobold embed
# ---------------------------------------------------------------------------
class TestKoboldEmbed:
    def test_shape_matches_plugin_validation(self, client, auth_headers, monkeypatch):
        """插件严格校验：长度相等、每条非空、model 非空（vectors/index.js:1471-1478）。"""
        import numpy as np

        import app.memory_module.embedder as embedder_mod

        class FakeEmbedder:
            _model = "bge-m3"

            def dimension(self):
                return 4

        monkeypatch.setattr(embedder_mod, "get_embedder", lambda: FakeEmbedder())
        monkeypatch.setattr(
            embedder_mod,
            "embed_text",
            lambda items: np.array([[0.1, 0.2, 0.3, 0.4] for _ in items], dtype="float32"),
        )

        resp = client.post(
            "/api/backends/kobold/embed",
            json={"items": ["a", "b", "c"], "server": "http://kobold:5001"},
            headers=auth_headers,
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["model"] == "bge-m3"
        assert len(body["embeddings"]) == 3
        assert all(len(vec) == 4 for vec in body["embeddings"])

    def test_empty_items_returns_empty(self, client, auth_headers):
        resp = client.post(
            "/api/backends/kobold/embed", json={"items": []}, headers=auth_headers
        )

        assert resp.status_code == 200
        assert resp.json()["embeddings"] == []

    def test_count_mismatch_is_reported_not_papered_over(self, client, auth_headers, monkeypatch):
        """嵌入条数与输入不符时必须报错——静默截断会让插件把向量配错文本。"""
        import numpy as np

        import app.memory_module.embedder as embedder_mod

        class FakeEmbedder:
            _model = "bge-m3"

            def dimension(self):
                return 4

        monkeypatch.setattr(embedder_mod, "get_embedder", lambda: FakeEmbedder())
        monkeypatch.setattr(
            embedder_mod, "embed_text", lambda items: np.array([[0.1, 0.2]], dtype="float32")
        )

        resp = client.post(
            "/api/backends/kobold/embed", json={"items": ["a", "b"]}, headers=auth_headers
        )

        assert resp.status_code == 502
        assert "不匹配" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# sprites
# ---------------------------------------------------------------------------
class TestSprites:
    def test_upload_get_delete_roundtrip(
        self, client, auth_headers, character, data_dir
    ):
        """完整闭环：上传 → 列出 → 删除 → 再列出为空。

        只做 get/delete 不叫闭环——没有 upload，get 永远是空的。
        """
        upload = client.post(
            "/api/sprites/upload",
            data={"name": "露缇雅", "label": "joy", "spriteName": "joy"},
            files={"avatar": ("joy.png", _PNG_1PX, "image/png")},
            headers=auth_headers,
        )
        assert upload.status_code == 200, upload.text

        listed = client.get("/api/sprites/get?name=露缇雅", headers=auth_headers)
        assert listed.status_code == 200
        sprites = listed.json()
        assert [s["label"] for s in sprites] == ["joy"]
        # path 会被插件直接当 imageSrc（expressions/index.js:1216）
        assert sprites[0]["path"].startswith("/api/characters/")

        removed = client.post(
            "/api/sprites/delete",
            json={"name": "露缇雅", "label": "joy", "spriteName": "joy"},
            headers=auth_headers,
        )
        assert removed.status_code == 200
        assert removed.json()["deleted"] is True

        assert client.get("/api/sprites/get?name=露缇雅", headers=auth_headers).json() == []

    def test_palink_avatar_name_is_resolved(self, client, auth_headers, character, data_dir):
        """插件可能传 avatar 主干 ``palink-<cid>`` 而不是显示名（两种形状都要认）。"""
        client.post(
            "/api/sprites/upload",
            data={"name": "palink-char-sprites-1", "label": "anger"},
            files={"avatar": ("anger.png", _PNG_1PX, "image/png")},
            headers=auth_headers,
        )

        listed = client.get("/api/sprites/get?name=palink-char-sprites-1", headers=auth_headers)

        assert [s["label"] for s in listed.json()] == ["anger"]

    def test_multi_sprite_label_is_merged(self, client, auth_headers, character, data_dir):
        """``joy-2`` 这类多图名要归并回 ``joy``，否则插件按标签过滤会全部丢掉。"""
        for sprite_name in ("joy", "joy-2"):
            client.post(
                "/api/sprites/upload",
                data={"name": "露缇雅", "label": "joy", "spriteName": sprite_name},
                files={"avatar": (f"{sprite_name}.png", _PNG_1PX, "image/png")},
                headers=auth_headers,
            )

        listed = client.get("/api/sprites/get?name=露缇雅", headers=auth_headers)

        assert [s["label"] for s in listed.json()] == ["joy", "joy"]

    def test_upload_zip_counts_images_and_blocks_zip_slip(
        self, client, auth_headers, character, data_dir
    ):
        """压缩包上传返回 {count}；带 ../ 的条目必须被压平在目标目录内。"""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("joy.png", _PNG_1PX)
            archive.writestr("anger.png", _PNG_1PX)
            archive.writestr("../../escape.png", _PNG_1PX)
            archive.writestr("notes.txt", b"not an image")
        buffer.seek(0)

        resp = client.post(
            "/api/sprites/upload-zip",
            data={"name": "露缇雅"},
            files={"avatar": ("sprites.zip", buffer.getvalue(), "application/zip")},
            headers=auth_headers,
        )

        assert resp.status_code == 200
        # 3 张图（notes.txt 被跳过），escape.png 被 basename 压平
        assert resp.json()["count"] == 3
        # 不得写到 DATA_DIR 之外
        assert not (data_dir.parent / "escape.png").exists()

    def test_bad_zip_rejected(self, client, auth_headers, character, data_dir):
        resp = client.post(
            "/api/sprites/upload-zip",
            data={"name": "露缇雅"},
            files={"avatar": ("sprites.zip", b"not a zip", "application/zip")},
            headers=auth_headers,
        )

        assert resp.status_code == 400

    def test_unknown_character_404(self, client, auth_headers, data_dir):
        resp = client.get("/api/sprites/get?name=不存在的角色", headers=auth_headers)

        assert resp.status_code == 404

    def test_invalid_label_rejected(self, client, auth_headers, character, data_dir):
        resp = client.post(
            "/api/sprites/upload",
            data={"name": "露缇雅", "label": "../evil"},
            files={"avatar": ("x.png", _PNG_1PX, "image/png")},
            headers=auth_headers,
        )

        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 认证
# ---------------------------------------------------------------------------
class TestAuth:
    @pytest.mark.parametrize(
        "method,path",
        [
            ("post", "/api/extra/classify"),
            ("post", "/api/extra/caption"),
            ("post", "/api/summarize"),
            ("post", "/api/translate/google"),
            ("post", "/api/backends/kobold/embed"),
            ("get", "/api/sprites/get?name=x"),
            ("get", "/api/classify/labels"),
        ],
    )
    def test_requires_authentication(self, client, method, path):
        kwargs = {} if method == "get" else {"json": {}}
        resp = getattr(client, method)(path, **kwargs)

        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _b64(raw: bytes) -> str:
    import base64

    return base64.b64encode(raw).decode("ascii")


async def _failing_native(text, target_lang):
    raise RuntimeError("native upstream unavailable in test")
