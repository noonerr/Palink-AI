"""POST /api/character-sessions/{sid}/mvu-secondary 冒烟回归（2026-10-05）。

## 为什么必须有这个文件

该端点在本次真机测试前是**零测试覆盖**（全仓 `grep mvu-secondary tests/` 命中 0），
于是一个 `NameError: name 'WorldBook' is not defined` 在里面潜伏至今：

    app/api/character_ext.py  trigger_mvu_secondary
    → .options(selectinload(Character.world_books).selectinload(WorldBook.entries))
       ↑ 本文件其余 3 处 WorldBook 用法都做了局部导入，唯独这处漏了

后果：端点**恒返回 HTTP 500**，前端 catch 后显示「变量更新失败」——
即「副 AI 变量更新」按钮**自诞生起从未成功过**。

**静态读码没发现它，单测也没发现它，是真机探针跑出来的。**
本文件钉住最小契约，防止再犯：

  1. 端点**不得 500**；
  2. `reason` 必须落在**前端已覆盖**的已知集合内（否则会掉进兜底文案，
     正是 2026-10-05 修的 `call_failed` 那类 bug）。

运行: cd backend && py -3 -m pytest tests/test_mvu_secondary_endpoint.py -q
"""
import pytest

# 前端 CharacterChat 的 reason → 提示映射所覆盖的全集
# （见 frontend/src/components/views/character/mvuSecondaryFeedback.ts）
KNOWN_REASONS = {
    "secondary_disabled",
    "secondary_model_missing",
    "no_schema",
    "call_failed",
    "no_patches",
    "ok",
    "no_change",
}

SID = "sess-mvu-ep"


@pytest.fixture()
def session_with_assistant_msg(db_session, test_user):
    """建一张卡 + 一个会话 + 一条 assistant 消息（端点要求有可分析的楼层）。"""
    from app.models import Character, CharacterChatMessage, CharacterChatSession

    char = Character(id="char-mvu-ep", user_id=test_user.id, name="端点冒烟卡")
    db_session.add(char)
    db_session.add(CharacterChatSession(
        id=SID, user_id=test_user.id, character_id=char.id, title="端点冒烟",
    ))
    db_session.add(CharacterChatMessage(
        session_id=SID, role="assistant", content="一段用于变量解析的剧情正文。",
    ))
    db_session.commit()
    return SID


def test_mvu_secondary_endpoint_does_not_500(client, auth_headers, session_with_assistant_msg):
    """★ 核心回归：端点不得 500。

    这条用例若在补 `WorldBook` 导入之前运行，会以 HTTP 500 变红 ——
    正是它要防的那种「端点整个跑不起来」的故障。
    """
    resp = client.post(
        f"/api/character-sessions/{session_with_assistant_msg}/mvu-secondary",
        json={"message_id": None},
        headers=auth_headers,
    )
    assert resp.status_code != 500, (
        f"端点返回 500，说明函数内有未定义名/未捕获异常：{resp.text[:500]}"
    )
    assert resp.status_code == 200, f"意外状态码 {resp.status_code}: {resp.text[:300]}"


def test_mvu_secondary_reason_is_known(client, auth_headers, session_with_assistant_msg):
    """reason 必须在已知集合内，否则前端会掉进兜底文案。"""
    resp = client.post(
        f"/api/character-sessions/{session_with_assistant_msg}/mvu-secondary",
        json={"message_id": None},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text[:300]
    body = resp.json()

    assert "reason" in body, f"响应缺少 reason 字段: {body}"
    assert body["reason"] in KNOWN_REASONS, (
        f"reason={body['reason']!r} 不在前端已覆盖的集合内 → 会显示成兜底文案"
    )
    assert "applied" in body, f"响应缺少 applied 字段: {body}"


def test_mvu_secondary_disabled_by_default(client, auth_headers, session_with_assistant_msg):
    """测试用户未开启副 AI → 应是 secondary_disabled（而不是崩溃或其它 reason）。"""
    resp = client.post(
        f"/api/character-sessions/{session_with_assistant_msg}/mvu-secondary",
        json={"message_id": None},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text[:300]
    body = resp.json()
    assert body["reason"] == "secondary_disabled"
    assert body["applied"] is False
