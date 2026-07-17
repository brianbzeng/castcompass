import assert from "node:assert/strict";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../", import.meta.url);
const PROTOCOL_SCHEMA_ID = "castingcompass.validation-preregistration/1.0.0";
const SPLIT_SCHEMA_ID = "castingcompass.validation-split-manifest/1.0.0";
const PROTOCOL_ID = "california-halibut-site-window-v1";
const SITE_CATALOG_SHA256 = "b0378742f40cca598c57d845fb683ab9b36068cdd69de541aeb3e45d93c31860";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

const EXPECTED_PANELS = {
  "north-coast": [
    "limantour-beach",
    "drakes-beach",
    "point-reyes-south-beach",
    "bolinas-beach",
    "stinson-beach",
    "muir-beach",
    "rodeo-beach",
  ],
  "golden-gate-sf-coast": [
    "fort-baker-pier",
    "torpedo-wharf",
    "crissy-field-east-beach",
    "baker-beach",
    "china-beach",
    "ocean-beach-north",
    "ocean-beach-south",
  ],
  "north-east-bay": [
    "mcnears-beach-pier",
    "paradise-beach-pier",
    "ferry-point-pier",
    "keller-beach",
    "point-isabel-shoreline",
    "albany-bulb",
    "berkeley-marina-north-basin",
    "cesar-chavez-park",
    "emeryville-marina-pier",
  ],
  "central-south-bay": [
    "pier-7",
    "pier-14",
    "crane-cove-park",
    "herons-head-park-pier",
    "port-view-park-pier",
    "middle-harbor-shoreline",
    "alameda-south-shore-rockwall",
    "crown-memorial-state-beach",
    "oyster-bay-shoreline",
    "san-leandro-marina-shore",
    "dumbarton-pier",
    "coyote-point-jetty",
    "seal-point-park",
    "oyster-point-fishing-pier",
  ],
  "san-mateo-coast": [
    "sharp-park-beach",
    "rockaway-beach",
    "pacifica-state-beach",
    "montara-state-beach",
    "pillar-point-west-jetty",
    "pillar-point-east-jetty",
    "surfers-beach",
    "francis-state-beach",
    "poplar-beach",
  ],
};

const EXPECTED_BLOCKS = [
  ["block-1", "2026-08-01T00:00:00Z", "2026-11-01T00:00:00Z", "baseline-development"],
  ["block-2", "2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z", "baseline-development"],
  ["block-3", "2027-02-01T00:00:00Z", "2027-05-01T00:00:00Z", "locked-primary-test"],
  ["block-4", "2027-05-01T00:00:00Z", "2027-08-01T00:00:00Z", "locked-primary-test"],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function impressionAttestationPayload(item) {
  const evidence = item.evidence;
  return {
    protocol_id: evidence.collection_validation_protocol_id,
    protocol_version: "1.0.0",
    activation_manifest_sha256: evidence.activation_manifest_sha256,
    assignment_id: item.assignment_id,
    source_record_sha256: item.source_record_sha256,
    participant_group_id: item.participant_group_id,
    activation_activated_at: evidence.collection_activated_at,
    intended_cohort_role: evidence.intended_cohort_role,
    intended_source_role: evidence.intended_source_role,
    selection_design: item.selection_design,
    selection_method: evidence.intended_selection_method,
    intended_cohort_id: evidence.intended_cohort_id,
    target_taxon_id: evidence.target_taxon_id,
    recruitment_frame_id: evidence.recruitment_frame_id,
    recruitment_source_id: evidence.recruitment_source_id,
    recruitment_event_contract_version: evidence.recruitment_event_contract_version,
    recruitment_event_at: evidence.recruitment_event_at,
    recruitment_event_sha256: evidence.recruitment_event_sha256,
    community_approval_sha256: evidence.community_approval_sha256,
    incentive_policy_id: evidence.incentive_policy_id,
    score_influenced_choice_at_assignment: evidence.score_influenced_choice,
    study_consent_version: evidence.study_consent_version,
    study_consent_at: evidence.study_consent_at,
    target_intent_confirmed_at: evidence.target_intent_confirmed_at,
    precommitment_event_sha256: evidence.precommitment_event_sha256,
    feasible_set_sha256: evidence.feasible_set_sha256,
    feasible_option_count: evidence.feasible_option_count,
    assignment_probability_numerator: evidence.assignment_probability_numerator,
    assignment_probability_denominator: evidence.assignment_probability_denominator,
    randomization_draw_index: evidence.randomization_draw_index,
    randomization_audit_sha256: evidence.randomization_audit_sha256,
    forecast_impression_id: evidence.forecast_impression_id,
    opportunity_window_id: evidence.opportunity_window_id,
    site_id: item.site_id,
    window_start_at: evidence.window_start_at,
    window_end_at: evidence.window_end_at,
    opportunity_score: item.opportunity_score,
    snapshot_sha256: evidence.snapshot_sha256,
    site_catalog_sha256: evidence.site_catalog_sha256,
    scoring_system_kind: evidence.scoring_system_kind,
    scoring_system_version: evidence.scoring_system_version,
    scoring_system_sha256: evidence.scoring_system_sha256,
    opportunity_contract_version: evidence.opportunity_contract_version,
    impression_or_assignment_at: evidence.impression_or_assignment_at,
    score_exposure_state_at_attestation: evidence.intended_cohort_role === "secondary" ? "already-exposed" : "not-yet-exposed",
    score_first_exposed_at_if_already_exposed: evidence.intended_cohort_role === "secondary" ? evidence.score_first_exposed_at : null,
    attested_at: evidence.impression_or_assignment_at,
  };
}

function scoreExposureAttestationPayload(item) {
  const evidence = item.evidence;
  return {
    protocol_id: evidence.collection_validation_protocol_id,
    protocol_version: "1.0.0",
    activation_manifest_sha256: evidence.activation_manifest_sha256,
    assignment_id: item.assignment_id,
    source_record_sha256: item.source_record_sha256,
    participant_group_id: item.participant_group_id,
    selection_design: item.selection_design,
    impression_attestation_sha256: evidence.impression_attestation_sha256,
    forecast_impression_id: evidence.forecast_impression_id,
    opportunity_window_id: evidence.opportunity_window_id,
    site_id: item.site_id,
    window_start_at: evidence.window_start_at,
    window_end_at: evidence.window_end_at,
    opportunity_score: item.opportunity_score,
    snapshot_sha256: evidence.snapshot_sha256,
    site_catalog_sha256: evidence.site_catalog_sha256,
    scoring_system_kind: evidence.scoring_system_kind,
    scoring_system_version: evidence.scoring_system_version,
    scoring_system_sha256: evidence.scoring_system_sha256,
    opportunity_contract_version: evidence.opportunity_contract_version,
    score_first_exposed_at: evidence.score_first_exposed_at,
    attested_at: evidence.score_first_exposed_at,
  };
}

function assertNoPlaceholders(value, location = "$") {
  if (typeof value === "string") {
    assert.doesNotMatch(value, /\b(?:tbd|todo|fixme|placeholder|replace[_ -]?me|replace with)\b/i, location);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPlaceholders(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertNoPlaceholders(entry, `${location}.${key}`);
  }
}

function assertProtocolSemantics(protocol, siteCatalogBytes, sites) {
  assert.equal(protocol.schema_version, PROTOCOL_SCHEMA_ID);
  assert.equal(protocol.protocol_id, PROTOCOL_ID);
  assert.equal(protocol.protocol_version, "1.0.0");
  assert.equal(protocol.status, "frozen");
  assert.equal(protocol.based_on_commit, "13e71bb312bd0c1ac008246240cf7f884d21ac01");
  assert.equal(protocol.frozen_at, "2026-07-16");
  assert.equal(protocol.hash_anchor.method, "containing-git-commit");
  assert.equal(protocol.hash_anchor.self_referential_hash, false);
  assertNoPlaceholders(protocol);

  assert.equal(protocol.activation.manifest_contract_version, SPLIT_SCHEMA_ID);
  assert.equal(protocol.activation.must_be_sealed_and_deployed_before_first_eligible_row, true);
  assert.equal(protocol.activation.backdating_prohibited, true);
  assert.equal(protocol.activation.pre_activation_rows_role, "exploratory-only");
  assert.equal(protocol.activation.external_log_anchor_identity_pinned_in_activation, true);
  assert.equal(protocol.activation.external_log_anchor_key_must_differ_from_export_key, true);
  assert.equal(protocol.evaluator_runtime.python_major_minor, "3.12");
  assert.equal(protocol.evaluator_runtime.immutable_runtime_image_required, true);
  assert.equal(protocol.evaluator_runtime.independent_publication_recomputation_required, true);
  assert.equal(protocol.enrollment.start_at, EXPECTED_BLOCKS[0][1]);
  assert.equal(protocol.enrollment.end_at, EXPECTED_BLOCKS.at(-1)[2]);
  assert.equal(protocol.enrollment.boundary_convention, "half-open-start-inclusive-end-exclusive");
  assert.ok(Date.parse(protocol.enrollment.start_at) > Date.parse(`${protocol.frozen_at}T00:00:00Z`));
  assert.ok(Date.parse(protocol.enrollment.end_at) > Date.parse(protocol.enrollment.start_at));
  assert.equal(protocol.enrollment.outcome_independent, true);
  assert.equal(protocol.enrollment.early_success_stop_allowed, false);

  assert.equal(protocol.target_and_claim.target_taxon_id, "california-halibut");
  assert.deepEqual(protocol.target_and_claim.contract_versions, {
    taxon_catalog: "castingcompass.taxa/1.0.0",
    observation: "castingcompass.observation/2.0.0",
    model_run: "castingcompass.model-run/2.0.0",
    opportunity: "castingcompass.opportunity/2.0.0",
  });
  assert.equal(protocol.target_and_claim.score_semantics, "ordinal-relative-ranking-0-to-100");
  for (const prohibited of ["catch-probability", "probability-calibration", "exact-point-or-casting-zone-skill", "safety-or-navigational-guidance"]) {
    assert.ok(protocol.target_and_claim.prohibited_claims.includes(prohibited));
  }

  assert.deepEqual(protocol.cohorts.primary.allowed_selection_designs, [
    "prospective-precommitted-without-score",
    "prospective-safely-randomized",
  ]);
  assert.equal(protocol.cohorts.primary.authoritative_pre_outcome_impression_or_assignment_required, true);
  assert.equal(protocol.cohorts.primary.score_visible_self_selection_allowed, false);
  assert.equal(protocol.cohorts.primary.past_report_allowed, false);
  assert.equal(protocol.cohorts.primary.role, "prospective-primary");
  assert.equal(protocol.cohorts.primary.precommitment.durable_server_event_required, true);
  assert.equal(protocol.cohorts.primary.precommitment.must_precede_score_exposure, true);
  assert.equal(protocol.cohorts.primary.safe_randomization.allocation, "uniform-one-of-declared-feasible-options");
  assert.equal(protocol.cohorts.primary.safe_randomization.single_durable_draw, true);
  assert.equal(protocol.cohorts.primary.safe_randomization.redraw_allowed, false);
  assert.equal(
    protocol.cohorts.primary.safe_randomization.safe_refusal_role,
    "unsealed-safe-canceled-not-negative-outcome",
  );
  assert.deepEqual(protocol.cohorts.secondary.allowed_selection_designs, ["prospective-score-visible-self-selected"]);
  assert.equal(protocol.cohorts.secondary.influence_answer_changes_role, false);
  assert.equal(protocol.cohorts.incentives.policy, "none-v1");
  for (const source of ["pre-freeze-trip", "pre-activation-trip", "past-report", "legacy-unverified", "official-aggregate-or-context"]) {
    assert.ok(protocol.cohorts.exploratory.sources.includes(source));
  }
  assert.deepEqual(protocol.recruitment, {
    frame_id: "california-halibut-site-window-recruitment-v1",
    event_contract_version: "castingcompass.recruitment-event/1.0.0",
    event_hash_method: "castingcompass-canonical-json/1.0.0-sha256",
    event_payload_fields: [
      "participant_group_id",
      "recruitment_frame_id",
      "recruitment_source_id",
      "recruitment_event_at",
      "community_approval_sha256",
    ],
    allowed_source_ids: [
      "castingcompass-organic-product",
      "direct-opt-in-research-invite",
      "admin-approved-community-prospective",
    ],
    source_assignment_rule: "first-eligible-pre-outcome-recruitment-event-wins-and-is-immutable",
    inclusion_rule: "consecutive-every-eligible-accepted-row-in-fixed-interval",
    outcome_adaptive_quotas_allowed: false,
    community_approval_rule: "sha256-required-only-for-admin-approved-community-prospective",
    pooled_primary_analysis: true,
    required_stratified_reporting: [
      "recruitment-source-id",
      "selection-design",
      "recruitment-source-id-by-selection-design",
    ],
    trusted_export_query_id: "castingcompass-fixed-interval-eligibility-census-v1",
    trusted_export_record_order_field: "export_ordinal",
    trusted_export_requires_consecutive_export_ordinal: true,
    trusted_export_requires_per_source_and_status_counts: true,
    trusted_export_eligible_omissions_allowed: false,
    issuance_reconciliation_query_id: "castingcompass-terminal-issuance-exposure-reconciliation-v1",
    issuance_stream_id: "castingcompass-assignment-issuance-v1",
    exposure_stream_id: "castingcompass-signed-primary-score-exposure-v1",
    issuance_reconciliation_evidence_basis: "signed-exporter-assertion-without-raw-ledger-proof",
    append_only_log_proof_included_in_local_freeze: false,
    production_requires_external_append_only_log_proof: true,
  });

  assert.equal(protocol.eligibility.observation_contract_status, "valid");
  assert.equal(protocol.eligibility.complete_attempt_required, true);
  assert.equal(protocol.eligibility.expanded_estimate_allowed, false);
  assert.deepEqual(new Set(protocol.eligibility.supported_modes), new Set(["shore", "beach", "pier", "jetty"]));
  assert.equal(protocol.eligibility.spatial_support_kind, "site");
  assert.equal(protocol.eligibility.authoritative_window_duration_minutes, 120);
  assert.equal(protocol.eligibility.entire_segment_within_one_authoritative_window, true);
  assert.equal(protocol.eligibility.outcome_dependent_verification_gate_allowed, false);
  assert.equal(protocol.eligibility.photo_required, false);
  assert.equal(protocol.eligibility.exact_coordinates_allowed, false);
  for (const field of ["scoring_system_sha256", "snapshot_sha256", "site_catalog_sha256", "window_start_at", "window_end_at"]) {
    assert.ok(protocol.eligibility.server_bound_identity_fields.includes(field));
  }
  for (const field of ["selection_design", "score_influenced_choice", "study_consent_version", "target_intent_confirmed_at", "impression_or_assignment_at"]) {
    assert.ok(protocol.eligibility.immutable_pre_outcome_fields.includes(field));
  }
  assert.equal(
    protocol.eligibility.score_exposure_attestation_contract.attested_at_rule,
    "equals-score-first-exposed-at-strictly-after-assignment-and-at-or-before-reconciliation-watermark",
  );
  assert.equal(
    protocol.eligibility.score_exposure_attestation_contract.sealed_row_admission_rule,
    "score-first-exposed-at-and-attested-at-must-both-be-strictly-before-segment-start",
  );
  const terminalContract = protocol.eligibility.terminal_issuance_reconciliation_contract;
  assert.ok(terminalContract.record_fields.includes("reconciliation_watermark_at"));
  assert.equal(
    terminalContract.terminal_snapshot_rule,
    "reconciliation-watermark-at-equals-reconciled-through-at-and-is-not-an-event-occurrence-time",
  );
  assert.equal(terminalContract.external_log_proof_interface.implementation_status, "not-implemented-production-blocker");
  assert.equal(terminalContract.external_log_proof_interface.maximum_assignment_anchor_delay_seconds, 300);
  assert.equal(terminalContract.external_log_proof_interface.maximum_exposure_anchor_delay_seconds, 300);
  assert.equal(
    terminalContract.external_log_proof_interface.exposure_inclusion_deadline,
    "each-signed-exposure-included-within-300-seconds-of-score-first-exposed-at-and-exposures-admitted-into-the-sealed-label-free-row-strictly-before-segment-start",
  );
  assert.equal(
    terminalContract.external_log_proof_interface.terminal_checkpoint_rule,
    "covers-every-issuance-and-exposure-event-through-reconciled-through-at-and-is-anchored-at-or-after-that-watermark-and-within-300-seconds-including-zero-size-streams",
  );
  assert.ok(terminalContract.external_log_proof_interface.required_artifact_fields.includes("effort_boundary_events"));
  assert.deepEqual(protocol.split_policy.deletion_status_reason_map, {
    withdrawn: ["participant-withdrawal"],
    deleted: ["account-deletion"],
    excluded: ["post_completion_profile_edit", "trusted_review_exclusion"],
  });
  assert.equal(protocol.split_policy.deletion_first_removal_semantics, "immutable-first-event-for-analytical-accounting");
  assert.equal(protocol.split_policy.deletion_latest_status_semantics, "latest-monotone-privacy-state-for-current-counts");

  assert.equal(sha256(siteCatalogBytes), SITE_CATALOG_SHA256);
  assert.equal(protocol.geography.site_catalog_sha256, SITE_CATALOG_SHA256);
  assert.equal(protocol.geography.eligible_site_count, 46);
  assert.deepEqual(protocol.geography.excluded_sites, [{ site_id: "pacifica-municipal-pier", reason: "no-emitted-opportunity-windows" }]);
  const actualPanels = Object.fromEntries(protocol.geography.panels.map((panel) => [panel.panel_id, panel.site_ids]));
  assert.deepEqual(actualPanels, EXPECTED_PANELS);
  const protocolSites = protocol.geography.panels.flatMap((panel) => panel.site_ids);
  assert.equal(protocolSites.length, 46);
  assert.equal(new Set(protocolSites).size, 46);
  const catalogSites = sites.map((site) => site.id);
  assert.equal(catalogSites.length, 47);
  assert.deepEqual(new Set(protocolSites), new Set(catalogSites.filter((siteId) => siteId !== "pacifica-municipal-pier")));

  assert.deepEqual(
    protocol.temporal_design.blocks.map((block) => [block.block_id, block.start_at, block.end_at, block.role]),
    EXPECTED_BLOCKS,
  );
  assert.equal(protocol.temporal_design.boundary_convention, "half-open-start-inclusive-end-exclusive");
  for (let index = 1; index < protocol.temporal_design.blocks.length; index += 1) {
    assert.equal(
      Date.parse(protocol.temporal_design.blocks[index - 1].end_at),
      Date.parse(protocol.temporal_design.blocks[index].start_at),
    );
  }
  assert.deepEqual(protocol.temporal_design.development_blocks, ["block-1", "block-2"]);
  assert.deepEqual(protocol.temporal_design.locked_test_blocks, ["block-3", "block-4"]);
  assert.equal(protocol.temporal_design.test_is_unseen_geography_and_later_time, true);

  assert.equal(protocol.baselines.selection_data, "development-blocks-only");
  assert.equal(protocol.baselines.selection_metric, "mean-leave-one-panel-out-auroc");
  assert.deepEqual(protocol.baselines.tie_break_order, [
    "prevalence-only",
    "calendar-mode-effort-logistic",
    "site-calendar-mode-effort-logistic",
  ]);
  assert.deepEqual(protocol.baselines.definitions.map((baseline) => baseline.baseline_id), protocol.baselines.tie_break_order);
  for (const baseline of protocol.baselines.definitions.slice(1)) {
    assert.deepEqual(baseline.hyperparameters, {
      penalty: "l2",
      C: 1,
      solver: "liblinear",
      class_weight: null,
      fit_intercept: true,
      intercept_scaling: 1,
      tol: 0.0001,
      max_iter: 2000,
      random_state: 20260716,
    });
    assert.deepEqual(baseline.preprocessing_parameters, {
      numeric_standardization: "training-fold-population-standard-deviation-ddof-0",
      utc_day_of_year_cycle_denominator_days: 365.2425,
    });
    assert.match(baseline.preprocessing, /fit-on-training-only/);
    assert.match(baseline.fallback, /training-prevalence/);
  }
  assert.equal(protocol.candidate.kind, "heuristic-configuration");
  assert.equal(protocol.candidate.single_scoring_identity_required, true);
  assert.equal(protocol.candidate.trained_or_tuned_on_locked_test, false);
  assert.equal(protocol.candidate.calibrated_probability_claimed, false);

  assert.equal(protocol.analysis.primary_metric, "auroc-concordance");
  assert.equal(protocol.analysis.paired_comparison, "candidate-minus-strongest-development-baseline");
  assert.deepEqual(new Set(protocol.analysis.probability_metrics_prohibited_for_candidate), new Set([
    "brier", "log-loss", "expected-calibration-error", "probability-calibration",
  ]));
  assert.equal(protocol.analysis.bootstrap.resamples, 2000);
  assert.equal(protocol.analysis.bootstrap.random_state, 20260716);
  assert.equal(protocol.analysis.bootstrap.method, "paired-global-participant-cluster-bootstrap");
  assert.deepEqual(protocol.analysis.bootstrap.strata, []);
  assert.equal(protocol.analysis.bootstrap.participant_rows_stay_together_across_all_panels_and_blocks, true);
  assert.equal(protocol.analysis.bootstrap.bit_generator, "PCG64");
  assert.equal(protocol.analysis.bootstrap.percentile_method, "linear");
  assert.equal(
    protocol.analysis.inferential_secondary_adjustment,
    "not-applicable-no-secondary-hypothesis-tests",
  );
  assert.deepEqual(protocol.analysis.promotion_gate, {
    candidate_auroc_lower_95_gt: 0.5,
    paired_delta_point_gte: 0.05,
    paired_delta_lower_95_gt: 0,
    minimum_estimable_geography_auroc: 0.45,
  });

  assert.deepEqual(protocol.sample_plan, {
    design_description: "conservative-design-gates-not-a-power-guarantee",
    analysis_set_rule: "fixed-interval-census-of-every-eligible-accepted-row",
    accepted_attempt_gate_scope: "primary-only",
    operational_planning_target_accepted_attempts: 800,
    operational_target_controls_enrollment_or_analysis: false,
    post_hoc_subsampling_allowed: false,
    arrival_order_exclusion_allowed: false,
    minimum_total_accepted_attempts: 500,
    minimum_development_attempts_per_geography: 20,
    minimum_development_target_encounters_per_geography: 5,
    minimum_development_non_encounters_per_geography: 10,
    all_development_lopo_aurocs_must_be_estimable: true,
    minimum_locked_test_attempts: 200,
    minimum_locked_test_target_encounters: 40,
    minimum_locked_test_non_encounters: 80,
    minimum_test_attempts_per_geography: 20,
    minimum_locked_test_target_encounters_per_geography: 5,
    minimum_locked_test_non_encounters_per_geography: 10,
    minimum_attempts_per_locked_temporal_block: 75,
    minimum_total_unique_participant_groups: 250,
    minimum_total_effective_participant_groups: 200,
    minimum_development_unique_participant_groups: 100,
    minimum_development_effective_participant_groups: 75,
    minimum_locked_test_unique_participant_groups: 100,
    minimum_locked_test_effective_participant_groups: 75,
    minimum_development_target_encounter_participant_groups: 20,
    minimum_development_target_encounter_effective_participant_groups: 15,
    minimum_development_non_encounter_participant_groups: 40,
    minimum_development_non_encounter_effective_participant_groups: 30,
    minimum_locked_test_target_encounter_participant_groups: 20,
    minimum_locked_test_target_encounter_effective_participant_groups: 15,
    minimum_locked_test_non_encounter_participant_groups: 40,
    minimum_locked_test_non_encounter_effective_participant_groups: 30,
    minimum_development_unique_participant_groups_per_geography: 15,
    minimum_development_effective_participant_groups_per_geography: 12,
    minimum_locked_test_unique_participant_groups_per_geography: 15,
    minimum_locked_test_effective_participant_groups_per_geography: 12,
    minimum_development_target_encounter_participant_groups_per_geography: 5,
    minimum_development_target_encounter_effective_participant_groups_per_geography: 5,
    minimum_development_non_encounter_participant_groups_per_geography: 10,
    minimum_development_non_encounter_effective_participant_groups_per_geography: 10,
    minimum_locked_test_target_encounter_participant_groups_per_geography: 5,
    minimum_locked_test_target_encounter_effective_participant_groups_per_geography: 5,
    minimum_locked_test_non_encounter_participant_groups_per_geography: 10,
    minimum_locked_test_non_encounter_effective_participant_groups_per_geography: 10,
    minimum_unique_participant_groups_per_locked_temporal_block: 50,
    minimum_effective_participant_groups_per_locked_temporal_block: 40,
    minimum_unique_participant_groups_per_development_temporal_block: 50,
    minimum_effective_participant_groups_per_development_temporal_block: 40,
    maximum_single_participant_attempt_share_numerator: 1,
    maximum_single_participant_attempt_share_denominator: 10,
    participant_effective_group_formula: "kish-square-of-sum-attempt-counts-divided-by-sum-of-squared-participant-attempt-counts",
    participant_concentration_gate_scope: [
      "all-primary",
      "development-primary",
      "locked-test-primary",
      "development-primary-by-outcome-class",
      "locked-test-primary-by-outcome-class",
      "development-primary-by-geography",
      "locked-test-primary-by-geography",
      "development-primary-by-temporal-block",
      "locked-test-primary-by-temporal-block",
    ],
    insufficient_support_result: "inconclusive",
    all_locked_geography_aurocs_must_be_estimable: true,
    sample_gate_is_not_power_claim: true,
  });
  assert.equal(protocol.split_policy.created_outcome_blind, true);
  assert.equal(protocol.split_policy.assignments_regenerated_after_label_access, false);
  assert.equal(protocol.split_policy.deletion_reconciliation_required, true);
  assert.equal(protocol.privacy.precise_location_collection, false);
  assert.equal(protocol.reporting.publish_negative_result, true);
  assert.equal(protocol.reporting.publish_inconclusive_result, true);
  assert.equal(protocol.production_gate.local_artifacts_are_production_evidence, false);
}

function baseActivationManifest() {
  return {
    schema_version: SPLIT_SCHEMA_ID,
    manifest_id: "activation-1",
    manifest_role: "activation",
    sequence: 0,
    previous_manifest_sha256: null,
    protocol_id: PROTOCOL_ID,
    protocol_version: "1.0.0",
    protocol_sha256: DIGEST_A,
    site_catalog_sha256: SITE_CATALOG_SHA256,
    data_snapshot_sha256: null,
    prediction_snapshot_sha256: null,
    created_at: "2026-07-20T12:00:00Z",
    activated_at: "2026-07-20T12:00:00Z",
    labels_opened_at: null,
    outcome_blind: true,
    append_only: true,
    activation: {
      release_commit: "b".repeat(40),
      scoring_system_kind: "heuristic-configuration",
      scoring_system_version: `heuristic-california-halibut-${DIGEST_C}`,
      scoring_system_sha256: DIGEST_C,
      opportunity_contract_version: "castingcompass.opportunity/2.0.0",
      validation_export_signing_key_id: "validation-export-key-1",
      validation_export_public_key_ed25519: `${"A".repeat(43)}=`,
      external_log_anchor_provider_id: "independent-transparency-anchor-1",
      external_log_anchor_signing_key_id: "external-log-anchor-key-1",
      external_log_anchor_public_key_ed25519: `${"B".repeat(43)}=`,
      deployed_before_first_eligible_row: true,
    },
    finalization: null,
    assignments: [],
    aggregate_counts: { total_assignments: 0, primary: 0, secondary: 0, exploratory: 0, quarantined: 0 },
    privacy: {
      participant_ids_pseudonymous: true,
      forbidden_fields_absent: true,
      exact_coordinates_absent: true,
      deletion_reconciled_at: "2026-07-20T11:59:00Z",
    },
  };
}

function baseAssignmentManifest() {
  const activation = baseActivationManifest();
  return {
    ...activation,
    manifest_id: "assignment-batch-1",
    manifest_role: "assignment-batch",
    sequence: 1,
    previous_manifest_sha256: DIGEST_B,
    data_snapshot_sha256: DIGEST_C,
    prediction_snapshot_sha256: DIGEST_D,
    created_at: "2027-02-02T12:00:00Z",
    activation: null,
    assignments: [{
      assignment_id: `assignment-${DIGEST_A}`,
      source_record_sha256: DIGEST_B,
      label_free_row_sha256: DIGEST_C,
      candidate_prediction_sha256: DIGEST_D,
      participant_group_id: `participant-${DIGEST_C}`,
      cohort_role: "primary",
      source_role: "prospective-first-party",
      selection_design: "prospective-precommitted-without-score",
      site_id: "limantour-beach",
      geographic_panel: "north-coast",
      temporal_block: "block-3",
      split: "locked-test",
      opportunity_score: 50,
      evidence: {
        observation_contract_status: "valid",
        observation_contract_version: "castingcompass.observation/2.0.0",
        taxon_catalog_version: "castingcompass.taxa/1.0.0",
        target_taxon_id: "california-halibut",
        recruitment_frame_id: "california-halibut-site-window-recruitment-v1",
        recruitment_source_id: "castingcompass-organic-product",
        recruitment_event_contract_version: "castingcompass.recruitment-event/1.0.0",
        recruitment_event_at: "2027-02-02T06:58:00Z",
        recruitment_event_sha256: DIGEST_D,
        community_approval_sha256: null,
        complete_attempt: true,
        expanded_estimate: false,
        activation_manifest_sha256: DIGEST_A,
        cohort_id: "california-halibut-site-window-primary-v1",
        prospective_assignment_issued: true,
        intended_cohort_role: "primary",
        intended_source_role: "prospective-first-party",
        intended_cohort_id: "california-halibut-site-window-primary-v1",
        intended_selection_method: "score_blind_precommitment",
        collection_source_role: "prospective_primary",
        collection_event_type: "completion",
        collection_event_id: "validation-event-completion-1",
        collection_event_at: "2027-02-02T09:46:00Z",
        collection_event_type_counts: {
          enrollment: 1,
          completion: 1,
          evidence_exclusion: 0,
          retrospective_submission: 0,
          legacy_context: 0,
        },
        collection_terminal_event_id: "validation-event-completion-1",
        collection_terminal_event_type: "completion",
        collection_terminal_event_at: "2027-02-02T09:46:00Z",
        collection_provenance_chain_sha256: DIGEST_C,
        collection_evidence_status: "primary_accepted",
        collection_cohort_id: "california-halibut-site-window-primary-v1",
        collection_selection_method: "score_blind_precommitment",
        collection_validation_protocol_id: PROTOCOL_ID,
        collection_activated_at: "2026-07-20T12:00:00Z",
        collection_activation_scoring_system_sha256: DIGEST_C,
        collection_exclusion_reason: null,
        incentive_policy_id: "none-v1",
        effort_segment_id: "effort-segment-1",
        effort_unit: "whole-trip-group-attempt",
        attempt_count: 1,
        duration_milliseconds: 5_400_000,
        angler_count: 1,
        person_milliseconds: 5_400_000,
        mode: "beach",
        segment_start_at: "2027-02-02T08:15:00Z",
        segment_end_at: "2027-02-02T09:45:00Z",
        opportunity_window_id: "limantour-beach--20270202T0800Z",
        window_start_at: "2027-02-02T08:00:00Z",
        window_end_at: "2027-02-02T10:00:00Z",
        opportunity_contract_version: "castingcompass.opportunity/2.0.0",
        scoring_system_kind: "heuristic-configuration",
        scoring_system_version: `heuristic-california-halibut-${DIGEST_C}`,
        scoring_system_sha256: DIGEST_C,
        snapshot_sha256: DIGEST_D,
        site_catalog_sha256: SITE_CATALOG_SHA256,
        impression_attestation_sha256: DIGEST_B,
        score_exposure_attestation_sha256: DIGEST_C,
        forecast_impression_id: "forecast-impression-1",
        impression_or_assignment_at: "2027-02-02T07:00:00Z",
        selection_design: "prospective-precommitted-without-score",
        score_influenced_choice: false,
        study_consent_version: "castingcompass.trip-validation-consent/1.0.0",
        study_consent_at: "2027-02-02T06:59:00Z",
        target_intent_confirmed_at: "2027-02-02T07:00:00Z",
        completion_event_contract_version: "castingcompass.validation-completion-event/1.0.0",
        completion_event_at: "2027-02-02T09:46:00Z",
        completion_consent_version: "castingcompass.trip-validation-consent/1.0.0",
        completion_consented_at: "2027-02-02T09:46:00Z",
        completion_primary_target_confirmed: true,
        completion_complete_attempt_confirmed: true,
        completion_event_sha256: DIGEST_D,
        precommitment_event_sha256: DIGEST_A,
        score_first_exposed_at: "2027-02-02T07:05:00Z",
        score_exposure_disposition: "exposed-after-assignment-before-segment",
        feasible_set_sha256: null,
        feasible_option_count: null,
        assignment_probability_numerator: null,
        assignment_probability_denominator: null,
        randomization_draw_index: null,
        randomization_audit_sha256: null,
        deletion_status: "active",
        exact_coordinates_collected: false,
      },
    }],
    aggregate_counts: { total_assignments: 1, primary: 1, secondary: 0, exploratory: 0, quarantined: 0 },
    privacy: {
      ...activation.privacy,
      deletion_reconciled_at: "2027-02-02T11:59:00Z",
    },
  };
}

function assertManifestSemantics(manifest, protocol) {
  assert.equal(manifest.schema_version, protocol.activation.manifest_contract_version);
  assert.equal(manifest.protocol_id, protocol.protocol_id);
  assert.equal(manifest.protocol_version, protocol.protocol_version);
  assert.equal(manifest.site_catalog_sha256, protocol.geography.site_catalog_sha256);
  assert.equal(manifest.append_only, true);
  if (manifest.outcome_blind) assert.equal(manifest.labels_opened_at, null);
  else assert.ok(manifest.labels_opened_at && Date.parse(manifest.labels_opened_at) >= Date.parse(manifest.created_at));

  if (manifest.manifest_role === "activation") {
    assert.equal(manifest.sequence, 0);
    assert.equal(manifest.previous_manifest_sha256, null);
    assert.ok(manifest.activation);
    assert.equal(manifest.assignments.length, 0);
    assert.ok(Date.parse(manifest.activated_at) < Date.parse(protocol.enrollment.start_at));
    assert.equal(manifest.activation.scoring_system_kind, protocol.candidate.kind);
  } else {
    assert.ok(manifest.sequence > 0);
    assert.match(manifest.previous_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.activation, null);
    assert.match(manifest.data_snapshot_sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.prediction_snapshot_sha256, /^[a-f0-9]{64}$/);
  }

  assert.equal(manifest.aggregate_counts.total_assignments, manifest.assignments.length);
  assert.equal(
    manifest.aggregate_counts.primary + manifest.aggregate_counts.secondary + manifest.aggregate_counts.exploratory + manifest.aggregate_counts.quarantined,
    manifest.assignments.length,
  );
  const assignmentIds = new Set();
  const sourceRecords = new Set();
  const siteToPanel = new Map(protocol.geography.panels.flatMap((panel) => panel.site_ids.map((siteId) => [siteId, panel.panel_id])));
  const blocks = new Map(protocol.temporal_design.blocks.map((block) => [block.block_id, block]));
  for (const assignment of manifest.assignments) {
    assert.equal(assignment.evidence.selection_design, assignment.selection_design);
    assert.equal(assignment.geographic_panel, siteToPanel.get(assignment.site_id));
    assert.equal(assignment.evidence.site_catalog_sha256, manifest.site_catalog_sha256);
    assert.equal(assignment.evidence.snapshot_sha256, manifest.prediction_snapshot_sha256);
    assert.equal(assignment.evidence.exact_coordinates_collected, false);
    assert.ok(!assignmentIds.has(assignment.assignment_id));
    assert.ok(!sourceRecords.has(assignment.source_record_sha256));
    assignmentIds.add(assignment.assignment_id);
    sourceRecords.add(assignment.source_record_sha256);

    const evidence = assignment.evidence;
    const isProspectiveFirstParty = ["prospective-first-party", "score-visible-first-party"].includes(assignment.source_role);
    if (isProspectiveFirstParty) {
      assert.equal(evidence.recruitment_frame_id, protocol.recruitment.frame_id);
      assert.ok(protocol.recruitment.allowed_source_ids.includes(evidence.recruitment_source_id));
      assert.match(evidence.recruitment_event_sha256, /^[a-f0-9]{64}$/);
      assert.ok(Date.parse(evidence.recruitment_event_at) <= Date.parse(evidence.impression_or_assignment_at));
      if (evidence.recruitment_source_id === "admin-approved-community-prospective") {
        assert.match(evidence.community_approval_sha256, /^[a-f0-9]{64}$/);
      } else {
        assert.equal(evidence.community_approval_sha256, null);
      }
    } else {
      for (const field of ["recruitment_frame_id", "recruitment_source_id", "recruitment_event_at", "recruitment_event_sha256", "community_approval_sha256"]) {
        assert.equal(evidence[field], null);
      }
    }
    assert.equal(Date.parse(evidence.window_end_at) - Date.parse(evidence.window_start_at), 120 * 60 * 1000);
    assert.ok(Date.parse(evidence.segment_start_at) >= Date.parse(evidence.window_start_at));
    assert.ok(Date.parse(evidence.segment_end_at) <= Date.parse(evidence.window_end_at));
    assert.ok(Date.parse(evidence.segment_end_at) > Date.parse(evidence.segment_start_at));
    assert.ok(Date.parse(evidence.impression_or_assignment_at) <= Date.parse(evidence.segment_start_at));
    assert.ok(Date.parse(evidence.target_intent_confirmed_at) <= Date.parse(evidence.segment_start_at));
    assert.ok(Date.parse(evidence.study_consent_at) <= Date.parse(evidence.segment_start_at));
    const block = blocks.get(assignment.temporal_block);
    assert.ok(Date.parse(evidence.segment_start_at) >= Date.parse(block.start_at));
    assert.ok(Date.parse(evidence.segment_end_at) <= Date.parse(block.end_at));

    if (assignment.cohort_role === "primary") {
      assert.equal(assignment.source_role, "prospective-first-party");
      assert.ok(protocol.cohorts.primary.allowed_selection_designs.includes(assignment.selection_design));
      assert.equal(assignment.split, block.role === "baseline-development" ? "baseline-development" : "locked-test");
      assert.equal(evidence.observation_contract_status, "valid");
      assert.equal(evidence.complete_attempt, true);
      assert.equal(evidence.expanded_estimate, false);
      assert.equal(evidence.deletion_status, "active");
      assert.ok(assignment.participant_group_id);
      for (const field of ["opportunity_window_id", "scoring_system_version", "scoring_system_sha256", "snapshot_sha256", "study_consent_version"]) {
        assert.ok(evidence[field]);
      }
      if (assignment.selection_design === "prospective-precommitted-without-score") {
        assert.match(evidence.precommitment_event_sha256, /^[a-f0-9]{64}$/);
        for (const field of ["feasible_set_sha256", "feasible_option_count", "assignment_probability_numerator", "assignment_probability_denominator", "randomization_draw_index", "randomization_audit_sha256"]) {
          assert.equal(evidence[field], null);
        }
      } else {
        assert.equal(evidence.precommitment_event_sha256, null);
        assert.match(evidence.feasible_set_sha256, /^[a-f0-9]{64}$/);
        assert.ok(evidence.feasible_option_count >= 2);
        assert.equal(evidence.assignment_probability_numerator, 1);
        assert.equal(evidence.assignment_probability_denominator, evidence.feasible_option_count);
        assert.ok(evidence.randomization_draw_index >= 0 && evidence.randomization_draw_index < evidence.feasible_option_count);
        assert.match(evidence.randomization_audit_sha256, /^[a-f0-9]{64}$/);
      }
      if (evidence.score_first_exposed_at !== null) {
        assert.ok(Date.parse(evidence.impression_or_assignment_at) < Date.parse(evidence.score_first_exposed_at));
        assert.ok(Date.parse(evidence.score_first_exposed_at) < Date.parse(evidence.segment_start_at));
      }
      assert.ok(Date.parse(evidence.impression_or_assignment_at) < Date.parse(evidence.segment_start_at));
    }
    if (assignment.cohort_role === "secondary") {
      assert.equal(assignment.selection_design, "prospective-score-visible-self-selected");
      assert.equal(assignment.split, "observational-secondary");
      assert.ok(evidence.score_first_exposed_at);
      assert.ok(Date.parse(evidence.score_first_exposed_at) < Date.parse(evidence.impression_or_assignment_at));
    }
    if (evidence.deletion_status !== "active") assert.equal(assignment.split, "quarantined");
  }
}

test("strict preregistration schema validates the frozen protocol and rejects unknown fields", async () => {
  const [schema, protocol] = await Promise.all([
    JSON.parse(await readFile(new URL("contracts/validation-preregistration.schema.json", root), "utf8")),
    JSON.parse(await readFile(new URL("validation/protocols/california-halibut-site-window-v1.json", root), "utf8")),
  ]);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(protocol), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...protocol, unknown_field: true }), false);
  const nestedUnknown = structuredClone(protocol);
  nestedUnknown.analysis.promotion_gate.unregistered_gate = 1;
  assert.equal(validate(nestedUnknown), false);
  const placeholder = structuredClone(protocol);
  placeholder.target_and_claim.allowed_claim = "TBD";
  assert.throws(() => assertNoPlaceholders(placeholder));
});

test("Python and Worker share the exact signed impression-attestation vector", async () => {
  const vectorBytes = await readFile(
    new URL("contracts/fixtures/impression-attestation-vector.json", root),
  );
  const vector = JSON.parse(vectorBytes.toString("utf8"));
  const protocol = JSON.parse(await readFile(
    new URL("validation/protocols/california-halibut-site-window-v1.json", root),
    "utf8",
  ));
  assert.equal(
    sha256(vectorBytes),
    protocol.eligibility.impression_attestation_contract.cross_runtime_vector_file_sha256,
  );
  const row = vector.label_free_evidence;
  const envelope = row.impression_attestation;
  const payload = impressionAttestationPayload(row);
  assert.deepEqual(payload, vector.expected_payload);
  assert.equal(canonicalJson(payload), vector.expected_canonical_payload_json);

  const payloadBytes = Buffer.from(envelope.payload_base64, "base64");
  assert.equal(payloadBytes.toString("base64"), envelope.payload_base64);
  assert.equal(payloadBytes.toString("utf8"), vector.expected_canonical_payload_json);
  assert.equal(sha256(payloadBytes), vector.expected_payload_sha256);
  assert.equal(envelope.payload_sha256, vector.expected_payload_sha256);
  assert.equal(envelope.signature_ed25519, vector.expected_signature_ed25519);
  assert.equal(
    sha256(Buffer.from(canonicalJson(envelope), "utf8")),
    vector.expected_envelope_canonical_sha256,
  );

  const rawPublicKey = Buffer.from(vector.public_key_ed25519_base64, "base64");
  assert.equal(rawPublicKey.length, 32);
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      rawPublicKey,
    ]),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verifySignature(
      null,
      payloadBytes,
      publicKey,
      Buffer.from(envelope.signature_ed25519, "base64"),
    ),
    true,
  );

  const exposureEnvelope = row.score_exposure_attestation;
  const exposurePayload = scoreExposureAttestationPayload(row);
  assert.deepEqual(exposurePayload, vector.expected_score_exposure_payload);
  assert.equal(
    canonicalJson(exposurePayload),
    vector.expected_score_exposure_canonical_payload_json,
  );
  const exposureBytes = Buffer.from(exposureEnvelope.payload_base64, "base64");
  assert.equal(exposureBytes.toString("base64"), exposureEnvelope.payload_base64);
  assert.equal(
    sha256(exposureBytes),
    vector.expected_score_exposure_payload_sha256,
  );
  assert.equal(
    exposureEnvelope.signature_ed25519,
    vector.expected_score_exposure_signature_ed25519,
  );
  assert.equal(
    sha256(Buffer.from(canonicalJson(exposureEnvelope), "utf8")),
    vector.expected_score_exposure_envelope_canonical_sha256,
  );
  assert.equal(
    verifySignature(
      null,
      exposureBytes,
      publicKey,
      Buffer.from(exposureEnvelope.signature_ed25519, "base64"),
    ),
    true,
  );

  const sourceFlip = structuredClone(row);
  sourceFlip.evidence.recruitment_source_id = "direct-opt-in-research-invite";
  assert.notDeepEqual(impressionAttestationPayload(sourceFlip), vector.expected_payload);
});

test("frozen protocol has exact site hash/coverage, contiguous dates, roles, metrics, and gates", async () => {
  const [protocol, siteCatalogBytes] = await Promise.all([
    JSON.parse(await readFile(new URL("validation/protocols/california-halibut-site-window-v1.json", root), "utf8")),
    readFile(new URL("public/data/sites.json", root)),
  ]);
  assertProtocolSemantics(protocol, siteCatalogBytes, JSON.parse(siteCatalogBytes.toString("utf8")));

  const duplicateSite = structuredClone(protocol);
  duplicateSite.geography.panels[1].site_ids[0] = duplicateSite.geography.panels[0].site_ids[0];
  assert.throws(() => assertProtocolSemantics(duplicateSite, siteCatalogBytes, JSON.parse(siteCatalogBytes)));
  const temporalGap = structuredClone(protocol);
  temporalGap.temporal_design.blocks[1].start_at = "2026-11-02T00:00:00Z";
  assert.throws(() => assertProtocolSemantics(temporalGap, siteCatalogBytes, JSON.parse(siteCatalogBytes)));
  const calibrationLeak = structuredClone(protocol);
  calibrationLeak.analysis.primary_metric = "brier";
  assert.throws(() => assertProtocolSemantics(calibrationLeak, siteCatalogBytes, JSON.parse(siteCatalogBytes)));
});

test("split manifest schema is strict and semantic checks fail closed on role, hash, date, and privacy errors", async () => {
  const [schema, protocol] = await Promise.all([
    JSON.parse(await readFile(new URL("contracts/validation-split-manifest.schema.json", root), "utf8")),
    JSON.parse(await readFile(new URL("validation/protocols/california-halibut-site-window-v1.json", root), "utf8")),
  ]);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const activation = baseActivationManifest();
  const assignmentBatch = baseAssignmentManifest();
  assert.equal(validate(activation), true, JSON.stringify(validate.errors));
  assert.equal(validate(assignmentBatch), true, JSON.stringify(validate.errors));
  assertManifestSemantics(activation, protocol);
  assertManifestSemantics(assignmentBatch, protocol);

  const developmentBatch = structuredClone(assignmentBatch);
  developmentBatch.created_at = "2026-08-02T12:00:00Z";
  developmentBatch.assignments[0].temporal_block = "block-1";
  developmentBatch.assignments[0].split = "baseline-development";
  developmentBatch.assignments[0].evidence.segment_start_at = "2026-08-02T08:15:00Z";
  developmentBatch.assignments[0].evidence.segment_end_at = "2026-08-02T09:45:00Z";
  developmentBatch.assignments[0].evidence.opportunity_window_id = "limantour-beach--20260802T0800Z";
  developmentBatch.assignments[0].evidence.window_start_at = "2026-08-02T08:00:00Z";
  developmentBatch.assignments[0].evidence.window_end_at = "2026-08-02T10:00:00Z";
  developmentBatch.assignments[0].evidence.impression_or_assignment_at = "2026-08-02T07:00:00Z";
  developmentBatch.assignments[0].evidence.recruitment_event_at = "2026-08-02T06:58:00Z";
  developmentBatch.assignments[0].evidence.study_consent_at = "2026-08-02T06:59:00Z";
  developmentBatch.assignments[0].evidence.target_intent_confirmed_at = "2026-08-02T07:00:00Z";
  developmentBatch.assignments[0].evidence.score_first_exposed_at = "2026-08-02T07:05:00Z";
  developmentBatch.privacy.deletion_reconciled_at = "2026-08-02T11:59:00Z";
  assert.equal(validate(developmentBatch), true, JSON.stringify(validate.errors));
  assertManifestSemantics(developmentBatch, protocol);

  const randomizedBatch = structuredClone(assignmentBatch);
  randomizedBatch.assignments[0].selection_design = "prospective-safely-randomized";
  randomizedBatch.assignments[0].evidence.selection_design = "prospective-safely-randomized";
  randomizedBatch.assignments[0].evidence.precommitment_event_sha256 = null;
  randomizedBatch.assignments[0].evidence.feasible_set_sha256 = DIGEST_B;
  randomizedBatch.assignments[0].evidence.feasible_option_count = 2;
  randomizedBatch.assignments[0].evidence.assignment_probability_numerator = 1;
  randomizedBatch.assignments[0].evidence.assignment_probability_denominator = 2;
  randomizedBatch.assignments[0].evidence.randomization_draw_index = 1;
  randomizedBatch.assignments[0].evidence.randomization_audit_sha256 = DIGEST_C;
  assert.equal(validate(randomizedBatch), true, JSON.stringify(validate.errors));
  assertManifestSemantics(randomizedBatch, protocol);

  const unknownPrivateField = structuredClone(assignmentBatch);
  unknownPrivateField.assignments[0].evidence.raw_email = "private@example.com";
  assert.equal(validate(unknownPrivateField), false);
  const unknownTopLevel = { ...activation, outcome_labels: [] };
  assert.equal(validate(unknownTopLevel), false);

  const missingPrecommitment = structuredClone(assignmentBatch);
  missingPrecommitment.assignments[0].evidence.precommitment_event_sha256 = null;
  assert.equal(validate(missingPrecommitment), false);
  const missingRecruitmentHash = structuredClone(assignmentBatch);
  missingRecruitmentHash.assignments[0].evidence.recruitment_event_sha256 = null;
  assert.equal(validate(missingRecruitmentHash), false);
  const unapprovedCommunityRecruitment = structuredClone(assignmentBatch);
  unapprovedCommunityRecruitment.assignments[0].evidence.recruitment_source_id = "admin-approved-community-prospective";
  assert.equal(validate(unapprovedCommunityRecruitment), false);
  const approvedCommunityRecruitment = structuredClone(unapprovedCommunityRecruitment);
  approvedCommunityRecruitment.assignments[0].evidence.community_approval_sha256 = DIGEST_B;
  assert.equal(validate(approvedCommunityRecruitment), true, JSON.stringify(validate.errors));
  assertManifestSemantics(approvedCommunityRecruitment, protocol);
  const organicWithCommunityApproval = structuredClone(assignmentBatch);
  organicWithCommunityApproval.assignments[0].evidence.community_approval_sha256 = DIGEST_B;
  assert.equal(validate(organicWithCommunityApproval), false);
  const lateRecruitment = structuredClone(assignmentBatch);
  lateRecruitment.assignments[0].evidence.recruitment_event_at = "2027-02-02T07:01:00Z";
  assert.throws(() => assertManifestSemantics(lateRecruitment, protocol));
  const biasedRandomization = structuredClone(randomizedBatch);
  biasedRandomization.assignments[0].evidence.assignment_probability_numerator = 2;
  assert.throws(() => assertManifestSemantics(biasedRandomization, protocol));

  const scoreVisiblePrimary = structuredClone(assignmentBatch);
  scoreVisiblePrimary.assignments[0].selection_design = "prospective-score-visible-self-selected";
  scoreVisiblePrimary.assignments[0].evidence.selection_design = "prospective-score-visible-self-selected";
  assert.throws(() => assertManifestSemantics(scoreVisiblePrimary, protocol));
  const wrongPanel = structuredClone(assignmentBatch);
  wrongPanel.assignments[0].geographic_panel = "central-south-bay";
  assert.throws(() => assertManifestSemantics(wrongPanel, protocol));
  const crossesWindow = structuredClone(assignmentBatch);
  crossesWindow.assignments[0].evidence.segment_end_at = "2027-02-02T10:30:00Z";
  assert.throws(() => assertManifestSemantics(crossesWindow, protocol));
  const openedWhileBlind = structuredClone(assignmentBatch);
  openedWhileBlind.labels_opened_at = "2027-08-01T00:00:00Z";
  assert.throws(() => assertManifestSemantics(openedWhileBlind, protocol));
  const wrongCatalog = structuredClone(assignmentBatch);
  wrongCatalog.site_catalog_sha256 = DIGEST_A;
  assert.throws(() => assertManifestSemantics(wrongCatalog, protocol));
  const deletedPrimary = structuredClone(assignmentBatch);
  deletedPrimary.assignments[0].evidence.deletion_status = "deleted";
  assert.throws(() => assertManifestSemantics(deletedPrimary, protocol));
});
