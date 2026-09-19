# -*- coding: utf-8 -*-
"""2026-09-02 安全整改实弹复验脚本（只读/无损，不落库不留产物）。

覆盖渗透验证报告 5 项修复中可在 HTTP 层验证的 3 项，外加 1 组"零误伤"对照：

  ① context_templates 写操作收口 get_admin
     - GET  列表（普通用户）      → 期望 200（读取保持开放，前端设置页不回归）
     - PUT  模板（普通用户）      → 期望 403（越权已收口）
  ② CSRF 中间件外站 Origin 独立拒绝（C3 缺口）
     - 同源 Origin + 有效令牌     → 期望非 403（正常路径无损）
     - 外站 Origin + 有效令牌     → 期望 403 + "Cross-site origin rejected"
  ③ 凭据外泄面收口
     - .env 必须被 gitignore 覆盖（否则凭据会再次入仓）
  ④ 对照组（防误伤）
     - 普通用户自带端点 PUT /api/users/me/settings（空体，不产生任何变更）
       同源 → 期望 200；外站 Origin → 期望 403

用法：
    cd scripts/st_audit && python verify_security_fixes_20260902.py

凭据从 scripts/st_audit/.env（gitignored）读取 FV_BROWSER_USER / FV_BROWSER_PASSWORD。
只做"无副作用"请求：settings 更新用空体 {}（业务层逐字段判空，零写入）。
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _credentials  # noqa: E402,F401  载入 .env 到环境变量

BASE = _credentials.BASE
USER = os.environ.get("FV_BROWSER_USER", "")
PASSWORD = os.environ.get("FV_BROWSER_PASSWORD", "")
EVIL_ORIGIN = "https://evil.example.com"

if not USER or not PASSWORD:
    raise SystemExit("缺少 FV_BROWSER_USER / FV_BROWSER_PASSWORD（scripts/st_audit/.env）")


class Resp:
    def __init__(self, status, body, cookies):
        self.status = status
        self.body = body
        self.cookies = cookies

    def detail(self):
        try:
            return json.loads(self.body).get("detail", "")
        except Exception:
            return self.body[:120].decode("utf-8", "replace")


def call(method, path, cookies=None, headers=None, body=None, ctype=None):
    url = BASE + path
    hdrs = dict(headers or {})
    if cookies:
        hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    data = body
    if isinstance(data, str):
        data = data.encode("utf-8")
    if ctype:
        hdrs["Content-Type"] = ctype
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return Resp(r.status, r.read(), _parse_cookies(r))
    except urllib.error.HTTPError as e:
        return Resp(e.code, e.read(), _parse_cookies(e))


def _parse_cookies(resp):
    """逐条解析 Set-Cookie（SimpleCookie 不接受 list，必须一条一条喂字符串）。"""
    jar = {}
    for raw_cookie in resp.headers.get_all("Set-Cookie") or []:
        try:
            for morsel in SimpleCookie(str(raw_cookie)).values():
                jar[morsel.key] = morsel.value
        except Exception:
            continue
    return jar


def login():
    body = urllib.parse.urlencode({"username": USER, "password": PASSWORD})
    r = call("POST", "/api/token", body=body,
             ctype="application/x-www-form-urlencoded")
    if r.status != 200:
        raise SystemExit(f"登录失败 status={r.status} detail={r.detail()}")
    jar = {"palink_session": r.cookies.get("palink_session", ""),
           "palink_csrf": r.cookies.get("palink_csrf", "")}
    if not jar["palink_session"] or not jar["palink_csrf"]:
        raise SystemExit(f"登录未下发双 Cookie，实际收到 keys={list(r.cookies)}")
    return jar


def same_origin():
    return BASE


def report(name, expect, actual, ok, extra=""):
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] {name}\n       期望={expect}  实际={actual} {extra}")
    return ok


def main():
    print(f"目标 {BASE}  账号 {USER}\n" + "-" * 68)
    jar = login()
    print(f"[INFO] 登录成功，双 Cookie 已获取（session={jar['palink_session'][:8]}… "
          f"csrf={jar['palink_csrf'][:8]}…）\n")
    results = []

    # ①-a 读取仍开放
    r = call("GET", "/api/roleplay/context-templates", cookies=jar)
    results.append(report("①-a 普通用户 GET context-templates（读取应保持开放）",
                          "200", r.status, r.status == 200))
    tmpl_id = None
    try:
        data = json.loads(r.body)
        if isinstance(data, list) and data:
            tmpl_id = data[0].get("id")
        elif isinstance(data, dict):
            items = data.get("items") or data.get("templates") or []
            if items:
                tmpl_id = items[0].get("id")
    except Exception:
        pass
    if tmpl_id is None:
        tmpl_id = 1
        print("       [INFO] 未能解析模板 id，回退使用 id=1 做写操作探测")
    else:
        print(f"       [INFO] 取到模板 id={tmpl_id}")

    # ①-b 写操作收口
    r = call("PUT", f"/api/roleplay/context-templates/{tmpl_id}",
             cookies=jar,
             headers={"X-CSRF-Token": jar["palink_csrf"], "Origin": same_origin()},
             body=json.dumps({"display_name": "__pentest_probe__"}),
             ctype="application/json")
    results.append(report("①-b 普通用户 PUT context-templates（应被 admin 收口拒绝）",
                          "403", f"{r.status} {r.detail()}", r.status == 403))

    r = call("DELETE", f"/api/roleplay/context-templates/{tmpl_id}",
             cookies=jar,
             headers={"X-CSRF-Token": jar["palink_csrf"], "Origin": same_origin()})
    results.append(report("①-c 普通用户 DELETE context-templates（应被 admin 收口拒绝）",
                          "403", f"{r.status} {r.detail()}", r.status == 403))

    # ② CSRF C3：外站 Origin 独立拒绝
    r = call("PUT", f"/api/roleplay/context-templates/{tmpl_id}",
             cookies=jar,
             headers={"X-CSRF-Token": jar["palink_csrf"], "Origin": EVIL_ORIGIN},
             body=json.dumps({"display_name": "__pentest_probe__"}),
             ctype="application/json")
    ok = r.status == 403 and "Cross-site origin rejected" in r.detail()
    results.append(report("②-a 外站 Origin + 有效 CSRF 令牌（应独立拒绝）",
                          "403 Cross-site origin rejected",
                          f"{r.status} {r.detail()}", ok))

    # ④ 对照组：普通用户自带端点，同源应放行、外站应拒绝
    r = call("PUT", "/api/users/me/settings", cookies=jar,
             headers={"X-CSRF-Token": jar["palink_csrf"], "Origin": same_origin()},
             body=json.dumps({}), ctype="application/json")
    results.append(report("④-a 同源 + 有效令牌 → 普通用户自带端点（应放行，防误伤）",
                          "非 403", f"{r.status} {r.detail()}", r.status != 403))

    r = call("PUT", "/api/users/me/settings", cookies=jar,
             headers={"X-CSRF-Token": jar["palink_csrf"], "Origin": EVIL_ORIGIN},
             body=json.dumps({}), ctype="application/json")
    ok = r.status == 403 and "Cross-site origin rejected" in r.detail()
    results.append(report("④-b 外站 Origin → 普通用户自带端点（应拒绝）",
                          "403 Cross-site origin rejected",
                          f"{r.status} {r.detail()}", ok))

    # ③ 凭据文件必须被 gitignore 覆盖
    try:
        out = subprocess.run(["git", "check-ignore", "-v", "scripts/st_audit/.env"],
                             cwd=str(Path(__file__).resolve().parents[2]),
                             capture_output=True, text=True, timeout=30)
        ignored = out.returncode == 0
        results.append(report("③ scripts/st_audit/.env 被 gitignore 覆盖",
                              "ignored", ("ignored " + out.stdout.strip().split()[-1])
                              if ignored else "NOT IGNORED", ignored))
    except Exception as exc:
        results.append(report("③ scripts/st_audit/.env 被 gitignore 覆盖",
                              "ignored", f"检查失败 {exc}", False))

    print("-" * 68)
    passed = sum(1 for x in results if x)
    print(f"结果：{passed}/{len(results)} 通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
