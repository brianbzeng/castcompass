import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAccountRequest,
  turnstileActionForAccountRequest,
} from "../worker/auth.ts";
import {
  TURNSTILE_ACTIONS,
  TurnstileVerificationError,
  handleTurnstileConfigRequest,
  verifyTurnstileChallenge,
} from "../worker/turnstile.ts";

const TOKEN = "turnstile-token-value";
const SITE_KEY = "1x00000000000000000000AA";
const SECRET_KEY = "1x0000000000000000000000000000000AA";
const ENABLED_ENV = {
  TURNSTILE_ENABLED: "true",
  TURNSTILE_SITE_KEY: SITE_KEY,
  TURNSTILE_SECRET_KEY: SECRET_KEY,
  TURNSTILE_ALLOWED_HOSTNAMES: "castingcompass.com,www.castingcompass.com",
};

function turnstileError(status, code) {
  return (error) => {
    assert.ok(error instanceof TurnstileVerificationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /token-value|1x000|secret|hostname|action/i);
    return true;
  };
}

async function withFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("runtime config is default-off, D1-independent, schema-closed, and never exposes secrets", async () => {
  const disabled = handleTurnstileConfigRequest(
    new Request("https://castingcompass.com/api/auth/turnstile-config"),
    { TURNSTILE_SECRET_KEY: SECRET_KEY, TURNSTILE_ALLOWED_HOSTNAMES: "private.example" },
  );
  assert.equal(disabled?.status, 200);
  assert.deepEqual(await disabled?.json(), { turnstile: { enabled: false } });

  const enabled = handleTurnstileConfigRequest(
    new Request("https://castingcompass.com/api/auth/turnstile-config"),
    ENABLED_ENV,
  );
  assert.equal(enabled?.status, 200);
  assert.deepEqual(await enabled?.json(), {
    turnstile: { enabled: true, available: true, siteKey: SITE_KEY },
  });
  const serialized = JSON.stringify(await handleTurnstileConfigRequest(
    new Request("https://castingcompass.com/api/auth/turnstile-config"),
    ENABLED_ENV,
  )?.json());
  assert.doesNotMatch(serialized, new RegExp(SECRET_KEY));
  assert.doesNotMatch(serialized, /TURNSTILE_SECRET_KEY|ALLOWED_HOSTNAMES|www\.castingcompass/i);

  const head = handleTurnstileConfigRequest(
    new Request("https://castingcompass.com/api/auth/turnstile-config", { method: "HEAD" }),
    ENABLED_ENV,
  );
  assert.equal(head?.status, 200);
  assert.equal(await head?.text(), "");
  assert.equal(head?.headers.get("Cache-Control"), "no-store");

  const method = handleTurnstileConfigRequest(
    new Request("https://castingcompass.com/api/auth/turnstile-config", { method: "POST" }),
    ENABLED_ENV,
  );
  assert.equal(method?.status, 405);
  assert.equal(method?.headers.get("Allow"), "GET, HEAD");
});

test("the kill switch bypasses Siteverify only when explicitly off or unset", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    throw new Error("should not be called");
  }, async () => {
    await verifyTurnstileChallenge({}, {}, TURNSTILE_ACTIONS.login);
    await verifyTurnstileChallenge({ TURNSTILE_ENABLED: "false" }, {}, TURNSTILE_ACTIONS.login);
  });
  assert.equal(calls, 0);

  for (const env of [
    { ...ENABLED_ENV, TURNSTILE_SECRET_KEY: undefined },
    { ...ENABLED_ENV, TURNSTILE_SITE_KEY: undefined },
    { ...ENABLED_ENV, TURNSTILE_ALLOWED_HOSTNAMES: undefined },
    { ...ENABLED_ENV, TURNSTILE_ALLOWED_HOSTNAMES: "https://castingcompass.com" },
    { ...ENABLED_ENV, TURNSTILE_ENABLED: "TRUE" },
  ]) {
    const config = handleTurnstileConfigRequest(
      new Request("https://castingcompass.com/api/auth/turnstile-config"),
      env,
    );
    assert.equal(config?.status, 503);
    assert.deepEqual((await config?.json()).turnstile, { enabled: true, available: false });
    await assert.rejects(
      verifyTurnstileChallenge(env, { turnstileToken: TOKEN }, TURNSTILE_ACTIONS.login),
      turnstileError(503, "security_verification_unavailable"),
    );
  }
});

test("Siteverify receives only the secret, token, and random idempotency key", async () => {
  let calls = 0;
  await withFetch(async (url, init) => {
    calls += 1;
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    assert.ok(init.signal instanceof AbortSignal);
    const parameters = new URLSearchParams(String(init.body));
    assert.deepEqual([...parameters.keys()].sort(), ["idempotency_key", "response", "secret"]);
    assert.equal(parameters.get("secret"), SECRET_KEY);
    assert.equal(parameters.get("response"), TOKEN);
    assert.match(parameters.get("idempotency_key") ?? "", /^[a-f0-9-]{36}$/);
    assert.equal(parameters.has("remoteip"), false);
    assert.equal(parameters.has("cdata"), false);
    assert.doesNotMatch(String(init.body), /private-angler|correct-horse|1990-01-01|user_/);
    return Response.json({ success: true, action: "login", hostname: "castingcompass.com" });
  }, () => verifyTurnstileChallenge(ENABLED_ENV, {
    turnstileToken: TOKEN,
    email: "private-angler@example.com",
    password: "correct-horse-battery-staple",
    birthDate: "1990-01-01",
    userId: "user_private",
  }, TURNSTILE_ACTIONS.login));
  assert.equal(calls, 1);
});

test("every protected action accepts only an exact action and allowlisted hostname", async () => {
  for (const action of Object.values(TURNSTILE_ACTIONS)) {
    await withFetch(
      async () => Response.json({ success: true, action, hostname: "castingcompass.com" }),
      () => verifyTurnstileChallenge(ENABLED_ENV, { turnstileToken: TOKEN }, action),
    );
  }

  for (const result of [
    { success: true, action: "password_reset", hostname: "castingcompass.com" },
    { success: true, action: "login", hostname: "attacker.example" },
    { success: true, action: "login", hostname: "CastingCompass.com" },
    { success: true, hostname: "castingcompass.com" },
    { success: true, action: "login" },
  ]) {
    await withFetch(async () => Response.json(result), () => assert.rejects(
      verifyTurnstileChallenge(ENABLED_ENV, { turnstileToken: TOKEN }, TURNSTILE_ACTIONS.login),
      turnstileError(400, "security_verification_failed"),
    ));
  }
});

test("missing and provider-rejected or reused tokens fail without a retry", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return Response.json({ success: true, action: "login", hostname: "castingcompass.com" });
  }, async () => {
    for (const body of [{}, { turnstileToken: "" }, { turnstileToken: " x " }, { turnstileToken: "x".repeat(2_049) }]) {
      await assert.rejects(
        verifyTurnstileChallenge(ENABLED_ENV, body, TURNSTILE_ACTIONS.login),
        turnstileError(422, "security_verification_required"),
      );
    }
  });
  assert.equal(calls, 0);

  await withFetch(async () => {
    calls += 1;
    return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
  }, () => assert.rejects(
    verifyTurnstileChallenge(ENABLED_ENV, { turnstileToken: TOKEN }, TURNSTILE_ACTIONS.login),
    turnstileError(400, "security_verification_failed"),
  ));
  assert.equal(calls, 1, "a reused token is submitted once and never retried or cached");
});

test("provider, network, and malformed-response failures fail closed without sensitive logging", async () => {
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const logs = [];
  console.log = (...values) => logs.push(values);
  console.warn = (...values) => logs.push(values);
  console.error = (...values) => logs.push(values);
  try {
    const providers = [
      async () => new Response(`provider echoed ${SECRET_KEY} ${TOKEN}`, { status: 503 }),
      async () => new Response("not json", { status: 200 }),
      async () => Response.json({ success: false, "error-codes": ["internal-error"] }),
      async () => Response.json({ success: false, "error-codes": ["missing-input-response"] }),
      async () => Response.json({ success: false, "error-codes": ["bad-request"] }),
      async () => { throw new Error(`network included ${SECRET_KEY} ${TOKEN}`); },
    ];
    for (const provider of providers) {
      await withFetch(provider, () => assert.rejects(
        verifyTurnstileChallenge(ENABLED_ENV, { turnstileToken: TOKEN }, TURNSTILE_ACTIONS.login),
        turnstileError(503, "security_verification_unavailable"),
      ));
    }
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  assert.deepEqual(logs, []);
});

test("Siteverify timeout aborts and fails closed", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await withFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), async () => {
    const pending = assert.rejects(
      verifyTurnstileChallenge(ENABLED_ENV, { turnstileToken: TOKEN }, TURNSTILE_ACTIONS.login),
      turnstileError(503, "security_verification_unavailable"),
    );
    context.mock.timers.tick(5_000);
    await pending;
  });
});

test("Siteverify deadline remains active after headers while the response body stalls", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await withFetch(async (_url, init) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      if (init.signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  }), async () => {
    const pending = assert.rejects(
      verifyTurnstileChallenge(ENABLED_ENV, { turnstileToken: TOKEN }, TURNSTILE_ACTIONS.login),
      turnstileError(503, "security_verification_unavailable"),
    );
    context.mock.timers.tick(5_000);
    await pending;
  });
});

test("all seven auth abuse routes are action-bound before D1 and privacy-right routes stay ungated", async () => {
  const expected = new Map([
    ["/api/auth/signup/eligibility", "signup_eligibility"],
    ["/api/auth/signup/request", "signup_request"],
    ["/api/auth/signup/verify", "signup_verify"],
    ["/api/auth/challenge/resend", "challenge_resend"],
    ["/api/auth/password/request", "password_request"],
    ["/api/auth/password/reset", "password_reset"],
    ["/api/auth/login", "login"],
  ]);
  for (const [path, action] of expected) {
    assert.equal(turnstileActionForAccountRequest(new Request(`https://castingcompass.com${path}`, { method: "POST" })), action);
  }
  assert.equal(turnstileActionForAccountRequest(new Request("https://castingcompass.com/api/auth/login")), null);
  assert.equal(turnstileActionForAccountRequest(new Request("https://castingcompass.com/api/profile", { method: "DELETE" })), null);
  assert.equal(turnstileActionForAccountRequest(new Request("https://castingcompass.com/api/profile/export")), null);
  assert.equal(turnstileActionForAccountRequest(new Request("https://castingcompass.com/api/privacy/deletion-status")), null);

  let databaseTouches = 0;
  let providerCalls = 0;
  const DB = {
    prepare() {
      databaseTouches += 1;
      throw new Error("D1 must not be touched before failed challenge verification");
    },
    async batch() {
      databaseTouches += 1;
      throw new Error("D1 must not be touched before failed challenge verification");
    },
  };
  await withFetch(async () => {
    providerCalls += 1;
    return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  }, async () => {
    for (const path of expected.keys()) {
      const response = await handleAccountRequest(new Request(`https://castingcompass.com${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://castingcompass.com" },
        body: JSON.stringify({ turnstileToken: TOKEN }),
      }), { DB, ...ENABLED_ENV }, []);
      assert.equal(response?.status, 400);
      assert.equal((await response?.json()).error.code, "security_verification_failed");
    }
  });
  assert.equal(providerCalls, expected.size);
  assert.equal(databaseTouches, 0);
});

test("wrong-origin requests are rejected before Siteverify and D1", async () => {
  let providerCalls = 0;
  let databaseTouches = 0;
  const response = await withFetch(async () => {
    providerCalls += 1;
    throw new Error("Siteverify must not be called");
  }, () => handleAccountRequest(new Request("https://castingcompass.com/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ turnstileToken: TOKEN }),
  }), {
    DB: {
      prepare() { databaseTouches += 1; throw new Error("D1 must not be called"); },
      async batch() { databaseTouches += 1; return []; },
    },
    ...ENABLED_ENV,
  }, []));
  assert.equal(response?.status, 403);
  assert.equal((await response?.json()).error.code, "invalid_origin");
  assert.equal(providerCalls, 0);
  assert.equal(databaseTouches, 0);
});

test("enabled-but-incomplete auth configuration fails before provider or D1", async () => {
  let providerCalls = 0;
  let databaseTouches = 0;
  const response = await withFetch(async () => {
    providerCalls += 1;
    throw new Error("Siteverify must not be called with incomplete configuration");
  }, () => handleAccountRequest(new Request("https://castingcompass.com/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://castingcompass.com" },
    body: JSON.stringify({ turnstileToken: TOKEN }),
  }), {
    DB: {
      prepare() { databaseTouches += 1; throw new Error("D1 must not be called"); },
      async batch() { databaseTouches += 1; return []; },
    },
    TURNSTILE_ENABLED: "true",
    TURNSTILE_SITE_KEY: SITE_KEY,
    TURNSTILE_ALLOWED_HOSTNAMES: "castingcompass.com",
  }, []));
  assert.equal(response?.status, 503);
  assert.equal((await response?.json()).error.code, "security_verification_unavailable");
  assert.equal(providerCalls, 0);
  assert.equal(databaseTouches, 0);
});
