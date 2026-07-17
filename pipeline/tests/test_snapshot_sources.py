import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from scripts import generate_snapshot


class SnapshotSourceTests(unittest.TestCase):
    def test_published_snapshot_matches_content_addressed_scoring_source(self):
        root = Path(__file__).resolve().parents[2]
        snapshot = json.loads((root / "public" / "data" / "opportunities.json").read_text(encoding="utf-8"))
        version, digest = generate_snapshot.scoring_system_identity()
        self.assertEqual(snapshot["scoring_system_version"], version)
        self.assertEqual(snapshot["scoring_system_sha256"], digest)
        self.assertEqual(snapshot["modelVersion"], version)
        self.assertTrue(snapshot["windows"])
        self.assertTrue(all(window["modelVersion"] == version for window in snapshot["windows"]))
        self.assertTrue(all(window["scoring_system_sha256"] == digest for window in snapshot["windows"]))

    def test_buoy_scans_each_variable_for_its_latest_valid_row(self):
        payload = """#YY MM DD hh mm WVHT WTMP
#yr mo dy hr mn m degC
2026 07 11 10 00 1.2 MM
2026 07 11 09 00 MM 13.0
2026 07 11 08 00 1.0 12.8
"""
        with patch.object(generate_snapshot, "request_text", return_value=payload):
            result = generate_snapshot.fetch_buoy_observation("46026")

        self.assertEqual(result["status"], "fresh")
        self.assertEqual(result["observed"], datetime(2026, 7, 11, 10, tzinfo=timezone.utc))
        self.assertEqual(result["swellObserved"], datetime(2026, 7, 11, 10, tzinfo=timezone.utc))
        self.assertEqual(result["waterObserved"], datetime(2026, 7, 11, 9, tzinfo=timezone.utc))
        self.assertEqual(result["swellFeet"], 3.9)
        self.assertEqual(result["waterTempF"], 55.4)

    def test_marine_sst_batches_anchors_and_converts_celsius(self):
        start = datetime(2026, 7, 11, 10, tzinfo=timezone.utc)
        end = start + timedelta(hours=72)
        payload = [
            {
                "hourly": {
                    "time": ["2026-07-11T11:00", "2026-07-11T12:00"],
                    "sea_surface_temperature": [13.0, None],
                    "wave_height": [1.0, 1.2],
                    "wave_period": [8.0, 8.5],
                    "wave_direction": [270.0, 275.0],
                    "ocean_current_velocity": [1.852, 0.926],
                    "ocean_current_direction": [45.0, 90.0],
                }
            },
            {
                "hourly": {
                    "time": ["2026-07-11T11:00", "2026-07-11T12:00"],
                    "sea_surface_temperature": [14.0, 14.2],
                    "wave_height": [0.5, 0.6],
                    "wave_period": [7.0, 7.5],
                    "wave_direction": [225.0, 230.0],
                    "ocean_current_velocity": [0.5, 0.75],
                    "ocean_current_direction": [180.0, 225.0],
                }
            },
        ]
        captured_urls = []

        def fake_request(url):
            captured_urls.append(url)
            return payload

        with patch.object(generate_snapshot, "request_json", side_effect=fake_request):
            results = generate_snapshot.fetch_marine_sst(["point-reyes", "central-bay"], start, end)

        self.assertEqual(len(captured_urls), 1)
        query = parse_qs(urlparse(captured_urls[0]).query)
        self.assertEqual(query["latitude"], ["38.0400,37.8000"])
        self.assertEqual(query["longitude"], ["-122.9600,-122.3900"])
        self.assertEqual(
            query["hourly"],
            ["sea_surface_temperature,wave_height,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction"],
        )
        self.assertEqual(query["cell_selection"], ["sea"])
        self.assertEqual(results["point-reyes"]["status"], "fresh")
        self.assertEqual(results["point-reyes"]["values"][0][1], 55.4)
        self.assertEqual(results["central-bay"]["values"][0][1], 57.2)
        self.assertEqual(results["point-reyes"]["currentValues"][0][1:], (1.0, 45.0))
        self.assertEqual(results["central-bay"]["waveValues"][0][1:], (1.6, 7.0, 225.0))

    def test_sst_for_window_never_invents_a_distant_or_missing_value(self):
        midpoint = datetime(2026, 7, 11, 11, tzinfo=timezone.utc)
        self.assertIsNone(generate_snapshot.sst_for_window([], midpoint))
        self.assertIsNone(
            generate_snapshot.sst_for_window([(midpoint - timedelta(hours=2), 55.0)], midpoint)
        )
        self.assertEqual(
            generate_snapshot.sst_for_window([(midpoint - timedelta(minutes=30), 55.0)], midpoint),
            55.0,
        )


if __name__ == "__main__":
    unittest.main()
