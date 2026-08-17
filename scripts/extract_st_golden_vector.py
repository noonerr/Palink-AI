"""ST 1.18.0 Golden Vector 提取脚本（spec 3.9 / tasks.md Task 0.3）。

本脚本编排 ST 1.18.0 真实浏览器输出的 golden vector 捕获流程。
ST 的 prompt 装配 100% 发生在浏览器端（public/scripts/openai.js PromptManager），
因此 golden vector 必须通过「真实 ST 浏览器实例 + 捕获服务器」获取，
不能用 Palink 自身预期当 golden（spec 第 4 节明确警告）。

工作流（每个场景）:
    1. 本脚本启动 st_capture_server.py（模拟 OpenAI 后端，监听指定端口）
    2. 打印该场景的 ST 1.18.0 配置步骤（人工在浏览器中操作）
    3. 人工在 ST 中: API 连接 → Custom (OpenAI-compatible) → 指向捕获服务器
       → 按场景配置角色/世界书/设置 → 触发一次生成
    4. 捕获服务器记录 ST 装配的完整 messages 数组
    5. 本脚本校验捕获结果并保存到 backend/tests/st_compat/golden_vectors/

契约对齐:
    场景 key 与 scripts/st-compat/prompt_golden/palink_golden_vector.py 的 FIXTURES key
    完全一致，输出文件名为 st_{name}.json，与 palink_{name}.json 自动配对，
    供 backend/tests/test_st_compat_golden_vector.py 自动发现与对比。

前置条件:
    - ST 1.18.0 已安装依赖（cd SillyTavern-1.18.0/SillyTavern-1.18.0 && npm install）
    - ST 已启动（npm start，默认 http://localhost:8000）

用法:
    python scripts/extract_st_golden_vector.py --scenario basic_char
    python scripts/extract_st_golden_vector.py --all          # 依次引导全部 5 场景
    python scripts/extract_st_golden_vector.py --list         # 列出场景及配置步骤
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_CAPTURE_SERVER = _REPO_ROOT / "scripts" / "st-compat" / "prompt_golden" / "st_capture_server.py"
_OUTPUT_DIR = _REPO_ROOT / "backend" / "tests" / "st_compat" / "golden_vectors"

# ---------------------------------------------------------------------------
# 场景定义：key 必须与 palink_golden_vector.py 的 FIXTURES key 完全一致，
# 以保证 st_{name}.json 与 palink_{name}.json 自动配对。
# 每个场景的 char_data 摘要自 palink FIXTURES，方便用户在 ST 中创建相同角色卡。
# ---------------------------------------------------------------------------
SCENARIOS: dict[str, dict] = {
    "basic_char": {
        "title": "单角色 + mes_example + 基本装配序验证",
        "port": 8901,
        "char_data": {
            "name": "GoldenTest_basic_char",
            "description": "A mysterious librarian named Elara who guards ancient tomes.",
            "personality": "Reserved, intellectual, secretly warm.",
            "scenario": "You visit the Grand Library seeking a forbidden book.",
            "first_mes": "*Elara looks up from her desk* \"Welcome to the Grand Library. How may I assist you today?\"",
            "mes_example": "<START>\n{{user}}: I'm looking for the Codex of Shadows.\n{{char}}: *Her eyes narrow* \"That tome is restricted. May I ask why you seek it?\"",
            "system_prompt": "",
            "post_history_instructions": "",
        },
        "st_setup": [
            "创建角色卡：name=GoldenTest_basic_char, description/personality/scenario/first_mes/mes_example 按上方 char_data 填写",
            "User Settings → Persona name 设为 GoldenUser",
            "Advanced Formatting → 确认 Context Template 为 Default（不使用自定义模板）",
            "确认 Power User → pin_examples=true（保留示例对话）",
            "发送消息 'The Codex of Shadows, I've heard it's here.' 触发生成",
        ],
        "verify_keywords": ["[Example Chat]", "[Start a new Chat]"],
        "verify_order": "main → charDescription → charPersonality → scenario → dialogueExamples → chatHistory",
    },
    "char_with_worldbook": {
        "title": "单角色 + 世界书 before(POS=0) 注入验证",
        "port": 8902,
        "char_data": {
            "name": "GoldenTest_char_with_worldbook",
            "description": "Captain Aria Stormwind, a sky pirate navigating the cloud seas.",
            "personality": "Bold, charismatic, reckless.",
            "scenario": "You've stowed away on Aria's airship, the Tempest.",
            "first_mes": "*Aria spots you hiding behind a barrel* \"Well, well... a stowaway. Give me one reason not to throw you overboard.\"",
            "mes_example": "",
            "system_prompt": "",
            "post_history_instructions": "",
        },
        "worldbook_entries": [
            {"keys": ["Tempest", "airship"], "content": "The Tempest is a legendary sky pirate vessel, powered by a captured storm elemental. It is the fastest ship in the cloud seas.", "position": 0, "constant": False, "order": 100},
            {"keys": ["cloud seas", "sky ocean"], "content": "The Cloud Seas are vast expanses of navigable atmosphere between floating islands. Ships sail on wind currents and storm streams.", "position": 0, "constant": False, "order": 90},
        ],
        "st_setup": [
            "创建角色卡：name=GoldenTest_char_with_worldbook，字段按上方 char_data 填写",
            "创建世界书 'Sky World Lore'，添加 2 个条目（position=Before Char, keys/content 按上方 worldbook_entries）",
            "将世界书绑定到角色卡",
            "User Settings → Persona name 设为 GoldenUser",
            "发送消息 'What's the fastest way to get to the Floating Isles?' 触发生成",
        ],
        "verify_keywords": ["Tempest", "Cloud Seas"],
        "verify_order": "main → worldInfoBefore → charDescription → charPersonality → scenario → chatHistory",
    },
    "worldbook_positions": {
        "title": "单角色 + 世界书 before/after/atDepth 多位置注入验证",
        "port": 8903,
        "char_data": {
            "name": "GoldenTest_worldbook_positions",
            "description": "A detective in a noir city.",
            "personality": "Cynical, observant.",
            "scenario": "You enter the detective's office.",
            "first_mes": "*The detective looks up* \"What brings you here?\"",
            "mes_example": "",
            "system_prompt": "",
            "post_history_instructions": "",
        },
        "worldbook_entries": [
            {"keys": ["detective", "office"], "content": "[BEFORE_CHAR] The detective's office is on the third floor of a rundown building. Neon signs flicker outside the window.", "position": 0, "constant": True, "order": 100},
            {"keys": ["warehouse", "district"], "content": "[AFTER_CHAR] The warehouse district is a dangerous area controlled by smugglers. Police rarely patrol there.", "position": 1, "constant": False, "order": 90},
            {"keys": ["cat", "Whiskers"], "content": "[AT_DEPTH] Whiskers is a rare silver tabby cat with a distinctive collar. She has been missing for three days.", "position": 4, "depth": 2, "constant": False, "order": 80},
        ],
        "st_setup": [
            "创建角色卡：name=GoldenTest_worldbook_positions，字段按上方 char_data 填写",
            "创建世界书 'Noir City Lore'，添加 3 个条目：",
            "  条目1: keys=[detective,office], position=Before Char(0), constant=true, order=100",
            "  条目2: keys=[warehouse,district], position=After Char(1), constant=false, order=90",
            "  条目3: keys=[cat,Whiskers], position=AT Depth(4), depth=2, constant=false, order=80",
            "将世界书绑定到角色卡",
            "User Settings → Persona name 设为 GoldenUser",
            "发送消息 'She was last seen near the old warehouse district.' 触发生成",
        ],
        "verify_keywords": ["BEFORE_CHAR", "AFTER_CHAR", "AT_DEPTH"],
        "verify_order": "main → worldInfoBefore → charDescription → charPersonality → scenario → worldInfoAfter → chatHistory(with depth entry)",
    },
    "char_with_instruct": {
        "title": "单角色 + instruct 模板 + post_history_instructions(jailbreak) 验证",
        "port": 8904,
        "char_data": {
            "name": "GoldenTest_char_with_instruct",
            "description": "A helpful AI assistant named Nova.",
            "personality": "Precise, efficient, slightly humorous.",
            "scenario": "User asks Nova for technical help.",
            "first_mes": "Hello! I'm Nova. How can I help you today?",
            "mes_example": "",
            "system_prompt": "You are Nova, a helpful AI assistant.",
            "post_history_instructions": "Remember to be concise and accurate.",
        },
        "st_setup": [
            "创建角色卡：name=GoldenTest_char_with_instruct，字段按上方 char_data 填写",
            "  注意：system_prompt 字段填入角色卡的 'Prompt' 字段（角色卡主提示词）",
            "  注意：post_history_instructions 字段填入角色卡的 'Post-history Instructions' 字段（角色卡 jailbreak 来源）",
            "User Settings → Persona name 设为 GoldenUser",
            "Advanced Formatting → 启用 Instruct Mode（无需配置具体模板，st-compat 路径不依赖 instruct 包装）",
            "确认 Power User → prefer_character_jailbreak=true（使用角色卡 PHI 作为 jailbreak）",
            "发送消息 'I checked the path but it still fails with ModuleNotFoundError.' 触发生成",
        ],
        "verify_keywords": ["You are Nova", "Remember to be concise"],
        "verify_order": "main(char system_prompt) → charDescription → charPersonality → scenario → chatHistory → jailbreak(PHI)",
    },
    "long_chat_truncation": {
        "title": "长对话（30 条）触发 token 预算裁剪验证",
        "port": 8905,
        "char_data": {
            "name": "GoldenTest_long_chat_truncation",
            "description": "A storyteller who narrates an epic fantasy.",
            "personality": "Dramatic, verbose.",
            "scenario": "An ongoing adventure story.",
            "first_mes": "The tale begins in a land far away...",
            "mes_example": "",
            "system_prompt": "",
            "post_history_instructions": "",
        },
        "chat_history_count": 30,
        "st_setup": [
            "创建角色卡：name=GoldenTest_long_chat_truncation，字段按上方 char_data 填写",
            "User Settings → Persona name 设为 GoldenUser",
            "Advanced Formatting → Max Context Tokens 设为 4096（触发裁剪）",
            "构造 30 条消息历史（user/assistant 交替，每条内容约 200 字符）",
            "  可用 ST 的 'Message Generation' 或手动发送 30 条消息",
            "发送消息触发生成（验证历史被裁剪到 token 预算内）",
        ],
        "verify_keywords": [],
        "verify_order": "main → charDescription → charPersonality → scenario → chatHistory(trimmed)",
    },
}


def _print_scenario_guide(name: str, sc: dict) -> None:
    print("\n" + "=" * 70)
    print(f"场景: {name} — {sc['title']}")
    print("=" * 70)
    print(f"捕获端口: {sc['port']}")
    print(f"输出文件: {_OUTPUT_DIR / f'st_{name}.json'}")
    if "char_data" in sc:
        print("\n角色卡数据（在 ST 中创建相同角色卡）:")
        for k, v in sc["char_data"].items():
            preview = str(v)[:80] + ("..." if len(str(v)) > 80 else "")
            print(f"  {k}: {preview}")
    if "worldbook_entries" in sc:
        print("\n世界书条目:")
        for i, entry in enumerate(sc["worldbook_entries"]):
            print(f"  [{i}] keys={entry['keys']}, position={entry['position']}, order={entry.get('order', 100)}")
    if "chat_history_count" in sc:
        print(f"\n聊天历史: {sc['chat_history_count']} 条消息")
    print("\nST 1.18.0 配置步骤（在浏览器中人工操作）:")
    for i, step in enumerate(sc["st_setup"], 1):
        print(f"  {i}. {step}")
    print(f"\nST API 连接配置:")
    print(f"  - API: Custom (OpenAI-compatible)")
    print(f"  - Server URL: http://localhost:{sc['port']}/v1")
    print(f"  - Model: capture-model")
    print(f"  - 勾选 Stream 或不勾选均可")
    if "verify_order" in sc:
        print(f"\n预期装配序: {sc['verify_order']}")


def _wait_for_capture(output_file: Path, timeout: int = 600) -> bool:
    """轮询等待捕获文件生成（人工在 ST 中触发生成）。"""
    print(f"\n等待 ST 触发生成并捕获... (超时 {timeout}s)")
    print(f"目标文件: {output_file}")
    start = time.time()
    while time.time() - start < timeout:
        if output_file.exists() and output_file.stat().st_size > 0:
            return True
        time.sleep(2)
    return False


def _validate_capture(output_file: Path, sc: dict, scenario_name: str) -> bool:
    """校验捕获的 golden vector 结构完整性。"""
    try:
        data = json.loads(output_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[FAIL] 无法解析捕获文件: {exc}")
        return False

    messages = data.get("messages")
    if not isinstance(messages, list) or not messages:
        print("[FAIL] 捕获文件缺少非空 messages 数组")
        return False

    # 补充元数据（spec checklist: scenario_name / st_version / extracted_at / messages）
    data.setdefault("scenario_name", scenario_name)
    data.setdefault("fixture", scenario_name)
    data.setdefault("st_version", "1.18.0")
    data.setdefault("extracted_at", data.get("timestamp", ""))
    output_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[OK] 捕获有效: {len(messages)} 条消息")
    keywords = sc.get("verify_keywords", [])
    if keywords:
        joined = json.dumps(messages, ensure_ascii=False)
        for kw in keywords:
            present = kw.lower() in joined.lower()
            print(f"  关键词 '{kw}': {'✓ 出现' if present else '⚠ 未出现（请确认场景配置）'}")
    return True


def run_scenario(name: str) -> bool:
    sc = SCENARIOS[name]
    _print_scenario_guide(name, sc)

    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # 契约对齐: 输出 st_{name}.json，与 palink_{name}.json 配对
    output_file = _OUTPUT_DIR / f"st_{name}.json"

    # 启动捕获服务器（子进程）
    print(f"\n启动捕获服务器 (port={sc['port']})...")
    proc = subprocess.Popen(
        [sys.executable, str(_CAPTURE_SERVER),
         "--port", str(sc["port"]),
         "--output", str(output_file),
         "--max-captures", "1"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    time.sleep(2)

    try:
        if not _wait_for_capture(output_file):
            print("[FAIL] 超时未捕获到 ST 输出")
            return False
        # 等待服务器写完
        time.sleep(1)
        return _validate_capture(output_file, sc, name)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def list_scenarios() -> None:
    print("可用场景（与 palink_golden_vector.py FIXTURES key 对齐）:\n")
    for name, sc in SCENARIOS.items():
        print(f"  {name}: {sc['title']}")
        print(f"    输出: st_{name}.json (配对 palink_{name}.json)")
        if "char_data" in sc:
            print(f"    角色: {sc['char_data']['name']}")
        print()


def main() -> None:
    parser = argparse.ArgumentParser(description="ST 1.18.0 golden vector 提取脚本")
    parser.add_argument("--scenario", choices=list(SCENARIOS.keys()), help="提取指定场景")
    parser.add_argument("--all", action="store_true", help="依次引导全部 5 场景")
    parser.add_argument("--list", action="store_true", help="列出场景及配置步骤")
    args = parser.parse_args()

    if not _CAPTURE_SERVER.exists():
        print(f"[FAIL] 捕获服务器不存在: {_CAPTURE_SERVER}")
        sys.exit(1)

    if args.list:
        list_scenarios()
        return

    if args.all:
        results = {}
        for name in SCENARIOS:
            results[name] = run_scenario(name)
        print("\n" + "=" * 70)
        print("提取结果汇总:")
        for name, ok in results.items():
            print(f"  st_{name}.json: {'✓ 成功' if ok else '✗ 失败/跳过'}")
        print(f"\n输出目录: {_OUTPUT_DIR}")
        print("\n下一步: 运行 pytest backend/tests/test_st_compat_golden_vector.py -v 进行对比")
    elif args.scenario:
        ok = run_scenario(args.scenario)
        sys.exit(0 if ok else 1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
