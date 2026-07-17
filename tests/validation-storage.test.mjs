import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RESTORE_EVIDENCE_VERSION,
  sealPrivacyLedger,
  sealOperationalSnapshot,
  runOperationalRestoreDrill,
  verifyStorageAuditLog,
} from "../scripts/validation-storage.mjs";

const ACTIVATION_ID = "activation-storage-drill-test";
const ACCOUNT_ID = "user-deleted-before-restore";
const TRIP_ID = "trip-deleted-before-restore";
const OBJECT_KEY = "private/deleted-before-restore.webp";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function privateWrite(path, value) {
  writeFileSync(path, value, { mode: 0o600, flag: "wx" });
}

function snapshotSql() {
  return `
PRAGMA foreign_keys = ON;
CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO d1_migrations (id, name) VALUES (14, '0014_validation_feasibility_recruitment_and_corrections.sql');
CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE trips (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE site_discussion_posts (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  summary TEXT NOT NULL
);
CREATE TABLE privacy_deletion_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  owner_subject_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  objects_total INTEGER NOT NULL,
  objects_deleted INTEGER NOT NULL,
  last_error_code TEXT,
  requested_at TEXT NOT NULL,
  active_data_removed_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE privacy_deletion_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES privacy_deletion_jobs(id) ON DELETE CASCADE,
  object_key TEXT,
  object_key_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  lease_token TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE validation_feasibility_activations (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE validation_feasibility_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT, activation_id TEXT, trip_id TEXT REFERENCES trips(id) ON DELETE CASCADE, event_type TEXT,
  event_contract_version TEXT, source_record_sha256 TEXT, participant_group_id TEXT,
  recruitment_frame_id TEXT, recruitment_source_id TEXT, selection_method TEXT,
  score_influenced_choice INTEGER, study_consent_version TEXT, study_consented_at TEXT,
  target_taxon_id TEXT, site_id TEXT, geographic_panel TEXT, mode TEXT,
  segment_start_at TEXT, segment_end_at TEXT, angler_count INTEGER, effort_minutes REAL,
  target_encountered INTEGER, target_encounter_count INTEGER, target_retained_count INTEGER,
  target_released_count INTEGER, identification_confidence TEXT, scoring_system_kind TEXT,
  scoring_system_version TEXT, scoring_system_sha256 TEXT, opportunity_score INTEGER,
  opportunity_window_id TEXT, snapshot_sha256 TEXT, terminal_reason TEXT,
  previous_event_sha256 TEXT, event_at TEXT, event_sha256 TEXT
);
CREATE TABLE validation_feasibility_corrections (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  correction_id TEXT, activation_id TEXT, trip_id TEXT REFERENCES trips(id) ON DELETE CASCADE,
  correction_contract_version TEXT,
  root_completion_event_sha256 TEXT, previous_event_sha256 TEXT, correction_reason TEXT,
  analytical_status TEXT, site_id TEXT, geographic_panel TEXT, mode TEXT,
  segment_start_at TEXT, segment_end_at TEXT, angler_count INTEGER, effort_minutes REAL,
  target_encountered INTEGER, target_encounter_count INTEGER, target_retained_count INTEGER,
  target_released_count INTEGER, identification_confidence TEXT, corrected_at TEXT,
  event_sha256 TEXT
);
CREATE TABLE validation_feasibility_recruitment_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE validation_feasibility_privacy_removals (
  activation_id TEXT,
  removed_started_attempt_count INTEGER,
  removed_completed_attempt_count INTEGER,
  removed_safe_canceled_attempt_count INTEGER
);
INSERT INTO validation_feasibility_activations (id) VALUES ('${ACTIVATION_ID}');
INSERT INTO users (id) VALUES ('${ACCOUNT_ID}');
INSERT INTO trips (id, user_id) VALUES ('${TRIP_ID}', '${ACCOUNT_ID}');
INSERT INTO site_discussion_posts (id, trip_id, summary)
VALUES ('discussion-deleted-before-restore', '${TRIP_ID}', 'private fixture summary');
INSERT INTO validation_feasibility_events (event_id, activation_id, trip_id, event_type)
VALUES ('event-restored-start', '${ACTIVATION_ID}', '${TRIP_ID}', 'started');
INSERT INTO validation_feasibility_events (event_id, activation_id, trip_id, event_type)
VALUES ('event-restored-complete', '${ACTIVATION_ID}', '${TRIP_ID}', 'completed');
INSERT INTO validation_feasibility_corrections (correction_id, activation_id, trip_id)
VALUES ('correction-restored', '${ACTIVATION_ID}', '${TRIP_ID}');
INSERT INTO validation_feasibility_recruitment_events (user_id) VALUES ('${ACCOUNT_ID}');
`;
}

function currentLedgerSql() {
  const requestedAt = "2026-07-17T08:00:00.000Z";
  const accountHash = sha256(`account:${ACCOUNT_ID}`);
  return `
PRAGMA foreign_keys = ON;
CREATE TABLE privacy_deletion_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  owner_subject_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  objects_total INTEGER NOT NULL,
  objects_deleted INTEGER NOT NULL,
  last_error_code TEXT,
  requested_at TEXT NOT NULL,
  active_data_removed_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE privacy_deletion_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES privacy_deletion_jobs(id) ON DELETE CASCADE,
  object_key TEXT,
  object_key_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  lease_token TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
INSERT INTO privacy_deletion_jobs (
  id, receipt_hash, scope, subject_hash, owner_subject_hash, state,
  objects_total, objects_deleted, last_error_code, requested_at,
  active_data_removed_at, completed_at, updated_at
) VALUES (
  'deletion-current-account', '${"a".repeat(64)}', 'account', '${accountHash}', '${accountHash}',
  'active_data_removed', 2, 1, NULL, '${requestedAt}', '${requestedAt}', NULL, '${requestedAt}'
);
INSERT INTO privacy_deletion_tasks (
  id, job_id, object_key, object_key_hash, state, attempts, available_at,
  lease_expires_at, lease_token, last_error_code, created_at, updated_at, completed_at
) VALUES (
  'task-current-pending', 'deletion-current-account', '${OBJECT_KEY}', '${sha256(OBJECT_KEY)}',
  'pending', 1, '${requestedAt}', NULL, NULL, NULL, '${requestedAt}', '${requestedAt}', NULL
);
INSERT INTO privacy_deletion_tasks (
  id, job_id, object_key, object_key_hash, state, attempts, available_at,
  lease_expires_at, lease_token, last_error_code, created_at, updated_at, completed_at
) VALUES (
  'task-current-completed', 'deletion-current-account', NULL, '${"b".repeat(64)}',
  'completed', 1, '${requestedAt}', NULL, NULL, NULL, '${requestedAt}', '${requestedAt}', '${requestedAt}'
);
`;
}

test("encrypted operational snapshots restore in isolation and replay current privacy controls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "castingcompass-storage-test-"));
  chmodSync(directory, 0o700);
  const workParent = join(directory, "work");
  mkdirSync(workParent, { mode: 0o700 });
  const keyPath = join(directory, "snapshot.key");
  const ledgerKeyPath = join(directory, "ledger.key");
  privateWrite(keyPath, randomBytes(32));
  privateWrite(ledgerKeyPath, randomBytes(32));
  const snapshotInput = join(directory, "snapshot.sql");
  const ledgerInput = join(directory, "current.sql");
  privateWrite(snapshotInput, snapshotSql());
  privateWrite(ledgerInput, currentLedgerSql());
  const snapshotArtifact = join(directory, "snapshot.ccv2");
  const snapshotManifest = join(directory, "snapshot.manifest.json");
  const ledgerArtifact = join(directory, "ledger.ccv2");
  const ledgerManifest = join(directory, "ledger.manifest.json");
  const auditPath = join(directory, "storage-audit.ndjson");
  const evidencePath = join(directory, "restore-evidence.json");

  assert.throws(() => sealOperationalSnapshot({
    inputPath: snapshotInput,
    artifactPath: snapshotArtifact,
    manifestPath: snapshotManifest,
    keyPath,
    keyId: "key-snapshot-test",
    activationId: ACTIVATION_ID,
    createdAt: "2026-07-17T09:00:00.000Z",
    auditPath,
    operatorRole: "data-steward",
    destroyPlaintext: false,
  }), /explicit plaintext destruction/);

  const sealedSnapshot = sealOperationalSnapshot({
    inputPath: snapshotInput,
    artifactPath: snapshotArtifact,
    manifestPath: snapshotManifest,
    keyPath,
    keyId: "key-snapshot-test",
    activationId: ACTIVATION_ID,
    createdAt: "2026-07-17T09:00:00.000Z",
    auditPath,
    operatorRole: "data-steward",
    destroyPlaintext: true,
  });
  const sealedLedger = sealPrivacyLedger({
    inputPath: ledgerInput,
    artifactPath: ledgerArtifact,
    manifestPath: ledgerManifest,
    keyPath: ledgerKeyPath,
    keyId: "key-ledger-test",
    activationId: ACTIVATION_ID,
    createdAt: "2026-07-17T09:01:00.000Z",
    auditPath,
    operatorRole: "privacy-reviewer",
    destroyPlaintext: true,
  });
  assert.equal(sealedSnapshot.manifest.retention_days, 89);
  assert.equal(sealedSnapshot.manifest.retention_until, "2026-10-14T09:00:00.000Z");
  assert.equal(sealedLedger.manifest.artifact_kind, "privacy-deletion-ledger");
  assert.equal(statSync(snapshotInput, { throwIfNoEntry: false }), undefined);
  assert.equal(statSync(ledgerInput, { throwIfNoEntry: false }), undefined);
  assert.equal(statSync(snapshotArtifact).mode & 0o077, 0);
  assert.equal(statSync(snapshotManifest).mode & 0o077, 0);

  const originalArtifact = readFileSync(snapshotArtifact);
  const tamperedArtifact = Buffer.from(originalArtifact);
  tamperedArtifact[tamperedArtifact.length - 1] ^= 1;
  writeFileSync(snapshotArtifact, tamperedArtifact);
  await assert.rejects(runOperationalRestoreDrill({
    activationId: ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath: keyPath,
    ledgerArtifactPath: ledgerArtifact,
    ledgerManifestPath: ledgerManifest,
    ledgerKeyPath,
    auditPath,
    workParent,
    evidencePath,
    completedAt: "2026-07-17T09:02:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  }), /checksum does not match/);
  writeFileSync(snapshotArtifact, originalArtifact);

  const wrongKeyPath = join(directory, "wrong.key");
  privateWrite(wrongKeyPath, randomBytes(32));
  await assert.rejects(runOperationalRestoreDrill({
    activationId: ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath: wrongKeyPath,
    ledgerArtifactPath: ledgerArtifact,
    ledgerManifestPath: ledgerManifest,
    ledgerKeyPath,
    auditPath,
    workParent,
    evidencePath,
    completedAt: "2026-07-17T09:02:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  }), /authentication failed/);

  const evidence = await runOperationalRestoreDrill({
    activationId: ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath: keyPath,
    ledgerArtifactPath: ledgerArtifact,
    ledgerManifestPath: ledgerManifest,
    ledgerKeyPath,
    auditPath,
    workParent,
    evidencePath,
    completedAt: "2026-07-17T09:02:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  });

  assert.equal(evidence.schema_version, RESTORE_EVIDENCE_VERSION);
  assert.equal(evidence.operational_restore_passed, true);
  assert.equal(evidence.validation_snapshot_and_restore_gate_passed, false);
  assert.equal(evidence.validation_snapshot_retention_days_required, 730);
  assert.match(evidence.validation_snapshot_gate_blocker, /suppression-policy-not-approved/);
  assert.ok(evidence.reconciliation_failed_gates.includes("snapshot_and_restore_success"));
  assert.equal(evidence.integrity_check, "ok");
  assert.equal(evidence.foreign_key_violation_count, 0);
  assert.equal(evidence.suppressed_account_count, 1);
  assert.equal(evidence.suppressed_trip_count, 1);
  assert.equal(evidence.suppressed_public_discussion_count, 1);
  assert.equal(evidence.suppressed_validation_event_count, 2);
  assert.equal(evidence.suppressed_validation_correction_count, 1);
  assert.equal(evidence.suppressed_validation_recruitment_count, 1);
  assert.equal(evidence.privacy_job_count, 1);
  assert.equal(evidence.privacy_task_count, 2);
  assert.equal(evidence.unresolved_object_task_count, 1);
  assert.equal(evidence.completed_object_task_count, 1);
  assert.equal(evidence.candidate_performance_computed, false);
  assert.equal(evidence.plaintext_artifacts_retained, false);
  assert.equal(evidence.restored_database_retained, false);
  assert.match(evidence.evidence_payload_sha256, /^[a-f0-9]{64}$/);
  assert.equal(readdirSync(workParent).length, 0);

  const serializedEvidence = readFileSync(evidencePath, "utf8");
  for (const prohibited of [ACCOUNT_ID, TRIP_ID, OBJECT_KEY, "private fixture summary"]) {
    assert.doesNotMatch(serializedEvidence, new RegExp(prohibited));
  }
  const audit = verifyStorageAuditLog(auditPath);
  assert.deepEqual(audit.map((event) => event.event_type), [
    "snapshot_sealed",
    "privacy_ledger_sealed",
    "restore_drill_completed",
  ]);
  assert.equal(audit[1].previous_event_sha256, audit[0].event_sha256);
  assert.equal(audit[2].previous_event_sha256, audit[1].event_sha256);

  const tamperedAuditPath = join(directory, "tampered-audit.ndjson");
  privateWrite(tamperedAuditPath, readFileSync(auditPath, "utf8").replace("data-steward", "site-operator"));
  assert.throws(() => verifyStorageAuditLog(tamperedAuditPath), /hash is invalid/);
});
