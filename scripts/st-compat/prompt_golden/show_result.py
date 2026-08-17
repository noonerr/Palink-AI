import json, sys
path = sys.argv[1] if len(sys.argv) > 1 else "scripts/st-compat/prompt_golden/results/palink_st_compat_basic.json"
d = json.load(open(path, "r", encoding="utf-8"))
msgs = d["messages"]
print(f"Total messages: {len(msgs)}")
for i, m in enumerate(msgs):
    content = m.get("content", "")
    if isinstance(content, list):
        content = str(content[0])
    preview = content[:100].replace("\n", "\\n")
    print(f"  [{i}] role={m['role']:10s} | {preview}")
print(f"\nReport: {[(r['key'], r['status']) for r in d.get('report', [])]}")
