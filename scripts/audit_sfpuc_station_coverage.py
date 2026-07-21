#!/usr/bin/env python3
"""Create a bounded SFPUC station-proximity audit without creating mappings.

Nearest-station distance is useful for review triage, but it is not evidence
that an agency station represents a CastingCompass location. This tool is
therefore deliberately incapable of editing the water-quality policy or
recommending a mapping.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from refresh_water_quality import (
    SFP_SOURCE_ID,
    SITES_PATH,
    WaterQualityError,
    clean_text,
    fetch_source,
    isoformat,
    load_inputs,
    parse_as_of,
    parse_sfpuc_records,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "water-quality" / "audits" / "sf-unmapped-station-candidates.json"
DEFAULT_SITE_IDS = (
    "torpedo-wharf",
    "pier-7",
    "pier-14",
    "herons-head-park-pier",
)
EARTH_RADIUS_METERS = 6_371_008.8
CANDIDATE_COUNT = 4


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


def build_audit(
    *,
    as_of: datetime,
    policy: dict[str, Any],
    sites: list[dict[str, Any]],
    source_body: bytes,
    site_ids: tuple[str, ...],
) -> dict[str, Any]:
    records = parse_sfpuc_records(source_body)
    source = policy["sources"][SFP_SOURCE_ID]
    sites_by_id = {site["id"]: site for site in sites}
    unknown_site_ids = sorted(set(site_ids) - set(sites_by_id))
    if unknown_site_ids:
        raise WaterQualityError("unknown-audit-site")
    station_coordinates = {
        station_id: (
            coordinate(record.get("lat"), latitude=True),
            coordinate(record.get("lon"), latitude=False),
        )
        for station_id, record in records.items()
    }
    audited_sites = []
    for site_id in site_ids:
        site = sites_by_id[site_id]
        site_coordinate = (
            coordinate(site.get("latitude"), latitude=True),
            coordinate(site.get("longitude"), latitude=False),
        )
        candidates = sorted(
            (
                distance_meters(site_coordinate, station_coordinates[station_id]),
                station_id,
                clean_text(record.get("stationname")) or "Unnamed station",
                station_coordinates[station_id],
            )
            for station_id, record in records.items()
        )[:CANDIDATE_COUNT]
        audited_sites.append(
            {
                "siteId": site_id,
                "siteName": site["name"],
                "siteCoordinate": {
                    "latitude": site_coordinate[0],
                    "longitude": site_coordinate[1],
                },
                "policyMapped": site_id in policy["site_mappings"],
                "automaticMappingAllowed": False,
                "automatedDisposition": "candidate-only-do-not-map",
                "nearestOfficialStations": [
                    {
                        "stationId": station_id,
                        "stationName": station_name,
                        "distanceMeters": distance,
                        "latitude": station_coordinate[0],
                        "longitude": station_coordinate[1],
                    }
                    for distance, station_id, station_name, station_coordinate in candidates
                ],
            }
        )
    return {
        "schemaVersion": "castingcompass.water-quality-coverage-audit/1.0.0",
        "generatedAt": isoformat(as_of),
        "meaning": "proximity candidates for manual spatial-support review; not agency coverage or a mapping recommendation",
        "automaticMappingAllowed": False,
        "source": {
            "sourceId": SFP_SOURCE_ID,
            "agency": source["agency"],
            "programUrl": source["program_url"],
            "statusUrl": source["status_url"],
            "machineUrl": source["machine_url"],
            "responseSha256": hashlib.sha256(source_body).hexdigest(),
            "stationCount": len(records),
        },
        "auditToolSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "siteCatalogSha256": hashlib.sha256(SITES_PATH.read_bytes()).hexdigest(),
        "method": {
            "distance": "haversine",
            "earthRadiusMeters": EARTH_RADIUS_METERS,
            "candidateCount": CANDIDATE_COUNT,
            "decisionRule": "distance and name are triage evidence only; policy mapping requires separate documented spatial authority and review",
        },
        "sites": audited_sites,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", help="UTC ISO timestamp for the audit receipt")
    parser.add_argument(
        "--source-file",
        type=Path,
        help="Read an SFPUC XML fixture instead of the fixed official endpoint",
    )
    parser.add_argument(
        "--site-id",
        action="append",
        dest="site_ids",
        help="Catalog site to audit; repeat for multiple sites",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    as_of = parse_as_of(args.as_of) if args.as_of else datetime.now(timezone.utc)
    policy, sites, _ = load_inputs()
    source = policy["sources"][SFP_SOURCE_ID]
    try:
        source_body = args.source_file.read_bytes() if args.source_file else fetch_source(SFP_SOURCE_ID, source)
    except OSError as exc:
        raise WaterQualityError("source-file-unavailable") from exc
    site_ids = tuple(args.site_ids) if args.site_ids else DEFAULT_SITE_IDS
    if not site_ids or len(site_ids) != len(set(site_ids)):
        raise WaterQualityError("invalid-audit-site-set")
    payload = build_audit(
        as_of=as_of,
        policy=policy,
        sites=sites,
        source_body=source_body,
        site_ids=site_ids,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "auditedSiteCount": len(payload["sites"]),
                "stationCount": payload["source"]["stationCount"],
                "automaticMappingAllowed": payload["automaticMappingAllowed"],
                "output": str(args.output),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
