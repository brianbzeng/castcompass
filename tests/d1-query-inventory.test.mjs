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
    prepareCallCount: 187,
    literalCallCount: 162,
    nonLiteralCallCount: 25,
    multiRowLiteralWithoutLimitCount: 11,
  });
  assert.equal(inventory.sourceFiles.length, 7);
  assert.equal(new Set(inventory.queries.map(({ callSiteId }) => callSiteId)).size, 187);
  assert.equal(policy.multiRowReadContracts.filter(({ rowBoundStatus }) => rowBoundStatus === "open-account-cardinality").length, 0);
  assert.equal(policy.multiRowReadContracts.filter(({ rowBoundStatus }) => rowBoundStatus === "complete-rights-export").length, 9);
  assert.equal(policy.multiRowReadContracts.filter(({ rowBoundStatus }) => rowBoundStatus === "owner-lifecycle-cleanup").length, 2);

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
