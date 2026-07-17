import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cleanupAuthData, LEGAL_VERSION, evaluateAgeEligibility, handleAccountRequest, processPrivacyDeletionTasks } from "../worker/auth.ts";
import { createTripStore, handleTripRequest } from "../worker/trips.ts";
import { reviewTripWithMimo } from "../worker/trip-review.ts";
import { buildFeasibilityReconciliationExport } from "../worker/validation-feasibility-export.ts";
import {
  buildFeasibilityRecruitmentCampaign,
  createFeasibilityRecruitmentToken,
} from "../worker/validation-feasibility.ts";

const MIGRATIONS = [
  "0000_unique_tusk.sql",
  "0001_accounts_and_saved_sites.sql",
  "0002_profile_trip_ownership.sql",
  "0003_email_verification_and_recovery.sql",
  "0004_advisory_trip_review.sql",
  "0005_fishability_and_gear.sql",
  "0006_moderated_location_discussions.sql",
  "0007_legal_acceptance.sql",
  "0009_human_discussion_approval.sql",
  "0010_privacy_durability.sql",
  "0011_species_aware_observations.sql",
  "0012_validation_protocol.sql",
  "0013_validation_feasibility_pilot.sql",
  "0014_validation_feasibility_recruitment_and_corrections.sql",
  "0015_validation_snapshot_suppression.sql",
  "0016_data_resilience_indexes.sql",
];

class D1StatementAdapter {
  constructor(owner, query, statement) {
    this.owner = owner;
    this.query = query;
    this.statement = statement;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    this.owner.assertQueryAllowed(this.query);
    return this.statement.get(...this.values) ?? null;
  }

  async all() {
    this.owner.assertQueryAllowed(this.query);
    return { results: this.statement.all(...this.values) };
  }

  async run() {
    this.owner.assertQueryAllowed(this.query);
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class TransactionalD1Adapter {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.failQuerySubstring = null;
    this.failOnceQuerySubstring = null;
    this.failAfterAccountDeletion = false;
    this.postCommitFailureActive = false;
    this.beforeOnceQuerySubstring = null;
    this.beforeOnceQuery = null;
  }

  prepare(query) {
    return new D1StatementAdapter(this, query, this.sqlite.prepare(query));
  }

  assertQueryAllowed(query) {
    if (this.beforeOnceQuerySubstring && query.includes(this.beforeOnceQuerySubstring)) {
      const callback = this.beforeOnceQuery;
      this.beforeOnceQuerySubstring = null;
      this.beforeOnceQuery = null;
      callback?.();
    }
    if (this.failQuerySubstring && query.includes(this.failQuerySubstring)) throw new Error("injected D1 failure");
    if (this.failOnceQuerySubstring && query.includes(this.failOnceQuerySubstring)) {
      this.failOnceQuerySubstring = null;
      throw new Error("injected one-time D1 failure");
    }
    if (this.postCommitFailureActive && query.includes("FROM privacy_deletion_tasks")) {
      throw new Error("injected post-commit D1 failure");
    }
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      if (this.failAfterAccountDeletion && statements.some((statement) => statement.query.includes("DELETE FROM users"))) {
        this.postCommitFailureActive = true;
      }
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    const sql = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
    sqlite.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  return { sqlite, d1: new TransactionalD1Adapter(sqlite) };
}

function request(path, { method = "GET", body, cookie, origin = method !== "GET" } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  if (origin) headers.set("Origin", "https://castingcompass.com");
  return new Request(`https://castingcompass.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const PRIVACY_TEST_SCORING_SHA = "c".repeat(64);

function privacyTestAssets({
  windowId = "ocean-beach--20260710T1000Z",
  siteId = "ocean-beach",
  start = "2026-07-10T10:00:00Z",
  end = "2026-07-10T12:00:00Z",
} = {}) {
  const index = {
    schema_version: "castingcompass.opportunity-attestation-index/1.0.0",
    generated_at: "2026-07-10T09:00:00Z",
    snapshot_sha256: "a".repeat(64),
    site_catalog_sha256: "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860",
    target_taxon_id: "california-halibut",
    taxon_catalog_version: "castingcompass.taxa/1.0.0",
    observation_contract_version: "castingcompass.observation/2.0.0",
    model_run_contract_version: "castingcompass.model-run/2.0.0",
    opportunity_contract_version: "castingcompass.opportunity/2.0.0",
    scoring_system_kind: "heuristic-configuration",
    scoring_system_version: `heuristic-california-halibut-${PRIVACY_TEST_SCORING_SHA}`,
    scoring_system_sha256: PRIVACY_TEST_SCORING_SHA,
    windows: [[
      windowId,
      siteId,
      start,
      end,
      81,
      78,
      74,
      72,
      69,
    ]],
  };
  return {
    async fetch() {
      return new Response(JSON.stringify(index), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

function decodeBase64Url(value) {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: decodeBase64Url(salt),
    iterations: 100_000,
  }, key, 256);
  return Buffer.from(bits).toString("base64url");
}

async function addUser(sqlite, suffix = "1") {
  const id = `user_${suffix}`;
  const email = `angler-${suffix}@example.com`;
  const password = "correct-horse-battery-staple";
  const salt = Buffer.alloc(18, Number(suffix.replace(/\D/g, "")) || 1).toString("base64url");
  const timestamp = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users (id, email, password_salt, password_hash,
      age_eligibility_confirmed_at, terms_accepted_at, terms_version,
      privacy_accepted_at, privacy_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, email, salt, await passwordHash(password, salt), timestamp, timestamp, LEGAL_VERSION,
      timestamp, LEGAL_VERSION, timestamp, timestamp);
  const token = Buffer.alloc(32, Number(suffix.replace(/\D/g, "")) || 1).toString("base64url");
  sqlite.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(await sha256(token), id, new Date(Date.now() + 86_400_000).toISOString(), timestamp);
  return { id, email, password, token, cookie: `cc_session=${token}` };
}

test("existing ten-character passwords remain valid for sign-in", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "10");
  const legacyPassword = "ten-chars!";
  sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(await passwordHash(legacyPassword, sqlite.prepare("SELECT password_salt FROM users WHERE id = ?").get(user.id).password_salt), user.id);

  const response = await handleAccountRequest(request("/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: legacyPassword },
  }), { DB: d1 }, []);

  assert.equal(response?.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /cc_session=.*HttpOnly/);
});

test("authentication rotates presented sessions into secure host cookies and logout revokes them", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "41");
  const oldTokenHash = await sha256(user.token);

  const login = await handleAccountRequest(request("/api/auth/login", {
    method: "POST",
    cookie: user.cookie,
    body: { email: user.email, password: user.password },
  }), { DB: d1 }, []);
  assert.equal(login?.status, 200);
  const setCookies = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""]).join("\n");
  assert.match(setCookies, /__Host-cc_session=[A-Za-z0-9_-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure/);
  assert.doesNotMatch(setCookies, /Domain=/i);
  const rotatedCookie = sessionCookieFrom(login);
  assert.match(rotatedCookie ?? "", /^__Host-cc_session=/);
  const rotatedToken = rotatedCookie?.split("=")[1] ?? "";
  assert.notEqual(rotatedToken, user.token);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(oldTokenHash).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(await sha256(rotatedToken)).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(rotatedToken).count, 0);

  const staleSession = await handleAccountRequest(request("/api/auth/session", { cookie: user.cookie }), { DB: d1 }, []);
  assert.deepEqual(await staleSession.json(), { user: null });
  const staleClears = (staleSession.headers.getSetCookie?.() ?? [staleSession.headers.get("set-cookie") ?? ""]).join("\n");
  assert.match(staleClears, /__Host-cc_session=;.*Max-Age=0/);
  assert.match(staleClears, /(?:^|\n)cc_session=;.*Max-Age=0/);

  const activeSession = await handleAccountRequest(request("/api/auth/session", { cookie: rotatedCookie }), { DB: d1 }, []);
  assert.deepEqual((await activeSession.json()).user, {
    id: user.id,
    email: user.email,
    ageEligible: true,
    legalAccepted: true,
  });

  const crossOriginLogout = await handleAccountRequest(new Request("https://castingcompass.com/api/auth/logout", {
    method: "POST",
    headers: { Cookie: rotatedCookie, Origin: "https://attacker.example" },
  }), { DB: d1 }, []);
  assert.equal(crossOriginLogout?.status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(await sha256(rotatedToken)).count, 1);

  const logout = await handleAccountRequest(request("/api/auth/logout", {
    method: "POST",
    cookie: rotatedCookie,
  }), { DB: d1 }, []);
  assert.equal(logout?.status, 200);
  const logoutCookies = (logout.headers.getSetCookie?.() ?? [logout.headers.get("set-cookie") ?? ""]).join("\n");
  assert.match(logoutCookies, /__Host-cc_session=;.*Max-Age=0/);
  assert.match(logoutCookies, /(?:^|\n)cc_session=;.*Max-Age=0/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(user.id).count, 0);
});

test("expired and deleted-account sessions fail closed", async () => {
  const { sqlite, d1 } = await database();
  const expired = await addUser(sqlite, "45");
  sqlite.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(expired.id);
  const expiredResponse = await handleAccountRequest(request("/api/auth/session", {
    cookie: expired.cookie,
  }), { DB: d1 }, []);
  assert.deepEqual(await expiredResponse.json(), { user: null });
  assert.match((expiredResponse.headers.getSetCookie?.() ?? []).join("\n"), /cc_session=;.*Max-Age=0/);
  await cleanupAuthData({ DB: d1 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(expired.id).count, 0);

  const deleted = await addUser(sqlite, "46");
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(deleted.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(deleted.id).count, 0);
  const deletedResponse = await handleAccountRequest(request("/api/auth/session", {
    cookie: deleted.cookie,
  }), { DB: d1 }, []);
  assert.deepEqual(await deletedResponse.json(), { user: null });
});

test("known and unknown invalid logins perform password derivation and return the same response", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "42");
  const originalDeriveBits = crypto.subtle.deriveBits;
  let deriveCalls = 0;
  crypto.subtle.deriveBits = function (...args) {
    deriveCalls += 1;
    return originalDeriveBits.apply(this, args);
  };

  try {
    const known = await handleAccountRequest(request("/api/auth/login", {
      method: "POST",
      body: { email: user.email, password: "definitely-wrong-password" },
    }), { DB: d1 }, []);
    const knownDerivations = deriveCalls;
    deriveCalls = 0;
    const unknown = await handleAccountRequest(request("/api/auth/login", {
      method: "POST",
      body: { email: "unknown-account@example.com", password: "definitely-wrong-password" },
    }), { DB: d1 }, []);
    const unknownDerivations = deriveCalls;

    assert.equal(known?.status, 401);
    assert.equal(unknown?.status, 401);
    assert.deepEqual(await known.json(), await unknown.json());
    assert.equal(knownDerivations, 1);
    assert.equal(unknownDerivations, 1);
  } finally {
    crypto.subtle.deriveBits = originalDeriveBits;
  }
});

test("password recovery remains enumeration-resistant through request, resend, and reset", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "43");
  const deferred = [];
  const providerCalls = [];
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    providerCalls.push({ input: String(input), init });
    return providerGate;
  };

  try {
    const known = await handleAccountRequest(request("/api/auth/password/request", {
      method: "POST",
      body: { email: user.email },
    }), { DB: d1, RESEND_API_KEY: "test-key" }, [], { waitUntil: (promise) => deferred.push(promise) });
    const missing = await handleAccountRequest(request("/api/auth/password/request", {
      method: "POST",
      body: { email: "missing-recovery@example.com" },
    }), { DB: d1, RESEND_API_KEY: "test-key" }, [], { waitUntil: (promise) => deferred.push(promise) });
    const knownBody = await known.json();
    const missingBody = await missing.json();
    assert.equal(known.status, 200);
    assert.equal(missing.status, 200);
    assert.deepEqual({ ...knownBody, challengeId: "normalized" }, { ...missingBody, challengeId: "normalized" });
    assert.match(knownBody.challengeId, /^challenge_[a-f0-9-]{36}$/);
    assert.match(missingBody.challengeId, /^challenge_[a-f0-9-]{36}$/);
    assert.equal(providerCalls.length, 1);
    assert.equal(deferred.length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM email_challenges WHERE email = ?")
      .get("missing-recovery@example.com").count, 0);

    const deliveryBody = JSON.parse(providerCalls[0].init.body);
    const deliveredCode = deliveryBody.text.match(/\b\d{6}\b/)?.[0];
    assert.match(deliveredCode ?? "", /^\d{6}$/);
    releaseProvider(Response.json({ id: "recovery-safe" }));
    await Promise.all(deferred);

    const knownResend = await handleAccountRequest(request("/api/auth/challenge/resend", {
      method: "POST",
      body: { challengeId: knownBody.challengeId },
    }), { DB: d1, RESEND_API_KEY: "test-key" }, []);
    const missingResend = await handleAccountRequest(request("/api/auth/challenge/resend", {
      method: "POST",
      body: { challengeId: missingBody.challengeId },
    }), { DB: d1, RESEND_API_KEY: "test-key" }, []);
    assert.equal(knownResend.status, 200);
    assert.equal(missingResend.status, 200);
    assert.deepEqual(
      { ...(await knownResend.json()), challengeId: "normalized" },
      { ...(await missingResend.json()), challengeId: "normalized" },
    );
    assert.equal(providerCalls.length, 1);

    const wrongCode = deliveredCode === "000000" ? "000001" : "000000";
    const resetBody = { code: wrongCode, password: "a new safe test password" };
    const knownReset = await handleAccountRequest(request("/api/auth/password/reset", {
      method: "POST",
      body: { ...resetBody, challengeId: knownBody.challengeId },
    }), { DB: d1 }, []);
    const missingReset = await handleAccountRequest(request("/api/auth/password/reset", {
      method: "POST",
      body: { ...resetBody, challengeId: missingBody.challengeId },
    }), { DB: d1 }, []);
    assert.equal(knownReset.status, 401);
    assert.equal(missingReset.status, 401);
    assert.deepEqual(await knownReset.json(), await missingReset.json());

    for (let index = 0; index < 4; index += 1) {
      const id = `challenge_${crypto.randomUUID()}`;
      sqlite.prepare(`INSERT INTO email_challenges
          (id, kind, email, user_id, code_hash, expires_at, attempts, resend_count, created_at)
        VALUES (?, 'password_reset', ?, ?, ?, ?, 0, 0, ?)`)
        .run(
          id,
          user.email,
          user.id,
          await sha256(`${id}:123456`),
          new Date(Date.now() + 15 * 60_000).toISOString(),
          new Date().toISOString(),
        );
    }
    const limitedKnown = await handleAccountRequest(request("/api/auth/password/request", {
      method: "POST",
      body: { email: user.email },
    }), { DB: d1, RESEND_API_KEY: "test-key" }, []);
    const limitedMissing = await handleAccountRequest(request("/api/auth/password/request", {
      method: "POST",
      body: { email: "another-missing@example.com" },
    }), { DB: d1, RESEND_API_KEY: "test-key" }, []);
    assert.equal(limitedKnown.status, 200);
    assert.equal(limitedMissing.status, 200);
    assert.deepEqual(
      { ...(await limitedKnown.json()), challengeId: "normalized" },
      { ...(await limitedMissing.json()), challengeId: "normalized" },
    );
    assert.equal(providerCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("password reset revokes every prior session before issuing a fresh one", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "44");
  const secondToken = Buffer.alloc(32, 45).toString("base64url");
  const now = new Date();
  sqlite.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(await sha256(secondToken), user.id, new Date(now.getTime() + 86_400_000).toISOString(), now.toISOString());
  const challengeId = `challenge_${crypto.randomUUID()}`;
  const code = "624810";
  sqlite.prepare(`INSERT INTO email_challenges
      (id, kind, email, user_id, code_hash, expires_at, attempts, resend_count, created_at)
    VALUES (?, 'password_reset', ?, ?, ?, ?, 0, 0, ?)`)
    .run(
      challengeId,
      user.email,
      user.id,
      await sha256(`${challengeId}:${code}`),
      new Date(now.getTime() + 15 * 60_000).toISOString(),
      now.toISOString(),
    );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`${"0".repeat(35)}:0`);
  try {
    const reset = await handleAccountRequest(request("/api/auth/password/reset", {
      method: "POST",
      cookie: user.cookie,
      body: { challengeId, code, password: "a unique replacement passphrase" },
    }), { DB: d1 }, []);
    assert.equal(reset?.status, 200);
    const freshCookie = sessionCookieFrom(reset);
    assert.match(freshCookie ?? "", /^__Host-cc_session=/);
    const freshToken = freshCookie?.split("=")[1] ?? "";
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(user.id).count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(await sha256(user.token)).count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(await sha256(secondToken)).count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash = ?").get(await sha256(freshToken)).count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM email_challenges WHERE id = ?").get(challengeId).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function addTrip(sqlite, user, {
  id = `trip_${crypto.randomUUID()}`,
  photoKey = null,
  moderation = "pending",
} = {}) {
  const timestamp = "2026-07-01T12:00:00.000Z";
  sqlite.prepare(`INSERT INTO trips (
      id, user_id, status, source, site_id, started_at, ended_at, mode, fishing_method, gear,
      angler_count, angler_hours, keeper_count, short_released_count, halibut_encounters,
      no_catch, notes, consent, consent_at, moderation_status, reporter_key_hash, referral_code,
      token_hash, opportunity_window_id, opportunity_score, habitat_score, seasonality_score,
      conditions_score, model_version, score_influenced_choice, prediction_metadata_json,
      photo_key, photo_content_type, photo_size_bytes, created_at, updated_at, completed_at,
      gear_profile_id, rod, reel, bait_lure, rig, other_catch_count, other_species,
      observations_json, fishability_score, ai_review_status, ai_review_json, ai_review_model,
      ai_reviewed_at, contract_status
    ) VALUES (?, ?, 'completed', 'past_report', 'ocean-beach', ?, ?, 'shore', 'artificial-lure', 'legacy gear',
      1, 2.5, 1, 2, 3, 0, 'User trip notes', 1, ?, ?, 'reporter-secret', 'friend-code',
      'trip-token-secret', 'window-1', 72, 80, 70, 66, 'model-v1', 1, '{"forecast":"snapshot"}',
      ?, 'image/jpeg', 4, ?, ?, ?, 'gear_1', 'Rod A', 'Reel B', 'Swimbait', 'Drop shot',
      1, 'surfperch', '{"waterClarity":"clear"}', 64, 'reviewed', '{"qualityScore":88}',
      'mimo-test', ?, 'legacy_unverified')`)
    .run(id, user.id, timestamp, timestamp, timestamp, moderation, photoKey,
      timestamp, timestamp, timestamp, timestamp);
  return id;
}

function addDiscussion(sqlite, tripId) {
  sqlite.prepare(`INSERT INTO site_discussion_posts (
      id, trip_id, site_id, summary, gear_summary, technique_tags_json, observed_at,
      created_at, updated_at, review_model, approved_at, approved_by, source_ai_reviewed_at)
    VALUES (?, ?, 'ocean-beach', 'Public-safe summary', 'Medium setup', '["swimbait"]',
      '2026-07-01', '2026-07-02', '2026-07-03', 'mimo-test', '2026-07-04',
      'operator-private-identity', '2026-07-03')`)
    .run(`post_${tripId}`, tripId);
}

async function addDeletionTombstone(sqlite, { scope, subjectId, ownerId, suffix }) {
  const timestamp = new Date().toISOString();
  sqlite.prepare(`INSERT INTO privacy_deletion_jobs (
      id, receipt_hash, scope, subject_hash, owner_subject_hash, state, objects_total,
      objects_deleted, requested_at, active_data_removed_at, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'completed', 0, 0, ?, ?, ?, ?)`)
    .run(
      `deletion_manual_${suffix}`,
      await sha256(`receipt:${suffix}`),
      scope,
      await sha256(`${scope}:${subjectId}`),
      await sha256(`account:${ownerId}`),
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    );
}

function receiptFrom(response) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const joined = cookies.join(",");
  return joined.match(/cc_deletion_receipt=([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

function sessionCookieFrom(response) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const match = cookie.match(/(?:^|,\s*)((?:__Host-)?cc_session)=([A-Za-z0-9_-]+)/);
    if (match) return `${match[1]}=${match[2]}`;
  }
  return null;
}

function losAngelesDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter((part) => ["year", "month", "day"].includes(part.type))
    .map((part) => [part.type, Number(part.value)]));
}

function isoDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

test("age eligibility is isolated, one-use, non-retaining, and fail-closed", async () => {
  const { sqlite, d1 } = await database();
  const eligible = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: "2000-01-01" },
  }), { DB: d1 }, []);
  assert.equal(eligible?.status, 200);
  const proof = (await eligible.json()).eligibilityProof;
  assert.equal(typeof proof, "string");
  assert.match(eligible.headers.get("set-cookie") ?? "", /cc_age_ineligible=;.*Secure/);
  const proofRow = sqlite.prepare("SELECT * FROM signup_age_proofs").get();
  assert.deepEqual(Object.keys(proofRow).sort(), ["confirmed_at", "consumed_at", "created_at", "expires_at", "gate_version", "token_hash"].sort());
  assert.doesNotMatch(JSON.stringify(proofRow), /2000-01-01|example\.com|password/i);

  const originalFetch = globalThis.fetch;
  let emailCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith("https://api.pwnedpasswords.com/range/")) {
      return new Response(`${"0".repeat(35)}:0`);
    }
    emailCalls += 1;
    return Response.json({ id: "email-safe" });
  };
  try {
    const signupBody = {
      eligibilityProof: proof,
      email: "eligible@example.com",
      password: "correct-horse-battery-staple",
      termsAccepted: true,
      privacyAccepted: true,
    };
    const signup = await handleAccountRequest(request("/api/auth/signup/request", { method: "POST", body: signupBody }), {
      DB: d1,
      RESEND_API_KEY: "test",
    }, []);
    assert.equal(signup?.status, 200);
    assert.equal(emailCalls, 1);
    const replay = await handleAccountRequest(request("/api/auth/signup/request", {
      method: "POST",
      body: { ...signupBody, email: "different@example.com" },
    }), { DB: d1, RESEND_API_KEY: "test" }, []);
    assert.equal(replay?.status, 410);
    assert.equal(emailCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const beforeRejected = sqlite.prepare("SELECT COUNT(*) AS count FROM signup_age_proofs").get().count;
  const year = new Date().getUTCFullYear();
  const underage = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: `${year - 5}-01-01` },
  }), { DB: d1 }, []);
  assert.equal(underage?.status, 403);
  assert.match(underage.headers.get("set-cookie") ?? "", /cc_age_ineligible=1;.*HttpOnly;.*SameSite=Lax;.*Secure/);
  const future = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: `${year + 1}-01-01` },
  }), { DB: d1 }, []);
  assert.equal(future?.status, 422);
  assert.doesNotMatch(future.headers.get("set-cookie") ?? "", /cc_age_ineligible=1/);
  const invalid = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: "2020-02-31" },
  }), { DB: d1 }, []);
  assert.equal(invalid?.status, 422);
  const unexpected = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: "2000-01-01", email: "too-early@example.com" },
  }), { DB: d1 }, []);
  assert.equal(unexpected?.status, 422);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM signup_age_proofs").get().count, beforeRejected);

  const blocked = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    cookie: "cc_age_ineligible=1",
    body: { birthDate: "2000-01-01" },
  }), { DB: d1 }, []);
  assert.equal(blocked?.status, 403);
  const blockedStatus = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    cookie: "cc_age_ineligible=1",
  }), { DB: d1 }, []);
  assert.deepEqual(await blockedStatus.json(), { available: false });
  const availableStatus = await handleAccountRequest(request("/api/auth/signup/eligibility"), { DB: d1 }, []);
  assert.deepEqual(await availableStatus.json(), { available: true });

  const fresh = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: "2000-01-01" },
  }), { DB: d1 }, []);
  const freshProof = (await fresh.json()).eligibilityProof;
  const markerBlockedSignup = await handleAccountRequest(request("/api/auth/signup/request", {
    method: "POST",
    cookie: "cc_age_ineligible=1",
    body: {
      eligibilityProof: freshProof,
      email: "blocked@example.com",
      password: "correct-horse-battery-staple",
      termsAccepted: true,
      privacyAccepted: true,
    },
  }), { DB: d1 }, []);
  assert.equal(markerBlockedSignup?.status, 403);
  assert.equal(sqlite.prepare("SELECT consumed_at FROM signup_age_proofs WHERE token_hash = ?").get(await sha256(freshProof)).consumed_at, null);

  const validationProofResponse = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: "2000-01-01" },
  }), { DB: d1 }, []);
  const validationProof = (await validationProofResponse.json()).eligibilityProof;
  const invalidCredentialStage = await handleAccountRequest(request("/api/auth/signup/request", {
    method: "POST",
    body: {
      eligibilityProof: validationProof,
      email: "not-an-email",
      password: "correct-horse-battery-staple",
      termsAccepted: true,
      privacyAccepted: true,
    },
  }), { DB: d1 }, []);
  assert.equal(invalidCredentialStage?.status, 422);
  assert.equal(
    sqlite.prepare("SELECT consumed_at FROM signup_age_proofs WHERE token_hash = ?").get(await sha256(validationProof)).consumed_at,
    null,
  );

  const originalScreeningFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    const unavailableScreening = await handleAccountRequest(request("/api/auth/signup/request", {
      method: "POST",
      body: {
        eligibilityProof: validationProof,
        email: "now-valid@example.com",
        password: "correct-horse-battery-staple",
        termsAccepted: true,
        privacyAccepted: true,
      },
    }), { DB: d1 }, []);
    assert.equal(unavailableScreening?.status, 503);
    assert.equal(
      sqlite.prepare("SELECT consumed_at FROM signup_age_proofs WHERE token_hash = ?").get(await sha256(validationProof)).consumed_at,
      null,
    );
  } finally {
    globalThis.fetch = originalScreeningFetch;
  }

  sqlite.prepare("UPDATE signup_age_proofs SET expires_at = '2000-01-01' WHERE token_hash = ?").run(await sha256(freshProof));
  const expired = await handleAccountRequest(request("/api/auth/signup/request", {
    method: "POST",
    body: {
      eligibilityProof: freshProof,
      email: "expired@example.com",
      password: "correct-horse-battery-staple",
      termsAccepted: true,
      privacyAccepted: true,
    },
  }), { DB: d1 }, []);
  assert.equal(expired?.status, 410);
});

test("age eligibility uses the California calendar at the exact birthday boundary", async () => {
  const { d1 } = await database();
  const today = losAngelesDateParts();
  const birthdayToday = { ...today, year: today.year - 13 };
  const tomorrowDate = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const birthdayTomorrow = {
    year: tomorrowDate.getUTCFullYear() - 13,
    month: tomorrowDate.getUTCMonth() + 1,
    day: tomorrowDate.getUTCDate(),
  };
  const dayOf = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: isoDate(birthdayToday) },
  }), { DB: d1 }, []);
  assert.equal(dayOf?.status, 200);
  const dayBefore = await handleAccountRequest(request("/api/auth/signup/eligibility", {
    method: "POST",
    body: { birthDate: isoDate(birthdayTomorrow) },
  }), { DB: d1 }, []);
  assert.equal(dayBefore?.status, 403);
  assert.throws(
    () => evaluateAgeEligibility("2013-07-17", new Date("2026-07-17T06:59:59.000Z")),
    (error) => error?.code === "age_restricted",
  );
  assert.equal(
    evaluateAgeEligibility("2013-07-17", new Date("2026-07-17T07:00:00.000Z")),
    "2026-07-17T07:00:00.000Z",
  );
});

test("default-off password recovery preserves the cached-client null payload only", async () => {
  const { d1 } = await database();
  const legacy = await handleAccountRequest(request("/api/auth/password/request", {
    method: "POST",
    body: { email: "missing@example.com", password: null },
  }), { DB: d1 }, []);
  assert.equal(legacy?.status, 200);
  assert.equal((await legacy?.json()).requested, true);

  const unexpectedCredential = await handleAccountRequest(request("/api/auth/password/request", {
    method: "POST",
    body: { email: "missing@example.com", password: "must-not-be-accepted" },
  }), { DB: d1 }, []);
  assert.equal(unexpectedCredential?.status, 422);
  assert.equal((await unexpectedCredential?.json()).error.code, "unexpected_fields");
});

test("legal reacceptance preserves prior age eligibility and legacy accounts fail closed with rights intact", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "9");
  const ageConfirmedAt = "2025-01-02T03:04:05.000Z";
  sqlite.prepare(`UPDATE users SET age_eligibility_confirmed_at = ?, terms_version = 'old', privacy_version = 'old'
    WHERE id = ?`).run(ageConfirmedAt, user.id);
  const session = await handleAccountRequest(request("/api/auth/session", { cookie: user.cookie }), { DB: d1 }, []);
  assert.deepEqual(await session.json(), {
    user: { id: user.id, email: user.email, ageEligible: true, legalAccepted: false },
  });
  const rotatedUserCookie = sessionCookieFrom(session);
  assert.match(rotatedUserCookie ?? "", /^__Host-cc_session=/);
  const reaccepted = await handleAccountRequest(request("/api/auth/eligibility", {
    method: "POST",
    cookie: rotatedUserCookie,
    body: { termsAccepted: true, privacyAccepted: true },
  }), { DB: d1 }, []);
  assert.equal(reaccepted?.status, 200);
  assert.equal(sqlite.prepare("SELECT age_eligibility_confirmed_at FROM users WHERE id = ?").get(user.id).age_eligibility_confirmed_at, ageConfirmedAt);

  const legacy = await addUser(sqlite, "10");
  sqlite.prepare(`UPDATE users SET age_eligibility_confirmed_at = NULL, terms_version = 'old', privacy_version = 'old'
    WHERE id = ?`).run(legacy.id);
  const legacySession = await handleAccountRequest(request("/api/auth/session", { cookie: legacy.cookie }), { DB: d1 }, []);
  assert.deepEqual(await legacySession.json(), {
    user: { id: legacy.id, email: legacy.email, ageEligible: false, legalAccepted: false },
  });
  const rotatedLegacyCookie = sessionCookieFrom(legacySession);
  assert.match(rotatedLegacyCookie ?? "", /^__Host-cc_session=/);
  const legacyReaccept = await handleAccountRequest(request("/api/auth/eligibility", {
    method: "POST",
    cookie: rotatedLegacyCookie,
    body: { termsAccepted: true, privacyAccepted: true },
  }), { DB: d1 }, []);
  assert.equal(legacyReaccept?.status, 428);
  const legacyDob = await handleAccountRequest(request("/api/auth/eligibility", {
    method: "POST",
    cookie: rotatedLegacyCookie,
    body: { birthDate: "2000-01-01", termsAccepted: true, privacyAccepted: true },
  }), { DB: d1 }, []);
  assert.equal(legacyDob?.status, 422);
  const legacyExport = await handleAccountRequest(request("/api/profile/export", { cookie: rotatedLegacyCookie }), { DB: d1 }, []);
  assert.equal(legacyExport?.status, 200);
});

test("per-record authorization denies cross-account reads and mutations", async () => {
  const { sqlite, d1 } = await database();
  const owner = await addUser(sqlite, "31");
  const otherAccount = await addUser(sqlite, "32");
  const tripId = addTrip(sqlite, owner, { photoKey: "private/owner-only.jpg" });
  const gearId = `gear_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  sqlite.prepare(`INSERT INTO gear_profiles
      (id, user_id, name, rod, reel, bait_lure, rig, created_at, updated_at)
    VALUES (?, ?, 'Owner setup', 'Owner rod', 'Owner reel', 'Owner lure', 'Owner rig', ?, ?)`)
    .run(gearId, owner.id, timestamp, timestamp);

  const photoRead = await handleAccountRequest(request(`/api/profile/export/photos/${tripId}`, {
    cookie: otherAccount.cookie,
  }), { DB: d1 }, []);
  assert.equal(photoRead?.status, 404);
  assert.equal((await photoRead?.json()).error.code, "photo_not_found");

  const tripDelete = await handleAccountRequest(request(`/api/profile/trips/${tripId}`, {
    method: "DELETE",
    cookie: otherAccount.cookie,
  }), { DB: d1 }, []);
  assert.equal(tripDelete?.status, 404);
  assert.equal((await tripDelete?.json()).error.code, "trip_not_found");

  const gearDelete = await handleAccountRequest(request(`/api/gear-profiles/${gearId}`, {
    method: "DELETE",
    cookie: otherAccount.cookie,
  }), { DB: d1 }, []);
  assert.equal(gearDelete?.status, 404);
  assert.equal((await gearDelete?.json()).error.code, "gear_profile_not_found");

  const otherExport = await handleAccountRequest(request("/api/profile/export", {
    cookie: otherAccount.cookie,
  }), { DB: d1 }, []);
  assert.equal(otherExport?.status, 200);
  const serializedExport = JSON.stringify(await otherExport?.json());
  assert.doesNotMatch(serializedExport, new RegExp(owner.id));
  assert.doesNotMatch(serializedExport, new RegExp(owner.email));
  assert.doesNotMatch(serializedExport, new RegExp(tripId));
  assert.doesNotMatch(serializedExport, new RegExp(gearId));

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trips WHERE id = ? AND user_id = ?")
    .get(tripId, owner.id).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM gear_profiles WHERE id = ? AND user_id = ?")
    .get(gearId, owner.id).count, 1);
});

test("owner mutations reject undeclared gear and profile fields", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "strict-input");
  const gear = await handleAccountRequest(request("/api/gear-profiles", {
    method: "POST",
    cookie: user.cookie,
    body: {
      name: "Strict setup",
      rod: "Rod",
      reel: "Reel",
      baitLure: "Swimbait",
      rig: "Jighead",
      userId: "user_attacker_selected",
    },
  }), { DB: d1 }, []);
  assert.equal(gear?.status, 422);
  assert.equal((await gear?.json()).error.code, "unexpected_fields");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM gear_profiles WHERE user_id = ?").get(user.id).count, 0);

  const tripId = addTrip(sqlite, user);
  const trip = sqlite.prepare("SELECT * FROM trips WHERE id = ?").get(tripId);
  const profile = await handleAccountRequest(request(`/api/profile/trips/${tripId}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: {
      siteId: trip.site_id,
      startedAt: trip.started_at,
      endedAt: trip.ended_at,
      mode: trip.mode,
      anglerCount: trip.angler_count,
      keeperCount: trip.keeper_count,
      shortReleasedCount: trip.short_released_count,
      fishingMethod: trip.fishing_method,
      gearProfileId: "",
      rod: trip.rod,
      reel: trip.reel,
      baitLure: trip.bait_lure,
      rig: trip.rig,
      otherCatchCount: trip.other_catch_count,
      otherSpecies: trip.other_species,
      notes: trip.notes,
      adminApproved: true,
    },
  }), { DB: d1 }, [{ id: "ocean-beach" }]);
  assert.equal(profile?.status, 422);
  assert.equal((await profile?.json()).error.code, "unexpected_fields");
  assert.equal(sqlite.prepare("SELECT notes FROM trips WHERE id = ?").get(tripId).notes, trip.notes);
});

test("account deletion transaction removes public/account rows and completes successful object purge", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite);
  const tripId = addTrip(sqlite, user, { photoKey: "private/photo.jpg" });
  addDiscussion(sqlite, tripId);
  sqlite.prepare("INSERT INTO saved_sites (user_id, site_id, created_at) VALUES (?, 'ocean-beach', '2026-07-01')").run(user.id);
  sqlite.prepare(`INSERT INTO gear_profiles (id, user_id, name, created_at, updated_at)
    VALUES ('gear_saved', ?, 'Surf setup', '2026-07-01', '2026-07-01')`).run(user.id);
  const deletedKeys = [];
  const response = await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1, TRIP_PHOTOS: { delete: async (key) => deletedKeys.push(key) } }, []);
  assert.equal(response?.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.deletion.status, "completed");
  assert.equal(payload.deleted, true);
  assert.deepEqual(deletedKeys, ["private/photo.jpg"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trips").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM site_discussion_posts").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM saved_sites").get().count, 0);
  const task = sqlite.prepare("SELECT state, object_key, object_key_hash FROM privacy_deletion_tasks").get();
  assert.equal(task.state, "completed");
  assert.equal(task.object_key, null);
  assert.equal(typeof task.object_key_hash, "string");
  const cookies = (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""]).join("\n");
  assert.match(cookies, /cc_session=;.*Max-Age=0/);
  assert.match(cookies, /cc_reporter=;.*SameSite=Strict; Secure/);
  assert.match(cookies, /cc_age_ineligible=;.*Max-Age=0/);
  assert.match(cookies, /cc_deletion_receipt=.*HttpOnly; SameSite=Lax; Secure/);
  const receipt = receiptFrom(response);
  assert.ok(receipt);
  const status = await handleAccountRequest(request("/api/privacy/deletion-status", {
    cookie: `cc_deletion_receipt=${receipt}`,
  }), { DB: d1 }, []);
  assert.equal(status?.status, 200);
  assert.deepEqual((await status.json()).deletion.status, "completed");
  const cleared = await handleAccountRequest(request("/api/privacy/deletion-status", {
    method: "DELETE",
    cookie: `cc_deletion_receipt=${receipt}`,
  }), { DB: d1 }, []);
  assert.equal(cleared?.status, 200);
  assert.match(cleared.headers.get("set-cookie") ?? "", /cc_deletion_receipt=;.*Max-Age=0/);
});

test("trip writes serialize safely on both sides of account deletion and fallback DDL keeps ownership foreign keys", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "19");
  const writeBeforeDeletion = addTrip(sqlite, user);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trips WHERE id = ?").get(writeBeforeDeletion).count, 1);

  const deletion = await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1 }, []);
  assert.equal(deletion?.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trips WHERE id = ?").get(writeBeforeDeletion).count, 0);
  assert.throws(() => addTrip(sqlite, user), /FOREIGN KEY constraint failed/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trips WHERE user_id = ?").get(user.id).count, 0);

  const fallbackSqlite = new DatabaseSync(":memory:");
  fallbackSqlite.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  const fallbackD1 = new TransactionalD1Adapter(fallbackSqlite);
  await createTripStore(fallbackD1).initialize();
  const foreignKeys = fallbackSqlite.prepare("PRAGMA foreign_key_list(trips)").all();
  assert.ok(foreignKeys.some((key) => key.table === "users" && key.from === "user_id" && key.on_delete === "SET NULL"));
});

test("missing storage and retry failures stay truthful until an idempotent purge succeeds", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "2");
  addTrip(sqlite, user, { photoKey: "private/retry.jpg" });
  const missingBinding = await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1 }, []);
  assert.equal(missingBinding?.status, 202);
  assert.equal((await missingBinding.json()).deletion.status, "needs_attention");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(user.id).count, 0);
  assert.equal(sqlite.prepare("SELECT object_key FROM privacy_deletion_tasks").get().object_key, "private/retry.jpg");

  sqlite.prepare(`UPDATE privacy_deletion_tasks SET state = 'pending', available_at = '2000-01-01',
    lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL WHERE state = 'needs_attention'`).run();
  let attempts = 0;
  await processPrivacyDeletionTasks({
    DB: d1,
    TRIP_PHOTOS: {
      delete: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
      },
    },
  });
  assert.equal(sqlite.prepare("SELECT state FROM privacy_deletion_jobs").get().state, "active_data_removed");
  sqlite.prepare("UPDATE privacy_deletion_tasks SET available_at = '2000-01-01'").run();
  await processPrivacyDeletionTasks({ DB: d1, TRIP_PHOTOS: { delete: async () => { attempts += 1; } } });
  const job = sqlite.prepare("SELECT state, objects_total, objects_deleted FROM privacy_deletion_jobs").get();
  assert.equal(job.state, "completed");
  assert.equal(job.objects_total, 1);
  assert.equal(job.objects_deleted, 1);
  assert.equal(sqlite.prepare("SELECT object_key FROM privacy_deletion_tasks").get().object_key, null);
});

test("account deletion adopts unresolved photo tasks from an earlier trip deletion", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "3");
  const tripId = addTrip(sqlite, user, { photoKey: "private/orphan-chain.jpg" });
  addDiscussion(sqlite, tripId);
  const tripDelete = await handleAccountRequest(request(`/api/profile/trips/${tripId}`, {
    method: "DELETE",
    cookie: user.cookie,
  }), { DB: d1 }, []);
  assert.equal(tripDelete?.status, 202);
  assert.equal((await tripDelete.json()).deletion.status, "needs_attention");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trips WHERE id = ?").get(tripId).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM site_discussion_posts WHERE trip_id = ?").get(tripId).count, 0);
  sqlite.prepare("UPDATE privacy_deletion_tasks SET attempts = 8 WHERE job_id IN (SELECT id FROM privacy_deletion_jobs WHERE scope = 'trip')").run();

  const noPhotoTripId = addTrip(sqlite, user);
  addDiscussion(sqlite, noPhotoTripId);
  const noPhotoDelete = await handleAccountRequest(request(`/api/profile/trips/${noPhotoTripId}`, {
    method: "DELETE",
    cookie: user.cookie,
  }), { DB: d1 }, []);
  assert.equal(noPhotoDelete?.status, 200);
  assert.equal((await noPhotoDelete.json()).deletion.status, "completed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM site_discussion_posts WHERE trip_id = ?").get(noPhotoTripId).count, 0);

  const deleted = [];
  const accountDelete = await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1, TRIP_PHOTOS: { delete: async (key) => deleted.push(key) } }, []);
  assert.equal(accountDelete?.status, 200);
  const accountStatus = (await accountDelete.json()).deletion;
  assert.equal(accountStatus.status, "completed");
  assert.equal(accountStatus.objectsTotal, 1);
  assert.deepEqual(deleted, ["private/orphan-chain.jpg"]);
  const adoptedTask = sqlite.prepare(`SELECT privacy_deletion_tasks.state, privacy_deletion_tasks.attempts
    FROM privacy_deletion_tasks JOIN privacy_deletion_jobs
      ON privacy_deletion_jobs.id = privacy_deletion_tasks.job_id
    WHERE privacy_deletion_jobs.scope = 'trip' AND privacy_deletion_jobs.objects_total = 1`).get();
  assert.equal(adoptedTask.state, "pending");
  assert.equal(adoptedTask.attempts, 8, "account adoption must preserve cumulative retry evidence");
  assert.deepEqual(
    sqlite.prepare("SELECT scope, state, objects_total, objects_deleted FROM privacy_deletion_jobs").all()
      .map((row) => ({ ...row }))
      .sort((left, right) => `${left.scope}:${left.objects_total}`.localeCompare(`${right.scope}:${right.objects_total}`)),
    [
      { scope: "account", state: "completed", objects_total: 1, objects_deleted: 1 },
      { scope: "trip", state: "completed", objects_total: 0, objects_deleted: 0 },
      { scope: "trip", state: "active_data_removed", objects_total: 1, objects_deleted: 0 },
    ],
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_tasks WHERE object_key IS NOT NULL").get().count, 1);

  await processPrivacyDeletionTasks({ DB: d1, TRIP_PHOTOS: { delete: async (key) => deleted.push(key) } });
  assert.deepEqual(deleted, ["private/orphan-chain.jpg", "private/orphan-chain.jpg"]);
  assert.equal(sqlite.prepare(`SELECT privacy_deletion_tasks.attempts
    FROM privacy_deletion_tasks JOIN privacy_deletion_jobs
      ON privacy_deletion_jobs.id = privacy_deletion_tasks.job_id
    WHERE privacy_deletion_jobs.scope = 'trip' AND privacy_deletion_jobs.objects_total = 1`).get().attempts, 9);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_jobs WHERE state != 'completed'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_tasks WHERE object_key IS NOT NULL").get().count, 0);
});

test("object deletion retries are bounded and retain the locator for operator attention", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "8");
  addTrip(sqlite, user, { photoKey: "private/exhausted.jpg" });
  let deleteCalls = 0;
  const env = {
    DB: d1,
    TRIP_PHOTOS: {
      delete: async () => {
        deleteCalls += 1;
        throw new Error("persistent object-store failure");
      },
    },
  };
  const response = await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), env, []);
  assert.equal(response?.status, 202);
  for (let attempt = 1; attempt < 8; attempt += 1) {
    sqlite.prepare("UPDATE privacy_deletion_tasks SET available_at = '2000-01-01'").run();
    await processPrivacyDeletionTasks(env);
  }
  const task = sqlite.prepare("SELECT state, attempts, object_key FROM privacy_deletion_tasks").get();
  assert.equal(task.state, "needs_attention");
  assert.equal(task.attempts, 8);
  assert.equal(task.object_key, "private/exhausted.jpg");
  assert.equal(sqlite.prepare("SELECT state FROM privacy_deletion_jobs").get().state, "needs_attention");
  assert.equal(deleteCalls, 8);
  sqlite.prepare("UPDATE privacy_deletion_tasks SET available_at = '2000-01-01'").run();
  await processPrivacyDeletionTasks(env);
  assert.equal(deleteCalls, 8);
  sqlite.prepare(`UPDATE privacy_deletion_tasks SET state = 'pending', available_at = '2000-01-01',
    lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL WHERE state = 'needs_attention'`).run();
  await processPrivacyDeletionTasks({ DB: d1, TRIP_PHOTOS: { delete: async () => { deleteCalls += 1; } } });
  assert.equal(deleteCalls, 9);
  assert.equal(sqlite.prepare("SELECT state FROM privacy_deletion_tasks").get().state, "completed");
  assert.equal(sqlite.prepare("SELECT state FROM privacy_deletion_jobs").get().state, "completed");
});

test("a stale selection cannot bypass another worker's retry backoff", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "18");
  addTrip(sqlite, user, { photoKey: "private/backoff-race.jpg" });
  await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1 }, []);
  sqlite.prepare(`UPDATE privacy_deletion_tasks SET state = 'pending', available_at = '2000-01-01',
    lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL`).run();

  const originalPrepare = d1.prepare.bind(d1);
  let pauseSelection = true;
  let announceSelected;
  const selected = new Promise((resolve) => { announceSelected = resolve; });
  let releaseSelection;
  const selectionGate = new Promise((resolve) => { releaseSelection = resolve; });
  d1.prepare = (query) => {
    const statement = originalPrepare(query);
    if (pauseSelection && query.includes("SELECT id, job_id, object_key, object_key_hash")) {
      pauseSelection = false;
      const originalAll = statement.all.bind(statement);
      statement.all = async () => {
        const rows = await originalAll();
        announceSelected();
        await selectionGate;
        return rows;
      };
    }
    return statement;
  };

  let staleCalls = 0;
  try {
    const staleRun = processPrivacyDeletionTasks({
      DB: d1,
      TRIP_PHOTOS: { delete: async () => { staleCalls += 1; } },
    });
    await selected;

    let failingCalls = 0;
    await processPrivacyDeletionTasks({
      DB: d1,
      TRIP_PHOTOS: { delete: async () => {
        failingCalls += 1;
        throw new Error("transient storage failure");
      } },
    });
    assert.equal(failingCalls, 1);

    releaseSelection();
    await staleRun;
    assert.equal(staleCalls, 0, "the stale row must be rechecked against available_at when claimed");
    const task = sqlite.prepare("SELECT state, attempts, available_at FROM privacy_deletion_tasks").get();
    assert.equal(task.state, "pending");
    assert.equal(task.attempts, 1);
    assert.ok(new Date(task.available_at).getTime() > Date.now());
  } finally {
    d1.prepare = originalPrepare;
  }
});

test("lease ownership prevents a stale successful worker from completing a newer lease", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "11");
  addTrip(sqlite, user, { photoKey: "private/lease-race.jpg" });
  await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1 }, []);
  sqlite.prepare(`UPDATE privacy_deletion_tasks SET state = 'pending', available_at = '2000-01-01',
    lease_expires_at = NULL, lease_token = NULL WHERE state = 'needs_attention'`).run();

  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  let releaseStale;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  let staleCalls = 0;
  const staleRun = processPrivacyDeletionTasks({
    DB: d1,
    TRIP_PHOTOS: {
      delete: async () => {
        staleCalls += 1;
        announceStarted();
        await staleGate;
      },
    },
  });
  await started;

  let newerCalls = 0;
  await processPrivacyDeletionTasks({
    DB: d1,
    TRIP_PHOTOS: { delete: async () => { newerCalls += 1; } },
  });
  assert.equal(newerCalls, 0, "an unexpired lease must not be stolen");
  sqlite.prepare("UPDATE privacy_deletion_tasks SET lease_expires_at = '2000-01-01'").run();
  let announceNewerStarted;
  const newerStarted = new Promise((resolve) => { announceNewerStarted = resolve; });
  let releaseNewer;
  const newerGate = new Promise((resolve) => { releaseNewer = resolve; });
  const newerRun = processPrivacyDeletionTasks({
    DB: d1,
    TRIP_PHOTOS: { delete: async () => {
      newerCalls += 1;
      announceNewerStarted();
      await newerGate;
    } },
  });
  await newerStarted;
  releaseStale();
  await staleRun;
  assert.equal(staleCalls, 1);
  assert.equal(newerCalls, 1);
  const duringNewerLease = sqlite.prepare("SELECT state, object_key, attempts FROM privacy_deletion_tasks").get();
  assert.equal(duringNewerLease.state, "leased");
  assert.equal(duringNewerLease.object_key, "private/lease-race.jpg");
  assert.equal(duringNewerLease.attempts, 2);

  releaseNewer();
  await newerRun;
  const task = sqlite.prepare("SELECT state, object_key FROM privacy_deletion_tasks").get();
  assert.equal(task.state, "completed");
  assert.equal(task.object_key, null);
  assert.equal(sqlite.prepare("SELECT state FROM privacy_deletion_jobs").get().state, "completed");
});

test("an expired final-attempt lease fails closed without an unbounded object call", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "12");
  addTrip(sqlite, user, { photoKey: "private/final-lease.jpg" });
  await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1 }, []);
  sqlite.prepare(`UPDATE privacy_deletion_tasks SET state = 'leased', attempts = 8,
    available_at = '2000-01-01', lease_expires_at = '2000-01-01', lease_token = 'abandoned-final-lease',
    last_error_code = NULL WHERE state = 'needs_attention'`).run();
  let calls = 0;
  await processPrivacyDeletionTasks({
    DB: d1,
    TRIP_PHOTOS: { delete: async () => { calls += 1; } },
  });
  assert.equal(calls, 0);
  const task = sqlite.prepare("SELECT state, attempts, object_key, last_error_code FROM privacy_deletion_tasks").get();
  assert.equal(task.state, "needs_attention");
  assert.equal(task.attempts, 8);
  assert.equal(task.object_key, "private/final-lease.jpg");
  assert.equal(task.last_error_code, "photo_delete_lease_expired");
  assert.equal(sqlite.prepare("SELECT state FROM privacy_deletion_jobs").get().state, "needs_attention");
});

test("a corrupted runnable task without an object locator fails closed for manual attention", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "13");
  addTrip(sqlite, user, { photoKey: "private/corrupt.jpg" });
  await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: d1 }, []);
  sqlite.exec("PRAGMA ignore_check_constraints = ON");
  sqlite.prepare(`UPDATE privacy_deletion_tasks SET state = 'pending', object_key = NULL,
    available_at = '2000-01-01', attempts = 12 WHERE state = 'needs_attention'`).run();
  let calls = 0;
  await processPrivacyDeletionTasks({
    DB: d1,
    TRIP_PHOTOS: { delete: async () => { calls += 1; } },
  });
  assert.equal(calls, 0);
  const task = sqlite.prepare("SELECT state, attempts, last_error_code FROM privacy_deletion_tasks").get();
  assert.equal(task.state, "needs_attention");
  assert.equal(task.attempts, 12, "fail-closed locator handling must preserve cumulative retry evidence");
  assert.equal(task.last_error_code, "photo_locator_missing");
  assert.equal(sqlite.prepare("SELECT state FROM privacy_deletion_jobs").get().state, "needs_attention");
});

test("task-ledger gaps cannot complete or purge deletion evidence", async () => {
  const { sqlite, d1 } = await database();
  const timestamp = "2026-07-01T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO privacy_deletion_jobs (
      id, receipt_hash, scope, subject_hash, owner_subject_hash, state, objects_total,
      objects_deleted, last_error_code, requested_at, active_data_removed_at, completed_at, updated_at)
    VALUES ('deletion_missing_task', 'receipt-missing-task', 'account', 'subject-missing-task',
      'owner-missing-task', 'active_data_removed', 1, 0, NULL, ?, ?, NULL, ?)`)
    .run(timestamp, timestamp, timestamp);

  await processPrivacyDeletionTasks({ DB: d1 });
  const incomplete = sqlite.prepare(`SELECT state, objects_total, objects_deleted, last_error_code, completed_at
    FROM privacy_deletion_jobs WHERE id = 'deletion_missing_task'`).get();
  assert.deepEqual({ ...incomplete }, {
    state: "needs_attention",
    objects_total: 1,
    objects_deleted: 0,
    last_error_code: "task_ledger_incomplete",
    completed_at: null,
  });

  sqlite.prepare(`INSERT INTO privacy_deletion_jobs (
      id, receipt_hash, scope, subject_hash, owner_subject_hash, state, objects_total,
      objects_deleted, last_error_code, requested_at, active_data_removed_at, completed_at, updated_at)
    VALUES ('deletion_corrupt_completed', 'receipt-corrupt-completed', 'trip', 'subject-corrupt-completed',
      'owner-corrupt-completed', 'completed', 1, 1, NULL, '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`).run();
  sqlite.prepare(`INSERT INTO privacy_deletion_tasks (
      id, job_id, object_key, object_key_hash, state, attempts, available_at,
      lease_expires_at, lease_token, last_error_code, created_at, updated_at, completed_at)
    VALUES ('deletion_task_corrupt_completed', 'deletion_corrupt_completed', 'private/restore-risk.jpg',
      'hash-restore-risk', 'pending', 0, '2099-01-01T00:00:00.000Z', NULL, NULL, NULL,
      '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL)`).run();

  await cleanupAuthData({ DB: d1 });
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM privacy_deletion_jobs
    WHERE id = 'deletion_corrupt_completed'`).get().count, 1);
  assert.equal(sqlite.prepare(`SELECT state FROM privacy_deletion_jobs
    WHERE id = 'deletion_corrupt_completed'`).get().state, "active_data_removed");
  const retained = sqlite.prepare(`SELECT state, object_key FROM privacy_deletion_tasks
    WHERE id = 'deletion_task_corrupt_completed'`).get();
  assert.equal(retained.state, "pending");
  assert.equal(retained.object_key, "private/restore-risk.jpg");
});

test("transaction failures roll back deletion, while post-commit cleanup failures return a durable 202 receipt", async () => {
  const first = await database();
  const user = await addUser(first.sqlite, "4");
  const tripId = addTrip(first.sqlite, user, { photoKey: "private/atomic.jpg" });
  addDiscussion(first.sqlite, tripId);
  first.d1.failQuerySubstring = "DELETE FROM users";
  const rolledBack = await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user.cookie,
    body: { confirmation: "DELETE", password: user.password },
  }), { DB: first.d1, TRIP_PHOTOS: { delete: async () => undefined } }, []);
  assert.equal(rolledBack?.status, 500);
  assert.equal(first.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(user.id).count, 1);
  assert.equal(first.sqlite.prepare("SELECT COUNT(*) AS count FROM trips WHERE id = ?").get(tripId).count, 1);
  assert.equal(first.sqlite.prepare("SELECT COUNT(*) AS count FROM site_discussion_posts WHERE trip_id = ?").get(tripId).count, 1);
  assert.equal(first.sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_jobs").get().count, 0);

  const second = await database();
  const user2 = await addUser(second.sqlite, "5");
  addTrip(second.sqlite, user2, { photoKey: "private/post-commit.jpg" });
  second.d1.failAfterAccountDeletion = true;
  const deferred = await handleAccountRequest(request("/api/profile", {
    method: "DELETE",
    cookie: user2.cookie,
    body: { confirmation: "DELETE", password: user2.password },
  }), { DB: second.d1, TRIP_PHOTOS: { delete: async () => undefined } }, []);
  assert.equal(deferred?.status, 202);
  assert.equal((await deferred.json()).deletion.status, "processing");
  assert.ok(receiptFrom(deferred));
  assert.equal(second.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(user2.id).count, 0);
  assert.equal(second.sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_jobs").get().count, 1);
});

test("export includes user data and downloadable photos without internal locators or moderator identity", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "6");
  const tripId = addTrip(sqlite, user, { photoKey: "private/export.jpg" });
  addDiscussion(sqlite, tripId);
  sqlite.prepare("INSERT INTO saved_sites (user_id, site_id, created_at) VALUES (?, 'ocean-beach', '2026-07-01')").run(user.id);
  sqlite.prepare(`INSERT INTO gear_profiles (id, user_id, name, rod, created_at, updated_at)
    VALUES ('gear_export', ?, 'Export rig', 'Rod C', '2026-07-01', '2026-07-02')`).run(user.id);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const bucket = {
    delete: async () => undefined,
    get: async () => ({
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      size: bytes.byteLength,
      httpMetadata: { contentType: "text/html" },
    }),
  };
  const exported = await handleAccountRequest(request("/api/profile/export", { cookie: user.cookie }), {
    DB: d1,
    TRIP_PHOTOS: bucket,
  }, []);
  assert.equal(exported?.status, 200);
  const payload = await exported.json();
  assert.equal(payload.account.terms_version, LEGAL_VERSION);
  assert.equal(payload.tripReports[0].consent, 1);
  assert.equal(payload.tripReports[0].observations_json, '{"waterClarity":"clear"}');
  assert.equal(payload.tripReports[0].ai_review_model, "mimo-test");
  assert.equal(payload.tripReports[0].target_taxon_id, "california-halibut");
  assert.equal(payload.tripReports[0].contract_status, "legacy_unverified");
  assert.equal(payload.tripReports[0].taxon_observations_json, null);
  assert.equal(payload.discussionPosts[0].summary, "Public-safe summary");
  assert.equal(payload.photos[0].availability, "downloadable");
  assert.equal(payload.photos[0].downloadPath, `/api/profile/export/photos/${tripId}`);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /private\/export\.jpg|reporter-secret|trip-token-secret|operator-private-identity|approved_by|photo_key|reporter_key_hash|token_hash/);

  const download = await handleAccountRequest(request(`/api/profile/export/photos/${tripId}`, { cookie: user.cookie }), {
    DB: d1,
    TRIP_PHOTOS: bucket,
  }, []);
  assert.equal(download?.status, 200);
  assert.equal(download.headers.get("Content-Type"), "application/octet-stream");
  assert.match(download.headers.get("Content-Disposition") ?? "", /attachment; filename="trip_[a-f0-9-]{36}\.bin"/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);

  const withoutBinding = await handleAccountRequest(request("/api/profile/export", { cookie: user.cookie }), { DB: d1 }, []);
  assert.equal((await withoutBinding.json()).photos[0].reason, "photo_storage_unavailable");
});

test("private export preserves immutable validation lineage without accepting evaluator roles", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "validation-export");
  const sites = [{ id: "ocean-beach", type: "Beach" }];
  const windowId = "ocean-beach--20260801T1000Z";
  const env = {
    DB: d1,
    ASSETS: privacyTestAssets({
      windowId,
      start: "2026-08-01T10:00:00Z",
      end: "2026-08-01T12:00:00Z",
    }),
    VALIDATION_OBSERVATIONAL_SECONDARY_ENABLED: "true",
    VALIDATION_PROTOCOL_ID: "california-halibut-site-window-v1",
    VALIDATION_COHORT_ID: "california-halibut-site-window-observational-secondary-v1",
    VALIDATION_ACTIVATION_MANIFEST_SHA256: "d".repeat(64),
    VALIDATION_ACTIVATED_AT: "2026-07-31T23:59:00Z",
    VALIDATION_ACTIVATION_SCORING_SHA256: PRIVACY_TEST_SCORING_SHA,
  };
  const reporterKey = "private-export-device-key-123456789";
  const startBody = {
    siteId: "ocean-beach",
    startedAt: "2026-08-01T10:30:00.000Z",
    mode: "beach",
    fishingMethod: "artificial-lure",
    anglerCount: 3,
    consent: true,
    primaryTargetConfirmed: true,
    scoreInfluencedChoice: true,
    reporterKey,
    opportunityWindowId: windowId,
    website: "",
  };
  const forgedStart = await handleTripRequest(new Request("https://castingcompass.com/api/trips/start", {
    method: "POST",
    headers: { Origin: "https://castingcompass.com", "Content-Type": "application/json" },
    body: JSON.stringify({
      ...startBody,
      sourceRole: "score-visible-first-party",
      cohortRole: "secondary",
      selectionDesign: "prospective-score-visible-self-selected",
      collectionSourceRole: "prospective_secondary",
      collectionEvidenceStatus: "secondary_pending_review",
      collectionCohortId: "california-halibut-site-window-observational-secondary-v1",
    }),
  }), env, sites, {
    accountId: user.id,
    now: () => new Date("2026-08-01T10:31:00.000Z"),
  });
  assert.equal(forgedStart.status, 422);
  assert.equal((await forgedStart.json()).error.code, "unexpected_fields");

  const startResponse = await handleTripRequest(new Request("https://castingcompass.com/api/trips/start", {
    method: "POST",
    headers: { Origin: "https://castingcompass.com", "Content-Type": "application/json" },
    body: JSON.stringify(startBody),
  }), env, sites, {
    accountId: user.id,
    now: () => new Date("2026-08-01T10:31:00.000Z"),
  });
  assert.equal(startResponse.status, 201, JSON.stringify(await startResponse.clone().json()));
  const started = await startResponse.json();

  const completion = new FormData();
  completion.set("token", started.token);
  completion.set("endedAt", "2026-08-01T10:45:00.000Z");
  completion.set("mode", "beach");
  completion.set("anglerCount", "3");
  completion.set("keeperCount", "0");
  completion.set("shortReleasedCount", "0");
  completion.set("otherCatchCount", "0");
  completion.set("consent", "true");
  completion.set("primaryTargetConfirmed", "true");
  completion.set("completeAttempt", "true");
  completion.set("website", "");
  completion.set("sourceRole", "score-visible-first-party");
  completion.set("cohortRole", "secondary");
  completion.set("selectionDesign", "prospective-score-visible-self-selected");
  const forgedCompletion = await handleTripRequest(new Request(
    `https://castingcompass.com/api/trips/${started.trip.id}/complete`,
    { method: "POST", headers: { Origin: "https://castingcompass.com" }, body: completion },
  ), env, sites, {
    accountId: user.id,
    now: () => new Date("2026-08-01T11:31:00.000Z"),
  });
  assert.equal(forgedCompletion.status, 422);
  assert.equal((await forgedCompletion.json()).error.code, "unexpected_fields");
  completion.delete("sourceRole");
  completion.delete("cohortRole");
  completion.delete("selectionDesign");
  const completionResponse = await handleTripRequest(new Request(
    `https://castingcompass.com/api/trips/${started.trip.id}/complete`,
    { method: "POST", headers: { Origin: "https://castingcompass.com" }, body: completion },
  ), env, sites, {
    accountId: user.id,
    now: () => new Date("2026-08-01T11:31:00.000Z"),
  });
  assert.equal(completionResponse.status, 200, JSON.stringify(await completionResponse.clone().json()));

  const provenanceColumns = sqlite.prepare("PRAGMA table_info(trip_validation_provenance)")
    .all()
    .map((column) => column.name);
  const cloneCompletion = (id, overrides) => {
    const selectExpressions = provenanceColumns.map((column) => {
      if (column === "id") return `'${id}'`;
      if (Object.hasOwn(overrides, column)) return `'${overrides[column]}'`;
      return `\`${column}\``;
    });
    return sqlite.prepare(`INSERT INTO trip_validation_provenance (
        ${provenanceColumns.map((column) => `\`${column}\``).join(", ")}
      ) SELECT ${selectExpressions.join(", ")}
      FROM trip_validation_provenance
      WHERE trip_id = ? AND event_type = 'completion'`);
  };
  assert.throws(() => cloneCompletion(
    "validation_forged_assignment",
    { assignment_id: `assignment-${"f".repeat(64)}` },
  ).run(started.trip.id));
  assert.throws(() => cloneCompletion(
    "validation_forged_completion_mode",
    { mode_at_completion: "pier" },
  ).run(started.trip.id));
  assert.throws(() => cloneCompletion(
    "validation_forged_secondary_exclusion",
    { event_type: "evidence_exclusion" },
  ).run(started.trip.id));
  assert.throws(() => cloneCompletion(
    "validation_forged_secondary_legacy_context",
    { event_type: "legacy_context" },
  ).run(started.trip.id));

  const storedTrip = sqlite.prepare(`SELECT started_at, ended_at FROM trips WHERE id = ?`)
    .get(started.trip.id);
  const profileEditBase = {
    siteId: "ocean-beach",
    mode: "beach",
    startedAt: storedTrip.started_at,
    endedAt: storedTrip.ended_at,
    anglerCount: 3,
    keeperCount: 0,
    shortReleasedCount: 0,
    fishingMethod: "artificial-lure",
    gearProfileId: "",
    rod: "",
    reel: "",
    baitLure: "",
    rig: "",
    otherCatchCount: 0,
    otherSpecies: "",
    shorebreak: "",
    wadingDepth: "",
    waterClarity: "",
    crowding: "",
    fishabilityRating: "",
    observedWaveHeightFeet: "",
    fishabilityNotes: "",
    notes: "",
  };
  const adversarialEdits = [
    ["outcome-only", { ...profileEditBase, keeperCount: 1 }, "2026-08-01T11:32:00.000Z"],
    ["effort-only", { ...profileEditBase, keeperCount: 1, anglerCount: 4 }, "2026-08-01T11:33:00.000Z"],
    ["gear/notes-only", {
      ...profileEditBase,
      keeperCount: 1,
      anglerCount: 4,
      rod: "Edited rod",
      notes: "Edited after completion",
    }, "2026-08-01T11:34:00.000Z"],
  ];
  for (const [label, body, editedAt] of adversarialEdits) {
    const edited = await handleAccountRequest(request(`/api/profile/trips/${started.trip.id}`, {
      method: "PATCH",
      cookie: user.cookie,
      body,
    }), { DB: d1 }, sites, { now: () => new Date(editedAt) });
    assert.equal(edited?.status, 200, `${label}: ${JSON.stringify(await edited?.clone().json())}`);
    assert.deepEqual(await edited.json(), {
      updated: true,
      tripId: started.trip.id,
      forecastAttributionCleared: false,
      validationEvidenceExcluded: true,
    }, label);
  }
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM trip_validation_provenance
    WHERE trip_id = ? AND event_type = 'evidence_exclusion'
      AND attestation_status = 'invalidated_after_edit'
      AND exclusion_reason = 'post_completion_profile_edit'`).get(started.trip.id).count, 3);
  assert.equal(sqlite.prepare("SELECT opportunity_window_id FROM trips WHERE id = ?")
    .get(started.trip.id).opportunity_window_id, windowId);

  const exported = await handleAccountRequest(
    request("/api/profile/export", { cookie: user.cookie }),
    { DB: d1 },
    sites,
  );
  assert.equal(exported?.status, 200);
  const payload = await exported.json();
  assert.equal(payload.forecastImpressions.length, 1);
  assert.equal(payload.validationProvenance.length, 5);

  const impression = payload.forecastImpressions[0];
  assert.equal(impression.trip_id, started.trip.id);
  assert.equal(impression.window_id, windowId);
  assert.equal(impression.scoring_system_sha256, PRIVACY_TEST_SCORING_SHA);
  assert.match(impression.id, /^impression_[a-f0-9-]{36}$/);

  const enrollment = payload.validationProvenance.find((row) => row.event_type === "enrollment");
  const completed = payload.validationProvenance.find((row) => row.event_type === "completion");
  const exclusions = payload.validationProvenance.filter((row) => row.event_type === "evidence_exclusion");
  assert.equal(enrollment.source_role, "prospective_secondary");
  assert.equal(enrollment.evidence_status, "secondary_pending_review");
  assert.equal(enrollment.cohort_id, "california-halibut-site-window-observational-secondary-v1");
  assert.equal(enrollment.forecast_impression_id, impression.id);
  assert.match(enrollment.participant_group_id, /^participant-[a-f0-9]{64}$/);
  assert.match(enrollment.recruitment_event_sha256, /^[a-f0-9]{64}$/);
  assert.match(enrollment.assignment_id, /^assignment-[a-f0-9]{64}$/);
  assert.match(enrollment.source_record_sha256, /^[a-f0-9]{64}$/);
  assert.match(enrollment.effort_segment_id, /^effort-[a-f0-9]{64}$/);
  assert.equal(enrollment.segment_start_at, "2026-08-01T10:31:00.000Z");

  assert.equal(completed.source_role, "prospective_secondary");
  assert.equal(completed.evidence_status, "secondary_pending_review");
  assert.equal(completed.assignment_id, enrollment.assignment_id);
  assert.equal(completed.source_record_sha256, enrollment.source_record_sha256);
  assert.equal(completed.effort_segment_id, enrollment.effort_segment_id);
  assert.equal(completed.participant_group_id, enrollment.participant_group_id);
  assert.equal(completed.recruitment_event_sha256, enrollment.recruitment_event_sha256);
  assert.equal(completed.forecast_impression_id, impression.id);
  assert.equal(completed.segment_end_at, "2026-08-01T11:31:00.000Z");
  assert.equal(completed.angler_count, 3);
  assert.equal(completed.duration_milliseconds, 3_600_000);
  assert.equal(completed.person_milliseconds, 10_800_000);
  assert.match(completed.completion_event_sha256, /^[a-f0-9]{64}$/);

  assert.equal(exclusions.length, 3);
  for (const exclusion of exclusions) {
    assert.match(exclusion.id, /^validation_[a-f0-9-]{36}$/);
    assert.equal(exclusion.trip_id, started.trip.id);
    assert.equal(exclusion.source_role, "context_only");
    assert.equal(exclusion.evidence_status, "context_only");
    assert.equal(exclusion.attestation_status, "invalidated_after_edit");
    assert.equal(exclusion.exclusion_reason, "post_completion_profile_edit");
    assert.equal(exclusion.assignment_id, null);
    assert.equal(exclusion.completion_event_sha256, null);
  }

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(reporterKey));
  assert.doesNotMatch(serialized, /reporter_key_hash|token_hash|score-visible-first-party|prospective-score-visible-self-selected|"cohort_role"/);
});

test("feasibility pilot start, completion, safe cancellation, export, and privacy removal are atomic", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "feasibility28");
  const directUser = await addUser(sqlite, "feasibility-direct29");
  const hour = 60 * 60 * 1_000;
  const day = 24 * hour;
  const wallNow = Date.now();
  const iso = (milliseconds) => new Date(milliseconds).toISOString();
  const activationCreatedAt = iso(wallNow - day);
  const preregisteredAt = iso(wallNow - (2 * hour));
  const receiptVerifiedAt = iso(wallNow - hour);
  const activationStartAt = iso(wallNow + (2 * day));
  const activationEndAt = iso(wallNow + (92 * day));
  const opportunityStartAt = iso(wallNow + (3 * day) + (10 * hour));
  const opportunityEndAt = iso(wallNow + (3 * day) + (12 * hour));
  const firstStartedAt = iso(wallNow + (3 * day) + (10 * hour) + (15 * 60 * 1_000));
  const firstEndedAt = iso(wallNow + (3 * day) + (11 * hour) + (15 * 60 * 1_000));
  const firstCorrectionAt = iso(wallNow + (3 * day) + (11 * hour) + (20 * 60 * 1_000));
  const exclusionCorrectionAt = iso(wallNow + (3 * day) + (11 * hour) + (25 * 60 * 1_000));
  const restoredCorrectionAt = iso(wallNow + (3 * day) + (11 * hour) + (30 * 60 * 1_000));
  const canceledStartedAt = iso(wallNow + (3 * day) + (10 * hour) + (30 * 60 * 1_000));
  const directStartedAt = iso(wallNow + (3 * day) + (10 * hour) + (40 * 60 * 1_000));
  const canceledAt = iso(wallNow + (3 * day) + (10 * hour) + (45 * 60 * 1_000));
  const replayedAt = iso(wallNow + (3 * day) + (10 * hour) + (46 * 60 * 1_000));
  const directEndedAt = iso(wallNow + (3 * day) + (11 * hour) + (40 * 60 * 1_000));
  const siteId = "ocean-beach-north";
  const opportunityWindowStamp = opportunityStartAt.slice(0, 16).replaceAll("-", "").replaceAll(":", "");
  const windowId = `${siteId}--${opportunityWindowStamp}Z`;
  const activationId = "feasibility-activation-test-v2";
  const studyConsentVersion = "castingcompass.validation-feasibility-consent/2.0.0";
  sqlite.prepare(`INSERT INTO validation_feasibility_activations (
      id, protocol_id, protocol_version, protocol_sha256, activation_commitment_sha256,
      activation_manifest_sha256, site_catalog_sha256, scoring_system_kind,
      scoring_system_version, scoring_system_sha256, worker_version_id,
      study_consent_version, start_at, end_at, preregistered_at, receipt_verified_at,
      status, created_at
    ) VALUES (?, 'california-halibut-collection-feasibility-v2', '2.0.0', ?, ?, ?, ?,
      'heuristic-configuration', ?, ?, 'worker-feasibility-test', ?, ?, ?, ?, ?,
      'sealed-before-enrollment', ?)`)
    .run(
      activationId,
      "8ff0d7bd009ed8eb10f328347d58d0b63d0b6c822b08351cc5c2760d41de13ed",
      "e".repeat(64),
      "d".repeat(64),
      "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860",
      `heuristic-california-halibut-${PRIVACY_TEST_SCORING_SHA}`,
      PRIVACY_TEST_SCORING_SHA,
      studyConsentVersion,
      activationStartAt,
      activationEndAt,
      preregisteredAt,
      receiptVerifiedAt,
      activationCreatedAt,
    );

  const env = {
    DB: d1,
    ASSETS: privacyTestAssets({
      windowId,
      siteId,
      start: opportunityStartAt,
      end: opportunityEndAt,
    }),
    VALIDATION_FEASIBILITY_ENABLED: "true",
    VALIDATION_FEASIBILITY_ACTIVATION_ID: activationId,
    VALIDATION_FEASIBILITY_ACTIVATION_MANIFEST_SHA256: "d".repeat(64),
    VALIDATION_FEASIBILITY_COMMITMENT_SHA256: "e".repeat(64),
    VALIDATION_PARTICIPANT_HMAC_SECRET:
      ["feasibility", "test", "secret", "with", "at", "least", "32", "bytes"].join("-"),
    VALIDATION_RECRUITMENT_HMAC_SECRET:
      ["feasibility", "recruitment", "secret", "at", "least", "32", "bytes"].join("-"),
    CF_VERSION_METADATA: { id: "worker-feasibility-test" },
  };
  const sites = [
    { id: siteId, type: "Beach" },
    { id: "ocean-beach-south", type: "Beach" },
  ];

  const startTrip = async (timestamp, suffix, account = user, recruitmentToken = null) => {
    const response = await handleTripRequest(new Request("https://castingcompass.com/api/trips/start", {
      method: "POST",
      headers: { Origin: "https://castingcompass.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        siteId,
        startedAt: timestamp,
        mode: "beach",
        anglerCount: 1,
        consent: true,
        primaryTargetConfirmed: true,
        scoreInfluencedChoice: true,
        studyConsent: true,
        studyConsentVersion,
        recruitmentToken,
        reporterKey: `feasibility-reporter-${suffix}-12345678901234567890`,
        opportunityWindowId: windowId,
        website: "",
      }),
    }), env, sites, { accountId: account.id, now: () => new Date(timestamp) });
    assert.equal(response?.status, 201, JSON.stringify(await response?.clone().json()));
    return response.json();
  };

  const first = await startTrip(firstStartedAt, "complete");
  let events = sqlite.prepare(`SELECT * FROM validation_feasibility_events
    WHERE trip_id = ? ORDER BY sequence`).all(first.trip.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "started");
  assert.match(events[0].participant_group_id, /^participant-[a-f0-9]{64}$/);
  assert.equal(events[0].study_consent_version, studyConsentVersion);

  const completion = new FormData();
  completion.set("token", first.token);
  completion.set("mode", "beach");
  completion.set("anglerCount", "1");
  completion.set("keeperCount", "0");
  completion.set("shortReleasedCount", "0");
  completion.set("otherCatchCount", "0");
  completion.set("consent", "true");
  completion.set("primaryTargetConfirmed", "true");
  completion.set("completeAttempt", "true");
  completion.set("website", "");
  const completedResponse = await handleTripRequest(new Request(
    `https://castingcompass.com/api/trips/${first.trip.id}/complete`,
    { method: "POST", headers: { Origin: "https://castingcompass.com" }, body: completion },
  ), env, sites, { accountId: user.id, now: () => new Date(firstEndedAt) });
  assert.equal(completedResponse?.status, 200, JSON.stringify(await completedResponse?.clone().json()));
  events = sqlite.prepare(`SELECT * FROM validation_feasibility_events
    WHERE trip_id = ? ORDER BY sequence`).all(first.trip.id);
  assert.deepEqual(events.map((event) => event.event_type), ["started", "completed"]);
  assert.equal(events[1].previous_event_sha256, events[0].event_sha256);
  assert.equal(events[1].target_encountered, 0);

  const correctionBody = (correctionSiteId) => ({
    siteId: correctionSiteId,
    startedAt: firstStartedAt,
    endedAt: firstEndedAt,
    mode: "beach",
    fishingMethod: "artificial-lure",
    anglerCount: 1,
    keeperCount: 1,
    shortReleasedCount: 0,
    otherCatchCount: 0,
    otherSpecies: null,
    notes: "Participant-corrected outcome.",
  });
  const editTrip = (correctionSiteId, correctedAt) => handleAccountRequest(
    request(`/api/profile/trips/${first.trip.id}`, {
      method: "PATCH",
      cookie: user.cookie,
      body: correctionBody(correctionSiteId),
    }),
    env,
    sites,
    { now: () => new Date(correctedAt) },
  );
  const eligibleCorrectionResponse = await editTrip(siteId, firstCorrectionAt);
  assert.equal(eligibleCorrectionResponse?.status, 200);
  assert.deepEqual(await eligibleCorrectionResponse.json(), {
    updated: true,
    tripId: first.trip.id,
    forecastAttributionCleared: false,
    validationEvidenceExcluded: true,
    validationFeasibilityCorrected: true,
    validationFeasibilityStatus: "eligible_corrected_completion",
  });
  const eligibleCorrectionExport = await buildFeasibilityReconciliationExport({
    db: d1,
    activationId,
    snapshotAndRestorePassed: true,
    exportedAt: iso(new Date(firstCorrectionAt).getTime() + 60_000),
  });
  assert.equal(eligibleCorrectionExport.reconciliation.completedAttempts, 1);
  assert.equal(eligibleCorrectionExport.reconciliation.targetEncounters, 1);

  const exclusionResponse = await editTrip("ocean-beach-south", exclusionCorrectionAt);
  assert.equal(exclusionResponse?.status, 200);
  assert.equal((await exclusionResponse.json()).validationFeasibilityStatus, "excluded_after_identity_correction");
  const exclusionExport = await buildFeasibilityReconciliationExport({
    db: d1,
    activationId,
    snapshotAndRestorePassed: true,
    exportedAt: iso(new Date(exclusionCorrectionAt).getTime() + 60_000),
  });
  assert.equal(exclusionExport.reconciliation.completedAttempts, 0);
  assert.equal(exclusionExport.reconciliation.identityCorrectionExclusions, 1);

  const restoredIdentityResponse = await editTrip(siteId, restoredCorrectionAt);
  assert.equal(restoredIdentityResponse?.status, 200);
  assert.equal((await restoredIdentityResponse.json()).validationFeasibilityStatus, "eligible_corrected_completion");
  const correctionRows = sqlite.prepare(`SELECT * FROM validation_feasibility_corrections
    WHERE trip_id = ? ORDER BY sequence`).all(first.trip.id);
  assert.equal(correctionRows.length, 3);
  assert.equal(correctionRows[0].previous_event_sha256, events[1].event_sha256);
  assert.equal(correctionRows[1].previous_event_sha256, correctionRows[0].event_sha256);
  assert.equal(correctionRows[2].previous_event_sha256, correctionRows[1].event_sha256);

  const campaignSealedAt = sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value").get().value;
  const directCampaignPayload = {
    schema_version: "castingcompass.validation-feasibility-recruitment-token/2.0.0",
    activation_id: activationId,
    campaign_id: "campaign-direct-test",
    recruitment_source_id: "direct-opt-in-research-invite",
    selection_method: "direct_precommitment",
    issued_at: campaignSealedAt,
    expires_at: activationEndAt,
    community_approval_sha256: null,
  };
  const directCampaign = await buildFeasibilityRecruitmentCampaign(
    directCampaignPayload,
    campaignSealedAt,
  );
  assert.ok(directCampaign);
  sqlite.prepare(`INSERT INTO validation_feasibility_recruitment_campaigns (
      activation_id, campaign_id, recruitment_source_id, selection_method,
      invite_issued_at, invite_expires_at, community_approval_sha256,
      token_payload_sha256, sealed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      directCampaign.activationId,
      directCampaign.campaignId,
      directCampaign.recruitmentSourceId,
      directCampaign.selectionMethod,
      directCampaign.inviteIssuedAt,
      directCampaign.inviteExpiresAt,
      directCampaign.communityApprovalSha256,
      directCampaign.tokenPayloadSha256,
      directCampaign.sealedAt,
    );
  assert.throws(() => sqlite.prepare(`UPDATE validation_feasibility_recruitment_campaigns
    SET campaign_id = campaign_id WHERE activation_id = ? AND campaign_id = ?`)
    .run(activationId, directCampaign.campaignId), /immutable/);
  assert.throws(() => sqlite.prepare(`DELETE FROM validation_feasibility_recruitment_campaigns
    WHERE activation_id = ? AND campaign_id = ?`)
    .run(activationId, directCampaign.campaignId), /immutable/);
  assert.throws(() => sqlite.prepare(`INSERT INTO validation_feasibility_recruitment_campaigns (
      activation_id, campaign_id, recruitment_source_id, selection_method,
      invite_issued_at, invite_expires_at, community_approval_sha256,
      token_payload_sha256, sealed_at
    ) VALUES (?, 'campaign-late-test', 'direct-opt-in-research-invite',
      'direct_precommitment', ?, ?, NULL, ?, ?)`)
    .run(
      activationId,
      campaignSealedAt,
      directCampaign.inviteExpiresAt,
      "0".repeat(64),
      activationStartAt,
    ), /must be sealed by the database before activation/);
  const directRecruitmentToken = await createFeasibilityRecruitmentToken(
    env.VALIDATION_RECRUITMENT_HMAC_SECRET,
    directCampaignPayload,
  );
  assert.ok(directRecruitmentToken);
  const direct = await startTrip(
    directStartedAt,
    "direct",
    directUser,
    directRecruitmentToken,
  );
  const directRecruitment = sqlite.prepare(`SELECT recruitment_source_id, selection_method,
      campaign_id, invite_issued_at, user_id
    FROM validation_feasibility_recruitment_events WHERE user_id = ?`).get(directUser.id);
  assert.deepEqual({ ...directRecruitment }, {
    recruitment_source_id: "direct-opt-in-research-invite",
    selection_method: "direct_precommitment",
    campaign_id: "campaign-direct-test",
    invite_issued_at: campaignSealedAt,
    user_id: directUser.id,
  });
  const directCompletion = new FormData();
  directCompletion.set("token", direct.token);
  directCompletion.set("mode", "beach");
  directCompletion.set("anglerCount", "1");
  directCompletion.set("keeperCount", "0");
  directCompletion.set("shortReleasedCount", "0");
  directCompletion.set("otherCatchCount", "0");
  directCompletion.set("consent", "true");
  directCompletion.set("primaryTargetConfirmed", "true");
  directCompletion.set("completeAttempt", "true");
  directCompletion.set("website", "");
  const directCompletedResponse = await handleTripRequest(new Request(
    `https://castingcompass.com/api/trips/${direct.trip.id}/complete`,
    { method: "POST", headers: { Origin: "https://castingcompass.com" }, body: directCompletion },
  ), env, sites, { accountId: directUser.id, now: () => new Date(directEndedAt) });
  assert.equal(directCompletedResponse?.status, 200, JSON.stringify(await directCompletedResponse?.clone().json()));

  const second = await startTrip(
    canceledStartedAt,
    "cancel",
    user,
    directRecruitmentToken,
  );
  const canceledResponse = await handleTripRequest(new Request(
    `https://castingcompass.com/api/trips/${second.trip.id}/cancel`,
    {
      method: "POST",
      headers: { Origin: "https://castingcompass.com", "Content-Type": "application/json" },
      body: JSON.stringify({ token: second.token, reason: "water_safety" }),
    },
  ), env, sites, { accountId: user.id, now: () => new Date(canceledAt) });
  assert.equal(canceledResponse?.status, 200, JSON.stringify(await canceledResponse?.clone().json()));
  const canceledEvents = sqlite.prepare(`SELECT * FROM validation_feasibility_events
    WHERE trip_id = ? ORDER BY sequence`).all(second.trip.id);
  assert.deepEqual(canceledEvents.map((event) => event.event_type), ["started", "safe_canceled"]);
  assert.equal(canceledEvents[0].recruitment_source_id, "castingcompass-organic-product");
  assert.equal(canceledEvents[1].terminal_reason, "water_safety");
  assert.equal(sqlite.prepare("SELECT token_hash FROM trips WHERE id = ?").get(second.trip.id).token_hash, null);

  const replay = await handleTripRequest(new Request(
    `https://castingcompass.com/api/trips/${second.trip.id}/cancel`,
    {
      method: "POST",
      headers: { Origin: "https://castingcompass.com", "Content-Type": "application/json" },
      body: JSON.stringify({ token: second.token, reason: "water_safety" }),
    },
  ), env, sites, { accountId: user.id, now: () => new Date(replayedAt) });
  assert.equal(replay?.status, 404);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM validation_feasibility_events
    WHERE trip_id = ?`).get(second.trip.id).count, 2);

  const exported = await handleAccountRequest(
    request("/api/profile/export", { cookie: user.cookie }),
    env,
    sites,
  );
  assert.equal(exported?.status, 200);
  const exportPayload = await exported.json();
  assert.equal(exportPayload.validationFeasibilityEvents.length, 4);
  assert.equal(exportPayload.validationFeasibilityRecruitment.length, 1);
  assert.equal(exportPayload.validationFeasibilityCorrections.length, 3);
  assert.equal("user_id" in exportPayload.validationFeasibilityRecruitment[0], false);
  assert.equal("snapshot_suppression_sha256" in exportPayload.validationFeasibilityEvents[0], false);
  assert.doesNotMatch(JSON.stringify(exportPayload.validationFeasibilityEvents), new RegExp(user.id));
  assert.doesNotMatch(JSON.stringify(exportPayload.validationFeasibilityEvents), new RegExp(user.email));

  const reconciliationExport = await buildFeasibilityReconciliationExport({
    db: d1,
    activationId,
    snapshotAndRestorePassed: true,
    exportedAt: activationEndAt,
  });
  assert.equal(reconciliationExport.candidatePerformanceComputed, false);
  assert.equal(reconciliationExport.privateRawRowsPublished, false);
  assert.equal(reconciliationExport.eventCount, 6);
  assert.equal(reconciliationExport.reconciliation.startedAttempts, 3);
  assert.equal(reconciliationExport.reconciliation.completedAttempts, 2);
  assert.equal(reconciliationExport.reconciliation.safeCanceledAttempts, 1);
  assert.equal(reconciliationExport.reconciliation.correctionEvents, 3);
  assert.equal(reconciliationExport.reconciliation.identityCorrectionExclusions, 0);
  assert.equal(reconciliationExport.reconciliation.targetEncounters, 1);
  assert.equal(reconciliationExport.reconciliation.nonEncounters, 1);
  assert.equal(reconciliationExport.reconciliation.recruitmentSourcesWithAttempts, 2);
  assert.equal(reconciliationExport.reconciliation.reconciliationRate, 1);
  assert.equal(reconciliationExport.reconciliation.completionRateExcludingSafeCancellations, 1);

  assert.throws(() => sqlite.prepare("DELETE FROM validation_feasibility_events WHERE event_id = ?")
    .run(canceledEvents[0].event_id), /may be removed only with their trip privacy deletion/);
  assert.throws(() => sqlite.prepare("UPDATE validation_feasibility_activations SET status = status WHERE id = ?")
    .run(activationId), /immutable/);
  sqlite.prepare("DELETE FROM trips WHERE id = ?").run(second.trip.id);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM validation_feasibility_events
    WHERE trip_id = ?`).get(second.trip.id).count, 0);
  const removal = sqlite.prepare(`SELECT removed_event_count, removed_started_attempt_count,
      removed_completed_attempt_count, removed_safe_canceled_attempt_count
    FROM validation_feasibility_privacy_removals WHERE activation_id = ?`).get(activationId);
  assert.deepEqual({ ...removal }, {
    removed_event_count: 2,
    removed_started_attempt_count: 1,
    removed_completed_attempt_count: 0,
    removed_safe_canceled_attempt_count: 1,
  });
  const canceledSuppressions = sqlite.prepare(`SELECT suppression_kind, suppressed_event_type,
      suppression_subject_sha256, source_event_sha256
    FROM validation_feasibility_snapshot_suppressions ORDER BY sequence`).all();
  assert.deepEqual(canceledSuppressions.map((row) => row.suppressed_event_type), ["started", "safe_canceled"]);
  assert.ok(canceledSuppressions.every((row) => row.suppression_kind === "trip"));
  assert.equal(new Set(canceledSuppressions.map((row) => row.suppression_subject_sha256)).size, 1);
  assert.ok(canceledSuppressions.every((row) => /^[a-f0-9]{64}$/.test(row.source_event_sha256)));
  const postDeletionExport = await buildFeasibilityReconciliationExport({
    db: d1,
    activationId,
    snapshotAndRestorePassed: true,
    exportedAt: iso(new Date(activationEndAt).getTime() + 1_000),
  });
  assert.equal(postDeletionExport.eventCount, 4);
  assert.equal(postDeletionExport.reconciliation.startedAttempts, 3);
  assert.equal(postDeletionExport.reconciliation.retainedStartedAttempts, 2);
  assert.equal(postDeletionExport.reconciliation.removedStartedAttempts, 1);
  assert.equal(postDeletionExport.reconciliation.removedSafeCanceledAttempts, 1);
  assert.equal(postDeletionExport.reconciliation.reconciliationRate, 1);

  assert.throws(() => sqlite.prepare("DELETE FROM validation_feasibility_recruitment_events WHERE activation_id = ?")
    .run(activationId), /may be removed only with account privacy deletion/);
  assert.throws(() => sqlite.prepare("UPDATE validation_feasibility_corrections SET corrected_at = corrected_at")
    .run(), /append-only/);
  const accountDeletion = await handleAccountRequest(
    request("/api/profile", {
      method: "DELETE",
      cookie: user.cookie,
      body: { confirmation: "DELETE", password: user.password },
    }),
    env,
    sites,
  );
  assert.equal(accountDeletion?.status, 200, JSON.stringify(await accountDeletion?.clone().json()));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_events").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_corrections").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_recruitment_events").get().count, 1);
  assert.equal(sqlite.prepare(`SELECT SUM(removed_correction_count) AS count
    FROM validation_feasibility_correction_removals WHERE activation_id = ?`).get(activationId).count, 3);
  const directAccountDeletion = await handleAccountRequest(
    request("/api/profile", {
      method: "DELETE",
      cookie: directUser.cookie,
      body: { confirmation: "DELETE", password: directUser.password },
    }),
    env,
    sites,
  );
  assert.equal(directAccountDeletion?.status, 200, JSON.stringify(await directAccountDeletion?.clone().json()));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_events").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM validation_feasibility_recruitment_events").get().count, 0);
  assert.equal(sqlite.prepare(`SELECT SUM(removed_recruitment_count) AS count
    FROM validation_feasibility_recruitment_removals WHERE activation_id = ?`).get(activationId).count, 2);
  const allSuppressions = sqlite.prepare(`SELECT suppression_kind, suppressed_event_type,
      suppression_subject_sha256, source_event_sha256
    FROM validation_feasibility_snapshot_suppressions ORDER BY sequence`).all();
  assert.equal(allSuppressions.length, 8);
  assert.equal(allSuppressions.filter((row) => row.suppression_kind === "participant").length, 2);
  assert.equal(allSuppressions.filter((row) => row.suppression_kind === "trip").length, 6);
  assert.doesNotMatch(JSON.stringify(allSuppressions), new RegExp(`${user.id}|${directUser.id}|${first.trip.id}|${direct.trip.id}`));
  assert.throws(() => sqlite.prepare(`UPDATE validation_feasibility_snapshot_suppressions
    SET removed_at = removed_at`).run(), /immutable/);
  assert.throws(() => sqlite.prepare("DELETE FROM validation_feasibility_snapshot_suppressions").run(), /outlive retained snapshots/);
  assert.throws(() => sqlite.prepare(`INSERT INTO validation_feasibility_snapshot_suppressions (
      suppression_id, activation_id, suppression_kind, suppression_subject_sha256,
      suppressed_event_type, source_event_sha256, removed_at
    ) VALUES (?, ?, 'participant', ?, 'participant', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    .run(`fsuppress_${"a".repeat(31)}z`, activationId, "c".repeat(64), "f".repeat(64)), /CHECK constraint/);
});

test("profile edits recompute valid v2 evidence, reject overrides, and never promote legacy rows", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "26");
  const sites = [{ id: "ocean-beach", type: "Beach" }];
  const form = new FormData();
  form.set("siteId", "ocean-beach");
  form.set("startedAt", "2026-07-10T15:00:00.000Z");
  form.set("endedAt", "2026-07-10T18:00:00.000Z");
  form.set("keeperCount", "1");
  form.set("shortReleasedCount", "0");
  form.set("otherCatchCount", "0");
  form.set("opportunityWindowId", "window-profile-edit");
  form.set("opportunityScore", "73");
  form.set("habitatScore", "78");
  form.set("seasonalityScore", "68");
  form.set("conditionsScore", "71");
  form.set("fishabilityScore", "66");
  form.set("modelVersion", "model-profile-edit-v1");
  form.set("scoreInfluencedChoice", "true");
  form.set("predictionMetadata", JSON.stringify({
    snapshotGeneratedAt: "2026-07-10T14:00:00.000Z",
    forecastStart: "2026-07-10T15:00:00.000Z",
    forecastEnd: "2026-07-10T18:00:00.000Z",
    confidence: "medium",
  }));
  form.set("consent", "true");
  form.set("primaryTargetConfirmed", "true");
  form.set("completeAttempt", "true");
  form.set("mode", "beach");
  form.set("reporterKey", "profile-edit-device-key-123456789");
  form.set("website", "");
  const created = await handleTripRequest(new Request("https://castingcompass.com/api/trips/report", {
    method: "POST",
    headers: { Origin: "https://castingcompass.com" },
    body: form,
  }), { DB: d1 }, sites, {
    accountId: user.id,
    now: () => new Date("2026-07-11T18:00:00.000Z"),
  });
  assert.equal(created?.status, 201);
  const tripId = (await created.json()).trip.id;

  const editBody = {
    siteId: "ocean-beach",
    mode: "beach",
    startedAt: "2026-07-10T15:00:00.000Z",
    endedAt: "2026-07-10T18:00:00.000Z",
    anglerCount: 1,
    keeperCount: 0,
    shortReleasedCount: 0,
    fishingMethod: "artificial-lure",
    gearProfileId: "",
    rod: "",
    reel: "",
    baitLure: "",
    rig: "",
    otherCatchCount: 3,
    otherSpecies: "surfperch",
    shorebreak: "",
    wadingDepth: "",
    waterClarity: "",
    crowding: "",
    fishabilityRating: "",
    observedWaveHeightFeet: "",
    fishabilityNotes: "",
    notes: "",
  };
  const edited = await handleAccountRequest(request(`/api/profile/trips/${tripId}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: editBody,
  }), { DB: d1 }, sites);
  assert.equal(edited?.status, 200);
  assert.deepEqual(await edited.json(), {
    updated: true,
    tripId,
    forecastAttributionCleared: false,
    validationEvidenceExcluded: true,
  });
  const row = sqlite.prepare(`SELECT no_catch, observation_contract_version, taxon_catalog_version,
      target_taxon_id, contract_status, taxon_observations_json, outcome_class,
      target_encounter_count, any_fish_encounter_count, target_identification_confidence
    FROM trips WHERE id = ?`).get(tripId);
  assert.deepEqual({ ...row }, {
    no_catch: 0,
    observation_contract_version: "castingcompass.observation/2.0.0",
    taxon_catalog_version: "castingcompass.taxa/1.0.0",
    target_taxon_id: "california-halibut",
    contract_status: "valid",
    taxon_observations_json: JSON.stringify([
      {
        taxon_id: "california-halibut",
        encounter_count: 0,
        retained_count: 0,
        released_count: 0,
        disposition_unknown_count: 0,
        identification_confidence: "not_observed",
        identification_basis: "not-observed",
      },
      {
        taxon_id: "unresolved-fish",
        encounter_count: 3,
        retained_count: 0,
        released_count: 0,
        disposition_unknown_count: 3,
        identification_confidence: "unresolved",
        identification_basis: "unresolved",
      },
    ]),
    outcome_class: "non_target_only",
    target_encounter_count: 0,
    any_fish_encounter_count: 3,
    target_identification_confidence: "not_observed",
  });
  assert.deepEqual({ ...sqlite.prepare(`SELECT opportunity_window_id, opportunity_score,
      habitat_score, seasonality_score, conditions_score, fishability_score, model_version,
      score_influenced_choice, prediction_metadata_json FROM trips WHERE id = ?`).get(tripId) }, {
    opportunity_window_id: null,
    opportunity_score: null,
    habitat_score: null,
    seasonality_score: null,
    conditions_score: null,
    fishability_score: null,
    model_version: null,
    score_influenced_choice: 1,
    prediction_metadata_json: null,
  });

  const attributionEdit = await handleAccountRequest(request(`/api/profile/trips/${tripId}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: { ...editBody, mode: "shore" },
  }), { DB: d1 }, sites);
  assert.equal(attributionEdit?.status, 200);
  assert.deepEqual(await attributionEdit.json(), {
    updated: true,
    tripId,
    forecastAttributionCleared: true,
    validationEvidenceExcluded: true,
  });
  assert.deepEqual({ ...sqlite.prepare(`SELECT mode, opportunity_window_id, opportunity_score,
      habitat_score, seasonality_score, conditions_score, fishability_score, model_version,
      score_influenced_choice, prediction_metadata_json FROM trips WHERE id = ?`).get(tripId) }, {
    mode: "shore",
    opportunity_window_id: null,
    opportunity_score: null,
    habitat_score: null,
    seasonality_score: null,
    conditions_score: null,
    fishability_score: null,
    model_version: null,
    score_influenced_choice: 1,
    prediction_metadata_json: null,
  });
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM trip_validation_provenance
    WHERE trip_id = ? AND event_type = 'evidence_exclusion'
      AND attestation_status = 'invalidated_after_edit'
      AND exclusion_reason = 'post_completion_profile_edit'`).get(tripId).count, 2);

  const override = await handleAccountRequest(request(`/api/profile/trips/${tripId}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: {
      ...editBody,
      target_taxon_id: "unresolved-fish",
      taxonObservations: [],
      temporalPrecision: "exact",
      spatial_support: { kind: "point", x: 1, y: 2 },
    },
  }), { DB: d1 }, sites);
  assert.equal(override?.status, 422);
  assert.equal((await override.json()).error.code, "observation_contract_override_forbidden");
  assert.equal(sqlite.prepare("SELECT outcome_class FROM trips WHERE id = ?").get(tripId).outcome_class, "non_target_only");

  const legacyTripId = addTrip(sqlite, user);
  sqlite.prepare("UPDATE trips SET contract_status = 'legacy_unverified' WHERE id = ?").run(legacyTripId);
  const legacyEdit = await handleAccountRequest(request(`/api/profile/trips/${legacyTripId}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: { ...editBody, keeperCount: 2, otherCatchCount: 0, otherSpecies: "" },
  }), { DB: d1 }, sites);
  assert.equal(legacyEdit?.status, 200);
  assert.equal((await legacyEdit.json()).validationEvidenceExcluded, true);
  assert.deepEqual({ ...sqlite.prepare(`SELECT contract_status, observation_contract_version,
      taxon_observations_json, outcome_class, target_encounter_count, any_fish_encounter_count,
      target_identification_confidence FROM trips WHERE id = ?`).get(legacyTripId) }, {
    contract_status: "legacy_unverified",
    observation_contract_version: null,
    taxon_observations_json: null,
    outcome_class: null,
    target_encounter_count: null,
    any_fish_encounter_count: null,
    target_identification_confidence: null,
  });
});

test("active completion clears forecast attribution atomically when fishing mode changes", async () => {
  const { sqlite, d1 } = await database();
  const sites = [{ id: "ocean-beach", type: "Beach" }];
  const startResponse = await handleTripRequest(new Request("https://castingcompass.com/api/trips/start", {
    method: "POST",
    headers: { Origin: "https://castingcompass.com", "Content-Type": "application/json" },
    body: JSON.stringify({
      siteId: "ocean-beach",
      startedAt: "2026-07-10T10:00:00.000Z",
      mode: "pier",
      anglerCount: 1,
      consent: true,
      primaryTargetConfirmed: true,
      reporterKey: "mode-change-device-key-123456789",
      website: "",
      opportunityWindowId: "ocean-beach--20260710T1000Z",
      opportunityScore: 1,
      habitatScore: 1,
      seasonalityScore: 1,
      conditionsScore: 1,
      fishabilityScore: 1,
      modelVersion: "client-forged-model",
      scoreInfluencedChoice: true,
      predictionMetadata: {
        snapshotGeneratedAt: "2026-07-10T09:00:00.000Z",
        forecastStart: "2026-07-10T10:00:00.000Z",
        forecastEnd: "2026-07-10T12:00:00.000Z",
        confidence: "medium",
      },
    }),
  }), { DB: d1, ASSETS: privacyTestAssets() }, sites, { now: () => new Date("2026-07-10T10:00:00.000Z") });
  assert.equal(startResponse?.status, 201, JSON.stringify(await startResponse?.clone().json()));
  const started = await startResponse.json();

  const form = new FormData();
  form.set("token", started.token);
  form.set("endedAt", "2026-07-10T12:00:00.000Z");
  form.set("mode", "shore");
  form.set("anglerCount", "1");
  form.set("keeperCount", "0");
  form.set("shortReleasedCount", "0");
  form.set("otherCatchCount", "0");
  form.set("consent", "true");
  form.set("primaryTargetConfirmed", "true");
  form.set("completeAttempt", "true");
  form.set("website", "");
  const completionResponse = await handleTripRequest(new Request(
    `https://castingcompass.com/api/trips/${started.trip.id}/complete`,
    { method: "POST", headers: { Origin: "https://castingcompass.com" }, body: form },
  ), { DB: d1, ASSETS: privacyTestAssets() }, sites, { now: () => new Date("2026-07-10T12:00:00.000Z") });
  assert.equal(completionResponse?.status, 200);
  const completed = await completionResponse.json();
  assert.equal(completed.forecastAttributionCleared, true);
  assert.equal(completed.trip.mode, "shore");
  assert.equal(completed.trip.contractStatus, "valid");
  assert.equal(completed.trip.opportunityWindowId, null);
  assert.equal(completed.trip.opportunityScore, null);
  assert.equal(completed.trip.modelVersion, null);
  assert.equal(completed.trip.scoreInfluencedChoice, true);
  assert.deepEqual({ ...sqlite.prepare(`SELECT opportunity_window_id, opportunity_score,
      habitat_score, seasonality_score, conditions_score, fishability_score, model_version,
      score_influenced_choice, prediction_metadata_json FROM trips WHERE id = ?`).get(started.trip.id) }, {
    opportunity_window_id: null,
    opportunity_score: null,
    habitat_score: null,
    seasonality_score: null,
    conditions_score: null,
    fishability_score: null,
    model_version: null,
    score_influenced_choice: 1,
    prediction_metadata_json: null,
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM forecast_impressions WHERE trip_id = ?")
    .get(started.trip.id).count, 1);
  assert.deepEqual({ ...sqlite.prepare(`SELECT source_role, evidence_status, exclusion_reason,
      complete_attempt_confirmed, consented_at FROM trip_validation_provenance
    WHERE trip_id = ? AND event_type = 'completion'`).get(started.trip.id) }, {
    source_role: "context_only",
    evidence_status: "context_only",
    exclusion_reason: "mode_changed_after_enrollment",
    complete_attempt_confirmed: 1,
    consented_at: "2026-07-10T12:00:00.000Z",
  });
});

test("pending-only profile mutation loses cleanly to a concurrent moderator decision", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "27");
  const sites = [{ id: "ocean-beach", type: "Beach" }];
  const editTripId = addTrip(sqlite, user);
  let updateCallbacks = 0;
  d1.beforeOnceQuerySubstring = "UPDATE trips SET site_id";
  d1.beforeOnceQuery = () => sqlite.prepare("UPDATE trips SET moderation_status = 'approved' WHERE id = ?").run(editTripId);
  const racedPatch = await handleAccountRequest(request(`/api/profile/trips/${editTripId}`, {
    method: "PATCH",
    cookie: user.cookie,
    body: {
      siteId: "ocean-beach",
      mode: "shore",
      startedAt: "2026-07-01T09:30:00.000Z",
      endedAt: "2026-07-01T12:00:00.000Z",
      anglerCount: 1,
      keeperCount: 1,
      shortReleasedCount: 2,
      fishingMethod: "artificial-lure",
      gearProfileId: "",
      rod: "Rod A",
      reel: "Reel B",
      baitLure: "Swimbait",
      rig: "Drop shot",
      otherCatchCount: 1,
      otherSpecies: "surfperch",
      shorebreak: "",
      wadingDepth: "",
      waterClarity: "clear",
      crowding: "",
      fishabilityRating: "",
      observedWaveHeightFeet: "",
      fishabilityNotes: "",
      notes: "changed",
    },
  }), { DB: d1 }, sites, { onTripUpdated: () => { updateCallbacks += 1; } });
  assert.equal(racedPatch?.status, 409);
  assert.equal((await racedPatch.json()).error.code, "trip_reviewed");
  assert.equal(updateCallbacks, 0);
  assert.deepEqual({ ...sqlite.prepare("SELECT moderation_status, notes FROM trips WHERE id = ?").get(editTripId) }, {
    moderation_status: "approved",
    notes: "User trip notes",
  });

  const deleteTripId = addTrip(sqlite, user, { photoKey: "private/raced-delete.jpg" });
  d1.beforeOnceQuerySubstring = "INSERT INTO privacy_deletion_jobs";
  d1.beforeOnceQuery = () => sqlite.prepare("UPDATE trips SET moderation_status = 'approved' WHERE id = ?").run(deleteTripId);
  const racedDelete = await handleAccountRequest(request(`/api/profile/trips/${deleteTripId}`, {
    method: "DELETE",
    cookie: user.cookie,
  }), { DB: d1, TRIP_PHOTOS: { delete: async () => undefined } }, sites);
  assert.equal(racedDelete?.status, 409);
  assert.equal((await racedDelete.json()).error.code, "trip_reviewed");
  assert.equal(sqlite.prepare("SELECT moderation_status FROM trips WHERE id = ?").get(deleteTripId).moderation_status, "approved");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_jobs WHERE scope = 'trip'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_tasks").get().count, 0);
});

test("AI provider payload omits hostile legacy forecast metadata at the egress boundary", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "20");
  const tripId = addTrip(sqlite, user);
  sqlite.prepare(`UPDATE trips SET ai_review_status = NULL, prediction_metadata_json = ? WHERE id = ?`)
    .run(JSON.stringify({
      snapshotGeneratedAt: "2026-07-01T00:00:00.000Z",
      latitude: 37.7749,
      email: "private-person@example.com",
      forecastConditions: {
        longitude: -122.4194,
        accountId: "account-secret-123",
        nested: { coordinates: [37.7749, -122.4194] },
      },
    }), tripId);

  let providerBody = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    providerBody = String(init?.body ?? "");
    return Response.json({
      choices: [{ message: { content: JSON.stringify({
        quality_score: 90,
        flags: [],
        summary: "Complete report.",
        needs_human_review: false,
        gear_analysis: {
          rod: { brand: null, series: null, model: null, confidence: "low" },
          reel: { brand: null, series: null, model: null, confidence: "low" },
          lure: { brand: null, series: null, model: null, confidence: "low" },
          setup_tags: [],
          compatibility_flags: [],
          technique_match_summary: null,
        },
        discussion: { publish: false, summary: "", gear_summary: null, technique_tags: [] },
      }) } }],
    });
  };
  try {
    await reviewTripWithMimo({ DB: d1, MIMO_API_KEY: "test" }, tripId, [{ id: "ocean-beach", type: "Beach" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(providerBody);
  const outbound = JSON.parse(providerBody);
  const tripPayload = JSON.parse(outbound.messages.at(-1).content);
  assert.equal("forecastMetadata" in tripPayload, false);
  assert.equal(tripPayload.primaryTargetTaxonId, "california-halibut");
  assert.equal(tripPayload.contractStatus, "legacy_unverified");
  assert.equal(tripPayload.taxonObservations, null);
  assert.equal(tripPayload.reportedOtherSpeciesLabel, "surfperch");
  assert.match(outbound.messages[0].content, /legacy_unverified or missing structured evidence as non-model evidence/);
  assert.doesNotMatch(providerBody, /latitude|longitude|coordinates|private-person@example\.com|account-secret-123|37\.7749|122\.4194/);
});

test("AI review suppresses dispatch after a committed tombstone and cannot resurrect after authorized dispatch", async () => {
  const { sqlite, d1 } = await database();
  const user = await addUser(sqlite, "7");
  const tripId = addTrip(sqlite, user);
  sqlite.prepare("UPDATE trips SET ai_review_status = NULL WHERE id = ?").run(tripId);
  sqlite.prepare("DELETE FROM trips WHERE id = ?").run(tripId);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ choices: [] });
  };
  try {
    await reviewTripWithMimo({ DB: d1, MIMO_API_KEY: "test" }, tripId, [{ id: "ocean-beach" }]);
    assert.equal(calls, 0);

    const tripId2 = addTrip(sqlite, user);
    sqlite.prepare("UPDATE trips SET ai_review_status = NULL WHERE id = ?").run(tripId2);
    const originalPrepare = d1.prepare.bind(d1);
    let deleteAfterClaim = true;
    d1.prepare = (query) => {
      const statement = originalPrepare(query);
      if (deleteAfterClaim && query.includes("SELECT * FROM trips") && query.includes("ai_review_status = 'processing'")) {
        const originalFirst = statement.first.bind(statement);
        statement.first = async () => {
          deleteAfterClaim = false;
          sqlite.prepare("DELETE FROM trips WHERE id = ?").run(tripId2);
          return originalFirst();
        };
      }
      return statement;
    };
    await reviewTripWithMimo({ DB: d1, MIMO_API_KEY: "test" }, tripId2, [{ id: "ocean-beach" }]);
    assert.equal(calls, 0);

    d1.prepare = originalPrepare;
    const tripA = addTrip(sqlite, user);
    const tripB = addTrip(sqlite, user);
    sqlite.prepare("UPDATE trips SET ai_review_status = NULL WHERE id IN (?, ?)").run(tripA, tripB);
    await addDeletionTombstone(sqlite, { scope: "trip", subjectId: tripA, ownerId: user.id, suffix: "trip-a" });
    await reviewTripWithMimo({ DB: d1, MIMO_API_KEY: "test" }, tripB, [{ id: "ocean-beach" }]);
    assert.equal(calls, 1, "a trip tombstone must not block later trips for the same account");

    const tripId3 = addTrip(sqlite, user);
    sqlite.prepare("UPDATE trips SET ai_review_status = NULL WHERE id = ?").run(tripId3);
    let tombstoneBeforeDispatch = true;
    d1.prepare = (query) => {
      const statement = originalPrepare(query);
      if (tombstoneBeforeDispatch && query.includes("FROM privacy_deletion_jobs")) {
        const originalFirst = statement.first.bind(statement);
        statement.first = async () => {
          tombstoneBeforeDispatch = false;
          await addDeletionTombstone(sqlite, {
            scope: "trip",
            subjectId: tripId3,
            ownerId: user.id,
            suffix: "before-dispatch",
          });
          return originalFirst();
        };
      }
      return statement;
    };
    await reviewTripWithMimo({ DB: d1, MIMO_API_KEY: "test" }, tripId3, [{ id: "ocean-beach" }]);
    assert.equal(calls, 1, "a committed deletion tombstone before dispatch must suppress the provider request");

    d1.prepare = originalPrepare;
    const tripId4 = addTrip(sqlite, user);
    sqlite.prepare("UPDATE trips SET ai_review_status = NULL WHERE id = ?").run(tripId4);
    globalThis.fetch = async () => {
      calls += 1;
      sqlite.prepare("DELETE FROM trips WHERE id = ?").run(tripId4);
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          quality_score: 90,
          flags: [],
          summary: "Complete report.",
          needs_human_review: false,
          gear_analysis: {
            rod: { brand: null, series: null, model: null, confidence: "low" },
            reel: { brand: null, series: null, model: null, confidence: "low" },
            lure: { brand: null, series: null, model: null, confidence: "low" },
            setup_tags: [],
            compatibility_flags: [],
            technique_match_summary: null,
          },
          discussion: { publish: true, summary: "Candidate", gear_summary: null, technique_tags: [] },
        }) } }],
      });
    };
    await reviewTripWithMimo({ DB: d1, MIMO_API_KEY: "test" }, tripId4, [{ id: "ocean-beach" }]);
    assert.equal(calls, 2, "authorization before deletion may dispatch an already-entering provider request");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trips WHERE id = ?").get(tripId4).count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM site_discussion_posts WHERE trip_id = ?").get(tripId4).count, 0);
  } finally {
    d1.prepare = TransactionalD1Adapter.prototype.prepare.bind(d1);
    globalThis.fetch = originalFetch;
  }
});

test("privacy migration is idempotent and contains restore-match hashes and owner index", async () => {
  const { sqlite } = await database();
  const migration = await readFile(new URL("../drizzle/0010_privacy_durability.sql", import.meta.url), "utf8");
  sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  const jobColumns = sqlite.prepare("PRAGMA table_info(privacy_deletion_jobs)").all().map((column) => column.name);
  assert.ok(jobColumns.includes("subject_hash"));
  assert.ok(jobColumns.includes("owner_subject_hash"));
  assert.ok(jobColumns.includes("completed_at"));
  const taskColumns = sqlite.prepare("PRAGMA table_info(privacy_deletion_tasks)").all().map((column) => column.name);
  assert.ok(taskColumns.includes("lease_token"));
  const taskDefinition = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'privacy_deletion_tasks'").get().sql;
  assert.match(taskDefinition, /privacy_deletion_tasks_locator_check/);
  const indexes = sqlite.prepare("PRAGMA index_list(privacy_deletion_jobs)").all().map((index) => index.name);
  assert.ok(indexes.includes("privacy_deletion_jobs_owner_state_idx"));
});
