import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createSantaBarbaraAccessReviewTemplate,
  evaluateSantaBarbaraAccessReview,
  requirePrivateEvidenceFile,
  validateSantaBarbaraAccessReview,
  verifySantaBarbaraAccessReview,
  writeSantaBarbaraAccessReviewTemplate,
} from "../scripts/verify-santa-barbara-access-review.mjs";

const root = new URL("../", import.meta.url);
const expectedCommit = "a".repeat(40);
const evaluatedAt = new Date("2026-07-19T12:00:00.000Z");
const reviewerOne = "11111111-1111-4111-8111-111111111111";
const reviewerTwo = "22222222-2222-4222-8222-222222222222";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixtures() {
  const [policySource, catalogSource, guide] = await Promise.all([
    readFile(new URL("field-review/santa-barbara-access-review-policy.json", root)),
    readFile(new URL("public/data/sites.json", root)),
    readFile(new URL("docs/SANTA-BARBARA-LOCAL-ACCESS-REVIEW.md", root), "utf8"),
  ]);
  return {
    policySource,
    catalogSource,
    guide,
    policy: JSON.parse(policySource.toString("utf8")),
    catalog: JSON.parse(catalogSource.toString("utf8")),
  };
}

function responseId(index) {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function completeEvidence(fixture) {
  let responseNumber = 10;
  const answer = {
    public_entry_route: "matches_catalog",
    access_status: "matches_catalog",
    parking_walk: "matches_catalog",
    posted_restrictions: "matches_catalog",
    boundary_clarity: "matches_catalog",
  };
  const responses = [];
  for (const site of fixture.policy.sites) {
    responses.push({
      site_id: site.siteId,
      response_id: responseId(responseNumber++),
      reviewer_key: reviewerOne,
      observed_month: "2026-07",
      question_answers: { ...answer },
      correction_category: null,
      generalized_correction: null,
    });
    if (site.catalogAccessStatus === "limited") {
      responses.push({
        site_id: site.siteId,
        response_id: responseId(responseNumber++),
        reviewer_key: reviewerTwo,
        observed_month: "2026-07",
        question_answers: { ...answer },
        correction_category: null,
        generalized_correction: null,
      });
    }
  }
  return {
    schema_version: "castingcompass.santa-barbara-access-review-evidence/1.0.0",
    reviewed_commit: expectedCommit,
    catalog_sha256: sha256(fixture.catalogSource),
    policy_sha256: sha256(fixture.policySource),
    responses,
    official_source_rechecks: fixture.policy.sites.map(({ siteId }) => ({
      site_id: siteId,
      checked_at: "2026-07-18T12:00:00.000Z",
      access_source_reachable: true,
      access_source_supports_catalog: true,
      regulation_source_reachable: true,
      regulation_source_supports_catalog: true,
      corrections_resolved: true,
    })),
    deployment_authorization_granted: false,
    model_validation_evidence_granted: false,
    safety_or_legality_guarantee_granted: false,
  };
}

function evaluate(fixture, evidence) {
  const evidenceSource = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  return evaluateSantaBarbaraAccessReview({
    ...fixture,
    evidence,
    evidenceSource,
    expectedCommit,
    evaluatedAt,
  });
}

test("Santa Barbara access-review policy exactly covers the regional catalog and remains unexecuted", async () => {
  assert.deepEqual(await verifySantaBarbaraAccessReview(), {
    schemaVersion: "castingcompass.santa-barbara-access-review/1.2.0",
    status: "template_only_not_executed",
    siteCount: 14,
    limitedSiteCount: 5,
    questionCount: 5,
    deploymentAuthorizationGranted: false,
    modelValidationEvidenceGranted: false,
  });
});

test("review policy rejects pre-accepted sites, catalog drift, and weakened authority gates", async () => {
  const fixture = await fixtures();
  const accepted = structuredClone({ policy: fixture.policy, catalog: fixture.catalog, guide: fixture.guide });
  accepted.policy.sites[0].reviewState = "accepted";
  assert.throws(() => validateSantaBarbaraAccessReview(accepted), /cannot be pre-accepted/u);

  const drifted = structuredClone({ policy: fixture.policy, catalog: fixture.catalog, guide: fixture.guide });
  const catalogSites = Array.isArray(drifted.catalog.sites) ? drifted.catalog.sites : drifted.catalog;
  catalogSites.find(({ id }) => id === "goleta-beach").accessStatus = "open";
  assert.throws(() => validateSantaBarbaraAccessReview(drifted), /access status drifted/u);

  const deployable = structuredClone({ policy: fixture.policy, catalog: fixture.catalog, guide: fixture.guide });
  deployable.policy.acceptance.deploymentAuthorizationGranted = true;
  assert.throws(() => validateSantaBarbaraAccessReview(deployable), /cannot authorize deployment/u);
});

test("blank evidence template is digest-bound, private-data-free, and non-authoritative", async () => {
  const fixture = await fixtures();
  const template = createSantaBarbaraAccessReviewTemplate({
    ...fixture,
    reviewedCommit: expectedCommit,
  });
  assert.equal(template.reviewed_commit, expectedCommit);
  assert.equal(template.catalog_sha256, sha256(fixture.catalogSource));
  assert.equal(template.policy_sha256, sha256(fixture.policySource));
  assert.deepEqual(template.responses, []);
  assert.equal(template.official_source_rechecks.length, 14);
  assert.equal(template.official_source_rechecks.every((entry) =>
    entry.checked_at === "1970-01-01T00:00:00.000Z"
      && entry.access_source_reachable === false
      && entry.corrections_resolved === false), true);
  assert.equal(template.deployment_authorization_granted, false);
});

test("guarded template writer creates one owner-only file and never overwrites it", async (context) => {
  const privateDirectory = await mkdtemp(join(tmpdir(), "castingcompass-access-writer-"));
  context.after(() => rm(privateDirectory, { force: true, recursive: true }));
  await chmod(privateDirectory, 0o700);
  const outputFile = join(privateDirectory, "access-review.json");

  const receipt = await writeSantaBarbaraAccessReviewTemplate({
    reviewedCommit: expectedCommit,
    outputFile,
  });
  const metadata = await lstat(outputFile);
  const payload = JSON.parse(await readFile(outputFile, "utf8"));
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.equal(payload.reviewed_commit, expectedCommit);
  assert.deepEqual(payload.responses, []);
  assert.equal(payload.official_source_rechecks.length, 14);
  assert.equal(receipt.owner_only_file_written, true);
  assert.equal(receipt.existing_file_overwritten, false);
  assert.equal(receipt.access_review_accepted, false);
  assert.equal(receipt.deployment_authorization_granted, false);

  const originalBytes = await readFile(outputFile);
  assert.deepEqual(await requirePrivateEvidenceFile(fileURLToPath(root), outputFile), originalBytes);
  await assert.rejects(
    writeSantaBarbaraAccessReviewTemplate({ reviewedCommit: expectedCommit, outputFile }),
    /must not already exist/u,
  );
  assert.deepEqual(await readFile(outputFile), originalBytes);
});

test("guarded template writer rejects unsafe destination boundaries", async (context) => {
  const baseDirectory = await mkdtemp(join(tmpdir(), "castingcompass-access-destination-"));
  context.after(() => rm(baseDirectory, { force: true, recursive: true }));
  await chmod(baseDirectory, 0o700);
  const permissiveDirectory = join(baseDirectory, "permissive");
  const privateDirectory = join(baseDirectory, "private");
  const linkedDirectory = join(baseDirectory, "linked");
  const repositoryRoot = fileURLToPath(root);
  await mkdir(permissiveDirectory, { mode: 0o755 });
  await chmod(permissiveDirectory, 0o755);
  await mkdir(privateDirectory, { mode: 0o700 });
  await symlink(privateDirectory, linkedDirectory);

  await assert.rejects(
    writeSantaBarbaraAccessReviewTemplate({ reviewedCommit: expectedCommit, outputFile: "relative.json" }),
    /must be absolute/u,
  );
  await assert.rejects(
    writeSantaBarbaraAccessReviewTemplate({
      reviewedCommit: expectedCommit,
      outputFile: join(repositoryRoot, "private-review.json"),
    }),
    /outside the repository/u,
  );
  await assert.rejects(
    writeSantaBarbaraAccessReviewTemplate({
      reviewedCommit: expectedCommit,
      outputFile: join(permissiveDirectory, "review.json"),
    }),
    /must not grant group or other permissions/u,
  );
  await assert.rejects(
    writeSantaBarbaraAccessReviewTemplate({
      reviewedCommit: expectedCommit,
      outputFile: join(linkedDirectory, "review.json"),
    }),
    /non-symlink directory/u,
  );
});

test("private evidence reader rejects unsafe files before reading them", async (context) => {
  const privateDirectory = await mkdtemp(join(tmpdir(), "castingcompass-access-reader-"));
  context.after(() => rm(privateDirectory, { force: true, recursive: true }));
  await chmod(privateDirectory, 0o700);
  const repositoryRoot = fileURLToPath(root);

  const broadFile = join(privateDirectory, "broad.json");
  await writeFile(broadFile, "{}\n", { mode: 0o600 });
  await chmod(broadFile, 0o644);
  await assert.rejects(requirePrivateEvidenceFile(repositoryRoot, broadFile), /exactly 0600/u);

  const linkedSource = join(privateDirectory, "linked-source.json");
  const hardLink = join(privateDirectory, "hard-link.json");
  await writeFile(linkedSource, "{}\n", { mode: 0o600 });
  await chmod(linkedSource, 0o600);
  await link(linkedSource, hardLink);
  await assert.rejects(requirePrivateEvidenceFile(repositoryRoot, linkedSource), /must not be hard-linked/u);

  const symlinkTarget = join(privateDirectory, "symlink-target.json");
  const symlinkFile = join(privateDirectory, "symlink.json");
  await writeFile(symlinkTarget, "{}\n", { mode: 0o600 });
  await chmod(symlinkTarget, 0o600);
  await symlink(symlinkTarget, symlinkFile);
  await assert.rejects(requirePrivateEvidenceFile(repositoryRoot, symlinkFile), /regular, non-symlink/u);

  const emptyFile = join(privateDirectory, "empty.json");
  await writeFile(emptyFile, "", { mode: 0o600 });
  await chmod(emptyFile, 0o600);
  await assert.rejects(requirePrivateEvidenceFile(repositoryRoot, emptyFile), /size boundary or is empty/u);

  const oversizedFile = join(privateDirectory, "oversized.json");
  await writeFile(oversizedFile, Buffer.alloc(256 * 1024 + 1), { mode: 0o600 });
  await chmod(oversizedFile, 0o600);
  await assert.rejects(requirePrivateEvidenceFile(repositoryRoot, oversizedFile), /size boundary or is empty/u);
});

test("complete evidence accepts all 14 sites while its public receipt exposes only aggregates", async () => {
  const fixture = await fixtures();
  const evidence = completeEvidence(fixture);
  const evidenceSource = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  const receipt = evaluateSantaBarbaraAccessReview({
    ...fixture,
    evidence,
    evidenceSource,
    expectedCommit,
    evaluatedAt,
  });
  assert.equal(receipt.access_review_accepted, true);
  assert.equal(receipt.site_count, 14);
  assert.equal(receipt.passing_site_count, 14);
  assert.equal(receipt.blocked_site_count, 0);
  assert.equal(receipt.response_count, 19);
  assert.equal(receipt.qualifying_response_count, 19);
  assert.equal(receipt.distinct_reviewer_count, 2);
  assert.equal(receipt.private_evidence_sha256, sha256(evidenceSource));
  assert.deepEqual(receipt.blockers, []);
  assert.equal(receipt.provider_query_performed, false);
  assert.equal(receipt.production_change_authorized, false);
  assert.equal(receipt.deployment_authorization_granted, false);
  const publicText = JSON.stringify(receipt);
  assert.equal(publicText.includes(reviewerOne), false);
  assert.equal(publicText.includes(evidence.responses[0].response_id), false);
  assert.equal(publicText.includes(evidence.responses[0].site_id), false);
  assert.equal(publicText.includes("generalized_correction"), false);
});

test("limited-site thresholds and uncertain or unobserved answers fail closed", async () => {
  const fixture = await fixtures();
  const missingLimitedReview = completeEvidence(fixture);
  missingLimitedReview.responses = missingLimitedReview.responses.filter((response) =>
    !(response.site_id === "goleta-beach" && response.reviewer_key === reviewerTwo));
  const missingReceipt = evaluate(fixture, missingLimitedReview);
  assert.equal(missingReceipt.access_review_accepted, false);
  assert.equal(missingReceipt.blockers.includes("responses-incomplete"), true);
  assert.equal(missingReceipt.blocked_site_count, 1);

  const uncertain = completeEvidence(fixture);
  uncertain.responses.find((response) => response.site_id === "gaviota-state-park-beach")
    .question_answers.access_status = "uncertain";
  const uncertainReceipt = evaluate(fixture, uncertain);
  assert.equal(uncertainReceipt.access_review_accepted, false);
  assert.equal(uncertainReceipt.blockers.includes("responses-incomplete"), true);

  const notObserved = completeEvidence(fixture);
  const response = notObserved.responses.find((entry) => entry.site_id === "gaviota-state-park-beach");
  response.observed_month = "not_observed";
  for (const question of Object.keys(response.question_answers)) response.question_answers[question] = "not_observed";
  assert.equal(evaluate(fixture, notObserved).access_review_accepted, false);
});

test("stale observations, stale or incomplete official checks, and unresolved corrections are explicit blockers", async () => {
  const fixture = await fixtures();
  const staleObservation = completeEvidence(fixture);
  staleObservation.responses[0].observed_month = "2025-12";
  assert.equal(evaluate(fixture, staleObservation).blockers.includes("response-outside-recency-window"), true);

  const staleSource = completeEvidence(fixture);
  staleSource.official_source_rechecks[0].checked_at = "2026-07-01T12:00:00.000Z";
  const staleReceipt = evaluate(fixture, staleSource);
  assert.equal(staleReceipt.blockers.includes("official-recheck-stale"), true);
  assert.equal(staleReceipt.official_rechecks_current, false);

  const incompleteSource = completeEvidence(fixture);
  incompleteSource.official_source_rechecks[0].access_source_supports_catalog = false;
  assert.equal(evaluate(fixture, incompleteSource).blockers.includes("official-recheck-incomplete"), true);

  const correction = completeEvidence(fixture);
  correction.responses[0].question_answers.access_status = "correction_needed";
  correction.responses[0].correction_category = "status";
  correction.responses[0].generalized_correction = "Posted access status did not match the catalog.";
  correction.official_source_rechecks.find(({ site_id }) => site_id === correction.responses[0].site_id)
    .corrections_resolved = false;
  const correctionReceipt = evaluate(fixture, correction);
  assert.equal(correctionReceipt.blockers.includes("unresolved-corrections"), true);
  assert.equal(correctionReceipt.unresolved_correction_count, 1);
});

test("private evidence rejects identity ambiguity, unsafe text, digest drift, unknown fields, and authority escalation", async () => {
  const fixture = await fixtures();
  const duplicateReviewer = completeEvidence(fixture);
  const duplicate = structuredClone(duplicateReviewer.responses[0]);
  duplicate.response_id = responseId(999);
  duplicateReviewer.responses.push(duplicate);
  assert.throws(() => evaluate(fixture, duplicateReviewer), /one response per site/u);

  const unsafe = completeEvidence(fixture);
  unsafe.responses[0].question_answers.access_status = "correction_needed";
  unsafe.responses[0].correction_category = "status";
  unsafe.responses[0].generalized_correction = "Email angler@example.com or use 34.42000, -119.70000";
  assert.throws(() => evaluate(fixture, unsafe), /unsafe or exceeds/u);

  const drifted = completeEvidence(fixture);
  drifted.catalog_sha256 = "0".repeat(64);
  assert.throws(() => evaluate(fixture, drifted), /catalog digest/u);

  const expanded = completeEvidence(fixture);
  expanded.responses[0].reviewer_name = "Private Person";
  assert.throws(() => evaluate(fixture, expanded), /keys do not match/u);

  const authoritative = completeEvidence(fixture);
  authoritative.deployment_authorization_granted = true;
  assert.throws(() => evaluate(fixture, authoritative), /cannot authorize deployment/u);
});

test("the evaluator has no provider client or process execution path", async () => {
  const source = await readFile(new URL("scripts/verify-santa-barbara-access-review.mjs", root), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bexecFile\b|\bspawn\b|\bfetch\s*\(/u);
});
