import unittest
import copy
from pathlib import Path
from unittest.mock import patch

import numpy as np

from pipeline.contourcast.habitat_probe import (
    PROBE_CLASS_NAMES,
    _fit_probe,
    _load_target_agnostic_checkpoint,
    _validate_target_agnostic_checkpoint,
    decode_substrate_probe_target,
    summarize_multiscale_patches,
)
from shared.species_contract import MODEL_RUN_CONTRACT_VERSION, TAXON_CATALOG_VERSION, target_scope


class HabitatProbeTests(unittest.TestCase):
    def test_checkpoint_identity_fails_closed_before_config_or_weights(self):
        digest = "a" * 64
        checkpoint = {
            "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
            "observation_contract_version": None,
            "taxon_catalog_version": TAXON_CATALOG_VERSION,
            "target_taxon_id": None,
            "target_scope": target_scope(None),
            "experiment_version": f"exp-target-agnostic-{'b' * 64}",
            "model_version": f"model-target-agnostic-{'c' * 64}",
            "corpus_sha256": digest,
            "config": {"must_not_be_read_for_identity": True},
            "state_dict": {"must_not_be_read_for_identity": True},
        }
        self.assertIs(
            _validate_target_agnostic_checkpoint(checkpoint, expected_corpus_sha256=digest),
            checkpoint,
        )
        with (
            patch("pipeline.contourcast.habitat_probe.require_torch"),
            patch("pipeline.contourcast.habitat_probe.torch") as torch_mock,
        ):
            torch_mock.load.return_value = checkpoint
            loaded = _load_target_agnostic_checkpoint(
                Path("checkpoint.pt"),
                expected_corpus_sha256=digest,
            )
            self.assertIs(loaded, checkpoint)
            torch_mock.load.assert_called_once_with(
                Path("checkpoint.pt"),
                map_location="cpu",
                weights_only=True,
            )
        mutations = (
            ("model_run_contract_version", "castingcompass.model-run/1.0.0"),
            ("observation_contract_version", "castingcompass.observation/2.0.0"),
            ("taxon_catalog_version", "castingcompass.taxa/0.0.0"),
            ("target_taxon_id", "california-halibut"),
            ("target_scope", {"kind": "target-agnostic", "taxon_id": "california-halibut"}),
            ("experiment_version", f"exp-california-halibut-{'b' * 64}"),
            ("model_version", f"model-california-halibut-{'c' * 64}"),
            ("corpus_sha256", "d" * 64),
        )
        for field, value in mutations:
            with self.subTest(field=field):
                tampered = copy.deepcopy(checkpoint)
                tampered[field] = value
                with self.assertRaises(ValueError):
                    _validate_target_agnostic_checkpoint(
                        tampered,
                        expected_corpus_sha256=digest,
                    )
        for field in ("observation_contract_version", "target_taxon_id", "target_scope"):
            with self.subTest(missing=field):
                tampered = copy.deepcopy(checkpoint)
                del tampered[field]
                with self.assertRaises(ValueError):
                    _validate_target_agnostic_checkpoint(
                        tampered,
                        expected_corpus_sha256=digest,
                    )

    def test_decode_removes_depth_and_slope_digits(self):
        raw = np.array([1, 11, 51, 2, 13, 63, 4, 24, 74, 5, 6, 0])
        decoded = decode_substrate_probe_target(raw)
        np.testing.assert_array_equal(
            decoded,
            np.array([0, 0, 0, 1, 1, 1, 2, 2, 2, -1, -1, -1]),
        )

    def test_multiscale_summary_contract(self):
        patches = np.arange(6 * 3 * 2 * 5 * 5, dtype=np.float32).reshape(6, 3, 2, 5, 5)
        features, names = summarize_multiscale_patches(
            patches,
            ("depth_m", "slope_deg"),
            selected_channels=("depth_m",),
        )
        self.assertEqual(features.shape, (6, 15))
        self.assertEqual(len(names), 15)
        self.assertTrue(all("depth_m" in name for name in names))

    def test_probe_reports_three_class_metrics(self):
        generator = np.random.default_rng(3)
        labels = np.repeat(np.arange(3), 40)
        features = np.column_stack(
            [labels + generator.normal(0, 0.05, len(labels)), generator.normal(size=len(labels))]
        )
        train = np.concatenate([np.arange(0, 30), np.arange(40, 70), np.arange(80, 110)])
        test = np.setdiff1d(np.arange(len(labels)), train)
        metrics, prediction, probability = _fit_probe(
            features.astype(np.float32), labels, train, test, seed=9
        )
        self.assertGreater(metrics["macro_f1"], 0.95)
        self.assertEqual(metrics["confusion_matrix"], np.diag([10, 10, 10]).tolist())
        self.assertEqual(prediction.shape, (30,))
        self.assertEqual(probability.shape, (30, len(PROBE_CLASS_NAMES)))


if __name__ == "__main__":
    unittest.main()
