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
  VALIDATION_RESTORE_EVIDENCE_VERSION,
  sealPrivacyLedger,
  sealOperationalSnapshot,
  sealValidationLedgerSnapshot,
  sealValidationSuppressionLedger,
  runOperationalRestoreDrill,
  runValidationRestoreDrill,
  verifyStorageAuditLog,
} from "../scripts/validation-storage.mjs";
import {
  buildFeasibilityCompletionEvent,
  buildFeasibilityCorrectionEvent,
  buildFeasibilityStartEvent,
  resolveFeasibilityRecruitment,
} from "../worker/validation-feasibility.ts";

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
  previous_event_sha256 TEXT, event_at TEXT, event_sha256 TEXT,
  snapshot_suppression_sha256 TEXT
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

const VALIDATION_ACTIVATION_ID = "activation-validation-storage-test";
const VALIDATION_ACCOUNT_ID = "user-validation-storage-private";
const VALIDATION_TRIP_ID = "trip_33333333-3333-4333-8333-333333333333";

function storedStart(event) {
  return {
    activation_id: event.activationId,
    trip_id: event.tripId,
    event_sha256: event.eventSha256,
    source_record_sha256: event.sourceRecordSha256,
    participant_group_id: event.participantGroupId,
    recruitment_frame_id: event.recruitmentFrameId,
    recruitment_source_id: event.recruitmentSourceId,
    selection_method: event.selectionMethod,
    score_influenced_choice: Number(event.scoreInfluencedChoice),
    study_consent_version: event.studyConsentVersion,
    study_consented_at: event.studyConsentedAt,
    target_taxon_id: event.targetTaxonId,
    site_id: event.siteId,
    geographic_panel: event.geographicPanel,
    mode: event.mode,
    segment_start_at: event.segmentStartAt,
    angler_count: event.anglerCount,
    scoring_system_kind: event.scoringSystemKind,
    scoring_system_version: event.scoringSystemVersion,
    scoring_system_sha256: event.scoringSystemSha256,
    opportunity_score: event.opportunityScore,
    opportunity_window_id: event.opportunityWindowId,
    snapshot_sha256: event.snapshotSha256,
    snapshot_suppression_sha256: event.snapshotSuppressionSha256,
  };
}

function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function snakeCaseRow(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [
    key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`),
    value,
  ]));
}

function createFixtureTable(name, columns, { sequence = false } = {}) {
  const definitions = columns.map((column) => `\`${column}\``);
  if (sequence) definitions.unshift("`sequence` INTEGER PRIMARY KEY AUTOINCREMENT");
  return `CREATE TABLE \`${name}\` (${definitions.join(", ")});`;
}

function insertFixtureRow(table, row) {
  const columns = Object.keys(row);
  return `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(", ")}) VALUES (${columns
    .map((column) => sqlLiteral(row[column])).join(", ")});`;
}

function validationRemovalTableSql() {
  return [
    createFixtureTable("validation_feasibility_privacy_removals", [
      "activation_id", "removal_day", "removed_event_count", "removed_started_attempt_count",
      "removed_completed_attempt_count", "removed_safe_canceled_attempt_count",
      "first_removed_at", "last_removed_at",
    ]),
    createFixtureTable("validation_feasibility_recruitment_removals", [
      "activation_id", "removal_day", "removed_recruitment_count", "removed_organic_count",
      "removed_direct_count", "removed_community_count", "first_removed_at", "last_removed_at",
    ]),
    createFixtureTable("validation_feasibility_correction_removals", [
      "activation_id", "removal_day", "removed_correction_count", "first_removed_at", "last_removed_at",
    ]),
    createFixtureTable("validation_feasibility_snapshot_suppressions", [
      "suppression_id", "activation_id", "suppression_kind", "suppression_subject_sha256",
      "suppressed_event_type", "source_event_sha256", "removed_at",
    ], { sequence: true }),
  ].join("\n");
}

async function validationStorageFixture() {
  const scoringSha = "c".repeat(64);
  const activation = {
    id: VALIDATION_ACTIVATION_ID,
    protocol_id: "california-halibut-collection-feasibility-v2",
    protocol_version: "2.0.0",
    protocol_sha256: "8ff0d7bd009ed8eb10f328347d58d0b63d0b6c822b08351cc5c2760d41de13ed",
    activation_commitment_sha256: "e".repeat(64),
    activation_manifest_sha256: "d".repeat(64),
    site_catalog_sha256: "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860",
    scoring_system_kind: "heuristic-configuration",
    scoring_system_version: `heuristic-california-halibut-${scoringSha}`,
    scoring_system_sha256: scoringSha,
    worker_version_id: "worker-validation-storage-test",
    study_consent_version: "castingcompass.validation-feasibility-consent/2.0.0",
    start_at: "2026-07-10T00:00:00.000Z",
    end_at: "2026-10-08T00:00:00.000Z",
    preregistered_at: "2026-07-09T00:00:00.000Z",
    receipt_verified_at: "2026-07-09T01:00:00.000Z",
    status: "sealed-before-enrollment",
    created_at: "2026-07-09T01:00:00.000Z",
  };
  const participantGroupId = `participant-${"a".repeat(64)}`;
  const recruitment = await resolveFeasibilityRecruitment({
    env: {},
    activation,
    accountId: VALIDATION_ACCOUNT_ID,
    participantGroupId,
    timestamp: "2026-07-11T10:00:00.000Z",
    recruitmentToken: null,
    campaign: null,
    existing: null,
  });
  assert.ok(recruitment);
  const opportunity = {
    snapshotSha256: "b".repeat(64),
    siteCatalogSha256: activation.site_catalog_sha256,
    targetTaxonId: "california-halibut",
    taxonCatalogVersion: "castingcompass.taxa/1.0.0",
    observationContractVersion: "castingcompass.observation/2.0.0",
    modelRunContractVersion: "castingcompass.model-run/2.0.0",
    opportunityContractVersion: "castingcompass.opportunity/2.0.0",
    scoringSystemKind: activation.scoring_system_kind,
    scoringSystemVersion: activation.scoring_system_version,
    scoringSystemSha256: activation.scoring_system_sha256,
    generatedAt: "2026-07-11T09:00:00.000Z",
    windowId: "ocean-beach-north--20260711T1000Z",
    siteId: "ocean-beach-north",
    windowStart: "2026-07-11T10:00:00.000Z",
    windowEnd: "2026-07-11T12:00:00.000Z",
    opportunityScore: 80,
    habitatScore: 75,
    seasonalityScore: 75,
    conditionsScore: 70,
    fishabilityScore: 70,
  };
  const started = await buildFeasibilityStartEvent({
    context: { activation, participantGroupId },
    recruitment: recruitment.record,
    tripId: VALIDATION_TRIP_ID,
    opportunity,
    siteId: opportunity.siteId,
    mode: "beach",
    anglerCount: 1,
    scoreInfluencedChoice: false,
    timestamp: "2026-07-11T10:05:00.000Z",
  });
  assert.ok(started);
  const completed = await buildFeasibilityCompletionEvent({
    start: storedStart(started),
    timestamp: "2026-07-11T11:05:00.000Z",
    anglerCount: 1,
    targetEncounterCount: 0,
    targetRetainedCount: 0,
    targetReleasedCount: 0,
  });
  assert.ok(completed);
  const correction = await buildFeasibilityCorrectionEvent({
    start: storedStart(started),
    rootCompletionEventSha256: completed.eventSha256,
    previousEventSha256: completed.eventSha256,
    siteId: started.siteId,
    mode: started.mode,
    segmentStartAt: started.segmentStartAt,
    segmentEndAt: completed.segmentEndAt,
    anglerCount: 1,
    targetEncounterCount: 1,
    targetRetainedCount: 0,
    targetReleasedCount: 1,
    correctedAt: "2026-07-11T11:10:00.000Z",
  });
  assert.ok(correction);
  const recruitmentRow = snakeCaseRow(recruitment.record);
  const eventRows = [started, completed].map(snakeCaseRow);
  const correctionRow = snakeCaseRow(correction);
  const snapshotSql = [
    "PRAGMA foreign_keys = ON;",
    createFixtureTable("validation_feasibility_activations", Object.keys(activation)),
    createFixtureTable("validation_feasibility_recruitment_campaigns", [
      "activation_id", "campaign_id", "recruitment_source_id", "selection_method", "invite_issued_at",
      "invite_expires_at", "community_approval_sha256", "token_payload_sha256", "sealed_at",
    ], { sequence: true }),
    createFixtureTable("validation_feasibility_recruitment_events", Object.keys(recruitmentRow), { sequence: true }),
    createFixtureTable("validation_feasibility_events", Object.keys(eventRows[0]), { sequence: true }),
    createFixtureTable("validation_feasibility_corrections", Object.keys(correctionRow), { sequence: true }),
    validationRemovalTableSql(),
    insertFixtureRow("validation_feasibility_activations", activation),
    insertFixtureRow("validation_feasibility_recruitment_events", recruitmentRow),
    ...eventRows.map((row) => insertFixtureRow("validation_feasibility_events", row)),
    insertFixtureRow("validation_feasibility_corrections", correctionRow),
  ].join("\n");
  const removedAt = "2026-07-17T09:30:00.000Z";
  const suppressions = [
    {
      suppression_id: `fsuppress_${"1".repeat(32)}`,
      activation_id: VALIDATION_ACTIVATION_ID,
      suppression_kind: "participant",
      suppression_subject_sha256: recruitment.record.snapshotSuppressionSha256,
      suppressed_event_type: "participant",
      source_event_sha256: recruitment.record.eventSha256,
      removed_at: removedAt,
    },
    {
      suppression_id: `fsuppress_${"2".repeat(32)}`,
      activation_id: VALIDATION_ACTIVATION_ID,
      suppression_kind: "trip",
      suppression_subject_sha256: started.snapshotSuppressionSha256,
      suppressed_event_type: "started",
      source_event_sha256: started.eventSha256,
      removed_at: removedAt,
    },
    {
      suppression_id: `fsuppress_${"3".repeat(32)}`,
      activation_id: VALIDATION_ACTIVATION_ID,
      suppression_kind: "trip",
      suppression_subject_sha256: completed.snapshotSuppressionSha256,
      suppressed_event_type: "completed",
      source_event_sha256: completed.eventSha256,
      removed_at: removedAt,
    },
  ];
  const privacyRemoval = {
    activation_id: VALIDATION_ACTIVATION_ID,
    removal_day: "2026-07-17",
    removed_event_count: 2,
    removed_started_attempt_count: 1,
    removed_completed_attempt_count: 1,
    removed_safe_canceled_attempt_count: 0,
    first_removed_at: removedAt,
    last_removed_at: removedAt,
  };
  const recruitmentRemoval = {
    activation_id: VALIDATION_ACTIVATION_ID,
    removal_day: "2026-07-17",
    removed_recruitment_count: 1,
    removed_organic_count: 1,
    removed_direct_count: 0,
    removed_community_count: 0,
    first_removed_at: removedAt,
    last_removed_at: removedAt,
  };
  const correctionRemoval = {
    activation_id: VALIDATION_ACTIVATION_ID,
    removal_day: "2026-07-17",
    removed_correction_count: 1,
    first_removed_at: removedAt,
    last_removed_at: removedAt,
  };
  const suppressionSql = [
    "PRAGMA foreign_keys = ON;",
    validationRemovalTableSql(),
    ...suppressions.map((row) => insertFixtureRow("validation_feasibility_snapshot_suppressions", row)),
    insertFixtureRow("validation_feasibility_privacy_removals", privacyRemoval),
    insertFixtureRow("validation_feasibility_recruitment_removals", recruitmentRemoval),
    insertFixtureRow("validation_feasibility_correction_removals", correctionRemoval),
  ].join("\n");
  const mismatchedSuppressionSql = suppressionSql.replace(
    sqlLiteral(started.eventSha256),
    sqlLiteral("f".repeat(64)),
  );
  const futureSuppressionSql = suppressionSql.replaceAll(removedAt, "2026-07-17T10:06:00.000Z");
  const emptySuppressionSql = `PRAGMA foreign_keys = ON;\n${validationRemovalTableSql()}`;
  return {
    snapshotSql,
    suppressionSql,
    mismatchedSuppressionSql,
    futureSuppressionSql,
    emptySuppressionSql,
  };
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

test("validation-only snapshots retain 730 days and suppress later participant deletions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "castingcompass-validation-storage-test-"));
  chmodSync(directory, 0o700);
  const snapshotKeyPath = join(directory, "validation-snapshot.key");
  const suppressionKeyPath = join(directory, "validation-suppression.key");
  privateWrite(snapshotKeyPath, randomBytes(32));
  privateWrite(suppressionKeyPath, randomBytes(32));
  const fixture = await validationStorageFixture();
  const snapshotInput = join(directory, "validation-snapshot.sql");
  const suppressionInput = join(directory, "validation-suppression.sql");
  const staleSuppressionInput = join(directory, "validation-suppression-stale.sql");
  privateWrite(snapshotInput, fixture.snapshotSql);
  privateWrite(suppressionInput, fixture.suppressionSql);
  privateWrite(staleSuppressionInput, fixture.emptySuppressionSql);
  const snapshotArtifact = join(directory, "validation-snapshot.ccv2");
  const snapshotManifest = join(directory, "validation-snapshot.manifest.json");
  const suppressionArtifact = join(directory, "validation-suppression.ccv2");
  const suppressionManifest = join(directory, "validation-suppression.manifest.json");
  const staleSuppressionArtifact = join(directory, "validation-suppression-stale.ccv2");
  const staleSuppressionManifest = join(directory, "validation-suppression-stale.manifest.json");
  const auditPath = join(directory, "validation-storage-audit.ndjson");
  const evidencePath = join(directory, "validation-restore-evidence.json");

  sealValidationSuppressionLedger({
    inputPath: staleSuppressionInput,
    artifactPath: staleSuppressionArtifact,
    manifestPath: staleSuppressionManifest,
    keyPath: suppressionKeyPath,
    keyId: "key-validation-suppression-test",
    activationId: VALIDATION_ACTIVATION_ID,
    createdAt: "2026-07-17T08:59:00.000Z",
    auditPath,
    operatorRole: "privacy-reviewer",
    destroyPlaintext: true,
  });
  const sealedSnapshot = sealValidationLedgerSnapshot({
    inputPath: snapshotInput,
    artifactPath: snapshotArtifact,
    manifestPath: snapshotManifest,
    keyPath: snapshotKeyPath,
    keyId: "key-validation-snapshot-test",
    activationId: VALIDATION_ACTIVATION_ID,
    createdAt: "2026-07-17T09:00:00.000Z",
    auditPath,
    operatorRole: "data-steward",
    destroyPlaintext: true,
  });
  const sealedSuppression = sealValidationSuppressionLedger({
    inputPath: suppressionInput,
    artifactPath: suppressionArtifact,
    manifestPath: suppressionManifest,
    keyPath: suppressionKeyPath,
    keyId: "key-validation-suppression-test",
    activationId: VALIDATION_ACTIVATION_ID,
    createdAt: "2026-07-17T10:01:00.000Z",
    auditPath,
    operatorRole: "privacy-reviewer",
    destroyPlaintext: true,
  });
  assert.equal(sealedSnapshot.manifest.artifact_kind, "validation-ledger-snapshot");
  assert.equal(sealedSnapshot.manifest.retention_days, 730);
  assert.equal(sealedSnapshot.manifest.retention_until, "2028-07-16T09:00:00.000Z");
  assert.equal(sealedSuppression.manifest.artifact_kind, "validation-suppression-ledger");
  assert.equal(sealedSuppression.manifest.retention_days, 730);
  assert.doesNotMatch(readFileSync(snapshotArtifact, "utf8"), new RegExp(VALIDATION_ACCOUNT_ID));
  assert.equal(statSync(snapshotInput, { throwIfNoEntry: false }), undefined);
  assert.equal(statSync(suppressionInput, { throwIfNoEntry: false }), undefined);

  await assert.rejects(runValidationRestoreDrill({
    activationId: VALIDATION_ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath,
    suppressionArtifactPath: staleSuppressionArtifact,
    suppressionManifestPath: staleSuppressionManifest,
    suppressionKeyPath,
    auditPath,
    evidencePath: join(directory, "validation-stale-evidence.json"),
    completedAt: "2026-07-17T10:02:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  }), /predates its snapshot/);
  await assert.rejects(runValidationRestoreDrill({
    activationId: VALIDATION_ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath,
    suppressionArtifactPath: snapshotArtifact,
    suppressionManifestPath: snapshotManifest,
    suppressionKeyPath: snapshotKeyPath,
    auditPath,
    evidencePath: join(directory, "validation-class-evidence.json"),
    completedAt: "2026-07-17T10:02:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  }), /contract is unsupported/);

  await assert.rejects(runValidationRestoreDrill({
    activationId: VALIDATION_ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath,
    suppressionArtifactPath: suppressionArtifact,
    suppressionManifestPath: suppressionManifest,
    suppressionKeyPath,
    auditPath,
    evidencePath,
    completedAt: "2026-07-17T10:02:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: false,
  }), /requires destruction/);

  const evidence = await runValidationRestoreDrill({
    activationId: VALIDATION_ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath,
    suppressionArtifactPath: suppressionArtifact,
    suppressionManifestPath: suppressionManifest,
    suppressionKeyPath,
    auditPath,
    evidencePath,
    completedAt: "2026-07-17T10:02:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  });
  assert.equal(evidence.schema_version, VALIDATION_RESTORE_EVIDENCE_VERSION);
  assert.equal(evidence.technical_validation_snapshot_restore_passed, true);
  assert.equal(evidence.governance_approval_recorded, false);
  assert.equal(evidence.validation_snapshot_and_restore_gate_passed, false);
  assert.match(evidence.validation_snapshot_gate_blocker, /governance-not-approved/);
  assert.equal(evidence.reconciliation_snapshot_restore_gate_passed, true);
  assert.equal(evidence.snapshot_retention_days, 730);
  assert.equal(evidence.suppression_ledger_retention_days, 730);
  assert.equal(evidence.snapshot_capture_after_activation_end, false);
  assert.equal(evidence.retained_recruitment_count, 0);
  assert.equal(evidence.retained_event_count, 0);
  assert.equal(evidence.retained_correction_count, 0);
  assert.equal(evidence.suppressed_snapshot_recruitment_count, 1);
  assert.equal(evidence.suppressed_snapshot_event_count, 2);
  assert.equal(evidence.suppressed_snapshot_started_attempt_count, 1);
  assert.equal(evidence.suppressed_snapshot_completed_attempt_count, 1);
  assert.equal(evidence.suppressed_snapshot_correction_count, 1);
  assert.equal(evidence.aggregate_removed_event_count, 2);
  assert.equal(evidence.aggregate_removed_recruitment_count, 1);
  assert.equal(evidence.aggregate_removed_correction_count, 1);
  assert.equal(evidence.candidate_performance_computed, false);
  assert.equal(evidence.private_raw_rows_published, false);
  assert.equal(evidence.plaintext_artifacts_retained, false);
  assert.equal(evidence.restored_projection_retained, false);
  const serializedEvidence = readFileSync(evidencePath, "utf8");
  for (const prohibited of [VALIDATION_ACCOUNT_ID, VALIDATION_TRIP_ID, "participant-"]) {
    assert.doesNotMatch(serializedEvidence, new RegExp(prohibited));
  }
  assert.deepEqual(verifyStorageAuditLog(auditPath).map((event) => event.event_type), [
    "validation_suppression_sealed",
    "validation_snapshot_sealed",
    "validation_suppression_sealed",
    "validation_restore_drill_completed",
  ]);

  const mismatchedInput = join(directory, "validation-suppression-mismatched.sql");
  const mismatchedArtifact = join(directory, "validation-suppression-mismatched.ccv2");
  const mismatchedManifest = join(directory, "validation-suppression-mismatched.manifest.json");
  const mismatchedEvidence = join(directory, "validation-mismatched-evidence.json");
  privateWrite(mismatchedInput, fixture.mismatchedSuppressionSql);
  sealValidationSuppressionLedger({
    inputPath: mismatchedInput,
    artifactPath: mismatchedArtifact,
    manifestPath: mismatchedManifest,
    keyPath: suppressionKeyPath,
    keyId: "key-validation-suppression-test",
    activationId: VALIDATION_ACTIVATION_ID,
    createdAt: "2026-07-17T10:03:00.000Z",
    auditPath,
    operatorRole: "privacy-reviewer",
    destroyPlaintext: true,
  });
  await assert.rejects(runValidationRestoreDrill({
    activationId: VALIDATION_ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath,
    suppressionArtifactPath: mismatchedArtifact,
    suppressionManifestPath: mismatchedManifest,
    suppressionKeyPath,
    auditPath,
    evidencePath: mismatchedEvidence,
    completedAt: "2026-07-17T10:04:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  }), /identity does not match/);
  assert.equal(statSync(mismatchedEvidence, { throwIfNoEntry: false }), undefined);

  const futureInput = join(directory, "validation-suppression-future.sql");
  const futureArtifact = join(directory, "validation-suppression-future.ccv2");
  const futureManifest = join(directory, "validation-suppression-future.manifest.json");
  privateWrite(futureInput, fixture.futureSuppressionSql);
  sealValidationSuppressionLedger({
    inputPath: futureInput,
    artifactPath: futureArtifact,
    manifestPath: futureManifest,
    keyPath: suppressionKeyPath,
    keyId: "key-validation-suppression-test",
    activationId: VALIDATION_ACTIVATION_ID,
    createdAt: "2026-07-17T10:05:00.000Z",
    auditPath,
    operatorRole: "privacy-reviewer",
    destroyPlaintext: true,
  });
  await assert.rejects(runValidationRestoreDrill({
    activationId: VALIDATION_ACTIVATION_ID,
    snapshotArtifactPath: snapshotArtifact,
    snapshotManifestPath: snapshotManifest,
    snapshotKeyPath,
    suppressionArtifactPath: futureArtifact,
    suppressionManifestPath: futureManifest,
    suppressionKeyPath,
    auditPath,
    evidencePath: join(directory, "validation-future-evidence.json"),
    completedAt: "2026-07-17T10:07:00.000Z",
    operatorRole: "data-steward",
    destroyRestored: true,
  }), /future removal/);
});
