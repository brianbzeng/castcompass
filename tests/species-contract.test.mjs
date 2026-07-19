import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../", import.meta.url);

function materializeFixture(corpus, fixtureCase) {
  const value = structuredClone(corpus.base_records[fixtureCase.base]);
  for (const mutation of fixtureCase.mutations) {
    const segments = mutation.path.split("/").slice(1).map((segment) => (
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ));
    let parent = value;
    for (const segment of segments.slice(0, -1)) {
      parent = Array.isArray(parent) ? parent[Number(segment)] : parent[segment];
    }
    const key = segments.at(-1);
    assert.notEqual(key, undefined);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (mutation.op === "remove") parent.splice(index, 1);
      else if (mutation.op === "add") parent.splice(index, 0, structuredClone(mutation.value));
      else parent[index] = structuredClone(mutation.value);
    } else if (mutation.op === "remove") {
      delete parent[key];
    } else {
      parent[key] = structuredClone(mutation.value);
    }
  }
  return value;
}

test("machine contract assets declare the locked IDs and versions", async () => {
  const files = await Promise.all([
    "contracts/taxa.json",
    "contracts/taxa.schema.json",
    "contracts/observation.schema.json",
    "contracts/model-run.schema.json",
    "contracts/model-governance.schema.json",
    "contracts/source-admissibility.schema.json",
    "contracts/privacy-rights-case.schema.json",
    "contracts/opportunity.schema.json",
  ].map(async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"))));
  const [
    catalog,
    taxaSchema,
    observationSchema,
    modelRunSchema,
    modelGovernanceSchema,
    sourceAdmissibilitySchema,
    privacyRightsCaseSchema,
    opportunitySchema,
  ] = files;
  assert.equal(catalog.contract_version, "castingcompass.taxa/1.0.0");
  assert.equal(taxaSchema.$id, catalog.contract_version);
  assert.equal(observationSchema.$id, "castingcompass.observation/2.0.0");
  assert.equal(modelRunSchema.$id, "castingcompass.model-run/2.0.0");
  assert.equal(modelGovernanceSchema.$id, "castingcompass.model-governance/1.0.0");
  assert.equal(sourceAdmissibilitySchema.$id, "castingcompass.source-admissibility/1.0.0");
  assert.equal(privacyRightsCaseSchema.$id, "castingcompass.privacy-rights-case/1.0.0");
  assert.equal(opportunitySchema.$id, "castingcompass.opportunity/2.0.0");
  assert.deepEqual(catalog.taxa.map((taxon) => taxon.taxon_id), [
    "california-halibut",
    "unresolved-fish",
    "synthetic-target",
  ]);
  assert.equal(catalog.taxa.find((taxon) => taxon.taxon_id === "california-halibut").model_eligible, true);
  assert.equal(catalog.taxa.find((taxon) => taxon.taxon_id === "unresolved-fish").model_eligible, false);
  assert.equal(catalog.taxa.find((taxon) => taxon.taxon_id === "synthetic-target").production_observation_eligible, false);
});

test("date-time formats require explicit offsets and real calendar values", () => {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile({ type: "string", format: "date-time" });

  assert.equal(validate("2026-07-18T10:00:00Z"), true);
  assert.equal(validate("2026-07-18T10:00:00-07:00"), true);
  assert.equal(validate("2026-07-18T10:00:00"), false);
  assert.equal(validate("2026-02-30T10:00:00Z"), false);
  assert.equal(validate("2026-07-18T25:00:00Z"), false);
});

test("Ajv 2020 strictly compiles every schema and validates structural fixtures", async () => {
  const paths = [
    "contracts/taxa.schema.json",
    "contracts/observation.schema.json",
    "contracts/model-run.schema.json",
    "contracts/model-governance.schema.json",
    "contracts/source-admissibility.schema.json",
    "contracts/privacy-rights-case.schema.json",
    "contracts/opportunity.schema.json",
  ];
  const [
    taxaSchema,
    observationSchema,
    modelRunSchema,
    modelGovernanceSchema,
    sourceAdmissibilitySchema,
    privacyRightsCaseSchema,
    opportunitySchema,
  ] = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"))),
  );
  const [catalog, corpus, modelGovernancePolicy, sourceAdmissibilityPolicy] = await Promise.all([
    JSON.parse(await readFile(new URL("contracts/taxa.json", root), "utf8")),
    JSON.parse(await readFile(new URL("contracts/fixtures/observation-contract-cases.json", root), "utf8")),
    JSON.parse(await readFile(new URL("model/governance/california-halibut-v1.json", root), "utf8")),
    JSON.parse(await readFile(new URL("pipeline/source-admissibility-policy.json", root), "utf8")),
  ]);

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validateCatalog = ajv.compile(taxaSchema);
  const validateObservation = ajv.compile(observationSchema);
  const validateModelRun = ajv.compile(modelRunSchema);
  const validateModelGovernance = ajv.compile(modelGovernanceSchema);
  const validateSourceAdmissibility = ajv.compile(sourceAdmissibilitySchema);
  const validatePrivacyRightsCase = ajv.compile(privacyRightsCaseSchema);
  const validateOpportunity = ajv.compile(opportunitySchema);

  assert.equal(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors));
  const changedCatalog = structuredClone(catalog);
  changedCatalog.taxa[0].model_eligible = false;
  assert.equal(validateCatalog(changedCatalog), false);

  for (const fixtureCase of corpus.cases) {
    const accepted = validateObservation(materializeFixture(corpus, fixtureCase));
    assert.equal(
      accepted,
      fixtureCase.expected_schema_valid,
      `${fixtureCase.name}: ${JSON.stringify(validateObservation.errors)}`,
    );
  }

  const digest = "a".repeat(64);
  const modelRun = {
    schema_version: "castingcompass.model-run/2.0.0",
    model_run_contract_version: "castingcompass.model-run/2.0.0",
    observation_contract_version: "castingcompass.observation/2.0.0",
    taxon_catalog_version: "castingcompass.taxa/1.0.0",
    target_taxon_id: "california-halibut",
    target_scope: { kind: "taxon", taxon_id: "california-halibut" },
    run_id: "run-1",
    created_at: "2026-07-16T18:00:00Z",
    status: "completed",
    dataset_kind: "official_labeled_observations",
    command: "fixture",
    experiment_version: `exp-california-halibut-${digest}`,
    model_version: `model-california-halibut-${digest}`,
    git_revision: digest,
    runtime: { python: "3.12", platform: "fixture" },
    config: {},
    inputs: [{ path: "/input.jsonl", sha256: digest, bytes: 1 }],
    metrics: { fixture_metric: 1 },
    notes: "structural fixture",
  };
  assert.equal(validateModelRun(modelRun), true, JSON.stringify(validateModelRun.errors));
  assert.equal(validateModelRun({ ...modelRun, target_taxon_id: "rockfish" }), false);
  assert.equal(
    validateModelGovernance(modelGovernancePolicy),
    true,
    JSON.stringify(validateModelGovernance.errors),
  );
  const weakenedGovernance = structuredClone(modelGovernancePolicy);
  weakenedGovernance.current_release.trained_model_authorized = true;
  assert.equal(validateModelGovernance(weakenedGovernance), false);
  const ambiguousGovernance = structuredClone(modelGovernancePolicy);
  ambiguousGovernance.unreviewed_escape_hatch = true;
  assert.equal(validateModelGovernance(ambiguousGovernance), false);
  assert.equal(
    validateSourceAdmissibility(sourceAdmissibilityPolicy),
    true,
    JSON.stringify(validateSourceAdmissibility.errors),
  );
  const weakenedSourcePolicy = structuredClone(sourceAdmissibilityPolicy);
  weakenedSourcePolicy.blocked_platforms[1].automated_collection_allowed = true;
  assert.equal(validateSourceAdmissibility(weakenedSourcePolicy), false);
  const ambiguousSourcePolicy = structuredClone(sourceAdmissibilityPolicy);
  ambiguousSourcePolicy.unreviewed_escape_hatch = true;
  assert.equal(validateSourceAdmissibility(ambiguousSourcePolicy), false);
  const privacyCase = {
    schema_version: "castingcompass.privacy-rights-case/1.0.0",
    case_id: "prc_00000000000000000000000000000000",
    synthetic: true,
    source_commit: digest.slice(0, 40),
    received_at: "2026-07-16T18:00:00.000Z",
    acknowledged_at: null,
    responded_at: null,
    closed_at: null,
    channel: "authenticated-self-service",
    jurisdiction_volunteered: "not-volunteered",
    rights: ["access"],
    applied_clock: "unassessed",
    extension: { status: "none", notified_at: null, reason_code: "none", extended_due_at: null },
    identity: { status: "pending", method: "not-completed", completed_at: null },
    status: "received",
    systems: [
      "active-d1", "deletion-ledger", "private-r2", "browser-state",
      "validation-artifacts", "operational-logs", "encrypted-backups", "processors",
    ].map((system) => ({ system, result: "unresolved", record_count: 0, action_count: 0 })),
    processors: ["cloudflare", "resend", "xiaomi-mimo", "hibp", "turnstile"]
      .map((processor) => ({ processor, result: "unresolved", action_count: 0 })),
    delivery: { status: "pending", channel: "none", delivered_at: null, export_section_count: 0 },
    disposition: {
      outcome: "pending",
      reason_code: "none",
      active_row_count: 0,
      object_task_completed_count: 0,
      object_task_pending_count: 0,
      retained_category_count: 0,
      deletion_completed_at: null,
      challenge_information_provided: false,
      legal_exception_recorded: false,
    },
    safety_checks: {
      cross_account_data_absent: false,
      secrets_absent: false,
      internal_locators_absent: false,
      deleted_content_absent: false,
      raw_identifiers_absent: true,
      restore_suppression_verified: false,
    },
    review: {
      legal_clock_review_completed: false,
      privacy_case_review_completed: false,
      second_person_review_completed: false,
    },
  };
  assert.equal(validatePrivacyRightsCase(privacyCase), true, JSON.stringify(validatePrivacyRightsCase.errors));
  assert.equal(validatePrivacyRightsCase({ ...privacyCase, email: "fixture@example.invalid" }), false);

  const opportunityCommon = {
    id: "pier--20260716T1800Z",
    species: "california-halibut",
    target_taxon_id: "california-halibut",
    taxon_catalog_version: "castingcompass.taxa/1.0.0",
    observation_contract_version: "castingcompass.observation/2.0.0",
    model_run_contract_version: "castingcompass.model-run/2.0.0",
    opportunity_contract_version: "castingcompass.opportunity/2.0.0",
    scoring_system_kind: "heuristic-configuration",
    scoring_system_sha256: digest,
  };
  const staticOpportunity = {
    ...opportunityCommon,
    siteId: "pier",
    start: "2026-07-16T18:00:00Z",
    end: "2026-07-16T20:00:00Z",
    score: 75,
    modelVersion: "heuristic-fixture",
    confidence: "medium",
  };
  const apiOpportunity = {
    ...opportunityCommon,
    scoring_system_version: "heuristic-fixture",
    site: { id: "pier" },
    start_time: "2026-07-16T18:00:00Z",
    end_time: "2026-07-16T20:00:00Z",
    opportunity_score: 75,
    model_version: "heuristic-fixture",
    confidence: { level: "medium", reasons: [] },
  };
  assert.equal(validateOpportunity(staticOpportunity), true, JSON.stringify(validateOpportunity.errors));
  assert.equal(validateOpportunity(apiOpportunity), true, JSON.stringify(validateOpportunity.errors));
  assert.equal(validateOpportunity({ ...staticOpportunity, ...apiOpportunity }), false);
  assert.equal(validateOpportunity({ ...staticOpportunity, target_taxon_id: "rockfish", species: "rockfish" }), false);
});

test("TypeScript contract validators pass their runtime suite on supported Node 22+", () => {
  const runtimeTest = new URL("species-contract-runtime.test.mts", import.meta.url);
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--test",
    runtimeTest.pathname,
  ], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("Python consumers validate the same catalog and environment eligibility", () => {
  const program = [
    "from shared.species_contract import validate_contract_assets, is_model_eligible_target, is_observation_eligible",
    "validate_contract_assets()",
    "assert is_observation_eligible('unresolved-fish', environment='production')",
    "assert not is_observation_eligible('synthetic-target', environment='production')",
    "assert is_observation_eligible('synthetic-target', environment='test')",
    "assert is_model_eligible_target('california-halibut', environment='production')",
    "assert is_model_eligible_target('california-halibut', environment='test')",
    "assert is_model_eligible_target('synthetic-target', environment='test')",
    "assert not is_model_eligible_target('unresolved-fish', environment='test')",
  ].join("; ");
  const result = spawnSync("python3", ["-c", program], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
