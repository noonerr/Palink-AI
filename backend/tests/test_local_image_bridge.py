"""文生图「浏览器桥接执行」回归（SPEC_文生图浏览器桥接执行_本机ComfyUI_2026-09-28）。

锁定四件事：
1. 配置面：execution=browser 放行内网 base_url（后端零出站），server 模式守卫原样；
2. 委派链：generate_image_for_message 的 browser 分支 → 任务创建/认领/回传/收敛
   （media ready/failed 仍由既有收敛链写入，桥不直接碰库）；
3. 端点面：pending 认领归属隔离、result 幂等、fail 透传、/test 对 browser 模式拒绝；
4. 安全：魔数校验、大小上限、每用户任务积压上限、45s 认领回收。

测试全程不碰真实网络：出图落盘被替换为记录器；ComfyUI 由"测试进程内扮演
用户浏览器"（直接调 claim/complete 桥函数）来驱动。
"""

import asyncio
import base64
import json
import os
import sys
import time

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import app.services.image_generation_service as igs  # noqa: E402
import app.services.local_image_bridge as bridge  # noqa: E402
import app.services.mcp_service as mcp_service  # noqa: E402
from app.api.image_generation import _decode_uploaded_image_b64  # noqa: E402

PNG_BYTES = b"\x89PNG\r\n\x1a\n-palink-local-bridge"
PNG_B64 = base64.b64encode(PNG_BYTES).decode()


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset_bridge():
    bridge.reset_for_tests()
    yield
    bridge.reset_for_tests()


@pytest.fixture(autouse=True)
def _force_private_network_guard(monkeypatch):
    """与 test_sd_provider_ssrf 同口径：强制走真实内网拦截路径。"""
    monkeypatch.setattr(mcp_service, "_allow_private_urls_in_development", lambda: False)


@pytest.fixture(autouse=True)
def _stub_public_dns(monkeypatch):
    """公网域固定解析，避免依赖外部 DNS（同 test_sd_provider_ssrf）。"""
    import socket

    original_getaddrinfo = socket.getaddrinfo

    def fake_getaddrinfo(host, *args, **kwargs):
        if host == "api.example.com":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
        return original_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


@pytest.fixture()
def write_config(tmp_path, monkeypatch):
    path = tmp_path / "image_generation_config.json"
    monkeypatch.setattr(igs, "_config_path", lambda: str(path))
    monkeypatch.setattr(igs, "_config_cache", None)
    monkeypatch.setattr(igs, "_config_mtime", None)

    def write(provider: dict) -> None:
        path.write_text(
            json.dumps({
                "enabled": True,
                "active_provider_id": provider["id"],
                "providers": [provider],
            }),
            encoding="utf-8",
        )
        igs._config_cache = None
        igs._config_mtime = None

    return write


@pytest.fixture()
def browser_comfyui_config(write_config):
    write_config({
        "id": "comfyui",
        "name": "ComfyUI",
        "type": "comfyui",
        "execution": "browser",
        "base_url": "http://127.0.0.1:8188",
        "timeout_seconds": 120,
    })


@pytest.fixture()
def saved_images(monkeypatch):
    saved: list[bytes] = []

    def fake_save(user_id: int, image_bytes: bytes) -> str:
        saved.append(image_bytes)
        return f"/api/uploads/generated-images/fake-{len(saved)}.png"

    monkeypatch.setattr(igs, "_save_generated_image", fake_save)
    return saved


@pytest.fixture()
def make_message(db_session, test_user):
    def _make() -> object:
        import uuid as _uuid

        from app.models import Character, CharacterChatMessage, CharacterChatSession

        char = Character(
            id=f"lbchar-{_uuid.uuid4().hex[:8]}",
            user_id=test_user.id,
            name="LocalBridgeChar",
        )
        db_session.add(char)
        db_session.flush()
        session_id = f"lbsess-{_uuid.uuid4().hex[:8]}"
        db_session.add(
            CharacterChatSession(
                id=session_id,
                user_id=test_user.id,
                character_id=char.id,
                title="local-bridge",
            )
        )
        db_session.commit()
        message = CharacterChatMessage(
            session_id=session_id,
            role="assistant",
            content="画一幅画",
        )
        db_session.add(message)
        db_session.commit()
        db_session.refresh(message)
        return message

    return _make


# ---------------------------------------------------------------------------
# 1. 配置面
# ---------------------------------------------------------------------------
class TestExecutionConfig:
    def test_browser_mode_allows_loopback_base_url(self) -> None:
        cleaned = igs._validate_provider({
            "id": "comfyui",
            "type": "comfyui",
            "execution": "browser",
            "base_url": "http://127.0.0.1:8188",
        })
        assert cleaned["execution"] == "browser"
        assert cleaned["base_url"] == "http://127.0.0.1:8188"

    @pytest.mark.parametrize("provider_type", ["openai_compatible", "sd_webui", "comfyui"])
    def test_server_mode_still_rejects_loopback(self, provider_type: str) -> None:
        with pytest.raises(ValueError, match="private/internal network address"):
            igs._validate_provider({
                "id": provider_type,
                "type": provider_type,
                "base_url": "http://127.0.0.1:8188",
            })

    def test_invalid_execution_falls_back_to_server(self) -> None:
        cleaned = igs._validate_provider({
            "id": "comfyui",
            "type": "comfyui",
            "execution": "hijack",
            "base_url": "https://api.example.com",
        })
        assert cleaned["execution"] == "server"

    def test_invalid_execution_loopback_still_rejected(self) -> None:
        with pytest.raises(ValueError, match="private/internal network address"):
            igs._validate_provider({
                "id": "comfyui",
                "type": "comfyui",
                "execution": "hijack",
                "base_url": "http://127.0.0.1:8188",
            })

    def test_openai_compatible_is_always_server(self) -> None:
        cleaned = igs._validate_provider({
            "id": "oai",
            "type": "openai_compatible",
            "execution": "browser",
            "base_url": "https://api.example.com",
        })
        assert cleaned["execution"] == "server"

    def test_sd_webui_browser_mode_allows_loopback(self) -> None:
        cleaned = igs._validate_provider({
            "id": "sd_webui",
            "type": "sd_webui",
            "execution": "browser",
            "base_url": "http://127.0.0.1:7860",
        })
        assert cleaned["execution"] == "browser"

    def test_default_config_comfyui_is_server(self) -> None:
        providers = {p["id"]: p for p in igs._default_config()["providers"]}
        assert providers["comfyui"]["execution"] == "server"
        assert providers["sd_webui"]["execution"] == "server"


# ---------------------------------------------------------------------------
# 2. 委派链（服务层端到端，测试进程扮演用户浏览器）
# ---------------------------------------------------------------------------
class TestBrowserDelegationFlow:
    def test_full_flow_creates_task_and_converges_media_ready(
        self, db_session, test_user, make_message, browser_comfyui_config, saved_images
    ):
        message = make_message()

        async def scenario():
            gen_task = asyncio.create_task(
                igs.generate_image_for_message(db_session, test_user, message, [])
            )
            await asyncio.sleep(0.05)
            claimed = bridge.claim_pending_tasks(test_user.id)
            assert len(claimed) == 1
            payload = claimed[0]
            assert payload["kind"] == "comfyui"
            assert payload["message_kind"] == "character"
            assert payload["base_url"] == "http://127.0.0.1:8188"
            assert payload["media_id"]
            # 工作流由后端组装完整下发（浏览器原样 POST /prompt）
            assert payload["workflow"]["9"]["class_type"] == "SaveImage"
            workflow_seed = payload["workflow"]["3"]["inputs"]["seed"]
            assert workflow_seed >= 0
            bridge.complete_local_task(payload["task_id"], test_user.id, [PNG_B64])
            return payload, workflow_seed, await gen_task

        payload, workflow_seed, result = _run(scenario())

        assert result.image_url.startswith("/api/uploads/generated-images/")
        assert result.metadata["seed"] == workflow_seed
        assert saved_images == [PNG_BYTES]
        db_session.expire_all()
        from app.services.message_media_service import get_message_media

        media = get_message_media(message)
        assert len(media) == 1
        assert media[0]["status"] == "ready"
        assert media[0]["id"] == payload["media_id"]
        assert media[0]["url"] == result.image_url

    def test_browser_fail_reports_error_and_media_failed(
        self, db_session, test_user, make_message, browser_comfyui_config, saved_images
    ):
        message = make_message()

        async def scenario():
            gen_task = asyncio.create_task(
                igs.generate_image_for_message(db_session, test_user, message, [])
            )
            await asyncio.sleep(0.05)
            claimed = bridge.claim_pending_tasks(test_user.id)
            bridge.fail_local_task(claimed[0]["task_id"], test_user.id, "CORS 未放行")
            return await gen_task

        with pytest.raises(igs.MessageImageGenerationError) as excinfo:
            _run(scenario())

        assert "CORS 未放行" in str(excinfo.value.detail)
        db_session.expire_all()
        from app.services.message_media_service import get_message_media

        media = get_message_media(message)
        assert media[0]["status"] == "failed"
        assert "CORS" in media[0]["error"]
        assert saved_images == []

    def test_wait_timeout_raises_504_and_media_failed(
        self, db_session, test_user, make_message, write_config, saved_images, monkeypatch
    ):
        write_config({
            "id": "comfyui",
            "type": "comfyui",
            "execution": "browser",
            "base_url": "http://127.0.0.1:8188",
            # 原始配置不经验证，int(0.5)=0 → wait_for(timeout=0) 立即超时
            "timeout_seconds": 0.5,
        })
        message = make_message()

        with pytest.raises(igs.MessageImageGenerationError) as excinfo:
            _run(igs.generate_image_for_message(db_session, test_user, message, []))

        assert excinfo.value.status_code == 504
        db_session.expire_all()
        from app.services.message_media_service import get_message_media

        assert get_message_media(message)[0]["status"] == "failed"


# ---------------------------------------------------------------------------
# 3. 端点面
# ---------------------------------------------------------------------------
class TestLocalTaskEndpoints:
    def _create_task(self, user_id: int, media_id: str = "m_abc123456789") -> object:
        return bridge.create_local_task(
            user_id=user_id,
            kind="comfyui",
            message_kind="character",
            session_id="s1",
            message_id=1,
            media_id=media_id,
            prompt="a cat",
            base_url="http://127.0.0.1:8188",
            workflow={"9": {"class_type": "SaveImage"}},
            seed=42,
            timeout_seconds=120,
        )

    def test_claim_marks_dispatched_and_within_ttl_no_reissue(self, client, auth_headers, test_user):
        self._create_task(user_id=test_user.id)

        claimed = client.get(
            "/api/image-generation/local-tasks/pending", headers=auth_headers
        ).json()
        assert len(claimed["tasks"]) == 1
        assert claimed["tasks"][0]["workflow"] == {"9": {"class_type": "SaveImage"}}
        assert claimed["tasks"][0]["timeout_ms"] == 120000

        # 已 dispatched 且在 TTL 内：再次认领不重复下发
        again = client.get(
            "/api/image-generation/local-tasks/pending", headers=auth_headers
        ).json()
        assert again["tasks"] == []

    def test_result_then_idempotent_and_404_for_missing(
        self, client, auth_headers, test_user
    ):
        task = self._create_task(user_id=test_user.id)

        ok = client.post(
            f"/api/image-generation/local-tasks/{task.task_id}/result",
            json={"images": [PNG_B64]},
            headers=auth_headers,
        )
        assert ok.status_code == 200
        assert ok.json()["status"] == "ok"

        again = client.post(
            f"/api/image-generation/local-tasks/{task.task_id}/result",
            json={"images": [PNG_B64]},
            headers=auth_headers,
        )
        assert again.status_code == 200
        assert again.json()["status"] == "already_done"

        missing = client.post(
            "/api/image-generation/local-tasks/lt_nonexistent/result",
            json={"images": [PNG_B64]},
            headers=auth_headers,
        )
        assert missing.status_code == 404

    def test_result_rejects_non_image_payload(self, client, auth_headers, test_user):
        task = self._create_task(user_id=test_user.id)
        text_b64 = base64.b64encode(b"definitely not an image").decode()
        resp = client.post(
            f"/api/image-generation/local-tasks/{task.task_id}/result",
            json={"images": [text_b64]},
            headers=auth_headers,
        )
        assert resp.status_code == 400

    def test_fail_endpoint_marks_task_failed(self, client, auth_headers, test_user):
        task = self._create_task(user_id=test_user.id)
        resp = client.post(
            f"/api/image-generation/local-tasks/{task.task_id}/fail",
            json={"error": "ComfyUI 不在本机"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        stored = bridge._tasks[task.task_id]
        assert stored.status == "failed"
        assert stored.error == "ComfyUI 不在本机"

    def test_test_endpoint_rejects_browser_execution(
        self, client, auth_headers, browser_comfyui_config
    ):
        resp = client.post(
            "/api/image-generation/test",
            json={"prompt": "a cat"},
            headers=auth_headers,
        )
        assert resp.status_code == 400
        assert "检测本机" in resp.json()["detail"]

    def test_expired_dispatched_task_is_reclaimed_after_ttl(
        self, client, auth_headers, test_user
    ):
        task = self._create_task(user_id=test_user.id)
        first = client.get(
            "/api/image-generation/local-tasks/pending", headers=auth_headers
        ).json()
        assert len(first["tasks"]) == 1

        # 模拟标签页失联：dispatched_at 拨回 50s（> 45s TTL）
        task.dispatched_at = time.monotonic() - 50.0
        reclaimed = client.get(
            "/api/image-generation/local-tasks/pending", headers=auth_headers
        ).json()
        assert len(reclaimed["tasks"]) == 1
        assert reclaimed["tasks"][0]["task_id"] == task.task_id


# ---------------------------------------------------------------------------
# 4. 安全与资源上限
# ---------------------------------------------------------------------------
class TestGuards:
    def test_decode_rejects_bad_base64(self) -> None:
        with pytest.raises(HTTPException) as excinfo:
            _decode_uploaded_image_b64("!!!!not-base64!!!!")
        assert excinfo.value.status_code == 400

    def test_decode_accepts_data_url_and_raw(self) -> None:
        from_data_url = _decode_uploaded_image_b64(f"data:image/png;base64,{PNG_B64}")
        from_raw = _decode_uploaded_image_b64(PNG_B64)
        assert from_data_url == from_raw == PNG_BYTES

    def test_decode_rejects_oversized_image(self) -> None:
        import base64 as b64mod

        big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (30 * 1024 * 1024 + 1)
        with pytest.raises(HTTPException) as excinfo:
            _decode_uploaded_image_b64(b64mod.b64encode(big).decode())
        assert excinfo.value.status_code == 413

    def test_decode_rejects_webp_without_webp_tag(self) -> None:
        riff_only = b"RIFF\x00\x00\x00\x00XXXX" + b"\x00" * 16
        with pytest.raises(HTTPException):
            _decode_uploaded_image_b64(base64.b64encode(riff_only).decode())

    def test_decode_accepts_webp(self) -> None:
        webp = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 20
        assert _decode_uploaded_image_b64(base64.b64encode(webp).decode()) == webp

    def test_result_owner_isolation(self, db_session, test_user):
        """归属隔离在桥层锁定：非属主按不存在处理。"""
        from app.core.security import get_password_hash
        from app.models import User

        other = User(
            username="bridge_owner_iso",
            hashed_password=get_password_hash("TestPassword1"),
            role="user",
            is_active=True,
        )
        db_session.add(other)
        db_session.commit()

        task = bridge.create_local_task(
            user_id=test_user.id,
            kind="comfyui",
            message_kind="chat",
            session_id=None,
            message_id=None,
            media_id="m_abc123456789",
            prompt="p",
            base_url="http://127.0.0.1:8188",
            workflow={},
            seed=1,
            timeout_seconds=120,
        )
        with pytest.raises(HTTPException) as excinfo:
            bridge.complete_local_task(task.task_id, other.id, [PNG_B64])
        assert excinfo.value.status_code == 404

    def test_active_task_overflow_cancels_oldest(self, test_user):
        tasks = []
        for i in range(8):
            tasks.append(bridge.create_local_task(
                user_id=test_user.id,
                kind="comfyui",
                message_kind="chat",
                session_id=None,
                message_id=None,
                media_id=f"m_{i:012d}",
                prompt="p",
                base_url="http://127.0.0.1:8188",
                workflow={},
                seed=i,
                timeout_seconds=120,
            ))
        ninth = bridge.create_local_task(
            user_id=test_user.id,
            kind="comfyui",
            message_kind="chat",
            session_id=None,
            message_id=None,
            media_id="m_ninth000000",
            prompt="p",
            base_url="http://127.0.0.1:8188",
            workflow={},
            seed=9,
            timeout_seconds=120,
        )
        assert tasks[0].status == "failed"
        assert "积压" in (tasks[0].error or "")
        assert ninth.status == "pending"

    def test_sweeper_expires_stale_tasks(self, test_user, monkeypatch):
        task = bridge.create_local_task(
            user_id=test_user.id,
            kind="comfyui",
            message_kind="chat",
            session_id=None,
            message_id=None,
            media_id="m_sweeper00000",
            prompt="p",
            base_url="http://127.0.0.1:8188",
            workflow={},
            seed=1,
            timeout_seconds=1,
        )
        # 直接跑一轮清扫逻辑（不起常级行程）：把 created_at 拨老
        task.created_at = time.monotonic() - 120.0
        now = time.monotonic()
        for t in list(bridge._tasks.values()):
            if t.status in ("pending", "dispatched") and not t.done.is_set():
                if now - t.created_at > t.timeout_seconds + 45.0:
                    t.status = "expired"
                    t.error = "本地出图任务超时未回传"
                    t.done.set()
        assert task.status == "expired"

        # 等待方拿到 504
        with pytest.raises(HTTPException) as excinfo:
            _run(bridge.await_local_task(task))
        assert excinfo.value.status_code == 504
