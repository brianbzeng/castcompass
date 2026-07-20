import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OBSERVABILITY_DRILL_VERSION,
  buildObservabilityDrillReport,
  parseObservabilityNdjson,
  runOfflineObservabilityDrill,
} from "../scripts/run-observability-incident-drill.mjs";

const fixtureUrl = new URL("fixtures/observability-incident.ndjson", import.meta.url);
const ACTOR_PSEUDONYM = "a".repeat(64);

test("offline observability drill reconstructs bounded request and operation timelines", async () => {
  const source = await readFile(fixtureUrl);
  const report = buildObservabilityDrillReport(source);

  assert.equal(report.schema_version, OBSERVABILITY_DRILL_VERSION);
  assert.equal(report.drill_mode, "offline_non_sensitive_fixture");
  assert.equal(report.source.event_count, 10);
  assert.match(report.source.sha256, /^[a-f0-9]{64}$/u);
  assert.match(report.receipt_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.correlation.requests.length, 2);
  assert.equal(report.correlation.operations.length, 3);

  const failedRequest = report.correlation.requests.find(({ terminal_status: status }) => status === 500);
  assert.deepEqual(failedRequest.events, ["http.request.exception", "http.request.completed"]);
  assert.equal(failedRequest.route, "/api/trips/report");
  assert.equal(failedRequest.duration_ms, 42.5);

  const queue = report.correlation.operations.find(({ environment }) => environment === "queue");
  assert.deepEqual(queue.events, [
    "queue.task.started",
    "ai_review.queue.backlog_failed",
    "queue.task.failed",
  ]);
  assert.equal(queue.terminal_outcome, "failed");
  assert.equal(report.aggregates.failed_request_count, 1);
  assert.equal(report.aggregates.failed_operation_count, 2);
  assert.equal(report.assertions.input_actor_pseudonym_count, 2);
  assert.equal(report.assertions.actor_session_keys_excluded_from_report, true);
  assert.equal(report.assertions.production_or_provider_queried, false);
  assert.equal(report.assertions.alert_delivery_proved, false);
  assert.equal(report.assertions.dashboard_activation_proved, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(ACTOR_PSEUDONYM));
});

test("default offline drill produces the exact deterministic receipt", async () => {
  const first = runOfflineObservabilityDrill(new URL(fixtureUrl).pathname);
  const second = runOfflineObservabilityDrill(new URL(fixtureUrl).pathname);
  assert.deepEqual(second, first);
});

test("drill rejects high-risk fields, raw identifiers, IP addresses, and unnormalized routes", async () => {
  const source = await readFile(fixtureUrl, "utf8");
  const events = parseObservabilityNdjson(source);
  const serialize = (candidate) => Buffer.from(`${candidate.map((event) => JSON.stringify(event)).join("\n")}\n`);

  for (const field of [
    "account_id",
    "cookie",
    "coordinates",
    "email",
    "note",
    "prompt",
    "provider_body",
    "token",
    "trip_id",
  ]) {
    const candidate = structuredClone(events);
    candidate[0][field] = "private-material";
    assert.throws(
      () => buildObservabilityDrillReport(serialize(candidate)),
      /unsupported field/u,
      `${field} must fail closed`,
    );
  }

  const withTrip = structuredClone(events);
  withTrip[0].error_code = "trip_12345678-private";
  assert.throws(
    () => buildObservabilityDrillReport(serialize(withTrip)),
    /raw application identifier/u,
  );

  const withIp = structuredClone(events);
  withIp[0].error_code = "203.0.113.42";
  assert.throws(
    () => buildObservabilityDrillReport(serialize(withIp)),
    /IP address/u,
  );

  const withRawRoute = structuredClone(events);
  withRawRoute[0].route = "/api/trips/private-trip/complete";
  assert.throws(
    () => buildObservabilityDrillReport(serialize(withRawRoute)),
    /normalized template/u,
  );
});

test("drill fails closed when correlation chains are incomplete or ambiguous", async () => {
  const source = await readFile(fixtureUrl, "utf8");
  const events = parseObservabilityNdjson(source);
  const serialize = (candidate) => Buffer.from(`${candidate.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const noCompletion = events.filter((event) => !(
    event.request_id === "11111111-1111-4111-8111-111111111111" &&
    event.event === "http.request.completed"
  ));
  assert.throws(
    () => buildObservabilityDrillReport(serialize(noCompletion)),
    /exactly one completion/u,
  );

  const duplicateTerminal = [...events, structuredClone(events.at(-1))];
  duplicateTerminal.at(-1).timestamp = "2026-07-19T20:03:00.020Z";
  assert.throws(
    () => buildObservabilityDrillReport(serialize(duplicateTerminal)),
    /one start and one terminal/u,
  );

  const mixedTrace = structuredClone(events);
  mixedTrace[1].trace_id = "fedcba0987654321-SJC";
  assert.throws(
    () => buildObservabilityDrillReport(serialize(mixedTrace)),
    /changes trace_id/u,
  );

  const mixedActor = structuredClone(events);
  mixedActor[1].actor_session_key = "b".repeat(64);
  assert.throws(
    () => buildObservabilityDrillReport(serialize(mixedActor)),
    /changes actor_session_key/u,
  );
});
