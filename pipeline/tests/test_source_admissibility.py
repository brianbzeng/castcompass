from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.contourcast.sources import (
    EXPECTED_MANIFEST_SOURCES,
    SOURCE_ADMISSIBILITY_POLICY_PATH,
    SOURCE_DIR,
    assert_source_operation,
    load_source_admissibility_policy,
    load_source_manifests,
    source_policy_sha256,
    validate_source_admissibility_policy,
)


class SourceAdmissibilityPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = load_source_admissibility_policy()

    def test_policy_is_deterministic_and_manifest_inventory_is_exact(self) -> None:
        digest = source_policy_sha256(self.policy)
        self.assertEqual(digest, "6363f14e5ddf2c92c9e91f8339c2b370e589d7b3882716f2aa839a5b793a3c86")
        self.assertEqual(digest, source_policy_sha256(load_source_admissibility_policy()))
        self.assertEqual(set(load_source_manifests()), set(EXPECTED_MANIFEST_SOURCES))

    def test_only_exact_source_operations_are_admitted(self) -> None:
        assert_source_operation("noaa_bluetopo", "bathymetry-ingest")
        assert_source_operation("noaa_bluetopo", "terrain-pretraining")
        assert_source_operation(
            "usgs_santa_barbara_south_coast_2m", "terrain-pretraining"
        )
        assert_source_operation(
            "usgs_santa_barbara_south_coast_2m", "endpoint-support-footprint"
        )
        assert_source_operation(
            "usgs_ds781_residual_video_observations", "endpoint-support-audit"
        )
        assert_source_operation(
            "usgs_ds182_pacific_ext_sediment", "endpoint-support-audit"
        )
        assert_source_operation("synthetic_fixture", "terrain-pretraining")
        assert_source_operation("cdfw_crfs_ds3185", "descriptive-context")
        assert_source_operation("cdfw_crfs", "observation-normalization")
        assert_source_operation("synthetic_fixture", "observation-normalization")

        denied = (
            ("cdfw_crfs_ds3185", "observation-normalization"),
            ("cdfw_crfs", "model-training"),
            ("fishbrain", "observation-normalization"),
            ("facebook-groups", "descriptive-context"),
            ("unknown-source", "terrain-pretraining"),
        )
        for source_id, operation in denied:
            with self.subTest(source_id=source_id, operation=operation):
                with self.assertRaises(ValueError):
                    assert_source_operation(source_id, operation)

    def test_policy_rejects_weakened_or_ambiguous_decisions(self) -> None:
        mutations = []

        candidate = copy.deepcopy(self.policy)
        candidate["default_decision"] = "allow"
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["current_model_roles"]["supervised_model_training_authorized"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["manifest_sources"][0]["production_scoring_authorized"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["manifest_sources"][0]["allowed_operations"].append("terrain-pretraining")
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["manifest_sources"].append(copy.deepcopy(candidate["manifest_sources"][0]))
        candidate["manifest_sources"][-1]["source_id"] = "unreviewed-source"
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["blocked_platforms"][0]["retrospective_content_import_allowed"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["blocked_platforms"][1]["automated_collection_allowed"] = True
        mutations.append(candidate)

        candidate = copy.deepcopy(self.policy)
        candidate["unreviewed_escape_hatch"] = True
        mutations.append(candidate)

        for index, weakened in enumerate(mutations):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    validate_source_admissibility_policy(weakened)

    def test_loader_rejects_a_manifest_not_in_the_policy(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp:
            temp_dir = Path(raw_temp)
            source_paths = list(SOURCE_DIR.glob("*.json"))
            for source_path in source_paths:
                (temp_dir / source_path.name).write_bytes(source_path.read_bytes())
            extra = json.loads(source_paths[0].read_text(encoding="utf-8"))
            extra["source_id"] = "unreviewed-source"
            (temp_dir / "unreviewed-source.json").write_text(
                json.dumps(extra),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "unreviewed"):
                load_source_manifests(temp_dir)

    def test_policy_file_is_the_canonical_loaded_document(self) -> None:
        raw = json.loads(SOURCE_ADMISSIBILITY_POLICY_PATH.read_text(encoding="utf-8"))
        self.assertEqual(raw, self.policy)


if __name__ == "__main__":
    unittest.main()
