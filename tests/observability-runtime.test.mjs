import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  attachRequestId,
  internalErrorResponse,
  logEvent,
  logRequestCompleted,
  observeQueueTask,
  observeScheduledTask,
  requestLogContext,
  routeTemplate,
  runWithLogContext,
} from "../worker/observability.ts";

const SECRET = "observability-test-secret-material-32-bytes-minimum";
const SESSION = "session_token_material_that_is_long_enough_for_validation_123";

async function contextFor(path, options = {}) {
  return requestLogContext(new Request(`https://castingcompass.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      Cookie: `__Host-cc_session=${SESSION}; unrelated=private-value`,
      "CF-Ray": "1234567890abcdef-SJC",
    },
  }), {
    OBSERVABILITY_PSEUDONYM_SECRET: SECRET,
    CF_VERSION_METADATA: { id: "version-safe-123" },
    LOG_LEVEL: options.logLevel,
  });
}

async function capture(method, callback) {
  const original = console[method];
  const entries = [];
  console[method] = (...values) => entries.push(values);
  try {
    await callback();
  } finally {
    console[method] = original;
  }
  return entries;
}

test("request context uses server correlation and a secret-keyed session pseudonym", async () => {
  const first = await contextFor("/api/profile/export?private=ignored");
  const second = await contextFor("/api/profile/export?different=ignored");

  assert.match(first.requestId, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(first.traceId, "1234567890abcdef-SJC");
  assert.equal(first.route, "/api/profile/export");
  assert.equal(first.environment, "production");
  assert.match(first.actorSessionKey, /^[a-f0-9]{64}$/);
  assert.equal(first.actorSessionKey, second.actorSessionKey);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(SESSION));

  const withoutSecret = await requestLogContext(
    new Request("https://castingcompass.com/api/profile", {
      headers: { Cookie: `__Host-cc_session=${SESSION}` },
    }),
    {},
  );
  assert.equal(withoutSecret.actorSessionKey, null);

  const withoutRuntimeEnv = await requestLogContext(
    new Request("http://localhost/", {
      headers: { Cookie: `__Host-cc_session=${SESSION}` },
    }),
    undefined,
  );
  assert.equal(withoutRuntimeEnv.environment, "development");
  assert.equal(withoutRuntimeEnv.workerVersionId, null);
  assert.equal(withoutRuntimeEnv.actorSessionKey, null);
});

test("route templates preserve operations but discard identifiers and hostile unknown paths", () => {
  assert.equal(
    routeTemplate("/api/profile/exports/pexj_0123456789abcdef0123456789abcdef"),
    "/api/profile/exports/:job_id",
  );
  assert.equal(
    routeTemplate("/api/profile/exports/pexj_0123456789abcdef0123456789abcdef/download"),
    "/api/profile/exports/:job_id/download",
  );
  assert.equal(
    routeTemplate("/api/profile/export/photos/trip_12345678-1234-1234-1234-123456789abc"),
    "/api/profile/export/photos/:trip_id",
  );
  assert.equal(
    routeTemplate("/api/trips/private-trip-value/complete"),
    "/api/trips/:trip_id/complete",
  );
  assert.equal(routeTemplate("/api/private.angler@example.com"), "/api/:unknown");
  assert.equal(routeTemplate("/private-person-name"), "/:unknown");
  assert.equal(routeTemplate("/_next/static/chunks/private-hash.js"), "/:asset");
});

test("structured logs correlate requests and reject sensitive or unbounded fields", async () => {
  const context = await contextFor("/api/auth/login", { method: "POST", logLevel: "debug" });
  const entries = await capture("log", async () => {
    runWithLogContext(context, () => logEvent("info", "account.login.completed", {
      outcome: "ok",
      email: "private.angler@example.com",
      user_id: "user_private",
      actor_key: "user_private",
      request_id: "attacker_selected",
      unsafe_value: "private.angler@example.com bearer secret",
    }));
  });

  assert.equal(entries.length, 1);
  const entry = entries[0][0];
  assert.equal(entry.schema_version, "castingcompass.log/1.0.0");
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "account.login.completed");
  assert.equal(entry.request_id, context.requestId);
  assert.equal(entry.actor_session_key, context.actorSessionKey);
  assert.equal(entry.route, "/api/auth/login");
  assert.equal(entry.outcome, "ok");
  assert.equal("email" in entry, false);
  assert.equal("user_id" in entry, false);
  assert.equal("actor_key" in entry, false);
  assert.notEqual(entry.request_id, "attacker_selected");
  assert.equal("unsafe_value" in entry, false);
  assert.doesNotMatch(JSON.stringify(entry), /private\.angler|user_private|bearer|session_token/);
});

test("production suppresses debug asset logs while retaining errors and request IDs", async () => {
  const context = await contextFor("/_next/static/chunks/app.js");
  const debugEntries = await capture("log", async () => {
    runWithLogContext(context, () => logRequestCompleted(new Response("ok"), 12.345));
  });
  assert.deepEqual(debugEntries, []);

  const errorEntries = await capture("error", async () => {
    runWithLogContext(context, () => logEvent("error", "http.request.exception", {
      error_name: "Error",
      error_code: "asset_failed",
    }));
  });
  assert.equal(errorEntries.length, 1);
  assert.equal(errorEntries[0][0].request_id, context.requestId);

  const attached = attachRequestId(new Response("ok"), context.requestId);
  assert.equal(attached.headers.get("X-Request-ID"), context.requestId);
});

test("internal failures are generic, non-cacheable, and scheduled errors omit exception messages", async () => {
  const api = internalErrorResponse(new Request("https://castingcompass.com/api/profile"));
  assert.equal(api.status, 500);
  assert.equal(api.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await api.json(), {
    error: { code: "internal_error", message: "The request could not be completed." },
  });

  const secretMessage = "private.angler@example.com bearer-secret-value";
  const originalLog = console.log;
  console.log = () => undefined;
  let entries;
  try {
    entries = await capture("error", () => observeScheduledTask(
      { CF_VERSION_METADATA: { id: "version-safe-123" } },
      "auth_data_cleanup",
      async () => { throw new Error(secretMessage); },
    ));
  } finally {
    console.log = originalLog;
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0].event, "scheduled.task.failed");
  assert.equal(entries[0][0].task, "auth_data_cleanup");
  assert.doesNotMatch(JSON.stringify(entries), /private\.angler|bearer-secret-value/);
});

test("queue failures keep correlation and redaction while propagating for provider retry", async () => {
  const secretMessage = "private.angler@example.com bearer-queue-secret";
  const originalLog = console.log;
  console.log = () => undefined;
  let entries;
  try {
    entries = await capture("error", async () => {
      await assert.rejects(observeQueueTask(
        { CF_VERSION_METADATA: { id: "version-safe-queue" } },
        "ai_review_consumer",
        async () => { throw new Error(secretMessage); },
      ), /bearer-queue-secret/);
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0].event, "queue.task.failed");
  assert.equal(entries[0][0].environment, "queue");
  assert.equal(entries[0][0].task, "ai_review_consumer");
  assert.equal(entries[0][0].worker_version_id, "version-safe-queue");
  assert.doesNotMatch(JSON.stringify(entries), /private\.angler|bearer-queue-secret/);
});

test("Wrangler stores only normalized custom logs and the Worker has one console boundary", async () => {
  const [configSource, workerSource, policy, workerFiles] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../worker/observability.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/OBSERVABILITY.md", import.meta.url), "utf8"),
    readdir(new URL("../worker", import.meta.url)),
  ]);
  const config = JSON.parse(configSource);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.observability.logs.head_sampling_rate, 1);
  assert.match(workerSource, /AsyncLocalStorage/);
  assert.match(workerSource, /FORBIDDEN_FIELD_NAME/);
  for (const name of workerFiles.filter((candidate) => candidate.endsWith(".ts") && candidate !== "observability.ts")) {
    const source = await readFile(new URL(`../worker/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /console\.(?:log|warn|error)\s*\(/, `${name} must use logEvent`);
  }
  assert.match(policy, /PostHog.*deferred/is);
  assert.match(policy, /Financial reporting must never/is);
});
