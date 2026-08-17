#!/usr/bin/env python3
"""
Palink-AI 浏览器烟测自动启动本地服务脚本 (Phase 5 Task 5.5).

功能：
  1. 自动启动 docker-compose.dev.yml 服务（如未运行）
  2. 等待前端 / 后端 / SillyTavern sidecar 全部就绪
  3. 执行 5 个最小化浏览器测试场景（首页加载 / 登录 / 角色列表 / 设置 / 插件管理）
  4. 测试结束后默认清理服务（除非指定 --keep-running）
  5. 输出汇总：`Browser Smoke Test: N/M passed`

运行：
  python scripts/browser_smoke_test.py [--keep-running] [--no-build] [--timeout 120]

环境变量：
  PALINK_URL             - 前端基础 URL（默认 http://localhost:3100，对应 docker-compose.dev.yml 端口映射）
  PALINK_SMOKE_USER      - 登录用户名（默认 admin）
  PALINK_SMOKE_PASSWORD  - 登录密码（默认 admin123）
  PALINK_TOKEN           - 直接注入的 JWT token（可选，未设置则用账号密码登录）
  PALINK_BACKEND_URL     - 后端基础 URL（默认 http://localhost:8000）
  PALINK_ST_URL          - SillyTavern sidecar URL（默认 http://localhost:8001）

退出码：
  0 - 全部通过
  1 - 有失败用例
  2 - 环境错误（Docker 未运行 / 服务启动超时等）
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

# ============================================================
# 常量
# ============================================================

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
COMPOSE_FILE = PROJECT_ROOT / "docker-compose.dev.yml"
SCREENSHOTS_DIR = SCRIPT_DIR / "screenshots"

DEFAULT_FRONTEND_URL = os.environ.get("PALINK_URL", "http://localhost:3100")
DEFAULT_BACKEND_URL = os.environ.get("PALINK_BACKEND_URL", "http://localhost:8000")
DEFAULT_ST_URL = os.environ.get("PALINK_ST_URL", "http://localhost:8001")
DEFAULT_USER = os.environ.get("PALINK_SMOKE_USER", "admin")
DEFAULT_PASSWORD = os.environ.get("PALINK_SMOKE_PASSWORD", "admin123")
DEFAULT_TOKEN = os.environ.get("PALINK_TOKEN", "")

SERVICE_STARTUP_TIMEOUT = 120  # 秒，服务启动总等待时间
SERVICE_POLL_INTERVAL = 2  # 秒，轮询间隔
BROWSER_TEST_TIMEOUT = 30  # 秒，单个浏览器测试最大耗时
HTTP_REQUEST_TIMEOUT = 5  # 秒，HTTP 轮询单次超时

# Windows 下 Docker / Node 常见安装路径
WINDOWS_PATH_PREFIXES = [
    r"C:\Program Files\Docker\Docker\resources\bin",
    r"C:\Program Files\nodejs",
    r"C:\Users\Pall\AppData\Roaming\npm",
]


# ============================================================
# 日志
# ============================================================

class Logger:
    """简单的带前缀日志器。"""

    @staticmethod
    def info(msg: str) -> None:
        print(f"[INFO] {msg}", flush=True)

    @staticmethod
    def warn(msg: str) -> None:
        print(f"[WARN] {msg}", flush=True)

    @staticmethod
    def error(msg: str) -> None:
        print(f"[ERROR] {msg}", file=sys.stderr, flush=True)

    @staticmethod
    def success(msg: str) -> None:
        print(f"[OK] {msg}", flush=True)

    @staticmethod
    def step(msg: str) -> None:
        print(f"\n=== {msg} ===", flush=True)


# ============================================================
# 工具函数
# ============================================================

def is_windows() -> bool:
    return os.name == "nt"


def ensure_path() -> None:
    """在 Windows 下把 Docker / Node 路径加入 PATH（如果缺失）。"""
    if not is_windows():
        return
    current_path = os.environ.get("PATH", "")
    missing = [p for p in WINDOWS_PATH_PREFIXES if p and p not in current_path]
    if missing:
        os.environ["PATH"] = ";".join(missing) + ";" + current_path
        Logger.info(f"已将以下路径加入 PATH: {missing}")


def run_command(cmd: list[str], *, check: bool = False, capture: bool = True,
                 cwd: Optional[Path] = None, timeout: Optional[int] = None) -> tuple[int, str, str]:
    """运行命令并返回 (returncode, stdout, stderr)。"""
    try:
        result = subprocess.run(
            cmd,
            capture_output=capture,
            text=True,
            cwd=str(cwd) if cwd else None,
            timeout=timeout,
            shell=False,
        )
        return result.returncode, result.stdout or "", result.stderr or ""
    except FileNotFoundError:
        return 127, "", f"命令未找到: {cmd[0]}"
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", f"命令超时: {e}"


def docker_cmd() -> list[str]:
    """返回 docker compose 命令前缀（兼容 v1/v2）。"""
    return ["docker", "compose", "-f", str(COMPOSE_FILE)]


def http_get(url: str, *, timeout: int = HTTP_REQUEST_TIMEOUT,
             headers: Optional[dict] = None) -> tuple[int, str]:
    """发起 GET 请求，返回 (status_code, body_text)。失败返回 (0, error_msg)。"""
    req = urllib.request.Request(url, method="GET")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return e.code, body
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
        return 0, str(e)


def http_post_form(url: str, form: dict, *, timeout: int = HTTP_REQUEST_TIMEOUT,
                   headers: Optional[dict] = None) -> tuple[int, str]:
    """发起 POST application/x-www-form-urlencoded 请求。"""
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return e.code, body
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
        return 0, str(e)


def http_post_json(url: str, json_body: Optional[dict] = None, *,
                   timeout: int = HTTP_REQUEST_TIMEOUT,
                   headers: Optional[dict] = None) -> tuple[int, str]:
    """发起 POST application/json 请求（body 可为空）。"""
    data = json.dumps(json_body).encode("utf-8") if json_body is not None else b""
    req = urllib.request.Request(url, data=data if data else None, method="POST")
    req.add_header("Content-Type", "application/json")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return e.code, body
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
        return 0, str(e)


# ============================================================
# Docker 服务管理
# ============================================================

def check_docker_running() -> bool:
    """检查 Docker daemon 是否在运行。"""
    code, _, err = run_command(["docker", "info"])
    if code == 0:
        return True
    Logger.error(f"Docker 不可用: {err.strip() or 'docker info 返回非 0'}")
    return False


def get_compose_services_status() -> dict[str, str]:
    """返回 {service_name: state}，state 为 'running' / 'exited' / 'absent' 等。"""
    cmd = docker_cmd() + ["ps", "--format", "json"]
    code, out, err = run_command(cmd, cwd=PROJECT_ROOT)
    services: dict[str, str] = {}
    if code != 0:
        Logger.warn(f"docker compose ps 失败 (code={code}): {err.strip()}")
        return services
    # docker compose ps --format json 每行一个 JSON 对象
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        # 字段名可能因 docker 版本不同：Service / service
        name = obj.get("Service") or obj.get("service") or ""
        state = obj.get("State") or obj.get("state") or ""
        if name:
            services[name] = state
    return services


def is_dev_services_running() -> bool:
    """检查 frontend + sillytavern 是否都在运行。"""
    services = get_compose_services_status()
    if not services:
        return False
    frontend_ok = services.get("frontend") == "running"
    st_ok = services.get("sillytavern") == "running"
    return frontend_ok and st_ok


def start_dev_services(*, build: bool = True) -> bool:
    """执行 docker compose up -d [--build]。"""
    cmd = docker_cmd() + ["up", "-d"]
    if build:
        cmd.append("--build")
    Logger.info(f"启动服务: {' '.join(cmd)}")
    # 构建可能耗时较长，不设短超时
    code, out, err = run_command(cmd, cwd=PROJECT_ROOT, timeout=600)
    if code != 0:
        Logger.error(f"docker compose up 失败 (code={code})")
        if out.strip():
            Logger.info(out.strip()[-2000:])
        if err.strip():
            Logger.error(err.strip()[-2000:])
        return False
    if out.strip():
        Logger.info(out.strip()[-1000:])
    return True


def stop_dev_services() -> bool:
    """执行 docker compose down。"""
    cmd = docker_cmd() + ["down"]
    Logger.info(f"停止服务: {' '.join(cmd)}")
    code, out, err = run_command(cmd, cwd=PROJECT_ROOT, timeout=120)
    if code != 0:
        Logger.warn(f"docker compose down 返回 code={code}: {err.strip()}")
        return False
    if out.strip():
        Logger.info(out.strip()[-500:])
    return True


# ============================================================
# 服务就绪轮询
# ============================================================

def wait_for_url(url: str, name: str, *, timeout: int = SERVICE_STARTUP_TIMEOUT,
                 expected_status: int = 200) -> bool:
    """轮询 URL 直到返回期望状态码或超时。"""
    Logger.info(f"等待 {name} 就绪: {url} (超时 {timeout}s)")
    deadline = time.time() + timeout
    last_error = ""
    while time.time() < deadline:
        code, body = http_get(url)
        if code == expected_status:
            Logger.success(f"{name} 就绪 (HTTP {code})")
            return True
        # 某些服务在启动过程中可能返回 502/503，视为待重试
        last_error = f"HTTP {code}: {body[:120]}" if code else body[:120]
        time.sleep(SERVICE_POLL_INTERVAL)
    Logger.error(f"{name} 在 {timeout}s 内未就绪。最后状态: {last_error}")
    return False


def wait_for_url_any_status(url: str, name: str, *, timeout: int = SERVICE_STARTUP_TIMEOUT,
                            accept_statuses: tuple[int, ...] = (200, 401, 403, 422, 302),
                            log_detail: str = "") -> bool:
    """轮询 URL 直到返回 accept_statuses 中任一状态码或超时。

    用于后端 API 探测：401/422 也算服务就绪（说明后端在响应，只是需要认证/参数）。
    """
    Logger.info(f"等待 {name} 就绪: {url} (超时 {timeout}s, 接受状态: {accept_statuses})")
    if log_detail:
        Logger.info(f"  {log_detail}")
    deadline = time.time() + timeout
    last_error = ""
    while time.time() < deadline:
        code, body = http_get(url)
        if code in accept_statuses:
            Logger.success(f"{name} 就绪 (HTTP {code})")
            return True
        last_error = f"HTTP {code}: {body[:120]}" if code else body[:120]
        time.sleep(SERVICE_POLL_INTERVAL)
    Logger.error(f"{name} 在 {timeout}s 内未就绪。最后状态: {last_error}")
    return False


def wait_for_frontend(url: str, timeout: int) -> bool:
    """前端就绪：GET / 返回 200（Vite dev server / nginx）。"""
    return wait_for_url(url, "前端", timeout=timeout, expected_status=200)


def wait_for_backend(backend_url: str, frontend_url: str, timeout: int) -> bool:
    """后端就绪：优先直接访问 backend_url/health，失败则通过前端代理探测 /api。

    后端容器可能仅 expose 而未映射主机端口（docker-compose.yml 中 backend 只 expose 8000），
    此时直接访问 localhost:8000 会失败，需通过前端 Vite/nginx 代理（/api/* → backend:8000）探测。
    代理探测下 401/403/404/405/422 也算就绪（说明后端在响应，只是需要认证/方法不对）。
    """
    # 方式 1：直接访问后端健康检查端点
    if backend_url:
        direct_url = backend_url.rstrip("/") + "/health"
        Logger.info(f"尝试直接访问后端: {direct_url}")
        if wait_for_url(direct_url, "后端(直接)", timeout=timeout, expected_status=200):
            return True
        Logger.warn("后端直接访问失败，尝试通过前端代理探测...")

    # 方式 2：通过前端代理访问 /api 端点
    # 使用 /api/plugins（GET 端点，存在但需要认证 → 401 表示后端在响应）
    proxy_url = frontend_url.rstrip("/") + "/api/plugins"
    # 任何 2xx/3xx/4xx 响应都说明后端在响应（只有 502/503/504 或连接失败才说明后端未就绪）
    return wait_for_url_any_status(
        proxy_url, "后端(代理)",
        timeout=timeout,
        accept_statuses=(200, 301, 302, 307, 401, 403, 404, 405, 422),
        log_detail="后端容器可能仅 expose 未映射主机端口，4xx 也算就绪（后端在响应）",
    )


def wait_for_sillytavern(st_url: str, timeout: int, *, required: bool = False) -> bool:
    """SillyTavern sidecar 就绪：GET / 返回 200/401/302/403 即可。

    当 docker-compose.dev.yml 生效时，ST 应映射到主机 8001 端口。
    若 ST 不可直接访问（如使用 docker-compose.yml 的 expose 模式），则根据 required 决定是否失败。
    """
    if not st_url:
        Logger.warn("未配置 SillyTavern URL，跳过 sidecar 就绪检查")
        return not required
    Logger.info(f"等待 SillyTavern sidecar 就绪: {st_url} (超时 {timeout}s)")
    deadline = time.time() + timeout
    last_error = ""
    while time.time() < deadline:
        code, body = http_get(st_url)
        # ST 启动后访问根路径可能返回 200 / 401 / 302 / 403，只要 TCP 通了就算就绪
        if code in (200, 401, 302, 403):
            Logger.success(f"SillyTavern sidecar 就绪 (HTTP {code})")
            return True
        last_error = f"HTTP {code}: {body[:120]}" if code else body[:120]
        time.sleep(SERVICE_POLL_INTERVAL)
    if required:
        Logger.error(f"SillyTavern sidecar 在 {timeout}s 内未就绪。最后状态: {last_error}")
        return False
    Logger.warn(f"SillyTavern sidecar 不可直接访问（{last_error}），跳过（非必需）")
    Logger.warn("如需访问 ST，请确保通过 docker-compose.dev.yml 启动（端口映射 8001:8000）")
    return True


def wait_for_services(frontend_url: str, backend_url: str, st_url: str,
                      timeout: int) -> bool:
    """等待全部服务就绪。"""
    Logger.step("等待服务就绪")
    # 三个服务串行轮询，每个独立计时
    remaining = timeout
    start = time.time()
    if not wait_for_frontend(frontend_url, remaining):
        return False
    remaining = max(10, timeout - int(time.time() - start))
    if not wait_for_backend(backend_url, frontend_url, remaining):
        return False
    remaining = max(10, timeout - int(time.time() - start))
    # SillyTavern 非必需（sidecar 可能未映射主机端口）
    if not wait_for_sillytavern(st_url, remaining, required=False):
        return False
    return True


# ============================================================
# Playwright 检测
# ============================================================

def detect_python_playwright() -> bool:
    """检测 Python playwright 是否可用。"""
    try:
        import playwright  # noqa: F401
        from playwright.sync_api import sync_playwright  # noqa: F401
        return True
    except ImportError:
        return False


def detect_node_playwright() -> bool:
    """检测 Node 端 playwright 是否可用（项目 root package.json devDependencies 中包含）。"""
    code, out, _ = run_command(
        ["node", "-e", "require('playwright'); console.log('ok');"],
        cwd=PROJECT_ROOT,
    )
    return code == 0 and "ok" in out


def detect_chromium_browser() -> bool:
    """检测 Playwright Chromium 浏览器是否已安装。"""
    # Python 端
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            if p.chromium.executable_path and os.path.exists(p.chromium.executable_path):
                return True
    except Exception:
        pass
    # Node 端：检查缓存目录
    if is_windows():
        cache_dirs = [
            os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright"),
            os.path.expanduser("~/AppData/Local/ms-playwright"),
        ]
    else:
        cache_dirs = [
            os.path.expanduser("~/.cache/ms-playwright"),
            "/root/.cache/ms-playwright",
        ]
    for d in cache_dirs:
        if os.path.isdir(d):
            for name in os.listdir(d):
                if name.startswith("chromium"):
                    return True
    return False


# ============================================================
# 浏览器测试场景（Playwright 模式）
# ============================================================

class TestResult:
    """单个测试场景结果。"""
    def __init__(self, name: str, passed: bool, detail: str = "",
                 screenshot: Optional[str] = None):
        self.name = name
        self.passed = passed
        self.detail = detail
        self.screenshot = screenshot

    def __repr__(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        return f"[{status}] {self.name}: {self.detail}"


def run_playwright_tests(frontend_url: str, username: str, password: str,
                         token: str, screenshots_dir: Path) -> list[TestResult]:
    """使用 Python Playwright 执行 5 个测试场景。"""
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

    results: list[TestResult] = []
    screenshots_dir.mkdir(parents=True, exist_ok=True)

    def screenshot_path(name: str) -> str:
        return str(screenshots_dir / f"{name}.png")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        page = context.new_page()
        page.set_default_timeout(BROWSER_TEST_TIMEOUT * 1000)

        # ----- 场景 1: 访问首页 -----
        Logger.step("场景 1/5: 访问首页")
        try:
            resp = page.goto(frontend_url, wait_until="domcontentloaded",
                             timeout=BROWSER_TEST_TIMEOUT * 1000)
            status = resp.status if resp else 0
            passed = status == 200
            shot = screenshot_path("01_home")
            try:
                page.screenshot(path=shot, full_page=True)
            except Exception as e:
                shot = None
                Logger.warn(f"截图失败: {e}")
            results.append(TestResult("首页加载", passed,
                                      f"HTTP {status}", shot))
            Logger.info(f"首页 HTTP {status}")
        except Exception as e:
            results.append(TestResult("首页加载", False, str(e)[:200]))

        # ----- 场景 2: 登录 -----
        Logger.step("场景 2/5: 登录")
        try:
            if token:
                # 直接注入 token
                page.goto(f"{frontend_url}/login", wait_until="domcontentloaded",
                          timeout=BROWSER_TEST_TIMEOUT * 1000)
                page.evaluate(f"localStorage.setItem('palink_token', {json.dumps(token)})")
                results.append(TestResult("登录", True, "使用环境变量 token 注入",
                                          screenshot_path("02_login")))
                try:
                    page.screenshot(path=screenshot_path("02_login"), full_page=True)
                except Exception:
                    pass
            else:
                page.goto(f"{frontend_url}/login", wait_until="networkidle",
                          timeout=BROWSER_TEST_TIMEOUT * 1000)
                login_result = page.evaluate(
                    """async ({username, password}) => {
                        const body = new URLSearchParams();
                        body.set('username', username);
                        body.set('password', password);
                        const response = await fetch('/api/token', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body,
                        });
                        const text = await response.text();
                        let json = null;
                        try { json = JSON.parse(text); } catch {}
                        if (json?.access_token) localStorage.setItem('palink_token', json.access_token);
                        return {
                            status: response.status,
                            ok: response.ok,
                            hasToken: Boolean(json?.access_token),
                            text: text.slice(0, 200),
                        };
                    }""",
                    {"username": username, "password": password},
                )
                passed = bool(login_result.get("ok") and login_result.get("hasToken"))
                shot = screenshot_path("02_login")
                try:
                    page.screenshot(path=shot, full_page=True)
                except Exception:
                    shot = None
                results.append(TestResult("登录", passed,
                                          f"status={login_result.get('status')} hasToken={login_result.get('hasToken')}",
                                          shot))
                Logger.info(f"登录结果: {login_result}")
        except Exception as e:
            results.append(TestResult("登录", False, str(e)[:200]))

        # ----- 场景 3: 角色列表页 -----
        Logger.step("场景 3/5: 角色列表页")
        try:
            resp = page.goto(f"{frontend_url}/characters", wait_until="domcontentloaded",
                             timeout=BROWSER_TEST_TIMEOUT * 1000)
            # 等待页面渲染
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except PWTimeout:
                pass
            status = resp.status if resp else 0
            # 验证页面不是 404 / 未跳回 login
            current_url = page.url
            passed = status == 200 and "/login" not in current_url
            shot = screenshot_path("03_characters")
            try:
                page.screenshot(path=shot, full_page=True)
            except Exception:
                shot = None
            results.append(TestResult("角色列表页", passed,
                                      f"HTTP {status} url={current_url}", shot))
            Logger.info(f"角色列表页 HTTP {status} -> {current_url}")
        except Exception as e:
            results.append(TestResult("角色列表页", False, str(e)[:200]))

        # ----- 场景 4: 设置页 -----
        Logger.step("场景 4/5: 设置页")
        try:
            resp = page.goto(f"{frontend_url}/settings", wait_until="domcontentloaded",
                             timeout=BROWSER_TEST_TIMEOUT * 1000)
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except PWTimeout:
                pass
            status = resp.status if resp else 0
            current_url = page.url
            passed = status == 200 and "/login" not in current_url
            shot = screenshot_path("04_settings")
            try:
                page.screenshot(path=shot, full_page=True)
            except Exception:
                shot = None
            results.append(TestResult("设置页", passed,
                                      f"HTTP {status} url={current_url}", shot))
            Logger.info(f"设置页 HTTP {status} -> {current_url}")
        except Exception as e:
            results.append(TestResult("设置页", False, str(e)[:200]))

        # ----- 场景 5: 插件管理页（settings 下的 tab）-----
        Logger.step("场景 5/5: 插件管理页")
        try:
            # 先直接调用后端 API 验证插件管理功能可用
            api_result = page.evaluate(
                """async () => {
                    const token = localStorage.getItem('palink_token') || '';
                    const headers = token ? { Authorization: `Bearer ${token}` } : {};
                    const response = await fetch('/api/plugins', { headers });
                    const text = await response.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return {
                        status: response.status,
                        ok: response.ok,
                        count: Array.isArray(json) ? json.length : (json?.items?.length || 0),
                        text: text.slice(0, 200),
                    };
                }"""
            )
            # 截图当前 settings 页面（插件 tab 在 settings 内）
            shot = screenshot_path("05_plugins")
            try:
                page.screenshot(path=shot, full_page=True)
            except Exception:
                shot = None
            passed = bool(api_result.get("ok"))
            results.append(TestResult("插件管理页", passed,
                                      f"API status={api_result.get('status')} count={api_result.get('count')}",
                                      shot))
            Logger.info(f"插件 API 结果: {api_result}")
        except Exception as e:
            results.append(TestResult("插件管理页", False, str(e)[:200]))

        browser.close()

    return results


# ============================================================
# Node Playwright 模式（项目 root 已安装 playwright npm 包时使用）
# ============================================================

NODE_PLAYWRIGHT_SCRIPT_TEMPLATE = r"""
// 自动生成的临时脚本，由 browser_smoke_test.py 调用
// 使用项目 root 已安装的 playwright npm 包执行 5 个浏览器测试场景
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.PALINK_URL || 'http://localhost:3100';
const USERNAME = process.env.PALINK_SMOKE_USER || 'admin';
const PASSWORD = process.env.PALINK_SMOKE_PASSWORD || 'admin123';
const TOKEN = process.env.PALINK_TOKEN || '';
const SCREENSHOTS_DIR = process.env.PALINK_SCREENSHOTS_DIR || '';
const TIMEOUT = 30000;

if (SCREENSHOTS_DIR) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function shotPath(name) {
  return SCREENSHOTS_DIR ? path.join(SCREENSHOTS_DIR, name + '.png') : '';
}

async function login(page) {
  if (TOKEN) {
    await page.goto(BASE_URL + '/login', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.evaluate((t) => localStorage.setItem('palink_token', t), TOKEN);
    return { source: 'env-token' };
  }
  await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: TIMEOUT });
  const result = await page.evaluate(async ({ username, password }) => {
    const body = new URLSearchParams();
    body.set('username', username);
    body.set('password', password);
    const response = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (json && json.access_token) localStorage.setItem('palink_token', json.access_token);
    return {
      status: response.status,
      ok: response.ok,
      hasToken: Boolean(json && json.access_token),
      text: text.slice(0, 200),
    };
  }, { username: USERNAME, password: PASSWORD });
  return result;
}

(async () => {
  const results = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // 场景 1: 首页
  try {
    const resp = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const status = resp ? resp.status() : 0;
    const passed = status === 200;
    try { await page.screenshot({ path: shotPath('01_home'), fullPage: true }); } catch {}
    results.push({ name: '首页加载', passed, detail: 'HTTP ' + status, screenshot: shotPath('01_home') });
  } catch (e) {
    results.push({ name: '首页加载', passed: false, detail: String(e.message || e).slice(0, 200) });
  }

  // 场景 2: 登录
  try {
    const loginResult = await login(page);
    const passed = TOKEN ? true : (loginResult.ok && loginResult.hasToken);
    try { await page.screenshot({ path: shotPath('02_login'), fullPage: true }); } catch {}
    results.push({
      name: '登录',
      passed,
      detail: TOKEN ? '使用环境变量 token' : ('status=' + loginResult.status + ' hasToken=' + loginResult.hasToken),
      screenshot: shotPath('02_login'),
    });
  } catch (e) {
    results.push({ name: '登录', passed: false, detail: String(e.message || e).slice(0, 200) });
  }

  // 场景 3: 角色列表页
  try {
    const resp = await page.goto(BASE_URL + '/characters', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
    const status = resp ? resp.status() : 0;
    const currentUrl = page.url();
    const passed = status === 200 && !currentUrl.includes('/login');
    try { await page.screenshot({ path: shotPath('03_characters'), fullPage: true }); } catch {}
    results.push({ name: '角色列表页', passed, detail: 'HTTP ' + status + ' url=' + currentUrl, screenshot: shotPath('03_characters') });
  } catch (e) {
    results.push({ name: '角色列表页', passed: false, detail: String(e.message || e).slice(0, 200) });
  }

  // 场景 4: 设置页
  try {
    const resp = await page.goto(BASE_URL + '/settings', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
    const status = resp ? resp.status() : 0;
    const currentUrl = page.url();
    const passed = status === 200 && !currentUrl.includes('/login');
    try { await page.screenshot({ path: shotPath('04_settings'), fullPage: true }); } catch {}
    results.push({ name: '设置页', passed, detail: 'HTTP ' + status + ' url=' + currentUrl, screenshot: shotPath('04_settings') });
  } catch (e) {
    results.push({ name: '设置页', passed: false, detail: String(e.message || e).slice(0, 200) });
  }

  // 场景 5: 插件管理 API
  try {
    const apiResult = await page.evaluate(async () => {
      const token = localStorage.getItem('palink_token') || '';
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      const response = await fetch('/api/plugins', { headers });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {
        status: response.status,
        ok: response.ok,
        count: Array.isArray(json) ? json.length : (json && json.items ? json.items.length : 0),
      };
    });
    try { await page.screenshot({ path: shotPath('05_plugins'), fullPage: true }); } catch {}
    results.push({
      name: '插件管理页',
      passed: !!apiResult.ok,
      detail: 'API status=' + apiResult.status + ' count=' + apiResult.count,
      screenshot: shotPath('05_plugins'),
    });
  } catch (e) {
    results.push({ name: '插件管理页', passed: false, detail: String(e.message || e).slice(0, 200) });
  }

  await browser.close();
  // 输出 JSON 结果到 stdout（Python 解析这一行）
  console.log('===RESULTS_JSON===');
  console.log(JSON.stringify(results));
})().catch((e) => {
  console.error('Node Playwright 脚本异常:', e);
  process.exit(1);
});
"""


def run_node_playwright_tests(frontend_url: str, username: str, password: str,
                              token: str, screenshots_dir: Path) -> list[TestResult]:
    """使用 Node Playwright（项目 root 已安装的 npm 包）执行 5 个测试场景。

    生成临时 .cjs 脚本并通过 node 调用，解析 JSON 输出。
    """
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    # 写入临时 .cjs 脚本到项目 root（确保 Node 能找到 node_modules/playwright）
    script_path = PROJECT_ROOT / ".palink_smoke_test_tmp.cjs"
    script_path.write_text(NODE_PLAYWRIGHT_SCRIPT_TEMPLATE, encoding="utf-8")

    # 准备环境变量
    env = os.environ.copy()
    env["PALINK_URL"] = frontend_url
    env["PALINK_SMOKE_USER"] = username
    env["PALINK_SMOKE_PASSWORD"] = password
    env["PALINK_TOKEN"] = token
    env["PALINK_SCREENSHOTS_DIR"] = str(screenshots_dir)
    # 让 Node 能找到项目 root 的 node_modules（脚本放在 temp 目录，默认找不到）
    node_modules = PROJECT_ROOT / "node_modules"
    if node_modules.is_dir():
        existing_node_path = env.get("NODE_PATH", "")
        env["NODE_PATH"] = str(node_modules) + (
            os.pathsep + existing_node_path if existing_node_path else ""
        )

    Logger.info(f"调用 Node Playwright 脚本: {script_path}")
    try:
        result = subprocess.run(
            ["node", str(script_path)],
            cwd=str(PROJECT_ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=BROWSER_TEST_TIMEOUT * 5 + 60,  # 5 个场景 + 启动余量
        )
    except subprocess.TimeoutExpired:
        Logger.error("Node Playwright 脚本超时")
        return [TestResult("Node Playwright", False, "脚本执行超时")]
    finally:
        # 清理临时脚本
        try:
            script_path.unlink(missing_ok=True)
        except Exception:
            pass

    if result.returncode != 0:
        Logger.error(f"Node Playwright 脚本失败 (code={result.returncode})")
        if result.stderr:
            Logger.error(result.stderr[-1000:])
        return [TestResult("Node Playwright", False, f"脚本退出码 {result.returncode}")]

    # 解析 JSON 输出
    stdout = result.stdout or ""
    marker = "===RESULTS_JSON==="
    marker_idx = stdout.find(marker)
    if marker_idx < 0:
        Logger.error("未找到结果 JSON 标记")
        Logger.info(f"stdout: {stdout[-500:]}")
        return [TestResult("Node Playwright", False, "未找到结果 JSON")]

    json_text = stdout[marker_idx + len(marker):].strip()
    # 取第一行（避免后续日志干扰）
    first_line = json_text.split("\n", 1)[0].strip()
    try:
        raw_results = json.loads(first_line)
    except json.JSONDecodeError as e:
        Logger.error(f"结果 JSON 解析失败: {e}")
        Logger.info(f"原始输出: {first_line[:300]}")
        return [TestResult("Node Playwright", False, "JSON 解析失败")]

    # 打印 Node 脚本的 stdout（调试用）
    if stdout[:marker_idx].strip():
        for line in stdout[:marker_idx].strip().splitlines():
            Logger.info(f"[node] {line}")

    return [
        TestResult(
            name=r.get("name", ""),
            passed=bool(r.get("passed")),
            detail=r.get("detail", ""),
            screenshot=r.get("screenshot") or None,
        )
        for r in raw_results
    ]


# ============================================================
# HTTP 降级模式（无 Playwright 时使用，不截图）
# ============================================================

def run_http_tests(frontend_url: str, backend_url: str, username: str,
                   password: str, token: str) -> list[TestResult]:
    """仅使用 HTTP 请求执行 5 个测试场景（无截图）。

    所有 API 请求通过前端 URL（Vite/nginx 代理 /api/* → backend:8000），
    这样无论后端是否映射主机端口都能正常工作。
    """
    results: list[TestResult] = []
    # API 基础 URL：优先前端代理（始终可达），后端 URL 仅用于健康检查
    api_base = frontend_url.rstrip("/")

    # ----- 场景 1: 首页 -----
    Logger.step("场景 1/5: 首页 (HTTP 模式)")
    code, body = http_get(frontend_url)
    passed = code == 200 and "<html" in body.lower()
    results.append(TestResult("首页加载", passed, f"HTTP {code}, html={'yes' if '<html' in body.lower() else 'no'}"))
    Logger.info(f"首页 HTTP {code}")

    # ----- 场景 2: 登录 -----
    Logger.step("场景 2/5: 登录 (HTTP 模式)")
    jwt_token = token
    if not jwt_token:
        code, body = http_post_form(
            api_base + "/api/token",
            {"username": username, "password": password},
        )
        try:
            data = json.loads(body)
            jwt_token = data.get("access_token", "")
        except json.JSONDecodeError:
            data = {}
        passed = code == 200 and bool(jwt_token)
        results.append(TestResult("登录", passed,
                                  f"HTTP {code}, hasToken={bool(jwt_token)}"))
        Logger.info(f"登录 HTTP {code}, hasToken={bool(jwt_token)}")
    else:
        results.append(TestResult("登录", True, "使用环境变量 token"))
        Logger.info("使用环境变量 token")

    # ----- 场景 3: 角色列表 API（ST 兼容端点为 POST）-----
    Logger.step("场景 3/5: 角色列表 (HTTP 模式)")
    headers = {"Authorization": f"Bearer {jwt_token}"} if jwt_token else {}
    code, body = http_post_json(api_base + "/api/characters/all",
                                headers=headers)
    passed = code == 200
    count = 0
    try:
        data = json.loads(body)
        if isinstance(data, list):
            count = len(data)
        elif isinstance(data, dict) and "items" in data:
            count = len(data["items"])
    except json.JSONDecodeError:
        pass
    results.append(TestResult("角色列表页", passed,
                              f"HTTP {code}, count={count}"))
    Logger.info(f"角色列表 HTTP {code}, count={count}")

    # ----- 场景 4: 设置 API（ST 兼容端点为 POST）-----
    Logger.step("场景 4/5: 设置 (HTTP 模式)")
    code, body = http_post_json(api_base + "/api/settings/get",
                                headers=headers)
    passed = code == 200
    results.append(TestResult("设置页", passed, f"HTTP {code}"))
    Logger.info(f"设置 API HTTP {code}")

    # ----- 场景 5: 插件管理 API（GET）-----
    Logger.step("场景 5/5: 插件管理 (HTTP 模式)")
    code, body = http_get(api_base + "/api/plugins",
                          headers=headers)
    passed = code == 200
    count = 0
    try:
        data = json.loads(body)
        if isinstance(data, list):
            count = len(data)
        elif isinstance(data, dict) and "items" in data:
            count = len(data["items"])
    except json.JSONDecodeError:
        pass
    results.append(TestResult("插件管理页", passed,
                              f"HTTP {code}, count={count}"))
    Logger.info(f"插件 API HTTP {code}, count={count}")

    return results


# ============================================================
# 主流程
# ============================================================

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Palink-AI 浏览器烟测自动启动本地服务脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python scripts/browser_smoke_test.py
  python scripts/browser_smoke_test.py --keep-running
  python scripts/browser_smoke_test.py --no-build --timeout 180
  python scripts/browser_smoke_test.py --http-only

退出码:
  0 - 全部测试通过
  1 - 有失败用例
  2 - 环境错误（Docker 未运行 / 服务启动超时等）
""",
    )
    parser.add_argument("--keep-running", action="store_true",
                        help="测试结束后保留 docker-compose 服务（便于调试）")
    parser.add_argument("--no-build", action="store_true",
                        help="启动服务时不执行 --build（使用已有镜像）")
    parser.add_argument("--timeout", type=int, default=SERVICE_STARTUP_TIMEOUT,
                        help=f"服务启动等待超时（秒，默认 {SERVICE_STARTUP_TIMEOUT}）")
    parser.add_argument("--http-only", action="store_true",
                        help="强制使用 HTTP 模式（不调用浏览器，不截图）")
    parser.add_argument("--frontend-url", default=DEFAULT_FRONTEND_URL,
                        help=f"前端 URL（默认 {DEFAULT_FRONTEND_URL}）")
    parser.add_argument("--backend-url", default=DEFAULT_BACKEND_URL,
                        help=f"后端 URL（默认 {DEFAULT_BACKEND_URL}）")
    parser.add_argument("--st-url", default=DEFAULT_ST_URL,
                        help=f"SillyTavern sidecar URL（默认 {DEFAULT_ST_URL}）")
    parser.add_argument("--user", default=DEFAULT_USER,
                        help=f"登录用户名（默认 {DEFAULT_USER}）")
    parser.add_argument("--password", default=DEFAULT_PASSWORD,
                        help="登录密码（默认 admin123）")
    parser.add_argument("--token", default=DEFAULT_TOKEN,
                        help="直接注入的 JWT token（可选，未设置则用账号密码登录）")
    parser.add_argument("--skip-start", action="store_true",
                        help="跳过服务启动步骤（假设服务已在运行）")
    parser.add_argument("--install-browser", action="store_true",
                        help="如果 Playwright 浏览器未安装，尝试安装 Chromium")
    return parser.parse_args()


def ensure_playwright_browser() -> bool:
    """尝试安装 Playwright Chromium 浏览器。"""
    Logger.info("尝试安装 Playwright Chromium 浏览器...")
    # Python 端
    code, out, err = run_command(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        timeout=300,
    )
    if code == 0:
        Logger.success("Chromium 浏览器已安装 (Python)")
        return True
    # Node 端
    code, out, err = run_command(
        ["npx", "playwright", "install", "chromium"],
        cwd=PROJECT_ROOT, timeout=300,
    )
    if code == 0:
        Logger.success("Chromium 浏览器已安装 (Node)")
        return True
    Logger.error(f"Chromium 安装失败: {err[:300]}")
    return False


def select_test_mode(args: argparse.Namespace) -> str:
    """决定测试模式：'playwright-python' / 'playwright-node' / 'http'。返回模式字符串。"""
    if args.http_only:
        Logger.info("强制使用 HTTP 模式")
        return "http"

    # 优先 Python Playwright（直接集成，最佳）
    if detect_python_playwright():
        if detect_chromium_browser():
            Logger.success("检测到 Python Playwright + Chromium，使用浏览器模式")
            return "playwright-python"
        Logger.warn("检测到 Python Playwright，但 Chromium 浏览器未安装")
        if args.install_browser:
            if ensure_playwright_browser():
                return "playwright-python"
        Logger.warn("降级到 Node Playwright 探测...")

    # 其次 Node Playwright（项目 root package.json 已安装）
    if detect_node_playwright():
        if detect_chromium_browser():
            Logger.success("检测到 Node Playwright + Chromium，使用 Node 浏览器模式")
            return "playwright-node"
        Logger.warn("检测到 Node Playwright，但 Chromium 浏览器未安装")
        if args.install_browser:
            if ensure_playwright_browser():
                return "playwright-node"
        Logger.warn("降级为 HTTP 模式（不截图）。如需浏览器模式，请执行：")
        Logger.warn("  npx playwright install chromium")
        return "http"

    Logger.warn("未检测到 Playwright（Python 或 Node），降级为 HTTP 模式（不截图）")
    Logger.warn("如需浏览器模式，请执行：")
    Logger.warn(f"  pip install playwright && {sys.executable} -m playwright install chromium")
    return "http"


def run_tests(mode: str, args: argparse.Namespace) -> list[TestResult]:
    """根据模式执行测试。"""
    if mode == "playwright-python":
        return run_playwright_tests(
            frontend_url=args.frontend_url,
            username=args.user,
            password=args.password,
            token=args.token,
            screenshots_dir=SCREENSHOTS_DIR,
        )
    if mode == "playwright-node":
        return run_node_playwright_tests(
            frontend_url=args.frontend_url,
            username=args.user,
            password=args.password,
            token=args.token,
            screenshots_dir=SCREENSHOTS_DIR,
        )
    return run_http_tests(
        frontend_url=args.frontend_url,
        backend_url=args.backend_url,
        username=args.user,
        password=args.password,
        token=args.token,
    )


def main() -> int:
    ensure_path()
    args = parse_args()

    Logger.step("Palink-AI 浏览器烟测")

    # 1. 检查 Docker
    Logger.step("检查 Docker 守护进程")
    if not check_docker_running():
        Logger.error("Docker 未运行，请先启动 Docker Desktop / dockerd")
        Logger.error("Windows: 启动 Docker Desktop")
        Logger.error("Linux: sudo systemctl start docker")
        return 2

    # 2. 检查 / 启动 docker-compose dev 服务
    services_started_by_us = False
    if args.skip_start:
        Logger.info("跳过服务启动步骤（--skip-start）")
    else:
        Logger.step("检查 docker-compose dev 服务状态")
        if is_dev_services_running():
            Logger.success("dev 服务已在运行")
        else:
            Logger.info("dev 服务未运行，开始启动...")
            if not start_dev_services(build=not args.no_build):
                Logger.error("服务启动失败")
                return 2
            services_started_by_us = True

    # 3. 等待服务就绪
    try:
        if not wait_for_services(args.frontend_url, args.backend_url,
                                 args.st_url, args.timeout):
            Logger.error("服务就绪超时，烟测中止")
            return 2
    except Exception as e:
        Logger.error(f"等待服务就绪异常: {e}")
        return 2

    # 4. 选择测试模式并执行
    Logger.step("执行浏览器烟测")
    mode = select_test_mode(args)
    Logger.info(f"测试模式: {mode}")

    try:
        results = run_tests(mode, args)
    except Exception as e:
        Logger.error(f"测试执行异常: {e}")
        import traceback
        traceback.print_exc()
        return 2

    # 5. 输出结果汇总
    Logger.step("测试结果汇总")
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        shot = f" [screenshot: {r.screenshot}]" if r.screenshot else ""
        print(f"  [{mark}] {r.name}: {r.detail}{shot}", flush=True)

    print(f"\nBrowser Smoke Test: {passed}/{total} passed", flush=True)

    # 6. 清理服务
    if args.keep_running:
        Logger.info("--keep-running 已指定，保留 dev 服务运行")
    elif services_started_by_us:
        Logger.step("清理 dev 服务")
        stop_dev_services()
    else:
        Logger.info("服务非本脚本启动，不清理（如需停止请手动执行 docker compose -f docker-compose.dev.yml down）")

    return 0 if passed == total else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        Logger.warn("用户中断")
        # 尽量清理
        try:
            stop_dev_services()
        except Exception:
            pass
        sys.exit(130)
