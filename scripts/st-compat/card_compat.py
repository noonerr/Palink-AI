#!/usr/bin/env python
"""Phase 1 harness: character-card PNG round-trip parity between Palink and ST 1.18.0.

Strategy (source of truth = real ST code running inside the sillytavern container):
  1. Generate a base PNG + a set of test cards (V1 / V2 / V3, unicode, edge cases).
  2. Palink side: create_png_with_chara_card() then extract_chara_card_from_png().
  3. ST side (in container): write() then read() its own output, AND read() Palink's PNG.
  4. Also Palink extract() ST's PNG.
  5. Compare semantically (does each side read the other's export into the same card?)
     and structurally (tEXt chunk keywords/order, chara+ccv3 present, before IEND).

Run:
  python scripts/st-compat/card_compat.py [--container palink-ai-sillytavern-1]

Exit code 0 => full parity; non-zero => at least one divergence (details in report).
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from io import BytesIO
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CARD_MODULE_PATH = REPO / "backend" / "app" / "character_card.py"
HARNESS_DIR = Path(__file__).resolve().parent
FIXTURES = HARNESS_DIR / "fixtures"
RESULTS = HARNESS_DIR / "results" / "card"
ST_SCRIPT = HARNESS_DIR / "st_card_roundtrip.mjs"
CONTAINER_TMP = "/tmp/stcompat_card"
# ST is an ESM app; the script must live inside the app dir so that
# `./src/...` and bare-package (png-chunks-extract) imports resolve.
ST_APP_DIR = "/home/node/app"
ST_SCRIPT_IN_APP = f"{ST_APP_DIR}/stcompat_roundtrip.mjs"


def load_card_module():
    spec = importlib.util.spec_from_file_location("palink_character_card", CARD_MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_base_png() -> bytes:
    from PIL import Image
    img = Image.new("RGBA", (8, 8), (10, 20, 30, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_cards() -> dict[str, dict]:
    """Return name -> card dict. Covers V2, V3, unicode, nested character_book, empties."""
    base_v2_data = {
        "name": "Aria",
        "description": "A curious explorer. 好奇的探险家。",
        "personality": "brave, witty",
        "scenario": "In a neon city at dusk 🌆",
        "first_mes": "Hello, {{user}}!\nReady?",
        "mes_example": "<START>\n{{user}}: hi\n{{char}}: hey",
        "creator_notes": "notes with \"quotes\" and \\backslash",
        "system_prompt": "",
        "post_history_instructions": "",
        "alternate_greetings": ["Hi again", "另一个问候"],
        "tags": ["scifi", "探险"],
        "creator": "tester",
        "character_version": "1.0",
        "extensions": {"talkativeness": "0.6", "world": "neon"},
    }
    v2 = {"spec": "chara_card_v2", "spec_version": "2.0", "data": copy.deepcopy(base_v2_data)}

    v3_data = copy.deepcopy(base_v2_data)
    v3_data.update({
        "nickname": "A",
        "group_only_greetings": ["group hi"],
        "creation_date": 1700000000,
        "assets": [{"type": "icon", "uri": "ccdefault:", "name": "main", "ext": "png"}],
        "character_book": {
            "name": "Aria Lore",
            "description": "",
            "scan_depth": 4,
            "token_budget": 500,
            "recursive_scanning": False,
            "extensions": {},
            "entries": [
                {
                    "id": 0,
                    "keys": ["city", "neon"],
                    "secondary_keys": [],
                    "comment": "The City",
                    "content": "A sprawling neon metropolis.",
                    "constant": False,
                    "selective": True,
                    "insertion_order": 10,
                    "enabled": True,
                    "position": "after_char",
                    "extensions": {"depth": 4, "role": 0, "position": 0},
                }
            ],
        },
    })
    v3 = {"spec": "chara_card_v3", "spec_version": "3.0", "data": v3_data}

    v1 = {
        "name": "Legacy",
        "description": "old style",
        "personality": "flat",
        "scenario": "nowhere",
        "first_mes": "hi",
        "mes_example": "",
    }

    return {"v2": v2, "v3": v3, "v1": v1}


def normalize_for_compare(card: dict) -> dict:
    """Drop spec/spec_version (they legitimately shift V2<->V3 on ccv3 round-trip)
    and fav (unsetPrivateFields forces False). Compare the substantive payload only."""
    c = copy.deepcopy(card)
    c.pop("spec", None)
    c.pop("spec_version", None)
    data = c.get("data")
    if isinstance(data, dict):
        data.pop("fav", None)
        ext = data.get("extensions")
        if isinstance(ext, dict):
            ext.pop("fav", None)
    return c


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def deep_diff(a, b, path="") -> list[str]:
    diffs: list[str] = []
    if type(a) is not type(b) and not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        diffs.append(f"{path}: type {type(a).__name__} != {type(b).__name__} ({a!r} vs {b!r})")
        return diffs
    if isinstance(a, dict):
        for k in set(a) | set(b):
            if k not in a:
                diffs.append(f"{path}.{k}: missing on LEFT (right={b[k]!r})")
            elif k not in b:
                diffs.append(f"{path}.{k}: missing on RIGHT (left={a[k]!r})")
            else:
                diffs += deep_diff(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        if len(a) != len(b):
            diffs.append(f"{path}: list len {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diffs += deep_diff(x, y, f"{path}[{i}]")
    else:
        if a != b:
            diffs.append(f"{path}: {a!r} != {b!r}")
    return diffs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--container", default="palink-ai-sillytavern-1")
    args = ap.parse_args()

    card_mod = load_card_module()
    FIXTURES.mkdir(parents=True, exist_ok=True)
    RESULTS.mkdir(parents=True, exist_ok=True)

    base_png = make_base_png()
    (FIXTURES / "base.png").write_bytes(base_png)

    # copy ST script into the app dir (for module resolution) once
    _run(["docker", "exec", args.container, "mkdir", "-p", CONTAINER_TMP])
    cp = _run(["docker", "cp", str(ST_SCRIPT), f"{args.container}:{ST_SCRIPT_IN_APP}"])
    if cp.returncode != 0:
        print("FATAL: cannot copy ST script into container:", cp.stderr)
        return 10

    overall_ok = True
    report: dict[str, dict] = {}

    for name, card in test_cards().items():
        case_dir = RESULTS / name
        case_dir.mkdir(parents=True, exist_ok=True)
        # ST write() uses the JSON string exactly as passed; mimic server JSON.stringify
        card_str = json.dumps(card, ensure_ascii=False)
        (case_dir / "card.json").write_text(card_str, encoding="utf-8")
        (case_dir / "base.png").write_bytes(base_png)

        # ---- Palink side ----
        palink_png = card_mod.create_png_with_chara_card(base_png, card)
        (case_dir / "palink_out.png").write_bytes(palink_png)
        palink_self = card_mod.extract_chara_card_from_png(palink_png)
        (case_dir / "palink_parsed.json").write_text(
            json.dumps(palink_self, ensure_ascii=False, indent=2), encoding="utf-8")

        # ---- push inputs to container ----
        cdir = f"{CONTAINER_TMP}/{name}"
        _run(["docker", "exec", args.container, "mkdir", "-p", cdir])
        for fn in ("card.json", "base.png", "palink_out.png"):
            _run(["docker", "cp", str(case_dir / fn), f"{args.container}:{cdir}/{fn}"])

        # ---- run ST inside container (cwd = app dir for module resolution) ----
        st = _run(["docker", "exec", "-w", ST_APP_DIR, args.container, "node",
                   ST_SCRIPT_IN_APP,
                   f"{cdir}/base.png", f"{cdir}/card.json", cdir])

        # ---- pull ST outputs back ----
        for fn in ("st_out.png", "st_parsed.json", "st_chunks.json",
                   "st_reads_palink.json", "palink_chunks.json", "st_reads_palink.error"):
            _run(["docker", "cp", f"{args.container}:{cdir}/{fn}", str(case_dir / fn)])

        # ---- Palink reads ST's PNG ----
        palink_reads_st = None
        st_out_path = case_dir / "st_out.png"
        if st_out_path.exists():
            palink_reads_st = card_mod.extract_chara_card_from_png(st_out_path.read_bytes())
            (case_dir / "palink_reads_st.json").write_text(
                json.dumps(palink_reads_st, ensure_ascii=False, indent=2), encoding="utf-8")

        # ---- compare ----
        case_report: dict = {"st_exit": st.returncode, "checks": {}}
        if st.stderr.strip():
            case_report["st_stderr"] = st.stderr.strip()[:2000]

        norm_orig = normalize_for_compare(card)

        # ST reads Palink's PNG -> equals original?
        srp = case_dir / "st_reads_palink.json"
        if srp.exists():
            try:
                parsed = json.loads(srp.read_text(encoding="utf-8"))
                d = deep_diff(normalize_for_compare(parsed), norm_orig, "st_reads_palink")
                case_report["checks"]["st_reads_palink"] = {"ok": not d, "diffs": d[:40]}
            except Exception as e:  # noqa: BLE001
                case_report["checks"]["st_reads_palink"] = {"ok": False, "error": str(e)}
        else:
            err = case_dir / "st_reads_palink.error"
            case_report["checks"]["st_reads_palink"] = {
                "ok": False, "error": err.read_text(encoding="utf-8")[:1000] if err.exists() else "no output"}

        # Palink reads ST's PNG -> equals original?
        if palink_reads_st is not None:
            d = deep_diff(normalize_for_compare(palink_reads_st), norm_orig, "palink_reads_st")
            case_report["checks"]["palink_reads_st"] = {"ok": not d, "diffs": d[:40]}
        else:
            case_report["checks"]["palink_reads_st"] = {"ok": False, "error": "no st_out.png"}

        # Structural: both PNGs carry chara+ccv3 tEXt before IEND
        for label, chunkfile in (("st_chunks", "st_chunks.json"), ("palink_chunks", "palink_chunks.json")):
            cf = case_dir / chunkfile
            if cf.exists():
                info = json.loads(cf.read_text(encoding="utf-8"))
                kws = [t["keyword"].lower() for t in info.get("text_chunks", [])]
                idxs = info.get("text_indexes", [])
                iend = info.get("iend_index", -1)
                before_iend = all(i < iend for i in idxs) if iend >= 0 else False
                case_report["checks"][label] = {
                    "ok": ("chara" in kws and "ccv3" in kws and before_iend),
                    "keywords": kws, "before_iend": before_iend,
                }
            else:
                case_report["checks"][label] = {"ok": False, "error": "missing chunk info"}

        case_ok = all(v.get("ok") for v in case_report["checks"].values())
        case_report["ok"] = case_ok
        overall_ok = overall_ok and case_ok
        report[name] = case_report

    (RESULTS / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- print summary ----
    print("=" * 70)
    print("PHASE 1 CHARACTER-CARD PNG PARITY REPORT")
    print("=" * 70)
    for name, rep in report.items():
        print(f"\n[{name}]  overall={'PASS' if rep['ok'] else 'FAIL'}  (st_exit={rep['st_exit']})")
        for check, res in rep["checks"].items():
            status = "ok" if res.get("ok") else "FAIL"
            print(f"   - {check}: {status}")
            if not res.get("ok"):
                if res.get("diffs"):
                    for dln in res["diffs"]:
                        print(f"        diff: {dln}")
                if res.get("error"):
                    print(f"        error: {res['error']}")
        if rep.get("st_stderr"):
            print(f"   st_stderr: {rep['st_stderr'][:300]}")
    print("\n" + ("ALL PASS" if overall_ok else "DIVERGENCES FOUND"))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
