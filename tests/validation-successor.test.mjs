import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  activationCommitmentSha256,
  verifyActivationSemantics,
  verifySuccessor,
} from "../scripts/verify-validation-successor.mjs";

const root = new URL("../", import.meta.url);
const PROTOCOL_SCHEMA_ID = "castingcompass.validation-feasibility-pilot/2.0.0";
const ACTIVATION_SCHEMA_ID = "castingcompass.validation-feasibility-activation/2.0.0";
const PROTOCOL_ID = "california-halibut-collection-feasibility-v2";
const SITE_CATALOG_SHA256 = "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const COMMIT = "1".repeat(40);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validator(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertNoPlaceholders(value, location = "$") {
  if (typeof value === "string") {
    assert.doesNotMatch(
      value,
      /\b(?:tbd|todo|fixme|placeholder|replace[_ -]?me|replace with)\b/i,
      location,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPlaceholders(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoPlaceholders(entry, `${location}.${key}`);
    }
  }
}

function activationExample() {
  return {
    schema_version: ACTIVATION_SCHEMA_ID,
    activation_id: "california-halibut-feasibility-activation-example",
    protocol_id: PROTOCOL_ID,
    protocol_version: "2.0.0",
    protocol_sha256: DIGEST_A,
    protocol_release_commit: COMMIT,
    created_at: "2026-09-02T02:00:00Z",
    enrollment: {
      start_at: "2026-10-01T00:00:00Z",
      end_at: "2027-03-30T00:00:00Z",
      boundary_convention: "half-open-start-inclusive-end-exclusive",
      fixed_before_first_row: true,
    },
    preregistration: {
      provider: "osf-registration",
      registration_url: "https://osf.io/abc12/",
      registration_id: "osf-abc12",
      registered_at: "2026-09-03T00:00:00Z",
      visibility: "public",
      registered_artifact_sha256: DIGEST_C,
      read_only_after_submission: true,
      receipt_verified_at: "2026-09-03T01:00:00Z",
      receipt_verified_by_role: "data-steward",
      registered_artifact_download_sha256: DIGEST_C,
      artifact_archive_id: "osf-abc12-activation-commitment-archive",
    },
    release: {
      release_commit: COMMIT,
      worker_version_id: "cloudflare-worker-version-2026-09-05",
      deployed_at: "2026-09-01T00:00:00Z",
      deployed_before_first_eligible_row: true,
      runtime_capture_acceptance_passed_at: "2026-09-02T01:00:00Z",
    },
    contracts: {
      taxon_catalog: "castingcompass.taxa/1.0.0",
      observation: "castingcompass.observation/2.0.0",
      model_run: "castingcompass.model-run/2.0.0",
      opportunity: "castingcompass.opportunity/2.0.0",
      storage_schema: "castingcompass.validation-feasibility-storage/2.0.0",
    },
    site_catalog_sha256: SITE_CATALOG_SHA256,
    scoring_system: {
      kind: "heuristic-configuration",
      version: "heuristic-california-halibut-example",
      sha256: DIGEST_B,
      frozen_for_pilot: true,
    },
    governance: {
      study_consent_version: "castingcompass-study-consent-2026-09",
      data_steward_approval: {
        approved_at: "2026-08-27T00:00:00Z",
        policy_or_notice_version: "castingcompass-data-plan-2026-09",
        approved_by_role: "data-steward",
      },
      privacy_approval: {
        approved_at: "2026-08-28T00:00:00Z",
        policy_or_notice_version: "castingcompass-privacy-2026-09",
        approved_by_role: "privacy-reviewer",
      },
      legal_approval: {
        approved_at: "2026-08-29T00:00:00Z",
        policy_or_notice_version: "castingcompass-study-notice-2026-09",
        approved_by_role: "legal-reviewer",
      },
    },
    storage: {
      encrypted_at_rest: true,
      least_privilege_access_reviewed: true,
      daily_snapshot_destination: "private-r2-validation-backups",
      daily_snapshot_checksum_algorithm: "sha256",
      restore_tested_at: "2026-09-04T00:00:00Z",
      deletion_reconciliation_tested_at: "2026-09-04T01:00:00Z",
      retention_days: 730,
    },
    status: "sealed-before-enrollment",
  };
}

test("freezes a strict collection-feasibility protocol without model-performance claims", async () => {
  const [schema, protocol, siteCatalogBytes] = await Promise.all([
    readJson("contracts/validation-feasibility-pilot.schema.json"),
    readJson("validation/protocols/california-halibut-collection-feasibility-v2.json"),
    readFile(new URL("public/data/sites.json", root)),
  ]);
  assert.equal(schema.$id, PROTOCOL_SCHEMA_ID);
  const validate = validator(schema);
  assert.equal(validate(protocol), true, JSON.stringify(validate.errors, null, 2));
  assertNoPlaceholders(protocol);

  assert.equal(protocol.protocol_id, PROTOCOL_ID);
  assert.equal(protocol.status, "frozen-local-not-activated");
  assert.equal(protocol.supersedes_for_activation, "california-halibut-site-window-v1");
  assert.equal(protocol.population.curated_site_catalog_sha256, sha256(siteCatalogBytes));
  assert.equal(protocol.purpose_and_claim_boundary.candidate_performance_evaluation_allowed, false);
  assert.equal(protocol.purpose_and_claim_boundary.candidate_baseline_comparison_allowed, false);
  assert.equal(protocol.purpose_and_claim_boundary.model_promotion_allowed, false);
  assert.equal(protocol.purpose_and_claim_boundary.pilot_rows_eligible_for_future_confirmatory_testing, false);
  assert.equal(protocol.feasibility_endpoints.candidate_score_outcome_association_computed, false);
  assert.equal(protocol.confirmatory_handoff.pilot_rows_excluded, true);
  assert.equal(protocol.confirmatory_handoff.promotion_before_confirmatory_pass_allowed, false);
});

test("replaces the unavailable per-event proof stack with a bounded activation gate", async () => {
  const [schema, protocol] = await Promise.all([
    readJson("contracts/validation-feasibility-pilot.schema.json"),
    readJson("validation/protocols/california-halibut-collection-feasibility-v2.json"),
  ]);
  const validate = validator(schema);
  assert.equal(protocol.activation.external_timestamped_preregistration_provider, "osf-registration");
  assert.equal(protocol.activation.per_event_external_transparency_log_required, false);
  assert.equal(protocol.activation.independent_publication_service_required, false);
  assert.equal(protocol.activation.must_precede_first_eligible_row, true);
  assert.equal(protocol.activation.backdating_prohibited, true);
  assert.equal(protocol.activation.minimum_duration_days, 90);
  assert.equal(protocol.activation.maximum_duration_days, 365);

  const weakened = structuredClone(protocol);
  weakened.purpose_and_claim_boundary.candidate_performance_evaluation_allowed = true;
  assert.equal(validate(weakened), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "const"));

  const unbounded = structuredClone(protocol);
  unbounded.activation.per_event_external_transparency_log_required = true;
  assert.equal(validate(unbounded), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "const"));
});

test("defines a strict, outcome-blind activation envelope and semantic chronology", async () => {
  const [schema, protocolBytes, siteCatalogBytes] = await Promise.all([
    readJson("contracts/validation-feasibility-activation.schema.json"),
    readFile(new URL("validation/protocols/california-halibut-collection-feasibility-v2.json", root)),
    readFile(new URL("public/data/sites.json", root)),
  ]);
  const protocol = JSON.parse(protocolBytes.toString("utf8"));
  assert.equal(schema.$id, ACTIVATION_SCHEMA_ID);
  const validate = validator(schema);
  const activation = activationExample();
  activation.protocol_sha256 = sha256(protocolBytes);
  activation.preregistration.registered_artifact_sha256 = activationCommitmentSha256(activation);
  activation.preregistration.registered_artifact_download_sha256 =
    activation.preregistration.registered_artifact_sha256;
  assert.equal(validate(activation), true, JSON.stringify(validate.errors, null, 2));
  verifyActivationSemantics(activation, protocolBytes, protocol, siteCatalogBytes);

  const extra = structuredClone(activation);
  extra.unreviewed_override = true;
  assert.equal(validate(extra), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "additionalProperties"));

  const wrongRole = structuredClone(activation);
  wrongRole.governance.legal_approval.approved_by_role = "data-steward";
  assert.equal(validate(wrongRole), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "const"));

  const tooShort = structuredClone(activation);
  tooShort.enrollment.end_at = "2026-10-30T00:00:00Z";
  assert.throws(() =>
    verifyActivationSemantics(tooShort, protocolBytes, protocol, siteCatalogBytes),
  );

  const lateRegistration = structuredClone(activation);
  lateRegistration.preregistration.registered_at = lateRegistration.enrollment.start_at;
  assert.throws(() =>
    verifyActivationSemantics(lateRegistration, protocolBytes, protocol, siteCatalogBytes),
  );

  const changedAfterRegistration = structuredClone(activation);
  changedAfterRegistration.enrollment.end_at = "2027-03-31T00:00:00Z";
  assert.throws(() =>
    verifyActivationSemantics(
      changedAfterRegistration,
      protocolBytes,
      protocol,
      siteCatalogBytes,
    ),
  );

  const wrongDownloadedArtifact = structuredClone(activation);
  wrongDownloadedArtifact.preregistration.registered_artifact_download_sha256 = DIGEST_C;
  assert.throws(() =>
    verifyActivationSemantics(
      wrongDownloadedArtifact,
      protocolBytes,
      protocol,
      siteCatalogBytes,
    ),
  );
});

test("operator verifier accepts the frozen protocol while leaving activation closed", async () => {
  const result = await verifySuccessor();
  assert.match(result.protocolSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.activationVerified, false);
});

test("documents the local 730-day storage candidate without opening the activation gate", async () => {
  const [storage, successor, roadmap] = await Promise.all([
    readFile(new URL("docs/VALIDATION-STORAGE.md", root), "utf8"),
    readFile(new URL("docs/VALIDATION-SUCCESSOR.md", root), "utf8"),
    readFile(new URL("docs/PRODUCT_ROADMAP.md", root), "utf8"),
  ]);
  assert.match(storage, /tested technical candidate, not an approved policy/i);
  assert.match(storage, /technical_validation_snapshot_restore_passed: true/);
  assert.match(storage, /governance_approval_recorded: false/);
  assert.match(storage, /validation_snapshot_and_restore_gate_passed: false/);
  assert.match(successor, /- \[x\] Implement and locally verify a separate 730-day/);
  assert.match(successor, /- \[ \] Configure encrypted daily snapshots/);
  assert.match(successor, /- \[ \] Obtain privacy\/legal\/data-steward approval/);
  assert.match(roadmap, /- \[x\] Locally implement and verify the separate 730-day/);
  assert.match(roadmap, /- \[ \] Approve the 730-day validation-only snapshot/);
});

test("operator verifier accepts a complete externally committed activation wrapper", async () => {
  const protocolBytes = await readFile(
    new URL("validation/protocols/california-halibut-collection-feasibility-v2.json", root),
  );
  const activation = activationExample();
  activation.protocol_sha256 = sha256(protocolBytes);
  activation.preregistration.registered_artifact_sha256 = activationCommitmentSha256(activation);
  activation.preregistration.registered_artifact_download_sha256 =
    activation.preregistration.registered_artifact_sha256;

  const directory = await mkdtemp(join(tmpdir(), "castingcompass-successor-"));
  const activationPath = join(directory, "activation.json");
  try {
    await writeFile(activationPath, `${JSON.stringify(activation, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const result = await verifySuccessor({ activationPath });
    assert.equal(result.protocolSha256, activation.protocol_sha256);
    assert.equal(result.activationVerified, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps starts, skunks, source provenance, and privacy rights in the pilot contract", async () => {
  const protocol = await readJson(
    "validation/protocols/california-halibut-collection-feasibility-v2.json",
  );
  const required = new Set(protocol.collection.required_fields);
  for (const field of [
    "participant_group_id",
    "target_taxon_id",
    "effort_minutes",
    "target_encountered",
    "score_influenced_choice",
    "recruitment_source_id",
    "scoring_system_sha256",
    "source_record_sha256",
  ]) {
    assert.equal(required.has(field), true, `${field} must be collected`);
  }
  assert.equal(protocol.population.complete_attempts_including_non_encounters_required, true);
  assert.equal(protocol.collection.all_started_attempts_reconciled, true);
  assert.equal(protocol.collection.cancellation_not_encoded_as_non_encounter, true);
  assert.equal(protocol.recruitment.outcome_dependent_recruitment_allowed, false);
  assert.equal(protocol.recruitment.outcome_dependent_incentive_allowed, false);
  assert.equal(protocol.privacy.participant_token.deletion_linked, true);
  assert.equal(protocol.privacy.account_export_supported, true);
  assert.equal(protocol.privacy.withdrawal_supported, true);
  assert.equal(protocol.privacy.account_deletion_supported, true);
  assert.deepEqual(protocol.privacy.prohibited_fields, [
    "email",
    "raw_account_id",
    "precise_coordinates",
    "raw_notes",
    "photo_bytes",
    "device_advertising_id",
    "ip_address",
    "user_agent",
  ]);
});

test("freezes non-adaptive feasibility gates and a separate confirmatory handoff", async () => {
  const protocol = await readJson(
    "validation/protocols/california-halibut-collection-feasibility-v2.json",
  );
  const gates = protocol.exit_rule.feasibility_gates;
  assert.equal(protocol.exit_rule.stop_rule, "activation-manifest-fixed-end");
  assert.equal(protocol.exit_rule.early_success_stop_allowed, false);
  assert.equal(protocol.exit_rule.outcome_adaptive_stop_allowed, false);
  assert.equal(gates.minimum_complete_attempts, 100);
  assert.equal(gates.minimum_unique_participant_groups, 50);
  assert.equal(gates.minimum_target_encounters, 10);
  assert.equal(gates.minimum_non_encounters, 50);
  assert.equal(gates.minimum_completion_rate, 0.8);
  assert.equal(gates.minimum_reconciliation_rate, 1);
  assert.equal(gates.maximum_required_field_missingness, 0.02);
  assert.equal(gates.maximum_single_participant_share, 0.1);
  assert.equal(protocol.exit_rule.unmet_gate_result, "collection-feasibility-not-demonstrated");
  assert.ok(
    protocol.confirmatory_handoff.required_confirmatory_elements.includes(
      "separate-timestamped-preregistration-before-confirmatory-enrollment",
    ),
  );
});

test("documents v1 as inactive, records local ledger progress, and leaves activation closed", async () => {
  const [v1, successor, roadmap, pipelineReadme, modelCard, architecture, storage] = await Promise.all([
    readFile(new URL("docs/VALIDATION-PROTOCOL.md", root), "utf8"),
    readFile(new URL("docs/VALIDATION-SUCCESSOR.md", root), "utf8"),
    readFile(new URL("docs/PRODUCT_ROADMAP.md", root), "utf8"),
    readFile(new URL("pipeline/README.md", root), "utf8"),
    readFile(new URL("docs/MODEL_CARD.md", root), "utf8"),
    readFile(new URL("docs/ARCHITECTURE.md", root), "utf8"),
    readFile(new URL("docs/VALIDATION-STORAGE.md", root), "utf8"),
  ]);
  assert.match(v1, /do not activate v1/i);
  assert.match(v1, /supersedes it for any\s+future activation/i);
  assert.match(successor, /not activated/i);
  assert.match(successor, /Candidate score\/outcome associations[^.]+are not\s+computed/is);
  assert.match(successor, /- \[x\] Freeze and test the local protocol and activation schemas/);
  assert.match(successor, /- \[x\] Implement the server-authoritative start, completion, cancellation,/);
  assert.match(successor, /- \[x\] Implement the privacy-safe deletion-linked participant token/);
  assert.match(successor, /- \[x\] Implement the append-only event ledger/);
  assert.match(successor, /- \[ \] Submit the exact protocol artifact to OSF/);
  assert.match(successor, /89-day full-D1 operational path\s+remains separate and cannot satisfy this gate/is);
  assert.match(roadmap, /- \[x\] Freeze and locally verify the v2 successor schemas/);
  assert.match(roadmap, /- \[x\] Locally implement and verify the default-off v2 start\/completion\/safe-cancellation/);
  assert.match(roadmap, /- \[x\] Locally implement and verify append-only correction handling/);
  assert.match(roadmap, /an HMAC invitation alone is\s+not treated as proof of issue time/i);
  assert.match(successor, /No post-outcome change may reclassify pilot rows as confirmatory evidence/i);
  assert.match(pipelineReadme, /Historical v1 site-window validation — do not activate/);
  assert.match(pipelineReadme, /No command below satisfies those gates/);
  assert.match(modelCard, /No run may claim evidence under historical v1 or the v2 feasibility pilot/);
  assert.match(architecture, /V2 retains the same source IDs for feasibility reporting but performs no pooled\s+candidate analysis/);
  assert.match(storage, /Do not solve\s+this by silently retaining full account exports or broader account data for 730 days/i);
  assert.match(storage, /validation_snapshot_and_restore_gate_passed: false/);
});
