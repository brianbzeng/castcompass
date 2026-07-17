"""Canonical bathymetry and recreational-catch ingestion."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import pandas as pd

from .geo import GeoGrid, GridValidationError, verify_projected_crs
from .metadata import sha256_file, utc_now, write_json
from .sources import get_source_manifest

from shared.species_contract import (
    JSON_SAFE_INTEGER_MAX,
    MODEL_PROJECTED_CRS_IDS,
    OBSERVATION_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    SYNTHETIC_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    UNRESOLVED_TAXON_ID,
    is_known_taxon,
    is_model_eligible_target,
    is_observation_eligible,
    is_strict_offset_datetime,
    validate_contract_assets,
)


OBSERVATION_COLUMNS = (
    "observation_contract_version",
    "taxon_catalog_version",
    "contract_status",
    "observation_id",
    "event_id",
    "effort_segment_id",
    "observed_at",
    "observed_end_at",
    "temporal_precision",
    "primary_target_taxon_id",
    "species",
    "catch_count",
    "target_encounter_count",
    "any_fish_encounter_count",
    "effort_hours",
    "target_effort_unit",
    "fishing_mode",
    "sample_weight",
    "outcome_class",
    "source_data_kind",
    "source_complete_attempt",
    "source_expanded_estimate",
    "taxon_observations_json",
    "x",
    "y",
    "crs",
    "area_id",
    "spatial_support_id",
    "spatial_support_kind",
    "spatial_resolution",
    "source_id",
)

OBSERVATION_TOP_LEVEL_FIELDS = {
    "contract_version",
    "taxon_catalog_version",
    "contract_status",
    "observation_id",
    "effort_segment_id",
    "primary_target_taxon_id",
    "source",
    "target_effort",
    "temporal_support",
    "spatial_support",
    "taxon_observations",
    "outcome_class",
}

COUNT_FIELDS = (
    "encounter_count",
    "retained_count",
    "released_count",
    "disposition_unknown_count",
)
OUTCOME_CLASSES = {"target_encountered", "non_target_only", "no_fish"}
CONFIDENCE_BASIS = {
    "verified": {"official-survey-code", "expert-review", "photo-review"},
    "self_reported": {"angler-report"},
    "uncertain": {"angler-report", "photo-review"},
    "unresolved": {"unresolved"},
    "not_observed": {"not-observed"},
}
STABLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")


def save_grid(path: Path, grid: GeoGrid) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "schema_version": "1.0",
        "crs": grid.crs,
        "transform": list(grid.transform),
        "vertical_datum": grid.vertical_datum,
        "horizontal_units": grid.horizontal_units,
        "nodata": grid.nodata,
        "source_id": grid.source_id,
    }
    np.savez_compressed(path, values=grid.values, metadata=json.dumps(metadata, sort_keys=True))


def load_grid(path: Path) -> GeoGrid:
    suffix = path.suffix.lower()
    if suffix == ".npz":
        with np.load(path, allow_pickle=False) as archive:
            values = archive["values"]
            raw_metadata = archive["metadata"].item()
        metadata = json.loads(str(raw_metadata))
        return GeoGrid(
            values=values,
            crs=metadata["crs"],
            transform=tuple(metadata["transform"]),
            vertical_datum=metadata["vertical_datum"],
            horizontal_units=metadata.get("horizontal_units", "metre"),
            nodata=metadata.get("nodata"),
            source_id=metadata.get("source_id", "unknown"),
        )
    if suffix in {".tif", ".tiff"}:
        raise GridValidationError(
            "raw GeoTIFF needs explicit vertical datum; run ingest-bathymetry instead of load_grid"
        )
    raise ValueError(f"unsupported raster format {suffix!r}; expected canonical .npz")


def ingest_bathymetry(
    source_path: Path,
    output_path: Path,
    *,
    source_id: str,
    vertical_datum: str,
    expected_sha256: str | None = None,
    crs_override: str | None = None,
) -> Mapping[str, Any]:
    """Convert an official GeoTIFF or canonical NPZ into a validated archive."""

    manifest = get_source_manifest(source_id)
    actual_sha256 = sha256_file(source_path)
    if expected_sha256 and expected_sha256.lower() != actual_sha256:
        raise ValueError(
            f"checksum mismatch for {source_path}: expected {expected_sha256}, got {actual_sha256}"
        )

    if source_path.suffix.lower() == ".npz":
        source_grid = load_grid(source_path)
        if crs_override and crs_override.strip().upper() != source_grid.crs.strip().upper():
            raise GridValidationError(
                "--crs-override cannot reproject a canonical NPZ; create a correctly reprojected raster first"
            )
        grid = GeoGrid(
            source_grid.values,
            source_grid.crs,
            source_grid.transform,
            vertical_datum,
            source_grid.horizontal_units,
            source_grid.nodata,
            source_id,
        )
    elif source_path.suffix.lower() in {".tif", ".tiff"}:
        try:
            import rasterio  # type: ignore
        except ImportError as error:
            raise RuntimeError(
                "GeoTIFF ingestion requires rasterio. Install it in an isolated Python environment; "
                "the synthetic smoke path does not require it."
            ) from error
        with rasterio.open(source_path) as dataset:
            if dataset.count != 1:
                raise GridValidationError("bathymetry input must contain exactly one raster band")
            source_crs = dataset.crs.to_string() if dataset.crs else ""
            if crs_override and source_crs and crs_override.strip().upper() != source_crs.strip().upper():
                raise GridValidationError(
                    "--crs-override only supplies missing metadata; it cannot reproject a raster. "
                    "Warp the GeoTIFF before ingestion."
                )
            crs = source_crs or crs_override or ""
            transform = dataset.transform
            grid = GeoGrid(
                dataset.read(1),
                crs,
                (transform.c, transform.a, transform.b, transform.f, transform.d, transform.e),
                vertical_datum,
                "metre",
                dataset.nodata,
                source_id,
            )
    else:
        raise ValueError("bathymetry input must be GeoTIFF or canonical NPZ")

    crs_check = verify_projected_crs(grid.crs)
    save_grid(output_path, grid)
    provenance = {
        "schema_version": "1.0",
        "created_at": utc_now(),
        "source_id": source_id,
        "source_title": manifest["title"],
        "official_landing_page": manifest["official_landing_page"],
        "input_path": str(source_path.resolve()),
        "input_sha256": actual_sha256,
        "output_path": str(output_path.resolve()),
        "output_sha256": sha256_file(output_path),
        "crs_check": crs_check,
        "vertical_datum": vertical_datum,
        "bounds": list(grid.bounds),
        "shape": list(grid.values.shape),
        "not_for_navigation": True,
    }
    write_json(output_path.with_suffix(".provenance.json"), provenance)
    return provenance


def _strict_keys(value: Mapping[str, Any], expected: set[str], *, location: str) -> None:
    missing = expected - set(value)
    extra = set(value) - expected
    if missing or extra:
        raise ValueError(
            f"{location} fields do not match the observation contract; "
            f"missing={sorted(missing)}, extra={sorted(extra)}"
        )


def _load_observation_records(path: Path) -> list[Mapping[str, Any]]:
    if path.suffix.lower() in {".jsonl", ".ndjson"}:
        records: list[Mapping[str, Any]] = []
        for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not raw_line.strip():
                continue
            try:
                value = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid observation JSON on line {line_number}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"observation line {line_number} must be a JSON object")
            records.append(value)
        return records
    if path.suffix.lower() == ".json":
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("invalid observation JSON document") from exc
        if isinstance(value, dict):
            value = value.get("observations")
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            raise ValueError("observation JSON must be an array or an {observations: [...]} object")
        return value
    raise ValueError(
        "observation input must be canonical JSONL/JSON; flat catch-only CSV exports are rejected"
    )


def _aware_timestamp(value: Any, *, location: str) -> pd.Timestamp:
    if not is_strict_offset_datetime(value):
        raise ValueError(f"{location} must be an ISO-8601 timestamp with an explicit offset")
    try:
        stamp = pd.Timestamp(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{location} is not a valid ISO-8601 timestamp") from exc
    if stamp.tzinfo is None:
        raise ValueError(f"{location} must include a timezone offset")
    return stamp.tz_convert("UTC")


def _bool(value: Any, *, location: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{location} must be a JSON boolean")
    return value


def _finite_json_number(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{location} must be a finite JSON number")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise ValueError(f"{location} must be a finite JSON number") from exc
    if not np.isfinite(number):
        raise ValueError(f"{location} must be a finite JSON number")
    return number


def _count(value: Any, *, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{location} must be a nonnegative JSON-safe integer")
    if isinstance(value, int):
        valid = 0 <= value <= JSON_SAFE_INTEGER_MAX
    else:
        valid = (
            np.isfinite(value)
            and value.is_integer()
            and 0 <= value <= JSON_SAFE_INTEGER_MAX
        )
    if not valid:
        raise ValueError(f"{location} must be a nonnegative JSON-safe integer")
    return int(value)


def _stable_id(value: Any, *, location: str) -> str:
    if not isinstance(value, str) or STABLE_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{location} must be a normalized stable identifier")
    return value


def _validate_taxon_observation(
    raw: Mapping[str, Any], *, data_kind: str, location: str
) -> dict[str, Any]:
    expected = {
        "taxon_id",
        *COUNT_FIELDS,
        "identification_confidence",
        "identification_basis",
    }
    _strict_keys(raw, expected, location=location)
    taxon_id = raw.get("taxon_id")
    environment = "test" if data_kind == "synthetic-fixture" else "production"
    if not isinstance(taxon_id, str) or not is_known_taxon(taxon_id):
        raise ValueError(f"{location}.taxon_id is not in the canonical catalog")
    if not is_observation_eligible(taxon_id, environment=environment):
        raise ValueError(f"{location}.taxon_id is not observation eligible in {environment}")
    counts = {field: _count(raw.get(field), location=f"{location}.{field}") for field in COUNT_FIELDS}
    if counts["retained_count"] + counts["released_count"] + counts["disposition_unknown_count"] != counts["encounter_count"]:
        raise ValueError(f"{location} disposition counts must sum to encounter_count")
    confidence = raw.get("identification_confidence")
    basis = raw.get("identification_basis")
    allowed_basis = CONFIDENCE_BASIS.get(str(confidence))
    synthetic_identity = (
        data_kind == "synthetic-fixture"
        and taxon_id == SYNTHETIC_TARGET_TAXON_ID
        and confidence == "verified"
        and basis == "synthetic-fixture"
    )
    if basis == "synthetic-fixture" and taxon_id != SYNTHETIC_TARGET_TAXON_ID:
        raise ValueError(f"{location} synthetic identity is allowed only for synthetic-target")
    if data_kind != "synthetic-fixture" and basis == "synthetic-fixture":
        raise ValueError(f"{location} production observations cannot use synthetic identity")
    if not synthetic_identity and (allowed_basis is None or basis not in allowed_basis):
        raise ValueError(f"{location} identification confidence/basis combination is invalid")
    if counts["encounter_count"] == 0 and (confidence, basis) != ("not_observed", "not-observed"):
        raise ValueError(f"{location} zero encounter rows must be not_observed/not-observed")
    if counts["encounter_count"] > 0 and confidence == "not_observed":
        raise ValueError(f"{location} positive encounter rows cannot be not_observed")
    if taxon_id == UNRESOLVED_TAXON_ID and counts["encounter_count"] > 0:
        if (confidence, basis) != ("unresolved", "unresolved"):
            raise ValueError(f"{location} unresolved fish must retain unresolved identity")
    if taxon_id != UNRESOLVED_TAXON_ID and confidence == "unresolved":
        raise ValueError(f"{location} cannot attach unresolved identity to a named taxon")
    return {"taxon_id": taxon_id, **counts, "identification_confidence": confidence, "identification_basis": basis}


def _flatten_observation(
    raw: Mapping[str, Any],
    *,
    declared_target_taxon_id: str,
    declared_source_id: str,
    location: str,
) -> dict[str, Any]:
    _strict_keys(raw, OBSERVATION_TOP_LEVEL_FIELDS, location=location)
    if raw.get("contract_version") != OBSERVATION_CONTRACT_VERSION:
        raise ValueError(f"{location} has an unsupported observation contract_version")
    if raw.get("taxon_catalog_version") != TAXON_CATALOG_VERSION:
        raise ValueError(f"{location} has an unsupported taxon_catalog_version")
    status = raw.get("contract_status")
    if status != "valid":
        raise ValueError(f"{location} is not a valid v2 observation contract")
    observation_id = _stable_id(raw.get("observation_id"), location=f"{location}.observation_id")
    effort_segment_id = _stable_id(raw.get("effort_segment_id"), location=f"{location}.effort_segment_id")
    target_taxon_id = raw.get("primary_target_taxon_id")
    if target_taxon_id != declared_target_taxon_id:
        raise ValueError(f"{location} does not match the one declared primary target")

    source = raw.get("source")
    if not isinstance(source, dict):
        raise ValueError(f"{location}.source must be an object")
    allowed_source_fields = {"source_id", "source_record_id", "data_kind", "complete_attempt", "expanded_estimate"}
    if set(source) - allowed_source_fields or not {"source_id", "data_kind", "complete_attempt", "expanded_estimate"} <= set(source):
        raise ValueError(f"{location}.source fields do not match the contract")
    if source.get("source_id") != declared_source_id:
        raise ValueError(f"{location}.source_id does not match the declared source")
    _stable_id(source.get("source_id"), location=f"{location}.source.source_id")
    if "source_record_id" in source:
        _stable_id(source.get("source_record_id"), location=f"{location}.source.source_record_id")
    data_kind = source.get("data_kind")
    if data_kind not in {"complete-effort-segment", "synthetic-fixture"}:
        raise ValueError(f"{location} is catch-only or has an unsupported source data_kind")
    if not _bool(source.get("complete_attempt"), location=f"{location}.source.complete_attempt"):
        raise ValueError(f"{location} is catch-only; a complete attempt is required")
    if _bool(source.get("expanded_estimate"), location=f"{location}.source.expanded_estimate"):
        raise ValueError(f"{location} is an expanded estimate and cannot be used as an observation")

    environment = "test" if data_kind == "synthetic-fixture" else "production"
    if not is_model_eligible_target(str(target_taxon_id), environment=environment):
        raise ValueError(f"{location} primary target is not model eligible in {environment}")
    if environment == "production" and target_taxon_id != PRODUCTION_TARGET_TAXON_ID:
        raise ValueError(f"{location} production target must be California halibut")
    if environment == "test" and target_taxon_id != SYNTHETIC_TARGET_TAXON_ID:
        raise ValueError(f"{location} synthetic fixtures must use synthetic-target")

    effort = raw.get("target_effort")
    if not isinstance(effort, dict):
        raise ValueError(f"{location}.target_effort must be an object")
    _strict_keys(effort, {"value", "unit", "mode"}, location=f"{location}.target_effort")
    raw_effort_value = effort.get("value")
    effort_value = _finite_json_number(
        raw_effort_value,
        location=f"{location}.target_effort.value",
    )
    if effort_value <= 0:
        raise ValueError(f"{location}.target_effort.value must be finite and positive")
    effort_unit = effort.get("unit")
    if effort_unit not in {"trip-hours", "angler-hours", "rod-hours"}:
        raise ValueError(f"{location}.target_effort.unit is invalid")
    fishing_mode = effort.get("mode")
    if (
        not isinstance(fishing_mode, str)
        or not fishing_mode.strip()
        or fishing_mode != fishing_mode.strip()
        or len(fishing_mode) > 120
    ):
        raise ValueError(f"{location}.target_effort.mode must be a normalized nonempty source string")

    temporal = raw.get("temporal_support")
    if not isinstance(temporal, dict):
        raise ValueError(f"{location}.temporal_support must be an object")
    _strict_keys(temporal, {"start_at", "end_at", "precision"}, location=f"{location}.temporal_support")
    if temporal.get("precision") not in {"exact", "bounded"}:
        raise ValueError(f"{location}.temporal_support.precision is invalid")
    start_at = _aware_timestamp(temporal.get("start_at"), location=f"{location}.temporal_support.start_at")
    end_at = _aware_timestamp(temporal.get("end_at"), location=f"{location}.temporal_support.end_at")
    if end_at <= start_at:
        raise ValueError(f"{location}.temporal_support.end_at must be after start_at")

    spatial = raw.get("spatial_support")
    if not isinstance(spatial, dict):
        raise ValueError(f"{location}.spatial_support must be an object")
    kind = spatial.get("kind")
    if kind not in {"point", "site", "area"}:
        raise ValueError(f"{location}.spatial_support.kind is invalid")
    support_id = _stable_id(
        spatial.get("support_id"), location=f"{location}.spatial_support.support_id"
    )
    if kind == "point":
        _strict_keys(spatial, {"kind", "support_id", "crs", "x", "y"}, location=f"{location}.spatial_support")
        crs = spatial.get("crs")
        if crs not in MODEL_PROJECTED_CRS_IDS:
            raise ValueError(
                f"{location} point support CRS must exactly match one of "
                f"{list(MODEL_PROJECTED_CRS_IDS)}"
            )
        verify_projected_crs(crs)
        x = _finite_json_number(
            spatial.get("x"),
            location=f"{location}.spatial_support.x",
        )
        y = _finite_json_number(
            spatial.get("y"),
            location=f"{location}.spatial_support.y",
        )
    else:
        _strict_keys(spatial, {"kind", "support_id"}, location=f"{location}.spatial_support")
        crs = np.nan
        x = y = np.nan

    taxon_rows = raw.get("taxon_observations")
    if not isinstance(taxon_rows, list) or not taxon_rows:
        raise ValueError(f"{location}.taxon_observations must be a nonempty array")
    normalized_taxa = [
        _validate_taxon_observation(item, data_kind=str(data_kind), location=f"{location}.taxon_observations[{index}]")
        for index, item in enumerate(taxon_rows)
        if isinstance(item, dict)
    ]
    if len(normalized_taxa) != len(taxon_rows):
        raise ValueError(f"{location}.taxon_observations entries must be objects")
    taxon_ids = [item["taxon_id"] for item in normalized_taxa]
    if len(taxon_ids) != len(set(taxon_ids)):
        raise ValueError(f"{location}.taxon_observations contains duplicate taxa")
    target_rows = [item for item in normalized_taxa if item["taxon_id"] == target_taxon_id]
    if len(target_rows) != 1:
        raise ValueError(f"{location} must contain exactly one primary-target taxon row")
    target_count = int(target_rows[0]["encounter_count"])
    any_fish_count = sum(int(item["encounter_count"]) for item in normalized_taxa)
    derived_outcome = (
        "target_encountered" if target_count > 0 else "non_target_only" if any_fish_count > 0 else "no_fish"
    )
    outcome = raw.get("outcome_class")
    if outcome not in OUTCOME_CLASSES or outcome != derived_outcome:
        raise ValueError(f"{location}.outcome_class disagrees with taxon encounter counts")

    return {
        "observation_contract_version": OBSERVATION_CONTRACT_VERSION,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "contract_status": status,
        "observation_id": observation_id,
        "event_id": observation_id,
        "effort_segment_id": effort_segment_id,
        "observed_at": start_at.isoformat().replace("+00:00", "Z"),
        "observed_end_at": end_at.isoformat().replace("+00:00", "Z"),
        "temporal_precision": temporal["precision"],
        "primary_target_taxon_id": target_taxon_id,
        "species": target_taxon_id,
        "catch_count": target_count,
        "target_encounter_count": target_count,
        "any_fish_encounter_count": any_fish_count,
        "effort_hours": effort_value,
        "target_effort_unit": effort_unit,
        "fishing_mode": fishing_mode,
        # Each row is one complete effort segment. This is never a survey
        # expansion factor and downstream model code requires it to remain 1.
        "sample_weight": 1.0,
        "outcome_class": outcome,
        "source_data_kind": data_kind,
        "source_complete_attempt": True,
        "source_expanded_estimate": False,
        "taxon_observations_json": json.dumps(normalized_taxa, sort_keys=True, separators=(",", ":")),
        "x": x,
        "y": y,
        "crs": crs,
        "area_id": support_id if kind == "area" else np.nan,
        "spatial_support_id": support_id,
        "spatial_support_kind": kind,
        "spatial_resolution": kind,
        "source_id": declared_source_id,
        "occurrence": int(target_count > 0),
        "cpue": target_count / effort_value,
        "terrain_model_eligible": status == "valid" and kind == "point" and temporal["precision"] == "exact",
    }


def ingest_observations(
    source_path: Path,
    output_path: Path,
    *,
    source_id: str,
    primary_target_taxon_id: str,
    column_map_path: Path | None = None,
    expected_sha256: str | None = None,
) -> Mapping[str, Any]:
    """Validate canonical complete-effort records and flatten them for modeling.

    Catch-only rows, expanded survey estimates, implicit targets, and legacy
    flat CSVs are rejected. Site/area records remain descriptive only and are
    never promoted to precise terrain points.
    """

    validate_contract_assets()
    if column_map_path is not None:
        raise ValueError("column maps are not accepted by observation contract v2")
    if source_id == "synthetic_fixture":
        manifest: Mapping[str, Any] = {
            "title": "Synthetic pipeline fixture",
            "official_landing_page": "not-applicable",
        }
    else:
        manifest = get_source_manifest(source_id)
    actual_sha256 = sha256_file(source_path)
    if expected_sha256 and expected_sha256.lower() != actual_sha256:
        raise ValueError("observation checksum does not match expected_sha256")
    records = _load_observation_records(source_path)
    if not records:
        raise ValueError("observation input contains no records")
    flattened = [
        _flatten_observation(
            raw,
            declared_target_taxon_id=primary_target_taxon_id,
            declared_source_id=source_id,
            location=f"observation[{index}]",
        )
        for index, raw in enumerate(records)
    ]
    normalized = pd.DataFrame(flattened)
    if normalized["observation_id"].duplicated().any():
        raise ValueError("observation_id values must be unique")
    if normalized["effort_segment_id"].duplicated().any():
        raise ValueError("effort_segment_id values must be unique")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    normalized.to_csv(output_path, index=False)
    provenance = {
        "schema_version": OBSERVATION_CONTRACT_VERSION,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "primary_target_taxon_id": primary_target_taxon_id,
        "created_at": utc_now(),
        "source_id": source_id,
        "source_title": manifest["title"],
        "official_landing_page": manifest["official_landing_page"],
        "input_path": str(source_path.resolve()),
        "input_sha256": actual_sha256,
        "output_path": str(output_path.resolve()),
        "output_sha256": sha256_file(output_path),
        "rows": int(len(normalized)),
        "valid_rows": int((normalized["contract_status"] == "valid").sum()),
        "legacy_unverified_rows": int((normalized["contract_status"] == "legacy_unverified").sum()),
        "terrain_model_eligible_rows": int(normalized["terrain_model_eligible"].sum()),
        "sample_weight_contract": (
            "Always 1.0 per complete effort segment; never a survey expansion factor."
        ),
        "spatial_warning": (
            "Aggregated or area-only records were retained but are not eligible for exact terrain joins."
        ),
    }
    write_json(output_path.with_suffix(".provenance.json"), provenance)
    return provenance


def load_model_observations(
    path: Path,
    expected_crs: str,
    *,
    expected_target_taxon_id: str,
) -> pd.DataFrame:
    """Load only verified, target-consistent complete-effort observations."""

    validate_contract_assets()
    frame = pd.read_csv(path)
    required = {
        "observation_contract_version",
        "taxon_catalog_version",
        "contract_status",
        "observation_id",
        "effort_segment_id",
        "primary_target_taxon_id",
        "observed_at",
        "observed_end_at",
        "temporal_precision",
        "target_encounter_count",
        "any_fish_encounter_count",
        "effort_hours",
        "target_effort_unit",
        "sample_weight",
        "outcome_class",
        "source_data_kind",
        "source_id",
        "source_complete_attempt",
        "source_expanded_estimate",
        "taxon_observations_json",
        "spatial_support_kind",
        "spatial_support_id",
        "x",
        "y",
        "occurrence",
        "cpue",
        "terrain_model_eligible",
        "crs",
    }
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"model observations missing columns: {sorted(missing)}")
    if frame.empty:
        raise ValueError("model observations are empty")
    statuses = set(frame["contract_status"].astype(str))
    if not statuses <= {"valid", "legacy_unverified"}:
        raise ValueError("rejected or unknown observation contract statuses cannot enter modeling")
    frame = frame.loc[frame["contract_status"].astype(str) == "valid"].copy()
    if frame.empty:
        raise ValueError("no valid observations remain after excluding legacy_unverified rows")

    for field in ("observation_id", "effort_segment_id", "source_id", "spatial_support_id"):
        values = frame[field]
        if not values.map(
            lambda value: isinstance(value, str)
            and value == value.strip()
            and STABLE_ID_PATTERN.fullmatch(value) is not None
        ).all():
            raise ValueError(f"{field} must be a nonblank normalized identifier")
    if frame["observation_id"].astype(str).duplicated().any():
        raise ValueError("observation_id values must be unique at the model boundary")
    if frame["effort_segment_id"].astype(str).duplicated().any():
        raise ValueError("effort_segment_id values must be unique at the model boundary")
    if set(frame["observation_contract_version"].astype(str)) != {OBSERVATION_CONTRACT_VERSION}:
        raise ValueError("model observations mix or omit the locked observation contract version")
    if set(frame["taxon_catalog_version"].astype(str)) != {TAXON_CATALOG_VERSION}:
        raise ValueError("model observations mix or omit the locked taxon catalog version")
    targets = set(frame["primary_target_taxon_id"].astype(str))
    if targets != {expected_target_taxon_id}:
        raise ValueError(
            f"model observations target mismatch: expected {expected_target_taxon_id!r}, got {sorted(targets)}"
        )
    environments = set(frame["source_data_kind"].astype(str))
    expected_environment = "test" if expected_target_taxon_id == SYNTHETIC_TARGET_TAXON_ID else "production"
    if expected_environment == "production" and environments != {"complete-effort-segment"}:
        raise ValueError("production model observations must be complete-effort-segment records")
    if expected_environment == "test" and environments != {"synthetic-fixture"}:
        raise ValueError("synthetic target observations must be synthetic-fixture records")
    if not is_model_eligible_target(expected_target_taxon_id, environment=expected_environment):
        raise ValueError(f"target {expected_target_taxon_id!r} is not model eligible")

    def true_values(series: pd.Series, *, field: str) -> pd.Series:
        normalized = series.astype(str).str.strip().str.lower()
        if not normalized.isin({"true", "false", "1", "0"}).all():
            raise ValueError(f"{field} contains an invalid serialized boolean")
        return normalized.isin({"true", "1"})

    if not true_values(frame["source_complete_attempt"], field="source_complete_attempt").all():
        raise ValueError("catch-only rows cannot enter modeling")
    if true_values(frame["source_expanded_estimate"], field="source_expanded_estimate").any():
        raise ValueError("expanded estimates cannot enter modeling")

    structured_target_counts: list[int] = []
    structured_any_counts: list[int] = []
    for row_index, row in frame.iterrows():
        try:
            raw_taxa = json.loads(str(row["taxon_observations_json"]))
        except json.JSONDecodeError as exc:
            raise ValueError(f"row {row_index} has invalid taxon_observations_json") from exc
        if not isinstance(raw_taxa, list) or not raw_taxa or not all(isinstance(item, dict) for item in raw_taxa):
            raise ValueError(f"row {row_index} taxon_observations_json must be a nonempty object array")
        normalized_taxa = [
            _validate_taxon_observation(
                item,
                data_kind=str(row["source_data_kind"]),
                location=f"row[{row_index}].taxon_observations[{taxon_index}]",
            )
            for taxon_index, item in enumerate(raw_taxa)
        ]
        taxon_ids = [item["taxon_id"] for item in normalized_taxa]
        if len(taxon_ids) != len(set(taxon_ids)):
            raise ValueError(f"row {row_index} has duplicate taxon observations")
        target_rows = [item for item in normalized_taxa if item["taxon_id"] == expected_target_taxon_id]
        if len(target_rows) != 1:
            raise ValueError(f"row {row_index} must contain exactly one primary-target taxon row")
        structured_target_counts.append(int(target_rows[0]["encounter_count"]))
        structured_any_counts.append(sum(int(item["encounter_count"]) for item in normalized_taxa))

    for column in (
        "x",
        "y",
        "occurrence",
        "cpue",
        "sample_weight",
        "effort_hours",
        "target_encounter_count",
        "any_fish_encounter_count",
    ):
        frame[column] = pd.to_numeric(frame[column], errors="raise")
    numeric = frame[
        [
            "occurrence",
            "cpue",
            "sample_weight",
            "effort_hours",
            "target_encounter_count",
            "any_fish_encounter_count",
        ]
    ].to_numpy(dtype=float)
    if not np.isfinite(numeric).all():
        raise ValueError("model observation labels and effort must be finite")
    if not np.allclose(frame["sample_weight"].to_numpy(dtype=float), 1.0):
        raise ValueError("sample_weight must remain 1.0; expanded survey weights are prohibited")
    if (frame["effort_hours"] <= 0).any():
        raise ValueError("target effort must be positive")
    if not set(frame["target_effort_unit"].astype(str)) <= {"trip-hours", "angler-hours", "rod-hours"}:
        raise ValueError("target effort unit is invalid")
    for column in ("target_encounter_count", "any_fish_encounter_count"):
        values = frame[column].to_numpy(dtype=float)
        if (values < 0).any() or not np.equal(values, np.floor(values)).all():
            raise ValueError(f"{column} must contain nonnegative integer counts")
    target_counts = frame["target_encounter_count"].to_numpy(dtype=int)
    any_counts = frame["any_fish_encounter_count"].to_numpy(dtype=int)
    if not np.array_equal(target_counts, np.asarray(structured_target_counts, dtype=int)):
        raise ValueError("target encounter count disagrees with taxon_observations_json")
    if not np.array_equal(any_counts, np.asarray(structured_any_counts, dtype=int)):
        raise ValueError("all-fish encounter count disagrees with taxon_observations_json")
    if (target_counts > any_counts).any():
        raise ValueError("target encounter count cannot exceed all-fish encounter count")
    derived_outcome = np.where(
        target_counts > 0,
        "target_encountered",
        np.where(any_counts > 0, "non_target_only", "no_fish"),
    )
    if not np.array_equal(derived_outcome, frame["outcome_class"].astype(str).to_numpy()):
        raise ValueError("outcome_class disagrees with target and all-fish encounter counts")
    if not np.array_equal((target_counts > 0).astype(int), frame["occurrence"].to_numpy(dtype=int)):
        raise ValueError("occurrence label disagrees with target encounter count")
    expected_cpue = target_counts / frame["effort_hours"].to_numpy(dtype=float)
    if not np.allclose(expected_cpue, frame["cpue"].to_numpy(dtype=float)):
        raise ValueError("cpue disagrees with target encounters and target effort")

    starts = pd.DatetimeIndex(
        [_aware_timestamp(value, location=f"row[{index}].observed_at") for index, value in frame["observed_at"].items()]
    )
    ends = pd.DatetimeIndex(
        [_aware_timestamp(value, location=f"row[{index}].observed_end_at") for index, value in frame["observed_end_at"].items()]
    )
    if (ends <= starts).any():
        raise ValueError("observation end times must be after start times")
    if set(frame["temporal_precision"].astype(str)) - {"exact", "bounded"}:
        raise ValueError("temporal_precision is invalid")
    eligible = true_values(frame["terrain_model_eligible"], field="terrain_model_eligible")
    if (eligible & (frame["temporal_precision"].astype(str) != "exact")).any():
        raise ValueError("bounded temporal support cannot be terrain-model eligible")
    if (eligible & (frame["spatial_support_kind"].astype(str) != "point")).any():
        raise ValueError("only point spatial support can be terrain-model eligible")
    frame = frame.loc[eligible].copy()
    if frame.empty:
        raise ValueError("no point-resolution observations are eligible for terrain modeling")
    if not np.isfinite(frame[["x", "y"]].to_numpy(dtype=float)).all():
        raise ValueError("terrain-model observations require finite point coordinates")
    if expected_crs not in MODEL_PROJECTED_CRS_IDS:
        raise GridValidationError(
            f"expected CRS must exactly match an approved model CRS: {list(MODEL_PROJECTED_CRS_IDS)}"
        )
    if not frame["crs"].map(
        lambda value: isinstance(value, str) and value == expected_crs
    ).all():
        crs_values = sorted({repr(value) for value in frame["crs"].tolist()})
        raise GridValidationError(
            f"every eligible observation CRS must exactly match {expected_crs!r}; got {crs_values}"
        )
    verify_projected_crs(expected_crs)
    return frame
