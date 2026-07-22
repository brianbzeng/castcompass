#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { requirePrivateEvidenceFile } from "./verify-santa-barbara-access-review.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGION_NAMES = new Set(["Gaviota Coast", "Goleta", "Santa Barbara", "Summerland", "Carpinteria"]);
const POLICY_SCHEMA = "castingcompass.santa-barbara-structure-depth-review/1.0.0";
const EVIDENCE_SCHEMA = "castingcompass.santa-barbara-structure-depth-review-evidence/1.0.0";
const RECEIPT_SCHEMA = "castingcompass.santa-barbara-structure-depth-review-receipt/1.0.0";
const WRITE_RECEIPT_SCHEMA = "castingcompass.santa-barbara-structure-depth-review-template-write-receipt/1.0.0";
const ARTIFACT_SCHEMA = "castingcompass.structure-depth-evidence/1.5.0";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const DAY_MS = 86_400_000;
const TOP_LEVEL_KEYS = [
  "acceptance",
  "evidence",
  "geography",
  "prohibitedFields",
  "publicReceipt",
  "purpose",
  "questions",
  "responseStates",
  "reviewedOn",
  "schemaVersion",
  "sites",
  "sourceBoundary",
  "status",
  "storage",
];
const SOURCE_BOUNDARY_KEYS = [
  "artifactPath",
  "artifactSchemaVersion",
  "catalogMutationAllowed",
  "catalogPath",
  "collectorPath",
  "depthUnits",
  "navigationUseAllowed",
  "numericContributionAllowed",
  "sourceId",
  "sourcePolicyPath",
  "sourceSnapshotPath",
  "usageBand",
  "verticalDatum",
];
const SITE_KEYS = ["chartReviewState", "localReviewState", "name", "siteId"];
const LOCAL_RESPONSE_KEYS = [
  "correction_category",
  "generalized_correction",
  "observed_month",
  "question_answers",
  "response_id",
  "reviewer_key",
  "site_id",
];
const CHART_RESPONSE_KEYS = [
  "conflict_free_attestation",
  "correction_category",
  "generalized_correction",
  "question_answers",
  "response_id",
  "reviewed_at",
  "reviewer_key",
  "role_attestation",
  "site_id",
];
const RECHECK_KEYS = [
  "artifact_hashes_match",
  "checked_at",
  "limitations_acknowledged",
  "program_url_reachable",
  "reviewer_key",
  "service_identity_matches",
];
const EVIDENCE_KEYS = [
  "catalog_sha256",
  "chart_responses",
  "deployment_authorization_granted",
  "local_responses",
  "model_validation_evidence_granted",
  "navigation_use_authorized",
  "review_policy_sha256",
  "reviewed_commit",
  "schema_version",
  "score_use_authorized",
  "source_identity_recheck",
  "structure_depth_artifact_sha256",
  "structure_depth_policy_sha256",
];
const RECEIPT_FIELDS = [
  "schema_version",
  "evaluated_at",
  "reviewed_commit",
  "catalog_sha256",
  "structure_depth_artifact_sha256",
  "structure_depth_policy_sha256",
  "review_policy_sha256",
  "private_evidence_sha256",
  "read_only",
  "provider_query_performed",
  "production_change_authorized",
  "local_response_count",
  "qualifying_local_response_count",
  "chart_response_count",
  "qualifying_chart_response_count",
  "distinct_local_reviewer_count",
  "distinct_chart_reviewer_count",
  "site_count",
  "passing_local_site_count",
  "passing_chart_site_count",
  "passing_site_count",
  "unresolved_correction_count",
  "source_identity_recheck_current",
  "raw_response_disposal_due_at",
  "structure_depth_review_accepted",
  "score_use_authorized",
  "navigation_use_authorized",
  "deployment_authorization_granted",
  "model_validation_evidence_granted",
  "blockers",
];
const BLOCKER_CODES = [
  "distinct-local-reviewers-insufficient",
  "distinct-chart-reviewers-insufficient",
  "reviewer-role-overlap",
  "local-response-stale",
  "chart-review-stale",
  "local-responses-incomplete",
  "chart-responses-incomplete",
  "source-recheck-incomplete",
  "source-recheck-stale",
  "unresolved-corrections",
];
const LOCAL_QUESTION_IDS = [
  "sector_direction",
  "depth_band_usefulness",
  "charted_feature_usefulness",
  "catalog_clue_fit",
  "display_limitations",
];
const CHART_QUESTION_IDS = [
  "source_product_fit",
  "sector_reproducibility",
  "units_and_datum",
  "source_dates",
  "uncertainty_disclosure",
  "feature_class_claim",
];
const LOCAL_STATES = ["matches_context", "correction_needed", "not_observed", "uncertain"];
const CHART_STATES = ["accepted", "changes_required", "unable_to_assess"];
const LOCAL_CORRECTION_CATEGORIES = ["sector", "depth", "feature", "clue", "disclosure"];
const CHART_CORRECTION_CATEGORIES = ["source", "geometry", "datum", "date", "uncertainty", "classification", "disclosure"];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireExactKeys(value, expected, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  requireCondition(isDeepStrictEqual(actual, [...expected].sort()), `${label} keys do not match the locked contract.`);
}

function requireUniqueStrings(values, label) {
  requireCondition(Array.isArray(values) && values.every((value) => typeof value === "string" && value.length > 0), `${label} must contain nonempty strings.`);
  requireCondition(new Set(values).size === values.length, `${label} must not contain duplicates.`);
}

function strictCommit(value, label = "Reviewed commit") {
  requireCondition(COMMIT_PATTERN.test(value ?? ""), `${label} must be a full lowercase commit SHA.`);
  return value;
}

function canonicalInstant(value, label) {
  requireCondition(typeof value === "string", `${label} must be a canonical UTC timestamp.`);
  const parsed = new Date(value);
  requireCondition(!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value, `${label} must be a canonical UTC timestamp.`);
  return parsed;
}

function monthNumber(value) {
  const [year, month] = value.split("-").map(Number);
  return year * 12 + month - 1;
}

function safeCorrection(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 240
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    && !/(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu.test(value)
    && !/[-+]?\d{1,3}\.\d{3,}\s*[,/]\s*[-+]?\d{1,3}\.\d{3,}/u.test(value)
    && !/(?:\+?\d[\s().-]*){7,}/u.test(value)
    && !/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu.test(value);
}

function validateQuestionSet(questions, expectedIds, label) {
  requireCondition(Array.isArray(questions) && questions.length === expectedIds.length, `${label} question count changed.`);
  requireCondition(isDeepStrictEqual(questions.map(({ id }) => id), expectedIds), `${label} question IDs changed.`);
  for (const question of questions) {
    requireExactKeys(question, ["id", "prompt"], `${label} question ${question.id}`);
    requireCondition(typeof question.prompt === "string" && question.prompt.endsWith("?"), `${label} question ${question.id} must be a question.`);
    requireCondition(!/(?:name|email|phone|account (?:id|identifier)|exact time|coordinate|photo|catch|trip note)/iu.test(question.prompt), `${label} question ${question.id} requests prohibited data.`);
  }
}

function validateArtifactBindings({ policy, catalog, artifact, sourcePolicy, policySource, catalogSource, artifactSource, sourcePolicySource, sourceSnapshotSource, collectorSource }) {
  const sourceBoundary = policy.sourceBoundary;
  requireCondition(artifact.schemaVersion === ARTIFACT_SCHEMA, "Structure/depth artifact schema drifted.");
  requireCondition(artifact.schemaVersion === sourceBoundary.artifactSchemaVersion, "Policy artifact schema binding drifted.");
  requireCondition(artifact.source?.sourceId === sourceBoundary.sourceId, "Structure/depth source identity drifted.");
  requireCondition(artifact.source?.usageBand === sourceBoundary.usageBand, "Structure/depth usage band drifted.");
  requireCondition(artifact.source?.depthUnits === sourceBoundary.depthUnits, "Structure/depth units drifted.");
  requireCondition(artifact.source?.verticalDatum === sourceBoundary.verticalDatum, "Structure/depth datum drifted.");
  requireCondition(artifact.source?.notForNavigation === true, "Structure/depth source must remain non-navigational.");
  requireCondition(artifact.scoreContribution?.numericContributionAllowed === false, "Structure/depth artifact cannot contribute a number.");
  requireCondition(artifact.scoreContribution?.catalogMutationAllowed === false, "Structure/depth artifact cannot mutate the catalog.");
  requireCondition(artifact.policySha256 === sha256(sourcePolicySource), "Structure/depth source-policy digest drifted.");
  requireCondition(artifact.siteCatalogSha256 === sha256(catalogSource), "Structure/depth catalog digest drifted.");
  requireCondition(artifact.sourceSnapshotSha256 === sha256(sourceSnapshotSource), "Structure/depth source-snapshot digest drifted.");
  requireCondition(artifact.collectorSha256 === sha256(collectorSource), "Structure/depth collector digest drifted.");
  requireCondition(sourcePolicy.policy_version === artifact.policyVersion, "Structure/depth policy version drifted.");
  requireCondition(SHA256_PATTERN.test(sha256(policySource)) && SHA256_PATTERN.test(sha256(artifactSource)), "Review input digest generation failed.");

  const allSites = Array.isArray(catalog.sites) ? catalog.sites : catalog;
  requireCondition(Array.isArray(allSites), "Site catalog must contain an array.");
  const regionalSites = allSites.filter((site) => REGION_NAMES.has(site.region));
  requireCondition(regionalSites.length === 14, "Santa Barbara catalog population must remain 14 sites.");
  const catalogById = new Map(regionalSites.map((site) => [site.id, site]));
  for (const reviewSite of policy.sites) {
    const catalogSite = catalogById.get(reviewSite.siteId);
    const evidence = artifact.sites?.[reviewSite.siteId];
    requireCondition(Boolean(catalogSite), `Unknown review site ${reviewSite.siteId}.`);
    requireCondition(Boolean(evidence), `Structure/depth evidence is missing ${reviewSite.siteId}.`);
    requireCondition(reviewSite.name === catalogSite.name && evidence.siteName === catalogSite.name, `${reviewSite.siteId} name drifted.`);
    requireCondition(evidence.siteId === reviewSite.siteId, `${reviewSite.siteId} artifact identity drifted.`);
    requireCondition(evidence.status === "charted-context", `${reviewSite.siteId} is not charted context.`);
    requireCondition(evidence.navigationUseAllowed === false && evidence.scoreDelta === null, `${reviewSite.siteId} crossed an authority boundary.`);
    requireCondition(evidence.depth?.uncertaintyMeters === null, `${reviewSite.siteId} invented numeric uncertainty.`);
    requireCondition(evidence.depth?.uncertaintyStatus === "not-exposed-by-selected-service-layers", `${reviewSite.siteId} uncertainty disclosure drifted.`);
    requireCondition(evidence.geometry?.sectorHalfWidthDegrees === 45 && evidence.geometry?.contextRadiusMeters === 1000, `${reviewSite.siteId} geometry boundary drifted.`);
    const artifactClues = evidence.structure?.catalogClues?.map(({ tag, reviewStatus }) => ({ tag, reviewStatus })) ?? [];
    const expectedClues = (catalogSite.structureTags ?? []).map((tag) => ({ tag, reviewStatus: "catalog-only-not-validated-by-this-source" }));
    requireCondition(isDeepStrictEqual(artifactClues, expectedClues), `${reviewSite.siteId} catalog clues drifted or were pre-validated.`);
  }
  return { regionalSites, catalogById };
}

export function validateSantaBarbaraStructureDepthReview({
  policy,
  catalog,
  artifact,
  sourcePolicy,
  guide,
  policySource,
  catalogSource,
  artifactSource,
  sourcePolicySource,
  sourceSnapshotSource,
  collectorSource,
}) {
  requireExactKeys(policy, TOP_LEVEL_KEYS, "Review policy");
  requireCondition(policy.schemaVersion === POLICY_SCHEMA, "Review policy schema version is not locked.");
  requireCondition(policy.status === "template_only_not_executed", "Committed review policy must remain unexecuted.");
  requireCondition(/^\d{4}-\d{2}-\d{2}$/u.test(policy.reviewedOn), "Policy review date must be YYYY-MM-DD.");
  requireCondition(typeof policy.purpose === "string" && policy.purpose.length >= 100, "Review purpose is incomplete.");

  requireExactKeys(policy.geography, ["expectedSiteCount", "label", "scope"], "Review geography");
  requireCondition(policy.geography.label === "Santa Barbara South Coast" && policy.geography.scope === "Gaviota through Rincon", "Review geography drifted.");
  requireCondition(policy.geography.expectedSiteCount === 14, "Review geography must contain 14 sites.");

  requireExactKeys(policy.sourceBoundary, SOURCE_BOUNDARY_KEYS, "Source boundary");
  requireCondition(policy.sourceBoundary.artifactPath === "public/data/structure-depth.json", "Artifact path drifted.");
  requireCondition(policy.sourceBoundary.catalogPath === "data/sites.json", "Catalog path drifted.");
  requireCondition(policy.sourceBoundary.sourcePolicyPath === "structure-depth/policy.json", "Source-policy path drifted.");
  requireCondition(policy.sourceBoundary.sourceSnapshotPath === "structure-depth/noaa-enc-approach-snapshot.json", "Source-snapshot path drifted.");
  requireCondition(policy.sourceBoundary.collectorPath === "scripts/refresh_structure_depth.py", "Collector path drifted.");
  requireCondition(policy.sourceBoundary.sourceId === "noaa-enc-direct-approach" && policy.sourceBoundary.usageBand === "Approach", "NOAA source boundary drifted.");
  requireCondition(policy.sourceBoundary.depthUnits === "meters" && policy.sourceBoundary.verticalDatum === "Mean Lower Low Water (MLLW)", "Depth meaning drifted.");
  requireCondition(policy.sourceBoundary.numericContributionAllowed === false && policy.sourceBoundary.catalogMutationAllowed === false && policy.sourceBoundary.navigationUseAllowed === false, "Review policy cannot grant product authority.");

  requireExactKeys(policy.storage, ["privateEvidenceDigestRequiredForAggregateReceipt", "rawResponseRetentionDaysAfterDecision", "repositoryState", "responseLocation"], "Storage policy");
  requireCondition(policy.storage.responseLocation === "private_outside_repository", "Responses must remain private and outside the repository.");
  requireCondition(policy.storage.repositoryState === "blank_policy_and_aggregate_receipt_only", "Repository evidence boundary drifted.");
  requireCondition(policy.storage.rawResponseRetentionDaysAfterDecision === 30 && policy.storage.privateEvidenceDigestRequiredForAggregateReceipt === true, "Private evidence retention boundary drifted.");

  const expectedProhibited = [
    "reviewer_name",
    "contact_information",
    "account_or_user_id",
    "exact_visit_timestamp",
    "precise_coordinates",
    "private_access_directions",
    "catch_or_trip_outcomes",
    "trip_notes",
    "photos_or_video",
    "credentials_or_tokens",
  ];
  requireUniqueStrings(policy.prohibitedFields, "Prohibited fields");
  requireCondition(isDeepStrictEqual(policy.prohibitedFields, expectedProhibited), "Prohibited fields changed.");

  requireExactKeys(policy.evidence, ["maximumChartReviewAgeDays", "maximumFileBytes", "maximumFutureSkewMinutes", "maximumObservedMonthAgeMonths", "maximumResponsesPerSiteAndRole", "schemaVersion"], "Evidence policy");
  requireCondition(policy.evidence.schemaVersion === EVIDENCE_SCHEMA, "Private evidence schema version drifted.");
  requireCondition(policy.evidence.maximumFileBytes === 262144 && policy.evidence.maximumResponsesPerSiteAndRole === 10, "Private evidence size/count boundary drifted.");
  requireCondition(policy.evidence.maximumObservedMonthAgeMonths === 6 && policy.evidence.maximumChartReviewAgeDays === 30 && policy.evidence.maximumFutureSkewMinutes === 5, "Review recency boundary drifted.");

  requireExactKeys(policy.responseStates, ["chart", "local"], "Response states");
  requireCondition(isDeepStrictEqual(policy.responseStates.local, LOCAL_STATES) && isDeepStrictEqual(policy.responseStates.chart, CHART_STATES), "Response states changed.");
  requireExactKeys(policy.questions, ["chart", "local"], "Question sets");
  validateQuestionSet(policy.questions.local, LOCAL_QUESTION_IDS, "Local");
  validateQuestionSet(policy.questions.chart, CHART_QUESTION_IDS, "Chart");

  requireExactKeys(policy.publicReceipt, ["allowedFields", "blockerCodes", "schemaVersion"], "Public receipt policy");
  requireCondition(policy.publicReceipt.schemaVersion === RECEIPT_SCHEMA, "Receipt schema version drifted.");
  requireCondition(isDeepStrictEqual(policy.publicReceipt.allowedFields, RECEIPT_FIELDS), "Receipt fields changed.");
  requireCondition(isDeepStrictEqual(policy.publicReceipt.blockerCodes, BLOCKER_CODES), "Receipt blocker codes changed.");

  requireExactKeys(policy.acceptance, ["deploymentAuthorizationGranted", "maximumUnresolvedCorrections", "minimumChartReviewsPerSite", "minimumDistinctChartReviewersAcrossRegion", "minimumDistinctLocalReviewersAcrossRegion", "minimumLocalReviewsPerSite", "modelValidationEvidenceGranted", "navigationUseAuthorized", "reviewerRolesMustBeDisjoint", "scoreUseAuthorized", "sourceIdentityRecheckWithinDays"], "Acceptance policy");
  requireCondition(policy.acceptance.minimumLocalReviewsPerSite === 1 && policy.acceptance.minimumChartReviewsPerSite === 1, "Each site must require both review roles.");
  requireCondition(policy.acceptance.minimumDistinctLocalReviewersAcrossRegion === 2 && policy.acceptance.minimumDistinctChartReviewersAcrossRegion === 1, "Regional reviewer thresholds drifted.");
  requireCondition(policy.acceptance.reviewerRolesMustBeDisjoint === true && policy.acceptance.sourceIdentityRecheckWithinDays === 7 && policy.acceptance.maximumUnresolvedCorrections === 0, "Review separation or freshness boundary drifted.");
  requireCondition(policy.acceptance.scoreUseAuthorized === false && policy.acceptance.navigationUseAuthorized === false && policy.acceptance.deploymentAuthorizationGranted === false && policy.acceptance.modelValidationEvidenceGranted === false, "Review acceptance cannot grant authority.");

  requireCondition(Array.isArray(policy.sites) && policy.sites.length === 14, "Review policy must contain 14 sites.");
  requireUniqueStrings(policy.sites.map(({ siteId }) => siteId), "Review site IDs");
  for (const site of policy.sites) {
    requireExactKeys(site, SITE_KEYS, `Review site ${site.siteId}`);
    requireCondition(site.localReviewState === "pending" && site.chartReviewState === "pending", `${site.siteId} cannot be pre-accepted.`);
    requireCondition(guide.includes(`\`${site.siteId}\``) && guide.includes(`**${site.name}**`), `${site.siteId} is missing from the guide.`);
  }
  const bindings = validateArtifactBindings({ policy, catalog, artifact, sourcePolicy, policySource, catalogSource, artifactSource, sourcePolicySource, sourceSnapshotSource, collectorSource });
  requireCondition(isDeepStrictEqual(policy.sites.map(({ siteId }) => siteId).sort(), bindings.regionalSites.map(({ id }) => id).sort()), "Review site population does not match the regional catalog.");

  for (const questionId of LOCAL_QUESTION_IDS) requireCondition(guide.includes(`${questionId}: matches_context | correction_needed | not_observed | uncertain`), `Guide is missing local question ${questionId}.`);
  for (const questionId of CHART_QUESTION_IDS) requireCondition(guide.includes(`${questionId}: accepted | changes_required | unable_to_assess`), `Guide is missing chart question ${questionId}.`);
  requireCondition(/outside Git,\s*outside Codex/iu.test(guide), "Guide must keep raw evidence outside Git and Codex.");
  requireCondition(/does not authorize a score change/iu.test(guide), "Guide must preserve the score gate.");
  requireCondition(/no review has been conducted or accepted/iu.test(guide), "Guide must state the unexecuted status.");

  return {
    schemaVersion: policy.schemaVersion,
    status: policy.status,
    siteCount: policy.sites.length,
    localQuestionCount: policy.questions.local.length,
    chartQuestionCount: policy.questions.chart.length,
    scoreUseAuthorized: false,
    navigationUseAuthorized: false,
    deploymentAuthorizationGranted: false,
  };
}

export function createSantaBarbaraStructureDepthReviewTemplate({
  policy,
  catalog,
  artifact,
  sourcePolicy,
  guide,
  policySource,
  catalogSource,
  artifactSource,
  sourcePolicySource,
  sourceSnapshotSource,
  collectorSource,
  reviewedCommit,
}) {
  validateSantaBarbaraStructureDepthReview({ policy, catalog, artifact, sourcePolicy, guide, policySource, catalogSource, artifactSource, sourcePolicySource, sourceSnapshotSource, collectorSource });
  strictCommit(reviewedCommit);
  return {
    schema_version: EVIDENCE_SCHEMA,
    reviewed_commit: reviewedCommit,
    catalog_sha256: sha256(catalogSource),
    structure_depth_artifact_sha256: sha256(artifactSource),
    structure_depth_policy_sha256: sha256(sourcePolicySource),
    review_policy_sha256: sha256(policySource),
    local_responses: [],
    chart_responses: [],
    source_identity_recheck: {
      reviewer_key: null,
      checked_at: null,
      program_url_reachable: null,
      service_identity_matches: null,
      artifact_hashes_match: null,
      limitations_acknowledged: null,
    },
    score_use_authorized: false,
    navigation_use_authorized: false,
    deployment_authorization_granted: false,
    model_validation_evidence_granted: false,
  };
}

function validateCorrection(response, states, correctionState, categories, label) {
  const answers = Object.values(response.question_answers);
  requireCondition(answers.every((answer) => states.includes(answer)), `${label} contains an unknown answer state.`);
  const correctionNeeded = answers.includes(correctionState);
  if (correctionNeeded) {
    requireCondition(categories.includes(response.correction_category), `${label} requires a correction category.`);
    requireCondition(safeCorrection(response.generalized_correction), `${label} correction is unsafe or exceeds the privacy boundary.`);
  } else {
    requireCondition(response.correction_category === null && response.generalized_correction === null, `${label} must omit correction detail when no correction is requested.`);
  }
  return { answers, correctionNeeded };
}

function validateLocalResponse(response, policy, siteIds, evaluationInstant) {
  const label = `Local response ${response?.response_id ?? "unknown"}`;
  requireExactKeys(response, LOCAL_RESPONSE_KEYS, label);
  requireCondition(siteIds.has(response.site_id), `${label} uses an unknown site.`);
  requireCondition(UUID_V4_PATTERN.test(response.response_id ?? "") && UUID_V4_PATTERN.test(response.reviewer_key ?? ""), `${label} IDs must be random UUIDv4 values.`);
  requireCondition(response.observed_month === "not_observed" || MONTH_PATTERN.test(response.observed_month ?? ""), `${label} observed month must be YYYY-MM or not_observed.`);
  requireExactKeys(response.question_answers, LOCAL_QUESTION_IDS, `${label} answers`);
  const result = validateCorrection(response, LOCAL_STATES, "correction_needed", LOCAL_CORRECTION_CATEGORIES, label);
  if (response.observed_month === "not_observed") requireCondition(result.answers.every((answer) => answer === "not_observed"), `${label} must use not_observed for every answer.`);
  const currentMonth = evaluationInstant.getUTCFullYear() * 12 + evaluationInstant.getUTCMonth();
  const observedMonth = response.observed_month === "not_observed" ? null : monthNumber(response.observed_month);
  const fresh = observedMonth !== null && observedMonth <= currentMonth && currentMonth - observedMonth <= policy.evidence.maximumObservedMonthAgeMonths;
  return {
    siteId: response.site_id,
    reviewerKey: response.reviewer_key,
    correctionNeeded: result.correctionNeeded,
    stale: observedMonth !== null && !fresh,
    qualifying: fresh && result.answers.every((answer) => answer === "matches_context"),
  };
}

function validateChartResponse(response, policy, siteIds, evaluationInstant) {
  const label = `Chart response ${response?.response_id ?? "unknown"}`;
  requireExactKeys(response, CHART_RESPONSE_KEYS, label);
  requireCondition(siteIds.has(response.site_id), `${label} uses an unknown site.`);
  requireCondition(UUID_V4_PATTERN.test(response.response_id ?? "") && UUID_V4_PATTERN.test(response.reviewer_key ?? ""), `${label} IDs must be random UUIDv4 values.`);
  requireCondition(response.role_attestation === "independent_nautical_chart_or_marine_gis_reviewer", `${label} role attestation is not accepted.`);
  requireCondition(typeof response.conflict_free_attestation === "boolean", `${label} conflict attestation must be boolean.`);
  requireExactKeys(response.question_answers, CHART_QUESTION_IDS, `${label} answers`);
  const result = validateCorrection(response, CHART_STATES, "changes_required", CHART_CORRECTION_CATEGORIES, label);
  const reviewedAt = canonicalInstant(response.reviewed_at, `${label} reviewed_at`);
  requireCondition(reviewedAt.getTime() <= evaluationInstant.getTime() + policy.evidence.maximumFutureSkewMinutes * 60_000, `${label} is too far in the future.`);
  const fresh = evaluationInstant.getTime() - reviewedAt.getTime() <= policy.evidence.maximumChartReviewAgeDays * DAY_MS;
  return {
    siteId: response.site_id,
    reviewerKey: response.reviewer_key,
    correctionNeeded: result.correctionNeeded,
    stale: !fresh,
    qualifying: fresh && response.conflict_free_attestation === true && result.answers.every((answer) => answer === "accepted"),
  };
}

function validateSourceRecheck(recheck, policy, qualifyingChartReviewers, evaluationInstant, blockers) {
  requireExactKeys(recheck, RECHECK_KEYS, "Source identity recheck");
  const values = Object.values(recheck);
  if (values.every((value) => value === null)) {
    blockers.add("source-recheck-incomplete");
    return false;
  }
  requireCondition(UUID_V4_PATTERN.test(recheck.reviewer_key ?? ""), "Source recheck reviewer key must be a random UUIDv4.");
  const checkedAt = canonicalInstant(recheck.checked_at, "Source recheck checked_at");
  requireCondition(checkedAt.getTime() <= evaluationInstant.getTime() + policy.evidence.maximumFutureSkewMinutes * 60_000, "Source recheck is too far in the future.");
  const stale = evaluationInstant.getTime() - checkedAt.getTime() > policy.acceptance.sourceIdentityRecheckWithinDays * DAY_MS;
  if (stale) blockers.add("source-recheck-stale");
  const booleans = [recheck.program_url_reachable, recheck.service_identity_matches, recheck.artifact_hashes_match, recheck.limitations_acknowledged];
  requireCondition(booleans.every((value) => typeof value === "boolean"), "Source recheck decisions must be boolean.");
  const complete = qualifyingChartReviewers.has(recheck.reviewer_key) && booleans.every(Boolean);
  if (!complete) blockers.add("source-recheck-incomplete");
  return complete && !stale;
}

export function evaluateSantaBarbaraStructureDepthReview({
  policy,
  catalog,
  artifact,
  sourcePolicy,
  guide,
  policySource,
  catalogSource,
  artifactSource,
  sourcePolicySource,
  sourceSnapshotSource,
  collectorSource,
  evidence,
  evidenceSource,
  expectedCommit,
  evaluatedAt = new Date(),
}) {
  validateSantaBarbaraStructureDepthReview({ policy, catalog, artifact, sourcePolicy, guide, policySource, catalogSource, artifactSource, sourcePolicySource, sourceSnapshotSource, collectorSource });
  strictCommit(expectedCommit, "Expected commit");
  const evaluationInstant = evaluatedAt instanceof Date ? evaluatedAt : canonicalInstant(evaluatedAt, "Evaluation time");
  requireCondition(!Number.isNaN(evaluationInstant.getTime()), "Evaluation time is invalid.");
  requireExactKeys(evidence, EVIDENCE_KEYS, "Private review evidence");
  requireCondition(evidence.schema_version === EVIDENCE_SCHEMA, "Private evidence schema version drifted.");
  requireCondition(evidence.reviewed_commit === expectedCommit, "Private evidence commit does not match the expected commit.");
  requireCondition(evidence.catalog_sha256 === sha256(catalogSource), "Private evidence catalog digest drifted.");
  requireCondition(evidence.structure_depth_artifact_sha256 === sha256(artifactSource), "Private evidence structure/depth artifact digest drifted.");
  requireCondition(evidence.structure_depth_policy_sha256 === sha256(sourcePolicySource), "Private evidence source-policy digest drifted.");
  requireCondition(evidence.review_policy_sha256 === sha256(policySource), "Private evidence review-policy digest drifted.");
  requireCondition(evidence.score_use_authorized === false && evidence.navigation_use_authorized === false && evidence.deployment_authorization_granted === false && evidence.model_validation_evidence_granted === false, "Private evidence cannot authorize product or deployment use.");
  requireCondition(Buffer.isBuffer(evidenceSource) || typeof evidenceSource === "string", "Private evidence source bytes are required.");

  const siteIds = new Set(policy.sites.map(({ siteId }) => siteId));
  const maximumResponses = siteIds.size * policy.evidence.maximumResponsesPerSiteAndRole;
  requireCondition(Array.isArray(evidence.local_responses) && evidence.local_responses.length <= maximumResponses, "Local response count exceeds the policy boundary.");
  requireCondition(Array.isArray(evidence.chart_responses) && evidence.chart_responses.length <= maximumResponses, "Chart response count exceeds the policy boundary.");
  const responseIds = [...evidence.local_responses, ...evidence.chart_responses].map(({ response_id: responseId }) => responseId);
  requireCondition(new Set(responseIds).size === responseIds.length, "Response IDs must be unique across roles.");

  const localMetadata = evidence.local_responses.map((response) => validateLocalResponse(response, policy, siteIds, evaluationInstant));
  const chartMetadata = evidence.chart_responses.map((response) => validateChartResponse(response, policy, siteIds, evaluationInstant));
  const localPairs = evidence.local_responses.map(({ site_id: siteId, reviewer_key: reviewerKey }) => `${siteId}:${reviewerKey}`);
  const chartPairs = evidence.chart_responses.map(({ site_id: siteId, reviewer_key: reviewerKey }) => `${siteId}:${reviewerKey}`);
  requireCondition(new Set(localPairs).size === localPairs.length, "A local reviewer may submit only one response per site.");
  requireCondition(new Set(chartPairs).size === chartPairs.length, "A chart reviewer may submit only one response per site.");

  const blockers = new Set();
  if (localMetadata.some(({ stale }) => stale)) blockers.add("local-response-stale");
  if (chartMetadata.some(({ stale }) => stale)) blockers.add("chart-review-stale");
  const unresolvedCorrections = [...localMetadata, ...chartMetadata].filter(({ correctionNeeded }) => correctionNeeded);
  if (unresolvedCorrections.length > policy.acceptance.maximumUnresolvedCorrections) blockers.add("unresolved-corrections");

  const qualifyingLocal = localMetadata.filter(({ qualifying }) => qualifying);
  const qualifyingChart = chartMetadata.filter(({ qualifying }) => qualifying);
  const localReviewers = new Set(qualifyingLocal.map(({ reviewerKey }) => reviewerKey));
  const chartReviewers = new Set(qualifyingChart.map(({ reviewerKey }) => reviewerKey));
  if (localReviewers.size < policy.acceptance.minimumDistinctLocalReviewersAcrossRegion) blockers.add("distinct-local-reviewers-insufficient");
  if (chartReviewers.size < policy.acceptance.minimumDistinctChartReviewersAcrossRegion) blockers.add("distinct-chart-reviewers-insufficient");
  if ([...new Set(localMetadata.map(({ reviewerKey }) => reviewerKey))].some((key) => new Set(chartMetadata.map(({ reviewerKey }) => reviewerKey)).has(key))) blockers.add("reviewer-role-overlap");

  const passingLocalSites = policy.sites.filter((site) => new Set(qualifyingLocal.filter(({ siteId }) => siteId === site.siteId).map(({ reviewerKey }) => reviewerKey)).size >= policy.acceptance.minimumLocalReviewsPerSite);
  const passingChartSites = policy.sites.filter((site) => new Set(qualifyingChart.filter(({ siteId }) => siteId === site.siteId).map(({ reviewerKey }) => reviewerKey)).size >= policy.acceptance.minimumChartReviewsPerSite);
  if (passingLocalSites.length !== policy.sites.length) blockers.add("local-responses-incomplete");
  if (passingChartSites.length !== policy.sites.length) blockers.add("chart-responses-incomplete");
  const passingLocalIds = new Set(passingLocalSites.map(({ siteId }) => siteId));
  const passingChartIds = new Set(passingChartSites.map(({ siteId }) => siteId));
  const passingSites = policy.sites.filter(({ siteId }) => passingLocalIds.has(siteId) && passingChartIds.has(siteId));
  const sourceIdentityRecheckCurrent = validateSourceRecheck(evidence.source_identity_recheck, policy, chartReviewers, evaluationInstant, blockers);

  const orderedBlockers = BLOCKER_CODES.filter((code) => blockers.has(code));
  const accepted = orderedBlockers.length === 0 && passingSites.length === policy.sites.length && sourceIdentityRecheckCurrent;
  const receipt = {
    schema_version: RECEIPT_SCHEMA,
    evaluated_at: evaluationInstant.toISOString(),
    reviewed_commit: expectedCommit,
    catalog_sha256: evidence.catalog_sha256,
    structure_depth_artifact_sha256: evidence.structure_depth_artifact_sha256,
    structure_depth_policy_sha256: evidence.structure_depth_policy_sha256,
    review_policy_sha256: evidence.review_policy_sha256,
    private_evidence_sha256: sha256(evidenceSource),
    read_only: true,
    provider_query_performed: false,
    production_change_authorized: false,
    local_response_count: evidence.local_responses.length,
    qualifying_local_response_count: qualifyingLocal.length,
    chart_response_count: evidence.chart_responses.length,
    qualifying_chart_response_count: qualifyingChart.length,
    distinct_local_reviewer_count: localReviewers.size,
    distinct_chart_reviewer_count: chartReviewers.size,
    site_count: policy.sites.length,
    passing_local_site_count: passingLocalSites.length,
    passing_chart_site_count: passingChartSites.length,
    passing_site_count: passingSites.length,
    unresolved_correction_count: unresolvedCorrections.length,
    source_identity_recheck_current: sourceIdentityRecheckCurrent,
    raw_response_disposal_due_at: new Date(evaluationInstant.getTime() + policy.storage.rawResponseRetentionDaysAfterDecision * DAY_MS).toISOString(),
    structure_depth_review_accepted: accepted,
    score_use_authorized: false,
    navigation_use_authorized: false,
    deployment_authorization_granted: false,
    model_validation_evidence_granted: false,
    blockers: orderedBlockers,
  };
  requireExactKeys(receipt, policy.publicReceipt.allowedFields, "Public receipt");
  return receipt;
}

async function loadReviewSources(root = DEFAULT_ROOT) {
  const [policySource, catalogSource, artifactSource, sourcePolicySource, sourceSnapshotSource, collectorSource, guide] = await Promise.all([
    readFile(resolve(root, "field-review/santa-barbara-structure-depth-review-policy.json")),
    readFile(resolve(root, "data/sites.json")),
    readFile(resolve(root, "public/data/structure-depth.json")),
    readFile(resolve(root, "structure-depth/policy.json")),
    readFile(resolve(root, "structure-depth/noaa-enc-approach-snapshot.json")),
    readFile(resolve(root, "scripts/refresh_structure_depth.py")),
    readFile(resolve(root, "docs/SANTA-BARBARA-STRUCTURE-DEPTH-REVIEW.md"), "utf8"),
  ]);
  return {
    policy: JSON.parse(policySource.toString("utf8")),
    catalog: JSON.parse(catalogSource.toString("utf8")),
    artifact: JSON.parse(artifactSource.toString("utf8")),
    sourcePolicy: JSON.parse(sourcePolicySource.toString("utf8")),
    guide,
    policySource,
    catalogSource,
    artifactSource,
    sourcePolicySource,
    sourceSnapshotSource,
    collectorSource,
  };
}

async function privateTemplateOutputPath(root, outputFile) {
  requireCondition(typeof outputFile === "string" && isAbsolute(outputFile), "Template output path must be absolute.");
  const normalizedOutput = resolve(outputFile);
  requireCondition(normalizedOutput === outputFile, "Template output path must already be normalized.");
  const rootReal = await realpath(root);
  const parent = dirname(normalizedOutput);
  const parentMetadata = await lstat(parent).catch(() => null);
  requireCondition(parentMetadata?.isDirectory() && !parentMetadata.isSymbolicLink(), "Template output directory must be an existing non-symlink directory.");
  const parentReal = await realpath(parent);
  requireCondition(parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`), "Template output must remain outside the repository checkout.");
  requireCondition((parentMetadata.mode & 0o077) === 0, "Template output directory must not grant group or other permissions.");
  if (typeof process.getuid === "function") requireCondition(parentMetadata.uid === process.getuid(), "Template output directory must be owned by the current user.");
  return resolve(parentReal, basename(normalizedOutput));
}

export async function writeSantaBarbaraStructureDepthReviewTemplate({ root = DEFAULT_ROOT, reviewedCommit, outputFile, sources }) {
  const outputPath = await privateTemplateOutputPath(root, outputFile);
  const reviewSources = sources ?? await loadReviewSources(root);
  const payload = createSantaBarbaraStructureDepthReviewTemplate({ ...reviewSources, reviewedCommit });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const expectedBytes = Buffer.byteLength(body);
  let handle;
  try {
    handle = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Template output file must not already exist.");
    throw new Error("Template output file could not be created safely.");
  }
  let complete = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    const metadata = await handle.stat();
    requireCondition(metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600 && (typeof process.getuid !== "function" || metadata.uid === process.getuid()) && metadata.size === expectedBytes, "Template output file did not preserve the required private mode.");
    complete = true;
  } finally {
    try {
      await handle.close();
    } finally {
      if (!complete) await unlink(outputPath).catch(() => undefined);
    }
  }
  return {
    schema_version: WRITE_RECEIPT_SCHEMA,
    reviewed_commit: payload.reviewed_commit,
    catalog_sha256: payload.catalog_sha256,
    structure_depth_artifact_sha256: payload.structure_depth_artifact_sha256,
    review_policy_sha256: payload.review_policy_sha256,
    site_count: reviewSources.policy.sites.length,
    owner_only_file_written: true,
    existing_file_overwritten: false,
    structure_depth_review_accepted: false,
    score_use_authorized: false,
    navigation_use_authorized: false,
    deployment_authorization_granted: false,
    model_validation_evidence_granted: false,
  };
}

export async function verifySantaBarbaraStructureDepthReview(root = DEFAULT_ROOT) {
  const sources = await loadReviewSources(root);
  return validateSantaBarbaraStructureDepthReview(sources);
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  requireCondition(index >= 0 && typeof args[index + 1] === "string" && !args[index + 1].startsWith("--"), `${name} is required.`);
  return args[index + 1];
}

async function main() {
  const command = process.argv[2] ?? "verify-policy";
  const args = process.argv.slice(3);
  const sources = await loadReviewSources();
  if (command === "verify-policy") {
    requireCondition(args.length === 0, "verify-policy does not accept arguments.");
    process.stdout.write(`${JSON.stringify(validateSantaBarbaraStructureDepthReview(sources), null, 2)}\n`);
    return;
  }
  if (command === "print-template") {
    requireCondition(args.length === 2, "print-template requires only --expected-commit.");
    const reviewedCommit = parseFlag(args, "--expected-commit");
    process.stdout.write(`${JSON.stringify(createSantaBarbaraStructureDepthReviewTemplate({ ...sources, reviewedCommit }), null, 2)}\n`);
    return;
  }
  if (command === "write-template") {
    requireCondition(args.length === 4, "write-template requires --output-file and --expected-commit.");
    const outputFile = parseFlag(args, "--output-file");
    const reviewedCommit = parseFlag(args, "--expected-commit");
    const receipt = await writeSantaBarbaraStructureDepthReviewTemplate({ sources, reviewedCommit, outputFile });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (command === "evaluate") {
    requireCondition(args.length === 4, "evaluate requires --evidence-file and --expected-commit.");
    const evidenceFile = parseFlag(args, "--evidence-file");
    const expectedCommit = parseFlag(args, "--expected-commit");
    const evidenceSource = await requirePrivateEvidenceFile(DEFAULT_ROOT, evidenceFile);
    const receipt = evaluateSantaBarbaraStructureDepthReview({
      ...sources,
      evidence: JSON.parse(evidenceSource.toString("utf8")),
      evidenceSource,
      expectedCommit,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!receipt.structure_depth_review_accepted) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: verify-santa-barbara-structure-depth-review.mjs verify-policy | print-template --expected-commit <sha> | write-template --output-file <absolute-path> --expected-commit <sha> | evaluate --evidence-file <absolute-path> --expected-commit <sha>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
