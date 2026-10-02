"""真机验收驱动：通过**真实 HTTP 入口**建新会话并生成，每格 n 次 swipe。

与 `_experiment_bubble_ab.py`（进程内等价链路）的区别：本脚本不打桩，
走 uvicorn 上的真实端点，消息真实落库，历史由 DB 回读。

- 新会话：`POST /api/character-chat`（不带 session_id → 服务端建会话）
- 续聊：`POST /api/character-chat`（带 session_id）
- 重采样：`POST /api/character-sessions/{sid}/swipe`（追加到该消息的 swipes 数组）
- 鉴权：容器内用 app 自己的 `create_access_token` 现签 Bearer 头（Bearer 豁免 CSRF 中间件）

隐私红线：只打印 id / 状态码 / 长度 / 条数 / 耗时等元数据，**从不打印任何正文**。

用法：
  docker exec palink-ai-backend-1 python /app/scripts/_drive_real_acceptance.py \
      --character 4af0c6d3-4fc8-4ad0-b22f-8ce64f52eb44 --model deepseek-v4-flash \
      --turns 1,3 --n 8
"""

import argparse
import asyncio
import json
import sys
import time

sys.path.insert(0, "/app")

import httpx  # noqa: E402

from app.core import security  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models import Character, CharacterChatMessage, CharacterChatSession  # noqa: E402

BASE = "http://127.0.0.1:8000"
USERNAME = "admin"
INIT_MAGIC = "__INIT__"
# 中性探针语，不借用任何既有对话内容
TURN_MESSAGES = {
    1: "你好",
    2: "嗯，然后呢？",
    3: "继续说。",
    4: "再多讲一点。",
    5: "继续。",
}


def _auth() -> str:
    return security.create_access_token({"sub": USERNAME})


def _latest_session_id(character_id: str) -> str:
    db = SessionLocal()
    try:
        row = (
            db.query(CharacterChatSession)
            .filter(CharacterChatSession.character_id == character_id)
            .order_by(CharacterChatSession.created_at.desc())
            .first()
        )
        return row.id if row else ""
    finally:
        db.close()


def _latest_assistant_id(session_id: str) -> int:
    db = SessionLocal()
    try:
        row = (
            db.query(CharacterChatMessage)
            .filter(
                CharacterChatMessage.session_id == session_id,
                CharacterChatMessage.role == "assistant",
            )
            .order_by(CharacterChatMessage.id.desc())
            .first()
        )
        return int(row.id) if row else -1
    finally:
        db.close()


def _msg_stats(session_id: str) -> list[tuple[int, str, int, int]]:
    """(id, role, content 长度, swipes 条数)——只出元数据。"""
    db = SessionLocal()
    try:
        rows = (
            db.query(CharacterChatMessage)
            .filter(CharacterChatMessage.session_id == session_id)
            .order_by(CharacterChatMessage.id)
            .all()
        )
        out = []
        for r in rows:
            n_swipes = 0
            if r.swipes:
                try:
                    n_swipes = len(json.loads(r.swipes))
                except (TypeError, ValueError):
                    n_swipes = -1
            out.append((int(r.id), r.role, len(r.content or ""), n_swipes))
        return out
    finally:
        db.close()


async def _consume(
    client: httpx.AsyncClient, path: str, payload: dict, token: str, retries: int = 3
) -> tuple[int, int, float]:
    """发一次生成请求并**完整消费** SSE 流；429 按 Retry-After 退避重试。

    提前中断会取消生成（消息可能只落一半），所以必须把流读到结束。
    限流（20 请求/60s，固定窗口，DB 共享计数）在连续 swipe 时会被撞到，
    故内建退避，避免把 429 当成"生成失败"误判。
    返回 (status, 收到字节数, 耗时秒)。
    """
    headers = {"Authorization": f"Bearer {token}"}
    for attempt in range(retries + 1):
        n_bytes = 0
        t0 = time.monotonic()
        async with client.stream("POST", BASE + path, json=payload, headers=headers) as resp:
            status = resp.status_code
            if status == 429 and attempt < retries:
                wait = 61.0
                try:
                    wait = max(5.0, float(resp.headers.get("Retry-After", "61")) + 2.0)
                except (TypeError, ValueError):
                    pass
                print("[HTTP] 429 -> 退避 %.0fs 后重试（第 %d 次）" % (wait, attempt + 1))
                await resp.aread()
                await asyncio.sleep(wait)
                continue
            async for chunk in resp.aiter_bytes():
                n_bytes += len(chunk)
            if status >= 400:
                # 只出状态码与响应长度，不回显正文
                print("[HTTP] %s -> %d" % (path, status))
            return status, n_bytes, time.monotonic() - t0
    return 429, 0, 0.0


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True, help="角色 id")
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument(
        "--turns", default="1,3",
        help="在这些**生成序号**（1=第一次生成）做 n 次 swipe；其余序号只各生成 1 次",
    )
    ap.add_argument("--n", type=int, default=8, help="每格 swipe 次数")
    ap.add_argument("--temperature", type=float, default=0.70)
    ap.add_argument("--pace", type=float, default=1.0, help="每次请求之间的间隔秒")
    ap.add_argument("--session-id", default="", help="复用既有会话（默认新建并先走 __INIT__）")
    ap.add_argument("--no-init", action="store_true", help="跳过 __INIT__（不推荐：真机必走它）")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        char = db.query(Character).filter(Character.id == args.character).first()
        if not char:
            raise SystemExit("[FAIL] 角色不存在")
        char_name_len = len(char.name or "")
        first_mes_len = len(char.first_mes or "")
    finally:
        db.close()

    sample_turns = sorted({int(t) for t in args.turns.split(",") if t.strip().isdigit()})
    max_turn = max(sample_turns) if sample_turns else 1
    token = _auth()
    print("[ENV] character=%s name_len=%d first_mes_len=%d model=%s gen_turns=%s n=%d"
          % (args.character[:8], char_name_len, first_mes_len, args.model, sample_turns, args.n))

    async with httpx.AsyncClient(timeout=300.0) as client:
        sid = args.session_id
        # ── 第 0 步：真机新会话必走的 __INIT__（静态渲染开场白，不过模型；
        #    开场白会作为 assistant 消息留在历史里，是"第一次生成"看到的正例）──
        if not sid and not args.no_init:
            st, by, el = await _consume(
                client,
                "/api/character-chat",
                {"message": INIT_MAGIC, "character_id": args.character,
                 "model": args.model, "max_tokens": 16384},
                token,
            )
            sid = _latest_session_id(args.character)
            oid = _latest_assistant_id(sid)
            if st != 200 or not sid:
                raise SystemExit("[FAIL] __INIT__ 失败 status=%d" % st)
            print("[INIT] session=%s status=%d bytes=%d %.1fs opening_msg_id=%s"
                  % (sid, st, by, el, oid))
            await asyncio.sleep(args.pace)

        for turn in range(1, max_turn + 1):
            payload = {
                "message": TURN_MESSAGES.get(turn, "继续。"),
                "character_id": args.character,
                "model": args.model,
                "temperature": args.temperature,
                "max_tokens": 16384,
            }
            if sid:
                payload["session_id"] = sid
            st, by, el = await _consume(client, "/api/character-chat", payload, token)
            if st != 200:
                print("[ABORT] gen=%d 生成请求未成功（status=%d），中止以免 swipe 到陈旧消息" % (turn, st))
                print("[RESULT] session_id=%s aborted_gen=%d" % (sid, turn))
                return
            if not sid:
                sid = _latest_session_id(args.character)
                print("[SESSION] 新建 id=%s" % sid)
            aid = _latest_assistant_id(sid)
            print("[TURN] gen=%d status=%d bytes=%d %.1fs assistant_id=%s"
                  % (turn, st, by, el, aid))
            await asyncio.sleep(args.pace)

            if turn not in sample_turns:
                continue
            ok = 0
            for i in range(args.n):
                st2, by2, el2 = await _consume(
                    client,
                    "/api/character-sessions/%s/swipe" % sid,
                    {"message_id": aid, "model": args.model,
                     "temperature": args.temperature, "max_tokens": 16384},
                    token,
                )
                ok += 1 if st2 == 200 else 0
                print("[SWIPE] gen=%d i=%d/%d status=%d bytes=%d %.1fs"
                      % (turn, i + 1, args.n, st2, by2, el2))
                await asyncio.sleep(args.pace)
            print("[CELL] gen=%d swipe 成功 %d/%d" % (turn, ok, args.n))

    print("[RESULT] session_id=%s" % sid)
    for mid, role, clen, n_sw in _msg_stats(sid):
        print("[MSG] id=%s role=%-9s len=%5d swipes=%d" % (mid, role, clen, n_sw))


if __name__ == "__main__":
    asyncio.run(main())
