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

from pipeline.contourcast.sediment_dbf_support_audit import (
    DBF_FIELD_SPECS,
    DBF_HEADER_LENGTH,
    DBF_RECORD_LENGTH,
    DS182_SOURCE_ID,
    _bounded_partition_audit,
    _parse_exact_dbf,
    _point_shapefile_coordinates,
    audit_usgs_ds182_sediment_dbf_support,
)
from pipeline.contourcast.sediment_endpoint_audit import SOURCE_HEADER


ROOT = Path(__file__).resolve().parents[2]


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _csv_bytes(header: tuple[str, ...], rows: list[list[str]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


def _dbf(rows: list[dict[str, str]]) -> bytes:
    data = bytearray(DBF_HEADER_LENGTH + len(rows) * DBF_RECORD_LENGTH + 1)
    data[0] = 0x03
    struct.pack_into("<I", data, 4, len(rows))
    struct.pack_into("<2H", data, 8, DBF_HEADER_LENGTH, DBF_RECORD_LENGTH)
    for index, (name, field_type, width, decimals, _canonical) in enumerate(
        DBF_FIELD_SPECS
    ):
        offset = 32 + index * 32
        encoded_name = name.encode("ascii")
        data[offset : offset + 11] = encoded_name + b"\0" * (11 - len(encoded_name))
        data[offset + 11] = ord(field_type)
        data[offset + 16] = width
        data[offset + 17] = decimals
    data[DBF_HEADER_LENGTH - 1] = 0x0D
    for row_index, row in enumerate(rows):
        start = DBF_HEADER_LENGTH + row_index * DBF_RECORD_LENGTH
        data[start] = 0x20
        offset = start + 1
        for _name, field_type, width, _decimals, canonical in DBF_FIELD_SPECS:
            value = row.get(canonical, "")
            encoded = value.encode("ascii")
            if len(encoded) > width:
                raise ValueError(f"fixture field {canonical} is too wide")
            if field_type == "C":
                encoded = encoded.ljust(width, b" ")
            else:
                encoded = encoded.rjust(width, b" ")
            data[offset : offset + width] = encoded
            offset += width
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
    for record_number, (longitude, latitude) in enumerate(points, start=1):
        struct.pack_into(">2i", data, offset, record_number, 10)
        struct.pack_into("<idd", data, offset + 8, 1, longitude, latitude)
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
) -> dict[str, str]:
    return {
        "Latitude": "37.75000",
        "Longitude": "-122.50000",
        "WaterDepth": "20",
        "SampleTop": "0",
        "SampleBase": ".1",
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


class SedimentDbfSupportAuditTests(unittest.TestCase):
    def test_receipt_binds_exact_negative_dbf_result(self) -> None:
        receipt = json.loads(
            (
                ROOT
                / "pipeline/evidence/usgs-ds182-sediment-dbf-support-v1.receipt.json"
            ).read_text(encoding="utf-8")
        )
        for key in ("result", "protocol", "source_manifest"):
            artifact = ROOT / receipt[key]["path"]
            self.assertEqual(_sha(artifact.read_bytes()), receipt[key]["sha256"])
        self.assertEqual(receipt["experiment_class"], "exploratory_same_release_representation")
        self.assertTrue(receipt["audit"]["source_schema"]["valid"])
        self.assertEqual(receipt["audit"]["row_flow"]["endpoint_valid_rows"], 0)
        self.assertEqual(receipt["audit"]["partition_audit"]["candidate_whole_source_partitions"], 0)
        self.assertFalse(receipt["decision"]["raw_endpoint_support_admissible"])
        self.assertFalse(receipt["decision"]["confirmatory_claim_authorized"])
        self.assertFalse(receipt["decision"]["model_training_run"])
        self.assertFalse(receipt["official_inputs"]["reference_raster"]["pixels_read"])

    def test_exact_dbf_parser_requires_frozen_schema_and_decoding(self) -> None:
        data = _dbf(
            [
                _outcome_row(
                    dataset="1",
                    site="10",
                    sample="100",
                    gravel="5",
                    sand="95",
                    mud="0",
                )
            ]
        )
        rows, schema = _parse_exact_dbf(data)
        self.assertEqual(rows[0]["DataSetKey"], "1")
        self.assertEqual(rows[0]["DataTypes"], "GRZ")
        self.assertEqual(rows[0]["SamplePhase"], "")
        self.assertEqual(schema["records"], 1)
        self.assertEqual(schema["field_count"], 32)

        descriptor_drift = bytearray(data)
        descriptor_drift[32] = ord("X")
        with self.assertRaisesRegex(ValueError, "field descriptors"):
            _parse_exact_dbf(bytes(descriptor_drift))

        deleted = bytearray(data)
        deleted[DBF_HEADER_LENGTH] = ord("*")
        with self.assertRaisesRegex(ValueError, "deleted or unknown"):
            _parse_exact_dbf(bytes(deleted))

        malformed_numeric = bytearray(data)
        latitude_offset = DBF_HEADER_LENGTH + 1
        malformed_numeric[latitude_offset] = ord("Q")
        with self.assertRaisesRegex(ValueError, "invalid numeric bytes"):
            _parse_exact_dbf(bytes(malformed_numeric))

    def test_point_parser_preserves_same_position_coordinates(self) -> None:
        points = [(-122.5, 37.75), (-122.4, 37.8)]
        self.assertEqual(_point_shapefile_coordinates(_shp(points)), points)
        malformed = bytearray(_shp(points))
        struct.pack_into(">i", malformed, 128, 3)
        with self.assertRaisesRegex(ValueError, "sequence"):
            _point_shapefile_coordinates(bytes(malformed))

    def test_partition_audit_fails_closed_above_frozen_group_limit(self) -> None:
        rows = [
            {
                "dataset_key": str(index),
                "site_key": str(index),
                "anchors": {name: True for name in ("gravel_bearing", "mud_bearing", "sand_dominant")},
            }
            for index in range(1, 4)
        ]
        result = _bounded_partition_audit(
            rows,
            min_rows=1,
            min_sites=1,
            min_anchor_rows=1,
            min_anchor_sites=1,
            min_train_sources=1,
            max_source_groups=2,
        )
        self.assertFalse(result["performed"])
        self.assertEqual(result["candidate_partition_count"], 3)
        self.assertEqual(
            result["failure"], "source_group_count_exceeds_exhaustive_limit"
        )

    def test_end_to_end_dbf_audit_is_exploratory_and_reads_no_pixels(self) -> None:
        try:
            import numpy as np
            import rasterio
            from rasterio.transform import from_origin
        except ImportError:
            self.skipTest("rasterio is not installed")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows: list[dict[str, str]] = []
            for dataset in range(1, 5):
                site_base = dataset * 10
                sample_base = dataset * 100
                rows.extend(
                    [
                        _outcome_row(
                            dataset=str(dataset),
                            site=str(site_base),
                            sample=str(sample_base),
                            gravel="5",
                            sand="95",
                            mud="0",
                        ),
                        _outcome_row(
                            dataset=str(dataset),
                            site=str(site_base + 1),
                            sample=str(sample_base + 1),
                            gravel="0",
                            sand="80",
                            mud="20",
                        ),
                        _outcome_row(
                            dataset=str(dataset),
                            site=str(site_base + 2),
                            sample=str(sample_base + 2),
                            gravel="0",
                            sand="100",
                            mud="0",
                        ),
                    ]
                )
            dbf_bytes = _dbf(rows)
            shp_bytes = _shp([(-122.5, 37.75)] * len(rows))
            members = {"pac_ext.dbf": dbf_bytes, "pac_ext.shp": shp_bytes}
            archive_path = root / "pac_ext.zip"
            with ZipFile(archive_path, "w", ZIP_DEFLATED) as archive:
                for name, value in members.items():
                    archive.writestr(name, value)

            source_rows = []
            for dataset in range(1, 5):
                row = {name: "fixture" for name in SOURCE_HEADER}
                row.update(
                    {
                        "DataSetKey": str(dataset),
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
                "record_count": len(rows),
                "published_metadata_record_count": len(rows) + 1,
                "members": [
                    {"path": name, "bytes": len(value), "sha256": _sha(value)}
                    for name, value in members.items()
                ],
            }
            manifest = {
                "access": {
                    "outcome_asset": outcome_spec,
                    "source_table": {
                        "sha256": _sha(source_bytes),
                        "bytes": len(source_bytes),
                        "record_count": 4,
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
                    "pipeline.contourcast.sediment_dbf_support_audit.assert_source_operation"
                ),
                patch(
                    "pipeline.contourcast.sediment_dbf_support_audit.get_source_manifest",
                    side_effect=source_lookup,
                ),
            ):
                result = audit_usgs_ds182_sediment_dbf_support(
                    archive_path,
                    source_path,
                    raster_path,
                    root / "output",
                    min_rows=3,
                    min_sites=3,
                    min_anchor_rows=1,
                    min_anchor_sites=1,
                    min_train_sources=3,
                )
            metrics = json.loads(result["metrics"].read_text(encoding="utf-8"))
            run = json.loads(result["run_metadata"].read_text(encoding="utf-8"))
            self.assertTrue(metrics["decision"]["raw_endpoint_support_admissible"])
            self.assertEqual(metrics["partition_audit"]["eligible_partition_count"], 3)
            self.assertFalse(metrics["official_inputs"]["reference_raster"]["pixels_read"])
            self.assertFalse(metrics["decision"]["confirmatory_claim_authorized"])
            self.assertFalse(metrics["decision"]["model_training_run"])
            self.assertEqual(
                run["dataset_kind"],
                "official_sediment_endpoint_exploratory_dbf_support_audit",
            )
            self.assertIsNone(run["target_taxon_id"])

            mismatched_members = {
                "pac_ext.dbf": dbf_bytes,
                "pac_ext.shp": _shp([(-122.4, 37.75)] + [(-122.5, 37.75)] * (len(rows) - 1)),
            }
            mismatched_archive = root / "pac_ext-mismatch.zip"
            with ZipFile(mismatched_archive, "w", ZIP_DEFLATED) as archive:
                for name, value in mismatched_members.items():
                    archive.writestr(name, value)
            mismatch_spec = {
                **outcome_spec,
                "archive_sha256": _sha(mismatched_archive.read_bytes()),
                "archive_bytes": mismatched_archive.stat().st_size,
                "members": [
                    {"path": name, "bytes": len(value), "sha256": _sha(value)}
                    for name, value in mismatched_members.items()
                ],
            }
            mismatch_manifest = {
                "access": {**manifest["access"], "outcome_asset": mismatch_spec}
            }

            def mismatch_lookup(source_id: str):
                if source_id == DS182_SOURCE_ID:
                    return mismatch_manifest
                if source_id == "reference-source":
                    return reference_manifest
                raise AssertionError(source_id)

            with (
                patch(
                    "pipeline.contourcast.sediment_dbf_support_audit.assert_source_operation"
                ),
                patch(
                    "pipeline.contourcast.sediment_dbf_support_audit.get_source_manifest",
                    side_effect=mismatch_lookup,
                ),
                self.assertRaisesRegex(ValueError, "disagrees with Point geometry"),
            ):
                audit_usgs_ds182_sediment_dbf_support(
                    mismatched_archive,
                    source_path,
                    raster_path,
                    root / "mismatch-output",
                )


if __name__ == "__main__":
    unittest.main()
