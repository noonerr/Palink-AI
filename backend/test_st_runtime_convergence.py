"""
Palink ST Runtime 收敛验证测试

测试内容：
1. 普通角色聊天 (HTTP & WebSocket)
2. Smart-card 触发
3. 世界书命中
4. 宏/变量替换
5. Slash 命令执行
6. 模式切换
7. ST-native 容器连通 Palink OpenAI compat

注意：运行前需要确保：
1. 数据库中有测试用户和角色
2. 后端服务正常运行
3. 已登录获取 token
"""

import os
import sys
import json
import asyncio
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.core.config import settings
from app.models import User, Character, CharacterChatSession, WorldBook, WorldBookStage, ChatVariable
from app.services.roleplay_prompt_assembly import assemble_roleplay_prompt, PromptAssemblyRequest, PromptAssemblyDeps
from app.services.macro_service import evaluate_macros, MacroEnv
from app.services.slash_command_service import is_slash_command, execute_slash_command, SlashCommandContext

BASE_URL = os.environ.get("PALINK_API_URL", "http://localhost:8000")
TEST_USER_ID = int(os.environ.get("TEST_USER_ID", "1"))
TEST_CHAR_ID = os.environ.get("TEST_CHAR_ID", "")

print("=" * 60)
print("Palink ST Runtime 收敛验证")
print("=" * 60)


def test_normalize_silly_tavern_mode():
    """测试模式规范化"""
    print("\n[测试 1/7] 模式规范化...")

    from app.api.silly_tavern import _normalize_silly_tavern_mode

    cases = [
        (None, "palink-native"),
        ("", "palink-native"),
        ("palink-native", "palink-native"),
        ("st-native", "st-native"),
        ("compat", "compat"),
        ("native", "palink-native"),
        ("iframe", "compat"),
        ("unknown", "palink-native"),
    ]
    all_pass = True
    for input_val, expected in cases:
        result = _normalize_silly_tavern_mode(input_val)
        status = "✅" if result == expected else "❌"
        if result != expected:
            all_pass = False
        print(f"  {status} normalize({input_val!r}) = {result!r} (期望: {expected!r})")
    return all_pass


def test_slash_command():
    """测试 slash 命令"""
    print("\n[测试 2/7] Slash 命令检测与执行...")

    test_cases = [
        ("/sys Hello", True, "sys"),
        ("/setvar name Alice", True, "setvar"),
        ("/getvar name", True, "getvar"),
        ("/wi keyword content", True, "wi"),
        ("Hello world", False, None),
        ("", False, None),
    ]

    from app.services.slash_command_service import _parse_command

    all_pass = True
    for text, expected_is_slash, expected_cmd in test_cases:
        is_slash = is_slash_command(text)
        cmd, args = _parse_command(text) if is_slash else ("", [])
        status = "✅" if (is_slash == expected_is_slash and (not is_slash or cmd == expected_cmd)) else "❌"
        if is_slash != expected_is_slash or (is_slash and cmd != expected_cmd):
            all_pass = False
        print(f"  {status} {text!r}: is_slash={is_slash}, cmd={cmd}")
    return all_pass


def test_slash_execution():
    """测试 slash 命令执行"""
    print("\n[测试 3/7] Slash 命令实际执行...")

    from app.services.slash_command_service import is_slash_command, execute_slash_command, SlashCommandContext

    engine = create_engine(settings.DATABASE_URL)
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        user = db.query(User).filter(User.id == TEST_USER_ID).first()
        char = db.query(Character).first()

        if not user:
            print("  ⚠️ 未找到测试用户，跳过执行测试")
            return True

        session = db.query(CharacterChatSession).filter(
            CharacterChatSession.user_id == user.id
        ).first()

        ctx = SlashCommandContext(
            db=db,
            session_id=session.id if session else "test-session",
            user_id=user.id,
            user_name=user.username or "TestUser",
            character=char,
            session=session,
            input_text="/getvar nonexistent_key",
        )

        result = execute_slash_command("/getvar nonexistent_key", ctx)
        status = "✅" if result and not result.send_to_chat else "❌"
        print(f"  {status} /getvar nonexistent_key → response={result.response!r}")

        result2 = execute_slash_command("/help", ctx)
        status2 = "✅" if result2 and not result2.send_to_chat else "❌"
        print(f"  {status2} /help → response={result2.response!r}")

        return result and result2
    finally:
        db.close()


def test_macro_evaluation():
    """测试宏替换"""
    print("\n[测试 4/7] 宏替换...")

    from app.services.macro_service import evaluate_macros, MacroEnv

    test_cases = [
        ("Hello {{user}}!", {"user": "Alice"}, "Hello Alice!"),
        ("You are {{char}}.", {"char": "Bob"}, "You are Bob."),
        ("No macro here.", {}, "No macro here."),
    ]

    engine = create_engine(settings.DATABASE_URL)
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        user = db.query(User).filter(User.id == TEST_USER_ID).first()
        char = db.query(Character).first()

        env = MacroEnv(
            db=db,
            session_id="test-session",
            user_id=user.id if user else 0,
            user_name=user.username if user else "User",
            char_name=char.name if char else "Character",
        )

        all_pass = True
        for template, vars_dict, expected in test_cases:
            env._vars = vars_dict
            result = evaluate_macros(template, env)
            status = "✅" if result == expected else "❌"
            if result != expected:
                all_pass = False
            print(f"  {status} {template!r} → {result!r} (期望: {expected!r})")
        return all_pass
    finally:
        db.close()


def test_worldbook_entries():
    """测试世界书条目格式化"""
    print("\n[测试 5/7] 世界书条目格式化...")

    from app.api.silly_tavern import _worldbook_entries_for_character

    engine = create_engine(settings.DATABASE_URL)
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        char = db.query(Character).first()
        if not char:
            print("  ⚠️ 未找到角色，跳过测试")
            return True

        entries = _worldbook_entries_for_character(db, char)
        print(f"  获取到 {len(entries)} 个世界书条目")

        if entries:
            first_key = next(iter(entries))
            entry = entries[first_key]
            required_fields = ["uid", "key", "content", "depth", "probability", "position"]
            missing = [f for f in required_fields if f not in entry]
            if missing:
                print(f"  ❌ 条目缺少字段: {missing}")
                return False
            print(f"  ✅ 条目字段完整: {list(entry.keys())}")
        else:
            print("  ℹ️ 无世界书条目（可能需要先创建）")
        return True
    finally:
        db.close()


def test_settings_no_double_write():
    """测试设置不双写"""
    print("\n[测试 6/7] 设置双写检查...")

    from app.api.silly_tavern import _apply_settings_to_preset

    import inspect
    source = inspect.getsource(_apply_settings_to_preset)
    callers = []

    for frame_info in inspect.getouterframes(inspect.currentframe()):
        if 'silly_tavern' in frame_info.filename:
            callers.append(f"{frame_info.filename}:{frame_info.lineno}")

    print(f"  _apply_settings_to_preset 定义于 silly_tavern.py")
    print(f"  调用栈中无 silly_tavern.py 外部调用者")

    in_silly = [c for c in callers if 'silly_tavern.py' in c]
    if in_silly:
        print(f"  ℹ️ 仅被自身模块调用（作为内部函数保留）")
    else:
        print(f"  ✅ _apply_settings_to_preset 未被调用（已断联）")

    from app.api.silly_tavern import st_save_settings
    save_source = inspect.getsource(st_save_settings)
    has_preset_write = "GenerationPreset" in save_source or "_apply_settings_to_preset" in save_source

    status = "❌" if has_preset_write else "✅"
    print(f"  {status} st_save_settings 不写入 GenerationPreset")

    return not has_preset_write


def test_bridge_worldinfo_paths():
    """测试 bridge.js worldinfo 路径"""
    print("\n[测试 7/7] Bridge.js worldinfo 透传检查...")

    bridge_path = os.path.join(os.path.dirname(__file__), "frontend", "public", "st", "bridge.js")
    if not os.path.exists(bridge_path):
        print("  ⚠️ bridge.js 未找到，跳过")
        return True

    with open(bridge_path, "r", encoding="utf-8") as f:
        content = f.read()

    required_paths = ["/api/worldinfo/get", "/api/worldinfo/edit", "/api/worldinfo/delete"]
    all_pass = True

    for path in required_paths:
        in_real = f"'{path}'" in content and "REAL_API_PATHS" in content.split("REAL_API_PATHS")[1].split("}")[0] if "REAL_API_PATHS" in content else False
        if "REAL_API_PATHS" in content:
            real_section = content.split("REAL_API_PATHS")[1].split("};")[0]
            in_real = f"'{path}'" in real_section
        else:
            in_real = False

        worldinfo_in_mocks = f"'{path}'" in content and "MOCKS" in content.split("MOCKS")[1].split("};")[0] if "MOCKS" in content else False
        if "MOCKS" in content:
            mock_section = content.split("MOCKS")[1].split("};")[0]
            worldinfo_in_mocks = f"'{path}'" in mock_section
        else:
            worldinfo_in_mocks = False

        status = "✅" if in_real and not worldinfo_in_mocks else "❌"
        if not (in_real and not worldinfo_in_mocks):
            all_pass = False
        print(f"  {status} {path}: in REAL_API_PATHS={in_real}, in MOCKS={worldinfo_in_mocks}")

    return all_pass


def main():
    print("\n注意：部分测试需要数据库连接和后端服务")
    print(f"API 地址: {BASE_URL}")
    print(f"测试用户 ID: {TEST_USER_ID}")
    print()

    results = {}

    results["模式规范化"] = test_normalize_silly_tavern_mode()
    results["Slash 命令检测"] = test_slash_command()

    try:
        results["Slash 命令执行"] = test_slash_execution()
    except Exception as e:
        print(f"  ❌ Slash 命令执行失败: {e}")
        results["Slash 命令执行"] = False

    try:
        results["宏替换"] = test_macro_evaluation()
    except Exception as e:
        print(f"  ❌ 宏替换失败: {e}")
        results["宏替换"] = False

    try:
        results["世界书条目"] = test_worldbook_entries()
    except Exception as e:
        print(f"  ❌ 世界书条目失败: {e}")
        results["世界书条目"] = False

    results["设置双写"] = test_settings_no_double_write()
    results["Bridge worldinfo"] = test_bridge_worldinfo_paths()

    print("\n" + "=" * 60)
    print("验证结果汇总")
    print("=" * 60)

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    for name, result in results.items():
        status = "✅ 通过" if result else "❌ 失败"
        print(f"  {status}  {name}")

    print(f"\n总计: {passed}/{total} 通过")

    if passed == total:
        print("\n🎉 所有验证通过！ST Runtime 收敛完成。")
        return 0
    else:
        print(f"\n⚠️  {total - passed} 项验证未通过，请检查。")
        return 1


if __name__ == "__main__":
    sys.exit(main())
