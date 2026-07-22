"""Fail-closed support audit for direct USGS DS182 sediment measurements.

The audit intentionally stops before raster pairing or model fitting. It asks
whether direct bulk-surficial Gravel/Sand/Mud measurements span the frozen
continuous-support anchors across separable whole source domains inside the
exact existing San Francisco hybrid reference-raster footprint.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import re
import struct
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Mapping, Sequence
from zipfile import BadZipFile, ZipFile

import numpy as np

from .metadata import (
    build_run_record,
    sha256_file,
    verify_run_record_integrity,
    write_json,
)
from .sources import assert_source_operation, get_source_manifest


SEDIMENT_ENDPOINT_SUPPORT_SCHEMA_VERSION = (
    "castingcompass.usgs-ds182-sediment-endpoint-support/1.0.0"
)
DS182_SOURCE_ID = "usgs_ds182_pacific_ext_sediment"
OUTCOME_HEADER = (
    "Latitude",
    "Longitude",
    "WaterDepth",
    "SampleTop",
    "SampleBase",
    "SiteName",
    "DataSetKey",
    "SiteKey",
    "SampleKey",
    "Sampler",
    "DataTypes",
    "Gravel",
    "Sand",
    "Mud",
    "Clay",
    "Grainsize",
    "Sorting",
    "SeabedCls",
    "ClsMshp",
    "FolkCode",
    "ShepardCode",
    "RockMshp",
    "WeedMshp",
    "Carbonate",
    "MunslCode",
    "OrgCarbon",
    "LgShearStr",
    "Porosity",
    "PWaveVel",
    "Roughness",
    "LgCrShSt",
    "SamplePhase",
)
SOURCE_HEADER = (
    "DataSetKey",
    "DataSet_{DataFile}",
    "DataOwner",
    "DataPerson",
    "DataSourceType",
    "LocationRegion",
    "SurveyDate",
    "ReportDate",
    "NavMethod",
    "SiteKey(Start)",
    "SampleKey(Start)",
    "SitesOutput",
    "SamplesOutput",
    "WestBounding",
    "EastBounding",
    "NorthBounding",
    "SouthBounding",
)
ANCHOR_NAMES = ("gravel_bearing", "mud_bearing", "sand_dominant")
IDENTIFIER_PATTERN = re.compile(r"^[1-9][0-9]*$")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read_exact_archive(
    archive_path: Path,
    specification: Mapping[str, Any],
) -> Mapping[str, bytes]:
    """Read only the exact content-addressed archive member inventory."""

    if archive_path.stat().st_size != specification.get("archive_bytes"):
        raise ValueError("DS182 archive byte count disagrees with the locked manifest")
    if sha256_file(archive_path) != specification.get("archive_sha256"):
        raise ValueError("DS182 archive checksum disagrees with the locked manifest")
    raw_members = specification.get("members")
    if not isinstance(raw_members, list) or not raw_members:
        raise ValueError("DS182 archive specification has no member inventory")
    expected: Dict[str, Mapping[str, Any]] = {}
    for member in raw_members:
        if not isinstance(member, Mapping) or set(member) != {"path", "bytes", "sha256"}:
            raise ValueError("DS182 archive member specification is malformed")
        name = str(member["path"])
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
            raise ValueError("DS182 archive specification contains an unsafe member path")
        if name in expected:
            raise ValueError("DS182 archive member specification is duplicated")
        expected[name] = member
    try:
        with ZipFile(archive_path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)) or set(names) != set(expected):
                raise ValueError("DS182 archive members disagree with the locked inventory")
            if any(info.is_dir() for info in infos):
                raise ValueError("DS182 archive contains an unexpected directory")
            result: Dict[str, bytes] = {}
            for info in infos:
                data = archive.read(info)
                member = expected[info.filename]
                if len(data) != member["bytes"]:
                    raise ValueError(f"DS182 member byte mismatch: {info.filename}")
                if _sha256_bytes(data) != member["sha256"]:
                    raise ValueError(f"DS182 member checksum mismatch: {info.filename}")
                result[info.filename] = data
            return result
    except BadZipFile as error:
        raise ValueError("DS182 outcome archive is not a valid ZIP file") from error


def _parse_exact_csv(
    data: bytes,
    *,
    expected_header: Sequence[str],
    label: str,
) -> list[dict[str, str]]:
    inspection = _inspect_exact_csv(
        data, expected_header=expected_header, label=label
    )
    if not inspection["valid"]:
        raise ValueError(f"{label} contains a malformed row width")
    text = data.decode("utf-8")
    rows = list(csv.reader(io.StringIO(text, newline=""), strict=True))
    return [dict(zip(expected_header, row)) for row in rows[1:]]


def _inspect_exact_csv(
    data: bytes,
    *,
    expected_header: Sequence[str],
    label: str,
) -> Mapping[str, Any]:
    """Inspect structural CSV validity without reading or aggregating outcomes."""

    if b"\0" in data:
        raise ValueError(f"{label} contains a NUL byte")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"{label} is not UTF-8") from error
    try:
        rows = list(csv.reader(io.StringIO(text, newline=""), strict=True))
    except csv.Error as error:
        raise ValueError(f"{label} is malformed CSV") from error
    if not rows or tuple(rows[0]) != tuple(expected_header):
        raise ValueError(f"{label} header disagrees with the frozen schema")
    width = len(expected_header)
    width_counts = Counter(len(row) for row in rows[1:])
    invalid_rows = sum(count for row_width, count in width_counts.items() if row_width != width)
    return {
        "valid": invalid_rows == 0,
        "header_width": width,
        "data_rows": len(rows) - 1,
        "row_width_counts": {
            str(row_width): count for row_width, count in sorted(width_counts.items())
        },
        "invalid_row_count": invalid_rows,
    }


def _dbf_record_count(data: bytes) -> int:
    if len(data) < 34 or data[0] != 0x03:
        raise ValueError("DS182 dBASE member is not dBASE III")
    record_count = struct.unpack_from("<I", data, 4)[0]
    header_length, record_length = struct.unpack_from("<2H", data, 8)
    if header_length < 33 or record_length < 2 or (header_length - 33) % 32:
        raise ValueError("DS182 dBASE header lengths are invalid")
    expected_length = header_length + record_count * record_length
    if len(data) not in {expected_length, expected_length + 1}:
        raise ValueError("DS182 dBASE length disagrees with its header")
    if len(data) == expected_length + 1 and data[-1] != 0x1A:
        raise ValueError("DS182 dBASE trailing byte is invalid")
    return record_count


def _point_shapefile_record_count(data: bytes) -> int:
    if len(data) < 100:
        raise ValueError("DS182 Point shapefile is truncated")
    if struct.unpack_from(">i", data, 0)[0] != 9994:
        raise ValueError("DS182 Point shapefile file code is invalid")
    if any(struct.unpack_from(">5i", data, 4)):
        raise ValueError("DS182 Point shapefile reserved header is invalid")
    if struct.unpack_from(">i", data, 24)[0] * 2 != len(data):
        raise ValueError("DS182 Point shapefile length is invalid")
    version, shape_type = struct.unpack_from("<2i", data, 28)
    if version != 1000 or shape_type != 1:
        raise ValueError("DS182 geometry must be an ESRI Point shapefile")
    offset = 100
    expected_record = 1
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("DS182 Point record header is truncated")
        record_number, content_words = struct.unpack_from(">2i", data, offset)
        offset += 8
        content_bytes = content_words * 2
        if record_number != expected_record or content_bytes != 20:
            raise ValueError("DS182 Point record sequence or size is invalid")
        if offset + content_bytes > len(data):
            raise ValueError("DS182 Point record is truncated")
        record_type, x, y = struct.unpack_from("<idd", data, offset)
        if record_type != 1 or not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("DS182 Point shapefile contains an invalid point")
        offset += content_bytes
        expected_record += 1
    return expected_record - 1


def _parse_source_table(
    data: bytes,
    specification: Mapping[str, Any],
) -> Mapping[str, Mapping[str, str]]:
    if len(data) != specification.get("bytes") or _sha256_bytes(data) != specification.get(
        "sha256"
    ):
        raise ValueError("DS182 source table disagrees with the locked manifest")
    rows = _parse_exact_csv(data, expected_header=SOURCE_HEADER, label="DS182 source table")
    if len(rows) != specification.get("record_count"):
        raise ValueError("DS182 source table row count disagrees with the locked manifest")
    result: Dict[str, Mapping[str, str]] = {}
    for row in rows:
        key = row["DataSetKey"]
        if IDENTIFIER_PATTERN.fullmatch(key) is None or key in result:
            raise ValueError("DS182 source table has an invalid or duplicate DataSetKey")
        result[key] = row
    return result


def _required_decimal(value: str, *, field: str, row_number: int) -> Decimal:
    if value == "":
        raise ValueError(f"DS182 row {row_number} has a blank required {field}")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f"DS182 row {row_number} has malformed {field}") from error
    if not result.is_finite():
        raise ValueError(f"DS182 row {row_number} has non-finite {field}")
    return result


def _optional_measurement(value: str, *, field: str, row_number: int) -> Decimal | None:
    if value in {"", "-99"}:
        return None
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f"DS182 row {row_number} has malformed {field}") from error
    if not result.is_finite():
        raise ValueError(f"DS182 row {row_number} has non-finite {field}")
    return result


def _verify_reference_raster(
    path: Path,
    specification: Mapping[str, Any],
) -> Mapping[str, Any]:
    if sha256_file(path) != specification.get("geotiff_sha256"):
        raise ValueError("reference-raster checksum disagrees with the locked manifest")
    try:
        import rasterio
    except ImportError as error:
        raise RuntimeError("DS182 endpoint support audit requires rasterio") from error
    with rasterio.open(path) as dataset:
        actual = {
            "crs": str(dataset.crs),
            "transform": [float(value) for value in tuple(dataset.transform)],
            "width": int(dataset.width),
            "height": int(dataset.height),
            "bounds": [float(value) for value in tuple(dataset.bounds)],
        }
    if actual["crs"] != specification.get("crs"):
        raise ValueError("reference-raster CRS disagrees with the locked manifest")
    if actual["width"] != specification.get("width") or actual["height"] != specification.get(
        "height"
    ):
        raise ValueError("reference-raster shape disagrees with the locked manifest")
    for field in ("transform", "bounds"):
        if not np.allclose(
            actual[field], specification.get(field), rtol=0.0, atol=1e-9
        ):
            raise ValueError(f"reference-raster {field} disagrees with the locked manifest")
    return actual


def _anchor_flags(gravel: Decimal, sand: Decimal, mud: Decimal) -> Mapping[str, bool]:
    return {
        "gravel_bearing": gravel >= Decimal("5"),
        "mud_bearing": mud >= Decimal("20"),
        "sand_dominant": sand >= Decimal("80"),
    }


def _support_summary(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    sites = {str(row["site_key"]) for row in rows}
    anchors = {}
    for name in ANCHOR_NAMES:
        matching = [row for row in rows if row["anchors"][name]]
        anchors[name] = {
            "rows": len(matching),
            "sites": len({str(row["site_key"]) for row in matching}),
        }
    return {"rows": len(rows), "sites": len(sites), "anchors": anchors}


def _whole_source_partition_audit(
    rows: Sequence[Mapping[str, Any]],
    *,
    min_rows: int,
    min_sites: int,
    min_anchor_rows: int,
    min_anchor_sites: int,
    min_train_sources: int,
) -> Mapping[str, Any]:
    groups = tuple(sorted({str(row["dataset_key"]) for row in rows}, key=int))
    by_group = {group: [row for row in rows if str(row["dataset_key"]) == group] for group in groups}
    group_summaries = {group: _support_summary(group_rows) for group, group_rows in by_group.items()}
    if len(groups) < 2:
        return {
            "group_definition": "whole DataSetKey",
            "row_random_split_allowed": False,
            "site_random_split_allowed": False,
            "unique_groups": list(groups),
            "candidate_partition_count": 0,
            "eligible_partition_count": 0,
            "eligible_partitions": [],
            "minimums": {
                "rows_per_side": min_rows,
                "sites_per_side": min_sites,
                "anchor_rows_per_side": min_anchor_rows,
                "anchor_sites_per_side": min_anchor_sites,
                "train_source_groups": min_train_sources,
            },
        }

    def combine(selected: Sequence[str]) -> Mapping[str, Any]:
        rows_total = sum(int(group_summaries[group]["rows"]) for group in selected)
        sites_total = sum(int(group_summaries[group]["sites"]) for group in selected)
        anchors = {
            name: {
                "rows": sum(
                    int(group_summaries[group]["anchors"][name]["rows"])
                    for group in selected
                ),
                "sites": sum(
                    int(group_summaries[group]["anchors"][name]["sites"])
                    for group in selected
                ),
            }
            for name in ANCHOR_NAMES
        }
        return {"rows": rows_total, "sites": sites_total, "anchors": anchors}

    eligible: list[Mapping[str, Any]] = []
    candidate_count = (1 << (len(groups) - 1)) - 1
    for mask in range(1, 1 << (len(groups) - 1)):
        test_groups = tuple(
            groups[index + 1]
            for index in range(len(groups) - 1)
            if mask & (1 << index)
        )
        test_set = set(test_groups)
        train_groups = tuple(group for group in groups if group not in test_set)
        train = combine(train_groups)
        test = combine(test_groups)
        admitted = (
            len(train_groups) >= min_train_sources
            and len(test_groups) >= 1
            and train["rows"] >= min_rows
            and test["rows"] >= min_rows
            and train["sites"] >= min_sites
            and test["sites"] >= min_sites
            and all(
                train["anchors"][name]["rows"] >= min_anchor_rows
                and test["anchors"][name]["rows"] >= min_anchor_rows
                and train["anchors"][name]["sites"] >= min_anchor_sites
                and test["anchors"][name]["sites"] >= min_anchor_sites
                for name in ANCHOR_NAMES
            )
        )
        if admitted:
            eligible.append(
                {
                    "train_groups": list(train_groups),
                    "test_groups": list(test_groups),
                    "train_support": train,
                    "test_support": test,
                }
            )
    return {
        "group_definition": "whole DataSetKey",
        "row_random_split_allowed": False,
        "site_random_split_allowed": False,
        "unique_groups": list(groups),
        "candidate_partition_count": candidate_count,
        "eligible_partition_count": len(eligible),
        "eligible_partitions": eligible,
        "minimums": {
            "rows_per_side": min_rows,
            "sites_per_side": min_sites,
            "anchor_rows_per_side": min_anchor_rows,
            "anchor_sites_per_side": min_anchor_sites,
            "train_source_groups": min_train_sources,
        },
    }


def audit_usgs_ds182_sediment_endpoint_support(
    archive_path: Path,
    source_table_path: Path,
    reference_raster_path: Path,
    output_dir: Path,
    *,
    source_id: str = DS182_SOURCE_ID,
    min_rows: int = 64,
    min_sites: int = 64,
    min_anchor_rows: int = 16,
    min_anchor_sites: int = 16,
    min_train_sources: int = 3,
    coordinate_tolerance_degrees: float = 0.00001,
) -> Mapping[str, Path]:
    """Run the frozen raw support screen and write a no-training decision."""

    assert_source_operation(source_id, "endpoint-support-audit")
    manifest = get_source_manifest(source_id)
    access = manifest.get("access")
    if not isinstance(access, Mapping):
        raise ValueError("DS182 source manifest has no access contract")
    outcome_spec = access.get("outcome_asset")
    source_spec = access.get("source_table")
    reference_spec = access.get("reference_raster")
    if not all(isinstance(item, Mapping) for item in (outcome_spec, source_spec, reference_spec)):
        raise ValueError("DS182 source manifest is incomplete")
    assert isinstance(outcome_spec, Mapping)
    assert isinstance(source_spec, Mapping)
    assert isinstance(reference_spec, Mapping)

    reference_source = get_source_manifest(str(reference_spec["source_id"]))
    reference_access = reference_source.get("access")
    if not isinstance(reference_access, Mapping) or reference_access.get(
        "bathymetry_geotiff_sha256"
    ) != reference_spec.get("geotiff_sha256"):
        raise ValueError("DS182 reference raster is not bound to the admitted source manifest")

    archive = _read_exact_archive(archive_path, outcome_spec)
    data_member = str(outcome_spec["data_member"])
    csv_structure = _inspect_exact_csv(
        archive[data_member],
        expected_header=OUTCOME_HEADER,
        label="DS182 EXT outcome table",
    )
    record_count = int(outcome_spec["record_count"])
    structural_counts = {
        "text_rows": csv_structure["data_rows"],
        "dbf_records": _dbf_record_count(archive["pac_ext.dbf"]),
        "shapefile_records": _point_shapefile_record_count(archive["pac_ext.shp"]),
    }
    if set(structural_counts.values()) != {record_count}:
        raise ValueError("DS182 text, dBASE, or Point record counts disagree")

    source_bytes = source_table_path.read_bytes()
    source_rows = _parse_source_table(source_bytes, source_spec)
    reference = _verify_reference_raster(reference_raster_path, reference_spec)
    if not csv_structure["valid"]:
        metrics = {
            "schema_version": SEDIMENT_ENDPOINT_SUPPORT_SCHEMA_VERSION,
            "source_id": source_id,
            "official_inputs": {
                "outcome_archive": {
                    "sha256": outcome_spec["archive_sha256"],
                    "bytes": outcome_spec["archive_bytes"],
                    "member_inventory_verified": True,
                    "data_member": data_member,
                },
                "source_table": {
                    "sha256": source_spec["sha256"],
                    "bytes": source_spec["bytes"],
                    "records": source_spec["record_count"],
                },
                "reference_raster": {
                    "sha256": reference_spec["geotiff_sha256"],
                    **reference,
                    "pixels_read": False,
                },
            },
            "source_schema": {
                "valid": False,
                "published_metadata_record_count": outcome_spec[
                    "published_metadata_record_count"
                ],
                "exact_archive_record_count": record_count,
                "published_count_matches_archive": outcome_spec[
                    "published_metadata_record_count"
                ]
                == record_count,
                "structural_record_counts": structural_counts,
                "field_name_canonicalization": {"DataTypes": "DataType"},
                "csv_structure": csv_structure,
                "failure": (
                    "The exact PAC_EXT.txt member contains rows whose field counts disagree "
                    "with its 32-field header. The frozen protocol forbids padding the omitted "
                    "trailing field, switching to the companion dBASE table, or aggregating "
                    "outcome values after this schema failure."
                ),
                "outcome_values_aggregated": False,
                "repair_or_imputation_performed": False,
            },
            "row_flow": {
                "official_records": record_count,
                "endpoint_valid_rows": "not_computed_after_schema_failure",
                "endpoint_valid_sites": "not_computed_after_schema_failure",
                "endpoint_valid_source_groups": "not_computed_after_schema_failure",
            },
            "partition_audit": {
                "performed": False,
                "eligible_partition_count": 0,
                "reason": "source_schema_invalid",
            },
            "decision": {
                "source_schema_valid": False,
                "raw_endpoint_support_admissible": False,
                "source_accuracy_review_authorized": False,
                "raster_alignment_authorized": False,
                "patch_corpus_built": False,
                "model_training_run": False,
                "encoder_promoted": False,
                "live_score_changed": False,
                "production_or_provider_state_changed": False,
            },
            "claim_boundary": (
                "This result establishes only that the frozen PAC_EXT.txt representation fails "
                "the preregistered exact-width schema. No composition values were aggregated, "
                "no support partition was evaluated, no raster pixels were read, and no patch, "
                "model, score, serving, provider, production, or deployment state changed."
            ),
        }
        output_dir.mkdir(parents=True, exist_ok=True)
        metrics_path = output_dir / "metrics.json"
        write_json(metrics_path, metrics)
        run = build_run_record(
            command="audit-usgs-ds182-sediment-endpoint-support",
            target_taxon_id=None,
            config={
                "source_id": source_id,
                "endpoint": ["Gravel", "Sand", "Mud"],
                "outcome_member": data_member,
                "required_csv_fields": len(OUTCOME_HEADER),
                "min_rows_per_side": min_rows,
                "min_sites_per_side": min_sites,
                "min_anchor_rows_per_side": min_anchor_rows,
                "min_anchor_sites_per_side": min_anchor_sites,
                "min_train_sources": min_train_sources,
                "coordinate_tolerance_degrees": coordinate_tolerance_degrees,
                "raster_pixels_read": False,
            },
            input_paths=(archive_path, source_table_path, reference_raster_path),
            dataset_kind="official_sediment_endpoint_support_audit",
            status="completed",
            metrics={
                "metrics_sha256": sha256_file(metrics_path),
                "source_schema_valid": False,
                "raw_endpoint_support_admissible": False,
                "invalid_csv_rows": csv_structure["invalid_row_count"],
                "eligible_whole_source_partitions": 0,
                "model_training_run": False,
            },
            notes=(
                "Fail-closed raw source-schema result. Outcome values were not aggregated, "
                "reference raster pixels were not read, no patch corpus or model was created, "
                "and no score, serving, provider, production, or deployment state changed."
            ),
        )
        verify_run_record_integrity(run, rehash_inputs=True)
        run_path = output_dir / "run-metadata.json"
        write_json(run_path, run)
        return {"metrics": metrics_path, "run_metadata": run_path}

    outcome_rows = _parse_exact_csv(
        archive[data_member], expected_header=OUTCOME_HEADER, label="DS182 EXT outcome table"
    )
    try:
        from rasterio.warp import transform as transform_coordinates
    except ImportError as error:
        raise RuntimeError("DS182 endpoint support audit requires rasterio") from error

    canonical_by_sample: Dict[str, Mapping[str, str]] = {}
    exact_duplicate_rows = 0
    for row_number, row in enumerate(outcome_rows, start=2):
        sample_key = row["SampleKey"]
        if IDENTIFIER_PATTERN.fullmatch(sample_key) is None:
            raise ValueError(f"DS182 row {row_number} has an invalid SampleKey")
        prior = canonical_by_sample.get(sample_key)
        if prior is None:
            canonical_by_sample[sample_key] = row
        elif prior == row:
            exact_duplicate_rows += 1
        else:
            raise ValueError(f"DS182 SampleKey {sample_key} has non-identical duplicate rows")

    canonical_rows = list(canonical_by_sample.values())
    latitudes: list[float] = []
    longitudes: list[float] = []
    for row_number, row in enumerate(canonical_rows, start=1):
        dataset_key, site_key = row["DataSetKey"], row["SiteKey"]
        if IDENTIFIER_PATTERN.fullmatch(dataset_key) is None or dataset_key not in source_rows:
            raise ValueError(f"DS182 canonical row {row_number} has an invalid DataSetKey")
        if IDENTIFIER_PATTERN.fullmatch(site_key) is None:
            raise ValueError(f"DS182 canonical row {row_number} has an invalid SiteKey")
        latitude = _required_decimal(row["Latitude"], field="Latitude", row_number=row_number)
        longitude = _required_decimal(row["Longitude"], field="Longitude", row_number=row_number)
        if not (Decimal("-90") <= latitude <= Decimal("90")) or not (
            Decimal("-180") <= longitude <= Decimal("180")
        ):
            raise ValueError(f"DS182 canonical row {row_number} has invalid coordinates")
        latitudes.append(float(latitude))
        longitudes.append(float(longitude))

    transformed_x, transformed_y = transform_coordinates(
        "EPSG:4326", reference["crs"], longitudes, latitudes
    )
    left, bottom, right, top = reference["bounds"]
    exclusions: Counter[str] = Counter()
    valid_rows: list[Mapping[str, Any]] = []
    site_identity: Dict[str, tuple[str, float, float]] = {}
    for index, row in enumerate(canonical_rows):
        dataset_key, site_key = row["DataSetKey"], row["SiteKey"]
        longitude, latitude = longitudes[index], latitudes[index]
        identity = site_identity.get(site_key)
        if identity is None:
            site_identity[site_key] = (dataset_key, longitude, latitude)
        elif identity[0] != dataset_key:
            raise ValueError(f"DS182 SiteKey {site_key} crosses DataSetKey groups")
        elif (
            abs(identity[1] - longitude) > coordinate_tolerance_degrees
            or abs(identity[2] - latitude) > coordinate_tolerance_degrees
        ):
            raise ValueError(f"DS182 SiteKey {site_key} has conflicting coordinates")

        reasons: set[str] = set()
        if not (
            left <= transformed_x[index] <= right
            and bottom <= transformed_y[index] <= top
        ):
            reasons.add("outside_reference_raster_footprint")
        if row["DataTypes"] not in {"GRZ", "TXR"}:
            reasons.add("unsupported_data_type")
        if row["SamplePhase"] != "":
            reasons.add("nonblank_sample_phase")

        sample_top = _optional_measurement(
            row["SampleTop"], field="SampleTop", row_number=index + 1
        )
        if sample_top is None:
            reasons.add("sample_top_unreported")
        elif not Decimal("0") <= sample_top <= Decimal("0.1"):
            reasons.add("sample_top_outside_0_to_0_1_m")

        composition = {
            field.lower(): _optional_measurement(
                row[field], field=field, row_number=index + 1
            )
            for field in ("Gravel", "Sand", "Mud")
        }
        if any(value is None for value in composition.values()):
            reasons.add("composition_unreported")
        else:
            measured = {name: value for name, value in composition.items() if value is not None}
            if any(not Decimal("0") <= value <= Decimal("100") for value in measured.values()):
                reasons.add("composition_outside_0_to_100")
            total = sum(measured.values(), Decimal("0"))
            if not Decimal("98") <= total <= Decimal("102"):
                reasons.add("composition_sum_outside_98_to_102")

        for reason in reasons:
            exclusions[reason] += 1
        if reasons:
            continue
        gravel = composition["gravel"]
        sand = composition["sand"]
        mud = composition["mud"]
        assert gravel is not None and sand is not None and mud is not None
        valid_rows.append(
            {
                "dataset_key": dataset_key,
                "site_key": site_key,
                "sample_key": row["SampleKey"],
                "longitude": longitude,
                "latitude": latitude,
                "gravel": float(gravel),
                "sand": float(sand),
                "mud": float(mud),
                "anchors": _anchor_flags(gravel, sand, mud),
            }
        )

    support_by_source = {
        group: {
            "source_name": source_rows[group]["DataSet_{DataFile}"],
            "navigation_method": source_rows[group]["NavMethod"],
            **_support_summary(
                [row for row in valid_rows if str(row["dataset_key"]) == group]
            ),
        }
        for group in sorted({str(row["dataset_key"]) for row in valid_rows}, key=int)
    }
    partition_audit = _whole_source_partition_audit(
        valid_rows,
        min_rows=min_rows,
        min_sites=min_sites,
        min_anchor_rows=min_anchor_rows,
        min_anchor_sites=min_anchor_sites,
        min_train_sources=min_train_sources,
    )
    admissible = partition_audit["eligible_partition_count"] > 0
    metrics = {
        "schema_version": SEDIMENT_ENDPOINT_SUPPORT_SCHEMA_VERSION,
        "source_id": source_id,
        "official_inputs": {
            "outcome_archive": {
                "sha256": outcome_spec["archive_sha256"],
                "bytes": outcome_spec["archive_bytes"],
                "member_inventory_verified": True,
                "data_member": data_member,
            },
            "source_table": {
                "sha256": source_spec["sha256"],
                "bytes": source_spec["bytes"],
                "records": source_spec["record_count"],
            },
            "reference_raster": {
                "sha256": reference_spec["geotiff_sha256"],
                **reference,
                "pixels_read": False,
            },
        },
        "source_schema": {
            "valid": True,
            "published_metadata_record_count": outcome_spec[
                "published_metadata_record_count"
            ],
            "exact_archive_record_count": record_count,
            "published_count_matches_archive": outcome_spec[
                "published_metadata_record_count"
            ]
            == record_count,
            "structural_record_counts": structural_counts,
            "field_name_canonicalization": {"DataTypes": "DataType"},
            "repair_or_imputation_performed": False,
        },
        "row_flow": {
            "official_records": record_count,
            "exact_duplicate_rows_removed": exact_duplicate_rows,
            "distinct_sample_keys": len(canonical_rows),
            "endpoint_valid_rows": len(valid_rows),
            "endpoint_valid_sites": len({str(row["site_key"]) for row in valid_rows}),
            "endpoint_valid_source_groups": len(support_by_source),
        },
        "exclusion_counts_nonexclusive": dict(sorted(exclusions.items())),
        "overall_support": _support_summary(valid_rows),
        "support_by_source": support_by_source,
        "partition_audit": partition_audit,
        "decision": {
            "source_schema_valid": True,
            "raw_endpoint_support_admissible": admissible,
            "source_accuracy_review_authorized": admissible,
            "raster_alignment_authorized": False,
            "patch_corpus_built": False,
            "model_training_run": False,
            "encoder_promoted": False,
            "live_score_changed": False,
            "production_or_provider_state_changed": False,
        },
        "claim_boundary": (
            "This raw audit can establish only whether historical direct bulk-surficial "
            "sediment percentages span the preregistered anchors across whole source groups "
            "inside the reference bounds. It does not admit source accuracy, read raster pixels, "
            "build patches, train or validate a model, establish current habitat or fish presence, "
            "measure fishing skill, calibrate the live score, or authorize deployment."
        ),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "metrics.json"
    write_json(metrics_path, metrics)
    run = build_run_record(
        command="audit-usgs-ds182-sediment-endpoint-support",
        target_taxon_id=None,
        config={
            "source_id": source_id,
            "endpoint": ["Gravel", "Sand", "Mud"],
            "accepted_data_types": ["GRZ", "TXR"],
            "sample_top_m": [0.0, 0.1],
            "composition_sum_percent": [98.0, 102.0],
            "anchors": {
                "gravel_bearing_min_percent": 5.0,
                "mud_bearing_min_percent": 20.0,
                "sand_dominant_min_percent": 80.0,
            },
            "min_rows_per_side": min_rows,
            "min_sites_per_side": min_sites,
            "min_anchor_rows_per_side": min_anchor_rows,
            "min_anchor_sites_per_side": min_anchor_sites,
            "min_train_sources": min_train_sources,
            "coordinate_tolerance_degrees": coordinate_tolerance_degrees,
            "raster_pixels_read": False,
        },
        input_paths=(archive_path, source_table_path, reference_raster_path),
        dataset_kind="official_sediment_endpoint_support_audit",
        status="completed",
        metrics={
            "metrics_sha256": sha256_file(metrics_path),
            "source_schema_valid": True,
            "raw_endpoint_support_admissible": admissible,
            "endpoint_valid_rows": len(valid_rows),
            "eligible_whole_source_partitions": partition_audit[
                "eligible_partition_count"
            ],
            "model_training_run": False,
        },
        notes=(
            "Raw historical sediment endpoint support audit only. No raster pixels were read, no "
            "patch corpus or model was created, and no score, serving, provider, production, or "
            "deployment state changed."
        ),
    )
    verify_run_record_integrity(run, rehash_inputs=True)
    run_path = output_dir / "run-metadata.json"
    write_json(run_path, run)
    return {"metrics": metrics_path, "run_metadata": run_path}
