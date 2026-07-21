#!/usr/bin/env python3
"""Refresh the fail-closed public water-quality advisory overlay.

This collector deliberately keeps agency water-contact status separate from
the fishing opportunity score. A current official posting suppresses a site
from recommendations. A current no-posting result is neutral only when the
source publishes complete, fresh sample evidence. A source that reports only
actions cannot turn an absent action into a no-posting claim. Missing, stale,
unmonitored, unavailable, and unmapped data remains explicitly unknown.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "water-quality" / "policy.json"
SITES_PATH = ROOT / "data" / "sites.json"
DEFAULT_OUTPUT = ROOT / "public" / "data" / "water-quality.json"
SFP_SOURCE_ID = "sfpuc"
BEACHWATCH_SOURCE_ID = "california-beachwatch-santa-barbara"
EXPECTED_SOURCES = {
    SFP_SOURCE_ID: {
        "source_type": "sfpuc-sample-status-xml",
        "machine_url": "https://infrastructure.sfwater.org/lims.asmx/getBeaches",
    },
    BEACHWATCH_SOURCE_ID: {
        "source_type": "california-beachwatch-action-html",
        "machine_url": "https://beachwatch.waterboards.ca.gov/public/advisory.php",
        "county_id": "14",
        "county_name": "Santa Barbara",
    },
}
USER_AGENT = "CastingCompass/0.1 (public-data demo; contact: bzeng0000@gmail.com)"
PACIFIC = ZoneInfo("America/Los_Angeles")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_BEACHWATCH_ROWS = 5_000
HISTORICAL_MALFORMED_ACTION_GRACE_DAYS = 90
STATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")
BEACHWATCH_HEADERS = [
    "Type",
    "County",
    "Station Name",
    "Description",
    "Beach",
    "Cause",
    "Source",
    "Substance",
    "Start Date",
    "End Date",
    "Indicators",
]


class WaterQualityError(RuntimeError):
    """A sanitized collector error that is safe to expose as a category."""


class BeachwatchTableParser(HTMLParser):
    """Extract only complete header/data rows from the public action table."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._row: list[tuple[str, str]] | None = None
        self._cell_tag: str | None = None
        self._cell_parts: list[str] = []
        self.headers: list[list[str]] = []
        self.rows: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag == "tr":
            self._row = []
        elif tag in {"th", "td"} and self._row is not None:
            self._cell_tag = tag
            self._cell_parts = []

    def handle_data(self, data: str) -> None:
        if self._cell_tag is not None:
            self._cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"th", "td"} and self._cell_tag == tag and self._row is not None:
            self._row.append((tag, " ".join("".join(self._cell_parts).split())))
            self._cell_tag = None
            self._cell_parts = []
        elif tag == "tr" and self._row is not None:
            values = [value for _, value in self._row]
            tags = {cell_tag for cell_tag, _ in self._row}
            if tags == {"th"}:
                self.headers.append(values)
            elif tags == {"td"} and len(values) == len(BEACHWATCH_HEADERS):
                self.rows.append(values)
            self._row = None


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
    if policy.get("schema_version") != "castingcompass.water-quality-policy/2.0.0":
        raise WaterQualityError("unsupported-policy-schema")
    if policy.get("score_contribution") != "excluded-pending-frozen-baseline-validation":
        raise WaterQualityError("unsafe-score-contribution")
    sources = policy.get("sources")
    if not isinstance(sources, dict) or set(sources) != set(EXPECTED_SOURCES):
        raise WaterQualityError("invalid-source-set")
    for source_id, expected in EXPECTED_SOURCES.items():
        source = sources.get(source_id)
        if not isinstance(source, dict) or any(source.get(key) != value for key, value in expected.items()):
            raise WaterQualityError("untrusted-source-configuration")
        for url_key in ("program_url", "status_url", "machine_url"):
            if not isinstance(source.get(url_key), str) or not source[url_key].startswith("https://"):
                raise WaterQualityError("invalid-source-url")
    beachwatch_source = sources[BEACHWATCH_SOURCE_ID]
    global_station_ids = beachwatch_source.get("global_station_ids")
    if (
        not isinstance(global_station_ids, list)
        or not global_station_ids
        or not all(isinstance(value, str) and STATION_ID_PATTERN.fullmatch(value) for value in global_station_ids)
    ):
        raise WaterQualityError("invalid-global-station-map")
    site_ids = {site.get("id") for site in sites}
    mappings = policy.get("site_mappings")
    if not isinstance(mappings, dict) or not mappings:
        raise WaterQualityError("missing-site-station-map")
    for site_id, mapping in mappings.items():
        if site_id not in site_ids or not isinstance(mapping, dict):
            raise WaterQualityError("unknown-policy-site")
        source_id = mapping.get("source_id")
        station_ids = mapping.get("station_ids")
        if source_id not in sources or not isinstance(station_ids, list):
            raise WaterQualityError("invalid-station-map")
        if (
            len(set(station_ids)) != len(station_ids)
            or not all(isinstance(value, str) and STATION_ID_PATTERN.fullmatch(value) for value in station_ids)
        ):
            raise WaterQualityError("invalid-station-map")
        if source_id == SFP_SOURCE_ID and (
            not station_ids or not all(station_id.isdigit() for station_id in station_ids)
        ):
            raise WaterQualityError("invalid-sfpuc-station-map")
    return policy, sites, policy_bytes


def fetch_source(source_id: str, source: dict[str, Any]) -> bytes:
    headers = {"User-Agent": USER_AGENT}
    data = None
    if source_id == SFP_SOURCE_ID:
        headers["Accept"] = "application/xml,text/xml"
    elif source_id == BEACHWATCH_SOURCE_ID:
        headers["Accept"] = "text/html"
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urllib.parse.urlencode(
            {
                "County": source["county_id"],
                "year": "",
                "created": "",
                "sort": "`Start Date`",
                "sortOrder": "DESC",
                "submit": "Search",
            }
        ).encode("ascii")
    else:
        raise WaterQualityError("untrusted-source-id")
    request = urllib.request.Request(source["machine_url"], data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 -- fixed HTTPS allowlist
            if response.geturl() != source["machine_url"]:
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


def parse_sfpuc_records(body: bytes) -> dict[str, dict[str, Any]]:
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


def parse_beachwatch_records(
    body: bytes, county_name: str, as_of: datetime
) -> list[dict[str, str | date | None]]:
    try:
        text = body.decode("utf-8")
    except UnicodeError as exc:
        raise WaterQualityError("invalid-source-payload") from exc
    parser = BeachwatchTableParser()
    try:
        parser.feed(text)
        parser.close()
    except Exception as exc:
        raise WaterQualityError("invalid-source-payload") from exc
    if BEACHWATCH_HEADERS not in parser.headers or len(parser.rows) > MAX_BEACHWATCH_ROWS:
        raise WaterQualityError("invalid-source-record-set")
    records: list[dict[str, str | date | None]] = []
    for row in parser.rows:
        action_type, county, station_id, description, beach, cause, source, substance, start, end, indicators = row
        if county != county_name:
            raise WaterQualityError("unexpected-source-county")
        if action_type not in {"Closure", "Posting", "Rain"}:
            raise WaterQualityError("unreviewed-action-type")
        if not station_id or not STATION_ID_PATTERN.fullmatch(station_id):
            raise WaterQualityError("invalid-source-station-id")
        start_date = parse_action_date(start)
        end_date = parse_action_date(end) if end else None
        if start_date is None or (end and end_date is None):
            raise WaterQualityError("invalid-action-date")
        if end_date is not None and end_date < start_date:
            historical_cutoff = (
                as_of.astimezone(PACIFIC).date()
                - timedelta(days=HISTORICAL_MALFORMED_ACTION_GRACE_DAYS)
            )
            if max(start_date, end_date) < historical_cutoff:
                continue
            raise WaterQualityError("invalid-action-date")
        records.append(
            {
                "type": action_type,
                "station_id": station_id,
                "description": clean_text(description) or "Unnamed station",
                "beach": clean_text(beach) or "Unnamed beach",
                "cause": clean_text(cause),
                "source": clean_text(source),
                "substance": clean_text(substance),
                "indicators": clean_text(indicators),
                "start_date": start_date,
                "end_date": end_date,
            }
        )
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


def parse_action_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def active_sfpuc_status(record: dict[str, Any]) -> str | None:
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


def assessment_base(
    *,
    source_id: str | None,
    station_ids: list[str],
    station_names: list[str],
    as_of: datetime,
    source_url: str,
    sample_dates: list[str] | None = None,
    action_start_dates: list[str] | None = None,
    action_end_dates: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "sourceId": source_id,
        "stationIds": station_ids,
        "stationNames": station_names,
        "checkedAt": isoformat(as_of),
        "sampleDates": sample_dates or [],
        "actionStartDates": action_start_dates or [],
        "actionEndDates": action_end_dates or [],
        "scoreDelta": None,
        "sourceUrl": source_url,
    }


def assess_sfpuc_site(
    station_ids: list[str],
    records: dict[str, dict[str, Any]],
    as_of: datetime,
    maximum_sample_age_days: int,
    source_url: str,
) -> dict[str, Any]:
    found = [records[station_id] for station_id in station_ids if station_id in records]
    station_names = [clean_text(record.get("stationname")) or "Unnamed station" for record in found]
    base = assessment_base(
        source_id=SFP_SOURCE_ID,
        station_ids=station_ids,
        station_names=station_names,
        as_of=as_of,
        source_url=source_url,
        sample_dates=sorted(
            {value.isoformat() for record in found if (value := sample_date(record.get("sample_date"))) is not None}
        ),
    )
    active = [active_sfpuc_status(record) for record in found]
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


def assess_beachwatch_site(
    station_ids: list[str],
    global_station_ids: list[str],
    records: list[dict[str, str | date | None]],
    as_of: datetime,
    source_url: str,
) -> dict[str, Any]:
    configured_station_ids = list(dict.fromkeys([*station_ids, *global_station_ids]))
    current_date = as_of.astimezone(PACIFIC).date()
    active_records = [
        record
        for record in records
        if record["station_id"] in configured_station_ids
        and isinstance(record["start_date"], date)
        and record["start_date"] <= current_date
        and (record["end_date"] is None or record["end_date"] >= current_date)
    ]
    status_order = (
        ("Closure", "closure", "Official water-contact closure"),
        ("Posting", "posted", "Official water-contact posting"),
        ("Rain", "rain-advisory", "Official countywide rain advisory"),
    )
    for action_type, status, label in status_order:
        selected = [record for record in active_records if record["type"] == action_type]
        if not selected:
            continue
        selected_station_ids = sorted({str(record["station_id"]) for record in selected})
        selected_station_names = sorted({str(record["description"]) for record in selected})
        start_dates = sorted(
            {record["start_date"].isoformat() for record in selected if isinstance(record["start_date"], date)}
        )
        end_dates = sorted(
            {record["end_date"].isoformat() for record in selected if isinstance(record["end_date"], date)}
        )
        return {
            **assessment_base(
                source_id=BEACHWATCH_SOURCE_ID,
                station_ids=selected_station_ids,
                station_names=selected_station_names,
                as_of=as_of,
                source_url=source_url,
                action_start_dates=start_dates,
                action_end_dates=end_dates,
            ),
            "status": status,
            "recommendationEffect": "suppress",
            "officialLabel": label,
            "detail": "A current county-submitted action in the official State Board table suppresses this site from recommendations.",
        }
    return {
        **assessment_base(
            source_id=BEACHWATCH_SOURCE_ID,
            station_ids=configured_station_ids,
            station_names=[],
            as_of=as_of,
            source_url=source_url,
        ),
        "status": "unknown",
        "recommendationEffect": "unknown",
        "officialLabel": "No active action verified",
        "detail": "No active action was found in this official table. Because absence does not prove a current no-posting status, this site remains unknown.",
    }


def unavailable_assessment(
    *, source_id: str, station_ids: list[str], as_of: datetime, source_url: str
) -> dict[str, Any]:
    return {
        **assessment_base(
            source_id=source_id,
            station_ids=station_ids,
            station_names=[],
            as_of=as_of,
            source_url=source_url,
        ),
        "status": "source-unavailable",
        "recommendationEffect": "unknown",
        "officialLabel": "Official status unavailable",
        "detail": "The official source could not be verified during this refresh.",
    }


def build_payload(
    *,
    policy: dict[str, Any],
    sites: list[dict[str, Any]],
    policy_bytes: bytes,
    source_records: dict[str, Any],
    source_errors: dict[str, str | None],
    as_of: datetime,
) -> dict[str, Any]:
    sources = policy["sources"]
    mappings = policy["site_mappings"]
    site_assessments: dict[str, dict[str, Any]] = {}
    for site in sorted(sites, key=lambda item: item["id"]):
        site_id = site["id"]
        mapping = mappings.get(site_id)
        if mapping is None:
            assessment = {
                **assessment_base(
                    source_id=None,
                    station_ids=[],
                    station_names=[],
                    as_of=as_of,
                    source_url="https://www.waterboards.ca.gov/water_issues/programs/beaches/beach_water_quality/",
                ),
                "status": "not-covered",
                "recommendationEffect": "unknown",
                "officialLabel": "No exact official station mapped",
                "detail": "CastingCompass has no exact, reviewed official water-quality station mapping for this site.",
            }
        else:
            source_id = mapping["source_id"]
            source = sources[source_id]
            station_ids = mapping["station_ids"]
            if source_errors[source_id] is not None:
                unavailable_station_ids = station_ids
                if source_id == BEACHWATCH_SOURCE_ID:
                    unavailable_station_ids = list(
                        dict.fromkeys([*station_ids, *source["global_station_ids"]])
                    )
                assessment = unavailable_assessment(
                    source_id=source_id,
                    station_ids=unavailable_station_ids,
                    as_of=as_of,
                    source_url=source["status_url"],
                )
            elif source_id == SFP_SOURCE_ID:
                assessment = assess_sfpuc_site(
                    station_ids,
                    source_records[source_id],
                    as_of,
                    int(policy["freshness"]["maximum_sample_age_days"]),
                    source["status_url"],
                )
            else:
                assessment = assess_beachwatch_site(
                    station_ids,
                    source["global_station_ids"],
                    source_records[source_id],
                    as_of,
                    source["status_url"],
                )
        site_assessments[site_id] = assessment
    mapped = [site_assessments[site_id] for site_id in mappings]
    unavailable_count = sum(error is not None for error in source_errors.values())
    if unavailable_count == len(sources):
        overall_status = "unavailable"
    elif unavailable_count or any(item["status"] != "no-active-posting" for item in mapped):
        overall_status = "partial"
    else:
        overall_status = "fresh"
    return {
        "schemaVersion": "castingcompass.water-quality-advisory/2.0.0",
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
        "sources": {
            source_id: {
                "agency": source["agency"],
                "programUrl": source["program_url"],
                "statusUrl": source["status_url"],
                "machineUrl": source["machine_url"],
                "absenceBehavior": source["absence_behavior"],
                "errorCategory": source_errors[source_id],
            }
            for source_id, source in sources.items()
        },
        "sites": site_assessments,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", help="UTC ISO timestamp used for deterministic freshness checks")
    parser.add_argument(
        "--source-file",
        "--sfpuc-source-file",
        dest="sfpuc_source_file",
        type=Path,
        help="Read an SFPUC XML fixture instead of the network",
    )
    parser.add_argument(
        "--beachwatch-source-file",
        type=Path,
        help="Read a California BeachWatch HTML fixture instead of the network",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    as_of = parse_as_of(args.as_of)
    policy, sites, policy_bytes = load_inputs()
    fixture_paths = {
        SFP_SOURCE_ID: args.sfpuc_source_file,
        BEACHWATCH_SOURCE_ID: args.beachwatch_source_file,
    }
    source_records: dict[str, Any] = {}
    source_errors: dict[str, str | None] = {source_id: None for source_id in policy["sources"]}
    for source_id, source in policy["sources"].items():
        try:
            fixture_path = fixture_paths[source_id]
            body = fixture_path.read_bytes() if fixture_path else fetch_source(source_id, source)
            if source_id == SFP_SOURCE_ID:
                source_records[source_id] = parse_sfpuc_records(body)
            else:
                source_records[source_id] = parse_beachwatch_records(
                    body, source["county_name"], as_of
                )
        except (OSError, WaterQualityError) as exc:
            source_errors[source_id] = (
                exc.args[0] if isinstance(exc, WaterQualityError) else "source-file-unavailable"
            )
    payload = build_payload(
        policy=policy,
        sites=sites,
        policy_bytes=policy_bytes,
        source_records=source_records,
        source_errors=source_errors,
        as_of=as_of,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": payload["status"],
                "coveredSiteCount": len(policy["site_mappings"]),
                "suppressedSiteCount": sum(
                    item["recommendationEffect"] == "suppress" for item in payload["sites"].values()
                ),
                "sourceErrors": source_errors,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
