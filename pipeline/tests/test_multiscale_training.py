import tempfile
import unittest
from pathlib import Path

import numpy as np

from pipeline.contourcast.geo import GeoGrid
from pipeline.contourcast.patches import (
    extract_multiscale_patches,
    load_patch_corpus,
    sample_water_centers,
    save_patch_corpus,
)
from pipeline.contourcast.structure import STRUCTURE_CHANNELS, derive_structure_channels
from pipeline.contourcast.training import normalize_patches, robust_patch_normalization


class MultiScaleTrainingTests(unittest.TestCase):
    def setUp(self):
        rows, cols = np.mgrid[0:81, 0:81]
        elevation = -(4 + 0.01 * rows + 0.03 * cols + np.sin(cols / 4))
        self.grid = GeoGrid(
            elevation.astype(np.float32),
            "EPSG:32610",
            (500000, 5, 0, 4200000, 0, -5),
            "MLLW",
            source_id="multiscale-test",
        )
        self.channels, _ = derive_structure_channels(self.grid, broad_radius=6)

    def test_physical_scales_and_corpus_round_trip(self):
        x, y = sample_water_centers(
            self.channels, self.grid, stride_m=100, max_centers=12, seed=4
        )
        patches, metadata = extract_multiscale_patches(
            self.channels,
            self.grid,
            x,
            y,
            radii_m=(20, 60, 150),
            output_size=17,
            min_valid_fraction=1.0,
        )
        keep = np.asarray(metadata.pop("retained_mask"), dtype=bool)
        self.assertEqual(patches.shape, (int(np.sum(keep)), 3, 10, 17, 17))
        self.assertEqual(metadata["diameters_m"], [40.0, 120.0, 300.0])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "corpus.npz"
            save_patch_corpus(
                path,
                patches,
                x[keep],
                y[keep],
                STRUCTURE_CHANNELS,
                metadata,
            )
            loaded, loaded_x, loaded_y, names, loaded_metadata = load_patch_corpus(path)
        np.testing.assert_allclose(loaded, patches)
        np.testing.assert_allclose(loaded_x, x[keep])
        np.testing.assert_allclose(loaded_y, y[keep])
        self.assertEqual(names, STRUCTURE_CHANNELS)
        self.assertIn("resampling_warning", loaded_metadata)

    def test_fold_local_robust_normalization(self):
        patches = np.arange(8 * 2 * 3 * 5 * 5, dtype=np.float32).reshape(8, 2, 3, 5, 5)
        train_indices = np.arange(6)
        median, scale = robust_patch_normalization(patches, train_indices)
        normalized = normalize_patches(patches, median, scale)
        self.assertEqual(median.shape, (3,))
        self.assertEqual(scale.shape, (3,))
        self.assertEqual(normalized.shape, patches.shape)
        training_values = normalized[train_indices]
        np.testing.assert_allclose(np.median(training_values, axis=(0, 1, 3, 4)), 0, atol=1e-6)


if __name__ == "__main__":
    unittest.main()
