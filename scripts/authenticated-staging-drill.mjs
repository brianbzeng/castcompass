#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { verifyReleaseCheckout } from "./verify-release-checkout.mjs";

export const AUTHENTICATED_STAGING_DRILL_POLICY_VERSION =
  "castingcompass.authenticated-staging-drill-policy/1.0.0";
export const AUTHENTICATED_STAGING_DRILL_AUTHORIZATION_VERSION =
  "castingcompass.authenticated-staging-drill-authorization/1.0.0";
export const AUTHENTICATED_STAGING_DRILL_PLAN_VERSION =
  "castingcompass.authenticated-staging-drill-plan/1.0.0";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(ROOT, "security", "authenticated-staging-drill-policy.json");
const SCHEMA_PATH = join(ROOT, "contracts", "authenticated-staging-drill-authorization.schema.json");
const PRODUCTION_HOSTS = [
  "castingcompass.com",
  "www.castingcompass.com",
  "castcompass.brianbzeng.com",
  "contourcast.brianbzeng.com",
];
const EXPECTED_ROUTES = [
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/profile" },
  { method: "POST", path: "/api/profile/reviews/retry" },
];
const EXPECTED_MODES = ["direct", "durable_queue"];
const EXPECTED_LIMITS = {
  maximum_authorization_window_minutes: 120,
  maximum_authorization_lead_days: 7,
  trips_per_mode: 10,
  overlapping_retry_requests_per_mode: 2,
  maximum_client_responses_dropped: 1,
  maximum_total_http_requests: 80,
  maximum_authorization_bytes: 65536,
  maximum_plan_bytes: 131072,
};
const EXPECTED_TRUTH_BOUNDARIES = {
  queued_response_is_not_provider_dispatch_count: true,
  unique_d1_rows_and_stub_requests_are_authoritative: true,
  client_response_drop_is_not_d1_mutation_receipt_loss: true,
  local_fault_tests_do_not_count_as_staging_evidence: true,
  model_output_remains_private_and_human_gated: true,
};
const REQUIRED_EVIDENCE = [
  "exact_source_and_worker_identity",
  "exact_exercise_and_stub_worker_identity",
  "synthetic_account_and_twenty_trip_hash_inventory",
  "before_and_after_d1_read_only_snapshots",
  "direct_mode_overlap_and_single_client_response_drop",
  "durable_queue_overlap_and_duplicate_delivery",
  "unique_stub_request_counts_and_latency",
  "queue_depth_retry_and_attention_metrics",
  "zero_real_provider_requests_and_cost",
  "zero_production_binding_or_data_access",
  "private_raw_evidence_and_minimized_aggregate_receipt",
  "independent_review_and_remediation_retest",
];
const PRODUCTION_GATES = [
  "isolated_staging_provisioned",
  "written_authorization_recorded",
  "authenticated_drill_completed",
  "critical_high_findings_remediated_and_retested",
  "independent_acceptance_recorded",
  "production_authority",
];

export class AuthenticatedStagingDrillRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthenticatedStagingDrillRefusal";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new AuthenticatedStagingDrillRefusal(code, message);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") refuse("unsupported-json", "Unsupported JSON value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("policy-invalid", `${name} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) refuse("policy-invalid", `${name} has unexpected fields`);
}

function exactValue(value, expected, name) {
  if (canonicalJson(value) !== canonicalJson(expected)) refuse("policy-invalid", `${name} was changed`);
}

export function validatePolicy(policy) {
  exactKeys(policy, [
    "schema_version", "policy_id", "authorization_contract_version", "plan_contract_version",
    "api_compatibility_version", "production_hosts", "routes", "modes", "exercise_provider",
    "limits", "truth_boundaries", "required_evidence", "production_gates",
  ], "Authenticated staging drill policy");
  if (policy.schema_version !== AUTHENTICATED_STAGING_DRILL_POLICY_VERSION
    || policy.policy_id !== "castingcompass-authenticated-isolated-staging-drill-v1"
    || policy.authorization_contract_version !== AUTHENTICATED_STAGING_DRILL_AUTHORIZATION_VERSION
    || policy.plan_contract_version !== AUTHENTICATED_STAGING_DRILL_PLAN_VERSION
    || policy.api_compatibility_version !== "1") {
    refuse("policy-invalid", "Authenticated staging drill policy identity is invalid");
  }
  exactValue(policy.production_hosts, PRODUCTION_HOSTS, "Production host inventory");
  exactValue(policy.routes, EXPECTED_ROUTES, "Authenticated route inventory");
  exactValue(policy.modes, EXPECTED_MODES, "Dispatch modes");
  exactValue(policy.exercise_provider, {
    binding: "AI_REVIEW_EXERCISE_PROVIDER",
    deployment_config: "staging/ai-review-exercise-stub.wrangler.jsonc",
    model: "castingcompass-isolated-stub-v1",
    contract: "castingcompass.ai-review-exercise-provider/1.0.0",
    public_routes_allowed: false,
    real_provider_key_must_be_absent: true,
    real_provider_model_must_be_absent: true,
    synthetic_account_hash_required: true,
  }, "Exercise provider boundary");
  exactValue(policy.limits, EXPECTED_LIMITS, "Drill limits");
  exactValue(policy.truth_boundaries, EXPECTED_TRUTH_BOUNDARIES, "Truth boundaries");
  exactValue(policy.required_evidence, REQUIRED_EVIDENCE, "Evidence inventory");
  exactKeys(policy.production_gates, PRODUCTION_GATES, "Production gates");
  if (PRODUCTION_GATES.some((gate) => policy.production_gates[gate] !== false)) {
    refuse("policy-invalid", "Repository policy cannot self-approve a production gate");
  }
  return policy;
}

export function loadPolicy() {
  return validatePolicy(JSON.parse(readFileSync(POLICY_PATH, "utf8")));
}

function authorizationValidator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function validateTargetOrigin(value, policy) {
  let target;
  try {
    target = new URL(value);
  } catch {
    refuse("target-invalid", "Target must be one canonical HTTPS DNS origin");
  }
  if (target.protocol !== "https:" || target.username || target.password || target.port
    || target.pathname !== "/" || target.search || target.hash
    || target.hostname !== target.hostname.toLowerCase()
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(target.hostname)
    || isIP(target.hostname) !== 0) {
    refuse("target-invalid", "Target must be one canonical HTTPS DNS origin");
  }
  if (policy.production_hosts.includes(target.hostname)
    || target.hostname.endsWith(".castingcompass.com")) {
    refuse("production-blocked", "Production and every CastingCompass subdomain are permanently blocked");
  }
  return target.origin;
}

function canonicalTimestamp(value, name) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    refuse("authorization-invalid", `${name} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

function requireBooleanSet(source, expected, name) {
  for (const [key, value] of Object.entries(expected)) {
    if (source[key] !== value) refuse("authorization-gate", `${name}.${key} did not satisfy the locked gate`);
  }
}

export function validateAuthorization(authorization, policy = loadPolicy(), options = {}) {
  const validate = authorizationValidator();
  if (!validate(authorization)) refuse("authorization-schema", "Authorization contract rejected");
  if (authorization.expected_api_compatibility_version !== policy.api_compatibility_version) {
    refuse("authorization-version", "API compatibility version disagrees with policy");
  }
  const targetOrigin = validateTargetOrigin(authorization.target_origin, policy);
  const start = canonicalTimestamp(authorization.window_start_at, "window_start_at");
  const end = canonicalTimestamp(authorization.window_end_at, "window_end_at");
  const now = (options.now ?? new Date()).getTime();
  if (end <= start || end <= now
    || end - start > policy.limits.maximum_authorization_window_minutes * 60_000
    || start - now > policy.limits.maximum_authorization_lead_days * 86_400_000) {
    refuse("authorization-window", "Authorization window is expired, reversed, too long, or too far ahead");
  }
  if (options.expectedSourceCommit && authorization.source_commit !== options.expectedSourceCommit) {
    refuse("source-mismatch", "Authorization source commit does not match the exact checkout");
  }
  requireBooleanSet(authorization.authorization, {
    written_scope_approved: true,
    authenticated_testing_approved: true,
    independent_tester_authorized: true,
    client_response_fault_authorized: true,
    queue_duplicate_delivery_authorized: true,
  }, "authorization");
  requireBooleanSet(authorization.safety, {
    synthetic_data_only: true,
    production_bindings_attached: false,
    production_user_data_accessible: false,
    real_ai_provider_credentials_attached: false,
    exercise_service_binding_attached: true,
    email_sink_only: true,
    outbound_callbacks_disabled: true,
    monitoring_operator_ready: true,
    emergency_stop_verified: true,
    exact_source_deployed: true,
  }, "safety");
  requireBooleanSet(authorization.fault_injection, {
    client_response_drop_after_upstream_completion: true,
    maximum_dropped_responses: policy.limits.maximum_client_responses_dropped,
  }, "fault_injection");
  requireBooleanSet(authorization.evidence_access, {
    d1_read_only_evidence_approved: true,
    stub_provider_metrics_approved: true,
    queue_metrics_approved: true,
    private_evidence_location_approved: true,
  }, "evidence_access");
  const direct = authorization.synthetic_subjects.direct_trip_hashes;
  const queue = authorization.synthetic_subjects.queue_trip_hashes;
  if (new Set([...direct, ...queue]).size !== policy.limits.trips_per_mode * policy.modes.length) {
    refuse("authorization-subjects", "Direct and Queue synthetic trip hashes must be distinct");
  }
  return { authorization, targetOrigin, start, end };
}

export function buildPlan(validated, policy = loadPolicy()) {
  const authorization = validated.authorization;
  const common = {
    route: { method: "POST", path: "/api/profile/reviews/retry" },
    overlapping_requests: policy.limits.overlapping_retry_requests_per_mode,
    authoritative_counts: ["unique_d1_trip_rows", "unique_exercise_stub_requests"],
    queued_response_fields_must_not_be_summed: true,
    expected_unique_reviewed_rows: policy.limits.trips_per_mode,
    expected_unique_stub_requests: policy.limits.trips_per_mode,
    real_provider_expected_requests: 0,
  };
  return {
    schema_version: AUTHENTICATED_STAGING_DRILL_PLAN_VERSION,
    policy_sha256: sha256(canonicalJson(policy)),
    authorization_sha256: sha256(canonicalJson(authorization)),
    source_commit: authorization.source_commit,
    exercise_id_sha256: sha256(authorization.exercise_id),
    target_origin: validated.targetOrigin,
    expected_api_compatibility_version: authorization.expected_api_compatibility_version,
    expected_worker_version_id: authorization.expected_worker_version_id,
    expected_exercise_provider_version_id: authorization.expected_exercise_provider_version_id,
    window_start_at: authorization.window_start_at,
    window_end_at: authorization.window_end_at,
    synthetic_account_hash: authorization.synthetic_subjects.account_hash,
    credential_handling: "Supply the synthetic account session only through the live operator client; never place it in authorization, plan, logs, screenshots, or evidence metadata.",
    preflight_assertions: {
      exact_clean_reviewed_source: true,
      exact_worker_and_exercise_identity: true,
      production_bindings_and_data_absent: true,
      real_ai_provider_credentials_and_requests_absent: true,
      isolated_stub_binding_and_metrics_present: true,
      maintenance_off_and_d1_healthy: true,
      monitoring_and_emergency_stop_ready: true,
    },
    scenarios: [
      {
        id: "direct_overlap_with_client_response_drop",
        mode: "direct",
        trip_hashes: authorization.synthetic_subjects.direct_trip_hashes,
        queue_feature_flag: "false",
        client_response_drop_after_upstream_completion: 1,
        claim_boundary: "This proves client-to-Worker response loss and idempotent replay only; it does not claim D1 SDK mutation-receipt loss.",
        ...common,
      },
      {
        id: "durable_queue_overlap_with_duplicate_delivery",
        mode: "durable_queue",
        trip_hashes: authorization.synthetic_subjects.queue_trip_hashes,
        queue_feature_flag: "true",
        duplicate_queue_delivery_required: true,
        claim_boundary: "Queue delivery, D1 job state, and stub metrics must reconcile by unique opaque identity; HTTP queued counts are not dispatch receipts.",
        ...common,
      },
    ],
    required_evidence: policy.required_evidence,
    execution_supported: false,
    network_preflight_performed: false,
    production_ready: false,
    production_authority: false,
  };
}

function pathInsideRepository(path) {
  const candidate = resolve(path);
  const fromRoot = relative(ROOT, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function privateJsonRead(path, maximumBytes) {
  if (!isAbsolute(path) || pathInsideRepository(path)) refuse("file-location", "Private input must be an absolute out-of-repository file");
  const resolved = resolve(path);
  const before = lstatSync(resolved, { throwIfNoEntry: false });
  if (!before || before.isSymbolicLink() || !before.isFile() || before.size <= 0 || before.size > maximumBytes
    || before.nlink !== 1 || (before.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    refuse("file-safety", "Private input must be a current-user-owned bounded 0600 regular file");
  }
  let descriptor;
  try {
    descriptor = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    refuse("file-safety", "Private input could not be opened safely");
  }
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs || opened.nlink !== 1) {
      refuse("file-race", "Private input changed while opening");
    }
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || Buffer.byteLength(text) !== opened.size) refuse("file-race", "Private input changed while reading");
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof AuthenticatedStagingDrillRefusal) throw error;
    refuse("file-json", "Private input is not valid JSON");
  } finally {
    closeSync(descriptor);
  }
}

function privateJsonWrite(path, value, maximumBytes) {
  if (!isAbsolute(path) || pathInsideRepository(path)) refuse("file-location", "Private output must be an absolute out-of-repository file");
  const resolved = resolve(path);
  const parent = lstatSync(dirname(resolved), { throwIfNoEntry: false });
  if (!parent || parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && parent.uid !== process.getuid())) {
    refuse("file-safety", "Private output parent must be a current-user-owned 0700 directory");
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > maximumBytes) refuse("file-size", "Private output exceeds its fixed ceiling");
  try {
    writeFileSync(resolved, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const written = lstatSync(resolved);
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1
      || written.size !== Buffer.byteLength(serialized) || (written.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && written.uid !== process.getuid())) {
      refuse("file-safety", "Private output did not preserve its locked file identity");
    }
  } catch (error) {
    if (error instanceof AuthenticatedStagingDrillRefusal) throw error;
    refuse("file-safety", "Private output could not be created exclusively");
  }
}

function template(now = new Date()) {
  const start = new Date(now.getTime() + 60 * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  const hashes = Array.from({ length: 20 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
  return {
    schema_version: AUTHENTICATED_STAGING_DRILL_AUTHORIZATION_VERSION,
    exercise_id: "sec_00000000000000000000000000000000",
    source_commit: "0".repeat(40),
    environment: "isolated-staging",
    target_origin: "https://isolated-staging.invalid",
    expected_api_compatibility_version: "1",
    expected_worker_version_id: "REPLACE-WORKER-VERSION",
    expected_exercise_provider_version_id: "REPLACE-STUB-VERSION",
    window_start_at: start.toISOString(),
    window_end_at: end.toISOString(),
    synthetic_subjects: {
      account_hash: "0".repeat(64),
      direct_trip_hashes: hashes.slice(0, 10),
      queue_trip_hashes: hashes.slice(10),
    },
    authorization: {
      written_scope_approved: false,
      authenticated_testing_approved: false,
      independent_tester_authorized: false,
      client_response_fault_authorized: false,
      queue_duplicate_delivery_authorized: false,
    },
    safety: {
      synthetic_data_only: false,
      production_bindings_attached: false,
      production_user_data_accessible: false,
      real_ai_provider_credentials_attached: false,
      exercise_service_binding_attached: false,
      email_sink_only: false,
      outbound_callbacks_disabled: false,
      monitoring_operator_ready: false,
      emergency_stop_verified: false,
      exact_source_deployed: false,
    },
    fault_injection: {
      client_response_drop_after_upstream_completion: false,
      fault_proxy_identity_sha256: "0".repeat(64),
      maximum_dropped_responses: 1,
    },
    evidence_access: {
      d1_read_only_evidence_approved: false,
      stub_provider_metrics_approved: false,
      queue_metrics_approved: false,
      private_evidence_location_approved: false,
    },
  };
}

function parseArguments(args) {
  const command = args[0];
  const options = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !["--authorization", "--output"].includes(flag)) refuse("arguments", `Unknown or incomplete argument: ${flag}`);
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const policy = loadPolicy();
  authorizationValidator();
  if (command === "verify-policy") {
    process.stdout.write(`${JSON.stringify({
      policy_version: policy.schema_version,
      policy_sha256: sha256(canonicalJson(policy)),
      execution_supported: false,
      production_authority: false,
    })}\n`);
    return;
  }
  if (command === "write-template") {
    if (!options.output || options.authorization) refuse("arguments", "write-template requires only --output");
    privateJsonWrite(options.output, template(), policy.limits.maximum_authorization_bytes);
    process.stdout.write(`${JSON.stringify({ written: true, private: true, approvals_recorded: false })}\n`);
    return;
  }
  if (command === "plan") {
    if (!options.authorization || !options.output) refuse("arguments", "plan requires --authorization and --output");
    const authorization = privateJsonRead(options.authorization, policy.limits.maximum_authorization_bytes);
    await verifyReleaseCheckout({ root: ROOT, expectedCommit: authorization.source_commit });
    const validated = validateAuthorization(authorization, policy, { expectedSourceCommit: authorization.source_commit });
    privateJsonWrite(options.output, buildPlan(validated, policy), policy.limits.maximum_plan_bytes);
    process.stdout.write(`${JSON.stringify({ planned: true, network_contacted: false, execution_supported: false })}\n`);
    return;
  }
  refuse("command", "Use verify-policy, write-template, or plan. This tool deliberately has no run command");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const code = error instanceof AuthenticatedStagingDrillRefusal ? error.code : "drill-plan-failed";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
