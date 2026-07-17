from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pipeline.contourcast.validation_protocol import (
    EVALUATOR_SOURCE_PATHS,
    EXPECTED_PROTOCOL_CANONICAL_SHA256,
    build_frozen_evaluator_identity,
    canonical_json_bytes,
    canonical_sha256,
    impression_attestation_payload,
    load_deletion_reconciliation_chain,
    load_manifest_chain,
    load_signed_labeled_export,
    load_split_manifest,
    load_trusted_census_export,
    load_validation_evidence,
    load_validation_protocol,
    map_trusted_collection_record,
    read_private_bytes_once,
    seal_validation_label_lock,
    seal_validation_splits,
    summarize_collection_provenance_events,
    validate_impression_attestation,
    score_exposure_attestation_payload,
    validate_score_exposure_attestation,
)
from pipeline.tests._validation_fixtures import (
    ACTIVATED_AT,
    PUBLIC_KEY_BASE64,
    RELEASE_COMMIT,
    SCORING_SHA,
    SCORING_VERSION,
    SIGNING_KEY_ID,
    bind_impression_attestation,
    build_sealed_bundle,
    completion_payload,
    digest,
    load_protocol,
    make_context_row,
    make_row,
    seal_activation,
    sign_payload,
    trusted_clock,
    validation_activation_identity,
    write_deletion_ledger,
    write_json,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class ValidationProtocolTests(unittest.TestCase):
    def test_frozen_protocol_and_all_shared_cross_runtime_vectors(self):
        protocol, protocol_sha = load_validation_protocol()
        self.assertEqual(protocol_sha, EXPECTED_PROTOCOL_CANONICAL_SHA256)

        recruitment = json.loads(
            (REPOSITORY_ROOT / "contracts/fixtures/recruitment-event-vector.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            canonical_json_bytes(recruitment["payload"]).decode("utf-8"),
            recruitment["canonical_json"],
        )
        self.assertEqual(
            canonical_sha256(recruitment["payload"]),
            recruitment["expected_recruitment_event_sha256"],
        )

        attestation = json.loads(
            (
                REPOSITORY_ROOT
                / "contracts/fixtures/impression-attestation-vector.json"
            ).read_text(encoding="utf-8")
        )
        attestation_row = attestation["label_free_evidence"]
        attestation_envelope = attestation_row["impression_attestation"]
        self.assertEqual(
            impression_attestation_payload(attestation_row),
            attestation["expected_payload"],
        )
        self.assertEqual(
            canonical_json_bytes(attestation["expected_payload"]).decode("utf-8"),
            attestation["expected_canonical_payload_json"],
        )
        self.assertEqual(
            hashlib.sha256(
                attestation["expected_canonical_payload_json"].encode("utf-8")
            ).hexdigest(),
            attestation["expected_payload_sha256"],
        )
        self.assertEqual(
            canonical_sha256(attestation_envelope),
            attestation["expected_envelope_canonical_sha256"],
        )
        self.assertEqual(
            validate_impression_attestation(
                attestation_row,
                activation={
                    "validation_export_signing_key_id": SIGNING_KEY_ID,
                    "validation_export_public_key_ed25519": attestation[
                        "public_key_ed25519_base64"
                    ],
                    "scoring_system_kind": "heuristic-configuration",
                    "scoring_system_version": SCORING_VERSION,
                    "scoring_system_sha256": SCORING_SHA,
                    "opportunity_contract_version": "castingcompass.opportunity/2.0.0",
                },
            ),
            attestation["expected_payload"],
        )
        self.assertEqual(
            score_exposure_attestation_payload(attestation_row),
            attestation["expected_score_exposure_payload"],
        )
        self.assertEqual(
            canonical_json_bytes(
                attestation["expected_score_exposure_payload"]
            ).decode("utf-8"),
            attestation["expected_score_exposure_canonical_payload_json"],
        )
        self.assertEqual(
            validate_score_exposure_attestation(
                attestation_row,
                activation=validation_activation_identity(),
            ),
            attestation["expected_score_exposure_payload"],
        )
        expected_participant = "participant-" + hashlib.sha256(
            (
                recruitment["participant_token_domain"]
                + "\0"
                + recruitment["reporter_key_hash_input"]
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(expected_participant, recruitment["expected_participant_group_id"])

        completion = json.loads(
            (REPOSITORY_ROOT / "contracts/fixtures/completion-event-vector.json").read_text(
                encoding="utf-8"
            )
        )
        source_sha = hashlib.sha256(
            (completion["source_record_domain"] + "\0" + completion["immutable_trip_id"]).encode()
        ).hexdigest()
        effort_id = "effort-" + hashlib.sha256(
            (completion["effort_segment_domain"] + "\0" + completion["immutable_trip_id"]).encode()
        ).hexdigest()
        assignment_id = "assignment-" + hashlib.sha256(
            (
                completion["assignment_domain"]
                + "\0"
                + completion["validation_protocol_id"]
                + "\0"
                + source_sha
            ).encode()
        ).hexdigest()
        self.assertEqual(source_sha, completion["expected_source_record_sha256"])
        self.assertEqual(effort_id, completion["expected_effort_segment_id"])
        self.assertEqual(assignment_id, completion["expected_assignment_id"])
        self.assertEqual(canonical_json_bytes(completion["payload"]).decode(), completion["canonical_json"])
        self.assertEqual(canonical_sha256(completion["payload"]), completion["expected_completion_event_sha256"])
        self.assertEqual(
            completion["payload"]["person_milliseconds"],
            completion["payload"]["duration_milliseconds"]
            * completion["payload"]["angler_count"],
        )

        mapping = json.loads(
            (REPOSITORY_ROOT / "contracts/fixtures/validation-export-mapping-vector.json").read_text(
                encoding="utf-8"
            )
        )
        for case in mapping["cases"]:
            raw = case["raw_collection"]
            expected_chain = summarize_collection_provenance_events(raw["provenance_events"])
            for field, value in expected_chain.items():
                self.assertEqual(raw[field], value, case["id"])
            if case["expected_secondary_admission_allowed"]:
                self.assertEqual(
                    map_trusted_collection_record(raw, protocol),
                    case["expected_evaluator_mapping"],
                )
            else:
                with self.assertRaises(ValueError, msg=case["id"]):
                    map_trusted_collection_record(raw, protocol)
            self.assertFalse(case["promotion_bearing"])
        valid = deepcopy(mapping["cases"][0]["raw_collection"])
        valid["collection_provenance_chain_sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            map_trusted_collection_record(valid, protocol)

    def test_evidence_boundary_rejects_multiangler_primary_chain_spoof_and_duplicate_attempts(self):
        protocol, _ = load_validation_protocol()
        site = protocol["geography"]["panels"][0]["site_ids"][0]
        primary = make_row(10, site_id=site, block="block-1", score=60, encountered=False)[0]
        secondary = make_row(
            11,
            site_id=site,
            block="block-1",
            score=60,
            encountered=False,
            cohort_role="secondary",
            angler_count=3,
        )[0]
        with tempfile.TemporaryDirectory() as directory, trusted_clock():
            root = Path(directory)
            self.assertEqual(
                len(
                    load_validation_evidence(
                        write_json(root / "primary.json", [primary]),
                        protocol,
                        include_outcomes=False,
                        activated_at=ACTIVATED_AT,
                        activation=validation_activation_identity(),
                    )
                ),
                1,
            )
            self.assertEqual(
                len(
                    load_validation_evidence(
                        write_json(root / "secondary.json", [secondary]),
                        protocol,
                        include_outcomes=False,
                        activated_at=ACTIVATED_AT,
                        activation=validation_activation_identity(),
                    )
                ),
                1,
            )
            multi = deepcopy(primary)
            multi["evidence"]["angler_count"] = 2
            multi["evidence"]["person_milliseconds"] *= 2
            multi["evidence"]["completion_event_sha256"] = canonical_sha256(
                completion_payload(multi)
            )
            multi["evidence"]["group_composition_id"] = "invented"
            with self.assertRaises(ValueError):
                load_validation_evidence(
                    write_json(root / "multi.json", [multi]),
                    protocol,
                    include_outcomes=False,
                    activated_at=ACTIVATED_AT,
                    activation=validation_activation_identity(),
                )
            chain_spoof = deepcopy(secondary)
            chain_spoof["evidence"]["collection_event_type_counts"]["evidence_exclusion"] = 1
            chain_spoof["evidence"]["collection_terminal_event_type"] = "evidence_exclusion"
            with self.assertRaises(ValueError):
                load_validation_evidence(
                    write_json(root / "chain-spoof.json", [chain_spoof]),
                    protocol,
                    include_outcomes=False,
                    activated_at=ACTIVATED_AT,
                    activation=validation_activation_identity(),
                )
            wrong_method = deepcopy(secondary)
            wrong_method["evidence"]["collection_selection_method"] = "safe_randomized"
            with self.assertRaises(ValueError):
                load_validation_evidence(
                    write_json(root / "wrong-method.json", [wrong_method]),
                    protocol,
                    include_outcomes=False,
                    activated_at=ACTIVATED_AT,
                    activation=validation_activation_identity(),
                )
            float_score = deepcopy(primary)
            float_score["opportunity_score"] = 60.0
            with self.assertRaises(ValueError):
                load_validation_evidence(
                    write_json(root / "float-score.json", [float_score]),
                    protocol,
                    include_outcomes=False,
                    activated_at=ACTIVATED_AT,
                    activation=validation_activation_identity(),
                )

            fractional_window = deepcopy(primary)
            fractional_window["evidence"]["window_end_at"] = (
                "2026-08-15T12:00:00.999Z"
            )
            with self.assertRaisesRegex(ValueError, "exactly two hours"):
                load_validation_evidence(
                    write_json(root / "fractional-window.json", [fractional_window]),
                    protocol,
                    include_outcomes=False,
                    activated_at=ACTIVATED_AT,
                    activation=validation_activation_identity(),
                )

            duplicate = deepcopy(primary)
            duplicate["assignment_id"] = f"assignment-{digest('different-assignment')}"
            duplicate["source_record_sha256"] = digest("different-source")
            duplicate["evidence"]["opportunity_window_id"] = "opaque-different-window-id"
            duplicate["evidence"]["effort_segment_id"] = f"effort-{digest('different-effort')}"
            duplicate["evidence"]["window_start_at"] = "2026-08-15T10:00:00+00:00"
            duplicate["evidence"]["window_end_at"] = "2026-08-15T12:00:00+00:00"
            duplicate["evidence"]["segment_start_at"] = "2026-08-15T11:45:00.000Z"
            duplicate["evidence"]["segment_end_at"] = "2026-08-15T12:00:00.000Z"
            duplicate["evidence"]["duration_milliseconds"] = 15 * 60 * 1000
            duplicate["evidence"]["person_milliseconds"] = 15 * 60 * 1000
            duplicate["evidence"]["completion_event_at"] = "2026-08-15T12:00:00.000Z"
            duplicate["evidence"]["completion_consented_at"] = "2026-08-15T12:00:00.000Z"
            duplicate["evidence"]["collection_event_id"] = "validation-completion-offset"
            duplicate["evidence"]["collection_event_at"] = "2026-08-15T12:00:00.000Z"
            duplicate["evidence"].update(
                summarize_collection_provenance_events(
                    [
                        {
                            "id": "validation-enrollment-10",
                            "event_type": "enrollment",
                            "created_at": duplicate["evidence"]["recruitment_event_at"],
                            "exclusion_reason": None,
                        },
                        {
                            "id": "validation-completion-offset",
                            "event_type": "completion",
                            "created_at": "2026-08-15T12:00:00.000Z",
                            "exclusion_reason": None,
                        },
                    ]
                )
            )
            duplicate["evidence"]["completion_event_sha256"] = canonical_sha256(
                completion_payload(duplicate)
            )
            with self.assertRaisesRegex(ValueError, "participant opportunity window"):
                load_validation_evidence(
                    write_json(root / "duplicate-window.json", [primary, duplicate]),
                    protocol,
                    include_outcomes=False,
                    activated_at=ACTIVATED_AT,
                    activation=validation_activation_identity(),
                )

    def test_signed_census_rejects_wrong_key_mutation_duplicate_float_and_noncanonical_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(
                root,
                [make_row(20, site_id="limantour-beach", block="block-1", score=70, encountered=True)],
            )
            protocol, protocol_sha = load_validation_protocol()
            with trusted_clock():
                activation = load_split_manifest(
                    bundle["activation"], protocol, protocol_sha
                )
                evidence = load_validation_evidence(
                    bundle["label_free_path"],
                    protocol,
                    include_outcomes=False,
                    activated_at=activation["activated_at"],
                    activation_manifest_sha256=canonical_sha256(activation),
                    activation=activation["activation"],
                )
                valid = load_trusted_census_export(
                    bundle["census"], protocol, activation, evidence=evidence
                )
            envelope = valid["envelope"]
            payload_bytes = base64.b64decode(envelope["payload_base64"])
            payload = json.loads(payload_bytes)
            wrong_key = Ed25519PrivateKey.generate()
            cases: list[Path] = []
            cases.append(
                sign_payload(
                    root / "wrong-key.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=payload,
                    private_key=wrong_key,
                )
            )
            mutated = deepcopy(envelope)
            signature = bytearray(base64.b64decode(mutated["signature_ed25519"]))
            signature[0] ^= 1
            mutated["signature_ed25519"] = base64.b64encode(signature).decode()
            cases.append(write_json(root / "mutated-signature.json", mutated))
            cases.append(
                sign_payload(
                    root / "noncanonical.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=payload,
                    payload_bytes=json.dumps(payload, indent=2, sort_keys=False).encode(),
                )
            )
            floating = deepcopy(payload)
            floating["eligible_source_count"] = 1.0
            cases.append(
                sign_payload(
                    root / "float.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=floating,
                )
            )
            duplicate_bytes = payload_bytes.replace(
                b"{", b'{"protocol_id":"duplicate",', 1
            )
            cases.append(
                sign_payload(
                    root / "duplicate-key.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=payload,
                    payload_bytes=duplicate_bytes,
                )
            )
            unicode_bytes = payload_bytes.replace(
                b"california-halibut", b"california\\u002dhalibut", 1
            )
            cases.append(
                sign_payload(
                    root / "unicode-escape.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=payload,
                    payload_bytes=unicode_bytes,
                )
            )
            with trusted_clock():
                for path in cases:
                    with self.subTest(path=path.name), self.assertRaises(ValueError):
                        load_trusted_census_export(path, protocol, activation, evidence=evidence)

    def test_semantic_loaders_reject_boolean_integer_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(
                root,
                [
                    make_row(
                        29,
                        site_id="limantour-beach",
                        block="block-1",
                        score=50,
                        encountered=False,
                    )
                ],
            )
            protocol, protocol_sha = load_validation_protocol()
            activation = json.loads(bundle["activation"].read_text())
            census_envelope = json.loads(bundle["census"].read_text())
            census_payload = json.loads(
                base64.b64decode(census_envelope["payload_base64"])
            )
            census_cases: list[Path] = []
            first_ordinal = deepcopy(census_payload)
            first_ordinal["first_export_ordinal"] = True
            census_cases.append(
                sign_payload(
                    root / "bool-first-ordinal.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=first_ordinal,
                )
            )
            status_count = deepcopy(census_payload)
            status_count["status_counts"]["primary"] = True
            census_cases.append(
                sign_payload(
                    root / "bool-status-count.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=status_count,
                )
            )
            source_count = deepcopy(census_payload)
            source_count["recruitment_source_counts"][
                "castingcompass-organic-product"
            ] = True
            census_cases.append(
                sign_payload(
                    root / "bool-source-count.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=source_count,
                )
            )
            exact_row_alias = deepcopy(census_payload)
            exact_row_alias["records"][0]["label_free_evidence"][
                "server_attested"
            ] = 1
            census_cases.append(
                sign_payload(
                    root / "bool-exact-row-alias.json",
                    schema_version="castingcompass.validation-census-export/1.0.0",
                    payload=exact_row_alias,
                )
            )
            with trusted_clock():
                for path in census_cases:
                    with self.subTest(path=path.name), self.assertRaises(ValueError):
                        load_trusted_census_export(
                            path,
                            protocol,
                            activation,
                            evidence=bundle["label_free"],
                        )

            bool_aggregate = json.loads(bundle["batch"].read_text())
            bool_aggregate["aggregate_counts"]["total_assignments"] = True
            bool_aggregate_path = write_json(
                root / "bool-aggregate.json", bool_aggregate
            )
            bool_eligible = json.loads(bundle["finalization"].read_text())
            bool_eligible["finalization"]["eligible_source_count"] = True
            bool_eligible_path = write_json(root / "bool-eligible.json", bool_eligible)
            with trusted_clock():
                for path in (bool_aggregate_path, bool_eligible_path):
                    with self.subTest(path=path.name), self.assertRaises(ValueError):
                        load_split_manifest(path, protocol, protocol_sha)

            attempt = make_row(
                291,
                site_id="limantour-beach",
                block="block-1",
                score=50,
                encountered=False,
            )
            attempt[0]["evidence"]["attempt_count"] = True
            attempt[1]["evidence"]["attempt_count"] = True
            from pipeline.tests._validation_fixtures import bind_rows_to_activation

            bind_rows_to_activation([attempt], bundle["activation"])
            attempt_path = write_json(root / "bool-attempt.json", [attempt[0]])
            with self.assertRaisesRegex(ValueError, "attempt_count"):
                load_validation_evidence(
                    attempt_path,
                    protocol,
                    include_outcomes=False,
                    activated_at=activation["activated_at"],
                    activation_manifest_sha256=canonical_sha256(activation),
                    activation=activation["activation"],
                )

            randomized = make_row(
                292,
                site_id="limantour-beach",
                block="block-1",
                score=50,
                encountered=False,
                selection_design="prospective-safely-randomized",
            )
            for row in randomized:
                row["evidence"]["assignment_probability_numerator"] = True
            bind_rows_to_activation([randomized], bundle["activation"])
            randomized_path = write_json(
                root / "bool-probability.json", [randomized[0]]
            )
            with self.assertRaisesRegex(ValueError, "probability"):
                load_validation_evidence(
                    randomized_path,
                    protocol,
                    include_outcomes=False,
                    activated_at=activation["activated_at"],
                    activation_manifest_sha256=canonical_sha256(activation),
                    activation=activation["activation"],
                )

            boolean_counts = make_row(
                293,
                site_id="limantour-beach",
                block="block-1",
                score=50,
                encountered=False,
            )
            for row in boolean_counts:
                row["evidence"]["collection_event_type_counts"] = {
                    "enrollment": True,
                    "completion": True,
                    "evidence_exclusion": False,
                    "retrospective_submission": False,
                    "legacy_context": False,
                }
            bind_rows_to_activation([boolean_counts], bundle["activation"])
            boolean_counts_path = write_json(
                root / "bool-collection-counts.json", [boolean_counts[0]]
            )
            with self.assertRaisesRegex(ValueError, "role/status/cohort"):
                load_validation_evidence(
                    boolean_counts_path,
                    protocol,
                    include_outcomes=False,
                    activated_at=activation["activated_at"],
                    activation_manifest_sha256=canonical_sha256(activation),
                    activation=activation["activation"],
                )

    def test_deletion_chain_omits_exact_withdrawn_row_and_labeled_signature_is_fail_closed(self):
        rows = [
            make_row(30, site_id="limantour-beach", block="block-1", score=20, encountered=False),
            make_row(31, site_id="limantour-beach", block="block-2", score=80, encountered=True),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(root, rows)
            activation = json.loads(bundle["activation"].read_text())
            finalization = json.loads(bundle["finalization"].read_text())
            manifest_chain = [
                json.loads(path.read_text()) for path in bundle["chain"]
            ]
            initial_envelope = json.loads(bundle["deletion"].read_text())
            removed = bundle["label_free"][0]
            regressed = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                sequence=1,
                previous_envelope=initial_envelope,
                name="deletion-regressed.json",
                created_at="2027-08-02T23:00:00Z",
                reconciled_through_at="2027-08-02T23:00:00Z",
            )
            protocol, _ = load_validation_protocol()
            with trusted_clock(), self.assertRaisesRegex(
                ValueError, "complete manifest chain"
            ):
                load_deletion_reconciliation_chain(
                    [bundle["deletion"]],
                    protocol,
                    activation,
                    finalization,
                )
            fabricated_chain = deepcopy(manifest_chain)
            fabricated_chain[1]["created_at"] = "2026-07-31T00:00:00Z"
            with trusted_clock(), self.assertRaisesRegex(
                ValueError, "sequence/role/hash|chronology"
            ):
                load_deletion_reconciliation_chain(
                    [bundle["deletion"]],
                    protocol,
                    activation,
                    finalization,
                    manifest_chain=fabricated_chain,
                )
            with trusted_clock(), self.assertRaisesRegex(ValueError, "regressed"):
                load_deletion_reconciliation_chain(
                    [bundle["deletion"], regressed],
                    protocol,
                    activation,
                    finalization,
                    manifest_chain=manifest_chain,
                )

            omitted_prior_event = {
                "event_id": "omitted-prior-event",
                "assignment_id": removed["assignment_id"],
                "source_record_sha256": removed["source_record_sha256"],
                "status": "withdrawn",
                "reason": "participant-withdrawal",
                "occurred_at": "2027-08-02T18:00:00Z",
                "source_event_sha256": digest("omitted-prior-event"),
            }
            omitted = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                events=[omitted_prior_event],
                sequence=1,
                previous_envelope=initial_envelope,
                name="deletion-omitted-prior.json",
                created_at="2027-08-03T13:00:00Z",
                reconciled_through_at="2027-08-03T13:00:00Z",
            )
            with trusted_clock(), self.assertRaisesRegex(
                ValueError, "predecessor reconciliation watermark"
            ):
                load_deletion_reconciliation_chain(
                    [bundle["deletion"], omitted],
                    protocol,
                    activation,
                    finalization,
                    manifest_chain=manifest_chain,
                )
            event = {
                "event_id": "withdrawal-event-1",
                "assignment_id": removed["assignment_id"],
                "source_record_sha256": removed["source_record_sha256"],
                "status": "withdrawn",
                "reason": "participant-withdrawal",
                "occurred_at": "2027-08-03T12:00:00Z",
                "source_event_sha256": digest("withdrawal-source-event"),
            }
            second = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                events=[event],
                sequence=1,
                previous_envelope=initial_envelope,
                name="deletion-1.json",
                created_at="2027-08-03T13:00:00Z",
                reconciled_through_at="2027-08-03T13:00:00Z",
            )
            with trusted_clock():
                deletion = load_deletion_reconciliation_chain(
                    [bundle["deletion"], second],
                    protocol,
                    activation,
                    finalization,
                    manifest_chain=manifest_chain,
                )
            active_labeled = [
                row
                for row in bundle["labeled"]
                if row["assignment_id"] in deletion["active_assignment_ids"]
            ]
            from pipeline.tests._validation_fixtures import write_labeled_export

            active_export = write_labeled_export(
                root,
                bundle["activation"],
                bundle["finalization"],
                second,
                bundle["label_lock"],
                active_labeled,
                name="active-labeled.json",
            )
            with trusted_clock():
                labeled, signed = load_signed_labeled_export(
                    active_export,
                    protocol,
                    activation,
                    finalization,
                    deletion,
                    json.loads(bundle["label_lock"].read_text()),
                    raw_envelope_bytes=read_private_bytes_once(
                        active_export, artifact="active labeled export"
                    ),
                )
            self.assertEqual([row["assignment_id"] for row in labeled], deletion["active_assignment_ids"])
            self.assertEqual(len(signed["file_sha256"]), 64)

            changed_active_labeled = deepcopy(active_labeled)
            changed_active_labeled[0]["opportunity_score"] -= 1
            bind_impression_attestation(changed_active_labeled[0])
            changed_active_export = write_labeled_export(
                root,
                bundle["activation"],
                bundle["finalization"],
                second,
                bundle["label_lock"],
                changed_active_labeled,
                name="changed-active-labeled.json",
            )
            with trusted_clock(), self.assertRaisesRegex(
                ValueError, "sealed finalization assignment"
            ):
                load_signed_labeled_export(
                    changed_active_export,
                    protocol,
                    activation,
                    finalization,
                    deletion,
                    json.loads(bundle["label_lock"].read_text()),
                    raw_envelope_bytes=read_private_bytes_once(
                        changed_active_export,
                        artifact="changed active labeled export",
                    ),
                )

            analytically_excluded = bundle["label_free"][1]
            exclusion_event = {
                "event_id": "exclusion-event-1",
                "assignment_id": analytically_excluded["assignment_id"],
                "source_record_sha256": analytically_excluded[
                    "source_record_sha256"
                ],
                "status": "excluded",
                "reason": "post_completion_profile_edit",
                "occurred_at": "2027-08-03T12:00:00Z",
                "source_event_sha256": digest("exclusion-source-event"),
            }
            exclusion_ledger = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                events=[exclusion_event],
                sequence=1,
                previous_envelope=initial_envelope,
                name="deletion-excluded.json",
                created_at="2027-08-03T13:00:00Z",
                reconciled_through_at="2027-08-03T13:00:00Z",
            )
            withdrawal_after_exclusion = {
                **exclusion_event,
                "event_id": "withdrawal-after-exclusion",
                "status": "withdrawn",
                "reason": "participant-withdrawal",
                "occurred_at": "2027-08-04T12:00:00Z",
                "source_event_sha256": digest("withdrawal-after-exclusion"),
            }
            repeated_exclusion = {
                **exclusion_event,
                "event_id": "repeated-exclusion",
                "reason": "trusted_review_exclusion",
                "occurred_at": "2027-08-04T11:00:00Z",
                "source_event_sha256": digest("repeated-exclusion"),
            }
            exclusion_envelope = json.loads(exclusion_ledger.read_text())
            privacy_ledger = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                events=[
                    exclusion_event,
                    repeated_exclusion,
                    withdrawal_after_exclusion,
                ],
                sequence=2,
                previous_envelope=exclusion_envelope,
                name="deletion-excluded-then-withdrawn.json",
                created_at="2027-08-04T13:00:00Z",
                reconciled_through_at="2027-08-04T13:00:00Z",
            )
            with trusted_clock():
                lifecycle = load_deletion_reconciliation_chain(
                    [bundle["deletion"], exclusion_ledger, privacy_ledger],
                    protocol,
                    activation,
                    finalization,
                    manifest_chain=manifest_chain,
                )
            assignment_id = analytically_excluded["assignment_id"]
            self.assertEqual(
                lifecycle["first_removal_status"][assignment_id], "excluded"
            )
            self.assertEqual(
                lifecycle["first_removal_reason"][assignment_id],
                "post_completion_profile_edit",
            )
            self.assertEqual(lifecycle["removed_status"][assignment_id], "withdrawn")
            self.assertIn(assignment_id, lifecycle["ever_excluded_assignment_ids"])

            duplicate_source_event = {
                **withdrawal_after_exclusion,
                "event_id": "delete-with-replayed-source",
                "status": "deleted",
                "reason": "account-deletion",
                "occurred_at": "2027-08-05T12:00:00Z",
                "source_event_sha256": exclusion_event["source_event_sha256"],
            }
            duplicate_source_ledger = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                events=[
                    exclusion_event,
                    repeated_exclusion,
                    withdrawal_after_exclusion,
                    duplicate_source_event,
                ],
                sequence=3,
                previous_envelope=json.loads(privacy_ledger.read_text()),
                name="deletion-replayed-source.json",
                created_at="2027-08-05T13:00:00Z",
                reconciled_through_at="2027-08-05T13:00:00Z",
            )
            with trusted_clock(), self.assertRaisesRegex(
                ValueError, "source event SHA-256"
            ):
                load_deletion_reconciliation_chain(
                    [
                        bundle["deletion"],
                        exclusion_ledger,
                        privacy_ledger,
                        duplicate_source_ledger,
                    ],
                    protocol,
                    activation,
                    finalization,
                    manifest_chain=manifest_chain,
                )

            pre_seal_event = {
                **exclusion_event,
                "event_id": "pre-first-seal",
                "occurred_at": "2027-08-01T23:59:59Z",
                "source_event_sha256": digest("pre-first-seal"),
            }
            pre_seal_ledger = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                events=[pre_seal_event],
                sequence=1,
                previous_envelope=initial_envelope,
                name="deletion-pre-first-seal.json",
                created_at="2027-08-04T13:00:00Z",
                reconciled_through_at="2027-08-04T13:00:00Z",
            )
            with trusted_clock(), self.assertRaisesRegex(
                ValueError, "after its assignment seal"
            ):
                load_deletion_reconciliation_chain(
                    [bundle["deletion"], pre_seal_ledger],
                    protocol,
                    activation,
                    finalization,
                    manifest_chain=manifest_chain,
                )

            tampered = json.loads(active_export.read_text())
            raw_payload = bytearray(base64.b64decode(tampered["payload_base64"]))
            raw_payload[-2] ^= 1
            tampered["payload_base64"] = base64.b64encode(raw_payload).decode()
            tampered["payload_sha256"] = hashlib.sha256(raw_payload).hexdigest()
            bad = write_json(root / "tampered-labeled.json", tampered)
            with trusted_clock(), self.assertRaises(ValueError):
                load_signed_labeled_export(
                    bad,
                    protocol,
                    activation,
                    finalization,
                    deletion,
                    json.loads(bundle["label_lock"].read_text()),
                    raw_envelope_bytes=read_private_bytes_once(
                        bad, artifact="tampered labeled export"
                    ),
                )

    def test_manifest_chain_finalization_and_private_permissions_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(
                root,
                [make_row(40, site_id="limantour-beach", block="block-1", score=50, encountered=False)],
            )
            protocol, protocol_sha = load_validation_protocol()
            with trusted_clock():
                chain = load_manifest_chain(bundle["chain"], protocol, protocol_sha)
            self.assertEqual([item["manifest_role"] for item in chain], ["activation", "assignment-batch", "finalization"])
            self.assertEqual(
                chain[-1]["finalization"]["evaluator_identity"], bundle["identity"]
            )
            os.chmod(bundle["label_free_path"], 0o644)
            with self.assertRaises(ValueError):
                load_validation_evidence(
                    bundle["label_free_path"],
                    protocol,
                    include_outcomes=False,
                )

            activation = seal_activation(root / "early")
            row = make_row(41, site_id="limantour-beach", block="block-1", score=50, encountered=False)
            from pipeline.tests._validation_fixtures import (
                bind_rows_to_activation,
                seal_batch,
                seal_finalization,
                write_census,
                write_prediction_artifacts,
            )

            bind_rows_to_activation([row], activation)
            label_free = write_json(root / "early/label-free.json", [row[0]])
            ledger, predictions = write_prediction_artifacts(root / "early", [row[0]])
            batch = seal_batch(
                root / "early",
                label_free_path=label_free,
                ledger_path=ledger,
                predictions_path=predictions,
                chain=[activation],
            )
            census = write_census(root / "early", activation, [row[0]])
            with self.assertRaises(ValueError):
                seal_finalization(
                    root / "early",
                    label_free_path=label_free,
                    ledger_path=ledger,
                    predictions_path=predictions,
                    census_path=census,
                    chain=[activation, batch],
                    sealed_at="2027-07-31T23:59:59Z",
                )

    def test_signed_impression_attestation_and_prior_scores_are_immutable(self):
        from pipeline.tests._validation_fixtures import (
            bind_rows_to_activation,
            seal_batch,
            write_prediction_artifacts,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activation = seal_activation(root)
            first = make_row(
                42,
                site_id="limantour-beach",
                block="block-1",
                score=10,
                encountered=False,
            )
            bind_rows_to_activation([first], activation)

            influence_flip = deepcopy(first[0])
            influence_flip["evidence"]["score_influenced_choice"] = True
            with self.assertRaisesRegex(ValueError, "does not match the exact evidence row"):
                validate_impression_attestation(influence_flip)

            source_flip = deepcopy(first[0])
            source_evidence = source_flip["evidence"]
            source_evidence["recruitment_source_id"] = "direct-opt-in-research-invite"
            source_evidence["recruitment_event_sha256"] = canonical_sha256(
                {
                    "participant_group_id": source_flip["participant_group_id"],
                    "recruitment_frame_id": source_evidence["recruitment_frame_id"],
                    "recruitment_source_id": source_evidence["recruitment_source_id"],
                    "recruitment_event_at": source_evidence["recruitment_event_at"],
                    "community_approval_sha256": None,
                }
            )
            source_flip_path = write_json(
                root / "source-flip/label-free.json", [source_flip]
            )
            source_flip_ledger, source_flip_predictions = write_prediction_artifacts(
                root / "source-flip", [source_flip]
            )
            with self.assertRaisesRegex(
                ValueError, "impression attestation does not match"
            ):
                seal_batch(
                    root / "source-flip",
                    label_free_path=source_flip_path,
                    ledger_path=source_flip_ledger,
                    predictions_path=source_flip_predictions,
                    chain=[activation],
                )

            forged = deepcopy(first[0])
            forged["opportunity_score"] = 99
            forged["evidence"]["impression_attestation_sha256"] = "f" * 64
            forged_path = write_json(root / "forged/label-free.json", [forged])
            forged_ledger, forged_predictions = write_prediction_artifacts(
                root / "forged", [forged]
            )
            with self.assertRaisesRegex(
                ValueError, "impression attestation does not match|envelope SHA-256"
            ):
                seal_batch(
                    root / "forged",
                    label_free_path=forged_path,
                    ledger_path=forged_ledger,
                    predictions_path=forged_predictions,
                    chain=[activation],
                )

            first_path = write_json(root / "first/label-free.json", [first[0]])
            first_ledger, first_predictions = write_prediction_artifacts(
                root / "first", [first[0]]
            )
            batch = seal_batch(
                root,
                label_free_path=first_path,
                ledger_path=first_ledger,
                predictions_path=first_predictions,
                chain=[activation],
            )

            second = make_row(
                43,
                site_id="drakes-beach",
                block="block-1",
                score=50,
                encountered=False,
            )
            bind_rows_to_activation([second], activation)
            rewritten_first = deepcopy(first[0])
            rewritten_first["opportunity_score"] = 99
            bind_impression_attestation(rewritten_first)
            cumulative = [rewritten_first, second[0]]
            cumulative_path = write_json(
                root / "cumulative/label-free.json", cumulative
            )
            cumulative_ledger, cumulative_predictions = write_prediction_artifacts(
                root / "cumulative", cumulative
            )
            with self.assertRaisesRegex(ValueError, "moved or changed"):
                seal_batch(
                    root,
                    label_free_path=cumulative_path,
                    ledger_path=cumulative_ledger,
                    predictions_path=cumulative_predictions,
                    chain=[activation, batch],
                    name="batch-2.json",
                )

    def test_seals_use_trusted_clock_and_label_lock_rechecks_runtime_before_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            late_root = root / "late"
            late_root.mkdir(mode=0o700)
            with trusted_clock(datetime(2027, 8, 2, tzinfo=timezone.utc)), patch(
                "pipeline.contourcast.validation_protocol.verify_release_commit_contains_protocol"
            ), self.assertRaisesRegex(ValueError, "before the enrollment interval"):
                seal_validation_splits(
                    output_path=late_root / "activation.json",
                    release_commit=RELEASE_COMMIT,
                    scoring_system_kind="heuristic-configuration",
                    scoring_system_version=SCORING_VERSION,
                    scoring_system_sha256=SCORING_SHA,
                    opportunity_contract_version="castingcompass.opportunity/2.0.0",
                    validation_export_signing_key_id=SIGNING_KEY_ID,
                    validation_export_public_key_ed25519=PUBLIC_KEY_BASE64,
                )
            with self.assertRaises(TypeError):
                seal_validation_splits(  # type: ignore[call-arg]
                    output_path=late_root / "backdated.json",
                    created_at="2026-07-31T00:00:00Z",
                )

            bundle = build_sealed_bundle(
                root,
                [
                    make_row(
                        45,
                        site_id="limantour-beach",
                        block="block-1",
                        score=50,
                        encountered=False,
                    )
                ],
            )
            protocol, protocol_sha = load_validation_protocol()
            activation_document = json.loads(bundle["activation"].read_text())
            equal_key_id = deepcopy(activation_document)
            equal_key_id["activation"]["external_log_anchor_signing_key_id"] = (
                equal_key_id["activation"]["validation_export_signing_key_id"]
            )
            equal_key_id_path = write_json(
                root / "equal-anchor-key-id.json", equal_key_id
            )
            equal_key_bytes = deepcopy(activation_document)
            equal_key_bytes["activation"][
                "external_log_anchor_public_key_ed25519"
            ] = equal_key_bytes["activation"][
                "validation_export_public_key_ed25519"
            ]
            equal_key_bytes_path = write_json(
                root / "equal-anchor-key-bytes.json", equal_key_bytes
            )
            with trusted_clock():
                for path in (equal_key_id_path, equal_key_bytes_path):
                    with self.subTest(path=path.name), self.assertRaisesRegex(
                        ValueError, "anchor must differ"
                    ):
                        load_split_manifest(path, protocol, protocol_sha)
            rejected_lock = root / "runtime-mismatch-label-lock.json"
            with trusted_clock(), patch(
                "pipeline.contourcast.validation_protocol.verify_release_commit_contains_protocol"
            ), patch(
                "pipeline.contourcast.validation_protocol.verify_frozen_evaluator_identity",
                side_effect=ValueError("runtime image mismatch"),
            ), self.assertRaisesRegex(ValueError, "runtime image mismatch"):
                seal_validation_label_lock(
                    output_path=rejected_lock,
                    finalization_manifest_path=bundle["finalization"],
                    manifest_chain_paths=bundle["chain"],
                )
            self.assertFalse(rejected_lock.exists())

    def test_nonissued_context_round_trips_without_prospective_completion_identity(self):
        from pipeline.tests._validation_fixtures import (
            seal_batch,
            seal_finalization,
            write_census,
            write_prediction_artifacts,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activation = seal_activation(root)
            context_pair = make_context_row(49)
            context_path = write_json(root / "context.json", [context_pair[0]])
            protocol, _ = load_validation_protocol()
            activation_document = json.loads(activation.read_text())
            loaded = load_validation_evidence(
                context_path,
                protocol,
                include_outcomes=False,
                activated_at=activation_document["activated_at"],
                activation_manifest_sha256=canonical_sha256(activation_document),
                activation=activation_document["activation"],
            )
            self.assertEqual(loaded[0]["cohort_role"], "exploratory")
            self.assertFalse(
                loaded[0]["evidence"]["prospective_assignment_issued"]
            )

            contaminated = deepcopy(context_pair[0])
            contaminated["evidence"]["completion_event_contract_version"] = (
                "castingcompass.validation-completion-event/1.0.0"
            )
            contaminated_path = write_json(
                root / "context-contaminated.json", [contaminated]
            )
            with self.assertRaisesRegex(ValueError, "retrospective/context-only"):
                load_validation_evidence(
                    contaminated_path,
                    protocol,
                    include_outcomes=False,
                    activated_at=activation_document["activated_at"],
                    activation_manifest_sha256=canonical_sha256(
                        activation_document
                    ),
                    activation=activation_document["activation"],
                )

            ledger, predictions = write_prediction_artifacts(
                root, [context_pair[0]]
            )
            batch = seal_batch(
                root,
                label_free_path=context_path,
                ledger_path=ledger,
                predictions_path=predictions,
                chain=[activation],
            )
            census = write_census(root, activation, [context_pair[0]])
            finalization = seal_finalization(
                root,
                label_free_path=context_path,
                ledger_path=ledger,
                predictions_path=predictions,
                census_path=census,
                chain=[activation, batch],
            )
            finalization_document = json.loads(finalization.read_text())
            self.assertEqual(
                finalization_document["finalization"]["eligible_source_count"], 1
            )
            self.assertEqual(
                finalization_document["finalization"][
                    "issuance_reconciliation"
                ]["issued_assignment_count"],
                0,
            )

    def test_terminal_exposure_lifecycle_boundaries_and_partial_completion_fail_closed(self):
        from pipeline.tests._validation_fixtures import (
            make_unsealed_issuance_record,
            write_census,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activation_path = seal_activation(root)
            activation = json.loads(activation_path.read_text())
            protocol, _ = load_validation_protocol()

            def validate_case(name: str, record: dict[str, object]) -> None:
                case_root = root / name
                census_path = write_census(
                    case_root,
                    activation_path,
                    [],
                    unsealed_issuance_records=[record],
                )
                with trusted_clock():
                    load_trusted_census_export(
                        census_path,
                        protocol,
                        activation,
                        evidence=[],
                    )

            def signed_record(
                index: int,
                *,
                exposed_at: str,
                disposition: str,
                segment_start_at: str | None,
                completion_event_at: str | None,
                terminal_disposition: str,
                terminal_reason: str,
            ) -> dict[str, object]:
                record = make_unsealed_issuance_record(
                    index,
                    terminal_disposition=terminal_disposition,
                    terminal_reason=terminal_reason,
                )
                record.update(
                    {
                        "segment_start_at": segment_start_at,
                        "completion_event_at": completion_event_at,
                        "completion_event_sha256": (
                            digest(f"completion:{index}")
                            if completion_event_at is not None
                            else None
                        ),
                        "score_exposure_attestation_sha256": digest(
                            f"terminal-exposure:{index}"
                        ),
                        "score_exposure_links_impression_attestation_sha256": record[
                            "impression_attestation_sha256"
                        ],
                        "score_exposed_at": exposed_at,
                        "score_exposure_evidence_kind": (
                            "signed-first-exposure-event"
                        ),
                        "score_exposure_disposition": disposition,
                    }
                )
                return record

            validate_case(
                "safe-canceled-no-segment",
                signed_record(
                    1,
                    exposed_at="2026-08-20T09:00:00.000Z",
                    disposition="exposed-after-assignment-no-effort-started",
                    segment_start_at=None,
                    completion_event_at=None,
                    terminal_disposition="safe-canceled",
                    terminal_reason="participant-safe-cancellation",
                ),
            )
            validate_case(
                "started-incomplete",
                signed_record(
                    2,
                    exposed_at="2026-08-20T11:00:00.000Z",
                    disposition="exposed-during-started-incomplete-effort",
                    segment_start_at="2026-08-20T10:00:00.000Z",
                    completion_event_at=None,
                    terminal_disposition="incomplete-or-expired",
                    terminal_reason="no-completion-before-enrollment-close",
                ),
            )
            for name, exposed_at in (
                ("at-segment-start", "2026-08-20T10:00:00.000Z"),
                ("at-completion", "2026-08-20T12:00:00.000Z"),
            ):
                validate_case(
                    name,
                    signed_record(
                        3 if name == "at-segment-start" else 4,
                        exposed_at=exposed_at,
                        disposition="exposed-during-effort-through-completion",
                        segment_start_at="2026-08-20T10:00:00.000Z",
                        completion_event_at="2026-08-20T12:00:00.000Z",
                        terminal_disposition="excluded",
                        terminal_reason=(
                            "score-exposed-during-effort-through-completion"
                        ),
                    ),
                )
            validate_case(
                "one-millisecond-after-completion",
                signed_record(
                    5,
                    exposed_at="2026-08-20T12:00:00.001Z",
                    disposition="exposed-after-completion",
                    segment_start_at="2026-08-20T10:00:00.000Z",
                    completion_event_at="2026-08-20T12:00:00.000Z",
                    terminal_disposition="withdrawn",
                    terminal_reason="participant-withdrawal",
                ),
            )

            orphan = make_unsealed_issuance_record(
                6,
                completion_event_sha256=digest("orphan-completion"),
            )
            orphan_path = write_census(
                root / "orphan-completion",
                activation_path,
                [],
                unsealed_issuance_records=[orphan],
            )
            with trusted_clock(), self.assertRaisesRegex(
                ValueError, "completion time/hash"
            ):
                load_trusted_census_export(
                    orphan_path,
                    protocol,
                    activation,
                    evidence=[],
                )

    def test_completion_chronology_is_bound_to_batch_census_and_fractional_finalization(self):
        from pipeline.tests._validation_fixtures import (
            bind_rows_to_activation,
            seal_batch,
            seal_finalization,
            write_census,
            write_prediction_artifacts,
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activation = seal_activation(root)
            late_completion = make_row(
                50,
                site_id="limantour-beach",
                block="block-1",
                score=50,
                encountered=False,
            )
            evidence = late_completion[0]["evidence"]
            evidence["completion_event_at"] = "2026-08-15T11:50:00.000Z"
            evidence["completion_consented_at"] = "2026-08-15T11:50:00.000Z"
            evidence["collection_event_at"] = "2026-08-15T11:50:00.000Z"
            evidence.update(
                summarize_collection_provenance_events(
                    [
                        {
                            "id": "validation-enrollment-50",
                            "event_type": "enrollment",
                            "created_at": evidence["recruitment_event_at"],
                            "exclusion_reason": None,
                        },
                        {
                            "id": evidence["collection_event_id"],
                            "event_type": "completion",
                            "created_at": evidence["completion_event_at"],
                            "exclusion_reason": None,
                        },
                    ]
                )
            )
            bind_rows_to_activation([late_completion], activation)
            label_free = write_json(root / "late-completion.json", [late_completion[0]])
            ledger, predictions = write_prediction_artifacts(root, [late_completion[0]])
            with self.assertRaisesRegex(ValueError, "after the seal"):
                seal_batch(
                    root,
                    label_free_path=label_free,
                    ledger_path=ledger,
                    predictions_path=predictions,
                    chain=[activation],
                    sealed_at="2026-08-15T11:47:00Z",
                )

            enrollment_boundary = make_row(
                51,
                site_id="limantour-beach",
                block="block-4",
                score=50,
                encountered=False,
            )
            post_evidence = enrollment_boundary[0]["evidence"]
            post_evidence["completion_event_at"] = "2027-08-01T00:00:00.000Z"
            post_evidence["completion_consented_at"] = "2027-08-01T00:00:00.000Z"
            post_evidence["collection_event_at"] = "2027-08-01T00:00:00.000Z"
            post_evidence.update(
                summarize_collection_provenance_events(
                    [
                        {
                            "id": "validation-enrollment-51",
                            "event_type": "enrollment",
                            "created_at": post_evidence["recruitment_event_at"],
                            "exclusion_reason": None,
                        },
                        {
                            "id": post_evidence["collection_event_id"],
                            "event_type": "completion",
                            "created_at": post_evidence["completion_event_at"],
                            "exclusion_reason": None,
                        },
                    ]
                )
            )
            bind_rows_to_activation([enrollment_boundary], activation)
            protocol, _ = load_validation_protocol()
            activation_document = json.loads(activation.read_text())
            boundary_path = write_json(
                root / "boundary.json", [enrollment_boundary[0]]
            )
            with self.assertRaisesRegex(ValueError, "completion consent/intent"):
                load_validation_evidence(
                    boundary_path,
                    protocol,
                    include_outcomes=False,
                    activated_at=activation_document["activated_at"],
                    activation_manifest_sha256=canonical_sha256(
                        activation_document
                    ),
                    activation=activation_document["activation"],
                    _records=[enrollment_boundary[0]],
                )

            one_millisecond_before = make_row(
                53,
                site_id="limantour-beach",
                block="block-4",
                score=50,
                encountered=False,
            )
            before_evidence = one_millisecond_before[0]["evidence"]
            before_evidence["completion_event_at"] = "2027-07-31T23:59:59.999Z"
            before_evidence["completion_consented_at"] = "2027-07-31T23:59:59.999Z"
            before_evidence["collection_event_at"] = "2027-07-31T23:59:59.999Z"
            before_evidence.update(
                summarize_collection_provenance_events(
                    [
                        {
                            "id": "validation-enrollment-53",
                            "event_type": "enrollment",
                            "created_at": before_evidence["recruitment_event_at"],
                            "exclusion_reason": None,
                        },
                        {
                            "id": before_evidence["collection_event_id"],
                            "event_type": "completion",
                            "created_at": before_evidence["completion_event_at"],
                            "exclusion_reason": None,
                        },
                    ]
                )
            )
            bind_rows_to_activation([one_millisecond_before], activation)
            before_boundary_path = write_json(
                root / "before-boundary.json", [one_millisecond_before[0]]
            )
            accepted = load_validation_evidence(
                before_boundary_path,
                protocol,
                include_outcomes=False,
                activated_at=activation_document["activated_at"],
                activation_manifest_sha256=canonical_sha256(activation_document),
                activation=activation_document["activation"],
                _records=[one_millisecond_before[0]],
            )
            self.assertEqual(len(accepted), 1)

            ordinary = make_row(
                52,
                site_id="limantour-beach",
                block="block-1",
                score=50,
                encountered=False,
            )
            bind_rows_to_activation([ordinary], activation)
            ordinary_free = write_json(root / "fractional.json", [ordinary[0]])
            ordinary_ledger, ordinary_predictions = write_prediction_artifacts(
                root / "fractional", [ordinary[0]]
            )
            ordinary_batch = seal_batch(
                root / "fractional",
                label_free_path=ordinary_free,
                ledger_path=ordinary_ledger,
                predictions_path=ordinary_predictions,
                chain=[activation],
                sealed_at="2027-08-02T12:00:00Z",
            )
            fractional_census = write_census(
                root / "fractional",
                activation,
                [ordinary[0]],
                generated_at="2027-08-02T12:00:00.900Z",
            )
            finalization = seal_finalization(
                root / "fractional",
                label_free_path=ordinary_free,
                ledger_path=ordinary_ledger,
                predictions_path=ordinary_predictions,
                census_path=fractional_census,
                chain=[activation, ordinary_batch],
                sealed_at="2027-08-02T12:00:00.900Z",
            )
            finalization_payload = json.loads(finalization.read_text())
            self.assertEqual(
                finalization_payload["created_at"], "2027-08-02T12:00:00.900000Z"
            )

    def test_runtime_identity_rejects_untracked_modified_contract_and_version_drift(self):
        protocol = load_protocol()
        exact_versions = {
            "python": "3.12.8",
            "python_implementation": "CPython",
            "numpy": "2.0.2",
            "scipy": "1.13.1",
            "scikit-learn": "1.6.1",
            "cffi": "2.1.0",
            "cryptography": "46.0.4",
            "joblib": "1.5.3",
            "pycparser": "3.0",
            "threadpoolctl": "3.6.0",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in EVALUATOR_SOURCE_PATHS:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                if relative == "pipeline/requirements-validation.lock":
                    path.write_text(
                        "cffi==2.1.0\ncryptography==46.0.4\njoblib==1.5.3\n"
                        "numpy==2.0.2\npycparser==3.0\nscikit-learn==1.6.1\n"
                        "scipy==1.13.1\nthreadpoolctl==3.6.0\n"
                    )
                else:
                    path.write_text(f"frozen:{relative}\n")
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "frozen"], cwd=root, check=True)
            with patch(
                "pipeline.contourcast.validation_protocol.REPOSITORY_ROOT", root
            ), patch(
                "pipeline.contourcast.validation_protocol._runtime_image_digest",
                return_value=f"sha256:{'a' * 64}",
            ), patch(
                "pipeline.contourcast.validation_protocol._evaluator_runtime_versions",
                return_value=exact_versions,
            ):
                identity = build_frozen_evaluator_identity(protocol)
                self.assertTrue(identity["tracked_source_tree_clean"])
                (root / "sitecustomize.py").write_text("raise RuntimeError('injected')\n")
                with self.assertRaisesRegex(ValueError, "clean"):
                    build_frozen_evaluator_identity(protocol)
                (root / "sitecustomize.py").unlink()
                taxa = root / "contracts/taxa.json"
                original = taxa.read_text()
                taxa.write_text("mutated\n")
                with self.assertRaisesRegex(ValueError, "clean"):
                    build_frozen_evaluator_identity(protocol)
                taxa.write_text(original)
                drifted = {**exact_versions, "numpy": "2.1.0"}
                with patch(
                    "pipeline.contourcast.validation_protocol._evaluator_runtime_versions",
                    return_value=drifted,
                ), self.assertRaisesRegex(ValueError, "exact lock"):
                    build_frozen_evaluator_identity(protocol)


if __name__ == "__main__":
    unittest.main()
