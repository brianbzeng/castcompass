"""Fail-closed model promotion, monitoring, rollback, and revalidation decisions.

This module evaluates evidence and emits an auditable recommendation. It never
changes a serving release, promotes a model, or reads private observation rows.
The checked-in v1 policy explicitly authorizes only the reviewed heuristic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping

from shared.species_contract import (
    MODEL_GOVERNANCE_CONTRACT_VERSION,
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    OPPORTUNITY_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    is_strict_offset_datetime,
    validate_contract_assets,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_POLICY_PATH = REPOSITORY_ROOT / "model" / "governance" / "california-halibut-v1.json"
DECISION_SCHEMA_VERSION = "castingcompass.model-governance-decision/1.0.0"
EVIDENCE_SCHEMA_VERSION = "castingcompass.model-governance-evidence/1.0.0"
POLICY_ID = "california-halibut-model-governance-v1"
POLICY_VERSION = "1.0.0"

PROMOTION_STAGES = [
    "development",
    "candidate",
    "shadow",
    "limited",
    "production",
]
SAFETY_STATES = ["suppressed", "retired"]
PROMOTION_GATES = [
    "target-contract-and-run-integrity",
    "checkpoint-and-metrics-artifact-rehash",
    "fixed-candidate-and-best-preregistered-baseline",
    "source-separated-development-and-locked-test-data",
    "geographic-and-temporal-holdouts",
    "participant-clustered-uncertainty",
    "complete-attempt-inclusion-and-score-influence-stratification",
    "all-primary-and-slice-metrics-estimable",
    "primary-lower-confidence-bound-beats-best-baseline",
    "paired-improvement-lower-confidence-bound-above-zero",
    "calibration-within-preregistered-ceiling-and-not-worse-than-baseline",
    "no-required-geography-season-mode-or-taxon-slice-below-floor",
    "minimum-positive-negative-participant-and-slice-support",
    "independent-checkpoint-reproduction",
    "low-confidence-missing-coverage-and-source-outage-product-tests",
    "negative-and-inconclusive-reporting-commitment",
]
IMMEDIATE_SUPPRESSION_TRIGGERS = [
    "model-or-policy-digest-mismatch",
    "target-or-contract-version-mismatch",
    "crs-channel-order-source-version-or-coverage-contract-failure",
    "nonfinite-malformed-or-out-of-contract-features",
    "required-input-missingness-above-preregistered-bound",
    "serving-outside-validated-geography-season-mode-or-taxon-support",
]
ROLLBACK_TRIGGERS = [
    "primary-performance-lower-bound-no-longer-clears-preregistered-floor",
    "calibration-no-longer-clears-preregistered-bound",
    "required-slice-no-longer-clears-preregistered-floor",
    "distribution-drift-breaches-preregistered-action-bound",
    "support-falls-below-preregistered-minimum",
    "monitoring-evidence-exceeds-maximum-age",
]
REVALIDATION_TRIGGERS = [
    "candidate-model-or-checkpoint-change",
    "feature-definition-order-normalization-or-imputation-change",
    "target-taxon-or-contract-version-change",
    "training-label-or-data-source-change",
    "validated-geography-season-mode-or-population-expansion",
    "calibration-method-or-decision-threshold-change",
    "material-regulation-product-or-ranking-semantics-change",
    "rollback-or-safety-suppression",
    "maximum-evidence-age-reached",
]


def _exact_keys(value: Mapping[str, Any], expected: set[str], context: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ValueError(f"{context} keys changed (missing={missing}, extra={extra})")


def _mapping(value: Any, context: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")
    return value


def _boolean(value: Any, context: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{context} must be boolean")
    return value


def _digest(value: Any, context: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{64}", value) is None:
        raise ValueError(f"{context} must be a lowercase SHA-256 digest")
    return value


def canonical_policy_sha256(policy: Mapping[str, Any]) -> str:
    payload = json.dumps(
        policy,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_model_governance_policy(path: Path = DEFAULT_POLICY_PATH) -> Mapping[str, Any]:
    try:
        policy = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Model governance policy is unavailable or invalid: {path}") from exc
    validate_model_governance_policy(policy)
    return policy


def validate_model_governance_policy(policy: Mapping[str, Any]) -> None:
    """Reject semantic weakening or ambiguity in the v1 policy."""

    validate_contract_assets()
    policy = _mapping(policy, "policy")
    _exact_keys(
        policy,
        {
            "schema_version",
            "policy_id",
            "policy_version",
            "target_taxon_id",
            "contract_versions",
            "current_release",
            "promotion",
            "monitoring",
            "rollback",
            "revalidation",
            "audit",
        },
        "policy",
    )
    expected_identity = {
        "schema_version": MODEL_GOVERNANCE_CONTRACT_VERSION,
        "policy_id": POLICY_ID,
        "policy_version": POLICY_VERSION,
        "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
    }
    for field, expected in expected_identity.items():
        if policy.get(field) != expected:
            raise ValueError(f"policy {field} is unsupported")

    contracts = _mapping(policy["contract_versions"], "policy.contract_versions")
    expected_contracts = {
        "model_governance": MODEL_GOVERNANCE_CONTRACT_VERSION,
        "model_run": MODEL_RUN_CONTRACT_VERSION,
        "observation": OBSERVATION_CONTRACT_VERSION,
        "opportunity": OPPORTUNITY_CONTRACT_VERSION,
        "taxon_catalog": TAXON_CATALOG_VERSION,
    }
    if dict(contracts) != expected_contracts:
        raise ValueError("policy contract versions changed")

    current = _mapping(policy["current_release"], "policy.current_release")
    if dict(current) != {
        "serving_kind": "heuristic-configuration",
        "trained_model_authorized": False,
        "automatic_promotion_allowed": False,
        "public_probability_claim_allowed": False,
        "reason": "no-separately-preregistered-confirmatory-model-validation-pass",
    }:
        raise ValueError("current release must remain a non-probabilistic heuristic")

    promotion = _mapping(policy["promotion"], "policy.promotion")
    _exact_keys(
        promotion,
        {
            "stages",
            "safety_states",
            "stage_skipping_allowed",
            "automatic_promotion_allowed",
            "named_human_approval_required",
            "separate_confirmatory_protocol_required",
            "external_timestamp_before_enrollment_required",
            "activation_before_first_eligible_row_required",
            "pilot_rows_excluded",
            "locked_test_outcomes_available_to_development",
            "required_gates",
        },
        "policy.promotion",
    )
    if (
        promotion["stages"] != PROMOTION_STAGES
        or promotion["safety_states"] != SAFETY_STATES
        or promotion["required_gates"] != PROMOTION_GATES
    ):
        raise ValueError("promotion stages, safety states, or gates changed")
    required_true = (
        "named_human_approval_required",
        "separate_confirmatory_protocol_required",
        "external_timestamp_before_enrollment_required",
        "activation_before_first_eligible_row_required",
        "pilot_rows_excluded",
    )
    for field in required_true:
        if promotion.get(field) is not True:
            raise ValueError(f"promotion safeguard {field} must remain true")
    for field in (
        "stage_skipping_allowed",
        "automatic_promotion_allowed",
        "locked_test_outcomes_available_to_development",
    ):
        if promotion.get(field) is not False:
            raise ValueError(f"promotion safeguard {field} must remain false")

    monitoring = _mapping(policy["monitoring"], "policy.monitoring")
    _exact_keys(
        monitoring,
        {"privacy", "cadence", "immediate_suppression_triggers", "rollback_triggers"},
        "policy.monitoring",
    )
    if monitoring["immediate_suppression_triggers"] != IMMEDIATE_SUPPRESSION_TRIGGERS:
        raise ValueError("immediate suppression triggers changed")
    if monitoring["rollback_triggers"] != ROLLBACK_TRIGGERS:
        raise ValueError("rollback triggers changed")
    privacy = _mapping(monitoring["privacy"], "policy.monitoring.privacy")
    if dict(privacy) != {
        "precise_coordinates_allowed": False,
        "raw_labels_allowed": False,
        "minimum_aggregate_group_size": 20,
    }:
        raise ValueError("monitoring privacy boundary changed")
    cadence = _mapping(monitoring["cadence"], "policy.monitoring.cadence")
    if dict(cadence) != {
        "integrity": "per-request-and-release",
        "distribution_and_support": "rolling-seven-day-window-reviewed-weekly",
        "delayed_performance_and_calibration": "each-preregistered-minimum-support-window",
        "full_revalidation": "at-least-every-180-days",
    }:
        raise ValueError("monitoring cadence changed")

    rollback = _mapping(policy["rollback"], "policy.rollback")
    if dict(rollback) != {
        "fallback_order": [
            "last-known-good-trained-model-if-fresh-compatible-and-rehashed",
            "reviewed-heuristic-configuration",
            "feature-unavailable",
        ],
        "last_known_good_release_immutable": True,
        "artifact_rehash_required": True,
        "automatic_safety_suppression_allowed": True,
        "automatic_promotion_allowed": False,
        "named_human_operator_required_for_restoration": True,
        "post_rollback_incident_and_revalidation_required": True,
    }:
        raise ValueError("rollback policy changed")

    revalidation = _mapping(policy["revalidation"], "policy.revalidation")
    if dict(revalidation) != {
        "maximum_evidence_age_days": 180,
        "same_exposed_locked_test_reuse_for_new_candidate_allowed": False,
        "post_change_shadow_stage_required": True,
        "triggers": REVALIDATION_TRIGGERS,
    }:
        raise ValueError("revalidation policy changed")

    audit = _mapping(policy["audit"], "policy.audit")
    if dict(audit) != {
        "decision_schema_version": DECISION_SCHEMA_VERSION,
        "append_only_decision_record_required": True,
        "raw_sensitive_data_allowed": False,
        "required_identity": [
            "policy-sha256",
            "protocol-and-activation-sha256",
            "model-run-and-artifact-sha256",
            "source-release-and-serving-version",
            "decision-timestamp-action-reasons-and-owner",
        ],
    }:
        raise ValueError("audit policy changed")


def evaluate_model_governance(
    evidence: Mapping[str, Any],
    *,
    policy: Mapping[str, Any] | None = None,
) -> Mapping[str, Any]:
    """Evaluate evidence without applying any release or serving change."""

    selected_policy = policy or load_model_governance_policy()
    validate_model_governance_policy(selected_policy)
    evidence = _mapping(evidence, "evidence")
    _exact_keys(
        evidence,
        {
            "schema_version",
            "policy_id",
            "policy_version",
            "evaluated_at",
            "requested_action",
            "serving_kind",
            "source_release",
            "serving_version",
            "target_taxon_id",
            "candidate",
            "confirmatory",
            "monitoring",
            "material_change",
            "named_human_approval",
            "owner",
        },
        "evidence",
    )
    if evidence.get("schema_version") != EVIDENCE_SCHEMA_VERSION:
        raise ValueError("evidence schema version is unsupported")
    if evidence.get("policy_id") != POLICY_ID or evidence.get("policy_version") != POLICY_VERSION:
        raise ValueError("evidence policy identity mismatch")
    if evidence.get("target_taxon_id") != PRODUCTION_TARGET_TAXON_ID:
        raise ValueError("evidence target is unsupported")
    evaluated_at = evidence.get("evaluated_at")
    if not is_strict_offset_datetime(evaluated_at):
        raise ValueError("evidence evaluated_at must be a real offset timestamp")
    action = evidence.get("requested_action")
    if action not in {"promote", "continue-serving", "rollback"}:
        raise ValueError("evidence requested_action is unsupported")
    serving_kind = evidence.get("serving_kind")
    if serving_kind not in {"heuristic-configuration", "trained-model"}:
        raise ValueError("evidence serving_kind is unsupported")
    source_release = evidence.get("source_release")
    if not isinstance(source_release, str) or re.fullmatch(
        r"(?:[a-f0-9]{40}|[a-f0-9]{64})", source_release
    ) is None:
        raise ValueError("evidence source_release must be an exact Git object id")
    serving_version = evidence.get("serving_version")
    if not isinstance(serving_version, str) or re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,159}", serving_version
    ) is None:
        raise ValueError("evidence serving_version must be an exact bounded identifier")
    owner = evidence.get("owner")
    if not isinstance(owner, str) or not owner.strip() or len(owner) > 120:
        raise ValueError("evidence owner must be a named operator")
    material_change = _boolean(evidence.get("material_change"), "evidence.material_change")
    human_approval = _boolean(
        evidence.get("named_human_approval"), "evidence.named_human_approval"
    )

    confirmatory = _mapping(evidence["confirmatory"], "evidence.confirmatory")
    confirmatory_fields = {
        "separate_protocol",
        "externally_timestamped_before_enrollment",
        "activation_preceded_first_eligible_row",
        "candidate_and_baselines_frozen",
        "locked_test_source_separated",
        "pilot_rows_excluded",
        "passed",
        "all_required_metrics_estimable",
        "primary_lower_bound_beats_best_baseline",
        "paired_improvement_lower_bound_above_zero",
        "calibration_within_precommitted_ceiling_and_not_worse_than_baseline",
        "no_required_slice_below_floor",
        "minimum_support_met",
        "negative_and_inconclusive_reporting_committed",
        "protocol_sha256",
        "activation_sha256",
    }
    _exact_keys(confirmatory, confirmatory_fields, "evidence.confirmatory")
    confirmatory_boolean_fields = confirmatory_fields - {"protocol_sha256", "activation_sha256"}
    for field in confirmatory_boolean_fields:
        _boolean(confirmatory[field], f"evidence.confirmatory.{field}")
    if confirmatory["separate_protocol"]:
        _digest(confirmatory["protocol_sha256"], "evidence.confirmatory.protocol_sha256")
        _digest(confirmatory["activation_sha256"], "evidence.confirmatory.activation_sha256")
    else:
        if confirmatory["protocol_sha256"] is not None or confirmatory["activation_sha256"] is not None:
            raise ValueError("absent confirmatory protocol cannot declare protocol or activation digests")
        if any(confirmatory[field] for field in confirmatory_boolean_fields - {"separate_protocol"}):
            raise ValueError("absent confirmatory protocol cannot declare confirmatory gates passed")

    monitoring = _mapping(evidence["monitoring"], "evidence.monitoring")
    monitoring_fields = {
        "model_and_policy_digests_match",
        "target_and_contract_versions_match",
        "crs_channel_source_and_coverage_contract_valid",
        "features_finite_and_in_contract",
        "missingness_within_precommitted_bound",
        "within_validated_support",
        "distribution_drift_within_action_bound",
        "performance_floor_cleared",
        "calibration_bound_cleared",
        "required_slice_floors_cleared",
        "support_minimum_met",
        "evidence_age_within_bound",
    }
    _exact_keys(monitoring, monitoring_fields, "evidence.monitoring")
    for field in monitoring_fields:
        _boolean(monitoring[field], f"evidence.monitoring.{field}")

    candidate = evidence.get("candidate")
    if candidate is not None:
        candidate = _mapping(candidate, "evidence.candidate")
        candidate_fields = {
            "model_version",
            "model_run_sha256",
            "checkpoint_sha256",
            "metrics_sha256",
            "run_record_integrity_verified",
            "artifact_hashes_verified",
            "clean_git_revision",
            "independent_reproduction",
            "product_fallbacks_verified",
        }
        _exact_keys(candidate, candidate_fields, "evidence.candidate")
        model_version = candidate.get("model_version")
        if not isinstance(model_version, str) or re.fullmatch(
            r"model-california-halibut-[a-f0-9]{64}", model_version
        ) is None:
            raise ValueError("candidate model_version is invalid")
        for field in {"model_run_sha256", "checkpoint_sha256", "metrics_sha256"}:
            _digest(candidate[field], f"evidence.candidate.{field}")
        for field in candidate_fields - {
            "model_version",
            "model_run_sha256",
            "checkpoint_sha256",
            "metrics_sha256",
        }:
            _boolean(candidate[field], f"evidence.candidate.{field}")

    reasons: list[str] = []
    decision: str
    immediate_monitoring = {
        "model_and_policy_digests_match": "model-or-policy-digest-mismatch",
        "target_and_contract_versions_match": "target-or-contract-version-mismatch",
        "crs_channel_source_and_coverage_contract_valid": "crs-channel-source-or-coverage-contract-failure",
        "features_finite_and_in_contract": "invalid-serving-features",
        "missingness_within_precommitted_bound": "missingness-bound-breached",
        "within_validated_support": "outside-validated-support",
    }
    rollback_monitoring = {
        "distribution_drift_within_action_bound": "distribution-drift-bound-breached",
        "performance_floor_cleared": "performance-floor-not-cleared",
        "calibration_bound_cleared": "calibration-bound-not-cleared",
        "required_slice_floors_cleared": "required-slice-floor-not-cleared",
        "support_minimum_met": "support-minimum-not-met",
        "evidence_age_within_bound": "monitoring-evidence-stale",
    }

    if action == "rollback":
        decision = "rollback"
        reasons.append("operator-requested-rollback")
    elif serving_kind == "trained-model" and not selected_policy["current_release"][
        "trained_model_authorized"
    ]:
        decision = "suppress"
        reasons.append("trained-model-not-authorized-by-current-policy")
    elif serving_kind == "trained-model":
        reasons.extend(reason for field, reason in immediate_monitoring.items() if not monitoring[field])
        if reasons:
            decision = "suppress"
        else:
            reasons.extend(reason for field, reason in rollback_monitoring.items() if not monitoring[field])
            if material_change:
                reasons.append("material-change-requires-revalidation")
            decision = "rollback" if reasons else "continue-trained-model"
    elif action == "promote":
        if candidate is None:
            reasons.append("candidate-evidence-missing")
        else:
            candidate_gate_map = {
                "run_record_integrity_verified": "run-record-integrity-not-verified",
                "artifact_hashes_verified": "artifact-hashes-not-verified",
                "clean_git_revision": "candidate-source-revision-not-clean",
                "independent_reproduction": "independent-reproduction-missing",
                "product_fallbacks_verified": "product-fallback-tests-missing",
            }
            reasons.extend(
                reason for field, reason in candidate_gate_map.items() if not candidate[field]
            )
        confirmatory_gate_map = {
            "separate_protocol": "separate-confirmatory-protocol-missing",
            "externally_timestamped_before_enrollment": "confirmatory-protocol-not-pre-enrollment-timestamped",
            "activation_preceded_first_eligible_row": "confirmatory-activation-too-late",
            "candidate_and_baselines_frozen": "candidate-or-baselines-not-frozen",
            "locked_test_source_separated": "locked-test-source-separation-failed",
            "pilot_rows_excluded": "pilot-rows-not-excluded",
            "passed": "confirmatory-study-did-not-pass",
            "all_required_metrics_estimable": "required-metrics-not-estimable",
            "primary_lower_bound_beats_best_baseline": "primary-lower-bound-does-not-beat-baseline",
            "paired_improvement_lower_bound_above_zero": "paired-improvement-lower-bound-not-positive",
            "calibration_within_precommitted_ceiling_and_not_worse_than_baseline": "calibration-gate-failed",
            "no_required_slice_below_floor": "required-slice-floor-failed",
            "minimum_support_met": "minimum-support-not-met",
            "negative_and_inconclusive_reporting_committed": "negative-reporting-commitment-missing",
        }
        reasons.extend(
            reason for field, reason in confirmatory_gate_map.items() if not confirmatory[field]
        )
        if material_change:
            reasons.append("material-change-requires-new-confirmatory-evidence")
        if reasons:
            decision = "blocked"
        elif not human_approval:
            decision = "eligible-for-human-review"
        else:
            decision = "eligible-for-policy-update"
            reasons.append("current-policy-still-authorizes-only-reviewed-heuristic")
    else:
        decision = "revalidate" if material_change else "continue-heuristic"
        if material_change:
            reasons.append("material-change-requires-revalidation")

    return {
        "schema_version": DECISION_SCHEMA_VERSION,
        "policy_id": POLICY_ID,
        "policy_version": POLICY_VERSION,
        "policy_sha256": canonical_policy_sha256(selected_policy),
        "evaluated_at": evaluated_at,
        "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
        "requested_action": action,
        "evidence_identity": {
            "serving_kind": serving_kind,
            "source_release": source_release,
            "serving_version": serving_version,
            "protocol_sha256": confirmatory["protocol_sha256"],
            "activation_sha256": confirmatory["activation_sha256"],
            "candidate_model_version": (
                candidate["model_version"] if candidate is not None else None
            ),
            "model_run_sha256": (
                candidate["model_run_sha256"] if candidate is not None else None
            ),
            "checkpoint_sha256": (
                candidate["checkpoint_sha256"] if candidate is not None else None
            ),
            "metrics_sha256": (
                candidate["metrics_sha256"] if candidate is not None else None
            ),
        },
        "decision": decision,
        "automatic_change_applied": False,
        "reasons": reasons,
        "owner": owner,
    }


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n"
    with path.open("x", encoding="utf-8") as stream:
        stream.write(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify_parser = subparsers.add_parser("verify-policy")
    verify_parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY_PATH)
    evaluate_parser = subparsers.add_parser("evaluate")
    evaluate_parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY_PATH)
    evaluate_parser.add_argument("--evidence", type=Path, required=True)
    evaluate_parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)

    policy = load_model_governance_policy(args.policy)
    if args.command == "verify-policy":
        result = {
            "schema_version": MODEL_GOVERNANCE_CONTRACT_VERSION,
            "policy_id": POLICY_ID,
            "policy_version": POLICY_VERSION,
            "policy_sha256": canonical_policy_sha256(policy),
            "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
            "trained_model_authorized": False,
            "automatic_promotion_allowed": False,
        }
    else:
        try:
            evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Governance evidence is unavailable or invalid: {args.evidence}") from exc
        result = evaluate_model_governance(evidence, policy=policy)

    if getattr(args, "output", None) is not None:
        _write_json(args.output, result)
    else:
        json.dump(result, sys.stdout, indent=2, sort_keys=True, allow_nan=False)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
