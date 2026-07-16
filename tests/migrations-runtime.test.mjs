import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getAuthenticatedUser } from "../worker/auth.ts";
import { handleDiscussionRequest } from "../worker/discussions.ts";
import { createTripStore } from "../worker/trips.ts";

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

const migrationDirectory = new URL("../drizzle/", import.meta.url);

async function migrationFiles() {
  return (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function applyMigration(sqlite, file) {
  const sql = (await readFile(new URL(file, migrationDirectory), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
  sqlite.exec(`BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`);
}

function columns(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function schemaVersion(sqlite) {
  return sqlite.prepare("PRAGMA schema_version").get().schema_version;
}

test("the complete migration chain applies atomically and produces the runtime schema", async () => {
  const files = await migrationFiles();
  assert.deepEqual(files, [
    "0000_unique_tusk.sql",
    "0001_accounts_and_saved_sites.sql",
    "0002_profile_trip_ownership.sql",
    "0003_email_verification_and_recovery.sql",
    "0004_advisory_trip_review.sql",
    "0005_fishability_and_gear.sql",
    "0006_moderated_location_discussions.sql",
    "0007_legal_acceptance.sql",
    "0009_human_discussion_approval.sql",
  ]);

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of files) await applyMigration(sqlite, file);

  assert.deepEqual(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map((row) => row.name),
    ["auth_attempts", "auth_sessions", "email_challenges", "gear_profiles", "saved_sites", "site_discussion_posts", "trips", "users"],
  );
  assert.ok(columns(sqlite, "trips").includes("user_id"));
  assert.ok(columns(sqlite, "trips").includes("ai_reviewed_at"));
  assert.ok(columns(sqlite, "trips").includes("fishability_score"));
  assert.ok(columns(sqlite, "email_challenges").includes("resend_count"));
  assert.ok(columns(sqlite, "email_challenges").includes("privacy_version"));
  assert.deepEqual(
    columns(sqlite, "site_discussion_posts").slice(-3),
    ["approved_at", "approved_by", "source_ai_reviewed_at"],
  );
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(sqlite.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("the approval migration quarantines a legacy discussion row", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of await migrationFiles()) {
    if (file === "0009_human_discussion_approval.sql") {
      sqlite.prepare(`INSERT INTO trips (
        id, status, source, site_id, started_at, mode, angler_count, consent,
        moderation_status, reporter_key_hash, created_at, updated_at
      ) VALUES ('trip_legacy', 'completed', 'past_report', 'ocean-beach',
        '2026-07-01T10:00:00.000Z', 'shore', 1, 1, 'approved', 'hash',
        '2026-07-01T10:00:00.000Z', '2026-07-01T12:00:00.000Z')`).run();
      sqlite.prepare(`INSERT INTO site_discussion_posts (
        id, trip_id, site_id, summary, observed_at, created_at, updated_at
      ) VALUES ('legacy', 'trip_legacy', 'ocean-beach', 'Legacy text',
        '2026-07-01T12:00:00.000Z', '2026-07-01T12:00:00.000Z',
        '2026-07-01T12:00:00.000Z')`).run();
    }
    await applyMigration(sqlite, file);
  }

  assert.deepEqual(
    { ...sqlite.prepare("SELECT approved_at, approved_by, source_ai_reviewed_at FROM site_discussion_posts WHERE id = 'legacy'").get() },
    { approved_at: null, approved_by: null, source_ai_reviewed_at: null },
  );
});

test("runtime initializers do not mutate a fully migrated schema", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of await migrationFiles()) await applyMigration(sqlite, file);
  const d1 = new D1Adapter(sqlite);
  const before = schemaVersion(sqlite);

  await createTripStore(d1).initialize();
  assert.equal(await getAuthenticatedUser(new Request("https://castingcompass.com/api/auth/session"), { DB: d1 }), null);
  const response = await handleDiscussionRequest(
    new Request("https://castingcompass.com/api/discussions/ocean-beach"),
    { DB: d1, PUBLIC_DISCUSSIONS_ENABLED: "true" },
    [{ id: "ocean-beach" }],
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { posts: [] });
  assert.equal(schemaVersion(sqlite), before);
});
