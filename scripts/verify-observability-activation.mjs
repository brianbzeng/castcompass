#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const POLICY_SCHEMA_VERSION =
  "castingcompass.observability-activation-policy/1.0.0";
export const EVIDENCE_SCHEMA_VERSION =
  "castingcompass.observability-activation-evidence/1.0.0";
export const RECEIPT_SCHEMA_VERSION =
  "castingcompass.observability-activation-receipt/1.0.0";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = resolve(ROOT, "security", "observability-activation-policy.json");
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const REQUIRED_SAVED_VIEWS = [
  "CC — current failures",
  "CC — latency by route",
  "CC — rate-limit controls",
  "CC — privacy jobs",
  "CC — AI review",
  "CC — email delivery",
  "CC — one request",
  "CC — one session window",
  "CC — scheduled failures",
];
const REQUIRED_ALERT_DRILLS = [
  "sustained-5xx",
  "latency-regression",
  "scheduled-failure",
  "d1-error",
  "request-volume-anomaly",
];
const REQUIRED_UPTIME_CHECKS = [
  "canonical-health",
  "canonical-page",
  "alias-redirects",
];
const REQUIRED_RECONSTRUCTION_DRILLS = [
  "preview-request",
  "preview-queue",
  "preview-scheduled",
  "production-request",
  "production-queue",
  "production-scheduled",
];
const BLOCKER_CODES = [
  "access-evidence-missing",
  "alert-drill-evidence-missing",
  "dashboard-evidence-missing",
  "evidence-expired",
  "evidence-not-yet-valid",
  "log-hygiene-evidence-missing",
  "posthog-policy-violated",
  "pseudonym-key-evidence-missing",
  "reconstruction-evidence-missing",
  "release-binding-evidence-missing",
  "retention-cost-evidence-missing",
  "uptime-evidence-missing",
];
const RECEIPT_FIELDS = [
  "schema_version",
  "evaluated_at",
  "evidence_observed_at",
  "policy_id",
  "read_only",
  "provider_query_performed",
  "production_change_authorized",
  "checks",
  "activation_ready",
  "blockers",
];
const CHECK_FIELDS = [
  "access",
  "alerts",
  "dashboards",
  "evidence_fresh",
  "log_hygiene",
  "posthog_deferred",
  "pseudonym_key",
  "reconstruction",
  "release_binding",
  "retention_and_cost",
  "uptime",
];

export class ObservabilityActivationRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ObservabilityActivationRefusal";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new ObservabilityActivationRefusal(code, message);
}

function exactKeys(value, expected, label, code = "evidence-invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse(code, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    refuse(code, `${label} has unexpected fields`);
  }
}

function exactArray(value, expected, label, code = "policy-invalid") {
  if (!Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])) {
    refuse(code, `${label} disagrees with the locked policy`);
  }
}

function readJson(path, maximumBytes, label) {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    refuse("file-invalid", `${label} is empty or exceeds its byte limit`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse("file-invalid", `${label} is not valid JSON`);
  }
}

function boolean(value, label) {
  if (typeof value !== "boolean") refuse("evidence-invalid", `${label} must be boolean`);
  return value;
}

function digest(value, label) {
  if (!DIGEST_PATTERN.test(value ?? "")) {
    refuse("evidence-invalid", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function finiteNumber(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    refuse("evidence-invalid", `${label} is outside the locked range`);
  }
  return value;
}

function exactNamedEntries(entries, requiredNames, fields, label, predicate) {
  if (!Array.isArray(entries) || entries.length !== requiredNames.length) {
    refuse("evidence-invalid", `${label} must contain every required entry exactly once`);
  }
  const byName = new Map();
  for (const entry of entries) {
    exactKeys(entry, ["name", ...fields], `${label} entry`);
    if (typeof entry.name !== "string" || byName.has(entry.name)) {
      refuse("evidence-invalid", `${label} names must be unique strings`);
    }
    byName.set(entry.name, entry);
  }
  if (requiredNames.some((name) => !byName.has(name))
    || [...byName].some(([name]) => !requiredNames.includes(name))) {
    refuse("evidence-invalid", `${label} names disagree with the locked policy`);
  }
  return requiredNames.every((name) => predicate(byName.get(name)));
}

export function validatePolicy(policy) {
  exactKeys(policy, [
    "schema_version",
    "policy_id",
    "limits",
    "required_saved_views",
    "required_alert_drills",
    "required_uptime_checks",
    "required_reconstruction_drills",
    "blocker_codes",
    "public_receipt",
  ], "Observability activation policy", "policy-invalid");
  if (policy.schema_version !== POLICY_SCHEMA_VERSION
    || policy.policy_id !== "castingcompass-observability-activation-v1") {
    refuse("policy-invalid", "Observability activation policy identity is invalid");
  }
  exactKeys(policy.limits, [
    "maximum_evidence_bytes",
    "maximum_evidence_age_hours",
    "maximum_future_skew_minutes",
    "minimum_retention_days",
    "maximum_retention_days",
    "maximum_estimated_monthly_events",
    "maximum_monthly_cost_ceiling_usd",
  ], "Observability activation limits", "policy-invalid");
  const expectedLimits = {
    maximum_evidence_bytes: 262_144,
    maximum_evidence_age_hours: 72,
    maximum_future_skew_minutes: 5,
    minimum_retention_days: 1,
    maximum_retention_days: 30,
    maximum_estimated_monthly_events: 1_000_000_000,
    maximum_monthly_cost_ceiling_usd: 1_000_000,
  };
  for (const [name, value] of Object.entries(expectedLimits)) {
    if (policy.limits[name] !== value) {
      refuse("policy-invalid", `Observability activation limit ${name} was changed`);
    }
  }
  exactArray(policy.required_saved_views, REQUIRED_SAVED_VIEWS, "Saved-view policy");
  exactArray(policy.required_alert_drills, REQUIRED_ALERT_DRILLS, "Alert-drill policy");
  exactArray(policy.required_uptime_checks, REQUIRED_UPTIME_CHECKS, "Uptime-check policy");
  exactArray(policy.required_reconstruction_drills, REQUIRED_RECONSTRUCTION_DRILLS,
    "Reconstruction-drill policy");
  exactArray(policy.blocker_codes, BLOCKER_CODES, "Blocker policy");
  exactKeys(policy.public_receipt, [
    "schema_version", "allowed_top_level_fields", "allowed_check_fields",
  ], "Public receipt policy", "policy-invalid");
  if (policy.public_receipt.schema_version !== RECEIPT_SCHEMA_VERSION) {
    refuse("policy-invalid", "Public receipt schema identity is invalid");
  }
  exactArray(policy.public_receipt.allowed_top_level_fields, RECEIPT_FIELDS,
    "Public receipt field policy");
  exactArray(policy.public_receipt.allowed_check_fields, CHECK_FIELDS,
    "Public receipt check policy");
  return policy;
}

export function loadPolicy() {
  return validatePolicy(readJson(POLICY_PATH, 262_144, "Observability activation policy"));
}

function validateEvidence(evidence, policy) {
  exactKeys(evidence, [
    "schema_version",
    "observed_at",
    "evidence_packet_sha256",
    "release_binding",
    "log_hygiene",
    "dashboards",
    "access",
    "retention_and_cost",
    "alerts",
    "uptime",
    "reconstruction",
    "pseudonym_key",
    "posthog",
    "production_change_authorized",
  ], "Observability activation evidence");
  if (evidence.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    refuse("evidence-invalid", "Observability activation evidence identity is invalid");
  }
  const observedAt = new Date(evidence.observed_at);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== evidence.observed_at) {
    refuse("evidence-invalid", "Evidence observed_at must be a canonical UTC timestamp");
  }
  digest(evidence.evidence_packet_sha256, "Evidence packet digest");
  if (evidence.production_change_authorized !== false) {
    refuse("authorization-boundary-violated",
      "Observability evidence cannot authorize a production change");
  }

  exactKeys(evidence.release_binding, [
    "reviewed_commit",
    "preview_evidence_sha256",
    "production_evidence_sha256",
    "preview_matches_reviewed_commit",
    "production_matches_reviewed_commit",
  ], "Release-binding evidence");
  if (!COMMIT_PATTERN.test(evidence.release_binding.reviewed_commit ?? "")) {
    refuse("evidence-invalid", "Reviewed commit must be a full lowercase Git commit");
  }
  digest(evidence.release_binding.preview_evidence_sha256, "Preview release evidence digest");
  digest(evidence.release_binding.production_evidence_sha256,
    "Production release evidence digest");

  exactKeys(evidence.log_hygiene, [
    "preview_evidence_sha256",
    "production_evidence_sha256",
    "preview_structured_only",
    "production_structured_only",
    "preview_raw_invocation_absent",
    "production_raw_invocation_absent",
  ], "Log-hygiene evidence");
  digest(evidence.log_hygiene.preview_evidence_sha256, "Preview log evidence digest");
  digest(evidence.log_hygiene.production_evidence_sha256, "Production log evidence digest");

  exactKeys(evidence.dashboards, ["evidence_sha256", "saved_views"], "Dashboard evidence");
  digest(evidence.dashboards.evidence_sha256, "Dashboard evidence digest");
  if (!Array.isArray(evidence.dashboards.saved_views)
    || evidence.dashboards.saved_views.some((name) => typeof name !== "string")) {
    refuse("evidence-invalid", "Saved views must be strings");
  }

  exactKeys(evidence.access, [
    "evidence_sha256", "mfa_enforced", "least_privilege_role", "access_review_completed",
  ], "Access evidence");
  digest(evidence.access.evidence_sha256, "Access evidence digest");

  exactKeys(evidence.retention_and_cost, [
    "evidence_sha256",
    "plan_recorded",
    "retention_days",
    "sampling_percent",
    "estimated_daily_events",
    "estimated_monthly_events",
    "monthly_cost_ceiling_usd",
    "owner_assigned",
  ], "Retention and cost evidence");
  digest(evidence.retention_and_cost.evidence_sha256, "Retention and cost evidence digest");
  finiteNumber(evidence.retention_and_cost.retention_days,
    policy.limits.minimum_retention_days, policy.limits.maximum_retention_days,
    "Retention days");
  finiteNumber(evidence.retention_and_cost.sampling_percent, 0.01, 100, "Sampling percentage");
  finiteNumber(evidence.retention_and_cost.estimated_daily_events, 0,
    policy.limits.maximum_estimated_monthly_events, "Estimated daily events");
  finiteNumber(evidence.retention_and_cost.estimated_monthly_events, 0,
    policy.limits.maximum_estimated_monthly_events, "Estimated monthly events");
  finiteNumber(evidence.retention_and_cost.monthly_cost_ceiling_usd, 0,
    policy.limits.maximum_monthly_cost_ceiling_usd, "Monthly cost ceiling");

  exactKeys(evidence.alerts, ["evidence_sha256", "drills"], "Alert evidence");
  digest(evidence.alerts.evidence_sha256, "Alert evidence digest");
  exactKeys(evidence.uptime, ["evidence_sha256", "checks"], "Uptime evidence");
  digest(evidence.uptime.evidence_sha256, "Uptime evidence digest");
  exactKeys(evidence.reconstruction, ["evidence_sha256", "drills"],
    "Reconstruction evidence");
  digest(evidence.reconstruction.evidence_sha256, "Reconstruction evidence digest");

  exactKeys(evidence.pseudonym_key, [
    "evidence_sha256",
    "distinct_from_session_secret",
    "access_separated",
    "rotation_owner_assigned",
  ], "Pseudonym-key evidence");
  digest(evidence.pseudonym_key.evidence_sha256, "Pseudonym-key evidence digest");

  exactKeys(evidence.posthog, ["enabled", "separate_approval_recorded"], "PostHog evidence");
  return observedAt;
}

export function evaluateEvidence(evidence, policy = loadPolicy(), options = {}) {
  const lockedPolicy = validatePolicy(policy);
  const observedAt = validateEvidence(evidence, lockedPolicy);
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    refuse("evaluation-invalid", "Evaluation time is invalid");
  }
  const maximumAgeMs = lockedPolicy.limits.maximum_evidence_age_hours * 60 * 60 * 1000;
  const maximumFutureMs = lockedPolicy.limits.maximum_future_skew_minutes * 60 * 1000;
  const ageMs = now.getTime() - observedAt.getTime();
  const evidenceFresh = ageMs <= maximumAgeMs && ageMs >= -maximumFutureMs;

  const releaseBinding = boolean(evidence.release_binding.preview_matches_reviewed_commit,
    "Preview release binding")
    && boolean(evidence.release_binding.production_matches_reviewed_commit,
      "Production release binding");
  const logHygiene = [
    [evidence.log_hygiene.preview_structured_only, "Preview structured-only evidence"],
    [evidence.log_hygiene.production_structured_only, "Production structured-only evidence"],
    [evidence.log_hygiene.preview_raw_invocation_absent, "Preview raw-invocation evidence"],
    [evidence.log_hygiene.production_raw_invocation_absent,
      "Production raw-invocation evidence"],
  ].every(([value, label]) => boolean(value, label));
  const dashboardNames = new Set(evidence.dashboards.saved_views);
  const dashboards = dashboardNames.size === lockedPolicy.required_saved_views.length
    && lockedPolicy.required_saved_views.every((name) => dashboardNames.has(name));
  const access = [
    [evidence.access.mfa_enforced, "MFA evidence"],
    [evidence.access.least_privilege_role, "Least-privilege evidence"],
    [evidence.access.access_review_completed, "Access-review evidence"],
  ].every(([value, label]) => boolean(value, label));
  const retentionAndCost = [
    [evidence.retention_and_cost.plan_recorded, "Plan evidence"],
    [evidence.retention_and_cost.owner_assigned, "Cost owner evidence"],
  ].every(([value, label]) => boolean(value, label));
  const alerts = exactNamedEntries(evidence.alerts.drills,
    lockedPolicy.required_alert_drills,
    ["delivered", "acknowledged", "closed", "redaction_tested"],
    "Alert drills",
    (entry) => ["delivered", "acknowledged", "closed", "redaction_tested"]
      .every((field) => boolean(entry[field], `Alert ${entry.name} ${field}`)));
  const uptime = exactNamedEntries(evidence.uptime.checks,
    lockedPolicy.required_uptime_checks,
    ["configured", "delivered", "acknowledged"],
    "Uptime checks",
    (entry) => ["configured", "delivered", "acknowledged"]
      .every((field) => boolean(entry[field], `Uptime ${entry.name} ${field}`)));
  const reconstruction = exactNamedEntries(evidence.reconstruction.drills,
    lockedPolicy.required_reconstruction_drills,
    ["completed", "structured_only", "redaction_passed"],
    "Reconstruction drills",
    (entry) => ["completed", "structured_only", "redaction_passed"]
      .every((field) => boolean(entry[field], `Reconstruction ${entry.name} ${field}`)));
  const pseudonymKey = [
    [evidence.pseudonym_key.distinct_from_session_secret, "Pseudonym separation evidence"],
    [evidence.pseudonym_key.access_separated, "Pseudonym access evidence"],
    [evidence.pseudonym_key.rotation_owner_assigned, "Pseudonym rotation owner evidence"],
  ].every(([value, label]) => boolean(value, label));
  const posthogDeferred = boolean(evidence.posthog.enabled, "PostHog enabled evidence") === false
    && boolean(evidence.posthog.separate_approval_recorded,
      "PostHog approval evidence") === false;

  const checks = {
    access,
    alerts,
    dashboards,
    evidence_fresh: evidenceFresh,
    log_hygiene: logHygiene,
    posthog_deferred: posthogDeferred,
    pseudonym_key: pseudonymKey,
    reconstruction,
    release_binding: releaseBinding,
    retention_and_cost: retentionAndCost,
    uptime,
  };
  const blockers = [];
  if (!access) blockers.push("access-evidence-missing");
  if (!alerts) blockers.push("alert-drill-evidence-missing");
  if (!dashboards) blockers.push("dashboard-evidence-missing");
  if (ageMs > maximumAgeMs) blockers.push("evidence-expired");
  if (ageMs < -maximumFutureMs) blockers.push("evidence-not-yet-valid");
  if (!logHygiene) blockers.push("log-hygiene-evidence-missing");
  if (!posthogDeferred) blockers.push("posthog-policy-violated");
  if (!pseudonymKey) blockers.push("pseudonym-key-evidence-missing");
  if (!reconstruction) blockers.push("reconstruction-evidence-missing");
  if (!releaseBinding) blockers.push("release-binding-evidence-missing");
  if (!retentionAndCost) blockers.push("retention-cost-evidence-missing");
  if (!uptime) blockers.push("uptime-evidence-missing");

  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    evaluated_at: now.toISOString(),
    evidence_observed_at: observedAt.toISOString(),
    policy_id: lockedPolicy.policy_id,
    read_only: true,
    provider_query_performed: false,
    production_change_authorized: false,
    checks,
    activation_ready: blockers.length === 0,
    blockers,
  };
  return assertPublicReceipt(receipt, lockedPolicy);
}

export function assertPublicReceipt(receipt, policy = loadPolicy()) {
  const lockedPolicy = validatePolicy(policy);
  exactKeys(receipt, lockedPolicy.public_receipt.allowed_top_level_fields,
    "Observability activation receipt", "receipt-invalid");
  exactKeys(receipt.checks, lockedPolicy.public_receipt.allowed_check_fields,
    "Observability activation receipt checks", "receipt-invalid");
  if (receipt.schema_version !== RECEIPT_SCHEMA_VERSION
    || receipt.policy_id !== lockedPolicy.policy_id
    || receipt.read_only !== true
    || receipt.provider_query_performed !== false
    || receipt.production_change_authorized !== false
    || !Array.isArray(receipt.blockers)
    || receipt.blockers.some((code) => !lockedPolicy.blocker_codes.includes(code))
    || new Set(receipt.blockers).size !== receipt.blockers.length
    || CHECK_FIELDS.some((field) => typeof receipt.checks[field] !== "boolean")
    || receipt.activation_ready !== (receipt.blockers.length === 0)
    || receipt.activation_ready !== CHECK_FIELDS.every((field) => receipt.checks[field])) {
    refuse("receipt-invalid", "Public observability receipt overstates or widens its claim");
  }
  for (const field of ["evaluated_at", "evidence_observed_at"]) {
    const parsed = new Date(receipt[field]);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== receipt[field]) {
      refuse("receipt-invalid", `Public receipt ${field} is invalid`);
    }
  }
  return receipt;
}

function loadPrivateEvidence(path, policy) {
  if (!isAbsolute(path)) {
    refuse("private-file-required", "Evidence file path must be absolute and outside Git");
  }
  const requested = resolve(path);
  const metadata = lstatSync(requested, { throwIfNoEntry: false });
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) {
    refuse("private-file-required", "Evidence must be a regular, non-symlink file");
  }
  const actual = realpathSync(requested);
  const fromRoot = relative(ROOT, actual);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
    refuse("private-file-required", "Evidence file must remain outside the repository");
  }
  if ((metadata.mode & 0o077) !== 0) {
    refuse("private-file-required", "Evidence file permissions must be owner-only (chmod 600)");
  }
  return readJson(actual, policy.limits.maximum_evidence_bytes,
    "Private observability activation evidence");
}

function parseEvaluateArgs(args) {
  if (args.length !== 2 || args[0] !== "--evidence-file" || !args[1]) {
    refuse("usage-invalid",
      "Usage: node scripts/verify-observability-activation.mjs evaluate --evidence-file /private/path.json");
  }
  return args[1];
}

function main(args) {
  const policy = loadPolicy();
  const [command, ...rest] = args;
  if (command === "verify-policy" && rest.length === 0) {
    console.log(JSON.stringify({
      schema_version: POLICY_SCHEMA_VERSION,
      policy_valid: true,
      provider_query_performed: false,
      production_change_authorized: false,
    }));
    return;
  }
  if (command === "evaluate") {
    const evidencePath = parseEvaluateArgs(rest);
    console.log(JSON.stringify(evaluateEvidence(loadPrivateEvidence(evidencePath, policy), policy),
      null, 2));
    return;
  }
  refuse("usage-invalid",
    "Usage: node scripts/verify-observability-activation.mjs verify-policy|evaluate --evidence-file /private/path.json");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ObservabilityActivationRefusal) {
      console.error(`Observability activation verification refused [${error.code}]: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
