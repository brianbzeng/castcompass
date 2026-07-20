#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = "security/operational-restore-review-policy.json";
const CONTRACT_PATH = "contracts/operational-restore-independent-review.schema.json";
const LOCKED_POLICY_SHA256 = "37681b8512762717cd3d3b885e90e33a856607fcf9065dcbb292065fc45ba5af";
const LOCKED_CONTRACT_SHA256 = "7006b93a8aa18eede95d79df182871cf2051078a9b7b3e812e9d72c650d99b87";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

const PACKET_FILES = Object.freeze([
  "acceptance-record.json",
  "operational-restore-evidence.json",
  "storage-audit.ndjson",
]);
const AUDIT_EVENTS = Object.freeze([
  Object.freeze({ event_type: "snapshot_sealed", operator_role: "data-steward" }),
  Object.freeze({ event_type: "privacy_ledger_sealed", operator_role: "privacy-reviewer" }),
  Object.freeze({ event_type: "restore_drill_completed", operator_role: "data-steward" }),
]);
const ACCEPTANCE_CHECKS = Object.freeze([
  "aggregate_only_evidence",
  "completed_object_task_preserved",
  "current_deletion_ledger_replayed",
  "deleted_account_suppressed",
  "deleted_public_discussion_suppressed",
  "deleted_trip_suppressed",
  "encrypted_fixture_artifacts_destroyed",
  "foreign_key_check_passed",
  "operational_restore_passed",
  "pending_object_task_preserved",
  "plaintext_sources_destroyed",
  "restored_database_destroyed",
  "source_checkout_verified_clean",
  "sqlite_integrity_passed",
  "tampered_artifact_rejected",
  "temporary_keys_destroyed",
  "wrong_key_rejected",
]);
const FALSE_BOUNDARIES = Object.freeze([
  "production_backup_restored",
  "production_data_used",
  "production_key_custody_approved",
  "production_privacy_ledger_used",
  "production_provider_accessed",
  "production_restore_gate_passed",
  "second_person_reviewed",
  "validation_snapshot_governance_approved",
]);
const REVIEW_CHECKS = Object.freeze([
  "acceptance_boundaries_understood",
  "aggregate_only_evidence_confirmed",
  "no_production_authority_granted",
  "packet_integrity_confirmed",
  "source_binding_confirmed",
]);
const APPROVALS_BEFORE_REVIEW = Object.freeze([
  "independent-second-person-review",
  "production-key-custody-policy",
  "provider-and-production-release-evidence",
  "validation-snapshot-governance",
]);
const APPROVALS_AFTER_REVIEW = Object.freeze([
  "production-key-custody-policy",
  "provider-and-production-release-evidence",
  "validation-snapshot-governance",
]);
const PROHIBITED_EVIDENCE_FIELDS = Object.freeze([
  "account_id", "cookie", "email", "ip", "ip_address", "latitude", "longitude", "notes",
  "object_key", "password", "photo_key", "precise_location", "prompt", "provider_id",
  "raw_payload", "session", "token", "trip_id", "user_id", "worker_version_id",
]);
const PROHIBITED_RECEIPT_FIELDS = Object.freeze([
  "activation_id", "architecture", "audit_head_sha256", "evidence_payload_sha256", "file_path",
  "platform", "provider_id", "review_evidence_sha256", "review_id", "reviewer_id", "runtime",
  "storage_audit_sha256",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number"
    || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("Canonical JSON contains an unsupported value.");
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function exactKeys(value, expected, label, { preserveOrder = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value);
  const wanted = [...expected];
  if (!preserveOrder) {
    actual.sort();
    wanted.sort();
  }
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields${preserveOrder ? " or field order" : ""} are invalid.`);
  }
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${label} is invalid.`);
  }
}

function parseTimestamp(value, label) {
  if (!TIMESTAMP_PATTERN.test(value ?? "")) {
    throw new Error(`${label} must be an exact UTC timestamp with milliseconds.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} is not a valid UTC timestamp.`);
  }
  return milliseconds;
}

function parseCanonicalJson(source, label, serialize) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (source !== serialize(value)) {
    throw new Error(`${label} must use its exact canonical JSON form without duplicate keys.`);
  }
  return value;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || value.length < 3 || value.length > 200
    || !IDENTIFIER_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid.`);
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
}

function assertExactBoolean(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
}

function assertNoFields(value, prohibited, label, path = "$") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoFields(entry, prohibited, label, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (prohibited.has(key.toLowerCase())) {
      throw new Error(`${label} contains prohibited field ${path}.${key}.`);
    }
    assertNoFields(child, prohibited, label, `${path}.${key}`);
  }
}

function assertNoCredentialMaterial(source, label) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u
    .test(source)) throw new Error(`${label} contains credential-shaped material.`);
}

export function validateOperationalRestoreReviewPolicy(policy, source = stableJson(policy)) {
  exactKeys(policy, [
    "schema_version",
    "acceptance_schema_version",
    "restore_evidence_schema_version",
    "storage_audit_schema_version",
    "review_schema_version",
    "receipt_schema_version",
    "packet_scope",
    "limits",
    "required_packet_files",
    "required_audit_events",
    "required_acceptance_checks",
    "required_false_boundaries",
    "required_review_checks",
    "remaining_approvals_before_review",
    "remaining_approvals_after_review",
    "prohibited_evidence_fields",
    "prohibited_public_receipt_fields",
  ], "Operational restore review policy", { preserveOrder: true });
  if (source !== stableJson(policy)) {
    throw new Error("Operational restore review policy must use canonical JSON without duplicate keys.");
  }
  if (sha256(source) !== LOCKED_POLICY_SHA256) {
    throw new Error("Operational restore review policy does not match the locked reviewed policy.");
  }
  const expectedVersions = {
    schema_version: "castingcompass.operational-restore-review-policy/1.0.0",
    acceptance_schema_version: "castingcompass.offline-operational-restore-acceptance/1.0.0",
    restore_evidence_schema_version: "castingcompass.operational-restore-evidence/1.0.0",
    storage_audit_schema_version: "castingcompass.operational-storage-audit/1.0.0",
    review_schema_version: "castingcompass.operational-restore-independent-review/1.0.0",
    receipt_schema_version: "castingcompass.operational-restore-independent-review-receipt/1.0.0",
    packet_scope: "synthetic-production-shaped-non-production",
  };
  for (const [field, expected] of Object.entries(expectedVersions)) {
    if (policy[field] !== expected) throw new Error(`Operational restore review ${field} is invalid.`);
  }
  exactKeys(policy.limits, [
    "maximum_packet_bytes", "maximum_review_bytes", "maximum_review_delay_hours",
    "maximum_future_skew_minutes",
  ], "Operational restore review limits", { preserveOrder: true });
  if (policy.limits.maximum_packet_bytes !== 1_048_576
    || policy.limits.maximum_review_bytes !== 65_536
    || policy.limits.maximum_review_delay_hours !== 168
    || policy.limits.maximum_future_skew_minutes !== 5) {
    throw new Error("Operational restore review limits are invalid.");
  }
  exactArray(policy.required_packet_files, PACKET_FILES, "Operational restore packet files");
  if (JSON.stringify(policy.required_audit_events) !== JSON.stringify(AUDIT_EVENTS)) {
    throw new Error("Operational restore audit event contract is invalid.");
  }
  exactArray(policy.required_acceptance_checks, ACCEPTANCE_CHECKS, "Operational restore acceptance checks");
  exactArray(policy.required_false_boundaries, FALSE_BOUNDARIES, "Operational restore false boundaries");
  exactArray(policy.required_review_checks, REVIEW_CHECKS, "Operational restore review checks");
  exactArray(policy.remaining_approvals_before_review, APPROVALS_BEFORE_REVIEW,
    "Operational restore pre-review approvals");
  exactArray(policy.remaining_approvals_after_review, APPROVALS_AFTER_REVIEW,
    "Operational restore post-review approvals");
  exactArray(policy.prohibited_evidence_fields, PROHIBITED_EVIDENCE_FIELDS,
    "Operational restore prohibited evidence fields");
  exactArray(policy.prohibited_public_receipt_fields, PROHIBITED_RECEIPT_FIELDS,
    "Operational restore prohibited receipt fields");
  return policy;
}

export async function loadOperationalRestoreReviewPolicy(root = DEFAULT_ROOT) {
  const source = await readFile(resolve(root, POLICY_PATH), "utf8");
  return validateOperationalRestoreReviewPolicy(parseCanonicalJson(
    source,
    "Operational restore review policy",
    stableJson,
  ), source);
}

export async function verifyOperationalRestoreReviewContract(root = DEFAULT_ROOT) {
  const source = await readFile(resolve(root, CONTRACT_PATH), "utf8");
  if (sha256(source) !== LOCKED_CONTRACT_SHA256) {
    throw new Error("Operational restore review contract does not match the locked reviewed contract.");
  }
  const contract = parseCanonicalJson(source, "Operational restore review contract", stableJson);
  if (contract.$schema !== "https://json-schema.org/draft/2020-12/schema"
    || contract.$id !== "https://castingcompass.com/contracts/operational-restore-independent-review.schema.json"
    || contract.properties?.schema_version?.const
      !== "castingcompass.operational-restore-independent-review/1.0.0"
    || contract.additionalProperties !== false) {
    throw new Error("Operational restore review contract identity is invalid.");
  }
  return contract;
}

function validateAcceptance(acceptance, policy, expectedSourceCommit) {
  exactKeys(acceptance, [
    "schema_version", "scope", "source_commit", "drill_completed_at", "runtime", "receipts",
    "acceptance_checks", "boundaries", "remaining_approvals",
  ], "Operational restore acceptance", { preserveOrder: true });
  if (acceptance.schema_version !== policy.acceptance_schema_version
    || acceptance.scope !== policy.packet_scope) {
    throw new Error("Operational restore acceptance identity is invalid.");
  }
  if (!COMMIT_PATTERN.test(expectedSourceCommit ?? "")
    || acceptance.source_commit !== expectedSourceCommit) {
    throw new Error("Operational restore acceptance does not match the independently expected source commit.");
  }
  const drillCompletedAt = parseTimestamp(acceptance.drill_completed_at, "Restore drill completion");
  exactKeys(acceptance.runtime, ["node", "sqlite", "platform", "architecture"],
    "Operational restore runtime", { preserveOrder: true });
  if (typeof acceptance.runtime.node !== "string" || !/^v22\./u.test(acceptance.runtime.node)
    || (acceptance.runtime.sqlite !== null && typeof acceptance.runtime.sqlite !== "string")
    || typeof acceptance.runtime.platform !== "string" || typeof acceptance.runtime.architecture !== "string") {
    throw new Error("Operational restore runtime identity is invalid.");
  }
  exactKeys(acceptance.receipts, [
    "restore_evidence_file", "restore_evidence_sha256", "restore_evidence_payload_sha256",
    "storage_audit_file", "storage_audit_sha256", "storage_audit_head_sha256",
  ], "Operational restore acceptance receipts", { preserveOrder: true });
  if (acceptance.receipts.restore_evidence_file !== "operational-restore-evidence.json"
    || acceptance.receipts.storage_audit_file !== "storage-audit.ndjson") {
    throw new Error("Operational restore receipt filenames are invalid.");
  }
  for (const [name, value] of Object.entries(acceptance.receipts)) {
    if (name.endsWith("_sha256")) assertSha256(value, `Operational restore ${name}`);
  }
  exactKeys(acceptance.acceptance_checks, policy.required_acceptance_checks,
    "Operational restore acceptance checks");
  for (const name of policy.required_acceptance_checks) {
    assertExactBoolean(acceptance.acceptance_checks[name], true, `Operational restore ${name}`);
  }
  exactKeys(acceptance.boundaries, policy.required_false_boundaries,
    "Operational restore acceptance boundaries");
  for (const name of policy.required_false_boundaries) {
    assertExactBoolean(acceptance.boundaries[name], false, `Operational restore boundary ${name}`);
  }
  exactArray(acceptance.remaining_approvals, policy.remaining_approvals_before_review,
    "Operational restore remaining approvals");
  return drillCompletedAt;
}

function validateRestoreEvidence(evidence, policy, acceptance) {
  exactKeys(evidence, [
    "schema_version", "activation_id", "drill_completed_at", "snapshot_encrypted_sha256",
    "privacy_ledger_encrypted_sha256", "snapshot_retention_until", "restored_schema_table_count",
    "migration_count", "last_migration_name", "integrity_check", "foreign_key_violation_count",
    "suppressed_account_count", "suppressed_trip_count", "suppressed_public_discussion_count",
    "suppressed_validation_event_count", "suppressed_validation_correction_count",
    "suppressed_validation_recruitment_count", "privacy_job_count", "privacy_task_count",
    "unresolved_object_task_count", "completed_object_task_count", "validation_event_count",
    "validation_correction_count", "validation_recruitment_count", "reconciliation_status",
    "reconciliation_failed_gates", "candidate_performance_computed", "operational_restore_passed",
    "validation_snapshot_and_restore_gate_passed", "validation_snapshot_retention_days_required",
    "validation_snapshot_gate_blocker", "plaintext_artifacts_retained", "restored_database_retained",
    "evidence_payload_sha256", "audit_event_sha256",
  ], "Operational restore evidence");
  if (evidence.schema_version !== policy.restore_evidence_schema_version
    || evidence.drill_completed_at !== acceptance.drill_completed_at) {
    throw new Error("Operational restore evidence identity is invalid.");
  }
  assertIdentifier(evidence.activation_id, "Operational restore activation ID");
  parseTimestamp(evidence.snapshot_retention_until, "Operational restore retention");
  for (const name of [
    "snapshot_encrypted_sha256", "privacy_ledger_encrypted_sha256", "evidence_payload_sha256",
    "audit_event_sha256",
  ]) assertSha256(evidence[name], `Operational restore evidence ${name}`);
  const exactCounts = {
    suppressed_account_count: 1,
    suppressed_trip_count: 1,
    suppressed_public_discussion_count: 1,
    suppressed_validation_event_count: 2,
    suppressed_validation_correction_count: 1,
    suppressed_validation_recruitment_count: 1,
    privacy_job_count: 1,
    privacy_task_count: 2,
    unresolved_object_task_count: 1,
    completed_object_task_count: 1,
  };
  for (const [name, expected] of Object.entries(exactCounts)) {
    if (evidence[name] !== expected) throw new Error(`Operational restore ${name} is invalid.`);
  }
  for (const name of [
    "restored_schema_table_count", "migration_count", "foreign_key_violation_count",
    "validation_event_count", "validation_correction_count", "validation_recruitment_count",
  ]) assertNonnegativeInteger(evidence[name], `Operational restore ${name}`);
  if (evidence.integrity_check !== "ok" || evidence.foreign_key_violation_count !== 0
    || evidence.operational_restore_passed !== true
    || evidence.candidate_performance_computed !== false
    || evidence.validation_snapshot_and_restore_gate_passed !== false
    || evidence.validation_snapshot_retention_days_required !== 730
    || evidence.validation_snapshot_gate_blocker
      !== "730-day-validation-snapshot-suppression-policy-not-approved"
    || evidence.plaintext_artifacts_retained !== false
    || evidence.restored_database_retained !== false) {
    throw new Error("Operational restore evidence safety boundary is invalid.");
  }
  if (typeof evidence.last_migration_name !== "string" || evidence.last_migration_name.length === 0
    || typeof evidence.reconciliation_status !== "string"
    || !Array.isArray(evidence.reconciliation_failed_gates)
    || evidence.reconciliation_failed_gates.some((value) => typeof value !== "string")) {
    throw new Error("Operational restore evidence reconciliation fields are invalid.");
  }
  const payloadDigest = evidence.evidence_payload_sha256;
  const core = Object.fromEntries(Object.entries(evidence).filter(([name]) => (
    name !== "evidence_payload_sha256" && name !== "audit_event_sha256"
  )));
  if (sha256(canonicalJson(core)) !== payloadDigest
    || acceptance.receipts.restore_evidence_payload_sha256 !== payloadDigest) {
    throw new Error("Operational restore evidence payload digest is invalid.");
  }
  return evidence;
}

function validateAuditSource(source, policy, evidence, acceptance) {
  if (!source.endsWith("\n") || source.includes("\r")) {
    throw new Error("Operational restore storage audit is truncated or noncanonical.");
  }
  const lines = source.slice(0, -1).split("\n");
  if (lines.length !== policy.required_audit_events.length || lines.some((line) => line.length === 0)) {
    throw new Error("Operational restore storage audit event count is invalid.");
  }
  let previousHash = null;
  let previousTimestamp = null;
  let activationId = null;
  const validatedEvents = [];
  const artifactHashes = [
    evidence.snapshot_encrypted_sha256,
    evidence.privacy_ledger_encrypted_sha256,
    evidence.evidence_payload_sha256,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const event = parseCanonicalJson(`${lines[index]}\n`, `Storage audit event ${index + 1}`,
      (value) => `${canonicalJson(value)}\n`);
    exactKeys(event, [
      "schema_version", "sequence", "event_id", "activation_id", "event_type", "artifact_sha256",
      "previous_event_sha256", "event_at", "operator_role", "event_sha256",
    ], `Storage audit event ${index + 1}`);
    const expected = policy.required_audit_events[index];
    if (event.schema_version !== policy.storage_audit_schema_version
      || event.sequence !== index + 1 || event.event_type !== expected.event_type
      || event.operator_role !== expected.operator_role || event.artifact_sha256 !== artifactHashes[index]) {
      throw new Error(`Storage audit event ${index + 1} contract is invalid.`);
    }
    assertIdentifier(event.event_id, `Storage audit event ${index + 1} ID`);
    assertIdentifier(event.activation_id, `Storage audit event ${index + 1} activation ID`);
    assertSha256(event.artifact_sha256, `Storage audit event ${index + 1} artifact digest`);
    assertSha256(event.event_sha256, `Storage audit event ${index + 1} digest`);
    if (index === 0) activationId = event.activation_id;
    if (event.activation_id !== activationId || event.activation_id !== evidence.activation_id
      || event.previous_event_sha256 !== previousHash) {
      throw new Error(`Storage audit event ${index + 1} chain identity is invalid.`);
    }
    const timestamp = parseTimestamp(event.event_at, `Storage audit event ${index + 1} time`);
    if (previousTimestamp !== null && timestamp <= previousTimestamp) {
      throw new Error("Operational restore storage audit chronology is invalid.");
    }
    const { event_sha256: eventDigest, ...unsigned } = event;
    if (sha256(canonicalJson(unsigned)) !== eventDigest) {
      throw new Error(`Storage audit event ${index + 1} hash is invalid.`);
    }
    previousHash = eventDigest;
    previousTimestamp = timestamp;
    validatedEvents.push(event);
  }
  if (previousHash !== evidence.audit_event_sha256
    || previousHash !== acceptance.receipts.storage_audit_head_sha256
    || new Date(previousTimestamp).toISOString() !== acceptance.drill_completed_at) {
    throw new Error("Operational restore storage audit head is invalid.");
  }
  return validatedEvents;
}

function validateReview(
  review,
  policy,
  acceptance,
  evidence,
  auditEvents,
  packetDigests,
  drillCompletedAt,
  now,
) {
  exactKeys(review, [
    "schema_version", "review_id", "packet_source_commit", "packet_acceptance_sha256",
    "packet_restore_evidence_sha256", "packet_storage_audit_sha256", "reviewed_at",
    "reviewer_role", "reviewer_was_not_drill_operator", "review_checklist",
    "review_evidence_sha256",
  ], "Operational restore independent review", { preserveOrder: true });
  if (review.schema_version !== policy.review_schema_version
    || !UUID_V4_PATTERN.test(review.review_id ?? "")
    || review.packet_source_commit !== acceptance.source_commit
    || review.reviewer_role !== "independent_reviewer"
    || review.reviewer_was_not_drill_operator !== true) {
    throw new Error("Operational restore independent review identity or separation attestation is invalid.");
  }
  for (const [field, expected] of Object.entries({
    packet_acceptance_sha256: packetDigests.acceptance,
    packet_restore_evidence_sha256: packetDigests.evidence,
    packet_storage_audit_sha256: packetDigests.audit,
  })) {
    if (review[field] !== expected) throw new Error(`Operational restore review ${field} is invalid.`);
  }
  exactKeys(review.review_checklist, policy.required_review_checks,
    "Operational restore independent review checklist", { preserveOrder: true });
  for (const name of policy.required_review_checks) {
    assertExactBoolean(review.review_checklist[name], true, `Operational restore review ${name}`);
  }
  assertSha256(review.review_evidence_sha256, "Operational restore independent review evidence digest");
  const packetHashes = new Set([packetDigests.acceptance, packetDigests.evidence, packetDigests.audit]);
  function collectHashes(value) {
    if (typeof value === "string" && SHA256_PATTERN.test(value)) packetHashes.add(value);
    else if (Array.isArray(value)) value.forEach(collectHashes);
    else if (value && typeof value === "object") Object.values(value).forEach(collectHashes);
  }
  collectHashes(acceptance);
  collectHashes(evidence);
  collectHashes(auditEvents);
  if (packetHashes.has(review.review_evidence_sha256)) {
    throw new Error("Independent review evidence must be distinct from every packet digest.");
  }
  const reviewedAt = parseTimestamp(review.reviewed_at, "Operational restore independent review time");
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMilliseconds)) throw new Error("Operational restore review evaluation time is invalid.");
  const maximumDelay = policy.limits.maximum_review_delay_hours * 60 * 60 * 1000;
  const futureSkew = policy.limits.maximum_future_skew_minutes * 60 * 1000;
  if (reviewedAt <= drillCompletedAt || reviewedAt - drillCompletedAt > maximumDelay
    || reviewedAt > nowMilliseconds + futureSkew) {
    throw new Error("Operational restore independent review time is outside the accepted window.");
  }
  return reviewedAt;
}

export function evaluateOperationalRestoreReview(
  { acceptanceSource, evidenceSource, auditSource, reviewSource },
  policy,
  { expectedSourceCommit, now = new Date() },
) {
  const lockedPolicy = validateOperationalRestoreReviewPolicy(policy);
  for (const [label, source] of Object.entries({
    "Operational restore acceptance": acceptanceSource,
    "Operational restore evidence": evidenceSource,
    "Operational restore audit": auditSource,
    "Operational restore independent review": reviewSource,
  })) {
    if (typeof source !== "string") throw new Error(`${label} source is invalid.`);
    assertNoCredentialMaterial(source, label);
  }
  const acceptance = parseCanonicalJson(acceptanceSource, "Operational restore acceptance",
    (value) => `${JSON.stringify(value)}\n`);
  const evidence = parseCanonicalJson(evidenceSource, "Operational restore evidence",
    (value) => `${canonicalJson(value)}\n`);
  const review = parseCanonicalJson(reviewSource, "Operational restore independent review", stableJson);
  const prohibitedEvidenceFields = new Set(lockedPolicy.prohibited_evidence_fields);
  assertNoFields(acceptance, prohibitedEvidenceFields, "Operational restore acceptance");
  assertNoFields(evidence, prohibitedEvidenceFields, "Operational restore evidence");
  const drillCompletedAt = validateAcceptance(acceptance, lockedPolicy, expectedSourceCommit);
  validateRestoreEvidence(evidence, lockedPolicy, acceptance);
  const packetDigests = {
    acceptance: sha256(acceptanceSource),
    evidence: sha256(evidenceSource),
    audit: sha256(auditSource),
  };
  if (packetDigests.evidence !== acceptance.receipts.restore_evidence_sha256
    || packetDigests.audit !== acceptance.receipts.storage_audit_sha256) {
    throw new Error("Operational restore packet file digests do not match the acceptance record.");
  }
  const auditEvents = validateAuditSource(auditSource, lockedPolicy, evidence, acceptance);
  const reviewedAt = validateReview(
    review,
    lockedPolicy,
    acceptance,
    evidence,
    auditEvents,
    packetDigests,
    drillCompletedAt,
    now,
  );
  const receipt = {
    schema_version: lockedPolicy.receipt_schema_version,
    packet_scope: lockedPolicy.packet_scope,
    source_commit: acceptance.source_commit,
    packet_acceptance_sha256: packetDigests.acceptance,
    reviewed_at: new Date(reviewedAt).toISOString(),
    reviewer_role: "independent_reviewer",
    independent_review_record_accepted: true,
    separation_attested: true,
    verified_acceptance_checks: [...lockedPolicy.required_acceptance_checks],
    verified_review_checks: [...lockedPolicy.required_review_checks],
    production_key_custody_approved: false,
    production_provider_evidence_verified: false,
    production_restore_gate_passed: false,
    production_release_authorized: false,
    remaining_approvals: [...lockedPolicy.remaining_approvals_after_review],
  };
  assertNoFields(receipt, new Set(lockedPolicy.prohibited_public_receipt_fields),
    "Operational restore public receipt");
  return receipt;
}

function isOutside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}

function assertOutsideRepositories(repositoryRoots, candidate, label) {
  if (repositoryRoots.some((root) => !isOutside(root, candidate))) {
    throw new Error(`${label} must be stored outside every repository checkout.`);
  }
}

async function safeReadPrivateFile(path, {
  label,
  maximumBytes,
  repositoryRoots,
}) {
  if (!isAbsolute(path ?? "")) throw new Error(`${label} path must be absolute.`);
  const requestedPath = resolve(path);
  const before = await lstat(requestedPath).catch(() => null);
  if (!before || before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be an existing regular file, not a symbolic link.`);
  }
  const realPathBefore = await realpath(requestedPath);
  assertOutsideRepositories(repositoryRoots, realPathBefore, label);
  let handle;
  try {
    handle = await open(requestedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${label} could not be opened safely.`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino
      || metadata.nlink !== 1 || metadata.size < 2 || metadata.size > maximumBytes
      || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw new Error(`${label} ownership, permissions, link count, or size is invalid.`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(requestedPath).catch(() => null);
    if (!after || after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino
      || await realpath(requestedPath) !== realPathBefore) {
      throw new Error(`${label} changed while it was being read.`);
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} must be valid UTF-8.`);
    }
    return { source, path: realPathBefore, size: bytes.length };
  } finally {
    await handle.close();
  }
}

async function readPrivatePacket(packetDirectory, policy, repositoryRoots) {
  if (!isAbsolute(packetDirectory ?? "")) {
    throw new Error("Operational restore packet directory must be an absolute path.");
  }
  const requestedDirectory = resolve(packetDirectory);
  const before = await lstat(requestedDirectory).catch(() => null);
  if (!before || before.isSymbolicLink() || !before.isDirectory()
    || (before.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    throw new Error("Operational restore packet directory ownership or permissions are invalid.");
  }
  const realDirectoryBefore = await realpath(requestedDirectory);
  assertOutsideRepositories(repositoryRoots, realDirectoryBefore, "Operational restore packet directory");
  const entries = await readdir(requestedDirectory, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  if (entries.some((entry) => !entry.isFile())
    || JSON.stringify(names) !== JSON.stringify([...policy.required_packet_files].sort())) {
    throw new Error("Operational restore packet must contain exactly the three reviewed files.");
  }
  const files = {};
  let totalBytes = 0;
  for (const name of policy.required_packet_files) {
    files[name] = await safeReadPrivateFile(join(requestedDirectory, name), {
      label: `Operational restore packet ${name}`,
      maximumBytes: policy.limits.maximum_packet_bytes,
      repositoryRoots,
    });
    totalBytes += files[name].size;
  }
  const after = await lstat(requestedDirectory).catch(() => null);
  const namesAfter = (await readdir(requestedDirectory)).sort();
  if (!after || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
    || await realpath(requestedDirectory) !== realDirectoryBefore
    || JSON.stringify(namesAfter) !== JSON.stringify(names)
    || totalBytes > policy.limits.maximum_packet_bytes) {
    throw new Error("Operational restore packet directory changed or exceeds its total size limit.");
  }
  return { files, path: realDirectoryBefore };
}

export async function verifyOperationalRestoreIndependentReview({
  root = DEFAULT_ROOT,
  policyRoot = DEFAULT_ROOT,
  packetDirectory,
  reviewFile,
  expectedSourceCommit,
  now = new Date(),
}) {
  const repositoryRoot = await realpath(resolve(root));
  const policyRepositoryRoot = await realpath(resolve(policyRoot));
  const repositoryRoots = [...new Set([repositoryRoot, policyRepositoryRoot])];
  const policy = await loadOperationalRestoreReviewPolicy(policyRepositoryRoot);
  await verifyOperationalRestoreReviewContract(policyRepositoryRoot);
  const packet = await readPrivatePacket(packetDirectory, policy, repositoryRoots);
  const review = await safeReadPrivateFile(reviewFile, {
    label: "Operational restore independent review file",
    maximumBytes: policy.limits.maximum_review_bytes,
    repositoryRoots,
  });
  if (!isOutside(packet.path, review.path)) {
    throw new Error("Independent review file must be stored outside the immutable packet directory.");
  }
  return evaluateOperationalRestoreReview({
    acceptanceSource: packet.files["acceptance-record.json"].source,
    evidenceSource: packet.files["operational-restore-evidence.json"].source,
    auditSource: packet.files["storage-audit.ndjson"].source,
    reviewSource: review.source,
  }, policy, { expectedSourceCommit, now });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}.`);
    const name = argument.slice(2);
    if (values.has(name)) throw new Error(`Duplicate argument ${argument}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

function exactArguments(values, expected) {
  const actual = [...values.keys()].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Expected exactly ${wanted.map((name) => `--${name}`).join(", ")}.`);
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "verify-policy") {
    if (argv.length !== 0) throw new Error("verify-policy accepts no arguments.");
    await loadOperationalRestoreReviewPolicy(DEFAULT_ROOT);
    await verifyOperationalRestoreReviewContract(DEFAULT_ROOT);
    process.stdout.write(`${JSON.stringify({
      policySha256: LOCKED_POLICY_SHA256,
      contractSha256: LOCKED_CONTRACT_SHA256,
      packetScope: "synthetic-production-shaped-non-production",
      productionAuthority: false,
    })}\n`);
    return;
  }
  if (command !== "evaluate") {
    throw new Error("Usage: verify-operational-restore-review.mjs verify-policy | evaluate --packet-directory ABSOLUTE_PATH --review-file ABSOLUTE_PATH --expected-source-commit SHA");
  }
  const values = parseArguments(argv);
  exactArguments(values, ["packet-directory", "review-file", "expected-source-commit"]);
  const receipt = await verifyOperationalRestoreIndependentReview({
    packetDirectory: values.get("packet-directory"),
    reviewFile: values.get("review-file"),
    expectedSourceCommit: values.get("expected-source-commit"),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
