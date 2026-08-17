"""检查 golden vector 文件的 messages 结构。"""
import json
import sys
from pathlib import Path


def inspect(path: str):
    with open(path, "r", encoding="utf-8") as f:
        d = json.load(f)
    msgs = d.get("messages", [])
    fixture = d.get("fixture", "?")
    source = d.get("source", "?")
    print(f"=== {Path(path).name} (fixture={fixture}, source={source}) ===")
    print(f"Total messages: {len(msgs)}")
    for i, m in enumerate(msgs):
        role = m.get("role", "?")
        content = m.get("content", "")
        if isinstance(content, list):
            # 多模态 content
            text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
            content = "\\n".join(text_parts)
        content_str = str(content).replace("\n", "\\n")[:150]
        print(f"  [{i}] role={role} content={content_str}")
    print()


def main():
    if len(sys.argv) < 2:
        # 默认检查目录下所有 golden vector
        dir_path = Path("/app/tests/st_compat/golden_vectors")
        if not dir_path.exists():
            dir_path = Path("d:/项目/Palink-AI/backend/tests/st_compat/golden_vectors")
        for p in sorted(dir_path.glob("*.json")):
            inspect(str(p))
    else:
        for path in sys.argv[1:]:
            inspect(path)


if __name__ == "__main__":
    main()
