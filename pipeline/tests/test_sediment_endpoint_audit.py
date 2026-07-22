from __future__ import annotations

import csv
import hashlib
import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from pipeline.contourcast.sediment_endpoint_audit import (
    DS182_SOURCE_ID,
    OUTCOME_HEADER,
    SOURCE_HEADER,
    _parse_exact_csv,
    _point_shapefile_record_count,
    _read_exact_archive,
    audit_usgs_ds182_sediment_endpoint_support,
)


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _csv_bytes(header: tuple[str, ...], rows: list[list[str]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


def _dbf(record_count: int) -> bytes:
    header_length = 33
    record_length = 2
    data = bytearray(header_length + record_count * record_length + 1)
    data[0] = 0x03
    struct.pack_into("<I", data, 4, record_count)
    struct.pack_into("<2H", data, 8, header_length, record_length)
    data[32] = 0x0D
    for index in range(record_count):
        data[header_length + index * record_length] = 0x20
    data[-1] = 0x1A
    return bytes(data)


def _shp(points: list[tuple[float, float]]) -> bytes:
    data = bytearray(100 + len(points) * 28)
    struct.pack_into(">i", data, 0, 9994)
    struct.pack_into(">5i", data, 4, 0, 0, 0, 0, 0)
    struct.pack_into(">i", data, 24, len(data) // 2)
    struct.pack_into("<2i", data, 28, 1000, 1)
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    struct.pack_into("<4d", data, 36, min(xs), min(ys), max(xs), max(ys))
    offset = 100
    for record_number, (x, y) in enumerate(points, start=1):
        struct.pack_into(">2i", data, offset, record_number, 10)
        struct.pack_into("<idd", data, offset + 8, 1, x, y)
        offset += 28
    return bytes(data)


def _outcome_row(
    *,
    dataset: str,
    site: str,
    sample: str,
    gravel: str,
    sand: str,
    mud: str,
) -> list[str]:
    values = {name: "" for name in OUTCOME_HEADER}
    values.update(
        {
            "Latitude": "37.75",
            "Longitude": "-122.50",
            "WaterDepth": "20",
            "SampleTop": "0",
            "SampleBase": "0.1",
            "SiteName": f"site-{site}",
            "DataSetKey": dataset,
            "SiteKey": site,
            "SampleKey": sample,
            "Sampler": "Grab",
            "DataTypes": "GRZ",
            "Gravel": gravel,
            "Sand": sand,
            "Mud": mud,
            "Clay": "-99",
            "Grainsize": "-99",
            "Sorting": "-99",
            "ClsMshp": "-99",
            "RockMshp": "-99",
            "WeedMshp": "-99",
            "Carbonate": "-99",
            "OrgCarbon": "-99",
            "LgShearStr": "-99",
            "Porosity": "-99",
            "PWaveVel": "-99",
            "LgCrShSt": "-99",
        }
    )
    return [values[name] for name in OUTCOME_HEADER]


class SedimentEndpointAuditTests(unittest.TestCase):
    def test_exact_csv_parser_rejects_header_and_width_drift(self) -> None:
        valid = _csv_bytes(("a", "b"), [["1", "2"]])
        self.assertEqual(
            _parse_exact_csv(valid, expected_header=("a", "b"), label="fixture"),
            [{"a": "1", "b": "2"}],
        )
        with self.assertRaisesRegex(ValueError, "header"):
            _parse_exact_csv(valid, expected_header=("b", "a"), label="fixture")
        with self.assertRaisesRegex(ValueError, "row width"):
            _parse_exact_csv(b"a,b\r\n1\r\n", expected_header=("a", "b"), label="fixture")

    def test_point_record_counter_rejects_header_drift(self) -> None:
        data = _shp([(-122.5, 37.75), (-122.4, 37.8)])
        self.assertEqual(_point_shapefile_record_count(data), 2)
        invalid = bytearray(data)
        struct.pack_into(">i", invalid, 24, 1)
        with self.assertRaisesRegex(ValueError, "length"):
            _point_shapefile_record_count(bytes(invalid))

    def test_archive_inventory_is_exact_and_content_addressed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "fixture.zip"
            members = {"PAC_EXT.txt": b"a,b\r\n1,2\r\n", "pac_ext.dbf": _dbf(1)}
            with ZipFile(archive_path, "w", ZIP_DEFLATED) as archive:
                for name, data in members.items():
                    archive.writestr(name, data)
            spec = {
                "archive_sha256": _sha(archive_path.read_bytes()),
                "archive_bytes": archive_path.stat().st_size,
                "members": [
                    {"path": name, "bytes": len(data), "sha256": _sha(data)}
                    for name, data in members.items()
                ],
            }
            self.assertEqual(_read_exact_archive(archive_path, spec), members)
            weakened = json.loads(json.dumps(spec))
            weakened["members"][0]["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "member checksum"):
                _read_exact_archive(archive_path, weakened)

    def test_end_to_end_support_audit_uses_whole_sources_and_reads_no_pixels(self) -> None:
        try:
            import numpy as np
            import rasterio
            from rasterio.transform import from_origin
        except ImportError:
            self.skipTest("rasterio is not installed")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outcome_rows: list[list[str]] = []
            for dataset, site_base, sample_base in (("1", 10, 100), ("2", 20, 200)):
                outcome_rows.extend(
                    [
                        _outcome_row(
                            dataset=dataset,
                            site=str(site_base),
                            sample=str(sample_base),
                            gravel="5",
                            sand="95",
                            mud="0",
                        ),
                        _outcome_row(
                            dataset=dataset,
                            site=str(site_base + 1),
                            sample=str(sample_base + 1),
                            gravel="0",
                            sand="80",
                            mud="20",
                        ),
                        _outcome_row(
                            dataset=dataset,
                            site=str(site_base + 2),
                            sample=str(sample_base + 2),
                            gravel="0",
                            sand="100",
                            mud="0",
                        ),
                    ]
                )
            outcome_bytes = _csv_bytes(OUTCOME_HEADER, outcome_rows)
            dbf_bytes = _dbf(len(outcome_rows))
            shp_bytes = _shp([(-122.5, 37.75)] * len(outcome_rows))
            archive_path = root / "pac_ext.zip"
            members = {
                "PAC_EXT.txt": outcome_bytes,
                "pac_ext.dbf": dbf_bytes,
                "pac_ext.shp": shp_bytes,
            }
            with ZipFile(archive_path, "w", ZIP_DEFLATED) as archive:
                for name, data in members.items():
                    archive.writestr(name, data)

            source_rows = []
            for dataset in ("1", "2"):
                row = {name: "fixture" for name in SOURCE_HEADER}
                row.update(
                    {
                        "DataSetKey": dataset,
                        "DataSet_{DataFile}": f"source-{dataset}",
                        "NavMethod": "DGPS",
                    }
                )
                source_rows.append([row[name] for name in SOURCE_HEADER])
            source_bytes = _csv_bytes(SOURCE_HEADER, source_rows)
            source_path = root / "pac_src.txt"
            source_path.write_bytes(source_bytes)

            raster_path = root / "reference.tif"
            with rasterio.open(
                raster_path,
                "w",
                driver="GTiff",
                width=100,
                height=100,
                count=1,
                dtype="float32",
                crs="EPSG:4326",
                transform=from_origin(-123, 38, 0.01, 0.01),
            ) as dataset:
                dataset.write(np.ones((1, 100, 100), dtype=np.float32))
            raster_sha = _sha(raster_path.read_bytes())
            with rasterio.open(raster_path) as dataset:
                reference = {
                    "source_id": "reference-source",
                    "geotiff_sha256": raster_sha,
                    "crs": str(dataset.crs),
                    "transform": [float(value) for value in tuple(dataset.transform)],
                    "width": dataset.width,
                    "height": dataset.height,
                    "bounds": [float(value) for value in tuple(dataset.bounds)],
                }
            outcome_spec = {
                "archive_sha256": _sha(archive_path.read_bytes()),
                "archive_bytes": archive_path.stat().st_size,
                "data_member": "PAC_EXT.txt",
                "record_count": len(outcome_rows),
                "published_metadata_record_count": len(outcome_rows) + 1,
                "members": [
                    {"path": name, "bytes": len(data), "sha256": _sha(data)}
                    for name, data in members.items()
                ],
            }
            manifest = {
                "access": {
                    "outcome_asset": outcome_spec,
                    "source_table": {
                        "sha256": _sha(source_bytes),
                        "bytes": len(source_bytes),
                        "record_count": 2,
                    },
                    "reference_raster": reference,
                }
            }
            reference_manifest = {
                "access": {"bathymetry_geotiff_sha256": raster_sha}
            }

            def source_lookup(source_id: str):
                if source_id == DS182_SOURCE_ID:
                    return manifest
                if source_id == "reference-source":
                    return reference_manifest
                raise AssertionError(source_id)

            with (
                patch(
                    "pipeline.contourcast.sediment_endpoint_audit.assert_source_operation"
                ),
                patch(
                    "pipeline.contourcast.sediment_endpoint_audit.get_source_manifest",
                    side_effect=source_lookup,
                ),
            ):
                result = audit_usgs_ds182_sediment_endpoint_support(
                    archive_path,
                    source_path,
                    raster_path,
                    root / "output",
                    min_rows=3,
                    min_sites=3,
                    min_anchor_rows=1,
                    min_anchor_sites=1,
                    min_train_sources=1,
                )
            metrics = json.loads(result["metrics"].read_text(encoding="utf-8"))
            run = json.loads(result["run_metadata"].read_text(encoding="utf-8"))
            self.assertTrue(metrics["decision"]["raw_endpoint_support_admissible"])
            self.assertEqual(metrics["partition_audit"]["eligible_partition_count"], 1)
            self.assertFalse(metrics["official_inputs"]["reference_raster"]["pixels_read"])
            self.assertFalse(metrics["decision"]["model_training_run"])
            self.assertEqual(run["dataset_kind"], "official_sediment_endpoint_support_audit")
            self.assertIsNone(run["target_taxon_id"])


if __name__ == "__main__":
    unittest.main()
