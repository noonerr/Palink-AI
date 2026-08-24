"""批次 C：后端安全卫生 + PATCH/swipe 记忆同步二期 + 测试基建。

spec: docs/SPEC_清理批次总案_除N8_2026-08-24.md §3
覆盖面：
1. C1 [MEM-SYNC-ON-SWITCH] switch_message_swipe 切换致 content 变化时记忆镜像同步；
   内容未变零操作；assistant 经 clean_memory_content；branch_id 取消息当前值；
   服务不可用不崩溃
2. C2 N-13 契约：api 层不再有未脱敏的 4xx detail=str(e)（白名单外）
3. C3 N-15 日志脱敏 (sk|pk)- 裸密钥模式
4. C4 N-16 本地模型上传限流落盘 + env 可配置上限超限 413
5. C5 N-17 admin 会话消息 / plotline 列表 limit 限幅
6. C6 N-18 prod 弱 ADMIN_PASSWORD 启动阻断
"""

import io
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

try:
    from app.api import character_ext as ce_mod
    from app.core.config import Settings, settings
    from app.core.log_sanitizer import sanitize_message
    from app.memory_module import storage as mem_storage_mod
    from app.memory_module.config import memory_config
    from app.memory_module.service import MemoryService
    from app.memory_module.storage import MemoryStorage
    from app.models import (
        CharacterChatMessage,
        CharacterChatSession,
        ChatMessage,
        ChatSession,
        PlotLine,
    )
    from app.services.local_model_registry import upload_local_model
    from app.utils import clean_memory_content
    _IMPORT_OK = True
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    _IMPORT_OK = False
    _IMPORT_ERROR = exc

pytestmark = pytest.mark.skipif(not _IMPORT_OK, reason=f"依赖缺失，跳过: {_IMPORT_ERROR}")


# ─────────────────────────────────────────────────────────────────────
# 共享工具
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture()
def mem_env(db_session, _engine, monkeypatch):
    """初始化 memory 表并把后台线程的 SessionLocal 接到测试引擎上。"""
    monkeypatch.setattr(mem_storage_mod, "_tables_initialized", False)
    monkeypatch.setattr(mem_storage_mod, "_is_postgres_cached", None)
    monkeypatch.setattr(mem_storage_mod, "_migration_done", False)
    monkeypatch.setattr(memory_config, "ENABLED", True)

    def _embed_unavailable(*args, **kwargs):
        raise RuntimeError("embedder unavailable in tests")

    monkeypatch.setattr(mem_storage_mod, "embed_text", _embed_unavailable)

    from sqlalchemy.orm import sessionmaker
    test_session_factory = sessionmaker(
        bind=_engine, autoflush=False, autocommit=False, expire_on_commit=False
    )
    monkeypatch.setattr(ce_mod, "SessionLocal", test_session_factory)

    MemoryStorage(db_session)
    return db_session


def _patch_embed_signal(monkeypatch):
    ev = threading.Event()

    def _fake_embed(*args, **kwargs):
        ev.set()
        raise RuntimeError("embed signal raised (degradation path)")

    monkeypatch.setattr(mem_storage_mod, "embed_text", _fake_embed)
    return ev


def _seed_swiped_message(db, user, *, role="assistant", swipes=None, swipe_id=0,
                         branch_id="br-sw"):
    from app.models import CharacterChatSessionBranch
    sess = CharacterChatSession(user_id=user.id, title="t")
    db.add(sess)
    db.flush()
    db.add(CharacterChatSessionBranch(
        id=branch_id, session_id=sess.id, branch_name=branch_id, is_active=True,
    ))
    msg = CharacterChatMessage(
        session_id=sess.id,
        branch_id=branch_id,
        role=role,
        content=(swipes or ["初始正文"])[swipe_id],
        is_user=(role == "user"),
        is_system=False,
        is_locked=False,
        swipe_id=swipe_id,
        swipes=json.dumps(swipes or ["初始正文"], ensure_ascii=False),
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return sess, msg


def _mem_rows(db, session_id, message_id):
    return db.execute(text(
        "SELECT id, role, content, branch_id, message_id FROM conversation_memories "
        "WHERE session_id = :s AND message_id = :m ORDER BY id"
    ), {"s": session_id, "m": message_id}).fetchall()


def _seed_memory(db, user, session_id, message_id, *, content, role="assistant",
                 branch_id="br-sw"):
    db.execute(text(
        "INSERT INTO conversation_memories "
        "(user_id, session_id, branch_id, role, content, embedding, "
        " importance_score, topics, tokens_count, created_at, message_id) "
        "VALUES (:u, :s, :b, :r, :c, NULL, 0.5, '[]', 0, CURRENT_TIMESTAMP, :m)"
    ), {"u": user.id, "s": session_id, "b": branch_id, "r": role,
        "c": content, "m": message_id})
    db.commit()


# ─────────────────────────────────────────────────────────────────────
# C1 [MEM-SYNC-ON-SWITCH]
# ─────────────────────────────────────────────────────────────────────

class TestMemSyncOnSwitch:
    SWIPES = [
        "第一版剧情正文",
        "第二版 <think>内部独白</think>剧情继续",
        "第三版剧情收尾",
    ]

    def test_switch_assistant_swipe_resyncs_memory(self, client, mem_env, test_user, monkeypatch):
        db = mem_env
        sess, msg = _seed_swiped_message(db, test_user, role="assistant",
                                         swipes=self.SWIPES, swipe_id=0)
        _seed_memory(db, test_user, sess.id, msg.id, content="第一版剧情正文")
        ev = _patch_embed_signal(monkeypatch)

        resp = client.patch(
            f"/api/character-sessions/{sess.id}/messages/{msg.id}/swipe",
            json={"swipe_id": 1},
        )

        assert resp.status_code == 200
        assert resp.json()["content"] == self.SWIPES[1]
        assert ev.wait(5), "切换后的后台重嵌未执行"
        rows = _mem_rows(db, sess.id, msg.id)
        assert len(rows) == 1
        row = rows[0]
        # assistant 内容经 clean_memory_content：<think> 块剥离
        assert row.content == clean_memory_content(self.SWIPES[1])
        assert "内部独白" not in row.content
        assert row.role == "assistant"
        assert row.branch_id == "br-sw" and row.message_id == msg.id

    def test_switch_user_message_stores_raw_text(self, client, mem_env, test_user, monkeypatch):
        db = mem_env
        swipes = ["用户的说法甲", "用户的说法乙"]
        sess, msg = _seed_swiped_message(db, test_user, role="user",
                                         swipes=swipes, swipe_id=0, branch_id="br-u")
        ev = _patch_embed_signal(monkeypatch)

        resp = client.patch(
            f"/api/character-sessions/{sess.id}/messages/{msg.id}/swipe",
            json={"swipe_id": 1},
        )

        assert resp.status_code == 200
        assert ev.wait(5)
        rows = _mem_rows(db, sess.id, msg.id)
        assert len(rows) == 1
        # user 消息原文入库，不做 clean_memory_content 清洗
        assert rows[0].content == "用户的说法乙"
        assert rows[0].branch_id == "br-u"

    def test_switch_same_swipe_zero_op(self, client, mem_env, test_user, monkeypatch):
        db = mem_env
        sess, msg = _seed_swiped_message(db, test_user, role="assistant",
                                         swipes=self.SWIPES, swipe_id=0)
        ev = _patch_embed_signal(monkeypatch)

        calls = {"n": 0}
        orig_store = MemoryService.store_memory

        def _counting_store(svc_self, *a, **k):
            calls["n"] += 1
            return orig_store(svc_self, *a, **k)

        monkeypatch.setattr(MemoryService, "store_memory", _counting_store)

        first = client.patch(
            f"/api/character-sessions/{sess.id}/messages/{msg.id}/swipe",
            json={"swipe_id": 1},
        )
        assert first.status_code == 200
        assert ev.wait(5), "首次切换应触发一次记忆写入"
        time.sleep(0.2)

        # 重复切到同一 swipe：content 未变 → 零操作（不再删除、不再写库）
        second = client.patch(
            f"/api/character-sessions/{sess.id}/messages/{msg.id}/swipe",
            json={"swipe_id": 1},
        )
        assert second.status_code == 200
        time.sleep(0.2)
        assert calls["n"] == 1, f"内容未变的重复切换不应再写记忆，实际 {calls['n']} 次"
        assert len(_mem_rows(db, sess.id, msg.id)) == 1

    def test_switch_with_service_disabled_no_crash_no_rows(self, client, mem_env, test_user, monkeypatch):
        db = mem_env
        sess, msg = _seed_swiped_message(db, test_user, role="assistant",
                                         swipes=self.SWIPES, swipe_id=0)
        # 注意：memory_config 是实例，is_enabled() 是读类属性的 classmethod，
        # 必须在类上打补丁才能影响后台线程内的可用性判断。
        monkeypatch.setattr(type(memory_config), "ENABLED", False)

        resp = client.patch(
            f"/api/character-sessions/{sess.id}/messages/{msg.id}/swipe",
            json={"swipe_id": 2},
        )

        assert resp.status_code == 200
        assert resp.json()["content"] == self.SWIPES[2]
        time.sleep(0.2)
        assert _mem_rows(db, sess.id, msg.id) == []

    def test_source_contract_tag_present(self):
        """源码契约：switch_message_swipe 含 [MEM-SYNC-ON-SWITCH] 同步钩子。"""
        src_path = os.path.join(_BACKEND_DIR, "app", "api", "character_ext.py")
        src = open(src_path, encoding="utf-8").read()
        assert "[MEM-SYNC-ON-SWITCH]" in src, "character_ext.py 缺少 swipe 切换钩子标签"
        idx = src.find("async def switch_message_swipe(")
        assert idx != -1, "switch_message_swipe 函数未找到"
        body = src[idx:]
        assert "delete_by_message_id" in body, "切换钩子应先删旧记忆行"
        assert "store_memory" in body, "切换钩子应按新文本 upsert 记忆"


# ─────────────────────────────────────────────────────────────────────
# C2 N-13 契约：4xx 不再直传 str(e)
# ─────────────────────────────────────────────────────────────────────

class TestNoUnmasked4xxDetail:
    ALLOWLIST = {"openai_compat.py", "silly_tavern.py"}

    def test_api_layer_has_no_raw_4xx_str_detail_outside_allowlist(self):
        api_dir = Path(_BACKEND_DIR) / "app" / "api"
        pattern = re.compile(r"status_code=4\d\d,\s*\n?\s*detail=str\(")
        offenders = []
        for py in sorted(api_dir.glob("*.py")):
            if py.name in self.ALLOWLIST:
                continue
            if pattern.search(py.read_text(encoding="utf-8")):
                offenders.append(py.name)
        assert offenders == [], f"以下文件仍有未脱敏的 4xx detail=str(): {offenders}"


# ─────────────────────────────────────────────────────────────────────
# C3 N-15 日志脱敏 sk-/pk-
# ─────────────────────────────────────────────────────────────────────

class TestLogSanitizerSkPkPatterns:
    def test_sk_key_redacted(self):
        out = sanitize_message("request failed with key sk-abc123DEF456ghi789 please retry")
        assert "sk-abc123DEF456ghi789" not in out
        assert "[REDACTED_API_KEY]" in out

    def test_pk_key_redacted(self):
        out = sanitize_message("token pk-ZZZZ9999yyyy8888 embedded")
        assert "pk-ZZZZ9999yyyy8888" not in out
        assert "[REDACTED_API_KEY]" in out

    def test_short_prefix_not_redacted(self):
        # 少于 16 位字母数字的短串不属于密钥形态，保持原样
        text_val = "id sk-short123 ok"
        assert sanitize_message(text_val) == text_val

    def test_plain_words_unaffected(self):
        text_val = "the task needs a pk check and a sk check"
        assert sanitize_message(text_val) == text_val

    def test_existing_patterns_still_work(self):
        out = sanitize_message("Bearer abc.def.ghi password=hunter2")
        assert "hunter2" not in out
        assert "password=[REDACTED]" in out


# ─────────────────────────────────────────────────────────────────────
# C4 N-16 本地模型上传上限
# ─────────────────────────────────────────────────────────────────────

class TestLocalModelUploadLimit:
    @pytest.fixture()
    def limited_models_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "DATA_DIR", str(tmp_path))
        monkeypatch.setattr(settings, "LOCAL_MODEL_UPLOAD_MAX_FILE_SIZE_MB", 1)
        return tmp_path

    @staticmethod
    def _upload_file(data: bytes) -> SimpleNamespace:
        return SimpleNamespace(filename="model.gguf", file=io.BytesIO(data))

    def test_over_limit_rejected_413_and_no_partial_file(self, limited_models_dir):
        data = b"x" * (1536 * 1024)  # 1.5MB > 1MB 上限
        with pytest.raises(Exception) as ei:
            upload_local_model(self._upload_file(data))
        assert getattr(ei.value, "status_code", None) == 413
        models_dir = limited_models_dir / "models"
        leftovers = list(models_dir.glob("*.gguf")) if models_dir.exists() else []
        assert leftovers == [], "超限后不应残留半成品文件"

    def test_under_limit_saves_registry_entry(self, limited_models_dir):
        data = b"y" * (512 * 1024)  # 0.5MB < 1MB 上限
        result = upload_local_model(self._upload_file(data))
        entry = result["model"]
        assert entry["size_bytes"] == len(data)
        assert os.path.exists(entry["path"])


# ─────────────────────────────────────────────────────────────────────
# C6 N-18 prod 弱管理员密码启动阻断
# ─────────────────────────────────────────────────────────────────────

class TestProdWeakAdminPasswordBlocked:
    def _settings_kwargs(self, **overrides):
        kwargs = dict(
            APP_ENV="production",
            SECRET_KEY="s" * 32,
            ADMIN_PASSWORD="St9StrongPassw0rd",
            CORS_ORIGINS="https://app.example.com",
        )
        kwargs.update(overrides)
        return kwargs

    def test_production_admin123_raises(self):
        with pytest.raises(RuntimeError, match="admin123"):
            Settings(**self._settings_kwargs(ADMIN_PASSWORD="admin123"))

    def test_production_strong_password_ok(self):
        s = Settings(**self._settings_kwargs())
        assert s.ADMIN_PASSWORD == "St9StrongPassw0rd"

    def test_development_admin123_warns_only(self, caplog):
        import logging
        with caplog.at_level(logging.WARNING):
            s = Settings(APP_ENV="development", ADMIN_PASSWORD="admin123")
        assert s.APP_ENV == "development"
        assert any("[SECURITY] ADMIN_PASSWORD is set to the default value 'admin123'"
                   in r.getMessage() for r in caplog.records)


# ─────────────────────────────────────────────────────────────────────
# C5 N-17 无 limit 查询限幅
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture()
def admin_client(db_session, test_user):
    """TestClient：get_db 注入测试会话，get_current_user/get_admin 注入管理员。"""
    from fastapi.testclient import TestClient

    import app.api.dependencies as deps
    from app.core.database import get_db
    from app.main import app

    admin = test_user
    admin.role = "admin"
    db_session.add(admin)
    db_session.commit()

    def _override_get_db():
        yield db_session

    async def _override_user():
        return admin

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[deps.get_current_user] = _override_user
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(deps.get_current_user, None)
        app.dependency_overrides.pop(deps.get_admin, None)
        admin.role = "user"


class TestAdminSessionMessagesLimit:
    def test_limit_param_caps_results(self, admin_client, db_session, test_user):
        sess = ChatSession(id=f"sess-cap-{test_user.id}", user_id=test_user.id, title="t")
        db_session.add(sess)
        db_session.flush()
        for i in range(12):
            db_session.add(ChatMessage(
                session_id=sess.id, role="user", content=f"m{i}", model="test",
            ))
        db_session.commit()

        default = admin_client.get(f"/api/admin/sessions/{sess.id}/messages")
        assert default.status_code == 200
        assert len(default.json()) == 12

        capped = admin_client.get(f"/api/admin/sessions/{sess.id}/messages", params={"limit": 5})
        assert capped.status_code == 200
        assert len(capped.json()) == 5

        paged = admin_client.get(
            f"/api/admin/sessions/{sess.id}/messages",
            params={"limit": 5, "offset": 5},
        )
        assert paged.status_code == 200
        assert [m["content"] for m in paged.json()] == [f"m{i}" for i in range(5, 10)]

    def test_limit_out_of_range_rejected(self, admin_client, db_session, test_user):
        sess = ChatSession(id=f"sess-range-{test_user.id}", user_id=test_user.id, title="t2")
        db_session.add(sess)
        db_session.commit()
        resp = admin_client.get(
            f"/api/admin/sessions/{sess.id}/messages", params={"limit": 99999},
        )
        assert resp.status_code == 422


class TestPlotlineListLimit:
    def test_limit_param_caps_results(self, admin_client, db_session, test_user):
        for i in range(3):
            db_session.add(PlotLine(
                id=f"pl-{i}", user_id=test_user.id, name=f"线{i}",
            ))
        db_session.commit()

        resp = admin_client.get("/api/plotlines", params={"limit": 2})
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    def test_limit_must_be_positive(self, admin_client):
        resp = admin_client.get("/api/plotlines", params={"limit": 0})
        assert resp.status_code == 422
