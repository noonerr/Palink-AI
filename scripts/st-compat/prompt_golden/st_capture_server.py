"""ST 侧提示词黄金向量捕获服务器。

一个最小化 HTTP 服务器，模拟 OpenAI-compatible 后端。
当 ST 前端发送 /api/backends/chat-completions/generate 请求时，
将完整请求体（含 messages 数组）记录为黄金向量 JSON。

用法:
    python st_capture_server.py --port 8899 --output results/st_basic_char.json

然后在 ST 中:
    1. API 连接 → Custom (OpenAI-compatible)
    2. 服务器地址: http://<host>:8899/v1
    3. 模型名: capture-model
    4. 触发一次生成
    5. 捕获的 messages 将写入 output 文件
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse


class CaptureHandler(BaseHTTPRequestHandler):
    """捕获 ST 发送的 generate 请求并返回最小有效流式响应。"""

    output_path: str = ""
    capture_count: int = 0
    max_captures: int = 1
    fixture_name: str = ""

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        # 捕获 generate 请求
        if "generate" in parsed.path or "chat/completions" in parsed.path:
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = {"raw": body.decode("utf-8", errors="replace")}

            golden = {
                "fixture": CaptureHandler.fixture_name or "captured_from_st",
                "source": "sillytavern",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "scenario_name": CaptureHandler.fixture_name,
                "st_version": "1.18.0",
                "messages": payload.get("messages", []),
                "model": payload.get("model", ""),
                "temperature": payload.get("temperature"),
                "top_p": payload.get("top_p"),
                "max_tokens": payload.get("max_tokens"),
                "frequency_penalty": payload.get("frequency_penalty"),
                "presence_penalty": payload.get("presence_penalty"),
                "stream": payload.get("stream", False),
                "full_payload": payload,
            }

            CaptureHandler.capture_count += 1
            out_path = self.output_path
            if CaptureHandler.capture_count > 1:
                # 多次捕获时追加序号
                p = Path(out_path)
                out_path = str(p.parent / f"{p.stem}_{CaptureHandler.capture_count}{p.suffix}")

            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(golden, f, ensure_ascii=False, indent=2)

            print(f"[CAPTURED #{CaptureHandler.capture_count}] {len(golden['messages'])} messages → {out_path}")

            # 返回最小有效流式响应（让 ST 不报错）
            if payload.get("stream"):
                self._send_stream_response(payload.get("model", "capture-model"))
            else:
                self._send_complete_response(payload.get("model", "capture-model"))

            if CaptureHandler.capture_count >= self.max_captures:
                print(f"[DONE] Reached max captures ({self.max_captures}). Shutting down...")
                # 延迟关闭（让响应发完）
                import threading
                threading.Timer(1.0, lambda: sys.exit(0)).start()
            return

        # 其他 POST 端点（如 /v1/models）
        if "models" in parsed.path:
            self._send_json({
                "object": "list",
                "data": [{"id": "capture-model", "object": "model", "owned_by": "capture"}]
            })
            return

        self._send_json({"ok": True})

    def do_GET(self):
        parsed = urlparse(self.path)
        if "models" in parsed.path:
            self._send_json({
                "object": "list",
                "data": [{"id": "capture-model", "object": "model", "owned_by": "capture"}]
            })
        else:
            self._send_json({"status": "capture_server_running"})

    def _send_stream_response(self, model: str):
        """返回最小 SSE 流式响应。"""
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

    def _send_complete_response(self, model: str):
        """返回最小完整响应。"""
        self._send_json({
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "[CAPTURED]"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1},
        })

    def _send_json(self, data: dict):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """处理 CORS preflight。"""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def log_message(self, format, *args):
        # 静默默认日志，只输出捕获信息
        pass


def main():
    parser = argparse.ArgumentParser(description="ST prompt capture server")
    parser.add_argument("--port", type=int, default=8899, help="Listen port")
    parser.add_argument("--output", type=str, default="results/st_captured.json",
                        help="Output path for captured golden vector")
    parser.add_argument("--max-captures", type=int, default=1,
                        help="Number of captures before auto-shutdown (0=unlimited)")
    parser.add_argument("--fixture", type=str, default="",
                        help="Fixture/scenario name written to scenario_name (e.g. basic_char)")
    args = parser.parse_args()

    CaptureHandler.output_path = args.output
    CaptureHandler.max_captures = args.max_captures if args.max_captures > 0 else 99999
    CaptureHandler.fixture_name = args.fixture

    server = HTTPServer(("0.0.0.0", args.port), CaptureHandler)
    print(f"[ST Capture Server] Listening on port {args.port}")
    print(f"[ST Capture Server] Output: {args.output}")
    print(f"[ST Capture Server] Configure ST to use: http://<this-host>:{args.port}/v1")
    print(f"[ST Capture Server] Waiting for generate request...")
    try:
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        print("\n[ST Capture Server] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
