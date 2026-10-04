"""把 stat_data 按卡片 schema 的**形状**归一化（2026-10-05）。

## 为什么需要它

卡片的 zod schema 定义了变量的树形（例：`露缇雅.状态.爱意`），但
`mvu_engine.apply_patches` 对模型给的 JSON Patch 是**逐条照做**：
`_pointer_set` 会为不存在的中间路径凭空创建对象，且**不做任何类型检查**。

于是模型一旦发出「扁平」结构的补丁（例如把 `状态` 写成一段文本、
把 `爱意/魔力值` 提到 `露缇雅` 下当兄弟键），错误结构就**永久落库** ——
卡的状态栏按 `stat_data.露缇雅.状态.爱意` 取值，穿不过一个字符串 → 回落默认值。

**ST 的 MVU 不会有这个问题**：它在应用命令后会跑卡片注册的 zod schema，
`prefault` / `transform` / `clamp` 会把结构修回来。本模块就是把那一层语义
在 Python 侧补上（复用 `mvu_engine.extract_schema_defaults` 已解析出的骨架）。

## 修复策略（最小干预，非破坏）

对每个「schema 说是对象、而数据里不是对象」的字段：

1. **搬回来**：把被错误提到**父层**的同名子键挪回该对象内部；
2. **归档**：若数据里该字段原本是个非空字符串（模型把对象写成了文本），
   把它存进 `_漂移前文本` —— 下划线前缀的键被 `_flatten_stat_data` 跳过、
   被 `apply_patches` 的只读前缀挡住、卡片也不会读，是**零干扰的存档位**。
   **不丢弃**任何原有信息；
3. **补缺**：schema 有、数据没有的子键，用骨架里的 prefault 补上
   （与 ST 的 zod 行为一致），并在日志里标为 `filled`，便于区分「真实值」与「合成值」。

递归处理嵌套对象字段（如 `环境.时间`、`魅魔特征.性经验`）。
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List, Tuple

ARCHIVE_KEY = "_漂移前文本"


def _is_schema_object(v: Any) -> bool:
    """schema 骨架里该字段是不是「对象」（而非叶子）。

    `extract_schema_defaults` 对 z.object 返回嵌套 dict；对 string/number 等
    返回标量。空 dict 也视为对象（z.object 无子字段的情况）。
    """
    return isinstance(v, dict)


def _normalize_object(
    data: Any,
    skeleton: Dict[str, Any],
    path: str,
    log: List[str],
) -> Dict[str, Any]:
    """把 *data* 对齐成 *skeleton* 描述的对象形状，返回新 dict。"""
    out: Dict[str, Any] = dict(data) if isinstance(data, dict) else {}

    for field, sub_skeleton in skeleton.items():
        field_path = f"{path}.{field}" if path else field

        if not _is_schema_object(sub_skeleton):
            # 叶子字段：数据有就用数据的，没有就补 schema 的 prefault
            if field not in out:
                out[field] = copy.deepcopy(sub_skeleton)
                log.append(f"filled {field_path} = {sub_skeleton!r}")
            continue

        cur = out.get(field)

        if not isinstance(cur, dict):
            # ★ 漂移：schema 要对象，数据不是对象
            rescued: Dict[str, Any] = {}
            # ① 把被提到**本层**的同名子键搬回来
            for sub in list(skeleton[field].keys()):
                if sub in out and isinstance(out[sub], dict):
                    # 子键本身也是对象 → 交给递归处理，别在这里搬
                    continue
                if sub in out:
                    rescued[sub] = out.pop(sub)
                    log.append(f"moved {path}.{sub} -> {field_path}.{sub}")

            if isinstance(cur, str) and cur.strip():
                rescued[ARCHIVE_KEY] = cur
                log.append(f"archived {field_path} (was text) -> {field_path}.{ARCHIVE_KEY}")

            out[field] = _normalize_object(rescued, skeleton[field], field_path, log)
            continue

        # 已是对象：递归对齐子层
        out[field] = _normalize_object(cur, sub_skeleton, field_path, log)

    return out


def normalize_stat_data(
    stat_data: Any,
    skeleton: Dict[str, Any],
) -> Tuple[Dict[str, Any], List[str]]:
    """把 stat_data（不含外层 "stat_data" 包裹）按骨架形状归一化。

    返回 ``(新 stat_data, 变更日志)``。骨架为空/非法时**原样返回**并给出一条说明，
    绝不因为解析不出 schema 就把用户数据改坏。
    """
    if not isinstance(stat_data, dict):
        return {}, ["skip: stat_data 不是 dict"]
    if not isinstance(skeleton, dict) or not skeleton:
        return copy.deepcopy(stat_data), ["skip: 没有可用的 schema 骨架（不做任何改动）"]

    log: List[str] = []
    return _normalize_object(stat_data, skeleton, "", log), log


def normalize_variables(
    variables: Any,
    skeleton: Dict[str, Any],
) -> Tuple[Dict[str, Any], List[str]]:
    """对 ``chat_metadata.variables`` 这种「外层包一层 stat_data」的结构做归一化。"""
    if not isinstance(variables, dict):
        return {}, ["skip: variables 不是 dict"]
    out = copy.deepcopy(variables)
    if "stat_data" not in out:
        return out, ["skip: variables 里没有 stat_data"]
    new_stat, log = normalize_stat_data(out["stat_data"], skeleton)
    out["stat_data"] = new_stat
    return out, log
