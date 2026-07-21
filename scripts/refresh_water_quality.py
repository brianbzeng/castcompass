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
SANTA_BARBARA_BEACHWATCH_SOURCE_ID = "california-beachwatch-santa-barbara"
MARIN_BEACHWATCH_SOURCE_ID = "california-beachwatch-marin"
BEACHWATCH_SOURCE_IDS = (
    SANTA_BARBARA_BEACHWATCH_SOURCE_ID,
    MARIN_BEACHWATCH_SOURCE_ID,
)
SAN_MATEO_SOURCE_ID = "san-mateo-county-health"
EXPECTED_SOURCES = {
    SFP_SOURCE_ID: {
        "source_type": "sfpuc-sample-status-xml",
        "machine_url": "https://infrastructure.sfwater.org/lims.asmx/getBeaches",
    },
    SANTA_BARBARA_BEACHWATCH_SOURCE_ID: {
        "source_type": "california-beachwatch-action-html",
        "machine_url": "https://beachwatch.waterboards.ca.gov/public/advisory.php",
        "county_id": "14",
        "county_name": "Santa Barbara",
    },
    MARIN_BEACHWATCH_SOURCE_ID: {
        "source_type": "california-beachwatch-action-html",
        "machine_url": "https://beachwatch.waterboards.ca.gov/public/advisory.php",
        "station_registry_url": "https://beachwatch.waterboards.ca.gov/public/result.php",
        "station_registry_machine_url": "https://beachwatch.waterboards.ca.gov/public/getstation.php",
        "county_id": "6",
        "county_name": "Marin",
    },
    SAN_MATEO_SOURCE_ID: {
        "source_type": "san-mateo-current-posting-html",
        "machine_url": "https://www.smchealth.org/node/1201",
    },
}
USER_AGENT = "CastingCompass/0.1 (public-data demo; contact: bzeng0000@gmail.com)"
PACIFIC = ZoneInfo("America/Los_Angeles")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_BEACHWATCH_ROWS = 5_000
MAX_SAN_MATEO_POSTINGS = 200
HISTORICAL_MALFORMED_ACTION_GRACE_DAYS = 90
STATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")
BEACHWATCH_STATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.# -]{1,96}$")
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
SAN_MATEO_SECTIONS = (
    "ocean beaches",
    "creeks (where they meet or cross the beach)",
    "bay beaches",
)


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


class SanMateoStatusParser(HTMLParser):
    """Collect the bounded block structure around the County's current notice."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._tag: str | None = None
        self._parts: list[str] = []
        self.blocks: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag in {"h3", "h6", "p", "li"} and self._tag is None:
            self._tag = tag
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._tag is not None:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == self._tag:
            text = normalize_label(" ".join(self._parts), preserve_case=True)
            if text:
                self.blocks.append((tag, text))
            self._tag = None
            self._parts = []


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
    for source_id in BEACHWATCH_SOURCE_IDS:
        beachwatch_source = sources[source_id]
        global_station_ids = beachwatch_source.get("global_station_ids")
        if (
            not isinstance(global_station_ids, list)
            or not global_station_ids
            or not all(
                isinstance(value, str) and BEACHWATCH_STATION_ID_PATTERN.fullmatch(value)
                for value in global_station_ids
            )
        ):
            raise WaterQualityError("invalid-global-station-map")
    san_mateo_source = sources[SAN_MATEO_SOURCE_ID]
    if (
        not isinstance(san_mateo_source.get("station_registry_url"), str)
        or not san_mateo_source["station_registry_url"].startswith("https://data.smcgov.org/")
        or san_mateo_source.get("station_registry_machine_url")
        != "https://datahub.smcgov.org/api/id/kpd9-xf4h.json"
    ):
        raise WaterQualityError("invalid-station-registry-url")
    station_aliases = san_mateo_source.get("station_aliases")
    if not isinstance(station_aliases, dict) or not station_aliases:
        raise WaterQualityError("invalid-station-alias-map")
    normalized_aliases: set[str] = set()
    for station_id, aliases in station_aliases.items():
        if (
            not isinstance(station_id, str)
            or not STATION_ID_PATTERN.fullmatch(station_id)
            or not isinstance(aliases, list)
            or not aliases
        ):
            raise WaterQualityError("invalid-station-alias-map")
        for alias in aliases:
            normalized = normalize_label(alias)
            if not normalized or normalized in normalized_aliases:
                raise WaterQualityError("invalid-station-alias-map")
            normalized_aliases.add(normalized)
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
        if len(set(station_ids)) != len(station_ids) or not all(
            isinstance(value, str) for value in station_ids
        ):
            raise WaterQualityError("invalid-station-map")
        if source_id in BEACHWATCH_SOURCE_IDS and not all(
            BEACHWATCH_STATION_ID_PATTERN.fullmatch(station_id) for station_id in station_ids
        ):
            raise WaterQualityError("invalid-beachwatch-station-map")
        if source_id not in BEACHWATCH_SOURCE_IDS and not all(
            STATION_ID_PATTERN.fullmatch(station_id) for station_id in station_ids
        ):
            raise WaterQualityError("invalid-station-map")
        if source_id == SFP_SOURCE_ID and (
            not station_ids or not all(station_id.isdigit() for station_id in station_ids)
        ):
            raise WaterQualityError("invalid-sfpuc-station-map")
        if source_id == SAN_MATEO_SOURCE_ID and (
            not station_ids or not all(station_id in station_aliases for station_id in station_ids)
        ):
            raise WaterQualityError("invalid-san-mateo-station-map")
    return policy, sites, policy_bytes


def fetch_source(source_id: str, source: dict[str, Any]) -> bytes:
    headers = {"User-Agent": USER_AGENT}
    data = None
    if source_id == SFP_SOURCE_ID:
        headers["Accept"] = "application/xml,text/xml"
    elif source_id in BEACHWATCH_SOURCE_IDS:
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
    elif source_id == SAN_MATEO_SOURCE_ID:
        headers["Accept"] = "text/html"
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
        if not station_id or not BEACHWATCH_STATION_ID_PATTERN.fullmatch(station_id):
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


def normalize_label(value: Any, *, preserve_case: bool = False) -> str:
    text = clean_text(value, maximum=240) or ""
    text = " ".join(text.replace("\u200b", "").split())
    return text if preserve_case else text.casefold()


def notice_date(value: str) -> date | None:
    match = re.search(
        r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+"
        r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+"
        r"(\d{1,2}),\s+(\d{4})\b",
        value,
    )
    if match is None:
        return None
    try:
        return datetime.strptime(" ".join(match.groups()), "%B %d %Y").date()
    except ValueError:
        return None


def parse_san_mateo_records(
    body: bytes, source: dict[str, Any], as_of: datetime
) -> dict[str, Any]:
    try:
        text = body.decode("utf-8")
    except UnicodeError as exc:
        raise WaterQualityError("invalid-source-payload") from exc
    parser = SanMateoStatusParser()
    try:
        parser.feed(text)
        parser.close()
    except Exception as exc:
        raise WaterQualityError("invalid-source-payload") from exc
    notice_indexes = [
        index
        for index, (tag, value) in enumerate(parser.blocks)
        if tag == "h3" and normalize_label(value) == "important notice:"
    ]
    if len(notice_indexes) != 1:
        raise WaterQualityError("invalid-source-record-set")
    notice_index = notice_indexes[0]
    notice_candidates = [
        value
        for tag, value in parser.blocks[notice_index + 1 :]
        if tag == "p" and normalize_label(value).startswith("the following list was last updated ")
    ]
    if len(notice_candidates) != 1:
        raise WaterQualityError("invalid-source-record-set")
    notice = notice_candidates[0]
    parts = re.split(r"\bbased on samples collected\b", notice, maxsplit=1, flags=re.IGNORECASE)
    if len(parts) != 2:
        raise WaterQualityError("invalid-source-record-set")
    updated_date = notice_date(parts[0])
    sample_date_value = notice_date(parts[1])
    current_date = as_of.astimezone(PACIFIC).date()
    if (
        updated_date is None
        or sample_date_value is None
        or sample_date_value > updated_date
        or updated_date > current_date
    ):
        raise WaterQualityError("invalid-source-date")
    listing_indexes = [
        index
        for index, (tag, value) in enumerate(parser.blocks[notice_index + 1 :], start=notice_index + 1)
        if tag == "p"
        and normalize_label(value)
        == "the following locations have elevated levels of indicator bacteria and are posted with warning and/or closure signs."
    ]
    if len(listing_indexes) != 1:
        raise WaterQualityError("invalid-source-record-set")
    sections: dict[str, list[str]] = {section: [] for section in SAN_MATEO_SECTIONS}
    current_section: str | None = None
    seen_sections: list[str] = []
    reached_end = False
    for tag, value in parser.blocks[listing_indexes[0] + 1 :]:
        normalized = normalize_label(value).rstrip(":")
        if tag == "p" and normalized.startswith("signs limiting the recreational use of these waters"):
            reached_end = True
            break
        if tag == "h6":
            expected_index = len(seen_sections)
            if (
                expected_index >= len(SAN_MATEO_SECTIONS)
                or normalized != SAN_MATEO_SECTIONS[expected_index]
            ):
                raise WaterQualityError("invalid-source-record-set")
            seen_sections.append(normalized)
            current_section = normalized
        elif tag == "li":
            if current_section is None:
                raise WaterQualityError("invalid-source-record-set")
            sections[current_section].append(value)
    listings = [item for section in SAN_MATEO_SECTIONS for item in sections[section]]
    if (
        not reached_end
        or tuple(seen_sections) != SAN_MATEO_SECTIONS
        or not listings
        or len(listings) > MAX_SAN_MATEO_POSTINGS
        or len({normalize_label(item) for item in listings}) != len(listings)
    ):
        raise WaterQualityError("invalid-source-record-set")
    aliases_by_label = {
        normalize_label(alias): station_id
        for station_id, aliases in source["station_aliases"].items()
        for alias in aliases
    }
    postings: dict[str, dict[str, str]] = {}
    unknown_listings: list[str] = []
    for section, values in sections.items():
        for value in values:
            station_id = aliases_by_label.get(normalize_label(value))
            if station_id is None:
                unknown_listings.append(value)
                continue
            if station_id in postings:
                raise WaterQualityError("duplicate-source-station-id")
            postings[station_id] = {
                "station_name": clean_text(value) or "Unnamed station",
                "section": section,
            }
    return {
        "updated_date": updated_date,
        "sample_date": sample_date_value,
        "postings": postings,
        "unknown_listings": unknown_listings,
    }


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
    source_id: str,
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
                source_id=source_id,
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
            source_id=source_id,
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


def assess_san_mateo_site(
    station_ids: list[str],
    records: dict[str, Any],
    as_of: datetime,
    source_url: str,
) -> dict[str, Any]:
    postings = records["postings"]
    selected = [postings[station_id] for station_id in station_ids if station_id in postings]
    sample_dates = [records["sample_date"].isoformat()]
    if selected:
        return {
            **assessment_base(
                source_id=SAN_MATEO_SOURCE_ID,
                station_ids=[station_id for station_id in station_ids if station_id in postings],
                station_names=sorted({record["station_name"] for record in selected}),
                as_of=as_of,
                source_url=source_url,
                sample_dates=sample_dates,
            ),
            "status": "posted",
            "recommendationEffect": "suppress",
            "officialLabel": "Official water-contact warning or closure",
            "detail": "The current County Health posting list names an exact reviewed station for this site, so the recommendation is suppressed.",
        }
    return {
        **assessment_base(
            source_id=SAN_MATEO_SOURCE_ID,
            station_ids=station_ids,
            station_names=[],
            as_of=as_of,
            source_url=source_url,
            sample_dates=[],
        ),
        "status": "unknown",
        "recommendationEffect": "unknown",
        "officialLabel": "No current county posting verified",
        "detail": "No exact mapped station appeared in the current County Health posting list. Because unlisted or unsampled status does not prove no posting, this site remains unknown.",
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
                if source_id in BEACHWATCH_SOURCE_IDS:
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
            elif source_id == SAN_MATEO_SOURCE_ID:
                assessment = assess_san_mateo_site(
                    station_ids,
                    source_records[source_id],
                    as_of,
                    source["status_url"],
                )
            elif source_id in BEACHWATCH_SOURCE_IDS:
                assessment = assess_beachwatch_site(
                    source_id,
                    station_ids,
                    source["global_station_ids"],
                    source_records[source_id],
                    as_of,
                    source["status_url"],
                )
            else:
                raise WaterQualityError("untrusted-source-id")
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
    parser.add_argument(
        "--marin-beachwatch-source-file",
        type=Path,
        help="Read a Marin California BeachWatch HTML fixture instead of the network",
    )
    parser.add_argument(
        "--san-mateo-source-file",
        type=Path,
        help="Read a San Mateo County Health HTML fixture instead of the network",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    as_of = parse_as_of(args.as_of)
    policy, sites, policy_bytes = load_inputs()
    fixture_paths = {
        SFP_SOURCE_ID: args.sfpuc_source_file,
        SANTA_BARBARA_BEACHWATCH_SOURCE_ID: args.beachwatch_source_file,
        MARIN_BEACHWATCH_SOURCE_ID: args.marin_beachwatch_source_file,
        SAN_MATEO_SOURCE_ID: args.san_mateo_source_file,
    }
    source_records: dict[str, Any] = {}
    source_errors: dict[str, str | None] = {source_id: None for source_id in policy["sources"]}
    for source_id, source in policy["sources"].items():
        try:
            fixture_path = fixture_paths[source_id]
            body = fixture_path.read_bytes() if fixture_path else fetch_source(source_id, source)
            if source_id == SFP_SOURCE_ID:
                source_records[source_id] = parse_sfpuc_records(body)
            elif source_id in BEACHWATCH_SOURCE_IDS:
                source_records[source_id] = parse_beachwatch_records(
                    body, source["county_name"], as_of
                )
            else:
                source_records[source_id] = parse_san_mateo_records(body, source, as_of)
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
