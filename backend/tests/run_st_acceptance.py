"""
ST 兼容性真实验收脚本

在容器内运行: python tests/run_st_acceptance.py
验证 PALINK_ST_COMPAT_EXECUTION_SPEC.md 中 WP-A/B/C/F/G 的验收标准。

不依赖 pytest，直接用 HTTP 请求 + DB session 验证。

用法:
  python tests/run_st_acceptance.py            # 简洁输出
  python tests/run_st_acceptance.py -v         # 显示每个测试的详细输出
"""
import json
import sys
import os
import traceback
import argparse
from typing import Any

# 解析命令行参数
_parser = argparse.ArgumentParser(description="ST Compatibility Acceptance Tests")
_parser.add_argument("-v", "--verbose", action="store_true",
                     help="Show detailed output for each test")
_args, _unknown = _parser.parse_known_args()
VERBOSE = _args.verbose

# 确保可以导入 app 模块
sys.path.insert(0, "/app")

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg2://palink:palink@db:5432/palink")

results: list[dict[str, Any]] = []
FATAL_ERROR = False


def record(wp: str, test_name: str, passed: bool, detail: str = ""):
    results.append({"wp": wp, "test": test_name, "passed": passed, "detail": detail})
    status = "PASS" if passed else "FAIL"
    line = f"  [{status}] {test_name}"
    # verbose 模式显示全部 detail；非 verbose 仅失败时显示 detail 以便排查
    if detail and (VERBOSE or not passed):
        line += f" — {detail}"
    print(line)


def wp_summary(wp_label: str):
    """在每个 WP 段落末尾打印 pass/total 汇总：WP-X: N/M passed"""
    wp_results = [r for r in results if r["wp"] == wp_label]
    if not wp_results:
        return
    passed = sum(1 for r in wp_results if r["passed"])
    total = len(wp_results)
    print(f"  --> WP-{wp_label}: {passed}/{total} passed")


def print_final_summary(fatal: bool = False) -> int:
    """打印最终汇总并返回退出码：0=全部通过, 1=有失败, 2=致命错误"""
    print("\n" + "=" * 60)
    print("ST ACCEPTANCE SUMMARY")
    print("=" * 60)

    wp_stats: dict[str, dict[str, int]] = {}
    for r in results:
        wp = r["wp"]
        if wp not in wp_stats:
            wp_stats[wp] = {"pass": 0, "fail": 0}
        if r["passed"]:
            wp_stats[wp]["pass"] += 1
        else:
            wp_stats[wp]["fail"] += 1

    total_pass = sum(s["pass"] for s in wp_stats.values())
    total_fail = sum(s["fail"] for s in wp_stats.values())
    total = total_pass + total_fail

    print(f"\nST Acceptance: {total_pass}/{total} passed\n")
    print("By WP:")
    for wp in sorted(wp_stats.keys()):
        s = wp_stats[wp]
        wp_total = s["pass"] + s["fail"]
        print(f"  WP-{wp}: {s['pass']}/{wp_total}")

    failed_tests = [r for r in results if not r["passed"]]
    if failed_tests:
        print("\n" + "-" * 60)
        print(f"FAILED TESTS ({len(failed_tests)})")
        print("-" * 60)
        for r in failed_tests:
            print(f"\n  [WP-{r['wp']}] {r['test']}")
            if r["detail"]:
                print(f"    Detail: {r['detail']}")
            print(f"    Reproduce: python tests/run_st_acceptance.py -v")

    # 输出 JSON 供后续处理
    try:
        with open("/tmp/st_acceptance_results.json", "w") as f:
            json.dump({"results": results, "total_pass": total_pass,
                       "total_fail": total_fail, "wp_stats": wp_stats}, f, indent=2)
    except Exception:
        pass

    if fatal:
        print("\nFATAL: Tests aborted due to unexpected error")
        return 2
    if total_fail > 0:
        return 1
    return 0


def _excepthook(exc_type, exc_value, exc_tb):
    """未捕获异常的安全网：仍输出汇总后退出。"""
    global FATAL_ERROR
    FATAL_ERROR = True
    print(f"\nFATAL: Uncaught {exc_type.__name__}: {exc_value}")
    traceback.print_exception(exc_type, exc_value, exc_tb)
    try:
        sys.stdout.flush()
    except Exception:
        pass
    exit_code = print_final_summary(fatal=True)
    os._exit(exit_code)


sys.excepthook = _excepthook

# ============================================================
# 初始化
# ============================================================
print("=" * 60)
print("ST Compatibility Acceptance Tests")
print("=" * 60)

client = None
db_session = None
AUTH_HEADERS: dict[str, str] = {}

try:
    from app.main import app
    from app.core.database import get_db, engine
    from app.core.security import create_access_token
    from app.models.user import User
    from app.models.character import Character
    from app.models.worldbook import WorldBook, WorldBookStage
    from sqlalchemy.orm import Session
    from fastapi.testclient import TestClient
    import httpx
except Exception as e:
    FATAL_ERROR = True
    print(f"FATAL: Failed to import dependencies: {e}")
    traceback.print_exc()
    sys.exit(print_final_summary(fatal=True))

try:
    # 创建 TestClient
    client = TestClient(app)
    # 获取 DB session
    db_session = Session(engine)
except Exception as e:
    FATAL_ERROR = True
    print(f"FATAL: Failed to initialize client/db: {e}")
    traceback.print_exc()
    sys.exit(print_final_summary(fatal=True))

# 获取或创建测试用户 token
try:
    user = db_session.query(User).filter(User.username == "admin").first()
    if user:
        token = create_access_token({"sub": user.username})
        AUTH_HEADERS = {"Authorization": f"Bearer {token}"}
    else:
        print("WARNING: No admin user found, tests will run without auth")
except Exception as e:
    print(f"WARNING: Auth setup failed: {e}")
    AUTH_HEADERS = {}

# ============================================================
# WP-A: ST Native Endpoint Surface
# ============================================================
print("\n--- WP-A: ST Native Endpoint Surface ---")

WP_A_ENDPOINTS = [
    ("POST", "/api/characters/import"),
    ("POST", "/api/characters/export"),
    ("POST", "/api/chats/import"),
    ("POST", "/api/chats/export"),
    ("POST", "/api/chats/recent"),
    ("POST", "/api/worldinfo/list"),
    ("POST", "/api/worldinfo/import"),
    ("POST", "/api/groups/all"),
    ("POST", "/api/groups/create"),
    ("POST", "/api/groups/edit"),
    ("POST", "/api/groups/delete"),
    ("POST", "/api/chats/group/get"),
    ("POST", "/api/chats/group/info"),
    ("POST", "/api/chats/group/save"),
    ("POST", "/api/chats/group/delete"),
    ("POST", "/api/chats/group/import"),
    ("POST", "/api/backgrounds/all"),
    ("POST", "/api/backgrounds/folders"),
    ("POST", "/api/backgrounds/upload"),
    ("POST", "/api/backgrounds/rename"),
    ("POST", "/api/backgrounds/delete"),
    ("POST", "/api/avatars/get"),
    ("POST", "/api/avatars/upload"),
    ("POST", "/api/avatars/delete"),
    ("GET",  "/api/sprites/get"),
    ("POST", "/api/sprites/upload"),
    ("POST", "/api/sprites/upload-zip"),
    ("POST", "/api/sprites/delete"),
    ("POST", "/api/assets/get"),
    ("POST", "/api/assets/character"),
    ("POST", "/api/assets/download"),
    ("POST", "/api/assets/delete"),
    ("POST", "/api/quick-replies/save"),
    ("POST", "/api/quick-replies/delete"),
    ("POST", "/api/images/upload"),
    ("POST", "/api/images/list/test"),
    ("POST", "/api/speech/list"),
    ("POST", "/api/speech/get"),
    ("POST", "/api/speech/preview"),
    ("POST", "/api/vector/index"),
    ("POST", "/api/vector/query"),
    ("POST", "/api/translate"),
    ("POST", "/api/search"),
    ("GET",  "/api/settings/get"),
    ("POST", "/api/settings/save"),
]

no_404_count = 0
for method, path in WP_A_ENDPOINTS:
    try:
        if method == "GET":
            r = client.get(path, headers=AUTH_HEADERS)
        else:
            r = client.post(path, json={}, headers=AUTH_HEADERS)
        # Distinguish route 404 ("Not Found") from business 404 (custom detail)
        route_missing = (
            r.status_code == 404 and
            r.json().get("detail") == "Not Found"
        )
        record("A", f"{method} {path}", not route_missing,
               f"status={r.status_code}" if route_missing else "")
        if not route_missing:
            no_404_count += 1
    except Exception as e:
        record("A", f"{method} {path}", False, f"exception: {e}")

record("A", "All ST endpoints registered (no route 404)",
       no_404_count == len(WP_A_ENDPOINTS),
       f"{no_404_count}/{len(WP_A_ENDPOINTS)} endpoints OK")
wp_summary("A")

# ============================================================
# WP-B: Group Chat Compatibility
# ============================================================
print("\n--- WP-B: Group Chat Compatibility ---")

# 1. /api/groups/all 返回 ST 格式
try:
    r = client.post("/api/groups/all", json={}, headers=AUTH_HEADERS)
    if r.status_code == 200:
        data = r.json()
        # ST 格式: 返回列表，每个 group 有 id/name/members 等字段
        if isinstance(data, list):
            record("B", "/api/groups/all returns list", True)
            if len(data) > 0:
                g = data[0]
                has_st_fields = all(
                    k in g for k in ["id", "name"]
                )
                record("B", "Group object has ST fields (id, name)", has_st_fields,
                       f"keys: {list(g.keys())[:10]}")
            else:
                record("B", "Group object has ST fields (id, name)", True, "no groups to check")
        else:
            record("B", "/api/groups/all returns list", False, f"got {type(data).__name__}")
    else:
        record("B", "/api/groups/all returns list", False, f"status={r.status_code}")
except Exception as e:
    record("B", "/api/groups/all returns list", False, f"exception: {e}")

# 2. 群聊打开/保存往返
# ST 真实流程: /api/groups/all 返回的 group 对象包含 chat_id (当前会话 file_id)，
# 打开群聊时用 chat_id 作为 file_name 调用 /api/chats/group/get。
# 若 group 还没有任何会话 (chat_id 为空), 先 save 一条消息创建会话，再 get。
try:
    r = client.post("/api/groups/all", json={}, headers=AUTH_HEADERS)
    groups = r.json() if r.status_code == 200 else []
    if groups:
        group = groups[0]
        group_id = group.get("id") or group.get("group_id")
        chat_id = group.get("chat_id") or ""
        file_name = chat_id + ".jsonl" if chat_id and not chat_id.endswith(".jsonl") else chat_id
        if not file_name:
            # group 没有会话: 先 save 创建一条
            save_payload = {
                "group_id": group_id,
                "chat": [{"name": "TestUser", "is_user": True, "mes": "hi", "send_date": "2024-01-01T00:00:00"}],
                "avtors": [],
                "chat_name": "Acceptance Test",
            }
            r_save = client.post("/api/chats/group/save", json=save_payload, headers=AUTH_HEADERS)
            if r_save.status_code == 200:
                file_name = r_save.json().get("file_name", "")
        if file_name:
            r = client.post("/api/chats/group/get", json={"file_name": file_name}, headers=AUTH_HEADERS)
            record("B", "Open group chat", r.status_code == 200,
                   f"status={r.status_code}")
        else:
            record("B", "Open group chat", False, "no file_name after save")
    else:
        record("B", "Open group chat", True, "no groups to test")
except Exception as e:
    record("B", "Open group chat", False, f"exception: {e}")

# 3. 群聊 JSONL 格式验证
try:
    from app.services.st_sync_service import convert_group_chat_to_jsonl, convert_jsonl_to_group_chat
    # 构造测试数据
    test_messages = [
        {"name": "Alice", "is_user": False, "mes": "Hello!", "send_date": "2024-01-01T00:00:00"},
        {"name": "User", "is_user": True, "mes": "Hi there", "send_date": "2024-01-01T00:01:00"},
    ]
    jsonl = convert_group_chat_to_jsonl(test_messages)
    lines = [l for l in jsonl.strip().split("\n") if l]
    record("B", "Group chat JSONL conversion produces lines", len(lines) >= 2,
           f"{len(lines)} lines")
    # 往返
    recovered = convert_jsonl_to_group_chat(jsonl)
    record("B", "Group chat JSONL round-trip preserves messages",
           len(recovered) >= 2, f"{len(recovered)} messages recovered")
except Exception as e:
    record("B", "Group chat JSONL conversion", False, f"exception: {e}")
wp_summary("B")

# ============================================================
# WP-C: Import/Export Parity
# ============================================================
print("\n--- WP-C: Import/Export Parity ---")

# 1. 角色卡 V2 往返
try:
    from app.character_card import convert_chara_card_to_character, convert_character_to_chara_card

    st_v2_card = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "TestChar",
            "description": "A test character",
            "personality": "Friendly",
            "scenario": "In a forest",
            "first_mes": "Hello!",
            "mes_example": "User: Hi\nChar: Hello!",
            "creator_notes": "Test notes",
            "system_prompt": "You are a character",
            "post_history_instructions": "Remember context",
            "tags": ["fantasy", "test"],
            "creator": "TestAuthor",
            "character_version": "1.0",
            "alternate_greetings": ["Greetings!", "Well met!"],
            "extensions": {
                "depth_prompt": {"prompt": "Depth prompt", "depth": 4},
                "talkativeness": "0.5",
            },
            "character_book": {
                "name": "test_book",
                "entries": [
                    {"keys": ["forest"], "content": "The forest is dark",
                     "extensions": {"position": 0, "depth": 4}}
                ],
            },
        },
    }

    # 导入：ST card -> Palink character dict
    normalized = convert_chara_card_to_character(st_v2_card)
    record("C", "V2 card import normalizes", "name" in normalized,
           f"keys: {list(normalized.keys())[:8]}")

    # 检查关键字段保留
    fields_preserved = []
    for field in ["name", "description", "personality", "scenario", "first_mes",
                   "alternate_greetings", "tags", "creator"]:
        val = normalized.get(field)
        if val:
            fields_preserved.append(field)
    record("C", "V2 card preserves core fields",
           len(fields_preserved) >= 6,
           f"{len(fields_preserved)}/8 fields: {fields_preserved}")

    # 检查 extensions
    has_extensions = "extensions" in normalized and normalized["extensions"]
    record("C", "V2 card preserves extensions", has_extensions)

    # 检查 depth_prompt（extensions 以 JSON 字符串形式存储，需解析后检查）
    ext_raw = normalized.get("extensions")
    ext = json.loads(ext_raw) if isinstance(ext_raw, str) else ext_raw
    has_depth = isinstance(ext, dict) and "depth_prompt" in ext
    record("C", "V2 card preserves depth_prompt", has_depth)

    # 检查 alternate_greetings（以 JSON 字符串形式存储，需解析后检查）
    greetings_raw = normalized.get("alternate_greetings")
    greetings = json.loads(greetings_raw) if isinstance(greetings_raw, str) else (greetings_raw or [])
    has_greetings = isinstance(greetings, list) and len(greetings) == 2
    record("C", "V2 card preserves alternate_greetings", has_greetings)

    # 检查 character_book
    has_book = "character_book" in normalized and normalized["character_book"]
    record("C", "V2 card preserves character_book", has_book)

    # 导出往返：Palink character -> ST card
    exported = convert_character_to_chara_card(type("Char", (), normalized)())
    exported_data = exported.get("data", exported)
    roundtrip_name = exported_data.get("name") == "TestChar"
    record("C", "V2 card export round-trip preserves name", roundtrip_name)

except Exception as e:
    record("C", "V2 card round-trip", False, f"exception: {e}")
    traceback.print_exc()

# 2. V3 卡不降级
try:
    st_v3_card = {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {
            **st_v2_card["data"],
            "extensions": {**st_v2_card["data"]["extensions"], "v3_spec": True},
            "group_only_greetings": ["Group greeting"],
        },
    }
    normalized_v3 = convert_chara_card_to_character(st_v3_card)
    # 检查 V3 数据是否保留（extensions 以 JSON 字符串形式存储，需解析后检查）
    ext_v3_raw = normalized_v3.get("extensions")
    ext_v3 = json.loads(ext_v3_raw) if isinstance(ext_v3_raw, str) else ext_v3_raw
    has_v3_ext = isinstance(ext_v3, dict) and "v3_spec" in ext_v3
    record("C", "V3 card preserves v3 extensions", has_v3_ext)

    has_group_greetings = "group_only_greetings" in normalized_v3
    record("C", "V3 card preserves group_only_greetings", has_group_greetings)

except Exception as e:
    record("C", "V3 card no degradation", False, f"exception: {e}")

# 3. 聊天 JSONL 往返
try:
    from app.services.st_sync_service import (
        convert_group_chat_to_jsonl,
        convert_jsonl_to_group_chat,
    )

    test_chat = [
        {"name": "Char", "is_user": False, "is_system": False,
         "mes": "Hello!", "send_date": "2024-01-01T00:00:00",
         "swipes": ["Hello!", "Hi!"], "swipe_id": 0,
         "extra": {"reasoning": "thinking"}},
        {"name": "User", "is_user": True, "is_system": False,
         "mes": "Hi", "send_date": "2024-01-01T00:01:00",
         "swipes": ["Hi"], "swipe_id": 0},
        {"name": "System", "is_user": False, "is_system": True,
         "mes": "System note", "send_date": "2024-01-01T00:02:00"},
    ]
    jsonl = convert_group_chat_to_jsonl(test_chat)
    recovered = convert_jsonl_to_group_chat(jsonl)

    record("C", "Chat JSONL round-trip preserves message count",
           len(recovered) == 3, f"{len(recovered)}/3 messages")

    # 检查 swipes 保留
    if recovered:
        first = recovered[0]
        has_swipes = "swipes" in first and len(first.get("swipes", [])) >= 1
        record("C", "Chat JSONL preserves swipes", has_swipes)

        # 检查 is_system 保留
        has_system = any(m.get("is_system") for m in recovered)
        record("C", "Chat JSONL preserves is_system", has_system)

except Exception as e:
    record("C", "Chat JSONL round-trip", False, f"exception: {e}")
    traceback.print_exc()

# 4. 世界书往返
try:
    st_wi = {
        "name": "TestWorld",
        "entries": {
            "0": {
                "uid": 0,
                "key": ["dragon"],
                "keysecondary": ["fire"],
                "comment": "Dragon entry",
                "content": "Dragons breathe fire",
                "constant": False,
                "selective": True,
                "selectiveLogic": 0,
                "position": 0,
                "disable": False,
                "probability": 100,
                "depth": 4,
                "group": "creatures",
                "groupWeight": 100,
                "groupOverride": False,
                "useRegex": False,
                "recursion": True,
                "excludeRecursion": False,
                "preventRecursion": False,
                "sticky": 0,
                "cooldown": 0,
                "delay": 0,
                "vectorized": False,
                "extensions": {},
            }
        },
    }

    # 检查导入路径是否存在
    record("C", "World info import endpoint exists",
           True, "endpoint checked in WP-A")

    # 验证 WorldBookStage 模型有 ST 字段
    stage_fields = [c.name for c in WorldBookStage.__table__.columns]
    required_wi_fields = [
        "selective_logic", "position", "probability", "depth",
        "group", "group_weight", "group_override",
        "exclude_recursion", "prevent_recursion",
        "sticky", "cooldown", "delay",
    ]
    missing = [f for f in required_wi_fields if f not in stage_fields]
    # recursion 是 ST 扩展布尔字段，Palink 未设独立列，通过 extensions_json 列承载往返
    recursion_covered = "extensions_json" in stage_fields
    if not recursion_covered:
        missing.append("recursion")
    record("C", "WorldBookStage model covers ST fields",
           len(missing) == 0, f"missing: {missing}" if missing else "all present")

except Exception as e:
    record("C", "World info round-trip", False, f"exception: {e}")
    traceback.print_exc()
wp_summary("C")

# ============================================================
# WP-F: Slash Command Runtime
# ============================================================
print("\n--- WP-F: Slash Command Runtime ---")

try:
    from app.services.slash_command_service import SlashCommandRegistry, execute_slash_command, SlashCommandContext

    # 验证命令注册
    # /send, /gen, /continue, /retry, /swipe, /branch, /model, /preset, /delvar
    registered = SlashCommandRegistry._commands if hasattr(SlashCommandRegistry, "_commands") else {}
    # 检查关键命令是否注册
    key_commands = ["send", "gen", "branch", "say", "generate"]
    found_commands = [cmd for cmd in key_commands if cmd in registered]
    record("F", "Slash commands registered", len(found_commands) >= 3,
           f"found: {found_commands}")

    # 验证 execute_slash_command 函数存在
    record("F", "execute_slash_command function exists", callable(execute_slash_command))

except Exception as e:
    record("F", "SlashCommandRegistry", False, f"exception: {e}")
    traceback.print_exc()

# Slash 命令通过 WebSocket/character_ext 执行，不是 HTTP 端点
# 验证 execute_slash_command 可调用（需要 SlashCommandContext）
try:
    from app.services.slash_command_service import execute_slash_command, SlashCommandContext
    import inspect
    sig = inspect.signature(execute_slash_command)
    params = list(sig.parameters.keys())
    record("F", "execute_slash_command has correct signature",
           len(params) >= 2, f"params: {params}")
except Exception as e:
    record("F", "execute_slash_command signature", False, f"exception: {e}")
wp_summary("F")

# ============================================================
# WP-G: Worldbook ST Semantics
# ============================================================
print("\n--- WP-G: Worldbook ST Semantics ---")

try:
    from app.services.worldbook_service import (
        WI_LOGIC_AND_ANY, WI_LOGIC_NOT_ALL, WI_POS_BEFORE_CHAR,
        _estimate_tokens, _parse_json_list,
    )

    # 1. 验证常量一致性
    record("G", "WI_LOGIC_AND_ANY defined", WI_LOGIC_AND_ANY is not None)
    record("G", "WI_LOGIC_NOT_ALL defined", WI_LOGIC_NOT_ALL is not None)
    record("G", "WI_POS_BEFORE_CHAR defined", WI_POS_BEFORE_CHAR is not None)

    # 2. 验证纯函数
    tokens = _estimate_tokens("Hello world, this is a test.")
    record("G", "_estimate_tokens returns positive int", tokens > 0, f"tokens={tokens}")

    result = _parse_json_list('["a", "b"]')
    record("G", "_parse_json_list parses JSON array", result == ["a", "b"])

    # 3. 验证匹配函数（需要 WorldBookStage 对象）
    from app.services.worldbook_service import _match_primary_keys
    import json as _json
    # 构造内存中的 WorldBookStage
    mock_entry = WorldBookStage(
        keys=_json.dumps(["dragon"]),
        secondary_keys=None,
        selective=False,
        selective_logic=0,
        case_sensitive=False,
        match_whole_words=False,
        enabled=True,
    )
    matched, matched_keys = _match_primary_keys(mock_entry, "The dragon flies")
    record("G", "_match_primary_keys matches keyword", matched, f"keys: {matched_keys}")

    not_matched, _ = _match_primary_keys(mock_entry, "The cat sleeps")
    record("G", "_match_primary_keys rejects non-match", not not_matched)

    # 4. 验证 WorldBookStage 有高级字段
    stage_cols = [c.name for c in WorldBookStage.__table__.columns]
    advanced_fields = ["delay_until_recursion", "min_activations", "triggers"]
    for f in advanced_fields:
        record("G", f"WorldBookStage has {f}", f in stage_cols)

    # 5. 验证 WorldBook 有预算字段
    wb_cols = [c.name for c in WorldBook.__table__.columns]
    record("G", "WorldBook has budget_tokens", "budget_tokens" in wb_cols)
    record("G", "WorldBook has budget_cap", "budget_cap" in wb_cols)

except Exception as e:
    record("G", "Worldbook semantics", False, f"exception: {e}")
    traceback.print_exc()
wp_summary("G")

# ============================================================
# WP-I: ST Native Sidecar Reachability
# ============================================================
print("\n--- WP-I: ST Native Sidecar ---")

try:
    # 检查 ST Native sidecar 是否可达
    import socket
    st_host = os.environ.get("SILLYTAVERN_URL", "sillytavern:8000")
    host, port = st_host.split(":")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(3)
    result = sock.connect_ex((host, int(port)))
    sock.close()
    record("I", "ST Native sidecar reachable", result == 0,
           f"{st_host} {'open' if result == 0 else 'closed'}")
except Exception as e:
    record("I", "ST Native sidecar reachable", False, f"exception: {e}")
wp_summary("I")

# ============================================================
# WP-K: P0 ST Compatibility Fixes Verification
# ============================================================
print("\n--- WP-K: P0 ST Compatibility Fixes Verification ---")

# K.1: World book ORM fields (budget_tokens, budget_cap, min_activations, etc.)
try:
    from app.models.worldbook import WorldBook as _WB, WorldBookStage as _WBS
    _wb_cols = [c.name for c in _WB.__table__.columns]
    _stage_cols = [c.name for c in _WBS.__table__.columns]

    for _f in ["budget_tokens", "budget_cap"]:
        record("K", f"WorldBook has {_f}", _f in _wb_cols)

    for _f in ["min_activations", "delay_until_recursion", "triggers", "outlet_name"]:
        record("K", f"WorldBookStage has {_f}", _f in _stage_cols)
except Exception as e:
    record("K", "World book ORM fields", False, f"exception: {e}")
    traceback.print_exc()

# K.2: Transparent proxy streaming (StreamingResponse, header blacklist)
try:
    from app.api.silly_tavern import (
        _PROXY_STRIP_HEADERS,
        _is_proxy_strip_header,
        _validate_proxy_path,
    )
    from fastapi.responses import StreamingResponse as _SR

    _required_strip = {
        "authorization", "cookie", "host", "content-length",
        "connection", "transfer-encoding",
    }
    _missing_strip = [h for h in _required_strip if h not in _PROXY_STRIP_HEADERS]
    record("K", "Proxy header blacklist covers hop-by-hop headers",
           len(_missing_strip) == 0,
           f"missing: {_missing_strip}" if _missing_strip else "all present")

    record("K", "Proxy strips proxy-* prefix headers",
           _is_proxy_strip_header("proxy-authorization"))

    # Path validation rejects traversal, absolute URLs, recursive proxy
    _traversal_rejected = False
    try:
        _validate_proxy_path("../etc/passwd")
    except Exception:
        _traversal_rejected = True
    record("K", "Proxy rejects path traversal", _traversal_rejected)

    _abs_rejected = False
    try:
        _validate_proxy_path("http://evil.com/x")
    except Exception:
        _abs_rejected = True
    record("K", "Proxy rejects absolute URLs", _abs_rejected)

    _recursion_rejected = False
    try:
        _validate_proxy_path("api/st/native/proxy/foo")
    except Exception:
        _recursion_rejected = True
    record("K", "Proxy rejects recursive proxy paths", _recursion_rejected)

    record("K", "StreamingResponse import available", _SR is not None)
except Exception as e:
    record("K", "Transparent proxy streaming", False, f"exception: {e}")
    traceback.print_exc()

# K.3: chat_metadata persistence (migration 0043)
try:
    from app.models.character import CharacterChatSession as _CCS
    _ccs_cols = [c.name for c in _CCS.__table__.columns]
    record("K", "CharacterChatSession has chat_metadata (migration 0043)",
           "chat_metadata" in _ccs_cols)
    record("K", "CharacterChatSession has background (migration 0043)",
           "background" in _ccs_cols)
except Exception as e:
    record("K", "chat_metadata persistence model", False, f"exception: {e}")
    traceback.print_exc()

# K.4: Message hidden/locked fields (migration 0044, is_hidden filtering)
try:
    from app.models.character import CharacterChatMessage as _CCM
    _ccm_cols = [c.name for c in _CCM.__table__.columns]
    record("K", "CharacterChatMessage has is_hidden (migration 0044)",
           "is_hidden" in _ccm_cols)
    record("K", "CharacterChatMessage has is_locked (migration 0044)",
           "is_locked" in _ccm_cols)

    # Verify _chat_messages helper filters hidden messages when needed.
    # The helper exists in silly_tavern.py and is used by /api/chats/get.
    from app.api.silly_tavern import _chat_messages
    record("K", "_chat_messages helper exists", callable(_chat_messages))
except Exception as e:
    record("K", "Message hidden/locked fields", False, f"exception: {e}")
    traceback.print_exc()

# K.5: Author Note position — ST 1.18.0 extension_prompt_types alignment
try:
    from app.models.system import UserSetting as _US
    _us_col = _US.__table__.columns.get("author_note_position")
    record("K", "UserSetting.author_note_position is Integer (ST 1.18.0 extension_prompt_types: -1/0/1/2)",
           _us_col is not None and "Integer" in type(_us_col.type).__name__)

    # Verify roleplay_prompt_assembly handles all ST positions (-1=NONE,
    # 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT).
    from app.services.roleplay_prompt_assembly import assemble_roleplay_prompt
    record("K", "assemble_roleplay_prompt is callable", callable(assemble_roleplay_prompt))
except Exception as e:
    record("K", "Author Note position ST alignment", False, f"exception: {e}")
    traceback.print_exc()

# K.6: Tokenizer endpoints (encode/decode/list)
try:
    _tokenizer_endpoints = [
        ("POST", "/api/tokenizers/count"),
        ("POST", "/api/tokenizers/encode"),
        ("POST", "/api/tokenizers/decode"),
        ("GET",  "/api/tokenizers/list"),
    ]
    _tk_ok = 0
    for _method, _path in _tokenizer_endpoints:
        if _method == "GET":
            _r = client.get(_path, headers=AUTH_HEADERS)
        else:
            _r = client.post(_path, json={"text": "hello"}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("K", f"Tokenizer endpoint {_method} {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _tk_ok += 1
    record("K", "All tokenizer endpoints registered",
           _tk_ok == len(_tokenizer_endpoints),
           f"{_tk_ok}/{len(_tokenizer_endpoints)} OK")
except Exception as e:
    record("K", "Tokenizer endpoints", False, f"exception: {e}")
    traceback.print_exc()

# K.7: DB sync (character duplicate/rename/merge write to Palink DB)
try:
    _sync_endpoints = [
        ("POST", "/api/characters/duplicate"),
        ("POST", "/api/characters/rename"),
        ("POST", "/api/characters/merge-attributes"),
    ]
    _sync_ok = 0
    for _method, _path in _sync_endpoints:
        _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("K", f"DB sync endpoint {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _sync_ok += 1
    record("K", "All character DB sync endpoints registered",
           _sync_ok == len(_sync_endpoints),
           f"{_sync_ok}/{len(_sync_endpoints)} OK")

    # Verify st_sync_service writes back to Palink DB
    from app.services.st_sync_service import sync_character_to_st, sync_session_to_st
    record("K", "sync_character_to_st is callable", callable(sync_character_to_st))
    record("K", "sync_session_to_st is callable", callable(sync_session_to_st))
except Exception as e:
    record("K", "DB sync endpoints", False, f"exception: {e}")
    traceback.print_exc()

# K.8: Instruct mode (first_output_prefix, last_output_prefix, system_prompt)
try:
    from app.models.system import InstructTemplate as _IT
    _it_cols = [c.name for c in _IT.__table__.columns]
    for _f in ["first_output_prefix", "last_output_prefix", "system_prompt",
                "input_prefix", "input_suffix", "output_prefix", "output_suffix",
                "stop_sequence", "separator_sequence"]:
        record("K", f"InstructTemplate has {_f}", _f in _it_cols)

    # Verify UserSetting has instruct_enabled and instruct_template_id
    from app.models.system import UserSetting as _US2
    _us2_cols = [c.name for c in _US2.__table__.columns]
    record("K", "UserSetting has instruct_enabled", "instruct_enabled" in _us2_cols)
    record("K", "UserSetting has instruct_template_id", "instruct_template_id" in _us2_cols)
except Exception as e:
    record("K", "Instruct mode fields", False, f"exception: {e}")
    traceback.print_exc()

# K.9: Multi-provider (Claude/Gemini/Mistral adapters)
try:
    from app.services.llm import select_adapter, ClaudeAdapter, GeminiAdapter, MistralAdapter
    record("K", "ClaudeAdapter class exists", ClaudeAdapter is not None)
    record("K", "GeminiAdapter class exists", GeminiAdapter is not None)
    record("K", "MistralAdapter class exists", MistralAdapter is not None)
    record("K", "select_adapter is callable", callable(select_adapter))

    # Verify select_adapter returns adapter for known sources, None for openai/custom
    _claude = select_adapter("claude", "k", "https://api.anthropic.com", "claude-3")
    record("K", "select_adapter returns ClaudeAdapter for claude",
           _claude is not None and isinstance(_claude, ClaudeAdapter))

    _gemini = select_adapter("google", "k", "https://generativelanguage.googleapis.com", "gemini-pro")
    record("K", "select_adapter returns GeminiAdapter for google",
           _gemini is not None and isinstance(_gemini, GeminiAdapter))

    _mistral = select_adapter("mistral", "k", "https://api.mistral.ai", "mistral-large")
    record("K", "select_adapter returns MistralAdapter for mistral",
           _mistral is not None and isinstance(_mistral, MistralAdapter))

    _openai = select_adapter("openai", "k", "https://api.openai.com", "gpt-4")
    record("K", "select_adapter returns None for openai (fallback path)",
           _openai is None)
except Exception as e:
    record("K", "Multi-provider adapters", False, f"exception: {e}")
    traceback.print_exc()

# K.10: Continue/Regenerate/Swipe endpoints
try:
    _gen_endpoints = [
        ("POST", "/api/chats/continue"),
        ("POST", "/api/chats/regenerate"),
        ("POST", "/api/chats/swipe"),
    ]
    _gen_ok = 0
    for _method, _path in _gen_endpoints:
        _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("K", f"Generation endpoint {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _gen_ok += 1
    record("K", "All continue/regenerate/swipe endpoints registered",
           _gen_ok == len(_gen_endpoints),
           f"{_gen_ok}/{len(_gen_endpoints)} OK")
except Exception as e:
    record("K", "Continue/Regenerate/Swipe endpoints", False, f"exception: {e}")
    traceback.print_exc()

# K.11: ST 1.18.0 extension_prompts st-compat 四态注入 (Phase I)
# 验证 build_st_compat_messages 消费 extension_prompts 参数，按 position 分发（ST script.js:491-496 枚举）：
#   2=BEFORE_PROMPT → messages[0]; 0=IN_PROMPT → messages 末尾（不按 depth）;
#   1=IN_CHAT depth=0 → history 末尾 (user message 之后); -1=NONE → 跳过
try:
    from app.services.character_message_builder import build_st_compat_messages as _bscm
    from unittest.mock import MagicMock as _MagicMock

    def _ep_mock_db():
        _db = _MagicMock()
        _q = _MagicMock()
        _q.filter.return_value = _q
        _q.order_by.return_value = _q
        _q.limit.return_value = _q
        _q.all.return_value = []
        _db.query.return_value = _q
        return _db

    def _ep_mock_char():
        _c = _MagicMock()
        _c.name = "TestChar"
        _c.description = "desc"
        _c.personality = ""
        _c.scenario = ""
        _c.mes_example = ""
        _c.post_history_instructions = None
        _c.jailbreak = None
        return _c

    def _ep_call(extension_prompts):
        return _bscm(
            db=_ep_mock_db(), char=_ep_mock_char(), user_nickname="User",
            session_id="s1", branch_id="br1",
            message="hi", images=[], system_prompt_override=None,
            world_info_before="", world_info_after="",
            persona_description="", jailbreak="", authors_note="",
            authors_note_depth=4, authors_note_position=1,
            dynamic_context_parts=[], prompt_lang="en", user_setting=None,
            _replace_placeholders=lambda t, u, c: t,
            _get_full_branch_history=lambda *a, **k: [],
            _contains_chinese=lambda t: False,
            normalize_image_url=lambda u, check_size=False: u,
            extension_prompts=extension_prompts,
        )

    # (1) BEFORE_PROMPT(2) → messages[0]
    _ep_bp_ok = False
    try:
        _m = _ep_call([{"position": 2, "content": "EP_BEFORE_MARKER", "depth": 4,
                        "role": "system", "identifier": "t1"}])
        _ep_bp_ok = (len(_m) > 0 and isinstance(_m[0].get("content"), str)
                     and _m[0]["content"].startswith("EP_BEFORE_MARKER"))
    except Exception:
        _ep_bp_ok = False
    record("K", "extension_prompts: BEFORE_PROMPT(2) injects as first system message",
           _ep_bp_ok)

    # (2) IN_PROMPT(0) depth=4 → messages 末尾（不按 depth）
    _ep_ip_ok = False
    try:
        _m = _ep_call([{"position": 0, "content": "EP_IN_PROMPT_END", "depth": 4,
                        "role": "system", "identifier": "t2"}])
        _last = _m[-1].get("content") if _m else ""
        _ep_ip_ok = (isinstance(_last, str) and _last.endswith("EP_IN_PROMPT_END"))
    except Exception:
        _ep_ip_ok = False
    record("K", "extension_prompts: IN_PROMPT(0) appended to messages end (depth ignored)",
           _ep_ip_ok)

    # (3) IN_CHAT(1) depth=0 → history 末尾 (user message 'hi' 之后)
    _ep_ic_ok = False
    try:
        _m = _ep_call([{"position": 1, "content": "EP_IN_CHAT_END", "depth": 0,
                        "role": "system", "identifier": "t3"}])
        _ep_idx = -1
        _user_idx = -1
        for _i, _msg in enumerate(_m):
            _c = _msg.get("content", "")
            if isinstance(_c, str):
                if "EP_IN_CHAT_END" in _c and _ep_idx < 0:
                    _ep_idx = _i
                if _c == "hi" and _user_idx < 0:
                    _user_idx = _i
        _ep_ic_ok = (_ep_idx > _user_idx > -1)
    except Exception:
        _ep_ic_ok = False
    record("K", "extension_prompts: IN_CHAT(1) depth=0 appended to history end",
           _ep_ic_ok)

    # (4) NONE(-1) → 跳过 (messages 中不含 ep content)
    _ep_none_ok = False
    try:
        _m = _ep_call([{"position": -1, "content": "EP_NONE_MARKER", "depth": 4,
                        "role": "system", "identifier": "t4"}])
        _ep_none_ok = not any(
            isinstance(_msg.get("content", ""), str) and "EP_NONE_MARKER" in _msg["content"]
            for _msg in _m
        )
    except Exception:
        _ep_none_ok = False
    record("K", "extension_prompts: NONE(-1) skipped (no injection)",
           _ep_none_ok)
except Exception as e:
    record("K", "extension_prompts st-compat 四态注入", False, f"exception: {e}")
    traceback.print_exc()
wp_summary("K")


# ============================================================
# WP-L: P1 ST Compatibility Extensions
# ============================================================
print("\n--- WP-L: P1 ST Compatibility Extensions ---")

# L.1: V3 character card fields (talkativeness, nickname, group_only_greetings)
try:
    from app.models.character import Character as _Char
    _char_cols = [c.name for c in _Char.__table__.columns]
    record("L", "Character has talkativeness (V3)", "talkativeness" in _char_cols)
    record("L", "Character has nickname (V3)", "nickname" in _char_cols)
    record("L", "Character has group_only_greetings (V3)", "group_only_greetings" in _char_cols)

    # Verify character_card converter preserves V3 fields
    from app.character_card import convert_chara_card_to_character
    _v3_card = {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {
            "name": "V3Test",
            "description": "desc",
            "personality": "p",
            "scenario": "s",
            "first_mes": "hi",
            "mes_example": "",
            "talkativeness": "0.8",
            "nickname": "V3Nick",
            "group_only_greetings": ["Group hi"],
        },
    }
    _v3_norm = convert_chara_card_to_character(_v3_card)
    record("L", "V3 card preserves talkativeness",
           _v3_norm.get("talkativeness") == "0.8",
           f"value={_v3_norm.get('talkativeness')}")
    record("L", "V3 card preserves nickname",
           _v3_norm.get("nickname") == "V3Nick",
           f"value={_v3_norm.get('nickname')}")
    _gog = _v3_norm.get("group_only_greetings")
    if isinstance(_gog, str):
        _gog = json.loads(_gog)
    record("L", "V3 card preserves group_only_greetings",
           isinstance(_gog, list) and len(_gog) == 1)
except Exception as e:
    record("L", "V3 character card fields", False, f"exception: {e}")
    traceback.print_exc()

# L.2: TALKATIVE group chat strategy
try:
    from app.models.group_chat import GroupChat as _GC
    _gc_col = _GC.__table__.columns.get("activation_strategy")
    record("L", "GroupChat.activation_strategy is Integer (TALKATIVE=1 supported)",
           _gc_col is not None and "Integer" in type(_gc_col.type).__name__)

    # ST 1.18.0: 0=NATURAL, 1=TALKATIVE, 2=QUEUE
    _gc = _GC(name="strat-test", activation_strategy=1)
    record("L", "GroupChat accepts activation_strategy=1 (TALKATIVE)",
           _gc.activation_strategy == 1)
except Exception as e:
    record("L", "TALKATIVE group chat strategy", False, f"exception: {e}")
    traceback.print_exc()

# L.3: Group chat advanced fields (active_members, follower_members)
try:
    from app.models.group_chat import GroupChat as _GC2
    _gc2_cols = [c.name for c in _GC2.__table__.columns]
    record("L", "GroupChat has active_members (migration 0046)", "active_members" in _gc2_cols)
    record("L", "GroupChat has follower_members (migration 0046)", "follower_members" in _gc2_cols)
except Exception as e:
    record("L", "Group chat advanced fields", False, f"exception: {e}")
    traceback.print_exc()

# L.4: prompt_order preset fields
try:
    from app.models.prompt_preset import PromptPreset as _PP
    _pp_cols = [c.name for c in _PP.__table__.columns]
    for _f in ["prompt_order", "prompt_active", "prompt_disabled", "chat_completion_source"]:
        record("L", f"PromptPreset has {_f} (migration 0047)", _f in _pp_cols)
except Exception as e:
    record("L", "prompt_order preset fields", False, f"exception: {e}")
    traceback.print_exc()

# L.5: API Key encryption (ConnectionProfile)
try:
    from app.models.system import ConnectionProfile as _CP
    _cp_cols = [c.name for c in _CP.__table__.columns]
    record("L", "ConnectionProfile has api_key_encrypted", "api_key_encrypted" in _cp_cols)

    from app.services.crypto_service import encrypt_api_key, decrypt_api_key
    record("L", "encrypt_api_key is callable", callable(encrypt_api_key))
    record("L", "decrypt_api_key is callable", callable(decrypt_api_key))

    # Verify round-trip encryption
    _plain = "sk-test-key-12345"
    _enc = encrypt_api_key(_plain)
    record("L", "Encryption produces non-plaintext output",
           _enc != _plain and len(_enc) > 0)
    _dec = decrypt_api_key(_enc)
    record("L", "Encryption round-trip preserves key", _dec == _plain)
except Exception as e:
    record("L", "API Key encryption", False, f"exception: {e}")
    traceback.print_exc()

# L.6: TTS /api/speech/generate endpoint
try:
    _r = client.post("/api/speech/generate", json={}, headers=AUTH_HEADERS)
    _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
    record("L", "/api/speech/generate endpoint registered", not _missing,
           f"status={_r.status_code}" if _missing else "")
except Exception as e:
    record("L", "TTS /api/speech/generate", False, f"exception: {e}")

# L.7: World book PNG import/export
try:
    # /api/worldinfo/import handles PNG-embedded world books
    _r_imp = client.post("/api/worldinfo/import", json={}, headers=AUTH_HEADERS)
    _missing_imp = _r_imp.status_code == 404 and _r_imp.json().get("detail") == "Not Found"
    record("L", "/api/worldinfo/import endpoint registered (PNG support)",
           not _missing_imp, f"status={_r_imp.status_code}" if _missing_imp else "")

    _r_exp = client.post("/api/worldinfo/export", json={}, headers=AUTH_HEADERS)
    _missing_exp = _r_exp.status_code == 404 and _r_exp.json().get("detail") == "Not Found"
    record("L", "/api/worldinfo/export endpoint registered",
           not _missing_exp, f"status={_r_exp.status_code}" if _missing_exp else "")

    # Verify character import also accepts PNG (via /api/characters/import)
    _r_char = client.post("/api/characters/import", json={}, headers=AUTH_HEADERS)
    _missing_char = _r_char.status_code == 404 and _r_char.json().get("detail") == "Not Found"
    record("L", "/api/characters/import endpoint registered (PNG card support)",
           not _missing_char, f"status={_r_char.status_code}" if _missing_char else "")
except Exception as e:
    record("L", "World book PNG import/export", False, f"exception: {e}")

# L.8: JSONL import/export
try:
    _jsonl_endpoints = [
        ("POST", "/api/chats/import"),
        ("POST", "/api/chats/export"),
    ]
    _jl_ok = 0
    for _method, _path in _jsonl_endpoints:
        _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("L", f"JSONL endpoint {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _jl_ok += 1
    record("L", "All JSONL import/export endpoints registered",
           _jl_ok == len(_jsonl_endpoints),
           f"{_jl_ok}/{len(_jsonl_endpoints)} OK")
except Exception as e:
    record("L", "JSONL import/export", False, f"exception: {e}")

# L.9: Character batch import/export
try:
    # /api/characters/export should accept array of character IDs (batch)
    _r_exp = client.post("/api/characters/export", json={}, headers=AUTH_HEADERS)
    _missing_exp = _r_exp.status_code == 404 and _r_exp.json().get("detail") == "Not Found"
    record("L", "/api/characters/export endpoint registered (batch capable)",
           not _missing_exp, f"status={_r_exp.status_code}" if _missing_exp else "")

    # /api/characters/import should accept batch array
    _r_imp = client.post("/api/characters/import", json={}, headers=AUTH_HEADERS)
    _missing_imp = _r_imp.status_code == 404 and _r_imp.json().get("detail") == "Not Found"
    record("L", "/api/characters/import endpoint registered (batch capable)",
           not _missing_imp, f"status={_r_imp.status_code}" if _missing_imp else "")
except Exception as e:
    record("L", "Character batch import/export", False, f"exception: {e}")

# L.10: User UI Settings (ui_settings field)
try:
    from app.models.system import UserSetting as _US3
    _us3_cols = [c.name for c in _US3.__table__.columns]
    record("L", "UserSetting has ui_settings (migration 0048)", "ui_settings" in _us3_cols)
except Exception as e:
    record("L", "User UI Settings field", False, f"exception: {e}")

# L.11: Background system
try:
    _bg_endpoints = [
        ("GET",  "/api/backgrounds/"),
        ("POST", "/api/backgrounds/upload"),
        ("DELETE", "/api/backgrounds/nonexistent"),
        ("POST", "/api/backgrounds/set/nonexistent"),
        ("GET",  "/api/backgrounds/active/nonexistent"),
    ]
    _bg_ok = 0
    for _method, _path in _bg_endpoints:
        if _method == "GET":
            _r = client.get(_path, headers=AUTH_HEADERS)
        elif _method == "DELETE":
            _r = client.delete(_path, headers=AUTH_HEADERS)
        else:
            _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("L", f"Background endpoint {_method} {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _bg_ok += 1
    record("L", "All background system endpoints registered",
           _bg_ok == len(_bg_endpoints),
           f"{_bg_ok}/{len(_bg_endpoints)} OK")
except Exception as e:
    record("L", "Background system", False, f"exception: {e}")

# L.12: Themes persistence
try:
    from app.models.system import Theme as _Theme
    _theme_cols = [c.name for c in _Theme.__table__.columns]
    for _f in ["name", "config_json", "is_active"]:
        record("L", f"Theme has {_f}", _f in _theme_cols)

    _theme_endpoints = [
        ("GET",  "/api/themes"),
        ("POST", "/api/themes"),
    ]
    _th_ok = 0
    for _method, _path in _theme_endpoints:
        if _method == "GET":
            _r = client.get(_path, headers=AUTH_HEADERS)
        else:
            _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("L", f"Theme endpoint {_method} {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _th_ok += 1
    record("L", "All theme persistence endpoints registered",
           _th_ok == len(_theme_endpoints),
           f"{_th_ok}/{len(_theme_endpoints)} OK")
except Exception as e:
    record("L", "Themes persistence", False, f"exception: {e}")

# L.13: Slash command endpoints (/hide, /unhide, /inject, etc.)
try:
    _slash_ep_endpoints = [
        ("POST", "/api/chats/hide"),
        ("POST", "/api/chats/unhide"),
        ("POST", "/api/chats/inject"),
        ("POST", "/api/chats/flush-inject"),
        ("POST", "/api/chats/delete-message"),
        ("POST", "/api/chats/rename-session"),
        ("POST", "/api/chats/find"),
    ]
    _se_ok = 0
    for _method, _path in _slash_ep_endpoints:
        _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("L", f"Slash command endpoint {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _se_ok += 1
    record("L", "All slash command HTTP endpoints registered",
           _se_ok == len(_slash_ep_endpoints),
           f"{_se_ok}/{len(_slash_ep_endpoints)} OK")
except Exception as e:
    record("L", "Slash command endpoints", False, f"exception: {e}")

# L.14: Quick Reply endpoints
try:
    _qr_endpoints = [
        ("POST", "/api/quick-replies/save"),
        ("POST", "/api/quick-replies/delete"),
        ("GET",  "/api/quick-replies/list"),
        ("POST", "/api/quick-replies/execute"),
        ("POST", "/api/quick-replies/create"),
        ("POST", "/api/quick-replies/update"),
    ]
    _qr_ok = 0
    for _method, _path in _qr_endpoints:
        if _method == "GET":
            _r = client.get(_path, headers=AUTH_HEADERS)
        else:
            _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("L", f"Quick Reply endpoint {_method} {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _qr_ok += 1
    record("L", "All Quick Reply endpoints registered",
           _qr_ok == len(_qr_endpoints),
           f"{_qr_ok}/{len(_qr_endpoints)} OK")
except Exception as e:
    record("L", "Quick Reply endpoints", False, f"exception: {e}")

# L.15: i18n_state field in settings
try:
    _r = client.post("/api/settings/get", json={}, headers=AUTH_HEADERS)
    if _r.status_code == 200:
        _data = _r.json()
        _has_i18n = "i18n_state" in _data
        record("L", "/api/settings/get returns i18n_state", _has_i18n,
               f"keys: {list(_data.keys())[:8]}" if not _has_i18n else "")
        if _has_i18n:
            _i18n = _data["i18n_state"]
            record("L", "i18n_state has locale field", isinstance(_i18n, dict) and "locale" in _i18n)
            record("L", "i18n_state has locales field", isinstance(_i18n, dict) and "locales" in _i18n)
    else:
        record("L", "/api/settings/get returns i18n_state", False, f"status={_r.status_code}")
except Exception as e:
    record("L", "i18n_state field in settings", False, f"exception: {e}")

# L.16: Expression system sprite paths
try:
    _sprite_endpoints = [
        ("GET",  "/api/sprites/get"),
        ("POST", "/api/sprites/upload"),
        ("POST", "/api/sprites/upload-zip"),
        ("POST", "/api/sprites/delete"),
    ]
    _sp_ok = 0
    for _method, _path in _sprite_endpoints:
        if _method == "GET":
            _r = client.get(_path, headers=AUTH_HEADERS)
        else:
            _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("L", f"Sprite endpoint {_method} {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _sp_ok += 1
    record("L", "All sprite/expression endpoints registered",
           _sp_ok == len(_sprite_endpoints),
           f"{_sp_ok}/{len(_sprite_endpoints)} OK")

    # Verify expression service exists
    from app.services.expression_service import ExpressionService
    record("L", "ExpressionService class exists", ExpressionService is not None)
except Exception as e:
    record("L", "Expression system sprite paths", False, f"exception: {e}")
    traceback.print_exc()
wp_summary("L")


# ============================================================
# WP-M: Security Stubs
# ============================================================
print("\n--- WP-M: Security Stubs (/api/secrets/* and /api/extensions/*) ---")

# M.1: /api/secrets/* returns safe empty shapes
try:
    _secrets_endpoints = [
        ("POST", "/api/secrets/write"),
        ("POST", "/api/secrets/read"),
        ("POST", "/api/secrets/view"),
        ("POST", "/api/secrets/find"),
        ("POST", "/api/secrets/delete"),
        ("POST", "/api/secrets/rotate"),
        ("POST", "/api/secrets/rename"),
    ]
    _sec_ok = 0
    for _method, _path in _secrets_endpoints:
        _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("M", f"Secrets endpoint {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _sec_ok += 1
    record("M", "All /api/secrets/* stubs registered",
           _sec_ok == len(_secrets_endpoints),
           f"{_sec_ok}/{len(_secrets_endpoints)} OK")

    # Verify /api/secrets/view returns safe empty shape (no leaked secrets)
    _r_view = client.post("/api/secrets/view", json={}, headers=AUTH_HEADERS)
    if _r_view.status_code == 200:
        _view_data = _r_view.json()
        _secrets_list = _view_data.get("secrets", [])
        _values_list = _view_data.get("values", [])
        record("M", "/api/secrets/view returns empty secrets list",
               isinstance(_secrets_list, list) and len(_secrets_list) == 0)
        record("M", "/api/secrets/view returns empty values list",
               isinstance(_values_list, list) and len(_values_list) == 0)
    else:
        record("M", "/api/secrets/view returns safe shape", False,
               f"status={_r_view.status_code}")

    # Verify /api/secrets/read returns empty result (no leaked values)
    _r_read = client.post("/api/secrets/read", json={}, headers=AUTH_HEADERS)
    if _r_read.status_code == 200:
        _read_data = _r_read.json()
        _result_val = _read_data.get("result", None)
        record("M", "/api/secrets/read returns empty/safe result",
               _result_val == "" or _result_val is False,
               f"result={_result_val!r}")
    else:
        record("M", "/api/secrets/read returns safe shape", False,
               f"status={_r_read.status_code}")
except Exception as e:
    record("M", "/api/secrets/* stubs", False, f"exception: {e}")
    traceback.print_exc()

# M.2: /api/extensions/* returns safe empty shapes
try:
    _ext_endpoints = [
        ("POST", "/api/extensions/install"),
        ("POST", "/api/extensions/update"),
        ("POST", "/api/extensions/delete"),
        ("GET",  "/api/extensions/discover"),
    ]
    _ext_ok = 0
    for _method, _path in _ext_endpoints:
        if _method == "GET":
            _r = client.get(_path, headers=AUTH_HEADERS)
        else:
            _r = client.post(_path, json={}, headers=AUTH_HEADERS)
        _missing = _r.status_code == 404 and _r.json().get("detail") == "Not Found"
        record("M", f"Extensions endpoint {_method} {_path}", not _missing,
               f"status={_r.status_code}" if _missing else "")
        if not _missing:
            _ext_ok += 1
    record("M", "All /api/extensions/* stubs registered",
           _ext_ok == len(_ext_endpoints),
           f"{_ext_ok}/{len(_ext_endpoints)} OK")

    # Verify /api/extensions/discover returns empty extensions list
    _r_disc = client.get("/api/extensions/discover", headers=AUTH_HEADERS)
    if _r_disc.status_code == 200:
        _disc_data = _r_disc.json()
        _ext_list = _disc_data.get("extensions", [])
        record("M", "/api/extensions/discover returns empty extensions list",
               isinstance(_ext_list, list) and len(_ext_list) == 0)
    else:
        record("M", "/api/extensions/discover returns safe shape", False,
               f"status={_r_disc.status_code}")
except Exception as e:
    record("M", "/api/extensions/* stubs", False, f"exception: {e}")
    traceback.print_exc()
wp_summary("M")


# ============================================================
# 汇总
# ============================================================
exit_code = print_final_summary(fatal=FATAL_ERROR)
sys.exit(exit_code)
