#!/usr/bin/env python3
"""Create a bounded receipt for provisional San Mateo station mappings.

The County open-data registry is used only to corroborate station identity and
coordinates. It is historical and cannot establish current water quality,
clean water, seafood safety, or any numeric fishing-score contribution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from refresh_water_quality import (
    SAN_MATEO_SOURCE_ID,
    SITES_PATH,
    USER_AGENT,
    WaterQualityError,
    clean_text,
    isoformat,
    load_inputs,
    parse_as_of,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "water-quality" / "audits" / "san-mateo-station-mappings.json"
REGISTRY_MACHINE_URL = "https://datahub.smcgov.org/api/id/kpd9-xf4h.json"
MAX_RECORD_BYTES = 64 * 1024
EARTH_RADIUS_METERS = 6_371_008.8
UNMAPPED_REVIEW_SITE_IDS = ("poplar-beach",)


def coordinate(value: Any, *, latitude: bool) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise WaterQualityError("invalid-station-coordinate") from exc
    limit = 90 if latitude else 180
    if not math.isfinite(parsed) or not -limit <= parsed <= limit:
        raise WaterQualityError("invalid-station-coordinate")
    return parsed


def distance_meters(origin: tuple[float, float], target: tuple[float, float]) -> int:
    lat1, lon1 = (math.radians(value) for value in origin)
    lat2, lon2 = (math.radians(value) for value in target)
    delta_lat = lat2 - lat1
    delta_lon = lon2 - lon1
    haversine = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    return round(2 * EARTH_RADIUS_METERS * math.asin(math.sqrt(haversine)))


def read_response(response: Any) -> bytes:
    if response.geturl() != REGISTRY_MACHINE_URL and not response.geturl().startswith(
        f"{REGISTRY_MACHINE_URL}?"
    ):
        raise WaterQualityError("source-redirect-rejected")
    body = response.read(MAX_RECORD_BYTES + 1)
    if len(body) > MAX_RECORD_BYTES:
        raise WaterQualityError("source-response-too-large")
    return body


def fetch_registry_records(station_ids: list[str]) -> bytes:
    records: list[dict[str, Any]] = []
    for station_id in station_ids:
        query = urllib.parse.urlencode(
            {
                "$select": "site_id,site_name,site_type,process_da,location",
                "$where": f'site_id="{station_id}" AND location IS NOT NULL',
                "$order": "process_da DESC",
                "$limit": "1",
            }
        )
        request = urllib.request.Request(
            f"{REGISTRY_MACHINE_URL}?{query}",
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = read_response(response)
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise WaterQualityError("source-fetch-failed") from exc
        try:
            payload = json.loads(body)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise WaterQualityError("invalid-source-payload") from exc
        if not isinstance(payload, list) or len(payload) != 1:
            raise WaterQualityError("invalid-source-record-set")
        records.append(payload[0])
    return (json.dumps(records, sort_keys=True, separators=(",", ":")) + "\n").encode()


def parse_registry_records(body: bytes, station_ids: list[str]) -> dict[str, dict[str, Any]]:
    try:
        payload = json.loads(body)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise WaterQualityError("invalid-source-payload") from exc
    if not isinstance(payload, list) or len(payload) != len(station_ids):
        raise WaterQualityError("invalid-source-record-set")
    records: dict[str, dict[str, Any]] = {}
    for item in payload:
        if not isinstance(item, dict):
            raise WaterQualityError("invalid-source-record-set")
        station_id = item.get("site_id")
        location = item.get("location")
        coordinates = location.get("coordinates") if isinstance(location, dict) else None
        station_name = clean_text(item.get("site_name"))
        station_type = clean_text(item.get("site_type"), maximum=40)
        process_date = item.get("process_da")
        if (
            station_id not in station_ids
            or station_id in records
            or station_name is None
            or station_type is None
            or not isinstance(process_date, str)
            or not isinstance(coordinates, list)
            or len(coordinates) != 2
        ):
            raise WaterQualityError("invalid-source-record-set")
        try:
            record_date = datetime.fromisoformat(process_date.replace("Z", "+00:00")).date()
        except ValueError as exc:
            raise WaterQualityError("invalid-source-date") from exc
        records[station_id] = {
            "stationId": station_id,
            "stationName": station_name,
            "stationType": station_type,
            "recordDate": record_date.isoformat(),
            "latitude": coordinate(coordinates[1], latitude=True),
            "longitude": coordinate(coordinates[0], latitude=False),
        }
    if set(records) != set(station_ids):
        raise WaterQualityError("invalid-source-record-set")
    return records


def build_audit(
    *,
    as_of: datetime,
    policy: dict[str, Any],
    sites: list[dict[str, Any]],
    source_body: bytes,
) -> dict[str, Any]:
    source = policy["sources"][SAN_MATEO_SOURCE_ID]
    if source.get("station_registry_machine_url") != REGISTRY_MACHINE_URL:
        raise WaterQualityError("untrusted-station-registry-endpoint")
    mappings = {
        site_id: mapping
        for site_id, mapping in policy["site_mappings"].items()
        if mapping["source_id"] == SAN_MATEO_SOURCE_ID
    }
    station_ids = sorted(
        {station_id for mapping in mappings.values() for station_id in mapping["station_ids"]}
    )
    records = parse_registry_records(source_body, station_ids)
    if any(
        datetime.fromisoformat(record["recordDate"]).date() > as_of.date()
        for record in records.values()
    ):
        raise WaterQualityError("invalid-source-date")
    sites_by_id = {site["id"]: site for site in sites}

    audited_sites = []
    for site_id, mapping in mappings.items():
        site = sites_by_id[site_id]
        site_coordinate = (
            coordinate(site.get("latitude"), latitude=True),
            coordinate(site.get("longitude"), latitude=False),
        )
        station_support = []
        for station_id in mapping["station_ids"]:
            record = records[station_id]
            station_support.append(
                {
                    **record,
                    "distanceMeters": distance_meters(
                        site_coordinate, (record["latitude"], record["longitude"])
                    ),
                }
            )
        audited_sites.append(
            {
                "siteId": site_id,
                "siteName": site["name"],
                "siteCoordinate": {
                    "latitude": site_coordinate[0],
                    "longitude": site_coordinate[1],
                },
                "policyMapped": True,
                "reviewStatus": "local-preliminary-independent-review-required",
                "automaticMappingAllowed": False,
                "stationSupport": station_support,
            }
        )

    unmapped_sites = []
    for site_id in UNMAPPED_REVIEW_SITE_IDS:
        site = sites_by_id[site_id]
        site_coordinate = (
            coordinate(site.get("latitude"), latitude=True),
            coordinate(site.get("longitude"), latitude=False),
        )
        nearest = min(
            records.values(),
            key=lambda record: distance_meters(
                site_coordinate, (record["latitude"], record["longitude"])
            ),
        )
        unmapped_sites.append(
            {
                "siteId": site_id,
                "siteName": site["name"],
                "policyMapped": False,
                "reviewStatus": "local-preliminary-do-not-map",
                "automaticMappingAllowed": False,
                "nearestReviewedStation": {
                    **nearest,
                    "distanceMeters": distance_meters(
                        site_coordinate, (nearest["latitude"], nearest["longitude"])
                    ),
                },
                "reason": "No exact station identity or defensible local spatial support was established.",
            }
        )

    return {
        "schemaVersion": "castingcompass.water-quality-mapping-audit/1.0.0",
        "generatedAt": isoformat(as_of),
        "meaning": "historical station identity and coordinate support for local preliminary review; not current water quality, safety, or score evidence",
        "automaticMappingAllowed": False,
        "independentReviewRequired": True,
        "source": {
            "sourceId": SAN_MATEO_SOURCE_ID,
            "agency": source["agency"],
            "currentStatusUrl": source["status_url"],
            "registryUrl": source["station_registry_url"],
            "registryMachineUrl": REGISTRY_MACHINE_URL,
            "registryResponseSha256": hashlib.sha256(source_body).hexdigest(),
            "stationCount": len(records),
            "latestRecordDate": max(record["recordDate"] for record in records.values()),
            "registryUse": "station identity and spatial context only; never current status",
        },
        "policySha256": hashlib.sha256(
            (ROOT / "water-quality" / "policy.json").read_bytes()
        ).hexdigest(),
        "auditToolSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "siteCatalogSha256": hashlib.sha256(SITES_PATH.read_bytes()).hexdigest(),
        "method": {
            "distance": "haversine",
            "earthRadiusMeters": EARTH_RADIUS_METERS,
            "decisionRule": "exact name/location plus coordinate distance may support preliminary review; proximity alone never creates a mapping",
        },
        "mappedSites": audited_sites,
        "unmappedSites": unmapped_sites,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", help="UTC ISO timestamp for the audit receipt")
    parser.add_argument(
        "--source-file", type=Path, help="Read a bounded registry JSON fixture instead of the network"
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    as_of = parse_as_of(args.as_of) if args.as_of else datetime.now(timezone.utc)
    policy, sites, _ = load_inputs()
    mappings = [
        mapping
        for mapping in policy["site_mappings"].values()
        if mapping["source_id"] == SAN_MATEO_SOURCE_ID
    ]
    station_ids = sorted({station_id for mapping in mappings for station_id in mapping["station_ids"]})
    try:
        source_body = (
            args.source_file.read_bytes()
            if args.source_file
            else fetch_registry_records(station_ids)
        )
    except OSError as exc:
        raise WaterQualityError("source-file-unavailable") from exc
    payload = build_audit(
        as_of=as_of,
        policy=policy,
        sites=sites,
        source_body=source_body,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "mappedSiteCount": len(payload["mappedSites"]),
                "unmappedSiteCount": len(payload["unmappedSites"]),
                "stationCount": payload["source"]["stationCount"],
                "independentReviewRequired": payload["independentReviewRequired"],
                "output": str(args.output),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
