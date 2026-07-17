import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAccountRequest } from "../worker/auth.ts";
import { reviewTripWithMimo } from "../worker/trip-review.ts";
import { handleTripRequest } from "../worker/trips.ts";

class D1StatementAdapter {
  constructor(statement) {
    this.statement = statement;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }

  async all() {
    return { results: this.statement.all(...this.values) };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1Adapter {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(query) {
    return new D1StatementAdapter(this.sqlite.prepare(query));
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function serializedLogs(entries) {
  return entries.map((entry) => entry.map((value) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ")).join("\n");
}

async function withCapturedConsole(method, callback) {
  const original = console[method];
  const entries = [];
  console[method] = (...values) => entries.push(values);
  try {
    return { value: await callback(), entries };
  } finally {
    console[method] = original;
  }
}

async function signupRequest(d1, email) {
  const eligibility = await handleAccountRequest(new Request("https://castingcompass.com/api/auth/signup/eligibility", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://castingcompass.com",
    },
    body: JSON.stringify({ birthDate: "1990-01-01" }),
  }), { DB: d1 }, []);
  const { eligibilityProof } = await eligibility.json();
  return new Request("https://castingcompass.com/api/auth/signup/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://castingcompass.com",
    },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery-staple",
      eligibilityProof,
      termsAccepted: true,
      privacyAccepted: true,
    }),
  });
}

function authDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      age_eligibility_confirmed_at TEXT, terms_accepted_at TEXT, terms_version TEXT,
      privacy_accepted_at TEXT, privacy_version TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE saved_sites (
      user_id TEXT NOT NULL, site_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, site_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE auth_attempts (
      id TEXT PRIMARY KEY NOT NULL, email_hash TEXT NOT NULL,
      attempted_at TEXT NOT NULL, successful INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE email_challenges (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, email TEXT NOT NULL,
      user_id TEXT, code_hash TEXT NOT NULL, password_salt TEXT, password_hash TEXT,
      age_eligibility_confirmed_at TEXT, terms_version TEXT, privacy_version TEXT,
      expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      resend_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE gear_profiles (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
      rod TEXT, reel TEXT, bait_lure TEXT, rig TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  return { sqlite, d1: new D1Adapter(sqlite) };
}

test("email-provider failures log status metadata but not recipient or provider body", async () => {
  const { d1 } = authDatabase();
  const recipient = "private.angler@example.com";
  const signup = await signupRequest(d1, recipient);
  const providerBody = `delivery rejected for ${recipient}; api_key=super-secret-value`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).startsWith("https://api.pwnedpasswords.com/range/")
    ? new Response(`${"0".repeat(35)}:0`)
    : new Response(providerBody, {
        status: 400,
        headers: { "x-request-id": "req_safe-123" },
      });

  try {
    const { value: response, entries } = await withCapturedConsole("error", () =>
      handleAccountRequest(
        signup,
        { DB: d1, RESEND_API_KEY: "test-key" },
        [],
      ));
    assert.equal(response?.status, 502);
    assert.equal((await response?.json()).error.code, "email_delivery_failed");
    const logs = serializedLogs(entries);
    assert.match(logs, /"status":400/);
    assert.match(logs, /req_safe-123/);
    assert.doesNotMatch(logs, /private\.angler|example\.com|super-secret-value|api_key/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepted email logs omit the recipient", async () => {
  const { d1 } = authDatabase();
  const recipient = "private.angler@example.com";
  const signup = await signupRequest(d1, recipient);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).startsWith("https://api.pwnedpasswords.com/range/")
    ? new Response(`${"0".repeat(35)}:0`)
    : Response.json({ id: "email_safe-123" });

  try {
    const { value: response, entries } = await withCapturedConsole("log", () =>
      handleAccountRequest(
        signup,
        { DB: d1, RESEND_API_KEY: "test-key" },
        [],
      ));
    assert.equal(response?.status, 200);
    const logs = serializedLogs(entries);
    assert.match(logs, /email_safe-123/);
    assert.doesNotMatch(logs, /private\.angler|example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepted email logs reject untrusted provider receipt text", async () => {
  const { d1 } = authDatabase();
  const recipient = "private.angler@example.com";
  const signup = await signupRequest(d1, recipient);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).startsWith("https://api.pwnedpasswords.com/range/")
    ? new Response(`${"0".repeat(35)}:0`)
    : Response.json({ id: `accepted for ${recipient}; bearer-secret` });

  try {
    const { value: response, entries } = await withCapturedConsole("log", () =>
      handleAccountRequest(
        signup,
        { DB: d1, RESEND_API_KEY: "test-key" },
        [],
      ));
    assert.equal(response?.status, 200);
    const logs = serializedLogs(entries);
    assert.doesNotMatch(logs, /private\.angler|example\.com|bearer-secret|accepted for/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deferred recovery failures stay generic, remove the challenge, and redact provider data", async () => {
  const { sqlite, d1 } = authDatabase();
  const recipient = "recovery.private@example.com";
  const timestamp = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users
      (id, email, password_salt, password_hash, age_eligibility_confirmed_at,
        terms_accepted_at, terms_version, privacy_accepted_at, privacy_version,
        created_at, updated_at)
    VALUES ('user_recovery', ?, 'salt', 'hash', ?, ?, 'test', ?, 'test', ?, ?)`)
    .run(recipient, timestamp, timestamp, timestamp, timestamp, timestamp);
  const providerBody = `delivery rejected for ${recipient}; bearer super-secret-value`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(providerBody, {
    status: 400,
    headers: { "x-request-id": "req_recovery-safe" },
  });

  try {
    const deferred = [];
    const { value: response, entries } = await withCapturedConsole("error", async () => {
      const result = await handleAccountRequest(new Request("https://castingcompass.com/api/auth/password/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://castingcompass.com",
        },
        body: JSON.stringify({ email: recipient }),
      }), { DB: d1, RESEND_API_KEY: "test-key" }, [], {
        waitUntil: (promise) => deferred.push(promise),
      });
      await Promise.all(deferred);
      return result;
    });
    assert.equal(response?.status, 200);
    assert.equal((await response.json()).requested, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM email_challenges WHERE email = ?").get(recipient).count, 0);
    const logs = serializedLogs(entries);
    assert.match(logs, /"status":400/);
    assert.match(logs, /req_recovery-safe/);
    assert.doesNotMatch(logs, /recovery\.private|example\.com|super-secret-value|bearer/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI-provider failures do not log upstream response bodies", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE trips (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    site_id TEXT,
    ai_review_status TEXT,
    ai_review_model TEXT,
    ai_review_json TEXT,
    ai_reviewed_at TEXT
  );
  CREATE TABLE privacy_deletion_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    subject_hash TEXT NOT NULL,
    owner_subject_hash TEXT NOT NULL
  );
  INSERT INTO trips (id, status, site_id) VALUES ('trip_safe', 'completed', 'ocean-beach');`);
  const d1 = new D1Adapter(sqlite);
  const originalFetch = globalThis.fetch;
  const providerBody = "model error includes private.angler@example.com and bearer-secret";
  globalThis.fetch = async () => new Response(providerBody, { status: 429 });

  const trip = {
    id: "trip_safe",
    status: "completed",
    site_id: "ocean-beach",
    started_at: "2026-07-01T10:00:00.000Z",
    ended_at: "2026-07-01T12:00:00.000Z",
    mode: "shore",
    fishing_method: "artificial-lure",
    gear: null,
    rod: null,
    reel: null,
    bait_lure: "swimbait",
    rig: null,
    angler_count: 1,
    angler_hours: 2,
    keeper_count: 0,
    short_released_count: 0,
    halibut_encounters: 0,
    no_catch: 1,
    other_catch_count: 0,
    other_species: null,
    observations_json: null,
    fishability_score: null,
    prediction_metadata_json: null,
    notes: "Moderate shorebreak.",
  };

  try {
    const { entries } = await withCapturedConsole("error", () =>
      reviewTripWithMimo({ DB: d1, MIMO_API_KEY: "test-key" }, trip, [{ id: "ocean-beach", type: "beach" }]));
    const logs = serializedLogs(entries);
    assert.match(logs, /"status":429/);
    assert.match(logs, /upstream_status/);
    assert.doesNotMatch(logs, /private\.angler|example\.com|bearer-secret|model error/i);
    assert.equal(sqlite.prepare("SELECT ai_review_status FROM trips WHERE id = 'trip_safe'").get().ai_review_status, "retry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trip persistence failures do not log database or object-store details", async () => {
  const secret = "private.angler@example.com exact-note bearer-secret";
  const store = {
    initialize: async () => { throw new Error(secret); },
  };
  const { value: response, entries } = await withCapturedConsole("error", () =>
    handleTripRequest(
      new Request("https://castingcompass.com/api/trips/summary"),
      {},
      [],
      { store },
    ));

  assert.equal(response?.status, 500);
  const logs = serializedLogs(entries);
  assert.match(logs, /Trip API request failed/);
  assert.doesNotMatch(logs, /private\.angler|example\.com|exact-note|bearer-secret/);
});
