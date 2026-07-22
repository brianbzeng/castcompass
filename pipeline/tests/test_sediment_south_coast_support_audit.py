from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.contourcast.sediment_south_coast_support_audit import (
    REGION_PRIORITY,
    _assign_region_membership,
    _verify_region_rasters,
)

ROOT = Path(__file__).resolve().parents[2]


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SedimentSouthCoastSupportAuditTests(unittest.TestCase):
    def test_receipt_binds_exact_negative_south_coast_result(self) -> None:
        receipt = json.loads(
            (
                ROOT
                / "pipeline/evidence/usgs-south-coast-sediment-support-v1.receipt.json"
            ).read_text(encoding="utf-8")
        )
        artifacts = [
            receipt["result"],
            receipt["protocol"],
            *receipt["source_manifests"].values(),
            receipt["source_policy"],
        ]
        for artifact_record in artifacts:
            artifact = ROOT / artifact_record["path"]
            self.assertEqual(_sha(artifact), artifact_record["sha256"])

        self.assertEqual(receipt["audit"]["row_flow"]["endpoint_valid_rows"], 26)
        self.assertEqual(
            receipt["audit"]["partition_audit"][
                "candidate_whole_source_partitions"
            ],
            3,
        )
        self.assertEqual(
            receipt["audit"]["partition_audit"][
                "eligible_whole_source_partitions"
            ],
            0,
        )
        self.assertFalse(receipt["decision"]["raw_endpoint_support_admissible"])
        self.assertFalse(receipt["decision"]["model_training_run"])
        self.assertFalse(receipt["audit"]["footprint_assignment"]["raster_pixels_read"])

    def test_region_assignment_uses_frozen_priority_without_pixels(self) -> None:
        metadata = {
            "offshore_refugio_beach": {
                "crs": "EPSG:4326",
                "bounds": [-123.0, 34.0, -122.0, 35.0],
            },
            "offshore_coal_oil_point": {
                "crs": "EPSG:4326",
                "bounds": [-122.5, 34.0, -121.5, 35.0],
            },
            "offshore_santa_barbara": {
                "crs": "EPSG:4326",
                "bounds": [-121.5, 34.0, -120.5, 35.0],
            },
            "offshore_carpinteria": {
                "crs": "EPSG:4326",
                "bounds": [-120.5, 34.0, -119.5, 35.0],
            },
        }
        assignments, overlaps = _assign_region_membership(
            [-122.25, -121.0, -120.0, -118.0],
            [34.5, 34.5, 34.5, 34.5],
            metadata,
        )
        self.assertEqual(
            assignments,
            [
                "offshore_refugio_beach",
                "offshore_santa_barbara",
                "offshore_carpinteria",
                None,
            ],
        )
        self.assertEqual(overlaps, 1)

    def test_raster_verification_binds_exact_bytes_and_reads_metadata_only(self) -> None:
        try:
            import numpy as np
            import rasterio
            from rasterio.transform import from_origin
        except ImportError:
            self.skipTest("rasterio is not installed")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raster_paths: dict[str, Path] = {}
            region_specs: dict[str, dict[str, object]] = {}
            manifest_regions: dict[str, dict[str, object]] = {}
            for index, region in enumerate(REGION_PRIORITY):
                name = f"fixture-{region}.tif"
                path = root / name
                transform = from_origin(-123 + index, 35, 0.01, 0.01)
                with rasterio.open(
                    path,
                    "w",
                    driver="GTiff",
                    width=2,
                    height=2,
                    count=1,
                    dtype="float32",
                    crs="EPSG:4326",
                    transform=transform,
                ) as dataset:
                    dataset.write(np.ones((1, 2, 2), dtype=np.float32))
                with rasterio.open(path) as dataset:
                    specification = {
                        "geotiff_path": name,
                        "geotiff_sha256": _sha(path),
                        "crs": str(dataset.crs),
                        "transform": [float(value) for value in tuple(dataset.transform)],
                        "width": dataset.width,
                        "height": dataset.height,
                        "bounds": [float(value) for value in tuple(dataset.bounds)],
                    }
                raster_paths[region] = path
                region_specs[region] = specification
                manifest_regions[region] = {
                    "bathymetry": {
                        "geotiff_path": name,
                        "geotiff_sha256": specification["geotiff_sha256"],
                    }
                }
            manifest = {
                "access": {
                    "region_priority": list(REGION_PRIORITY),
                    "regions": manifest_regions,
                }
            }
            verified = _verify_region_rasters(
                raster_paths, manifest, region_specs=region_specs
            )
            self.assertEqual(tuple(verified), REGION_PRIORITY)
            self.assertTrue(all(not item["pixels_read"] for item in verified.values()))

            mutated = path.read_bytes() + b"drift"
            path.write_bytes(mutated)
            with self.assertRaisesRegex(ValueError, "checksum"):
                _verify_region_rasters(
                    raster_paths, manifest, region_specs=region_specs
                )


if __name__ == "__main__":
    unittest.main()
