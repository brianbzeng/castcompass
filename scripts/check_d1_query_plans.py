#!/usr/bin/env python3
"""Apply every D1 migration and reject regressions in critical query plans."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "drizzle"


@dataclass(frozen=True)
class PlanCheck:
    name: str
    sql: str
    parameters: Sequence[object]
    required_indexes: tuple[str, ...]
    reject_temporary_sort: bool = True


CHECKS = (
    PlanCheck(
        "expired sessions",
        "DELETE FROM auth_sessions WHERE expires_at <= ?",
        ("2026-07-17T00:00:00.000Z",),
        ("auth_sessions_expires_idx",),
    ),
    PlanCheck(
        "expired email challenges",
        "DELETE FROM email_challenges WHERE expires_at <= ?",
        ("2026-07-17T00:00:00.000Z",),
        ("email_challenges_expires_idx",),
    ),
    PlanCheck(
        "old authentication attempts",
        "DELETE FROM auth_attempts WHERE attempted_at < ?",
        ("2026-06-17T00:00:00.000Z",),
        ("auth_attempts_attempted_idx",),
    ),
    PlanCheck(
        "expired or consumed age proofs",
        """DELETE FROM signup_age_proofs
           WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)""",
        ("2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
        ("signup_age_proofs_expiry_idx", "signup_age_proofs_consumed_idx"),
    ),
    PlanCheck(
        "saved-site ordering",
        "SELECT site_id FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC",
        ("user_fixture",),
        ("saved_sites_user_created_idx",),
    ),
    PlanCheck(
        "profile trip history",
        """SELECT id FROM trips
           WHERE user_id = ? AND status = 'completed'
           ORDER BY COALESCE(completed_at, ended_at, started_at) DESC LIMIT 100""",
        ("user_fixture",),
        ("trips_user_history_idx",),
    ),
    PlanCheck(
        "account trip export",
        "SELECT id FROM trips WHERE user_id = ? ORDER BY created_at DESC",
        ("user_fixture",),
        ("trips_user_created_idx",),
    ),
    PlanCheck(
        "AI review backlog",
        """SELECT id FROM trips
           WHERE status = 'completed'
             AND (ai_review_status IS NULL OR ai_review_status = 'retry')
           ORDER BY COALESCE(completed_at, ended_at, started_at) ASC LIMIT ?""",
        (10,),
        ("trips_ai_review_backlog_idx",),
    ),
    PlanCheck(
        "active-trip abuse ceiling",
        """SELECT COUNT(*) FROM trips
           WHERE reporter_key_hash = ? AND status = 'active' AND created_at >= ?""",
        ("reporter_fixture", "2026-07-17T00:00:00.000Z"),
        ("trips_reporter_active_created_idx",),
    ),
    PlanCheck(
        "trip deletion tombstone",
        """SELECT 1 FROM privacy_deletion_jobs
           WHERE scope = 'trip' AND subject_hash = ? LIMIT 1""",
        ("subject_fixture",),
        ("privacy_deletion_jobs_scope_subject_idx",),
    ),
    PlanCheck(
        "completed deletion-job retention",
        """SELECT id FROM privacy_deletion_jobs
           WHERE state = 'completed' AND completed_at < ?
           ORDER BY completed_at LIMIT 100""",
        ("2026-04-17T00:00:00.000Z",),
        ("privacy_deletion_jobs_state_completed_idx",),
    ),
    PlanCheck(
        "recruitment account export",
        """SELECT event_id FROM validation_feasibility_recruitment_events
           WHERE user_id = ? ORDER BY sequence ASC""",
        ("user_fixture",),
        ("validation_feasibility_recruitment_user_sequence_idx",),
    ),
    PlanCheck(
        "correction activation export",
        """SELECT correction_id FROM validation_feasibility_corrections
           WHERE activation_id = ? ORDER BY sequence ASC""",
        ("activation_fixture",),
        ("validation_feasibility_correction_activation_sequence_idx",),
    ),
)


def apply_migrations(connection: sqlite3.Connection) -> list[Path]:
    migrations = sorted(MIGRATIONS.glob("*.sql"))
    if not migrations or migrations[-1].name != "0017_trip_idempotency.sql":
        raise AssertionError("0017_trip_idempotency.sql must be the latest D1 migration")
    connection.execute("PRAGMA foreign_keys = ON")
    for path in migrations:
        sql = path.read_text(encoding="utf-8").replace("--> statement-breakpoint", "")
        connection.executescript(sql)
    return migrations


def explain(connection: sqlite3.Connection, check: PlanCheck) -> list[str]:
    return [
        str(row[3])
        for row in connection.execute(f"EXPLAIN QUERY PLAN {check.sql}", check.parameters)
    ]


def assert_critical_plans(connection: sqlite3.Connection) -> None:
    for check in CHECKS:
        details = explain(connection, check)
        joined = "\n".join(details)
        missing = [name for name in check.required_indexes if name not in joined]
        if missing:
            raise AssertionError(
                f"{check.name} does not use required index(es) {missing}:\n{joined}"
            )
        if check.reject_temporary_sort and "USE TEMP B-TREE FOR ORDER BY" in joined:
            raise AssertionError(f"{check.name} regressed to a temporary sort:\n{joined}")


def assert_foreign_key_indexes(connection: sqlite3.Connection) -> None:
    tables = [
        str(row[0])
        for row in connection.execute(
            """SELECT name FROM sqlite_schema
               WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"""
        )
    ]
    failures: list[str] = []
    for table in tables:
        indexes: list[tuple[str, tuple[str | None, ...]]] = []
        for index_row in connection.execute(f'PRAGMA index_list("{table}")'):
            index_name = str(index_row[1])
            columns = tuple(
                column_row[2]
                for column_row in connection.execute(f'PRAGMA index_info("{index_name}")')
            )
            indexes.append((index_name, columns))

        foreign_keys: dict[int, list[sqlite3.Row | tuple[object, ...]]] = {}
        for foreign_key in connection.execute(f'PRAGMA foreign_key_list("{table}")'):
            foreign_keys.setdefault(int(foreign_key[0]), []).append(foreign_key)
        for parts in foreign_keys.values():
            ordered = sorted(parts, key=lambda part: int(part[1]))
            child_columns = tuple(str(part[3]) for part in ordered)
            if not any(columns[: len(child_columns)] == child_columns for _, columns in indexes):
                parent = str(ordered[0][2])
                failures.append(f"{table}{child_columns} -> {parent}")

    if failures:
        raise AssertionError(
            "foreign-key child columns lack a matching leftmost index: " + ", ".join(failures)
        )


def main() -> None:
    with sqlite3.connect(":memory:") as connection:
        migrations = apply_migrations(connection)
        assert_critical_plans(connection)
        assert_foreign_key_indexes(connection)
    print(
        f"D1 query-plan contract verified: {len(migrations)} migrations, "
        f"{len(CHECKS)} critical plans, all foreign-key child paths indexed."
    )


if __name__ == "__main__":
    main()
