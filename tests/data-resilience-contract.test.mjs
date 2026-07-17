import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("D1 migration, runtime bootstrap, schema, and CI share the critical index contract", async () => {
  const [migration, auth, trips, schema, ci, checker] = await Promise.all([
    readFile(new URL("drizzle/0016_data_resilience_indexes.sql", root), "utf8"),
    readFile(new URL("worker/auth.ts", root), "utf8"),
    readFile(new URL("worker/trips.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    readFile(new URL("scripts/check_d1_query_plans.py", root), "utf8"),
  ]);
  const names = [
    "auth_sessions_expires_idx",
    "saved_sites_user_created_idx",
    "auth_attempts_attempted_idx",
    "email_challenges_expires_idx",
    "email_challenges_user_idx",
    "signup_age_proofs_consumed_idx",
    "privacy_deletion_jobs_scope_subject_idx",
    "privacy_deletion_jobs_state_completed_idx",
    "trips_user_history_idx",
    "trips_user_created_idx",
    "trips_ai_review_backlog_idx",
    "trips_reporter_active_created_idx",
    "trip_validation_provenance_forecast_trip_idx",
    "validation_feasibility_recruitment_user_sequence_idx",
    "validation_feasibility_correction_activation_sequence_idx",
  ];
  for (const name of names) {
    assert.match(migration, new RegExp(`\\b${name}\\b`));
    assert.match(schema, new RegExp(`\\b${name}\\b`));
  }
  for (const name of names.slice(0, 8)) assert.match(auth, new RegExp(`\\b${name}\\b`));
  for (const name of names.slice(8, 13)) assert.match(trips, new RegExp(`\\b${name}\\b`));
  assert.match(ci, /python scripts\/check_d1_query_plans\.py/);
  assert.match(checker, /EXPLAIN QUERY PLAN/);
  assert.match(checker, /assert_foreign_key_indexes/);
});

test("cache policy never shares API or personalized responses", async () => {
  const [security, serviceWorker, headers, policy] = await Promise.all([
    readFile(new URL("worker/security.ts", root), "utf8"),
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(new URL("public/_headers", root), "utf8"),
    readFile(new URL("docs/CACHING-STRATEGY.md", root), "utf8"),
  ]);
  assert.match(security, /isApi \|\| headers\.has\("Set-Cookie"\) \|\| response\.status >= 400/);
  assert.match(security, /CDN-Cache-Control", "no-store"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /PUBLIC_NAVIGATION_PATHS\.has\(url\.pathname\)/);
  assert.match(serviceWorker, /cacheControl\.includes\("private"\)/);
  assert.match(headers, /\/data\/opportunities\.json[\s\S]+s-maxage=300/);
  assert.match(headers, /\/data\/sites\.json[\s\S]+s-maxage=3600/);
  assert.match(policy, /never an authorization source/i);
  assert.match(policy, /never supplies an offline API response/i);
});

test("connection and load contracts keep D1 managed and remote stress explicit", async () => {
  const [repository, performancePolicy, loadHarness] = await Promise.all([
    readFile(new URL("services/api/app/repository.py", root), "utf8"),
    readFile(new URL("docs/PERFORMANCE-READINESS.md", root), "utf8"),
    readFile(new URL("scripts/load-test.mjs", root), "utf8"),
  ]);
  assert.match(repository, /ConnectionPool\(/);
  assert.match(repository, /min_size=minimum/);
  assert.match(repository, /max_size=maximum/);
  assert.match(repository, /max_waiting=/);
  assert.match(repository, /open=False/);
  assert.match(performancePolicy, /does \*\*not\*\* create a SQL\s+connection pool/i);
  assert.match(performancePolicy, /No migration was applied while preparing this change/i);
  assert.match(performancePolicy, /Failure injection and penetration testing remain separate authorized exercises/i);
  assert.match(loadHarness, /production CastingCompass hostnames are permanently blocked/);
  assert.match(loadHarness, /I_HAVE_AUTHORIZATION_FOR_THIS_STAGING_TARGET/);
  assert.doesNotMatch(loadHarness, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
});
