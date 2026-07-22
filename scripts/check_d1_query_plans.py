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
        """DELETE FROM auth_sessions WHERE token_hash IN (
             SELECT token_hash FROM auth_sessions WHERE expires_at <= ?
             ORDER BY expires_at, token_hash LIMIT ?
           )""",
        ("2026-07-17T00:00:00.000Z", 100),
        ("auth_sessions_expires_idx",),
    ),
    PlanCheck(
        "exact session issuance receipt",
        """SELECT token_hash, user_id, expires_at, created_at
           FROM auth_sessions
           WHERE token_hash = ? AND user_id = ? AND expires_at = ? AND created_at = ?
             AND EXISTS (SELECT 1 FROM users WHERE id = ?)
             AND NOT EXISTS (SELECT 1 FROM account_deletion_fences WHERE user_id = ?)
           LIMIT 1""",
        (
            "session_hash_fixture",
            "user_fixture",
            "2026-08-16T00:00:00.000Z",
            "2026-07-17T00:00:00.000Z",
            "user_fixture",
            "user_fixture",
        ),
        (
            "sqlite_autoindex_auth_sessions_1",
            "sqlite_autoindex_users_1",
            "sqlite_autoindex_account_deletion_fences_1",
        ),
    ),
    PlanCheck(
        "exact password reset receipt",
        """SELECT
             (SELECT COUNT(*) FROM users
               WHERE id = ? AND email = ? AND password_salt = ? AND password_hash = ?
                 AND updated_at = ?) AS exact_user_count,
             (SELECT COUNT(*) FROM users WHERE id = ?) AS any_user_count,
             (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?) AS session_count,
             (SELECT COUNT(*) FROM email_challenges
               WHERE id = ? AND kind = 'password_reset' AND user_id = ? AND code_hash = ?
                 AND created_at = ? AND attempts = ? AND expires_at > ?) AS exact_challenge_count,
             (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_challenge_count,
             (SELECT COUNT(*) FROM account_deletion_fences WHERE user_id = ?) AS fence_count""",
        (
            "user_fixture",
            "angler@example.com",
            "salt_fixture",
            "password_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "user_fixture",
            "user_fixture",
            "challenge_fixture",
            "user_fixture",
            "code_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            1,
            "2026-07-17T00:00:00.000Z",
            "challenge_fixture",
            "user_fixture",
        ),
        (
            "sqlite_autoindex_users_1",
            "auth_sessions_user_idx",
            "sqlite_autoindex_email_challenges_1",
            "sqlite_autoindex_account_deletion_fences_1",
        ),
    ),
    PlanCheck(
        "expired email challenges",
        """DELETE FROM email_challenges WHERE id IN (
             SELECT id FROM email_challenges WHERE expires_at <= ?
             ORDER BY expires_at, id LIMIT ?
           )""",
        ("2026-07-17T00:00:00.000Z", 100),
        ("email_challenges_expires_idx",),
    ),
    PlanCheck(
        "old authentication attempts",
        """DELETE FROM auth_attempts WHERE id IN (
             SELECT id FROM auth_attempts WHERE attempted_at < ?
             ORDER BY attempted_at, id LIMIT ?
           )""",
        ("2026-06-17T00:00:00.000Z", 100),
        ("auth_attempts_attempted_idx",),
    ),
    PlanCheck(
        "atomic sign-in attempt ceiling",
        """INSERT INTO auth_attempts (id, email_hash, attempted_at, successful)
           SELECT ?, ?, ?, 0
           WHERE (SELECT COUNT(*) FROM auth_attempts
                  WHERE email_hash = ? AND successful = 0 AND attempted_at >= ?) < 10""",
        (
            "attempt_fixture",
            "email_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "email_hash_fixture",
            "2026-07-16T23:00:00.000Z",
        ),
        ("auth_attempts_email_time_idx",),
    ),
    PlanCheck(
        "sign-in success classification",
        """UPDATE auth_attempts SET successful = 1
           WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 0""",
        ("attempt_fixture", "email_hash_fixture", "2026-07-17T00:00:00.000Z"),
        ("sqlite_autoindex_auth_attempts_1",),
    ),
    PlanCheck(
        "atomic email challenge issuance ceiling",
        """INSERT INTO email_challenges
             (id, kind, email, user_id, code_hash, expires_at, attempts, created_at)
           SELECT ?, 'password_reset', ?, ?, ?, ?, 0, ?
           WHERE (SELECT COUNT(*) FROM email_challenges
                  WHERE email = ? AND created_at >= ?) < 5""",
        (
            "challenge_fixture",
            "angler@example.com",
            "user_fixture",
            "code_hash_fixture",
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:00:00.000Z",
            "angler@example.com",
            "2026-07-16T23:00:00.000Z",
        ),
        ("email_challenges_email_time_idx",),
    ),
    PlanCheck(
        "atomic email challenge attempt claim",
        """UPDATE email_challenges SET attempts = ?
           WHERE id = ? AND kind = ? AND code_hash = ? AND created_at = ?
             AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?""",
        (
            1,
            "challenge_fixture",
            "signup",
            "code_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            0,
            0,
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:00:00.000Z",
        ),
        ("sqlite_autoindex_email_challenges_1",),
    ),
    PlanCheck(
        "expired or consumed age proofs",
        """DELETE FROM signup_age_proofs WHERE token_hash IN (
             SELECT token_hash FROM signup_age_proofs
             WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)
             LIMIT ?
           )""",
        ("2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z", 100),
        ("signup_age_proofs_expiry_idx", "signup_age_proofs_consumed_idx"),
    ),
    PlanCheck(
        "saved-site ordering",
        "SELECT site_id FROM saved_sites WHERE user_id = ? ORDER BY created_at DESC",
        ("user_fixture",),
        ("saved_sites_user_created_idx",),
    ),
    PlanCheck(
        "gear-profile ordering",
        "SELECT id FROM gear_profiles WHERE user_id = ? ORDER BY updated_at DESC",
        ("user_fixture",),
        ("gear_profiles_user_updated_idx",),
    ),
    PlanCheck(
        "gear-profile update exact receipt",
        """SELECT id, user_id, name, rod, reel, bait_lure, rig, created_at, updated_at
           FROM gear_profiles WHERE id = ? AND user_id = ? LIMIT 1""",
        ("gear_fixture", "user_fixture"),
        ("sqlite_autoindex_gear_profiles_1",),
    ),
    PlanCheck(
        "gear-profile deletion exact state",
        """SELECT
             (SELECT COUNT(*) FROM gear_profiles WHERE id = ? AND user_id = ?) AS owner_count,
             (SELECT COUNT(*) FROM gear_profiles WHERE id = ?) AS any_count""",
        ("gear_fixture", "user_fixture", "gear_fixture"),
        ("sqlite_autoindex_gear_profiles_1",),
    ),
    PlanCheck(
        "profile trip history",
        """SELECT id FROM trips INDEXED BY trips_user_history_idx
           WHERE user_id = ? AND status = 'completed'
           ORDER BY COALESCE(completed_at, ended_at, started_at) DESC LIMIT 100""",
        ("user_fixture",),
        ("trips_user_history_idx",),
    ),
    PlanCheck(
        "profile trip edit exact receipt",
        """SELECT trip.id, evidence.id, correction.correction_id
           FROM trips AS trip
           INNER JOIN trip_validation_provenance AS evidence
             ON evidence.id = ? AND evidence.trip_id = trip.id
             AND evidence.event_type = 'evidence_exclusion'
             AND evidence.attestation_status = 'invalidated_after_edit'
             AND evidence.evidence_status = 'context_only'
             AND evidence.exclusion_reason = 'post_completion_profile_edit'
             AND evidence.created_at = ?
           LEFT JOIN validation_feasibility_corrections AS correction
             ON correction.correction_id = ? AND correction.trip_id = trip.id
             AND correction.corrected_at = ?
           WHERE trip.id = ? AND trip.user_id = ? LIMIT 1""",
        (
            "validation_fixture",
            "2026-07-21T00:00:00.000Z",
            "correction_fixture",
            "2026-07-21T00:00:00.000Z",
            "trip_fixture",
            "user_fixture",
        ),
        (
            "sqlite_autoindex_trip_validation_provenance_1",
            "sqlite_autoindex_trips_1",
            "validation_feasibility_correction_id_unique",
        ),
    ),
    PlanCheck(
        "pending trip deletion exact receipt",
        """SELECT job.id, task.id,
             (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = job.id),
             (SELECT COUNT(*) FROM trips WHERE id = ? AND user_id = ?),
             (SELECT COUNT(*) FROM site_discussion_posts WHERE trip_id = ?)
           FROM privacy_deletion_jobs AS job
           LEFT JOIN privacy_deletion_tasks AS task ON task.job_id = job.id
           WHERE job.receipt_hash = ? LIMIT 1""",
        (
            "trip_fixture",
            "user_fixture",
            "trip_fixture",
            "receipt_fixture",
        ),
        (
            "privacy_deletion_jobs_receipt_unique",
            "privacy_deletion_tasks_job_object_unique",
            "sqlite_autoindex_trips_1",
            "site_discussion_posts_trip_unique",
        ),
    ),
    PlanCheck(
        "account deletion exact receipt",
        """SELECT job.id,
             (SELECT COUNT(*) FROM privacy_deletion_tasks WHERE job_id = job.id),
             (SELECT COUNT(*) FROM privacy_deletion_tasks AS task WHERE task.job_id = job.id),
             (SELECT COUNT(*) FROM users WHERE id = ?),
             (SELECT COUNT(*) FROM trips WHERE user_id = ?),
             (SELECT COUNT(*) FROM account_deletion_fences WHERE owner_subject_hash = ?),
             (SELECT COUNT(*) FROM trip_photo_upload_reservations WHERE owner_subject_hash = ?),
             (SELECT COUNT(*) FROM auth_attempts WHERE email_hash = ?),
             (SELECT COUNT(*) FROM privacy_export_jobs
                WHERE user_id = ? AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')),
             (SELECT COUNT(*) FROM privacy_export_jobs
                WHERE owner_subject_hash = ?
                  AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention'))
           FROM privacy_deletion_jobs AS job
           WHERE job.receipt_hash = ? LIMIT 1""",
        (
            "user_fixture",
            "user_fixture",
            "owner_fixture",
            "owner_fixture",
            "email_fixture",
            "user_fixture",
            "owner_fixture",
            "receipt_fixture",
        ),
        (
            "privacy_deletion_jobs_receipt_unique",
            "privacy_deletion_tasks_job_object_unique",
            "sqlite_autoindex_users_1",
            "trips_user_created_idx",
            "account_deletion_fences_owner_unique",
            "trip_photo_upload_reservations_owner_idx",
            "auth_attempts_email_time_idx",
            "privacy_export_jobs_active_user_unique",
            "privacy_export_jobs_owner_idx",
        ),
    ),
    PlanCheck(
        "account trip export",
        "SELECT id FROM trips WHERE user_id = ? ORDER BY created_at DESC",
        ("user_fixture",),
        ("trips_user_created_idx",),
    ),
    PlanCheck(
        "AI review backlog",
        """SELECT id FROM trips INDEXED BY trips_ai_review_backlog_idx
           WHERE status = 'completed'
             AND ((ai_review_status IS NULL OR ai_review_status = 'queued'
                   OR ai_review_status = 'retry')
               OR (ai_review_status = 'processing'
                 AND CASE WHEN json_valid(ai_review_json)
                   THEN json_extract(ai_review_json, '$.version') END = ?
                 AND CASE WHEN json_valid(ai_review_json)
                   THEN json_extract(ai_review_json, '$.leaseExpiresAt') END <= ?))
           ORDER BY COALESCE(completed_at, ended_at, started_at) ASC LIMIT ?""",
        ("castingcompass.ai-review-claim/1.0.0", "2026-07-21T00:00:00.000Z", 10),
        ("trips_ai_review_backlog_idx",),
    ),
    PlanCheck(
        "AI review queue dispatch",
        """SELECT id FROM ai_review_jobs
           WHERE ((state = 'pending' OR state = 'retry' OR state = 'queued')
                  AND available_at <= ?)
              OR (state = 'processing'
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           ORDER BY available_at, created_at LIMIT ?""",
        ("2026-07-17T00:00:00.000Z", "2026-07-17T00:00:00.000Z", 10),
        ("ai_review_jobs_dispatch_idx",),
        reject_temporary_sort=False,
    ),
    PlanCheck(
        "privacy export owner job",
        """SELECT id FROM privacy_export_jobs
           WHERE user_id = ?
             AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')
           ORDER BY requested_at DESC LIMIT 1""",
        ("user_fixture",),
        ("privacy_export_jobs_active_user_unique",),
        reject_temporary_sort=False,
    ),
    PlanCheck(
        "privacy export queue dispatch",
        """SELECT id FROM privacy_export_jobs
           WHERE (((state = 'pending' OR state = 'retry' OR state = 'queued') AND available_at <= ?)
             OR (state = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
             AND user_id IS NOT NULL
           ORDER BY available_at, requested_at LIMIT ?""",
        ("2026-07-17T00:00:00.000Z", "2026-07-17T00:00:00.000Z", 10),
        ("privacy_export_jobs_dispatch_idx",),
        reject_temporary_sort=False,
    ),
    PlanCheck(
        "privacy export expiry",
        """SELECT id FROM privacy_export_jobs
           WHERE object_key IS NOT NULL
             AND state = 'completed' AND expires_at <= ?
           ORDER BY expires_at, id LIMIT ?""",
        ("2026-07-17T00:00:00.000Z", 50),
        ("privacy_export_jobs_expiry_idx",),
    ),
    PlanCheck(
        "typed privacy object retry",
        """SELECT id FROM privacy_deletion_tasks
           WHERE object_store = ? AND state = 'pending' AND available_at <= ?
           ORDER BY available_at LIMIT ?""",
        ("privacy_exports", "2026-07-17T00:00:00.000Z", 50),
        ("privacy_deletion_tasks_store_retry_idx",),
    ),
    PlanCheck(
        "trip photo reservation reconciliation",
        """SELECT id FROM trip_photo_upload_reservations
           WHERE (state = 'pending' AND available_at <= ?)
              OR (state = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           ORDER BY available_at, created_at LIMIT ?""",
        ("2026-07-17T00:00:00.000Z", "2026-07-17T00:00:00.000Z", 50),
        ("trip_photo_upload_reservations_retry_idx",),
        reject_temporary_sort=False,
    ),
    PlanCheck(
        "account prior deletion-task inventory",
        """SELECT task.object_key, task.object_key_hash, task.object_store, task.available_at
           FROM privacy_deletion_tasks AS task
           JOIN privacy_deletion_jobs AS source_job ON source_job.id = task.job_id
           WHERE source_job.owner_subject_hash = ? AND source_job.id != ?
             AND task.state != 'completed' AND task.object_key IS NOT NULL""",
        ("a" * 64, "deletion_fixture"),
        ("privacy_deletion_jobs_owner_state_idx", "privacy_deletion_tasks_job_object_unique"),
    ),
    PlanCheck(
        "account photo reservation inventory",
        """SELECT object_key, object_key_hash, available_at
           FROM trip_photo_upload_reservations WHERE owner_subject_hash = ?""",
        ("a" * 64,),
        ("trip_photo_upload_reservations_owner_idx",),
    ),
    PlanCheck(
        "account privacy-export inventory",
        """SELECT object_key, object_key_hash FROM privacy_export_jobs
           WHERE owner_subject_hash = ? AND object_key IS NOT NULL
             AND object_key_hash IS NOT NULL
             AND state IN ('pending', 'queued', 'processing', 'retry', 'completed', 'needs_attention')""",
        ("a" * 64,),
        ("privacy_export_jobs_owner_idx",),
    ),
    PlanCheck(
        "account attached-photo inventory",
        """SELECT photo_key, photo_key_hash FROM trips
           WHERE user_id = ? AND photo_key IS NOT NULL AND photo_key_hash IS NOT NULL""",
        ("user_fixture",),
        ("trips_user_created_idx",),
    ),
    PlanCheck(
        "account deletion fence receipt",
        """SELECT requested_at FROM account_deletion_fences
           WHERE user_id = ? AND owner_subject_hash = ? AND lease_token = ?
             AND lease_expires_at = ? LIMIT 1""",
        (
            "user_fixture",
            "a" * 64,
            "account-deletion-fence-token-0000000000000000",
            "2026-07-17T00:05:00.000Z",
        ),
        ("account_deletion_fences_owner_unique",),
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
        """DELETE FROM privacy_deletion_jobs WHERE id IN (
             SELECT id FROM privacy_deletion_jobs
             WHERE state = 'completed' AND completed_at < ?
               AND objects_deleted = objects_total
               AND (SELECT COUNT(*) FROM privacy_deletion_tasks
                 WHERE job_id = privacy_deletion_jobs.id) = objects_total
               AND NOT EXISTS (SELECT 1 FROM privacy_deletion_tasks
                 WHERE job_id = privacy_deletion_jobs.id AND state != 'completed')
             ORDER BY completed_at, id LIMIT ?
           )""",
        ("2026-04-17T00:00:00.000Z", 100),
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
    if not migrations or migrations[-1].name != "0020_trip_photo_upload_reservations.sql":
        raise AssertionError("0020_trip_photo_upload_reservations.sql must be the latest D1 migration")
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
