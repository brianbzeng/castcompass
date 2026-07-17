import assert from "node:assert/strict";
import test from "node:test";

import {
  API_MUTATION_BODY_LIMIT,
  TRIP_MULTIPART_BODY_LIMIT,
  bodyLimitForRequest,
  canonicalRedirect,
  guardRequestBody,
  hardenResponse,
  healthResponse,
  releaseMaintenanceEnabled,
  releaseMaintenanceResponse,
} from "../worker/security.ts";

const ORIGIN = "https://castingcompass.com";

function okDatabase() {
  return {
    prepare(query) {
      assert.equal(query, "SELECT 1 AS ok");
      return { first: async () => ({ ok: 1 }) };
    },
  };
}

test("canonical redirects preserve path and query without redirecting preview hosts", () => {
  const aliasRequest = new Request("http://www.castingcompass.com:8080/locations/ocean-beach?day=2");
  const aliasResponse = canonicalRedirect(aliasRequest);
  assert.equal(aliasResponse?.status, 308);
  assert.equal(aliasResponse?.headers.get("Location"), "https://castingcompass.com/locations/ocean-beach?day=2");

  const cleartextCanonical = canonicalRedirect(new Request("http://castingcompass.com/privacy"));
  assert.equal(cleartextCanonical?.headers.get("Location"), "https://castingcompass.com/privacy");

  assert.equal(canonicalRedirect(new Request(`${ORIGIN}/privacy`)), null);
  assert.equal(canonicalRedirect(new Request("https://contourcast-halibut.workers.dev/privacy")), null);
  assert.equal(canonicalRedirect(new Request("https://example.com/privacy")), null);
});

test("health endpoint reports D1 readiness, Worker version, and supports HEAD", async () => {
  const env = { DB: okDatabase(), CF_VERSION_METADATA: { id: "version-123" } };
  const get = await healthResponse(new Request(`${ORIGIN}/api/health`), env);
  assert.equal(get?.status, 200);
  assert.deepEqual(await get?.json(), {
    status: "ok",
    service: "castingcompass-web",
    workerVersionId: "version-123",
    releaseMaintenance: false,
  });
  assert.equal(get?.headers.get("Cache-Control"), "no-store");

  const head = await healthResponse(new Request(`${ORIGIN}/api/health`, { method: "HEAD" }), env);
  assert.equal(head?.status, 200);
  assert.equal(await head?.text(), "");

  const degraded = await healthResponse(new Request(`${ORIGIN}/api/health`), {});
  assert.equal(degraded?.status, 503);
  assert.deepEqual(await degraded?.json(), {
    status: "degraded",
    service: "castingcompass-web",
    workerVersionId: null,
    releaseMaintenance: false,
  });

  const post = await healthResponse(new Request(`${ORIGIN}/api/health`, { method: "POST" }), { DB: okDatabase() });
  assert.equal(post?.status, 405);
  assert.equal(post?.headers.get("Allow"), "GET, HEAD");

  assert.equal(await healthResponse(new Request(`${ORIGIN}/api/other`), { DB: okDatabase() }), null);
});

test("release maintenance stops APIs before handlers while preserving health and pages", async () => {
  const enabled = { RELEASE_MAINTENANCE_MODE: "true" };
  assert.equal(releaseMaintenanceEnabled(enabled), true);
  assert.equal(releaseMaintenanceEnabled({ RELEASE_MAINTENANCE_MODE: "invalid" }), true);
  assert.equal(releaseMaintenanceEnabled({ RELEASE_MAINTENANCE_MODE: "false" }), false);
  assert.equal(releaseMaintenanceEnabled({}), false);
  assert.equal(releaseMaintenanceEnabled(undefined), false);
  assert.equal(releaseMaintenanceResponse(new Request(`${ORIGIN}/privacy`), undefined), null);

  const response = releaseMaintenanceResponse(
    new Request(`${ORIGIN}/api/trips/trip_123/complete`, { method: "POST", body: "large-body-not-read" }),
    enabled,
  );
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("Retry-After"), "300");
  assert.equal(response?.headers.get("Cache-Control"), "no-store");
  assert.equal((await response?.json()).error.code, "release_maintenance");
  assert.equal(releaseMaintenanceResponse(new Request(`${ORIGIN}/api/health`), enabled), null);
  assert.equal(releaseMaintenanceResponse(new Request(`${ORIGIN}/privacy`), enabled), null);

  const health = await healthResponse(new Request(`${ORIGIN}/api/health`), {
    ...enabled,
    DB: okDatabase(),
  });
  assert.equal((await health?.json()).releaseMaintenance, true);
});

test("mutation limits are narrow for JSON routes and allow photo multipart routes", () => {
  const json = new Request(`${ORIGIN}/api/auth/login`, { method: "POST", body: "{}" });
  assert.equal(bodyLimitForRequest(json), API_MUTATION_BODY_LIMIT);

  const report = new Request(`${ORIGIN}/api/trips/report`, { method: "POST", body: "form" });
  assert.equal(bodyLimitForRequest(report), TRIP_MULTIPART_BODY_LIMIT);

  const complete = new Request(`${ORIGIN}/api/trips/trip_123/complete`, { method: "POST", body: "form" });
  assert.equal(bodyLimitForRequest(complete), TRIP_MULTIPART_BODY_LIMIT);

  assert.equal(bodyLimitForRequest(new Request(`${ORIGIN}/api/profile`)), null);
  assert.equal(bodyLimitForRequest(new Request(`${ORIGIN}/contact`, { method: "POST", body: "hello" })), null);
});

test("body guard rejects declared and actual oversized payloads", async () => {
  const declared = new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Length": String(API_MUTATION_BODY_LIMIT + 1) },
    body: "{}",
  });
  const declaredResult = await guardRequestBody(declared);
  assert.equal(declaredResult.request, null);
  assert.equal(declaredResult.response?.status, 413);
  assert.equal((await declaredResult.response?.json()).error.code, "payload_too_large");

  const bytes = new Uint8Array(API_MUTATION_BODY_LIMIT + 1).fill(97);
  const streamed = new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Length": "1" },
    body: bytes,
  });
  const streamedResult = await guardRequestBody(streamed);
  assert.equal(streamedResult.request, null);
  assert.equal(streamedResult.response?.status, 413);
});

test("body guard rebuilds allowed request bytes for downstream parsers", async () => {
  const payload = JSON.stringify({ email: "angler@example.com", password: "test-value" });
  const original = new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "1",
      "X-Test-Header": "preserved",
    },
    body: payload,
  });
  const result = await guardRequestBody(original);
  assert.equal(result.response, null);
  assert.equal(result.request?.method, "POST");
  assert.equal(result.request?.headers.get("Content-Type"), "application/json");
  assert.equal(result.request?.headers.get("X-Test-Header"), "preserved");
  assert.equal(result.request?.headers.has("Content-Length"), false);
  assert.equal(await result.request?.text(), payload);
});

test("body guard preserves multipart boundaries for trip handlers", async () => {
  const form = new FormData();
  form.set("token", "safe-token");
  form.set("notes", "Observed moderate shorebreak.");
  const original = new Request(`${ORIGIN}/api/trips/trip_123/complete`, {
    method: "POST",
    body: form,
  });

  const result = await guardRequestBody(original);
  assert.equal(result.response, null);
  const rebuilt = await result.request?.formData();
  assert.equal(rebuilt?.get("token"), "safe-token");
  assert.equal(rebuilt?.get("notes"), "Observed moderate shorebreak.");
});

test("central hardening prevents API caching and preserves explicit asset caching", () => {
  const apiRequest = new Request(`${ORIGIN}/api/discussions/ocean-beach`);
  const apiResponse = hardenResponse(new Response("{}", {
    headers: { "Cache-Control": "public, max-age=600" },
  }), apiRequest);
  assert.equal(apiResponse.headers.get("Cache-Control"), "no-store");
  assert.equal(apiResponse.headers.get("CDN-Cache-Control"), "no-store");
  assert.equal(apiResponse.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(apiResponse.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(apiResponse.headers.get("X-Frame-Options"), "DENY");
  assert.equal(apiResponse.headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.match(apiResponse.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);

  const assetResponse = hardenResponse(new Response("asset", {
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  }), new Request(`${ORIGIN}/_next/static/app.js`));
  assert.equal(assetResponse.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(assetResponse.headers.has("CDN-Cache-Control"), false);

  const previewResponse = hardenResponse(
    new Response("page"),
    new Request("https://contourcast-halibut.preview.workers.dev/"),
  );
  assert.equal(previewResponse.headers.get("X-Robots-Tag"), "noindex, nofollow");

  const cookieResponse = hardenResponse(new Response("page", {
    headers: { "Set-Cookie": "cc_session=secret; Secure; HttpOnly" },
  }), new Request(`${ORIGIN}/account`));
  assert.equal(cookieResponse.headers.get("Cache-Control"), "no-store");
});

test("canonical page redirects have bounded caching while API redirects never cache", () => {
  const pageRequest = new Request("https://www.castingcompass.com/about");
  const page = hardenResponse(canonicalRedirect(pageRequest), pageRequest);
  assert.equal(page.headers.get("Cache-Control"), "public, max-age=3600");

  const apiRequest = new Request("https://www.castingcompass.com/api/health");
  const api = hardenResponse(canonicalRedirect(apiRequest), apiRequest);
  assert.equal(api.headers.get("Cache-Control"), "no-store");

  const appRedirect = hardenResponse(
    Response.redirect(`${ORIGIN}/profile`, 302),
    new Request(`${ORIGIN}/account`),
  );
  assert.equal(appRedirect.headers.get("Cache-Control"), "no-store");
  assert.equal(appRedirect.headers.get("CDN-Cache-Control"), "no-store");
});
