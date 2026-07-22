import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverInventory,
  validatePolicy,
} from "../scripts/generate-d1-query-inventory.mjs";

const root = new URL("../", import.meta.url);

function acceptedPolicy(inventory, overrides = {}) {
  return {
    schemaVersion: "castingcompass.d1-query-inventory-policy/1.0.0",
    sourceFiles: inventory.sourceFiles.map(({ file }) => file),
    expectedSummary: { ...inventory.summary },
    allowedNonLiteralExpressions: inventory.queries
      .filter(({ argumentKind }) => argumentKind === "reviewed-nonliteral")
      .map(({ file, expressionSha256 }) => ({
        file,
        expressionSha256,
        staticAuthority: "test-owned fixed expression",
        executionContract: "test-only query",
        rationale: "The fixture deliberately accepts this exact expression.",
      })),
    multiRowReadContracts: inventory.queries
      .filter((query) => query.executionMode === "all" && query.statementClass === "SELECT" && !query.hasLimit)
      .map((query) => ({
        callSiteId: query.callSiteId,
        sqlSha256: query.sqlSha256,
        scope: "test owner",
        boundPredicate: "user_id = ?",
        rowBoundStatus: "test-fixture",
        rationale: "The fixture is scoped by its bound test user.",
      })),
    ...overrides,
  };
}

async function fixture(source) {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-d1-inventory-"));
  await mkdir(join(directory, "worker"));
  await mkdir(join(directory, "security"));
  await writeFile(join(directory, "worker/runtime.ts"), source, "utf8");
  await writeFile(join(directory, "security/d1-query-inventory-policy.json"), "{}\n", "utf8");
  return directory;
}

test("the committed inventory covers every Worker prepare site and its reviewed exceptions", async () => {
  const [{ policy, inventory }, committed] = await Promise.all([
    Promise.resolve(discoverInventory()),
    readFile(new URL("security/d1-query-inventory.json", root), "utf8"),
  ]);
  validatePolicy(policy, inventory);
  assert.deepEqual(JSON.parse(committed), inventory);
  assert.deepEqual(inventory.summary, {
    prepareCallCount: 239,
    literalCallCount: 213,
    nonLiteralCallCount: 26,
    multiRowLiteralWithoutLimitCount: 12,
  });
  assert.equal(inventory.sourceFiles.length, 8);
  assert.equal(new Set(inventory.queries.map(({ callSiteId }) => callSiteId)).size, 239);
  assert.equal(policy.multiRowReadContracts.filter(({ rowBoundStatus }) => rowBoundStatus === "open-account-cardinality").length, 0);
  assert.equal(policy.multiRowReadContracts.filter(({ rowBoundStatus }) => rowBoundStatus === "complete-rights-export").length, 9);
  assert.equal(policy.multiRowReadContracts.filter(({ rowBoundStatus }) => rowBoundStatus === "owner-lifecycle-cleanup").length, 3);

  const boundedAccountLists = inventory.queries.filter(({ executionMode, hasLimit, sql }) =>
    executionMode === "all"
      && hasLimit
      && /FROM (?:saved_sites|gear_profiles) WHERE user_id = \? ORDER BY/u.test(sql ?? "")
      && /LIMIT 101$/u.test(sql ?? ""));
  assert.equal(boundedAccountLists.length, 4);

  const gearInsert = inventory.queries.find(({ sql }) => sql?.startsWith("INSERT INTO gear_profiles"));
  assert.match(gearInsert?.sql ?? "", /WHERE \(SELECT COUNT\(\*\) FROM gear_profiles WHERE user_id = \?\) < 100$/u);
  const savedSiteInsert = inventory.queries.find(({ sql }) => sql?.startsWith("INSERT OR IGNORE INTO saved_sites"));
  assert.match(savedSiteInsert?.sql ?? "", /WHERE \(SELECT COUNT\(\*\) FROM saved_sites WHERE user_id = \?\) < 100$/u);
  assert.ok(inventory.queries.some(({ executionMode, sql }) =>
    executionMode === "first"
      && sql === "SELECT 1 AS present FROM saved_sites WHERE user_id = ? AND site_id = ? LIMIT 1"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "DELETE"
      && sql === "DELETE FROM saved_sites WHERE user_id = ? AND site_id = ?"));

  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "UPDATE"
      && sql === "UPDATE gear_profiles SET name = ?, rod = ?, reel = ?, bait_lure = ?, rig = ?, updated_at = ? WHERE id = ? AND user_id = ?"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "DELETE"
      && sql === "DELETE FROM gear_profiles WHERE id = ? AND user_id = ?"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "batch"
      && statementClass === "DELETE"
      && sql === "DELETE FROM trips WHERE id = ? AND user_id = ? AND moderation_status = 'pending'"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "UPDATE"
      && sql === "UPDATE users SET terms_accepted_at = ?, terms_version = ?, privacy_accepted_at = ?, privacy_version = ?, updated_at = ? WHERE id = ?"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "batch"
      && statementClass === "UPDATE"
      && sql === "UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM email_challenges WHERE id = ? AND kind = 'password_reset' AND user_id = ? AND code_hash = ? AND created_at = ? AND attempts = ? AND expires_at > ?)"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "batch"
      && statementClass === "INSERT"
      && sql === "INSERT INTO users (id, email, password_salt, password_hash, age_eligibility_confirmed_at, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM email_challenges WHERE id = ? AND kind = 'signup' AND code_hash = ? AND created_at = ? AND attempts = ? AND expires_at > ?)"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "batch"
      && statementClass === "INSERT"
      && sql === "INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"));
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "DELETE"
      && sql === "DELETE FROM auth_sessions WHERE token_hash = ?"));

  const signInAttemptClaim = inventory.queries.find(({ sql }) =>
    sql?.startsWith("INSERT INTO auth_attempts (id, email_hash, attempted_at, successful) SELECT"));
  assert.equal(signInAttemptClaim?.executionMode, "run");
  assert.match(signInAttemptClaim?.sql ?? "", /WHERE \(SELECT COUNT\(\*\) FROM auth_attempts WHERE email_hash = \? AND successful = 0 AND attempted_at >= \?\) < 10$/u);
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "UPDATE"
      && sql === "UPDATE auth_attempts SET successful = 1 WHERE id = ? AND email_hash = ? AND attempted_at = ? AND successful = 0"));

  const challengeIssuanceClaims = inventory.queries.filter(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "INSERT"
      && sql?.startsWith("INSERT INTO email_challenges")
      && /WHERE \(SELECT COUNT\(\*\) FROM email_challenges WHERE email = \? AND created_at >= \?\) < 5$/u.test(sql));
  assert.equal(challengeIssuanceClaims.length, 2);
  assert.ok(inventory.queries.some(({ executionMode, statementClass, sql }) =>
    executionMode === "run"
      && statementClass === "UPDATE"
      && sql === "UPDATE email_challenges SET attempts = ? WHERE id = ? AND kind = ? AND code_hash = ? AND created_at = ? AND attempts = ? AND resend_count = ? AND expires_at = ? AND expires_at > ?"));

  const terminalTripWrites = inventory.queries.filter(({ executionMode, statementClass, sql }) =>
    executionMode === "prepared-statement"
      && statementClass === "UPDATE"
      && /UPDATE trips SET/u.test(sql ?? "")
      && /WHERE id = \? AND user_id IS \? AND status = 'active' AND token_hash = \?$/u.test(sql ?? ""));
  assert.equal(terminalTripWrites.length, 2);
  assert.ok(terminalTripWrites.some(({ sql }) => /status = 'completed'/u.test(sql ?? "")));
  assert.ok(terminalTripWrites.some(({ sql }) =>
    sql === "UPDATE trips SET token_hash = NULL, updated_at = ? WHERE id = ? AND user_id IS ? AND status = 'active' AND token_hash = ?"));

  const manualReviewRetryWrites = inventory.queries.filter(({ file, executionMode, statementClass, sql }) =>
    file === "worker/auth.ts"
      && executionMode === "batch"
      && statementClass === "UPDATE"
      && sql?.startsWith("UPDATE trips SET ai_review_status = 'queued'"));
  assert.equal(manualReviewRetryWrites.length, 1);
  assert.equal(
    manualReviewRetryWrites[0].sql,
    "UPDATE trips SET ai_review_status = 'queued', ai_review_json = NULL, ai_review_model = NULL, ai_reviewed_at = NULL WHERE id = ? AND user_id = ? AND (ai_review_status IS NULL OR ai_review_status = 'retry')",
  );
  const legacyReviewBacklog = inventory.queries.find(({ containingFunction }) =>
    containingFunction === "reviewTripBacklog");
  assert.match(
    legacyReviewBacklog?.sql ?? "",
    /ai_review_status IS NULL OR ai_review_status = 'queued' OR ai_review_status = 'retry'/u,
  );
  assert.match(legacyReviewBacklog?.sql ?? "", /ai_review_status = 'processing'/u);
  assert.match(legacyReviewBacklog?.sql ?? "", /json_extract\(ai_review_json, '\$\.leaseExpiresAt'\)/u);
  assert.ok(inventory.queries.some(({ file, executionMode, statementClass, sql }) =>
    file === "worker/trip-review.ts"
      && executionMode === "run"
      && statementClass === "UPDATE"
      && sql === "UPDATE trips SET ai_review_status = 'reviewed', ai_review_json = ?, ai_review_model = ?, ai_reviewed_at = ? WHERE id = ? AND ai_review_status = 'processing' AND ai_review_json = ?"));
  assert.ok(inventory.queries.some(({ file, executionMode, statementClass, sql }) =>
    file === "worker/trip-review-queue.ts"
      && executionMode === "first"
      && statementClass === "SELECT"
      && sql === "SELECT id FROM ai_review_jobs WHERE id = ? AND state = 'queued' AND lease_token = ? AND available_at = ? LIMIT 1"));
  assert.ok(inventory.queries.some(({ file, executionMode, statementClass, sql }) =>
    file === "worker/trip-review-queue.ts"
      && executionMode === "first"
      && statementClass === "SELECT"
      && sql === "SELECT id, trip_id, state, attempts, available_at, lease_expires_at, lease_token FROM ai_review_jobs WHERE id = ? AND state = 'processing' AND lease_token = ? LIMIT 1"));
  assert.ok(inventory.queries.some(({ file, statementClass, sql }) =>
    file === "worker/trip-review-queue.ts"
      && statementClass === "UPDATE"
      && sql === "UPDATE ai_review_jobs SET state = 'completed', available_at = ?, lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ? AND state = 'processing' AND lease_token = ?"));
  assert.ok(inventory.queries.some(({ file, statementClass, sql }) =>
    file === "worker/trip-review-queue.ts"
      && statementClass === "UPDATE"
      && /last_error_code = 'review_lease_abandoned'/u.test(sql ?? "")
      && /attempts >= \?/u.test(sql ?? "")));
  assert.ok(inventory.queries.some(({ file, executionMode, statementClass, sql }) =>
    file === "worker/privacy-export.ts"
      && executionMode === "first"
      && statementClass === "SELECT"
      && sql === "SELECT id FROM privacy_export_jobs WHERE id = ? AND user_id IS NOT NULL AND state = 'queued' AND lease_token = ? AND available_at = ? LIMIT 1"));
  assert.ok(inventory.queries.some(({ file, executionMode, statementClass, sql }) =>
    file === "worker/privacy-export.ts"
      && executionMode === "first"
      && statementClass === "SELECT"
      && /state = 'processing' AND lease_token = \? AND object_key IS NULL LIMIT 1$/u.test(sql ?? "")));
  assert.ok(inventory.queries.some(({ file, executionMode, statementClass, sql }) =>
    file === "worker/privacy-export.ts"
      && executionMode === "first"
      && statementClass === "SELECT"
      && /state = 'completed' AND lease_token IS NULL/u.test(sql ?? "")
      && /content_sha256 = \? AND size_bytes = \? AND record_count = \?/u.test(sql ?? "")));
  assert.ok(inventory.queries.some(({ file, executionMode, statementClass, sql }) =>
    file === "worker/privacy-export.ts"
      && executionMode === "first"
      && statementClass === "SELECT"
      && sql === "SELECT id FROM privacy_export_jobs WHERE id = ? AND state = ? AND lease_token = ? AND lease_expires_at = ? AND object_key = ? AND user_id IS ? LIMIT 1"));
  assert.ok(inventory.queries.some(({ file, statementClass, sql }) =>
    file === "worker/privacy-export.ts"
      && statementClass === "UPDATE"
      && /last_error_code = 'export_lease_abandoned'/u.test(sql ?? "")
      && /attempts >= \? AND object_key IS NULL/u.test(sql ?? "")));

  const exactOwnerTripRead = inventory.queries.find(({ sql }) =>
    sql === "SELECT * FROM trips WHERE id = ? AND user_id IS ? LIMIT 1");
  assert.equal(exactOwnerTripRead?.executionMode, "first");
  assert.equal(inventory.queries.some(({ sql }) => sql === "SELECT * FROM trips WHERE id = ? LIMIT 1"), false);

  const ownerSidecarReads = inventory.queries.filter(({ file, executionMode, sql }) =>
    file === "worker/trips.ts"
      && executionMode === "first"
      && /FROM (?:validation_feasibility_recruitment_events|validation_feasibility_events AS event|trip_validation_provenance AS provenance|forecast_impressions AS impression)/u.test(sql ?? "")
      && /user_id IS \?/u.test(sql ?? ""));
  assert.equal(ownerSidecarReads.length, 5);
  assert.ok(ownerSidecarReads.some(({ sql }) =>
    /FROM validation_feasibility_recruitment_events .* user_id IS \? LIMIT 1$/u.test(sql ?? "")));
  assert.equal(ownerSidecarReads.filter(({ sql }) => /owner_trip\.user_id IS \?/u.test(sql ?? "")).length, 4);

  const ownerProfileSidecarReads = inventory.queries.filter(({ file, executionMode, sql }) =>
    file === "worker/auth.ts"
      && executionMode === "first"
      && /FROM (?:validation_feasibility_events AS event|validation_feasibility_corrections AS correction)/u.test(sql ?? "")
      && /owner_trip\.user_id = \?/u.test(sql ?? ""));
  assert.equal(ownerProfileSidecarReads.length, 3);
  assert.equal(ownerProfileSidecarReads.filter(({ sql }) => /event_type = '(?:started|completed)'/u.test(sql ?? "")).length, 2);
  assert.ok(ownerProfileSidecarReads.some(({ sql }) =>
    /ORDER BY correction\.sequence DESC LIMIT 1$/u.test(sql ?? "")));

  const opaqueTripIdentityRead = inventory.queries.find(({ sql }) =>
    sql === "SELECT 1 AS reserved FROM trips WHERE id = ? LIMIT 1");
  assert.equal(opaqueTripIdentityRead?.executionMode, "first");
  assert.deepEqual(opaqueTripIdentityRead?.tables, ["trips"]);
});

test("unscoped writes and unreviewed multi-row reads fail closed", async () => {
  const directory = await fixture(`
    export async function query(db, userId) {
      await db.prepare("SELECT id FROM trips WHERE user_id = ?").bind(userId).all();
      await db.prepare("DELETE FROM trips").run();
    }
  `);
  const { inventory } = discoverInventory(directory);
  assert.throws(() => validatePolicy(acceptedPolicy(inventory), inventory), /unscoped D1 write query/u);

  const safeDirectory = await fixture(`
    export async function query(db, userId) {
      return db.prepare("SELECT id FROM trips WHERE user_id = ?").bind(userId).all();
    }
  `);
  const { inventory: safeInventory } = discoverInventory(safeDirectory);
  assert.throws(
    () => validatePolicy(acceptedPolicy(safeInventory, { multiRowReadContracts: [] }), safeInventory),
    /unreviewed multi-row read/u,
  );
});

test("dynamic and computed SQL entry points require an exact review or are rejected", async () => {
  const directory = await fixture(`
    const OWNER_QUERY = "SELECT id FROM trips WHERE user_id = ? LIMIT 10";
    export async function query(db, userId) {
      return db.prepare(OWNER_QUERY).bind(userId).all();
    }
  `);
  const { inventory } = discoverInventory(directory);
  assert.throws(
    () => validatePolicy(acceptedPolicy(inventory, { allowedNonLiteralExpressions: [] }), inventory),
    /unreviewed nonliteral SQL expression/u,
  );
  validatePolicy(acceptedPolicy(inventory), inventory);

  const computedDirectory = await fixture(`
    export async function query(db) {
      return db[\`prepare\`]("SELECT 1").first();
    }
  `);
  assert.throws(() => discoverInventory(computedDirectory), /computed D1 prepare access/u);

  const aliasedDirectory = await fixture(`
    export async function query(db) {
      const prepare = db.prepare;
      return prepare("SELECT 1").first();
    }
  `);
  assert.throws(() => discoverInventory(aliasedDirectory), /aliases D1 prepare/u);
});
