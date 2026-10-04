"""生成链路「形状守卫」接线回归（2026-10-05）。

`mvu_stat_normalize` 的单元测试证明归一化本身对；本文件证明**它确实被接在
生成链路上** —— 否则就是「写了个函数但没人调用」的假修。

做法：把 `MvuEngine.update_from_reply` 打桩成返回**已漂移**的 new_vars
（复刻真实故障形状），调 `apply_mvu_reply_to_session`，断言落库的
`chat_metadata.variables` 已被归一化。

运行: cd backend && py -3 -m pytest tests/test_mvu_shape_guard_wiring.py -q
"""
import json

import pytest

from app.models import Character, CharacterChatSession


SID = "sess-shape-guard"
CID = "char-shape-guard"

# 卡片 z.object 的最小复刻（与真实卡同形：状态 是对象，里面才是 爱意/魔力值）
SCHEMA_SCRIPT = """
export const Schema = z.object({
  露缇雅: z.object({
    状态: z.object({
      爱意: z.coerce.number().prefault(0),
      魔力值: z.coerce.number().prefault(100),
    }).prefault({}),
    穿着: z.partialRecord(z.enum(['上身']), z.string()).prefault({}),
  }).prefault({}),
});
"""


@pytest.fixture()
def seeded_session(db_session, test_user):
    db_session.add(
        Character(
            id=CID, user_id=test_user.id, name="形状守卫卡",
            extensions=json.dumps(
                {"tavern_helper": {"scripts": [{"content": SCHEMA_SCRIPT}]}},
                ensure_ascii=False,
            ),
        )
    )
    db_session.add(
        CharacterChatSession(
            id=SID, user_id=test_user.id, character_id=CID, title="形状守卫",
            chat_metadata=json.dumps(
                {"variables": {"stat_data": {"露缇雅": {"状态": {"爱意": 1, "魔力值": 50}}}}},
                ensure_ascii=False,
            ),
        )
    )
    db_session.commit()
    return SID


def _drifted_vars():
    """复刻真实漂移：状态 变文本，子键被提到 露缇雅 下。"""
    return {
        "stat_data": {
            "露缇雅": {
                "状态": "依赖加深，对魔纹的指向性感到困惑与不安",
                "穿着": {"上身": "睡裙"},
                "爱意": 7,
                "魔力值": 56,
            }
        }
    }


def test_wiring_normalizes_drifted_vars(monkeypatch, db_session, seeded_session):
    """★ 主回归：链路必须真的调用归一化。

    改坏方式：删掉 character_message_builder 里那段 `[MVU-SHAPE-GUARD]` 调用，
    本用例会读到未归一化的 stat_data 而变红。
    """
    from app.services import mvu_engine
    from app.services import character_message_builder as cmb

    monkeypatch.setattr(
        mvu_engine.MvuEngine, "update_from_reply",
        staticmethod(lambda *a, **k: (_drifted_vars(), ["stub"], [])),
    )

    new_vars, logs, patches = cmb.apply_mvu_reply_to_session(
        db_session, CID, SID, "一段剧情正文",
    )

    st = new_vars["stat_data"]["露缇雅"]["状态"]
    assert isinstance(st, dict), f"接线没生效：状态 仍是 {type(st).__name__}"
    assert st["爱意"] == 7
    assert st["魔力值"] == 56
    assert "爱意" not in new_vars["stat_data"]["露缇雅"], "裸挂的兄弟键没被搬走"

    # 落库的也必须已归一化（否则下一轮读到的还是坏结构）
    sess = db_session.query(CharacterChatSession).filter_by(id=SID).one()
    stored = json.loads(sess.chat_metadata)["variables"]["stat_data"]
    assert isinstance(stored["露缇雅"]["状态"], dict)
    assert stored["露缇雅"]["状态"]["爱意"] == 7


def test_wiring_leaves_clean_vars_untouched(monkeypatch, db_session, seeded_session):
    """反向守卫：结构本来就对 → 一个字节都不动（不能因为归一化把好数据改坏）。"""
    from app.services import mvu_engine
    from app.services import character_message_builder as cmb

    clean = {"stat_data": {"露缇雅": {"状态": {"爱意": 3, "魔力值": 40}, "穿着": {"上身": "x"}}}}
    monkeypatch.setattr(
        mvu_engine.MvuEngine, "update_from_reply",
        staticmethod(lambda *a, **k: (clean, ["stub"], [])),
    )

    new_vars, _, _ = cmb.apply_mvu_reply_to_session(
        db_session, CID, SID, "剧情",
    )
    assert new_vars == clean, f"干净数据被改了：{new_vars}"


def test_wiring_survives_broken_schema(monkeypatch, db_session, test_user):
    """安全阀：解析不出 schema 时，链路照常走通、数据原样落库（不因守卫而失败）。"""
    from app.services import mvu_engine
    from app.services import character_message_builder as cmb

    db_session.add(Character(id="char-no-schema", user_id=test_user.id, name="无schema", extensions="{}"))
    db_session.add(CharacterChatSession(
        id="sess-no-schema", user_id=test_user.id, character_id="char-no-schema", title="t",
        chat_metadata=json.dumps({"variables": {"stat_data": {}}}, ensure_ascii=False),
    ))
    db_session.commit()

    monkeypatch.setattr(
        mvu_engine.MvuEngine, "update_from_reply",
        staticmethod(lambda *a, **k: (_drifted_vars(), ["stub"], [])),
    )
    new_vars, _, _ = cmb.apply_mvu_reply_to_session(
        db_session, "char-no-schema", "sess-no-schema", "剧情",
    )
    # 没有骨架 → 不做任何改动，且不得抛异常
    assert new_vars["stat_data"]["露缇雅"]["状态"] == "依赖加深，对魔纹的指向性感到困惑与不安"
