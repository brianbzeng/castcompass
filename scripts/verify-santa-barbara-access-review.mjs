#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGION_NAMES = new Set(["Gaviota Coast", "Goleta", "Santa Barbara", "Summerland", "Carpinteria"]);
const POLICY_SCHEMA = "castingcompass.santa-barbara-access-review/1.2.0";
const EVIDENCE_SCHEMA = "castingcompass.santa-barbara-access-review-evidence/1.0.0";
const RECEIPT_SCHEMA = "castingcompass.santa-barbara-access-review-receipt/1.0.0";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const DAY_MS = 86_400_000;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const TOP_LEVEL_KEYS = [
  "acceptance",
  "allowedPrivateResponseFields",
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
  "status",
  "storage",
];
const SITE_KEYS = [
  "accessSourceUrl",
  "catalogAccessStatus",
  "catalogAccessStatusUpdatedAt",
  "minimumLocalReviews",
  "name",
  "region",
  "regulationUrl",
  "reviewState",
  "siteId",
];
const RESPONSE_KEYS = [
  "correction_category",
  "generalized_correction",
  "observed_month",
  "question_answers",
  "response_id",
  "reviewer_key",
  "site_id",
];
const RECHECK_KEYS = [
  "access_source_reachable",
  "access_source_supports_catalog",
  "checked_at",
  "corrections_resolved",
  "regulation_source_reachable",
  "regulation_source_supports_catalog",
  "site_id",
];
const EVIDENCE_KEYS = [
  "catalog_sha256",
  "deployment_authorization_granted",
  "model_validation_evidence_granted",
  "official_source_rechecks",
  "policy_sha256",
  "responses",
  "reviewed_commit",
  "safety_or_legality_guarantee_granted",
  "schema_version",
];
const RECEIPT_FIELDS = [
  "schema_version",
  "evaluated_at",
  "reviewed_commit",
  "catalog_sha256",
  "policy_sha256",
  "private_evidence_sha256",
  "read_only",
  "provider_query_performed",
  "production_change_authorized",
  "response_count",
  "qualifying_response_count",
  "distinct_reviewer_count",
  "site_count",
  "passing_site_count",
  "blocked_site_count",
  "unresolved_correction_count",
  "official_rechecks_current",
  "raw_response_disposal_due_at",
  "access_review_accepted",
  "deployment_authorization_granted",
  "model_validation_evidence_granted",
  "safety_or_legality_guarantee_granted",
  "blockers",
];
const BLOCKER_CODES = [
  "distinct-reviewers-insufficient",
  "official-recheck-incomplete",
  "official-recheck-stale",
  "response-outside-recency-window",
  "responses-incomplete",
  "unresolved-corrections",
];
const RESPONSE_STATES = ["matches_catalog", "correction_needed", "not_observed", "uncertain"];
const QUESTION_IDS = [
  "public_entry_route",
  "access_status",
  "parking_walk",
  "posted_restrictions",
  "boundary_clarity",
];
const CORRECTION_CATEGORIES = ["access", "status", "parking_walk", "restriction", "boundary"];
const OFFICIAL_ACCESS_HOSTS = new Set([
  "www.parks.ca.gov",
  "www.cityofgoleta.org",
  "www.countyofsb.org",
  "sbparksandrec.santabarbaraca.gov",
  "santabarbaraca.gov",
  "wildlife.ca.gov",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function requireExactKeys(value, expected, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  requireCondition(
    JSON.stringify(sortedKeys(value)) === JSON.stringify([...expected].sort()),
    `${label} keys do not match the locked contract.`,
  );
}

function requireUniqueStrings(values, label) {
  requireCondition(Array.isArray(values) && values.every((value) => typeof value === "string" && value.length > 0), `${label} must contain nonempty strings.`);
  requireCondition(new Set(values).size === values.length, `${label} must not contain duplicates.`);
}

function officialUrl(value, allowedHosts, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  requireCondition(parsed.protocol === "https:", `${label} must use HTTPS.`);
  requireCondition(allowedHosts.has(parsed.hostname), `${label} must use a declared official host.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

export function validateSantaBarbaraAccessReview({ policy, catalog, guide }) {
  requireExactKeys(policy, TOP_LEVEL_KEYS, "Review policy");
  requireCondition(policy.schemaVersion === POLICY_SCHEMA, "Review policy schema version is not locked.");
  requireCondition(policy.status === "template_only_not_executed", "Committed review policy must remain unexecuted.");
  requireCondition(/^\d{4}-\d{2}-\d{2}$/u.test(policy.reviewedOn), "Policy review date must be YYYY-MM-DD.");
  requireExactKeys(policy.geography, ["expectedSiteCount", "label", "scope"], "Review geography");
  requireCondition(policy.geography.label === "Santa Barbara South Coast", "Review geography label changed.");
  requireCondition(policy.geography.scope === "Gaviota through Rincon", "Review geography scope changed.");
  requireCondition(policy.geography.expectedSiteCount === 14, "Review geography must contain 14 sites.");

  requireExactKeys(policy.storage, [
    "privateEvidenceDigestRequiredForAggregateReceipt",
    "rawResponseRetentionDaysAfterDecision",
    "repositoryState",
    "responseLocation",
  ], "Review storage policy");
  requireCondition(policy.storage.responseLocation === "private_outside_repository", "Responses must remain private and outside the repository.");
  requireCondition(policy.storage.repositoryState === "blank_policy_and_aggregate_receipt_only", "Repository response boundary changed.");
  requireCondition(policy.storage.rawResponseRetentionDaysAfterDecision === 30, "Raw response retention must remain 30 days after a decision.");
  requireCondition(policy.storage.privateEvidenceDigestRequiredForAggregateReceipt === true, "Aggregate receipts must bind private evidence by digest.");

  const expectedAllowedFields = [
    "site_id",
    "response_id",
    "reviewer_key",
    "observed_month",
    "question_answers",
    "correction_category",
    "generalized_correction",
  ];
  const expectedProhibitedFields = [
    "reviewer_name",
    "contact_information",
    "account_or_user_id",
    "exact_visit_timestamp",
    "precise_coordinates",
    "catch_or_trip_outcomes",
    "trip_notes",
    "photos_or_video",
    "credentials_or_tokens",
    "private_access_directions",
  ];
  requireUniqueStrings(policy.allowedPrivateResponseFields, "Allowed response fields");
  requireUniqueStrings(policy.prohibitedFields, "Prohibited response fields");
  requireCondition(JSON.stringify(policy.allowedPrivateResponseFields) === JSON.stringify(expectedAllowedFields), "Allowed private response fields changed.");
  requireCondition(JSON.stringify(policy.prohibitedFields) === JSON.stringify(expectedProhibitedFields), "Prohibited response fields changed.");
  requireCondition(JSON.stringify(policy.responseStates) === JSON.stringify(RESPONSE_STATES), "Review response states changed.");

  requireExactKeys(policy.evidence, [
    "maximumFileBytes",
    "maximumFutureSkewMinutes",
    "maximumObservedMonthAgeMonths",
    "maximumResponsesPerSite",
    "schemaVersion",
  ], "Private evidence policy");
  requireCondition(policy.evidence.schemaVersion === EVIDENCE_SCHEMA, "Private evidence schema version is not locked.");
  requireCondition(policy.evidence.maximumFileBytes === 262144, "Private evidence size limit changed.");
  requireCondition(policy.evidence.maximumResponsesPerSite === 10, "Per-site response limit changed.");
  requireCondition(policy.evidence.maximumObservedMonthAgeMonths === 6, "Observation recency limit changed.");
  requireCondition(policy.evidence.maximumFutureSkewMinutes === 5, "Future timestamp tolerance changed.");

  requireExactKeys(policy.publicReceipt, ["allowedFields", "blockerCodes", "schemaVersion"], "Public receipt policy");
  requireCondition(policy.publicReceipt.schemaVersion === RECEIPT_SCHEMA, "Public receipt schema version is not locked.");
  requireCondition(JSON.stringify(policy.publicReceipt.allowedFields) === JSON.stringify(RECEIPT_FIELDS), "Public receipt fields changed.");
  requireCondition(JSON.stringify(policy.publicReceipt.blockerCodes) === JSON.stringify(BLOCKER_CODES), "Public receipt blocker codes changed.");

  requireCondition(Array.isArray(policy.questions) && policy.questions.length === QUESTION_IDS.length, "Review policy must contain five questions.");
  requireCondition(JSON.stringify(policy.questions.map(({ id }) => id)) === JSON.stringify(QUESTION_IDS), "Review question IDs changed.");
  for (const question of policy.questions) {
    requireExactKeys(question, ["id", "prompt"], `Question ${question.id}`);
    requireCondition(typeof question.prompt === "string" && question.prompt.endsWith("?"), `Question ${question.id} must be a question.`);
    requireCondition(!/(?:name|email|phone|account (?:id|identifier)|exact time|coordinate|photo|catch|trip note)/iu.test(question.prompt), `Question ${question.id} requests prohibited data.`);
  }

  requireExactKeys(policy.acceptance, [
    "deploymentAuthorizationGranted",
    "maximumUnresolvedCorrections",
    "minimumDistinctReviewersAcrossRegion",
    "minimumReviewsForLimitedSite",
    "minimumReviewsForOpenSite",
    "modelValidationEvidenceGranted",
    "officialSourceRecheckWithinDays",
    "safetyOrLegalityGuaranteeGranted",
  ], "Review acceptance policy");
  requireCondition(policy.acceptance.minimumDistinctReviewersAcrossRegion === 2, "Regional review requires two distinct reviewers.");
  requireCondition(policy.acceptance.minimumReviewsForOpenSite === 1, "Open sites require one local review.");
  requireCondition(policy.acceptance.minimumReviewsForLimitedSite === 2, "Limited sites require two local reviews.");
  requireCondition(policy.acceptance.officialSourceRecheckWithinDays === 7, "Official sources must be rechecked within seven days.");
  requireCondition(policy.acceptance.maximumUnresolvedCorrections === 0, "Unresolved corrections must fail closed.");
  requireCondition(policy.acceptance.deploymentAuthorizationGranted === false, "The review policy cannot authorize deployment.");
  requireCondition(policy.acceptance.modelValidationEvidenceGranted === false, "The review policy cannot create validation evidence.");
  requireCondition(policy.acceptance.safetyOrLegalityGuaranteeGranted === false, "The review policy cannot guarantee safety or legality.");

  const allSites = Array.isArray(catalog.sites) ? catalog.sites : catalog;
  requireCondition(Array.isArray(allSites), "Site catalog must contain a sites array.");
  const regionalSites = allSites.filter((site) => REGION_NAMES.has(site.region));
  requireCondition(regionalSites.length === policy.geography.expectedSiteCount, "Regional catalog count does not match the review policy.");
  requireCondition(Array.isArray(policy.sites) && policy.sites.length === regionalSites.length, "Review site count does not match the catalog.");
  requireUniqueStrings(policy.sites.map(({ siteId }) => siteId), "Review site IDs");
  requireCondition(
    JSON.stringify(policy.sites.map(({ siteId }) => siteId).sort()) === JSON.stringify(regionalSites.map(({ id }) => id).sort()),
    "Review policy site population does not exactly match the Santa Barbara catalog.",
  );

  const catalogById = new Map(regionalSites.map((site) => [site.id, site]));
  let limitedSiteCount = 0;
  for (const reviewSite of policy.sites) {
    requireExactKeys(reviewSite, SITE_KEYS, `Review site ${reviewSite.siteId}`);
    const catalogSite = catalogById.get(reviewSite.siteId);
    requireCondition(Boolean(catalogSite), `Unknown review site ${reviewSite.siteId}.`);
    requireCondition(reviewSite.name === catalogSite.name, `${reviewSite.siteId} name drifted from the catalog.`);
    requireCondition(reviewSite.region === catalogSite.region, `${reviewSite.siteId} region drifted from the catalog.`);
    requireCondition(reviewSite.catalogAccessStatus === catalogSite.accessStatus, `${reviewSite.siteId} access status drifted from the catalog.`);
    requireCondition(reviewSite.catalogAccessStatusUpdatedAt === catalogSite.accessStatusUpdatedAt, `${reviewSite.siteId} access review date drifted from the catalog.`);
    requireCondition(reviewSite.accessSourceUrl === catalogSite.accessSourceUrl, `${reviewSite.siteId} access source drifted from the catalog.`);
    requireCondition(reviewSite.regulationUrl === catalogSite.regulationUrl, `${reviewSite.siteId} regulation source drifted from the catalog.`);
    officialUrl(reviewSite.accessSourceUrl, OFFICIAL_ACCESS_HOSTS, `${reviewSite.siteId} access source`);
    officialUrl(reviewSite.regulationUrl, new Set(["wildlife.ca.gov"]), `${reviewSite.siteId} regulation source`);
    requireCondition(["open", "limited"].includes(reviewSite.catalogAccessStatus), `${reviewSite.siteId} has an unsupported catalog status.`);
    const expectedReviews = reviewSite.catalogAccessStatus === "limited" ? 2 : 1;
    requireCondition(reviewSite.minimumLocalReviews === expectedReviews, `${reviewSite.siteId} has the wrong local-review threshold.`);
    requireCondition(reviewSite.reviewState === "pending", `${reviewSite.siteId} cannot be pre-accepted in the committed policy.`);
    if (reviewSite.catalogAccessStatus === "limited") limitedSiteCount += 1;
    requireCondition(guide.includes(`\`${reviewSite.siteId}\``), `${reviewSite.siteId} is missing from the reviewer guide.`);
    requireCondition(guide.includes(`**${reviewSite.name}**`), `${reviewSite.name} is missing from the reviewer guide.`);
  }
  requireCondition(limitedSiteCount === 5, "Expected exactly five limited-access sites requiring two reviews.");

  for (const questionId of QUESTION_IDS) {
    requireCondition(guide.includes(`${questionId}: matches_catalog | correction_needed | not_observed | uncertain`), `Reviewer guide response block is missing ${questionId}.`);
  }
  requireCondition(/random pseudonymous reviewer key/iu.test(guide), "Reviewer guide must explain the pseudonymous reviewer key.");
  requireCondition(/no review has been conducted or accepted/iu.test(guide), "Reviewer guide must state that execution is still open.");
  requireCondition(/does not authorize a deployment/iu.test(guide), "Reviewer guide must preserve the deployment gate.");
  requireCondition(/outside Git and\s+outside Codex/iu.test(guide), "Reviewer guide must keep raw responses outside Git and Codex.");

  return {
    schemaVersion: policy.schemaVersion,
    status: policy.status,
    siteCount: policy.sites.length,
    limitedSiteCount,
    questionCount: policy.questions.length,
    deploymentAuthorizationGranted: policy.acceptance.deploymentAuthorizationGranted,
    modelValidationEvidenceGranted: policy.acceptance.modelValidationEvidenceGranted,
  };
}

function validateResponse(response, policy, siteIds) {
  requireExactKeys(response, RESPONSE_KEYS, `Response ${response?.response_id ?? "unknown"}`);
  requireCondition(siteIds.has(response.site_id), `Response ${response.response_id} uses an unknown site.`);
  requireCondition(UUID_V4_PATTERN.test(response.response_id ?? ""), "Response ID must be a UUIDv4.");
  requireCondition(UUID_V4_PATTERN.test(response.reviewer_key ?? ""), "Reviewer key must be a random pseudonymous UUIDv4.");
  requireCondition(response.observed_month === "not_observed" || MONTH_PATTERN.test(response.observed_month ?? ""), "Observed month must be YYYY-MM or not_observed.");
  requireExactKeys(response.question_answers, QUESTION_IDS, `Response ${response.response_id} answers`);
  const answers = Object.values(response.question_answers);
  requireCondition(answers.every((answer) => RESPONSE_STATES.includes(answer)), `Response ${response.response_id} contains an unknown answer state.`);
  if (response.observed_month === "not_observed") {
    requireCondition(answers.every((answer) => answer === "not_observed"), `Response ${response.response_id} marked not_observed must use that state for every answer.`);
  }
  const correctionNeeded = answers.includes("correction_needed");
  if (correctionNeeded) {
    requireCondition(CORRECTION_CATEGORIES.includes(response.correction_category), `Response ${response.response_id} requires a correction category.`);
    requireCondition(safeCorrection(response.generalized_correction), `Response ${response.response_id} correction is unsafe or exceeds the privacy boundary.`);
  } else {
    requireCondition(response.correction_category === null && response.generalized_correction === null, `Response ${response.response_id} must omit correction detail when no correction is requested.`);
  }
  return { answers, correctionNeeded };
}

function validateRecheck(recheck, siteIds, evaluatedAt, maximumFutureSkewMinutes) {
  requireExactKeys(recheck, RECHECK_KEYS, `Official recheck ${recheck?.site_id ?? "unknown"}`);
  requireCondition(siteIds.has(recheck.site_id), `Official recheck uses unknown site ${recheck.site_id}.`);
  const checkedAt = canonicalInstant(recheck.checked_at, `Official recheck ${recheck.site_id}`);
  requireCondition(
    checkedAt.getTime() <= evaluatedAt.getTime() + maximumFutureSkewMinutes * 60_000,
    `Official recheck ${recheck.site_id} is too far in the future.`,
  );
  for (const field of RECHECK_KEYS.filter((key) => !["site_id", "checked_at"].includes(key))) {
    requireCondition(typeof recheck[field] === "boolean", `Official recheck ${recheck.site_id} field ${field} must be boolean.`);
  }
  return checkedAt;
}

export function createSantaBarbaraAccessReviewTemplate({
  policy,
  catalog,
  guide,
  reviewedCommit,
  policySource,
  catalogSource,
}) {
  requireCondition(isDeepStrictEqual(policy, JSON.parse(Buffer.from(policySource).toString("utf8"))), "Review policy object does not match its source bytes.");
  requireCondition(isDeepStrictEqual(catalog, JSON.parse(Buffer.from(catalogSource).toString("utf8"))), "Site catalog object does not match its source bytes.");
  validateSantaBarbaraAccessReview({ policy, catalog, guide });
  strictCommit(reviewedCommit);
  return {
    schema_version: EVIDENCE_SCHEMA,
    reviewed_commit: reviewedCommit,
    catalog_sha256: sha256(catalogSource),
    policy_sha256: sha256(policySource),
    responses: [],
    official_source_rechecks: policy.sites.map(({ siteId }) => ({
      site_id: siteId,
      checked_at: "1970-01-01T00:00:00.000Z",
      access_source_reachable: false,
      access_source_supports_catalog: false,
      regulation_source_reachable: false,
      regulation_source_supports_catalog: false,
      corrections_resolved: false,
    })),
    deployment_authorization_granted: false,
    model_validation_evidence_granted: false,
    safety_or_legality_guarantee_granted: false,
  };
}

export function evaluateSantaBarbaraAccessReview({
  policy,
  catalog,
  guide,
  evidence,
  evidenceSource,
  policySource,
  catalogSource,
  expectedCommit,
  evaluatedAt = new Date(),
}) {
  requireCondition(isDeepStrictEqual(policy, JSON.parse(Buffer.from(policySource).toString("utf8"))), "Review policy object does not match its source bytes.");
  requireCondition(isDeepStrictEqual(catalog, JSON.parse(Buffer.from(catalogSource).toString("utf8"))), "Site catalog object does not match its source bytes.");
  validateSantaBarbaraAccessReview({ policy, catalog, guide });
  strictCommit(expectedCommit, "Expected commit");
  const evaluationInstant = evaluatedAt instanceof Date ? evaluatedAt : canonicalInstant(evaluatedAt, "Evaluation time");
  requireCondition(!Number.isNaN(evaluationInstant.getTime()), "Evaluation time is invalid.");
  const evidenceBytes = Buffer.isBuffer(evidenceSource) ? evidenceSource : Buffer.from(evidenceSource ?? "", "utf8");
  requireCondition(evidenceBytes.length > 0 && evidenceBytes.length <= policy.evidence.maximumFileBytes, "Private evidence file exceeds its size boundary or is empty.");
  requireCondition(isDeepStrictEqual(evidence, JSON.parse(evidenceBytes.toString("utf8"))), "Private evidence object does not match its source bytes.");
  requireExactKeys(evidence, EVIDENCE_KEYS, "Private evidence");
  requireCondition(evidence.schema_version === EVIDENCE_SCHEMA, "Private evidence schema version is not locked.");
  requireCondition(evidence.reviewed_commit === expectedCommit, "Private evidence is not bound to the expected commit.");
  requireCondition(SHA256_PATTERN.test(evidence.catalog_sha256 ?? "") && evidence.catalog_sha256 === sha256(catalogSource), "Private evidence catalog digest does not match this checkout.");
  requireCondition(SHA256_PATTERN.test(evidence.policy_sha256 ?? "") && evidence.policy_sha256 === sha256(policySource), "Private evidence policy digest does not match this checkout.");
  requireCondition(evidence.deployment_authorization_granted === false, "Private access evidence cannot authorize deployment.");
  requireCondition(evidence.model_validation_evidence_granted === false, "Private access evidence cannot create model validation evidence.");
  requireCondition(evidence.safety_or_legality_guarantee_granted === false, "Private access evidence cannot guarantee safety or legality.");
  requireCondition(Array.isArray(evidence.responses), "Private evidence responses must be an array.");
  requireCondition(Array.isArray(evidence.official_source_rechecks), "Private evidence official rechecks must be an array.");

  const siteIds = new Set(policy.sites.map(({ siteId }) => siteId));
  const responseIds = new Set();
  const reviewerSitePairs = new Set();
  const responseCounts = new Map();
  const responseMetadata = [];
  const blockers = new Set();
  const evaluationMonth = monthNumber(evaluationInstant.toISOString().slice(0, 7));

  for (const response of evidence.responses) {
    const metadata = validateResponse(response, policy, siteIds);
    requireCondition(!responseIds.has(response.response_id), `Duplicate response ID ${response.response_id}.`);
    responseIds.add(response.response_id);
    const reviewerSite = `${response.reviewer_key}:${response.site_id}`;
    requireCondition(!reviewerSitePairs.has(reviewerSite), "A reviewer may submit only one response per site.");
    reviewerSitePairs.add(reviewerSite);
    const siteCount = (responseCounts.get(response.site_id) ?? 0) + 1;
    requireCondition(siteCount <= policy.evidence.maximumResponsesPerSite, `Site ${response.site_id} exceeds its response limit.`);
    responseCounts.set(response.site_id, siteCount);

    let monthCurrent = false;
    if (response.observed_month !== "not_observed") {
      const monthAge = evaluationMonth - monthNumber(response.observed_month);
      monthCurrent = monthAge >= 0 && monthAge <= policy.evidence.maximumObservedMonthAgeMonths;
      if (!monthCurrent) blockers.add("response-outside-recency-window");
    }
    const qualifying = monthCurrent
      && metadata.answers.every((answer) => answer === "matches_catalog" || answer === "correction_needed");
    responseMetadata.push({
      correctionNeeded: metadata.correctionNeeded,
      qualifying,
      reviewerKey: response.reviewer_key,
      siteId: response.site_id,
    });
  }

  const rechecks = new Map();
  let staleRecheck = false;
  for (const recheck of evidence.official_source_rechecks) {
    requireCondition(!rechecks.has(recheck.site_id), `Duplicate official recheck for ${recheck.site_id}.`);
    const checkedAt = validateRecheck(recheck, siteIds, evaluationInstant, policy.evidence.maximumFutureSkewMinutes);
    const current = (evaluationInstant.getTime() - checkedAt.getTime()) / DAY_MS <= policy.acceptance.officialSourceRecheckWithinDays;
    if (!current) staleRecheck = true;
    rechecks.set(recheck.site_id, { checkedAt, current, value: recheck });
  }
  if (staleRecheck) blockers.add("official-recheck-stale");

  const supportingRecheck = (siteId) => {
    const entry = rechecks.get(siteId);
    return Boolean(entry?.current
      && entry.value.access_source_reachable
      && entry.value.access_source_supports_catalog
      && entry.value.regulation_source_reachable
      && entry.value.regulation_source_supports_catalog);
  };
  const allOfficialRechecksCurrent = policy.sites.every(({ siteId }) => supportingRecheck(siteId));
  if (!allOfficialRechecksCurrent) blockers.add("official-recheck-incomplete");

  const unresolvedCorrections = responseMetadata.filter(({ correctionNeeded, siteId }) =>
    correctionNeeded && rechecks.get(siteId)?.value.corrections_resolved !== true);
  if (unresolvedCorrections.length > policy.acceptance.maximumUnresolvedCorrections) {
    blockers.add("unresolved-corrections");
  }

  const qualifying = responseMetadata.filter(({ qualifying: isQualifying }) => isQualifying);
  const distinctReviewers = new Set(qualifying.map(({ reviewerKey }) => reviewerKey));
  if (distinctReviewers.size < policy.acceptance.minimumDistinctReviewersAcrossRegion) {
    blockers.add("distinct-reviewers-insufficient");
  }

  const passingSites = policy.sites.filter((site) => {
    const localReviewers = new Set(qualifying
      .filter(({ siteId }) => siteId === site.siteId)
      .map(({ reviewerKey }) => reviewerKey));
    const hasThreshold = localReviewers.size >= site.minimumLocalReviews;
    const hasUnresolvedCorrection = unresolvedCorrections.some(({ siteId }) => siteId === site.siteId);
    return hasThreshold && supportingRecheck(site.siteId) && !hasUnresolvedCorrection;
  }).length;
  if (passingSites !== policy.sites.length) blockers.add("responses-incomplete");

  const orderedBlockers = BLOCKER_CODES.filter((code) => blockers.has(code));
  const accepted = orderedBlockers.length === 0 && passingSites === policy.sites.length;
  const receipt = {
    schema_version: RECEIPT_SCHEMA,
    evaluated_at: evaluationInstant.toISOString(),
    reviewed_commit: expectedCommit,
    catalog_sha256: evidence.catalog_sha256,
    policy_sha256: evidence.policy_sha256,
    private_evidence_sha256: sha256(evidenceBytes),
    read_only: true,
    provider_query_performed: false,
    production_change_authorized: false,
    response_count: evidence.responses.length,
    qualifying_response_count: qualifying.length,
    distinct_reviewer_count: distinctReviewers.size,
    site_count: policy.sites.length,
    passing_site_count: passingSites,
    blocked_site_count: policy.sites.length - passingSites,
    unresolved_correction_count: unresolvedCorrections.length,
    official_rechecks_current: allOfficialRechecksCurrent,
    raw_response_disposal_due_at: new Date(evaluationInstant.getTime() + policy.storage.rawResponseRetentionDaysAfterDecision * DAY_MS).toISOString(),
    access_review_accepted: accepted,
    deployment_authorization_granted: false,
    model_validation_evidence_granted: false,
    safety_or_legality_guarantee_granted: false,
    blockers: orderedBlockers,
  };
  requireExactKeys(receipt, policy.publicReceipt.allowedFields, "Public receipt");
  return receipt;
}

async function loadReviewSources(root = DEFAULT_ROOT) {
  const [policySource, catalogSource, guide] = await Promise.all([
    readFile(resolve(root, "field-review/santa-barbara-access-review-policy.json")),
    readFile(resolve(root, "public/data/sites.json")),
    readFile(resolve(root, "docs/SANTA-BARBARA-LOCAL-ACCESS-REVIEW.md"), "utf8"),
  ]);
  return {
    policy: JSON.parse(policySource.toString("utf8")),
    catalog: JSON.parse(catalogSource.toString("utf8")),
    guide,
    policySource,
    catalogSource,
  };
}

async function privateTemplateOutputPath(root, outputFile) {
  requireCondition(typeof outputFile === "string" && isAbsolute(outputFile), "Template output path must be absolute.");
  const normalizedOutput = resolve(outputFile);
  requireCondition(normalizedOutput === outputFile, "Template output path must already be normalized.");
  const rootReal = await realpath(root);
  const parent = dirname(normalizedOutput);
  const parentMetadata = await lstat(parent).catch(() => null);
  requireCondition(
    parentMetadata?.isDirectory() && !parentMetadata.isSymbolicLink(),
    "Template output directory must be an existing non-symlink directory.",
  );
  const parentReal = await realpath(parent);
  requireCondition(
    parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`),
    "Template output must remain outside the repository checkout.",
  );
  requireCondition(
    (parentMetadata.mode & 0o077) === 0,
    "Template output directory must not grant group or other permissions.",
  );
  if (typeof process.getuid === "function") {
    requireCondition(parentMetadata.uid === process.getuid(), "Template output directory must be owned by the current user.");
  }
  return resolve(parentReal, basename(normalizedOutput));
}

export async function writeSantaBarbaraAccessReviewTemplate({
  root = DEFAULT_ROOT,
  reviewedCommit,
  outputFile,
  sources,
}) {
  const outputPath = await privateTemplateOutputPath(root, outputFile);
  const reviewSources = sources ?? await loadReviewSources(root);
  const payload = createSantaBarbaraAccessReviewTemplate({ ...reviewSources, reviewedCommit });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const expectedBytes = Buffer.byteLength(body);
  let handle;
  try {
    handle = await open(
      outputPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
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
    requireCondition(
      metadata.isFile()
        && metadata.nlink === 1
        && (metadata.mode & 0o777) === 0o600
        && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
        && metadata.size === expectedBytes,
      "Template output file did not preserve the required private mode.",
    );
    complete = true;
  } finally {
    try {
      await handle.close();
    } finally {
      if (!complete) await unlink(outputPath).catch(() => undefined);
    }
  }
  return {
    schema_version: "castingcompass.santa-barbara-access-review-template-write-receipt/1.0.0",
    reviewed_commit: payload.reviewed_commit,
    catalog_sha256: payload.catalog_sha256,
    policy_sha256: payload.policy_sha256,
    site_count: payload.official_source_rechecks.length,
    owner_only_file_written: true,
    existing_file_overwritten: false,
    access_review_accepted: false,
    deployment_authorization_granted: false,
    model_validation_evidence_granted: false,
    safety_or_legality_guarantee_granted: false,
  };
}

export async function verifySantaBarbaraAccessReview(root = DEFAULT_ROOT) {
  const sources = await loadReviewSources(root);
  return validateSantaBarbaraAccessReview(sources);
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  requireCondition(index >= 0 && typeof args[index + 1] === "string" && !args[index + 1].startsWith("--"), `${name} is required.`);
  return args[index + 1];
}

export async function requirePrivateEvidenceFile(root, evidenceFile) {
  requireCondition(typeof evidenceFile === "string" && isAbsolute(evidenceFile), "Private evidence path must be absolute.");
  const suppliedStats = await lstat(evidenceFile);
  requireCondition(suppliedStats.isFile() && !suppliedStats.isSymbolicLink(), "Private evidence must be a regular, non-symlink file.");
  requireCondition(suppliedStats.nlink === 1, "Private evidence must not be hard-linked.");
  requireCondition((suppliedStats.mode & 0o777) === 0o600, "Private evidence permissions must be exactly 0600.");
  if (typeof process.getuid === "function") {
    requireCondition(suppliedStats.uid === process.getuid(), "Private evidence must be owned by the current user.");
  }
  requireCondition(
    suppliedStats.size > 0 && suppliedStats.size <= MAX_EVIDENCE_BYTES,
    "Private evidence file exceeds its size boundary or is empty.",
  );
  const [rootPath, evidencePath] = await Promise.all([realpath(root), realpath(evidenceFile)]);
  requireCondition(evidencePath !== rootPath && !evidencePath.startsWith(`${rootPath}${sep}`), "Private evidence must remain outside the repository.");
  const handle = await open(evidencePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = await handle.stat();
    requireCondition(
      openedStats.isFile()
        && openedStats.dev === suppliedStats.dev
        && openedStats.ino === suppliedStats.ino
        && openedStats.nlink === 1
        && (openedStats.mode & 0o777) === 0o600
        && (typeof process.getuid !== "function" || openedStats.uid === process.getuid())
        && openedStats.size > 0
        && openedStats.size <= MAX_EVIDENCE_BYTES,
      "Private evidence changed while it was being opened.",
    );
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function main() {
  const command = process.argv[2] ?? "verify-policy";
  const args = process.argv.slice(3);
  const sources = await loadReviewSources();
  if (command === "verify-policy") {
    requireCondition(args.length === 0, "verify-policy does not accept arguments.");
    process.stdout.write(`${JSON.stringify(validateSantaBarbaraAccessReview(sources), null, 2)}\n`);
    return;
  }
  if (command === "print-template") {
    requireCondition(args.length === 2, "print-template requires only --expected-commit.");
    const reviewedCommit = parseFlag(args, "--expected-commit");
    const template = createSantaBarbaraAccessReviewTemplate({ ...sources, reviewedCommit });
    process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    return;
  }
  if (command === "write-template") {
    requireCondition(args.length === 4, "write-template requires --output-file and --expected-commit.");
    const outputFile = parseFlag(args, "--output-file");
    const reviewedCommit = parseFlag(args, "--expected-commit");
    const receipt = await writeSantaBarbaraAccessReviewTemplate({
      sources,
      reviewedCommit,
      outputFile,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (command === "evaluate") {
    requireCondition(args.length === 4, "evaluate requires --evidence-file and --expected-commit.");
    const evidenceFile = parseFlag(args, "--evidence-file");
    const expectedCommit = parseFlag(args, "--expected-commit");
    const evidenceSource = await requirePrivateEvidenceFile(DEFAULT_ROOT, evidenceFile);
    const receipt = evaluateSantaBarbaraAccessReview({
      ...sources,
      evidence: JSON.parse(evidenceSource.toString("utf8")),
      evidenceSource,
      expectedCommit,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!receipt.access_review_accepted) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: verify-santa-barbara-access-review.mjs verify-policy | print-template --expected-commit <sha> | write-template --output-file <absolute-path> --expected-commit <sha> | evaluate --evidence-file <absolute-path> --expected-commit <sha>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
