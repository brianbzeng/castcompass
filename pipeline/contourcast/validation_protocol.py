"""Frozen, outcome-blind validation-protocol and split-manifest tooling.

This module is deliberately separate from :mod:`pipeline.contourcast.ingest`.
Curated-site evidence is suitable only for the frozen site-by-time-window claim;
it is never converted into a terrain point or casting-zone label.
"""

from __future__ import annotations

import hashlib
import json
import base64
import binascii
import os
import platform
import re
import stat
import subprocess
import sys
from importlib import metadata as importlib_metadata
from collections import Counter
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    OPPORTUNITY_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    is_strict_offset_datetime,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PRIVATE_VALIDATION_ROOT = REPOSITORY_ROOT / ".validation-private"
DEFAULT_PROTOCOL_PATH = (
    REPOSITORY_ROOT / "validation" / "protocols" / "california-halibut-site-window-v1.json"
)
PROTOCOL_SCHEMA_VERSION = "castingcompass.validation-preregistration/1.0.0"
SPLIT_MANIFEST_SCHEMA_VERSION = "castingcompass.validation-split-manifest/1.0.0"
EVIDENCE_SCHEMA_VERSION = "castingcompass.validation-evidence/1.0.0"
IMPRESSION_ATTESTATION_SCHEMA_VERSION = (
    "castingcompass.validation-impression-attestation/1.0.0"
)
SCORE_EXPOSURE_ATTESTATION_SCHEMA_VERSION = (
    "castingcompass.validation-score-exposure-attestation/1.0.0"
)

# The concrete preregistration is immutable. A semantic change requires a new
# protocol/version rather than editing this artifact in place.
EXPECTED_PROTOCOL_CANONICAL_SHA256 = (
    "93c8b58291b994f3a56458863e64b21db2451f0262cacde1fe90045d52eab5d9"
)

SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
ASSIGNMENT_PATTERN = re.compile(r"^assignment-[a-f0-9]{64}$")
PARTICIPANT_PATTERN = re.compile(r"^participant-[a-f0-9]{64}$")
PLACEHOLDER_PATTERN = re.compile(
    r"(?:\b(?:todo|tbd|placeholder|replace[-_ ]?me|fixme)\b|<[^>]+>|\{\{[^}]+\}\})",
    re.IGNORECASE,
)

LABEL_FREE_EVIDENCE_TOP_LEVEL_FIELDS = {
    "schema_version",
    "assignment_id",
    "source_record_sha256",
    "participant_group_id",
    "protocol_id",
    "protocol_version",
    "cohort_role",
    "source_role",
    "selection_design",
    "site_id",
    "opportunity_score",
    "impression_attestation",
    "score_exposure_attestation",
    "server_attested",
    "evidence_status",
    "deletion_lineage",
    "evidence",
}
LABELED_EVIDENCE_TOP_LEVEL_FIELDS = LABEL_FREE_EVIDENCE_TOP_LEVEL_FIELDS | {
    "outcome_class",
    "target_encounter_count",
}
EVIDENCE_OBJECT_FIELDS = {
    "observation_contract_status",
    "observation_contract_version",
    "taxon_catalog_version",
    "target_taxon_id",
    "recruitment_frame_id",
    "recruitment_source_id",
    "recruitment_event_contract_version",
    "recruitment_event_at",
    "recruitment_event_sha256",
    "community_approval_sha256",
    "complete_attempt",
    "expanded_estimate",
    "activation_manifest_sha256",
    "cohort_id",
    "prospective_assignment_issued",
    "intended_cohort_role",
    "intended_source_role",
    "intended_cohort_id",
    "intended_selection_method",
    "collection_source_role",
    "collection_event_type",
    "collection_event_id",
    "collection_event_at",
    "collection_event_type_counts",
    "collection_terminal_event_id",
    "collection_terminal_event_type",
    "collection_terminal_event_at",
    "collection_provenance_chain_sha256",
    "collection_evidence_status",
    "collection_cohort_id",
    "collection_selection_method",
    "collection_validation_protocol_id",
    "collection_activated_at",
    "collection_activation_scoring_system_sha256",
    "collection_exclusion_reason",
    "incentive_policy_id",
    "effort_segment_id",
    "effort_unit",
    "attempt_count",
    "duration_milliseconds",
    "angler_count",
    "person_milliseconds",
    "mode",
    "segment_start_at",
    "segment_end_at",
    "opportunity_window_id",
    "window_start_at",
    "window_end_at",
    "opportunity_contract_version",
    "scoring_system_kind",
    "scoring_system_version",
    "scoring_system_sha256",
    "snapshot_sha256",
    "site_catalog_sha256",
    "impression_attestation_sha256",
    "score_exposure_attestation_sha256",
    "forecast_impression_id",
    "impression_or_assignment_at",
    "selection_design",
    "score_influenced_choice",
    "study_consent_version",
    "study_consent_at",
    "target_intent_confirmed_at",
    "completion_event_contract_version",
    "completion_event_at",
    "completion_consent_version",
    "completion_consented_at",
    "completion_primary_target_confirmed",
    "completion_complete_attempt_confirmed",
    "completion_event_sha256",
    "precommitment_event_sha256",
    "score_first_exposed_at",
    "score_exposure_disposition",
    "feasible_set_sha256",
    "feasible_option_count",
    "assignment_probability_numerator",
    "assignment_probability_denominator",
    "randomization_draw_index",
    "randomization_audit_sha256",
    "deletion_status",
    "exact_coordinates_collected",
}
DELETION_LINEAGE_FIELDS = {"lineage_sha256", "reconciled_at", "status"}
MANIFEST_FIELDS = {
    "schema_version",
    "manifest_id",
    "manifest_role",
    "sequence",
    "previous_manifest_sha256",
    "protocol_id",
    "protocol_version",
    "protocol_sha256",
    "site_catalog_sha256",
    "data_snapshot_sha256",
    "prediction_snapshot_sha256",
    "created_at",
    "activated_at",
    "labels_opened_at",
    "outcome_blind",
    "append_only",
    "activation",
    "finalization",
    "assignments",
    "aggregate_counts",
    "privacy",
}
ASSIGNMENT_FIELDS = {
    "assignment_id",
    "source_record_sha256",
    "label_free_row_sha256",
    "candidate_prediction_sha256",
    "participant_group_id",
    "cohort_role",
    "source_role",
    "selection_design",
    "site_id",
    "geographic_panel",
    "temporal_block",
    "split",
    "opportunity_score",
    "evidence",
}
IMPRESSION_ATTESTATION_ENVELOPE_FIELDS = {
    "schema_version",
    "signing_key_id",
    "payload_base64",
    "payload_sha256",
    "signature_ed25519",
}
IMPRESSION_ATTESTATION_PAYLOAD_ORDER = (
    "protocol_id",
    "protocol_version",
    "activation_manifest_sha256",
    "assignment_id",
    "source_record_sha256",
    "participant_group_id",
    "activation_activated_at",
    "intended_cohort_role",
    "intended_source_role",
    "selection_design",
    "selection_method",
    "intended_cohort_id",
    "target_taxon_id",
    "recruitment_frame_id",
    "recruitment_source_id",
    "recruitment_event_contract_version",
    "recruitment_event_at",
    "recruitment_event_sha256",
    "community_approval_sha256",
    "incentive_policy_id",
    "score_influenced_choice_at_assignment",
    "study_consent_version",
    "study_consent_at",
    "target_intent_confirmed_at",
    "precommitment_event_sha256",
    "feasible_set_sha256",
    "feasible_option_count",
    "assignment_probability_numerator",
    "assignment_probability_denominator",
    "randomization_draw_index",
    "randomization_audit_sha256",
    "forecast_impression_id",
    "opportunity_window_id",
    "site_id",
    "window_start_at",
    "window_end_at",
    "opportunity_score",
    "snapshot_sha256",
    "site_catalog_sha256",
    "scoring_system_kind",
    "scoring_system_version",
    "scoring_system_sha256",
    "opportunity_contract_version",
    "impression_or_assignment_at",
    "score_exposure_state_at_attestation",
    "score_first_exposed_at_if_already_exposed",
    "attested_at",
)
IMPRESSION_ATTESTATION_PAYLOAD_FIELDS = set(IMPRESSION_ATTESTATION_PAYLOAD_ORDER)
SCORE_EXPOSURE_ATTESTATION_ENVELOPE_FIELDS = IMPRESSION_ATTESTATION_ENVELOPE_FIELDS
SCORE_EXPOSURE_ATTESTATION_PAYLOAD_ORDER = (
    "protocol_id",
    "protocol_version",
    "activation_manifest_sha256",
    "assignment_id",
    "source_record_sha256",
    "participant_group_id",
    "selection_design",
    "impression_attestation_sha256",
    "forecast_impression_id",
    "opportunity_window_id",
    "site_id",
    "window_start_at",
    "window_end_at",
    "opportunity_score",
    "snapshot_sha256",
    "site_catalog_sha256",
    "scoring_system_kind",
    "scoring_system_version",
    "scoring_system_sha256",
    "opportunity_contract_version",
    "score_first_exposed_at",
    "attested_at",
)
SCORE_EXPOSURE_ATTESTATION_PAYLOAD_FIELDS = set(
    SCORE_EXPOSURE_ATTESTATION_PAYLOAD_ORDER
)
ACTIVATION_FIELDS = {
    "release_commit",
    "scoring_system_kind",
    "scoring_system_version",
    "scoring_system_sha256",
    "opportunity_contract_version",
    "validation_export_signing_key_id",
    "validation_export_public_key_ed25519",
    "external_log_anchor_provider_id",
    "external_log_anchor_signing_key_id",
    "external_log_anchor_public_key_ed25519",
    "deployed_before_first_eligible_row",
}
PRIVACY_FIELDS = {
    "participant_ids_pseudonymous",
    "forbidden_fields_absent",
    "exact_coordinates_absent",
    "deletion_reconciled_at",
}
OPPORTUNITY_LEDGER_FIELDS = {
    "schema_version",
    "protocol_id",
    "protocol_version",
    "entries",
}
OPPORTUNITY_LEDGER_ENTRY_FIELDS = {
    "assignment_id",
    "source_record_sha256",
    "opportunity_window_id",
    "site_id",
    "window_start_at",
    "window_end_at",
    "opportunity_contract_version",
    "scoring_system_kind",
    "scoring_system_version",
    "scoring_system_sha256",
    "snapshot_sha256",
    "site_catalog_sha256",
    "impression_attestation_sha256",
    "score_exposure_attestation_sha256",
}
CANDIDATE_PREDICTION_FIELDS = {
    "schema_version",
    "protocol_id",
    "protocol_version",
    "predictions",
}
CANDIDATE_PREDICTION_ENTRY_FIELDS = {
    "assignment_id",
    "source_record_sha256",
    "opportunity_window_id",
    "scoring_system_version",
    "scoring_system_sha256",
    "snapshot_sha256",
    "opportunity_score",
}

FINALIZATION_FIELDS = {
    "census_export_canonical_sha256",
    "census_export_file_sha256",
    "eligible_source_count",
    "query_watermark_start_at",
    "query_watermark_end_at",
    "completion_event_set_sha256",
    "issuance_reconciliation",
    "finalized_after_enrollment",
    "evaluator_identity",
}
EVALUATOR_IDENTITY_FIELDS = {
    "release_commit",
    "tracked_source_tree_clean",
    "file_sha256",
    "dependency_lock_sha256",
    "runtime_versions",
    "algorithm_config_sha256",
    "runtime_image_digest",
    "evaluator_environment_sha256",
}
EVALUATOR_RUNTIME_VERSION_FIELDS = {
    "python",
    "python_implementation",
    "narwhals",
    "numpy",
    "scipy",
    "scikit-learn",
    "cffi",
    "cryptography",
    "joblib",
    "pycparser",
    "threadpoolctl",
}
EVALUATOR_SOURCE_PATHS = (
    "contracts/fixtures/impression-attestation-vector.json",
    "contracts/model-run.schema.json",
    "contracts/observation.schema.json",
    "contracts/opportunity.schema.json",
    "contracts/taxa.json",
    "contracts/validation-preregistration.schema.json",
    "contracts/validation-split-manifest.schema.json",
    "pipeline/contourcast/validation_protocol.py",
    "pipeline/contourcast/first_party_validation.py",
    "pipeline/contourcast/cli.py",
    "pipeline/requirements-validation.lock",
    "public/data/sites.json",
    "shared/species_contract.py",
    "validation/protocols/california-halibut-site-window-v1.json",
)
COLLECTION_EVENT_TYPES = (
    "enrollment",
    "completion",
    "evidence_exclusion",
    "retrospective_submission",
    "legacy_context",
)
COLLECTION_EVENT_PROJECTION_FIELDS = {
    "id",
    "event_type",
    "created_at",
    "exclusion_reason",
}
CENSUS_EXPORT_FIELDS = {
    "schema_version",
    "signing_key_id",
    "payload_base64",
    "payload_sha256",
    "signature_ed25519",
}
CENSUS_PAYLOAD_FIELDS = {
    "protocol_id",
    "protocol_version",
    "activation_manifest_sha256",
    "query_id",
    "generated_at",
    "query_watermark_start_at",
    "query_watermark_end_at",
    "enrollment_start_at",
    "enrollment_end_at",
    "eligible_source_count",
    "first_export_ordinal",
    "last_export_ordinal",
    "status_counts",
    "recruitment_source_counts",
    "records",
    "eligible_omissions",
    "issuance_reconciliation",
}
CENSUS_RECORD_FIELDS = {
    "export_ordinal",
    "label_free_evidence",
}
ISSUANCE_RECONCILIATION_FIELDS = {
    "evidence_basis",
    "append_only_log_proof_included",
    "query_id",
    "reconciled_through_at",
    "issuance_stream",
    "signed_primary_exposure_stream",
    "issued_assignment_count",
    "issued_assignment_set_sha256",
    "signed_primary_exposure_event_count",
    "signed_primary_exposure_event_set_sha256",
    "terminal_disposition_set_sha256",
    "terminal_disposition_counts",
    "intended_to_final_disposition_counts",
    "missing_issued_assignment_count",
    "unmatched_exposure_event_count",
    "missing_issued_assignment_ids",
    "unmatched_exposure_event_ids",
    "records",
}
RECONCILIATION_STREAM_FIELDS = {
    "stream_id",
    "first_sequence",
    "last_sequence",
    "event_count",
    "event_set_sha256",
    "chain_tip_sha256",
    "external_log_proof_sha256",
}
FINALIZATION_ISSUANCE_RECONCILIATION_FIELDS = {
    "evidence_basis",
    "append_only_log_proof_included",
    "query_id",
    "reconciled_through_at",
    "issuance_stream",
    "signed_primary_exposure_stream",
    "issued_assignment_count",
    "issued_assignment_set_sha256",
    "signed_primary_exposure_event_count",
    "signed_primary_exposure_event_set_sha256",
    "terminal_disposition_set_sha256",
    "terminal_disposition_counts",
    "intended_to_final_disposition_counts",
    "missing_issued_assignment_count",
    "unmatched_exposure_event_count",
}
ISSUANCE_DISPOSITION_RECORD_FIELDS = {
    "assignment_sequence",
    "assignment_id",
    "source_record_sha256",
    "impression_attestation_sha256",
    "assignment_issued_at",
    "intended_cohort_role",
    "intended_source_role",
    "segment_start_at",
    "completion_event_at",
    "exposure_sequence",
    "score_exposure_attestation_sha256",
    "score_exposure_links_impression_attestation_sha256",
    "score_exposed_at",
    "score_exposure_evidence_kind",
    "score_exposure_disposition",
    "sealed_row_score_exposure_disposition",
    "terminal_disposition",
    "terminal_reason",
    "final_cohort_role",
    "label_free_row_sha256",
    "completion_event_sha256",
    "reconciliation_watermark_at",
    "terminal_collection_provenance_chain_sha256",
    "disposition_event_sha256",
}
ISSUANCE_DISPOSITION_STATUSES = (
    "completed-and-exported",
    "incomplete-or-expired",
    "safe-canceled",
    "withdrawn",
    "excluded",
)
EXPECTED_ISSUANCE_RECONCILIATION_CONTRACT = {
    "census_field": "issuance_reconciliation",
    "query_id": "castingcompass-terminal-issuance-exposure-reconciliation-v1",
    "local_evidence_basis": "signed-exporter-assertion-without-raw-ledger-proof",
    "local_append_only_log_proof_included": False,
    "stream_fields": [
        "stream_id",
        "first_sequence",
        "last_sequence",
        "event_count",
        "event_set_sha256",
        "chain_tip_sha256",
        "external_log_proof_sha256",
    ],
    "issuance_stream_id": "castingcompass-assignment-issuance-v1",
    "signed_primary_exposure_stream_id": (
        "castingcompass-signed-primary-score-exposure-v1"
    ),
    "signed_primary_exposure_stream_scope": (
        "signer-issued-post-assignment-primary-first-exposure-events-only"
    ),
    "secondary_prior_exposure_rule": (
        "asserted-in-later-assignment-envelope-not-counted-in-signed-exposure-stream"
    ),
    "record_fields": [
        "assignment_sequence",
        "assignment_id",
        "source_record_sha256",
        "impression_attestation_sha256",
        "assignment_issued_at",
        "intended_cohort_role",
        "intended_source_role",
        "segment_start_at",
        "completion_event_at",
        "exposure_sequence",
        "score_exposure_attestation_sha256",
        "score_exposure_links_impression_attestation_sha256",
        "score_exposed_at",
        "score_exposure_evidence_kind",
        "score_exposure_disposition",
        "sealed_row_score_exposure_disposition",
        "terminal_disposition",
        "terminal_reason",
        "final_cohort_role",
        "label_free_row_sha256",
        "completion_event_sha256",
        "reconciliation_watermark_at",
        "terminal_collection_provenance_chain_sha256",
        "disposition_event_sha256",
    ],
    "assignment_set_projection_fields": [
        "assignment_id",
        "impression_attestation_sha256",
    ],
    "signed_primary_exposure_set_projection_fields": [
        "assignment_id",
        "score_exposure_attestation_sha256",
    ],
    "terminal_disposition_set_projection_fields": [
        "assignment_id",
        "disposition_event_sha256",
    ],
    "stream_event_projection_fields": [
        "sequence",
        "event_type",
        "assignment_id",
        "event_sha256",
        "event_at",
    ],
    "score_exposure_evidence_kinds": [
        "none",
        "signed-first-exposure-event",
        "prior-exposure-asserted-in-impression",
    ],
    "score_exposure_dispositions": [
        "already-exposed-before-assignment",
        "exposed-after-assignment-no-effort-started",
        "exposed-after-assignment-before-segment",
        "exposed-during-started-incomplete-effort",
        "exposed-during-effort-through-completion",
        "exposed-after-completion",
        "no-issued-exposure-through-terminal-watermark",
    ],
    "terminal_dispositions": list(ISSUANCE_DISPOSITION_STATUSES),
    "terminal_snapshot_rule": (
        "reconciliation-watermark-at-equals-reconciled-through-at-and-is-not-an-event-occurrence-time"
    ),
    "sequence_rule": "consecutive-gapless-monotone-timestamps-starting-at-one",
    "zero_missing_and_unmatched_required": True,
    "sealed_issued_role_rule": (
        "final-primary-or-secondary-must-exactly-equal-signed-intended-role"
    ),
    "unsealed_issued_rule": (
        "final-role-and-label-free-row-hash-null-with-exhaustive-terminal-disposition"
    ),
    "external_log_proof_interface": {
        "implementation_status": "not-implemented-production-blocker",
        "artifact_schema_version": (
            "castingcompass.validation-external-log-proof/1.0.0"
        ),
        "anchor_identity_source": "activation-pinned-distinct-from-exporter",
        "anchor_must_differ_from_export_signing_key": True,
        "required_artifact_fields": [
            "protocol_id",
            "activation_manifest_sha256",
            "issuance_checkpoint_tree_root_sha256",
            "issuance_checkpoint_tree_size",
            "exposure_checkpoint_tree_root_sha256",
            "exposure_checkpoint_tree_size",
            "event_inclusion_proofs",
            "checkpoint_consistency_chain",
            "effort_boundary_events",
            "anchored_checkpoint_at",
            "anchor_signing_key_id",
            "anchor_allowlist_receipt_sha256",
            "transparency_receipt_sha256",
            "signature_ed25519",
        ],
        "issuance_inclusion_deadline": (
            "each-assignment-included-within-300-seconds-of-assignment-issued-at-and-"
            "strictly-before-segment-start-when-a-segment-exists"
        ),
        "exposure_inclusion_deadline": (
            "each-signed-exposure-included-within-300-seconds-of-score-first-exposed-at-"
            "and-exposures-admitted-into-the-sealed-label-free-row-strictly-before-"
            "segment-start"
        ),
        "maximum_assignment_anchor_delay_seconds": 300,
        "maximum_exposure_anchor_delay_seconds": 300,
        "gapless_consistency_rule": (
            "verified-consistency-and-inclusion-proofs-cover-every-sequence-through-"
            "terminal-checkpoint"
        ),
        "zero_event_stream_rule": (
            "independently-signed-and-anchored-zero-size-terminal-checkpoint-with-"
            "verified-genesis-consistency-required"
        ),
        "proof_bundle_data_rule": (
            "verifier-consumes-canonical-proof-arrays-checkpoint-roots-and-tree-sizes-"
            "not-caller-asserted-proof-digests"
        ),
        "anchor_trust_rule": (
            "activation-pinned-anchor-must-also-verify-against-an-external-allowlist-"
            "with-independent-key-custody"
        ),
        "terminal_checkpoint_max_delay_seconds": 300,
        "terminal_checkpoint_rule": (
            "covers-every-issuance-and-exposure-event-through-reconciled-through-at-"
            "and-is-anchored-at-or-after-that-watermark-and-within-300-seconds-"
            "including-zero-size-streams"
        ),
        "effort_boundary_rule": (
            "exact-server-authoritative-segment-start-and-completion-event-identities-and-"
            "times-covered-by-the-independently-verified-collection-ledger-proof"
        ),
        "verification_required_before_activation": True,
        "verification_required_before_publication": True,
        "local_evaluator_accepts_proof_mode": False,
    },
}
DELETION_LEDGER_FIELDS = {
    "schema_version",
    "signing_key_id",
    "payload_base64",
    "payload_sha256",
    "signature_ed25519",
}
DELETION_LEDGER_PAYLOAD_FIELDS = {
    "ledger_id",
    "sequence",
    "previous_ledger_sha256",
    "protocol_id",
    "protocol_version",
    "activation_manifest_sha256",
    "finalization_manifest_sha256",
    "sealed_assignment_set_sha256",
    "created_at",
    "reconciled_through_at",
    "events",
}
DELETION_EVENT_FIELDS = {
    "event_id",
    "assignment_id",
    "source_record_sha256",
    "status",
    "reason",
    "occurred_at",
    "source_event_sha256",
}
LABELED_EXPORT_FIELDS = {
    "schema_version",
    "signing_key_id",
    "payload_base64",
    "payload_sha256",
    "signature_ed25519",
}
LABELED_EXPORT_PAYLOAD_FIELDS = {
    "protocol_id",
    "protocol_version",
    "activation_manifest_sha256",
    "finalization_manifest_sha256",
    "deletion_reconciliation_sha256",
    "label_lock_manifest_sha256",
    "generated_at",
    "records",
}
PUBLICATION_REQUEST_FIELDS = {
    "schema_version",
    "publication_request_nonce",
    "requested_at",
    "protocol_id",
    "protocol_version",
    "activation_manifest_sha256",
    "finalization_manifest_sha256",
    "deletion_reconciliation_sha256",
    "deletion_reconciliation_chain_sha256",
    "label_lock_manifest_sha256",
    "label_access_receipt_sha256",
    "analysis_result_sha256",
    "evaluator_identity_sha256",
    "runtime_image_digest",
    "required_execution_mode",
    "active_assignment_ids_sha256",
    "reconciliation_counts",
    "issuance_reconciliation_sha256",
    "append_only_log_proof_included",
    "minimum_checked_at",
    "required_signature",
}
PUBLICATION_AUDIT_FIELDS = LABELED_EXPORT_FIELDS
PUBLICATION_AUDIT_PAYLOAD_FIELDS = {
    "protocol_id",
    "protocol_version",
    "activation_manifest_sha256",
    "finalization_manifest_sha256",
    "deletion_reconciliation_sha256",
    "deletion_reconciliation_chain_sha256",
    "label_lock_manifest_sha256",
    "label_access_receipt_sha256",
    "analysis_result_sha256",
    "evaluator_identity_sha256",
    "runtime_image_digest",
    "publication_request_nonce",
    "publication_request_sha256",
    "trusted_publication_nonce",
    "trusted_publication_nonce_issued_at",
    "trusted_publication_nonce_consumed_at",
    "atomic_reconciliation_nonce_consumption_and_publication_completed",
    "production_artifact_sha256",
    "trusted_publication_service_attestation_sha256",
    "independent_recomputation_completed",
    "recomputed_analysis_result_sha256",
    "trusted_execution_attestation_sha256",
    "active_assignment_ids_sha256",
    "reconciliation_counts",
    "issuance_reconciliation_sha256",
    "append_only_log_proof_included",
    "checked_at",
    "reconciled_through_at",
}
PUBLICATION_AUDIT_MAX_AGE_SECONDS = 300
FORBIDDEN_EVIDENCE_FIELDS = {
    "raw_email",
    "email",
    "account_id",
    "user_id",
    "reporter_key",
    "reporter_key_hash",
    "reporter_hash",
    "trip_notes",
    "notes",
    "photo",
    "photo_key",
    "image",
    "x",
    "y",
    "lat",
    "lon",
    "lng",
    "latitude",
    "longitude",
    "coordinates",
    "geometry",
    "crs",
}


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def strict_json_loads(
    data: str | bytes,
    *,
    artifact: str,
    reject_floats: bool = False,
) -> Any:
    """Parse JSON while rejecting duplicate keys and non-finite/float payloads."""

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"{artifact} contains duplicate object key {key!r}")
            value[key] = item
        return value

    def parse_float(value: str) -> float:
        if reject_floats:
            raise ValueError(f"{artifact} cannot contain floating-point numbers")
        return float(value)

    def reject_constant(value: str) -> None:
        raise ValueError(f"{artifact} contains non-finite number {value}")

    try:
        return json.loads(
            data,
            object_pairs_hook=object_pairs,
            parse_float=parse_float,
            parse_constant=reject_constant,
        )
    except json.JSONDecodeError as exc:
        raise ValueError(f"{artifact} is invalid JSON") from exc


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def trusted_utc_now() -> datetime:
    """Return the trusted wall clock used for chronology checks."""

    return datetime.now(timezone.utc)


def require_private_file(path: Path, *, artifact: str) -> None:
    """Require a regular 0600-or-stricter artifact in a private directory."""

    try:
        info = path.lstat()
    except OSError as exc:
        raise ValueError(f"{artifact} is unavailable: {path}") from exc
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError(f"{artifact} must be a regular non-symlink file")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f"{artifact} must be private mode 0600 or stricter")
    if stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
        raise ValueError(f"{artifact} parent directory must be private mode 0700 or stricter")
    _require_safe_private_location(path, artifact=artifact)


def read_private_bytes_once(path: Path, *, artifact: str) -> bytes:
    """Open one non-symlink private inode and return the exact held bytes."""

    require_private_file(path, artifact=artifact)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError(f"{artifact} changed while being opened")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _require_safe_private_location(path: Path, *, artifact: str) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPOSITORY_ROOT.resolve())
    except ValueError:
        return
    try:
        resolved.relative_to(PRIVATE_VALIDATION_ROOT.resolve())
    except ValueError as exc:
        raise ValueError(
            f"{artifact} cannot live inside the repository outside .validation-private"
        ) from exc
    ignored = subprocess.run(
        ["git", "check-ignore", "--quiet", str(resolved)],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
    )
    if ignored.returncode != 0:
        raise ValueError(".validation-private must remain ignored by Git")


def _ensure_private_parent(path: Path) -> None:
    _require_safe_private_location(path, artifact="private validation output")
    if not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=False, mode=0o700)
        os.chmod(path.parent, 0o700)
    if stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
        raise ValueError(
            "private validation directory must be pre-created with mode 0700 or stricter"
        )


def write_private_json_new(path: Path, value: Mapping[str, Any]) -> None:
    """Create and durably fsync an immutable private JSON artifact."""

    _ensure_private_parent(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError as exc:
        raise ValueError(f"refusing to overwrite immutable validation artifact {path}") from exc
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    require_private_file(path, artifact="new validation artifact")


def verify_release_commit_contains_protocol(
    release_commit: str, protocol_path: Path, protocol_sha256: str
) -> None:
    """Verify the declared Git object actually contains this frozen protocol."""

    try:
        relative = protocol_path.resolve().relative_to(REPOSITORY_ROOT.resolve())
    except ValueError as exc:
        raise ValueError("activation protocol must live inside the repository") from exc
    result = subprocess.run(
        ["git", "show", f"{release_commit}:{relative.as_posix()}"],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ValueError("release_commit does not contain the frozen validation protocol")
    try:
        committed = strict_json_loads(result.stdout, artifact="committed validation protocol")
    except ValueError as exc:
        raise ValueError("release_commit contains an invalid validation protocol") from exc
    if canonical_sha256(committed) != protocol_sha256:
        raise ValueError("release_commit validation protocol differs from the frozen artifact")


def git_object_file_sha256(release_commit: str, relative_path: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{release_commit}:{relative_path}"],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise ValueError(f"release_commit does not contain {relative_path}")
    return hashlib.sha256(result.stdout).hexdigest()


def _evaluator_algorithm_config_sha256(protocol: Mapping[str, Any]) -> str:
    return canonical_sha256(
        {
            "candidate": protocol["candidate"],
            "baselines": protocol["baselines"],
            "analysis": protocol["analysis"],
            "sample_plan": protocol["sample_plan"],
            "split_policy": protocol["split_policy"],
            "temporal_design": protocol["temporal_design"],
            "eligibility": protocol["eligibility"],
        }
    )


def _evaluator_runtime_versions() -> dict[str, str]:
    versions = {
        "python": platform.python_version(),
        "python_implementation": platform.python_implementation(),
    }
    for distribution in (
        "narwhals",
        "numpy",
        "scipy",
        "scikit-learn",
        "cffi",
        "cryptography",
        "joblib",
        "pycparser",
        "threadpoolctl",
    ):
        try:
            versions[distribution] = importlib_metadata.version(distribution)
        except importlib_metadata.PackageNotFoundError as exc:
            raise ValueError(
                f"frozen evaluator dependency {distribution} is not installed"
            ) from exc
    return versions


def _validation_dependency_lock() -> dict[str, str]:
    lock_path = REPOSITORY_ROOT / "pipeline/requirements-validation.lock"
    locked: dict[str, str] = {}
    for line in lock_path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("==")
        if len(parts) != 2 or not parts[0] or not parts[1] or parts[0] in locked:
            raise ValueError("validation dependency lock must contain exact unique versions")
        locked[parts[0]] = parts[1]
    if set(locked) != EVALUATOR_RUNTIME_VERSION_FIELDS - {"python", "python_implementation"}:
        raise ValueError("validation dependency lock does not cover the frozen runtime")
    return locked


def _runtime_image_digest(protocol: Mapping[str, Any]) -> str:
    runtime_policy = protocol.get("evaluator_runtime")
    if not isinstance(runtime_policy, dict):
        raise ValueError("validation evaluator runtime policy is missing")
    digest_path = Path(str(runtime_policy.get("runtime_image_digest_file", "")))
    if not digest_path.is_absolute():
        raise ValueError("runtime image digest path must be absolute")
    try:
        info = digest_path.lstat()
    except OSError as exc:
        raise ValueError("immutable validation image digest file is unavailable") from exc
    if (
        not stat.S_ISREG(info.st_mode)
        or digest_path.is_symlink()
        or info.st_uid != 0
        or stat.S_IMODE(info.st_mode) & 0o022
    ):
        raise ValueError("validation image digest file must be root-owned and non-writable")
    digest = digest_path.read_text(encoding="ascii").strip()
    if re.fullmatch(r"sha256:[a-f0-9]{64}", digest) is None:
        raise ValueError("validation runtime image digest is invalid")
    return digest


def build_frozen_evaluator_identity(protocol: Mapping[str, Any]) -> dict[str, Any]:
    """Capture the exact clean evaluator/runtime identity before labels exist."""

    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if head.returncode != 0 or re.fullmatch(r"[a-f0-9]{40}", head.stdout.strip()) is None:
        raise ValueError("cannot determine the frozen evaluator release commit")
    release_commit = head.stdout.strip()
    status = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if status.returncode != 0 or status.stdout:
        raise ValueError("tracked evaluator source tree must be clean at finalization")
    file_sha256 = {
        relative: sha256_file(REPOSITORY_ROOT / relative)
        for relative in EVALUATOR_SOURCE_PATHS
    }
    for relative, digest in file_sha256.items():
        if git_object_file_sha256(release_commit, relative) != digest:
            raise ValueError(f"release commit does not contain exact evaluator file {relative}")
    lock_digest = file_sha256["pipeline/requirements-validation.lock"]
    runtime_versions = _evaluator_runtime_versions()
    required_python = str(protocol["evaluator_runtime"]["python_major_minor"])
    if ".".join(runtime_versions["python"].split(".")[:2]) != required_python:
        raise ValueError(f"validation evaluator requires Python {required_python}")
    locked = _validation_dependency_lock()
    if any(runtime_versions[name] != version for name, version in locked.items()):
        raise ValueError("installed validation dependencies differ from the exact lock")
    image_digest = _runtime_image_digest(protocol)
    environment = canonical_sha256(
        {
            "runtime_image_digest": image_digest,
            "machine": platform.machine(),
            "system": platform.system(),
            "python_build": list(platform.python_build()),
            "python_compiler": platform.python_compiler(),
            "python_executable_sha256": sha256_file(Path(sys.executable)),
        }
    )
    return {
        "release_commit": release_commit,
        "tracked_source_tree_clean": True,
        "file_sha256": file_sha256,
        "dependency_lock_sha256": lock_digest,
        "runtime_versions": runtime_versions,
        "algorithm_config_sha256": _evaluator_algorithm_config_sha256(protocol),
        "runtime_image_digest": image_digest,
        "evaluator_environment_sha256": environment,
    }


def _validate_evaluator_identity_shape(
    identity: Any, protocol: Mapping[str, Any], *, location: str
) -> None:
    if not isinstance(identity, dict):
        raise ValueError(f"{location} must be an object")
    _require_exact_keys(identity, EVALUATOR_IDENTITY_FIELDS, location=location)
    release_commit = identity.get("release_commit")
    if not isinstance(release_commit, str) or re.fullmatch(r"[a-f0-9]{40}", release_commit) is None:
        raise ValueError(f"{location}.release_commit is invalid")
    if identity.get("tracked_source_tree_clean") is not True:
        raise ValueError(f"{location} must attest a clean tracked source tree")
    file_digests = identity.get("file_sha256")
    if not isinstance(file_digests, dict) or set(file_digests) != set(EVALUATOR_SOURCE_PATHS):
        raise ValueError(f"{location}.file_sha256 does not cover the frozen evaluator")
    for relative, digest in file_digests.items():
        if not isinstance(relative, str) or not isinstance(digest, str) or SHA256_PATTERN.fullmatch(digest) is None:
            raise ValueError(f"{location}.file_sha256 is invalid")
    if identity.get("dependency_lock_sha256") != file_digests.get(
        "pipeline/requirements-validation.lock"
    ):
        raise ValueError(f"{location}.dependency_lock_sha256 is inconsistent")
    versions = identity.get("runtime_versions")
    if not isinstance(versions, dict) or set(versions) != EVALUATOR_RUNTIME_VERSION_FIELDS:
        raise ValueError(f"{location}.runtime_versions is incomplete")
    if not all(isinstance(value, str) and bool(value) for value in versions.values()):
        raise ValueError(f"{location}.runtime_versions is invalid")
    for field in ("algorithm_config_sha256", "evaluator_environment_sha256"):
        value = identity.get(field)
        if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
            raise ValueError(f"{location}.{field} is invalid")
    if identity.get("algorithm_config_sha256") != _evaluator_algorithm_config_sha256(protocol):
        raise ValueError(f"{location}.algorithm_config_sha256 changed")
    if re.fullmatch(r"sha256:[a-f0-9]{64}", str(identity.get("runtime_image_digest"))) is None:
        raise ValueError(f"{location}.runtime_image_digest is invalid")
    required_python = str(protocol.get("evaluator_runtime", {}).get("python_major_minor", ""))
    if ".".join(str(versions["python"]).split(".")[:2]) != required_python:
        raise ValueError(f"{location} does not use frozen Python {required_python}")
    locked = _validation_dependency_lock()
    if any(versions.get(name) != version for name, version in locked.items()):
        raise ValueError(f"{location} differs from the exact dependency lock")


def verify_frozen_evaluator_identity(
    identity: Mapping[str, Any], protocol: Mapping[str, Any]
) -> dict[str, Any]:
    """Fail before label access unless runtime/source exactly match finalization."""

    _validate_evaluator_identity_shape(identity, protocol, location="evaluator_identity")
    actual = build_frozen_evaluator_identity(protocol)
    if actual != dict(identity):
        raise ValueError("evaluator source, runtime, algorithm, or environment changed after finalization")
    return actual


def utc_now() -> str:
    return trusted_utc_now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_datetime(value: Any, *, location: str) -> datetime:
    if not is_strict_offset_datetime(value):
        raise ValueError(f"{location} must be a valid ISO-8601 timestamp with an explicit offset")
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{location} must have an explicit offset")
    return parsed.astimezone(timezone.utc)


def _require_exact_keys(value: Mapping[str, Any], expected: set[str], *, location: str) -> None:
    missing = expected - set(value)
    extra = set(value) - expected
    if missing or extra:
        raise ValueError(
            f"{location} fields are not permitted; missing={sorted(missing)}, extra={sorted(extra)}"
        )


def _is_stable_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", value
    ) is not None


def _is_nonnegative_int(value: Any) -> bool:
    return type(value) is int and value >= 0


def _is_nonnegative_int_map(
    value: Any, *, expected_keys: set[str] | None = None
) -> bool:
    return (
        isinstance(value, dict)
        and (expected_keys is None or set(value) == expected_keys)
        and all(_is_nonnegative_int(count) for count in value.values())
    )


def _decode_ed25519_public_key(value: Any, *, location: str) -> bytes:
    if not isinstance(value, str):
        raise ValueError(f"{location} must be base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"{location} must be canonical base64") from exc
    if len(decoded) != 32 or base64.b64encode(decoded).decode("ascii") != value:
        raise ValueError(f"{location} must encode one 32-byte Ed25519 public key")
    return decoded


def _reject_placeholders(value: Any, *, location: str = "$") -> None:
    if isinstance(value, str):
        if PLACEHOLDER_PATTERN.search(value) or value == "0" * 64:
            raise ValueError(f"{location} contains a placeholder")
    elif isinstance(value, Mapping):
        for key, item in value.items():
            _reject_placeholders(item, location=f"{location}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _reject_placeholders(item, location=f"{location}[{index}]")


def _reject_forbidden_fields(value: Any, *, location: str = "$") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            if normalized in FORBIDDEN_EVIDENCE_FIELDS:
                raise ValueError(f"{location}.{key} is a forbidden privacy field")
            _reject_forbidden_fields(item, location=f"{location}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _reject_forbidden_fields(item, location=f"{location}[{index}]")


def _load_json_records(path: Path) -> list[Mapping[str, Any]]:
    suffix = path.suffix.lower()
    if suffix in {".jsonl", ".ndjson"}:
        records: list[Mapping[str, Any]] = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                item = strict_json_loads(line, artifact=f"validation evidence line {line_number}")
            except ValueError as exc:
                raise ValueError(f"invalid validation evidence JSON on line {line_number}") from exc
            if not isinstance(item, dict):
                raise ValueError(f"validation evidence line {line_number} must be an object")
            records.append(item)
        return records
    if suffix == ".json":
        try:
            document = strict_json_loads(
                path.read_text(encoding="utf-8"), artifact="validation evidence"
            )
        except ValueError as exc:
            raise ValueError("invalid validation evidence JSON") from exc
        if isinstance(document, dict) and set(document) == {"evidence"}:
            document = document["evidence"]
        if not isinstance(document, list) or not all(isinstance(item, dict) for item in document):
            raise ValueError("validation evidence JSON must be an array or {evidence: [...]} object")
        return document
    raise ValueError("validation evidence must be canonical JSONL/JSON")


def load_validation_protocol(path: Path = DEFAULT_PROTOCOL_PATH) -> tuple[dict[str, Any], str]:
    """Load and semantically verify the one frozen launch preregistration."""

    try:
        protocol = strict_json_loads(
            path.read_text(encoding="utf-8"), artifact="validation protocol"
        )
    except (OSError, ValueError) as exc:
        raise ValueError(f"could not load validation protocol {path}") from exc
    if not isinstance(protocol, dict):
        raise ValueError("validation protocol must be an object")
    _reject_placeholders(protocol)
    digest = canonical_sha256(protocol)
    if digest != EXPECTED_PROTOCOL_CANONICAL_SHA256:
        raise ValueError(
            "frozen validation protocol canonical SHA-256 changed; create a new version instead"
        )
    if protocol.get("schema_version") != PROTOCOL_SCHEMA_VERSION:
        raise ValueError("validation preregistration schema version is unsupported")
    if protocol.get("protocol_id") != "california-halibut-site-window-v1":
        raise ValueError("validation protocol_id is not the frozen California-halibut protocol")
    if protocol.get("protocol_version") != "1.0.0" or protocol.get("status") != "frozen":
        raise ValueError("validation protocol must be frozen version 1.0.0")
    if not re.fullmatch(r"[a-f0-9]{40}", str(protocol.get("based_on_commit", ""))):
        raise ValueError("validation protocol based_on_commit is invalid")
    if protocol.get("frozen_at") != "2026-07-16":
        raise ValueError("validation protocol frozen_at changed")
    activation_policy = protocol.get("activation")
    if not isinstance(activation_policy, dict) or (
        activation_policy.get("trusted_export_signature_algorithm") != "ed25519-rfc8032"
        or activation_policy.get("trusted_export_public_key_pinned_in_activation") is not True
        or activation_policy.get("external_log_anchor_identity_pinned_in_activation")
        is not True
        or activation_policy.get("external_log_anchor_key_must_differ_from_export_key")
        is not True
        or activation_policy.get("external_log_anchor_provider_id_required") is not True
        or activation_policy.get(
            "external_log_anchor_must_be_externally_allowlisted_and_independently_custodied"
        )
        is not True
    ):
        raise ValueError("validation trusted-export activation policy changed")
    if protocol.get("evaluator_runtime") != {
        "python_major_minor": "3.12",
        "dependency_lock_path": "pipeline/requirements-validation.lock",
        "exact_dependency_versions_required": True,
        "immutable_runtime_image_required": True,
        "runtime_image_digest_file": "/etc/castingcompass-validation-image-digest",
        "runtime_image_digest_file_must_be_root_owned_nonwritable": True,
        "independent_publication_recomputation_required": True,
    }:
        raise ValueError("validation evaluator runtime policy changed")

    target = protocol.get("target_and_claim")
    if not isinstance(target, dict) or target.get("target_taxon_id") != PRODUCTION_TARGET_TAXON_ID:
        raise ValueError("validation protocol target is not California halibut")
    expected_contracts = {
        "taxon_catalog": TAXON_CATALOG_VERSION,
        "observation": OBSERVATION_CONTRACT_VERSION,
        "model_run": MODEL_RUN_CONTRACT_VERSION,
        "opportunity": OPPORTUNITY_CONTRACT_VERSION,
    }
    if target.get("contract_versions") != expected_contracts:
        raise ValueError("validation protocol contract versions changed")
    if target.get("score_semantics") != "ordinal-relative-ranking-0-to-100":
        raise ValueError("validation protocol must not reinterpret the score as probability")

    attestation_contract = protocol.get("eligibility", {}).get(
        "impression_attestation_contract"
    )
    if attestation_contract != {
        "schema_version": IMPRESSION_ATTESTATION_SCHEMA_VERSION,
        "canonicalization": "castingcompass-canonical-json/1.0.0",
        "canonicalization_rules": [
            "utf-8",
            "object-keys-sorted-lexicographically-by-unicode-code-point",
            "compact-comma-and-colon-separators",
            "non-ascii-characters-unescaped",
            "duplicate-object-keys-rejected",
            "floating-point-and-nonfinite-numbers-rejected",
        ],
        "payload_encoding": "canonical-json-utf8-base64-canonical",
        "payload_sha256_rule": "sha256-of-decoded-canonical-payload-bytes",
        "signature_algorithm": "ed25519-rfc8032",
        "public_key_source": "root-activation-validation-export-public-key-ed25519",
        "signing_key_id_source": "root-activation-validation-export-signing-key-id",
        "required_cohort_roles": ["primary", "secondary"],
        "envelope_fields": [
            "schema_version",
            "signing_key_id",
            "payload_base64",
            "payload_sha256",
            "signature_ed25519",
        ],
        "payload_fields": list(IMPRESSION_ATTESTATION_PAYLOAD_ORDER),
        "envelope_hash_field": "evidence.impression_attestation_sha256",
        "attested_at_rule": (
            "equals-impression-or-assignment-at-and-before-segment-start"
        ),
        "full_row_match_required": True,
        "signature_verification_required_before_prospective_admission": True,
        "unsigned_or_arbitrary_digest_allowed": False,
        "future_completion_or_admission_status_fields_allowed": False,
        "primary_exposure_state_rule": (
            "not-yet-exposed-and-no-future-exposure-time"
        ),
        "secondary_exposure_state_rule": (
            "already-exposed-with-observed-time-before-assignment"
        ),
        "cross_runtime_vector_path": (
            "contracts/fixtures/impression-attestation-vector.json"
        ),
        "cross_runtime_vector_file_sha256": (
            "8ef6ec7b001d0a9a84d554b6327f711274e0af992081f342aa6b8392894c173c"
        ),
    }:
        raise ValueError("validation impression-attestation contract changed")
    attestation_vector_path = REPOSITORY_ROOT / attestation_contract[
        "cross_runtime_vector_path"
    ]
    if (
        not attestation_vector_path.is_file()
        or sha256_file(attestation_vector_path)
        != attestation_contract["cross_runtime_vector_file_sha256"]
    ):
        raise ValueError("validation impression-attestation vector changed")
    score_exposure_contract = protocol.get("eligibility", {}).get(
        "score_exposure_attestation_contract"
    )
    if score_exposure_contract != {
        "schema_version": SCORE_EXPOSURE_ATTESTATION_SCHEMA_VERSION,
        "scope": "primary-only-when-score-is-actually-exposed",
        "sealed_row_envelope_scope": (
            "primary-first-exposure-after-assignment-and-before-segment-start-only"
        ),
        "terminal_stream_event_scope": (
            "all-signed-primary-first-exposure-events-after-assignment-through-"
            "reconciliation-watermark-including-during-or-after-effort"
        ),
        "postsegment_event_rule": (
            "terminal-reconciliation-only-never-backfilled-into-a-sealed-label-free-row"
        ),
        "never_exposed_rule": "score-time-envelope-and-envelope-hash-all-null",
        "canonicalization": "castingcompass-canonical-json/1.0.0",
        "canonicalization_rules": [
            "utf-8",
            "object-keys-sorted-lexicographically-by-unicode-code-point",
            "compact-comma-and-colon-separators",
            "non-ascii-characters-unescaped",
            "duplicate-object-keys-rejected",
            "floating-point-and-nonfinite-numbers-rejected",
        ],
        "payload_encoding": "canonical-json-utf8-base64-canonical",
        "payload_sha256_rule": "sha256-of-decoded-canonical-payload-bytes",
        "signature_algorithm": "ed25519-rfc8032",
        "public_key_source": "root-activation-validation-export-public-key-ed25519",
        "signing_key_id_source": "root-activation-validation-export-signing-key-id",
        "envelope_fields": [
            "schema_version",
            "signing_key_id",
            "payload_base64",
            "payload_sha256",
            "signature_ed25519",
        ],
        "payload_fields": list(SCORE_EXPOSURE_ATTESTATION_PAYLOAD_ORDER),
        "chain_rule": "links-prior-impression-attestation-sha256",
        "attested_at_rule": (
            "equals-score-first-exposed-at-strictly-after-assignment-and-at-or-before-"
            "reconciliation-watermark"
        ),
        "sealed_row_admission_rule": (
            "score-first-exposed-at-and-attested-at-must-both-be-strictly-before-"
            "segment-start"
        ),
        "secondary_rule": (
            "no-exposure-envelope-assignment-attestation-binds-prior-observed-exposure"
        ),
        "envelope_hash_field": "evidence.score_exposure_attestation_sha256",
        "signature_verification_required": True,
        "disposition_field": "evidence.score_exposure_disposition",
        "disposition_mapping": {
            "primary_never_exposed": "never-exposed-through-completion",
            "primary_exposed": "exposed-after-assignment-before-segment",
            "secondary": "already-exposed-before-assignment",
            "nonprospective": "not-applicable",
        },
        "terminal_signed_census_binds_disposition": True,
        "terminal_exposure_ledger_reconciliation_required": True,
        "cross_runtime_vector_path": (
            "contracts/fixtures/impression-attestation-vector.json"
        ),
        "cross_runtime_vector_file_sha256": (
            "8ef6ec7b001d0a9a84d554b6327f711274e0af992081f342aa6b8392894c173c"
        ),
    }:
        raise ValueError("validation score-exposure-attestation contract changed")

    eligibility = protocol.get("eligibility")
    if not isinstance(eligibility, dict):
        raise ValueError("validation eligibility policy is missing")
    if (
        eligibility.get("terminal_issuance_reconciliation_contract")
        != EXPECTED_ISSUANCE_RECONCILIATION_CONTRACT
    ):
        raise ValueError("validation terminal issuance reconciliation contract changed")
    if eligibility.get("immutable_pre_outcome_fields") != [
        "selection_design",
        "score_influenced_choice",
        "precommitment_event_sha256",
        "study_consent_version",
        "target_intent_confirmed_at",
        "impression_or_assignment_at",
    ]:
        raise ValueError("validation pre-outcome immutability policy changed")
    if eligibility.get("immutable_score_exposure_event_fields") != [
        "score_first_exposed_at",
        "score_exposure_attestation_sha256",
    ]:
        raise ValueError("validation score-exposure immutability policy changed")
    if eligibility.get("immutable_completion_fields") != [
        "completion_event_at",
        "completion_consent_version",
        "completion_consented_at",
        "completion_primary_target_confirmed",
        "completion_complete_attempt_confirmed",
        "completion_event_sha256",
        "effort_unit",
        "attempt_count",
        "duration_milliseconds",
        "angler_count",
        "person_milliseconds",
    ]:
        raise ValueError("validation completion immutability policy changed")
    if eligibility.get("immutable_terminal_reconciliation_fields") != [
        "score_exposure_disposition",
        "terminal_disposition",
        "terminal_reason",
        "disposition_event_sha256",
    ]:
        raise ValueError("validation terminal immutability policy changed")
    if (
        eligibility.get("edit_policy")
        != "fail-closed-append-evidence-exclusion-and-remove-from-active-analysis"
        or eligibility.get("deletion_withdrawal_and_exclusion_policy")
        != "remove-from-future-runs-and-reconcile-derived-private-artifacts"
    ):
        raise ValueError("validation post-seal removal policy changed")

    geography = protocol.get("geography")
    if not isinstance(geography, dict):
        raise ValueError("validation protocol geography is missing")
    site_path = REPOSITORY_ROOT / str(geography.get("site_catalog_path", ""))
    site_digest = geography.get("site_catalog_sha256")
    if not isinstance(site_digest, str) or SHA256_PATTERN.fullmatch(site_digest) is None:
        raise ValueError("validation protocol site catalog SHA-256 is invalid")
    if not site_path.is_file() or sha256_file(site_path) != site_digest:
        raise ValueError("validation protocol site catalog SHA-256 does not match the frozen catalog")
    site_document = strict_json_loads(
        site_path.read_text(encoding="utf-8"), artifact="frozen site catalog"
    )
    if not isinstance(site_document, list):
        raise ValueError("frozen site catalog must be an array")
    catalog_ids = {item.get("id") for item in site_document if isinstance(item, dict)}
    panels = geography.get("panels")
    if not isinstance(panels, list) or len(panels) != 5:
        raise ValueError("validation protocol must contain five geographic panels")
    panel_sites: list[str] = []
    panel_ids: list[str] = []
    for panel in panels:
        if not isinstance(panel, dict) or not isinstance(panel.get("site_ids"), list):
            raise ValueError("validation protocol geographic panel is malformed")
        panel_ids.append(str(panel.get("panel_id")))
        panel_sites.extend(str(site) for site in panel["site_ids"])
    excluded = geography.get("excluded_sites")
    excluded_ids = {
        item.get("site_id") for item in excluded if isinstance(item, dict)
    } if isinstance(excluded, list) else set()
    if len(panel_sites) != geography.get("eligible_site_count") or len(set(panel_sites)) != len(panel_sites):
        raise ValueError("validation protocol panel site coverage is incomplete or duplicated")
    if set(panel_sites) | excluded_ids != catalog_ids:
        raise ValueError("validation protocol panels do not exactly cover the frozen site catalog")
    if len(set(panel_ids)) != len(panel_ids):
        raise ValueError("validation protocol geographic panels are duplicated")

    enrollment = protocol.get("enrollment")
    temporal = protocol.get("temporal_design")
    if not isinstance(enrollment, dict) or not isinstance(temporal, dict):
        raise ValueError("validation enrollment or temporal design is missing")
    enrollment_start = _parse_datetime(enrollment.get("start_at"), location="$.enrollment.start_at")
    enrollment_end = _parse_datetime(enrollment.get("end_at"), location="$.enrollment.end_at")
    if enrollment_end <= enrollment_start:
        raise ValueError("validation enrollment dates are reversed")
    if any(
        enrollment.get(field) is not True
        for field in (
            "terminal_finalization_required",
            "finalization_not_before_end_at",
            "trusted_complete_census_export_required",
        )
    ):
        raise ValueError("validation terminal census policy changed")
    blocks = temporal.get("blocks")
    if not isinstance(blocks, list) or [item.get("block_id") for item in blocks if isinstance(item, dict)] != [
        "block-1", "block-2", "block-3", "block-4"
    ]:
        raise ValueError("validation temporal blocks changed")
    parsed_blocks = []
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise ValueError("validation temporal block must be an object")
        start = _parse_datetime(block.get("start_at"), location=f"$.temporal_design.blocks[{index}].start_at")
        end = _parse_datetime(block.get("end_at"), location=f"$.temporal_design.blocks[{index}].end_at")
        if end <= start:
            raise ValueError("validation temporal block has invalid dates")
        parsed_blocks.append((start, end))
    if parsed_blocks[0][0] != enrollment_start or parsed_blocks[-1][1] != enrollment_end:
        raise ValueError("validation temporal blocks do not cover the fixed enrollment interval")
    for previous, following in zip(parsed_blocks, parsed_blocks[1:]):
        if following[0] != previous[1]:
            raise ValueError("validation temporal blocks have a gap or overlap")
    if temporal.get("development_blocks") != ["block-1", "block-2"] or temporal.get("locked_test_blocks") != ["block-3", "block-4"]:
        raise ValueError("validation development or locked temporal blocks changed")

    split_policy = protocol.get("split_policy")
    if not isinstance(split_policy, dict) or (
        split_policy.get("deletion_events_require_complete_manifest_chain")
        is not True
        or split_policy.get(
            "deletion_events_must_strictly_follow_first_assignment_seal"
        )
        is not True
        or split_policy.get("deletion_event_order")
        != "cumulative-prefix-sorted-by-occurred-at-then-event-id"
        or split_policy.get(
            "deletion_source_event_sha256_unique_in_cumulative_snapshot"
        )
        is not True
        or split_policy.get("deletion_status_reason_map")
        != {
            "withdrawn": ["participant-withdrawal"],
            "deleted": ["account-deletion"],
            "excluded": [
                "post_completion_profile_edit",
                "trusted_review_exclusion",
            ],
        }
        or split_policy.get("deletion_status_transition_policy")
        != (
            "active-to-withdrawn-excluded-or-deleted;"
            "excluded-to-excluded-withdrawn-or-deleted;"
            "withdrawn-to-withdrawn-or-deleted;deleted-terminal-never-reactivates"
        )
        or split_policy.get("deletion_first_removal_semantics")
        != "immutable-first-event-for-analytical-accounting"
        or split_policy.get("deletion_latest_status_semantics")
        != "latest-monotone-privacy-state-for-current-counts"
    ):
        raise ValueError("validation post-seal reconciliation policy changed")

    provenance_chain = protocol.get("cohorts", {}).get("provenance_chain")
    if provenance_chain != {
        "event_projection_fields": [
            "id",
            "event_type",
            "created_at",
            "exclusion_reason",
        ],
        "canonical_sort": ["created_at", "event_type", "id"],
        "canonical_hash": "sha256-of-compact-sorted-key-utf8-json-array",
        "required_prospective_event_type_counts": {
            "enrollment": 1,
            "completion": 1,
            "evidence_exclusion": 0,
            "retrospective_submission": 0,
            "legacy_context": 0,
        },
        "terminal_effective_event_must_equal_completion": True,
        "any_exclusion_permanently_disqualifies_prospective_admission": True,
        "signed_summary_fields": [
            "collection_event_type",
            "collection_event_id",
            "collection_event_at",
            "collection_event_type_counts",
            "collection_terminal_event_id",
            "collection_terminal_event_type",
            "collection_terminal_event_at",
            "collection_provenance_chain_sha256",
        ],
    }:
        raise ValueError("validation collection provenance-chain policy changed")

    baseline_ids = [item.get("baseline_id") for item in protocol["baselines"]["definitions"]]
    if baseline_ids != [
        "prevalence-only",
        "calendar-mode-effort-logistic",
        "site-calendar-mode-effort-logistic",
    ]:
        raise ValueError("validation baseline preregistration changed")
    analysis = protocol.get("analysis")
    if not isinstance(analysis, dict) or analysis.get("primary_metric") != "auroc-concordance":
        raise ValueError("validation primary metric changed")
    if analysis.get("bootstrap", {}).get("resamples") != 2000:
        raise ValueError("validation bootstrap resample count changed")
    if analysis.get("bootstrap") != {
        "method": "paired-global-participant-cluster-bootstrap",
        "resamples": 2000,
        "random_state": 20260716,
        "participant_group": "privacy-safe-participant-group-id",
        "strata": [],
        "participant_rows_stay_together_across_all_panels_and_blocks": True,
        "interval": "percentile-95",
        "bit_generator": "PCG64",
        "percentile_method": "linear",
        "one-class_replicates": "discard-and-resample",
        "maximum_draws": 20000,
        "zero_estimable_locked_geographies_result": "inconclusive",
    }:
        raise ValueError("validation bootstrap definition changed")
    if analysis.get("promotion_gate") != {
        "candidate_auroc_lower_95_gt": 0.5,
        "paired_delta_point_gte": 0.05,
        "paired_delta_lower_95_gt": 0,
        "minimum_estimable_geography_auroc": 0.45,
    }:
        raise ValueError("validation promotion gate changed")
    return protocol, digest


def protocol_site_panel(protocol: Mapping[str, Any], site_id: str) -> str:
    for panel in protocol["geography"]["panels"]:
        if site_id in panel["site_ids"]:
            return str(panel["panel_id"])
    raise ValueError(f"site {site_id!r} is not in the frozen validation geography")


def protocol_temporal_block(
    protocol: Mapping[str, Any], start_at: datetime, end_at: datetime
) -> str:
    for block in protocol["temporal_design"]["blocks"]:
        block_start = _parse_datetime(block["start_at"], location="temporal block start")
        block_end = _parse_datetime(block["end_at"], location="temporal block end")
        if start_at >= block_start and end_at <= block_end:
            return str(block["block_id"])
    raise ValueError("effort segment is not wholly contained in one frozen temporal block")


def summarize_collection_provenance_events(
    events: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Return the canonical, append-only effective-event projection for one trip."""

    if not isinstance(events, Sequence) or isinstance(events, (str, bytes)) or not events:
        raise ValueError("collection provenance chain must be a nonempty event array")
    normalized: list[dict[str, Any]] = []
    event_ids: set[str] = set()
    for index, event in enumerate(events):
        if not isinstance(event, Mapping):
            raise ValueError("collection provenance event must be an object")
        _require_exact_keys(
            event,
            COLLECTION_EVENT_PROJECTION_FIELDS,
            location=f"collection.provenance_events[{index}]",
        )
        event_id = event.get("id")
        event_type = event.get("event_type")
        if not _is_stable_id(event_id) or str(event_id) in event_ids:
            raise ValueError("collection provenance event ID is invalid or duplicated")
        if event_type not in COLLECTION_EVENT_TYPES:
            raise ValueError("collection provenance event type is invalid")
        created_at = _parse_datetime(
            event.get("created_at"),
            location=f"collection.provenance_events[{index}].created_at",
        )
        exclusion_reason = event.get("exclusion_reason")
        if event_type == "evidence_exclusion":
            if not _is_stable_id(exclusion_reason):
                raise ValueError("collection exclusion event lacks a frozen reason")
        elif exclusion_reason is not None:
            raise ValueError("non-exclusion collection event has an exclusion reason")
        event_ids.add(str(event_id))
        normalized.append(
            {
                "id": str(event_id),
                "event_type": str(event_type),
                "created_at": created_at.isoformat(timespec="milliseconds").replace(
                    "+00:00", "Z"
                ),
                "exclusion_reason": exclusion_reason,
            }
        )
    ordered = sorted(
        normalized,
        key=lambda item: (item["created_at"], item["event_type"], item["id"]),
    )
    terminal = ordered[-1]
    counts = {event_type: 0 for event_type in COLLECTION_EVENT_TYPES}
    for event in ordered:
        counts[event["event_type"]] += 1
    return {
        "collection_event_type_counts": counts,
        "collection_terminal_event_id": terminal["id"],
        "collection_terminal_event_type": terminal["event_type"],
        "collection_terminal_event_at": terminal["created_at"],
        "collection_provenance_chain_sha256": canonical_sha256(ordered),
    }


def map_trusted_collection_record(
    raw: Mapping[str, Any],
    protocol: Mapping[str, Any],
    *,
    expected_activation_manifest_sha256: str | None = None,
    expected_activation_scoring_system_sha256: str | None = None,
    expected_activated_at: str | None = None,
    require_provenance_events: bool = True,
) -> dict[str, str]:
    """Map one authoritative raw collection record into an evaluator role.

    This is the sole upward mapping boundary used by private exporters. Client
    normalized role claims are not inputs and cannot influence the result.
    """

    raw_role = raw.get("source_role")
    mapping_role = {
        "prospective_primary": "primary",
        "prospective_secondary": "secondary",
    }.get(str(raw_role))
    if mapping_role is None:
        raise ValueError("raw collection record is not prospectively admissible")
    frozen = protocol["cohorts"]["trusted_export_mapping"][mapping_role]
    if require_provenance_events:
        events = raw.get("provenance_events")
        if not isinstance(events, list):
            raise ValueError("raw collection mapping requires the complete provenance chain")
        expected_chain = summarize_collection_provenance_events(events)
        if any(raw.get(field) != value for field, value in expected_chain.items()):
            raise ValueError("raw collection provenance-chain summary is invalid")
    counts = raw.get("collection_event_type_counts")
    expected_counts = {
        "enrollment": 1,
        "completion": 1,
        "evidence_exclusion": 0,
        "retrospective_submission": 0,
        "legacy_context": 0,
    }
    if (
        raw.get("event_type") != "completion"
        or raw.get("collection_event_id") != raw.get("collection_terminal_event_id")
        or raw.get("collection_event_at") != raw.get("collection_terminal_event_at")
        or raw.get("collection_terminal_event_type") != "completion"
        or not _is_nonnegative_int_map(
            counts, expected_keys=set(expected_counts)
        )
        or counts != expected_counts
        or raw_role != frozen["collection_source_role"]
        or raw.get("evidence_status") != frozen["collection_evidence_status"]
        or raw.get("cohort_id") != frozen["cohort_id"]
        or raw.get("validation_protocol_id") != protocol["protocol_id"]
        or raw.get("exclusion_reason") is not None
    ):
        raise ValueError("raw collection role/status/cohort cannot be promoted")
    for field in (
        "collection_event_id",
        "collection_terminal_event_id",
    ):
        if not _is_stable_id(raw.get(field)):
            raise ValueError(f"raw collection {field} is invalid")
    event_at = _parse_datetime(raw.get("collection_event_at"), location="collection.event_at")
    terminal_at = _parse_datetime(
        raw.get("collection_terminal_event_at"), location="collection.terminal_event_at"
    )
    if event_at != terminal_at:
        raise ValueError("raw collection terminal event chronology is invalid")
    completion_event_at = _parse_datetime(
        raw.get("completion_event_at"), location="collection.completion_event_at"
    )
    if completion_event_at != event_at:
        raise ValueError("raw collection terminal event does not bind the completion event")
    chain_sha = raw.get("collection_provenance_chain_sha256")
    if not isinstance(chain_sha, str) or SHA256_PATTERN.fullmatch(chain_sha) is None:
        raise ValueError("raw collection provenance-chain SHA-256 is invalid")
    activation_digest = raw.get("activation_manifest_sha256")
    if not isinstance(activation_digest, str) or SHA256_PATTERN.fullmatch(activation_digest) is None:
        raise ValueError("raw collection record lacks sealed activation identity")
    if expected_activation_manifest_sha256 is not None and activation_digest != expected_activation_manifest_sha256:
        raise ValueError("raw collection record belongs to a different activation")
    activated_at = _parse_datetime(raw.get("activated_at"), location="collection.activated_at")
    if activated_at >= _parse_datetime(protocol["enrollment"]["start_at"], location="enrollment.start_at"):
        raise ValueError("raw collection activation was not deployed before enrollment")
    if expected_activated_at is not None and raw.get("activated_at") != expected_activated_at:
        raise ValueError("raw collection activation timestamp differs from the root activation")
    for field, pattern in (
        ("participant_group_id", PARTICIPANT_PATTERN),
        ("assignment_id", ASSIGNMENT_PATTERN),
    ):
        value = raw.get(field)
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            raise ValueError(f"raw collection {field} is invalid")
    for field in (
        "activation_scoring_system_sha256",
        "recruitment_event_sha256",
        "source_record_sha256",
        "completion_event_sha256",
    ):
        value = raw.get(field)
        if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
            raise ValueError(f"raw collection {field} is invalid")
    if (
        expected_activation_scoring_system_sha256 is not None
        and raw.get("activation_scoring_system_sha256")
        != expected_activation_scoring_system_sha256
    ):
        raise ValueError("raw collection scoring deployment differs from root activation")
    for field in ("forecast_impression_id", "effort_segment_id"):
        if not _is_stable_id(raw.get(field)):
            raise ValueError(f"raw collection {field} is invalid")
    selection_method = raw.get("selection_method")
    if mapping_role == "secondary":
        if selection_method != "organic_score_visible":
            raise ValueError("raw secondary collection selection method is invalid")
        selection_design = "prospective-score-visible-self-selected"
    elif selection_method == "score_blind_precommitment":
        selection_design = "prospective-precommitted-without-score"
    elif selection_method == "safe_randomized":
        selection_design = "prospective-safely-randomized"
    else:
        raise ValueError("raw primary collection selection method is invalid")
    return {
        "cohort_role": mapping_role,
        "source_role": (
            "prospective-first-party"
            if mapping_role == "primary"
            else "score-visible-first-party"
        ),
        "selection_design": selection_design,
    }


def load_validation_evidence(
    path: Path,
    protocol: Mapping[str, Any],
    *,
    include_outcomes: bool,
    activated_at: str | None = None,
    activation_manifest_sha256: str | None = None,
    activation: Mapping[str, Any] | None = None,
    _records: Sequence[Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Load the minimized private envelope with strict privacy and semantic checks.

    ``include_outcomes=False`` accepts only the exact label-free envelope used to
    seal assignments. Outcome keys are forbidden in that mode. A distinct,
    fully labeled envelope is accepted only after a label-lock has been written.
    """

    require_private_file(path, artifact="private validation evidence")
    records = list(_records) if _records is not None else _load_json_records(path)
    if not records:
        return []
    activation_time = (
        _parse_datetime(activated_at, location="activated_at") if activated_at is not None else None
    )
    normalized: list[dict[str, Any]] = []
    seen_assignments: set[str] = set()
    seen_sources: set[str] = set()
    seen_participant_events: set[tuple[str, str, str, str]] = set()
    participant_windows: set[tuple[str, str, datetime, datetime]] = set()
    participant_intervals: dict[tuple[str, str], list[tuple[datetime, datetime]]] = {}
    participant_recruitment: dict[str, tuple[Any, ...]] = {}
    allowed_primary_designs = set(protocol["cohorts"]["primary"]["allowed_selection_designs"])
    for index, raw in enumerate(records):
        location = f"evidence[{index}]"
        _reject_forbidden_fields(raw, location=location)
        expected_fields = (
            LABELED_EVIDENCE_TOP_LEVEL_FIELDS
            if include_outcomes
            else LABEL_FREE_EVIDENCE_TOP_LEVEL_FIELDS
        )
        _require_exact_keys(raw, expected_fields, location=location)
        if raw.get("schema_version") != EVIDENCE_SCHEMA_VERSION:
            raise ValueError(f"{location}.schema_version is unsupported")
        if raw.get("protocol_id") != protocol["protocol_id"] or raw.get("protocol_version") != protocol["protocol_version"]:
            raise ValueError(f"{location} does not bind the frozen validation protocol")
        assignment_id = raw.get("assignment_id")
        source_record_sha256 = raw.get("source_record_sha256")
        participant = raw.get("participant_group_id")
        if not isinstance(assignment_id, str) or ASSIGNMENT_PATTERN.fullmatch(assignment_id) is None:
            raise ValueError(f"{location}.assignment_id must be an opaque assignment SHA-256")
        if not isinstance(source_record_sha256, str) or SHA256_PATTERN.fullmatch(source_record_sha256) is None:
            raise ValueError(f"{location}.source_record_sha256 is invalid")
        if participant is not None and (
            not isinstance(participant, str) or PARTICIPANT_PATTERN.fullmatch(participant) is None
        ):
            raise ValueError(f"{location}.participant_group_id is not a privacy-safe derived token")
        if assignment_id in seen_assignments or source_record_sha256 in seen_sources:
            raise ValueError("validation evidence contains duplicate assignment or source lineage")
        seen_assignments.add(assignment_id)
        seen_sources.add(source_record_sha256)

        evidence = raw.get("evidence")
        if not isinstance(evidence, dict):
            raise ValueError(f"{location}.evidence must be an object")
        _require_exact_keys(evidence, EVIDENCE_OBJECT_FIELDS, location=f"{location}.evidence")
        lineage = raw.get("deletion_lineage")
        if not isinstance(lineage, dict):
            raise ValueError(f"{location}.deletion_lineage must be an object")
        _require_exact_keys(lineage, DELETION_LINEAGE_FIELDS, location=f"{location}.deletion_lineage")
        if not isinstance(lineage.get("lineage_sha256"), str) or SHA256_PATTERN.fullmatch(lineage["lineage_sha256"]) is None:
            raise ValueError(f"{location}.deletion_lineage.lineage_sha256 is invalid")
        _parse_datetime(lineage.get("reconciled_at"), location=f"{location}.deletion_lineage.reconciled_at")
        if lineage.get("status") != evidence.get("deletion_status"):
            raise ValueError(f"{location} deletion lineage disagrees with evidence status")

        if raw.get("selection_design") != evidence.get("selection_design"):
            raise ValueError(f"{location} selection design fields disagree")
        cohort_role = raw.get("cohort_role")
        source_role = raw.get("source_role")
        selection_design = raw.get("selection_design")
        primary_declared = cohort_role == "primary"
        if cohort_role not in {"primary", "secondary", "exploratory", "quarantined"}:
            raise ValueError(f"{location}.cohort_role is invalid")
        if source_role not in {
            "prospective-first-party",
            "score-visible-first-party",
            "retrospective-first-party",
            "official-context",
        }:
            raise ValueError(f"{location}.source_role is invalid")
        if selection_design not in {
            "prospective-precommitted-without-score",
            "prospective-safely-randomized",
            "prospective-score-visible-self-selected",
            "retrospective-or-context",
        }:
            raise ValueError(f"{location}.selection_design is invalid")
        prospective_assignment_issued = evidence.get(
            "prospective_assignment_issued"
        )
        if not isinstance(prospective_assignment_issued, bool):
            raise ValueError(
                f"{location}.evidence.prospective_assignment_issued must be boolean"
            )
        prospectively_observed = prospective_assignment_issued
        intended_cohort_role = evidence.get("intended_cohort_role")
        intended_source_role = evidence.get("intended_source_role")
        intended_cohort_id = evidence.get("intended_cohort_id")
        intended_selection_method = evidence.get("intended_selection_method")
        intended_selection_design_by_method = {
            "score_blind_precommitment": "prospective-precommitted-without-score",
            "safe_randomized": "prospective-safely-randomized",
            "organic_score_visible": "prospective-score-visible-self-selected",
        }
        if prospectively_observed:
            if participant is None:
                raise ValueError(
                    f"{location} issued prospective assignment lacks participant grouping"
                )
            if intended_cohort_role not in {"primary", "secondary"}:
                raise ValueError(
                    f"{location} issued prospective assignment lacks an intended cohort"
                )
            expected_intended_source_role = (
                "prospective-first-party"
                if intended_cohort_role == "primary"
                else "score-visible-first-party"
            )
            expected_intended_cohort_id = protocol["cohorts"][
                str(intended_cohort_role)
            ]["cohort_id"]
            allowed_intended_methods = (
                {"score_blind_precommitment", "safe_randomized"}
                if intended_cohort_role == "primary"
                else {"organic_score_visible"}
            )
            if (
                intended_source_role != expected_intended_source_role
                or intended_cohort_id != expected_intended_cohort_id
                or intended_selection_method not in allowed_intended_methods
                or selection_design
                != intended_selection_design_by_method.get(intended_selection_method)
                or source_role != intended_source_role
                or evidence.get("cohort_id") != intended_cohort_id
                or (
                    intended_cohort_role == "primary"
                    and evidence.get("score_influenced_choice") is not False
                )
                or (
                    intended_cohort_role == "secondary"
                    and not isinstance(evidence.get("score_influenced_choice"), bool)
                )
            ):
                raise ValueError(
                    f"{location} issued assignment intent tuple is inconsistent"
                )
            if (
                cohort_role != intended_cohort_role
                or source_role != intended_source_role
                or raw.get("evidence_status") != "admitted"
            ):
                raise ValueError(
                    f"{location} issued assignment must final-admit exactly its signed intent"
                )
        else:
            if any(
                value is not None
                for value in (
                    intended_cohort_role,
                    intended_source_role,
                    intended_cohort_id,
                    intended_selection_method,
                    raw.get("impression_attestation"),
                    raw.get("score_exposure_attestation"),
                    evidence.get("impression_attestation_sha256"),
                    evidence.get("score_exposure_attestation_sha256"),
                )
            ):
                raise ValueError(
                    f"{location} non-issued evidence contains prospective assignment state"
                )
            if cohort_role in {"primary", "secondary"}:
                raise ValueError(
                    f"{location} cannot enter a prospective cohort without an issued assignment"
                )
            if (
                source_role not in {"retrospective-first-party", "official-context"}
                or selection_design != "retrospective-or-context"
                or any(
                    evidence.get(field) is not None
                    for field in (
                        "recruitment_frame_id",
                        "recruitment_source_id",
                        "recruitment_event_contract_version",
                        "recruitment_event_at",
                        "recruitment_event_sha256",
                        "community_approval_sha256",
                        "activation_manifest_sha256",
                        "cohort_id",
                        "forecast_impression_id",
                        "impression_or_assignment_at",
                        "study_consent_version",
                        "study_consent_at",
                        "target_intent_confirmed_at",
                        "precommitment_event_sha256",
                        "feasible_set_sha256",
                        "feasible_option_count",
                        "assignment_probability_numerator",
                        "assignment_probability_denominator",
                        "randomization_draw_index",
                        "randomization_audit_sha256",
                        "score_first_exposed_at",
                        "completion_event_contract_version",
                        "completion_event_at",
                        "completion_consent_version",
                        "completion_consented_at",
                        "completion_primary_target_confirmed",
                        "completion_complete_attempt_confirmed",
                        "completion_event_sha256",
                    )
                )
                or evidence.get("score_exposure_disposition") != "not-applicable"
            ):
                raise ValueError(
                    f"{location} non-issued evidence must remain retrospective/context-only"
                )
            context_mapping = protocol["cohorts"]["trusted_export_mapping"][
                str(cohort_role)
            ]
            context_event_type = evidence.get("collection_event_type")
            context_counts = evidence.get("collection_event_type_counts")
            expected_context_counts = {
                event_type: int(event_type == context_event_type)
                for event_type in COLLECTION_EVENT_TYPES
            }
            if (
                evidence.get("collection_source_role")
                != context_mapping["collection_source_role"]
                or evidence.get("collection_evidence_status")
                != context_mapping["collection_evidence_status"]
                or evidence.get("collection_cohort_id")
                != context_mapping["cohort_id"]
                or evidence.get("collection_selection_method")
                != "organic_unverified"
                or evidence.get("collection_validation_protocol_id")
                != protocol["protocol_id"]
                or evidence.get("collection_activated_at") is not None
                or evidence.get("collection_activation_scoring_system_sha256")
                is not None
                or context_event_type
                not in {
                    "retrospective_submission",
                    "legacy_context",
                    "evidence_exclusion",
                }
                or not _is_nonnegative_int_map(
                    context_counts, expected_keys=set(expected_context_counts)
                )
                or context_counts != expected_context_counts
                or evidence.get("collection_terminal_event_type")
                != context_event_type
                or evidence.get("collection_terminal_event_id")
                != evidence.get("collection_event_id")
                or evidence.get("collection_terminal_event_at")
                != evidence.get("collection_event_at")
                or (
                    cohort_role == "exploratory"
                    and evidence.get("collection_exclusion_reason") is not None
                )
                or (
                    cohort_role == "quarantined"
                    and not _is_stable_id(
                        evidence.get("collection_exclusion_reason")
                    )
                )
            ):
                raise ValueError(
                    f"{location} non-issued collection provenance is not context-only"
                )
        if not isinstance(raw.get("server_attested"), bool):
            raise ValueError(f"{location}.server_attested must be boolean")
        if raw.get("evidence_status") not in {"admitted", "quarantined", "rejected"}:
            raise ValueError(f"{location}.evidence_status is invalid")
        if cohort_role == "quarantined" and raw.get("evidence_status") == "admitted":
            raise ValueError(f"{location} quarantined evidence cannot claim admitted status")
        if evidence.get("observation_contract_status") not in {
            "valid",
            "legacy_unverified",
            "rejected",
        }:
            raise ValueError(f"{location}.evidence.observation_contract_status is invalid")
        if evidence.get("observation_contract_version") not in {
            OBSERVATION_CONTRACT_VERSION,
            None,
        } or evidence.get("taxon_catalog_version") not in {TAXON_CATALOG_VERSION, None}:
            raise ValueError(f"{location} observation contract identity is invalid")
        if evidence.get("target_taxon_id") != PRODUCTION_TARGET_TAXON_ID:
            raise ValueError(f"{location} target taxon is outside the frozen protocol")
        if not isinstance(evidence.get("complete_attempt"), bool) or not isinstance(
            evidence.get("expanded_estimate"), bool
        ):
            raise ValueError(f"{location} attempt flags must be boolean")
        if evidence.get("mode") not in set(protocol["eligibility"]["supported_modes"]):
            raise ValueError(f"{location}.evidence.mode is unsupported")
        if evidence.get("opportunity_window_id") is not None and not _is_stable_id(
            evidence.get("opportunity_window_id")
        ):
            raise ValueError(f"{location}.evidence.opportunity_window_id is invalid")
        if evidence.get("opportunity_contract_version") not in {
            OPPORTUNITY_CONTRACT_VERSION,
            None,
        }:
            raise ValueError(f"{location}.evidence.opportunity_contract_version is invalid")
        if evidence.get("scoring_system_kind") not in {
            "heuristic-configuration",
            "trained-model",
            None,
        }:
            raise ValueError(f"{location}.evidence.scoring_system_kind is invalid")
        for field in (
            "scoring_system_version",
            "study_consent_version",
            "completion_consent_version",
            "completion_event_contract_version",
            "cohort_id",
            "collection_source_role",
            "collection_evidence_status",
            "collection_cohort_id",
            "collection_selection_method",
            "collection_validation_protocol_id",
            "incentive_policy_id",
            "effort_segment_id",
            "effort_unit",
            "recruitment_event_contract_version",
            "forecast_impression_id",
        ):
            if evidence.get(field) is not None and not _is_stable_id(evidence.get(field)):
                raise ValueError(f"{location}.evidence.{field} is invalid")
        for field in (
            "scoring_system_sha256",
            "snapshot_sha256",
            "precommitment_event_sha256",
            "feasible_set_sha256",
            "randomization_audit_sha256",
            "recruitment_event_sha256",
            "community_approval_sha256",
            "activation_manifest_sha256",
            "completion_event_sha256",
            "impression_attestation_sha256",
            "collection_activation_scoring_system_sha256",
        ):
            value = evidence.get(field)
            if value is not None and (
                not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None
            ):
                raise ValueError(f"{location}.evidence.{field} is invalid")
        if evidence.get("site_catalog_sha256") != protocol["geography"]["site_catalog_sha256"]:
            raise ValueError(f"{location} site catalog identity changed")
        if prospectively_observed:
            if evidence.get("activation_manifest_sha256") is None:
                raise ValueError(f"{location} prospective evidence lacks activation binding")
            if not _is_stable_id(evidence.get("forecast_impression_id")):
                raise ValueError(f"{location} prospective evidence lacks immutable forecast impression ID")
            if (
                activation_manifest_sha256 is not None
                and evidence.get("activation_manifest_sha256") != activation_manifest_sha256
            ):
                raise ValueError(f"{location} was not collected under the supplied root activation")
            if evidence.get("cohort_id") != intended_cohort_id:
                raise ValueError(f"{location} cohort identity changed")
            if evidence.get("incentive_policy_id") != protocol["cohorts"]["incentives"]["policy"]:
                raise ValueError(f"{location} incentive policy differs from the frozen no-incentive policy")
        if prospectively_observed:
            mapped = map_trusted_collection_record(
                {
                    "source_role": evidence.get("collection_source_role"),
                    "event_type": evidence.get("collection_event_type"),
                    "collection_event_id": evidence.get("collection_event_id"),
                    "collection_event_at": evidence.get("collection_event_at"),
                    "collection_event_type_counts": evidence.get(
                        "collection_event_type_counts"
                    ),
                    "collection_terminal_event_id": evidence.get(
                        "collection_terminal_event_id"
                    ),
                    "collection_terminal_event_type": evidence.get(
                        "collection_terminal_event_type"
                    ),
                    "collection_terminal_event_at": evidence.get(
                        "collection_terminal_event_at"
                    ),
                    "collection_provenance_chain_sha256": evidence.get(
                        "collection_provenance_chain_sha256"
                    ),
                    "evidence_status": evidence.get("collection_evidence_status"),
                    "cohort_id": evidence.get("collection_cohort_id"),
                    "selection_method": evidence.get("collection_selection_method"),
                    "validation_protocol_id": evidence.get(
                        "collection_validation_protocol_id"
                    ),
                    "activation_manifest_sha256": evidence.get(
                        "activation_manifest_sha256"
                    ),
                    "activated_at": evidence.get("collection_activated_at"),
                    "activation_scoring_system_sha256": evidence.get(
                        "collection_activation_scoring_system_sha256"
                    ),
                    "exclusion_reason": evidence.get("collection_exclusion_reason"),
                    "participant_group_id": participant,
                    "recruitment_event_sha256": evidence.get(
                        "recruitment_event_sha256"
                    ),
                    "forecast_impression_id": evidence.get("forecast_impression_id"),
                    "assignment_id": assignment_id,
                    "source_record_sha256": source_record_sha256,
                    "effort_segment_id": evidence.get("effort_segment_id"),
                    "completion_event_sha256": evidence.get("completion_event_sha256"),
                    "completion_event_at": evidence.get("completion_event_at"),
                },
                protocol,
                expected_activation_manifest_sha256=activation_manifest_sha256,
                expected_activation_scoring_system_sha256=evidence.get(
                    "scoring_system_sha256"
                ),
                expected_activated_at=activated_at,
                require_provenance_events=False,
            )
            declared_mapping = {
                "cohort_role": intended_cohort_role,
                "source_role": intended_source_role,
                "selection_design": selection_design,
            }
            if mapped != declared_mapping:
                raise ValueError(
                    f"{location} raw collection fields cannot map to the declared evaluator cohort"
                )
        if evidence.get("score_influenced_choice") is not None and not isinstance(
            evidence.get("score_influenced_choice"), bool
        ):
            raise ValueError(f"{location}.evidence.score_influenced_choice is invalid")
        if evidence.get("deletion_status") not in {"active", "withdrawn", "deleted"}:
            raise ValueError(f"{location}.evidence.deletion_status is invalid")
        if evidence.get("exact_coordinates_collected") is not False:
            raise ValueError(f"{location} cannot contain exact coordinates")
        if lineage.get("status") not in {"active", "withdrawn", "deleted"}:
            raise ValueError(f"{location}.deletion_lineage.status is invalid")
        site_id = raw.get("site_id")
        if not isinstance(site_id, str):
            raise ValueError(f"{location}.site_id is invalid")
        panel = protocol_site_panel(protocol, site_id)
        segment_start = _parse_datetime(evidence.get("segment_start_at"), location=f"{location}.evidence.segment_start_at")
        segment_end = _parse_datetime(evidence.get("segment_end_at"), location=f"{location}.evidence.segment_end_at")
        if segment_start.microsecond % 1000 or segment_end.microsecond % 1000:
            raise ValueError(f"{location} segment timestamps must be millisecond-aligned")
        if segment_end <= segment_start:
            raise ValueError(f"{location} segment end must be after start")
        temporal_block = protocol_temporal_block(protocol, segment_start, segment_end)
        raw_window_start = evidence.get("window_start_at")
        raw_window_end = evidence.get("window_end_at")
        if prospectively_observed and (raw_window_start is None or raw_window_end is None):
            raise ValueError(f"{location} prospective evidence requires an authoritative window")
        if (raw_window_start is None) != (raw_window_end is None):
            raise ValueError(f"{location} authoritative window bounds must be both present or both absent")
        if raw_window_start is not None:
            window_start = _parse_datetime(
                raw_window_start, location=f"{location}.evidence.window_start_at"
            )
            window_end = _parse_datetime(
                raw_window_end, location=f"{location}.evidence.window_end_at"
            )
            expected_window_duration = timedelta(
                minutes=int(
                    protocol["eligibility"]["authoritative_window_duration_minutes"]
                )
            )
            if (
                window_start.microsecond % 1000
                or window_end.microsecond % 1000
                or window_end - window_start != expected_window_duration
            ):
                raise ValueError(
                    f"{location} authoritative opportunity window must be exactly two hours"
                )
            if segment_start < window_start or segment_end > window_end:
                raise ValueError(
                    f"{location} effort segment must be wholly contained in one authoritative window"
                )
        if prospectively_observed:
            effort_segment_id = evidence.get("effort_segment_id")
            if not _is_stable_id(effort_segment_id):
                raise ValueError(f"{location} prospective effort segment ID is invalid")
            if evidence.get("effort_unit") != protocol["eligibility"]["effort_unit"]:
                raise ValueError(f"{location} effort unit is not one whole-trip group attempt")
            if type(evidence.get("attempt_count")) is not int or evidence.get(
                "attempt_count"
            ) != 1:
                raise ValueError(f"{location} attempt_count must be exactly one")
            angler_count = evidence.get("angler_count")
            if isinstance(angler_count, bool) or not isinstance(angler_count, int) or not (1 <= angler_count <= 12):
                raise ValueError(f"{location} angler count is invalid")
            duration_milliseconds = evidence.get("duration_milliseconds")
            person_milliseconds = evidence.get("person_milliseconds")
            duration_delta = segment_end - segment_start
            actual_duration_milliseconds = (
                duration_delta.days * 86_400_000
                + duration_delta.seconds * 1000
                + duration_delta.microseconds // 1000
            )
            if (
                isinstance(duration_milliseconds, bool)
                or not isinstance(duration_milliseconds, int)
                or duration_milliseconds <= 0
                or duration_milliseconds != actual_duration_milliseconds
                or isinstance(person_milliseconds, bool)
                or not isinstance(person_milliseconds, int)
                or person_milliseconds != duration_milliseconds * angler_count
            ):
                raise ValueError(f"{location} integer duration/person effort proof is invalid")
            completion_at = _parse_datetime(
                evidence.get("completion_event_at"),
                location=f"{location}.evidence.completion_event_at",
            )
            completion_consented_at = _parse_datetime(
                evidence.get("completion_consented_at"),
                location=f"{location}.evidence.completion_consented_at",
            )
            if completion_at.microsecond % 1000 or completion_consented_at.microsecond % 1000:
                raise ValueError(f"{location} completion timestamps must be millisecond-aligned")
            if (
                evidence.get("completion_event_contract_version")
                != protocol["eligibility"]["completion_event_contract_version"]
                or evidence.get("completion_consent_version")
                != protocol["eligibility"]["accepted_study_consent_version"]
                or evidence.get("completion_primary_target_confirmed") is not True
                or evidence.get("completion_complete_attempt_confirmed") is not True
                or completion_at < segment_end
                or completion_consented_at != completion_at
                or (activation_time is not None and completion_at <= activation_time)
                or completion_at
                >= _parse_datetime(
                    protocol["enrollment"]["end_at"], location="enrollment.end_at"
                )
            ):
                raise ValueError(f"{location} immutable completion consent/intent proof is invalid")
            completion_payload = {
                "activation_manifest_sha256": evidence.get("activation_manifest_sha256"),
                "assignment_id": assignment_id,
                "source_record_sha256": source_record_sha256,
                "participant_group_id": participant,
                "cohort_id": evidence.get("cohort_id"),
                "incentive_policy_id": evidence.get("incentive_policy_id"),
                "effort_segment_id": effort_segment_id,
                "completion_event_contract_version": evidence.get("completion_event_contract_version"),
                "completion_event_at": evidence.get("completion_event_at"),
                "completion_consent_version": evidence.get("completion_consent_version"),
                "completion_consented_at": evidence.get("completion_consented_at"),
                "completion_primary_target_confirmed": evidence.get("completion_primary_target_confirmed"),
                "completion_complete_attempt_confirmed": evidence.get("completion_complete_attempt_confirmed"),
                "target_taxon_id": evidence.get("target_taxon_id"),
                "segment_start_at": evidence.get("segment_start_at"),
                "segment_end_at": evidence.get("segment_end_at"),
                "mode": evidence.get("mode"),
                "effort_unit": evidence.get("effort_unit"),
                "attempt_count": evidence.get("attempt_count"),
                "duration_milliseconds": duration_milliseconds,
                "angler_count": angler_count,
                "person_milliseconds": person_milliseconds,
            }
            if evidence.get("completion_event_sha256") != canonical_sha256(completion_payload):
                raise ValueError(f"{location} completion event SHA-256 is invalid")

            participant_window = (
                str(participant),
                site_id,
                window_start,
                window_end,
            )
            if participant_window in participant_windows:
                raise ValueError("validation evidence duplicates a participant opportunity window")
            participant_windows.add(participant_window)
            prior_intervals = participant_intervals.setdefault((str(participant), "all"), [])
            if any(segment_start < prior_end and prior_start < segment_end for prior_start, prior_end in prior_intervals):
                raise ValueError("validation evidence contains overlapping participant effort segments")
            prior_intervals.append((segment_start, segment_end))
        pre_outcome_times: dict[str, datetime] = {}
        for field in ("impression_or_assignment_at", "study_consent_at", "target_intent_confirmed_at"):
            stamp = evidence.get(field)
            if stamp is None and prospectively_observed:
                raise ValueError(f"{location}.evidence.{field} is required")
            if stamp is not None:
                parsed_stamp = _parse_datetime(
                    stamp, location=f"{location}.evidence.{field}"
                )
                if prospectively_observed and parsed_stamp.microsecond % 1000:
                    raise ValueError(f"{location}.evidence.{field} must be millisecond-aligned")
                pre_outcome_times[field] = parsed_stamp
                if parsed_stamp > segment_start:
                    raise ValueError(
                        f"{location}.evidence.{field} must be immutable pre-outcome context"
                    )
        if prospectively_observed:
            assignment_time = pre_outcome_times["impression_or_assignment_at"]
            if assignment_time >= segment_start:
                raise ValueError(
                    f"{location} prospective assignment must precede effort start"
                )
            if pre_outcome_times["study_consent_at"] > assignment_time:
                raise ValueError(f"{location} study consent must precede assignment")
            if pre_outcome_times["target_intent_confirmed_at"] > assignment_time:
                raise ValueError(f"{location} target intent must precede assignment")
            if evidence.get("study_consent_version") != protocol["eligibility"]["accepted_study_consent_version"]:
                raise ValueError(f"{location} study consent version is not frozen")
            if activation_time is not None and any(
                pre_outcome_times[field] <= activation_time
                for field in ("study_consent_at", "target_intent_confirmed_at", "impression_or_assignment_at")
            ):
                raise ValueError(f"{location} protocol consent, intent, and assignment must follow activation")
        recruitment_frame = evidence.get("recruitment_frame_id")
        recruitment_source = evidence.get("recruitment_source_id")
        recruitment_at_raw = evidence.get("recruitment_event_at")
        recruitment_digest = evidence.get("recruitment_event_sha256")
        community_approval = evidence.get("community_approval_sha256")
        if prospectively_observed and recruitment_source is None:
            raise ValueError(f"{location} prospective evidence requires frozen recruitment provenance")
        if recruitment_source is not None:
            if participant is None:
                raise ValueError(f"{location} recruited evidence requires participant grouping")
            if recruitment_frame != protocol["recruitment"]["frame_id"]:
                raise ValueError(f"{location} recruitment frame changed")
            if evidence.get("recruitment_event_contract_version") != protocol["recruitment"]["event_contract_version"]:
                raise ValueError(f"{location} recruitment event contract changed")
            if recruitment_source not in set(protocol["recruitment"]["allowed_source_ids"]):
                raise ValueError(f"{location} recruitment source is not frozen")
            recruitment_at = _parse_datetime(
                recruitment_at_raw, location=f"{location}.evidence.recruitment_event_at"
            )
            if recruitment_at.microsecond % 1000:
                raise ValueError(f"{location} recruitment timestamp must be millisecond-aligned")
            if recruitment_at > pre_outcome_times.get("impression_or_assignment_at", segment_start):
                raise ValueError(f"{location} recruitment must precede assignment")
            if activation_time is not None and prospectively_observed and recruitment_at <= activation_time:
                raise ValueError(f"{location} prospective recruitment predates activation")
            if recruitment_source == "admin-approved-community-prospective":
                if not isinstance(community_approval, str) or SHA256_PATTERN.fullmatch(community_approval) is None:
                    raise ValueError(f"{location} community recruitment lacks approval lineage")
            elif community_approval is not None:
                raise ValueError(f"{location} non-community recruitment has community approval lineage")
            expected_recruitment_digest = canonical_sha256(
                {
                    "participant_group_id": participant,
                    "recruitment_frame_id": recruitment_frame,
                    "recruitment_source_id": recruitment_source,
                    "recruitment_event_at": recruitment_at_raw,
                    "community_approval_sha256": community_approval,
                }
            )
            if recruitment_digest != expected_recruitment_digest:
                raise ValueError(f"{location} recruitment event SHA-256 is invalid")
            recruitment_identity = (
                recruitment_frame,
                recruitment_source,
                recruitment_at_raw,
                recruitment_digest,
                community_approval,
            )
            previous_recruitment = participant_recruitment.get(str(participant))
            if previous_recruitment is not None and previous_recruitment != recruitment_identity:
                raise ValueError(f"{location} participant recruitment source changed")
            participant_recruitment[str(participant)] = recruitment_identity
        elif any(
            value is not None
            for value in (
                recruitment_frame,
                recruitment_at_raw,
                recruitment_digest,
                community_approval,
            )
        ):
            raise ValueError(f"{location} partial recruitment provenance is invalid")
        score_exposed_raw = evidence.get("score_first_exposed_at")
        score_exposed_at: datetime | None = None
        if score_exposed_raw is not None:
            score_exposed_at = _parse_datetime(
                score_exposed_raw, location=f"{location}.evidence.score_first_exposed_at"
            )
            if score_exposed_at.microsecond % 1000:
                raise ValueError(f"{location} score-exposure timestamp must be millisecond-aligned")
        primary_intended = intended_cohort_role == "primary"
        secondary_intended = intended_cohort_role == "secondary"
        if primary_intended and score_exposed_at is not None and score_exposed_at <= pre_outcome_times["impression_or_assignment_at"]:
            raise ValueError(f"{location} primary score exposure did not follow durable assignment")
        if primary_intended and score_exposed_at is not None and score_exposed_at >= segment_start:
            raise ValueError(f"{location} primary score exposure postdates effort start")
        if secondary_intended and (
            score_exposed_at is None
            or score_exposed_at >= pre_outcome_times["impression_or_assignment_at"]
        ):
            raise ValueError(f"{location} secondary selection must follow score exposure")
        expected_exposure_disposition = (
            "already-exposed-before-assignment"
            if secondary_intended
            else (
                "exposed-after-assignment-before-segment"
                if primary_intended and score_exposed_at is not None
                else (
                    "never-exposed-through-completion"
                    if primary_intended
                    else "not-applicable"
                )
            )
        )
        if evidence.get("score_exposure_disposition") != expected_exposure_disposition:
            raise ValueError(f"{location} score-exposure disposition is inconsistent")

        precommit_hash = evidence.get("precommitment_event_sha256")
        feasible_hash = evidence.get("feasible_set_sha256")
        feasible_count = evidence.get("feasible_option_count")
        probability_numerator = evidence.get("assignment_probability_numerator")
        probability_denominator = evidence.get("assignment_probability_denominator")
        draw_index = evidence.get("randomization_draw_index")
        audit_hash = evidence.get("randomization_audit_sha256")
        if selection_design == "prospective-precommitted-without-score":
            if not isinstance(precommit_hash, str) or SHA256_PATTERN.fullmatch(precommit_hash) is None:
                raise ValueError(f"{location} score-blind precommitment lacks its durable event hash")
            if any(
                value is not None
                for value in (
                    feasible_hash,
                    feasible_count,
                    probability_numerator,
                    probability_denominator,
                    draw_index,
                    audit_hash,
                )
            ):
                raise ValueError(f"{location} precommitment cannot contain randomization audit fields")
        elif selection_design == "prospective-safely-randomized":
            if precommit_hash is not None:
                raise ValueError(f"{location} randomized assignment cannot contain a precommit hash")
            if not isinstance(feasible_hash, str) or SHA256_PATTERN.fullmatch(feasible_hash) is None:
                raise ValueError(f"{location} randomized assignment lacks a feasible-set hash")
            if isinstance(feasible_count, bool) or not isinstance(feasible_count, int) or feasible_count < 2:
                raise ValueError(f"{location} randomized assignment needs at least two feasible options")
            if (
                type(probability_numerator) is not int
                or type(probability_denominator) is not int
                or probability_numerator != 1
                or probability_denominator != feasible_count
            ):
                raise ValueError(f"{location} randomized assignment probability is not uniform")
            if isinstance(draw_index, bool) or not isinstance(draw_index, int) or not (0 <= draw_index < feasible_count):
                raise ValueError(f"{location} randomization draw index is invalid")
            if not isinstance(audit_hash, str) or SHA256_PATTERN.fullmatch(audit_hash) is None:
                raise ValueError(f"{location} randomized assignment lacks its durable audit hash")
        elif any(
            value is not None
            for value in (
                precommit_hash,
                feasible_hash,
                feasible_count,
                probability_numerator,
                probability_denominator,
                draw_index,
                audit_hash,
            )
        ):
            raise ValueError(f"{location} non-primary selection has primary-design audit fields")
        if (
            activation_time is not None
            and segment_start <= activation_time
            and prospectively_observed
        ):
            raise ValueError(
                f"{location} is preactivation and must remain exploratory"
            )

        event_key = (
            str(participant),
            site_id,
            str(evidence["segment_start_at"]),
            str(evidence["segment_end_at"]),
        )
        if participant is not None and event_key in seen_participant_events:
            raise ValueError("validation evidence duplicates a participant event")
        seen_participant_events.add(event_key)

        prospective_requirements = {
            "privacy-safe participant group": participant is not None,
            "valid v2 observation": evidence.get("observation_contract_status") == "valid"
            and evidence.get("observation_contract_version") == OBSERVATION_CONTRACT_VERSION
            and evidence.get("taxon_catalog_version") == TAXON_CATALOG_VERSION,
            "California-halibut target": evidence.get("target_taxon_id") == PRODUCTION_TARGET_TAXON_ID,
            "complete non-expanded attempt": evidence.get("complete_attempt") is True
            and evidence.get("expanded_estimate") is False,
            "supported fishing mode": evidence.get("mode") in protocol["eligibility"]["supported_modes"],
            "authoritative server attestation": raw.get("server_attested") is True,
            "admitted evidence status": raw.get("evidence_status") == "admitted",
            "active deletion lineage": evidence.get("deletion_status") == "active",
            "no exact coordinates": evidence.get("exact_coordinates_collected") is False,
            "opportunity contract": evidence.get("opportunity_contract_version") == OPPORTUNITY_CONTRACT_VERSION,
            "heuristic scoring kind": evidence.get("scoring_system_kind") == protocol["candidate"]["kind"],
            "frozen site catalog": evidence.get("site_catalog_sha256") == protocol["geography"]["site_catalog_sha256"],
        }
        identity_fields = (
            "opportunity_window_id",
            "scoring_system_version",
            "scoring_system_sha256",
            "snapshot_sha256",
            "study_consent_version",
        )
        prospective_requirements["complete authoritative identity"] = all(
            isinstance(evidence.get(field), str) and bool(evidence.get(field))
            for field in identity_fields
        ) and all(
            SHA256_PATTERN.fullmatch(str(evidence.get(field))) is not None
            for field in ("scoring_system_sha256", "snapshot_sha256")
        )
        if evidence.get("scoring_system_kind") == "heuristic-configuration" and isinstance(evidence.get("scoring_system_sha256"), str):
            prospective_requirements["coherent heuristic identity"] = evidence.get("scoring_system_version") == (
                f"heuristic-{PRODUCTION_TARGET_TAXON_ID}-{evidence['scoring_system_sha256']}"
            )
        else:
            prospective_requirements["coherent heuristic identity"] = False
        if primary_declared:
            primary_requirements = {
                **prospective_requirements,
                "prospective source": source_role == "prospective-first-party",
                "allowed precommitted/randomized selection": selection_design in allowed_primary_designs,
                "score not used for selection": evidence.get("score_influenced_choice") is False,
                "solo angler primary unit": evidence.get("angler_count")
                == int(protocol["eligibility"]["primary_angler_count"]),
            }
            failed = [name for name, passed in primary_requirements.items() if not passed]
            if failed:
                raise ValueError(f"{location} cannot enter the primary cohort: {', '.join(failed)}")

        if cohort_role == "secondary":
            secondary_requirements = {
                **prospective_requirements,
                "score-visible source": source_role == "score-visible-first-party",
                "score-visible selection": selection_design
                in set(protocol["cohorts"]["secondary"]["allowed_selection_designs"]),
                "score influence answered": isinstance(
                    evidence.get("score_influenced_choice"), bool
                ),
            }
            failed = [name for name, passed in secondary_requirements.items() if not passed]
            if failed:
                raise ValueError(
                    f"{location} cannot enter the secondary cohort: {', '.join(failed)}"
                )
        elif cohort_role in {"exploratory", "quarantined"}:
            if selection_design not in {
                "retrospective-or-context",
                "prospective-score-visible-self-selected",
                *allowed_primary_designs,
            }:
                raise ValueError(f"{location} has an unsupported exploratory selection design")
        elif not primary_declared:
            raise ValueError(f"{location}.cohort_role is invalid")

        score = raw.get("opportunity_score")
        if isinstance(score, bool) or not isinstance(score, int) or not (0 <= score <= 100):
            raise ValueError(f"{location}.opportunity_score must be an integer ordinal score from 0 to 100")
        person_milliseconds_value = evidence.get("person_milliseconds")
        derived_angler_hours = (
            person_milliseconds_value / 3_600_000.0
            if isinstance(person_milliseconds_value, int)
            and not isinstance(person_milliseconds_value, bool)
            and person_milliseconds_value > 0
            else (segment_end - segment_start).total_seconds() / 3600.0
        )

        item: dict[str, Any] = {
            "assignment_id": assignment_id,
            "source_record_sha256": source_record_sha256,
            "participant_group_id": participant,
            "cohort_role": cohort_role,
            "source_role": source_role,
            "selection_design": selection_design,
            "site_id": site_id,
            "geographic_panel": panel,
            "temporal_block": temporal_block,
            "angler_hours": float(derived_angler_hours),
            "opportunity_score": score,
            "impression_attestation": deepcopy(raw.get("impression_attestation")),
            "score_exposure_attestation": deepcopy(
                raw.get("score_exposure_attestation")
            ),
            "server_attested": bool(raw.get("server_attested")),
            "evidence_status": raw.get("evidence_status"),
            "deletion_lineage": deepcopy(lineage),
            "evidence": deepcopy(evidence),
        }
        if prospectively_observed:
            if activation is None:
                raise ValueError(
                    "prospective evidence admission requires the root activation signing key"
                )
            validate_impression_attestation(item, activation=activation)
            validate_score_exposure_attestation(item, activation=activation)
        if include_outcomes:
            outcome = raw.get("outcome_class")
            target_count = raw.get("target_encounter_count")
            if outcome not in {"target_encountered", "non_target_only", "no_fish"}:
                raise ValueError(f"{location}.outcome_class is invalid")
            if isinstance(target_count, bool) or not isinstance(target_count, int) or target_count < 0:
                raise ValueError(f"{location}.target_encounter_count must be a nonnegative integer")
            if (target_count > 0) != (outcome == "target_encountered"):
                raise ValueError(f"{location} target count and outcome disagree")
            item["outcome_class"] = outcome
            item["target_encounter_count"] = target_count
            item["target_encountered"] = int(target_count > 0)
        normalized.append(item)
    return normalized


def _candidate_prediction_projection(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the exact per-assignment candidate prediction that is frozen."""

    if item["evidence"]["prospective_assignment_issued"] is not True:
        return None
    evidence = item["evidence"]
    return {
        "assignment_id": item["assignment_id"],
        "source_record_sha256": item["source_record_sha256"],
        "opportunity_window_id": evidence["opportunity_window_id"],
        "scoring_system_version": evidence["scoring_system_version"],
        "scoring_system_sha256": evidence["scoring_system_sha256"],
        "snapshot_sha256": evidence["snapshot_sha256"],
        "opportunity_score": item["opportunity_score"],
    }


def _assignment_projection(item: Mapping[str, Any], protocol: Mapping[str, Any]) -> dict[str, Any]:
    block = str(item["temporal_block"])
    if item["cohort_role"] == "primary":
        split = (
            "baseline-development"
            if block in protocol["temporal_design"]["development_blocks"]
            else "locked-test"
        )
    elif item["cohort_role"] == "secondary":
        split = "observational-secondary"
    elif item["cohort_role"] == "quarantined":
        split = "quarantined"
    else:
        split = "exploratory"
    return {
        "assignment_id": item["assignment_id"],
        "source_record_sha256": item["source_record_sha256"],
        "label_free_row_sha256": canonical_sha256(
            label_free_export_projection(item, protocol)
        ),
        "candidate_prediction_sha256": (
            canonical_sha256(candidate_prediction)
            if (candidate_prediction := _candidate_prediction_projection(item)) is not None
            else None
        ),
        "participant_group_id": item["participant_group_id"],
        "cohort_role": item["cohort_role"],
        "source_role": item["source_role"],
        "selection_design": item["selection_design"],
        "site_id": item["site_id"],
        "geographic_panel": item["geographic_panel"],
        "temporal_block": block,
        "split": split,
        "opportunity_score": item["opportunity_score"],
        "evidence": deepcopy(item["evidence"]),
    }


def _aggregate_counts(assignments: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    counts = Counter(str(item["cohort_role"]) for item in assignments)
    return {
        "total_assignments": len(assignments),
        "primary": counts["primary"],
        "secondary": counts["secondary"],
        "exploratory": counts["exploratory"],
        "quarantined": counts["quarantined"],
    }


def _label_free_snapshot_projection(items: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return the canonical, minimized projection whose digest seals raw inputs."""

    return sorted(
        (
            {
                key: deepcopy(value)
                for key, value in item.items()
                if key != "angler_hours"
            }
            for item in items
        ),
        key=lambda item: str(item["assignment_id"]),
    )


def label_free_snapshot_sha256(items: Sequence[Mapping[str, Any]]) -> str:
    return canonical_sha256(_label_free_snapshot_projection(items))


def label_free_export_projection(
    item: Mapping[str, Any], protocol: Mapping[str, Any]
) -> dict[str, Any]:
    """Reconstruct the exact label-free server export row signed by the census."""

    return {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "assignment_id": item["assignment_id"],
        "source_record_sha256": item["source_record_sha256"],
        "participant_group_id": item["participant_group_id"],
        "protocol_id": protocol["protocol_id"],
        "protocol_version": protocol["protocol_version"],
        "cohort_role": item["cohort_role"],
        "source_role": item["source_role"],
        "selection_design": item["selection_design"],
        "site_id": item["site_id"],
        "opportunity_score": item["opportunity_score"],
        "impression_attestation": deepcopy(item["impression_attestation"]),
        "score_exposure_attestation": deepcopy(
            item["score_exposure_attestation"]
        ),
        "server_attested": item["server_attested"],
        "evidence_status": item["evidence_status"],
        "deletion_lineage": deepcopy(item["deletion_lineage"]),
        "evidence": deepcopy(item["evidence"]),
    }


def prediction_snapshot_sha256(opportunity_ledger_path: Path, candidate_predictions_path: Path) -> str:
    return canonical_sha256(
        {
            "opportunity_ledger_sha256": sha256_file(opportunity_ledger_path),
            "candidate_predictions_sha256": sha256_file(candidate_predictions_path),
        }
    )


def _load_exact_json_object(path: Path, *, artifact: str) -> dict[str, Any]:
    require_private_file(path, artifact=artifact)
    try:
        value = strict_json_loads(path.read_text(encoding="utf-8"), artifact=artifact)
    except (OSError, ValueError) as exc:
        raise ValueError(f"could not load {artifact} JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{artifact} must be a JSON object")
    _reject_forbidden_fields(value, location=artifact)
    serialized = canonical_json_bytes(value).decode("utf-8")
    if (
        '"outcome_class"' in serialized
        or '"target_encounter_count"' in serialized
        or '"target_encountered"' in serialized
    ):
        raise ValueError(f"{artifact} must be label-free")
    return value


def validate_label_free_prediction_artifacts(
    *,
    opportunity_ledger_path: Path,
    candidate_predictions_path: Path,
    evidence: Sequence[Mapping[str, Any]],
    protocol: Mapping[str, Any],
    activation: Mapping[str, Any],
) -> dict[str, str]:
    """Strictly validate and join minimized opportunity/prediction artifacts."""

    ledger = _load_exact_json_object(opportunity_ledger_path, artifact="opportunity ledger")
    _require_exact_keys(ledger, OPPORTUNITY_LEDGER_FIELDS, location="opportunity ledger")
    if (
        ledger.get("schema_version")
        != "castingcompass.validation-opportunity-ledger/1.0.0"
        or ledger.get("protocol_id") != protocol["protocol_id"]
        or ledger.get("protocol_version") != protocol["protocol_version"]
    ):
        raise ValueError("opportunity ledger protocol identity is invalid")
    entries = ledger.get("entries")
    if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
        raise ValueError("opportunity ledger entries must be an object array")
    if entries != sorted(entries, key=lambda item: str(item.get("assignment_id"))):
        raise ValueError("opportunity ledger entries must be sorted by assignment_id")

    predictions_document = _load_exact_json_object(
        candidate_predictions_path, artifact="candidate predictions"
    )
    _require_exact_keys(
        predictions_document, CANDIDATE_PREDICTION_FIELDS, location="candidate predictions"
    )
    if (
        predictions_document.get("schema_version")
        != "castingcompass.validation-candidate-predictions/1.0.0"
        or predictions_document.get("protocol_id") != protocol["protocol_id"]
        or predictions_document.get("protocol_version") != protocol["protocol_version"]
    ):
        raise ValueError("candidate prediction protocol identity is invalid")
    predictions = predictions_document.get("predictions")
    if not isinstance(predictions, list) or not all(
        isinstance(item, dict) for item in predictions
    ):
        raise ValueError("candidate predictions must be an object array")
    if predictions != sorted(predictions, key=lambda item: str(item.get("assignment_id"))):
        raise ValueError("candidate predictions must be sorted by assignment_id")

    prospective = {
        str(item["assignment_id"]): item
        for item in evidence
        if item["evidence"]["prospective_assignment_issued"] is True
    }
    ledger_by_id: dict[str, Mapping[str, Any]] = {}
    for index, entry in enumerate(entries):
        _require_exact_keys(
            entry,
            OPPORTUNITY_LEDGER_ENTRY_FIELDS,
            location=f"opportunity ledger.entries[{index}]",
        )
        assignment_id = entry.get("assignment_id")
        if not isinstance(assignment_id, str) or ASSIGNMENT_PATTERN.fullmatch(assignment_id) is None:
            raise ValueError("opportunity ledger assignment_id is invalid")
        if assignment_id in ledger_by_id:
            raise ValueError("opportunity ledger contains duplicate assignments")
        ledger_by_id[assignment_id] = entry
    prediction_by_id: dict[str, Mapping[str, Any]] = {}
    for index, entry in enumerate(predictions):
        _require_exact_keys(
            entry,
            CANDIDATE_PREDICTION_ENTRY_FIELDS,
            location=f"candidate predictions.predictions[{index}]",
        )
        assignment_id = entry.get("assignment_id")
        if not isinstance(assignment_id, str) or ASSIGNMENT_PATTERN.fullmatch(assignment_id) is None:
            raise ValueError("candidate prediction assignment_id is invalid")
        score = entry.get("opportunity_score")
        if (
            isinstance(score, bool)
            or not isinstance(score, int)
            or not (0 <= score <= 100)
        ):
            raise ValueError("candidate prediction score must be ordinal 0 to 100")
        if assignment_id in prediction_by_id:
            raise ValueError("candidate predictions contain duplicate assignments")
        prediction_by_id[assignment_id] = entry
    if set(ledger_by_id) != set(prospective) or set(prediction_by_id) != set(prospective):
        raise ValueError("ledger and predictions must exactly cover prospective evidence")

    for assignment_id, item in prospective.items():
        validate_impression_attestation(item, activation=activation)
        validate_score_exposure_attestation(item, activation=activation)
        evidence_identity = item["evidence"]
        ledger_entry = ledger_by_id[assignment_id]
        prediction = prediction_by_id[assignment_id]
        expected_ledger = {
            "assignment_id": assignment_id,
            "source_record_sha256": item["source_record_sha256"],
            "opportunity_window_id": evidence_identity["opportunity_window_id"],
            "site_id": item["site_id"],
            "window_start_at": evidence_identity["window_start_at"],
            "window_end_at": evidence_identity["window_end_at"],
            "opportunity_contract_version": evidence_identity["opportunity_contract_version"],
            "scoring_system_kind": evidence_identity["scoring_system_kind"],
            "scoring_system_version": evidence_identity["scoring_system_version"],
            "scoring_system_sha256": evidence_identity["scoring_system_sha256"],
            "snapshot_sha256": evidence_identity["snapshot_sha256"],
            "site_catalog_sha256": evidence_identity["site_catalog_sha256"],
            "impression_attestation_sha256": evidence_identity[
                "impression_attestation_sha256"
            ],
            "score_exposure_attestation_sha256": evidence_identity[
                "score_exposure_attestation_sha256"
            ],
        }
        expected_prediction = _candidate_prediction_projection(item)
        if expected_prediction is None:  # guarded by the prospective mapping above
            raise ValueError(f"candidate prediction is not applicable to {assignment_id}")
        if dict(ledger_entry) != expected_ledger:
            raise ValueError(f"opportunity ledger identity mismatch for {assignment_id}")
        if dict(prediction) != expected_prediction:
            raise ValueError(f"candidate prediction identity mismatch for {assignment_id}")
        if (
            evidence_identity["scoring_system_kind"] != activation["scoring_system_kind"]
            or evidence_identity["scoring_system_version"]
            != activation["scoring_system_version"]
            or evidence_identity["scoring_system_sha256"]
            != activation["scoring_system_sha256"]
            or evidence_identity["opportunity_contract_version"]
            != activation["opportunity_contract_version"]
        ):
            raise ValueError("prospective artifact identity differs from activation")
    return {
        "opportunity_ledger_sha256": sha256_file(opportunity_ledger_path),
        "candidate_predictions_sha256": sha256_file(candidate_predictions_path),
        "prediction_snapshot_sha256": prediction_snapshot_sha256(
            opportunity_ledger_path, candidate_predictions_path
        ),
    }


def _decode_canonical_base64(value: Any, *, location: str, expected_length: int | None = None) -> bytes:
    if not isinstance(value, str):
        raise ValueError(f"{location} must be base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"{location} must be canonical base64") from exc
    if base64.b64encode(decoded).decode("ascii") != value:
        raise ValueError(f"{location} is not canonical base64")
    if expected_length is not None and len(decoded) != expected_length:
        raise ValueError(f"{location} has an invalid decoded length")
    return decoded


def impression_attestation_payload(item: Mapping[str, Any]) -> dict[str, Any]:
    """Reconstruct the exact full pre-outcome identity signed by the service."""

    evidence = item["evidence"]
    secondary = evidence["intended_cohort_role"] == "secondary"
    return {
        "protocol_id": evidence["collection_validation_protocol_id"],
        "protocol_version": "1.0.0",
        "activation_manifest_sha256": evidence["activation_manifest_sha256"],
        "assignment_id": item["assignment_id"],
        "source_record_sha256": item["source_record_sha256"],
        "participant_group_id": item["participant_group_id"],
        "activation_activated_at": evidence["collection_activated_at"],
        "intended_cohort_role": evidence["intended_cohort_role"],
        "intended_source_role": evidence["intended_source_role"],
        "selection_design": item["selection_design"],
        "selection_method": evidence["intended_selection_method"],
        "intended_cohort_id": evidence["intended_cohort_id"],
        "target_taxon_id": evidence["target_taxon_id"],
        "recruitment_frame_id": evidence["recruitment_frame_id"],
        "recruitment_source_id": evidence["recruitment_source_id"],
        "recruitment_event_contract_version": evidence[
            "recruitment_event_contract_version"
        ],
        "recruitment_event_at": evidence["recruitment_event_at"],
        "recruitment_event_sha256": evidence["recruitment_event_sha256"],
        "community_approval_sha256": evidence["community_approval_sha256"],
        "incentive_policy_id": evidence["incentive_policy_id"],
        "score_influenced_choice_at_assignment": evidence[
            "score_influenced_choice"
        ],
        "study_consent_version": evidence["study_consent_version"],
        "study_consent_at": evidence["study_consent_at"],
        "target_intent_confirmed_at": evidence["target_intent_confirmed_at"],
        "precommitment_event_sha256": evidence["precommitment_event_sha256"],
        "feasible_set_sha256": evidence["feasible_set_sha256"],
        "feasible_option_count": evidence["feasible_option_count"],
        "assignment_probability_numerator": evidence[
            "assignment_probability_numerator"
        ],
        "assignment_probability_denominator": evidence[
            "assignment_probability_denominator"
        ],
        "randomization_draw_index": evidence["randomization_draw_index"],
        "randomization_audit_sha256": evidence["randomization_audit_sha256"],
        "forecast_impression_id": evidence["forecast_impression_id"],
        "opportunity_window_id": evidence["opportunity_window_id"],
        "site_id": item["site_id"],
        "window_start_at": evidence["window_start_at"],
        "window_end_at": evidence["window_end_at"],
        "opportunity_score": item["opportunity_score"],
        "snapshot_sha256": evidence["snapshot_sha256"],
        "site_catalog_sha256": evidence["site_catalog_sha256"],
        "scoring_system_kind": evidence["scoring_system_kind"],
        "scoring_system_version": evidence["scoring_system_version"],
        "scoring_system_sha256": evidence["scoring_system_sha256"],
        "opportunity_contract_version": evidence["opportunity_contract_version"],
        "impression_or_assignment_at": evidence["impression_or_assignment_at"],
        "score_exposure_state_at_attestation": (
            "already-exposed" if secondary else "not-yet-exposed"
        ),
        "score_first_exposed_at_if_already_exposed": (
            evidence["score_first_exposed_at"] if secondary else None
        ),
        "attested_at": evidence["impression_or_assignment_at"],
    }


def score_exposure_attestation_payload(item: Mapping[str, Any]) -> dict[str, Any]:
    """Reconstruct the primary-only event signed when the score is exposed."""

    evidence = item["evidence"]
    return {
        "protocol_id": evidence["collection_validation_protocol_id"],
        "protocol_version": "1.0.0",
        "activation_manifest_sha256": evidence["activation_manifest_sha256"],
        "assignment_id": item["assignment_id"],
        "source_record_sha256": item["source_record_sha256"],
        "participant_group_id": item["participant_group_id"],
        "selection_design": item["selection_design"],
        "impression_attestation_sha256": evidence["impression_attestation_sha256"],
        "forecast_impression_id": evidence["forecast_impression_id"],
        "opportunity_window_id": evidence["opportunity_window_id"],
        "site_id": item["site_id"],
        "window_start_at": evidence["window_start_at"],
        "window_end_at": evidence["window_end_at"],
        "opportunity_score": item["opportunity_score"],
        "snapshot_sha256": evidence["snapshot_sha256"],
        "site_catalog_sha256": evidence["site_catalog_sha256"],
        "scoring_system_kind": evidence["scoring_system_kind"],
        "scoring_system_version": evidence["scoring_system_version"],
        "scoring_system_sha256": evidence["scoring_system_sha256"],
        "opportunity_contract_version": evidence["opportunity_contract_version"],
        "score_first_exposed_at": evidence["score_first_exposed_at"],
        "attested_at": evidence["score_first_exposed_at"],
    }


def validate_impression_attestation(
    item: Mapping[str, Any], *, activation: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Validate the canonical signed score/site/window identity before admission."""

    envelope = item.get("impression_attestation")
    if not isinstance(envelope, dict):
        raise ValueError("prospective evidence requires a signed impression attestation")
    _require_exact_keys(
        envelope,
        IMPRESSION_ATTESTATION_ENVELOPE_FIELDS,
        location="impression attestation",
    )
    if envelope.get("schema_version") != IMPRESSION_ATTESTATION_SCHEMA_VERSION:
        raise ValueError("impression attestation schema version is unsupported")
    payload_bytes = _decode_canonical_base64(
        envelope.get("payload_base64"), location="impression attestation payload"
    )
    if hashlib.sha256(payload_bytes).hexdigest() != envelope.get("payload_sha256"):
        raise ValueError("impression attestation payload SHA-256 is invalid")
    try:
        payload = strict_json_loads(
            payload_bytes,
            artifact="impression attestation payload",
            reject_floats=True,
        )
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("impression attestation payload is invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("impression attestation payload must be an object")
    _require_exact_keys(
        payload,
        IMPRESSION_ATTESTATION_PAYLOAD_FIELDS,
        location="impression attestation payload",
    )
    if canonical_json_bytes(payload) != payload_bytes:
        raise ValueError("impression attestation payload is not canonical JSON")
    if payload_bytes != canonical_json_bytes(impression_attestation_payload(item)):
        raise ValueError("impression attestation does not match the exact evidence row")
    evidence = item["evidence"]
    attested_at = _parse_datetime(payload["attested_at"], location="attestation.attested_at")
    assignment_at = _parse_datetime(
        evidence["impression_or_assignment_at"],
        location="evidence.impression_or_assignment_at",
    )
    segment_start = _parse_datetime(
        evidence["segment_start_at"], location="evidence.segment_start_at"
    )
    if attested_at != assignment_at or attested_at >= segment_start:
        raise ValueError("impression attestation was not sealed at the pre-outcome assignment")
    if evidence["intended_cohort_role"] == "primary":
        if (
            payload["score_exposure_state_at_attestation"] != "not-yet-exposed"
            or payload["score_first_exposed_at_if_already_exposed"] is not None
        ):
            raise ValueError("primary assignment attestation claims future score exposure")
    elif (
        payload["score_exposure_state_at_attestation"] != "already-exposed"
        or payload["score_first_exposed_at_if_already_exposed"] is None
        or _parse_datetime(
            payload["score_first_exposed_at_if_already_exposed"],
            location="attestation.score_first_exposed_at_if_already_exposed",
        )
        >= assignment_at
    ):
        raise ValueError("secondary assignment attestation lacks prior score exposure")
    if evidence.get("impression_attestation_sha256") != canonical_sha256(envelope):
        raise ValueError("impression attestation envelope SHA-256 is invalid")
    if activation is not None:
        if envelope.get("signing_key_id") != activation.get(
            "validation_export_signing_key_id"
        ):
            raise ValueError("impression attestation signing key differs from activation")
        if (
            payload["scoring_system_kind"] != activation.get("scoring_system_kind")
            or payload["scoring_system_version"]
            != activation.get("scoring_system_version")
            or payload["scoring_system_sha256"]
            != activation.get("scoring_system_sha256")
            or payload["opportunity_contract_version"]
            != activation.get("opportunity_contract_version")
        ):
            raise ValueError("impression attestation scoring identity differs from activation")
        signature = _decode_canonical_base64(
            envelope.get("signature_ed25519"),
            location="impression attestation signature",
            expected_length=64,
        )
        public_key = _decode_ed25519_public_key(
            activation.get("validation_export_public_key_ed25519"),
            location="activation.validation_export_public_key_ed25519",
        )
        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(
                signature, payload_bytes
            )
        except InvalidSignature as exc:
            raise ValueError("impression attestation signature is invalid") from exc
    return payload


def validate_score_exposure_attestation(
    item: Mapping[str, Any], *, activation: Mapping[str, Any] | None = None
) -> dict[str, Any] | None:
    """Validate the later primary score-exposure event without backdating."""

    evidence = item["evidence"]
    envelope = item.get("score_exposure_attestation")
    envelope_digest = evidence.get("score_exposure_attestation_sha256")
    score_exposed_at = evidence.get("score_first_exposed_at")
    if evidence["intended_cohort_role"] != "primary" or score_exposed_at is None:
        if envelope is not None or envelope_digest is not None:
            raise ValueError(
                "score-exposure attestation is allowed only for an exposed primary assignment"
            )
        return None
    if not isinstance(envelope, dict):
        raise ValueError("exposed primary evidence requires a score-exposure attestation")
    _require_exact_keys(
        envelope,
        SCORE_EXPOSURE_ATTESTATION_ENVELOPE_FIELDS,
        location="score-exposure attestation",
    )
    if envelope.get("schema_version") != SCORE_EXPOSURE_ATTESTATION_SCHEMA_VERSION:
        raise ValueError("score-exposure attestation schema version is unsupported")
    payload_bytes = _decode_canonical_base64(
        envelope.get("payload_base64"), location="score-exposure attestation payload"
    )
    if hashlib.sha256(payload_bytes).hexdigest() != envelope.get("payload_sha256"):
        raise ValueError("score-exposure attestation payload SHA-256 is invalid")
    try:
        payload = strict_json_loads(
            payload_bytes,
            artifact="score-exposure attestation payload",
            reject_floats=True,
        )
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("score-exposure attestation payload is invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("score-exposure attestation payload must be an object")
    _require_exact_keys(
        payload,
        SCORE_EXPOSURE_ATTESTATION_PAYLOAD_FIELDS,
        location="score-exposure attestation payload",
    )
    if canonical_json_bytes(payload) != payload_bytes:
        raise ValueError("score-exposure attestation payload is not canonical JSON")
    if payload_bytes != canonical_json_bytes(score_exposure_attestation_payload(item)):
        raise ValueError(
            "score-exposure attestation does not match the exact evidence row"
        )
    exposed_at = _parse_datetime(
        score_exposed_at, location="evidence.score_first_exposed_at"
    )
    assignment_at = _parse_datetime(
        evidence["impression_or_assignment_at"],
        location="evidence.impression_or_assignment_at",
    )
    segment_start = _parse_datetime(
        evidence["segment_start_at"], location="evidence.segment_start_at"
    )
    attested_at = _parse_datetime(
        payload["attested_at"], location="score_exposure.attested_at"
    )
    if attested_at != exposed_at or exposed_at <= assignment_at or exposed_at >= segment_start:
        raise ValueError(
            "primary score-exposure attestation was not sealed at its actual pre-outcome event"
        )
    if envelope_digest != canonical_sha256(envelope):
        raise ValueError("score-exposure attestation envelope SHA-256 is invalid")
    if activation is not None:
        if envelope.get("signing_key_id") != activation.get(
            "validation_export_signing_key_id"
        ):
            raise ValueError("score-exposure signing key differs from activation")
        if (
            payload["scoring_system_kind"] != activation.get("scoring_system_kind")
            or payload["scoring_system_version"]
            != activation.get("scoring_system_version")
            or payload["scoring_system_sha256"]
            != activation.get("scoring_system_sha256")
            or payload["opportunity_contract_version"]
            != activation.get("opportunity_contract_version")
        ):
            raise ValueError("score-exposure scoring identity differs from activation")
        signature = _decode_canonical_base64(
            envelope.get("signature_ed25519"),
            location="score-exposure attestation signature",
            expected_length=64,
        )
        public_key = _decode_ed25519_public_key(
            activation.get("validation_export_public_key_ed25519"),
            location="activation.validation_export_public_key_ed25519",
        )
        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(
                signature, payload_bytes
            )
        except InvalidSignature as exc:
            raise ValueError("score-exposure attestation signature is invalid") from exc
    return payload


def _reconciliation_stream_events(
    records: Sequence[Mapping[str, Any]], *, event_type: str
) -> list[dict[str, Any]]:
    if event_type == "assignment-issued":
        events = [
            {
                "sequence": record["assignment_sequence"],
                "event_type": event_type,
                "assignment_id": record["assignment_id"],
                "event_sha256": record["impression_attestation_sha256"],
                "event_at": record["assignment_issued_at"],
            }
            for record in records
        ]
    elif event_type == "score-first-exposed":
        events = [
            {
                "sequence": record["exposure_sequence"],
                "event_type": event_type,
                "assignment_id": record["assignment_id"],
                "event_sha256": record["score_exposure_attestation_sha256"],
                "event_at": record["score_exposed_at"],
            }
            for record in records
            if record["score_exposure_evidence_kind"]
            == "signed-first-exposure-event"
        ]
    else:  # pragma: no cover - internal callers use the two frozen event types
        raise ValueError("unsupported reconciliation stream event type")
    return sorted(events, key=lambda event: int(event["sequence"]))


def _reconciliation_stream_summary(
    stream_id: str, events: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    return {
        "stream_id": stream_id,
        "first_sequence": int(events[0]["sequence"]) if events else None,
        "last_sequence": int(events[-1]["sequence"]) if events else None,
        "event_count": len(events),
        "event_set_sha256": canonical_sha256(list(events)),
        "chain_tip_sha256": None,
        "external_log_proof_sha256": None,
    }


def _issued_assignment_set_projection(
    records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    return sorted(
        (
            {
                "assignment_id": record["assignment_id"],
                "impression_attestation_sha256": record[
                    "impression_attestation_sha256"
                ],
            }
            for record in records
        ),
        key=lambda item: str(item["assignment_id"]),
    )


def _signed_exposure_set_projection(
    records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    return sorted(
        (
            {
                "assignment_id": record["assignment_id"],
                "score_exposure_attestation_sha256": record[
                    "score_exposure_attestation_sha256"
                ],
            }
            for record in records
            if record["score_exposure_evidence_kind"]
            == "signed-first-exposure-event"
        ),
        key=lambda item: str(item["assignment_id"]),
    )


def _terminal_disposition_set_projection(
    records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    return sorted(
        (
            {
                "assignment_id": record["assignment_id"],
                "disposition_event_sha256": record["disposition_event_sha256"],
            }
            for record in records
        ),
        key=lambda item: str(item["assignment_id"]),
    )


def _disposition_event_sha256(record: Mapping[str, Any]) -> str:
    return canonical_sha256(
        {
            field: record[field]
            for field in sorted(ISSUANCE_DISPOSITION_RECORD_FIELDS)
            if field != "disposition_event_sha256"
        }
    )


def _validate_issuance_reconciliation(
    value: Any,
    *,
    evidence: Sequence[Mapping[str, Any]],
    protocol: Mapping[str, Any],
    activation_manifest: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("trusted census issuance reconciliation must be an object")
    _require_exact_keys(
        value,
        ISSUANCE_RECONCILIATION_FIELDS,
        location="census.issuance_reconciliation",
    )
    if (
        value.get("evidence_basis")
        != "signed-exporter-assertion-without-raw-ledger-proof"
        or value.get("append_only_log_proof_included") is not False
        or value.get("query_id")
        != protocol["recruitment"]["issuance_reconciliation_query_id"]
    ):
        raise ValueError(
            "trusted census must truthfully identify its signed-assertion evidence basis"
        )
    reconciled_through = _parse_datetime(
        value.get("reconciled_through_at"),
        location="census.issuance_reconciliation.reconciled_through_at",
    )
    enrollment_end = _parse_datetime(
        protocol["enrollment"]["end_at"], location="enrollment.end_at"
    )
    if (
        reconciled_through.microsecond % 1000
        or reconciled_through < enrollment_end
        or reconciled_through > generated_at
    ):
        raise ValueError("issuance reconciliation does not cover the terminal query")
    if (
        value.get("missing_issued_assignment_ids") != []
        or value.get("unmatched_exposure_event_ids") != []
        or isinstance(value.get("missing_issued_assignment_count"), bool)
        or not isinstance(value.get("missing_issued_assignment_count"), int)
        or isinstance(value.get("unmatched_exposure_event_count"), bool)
        or not isinstance(value.get("unmatched_exposure_event_count"), int)
        or value.get("missing_issued_assignment_count") != 0
        or value.get("unmatched_exposure_event_count") != 0
    ):
        raise ValueError(
            "issuance reconciliation must report zero missing assignments and unmatched exposures"
        )
    records = value.get("records")
    if not isinstance(records, list) or not all(
        isinstance(record, dict) for record in records
    ):
        raise ValueError("issuance reconciliation records must be an object array")
    assignment_sequences: list[int] = []
    exposure_sequences: list[int] = []
    assignment_times: list[datetime] = []
    exposure_times_by_sequence: list[tuple[int, datetime]] = []
    seen_assignments: set[str] = set()
    seen_sources: set[str] = set()
    seen_impressions: set[str] = set()
    seen_exposures: set[str] = set()
    activation_at = _parse_datetime(
        activation_manifest["activated_at"], location="activation.activated_at"
    )
    enrollment_start = _parse_datetime(
        protocol["enrollment"]["start_at"], location="enrollment.start_at"
    )
    allowed_reasons = {
        "completed-and-exported": {None},
        "incomplete-or-expired": {"no-completion-before-enrollment-close"},
        "safe-canceled": {"participant-safe-cancellation"},
        "withdrawn": {"participant-withdrawal", "account-deletion"},
        "excluded": {
            "protocol-eligibility-failure",
            "duplicate-or-conflicting-assignment",
            "score-exposed-during-effort-through-completion",
        },
    }
    for index, record in enumerate(records):
        _require_exact_keys(
            record,
            ISSUANCE_DISPOSITION_RECORD_FIELDS,
            location=f"census.issuance_reconciliation.records[{index}]",
        )
        sequence = record.get("assignment_sequence")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
            raise ValueError("issuance assignment sequence is invalid")
        assignment_sequences.append(sequence)
        assignment_id = record.get("assignment_id")
        source_digest = record.get("source_record_sha256")
        impression_digest = record.get("impression_attestation_sha256")
        if (
            not isinstance(assignment_id, str)
            or ASSIGNMENT_PATTERN.fullmatch(assignment_id) is None
            or not isinstance(source_digest, str)
            or SHA256_PATTERN.fullmatch(source_digest) is None
            or not isinstance(impression_digest, str)
            or SHA256_PATTERN.fullmatch(impression_digest) is None
            or assignment_id in seen_assignments
            or source_digest in seen_sources
            or impression_digest in seen_impressions
        ):
            raise ValueError("issuance reconciliation identity is invalid or duplicated")
        seen_assignments.add(assignment_id)
        seen_sources.add(source_digest)
        seen_impressions.add(impression_digest)
        intended_role = record.get("intended_cohort_role")
        intended_source = record.get("intended_source_role")
        if (
            intended_role not in {"primary", "secondary"}
            or intended_source
            != (
                "prospective-first-party"
                if intended_role == "primary"
                else "score-visible-first-party"
            )
        ):
            raise ValueError("issuance reconciliation intended role/source is invalid")
        issued_at = _parse_datetime(
            record.get("assignment_issued_at"),
            location=f"census.issuance_reconciliation.records[{index}].assignment_issued_at",
        )
        reconciliation_watermark_at = _parse_datetime(
            record.get("reconciliation_watermark_at"),
            location=(
                f"census.issuance_reconciliation.records[{index}]"
                ".reconciliation_watermark_at"
            ),
        )
        if (
            issued_at.microsecond % 1000
            or reconciliation_watermark_at.microsecond % 1000
            or issued_at <= activation_at
            or issued_at < enrollment_start
            or issued_at >= enrollment_end
            or reconciliation_watermark_at != reconciled_through
            or record.get("reconciliation_watermark_at")
            != value.get("reconciled_through_at")
        ):
            raise ValueError("issuance reconciliation chronology is invalid")
        assignment_times.append(issued_at)
        exposure_kind = record.get("score_exposure_evidence_kind")
        exposure_sequence = record.get("exposure_sequence")
        exposure_digest = record.get("score_exposure_attestation_sha256")
        exposure_link = record.get(
            "score_exposure_links_impression_attestation_sha256"
        )
        score_exposed_raw = record.get("score_exposed_at")
        score_disposition = record.get("score_exposure_disposition")
        segment_start_raw = record.get("segment_start_at")
        completion_at_raw = record.get("completion_event_at")
        segment_boundary: datetime | None = None
        completion_boundary: datetime | None = None
        if segment_start_raw is not None:
            segment_boundary = _parse_datetime(
                segment_start_raw,
                location=f"census.issuance_reconciliation.records[{index}].segment_start_at",
            )
            if (
                segment_boundary.microsecond % 1000
                or segment_boundary <= issued_at
                or segment_boundary > reconciliation_watermark_at
            ):
                raise ValueError("issuance reconciliation effort boundaries are invalid")
        if completion_at_raw is not None:
            completion_boundary = _parse_datetime(
                completion_at_raw,
                location=f"census.issuance_reconciliation.records[{index}].completion_event_at",
            )
            if (
                segment_boundary is None
                or completion_boundary.microsecond % 1000
                or completion_boundary < segment_boundary
                or completion_boundary > reconciliation_watermark_at
            ):
                raise ValueError("issuance reconciliation completion boundary is invalid")
        if exposure_kind == "signed-first-exposure-event":
            if (
                intended_role != "primary"
                or isinstance(exposure_sequence, bool)
                or not isinstance(exposure_sequence, int)
                or exposure_sequence < 1
                or not isinstance(exposure_digest, str)
                or SHA256_PATTERN.fullmatch(exposure_digest) is None
                or exposure_digest in seen_exposures
                or exposure_link != impression_digest
            ):
                raise ValueError("signed score-exposure reconciliation is invalid")
            exposed_at = _parse_datetime(
                score_exposed_raw,
                location=f"census.issuance_reconciliation.records[{index}].score_exposed_at",
            )
            if (
                exposed_at.microsecond % 1000
                or exposed_at <= issued_at
                or exposed_at > reconciliation_watermark_at
            ):
                raise ValueError("signed score-exposure chronology is invalid")
            expected_score_disposition = (
                "exposed-after-assignment-no-effort-started"
                if segment_boundary is None
                else (
                    "exposed-after-assignment-before-segment"
                    if exposed_at < segment_boundary
                    else (
                        "exposed-during-started-incomplete-effort"
                        if completion_boundary is None
                        else (
                            "exposed-during-effort-through-completion"
                            if exposed_at <= completion_boundary
                            else "exposed-after-completion"
                        )
                    )
                )
            )
            if score_disposition != expected_score_disposition:
                raise ValueError("signed score-exposure disposition is invalid")
            exposure_sequences.append(exposure_sequence)
            exposure_times_by_sequence.append((exposure_sequence, exposed_at))
            seen_exposures.add(exposure_digest)
        elif exposure_kind == "prior-exposure-asserted-in-impression":
            if (
                intended_role != "secondary"
                or exposure_sequence is not None
                or exposure_digest is not None
                or exposure_link is not None
                or score_disposition != "already-exposed-before-assignment"
            ):
                raise ValueError("prior score-exposure assertion is invalid")
            exposed_at = _parse_datetime(
                score_exposed_raw,
                location=f"census.issuance_reconciliation.records[{index}].score_exposed_at",
            )
            if exposed_at.microsecond % 1000 or exposed_at >= issued_at:
                raise ValueError("prior score exposure must precede assignment")
        elif exposure_kind == "none":
            if (
                intended_role != "primary"
                or exposure_sequence is not None
                or exposure_digest is not None
                or exposure_link is not None
                or score_exposed_raw is not None
                or score_disposition
                != "no-issued-exposure-through-terminal-watermark"
            ):
                raise ValueError("no-exposure terminal assertion is invalid")
        else:
            raise ValueError("score exposure evidence kind is invalid")
        terminal_disposition = record.get("terminal_disposition")
        terminal_reason = record.get("terminal_reason")
        if (
            terminal_disposition not in ISSUANCE_DISPOSITION_STATUSES
            or terminal_reason not in allowed_reasons[str(terminal_disposition)]
        ):
            raise ValueError("terminal issuance disposition/reason is invalid")
        final_role = record.get("final_cohort_role")
        row_digest = record.get("label_free_row_sha256")
        completion_digest = record.get("completion_event_sha256")
        sealed_score_disposition = record.get(
            "sealed_row_score_exposure_disposition"
        )
        terminal_provenance = record.get(
            "terminal_collection_provenance_chain_sha256"
        )
        for digest_value, digest_name in (
            (row_digest, "label-free row"),
            (completion_digest, "completion event"),
        ):
            if digest_value is not None and (
                not isinstance(digest_value, str)
                or SHA256_PATTERN.fullmatch(digest_value) is None
            ):
                raise ValueError(f"issuance reconciliation {digest_name} digest is invalid")
        if (completion_digest is None) != (completion_at_raw is None):
            raise ValueError(
                "issuance reconciliation completion time/hash must be both present or absent"
            )
        if (
            not isinstance(terminal_provenance, str)
            or SHA256_PATTERN.fullmatch(terminal_provenance) is None
        ):
            raise ValueError("terminal collection provenance digest is invalid")
        if terminal_disposition == "completed-and-exported":
            if (
                final_role != intended_role
                or final_role not in {"primary", "secondary"}
                or row_digest is None
                or completion_digest is None
                or terminal_reason is not None
                or score_disposition
                == "exposed-during-effort-through-completion"
                or sealed_score_disposition
                not in {
                    "never-exposed-through-completion",
                    "exposed-after-assignment-before-segment",
                    "already-exposed-before-assignment",
                }
            ):
                raise ValueError("completed exported disposition is inconsistent")
        elif terminal_disposition == "excluded":
            if (
                final_role is not None
                or row_digest is not None
                or sealed_score_disposition is not None
            ):
                raise ValueError("excluded unsealed disposition has a final sealed row")
        elif (
            final_role is not None
            or row_digest is not None
            or sealed_score_disposition is not None
        ):
            raise ValueError("unsealed disposition cannot claim a final sealed row")
        if score_disposition == "exposed-during-effort-through-completion" and (
            terminal_disposition != "excluded"
            or terminal_reason
            != "score-exposed-during-effort-through-completion"
        ):
            raise ValueError("during-effort score exposure must be excluded unsealed")
        if terminal_disposition in {"incomplete-or-expired", "safe-canceled"} and (
            completion_digest is not None
            or (
                terminal_disposition == "incomplete-or-expired"
                and reconciliation_watermark_at < enrollment_end
            )
        ):
            raise ValueError("incomplete/canceled disposition completion lineage is invalid")
        if record.get("disposition_event_sha256") != _disposition_event_sha256(
            record
        ):
            raise ValueError("terminal disposition event SHA-256 is invalid")
    if assignment_sequences != list(range(1, len(records) + 1)):
        raise ValueError("issuance reconciliation assignment sequence has gaps")
    if sorted(exposure_sequences) != list(range(1, len(exposure_sequences) + 1)):
        raise ValueError("issuance reconciliation exposure sequence has gaps")
    if assignment_times != sorted(assignment_times):
        raise ValueError("issuance sequence timestamps are not monotone")
    ordered_exposure_times = [
        timestamp for _, timestamp in sorted(exposure_times_by_sequence)
    ]
    if ordered_exposure_times != sorted(ordered_exposure_times):
        raise ValueError("score-exposure sequence timestamps are not monotone")

    issued_projection = _issued_assignment_set_projection(records)
    exposure_projection = _signed_exposure_set_projection(records)
    disposition_projection = _terminal_disposition_set_projection(records)
    disposition_counts = {
        status: sum(record["terminal_disposition"] == status for record in records)
        for status in ISSUANCE_DISPOSITION_STATUSES
    }
    intended_to_final_counts = {
        f"{intended}->{final}": sum(
            record["intended_cohort_role"] == intended
            and (record["final_cohort_role"] or "unsealed") == final
            for record in records
        )
        for intended in ("primary", "secondary")
        for final in ("primary", "secondary", "unsealed")
    }
    for count_field in (
        "issued_assignment_count",
        "signed_primary_exposure_event_count",
    ):
        count_value = value.get(count_field)
        if (
            isinstance(count_value, bool)
            or not isinstance(count_value, int)
            or count_value < 0
        ):
            raise ValueError(f"issuance reconciliation {count_field} is invalid")
    supplied_disposition_counts = value.get("terminal_disposition_counts")
    supplied_transition_counts = value.get("intended_to_final_disposition_counts")
    if (
        not isinstance(supplied_disposition_counts, dict)
        or set(supplied_disposition_counts) != set(ISSUANCE_DISPOSITION_STATUSES)
        or any(
            isinstance(count, bool) or not isinstance(count, int) or count < 0
            for count in supplied_disposition_counts.values()
        )
        or not isinstance(supplied_transition_counts, dict)
        or set(supplied_transition_counts) != set(intended_to_final_counts)
        or any(
            isinstance(count, bool) or not isinstance(count, int) or count < 0
            for count in supplied_transition_counts.values()
        )
    ):
        raise ValueError("issuance reconciliation count maps are invalid")
    if (
        value.get("issued_assignment_count") != len(records)
        or value.get("issued_assignment_set_sha256")
        != canonical_sha256(issued_projection)
        or value.get("signed_primary_exposure_event_count")
        != len(exposure_projection)
        or value.get("signed_primary_exposure_event_set_sha256")
        != canonical_sha256(exposure_projection)
        or value.get("terminal_disposition_set_sha256")
        != canonical_sha256(disposition_projection)
        or value.get("terminal_disposition_counts") != disposition_counts
        or value.get("intended_to_final_disposition_counts")
        != intended_to_final_counts
    ):
        raise ValueError("issuance reconciliation sets or counts are inconsistent")
    issuance_events = _reconciliation_stream_events(
        records, event_type="assignment-issued"
    )
    exposure_events = _reconciliation_stream_events(
        records, event_type="score-first-exposed"
    )
    for field, stream_id, events in (
        (
            "issuance_stream",
            protocol["recruitment"]["issuance_stream_id"],
            issuance_events,
        ),
        (
            "signed_primary_exposure_stream",
            protocol["recruitment"]["exposure_stream_id"],
            exposure_events,
        ),
    ):
        stream = value.get(field)
        if not isinstance(stream, dict):
            raise ValueError(f"issuance reconciliation {field} is invalid")
        _require_exact_keys(
            stream,
            RECONCILIATION_STREAM_FIELDS,
            location=f"census.issuance_reconciliation.{field}",
        )
        for count_field in ("first_sequence", "last_sequence", "event_count"):
            count_value = stream.get(count_field)
            if count_value is not None and (
                isinstance(count_value, bool)
                or not isinstance(count_value, int)
                or count_value < (0 if count_field == "event_count" else 1)
            ):
                raise ValueError(
                    f"issuance reconciliation {field}.{count_field} is invalid"
                )
        if stream != _reconciliation_stream_summary(stream_id, events):
            raise ValueError(f"issuance reconciliation {field} watermark is inconsistent")

    sealed_issued = {
        str(item["assignment_id"]): item
        for item in evidence
        if item["evidence"]["prospective_assignment_issued"] is True
    }
    sealed_nonissued_ids = {
        str(item["assignment_id"])
        for item in evidence
        if item["evidence"]["prospective_assignment_issued"] is not True
    }
    sealed_nonissued_sources = {
        str(item["source_record_sha256"])
        for item in evidence
        if item["evidence"]["prospective_assignment_issued"] is not True
    }
    if seen_assignments & sealed_nonissued_ids or seen_sources & sealed_nonissued_sources:
        raise ValueError(
            "issued reconciliation identity collides with sealed non-issued context"
        )
    record_by_id = {str(record["assignment_id"]): record for record in records}
    sealed_record_ids = {
        str(record["assignment_id"])
        for record in records
        if record["label_free_row_sha256"] is not None
    }
    if sealed_record_ids != set(sealed_issued):
        raise ValueError(
            "issuance reconciliation does not exactly identify sealed versus unsealed assignments"
        )
    for assignment_id, item in sealed_issued.items():
        record = record_by_id[assignment_id]
        evidence_identity = item["evidence"]
        expected_terminal_disposition = "completed-and-exported"
        expected_terminal_reason = None
        expected = {
            "source_record_sha256": item["source_record_sha256"],
            "impression_attestation_sha256": evidence_identity[
                "impression_attestation_sha256"
            ],
            "assignment_issued_at": evidence_identity[
                "impression_or_assignment_at"
            ],
            "intended_cohort_role": evidence_identity["intended_cohort_role"],
            "intended_source_role": evidence_identity["intended_source_role"],
            "segment_start_at": evidence_identity["segment_start_at"],
            "completion_event_at": evidence_identity["completion_event_at"],
            "sealed_row_score_exposure_disposition": evidence_identity[
                "score_exposure_disposition"
            ],
            "terminal_disposition": expected_terminal_disposition,
            "terminal_reason": expected_terminal_reason,
            "final_cohort_role": item["cohort_role"],
            "label_free_row_sha256": canonical_sha256(
                label_free_export_projection(item, protocol)
            ),
            "completion_event_sha256": evidence_identity[
                "completion_event_sha256"
            ],
            "terminal_collection_provenance_chain_sha256": evidence_identity[
                "collection_provenance_chain_sha256"
            ],
        }
        if any(record[field] != expected_value for field, expected_value in expected.items()):
            raise ValueError(
                f"issuance reconciliation differs from sealed assignment {assignment_id}"
            )
        if evidence_identity["intended_cohort_role"] == "secondary":
            expected_exposure = {
                "exposure_sequence": None,
                "score_exposure_attestation_sha256": None,
                "score_exposure_links_impression_attestation_sha256": None,
                "score_exposed_at": evidence_identity["score_first_exposed_at"],
                "score_exposure_evidence_kind": (
                    "prior-exposure-asserted-in-impression"
                ),
                "score_exposure_disposition": "already-exposed-before-assignment",
            }
        elif evidence_identity["score_exposure_attestation_sha256"] is not None:
            expected_exposure = {
                "score_exposure_attestation_sha256": evidence_identity[
                    "score_exposure_attestation_sha256"
                ],
                "score_exposure_links_impression_attestation_sha256": (
                    evidence_identity["impression_attestation_sha256"]
                ),
                "score_exposed_at": evidence_identity["score_first_exposed_at"],
                "score_exposure_evidence_kind": "signed-first-exposure-event",
                "score_exposure_disposition": (
                    "exposed-after-assignment-before-segment"
                ),
            }
            if not isinstance(record["exposure_sequence"], int):
                raise ValueError("sealed pre-segment exposure lacks its stream sequence")
        elif record["score_exposure_evidence_kind"] == "signed-first-exposure-event":
            expected_exposure = {
                "score_exposure_links_impression_attestation_sha256": (
                    evidence_identity["impression_attestation_sha256"]
                ),
                "score_exposure_evidence_kind": "signed-first-exposure-event",
                "score_exposure_disposition": "exposed-after-completion",
            }
            if not isinstance(record["exposure_sequence"], int):
                raise ValueError("sealed post-completion exposure lacks its stream sequence")
        else:
            expected_exposure = {
                "exposure_sequence": None,
                "score_exposure_attestation_sha256": None,
                "score_exposure_links_impression_attestation_sha256": None,
                "score_exposed_at": None,
                "score_exposure_evidence_kind": "none",
                "score_exposure_disposition": (
                    "no-issued-exposure-through-terminal-watermark"
                ),
            }
        if any(
            record[field] != expected_value
            for field, expected_value in expected_exposure.items()
        ):
            raise ValueError(
                f"issuance score exposure differs from sealed assignment {assignment_id}"
            )
    return {
        "issued_assignment_count": len(records),
        "issued_assignment_set_sha256": canonical_sha256(issued_projection),
        "signed_primary_exposure_event_count": len(exposure_projection),
        "signed_primary_exposure_event_set_sha256": canonical_sha256(
            exposure_projection
        ),
        "terminal_disposition_set_sha256": canonical_sha256(disposition_projection),
        "terminal_disposition_counts": disposition_counts,
        "intended_to_final_disposition_counts": intended_to_final_counts,
        "issuance_stream": deepcopy(value["issuance_stream"]),
        "signed_primary_exposure_stream": deepcopy(
            value["signed_primary_exposure_stream"]
        ),
        "reconciled_through_at": value["reconciled_through_at"],
        "evidence_basis": value["evidence_basis"],
        "append_only_log_proof_included": value[
            "append_only_log_proof_included"
        ],
        "query_id": value["query_id"],
        "missing_issued_assignment_count": 0,
        "unmatched_exposure_event_count": 0,
    }


def load_trusted_census_export(
    path: Path,
    protocol: Mapping[str, Any],
    activation_manifest: Mapping[str, Any],
    *,
    evidence: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Verify the signed terminal server export and its complete source census."""

    activation = activation_manifest.get("activation")
    if not isinstance(activation, Mapping):
        raise ValueError("trusted census export requires the root activation manifest")
    envelope, payload, file_digest = _load_signed_private_payload(
        path,
        artifact="trusted census export",
        schema_version="castingcompass.validation-census-export/1.0.0",
        expected_fields=CENSUS_EXPORT_FIELDS,
        activation=activation,
    )
    _require_exact_keys(payload, CENSUS_PAYLOAD_FIELDS, location="trusted census payload")
    if (
        payload.get("protocol_id") != protocol["protocol_id"]
        or payload.get("protocol_version") != protocol["protocol_version"]
        or payload.get("activation_manifest_sha256") != canonical_sha256(activation_manifest)
        or payload.get("query_id") != protocol["recruitment"]["trusted_export_query_id"]
        or payload.get("enrollment_start_at") != protocol["enrollment"]["start_at"]
        or payload.get("enrollment_end_at") != protocol["enrollment"]["end_at"]
    ):
        raise ValueError("trusted census export protocol/query identity is invalid")
    generated = _parse_datetime(payload.get("generated_at"), location="census.generated_at")
    watermark_start = _parse_datetime(
        payload.get("query_watermark_start_at"), location="census.query_watermark_start_at"
    )
    watermark_end = _parse_datetime(
        payload.get("query_watermark_end_at"), location="census.query_watermark_end_at"
    )
    enrollment_start = _parse_datetime(protocol["enrollment"]["start_at"], location="enrollment.start_at")
    enrollment_end = _parse_datetime(protocol["enrollment"]["end_at"], location="enrollment.end_at")
    if (
        watermark_start != enrollment_start
        or watermark_end != enrollment_end
        or generated < enrollment_end
        or generated > trusted_utc_now()
    ):
        raise ValueError("trusted census export is not the terminal fixed-interval query")
    if payload.get("eligible_omissions") != []:
        raise ValueError("trusted census export cannot omit an eligible source")
    records = payload.get("records")
    if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
        raise ValueError("trusted census records must be an object array")
    eligible_count = payload.get("eligible_source_count")
    if isinstance(eligible_count, bool) or not isinstance(eligible_count, int) or eligible_count != len(records):
        raise ValueError("trusted census eligible-source count is inconsistent")
    sequences: list[int] = []
    seen_ids: set[str] = set()
    seen_sources: set[str] = set()
    signed_rows: list[Mapping[str, Any]] = []
    for index, record in enumerate(records):
        _require_exact_keys(record, CENSUS_RECORD_FIELDS, location=f"census.records[{index}]")
        sequence = record.get("export_ordinal")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
            raise ValueError("trusted census export ordinal is invalid")
        sequences.append(sequence)
        signed_row = record.get("label_free_evidence")
        if not isinstance(signed_row, dict):
            raise ValueError("trusted census label-free row is invalid")
        _require_exact_keys(
            signed_row,
            LABEL_FREE_EVIDENCE_TOP_LEVEL_FIELDS,
            location=f"census.records[{index}].label_free_evidence",
        )
        _reject_forbidden_fields(signed_row, location=f"census.records[{index}].label_free_evidence")
        assignment_id = signed_row.get("assignment_id")
        source_digest = signed_row.get("source_record_sha256")
        if not isinstance(assignment_id, str) or ASSIGNMENT_PATTERN.fullmatch(assignment_id) is None:
            raise ValueError("trusted census assignment ID is invalid")
        if not isinstance(source_digest, str) or SHA256_PATTERN.fullmatch(source_digest) is None:
            raise ValueError("trusted census source digest is invalid")
        if assignment_id in seen_ids or source_digest in seen_sources:
            raise ValueError("trusted census contains duplicate source lineage")
        seen_ids.add(assignment_id)
        seen_sources.add(source_digest)
        signed_rows.append(signed_row)
        if signed_row.get("cohort_role") not in {"primary", "secondary", "exploratory", "quarantined"}:
            raise ValueError("trusted census cohort status is invalid")
        if signed_row.get("source_role") not in {
            "prospective-first-party", "score-visible-first-party", "retrospective-first-party", "official-context"
        }:
            raise ValueError("trusted census source role is invalid")
        if not isinstance(signed_row.get("opportunity_score"), int) or isinstance(signed_row.get("opportunity_score"), bool) or not (0 <= signed_row["opportunity_score"] <= 100):
            raise ValueError("trusted census score is invalid")
        evidence_identity = signed_row.get("evidence", {})
        issued = evidence_identity.get("prospective_assignment_issued") is True
        required_hash_fields = (
            "scoring_system_sha256",
            "snapshot_sha256",
            "impression_attestation_sha256",
            "completion_event_sha256",
        ) if issued else ("collection_provenance_chain_sha256",)
        for field in required_hash_fields:
            field_value = evidence_identity.get(field)
            if (
                not isinstance(field_value, str)
                or SHA256_PATTERN.fullmatch(field_value) is None
            ):
                raise ValueError(f"trusted census {field} is invalid")
        if not issued and any(
            evidence_identity.get(field) is not None
            for field in (
                "activation_manifest_sha256",
                "impression_attestation_sha256",
                "score_exposure_attestation_sha256",
            )
        ):
            raise ValueError("trusted census context row contains prospective identity")
        completion_raw = evidence_identity.get("completion_event_at")
        completion_digest = evidence_identity.get("completion_event_sha256")
        if (completion_raw is None) != (completion_digest is None):
            raise ValueError("trusted census completion time/hash is partial")
        if completion_raw is not None:
            completion_at = _parse_datetime(
                completion_raw,
                location=f"census.records[{index}].completion_event_at",
            )
            if completion_at > generated or completion_at >= watermark_end:
                raise ValueError(
                    "trusted census contains a completion after its generation/query watermark"
                )
    if sequences != list(range(1, len(records) + 1)):
        raise ValueError("trusted census export ordinal is not complete and consecutive")
    expected_first_sequence = 1 if records else None
    expected_last_sequence = len(records) if records else None
    supplied_first_sequence = payload.get("first_export_ordinal")
    supplied_last_sequence = payload.get("last_export_ordinal")
    if (
        (
            supplied_first_sequence is not None
            and not _is_nonnegative_int(supplied_first_sequence)
        )
        or (
            supplied_last_sequence is not None
            and not _is_nonnegative_int(supplied_last_sequence)
        )
        or supplied_first_sequence != expected_first_sequence
        or supplied_last_sequence != expected_last_sequence
    ):
        raise ValueError("trusted census sequence watermarks are inconsistent")
    expected_status_counts = {
        role: sum(row["cohort_role"] == role for row in signed_rows)
        for role in ("primary", "secondary", "exploratory", "quarantined")
    }
    supplied_status_counts = payload.get("status_counts")
    if (
        not _is_nonnegative_int_map(
            supplied_status_counts, expected_keys=set(expected_status_counts)
        )
        or supplied_status_counts != expected_status_counts
    ):
        raise ValueError("trusted census per-status counts are inconsistent")
    recruitment_sources = [*protocol["recruitment"]["allowed_source_ids"], "not-applicable"]
    expected_source_counts = {
        source: sum(
            (row["evidence"].get("recruitment_source_id") or "not-applicable") == source
            for row in signed_rows
        )
        for source in recruitment_sources
    }
    supplied_source_counts = payload.get("recruitment_source_counts")
    if (
        not _is_nonnegative_int_map(
            supplied_source_counts, expected_keys=set(expected_source_counts)
        )
        or supplied_source_counts != expected_source_counts
    ):
        raise ValueError("trusted census per-source counts are inconsistent")
    if evidence is None:
        raise ValueError("trusted census verification requires sealed label-free evidence")
    by_id = {str(item["assignment_id"]): item for item in evidence}
    if set(by_id) != seen_ids:
        raise ValueError("trusted census does not exactly cover sealed evidence")
    for record in records:
        signed_row = record["label_free_evidence"]
        item = by_id[str(signed_row["assignment_id"])]
        if canonical_json_bytes(dict(signed_row)) != canonical_json_bytes(
            label_free_export_projection(item, protocol)
        ):
            raise ValueError(f"trusted census row differs from sealed evidence: {item['assignment_id']}")
    issuance_reconciliation = _validate_issuance_reconciliation(
        payload.get("issuance_reconciliation"),
        evidence=evidence,
        protocol=protocol,
        activation_manifest=activation_manifest,
        generated_at=generated,
    )
    return {
        "envelope": envelope,
        "payload": payload,
        "file_sha256": file_digest,
        "canonical_sha256": canonical_sha256(envelope),
        "completion_event_set_sha256": canonical_sha256(
            sorted(
                (
                    {
                        "assignment_id": record["label_free_evidence"][
                            "assignment_id"
                        ],
                        "completion_event_sha256": record["label_free_evidence"][
                            "evidence"
                        ]["completion_event_sha256"],
                    }
                    for record in records
                    if record["label_free_evidence"]["evidence"][
                        "completion_event_sha256"
                    ]
                    is not None
                ),
                key=lambda item: item["assignment_id"],
            )
        ),
        "issuance_reconciliation": issuance_reconciliation,
    }


def _load_signed_private_payload(
    path: Path,
    *,
    artifact: str,
    schema_version: str,
    expected_fields: set[str],
    activation: Mapping[str, Any],
    allow_outcomes: bool = False,
    raw_envelope_bytes: bytes | None = None,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    held_bytes = (
        raw_envelope_bytes
        if raw_envelope_bytes is not None
        else read_private_bytes_once(path, artifact=artifact)
    )
    try:
        envelope = strict_json_loads(held_bytes, artifact=artifact)
    except ValueError as exc:
        raise ValueError(f"could not load {artifact} JSON") from exc
    if not isinstance(envelope, dict):
        raise ValueError(f"{artifact} must be a JSON object")
    _reject_forbidden_fields(envelope, location=artifact)
    _require_exact_keys(envelope, expected_fields, location=artifact)
    if envelope.get("schema_version") != schema_version:
        raise ValueError(f"{artifact} schema version is unsupported")
    if envelope.get("signing_key_id") != activation.get("validation_export_signing_key_id"):
        raise ValueError(f"{artifact} signing key differs from activation")
    payload_bytes = _decode_canonical_base64(
        envelope.get("payload_base64"), location=f"{artifact} payload"
    )
    if hashlib.sha256(payload_bytes).hexdigest() != envelope.get("payload_sha256"):
        raise ValueError(f"{artifact} payload SHA-256 is invalid")
    signature = _decode_canonical_base64(
        envelope.get("signature_ed25519"),
        location=f"{artifact} signature",
        expected_length=64,
    )
    public_key = _decode_ed25519_public_key(
        activation.get("validation_export_public_key_ed25519"),
        location="activation.validation_export_public_key_ed25519",
    )
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, payload_bytes)
    except InvalidSignature as exc:
        raise ValueError(f"{artifact} signature is invalid") from exc
    try:
        payload = strict_json_loads(
            payload_bytes, artifact=f"{artifact} payload", reject_floats=True
        )
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError(f"{artifact} payload is invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{artifact} payload must be an object")
    if canonical_json_bytes(payload) != payload_bytes:
        raise ValueError(f"{artifact} payload is not canonical JSON")
    _reject_forbidden_fields(payload, location=artifact)
    serialized = payload_bytes.decode("utf-8")
    if not allow_outcomes and any(field in serialized for field in ('"outcome_class"', '"target_encounter_count"', '"target_encountered"')):
        raise ValueError(f"{artifact} must remain label-free")
    return envelope, payload, hashlib.sha256(held_bytes).hexdigest()


def load_deletion_reconciliation_chain(
    paths: Sequence[Path],
    protocol: Mapping[str, Any],
    activation_manifest: Mapping[str, Any],
    finalization_manifest: Mapping[str, Any],
    manifest_chain: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Verify signed cumulative post-seal withdrawal/deletion/exclusion snapshots."""

    if not paths:
        raise ValueError("a signed deletion reconciliation chain is required")
    activation = activation_manifest["activation"]
    assignment_pairs = [
        {
            "assignment_id": item["assignment_id"],
            "source_record_sha256": item["source_record_sha256"],
        }
        for item in finalization_manifest["assignments"]
    ]
    assignment_set_sha = canonical_sha256(assignment_pairs)
    assignment_by_id = {
        str(item["assignment_id"]): str(item["source_record_sha256"])
        for item in assignment_pairs
    }
    first_sealed_at: dict[str, datetime] = {}
    if manifest_chain is None:
        raise ValueError(
            "deletion reconciliation requires the complete manifest chain for first-seal chronology"
        )
    if (
        not manifest_chain
        or canonical_sha256(manifest_chain[0])
        != canonical_sha256(activation_manifest)
        or canonical_sha256(manifest_chain[-1])
        != canonical_sha256(finalization_manifest)
    ):
        raise ValueError(
            "deletion reconciliation manifest chain root/tip binding is invalid"
        )
    expected_roles = {0: "activation", len(manifest_chain) - 1: "finalization"}
    previous_manifest: Mapping[str, Any] | None = None
    previous_assignments: list[Mapping[str, Any]] = []
    for manifest in manifest_chain:
        manifest_sequence = manifest.get("sequence")
        if (
            isinstance(manifest_sequence, bool)
            or not isinstance(manifest_sequence, int)
            or manifest_sequence
            != (0 if previous_manifest is None else previous_manifest["sequence"] + 1)
            or manifest.get("manifest_role")
            != expected_roles.get(
                manifest_sequence,
                "assignment-batch",
            )
            or manifest.get("previous_manifest_sha256")
            != (
                None
                if previous_manifest is None
                else canonical_sha256(previous_manifest)
            )
        ):
            raise ValueError(
                "deletion reconciliation manifest chain sequence/role/hash is invalid"
            )
        assignments = manifest.get("assignments")
        if not isinstance(assignments, list) or not all(
            isinstance(assignment, Mapping) for assignment in assignments
        ):
            raise ValueError("deletion reconciliation manifest assignments are invalid")
        if previous_manifest is not None:
            if manifest["manifest_role"] == "assignment-batch":
                if (
                    len(assignments) <= len(previous_assignments)
                    or canonical_json_bytes(assignments[: len(previous_assignments)])
                    != canonical_json_bytes(previous_assignments)
                ):
                    raise ValueError(
                        "deletion reconciliation manifest assignment prefix changed"
                    )
            elif canonical_json_bytes(assignments) != canonical_json_bytes(
                previous_assignments
            ):
                raise ValueError(
                    "deletion reconciliation finalization assignments changed"
                )
        sealed_at = _parse_datetime(
            manifest["created_at"], location="manifest.created_at"
        )
        if previous_manifest is not None and sealed_at <= _parse_datetime(
            previous_manifest["created_at"], location="manifest.created_at"
        ):
            raise ValueError(
                "deletion reconciliation manifest chronology did not advance"
            )
        for assignment in assignments:
            first_sealed_at.setdefault(str(assignment["assignment_id"]), sealed_at)
        previous_manifest = manifest
        previous_assignments = assignments
    if set(first_sealed_at) != set(assignment_by_id):
        raise ValueError(
            "complete manifest chain does not cover every finalized assignment"
        )
    previous_envelope: dict[str, Any] | None = None
    previous_events: list[Mapping[str, Any]] = []
    envelopes: list[dict[str, Any]] = []
    payloads: list[dict[str, Any]] = []
    seen_event_ids: set[str] = set()
    removed_status: dict[str, str] = {}
    first_removal_status: dict[str, str] = {}
    first_removal_reason: dict[str, str] = {}
    ever_excluded_assignment_ids: set[str] = set()
    previous_created: datetime | None = None
    previous_reconciled: datetime | None = None
    finalization_created = _parse_datetime(
        finalization_manifest["created_at"], location="finalization.created_at"
    )
    for index, path in enumerate(paths):
        envelope, payload, file_digest = _load_signed_private_payload(
            path,
            artifact=f"deletion reconciliation ledger[{index}]",
            schema_version="castingcompass.validation-deletion-reconciliation/1.0.0",
            expected_fields=DELETION_LEDGER_FIELDS,
            activation=activation,
        )
        _require_exact_keys(payload, DELETION_LEDGER_PAYLOAD_FIELDS, location=f"deletion ledger payload[{index}]")
        if (
            payload.get("protocol_id") != protocol["protocol_id"]
            or payload.get("protocol_version") != protocol["protocol_version"]
            or payload.get("activation_manifest_sha256") != canonical_sha256(activation_manifest)
            or payload.get("finalization_manifest_sha256") != canonical_sha256(finalization_manifest)
            or payload.get("sealed_assignment_set_sha256") != assignment_set_sha
            or isinstance(payload.get("sequence"), bool)
            or not isinstance(payload.get("sequence"), int)
            or payload.get("sequence") != index
        ):
            raise ValueError("deletion reconciliation ledger binding is invalid")
        expected_previous = canonical_sha256(previous_envelope) if previous_envelope is not None else None
        if payload.get("previous_ledger_sha256") != expected_previous:
            raise ValueError("deletion reconciliation ledger predecessor hash is broken")
        if not _is_stable_id(payload.get("ledger_id")):
            raise ValueError("deletion reconciliation ledger ID is invalid")
        created = _parse_datetime(payload.get("created_at"), location="deletion.created_at")
        reconciled = _parse_datetime(
            payload.get("reconciled_through_at"), location="deletion.reconciled_through_at"
        )
        if created < finalization_created or reconciled < finalization_created or reconciled > created or created > trusted_utc_now():
            raise ValueError("deletion reconciliation chronology is invalid")
        if previous_created is not None and (
            created <= previous_created
            or previous_reconciled is None
            or reconciled <= previous_reconciled
        ):
            raise ValueError("deletion reconciliation chronology regressed or did not advance")
        events = payload.get("events")
        if not isinstance(events, list) or not all(isinstance(event, dict) for event in events):
            raise ValueError("deletion reconciliation events must be an object array")
        if events[: len(previous_events)] != previous_events:
            raise ValueError("deletion reconciliation chain changed a prior event")
        event_order = [
            (
                _parse_datetime(
                    event.get("occurred_at"), location="deletion.event.occurred_at"
                ),
                str(event.get("event_id")),
            )
            for event in events
        ]
        if event_order != sorted(event_order):
            raise ValueError("deletion reconciliation events are not chronologically ordered")
        snapshot_source_event_hashes: set[str] = set()
        for event_index, event in enumerate(events):
            _require_exact_keys(
                event,
                DELETION_EVENT_FIELDS,
                location=f"deletion.events[{event_index}]",
            )
            event_id = event.get("event_id")
            assignment_id = event.get("assignment_id")
            if not _is_stable_id(event_id) or event_id in seen_event_ids:
                if event_index >= len(previous_events):
                    raise ValueError("deletion reconciliation event ID is invalid or duplicated")
            if assignment_id not in assignment_by_id or event.get("source_record_sha256") != assignment_by_id.get(str(assignment_id)):
                raise ValueError("deletion reconciliation references an unknown sealed assignment")
            allowed_reasons = {
                "withdrawn": {"participant-withdrawal"},
                "deleted": {"account-deletion"},
                "excluded": {
                    "post_completion_profile_edit",
                    "trusted_review_exclusion",
                },
            }.get(str(event.get("status")))
            if allowed_reasons is None or event.get("reason") not in allowed_reasons:
                raise ValueError("deletion reconciliation reason/status is not permitted")
            occurred = _parse_datetime(event.get("occurred_at"), location="deletion.event.occurred_at")
            earliest = first_sealed_at[str(assignment_id)]
            if occurred <= earliest or occurred > reconciled:
                raise ValueError("deletion event is not after its assignment seal or before reconciliation")
            if (
                event_index >= len(previous_events)
                and previous_reconciled is not None
                and occurred <= previous_reconciled
            ):
                raise ValueError(
                    "new deletion event predates or equals the predecessor reconciliation watermark"
                )
            source_event_sha = event.get("source_event_sha256")
            if (
                not isinstance(source_event_sha, str)
                or SHA256_PATTERN.fullmatch(source_event_sha) is None
                or source_event_sha in snapshot_source_event_hashes
            ):
                raise ValueError("deletion source event SHA-256 is invalid")
            snapshot_source_event_hashes.add(source_event_sha)
            if event_index >= len(previous_events):
                previous_status = removed_status.get(str(assignment_id))
                next_status = str(event["status"])
                if previous_status is not None and not (
                    (
                        previous_status == "excluded"
                        and next_status in {"excluded", "withdrawn", "deleted"}
                    )
                    or (
                        previous_status == "withdrawn"
                        and next_status in {"withdrawn", "deleted"}
                    )
                ):
                    raise ValueError("removed assignment status transition is not monotone")
                seen_event_ids.add(str(event_id))
                normalized_assignment_id = str(assignment_id)
                first_removal_status.setdefault(normalized_assignment_id, next_status)
                first_removal_reason.setdefault(
                    normalized_assignment_id, str(event["reason"])
                )
                if next_status == "excluded":
                    ever_excluded_assignment_ids.add(normalized_assignment_id)
                removed_status[normalized_assignment_id] = next_status
        previous_envelope = envelope
        previous_events = list(events)
        previous_created = created
        previous_reconciled = reconciled
        envelopes.append(envelope)
        payloads.append(payload)
        if index == len(paths) - 1:
            final_file_digest = file_digest
    final_envelope = envelopes[-1]
    final_payload = payloads[-1]
    return {
        "envelope": final_envelope,
        "payload": final_payload,
        "ledger_sha256": canonical_sha256(final_envelope),
        "ledger_file_sha256": final_file_digest,
        "chain_sha256": canonical_sha256([canonical_sha256(item) for item in envelopes]),
        "removed_status": removed_status,
        "first_removal_status": first_removal_status,
        "first_removal_reason": first_removal_reason,
        "ever_excluded_assignment_ids": sorted(ever_excluded_assignment_ids),
        "active_assignment_ids": sorted(set(assignment_by_id) - set(removed_status)),
        "counts": {
            "active": len(assignment_by_id) - len(removed_status),
            "withdrawn": sum(status == "withdrawn" for status in removed_status.values()),
            "deleted": sum(status == "deleted" for status in removed_status.values()),
            "excluded": sum(status == "excluded" for status in removed_status.values()),
        },
    }


def load_signed_labeled_export(
    path: Path,
    protocol: Mapping[str, Any],
    activation_manifest: Mapping[str, Any],
    finalization_manifest: Mapping[str, Any],
    deletion_reconciliation: Mapping[str, Any],
    label_lock: Mapping[str, Any],
    *,
    raw_envelope_bytes: bytes,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Verify the server-signed active-row labeled export before parsing labels."""

    envelope, payload, file_digest = _load_signed_private_payload(
        path,
        artifact="signed labeled export",
        schema_version="castingcompass.validation-labeled-export/1.0.0",
        expected_fields=LABELED_EXPORT_FIELDS,
        activation=activation_manifest["activation"],
        allow_outcomes=True,
        raw_envelope_bytes=raw_envelope_bytes,
    )
    _require_exact_keys(payload, LABELED_EXPORT_PAYLOAD_FIELDS, location="labeled export payload")
    if (
        payload.get("protocol_id") != protocol["protocol_id"]
        or payload.get("protocol_version") != protocol["protocol_version"]
        or payload.get("activation_manifest_sha256") != canonical_sha256(activation_manifest)
        or payload.get("finalization_manifest_sha256") != canonical_sha256(finalization_manifest)
        or payload.get("deletion_reconciliation_sha256")
        != deletion_reconciliation["ledger_sha256"]
        or payload.get("label_lock_manifest_sha256")
        != canonical_sha256(label_lock)
    ):
        raise ValueError("signed labeled export binding is invalid")
    generated = _parse_datetime(payload.get("generated_at"), location="labeled.generated_at")
    reconciled = _parse_datetime(
        deletion_reconciliation["payload"]["reconciled_through_at"],
        location="deletion.reconciled_through_at",
    )
    labels_opened = _parse_datetime(
        label_lock.get("labels_opened_at"), location="label_lock.labels_opened_at"
    )
    if generated < reconciled or generated < labels_opened or generated > trusted_utc_now():
        raise ValueError("signed labeled export chronology is invalid")
    records = payload.get("records")
    if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
        raise ValueError("signed labeled export records must be an object array")
    labeled = load_validation_evidence(
        path,
        protocol,
        include_outcomes=True,
        activated_at=str(activation_manifest["activated_at"]),
        activation_manifest_sha256=canonical_sha256(activation_manifest),
        activation=activation_manifest["activation"],
        _records=records,
    )
    labeled_assignment_ids = sorted(str(item["assignment_id"]) for item in labeled)
    if labeled_assignment_ids != deletion_reconciliation["active_assignment_ids"]:
        raise ValueError(
            "signed labeled export does not exactly cover the reconciled active assignment set"
        )
    finalization_assignments = {
        str(item["assignment_id"]): item
        for item in finalization_manifest["assignments"]
    }
    for item in labeled:
        assignment_id = str(item["assignment_id"])
        expected_assignment = finalization_assignments.get(assignment_id)
        if expected_assignment is None or canonical_json_bytes(
            _assignment_projection(item, protocol)
        ) != canonical_json_bytes(expected_assignment):
            raise ValueError(
                "signed labeled export row differs from its sealed finalization assignment"
            )
    return labeled, {
        "envelope": envelope,
        "payload": payload,
        "canonical_sha256": canonical_sha256(envelope),
        "payload_sha256": envelope["payload_sha256"],
        "file_sha256": file_digest,
    }


def load_publication_reconciliation_audit(
    path: Path,
    protocol: Mapping[str, Any],
    activation_manifest: Mapping[str, Any],
    finalization_manifest: Mapping[str, Any],
    deletion_reconciliation: Mapping[str, Any],
    label_lock: Mapping[str, Any],
    label_access_receipt: Mapping[str, Any],
    analysis_result_sha256: str,
    publication_request: Mapping[str, Any],
) -> dict[str, Any]:
    """Verify the final signed no-new-deletion check that authorizes publication."""

    envelope, payload, file_digest = _load_signed_private_payload(
        path,
        artifact="publication reconciliation audit",
        schema_version="castingcompass.validation-publication-audit/1.0.0",
        expected_fields=PUBLICATION_AUDIT_FIELDS,
        activation=activation_manifest["activation"],
    )
    _require_exact_keys(
        payload,
        PUBLICATION_AUDIT_PAYLOAD_FIELDS,
        location="publication audit payload",
    )
    reconciliation_counts = payload.get("reconciliation_counts")
    if (
        payload.get("independent_recomputation_completed") is not True
        or payload.get("append_only_log_proof_included") is not True
        or not _is_nonnegative_int_map(
            reconciliation_counts,
            expected_keys={"active", "withdrawn", "deleted", "excluded"},
        )
    ):
        raise ValueError("publication audit proof/count types are invalid")
    active_ids_sha = canonical_sha256(deletion_reconciliation["active_assignment_ids"])
    expected_bindings = {
        "protocol_id": protocol["protocol_id"],
        "protocol_version": protocol["protocol_version"],
        "activation_manifest_sha256": canonical_sha256(activation_manifest),
        "finalization_manifest_sha256": canonical_sha256(finalization_manifest),
        "deletion_reconciliation_sha256": deletion_reconciliation["ledger_sha256"],
        "deletion_reconciliation_chain_sha256": deletion_reconciliation["chain_sha256"],
        "label_lock_manifest_sha256": canonical_sha256(label_lock),
        "label_access_receipt_sha256": canonical_sha256(label_access_receipt),
        "analysis_result_sha256": analysis_result_sha256,
        "evaluator_identity_sha256": canonical_sha256(
            finalization_manifest["finalization"]["evaluator_identity"]
        ),
        "runtime_image_digest": finalization_manifest["finalization"][
            "evaluator_identity"
        ]["runtime_image_digest"],
        "publication_request_nonce": publication_request[
            "publication_request_nonce"
        ],
        "publication_request_sha256": canonical_sha256(publication_request),
        "independent_recomputation_completed": True,
        "recomputed_analysis_result_sha256": analysis_result_sha256,
        "active_assignment_ids_sha256": active_ids_sha,
        "reconciliation_counts": deletion_reconciliation["counts"],
        "issuance_reconciliation_sha256": canonical_sha256(
            finalization_manifest["finalization"]["issuance_reconciliation"]
        ),
        "append_only_log_proof_included": finalization_manifest["finalization"][
            "issuance_reconciliation"
        ]["append_only_log_proof_included"],
    }
    if any(payload.get(key) != value for key, value in expected_bindings.items()):
        raise ValueError("publication audit does not bind this exact result/reconciliation state")
    execution_attestation = payload.get("trusted_execution_attestation_sha256")
    if (
        not isinstance(execution_attestation, str)
        or SHA256_PATTERN.fullmatch(execution_attestation) is None
    ):
        raise ValueError("publication audit lacks trusted independent-execution attestation")
    trusted_publication_nonce = payload.get("trusted_publication_nonce")
    production_artifact_sha = payload.get("production_artifact_sha256")
    publication_service_attestation = payload.get(
        "trusted_publication_service_attestation_sha256"
    )
    if (
        not isinstance(trusted_publication_nonce, str)
        or len(trusted_publication_nonce) != 64
        or any(
            character not in "0123456789abcdef"
            for character in trusted_publication_nonce
        )
        or payload.get(
            "atomic_reconciliation_nonce_consumption_and_publication_completed"
        )
        is not True
        or not isinstance(production_artifact_sha, str)
        or SHA256_PATTERN.fullmatch(production_artifact_sha) is None
        or not isinstance(publication_service_attestation, str)
        or SHA256_PATTERN.fullmatch(publication_service_attestation) is None
    ):
        raise ValueError(
            "publication audit lacks trusted atomic single-use publication attestation"
        )
    checked = _parse_datetime(payload.get("checked_at"), location="publication.checked_at")
    reconciled = _parse_datetime(
        payload.get("reconciled_through_at"), location="publication.reconciled_through_at"
    )
    labels_opened = _parse_datetime(label_lock["labels_opened_at"], location="labels_opened_at")
    prior_reconciled = _parse_datetime(
        deletion_reconciliation["payload"]["reconciled_through_at"],
        location="deletion.reconciled_through_at",
    )
    requested = _parse_datetime(
        publication_request.get("requested_at"),
        location="publication_request.requested_at",
    )
    now = trusted_utc_now()
    maximum_age = timedelta(seconds=PUBLICATION_AUDIT_MAX_AGE_SECONDS)
    nonce_issued = _parse_datetime(
        payload.get("trusted_publication_nonce_issued_at"),
        location="publication.trusted_publication_nonce_issued_at",
    )
    nonce_consumed = _parse_datetime(
        payload.get("trusted_publication_nonce_consumed_at"),
        location="publication.trusted_publication_nonce_consumed_at",
    )
    if (
        checked != reconciled
        or checked < labels_opened
        or checked < prior_reconciled
        or checked < requested
        or checked - requested > maximum_age
        or checked > now
        or nonce_issued < requested
        or nonce_issued > nonce_consumed
        or nonce_consumed != checked
        or nonce_consumed - nonce_issued > maximum_age
    ):
        raise ValueError("publication reconciliation audit chronology is invalid")
    return {
        "envelope": envelope,
        "payload": payload,
        "canonical_sha256": canonical_sha256(envelope),
        "file_sha256": file_digest,
    }


def _expected_split(assignment: Mapping[str, Any], protocol: Mapping[str, Any]) -> str:
    role = assignment.get("cohort_role")
    block = assignment.get("temporal_block")
    if role == "primary":
        return (
            "baseline-development"
            if block in protocol["temporal_design"]["development_blocks"]
            else "locked-test"
        )
    return {
        "secondary": "observational-secondary",
        "exploratory": "exploratory",
        "quarantined": "quarantined",
    }.get(str(role), "")


def _validate_activation(value: Any, protocol: Mapping[str, Any], *, location: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{location} must be an object")
    _require_exact_keys(value, ACTIVATION_FIELDS, location=location)
    if re.fullmatch(r"[a-f0-9]{40}", str(value.get("release_commit", ""))) is None:
        raise ValueError(f"{location}.release_commit must be a full Git commit")
    if value.get("scoring_system_kind") != protocol["candidate"]["kind"]:
        raise ValueError(f"{location}.scoring_system_kind does not match the candidate")
    version = value.get("scoring_system_version")
    digest = value.get("scoring_system_sha256")
    if not isinstance(digest, str) or SHA256_PATTERN.fullmatch(digest) is None:
        raise ValueError(f"{location}.scoring_system_sha256 is invalid")
    if version != f"heuristic-{PRODUCTION_TARGET_TAXON_ID}-{digest}":
        raise ValueError(f"{location} has an incoherent heuristic scoring identity")
    if value.get("opportunity_contract_version") != OPPORTUNITY_CONTRACT_VERSION:
        raise ValueError(f"{location}.opportunity_contract_version changed")
    if not _is_stable_id(value.get("validation_export_signing_key_id")):
        raise ValueError(f"{location}.validation_export_signing_key_id is invalid")
    export_public_key = _decode_ed25519_public_key(
        value.get("validation_export_public_key_ed25519"),
        location=f"{location}.validation_export_public_key_ed25519",
    )
    if not _is_stable_id(value.get("external_log_anchor_provider_id")):
        raise ValueError(f"{location}.external_log_anchor_provider_id is invalid")
    if not _is_stable_id(value.get("external_log_anchor_signing_key_id")):
        raise ValueError(f"{location}.external_log_anchor_signing_key_id is invalid")
    anchor_public_key = _decode_ed25519_public_key(
        value.get("external_log_anchor_public_key_ed25519"),
        location=f"{location}.external_log_anchor_public_key_ed25519",
    )
    if (
        value.get("external_log_anchor_signing_key_id")
        == value.get("validation_export_signing_key_id")
        or anchor_public_key == export_public_key
    ):
        raise ValueError(f"{location} external log anchor must differ from exporter")
    if value.get("deployed_before_first_eligible_row") is not True:
        raise ValueError(f"{location} was not deployed before eligible evidence")


def _validate_finalization_issuance_reconciliation_shape(
    value: Any, protocol: Mapping[str, Any], *, location: str
) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{location} must be an object")
    _require_exact_keys(
        value, FINALIZATION_ISSUANCE_RECONCILIATION_FIELDS, location=location
    )
    if (
        value.get("evidence_basis")
        != "signed-exporter-assertion-without-raw-ledger-proof"
        or value.get("append_only_log_proof_included") is not False
        or value.get("query_id")
        != protocol["recruitment"]["issuance_reconciliation_query_id"]
    ):
        raise ValueError(f"{location} overstates its reconciliation evidence")
    _parse_datetime(
        value.get("reconciled_through_at"),
        location=f"{location}.reconciled_through_at",
    )
    integer_fields = (
        "issued_assignment_count",
        "signed_primary_exposure_event_count",
        "missing_issued_assignment_count",
        "unmatched_exposure_event_count",
    )
    if any(
        isinstance(value.get(field), bool)
        or not isinstance(value.get(field), int)
        or int(value[field]) < 0
        for field in integer_fields
    ):
        raise ValueError(f"{location} counts are invalid")
    if (
        value["missing_issued_assignment_count"] != 0
        or value["unmatched_exposure_event_count"] != 0
    ):
        raise ValueError(f"{location} has missing or unmatched events")
    for field in (
        "issued_assignment_set_sha256",
        "signed_primary_exposure_event_set_sha256",
        "terminal_disposition_set_sha256",
    ):
        field_value = value.get(field)
        if (
            not isinstance(field_value, str)
            or SHA256_PATTERN.fullmatch(field_value) is None
        ):
            raise ValueError(f"{location}.{field} is invalid")
    disposition_counts = value.get("terminal_disposition_counts")
    if (
        not isinstance(disposition_counts, dict)
        or set(disposition_counts) != set(ISSUANCE_DISPOSITION_STATUSES)
        or any(
            isinstance(count, bool) or not isinstance(count, int) or count < 0
            for count in disposition_counts.values()
        )
        or sum(disposition_counts.values()) != value["issued_assignment_count"]
    ):
        raise ValueError(f"{location}.terminal_disposition_counts is invalid")
    transition_keys = {
        f"{intended}->{final}"
        for intended in ("primary", "secondary")
        for final in ("primary", "secondary", "unsealed")
    }
    transitions = value.get("intended_to_final_disposition_counts")
    if (
        not isinstance(transitions, dict)
        or set(transitions) != transition_keys
        or any(
            isinstance(count, bool) or not isinstance(count, int) or count < 0
            for count in transitions.values()
        )
        or sum(transitions.values()) != value["issued_assignment_count"]
        or transitions["primary->secondary"] != 0
        or transitions["secondary->primary"] != 0
    ):
        raise ValueError(f"{location} intended-to-final counts are invalid")
    for field, stream_id, expected_count in (
        (
            "issuance_stream",
            protocol["recruitment"]["issuance_stream_id"],
            value["issued_assignment_count"],
        ),
        (
            "signed_primary_exposure_stream",
            protocol["recruitment"]["exposure_stream_id"],
            value["signed_primary_exposure_event_count"],
        ),
    ):
        stream = value.get(field)
        if not isinstance(stream, dict):
            raise ValueError(f"{location}.{field} is invalid")
        _require_exact_keys(
            stream, RECONCILIATION_STREAM_FIELDS, location=f"{location}.{field}"
        )
        count = stream.get("event_count")
        first = stream.get("first_sequence")
        last = stream.get("last_sequence")
        if (
            stream.get("stream_id") != stream_id
            or isinstance(count, bool)
            or not isinstance(count, int)
            or count != expected_count
            or (count == 0 and (first is not None or last is not None))
            or (
                count > 0
                and (
                    isinstance(first, bool)
                    or isinstance(last, bool)
                    or first != 1
                    or last != count
                )
            )
            or not isinstance(stream.get("event_set_sha256"), str)
            or SHA256_PATTERN.fullmatch(str(stream.get("event_set_sha256")))
            is None
            or stream.get("chain_tip_sha256") is not None
            or stream.get("external_log_proof_sha256") is not None
        ):
            raise ValueError(f"{location}.{field} watermark is invalid")


def _validate_manifest_assignment(
    item: Mapping[str, Any],
    protocol: Mapping[str, Any],
    *,
    location: str,
    activated_at: datetime,
) -> None:
    _require_exact_keys(item, ASSIGNMENT_FIELDS, location=location)
    assignment_id = item.get("assignment_id")
    source_digest = item.get("source_record_sha256")
    participant = item.get("participant_group_id")
    if not isinstance(assignment_id, str) or ASSIGNMENT_PATTERN.fullmatch(assignment_id) is None:
        raise ValueError(f"{location}.assignment_id is invalid")
    if not isinstance(source_digest, str) or SHA256_PATTERN.fullmatch(source_digest) is None:
        raise ValueError(f"{location}.source_record_sha256 is invalid")
    row_digest = item.get("label_free_row_sha256")
    if not isinstance(row_digest, str) or SHA256_PATTERN.fullmatch(row_digest) is None:
        raise ValueError(f"{location}.label_free_row_sha256 is invalid")
    score = item.get("opportunity_score")
    if isinstance(score, bool) or not isinstance(score, int) or not (0 <= score <= 100):
        raise ValueError(f"{location}.opportunity_score must be an integer from 0 to 100")
    if participant is not None and (
        not isinstance(participant, str) or PARTICIPANT_PATTERN.fullmatch(participant) is None
    ):
        raise ValueError(f"{location}.participant_group_id is invalid")
    if item.get("cohort_role") not in {"primary", "secondary", "exploratory", "quarantined"}:
        raise ValueError(f"{location}.cohort_role is invalid")
    if item.get("source_role") not in {
        "prospective-first-party",
        "score-visible-first-party",
        "retrospective-first-party",
        "official-context",
    }:
        raise ValueError(f"{location}.source_role is invalid")
    if item.get("selection_design") not in {
        "prospective-precommitted-without-score",
        "prospective-safely-randomized",
        "prospective-score-visible-self-selected",
        "retrospective-or-context",
    }:
        raise ValueError(f"{location}.selection_design is invalid")
    site_id = item.get("site_id")
    if not isinstance(site_id, str) or protocol_site_panel(protocol, site_id) != item.get("geographic_panel"):
        raise ValueError(f"{location} geographic panel does not match its frozen site")
    block_ids = {block["block_id"] for block in protocol["temporal_design"]["blocks"]}
    if item.get("temporal_block") not in block_ids:
        raise ValueError(f"{location}.temporal_block is invalid")
    if item.get("split") != _expected_split(item, protocol):
        raise ValueError(f"{location}.split disagrees with the frozen split policy")
    if item.get("cohort_role") == "primary" and participant is None:
        raise ValueError(f"{location} primary assignment lacks participant grouping")

    evidence = item.get("evidence")
    if not isinstance(evidence, dict):
        raise ValueError(f"{location}.evidence must be an object")
    _require_exact_keys(evidence, EVIDENCE_OBJECT_FIELDS, location=f"{location}.evidence")
    issued = evidence.get("prospective_assignment_issued")
    if not isinstance(issued, bool):
        raise ValueError(f"{location}.evidence.prospective_assignment_issued is invalid")
    intended_role = evidence.get("intended_cohort_role")
    intended_source = evidence.get("intended_source_role")
    intended_cohort_id = evidence.get("intended_cohort_id")
    intended_method = evidence.get("intended_selection_method")
    method_design = {
        "score_blind_precommitment": "prospective-precommitted-without-score",
        "safe_randomized": "prospective-safely-randomized",
        "organic_score_visible": "prospective-score-visible-self-selected",
    }
    if issued:
        if intended_role not in {"primary", "secondary"}:
            raise ValueError(f"{location} issued assignment lacks intended cohort")
        expected_source = (
            "prospective-first-party"
            if intended_role == "primary"
            else "score-visible-first-party"
        )
        allowed_methods = (
            {"score_blind_precommitment", "safe_randomized"}
            if intended_role == "primary"
            else {"organic_score_visible"}
        )
        if (
            participant is None
            or intended_source != expected_source
            or intended_cohort_id
            != protocol["cohorts"][str(intended_role)]["cohort_id"]
            or intended_method not in allowed_methods
            or item.get("selection_design") != method_design.get(intended_method)
            or item.get("source_role") != intended_source
            or evidence.get("cohort_id") != intended_cohort_id
            or not isinstance(evidence.get("impression_attestation_sha256"), str)
            or SHA256_PATTERN.fullmatch(
                str(evidence.get("impression_attestation_sha256"))
            )
            is None
        ):
            raise ValueError(f"{location} issued assignment intent tuple is inconsistent")
        if item.get("cohort_role") != intended_role:
            raise ValueError(f"{location} final cohort differs from assignment intent")
    elif (
        item.get("cohort_role") in {"primary", "secondary"}
        or any(
            value is not None
            for value in (
                intended_role,
                intended_source,
                intended_cohort_id,
                intended_method,
                evidence.get("impression_attestation_sha256"),
                evidence.get("score_exposure_attestation_sha256"),
            )
        )
    ):
        raise ValueError(f"{location} non-issued assignment contains prospective state")
    if not issued and (
        item.get("source_role")
        not in {"retrospective-first-party", "official-context"}
        or item.get("selection_design") != "retrospective-or-context"
        or evidence.get("score_exposure_disposition") != "not-applicable"
    ):
        raise ValueError(f"{location} non-issued assignment is not context-only")
    expected_prediction = _candidate_prediction_projection(item)
    candidate_digest = item.get("candidate_prediction_sha256")
    if expected_prediction is None:
        if candidate_digest is not None:
            raise ValueError(f"{location} nonprospective assignment has a candidate prediction")
    elif candidate_digest != canonical_sha256(expected_prediction):
        raise ValueError(f"{location} candidate prediction SHA-256 is invalid")
    if evidence.get("selection_design") != item.get("selection_design"):
        raise ValueError(f"{location} selection design fields disagree")
    if evidence.get("site_catalog_sha256") != protocol["geography"]["site_catalog_sha256"]:
        raise ValueError(f"{location} site catalog identity changed")
    if evidence.get("target_taxon_id") != PRODUCTION_TARGET_TAXON_ID:
        raise ValueError(f"{location} target identity changed")
    if evidence.get("exact_coordinates_collected") is not False:
        raise ValueError(f"{location} contains exact-coordinate evidence")
    segment_start = _parse_datetime(
        evidence.get("segment_start_at"), location=f"{location}.evidence.segment_start_at"
    )
    segment_end = _parse_datetime(
        evidence.get("segment_end_at"), location=f"{location}.evidence.segment_end_at"
    )
    if segment_end <= segment_start:
        raise ValueError(f"{location} segment is invalid")
    if protocol_temporal_block(protocol, segment_start, segment_end) != item.get("temporal_block"):
        raise ValueError(f"{location} temporal block does not match its segment")
    if issued and segment_start <= activated_at:
        raise ValueError(f"{location} prospective assignment predates activation")
    if issued:
        recruitment_source = evidence.get("recruitment_source_id")
        recruitment_at = _parse_datetime(
            evidence.get("recruitment_event_at"),
            location=f"{location}.evidence.recruitment_event_at",
        )
        assignment_at = _parse_datetime(
            evidence.get("impression_or_assignment_at"),
            location=f"{location}.evidence.impression_or_assignment_at",
        )
        if (
            evidence.get("recruitment_frame_id") != protocol["recruitment"]["frame_id"]
            or recruitment_source not in set(protocol["recruitment"]["allowed_source_ids"])
            or recruitment_at <= activated_at
            or recruitment_at > assignment_at
        ):
            raise ValueError(f"{location} recruitment provenance is invalid")
        community_approval = evidence.get("community_approval_sha256")
        if recruitment_source == "admin-approved-community-prospective":
            if not isinstance(community_approval, str) or SHA256_PATTERN.fullmatch(community_approval) is None:
                raise ValueError(f"{location} community recruitment approval is invalid")
        elif community_approval is not None:
            raise ValueError(f"{location} non-community recruitment has approval lineage")
        expected_recruitment_digest = canonical_sha256(
            {
                "participant_group_id": participant,
                "recruitment_frame_id": evidence.get("recruitment_frame_id"),
                "recruitment_source_id": recruitment_source,
                "recruitment_event_at": evidence.get("recruitment_event_at"),
                "community_approval_sha256": community_approval,
            }
        )
        if evidence.get("recruitment_event_sha256") != expected_recruitment_digest:
            raise ValueError(f"{location} recruitment event SHA-256 is invalid")
    design = item.get("selection_design")
    precommit_hash = evidence.get("precommitment_event_sha256")
    randomization_values = (
        evidence.get("feasible_set_sha256"),
        evidence.get("feasible_option_count"),
        evidence.get("assignment_probability_numerator"),
        evidence.get("assignment_probability_denominator"),
        evidence.get("randomization_draw_index"),
        evidence.get("randomization_audit_sha256"),
    )
    if design == "prospective-precommitted-without-score":
        if not isinstance(precommit_hash, str) or SHA256_PATTERN.fullmatch(precommit_hash) is None:
            raise ValueError(f"{location} lacks a durable precommitment event")
        if any(value is not None for value in randomization_values):
            raise ValueError(f"{location} precommitment has randomization fields")
    elif design == "prospective-safely-randomized":
        feasible_hash, feasible_count, numerator, denominator, draw_index, audit_hash = randomization_values
        if precommit_hash is not None:
            raise ValueError(f"{location} randomized assignment has a precommit hash")
        if not isinstance(feasible_hash, str) or SHA256_PATTERN.fullmatch(feasible_hash) is None:
            raise ValueError(f"{location} feasible-set hash is invalid")
        if isinstance(feasible_count, bool) or not isinstance(feasible_count, int) or feasible_count < 2:
            raise ValueError(f"{location} feasible option count is invalid")
        if (
            type(numerator) is not int
            or type(denominator) is not int
            or numerator != 1
            or denominator != feasible_count
        ):
            raise ValueError(f"{location} assignment probability is not uniform")
        if isinstance(draw_index, bool) or not isinstance(draw_index, int) or not (0 <= draw_index < feasible_count):
            raise ValueError(f"{location} randomization draw index is invalid")
        if not isinstance(audit_hash, str) or SHA256_PATTERN.fullmatch(audit_hash) is None:
            raise ValueError(f"{location} randomization audit hash is invalid")
    elif precommit_hash is not None or any(value is not None for value in randomization_values):
        raise ValueError(f"{location} non-primary selection has primary-design audit fields")

    if item.get("cohort_role") == "primary":
        if (
            item.get("source_role") != "prospective-first-party"
            or design not in set(protocol["cohorts"]["primary"]["allowed_selection_designs"])
            or evidence.get("observation_contract_status") != "valid"
            or evidence.get("observation_contract_version") != OBSERVATION_CONTRACT_VERSION
            or evidence.get("taxon_catalog_version") != TAXON_CATALOG_VERSION
            or evidence.get("complete_attempt") is not True
            or evidence.get("expanded_estimate") is not False
            or evidence.get("mode") not in protocol["eligibility"]["supported_modes"]
            or evidence.get("opportunity_contract_version") != OPPORTUNITY_CONTRACT_VERSION
            or evidence.get("scoring_system_kind") != protocol["candidate"]["kind"]
            or evidence.get("score_influenced_choice") is not False
            or evidence.get("deletion_status") != "active"
            or evidence.get("angler_count") != int(protocol["eligibility"]["primary_angler_count"])
        ):
            raise ValueError(f"{location} violates primary eligibility")
        window_start = _parse_datetime(
            evidence.get("window_start_at"), location=f"{location}.evidence.window_start_at"
        )
        window_end = _parse_datetime(
            evidence.get("window_end_at"), location=f"{location}.evidence.window_end_at"
        )
        if (
            window_start.microsecond % 1000
            or window_end.microsecond % 1000
            or window_end - window_start
            != timedelta(
                minutes=int(
                    protocol["eligibility"]["authoritative_window_duration_minutes"]
                )
            )
            or segment_start < window_start
            or segment_end > window_end
        ):
            raise ValueError(f"{location} is outside its authoritative two-hour window")
        assignment_time = _parse_datetime(
            evidence.get("impression_or_assignment_at"),
            location=f"{location}.evidence.impression_or_assignment_at",
        )
        consent_time = _parse_datetime(
            evidence.get("study_consent_at"), location=f"{location}.evidence.study_consent_at"
        )
        intent_time = _parse_datetime(
            evidence.get("target_intent_confirmed_at"),
            location=f"{location}.evidence.target_intent_confirmed_at",
        )
        if consent_time > assignment_time or intent_time > assignment_time or assignment_time >= segment_start:
            raise ValueError(f"{location} pre-outcome timestamps are incoherent")
        score_exposed = evidence.get("score_first_exposed_at")
        if score_exposed is not None and _parse_datetime(
            score_exposed, location=f"{location}.evidence.score_first_exposed_at"
        ) <= assignment_time:
            raise ValueError(f"{location} primary score exposure did not follow assignment")
        if score_exposed is not None and _parse_datetime(
            score_exposed, location=f"{location}.evidence.score_first_exposed_at"
        ) >= segment_start:
            raise ValueError(f"{location} primary score exposure did not precede effort")
        scoring_digest = evidence.get("scoring_system_sha256")
        if (
            not isinstance(scoring_digest, str)
            or SHA256_PATTERN.fullmatch(scoring_digest) is None
            or evidence.get("scoring_system_version")
            != f"heuristic-{PRODUCTION_TARGET_TAXON_ID}-{scoring_digest}"
            or not isinstance(evidence.get("snapshot_sha256"), str)
            or SHA256_PATTERN.fullmatch(str(evidence.get("snapshot_sha256"))) is None
        ):
            raise ValueError(f"{location} authoritative scoring identity is invalid")
    elif item.get("cohort_role") == "secondary":
        if (
            participant is None
            or item.get("source_role") != "score-visible-first-party"
            or design not in set(protocol["cohorts"]["secondary"]["allowed_selection_designs"])
            or evidence.get("observation_contract_status") != "valid"
            or evidence.get("observation_contract_version") != OBSERVATION_CONTRACT_VERSION
            or evidence.get("taxon_catalog_version") != TAXON_CATALOG_VERSION
            or evidence.get("complete_attempt") is not True
            or evidence.get("expanded_estimate") is not False
            or evidence.get("mode") not in protocol["eligibility"]["supported_modes"]
            or evidence.get("opportunity_contract_version") != OPPORTUNITY_CONTRACT_VERSION
            or evidence.get("scoring_system_kind") != protocol["candidate"]["kind"]
            or not isinstance(evidence.get("score_influenced_choice"), bool)
            or evidence.get("deletion_status") != "active"
        ):
            raise ValueError(f"{location} violates secondary eligibility")
        window_start = _parse_datetime(
            evidence.get("window_start_at"), location=f"{location}.evidence.window_start_at"
        )
        window_end = _parse_datetime(
            evidence.get("window_end_at"), location=f"{location}.evidence.window_end_at"
        )
        if (
            window_start.microsecond % 1000
            or window_end.microsecond % 1000
            or window_end - window_start
            != timedelta(
                minutes=int(
                    protocol["eligibility"]["authoritative_window_duration_minutes"]
                )
            )
            or segment_start < window_start
            or segment_end > window_end
        ):
            raise ValueError(f"{location} is outside its authoritative two-hour window")
        assignment_time = _parse_datetime(
            evidence.get("impression_or_assignment_at"),
            location=f"{location}.evidence.impression_or_assignment_at",
        )
        consent_time = _parse_datetime(
            evidence.get("study_consent_at"), location=f"{location}.evidence.study_consent_at"
        )
        intent_time = _parse_datetime(
            evidence.get("target_intent_confirmed_at"),
            location=f"{location}.evidence.target_intent_confirmed_at",
        )
        if consent_time > assignment_time or intent_time > assignment_time or assignment_time >= segment_start:
            raise ValueError(f"{location} secondary timestamps are incoherent")
        score_exposed = evidence.get("score_first_exposed_at")
        if score_exposed is None or _parse_datetime(
            score_exposed, location=f"{location}.evidence.score_first_exposed_at"
        ) >= assignment_time:
            raise ValueError(f"{location} secondary selection did not follow score exposure")
        scoring_digest = evidence.get("scoring_system_sha256")
        if (
            not isinstance(scoring_digest, str)
            or SHA256_PATTERN.fullmatch(scoring_digest) is None
            or evidence.get("scoring_system_version")
            != f"heuristic-{PRODUCTION_TARGET_TAXON_ID}-{scoring_digest}"
            or not isinstance(evidence.get("snapshot_sha256"), str)
            or SHA256_PATTERN.fullmatch(str(evidence.get("snapshot_sha256"))) is None
        ):
            raise ValueError(f"{location} authoritative scoring identity is invalid")


def load_split_manifest(
    path: Path,
    protocol: Mapping[str, Any],
    protocol_sha256: str,
) -> dict[str, Any]:
    require_private_file(path, artifact="validation split manifest")
    try:
        manifest = strict_json_loads(
            path.read_text(encoding="utf-8"), artifact="validation split manifest"
        )
    except (OSError, ValueError) as exc:
        raise ValueError(f"could not load validation split manifest {path}") from exc
    if not isinstance(manifest, dict):
        raise ValueError("validation split manifest must be an object")
    _require_exact_keys(manifest, MANIFEST_FIELDS, location="manifest")
    _reject_forbidden_fields(manifest, location="manifest")
    if manifest.get("schema_version") != SPLIT_MANIFEST_SCHEMA_VERSION:
        raise ValueError("validation split manifest schema version is unsupported")
    if manifest.get("protocol_id") != protocol["protocol_id"] or manifest.get("protocol_version") != protocol["protocol_version"]:
        raise ValueError("validation split manifest protocol identity mismatch")
    if manifest.get("protocol_sha256") != protocol_sha256:
        raise ValueError("validation split manifest protocol SHA-256 mismatch")
    if manifest.get("site_catalog_sha256") != protocol["geography"]["site_catalog_sha256"]:
        raise ValueError("validation split manifest site catalog SHA-256 mismatch")
    if manifest.get("append_only") is not True:
        raise ValueError("validation split manifest is not append-only")
    manifest_id = manifest.get("manifest_id")
    if not isinstance(manifest_id, str) or re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", manifest_id
    ) is None:
        raise ValueError("validation split manifest_id is invalid")
    sequence = manifest.get("sequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise ValueError("validation split sequence is invalid")
    previous_digest = manifest.get("previous_manifest_sha256")
    if previous_digest is not None and (
        not isinstance(previous_digest, str) or SHA256_PATTERN.fullmatch(previous_digest) is None
    ):
        raise ValueError("validation split previous_manifest_sha256 is invalid")
    for field in ("data_snapshot_sha256", "prediction_snapshot_sha256"):
        value = manifest.get(field)
        if value is not None and (
            not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None
        ):
            raise ValueError(f"validation split {field} is invalid")
    created = _parse_datetime(manifest.get("created_at"), location="manifest.created_at")
    if manifest.get("activated_at") is None:
        raise ValueError("validation split activated_at is required")
    activated = _parse_datetime(manifest.get("activated_at"), location="manifest.activated_at")
    if created > trusted_utc_now() or activated > trusted_utc_now():
        raise ValueError("validation split manifest cannot claim a future trusted timestamp")
    if created > activated and manifest.get("manifest_role") == "activation":
        raise ValueError("activation cannot be backdated before it was sealed")

    role = manifest.get("manifest_role")
    if role == "activation":
        if sequence != 0 or previous_digest is not None:
            raise ValueError("activation manifest must be sequence zero with no predecessor")
        if manifest.get("labels_opened_at") is not None or manifest.get("outcome_blind") is not True:
            raise ValueError("activation manifest must be outcome blind")
        if manifest.get("data_snapshot_sha256") is not None or manifest.get("prediction_snapshot_sha256") is not None:
            raise ValueError("activation manifest cannot bind evidence or predictions")
        if manifest.get("finalization") is not None:
            raise ValueError("activation manifest cannot contain finalization identity")
        _validate_activation(manifest.get("activation"), protocol, location="manifest.activation")
    elif role == "assignment-batch":
        if sequence < 1 or previous_digest is None:
            raise ValueError("assignment batch must have a predecessor")
        if manifest.get("labels_opened_at") is not None or manifest.get("outcome_blind") is not True:
            raise ValueError("assignment batch must remain outcome blind")
        if manifest.get("activation") is not None:
            raise ValueError("assignment batch must not duplicate activation identity")
        if manifest.get("finalization") is not None:
            raise ValueError("assignment batch cannot claim terminal finalization")
        if manifest.get("data_snapshot_sha256") is None or manifest.get("prediction_snapshot_sha256") is None:
            raise ValueError("assignment batch must bind data and prediction snapshots")
    elif role == "finalization":
        if sequence < 1 or previous_digest is None:
            raise ValueError("finalization must follow activation or an assignment batch")
        if manifest.get("labels_opened_at") is not None or manifest.get("outcome_blind") is not True:
            raise ValueError("finalization must remain outcome blind")
        if manifest.get("activation") is not None:
            raise ValueError("finalization must not duplicate activation identity")
        finalization = manifest.get("finalization")
        if not isinstance(finalization, dict):
            raise ValueError("finalization manifest lacks terminal census identity")
        _require_exact_keys(finalization, FINALIZATION_FIELDS, location="manifest.finalization")
        for field in (
            "census_export_canonical_sha256",
            "census_export_file_sha256",
            "completion_event_set_sha256",
        ):
            if not isinstance(finalization.get(field), str) or SHA256_PATTERN.fullmatch(finalization[field]) is None:
                raise ValueError(f"manifest.finalization.{field} is invalid")
        eligible_source_count = finalization.get("eligible_source_count")
        if (
            finalization.get("finalized_after_enrollment") is not True
            or not _is_nonnegative_int(eligible_source_count)
            or eligible_source_count != len(manifest.get("assignments", []))
            or finalization.get("query_watermark_start_at") != protocol["enrollment"]["start_at"]
            or finalization.get("query_watermark_end_at") != protocol["enrollment"]["end_at"]
            or created < _parse_datetime(protocol["enrollment"]["end_at"], location="enrollment.end_at")
        ):
            raise ValueError("finalization manifest is not the complete terminal census")
        _validate_evaluator_identity_shape(
            finalization.get("evaluator_identity"),
            protocol,
            location="manifest.finalization.evaluator_identity",
        )
        _validate_finalization_issuance_reconciliation_shape(
            finalization.get("issuance_reconciliation"),
            protocol,
            location="manifest.finalization.issuance_reconciliation",
        )
        if manifest.get("data_snapshot_sha256") is None or manifest.get("prediction_snapshot_sha256") is None:
            raise ValueError("finalization must preserve data and prediction snapshots")
    elif role == "label-lock":
        if sequence < 2 or previous_digest is None:
            raise ValueError("label lock must follow an assignment batch")
        if manifest.get("activation") is not None:
            raise ValueError("label lock must not duplicate activation identity")
        if not isinstance(manifest.get("finalization"), dict):
            raise ValueError("label lock must preserve terminal finalization identity")
        _require_exact_keys(
            manifest["finalization"],
            FINALIZATION_FIELDS,
            location="manifest.finalization",
        )
        if not _is_nonnegative_int(
            manifest["finalization"].get("eligible_source_count")
        ):
            raise ValueError("manifest.finalization.eligible_source_count is invalid")
        _validate_evaluator_identity_shape(
            manifest["finalization"].get("evaluator_identity"),
            protocol,
            location="manifest.finalization.evaluator_identity",
        )
        _validate_finalization_issuance_reconciliation_shape(
            manifest["finalization"].get("issuance_reconciliation"),
            protocol,
            location="manifest.finalization.issuance_reconciliation",
        )
        if manifest.get("outcome_blind") is not False or manifest.get("labels_opened_at") is None:
            raise ValueError("label lock must record when outcomes were opened")
        labels_opened = _parse_datetime(
            manifest.get("labels_opened_at"), location="manifest.labels_opened_at"
        )
        if labels_opened != created:
            raise ValueError("label lock created_at must equal labels_opened_at")
        if labels_opened > trusted_utc_now():
            raise ValueError("label lock cannot claim future label access")
        if manifest.get("data_snapshot_sha256") is None or manifest.get("prediction_snapshot_sha256") is None:
            raise ValueError("label lock must preserve data and prediction bindings")
    else:
        raise ValueError("validation split manifest_role is invalid")

    assignments = manifest.get("assignments")
    if not isinstance(assignments, list) or not all(isinstance(item, dict) for item in assignments):
        raise ValueError("validation split assignments must be an object array")
    if role == "activation" and assignments:
        raise ValueError("activation manifest must be sealed before any eligible evidence")
    if role == "assignment-batch" and not assignments:
        raise ValueError("assignment batches require assignments")
    if role in {"finalization", "label-lock"} and not assignments:
        finalization = manifest.get("finalization")
        if (
            not isinstance(finalization, dict)
            or finalization.get("eligible_source_count") != 0
        ):
            raise ValueError(
                "only an exact zero-eligible finalization/label lock may have no assignments"
            )
    if assignments != sorted(assignments, key=lambda item: str(item.get("assignment_id"))):
        raise ValueError("validation split assignments must be sorted by assignment_id")
    seen_assignments: set[str] = set()
    seen_sources: set[str] = set()
    seen_manifest_recruitment: dict[str, tuple[Any, ...]] = {}
    for index, item in enumerate(assignments):
        _validate_manifest_assignment(
            item, protocol, location=f"manifest.assignments[{index}]", activated_at=activated
        )
        assignment_id = str(item["assignment_id"])
        source_digest = str(item["source_record_sha256"])
        if assignment_id in seen_assignments or source_digest in seen_sources:
            raise ValueError("validation split contains duplicate assignment or source lineage")
        seen_assignments.add(assignment_id)
        seen_sources.add(source_digest)
        if item["evidence"]["prospective_assignment_issued"] is True:
            evidence = item["evidence"]
            completion_at = _parse_datetime(
                evidence["completion_event_at"],
                location=f"manifest.assignments[{index}].completion_event_at",
            )
            if completion_at > created:
                raise ValueError("validation assignment completion postdates its manifest seal")
            recruitment_identity = (
                evidence["recruitment_frame_id"],
                evidence["recruitment_source_id"],
                evidence["recruitment_event_at"],
                evidence["recruitment_event_sha256"],
                evidence["community_approval_sha256"],
            )
            participant = str(item["participant_group_id"])
            previous_identity = seen_manifest_recruitment.get(participant)
            if previous_identity is not None and previous_identity != recruitment_identity:
                raise ValueError("validation split changed participant recruitment provenance")
            seen_manifest_recruitment[participant] = recruitment_identity
    expected_aggregate_counts = _aggregate_counts(assignments)
    aggregate_counts = manifest.get("aggregate_counts")
    if (
        not _is_nonnegative_int_map(
            aggregate_counts, expected_keys=set(expected_aggregate_counts)
        )
        or aggregate_counts != expected_aggregate_counts
    ):
        raise ValueError("validation split aggregate counts are inconsistent")
    privacy = manifest.get("privacy")
    if not isinstance(privacy, dict):
        raise ValueError("validation split privacy declaration is missing")
    _require_exact_keys(privacy, PRIVACY_FIELDS, location="manifest.privacy")
    if privacy.get("participant_ids_pseudonymous") is not True or privacy.get("forbidden_fields_absent") is not True or privacy.get("exact_coordinates_absent") is not True:
        raise ValueError("validation split privacy declaration is false")
    if privacy.get("deletion_reconciled_at") is not None:
        _parse_datetime(
            privacy.get("deletion_reconciled_at"),
            location="manifest.privacy.deletion_reconciled_at",
        )
    serialized = canonical_json_bytes(assignments).decode("utf-8")
    if '"outcome_class"' in serialized or '"target_encounter_count"' in serialized or '"target_encountered"' in serialized:
        raise ValueError("validation split manifest contains outcomes")
    return manifest


def load_manifest_chain(
    paths: Sequence[Path],
    protocol: Mapping[str, Any],
    protocol_sha256: str,
) -> list[dict[str, Any]]:
    """Load and verify every link from activation through the supplied tip."""

    if not paths:
        raise ValueError("validation manifest chain cannot be empty")
    manifests = [load_split_manifest(path, protocol, protocol_sha256) for path in paths]
    if manifests[0]["manifest_role"] != "activation":
        raise ValueError("validation manifest chain must begin with activation")
    activated_at = manifests[0]["activated_at"]
    label_lock_seen = False
    for index, manifest in enumerate(manifests):
        if manifest["sequence"] != index:
            raise ValueError("validation manifest chain has a missing or duplicate sequence")
        if manifest["activated_at"] != activated_at:
            raise ValueError("validation manifest chain changed activation time")
        if index == 0:
            continue
        previous = manifests[index - 1]
        if manifest["previous_manifest_sha256"] != canonical_sha256(previous):
            raise ValueError("validation manifest chain predecessor hash is broken")
        if _parse_datetime(manifest["created_at"], location="manifest.created_at") < _parse_datetime(
            previous["created_at"], location="previous.created_at"
        ):
            raise ValueError("validation manifest chain timestamps move backwards")
        if label_lock_seen:
            raise ValueError("validation manifest chain extends past label access")
        previous_by_id = {
            str(item["assignment_id"]): item for item in previous["assignments"]
        }
        current_by_id = {
            str(item["assignment_id"]): item for item in manifest["assignments"]
        }
        if not set(previous_by_id) <= set(current_by_id):
            raise ValueError("validation manifest chain removed an assignment")
        if any(
            canonical_json_bytes(current_by_id[assignment_id])
            != canonical_json_bytes(item)
            for assignment_id, item in previous_by_id.items()
        ):
            raise ValueError("validation manifest chain moved or changed an assignment")
        if manifest["manifest_role"] == "assignment-batch":
            if previous["manifest_role"] not in {"activation", "assignment-batch"}:
                raise ValueError("assignment batch follows an invalid manifest role")
            if set(previous_by_id) == set(current_by_id):
                raise ValueError("assignment batch did not append an assignment")
        elif manifest["manifest_role"] == "finalization":
            if previous["manifest_role"] not in {"activation", "assignment-batch"}:
                raise ValueError(
                    "finalization must immediately follow activation or the final assignment batch"
                )
            if canonical_json_bytes(previous["assignments"]) != canonical_json_bytes(
                manifest["assignments"]
            ):
                raise ValueError("finalization changed split assignments")
            preserved_fields = (
                ("aggregate_counts",)
                if previous["manifest_role"] == "activation"
                else (
                    "data_snapshot_sha256",
                    "prediction_snapshot_sha256",
                    "aggregate_counts",
                    "privacy",
                )
            )
            if previous["manifest_role"] == "activation" and (
                manifest["assignments"]
                or manifest["finalization"]["eligible_source_count"] != 0
            ):
                raise ValueError(
                    "activation may finalize directly only for an exact zero-eligible census"
                )
            for field in preserved_fields:
                if manifest[field] != previous[field]:
                    raise ValueError(f"finalization changed {field}")
        elif manifest["manifest_role"] == "label-lock":
            if previous["manifest_role"] != "finalization":
                raise ValueError("label lock must immediately follow terminal finalization")
            if previous["assignments"] != manifest["assignments"]:
                raise ValueError("label lock changed split assignments")
            for field in (
                "data_snapshot_sha256",
                "prediction_snapshot_sha256",
                "aggregate_counts",
                "privacy",
                "finalization",
            ):
                if manifest[field] != previous[field]:
                    raise ValueError(f"label lock changed {field}")
            label_lock_seen = True
        else:
            raise ValueError("activation may appear only at the start of the chain")
    return manifests


def seal_validation_splits(
    *,
    protocol_path: Path = DEFAULT_PROTOCOL_PATH,
    output_path: Path,
    evidence_path: Path | None = None,
    opportunity_ledger_path: Path | None = None,
    candidate_predictions_path: Path | None = None,
    existing_manifest_path: Path | None = None,
    activation_manifest_path: Path | None = None,
    manifest_chain_paths: Sequence[Path] | None = None,
    release_commit: str | None = None,
    scoring_system_kind: str | None = None,
    scoring_system_version: str | None = None,
    scoring_system_sha256: str | None = None,
    opportunity_contract_version: str | None = None,
    validation_export_signing_key_id: str | None = None,
    validation_export_public_key_ed25519: str | None = None,
    external_log_anchor_provider_id: str | None = None,
    external_log_anchor_signing_key_id: str | None = None,
    external_log_anchor_public_key_ed25519: str | None = None,
) -> dict[str, Any]:
    """Seal an empty activation or append a cumulative outcome-free batch.

    The initial invocation has no evidence inputs and requires explicit scoring
    identity. Later invocations require both the immediate predecessor and the
    root activation manifest. Every output is a new append-only chain link.
    """

    protocol, protocol_digest = load_validation_protocol(protocol_path)
    timestamp = utc_now()
    created = _parse_datetime(timestamp, location="created_at")
    if output_path.exists():
        raise ValueError("refusing to overwrite an immutable validation manifest")

    opportunity_digest: str | None = None
    candidate_digest: str | None = None
    if existing_manifest_path is None:
        if any(
            value is not None
            for value in (
                evidence_path,
                opportunity_ledger_path,
                candidate_predictions_path,
                activation_manifest_path,
                manifest_chain_paths,
            )
        ):
            raise ValueError("activation sealing must not receive evidence or prediction inputs")
        activation_time = timestamp
        activated = created
        enrollment_start = _parse_datetime(
            protocol["enrollment"]["start_at"], location="protocol.enrollment.start_at"
        )
        if activated >= enrollment_start:
            raise ValueError("activation must be deployed before the enrollment interval starts")
        if release_commit is None:
            raise ValueError("activation requires the explicit containing release_commit")
        verify_release_commit_contains_protocol(
            release_commit, protocol_path, protocol_digest
        )
        if scoring_system_kind != protocol["candidate"]["kind"]:
            raise ValueError("activation requires the frozen candidate scoring kind")
        if scoring_system_version is None or scoring_system_sha256 is None:
            raise ValueError("activation requires explicit authoritative scoring version and SHA-256")
        activation = {
            "release_commit": release_commit,
            "scoring_system_kind": scoring_system_kind,
            "scoring_system_version": scoring_system_version,
            "scoring_system_sha256": scoring_system_sha256,
            "opportunity_contract_version": opportunity_contract_version,
            "validation_export_signing_key_id": validation_export_signing_key_id,
            "validation_export_public_key_ed25519": validation_export_public_key_ed25519,
            "external_log_anchor_provider_id": external_log_anchor_provider_id,
            "external_log_anchor_signing_key_id": external_log_anchor_signing_key_id,
            "external_log_anchor_public_key_ed25519": (
                external_log_anchor_public_key_ed25519
            ),
            "deployed_before_first_eligible_row": True,
        }
        _validate_activation(activation, protocol, location="activation")
        previous_hash = None
        sequence = 0
        role = "activation"
        projections: list[dict[str, Any]] = []
        data_digest: str | None = None
        combined_prediction_digest: str | None = None
        deletion_reconciled_at: str | None = None
    else:
        forbidden_activation_args = (
            release_commit,
            scoring_system_kind,
            scoring_system_version,
            scoring_system_sha256,
            opportunity_contract_version,
            validation_export_signing_key_id,
            validation_export_public_key_ed25519,
            external_log_anchor_provider_id,
            external_log_anchor_signing_key_id,
            external_log_anchor_public_key_ed25519,
        )
        if any(value is not None for value in forbidden_activation_args):
            raise ValueError("assignment batches derive activation identity from the sealed root")
        if evidence_path is None or opportunity_ledger_path is None or candidate_predictions_path is None:
            raise ValueError("assignment batches require label-free evidence, ledger, and predictions")
        previous = load_split_manifest(existing_manifest_path, protocol, protocol_digest)
        if previous["manifest_role"] not in {"activation", "assignment-batch"}:
            raise ValueError("split assignments cannot be extended after labels are opened")
        if manifest_chain_paths is None:
            if previous["manifest_role"] != "activation":
                raise ValueError("assignment extension requires the complete manifest chain")
            chain_paths = [existing_manifest_path]
        else:
            chain_paths = list(manifest_chain_paths)
        chain = load_manifest_chain(chain_paths, protocol, protocol_digest)
        if canonical_sha256(chain[-1]) != canonical_sha256(previous):
            raise ValueError("manifest chain tip is not the immediate predecessor")
        root = chain[0]
        verify_release_commit_contains_protocol(
            str(root["activation"]["release_commit"]), protocol_path, protocol_digest
        )
        if activation_manifest_path is not None:
            explicit_root = load_split_manifest(
                activation_manifest_path, protocol, protocol_digest
            )
            if canonical_sha256(explicit_root) != canonical_sha256(root):
                raise ValueError("activation_manifest_path differs from the chain root")
        if previous["activated_at"] != root["activated_at"]:
            raise ValueError("append-only split extension changed activation time")
        if created < _parse_datetime(previous["created_at"], location="previous.created_at"):
            raise ValueError("append-only manifest timestamps cannot move backwards")
        activation_time = str(root["activated_at"])
        label_free = load_validation_evidence(
            evidence_path,
            protocol,
            include_outcomes=False,
            activated_at=activation_time,
            activation_manifest_sha256=canonical_sha256(root),
            activation=root["activation"],
        )
        if not label_free:
            raise ValueError("assignment batch requires at least one label-free evidence row")
        if created < _parse_datetime(activation_time, location="activation.activated_at"):
            raise ValueError("assignment batch cannot be sealed before activation")
        if any(
            _parse_datetime(
                item["evidence"][field], location=f"evidence.{field}"
            )
            > created
            for item in label_free
            for field in ("segment_end_at", "completion_event_at")
            if item["evidence"].get(field) is not None
        ):
            raise ValueError(
                "assignment batch cannot seal effort/completion evidence from after the seal"
            )
        projections = sorted(
            (_assignment_projection(item, protocol) for item in label_free),
            key=lambda item: str(item["assignment_id"]),
        )
        prior_by_id = {str(item["assignment_id"]): item for item in previous["assignments"]}
        current_by_id = {str(item["assignment_id"]): item for item in projections}
        if not set(prior_by_id) <= set(current_by_id):
            raise ValueError("append-only split extension removed an existing assignment")
        for assignment_id, old in prior_by_id.items():
            if canonical_json_bytes(current_by_id[assignment_id]) != canonical_json_bytes(
                old
            ):
                raise ValueError("append-only split extension moved or changed an assignment")
        if set(prior_by_id) == set(current_by_id):
            raise ValueError("assignment batch must append at least one new assignment")
        root_identity = root["activation"]
        for item in label_free:
            if item["evidence"]["prospective_assignment_issued"] is not True:
                continue
            evidence_identity = item["evidence"]
            if (
                evidence_identity["scoring_system_kind"] != root_identity["scoring_system_kind"]
                or evidence_identity["scoring_system_version"] != root_identity["scoring_system_version"]
                or evidence_identity["scoring_system_sha256"] != root_identity["scoring_system_sha256"]
                or evidence_identity["opportunity_contract_version"]
                != root_identity["opportunity_contract_version"]
            ):
                raise ValueError("primary evidence scoring identity differs from activation")
        previous_hash = canonical_sha256(previous)
        sequence = int(previous["sequence"]) + 1
        role = "assignment-batch"
        activation = None
        data_digest = label_free_snapshot_sha256(label_free)
        artifact_digests = validate_label_free_prediction_artifacts(
            opportunity_ledger_path=opportunity_ledger_path,
            candidate_predictions_path=candidate_predictions_path,
            evidence=label_free,
            protocol=protocol,
            activation=root_identity,
        )
        opportunity_digest = artifact_digests["opportunity_ledger_sha256"]
        candidate_digest = artifact_digests["candidate_predictions_sha256"]
        combined_prediction_digest = artifact_digests["prediction_snapshot_sha256"]
        deletion_reconciled_at = timestamp

    manifest_token = data_digest or str(scoring_system_sha256)
    manifest: dict[str, Any] = {
        "schema_version": SPLIT_MANIFEST_SCHEMA_VERSION,
        "manifest_id": f"validation-{role}-{sequence}-{manifest_token[:24]}",
        "manifest_role": role,
        "sequence": sequence,
        "previous_manifest_sha256": previous_hash,
        "protocol_id": protocol["protocol_id"],
        "protocol_version": protocol["protocol_version"],
        "protocol_sha256": protocol_digest,
        "site_catalog_sha256": protocol["geography"]["site_catalog_sha256"],
        "data_snapshot_sha256": data_digest,
        "prediction_snapshot_sha256": combined_prediction_digest,
        "created_at": timestamp,
        "activated_at": activation_time,
        "labels_opened_at": None,
        "outcome_blind": True,
        "append_only": True,
        "activation": activation,
        "finalization": None,
        "assignments": projections,
        "aggregate_counts": _aggregate_counts(projections),
        "privacy": {
            "participant_ids_pseudonymous": True,
            "forbidden_fields_absent": True,
            "exact_coordinates_absent": True,
            "deletion_reconciled_at": deletion_reconciled_at,
        },
    }
    write_private_json_new(output_path, manifest)
    load_split_manifest(output_path, protocol, protocol_digest)
    return {
        "manifest_path": str(output_path),
        "manifest_role": role,
        "manifest_sha256": canonical_sha256(manifest),
        "protocol_sha256": protocol_digest,
        "data_snapshot_sha256": data_digest,
        "opportunity_ledger_sha256": opportunity_digest,
        "candidate_predictions_sha256": candidate_digest,
        "prediction_snapshot_sha256": combined_prediction_digest,
        "assignments": len(projections),
    }


def seal_validation_finalization(
    *,
    output_path: Path,
    label_free_evidence_path: Path,
    opportunity_ledger_path: Path,
    candidate_predictions_path: Path,
    census_export_path: Path,
    manifest_chain_paths: Sequence[Path],
    protocol_path: Path = DEFAULT_PROTOCOL_PATH,
) -> dict[str, Any]:
    """Seal the unique terminal census link after the fixed enrollment interval."""

    protocol, protocol_digest = load_validation_protocol(protocol_path)
    chain = load_manifest_chain(manifest_chain_paths, protocol, protocol_digest)
    previous = chain[-1]
    root = chain[0]
    if previous["manifest_role"] not in {"activation", "assignment-batch"}:
        raise ValueError(
            "terminal finalization requires activation or the final assignment-batch tip"
        )
    enrollment_end = _parse_datetime(protocol["enrollment"]["end_at"], location="enrollment.end_at")
    if trusted_utc_now() < enrollment_end:
        raise ValueError("terminal finalization must be sealed after enrollment")
    if output_path.exists():
        raise ValueError("refusing to overwrite an immutable validation manifest")
    verify_release_commit_contains_protocol(
        str(root["activation"]["release_commit"]), protocol_path, protocol_digest
    )
    label_free = load_validation_evidence(
        label_free_evidence_path,
        protocol,
        include_outcomes=False,
        activated_at=str(root["activated_at"]),
        activation_manifest_sha256=canonical_sha256(root),
        activation=root["activation"],
    )
    projections = sorted(
        (_assignment_projection(item, protocol) for item in label_free),
        key=lambda item: str(item["assignment_id"]),
    )
    if canonical_json_bytes(projections) != canonical_json_bytes(
        previous["assignments"]
    ):
        raise ValueError("terminal census evidence differs from the final sealed assignments")
    empty_interval = previous["manifest_role"] == "activation"
    if empty_interval and label_free:
        raise ValueError("direct activation finalization requires zero eligible evidence")
    if (
        not empty_interval
        and label_free_snapshot_sha256(label_free) != previous["data_snapshot_sha256"]
    ):
        raise ValueError("terminal census evidence differs from the sealed data snapshot")
    artifact_digests = validate_label_free_prediction_artifacts(
        opportunity_ledger_path=opportunity_ledger_path,
        candidate_predictions_path=candidate_predictions_path,
        evidence=label_free,
        protocol=protocol,
        activation=root["activation"],
    )
    if (
        not empty_interval
        and artifact_digests["prediction_snapshot_sha256"]
        != previous["prediction_snapshot_sha256"]
    ):
        raise ValueError("terminal prediction artifacts differ from the sealed snapshot")
    census = load_trusted_census_export(
        census_export_path, protocol, root, evidence=label_free
    )
    evaluator_identity = build_frozen_evaluator_identity(protocol)
    payload = census["payload"]
    timestamp = utc_now()
    created = _parse_datetime(timestamp, location="created_at")
    census_generated = _parse_datetime(
        payload["generated_at"], location="census.generated_at"
    )
    if created < enrollment_end or created < census_generated:
        raise ValueError(
            "terminal finalization cannot predate enrollment closure or census generation"
        )
    manifest = deepcopy(previous)
    manifest["manifest_id"] = (
        f"validation-finalization-{int(previous['sequence']) + 1}-"
        f"{str(census['canonical_sha256'])[:24]}"
    )
    manifest["manifest_role"] = "finalization"
    manifest["sequence"] = int(previous["sequence"]) + 1
    manifest["previous_manifest_sha256"] = canonical_sha256(previous)
    manifest["created_at"] = timestamp
    manifest["activation"] = None
    if empty_interval:
        manifest["data_snapshot_sha256"] = label_free_snapshot_sha256(label_free)
        manifest["prediction_snapshot_sha256"] = artifact_digests[
            "prediction_snapshot_sha256"
        ]
        manifest["privacy"] = {
            **deepcopy(previous["privacy"]),
            "deletion_reconciled_at": timestamp,
        }
    manifest["finalization"] = {
        "census_export_canonical_sha256": census["canonical_sha256"],
        "census_export_file_sha256": census["file_sha256"],
        "eligible_source_count": payload["eligible_source_count"],
        "query_watermark_start_at": payload["query_watermark_start_at"],
        "query_watermark_end_at": payload["query_watermark_end_at"],
        "completion_event_set_sha256": census["completion_event_set_sha256"],
        "issuance_reconciliation": deepcopy(census["issuance_reconciliation"]),
        "finalized_after_enrollment": True,
        "evaluator_identity": evaluator_identity,
    }
    write_private_json_new(output_path, manifest)
    load_split_manifest(output_path, protocol, protocol_digest)
    return {
        "manifest_path": str(output_path),
        "manifest_role": "finalization",
        "manifest_sha256": canonical_sha256(manifest),
        "census_export_canonical_sha256": census["canonical_sha256"],
        "eligible_source_count": payload["eligible_source_count"],
        "evaluator_identity_sha256": canonical_sha256(evaluator_identity),
    }


def _label_lock_projection(
    manifest: Mapping[str, Any], labels_opened_at: str
) -> dict[str, Any]:
    """Return the one exact label-lock link allowed for a finalization."""

    opened = _parse_datetime(labels_opened_at, location="labels_opened_at")
    if manifest.get("manifest_role") != "finalization":
        raise ValueError("labels may be opened only from the terminal finalization manifest")
    if manifest.get("labels_opened_at") is not None or manifest.get("outcome_blind") is not True:
        raise ValueError("validation labels have already been opened")
    if opened < _parse_datetime(manifest.get("created_at"), location="manifest.created_at"):
        raise ValueError("labels_opened_at cannot predate the sealed assignment manifest")
    if opened > trusted_utc_now():
        raise ValueError("labels_opened_at cannot be future-dated")
    locked = deepcopy(dict(manifest))
    locked["manifest_id"] = f"validation-label-lock-{int(manifest['sequence']) + 1}-{canonical_sha256(manifest)[:24]}"
    locked["manifest_role"] = "label-lock"
    locked["sequence"] = int(manifest["sequence"]) + 1
    locked["previous_manifest_sha256"] = canonical_sha256(manifest)
    locked["created_at"] = labels_opened_at
    locked["labels_opened_at"] = labels_opened_at
    locked["outcome_blind"] = False
    return locked


def validate_label_lock_extension(
    label_lock: Mapping[str, Any], finalization_manifest: Mapping[str, Any]
) -> dict[str, Any]:
    """Require an existing label lock to be the exact next immutable chain link."""

    opened_at = label_lock.get("labels_opened_at")
    expected = _label_lock_projection(finalization_manifest, str(opened_at))
    if dict(label_lock) != expected:
        raise ValueError("label lock is not the exact next finalization chain link")
    return expected


def lock_manifest_for_label_access(
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    """Create the immutable next chain link at the trusted current time."""

    return _label_lock_projection(manifest, utc_now())


def seal_validation_label_lock(
    *,
    output_path: Path,
    finalization_manifest_path: Path,
    manifest_chain_paths: Sequence[Path],
    protocol_path: Path = DEFAULT_PROTOCOL_PATH,
) -> dict[str, Any]:
    """Durably seal the exact label-lock link before a server releases labels."""

    protocol, protocol_digest = load_validation_protocol(protocol_path)
    chain = load_manifest_chain(manifest_chain_paths, protocol, protocol_digest)
    finalization = load_split_manifest(
        finalization_manifest_path, protocol, protocol_digest
    )
    if canonical_sha256(chain[-1]) != canonical_sha256(finalization):
        raise ValueError("label lock requires the exact finalization chain tip")
    if output_path.exists():
        raise ValueError("refusing to overwrite an immutable validation label lock")
    root = chain[0]
    verify_release_commit_contains_protocol(
        str(root["activation"]["release_commit"]), protocol_path, protocol_digest
    )
    verify_frozen_evaluator_identity(
        finalization["finalization"]["evaluator_identity"], protocol
    )
    locked = lock_manifest_for_label_access(finalization)
    write_private_json_new(output_path, locked)
    persisted = load_split_manifest(output_path, protocol, protocol_digest)
    validate_label_lock_extension(persisted, finalization)
    load_manifest_chain(
        [*manifest_chain_paths, output_path], protocol, protocol_digest
    )
    return {
        "manifest_path": str(output_path),
        "manifest_role": "label-lock",
        "manifest_sha256": canonical_sha256(persisted),
        "labels_opened_at": persisted["labels_opened_at"],
    }
