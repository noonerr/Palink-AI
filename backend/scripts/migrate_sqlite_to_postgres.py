#!/usr/bin/env python3
"""One-off migration tool: SQLite -> PostgreSQL.

This script copies records from a SQLite source database into a PostgreSQL target
with idempotent inserts (ON CONFLICT DO NOTHING). It emits a JSON report with
per-table stats and can optionally truncate target tables before import.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import BigInteger, Integer, MetaData, create_engine, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Engine

EXCLUDED_TABLES = {"alembic_version"}

PREFERRED_TABLE_ORDER = [
    "users",
    "settings",
    "user_settings",
    "sessions",
    "messages",
    "user_folders",
    "user_files",
    "characters",
    "character_chat_sessions",
    "character_chat_session_branches",
    "character_chat_messages",
    "world_books",
    "world_book_stages",
    "session_world_books",
    "plot_lines",
    "plot_stages",
    "session_plot_lines",
    "conversation_memories",
    "user_profiles",
    "provider_test_results",
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_table_order(common_tables: list[str], target_meta: MetaData) -> list[str]:
    deps: dict[str, set[str]] = defaultdict(set)
    for table_name in common_tables:
        table = target_meta.tables[table_name]
        deps.setdefault(table_name, set())
        for fk in table.foreign_keys:
            ref = fk.column.table.name
            if ref in common_tables and ref != table_name:
                deps[table_name].add(ref)

    indegree = {name: len(reqs) for name, reqs in deps.items()}
    queue = deque(sorted([name for name, d in indegree.items() if d == 0]))
    order: list[str] = []

    reverse_edges: dict[str, set[str]] = defaultdict(set)
    for table_name, reqs in deps.items():
        for req in reqs:
            reverse_edges[req].add(table_name)

    while queue:
        current = queue.popleft()
        order.append(current)
        for nxt in sorted(reverse_edges[current]):
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)

    remaining = sorted(set(common_tables) - set(order))
    if remaining:
        # Break any potential cycles by appending deterministic fallback order.
        order.extend(remaining)

    # Stabilize with preferred order while preserving members not listed.
    preferred = [t for t in PREFERRED_TABLE_ORDER if t in order]
    others = [t for t in order if t not in preferred]
    return preferred + others


def get_table_count(conn, table) -> int:
    return int(conn.execute(select(func.count()).select_from(table)).scalar_one())


def normalize_rows(raw_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for row in raw_rows:
        item = {}
        for key, value in row.items():
            if isinstance(value, bytes):
                item[key] = value.decode("utf-8", errors="ignore")
            else:
                item[key] = value
        normalized.append(item)
    return normalized


def copy_table(
    source_conn,
    target_conn,
    source_meta: MetaData,
    target_meta: MetaData,
    table_name: str,
    batch_size: int,
    dry_run: bool,
) -> dict[str, Any]:
    source_table = source_meta.tables[table_name]
    target_table = target_meta.tables[table_name]

    source_columns = {c.name for c in source_table.columns}
    insert_columns = [c.name for c in target_table.columns if c.name in source_columns]

    if not insert_columns:
        return {
            "table": table_name,
            "source_count": 0,
            "target_before": get_table_count(target_conn, target_table),
            "target_after": get_table_count(target_conn, target_table),
            "inserted": 0,
            "skipped": 0,
            "status": "skipped_no_common_columns",
        }

    pk_columns = [c.name for c in target_table.primary_key.columns if c.name in insert_columns]

    target_before = get_table_count(target_conn, target_table)
    source_count = get_table_count(source_conn, source_table)

    if source_count == 0:
        return {
            "table": table_name,
            "source_count": 0,
            "target_before": target_before,
            "target_after": target_before,
            "inserted": 0,
            "skipped": 0,
            "status": "ok",
        }

    selected_columns = [source_table.c[col] for col in insert_columns]
    stmt = select(*selected_columns)
    result = source_conn.execute(stmt).mappings()

    copied = 0
    while True:
        batch = result.fetchmany(batch_size)
        if not batch:
            break

        rows = normalize_rows([dict(row) for row in batch])
        if dry_run:
            copied += len(rows)
            continue

        if pk_columns:
            insert_stmt = pg_insert(target_table).on_conflict_do_nothing(index_elements=pk_columns)
            target_conn.execute(insert_stmt, rows)
        else:
            target_conn.execute(target_table.insert(), rows)

        copied += len(rows)

    if not dry_run:
        target_after = get_table_count(target_conn, target_table)
        inserted = max(target_after - target_before, 0)
        skipped = max(source_count - inserted, 0)
        sync_integer_sequence(target_conn, table_name, target_table)
    else:
        target_after = target_before
        inserted = copied
        skipped = 0

    return {
        "table": table_name,
        "source_count": source_count,
        "target_before": target_before,
        "target_after": target_after,
        "inserted": inserted,
        "skipped": skipped,
        "status": "ok",
    }


def sync_integer_sequence(target_conn, table_name: str, table) -> None:
    pk_columns = list(table.primary_key.columns)
    if len(pk_columns) != 1:
        return

    pk_col = pk_columns[0]
    if not isinstance(pk_col.type, (Integer, BigInteger)):
        return

    seq_name = target_conn.execute(
        text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
        {"table_name": f"public.{table_name}", "column_name": pk_col.name},
    ).scalar()

    if not seq_name:
        return

    target_conn.execute(
        text(
            f'SELECT setval(CAST(:seq AS regclass), COALESCE((SELECT MAX("{pk_col.name}") FROM "{table_name}"), 1), true)'
        ),
        {"seq": seq_name},
    )


def parse_args() -> argparse.Namespace:
    default_sqlite = Path(__file__).resolve().parents[1] / "data" / "palink.db"
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    default_report = Path(__file__).resolve().parents[1] / "data" / "migration_reports" / f"sqlite_to_postgres_{timestamp}.json"

    parser = argparse.ArgumentParser(description="Migrate records from SQLite to PostgreSQL")
    parser.add_argument("--sqlite-path", default=str(default_sqlite), help="Path to source sqlite .db file")
    parser.add_argument("--postgres-url", default=os.getenv("DATABASE_URL", ""), help="Target PostgreSQL URL")
    parser.add_argument("--batch-size", type=int, default=500, help="Insert batch size")
    parser.add_argument("--report-path", default=str(default_report), help="Output JSON report path")
    parser.add_argument("--truncate-target", action="store_true", help="Truncate target tables before import")
    parser.add_argument("--dry-run", action="store_true", help="Read source and compute plan without writing target")
    parser.add_argument(
        "--tables",
        default="",
        help="Comma-separated subset of tables to migrate (default: all common tables)",
    )
    return parser.parse_args()


def build_engines(sqlite_path: str, postgres_url: str) -> tuple[Engine, Engine]:
    if not Path(sqlite_path).exists():
        raise FileNotFoundError(f"SQLite file not found: {sqlite_path}")
    if not postgres_url or not postgres_url.startswith("postgresql"):
        raise ValueError("A valid PostgreSQL DATABASE_URL is required.")

    sqlite_engine = create_engine(f"sqlite:///{sqlite_path}")
    pg_engine = create_engine(postgres_url)
    return sqlite_engine, pg_engine


def run() -> int:
    args = parse_args()
    started = time.time()

    sqlite_engine, pg_engine = build_engines(args.sqlite_path, args.postgres_url)

    source_meta = MetaData()
    source_meta.reflect(bind=sqlite_engine)

    target_meta = MetaData()
    target_meta.reflect(bind=pg_engine)

    source_tables = set(source_meta.tables.keys()) - EXCLUDED_TABLES
    target_tables = set(target_meta.tables.keys()) - EXCLUDED_TABLES
    common_tables = sorted(source_tables & target_tables)

    if args.tables:
        subset = {name.strip() for name in args.tables.split(",") if name.strip()}
        common_tables = [t for t in common_tables if t in subset]

    if not common_tables:
        raise RuntimeError("No common tables found between source and target.")

    table_order = build_table_order(common_tables, target_meta)

    report: dict[str, Any] = {
        "started_at_utc": utc_now_iso(),
        "sqlite_path": str(Path(args.sqlite_path).resolve()),
        "target_postgres": args.postgres_url,
        "dry_run": args.dry_run,
        "truncate_target": args.truncate_target,
        "batch_size": args.batch_size,
        "source_tables": sorted(source_tables),
        "target_tables": sorted(target_tables),
        "common_tables": common_tables,
        "migration_order": table_order,
        "table_results": [],
        "status": "running",
    }

    with sqlite_engine.connect() as source_conn, pg_engine.connect() as target_conn:
        if args.truncate_target and not args.dry_run:
            table_sql = ", ".join(f'"{t}"' for t in reversed(table_order))
            target_conn.execute(text(f"TRUNCATE TABLE {table_sql} RESTART IDENTITY CASCADE"))
            target_conn.commit()

        for table_name in table_order:
            table_start = time.time()
            table_result = copy_table(
                source_conn=source_conn,
                target_conn=target_conn,
                source_meta=source_meta,
                target_meta=target_meta,
                table_name=table_name,
                batch_size=args.batch_size,
                dry_run=args.dry_run,
            )
            if not args.dry_run:
                target_conn.commit()

            table_result["duration_ms"] = round((time.time() - table_start) * 1000, 2)
            report["table_results"].append(table_result)

    report["finished_at_utc"] = utc_now_iso()
    report["duration_seconds"] = round(time.time() - started, 3)
    report["status"] = "ok"

    report_path = Path(args.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Migration completed. Report: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
