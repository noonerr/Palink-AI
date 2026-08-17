"""ST worldinfo round-trip field-fidelity verifier (Phase 3).

Confirms whether importing an ST worldinfo entry (flat format) and serializing it
back via _worldbook_to_st_world_info preserves every field ST persists.

Run inside backend container:
  docker exec palink-ai-backend-1 python /app/tests/st_worldinfo_roundtrip_check.py
"""
import sys
from datetime import datetime, timezone

sys.path.insert(0, "/app")

from app.api.silly_tavern import _create_stage_from_st_entry, _worldbook_to_st_world_info  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402

# An ST worldinfo entry with every meaningful non-default field set.
entry = {
    "uid": 0,
    "key": ["alpha", "beta"],
    "keysecondary": ["gamma"],
    "comment": "Test Entry",
    "content": "Some lore content.",
    "constant": True,
    "vectorized": True,
    "selective": True,
    "selectiveLogic": 1,
    "addMemo": True,
    "order": 42,
    "position": 2,
    "disable": False,
    "ignoreBudget": True,
    "excludeRecursion": True,
    "preventRecursion": True,
    "matchPersonaDescription": True,
    "matchCharacterDescription": True,
    "matchCharacterPersonality": True,
    "matchCharacterDepthPrompt": True,
    "matchScenario": True,
    "matchCreatorNotes": True,
    "delayUntilRecursion": 3,
    "probability": 75,
    "useProbability": True,
    "depth": 7,
    "outletName": "myoutlet",
    "group": "grpA",
    "groupOverride": True,
    "groupWeight": 200,
    "scanDepth": 5,
    "caseSensitive": True,
    "matchWholeWords": True,
    "useGroupScoring": True,
    "automationId": "auto-123",
    "role": 2,
    "sticky": 4,
    "cooldown": 6,
    "delay": 8,
    "triggers": ["normal"],
}

now = datetime.now(timezone.utc)
stage = _create_stage_from_st_entry("wb-test", entry, 0, now)

wb = WorldBook(id="wb-test", name="RoundTripWB", description="")
wb.entries = [stage]

out = _worldbook_to_st_world_info(wb, db=None)
out_entry = out["entries"]["0"]

# Fields ST persists at top level (from newWorldInfoEntryDefinition), value-compared.
expected = {
    "key": entry["key"],
    "keysecondary": entry["keysecondary"],
    "comment": entry["comment"],
    "content": entry["content"],
    "constant": True,
    "vectorized": True,
    "selective": True,
    "selectiveLogic": 1,
    "addMemo": True,
    "order": 42,
    "position": 2,
    "disable": False,
    "ignoreBudget": True,
    "excludeRecursion": True,
    "preventRecursion": True,
    "matchPersonaDescription": True,
    "matchCharacterDescription": True,
    "matchCharacterPersonality": True,
    "matchCharacterDepthPrompt": True,
    "matchScenario": True,
    "matchCreatorNotes": True,
    "delayUntilRecursion": 3,
    "probability": 75,
    "useProbability": True,
    "depth": 7,
    "outletName": "myoutlet",
    "group": "grpA",
    "groupOverride": True,
    "groupWeight": 200,
    "scanDepth": 5,
    "caseSensitive": True,
    "matchWholeWords": True,
    "useGroupScoring": True,
    "automationId": "auto-123",
    "role": 2,
    "sticky": 4,
    "cooldown": 6,
    "delay": 8,
    "triggers": ["normal"],
}

missing = []
wrong = []
for k, v in expected.items():
    if k not in out_entry:
        missing.append(k)
    elif out_entry[k] != v:
        wrong.append((k, v, out_entry.get(k)))

print("=== ST worldinfo round-trip fidelity ===")
print("emitted keys:", sorted(out_entry.keys()))
print()
print("MISSING (dropped on export):", missing)
print("WRONG VALUE:", wrong)
print()
print("RESULT:", "PASS" if not missing and not wrong else "FAIL")

# --- V3 character_book export path (_worldbook_to_charbook) ---
from app.api.silly_tavern import _worldbook_to_charbook  # noqa: E402

cb = _worldbook_to_charbook(wb)
cb_entry = cb["entries"][0]
cb_ext = cb_entry.get("extensions", {})
cb_missing = []
for k, expected_v in (("role", 2), ("use_group_scoring", True), ("automation_id", "auto-123")):
    if k not in cb_ext:
        cb_missing.append((k, "MISSING"))
    elif cb_ext[k] != expected_v:
        cb_missing.append((k, f"got {cb_ext[k]!r} want {expected_v!r}"))

print()
print("=== V3 character_book export (extensions) ===")
print("role/use_group_scoring/automation_id issues:", cb_missing or "none")
cb_ok = not cb_missing
print("CHARBOOK RESULT:", "PASS" if cb_ok else "FAIL")

# --- DB-backed persistence round-trip (real PostgreSQL columns) ---
# Proves role/use_group_scoring/automation_id survive a physical INSERT + re-read
# through the world_book_stages table (migration 0053). Runs inside a savepoint
# that is rolled back, so no data is persisted.
import uuid as _uuid  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.user import User  # noqa: E402

db_issues = []
db_result = "SKIP (no user in DB)"
session = SessionLocal()
try:
    owner = session.query(User).first()
    if owner is not None:
        wb_id = "wb-sttest-" + _uuid.uuid4().hex[:8]
        wb_row = WorldBook(
            id=wb_id,
            user_id=owner.id,
            character_id=None,
            name="STCompatRoundTrip-" + wb_id,
            description="",
            type="world_book",
            format="silly_tavern_v2",
        )
        session.add(wb_row)
        session.add(_create_stage_from_st_entry(wb_id, entry, 0, now))
        session.flush()
        # Drop ORM identity-map cache so the re-query reads column values from PG.
        session.expire_all()
        reloaded = session.query(WorldBook).filter(WorldBook.id == wb_id).first()
        db_out = _worldbook_to_st_world_info(reloaded, db=session)["entries"]["0"]
        for k in ("role", "useGroupScoring", "automationId", "ignoreBudget",
                  "matchScenario", "delayUntilRecursion", "outletName", "triggers"):
            if db_out.get(k) != expected[k]:
                db_issues.append((k, f"got {db_out.get(k)!r} want {expected[k]!r}"))
        db_result = "PASS" if not db_issues else "FAIL"
finally:
    session.rollback()
    session.close()

print()
print("=== DB persistence round-trip (world_book_stages) ===")
print("issues:", db_issues or "none")
print("DB RESULT:", db_result)
db_ok = db_result.startswith("PASS") or db_result.startswith("SKIP")

sys.exit(0 if (not missing and not wrong and cb_ok and db_ok) else 1)
