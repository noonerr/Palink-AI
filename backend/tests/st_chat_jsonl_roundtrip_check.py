"""ST chat JSONL round-trip field-fidelity verifier (Phase 2).

Imports a realistic ST 1.18.0 chat JSONL (header + user + AI message) via
import_jsonl_to_session, re-exports it via export_session_to_jsonl, and diffs
the per-message fields to detect any dropped/altered data.

All rows created for the test are deleted at the end (no DB pollution).

Run inside backend container:
  docker exec palink-ai-backend-1 python /app/tests/st_chat_jsonl_roundtrip_check.py
"""
import json
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app")

from app.core.database import SessionLocal  # noqa: E402
from app.models.character import (  # noqa: E402
    Character,
    CharacterChatMessage,
    CharacterChatSession,
    CharacterChatSessionBranch,
)
from app.models.user import User  # noqa: E402
from app.services.st_sync_service import (  # noqa: E402
    export_session_to_jsonl,
    import_jsonl_to_session,
)

# A realistic ST 1.18.0 chat: header line + user msg + AI msg with the full
# set of top-level fields ST persists (see script.js:5818, 6720-6767).
header = {
    "user_name": "Tester",
    "character_name": "STCompatChar",
    "create_date": "2024-6-20@15h45m30s123ms",
    "chat_metadata": {"note_prompt": "hi", "variables": {"foo": "bar"}},
}
user_msg = {
    "name": "Tester",
    "is_user": True,
    "is_system": False,
    "send_date": "2024-06-20T15:45:30.123Z",
    "mes": "Hello there.",
    "extra": {"isSmallSys": False, "token_count": 3},
}
ai_msg = {
    "name": "STCompatChar",
    "is_user": False,
    "is_system": False,
    "send_date": "2024-06-20T15:45:40.456Z",
    "gen_started": "2024-06-20T15:45:38.000Z",
    "gen_finished": "2024-06-20T15:45:40.456Z",
    "mes": "General Kenobi!",
    "force_avatar": "/thumbnail?type=avatar&file=x.png",
    "extra": {
        "token_count": 5,
        "model": "palink-default",
        "api": "openai",
        "reasoning": "thinking...",
        "reasoning_duration": 1200,
    },
    "swipe_id": 1,
    "swipes": ["First swipe.", "General Kenobi!"],
    "swipe_info": [
        {"send_date": "2024-06-20T15:45:39.000Z", "gen_started": "2024-06-20T15:45:38.000Z",
         "gen_finished": "2024-06-20T15:45:39.000Z", "extra": {"token_count": 4}},
        {"send_date": "2024-06-20T15:45:40.456Z", "gen_started": "2024-06-20T15:45:38.000Z",
         "gen_finished": "2024-06-20T15:45:40.456Z", "extra": {"token_count": 5}},
    ],
}
jsonl_in = "\n".join(json.dumps(x, ensure_ascii=False) for x in (header, user_msg, ai_msg)) + "\n"

# Fields whose loss on round-trip we consider a fidelity defect.
TOP_LEVEL_CHECK = ["name", "is_user", "is_system", "send_date", "mes",
                   "gen_started", "gen_finished", "force_avatar",
                   "swipe_id", "swipes"]
EXTRA_CHECK = ["token_count", "model", "api", "reasoning", "reasoning_duration"]

db = SessionLocal()
created_char_id = None
created_session_id = None
findings = []
try:
    owner = db.query(User).first()
    if owner is None:
        print("SKIP: no user in DB")
        sys.exit(0)

    created_char_id = "char-sttest-" + uuid.uuid4().hex[:8]
    db.add(Character(id=created_char_id, user_id=owner.id, name="STCompatChar",
                     created_at=datetime.now(timezone.utc)))
    db.commit()

    created_session_id = import_jsonl_to_session(db, created_char_id, jsonl_in, owner.id)
    jsonl_out = export_session_to_jsonl(db, created_session_id)

    out_lines = [json.loads(l) for l in jsonl_out.splitlines() if l.strip()]
    out_msgs = [m for m in out_lines if "mes" in m]
    if len(out_msgs) != 2:
        findings.append(("message count", f"expected 2 got {len(out_msgs)}"))
    else:
        out_ai = out_msgs[1]
        for k in TOP_LEVEL_CHECK:
            want = ai_msg.get(k)
            got = out_ai.get(k)
            if want is not None and got != want:
                findings.append((f"top:{k}", f"want {want!r} got {got!r}"))
        out_extra = out_ai.get("extra", {}) if isinstance(out_ai.get("extra"), dict) else {}
        for k in EXTRA_CHECK:
            want = ai_msg["extra"].get(k)
            got = out_extra.get(k)
            if want is not None and got != want:
                findings.append((f"extra:{k}", f"want {want!r} got {got!r}"))
        # swipe_info internal gen_started fidelity
        out_si = out_ai.get("swipe_info") or out_extra.get("swipe_info")
        if not (isinstance(out_si, list) and len(out_si) == 2
                and out_si[0].get("gen_started") == "2024-06-20T15:45:38.000Z"):
            findings.append(("swipe_info.gen_started", f"got {out_si!r}"))

    print("=== ST chat JSONL round-trip fidelity ===")
    print("exported AI message keys:", sorted(out_msgs[1].keys()) if len(out_msgs) == 2 else "N/A")
    print("FINDINGS (dropped/wrong):", findings or "none")
    print("RESULT:", "PASS" if not findings else "FAIL")
finally:
    # Clean up everything created (explicit order to satisfy FKs).
    if created_session_id:
        db.query(CharacterChatMessage).filter(
            CharacterChatMessage.session_id == created_session_id).delete(synchronize_session=False)
        db.query(CharacterChatSessionBranch).filter(
            CharacterChatSessionBranch.session_id == created_session_id).delete(synchronize_session=False)
        db.query(CharacterChatSession).filter(
            CharacterChatSession.id == created_session_id).delete(synchronize_session=False)
    if created_char_id:
        db.query(Character).filter(Character.id == created_char_id).delete(synchronize_session=False)
    db.commit()
    db.close()

sys.exit(0 if not findings else 1)
