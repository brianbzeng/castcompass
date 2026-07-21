#!/usr/bin/env python3
"""Refresh the fail-closed public water-quality advisory overlay.

This collector deliberately keeps agency water-contact status separate from
the fishing opportunity score. A current official posting suppresses a site
from recommendations. A current no-posting result is neutral, never a positive
score or a claim that water or seafood is safe. Missing, stale, unmonitored, or
unmapped data remains explicitly unknown.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "water-quality" / "policy.json"
SITES_PATH = ROOT / "data" / "sites.json"
DEFAULT_OUTPUT = ROOT / "public" / "data" / "water-quality.json"
EXPECTED_MACHINE_URL = "https://infrastructure.sfwater.org/lims.asmx/getBeaches"
USER_AGENT = "CastingCompass/0.1 (public-data demo; contact: bzeng0000@gmail.com)"
PACIFIC = ZoneInfo("America/Los_Angeles")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class WaterQualityError(RuntimeError):
    """A sanitized collector error that is safe to expose as a category."""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_as_of(raw: str | None) -> datetime:
    if raw is None:
        return datetime.now(timezone.utc)
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise WaterQualityError("invalid-as-of") from exc
    if value.tzinfo is None:
        raise WaterQualityError("as-of-missing-offset")
    return value.astimezone(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_inputs() -> tuple[dict[str, Any], list[dict[str, Any]], bytes]:
    policy_bytes = POLICY_PATH.read_bytes()
    policy = json.loads(policy_bytes)
    sites = json.loads(SITES_PATH.read_text(encoding="utf-8"))
    if policy.get("schema_version") != "castingcompass.water-quality-policy/1.0.0":
        raise WaterQualityError("unsupported-policy-schema")
    if policy.get("source", {}).get("machine_url") != EXPECTED_MACHINE_URL:
        raise WaterQualityError("untrusted-machine-url")
    if policy.get("score_contribution") != "excluded-pending-frozen-baseline-validation":
        raise WaterQualityError("unsafe-score-contribution")
    site_ids = {site.get("id") for site in sites}
    mappings = policy.get("site_stations")
    if not isinstance(mappings, dict) or not mappings:
        raise WaterQualityError("missing-site-station-map")
    for site_id, station_ids in mappings.items():
        if site_id not in site_ids:
            raise WaterQualityError("unknown-policy-site")
        if (
            not isinstance(station_ids, list)
            or not station_ids
            or not all(isinstance(station_id, str) and station_id.isdigit() for station_id in station_ids)
            or len(set(station_ids)) != len(station_ids)
        ):
            raise WaterQualityError("invalid-station-map")
    return policy, sites, policy_bytes


def fetch_source() -> bytes:
    request = urllib.request.Request(
        EXPECTED_MACHINE_URL,
        headers={"User-Agent": USER_AGENT, "Accept": "application/xml,text/xml"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 -- fixed HTTPS allowlist
            if response.geturl() != EXPECTED_MACHINE_URL:
                raise WaterQualityError("unexpected-source-redirect")
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_RESPONSE_BYTES:
                raise WaterQualityError("source-response-too-large")
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except WaterQualityError:
        raise
    except Exception as exc:
        raise WaterQualityError("source-request-failed") from exc
    if len(body) > MAX_RESPONSE_BYTES:
        raise WaterQualityError("source-response-too-large")
    return body


def parse_records(body: bytes) -> dict[str, dict[str, Any]]:
    try:
        root = ET.fromstring(body)
        raw_json = root.text
        parsed = json.loads(raw_json or "")
    except (ET.ParseError, json.JSONDecodeError, UnicodeError) as exc:
        raise WaterQualityError("invalid-source-payload") from exc
    if not isinstance(parsed, list) or len(parsed) > 500:
        raise WaterQualityError("invalid-source-record-set")
    records: dict[str, dict[str, Any]] = {}
    for record in parsed:
        if not isinstance(record, dict):
            raise WaterQualityError("invalid-source-record")
        station_id = record.get("stationid")
        if not isinstance(station_id, str) or not station_id.isdigit() or station_id in records:
            raise WaterQualityError("invalid-source-station-id")
        records[station_id] = record
    return records


def clean_text(value: Any, *, maximum: int = 160) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text[:maximum] or None


def sample_date(value: Any) -> date | None:
    raw = clean_text(value, maximum=10)
    if raw is None:
        return None
    try:
        return datetime.strptime(raw, "%m/%d/%y").date()
    except ValueError:
        return None


def active_status(record: dict[str, Any]) -> str | None:
    posted = (clean_text(record.get("posted")) or "").lower()
    cso = clean_text(record.get("cso"))
    primary_color = (clean_text(record.get("p_color"), maximum=8) or "").upper()
    sample_color = (clean_text(record.get("s_color"), maximum=8) or "").upper()
    if "clos" in posted:
        return "closure"
    if "advis" in posted or "warn" in posted or primary_color == "Y" or sample_color == "Y":
        return "advisory"
    if cso or (posted and posted not in {"open", "no posting"}) or primary_color == "R" or sample_color == "R":
        return "posted"
    return None


def assess_site(
    station_ids: list[str],
    records: dict[str, dict[str, Any]],
    as_of: datetime,
    maximum_sample_age_days: int,
) -> dict[str, Any]:
    found = [records[station_id] for station_id in station_ids if station_id in records]
    station_names = [clean_text(record.get("stationname")) or "Unnamed station" for record in found]
    base = {
        "stationIds": station_ids,
        "stationNames": station_names,
        "checkedAt": isoformat(as_of),
        "sampleDates": sorted(
            {value.isoformat() for record in found if (value := sample_date(record.get("sample_date"))) is not None}
        ),
        "scoreDelta": None,
    }
    active = [active_status(record) for record in found]
    for status in ("closure", "posted", "advisory"):
        if status in active:
            label = {
                "closure": "Official water-contact closure",
                "posted": "Official water-contact posting",
                "advisory": "Official water-contact advisory",
            }[status]
            return {
                **base,
                "status": status,
                "recommendationEffect": "suppress",
                "officialLabel": label,
                "detail": "This active agency status suppresses the site from CastingCompass recommendations.",
            }
    if len(found) != len(station_ids):
        return {
            **base,
            "status": "unknown",
            "recommendationEffect": "unknown",
            "officialLabel": "Official status incomplete",
            "detail": "One or more exact mapped stations were missing from the agency response.",
        }
    if any(
        (clean_text(record.get("p_color"), maximum=8) or "").upper() not in {"", "R", "Y"}
        or (clean_text(record.get("s_color"), maximum=8) or "").upper() not in {"", "R", "Y", "W"}
        for record in found
    ):
        return {
            **base,
            "status": "unknown",
            "recommendationEffect": "unknown",
            "officialLabel": "Official status encoding changed",
            "detail": "The agency response used an unreviewed status code, so CastingCompass cannot interpret it.",
        }
    sampled = [sample_date(record.get("sample_date")) for record in found]
    if any((clean_text(record.get("s_color"), maximum=8) or "").upper() == "W" for record in found):
        return {
            **base,
            "status": "unmonitored",
            "recommendationEffect": "unknown",
            "officialLabel": "Not routinely sampled",
            "detail": "The agency reports no routine sample data for at least one mapped station.",
        }
    if any(value is None for value in sampled):
        return {
            **base,
            "status": "unknown",
            "recommendationEffect": "unknown",
            "officialLabel": "Official sample status unavailable",
            "detail": "The agency response did not include a usable sample date for every mapped station.",
        }
    current_date = as_of.astimezone(PACIFIC).date()
    ages = [(current_date - value).days for value in sampled if value is not None]
    if any(age < 0 or age > maximum_sample_age_days for age in ages):
        return {
            **base,
            "status": "stale",
            "recommendationEffect": "unknown",
            "officialLabel": "Official sample is stale",
            "detail": f"At least one mapped sample exceeds the {maximum_sample_age_days}-day freshness limit.",
        }
    return {
        **base,
        "status": "no-active-posting",
        "recommendationEffect": "neutral",
        "officialLabel": "No active posting reported",
        "detail": "Neutral context only. This does not mean the water or seafood is safe and does not improve the fishing score.",
    }


def build_payload(
    *,
    policy: dict[str, Any],
    sites: list[dict[str, Any]],
    policy_bytes: bytes,
    records: dict[str, dict[str, Any]] | None,
    as_of: datetime,
    source_error: str | None,
) -> dict[str, Any]:
    source = policy["source"]
    mappings = policy["site_stations"]
    site_assessments: dict[str, dict[str, Any]] = {}
    for site in sorted(sites, key=lambda item: item["id"]):
        site_id = site["id"]
        if site_id not in mappings:
            assessment = {
                "status": "not-covered",
                "recommendationEffect": "unknown",
                "officialLabel": "No exact official station mapped",
                "detail": "CastingCompass has no exact, reviewed official water-quality station mapping for this site.",
                "stationIds": [],
                "stationNames": [],
                "sampleDates": [],
                "checkedAt": isoformat(as_of),
                "scoreDelta": None,
            }
        elif records is None:
            assessment = {
                "status": "source-unavailable",
                "recommendationEffect": "unknown",
                "officialLabel": "Official status unavailable",
                "detail": "The official source could not be verified during this refresh.",
                "stationIds": mappings[site_id],
                "stationNames": [],
                "sampleDates": [],
                "checkedAt": isoformat(as_of),
                "scoreDelta": None,
            }
        else:
            assessment = assess_site(
                mappings[site_id],
                records,
                as_of,
                int(policy["freshness"]["maximum_sample_age_days"]),
            )
        site_assessments[site_id] = {**assessment, "sourceUrl": source["status_url"]}
    mapped = [site_assessments[site_id] for site_id in mappings]
    if records is None:
        overall_status = "unavailable"
    elif all(item["status"] == "no-active-posting" for item in mapped):
        overall_status = "fresh"
    else:
        overall_status = "partial"
    return {
        "schemaVersion": "castingcompass.water-quality-advisory/1.0.0",
        "policyVersion": policy["policy_version"],
        "policySha256": hashlib.sha256(policy_bytes).hexdigest(),
        "collectorSha256": sha256(Path(__file__)),
        "siteCatalogSha256": sha256(SITES_PATH),
        "generatedAt": isoformat(as_of),
        "status": overall_status,
        "meaning": policy["meaning"],
        "freshness": {
            "maximumSampleAgeDays": int(policy["freshness"]["maximum_sample_age_days"]),
        },
        "scoreContribution": {
            "mode": policy["score_contribution"],
            "positiveContributionAllowed": False,
            "activeAgencyStatusSuppressesRecommendation": True,
        },
        "source": {
            "agency": source["agency"],
            "programUrl": source["program_url"],
            "statusUrl": source["status_url"],
            "machineUrl": source["machine_url"],
            "errorCategory": source_error,
        },
        "sites": site_assessments,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", help="UTC ISO timestamp used for deterministic freshness checks")
    parser.add_argument("--source-file", type=Path, help="Read an official XML fixture instead of the network")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    as_of = parse_as_of(args.as_of)
    policy, sites, policy_bytes = load_inputs()
    records: dict[str, dict[str, Any]] | None = None
    source_error: str | None = None
    try:
        body = args.source_file.read_bytes() if args.source_file else fetch_source()
        records = parse_records(body)
    except (OSError, WaterQualityError) as exc:
        source_error = exc.args[0] if isinstance(exc, WaterQualityError) else "source-file-unavailable"
    payload = build_payload(
        policy=policy,
        sites=sites,
        policy_bytes=policy_bytes,
        records=records,
        as_of=as_of,
        source_error=source_error,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": payload["status"],
                "coveredSiteCount": len(policy["site_stations"]),
                "suppressedSiteCount": sum(
                    item["recommendationEffect"] == "suppress" for item in payload["sites"].values()
                ),
                "sourceError": source_error,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
