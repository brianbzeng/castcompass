import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from pipeline.contourcast.model_governance import (
    EVIDENCE_SCHEMA_VERSION,
    canonical_policy_sha256,
    evaluate_model_governance,
    load_model_governance_policy,
    validate_model_governance_policy,
)


def valid_evidence(*, action="promote", serving_kind="heuristic-configuration"):
    digest = "a" * 64
    return {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "policy_id": "california-halibut-model-governance-v1",
        "policy_version": "1.0.0",
        "evaluated_at": "2026-07-18T18:00:00Z",
        "requested_action": action,
        "serving_kind": serving_kind,
        "source_release": "f" * 40,
        "serving_version": "heuristic-california-halibut-v1",
        "target_taxon_id": "california-halibut",
        "candidate": {
            "model_version": f"model-california-halibut-{digest}",
            "model_run_sha256": "c" * 64,
            "checkpoint_sha256": "d" * 64,
            "metrics_sha256": "e" * 64,
            "run_record_integrity_verified": True,
            "artifact_hashes_verified": True,
            "clean_git_revision": True,
            "independent_reproduction": True,
            "product_fallbacks_verified": True,
        },
        "confirmatory": {
            "separate_protocol": True,
            "externally_timestamped_before_enrollment": True,
            "activation_preceded_first_eligible_row": True,
            "candidate_and_baselines_frozen": True,
            "locked_test_source_separated": True,
            "pilot_rows_excluded": True,
            "passed": True,
            "all_required_metrics_estimable": True,
            "primary_lower_bound_beats_best_baseline": True,
            "paired_improvement_lower_bound_above_zero": True,
            "calibration_within_precommitted_ceiling_and_not_worse_than_baseline": True,
            "no_required_slice_below_floor": True,
            "minimum_support_met": True,
            "negative_and_inconclusive_reporting_committed": True,
            "protocol_sha256": digest,
            "activation_sha256": "b" * 64,
        },
        "monitoring": {
            "model_and_policy_digests_match": True,
            "target_and_contract_versions_match": True,
            "crs_channel_source_and_coverage_contract_valid": True,
            "features_finite_and_in_contract": True,
            "missingness_within_precommitted_bound": True,
            "within_validated_support": True,
            "distribution_drift_within_action_bound": True,
            "performance_floor_cleared": True,
            "calibration_bound_cleared": True,
            "required_slice_floors_cleared": True,
            "support_minimum_met": True,
            "evidence_age_within_bound": True,
        },
        "material_change": False,
        "named_human_approval": False,
        "owner": "repository-model-governance-owner",
    }


def without_confirmatory(evidence):
    for field in evidence["confirmatory"]:
        evidence["confirmatory"][field] = (
            None if field in {"protocol_sha256", "activation_sha256"} else False
        )
    return evidence


class ModelGovernanceTests(unittest.TestCase):
    def setUp(self):
        self.policy = load_model_governance_policy()

    def test_policy_is_deterministic_and_semantically_fail_closed(self):
        validate_model_governance_policy(self.policy)
        self.assertRegex(canonical_policy_sha256(self.policy), r"^[a-f0-9]{64}$")
        self.assertEqual(
            canonical_policy_sha256(self.policy),
            canonical_policy_sha256(copy.deepcopy(self.policy)),
        )

        mutations = []
        changed = copy.deepcopy(self.policy)
        changed["current_release"]["trained_model_authorized"] = True
        mutations.append(changed)
        changed = copy.deepcopy(self.policy)
        changed["promotion"]["automatic_promotion_allowed"] = True
        mutations.append(changed)
        changed = copy.deepcopy(self.policy)
        changed["promotion"]["required_gates"].reverse()
        mutations.append(changed)
        changed = copy.deepcopy(self.policy)
        changed["monitoring"]["privacy"]["precise_coordinates_allowed"] = True
        mutations.append(changed)
        changed = copy.deepcopy(self.policy)
        changed["revalidation"]["maximum_evidence_age_days"] = 365
        mutations.append(changed)
        changed = copy.deepcopy(self.policy)
        changed["rollback"]["fallback_order"].pop()
        mutations.append(changed)

        for index, mutation in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(ValueError):
                validate_model_governance_policy(mutation)

    def test_current_heuristic_continues_or_revalidates_without_automatic_change(self):
        evidence = without_confirmatory(valid_evidence(action="continue-serving"))
        evidence["candidate"] = None
        decision = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(decision["decision"], "continue-heuristic")
        self.assertFalse(decision["automatic_change_applied"])
        self.assertEqual(decision["reasons"], [])

        evidence["material_change"] = True
        changed = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(changed["decision"], "revalidate")
        self.assertEqual(changed["reasons"], ["material-change-requires-revalidation"])

    def test_promotion_requires_every_gate_and_only_recommends_manual_policy_change(self):
        evidence = valid_evidence()
        decision = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(decision["decision"], "eligible-for-human-review")
        self.assertFalse(decision["automatic_change_applied"])

        evidence["named_human_approval"] = True
        approved = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(approved["decision"], "eligible-for-policy-update")
        self.assertEqual(
            approved["reasons"],
            ["current-policy-still-authorizes-only-reviewed-heuristic"],
        )
        self.assertFalse(approved["automatic_change_applied"])

        evidence["confirmatory"]["minimum_support_met"] = False
        blocked = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(blocked["decision"], "blocked")
        self.assertIn("minimum-support-not-met", blocked["reasons"])

        evidence["confirmatory"]["minimum_support_met"] = True
        evidence["candidate"]["artifact_hashes_verified"] = False
        blocked = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(blocked["decision"], "blocked")
        self.assertIn("artifact-hashes-not-verified", blocked["reasons"])

    def test_current_policy_suppresses_any_unauthorized_trained_model(self):
        evidence = valid_evidence(action="continue-serving", serving_kind="trained-model")
        decision = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(decision["decision"], "suppress")
        self.assertEqual(
            decision["reasons"],
            ["trained-model-not-authorized-by-current-policy"],
        )

    def test_explicit_rollback_wins_and_never_restores_automatically(self):
        evidence = valid_evidence(action="rollback", serving_kind="trained-model")
        decision = evaluate_model_governance(evidence, policy=self.policy)
        self.assertEqual(decision["decision"], "rollback")
        self.assertEqual(decision["reasons"], ["operator-requested-rollback"])
        self.assertFalse(decision["automatic_change_applied"])

    def test_evidence_is_strict_and_rejects_ambiguous_identity(self):
        cases = []
        changed = valid_evidence()
        changed["unexpected"] = True
        cases.append(changed)
        changed = valid_evidence()
        changed["evaluated_at"] = "2026-02-30T10:00:00Z"
        cases.append(changed)
        changed = valid_evidence()
        changed["material_change"] = 0
        cases.append(changed)
        changed = valid_evidence()
        changed["candidate"]["model_version"] = "model-rockfish-" + "a" * 64
        cases.append(changed)
        changed = valid_evidence()
        changed["candidate"]["model_run_sha256"] = "not-a-digest"
        cases.append(changed)
        changed = valid_evidence()
        changed["source_release"] = "main"
        cases.append(changed)
        changed = valid_evidence()
        changed["serving_version"] = "ambiguous version"
        cases.append(changed)
        changed = valid_evidence()
        changed["confirmatory"]["protocol_sha256"] = "not-a-digest"
        cases.append(changed)
        changed = without_confirmatory(valid_evidence(action="continue-serving"))
        changed["confirmatory"]["protocol_sha256"] = "a" * 64
        cases.append(changed)
        changed = without_confirmatory(valid_evidence(action="continue-serving"))
        changed["confirmatory"]["passed"] = True
        cases.append(changed)
        changed = valid_evidence()
        del changed["monitoring"]["within_validated_support"]
        cases.append(changed)

        for index, case in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(ValueError):
                evaluate_model_governance(case, policy=self.policy)

    def test_cli_verifies_policy_and_writes_a_non_mutating_decision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence_path = root / "evidence.json"
            decision_path = root / "decision.json"
            evidence_path.write_text(
                json.dumps(without_confirmatory(valid_evidence(action="continue-serving"))),
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pipeline.contourcast.model_governance",
                    "evaluate",
                    "--evidence",
                    str(evidence_path),
                    "--output",
                    str(decision_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            decision = json.loads(decision_path.read_text(encoding="utf-8"))
            self.assertEqual(decision["decision"], "continue-heuristic")
            self.assertFalse(decision["automatic_change_applied"])
            self.assertEqual(decision["evidence_identity"]["source_release"], "f" * 40)
            self.assertEqual(decision["evidence_identity"]["model_run_sha256"], "c" * 64)

            original_decision = decision_path.read_bytes()
            repeated = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pipeline.contourcast.model_governance",
                    "evaluate",
                    "--evidence",
                    str(evidence_path),
                    "--output",
                    str(decision_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(repeated.returncode, 0)
            self.assertEqual(decision_path.read_bytes(), original_decision)

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "pipeline.contourcast.model_governance",
                "verify-policy",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertFalse(summary["trained_model_authorized"])
        self.assertFalse(summary["automatic_promotion_allowed"])


if __name__ == "__main__":
    unittest.main()
