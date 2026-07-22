from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.contourcast.independent_endpoint_policy import (
    EXPECTED_CANDIDATE_IDS,
    INDEPENDENT_ENDPOINT_POLICY_PATH,
    PROSPECTIVE_COLLECTION_PROTOCOL_PATH,
    independent_endpoint_policy_sha256,
    load_independent_endpoint_policy,
    load_prospective_collection_protocol,
    prospective_collection_protocol_sha256,
    validate_independent_endpoint_policy,
    validate_prospective_collection_protocol,
)
from pipeline.contourcast.sources import assert_source_operation


class IndependentEndpointPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = load_independent_endpoint_policy()

    def test_inventory_is_deterministic_and_has_no_model_authority(self) -> None:
        self.assertEqual(
            independent_endpoint_policy_sha256(self.policy),
            "5127ef90fe425d9dd1b0469a631a13cbd556a798208b7fb514190794dcc540e1",
        )
        self.assertEqual(
            [candidate["candidate_id"] for candidate in self.policy["reviewed_candidates"]],
            list(EXPECTED_CANDIDATE_IDS),
        )
        self.assertTrue(
            all(value is False for value in self.policy["model_actions_authorized"].values())
        )
        for candidate in self.policy["reviewed_candidates"]:
            self.assertEqual(candidate["allowed_evidence_roles"], [])
            self.assertFalse(candidate["raster_pairing_authorized"])
            self.assertFalse(candidate["supervised_training_authorized"])
            self.assertFalse(candidate["representation_comparison_authorized"])
            with self.assertRaises(ValueError):
                assert_source_operation(candidate["candidate_id"], "endpoint-support-audit")

    def test_policy_rejects_every_authorization_and_inventory_escape_hatch(self) -> None:
        mutations = []

        candidate = copy.deepcopy(self.policy)
        candidate["current_decision"] = "candidate-admissible"
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["model_actions_authorized"]["representation_comparison"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["reviewed_candidates"][0]["allowed_evidence_roles"] = ["validation"]
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["reviewed_candidates"][0]["supervised_training_authorized"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["reviewed_candidates"][2]["reason_codes"] = ["resolution-variable"]
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["reviewed_candidates"].append(copy.deepcopy(candidate["reviewed_candidates"][0]))
        candidate["reviewed_candidates"][-1]["candidate_id"] = "unreviewed-source"
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["unreviewed_escape_hatch"] = True
        mutations.append(candidate)

        for index, weakened in enumerate(mutations):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    validate_independent_endpoint_policy(weakened)

    def test_loader_rejects_invalid_local_copy(self) -> None:
        raw = json.loads(INDEPENDENT_ENDPOINT_POLICY_PATH.read_text(encoding="utf-8"))
        raw["reviewed_candidates"][0]["official_url"] = "http://example.com/source"
        with tempfile.TemporaryDirectory() as raw_temp:
            path = Path(raw_temp) / "policy.json"
            path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "official URL"):
                load_independent_endpoint_policy(path)

    def test_prospective_collection_protocol_is_frozen_but_inactive(self) -> None:
        protocol = load_prospective_collection_protocol()
        self.assertEqual(
            prospective_collection_protocol_sha256(protocol),
            "eef862df95d11747aeffc9f6aaff698d6fe2e41d1f74b0092ada3e1dbf673923",
        )
        self.assertEqual(protocol["status"], "frozen-local-not-activated")
        self.assertFalse(protocol["activation"]["current_activation_authorized"])
        self.assertFalse(
            protocol["purpose_and_claim_boundary"]["candidate_model_access_allowed"]
        )
        self.assertEqual(
            protocol["support_gate"]["minimum_retained_deployments_per_class_per_side"],
            32,
        )

    def test_prospective_protocol_rejects_leakage_and_activation_shortcuts(self) -> None:
        protocol = load_prospective_collection_protocol()
        mutations = []

        candidate = copy.deepcopy(protocol)
        candidate["activation"]["current_activation_authorized"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(protocol)
        candidate["geography_and_frame"][
            "model_score_or_embedding_visible_during_frame_construction"
        ] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(protocol)
        candidate["labeling"]["classes"].pop()
        mutations.append(candidate)

        candidate = copy.deepcopy(protocol)
        candidate["labeling"]["post_label_class_collapse_allowed"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(protocol)
        candidate["independence_and_partitioning"]["row_random_split_allowed"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(protocol)
        candidate["support_gate"]["minimum_retained_deployments_per_class_per_side"] = 16
        mutations.append(candidate)

        for index, weakened in enumerate(mutations):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    validate_prospective_collection_protocol(weakened)

    def test_prospective_protocol_file_is_the_canonical_loaded_document(self) -> None:
        raw = json.loads(PROSPECTIVE_COLLECTION_PROTOCOL_PATH.read_text(encoding="utf-8"))
        self.assertEqual(raw, load_prospective_collection_protocol())

    def test_result_receipt_binds_the_negative_review_and_inactive_protocol(self) -> None:
        root = INDEPENDENT_ENDPOINT_POLICY_PATH.parents[1]
        receipt_path = (
            root
            / "pipeline"
            / "evidence"
            / "independent-endpoint-source-inventory-v1.receipt.json"
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(receipt["candidate_policy"]["candidate_count"], 7)
        self.assertEqual(receipt["candidate_policy"]["admissible_count"], 0)
        self.assertFalse(receipt["decision"]["reviewed_candidate_admissible"])
        self.assertFalse(receipt["decision"]["representation_comparison_authorized"])
        self.assertFalse(receipt["prospective_protocol"]["collection_authorized"])
        for section, hash_key in (
            (receipt["result"], "sha256"),
            (receipt["candidate_policy"], "file_sha256"),
            (receipt["prospective_protocol"], "file_sha256"),
        ):
            path = root / section["path"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), section[hash_key])
        protocol_doc = root / receipt["prospective_protocol"]["documentation_path"]
        self.assertEqual(
            hashlib.sha256(protocol_doc.read_bytes()).hexdigest(),
            receipt["prospective_protocol"]["documentation_sha256"],
        )


if __name__ == "__main__":
    unittest.main()
