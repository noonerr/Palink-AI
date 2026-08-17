"""WorldBook / WorldBookStage 模型字段声明验证（migration 0040）。

确保 ``backend/app/models/worldbook.py`` 中的 SQLAlchemy 模型类声明了
migration 0040 引入的 6 个高级字段，构造对象并访问这些字段时不会抛
``AttributeError``。

覆盖字段：
- WorldBook.budget_tokens (String)
- WorldBook.budget_cap (Integer)
- WorldBookStage.min_activations (Integer)
- WorldBookStage.delay_until_recursion (Integer)
- WorldBookStage.triggers (Text)
- WorldBookStage.outlet_name (String)

该测试不依赖 DB session，仅验证 ORM 模型字段声明存在。
"""

import os
import sys

# 让 ``backend`` 目录可被导入（测试可位于 backend/tests/ 下独立运行）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from sqlalchemy import Integer, String, Text

from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402


# ---------------------------------------------------------------------------
# WorldBook 字段声明验证
# ---------------------------------------------------------------------------
class TestWorldBookAdvancedFields:
    """验证 WorldBook 类声明了 migration 0040 引入的 budget 字段。"""

    def test_budget_tokens_column_exists(self):
        """WorldBook.budget_tokens 应作为 SQLAlchemy Column 声明存在。"""
        assert hasattr(WorldBook, "budget_tokens")
        col = WorldBook.__table__.columns.get("budget_tokens")
        assert col is not None, "world_books.budget_tokens column missing"
        # migration 0040: sa.String()
        assert isinstance(col.type, String)

    def test_budget_cap_column_exists(self):
        """WorldBook.budget_cap 应作为 Integer Column 声明存在。"""
        assert hasattr(WorldBook, "budget_cap")
        col = WorldBook.__table__.columns.get("budget_cap")
        assert col is not None, "world_books.budget_cap column missing"
        assert isinstance(col.type, Integer)

    def test_construct_worldbook_with_budget_fields(self):
        """构造启用 budget_tokens / budget_cap 的 WorldBook 对象不应抛 AttributeError。"""
        wb = WorldBook(
            name="budget-test-worldbook",
            budget_tokens="10%",
            budget_cap=500,
        )
        # 访问字段不应抛 AttributeError
        assert wb.budget_tokens == "10%"
        assert wb.budget_cap == 500

    def test_construct_worldbook_without_budget_fields(self):
        """未显式赋值时，budget 字段应为 None（未应用 Python default）。

        migration 0040 仅设置了 server_default，未在 Column 上声明 Python
        端 default；构造未赋值对象时字段值应为 None。
        """
        wb = WorldBook(name="no-budget-worldbook")
        # budget_tokens 没有 Python default
        assert wb.budget_tokens is None
        # budget_cap 在 model 上声明了 default=0，但 Python default 仅在
        # flush/commit 时才应用；构造后未触发默认值时仍为 None。
        # 这里只验证字段可访问（无 AttributeError），不强制具体值。
        _ = wb.budget_cap


# ---------------------------------------------------------------------------
# WorldBookStage 字段声明验证
# ---------------------------------------------------------------------------
class TestWorldBookStageAdvancedFields:
    """验证 WorldBookStage 类声明了 migration 0040 引入的 4 个高级字段。"""

    def test_min_activations_column_exists(self):
        """WorldBookStage.min_activations 应作为 Integer Column 声明存在。"""
        assert hasattr(WorldBookStage, "min_activations")
        col = WorldBookStage.__table__.columns.get("min_activations")
        assert col is not None, "world_book_stages.min_activations column missing"
        assert isinstance(col.type, Integer)

    def test_delay_until_recursion_column_exists(self):
        """WorldBookStage.delay_until_recursion 应作为 Integer Column 声明存在。"""
        assert hasattr(WorldBookStage, "delay_until_recursion")
        col = WorldBookStage.__table__.columns.get("delay_until_recursion")
        assert col is not None, "world_book_stages.delay_until_recursion column missing"
        assert isinstance(col.type, Integer)

    def test_triggers_column_exists(self):
        """WorldBookStage.triggers 应作为 Text Column 声明存在。"""
        assert hasattr(WorldBookStage, "triggers")
        col = WorldBookStage.__table__.columns.get("triggers")
        assert col is not None, "world_book_stages.triggers column missing"
        assert isinstance(col.type, Text)

    def test_outlet_name_column_exists(self):
        """WorldBookStage.outlet_name 应作为 String Column 声明存在。"""
        assert hasattr(WorldBookStage, "outlet_name")
        col = WorldBookStage.__table__.columns.get("outlet_name")
        assert col is not None, "world_book_stages.outlet_name column missing"
        assert isinstance(col.type, String)

    def test_construct_stage_with_all_advanced_fields(self):
        """构造启用全部 4 个高级字段的 WorldBookStage 对象不应抛 AttributeError。"""
        stage = WorldBookStage(
            content="Advanced stage content",
            min_activations=2,
            delay_until_recursion=3,
            triggers='["to_title"]',
            outlet_name="lore_box",
        )
        # 逐一访问字段，验证无 AttributeError
        assert stage.min_activations == 2
        assert stage.delay_until_recursion == 3
        assert stage.triggers == '["to_title"]'
        assert stage.outlet_name == "lore_box"

    def test_construct_stage_without_advanced_fields(self):
        """未显式赋值时，构造 WorldBookStage 不应抛 AttributeError。"""
        stage = WorldBookStage(content="minimal stage")
        # 仅验证字段可访问，不强制具体值（Python default 在 flush 时才应用）
        _ = stage.min_activations
        _ = stage.delay_until_recursion
        _ = stage.triggers
        _ = stage.outlet_name


# ---------------------------------------------------------------------------
# 综合场景：WorldBook + 多个 WorldBookStage
# ---------------------------------------------------------------------------
class TestWorldBookWithAdvancedStages:
    """验证 WorldBook 关联多个启用高级字段的 WorldBookStage 时无 AttributeError。"""

    def test_full_advanced_worldbook_construction(self):
        """综合场景：构造带 budget 的 WorldBook 与多个高级 stage。"""
        wb = WorldBook(
            name="full-advanced-worldbook",
            budget_tokens="15%",
            budget_cap=2000,
        )

        stages = [
            WorldBookStage(
                world_book_id=wb.id,
                stage_index=0,
                content="Stage with min_activations",
                min_activations=3,
                group="minact-group",
            ),
            WorldBookStage(
                world_book_id=wb.id,
                stage_index=1,
                content="Stage with delay_until_recursion",
                delay_until_recursion=2,
            ),
            WorldBookStage(
                world_book_id=wb.id,
                stage_index=2,
                content="Stage with triggers",
                triggers='["to_title","to_summary"]',
            ),
            WorldBookStage(
                world_book_id=wb.id,
                stage_index=3,
                content="Stage with outlet_name",
                outlet_name="custom_outlet",
                position=7,  # WI_POS_OUTLET
            ),
        ]

        # 验证 budget 字段
        assert wb.budget_tokens == "15%"
        assert wb.budget_cap == 2000

        # 验证每个 stage 的目标字段可访问且值正确
        assert stages[0].min_activations == 3
        assert stages[1].delay_until_recursion == 2
        assert stages[2].triggers == '["to_title","to_summary"]'
        assert stages[3].outlet_name == "custom_outlet"

        # 验证其他高级字段也可访问（未显式赋值，不抛 AttributeError）
        for stage in stages:
            _ = stage.min_activations
            _ = stage.delay_until_recursion
            _ = stage.triggers
            _ = stage.outlet_name
