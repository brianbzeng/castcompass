import unittest

import numpy as np

from pipeline.contourcast.habitat_probe import (
    PROBE_CLASS_NAMES,
    _fit_probe,
    decode_substrate_probe_target,
    summarize_multiscale_patches,
)


class HabitatProbeTests(unittest.TestCase):
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
