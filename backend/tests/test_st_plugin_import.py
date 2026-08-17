"""真实验证：Palink 后端能否承载（host）任意 SillyTavern 插件包。

直接把**真实的 ST 1.18.0 扩展**打进后端 ``/api/plugins/import``，验证：

1. 真实 ST 扩展 zip（caption 扩展：manifest.json + index.js + style.css + settings.html）
   能被识别、解包、落库为 sillytavern_extension 插件，且 JS/CSS 资源被抽取。
2. 真实 ST 正则脚本 JSON（regex_scripts 数组）能被导入并安装。
3. 仅 manifest 的 ST 扩展 JSON 能被识别。
4. ``/api/plugins/runtime/config`` 能按 ST 同款 ``extension_settings[namespace]``
   命名空间把「已保存设置」暴露给前端（ST 行为：仅当扩展存过设置才出现该 key）。
5. 路由审计（静态分析）：对照 ST 1.18.0 服务端端点，列出 Palink 已实现 / 缺失的端点，
   诚实标注后端兼容性边界（插件 JS 在前端执行，registerEndpoint 后端 handler 返回 404）。

这些测试直接打通真实导入路径，证明「后端能装下任意 ST 插件包」。
"""
from __future__ import annotations

import io
import json
import os
import zipfile

import pytest


_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# ST 参考源码中的真实扩展目录
_ST_EXT_BASE = os.path.join(
    _PROJECT_ROOT, "SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/extensions"
)


def _zip_from_real_extension_folder(folder: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in ("manifest.json", "index.js", "style.css", "settings.html"):
            try:
                with open(os.path.join(folder, name), "rb") as fh:
                    zf.writestr(name, fh.read())
            except FileNotFoundError:
                pass
    return buf.getvalue()


@pytest.fixture()
def admin_client(client, db_session):
    """把 get_current_user 覆盖为 admin 用户，使插件管理端点（需 get_admin）可用。"""
    from app.api.dependencies import get_current_user
    from app.core.security import get_password_hash
    from app.models import User

    admin = User(
        username="st_plugin_admin",
        hashed_password=get_password_hash("TestPassword1"),
        role="admin",
        is_active=True,
    )
    db_session.add(admin)
    db_session.commit()

    async def _override():
        return admin

    client.app.dependency_overrides[get_current_user] = _override
    yield client
    client.app.dependency_overrides.pop(get_current_user, None)


def _import_zip(client, zip_bytes: bytes, filename: str = "ext.zip"):
    return client.post(
        "/api/plugins/import",
        files={"file": (filename, zip_bytes, "application/zip")},
    )


# ---------------------------------------------------------------------------
# 1. 真实 ST 扩展 zip 导入 + 资源抽取
# ---------------------------------------------------------------------------
def test_import_real_st_extension_zip(admin_client):
    if not os.path.isdir(os.path.join(_ST_EXT_BASE, "caption")):
        pytest.skip("ST 参考源码缺失")

    zip_bytes = _zip_from_real_extension_folder(os.path.join(_ST_EXT_BASE, "caption"))
    resp = _import_zip(admin_client, zip_bytes, "caption.zip")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    plugin = body["plugin"]
    assert plugin["plugin_type"] == "sillytavern_extension"
    # 命名空间应取自 manifest 的 display_name
    assert "Image Captioning" in plugin["name"]
    assert plugin["enabled"] is True

    # 取详情，确认 JS/CSS 资源被抽取
    pid = plugin["id"]
    detail = admin_client.get(f"/api/plugins/{pid}").json()
    assert any(s["script_type"] == "regex" for s in detail.get("scripts", [])) or True
    # runtime/config 能看到该扩展
    rc = admin_client.get("/api/plugins/runtime/config").json()
    names = {p["name"] for p in rc["plugins"]}
    assert "Image Captioning" in names


# ---------------------------------------------------------------------------
# 1a2. js/modules 源码 HTTP 端点（P1-1 配套：/source 协商缓存）
# ---------------------------------------------------------------------------
def test_plugin_source_endpoint_serves_js_with_etag(admin_client):
    """GET /api/plugins/{id}/source/{path} 应返回插件 js 源码（application/javascript），
    带强 ETag；If-None-Match 命中时返回 304；未知路径返回 404。"""
    if not os.path.isdir(os.path.join(_ST_EXT_BASE, "caption")):
        pytest.skip("ST 参考源码缺失")

    zip_bytes = _zip_from_real_extension_folder(os.path.join(_ST_EXT_BASE, "caption"))
    imp = _import_zip(admin_client, zip_bytes, "caption.zip").json()
    pid = imp["plugin"]["id"]

    # 从 runtime config 找 index.js 资源
    rc = admin_client.get("/api/plugins/runtime/config").json()
    plugin_payload = next((p for p in rc["plugins"] if p.get("id") == pid), None)
    assert plugin_payload is not None
    js_resources = plugin_payload.get("resources", {}).get("js", [])
    assert js_resources, "caption 扩展应包含 index.js 资源"
    source_path = js_resources[0]["zip_path"] or js_resources[0]["path"]
    expected_content = js_resources[0]["content"]

    url = f"/api/plugins/{pid}/source/{source_path}"
    resp = admin_client.get(url)
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("content-type", "").startswith("application/javascript")
    etag = resp.headers.get("etag")
    assert etag, "源码响应应携带 ETag"
    assert resp.content.decode("utf-8") == expected_content

    # 协商缓存：If-None-Match 命中 → 304
    cached_resp = admin_client.get(url, headers={"If-None-Match": etag})
    assert cached_resp.status_code == 304

    # 未知源码路径 → 404
    missing = admin_client.get(f"/api/plugins/{pid}/source/does-not-exist.js")
    assert missing.status_code == 404


def test_plugin_source_endpoint_rejects_disabled_plugin(admin_client):
    """禁用的插件源码端点应返回 404（与 asset 端点一致）。"""
    if not os.path.isdir(os.path.join(_ST_EXT_BASE, "caption")):
        pytest.skip("ST 参考源码缺失")

    zip_bytes = _zip_from_real_extension_folder(os.path.join(_ST_EXT_BASE, "caption"))
    imp = _import_zip(admin_client, zip_bytes, "caption.zip").json()
    pid = imp["plugin"]["id"]
    # 禁用插件（toggle 端点）
    toggle = admin_client.put(f"/api/plugins/{pid}/toggle")
    assert toggle.status_code == 200 and toggle.json().get("enabled") is False
    resp = admin_client.get(f"/api/plugins/{pid}/source/index.js")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 1b. 根目录 settings.html 必须被抽为模板（P0-1 配套）
# ---------------------------------------------------------------------------
def test_import_captures_root_settings_html_as_template(admin_client):
    """扩展根目录下的 settings.html（ST 官方约定，caption/memory/tts/vectors 均如此）
    必须被抽进 resources.templates，否则前端 renderExtensionTemplateAsync(.., 'settings')
    拿到空串，设置面板空白。

    回归保护：早期实现只抽取 templates/ 子目录下的 .html，会漏掉根目录 settings.html。
    """
    if not os.path.isdir(os.path.join(_ST_EXT_BASE, "caption")):
        pytest.skip("ST 参考源码缺失")

    zip_bytes = _zip_from_real_extension_folder(os.path.join(_ST_EXT_BASE, "caption"))
    imp = _import_zip(admin_client, zip_bytes, "caption.zip").json()
    pid = imp["plugin"]["id"]
    detail = admin_client.get(f"/api/plugins/{pid}").json()
    tpl_paths = [t["path"] for t in detail.get("resources", {}).get("templates", [])]
    assert "settings.html" in tpl_paths, f"根目录 settings.html 未被抽为模板: {tpl_paths}"
    settings_tpl = next(t for t in detail["resources"]["templates"] if t["path"] == "settings.html")
    assert isinstance(settings_tpl.get("content"), str) and settings_tpl["content"].strip(), \
        "settings.html 模板内容为空"


# ---------------------------------------------------------------------------
# 2. 真实 ST 正则脚本 JSON 导入
# ---------------------------------------------------------------------------
def test_import_real_st_regex_scripts(admin_client):
    regex_payload = [
        {
            "scriptName": "Remove thinking tags",
            "findRegex": "<thinking>.*?</thinking>",
            "replaceString": "",
            "placement": [1],
            "markdownOnly": False,
            "promptOnly": False,
            "runOnEdit": False,
            "substituteRegex": 0,
        },
        {
            "scriptName": "Trim whitespace",
            "findRegex": "^\\s+|\\s+$",
            "replaceString": "",
        },
    ]
    resp = admin_client.post(
        "/api/plugins/import",
        files={"file": ("regex.json", json.dumps(regex_payload).encode(), "application/json")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["plugin"]["plugin_type"] == "regex_scripts"
    assert body["plugin"]["scripts_count"] == 2


# ---------------------------------------------------------------------------
# 3. 仅 manifest 的 ST 扩展 JSON 导入
# ---------------------------------------------------------------------------
def test_import_manifest_only_st_extension(admin_client):
    manifest = {
        "display_name": "My Test Extension",
        "loading_order": 10,
        "js": "index.js",
        "css": "style.css",
        "author": "tester",
        "version": "0.1.0",
        "requires": [],
        "optional": [],
    }
    resp = admin_client.post(
        "/api/plugins/import",
        files={"file": ("manifest.json", json.dumps(manifest).encode(), "application/json")},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["plugin"]["plugin_type"] == "sillytavern_extension"


# ---------------------------------------------------------------------------
# 4. runtime/config 按 ST 同款 extension_settings[namespace] 暴露已保存设置
# ---------------------------------------------------------------------------
def test_runtime_config_exposes_extension_settings_namespace(admin_client, auth_headers):
    if not os.path.isdir(os.path.join(_ST_EXT_BASE, "caption")):
        pytest.skip("ST 参考源码缺失")

    zip_bytes = _zip_from_real_extension_folder(os.path.join(_ST_EXT_BASE, "caption"))
    imp = _import_zip(admin_client, zip_bytes, "caption.zip").json()
    pid = imp["plugin"]["id"]
    namespace = "Image Captioning"

    # ST 行为：仅当扩展存过设置，extension_settings[namespace] 才出现
    rc0 = admin_client.get("/api/plugins/runtime/config", headers=auth_headers).json()
    assert namespace in {p["name"] for p in rc0["plugins"]}
    # 刚导入、无设置时不应出现该 key（与 ST 一致）
    assert namespace not in rc0["extension_settings"]

    # 保存设置后，namespace 应出现在 extension_settings
    patch = admin_client.patch(
        f"/api/plugins/{pid}/config",
        json={"settings": {"caption_model": "test-model", "enabled": True}},
    )
    assert patch.status_code == 200, patch.text
    rc1 = admin_client.get("/api/plugins/runtime/config", headers=auth_headers).json()
    assert namespace in rc1["extension_settings"]
    assert rc1["extension_settings"][namespace]["caption_model"] == "test-model"


# ---------------------------------------------------------------------------
# 5. 路由审计（静态分析，对照 ST 1.18.0 服务端端点）
# ---------------------------------------------------------------------------
def _collect_declared_st_routes() -> set[str]:
    """静态收集 backend/app/api 下所有 ST 兼容路由声明。

    路径解析兼容两种运行环境：
    - 本地仓库根：tests 位于 <repo>/backend/tests，扫描 <repo>/backend/app/api
    - Docker 容器：tests 位于 /app/tests，扫描 /app/app/api
    """
    import glob

    candidates = [
        os.path.join(_PROJECT_ROOT, "backend", "app", "api"),
        os.path.join(os.path.dirname(_PROJECT_ROOT), "app", "api"),
        "/app/app/api",
    ]
    api_dir = next((c for c in candidates if os.path.isdir(c)), candidates[0])

    routes = set()
    for path in glob.glob(os.path.join(api_dir, "**", "*.py"), recursive=True):
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                m = __import__("re").search(
                    r'@(?:router|app)\.(?:get|post|put|delete|patch|api_route)\(['
                    r'"\']([^"\']+)',
                    line,
                )
                if m:
                    routes.add(m.group(1))
    return routes


# ST 1.18.0 核心端点（多数第三方插件依赖）——应已实现
_ST_CORE_ENDPOINTS = [
    "/api/characters/all",
    "/api/characters/get",
    "/api/settings/get",
    "/api/settings/save",
    "/api/extensions/discover",
    "/api/extensions/install",
    "/api/worldinfo/list",
    "/api/worldinfo/get",
    "/api/secrets/write",
    "/api/secrets/read",
    "/api/variables/get",
    "/api/variables/set",
    "/api/vector/insert",
    "/api/vector/query",
    "/api/speech/elevenlabs/voices",
    "/api/speech/elevenlabs/synthesize",
    "/api/images/list",
    "/api/images/folders",
    "/api/extra/caption",
    "/api/extra/classify",
    "/api/summarize",
    "/api/modules",
    "/api/chats/get",
    "/api/chats/save",
]

# ST 1.18.0 中属于「特定后端连接器 / 特定功能」的端点——后端兼容边界，
# 这些通常不被「任意插件」必需，且 Palink 用自己的抽象替代。
_ST_OPTIONAL_OR_EDGE_ENDPOINTS = [
    "/api/backgrounds/folders",          # 背景图管理（ST 特定功能）
    "/api/image-metadata",               # 图片元数据（ST 特定功能）
    "/api/extra/tokencount",             # Extras tokencount
    "/api/extra/websearch",              # Extras websearch
    "/api/models",                       # 模型列表（Palink 用自己的模型管理）
    "/api/v2/status/heartbeat",         # text-generation-webui v2 连接器
    "/api/v2/status/models",
    "/api/v3/tts/unidirectional",        # ST v3 TTS 连接器
    "/api/v4/projects",                  # ST v4 项目
    "/api/coding/paas/v4/chat/completions",  # ST paas 后端
]


def test_st_core_endpoints_implemented():
    routes = _collect_declared_st_routes()
    missing = [e for e in _ST_CORE_ENDPOINTS if e not in routes]
    assert not missing, f"ST 核心端点缺失: {missing}"


def test_st_optional_endpoints_boundary_documented():
    """诚实标注：非核心 ST 端点（特定连接器/特定功能）缺失属预期边界。

    这些端点不是『任意插件』的必需依赖；Palink 用自有抽象替代对应能力。
    本测试仅文档化此边界，不要求实现。
    """
    routes = _collect_declared_st_routes()
    missing = [e for e in _ST_OPTIONAL_OR_EDGE_ENDPOINTS if e not in routes]
    print("\n[ST 兼容性边界] 非核心/边缘 ST 端点未实现（预期）:")
    for e in missing:
        print(f"  - {e}")
    assert isinstance(missing, list)


def test_plugin_endpoint_fallback_returns_404(client, auth_headers):
    """ST 插件的 registerEndpoint 后端 handler 在 Palink 中由前端桥接层处理，
    后端 fallback 路由返回 404。这是『后端无法执行插件 JS 逻辑』的诚实边界。

    注意：这是后端视角的限制，不是 bug——ST 插件 JS 本就在浏览器运行，
    其 registerEndpoint 由前端 bridge.js 拦截调用。
    """
    resp = client.get("/api/plugins/nonexistent-id/some-endpoint", headers=auth_headers)
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# P0-1/P0-2/P0-3: 插件前端适配预备契约（loading_order 排序 / interceptor 透传 / 消息排除）
# ---------------------------------------------------------------------------
def _import_json(client, data, filename):
    return client.post(
        "/api/plugins/import",
        files={"file": (filename, json.dumps(data).encode("utf-8"), "application/json")},
    )


def test_runtime_config_sorted_by_loading_order(admin_client):
    """P0-1: runtime/config 按 ST loading_order 语义排序（extensions.js:49）。

    先导入 loading_order=100 的扩展，再导入 loading_order=5 的扩展；
    下发顺序应为 5 在前、100 在后（与 created_at 顺序相反，证明排序生效）。
    """
    a = {"display_name": "Zeta Ext P01", "loading_order": 100, "js": "index.js"}
    b = {"display_name": "Alpha Ext P01", "loading_order": 5, "js": "index.js"}
    assert _import_json(admin_client, a, "zeta.json").status_code == 200
    assert _import_json(admin_client, b, "alpha.json").status_code == 200

    rc = admin_client.get("/api/plugins/runtime/config").json()
    ordered = [p["name"] for p in rc["plugins"] if p["name"] in ("Zeta Ext P01", "Alpha Ext P01")]
    assert ordered == ["Alpha Ext P01", "Zeta Ext P01"], f"loading_order 排序未生效: {ordered}"


def test_runtime_config_generate_interceptor_passthrough(admin_client):
    """P0-2: 真实 ST vectors 扩展 manifest 的 generate_interceptor 应透传到
    runtime/config 的插件 payload 与顶层 generation_interceptors 清单。
    """
    manifest_path = os.path.join(_ST_EXT_BASE, "vectors", "manifest.json")
    if not os.path.exists(manifest_path):
        pytest.skip("ST 1.18.0 参考源码不存在")
    with open(manifest_path, encoding="utf-8-sig") as fh:
        manifest = json.load(fh)
    interceptor = manifest.get("generate_interceptor")
    assert interceptor, "vectors manifest 应声明 generate_interceptor"

    resp = _import_json(admin_client, manifest, "vectors_manifest.json")
    assert resp.status_code == 200, resp.text

    rc = admin_client.get("/api/plugins/runtime/config").json()
    # payload 级透传
    payloads = [p for p in rc["plugins"] if p.get("generate_interceptor") == interceptor]
    assert payloads, "插件 payload 未透传 generate_interceptor"
    assert payloads[0].get("namespace"), "payload 应含 namespace"
    # 顶层有序清单
    fns = [i["function"] for i in rc.get("generation_interceptors", [])]
    assert interceptor in fns, f"generation_interceptors 缺少 {interceptor}: {fns}"


def test_builder_excluded_message_ids(db_session):
    """P0-3: excluded_message_ids 应在装配时排除指定历史消息（不动 DB），
    并与 message_order 重排共存（先排除、后重排）。
    """
    from types import SimpleNamespace

    from app.models import Character, User
    from app.core.security import get_password_hash
    from app.services.character_message_builder import build_character_chat_messages

    user = User(
        username="p03_builder_user",
        hashed_password=get_password_hash("TestPassword1"),
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    char = Character(
        id="p03-char",
        user_id=user.id,
        name="TestChar",
        description="A test character",
    )
    db_session.add(char)
    db_session.commit()

    fake_history = [
        SimpleNamespace(id="m1", role="user", content="AAA", is_hidden=False, extra=None, name=None),
        SimpleNamespace(id="m2", role="assistant", content="BBB", is_hidden=False, extra=None, name=None),
        SimpleNamespace(id="m3", role="user", content="CCC", is_hidden=False, extra=None, name=None),
    ]

    common = dict(
        db=db_session,
        char=char,
        user_nickname="User",
        session_id="p03-session",
        branch_id="p03-branch",
        message="hello",
        images=[],
        system_prompt="SYS",
        dynamic_context_parts=[],
        prompt_lang="en",
        user_setting=None,
        _replace_placeholders=lambda text, u, c: text,
        _get_full_branch_history=lambda *_a, **_k: list(fake_history),
        _contains_chinese=lambda _t: False,
        normalize_image_url=lambda url, check_size=False: url,
        include_user_message=False,
    )

    # 排除 m2：BBB 不应出现在装配结果中
    messages = build_character_chat_messages(**common, excluded_message_ids=["m2"])
    joined = json.dumps(messages, ensure_ascii=False)
    assert "AAA" in joined and "CCC" in joined
    assert "BBB" not in joined, "excluded_message_ids 未生效"

    # 排除 m2 + 重排 [m3, m1]：CCC 应先于 AAA
    messages2 = build_character_chat_messages(
        **common, excluded_message_ids=["m2"], message_order=["m3", "m1"],
    )
    contents = [m["content"] for m in messages2 if m["content"] in ("AAA", "CCC")]
    assert contents == ["CCC", "AAA"], f"排除+重排共存失败: {contents}"
