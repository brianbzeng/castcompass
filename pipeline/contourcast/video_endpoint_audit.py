"""Fail-closed admissibility audit for official USGS video observations.

The audit intentionally stops before fitting a model.  It asks whether direct
camera observations can support a whole-track-group train/test comparison of
the frozen hybrid inputs without splitting adjacent one-minute observations
across the boundary.
"""

from __future__ import annotations

import hashlib
import math
import struct
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Mapping, Sequence, Tuple
from zipfile import BadZipFile, ZipFile

import numpy as np

from .metadata import (
    build_run_record,
    sha256_file,
    verify_run_record_integrity,
    write_json,
)
from .rare_structure_probe import _extract_hybrid_patches_at_coordinates
from .sources import SOURCE_DIR, get_source_manifest


VIDEO_ENDPOINT_AUDIT_SCHEMA_VERSION = (
    "castingcompass.usgs-video-endpoint-admissibility-audit/1.0.0"
)
VIDEO_SUPPORT_SCREEN_SCHEMA_VERSION = "castingcompass.usgs-video-support-screen/1.0.0"
VIDEO_CLASS_NAMES: Tuple[str, ...] = (
    "smooth_fine_medium_sediment",
    "mixed_or_rugose_rock",
    "mobile_coarse_sediment",
)
VIDEO_CLASS_COLLAPSE = {"1": 0, "2": 1, "3": 1, "4": 2}
SOUTH_COAST_REGION_PRIORITY: Tuple[str, ...] = (
    "offshore_refugio_beach",
    "offshore_coal_oil_point",
    "offshore_santa_barbara",
    "offshore_carpinteria",
)
RESIDUAL_STATEWIDE_VIDEO_CRUISES: Tuple[str, ...] = (
    "c0111sc",
    "c109nc",
    "c210nc",
    "c0212sc",
    "l908nc",
    "s2210mb",
)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read_archive(
    archive_path: Path,
    specification: Mapping[str, Any],
) -> Mapping[str, bytes]:
    """Read only an exact, content-addressed archive member inventory."""

    expected_archive_hash = specification.get("archive_sha256")
    if sha256_file(archive_path) != expected_archive_hash:
        raise ValueError(f"video archive checksum mismatch: {archive_path}")
    raw_members = specification.get("members")
    if not isinstance(raw_members, list) or not raw_members:
        raise ValueError("video archive specification has no member inventory")
    expected = {
        str(member["path"]): str(member["sha256"])
        for member in raw_members
        if isinstance(member, Mapping)
        and set(member) == {"path", "sha256", "bytes"}
    }
    if len(expected) != len(raw_members):
        raise ValueError("video archive member specification is malformed or duplicated")
    for name in expected:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
            raise ValueError("video archive specification contains an unsafe member path")
    try:
        with ZipFile(archive_path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)) or set(names) != set(expected):
                raise ValueError("video archive members disagree with the locked inventory")
            if any(info.is_dir() for info in infos):
                raise ValueError("video archive contains an unexpected directory")
            result: Dict[str, bytes] = {}
            specs = {str(member["path"]): member for member in raw_members}
            for info in infos:
                data = archive.read(info)
                member_spec = specs[info.filename]
                if len(data) != member_spec["bytes"]:
                    raise ValueError(f"video archive member size mismatch: {info.filename}")
                if _sha256_bytes(data) != member_spec["sha256"]:
                    raise ValueError(f"video archive member checksum mismatch: {info.filename}")
                result[info.filename] = data
            return result
    except BadZipFile as error:
        raise ValueError(f"video archive is not a valid ZIP file: {archive_path}") from error


def _parse_point_shapefile(data: bytes) -> np.ndarray:
    """Parse an exact ESRI Point shapefile without an ambient GIS dependency."""

    if len(data) < 100:
        raise ValueError("point shapefile is truncated")
    file_code = struct.unpack_from(">i", data, 0)[0]
    unused = struct.unpack_from(">5i", data, 4)
    declared_bytes = struct.unpack_from(">i", data, 24)[0] * 2
    version, shape_type = struct.unpack_from("<2i", data, 28)
    if file_code != 9994 or any(unused) or declared_bytes != len(data):
        raise ValueError("point shapefile header is invalid")
    if version != 1000 or shape_type != 1:
        raise ValueError("video geometry must be an ESRI Point shapefile")
    bounds = struct.unpack_from("<4d", data, 36)
    offset = 100
    points: list[tuple[float, float]] = []
    expected_record = 1
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("point shapefile record header is truncated")
        record_number, content_words = struct.unpack_from(">2i", data, offset)
        offset += 8
        content_bytes = content_words * 2
        if record_number != expected_record or content_bytes != 20:
            raise ValueError("point shapefile record sequence or size is invalid")
        if offset + content_bytes > len(data):
            raise ValueError("point shapefile record is truncated")
        record_type, x, y = struct.unpack_from("<idd", data, offset)
        offset += content_bytes
        if record_type != 1 or not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("video shapefile contains an invalid point")
        if not (-180 <= x <= 180 and -90 <= y <= 90):
            raise ValueError("video point is outside longitude/latitude bounds")
        points.append((x, y))
        expected_record += 1
    if not points:
        raise ValueError("video shapefile contains no points")
    array = np.asarray(points, dtype=np.float64)
    xmin, ymin, xmax, ymax = bounds
    if (
        not np.isclose(np.min(array[:, 0]), xmin)
        or not np.isclose(np.max(array[:, 0]), xmax)
        or not np.isclose(np.min(array[:, 1]), ymin)
        or not np.isclose(np.max(array[:, 1]), ymax)
    ):
        raise ValueError("point shapefile bounds do not match its records")
    return array


def _parse_dbf_required_fields(
    data: bytes,
    *,
    required_fields: Sequence[str] = ("CLASS", "LINE", "TAPE"),
) -> Mapping[str, list[str]]:
    """Parse required character or integral numeric fields from strict dBASE III."""

    normalized_required = tuple(name.upper() for name in required_fields)
    if (
        any(not name or not name.isascii() for name in normalized_required)
        or len(set(normalized_required)) != len(normalized_required)
    ):
        raise ValueError("required video DBF field names are invalid or duplicated")

    if len(data) < 34 or data[0] != 0x03:
        raise ValueError("video DBF must be a dBASE III table")
    record_count = struct.unpack_from("<I", data, 4)[0]
    header_length, record_length = struct.unpack_from("<2H", data, 8)
    if header_length < 33 or record_length < 2 or (header_length - 33) % 32:
        raise ValueError("video DBF header lengths are invalid")
    expected_length = header_length + record_count * record_length
    if len(data) not in {expected_length, expected_length + 1}:
        raise ValueError("video DBF length disagrees with its header")
    if len(data) == expected_length + 1 and data[-1] != 0x1A:
        raise ValueError("video DBF has an invalid trailing byte")
    if data[header_length - 1] != 0x0D:
        raise ValueError("video DBF field descriptor terminator is absent")

    fields: list[tuple[str, str, int, int]] = []
    names: set[str] = set()
    field_offset = 1
    for offset in range(32, header_length - 1, 32):
        descriptor = data[offset : offset + 32]
        raw_name = descriptor[:11].split(b"\0", 1)[0]
        try:
            name = raw_name.decode("ascii").upper()
            field_type = chr(descriptor[11])
        except (UnicodeDecodeError, ValueError) as error:
            raise ValueError("video DBF field descriptor is not ASCII") from error
        length = int(descriptor[16])
        if not name or name in names or field_type not in {"C", "D", "F", "N"} or length < 1:
            raise ValueError("video DBF field descriptor is invalid")
        fields.append((name, field_type, field_offset, length))
        names.add(name)
        field_offset += length
    if field_offset != record_length:
        raise ValueError("video DBF fields do not fill the declared record length")
    missing = set(normalized_required) - names
    if missing:
        raise ValueError(f"video DBF lacks required fields: {sorted(missing)}")
    by_name = {name: (field_type, offset, length) for name, field_type, offset, length in fields}
    for name in normalized_required:
        if by_name[name][0] not in {"C", "F", "N"}:
            raise ValueError(
                f"video DBF field {name!r} must be character or numeric data"
            )

    values = {name: [] for name in normalized_required}
    for index in range(record_count):
        start = header_length + index * record_length
        record = data[start : start + record_length]
        if record[0] != 0x20:
            raise ValueError("video DBF contains a deleted or invalid record")
        for name in normalized_required:
            field_type, field_start, length = by_name[name]
            try:
                value = record[field_start : field_start + length].decode("cp1252").strip()
            except UnicodeDecodeError as error:
                raise ValueError(f"video DBF field {name!r} is not decodable") from error
            if field_type in {"F", "N"} and value:
                try:
                    numeric = Decimal(value)
                except InvalidOperation as error:
                    raise ValueError(
                        f"video DBF field {name!r} contains malformed numeric data"
                    ) from error
                if not numeric.is_finite() or numeric != numeric.to_integral_value():
                    raise ValueError(
                        f"video DBF field {name!r} contains non-integral numeric data"
                    )
                value = str(int(numeric))
            values[name].append(value)
    return values


def _whole_group_partition_audit(
    labels: np.ndarray,
    groups: np.ndarray,
    *,
    min_rows_per_class: int,
    group_definition: str = "exact cruise_id + LINE + TAPE",
) -> Mapping[str, Any]:
    """Enumerate every unique whole-group bipartition, once."""

    if labels.ndim != 1 or groups.ndim != 1 or len(labels) != len(groups):
        raise ValueError("partition labels and groups are inconsistent")
    unique_groups = tuple(sorted({str(group) for group in groups}))
    if len(unique_groups) < 2 or min_rows_per_class < 1:
        raise ValueError("partition audit needs multiple groups and a positive support gate")
    partitions = []
    eligible = 0
    # Fix the first group in train, then enumerate every nonempty test subset.
    for mask in range(1, 1 << (len(unique_groups) - 1)):
        test_groups = {
            unique_groups[index + 1]
            for index in range(len(unique_groups) - 1)
            if mask & (1 << index)
        }
        test = np.asarray([str(group) in test_groups for group in groups], dtype=bool)
        train_counts = np.bincount(labels[~test], minlength=len(VIDEO_CLASS_NAMES))
        test_counts = np.bincount(labels[test], minlength=len(VIDEO_CLASS_NAMES))
        admitted = bool(
            np.all(train_counts >= min_rows_per_class)
            and np.all(test_counts >= min_rows_per_class)
        )
        eligible += int(admitted)
        partitions.append(
            {
                "train_groups": [group for group in unique_groups if group not in test_groups],
                "test_groups": sorted(test_groups),
                "train_class_counts": {
                    name: int(count) for name, count in zip(VIDEO_CLASS_NAMES, train_counts)
                },
                "test_class_counts": {
                    name: int(count) for name, count in zip(VIDEO_CLASS_NAMES, test_counts)
                },
                "eligible": admitted,
            }
        )
    return {
        "group_definition": group_definition,
        "adjacent_row_split_allowed": False,
        "minimum_rows_per_class_in_train_and_test": min_rows_per_class,
        "unique_groups": list(unique_groups),
        "candidate_partition_count": len(partitions),
        "eligible_partition_count": eligible,
        "partitions": partitions,
    }


def audit_usgs_sf_video_endpoint(
    bathymetry_path: Path,
    aligned_layer_paths: Mapping[str, Path],
    video_archive_paths: Mapping[str, Path],
    output_dir: Path,
    *,
    source_id: str = "usgs_sf_state_waters_2m",
    vertical_datum: str = "NAVD88",
    radii_m: Sequence[float] = (32.0, 128.0, 512.0),
    output_size: int = 33,
    min_valid_fraction: float = 0.8,
    min_aligned_valid_fraction: float = 0.5,
    local_radius: int = 4,
    broad_radius: int = 24,
    relief_radius: int = 8,
    horizontal_accuracy_m: float = 2.0,
    tile_size: int = 1024,
    min_group_class_rows: int = 16,
) -> Mapping[str, Path]:
    """Audit direct video labels and write a deterministic no-training decision."""

    manifest = get_source_manifest(source_id)
    access = manifest.get("access")
    if not isinstance(access, Mapping):
        raise ValueError("USGS source manifest has no access contract")
    specs = access.get("video_observation_assets")
    if not isinstance(specs, list) or not specs:
        raise ValueError("USGS source manifest has no video observation inventory")
    expected_cruises = [str(spec["cruise_id"]) for spec in specs]
    if set(video_archive_paths) != set(expected_cruises):
        raise ValueError("video archive arguments disagree with the locked cruise inventory")

    if sha256_file(bathymetry_path) != access.get("bathymetry_geotiff_sha256"):
        raise ValueError("bathymetry checksum disagrees with the source manifest")
    backscatter_specs = access.get("backscatter_assets")
    if not isinstance(backscatter_specs, list):
        raise ValueError("USGS source manifest has no backscatter inventory")
    layer_specs = {
        f"backscatter_intensity_{item['survey']}": item
        for item in backscatter_specs
        if isinstance(item, Mapping)
    }
    if set(aligned_layer_paths) != set(layer_specs):
        raise ValueError("aligned layers disagree with the locked backscatter inventory")
    ordered_layers = {name: aligned_layer_paths[name] for name in layer_specs}
    for name, path in ordered_layers.items():
        if sha256_file(path) != layer_specs[name].get("geotiff_sha256"):
            raise ValueError(f"aligned layer checksum mismatch: {name}")

    raw_rows: list[dict[str, Any]] = []
    asset_summaries: Dict[str, Any] = {}
    for spec in specs:
        if not isinstance(spec, Mapping):
            raise ValueError("video observation specification must be an object")
        cruise_id = str(spec["cruise_id"])
        members = _read_archive(video_archive_paths[cruise_id], spec)
        stem = str(spec["dataset_stem"])
        points = _parse_point_shapefile(members[f"{stem}.shp"])
        fields = _parse_dbf_required_fields(members[f"{stem}.dbf"])
        if len(points) != len(fields["CLASS"]) or len(points) != spec.get("record_count"):
            raise ValueError(f"video geometry/table count mismatch for {cruise_id}")
        nonblank = {value for value in fields["CLASS"] if value}
        if not nonblank.issubset(VIDEO_CLASS_COLLAPSE):
            raise ValueError(f"video archive {cruise_id} has an unknown CLASS value")
        raw_class_counts = Counter(value for value in fields["CLASS"] if value)
        for index, raw_class in enumerate(fields["CLASS"]):
            if not raw_class:
                continue
            line, tape = fields["LINE"][index], fields["TAPE"][index]
            raw_rows.append(
                {
                    "cruise_id": cruise_id,
                    "line": line,
                    "tape": tape,
                    "longitude": float(points[index, 0]),
                    "latitude": float(points[index, 1]),
                    "raw_class": raw_class,
                    "class_index": VIDEO_CLASS_COLLAPSE[raw_class],
                }
            )
        asset_summaries[cruise_id] = {
            "record_count": len(points),
            "published_metadata_record_count": spec.get(
                "published_metadata_record_count", spec["record_count"]
            ),
            "published_metadata_count_matches_archive": (
                spec.get("published_metadata_record_count", spec["record_count"])
                == len(points)
            ),
            "labeled_record_count": int(sum(raw_class_counts.values())),
            "raw_class_counts": dict(sorted(raw_class_counts.items())),
            "archive_sha256": spec["archive_sha256"],
            "member_inventory_verified": True,
        }
    if len(raw_rows) < 2:
        raise ValueError("video inventory has too few labeled observations")

    try:
        import rasterio
        from rasterio.warp import transform as transform_coordinates
    except ImportError as error:
        raise RuntimeError("video endpoint audit requires rasterio") from error
    with rasterio.open(bathymetry_path) as dataset:
        if not dataset.crs:
            raise ValueError("bathymetry has no CRS")
        transformed_x, transformed_y = transform_coordinates(
            "EPSG:4326",
            dataset.crs,
            [row["longitude"] for row in raw_rows],
            [row["latitude"] for row in raw_rows],
        )
        bounds = dataset.bounds
        bathymetry_nodata = dataset.nodata
        center_values = np.asarray(
            [value[0] for value in dataset.sample(zip(transformed_x, transformed_y))],
            dtype=float,
        )
    inside = np.asarray(
        [
            bounds.left <= x <= bounds.right and bounds.bottom <= y <= bounds.top
            for x, y in zip(transformed_x, transformed_y)
        ],
        dtype=bool,
    )
    center_valid = inside & np.isfinite(center_values)
    if bathymetry_nodata is not None and np.isfinite(bathymetry_nodata):
        center_valid &= ~np.isclose(center_values, bathymetry_nodata)
    candidate_indices = np.flatnonzero(center_valid)
    if len(candidate_indices) < 2:
        raise ValueError("fewer than two labeled video points overlap bathymetry coverage")
    candidate_x = np.asarray(transformed_x, dtype=float)[candidate_indices]
    candidate_y = np.asarray(transformed_y, dtype=float)[candidate_indices]

    patches, retained_relative, channel_names, patch_metadata = (
        _extract_hybrid_patches_at_coordinates(
            bathymetry_path,
            candidate_x,
            candidate_y,
            source_id=source_id,
            vertical_datum=vertical_datum,
            aligned_layer_paths=ordered_layers,
            radii_m=radii_m,
            output_size=output_size,
            min_valid_fraction=min_valid_fraction,
            min_aligned_valid_fraction=min_aligned_valid_fraction,
            local_radius=local_radius,
            broad_radius=broad_radius,
            relief_radius=relief_radius,
            horizontal_accuracy_m=horizontal_accuracy_m,
            tile_size=tile_size,
        )
    )
    retained_raw_indices = candidate_indices[retained_relative]
    retained_rows = [raw_rows[int(index)] for index in retained_raw_indices]
    if any(not row["line"] or not row["tape"] for row in retained_rows):
        raise ValueError("retained video observations need nonempty LINE and TAPE")
    labels = np.asarray([row["class_index"] for row in retained_rows], dtype=np.int64)
    groups = np.asarray(
        [f"{row['cruise_id']}:{row['line']}:{row['tape']}" for row in retained_rows],
        dtype=str,
    )
    class_counts = np.bincount(labels, minlength=len(VIDEO_CLASS_NAMES))
    partition_audit = _whole_group_partition_audit(
        labels,
        groups,
        min_rows_per_class=min_group_class_rows,
    )

    center = output_size // 2
    availability_indices = [
        index for index, name in enumerate(channel_names) if name.endswith("__available")
    ]
    if len(availability_indices) != len(ordered_layers):
        raise ValueError("hybrid patch channels lack the locked availability masks")
    center_availability = patches[:, 0, availability_indices, center, center]
    source_patterns = Counter(
        "".join("1" if value >= 0.5 else "0" for value in row)
        for row in center_availability
    )
    group_counts: Dict[str, Mapping[str, int]] = {}
    for group in sorted(set(groups)):
        mask = groups == group
        counts = np.bincount(labels[mask], minlength=len(VIDEO_CLASS_NAMES))
        group_counts[group] = {
            name: int(count) for name, count in zip(VIDEO_CLASS_NAMES, counts)
        }
    for cruise_id in expected_cruises:
        raw_cruise = np.asarray([row["cruise_id"] == cruise_id for row in raw_rows])
        retained_cruise = sum(row["cruise_id"] == cruise_id for row in retained_rows)
        asset_summaries[cruise_id]["labeled_in_bathymetry_bounds"] = int(
            np.sum(inside & raw_cruise)
        )
        asset_summaries[cruise_id]["labeled_at_valid_bathymetry_centers"] = int(
            np.sum(center_valid & raw_cruise)
        )
        asset_summaries[cruise_id]["retained_hybrid_patch_rows"] = retained_cruise

    admissible = partition_audit["eligible_partition_count"] > 0
    metrics = {
        "schema_version": VIDEO_ENDPOINT_AUDIT_SCHEMA_VERSION,
        "source_id": source_id,
        "source_manifest_sha256": sha256_file(SOURCE_DIR / "usgs_sf_state_waters.json"),
        "endpoint": {
            "measurement": "direct scientist-recorded camera-video seafloor class",
            "observation_interval": "one 10-second observation per minute",
            "horizontal_positional_accuracy": "highly variable, on the order of 10 meters",
            "selection_design": "targeted sonar-interpretation validation tracks; not uniform",
            "class_collapse": {
                "1": VIDEO_CLASS_NAMES[0],
                "2": VIDEO_CLASS_NAMES[1],
                "3": VIDEO_CLASS_NAMES[1],
                "4": VIDEO_CLASS_NAMES[2],
            },
        },
        "assets": asset_summaries,
        "row_flow": {
            "labeled_official_rows": len(raw_rows),
            "labeled_rows_in_bathymetry_bounds": int(np.sum(inside)),
            "labeled_rows_at_valid_bathymetry_centers": int(len(candidate_indices)),
            "retained_full_hybrid_patch_rows": len(retained_rows),
        },
        "retained_class_counts": {
            name: int(count) for name, count in zip(VIDEO_CLASS_NAMES, class_counts)
        },
        "retained_group_class_counts": group_counts,
        "center_backscatter_availability_patterns": dict(sorted(source_patterns.items())),
        "patch_contract": {
            "channel_names": list(channel_names),
            **patch_metadata["patch_design"],
        },
        "leakage_gate": partition_audit,
        "lineage_boundary": {
            "video_endpoint_measurement_independent_of_sonar_interpretation": True,
            "video_track_selection_independent_of_sonar_interpretation": False,
            "published_habitat_polygons_accepted_as_independent_endpoint": False,
            "habitat_rejection_reason": (
                "Official metadata says bathymetry, backscatter, and hillshade were the "
                "primary interpretation sources; video and samples were supporting data."
            ),
        },
        "decision": {
            "video_probe_admissible": admissible,
            "model_training_run": False,
            "encoder_promoted": False,
            "serving_or_score_changed": False,
            "reason": (
                "No whole cruise/LINE/TAPE partition leaves at least "
                f"{min_group_class_rows} rows of every collapsed class in both train and test; "
                "row-level splitting would leak adjacent one-minute track observations."
                if not admissible
                else "At least one whole-group partition passes the frozen support gate; this "
                "audit still does not authorize training without a separately reviewed protocol."
            ),
        },
        "claim_boundary": (
            "This audit measures endpoint support and leakage risk for historical USGS visual "
            "seafloor classes only. It does not validate habitat currency, fish presence, catch "
            "skill, probability calibration, the Opportunity Score, model promotion, or deployment."
        ),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "usgs_video_endpoint_audit_metrics.json"
    write_json(metrics_path, metrics)

    config = {
        "source_id": source_id,
        "vertical_datum": vertical_datum,
        "radii_m": list(map(float, radii_m)),
        "output_size": output_size,
        "min_valid_fraction": min_valid_fraction,
        "min_aligned_valid_fraction": min_aligned_valid_fraction,
        "local_radius": local_radius,
        "broad_radius": broad_radius,
        "relief_radius": relief_radius,
        "horizontal_accuracy_m": horizontal_accuracy_m,
        "tile_size": tile_size,
        "min_group_class_rows": min_group_class_rows,
        "group_definition": "exact cruise_id + LINE + TAPE",
    }
    input_paths = [bathymetry_path, *ordered_layers.values()]
    input_paths.extend(video_archive_paths[cruise] for cruise in expected_cruises)
    run_record = build_run_record(
        command="audit-usgs-sf-video-endpoint",
        target_taxon_id=None,
        config=config,
        input_paths=input_paths,
        dataset_kind="official_video_endpoint_admissibility_audit",
        status="completed",
        metrics={
            "audit_metrics_sha256": sha256_file(metrics_path),
            "video_probe_admissible": admissible,
            "model_training_run": False,
            "retained_rows": len(retained_rows),
            "eligible_group_partitions": partition_audit["eligible_partition_count"],
        },
        notes=(
            "Direct video observations were audited under a whole-track-group support gate. "
            "No model was fit and no serving artifact was changed."
        ),
    )
    verify_run_record_integrity(
        run_record,
        rehash_inputs=True,
        artifact_paths={"audit_metrics_sha256": metrics_path},
    )
    run_metadata_path = output_dir / "usgs_video_endpoint_audit_run_metadata.json"
    write_json(run_metadata_path, run_record)
    return {"metrics": metrics_path, "run_metadata": run_metadata_path}


def audit_usgs_south_coast_video_endpoint(
    region_bathymetry_paths: Mapping[str, Path],
    region_aligned_layer_paths: Mapping[str, Mapping[str, Path]],
    video_archive_paths: Mapping[str, Path],
    output_dir: Path,
    *,
    source_id: str = "usgs_santa_barbara_south_coast_2m",
    vertical_datum: str = "NAVD88",
    radii_m: Sequence[float] = (32.0, 128.0, 512.0),
    output_size: int = 33,
    min_valid_fraction: float = 0.8,
    min_aligned_valid_fraction: float = 0.5,
    local_radius: int = 4,
    broad_radius: int = 24,
    relief_radius: int = 8,
    horizontal_accuracy_m: float = 2.0,
    tile_size: int = 1024,
    min_group_class_rows: int = 16,
) -> Mapping[str, Path]:
    """Audit South Coast visual labels under a frozen whole-cruise gate.

    The function deliberately does not fit, select, or promote a model.  Map
    overlaps are resolved by ``SOUTH_COAST_REGION_PRIORITY`` before labels are
    counted, so the assignment rule cannot adapt to the observed class mix.
    """

    manifest = get_source_manifest(source_id)
    access = manifest.get("access")
    if not isinstance(access, Mapping):
        raise ValueError("South Coast source manifest has no access contract")
    region_specs = access.get("regions")
    if not isinstance(region_specs, Mapping):
        raise ValueError("South Coast source manifest has no region inventory")
    if tuple(region_specs) != SOUTH_COAST_REGION_PRIORITY:
        raise ValueError("South Coast regions disagree with the frozen west-to-east priority")
    if set(region_bathymetry_paths) != set(SOUTH_COAST_REGION_PRIORITY):
        raise ValueError("region bathymetry arguments disagree with the locked inventory")
    if set(region_aligned_layer_paths) != set(SOUTH_COAST_REGION_PRIORITY):
        raise ValueError("region aligned-layer arguments disagree with the locked inventory")

    ordered_region_layers: Dict[str, Dict[str, Path]] = {}
    for region_id in SOUTH_COAST_REGION_PRIORITY:
        raw_region_spec = region_specs[region_id]
        if not isinstance(raw_region_spec, Mapping):
            raise ValueError(f"South Coast region {region_id!r} is malformed")
        bathymetry_spec = raw_region_spec.get("bathymetry")
        if not isinstance(bathymetry_spec, Mapping):
            raise ValueError(f"South Coast region {region_id!r} lacks bathymetry")
        if sha256_file(region_bathymetry_paths[region_id]) != bathymetry_spec.get(
            "geotiff_sha256"
        ):
            raise ValueError(f"bathymetry checksum mismatch: {region_id}")
        backscatter_specs = raw_region_spec.get("backscatter_assets")
        if not isinstance(backscatter_specs, list) or not backscatter_specs:
            raise ValueError(f"South Coast region {region_id!r} lacks backscatter")
        layer_specs = {
            f"backscatter_intensity_{item['survey']}": item
            for item in backscatter_specs
            if isinstance(item, Mapping)
        }
        if len(layer_specs) != len(backscatter_specs):
            raise ValueError(f"South Coast region {region_id!r} has malformed backscatter")
        supplied_layers = region_aligned_layer_paths[region_id]
        if set(supplied_layers) != set(layer_specs):
            raise ValueError(
                f"aligned layers disagree with the locked inventory: {region_id}"
            )
        ordered_region_layers[region_id] = {
            name: supplied_layers[name] for name in layer_specs
        }
        for name, path in ordered_region_layers[region_id].items():
            if sha256_file(path) != layer_specs[name].get("geotiff_sha256"):
                raise ValueError(f"aligned layer checksum mismatch: {region_id}:{name}")

    video_specs = access.get("video_observation_assets")
    if not isinstance(video_specs, list) or not video_specs:
        raise ValueError("South Coast source manifest has no video observation inventory")
    expected_cruises = [str(spec["cruise_id"]) for spec in video_specs]
    if set(video_archive_paths) != set(expected_cruises):
        raise ValueError("video archive arguments disagree with the locked cruise inventory")

    raw_rows: list[dict[str, Any]] = []
    asset_summaries: Dict[str, Any] = {}
    for spec in video_specs:
        if not isinstance(spec, Mapping):
            raise ValueError("video observation specification must be an object")
        cruise_id = str(spec["cruise_id"])
        members = _read_archive(video_archive_paths[cruise_id], spec)
        stem = str(spec["dataset_stem"])
        points = _parse_point_shapefile(members[f"{stem}.shp"])
        fields = _parse_dbf_required_fields(members[f"{stem}.dbf"])
        if len(points) != len(fields["CLASS"]) or len(points) != spec.get("record_count"):
            raise ValueError(f"video geometry/table count mismatch for {cruise_id}")
        nonblank = {value for value in fields["CLASS"] if value}
        if not nonblank.issubset(VIDEO_CLASS_COLLAPSE):
            raise ValueError(f"video archive {cruise_id} has an unknown CLASS value")
        raw_class_counts = Counter(value for value in fields["CLASS"] if value)
        for record_index, raw_class in enumerate(fields["CLASS"]):
            if not raw_class:
                continue
            raw_rows.append(
                {
                    "cruise_id": cruise_id,
                    "record_index": record_index,
                    "line": fields["LINE"][record_index],
                    "tape": fields["TAPE"][record_index],
                    "longitude": float(points[record_index, 0]),
                    "latitude": float(points[record_index, 1]),
                    "raw_class": raw_class,
                    "class_index": VIDEO_CLASS_COLLAPSE[raw_class],
                }
            )
        asset_summaries[cruise_id] = {
            "record_count": len(points),
            "labeled_record_count": int(sum(raw_class_counts.values())),
            "raw_class_counts": dict(sorted(raw_class_counts.items())),
            "archive_sha256": spec["archive_sha256"],
            "member_inventory_verified": True,
        }
    if len(raw_rows) < 2:
        raise ValueError("video inventory has too few labeled observations")

    try:
        import rasterio
        from rasterio.warp import transform as transform_coordinates
    except ImportError as error:
        raise RuntimeError("video endpoint audit requires rasterio") from error

    selected: Dict[tuple[str, int], dict[str, Any]] = {}
    region_summaries: Dict[str, Any] = {}
    retained_before_dedup = 0
    for region_id in SOUTH_COAST_REGION_PRIORITY:
        bathymetry_path = region_bathymetry_paths[region_id]
        ordered_layers = ordered_region_layers[region_id]
        with rasterio.open(bathymetry_path) as dataset:
            if not dataset.crs:
                raise ValueError(f"bathymetry has no CRS: {region_id}")
            transformed_x, transformed_y = transform_coordinates(
                "EPSG:4326",
                dataset.crs,
                [row["longitude"] for row in raw_rows],
                [row["latitude"] for row in raw_rows],
            )
            bounds = dataset.bounds
            bathymetry_nodata = dataset.nodata
            center_values = np.asarray(
                [value[0] for value in dataset.sample(zip(transformed_x, transformed_y))],
                dtype=float,
            )
        inside = np.asarray(
            [
                bounds.left <= x <= bounds.right and bounds.bottom <= y <= bounds.top
                for x, y in zip(transformed_x, transformed_y)
            ],
            dtype=bool,
        )
        center_valid = inside & np.isfinite(center_values)
        if bathymetry_nodata is not None and np.isfinite(bathymetry_nodata):
            center_valid &= ~np.isclose(center_values, bathymetry_nodata)
        candidate_indices = np.flatnonzero(center_valid)
        retained_raw_indices = np.asarray([], dtype=np.int64)
        channel_names: Tuple[str, ...] = ()
        patch_design: Mapping[str, Any] = {}
        source_patterns: Counter[str] = Counter()
        if len(candidate_indices) >= 2:
            candidate_x = np.asarray(transformed_x, dtype=float)[candidate_indices]
            candidate_y = np.asarray(transformed_y, dtype=float)[candidate_indices]
            try:
                patches, retained_relative, channel_names, patch_metadata = (
                    _extract_hybrid_patches_at_coordinates(
                        bathymetry_path,
                        candidate_x,
                        candidate_y,
                        source_id=source_id,
                        vertical_datum=vertical_datum,
                        aligned_layer_paths=ordered_layers,
                        radii_m=radii_m,
                        output_size=output_size,
                        min_valid_fraction=min_valid_fraction,
                        min_aligned_valid_fraction=min_aligned_valid_fraction,
                        local_radius=local_radius,
                        broad_radius=broad_radius,
                        relief_radius=relief_radius,
                        horizontal_accuracy_m=horizontal_accuracy_m,
                        tile_size=tile_size,
                    )
                )
            except ValueError as error:
                if "no rare-structure patches passed the coverage contract" not in str(error):
                    raise
            else:
                retained_raw_indices = candidate_indices[retained_relative]
                patch_design = patch_metadata["patch_design"]
                center = output_size // 2
                availability_indices = [
                    index
                    for index, name in enumerate(channel_names)
                    if name.endswith("__available")
                ]
                if len(availability_indices) != len(ordered_layers):
                    raise ValueError(
                        f"hybrid patch channels lack availability masks: {region_id}"
                    )
                center_availability = patches[:, 0, availability_indices, center, center]
                source_patterns.update(
                    "".join("1" if value >= 0.5 else "0" for value in row)
                    for row in center_availability
                )
        retained_before_dedup += len(retained_raw_indices)
        assigned = 0
        for raw_index in retained_raw_indices:
            row = raw_rows[int(raw_index)]
            key = (str(row["cruise_id"]), int(row["record_index"]))
            if key not in selected:
                selected[key] = {**row, "region_id": region_id}
                assigned += 1
        retained_region_rows = [raw_rows[int(index)] for index in retained_raw_indices]
        region_class_counts = np.bincount(
            [row["class_index"] for row in retained_region_rows],
            minlength=len(VIDEO_CLASS_NAMES),
        )
        region_summaries[region_id] = {
            "labeled_rows_in_bathymetry_bounds": int(np.sum(inside)),
            "labeled_rows_at_valid_bathymetry_centers": int(len(candidate_indices)),
            "retained_full_hybrid_patch_rows_before_priority_dedup": int(
                len(retained_raw_indices)
            ),
            "assigned_rows_after_priority_dedup": assigned,
            "retained_class_counts_before_priority_dedup": {
                name: int(count)
                for name, count in zip(VIDEO_CLASS_NAMES, region_class_counts)
            },
            "center_backscatter_availability_patterns": dict(sorted(source_patterns.items())),
            "patch_contract": {
                "channel_names": list(channel_names),
                **patch_design,
            },
        }

    retained_rows = list(selected.values())
    if len(retained_rows) < 2:
        raise ValueError("fewer than two South Coast rows passed the hybrid patch contract")
    labels = np.asarray([row["class_index"] for row in retained_rows], dtype=np.int64)
    groups = np.asarray([row["cruise_id"] for row in retained_rows], dtype=str)
    class_counts = np.bincount(labels, minlength=len(VIDEO_CLASS_NAMES))
    partition_audit = _whole_group_partition_audit(
        labels,
        groups,
        min_rows_per_class=min_group_class_rows,
        group_definition="exact cruise_id; no LINE, TAPE, or adjacent-row split",
    )
    group_counts: Dict[str, Mapping[str, int]] = {}
    for group in sorted(set(groups)):
        counts = np.bincount(labels[groups == group], minlength=len(VIDEO_CLASS_NAMES))
        group_counts[group] = {
            name: int(count) for name, count in zip(VIDEO_CLASS_NAMES, counts)
        }
    assigned_region_counts = Counter(row["region_id"] for row in retained_rows)
    for region_id in SOUTH_COAST_REGION_PRIORITY:
        region_summaries[region_id]["assigned_rows_after_priority_dedup"] = int(
            assigned_region_counts[region_id]
        )

    admissible = partition_audit["eligible_partition_count"] > 0
    manifest_path = SOURCE_DIR / "usgs_santa_barbara_south_coast.json"
    metrics = {
        "schema_version": VIDEO_ENDPOINT_AUDIT_SCHEMA_VERSION,
        "source_id": source_id,
        "source_manifest_sha256": sha256_file(manifest_path),
        "geographic_scope": {
            "official_map_blocks_west_to_east": list(SOUTH_COAST_REGION_PRIORITY),
            "scope_boundary": (
                "Contiguous official USGS map blocks from Offshore Refugio Beach through "
                "Offshore Carpinteria; this is not evidence for Gaviota or the full product catalog."
            ),
            "overlap_assignment": (
                "First complete hybrid patch in the frozen west-to-east region priority; "
                "labels do not influence region assignment."
            ),
        },
        "endpoint": {
            "measurement": "direct scientist-recorded camera-video seafloor class",
            "observation_interval": "one 10-second observation per minute",
            "horizontal_positional_accuracy": "highly variable, on the order of 10 meters",
            "selection_design": "targeted sonar-interpretation validation tracks; not uniform",
            "class_collapse": {
                "1": VIDEO_CLASS_NAMES[0],
                "2": VIDEO_CLASS_NAMES[1],
                "3": VIDEO_CLASS_NAMES[1],
                "4": VIDEO_CLASS_NAMES[2],
            },
        },
        "label_visibility_protocol": {
            "exploratory_archives_inspected_during_source_discovery": ["s1c08sc", "z206sc"],
            "confirmatory_archives_held_unread_until_protocol_implementation_commit": [
                "sw109sc",
                "z107sc",
            ],
            "confirmatory_class_collapse_changed_after_label_read": False,
            "confirmatory_support_gate_changed_after_label_read": False,
            "confirmatory_grouping_rule_changed_after_label_read": False,
        },
        "assets": asset_summaries,
        "regions": region_summaries,
        "row_flow": {
            "labeled_official_rows": len(raw_rows),
            "retained_region_rows_before_priority_dedup": retained_before_dedup,
            "deduplicated_overlap_rows": retained_before_dedup - len(retained_rows),
            "retained_full_hybrid_patch_rows": len(retained_rows),
        },
        "retained_class_counts": {
            name: int(count) for name, count in zip(VIDEO_CLASS_NAMES, class_counts)
        },
        "retained_cruise_class_counts": group_counts,
        "leakage_gate": partition_audit,
        "lineage_boundary": {
            "video_endpoint_measurement_independent_of_sonar_interpretation": True,
            "video_track_selection_independent_of_sonar_interpretation": False,
            "published_habitat_polygons_accepted_as_independent_endpoint": False,
            "habitat_rejection_reason": (
                "Official metadata says bathymetry, backscatter, and hillshade were the "
                "primary interpretation sources; video and samples were supporting data."
            ),
        },
        "decision": {
            "video_probe_admissible": admissible,
            "model_training_run": False,
            "encoder_promoted": False,
            "serving_or_score_changed": False,
            "reason": (
                "No whole-cruise partition leaves at least "
                f"{min_group_class_rows} rows of every collapsed class in both train and test; "
                "a finer split would leak spatially adjacent track observations."
                if not admissible
                else "At least one whole-cruise partition passes the frozen support gate; this "
                "audit still does not authorize training without a separately reviewed protocol."
            ),
        },
        "claim_boundary": (
            "This audit measures endpoint support and leakage risk for historical USGS visual "
            "seafloor classes only. It does not validate current habitat, fish presence, catch "
            "skill, probability calibration, the Opportunity Score, model promotion, or deployment."
        ),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "usgs_south_coast_video_endpoint_audit_metrics.json"
    write_json(metrics_path, metrics)

    config = {
        "source_id": source_id,
        "vertical_datum": vertical_datum,
        "region_priority": list(SOUTH_COAST_REGION_PRIORITY),
        "overlap_assignment": "first complete hybrid patch in frozen region priority",
        "radii_m": list(map(float, radii_m)),
        "output_size": output_size,
        "min_valid_fraction": min_valid_fraction,
        "min_aligned_valid_fraction": min_aligned_valid_fraction,
        "local_radius": local_radius,
        "broad_radius": broad_radius,
        "relief_radius": relief_radius,
        "horizontal_accuracy_m": horizontal_accuracy_m,
        "tile_size": tile_size,
        "min_group_class_rows": min_group_class_rows,
        "group_definition": "exact cruise_id; no LINE, TAPE, or adjacent-row split",
    }
    input_paths = []
    for region_id in SOUTH_COAST_REGION_PRIORITY:
        input_paths.append(region_bathymetry_paths[region_id])
        input_paths.extend(ordered_region_layers[region_id].values())
    input_paths.extend(video_archive_paths[cruise] for cruise in expected_cruises)
    run_record = build_run_record(
        command="audit-usgs-south-coast-video-endpoint",
        target_taxon_id=None,
        config=config,
        input_paths=input_paths,
        dataset_kind="official_video_endpoint_admissibility_audit",
        status="completed",
        metrics={
            "audit_metrics_sha256": sha256_file(metrics_path),
            "video_probe_admissible": admissible,
            "model_training_run": False,
            "retained_rows": len(retained_rows),
            "eligible_group_partitions": partition_audit["eligible_partition_count"],
        },
        notes=(
            "Direct South Coast video observations were audited under a whole-cruise support "
            "gate. No model was fit and no serving artifact was changed."
        ),
    )
    verify_run_record_integrity(
        run_record,
        rehash_inputs=True,
        artifact_paths={"audit_metrics_sha256": metrics_path},
    )
    run_metadata_path = output_dir / "usgs_south_coast_video_endpoint_audit_run_metadata.json"
    write_json(run_metadata_path, run_record)
    return {"metrics": metrics_path, "run_metadata": run_metadata_path}


def audit_usgs_residual_statewide_video_support(
    video_archive_paths: Mapping[str, Path],
    output_dir: Path,
    *,
    source_id: str = "usgs_ds781_residual_video_observations",
    min_group_class_rows: int = 16,
) -> Mapping[str, Path]:
    """Screen the residual DS 781 catalog for whole-cruise class support only.

    This intentionally stops before raster acquisition, spatial alignment, or
    model fitting.  Passing it establishes only that a later endpoint protocol
    is worth designing.
    """

    manifest = get_source_manifest(source_id)
    access = manifest.get("access")
    if not isinstance(access, Mapping):
        raise ValueError("residual video source manifest has no access contract")
    specs = access.get("video_observation_assets")
    if not isinstance(specs, list) or not specs:
        raise ValueError("residual video source manifest has no archive inventory")
    expected_cruises = [
        str(spec.get("cruise_id")) if isinstance(spec, Mapping) else "" for spec in specs
    ]
    if tuple(expected_cruises) != RESIDUAL_STATEWIDE_VIDEO_CRUISES:
        raise ValueError("residual video cruises disagree with the frozen catalog selection")
    if set(video_archive_paths) != set(RESIDUAL_STATEWIDE_VIDEO_CRUISES):
        raise ValueError("video archive arguments disagree with the frozen residual inventory")
    prior_cruises = access.get("prior_audit_cruises")
    if not isinstance(prior_cruises, list) or set(prior_cruises) & set(expected_cruises):
        raise ValueError("residual and prior-audit cruise inventories are not disjoint")

    labels: list[int] = []
    groups: list[str] = []
    asset_summaries: Dict[str, Any] = {}
    unexpected_class_rows = 0
    unexpected_class_values: Dict[str, list[str]] = {}
    for spec in specs:
        if not isinstance(spec, Mapping):
            raise ValueError("video observation specification must be an object")
        cruise_id = str(spec["cruise_id"])
        members = _read_archive(video_archive_paths[cruise_id], spec)
        stem = str(spec["dataset_stem"])
        points = _parse_point_shapefile(members[f"{stem}.shp"])
        fields = _parse_dbf_required_fields(members[f"{stem}.dbf"])
        if len(points) != len(fields["CLASS"]) or len(points) != spec.get("record_count"):
            raise ValueError(f"video geometry/table count mismatch for {cruise_id}")
        nonblank = {value for value in fields["CLASS"] if value}
        unexpected = sorted(nonblank - set(VIDEO_CLASS_COLLAPSE))
        if unexpected:
            unexpected_class_values[cruise_id] = unexpected
        raw_class_counts = Counter(value for value in fields["CLASS"] if value)
        collapsed_counts = np.zeros(len(VIDEO_CLASS_NAMES), dtype=np.int64)
        for index, raw_class in enumerate(fields["CLASS"]):
            if not raw_class:
                continue
            if not fields["LINE"][index] or not fields["TAPE"][index]:
                raise ValueError(
                    f"labeled video observation lacks LINE or TAPE for {cruise_id}"
                )
            if raw_class not in VIDEO_CLASS_COLLAPSE:
                unexpected_class_rows += 1
                continue
            class_index = VIDEO_CLASS_COLLAPSE[raw_class]
            labels.append(class_index)
            groups.append(cruise_id)
            collapsed_counts[class_index] += 1
        asset_summaries[cruise_id] = {
            "record_count": len(points),
            "labeled_record_count": int(sum(raw_class_counts.values())),
            "raw_class_counts": dict(sorted(raw_class_counts.items())),
            "unexpected_nonblank_class_values": unexpected,
            "collapsed_class_counts": {
                name: int(count)
                for name, count in zip(VIDEO_CLASS_NAMES, collapsed_counts)
            },
            "archive_sha256": spec["archive_sha256"],
            "member_inventory_verified": True,
        }
    if len(labels) < 2:
        raise ValueError("residual video inventory has too few labeled observations")

    label_array = np.asarray(labels, dtype=np.int64)
    group_array = np.asarray(groups, dtype=str)
    total_counts = np.bincount(label_array, minlength=len(VIDEO_CLASS_NAMES))
    partition_audit = _whole_group_partition_audit(
        label_array,
        group_array,
        min_rows_per_class=min_group_class_rows,
        group_definition="exact cruise_id; no LINE, TAPE, date, coordinate, or adjacent-row split",
    )
    source_schema_valid = not unexpected_class_values
    admissible = (
        source_schema_valid and partition_audit["eligible_partition_count"] > 0
    )
    manifest_path = SOURCE_DIR / "usgs_ds781_residual_video_observations.json"
    protocol_path = (
        SOURCE_DIR.parents[1]
        / "docs"
        / "experiments"
        / "2026-07-22-usgs-residual-statewide-video-support-screen-protocol-v1.md"
    )
    metrics = {
        "schema_version": VIDEO_SUPPORT_SCREEN_SCHEMA_VERSION,
        "source_id": source_id,
        "source_manifest_sha256": sha256_file(manifest_path),
        "protocol_sha256": sha256_file(protocol_path),
        "catalog_selection": {
            "residual_cruises": list(RESIDUAL_STATEWIDE_VIDEO_CRUISES),
            "prior_audit_cruises": prior_cruises,
            "selection_changed_after_label_read": False,
        },
        "endpoint": {
            "measurement": "direct scientist-recorded camera-video seafloor class",
            "observation_interval": "one 10-second observation per minute",
            "horizontal_positional_accuracy": "highly variable, on the order of 10 meters",
            "selection_design": "targeted sonar-interpretation validation tracks; not uniform",
            "class_collapse": {
                "1": VIDEO_CLASS_NAMES[0],
                "2": VIDEO_CLASS_NAMES[1],
                "3": VIDEO_CLASS_NAMES[1],
                "4": VIDEO_CLASS_NAMES[2],
            },
        },
        "assets": asset_summaries,
        "row_flow": {
            "official_records": int(sum(item["record_count"] for item in asset_summaries.values())),
            "nonblank_class_rows": int(
                sum(item["labeled_record_count"] for item in asset_summaries.values())
            ),
            "recognized_class_rows": len(labels),
            "unexpected_class_rows": unexpected_class_rows,
        },
        "collapsed_class_counts": {
            name: int(count) for name, count in zip(VIDEO_CLASS_NAMES, total_counts)
        },
        "source_schema_gate": {
            "valid": source_schema_valid,
            "unexpected_nonblank_class_values": unexpected_class_values,
            "unexpected_class_rows": unexpected_class_rows,
            "unknown_values_reinterpreted_or_dropped_for_admission": False,
        },
        "recognized_rows_partition_diagnostic": {
            **partition_audit,
            "authoritative_for_admission": source_schema_valid,
        },
        "next_stage_requirements": {
            "source_specific_bathymetry_and_backscatter_required": True,
            "survey_bound_intensity_and_availability_masks_required": True,
            "existing_multiscale_patch_contract_required": True,
            "minimum_cross_boundary_buffer_m": 512,
            "separate_protocol_required_before_training": True,
        },
        "decision": {
            "raw_endpoint_support_admissible": admissible,
            "raster_acquisition_authorized": False,
            "model_training_run": False,
            "encoder_promoted": False,
            "serving_or_score_changed": False,
            "reason": (
                "At least one archive contains a nonblank CLASS value outside the frozen 1-4 "
                "domain; the source schema fails closed without reinterpretation."
                if not source_schema_valid
                else (
                    "No whole-cruise partition leaves at least "
                    f"{min_group_class_rows} rows of every collapsed class in both train and test."
                    if not admissible
                    else "At least one whole-cruise partition passes the frozen raw support floor; "
                    "a separately frozen raster, alignment, buffering, and training protocol is still required."
                )
            ),
        },
        "claim_boundary": (
            "This raw support screen does not establish raster coverage, spatial independence, "
            "current habitat, fish presence, catch skill, score calibration, model promotion, "
            "product readiness, or deployment authority."
        ),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "usgs_residual_statewide_video_support_screen_metrics.json"
    write_json(metrics_path, metrics)

    config = {
        "source_id": source_id,
        "residual_cruises": list(RESIDUAL_STATEWIDE_VIDEO_CRUISES),
        "min_group_class_rows": min_group_class_rows,
        "group_definition": (
            "exact cruise_id; no LINE, TAPE, date, coordinate, or adjacent-row split"
        ),
        "raster_acquisition": False,
        "model_training": False,
    }
    input_paths = [manifest_path, protocol_path]
    input_paths.extend(video_archive_paths[cruise] for cruise in expected_cruises)
    run_record = build_run_record(
        command="audit-usgs-residual-statewide-video-support",
        target_taxon_id=None,
        config=config,
        input_paths=input_paths,
        dataset_kind="official_video_endpoint_admissibility_audit",
        status="completed",
        metrics={
            "audit_metrics_sha256": sha256_file(metrics_path),
            "raw_endpoint_support_admissible": admissible,
            "source_schema_valid": source_schema_valid,
            "model_training_run": False,
            "recognized_class_rows": len(labels),
            "eligible_group_partitions": partition_audit["eligible_partition_count"],
        },
        notes=(
            "Residual official video observations were screened under a whole-cruise raw support "
            "gate. No raster was acquired, no model was fit, and no serving artifact changed."
        ),
    )
    verify_run_record_integrity(
        run_record,
        rehash_inputs=True,
        artifact_paths={"audit_metrics_sha256": metrics_path},
    )
    run_metadata_path = output_dir / "usgs_residual_statewide_video_support_run_metadata.json"
    write_json(run_metadata_path, run_record)
    return {"metrics": metrics_path, "run_metadata": run_metadata_path}


__all__ = [
    "RESIDUAL_STATEWIDE_VIDEO_CRUISES",
    "VIDEO_CLASS_NAMES",
    "VIDEO_ENDPOINT_AUDIT_SCHEMA_VERSION",
    "VIDEO_SUPPORT_SCREEN_SCHEMA_VERSION",
    "SOUTH_COAST_REGION_PRIORITY",
    "_parse_dbf_required_fields",
    "_parse_point_shapefile",
    "_read_archive",
    "_whole_group_partition_audit",
    "audit_usgs_sf_video_endpoint",
    "audit_usgs_south_coast_video_endpoint",
    "audit_usgs_residual_statewide_video_support",
]
