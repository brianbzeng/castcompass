import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyReleaseCheckout } from "./verify-release-checkout.mjs";
import { verifyProductionChangeAuthorization } from "./verify-production-change-authorization.mjs";

const execFile = promisify(execFileCallback);
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_DATABASE = "contourcast-trips";

export const BASE_APPLIED_MIGRATIONS = Object.freeze([
  "0000_unique_tusk.sql",
  "0001_accounts_and_saved_sites.sql",
  "0002_profile_trip_ownership.sql",
  "0003_email_verification_and_recovery.sql",
  "0004_advisory_trip_review.sql",
  "0005_fishability_and_gear.sql",
  "0006_moderated_location_discussions.sql",
]);
export const RECONCILED_LEGAL_MIGRATION = "0007_legal_acceptance.sql";
export const STAGED_MIGRATIONS = Object.freeze([
  "0009_human_discussion_approval.sql",
  "0010_privacy_durability.sql",
  "0011_species_aware_observations.sql",
  "0012_validation_protocol.sql",
  "0013_validation_feasibility_pilot.sql",
  "0014_validation_feasibility_recruitment_and_corrections.sql",
  "0015_validation_snapshot_suppression.sql",
  "0016_data_resilience_indexes.sql",
  "0017_trip_idempotency.sql",
  "0018_ai_review_queue.sql",
  "0019_async_privacy_exports.sql",
]);
export const ALL_RELEASE_MIGRATIONS = Object.freeze([
  ...BASE_APPLIED_MIGRATIONS,
  RECONCILED_LEGAL_MIGRATION,
  ...STAGED_MIGRATIONS,
]);

const LEDGER_QUERY = `SELECT COALESCE((
  SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY id)
), '[]') AS applied_migrations_json,
(SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_violations`;

const STAGE_ABSENCE_QUERIES = Object.freeze({
  "0009_human_discussion_approval.sql": `
    SELECT COUNT(*) AS target_artifacts_found
    FROM pragma_table_info('site_discussion_posts')
    WHERE name IN ('approved_at', 'approved_by', 'source_ai_reviewed_at')`,
  "0010_privacy_durability.sql": `
    SELECT COUNT(*) AS target_artifacts_found FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'signup_age_proofs', 'privacy_deletion_jobs', 'privacy_deletion_tasks'
    )`,
  "0011_species_aware_observations.sql": `
    SELECT
      (SELECT COUNT(*) FROM pragma_table_info('trips') WHERE name IN (
        'observation_contract_version', 'taxon_catalog_version', 'target_taxon_id',
        'contract_status', 'taxon_observations_json', 'outcome_class',
        'target_encounter_count', 'any_fish_encounter_count',
        'target_identification_confidence'
      )) + (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (
        'trips_completed_contract_insert_guard', 'trips_completed_contract_update_guard'
      )) AS target_artifacts_found`,
  "0012_validation_protocol.sql": `
    SELECT COUNT(*) AS target_artifacts_found FROM sqlite_master
    WHERE type = 'table' AND name IN ('forecast_impressions', 'trip_validation_provenance')`,
  "0013_validation_feasibility_pilot.sql": `
    SELECT COUNT(*) AS target_artifacts_found FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'validation_feasibility_activations', 'validation_feasibility_events',
      'validation_feasibility_privacy_removals'
    )`,
  "0014_validation_feasibility_recruitment_and_corrections.sql": `
    SELECT COUNT(*) AS target_artifacts_found FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'validation_feasibility_recruitment_campaigns',
      'validation_feasibility_recruitment_events',
      'validation_feasibility_recruitment_removals',
      'validation_feasibility_corrections',
      'validation_feasibility_correction_removals'
    )`,
  "0015_validation_snapshot_suppression.sql": `
    SELECT
      (SELECT COUNT(*) FROM pragma_table_info('validation_feasibility_events')
        WHERE name = 'snapshot_suppression_sha256')
      + (SELECT COUNT(*) FROM pragma_table_info('validation_feasibility_recruitment_events')
        WHERE name = 'snapshot_suppression_sha256')
      + (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
        AND name = 'validation_feasibility_snapshot_suppressions')
      AS target_artifacts_found`,
  "0016_data_resilience_indexes.sql": `
    SELECT COUNT(*) AS target_artifacts_found FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'auth_sessions_expires_idx',
      'saved_sites_user_created_idx',
      'auth_attempts_attempted_idx',
      'email_challenges_expires_idx',
      'email_challenges_user_idx',
      'signup_age_proofs_consumed_idx',
      'privacy_deletion_jobs_scope_subject_idx',
      'privacy_deletion_jobs_state_completed_idx',
      'trips_user_history_idx',
      'trips_user_created_idx',
      'trips_ai_review_backlog_idx',
      'trips_reporter_active_created_idx',
      'trip_validation_provenance_forecast_trip_idx',
      'validation_feasibility_recruitment_user_sequence_idx',
      'validation_feasibility_correction_activation_sequence_idx'
    )`,
  "0017_trip_idempotency.sql": `
    SELECT COUNT(*) AS target_artifacts_found
    FROM pragma_table_info('trips')
    WHERE name = 'idempotency_key_hash'`,
  "0018_ai_review_queue.sql": `
    SELECT
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'ai_review_jobs')
      + (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'ai_review_jobs_trip_unique', 'ai_review_jobs_dispatch_idx'
        )) AS target_artifacts_found`,
  "0019_async_privacy_exports.sql": `
    SELECT
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'privacy_export_jobs')
      + (SELECT COUNT(*) FROM pragma_table_info('privacy_deletion_tasks')
        WHERE name = 'object_store')
      + (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'privacy_export_jobs_active_user_unique',
          'privacy_export_jobs_object_key_unique',
          'privacy_export_jobs_dispatch_idx',
          'privacy_export_jobs_expiry_idx',
          'privacy_export_jobs_owner_idx',
          'privacy_deletion_tasks_store_retry_idx'
        )) AS target_artifacts_found`,
});

function fail(label, expected, actual) {
  throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) fail(label, expected, actual);
}

function requireNonnegativeInteger(label, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label}: expected a nonnegative integer, received ${JSON.stringify(value)}`);
  }
}

function parseMigrationArray(value, label = "applied_migrations_json") {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label}: expected a JSON migration array`);
  }
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new Error(`${label}: expected a string migration array`);
  }
  return parsed;
}

function requireMigrationArray(label, actual, expected) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(label, expected, actual);
  }
}

function resultEnvelope(payload) {
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error(`Wrangler result must contain exactly one statement result; received ${payload?.length ?? "invalid"}.`);
  }
  const entry = payload[0];
  requireEqual("Wrangler success", entry?.success, true);
  requireEqual("primary D1 execution", entry?.meta?.served_by_primary, true);
  requireEqual("changed_db", entry?.meta?.changed_db, false);
  requireEqual("rows_written", entry?.meta?.rows_written, 0);
  requireEqual("changes", entry?.meta?.changes, 0);
  if (!Array.isArray(entry.results)) throw new Error("Wrangler result is missing its results array.");
  return entry;
}

export function verifyInitialPreflight(payload, expectedMigrations = BASE_APPLIED_MIGRATIONS) {
  const entry = resultEnvelope(payload);
  requireEqual("preflight row count", entry.results.length, 1);
  const row = entry.results[0];
  const appliedMigrations = parseMigrationArray(row.applied_migrations_json);
  requireMigrationArray("remote migration ledger", appliedMigrations, expectedMigrations);
  for (const [field, expected] of Object.entries({
    legal_columns_expected: 8,
    legal_columns_present: 8,
    legal_columns_exact: 8,
    approval_columns_found: 0,
    later_tables_found: 0,
    later_trip_columns_found: 0,
    later_indexes_found: 0,
    later_triggers_found: 0,
    trip_photo_locators: 0,
    foreign_key_violations: 0,
  })) requireEqual(field, row[field], expected);
  for (const field of [
    "users",
    "users_missing_age_eligibility",
    "users_missing_legal_acceptance",
    "trips",
    "discussion_rows",
  ]) requireNonnegativeInteger(field, row[field]);
  if (row.users_missing_age_eligibility > row.users) throw new Error("Age-eligibility aggregate exceeds the user count.");
  if (row.users_missing_legal_acceptance > row.users) throw new Error("Legal-acceptance aggregate exceeds the user count.");
  return {
    appliedMigrations,
    aggregates: {
      users: row.users,
      usersMissingAgeEligibility: row.users_missing_age_eligibility,
      usersMissingLegalAcceptance: row.users_missing_legal_acceptance,
      trips: row.trips,
      discussionRows: row.discussion_rows,
      tripPhotoLocators: row.trip_photo_locators,
    },
  };
}

export function verifyReconciliationResult(payload) {
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error("Reconciliation must return exactly one Wrangler result.");
  }
  const entry = payload[0];
  requireEqual("Wrangler success", entry?.success, true);
  requireEqual("primary D1 execution", entry?.meta?.served_by_primary, true);
  requireEqual("changed_db", entry?.meta?.changed_db, true);
  requireEqual("rows_written", entry?.meta?.rows_written, 1);
  requireEqual("changes", entry?.meta?.changes, 1);
  requireEqual("reconciliation row count", entry?.results?.length, 1);
  requireEqual("reconciled migration", entry.results[0]?.reconciled_migration, RECONCILED_LEGAL_MIGRATION);
  return { reconciledMigration: RECONCILED_LEGAL_MIGRATION };
}

export function verifyLedgerPayload(payload, expectedMigrations) {
  const entry = resultEnvelope(payload);
  requireEqual("ledger row count", entry.results.length, 1);
  const row = entry.results[0];
  const appliedMigrations = parseMigrationArray(row.applied_migrations_json);
  requireMigrationArray("remote migration ledger", appliedMigrations, expectedMigrations);
  requireEqual("foreign_key_violations", row.foreign_key_violations, 0);
  return { appliedMigrations };
}

export function verifyStageBoundaryPayload(payload) {
  const entry = resultEnvelope(payload);
  requireEqual("stage-boundary row count", entry.results.length, 1);
  requireEqual("target_artifacts_found", entry.results[0]?.target_artifacts_found, 0);
  return { targetArtifactsFound: 0 };
}

export function verifyFinalPostflight(payload) {
  const entry = resultEnvelope(payload);
  requireEqual("postflight row count", entry.results.length, 1);
  const row = entry.results[0];
  const appliedMigrations = parseMigrationArray(row.applied_migrations_json);
  requireMigrationArray("remote migration ledger", appliedMigrations, ALL_RELEASE_MIGRATIONS);
  for (const [field, expected] of Object.entries({
    exact_approval_columns: 3,
    privacy_tables: 4,
    privacy_deletion_store_columns: 1,
    species_columns: 9,
    species_completion_triggers: 2,
    validation_tables: 11,
    snapshot_suppression_columns: 2,
    data_resilience_indexes: 15,
    exact_trip_idempotency_columns: 1,
    ai_review_queue_tables: 1,
    ai_review_queue_indexes: 2,
    ai_review_queue_rows: 0,
    privacy_export_queue_tables: 1,
    privacy_export_queue_indexes: 5,
    privacy_export_queue_rows: 0,
    non_legacy_trip_rows: 0,
    trip_photo_locators: 0,
    discussion_rows_with_approval_metadata: 0,
    validation_activation_rows: 0,
    validation_event_rows: 0,
    validation_recruitment_rows: 0,
    foreign_key_violations: 0,
  })) requireEqual(field, row[field], expected);
  for (const field of [
    "users",
    "users_missing_age_eligibility",
    "users_missing_legal_acceptance",
    "trips",
    "discussion_rows",
  ]) requireNonnegativeInteger(field, row[field]);
  return {
    appliedMigrations,
    aggregates: {
      users: row.users,
      usersMissingAgeEligibility: row.users_missing_age_eligibility,
      usersMissingLegalAcceptance: row.users_missing_legal_acceptance,
      trips: row.trips,
      discussionRows: row.discussion_rows,
    },
  };
}

export function expectedMigrationsBefore(targetMigration) {
  const index = STAGED_MIGRATIONS.indexOf(targetMigration);
  if (index < 0) {
    throw new Error(`--migration must be one exact staged filename: ${STAGED_MIGRATIONS.join(", ")}`);
  }
  return [...BASE_APPLIED_MIGRATIONS, RECONCILED_LEGAL_MIGRATION, ...STAGED_MIGRATIONS.slice(0, index)];
}

export function createStagedWranglerConfig(baseConfig, targetMigration) {
  expectedMigrationsBefore(targetMigration);
  const databases = baseConfig?.d1_databases;
  const database = Array.isArray(databases)
    ? databases.find((candidate) => candidate.database_name === PRIMARY_DATABASE)
    : null;
  if (!database?.database_id || database.binding !== "DB") {
    throw new Error(`wrangler.jsonc must bind the primary ${PRIMARY_DATABASE} database as DB.`);
  }
  return {
    name: "contourcast-staged-migration",
    compatibility_date: baseConfig.compatibility_date,
    d1_databases: [{
      binding: database.binding,
      database_name: database.database_name,
      database_id: database.database_id,
      migrations_dir: "drizzle",
      migrations_pattern: `drizzle/${targetMigration}`,
    }],
  };
}

export async function verifyLocalMigrationSet(root = DEFAULT_ROOT) {
  const files = (await readdir(resolve(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  requireMigrationArray("local migration set", files, ALL_RELEASE_MIGRATIONS);
  return files;
}

function evidenceDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return parseable JSON.`);
  }
}

async function defaultWranglerRunner(root, args, { inherit = false } = {}) {
  const binary = resolve(root, "node_modules/.bin/wrangler");
  if (inherit) {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawnCallback(binary, args, { cwd: root, stdio: "inherit" });
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`Wrangler exited with ${signal ? `signal ${signal}` : `status ${code}`}.`));
      });
    });
    return "";
  }
  const { stdout } = await execFile(binary, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function executeReadOnlySqlFile(root, runner, file, config = "wrangler.jsonc") {
  const source = await readFile(resolve(root, file), "utf8");
  const output = await runner(root, [
    "d1", "execute", PRIMARY_DATABASE, "--remote", "--config", config,
    "--command", source, "--json",
  ]);
  return parseJsonOutput(output, file);
}

async function executeMutationFile(root, runner, file, config = "wrangler.jsonc") {
  const source = await readFile(resolve(root, file), "utf8");
  const output = await runner(root, [
    "d1", "execute", PRIMARY_DATABASE, "--remote", "--config", config,
    "--command", source, "--json",
  ]);
  return parseJsonOutput(output, file);
}

async function queryLedger(root, runner) {
  const output = await runner(root, [
    "d1", "execute", PRIMARY_DATABASE, "--remote", "--config", "wrangler.jsonc",
    "--command", LEDGER_QUERY, "--json",
  ]);
  return parseJsonOutput(output, "migration ledger query");
}

async function queryStageBoundary(root, runner, migration) {
  const query = STAGE_ABSENCE_QUERIES[migration];
  if (!query) throw new Error(`No schema-boundary query exists for ${migration}.`);
  const output = await runner(root, [
    "d1", "execute", PRIMARY_DATABASE, "--remote", "--config", "wrangler.jsonc",
    "--command", query, "--json",
  ]);
  return parseJsonOutput(output, `${migration} schema-boundary query`);
}

function assertMutationConfirmation(options) {
  requireEqual("--confirm-primary", options.confirmPrimary, PRIMARY_DATABASE);
  if (!options.confirmBookmarkRecorded) {
    throw new Error("Production mutation requires --confirm-bookmark-recorded after the Time Travel bookmark is stored privately.");
  }
}

export function productionMutationAction(options) {
  if (options.command === "reconcile-0007") return "migrate:reconcile-0007";
  if (options.command === "apply") {
    expectedMigrationsBefore(options.migration);
    return `migrate:${options.migration}`;
  }
  return null;
}

export async function authorizeProductionMutation(
  root,
  options,
  authorizationVerifier = verifyProductionChangeAuthorization,
  environment = process.env,
) {
  const action = productionMutationAction(options);
  if (!action) return null;
  assertMutationConfirmation(options);
  return authorizationVerifier({
    root,
    expectedCommit: environment.RELEASE_COMMIT,
    authorizationFile: environment.RELEASE_AUTHORIZATION_FILE,
    action,
  });
}

async function verifyImmutableCheckout(root) {
  await verifyReleaseCheckout({ root, expectedCommit: process.env.RELEASE_COMMIT });
  await verifyLocalMigrationSet(root);
}

async function runPreflight(root, runner, expectedMigrations = BASE_APPLIED_MIGRATIONS) {
  const payload = await executeReadOnlySqlFile(root, runner, "scripts/integrated-release-preflight.sql");
  const result = verifyInitialPreflight(payload, expectedMigrations);
  return { ...result, evidenceSha256: evidenceDigest(result) };
}

async function withStagedConfig(root, targetMigration, callback) {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "castingcompass-migration-"));
  try {
    const baseConfig = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
    const config = createStagedWranglerConfig(baseConfig, targetMigration);
    const migrationDirectory = await realpath(resolve(root, "drizzle"));
    await symlink(migrationDirectory, resolve(temporaryRoot, "drizzle"), "dir");
    const configPath = resolve(temporaryRoot, "wrangler.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return await callback(configPath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function applyOneMigration(
  root,
  runner,
  options,
  reauthorize = authorizeProductionMutation,
) {
  assertMutationConfirmation(options);
  const expectedBefore = expectedMigrationsBefore(options.migration);
  verifyLedgerPayload(await queryLedger(root, runner), expectedBefore);
  verifyStageBoundaryPayload(await queryStageBoundary(root, runner, options.migration));
  await withStagedConfig(root, options.migration, async (configPath) => {
    const listOutput = await runner(root, [
      "d1", "migrations", "list", PRIMARY_DATABASE, "--remote", "--config", configPath,
    ]);
    const mentionedMigrations = [...new Set(listOutput.match(/\d{4}_[A-Za-z0-9_.-]+\.sql/g) ?? [])];
    requireMigrationArray("staged Wrangler pending set", mentionedMigrations, [options.migration]);
    await reauthorize(root, options);
    await runner(root, [
      "d1", "migrations", "apply", PRIMARY_DATABASE, "--remote", "--config", configPath,
    ], { inherit: true });
  });
  const expectedAfter = [...expectedBefore, options.migration];
  const result = verifyLedgerPayload(await queryLedger(root, runner), expectedAfter);
  return { ...result, appliedMigration: options.migration, evidenceSha256: evidenceDigest(result) };
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const options = { command, migration: undefined, confirmPrimary: undefined, confirmBookmarkRecorded: false };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--migration") {
      options.migration = rest[index + 1];
      if (!options.migration) throw new Error("--migration requires an exact filename.");
      index += 1;
    } else if (value === "--confirm-primary") {
      options.confirmPrimary = rest[index + 1];
      if (!options.confirmPrimary) throw new Error("--confirm-primary requires the production database name.");
      index += 1;
    } else if (value === "--confirm-bookmark-recorded") {
      options.confirmBookmarkRecorded = true;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

async function main({ root = DEFAULT_ROOT, runner = defaultWranglerRunner } = {}) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.command) {
    process.stdout.write(
      "Usage:\n" +
      "  node scripts/integrated-release.mjs preflight\n" +
      "  RELEASE_AUTHORIZATION_FILE=/PRIVATE/PATH.json node scripts/integrated-release.mjs reconcile-0007 --confirm-primary contourcast-trips --confirm-bookmark-recorded\n" +
      "  RELEASE_AUTHORIZATION_FILE=/PRIVATE/PATH.json node scripts/integrated-release.mjs apply --migration FILE --confirm-primary contourcast-trips --confirm-bookmark-recorded\n" +
      "  node scripts/integrated-release.mjs postflight\n",
    );
    return;
  }
  await verifyImmutableCheckout(root);
  await authorizeProductionMutation(root, options);
  let result;
  if (options.command === "preflight") {
    result = await runPreflight(root, runner);
  } else if (options.command === "reconcile-0007") {
    assertMutationConfirmation(options);
    const before = await runPreflight(root, runner);
    await authorizeProductionMutation(root, options);
    const payload = await executeMutationFile(root, runner, "scripts/reconcile-0007-legal-migration.sql");
    verifyReconciliationResult(payload);
    const after = await runPreflight(root, runner, [...BASE_APPLIED_MIGRATIONS, RECONCILED_LEGAL_MIGRATION]);
    result = { reconciledMigration: RECONCILED_LEGAL_MIGRATION, before, after };
  } else if (options.command === "apply") {
    result = await applyOneMigration(root, runner, options);
  } else if (options.command === "postflight") {
    const payload = await executeReadOnlySqlFile(root, runner, "scripts/integrated-release-postflight.sql");
    const verified = verifyFinalPostflight(payload);
    result = { ...verified, evidenceSha256: evidenceDigest(verified) };
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
