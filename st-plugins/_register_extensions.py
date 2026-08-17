#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将 st-plugins/ 下各真实 ST 1.18.0 扩展打包并注册到 Palink 后端。

用法（后端已启动、且你有 admin 账号）：
    python _register_extensions.py --base http://localhost:8000 --token <ADMIN_JWT>

或把 token 放到环境变量：
    set PALINK_ADMIN_TOKEN=eyJ...
    python _register_extensions.py

说明：
- 每个含 manifest.json 的子目录视为一个扩展，递归打 zip 后 POST /api/plugins/import
- 后端会把 .html 抽进 resources.templates，前端 load() 时通过 P0-1 修复的
  renderExtensionTemplateAsync 渲染设置面板（#xxx_container 由 StPluginMountPoints 提供）
- 不会重复注册判断：每次调用都会新增一条记录，重复运行前请先在插件管理里卸载
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import zipfile

import requests

HERE = os.path.dirname(os.path.abspath(__file__))

# 不参与打包的文件/目录
SKIP = {"shared.js", "_verify_render.mjs", "_register_extensions.py", "COMPAT_ANALYSIS.md", "__pycache__"}


def make_zip(ext_dir: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(ext_dir):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, ext_dir).replace("\\", "/")
                # 跳过无关文件
                if rel in SKIP or rel.startswith("."):
                    continue
                if any(seg in SKIP for seg in rel.split("/")):
                    continue
                zf.write(full, rel)
    return buf.getvalue()


def register(base: str, token: str) -> int:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    failures = 0
    for entry in sorted(os.listdir(HERE)):
        ext_dir = os.path.join(HERE, entry)
        manifest = os.path.join(ext_dir, "manifest.json")
        if not os.path.isdir(ext_dir) or not os.path.isfile(manifest):
            continue
        try:
            data = make_zip(ext_dir)
        except Exception as e:
            print(f"[SKIP] {entry}: 打包失败 {e}")
            failures += 1
            continue
        try:
            resp = requests.post(
                f"{base.rstrip('/')}/api/plugins/import",
                files={"file": (f"{entry}.zip", data, "application/zip")},
                headers=headers,
                timeout=60,
            )
        except requests.RequestException as e:
            print(f"[ERR ] {entry}: 请求失败 {e}")
            failures += 1
            continue
        if resp.status_code == 200:
            body = resp.json()
            p = body.get("plugin", {})
            print(f"[OK  ] {entry}: name={p.get('name')!r} type={p.get('plugin_type')} id={p.get('id')}")
        else:
            print(f"[FAIL] {entry}: HTTP {resp.status_code} {resp.text[:200]}")
            failures += 1
    return failures


def main() -> int:
    ap = argparse.ArgumentParser(description="注册 st-plugins/ 下的 ST 扩展到 Palink")
    ap.add_argument("--base", default=os.environ.get("PALINK_BASE", "http://localhost:8000"))
    ap.add_argument("--token", default=os.environ.get("PALINK_ADMIN_TOKEN", ""))
    args = ap.parse_args()
    if not args.token:
        print("缺少 admin token：用 --token 传入或设置环境变量 PALINK_ADMIN_TOKEN", file=sys.stderr)
        return 2
    print(f"目标后端: {args.base}")
    print(f"扫描目录: {HERE}\n")
    failures = register(args.base, args.token)
    print(f"\n完成。失败/跳过: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
