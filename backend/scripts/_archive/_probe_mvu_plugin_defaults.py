# -*- coding: utf-8 -*-
"""只读探针：从 MVU 插件 bundle 里核出「自动清理」相关设置项的**真实默认值**。

用途：P3-e 拍板依据 —— 用户要求「与 ST 保持一致」，所以必须拿到插件侧的实际默认，
而不是沿用我们 mvu_cleanup.py:46-49 里自己写的 True / 20。

只读，不改任何业务代码。运行：py -3 backend/scripts/_probe_mvu_plugin_defaults.py
"""
import re
import sys
from pathlib import Path

BUNDLE = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "smart_card_assets"
    / "0c646fb31a8cd5610d22ccd26323258a430f83a09e6a0a09596b2b1875eabac2.js"
)

# 插件面板里与清理相关的文案关键词（中文原文来自 bundle 的 i18n 字典）
KEYWORDS = [
    "自动清理",
    "清理策略",
    "快照保留间隔",
    "最近楼层数",
    "触发恢复",
]


def main() -> int:
    if not BUNDLE.exists():
        print(f"bundle not found: {BUNDLE}")
        return 1
    src = BUNDLE.read_text(encoding="utf-8", errors="replace")
    print(f"bundle: {BUNDLE.name}  bytes={len(src)}")

    # ① i18n 字典里含关键词的条目
    print("\n=== ① i18n 文案条目（panel.* 含清理关键词）===")
    pat = re.compile(
        r"'(panel\.[A-Za-z0-9_.]+)':\{'zh-CN':'((?:[^'\\]|\\.)*)'(?:,|\})"
    )
    hits = [(k, zh) for k, zh in pat.findall(src) if any(w in zh for w in KEYWORDS)]
    for k, zh in hits:
        print(f"  {k}\n      {zh}")
    if not hits:
        print("  (无命中)")

    # ② 真正带默认值的设置模型：形如 { 默认值: N } / default: N / 缺省: N
    #    插件用 make_boolean_model / make_number_model 等构造，默认值写在调用实参里。
    print("\n=== ② 可能的默认值构造点（number/boolean model 调用）===")
    for m in re.finditer(r"make_(number|boolean|text)_model\(([^\n]{0,200})", src):
        seg = m.group(2)
        if any(w in seg for w in ["清理", "楼层", "快照", "间隔"]):
            print(f"  [{m.group(1)}] {seg[:180]}")

    # ③ 直接搜数字上下文：清理相关键名附近出现的整数
    print("\n=== ③ 清理相关键名附近的整数字面量 ===")
    for kw in KEYWORDS:
        for m in re.finditer(re.escape(kw), src):
            start = max(0, m.start() - 120)
            end = min(len(src), m.end() + 120)
            ctx = src[start:end].replace("\n", " ")
            nums = re.findall(r"(?<![\w.])\d{1,4}(?![\w.])", ctx)
            if nums:
                print(f"  [{kw}] ...{ctx[60:200]}...  → nums={nums}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
