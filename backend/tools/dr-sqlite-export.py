#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote


def fail(message: str) -> "NoReturn":
    print(f"P11_DR_SOURCE_ERROR={message}", file=sys.stderr)
    raise SystemExit(2)


def decode_json_blob(value: object, label: str) -> dict:
    if isinstance(value, memoryview):
        value = value.tobytes()

    if isinstance(value, bytes):
        try:
            text = value.decode("utf-8")
        except UnicodeDecodeError as exc:
            fail(f"{label}: invalid UTF-8 canonical blob: {exc}")
    elif isinstance(value, str):
        text = value
    else:
        fail(f"{label}: canonical blob is neither TEXT nor BLOB")

    try:
        decoded = json.loads(text)
    except json.JSONDecodeError as exc:
        fail(f"{label}: canonical blob is invalid JSON: {exc}")

    if not isinstance(decoded, dict):
        fail(f"{label}: canonical JSON root is not an object")

    return decoded


def fetch_one(
    connection: sqlite3.Connection,
    sql: str,
    params: tuple[object, ...],
    label: str,
) -> sqlite3.Row:
    row = connection.execute(sql, params).fetchone()
    if row is None:
        fail(f"{label}: required row missing")
    return row


def main() -> int:
    if len(sys.argv) != 2:
        fail("usage: dr-sqlite-export.py /absolute/path/to/delta_research.sqlite3")

    database = Path(sys.argv[1])
    if not database.is_absolute():
        fail("database path must be absolute")
    if not database.is_file():
        fail("database file does not exist")

    uri = f"file:{quote(str(database), safe='/')}?mode=ro"

    try:
        connection = sqlite3.connect(
            uri,
            uri=True,
            timeout=5.0,
            isolation_level=None,
        )
    except sqlite3.Error as exc:
        fail(f"read-only SQLite open failed: {exc}")

    connection.row_factory = sqlite3.Row

    try:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA busy_timeout = 5000")

        query_only = connection.execute(
            "PRAGMA query_only"
        ).fetchone()[0]
        if int(query_only) != 1:
            fail("PRAGMA query_only did not become active")

        connection.execute("BEGIN")

        lifecycles = connection.execute(
            """
            SELECT
                signal_lifecycle_id,
                paper_trade_plan_id,
                exchange,
                market,
                symbol,
                published_at
            FROM signal_lifecycles
            ORDER BY
                published_at ASC,
                signal_lifecycle_id ASC
            """
        )

        for lifecycle in lifecycles:
            signal_id = lifecycle["signal_lifecycle_id"]
            plan_id = lifecycle["paper_trade_plan_id"]

            plan_row = fetch_one(
                connection,
                """
                SELECT
                    paper_trade_plan_id,
                    exchange,
                    market,
                    symbol,
                    direction,
                    expires_at,
                    canonical_plan
                FROM paper_trade_plans
                WHERE paper_trade_plan_id = ?
                """,
                (plan_id,),
                f"plan {plan_id}",
            )

            event_rows = connection.execute(
                """
                SELECT
                    signal_lifecycle_event_id,
                    signal_lifecycle_id,
                    sequence,
                    event_type,
                    from_state,
                    to_state,
                    occurred_at,
                    canonical_event
                FROM signal_lifecycle_events
                WHERE signal_lifecycle_id = ?
                ORDER BY sequence ASC
                """,
                (signal_id,),
            ).fetchall()

            if not event_rows:
                fail(f"signal {signal_id}: event timeline missing")

            state_row = fetch_one(
                connection,
                """
                SELECT
                    signal_lifecycle_id,
                    revision,
                    sequence,
                    current_state,
                    as_of,
                    terminal_at,
                    canonical_state
                FROM signal_lifecycle_state_revisions
                WHERE signal_lifecycle_id = ?
                ORDER BY revision DESC
                LIMIT 1
                """,
                (signal_id,),
                f"signal {signal_id} latest state",
            )

            outcome_row = connection.execute(
                """
                SELECT
                    signal_outcome_id,
                    signal_lifecycle_id,
                    lifecycle_revision,
                    as_of,
                    final_status,
                    quality_status,
                    canonical_outcome
                FROM signal_outcomes
                WHERE signal_lifecycle_id = ?
                ORDER BY lifecycle_revision DESC
                LIMIT 1
                """,
                (signal_id,),
            ).fetchone()

            bundle = {
                "lifecycle": {
                    "signal_lifecycle_id": signal_id,
                    "paper_trade_plan_id": plan_id,
                    "exchange": lifecycle["exchange"],
                    "market": lifecycle["market"],
                    "symbol": lifecycle["symbol"],
                    "published_at": lifecycle["published_at"],
                },
                "planMeta": {
                    "paper_trade_plan_id": plan_row["paper_trade_plan_id"],
                    "exchange": plan_row["exchange"],
                    "market": plan_row["market"],
                    "symbol": plan_row["symbol"],
                    "direction": plan_row["direction"],
                    "expires_at": plan_row["expires_at"],
                },
                "plan": decode_json_blob(
                    plan_row["canonical_plan"],
                    f"plan {plan_id}",
                ),
                "events": [
                    {
                        "meta": {
                            "signal_lifecycle_event_id":
                                row["signal_lifecycle_event_id"],
                            "signal_lifecycle_id":
                                row["signal_lifecycle_id"],
                            "sequence": row["sequence"],
                            "event_type": row["event_type"],
                            "from_state": row["from_state"],
                            "to_state": row["to_state"],
                            "occurred_at": row["occurred_at"],
                        },
                        "canonical": decode_json_blob(
                            row["canonical_event"],
                            (
                                f"signal {signal_id} event "
                                f"{row['sequence']}"
                            ),
                        ),
                    }
                    for row in event_rows
                ],
                "stateMeta": {
                    "signal_lifecycle_id":
                        state_row["signal_lifecycle_id"],
                    "revision": state_row["revision"],
                    "sequence": state_row["sequence"],
                    "current_state": state_row["current_state"],
                    "as_of": state_row["as_of"],
                    "terminal_at": state_row["terminal_at"],
                },
                "state": decode_json_blob(
                    state_row["canonical_state"],
                    f"signal {signal_id} latest state",
                ),
                "outcomeMeta": (
                    None
                    if outcome_row is None
                    else {
                        "signal_outcome_id":
                            outcome_row["signal_outcome_id"],
                        "signal_lifecycle_id":
                            outcome_row["signal_lifecycle_id"],
                        "lifecycle_revision":
                            outcome_row["lifecycle_revision"],
                        "as_of": outcome_row["as_of"],
                        "final_status":
                            outcome_row["final_status"],
                        "quality_status":
                            outcome_row["quality_status"],
                    }
                ),
                "outcome": (
                    None
                    if outcome_row is None
                    else decode_json_blob(
                        outcome_row["canonical_outcome"],
                        f"signal {signal_id} outcome",
                    )
                ),
            }

            print(
                json.dumps(
                    bundle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                flush=True,
            )

        connection.execute("COMMIT")
        return 0
    except sqlite3.Error as exc:
        try:
            connection.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        fail(f"SQLite read failed: {exc}")
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
