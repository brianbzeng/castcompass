import json
import tempfile
import unittest
from pathlib import Path

from pipeline.contourcast.workflow import run_smoke_workflow


class SmokeWorkflowTests(unittest.TestCase):
    def test_synthetic_end_to_end_is_labeled(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "smoke"
            artifacts = run_smoke_workflow(output, seed=12, observations=160)
            with Path(artifacts["metrics"]).open(encoding="utf-8") as handle:
                metrics = json.load(handle)
            with Path(artifacts["run_metadata"]).open(encoding="utf-8") as handle:
                metadata = json.load(handle)
        self.assertEqual(metrics["dataset_kind"], "synthetic_fixture")
        self.assertIn("not evidence of real-world", metrics["result_scope"])
        self.assertEqual(metadata["status"], "completed")
        self.assertEqual(metadata["dataset_kind"], "synthetic_fixture")
        self.assertTrue(metadata["experiment_version"].startswith("exp-"))
        self.assertTrue(metadata["model_version"].startswith("model-"))
        self.assertEqual(
            metrics["folds"],
            [
                {
                    "fold_id": 0,
                    "train_rows": 119,
                    "test_rows": 41,
                    "buffer_excluded_rows": 0,
                },
                {
                    "fold_id": 1,
                    "train_rows": 121,
                    "test_rows": 39,
                    "buffer_excluded_rows": 0,
                },
                {
                    "fold_id": 2,
                    "train_rows": 132,
                    "test_rows": 28,
                    "buffer_excluded_rows": 0,
                },
                {
                    "fold_id": 3,
                    "train_rows": 108,
                    "test_rows": 52,
                    "buffer_excluded_rows": 0,
                },
            ],
        )
        expected = {
            "naive": {
                "roc_auc": 0.5,
                "brier": 0.24858317218225012,
                "log_loss": 0.6903426753075708,
                "cpue_rmse_positive": 0.6730184586378352,
            },
            "linear": {
                "roc_auc": 0.4918368736383443,
                "brier": 0.31091343172692865,
                "log_loss": 0.85276124919543,
                "cpue_rmse_positive": 0.7338468179670059,
            },
            "boosted": {
                "roc_auc": 0.44068735827664396,
                "brier": 0.3408468682244582,
                "log_loss": 0.946222380368859,
                "cpue_rmse_positive": 0.6281928395385259,
            },
        }
        models = metrics["ablations"]["full_six"]["models"]
        for model_name, expected_metrics in expected.items():
            for metric_name, expected_value in expected_metrics.items():
                with self.subTest(model=model_name, metric=metric_name):
                    self.assertAlmostEqual(
                        models[model_name]["aggregate"][metric_name]["mean"],
                        expected_value,
                        delta=1e-3,
                    )


if __name__ == "__main__":
    unittest.main()
