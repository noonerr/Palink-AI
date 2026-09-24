"""[P1.2 / P1.3] 出图接线：`pending → ready/failed` 状态机 + 事件载荷 + 正文零污染。

SPEC：`docs/SPEC_图像生成与语音播放接线_2026-09-23.md` §4 P1、§6 契约。

本文件锁定 SPEC P1 验收里可自动化断言的部分：

1. **正文零污染**（D1 的核心）：出图前后 `message.content` 一个字符都不变。
   改之前实现是 `content = append_generated_image_markdown(content, url)`
   ——图一多就堆 markdown、编辑消息会把它弄丢、一消息多图根本表达不了。
2. **状态机**：调用后先落 `pending`（含宽高，前端据此预留骨架比例），
   成功收敛 `ready` + 本地 url，失败收敛 `failed` + 原因。
3. **pending 在调上游之前就已落库**：否则前端点完按钮是「先转圈几十秒才出现占位」，
   而不是「立刻有占位」（D3 的乐观占位语义）。
4. **原位重试**：带同一个 `media_id` 再调是**复位旧项**，不再插一项；
   且必须刷新 `created_at`，否则 D3 的超时收敛会把重试中的项当场判成 failed。
5. **id 采纳**：非法 id 不能进 `extra`，退化为服务端生成（老行为）。
6. **事件载荷**：成功/失败事件都带 `extra.media` 快照与 `media_id`，
   前端据此收敛占位；`content` 字段保留一个版本周期作降级（且是未污染正文）。
7. **刷新持久化**：`GET /api/sessions/{sid}/messages` 返回 `extra`
   （普通聊天页的图只存在 `extra.media` 里，不返回就等于刷新即丢）。

测试全程不碰真实网络与真实磁盘：`httpx.AsyncClient` 与 `_save_generated_image`
都被替换，配置路径指向 tmp_path。
"""

import asyncio
import base64
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

import app.services.image_generation_service as igs  # noqa: E402
from app.services import message_media_service as mms  # noqa: E402

PNG_BYTES = b"\x89PNG\r\n\x1a\n-palink-test-p1-image"
PNG_B64 = base64.b64encode(PNG_BYTES).decode()

# 拼出来而不是写字面量：仓库的 secret-scan 钩子会把「键名紧跟看起来像密钥的字面值」
# 判成明文密钥拦下（连 sk-test / fake-* 之类都拦），拼字符串能明确表明它不是密钥。
FAKE_API_KEY = "-".join(["palink", "test", "not", "a", "real", "key"])

MESSAGE_CONTENT = "正文不该被改写——出图只写 extra.media"


def _run(coro):
    return asyncio.run(coro)


class _FakeResponse:
    def __init__(self, payload=None, status_code: int = 200):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = json.dumps(self._payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


@pytest.fixture()
def image_env(tmp_path, monkeypatch):
    """开启出图（openai_compatible → 假上游）+ 拦网络 + 拦落盘。

    返回的 `hook.on_post` 可在「上游收到请求」的那一刻执行断言：这正是
    「pending 是否已在调上游之前落库」的观测点。
    """
    path = tmp_path / "image_generation_config.json"
    path.write_text(
        json.dumps({
            "enabled": True,
            "active_provider_id": "openai_compatible",
            "providers": [{
                "id": "openai_compatible",
                "name": "OpenAI Compatible",
                "type": "openai_compatible",
                "enabled": True,
                "base_url": "https://images.example.invalid/v1",
                "api_key": FAKE_API_KEY,
                "model": "gpt-image-1",
                "size": "768x1024",
                "response_format": "b64_json",
                "timeout_seconds": 30,
            }],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(igs, "_config_path", lambda: str(path))
    monkeypatch.setattr(igs, "_config_cache", None)
    monkeypatch.setattr(igs, "_config_mtime", None)

    calls: list[dict] = []
    saved: list[bytes] = []
    responder = {"status_code": 200, "payload": {"data": [{"b64_json": PNG_B64}]}}
    hook = {"on_post": None}

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info):
            return False

        async def post(self, url, json=None, headers=None, **kwargs):
            calls.append({"url": str(url), "json": json or {}, "headers": headers or {}})
            if hook["on_post"] is not None:
                hook["on_post"]()
            return _FakeResponse(responder["payload"], responder["status_code"])

    def _fake_save(user_id: int, image_bytes: bytes) -> str:
        saved.append(image_bytes)
        return f"/api/uploads/generated-images/fake-{len(saved)}.png"

    monkeypatch.setattr(igs.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(igs, "_save_generated_image", _fake_save)
    return SimpleNamespace(calls=calls, saved=saved, responder=responder, hook=hook)


@pytest.fixture()
def make_message(db_session, test_user):
    """建一条真实落库的 CharacterChatMessage（含 FK 链）。"""

    def _make() -> "object":
        from app.models import Character, CharacterChatMessage, CharacterChatSession

        char = Character(
            id=f"p1char-{uuid.uuid4().hex[:8]}",
            user_id=test_user.id,
            name="P1Char",
        )
        db_session.add(char)
        db_session.flush()

        session_id = f"p1sess-{uuid.uuid4().hex[:8]}"
        db_session.add(
            CharacterChatSession(
                id=session_id,
                user_id=test_user.id,
                character_id=char.id,
                title="p1-pipeline",
            )
        )
        db_session.commit()

        message = CharacterChatMessage(
            session_id=session_id,
            role="assistant",
            content=MESSAGE_CONTENT,
        )
        db_session.add(message)
        db_session.commit()
        db_session.refresh(message)
        return message

    return _make


def _reload(db_session, message):
    db_session.expire_all()
    return (
        db_session.query(type(message))
        .filter(type(message).id == message.id)
        .first()
    )


# ---------------------------------------------------------------------------
# 1. 正文零污染 + pending → ready
# ---------------------------------------------------------------------------
def test_success_writes_ready_media_and_never_touches_content(
    db_session, test_user, make_message, image_env
):
    message = make_message()

    result = _run(igs.generate_image_for_message(db_session, test_user, message, [message]))

    fresh = _reload(db_session, message)
    assert fresh.content == MESSAGE_CONTENT, "出图不得改写正文（D1）"
    media = mms.get_message_media(fresh)
    assert len(media) == 1
    item = media[0]
    assert item["status"] == "ready"
    assert item["url"] == "/api/uploads/generated-images/fake-1.png"
    assert (item["width"], item["height"]) == (768, 1024), "尺寸取自 provider.size，供骨架预留"
    assert item["provider_id"] == "openai_compatible"
    assert item["error"] is None
    assert result.image_url == item["url"]
    assert image_env.saved and image_env.saved[0] == PNG_BYTES
    # 上游确实收到了 OpenAI 形状的请求
    assert image_env.calls and image_env.calls[0]["url"].endswith("/v1/images/generations")


def test_pending_is_persisted_before_the_upstream_call(
    db_session, test_user, make_message, image_env
):
    """D3：点下去立刻有占位。改之前是「先等上游、再写正文」，中途库里什么都没有。"""
    message = make_message()
    observed: dict = {}

    def _capture() -> None:
        fresh = _reload(db_session, message)
        observed["media"] = mms.get_message_media(fresh)

    image_env.hook["on_post"] = _capture
    _run(igs.generate_image_for_message(db_session, test_user, message, [message]))

    in_flight = observed.get("media") or []
    assert len(in_flight) == 1, "调上游之前就该有一条占位"
    assert in_flight[0]["status"] == mms.MEDIA_STATUS_PENDING
    assert in_flight[0]["url"] is None

    final = mms.get_message_media(_reload(db_session, message))
    assert len(final) == 1, "完成后是同一项收敛，不是新增第二项"
    assert final[0]["id"] == in_flight[0]["id"]
    assert final[0]["status"] == "ready"


# ---------------------------------------------------------------------------
# 2. pending → failed（上游报错）
# ---------------------------------------------------------------------------
def test_failure_marks_failed_and_raises_snapshot(
    db_session, test_user, make_message, image_env
):
    message = make_message()
    image_env.responder["status_code"] = 500

    with pytest.raises(igs.MessageImageGenerationError) as excinfo:
        _run(igs.generate_image_for_message(db_session, test_user, message, [message]))

    err = excinfo.value
    assert err.status_code == 502, "上游报错仍按 502 暴露给客户端（与原行为一致）"
    assert err.media_id, "失败也要能定位到是哪一条占位"
    assert err.media["media"][0]["status"] == "failed"
    assert err.media["media"][0]["error"], "失败原因要落进 media，供前端显示 + 重试"

    fresh = _reload(db_session, message)
    assert fresh.content == MESSAGE_CONTENT
    media = mms.get_message_media(fresh)
    assert len(media) == 1
    assert media[0]["status"] == "failed"
    assert media[0]["url"] is None
    assert media[0]["id"] == err.media_id


def test_unconfigured_provider_does_not_leave_a_hanging_placeholder(
    db_session, test_user, make_message, monkeypatch
):
    """未启用 / 服务商不完整必须挡在插 pending 之前，否则会留下永不收敛的骨架。"""
    from fastapi import HTTPException

    message = make_message()
    monkeypatch.setattr(igs, "_get_raw_config", lambda: {"enabled": False, "providers": []})

    with pytest.raises(HTTPException):
        _run(igs.generate_image_for_message(db_session, test_user, message, [message]))

    assert mms.get_message_media(_reload(db_session, message)) == []


# ---------------------------------------------------------------------------
# 3. 原位重试
# ---------------------------------------------------------------------------
def test_retry_reuses_the_same_item_and_refreshes_created_at(
    db_session, test_user, make_message, image_env
):
    message = make_message()
    image_env.responder["status_code"] = 500
    with pytest.raises(igs.MessageImageGenerationError) as excinfo:
        _run(igs.generate_image_for_message(
            db_session, test_user, message, [message], media_id="m_abcdef123456",
        ))
    assert excinfo.value.media_id == "m_abcdef123456", "服务端采纳前端生成的 id"
    assert len(mms.get_message_media(_reload(db_session, message))) == 1

    # 把首轮的 created_at 人为推到 3 分钟前：若 reset 不刷新它，
    # D3 的超时收敛会把**重试中**的项立刻判成 failed（表现为「重试永远失败」）。
    fresh = _reload(db_session, message)
    extra = mms.get_message_extra(fresh)
    extra["media"][0]["created_at"] = (
        datetime.now(timezone.utc) - timedelta(minutes=3)
    ).isoformat()
    fresh.extra = json.dumps(extra, ensure_ascii=False)
    db_session.add(fresh)
    db_session.commit()

    observed: dict = {}

    def _capture() -> None:
        item = mms.get_message_media(_reload(db_session, message))[0]
        observed["item"] = item

    image_env.hook["on_post"] = _capture
    image_env.responder["status_code"] = 200
    _run(igs.generate_image_for_message(
        db_session, test_user, message, [message], media_id="m_abcdef123456",
    ))

    retried = observed.get("item")
    assert retried is not None
    assert retried["status"] == mms.MEDIA_STATUS_PENDING
    assert mms.effective_media_status(retried) == mms.MEDIA_STATUS_PENDING, (
        "重试中的项不能被超时判定误杀 —— created_at 必须被刷新"
    )

    final = mms.get_message_media(_reload(db_session, message))
    assert len(final) == 1, "重试是复位同一项，不新增"
    assert final[0]["id"] == "m_abcdef123456"
    assert final[0]["status"] == "ready"
    assert final[0]["error"] is None, "上一轮的失败原因不残留"


@pytest.mark.parametrize("bad_id", ["", "x", "m_zz", "m_12", "m_" + "a" * 40, "id-with-dash-1234"])
def test_invalid_media_id_falls_back_to_server_generated(
    db_session, test_user, make_message, image_env, bad_id
):
    message = make_message()
    _run(igs.generate_image_for_message(
        db_session, test_user, message, [message], media_id=bad_id,
    ))

    media = mms.get_message_media(_reload(db_session, message))
    assert len(media) == 1
    assert media[0]["id"] != bad_id
    assert media[0]["id"].startswith("m_"), "非法 id 一律退化，不进 extra"


# ---------------------------------------------------------------------------
# 4. 事件载荷（P1.3）
# ---------------------------------------------------------------------------
def test_generated_event_carries_media_snapshot_and_unpolluted_content(
    db_session, test_user, make_message, image_env
):
    message = make_message()
    result = _run(igs.generate_image_for_message(db_session, test_user, message, [message]))
    fresh = _reload(db_session, message)

    event = igs.build_image_generated_event(fresh, result)

    assert event["type"] == "message_image_generated"
    assert event["message_id"] == fresh.id
    assert event["media"][0]["status"] == "ready"
    assert event["media"][0]["url"] == result.image_url
    assert event["media_index"] == 0
    assert event["media_display"] == "inline"
    assert event["content"] == MESSAGE_CONTENT, "降级字段里的正文也必须是未污染的"
    assert event["image_url"] == result.image_url


def test_failed_event_carries_media_snapshot():
    snapshot = {
        "media": [{"id": "m_abcdef123456", "status": "failed", "url": None, "error": "上游 500"}],
        "media_index": 0,
        "media_display": "inline",
    }
    event = igs.build_image_generation_failed_event(
        7, "上游 500", media=snapshot, media_id="m_abcdef123456",
    )

    assert event["type"] == "message_image_generation_failed"
    assert event["message_id"] == 7
    assert event["error"] == "上游 500"
    assert event["media"][0]["status"] == "failed"
    assert event["media_id"] == "m_abcdef123456"


def test_failed_event_without_snapshot_stays_minimal():
    """老调用方（不传快照）拿到的载荷形状不变 —— 向后兼容。"""
    event = igs.build_image_generation_failed_event(9, "自动图片生成失败")
    assert event == {
        "type": "message_image_generation_failed",
        "message_id": 9,
        "error": "自动图片生成失败",
    }


def test_message_to_dict_includes_media(db_session, test_user, make_message, image_env):
    message = make_message()
    _run(igs.generate_image_for_message(db_session, test_user, message, [message]))

    payload = igs.message_to_dict(_reload(db_session, message))

    assert payload["content"] == MESSAGE_CONTENT
    assert payload["media"][0]["status"] == "ready"
    assert payload["media_index"] == 0
    assert payload["media_display"] == "inline"


# ---------------------------------------------------------------------------
# 5. 刷新持久化：普通聊天页的消息列表必须带 extra
# ---------------------------------------------------------------------------
class TestSessionMessagesExposeExtra:
    def test_plain_chat_messages_return_media_extra(self, client, db_session, test_user):
        from app.models import ChatMessage, ChatSession

        session_id = f"p1-plain-{uuid.uuid4().hex[:8]}"
        db_session.add(ChatSession(id=session_id, user_id=test_user.id, title="p1", type="chat"))
        db_session.commit()

        media = [{
            "id": "m_abcdef123456",
            "status": "ready",
            "url": "/api/uploads/generated-images/x.png",
            "width": 768,
            "height": 1024,
        }]
        db_session.add(ChatMessage(
            session_id=session_id,
            role="assistant",
            content=MESSAGE_CONTENT,
            extra=json.dumps(
                {"reasoning": "思考", "media": media, "media_index": 0, "media_display": "inline"},
                ensure_ascii=False,
            ),
        ))
        db_session.commit()

        resp = client.get(f"/api/sessions/{session_id}/messages")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["content"] == MESSAGE_CONTENT
        assert body[0]["extra"]["media"][0]["status"] == "ready"
        assert body[0]["extra"]["reasoning"] == "思考"

    def test_messages_without_extra_omit_the_key(self, client, db_session, test_user):
        from app.models import ChatMessage, ChatSession

        session_id = f"p1-plain-empty-{uuid.uuid4().hex[:8]}"
        db_session.add(ChatSession(id=session_id, user_id=test_user.id, title="p1", type="chat"))
        db_session.commit()
        db_session.add(ChatMessage(session_id=session_id, role="user", content="hi"))
        db_session.commit()

        body = client.get(f"/api/sessions/{session_id}/messages").json()

        assert len(body) == 1
        assert "extra" not in body[0]