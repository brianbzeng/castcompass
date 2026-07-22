import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from pipeline.contourcast import deep_model, training
from pipeline.contourcast.patches import save_patch_corpus
from pipeline.contourcast.structure import STRUCTURE_CHANNELS


class DeepModelTests(unittest.TestCase):
    def test_dependency_guard_or_architecture_shapes(self):
        if deep_model.torch is None:
            with self.assertRaisesRegex(RuntimeError, "PyTorch is required"):
                deep_model.architecture_smoke_test()
        else:
            result = deep_model.architecture_smoke_test(batch_size=4, patch_size=17)
            self.assertEqual(result["status"], "architecture_smoke_only")
            self.assertEqual(result["input_shape"], [4, 6, 17, 17])
            self.assertTrue(result["finite_losses"])
            multiscale = deep_model.architecture_smoke_test(
                batch_size=4, patch_size=17, input_channels=10, scales=3
            )
            self.assertEqual(multiscale["input_shape"], [4, 3, 10, 17, 17])
            self.assertEqual(multiscale["area_bag_attention_shape"], [4, 2])
            self.assertTrue(multiscale["finite_losses"])
            first = deep_model.torch.randn(4, 8)
            second = deep_model.torch.randn(4, 8)
            coordinates = deep_model.torch.tensor(
                [[0.0, 0.0], [10.0, 0.0], [1000.0, 0.0], [2000.0, 0.0]]
            )
            loss = deep_model.spatial_nt_xent_loss(
                first,
                second,
                coordinates,
                min_negative_distance_m=100,
            )
            self.assertTrue(bool(deep_model.torch.isfinite(loss)))

    def test_hybrid_masked_contrastive_objective_shapes_and_missingness(self):
        if deep_model.torch is None:
            self.skipTest("PyTorch is optional")
        torch = deep_model.torch
        base = deep_model.TerrainResNetEncoder(
            input_channels=12,
            base_width=8,
            blocks_per_stage=1,
        )
        encoder = deep_model.MultiScaleTerrainEncoder(base, scales=3)
        model = deep_model.TerrainMaskedContrastiveModel(
            encoder,
            projection_dim=16,
            reconstruction_channels=2,
        )
        patches = torch.randn(4, 3, 12, 17, 17)
        patches[:, :, 11] = 1.0
        patches[0, :, 11, :4, :4] = 0.0
        masked, mask = deep_model.mask_terrain_blocks(
            patches,
            (0, 10),
            mask_fraction=0.3,
            block_size=4,
        )
        self.assertEqual(tuple(masked.shape), tuple(patches.shape))
        self.assertFalse(bool(torch.any(mask[:, :, 11])))
        outputs = model(masked)
        self.assertEqual(tuple(outputs["projection"].shape), (4, 16))
        self.assertEqual(tuple(outputs["reconstruction"].shape), (4, 3, 2, 17, 17))
        contract = {
            "availability_channel_indices": [11],
            "reconstruction_channel_indices": [0, 10],
            "reconstruction_availability_indices": [None, 11],
        }
        coordinates = torch.tensor(
            [[0.0, 0.0], [1000.0, 0.0], [2000.0, 0.0], [3000.0, 0.0]]
        )
        loss, parts = training.hybrid_pretraining_batch_loss(
            model,
            patches,
            coordinates,
            contract,
            min_negative_distance_m=100.0,
            mask_fraction=0.3,
            mask_block_size=4,
        )
        self.assertTrue(bool(torch.isfinite(loss)))
        self.assertTrue(all(value >= 0 for value in parts.values()))
        loss.backward()
        self.assertTrue(any(parameter.grad is not None for parameter in model.parameters()))

        predictions = torch.zeros(1, 1, 1, 3, 3)
        with self.assertRaisesRegex(ValueError, "no measured eligible pixels"):
            deep_model.masked_reconstruction_loss(
                predictions,
                predictions,
                torch.ones_like(predictions, dtype=torch.bool),
                available_pixels=torch.zeros_like(predictions, dtype=torch.bool),
            )

    def test_hybrid_runner_writes_target_agnostic_receipts(self):
        if deep_model.torch is None:
            self.skipTest("PyTorch is optional")
        generator = np.random.default_rng(12)
        value_name = "backscatter_intensity_8101_2004"
        availability_name = f"{value_name}__available"
        names = STRUCTURE_CHANNELS + (value_name, availability_name)
        patches = generator.normal(size=(64, 3, len(names), 9, 9)).astype(np.float32)
        patches[:, :, 0] = np.abs(patches[:, :, 0]) + 1.0
        patches[:, :, 11] = generator.integers(0, 2, size=(64, 3, 9, 9))
        x, y = np.meshgrid(np.arange(8) * 1000.0, np.arange(8) * 1000.0)
        metadata = {
            "source_id": "usgs_sf_state_waters_2m",
            "feature_metadata": {
                "aligned_layers": {
                    value_name: {
                        "source_id": "usgs_sf_state_waters_2m",
                        "valid_fraction": float(np.mean(patches[:, :, 11])),
                        "missingness_channel": availability_name,
                    }
                }
            },
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            corpus = root / "corpus.npz"
            output = root / "run"
            save_patch_corpus(
                corpus,
                patches,
                x.ravel(),
                y.ravel(),
                names,
                metadata,
            )
            result = training.run_hybrid_seafloor_pretraining(
                corpus,
                output,
                modality="fused",
                epochs=1,
                batch_size=8,
                base_width=8,
                blocks_per_stage=1,
                projection_dim=16,
                min_negative_distance_m=0.0,
                mask_fraction=0.3,
                mask_block_size=3,
                validation_fold=0,
                split_regions=2,
                device="cpu",
                seed=5,
            )
            run_record = json.loads(Path(result["run_metadata"]).read_text(encoding="utf-8"))
            metrics = json.loads(Path(result["metrics"]).read_text(encoding="utf-8"))
            self.assertTrue(Path(result["checkpoint"]).is_file())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(run_record["target_taxon_id"], None)
        self.assertEqual(
            run_record["dataset_kind"],
            "official_unlabeled_seafloor_remote_sensing",
        )
        self.assertEqual(metrics["modality"], "fused")
        self.assertIn("not catch accuracy", metrics["claim_boundary"])


if __name__ == "__main__":
    unittest.main()
