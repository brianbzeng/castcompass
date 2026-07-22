import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pipeline.contourcast.metadata import (
    build_run_record,
    sha256_file,
    verify_run_record_integrity,
)
from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    SYNTHETIC_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    validate_contract_assets,
)


EXPECTED_KEYS = {
    "schema_version",
    "model_run_contract_version",
    "observation_contract_version",
    "taxon_catalog_version",
    "target_taxon_id",
    "target_scope",
    "run_id",
    "created_at",
    "status",
    "dataset_kind",
    "command",
    "experiment_version",
    "model_version",
    "git_revision",
    "runtime",
    "config",
    "inputs",
    "metrics",
    "notes",
}


class ModelRunMetadataTests(unittest.TestCase):
    def test_contract_assets_and_target_specific_run_identity(self):
        validate_contract_assets()
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "observations.csv"
            input_path.write_text("fixture\n", encoding="utf-8")
            record = build_run_record(
                command="baseline-evaluation",
                target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
                config={"folds": 5},
                input_paths=(input_path,),
                dataset_kind="real_observations",
                status="completed",
                metrics={"folds_completed": 5},
                notes="Blocked evaluation completed on the recorded fixture.",
            )
        self.assertEqual(set(record), EXPECTED_KEYS)
        self.assertEqual(record["schema_version"], MODEL_RUN_CONTRACT_VERSION)
        self.assertEqual(record["taxon_catalog_version"], TAXON_CATALOG_VERSION)
        self.assertEqual(record["observation_contract_version"], OBSERVATION_CONTRACT_VERSION)
        self.assertEqual(record["target_scope"], {"kind": "taxon", "taxon_id": PRODUCTION_TARGET_TAXON_ID})
        self.assertRegex(record["model_version"], r"^model-california-halibut-[a-f0-9]{64}$")
        self.assertRegex(record["experiment_version"], r"^exp-california-halibut-[a-f0-9]{64}$")
        self.assertTrue(record["created_at"].endswith("Z"))

    def test_target_agnostic_run_disclaims_observation_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "terrain.npz"
            input_path.write_bytes(b"terrain")
            record = build_run_record(
                command="pretrain-bathymetry",
                target_taxon_id=None,
                config={"epochs": 1},
                input_paths=(input_path,),
                dataset_kind="official_unlabeled_bathymetry",
            )
        self.assertIsNone(record["observation_contract_version"])
        self.assertEqual(record["target_scope"], {"kind": "target-agnostic", "taxon_id": None})
        self.assertRegex(record["model_version"], r"^model-target-agnostic-[a-f0-9]{64}$")

    def test_unlabeled_remote_sensing_run_is_target_agnostic(self):
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "hybrid-corpus.npz"
            input_path.write_bytes(b"hybrid")
            record = build_run_record(
                command="pretrain-hybrid-seafloor",
                target_taxon_id=None,
                config={"modality": "fused"},
                input_paths=(input_path,),
                dataset_kind="official_unlabeled_seafloor_remote_sensing",
            )
        self.assertIsNone(record["observation_contract_version"])
        self.assertEqual(record["target_scope"], {"kind": "target-agnostic", "taxon_id": None})

    def test_target_changes_content_identity_and_invalid_targets_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "input.csv"
            input_path.write_text("same\n", encoding="utf-8")
            production = build_run_record(
                command="evaluate",
                target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
                config={"same": True},
                input_paths=(input_path,),
                dataset_kind="real_observations",
            )
            synthetic = build_run_record(
                command="evaluate",
                target_taxon_id=SYNTHETIC_TARGET_TAXON_ID,
                config={"same": True},
                input_paths=(input_path,),
                dataset_kind="synthetic_fixture",
            )
            self.assertNotEqual(production["model_version"], synthetic["model_version"])
            with self.assertRaises(ValueError):
                build_run_record(
                    command="evaluate",
                    target_taxon_id="unresolved-fish",
                    config={},
                    input_paths=(input_path,),
                    dataset_kind="real_observations",
                )

    def test_command_dataset_and_dirty_code_state_change_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "same.csv"
            input_path.write_text("same\n", encoding="utf-8")
            common = {
                "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
                "config": {"same": True},
                "input_paths": (input_path,),
                "dataset_kind": "real_observations",
            }
            with patch("pipeline.contourcast.metadata.git_revision", return_value=f"abc-dirty-{'1' * 64}"):
                first = build_run_record(command="evaluate", **common)
                command_changed = build_run_record(command="different-command", **common)
            with patch("pipeline.contourcast.metadata.git_revision", return_value=f"abc-dirty-{'2' * 64}"):
                code_changed = build_run_record(command="evaluate", **common)
            with patch("pipeline.contourcast.metadata.git_revision", return_value=f"abc-dirty-{'1' * 64}"):
                dataset_changed = build_run_record(
                    command="evaluate",
                    **{**common, "dataset_kind": "independent_real_observations"},
                )
        versions = {
            first["model_version"],
            command_changed["model_version"],
            code_changed["model_version"],
            dataset_changed["model_version"],
        }
        self.assertEqual(len(versions), 4)

    def test_integrity_verifier_rejects_mutated_material_and_arbitrary_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "input.csv"
            input_path.write_text("stable\n", encoding="utf-8")
            record = build_run_record(
                command="evaluate",
                target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
                config={"folds": 5},
                input_paths=(input_path,),
                dataset_kind="real_observations",
            )
        mutations = (
            ("command", "other"),
            ("dataset_kind", "other_real"),
            ("git_revision", f"changed-dirty-{'f' * 64}"),
            ("model_version", f"model-california-halibut-{'0' * 64}"),
        )
        for field, value in mutations:
            with self.subTest(field=field):
                mutated = copy.deepcopy(record)
                mutated[field] = value
                with self.assertRaises(ValueError):
                    verify_run_record_integrity(mutated)
        mutated = copy.deepcopy(record)
        mutated["config"]["folds"] = 9
        with self.assertRaises(ValueError):
            verify_run_record_integrity(mutated)
        mutated = copy.deepcopy(record)
        mutated["inputs"][0]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            verify_run_record_integrity(mutated)
        mutated = copy.deepcopy(record)
        mutated["target_taxon_id"] = SYNTHETIC_TARGET_TAXON_ID
        mutated["target_scope"] = {"kind": "taxon", "taxon_id": SYNTHETIC_TARGET_TAXON_ID}
        with self.assertRaises(ValueError):
            verify_run_record_integrity(mutated)

    def test_completed_runs_require_provenance_and_promotion_rehashes_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "input.csv"
            artifact_path = root / "metrics.json"
            input_path.write_text("input\n", encoding="utf-8")
            artifact_path.write_text("{}\n", encoding="utf-8")
            artifact_digest = sha256_file(artifact_path)
            common = {
                "command": "evaluate",
                "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
                "config": {"folds": 5},
                "input_paths": (input_path,),
                "dataset_kind": "real_observations",
                "status": "completed",
            }
            with self.assertRaises(ValueError):
                build_run_record(**common, metrics={}, notes="complete")
            with self.assertRaises(ValueError):
                build_run_record(**common, metrics={"artifact_sha256": artifact_digest}, notes=" ")
            with self.assertRaises(ValueError):
                build_run_record(
                    **{**common, "input_paths": ()},
                    metrics={"artifact_sha256": artifact_digest},
                    notes="complete",
                )
            record = build_run_record(
                **common,
                metrics={"artifact_sha256": artifact_digest},
                notes="complete",
            )
            verify_run_record_integrity(
                record,
                rehash_inputs=True,
                artifact_paths={"artifact_sha256": artifact_path},
            )
            artifact_path.write_text("tampered\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                verify_run_record_integrity(
                    record,
                    rehash_inputs=True,
                    artifact_paths={"artifact_sha256": artifact_path},
                )
            artifact_path.write_text("{}\n", encoding="utf-8")
            input_path.write_text("tampered input\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                verify_run_record_integrity(record, rehash_inputs=True)


if __name__ == "__main__":
    unittest.main()
