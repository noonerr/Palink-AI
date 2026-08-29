# -*- coding: utf-8 -*-
"""批次 D/F 反向运行时验证 v2（临时数据 + finally 清理）。"""
import io
import json
import sys
import uuid
import zipfile
from datetime import datetime, timedelta

sys.path.insert(0, "/app")

TAG = "fvcheck_" + uuid.uuid4().hex[:8]
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append((name, detail))
    print(("PASS" if cond else "FAIL"), name, ("| " + str(detail)[:140] if detail and not cond else ""))


from app.core.database import SessionLocal  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.character import (  # noqa: E402
    Character,
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
)
from app.models.group_chat import GroupChat  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402

db = SessionLocal()
_cleanup_ids = {"chars": [], "sessions": [], "groups": [], "wbs": [], "users": [], "mem_sessions": []}
try:
    user = User(username=TAG, hashed_password="x", role="user")
    db.add(user)
    db.flush()
    _cleanup_ids["users"].append(user.id)

    char = Character(user_id=user.id, name="VerifyChar", description="verify-desc",
                     first_mes="{{user}} 你好")
    db.add(char)
    db.flush()
    member = Character(user_id=user.id, name="VerifyMember", description="member-desc")
    db.add(member)
    db.flush()
    _cleanup_ids["chars"] = [char.id, member.id]

    session = CharacterChatSession(character_id=char.id, user_id=user.id)
    db.add(session)
    db.flush()
    _cleanup_ids["sessions"].append(session.id)

    def add_msg(content, role="assistant", is_user=False, is_locked=False, is_hidden=False):
        m = CharacterChatMessage(session_id=session.id, role=role, content=content,
                                 is_user=is_user, is_system=False,
                                 is_locked=is_locked, is_hidden=is_hidden)
        db.add(m)
        db.flush()
        return m

    m1 = add_msg("one")
    m2 = add_msg("two", is_locked=True)
    m3 = add_msg("three")
    m4 = add_msg("A")
    m4.swipes = json.dumps(["A", "B", "C"], ensure_ascii=False)
    m4.swipe_id = 2
    db.commit()

    group = GroupChat(user_id=user.id, name="VerifyG",
                      member_ids=json.dumps([str(member.id)]), disabled_members="[]")
    db.add(group)
    db.flush()
    _cleanup_ids["groups"].append(group.id)

    wb = WorldBook(name="VerifyWB", character_id=char.id, user_id=user.id, type="character_book")
    db.add(wb)
    db.flush()
    _cleanup_ids["wbs"].append(wb.id)
    db.add(WorldBookStage(world_book_id=wb.id, stage_index=0, title="g-text",
                          content="VERIFY-WB-TEXT-MARK", keys=json.dumps(["garden"]),
                          constant=True, enabled=True, position=0))
    db.add(WorldBookStage(world_book_id=wb.id, stage_index=1, title="g-depth",
                          content="VERIFY-WB-DEPTH-MARK", keys=json.dumps(["garden"]),
                          constant=True, enabled=True, position=4))
    db.flush()
    db.commit()

    from app.services.slash_command_service import (  # noqa: E402
        SlashCommandContext,
        SlashCommandRegistry,
        execute_slash_command,
    )

    ctx = SlashCommandContext(db=db, session_id=session.id, user_id=user.id,
                              user_name="Verifier", character=char, session=session,
                              input_text="")

    # ---------- 1. 斜杠命令 ----------
    check("registry-10-commands", all(n in SlashCommandRegistry.list_commands() for n in
          ("genraw", "del", "cut", "delswipe", "hide", "unhide", "listvar", "if", "inject", "flushinject")))

    r = execute_slash_command("/genraw raw prompt here", ctx)
    check("genraw-sets-gen-prompt", r.gen_prompt == "raw prompt here" and not r.send_to_chat)

    # delswipe（m4 最新，先测）
    r = execute_slash_command("/delswipe", ctx)
    db.refresh(m4)
    sw = json.loads(m4.swipes)
    check("delswipe-last", sw == ["A", "B"] and m4.swipe_id == 1 and m4.content == "B",
          f"sw={sw} id={m4.swipe_id}")

    # hide / unhide（缺省 = 最后一条 = m4）
    r = execute_slash_command("/hide", ctx)
    db.refresh(m4)
    check("hide-default-last", m4.is_hidden is True)
    r = execute_slash_command("/unhide", ctx)
    db.refresh(m4)
    check("unhide", m4.is_hidden is False)

    # listvar / if
    execute_slash_command("/setvar gold 42", ctx)
    r = execute_slash_command("/listvar", ctx)
    check("listvar", json.loads(r.response or "{}").get("gold") == "42", r.response)
    execute_slash_command("/setvar flag 1", ctx)
    r = execute_slash_command("/if {{getvar::flag}} then /getvar flag", ctx)
    check("if-true", "flag=1" in (r.response or ""), r.response)
    r = execute_slash_command("/if {{getvar::missingvar}} then /getvar missingvar", ctx)
    check("if-false-skip", "skipped" in (r.response or ""), r.response)

    # inject / flushinject
    r = execute_slash_command("/inject hello world", ctx)
    r = execute_slash_command("/inject position=2 depth=1 status", ctx)
    db.refresh(session)
    meta = json.loads(session.chat_metadata)
    inj = meta.get("palink_injections", [])
    check("inject-storage", len(inj) == 2 and inj[0]["position"] == 0 and inj[1]["depth"] == 1, json.dumps(inj))
    r = execute_slash_command("/flushinject", ctx)
    db.refresh(session)
    check("flushinject", "palink_injections" not in json.loads(session.chat_metadata), r.response)

    # /del 1 → 删除最新（m4）；m4 的记忆镜像应级联清理
    # （生产语义：镜像行 session_id = 聊天会话 id）
    mem_sess = "fvcheck-mem-" + uuid.uuid4().hex[:8]
    _cleanup_ids["mem_sessions"].append(mem_sess)
    import sqlalchemy as _sa
    db.execute(_sa.text(
        "INSERT INTO conversation_memories (user_id, session_id, role, content, tokens_count, message_id) "
        "VALUES (:u, :s, 'assistant', 'mirror-of-m4', 10, :m)"),
        {"u": user.id, "s": session.id, "m": m4.id})
    db.commit()
    r = execute_slash_command("/del 1", ctx)
    cnt = db.execute(_sa.text(
        "SELECT COUNT(*) FROM conversation_memories WHERE session_id=:s AND message_id=:m"),
        {"s": session.id, "m": m4.id}).scalar()
    check("del-memory-cascade", cnt == 0 and r.modified, f"residual={cnt} resp={r.response}")

    # /del 2 → 最新两条：m3 删、m2 锁定跳过
    r = execute_slash_command("/del 2", ctx)
    ids_left = {m.id for m in db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session.id).all()}
    check("del-2-skips-locked", r.modified and m3.id not in ids_left and m2.id in ids_left and m1.id in ids_left,
          f"resp={r.response} left={sorted(ids_left)}")

    # /cut 0-0 → 删首条 m1
    r = execute_slash_command("/cut 0-0", ctx)
    ids_left = {m.id for m in db.query(CharacterChatMessage).filter(
        CharacterChatMessage.session_id == session.id).all()}
    check("cut-range", m1.id not in ids_left and m2.id in ids_left, f"resp={r.response}")

    # ---------- 2. 群聊世界书（D-1） ----------
    from types import SimpleNamespace  # noqa: E402
    from app.services.roleplay_prompt_assembly import _append_worldbook_context  # noqa: E402

    class StubDeps:
        def apply_plugin_regex_scripts(self, t, *a, **k):
            return t

        def apply_regex_scripts(self, t, *a, **k):
            return t

        def replace_placeholders(self, t, *a, **k):
            return t

    req = SimpleNamespace(db=db, user=user, char=char, session_id=session.id, branch_id=None,
                          is_init=False, message="hello garden", smart_card_trigger=False,
                          is_continue=False, group_id=group.id, user_nickname="Verifier")
    parts, depth_entries, report = [], [], []
    try:
        _append_worldbook_context(req, StubDeps(), parts, depth_entries, report,
                                  char_name=char.name, group_chat=group, group_wi_strategy="all")
        ok = any("VERIFY-WB-TEXT-MARK" in p for p in parts) and \
            any("VERIFY-WB-DEPTH-MARK" in d.content for d in depth_entries) and \
            not any(i.status == "error" for i in report)
        check("group-worldbook-injection", ok,
              f"parts={len(parts)} depth={len(depth_entries)} errors={[i.detail for i in report if i.status=='error']}")
    except Exception as exc:
        check("group-worldbook-injection", False, f"EXCEPTION: {exc!r}")

    # ---------- 3. 记忆 exclude_recent（D-4） ----------
    from app.memory_module.models import ContextRequest  # noqa: E402
    from app.memory_module.retriever import MemoryRetriever  # noqa: E402
    base = datetime.utcnow()
    for i in range(1, 8):
        db.execute(_sa.text(
            "INSERT INTO conversation_memories (user_id, session_id, role, content, tokens_count, created_at, message_id) "
            "VALUES (:u, :s, 'assistant', :c, 10, :t, :m)"),
            {"u": user.id, "s": mem_sess, "c": f"mirror-{i}", "t": base + timedelta(seconds=i), "m": i})
    db.commit()
    from app.memory_module.storage import MemoryStorage  # noqa: E402
    storage = MemoryStorage(db)
    resp = MemoryRetriever(storage).retrieve(ContextRequest(
        user_id=user.id, query="mirror", session_id=mem_sess, max_tokens=2000,
        include_profile=False, memory_mode="rule", exclude_message_ids=[6, 7]))
    got = {m.message_id for m in resp.memories}
    check("memory-exclude-recent", got == {1, 2, 3, 4, 5}, f"got={got}")

    # ---------- 4. 宏（F7/F8） ----------
    from app.services.macro_service import MacroEnv, evaluate_macros  # noqa: E402
    env = MacroEnv(db=db, user_name="U", char_name="C", input_text="ORIG",
                   character=SimpleNamespace(first_mes="GREET", mes_example="RAWEX", character_version="2.5"))
    out = evaluate_macros("{{greeting}}|{{charVersion}}|{{mesExamplesRaw}}|{{original}}|{{idleDuration}}", env)
    check("f7-macros", out == "GREET|2.5|RAWEX|ORIG|", out)

    # ---------- 5. /wi 两条路径 ----------
    # 5a. 已有书追加（VerifyWB 存在 → 追加成功即证明 title→name 未回归）
    r = execute_slash_command("/wi 新关键词 新内容", ctx)
    check("wi-append-existing", "Command error" not in (r.response or ""), r.response)
    # 5b. 无书角色 → 建新书（title→name 修复的直达路径）
    char3 = Character(user_id=user.id, name="NoBookChar")
    db.add(char3)
    db.flush()
    _cleanup_ids["chars"].append(char3.id)
    ctx3 = SlashCommandContext(db=db, session_id=session.id, user_id=user.id,
                               user_name="Verifier", character=char3, session=session,
                               input_text="")
    r = execute_slash_command("/wi 关键词Z 内容Z", ctx3)
    wb3 = db.query(WorldBook).filter(WorldBook.character_id == char3.id,
                                     WorldBook.name.like("%'s World Book")).first()
    check("wi-create-book", wb3 is not None and "Command error" not in (r.response or ""), r.response)

    # ---------- 6. G1 导出方言（真实 WorldBook 行 → 数组 + V3 名） ----------
    from app.api.character_ext import _worldbook_to_charbook  # noqa: E402
    wb_full = db.query(WorldBook).filter(WorldBook.id == wb.id).first()
    out = _worldbook_to_charbook(wb_full)
    e0 = out["entries"][0]
    check("g1-export-dialect", isinstance(out["entries"], list) and
          all(k in e0 for k in ("keys", "secondary_keys", "insertion_order", "enabled", "extensions")),
          json.dumps(e0, ensure_ascii=False)[:150])

    # ---------- 7. F2 BYAF ZIP（真实容器运行） ----------
    from app.services.character_import_service import CharacterImportService  # noqa: E402
    svc = CharacterImportService(db)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps({
            "author": {"name": "A1"}, "characters": ["c.json"],
            "scenarios": ["s.json"]}))
        zf.writestr("c.json", json.dumps({"name": "Z", "persona": "Hi {character}"}))
        zf.writestr("s.json", json.dumps({"firstMessages": [{"text": "Yo {user}"}]}))
    data = svc._import_from_byaf(buf.getvalue())
    check("f2-byaf-zip", data["name"] == "Z" and "{{char}}" in data["description"]
          and data["first_mes"] == "Yo {{user}}", json.dumps(data, ensure_ascii=False)[:150])

finally:
    try:
        from sqlalchemy import text as _t
        for s in _cleanup_ids["mem_sessions"]:
            db.execute(_t("DELETE FROM conversation_memories WHERE session_id = :s"), {"s": s})
        db.commit()
    except Exception as e:
        print("cleanup-mem-err:", e)
    try:
        for s in _cleanup_ids["sessions"]:
            db.query(CharacterChatMessage).filter(CharacterChatMessage.session_id == s).delete(synchronize_session=False)
            db.query(CharacterChatSessionBranch).filter(CharacterChatSessionBranch.session_id == s).delete(synchronize_session=False)
            db.query(CharacterChatSession).filter(CharacterChatSession.id == s).delete(synchronize_session=False)
        for g in _cleanup_ids["groups"]:
            db.query(GroupChat).filter(GroupChat.id == g).delete(synchronize_session=False)
        for w in _cleanup_ids["wbs"]:
            db.query(WorldBookStage).filter(WorldBookStage.world_book_id == w).delete(synchronize_session=False)
            db.query(WorldBook).filter(WorldBook.id == w).delete(synchronize_session=False)
        for c in _cleanup_ids["chars"]:
            db.query(WorldBook).filter(WorldBook.character_id == c).delete(synchronize_session=False)
            db.query(Character).filter(Character.id == c).delete(synchronize_session=False)
        for u in _cleanup_ids["users"]:
            db.query(User).filter(User.id == u).delete(synchronize_session=False)
        db.commit()
        print("cleanup-done")
    except Exception as e:
        db.rollback()
        print("cleanup-err:", e)
    finally:
        db.close()

print(f"=== RESULT: {len(PASS)} passed, {len(FAIL)} failed ===")
for name, detail in FAIL:
    print("FAILED:", name, "|", detail)
sys.exit(1 if FAIL else 0)
