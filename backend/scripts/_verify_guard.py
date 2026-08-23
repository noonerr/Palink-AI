"""验证副 AI 守卫：有 schema 介入，无 schema 不介入（不乱输出）。"""
import asyncio
import sys

sys.path.insert(0, "/app")

from app.services.mvu_secondary import run_secondary_mvu

STORY = "桃汐穿着浅蓝色连衣裙，开心地拉着我去甜品屋。"


async def main() -> None:
    # 场景 1：有 schema + 有 stat_data → 副 AI 介入
    schema = {"世界信息": {"日期时间": "", "天气": ""}, "桃汐": {"好感度": 50, "服饰": ""}}
    stat = {"stat_data": {"世界信息": {"日期时间": "", "天气": ""}, "桃汐": {"好感度": 50, "服饰": ""}}}
    p1, _ = await run_secondary_mvu("deepseek-v4-flash", stat, STORY, schema)
    print(f"[场景1 有schema] patches={len(p1)} -> {'介入' if p1 else '未介入'}")

    # 场景 2：无 schema + 无 stat_data → 副 AI 不介入（不乱输出）
    p2, _ = await run_secondary_mvu("deepseek-v4-flash", {"stat_data": {}}, STORY, {})
    print(f"[场景2 无schema无stat] patches={len(p2)} -> {'介入(异常!)' if p2 else '不介入(正确)'}")

    # 场景 3：无 schema 但有 stat_data（<initvar> 来源）→ 副 AI 介入（有变量系统）
    stat3 = {"stat_data": {"桃汐": {"好感度": 50}}}
    p3, _ = await run_secondary_mvu("deepseek-v4-flash", stat3, STORY, {})
    print(f"[场景3 无schema有stat] patches={len(p3)} -> {'介入' if p3 else '未介入'}")

    # 断言
    assert p2 == [], "场景2 应不介入（无变量系统卡不能乱输出）"
    print("\n[PASS] 守卫生效：无变量系统的卡副 AI 不介入")


asyncio.run(main())
