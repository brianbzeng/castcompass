from __future__ import annotations

import base64
import hashlib
import json
import os
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pipeline.contourcast.validation_protocol import (
    DEFAULT_PROTOCOL_PATH,
    EVALUATOR_SOURCE_PATHS,
    EVIDENCE_SCHEMA_VERSION,
    IMPRESSION_ATTESTATION_SCHEMA_VERSION,
    SCORE_EXPOSURE_ATTESTATION_SCHEMA_VERSION,
    ISSUANCE_DISPOSITION_STATUSES,
    _disposition_event_sha256,
    _evaluator_algorithm_config_sha256,
    _issued_assignment_set_projection,
    _reconciliation_stream_events,
    _reconciliation_stream_summary,
    _signed_exposure_set_projection,
    _terminal_disposition_set_projection,
    canonical_json_bytes,
    canonical_sha256,
    impression_attestation_payload,
    score_exposure_attestation_payload,
    seal_validation_finalization,
    seal_validation_label_lock,
    seal_validation_splits,
    summarize_collection_provenance_events,
)
from shared.species_contract import (
    OBSERVATION_CONTRACT_VERSION,
    OPPORTUNITY_CONTRACT_VERSION,
    TAXON_CATALOG_VERSION,
)


SCORING_SHA = "a" * 64
SCORING_VERSION = f"heuristic-california-halibut-{SCORING_SHA}"
SNAPSHOT_SHA = "b" * 64
ACTIVATED_AT = "2026-07-31T00:00:00Z"
RELEASE_COMMIT = "c" * 40
PLACEHOLDER_ACTIVATION_SHA = "d" * 64
SIGNING_KEY_ID = "validation-export-key-1"
PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33)))
PUBLIC_KEY_BASE64 = base64.b64encode(
    PRIVATE_KEY.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
).decode("ascii")
ANCHOR_KEY_ID = "external-log-anchor-key-1"
ANCHOR_PROVIDER_ID = "independent-transparency-anchor-1"
ANCHOR_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(33, 65)))
ANCHOR_PUBLIC_KEY_BASE64 = base64.b64encode(
    ANCHOR_PRIVATE_KEY.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
).decode("ascii")
TRUSTED_NOW = datetime(2027, 8, 10, tzinfo=timezone.utc)
LABEL_LOCKED_AT = datetime(2027, 8, 4, tzinfo=timezone.utc)

BLOCK_WINDOWS = {
    "block-1": "2026-08-15T10:00:00Z",
    "block-2": "2026-12-15T10:00:00Z",
    "block-3": "2027-03-15T10:00:00Z",
    "block-4": "2027-06-15T10:00:00Z",
}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stamp(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def bind_impression_attestation(row: dict[str, Any]) -> None:
    payload_bytes = canonical_json_bytes(impression_attestation_payload(row))
    envelope = {
        "schema_version": IMPRESSION_ATTESTATION_SCHEMA_VERSION,
        "signing_key_id": SIGNING_KEY_ID,
        "payload_base64": base64.b64encode(payload_bytes).decode("ascii"),
        "payload_sha256": hashlib.sha256(payload_bytes).hexdigest(),
        "signature_ed25519": base64.b64encode(PRIVATE_KEY.sign(payload_bytes)).decode(
            "ascii"
        ),
    }
    row["impression_attestation"] = envelope
    row["evidence"]["impression_attestation_sha256"] = canonical_sha256(envelope)
    if (
        row["evidence"]["intended_cohort_role"] == "primary"
        and row["evidence"]["score_first_exposed_at"] is not None
    ):
        exposure_bytes = canonical_json_bytes(score_exposure_attestation_payload(row))
        exposure_envelope = {
            "schema_version": SCORE_EXPOSURE_ATTESTATION_SCHEMA_VERSION,
            "signing_key_id": SIGNING_KEY_ID,
            "payload_base64": base64.b64encode(exposure_bytes).decode("ascii"),
            "payload_sha256": hashlib.sha256(exposure_bytes).hexdigest(),
            "signature_ed25519": base64.b64encode(
                PRIVATE_KEY.sign(exposure_bytes)
            ).decode("ascii"),
        }
        row["score_exposure_attestation"] = exposure_envelope
        row["evidence"]["score_exposure_attestation_sha256"] = canonical_sha256(
            exposure_envelope
        )
    else:
        row["score_exposure_attestation"] = None
        row["evidence"]["score_exposure_attestation_sha256"] = None


def load_protocol() -> dict[str, Any]:
    return json.loads(DEFAULT_PROTOCOL_PATH.read_text(encoding="utf-8"))


def validation_activation_identity() -> dict[str, Any]:
    return {
        "scoring_system_kind": "heuristic-configuration",
        "scoring_system_version": SCORING_VERSION,
        "scoring_system_sha256": SCORING_SHA,
        "opportunity_contract_version": OPPORTUNITY_CONTRACT_VERSION,
        "validation_export_signing_key_id": SIGNING_KEY_ID,
        "validation_export_public_key_ed25519": PUBLIC_KEY_BASE64,
        "external_log_anchor_provider_id": ANCHOR_PROVIDER_ID,
        "external_log_anchor_signing_key_id": ANCHOR_KEY_ID,
        "external_log_anchor_public_key_ed25519": ANCHOR_PUBLIC_KEY_BASE64,
    }


@contextmanager
def trusted_clock(now: datetime = TRUSTED_NOW) -> Iterator[None]:
    with ExitStack() as stack:
        stack.enter_context(
            patch(
                "pipeline.contourcast.validation_protocol.trusted_utc_now",
                return_value=now,
            )
        )
        stack.enter_context(
            patch(
                "pipeline.contourcast.first_party_validation.trusted_utc_now",
                return_value=now,
            )
        )
        yield


def completion_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    evidence = row["evidence"]
    return {
        "activation_manifest_sha256": evidence["activation_manifest_sha256"],
        "assignment_id": row["assignment_id"],
        "source_record_sha256": row["source_record_sha256"],
        "participant_group_id": row["participant_group_id"],
        "cohort_id": evidence["cohort_id"],
        "incentive_policy_id": evidence["incentive_policy_id"],
        "effort_segment_id": evidence["effort_segment_id"],
        "completion_event_contract_version": evidence[
            "completion_event_contract_version"
        ],
        "completion_event_at": evidence["completion_event_at"],
        "completion_consent_version": evidence["completion_consent_version"],
        "completion_consented_at": evidence["completion_consented_at"],
        "completion_primary_target_confirmed": evidence[
            "completion_primary_target_confirmed"
        ],
        "completion_complete_attempt_confirmed": evidence[
            "completion_complete_attempt_confirmed"
        ],
        "target_taxon_id": evidence["target_taxon_id"],
        "segment_start_at": evidence["segment_start_at"],
        "segment_end_at": evidence["segment_end_at"],
        "mode": evidence["mode"],
        "effort_unit": evidence["effort_unit"],
        "attempt_count": evidence["attempt_count"],
        "duration_milliseconds": evidence["duration_milliseconds"],
        "angler_count": evidence["angler_count"],
        "person_milliseconds": evidence["person_milliseconds"],
    }


def make_row(
    index: int,
    *,
    site_id: str,
    block: str,
    score: int,
    encountered: bool,
    cohort_role: str = "primary",
    source_role: str = "prospective-first-party",
    selection_design: str = "prospective-precommitted-without-score",
    angler_count: int = 1,
    participant_index: int | None = None,
    recruitment_source: str = "castingcompass-organic-product",
    expose_primary_score: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    window_start = datetime.fromisoformat(BLOCK_WINDOWS[block].replace("Z", "+00:00"))
    window_end = window_start + timedelta(hours=2)
    segment_start = window_start + timedelta(minutes=15)
    segment_end = window_start + timedelta(minutes=105)
    assignment_time = window_start - timedelta(hours=2)
    score_exposed = assignment_time + timedelta(minutes=30)
    assignment_id = f"assignment-{digest(f'assignment:{index}')}"
    source_sha = digest(f"source:{index}")
    participant = f"participant-{digest(f'participant:{participant_index if participant_index is not None else index}')}"
    recruitment_at = "2026-07-31T12:00:00.000Z"
    recruitment_frame = "california-halibut-site-window-recruitment-v1"
    recruitment_event_sha = canonical_sha256(
        {
            "participant_group_id": participant,
            "recruitment_frame_id": recruitment_frame,
            "recruitment_source_id": recruitment_source,
            "recruitment_event_at": recruitment_at,
            "community_approval_sha256": None,
        }
    )
    randomized = selection_design == "prospective-safely-randomized"
    precommitted = selection_design == "prospective-precommitted-without-score"
    secondary = cohort_role == "secondary"
    if secondary:
        source_role = "score-visible-first-party"
        selection_design = "prospective-score-visible-self-selected"
        randomized = False
        precommitted = False
    cohort_id = (
        "california-halibut-site-window-observational-secondary-v1"
        if secondary
        else "california-halibut-site-window-primary-v1"
    )
    collection_source_role = "prospective_secondary" if secondary else "prospective_primary"
    collection_status = "secondary_pending_review" if secondary else "primary_accepted"
    selection_method = (
        "organic_score_visible"
        if secondary
        else "safe_randomized" if randomized else "score_blind_precommitment"
    )
    event_id = f"validation-completion-{index}"
    provenance_events = [
        {
            "id": f"validation-enrollment-{index}",
            "event_type": "enrollment",
            "created_at": recruitment_at,
            "exclusion_reason": None,
        },
        {
            "id": event_id,
            "event_type": "completion",
            "created_at": stamp(segment_end),
            "exclusion_reason": None,
        },
    ]
    provenance = summarize_collection_provenance_events(provenance_events)
    duration_milliseconds = 90 * 60 * 1000
    evidence = {
        "observation_contract_status": "valid",
        "observation_contract_version": OBSERVATION_CONTRACT_VERSION,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_taxon_id": "california-halibut",
        "recruitment_frame_id": recruitment_frame,
        "recruitment_source_id": recruitment_source,
        "recruitment_event_contract_version": "castingcompass.recruitment-event/1.0.0",
        "recruitment_event_at": recruitment_at,
        "recruitment_event_sha256": recruitment_event_sha,
        "community_approval_sha256": None,
        "complete_attempt": True,
        "expanded_estimate": False,
        "activation_manifest_sha256": PLACEHOLDER_ACTIVATION_SHA,
        "cohort_id": cohort_id,
        "prospective_assignment_issued": cohort_role in {"primary", "secondary"},
        "intended_cohort_role": (
            cohort_role if cohort_role in {"primary", "secondary"} else None
        ),
        "intended_source_role": (
            source_role if cohort_role in {"primary", "secondary"} else None
        ),
        "intended_cohort_id": (
            cohort_id if cohort_role in {"primary", "secondary"} else None
        ),
        "intended_selection_method": (
            selection_method if cohort_role in {"primary", "secondary"} else None
        ),
        "collection_source_role": collection_source_role,
        "collection_event_type": "completion",
        "collection_event_id": event_id,
        "collection_event_at": stamp(segment_end),
        **provenance,
        "collection_evidence_status": collection_status,
        "collection_cohort_id": cohort_id,
        "collection_selection_method": selection_method,
        "collection_validation_protocol_id": "california-halibut-site-window-v1",
        "collection_activated_at": ACTIVATED_AT,
        "collection_activation_scoring_system_sha256": SCORING_SHA,
        "collection_exclusion_reason": None,
        "incentive_policy_id": "none-v1",
        "effort_segment_id": f"effort-{digest(f'effort:{index}')}",
        "effort_unit": "whole-trip-group-attempt",
        "attempt_count": 1,
        "duration_milliseconds": duration_milliseconds,
        "angler_count": angler_count,
        "person_milliseconds": duration_milliseconds * angler_count,
        "mode": "shore",
        "segment_start_at": stamp(segment_start),
        "segment_end_at": stamp(segment_end),
        "opportunity_window_id": f"{site_id}--{window_start:%Y%m%dT%H%MZ}",
        "window_start_at": stamp(window_start),
        "window_end_at": stamp(window_end),
        "opportunity_contract_version": OPPORTUNITY_CONTRACT_VERSION,
        "scoring_system_kind": "heuristic-configuration",
        "scoring_system_version": SCORING_VERSION,
        "scoring_system_sha256": SCORING_SHA,
        "snapshot_sha256": SNAPSHOT_SHA,
        "site_catalog_sha256": load_protocol()["geography"]["site_catalog_sha256"],
        "impression_attestation_sha256": digest(f"attestation:{index}"),
        "score_exposure_attestation_sha256": None,
        "forecast_impression_id": f"forecast-impression-{index}",
        "impression_or_assignment_at": stamp(assignment_time),
        "selection_design": selection_design,
        "score_influenced_choice": True if secondary else False,
        "study_consent_version": "castingcompass.trip-validation-consent/1.0.0",
        "study_consent_at": stamp(assignment_time - timedelta(minutes=30)),
        "target_intent_confirmed_at": stamp(assignment_time - timedelta(minutes=15)),
        "completion_event_contract_version": "castingcompass.validation-completion-event/1.0.0",
        "completion_event_at": stamp(segment_end),
        "completion_consent_version": "castingcompass.trip-validation-consent/1.0.0",
        "completion_consented_at": stamp(segment_end),
        "completion_primary_target_confirmed": True,
        "completion_complete_attempt_confirmed": True,
        "completion_event_sha256": None,
        "precommitment_event_sha256": digest(f"precommit:{index}") if precommitted else None,
        "score_first_exposed_at": stamp(
            assignment_time - timedelta(minutes=30) if secondary else score_exposed
        )
        if secondary or expose_primary_score
        else None,
        "score_exposure_disposition": (
            "already-exposed-before-assignment"
            if secondary
            else (
                "exposed-after-assignment-before-segment"
                if expose_primary_score
                else "never-exposed-through-completion"
            )
        ),
        "feasible_set_sha256": digest(f"feasible:{index}") if randomized else None,
        "feasible_option_count": 2 if randomized else None,
        "assignment_probability_numerator": 1 if randomized else None,
        "assignment_probability_denominator": 2 if randomized else None,
        "randomization_draw_index": index % 2 if randomized else None,
        "randomization_audit_sha256": digest(f"audit:{index}") if randomized else None,
        "deletion_status": "active",
        "exact_coordinates_collected": False,
    }
    label_free = {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "assignment_id": assignment_id,
        "source_record_sha256": source_sha,
        "participant_group_id": participant,
        "protocol_id": "california-halibut-site-window-v1",
        "protocol_version": "1.0.0",
        "cohort_role": cohort_role,
        "source_role": source_role,
        "selection_design": selection_design,
        "site_id": site_id,
        "opportunity_score": score,
        "impression_attestation": {},
        "score_exposure_attestation": None,
        "server_attested": True,
        "evidence_status": "admitted",
        "deletion_lineage": {
            "lineage_sha256": digest(f"lineage:{index}"),
            "reconciled_at": "2027-08-02T00:00:00.000Z",
            "status": "active",
        },
        "evidence": evidence,
    }
    bind_impression_attestation(label_free)
    evidence["completion_event_sha256"] = canonical_sha256(completion_payload(label_free))
    labeled = deepcopy(label_free)
    labeled["outcome_class"] = "target_encountered" if encountered else "no_fish"
    labeled["target_encounter_count"] = 1 if encountered else 0
    return label_free, labeled


def make_context_row(
    index: int,
    *,
    site_id: str = "limantour-beach",
    block: str = "block-1",
    score: int = 50,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return one explicitly non-issued retrospective context row."""

    label_free, labeled = make_row(
        index,
        site_id=site_id,
        block=block,
        score=score,
        encountered=False,
    )
    for row in (label_free, labeled):
        evidence = row["evidence"]
        context_event_at = evidence["segment_end_at"]
        context_event_id = f"retrospective-context-{index}"
        context_provenance = summarize_collection_provenance_events(
            [
                {
                    "id": context_event_id,
                    "event_type": "retrospective_submission",
                    "created_at": context_event_at,
                    "exclusion_reason": None,
                }
            ]
        )
        row.update(
            {
                "cohort_role": "exploratory",
                "source_role": "retrospective-first-party",
                "selection_design": "retrospective-or-context",
                "impression_attestation": None,
                "score_exposure_attestation": None,
                "evidence_status": "admitted",
            }
        )
        evidence.update(
            {
                "recruitment_frame_id": None,
                "recruitment_source_id": None,
                "recruitment_event_contract_version": None,
                "recruitment_event_at": None,
                "recruitment_event_sha256": None,
                "community_approval_sha256": None,
                "activation_manifest_sha256": None,
                "cohort_id": None,
                "prospective_assignment_issued": False,
                "intended_cohort_role": None,
                "intended_source_role": None,
                "intended_cohort_id": None,
                "intended_selection_method": None,
                "collection_source_role": "context_only",
                "collection_event_type": "retrospective_submission",
                "collection_event_id": context_event_id,
                "collection_event_at": context_event_at,
                **context_provenance,
                "collection_evidence_status": "context_only",
                "collection_cohort_id": "predeployment-context",
                "collection_selection_method": "organic_unverified",
                "collection_validation_protocol_id": (
                    "california-halibut-site-window-v1"
                ),
                "collection_activated_at": None,
                "collection_activation_scoring_system_sha256": None,
                "collection_exclusion_reason": None,
                "impression_attestation_sha256": None,
                "score_exposure_attestation_sha256": None,
                "forecast_impression_id": None,
                "impression_or_assignment_at": None,
                "selection_design": "retrospective-or-context",
                "score_influenced_choice": None,
                "study_consent_version": None,
                "study_consent_at": None,
                "target_intent_confirmed_at": None,
                "completion_event_contract_version": None,
                "completion_event_at": None,
                "completion_consent_version": None,
                "completion_consented_at": None,
                "completion_primary_target_confirmed": None,
                "completion_complete_attempt_confirmed": None,
                "completion_event_sha256": None,
                "precommitment_event_sha256": None,
                "score_first_exposed_at": None,
                "score_exposure_disposition": "not-applicable",
                "feasible_set_sha256": None,
                "feasible_option_count": None,
                "assignment_probability_numerator": None,
                "assignment_probability_denominator": None,
                "randomization_draw_index": None,
                "randomization_audit_sha256": None,
            }
        )
    return label_free, labeled


def write_json(path: Path, value: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.chmod(path, 0o600)
    return path


def seal_activation(root: Path) -> Path:
    path = root / "activation.json"
    activation_time = datetime.fromisoformat(ACTIVATED_AT.replace("Z", "+00:00"))
    with trusted_clock(activation_time), patch(
        "pipeline.contourcast.validation_protocol.verify_release_commit_contains_protocol"
    ):
        seal_validation_splits(
            output_path=path,
            release_commit=RELEASE_COMMIT,
            scoring_system_kind="heuristic-configuration",
            scoring_system_version=SCORING_VERSION,
            scoring_system_sha256=SCORING_SHA,
            opportunity_contract_version=OPPORTUNITY_CONTRACT_VERSION,
            validation_export_signing_key_id=SIGNING_KEY_ID,
            validation_export_public_key_ed25519=PUBLIC_KEY_BASE64,
            external_log_anchor_provider_id=ANCHOR_PROVIDER_ID,
            external_log_anchor_signing_key_id=ANCHOR_KEY_ID,
            external_log_anchor_public_key_ed25519=ANCHOR_PUBLIC_KEY_BASE64,
        )
    return path


def bind_rows_to_activation(
    rows: Sequence[tuple[dict[str, Any], dict[str, Any]]], activation_path: Path
) -> None:
    activation = json.loads(activation_path.read_text(encoding="utf-8"))
    activation_sha = canonical_sha256(activation)
    for pair in rows:
        for row in pair:
            evidence = row["evidence"]
            evidence["activation_manifest_sha256"] = activation_sha
            evidence["collection_activated_at"] = activation["activated_at"]
            evidence["collection_activation_scoring_system_sha256"] = activation[
                "activation"
            ]["scoring_system_sha256"]
            bind_impression_attestation(row)
            evidence["completion_event_sha256"] = canonical_sha256(
                completion_payload(row)
            )


def write_evidence_pair(
    root: Path,
    rows: Sequence[tuple[dict[str, Any], dict[str, Any]]],
    *,
    activation_path: Path | None = None,
) -> tuple[Path, list[dict[str, Any]], list[dict[str, Any]]]:
    if activation_path is not None:
        bind_rows_to_activation(rows, activation_path)
    label_free = [deepcopy(row[0]) for row in rows]
    labeled = [deepcopy(row[1]) for row in rows]
    return write_json(root / "label-free.json", label_free), label_free, labeled


def write_prediction_artifacts(
    root: Path, label_free: Sequence[dict[str, Any]]
) -> tuple[Path, Path]:
    prospective = [
        row
        for row in label_free
        if row["evidence"]["prospective_assignment_issued"] is True
    ]
    entries = []
    predictions = []
    for row in prospective:
        evidence = row["evidence"]
        entries.append(
            {
                "assignment_id": row["assignment_id"],
                "source_record_sha256": row["source_record_sha256"],
                "opportunity_window_id": evidence["opportunity_window_id"],
                "site_id": row["site_id"],
                "window_start_at": evidence["window_start_at"],
                "window_end_at": evidence["window_end_at"],
                "opportunity_contract_version": evidence["opportunity_contract_version"],
                "scoring_system_kind": evidence["scoring_system_kind"],
                "scoring_system_version": evidence["scoring_system_version"],
                "scoring_system_sha256": evidence["scoring_system_sha256"],
                "snapshot_sha256": evidence["snapshot_sha256"],
                "site_catalog_sha256": evidence["site_catalog_sha256"],
                "impression_attestation_sha256": evidence[
                    "impression_attestation_sha256"
                ],
                "score_exposure_attestation_sha256": evidence[
                    "score_exposure_attestation_sha256"
                ],
            }
        )
        predictions.append(
            {
                "assignment_id": row["assignment_id"],
                "source_record_sha256": row["source_record_sha256"],
                "opportunity_window_id": evidence["opportunity_window_id"],
                "scoring_system_version": evidence["scoring_system_version"],
                "scoring_system_sha256": evidence["scoring_system_sha256"],
                "snapshot_sha256": evidence["snapshot_sha256"],
                "opportunity_score": row["opportunity_score"],
            }
        )
    entries.sort(key=lambda item: item["assignment_id"])
    predictions.sort(key=lambda item: item["assignment_id"])
    return (
        write_json(
            root / "ledger.json",
            {
                "schema_version": "castingcompass.validation-opportunity-ledger/1.0.0",
                "protocol_id": "california-halibut-site-window-v1",
                "protocol_version": "1.0.0",
                "entries": entries,
            },
        ),
        write_json(
            root / "predictions.json",
            {
                "schema_version": "castingcompass.validation-candidate-predictions/1.0.0",
                "protocol_id": "california-halibut-site-window-v1",
                "protocol_version": "1.0.0",
                "predictions": predictions,
            },
        ),
    )


def seal_batch(
    root: Path,
    *,
    label_free_path: Path,
    ledger_path: Path,
    predictions_path: Path,
    chain: Sequence[Path],
    name: str = "batch.json",
    sealed_at: str = "2027-08-02T00:00:00Z",
) -> Path:
    output = root / name
    seal_time = datetime.fromisoformat(sealed_at.replace("Z", "+00:00"))
    with trusted_clock(seal_time), patch(
        "pipeline.contourcast.validation_protocol.verify_release_commit_contains_protocol"
    ):
        seal_validation_splits(
            output_path=output,
            evidence_path=label_free_path,
            opportunity_ledger_path=ledger_path,
            candidate_predictions_path=predictions_path,
            existing_manifest_path=chain[-1],
            activation_manifest_path=chain[0],
            manifest_chain_paths=chain,
        )
    return output


def sign_payload(
    path: Path,
    *,
    schema_version: str,
    payload: Mapping[str, Any],
    private_key: Ed25519PrivateKey = PRIVATE_KEY,
    payload_bytes: bytes | None = None,
) -> Path:
    raw_payload = payload_bytes if payload_bytes is not None else canonical_json_bytes(payload)
    envelope = {
        "schema_version": schema_version,
        "signing_key_id": SIGNING_KEY_ID,
        "payload_base64": base64.b64encode(raw_payload).decode("ascii"),
        "payload_sha256": hashlib.sha256(raw_payload).hexdigest(),
        "signature_ed25519": base64.b64encode(private_key.sign(raw_payload)).decode(
            "ascii"
        ),
    }
    return write_json(path, envelope)


def make_unsealed_issuance_record(
    index: int,
    *,
    intended_cohort_role: str = "primary",
    assignment_issued_at: str = "2026-08-20T08:00:00.000Z",
    terminal_disposition: str = "incomplete-or-expired",
    terminal_reason: str = "no-completion-before-enrollment-close",
    reconciliation_watermark_at: str = "2027-08-01T00:00:00.000Z",
    completion_event_sha256: str | None = None,
) -> dict[str, Any]:
    return {
        "assignment_sequence": 0,
        "assignment_id": f"assignment-{digest(f'unsealed-assignment:{index}')}",
        "source_record_sha256": digest(f"unsealed-source:{index}"),
        "impression_attestation_sha256": digest(f"unsealed-impression:{index}"),
        "assignment_issued_at": assignment_issued_at,
        "intended_cohort_role": intended_cohort_role,
        "intended_source_role": (
            "prospective-first-party"
            if intended_cohort_role == "primary"
            else "score-visible-first-party"
        ),
        "segment_start_at": None,
        "completion_event_at": None,
        "exposure_sequence": None,
        "score_exposure_attestation_sha256": None,
        "score_exposure_links_impression_attestation_sha256": None,
        "score_exposed_at": (
            "2026-08-20T07:30:00.000Z"
            if intended_cohort_role == "secondary"
            else None
        ),
        "score_exposure_evidence_kind": (
            "prior-exposure-asserted-in-impression"
            if intended_cohort_role == "secondary"
            else "none"
        ),
        "score_exposure_disposition": (
            "already-exposed-before-assignment"
            if intended_cohort_role == "secondary"
            else "no-issued-exposure-through-terminal-watermark"
        ),
        "sealed_row_score_exposure_disposition": None,
        "terminal_disposition": terminal_disposition,
        "terminal_reason": terminal_reason,
        "final_cohort_role": None,
        "label_free_row_sha256": None,
        "completion_event_sha256": completion_event_sha256,
        "reconciliation_watermark_at": reconciliation_watermark_at,
        "terminal_collection_provenance_chain_sha256": digest(
            f"unsealed-terminal-provenance:{index}"
        ),
        "disposition_event_sha256": None,
    }


def build_issuance_reconciliation(
    label_free: Sequence[dict[str, Any]],
    protocol: Mapping[str, Any],
    *,
    reconciled_through_at: str,
    unsealed_issuance_records: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    issued_rows = sorted(
        (
            row
            for row in label_free
            if row["evidence"]["prospective_assignment_issued"] is True
        ),
        key=lambda row: (
            row["evidence"]["impression_or_assignment_at"],
            row["assignment_id"],
        ),
    )
    records: list[dict[str, Any]] = []
    for row in issued_rows:
        evidence = row["evidence"]
        if evidence["intended_cohort_role"] == "secondary":
            exposure_kind = "prior-exposure-asserted-in-impression"
            score_disposition = "already-exposed-before-assignment"
        elif evidence["score_exposure_attestation_sha256"] is not None:
            exposure_kind = "signed-first-exposure-event"
            score_disposition = "exposed-after-assignment-before-segment"
        else:
            exposure_kind = "none"
            score_disposition = "no-issued-exposure-through-terminal-watermark"
        record = {
            "assignment_sequence": 0,
            "assignment_id": row["assignment_id"],
            "source_record_sha256": row["source_record_sha256"],
            "impression_attestation_sha256": evidence[
                "impression_attestation_sha256"
            ],
            "assignment_issued_at": evidence["impression_or_assignment_at"],
            "intended_cohort_role": evidence["intended_cohort_role"],
            "intended_source_role": evidence["intended_source_role"],
            "segment_start_at": evidence["segment_start_at"],
            "completion_event_at": evidence["completion_event_at"],
            "exposure_sequence": None,
            "score_exposure_attestation_sha256": evidence[
                "score_exposure_attestation_sha256"
            ],
            "score_exposure_links_impression_attestation_sha256": (
                evidence["impression_attestation_sha256"]
                if evidence["score_exposure_attestation_sha256"] is not None
                else None
            ),
            "score_exposed_at": evidence["score_first_exposed_at"],
            "score_exposure_evidence_kind": exposure_kind,
            "score_exposure_disposition": score_disposition,
            "sealed_row_score_exposure_disposition": evidence[
                "score_exposure_disposition"
            ],
            "terminal_disposition": "completed-and-exported",
            "terminal_reason": None,
            "final_cohort_role": row["cohort_role"],
            "label_free_row_sha256": canonical_sha256(row),
            "completion_event_sha256": evidence["completion_event_sha256"],
            "reconciliation_watermark_at": evidence["completion_event_at"],
            "terminal_collection_provenance_chain_sha256": evidence[
                "collection_provenance_chain_sha256"
            ],
            "disposition_event_sha256": None,
        }
        records.append(record)
    records.extend(deepcopy(dict(record)) for record in unsealed_issuance_records)
    records.sort(key=lambda record: (record["assignment_issued_at"], record["assignment_id"]))
    for sequence, record in enumerate(records, 1):
        record["assignment_sequence"] = sequence
        record["reconciliation_watermark_at"] = reconciled_through_at
    signed_exposures = sorted(
        (
            record
            for record in records
            if record["score_exposure_evidence_kind"]
            == "signed-first-exposure-event"
        ),
        key=lambda record: (record["score_exposed_at"], record["assignment_id"]),
    )
    for sequence, record in enumerate(signed_exposures, 1):
        record["exposure_sequence"] = sequence
    for record in records:
        record["disposition_event_sha256"] = _disposition_event_sha256(record)
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
    issuance_events = _reconciliation_stream_events(
        records, event_type="assignment-issued"
    )
    exposure_events = _reconciliation_stream_events(
        records, event_type="score-first-exposed"
    )
    return {
        "evidence_basis": "signed-exporter-assertion-without-raw-ledger-proof",
        "append_only_log_proof_included": False,
        "query_id": protocol["recruitment"]["issuance_reconciliation_query_id"],
        "reconciled_through_at": reconciled_through_at,
        "issuance_stream": _reconciliation_stream_summary(
            protocol["recruitment"]["issuance_stream_id"], issuance_events
        ),
        "signed_primary_exposure_stream": _reconciliation_stream_summary(
            protocol["recruitment"]["exposure_stream_id"], exposure_events
        ),
        "issued_assignment_count": len(records),
        "issued_assignment_set_sha256": canonical_sha256(issued_projection),
        "signed_primary_exposure_event_count": len(exposure_projection),
        "signed_primary_exposure_event_set_sha256": canonical_sha256(
            exposure_projection
        ),
        "terminal_disposition_set_sha256": canonical_sha256(
            disposition_projection
        ),
        "terminal_disposition_counts": disposition_counts,
        "intended_to_final_disposition_counts": intended_to_final_counts,
        "missing_issued_assignment_count": 0,
        "unmatched_exposure_event_count": 0,
        "missing_issued_assignment_ids": [],
        "unmatched_exposure_event_ids": [],
        "records": records,
    }


def write_census(
    root: Path,
    activation_path: Path,
    label_free: Sequence[dict[str, Any]],
    *,
    generated_at: str = "2027-08-02T11:00:00Z",
    unsealed_issuance_records: Sequence[Mapping[str, Any]] = (),
) -> Path:
    activation = json.loads(activation_path.read_text(encoding="utf-8"))
    protocol = load_protocol()
    roles = ("primary", "secondary", "exploratory", "quarantined")
    sources = [*protocol["recruitment"]["allowed_source_ids"], "not-applicable"]
    payload = {
        "protocol_id": protocol["protocol_id"],
        "protocol_version": protocol["protocol_version"],
        "activation_manifest_sha256": canonical_sha256(activation),
        # This is a public, schema-fixed protocol identifier, not query text or a credential.
        "query_id": protocol["recruitment"]["trusted_export_query_id"],
        "generated_at": generated_at,
        "query_watermark_start_at": protocol["enrollment"]["start_at"],
        "query_watermark_end_at": protocol["enrollment"]["end_at"],
        "enrollment_start_at": protocol["enrollment"]["start_at"],
        "enrollment_end_at": protocol["enrollment"]["end_at"],
        "eligible_source_count": len(label_free),
        "first_export_ordinal": 1 if label_free else None,
        "last_export_ordinal": len(label_free) if label_free else None,
        "status_counts": {
            role: sum(row["cohort_role"] == role for row in label_free)
            for role in roles
        },
        "recruitment_source_counts": {
            source: sum(
                (row["evidence"].get("recruitment_source_id") or "not-applicable")
                == source
                for row in label_free
            )
            for source in sources
        },
        "records": [
            {"export_ordinal": index, "label_free_evidence": deepcopy(row)}
            for index, row in enumerate(label_free, 1)
        ],
        "eligible_omissions": [],
        "issuance_reconciliation": build_issuance_reconciliation(
            label_free,
            protocol,
            reconciled_through_at=generated_at,
            unsealed_issuance_records=unsealed_issuance_records,
        ),
    }
    return sign_payload(
        root / "census.json",
        schema_version="castingcompass.validation-census-export/1.0.0",
        payload=payload,
    )


def fake_evaluator_identity(protocol: Mapping[str, Any]) -> dict[str, Any]:
    file_sha = {path: digest(f"file:{path}") for path in EVALUATOR_SOURCE_PATHS}
    lock_sha = file_sha["pipeline/requirements-validation.lock"]
    return {
        "release_commit": RELEASE_COMMIT,
        "tracked_source_tree_clean": True,
        "file_sha256": file_sha,
        "dependency_lock_sha256": lock_sha,
        "runtime_versions": {
            "python": "3.12.8",
            "python_implementation": "CPython",
            "narwhals": "2.24.0",
            "numpy": "2.0.2",
            "scipy": "1.13.1",
            "scikit-learn": "1.9.0",
            "cffi": "2.1.0",
            "cryptography": "48.0.1",
            "joblib": "1.5.3",
            "pycparser": "3.0",
            "threadpoolctl": "3.6.0",
        },
        "algorithm_config_sha256": _evaluator_algorithm_config_sha256(protocol),
        "runtime_image_digest": f"sha256:{'e' * 64}",
        "evaluator_environment_sha256": "f" * 64,
    }


def seal_finalization(
    root: Path,
    *,
    label_free_path: Path,
    ledger_path: Path,
    predictions_path: Path,
    census_path: Path,
    chain: Sequence[Path],
    sealed_at: str = "2027-08-02T12:00:00Z",
) -> Path:
    path = root / "finalization.json"
    identity = fake_evaluator_identity(load_protocol())
    seal_time = datetime.fromisoformat(sealed_at.replace("Z", "+00:00"))
    with trusted_clock(seal_time), patch(
        "pipeline.contourcast.validation_protocol.verify_release_commit_contains_protocol"
    ), patch(
        "pipeline.contourcast.validation_protocol.build_frozen_evaluator_identity",
        return_value=identity,
    ):
        seal_validation_finalization(
            output_path=path,
            label_free_evidence_path=label_free_path,
            opportunity_ledger_path=ledger_path,
            candidate_predictions_path=predictions_path,
            census_export_path=census_path,
            manifest_chain_paths=chain,
        )
    return path


def write_deletion_ledger(
    root: Path,
    activation_path: Path,
    finalization_path: Path,
    *,
    events: Sequence[Mapping[str, Any]] = (),
    sequence: int = 0,
    previous_envelope: Mapping[str, Any] | None = None,
    name: str | None = None,
    created_at: str = "2027-08-03T00:00:00Z",
    reconciled_through_at: str = "2027-08-03T00:00:00Z",
) -> Path:
    activation = json.loads(activation_path.read_text(encoding="utf-8"))
    finalization = json.loads(finalization_path.read_text(encoding="utf-8"))
    assignment_pairs = [
        {
            "assignment_id": item["assignment_id"],
            "source_record_sha256": item["source_record_sha256"],
        }
        for item in finalization["assignments"]
    ]
    payload = {
        "ledger_id": f"deletion-ledger-{sequence}",
        "sequence": sequence,
        "previous_ledger_sha256": (
            canonical_sha256(previous_envelope) if previous_envelope is not None else None
        ),
        "protocol_id": finalization["protocol_id"],
        "protocol_version": finalization["protocol_version"],
        "activation_manifest_sha256": canonical_sha256(activation),
        "finalization_manifest_sha256": canonical_sha256(finalization),
        "sealed_assignment_set_sha256": canonical_sha256(assignment_pairs),
        "created_at": created_at,
        "reconciled_through_at": reconciled_through_at,
        "events": [deepcopy(dict(event)) for event in events],
    }
    return sign_payload(
        root / (name or f"deletion-{sequence}.json"),
        schema_version="castingcompass.validation-deletion-reconciliation/1.0.0",
        payload=payload,
    )


def seal_label_lock(
    root: Path,
    finalization_path: Path,
    chain: Sequence[Path],
    *,
    sealed_at: datetime = LABEL_LOCKED_AT,
) -> Path:
    path = root / "label-lock.json"
    identity = fake_evaluator_identity(load_protocol())
    with trusted_clock(sealed_at), patch(
        "pipeline.contourcast.validation_protocol.verify_release_commit_contains_protocol"
    ), patch(
        "pipeline.contourcast.validation_protocol.verify_frozen_evaluator_identity",
        return_value=identity,
    ):
        seal_validation_label_lock(
            output_path=path,
            finalization_manifest_path=finalization_path,
            manifest_chain_paths=chain,
        )
    return path


def write_labeled_export(
    root: Path,
    activation_path: Path,
    finalization_path: Path,
    deletion_path: Path,
    label_lock_path: Path,
    labeled: Sequence[dict[str, Any]],
    *,
    name: str = "labeled-export.json",
    generated_at: str = "2027-08-04T01:00:00Z",
) -> Path:
    activation = json.loads(activation_path.read_text(encoding="utf-8"))
    finalization = json.loads(finalization_path.read_text(encoding="utf-8"))
    deletion = json.loads(deletion_path.read_text(encoding="utf-8"))
    label_lock = json.loads(label_lock_path.read_text(encoding="utf-8"))
    payload = {
        "protocol_id": finalization["protocol_id"],
        "protocol_version": finalization["protocol_version"],
        "activation_manifest_sha256": canonical_sha256(activation),
        "finalization_manifest_sha256": canonical_sha256(finalization),
        "deletion_reconciliation_sha256": canonical_sha256(deletion),
        "label_lock_manifest_sha256": canonical_sha256(label_lock),
        "generated_at": generated_at,
        "records": [deepcopy(row) for row in labeled],
    }
    return sign_payload(
        root / name,
        schema_version="castingcompass.validation-labeled-export/1.0.0",
        payload=payload,
    )


def build_sealed_bundle(
    root: Path,
    rows: Sequence[tuple[dict[str, Any], dict[str, Any]]],
) -> dict[str, Any]:
    activation = seal_activation(root)
    label_free_path, label_free, labeled = write_evidence_pair(
        root, rows, activation_path=activation
    )
    ledger, predictions = write_prediction_artifacts(root, label_free)
    batch = seal_batch(
        root,
        label_free_path=label_free_path,
        ledger_path=ledger,
        predictions_path=predictions,
        chain=[activation],
    )
    census = write_census(root, activation, label_free)
    finalization = seal_finalization(
        root,
        label_free_path=label_free_path,
        ledger_path=ledger,
        predictions_path=predictions,
        census_path=census,
        chain=[activation, batch],
    )
    deletion = write_deletion_ledger(root, activation, finalization)
    chain = [activation, batch, finalization]
    label_lock = seal_label_lock(root, finalization, chain)
    labeled_export = write_labeled_export(
        root, activation, finalization, deletion, label_lock, labeled
    )
    return {
        "activation": activation,
        "label_free_path": label_free_path,
        "label_free": label_free,
        "labeled": labeled,
        "ledger": ledger,
        "predictions": predictions,
        "batch": batch,
        "census": census,
        "finalization": finalization,
        "deletion": deletion,
        "label_lock": label_lock,
        "labeled_export": labeled_export,
        "chain": chain,
        "identity": fake_evaluator_identity(load_protocol()),
    }


def write_publication_audit(
    root: Path,
    request_path: Path,
    *,
    checked_at: datetime = TRUSTED_NOW,
) -> Path:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    payload = {
        key: deepcopy(request[key])
        for key in (
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
            "active_assignment_ids_sha256",
            "reconciliation_counts",
        )
    }
    checked = checked_at.astimezone(timezone.utc).replace(microsecond=0)
    checked_stamp = checked.isoformat().replace("+00:00", "Z")
    payload.update(
        {
            "publication_request_nonce": request["publication_request_nonce"],
            "publication_request_sha256": canonical_sha256(request),
            "trusted_publication_nonce": digest(
                f"trusted-publication-nonce:{request['publication_request_nonce']}"
            ),
            "trusted_publication_nonce_issued_at": checked_stamp,
            "trusted_publication_nonce_consumed_at": checked_stamp,
            "atomic_reconciliation_nonce_consumption_and_publication_completed": True,
            "production_artifact_sha256": digest("production-artifact"),
            "trusted_publication_service_attestation_sha256": digest(
                "trusted-publication-service"
            ),
            "independent_recomputation_completed": True,
            "recomputed_analysis_result_sha256": request["analysis_result_sha256"],
            "trusted_execution_attestation_sha256": digest("trusted-execution"),
            "checked_at": checked_stamp,
            "reconciled_through_at": checked_stamp,
        }
    )
    return sign_payload(
        root / "publication-audit.json",
        schema_version="castingcompass.validation-publication-audit/1.0.0",
        payload=payload,
    )


def evaluation_kwargs(bundle: Mapping[str, Any], output: Path) -> dict[str, Any]:
    return {
        "label_free_evidence_path": bundle["label_free_path"],
        "labeled_evidence_path": bundle["labeled_export"],
        "split_manifest_path": bundle["finalization"],
        "activation_manifest_path": bundle["activation"],
        "manifest_chain_paths": bundle["chain"],
        "opportunity_ledger_path": bundle["ledger"],
        "candidate_predictions_path": bundle["predictions"],
        "census_export_path": bundle["census"],
        "deletion_reconciliation_paths": [bundle["deletion"]],
        "label_lock_path": bundle["label_lock"],
        "label_access_receipt_path": output.with_name(
            f"{output.stem}.label-access-receipt.json"
        ),
        "output_path": output,
    }


def strong_rows() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    protocol = load_protocol()
    rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    index = 0
    for panel in protocol["geography"]["panels"]:
        site_id = panel["site_ids"][0]
        for within_panel in range(100):
            if within_panel < 50:
                block = "block-1" if within_panel % 2 == 0 else "block-2"
                encountered = within_panel % 2 == 0
            else:
                block = "block-3" if within_panel % 2 == 0 else "block-4"
                encountered = within_panel % 5 in {0, 1}
            rows.append(
                make_row(
                    index,
                    site_id=site_id,
                    block=block,
                    score=90 if encountered else 10,
                    encountered=encountered,
                )
            )
            index += 1
    return rows
