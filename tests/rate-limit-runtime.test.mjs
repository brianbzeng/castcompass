import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  aiProviderRateLimitAllowed,
  enforceRequestRateLimit,
  requestLimitClasses,
} from "../worker/rate-limit.ts";

class MockLimiter {
  constructor(success = true) {
    this.success = success;
    this.calls = [];
    this.error = null;
  }

  async limit(options) {
    this.calls.push(options);
    if (this.error) throw this.error;
    return { success: this.success };
  }
}

const SECRET = "rate-limit-test-secret-material-32-bytes-minimum";

function request(path, { method = "GET", address = "203.0.113.42" } = {}) {
  return new Request(`https://castingcompass.com${path}`, {
    method,
    headers: address ? { "CF-Connecting-IP": address } : undefined,
  });
}

function enabledEnv() {
  return {
    RATE_LIMITING_ENABLED: "true",
    RATE_LIMIT_KEY_SECRET: SECRET,
    AUTH_RATE_LIMITER: new MockLimiter(),
    EMAIL_RATE_LIMITER: new MockLimiter(),
    WRITE_RATE_LIMITER: new MockLimiter(),
    SENSITIVE_RATE_LIMITER: new MockLimiter(),
    READ_RATE_LIMITER: new MockLimiter(),
    AI_PROVIDER_RATE_LIMITER: new MockLimiter(),
  };
}

test("rate-limit route policy covers auth, email, writes, reads, sensitive work, and health exclusion", () => {
  assert.deepEqual(requestLimitClasses(request("/api/auth/login", { method: "POST" })), ["auth"]);
  assert.deepEqual(
    requestLimitClasses(request("/api/auth/signup/request", { method: "POST" })),
    ["auth", "email"],
  );
  assert.deepEqual(requestLimitClasses(request("/api/trips/report", { method: "POST" })), ["write"]);
  assert.deepEqual(requestLimitClasses(request("/api/profile", { method: "DELETE" })), ["sensitive", "write"]);
  assert.deepEqual(requestLimitClasses(request("/api/profile/export")), ["read", "sensitive"]);
  assert.deepEqual(requestLimitClasses(request("/api/discussions/ocean-beach")), ["read"]);
  assert.deepEqual(requestLimitClasses(request("/api/health")), []);
  assert.deepEqual(requestLimitClasses(request("/privacy")), []);
});

test("request limiters receive only a stable HMAC pseudonym, never the network address", async () => {
  const env = enabledEnv();
  const response = await enforceRequestRateLimit(
    request("/api/auth/signup/request", { method: "POST" }),
    env,
  );
  assert.equal(response, null);
  assert.equal(env.AUTH_RATE_LIMITER.calls.length, 1);
  assert.equal(env.EMAIL_RATE_LIMITER.calls.length, 1);
  const authKey = env.AUTH_RATE_LIMITER.calls[0].key;
  assert.match(authKey, /^[a-f0-9]{64}$/);
  assert.equal(env.EMAIL_RATE_LIMITER.calls[0].key, authKey);
  assert.doesNotMatch(authKey, /203\.0\.113\.42/);

  await enforceRequestRateLimit(request("/api/auth/login", { method: "POST" }), env);
  assert.equal(env.AUTH_RATE_LIMITER.calls[1].key, authKey);
  await enforceRequestRateLimit(request("/api/auth/login", { method: "POST", address: "203.0.113.43" }), env);
  assert.notEqual(env.AUTH_RATE_LIMITER.calls[2].key, authKey);

  await enforceRequestRateLimit(request("/api/auth/login", { method: "POST", address: "2001:0db8::1" }), env);
  const expandedIpv6Key = env.AUTH_RATE_LIMITER.calls[3].key;
  await enforceRequestRateLimit(request("/api/auth/login", { method: "POST", address: "2001:db8::1" }), env);
  assert.equal(env.AUTH_RATE_LIMITER.calls[4].key, expandedIpv6Key);
});

test("rate-limit denials are generic, non-cacheable 429 responses", async () => {
  const env = enabledEnv();
  env.SENSITIVE_RATE_LIMITER.success = false;
  const response = await enforceRequestRateLimit(request("/api/profile/export"), env);
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("Retry-After"), "60");
  assert.equal(response?.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response?.json(), {
    error: {
      code: "rate_limited",
      message: "Too many requests were received. Try again shortly.",
    },
  });
  assert.equal(env.READ_RATE_LIMITER.calls.length, 1);
  assert.equal(env.SENSITIVE_RATE_LIMITER.calls.length, 1);
});

test("enabled rate limiting fails closed on missing, malformed, or unavailable controls", async () => {
  const missingSecret = enabledEnv();
  delete missingSecret.RATE_LIMIT_KEY_SECRET;
  const secretResponse = await enforceRequestRateLimit(request("/api/auth/login", { method: "POST" }), missingSecret);
  assert.equal(secretResponse?.status, 503);
  assert.equal((await secretResponse?.json()).error.code, "security_control_unavailable");

  const missingAddress = await enforceRequestRateLimit(
    request("/api/auth/login", { method: "POST", address: "" }),
    enabledEnv(),
  );
  assert.equal(missingAddress?.status, 503);

  const malformedAddress = await enforceRequestRateLimit(
    request("/api/auth/login", { method: "POST", address: ":::" }),
    enabledEnv(),
  );
  assert.equal(malformedAddress?.status, 503);

  const missingBinding = enabledEnv();
  delete missingBinding.AUTH_RATE_LIMITER;
  assert.equal((await enforceRequestRateLimit(
    request("/api/auth/login", { method: "POST" }),
    missingBinding,
  ))?.status, 503);

  const invalidMode = enabledEnv();
  invalidMode.RATE_LIMITING_ENABLED = "TRUE";
  assert.equal((await enforceRequestRateLimit(
    request("/api/auth/login", { method: "POST" }),
    invalidMode,
  ))?.status, 503);

  const unavailable = enabledEnv();
  unavailable.AUTH_RATE_LIMITER.error = new Error("private.angler@example.com 203.0.113.42");
  const original = console.error;
  const entries = [];
  console.error = (...values) => entries.push(values);
  try {
    assert.equal((await enforceRequestRateLimit(
      request("/api/auth/login", { method: "POST" }),
      unavailable,
    ))?.status, 503);
  } finally {
    console.error = original;
  }
  assert.doesNotMatch(JSON.stringify(entries), /private\.angler|203\.0\.113\.42/);
});

test("default-off rate limiting does not touch bindings", async () => {
  const env = enabledEnv();
  env.RATE_LIMITING_ENABLED = "false";
  assert.equal(await enforceRequestRateLimit(request("/api/auth/login", { method: "POST" }), env), null);
  assert.equal(env.AUTH_RATE_LIMITER.calls.length, 0);
  assert.equal(await aiProviderRateLimitAllowed(env), true);
  assert.equal(env.AI_PROVIDER_RATE_LIMITER.calls.length, 0);
});

test("the AI-provider ceiling is global, fail-closed, and content-free", async () => {
  const env = enabledEnv();
  assert.equal(await aiProviderRateLimitAllowed(env), true);
  assert.deepEqual(env.AI_PROVIDER_RATE_LIMITER.calls, [{ key: "castingcompass.ai-review/1" }]);

  env.AI_PROVIDER_RATE_LIMITER.success = false;
  const original = console.warn;
  const entries = [];
  console.warn = (...values) => entries.push(values);
  try {
    assert.equal(await aiProviderRateLimitAllowed(env), false);
  } finally {
    console.warn = original;
  }
  assert.match(JSON.stringify(entries), /ai_provider_rate_limited/);
  assert.doesNotMatch(JSON.stringify(entries), /trip|user|email|note/i);
});

test("Wrangler declares unique reviewed ceilings but keeps activation default-off", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.vars.RATE_LIMITING_ENABLED, "false");
  assert.equal("RATE_LIMIT_KEY_SECRET" in config.vars, false);
  assert.deepEqual(config.ratelimits.map((entry) => [entry.name, entry.simple.limit, entry.simple.period]), [
    ["AUTH_RATE_LIMITER", 20, 60],
    ["EMAIL_RATE_LIMITER", 5, 60],
    ["WRITE_RATE_LIMITER", 30, 60],
    ["SENSITIVE_RATE_LIMITER", 6, 60],
    ["READ_RATE_LIMITER", 120, 60],
    ["AI_PROVIDER_RATE_LIMITER", 20, 60],
  ]);
  assert.equal(new Set(config.ratelimits.map((entry) => entry.namespace_id)).size, config.ratelimits.length);
  for (const entry of config.ratelimits) assert.match(entry.namespace_id, /^[1-9]\d*$/);

  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.ok(
    worker.indexOf("enforceRequestRateLimit(request, env)") < worker.indexOf("guardRequestBody(request)"),
    "the edge ceiling must run before request bodies and route handlers",
  );

  const operations = await readFile(new URL("../docs/PRODUCTION-OPERATIONS.md", import.meta.url), "utf8");
  assert.match(operations, /RATE_LIMIT_KEY_SECRET/);
  assert.match(operations, /local to a Cloudflare location and eventually\s+consistent/);
  assert.match(operations, /durable D1 ceilings/);
  assert.match(operations, /Outer Cloudflare rate-limiting rules/);
});
