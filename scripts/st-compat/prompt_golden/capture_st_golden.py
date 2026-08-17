"""ST 1.18.0 Golden Vector 捕获脚本（捕获服务器版）。

策略：
    1. 启动独立捕获服务器（模拟 OpenAI-compatible API）
    2. 修改 ST settings.json 将 custom_url 指向捕获服务器
    3. Playwright 加载 ST 前端，DOM 交互触发生成
    4. ST 后端转发 generate 请求到捕获服务器，捕获 messages
    5. 恢复 ST 原始 settings.json

优点：
    - 不干扰 ST 内部 token 计数等请求
    - 捕获服务器是真实 HTTP 服务器，可靠处理请求
    - Playwright 只负责 UI 交互，不做路由拦截

输出: /app/tests/st_compat/golden_vectors/st_{name}.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
ST_URL = "http://sillytavern:8000"
ST_SETTINGS_PATH = "/home/node/app/data/default-user/settings.json"
CAPTURE_PORT = 8899
CAPTURE_HOST = "0.0.0.0"
CAPTURE_URL_FOR_ST = f"http://backend:{CAPTURE_PORT}/v1"
OUTPUT_DIR = Path("/app/tests/st_compat/golden_vectors")

# 导入 fixture 数据
sys.path.insert(0, "/app")
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from palink_golden_vector import FIXTURES
except Exception:
    FIXTURES = {}


# ---------------------------------------------------------------------------
# 捕获服务器
# ---------------------------------------------------------------------------
class CaptureHandler(BaseHTTPRequestHandler):
    """捕获 ST 发送的 generate 请求。"""

    captured_data: dict | None = None
    capture_event = threading.Event()

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        # 捕获 generate/chat-completions 请求
        if "generate" in parsed.path or "chat/completions" in parsed.path:
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = {"raw": body.decode("utf-8", errors="replace")}

            messages = payload.get("messages", [])
            if messages:
                CaptureHandler.captured_data = {
                    "messages": messages,
                    "model": payload.get("model", ""),
                    "stream": payload.get("stream", False),
                    "temperature": payload.get("temperature"),
                    "top_p": payload.get("top_p"),
                    "max_tokens": payload.get("max_tokens"),
                    "full_payload": payload,
                }
                print(f"  [CAPTURED] {len(messages)} messages from {parsed.path}")
                CaptureHandler.capture_event.set()

            # 返回最小有效响应
            if payload.get("stream"):
                self._send_stream_response(payload.get("model", "capture-model"))
            else:
                self._send_json({
                    "id": f"chatcmpl-captured-{int(time.time())}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": payload.get("model", "capture-model"),
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "[CAPTURED]"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1},
                })
            return

        # 其他 POST 端点
        self._send_json({"ok": True})

    def do_GET(self):
        parsed = urlparse(self.path)
        if "models" in parsed.path:
            self._send_json({
                "object": "list",
                "data": [{"id": "capture-model", "object": "model", "owned_by": "capture"}],
            })
        else:
            self._send_json({"status": "ok"})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def _send_json(self, data: dict):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_stream_response(self, model: str):
        import uuid
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        chunks = [
            {"id": completion_id, "object": "chat.completion.chunk", "created": int(time.time()),
             "model": model, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]},
            {"id": completion_id, "object": "chat.completion.chunk", "created": int(time.time()),
             "model": model, "choices": [{"index": 0, "delta": {"content": "[CAPTURED]"}, "finish_reason": None}]},
            {"id": completion_id, "object": "chat.completion.chunk", "created": int(time.time()),
             "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, format, *args):
        pass  # 静默


class ReuseHTTPServer(HTTPServer):
    """允许端口复用，避免 TIME_WAIT 导致 Address already in use。"""
    allow_reuse_address = True
    allow_reuse_port = True


def start_capture_server() -> HTTPServer:
    """启动捕获服务器（带端口占用重试）。"""
    CaptureHandler.captured_data = None
    CaptureHandler.capture_event.clear()
    server = None
    for attempt in range(6):
        try:
            server = ReuseHTTPServer((CAPTURE_HOST, CAPTURE_PORT), CaptureHandler)
            break
        except OSError as e:
            if attempt < 5:
                print(f"  [SERVER] Port {CAPTURE_PORT} in use ({e}), retry {attempt+1}/6...")
                time.sleep(2)
            else:
                raise
    server.timeout = 1  # 非阻塞，允许超时检查
    thread = threading.Thread(target=_serve_loop, args=(server,), daemon=True)
    thread.start()
    print(f"  [SERVER] Capture server on port {CAPTURE_PORT}")
    return server


def _serve_loop(server: HTTPServer):
    """非阻塞服务循环。"""
    while server._BaseServer__shutdown_request is False:
        server.handle_request()


def stop_capture_server(server: HTTPServer):
    """停止捕获服务器（非阻塞）。"""
    try:
        # 不用 server.shutdown()（会阻塞等待 serve_forever 确认）
        # 直接关闭 socket 并标记关闭
        server._BaseServer__shutdown_request = True
        server.server_close()
        time.sleep(1)  # 等待端口释放
        print("  [SERVER] Capture server stopped")
    except Exception as e:
        print(f"  [SERVER] Stop error: {e}")


# ---------------------------------------------------------------------------
# ST settings.json 管理（通过 REST API）
# ---------------------------------------------------------------------------
def backup_st_settings() -> dict:
    """通过 ST REST API 读取 settings，返回原始 settings 对象。"""
    req = urllib.request.Request(
        f"{ST_URL}/api/settings/get", data=b"{}",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())

    # settings 是文件内容的字符串
    settings_str = data.get("settings", "{}")
    settings_obj = json.loads(settings_str)
    print(f"  [SETTINGS] Backed up (custom_url={settings_obj.get('oai_settings',{}).get('custom_url','N/A')})")
    return settings_obj


def restore_st_settings(original_settings: dict):
    """通过 ST REST API 恢复 settings。"""
    body = json.dumps(original_settings).encode()
    req = urllib.request.Request(
        f"{ST_URL}/api/settings/save", data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        print("  [SETTINGS] Restored original settings")
    except Exception as e:
        print(f"  [WARN] Failed to restore settings: {e}")


def set_st_custom_url(capture_url: str, original_settings: dict) -> dict:
    """修改 ST settings 中的 custom_url，返回修改后的 settings。"""
    import copy
    settings = copy.deepcopy(original_settings)
    old_url = settings.get("oai_settings", {}).get("custom_url", "N/A")
    settings.setdefault("oai_settings", {})["custom_url"] = capture_url
    print(f"  [SETTINGS] custom_url: {old_url} → {capture_url}")

    body = json.dumps(settings).encode()
    req = urllib.request.Request(
        f"{ST_URL}/api/settings/save", data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()
    return settings


# ---------------------------------------------------------------------------
# ST REST API
# ---------------------------------------------------------------------------
def _st_multipart(path: str, fields: dict, timeout: int = 15) -> str:
    boundary = "----CaptureBoundary7MA4YWxkTrZu0gW"
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
    parts.append(f"--{boundary}--\r\n")
    body = "".join(parts).encode("utf-8")
    req = urllib.request.Request(
        f"{ST_URL}{path}", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode().strip('"')


def _st_json(path: str, data: dict, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        f"{ST_URL}{path}", data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode()
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"raw": body}


def _st_post_raw(path: str, data: dict, timeout: int = 15) -> int:
    req = urllib.request.Request(
        f"{ST_URL}{path}", data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def create_character(char_name: str, fixture: dict) -> str:
    fields = {
        "ch_name": char_name,
        "description": fixture.get("description", ""),
        "personality": fixture.get("personality", ""),
        "scenario": fixture.get("scenario", ""),
        "first_mes": fixture.get("first_mes", ""),
        "mes_example": fixture.get("mes_example", ""),
        "creator_notes": fixture.get("creator_notes", ""),
        "system_prompt": fixture.get("system_prompt", ""),
        "post_history_instructions": fixture.get("post_history_instructions", ""),
    }
    avatar = _st_multipart("/api/characters/create", fields)
    print(f"  [CHAR] Created: {char_name}")
    return avatar


def _list_characters() -> list[dict]:
    """获取 ST 所有角色卡列表。"""
    req = urllib.request.Request(
        f"{ST_URL}/api/characters/all", data=b"{}",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def _delete_by_avatar(avatar: str) -> bool:
    """按 avatar 文件名删除单个角色卡。"""
    status = _st_post_raw("/api/characters/delete", {"avatar_url": avatar, "delete_chats": True})
    return status == 200


def cleanup_existing_characters(char_name: str):
    """清理所有同名残留角色卡（处理重名后缀如 name1.png, name2.png）。"""
    try:
        chars = _list_characters()
        to_delete = [c["avatar"] for c in chars if c.get("name") == char_name and c.get("avatar")]
        if not to_delete:
            return
        for av in to_delete:
            if _delete_by_avatar(av):
                print(f"  [PRE-CLEAN] Deleted: {av}")
            else:
                print(f"  [PRE-CLEAN] Failed: {av}")
        time.sleep(1)
    except Exception as e:
        print(f"  [PRE-CLEAN] Error: {e}")


def delete_character(char_name: str):
    """删除角色卡（兼容重名后缀：删除所有 name 匹配的角色）。"""
    try:
        chars = _list_characters()
        to_delete = [c["avatar"] for c in chars if c.get("name") == char_name and c.get("avatar")]
        if not to_delete:
            # fallback: 尝试默认 avatar 名
            to_delete = [f"{char_name}.png"]
        for av in to_delete:
            if _delete_by_avatar(av):
                print(f"  [CLEAN] Deleted: {av}")
            else:
                print(f"  [CLEAN] Failed: {av}")
    except Exception as e:
        print(f"  [CLEAN] Failed: {e}")


def create_worldbook(wb_data: dict) -> str:
    """通过 ST API 创建 worldbook 并返回名称。

    将 fixture 中的 worldbook 格式转换为 ST 1.18.0 的 worldinfo 格式。
    """
    wb_name = wb_data["name"]
    entries = {}
    for idx, entry_data in enumerate(wb_data.get("entries", [])):
        # fixture 格式 → ST worldinfo entry 格式
        st_entry = {
            "uid": idx,
            "key": entry_data.get("keys", []),
            "keysecondary": [],
            "comment": "",
            "content": entry_data.get("content", ""),
            "constant": entry_data.get("constant", False),
            "vectorized": False,
            "selective": entry_data.get("selective", False),
            "selectiveLogic": entry_data.get("selective_logic", 0),
            "addMemo": False,
            "order": entry_data.get("order", 100),
            "position": entry_data.get("position", 0),
            "disable": not entry_data.get("enabled", True),
            "ignoreBudget": False,
            "excludeRecursion": False,
            "preventRecursion": False,
            "matchPersonaDescription": False,
            "matchCharacterDescription": False,
            "matchCharacterPersonality": False,
            "matchCharacterDepthPrompt": False,
            "matchScenario": False,
            "matchCreatorNotes": False,
            "delayUntilRecursion": 0,
            "probability": 100,
            "useProbability": True,
            "depth": entry_data.get("depth", 4),
            "outletName": "",
            "group": "",
            "groupOverride": False,
            "groupWeight": 100,
            "scanDepth": None,
            "caseSensitive": None,
            "matchWholeWords": None,
            "useGroupScoring": None,
            "automationId": "",
            "role": 0,
            "sticky": None,
            "cooldown": None,
            "delay": None,
            "triggers": [],
        }
        entries[str(idx)] = st_entry

    payload = {
        "name": wb_name,
        "data": {
            "entries": entries,
            "name": wb_name,
        },
    }
    _st_json("/api/worldinfo/edit", payload)
    print(f"  [WORLDBOOK] Created: {wb_name} ({len(entries)} entries)")
    return wb_name


def link_worldbook_to_character(avatar: str, wb_name: str):
    """通过 ST API 将 worldbook 关联到角色卡。"""
    payload = {
        "avatar": avatar,
        "data": {
            "extensions": {
                "world": wb_name,
            },
        },
    }
    _st_json("/api/characters/merge-attributes", payload)
    print(f"  [WORLDBOOK] Linked '{wb_name}' to {avatar}")


def delete_worldbook(wb_name: str):
    """删除 worldbook。"""
    try:
        _st_post_raw("/api/worldinfo/delete", {"name": wb_name})
        print(f"  [WORLDBOOK] Deleted: {wb_name}")
    except Exception as e:
        print(f"  [WORLDBOOK] Delete failed: {e}")


def save_chat(char_name: str, chat_messages: list[dict], first_mes: str, file_name: str):
    chat_data = [{
        "name": char_name, "is_user": False, "is_system": False,
        "send_date": "2024-01-01T12:00:00Z", "mes": first_mes,
        "swipe_id": 0, "swipes": [], "extra": {},
    }]
    for i, msg in enumerate(chat_messages):
        chat_data.append({
            "name": char_name if msg["role"] == "assistant" else "GoldenUser",
            "is_user": msg["role"] == "user", "is_system": False,
            "send_date": f"2024-01-01T12:{i+1:02d}:00Z", "mes": msg["content"],
            "swipe_id": 0, "swipes": [], "extra": {},
        })
    _st_json("/api/chats/save", {
        "avatar_url": f"{char_name}.png", "chat": chat_data,
        "file_name": file_name, "force": True,
    })
    print(f"  [CHAT] Saved {len(chat_data)} messages")


# ---------------------------------------------------------------------------
# Playwright UI 交互（不做路由拦截）
# ---------------------------------------------------------------------------
def trigger_send_via_playwright(char_name: str, current_message: str, timeout: int = 90) -> bool:
    """使用 Playwright 加载 ST 前端，DOM 交互触发发送。"""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu"])
        context = browser.new_context(viewport={"width": 1280, "height": 720})
        page = context.new_page()

        # 监听控制台错误
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)[:200]))

        try:
            # 1. 加载 ST
            print("  [PW] Loading ST...")
            page.goto(ST_URL + "/", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=30000)
            time.sleep(5)

            # 2. 触发 API 连接
            print("  [PW] Triggering API connection...")
            page.evaluate("() => { jQuery('#api_button_openai').trigger('click'); }")
            time.sleep(8)

            send_but_visible = page.evaluate("() => !jQuery('#send_but').hasClass('displayNone')")
            print(f"  [PW] send_but visible: {send_but_visible}")
            if not send_but_visible:
                page.evaluate("() => { jQuery('#api_button_openai').trigger('click'); }")
                time.sleep(5)
                send_but_visible = page.evaluate("() => !jQuery('#send_but').hasClass('displayNone')")
                print(f"  [PW] send_but visible (retry): {send_but_visible}")

            # 3. 选择角色
            print(f"  [PW] Selecting character: {char_name}")
            char_found = False

            # 方法1: 通过 .character_select 文本匹配
            try:
                char_locator = page.locator(f".character_select:has-text('{char_name}')")
                if char_locator.count() > 0:
                    char_locator.first.click(timeout=5000)
                    char_found = True
                    print(f"  [PW] Clicked character_select")
            except Exception:
                pass

            # 方法2: 通过 [class*='character_select_container'] 文本匹配
            if not char_found:
                try:
                    char_locator = page.locator(f"[class*='character_select_container']:has-text('{char_name}')")
                    if char_locator.count() > 0:
                        char_locator.first.click(timeout=5000)
                        char_found = True
                        print(f"  [PW] Clicked character_select_container")
                except Exception:
                    pass

            # 方法3: 通过 ST API 获取 chid，jQuery 点击
            if not char_found:
                try:
                    chars_response = _st_json("/api/characters/all", {})
                    chars_list = chars_response.get("characters", []) if isinstance(chars_response, dict) else chars_response
                    chid = None
                    for i, c in enumerate(chars_list):
                        if c.get("name") == char_name:
                            chid = i
                            break
                    if chid is not None:
                        page.evaluate(f"""
                        () => {{
                            const chars = document.querySelectorAll('.character_select');
                            if (chars[{chid}]) chars[{chid}].click();
                        }}
                        """)
                        char_found = True
                        print(f"  [PW] Clicked character by index {chid}")
                except Exception as e:
                    print(f"  [PW] Method 3 failed: {e}")

            if not char_found:
                print(f"  [PW] Character not found")
                page.screenshot(path="/tmp/st_char_not_found.png")
                return False

            # 等待聊天加载
            time.sleep(5)
            page.wait_for_load_state("networkidle", timeout=15000)

            # 4. 输入消息
            print(f"  [PW] Typing: {current_message[:50]}...")
            textarea = page.locator("#send_textarea")
            textarea.wait_for(state="visible", timeout=10000)
            textarea.click()
            time.sleep(0.5)
            textarea.fill(current_message)
            page.evaluate("() => { jQuery('#send_textarea').trigger('input'); }")
            time.sleep(1)

            # 5. 发送
            print("  [PW] Sending...")
            # 移除 displayNone 确保 send_but 可点击
            page.evaluate("() => { jQuery('#send_but').removeClass('displayNone'); }")
            time.sleep(0.5)

            sent = False
            try:
                send_btn = page.locator("#send_but")
                if send_btn.is_visible():
                    send_btn.click(timeout=5000)
                    sent = True
                    print("  [PW] Send via click")
            except Exception:
                pass

            if not sent:
                try:
                    page.evaluate("() => { jQuery('#send_but').trigger('click'); }")
                    sent = True
                    print("  [PW] Send via jQuery trigger")
                except Exception:
                    pass

            if not sent:
                try:
                    textarea.press("Enter")
                    sent = True
                    print("  [PW] Send via Enter")
                except Exception:
                    pass

            if not sent:
                print("  [PW] All send methods failed")
                return False

            # 6. 等待（捕获服务器会在收到请求时设置 event）
            print(f"  [PW] Waiting for capture (timeout {timeout}s)...")
            # 不需要在这里等待 - 调用方会检查 capture_event
            time.sleep(5)  # 给 ST 时间发送请求

            if page_errors:
                print(f"  [PW] Page errors: {page_errors[:3]}")

            return True

        except Exception as e:
            print(f"  [PW] Error: {e}")
            try:
                page.screenshot(path="/tmp/st_capture_error.png")
            except Exception:
                pass
            return False
        finally:
            browser.close()


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def run_scenario(name: str, fixture: dict) -> bool:
    print(f"\n{'='*60}")
    print(f"场景: {name}")
    print(f"{'='*60}")

    char_name = f"GoldenTest_{name}"
    chat_file = f"{char_name} - 2024-01-01T12:00:00Z"

    # -1. 预清理同名残留角色卡（防止重名后缀问题）
    cleanup_existing_characters(char_name)

    # 0. 备份 ST settings
    print("  [SETUP] Backing up ST settings...")
    try:
        original_settings = backup_st_settings()
    except Exception as e:
        print(f"  [FAIL] Cannot backup settings: {e}")
        return False

    # 1. 修改 ST custom_url 指向捕获服务器
    try:
        set_st_custom_url(CAPTURE_URL_FOR_ST, original_settings)
    except Exception as e:
        print(f"  [FAIL] Cannot set custom_url: {e}")
        return False

    # 2. 启动捕获服务器
    server = start_capture_server()

    # 3. 创建角色卡和聊天
    try:
        avatar = create_character(char_name, fixture)
    except Exception as e:
        print(f"  [FAIL] Character creation: {e}")
        stop_capture_server(server)
        restore_st_settings(original_settings)
        return False

    # 3.5 创建并关联 worldbook（如果 fixture 有）
    wb_name = None
    if fixture.get("worldbook"):
        try:
            wb_name = create_worldbook(fixture["worldbook"])
            link_worldbook_to_character(avatar, wb_name)
            time.sleep(1)  # 等待 ST 处理关联
        except Exception as e:
            print(f"  [WARN] Worldbook import failed: {e}")
            wb_name = None

    save_chat(char_name, fixture["chat_messages"], fixture["first_mes"], chat_file)

    # 4. Playwright 触发发送
    current_msg = fixture.get("current_message", "")
    if not current_msg:
        for m in reversed(fixture["chat_messages"]):
            if m["role"] == "user":
                current_msg = m["content"]
                break

    ui_success = trigger_send_via_playwright(char_name, current_msg, timeout=60)

    # 5. 等待捕获
    captured = None
    if ui_success:
        print("  [WAIT] Waiting for capture server...")
        if CaptureHandler.capture_event.wait(timeout=30):
            captured = CaptureHandler.captured_data
        else:
            print("  [WAIT] Capture timeout (30s)")

    # 6. 停止捕获服务器
    stop_capture_server(server)

    # 7. 恢复 ST settings
    restore_st_settings(original_settings)

    # 8. 保存结果
    success = False
    if captured and captured.get("messages"):
        captured["scenario_name"] = name
        captured["fixture"] = name
        captured["source"] = "sillytavern"
        captured["st_version"] = "1.18.0"
        captured["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        out = OUTPUT_DIR / f"st_{name}.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(captured, f, ensure_ascii=False, indent=2)
        print(f"  [OK] Saved: {out}")
        success = True
    else:
        print("  [FAIL] No capture data")

    # 9. 清理角色卡和 worldbook
    delete_character(char_name)
    if wb_name:
        delete_worldbook(wb_name)
    return success


def main():
    parser = argparse.ArgumentParser(description="ST golden vector capture")
    parser.add_argument("--scenario", choices=list(FIXTURES.keys()))
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    if not args.scenario and not args.all:
        parser.print_help()
        sys.exit(1)

    scenarios = list(FIXTURES.keys()) if args.all else [args.scenario]
    results = {}
    for name in scenarios:
        results[name] = run_scenario(name, FIXTURES[name])

    print(f"\n{'='*60}")
    print("捕获结果:")
    for n, ok in results.items():
        print(f"  st_{n}.json: {'OK' if ok else 'FAIL'}")


if __name__ == "__main__":
    main()
