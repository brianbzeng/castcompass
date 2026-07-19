#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { verifyReleaseCheckout } from "./verify-release-checkout.mjs";

export const SECURITY_EXERCISE_POLICY_VERSION =
  "castingcompass.security-exercise-policy/1.0.0";
export const SECURITY_EXERCISE_AUTHORIZATION_VERSION =
  "castingcompass.security-exercise-authorization/1.0.0";
export const SECURITY_EXERCISE_RECEIPT_VERSION =
  "castingcompass.security-exercise-receipt/1.0.0";
export const ACTIVE_EXECUTION_CONFIRMATION =
  "I_HAVE_WRITTEN_AUTHORIZATION_FOR_THIS_ISOLATED_STAGING_TARGET";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(ROOT, "security", "security-exercise-policy.json");
const SCHEMA_PATH = join(ROOT, "contracts", "security-exercise-authorization.schema.json");
const PRODUCTION_HOSTS = [
  "castingcompass.com",
  "www.castingcompass.com",
  "castcompass.brianbzeng.com",
  "contourcast.brianbzeng.com",
];
const PUBLIC_PATH_PATTERNS = [
  "^/$",
  "^/ai-disclosure/?$",
  "^/privacy/?$",
  "^/terms/?$",
  "^/api/health$",
  "^/robots\\.txt$",
  "^/sitemap\\.xml$",
];
const EXCLUDED_PATH_PATTERNS = [
  "^/api/(?!health$).*$",
  "^/profile(?:/.*)?$",
  "^/_next/image(?:/.*)?$",
];
const EXPECTED_IMAGE_DIGEST =
  "sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2";
const EXPECTED_LIMITS = {
  maximum_authorization_window_minutes: 480,
  maximum_spider_minutes: 2,
  maximum_scan_minutes: 15,
  maximum_rule_minutes: 2,
  delay_milliseconds: 250,
  threads_per_host: 1,
  maximum_alerts_per_rule: 5,
  active_strength: "Low",
  alert_threshold: "Medium",
  request_timeout_milliseconds: 5000,
  maximum_health_response_bytes: 8192,
  maximum_authorization_bytes: 65536,
  maximum_report_bytes: 16777216,
};
const PRODUCTION_GATES = [
  "isolated_staging_provisioned",
  "independent_tester_appointed",
  "authenticated_multi_account_testing_completed",
  "critical_high_findings_remediated_and_retested",
  "independent_acceptance_recorded",
];

class SecurityExerciseRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecurityExerciseRefusal";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new SecurityExerciseRefusal(code, message);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") refuse("unsupported-json", "Unsupported JSON value");
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("policy-invalid", `${name} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    refuse("policy-invalid", `${name} has unexpected fields`);
  }
}

function exactArray(value, expected, name) {
  if (!Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])) {
    refuse("policy-invalid", `${name} disagrees with the locked policy`);
  }
}

function boundedJsonFile(path, maximumBytes, name) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    refuse("file-invalid", `${name} is unavailable`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
    refuse("file-invalid", `${name} must be a bounded regular file`);
  }
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), metadata };
  } catch {
    refuse("file-invalid", `${name} is not valid JSON`);
  }
}

function isInsideRepository(path) {
  const candidate = resolve(path);
  const pathFromRoot = relative(ROOT, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function privateAuthorizationFile(path, maximumBytes) {
  if (!isAbsolute(path) || isInsideRepository(path)) {
    refuse("authorization-location", "Authorization must be an absolute out-of-repository file");
  }
  const parsed = boundedJsonFile(resolve(path), maximumBytes, "Authorization");
  if ((parsed.metadata.mode & 0o077) !== 0) {
    refuse("authorization-permissions", "Authorization must not be accessible by group or others");
  }
  return parsed.value;
}

function privateOutputDirectory(path) {
  if (!isAbsolute(path) || isInsideRepository(path)) {
    refuse("output-location", "Evidence output must be an absolute out-of-repository directory");
  }
  const output = resolve(path);
  const parent = lstatSync(dirname(output), { throwIfNoEntry: false });
  if (!parent || parent.isSymbolicLink() || !parent.isDirectory()) {
    refuse("output-location", "Evidence output parent is invalid");
  }
  const existing = lstatSync(output, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory() || readdirSync(output).length !== 0) {
      refuse("output-location", "Evidence output must be a real empty directory");
    }
  } else {
    mkdirSync(output, { mode: 0o700 });
  }
  chmodSync(output, 0o700);
  if ((lstatSync(output).mode & 0o077) !== 0) {
    refuse("output-permissions", "Evidence output directory is not private");
  }
  return output;
}

function privateWrite(path, value) {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  if ((lstatSync(path).mode & 0o077) !== 0) {
    refuse("output-permissions", "Evidence file is not private");
  }
}

export function validatePolicy(policy) {
  exactKeys(policy, [
    "schema_version", "policy_id", "authorization_contract_version",
    "receipt_contract_version", "scanner", "production_hosts", "public_path_patterns",
    "excluded_path_patterns", "limits", "production_gates",
  ], "Security-exercise policy");
  if (policy.schema_version !== SECURITY_EXERCISE_POLICY_VERSION
    || policy.policy_id !== "castingcompass-isolated-security-exercise-v1"
    || policy.authorization_contract_version !== SECURITY_EXERCISE_AUTHORIZATION_VERSION
    || policy.receipt_contract_version !== SECURITY_EXERCISE_RECEIPT_VERSION) {
    refuse("policy-invalid", "Security-exercise policy identity is invalid");
  }
  exactKeys(policy.scanner, [
    "name", "version", "image_repository", "image_index_digest", "image_reference",
  ], "Scanner identity");
  if (policy.scanner.name !== "OWASP ZAP"
    || policy.scanner.version !== "2.17.0"
    || policy.scanner.image_repository !== "ghcr.io/zaproxy/zaproxy"
    || policy.scanner.image_index_digest !== EXPECTED_IMAGE_DIGEST
    || policy.scanner.image_reference !== `${policy.scanner.image_repository}@${EXPECTED_IMAGE_DIGEST}`) {
    refuse("policy-invalid", "Scanner identity is not immutable");
  }
  exactArray(policy.production_hosts, PRODUCTION_HOSTS, "Production hostname inventory");
  exactArray(policy.public_path_patterns, PUBLIC_PATH_PATTERNS, "Public path scope");
  exactArray(policy.excluded_path_patterns, EXCLUDED_PATH_PATTERNS, "Excluded path scope");
  exactKeys(policy.limits, Object.keys(EXPECTED_LIMITS), "Exercise limits");
  if (canonicalJson(policy.limits) !== canonicalJson(EXPECTED_LIMITS)) {
    refuse("policy-invalid", "Exercise limits were weakened");
  }
  exactKeys(policy.production_gates, PRODUCTION_GATES, "Production gates");
  if (!PRODUCTION_GATES.every((gate) => policy.production_gates[gate] === false)) {
    refuse("policy-invalid", "Repository policy cannot self-approve a production gate");
  }
  return policy;
}

export function loadPolicy() {
  const { value } = boundedJsonFile(POLICY_PATH, 256 * 1024, "Security-exercise policy");
  return validatePolicy(value);
}

function compileAuthorizationValidator() {
  const { value: schema } = boundedJsonFile(SCHEMA_PATH, 256 * 1024, "Authorization schema");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1"
    || hostname === "::1" || hostname === "[::1]";
}

function isIpLiteral(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname.includes(":");
}

export function validateTargetOrigin(value, policy, mode, environment) {
  let target;
  try {
    target = new URL(value);
  } catch {
    refuse("target-invalid", "Target must be an absolute HTTP(S) origin");
  }
  if ((target.protocol !== "http:" && target.protocol !== "https:")
    || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    refuse("target-invalid", "Target must contain only HTTP(S), hostname, and optional port");
  }
  if (value !== target.origin) {
    refuse("target-invalid", "Target must be one canonical origin without normalization");
  }
  const hostname = target.hostname.toLowerCase();
  if (policy.production_hosts.includes(hostname) || hostname.endsWith(".castingcompass.com")) {
    refuse("production-target-blocked", "Production CastingCompass targets are permanently blocked");
  }
  const local = isLocalHostname(hostname);
  const namedHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
    .test(hostname);
  if (!local && !namedHost) {
    refuse("target-invalid", "Remote targets require a canonical DNS hostname");
  }
  if (mode === "active-staging" && (local || environment !== "isolated-staging" || target.protocol !== "https:")) {
    refuse("active-target-invalid", "Active mode requires a remote HTTPS isolated-staging target");
  }
  if (environment === "local-synthetic" && !local) {
    refuse("environment-target-mismatch", "Local-synthetic mode requires a loopback target");
  }
  if (environment === "isolated-staging" && (local || isIpLiteral(hostname))) {
    refuse("environment-target-mismatch", "Isolated staging requires a named non-loopback host");
  }
  return target;
}

export function validateAuthorization(authorization, policy, options = {}) {
  const validator = options.validator ?? compileAuthorizationValidator();
  if (!validator(authorization)) {
    refuse("authorization-contract", "Authorization contract rejected");
  }
  const target = validateTargetOrigin(
    authorization.target_origin,
    policy,
    authorization.mode,
    authorization.environment,
  );
  const start = canonicalTimestamp(authorization.window_start_at);
  const end = canonicalTimestamp(authorization.window_end_at);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!start || !end || start >= end
    || end.getTime() - start.getTime() > policy.limits.maximum_authorization_window_minutes * 60_000
    || now < start || now > end) {
    refuse("authorization-window", "Authorization window is invalid, expired, or not active");
  }
  if (!authorization.authorization.written_scope_approved) {
    refuse("scope-unapproved", "Written scope approval is required");
  }
  const safety = authorization.safety;
  if (!safety.synthetic_data_only || safety.production_bindings_attached
    || safety.production_user_data_accessible || !safety.external_providers_disabled
    || !safety.outbound_callbacks_disabled || !safety.monitoring_operator_ready
    || !safety.emergency_stop_verified) {
    refuse("safety-gate", "Every isolated-data and emergency-control gate must pass");
  }
  if (authorization.mode === "active-staging"
    && (!authorization.authorization.active_testing_approved
      || !authorization.authorization.independent_tester_authorized)) {
    refuse("active-authorization", "Active testing requires explicit independent authorization");
  }
  return { authorization, target, start, end };
}

export async function preflightTarget(validated, policy, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthUrl = new URL("/api/health", validated.target);
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(policy.limits.request_timeout_milliseconds),
    });
  } catch {
    refuse("preflight-unavailable", "Staging preflight could not be completed");
  }
  if (response.status !== 200 || response.type === "opaqueredirect"
    || (response.status >= 300 && response.status < 400)) {
    refuse("preflight-response", "Staging health response was not accepted");
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  if (!/^application\/json\b/iu.test(contentType) || !/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(cacheControl)) {
    refuse("preflight-headers", "Staging health headers were not accepted");
  }
  let text;
  try {
    text = await response.text();
  } catch {
    refuse("preflight-body", "Staging health body could not be read");
  }
  if (Buffer.byteLength(text) > policy.limits.maximum_health_response_bytes) {
    refuse("preflight-body", "Staging health body exceeded the fixed limit");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    refuse("preflight-body", "Staging health body was not valid JSON");
  }
  exactKeys(body, [
    "status", "service", "workerVersionId", "releaseMaintenance", "securityExerciseId",
  ], "Staging health body");
  if (body.status !== "ok" || body.service !== "castingcompass-web"
    || body.workerVersionId !== validated.authorization.expected_worker_version_id
    || body.securityExerciseId !== validated.authorization.exercise_id
    || body.releaseMaintenance !== false) {
    refuse("preflight-identity", "Staging identity did not match the written authorization");
  }
  return true;
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function yamlString(value) {
  return JSON.stringify(value);
}

export function buildAutomationPlan(validated, policy) {
  const origin = validated.target.origin;
  const originPattern = regexEscape(origin);
  const includes = policy.public_path_patterns.map((pattern) => `^${originPattern}${pattern.slice(1)}`);
  const excludes = policy.excluded_path_patterns.map((pattern) => `^${originPattern}${pattern.slice(1)}`);
  const lines = [
    "env:",
    "  contexts:",
    "    - name: castingcompass-public-synthetic",
    "      urls:",
    `        - ${yamlString(origin)}`,
    "      includePaths:",
    ...includes.map((pattern) => `        - ${yamlString(pattern)}`),
    "      excludePaths:",
    ...excludes.map((pattern) => `        - ${yamlString(pattern)}`),
    "  parameters:",
    "    failOnError: true",
    "    failOnWarning: true",
    "    progressToStdout: false",
    "jobs:",
    "  - type: passiveScan-config",
    "    parameters:",
    "      scanOnlyInScope: true",
    `      maxAlertsPerRule: ${policy.limits.maximum_alerts_per_rule}`,
    "  - type: spider",
    "    parameters:",
    "      context: castingcompass-public-synthetic",
    `      maxDuration: ${policy.limits.maximum_spider_minutes}`,
    "      maxDepth: 5",
    "      maxChildren: 100",
    "  - type: passiveScan-wait",
    "    parameters:",
    `      maxDuration: ${policy.limits.maximum_spider_minutes}`,
  ];
  if (validated.authorization.mode === "active-staging") {
    lines.push(
      "  - type: activeScan",
      "    parameters:",
      "      context: castingcompass-public-synthetic",
      "      policy: castingcompass-public-low-impact",
      `      maxRuleDurationInMins: ${policy.limits.maximum_rule_minutes}`,
      `      maxScanDurationInMins: ${policy.limits.maximum_scan_minutes}`,
      `      delayInMs: ${policy.limits.delay_milliseconds}`,
      `      threadPerHost: ${policy.limits.threads_per_host}`,
      `      maxAlertsPerRule: ${policy.limits.maximum_alerts_per_rule}`,
      "    policyDefinition:",
      `      defaultStrength: ${policy.limits.active_strength}`,
      `      defaultThreshold: ${policy.limits.alert_threshold}`,
    );
  }
  lines.push(
    "  - type: report",
    "    parameters:",
    "      template: traditional-json",
    "      reportDir: /zap/wrk",
    "      reportFile: zap-report.json",
    "      reportTitle: CastingCompass isolated synthetic security exercise",
  );
  return `${lines.join("\n")}\n`;
}

export function buildDockerArguments(outputDirectory, policy) {
  return [
    "run", "--rm", "--pull=never", "--read-only",
    "--hostname", "castingcompass-zap",
    "--add-host", "castingcompass-zap:127.0.0.1",
    "--env", "JAVA_TOOL_OPTIONS=-Djava.util.prefs.userRoot=/home/zap/.ZAP/java-prefs",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=512", "--memory=2g", "--cpus=2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
    "--tmpfs", "/home/zap/.ZAP:rw,noexec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700",
    "--volume", `${outputDirectory}:/zap/wrk:rw`,
    policy.scanner.image_reference,
    "zap.sh", "-cmd", "-autorun", "/zap/wrk/automation.yaml",
  ];
}

function riskKey(alert) {
  const code = Number.parseInt(String(alert?.riskcode ?? ""), 10);
  if (code === 4) return "critical";
  if (code === 3) return "high";
  if (code === 2) return "medium";
  if (code === 1) return "low";
  return "informational";
}

export function aggregateZapReport(report) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  const sites = Array.isArray(report?.site) ? report.site : [];
  for (const site of sites) {
    const alerts = Array.isArray(site?.alerts) ? site.alerts : [];
    for (const alert of alerts) counts[riskKey(alert)] += 1;
  }
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
}

export function validateZapReport(report, policy, target) {
  if (!report || typeof report !== "object" || Array.isArray(report)
    || report["@version"] !== policy.scanner.version
    || !Array.isArray(report.site) || report.site.length !== 1) {
    refuse("report-contract", "ZAP report identity or site inventory is invalid");
  }
  const site = report.site[0];
  if (!site || typeof site !== "object" || Array.isArray(site)
    || typeof site["@name"] !== "string"
    || !Array.isArray(site.alerts) || site.alerts.length > 10_000) {
    refuse("report-contract", "ZAP report site or alert inventory is invalid");
  }
  let reportOrigin;
  try {
    reportOrigin = new URL(site["@name"]).origin;
  } catch {
    refuse("report-contract", "ZAP report site identity is invalid");
  }
  if (reportOrigin !== target.origin) {
    refuse("report-target-mismatch", "ZAP report does not match the authorized target");
  }
  for (const alert of site.alerts) {
    if (!alert || typeof alert !== "object" || Array.isArray(alert)
      || !/^[0-4]$/u.test(String(alert.riskcode ?? ""))) {
      refuse("report-contract", "ZAP report contains an invalid aggregate alert");
    }
  }
  return report;
}

function readPrivateReport(path, maximumBytes) {
  const parsed = boundedJsonFile(path, maximumBytes, "ZAP report");
  if ((lstatSync(dirname(path)).mode & 0o077) !== 0) {
    refuse("output-permissions", "ZAP report parent is not private");
  }
  chmodSync(path, 0o600);
  return parsed.value;
}

export function buildAggregateReceipt({ policy, authorization, report, exitCode, completedAt }) {
  const target = validateTargetOrigin(
    authorization.target_origin,
    policy,
    authorization.mode,
    authorization.environment,
  );
  const summary = aggregateZapReport(validateZapReport(report, policy, target));
  const blockers = PRODUCTION_GATES.map((gate) => `production-gate:${gate}`);
  const acceptancePassed = exitCode === 0
    && summary.counts.critical === 0
    && summary.counts.high === 0
    && summary.counts.medium === 0;
  return {
    schema_version: SECURITY_EXERCISE_RECEIPT_VERSION,
    policy_sha256: sha256(canonicalJson(policy)),
    authorization_sha256: sha256(canonicalJson(authorization)),
    source_commit: authorization.source_commit,
    mode: authorization.mode,
    completed_at: completedAt.toISOString(),
    scanner: {
      name: policy.scanner.name,
      version: policy.scanner.version,
      image_index_digest: policy.scanner.image_index_digest,
      exit_code: exitCode,
    },
    aggregate_alert_counts: summary.counts,
    aggregate_alert_total: summary.total,
    public_unauthenticated_surface_exercised: true,
    authenticated_business_logic_exercised: false,
    multi_account_authorization_exercised: false,
    independent_acceptance_recorded: false,
    acceptance_passed: acceptancePassed,
    production_ready: false,
    production_blockers: blockers,
  };
}

export async function executeSecurityExercise(options) {
  const policy = options.policy ?? loadPolicy();
  const authorization = options.authorization
    ?? privateAuthorizationFile(options.authorizationPath, policy.limits.maximum_authorization_bytes);
  const validated = validateAuthorization(authorization, policy, { now: options.now });
  if (validated.authorization.mode === "active-staging"
    && options.executionConfirmation !== ACTIVE_EXECUTION_CONFIRMATION) {
    refuse("execution-confirmation", "Active execution confirmation is missing");
  }
  try {
    await (options.checkoutVerifier ?? verifyReleaseCheckout)({
      root: ROOT,
      expectedCommit: validated.authorization.source_commit,
    });
  } catch {
    refuse("checkout-mismatch", "Exercise execution requires a clean exact-source checkout");
  }
  await preflightTarget(validated, policy, { fetchImpl: options.fetchImpl });
  const output = privateOutputDirectory(options.outputDirectory);
  privateWrite(join(output, "automation.yaml"), buildAutomationPlan(validated, policy));
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const result = spawnImpl("docker", buildDockerArguments(output, policy), {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: (policy.limits.maximum_scan_minutes + 5) * 60_000,
  });
  privateWrite(join(output, "scanner-stdout.log"), String(result.stdout ?? ""));
  privateWrite(join(output, "scanner-stderr.log"), String(result.stderr ?? ""));
  if (result.error || !Number.isInteger(result.status)) {
    refuse("scanner-execution", "Scanner process did not complete");
  }
  const report = readPrivateReport(join(output, "zap-report.json"), policy.limits.maximum_report_bytes);
  const receipt = buildAggregateReceipt({
    policy,
    authorization,
    report,
    exitCode: result.status,
    completedAt: options.now instanceof Date ? options.now : new Date(),
  });
  privateWrite(join(output, "aggregate-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.acceptance_passed) {
    refuse("exercise-not-accepted", "Exercise completed but did not satisfy the aggregate acceptance rule");
  }
  return receipt;
}

function parseArguments(values) {
  const [command, ...rest] = values;
  const parsed = { command, authorizationPath: "", outputDirectory: "" };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--authorization") parsed.authorizationPath = rest[++index] ?? "";
    else if (value === "--output") parsed.outputDirectory = rest[++index] ?? "";
    else refuse("arguments", "Unknown command-line argument");
  }
  return parsed;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const policy = loadPolicy();
  if (arguments_.command === "verify-policy" && !arguments_.authorizationPath && !arguments_.outputDirectory) {
    process.stdout.write("Security-exercise policy verified; production gates remain closed.\n");
    return;
  }
  if (arguments_.command === "plan" && arguments_.authorizationPath && arguments_.outputDirectory) {
    const authorization = privateAuthorizationFile(
      arguments_.authorizationPath,
      policy.limits.maximum_authorization_bytes,
    );
    const validated = validateAuthorization(authorization, policy);
    const output = privateOutputDirectory(arguments_.outputDirectory);
    privateWrite(join(output, "automation.yaml"), buildAutomationPlan(validated, policy));
    process.stdout.write("Private security-exercise plan prepared; no target was contacted.\n");
    return;
  }
  if (arguments_.command === "run" && arguments_.authorizationPath && arguments_.outputDirectory) {
    await executeSecurityExercise({
      authorizationPath: arguments_.authorizationPath,
      outputDirectory: arguments_.outputDirectory,
      executionConfirmation: process.env.CASTINGCOMPASS_SECURITY_EXERCISE_AUTHORIZATION ?? "",
    });
    process.stdout.write("Security exercise accepted; private aggregate evidence retained.\n");
    return;
  }
  refuse("arguments", "Use verify-policy, plan, or run with the documented arguments");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof SecurityExerciseRefusal ? error.code : "unexpected-failure";
    process.stderr.write(`Security exercise refused or failed: ${code}\n`);
    process.exitCode = 1;
  });
}
