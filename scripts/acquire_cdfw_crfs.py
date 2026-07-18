#!/usr/bin/env python3
"""Acquire pinned public CDFW CRFS aggregate layers with fail-closed receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "pipeline" / "sources"
ALLOWED_ORIGIN = ("https", "services2.arcgis.com")
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
DEFAULT_PAGE_SIZE = 500
BLOCK_BOX_RE = re.compile(r"^[0-9]+-[0-9]+$")
BINNED_CPUA_FIELDS = {
    "All_04_09",
    "All_10_15",
    "All_16_20",
    "All_21_24",
    "Kept_04_09",
    "Kept_10_15",
    "Kept_16_20",
    "Kept_21_24",
}
NONNEGATIVE_NUMERIC_FIELDS = {
    "CPUA_Kept",
    "CPUA_All",
    "Shape__Area",
    "Shape__Length",
}


class AcquisitionError(RuntimeError):
    """Raised when an official source no longer matches its reviewed contract."""


def _canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode(
        "utf-8"
    )


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _read_bounded(response: Any, maximum: int = MAX_RESPONSE_BYTES) -> bytes:
    payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise AcquisitionError(f"official response exceeded {maximum} bytes")
    return payload


def _read_file_bounded(path: Path, maximum: int = MAX_RESPONSE_BYTES) -> bytes:
    try:
        if path.stat().st_size > maximum:
            raise AcquisitionError(f"offline acquisition input exceeded {maximum} bytes: {path.name}")
        payload = path.read_bytes()
    except OSError as error:
        raise AcquisitionError(f"offline acquisition input is unreadable: {path.name}") from error
    if len(payload) > maximum:
        raise AcquisitionError(f"offline acquisition input exceeded {maximum} bytes: {path.name}")
    return payload


def _fetch_json(url: str, *, timeout: float = 30.0) -> Mapping[str, Any]:
    parsed = urlparse(url)
    if (parsed.scheme, parsed.hostname) != ALLOWED_ORIGIN:
        raise AcquisitionError("official acquisition URL left the reviewed HTTPS origin")
    request = Request(
        url,
        headers={"Accept": "application/json, application/geo+json", "User-Agent": "CastingCompass-official-data/1.0"},
    )
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - exact origin is checked above and below.
        final = urlparse(response.geturl())
        if (final.scheme, final.hostname) != ALLOWED_ORIGIN:
            raise AcquisitionError("official acquisition redirected away from the reviewed HTTPS origin")
        payload = _read_bounded(response)
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AcquisitionError("official source returned unreadable JSON") from error
    if not isinstance(decoded, dict):
        raise AcquisitionError("official source returned a non-object JSON envelope")
    if "error" in decoded:
        raise AcquisitionError("official ArcGIS service returned an error envelope")
    return decoded


def _query_url(service_url: str, params: Mapping[str, object]) -> str:
    return f"{service_url}/query?{urlencode(params)}"


def load_manifest(dataset_id: str) -> tuple[Path, Mapping[str, Any]]:
    matches: list[tuple[Path, Mapping[str, Any]]] = []
    for path in sorted(SOURCE_DIR.glob("cdfw_crfs_ds*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("dataset_id") == dataset_id:
            matches.append((path, payload))
    if len(matches) != 1:
        raise AcquisitionError(f"expected one reviewed manifest for {dataset_id!r}, found {len(matches)}")
    path, manifest = matches[0]
    validate_manifest(manifest)
    return path, manifest


def validate_manifest(manifest: Mapping[str, Any]) -> None:
    required = {
        "manifest_version",
        "source_id",
        "dataset_id",
        "title",
        "steward",
        "official_landing_page",
        "license",
        "access",
        "source_version",
        "sampling_design",
        "denominator",
        "spatial_support",
        "temporal_support",
        "field_semantics",
        "permitted_uses",
        "limitations",
    }
    missing = required - set(manifest)
    if missing:
        raise AcquisitionError(f"source manifest is missing {sorted(missing)}")
    dataset_id = manifest["dataset_id"]
    if dataset_id not in {"ds3185", "ds3186"}:
        raise AcquisitionError("only reviewed CDFW datasets ds3185 and ds3186 are supported")
    access = manifest["access"]
    if not isinstance(access, dict) or access.get("mode") != "official_arcgis_snapshot":
        raise AcquisitionError("CDFW aggregate access mode must be official_arcgis_snapshot")
    service_url = access.get("service_url")
    if not isinstance(service_url, str):
        raise AcquisitionError("CDFW service URL is missing")
    parsed = urlparse(service_url)
    expected_path = f"/Uq9r85Potqm3MfRV/arcgis/rest/services/bios{dataset_id}_fpu/FeatureServer/0"
    if (parsed.scheme, parsed.hostname, parsed.path) != (*ALLOWED_ORIGIN, expected_path):
        raise AcquisitionError("CDFW service URL does not match the reviewed layer")
    if parsed.query or parsed.fragment:
        raise AcquisitionError("CDFW service URL must not contain query or fragment data")
    expected_fields = access.get("expected_fields")
    if not isinstance(expected_fields, list) or not expected_fields:
        raise AcquisitionError("CDFW expected field dictionary is missing")
    names = [field.get("name") for field in expected_fields if isinstance(field, dict)]
    if len(names) != len(expected_fields) or len(set(names)) != len(names) or names[0] != "OBJECTID":
        raise AcquisitionError("CDFW expected fields must be unique and begin with OBJECTID")
    uses = manifest["permitted_uses"]
    if not isinstance(uses, dict) or uses.get("descriptive_context") is not True:
        raise AcquisitionError("CDFW aggregate manifest must permit descriptive context")
    for forbidden in ("model_training", "model_validation", "production_scoring", "point_labels"):
        if uses.get(forbidden) is not False:
            raise AcquisitionError(f"CDFW aggregate manifest must explicitly disable {forbidden}")


def _field_contract(fields: Sequence[Mapping[str, Any]]) -> list[dict[str, object]]:
    return [
        {"name": field.get("name"), "type": field.get("type"), "nullable": field.get("nullable")}
        for field in fields
    ]


def validate_layer_metadata(metadata: Mapping[str, Any], manifest: Mapping[str, Any]) -> None:
    access = manifest["access"]
    revision = manifest["source_version"]["service_revision"]
    checks = {
        "name": (metadata.get("name"), access["expected_layer_name"]),
        "geometryType": (metadata.get("geometryType"), "esriGeometryPolygon"),
        "objectIdField": (metadata.get("objectIdField"), "OBJECTID"),
        "copyrightText": (metadata.get("copyrightText"), access["expected_copyright"]),
        "maxRecordCount": (metadata.get("maxRecordCount"), access["expected_max_record_count"]),
    }
    for label, (actual, expected) in checks.items():
        if actual != expected:
            raise AcquisitionError(f"CDFW {label} changed: expected {expected!r}, got {actual!r}")
    spatial_reference = metadata.get("extent", {}).get("spatialReference", {})
    if spatial_reference.get("latestWkid", spatial_reference.get("wkid")) != 3857:
        raise AcquisitionError("CDFW layer is no longer published in the reviewed EPSG:3857 service CRS")
    if _field_contract(metadata.get("fields", [])) != access["expected_fields"]:
        raise AcquisitionError("CDFW layer field dictionary changed")
    editing = metadata.get("editingInfo", {})
    for field in ("lastEditDate", "schemaLastEditDate", "dataLastEditDate"):
        if editing.get(field) != revision[field]:
            raise AcquisitionError(f"CDFW service revision {field} changed")


def _fetch_object_ids(service_url: str) -> list[int]:
    payload = _fetch_json(
        _query_url(service_url, {"where": "1=1", "returnIdsOnly": "true", "f": "json"})
    )
    if payload.get("objectIdFieldName") != "OBJECTID":
        raise AcquisitionError("CDFW object ID response changed")
    object_ids = payload.get("objectIds")
    if not isinstance(object_ids, list) or not all(
        isinstance(value, int) and not isinstance(value, bool) for value in object_ids
    ):
        raise AcquisitionError("CDFW object ID response is incomplete")
    ordered = sorted(object_ids)
    if len(set(ordered)) != len(ordered):
        raise AcquisitionError("CDFW object ID response contains duplicates")
    return ordered


def _validate_position(position: object) -> None:
    if not isinstance(position, list) or len(position) != 2:
        raise AcquisitionError("CDFW geometry position is not a two-dimensional coordinate")
    longitude, latitude = position
    if any(
        isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
        for value in position
    ):
        raise AcquisitionError("CDFW geometry contains a non-finite coordinate")
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise AcquisitionError("CDFW geometry is outside reviewed EPSG:4326 bounds")


def _validate_ring(ring: object) -> None:
    if not isinstance(ring, list) or len(ring) < 4:
        raise AcquisitionError("CDFW polygon ring is incomplete")
    for position in ring:
        _validate_position(position)
    if ring[0] != ring[-1]:
        raise AcquisitionError("CDFW polygon ring is not closed")


def _validate_geometry(geometry: Mapping[str, Any]) -> None:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates:
        raise AcquisitionError("CDFW feature has empty geometry")
    if geometry_type == "Polygon":
        for ring in coordinates:
            _validate_ring(ring)
        return
    if geometry_type == "MultiPolygon":
        for polygon in coordinates:
            if not isinstance(polygon, list) or not polygon:
                raise AcquisitionError("CDFW multipolygon contains an empty polygon")
            for ring in polygon:
                _validate_ring(ring)
        return
    raise AcquisitionError("CDFW feature has unexpected geometry type")


def validate_feature(feature: Mapping[str, Any], manifest: Mapping[str, Any]) -> int:
    if feature.get("type") != "Feature":
        raise AcquisitionError("CDFW result contains a non-Feature entry")
    geometry = feature.get("geometry")
    if not isinstance(geometry, dict):
        raise AcquisitionError("CDFW feature has missing geometry")
    _validate_geometry(geometry)
    properties = feature.get("properties")
    if not isinstance(properties, dict):
        raise AcquisitionError("CDFW feature properties are missing")
    expected_names = [field["name"] for field in manifest["access"]["expected_fields"]]
    if set(properties) != set(expected_names):
        raise AcquisitionError("CDFW feature properties no longer match the reviewed dictionary")
    object_id = properties.get("OBJECTID")
    if isinstance(object_id, bool) or not isinstance(object_id, int) or feature.get("id") != object_id:
        raise AcquisitionError("CDFW feature identity is not bound to OBJECTID")
    if properties.get("Catch") != manifest["sampling_design"]["catch_label"]:
        raise AcquisitionError("CDFW aggregate catch label changed")
    if properties.get("Trip") != manifest["sampling_design"]["trip_label"]:
        raise AcquisitionError("CDFW aggregate trip label changed")
    block_box = properties.get("BlockBox")
    if not isinstance(block_box, str) or not BLOCK_BOX_RE.fullmatch(block_box):
        raise AcquisitionError("CDFW BlockBox is missing or malformed")
    samples = properties.get("Samples")
    if not isinstance(samples, int) or isinstance(samples, bool) or samples < 3:
        raise AcquisitionError("CDFW aggregate violates the published three-trip release floor")
    missing_sentinel = manifest["field_semantics"]["missing_binned_cpua_sentinel"]
    for field in BINNED_CPUA_FIELDS:
        value = properties.get(field)
        if value is None:
            continue
        if value == missing_sentinel:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise AcquisitionError(f"CDFW feature has invalid non-negative numeric field {field}")
    for field in NONNEGATIVE_NUMERIC_FIELDS:
        value = properties.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise AcquisitionError(f"CDFW feature has invalid non-negative numeric field {field}")
    return object_id


def _fetch_features(
    service_url: str,
    object_ids: Sequence[int],
    manifest: Mapping[str, Any],
    *,
    page_size: int,
) -> list[Mapping[str, Any]]:
    field_names = ",".join(field["name"] for field in manifest["access"]["expected_fields"])
    features: list[Mapping[str, Any]] = []
    for offset in range(0, len(object_ids), page_size):
        page_ids = object_ids[offset : offset + page_size]
        payload = _fetch_json(
            _query_url(
                service_url,
                {
                    "objectIds": ",".join(str(value) for value in page_ids),
                    "outFields": field_names,
                    "returnGeometry": "true",
                    "outSR": "4326",
                    "orderByFields": "OBJECTID",
                    "f": "geojson",
                },
            )
        )
        page_features = payload.get("features")
        if not isinstance(page_features, list) or len(page_features) != len(page_ids):
            raise AcquisitionError("CDFW feature page was truncated or incomplete")
        returned_ids = [validate_feature(feature, manifest) for feature in page_features]
        if sorted(returned_ids) != list(page_ids):
            raise AcquisitionError("CDFW feature page returned unexpected object IDs")
        features.extend(page_features)
    features.sort(key=lambda feature: feature["properties"]["OBJECTID"])
    return features


def _load_json_file(path: Path) -> Mapping[str, Any]:
    try:
        payload = json.loads(_read_file_bounded(path))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AcquisitionError(f"offline acquisition input is unreadable: {path.name}") from error
    if not isinstance(payload, dict) or "error" in payload:
        raise AcquisitionError(f"offline acquisition input has an invalid envelope: {path.name}")
    return payload


def _load_offline_features(
    dataset_id: str,
    input_dir: Path,
    object_ids: Sequence[int],
    manifest: Mapping[str, Any],
    *,
    page_size: int,
) -> tuple[list[Mapping[str, Any]], list[Mapping[str, object]]]:
    page_paths = sorted(input_dir.glob(f"{dataset_id}.page.*.geojson"))
    expected_pages = math.ceil(len(object_ids) / page_size)
    if len(page_paths) != expected_pages:
        raise AcquisitionError(
            f"offline acquisition expected {expected_pages} pages for {dataset_id}, found {len(page_paths)}"
        )
    features: list[Mapping[str, Any]] = []
    inputs: list[Mapping[str, object]] = []
    for index, path in enumerate(page_paths):
        expected_offset = index * page_size
        expected_name = f"{dataset_id}.page.{expected_offset:05d}.geojson"
        if path.name != expected_name:
            raise AcquisitionError(f"offline page sequence changed: expected {expected_name}, got {path.name}")
        raw = _read_file_bounded(path)
        payload = _load_json_file(path)
        page_features = payload.get("features")
        page_ids = object_ids[expected_offset : expected_offset + page_size]
        if not isinstance(page_features, list) or len(page_features) != len(page_ids):
            raise AcquisitionError(f"offline CDFW page is truncated: {path.name}")
        returned_ids = [validate_feature(feature, manifest) for feature in page_features]
        if returned_ids != list(page_ids):
            raise AcquisitionError(f"offline CDFW page is not in exact OBJECTID order: {path.name}")
        transfer_limit = payload.get("properties", {}).get("exceededTransferLimit", False)
        if bool(transfer_limit) != (index < expected_pages - 1):
            raise AcquisitionError(f"offline CDFW transfer-limit marker is inconsistent: {path.name}")
        features.extend(page_features)
        inputs.append({"file": path.name, "sha256": _sha256(raw), "bytes": len(raw)})
    return features, inputs


def build_snapshot(features: Sequence[Mapping[str, Any]], source_id: str) -> Mapping[str, Any]:
    ordered = sorted(features, key=lambda feature: feature["properties"]["OBJECTID"])
    return {
        "type": "FeatureCollection",
        "name": source_id,
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": ordered,
    }


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def acquire(
    dataset_id: str,
    output_dir: Path,
    *,
    page_size: int = DEFAULT_PAGE_SIZE,
    offline_input_dir: Path | None = None,
) -> Mapping[str, Any]:
    maximum_page_size = 2000 if offline_input_dir is not None else 500
    if page_size < 1 or page_size > maximum_page_size:
        raise AcquisitionError(f"page size must be between 1 and {maximum_page_size}")
    manifest_path, manifest = load_manifest(dataset_id)
    service_url = manifest["access"]["service_url"]
    staged_inputs: list[Mapping[str, object]] = []
    if offline_input_dir is None:
        metadata_before = _fetch_json(f"{service_url}?f=json")
        object_ids = _fetch_object_ids(service_url)
    else:
        metadata_before_path = offline_input_dir / f"{dataset_id}.metadata.before.json"
        ids_before_path = offline_input_dir / f"{dataset_id}.ids.before.json"
        metadata_before = _load_json_file(metadata_before_path)
        ids_before = _load_json_file(ids_before_path)
        if ids_before.get("objectIdFieldName") != "OBJECTID":
            raise AcquisitionError("offline CDFW object ID response changed")
        raw_object_ids = ids_before.get("objectIds")
        if not isinstance(raw_object_ids, list) or not all(
            isinstance(value, int) and not isinstance(value, bool) for value in raw_object_ids
        ):
            raise AcquisitionError("offline CDFW object ID response is incomplete")
        object_ids = sorted(raw_object_ids)
        for path in (metadata_before_path, ids_before_path):
            raw = _read_file_bounded(path)
            staged_inputs.append({"file": path.name, "sha256": _sha256(raw), "bytes": len(raw)})
    validate_layer_metadata(metadata_before, manifest)
    expected_count = manifest["source_version"]["expected_feature_count"]
    if len(object_ids) != expected_count:
        raise AcquisitionError(
            f"CDFW feature count changed: expected {expected_count}, got {len(object_ids)}"
        )
    if len(set(object_ids)) != len(object_ids):
        raise AcquisitionError("CDFW object ID response contains duplicates")
    if offline_input_dir is None:
        features = _fetch_features(service_url, object_ids, manifest, page_size=page_size)
        metadata_after = _fetch_json(f"{service_url}?f=json")
        object_ids_after = _fetch_object_ids(service_url)
        pagination = f"explicit OBJECTID pages of at most {page_size}"
        acquisition_transport = "direct HTTPS FeatureServer queries"
    else:
        features, page_inputs = _load_offline_features(
            dataset_id,
            offline_input_dir,
            object_ids,
            manifest,
            page_size=page_size,
        )
        staged_inputs.extend(page_inputs)
        metadata_after_path = offline_input_dir / f"{dataset_id}.metadata.after.json"
        ids_after_path = offline_input_dir / f"{dataset_id}.ids.after.json"
        metadata_after = _load_json_file(metadata_after_path)
        ids_after = _load_json_file(ids_after_path)
        raw_object_ids_after = ids_after.get("objectIds")
        if not isinstance(raw_object_ids_after, list) or not all(
            isinstance(value, int) and not isinstance(value, bool)
            for value in raw_object_ids_after
        ):
            raise AcquisitionError("offline CDFW post-download object IDs are incomplete")
        object_ids_after = sorted(raw_object_ids_after)
        for path in (metadata_after_path, ids_after_path):
            raw = _read_file_bounded(path)
            staged_inputs.append({"file": path.name, "sha256": _sha256(raw), "bytes": len(raw)})
        pagination = f"OBJECTID-ordered resultOffset pages of at most {page_size}"
        acquisition_transport = "approved curl capture plus offline fail-closed verification"
    validate_layer_metadata(metadata_after, manifest)
    if metadata_after.get("editingInfo") != metadata_before.get("editingInfo"):
        raise AcquisitionError("CDFW layer changed during acquisition")
    if object_ids_after != object_ids:
        raise AcquisitionError("CDFW object IDs changed during acquisition")

    snapshot = build_snapshot(features, manifest["source_id"])
    snapshot_bytes = _canonical_bytes(snapshot)
    snapshot_name = f"{dataset_id}-{manifest['source_version']['service_revision']['dataLastEditDate']}.geojson"
    snapshot_path = output_dir / snapshot_name
    _atomic_write(snapshot_path, snapshot_bytes)

    manifest_bytes = manifest_path.read_bytes()
    metadata_bytes = _canonical_bytes(metadata_before)
    receipt = {
        "receipt_version": "castingcompass.official-source-snapshot/1.0.0",
        "dataset_id": dataset_id,
        "source_id": manifest["source_id"],
        "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source_manifest": {
            "path": str(manifest_path.relative_to(ROOT)),
            "sha256": _sha256(manifest_bytes),
        },
        "service": {
            "url": service_url,
            "revision": manifest["source_version"]["service_revision"],
            "metadata_sha256": _sha256(metadata_bytes),
        },
        "query": {
            "where": "1=1",
            "out_fields": [field["name"] for field in manifest["access"]["expected_fields"]],
            "return_geometry": True,
            "output_crs": "EPSG:4326",
            "ordering": "OBJECTID ascending",
            "pagination": pagination,
            "transport": acquisition_transport,
        },
        "snapshot": {
            "file": snapshot_name,
            "media_type": "application/geo+json",
            "sha256": _sha256(snapshot_bytes),
            "bytes": len(snapshot_bytes),
            "feature_count": len(features),
            "object_id_min": object_ids[0],
            "object_id_max": object_ids[-1],
        },
        "license": manifest["license"],
        "attribution": manifest["attribution"],
        "dataset_version": manifest["source_version"]["dataset_version"],
        "sampling_design": manifest["sampling_design"],
        "denominator": manifest["denominator"],
        "spatial_support": manifest["spatial_support"],
        "temporal_support": manifest["temporal_support"],
        "field_semantics": manifest["field_semantics"],
        "permitted_uses": manifest["permitted_uses"],
        "verification": {
            "exact_origin": True,
            "layer_identity": True,
            "service_revision": True,
            "field_dictionary": True,
            "feature_identity": True,
            "published_aggregation_labels": True,
            "three_trip_release_floor": True,
            "pre_and_post_revision_match": True,
            "pre_and_post_object_ids_match": True,
        },
    }
    if staged_inputs:
        receipt["staged_inputs"] = staged_inputs
    receipt_bytes = _canonical_bytes(receipt)
    _atomic_write(output_dir / f"{dataset_id}.receipt.json", receipt_bytes)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=("ds3185", "ds3186"), action="append", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    parser.add_argument(
        "--offline-input-dir",
        type=Path,
        help="Verify pre-captured official metadata, ID, and GeoJSON page files without network access.",
    )
    arguments = parser.parse_args()
    summaries = [
        acquire(
            dataset_id,
            arguments.output_dir,
            page_size=arguments.page_size,
            offline_input_dir=arguments.offline_input_dir,
        )
        for dataset_id in dict.fromkeys(arguments.dataset)
    ]
    print(
        json.dumps(
            [
                {
                    "dataset_id": receipt["dataset_id"],
                    "feature_count": receipt["snapshot"]["feature_count"],
                    "snapshot_sha256": receipt["snapshot"]["sha256"],
                    "receipt": f"{receipt['dataset_id']}.receipt.json",
                }
                for receipt in summaries
            ],
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
