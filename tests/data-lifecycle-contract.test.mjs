import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationDirectory = new URL("../drizzle/", import.meta.url);

async function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    const source = await readFile(new URL(migration, migrationDirectory), "utf8");
    sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
  }
  return sqlite;
}

function foreignKeys(sqlite, table) {
  return sqlite.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table);
}

function assertForeignKey(sqlite, table, from, parent, parentColumn, onDelete) {
  assert.ok(
    foreignKeys(sqlite, table).some((key) => (
      key.from === from
      && key.table === parent
      && key.to === parentColumn
      && key.on_delete === onDelete
    )),
    `${table}.${from} must reference ${parent}.${parentColumn} with ON DELETE ${onDelete}`,
  );
}

test("the migrated schema preserves the documented account and trip cascade boundaries", async () => {
  const sqlite = await migratedDatabase();
  for (const table of ["auth_sessions", "email_challenges", "saved_sites", "gear_profiles"]) {
    assertForeignKey(sqlite, table, "user_id", "users", "id", "CASCADE");
  }
  assertForeignKey(sqlite, "trips", "user_id", "users", "id", "SET NULL");
  assertForeignKey(sqlite, "site_discussion_posts", "trip_id", "trips", "id", "CASCADE");
  assertForeignKey(sqlite, "forecast_impressions", "trip_id", "trips", "id", "CASCADE");
  assertForeignKey(sqlite, "trip_validation_provenance", "trip_id", "trips", "id", "CASCADE");
  assertForeignKey(sqlite, "validation_feasibility_events", "trip_id", "trips", "id", "CASCADE");
  assertForeignKey(sqlite, "validation_feasibility_corrections", "trip_id", "trips", "id", "CASCADE");
  assertForeignKey(sqlite, "validation_feasibility_recruitment_events", "user_id", "users", "id", "CASCADE");
  assertForeignKey(sqlite, "privacy_deletion_tasks", "job_id", "privacy_deletion_jobs", "id", "CASCADE");

  const triggerNames = new Set(sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
  ).all("trigger").map((row) => row.name));
  for (const trigger of [
    "validation_feasibility_event_delete_guard",
    "validation_feasibility_event_privacy_removal_audit",
    "validation_feasibility_recruitment_delete_guard",
    "validation_feasibility_recruitment_removal_audit",
    "validation_feasibility_correction_delete_guard",
    "validation_feasibility_correction_removal_audit",
    "validation_feasibility_event_snapshot_suppression_capture",
    "validation_feasibility_recruitment_snapshot_suppression_capture",
    "validation_feasibility_snapshot_suppression_delete_guard",
  ]) {
    assert.ok(triggerNames.has(trigger), `missing privacy deletion trigger ${trigger}`);
  }
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("account deletion keeps tombstone creation and every active-row removal in one ordered batch", async () => {
  const source = await readFile(new URL("../worker/auth.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (url.pathname === "/api/profile" && request.method === "DELETE")');
  const end = source.indexOf("if (!user.legalAccepted)", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /await db\.batch\(\[/);
  assert.match(block, /deletion\.jobStatement\(db\)/);
  assert.match(block, /\.\.\.deletion\.taskStatements\(db\)/);

  const orderedDeletes = [
    "DELETE FROM site_discussion_posts",
    "DELETE FROM trips WHERE user_id = ?",
    "DELETE FROM saved_sites WHERE user_id = ?",
    "DELETE FROM gear_profiles WHERE user_id = ?",
    "DELETE FROM auth_sessions WHERE user_id = ?",
    "DELETE FROM email_challenges WHERE email = ? OR user_id = ?",
    "DELETE FROM auth_attempts WHERE email_hash = ?",
    "DELETE FROM users WHERE id = ?",
  ];
  let cursor = block.indexOf("deletion.jobStatement(db)");
  for (const statement of orderedDeletes) {
    const position = block.indexOf(statement, cursor + 1);
    assert.ok(position > cursor, `${statement} must remain in the ordered deletion batch`);
    cursor = position;
  }
});

test("the lifecycle register covers every schema table and does not mislabel the receipt as recovery", async () => {
  const sqlite = await migratedDatabase();
  const document = await readFile(
    new URL("../docs/DATA-LIFECYCLE-AND-RIGHTS.md", import.meta.url),
    "utf8",
  );
  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND substr(name, 1, 7) != ? ORDER BY name",
  ).all("table", "sqlite_").map((row) => row.name);
  for (const table of tables) assert.match(document, new RegExp(`\\b${table}\\b`), `undocumented table ${table}`);

  assert.match(document, /does \*\*not\*\* currently\s+keep a recoverable account copy/i);
  assert.match(document, /30-day deletion receipt is an aggregate cleanup-status credential/i);
  assert.match(document, /28 calendar days/);
  assert.match(document, /10-business-day receipt confirmation/);
  assert.match(document, /45-calendar-day substantive response/);
  assert.match(document, /https:\/\/eur-lex\.europa\.eu\/eli\/reg\/2016\/679\/oj/);

  const terms = await readFile(new URL("../app/terms/page.tsx", import.meta.url), "utf8");
  assert.match(terms, /accepted deletion request immediately removes account access/i);
});
