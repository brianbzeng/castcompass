import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  LOCKED_REVIEW_TARGET_SHA256,
  LOCKED_SOURCE_COMMIT,
  REVIEW_CHECKS,
  REVIEW_ROLES,
  REVIEW_TARGET_INPUTS,
  SITE_REVIEW_CHECKS,
  evaluateReviewFiles,
  loadReviewTarget,
  stableJson,
  validateReviewRecord,
  verifyPolicy,
  writeReviewTemplate,
} from "../scripts/verify-water-quality-mapping-independent-review.mjs";

const root = new URL("../", import.meta.url).pathname;
const target = await loadReviewTarget(root);

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

function review(role, label, overrides = {}) {
  const base = {
    schema_version: "castingcompass.water-quality-mapping-independent-review/1.0.0",
    review_id: randomUUID(),
    source_commit: LOCKED_SOURCE_COMMIT,
    review_target_sha256: LOCKED_REVIEW_TARGET_SHA256,
    water_quality_policy_version: "castingcompass.water-quality-advisory/official-programs-0.5.0",
    reviewed_at: "2026-07-21T19:00:00.000Z",
    reviewer_role: role,
    reviewer_independent_of_implementation: true,
    reviewer_competence_evidence_sha256: digest(`${label}-competence`),
    review_evidence_sha256: digest(`${label}-review`),
    disposition: "accepted_inventory",
    blocking_finding_count: 0,
    inventory_checklist: Object.fromEntries(REVIEW_CHECKS.map((check) => [check, true])),
    site_reviews: target.sites.map((site) => ({
      ...site,
      ...Object.fromEntries(SITE_REVIEW_CHECKS.map((check) => [check, true])),
    })),
  };
  return { ...base, ...overrides };
}

async function privatePair(t, mapping, publicHealth) {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-mapping-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mappingPath = join(directory, "mapping.json");
  const publicHealthPath = join(directory, "public-health.json");
  await writeFile(mappingPath, stableJson(mapping), { mode: 0o600 });
  await writeFile(publicHealthPath, stableJson(publicHealth), { mode: 0o600 });
  return { directory, mappingPath, publicHealthPath };
}

test("locked target is exhaustive, mutually exclusive, and non-authorizing", async () => {
  assert.equal(target.targetSha256, LOCKED_REVIEW_TARGET_SHA256);
  assert.equal(target.sites.length, 61);
  assert.equal(target.sites.filter(({ target_outcome: outcome }) => outcome === "mapped").length, 39);
  assert.equal(target.sites.filter(({ target_outcome: outcome }) => outcome === "not_covered").length, 22);
  assert.equal(new Set(target.sites.map(({ site_id: siteId }) => siteId)).size, 61);
  assert.deepEqual([...target.sites].sort((left, right) => left.site_id.localeCompare(right.site_id)), target.sites);
  for (const site of target.sites) {
    if (site.target_outcome === "mapped") {
      assert.equal(typeof site.source_id, "string");
      assert.ok(site.station_ids.length + site.inherited_global_station_ids.length > 0);
    } else {
      assert.equal(site.source_id, null);
      assert.deepEqual(site.station_ids, []);
      assert.deepEqual(site.inherited_global_station_ids, []);
    }
  }
  const receipt = await verifyPolicy(root);
  assert.equal(receipt.catalog_site_count, 61);
  assert.equal(receipt.mapped_site_count, 39);
  assert.equal(receipt.not_covered_site_count, 22);
  assert.equal(receipt.mapping_change_authorized, false);
  assert.equal(receipt.runtime_activation_authorized, false);
  assert.equal(receipt.numeric_score_authorized, false);
  assert.equal(receipt.merge_authorized, false);
  assert.equal(receipt.deployment_authorized, false);
  assert.equal(receipt.production_authorized, false);
});

test("role templates contain every locked site and default to changes required", () => {
  for (const [script, role] of [
    ["template:water-quality-mapping-review", REVIEW_ROLES[0]],
    ["template:water-quality-public-health-review", REVIEW_ROLES[1]],
  ]) {
    const result = spawnSync("npm", ["run", "--silent", script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.reviewer_role, role);
    assert.equal(payload.disposition, "changes_required");
    assert.equal(payload.blocking_finding_count, 1);
    assert.equal(payload.site_reviews.length, 61);
    assert.ok(Object.values(payload.inventory_checklist).every((value) => value === false));
    assert.ok(payload.site_reviews.every((site) => SITE_REVIEW_CHECKS.every((check) => site[check] === false)));
  }
});

test("two distinct accepted reviews emit only a minimized non-authorizing receipt", async (t) => {
  const mapping = review(REVIEW_ROLES[0], "mapping");
  const publicHealth = review(REVIEW_ROLES[1], "public-health");
  const paths = await privatePair(t, mapping, publicHealth);
  const receipt = await evaluateReviewFiles({
    root,
    mappingReviewFile: paths.mappingPath,
    publicHealthReviewFile: paths.publicHealthPath,
    expectedSourceCommit: LOCKED_SOURCE_COMMIT,
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  });
  assert.equal(receipt.independent_mapping_review_complete, true);
  assert.equal(receipt.changes_required, false);
  assert.equal(receipt.official_source_mapping_review_accepted, true);
  assert.equal(receipt.public_health_risk_communication_review_accepted, true);
  assert.equal(receipt.catalog_site_count, 61);
  assert.equal(receipt.mapped_site_count, 39);
  assert.equal(receipt.not_covered_site_count, 22);
  for (const boundary of [
    "mapping_change_authorized",
    "runtime_activation_authorized",
    "numeric_score_authorized",
    "clean_water_claim_authorized",
    "seafood_safety_claim_authorized",
    "catch_probability_claim_authorized",
    "merge_authorized",
    "deployment_authorized",
    "production_authorized",
  ]) assert.equal(receipt[boundary], false);
  const publicReceipt = stableJson(receipt);
  for (const privateValue of [
    mapping.review_id,
    publicHealth.review_id,
    mapping.reviewer_competence_evidence_sha256,
    publicHealth.reviewer_competence_evidence_sha256,
    mapping.review_evidence_sha256,
    publicHealth.review_evidence_sha256,
    paths.directory,
    "goleta-beach",
  ]) assert.equal(publicReceipt.includes(privateValue), false);
});

test("an honest changes-required review remains valid and cannot look complete", async (t) => {
  const siteReviews = review(REVIEW_ROLES[0], "mapping").site_reviews;
  siteReviews[0] = {
    ...siteReviews[0],
    official_identity_and_spatial_support_accepted: false,
  };
  const mapping = review(REVIEW_ROLES[0], "mapping-changes", {
    disposition: "changes_required",
    blocking_finding_count: 1,
    site_reviews: siteReviews,
  });
  const publicHealth = review(REVIEW_ROLES[1], "public-health");
  const paths = await privatePair(t, mapping, publicHealth);
  const receipt = await evaluateReviewFiles({
    root,
    mappingReviewFile: paths.mappingPath,
    publicHealthReviewFile: paths.publicHealthPath,
    expectedSourceCommit: LOCKED_SOURCE_COMMIT,
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  });
  assert.equal(receipt.official_source_mapping_review_accepted, false);
  assert.equal(receipt.public_health_risk_communication_review_accepted, true);
  assert.equal(receipt.independent_mapping_review_complete, false);
  assert.equal(receipt.changes_required, true);
  assert.equal(receipt.mapping_change_authorized, false);
});

test("accepted disposition rejects failed site or inventory checks and blocking findings", () => {
  const failedSite = review(REVIEW_ROLES[0], "failed-site");
  failedSite.site_reviews[12].action_only_and_missing_data_semantics_accepted = false;
  assert.throws(() => validateReviewRecord(failedSite, {
    expectedRole: REVIEW_ROLES[0],
    targetSites: target.sites,
    expectedCommit: LOCKED_SOURCE_COMMIT,
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  }), /accepted inventory requires every inventory and site check/u);
  const failedInventory = review(REVIEW_ROLES[0], "failed-inventory", {
    inventory_checklist: {
      ...Object.fromEntries(REVIEW_CHECKS.map((check) => [check, true])),
      proximity_alone_never_creates_a_mapping: false,
    },
  });
  assert.throws(() => validateReviewRecord(failedInventory, {
    expectedRole: REVIEW_ROLES[0],
    targetSites: target.sites,
    expectedCommit: LOCKED_SOURCE_COMMIT,
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  }), /accepted inventory requires every inventory and site check/u);
  const noFinding = review(REVIEW_ROLES[0], "no-finding", { disposition: "changes_required" });
  assert.throws(() => validateReviewRecord(noFinding, {
    expectedRole: REVIEW_ROLES[0],
    targetSites: target.sites,
    expectedCommit: LOCKED_SOURCE_COMMIT,
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  }), /must identify a failed check or blocking finding/u);
});

test("omission, reorder, remapping, and station substitution all fail closed", () => {
  const omitted = review(REVIEW_ROLES[0], "omitted");
  omitted.site_reviews = omitted.site_reviews.slice(1);
  assert.throws(() => validateReviewRecord(omitted, {
    expectedRole: REVIEW_ROLES[0], targetSites: target.sites, expectedCommit: LOCKED_SOURCE_COMMIT,
  }), /exactly the 61 locked site outcomes/u);

  const reordered = review(REVIEW_ROLES[0], "reordered");
  [reordered.site_reviews[0], reordered.site_reviews[1]] = [reordered.site_reviews[1], reordered.site_reviews[0]];
  assert.throws(() => validateReviewRecord(reordered, {
    expectedRole: REVIEW_ROLES[0], targetSites: target.sites, expectedCommit: LOCKED_SOURCE_COMMIT,
  }), /does not match the locked site_id/u);

  const remapped = review(REVIEW_ROLES[0], "remapped");
  const mappedIndex = remapped.site_reviews.findIndex(({ target_outcome: outcome }) => outcome === "mapped");
  remapped.site_reviews[mappedIndex] = { ...remapped.site_reviews[mappedIndex], source_id: "unreviewed-source" };
  assert.throws(() => validateReviewRecord(remapped, {
    expectedRole: REVIEW_ROLES[0], targetSites: target.sites, expectedCommit: LOCKED_SOURCE_COMMIT,
  }), /does not match the locked source_id/u);

  const substituted = review(REVIEW_ROLES[0], "substituted");
  substituted.site_reviews[mappedIndex] = {
    ...substituted.site_reviews[mappedIndex],
    station_ids: ["UNREVIEWED-STATION"],
  };
  assert.throws(() => validateReviewRecord(substituted, {
    expectedRole: REVIEW_ROLES[0], targetSites: target.sites, expectedCommit: LOCKED_SOURCE_COMMIT,
  }), /does not match the locked station_ids/u);
});

test("any checked-in target artifact drift invalidates the entire review target", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-target-drift-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const { path } of REVIEW_TARGET_INPUTS) {
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, path), destination);
  }
  const policyPath = join(directory, "water-quality/policy.json");
  await writeFile(policyPath, `${await readFile(policyPath, "utf8")}\n`);
  await assert.rejects(loadReviewTarget(directory), /Review target input drifted: water-quality\/policy.json/u);
});

test("evaluation rejects source drift, reviewer reuse, and swapped roles", async (t) => {
  const mapping = review(REVIEW_ROLES[0], "mapping");
  const publicHealth = review(REVIEW_ROLES[1], "public-health", {
    reviewer_competence_evidence_sha256: mapping.reviewer_competence_evidence_sha256,
  });
  const paths = await privatePair(t, mapping, publicHealth);
  await assert.rejects(evaluateReviewFiles({
    root,
    mappingReviewFile: paths.mappingPath,
    publicHealthReviewFile: paths.publicHealthPath,
    expectedSourceCommit: LOCKED_SOURCE_COMMIT,
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  }), /must be distinct/u);
  await assert.rejects(evaluateReviewFiles({
    root,
    mappingReviewFile: paths.mappingPath,
    publicHealthReviewFile: paths.publicHealthPath,
    expectedSourceCommit: "0".repeat(40),
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  }), /does not match the locked mapping source commit/u);
  const swapped = await privatePair(
    t,
    review(REVIEW_ROLES[1], "swapped-one"),
    review(REVIEW_ROLES[0], "swapped-two"),
  );
  await assert.rejects(evaluateReviewFiles({
    root,
    mappingReviewFile: swapped.mappingPath,
    publicHealthReviewFile: swapped.publicHealthPath,
    expectedSourceCommit: LOCKED_SOURCE_COMMIT,
    now: Date.parse("2026-07-21T20:00:00.000Z"),
  }), /role is invalid/u);
});

test("private review files reject repository paths, permissive modes, symlinks, and hard links", async (t) => {
  const mapping = review(REVIEW_ROLES[0], "mapping");
  const publicHealth = review(REVIEW_ROLES[1], "public-health");
  const paths = await privatePair(t, mapping, publicHealth);
  await chmod(paths.mappingPath, 0o644);
  await assert.rejects(evaluateReviewFiles({
    root,
    mappingReviewFile: paths.mappingPath,
    publicHealthReviewFile: paths.publicHealthPath,
    expectedSourceCommit: LOCKED_SOURCE_COMMIT,
  }), /must not grant group or other permissions/u);
  await chmod(paths.mappingPath, 0o600);
  const linkPath = join(paths.directory, "mapping-link.json");
  await symlink(paths.mappingPath, linkPath);
  await assert.rejects(evaluateReviewFiles({
    root,
    mappingReviewFile: linkPath,
    publicHealthReviewFile: paths.publicHealthPath,
    expectedSourceCommit: LOCKED_SOURCE_COMMIT,
  }), /regular non-symlink file/u);
  const hardLinkPath = join(paths.directory, "mapping-hard-link.json");
  await link(paths.mappingPath, hardLinkPath);
  await assert.rejects(evaluateReviewFiles({
    root,
    mappingReviewFile: paths.mappingPath,
    publicHealthReviewFile: paths.publicHealthPath,
    expectedSourceCommit: LOCKED_SOURCE_COMMIT,
  }), /must not be hard-linked/u);
});

test("private template writer creates a canonical owner-only file and never overwrites", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-review-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const outputFile = join(directory, "mapping-review.json");
  const receipt = await writeReviewTemplate({
    root,
    role: REVIEW_ROLES[0],
    outputFile,
    now: Date.parse("2026-07-21T21:00:00.000Z"),
  });
  const metadata = await lstat(outputFile);
  const source = await readFile(outputFile, "utf8");
  const payload = JSON.parse(source);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(source, stableJson(payload));
  assert.equal(payload.reviewer_role, REVIEW_ROLES[0]);
  assert.equal(payload.reviewed_at, "2026-07-21T21:00:00.000Z");
  assert.equal(payload.disposition, "changes_required");
  assert.equal(payload.site_reviews.length, 61);
  assert.equal(receipt.owner_only_file_written, true);
  assert.equal(receipt.existing_file_overwritten, false);
  assert.equal(receipt.merge_authorized, false);
  assert.equal(receipt.deployment_authorized, false);
  assert.equal(receipt.production_authorized, false);
  await assert.rejects(writeReviewTemplate({
    root,
    role: REVIEW_ROLES[0],
    outputFile,
  }), /must not already exist/u);
  assert.equal(await readFile(outputFile, "utf8"), source);
});

test("private template writer rejects relative, checkout, permissive, and symlinked destinations", async (t) => {
  await assert.rejects(writeReviewTemplate({
    root,
    role: REVIEW_ROLES[0],
    outputFile: "mapping-review.json",
  }), /must be absolute/u);
  await assert.rejects(writeReviewTemplate({
    root,
    role: REVIEW_ROLES[0],
    outputFile: join(root, "mapping-review.json"),
  }), /outside the repository checkout/u);

  const directory = await mkdtemp(join(tmpdir(), "castingcompass-water-review-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const permissive = join(directory, "permissive");
  await mkdir(permissive, { mode: 0o755 });
  await chmod(permissive, 0o755);
  await assert.rejects(writeReviewTemplate({
    root,
    role: REVIEW_ROLES[0],
    outputFile: join(permissive, "mapping-review.json"),
  }), /must not grant group or other permissions/u);

  const privateDirectory = join(directory, "private");
  const linkedDirectory = join(directory, "linked");
  await mkdir(privateDirectory, { mode: 0o700 });
  await symlink(privateDirectory, linkedDirectory);
  await assert.rejects(writeReviewTemplate({
    root,
    role: REVIEW_ROLES[0],
    outputFile: join(linkedDirectory, "mapping-review.json"),
  }), /existing non-symlink directory/u);
});
