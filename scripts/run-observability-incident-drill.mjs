#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { routeTemplate } from "../worker/observability.ts";

export const OBSERVABILITY_DRILL_VERSION = "castingcompass.observability-drill/1.0.0";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = resolve(ROOT, "tests/fixtures/observability-incident.ndjson");
const MAX_INPUT_BYTES = 512 * 1024;
const LOG_SCHEMA_VERSION = "castingcompass.log/1.0.0";
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const LEVEL_PRIORITY = { debug: 10, info: 20, warn: 30, error: 40 };
const SERVICES = new Set(["castingcompass-web", "castingcompass-api"]);
const REQUEST_ENVIRONMENTS = new Set(["development", "preview", "production", "unknown"]);
const OPERATION_ENVIRONMENTS = new Set(["queue", "scheduled"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"]);
const EVENT_PATTERN = /^[a-z][a-z0-9_.]{0,95}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,160}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TRACE_PATTERN = /^[a-f0-9]{16,32}(?:-[A-Za-z]{3})?$/u;
const PSEUDONYM_PATTERN = /^[a-f0-9]{64}$/u;
const FORBIDDEN_FIELD_NAME = /(^|_)(account_id|actor|authorization|body|cookie|coordinates|email|ip_address|latitude|longitude|note|object_key|password|passphrase|payload|photo_key|prompt|secret|site_id|token|trip_id|user_id)(_|$)/u;
const RAW_IDENTIFIER_VALUE = /\b(?:account|gear|photo|site|trip|user)_[A-Za-z0-9-]{8,}\b/u;
const IPV4_VALUE = /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^0-9])/u;
const SESSION_OR_BEARER_VALUE = /(?:__Host-cc_session|cc_session|\bbearer(?:%20|\s|:))/iu;
const ALLOWED_FIELDS = new Set([
  "actor_session_key",
  "attempts",
  "duration_ms",
  "environment",
  "error_code",
  "error_name",
  "error_status",
  "event",
  "level",
  "method",
  "operation_id",
  "outcome",
  "provider",
  "provider_request_id",
  "rate_limit_classes",
  "request_id",
  "route",
  "schema_version",
  "service",
  "status",
  "task",
  "timestamp",
  "trace_id",
  "worker_version_id",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  requireCondition(value && typeof value === "object", "Drill report contains an unsupported value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value, label) {
  requireCondition(typeof value === "string", `${label} timestamp must be a string`);
  const parsed = new Date(value);
  requireCondition(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value, `${label} timestamp must be canonical UTC`);
  return parsed;
}

function safeOptionalIdentifier(value, label, maximum = 160) {
  requireCondition(value === null || (
    typeof value === "string" && value.length <= maximum && SAFE_IDENTIFIER.test(value)
  ), `${label} must be a bounded identifier or null`);
}

function validateLogValue(value, label) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value), `${label} must be finite`);
    return;
  }
  if (typeof value === "string") {
    requireCondition(SAFE_IDENTIFIER.test(value), `${label} must be a bounded code-like identifier`);
    requireCondition(!RAW_IDENTIFIER_VALUE.test(value), `${label} contains a raw application identifier`);
    requireCondition(!IPV4_VALUE.test(value), `${label} contains an IP address`);
    requireCondition(!SESSION_OR_BEARER_VALUE.test(value), `${label} contains session or authorization material`);
    return;
  }
  requireCondition(Array.isArray(value) && value.length > 0 && value.length <= 16, `${label} must be a bounded scalar or identifier array`);
  for (const [index, item] of value.entries()) {
    requireCondition(typeof item === "string" && item.length <= 80 && SAFE_IDENTIFIER.test(item), `${label}[${index}] must be a bounded identifier`);
    requireCondition(!RAW_IDENTIFIER_VALUE.test(item) && !IPV4_VALUE.test(item) && !SESSION_OR_BEARER_VALUE.test(item), `${label}[${index}] contains high-risk material`);
  }
}

function validateEvent(event, index) {
  const label = `Event ${index + 1}`;
  requireCondition(event && typeof event === "object" && !Array.isArray(event), `${label} must be an object`);
  for (const [key, value] of Object.entries(event)) {
    requireCondition(ALLOWED_FIELDS.has(key), `${label} contains an unsupported field`);
    requireCondition(
      key === "actor_session_key" || !FORBIDDEN_FIELD_NAME.test(key),
      `${label} contains a prohibited field`,
    );
    validateLogValue(value, `${label} field ${key}`);
  }
  requireCondition(event.schema_version === LOG_SCHEMA_VERSION, `${label} uses an unsupported log schema`);
  canonicalTimestamp(event.timestamp, label);
  requireCondition(LEVELS.has(event.level), `${label} has an invalid severity`);
  requireCondition(typeof event.event === "string" && EVENT_PATTERN.test(event.event), `${label} has an invalid event name`);
  requireCondition(SERVICES.has(event.service), `${label} has an unsupported service`);
  safeOptionalIdentifier(event.worker_version_id, `${label} worker version`);

  const hasRequest = Object.hasOwn(event, "request_id");
  const hasOperation = Object.hasOwn(event, "operation_id");
  requireCondition(hasRequest !== hasOperation, `${label} must have exactly one correlation identity`);

  if (hasRequest) {
    requireCondition(typeof event.request_id === "string" && UUID_PATTERN.test(event.request_id), `${label} request ID must be a server UUID`);
    requireCondition(REQUEST_ENVIRONMENTS.has(event.environment), `${label} has an invalid request environment`);
    requireCondition(METHODS.has(event.method), `${label} has an invalid method`);
    requireCondition(typeof event.route === "string" && routeTemplate(event.route) === event.route, `${label} route is not a normalized template`);
    requireCondition(event.trace_id === null || (typeof event.trace_id === "string" && TRACE_PATTERN.test(event.trace_id)), `${label} trace ID is invalid`);
    requireCondition(event.actor_session_key === null || (
      typeof event.actor_session_key === "string" && PSEUDONYM_PATTERN.test(event.actor_session_key)
    ), `${label} actor session key is not a rotating pseudonym`);
  } else {
    requireCondition(typeof event.operation_id === "string" && UUID_PATTERN.test(event.operation_id), `${label} operation ID must be a server UUID`);
    requireCondition(OPERATION_ENVIRONMENTS.has(event.environment), `${label} has an invalid operation environment`);
    requireCondition(!Object.hasOwn(event, "actor_session_key"), `${label} operation cannot contain an actor key`);
    requireCondition(!Object.hasOwn(event, "route") && !Object.hasOwn(event, "method"), `${label} operation cannot contain request routing fields`);
  }

  if (Object.hasOwn(event, "status")) {
    requireCondition(Number.isInteger(event.status) && event.status >= 100 && event.status <= 599, `${label} status is invalid`);
  }
  if (Object.hasOwn(event, "error_status")) {
    requireCondition(Number.isInteger(event.error_status) && event.error_status >= 100 && event.error_status <= 599, `${label} error status is invalid`);
  }
  if (Object.hasOwn(event, "duration_ms")) {
    requireCondition(typeof event.duration_ms === "number" && event.duration_ms >= 0 && event.duration_ms <= 300_000, `${label} duration is invalid`);
  }
  if (Object.hasOwn(event, "attempts")) {
    requireCondition(Number.isInteger(event.attempts) && event.attempts >= 1 && event.attempts <= 50, `${label} attempts is invalid`);
  }
  return event;
}

export function parseObservabilityNdjson(source) {
  requireCondition(typeof source === "string" && source.length > 0, "Observability fixture must be nonempty UTF-8 NDJSON");
  const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
  requireCondition(lines.length >= 2 && lines.length <= 10_000, "Observability fixture must contain 2–10,000 events");
  return lines.map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Event ${index + 1} is not valid JSON`);
    }
    return validateEvent(event, index);
  });
}

function stableCount(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([value, count]) => ({ value, count }));
}

function highestLevel(events) {
  return events.reduce((highest, event) => (
    LEVEL_PRIORITY[event.level] > LEVEL_PRIORITY[highest] ? event.level : highest
  ), "debug");
}

function consistentValue(events, key, label) {
  const values = new Set(events.map((event) => event[key] ?? null));
  requireCondition(values.size === 1, `${label} changes ${key} within one correlation identity`);
  return events[0][key] ?? null;
}

function reconstructRequests(events) {
  const groups = new Map();
  for (const event of events.filter((candidate) => Object.hasOwn(candidate, "request_id"))) {
    const group = groups.get(event.request_id) ?? [];
    group.push(event);
    groups.set(event.request_id, group);
  }
  const requests = [];
  for (const [requestId, group] of groups) {
    group.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const terminal = group.filter((event) => event.event === "http.request.completed");
    requireCondition(terminal.length === 1, `Request ${requestId} must have exactly one completion event`);
    const completion = terminal[0];
    requireCondition(Number.isInteger(completion.status) && typeof completion.outcome === "string", `Request ${requestId} completion is incomplete`);
    consistentValue(group, "trace_id", `Request ${requestId}`);
    consistentValue(group, "actor_session_key", `Request ${requestId}`);
    requests.push({
      request_id: requestId,
      service: consistentValue(group, "service", `Request ${requestId}`),
      environment: consistentValue(group, "environment", `Request ${requestId}`),
      worker_version_id: consistentValue(group, "worker_version_id", `Request ${requestId}`),
      method: consistentValue(group, "method", `Request ${requestId}`),
      route: consistentValue(group, "route", `Request ${requestId}`),
      first_timestamp: group[0].timestamp,
      last_timestamp: group.at(-1).timestamp,
      event_count: group.length,
      events: group.map((event) => event.event),
      highest_level: highestLevel(group),
      terminal_status: completion.status,
      terminal_outcome: completion.outcome,
      duration_ms: completion.duration_ms,
    });
  }
  requireCondition(requests.some((request) => request.event_count >= 2), "Fixture does not prove multi-event request reconstruction");
  return requests.sort((left, right) => left.request_id < right.request_id ? -1 : 1);
}

function reconstructOperations(events) {
  const groups = new Map();
  for (const event of events.filter((candidate) => Object.hasOwn(candidate, "operation_id"))) {
    const group = groups.get(event.operation_id) ?? [];
    group.push(event);
    groups.set(event.operation_id, group);
  }
  const operations = [];
  for (const [operationId, group] of groups) {
    group.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const environment = consistentValue(group, "environment", `Operation ${operationId}`);
    const prefix = environment === "queue" ? "queue.task." : "scheduled.task.";
    const started = group.filter((event) => event.event === `${prefix}started`);
    const terminal = group.filter((event) => event.event === `${prefix}completed` || event.event === `${prefix}failed`);
    requireCondition(started.length === 1 && terminal.length === 1, `Operation ${operationId} must have one start and one terminal event`);
    const terminalEvent = terminal[0];
    const task = consistentValue(group.filter((event) => Object.hasOwn(event, "task")), "task", `Operation ${operationId}`);
    requireCondition(typeof task === "string", `Operation ${operationId} is missing its task`);
    operations.push({
      operation_id: operationId,
      service: consistentValue(group, "service", `Operation ${operationId}`),
      environment,
      worker_version_id: consistentValue(group, "worker_version_id", `Operation ${operationId}`),
      task,
      first_timestamp: group[0].timestamp,
      last_timestamp: group.at(-1).timestamp,
      event_count: group.length,
      events: group.map((event) => event.event),
      highest_level: highestLevel(group),
      terminal_outcome: terminalEvent.event.endsWith(".failed") ? "failed" : "completed",
      duration_ms: terminalEvent.duration_ms,
    });
  }
  requireCondition(operations.length > 0, "Fixture does not prove operation reconstruction");
  return operations.sort((left, right) => left.operation_id < right.operation_id ? -1 : 1);
}

export function buildObservabilityDrillReport(sourceBytes) {
  requireCondition(
    typeof sourceBytes === "string" || Buffer.isBuffer(sourceBytes),
    "Observability drill source must be UTF-8 bytes or text",
  );
  const bytes = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes, "utf8");
  const source = bytes.toString("utf8");
  requireCondition(Buffer.from(source, "utf8").equals(bytes), "Observability fixture must be valid UTF-8");
  const events = parseObservabilityNdjson(source);
  requireCondition(Array.isArray(events) && events.length > 0, "Validated observability events are required");
  const ordered = [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const requests = reconstructRequests(ordered);
  const operations = reconstructOperations(ordered);
  const actorPseudonyms = ordered
    .map((event) => event.actor_session_key)
    .filter((value) => typeof value === "string");
  const core = {
    schema_version: OBSERVABILITY_DRILL_VERSION,
    drill_mode: "offline_non_sensitive_fixture",
    source: {
      sha256: sha256(bytes),
      event_count: ordered.length,
      first_timestamp: ordered[0].timestamp,
      last_timestamp: ordered.at(-1).timestamp,
    },
    correlation: { requests, operations },
    aggregates: {
      by_event: stableCount(ordered.map((event) => event.event)),
      by_level: stableCount(ordered.map((event) => event.level)),
      failed_request_count: requests.filter((request) => request.terminal_status >= 500).length,
      failed_operation_count: operations.filter((operation) => operation.terminal_outcome === "failed").length,
    },
    assertions: {
      every_event_schema_valid: true,
      request_id_reconstruction_passed: true,
      operation_id_reconstruction_passed: true,
      prohibited_fields_absent: true,
      high_risk_value_patterns_absent: true,
      input_actor_pseudonym_count: actorPseudonyms.length,
      actor_session_keys_excluded_from_report: true,
      production_or_provider_queried: false,
      alert_delivery_proved: false,
      dashboard_activation_proved: false,
    },
    limitations: [
      "fixture_only_not_production_evidence",
      "no_alert_delivery_evidence",
      "no_dashboard_iam_retention_or_cost_evidence",
      "no_raw_event_payloads_preserved",
    ],
  };
  const serialized = canonicalJson(core);
  for (const pseudonym of new Set(actorPseudonyms)) {
    requireCondition(!serialized.includes(pseudonym), "Drill report retained an actor pseudonym");
  }
  return { ...core, receipt_sha256: sha256(serialized) };
}

export function runOfflineObservabilityDrill(inputPath = DEFAULT_INPUT) {
  const resolved = resolve(inputPath);
  const metadata = lstatSync(resolved);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), "Observability fixture must be a regular non-symlink file");
  requireCondition(metadata.size > 0 && metadata.size <= MAX_INPUT_BYTES, "Observability fixture exceeds the bounded input size");
  const sourceBytes = readFileSync(resolved);
  return buildObservabilityDrillReport(sourceBytes);
}

function cliArguments(argv) {
  let input = DEFAULT_INPUT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      requireCondition(index + 1 < argv.length, "--input requires a path");
      input = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--help") {
      return { help: true, input };
    }
    throw new Error("Usage: run-observability-incident-drill.mjs [--input PATH]");
  }
  return { help: false, input };
}

function main() {
  const { help, input } = cliArguments(process.argv.slice(2));
  if (help) {
    process.stdout.write("Usage: node scripts/run-observability-incident-drill.mjs [--input PATH]\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(runOfflineObservabilityDrill(input), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Observability drill failed"}\n`);
    process.exitCode = 1;
  }
}
