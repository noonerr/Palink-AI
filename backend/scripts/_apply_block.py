import io

SRC = r"D:\项目\Palink-AI\backend\app\services\roleplay_prompt_assembly.py"
NEW = r"D:\项目\Palink-AI\backend\scripts\_new_block.py"

lines = io.open(SRC, encoding="utf-8").read().split("\n")
# 1-indexed 4809..4917 inclusive -> 0-indexed 4808..4916
start, end = 4808, 4916
print("REPLACING first line :", repr(lines[start]))
print("REPLACING last  line :", repr(lines[end]))
assert lines[start].strip() == "if wb_result.text:", lines[start]
assert lines[end].strip().startswith('report.append(PromptAssemblyReportItem("worldbook", "skipped"'), lines[end]

new_block = io.open(NEW, encoding="utf-8").read().rstrip("\n").split("\n")
out = lines[:start] + new_block + lines[end + 1:]
io.open(SRC, "w", encoding="utf-8", newline="").write("\n".join(out))
print("OK: replaced", end - start + 1, "lines with", len(new_block), "lines")
print("next line after block:", repr(lines[end + 1]))