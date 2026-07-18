import tempfile
import unittest
from pathlib import Path

import numpy as np

from pipeline.contourcast.geo import GeoGrid
from pipeline.contourcast.structure import (
    STRUCTURE_CHANNELS,
    append_aligned_layers,
    audit_feature_resolution,
    derive_structure_channels,
    load_feature_stack,
    save_feature_stack,
)


class StructureFeatureTests(unittest.TestCase):
    def setUp(self):
        rows, cols = np.mgrid[0:41, 0:41]
        # Sloping bottom plus a narrow raised linear structure.
        elevation = -(8.0 + 0.04 * rows + 0.08 * cols)
        elevation[:, 20:23] += 1.5
        self.grid = GeoGrid(
            elevation.astype(np.float32),
            "EPSG:32610",
            (540000, 2, 0, 4190000, 0, -2),
            "NAVD88",
            source_id="structure-test",
        )

    def test_structure_channels_preserve_orientation_and_relief(self):
        channels, metadata = derive_structure_channels(
            self.grid,
            local_radius=2,
            broad_radius=6,
            relief_radius=2,
            horizontal_accuracy_m=2,
        )
        self.assertEqual(channels.shape, (10, 41, 41))
        self.assertEqual(tuple(metadata["channels"]), STRUCTURE_CHANNELS)
        relief = channels[STRUCTURE_CHANNELS.index("local_relief_m")]
        self.assertGreater(float(relief[20, 20]), float(relief[20, 5]))
        np.testing.assert_allclose(
            relief[20, 16:27],
            [0.48, 0.48, 1.58, 1.58, 1.58, 1.90, 1.98, 1.98, 1.98, 0.48, 0.48],
            rtol=0,
            atol=1e-6,
        )
        self.assertTrue(np.all(np.isfinite(channels)))

    def test_resolution_audit_does_not_upgrade_resampling(self):
        audit = audit_feature_resolution(
            self.grid,
            horizontal_accuracy_m=2,
            candidate_widths_m=(2, 4, 6, 12),
        )
        statuses = [item["status"] for item in audit["feature_classifications"]]
        self.assertEqual(statuses, ["unresolved", "marginal", "resolvable", "resolvable"])
        self.assertEqual(audit["conservative_feature_width_m"], 6)

    def test_auxiliary_missingness_and_round_trip(self):
        channels, metadata = derive_structure_channels(self.grid, broad_radius=6)
        backscatter = self.grid.values * -10
        backscatter[0:5, 0:5] = np.nan
        auxiliary = GeoGrid(
            backscatter,
            self.grid.crs,
            self.grid.transform,
            self.grid.vertical_datum,
            source_id="backscatter-test",
        )
        combined, names, layer_metadata = append_aligned_layers(
            channels,
            STRUCTURE_CHANNELS,
            self.grid,
            {"backscatter_db": auxiliary},
        )
        self.assertEqual(combined.shape[0], 12)
        availability = combined[names.index("backscatter_db__available")]
        self.assertEqual(float(availability[0, 0]), 0.0)
        self.assertEqual(float(availability[-1, -1]), 1.0)
        self.assertLess(layer_metadata["backscatter_db"]["valid_fraction"], 1.0)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "structure.npz"
            save_feature_stack(path, combined, self.grid, names, metadata)
            loaded, grid, loaded_names, _ = load_feature_stack(path)
        np.testing.assert_allclose(loaded, combined)
        self.assertEqual(loaded_names, names)
        self.assertEqual(grid.crs, self.grid.crs)


if __name__ == "__main__":
    unittest.main()
