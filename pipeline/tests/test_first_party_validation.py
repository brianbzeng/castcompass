from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator, Mapping
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pipeline.contourcast.first_party_validation import _bootstrap, evaluate_site_window
from pipeline.contourcast.validation_protocol import canonical_sha256, read_private_bytes_once
from pipeline.tests._validation_fixtures import (
    TRUSTED_NOW,
    build_sealed_bundle,
    digest,
    evaluation_kwargs,
    fake_evaluator_identity,
    make_row,
    seal_activation,
    seal_finalization,
    seal_label_lock,
    sign_payload,
    strong_rows,
    trusted_clock,
    write_deletion_ledger,
    write_census,
    write_json,
    write_labeled_export,
    write_prediction_artifacts,
)


@contextmanager
def evaluation_runtime(
    bundle: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> Iterator[None]:
    with ExitStack() as stack:
        stack.enter_context(trusted_clock(now) if now is not None else trusted_clock())
        stack.enter_context(
            patch(
                "pipeline.contourcast.first_party_validation.verify_release_commit_contains_protocol"
            )
        )
        stack.enter_context(
            patch(
                "pipeline.contourcast.first_party_validation.verify_frozen_evaluator_identity",
                return_value=bundle["identity"],
            )
        )
        yield


class FirstPartyValidationTests(unittest.TestCase):
    def test_strong_candidate_two_phase_publication_passes_and_secondary_never_promotes(self):
        rows = strong_rows()
        rows.append(
            make_row(
                9000,
                site_id="limantour-beach",
                block="block-3",
                score=90,
                encountered=True,
                cohort_role="secondary",
                angler_count=3,
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(root, rows)
            output = root / "result.json"
            kwargs = evaluation_kwargs(bundle, output)
            with evaluation_runtime(bundle):
                first = evaluate_site_window(**kwargs)
            self.assertEqual(
                first["verdict"],
                "withheld-pending-independent-append-only-log-proof",
            )
            self.assertEqual(first["analysis_verdict"], "pass")
            draft = json.loads(Path(first["draft_path"]).read_text())
            self.assertFalse(draft["publishable"])
            self.assertEqual(
                draft["withheld_reason"],
                "independently-verified-append-only-log-proof-not-implemented",
            )
            report = draft["analysis_result"]
            self.assertEqual(report["primary_analysis"]["candidate_auroc"], 1.0)
            self.assertEqual(
                report["primary_analysis"]["bootstrap"]["valid_resamples"], 2000
            )
            self.assertTrue(all(report["primary_analysis"]["promotion_gates"].values()))
            self.assertEqual(
                report["bindings"]["assignment_manifest_sha256"],
                canonical_sha256(json.loads(bundle["batch"].read_text())),
            )
            self.assertNotEqual(
                report["bindings"]["assignment_manifest_sha256"],
                report["bindings"]["finalization_manifest_sha256"],
            )
            self.assertEqual(report["sample_adequacy"]["counts"]["total_primary"], 500)
            self.assertEqual(report["sample_adequacy"]["counts"]["locked_test"], 250)
            accounting = report["cohort_and_reconciliation_accounting"]
            self.assertEqual(accounting["observational_secondary"]["attempts"], 1)
            self.assertEqual(accounting["observational_secondary"]["angler_hours"], 4.5)
            self.assertEqual(accounting["promotion_bearing_cohort"], "primary-solo-angler-only")
            self.assertTrue(accounting["observational_secondary_is_descriptive_only"])
            support = report["secondary_analysis"]["support"]
            self.assertEqual(
                support["by_recruitment_source"]["castingcompass-organic-product"]["attempts"],
                250,
            )
            self.assertEqual(
                support["by_selection_design"]["prospective-precommitted-without-score"]["attempts"],
                250,
            )
            descriptive = report["secondary_analysis"][
                "descriptive_discrimination_results"
            ]
            self.assertFalse(descriptive["promotion_bearing"])
            self.assertEqual(
                descriptive["by_recruitment_source"][
                    "castingcompass-organic-product"
                ]["candidate_auroc"],
                1.0,
            )
            self.assertNotIn("publication_audit_request_path", first)
            self.assertFalse(output.exists())
            self.assertFalse(
                list(root.glob("*.publication-audit-request.json"))
            )

    def test_global_participant_bootstrap_is_deterministic_and_never_splits_cross_panel_rows(self):
        rows = [
            {
                "participant_group_id": f"participant-{'1' * 64}",
                "geographic_panel": "north-coast",
                "temporal_block": "block-3",
                "target_encountered": 0,
            },
            {
                "participant_group_id": f"participant-{'1' * 64}",
                "geographic_panel": "san-mateo-coast",
                "temporal_block": "block-4",
                "target_encountered": 1,
            },
            {
                "participant_group_id": f"participant-{'2' * 64}",
                "geographic_panel": "north-coast",
                "temporal_block": "block-3",
                "target_encountered": 0,
            },
            {
                "participant_group_id": f"participant-{'3' * 64}",
                "geographic_panel": "san-mateo-coast",
                "temporal_block": "block-4",
                "target_encountered": 1,
            },
        ]
        candidate = [0.1, 0.9, 0.2, 0.8]
        baseline = [0.4, 0.6, 0.4, 0.6]
        first = _bootstrap(
            rows,
            candidate,
            baseline,
            resamples=100,
            random_state=20260716,
            maximum_draws=2000,
            minimum_participant_groups=2,
            minimum_effective_participant_groups=2,
            minimum_target_encounter_participant_groups=1,
            minimum_target_encounter_effective_participant_groups=1,
            minimum_non_encounter_participant_groups=1,
            minimum_non_encounter_effective_participant_groups=1,
            maximum_single_participant_share_numerator=1,
            maximum_single_participant_share_denominator=1,
        )
        second = _bootstrap(
            rows,
            candidate,
            baseline,
            resamples=100,
            random_state=20260716,
            maximum_draws=2000,
            minimum_participant_groups=2,
            minimum_effective_participant_groups=2,
            minimum_target_encounter_participant_groups=1,
            minimum_target_encounter_effective_participant_groups=1,
            minimum_non_encounter_participant_groups=1,
            minimum_non_encounter_effective_participant_groups=1,
            maximum_single_participant_share_numerator=1,
            maximum_single_participant_share_denominator=1,
        )
        self.assertEqual(first, second)
        self.assertEqual(first["status"], "complete")
        self.assertEqual(first["cross_stratum_participants"], 1)
        self.assertEqual(
            first["resampling_unit"],
            "global-participant-cluster-across-all-panels-and-blocks",
        )
        self.assertEqual(first["bit_generator"], "PCG64")
        self.assertEqual(first["percentile_method"], "linear")

    def test_bootstrap_rejects_one_cluster_and_outcome_class_concentration(self):
        one_cluster_rows = [
            {
                "participant_group_id": f"participant-{'1' * 64}",
                "geographic_panel": "north-coast",
                "temporal_block": "block-3",
                "target_encountered": index % 2,
            }
            for index in range(500)
        ]
        one_cluster = _bootstrap(
            one_cluster_rows,
            [float(row["target_encountered"]) for row in one_cluster_rows],
            [0.5] * len(one_cluster_rows),
            resamples=100,
            random_state=20260716,
            maximum_draws=2000,
        )
        self.assertEqual(one_cluster["status"], "inconclusive")
        self.assertEqual(one_cluster["valid_resamples"], 0)

        concentrated_rows: list[dict[str, Any]] = []
        for index in range(200):
            positive = index < 40
            if index < 15:
                participant = f"participant-{'a' * 64}"
            else:
                participant = f"participant-{digest(f'cluster:{index}') }"
            concentrated_rows.append(
                {
                    "participant_group_id": participant,
                    "geographic_panel": f"panel-{index % 5}",
                    "temporal_block": f"block-{3 + index % 2}",
                    "target_encountered": int(positive),
                }
            )
        concentrated = _bootstrap(
            concentrated_rows,
            [float(row["target_encountered"]) for row in concentrated_rows],
            [0.5] * len(concentrated_rows),
            resamples=100,
            random_state=20260716,
            maximum_draws=2000,
        )
        self.assertEqual(concentrated["status"], "inconclusive")
        positive_support = concentrated["participant_cluster_support"][
            "by_outcome_class"
        ]["target_encountered"]
        self.assertGreater(
            positive_support["maximum_single_participant_attempt_share"], 0.1
        )

    def test_label_bytes_are_receipted_once_and_path_swap_cannot_change_parsed_outcomes(self):
        rows = [
            make_row(
                1000 + index,
                site_id="limantour-beach",
                block="block-1" if index < 5 else "block-3",
                score=50,
                encountered=False,
            )
            for index in range(10)
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(root, rows)
            original_bytes = bundle["labeled_export"].read_bytes()
            alternate_rows = deepcopy(bundle["labeled"])
            for row in alternate_rows:
                row["outcome_class"] = "target_encountered"
                row["target_encounter_count"] = 1
            alternate = write_labeled_export(
                root,
                bundle["activation"],
                bundle["finalization"],
                bundle["deletion"],
                bundle["label_lock"],
                alternate_rows,
                name="alternate-labeled.json",
            )
            alternate_bytes = alternate.read_bytes()
            target = bundle["labeled_export"]
            swapped = False
            real_read = read_private_bytes_once

            def swap_after_held_read(path: Path, *, artifact: str) -> bytes:
                nonlocal swapped
                held = real_read(path, artifact=artifact)
                if Path(path) == target and not swapped:
                    target.write_bytes(alternate_bytes)
                    os.chmod(target, 0o600)
                    swapped = True
                return held

            output = root / "inconclusive.json"
            kwargs = evaluation_kwargs(bundle, output)
            with evaluation_runtime(bundle), patch(
                "pipeline.contourcast.first_party_validation.read_private_bytes_once",
                side_effect=swap_after_held_read,
            ):
                result = evaluate_site_window(**kwargs)
            self.assertTrue(swapped)
            self.assertEqual(result["analysis_verdict"], "inconclusive")
            draft = json.loads(Path(result["draft_path"]).read_text())[
                "analysis_result"
            ]
            self.assertTrue(
                all(
                    value is None
                    for value in draft["primary_analysis"][
                        "candidate_auroc_by_geography"
                    ].values()
                )
            )
            receipt = json.loads(Path(result["label_access_receipt_path"]).read_text())
            self.assertEqual(
                receipt["labeled_evidence_file_sha256"],
                hashlib.sha256(original_bytes).hexdigest(),
            )
            self.assertEqual(target.read_bytes(), alternate_bytes)
            self.assertNotEqual(
                receipt["labeled_evidence_file_sha256"],
                hashlib.sha256(target.read_bytes()).hexdigest(),
            )

    def test_deletion_after_label_lock_blocks_publication_of_old_analysis(self):
        rows = [
            make_row(2000, site_id="limantour-beach", block="block-1", score=20, encountered=False),
            make_row(2001, site_id="limantour-beach", block="block-3", score=80, encountered=True),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(root, rows)
            output = root / "result.json"
            kwargs = evaluation_kwargs(bundle, output)
            with evaluation_runtime(bundle):
                first = evaluate_site_window(**kwargs)
            self.assertEqual(
                first["verdict"],
                "withheld-pending-independent-append-only-log-proof",
            )
            initial_envelope = json.loads(bundle["deletion"].read_text())
            removed = bundle["label_free"][0]
            event = {
                "event_id": "post-lock-withdrawal",
                "assignment_id": removed["assignment_id"],
                "source_record_sha256": removed["source_record_sha256"],
                "status": "withdrawn",
                "reason": "participant-withdrawal",
                "occurred_at": "2027-08-04T12:00:00Z",
                "source_event_sha256": digest("post-lock-withdrawal"),
            }
            second_deletion = write_deletion_ledger(
                root,
                bundle["activation"],
                bundle["finalization"],
                events=[event],
                sequence=1,
                previous_envelope=initial_envelope,
                name="post-lock-deletion.json",
                created_at="2027-08-04T13:00:00Z",
                reconciled_through_at="2027-08-04T13:00:00Z",
            )
            active_labeled = [
                row
                for row in bundle["labeled"]
                if row["assignment_id"] != removed["assignment_id"]
            ]
            active_export = write_labeled_export(
                root,
                bundle["activation"],
                bundle["finalization"],
                second_deletion,
                bundle["label_lock"],
                active_labeled,
                name="post-lock-labeled.json",
                generated_at="2027-08-04T14:00:00Z",
            )
            updated = {
                **kwargs,
                "labeled_evidence_path": active_export,
                "deletion_reconciliation_paths": [
                    bundle["deletion"],
                    second_deletion,
                ],
            }
            with evaluation_runtime(bundle), self.assertRaisesRegex(
                ValueError, "receipt already binds different"
            ):
                evaluate_site_window(**updated)
            self.assertFalse(output.exists())

    def test_zero_eligible_interval_closes_honestly_and_is_inconclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activation = seal_activation(root)
            label_free_path = write_json(root / "label-free.json", [])
            ledger, predictions = write_prediction_artifacts(root, [])
            census = write_census(root, activation, [])
            finalization = seal_finalization(
                root,
                label_free_path=label_free_path,
                ledger_path=ledger,
                predictions_path=predictions,
                census_path=census,
                chain=[activation],
            )
            chain = [activation, finalization]
            deletion = write_deletion_ledger(root, activation, finalization)
            label_lock = seal_label_lock(root, finalization, chain)
            labeled_export = write_labeled_export(
                root,
                activation,
                finalization,
                deletion,
                label_lock,
                [],
            )
            bundle = {
                "activation": activation,
                "label_free_path": label_free_path,
                "label_free": [],
                "labeled": [],
                "ledger": ledger,
                "predictions": predictions,
                "census": census,
                "finalization": finalization,
                "deletion": deletion,
                "label_lock": label_lock,
                "labeled_export": labeled_export,
                "chain": chain,
                "identity": fake_evaluator_identity(
                    json.loads(
                        Path(
                            "validation/protocols/california-halibut-site-window-v1.json"
                        ).read_text()
                    )
                ),
            }
            output = root / "zero-result.json"
            with evaluation_runtime(bundle):
                result = evaluate_site_window(**evaluation_kwargs(bundle, output))
            self.assertEqual(result["analysis_verdict"], "inconclusive")
            draft = json.loads(Path(result["draft_path"]).read_text())
            self.assertFalse(draft["publishable"])
            report = draft["analysis_result"]
            self.assertEqual(report["sample_adequacy"]["counts"]["total_primary"], 0)
            self.assertIsNone(report["bindings"]["assignment_manifest_sha256"])
            finalization_value = json.loads(finalization.read_text())
            self.assertEqual(finalization_value["sequence"], 1)
            self.assertEqual(
                finalization_value["finalization"]["eligible_source_count"], 0
            )

    def test_existing_label_lock_and_labeled_export_chronology_are_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(
                root,
                [
                    make_row(
                        2500,
                        site_id="limantour-beach",
                        block="block-1",
                        score=50,
                        encountered=False,
                    )
                ],
            )
            forged = json.loads(bundle["label_lock"].read_text())
            forged["sequence"] = 99
            forged["manifest_id"] = "forged-label-lock"
            forged["created_at"] = "2027-08-01T12:00:00Z"
            forged["labels_opened_at"] = "2027-08-01T12:00:00Z"
            forged_path = write_json(root / "forged-label-lock.json", forged)
            forged_bundle = {**bundle, "label_lock": forged_path}
            output = root / "forged-result.json"
            with evaluation_runtime(bundle), self.assertRaisesRegex(
                ValueError,
                "cannot predate the sealed assignment manifest|exact next finalization chain link",
            ):
                evaluate_site_window(**evaluation_kwargs(forged_bundle, output))
            self.assertFalse(output.exists())

            predating_export = write_labeled_export(
                root,
                bundle["activation"],
                bundle["finalization"],
                bundle["deletion"],
                bundle["label_lock"],
                bundle["labeled"],
                name="predating-labels.json",
                generated_at="2027-08-03T23:59:59Z",
            )
            predating_bundle = {**bundle, "labeled_export": predating_export}
            predating_output = root / "predating-result.json"
            with evaluation_runtime(bundle), self.assertRaisesRegex(
                ValueError, "labeled export chronology"
            ):
                evaluate_site_window(
                    **evaluation_kwargs(predating_bundle, predating_output)
                )
            self.assertFalse(predating_output.exists())

    def test_assertion_only_reconciliation_never_creates_publication_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(
                root,
                [
                    make_row(
                        2600,
                        site_id="limantour-beach",
                        block="block-1",
                        score=50,
                        encountered=False,
                    )
                ],
            )
            output = root / "historical.json"
            kwargs = evaluation_kwargs(bundle, output)
            with evaluation_runtime(bundle):
                first = evaluate_site_window(**kwargs)
            self.assertEqual(
                first["verdict"],
                "withheld-pending-independent-append-only-log-proof",
            )
            self.assertNotIn("publication_audit_request_path", first)
            self.assertFalse(output.exists())
            with evaluation_runtime(bundle, now=TRUSTED_NOW + timedelta(days=30)):
                repeated = evaluate_site_window(**kwargs)
            self.assertEqual(
                repeated["verdict"],
                "withheld-pending-independent-append-only-log-proof",
            )
            self.assertFalse(
                list(root.glob("*.publication-audit-request.json"))
            )
            self.assertFalse(list(root.glob("*.publication-audit-receipt.json")))

    def test_wrong_key_and_noncanonical_labeled_exports_fail_after_durable_receipt(self):
        for case in ("wrong-key", "noncanonical"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bundle = build_sealed_bundle(
                    root,
                    [
                        make_row(
                            3000,
                            site_id="limantour-beach",
                            block="block-1",
                            score=50,
                            encountered=False,
                        )
                    ],
                )
                envelope = json.loads(bundle["labeled_export"].read_text())
                payload_bytes = base64.b64decode(envelope["payload_base64"])
                payload = json.loads(payload_bytes)
                if case == "wrong-key":
                    invalid = sign_payload(
                        root / "invalid-labeled.json",
                        schema_version="castingcompass.validation-labeled-export/1.0.0",
                        payload=payload,
                        private_key=Ed25519PrivateKey.generate(),
                    )
                else:
                    invalid = sign_payload(
                        root / "invalid-labeled.json",
                        schema_version="castingcompass.validation-labeled-export/1.0.0",
                        payload=payload,
                        payload_bytes=json.dumps(payload, indent=2).encode(),
                    )
                bundle["labeled_export"] = invalid
                output = root / "must-not-publish.json"
                kwargs = evaluation_kwargs(bundle, output)
                with evaluation_runtime(bundle), self.assertRaises(ValueError):
                    evaluate_site_window(**kwargs)
                self.assertTrue(Path(kwargs["label_lock_path"]).is_file())
                self.assertTrue(Path(kwargs["label_access_receipt_path"]).is_file())
                self.assertFalse(output.exists())

    def test_evaluator_identity_mismatch_stops_before_lock_or_label_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = build_sealed_bundle(
                root,
                [make_row(4000, site_id="limantour-beach", block="block-1", score=50, encountered=False)],
            )
            output = root / "must-not-run.json"
            kwargs = evaluation_kwargs(bundle, output)
            original_lock = Path(kwargs["label_lock_path"]).read_bytes()
            with trusted_clock(), patch(
                "pipeline.contourcast.first_party_validation.verify_release_commit_contains_protocol"
            ), patch(
                "pipeline.contourcast.first_party_validation.verify_frozen_evaluator_identity",
                side_effect=ValueError("runtime image mismatch"),
            ), patch(
                "pipeline.contourcast.first_party_validation.read_private_bytes_once"
            ) as read_label, self.assertRaisesRegex(ValueError, "runtime image mismatch"):
                evaluate_site_window(**kwargs)
            read_label.assert_not_called()
            self.assertEqual(Path(kwargs["label_lock_path"]).read_bytes(), original_lock)
            self.assertFalse(Path(kwargs["label_access_receipt_path"]).exists())
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
