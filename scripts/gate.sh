#!/usr/bin/env bash
# 本地一把梭门禁 —— Palink-AI
#
# 【为什么需要它】
# 2026-10-10 审计：项目没有 CI，门禁靠手工敲三条命令 + 人眼读 passed 数字。
# 结果是 backend/pytest_gate3.log 带着 `84 errors` 被当成通过存档。
# 实测 pytest 在 `1 passed, 1 error` 时退出码 = 1 —— 工具一直在报警，是人没看。
#
# 本脚本唯一的目的：**把退出码变成你无法忽略的东西。**
# 任一阶段非 0 → 脚本以 1 退出 → 你（和 CI）无法假装它是绿的。
#
# 【用法】
#   bash scripts/gate.sh            # 全跑
#   bash scripts/gate.sh backend    # 只跑后端
#   bash scripts/gate.sh frontend   # 只跑前端
#   bash scripts/gate.sh docs       # 只校验文档目录
#
# 【本机环境坑（照抄自运维手册，别改）】
#   - Python 解释器自动探测（见 pick_python）：Windows 上通常是 `py -3`，
#     Linux/macOS 上是 `python3`。**不要写死** —— 写死会让这个脚本在非 Windows 上直接失效。
#   - 全量跑时若命中安全删除守卫，本脚本会**直接告诉你**，不会再让你对着
#     “84 errors” 猜。判定见 run_stage 里的 SAFE_DELETE 检测。
#
# 【2026-10-10 已定位的根因（不要再猜一次）】
#   backend/pytest_gate3.log 的 84 errors 不是代码问题：
#     1. 有人把 pytest 的 basetemp 指到了仓库内（backend/.pytest_tmp）；
#     2. 清理时一次性删 58 个文件，撞上环境的安全删除守卫（阈值 50/轮）
#        → 抛 SystemExit: 1；
#     3. 临时目录被删到一半，后续 83 个用例在 setup 阶段连带 AssertionError。
#   所以：**basetemp 必须落在仓库外**，本脚本用系统默认 temp（不传 --basetemp）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

SCOPE="${1:-all}"

# ---------------------------------------------------------------------------
# 解释器探测：挑第一个能 import pytest 的
# ---------------------------------------------------------------------------
pick_python() {
  local cand
  for cand in "py -3" "python3" "python"; do
    if $cand -c "import pytest" >/dev/null 2>&1; then
      echo "$cand"
      return 0
    fi
  done
  echo ""
}

PY="$(pick_python)"
if [ -z "$PY" ]; then
  echo "找不到可用的 Python（要求能 import pytest）。装一个再跑：pip install pytest"
  exit 1
fi

LOGDIR="${TMPDIR:-/tmp}/palink-gate"
mkdir -p "$LOGDIR" 2>/dev/null || LOGDIR="$ROOT/.gate-logs"
mkdir -p "$LOGDIR" 2>/dev/null

FAILED=0
SUMMARY=()

run_stage() {
  local name="$1"; shift
  local slug="$1"; shift
  local log="$LOGDIR/$slug.log"
  echo ""
  echo "────────────────────────────────────────────────────────"
  echo "  ▶ $name"
  echo "────────────────────────────────────────────────────────"
  "$@" 2>&1 | tee "$log"
  local code="${PIPESTATUS[0]}"
  if [ "$code" -ne 0 ]; then
    FAILED=1
    SUMMARY+=("✗ $name（退出码 $code）")
    echo ""
    echo "  ✗ $name 失败（退出码 $code）  完整日志：$log"
  else
    SUMMARY+=("✓ $name")
    echo ""
    echo "  ✓ $name 通过"
  fi
  return 0
}

# 环境守卫误伤检测：命中就直说，别让人对着一片 error 猜根因
diagnose_env_guard() {
  local log="$1"
  if grep -q "SAFE_DELETE_BULK_CONFIRM_REQUIRED\|safe-delete" "$log" 2>/dev/null; then
    echo ""
    echo "  ⚠️⚠️ 检测到环境安全删除守卫拦截，本次失败大概率**不是代码回归** ⚠️⚠️"
    grep -m2 "safe-delete" "$log"
    echo "  处理：这是按轮次计数的守卫（阈值见上面的 count/threshold）。"
    echo "       开一个新会话/新一轮再跑，或确认 basetemp 不在仓库内（见本文件头部注释）。"
    echo "       不要为了让门禁变绿而去改测试或加 || true。"
  fi
}

# junitxml 交叉判读：即使 pytest 被环境守卫杀在收尾阶段（退出码非 0），
# 只要 xml 已经落地，就能读出**真实**的 failures/errors。
# 目的不是把红洗绿 —— 退出码仍然照实返回 —— 而是让人一眼看出
# 「红的是环境，还是代码」，避免对着一片红猜根因（2026-10-10 血的教训）。
diagnose_junit() {
  local xml="$1"
  [ -f "$xml" ] || return 0
  local f e
  f="$(sed -n 's/.*failures="\([0-9]*\)".*/\1/p' "$xml" | head -1)"
  e="$(sed -n 's/.*errors="\([0-9]*\)".*/\1/p' "$xml" | head -1)"
  if [ "$f" = "0" ] && [ "$e" = "0" ]; then
    echo ""
    echo "  ℹ️ junitxml 显示 failures=0 errors=0 —— 若上面是红的，那是环境拦截，不是代码回归。"
  else
    echo ""
    echo "  ‼️ junitxml 显示 failures=$f errors=$e —— 这是**真实失败**，按回归处理。"
  fi
}

should_run() {
  [ "$SCOPE" = "all" ] || [ "$SCOPE" = "$1" ]
}

if should_run backend; then
  # 仓库内残留的 .pytest_tmp 是上面那个根因的复发病灶，先预警
  if [ -d "$ROOT/backend/.pytest_tmp" ]; then
    echo "  ⚠️ 发现 backend/.pytest_tmp（仓库内临时目录残留）—— 这是 84 errors 的病灶，"
    echo "     确认无人使用后请删除，且永远不要把 --basetemp 指进仓库内。"
  fi
  # [2026-10-10 修复] ⚠️ 旧注释「实测一次全量只产生 17 个临时子目录，远低于守卫阈值 50」
  # **这个判断是错的**，别照它推理：
  #   它统计的是「本次产生」的目录数，而触发守卫的是「**清理历史累积**」的文件数
  #   —— pytest 会 garbage-collect 旧的 basetemp 代，历史越积越多，
  #   实测一次清理命中 59 个文件 > 阈值 50，抛 SystemExit，pytest 连汇总行都没打印。
  # 修法（治本）：每轮给一个**全新的空 temproot** ⇒ 不存在历史 basetemp
  #   ⇒ garbage 收集无从发生 ⇒ 守卫永不命中。
  # 目录仍在 LOGDIR（系统 temp，仓库外）下，不违反「basetemp 不得指进仓库内」的约定。
  # 不加 || true、不加 --continue-on-collection-errors（见本文件头部红线）。
  STAMP="$(date +%Y%m%d-%H%M%S)-$$"
  BTROOT="$LOGDIR/pytest-bt-$STAMP"
  mkdir -p "$BTROOT"
  run_stage "后端 pytest" backend bash -c 'cd "'"$ROOT"'/backend" && PYTEST_DEBUG_TEMPROOT="'"$BTROOT"'" '"$PY"' -m pytest tests/ -q --junitxml="'"$BTROOT"'/junit.xml"'
  diagnose_env_guard "$LOGDIR/backend.log"
  diagnose_junit "$BTROOT/junit.xml"
fi

if should_run frontend; then
  run_stage "前端 tsc --noEmit" frontend-tsc bash -c 'cd "'"$ROOT"'/frontend" && npx tsc --noEmit'
  run_stage "前端 vitest" frontend-vitest bash -c 'cd "'"$ROOT"'/frontend" && npx vitest run'
fi

if should_run docs; then
  # [2026-10-11 修复] 这里原先写死 `python`，而本文件头部的 pick_python 注释明确说过"不要写死"。
  # Windows 上 `python`/`python3` 常常是 Microsoft Store 的**应用执行别名空壳**：
  #   它不报 "command not found"（那是 127），而是**零输出 + 退出码 49**。
  # 后果有两层：
  #   ① docs 段恒红 ⇒ 整个 `bash scripts/gate.sh`（不带参数）在本机**从来没绿过**；
  #   ② 因为空壳一个字都不打印，$LOGDIR/docs.log 是**空文件** ⇒ 连"为什么红"都查不到。
  # 恒红的门禁等于没有门禁：真回归混在恒定红里分不出来。
  # 修法与上面 backend 段同源：复用已探测出的 "$PY"，并用 bash -c 承载（$PY 含空格，
  # 直接 "$PY" 会被当成一个带空格的命令名）。
  run_stage "文档目录一致性" docs bash -c 'cd "'"$ROOT"'" && '"$PY"' scripts/docs/gen_docs_catalog.py --check'

  # [2026-10-15 新增] docs 里 390+ 处 `上游文件:行号` 引用的可复核性校验。
  # 这些引用支撑过世界书 position 偏移 1、{{jailbreak}} 宏缺失等 P0 修复，是本项目
  # ST 兼容准确性的实际来源；校验器会确认它们指向的上游文件与行号仍然成立。
  # ⚠️ 它依赖 `_reference/sillytavern-1.18.0/`，而该目录**不入库**（.gitignore，机器本地）。
  #    所以缺失时**跳过而不是失败** —— 否则门禁会因环境原因恒红，
  #    与上面「恒红的门禁等于没有门禁」这条教训直接冲突。缺失只提示怎么锚定。
  if [ -d "$ROOT/_reference/sillytavern-1.18.0" ]; then
    run_stage "ST 上游引用可复核" citations bash -c 'cd "'"$ROOT"'" && '"$PY"' scripts/check_st_citations.py'
  else
    echo "  ⏭️  跳过「ST 上游引用可复核」：_reference/sillytavern-1.18.0 不存在。"
    echo "      该目录不入库（换机器即失效），锚定方法见 docs/REFERENCE_ST上游锚定_2026-10-15.md"
  fi
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "  门禁汇总"
echo "════════════════════════════════════════════════════════"
for line in "${SUMMARY[@]}"; do
  echo "  $line"
done
echo "════════════════════════════════════════════════════════"

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "  门禁失败。修完再提交 —— 别把红当成绿。"
  exit 1
fi

echo ""
echo "  全部门禁通过。"
exit 0
