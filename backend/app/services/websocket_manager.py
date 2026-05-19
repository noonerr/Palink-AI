import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Set, Dict, Any

from fastapi import WebSocket

from ..core.database import SessionLocal
from ..models import ChatMessage, CharacterChatMessage
from ..services.stream_builder import StreamResult

logger = logging.getLogger(__name__)


@dataclass
class Connection:
    websocket: WebSocket
    user_id: int
    session_id: str
    connected_at: float = field(default_factory=time.time)
    missed_pongs: int = 0


@dataclass
class StreamSession:
    stream_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str = ""
    full_content: str = ""
    full_reasoning: str = ""
    status: str = "streaming"
    subscribers: Set[Connection] = field(default_factory=set)
    generation_task: Optional[asyncio.Task] = None
    created_at: float = field(default_factory=time.time)
    assistant_message_id: Optional[int] = None
    last_saved_content_len: int = 0
    last_saved_reasoning_len: int = 0
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def is_active(self) -> bool:
        return self.status == "streaming"

    def append_content(self, content: str, reasoning: str = ""):
        if content:
            self.full_content += content
        if reasoning:
            self.full_reasoning += reasoning


class ChatRoom:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.connections: Set[Connection] = set()
        self._lock = asyncio.Lock()

    async def add(self, conn: Connection):
        async with self._lock:
            self.connections.add(conn)

    async def remove(self, conn: Connection) -> bool:
        async with self._lock:
            self.connections.discard(conn)
            return len(self.connections) == 0

    async def broadcast(self, message: dict):
        payload = json.dumps(message, ensure_ascii=False)
        async with self._lock:
            dead: list[Connection] = []
            for conn in self.connections:
                try:
                    await conn.websocket.send_text(payload)
                except Exception:
                    dead.append(conn)
            for conn in dead:
                self.connections.discard(conn)

    async def send_to(self, conn: Connection, message: dict):
        try:
            await conn.websocket.send_text(json.dumps(message, ensure_ascii=False))
        except Exception:
            await self.remove(conn)

    async def sync_connection(self, conn: Connection, stream_session: StreamSession):
        async with stream_session._lock:
            msg = {
                "type": "sync",
                "content": stream_session.full_content,
                "reasoning": stream_session.full_reasoning,
                "status": stream_session.status,
            }
        await self.send_to(conn, msg)

    @property
    def is_empty(self) -> bool:
        return len(self.connections) == 0


class WebSocketManager:
    _instance: Optional["WebSocketManager"] = None

    def __new__(cls) -> "WebSocketManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if hasattr(self, "_initialized"):
            return
        self._initialized = True
        self.rooms: Dict[str, ChatRoom] = {}
        self.stream_sessions: Dict[str, StreamSession] = {}
        self._room_lock = asyncio.Lock()
        self._stream_lock = asyncio.Lock()
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._cleanup_task: Optional[asyncio.Task] = None

    async def register(self, ws: WebSocket, user_id: int, session_id: str) -> Connection:
        await ws.accept()
        conn = Connection(websocket=ws, user_id=user_id, session_id=session_id)
        async with self._room_lock:
            if session_id not in self.rooms:
                self.rooms[session_id] = ChatRoom(session_id)
            await self.rooms[session_id].add(conn)
        logger.info("WebSocket registered: user=%s session=%s", user_id, session_id)

        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
            if ss and ss.is_active:
                await self.rooms[session_id].sync_connection(conn, ss)
                ss.subscribers.add(conn)

        return conn

    async def unregister(self, conn: Connection):
        session_id = conn.session_id
        async with self._room_lock:
            room = self.rooms.get(session_id)
            if room:
                empty = await room.remove(conn)
                if empty:
                    del self.rooms[session_id]

        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
            if ss:
                ss.subscribers.discard(conn)

        logger.info("WebSocket unregistered: user=%s session=%s", conn.user_id, session_id)

    async def broadcast_to_session(self, session_id: str, message: dict):
        async with self._room_lock:
            room = self.rooms.get(session_id)
        if room:
            await room.broadcast(message)

    async def create_stream_session(
        self,
        session_id: str,
        user_id: int,
        generation_coroutine,
    ) -> StreamSession:
        async with self._stream_lock:
            existing = self.stream_sessions.get(session_id)
            if existing and existing.is_active:
                return existing

            ss = StreamSession(session_id=session_id)
            self.stream_sessions[session_id] = ss

        async with self._room_lock:
            room = self.rooms.get(session_id)

        if room:
            async with room._lock:
                ss.subscribers = set(room.connections)

        async def _run_generation():
            try:
                await generation_coroutine(ss)
            except asyncio.CancelledError:
                async with ss._lock:
                    ss.status = "error"
                await self.broadcast_to_session(session_id, {
                    "type": "error",
                    "message": "Generation was cancelled",
                })
            except Exception as exc:
                logger.exception("Stream generation error for session=%s", session_id)
                async with ss._lock:
                    ss.status = "error"
                await self.broadcast_to_session(session_id, {
                    "type": "error",
                    "message": str(exc)[:500],
                })
            finally:
                async with ss._lock:
                    if ss.status == "streaming":
                        ss.status = "done"

        task = asyncio.create_task(_run_generation())
        ss.generation_task = task
        logger.info("StreamSession created: stream_id=%s session=%s", ss.stream_id, session_id)
        return ss

    def get_stream_session(self, session_id: str) -> Optional[StreamSession]:
        return self.stream_sessions.get(session_id)

    async def sync_connection(self, conn: Connection, session_id: str):
        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
        if not ss:
            return

        async with self._room_lock:
            room = self.rooms.get(session_id)
        if room:
            await room.sync_connection(conn, ss)
            ss.subscribers.add(conn)

    async def send_chunk(self, session_id: str, content: str = "", reasoning: str = ""):
        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
        if not ss:
            return

        async with ss._lock:
            ss.append_content(content, reasoning)

        msg: Dict[str, Any] = {"type": "chunk"}
        if content:
            msg["content"] = content
        if reasoning:
            msg["reasoning"] = reasoning
        await self.broadcast_to_session(session_id, msg)

    async def send_done(self, session_id: str, usage: Optional[dict] = None):
        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
        if not ss:
            return

        async with ss._lock:
            ss.status = "done"

        msg: Dict[str, Any] = {
            "type": "done",
            "content": ss.full_content,
        }
        if ss.full_reasoning:
            msg["reasoning"] = ss.full_reasoning
        if usage:
            msg["usage"] = usage
        await self.broadcast_to_session(session_id, msg)

    async def send_error(self, session_id: str, message: str):
        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
        if ss:
            async with ss._lock:
                ss.status = "error"

        await self.broadcast_to_session(session_id, {
            "type": "error",
            "message": message[:500],
        })

    async def save_stream_to_db(self, session_id: str, model: str, is_character: bool = False):
        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
        if not ss:
            return

        async with ss._lock:
            content = ss.full_content
            reasoning = ss.full_reasoning
            ss.last_saved_content_len = len(content)
            ss.last_saved_reasoning_len = len(reasoning)

        db = SessionLocal()
        try:
            if is_character:
                msg = CharacterChatMessage(
                    session_id=session_id,
                    role="assistant",
                    content=content,
                    model=model,
                )
            else:
                msg = ChatMessage(
                    session_id=session_id,
                    role="assistant",
                    content=content,
                    model=model,
                )
            db.add(msg)
            db.commit()
            db.refresh(msg)
            ss.assistant_message_id = msg.id
            logger.info("Saved stream to DB: session=%s msg_id=%s", session_id, msg.id)
        except Exception as exc:
            db.rollback()
            logger.error("Failed to save stream to DB: %s", exc)
        finally:
            db.close()

    async def update_stream_in_db(self, session_id: str, model: str, is_character: bool = False):
        async with self._stream_lock:
            ss = self.stream_sessions.get(session_id)
        if not ss:
            return

        async with ss._lock:
            content = ss.full_content
            reasoning = ss.full_reasoning
            msg_id = ss.assistant_message_id
            ss.last_saved_content_len = len(content)
            ss.last_saved_reasoning_len = len(reasoning)

        if not msg_id:
            await self.save_stream_to_db(session_id, model, is_character)
            return

        db = SessionLocal()
        try:
            if is_character:
                msg = db.query(CharacterChatMessage).filter(
                    CharacterChatMessage.id == msg_id
                ).first()
            else:
                msg = db.query(ChatMessage).filter(
                    ChatMessage.id == msg_id
                ).first()

            if msg:
                msg.content = content
                db.commit()
        except Exception as exc:
            db.rollback()
            logger.error("Failed to update stream in DB: %s", exc)
        finally:
            db.close()

    def start_heartbeat(self):
        if self._heartbeat_task and not self._heartbeat_task.done():
            return

        async def _heartbeat_loop():
            while True:
                try:
                    await asyncio.sleep(30)
                    await self._ping_all()
                except asyncio.CancelledError:
                    break
                except Exception:
                    logger.exception("Heartbeat error")

        self._heartbeat_task = asyncio.create_task(_heartbeat_loop())
        logger.info("WebSocket heartbeat started")

        if not self._cleanup_task or self._cleanup_task.done():
            self._start_cleanup()

    def stop_heartbeat(self):
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            self._cleanup_task = None
        logger.info("WebSocket heartbeat stopped")

    async def _ping_all(self):
        async with self._room_lock:
            all_conns: list[tuple[ChatRoom, Connection]] = []
            for room in self.rooms.values():
                for conn in list(room.connections):
                    all_conns.append((room, conn))

        for room, conn in all_conns:
            try:
                await conn.websocket.send_text(json.dumps({"type": "ping"}))
                conn.missed_pongs += 1
                if conn.missed_pongs > 3:
                    logger.warning(
                        "Too many missed pongs, removing: user=%s session=%s",
                        conn.user_id,
                        conn.session_id,
                    )
                    await self.unregister(conn)
            except Exception:
                await self.unregister(conn)

    def handle_pong(self, conn: Connection):
        conn.missed_pongs = 0

    def _start_cleanup(self):
        async def _cleanup_loop():
            while True:
                try:
                    await asyncio.sleep(60)
                    await self._cleanup_completed()
                except asyncio.CancelledError:
                    break
                except Exception:
                    logger.exception("Cleanup error")

        self._cleanup_task = asyncio.create_task(_cleanup_loop())

    async def _cleanup_completed(self):
        now = time.time()
        to_remove: list[str] = []

        async with self._stream_lock:
            for session_id, ss in list(self.stream_sessions.items()):
                if ss.status in ("done", "error") and not ss.subscribers:
                    if now - ss.created_at > 300:
                        to_remove.append(session_id)

            for session_id in to_remove:
                ss = self.stream_sessions.pop(session_id, None)
                if ss and ss.generation_task and not ss.generation_task.done():
                    ss.generation_task.cancel()
                logger.info("Cleaned up StreamSession: session=%s", session_id)

    async def shutdown(self):
        self.stop_heartbeat()

        async with self._stream_lock:
            for ss in self.stream_sessions.values():
                if ss.generation_task and not ss.generation_task.done():
                    ss.generation_task.cancel()

        async with self._room_lock:
            for room in self.rooms.values():
                for conn in list(room.connections):
                    try:
                        await conn.websocket.close(code=1001, reason="Server shutting down")
                    except Exception:
                        pass
            self.rooms.clear()

        self.stream_sessions.clear()
        logger.info("WebSocketManager shutdown complete")


ws_manager = WebSocketManager()
