#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { verifyReleaseCheckout } from "./verify-release-checkout.mjs";

export const PRIVACY_RIGHTS_POLICY_VERSION = "castingcompass.privacy-rights-policy/1.0.0";
export const PRIVACY_RIGHTS_CASE_VERSION = "castingcompass.privacy-rights-case/1.0.0";
export const PRIVACY_RIGHTS_DECISION_VERSION = "castingcompass.privacy-rights-decision/1.0.0";
export const PRIVACY_RIGHTS_DRILL_RECEIPT_VERSION =
  "castingcompass.privacy-rights-drill-receipt/1.0.0";

const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_CASE_BYTES = 256 * 1024;
const DAY_MILLISECONDS = 86_400_000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY_PATH = join(ROOT, "privacy", "rights-policy.json");
const DEFAULT_SCHEMA_PATH = join(ROOT, "contracts", "privacy-rights-case.schema.json");
const TERMINAL_STATUSES = new Set(["closed", "refused", "withdrawn"]);
const RESPONSE_RIGHTS = new Set([
  "access",
  "portability",
  "correction",
  "erasure",
  "restriction",
  "objection",
  "appeal",
  "opt-out-sale-sharing",
  "limit-sensitive-use",
]);
const COMPLETED_SYSTEM_RESULTS = new Set([
  "checked-not-found",
  "checked-found-and-acted",
  "retention-documented",
]);
const COMPLETED_PROCESSOR_RESULTS = new Set([
  "not-applicable",
  "confirmed",
  "retention-documented",
]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Unsupported canonical JSON value");
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unexpected fields`);
  }
}

function exactStringArray(value, expected, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  if (value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new Error(`${name} disagrees with the locked inventory`);
  }
}

function parseJsonFile(path, name, maximumBytes = MAX_CASE_BYTES) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${name} must be a bounded regular file`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return null;
    return parsed;
  } catch {
    return null;
  }
}

function addCalendarMonths(date, months) {
  const targetMonth = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

function addBusinessDays(date, days) {
  const result = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result;
}

function addClock(date, kind, value) {
  if (kind === "calendar-days") return new Date(date.getTime() + (value * DAY_MILLISECONDS));
  if (kind === "business-days") return addBusinessDays(date, value);
  if (kind === "calendar-months") return addCalendarMonths(date, value);
  if (kind === "none" && value === 0) return new Date(date);
  throw new Error("Policy clock is invalid");
}

function ensureNoForbiddenFields(value, forbidden, errors, path = "case") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => ensureNoForbiddenFields(item, forbidden, errors, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.has(key)) errors.add("forbidden-case-field");
    ensureNoForbiddenFields(nested, forbidden, errors, `${path}.${key}`);
  }
}

function setEquality(values, expected) {
  return values.length === expected.length
    && new Set(values).size === values.length
    && values.every((value) => expected.includes(value));
}

function safeDecision({ policySha256, accepted, errors, productionGates }) {
  const productionBlockers = Object.entries(productionGates)
    .filter(([, complete]) => complete !== true)
    .map(([gate]) => `production-gate:${gate}`)
    .sort();
  return {
    schema_version: PRIVACY_RIGHTS_DECISION_VERSION,
    policy_sha256: policySha256,
    case_contract_valid: accepted,
    semantic_evaluation_passed: accepted && errors.size === 0,
    production_ready: accepted && errors.size === 0 && productionBlockers.length === 0,
    gap_codes: [...errors].sort(),
    production_blockers: productionBlockers,
  };
}

export function validatePolicy(policy) {
  exactKeys(policy, [
    "schema_version",
    "policy_id",
    "policy_version",
    "case_contract_version",
    "decision_contract_version",
    "drill_receipt_contract_version",
    "current_deletion_semantics",
    "internal_service_level",
    "reviewed_clock_references",
    "required_systems",
    "processor_inventory",
    "forbidden_case_fields",
    "production_gates",
  ], "Privacy-rights policy");
  if (policy.schema_version !== PRIVACY_RIGHTS_POLICY_VERSION
    || policy.case_contract_version !== PRIVACY_RIGHTS_CASE_VERSION
    || policy.decision_contract_version !== PRIVACY_RIGHTS_DECISION_VERSION
    || policy.drill_receipt_contract_version !== PRIVACY_RIGHTS_DRILL_RECEIPT_VERSION
    || policy.policy_id !== "castingcompass-privacy-rights-v1"
    || policy.policy_version !== "1.0.0") {
    throw new Error("Privacy-rights policy identity is invalid");
  }
  exactKeys(policy.current_deletion_semantics, [
    "active_account_removal",
    "recovery_window_authorized",
    "deletion_receipt_is_recovery_credential",
    "completed_tombstone_retention_days",
    "operational_backup_retention_candidate_days",
  ], "Deletion semantics");
  if (policy.current_deletion_semantics.active_account_removal !== "immediate-and-nonrecoverable"
    || policy.current_deletion_semantics.recovery_window_authorized !== false
    || policy.current_deletion_semantics.deletion_receipt_is_recovery_credential !== false
    || policy.current_deletion_semantics.completed_tombstone_retention_days !== 90
    || policy.current_deletion_semantics.operational_backup_retention_candidate_days !== 89) {
    throw new Error("Current deletion promises were weakened");
  }
  exactKeys(policy.internal_service_level, [
    "response_target_calendar_days",
    "law_applicability_must_not_be_inferred",
    "ordinary_self_service_must_not_be_delayed",
  ], "Internal service level");
  if (policy.internal_service_level.response_target_calendar_days !== 28
    || policy.internal_service_level.law_applicability_must_not_be_inferred !== true
    || policy.internal_service_level.ordinary_self_service_must_not_be_delayed !== true) {
    throw new Error("Internal service-level safeguards are invalid");
  }
  const systems = [
    "active-d1", "deletion-ledger", "private-r2", "browser-state",
    "validation-artifacts", "operational-logs", "encrypted-backups", "processors",
  ];
  const processors = ["cloudflare", "resend", "xiaomi-mimo", "hibp", "turnstile"];
  exactStringArray(policy.required_systems, systems, "Required system inventory");
  exactStringArray(policy.processor_inventory, processors, "Processor inventory");
  if (!Array.isArray(policy.forbidden_case_fields)
    || policy.forbidden_case_fields.length < 20
    || new Set(policy.forbidden_case_fields).size !== policy.forbidden_case_fields.length
    || !policy.forbidden_case_fields.every((field) => /^[a-z][a-z0-9_]{1,50}$/u.test(field))) {
    throw new Error("Forbidden case-field inventory is invalid");
  }
  exactKeys(policy.production_gates, [
    "privacy_counsel_approval",
    "processor_retention_review",
    "provider_case_system_activated",
    "production_shaped_drill_witnessed",
    "independent_review_accepted",
  ], "Production gates");
  if (!Object.values(policy.production_gates).every((value) => typeof value === "boolean")) {
    throw new Error("Production gates must be explicit booleans");
  }
  const expectedRules = [
    "eu-gdpr-articles-15-through-22",
    "uk-gdpr-subject-access",
    "california-know-delete-correct",
    "california-opt-out-limit",
  ];
  if (!Array.isArray(policy.reviewed_clock_references)
    || policy.reviewed_clock_references.length !== expectedRules.length) {
    throw new Error("Reviewed clock inventory is incomplete");
  }
  policy.reviewed_clock_references.forEach((clock, index) => {
    exactKeys(clock, [
      "rule", "acknowledgement_business_days", "response_kind", "response_value",
      "maximum_extension_kind", "maximum_extension_value", "source_url",
    ], "Reviewed clock");
    if (clock.rule !== expectedRules[index]
      || !["calendar-days", "business-days", "calendar-months"].includes(clock.response_kind)
      || !Number.isInteger(clock.response_value)
      || clock.response_value < 1
      || !["none", "calendar-days", "calendar-months"].includes(clock.maximum_extension_kind)
      || !Number.isInteger(clock.maximum_extension_value)
      || clock.maximum_extension_value < 0
      || typeof clock.source_url !== "string"
      || !clock.source_url.startsWith("https://")) {
      throw new Error("Reviewed clock reference is invalid");
    }
  });
  return policy;
}

export function loadPrivacyRightsPolicy(path = DEFAULT_POLICY_PATH) {
  return validatePolicy(parseJsonFile(resolve(path), "Privacy-rights policy"));
}

export function policySha256(policy) {
  validatePolicy(policy);
  return sha256(canonicalJson(policy));
}

export function compileCaseValidator(schemaPath = DEFAULT_SCHEMA_PATH) {
  const schema = parseJsonFile(resolve(schemaPath), "Privacy-rights case schema");
  if (schema.$id !== PRIVACY_RIGHTS_CASE_VERSION) throw new Error("Privacy case schema identity is invalid");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function evaluatePrivacyRightsCase(caseRecord, {
  policy = loadPrivacyRightsPolicy(),
  validator = compileCaseValidator(),
  evaluatedAt = null,
} = {}) {
  const policyHash = policySha256(policy);
  const errors = new Set();
  const schemaAccepted = validator(caseRecord) === true;
  if (!schemaAccepted) {
    errors.add("case-schema-invalid");
    return safeDecision({
      policySha256: policyHash,
      accepted: false,
      errors,
      productionGates: policy.production_gates,
    });
  }

  ensureNoForbiddenFields(caseRecord, new Set(policy.forbidden_case_fields), errors);
  const evaluated = evaluatedAt === null ? null : canonicalTimestamp(evaluatedAt);
  if (evaluatedAt !== null && evaluated === null) errors.add("evaluation-timestamp-invalid");
  const timestampInputs = Object.fromEntries([
    "received_at", "acknowledged_at", "responded_at", "closed_at",
  ].map((field) => [field, caseRecord[field]]));
  timestampInputs.identity_completed_at = caseRecord.identity.completed_at;
  timestampInputs.delivered_at = caseRecord.delivery.delivered_at;
  timestampInputs.deletion_completed_at = caseRecord.disposition.deletion_completed_at;
  timestampInputs.extension_notified_at = caseRecord.extension.notified_at;
  timestampInputs.extended_due_at = caseRecord.extension.extended_due_at;
  const timestamps = Object.fromEntries(Object.entries(timestampInputs).map(([field, value]) => [
    field,
    value === null ? null : canonicalTimestamp(value),
  ]));
  if (Object.entries(timestampInputs).some(([field, value]) => (
    value !== null && timestamps[field] === null
  ))) {
    errors.add("timestamp-invalid");
  }

  const received = timestamps.received_at;
  if (received) {
    for (const name of [
      "acknowledged_at", "identity_completed_at", "delivered_at", "deletion_completed_at",
      "responded_at", "closed_at", "extension_notified_at", "extended_due_at",
    ]) {
      const value = timestamps[name];
      if (value && value < received) errors.add("timestamp-before-receipt");
    }
    const ordered = [
      timestamps.acknowledged_at,
      timestamps.identity_completed_at,
      timestamps.responded_at,
      timestamps.closed_at,
    ].filter(Boolean);
    if (ordered.some((value, index) => index > 0 && value < ordered[index - 1])) {
      errors.add("case-timestamp-order-invalid");
    }
    const internalDue = addClock(
      received,
      "calendar-days",
      policy.internal_service_level.response_target_calendar_days,
    );
    if (timestamps.responded_at && timestamps.responded_at > internalDue) {
      errors.add("internal-response-target-missed");
    } else if (!timestamps.responded_at && evaluated && evaluated > internalDue) {
      errors.add("internal-response-target-overdue");
    }
  }

  if (caseRecord.identity.status === "pending") {
    if (caseRecord.identity.method !== "not-completed" || timestamps.identity_completed_at) {
      errors.add("identity-state-invalid");
    }
  } else if (caseRecord.identity.method === "not-completed" || !timestamps.identity_completed_at) {
    errors.add("identity-state-invalid");
  }

  const systemNames = caseRecord.systems.map((entry) => entry.system);
  const processorNames = caseRecord.processors.map((entry) => entry.processor);
  if (!setEquality(systemNames, policy.required_systems)) errors.add("system-inventory-incomplete");
  if (!setEquality(processorNames, policy.processor_inventory)) errors.add("processor-inventory-incomplete");

  const clock = policy.reviewed_clock_references.find((entry) => entry.rule === caseRecord.applied_clock);
  if (caseRecord.applied_clock === "unassessed") {
    if (caseRecord.review.legal_clock_review_completed) errors.add("unassessed-clock-marked-reviewed");
    if (caseRecord.extension.status !== "none") errors.add("extension-without-applied-clock");
  } else if (!clock || !caseRecord.review.legal_clock_review_completed) {
    errors.add("applied-clock-without-legal-review");
  } else if (received) {
    const baseDue = addClock(received, clock.response_kind, clock.response_value);
    let responseDue = baseDue;
    if (clock.acknowledgement_business_days !== null && timestamps.acknowledged_at) {
      const acknowledgementDue = addBusinessDays(received, clock.acknowledgement_business_days);
      if (timestamps.acknowledged_at > acknowledgementDue) errors.add("reviewed-acknowledgement-clock-missed");
    }
    if (caseRecord.extension.status === "approved") {
      if (!timestamps.extension_notified_at || !timestamps.extended_due_at
        || caseRecord.extension.reason_code === "none") {
        errors.add("extension-record-incomplete");
      } else {
        const maximumDue = addClock(baseDue, clock.maximum_extension_kind, clock.maximum_extension_value);
        if (clock.maximum_extension_kind === "none" || timestamps.extended_due_at > maximumDue) {
          errors.add("extension-exceeds-reviewed-reference");
        }
        if (timestamps.extension_notified_at > baseDue) errors.add("extension-notice-late");
        responseDue = timestamps.extended_due_at;
      }
    } else if (timestamps.extension_notified_at || timestamps.extended_due_at
      || caseRecord.extension.reason_code !== "none") {
      errors.add("extension-state-invalid");
    }
    if (timestamps.responded_at && timestamps.responded_at > responseDue) {
      errors.add("reviewed-response-clock-missed");
    } else if (!timestamps.responded_at && evaluated && evaluated > responseDue) {
      errors.add("reviewed-response-clock-overdue");
    }
  }

  const terminal = TERMINAL_STATUSES.has(caseRecord.status);
  if (terminal !== Boolean(timestamps.closed_at)) errors.add("terminal-status-closure-invalid");
  if (terminal && (!timestamps.acknowledged_at || !timestamps.responded_at)) {
    errors.add("terminal-case-missing-response-timestamps");
  }
  if (caseRecord.status === "closed") {
    if (!["completed", "partially-completed"].includes(caseRecord.disposition.outcome)) {
      errors.add("closed-disposition-invalid");
    }
    if (caseRecord.identity.status !== "verified") errors.add("closed-without-verified-identity");
    if (!caseRecord.review.privacy_case_review_completed
      || !caseRecord.review.second_person_review_completed) {
      errors.add("closed-without-required-review");
    }
    if (!caseRecord.systems.every((entry) => COMPLETED_SYSTEM_RESULTS.has(entry.result))) {
      errors.add("closed-with-unresolved-system");
    }
    if (!caseRecord.processors.every((entry) => COMPLETED_PROCESSOR_RESULTS.has(entry.result))) {
      errors.add("closed-with-unresolved-processor");
    }
    if (!Object.values(caseRecord.safety_checks).every((value) => value === true)) {
      errors.add("closed-with-failed-safety-check");
    }
    if (!["delivered", "channel-exhausted"].includes(caseRecord.delivery.status)) {
      errors.add("closed-without-response-delivery");
    }
    if (!caseRecord.disposition.challenge_information_provided) {
      errors.add("closed-without-challenge-information");
    }
    if (timestamps.closed_at && [timestamps.delivered_at, timestamps.deletion_completed_at]
      .some((value) => value && value > timestamps.closed_at)) {
      errors.add("closed-before-case-actions-completed");
    }
    if (timestamps.responded_at && [timestamps.delivered_at, timestamps.deletion_completed_at]
      .some((value) => value && value > timestamps.responded_at)) {
      errors.add("response-recorded-before-case-actions-completed");
    }
  }
  if (caseRecord.status === "refused") {
    if (caseRecord.disposition.outcome !== "refused"
      || caseRecord.disposition.reason_code === "none"
      || !caseRecord.review.legal_clock_review_completed
      || !caseRecord.disposition.challenge_information_provided
      || !caseRecord.disposition.legal_exception_recorded) {
      errors.add("refusal-record-incomplete");
    }
  }
  if (caseRecord.status === "withdrawn"
    && (caseRecord.disposition.outcome !== "withdrawn"
      || caseRecord.disposition.reason_code !== "requester-withdrew")) {
    errors.add("withdrawal-record-incomplete");
  }

  if (caseRecord.delivery.status === "delivered") {
    if (!timestamps.delivered_at || caseRecord.delivery.channel === "none") {
      errors.add("delivery-record-incomplete");
    }
  } else if (timestamps.delivered_at || caseRecord.delivery.channel !== "none") {
    errors.add("delivery-state-invalid");
  }
  if (caseRecord.rights.some((right) => RESPONSE_RIGHTS.has(right))
    && terminal
    && !["delivered", "channel-exhausted"].includes(caseRecord.delivery.status)) {
    errors.add("terminal-case-without-response");
  }

  if (caseRecord.rights.includes("erasure")) {
    if (caseRecord.status === "closed"
      && (!timestamps.deletion_completed_at || caseRecord.disposition.object_task_pending_count !== 0)) {
      errors.add("erasure-closed-before-cleanup-complete");
    }
    if ((caseRecord.rights.includes("access") || caseRecord.rights.includes("portability"))
      && timestamps.deletion_completed_at
      && (!timestamps.delivered_at || timestamps.delivered_at > timestamps.deletion_completed_at)) {
      errors.add("export-not-delivered-before-erasure");
    }
  } else if (timestamps.deletion_completed_at) {
    errors.add("deletion-recorded-without-erasure-right");
  }
  if (caseRecord.disposition.reason_code === "legal-retention-exception"
    && (!caseRecord.disposition.legal_exception_recorded
      || !caseRecord.review.legal_clock_review_completed)) {
    errors.add("retention-exception-without-legal-review");
  } else if (caseRecord.disposition.reason_code !== "legal-retention-exception"
    && caseRecord.disposition.legal_exception_recorded) {
    errors.add("unjustified-legal-exception-record");
  }

  return safeDecision({
    policySha256: policyHash,
    accepted: true,
    errors,
    productionGates: policy.production_gates,
  });
}

export function syntheticPrivacyRightsCase({ sourceCommit, completedAt }) {
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) throw new Error("Source commit is invalid");
  const completed = canonicalTimestamp(completedAt);
  if (!completed) throw new Error("Completion time must be a canonical UTC timestamp");
  const at = (millisecondsBefore) => new Date(completed.getTime() - millisecondsBefore).toISOString();
  const systems = [
    "active-d1", "deletion-ledger", "private-r2", "browser-state",
    "validation-artifacts", "operational-logs", "encrypted-backups", "processors",
  ].map((system, index) => ({
    system,
    result: index === 6 ? "retention-documented" : "checked-found-and-acted",
    record_count: index < 3 ? index + 1 : 0,
    action_count: index < 3 ? index + 1 : 0,
  }));
  const processors = ["cloudflare", "resend", "xiaomi-mimo", "hibp", "turnstile"]
    .map((processor, index) => ({
      processor,
      result: index === 0 ? "retention-documented" : "not-applicable",
      action_count: index === 0 ? 1 : 0,
    }));
  return {
    schema_version: PRIVACY_RIGHTS_CASE_VERSION,
    case_id: "prc_00000000000000000000000000000000",
    synthetic: true,
    source_commit: sourceCommit,
    received_at: at(2_400_000),
    acknowledged_at: at(2_100_000),
    responded_at: at(300_000),
    closed_at: completed.toISOString(),
    channel: "authenticated-self-service",
    jurisdiction_volunteered: "not-volunteered",
    rights: ["access", "portability", "erasure"],
    applied_clock: "unassessed",
    extension: {
      status: "none",
      notified_at: null,
      reason_code: "none",
      extended_due_at: null,
    },
    identity: {
      status: "verified",
      method: "authenticated-session-and-reauthentication",
      completed_at: at(1_800_000),
    },
    status: "closed",
    systems,
    processors,
    delivery: {
      status: "delivered",
      channel: "authenticated-response",
      delivered_at: at(1_200_000),
      export_section_count: 7,
    },
    disposition: {
      outcome: "completed",
      reason_code: "none",
      active_row_count: 12,
      object_task_completed_count: 2,
      object_task_pending_count: 0,
      retained_category_count: 2,
      deletion_completed_at: at(600_000),
      challenge_information_provided: true,
      legal_exception_recorded: false,
    },
    safety_checks: {
      cross_account_data_absent: true,
      secrets_absent: true,
      internal_locators_absent: true,
      deleted_content_absent: true,
      raw_identifiers_absent: true,
      restore_suppression_verified: true,
    },
    review: {
      legal_clock_review_completed: false,
      privacy_case_review_completed: true,
      second_person_review_completed: true,
    },
  };
}

function privateOutputDirectory(path) {
  const output = resolve(path);
  if (output === ROOT || output.startsWith(`${ROOT}/`)) {
    throw new Error("Drill evidence must stay outside the repository");
  }
  const parent = lstatSync(dirname(output));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Output parent is invalid");
  if (existsSync(output)) throw new Error("Output directory already exists");
  mkdirSync(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  if ((lstatSync(output).mode & 0o077) !== 0) throw new Error("Output directory is not private");
  return output;
}

export async function runSyntheticPrivacyRightsDrill({
  outputDirectory,
  sourceCommit,
  completedAt = new Date().toISOString(),
  policy = loadPrivacyRightsPolicy(),
  validator = compileCaseValidator(),
  checkoutVerifier = verifyReleaseCheckout,
}) {
  const checkout = await checkoutVerifier({ expectedCommit: sourceCommit });
  if (checkout?.head !== sourceCommit || checkout?.expectedCommit !== sourceCommit
    || checkout?.clean !== true) {
    throw new Error("Synthetic privacy-rights drill requires the exact clean source checkout");
  }
  const caseRecord = syntheticPrivacyRightsCase({ sourceCommit, completedAt });
  const decision = evaluatePrivacyRightsCase(caseRecord, { policy, validator, evaluatedAt: completedAt });
  if (!decision.case_contract_valid || !decision.semantic_evaluation_passed) {
    throw new Error("Synthetic privacy-rights drill did not pass local controls");
  }
  if (decision.production_ready || decision.production_blockers.length === 0) {
    throw new Error("Synthetic drill unexpectedly authorized production");
  }
  const output = privateOutputDirectory(outputDirectory);
  try {
    const core = {
      schema_version: PRIVACY_RIGHTS_DRILL_RECEIPT_VERSION,
      policy_sha256: decision.policy_sha256,
      source_commit: sourceCommit,
      completed_at: completedAt,
      synthetic: true,
      case_contract_valid: true,
      semantic_evaluation_passed: true,
      source_checkout_verified_clean: true,
      raw_identifiers_recorded: false,
      request_or_response_content_recorded: false,
      systems_checked_count: caseRecord.systems.length,
      processors_checked_count: caseRecord.processors.length,
      rights_exercised_count: caseRecord.rights.length,
      production_ready: false,
      production_blockers: decision.production_blockers,
    };
    const receipt = {
      ...core,
      receipt_sha256: sha256(canonicalJson(core)),
    };
    const path = join(output, "privacy-rights-drill-receipt.json");
    writeFileSync(path, `${canonicalJson(receipt)}\n`, { flag: "wx", mode: 0o600 });
    if ((lstatSync(path).mode & 0o077) !== 0) throw new Error("Drill receipt is not private");
    return { receipt, path };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function assertPrivateCaseFile(path) {
  const resolved = resolve(path);
  if (resolved === ROOT || resolved.startsWith(`${ROOT}/`)) {
    throw new Error("A real privacy case must stay outside the repository");
  }
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0
    || metadata.size <= 0 || metadata.size > MAX_CASE_BYTES) {
    throw new Error("Privacy case must be a bounded private regular file");
  }
  return resolved;
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Command arguments are invalid");
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) throw new Error("Duplicate command argument");
    options[name] = value;
  }
  return { command, options };
}

function writeSafeStdout(value) {
  process.stdout.write(`${canonicalJson(value)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  const policy = loadPrivacyRightsPolicy();
  if (command === "verify-policy") {
    if (Object.keys(options).length !== 0) throw new Error("verify-policy does not accept options");
    const decision = safeDecision({
      policySha256: policySha256(policy),
      accepted: true,
      errors: new Set(),
      productionGates: policy.production_gates,
    });
    writeSafeStdout({
      schema_version: PRIVACY_RIGHTS_DECISION_VERSION,
      policy_sha256: decision.policy_sha256,
      policy_valid: true,
      production_ready: false,
      production_blockers: decision.production_blockers,
    });
    return;
  }
  if (command === "evaluate") {
    if (Object.keys(options).length !== 1 || typeof options.case !== "string") {
      throw new Error("evaluate requires only --case");
    }
    const caseRecord = parseJsonFile(assertPrivateCaseFile(options.case), "Privacy case");
    writeSafeStdout(evaluatePrivacyRightsCase(caseRecord, {
      policy,
      evaluatedAt: new Date().toISOString(),
    }));
    return;
  }
  if (command === "drill") {
    const keys = Object.keys(options).sort();
    if (keys.length !== 2 || keys[0] !== "output-dir" || keys[1] !== "source-commit") {
      throw new Error("drill requires --output-dir and --source-commit");
    }
    const { receipt } = await runSyntheticPrivacyRightsDrill({
      outputDirectory: options["output-dir"],
      sourceCommit: options["source-commit"],
    });
    writeSafeStdout(receipt);
    return;
  }
  throw new Error("Expected verify-policy, evaluate, or drill");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main().catch(() => {
      process.stderr.write("privacy-rights command failed: input or policy rejected\n");
      process.exitCode = 1;
    });
  } catch {
    process.stderr.write("privacy-rights command failed: input or policy rejected\n");
    process.exitCode = 1;
  }
}
