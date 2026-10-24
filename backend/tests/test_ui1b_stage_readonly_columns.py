"""UI-1b 回归锁：WorldBookStage 高级列的**只读**暴露（2026-10-25）。

出处 docs/_active/report/REPORT_ST设置前端可达性盘点_2026-10-21.md D 段：
`_stage_to_response` 是一张逐字段手抄的白名单，模型 52 列里 30 个高级列
（+created_at 共 31 个）既没进响应也没进 `WorldBookStageResponse`
⇒ 前端**连读都读不到**，补控件也就无从谈起。

本批只开放读：写通道（`WorldBookStageUpdate` / update_stage 处理函数）一字未动，
所以这些值目前只能由库里已有数据带出来。"写通道零变化"由
test_write_channel_does_not_accept_advanced_columns 钉住。

运行: cd backend && py -3 -m pytest tests/test_ui1b_stage_readonly_columns.py -q
"""

import json
import os
import re
import sys
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.api.worldbook import _stage_to_response  # noqa: E402
from app.models import Character, WorldBook, WorldBookStage  # noqa: E402
from app.schemas.worldbook import WorldBookStageResponse, WorldBookStageUpdate  # noqa: E402

MODEL_COLUMNS = [c.key for c in WorldBookStage.__table__.columns]

# 盘点表里点名的"高级列"（不含 created_at 这类元数据）
ADVANCED_COLUMNS = [
    "enabled", "case_sensitive", "match_whole_words", "selective_logic",
    "sticky", "cooldown", "delay", "depth", "order", "exclude_recursion",
    "prevent_recursion", "match_persona_description", "match_character_description",
    "match_character_personality", "match_character_depth_prompt", "match_scenario",
    "match_creator_notes", "group_override", "group_weight", "add_memo",
    "decorators", "character_filter", "min_activations", "delay_until_recursion",
    "triggers", "outlet_name", "ignore_budget", "role", "use_group_scoring",
    "automation_id",
]


def _make_book(db, user, stages=None):
    wb = WorldBook(
        id=f"ui1wb-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name="UI1b 世界书",
        description="",
    )
    db.add(wb)
    db.flush()
    out = []
    for i, kwargs in enumerate(stages or [{}]):
        st = WorldBookStage(
            id=f"ui1st-{uuid.uuid4().hex[:8]}",
            world_book_id=wb.id,
            stage_index=i,
            title=f"T{i}",
            content=f"C{i}",
            priority=0,
            token_count=0,
            **kwargs
        )
        db.add(st)
        out.append(st)
    db.commit()
    for st in out:
        db.refresh(st)
    return wb, out


class TestCompleteness:
    def test_every_model_column_is_exposed(self):
        """白名单完整性：模型有一列、响应就该有一键。

        这条刻意写成"完整性"而不是"逐个点名"——因为病灶从来不是漏了哪一个，
        而是**加列时没人想起要补白名单**（SPEC §11 A 那次漏 vectorized 是同一
        机制的既往病例：响应不带该字段 ⇒ 前端拿不到勾选状态，保存即丢）。
        以后再加列，本用例会红，逼人来补读侧。
        """
        body = open(
            os.path.join(_BACKEND_DIR, "app", "api", "worldbook.py"), encoding="utf-8"
        ).read()
        src = re.search(r"def _stage_to_response.*?\n    \}", body, re.S).group(0)
        exposed = set(re.findall(r'"(\w+)":', src))
        missing = [c for c in MODEL_COLUMNS if c not in exposed]
        assert not missing, f"_stage_to_response 漏了 {len(missing)} 列：{missing}"

    def test_response_schema_matches_response_dict(self):
        """schema 与响应 dict 必须同集合：漏一边就等于前端拿到被 pydantic
        静默丢键的响应（response_model 会过滤未知字段）。"""
        schema = set(WorldBookStageResponse.model_fields)
        body = open(
            os.path.join(_BACKEND_DIR, "app", "api", "worldbook.py"), encoding="utf-8"
        ).read()
        src = re.search(r"def _stage_to_response.*?\n    \}", body, re.S).group(0)
        exposed = set(re.findall(r'"(\w+)":', src))
        assert exposed - schema == set(), f"响应有、schema 没有：{exposed - schema}"
        assert schema - exposed == set(), f"schema 有、响应没有：{schema - exposed}"

    def test_the_30_advanced_columns_are_in(self):
        """点名核对盘点表 D 段那 30 项（防"补了别的、漏了这批"）。"""
        schema = set(WorldBookStageResponse.model_fields)
        assert len(ADVANCED_COLUMNS) == 30, len(ADVANCED_COLUMNS)
        assert set(ADVANCED_COLUMNS) <= schema, set(ADVANCED_COLUMNS) - schema


class TestReadBackRealValues:
    def test_detail_returns_the_advanced_values(self, client, auth_headers, db_session, test_user):
        wb, stages = _make_book(db_session, test_user, stages=[{
            "enabled": True,
            "case_sensitive": True,
            "depth": 7,
            "order": 3,
            "selective_logic": 2,
            "sticky": 5,
            "cooldown": 9,
            "role": 1,
            "outlet_name": "OUTLET-A",
            "character_filter": "露缇雅",
            "ignore_budget": True,
        }])
        resp = client.get(f"/api/worldbooks/{wb.id}", headers=auth_headers)
        assert resp.status_code == 200, resp.text
        st = next(s for s in resp.json()["stages"] if s["id"] == stages[0].id)
        for key, want in (
            ("enabled", True), ("case_sensitive", True), ("depth", 7),
            ("order", 3), ("selective_logic", 2), ("sticky", 5),
            ("cooldown", 9), ("role", 1), ("outlet_name", "OUTLET-A"),
            ("character_filter", "露缇雅"), ("ignore_budget", True),
        ):
            assert st[key] == want, f"{key}: 期望 {want!r} 实得 {st.get(key)!r}"

    def test_null_columns_come_back_as_defaults_not_none(
        self, client, auth_headers, db_session, test_user,
    ):
        """兜底口径：库里是 NULL 的高级列要给出 ST 语义下的合法值（4/0/False），
        不是让前端自己判 null。use_group_scoring 例外——模型里它本就 nullable
        且无默认，原样给出 None。"""
        wb, stages = _make_book(db_session, test_user, stages=[{}])
        st = client.get(f"/api/worldbooks/{wb.id}", headers=auth_headers).json()["stages"][0]
        assert st["depth"] == 4
        assert st["scan_depth"] == 4
        assert st["position"] == 4
        assert st["enabled"] is True
        assert st["selective_logic"] == 0
        assert st["role"] == 0
        assert st["use_group_scoring"] is None

    def test_stage_to_response_never_raises_on_bare_object(self):
        """`_stage_to_response` 不许因为某列为 None 就抛（它被列表/详情两条
        读路径共用，一处抛 = 整个世界书页面打不开）。"""
        from types import SimpleNamespace

        probe = SimpleNamespace(
            id="x", world_book_id="wb", stage_index=0, title=None, content="c",
            summary=None, transition_hint=None, priority=0, token_count=0,
            image_prompt=None, keys=None, secondary_keys=None,
        )
        for c in WorldBookStage.__table__.columns:
            if c.key not in probe.__dict__:
                setattr(probe, c.key, None)
        out = _stage_to_response(probe)
        WorldBookStageResponse.model_validate(out)


class TestWriteChannelUnchanged:
    """本批只开放读。写侧必须仍然**收不到**这些键——否则"补入口"会变成
    一条没人审过的隐式写通道（30 个字段直接可写 ≠ 派单要求）。"""

    def test_update_schema_does_not_gain_advanced_columns(self):
        fields = set(WorldBookStageUpdate.model_fields)
        leaked = set(ADVANCED_COLUMNS) & fields
        assert not leaked, f"写 schema 混进了高级列：{leaked}"

    def test_put_stage_ignores_advanced_keys(self, client, auth_headers, db_session, test_user):
        wb, stages = _make_book(db_session, test_user, stages=[{"depth": 7, "enabled": True}])
        resp = client.put(
            f"/api/worldbooks/{wb.id}/stages/{stages[0].id}",
            headers=auth_headers,
            json={"title": "改过了", "depth": 999, "enabled": False, "role": 5},
        )
        assert resp.status_code == 200, resp.text
        db_session.expire_all()
        st = db_session.query(WorldBookStage).filter(WorldBookStage.id == stages[0].id).first()
        assert st.title == "改过了", "常规写字段应当照常生效"
        assert st.depth == 7, "写通道被顺手放宽：depth 被请求体改写了"
        assert st.enabled is True, "写通道被顺手放宽：enabled 被请求体改写了"
        assert st.role == 0, "写通道被顺手放宽：role 被请求体改写了"
