import copy
import csv
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from pipeline.contourcast.ingest import ingest_observations


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPOSITORY_ROOT / "contracts" / "fixtures" / "observation-contract-cases.json"


def load_corpus() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def materialize_fixture(corpus: dict[str, Any], fixture_case: dict[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(corpus["base_records"][fixture_case["base"]])
    for mutation in fixture_case["mutations"]:
        segments = [segment.replace("~1", "/").replace("~0", "~") for segment in mutation["path"].split("/")[1:]]
        parent: Any = value
        for segment in segments[:-1]:
            parent = parent[int(segment)] if isinstance(parent, list) else parent[segment]
        key = segments[-1]
        if isinstance(parent, list):
            index = int(key)
            if mutation["op"] == "remove":
                parent.pop(index)
            elif mutation["op"] == "add":
                parent.insert(index, copy.deepcopy(mutation.get("value")))
            else:
                parent[index] = copy.deepcopy(mutation.get("value"))
        elif mutation["op"] == "remove":
            del parent[key]
        else:
            parent[key] = copy.deepcopy(mutation.get("value"))
    return value


class SharedObservationContractFixtureTests(unittest.TestCase):
    def test_actual_python_ingestion_matches_shared_semantic_expectations(self):
        corpus = load_corpus()
        required_categories = {
            "offset-parity",
            "numeric-strings",
            "invalid-ids",
            "extra-fields",
            "source-ids",
            "non-point-crs-fields",
            "model-crs",
            "timestamp-grammar",
            "timestamp-calendar",
            "counts",
            "confidence-pairs",
            "environments",
        }
        self.assertTrue(required_categories <= {case["category"] for case in corpus["cases"]})

        for fixture_case in corpus["cases"]:
            with self.subTest(case=fixture_case["name"]), tempfile.TemporaryDirectory() as temporary:
                record = materialize_fixture(corpus, fixture_case)
                root = Path(temporary)
                source_path = root / "observation.json"
                output_path = root / "normalized.csv"
                source_path.write_text(json.dumps([record]), encoding="utf-8")

                def ingest() -> None:
                    ingest_observations(
                        source_path,
                        output_path,
                        source_id=fixture_case["ingest_source_id"],
                        primary_target_taxon_id=fixture_case["ingest_target_taxon_id"],
                    )

                if fixture_case["expected_semantic_valid"]:
                    ingest()
                    self.assertTrue(output_path.exists())
                    if fixture_case["name"] == "valid-production-explicit-offset":
                        with output_path.open(newline="", encoding="utf-8") as handle:
                            normalized = next(csv.DictReader(handle))
                        self.assertEqual(normalized["observed_at"], "2026-07-16T15:00:00Z")
                        self.assertEqual(normalized["observed_end_at"], "2026-07-16T17:30:00Z")
                else:
                    with self.assertRaises(ValueError):
                        ingest()


if __name__ == "__main__":
    unittest.main()
