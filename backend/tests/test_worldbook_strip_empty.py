"""世界书条目剥离后无实质内容时整条跳过注入的回归测试。

背景：猫娘卡 7 条「人设控制器」条目 content = 首行 @activate + 酒馆助手 EJS
模板；strip_template_syntax 设计性剥离 EJS（P3 修复）后整条只剩 @activate
孤行，7 条并列（constant、position=after、order=100）拼进 after 桶成为
连续 7 行噪声。平台装饰器语法是双 @@（_parse_decorators），单 @ 全仓无
消费方，属死文本。装配侧窄口径兜底：剥离后所有非空行都只是装饰器样孤行
（@name / @@name 单 token 行）或纯标点/空白的条目，整条跳过注入；
任何一行还有实质文本（哪怕 EJS 剥离后遗留的静态残骨架）都照常注入。
"""
import os
import sys
import uuid

import pytest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from app.core.security import get_password_hash  # noqa: E402
from app.models import Character, User  # noqa: E402
from app.models.character import CharacterChatSession  # noqa: E402
from app.models.worldbook import WorldBook, WorldBookStage  # noqa: E402
from app.services.worldbook_service import (  # noqa: E402
    WI_POS_AFTER_CHAR,
    WI_POS_AT_DEPTH,
    _is_decoration_only,
    build_worldbook_context,
    strip_template_syntax,
)

# 猫娘卡「桃汐_人设控制器」条目 content 的逐字原文（world_book_stages 实测）：
# 首行 @activate + EJS 分层模板（按好感度/关系 getwi 阶段一/二/NSFW）。
CONTROLLER_SAMPLE = """@activate
<%_
var gw = getvar('stat_data.桃汐.好感度') || 50;
var rel = getvar('stat_data.桃汐.关系') || '青梅竹马';
var isPhase2 = (rel||'').includes('恋人') || gw >= 80;

var lib = getvar('stat_data.桃汐.性欲值') || 20;
_%>
<%_ if (isPhase2) { _%>
<%- await getwi('桃汐_人设_阶段二') %>
<%_ if (lib >= 75) { _%>
<%- await getwi('NSFW_桃汐') %>
<%_ } _%>
<%_ } else { _%>
<%- await getwi('桃汐_人设_阶段一') %>
<%_ if (lib >= 75) { _%>
<%- await getwi('NSFW_桃汐') %>
<%_ } _%>
<%_ } _%>"""

# 露缇雅卡「剧情引导」条目（EJS 模板）剥离后遗留的静态残骨架：
# 仍带实质文本，必须照常注入，不得被跳过。
SKELETON_RAW = "当前时间：<%= month %>月<%= day %>日，星期<%= weekday %>。\n<%= systemPrompt %>"
SKELETON_STRIPPED = "当前时间：月日，星期。"


class TestIsDecorationOnly:
    """谓词窄口径钉死：只有装饰器样孤行/纯标点/空白才算无实质内容。"""

    def test_empty_and_whitespace(self):
        assert _is_decoration_only("") is True
        assert _is_decoration_only("   \n \n\t ") is True

    def test_single_at_activate(self):
        assert _is_decoration_only("@activate") is True

    def test_double_at_activate(self):
        assert _is_decoration_only("@@activate") is True

    def test_controller_sample_after_strip(self):
        # 猫娘控制器条目整链：剥离后只剩 @activate 孤行
        stripped = strip_template_syntax(CONTROLLER_SAMPLE)
        assert stripped == "@activate"
        assert _is_decoration_only(stripped) is True

    def test_skeleton_text_not_decoration_only(self):
        # 剥离语义本身不动的前提下，剧情引导型残骨架要能被剥离出来
        assert strip_template_syntax(SKELETON_RAW) == SKELETON_STRIPPED
        assert _is_decoration_only(SKELETON_STRIPPED) is False

    def test_activate_plus_text_not_decoration_only(self):
        assert _is_decoration_only("@activate\n当前时间：月日，星期。") is False

    def test_punct_only_lines(self):
        assert _is_decoration_only("---\n。。。\n——") is True

    def test_punct_line_plus_text(self):
        assert _is_decoration_only("——\n猫娘的尾巴会随心情摆动。") is False

    def test_parameterized_decorator_line_not_lone(self):
        # 带参数的装饰器行（@@include <text>）不是单 token 孤行，保守不跳
        assert _is_decoration_only("@@include some text") is False

    def test_at_token_with_suffix_not_lone(self):
        # 非单 token 的 @ 行（函数调用形态）不匹配孤行口径
        assert _is_decoration_only("@activate(foo)") is False

    def test_plain_text(self):
        assert _is_decoration_only("猫神说话格式：喵。") is False


# ---------------------------------------------------------------------------
# 引擎级：真实 build_worldbook_context + 内存条目（与
# test_worldbook_st_semantics.py 的第三层同模式，SQLite in-memory）
# ---------------------------------------------------------------------------
def _mk_world(db_session, entries, *, tag):
    """建一套最小世界书依赖并返回 (user, char, sess_id)。

    书绑定本会话角色（character_id=char.id → lore source="character"），
    满足「未绑定的书不注入」的装配契约。
    """
    book_id = f"wb-{tag}-{uuid.uuid4().hex[:8]}"
    sess_id = f"sess-{tag}-{uuid.uuid4().hex[:8]}"

    user = User(
        username=f"wbse-{tag}-{uuid.uuid4().hex[:8]}",
        hashed_password=get_password_hash("TestPassword1"),
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.flush()

    char = Character(
        id=f"wbse-c-{tag}-{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name="WbSeChar",
    )
    db_session.add(char)
    db_session.flush()

    db_session.add(CharacterChatSession(
        id=sess_id, user_id=user.id, character_id=char.id, title="wbse",
    ))
    db_session.add(WorldBook(
        id=book_id,
        user_id=user.id,
        name=f"wbse-book-{tag}",
        character_id=char.id,
    ))
    db_session.flush()

    for e in entries:
        uid, content, position = e[0], e[1], e[2]
        order = e[3] if len(e) > 3 else 100
        db_session.add(WorldBookStage(
            id=uid,
            world_book_id=book_id,
            stage_index=0,
            title=f"entry-{uid}",
            content=content,
            keys="[]",
            position=position,
            constant=True,
            enabled=True,
            order=order,
        ))
    db_session.commit()
    return user, char, sess_id


def _run(db_session, user, char, sess_id):
    return build_worldbook_context(
        db_session,
        sess_id,
        user.id,
        recent_messages=[{"role": "user", "content": "随便聊聊，与任何关键词无关"}],
        character=char,
    )


def _report_of(result, entry_id):
    reports = [r for r in result.debug_report if r.entry_id == entry_id]
    return reports[-1] if reports else None


class TestStrippedEmptyEntries:
    """引擎级：剥离后无实质内容的条目不进任何位置桶/深度列表。"""

    def test_constant_controller_entry_skipped(self, db_session):
        """猫娘控制器形态（constant, after 桶）：条目激活但不注入。"""
        user, char, sess = _mk_world(
            db_session,
            [("e1", CONTROLLER_SAMPLE, WI_POS_AFTER_CHAR)],
            tag="ctrl",
        )
        result = _run(db_session, user, char, sess)

        rep = _report_of(result, "e1")
        assert rep.status == "activated"
        assert rep.reason == "constant;stripped_empty", f"实际 reason={rep.reason!r}"
        assert result.entries_by_position == {}
        assert result.text is None

    def test_depth_position_entry_skipped(self, db_session):
        """同形态但 position=atDepth：depth_entries 同样不收。"""
        user, char, sess = _mk_world(
            db_session,
            [("e2", CONTROLLER_SAMPLE, WI_POS_AT_DEPTH)],
            tag="dep",
        )
        result = _run(db_session, user, char, sess)

        assert _report_of(result, "e2").status == "activated"
        assert result.depth_entries == []

    def test_skeleton_entry_still_injected(self, db_session):
        """露缇雅剧情引导型（EJS + 静态残骨架）：剥离后的骨架照常注入。"""
        user, char, sess = _mk_world(
            db_session,
            [("e3", SKELETON_RAW, WI_POS_AFTER_CHAR)],
            tag="skel",
        )
        result = _run(db_session, user, char, sess)

        rep = _report_of(result, "e3")
        assert rep.status == "activated"
        assert "stripped_empty" not in rep.reason
        assert result.entries_by_position == {WI_POS_AFTER_CHAR: [SKELETON_STRIPPED]}

    def test_double_at_activate_with_body_injected(self, db_session):
        """既有 @@activate 语义不变：装饰器行 + 实质正文 → 不被跳过。

        strip_template_syntax 只剥 EJS、不剥 @@ 行，故注入文本含装饰器行
        本身是既有行为；本用例钉的是它不被新增的空内容跳过误伤。
        """
        user, char, sess = _mk_world(
            db_session,
            [("e4", "@@activate\nForced active content", WI_POS_AFTER_CHAR)],
            tag="dec",
        )
        result = _run(db_session, user, char, sess)

        rep = _report_of(result, "e4")
        assert rep.status == "activated"
        assert "stripped_empty" not in rep.reason
        assert result.entries_by_position == {
            WI_POS_AFTER_CHAR: ["@@activate\nForced active content"]
        }

    def test_lone_double_at_activate_skipped(self, db_session):
        """@@activate 孤行（无正文）：装饰器标记不是注入内容，跳过。"""
        user, char, sess = _mk_world(
            db_session,
            [("e5", "@@activate", WI_POS_AFTER_CHAR)],
            tag="lone",
        )
        result = _run(db_session, user, char, sess)

        rep = _report_of(result, "e5")
        assert rep.status == "activated"
        assert rep.reason == "decorator_activate;stripped_empty", \
            f"实际 reason={rep.reason!r}"
        assert result.entries_by_position == {}

    def test_empty_content_entry_skipped(self, db_session):
        """空内容条目：谓词对空串为真（空内容跳过的自然延伸）。"""
        user, char, sess = _mk_world(
            db_session,
            [("e6", "", WI_POS_AFTER_CHAR)],
            tag="empty",
        )
        result = _run(db_session, user, char, sess)

        rep = _report_of(result, "e6")
        assert rep.status == "activated"
        assert rep.reason.endswith("stripped_empty")
        assert result.text is None

    def test_catgirl_after_bucket_shape_reproduction(self, db_session):
        """生产形态复现：猫娘卡 after 桶 order 降序 = 前夹缝(666) → 7 条
        order=100 控制器并列相邻 → 后夹缝(99)。修复后桶里只剩两条实质内容，
        连续 7 行 @activate 噪声消失（与导出 M2 残渣形态逐条对应）。"""
        raw_entries = [
            ("pre", "猫神说话格式强调：所有猫娘说话必须带喵。", 666),
            *[(f"ctrl{i}", CONTROLLER_SAMPLE, 100) for i in range(7)],
            ("post", "【防牛头人】禁止 NTP/NTR 剧情。", 99),
        ]
        user, char, sess = _mk_world(
            db_session,
            [(u, c, WI_POS_AFTER_CHAR, o) for u, c, o in raw_entries],
            tag="cat",
        )
        result = _run(db_session, user, char, sess)

        assert result.entries_by_position == {
            WI_POS_AFTER_CHAR: [
                "猫神说话格式强调：所有猫娘说话必须带喵。",
                "【防牛头人】禁止 NTP/NTR 剧情。",
            ]
        }
        assert result.text is not None
        assert "@activate" not in result.text
