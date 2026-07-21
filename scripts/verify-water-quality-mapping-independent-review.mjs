#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = "contracts/water-quality-mapping-independent-review.schema.json";
const RUNBOOK_PATH = "docs/WATER-QUALITY-MAPPING-INDEPENDENT-REVIEW.md";
const ADVISORY_RUNBOOK_PATH = "docs/WATER-QUALITY-ADVISORY.md";
const PACKAGE_PATH = "package.json";

export const LOCKED_SOURCE_COMMIT = "377dec41c9fc1842c682b7556f2b0a8b1b83e87c";
export const LOCKED_REVIEW_TARGET_SHA256 = "6cb921149782483338f602b5b3df09ae41243e6a05743ae1534a0fe6892d3346";
const LOCKED_CONTRACT_SHA256 = "4124bd5652c58c15a26f727d72700f199e99a767b88f14ac83c1aea4cf848cff";
const REVIEW_SCHEMA_VERSION = "castingcompass.water-quality-mapping-independent-review/1.0.0";
const RECEIPT_SCHEMA_VERSION = "castingcompass.water-quality-mapping-independent-review-receipt/1.0.0";
const POLICY_VERSION = "castingcompass.water-quality-advisory/official-programs-0.5.0";
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_REVIEW_BYTES = 128 * 1024;
const POLICY_REVIEWED_AT = Date.parse("2026-07-21T00:00:00.000Z");
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export const REVIEW_TARGET_INPUTS = Object.freeze([
  Object.freeze({ path: "data/sites.json", sha256: "a7145a66368c6dd5dd13b6bec421d430d228a3082d2fa8ad31941fc84e14078d" }),
  Object.freeze({ path: "public/data/water-quality.json", sha256: "0cfa6842b353fbc42753f0cfe3a4923e35ae4484321102e69b7f148b8676e6c1" }),
  Object.freeze({ path: "water-quality/audits/east-bay-parks-beachwatch-station-mappings.json", sha256: "8e002941c5f757d78367b41c643e269b1841fb754caed6923a340c5638c0c3e9" }),
  Object.freeze({ path: "water-quality/audits/launch-catalog-coverage.json", sha256: "759de44313ecf3e07c7d7827cd6c5eaf78f15ab6966fdffa99d21312d61fff2f" }),
  Object.freeze({ path: "water-quality/audits/marin-beachwatch-station-mappings.json", sha256: "c37c334e1753f1d2b894c20d7030e8c09214425ac59671088ce9794779c65800" }),
  Object.freeze({ path: "water-quality/audits/san-mateo-station-mappings.json", sha256: "b435a55cc2ded36bbb3f80d520e72a6fb13d788f46221792e9216b27cac1a1c4" }),
  Object.freeze({ path: "water-quality/audits/sf-unmapped-station-candidates.json", sha256: "86006d8bac5a91acfd7e42d61f8df6dcb16381c402df5a5a7a7f4285e816fa86" }),
  Object.freeze({ path: "water-quality/policy.json", sha256: "13914b407929b98f804874e04ae4d474a4a6acd0f9d91ce4d25aa44927a65445" }),
]);

export const REVIEW_ROLES = Object.freeze([
  "official_source_mapping_reviewer",
  "public_health_risk_communication_reviewer",
]);

export const REVIEW_CHECKS = Object.freeze([
  "official_directories_and_station_evidence_reviewed",
  "all_61_site_outcomes_reviewed",
  "exact_location_identity_is_required",
  "proximity_alone_never_creates_a_mapping",
  "only_exact_current_actions_may_suppress",
  "absence_stale_unmapped_and_failed_sources_remain_unknown",
  "numeric_score_contribution_remains_disabled",
  "no_clean_water_seafood_safety_or_catch_claim_is_created",
  "source_latency_and_outage_boundaries_fail_closed",
  "no_merge_deployment_or_activation_authority_is_granted",
]);

export const SITE_REVIEW_CHECKS = Object.freeze([
  "official_identity_and_spatial_support_accepted",
  "action_only_and_missing_data_semantics_accepted",
  "no_safety_or_score_authority_accepted",
]);

const REVIEW_FIELDS = Object.freeze([
  "schema_version",
  "review_id",
  "source_commit",
  "review_target_sha256",
  "water_quality_policy_version",
  "reviewed_at",
  "reviewer_role",
  "reviewer_independent_of_implementation",
  "reviewer_competence_evidence_sha256",
  "review_evidence_sha256",
  "disposition",
  "blocking_finding_count",
  "inventory_checklist",
  "site_reviews",
]);

const SITE_REVIEW_FIELDS = Object.freeze([
  "site_id",
  "target_outcome",
  "source_id",
  "station_ids",
  "inherited_global_station_ids",
  ...SITE_REVIEW_CHECKS,
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields or field order are invalid.`);
  }
}

function parseCanonicalJson(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (source !== stableJson(value)) {
    throw new Error(`${label} must use the exact canonical JSON form without duplicate keys.`);
  }
  return value;
}

function parseTrackedJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseTimestamp(value, label) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an exact UTC timestamp with milliseconds.`);
  }
  return parsed;
}

function compileContract(contract) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(contract);
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function readPrivateReviewFile(root, path, label) {
  if (!isAbsolute(path ?? "")) throw new Error(`${label} path must be absolute.`);
  const rootReal = await realpath(root);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
  if (stat.nlink !== 1) throw new Error(`${label} must not be hard-linked.`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must not grant group or other permissions.`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  if (stat.size < 2 || stat.size > MAX_REVIEW_BYTES) throw new Error(`${label} size is invalid.`);
  const fileReal = await realpath(path);
  if (isInside(rootReal, fileReal)) throw new Error(`${label} must remain outside the repository checkout.`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    return {
      source: await handle.readFile("utf8"),
      identity: `${opened.dev}:${opened.ino}`,
      realPath: fileReal,
    };
  } finally {
    await handle.close();
  }
}

async function privateTemplateOutputPath(root, outputFile) {
  if (!isAbsolute(outputFile ?? "")) throw new Error("Template output path must be absolute.");
  const normalizedOutput = resolve(outputFile);
  if (normalizedOutput !== outputFile) throw new Error("Template output path must already be normalized.");
  const rootReal = await realpath(root);
  const parent = dirname(normalizedOutput);
  const parentMetadata = await lstat(parent).catch(() => null);
  if (!parentMetadata || parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Template output directory must be an existing non-symlink directory.");
  }
  const parentReal = await realpath(parent);
  if (isInside(rootReal, parentReal)) throw new Error("Template output must remain outside the repository checkout.");
  if ((parentMetadata.mode & 0o077) !== 0) {
    throw new Error("Template output directory must not grant group or other permissions.");
  }
  if (typeof process.getuid === "function" && parentMetadata.uid !== process.getuid()) {
    throw new Error("Template output directory must be owned by the current user.");
  }
  return resolve(parentReal, basename(normalizedOutput));
}

function assertDigest(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid.`);
}

function exactStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates.`);
  return value;
}

function targetDigest(entries) {
  return sha256(`${entries.map(({ path, sha256: digest }) => `${path}:${digest}`).join("\n")}\n`);
}

export async function loadReviewTarget(root = DEFAULT_ROOT) {
  const sources = await Promise.all(REVIEW_TARGET_INPUTS.map(async (entry) => {
    const source = await readFile(resolve(root, entry.path));
    const actual = sha256(source);
    if (actual !== entry.sha256) throw new Error(`Review target input drifted: ${entry.path}.`);
    return [entry.path, source.toString("utf8")];
  }));
  if (targetDigest(REVIEW_TARGET_INPUTS) !== LOCKED_REVIEW_TARGET_SHA256) {
    throw new Error("Review target aggregate digest is invalid.");
  }
  const inputs = new Map(sources);
  const catalog = parseTrackedJson(inputs.get("data/sites.json"), "Site catalog");
  const overlay = parseTrackedJson(inputs.get("public/data/water-quality.json"), "Public water-quality artifact");
  const coverage = parseTrackedJson(inputs.get("water-quality/audits/launch-catalog-coverage.json"), "Launch-catalog coverage inventory");
  const policy = parseTrackedJson(inputs.get("water-quality/policy.json"), "Water-quality policy");
  if (!Array.isArray(catalog) || catalog.length !== 61) throw new Error("Review target must contain exactly 61 catalog sites.");
  const catalogIds = catalog.map(({ id }) => id).sort(compare);
  if (catalogIds.some((id) => typeof id !== "string") || new Set(catalogIds).size !== 61) {
    throw new Error("Site catalog identities are invalid or duplicated.");
  }
  if (policy.policy_version !== POLICY_VERSION
    || policy.score_contribution !== "excluded-pending-frozen-baseline-validation") {
    throw new Error("Water-quality policy meaning boundary is invalid.");
  }
  if (overlay.policyVersion !== POLICY_VERSION
    || overlay.policySha256 !== REVIEW_TARGET_INPUTS.find(({ path }) => path === "water-quality/policy.json").sha256
    || overlay.siteCatalogSha256 !== REVIEW_TARGET_INPUTS.find(({ path }) => path === "data/sites.json").sha256
    || overlay.scoreContribution?.mode !== "excluded-pending-frozen-baseline-validation"
    || overlay.scoreContribution?.positiveContributionAllowed !== false
    || overlay.scoreContribution?.activeAgencyStatusSuppressesRecommendation !== true) {
    throw new Error("Public water-quality artifact is not bound to the review target.");
  }
  if (coverage.policySha256 !== overlay.policySha256
    || coverage.siteCatalogSha256 !== overlay.siteCatalogSha256
    || coverage.overlaySha256 !== REVIEW_TARGET_INPUTS.find(({ path }) => path === "public/data/water-quality.json").sha256
    || coverage.automaticMappingAllowed !== false
    || coverage.independentReviewRequired !== true) {
    throw new Error("Coverage inventory is not bound to the review target.");
  }
  const mappings = policy.site_mappings ?? {};
  const mappedIds = Object.keys(mappings).sort(compare);
  const notCovered = coverage.reviewedNotCoveredSites ?? [];
  const notCoveredIds = notCovered.map(({ siteId }) => siteId).sort(compare);
  if (mappedIds.length !== 39 || notCoveredIds.length !== 22 || new Set(notCoveredIds).size !== 22) {
    throw new Error("Review target mapping counts must remain 39 mapped and 22 not covered.");
  }
  if (mappedIds.some((siteId) => notCoveredIds.includes(siteId))
    || JSON.stringify([...mappedIds, ...notCoveredIds].sort(compare)) !== JSON.stringify(catalogIds)) {
    throw new Error("Every catalog site must have exactly one mapping outcome.");
  }
  const sites = catalogIds.map((siteId) => {
    const mapping = mappings[siteId];
    const publicSite = overlay.sites?.[siteId];
    if (!publicSite || publicSite.scoreDelta !== null) {
      throw new Error(`Site ${siteId} lacks a null-score public water-quality result.`);
    }
    if (!mapping) {
      if (publicSite.sourceId !== null
        || JSON.stringify(publicSite.stationIds) !== "[]"
        || publicSite.status !== "not-covered"
        || publicSite.recommendationEffect !== "unknown") {
        throw new Error(`Not-covered site ${siteId} no longer fails closed.`);
      }
      return {
        site_id: siteId,
        target_outcome: "not_covered",
        source_id: null,
        station_ids: [],
        inherited_global_station_ids: [],
      };
    }
    if (!policy.sources?.[mapping.source_id] || publicSite.sourceId !== mapping.source_id
      || publicSite.status === "not-covered") {
      throw new Error(`Mapped site ${siteId} has an invalid source binding.`);
    }
    const stationIds = exactStringArray(mapping.station_ids, `${siteId} policy station IDs`);
    const inheritedGlobalStationIds = exactStringArray(
      policy.sources[mapping.source_id].global_station_ids ?? [],
      `${siteId} inherited global station IDs`,
    );
    const allowedPublicStationIds = new Set([...stationIds, ...inheritedGlobalStationIds]);
    const actualPublicStationIds = exactStringArray(publicSite.stationIds, `${siteId} public station IDs`);
    if (actualPublicStationIds.length === 0
      || actualPublicStationIds.some((stationId) => !allowedPublicStationIds.has(stationId))) {
      throw new Error(`Mapped site ${siteId} public station evidence exceeds its reviewed binding.`);
    }
    return {
      site_id: siteId,
      target_outcome: "mapped",
      source_id: mapping.source_id,
      station_ids: stationIds,
      inherited_global_station_ids: inheritedGlobalStationIds,
    };
  });
  return { sites, policyVersion: POLICY_VERSION, targetSha256: LOCKED_REVIEW_TARGET_SHA256 };
}

export function validateReviewRecord(record, {
  expectedRole,
  targetSites,
  validateContract,
  expectedCommit = LOCKED_SOURCE_COMMIT,
  now = Date.now(),
} = {}) {
  exactKeys(record, REVIEW_FIELDS, "Water-quality mapping independent review");
  if (validateContract && !validateContract(record)) {
    throw new Error(`Water-quality mapping independent review violates its schema: ${JSON.stringify(validateContract.errors)}`);
  }
  if (record.schema_version !== REVIEW_SCHEMA_VERSION) throw new Error("Review schema version is invalid.");
  if (!UUID_V4_PATTERN.test(record.review_id ?? "")) throw new Error("Review ID is invalid.");
  if (!COMMIT_PATTERN.test(expectedCommit ?? "") || expectedCommit !== LOCKED_SOURCE_COMMIT) {
    throw new Error("Independently supplied source commit does not match the locked mapping source commit.");
  }
  if (record.source_commit !== expectedCommit) throw new Error("Review source commit does not match the independently supplied commit.");
  if (record.review_target_sha256 !== LOCKED_REVIEW_TARGET_SHA256) throw new Error("Review target digest is invalid.");
  if (record.water_quality_policy_version !== POLICY_VERSION) throw new Error("Water-quality policy version is invalid.");
  if (record.reviewer_role !== expectedRole) throw new Error("Review role is invalid for this review file.");
  if (record.reviewer_independent_of_implementation !== true) throw new Error("Reviewer independence assertion is required.");
  assertDigest(record.reviewer_competence_evidence_sha256, "Reviewer competence evidence digest");
  assertDigest(record.review_evidence_sha256, "Review evidence digest");
  if (record.reviewer_competence_evidence_sha256 === record.review_evidence_sha256) {
    throw new Error("Reviewer competence and review evidence must be distinct.");
  }
  const reviewedAt = parseTimestamp(record.reviewed_at, "Review time");
  if (reviewedAt < POLICY_REVIEWED_AT || reviewedAt > now + FUTURE_SKEW_MS) {
    throw new Error("Review time is outside the accepted policy window.");
  }
  exactKeys(record.inventory_checklist, REVIEW_CHECKS, "Water-quality mapping inventory checklist");
  const inventoryChecks = Object.values(record.inventory_checklist);
  if (!inventoryChecks.every((value) => typeof value === "boolean")) {
    throw new Error("Inventory checklist values must be booleans.");
  }
  if (!Array.isArray(targetSites) || targetSites.length !== 61 || record.site_reviews.length !== targetSites.length) {
    throw new Error("Review must contain exactly the 61 locked site outcomes.");
  }
  const siteChecks = [];
  record.site_reviews.forEach((siteReview, index) => {
    const target = targetSites[index];
    exactKeys(siteReview, SITE_REVIEW_FIELDS, `Site review ${index + 1}`);
    for (const field of ["site_id", "target_outcome", "source_id", "station_ids", "inherited_global_station_ids"]) {
      if (JSON.stringify(siteReview[field]) !== JSON.stringify(target[field])) {
        throw new Error(`Site review ${index + 1} does not match the locked ${field}.`);
      }
    }
    for (const check of SITE_REVIEW_CHECKS) {
      if (typeof siteReview[check] !== "boolean") throw new Error(`Site review ${index + 1} checks must be booleans.`);
      siteChecks.push(siteReview[check]);
    }
  });
  if (!Number.isSafeInteger(record.blocking_finding_count)
    || record.blocking_finding_count < 0 || record.blocking_finding_count > 1000) {
    throw new Error("Blocking finding count is invalid.");
  }
  const allChecksPassed = [...inventoryChecks, ...siteChecks].every(Boolean);
  if (record.disposition === "accepted_inventory") {
    if (!allChecksPassed || record.blocking_finding_count !== 0) {
      throw new Error("An accepted inventory requires every inventory and site check to pass and zero blocking findings.");
    }
  } else if (record.disposition === "changes_required") {
    if (allChecksPassed && record.blocking_finding_count === 0) {
      throw new Error("A changes-required disposition must identify a failed check or blocking finding.");
    }
  } else {
    throw new Error("Review disposition is invalid.");
  }
  return { accepted: record.disposition === "accepted_inventory", reviewedAt };
}

function assertDistinctReviewEvidence(first, second) {
  const values = [
    first.review_id,
    second.review_id,
    first.reviewer_competence_evidence_sha256,
    second.reviewer_competence_evidence_sha256,
    first.review_evidence_sha256,
    second.review_evidence_sha256,
  ];
  if (new Set(values).size !== values.length) {
    throw new Error("Reviewer identities, competence evidence, and review evidence must be distinct.");
  }
}

export async function verifyPolicy(root = DEFAULT_ROOT) {
  const [target, contractSource, runbook, advisoryRunbook, packageSource] = await Promise.all([
    loadReviewTarget(root),
    readFile(resolve(root, CONTRACT_PATH), "utf8"),
    readFile(resolve(root, RUNBOOK_PATH), "utf8"),
    readFile(resolve(root, ADVISORY_RUNBOOK_PATH), "utf8"),
    readFile(resolve(root, PACKAGE_PATH), "utf8"),
  ]);
  if (sha256(contractSource) !== LOCKED_CONTRACT_SHA256) {
    throw new Error("Water-quality mapping independent-review contract does not match its locked digest.");
  }
  const contract = parseTrackedJson(contractSource, "Water-quality mapping independent-review contract");
  const packageJson = parseTrackedJson(packageSource, "Package manifest");
  if (contract.$id !== "https://castingcompass.com/contracts/water-quality-mapping-independent-review.schema.json"
    || contract.properties?.schema_version?.const !== REVIEW_SCHEMA_VERSION) {
    throw new Error("Water-quality mapping independent-review contract identity is invalid.");
  }
  compileContract(contract);
  for (const phrase of [
    "all 61 launch-catalog sites",
    "must remain outside every repository checkout",
    "official-source mapping reviewer",
    "public-health risk-communication reviewer",
    "changes_required",
    "never authorizes a mapping change",
  ]) {
    if (!runbook.includes(phrase)) throw new Error(`Mapping-review runbook is missing required boundary: ${phrase}`);
  }
  if (!advisoryRunbook.includes("All 22 remaining sites are deliberately `not-covered`, unknown, and null-score")) {
    throw new Error("Water-quality advisory runbook no longer preserves the complete negative-evidence boundary.");
  }
  const scripts = packageJson.scripts ?? {};
  if (scripts["security:water-quality-mapping-independent-review"]
      !== "node scripts/verify-water-quality-mapping-independent-review.mjs verify-policy"
    || scripts["verify:water-quality-mapping-independent-review"]
      !== "node scripts/verify-water-quality-mapping-independent-review.mjs evaluate --mapping-review-file \"$WATER_QUALITY_MAPPING_REVIEW_FILE\" --public-health-review-file \"$WATER_QUALITY_PUBLIC_HEALTH_REVIEW_FILE\" --expected-source-commit \"$WATER_QUALITY_REVIEW_EXPECTED_SOURCE_COMMIT\""
    || scripts["template:water-quality-mapping-review"]
      !== "node scripts/verify-water-quality-mapping-independent-review.mjs print-template --role official_source_mapping_reviewer"
    || scripts["template:water-quality-public-health-review"]
      !== "node scripts/verify-water-quality-mapping-independent-review.mjs print-template --role public_health_risk_communication_reviewer"
    || !scripts.security.includes("security:water-quality-mapping-independent-review")) {
    throw new Error("Package scripts do not bind the water-quality mapping independent-review policy.");
  }
  return {
    schema_version: "castingcompass.water-quality-mapping-independent-review-policy-receipt/1.0.0",
    source_commit: LOCKED_SOURCE_COMMIT,
    review_target_sha256: target.targetSha256,
    water_quality_policy_version: target.policyVersion,
    catalog_site_count: target.sites.length,
    mapped_site_count: target.sites.filter(({ target_outcome: outcome }) => outcome === "mapped").length,
    not_covered_site_count: target.sites.filter(({ target_outcome: outcome }) => outcome === "not_covered").length,
    mapping_change_authorized: false,
    runtime_activation_authorized: false,
    numeric_score_authorized: false,
    merge_authorized: false,
    deployment_authorized: false,
    production_authorized: false,
  };
}

export async function evaluateReviewFiles({
  root = DEFAULT_ROOT,
  mappingReviewFile,
  publicHealthReviewFile,
  expectedSourceCommit,
  now = Date.now(),
}) {
  const policyReceipt = await verifyPolicy(root);
  if (!COMMIT_PATTERN.test(expectedSourceCommit ?? "") || expectedSourceCommit !== LOCKED_SOURCE_COMMIT) {
    throw new Error("Independently supplied source commit does not match the locked mapping source commit.");
  }
  const [target, contractSource] = await Promise.all([
    loadReviewTarget(root),
    readFile(resolve(root, CONTRACT_PATH), "utf8"),
  ]);
  const contract = parseTrackedJson(contractSource, "Water-quality mapping independent-review contract");
  const validateContract = compileContract(contract);
  const [mappingFile, publicHealthFile] = await Promise.all([
    readPrivateReviewFile(root, mappingReviewFile, "Official-source mapping review file"),
    readPrivateReviewFile(root, publicHealthReviewFile, "Public-health review file"),
  ]);
  if (mappingFile.identity === publicHealthFile.identity || mappingFile.realPath === publicHealthFile.realPath) {
    throw new Error("The two required reviews must be separate private files.");
  }
  const mapping = parseCanonicalJson(mappingFile.source, "Official-source mapping review file");
  const publicHealth = parseCanonicalJson(publicHealthFile.source, "Public-health review file");
  const mappingResult = validateReviewRecord(mapping, {
    expectedRole: REVIEW_ROLES[0],
    targetSites: target.sites,
    validateContract,
    expectedCommit: expectedSourceCommit,
    now,
  });
  const publicHealthResult = validateReviewRecord(publicHealth, {
    expectedRole: REVIEW_ROLES[1],
    targetSites: target.sites,
    validateContract,
    expectedCommit: expectedSourceCommit,
    now,
  });
  assertDistinctReviewEvidence(mapping, publicHealth);
  const complete = mappingResult.accepted && publicHealthResult.accepted;
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    policy_source_commit: LOCKED_SOURCE_COMMIT,
    review_target_sha256: LOCKED_REVIEW_TARGET_SHA256,
    water_quality_policy_version: POLICY_VERSION,
    reviewed_through: new Date(Math.max(mappingResult.reviewedAt, publicHealthResult.reviewedAt)).toISOString(),
    required_review_roles: REVIEW_ROLES,
    review_count: 2,
    catalog_site_count: policyReceipt.catalog_site_count,
    mapped_site_count: policyReceipt.mapped_site_count,
    not_covered_site_count: policyReceipt.not_covered_site_count,
    official_source_mapping_review_accepted: mappingResult.accepted,
    public_health_risk_communication_review_accepted: publicHealthResult.accepted,
    independent_mapping_review_complete: complete,
    changes_required: !complete,
    mapping_change_authorized: false,
    runtime_activation_authorized: false,
    numeric_score_authorized: false,
    clean_water_claim_authorized: false,
    seafood_safety_claim_authorized: false,
    catch_probability_claim_authorized: false,
    merge_authorized: false,
    deployment_authorized: false,
    production_authorized: false,
  };
}

async function template(root, role, now = Date.now()) {
  if (!REVIEW_ROLES.includes(role)) throw new Error(`Template role must be one of: ${REVIEW_ROLES.join(", ")}`);
  const target = await loadReviewTarget(root);
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    review_id: randomUUID(),
    source_commit: LOCKED_SOURCE_COMMIT,
    review_target_sha256: LOCKED_REVIEW_TARGET_SHA256,
    water_quality_policy_version: POLICY_VERSION,
    reviewed_at: new Date(now).toISOString(),
    reviewer_role: role,
    reviewer_independent_of_implementation: true,
    reviewer_competence_evidence_sha256: "REPLACE_WITH_PRIVATE_COMPETENCE_NOTE_SHA256",
    review_evidence_sha256: "REPLACE_WITH_PRIVATE_REVIEW_NOTE_SHA256",
    disposition: "changes_required",
    blocking_finding_count: 1,
    inventory_checklist: Object.fromEntries(REVIEW_CHECKS.map((check) => [check, false])),
    site_reviews: target.sites.map((site) => ({
      ...site,
      ...Object.fromEntries(SITE_REVIEW_CHECKS.map((check) => [check, false])),
    })),
  };
}

export async function writeReviewTemplate({
  root = DEFAULT_ROOT,
  role,
  outputFile,
  now = Date.now(),
}) {
  const outputPath = await privateTemplateOutputPath(root, outputFile);
  const payload = await template(root, role, now);
  const body = stableJson(payload);
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
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Template output file did not preserve the required private mode.");
    }
    complete = true;
  } finally {
    try {
      await handle.close();
    } finally {
      if (!complete) await unlink(outputPath).catch(() => undefined);
    }
  }
  return {
    schema_version: "castingcompass.water-quality-mapping-review-template-write-receipt/1.0.0",
    source_commit: LOCKED_SOURCE_COMMIT,
    review_target_sha256: LOCKED_REVIEW_TARGET_SHA256,
    reviewer_role: role,
    catalog_site_count: payload.site_reviews.length,
    disposition: payload.disposition,
    owner_only_file_written: true,
    existing_file_overwritten: false,
    merge_authorized: false,
    deployment_authorized: false,
    production_authorized: false,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("Arguments must be --name value pairs.");
    values.set(flag, value);
  }
  return values;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "verify-policy") {
    if (rest.length !== 0) throw new Error("verify-policy accepts no arguments.");
    process.stdout.write(stableJson(await verifyPolicy()));
    return;
  }
  if (command === "print-template") {
    const args = parseArgs(rest);
    if (args.size !== 1 || !args.has("--role")) throw new Error("print-template requires only --role.");
    process.stdout.write(stableJson(await template(DEFAULT_ROOT, args.get("--role"))));
    return;
  }
  if (command === "write-template") {
    const args = parseArgs(rest);
    if (args.size !== 2 || !args.has("--role") || !args.has("--output-file")) {
      throw new Error("write-template requires only --role and --output-file.");
    }
    process.stdout.write(stableJson(await writeReviewTemplate({
      role: args.get("--role"),
      outputFile: args.get("--output-file"),
    })));
    return;
  }
  if (command === "evaluate") {
    const args = parseArgs(rest);
    const allowed = ["--mapping-review-file", "--public-health-review-file", "--expected-source-commit"];
    if (args.size !== allowed.length || allowed.some((flag) => !args.has(flag))) {
      throw new Error(`evaluate requires ${allowed.join(", ")}.`);
    }
    process.stdout.write(stableJson(await evaluateReviewFiles({
      mappingReviewFile: args.get("--mapping-review-file"),
      publicHealthReviewFile: args.get("--public-health-review-file"),
      expectedSourceCommit: args.get("--expected-source-commit"),
    })));
    return;
  }
  throw new Error("Usage: verify-water-quality-mapping-independent-review.mjs verify-policy | print-template --role ROLE | write-template --role ROLE --output-file ABSOLUTE_PATH | evaluate --mapping-review-file ABSOLUTE_PATH --public-health-review-file ABSOLUTE_PATH --expected-source-commit SHA");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
