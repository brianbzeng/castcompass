#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { buildFeasibilityReconciliationExport } from "../worker/validation-feasibility-export.ts";
import {
  FEASIBILITY_CORRECTION_CONTRACT_VERSION,
  FEASIBILITY_EVENT_CONTRACT_VERSION,
  FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION,
  reconcileFeasibilityEvents,
  verifyFeasibilityCorrectionHash,
  verifyFeasibilityEventHash,
  verifyFeasibilityRecruitmentHash,
} from "../worker/validation-feasibility.ts";

export const STORAGE_ARTIFACT_VERSION = "castingcompass.operational-storage-artifact/1.0.0";
export const STORAGE_MANIFEST_VERSION = "castingcompass.operational-storage-manifest/1.0.0";
export const PRIVACY_LEDGER_VERSION = "castingcompass.operational-privacy-ledger/1.0.0";
export const STORAGE_AUDIT_VERSION = "castingcompass.operational-storage-audit/1.0.0";
export const RESTORE_EVIDENCE_VERSION = "castingcompass.operational-restore-evidence/1.0.0";
export const VALIDATION_SNAPSHOT_VERSION = "castingcompass.validation-ledger-snapshot/2.0.0";
export const VALIDATION_SUPPRESSION_LEDGER_VERSION =
  "castingcompass.validation-suppression-ledger/2.0.0";
export const VALIDATION_RESTORE_EVIDENCE_VERSION =
  "castingcompass.validation-ledger-restore-evidence/2.0.0";

const MAGIC = Buffer.from("CCV2BK1\n", "ascii");
const AUTH_TAG_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_PLAINTEXT_BYTES = 512 * 1024 * 1024;
const OPERATIONAL_RETENTION_DAYS = 89;
const VALIDATION_RETENTION_DAYS = 730;
const DAY_MILLISECONDS = 86_400_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SUPPRESSION_ID_PATTERN = /^fsuppress_[a-f0-9]{32}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{2,50}$/u;
const ARTIFACT_RETENTION_DAYS = new Map([
  ["d1-sql-export", OPERATIONAL_RETENTION_DAYS],
  ["privacy-deletion-ledger", OPERATIONAL_RETENTION_DAYS],
  ["validation-ledger-snapshot", VALIDATION_RETENTION_DAYS],
  ["validation-suppression-ledger", VALIDATION_RETENTION_DAYS],
]);
const RECONCILIATION_INTEGRITY_GATES = new Set([
  "invalid_event_hash",
  "duplicate_start_event",
  "duplicate_terminal_event",
  "orphan_terminal_event",
  "terminal_identity_mismatch",
  "invalid_correction_hash",
  "invalid_correction_chain",
  "privacy_removal_ledger_invalid",
]);

const JOB_COLUMNS = [
  "id", "receipt_hash", "scope", "subject_hash", "owner_subject_hash", "state",
  "objects_total", "objects_deleted", "last_error_code", "requested_at",
  "active_data_removed_at", "completed_at", "updated_at",
];
const TASK_COLUMNS = [
  "id", "job_id", "object_key", "object_key_hash", "state", "attempts",
  "available_at", "lease_expires_at", "lease_token", "last_error_code",
  "created_at", "updated_at", "completed_at",
];
const VALIDATION_ACTIVATION_COLUMNS = [
  "id", "protocol_id", "protocol_version", "protocol_sha256", "activation_commitment_sha256",
  "activation_manifest_sha256", "site_catalog_sha256", "scoring_system_kind",
  "scoring_system_version", "scoring_system_sha256", "worker_version_id",
  "study_consent_version", "start_at", "end_at", "preregistered_at", "receipt_verified_at",
  "status", "created_at",
];
const VALIDATION_CAMPAIGN_COLUMNS = [
  "activation_id", "campaign_id", "recruitment_source_id", "selection_method",
  "invite_issued_at", "invite_expires_at", "community_approval_sha256",
  "token_payload_sha256", "sealed_at",
];
const VALIDATION_RECRUITMENT_COLUMNS = [
  "event_id", "activation_id", "participant_group_id", "event_contract_version",
  "recruitment_frame_id", "recruitment_source_id", "selection_method", "recruited_at",
  "campaign_id", "invite_issued_at", "invite_expires_at", "community_approval_sha256",
  "event_sha256", "created_at", "snapshot_suppression_sha256",
];
const VALIDATION_EVENT_COLUMNS = [
  "event_id", "activation_id", "trip_id", "event_type", "event_contract_version",
  "source_record_sha256", "participant_group_id", "recruitment_frame_id",
  "recruitment_source_id", "selection_method", "score_influenced_choice",
  "study_consent_version", "study_consented_at", "target_taxon_id", "site_id",
  "geographic_panel", "mode", "segment_start_at", "segment_end_at", "angler_count",
  "effort_minutes", "target_encountered", "target_encounter_count", "target_retained_count",
  "target_released_count", "identification_confidence", "scoring_system_kind",
  "scoring_system_version", "scoring_system_sha256", "opportunity_score",
  "opportunity_window_id", "snapshot_sha256", "terminal_reason", "previous_event_sha256",
  "event_at", "event_sha256", "snapshot_suppression_sha256",
];
const VALIDATION_CORRECTION_COLUMNS = [
  "correction_id", "activation_id", "trip_id", "correction_contract_version",
  "root_completion_event_sha256", "previous_event_sha256", "correction_reason",
  "analytical_status", "site_id", "geographic_panel", "mode", "segment_start_at",
  "segment_end_at", "angler_count", "effort_minutes", "target_encountered",
  "target_encounter_count", "target_retained_count", "target_released_count",
  "identification_confidence", "corrected_at", "event_sha256",
];
const VALIDATION_PRIVACY_REMOVAL_COLUMNS = [
  "activation_id", "removal_day", "removed_event_count", "removed_started_attempt_count",
  "removed_completed_attempt_count", "removed_safe_canceled_attempt_count",
  "first_removed_at", "last_removed_at",
];
const VALIDATION_RECRUITMENT_REMOVAL_COLUMNS = [
  "activation_id", "removal_day", "removed_recruitment_count", "removed_organic_count",
  "removed_direct_count", "removed_community_count", "first_removed_at", "last_removed_at",
];
const VALIDATION_CORRECTION_REMOVAL_COLUMNS = [
  "activation_id", "removal_day", "removed_correction_count", "first_removed_at", "last_removed_at",
];
const VALIDATION_SUPPRESSION_COLUMNS = [
  "suppression_id", "activation_id", "suppression_kind", "suppression_subject_sha256",
  "suppressed_event_type", "source_event_sha256", "removed_at",
];
const VALIDATION_FORBIDDEN_SNAPSHOT_KEYS = new Set([
  "user_id",
  "email",
  "password_hash",
  "password_salt",
  "object_key",
  "receipt_hash",
  "notes",
  "photo_key",
  "ip",
  "ip_address",
  "user_agent",
  "latitude",
  "longitude",
  "coordinates",
]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Canonical JSON contains an unsupported value");
  const object = value;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function strictTimestamp(value, name) {
  if (typeof value !== "string") throw new Error(`${name} must be a UTC timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be a millisecond-aligned UTC timestamp`);
  }
  return value;
}

function strictIdentifier(value, name, pattern = ID_PATTERN) {
  if (typeof value !== "string" || value.length < 3 || value.length > 200 || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unexpected fields`);
  }
  return value;
}

function assertPrivateFile(path, name, { maximumBytes = MAX_PLAINTEXT_BYTES } = {}) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${name} must be a regular file`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${name} must not be accessible by group or others`);
  if (metadata.size <= 0 || metadata.size > maximumBytes) throw new Error(`${name} has an invalid size`);
  return metadata;
}

function assertPrivateDirectory(path, name) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${name} must be a real directory`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${name} must not be accessible by group or others`);
}

function assertOutputAvailable(path, name) {
  assertPrivateDirectory(dirname(resolve(path)), `${name} parent directory`);
  if (existsSync(path)) throw new Error(`${name} already exists`);
}

function atomicWrite(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const descriptor = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function readKey(path) {
  assertPrivateFile(path, "Encryption key", { maximumBytes: KEY_BYTES });
  const key = readFileSync(path);
  if (key.byteLength !== KEY_BYTES) throw new Error("Encryption key must contain exactly 32 random bytes");
  return key;
}

function retentionUntil(createdAt, retentionDays) {
  return new Date(
    new Date(createdAt).getTime() + (retentionDays * DAY_MILLISECONDS),
  ).toISOString();
}

function encryptPayload({ plaintext, artifactKind, activationId, key, keyId, createdAt }) {
  if (!Buffer.isBuffer(plaintext) || plaintext.byteLength === 0 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("Snapshot plaintext has an invalid size");
  }
  const retentionDays = ARTIFACT_RETENTION_DAYS.get(artifactKind);
  if (!retentionDays) throw new Error("Snapshot artifact kind is invalid");
  strictIdentifier(activationId, "Activation ID");
  strictIdentifier(keyId, "Key ID");
  strictTimestamp(createdAt, "Snapshot creation time");
  const nonce = randomBytes(NONCE_BYTES);
  const header = {
    schema_version: STORAGE_ARTIFACT_VERSION,
    artifact_kind: artifactKind,
    activation_id: activationId,
    algorithm: "aes-256-gcm",
    key_id: keyId,
    created_at: createdAt,
    retention_days: retentionDays,
    retention_until: retentionUntil(createdAt, retentionDays),
    nonce_base64url: nonce.toString("base64url"),
    plaintext_bytes: plaintext.byteLength,
  };
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.byteLength);
  const aad = Buffer.concat([MAGIC, length, headerBytes]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const artifact = Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
  return { artifact, header };
}

function manifestFor(path, artifact, header) {
  return {
    schema_version: STORAGE_MANIFEST_VERSION,
    artifact_kind: header.artifact_kind,
    activation_id: header.activation_id,
    artifact_filename: basename(path),
    algorithm: header.algorithm,
    key_id: header.key_id,
    created_at: header.created_at,
    retention_days: header.retention_days,
    retention_until: header.retention_until,
    encrypted_bytes: artifact.byteLength,
    encrypted_sha256: sha256(artifact),
  };
}

function parseManifest(path) {
  assertPrivateFile(path, "Storage manifest", { maximumBytes: 64 * 1024 });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Storage manifest is not valid JSON");
  }
  const manifest = exactKeys(parsed, [
    "schema_version", "artifact_kind", "activation_id", "artifact_filename", "algorithm",
    "key_id", "created_at", "retention_days", "retention_until", "encrypted_bytes", "encrypted_sha256",
  ], "Storage manifest");
  const expectedRetentionDays = ARTIFACT_RETENTION_DAYS.get(manifest.artifact_kind);
  if (manifest.schema_version !== STORAGE_MANIFEST_VERSION || !expectedRetentionDays) {
    throw new Error("Storage manifest contract is unsupported");
  }
  strictIdentifier(manifest.activation_id, "Manifest activation ID");
  strictIdentifier(manifest.key_id, "Manifest key ID");
  strictTimestamp(manifest.created_at, "Manifest creation time");
  strictTimestamp(manifest.retention_until, "Manifest retention time");
  if (manifest.retention_days !== expectedRetentionDays ||
      manifest.retention_until !== retentionUntil(manifest.created_at, expectedRetentionDays)) {
    throw new Error("Storage manifest retention does not match its artifact class");
  }
  if (manifest.algorithm !== "aes-256-gcm") throw new Error("Storage manifest algorithm is unsupported");
  if (!Number.isInteger(manifest.encrypted_bytes) || manifest.encrypted_bytes <= 0) {
    throw new Error("Storage manifest byte count is invalid");
  }
  if (!SHA256_PATTERN.test(manifest.encrypted_sha256)) throw new Error("Storage manifest checksum is invalid");
  return manifest;
}

function decryptArtifact({ artifactPath, manifestPath, keyPath, expectedKind, expectedActivationId }) {
  const manifest = parseManifest(manifestPath);
  assertPrivateFile(artifactPath, "Encrypted storage artifact");
  if (basename(artifactPath) !== manifest.artifact_filename) throw new Error("Artifact filename does not match manifest");
  const artifact = readFileSync(artifactPath);
  if (artifact.byteLength !== manifest.encrypted_bytes || sha256(artifact) !== manifest.encrypted_sha256) {
    throw new Error("Encrypted artifact checksum does not match manifest");
  }
  if (!artifact.subarray(0, MAGIC.byteLength).equals(MAGIC)) throw new Error("Encrypted artifact magic is invalid");
  const headerLength = artifact.readUInt32BE(MAGIC.byteLength);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) throw new Error("Encrypted artifact header is invalid");
  const headerEnd = MAGIC.byteLength + 4 + headerLength;
  if (artifact.byteLength <= headerEnd + AUTH_TAG_BYTES) throw new Error("Encrypted artifact is truncated");
  let parsedHeader;
  try {
    parsedHeader = JSON.parse(artifact.subarray(MAGIC.byteLength + 4, headerEnd).toString("utf8"));
  } catch {
    throw new Error("Encrypted artifact header is not valid JSON");
  }
  const header = exactKeys(parsedHeader, [
    "schema_version", "artifact_kind", "activation_id", "algorithm", "key_id", "created_at",
    "retention_days", "retention_until", "nonce_base64url", "plaintext_bytes",
  ], "Encrypted artifact header");
  for (const field of [
    "artifact_kind", "activation_id", "algorithm", "key_id", "created_at",
    "retention_days", "retention_until",
  ]) {
    if (header[field] !== manifest[field]) throw new Error(`Encrypted artifact ${field} does not match manifest`);
  }
  if (header.schema_version !== STORAGE_ARTIFACT_VERSION || header.artifact_kind !== expectedKind) {
    throw new Error("Encrypted artifact contract is unsupported");
  }
  if (header.activation_id !== expectedActivationId) throw new Error("Encrypted artifact activation does not match drill");
  if (!Number.isInteger(header.plaintext_bytes) || header.plaintext_bytes <= 0 || header.plaintext_bytes > MAX_PLAINTEXT_BYTES) {
    throw new Error("Encrypted artifact plaintext size is invalid");
  }
  const nonce = Buffer.from(header.nonce_base64url, "base64url");
  if (nonce.byteLength !== NONCE_BYTES || nonce.toString("base64url") !== header.nonce_base64url) {
    throw new Error("Encrypted artifact nonce is invalid");
  }
  const key = readKey(keyPath);
  const ciphertextEnd = artifact.byteLength - AUTH_TAG_BYTES;
  const aad = artifact.subarray(0, headerEnd);
  const ciphertext = artifact.subarray(headerEnd, ciphertextEnd);
  const tag = artifact.subarray(ciphertextEnd);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: header.plaintext_bytes });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength !== header.plaintext_bytes) throw new Error("size mismatch");
    return { plaintext, manifest };
  } catch {
    throw new Error("Encrypted artifact authentication failed");
  } finally {
    key.fill(0);
  }
}

function auditPayload(event) {
  const payload = { ...event };
  delete payload.event_sha256;
  return payload;
}

function verifyAuditEvent(event, expectedSequence, expectedPrevious, expectedNotBefore) {
  exactKeys(event, [
    "schema_version", "sequence", "event_id", "activation_id", "event_type", "artifact_sha256",
    "previous_event_sha256", "event_at", "operator_role", "event_sha256",
  ], "Storage audit event");
  if (event.schema_version !== STORAGE_AUDIT_VERSION || event.sequence !== expectedSequence) {
    throw new Error("Storage audit sequence is invalid");
  }
  strictIdentifier(event.event_id, "Storage audit event ID");
  strictIdentifier(event.activation_id, "Storage audit activation ID");
  strictIdentifier(event.operator_role, "Storage audit operator role", ROLE_PATTERN);
  strictTimestamp(event.event_at, "Storage audit time");
  if (expectedNotBefore && event.event_at < expectedNotBefore) throw new Error("Storage audit chronology is invalid");
  if (![
    "snapshot_sealed",
    "privacy_ledger_sealed",
    "restore_drill_completed",
    "validation_snapshot_sealed",
    "validation_suppression_sealed",
    "validation_restore_drill_completed",
  ].includes(event.event_type)) {
    throw new Error("Storage audit event type is invalid");
  }
  if (!SHA256_PATTERN.test(event.artifact_sha256) || !SHA256_PATTERN.test(event.event_sha256)) {
    throw new Error("Storage audit checksum is invalid");
  }
  if (event.previous_event_sha256 !== expectedPrevious) throw new Error("Storage audit chain is invalid");
  if (sha256(canonicalJson(auditPayload(event))) !== event.event_sha256) {
    throw new Error("Storage audit event hash is invalid");
  }
}

export function verifyStorageAuditLog(path) {
  if (!existsSync(path)) return [];
  assertPrivateFile(path, "Storage audit log", { maximumBytes: 16 * 1024 * 1024 });
  const contents = readFileSync(path, "utf8");
  if (!contents.endsWith("\n")) throw new Error("Storage audit log is truncated");
  const events = contents.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error("Storage audit log contains invalid JSON");
    }
  });
  let previous = null;
  let previousAt = null;
  for (let index = 0; index < events.length; index += 1) {
    verifyAuditEvent(events[index], index + 1, previous, previousAt);
    previous = events[index].event_sha256;
    previousAt = events[index].event_at;
  }
  return events;
}

function appendAuditEvent({ auditPath, activationId, eventType, artifactSha256, eventAt, operatorRole }) {
  assertPrivateDirectory(dirname(resolve(auditPath)), "Storage audit parent directory");
  strictIdentifier(activationId, "Storage audit activation ID");
  strictIdentifier(operatorRole, "Storage audit operator role", ROLE_PATTERN);
  strictTimestamp(eventAt, "Storage audit time");
  if (!SHA256_PATTERN.test(artifactSha256)) throw new Error("Storage audit artifact checksum is invalid");
  const lockPath = `${auditPath}.lock`;
  const lock = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  closeSync(lock);
  try {
    const events = verifyStorageAuditLog(auditPath);
    if (events.at(-1)?.event_at && eventAt < events.at(-1).event_at) {
      throw new Error("Storage audit event cannot predate the current audit head");
    }
    const previous = events.at(-1)?.event_sha256 ?? null;
    const unsigned = {
      schema_version: STORAGE_AUDIT_VERSION,
      sequence: events.length + 1,
      event_id: `storage-${eventType}-${randomBytes(12).toString("hex")}`,
      activation_id: activationId,
      event_type: eventType,
      artifact_sha256: artifactSha256,
      previous_event_sha256: previous,
      event_at: eventAt,
      operator_role: operatorRole,
    };
    const event = { ...unsigned, event_sha256: sha256(canonicalJson(unsigned)) };
    const descriptor = openSync(auditPath, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, `${canonicalJson(event)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return event;
  } finally {
    unlinkSync(lockPath);
  }
}

function writeSealedArtifact({ payload, artifactKind, activationId, keyPath, keyId, createdAt, artifactPath, manifestPath }) {
  assertOutputAvailable(artifactPath, "Encrypted artifact");
  assertOutputAvailable(manifestPath, "Storage manifest");
  if (resolve(artifactPath) === resolve(manifestPath)) throw new Error("Artifact and manifest paths must differ");
  const key = readKey(keyPath);
  try {
    const { artifact, header } = encryptPayload({
      plaintext: payload,
      artifactKind,
      activationId,
      key,
      keyId,
      createdAt,
    });
    const manifest = manifestFor(artifactPath, artifact, header);
    atomicWrite(artifactPath, artifact);
    atomicWrite(manifestPath, `${canonicalJson(manifest)}\n`);
    return manifest;
  } finally {
    key.fill(0);
  }
}

export function sealOperationalSnapshot(input) {
  if (input.destroyPlaintext !== true) throw new Error("Snapshot sealing requires explicit plaintext destruction");
  assertPrivateFile(input.inputPath, "D1 SQL export");
  const plaintext = readFileSync(input.inputPath);
  const manifest = writeSealedArtifact({
    payload: plaintext,
    artifactKind: "d1-sql-export",
    activationId: input.activationId,
    keyPath: input.keyPath,
    keyId: input.keyId,
    createdAt: input.createdAt,
    artifactPath: input.artifactPath,
    manifestPath: input.manifestPath,
  });
  const auditEvent = appendAuditEvent({
    auditPath: input.auditPath,
    activationId: input.activationId,
    eventType: "snapshot_sealed",
    artifactSha256: manifest.encrypted_sha256,
    eventAt: input.createdAt,
    operatorRole: input.operatorRole,
  });
  unlinkSync(input.inputPath);
  plaintext.fill(0);
  return { manifest, auditEvent };
}

function executeSqlExport(sqlBytes, databasePath = ":memory:") {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(sqlBytes.toString("utf8"));
    database.exec("PRAGMA foreign_keys = ON;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function extractPrivacyLedger(database, activationId, capturedAt) {
  if (!tableExists(database, "privacy_deletion_jobs") || !tableExists(database, "privacy_deletion_tasks")) {
    throw new Error("D1 export lacks the privacy deletion ledger");
  }
  const jobs = database.prepare(`SELECT ${JOB_COLUMNS.join(", ")} FROM privacy_deletion_jobs ORDER BY id`).all();
  const tasks = database.prepare(`SELECT ${TASK_COLUMNS.join(", ")} FROM privacy_deletion_tasks ORDER BY id`).all();
  const jobIds = new Set(jobs.map((job) => job.id));
  if (tasks.some((task) => !jobIds.has(task.job_id))) throw new Error("Privacy deletion ledger contains orphan tasks");
  return {
    schema_version: PRIVACY_LEDGER_VERSION,
    activation_id: activationId,
    captured_at: capturedAt,
    jobs,
    tasks,
  };
}

export function sealPrivacyLedger(input) {
  if (input.destroyPlaintext !== true) throw new Error("Ledger sealing requires explicit plaintext destruction");
  assertPrivateFile(input.inputPath, "Current D1 SQL export");
  const sqlBytes = readFileSync(input.inputPath);
  const database = executeSqlExport(sqlBytes);
  let ledger;
  try {
    ledger = extractPrivacyLedger(database, input.activationId, input.createdAt);
  } finally {
    database.close();
    sqlBytes.fill(0);
  }
  const payload = Buffer.from(canonicalJson(ledger), "utf8");
  const manifest = writeSealedArtifact({
    payload,
    artifactKind: "privacy-deletion-ledger",
    activationId: input.activationId,
    keyPath: input.keyPath,
    keyId: input.keyId,
    createdAt: input.createdAt,
    artifactPath: input.artifactPath,
    manifestPath: input.manifestPath,
  });
  const auditEvent = appendAuditEvent({
    auditPath: input.auditPath,
    activationId: input.activationId,
    eventType: "privacy_ledger_sealed",
    artifactSha256: manifest.encrypted_sha256,
    eventAt: input.createdAt,
    operatorRole: input.operatorRole,
  });
  unlinkSync(input.inputPath);
  payload.fill(0);
  return { manifest, auditEvent };
}

function validationRows(database, table, columns, activationId, orderBy) {
  if (!tableExists(database, table)) throw new Error(`D1 export lacks required validation table ${table}`);
  return database.prepare(
    `SELECT ${columns.join(", ")} FROM ${table} WHERE activation_id = ? ORDER BY ${orderBy}`,
  ).all(activationId);
}

function assertValidationSnapshotMinimized(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertValidationSnapshotMinimized(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (VALIDATION_FORBIDDEN_SNAPSHOT_KEYS.has(key)) {
      throw new Error(`Validation snapshot contains prohibited field ${key}`);
    }
    assertValidationSnapshotMinimized(child);
  }
}

function extractValidationSnapshot(database, activationId, capturedAt) {
  for (const table of [
    "validation_feasibility_activations",
    "validation_feasibility_recruitment_campaigns",
    "validation_feasibility_recruitment_events",
    "validation_feasibility_events",
    "validation_feasibility_corrections",
    "validation_feasibility_privacy_removals",
    "validation_feasibility_recruitment_removals",
    "validation_feasibility_correction_removals",
    "validation_feasibility_snapshot_suppressions",
  ]) {
    if (!tableExists(database, table)) throw new Error(`D1 export lacks required validation table ${table}`);
  }
  const activation = database.prepare(
    `SELECT ${VALIDATION_ACTIVATION_COLUMNS.join(", ")}
      FROM validation_feasibility_activations WHERE id = ? LIMIT 1`,
  ).get(activationId);
  if (!activation) throw new Error("D1 export lacks the requested validation activation");
  const snapshot = {
    schema_version: VALIDATION_SNAPSHOT_VERSION,
    activation_id: activationId,
    captured_at: capturedAt,
    activation,
    campaigns: validationRows(
      database,
      "validation_feasibility_recruitment_campaigns",
      VALIDATION_CAMPAIGN_COLUMNS,
      activationId,
      "campaign_id",
    ),
    recruitment_events: validationRows(
      database,
      "validation_feasibility_recruitment_events",
      VALIDATION_RECRUITMENT_COLUMNS,
      activationId,
      "sequence",
    ),
    events: validationRows(
      database,
      "validation_feasibility_events",
      VALIDATION_EVENT_COLUMNS,
      activationId,
      "sequence",
    ),
    corrections: validationRows(
      database,
      "validation_feasibility_corrections",
      VALIDATION_CORRECTION_COLUMNS,
      activationId,
      "sequence",
    ),
    privacy_removals: validationRows(
      database,
      "validation_feasibility_privacy_removals",
      VALIDATION_PRIVACY_REMOVAL_COLUMNS,
      activationId,
      "removal_day",
    ),
    recruitment_removals: validationRows(
      database,
      "validation_feasibility_recruitment_removals",
      VALIDATION_RECRUITMENT_REMOVAL_COLUMNS,
      activationId,
      "removal_day",
    ),
    correction_removals: validationRows(
      database,
      "validation_feasibility_correction_removals",
      VALIDATION_CORRECTION_REMOVAL_COLUMNS,
      activationId,
      "removal_day",
    ),
    suppressions: validationRows(
      database,
      "validation_feasibility_snapshot_suppressions",
      VALIDATION_SUPPRESSION_COLUMNS,
      activationId,
      "sequence",
    ),
  };
  assertValidationSnapshotMinimized(snapshot);
  return snapshot;
}

function extractValidationSuppressionLedger(database, activationId, capturedAt) {
  const ledger = {
    schema_version: VALIDATION_SUPPRESSION_LEDGER_VERSION,
    activation_id: activationId,
    captured_at: capturedAt,
    suppressions: validationRows(
      database,
      "validation_feasibility_snapshot_suppressions",
      VALIDATION_SUPPRESSION_COLUMNS,
      activationId,
      "sequence",
    ),
    privacy_removals: validationRows(
      database,
      "validation_feasibility_privacy_removals",
      VALIDATION_PRIVACY_REMOVAL_COLUMNS,
      activationId,
      "removal_day",
    ),
    recruitment_removals: validationRows(
      database,
      "validation_feasibility_recruitment_removals",
      VALIDATION_RECRUITMENT_REMOVAL_COLUMNS,
      activationId,
      "removal_day",
    ),
    correction_removals: validationRows(
      database,
      "validation_feasibility_correction_removals",
      VALIDATION_CORRECTION_REMOVAL_COLUMNS,
      activationId,
      "removal_day",
    ),
  };
  assertValidationSnapshotMinimized(ledger);
  return ledger;
}

function sealValidationProjection(input, artifactKind, eventType, extract) {
  if (input.destroyPlaintext !== true) {
    throw new Error("Validation storage sealing requires explicit plaintext destruction");
  }
  assertPrivateFile(input.inputPath, "Validation D1 SQL export");
  strictTimestamp(input.createdAt, "Validation storage creation time");
  const sqlBytes = readFileSync(input.inputPath);
  const database = executeSqlExport(sqlBytes);
  let projection;
  try {
    projection = extract(database, input.activationId, input.createdAt);
  } finally {
    database.close();
    sqlBytes.fill(0);
  }
  const payload = Buffer.from(canonicalJson(projection), "utf8");
  const manifest = writeSealedArtifact({
    payload,
    artifactKind,
    activationId: input.activationId,
    keyPath: input.keyPath,
    keyId: input.keyId,
    createdAt: input.createdAt,
    artifactPath: input.artifactPath,
    manifestPath: input.manifestPath,
  });
  const auditEvent = appendAuditEvent({
    auditPath: input.auditPath,
    activationId: input.activationId,
    eventType,
    artifactSha256: manifest.encrypted_sha256,
    eventAt: input.createdAt,
    operatorRole: input.operatorRole,
  });
  unlinkSync(input.inputPath);
  payload.fill(0);
  return { manifest, auditEvent };
}

export function sealValidationLedgerSnapshot(input) {
  return sealValidationProjection(
    input,
    "validation-ledger-snapshot",
    "validation_snapshot_sealed",
    extractValidationSnapshot,
  );
}

export function sealValidationSuppressionLedger(input) {
  return sealValidationProjection(
    input,
    "validation-suppression-ledger",
    "validation_suppression_sealed",
    extractValidationSuppressionLedger,
  );
}

function parseJsonArtifact(bytes, name) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${name} artifact is not valid JSON`);
  }
}

function validationRowArray(value, columns, name, activationId) {
  if (!Array.isArray(value)) throw new Error(`${name} rows are invalid`);
  for (const row of value) {
    exactKeys(row, columns, name);
    if (row.activation_id !== activationId) throw new Error(`${name} crossed activation boundaries`);
  }
  return value;
}

function validationSha256(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${name} is invalid`);
  }
}

function validationInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
}

function validateValidationRemovalRows(rows, countColumns, name, capturedAt) {
  for (const row of rows) {
    if (typeof row.removal_day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(row.removal_day)) {
      throw new Error(`${name} day is invalid`);
    }
    strictTimestamp(row.first_removed_at, `${name} first removal time`);
    strictTimestamp(row.last_removed_at, `${name} last removal time`);
    if (row.first_removed_at > row.last_removed_at) throw new Error(`${name} chronology is invalid`);
    if (capturedAt && row.last_removed_at > capturedAt) throw new Error(`${name} contains a future removal`);
    for (const column of countColumns) validationInteger(row[column], `${name} ${column}`);
  }
}

function validateValidationSuppressions(rows, capturedAt, name) {
  const ids = new Set();
  const subjects = new Set();
  const sources = new Set();
  for (const row of rows) {
    strictIdentifier(row.suppression_id, `${name} ID`, SUPPRESSION_ID_PATTERN);
    if (ids.has(row.suppression_id)) throw new Error(`${name} IDs are not unique`);
    ids.add(row.suppression_id);
    validationSha256(row.suppression_subject_sha256, `${name} subject`);
    validationSha256(row.source_event_sha256, `${name} source event`);
    strictTimestamp(row.removed_at, `${name} removal time`);
    if (row.removed_at > capturedAt) throw new Error(`${name} contains a future removal`);
    const validKind = row.suppression_kind === "participant"
      ? row.suppressed_event_type === "participant"
      : row.suppression_kind === "trip" &&
        ["started", "completed", "safe_canceled"].includes(row.suppressed_event_type);
    if (!validKind) throw new Error(`${name} kind is invalid`);
    const subjectKey = [
      row.activation_id,
      row.suppression_kind,
      row.suppression_subject_sha256,
      row.suppressed_event_type,
    ].join("\u0000");
    if (subjects.has(subjectKey)) throw new Error(`${name} subjects are not unique`);
    subjects.add(subjectKey);
    const sourceKey = [
      row.activation_id,
      row.suppression_kind,
      row.suppressed_event_type,
      row.source_event_sha256,
    ].join("\u0000");
    if (sources.has(sourceKey)) throw new Error(`${name} source events are not unique`);
    sources.add(sourceKey);
  }
}

function validateValidationSnapshotRows(snapshot) {
  const activation = exactKeys(
    snapshot.activation,
    VALIDATION_ACTIVATION_COLUMNS,
    "Validation activation",
  );
  if (activation.id !== snapshot.activation_id) throw new Error("Validation activation identity is invalid");
  for (const column of [
    "protocol_sha256", "activation_commitment_sha256", "activation_manifest_sha256",
    "site_catalog_sha256", "scoring_system_sha256",
  ]) validationSha256(activation[column], `Validation activation ${column}`);
  for (const column of [
    "start_at", "end_at", "preregistered_at", "receipt_verified_at", "created_at",
  ]) strictTimestamp(activation[column], `Validation activation ${column}`);
  if (activation.start_at >= activation.end_at || snapshot.captured_at < activation.start_at) {
    throw new Error("Validation snapshot must be captured at or after the sealed activation begins");
  }

  for (const campaign of snapshot.campaigns) {
    strictIdentifier(campaign.campaign_id, "Validation campaign ID");
    validationSha256(campaign.community_approval_sha256, "Validation campaign approval", { nullable: true });
    validationSha256(campaign.token_payload_sha256, "Validation campaign token payload");
    for (const column of ["invite_issued_at", "invite_expires_at", "sealed_at"]) {
      strictTimestamp(campaign[column], `Validation campaign ${column}`);
    }
    if (campaign.sealed_at > snapshot.captured_at) throw new Error("Validation campaign postdates its snapshot");
  }
  for (const recruitment of snapshot.recruitment_events) {
    if (recruitment.event_contract_version !== FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION) {
      throw new Error("Unexpected feasibility recruitment contract version");
    }
    validationSha256(recruitment.event_sha256, "Validation recruitment event hash");
    validationSha256(recruitment.snapshot_suppression_sha256, "Validation recruitment suppression subject");
    for (const column of ["recruited_at", "created_at"]) {
      strictTimestamp(recruitment[column], `Validation recruitment ${column}`);
    }
    if (recruitment.created_at > snapshot.captured_at || recruitment.recruited_at > snapshot.captured_at) {
      throw new Error("Validation recruitment postdates its snapshot");
    }
  }
  for (const event of snapshot.events) {
    if (event.event_contract_version !== FEASIBILITY_EVENT_CONTRACT_VERSION ||
        !["started", "completed", "safe_canceled"].includes(event.event_type)) {
      throw new Error("Unexpected feasibility event contract");
    }
    for (const column of [
      "source_record_sha256", "scoring_system_sha256", "snapshot_sha256",
      "event_sha256", "snapshot_suppression_sha256",
    ]) validationSha256(event[column], `Validation event ${column}`);
    validationSha256(event.previous_event_sha256, "Validation event previous hash", { nullable: true });
    strictTimestamp(event.segment_start_at, "Validation event segment start");
    strictTimestamp(event.event_at, "Validation event time");
    if (event.segment_end_at !== null) strictTimestamp(event.segment_end_at, "Validation event segment end");
    if (event.event_at > snapshot.captured_at || event.segment_start_at > snapshot.captured_at ||
        (event.segment_end_at !== null && event.segment_end_at > snapshot.captured_at)) {
      throw new Error("Validation event postdates its snapshot");
    }
    if (![0, 1].includes(event.score_influenced_choice) ||
        ![null, 0, 1].includes(event.target_encountered)) {
      throw new Error("Validation event boolean encoding is invalid");
    }
  }
  const startSuppressionByTrip = new Map(
    snapshot.events
      .filter((event) => event.event_type === "started")
      .map((event) => [event.trip_id, event.snapshot_suppression_sha256]),
  );
  for (const event of snapshot.events) {
    if (event.event_type !== "started" &&
        startSuppressionByTrip.get(event.trip_id) !== event.snapshot_suppression_sha256) {
      throw new Error("Validation terminal event suppression identity does not match its start");
    }
  }
  for (const correction of snapshot.corrections) {
    if (correction.correction_contract_version !== FEASIBILITY_CORRECTION_CONTRACT_VERSION) {
      throw new Error("Unexpected feasibility correction contract version");
    }
    for (const column of ["root_completion_event_sha256", "previous_event_sha256", "event_sha256"]) {
      validationSha256(correction[column], `Validation correction ${column}`);
    }
    for (const column of ["segment_start_at", "segment_end_at", "corrected_at"]) {
      strictTimestamp(correction[column], `Validation correction ${column}`);
    }
    if (correction.corrected_at > snapshot.captured_at) {
      throw new Error("Validation correction postdates its snapshot");
    }
    if (![0, 1].includes(correction.target_encountered)) {
      throw new Error("Validation correction boolean encoding is invalid");
    }
  }
  validateValidationRemovalRows(snapshot.privacy_removals, [
    "removed_event_count", "removed_started_attempt_count", "removed_completed_attempt_count",
    "removed_safe_canceled_attempt_count",
  ], "Validation privacy removal", snapshot.captured_at);
  validateValidationRemovalRows(snapshot.recruitment_removals, [
    "removed_recruitment_count", "removed_organic_count", "removed_direct_count",
    "removed_community_count",
  ], "Validation recruitment removal", snapshot.captured_at);
  validateValidationRemovalRows(
    snapshot.correction_removals,
    ["removed_correction_count"],
    "Validation correction removal",
    snapshot.captured_at,
  );
  validateValidationSuppressions(snapshot.suppressions, snapshot.captured_at, "Validation snapshot suppression");
}

function parseValidationSnapshot(bytes, expectedActivationId, expectedCapturedAt) {
  const snapshot = exactKeys(parseJsonArtifact(bytes, "Validation snapshot"), [
    "schema_version", "activation_id", "captured_at", "activation", "campaigns",
    "recruitment_events", "events", "corrections", "privacy_removals",
    "recruitment_removals", "correction_removals", "suppressions",
  ], "Validation snapshot");
  if (snapshot.schema_version !== VALIDATION_SNAPSHOT_VERSION ||
      snapshot.activation_id !== expectedActivationId) {
    throw new Error("Validation snapshot contract does not match the restore drill");
  }
  strictTimestamp(snapshot.captured_at, "Validation snapshot capture time");
  if (snapshot.captured_at !== expectedCapturedAt) {
    throw new Error("Validation snapshot capture time does not match its manifest");
  }
  snapshot.campaigns = validationRowArray(
    snapshot.campaigns,
    VALIDATION_CAMPAIGN_COLUMNS,
    "Validation campaign",
    expectedActivationId,
  );
  snapshot.recruitment_events = validationRowArray(
    snapshot.recruitment_events,
    VALIDATION_RECRUITMENT_COLUMNS,
    "Validation recruitment",
    expectedActivationId,
  );
  snapshot.events = validationRowArray(
    snapshot.events,
    VALIDATION_EVENT_COLUMNS,
    "Validation event",
    expectedActivationId,
  );
  snapshot.corrections = validationRowArray(
    snapshot.corrections,
    VALIDATION_CORRECTION_COLUMNS,
    "Validation correction",
    expectedActivationId,
  );
  snapshot.privacy_removals = validationRowArray(
    snapshot.privacy_removals,
    VALIDATION_PRIVACY_REMOVAL_COLUMNS,
    "Validation privacy removal",
    expectedActivationId,
  );
  snapshot.recruitment_removals = validationRowArray(
    snapshot.recruitment_removals,
    VALIDATION_RECRUITMENT_REMOVAL_COLUMNS,
    "Validation recruitment removal",
    expectedActivationId,
  );
  snapshot.correction_removals = validationRowArray(
    snapshot.correction_removals,
    VALIDATION_CORRECTION_REMOVAL_COLUMNS,
    "Validation correction removal",
    expectedActivationId,
  );
  snapshot.suppressions = validationRowArray(
    snapshot.suppressions,
    VALIDATION_SUPPRESSION_COLUMNS,
    "Validation snapshot suppression",
    expectedActivationId,
  );
  assertValidationSnapshotMinimized(snapshot);
  validateValidationSnapshotRows(snapshot);
  return snapshot;
}

function parseValidationSuppressionLedger(bytes, expectedActivationId, expectedCapturedAt) {
  const ledger = exactKeys(parseJsonArtifact(bytes, "Validation suppression ledger"), [
    "schema_version", "activation_id", "captured_at", "suppressions", "privacy_removals",
    "recruitment_removals", "correction_removals",
  ], "Validation suppression ledger");
  if (ledger.schema_version !== VALIDATION_SUPPRESSION_LEDGER_VERSION ||
      ledger.activation_id !== expectedActivationId) {
    throw new Error("Validation suppression contract does not match the restore drill");
  }
  strictTimestamp(ledger.captured_at, "Validation suppression capture time");
  if (ledger.captured_at !== expectedCapturedAt) {
    throw new Error("Validation suppression capture time does not match its manifest");
  }
  ledger.suppressions = validationRowArray(
    ledger.suppressions,
    VALIDATION_SUPPRESSION_COLUMNS,
    "Validation suppression",
    expectedActivationId,
  );
  ledger.privacy_removals = validationRowArray(
    ledger.privacy_removals,
    VALIDATION_PRIVACY_REMOVAL_COLUMNS,
    "Validation privacy removal",
    expectedActivationId,
  );
  ledger.recruitment_removals = validationRowArray(
    ledger.recruitment_removals,
    VALIDATION_RECRUITMENT_REMOVAL_COLUMNS,
    "Validation recruitment removal",
    expectedActivationId,
  );
  ledger.correction_removals = validationRowArray(
    ledger.correction_removals,
    VALIDATION_CORRECTION_REMOVAL_COLUMNS,
    "Validation correction removal",
    expectedActivationId,
  );
  assertValidationSnapshotMinimized(ledger);
  validateValidationRemovalRows(ledger.privacy_removals, [
    "removed_event_count", "removed_started_attempt_count", "removed_completed_attempt_count",
    "removed_safe_canceled_attempt_count",
  ], "Validation privacy removal", ledger.captured_at);
  validateValidationRemovalRows(ledger.recruitment_removals, [
    "removed_recruitment_count", "removed_organic_count", "removed_direct_count",
    "removed_community_count",
  ], "Validation recruitment removal", ledger.captured_at);
  validateValidationRemovalRows(
    ledger.correction_removals,
    ["removed_correction_count"],
    "Validation correction removal",
    ledger.captured_at,
  );
  validateValidationSuppressions(ledger.suppressions, ledger.captured_at, "Validation suppression");
  return ledger;
}

function camelCaseValidationRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z0-9])/gu, (_match, character) => character.toUpperCase()),
    value,
  ]));
}

function validationEventRecord(row) {
  const event = camelCaseValidationRow(row);
  return {
    ...event,
    eventContractVersion: FEASIBILITY_EVENT_CONTRACT_VERSION,
    scoreInfluencedChoice: Boolean(event.scoreInfluencedChoice),
    targetEncountered: event.targetEncountered === null ? null : Boolean(event.targetEncountered),
  };
}

function validationCorrectionRecord(row) {
  const correction = camelCaseValidationRow(row);
  return {
    ...correction,
    correctionContractVersion: FEASIBILITY_CORRECTION_CONTRACT_VERSION,
    targetEncountered: Boolean(correction.targetEncountered),
  };
}

function validationRecruitmentRecord(row) {
  return {
    ...camelCaseValidationRow(row),
    eventContractVersion: FEASIBILITY_RECRUITMENT_EVENT_CONTRACT_VERSION,
  };
}

function sumValidationRemovalRows(rows, column) {
  return rows.reduce((sum, row) => {
    const next = sum + row[column];
    if (!Number.isSafeInteger(next)) throw new Error("Validation removal totals exceed safe integer bounds");
    return next;
  }, 0);
}

function suppressionFingerprint(row) {
  return [
    row.suppression_kind,
    row.suppression_subject_sha256,
    row.suppressed_event_type,
    row.source_event_sha256,
  ].join("\u0000");
}

function suppressionSubjectFingerprint(row) {
  return [
    row.suppression_kind,
    row.suppression_subject_sha256,
    row.suppressed_event_type,
  ].join("\u0000");
}

function suppressionSourceFingerprint(row) {
  return [row.suppression_kind, row.suppressed_event_type, row.source_event_sha256].join("\u0000");
}

function validateSuppressionContinuity(snapshot, ledger) {
  if (ledger.captured_at < snapshot.captured_at) {
    throw new Error("Validation suppression ledger predates its snapshot");
  }
  const currentByFingerprint = new Map(
    ledger.suppressions.map((row) => [suppressionFingerprint(row), row]),
  );
  for (const suppression of snapshot.suppressions) {
    const current = currentByFingerprint.get(suppressionFingerprint(suppression));
    if (!current || canonicalJson(current) !== canonicalJson(suppression)) {
      throw new Error("Validation suppression ledger is not cumulative from the snapshot");
    }
  }

  const eventSuppressions = ledger.suppressions.filter((row) => row.suppression_kind === "trip");
  const participantSuppressions = ledger.suppressions.filter((row) => row.suppression_kind === "participant");
  const privacyTotals = {
    removedEvents: sumValidationRemovalRows(ledger.privacy_removals, "removed_event_count"),
    removedStartedAttempts: sumValidationRemovalRows(
      ledger.privacy_removals,
      "removed_started_attempt_count",
    ),
    removedCompletedAttempts: sumValidationRemovalRows(
      ledger.privacy_removals,
      "removed_completed_attempt_count",
    ),
    removedSafeCanceledAttempts: sumValidationRemovalRows(
      ledger.privacy_removals,
      "removed_safe_canceled_attempt_count",
    ),
  };
  const recruitmentTotals = {
    removedRecruitments: sumValidationRemovalRows(
      ledger.recruitment_removals,
      "removed_recruitment_count",
    ),
    removedOrganic: sumValidationRemovalRows(ledger.recruitment_removals, "removed_organic_count"),
    removedDirect: sumValidationRemovalRows(ledger.recruitment_removals, "removed_direct_count"),
    removedCommunity: sumValidationRemovalRows(
      ledger.recruitment_removals,
      "removed_community_count",
    ),
  };
  const correctionTotals = {
    removedCorrections: sumValidationRemovalRows(
      ledger.correction_removals,
      "removed_correction_count",
    ),
  };
  const suppressionCounts = {
    events: eventSuppressions.length,
    started: eventSuppressions.filter((row) => row.suppressed_event_type === "started").length,
    completed: eventSuppressions.filter((row) => row.suppressed_event_type === "completed").length,
    safeCanceled: eventSuppressions.filter((row) => row.suppressed_event_type === "safe_canceled").length,
    participants: participantSuppressions.length,
  };
  if (
    privacyTotals.removedEvents < suppressionCounts.events ||
    privacyTotals.removedStartedAttempts < suppressionCounts.started ||
    privacyTotals.removedCompletedAttempts < suppressionCounts.completed ||
    privacyTotals.removedSafeCanceledAttempts < suppressionCounts.safeCanceled ||
    recruitmentTotals.removedRecruitments < suppressionCounts.participants ||
    privacyTotals.removedStartedAttempts + privacyTotals.removedCompletedAttempts +
      privacyTotals.removedSafeCanceledAttempts !== privacyTotals.removedEvents ||
    recruitmentTotals.removedOrganic + recruitmentTotals.removedDirect +
      recruitmentTotals.removedCommunity !== recruitmentTotals.removedRecruitments ||
    privacyTotals.removedCompletedAttempts + privacyTotals.removedSafeCanceledAttempts >
      privacyTotals.removedStartedAttempts
  ) {
    throw new Error("Validation suppression and aggregate removal ledgers do not reconcile");
  }
  return { privacyTotals, recruitmentTotals, correctionTotals, suppressionCounts };
}

function suppressionIndexes(rows) {
  return {
    exact: new Set(rows.map(suppressionFingerprint)),
    subjects: new Map(rows.map((row) => [suppressionSubjectFingerprint(row), row.source_event_sha256])),
    sources: new Map(rows.map((row) => [suppressionSourceFingerprint(row), row.suppression_subject_sha256])),
  };
}

function rowSuppressed(row, kind, eventType, indexes) {
  const candidate = {
    suppression_kind: kind,
    suppression_subject_sha256: row.snapshot_suppression_sha256,
    suppressed_event_type: eventType,
    source_event_sha256: row.event_sha256,
  };
  if (indexes.exact.has(suppressionFingerprint(candidate))) return true;
  if (indexes.subjects.has(suppressionSubjectFingerprint(candidate)) ||
      indexes.sources.has(suppressionSourceFingerprint(candidate))) {
    throw new Error("Validation suppression identity does not match its snapshot source row");
  }
  return false;
}

async function verifyValidationSnapshotIntegrity(snapshot) {
  const recruitments = snapshot.recruitment_events.map(validationRecruitmentRecord);
  const events = snapshot.events.map(validationEventRecord);
  const corrections = snapshot.corrections.map(validationCorrectionRecord);
  const [recruitmentHashes, eventHashes, correctionHashes] = await Promise.all([
    Promise.all(recruitments.map((record) => verifyFeasibilityRecruitmentHash(record))),
    Promise.all(events.map((record) => verifyFeasibilityEventHash(record))),
    Promise.all(corrections.map((record) => verifyFeasibilityCorrectionHash(record))),
  ]);
  if (recruitmentHashes.includes(false) || eventHashes.includes(false) || correctionHashes.includes(false)) {
    throw new Error("Validation snapshot contains an invalid frozen event hash");
  }
  const snapshotReconciliation = await reconcileFeasibilityEvents({
    events,
    corrections,
    privacyRemovals: {
      removedStartedAttempts: sumValidationRemovalRows(
        snapshot.privacy_removals,
        "removed_started_attempt_count",
      ),
      removedCompletedAttempts: sumValidationRemovalRows(
        snapshot.privacy_removals,
        "removed_completed_attempt_count",
      ),
      removedSafeCanceledAttempts: sumValidationRemovalRows(
        snapshot.privacy_removals,
        "removed_safe_canceled_attempt_count",
      ),
    },
    snapshotAndRestorePassed: true,
  });
  if (snapshotReconciliation.failedGates.some((gate) => RECONCILIATION_INTEGRITY_GATES.has(gate))) {
    throw new Error("Validation snapshot failed frozen-ledger integrity checks");
  }
  return { recruitments, events, corrections };
}

function applyValidationSuppressions(records, suppressions) {
  const indexes = suppressionIndexes(suppressions);
  const suppressedTripIds = new Set();
  const retainedEvents = [];
  const suppressedEvents = [];
  for (let index = 0; index < records.events.length; index += 1) {
    const row = records.events[index];
    const stored = records.eventRows[index];
    if (rowSuppressed(stored, "trip", row.eventType, indexes)) {
      suppressedEvents.push(row);
      if (row.eventType === "started") suppressedTripIds.add(row.tripId);
    } else {
      retainedEvents.push(row);
    }
  }
  const retainedRecruitments = [];
  const suppressedRecruitments = [];
  for (let index = 0; index < records.recruitments.length; index += 1) {
    const row = records.recruitments[index];
    const stored = records.recruitmentRows[index];
    if (rowSuppressed(stored, "participant", "participant", indexes)) {
      suppressedRecruitments.push(row);
    } else {
      retainedRecruitments.push(row);
    }
  }
  const snapshotStartTripIds = new Set(
    records.events.filter((event) => event.eventType === "started").map((event) => event.tripId),
  );
  for (const correction of records.corrections) {
    if (!snapshotStartTripIds.has(correction.tripId)) {
      throw new Error("Validation snapshot contains a correction without a started attempt");
    }
  }
  const retainedCorrections = records.corrections.filter(
    (correction) => !suppressedTripIds.has(correction.tripId),
  );
  return {
    retainedEvents,
    retainedRecruitments,
    retainedCorrections,
    suppressedEvents,
    suppressedRecruitments,
    suppressedCorrections: records.corrections.length - retainedCorrections.length,
  };
}

function parsePrivacyLedger(bytes, expectedActivationId) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Privacy ledger artifact is not valid JSON");
  }
  const ledger = exactKeys(parsed, ["schema_version", "activation_id", "captured_at", "jobs", "tasks"], "Privacy ledger");
  if (ledger.schema_version !== PRIVACY_LEDGER_VERSION || ledger.activation_id !== expectedActivationId) {
    throw new Error("Privacy ledger contract does not match the restore drill");
  }
  strictTimestamp(ledger.captured_at, "Privacy ledger capture time");
  if (!Array.isArray(ledger.jobs) || !Array.isArray(ledger.tasks)) throw new Error("Privacy ledger rows are invalid");
  for (const job of ledger.jobs) {
    exactKeys(job, JOB_COLUMNS, "Privacy deletion job");
    if (!["account", "trip"].includes(job.scope) || !SHA256_PATTERN.test(job.subject_hash) ||
        !SHA256_PATTERN.test(job.owner_subject_hash)) {
      throw new Error("Privacy deletion job identity is invalid");
    }
  }
  const jobIds = new Set(ledger.jobs.map((job) => job.id));
  if (jobIds.size !== ledger.jobs.length) throw new Error("Privacy deletion job IDs are not unique");
  for (const task of ledger.tasks) {
    exactKeys(task, TASK_COLUMNS, "Privacy deletion task");
    if (!jobIds.has(task.job_id) || !SHA256_PATTERN.test(task.object_key_hash)) {
      throw new Error("Privacy deletion task identity is invalid");
    }
    if ((task.state === "completed") !== (task.object_key === null)) {
      throw new Error("Privacy deletion task locator state is invalid");
    }
  }
  return ledger;
}

function insertRows(database, table, columns, rows) {
  const placeholders = columns.map(() => "?").join(", ");
  const insert = database.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
}

function replacePrivacyLedger(database, ledger) {
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    database.exec("DELETE FROM privacy_deletion_tasks; DELETE FROM privacy_deletion_jobs;");
    insertRows(database, "privacy_deletion_jobs", JOB_COLUMNS, ledger.jobs);
    insertRows(database, "privacy_deletion_tasks", TASK_COLUMNS, ledger.tasks);
    database.exec("COMMIT; PRAGMA foreign_keys = ON;");
  } catch (error) {
    database.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
    throw error;
  }
}

function suppressRestoredDeletions(database, ledger) {
  const users = tableExists(database, "users") ? database.prepare("SELECT id FROM users").all() : [];
  const trips = tableExists(database, "trips") ? database.prepare("SELECT id, user_id FROM trips").all() : [];
  const accountIds = new Set();
  const tripIds = new Set();
  for (const job of ledger.jobs) {
    if (job.scope === "account") {
      for (const user of users) {
        if (sha256(`account:${user.id}`) === job.subject_hash) accountIds.add(user.id);
      }
    } else {
      for (const trip of trips) {
        if (sha256(`trip:${trip.id}`) === job.subject_hash) tripIds.add(trip.id);
      }
    }
  }
  for (const trip of trips) {
    if (accountIds.has(trip.user_id)) tripIds.add(trip.id);
  }
  let discussions = 0;
  let validationEvents = 0;
  let validationCorrections = 0;
  let validationRecruitments = 0;
  if (tableExists(database, "site_discussion_posts") && tripIds.size > 0) {
    const count = database.prepare("SELECT COUNT(*) AS count FROM site_discussion_posts WHERE trip_id = ?");
    for (const tripId of tripIds) discussions += Number(count.get(tripId).count);
  }
  if (tableExists(database, "validation_feasibility_events")) {
    const count = database.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_events WHERE trip_id = ?");
    for (const tripId of tripIds) validationEvents += Number(count.get(tripId).count);
  }
  if (tableExists(database, "validation_feasibility_corrections")) {
    const count = database.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_corrections WHERE trip_id = ?");
    for (const tripId of tripIds) validationCorrections += Number(count.get(tripId).count);
  }
  if (tableExists(database, "validation_feasibility_recruitment_events")) {
    const count = database.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_recruitment_events WHERE user_id = ?");
    for (const accountId of accountIds) validationRecruitments += Number(count.get(accountId).count);
  }
  database.exec("BEGIN IMMEDIATE;");
  try {
    const deleteTrip = database.prepare("DELETE FROM trips WHERE id = ?");
    for (const tripId of tripIds) deleteTrip.run(tripId);
    const deleteUser = database.prepare("DELETE FROM users WHERE id = ?");
    for (const accountId of accountIds) deleteUser.run(accountId);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return {
    accountIds,
    tripIds,
    discussions,
    validationEvents,
    validationCorrections,
    validationRecruitments,
  };
}

function assertDeletionSuppressed(database, ledger) {
  const users = tableExists(database, "users") ? database.prepare("SELECT id FROM users").all() : [];
  const trips = tableExists(database, "trips") ? database.prepare("SELECT id FROM trips").all() : [];
  for (const job of ledger.jobs) {
    const rows = job.scope === "account" ? users : trips;
    if (rows.some((row) => sha256(`${job.scope}:${row.id}`) === job.subject_hash)) {
      throw new Error("A current privacy tombstone still matches restored active data");
    }
  }
}

class SQLiteStatementAdapter {
  constructor(statement) {
    this.statement = statement;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async all() {
    return { results: this.statement.all(...this.values) };
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }
}

class SQLiteD1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SQLiteStatementAdapter(this.database.prepare(query));
  }
}

function countRows(database, table) {
  return tableExists(database, table)
    ? Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
    : 0;
}

function requiredAuditArtifact(events, eventType, checksum, activationId) {
  return events.some((event) => event.event_type === eventType &&
    event.artifact_sha256 === checksum && event.activation_id === activationId);
}

export async function runValidationRestoreDrill(input) {
  if (input.destroyRestored !== true) {
    throw new Error("Validation restore drill requires destruction of decrypted projections");
  }
  strictIdentifier(input.activationId, "Validation restore activation ID");
  strictIdentifier(input.operatorRole, "Validation restore operator role", ROLE_PATTERN);
  strictTimestamp(input.completedAt, "Validation restore completion time");
  assertOutputAvailable(input.evidencePath, "Validation restore evidence");
  let snapshotArtifact;
  let suppressionArtifact;
  let evidenceCore;
  try {
    snapshotArtifact = decryptArtifact({
      artifactPath: input.snapshotArtifactPath,
      manifestPath: input.snapshotManifestPath,
      keyPath: input.snapshotKeyPath,
      expectedKind: "validation-ledger-snapshot",
      expectedActivationId: input.activationId,
    });
    suppressionArtifact = decryptArtifact({
      artifactPath: input.suppressionArtifactPath,
      manifestPath: input.suppressionManifestPath,
      keyPath: input.suppressionKeyPath,
      expectedKind: "validation-suppression-ledger",
      expectedActivationId: input.activationId,
    });
    const auditEvents = verifyStorageAuditLog(input.auditPath);
    if (!requiredAuditArtifact(
      auditEvents,
      "validation_snapshot_sealed",
      snapshotArtifact.manifest.encrypted_sha256,
      input.activationId,
    ) || !requiredAuditArtifact(
      auditEvents,
      "validation_suppression_sealed",
      suppressionArtifact.manifest.encrypted_sha256,
      input.activationId,
    )) {
      throw new Error("Validation restore inputs are missing from the verified storage audit chain");
    }
    const snapshot = parseValidationSnapshot(
      snapshotArtifact.plaintext,
      input.activationId,
      snapshotArtifact.manifest.created_at,
    );
    const suppressionLedger = parseValidationSuppressionLedger(
      suppressionArtifact.plaintext,
      input.activationId,
      suppressionArtifact.manifest.created_at,
    );
    if (input.completedAt < suppressionLedger.captured_at) {
      throw new Error("Validation restore completion predates its suppression ledger");
    }
    const totals = validateSuppressionContinuity(snapshot, suppressionLedger);
    const verified = await verifyValidationSnapshotIntegrity(snapshot);
    const projection = applyValidationSuppressions({
      ...verified,
      eventRows: snapshot.events,
      recruitmentRows: snapshot.recruitment_events,
    }, suppressionLedger.suppressions);
    const reconciliation = await reconcileFeasibilityEvents({
      events: projection.retainedEvents,
      corrections: projection.retainedCorrections,
      privacyRemovals: totals.privacyTotals,
      snapshotAndRestorePassed: true,
    });
    if (reconciliation.failedGates.some((gate) => RECONCILIATION_INTEGRITY_GATES.has(gate))) {
      throw new Error("Suppressed validation snapshot failed reconciliation integrity checks");
    }
    evidenceCore = {
      schema_version: VALIDATION_RESTORE_EVIDENCE_VERSION,
      activation_id: input.activationId,
      drill_completed_at: input.completedAt,
      snapshot_encrypted_sha256: snapshotArtifact.manifest.encrypted_sha256,
      suppression_ledger_encrypted_sha256: suppressionArtifact.manifest.encrypted_sha256,
      snapshot_retention_days: snapshotArtifact.manifest.retention_days,
      suppression_ledger_retention_days: suppressionArtifact.manifest.retention_days,
      snapshot_retention_until: snapshotArtifact.manifest.retention_until,
      suppression_ledger_retention_until: suppressionArtifact.manifest.retention_until,
      snapshot_capture_after_activation_end: snapshot.captured_at >= snapshot.activation.end_at,
      retained_recruitment_count: projection.retainedRecruitments.length,
      retained_event_count: projection.retainedEvents.length,
      retained_correction_count: projection.retainedCorrections.length,
      suppressed_snapshot_recruitment_count: projection.suppressedRecruitments.length,
      suppressed_snapshot_event_count: projection.suppressedEvents.length,
      suppressed_snapshot_started_attempt_count: projection.suppressedEvents.filter(
        (event) => event.eventType === "started",
      ).length,
      suppressed_snapshot_completed_attempt_count: projection.suppressedEvents.filter(
        (event) => event.eventType === "completed",
      ).length,
      suppressed_snapshot_safe_canceled_attempt_count: projection.suppressedEvents.filter(
        (event) => event.eventType === "safe_canceled",
      ).length,
      suppressed_snapshot_correction_count: projection.suppressedCorrections,
      cumulative_suppression_count: suppressionLedger.suppressions.length,
      aggregate_removed_event_count: totals.privacyTotals.removedEvents,
      aggregate_removed_started_attempt_count: totals.privacyTotals.removedStartedAttempts,
      aggregate_removed_completed_attempt_count: totals.privacyTotals.removedCompletedAttempts,
      aggregate_removed_safe_canceled_attempt_count: totals.privacyTotals.removedSafeCanceledAttempts,
      aggregate_removed_recruitment_count: totals.recruitmentTotals.removedRecruitments,
      aggregate_removed_correction_count: totals.correctionTotals.removedCorrections,
      reconciliation_status: reconciliation.status,
      reconciliation_failed_gates: reconciliation.failedGates,
      reconciliation_snapshot_restore_gate_passed: reconciliation.snapshotAndRestorePassed,
      technical_validation_snapshot_restore_passed: true,
      governance_approval_recorded: false,
      validation_snapshot_and_restore_gate_passed: false,
      validation_snapshot_gate_blocker: "730-day-validation-snapshot-suppression-governance-not-approved",
      candidate_performance_computed: reconciliation.candidatePerformanceComputed,
      private_raw_rows_published: false,
      plaintext_artifacts_retained: false,
      restored_projection_retained: false,
    };
  } finally {
    snapshotArtifact?.plaintext.fill(0);
    suppressionArtifact?.plaintext.fill(0);
  }
  const evidencePayloadSha256 = sha256(canonicalJson(evidenceCore));
  const auditEvent = appendAuditEvent({
    auditPath: input.auditPath,
    activationId: input.activationId,
    eventType: "validation_restore_drill_completed",
    artifactSha256: evidencePayloadSha256,
    eventAt: input.completedAt,
    operatorRole: input.operatorRole,
  });
  const evidence = {
    ...evidenceCore,
    evidence_payload_sha256: evidencePayloadSha256,
    audit_event_sha256: auditEvent.event_sha256,
  };
  atomicWrite(input.evidencePath, `${canonicalJson(evidence)}\n`);
  return evidence;
}

export async function runOperationalRestoreDrill(input) {
  if (input.destroyRestored !== true) throw new Error("Restore drill requires destruction of the isolated restored database");
  strictIdentifier(input.activationId, "Restore activation ID");
  strictIdentifier(input.operatorRole, "Restore operator role", ROLE_PATTERN);
  strictTimestamp(input.completedAt, "Restore completion time");
  assertPrivateDirectory(input.workParent, "Restore work parent");
  assertOutputAvailable(input.evidencePath, "Restore evidence");
  const snapshot = decryptArtifact({
    artifactPath: input.snapshotArtifactPath,
    manifestPath: input.snapshotManifestPath,
    keyPath: input.snapshotKeyPath,
    expectedKind: "d1-sql-export",
    expectedActivationId: input.activationId,
  });
  const privacy = decryptArtifact({
    artifactPath: input.ledgerArtifactPath,
    manifestPath: input.ledgerManifestPath,
    keyPath: input.ledgerKeyPath,
    expectedKind: "privacy-deletion-ledger",
    expectedActivationId: input.activationId,
  });
  const auditEvents = verifyStorageAuditLog(input.auditPath);
  if (!requiredAuditArtifact(auditEvents, "snapshot_sealed", snapshot.manifest.encrypted_sha256, input.activationId) ||
      !requiredAuditArtifact(auditEvents, "privacy_ledger_sealed", privacy.manifest.encrypted_sha256, input.activationId)) {
    throw new Error("Restore inputs are missing from the verified storage audit chain");
  }
  const ledger = parsePrivacyLedger(privacy.plaintext, input.activationId);
  const workDirectory = mkdtempSync(join(resolve(input.workParent), "castingcompass-restore-"));
  const databasePath = join(workDirectory, "isolated.sqlite3");
  let database;
  let evidenceCore;
  try {
    database = executeSqlExport(snapshot.plaintext, databasePath);
    for (const table of [
      "users", "trips", "privacy_deletion_jobs", "privacy_deletion_tasks",
      "validation_feasibility_activations", "validation_feasibility_events",
      "validation_feasibility_corrections", "validation_feasibility_recruitment_events",
    ]) {
      if (!tableExists(database, table)) throw new Error(`Restored database lacks required table ${table}`);
    }
    replacePrivacyLedger(database, ledger);
    const suppressed = suppressRestoredDeletions(database, ledger);
    assertDeletionSuppressed(database, ledger);
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) throw new Error("Restored database integrity checks failed");
    const activation = database.prepare("SELECT id FROM validation_feasibility_activations WHERE id = ?").get(input.activationId);
    if (!activation) throw new Error("Restored database lacks the requested feasibility activation");
    const reconciliationExport = await buildFeasibilityReconciliationExport({
      db: new SQLiteD1Adapter(database),
      activationId: input.activationId,
      snapshotAndRestorePassed: false,
      exportedAt: input.completedAt,
    });
    if (reconciliationExport.reconciliation.failedGates.some((gate) => RECONCILIATION_INTEGRITY_GATES.has(gate))) {
      throw new Error("Restored feasibility ledger failed reconciliation integrity checks");
    }
    const migrations = tableExists(database, "d1_migrations")
      ? database.prepare("SELECT name FROM d1_migrations ORDER BY id").all()
      : [];
    const unresolvedTasks = ledger.tasks.filter((task) => task.state !== "completed").length;
    const completedTasks = ledger.tasks.length - unresolvedTasks;
    evidenceCore = {
      schema_version: RESTORE_EVIDENCE_VERSION,
      activation_id: input.activationId,
      drill_completed_at: input.completedAt,
      snapshot_encrypted_sha256: snapshot.manifest.encrypted_sha256,
      privacy_ledger_encrypted_sha256: privacy.manifest.encrypted_sha256,
      snapshot_retention_until: snapshot.manifest.retention_until,
      restored_schema_table_count: Number(database.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).get().count),
      migration_count: migrations.length,
      last_migration_name: migrations.at(-1)?.name ?? null,
      integrity_check: integrity,
      foreign_key_violation_count: foreignKeyViolations,
      suppressed_account_count: suppressed.accountIds.size,
      suppressed_trip_count: suppressed.tripIds.size,
      suppressed_public_discussion_count: suppressed.discussions,
      suppressed_validation_event_count: suppressed.validationEvents,
      suppressed_validation_correction_count: suppressed.validationCorrections,
      suppressed_validation_recruitment_count: suppressed.validationRecruitments,
      privacy_job_count: ledger.jobs.length,
      privacy_task_count: ledger.tasks.length,
      unresolved_object_task_count: unresolvedTasks,
      completed_object_task_count: completedTasks,
      validation_event_count: countRows(database, "validation_feasibility_events"),
      validation_correction_count: countRows(database, "validation_feasibility_corrections"),
      validation_recruitment_count: countRows(database, "validation_feasibility_recruitment_events"),
      reconciliation_status: reconciliationExport.reconciliation.status,
      reconciliation_failed_gates: reconciliationExport.reconciliation.failedGates,
      candidate_performance_computed: reconciliationExport.candidatePerformanceComputed,
      operational_restore_passed: true,
      validation_snapshot_and_restore_gate_passed: false,
      validation_snapshot_retention_days_required: VALIDATION_RETENTION_DAYS,
      validation_snapshot_gate_blocker: "730-day-validation-snapshot-suppression-policy-not-approved",
      plaintext_artifacts_retained: false,
      restored_database_retained: false,
    };
  } finally {
    database?.close();
    snapshot.plaintext.fill(0);
    privacy.plaintext.fill(0);
    rmSync(workDirectory, { recursive: true, force: true });
  }
  const evidencePayloadSha256 = sha256(canonicalJson(evidenceCore));
  const auditEvent = appendAuditEvent({
    auditPath: input.auditPath,
    activationId: input.activationId,
    eventType: "restore_drill_completed",
    artifactSha256: evidencePayloadSha256,
    eventAt: input.completedAt,
    operatorRole: input.operatorRole,
  });
  const evidence = {
    ...evidenceCore,
    evidence_payload_sha256: evidencePayloadSha256,
    audit_event_sha256: auditEvent.event_sha256,
  };
  atomicWrite(input.evidencePath, `${canonicalJson(evidence)}\n`);
  return evidence;
}

function parseArguments(argv) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}`);
    if (["--destroy-plaintext", "--destroy-restored"].includes(argument)) {
      booleans.add(argument.slice(2));
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  return { get: (name) => values.get(name), has: (name) => booleans.has(name) };
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArguments(argv);
  if ([
    "seal-snapshot",
    "seal-ledger",
    "seal-validation-snapshot",
    "seal-validation-suppression",
  ].includes(command)) {
    const input = {
      inputPath: required(args, "input"),
      artifactPath: required(args, "artifact"),
      manifestPath: required(args, "manifest"),
      keyPath: required(args, "key-file"),
      keyId: required(args, "key-id"),
      activationId: required(args, "activation-id"),
      createdAt: new Date().toISOString(),
      auditPath: required(args, "audit-log"),
      operatorRole: required(args, "operator-role"),
      destroyPlaintext: args.has("destroy-plaintext"),
    };
    const seal = new Map([
      ["seal-snapshot", sealOperationalSnapshot],
      ["seal-ledger", sealPrivacyLedger],
      ["seal-validation-snapshot", sealValidationLedgerSnapshot],
      ["seal-validation-suppression", sealValidationSuppressionLedger],
    ]).get(command);
    const result = seal(input);
    process.stdout.write(`${JSON.stringify({
      encryptedSha256: result.manifest.encrypted_sha256,
      auditEventSha256: result.auditEvent.event_sha256,
    })}\n`);
    return;
  }
  if (command === "restore-drill") {
    const result = await runOperationalRestoreDrill({
      activationId: required(args, "activation-id"),
      snapshotArtifactPath: required(args, "snapshot-artifact"),
      snapshotManifestPath: required(args, "snapshot-manifest"),
      snapshotKeyPath: required(args, "snapshot-key-file"),
      ledgerArtifactPath: required(args, "ledger-artifact"),
      ledgerManifestPath: required(args, "ledger-manifest"),
      ledgerKeyPath: required(args, "ledger-key-file"),
      auditPath: required(args, "audit-log"),
      workParent: required(args, "work-parent"),
      evidencePath: required(args, "evidence"),
      completedAt: new Date().toISOString(),
      operatorRole: required(args, "operator-role"),
      destroyRestored: args.has("destroy-restored"),
    });
    process.stdout.write(`${JSON.stringify({
      operationalRestorePassed: result.operational_restore_passed,
      validationSnapshotGatePassed: result.validation_snapshot_and_restore_gate_passed,
      evidencePayloadSha256: result.evidence_payload_sha256,
      auditEventSha256: result.audit_event_sha256,
    })}\n`);
    return;
  }
  if (command === "restore-validation-drill") {
    const result = await runValidationRestoreDrill({
      activationId: required(args, "activation-id"),
      snapshotArtifactPath: required(args, "snapshot-artifact"),
      snapshotManifestPath: required(args, "snapshot-manifest"),
      snapshotKeyPath: required(args, "snapshot-key-file"),
      suppressionArtifactPath: required(args, "suppression-artifact"),
      suppressionManifestPath: required(args, "suppression-manifest"),
      suppressionKeyPath: required(args, "suppression-key-file"),
      auditPath: required(args, "audit-log"),
      evidencePath: required(args, "evidence"),
      completedAt: new Date().toISOString(),
      operatorRole: required(args, "operator-role"),
      destroyRestored: args.has("destroy-restored"),
    });
    process.stdout.write(`${JSON.stringify({
      technicalValidationSnapshotRestorePassed: result.technical_validation_snapshot_restore_passed,
      governanceApprovalRecorded: result.governance_approval_recorded,
      validationSnapshotGatePassed: result.validation_snapshot_and_restore_gate_passed,
      evidencePayloadSha256: result.evidence_payload_sha256,
      auditEventSha256: result.audit_event_sha256,
    })}\n`);
    return;
  }
  if (command === "verify-audit") {
    const events = verifyStorageAuditLog(required(args, "audit-log"));
    process.stdout.write(`${JSON.stringify({ events: events.length, head: events.at(-1)?.event_sha256 ?? null })}\n`);
    return;
  }
  throw new Error(
    "Usage: validation-storage.mjs seal-snapshot|seal-ledger|seal-validation-snapshot|" +
    "seal-validation-suppression|restore-drill|restore-validation-drill|verify-audit [options]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
