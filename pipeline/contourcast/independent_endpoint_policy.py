"""Validate the fail-closed inventory of independent endpoint candidates."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlparse


PIPELINE_ROOT = Path(__file__).resolve().parents[1]
INDEPENDENT_ENDPOINT_POLICY_PATH = (
    PIPELINE_ROOT / "independent-endpoint-candidate-policy.json"
)
PROSPECTIVE_COLLECTION_PROTOCOL_PATH = (
    PIPELINE_ROOT.parent
    / "validation"
    / "protocols"
    / "seafloor-independent-endpoint-collection-v1.json"
)
SCHEMA_VERSION = "castingcompass.independent-endpoint-candidate-policy/1.0.0"
PROSPECTIVE_PROTOCOL_SCHEMA_VERSION = (
    "castingcompass.seafloor-independent-endpoint-collection/1.0.0"
)
POLICY_ID = "castingcompass-independent-seafloor-endpoint-candidates-v1"
POLICY_VERSION = "1.0.0"
POLICY_KEYS = {
    "schema_version",
    "policy_id",
    "policy_version",
    "reviewed_at",
    "target_question",
    "current_decision",
    "model_actions_authorized",
    "admission_requirements",
    "reviewed_candidates",
    "next_admissible_path",
}
ACTION_KEYS = {
    "raster_pairing",
    "supervised_training",
    "representation_comparison",
    "encoder_promotion",
    "production_scoring",
}
CANDIDATE_KEYS = {
    "candidate_id",
    "title",
    "steward",
    "official_url",
    "geographic_relation",
    "observation_form",
    "lineage_relation",
    "verdict",
    "reason_codes",
    "allowed_evidence_roles",
    "raster_pairing_authorized",
    "supervised_training_authorized",
    "representation_comparison_authorized",
}
EXPECTED_CANDIDATE_IDS = (
    "noaa-digital-coast-benthic-grab-samples",
    "noaa-digital-coast-san-francisco-benthic-cover-2011",
    "noaa-nccos-california-benthic-substrate-2006",
    "noaa-nccos-california-halibut-hsm-2006",
    "usgs-ds781-video-observations",
    "usgs-ds182-pacific-coast-sediment",
    "usgs-ds781-habitat-interpretations",
)
OFFICIAL_HOSTS = (
    "coast.noaa.gov",
    "www.coast.noaa.gov",
    "fisheries.noaa.gov",
    "www.fisheries.noaa.gov",
    "pubs.usgs.gov",
    "cmgds.marine.usgs.gov",
)
AUTHORIZATION_FIELDS = (
    "raster_pairing_authorized",
    "supervised_training_authorized",
    "representation_comparison_authorized",
)
DERIVED_OBSERVATION_FORMS = {
    "derived-benthic-cover-map",
    "compiled-hard-soft-substrate-map",
    "deterministic-habitat-suitability-model",
    "interpreted-seafloor-character-map",
}
CIRCULARITY_REASON_CODES = {
    "derived-map-not-direct-endpoint",
    "model-output-not-observation",
    "candidate-input-circularity",
}
PROSPECTIVE_PROTOCOL_KEYS = {
    "schema_version",
    "protocol_id",
    "protocol_version",
    "status",
    "frozen_at",
    "purpose_and_claim_boundary",
    "activation",
    "geography_and_frame",
    "observation",
    "labeling",
    "independence_and_partitioning",
    "support_gate",
    "quality_and_safety",
    "outcome_blind_decision_rules",
    "claim_boundary",
}
FROZEN_CLASSES = [
    "smooth_fine_medium_sediment",
    "mixed_or_rugose_rock",
    "mobile_coarse_sediment",
]
FROZEN_REGIONS = [
    "offshore_refugio_beach",
    "offshore_coal_oil_point",
    "offshore_santa_barbara",
    "offshore_carpinteria",
]


def _require_exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise ValueError(
            f"{label} fields disagree with the locked policy: "
            f"missing={sorted(expected - actual)}, extra={sorted(actual - expected)}"
        )


def _require_unique_nonempty_strings(value: Any, label: str) -> None:
    if (
        not isinstance(value, list)
        or not value
        or any(not isinstance(item, str) or not item.strip() for item in value)
        or len(set(value)) != len(value)
    ):
        raise ValueError(f"{label} must contain unique non-empty strings")


def validate_independent_endpoint_policy(policy: Mapping[str, Any]) -> None:
    """Reject drift that could turn a reviewed exclusion into model authority."""

    _require_exact_keys(policy, POLICY_KEYS, "independent endpoint candidate policy")
    if policy["schema_version"] != SCHEMA_VERSION:
        raise ValueError("independent endpoint policy schema is not recognized")
    if policy["policy_id"] != POLICY_ID or policy["policy_version"] != POLICY_VERSION:
        raise ValueError("independent endpoint policy identity is not recognized")
    if policy["reviewed_at"] != "2026-07-22":
        raise ValueError("independent endpoint review date is not recognized")
    if policy["current_decision"] != "no-reviewed-candidate-admissible":
        raise ValueError("reviewed candidates cannot authorize a model action")
    for field in ("target_question", "next_admissible_path"):
        if not isinstance(policy[field], str) or not policy[field].strip():
            raise ValueError(f"{field} must be a non-empty string")

    actions = policy["model_actions_authorized"]
    if not isinstance(actions, dict):
        raise ValueError("model_actions_authorized must be an object")
    _require_exact_keys(actions, ACTION_KEYS, "model_actions_authorized")
    if any(value is not False for value in actions.values()):
        raise ValueError("candidate inventory cannot authorize model actions")
    _require_unique_nonempty_strings(
        policy["admission_requirements"], "admission_requirements"
    )

    candidates = policy["reviewed_candidates"]
    if not isinstance(candidates, list):
        raise ValueError("reviewed_candidates must be an array")
    candidate_ids = [
        candidate.get("candidate_id") if isinstance(candidate, dict) else None
        for candidate in candidates
    ]
    if candidate_ids != list(EXPECTED_CANDIDATE_IDS):
        raise ValueError("candidate IDs or order disagree with the locked inventory")

    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ValueError("reviewed candidate entries must be objects")
        candidate_id = str(candidate["candidate_id"])
        _require_exact_keys(candidate, CANDIDATE_KEYS, f"candidate {candidate_id!r}")
        for field in (
            "title",
            "steward",
            "geographic_relation",
            "observation_form",
            "lineage_relation",
        ):
            if not isinstance(candidate[field], str) or not candidate[field].strip():
                raise ValueError(f"candidate {candidate_id!r} has invalid {field}")
        parsed_url = urlparse(str(candidate["official_url"]))
        if (
            parsed_url.scheme != "https"
            or not parsed_url.hostname
            or parsed_url.hostname not in OFFICIAL_HOSTS
        ):
            raise ValueError(f"candidate {candidate_id!r} lacks a locked official URL")
        if candidate["verdict"] not in {"exclude", "not-new-independent-evidence"}:
            raise ValueError(f"candidate {candidate_id!r} has an admissible verdict")
        _require_unique_nonempty_strings(
            candidate["reason_codes"], f"candidate {candidate_id!r} reason_codes"
        )
        if candidate["allowed_evidence_roles"] != []:
            raise ValueError(f"candidate {candidate_id!r} cannot have an evidence role")
        for field in AUTHORIZATION_FIELDS:
            if candidate[field] is not False:
                raise ValueError(f"candidate {candidate_id!r} cannot authorize {field}")
        if (
            candidate["observation_form"] in DERIVED_OBSERVATION_FORMS
            and not CIRCULARITY_REASON_CODES.intersection(candidate["reason_codes"])
        ):
            raise ValueError(
                f"derived candidate {candidate_id!r} lacks an explicit circularity exclusion"
            )


def load_independent_endpoint_policy(
    policy_path: Path | None = None,
) -> Mapping[str, Any]:
    path = policy_path or INDEPENDENT_ENDPOINT_POLICY_PATH
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"independent endpoint policy is unavailable or invalid: {path}") from error
    if not isinstance(raw, dict):
        raise ValueError("independent endpoint policy must be a JSON object")
    validate_independent_endpoint_policy(raw)
    return raw


def independent_endpoint_policy_sha256(policy: Mapping[str, Any]) -> str:
    validate_independent_endpoint_policy(policy)
    canonical = json.dumps(policy, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_prospective_collection_protocol(protocol: Mapping[str, Any]) -> None:
    """Validate the inactive, outcome-blind direct-video collection design."""

    _require_exact_keys(protocol, PROSPECTIVE_PROTOCOL_KEYS, "prospective endpoint protocol")
    if protocol["schema_version"] != PROSPECTIVE_PROTOCOL_SCHEMA_VERSION:
        raise ValueError("prospective endpoint protocol schema is not recognized")
    if (
        protocol["protocol_id"] != "seafloor-independent-endpoint-collection-v1"
        or protocol["protocol_version"] != "1.0.0"
        or protocol["status"] != "frozen-local-not-activated"
        or protocol["frozen_at"] != "2026-07-22"
    ):
        raise ValueError("prospective endpoint protocol identity is not recognized")

    purpose = protocol["purpose_and_claim_boundary"]
    if not isinstance(purpose, dict):
        raise ValueError("purpose_and_claim_boundary must be an object")
    for field in (
        "candidate_model_access_allowed",
        "raster_pairing_allowed",
        "representation_comparison_allowed",
        "model_promotion_allowed",
        "catch_or_fish_endpoint_claim_allowed",
    ):
        if purpose.get(field) is not False:
            raise ValueError(f"inactive collection protocol cannot authorize {field}")

    activation = protocol["activation"]
    if not isinstance(activation, dict) or activation.get("current_activation_authorized") is not False:
        raise ValueError("prospective collection is not activated")
    required_activation_controls = (
        "externally_timestamped_preregistration_required",
        "legal_privacy_safety_and_data_steward_approval_required",
        "fixed_collection_interval_required",
        "exact_site_assignment_manifest_required",
        "exact_equipment_and_label_manual_hashes_required",
        "collector_and_labeler_training_required",
        "activation_must_precede_site_assignment_and_first_observation",
        "backdating_prohibited",
    )
    if any(activation.get(field) is not True for field in required_activation_controls):
        raise ValueError("prospective collection activation controls are incomplete")

    geography = protocol["geography_and_frame"]
    if not isinstance(geography, dict) or geography.get("eligible_regions") != FROZEN_REGIONS:
        raise ValueError("prospective collection regions disagree with the frozen footprint")
    for field in (
        "model_score_or_embedding_visible_during_frame_construction",
        "bathymetry_or_backscatter_texture_used_to_target_substrate",
        "adaptive_targeting_after_label_visibility_allowed",
    ):
        if geography.get(field) is not False:
            raise ValueError(f"prospective site frame violates outcome blindness: {field}")

    observation = protocol["observation"]
    if not isinstance(observation, dict):
        raise ValueError("observation must be an object")
    if observation.get("primary_endpoint") != "direct-downward-video-seafloor-class":
        raise ValueError("prospective endpoint must remain direct video")
    if observation.get("minimum_usable_bottom_time_seconds") != 30:
        raise ValueError("minimum usable bottom time disagrees with the frozen protocol")
    if observation.get("fishing-trip-log_role") != (
        "separate-catch-observation-only-and-never-a-seafloor-label"
    ):
        raise ValueError("fishing trip logs cannot become seafloor labels")

    labeling = protocol["labeling"]
    if not isinstance(labeling, dict) or labeling.get("classes") != FROZEN_CLASSES:
        raise ValueError("prospective endpoint classes disagree with the frozen protocol")
    for field in (
        "class_manual_frozen_before_first_label",
        "labelers_blinded_to_candidate_inputs_outputs_location_name_and_fishing_outcomes",
        "two_independent_labelers_required",
        "adjudicator_required_for_disagreement",
    ):
        if labeling.get(field) is not True:
            raise ValueError(f"prospective labeling control is disabled: {field}")
    for field in ("post_label_class_collapse_allowed", "automated_pseudo_labels_allowed"):
        if labeling.get(field) is not False:
            raise ValueError(f"prospective labeling escape hatch is enabled: {field}")

    partitioning = protocol["independence_and_partitioning"]
    if not isinstance(partitioning, dict):
        raise ValueError("independence_and_partitioning must be an object")
    if partitioning.get("indivisible_group") != "whole-vessel-or-platform-collection-day":
        raise ValueError("prospective grouping unit disagrees with the frozen protocol")
    if partitioning.get("minimum_spatial_buffer_m") != 512:
        raise ValueError("prospective spatial buffer disagrees with the frozen protocol")
    if partitioning.get("row_random_split_allowed") is not False:
        raise ValueError("row-random splitting is prohibited")
    if partitioning.get("deployment_random_split_allowed") is not False:
        raise ValueError("deployment-random splitting is prohibited")

    support = protocol["support_gate"]
    if not isinstance(support, dict):
        raise ValueError("support_gate must be an object")
    if support.get("minimum_retained_deployments_per_class_per_side") != 32:
        raise ValueError("per-class support floor disagrees with the frozen protocol")
    if support.get("minimum_indivisible_groups_per_side") != 3:
        raise ValueError("group support floor disagrees with the frozen protocol")
    if support.get("minimum_regions_per_side") != 3:
        raise ValueError("region support floor disagrees with the frozen protocol")
    if support.get("every_class_required_on_both_sides") is not True:
        raise ValueError("every class must be supported on both partition sides")
    if support.get("partition_selected_from_outcome_balance") is not False:
        raise ValueError("partition cannot be selected from outcome balance")

    decision_rules = protocol["outcome_blind_decision_rules"]
    if not isinstance(decision_rules, dict) or any(
        value is not True for value in decision_rules.values()
    ):
        raise ValueError("outcome-blind decision controls must all remain enabled")
    if not isinstance(protocol["claim_boundary"], str) or not protocol["claim_boundary"].strip():
        raise ValueError("claim_boundary must be a non-empty string")


def load_prospective_collection_protocol(
    protocol_path: Path | None = None,
) -> Mapping[str, Any]:
    path = protocol_path or PROSPECTIVE_COLLECTION_PROTOCOL_PATH
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"prospective endpoint protocol is unavailable or invalid: {path}") from error
    if not isinstance(raw, dict):
        raise ValueError("prospective endpoint protocol must be a JSON object")
    validate_prospective_collection_protocol(raw)
    return raw


def prospective_collection_protocol_sha256(protocol: Mapping[str, Any]) -> str:
    validate_prospective_collection_protocol(protocol)
    canonical = json.dumps(protocol, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
