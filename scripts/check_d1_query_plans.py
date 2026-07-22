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
        "exact sign-out revocation receipt",
        "SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?",
        ("session_hash_fixture",),
        ("sqlite_autoindex_auth_sessions_1",),
    ),
    PlanCheck(
        "exact legal acceptance compare-and-set",
        """UPDATE users SET terms_accepted_at = ?, terms_version = ?,
             privacy_accepted_at = ?, privacy_version = ?, updated_at = ?
           WHERE id = ? AND email = ? AND age_eligibility_confirmed_at = ?
             AND terms_accepted_at IS ? AND terms_version IS ?
             AND privacy_accepted_at IS ? AND privacy_version IS ?
             AND created_at = ? AND updated_at = ?
             AND EXISTS (SELECT 1 FROM auth_sessions
               WHERE token_hash = ? AND user_id = ? AND expires_at = ? AND expires_at > ?)""",
        (
            "2026-07-22T06:00:00.000Z",
            "2026-07-16",
            "2026-07-22T06:00:00.000Z",
            "2026-07-16",
            "2026-07-22T06:00:00.000Z",
            "user_fixture",
            "angler@example.com",
            "2025-01-02T03:04:05.000Z",
            "2025-01-01T00:00:00.000Z",
            "old",
            "2025-01-01T00:00:00.000Z",
            "old",
            "2026-07-01T00:00:00.000Z",
            "2026-07-21T00:00:00.000Z",
            "session_hash_fixture",
            "user_fixture",
            "2026-08-21T00:00:00.000Z",
            "2026-07-22T06:00:00.000Z",
        ),
        ("users_email_unique", "sqlite_autoindex_auth_sessions_1"),
    ),
    PlanCheck(
        "exact legal acceptance receipt",
        """SELECT
             (SELECT COUNT(*) FROM users
               WHERE id = ? AND email = ? AND age_eligibility_confirmed_at = ?
                 AND terms_accepted_at = ? AND terms_version = ?
                 AND privacy_accepted_at = ? AND privacy_version = ?
                 AND created_at = ? AND updated_at = ?) AS accepted_count,
             (SELECT COUNT(*) FROM users
               WHERE id = ? AND email = ? AND age_eligibility_confirmed_at = ?
                 AND terms_accepted_at IS ? AND terms_version IS ?
                 AND privacy_accepted_at IS ? AND privacy_version IS ?
                 AND created_at = ? AND updated_at = ?) AS prior_count,
             (SELECT COUNT(*) FROM users WHERE id = ?) AS account_count,
             (SELECT COUNT(*) FROM auth_sessions
               WHERE token_hash = ? AND user_id = ? AND expires_at = ? AND expires_at > ?) AS session_count""",
        (
            "user_fixture",
            "angler@example.com",
            "2025-01-02T03:04:05.000Z",
            "2026-07-22T06:00:00.000Z",
            "2026-07-16",
            "2026-07-22T06:00:00.000Z",
            "2026-07-16",
            "2026-07-01T00:00:00.000Z",
            "2026-07-22T06:00:00.000Z",
            "user_fixture",
            "angler@example.com",
            "2025-01-02T03:04:05.000Z",
            "2025-01-01T00:00:00.000Z",
            "old",
            "2025-01-01T00:00:00.000Z",
            "old",
            "2026-07-01T00:00:00.000Z",
            "2026-07-21T00:00:00.000Z",
            "user_fixture",
            "session_hash_fixture",
            "user_fixture",
            "2026-08-21T00:00:00.000Z",
            "2026-07-22T06:00:00.000Z",
        ),
        ("users_email_unique", "sqlite_autoindex_users_1", "sqlite_autoindex_auth_sessions_1"),
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
        "exact account creation receipt",
        """SELECT
             (SELECT COUNT(*) FROM users
               WHERE id = ? AND email = ? AND password_salt = ? AND password_hash = ?
                 AND age_eligibility_confirmed_at = ? AND terms_accepted_at = ?
                 AND terms_version = ? AND privacy_accepted_at = ? AND privacy_version = ?
                 AND created_at = ? AND updated_at = ?) AS exact_user_count,
             (SELECT COUNT(*) FROM users WHERE id = ?) AS any_user_count,
             (SELECT COUNT(*) FROM users WHERE email = ?) AS email_user_count,
             (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?) AS session_count,
             (SELECT COUNT(*) FROM email_challenges
               WHERE id = ? AND kind = 'signup' AND email = ? AND code_hash = ?
                 AND password_salt = ? AND password_hash = ?
                 AND age_eligibility_confirmed_at = ? AND terms_version = ?
                 AND privacy_version = ? AND created_at = ? AND attempts = ?
                 AND resend_count = ? AND expires_at = ? AND expires_at > ?) AS exact_challenge_count,
             (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_challenge_count,
             (SELECT COUNT(*) FROM account_deletion_fences WHERE user_id = ?) AS fence_count""",
        (
            "new_user_fixture",
            "new-angler@example.com",
            "salt_fixture",
            "password_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "2026-07-17T00:01:00.000Z",
            "2026-07-16",
            "2026-07-17T00:01:00.000Z",
            "2026-07-16",
            "2026-07-17T00:01:00.000Z",
            "2026-07-17T00:01:00.000Z",
            "new_user_fixture",
            "new-angler@example.com",
            "new_user_fixture",
            "signup_challenge_fixture",
            "new-angler@example.com",
            "code_hash_fixture",
            "salt_fixture",
            "password_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "2026-07-16",
            "2026-07-16",
            "2026-07-17T00:00:00.000Z",
            1,
            0,
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:01:00.000Z",
            "signup_challenge_fixture",
            "new_user_fixture",
        ),
        (
            "sqlite_autoindex_users_1",
            "users_email_unique",
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
        "exact sign-in attempt claim receipt",
        """SELECT
             (SELECT COUNT(*) FROM auth_attempts
               WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 0) AS pending_count,
             (SELECT COUNT(*) FROM auth_attempts WHERE id = ?) AS any_count,
             (SELECT COUNT(*) FROM auth_attempts
               WHERE email_hash = ? AND successful = 0 AND attempted_at >= ?) AS recent_failed_count""",
        (
            "attempt_fixture",
            "email_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "attempt_fixture",
            "email_hash_fixture",
            "2026-07-16T23:00:00.000Z",
        ),
        ("sqlite_autoindex_auth_attempts_1", "auth_attempts_email_time_idx"),
    ),
    PlanCheck(
        "exact sign-in success-classification receipt",
        """SELECT
             (SELECT COUNT(*) FROM auth_attempts
               WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 1) AS classified_count,
             (SELECT COUNT(*) FROM auth_attempts
               WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 0) AS pending_count,
             (SELECT COUNT(*) FROM auth_attempts WHERE id = ?) AS any_count""",
        (
            "attempt_fixture",
            "email_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "attempt_fixture",
            "email_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "attempt_fixture",
        ),
        ("sqlite_autoindex_auth_attempts_1",),
    ),
    PlanCheck(
        "atomic email challenge issuance ceiling",
        """INSERT INTO email_challenges
             (id, kind, email, user_id, code_hash, password_salt, password_hash,
              age_eligibility_confirmed_at, terms_version, privacy_version, expires_at,
              attempts, resend_count, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM email_challenges
                  WHERE email = ? AND created_at >= ?) < 5""",
        (
            "challenge_fixture",
            "password_reset",
            "angler@example.com",
            "user_fixture",
            "code_hash_fixture",
            None,
            None,
            None,
            None,
            None,
            "2026-07-17T00:15:00.000Z",
            0,
            0,
            "2026-07-17T00:00:00.000Z",
            "angler@example.com",
            "2026-07-16T23:00:00.000Z",
        ),
        ("email_challenges_email_time_idx",),
    ),
    PlanCheck(
        "exact email challenge issuance receipt",
        """SELECT
             (SELECT COUNT(*) FROM email_challenges
               WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
                 AND password_salt IS ? AND password_hash IS ?
                 AND age_eligibility_confirmed_at IS ? AND terms_version IS ? AND privacy_version IS ?
                 AND expires_at = ? AND attempts = ? AND resend_count = ? AND created_at = ?) AS exact_count,
             (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_count,
             (SELECT COUNT(*) FROM email_challenges WHERE email = ? AND created_at >= ?) AS recent_count""",
        (
            "challenge_fixture",
            "password_reset",
            "angler@example.com",
            "user_fixture",
            "code_hash_fixture",
            None,
            None,
            None,
            None,
            None,
            "2026-07-17T00:15:00.000Z",
            0,
            0,
            "2026-07-17T00:00:00.000Z",
            "challenge_fixture",
            "angler@example.com",
            "2026-07-16T23:00:00.000Z",
        ),
        ("sqlite_autoindex_email_challenges_1", "email_challenges_email_time_idx"),
    ),
    PlanCheck(
        "atomic email challenge resend transition",
        """UPDATE email_challenges
           SET code_hash = ?, expires_at = ?, attempts = ?, resend_count = ?, created_at = ?
           WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
             AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
             AND terms_version IS ? AND privacy_version IS ? AND expires_at = ?
             AND attempts = ? AND resend_count = ? AND created_at = ?""",
        (
            "next_code_hash_fixture",
            "2026-07-17T00:16:00.000Z",
            0,
            1,
            "2026-07-17T00:01:00.000Z",
            "challenge_fixture",
            "signup",
            "angler@example.com",
            None,
            "prior_code_hash_fixture",
            "salt_fixture",
            "password_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "2026-07-16",
            "2026-07-16",
            "2026-07-17T00:15:00.000Z",
            0,
            0,
            "2026-07-17T00:00:00.000Z",
        ),
        ("sqlite_autoindex_email_challenges_1",),
    ),
    PlanCheck(
        "exact email challenge resend receipt",
        """SELECT
             (SELECT COUNT(*) FROM email_challenges
               WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
                 AND password_salt IS ? AND password_hash IS ?
                 AND age_eligibility_confirmed_at IS ? AND terms_version IS ? AND privacy_version IS ?
                 AND expires_at = ? AND attempts = ? AND resend_count = ? AND created_at = ?) AS next_count,
             (SELECT COUNT(*) FROM email_challenges
               WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
                 AND password_salt IS ? AND password_hash IS ?
                 AND age_eligibility_confirmed_at IS ? AND terms_version IS ? AND privacy_version IS ?
                 AND expires_at = ? AND attempts = ? AND resend_count = ? AND created_at = ?) AS prior_count,
             (SELECT COUNT(*) FROM email_challenges WHERE id = ?) AS any_count""",
        (
            "challenge_fixture", "signup", "angler@example.com", None,
            "next_code_hash_fixture", "salt_fixture", "password_hash_fixture",
            "2026-07-17T00:00:00.000Z", "2026-07-16", "2026-07-16",
            "2026-07-17T00:16:00.000Z", 0, 1, "2026-07-17T00:01:00.000Z",
            "challenge_fixture", "signup", "angler@example.com", None,
            "prior_code_hash_fixture", "salt_fixture", "password_hash_fixture",
            "2026-07-17T00:00:00.000Z", "2026-07-16", "2026-07-16",
            "2026-07-17T00:15:00.000Z", 0, 0, "2026-07-17T00:00:00.000Z",
            "challenge_fixture",
        ),
        ("sqlite_autoindex_email_challenges_1",),
    ),
    PlanCheck(
        "atomic email challenge attempt claim",
        """UPDATE email_challenges SET attempts = ?
           WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
             AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
             AND terms_version IS ? AND privacy_version IS ? AND created_at = ?
             AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?""",
        (
            1,
            "challenge_fixture",
            "signup",
            "new-angler@example.com",
            None,
            "code_hash_fixture",
            "salt_fixture",
            "password_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "2026-07-16",
            "2026-07-16",
            "2026-07-17T00:00:00.000Z",
            0,
            0,
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:00:00.000Z",
        ),
        ("sqlite_autoindex_email_challenges_1",),
    ),
    PlanCheck(
        "exact email challenge attempt receipt",
        """SELECT
             (SELECT COUNT(*) FROM email_challenges
               WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
                 AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
                 AND terms_version IS ? AND privacy_version IS ? AND created_at = ?
                 AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?) AS claimed_count,
             (SELECT COUNT(*) FROM email_challenges
               WHERE id = ? AND kind = ? AND email = ? AND user_id IS ? AND code_hash = ?
                 AND password_salt IS ? AND password_hash IS ? AND age_eligibility_confirmed_at IS ?
                 AND terms_version IS ? AND privacy_version IS ? AND created_at = ?
                 AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?) AS prior_count,
             (SELECT COUNT(*) FROM email_challenges WHERE id = ? AND kind = ?) AS any_count""",
        (
            "challenge_fixture",
            "signup",
            "new-angler@example.com",
            None,
            "code_hash_fixture",
            "salt_fixture",
            "password_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "2026-07-16",
            "2026-07-16",
            "2026-07-17T00:00:00.000Z",
            1,
            0,
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:01:00.000Z",
            "challenge_fixture",
            "signup",
            "new-angler@example.com",
            None,
            "code_hash_fixture",
            "salt_fixture",
            "password_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "2026-07-16",
            "2026-07-16",
            "2026-07-17T00:00:00.000Z",
            0,
            0,
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:01:00.000Z",
            "challenge_fixture",
            "signup",
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
        "exact age-proof creation receipt",
        """SELECT
             (SELECT COUNT(*) FROM signup_age_proofs
               WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ?
                 AND expires_at = ? AND consumed_at IS NULL AND created_at = ?) AS exact_count,
             (SELECT COUNT(*) FROM signup_age_proofs WHERE token_hash = ?) AS any_count""",
        (
            "proof_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "california-13-v1",
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:00:00.000Z",
            "proof_hash_fixture",
        ),
        ("sqlite_autoindex_signup_age_proofs_1",),
    ),
    PlanCheck(
        "exact age-proof consumption receipt",
        """SELECT
             (SELECT COUNT(*) FROM signup_age_proofs
               WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ? AND expires_at = ?
                 AND consumed_at = ? AND created_at = ?) AS consumed_count,
             (SELECT COUNT(*) FROM signup_age_proofs
               WHERE token_hash = ? AND confirmed_at = ? AND gate_version = ? AND expires_at = ?
                 AND consumed_at IS NULL AND created_at = ? AND expires_at > ?) AS prior_count,
             (SELECT COUNT(*) FROM signup_age_proofs WHERE token_hash = ?) AS any_count""",
        (
            "proof_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "california-13-v1",
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:01:00.000Z",
            "2026-07-17T00:00:00.000Z",
            "proof_hash_fixture",
            "2026-07-17T00:00:00.000Z",
            "california-13-v1",
            "2026-07-17T00:15:00.000Z",
            "2026-07-17T00:00:00.000Z",
            "2026-07-17T00:01:00.000Z",
            "proof_hash_fixture",
        ),
        ("sqlite_autoindex_signup_age_proofs_1",),
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
        "exact manual review retry compare-and-set",
        """UPDATE trips SET ai_review_status = 'queued', ai_review_json = NULL,
             ai_review_model = NULL, ai_reviewed_at = NULL
           WHERE id = ? AND user_id = ? AND status = 'completed'
             AND ai_review_status IS ? AND ai_review_json IS ?
             AND ai_review_model IS ? AND ai_reviewed_at IS ? AND updated_at = ?""",
        (
            "trip_fixture",
            "user_fixture",
            "retry",
            None,
            None,
            None,
            "2026-07-22T06:00:00.000Z",
        ),
        ("sqlite_autoindex_trips_1",),
    ),
    PlanCheck(
        "exact manual review retry receipt",
        """SELECT
             (SELECT COUNT(*) FROM trips
               WHERE id = ? AND user_id = ? AND status = 'completed'
                 AND ai_review_status = 'queued' AND ai_review_json IS NULL
                 AND ai_review_model IS NULL AND ai_reviewed_at IS NULL AND updated_at = ?) AS queued_count,
             (SELECT COUNT(*) FROM trips
               WHERE id = ? AND user_id = ? AND status = 'completed'
                 AND ai_review_status IS ? AND ai_review_json IS ?
                 AND ai_review_model IS ? AND ai_reviewed_at IS ? AND updated_at = ?) AS prior_count,
             (SELECT COUNT(*) FROM trips
               WHERE id = ? AND user_id = ? AND status = 'completed') AS owner_count,
             (SELECT COUNT(*) FROM trips WHERE id = ?) AS any_count""",
        (
            "trip_fixture",
            "user_fixture",
            "2026-07-22T06:00:00.000Z",
            "trip_fixture",
            "user_fixture",
            "retry",
            None,
            None,
            None,
            "2026-07-22T06:00:00.000Z",
            "trip_fixture",
            "user_fixture",
            "trip_fixture",
        ),
        ("sqlite_autoindex_trips_1",),
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
        "completed deletion-task retention candidate",
        """SELECT job.id, job.completed_at, job.objects_total, job.objects_deleted,
             (SELECT COUNT(*) FROM (
               SELECT task.id
               FROM privacy_deletion_tasks AS task
                 INDEXED BY privacy_deletion_tasks_job_object_unique
               WHERE task.job_id = job.id
                 AND task.state = 'completed' AND task.object_key IS NULL
               ORDER BY task.object_key_hash LIMIT ?
             )) AS prune_count
           FROM privacy_deletion_jobs AS job
             INDEXED BY privacy_deletion_jobs_state_completed_idx
           WHERE job.state = 'completed' AND job.completed_at < ?
             AND job.objects_deleted = job.objects_total
             AND job.objects_total > 0 AND job.last_error_code IS NULL
             AND EXISTS (
               SELECT 1
               FROM privacy_deletion_tasks AS eligible_task
                 INDEXED BY privacy_deletion_tasks_job_object_unique
               WHERE eligible_task.job_id = job.id
                 AND eligible_task.state = 'completed'
                 AND eligible_task.object_key IS NULL LIMIT 1
             )
             AND job.objects_total >= (
               SELECT COUNT(*) FROM (
                 SELECT bounded_task.id
                 FROM privacy_deletion_tasks AS bounded_task
                   INDEXED BY privacy_deletion_tasks_job_object_unique
                 WHERE bounded_task.job_id = job.id
                   AND bounded_task.state = 'completed'
                   AND bounded_task.object_key IS NULL
                 ORDER BY bounded_task.object_key_hash LIMIT ?
               )
             )
           ORDER BY job.completed_at LIMIT 1""",
        (100, "2026-04-17T00:00:00.000Z", 100),
        (
            "privacy_deletion_jobs_state_completed_idx",
            "privacy_deletion_tasks_job_object_unique",
        ),
    ),
    PlanCheck(
        "completed deletion-task retention claim",
        """UPDATE privacy_deletion_jobs
           SET objects_total = ?, objects_deleted = ?, last_error_code = ?
           WHERE id = ? AND state = 'completed' AND completed_at = ?
             AND objects_total = ? AND objects_deleted = ? AND last_error_code IS NULL""",
        (1, 1, "retention_prune_fixture", "job_fixture", "2026-04-01T00:00:00.000Z", 101, 101),
        ("sqlite_autoindex_privacy_deletion_jobs_1",),
    ),
    PlanCheck(
        "completed deletion-task retention delete",
        """DELETE FROM privacy_deletion_tasks WHERE id IN (
             SELECT task.id
             FROM privacy_deletion_tasks AS task
               INDEXED BY privacy_deletion_tasks_job_object_unique
             WHERE task.job_id = ?
               AND task.state = 'completed' AND task.object_key IS NULL
               AND EXISTS (
                 SELECT 1 FROM privacy_deletion_jobs AS job
                 WHERE job.id = ? AND job.state = 'completed' AND job.completed_at = ?
                   AND job.objects_total = ? AND job.objects_deleted = ?
                   AND job.last_error_code = ? LIMIT 1
               )
             ORDER BY task.object_key_hash LIMIT ?
           )""",
        (
            "job_fixture", "job_fixture", "2026-04-01T00:00:00.000Z",
            1, 1, "retention_prune_fixture", 100,
        ),
        (
            "sqlite_autoindex_privacy_deletion_jobs_1",
            "privacy_deletion_tasks_job_object_unique",
        ),
    ),
    PlanCheck(
        "completed deletion-task retention claim clear",
        """UPDATE privacy_deletion_jobs SET last_error_code = NULL
           WHERE id = ? AND state = 'completed' AND completed_at = ?
             AND objects_total = ? AND objects_deleted = ? AND last_error_code = ?""",
        ("job_fixture", "2026-04-01T00:00:00.000Z", 1, 1, "retention_prune_fixture"),
        ("sqlite_autoindex_privacy_deletion_jobs_1",),
    ),
    PlanCheck(
        "completed deletion-job retention",
        """DELETE FROM privacy_deletion_jobs WHERE id IN (
             SELECT job.id
             FROM privacy_deletion_jobs AS job
               INDEXED BY privacy_deletion_jobs_state_completed_idx
             WHERE job.state = 'completed' AND job.completed_at < ?
               AND job.objects_deleted = job.objects_total
               AND job.objects_total = 0 AND job.objects_deleted = 0
               AND job.last_error_code IS NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM privacy_deletion_tasks AS task
                   INDEXED BY privacy_deletion_tasks_job_object_unique
                 WHERE task.job_id = job.id
                 LIMIT 1
               )
             ORDER BY job.completed_at LIMIT ?
           )""",
        ("2026-04-17T00:00:00.000Z", 100),
        (
            "privacy_deletion_jobs_state_completed_idx",
            "privacy_deletion_tasks_job_object_unique",
        ),
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
