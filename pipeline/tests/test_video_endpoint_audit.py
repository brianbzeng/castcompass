import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

import numpy as np

from pipeline.contourcast.video_endpoint_audit import (
    RESIDUAL_STATEWIDE_VIDEO_CRUISES,
    SOUTH_COAST_REGION_PRIORITY,
    VIDEO_CLASS_NAMES,
    _parse_dbf_required_fields,
    _parse_point_shapefile,
    _read_archive,
    _whole_group_partition_audit,
    audit_usgs_residual_statewide_video_support,
    audit_usgs_sf_video_endpoint,
    audit_usgs_south_coast_video_endpoint,
)


ROOT = Path(__file__).resolve().parents[2]


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _point_shapefile(points):
    xmin = min(point[0] for point in points)
    ymin = min(point[1] for point in points)
    xmax = max(point[0] for point in points)
    ymax = max(point[1] for point in points)
    records = []
    for index, (x, y) in enumerate(points, start=1):
        content = struct.pack("<idd", 1, x, y)
        records.append(struct.pack(">2i", index, len(content) // 2) + content)
    size = 100 + sum(map(len, records))
    header = bytearray(100)
    struct.pack_into(">i", header, 0, 9994)
    struct.pack_into(">i", header, 24, size // 2)
    struct.pack_into("<2i", header, 28, 1000, 1)
    struct.pack_into("<8d", header, 36, xmin, ymin, xmax, ymax, 0, 0, 0, 0)
    return bytes(header) + b"".join(records)


def _dbf(rows):
    return _typed_dbf(rows, (("CLASS", "C", 8, 0), ("LINE", "C", 8, 0), ("TAPE", "C", 8, 0)))


def _typed_dbf(rows, fields):
    header_length = 32 + 32 * len(fields) + 1
    record_length = 1 + sum(length for _, _, length, _ in fields)
    header = bytearray(header_length)
    header[0] = 0x03
    struct.pack_into("<I", header, 4, len(rows))
    struct.pack_into("<2H", header, 8, header_length, record_length)
    for index, (name, field_type, length, decimals) in enumerate(fields):
        offset = 32 + index * 32
        encoded = name.encode("ascii")
        header[offset : offset + len(encoded)] = encoded
        header[offset + 11] = ord(field_type)
        header[offset + 16] = length
        header[offset + 17] = decimals
    header[-1] = 0x0D
    records = []
    for row in rows:
        record = bytearray(b" ")
        for value, (_, field_type, length, decimals) in zip(row, fields):
            encoded = str(value).encode("ascii")
            if field_type in {"F", "N"}:
                encoded = encoded.rjust(length, b" ")
            else:
                encoded = encoded.ljust(length, b" ")
            if len(encoded) != length:
                raise ValueError(f"fixture value does not fit declared DBF width: {decimals}")
            record.extend(encoded)
        records.append(bytes(record))
    return bytes(header) + b"".join(records) + b"\x1a"


def _archive(path, cruise, rows, *, extra=None):
    stem = f"{cruise.upper()}_video_observations"
    members = {
        f"{stem}.shp": _point_shapefile(
            [(-122.50 + index * 0.001, 37.75 + index * 0.001) for index in range(len(rows))]
        ),
        f"{stem}.dbf": _dbf(rows),
        f"{stem}.prj": b"WGS84",
    }
    if extra:
        members.update(extra)
    with ZipFile(path, "w", compression=ZIP_DEFLATED) as archive:
        for name, value in members.items():
            archive.writestr(name, value)
    specs = [
        {"path": name, "bytes": len(value), "sha256": _sha(value)}
        for name, value in members.items()
    ]
    return {
        "cruise_id": cruise,
        "dataset_stem": stem,
        "archive_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "record_count": len(rows),
        "members": specs,
    }


class VideoEndpointAuditTests(unittest.TestCase):
    def test_committed_receipt_binds_manifest_and_negative_decision(self):
        receipt = json.loads(
            (ROOT / "pipeline/evidence/usgs-sf-video-endpoint-audit-v1.receipt.json").read_text(
                encoding="utf-8"
            )
        )
        manifest_path = ROOT / receipt["source_manifest"]["path"]
        self.assertEqual(_sha(manifest_path.read_bytes()), receipt["source_manifest"]["sha256"])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        specs = {
            item["cruise_id"]: item
            for item in manifest["access"]["video_observation_assets"]
        }
        for cruise_id, recorded in receipt["official_inputs"]["video_archives"].items():
            self.assertEqual(specs[cruise_id]["archive_sha256"], recorded["sha256"])
            self.assertEqual(specs[cruise_id]["record_count"], recorded["record_count"])
        self.assertEqual(receipt["audit"]["eligible_whole_group_partitions"], 0)
        self.assertFalse(receipt["decision"]["video_probe_admissible"])
        self.assertFalse(receipt["decision"]["model_training_run"])

    def test_south_coast_receipt_binds_frozen_protocol_and_negative_decision(self):
        receipt = json.loads(
            (
                ROOT
                / "pipeline/evidence/usgs-south-coast-video-endpoint-audit-v1.receipt.json"
            ).read_text(encoding="utf-8")
        )
        manifest_path = ROOT / receipt["source_manifest"]["path"]
        protocol_path = ROOT / receipt["protocol"]["path"]
        self.assertEqual(_sha(manifest_path.read_bytes()), receipt["source_manifest"]["sha256"])
        self.assertEqual(_sha(protocol_path.read_bytes()), receipt["protocol"]["sha256"])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        specs = {
            item["cruise_id"]: item
            for item in manifest["access"]["video_observation_assets"]
        }
        for cruise_id, recorded in receipt["official_inputs"]["video_archives"].items():
            self.assertEqual(specs[cruise_id]["archive_sha256"], recorded["sha256"])
            self.assertEqual(specs[cruise_id]["record_count"], recorded["record_count"])
        self.assertTrue(receipt["protocol"]["frozen_before_confirmatory_label_read"])
        self.assertEqual(
            receipt["audit"]["retained_class_counts"]["mobile_coarse_sediment"], 0
        )
        self.assertEqual(receipt["audit"]["eligible_whole_cruise_partitions"], 0)
        self.assertFalse(receipt["decision"]["video_probe_admissible"])
        self.assertFalse(receipt["decision"]["model_training_run"])

    def test_strict_point_and_dbf_parsers(self):
        points = [(-122.5, 37.7), (-122.4, 37.8)]
        parsed_points = _parse_point_shapefile(_point_shapefile(points))
        np.testing.assert_allclose(parsed_points, points)
        fields = _parse_dbf_required_fields(_dbf((("1", "26", "29"), ("4", "27", "30"))))
        self.assertEqual(fields["CLASS"], ["1", "4"])
        self.assertEqual(fields["LINE"], ["26", "27"])
        self.assertEqual(fields["TAPE"], ["29", "30"])

        invalid = bytearray(_point_shapefile(points))
        struct.pack_into(">i", invalid, 24, 1)
        with self.assertRaisesRegex(ValueError, "header"):
            _parse_point_shapefile(bytes(invalid))
        deleted = bytearray(_dbf((("1", "26", "29"),)))
        deleted[129] = ord("*")
        with self.assertRaisesRegex(ValueError, "deleted"):
            _parse_dbf_required_fields(bytes(deleted))

    def test_numeric_dbf_fields_are_canonical_integral_strings(self):
        data = _typed_dbf(
            (("1.000000", "26", "29.000000"), ("", "27", "30")),
            (("CLASS", "N", 16, 6), ("LINE", "N", 8, 0), ("TAPE", "F", 16, 6)),
        )
        fields = _parse_dbf_required_fields(data)
        self.assertEqual(fields["CLASS"], ["1", ""])
        self.assertEqual(fields["LINE"], ["26", "27"])
        self.assertEqual(fields["TAPE"], ["29", "30"])

        fractional = _typed_dbf(
            (("1.500000", "26", "29"),),
            (("CLASS", "N", 16, 6), ("LINE", "N", 8, 0), ("TAPE", "N", 8, 0)),
        )
        with self.assertRaisesRegex(ValueError, "non-integral"):
            _parse_dbf_required_fields(fractional)

    def test_archive_inventory_is_exact_and_content_addressed(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "video.zip"
            spec = _archive(archive_path, "f208nc", (("1", "100", "74"),))
            members = _read_archive(archive_path, spec)
            self.assertEqual(set(members), {member["path"] for member in spec["members"]})

            bad_spec = json.loads(json.dumps(spec))
            bad_spec["members"][0]["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "member checksum"):
                _read_archive(archive_path, bad_spec)
            unsafe = json.loads(json.dumps(spec))
            unsafe["members"][0]["path"] = "../escape.shp"
            with self.assertRaisesRegex(ValueError, "unsafe"):
                _read_archive(archive_path, unsafe)

    def test_whole_group_gate_refuses_adjacent_row_split(self):
        labels = np.asarray([0] * 6 + [0] * 15 + [0] * 60 + [1] + [0] * 13 + [1] * 21 + [2] * 50)
        groups = np.asarray(
            ["f208:100:74"] * 6
            + ["f208:101:74"] * 15
            + ["f307:26:29"] * 61
            + ["f307:27:30"] * 84
        )
        result = _whole_group_partition_audit(labels, groups, min_rows_per_class=16)
        self.assertEqual(result["candidate_partition_count"], 7)
        self.assertEqual(result["eligible_partition_count"], 0)
        self.assertFalse(result["adjacent_row_split_allowed"])

        supported_labels = np.tile(np.arange(len(VIDEO_CLASS_NAMES)), 32)
        supported_groups = np.asarray(["a"] * 48 + ["b"] * 48)
        supported = _whole_group_partition_audit(
            supported_labels,
            supported_groups,
            min_rows_per_class=16,
            group_definition="whole cruise",
        )
        self.assertEqual(supported["eligible_partition_count"], 1)
        self.assertEqual(supported["group_definition"], "whole cruise")

    def test_end_to_end_audit_writes_no_training_decision(self):
        try:
            import rasterio
            from rasterio.transform import from_origin
        except ImportError:
            self.skipTest("rasterio is not installed")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bathymetry = root / "bathy.tif"
            with rasterio.open(
                bathymetry,
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
            layer_paths = {}
            backscatter_specs = []
            for survey in ("8101_2004", "8101_2007", "8101_2008", "7125_2006"):
                path = root / f"{survey}.tif"
                path.write_bytes(survey.encode("ascii"))
                name = f"backscatter_intensity_{survey}"
                layer_paths[name] = path
                backscatter_specs.append(
                    {"survey": survey, "geotiff_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                )
            first_archive = root / "f208.zip"
            second_archive = root / "f307.zip"
            first_spec = _archive(
                first_archive,
                "f208nc",
                (("1", "100", "74"), ("1", "100", "74"), ("2", "100", "74")),
            )
            second_spec = _archive(
                second_archive,
                "f307nc",
                (("1", "27", "30"), ("3", "27", "30"), ("4", "27", "30")),
            )
            manifest = {
                "access": {
                    "bathymetry_geotiff_sha256": hashlib.sha256(bathymetry.read_bytes()).hexdigest(),
                    "backscatter_assets": backscatter_specs,
                    "video_observation_assets": [first_spec, second_spec],
                }
            }
            channels = tuple(
                item
                for name in layer_paths
                for item in (name, f"{name}__available")
            )
            patches = np.ones((6, 3, len(channels), 33, 33), dtype=np.float32)
            with (
                patch(
                    "pipeline.contourcast.video_endpoint_audit.get_source_manifest",
                    return_value=manifest,
                ),
                patch(
                    "pipeline.contourcast.video_endpoint_audit._extract_hybrid_patches_at_coordinates",
                    return_value=(
                        patches,
                        np.arange(6),
                        channels,
                        {"patch_design": {"radii_m": [32, 128, 512], "output_size": 33}},
                    ),
                ),
            ):
                result = audit_usgs_sf_video_endpoint(
                    bathymetry,
                    layer_paths,
                    {"f208nc": first_archive, "f307nc": second_archive},
                    root / "output",
                    min_group_class_rows=1,
                )
            metrics = json.loads(result["metrics"].read_text(encoding="utf-8"))
            run = json.loads(result["run_metadata"].read_text(encoding="utf-8"))
            self.assertFalse(metrics["decision"]["video_probe_admissible"])
            self.assertFalse(metrics["decision"]["model_training_run"])
            self.assertEqual(run["dataset_kind"], "official_video_endpoint_admissibility_audit")
            self.assertIsNone(run["target_taxon_id"])

    def test_south_coast_audit_uses_label_blind_region_priority_and_whole_cruises(self):
        try:
            import rasterio
            from rasterio.transform import from_origin
        except ImportError:
            self.skipTest("rasterio is not installed")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bathymetry = root / "bathy.tif"
            with rasterio.open(
                bathymetry,
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
            layer = root / "layer.tif"
            layer.write_bytes(b"locked backscatter fixture")
            bathymetry_sha = _sha(bathymetry.read_bytes())
            layer_sha = _sha(layer.read_bytes())
            region_specs = {
                region: {
                    "bathymetry": {"geotiff_sha256": bathymetry_sha},
                    "backscatter_assets": [
                        {"survey": "fixture", "geotiff_sha256": layer_sha}
                    ],
                }
                for region in SOUTH_COAST_REGION_PRIORITY
            }
            archives = {}
            video_specs = []
            for cruise in ("s1c08sc", "sw109sc", "z107sc", "z206sc"):
                archive = root / f"{cruise}.zip"
                video_specs.append(
                    _archive(archive, cruise, (("1", "1", "1"), ("2", "1", "1"), ("4", "1", "1")))
                )
                archives[cruise] = archive
            manifest = {
                "access": {
                    "regions": region_specs,
                    "video_observation_assets": video_specs,
                }
            }
            channels = ("backscatter_intensity_fixture", "backscatter_intensity_fixture__available")
            patches = np.ones((12, 3, len(channels), 33, 33), dtype=np.float32)
            with (
                patch(
                    "pipeline.contourcast.video_endpoint_audit.get_source_manifest",
                    return_value=manifest,
                ),
                patch(
                    "pipeline.contourcast.video_endpoint_audit._extract_hybrid_patches_at_coordinates",
                    return_value=(
                        patches,
                        np.arange(12),
                        channels,
                        {"patch_design": {"radii_m": [32, 128, 512], "output_size": 33}},
                    ),
                ),
            ):
                result = audit_usgs_south_coast_video_endpoint(
                    {region: bathymetry for region in SOUTH_COAST_REGION_PRIORITY},
                    {
                        region: {"backscatter_intensity_fixture": layer}
                        for region in SOUTH_COAST_REGION_PRIORITY
                    },
                    archives,
                    root / "output",
                    min_group_class_rows=1,
                )
            metrics = json.loads(result["metrics"].read_text(encoding="utf-8"))
            self.assertTrue(metrics["decision"]["video_probe_admissible"])
            self.assertFalse(metrics["decision"]["model_training_run"])
            self.assertEqual(metrics["row_flow"]["retained_full_hybrid_patch_rows"], 12)
            self.assertEqual(metrics["row_flow"]["deduplicated_overlap_rows"], 36)
            self.assertEqual(
                metrics["regions"][SOUTH_COAST_REGION_PRIORITY[0]][
                    "assigned_rows_after_priority_dedup"
                ],
                12,
            )
            self.assertEqual(metrics["leakage_gate"]["eligible_partition_count"], 7)
            self.assertIn("exact cruise_id", metrics["leakage_gate"]["group_definition"])

    def test_residual_statewide_screen_stops_before_rasters_or_training(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archives = {}
            specs = []
            for cruise in RESIDUAL_STATEWIDE_VIDEO_CRUISES:
                archive = root / f"{cruise}.zip"
                specs.append(
                    _archive(
                        archive,
                        cruise,
                        (("1", "1", "1"), ("2", "1", "1"), ("4", "1", "1")),
                    )
                )
                archives[cruise] = archive
            manifest = {
                "access": {
                    "prior_audit_cruises": [
                        "f208nc",
                        "f307nc",
                        "s1c08sc",
                        "sw109sc",
                        "z107sc",
                        "z206sc",
                    ],
                    "video_observation_assets": specs,
                }
            }
            with patch(
                "pipeline.contourcast.video_endpoint_audit.get_source_manifest",
                return_value=manifest,
            ):
                result = audit_usgs_residual_statewide_video_support(
                    archives,
                    root / "output",
                    min_group_class_rows=1,
                )
            metrics = json.loads(result["metrics"].read_text(encoding="utf-8"))
            run = json.loads(result["run_metadata"].read_text(encoding="utf-8"))
            self.assertTrue(metrics["decision"]["raw_endpoint_support_admissible"])
            self.assertFalse(metrics["decision"]["raster_acquisition_authorized"])
            self.assertFalse(metrics["decision"]["model_training_run"])
            self.assertEqual(metrics["leakage_gate"]["candidate_partition_count"], 31)
            self.assertEqual(metrics["leakage_gate"]["eligible_partition_count"], 31)
            self.assertEqual(metrics["row_flow"]["official_records"], 18)
            self.assertEqual(run["dataset_kind"], "official_video_endpoint_admissibility_audit")
            self.assertFalse(run["metrics"]["model_training_run"])


if __name__ == "__main__":
    unittest.main()
