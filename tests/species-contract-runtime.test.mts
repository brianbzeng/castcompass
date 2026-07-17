import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CALIFORNIA_HALIBUT_TAXON_ID,
  MODEL_RUN_CONTRACT_VERSION,
  OBSERVATION_CONTRACT_VERSION,
  OPPORTUNITY_CONTRACT_VERSION,
  SYNTHETIC_TARGET_TAXON_ID,
  TAXON_CATALOG_VERSION,
  UNRESOLVED_FISH_TAXON_ID,
  assessObservationModelEligibility,
  buildModelVersionMaterial,
  deriveObservationOutcomeClass,
  isModelEligibleTaxon,
  isObservationEligible,
  validateModelRunContract,
  validateObservationContract,
  validateOpportunityContract,
} from "../shared/species-contract.ts";

const digest = (character: string) => character.repeat(64);

interface FixtureMutation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

interface ObservationFixtureCase {
  name: string;
  category: string;
  base: string;
  environment: "production" | "test";
  expected_schema_valid: boolean;
  expected_semantic_valid: boolean;
  mutations: FixtureMutation[];
}

interface ObservationFixtureCorpus {
  base_records: Record<string, Record<string, unknown>>;
  cases: ObservationFixtureCase[];
}

const observationFixtureCorpus = JSON.parse(readFileSync(
  new URL("../contracts/fixtures/observation-contract-cases.json", import.meta.url),
  "utf8",
)) as ObservationFixtureCorpus;

function materializeFixture(fixtureCase: ObservationFixtureCase): Record<string, unknown> {
  const value = structuredClone(observationFixtureCorpus.base_records[fixtureCase.base]);
  for (const mutation of fixtureCase.mutations) {
    const segments = mutation.path.split("/").slice(1).map((segment) => (
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ));
    let parent: unknown = value;
    for (const segment of segments.slice(0, -1)) {
      parent = Array.isArray(parent)
        ? parent[Number(segment)]
        : (parent as Record<string, unknown>)[segment];
    }
    const key = segments.at(-1);
    assert.ok(key !== undefined, `${fixtureCase.name} mutation has an empty path`);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (mutation.op === "remove") parent.splice(index, 1);
      else if (mutation.op === "add") parent.splice(index, 0, structuredClone(mutation.value));
      else parent[index] = structuredClone(mutation.value);
    } else {
      const record = parent as Record<string, unknown>;
      if (mutation.op === "remove") delete record[key];
      else record[key] = structuredClone(mutation.value);
    }
  }
  return value;
}

function targetRow(encounters: number) {
  return {
    taxon_id: CALIFORNIA_HALIBUT_TAXON_ID,
    encounter_count: encounters,
    retained_count: encounters > 0 ? 1 : 0,
    released_count: 0,
    disposition_unknown_count: encounters > 0 ? encounters - 1 : 0,
    identification_confidence: encounters > 0 ? "self_reported" : "not_observed",
    identification_basis: encounters > 0 ? "angler-report" : "not-observed",
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: OBSERVATION_CONTRACT_VERSION,
    taxon_catalog_version: TAXON_CATALOG_VERSION,
    contract_status: "valid",
    observation_id: "obs-1",
    effort_segment_id: "segment-1",
    primary_target_taxon_id: CALIFORNIA_HALIBUT_TAXON_ID,
    source: {
      source_id: "first-party-trip",
      source_record_id: "trip-1",
      data_kind: "complete-effort-segment",
      complete_attempt: true,
      expanded_estimate: false,
    },
    target_effort: { value: 2.5, unit: "trip-hours", mode: "shore" },
    temporal_support: {
      start_at: "2026-07-16T08:00:00-07:00",
      end_at: "2026-07-16T10:30:00-07:00",
      precision: "exact",
    },
    spatial_support: { kind: "point", support_id: "point-1", crs: "EPSG:32610", x: 551000, y: 4180000 },
    taxon_observations: [targetRow(2)],
    outcome_class: "target_encountered",
    ...overrides,
  };
}

test("catalog eligibility distinguishes observations, production targets, and test fixtures", () => {
  assert.equal(isObservationEligible(CALIFORNIA_HALIBUT_TAXON_ID, "production"), true);
  assert.equal(isObservationEligible(UNRESOLVED_FISH_TAXON_ID, "production"), true);
  assert.equal(isObservationEligible(SYNTHETIC_TARGET_TAXON_ID, "production"), false);
  assert.equal(isObservationEligible(SYNTHETIC_TARGET_TAXON_ID, "test"), true);
  assert.equal(isModelEligibleTaxon(CALIFORNIA_HALIBUT_TAXON_ID, "production"), true);
  assert.equal(isModelEligibleTaxon(CALIFORNIA_HALIBUT_TAXON_ID, "test"), true);
  assert.equal(isModelEligibleTaxon(SYNTHETIC_TARGET_TAXON_ID, "test"), true);
  assert.equal(isModelEligibleTaxon(UNRESOLVED_FISH_TAXON_ID, "test"), false);
});

test("validates complete observations and derives all three outcome classes", () => {
  assert.deepEqual(validateObservationContract(observation()), { ok: true, errors: [] });
  assert.equal(assessObservationModelEligibility(observation(), { expectedProjectedCrs: "EPSG:32610" }).ok, true);

  const noFish = observation({ taxon_observations: [targetRow(0)], outcome_class: "no_fish" });
  assert.equal(validateObservationContract(noFish).ok, true);
  assert.equal(deriveObservationOutcomeClass(noFish.taxon_observations, CALIFORNIA_HALIBUT_TAXON_ID), "no_fish");

  const nonTarget = {
    taxon_id: UNRESOLVED_FISH_TAXON_ID,
    encounter_count: 2,
    retained_count: 0,
    released_count: 0,
    disposition_unknown_count: 2,
    identification_confidence: "unresolved",
    identification_basis: "unresolved",
  };
  const miss = observation({
    taxon_observations: [targetRow(0), nonTarget],
    outcome_class: "non_target_only",
  });
  assert.equal(validateObservationContract(miss).ok, true);
  assert.equal(deriveObservationOutcomeClass(miss.taxon_observations, CALIFORNIA_HALIBUT_TAXON_ID), "non_target_only");
});

test("shared observation fixtures have identical TypeScript semantic outcomes", () => {
  const requiredCategories = new Set([
    "offset-parity",
    "numeric-strings",
    "invalid-ids",
    "extra-fields",
    "source-ids",
    "non-point-crs-fields",
    "model-crs",
    "timestamp-grammar",
    "timestamp-calendar",
    "counts",
    "confidence-pairs",
    "environments",
  ]);
  const actualCategories = new Set(observationFixtureCorpus.cases.map((fixtureCase) => fixtureCase.category));
  for (const category of requiredCategories) {
    assert.equal(actualCategories.has(category), true, `fixture corpus is missing ${category}`);
  }
  for (const fixtureCase of observationFixtureCorpus.cases) {
    const result = validateObservationContract(materializeFixture(fixtureCase), {
      environment: fixtureCase.environment,
    });
    assert.equal(
      result.ok,
      fixtureCase.expected_semantic_valid,
      `${fixtureCase.name}: ${result.errors.join("; ")}`,
    );
  }
});

test("rejects impossible calendar dates without weakening timestamp or safe-integer rules", () => {
  const invalidStarts = [
    "0000-01-01T08:00:00Z",
    "2026-02-29T08:00:00Z",
    "1900-02-29T08:00:00Z",
    "2026-04-31T08:00:00Z",
    "2026-00-10T08:00:00Z",
    "2026-13-10T08:00:00Z",
    "2026-01-00T08:00:00Z",
    "2026-01-32T08:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01t08:00:00Z",
    "2026-01-01T08:00:00z",
    "2026-01-01T08:00:00-0700",
    "2026-01-01T08:00:00.1234567890Z",
  ];
  for (const start_at of invalidStarts) {
    const record = observation({
      temporal_support: { start_at, end_at: "2026-12-31T23:00:00Z", precision: "exact" },
    });
    assert.equal(validateObservationContract(record).ok, false, start_at);
  }

  const validRanges = [
    ["2024-02-29T08:00:00Z", "2024-02-29T09:00:00Z"],
    ["2000-02-29T08:00:00+05:30", "2000-02-29T09:00:00+05:30"],
    ["2026-04-30T08:00:00.123456789-07:00", "2026-04-30T09:00:00.123456789-07:00"],
    ["2026-04-30T08:00:00.000000001Z", "2026-04-30T08:00:00.000000002Z"],
  ];
  for (const [start_at, end_at] of validRanges) {
    const record = observation({ temporal_support: { start_at, end_at, precision: "exact" } });
    assert.equal(validateObservationContract(record).ok, true, `${start_at} — ${end_at}`);
  }

  const integralJsonCount = JSON.parse("1.0") as number;
  assert.equal(Number.isSafeInteger(integralJsonCount), true);
  assert.equal(validateObservationContract(observation({
    taxon_observations: [targetRow(integralJsonCount)],
  })).ok, true);

  const unsafeCount = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validateObservationContract(observation({
    taxon_observations: [{
      ...targetRow(1),
      encounter_count: unsafeCount,
      retained_count: 0,
      released_count: unsafeCount,
      disposition_unknown_count: 0,
    }],
  })).ok, false);
});

test("rejects mixed identity, catch-only, expanded, generic, and legacy inputs", () => {
  const cases = [
    observation({ primary_target_taxon_id: "rockfish" }),
    observation({ contract_status: "legacy_unverified" }),
    observation({ source: { ...observation().source, complete_attempt: false } }),
    observation({ source: { ...observation().source, expanded_estimate: true } }),
    observation({ outcome_class: "no_fish" }),
    observation({ taxon_observations: [targetRow(2), targetRow(1)] }),
    observation({
      taxon_observations: [{ ...targetRow(2), identification_confidence: "unresolved", identification_basis: "unresolved" }],
    }),
    observation({
      taxon_observations: [{ ...targetRow(2), identification_confidence: "verified", identification_basis: "synthetic-fixture" }],
    }),
  ];
  for (const record of cases) assert.equal(validateObservationContract(record).ok, false);
});

test("allows synthetic target only for test fixtures and fails closed on terrain-model CRS", () => {
  const synthetic = observation({
    primary_target_taxon_id: SYNTHETIC_TARGET_TAXON_ID,
    source: {
      source_id: "synthetic_fixture",
      data_kind: "synthetic-fixture",
      complete_attempt: true,
      expanded_estimate: false,
    },
    taxon_observations: [{
      taxon_id: SYNTHETIC_TARGET_TAXON_ID,
      encounter_count: 1,
      retained_count: 0,
      released_count: 0,
      disposition_unknown_count: 1,
      identification_confidence: "verified",
      identification_basis: "synthetic-fixture",
    }],
  });
  assert.equal(validateObservationContract(synthetic, { environment: "test" }).ok, true);
  assert.equal(validateObservationContract(synthetic, { environment: "production" }).ok, false);

  const bounded = observation({ temporal_support: { ...observation().temporal_support, precision: "bounded" } });
  assert.equal(validateObservationContract(bounded).ok, true);
  assert.equal(assessObservationModelEligibility(bounded, { expectedProjectedCrs: "EPSG:32610" }).ok, false);
  const site = observation({ spatial_support: { kind: "site", support_id: "test-pier" } });
  assert.equal(validateObservationContract(site).ok, true);
  assert.equal(assessObservationModelEligibility(site, { expectedProjectedCrs: "EPSG:32610" }).ok, false);

  assert.equal(Reflect.apply(assessObservationModelEligibility, undefined, [observation()]).ok, false);
  assert.equal(assessObservationModelEligibility(observation(), { expectedProjectedCrs: "EPSG:4326" }).ok, false);
  assert.equal(assessObservationModelEligibility(observation(), { expectedProjectedCrs: "garbage" }).ok, false);
  assert.equal(assessObservationModelEligibility(observation(), { expectedProjectedCrs: "epsg:32610" }).ok, false);
  assert.equal(assessObservationModelEligibility(observation(), { expectedProjectedCrs: " EPSG:32610 " }).ok, false);
  assert.equal(assessObservationModelEligibility(
    observation({ spatial_support: { ...observation().spatial_support, crs: "EPSG:4326", x: -122.4, y: 37.8 } }),
    { expectedProjectedCrs: "EPSG:32610" },
  ).ok, false);
  const nad83Point = observation({ spatial_support: { ...observation().spatial_support, crs: "EPSG:26910" } });
  assert.equal(assessObservationModelEligibility(nad83Point, { expectedProjectedCrs: "EPSG:26910" }).ok, true);
  assert.equal(assessObservationModelEligibility(nad83Point, { expectedProjectedCrs: "EPSG:32610" }).ok, false);
});

function modelRun(targetTaxonId: string | null, environment: "production" | "test") {
  const scope = targetTaxonId === null
    ? { kind: "target-agnostic", taxon_id: null }
    : { kind: "taxon", taxon_id: targetTaxonId };
  const slug = targetTaxonId ?? "target-agnostic";
  return {
    schema_version: MODEL_RUN_CONTRACT_VERSION,
    model_run_contract_version: MODEL_RUN_CONTRACT_VERSION,
    observation_contract_version: targetTaxonId === null ? null : OBSERVATION_CONTRACT_VERSION,
    taxon_catalog_version: TAXON_CATALOG_VERSION,
    target_taxon_id: targetTaxonId,
    target_scope: scope,
    run_id: "run-1",
    created_at: "2026-07-16T18:00:00+00:00",
    status: "completed",
    dataset_kind: targetTaxonId === null ? "official_unlabeled_bathymetry" : environment === "test" ? "synthetic_fixture" : "official_labeled_observations",
    command: "test-run",
    experiment_version: `exp-${slug}-${digest("a")}`,
    model_version: `model-${slug}-${digest("b")}`,
    git_revision: digest("c"),
    runtime: { python: "3.12.0", platform: "test" },
    config: { fold_count: 5 },
    inputs: [{ path: "/data/input.jsonl", sha256: digest("d"), bytes: 42 }],
    metrics: { fixture_metric: 1 },
    notes: "fixture",
  };
}

test("validates actual target-specific and target-agnostic run metadata shapes", () => {
  const synthetic = modelRun(SYNTHETIC_TARGET_TAXON_ID, "test");
  assert.equal(validateModelRunContract(synthetic, { environment: "test" }).ok, true);
  const agnostic = modelRun(null, "production");
  assert.equal(validateModelRunContract(agnostic).ok, true);
  const halibut = modelRun(CALIFORNIA_HALIBUT_TAXON_ID, "production");
  assert.equal(validateModelRunContract(halibut).ok, true);
  assert.notEqual(buildModelVersionMaterial(halibut), buildModelVersionMaterial(synthetic));
  assert.notEqual(buildModelVersionMaterial(halibut), buildModelVersionMaterial({ ...halibut, command: "other-command" }));
  assert.notEqual(buildModelVersionMaterial(halibut), buildModelVersionMaterial({ ...halibut, dataset_kind: "other_labeled" }));
  assert.equal(validateModelRunContract({ ...agnostic, observation_contract_version: OBSERVATION_CONTRACT_VERSION }).ok, false);
  assert.equal(validateModelRunContract({ ...agnostic, dataset_kind: "official_labeled_observations" }).ok, false);
  assert.equal(validateModelRunContract({ ...halibut, dataset_kind: "synthetic_fixture" }, { environment: "test" }).ok, false);
  assert.equal(validateModelRunContract({ ...halibut, inputs: [] }).ok, false);
  assert.equal(validateModelRunContract({ ...halibut, metrics: {} }).ok, false);
  assert.equal(validateModelRunContract({ ...halibut, notes: "" }).ok, false);
});

test("validates actual Python build_run_record output for both target scopes", () => {
  const program = `
import json
import tempfile
from pathlib import Path
from pipeline.contourcast.metadata import build_run_record
from shared.species_contract import SYNTHETIC_TARGET_TAXON_ID
with tempfile.TemporaryDirectory() as temporary:
  input_path = Path(temporary) / "input.bin"
  input_path.write_bytes(b"contract fixture")
  records = {
    "synthetic": build_run_record(
      command="contract-test",
      target_taxon_id=SYNTHETIC_TARGET_TAXON_ID,
      config={"fold_count": 5},
      input_paths=(input_path,),
      dataset_kind="synthetic_fixture",
      status="completed",
      metrics={"fixture_metric": 1},
      notes="Synthetic structural contract fixture.",
    ),
    "agnostic": build_run_record(
      command="contract-test",
      target_taxon_id=None,
      config={"fold_count": 5},
      input_paths=(input_path,),
      dataset_kind="official_unlabeled_bathymetry",
      status="completed",
      metrics={"fixture_metric": 1},
      notes="Target-agnostic structural contract fixture.",
    ),
  }
print(json.dumps(records))
`;
  const result = spawnSync("python3", ["-c", program], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout);
  assert.equal(validateModelRunContract(records.synthetic, { environment: "test" }).ok, true);
  assert.equal(validateModelRunContract(records.agnostic).ok, true);
  assert.notEqual(records.synthetic.model_version, records.agnostic.model_version);
  assert.notEqual(buildModelVersionMaterial(records.synthetic), buildModelVersionMaterial(records.agnostic));
});

test("validates compact flat static and API opportunity windows", () => {
  const scoringSystemVersion = "castingcompass-hybrid-demo-0.6.0";
  const common = {
    id: "test-pier--20260716T1800Z",
    species: CALIFORNIA_HALIBUT_TAXON_ID,
    target_taxon_id: CALIFORNIA_HALIBUT_TAXON_ID,
    taxon_catalog_version: TAXON_CATALOG_VERSION,
    observation_contract_version: OBSERVATION_CONTRACT_VERSION,
    model_run_contract_version: MODEL_RUN_CONTRACT_VERSION,
    opportunity_contract_version: OPPORTUNITY_CONTRACT_VERSION,
    scoring_system_kind: "heuristic-configuration",
    scoring_system_sha256: digest("e"),
  };
  const staticWindow = {
    ...common,
    siteId: "test-pier",
    start: "2026-07-16T18:00:00Z",
    end: "2026-07-16T20:00:00Z",
    score: 82,
    modelVersion: scoringSystemVersion,
    confidence: "medium",
  };
  assert.equal(validateOpportunityContract(staticWindow).ok, true);
  const apiWindow = {
    ...common,
    scoring_system_version: scoringSystemVersion,
    site: { id: "test-pier" },
    start_time: "2026-07-16T18:00:00+00:00",
    end_time: "2026-07-16T20:00:00+00:00",
    opportunity_score: 82,
    model_version: scoringSystemVersion,
    confidence: { level: "medium" },
  };
  assert.equal(validateOpportunityContract(apiWindow).ok, true);
  assert.equal(validateOpportunityContract({ ...staticWindow, species: "rockfish" }).ok, false);
  assert.equal(validateOpportunityContract({ ...staticWindow, scoring_system_version: scoringSystemVersion }).ok, false);
  assert.equal(validateOpportunityContract({ ...apiWindow, modelVersion: scoringSystemVersion }).ok, false);
  assert.equal(validateOpportunityContract({ ...staticWindow, ...apiWindow }).ok, false);
  assert.equal(validateOpportunityContract({
    ...common,
    siteId: "test-pier",
    start_time: apiWindow.start_time,
    end_time: apiWindow.end_time,
    score: 82,
    modelVersion: scoringSystemVersion,
    confidence: "medium",
  }).ok, false);
  assert.equal(validateOpportunityContract({ ...apiWindow, model_version: "wrong" }).ok, false);
  assert.equal(validateOpportunityContract({ ...staticWindow, confidence: { level: "medium" } }).ok, false);
  assert.equal(validateOpportunityContract({ ...apiWindow, confidence: "medium" }).ok, false);
  const incompleteStatic: Record<string, unknown> = { ...staticWindow };
  delete incompleteStatic.end;
  assert.equal(validateOpportunityContract(incompleteStatic).ok, false);
});
