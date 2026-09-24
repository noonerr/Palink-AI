"""[P1.1] `extra.media` 数据契约测试。

SPEC：`docs/SPEC_图像生成与语音播放接线_2026-09-23.md` §6 / §3(D1, D3)。

本文件锁定四件事：

1. **契约形状**：每条 media 的字段齐全（含 pending 期即写入的 width/height，
   用于骨架预留比例、避免完成后 CLS）；字段名与 ST 对齐
   （`media` / `media_index` / `media_display`），使插件与第一方共用一条写入路径。
2. **不丢字段**：`extra` 里原有的键（如 `swipe_info`）在 attach/update 后必须原样保留 ——
   D1 迁移最容易踩的坑就是把别人的字段覆盖掉。
3. **状态机**：pending → ready（写 url）/ pending → failed（写 error）；未命中要能被识别。
4. **超时收敛不写库**：pending 超过阈值在**读取期**显示为 failed，但落库值仍是 pending
   （D3 明确要求，避免后台任务与前台判定互相打架）。
"""

import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402

from app.services import message_media_service as mms  # noqa: E402


def _make_message(db_session, test_user, *, extra=None):
    """建一条真实落库的 CharacterChatMessage（含 FK 链），返回该消息。"""
    from app.models import Character, CharacterChatMessage, CharacterChatSession

    char = Character(
        id=f"mmchar-{uuid.uuid4().hex[:8]}",
        user_id=test_user.id,
        name="MediaChar",
    )
    db_session.add(char)
    db_session.flush()

    session_id = f"mmsess-{uuid.uuid4().hex[:8]}"
    db_session.add(
        CharacterChatSession(
            id=session_id,
            user_id=test_user.id,
            character_id=char.id,
            title="media-contract",
        )
    )
    db_session.commit()

    message = CharacterChatMessage(
        session_id=session_id,
        role="assistant",
        content="正文不该被改写",
        extra=json.dumps(extra, ensure_ascii=False) if extra is not None else None,
    )
    db_session.add(message)
    db_session.commit()
    db_session.refresh(message)
    return message


# ---------------------------------------------------------------------------
# 契约形状
# ---------------------------------------------------------------------------
def test_build_media_item_full_shape():
    item = mms.build_media_item(prompt="a cat", width=512, height=768, provider_id="sd_webui")
    assert set(item) == {
        "id", "status", "url", "width", "height",
        "prompt", "seed", "provider_id", "error", "created_at",
    }
    assert item["status"] == mms.MEDIA_STATUS_PENDING
    assert item["url"] is None
    assert item["error"] is None
    assert (item["width"], item["height"]) == (512, 768)


@pytest.mark.parametrize("bad", [None, 0, -5, "abc", ""])
def test_build_media_item_dimension_fallback_prevents_cls(bad):
    """宽高缺失/非法时回落到默认比例 —— 骨架必须能预留尺寸。"""
    item = mms.build_media_item(width=bad, height=bad)
    assert (item["width"], item["height"]) == (
        mms.DEFAULT_MEDIA_WIDTH, mms.DEFAULT_MEDIA_HEIGHT,
    )


def test_build_media_item_rejects_unknown_status():
    with pytest.raises(ValueError):
        mms.build_media_item(status="generating")


def test_new_media_id_prefix_and_uniqueness():
    ids = {mms.new_media_id() for _ in range(200)}
    assert len(ids) == 200
    assert all(i.startswith("m_") for i in ids)


# ---------------------------------------------------------------------------
# 写入：不丢字段 + 多图
# ---------------------------------------------------------------------------
def test_attach_sets_defaults_on_first_write(db_session, test_user):
    message = _make_message(db_session, test_user)
    extra = mms.attach_message_media(db_session, message, mms.build_media_item(prompt="p1"))

    assert len(extra["media"]) == 1
    assert extra["media_index"] == 0
    assert extra["media_display"] == mms.MEDIA_DISPLAY_INLINE


def test_attach_appends_for_multi_image(db_session, test_user):
    message = _make_message(db_session, test_user)
    first = mms.build_media_item(prompt="p1")
    mms.attach_message_media(db_session, message, first)
    mms.attach_message_media(db_session, message, mms.build_media_item(prompt="p2"))

    media = mms.get_message_media(message)
    assert [m["prompt"] for m in media] == ["p1", "p2"]
    assert media[0]["id"] == first["id"]


def test_attach_preserves_sibling_extra_keys(db_session, test_user):
    """回归护栏：D1 迁移不得覆盖 extra 里的其它键（如 swipe_info）。"""
    message = _make_message(
        db_session,
        test_user,
        extra={"swipe_info": [{"send_date": "", "extra": {}}], "keep_me": 42},
    )
    mms.attach_message_media(db_session, message, mms.build_media_item(prompt="p1"))

    extra = mms.get_message_extra(message)
    assert extra["keep_me"] == 42
    assert isinstance(extra["swipe_info"], list) and extra["swipe_info"]

    stored = json.loads(message.extra)
    assert stored["keep_me"] == 42


def test_attach_overwrites_corrupt_media_without_crashing(db_session, test_user):
    """media 是坏数据（非 list）时应重建，而不是抛异常。"""
    message = _make_message(db_session, test_user, extra={"media": "not-a-list"})
    extra = mms.attach_message_media(db_session, message, mms.build_media_item(prompt="p1"))
    assert isinstance(extra["media"], list) and len(extra["media"]) == 1


# ---------------------------------------------------------------------------
# 读取：坏数据降级
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("raw", [None, "", "not json", "[]", '"str"', "123"])
def test_get_message_media_degrades_on_bad_extra(db_session, test_user, raw):
    message = _make_message(db_session, test_user)
    message.extra = raw
    assert mms.get_message_media(message) == []


def test_get_message_media_filters_non_dict_entries(db_session, test_user):
    message = _make_message(
        db_session,
        test_user,
        extra={"media": [{"id": "m_ok", "status": "ready"}, "junk", 7, None]},
    )
    media = mms.get_message_media(message)
    assert [m["id"] for m in media] == ["m_ok"]


# ---------------------------------------------------------------------------
# 状态机收敛
# ---------------------------------------------------------------------------
def test_update_media_status_pending_to_ready(db_session, test_user):
    message = _make_message(db_session, test_user)
    item = mms.build_media_item(prompt="p1")
    mms.attach_message_media(db_session, message, item)

    ok = mms.update_media_status(
        db_session, message, item["id"], mms.MEDIA_STATUS_READY,
        url="/api/uploads/generated-images/abc.png", seed=1234,
    )
    assert ok is True

    stored = mms.get_message_media(message)[0]
    assert stored["status"] == "ready"
    assert stored["url"] == "/api/uploads/generated-images/abc.png"
    assert stored["seed"] == 1234
    assert stored["updated_at"]


def test_update_media_status_pending_to_failed_keeps_error(db_session, test_user):
    message = _make_message(db_session, test_user)
    item = mms.build_media_item(prompt="p1")
    mms.attach_message_media(db_session, message, item)

    mms.update_media_status(
        db_session, message, item["id"], mms.MEDIA_STATUS_FAILED, error="上游 500",
    )
    stored = mms.get_message_media(message)[0]
    assert stored["status"] == "failed"
    assert stored["error"] == "上游 500"
    assert stored["url"] is None


def test_update_media_status_miss_returns_false(db_session, test_user):
    message = _make_message(db_session, test_user)
    mms.attach_message_media(db_session, message, mms.build_media_item(prompt="p1"))
    assert mms.update_media_status(
        db_session, message, "m_not-exist", mms.MEDIA_STATUS_READY, url="/x.png",
    ) is False


def test_update_media_status_rejects_unknown_status(db_session, test_user):
    message = _make_message(db_session, test_user)
    item = mms.build_media_item(prompt="p1")
    mms.attach_message_media(db_session, message, item)
    with pytest.raises(ValueError):
        mms.update_media_status(db_session, message, item["id"], "done")


def test_update_media_status_targets_only_matching_item(db_session, test_user):
    message = _make_message(db_session, test_user)
    a = mms.build_media_item(prompt="a")
    b = mms.build_media_item(prompt="b")
    mms.attach_message_media(db_session, message, a)
    mms.attach_message_media(db_session, message, b)

    mms.update_media_status(db_session, message, b["id"], mms.MEDIA_STATUS_READY, url="/b.png")
    media = {m["id"]: m for m in mms.get_message_media(message)}
    assert media[a["id"]]["status"] == "pending"
    assert media[b["id"]]["status"] == "ready"


# ---------------------------------------------------------------------------
# 超时收敛（只判定，不写库）
# ---------------------------------------------------------------------------
def _item_with_age(seconds: int) -> dict:
    item = mms.build_media_item(prompt="p")
    item["created_at"] = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()
    return item


def test_effective_status_passthrough_for_settled_states():
    assert mms.effective_media_status({"status": "ready"}) == "ready"
    assert mms.effective_media_status({"status": "failed"}) == "failed"


def test_effective_status_pending_within_timeout_stays_pending():
    item = _item_with_age(mms.PENDING_TIMEOUT_SECONDS - 30)
    assert mms.effective_media_status(item) == "pending"


def test_effective_status_pending_past_timeout_becomes_failed():
    item = _item_with_age(mms.PENDING_TIMEOUT_SECONDS + 30)
    assert mms.effective_media_status(item) == "failed"


def test_effective_status_bad_created_at_does_not_crash():
    item = mms.build_media_item(prompt="p")
    item["created_at"] = "yesterday"
    assert mms.effective_media_status(item) == "pending"
    assert mms.effective_media_status({}) is None
    assert mms.effective_media_status("junk") is None


def test_media_for_api_timeout_view_does_not_persist(db_session, test_user):
    """D3：超时只在读取期显示为 failed，落库值必须仍是 pending。"""
    message = _make_message(db_session, test_user)
    item = _item_with_age(mms.PENDING_TIMEOUT_SECONDS + 60)
    mms.attach_message_media(db_session, message, item)

    payload = mms.media_for_api(message)
    assert payload["media"][0]["status"] == "failed"
    assert mms.get_message_media(message)[0]["status"] == "pending"


# ---------------------------------------------------------------------------
# 对外载荷
# ---------------------------------------------------------------------------
def test_media_for_api_clamps_index_and_display(db_session, test_user):
    message = _make_message(
        db_session,
        test_user,
        extra={"media": [{"id": "m_a", "status": "ready"}], "media_index": 9, "media_display": "weird"},
    )
    payload = mms.media_for_api(message)
    assert payload["media_index"] == 0
    assert payload["media_display"] == mms.MEDIA_DISPLAY_INLINE
    assert len(payload["media"]) == 1


def test_media_for_api_keeps_gallery_display(db_session, test_user):
    message = _make_message(
        db_session,
        test_user,
        extra={"media": [], "media_index": 0, "media_display": "gallery"},
    )
    assert mms.media_for_api(message)["media_display"] == "gallery"


# ---------------------------------------------------------------------------
# 移除
# ---------------------------------------------------------------------------
def test_remove_message_media_resets_index(db_session, test_user):
    message = _make_message(db_session, test_user)
    a = mms.build_media_item(prompt="a")
    b = mms.build_media_item(prompt="b")
    mms.attach_message_media(db_session, message, a)
    mms.attach_message_media(db_session, message, b)
    mms.update_media_status(db_session, message, b["id"], mms.MEDIA_STATUS_READY, url="/b.png")

    # 手工把 index 指到第 2 张，再删掉它 → index 必须回落
    extra = mms.get_message_extra(message)
    extra["media_index"] = 1
    message.extra = json.dumps(extra, ensure_ascii=False)
    db_session.add(message)
    db_session.commit()

    assert mms.remove_message_media(db_session, message, b["id"]) is True
    assert [m["id"] for m in mms.get_message_media(message)] == [a["id"]]
    assert mms.get_message_extra(message)["media_index"] == 0
    assert mms.remove_message_media(db_session, message, "m_absent") is False
