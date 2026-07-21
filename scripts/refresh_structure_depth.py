#!/usr/bin/env python3
"""Build source-bound California structure/depth planning evidence.

The collector deliberately does not edit site metadata or opportunity scores.
It captures a fixed NOAA ENC Direct usage band, summarizes only reviewed
feature classes, and keeps missing or malformed source data explicit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "structure-depth" / "policy.json"
SITES_PATH = ROOT / "data" / "sites.json"
DEFAULT_OUTPUT = ROOT / "public" / "data" / "structure-depth.json"
SNAPSHOT_SCHEMA = "castingcompass.noaa-enc-approach-source/1.0.0"
ARTIFACT_SCHEMA = "castingcompass.structure-depth-evidence/1.3.0"
EXPECTED_POLICY_SCHEMA = "castingcompass.structure-depth-policy/1.0.0"
USER_AGENT = "CastingCompass/0.1 (public-data planning context; contact: bzeng0000@gmail.com)"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_FEATURES = 1_000
MEAN_EARTH_RADIUS_METERS = 6_371_008.8
YEAR_PATTERN = re.compile(r"^([0-9]{4})$")
MONTH_PATTERN = re.compile(r"^([0-9]{4})([0-9]{2})$")
DATE_PATTERN = re.compile(r"^([0-9]{4})([0-9]{2})([0-9]{2})$")
SAFE_CELL_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
SAFE_TAG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

FEATURE_LABELS = {
    "charted-obstruction": "Charted obstruction",
    "charted-wreck": "Charted wreck",
    "charted-pile": "Charted pile or piling",
    "charted-seabed-description": "Charted seabed description",
    "charted-shoreline-construction": "Charted shoreline construction",
    "charted-dredged-area": "Charted dredged area",
    "charted-vegetation": "Charted vegetation area",
}


class StructureDepthError(RuntimeError):
    """Sanitized collector error safe to record as a bounded category."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> None:
        del request, file_pointer, code, message, headers, new_url
        return None


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_path(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def write_atomic(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(body)
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)


def parse_as_of(raw: str | None) -> datetime:
    if raw is None:
        return datetime.now(timezone.utc)
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise StructureDepthError("invalid-as-of") from exc
    if value.tzinfo is None:
        raise StructureDepthError("as-of-missing-offset")
    return value.astimezone(timezone.utc)


def iso_datetime(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def require_number(value: Any, category: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise StructureDepthError(category)
    return float(value)


def load_inputs() -> tuple[dict[str, Any], list[dict[str, Any]], bytes, bytes]:
    policy_bytes = POLICY_PATH.read_bytes()
    site_bytes = SITES_PATH.read_bytes()
    try:
        policy = json.loads(policy_bytes)
        sites = json.loads(site_bytes)
    except json.JSONDecodeError as exc:
        raise StructureDepthError("invalid-local-json") from exc
    if policy.get("schema_version") != EXPECTED_POLICY_SCHEMA:
        raise StructureDepthError("unsupported-policy-schema")
    if policy.get("score_contribution") != "excluded-pending-site-review-and-validation":
        raise StructureDepthError("unsafe-score-contribution")
    if policy.get("catalog_mutation") != "forbidden":
        raise StructureDepthError("unsafe-catalog-mutation-policy")
    if not isinstance(sites, list):
        raise StructureDepthError("invalid-site-catalog")
    site_by_id = {site.get("id"): site for site in sites if isinstance(site, dict)}
    expected_ids = policy.get("covered_site_ids")
    if (
        not isinstance(expected_ids, list)
        or len(expected_ids) != 41
        or len(set(expected_ids)) != 41
        or any(not isinstance(site_id, str) or not SAFE_TAG_PATTERN.fullmatch(site_id) for site_id in expected_ids)
        or any(site_id not in site_by_id for site_id in expected_ids)
    ):
        raise StructureDepthError("invalid-covered-site-set")
    source = policy.get("source")
    if not isinstance(source, dict) or source.get("source_id") != "noaa-enc-direct-approach":
        raise StructureDepthError("invalid-source-policy")
    expected_url = "https://encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_approach/MapServer"
    if source.get("service_url") != expected_url or source.get("usage_band") != "Approach":
        raise StructureDepthError("untrusted-source-configuration")
    layers = source.get("layers")
    if not isinstance(layers, dict) or set(layers) != {
        "soundings",
        "depthContours",
        "depthAreas",
        "obstructionPoints",
        "wreckPoints",
        "pilePoints",
        "seabedPoints",
        "shorelineConstructionPoints",
        "shorelineConstructionLines",
        "shorelineConstructionAreas",
        "seabedAreas",
        "dredgedAreas",
        "vegetationAreas",
    }:
        raise StructureDepthError("invalid-layer-set")
    layer_ids: set[int] = set()
    for layer_key, layer in layers.items():
        if not isinstance(layer, dict):
            raise StructureDepthError("invalid-layer-policy")
        layer_id = layer.get("id")
        fields = layer.get("fields")
        scope = layer.get("query_scope")
        if (
            not isinstance(layer_id, int)
            or layer_id in layer_ids
            or not isinstance(layer.get("name"), str)
            or scope not in {"sector", "sector-and-context", "context"}
            or not isinstance(fields, list)
            or not fields
            or len(set(fields)) != len(fields)
            or any(not isinstance(field, str) or not re.fullmatch(r"[A-Z0-9.]+", field) for field in fields)
        ):
            raise StructureDepthError("invalid-layer-policy")
        layer_ids.add(layer_id)
        category = layer.get("category")
        if layer_key not in {"soundings", "depthContours", "depthAreas"} and category not in FEATURE_LABELS:
            raise StructureDepthError("invalid-layer-category")
    selected: list[dict[str, Any]] = []
    for site_id in expected_ids:
        site = site_by_id[site_id]
        zone = site.get("castingZone")
        latitude = require_number(site.get("latitude"), "invalid-site-coordinate")
        longitude = require_number(site.get("longitude"), "invalid-site-coordinate")
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise StructureDepthError("invalid-site-coordinate")
        if not isinstance(site.get("name"), str) or not isinstance(zone, dict):
            raise StructureDepthError("invalid-site-planning-zone")
        radius = zone.get("radiusMeters")
        bearing = zone.get("bearingDegrees")
        tags = site.get("structureTags")
        if (
            not isinstance(radius, int)
            or not 50 <= radius <= 2_000
            or isinstance(bearing, bool)
            or not isinstance(bearing, (int, float))
            or not 0 <= bearing < 360
            or not isinstance(tags, list)
            or not tags
            or any(not isinstance(tag, str) or not SAFE_TAG_PATTERN.fullmatch(tag) for tag in tags)
        ):
            raise StructureDepthError("invalid-site-planning-zone")
        selected.append(site)
    geometry = policy.get("geometry")
    if (
        not isinstance(geometry, dict)
        or geometry.get("sector_half_width_degrees") != 45
        or geometry.get("context_radius_meters") != 1000
        or geometry.get("horizontal_crs") != "EPSG:4326"
    ):
        raise StructureDepthError("invalid-geometry-policy")
    return policy, selected, policy_bytes, site_bytes


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    opener = urllib.request.build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=20) as response:
            if response.geturl() != url:
                raise StructureDepthError("unexpected-source-redirect")
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_RESPONSE_BYTES:
                raise StructureDepthError("source-response-too-large")
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except StructureDepthError:
        raise
    except Exception as exc:
        raise StructureDepthError("source-request-failed") from exc
    if len(body) > MAX_RESPONSE_BYTES:
        raise StructureDepthError("source-response-too-large")
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise StructureDepthError("invalid-source-json") from exc
    if not isinstance(parsed, dict):
        raise StructureDepthError("invalid-source-payload")
    return parsed


def destination(latitude: float, longitude: float, bearing: float, distance: float) -> list[float]:
    angular_distance = distance / MEAN_EARTH_RADIUS_METERS
    latitude_1 = math.radians(latitude)
    longitude_1 = math.radians(longitude)
    theta = math.radians(bearing)
    latitude_2 = math.asin(
        math.sin(latitude_1) * math.cos(angular_distance)
        + math.cos(latitude_1) * math.sin(angular_distance) * math.cos(theta)
    )
    longitude_2 = longitude_1 + math.atan2(
        math.sin(theta) * math.sin(angular_distance) * math.cos(latitude_1),
        math.cos(angular_distance) - math.sin(latitude_1) * math.sin(latitude_2),
    )
    return [round(math.degrees(longitude_2), 7), round(math.degrees(latitude_2), 7)]


def sector_geometry(site: dict[str, Any], half_width: float) -> dict[str, Any]:
    zone = site["castingZone"]
    origin = [site["longitude"], site["latitude"]]
    ring = [origin]
    for offset in range(-int(half_width), int(half_width) + 1, 5):
        ring.append(
            destination(
                site["latitude"],
                site["longitude"],
                zone["bearingDegrees"] + offset,
                zone["radiusMeters"],
            )
        )
    ring.append(origin)
    return {"rings": [ring], "spatialReference": {"wkid": 4326}}


def query_url(
    service_url: str,
    layer: dict[str, Any],
    site: dict[str, Any],
    scope: str,
    half_width: float,
    context_radius: int,
) -> str:
    parameters: dict[str, str] = {
        "where": "1=1",
        "inSR": "4326",
        "outSR": "4326",
        "outFields": ",".join(layer["fields"]),
        "returnGeometry": "true",
        "returnZ": "true",
        "f": "json",
    }
    if scope == "sector":
        parameters.update(
            {
                "geometry": json.dumps(sector_geometry(site, half_width), separators=(",", ":")),
                "geometryType": "esriGeometryPolygon",
                "spatialRel": "esriSpatialRelIntersects",
            }
        )
    elif scope == "context":
        parameters.update(
            {
                "geometry": f"{site['longitude']},{site['latitude']}",
                "geometryType": "esriGeometryPoint",
                "distance": str(context_radius),
                "units": "esriSRUnit_Meter",
                "spatialRel": "esriSpatialRelIntersects",
            }
        )
    else:
        raise StructureDepthError("invalid-query-scope")
    return f"{service_url}/{layer['id']}/query?{urllib.parse.urlencode(parameters)}"


def clean_scalar(value: Any) -> str | int | float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise StructureDepthError("invalid-source-attribute")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise StructureDepthError("invalid-source-attribute")
        return round(value, 7)
    if isinstance(value, str):
        cleaned = " ".join(value.split())
        if len(cleaned) > 500:
            raise StructureDepthError("source-attribute-too-long")
        return cleaned
    raise StructureDepthError("invalid-source-attribute")


def normalize_feature(feature: Any, allowed_fields: set[str], preserve_point: bool) -> dict[str, Any]:
    if not isinstance(feature, dict) or not isinstance(feature.get("attributes"), dict):
        raise StructureDepthError("invalid-source-feature")
    attributes = feature["attributes"]
    if set(attributes) - allowed_fields:
        raise StructureDepthError("unexpected-source-field")
    normalized: dict[str, Any] = {
        "attributes": {key: clean_scalar(attributes.get(key)) for key in sorted(allowed_fields)}
    }
    geometry = feature.get("geometry")
    if geometry is None or not isinstance(geometry, dict):
        raise StructureDepthError("missing-source-geometry")
    if preserve_point:
        x = require_number(geometry.get("x"), "invalid-source-geometry")
        y = require_number(geometry.get("y"), "invalid-source-geometry")
        if not (-180 <= x <= 180 and -90 <= y <= 90):
            raise StructureDepthError("invalid-source-geometry")
        normalized["point"] = [round(x, 7), round(y, 7)]
    else:
        normalized["geometrySha256"] = sha256_bytes(
            json.dumps(geometry, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
    return normalized


def capture_query(
    service_url: str,
    layer_key: str,
    layer: dict[str, Any],
    site: dict[str, Any],
    scope: str,
    half_width: float,
    context_radius: int,
) -> dict[str, Any]:
    try:
        payload = fetch_json(query_url(service_url, layer, site, scope, half_width, context_radius))
        if "error" in payload:
            raise StructureDepthError("source-service-error")
        features = payload.get("features")
        if not isinstance(features, list) or len(features) > MAX_FEATURES:
            raise StructureDepthError("invalid-source-feature-set")
        if payload.get("exceededTransferLimit") is True:
            raise StructureDepthError("source-feature-limit-exceeded")
        preserve_point = layer_key == "soundings"
        normalized = [
            normalize_feature(feature, set(layer["fields"]), preserve_point)
            for feature in features
        ]
        normalized.sort(key=lambda feature: json.dumps(feature, sort_keys=True, separators=(",", ":")))
        return {
            "layerKey": layer_key,
            "layerId": layer["id"],
            "scope": scope,
            "errorCategory": None,
            "features": normalized,
        }
    except StructureDepthError as exc:
        return {
            "layerKey": layer_key,
            "layerId": layer["id"],
            "scope": scope,
            "errorCategory": str(exc),
            "features": [],
        }


def capture_snapshot(policy: dict[str, Any], sites: list[dict[str, Any]], captured_at: str) -> dict[str, Any]:
    source = policy["source"]
    geometry = policy["geometry"]
    service_error: str | None = None
    service_metadata: dict[str, Any] = {}
    try:
        metadata_url = f"{source['service_url']}?{urllib.parse.urlencode({'f': 'json'})}"
        metadata = fetch_json(metadata_url)
        if "error" in metadata or not isinstance(metadata.get("layers"), list):
            raise StructureDepthError("invalid-service-metadata")
        advertised = {
            layer.get("id"): layer.get("name")
            for layer in metadata["layers"]
            if isinstance(layer, dict)
        }
        for layer in source["layers"].values():
            if advertised.get(layer["id"]) != layer["name"]:
                raise StructureDepthError("source-layer-drift")
        service_metadata = {
            "currentVersion": clean_scalar(metadata.get("currentVersion")),
            "mapName": clean_scalar(metadata.get("mapName")),
            "targetLayers": [
                {"id": layer["id"], "name": layer["name"]}
                for layer in sorted(source["layers"].values(), key=lambda value: value["id"])
            ],
        }
    except StructureDepthError as exc:
        service_error = str(exc)

    captured_sites: dict[str, Any] = {}
    for site in sites:
        queries: dict[str, Any] = {}
        if service_error is None:
            for layer_key, layer in source["layers"].items():
                scopes = ["sector", "context"] if layer["query_scope"] == "sector-and-context" else [layer["query_scope"]]
                for scope in scopes:
                    query_key = f"{layer_key}:{scope}"
                    queries[query_key] = capture_query(
                        source["service_url"],
                        layer_key,
                        layer,
                        site,
                        scope,
                        geometry["sector_half_width_degrees"],
                        geometry["context_radius_meters"],
                    )
        captured_sites[site["id"]] = {"queries": queries}
    return {
        "schemaVersion": SNAPSHOT_SCHEMA,
        "capturedAt": captured_at,
        "serviceUrl": source["service_url"],
        "usageBand": source["usage_band"],
        "serviceErrorCategory": service_error,
        "serviceMetadata": service_metadata,
        "sites": captured_sites,
    }


def validate_snapshot(snapshot: Any, policy: dict[str, Any], sites: list[dict[str, Any]]) -> None:
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != SNAPSHOT_SCHEMA:
        raise StructureDepthError("invalid-source-snapshot")
    source = policy["source"]
    if snapshot.get("serviceUrl") != source["service_url"] or snapshot.get("usageBand") != "Approach":
        raise StructureDepthError("untrusted-source-snapshot")
    try:
        captured_at = datetime.fromisoformat(str(snapshot.get("capturedAt", "")).replace("Z", "+00:00"))
    except ValueError as exc:
        raise StructureDepthError("invalid-source-capture-time") from exc
    if captured_at.tzinfo is None:
        raise StructureDepthError("invalid-source-capture-time")
    if snapshot.get("serviceErrorCategory") is not None and not isinstance(snapshot.get("serviceErrorCategory"), str):
        raise StructureDepthError("invalid-source-error-category")
    snapshot_sites = snapshot.get("sites")
    expected_ids = {site["id"] for site in sites}
    if not isinstance(snapshot_sites, dict) or set(snapshot_sites) != expected_ids:
        raise StructureDepthError("invalid-source-site-set")
    expected_queries: dict[str, tuple[str, dict[str, Any], str]] = {}
    for layer_key, layer in source["layers"].items():
        scopes = ["sector", "context"] if layer["query_scope"] == "sector-and-context" else [layer["query_scope"]]
        for scope in scopes:
            expected_queries[f"{layer_key}:{scope}"] = (layer_key, layer, scope)
    for site_id, site_snapshot in snapshot_sites.items():
        if not isinstance(site_snapshot, dict) or not isinstance(site_snapshot.get("queries"), dict):
            raise StructureDepthError("invalid-source-site-snapshot")
        queries = site_snapshot["queries"]
        if snapshot.get("serviceErrorCategory") is not None:
            if queries:
                raise StructureDepthError("invalid-failed-source-snapshot")
            continue
        if set(queries) != set(expected_queries):
            raise StructureDepthError("invalid-source-query-set")
        for query_key, query in queries.items():
            layer_key, layer, scope = expected_queries[query_key]
            if (
                not isinstance(query, dict)
                or query.get("layerKey") != layer_key
                or query.get("layerId") != layer["id"]
                or query.get("scope") != scope
                or not isinstance(query.get("features"), list)
                or len(query["features"]) > MAX_FEATURES
                or (query.get("errorCategory") is not None and not isinstance(query.get("errorCategory"), str))
            ):
                raise StructureDepthError("invalid-source-query")
            if query.get("errorCategory") is not None and query["features"]:
                raise StructureDepthError("invalid-source-query")
            for feature in query["features"]:
                if not isinstance(feature, dict) or set(feature) not in ({"attributes", "point"}, {"attributes", "geometrySha256"}):
                    raise StructureDepthError("invalid-source-feature")
                attributes = feature.get("attributes")
                if not isinstance(attributes, dict) or set(attributes) != set(layer["fields"]):
                    raise StructureDepthError("invalid-source-feature")
                for value in attributes.values():
                    clean_scalar(value)
                if layer_key == "soundings":
                    point = feature.get("point")
                    if (
                        not isinstance(point, list)
                        or len(point) != 2
                        or not -180 <= require_number(point[0], "invalid-source-geometry") <= 180
                        or not -90 <= require_number(point[1], "invalid-source-geometry") <= 90
                    ):
                        raise StructureDepthError("invalid-source-geometry")
                elif not isinstance(feature.get("geometrySha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", feature["geometrySha256"]):
                    raise StructureDepthError("invalid-source-geometry")


def date_value(raw: Any) -> tuple[str | None, str | None, bool]:
    if raw is None or raw == "":
        return None, None, True
    if not isinstance(raw, str):
        raise StructureDepthError("invalid-source-date")
    year_match = YEAR_PATTERN.fullmatch(raw)
    if year_match is not None:
        try:
            datetime(int(year_match[1]), 1, 1, tzinfo=timezone.utc)
        except ValueError as exc:
            raise StructureDepthError("invalid-source-date") from exc
        return None, raw, False
    month_match = MONTH_PATTERN.fullmatch(raw)
    if month_match is not None:
        try:
            month = datetime(int(month_match[1]), int(month_match[2]), 1, tzinfo=timezone.utc)
        except ValueError as exc:
            raise StructureDepthError("invalid-source-date") from exc
        return None, month.strftime("%Y-%m"), False
    match = DATE_PATTERN.fullmatch(raw)
    if match is None:
        raise StructureDepthError("invalid-source-date")
    try:
        return (
            datetime(int(match[1]), int(match[2]), int(match[3]), tzinfo=timezone.utc).date().isoformat(),
            None,
            False,
        )
    except ValueError as exc:
        raise StructureDepthError("invalid-source-date") from exc


def source_cells(features: list[dict[str, Any]]) -> list[str]:
    values: set[str] = set()
    for feature in features:
        raw = feature["attributes"].get("DSNM")
        if raw in {None, ""}:
            continue
        if not isinstance(raw, str) or not SAFE_CELL_PATTERN.fullmatch(raw):
            raise StructureDepthError("invalid-source-cell")
        values.add(raw)
    return sorted(values)


def source_dates(features: list[dict[str, Any]]) -> tuple[list[str], list[str], bool]:
    values: set[str] = set()
    partial_values: set[str] = set()
    has_missing_dates = False
    for feature in features:
        value, partial_value, missing = date_value(feature["attributes"].get("SORDAT"))
        if value is not None:
            values.add(value)
        if partial_value is not None:
            partial_values.add(partial_value)
        has_missing_dates = has_missing_dates or missing
    return sorted(values), sorted(partial_values), has_missing_dates


def numeric_attribute(feature: dict[str, Any], key: str) -> float:
    return require_number(feature["attributes"].get(key), "invalid-source-depth")


def rounded_depth(value: float) -> float:
    if not -100 <= value <= 2_000:
        raise StructureDepthError("invalid-source-depth")
    return round(value, 1)


def haversine_distance(latitude_1: float, longitude_1: float, latitude_2: float, longitude_2: float) -> float:
    phi_1 = math.radians(latitude_1)
    phi_2 = math.radians(latitude_2)
    delta_phi = math.radians(latitude_2 - latitude_1)
    delta_lambda = math.radians(longitude_2 - longitude_1)
    value = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi_1) * math.cos(phi_2) * math.sin(delta_lambda / 2) ** 2
    )
    return 2 * MEAN_EARTH_RADIUS_METERS * math.asin(math.sqrt(value))


def get_query(site_snapshot: dict[str, Any], key: str) -> dict[str, Any]:
    query = site_snapshot["queries"].get(key)
    if not isinstance(query, dict):
        raise StructureDepthError("missing-source-query")
    return query


def derive_depth(
    site: dict[str, Any],
    site_snapshot: dict[str, Any],
    source_uncertainty_status: str,
    context_radius: int,
) -> dict[str, Any]:
    queries = [
        get_query(site_snapshot, "soundings:sector"),
        get_query(site_snapshot, "soundings:context"),
        get_query(site_snapshot, "depthContours:sector"),
        get_query(site_snapshot, "depthAreas:sector"),
    ]
    if any(query["errorCategory"] is not None for query in queries):
        return {
            "status": "source-unavailable",
            "chartedBandsMeters": [],
            "contourDepthsMeters": [],
            "sectorSoundingDepthsMeters": [],
            "contextSoundingCount": 0,
            "contextSoundingDepthRangeMeters": None,
            "nearestContextSoundingDistanceMeters": None,
            "sourceDates": [],
            "partialSourceDates": [],
            "hasUndatedRecords": False,
            "sourceCells": [],
            "uncertaintyMeters": None,
            "uncertaintyStatus": source_uncertainty_status,
            "detail": "One or more required NOAA ENC depth queries failed closed. No depth inference is published for this site.",
        }
    try:
        sector_soundings = queries[0]["features"]
        context_soundings = queries[1]["features"]
        contours = queries[2]["features"]
        areas = queries[3]["features"]
        bands = sorted(
            {
                (
                    rounded_depth(numeric_attribute(feature, "DRVAL1")),
                    rounded_depth(numeric_attribute(feature, "DRVAL2")),
                )
                for feature in areas
            }
        )
        if any(lower > upper for lower, upper in bands):
            raise StructureDepthError("invalid-source-depth-band")
        contour_depths = sorted({rounded_depth(numeric_attribute(feature, "VALDCO")) for feature in contours})
        sector_depths = sorted({rounded_depth(numeric_attribute(feature, "Z")) for feature in sector_soundings})

        deduplicated_context: dict[tuple[Any, ...], dict[str, Any]] = {}
        for feature in context_soundings:
            point = feature["point"]
            attributes = feature["attributes"]
            depth = rounded_depth(numeric_attribute(feature, "Z"))
            key = (
                round(point[0], 7),
                round(point[1], 7),
                depth,
                attributes.get("SORDAT"),
                attributes.get("SORIND"),
            )
            deduplicated_context[key] = feature
        context_depths = sorted(rounded_depth(numeric_attribute(feature, "Z")) for feature in deduplicated_context.values())
        distances = sorted(
            haversine_distance(site["latitude"], site["longitude"], feature["point"][1], feature["point"][0])
            for feature in deduplicated_context.values()
        )
        all_features = sector_soundings + context_soundings + contours + areas
        dates, partial_dates, has_undated_records = source_dates(all_features)
        cells = source_cells(all_features)
    except StructureDepthError:
        return {
            "status": "source-unavailable",
            "chartedBandsMeters": [],
            "contourDepthsMeters": [],
            "sectorSoundingDepthsMeters": [],
            "contextSoundingCount": 0,
            "contextSoundingDepthRangeMeters": None,
            "nearestContextSoundingDistanceMeters": None,
            "sourceDates": [],
            "partialSourceDates": [],
            "hasUndatedRecords": False,
            "sourceCells": [],
            "uncertaintyMeters": None,
            "uncertaintyStatus": source_uncertainty_status,
            "detail": "The NOAA ENC depth response contained an unreviewed value and failed closed. No depth inference is published for this site.",
        }
    status = "charted-sector-bands" if bands else "no-charted-sector-band"
    if bands:
        detail = (
            f"NOAA ENC depth areas intersect the configured {site['castingZone']['radiusMeters']} m offshore sector. "
            f"Context soundings are limited to {context_radius:,} m and are not a shore-reachable or casting-depth guarantee. "
            "The selected service layers publish no numeric uncertainty, and source dates can be old."
        )
    else:
        detail = (
            "No reviewed NOAA ENC depth-area record intersected the configured offshore sector. "
            "That is an evidence gap, not proof of shallow water or safe access."
        )
    return {
        "status": status,
        "chartedBandsMeters": [list(value) for value in bands],
        "contourDepthsMeters": contour_depths,
        "sectorSoundingDepthsMeters": sector_depths,
        "contextSoundingCount": len(deduplicated_context),
        "contextSoundingDepthRangeMeters": [context_depths[0], context_depths[-1]] if context_depths else None,
        "nearestContextSoundingDistanceMeters": round(distances[0], 1) if distances else None,
        "sourceDates": dates,
        "partialSourceDates": partial_dates,
        "hasUndatedRecords": has_undated_records,
        "sourceCells": cells,
        "uncertaintyMeters": None,
        "uncertaintyStatus": source_uncertainty_status,
        "detail": detail,
    }


def derive_structure(
    site: dict[str, Any],
    site_snapshot: dict[str, Any],
    policy: dict[str, Any],
    context_radius: int,
) -> dict[str, Any]:
    layers = policy["source"]["layers"]
    structure_layers = {
        key: layer
        for key, layer in layers.items()
        if key not in {"soundings", "depthContours", "depthAreas"}
    }
    queries = [(layer, get_query(site_snapshot, f"{key}:context")) for key, layer in structure_layers.items()]
    catalog_clues = [
        {"tag": tag, "reviewStatus": "catalog-only-not-validated-by-this-source"}
        for tag in site["structureTags"]
    ]
    if any(query["errorCategory"] is not None for _, query in queries):
        return {
            "status": "source-unavailable",
            "chartedFeatures": [],
            "catalogClues": catalog_clues,
            "detail": "One or more selected NOAA ENC feature queries failed closed. Catalog clues remain unvalidated by this source.",
        }
    try:
        grouped: dict[str, dict[str, Any]] = {}
        for layer, query in queries:
            category = layer["category"]
            group = grouped.setdefault(
                category,
                {
                    "features": {},
                    "dates": set(),
                    "partialDates": set(),
                    "hasUndatedRecords": False,
                    "cells": set(),
                },
            )
            for feature in query["features"]:
                attributes_without_cell = {
                    key: value
                    for key, value in feature["attributes"].items()
                    if key not in {"DSNM"}
                }
                signature = json.dumps(
                    {
                        "geometrySha256": feature["geometrySha256"],
                        "attributes": attributes_without_cell,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
                group["features"][signature] = feature
            dates, partial_dates, has_undated_records = source_dates(query["features"])
            group["dates"].update(dates)
            group["partialDates"].update(partial_dates)
            group["hasUndatedRecords"] = group["hasUndatedRecords"] or has_undated_records
            group["cells"].update(source_cells(query["features"]))
        charted = [
            {
                "category": category,
                "label": FEATURE_LABELS[category],
                "recordCount": len(group["features"]),
                "sourceDates": sorted(group["dates"]),
                "partialSourceDates": sorted(group["partialDates"]),
                "hasUndatedRecords": group["hasUndatedRecords"],
                "sourceCells": sorted(group["cells"]),
            }
            for category, group in sorted(grouped.items())
            if group["features"]
        ]
    except StructureDepthError:
        return {
            "status": "source-unavailable",
            "chartedFeatures": [],
            "catalogClues": catalog_clues,
            "detail": "The NOAA ENC feature response contained an unreviewed value and failed closed. Catalog clues remain unvalidated by this source.",
        }
    if charted:
        detail = (
            f"Selected NOAA ENC feature classes have records within {context_radius:,} m. "
            "They are chart context, not a complete structure inventory; dynamic sand, reef, vegetation, and access still require local review."
        )
        status = "charted-features-present"
    else:
        detail = (
            f"No selected NOAA ENC feature-class record was returned within {context_radius:,} m. "
            "That does not establish that structure is absent; catalog clues still require independent local review."
        )
        status = "no-selected-feature-records"
    return {
        "status": status,
        "chartedFeatures": charted,
        "catalogClues": catalog_clues,
        "detail": detail,
    }


def build_artifact(
    policy: dict[str, Any],
    sites: list[dict[str, Any]],
    policy_bytes: bytes,
    site_bytes: bytes,
    snapshot: dict[str, Any],
    snapshot_bytes: bytes,
    generated_at: str,
) -> dict[str, Any]:
    source_policy = policy["source"]
    service_error = snapshot["serviceErrorCategory"]
    site_evidence: dict[str, Any] = {}
    statuses: list[str] = []
    for site in sites:
        if service_error is not None:
            depth = {
                "status": "source-unavailable",
                "chartedBandsMeters": [],
                "contourDepthsMeters": [],
                "sectorSoundingDepthsMeters": [],
                "contextSoundingCount": 0,
                "contextSoundingDepthRangeMeters": None,
                "nearestContextSoundingDistanceMeters": None,
                "sourceDates": [],
                "partialSourceDates": [],
                "hasUndatedRecords": False,
                "sourceCells": [],
                "uncertaintyMeters": None,
                "uncertaintyStatus": source_policy["uncertainty_status"],
                "detail": "The NOAA ENC service metadata was unavailable or drifted. No depth inference is published for this site.",
            }
            structure = {
                "status": "source-unavailable",
                "chartedFeatures": [],
                "catalogClues": [
                    {"tag": tag, "reviewStatus": "catalog-only-not-validated-by-this-source"}
                    for tag in site["structureTags"]
                ],
                "detail": "The NOAA ENC service metadata was unavailable or drifted. Catalog clues remain unvalidated by this source.",
            }
        else:
            site_snapshot = snapshot["sites"][site["id"]]
            depth = derive_depth(
                site,
                site_snapshot,
                source_policy["uncertainty_status"],
                policy["geometry"]["context_radius_meters"],
            )
            structure = derive_structure(
                site,
                site_snapshot,
                policy,
                policy["geometry"]["context_radius_meters"],
            )
        if depth["status"] == "source-unavailable" and structure["status"] == "source-unavailable":
            site_status = "source-unavailable"
        elif depth["status"] != "charted-sector-bands" or structure["status"] == "source-unavailable":
            site_status = "partial"
        else:
            site_status = "charted-context"
        statuses.append(site_status)
        site_evidence[site["id"]] = {
            "siteId": site["id"],
            "siteName": site["name"],
            "status": site_status,
            "coordinates": {
                "latitude": site["latitude"],
                "longitude": site["longitude"],
            },
            "geometry": {
                "sectorRadiusMeters": site["castingZone"]["radiusMeters"],
                "sectorBearingDegrees": site["castingZone"]["bearingDegrees"],
                "sectorHalfWidthDegrees": policy["geometry"]["sector_half_width_degrees"],
                "contextRadiusMeters": policy["geometry"]["context_radius_meters"],
            },
            "depth": depth,
            "structure": structure,
            "scoreDelta": None,
            "navigationUseAllowed": False,
            "sourceUrl": source_policy["program_url"],
        }
    if all(status == "charted-context" for status in statuses):
        overall_status = "complete"
    elif all(status == "source-unavailable" for status in statuses):
        overall_status = "unavailable"
    else:
        overall_status = "partial"
    return {
        "schemaVersion": ARTIFACT_SCHEMA,
        "policyVersion": policy["policy_version"],
        "policySha256": sha256_bytes(policy_bytes),
        "collectorSha256": sha256_path(Path(__file__)),
        "siteCatalogSha256": sha256_bytes(site_bytes),
        "sourceSnapshotSha256": sha256_bytes(snapshot_bytes),
        "generatedAt": generated_at,
        "status": overall_status,
        "meaning": policy["meaning"],
        "scoreContribution": {
            "mode": policy["score_contribution"],
            "numericContributionAllowed": False,
            "catalogMutationAllowed": False,
        },
        "source": {
            "sourceId": source_policy["source_id"],
            "agency": source_policy["agency"],
            "product": source_policy["product"],
            "programUrl": source_policy["program_url"],
            "serviceUrl": source_policy["service_url"],
            "usageBand": source_policy["usage_band"],
            "depthUnits": source_policy["depth_units"],
            "verticalDatum": source_policy["vertical_datum"],
            "verticalDatumBasis": source_policy["vertical_datum_basis"],
            "resolutionStatus": source_policy["resolution_status"],
            "positionalAccuracyStatus": source_policy["positional_accuracy_status"],
            "uncertaintyStatus": source_policy["uncertainty_status"],
            "notForNavigation": source_policy["not_for_navigation"],
            "capturedAt": snapshot["capturedAt"],
            "errorCategory": service_error,
        },
        "sites": site_evidence,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", help="UTC generation/capture time; required for a reproducible live receipt")
    parser.add_argument("--source-snapshot-file", type=Path, help="Use an existing normalized source snapshot")
    parser.add_argument("--source-snapshot-out", type=Path, help="Write the normalized live source snapshot")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()

    try:
        as_of = parse_as_of(arguments.as_of)
        generated_at = iso_datetime(as_of)
        policy, sites, policy_bytes, site_bytes = load_inputs()
        if arguments.source_snapshot_file is not None:
            if arguments.source_snapshot_out is not None:
                raise StructureDepthError("conflicting-source-snapshot-options")
            snapshot_bytes = arguments.source_snapshot_file.read_bytes()
            try:
                snapshot = json.loads(snapshot_bytes)
            except (json.JSONDecodeError, UnicodeError) as exc:
                raise StructureDepthError("invalid-source-snapshot") from exc
        else:
            if arguments.as_of is None:
                raise StructureDepthError("live-capture-requires-as-of")
            snapshot = capture_snapshot(policy, sites, generated_at)
            snapshot_bytes = json_bytes(snapshot)
            if arguments.source_snapshot_out is not None:
                write_atomic(arguments.source_snapshot_out, snapshot_bytes)
        validate_snapshot(snapshot, policy, sites)
        artifact = build_artifact(
            policy,
            sites,
            policy_bytes,
            site_bytes,
            snapshot,
            snapshot_bytes,
            generated_at,
        )
        write_atomic(arguments.output, json_bytes(artifact))
    except (OSError, StructureDepthError) as exc:
        category = str(exc) if isinstance(exc, StructureDepthError) else "local-io-failed"
        print(json.dumps({"status": "error", "errorCategory": category}))
        return 1
    print(
        json.dumps(
            {
                "status": "ok",
                "artifactStatus": artifact["status"],
                "siteCount": len(artifact["sites"]),
                "output": str(arguments.output),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
