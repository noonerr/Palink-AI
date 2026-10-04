"""兜底分支的离线实证：给一个「卡片未声明 MVU 规范」的装配结果，
确认装配会注入不含任何具体字段名的通用模板（不花钱、不落库）。

用法：把本脚本 docker cp 进后端容器后执行。
    docker cp backend/scripts/_verify_fallback_offline.py palink-ai-backend-1:/tmp/_f.py
    MSYS_NO_PATHCONV=1 docker exec -e PYTHONPATH=/app palink-ai-backend-1 \
        sh -c 'cd /app && python /tmp/_f.py'
"""

import re
import sys

sys.path.insert(0, "/app")
from app.services.roleplay_prompt_assembly import (  # noqa: E402
    _MVU_GENERIC_TAIL,
    _messages_declare_mvu_update_spec,
)

FORBIDDEN = ["桃汐", "世界信息", "好感度", "性欲值", "发情期", "内心想法", "服饰"]

# 场景 A：装配结果里没有变量协议声明 → 判据须为 False（才会走注入兜底）
no_decl = [
    {"role": "system", "content": "主提示词"},
    {"role": "user", "content": "玩家输入"},
    {"role": "assistant", "content": "历史回复"},
]
# 场景 B：有卡片自己声明的格式规范 → 判据须为 True（不注入）
declared = [
    {"role": "system", "content": "主提示词"},
    {"role": "system", "content":
        "变量输出格式: rule: output the update commands at the end of the reply; "
        "the commands work like the **JSON Patch (RFC 6902)** standard; "
        "wrap them in <UpdateVariable>"},
]

print("A_detects_spec=", _messages_declare_mvu_update_spec(no_decl), "(期望 False)")
print("B_detects_spec=", _messages_declare_mvu_update_spec(declared), "(期望 True)")

hits = [w for w in FORBIDDEN if w in _MVU_GENERIC_TAIL]
print("FORBIDDEN_HITS=", hits, "(期望 [])")
print("TAIL_LEN=", len(_MVU_GENERIC_TAIL))
print("HAS_NEW_TOPLEVEL_RULE=", "禁止新建顶层分组" in _MVU_GENERIC_TAIL)
print("HAS_NO_OBJECT_REPLACE_RULE=", "禁止整体替换成一句话字符串" in _MVU_GENERIC_TAIL)
# 模板里不应出现任何形如 /具体名字/字段 的示例路径（占位式 /分组/字段 允许）
paths = re.findall(r'"path"\s*:\s*"([^"]+)"', _MVU_GENERIC_TAIL)
print("EXAMPLE_PATHS=", paths)
_segments = [s for p in paths for s in p.strip("/").split("/") if s]
print("ALL_PLACEHOLDER=", bool(paths) and all(
    s in {"分组", "字段"} for s in _segments
))