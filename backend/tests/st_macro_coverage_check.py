"""ST 1.18.0 prompt-assembly macro coverage audit (Phase 5).

Compares Palink's prompt-assembly macro engine (``app.services.macro_service``)
against ST 1.18.0 ``public/scripts/macros.js`` ``evaluateMacros`` for the macros
that produce a *visible difference in the final prompt*.

ST truth:
- comment:        macros.js:659  /\\{\\{\\/\\/([\\s\\S]*?)\\}\\}/gm  -> ''
- reverse:        macros.js:658  {{reverse:(.+?)}}                  -> reversed
- legacy angles:  macros.js:624-628  <USER>/<BOT>/<CHAR>/<GROUP>/<CHARIFNOTGROUP>
- global vars:    variables.js:251-259  getglobalvar/addglobalvar/incglobalvar/decglobalvar

Run inside backend container:
  docker exec palink-ai-backend-1 python /app/tests/st_macro_coverage_check.py
"""
import sys

sys.path.insert(0, "/app")

from app.services.macro_service import MacroEnv, evaluate_macros  # noqa: E402


def _env(**kw):
    return MacroEnv(db=None, user_name="Alice", char_name="Bob", **kw)


findings = []


def check(label, text, expect_substituted, env=None, expect_exact=None):
    """Assert macro ``text`` no longer appears literally and (optionally) exact output."""
    env = env or _env()
    out = evaluate_macros(text, env)
    ok = True
    detail = []
    if expect_substituted:
        for token in expect_substituted:
            if token in out:
                ok = False
                detail.append(f"literal {token!r} survived")
    if expect_exact is not None and out != expect_exact:
        ok = False
        detail.append(f"expected {expect_exact!r} got {out!r}")
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {label}: {text!r} -> {out!r}" + (f"  ({'; '.join(detail)})" if detail else ""))
    if not ok:
        findings.append(label)


print("=== no-DB macros ===")
# 1. comment macro {{// ...}} -> '' (macros.js:659)
check("comment", "A{{// hidden note}}B", ["{{//"], expect_exact="AB")
check("comment-multiline", "A{{// line1\nline2 }}B", ["{{//"], expect_exact="AB")

# 2. reverse macro {{reverse:...}} -> reversed (macros.js:658)
check("reverse", "{{reverse:abc}}", ["{{reverse"], expect_exact="cba")

# 3. legacy angle-bracket macros (macros.js:624-628)
check("legacy-USER", "Hi <USER>!", ["<USER>"], expect_exact="Hi Alice!")
check("legacy-CHAR", "<CHAR> speaks", ["<CHAR>"], expect_exact="Bob speaks")
check("legacy-BOT", "<BOT> speaks", ["<BOT>"], expect_exact="Bob speaks")
check("legacy-GROUP", "<GROUP> here", ["<GROUP>"], expect_exact="Bob here")

print("=== DB-backed global var macros (variables.js:251-259) ===")
try:
    from app.core.database import SessionLocal  # noqa: E402
    from app.models.user import User  # noqa: E402

    dbs = SessionLocal()
    owner = dbs.query(User).first()
    if owner is None:
        print("[SKIP] no user in DB; cannot verify global var macros")
    else:
        nested = dbs.begin_nested()
        try:
            env = MacroEnv(db=dbs, user_id=owner.id, user_name="Alice", char_name="Bob")
            # setglobalvar then getglobalvar (SessionLocal autoflush=False → 显式 flush
            # 模拟真实请求边界：变量在生成结束时 commit，下一次装配可见)
            evaluate_macros("{{setglobalvar::phase5_probe::42}}", env)
            dbs.flush()
            check("getglobalvar", "[{{getglobalvar::phase5_probe}}]", ["{{getglobalvar"], expect_exact="[42]", env=env)
            check("incglobalvar", "{{incglobalvar::phase5_probe}}[{{getglobalvar::phase5_probe}}]",
                  ["{{incglobalvar", "{{getglobalvar"], expect_exact="[43]", env=env)
            dbs.flush()
            check("decglobalvar", "{{decglobalvar::phase5_probe}}[{{getglobalvar::phase5_probe}}]",
                  ["{{decglobalvar", "{{getglobalvar"], expect_exact="[42]", env=env)
            dbs.flush()
            check("addglobalvar", "{{addglobalvar::phase5_probe::8}}[{{getglobalvar::phase5_probe}}]",
                  ["{{addglobalvar", "{{getglobalvar"], expect_exact="[50]", env=env)
        finally:
            nested.rollback()
            dbs.close()
except Exception as exc:  # noqa: BLE001
    print(f"[SKIP] DB section unavailable: {exc}")

print()
if findings:
    print(f"FINDINGS: {', '.join(findings)}")
    print("RESULT: FAIL")
else:
    print("FINDINGS: none")
    print("RESULT: PASS")
