import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ALL_RELEASE_MIGRATIONS,
  BASE_APPLIED_MIGRATIONS,
  RECONCILED_LEGAL_MIGRATION,
  STAGED_MIGRATIONS,
  authorizeProductionMutation,
  createStagedWranglerConfig,
  expectedMigrationsBefore,
  verifyFinalPostflight,
  verifyInitialPreflight,
  verifyLedgerPayload,
  verifyLocalMigrationSet,
  productionMutationAction,
  verifyReconciliationResult,
  verifyStageBoundaryPayload,
} from "../scripts/integrated-release.mjs";

const migrationDirectory = new URL("../drizzle/", import.meta.url);
const HEAD = "0123456789abcdef0123456789abcdef01234567";

async function applyMigration(sqlite, name) {
  const source = await readFile(new URL(name, migrationDirectory), "utf8");
  sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
}

function createLedger(sqlite) {
  sqlite.exec(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
}

function recordMigration(sqlite, name) {
  sqlite.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
}

function readEnvelope(row) {
  return [{
    results: [row],
    success: true,
    meta: { served_by_primary: true, changed_db: false, changes: 0, rows_written: 0 },
  }];
}

function mutationEnvelope(rows) {
  return [{
    results: rows,
    success: true,
    meta: { served_by_primary: true, changed_db: true, changes: 1, rows_written: 1 },
  }];
}

async function legalSchemaWithUnrecordedMigration() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  createLedger(sqlite);
  for (const name of [...BASE_APPLIED_MIGRATIONS, RECONCILED_LEGAL_MIGRATION]) {
    await applyMigration(sqlite, name);
    if (name !== RECONCILED_LEGAL_MIGRATION) recordMigration(sqlite, name);
  }
  return sqlite;
}

test("integrated preflight recognizes only the observed 0007 schema-ledger drift", async () => {
  const sqlite = await legalSchemaWithUnrecordedMigration();
  const source = await readFile(new URL("../scripts/integrated-release-preflight.sql", import.meta.url), "utf8");
  const row = sqlite.prepare(source).get();
  const result = verifyInitialPreflight(readEnvelope(row));
  assert.deepEqual(result.appliedMigrations, BASE_APPLIED_MIGRATIONS);
  assert.deepEqual(result.aggregates, {
    users: 0,
    usersMissingAgeEligibility: 0,
    usersMissingLegalAcceptance: 0,
    trips: 0,
    discussionRows: 0,
    tripPhotoLocators: 0,
  });

  sqlite.exec("ALTER TABLE site_discussion_posts ADD COLUMN approved_at TEXT");
  const drifted = sqlite.prepare(source).get();
  assert.throws(() => verifyInitialPreflight(readEnvelope(drifted)), /approval_columns_found/);

  const idempotencyDrift = await legalSchemaWithUnrecordedMigration();
  idempotencyDrift.exec("ALTER TABLE trips ADD COLUMN idempotency_key_hash TEXT");
  assert.throws(
    () => verifyInitialPreflight(readEnvelope(idempotencyDrift.prepare(source).get())),
    /later_trip_columns_found/,
  );

  const indexDrift = await legalSchemaWithUnrecordedMigration();
  indexDrift.exec("CREATE INDEX auth_sessions_expires_idx ON auth_sessions(expires_at)");
  assert.throws(
    () => verifyInitialPreflight(readEnvelope(indexDrift.prepare(source).get())),
    /later_indexes_found/,
  );
});

test("0007 reconciliation is one guarded ledger insert and refuses replay", async () => {
  const sqlite = await legalSchemaWithUnrecordedMigration();
  const reconciliation = await readFile(
    new URL("../scripts/reconcile-0007-legal-migration.sql", import.meta.url),
    "utf8",
  );
  const first = sqlite.prepare(reconciliation).all();
  assert.deepEqual(first.map((row) => ({ ...row })), [{ reconciled_migration: RECONCILED_LEGAL_MIGRATION }]);
  assert.deepEqual(verifyReconciliationResult(mutationEnvelope(first)), {
    reconciledMigration: RECONCILED_LEGAL_MIGRATION,
  });
  assert.deepEqual(
    sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => row.name),
    [...BASE_APPLIED_MIGRATIONS, RECONCILED_LEGAL_MIGRATION],
  );
  assert.deepEqual(sqlite.prepare(reconciliation).all(), []);
});

test("final postflight proves the complete additive schema and empty default-off ledgers", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  createLedger(sqlite);
  for (const name of ALL_RELEASE_MIGRATIONS) {
    await applyMigration(sqlite, name);
    recordMigration(sqlite, name);
  }
  const source = await readFile(new URL("../scripts/integrated-release-postflight.sql", import.meta.url), "utf8");
  const result = verifyFinalPostflight(readEnvelope(sqlite.prepare(source).get()));
  assert.deepEqual(result.appliedMigrations, ALL_RELEASE_MIGRATIONS);
  assert.equal(result.aggregates.trips, 0);
});

test("ledger verifier binds read-only primary results to an exact ordered prefix", () => {
  const row = {
    applied_migrations_json: JSON.stringify(BASE_APPLIED_MIGRATIONS),
    foreign_key_violations: 0,
  };
  assert.deepEqual(verifyLedgerPayload(readEnvelope(row), BASE_APPLIED_MIGRATIONS), {
    appliedMigrations: BASE_APPLIED_MIGRATIONS,
  });
  assert.throws(
    () => verifyLedgerPayload(readEnvelope(row), [...BASE_APPLIED_MIGRATIONS, RECONCILED_LEGAL_MIGRATION]),
    /remote migration ledger/,
  );
  const nonPrimary = readEnvelope(row);
  nonPrimary[0].meta.served_by_primary = false;
  assert.throws(() => verifyLedgerPayload(nonPrimary, BASE_APPLIED_MIGRATIONS), /primary D1 execution/);
});

test("stage-boundary verifier rejects any pre-existing target artifact", () => {
  assert.deepEqual(verifyStageBoundaryPayload(readEnvelope({ target_artifacts_found: 0 })), {
    targetArtifactsFound: 0,
  });
  assert.throws(
    () => verifyStageBoundaryPayload(readEnvelope({ target_artifacts_found: 1 })),
    /target_artifacts_found/,
  );
});

test("staged migration configuration can expose only the exact next reviewed file", () => {
  assert.deepEqual(expectedMigrationsBefore(STAGED_MIGRATIONS[0]), [
    ...BASE_APPLIED_MIGRATIONS,
    RECONCILED_LEGAL_MIGRATION,
  ]);
  assert.deepEqual(expectedMigrationsBefore(STAGED_MIGRATIONS.at(-1)), ALL_RELEASE_MIGRATIONS.slice(0, -1));
  assert.throws(() => expectedMigrationsBefore(RECONCILED_LEGAL_MIGRATION), /one exact staged filename/);

  const config = createStagedWranglerConfig({
    compatibility_date: "2026-05-15",
    d1_databases: [{
      binding: "DB",
      database_name: "contourcast-trips",
      database_id: "database-id",
      migrations_dir: "drizzle",
    }],
  }, STAGED_MIGRATIONS[2]);
  assert.equal(config.d1_databases[0].migrations_pattern, `drizzle/${STAGED_MIGRATIONS[2]}`);
  assert.equal(config.d1_databases.length, 1);
});

test("release migration allowlist matches every checked-in migration file", async () => {
  const diskFiles = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.deepEqual(diskFiles, ALL_RELEASE_MIGRATIONS);
  assert.deepEqual(await verifyLocalMigrationSet(), ALL_RELEASE_MIGRATIONS);
});

test("the operator runbook enumerates the exact guarded migration sequence", async () => {
  const [runbook, operations] = await Promise.all([
    readFile(new URL("../docs/INTEGRATED-RELEASE.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/PRODUCTION-OPERATIONS.md", import.meta.url), "utf8"),
  ]);
  const documentedMigrations = [...runbook.matchAll(/export RELEASE_MIGRATION=(\d{4}_[A-Za-z0-9_]+\.sql)/g)]
    .map((match) => match[1]);
  assert.deepEqual(documentedMigrations, STAGED_MIGRATIONS);
  assert.match(runbook, /`0009` through `0019`/);
  assert.match(runbook, /exact nullable\s+text trip-idempotency column/);
  assert.match(operations, /Migration `0017_trip_idempotency\.sql` completed before normal traffic resumed/);
  assert.match(operations, /Migration `0018_ai_review_queue\.sql` completed before any Queue binding/);
  assert.match(operations, /Migration `0019_async_privacy_exports\.sql` completed before any privacy-export Queue or\s+private R2 binding/);
});

test("every D1 mutation maps to one exact private authorization action before Wrangler", async () => {
  assert.equal(productionMutationAction({ command: "preflight" }), null);
  assert.equal(productionMutationAction({ command: "postflight" }), null);
  assert.equal(productionMutationAction({ command: "reconcile-0007" }), "migrate:reconcile-0007");
  for (const migration of STAGED_MIGRATIONS) {
    assert.equal(
      productionMutationAction({ command: "apply", migration }),
      `migrate:${migration}`,
    );
  }
  assert.throws(
    () => productionMutationAction({ command: "apply", migration: "9999_unreviewed.sql" }),
    /one exact staged filename/,
  );

  let calls = 0;
  const result = await authorizeProductionMutation(
    "/reviewed/root",
    {
      command: "apply",
      migration: STAGED_MIGRATIONS[0],
      confirmPrimary: "contourcast-trips",
      confirmBookmarkRecorded: true,
    },
    async (options) => {
      calls += 1;
      assert.deepEqual(options, {
        root: "/reviewed/root",
        expectedCommit: HEAD,
        authorizationFile: "/private/authorization.json",
        action: `migrate:${STAGED_MIGRATIONS[0]}`,
      });
      return { authorized: true };
    },
    {
      RELEASE_COMMIT: HEAD,
      RELEASE_AUTHORIZATION_FILE: "/private/authorization.json",
    },
  );
  assert.deepEqual(result, { authorized: true });
  assert.equal(calls, 1);
  await assert.rejects(
    authorizeProductionMutation(
      "/reviewed/root",
      { command: "reconcile-0007", confirmPrimary: "wrong", confirmBookmarkRecorded: true },
      async () => { throw new Error("must not be called"); },
      {},
    ),
    /--confirm-primary/,
  );
});
