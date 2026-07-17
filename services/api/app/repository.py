from __future__ import annotations

import json
import logging
import math
import os
import re
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    OPPORTUNITY_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    is_strict_offset_datetime,
    validate_contract_assets,
)

from .models import (
    ComponentScores,
    Confidence,
    CurrentConditions,
    ExplanationFactor,
    FishingMode,
    FreshnessStatus,
    OpportunityStatus,
    OpportunityWindow,
    SiteDetail,
    SiteSummary,
    SourceFreshness,
)

LOGGER = logging.getLogger(__name__)

BAY_REGULATIONS = "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay"
COAST_REGULATIONS = "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/San-Francisco"

FRESHNESS_LIMITS = {
    "weather": 120,
    "nws": 120,
    "tides": 120,
    "currents": 120,
    "buoy": 180,
    "ocean": 480,
    "sst": 480,
    "water_temperature": 1_800,
    "chlorophyll": 720,
    # Versioned historical artifacts age on a model-governance cadence, not an
    # hourly-conditions cadence. Their provisional quality is exposed in the
    # source name/model version; they are still truthfully marked as used by
    # the demo score.
    "bathymetry": 10_512_000,
    "catch_history": 2_628_000,
    "seasonality": 2_628_000,
}


class DataUnavailableError(RuntimeError):
    pass


OPPORTUNITY_CONTRACT_FIELDS = {
    "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
    "taxon_catalog_version": TAXON_CATALOG_VERSION,
    "observation_contract_version": OBSERVATION_CONTRACT_VERSION,
    "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
    "opportunity_contract_version": OPPORTUNITY_CONTRACT_VERSION,
}

STATIC_WINDOW_REQUIRED_FIELDS = {
    "id",
    "species",
    "target_taxon_id",
    "taxon_catalog_version",
    "observation_contract_version",
    "model_run_contract_version",
    "opportunity_contract_version",
    "scoring_system_kind",
    "scoring_system_sha256",
    "siteId",
    "start",
    "end",
    "score",
    "habitatScore",
    "seasonalityScore",
    "dynamicScore",
    "fishabilityScore",
    "modelVersion",
    "confidence",
}
NORMALIZED_WINDOW_REQUIRED_FIELDS = {
    "id",
    "species",
    "target_taxon_id",
    "taxon_catalog_version",
    "observation_contract_version",
    "model_run_contract_version",
    "opportunity_contract_version",
    "scoring_system_kind",
    "scoring_system_version",
    "scoring_system_sha256",
    "site",
    "start_time",
    "end_time",
    "opportunity_score",
    "components",
    "model_version",
    "confidence",
}
STATIC_WINDOW_FORBIDDEN_FIELDS = {
    "site",
    "start_time",
    "end_time",
    "opportunity_score",
    "model_version",
    "scoring_system_version",
}
NORMALIZED_WINDOW_FORBIDDEN_FIELDS = {
    "siteId",
    "start",
    "end",
    "score",
    "modelVersion",
}
COMPONENT_SCORE_FIELDS = frozenset(
    {
        "habitat_score",
        "seasonality_score",
        "dynamic_score",
        "fishability_score",
    }
)


def validate_snapshot_window_shape(raw: dict[str, Any], *, location: str) -> None:
    """Reject partial or hybrid windows rather than repairing them through aliases."""

    fields = set(raw)
    looks_static = bool(fields & {"siteId", "start", "end", "score", "modelVersion"})
    looks_normalized = bool(
        fields & {"site", "start_time", "end_time", "opportunity_score", "model_version"}
    )
    if looks_static == looks_normalized:
        raise DataUnavailableError(f"{location} must use exactly one opportunity representation")
    required = STATIC_WINDOW_REQUIRED_FIELDS if looks_static else NORMALIZED_WINDOW_REQUIRED_FIELDS
    forbidden = STATIC_WINDOW_FORBIDDEN_FIELDS if looks_static else NORMALIZED_WINDOW_FORBIDDEN_FIELDS
    missing = required - fields
    present_forbidden = forbidden & fields
    if missing or present_forbidden:
        raise DataUnavailableError(
            f"{location} is malformed; missing={sorted(missing)}, "
            f"forbidden={sorted(present_forbidden)}"
        )
    confidence = raw.get("confidence")
    if looks_static:
        if not isinstance(confidence, str) or confidence not in {"low", "medium", "high"}:
            raise DataUnavailableError(f"{location} static confidence must be low, medium, or high")
    elif (
        not isinstance(confidence, dict)
        or not isinstance(confidence.get("level"), str)
        or confidence.get("level") not in {"low", "medium", "high"}
    ):
        raise DataUnavailableError(f"{location} normalized confidence must contain a valid level")
    if not looks_static:
        components = raw.get("components")
        if not isinstance(components, dict) or not COMPONENT_SCORE_FIELDS <= set(components):
            raise DataUnavailableError(
                f"{location} normalized components must contain all four component scores"
            )


def validate_database_window_shape(raw: dict[str, Any], *, location: str) -> None:
    """Require the canonical JSONB storage shape before any normalization."""

    confidence = raw.get("confidence")
    if (
        not isinstance(confidence, dict)
        or not isinstance(confidence.get("level"), str)
        or confidence.get("level") not in {"low", "medium", "high"}
    ):
        raise DataUnavailableError(
            f"{location} database confidence must be an object with a valid level"
        )
    components = raw.get("components")
    if not isinstance(components, dict) or not COMPONENT_SCORE_FIELDS <= set(components):
        raise DataUnavailableError(
            f"{location} database components must explicitly contain all four scores"
        )


def opportunity_identity(raw: dict[str, Any]) -> dict[str, str]:
    return {
        **OPPORTUNITY_CONTRACT_FIELDS,
        "species": str(raw["species"]),
        "scoring_system_kind": str(raw["scoring_system_kind"]),
        "scoring_system_version": str(raw["scoring_system_version"]),
        "scoring_system_sha256": str(raw["scoring_system_sha256"]),
    }


def validate_opportunity_contract(raw: dict[str, Any], *, location: str) -> None:
    """Reject incomplete, cross-target, or cross-version opportunity artifacts."""

    for field, expected in OPPORTUNITY_CONTRACT_FIELDS.items():
        actual = raw.get(field)
        if actual != expected:
            raise DataUnavailableError(
                f"{location} has invalid {field}: expected {expected!r}, got {actual!r}"
            )
    if raw.get("species") != raw["target_taxon_id"]:
        raise DataUnavailableError(f"{location} species must exactly match target_taxon_id")
    model_version = raw.get("model_version", raw.get("modelVersion"))
    if not isinstance(model_version, str) or not model_version.strip():
        raise DataUnavailableError(f"{location} has no model_version")
    scoring_kind = raw.get("scoring_system_kind")
    if scoring_kind not in {"heuristic-configuration", "trained-model"}:
        raise DataUnavailableError(f"{location} has invalid scoring_system_kind")
    scoring_version = raw.get("scoring_system_version", raw.get("modelVersion"))
    if not isinstance(scoring_version, str) or not scoring_version.strip():
        raise DataUnavailableError(f"{location} has no scoring_system_version")
    scoring_sha256 = raw.get("scoring_system_sha256")
    if not isinstance(scoring_sha256, str) or re.fullmatch(r"[a-f0-9]{64}", scoring_sha256) is None:
        raise DataUnavailableError(f"{location} has invalid scoring_system_sha256")
    if model_version != scoring_version:
        raise DataUnavailableError(f"{location} model version does not match scoring system version")
    if scoring_kind == "heuristic-configuration":
        expected_version = f"heuristic-{raw['target_taxon_id']}-{scoring_sha256}"
        if scoring_version != expected_version:
            raise DataUnavailableError(
                f"{location} heuristic version must exactly bind its target and SHA-256"
            )
    else:
        expected_prefix = f"model-{raw['target_taxon_id']}-"
        digest = scoring_version.removeprefix(expected_prefix)
        if not scoring_version.startswith(expected_prefix) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
            raise DataUnavailableError(f"{location} trained-model version is not content addressed")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_datetime(value: Any, *, default: datetime | None = None) -> datetime | None:
    if value in (None, ""):
        return default
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        if not is_strict_offset_datetime(value):
            raise DataUnavailableError(
                f"Timestamp must use strict ISO-8601 with Z or an explicit offset: {value!r}"
            )
        text = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError as exc:
            raise DataUnavailableError(f"Invalid timestamp in data snapshot: {value!r}") from exc
    else:
        raise DataUnavailableError(f"Invalid timestamp type in data snapshot: {value!r}")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DataUnavailableError(f"Timestamp must include an explicit UTC offset: {value!r}")
    return parsed.astimezone(timezone.utc)


def _slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _first(raw: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in raw and raw[name] is not None:
            return raw[name]
    return default


def _normalize_modes(value: Any) -> list[FishingMode]:
    values = value if isinstance(value, list) else [value or "shore"]
    modes: list[FishingMode] = []
    for item in values:
        token = str(item).lower().strip().replace("_", "-")
        if "pier" in token or "wharf" in token:
            mode = FishingMode.PIER
        elif "jetty" in token or "breakwater" in token:
            mode = FishingMode.JETTY
        elif "beach" in token or "surf" in token:
            mode = FishingMode.BEACH
        else:
            mode = FishingMode.SHORE
        if mode not in modes:
            modes.append(mode)
    return modes


def normalize_site(raw: dict[str, Any]) -> SiteDetail:
    location = raw.get("location") if isinstance(raw.get("location"), dict) else {}
    coordinates = raw.get("coordinates")
    if isinstance(coordinates, (list, tuple)) and len(coordinates) >= 2:
        coordinate_lon, coordinate_lat = coordinates[0], coordinates[1]
    elif isinstance(coordinates, dict):
        coordinate_lat = _first(coordinates, "latitude", "lat")
        coordinate_lon = _first(coordinates, "longitude", "lon", "lng")
    else:
        coordinate_lat = coordinate_lon = None

    latitude = _first(raw, "latitude", "lat", default=_first(location, "latitude", "lat", default=coordinate_lat))
    longitude = _first(
        raw,
        "longitude",
        "lon",
        "lng",
        default=_first(location, "longitude", "lon", "lng", default=coordinate_lon),
    )
    if latitude is None or longitude is None:
        raise DataUnavailableError(f"Site {raw.get('id') or raw.get('name')!r} has no coordinates")

    name = str(_first(raw, "name", "site_name", default="Unnamed fishing site"))
    site_id = str(_first(raw, "id", "slug", "site_id", default=_slugify(name)))
    region = str(_first(raw, "region", "area", "zone", default="San Francisco Bay"))
    regulation_url = str(
        _first(
            raw,
            "regulation_url",
            "regulationUrl",
            "regulations_url",
            default=BAY_REGULATIONS if "bay" in region.lower() else COAST_REGULATIONS,
        )
    )
    access_notes = str(
        _first(
            raw,
            "access_notes",
            "access",
            default="Confirm current public access, hours, parking, and posted closures before leaving.",
        )
    )
    official_links = raw.get("official_links") or []
    if not official_links:
        official_links = [{"label": "Current CDFW regulations", "url": regulation_url, "kind": "regulations"}]
        if raw.get("accessSourceUrl"):
            official_links.append(
                {"label": "Official access information", "url": raw["accessSourceUrl"], "kind": "access"}
            )

    access_status = str(_first(raw, "access_status", "accessStatus", default="open")).lower()
    is_accessible = bool(
        _first(
            raw,
            "is_accessible",
            "accessible",
            default=access_status not in {"closed", "inaccessible"},
        )
    )

    site_payload = {
        **raw,
        "id": site_id,
        "name": name,
        "region": region,
        "locality": _first(raw, "locality", "city"),
        "latitude": float(latitude),
        "longitude": float(longitude),
        "fishing_modes": _normalize_modes(_first(raw, "fishing_modes", "modes", "mode", "type")),
        "access_type": str(_first(raw, "access_type", default="public")),
        "is_accessible": is_accessible,
        "structure_tags": list(_first(raw, "structure_tags", "structureTags", "structures", default=[])),
        "regulation_url": regulation_url,
        "description": _first(raw, "description", "summary"),
        "access_notes": access_notes,
        "parking_notes": _first(raw, "parking_notes", "parking"),
        "transit_notes": _first(raw, "transit_notes", "transit"),
        "amenities": list(_first(raw, "amenities", default=[])),
        "bathymetry_summary": _first(raw, "bathymetry_summary", "bathymetry", "depthProfile"),
        "casting_zone": _first(raw, "casting_zone", "castingZone"),
        "official_links": official_links,
        "data_freshness": normalize_freshness(raw.get("data_freshness") or [], checked_at=utc_now(), fill_defaults=False),
    }
    return SiteDetail.model_validate(site_payload)


def _iter_freshness(raw: Any) -> Iterable[dict[str, Any]]:
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                yield item
    elif isinstance(raw, dict):
        for source, value in raw.items():
            if isinstance(value, dict):
                yield {"source": source, **value}
            else:
                yield {"source": source, "status": value}


def normalize_freshness(
    raw: Any,
    *,
    checked_at: datetime,
    fill_defaults: bool = True,
) -> list[SourceFreshness]:
    entries = list(_iter_freshness(raw))
    if fill_defaults and not entries:
        entries = [{"source": source} for source in ("bathymetry", "catch_history", "tides", "weather", "ocean")]

    normalized: list[SourceFreshness] = []
    for entry in entries:
        source = str(entry.get("source") or entry.get("name") or "unknown")
        source_key = source.lower().replace(" ", "_")
        limit = int(
            _first(
                entry,
                "freshness_limit_minutes",
                "max_age_minutes",
                default=(
                    float(_first(entry, "max_age_hours", "freshnessLimitHours")) * 60
                    if _first(entry, "max_age_hours", "freshnessLimitHours") is not None
                    else None
                ),
            )
            or FRESHNESS_LIMITS.get(source_key, 360)
        )
        observed_at = as_datetime(_first(entry, "observed_at", "observedAt", "updated_at", "timestamp"))
        item_checked_at = as_datetime(_first(entry, "checked_at", "checkedAt"), default=checked_at) or checked_at
        raw_status = str(entry.get("status") or "").lower()
        raw_used = bool(_first(entry, "used_in_score", "included", default=True))

        explicit_exclusion = any(
            marker in raw_status
            for marker in ("excluded", "not integrated", "not-integrated", "not-scored")
        )
        if explicit_exclusion or not raw_used:
            age_minutes = (
                max(0, int((item_checked_at - observed_at).total_seconds() // 60)) if observed_at is not None else None
            )
            status = FreshnessStatus.EXCLUDED
            used = False
            reason = str(
                entry.get("excluded_reason")
                or entry.get("excludedReason")
                or raw_status
                or "Source failed an upstream quality or availability check."
            )
        elif observed_at is None:
            age_minutes = None
            status = FreshnessStatus.MISSING
            used = False
            reason = str(
                entry.get("excluded_reason") or entry.get("excludedReason") or "No observation was available for this source."
            )
        else:
            age_minutes = max(0, int((item_checked_at - observed_at).total_seconds() // 60))
            if age_minutes > limit:
                status = FreshnessStatus.STALE
                used = False
                reason = str(
                    entry.get("excluded_reason")
                    or f"Observation is {age_minutes} minutes old; the limit is {limit} minutes."
                )
            elif raw_status == "missing":
                status = FreshnessStatus.EXCLUDED
                used = False
                reason = str(
                    entry.get("excluded_reason")
                    or entry.get("excludedReason")
                    or "Source failed an upstream quality or availability check."
                )
            else:
                status = FreshnessStatus.FRESH
                used = True
                reason = None

        normalized.append(
            SourceFreshness(
                source=source,
                observed_at=observed_at,
                checked_at=item_checked_at,
                age_minutes=age_minutes,
                freshness_limit_minutes=limit,
                status=status,
                used_in_score=used,
                excluded_reason=reason,
            )
        )
    return normalized


def _site_summary(site: SiteDetail) -> SiteSummary:
    return SiteSummary.model_validate(site.model_dump())


def _bounded_score(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DataUnavailableError(f"{location} must be a numeric score")
    try:
        score = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise DataUnavailableError(f"{location} must be a finite numeric score") from exc
    if not math.isfinite(score) or not 0 <= score <= 100:
        raise DataUnavailableError(f"{location} must be finite and between 0 and 100")
    return score


def _bounded_number(value: Any, *, location: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DataUnavailableError(f"{location} must be numeric")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise DataUnavailableError(f"{location} must be finite") from exc
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise DataUnavailableError(f"{location} must be finite and between {minimum} and {maximum}")
    return number


def _component_score(
    raw: dict[str, Any],
    components: dict[str, Any],
    *keys: str,
    default: float | None,
) -> float:
    value = _first(components, *keys, default=_first(raw, *keys, default=default))
    return _bounded_score(value, location=f"Opportunity component {keys[0]}")


def normalize_opportunity(
    raw: dict[str, Any],
    *,
    sites: dict[str, SiteDetail],
    snapshot_generated_at: datetime,
) -> OpportunityWindow:
    validate_opportunity_contract(raw, location=f"Opportunity {raw.get('id')!r}")
    site_raw = raw.get("site")
    if isinstance(site_raw, dict):
        site = normalize_site(site_raw)
    else:
        site_id = str(_first(raw, "site_id", "siteId", default=site_raw or ""))
        site = sites.get(site_id)
        if site is None:
            raise DataUnavailableError(f"Opportunity references unknown site {site_id!r}")

    start_time = as_datetime(_first(raw, "start_time", "start", "starts_at"))
    if start_time is None:
        raise DataUnavailableError(f"Opportunity for {site.id!r} has no start time")
    end_time = as_datetime(_first(raw, "end_time", "end", "ends_at"))
    if end_time is None or end_time <= start_time:
        raise DataUnavailableError(f"Opportunity for {site.id!r} has an invalid end time")

    generated_at = as_datetime(_first(raw, "generated_at", "generatedAt"), default=snapshot_generated_at) or snapshot_generated_at
    components_raw = raw.get("components") if isinstance(raw.get("components"), dict) else {}
    multiplier = _first(components_raw, "seasonality_multiplier", default=raw.get("seasonality_multiplier"))
    modifier = _first(components_raw, "dynamic_modifier", default=raw.get("dynamic_modifier"))
    normalized_multiplier = (
        None
        if multiplier is None
        else _bounded_number(multiplier, location="seasonality_multiplier", minimum=0, maximum=3)
    )
    normalized_modifier = (
        None
        if modifier is None
        else _bounded_number(modifier, location="dynamic_modifier", minimum=-0.5, maximum=0.5)
    )
    components = ComponentScores(
        habitat_score=_component_score(
            raw,
            components_raw,
            "habitat_score",
            "habitatScore",
            "habitat",
            default=None,
        ),
        seasonality_score=_component_score(
            raw,
            components_raw,
            "seasonality_score",
            "seasonalityScore",
            "seasonality",
            default=None,
        ),
        dynamic_score=_component_score(
            raw,
            components_raw,
            "dynamic_score",
            "dynamicScore",
            "dynamic",
            default=None,
        ),
        fishability_score=_component_score(
            raw,
            components_raw,
            "fishability_score",
            "fishabilityScore",
            default=None,
        ),
        seasonality_multiplier=normalized_multiplier,
        dynamic_modifier=normalized_modifier,
    )

    confidence_raw = raw.get("confidence")
    if isinstance(confidence_raw, dict):
        level = confidence_raw.get("level")
        if not isinstance(level, str) or level not in {"low", "medium", "high"}:
            raise DataUnavailableError("normalized opportunity confidence has an invalid level")
        confidence_score = confidence_raw.get("score")
        if confidence_score is not None:
            confidence_score = _bounded_number(
                confidence_score,
                location="confidence.score",
                minimum=0,
                maximum=1,
            )
        confidence = Confidence(
            level=level,
            score=confidence_score,
            reasons=list(confidence_raw.get("reasons") or []),
        )
    else:
        if not isinstance(confidence_raw, str) or confidence_raw not in {"low", "medium", "high"}:
            raise DataUnavailableError("static opportunity confidence has an invalid level")
        confidence = Confidence(level=confidence_raw)

    factors_raw = _first(
        raw, "explanation_factors", "explanationFactors", "factors", "explanations", default=[]
    )
    factors: list[ExplanationFactor] = []
    for factor in factors_raw:
        if isinstance(factor, str):
            factors.append(ExplanationFactor(label=factor, direction="neutral", detail=factor))
        elif isinstance(factor, dict):
            detail = str(_first(factor, "detail", "description", "text", default=factor.get("label") or "Model factor"))
            factors.append(
                ExplanationFactor(
                    label=str(factor.get("label") or factor.get("name") or "Model factor"),
                    direction=str(factor.get("direction") or "neutral").lower(),
                    impact=factor.get("impact"),
                    detail=detail,
                    source=factor.get("source"),
                )
            )

    freshness = normalize_freshness(
        _first(raw, "source_freshness", "sourceFreshness", "freshness", default=[]),
        checked_at=utc_now(),
        fill_defaults=True,
    )
    excluded = [item for item in freshness if not item.used_in_score]
    if excluded and len(excluded) == len(freshness):
        status = OpportunityStatus.STALE
    elif excluded:
        status = OpportunityStatus.PARTIAL
    else:
        status = OpportunityStatus.FRESH

    score = _bounded_score(
        _first(raw, "opportunity_score", "total_score", "score", default=None),
        location=f"Opportunity {raw.get('id')!r} score",
    )
    conditions_raw = raw.get("conditions") if isinstance(raw.get("conditions"), dict) else None
    conditions = None
    if conditions_raw is not None:
        conditions = CurrentConditions(
            tide_stage=_first(conditions_raw, "tide_stage", "tideStage"),
            current_knots=_first(conditions_raw, "current_knots", "currentKnots"),
            current_direction_degrees=_first(
                conditions_raw, "current_direction_degrees", "currentDirectionDegrees"
            ),
            current_direction=_first(conditions_raw, "current_direction", "currentDirection"),
            wind_mph=_first(conditions_raw, "wind_mph", "windMph"),
            swell_feet=_first(conditions_raw, "swell_feet", "swellFeet"),
            swell_period_seconds=_first(conditions_raw, "swell_period_seconds", "swellPeriodSeconds"),
            swell_direction_degrees=_first(
                conditions_raw, "swell_direction_degrees", "swellDirectionDegrees"
            ),
            swell_direction=_first(conditions_raw, "swell_direction", "swellDirection"),
            wave_power_kw_m=_first(conditions_raw, "wave_power_kw_m", "wavePowerKwM"),
            breaking_intensity=_first(conditions_raw, "breaking_intensity", "breakingIntensity"),
            breaking_wave_height_feet=_first(
                conditions_raw, "breaking_wave_height_feet", "breakingWaveHeightFeet"
            ),
            fishability_label=_first(conditions_raw, "fishability_label", "fishabilityLabel"),
            fishability_reasons=list(
                _first(conditions_raw, "fishability_reasons", "fishabilityReasons", default=[])
            ),
            water_temp_f=_first(conditions_raw, "water_temp_f", "waterTempF"),
            water_temp_source=_first(conditions_raw, "water_temp_source", "waterTempSource"),
            ndbc_observed_water_temp_f=_first(
                conditions_raw,
                "ndbc_observed_water_temp_f",
                "ndbcObservedWaterTempF",
            ),
            ndbc_observed_at=as_datetime(
                _first(conditions_raw, "ndbc_observed_at", "ndbcObservedAt")
            ),
            daylight=conditions_raw.get("daylight"),
            cloud_cover_pct=_first(conditions_raw, "cloud_cover_pct", "cloudCoverPct"),
            pressure_hpa=_first(conditions_raw, "pressure_hpa", "pressureHpa"),
            pressure_trend_hpa_3h=_first(conditions_raw, "pressure_trend_hpa_3h", "pressureTrendHpa3h"),
            moon_phase=_first(conditions_raw, "moon_phase", "moonPhase"),
            moon_illumination_pct=_first(conditions_raw, "moon_illumination_pct", "moonIlluminationPct"),
            fishing_pressure=_first(conditions_raw, "fishing_pressure", "fishingPressure"),
            fishing_pressure_pct=_first(conditions_raw, "fishing_pressure_pct", "fishingPressurePct"),
            access_adjustment_points=_first(
                conditions_raw, "access_adjustment_points", "accessAdjustmentPoints"
            ),
            fishing_pressure_basis=_first(
                conditions_raw, "fishing_pressure_basis", "fishingPressureBasis"
            ),
        )
    opportunity_id = raw.get("id")
    if (
        not isinstance(opportunity_id, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", opportunity_id) is None
    ):
        raise DataUnavailableError("Opportunity id must be a normalized stable identifier")
    return OpportunityWindow(
        id=opportunity_id,
        species=str(raw["species"]),
        target_taxon_id=str(raw["target_taxon_id"]),
        taxon_catalog_version=str(raw["taxon_catalog_version"]),
        observation_contract_version=str(raw["observation_contract_version"]),
        model_run_contract_version=str(raw["model_run_contract_version"]),
        opportunity_contract_version=str(raw["opportunity_contract_version"]),
        scoring_system_kind=str(raw["scoring_system_kind"]),
        scoring_system_version=str(raw.get("scoring_system_version", raw.get("modelVersion"))),
        scoring_system_sha256=str(raw["scoring_system_sha256"]),
        site=_site_summary(site),
        start_time=start_time,
        end_time=end_time,
        opportunity_score=score,
        components=components,
        confidence=confidence,
        explanation_factors=factors,
        model_version=str(_first(raw, "model_version", "modelVersion")),
        generated_at=generated_at,
        status=status,
        source_freshness=freshness,
        conditions=conditions,
        rank=raw.get("rank"),
    )


class Repository(ABC):
    source = "unknown"

    @abstractmethod
    def list_sites(self) -> tuple[list[SiteDetail], str]:
        raise NotImplementedError

    @abstractmethod
    def get_site(self, site_id: str) -> tuple[SiteDetail | None, str]:
        raise NotImplementedError

    @abstractmethod
    def list_opportunities(
        self, species: str, from_time: datetime, through: datetime
    ) -> tuple[list[OpportunityWindow], datetime, dict[str, str], str]:
        raise NotImplementedError


class FileRepository(Repository):
    source = "file-snapshot"

    def __init__(self, root: Path):
        self.root = root
        self.sites_path = root / "data" / "sites.json"
        self.opportunities_path = root / "public" / "data" / "opportunities.json"

    @staticmethod
    def _read_json(path: Path) -> Any:
        def reject_nonfinite(value: str) -> None:
            raise ValueError(f"non-finite JSON constant {value!r}")

        try:
            return json.loads(
                path.read_text(encoding="utf-8"),
                parse_constant=reject_nonfinite,
            )
        except FileNotFoundError as exc:
            raise DataUnavailableError(f"Required data snapshot is unavailable: {path}") from exc
        except (json.JSONDecodeError, ValueError) as exc:
            raise DataUnavailableError(f"Data snapshot is invalid JSON: {path}") from exc

    def list_sites(self) -> tuple[list[SiteDetail], str]:
        document = self._read_json(self.sites_path)
        records = document.get("sites", document.get("data", [])) if isinstance(document, dict) else document
        if not isinstance(records, list):
            raise DataUnavailableError("sites.json must contain a list or a {sites: [...]} object")
        sites = [
            site
            for item in records
            if isinstance(item, dict)
            for site in [normalize_site(item)]
            if site.is_accessible
        ]
        if not sites:
            raise DataUnavailableError("sites.json contains no usable sites")
        return sites, self.source

    def get_site(self, site_id: str) -> tuple[SiteDetail | None, str]:
        sites, source = self.list_sites()
        return next((site for site in sites if site.id == site_id), None), source

    @staticmethod
    def _source_keys(name: str) -> list[str]:
        token = name.lower()
        if "tide" in token:
            return ["tides"]
        if "weather" in token or "nws" in token:
            return ["weather"]
        if "buoy" in token or "ndbc" in token:
            return ["buoy"]
        if "open-meteo" in token or "marine sst" in token or "water temperature" in token:
            return ["water_temperature"]
        if "recfin" in token or "season" in token:
            return ["seasonality"]
        if "bathymetry" in token or "ncei" in token:
            return ["bathymetry"]
        if "current" in token and ("coastwatch" in token or "satellite" in token):
            return ["currents", "satellite"]
        if "current" in token:
            return ["currents"]
        if "coastwatch" in token or "satellite" in token or "ocean" in token:
            return ["satellite"]
        return [_slugify(name).replace("-", "_")]

    def _snapshot_freshness(self, document: dict[str, Any], window: dict[str, Any]) -> list[dict[str, Any]]:
        catalog: dict[str, dict[str, Any]] = {}
        for raw_source in document.get("sources") or []:
            if not isinstance(raw_source, dict):
                continue
            name = str(raw_source.get("name") or raw_source.get("source") or "unknown")
            for key in self._source_keys(name):
                catalog[key] = {"source": key, **raw_source}

        window_freshness = _first(window, "source_freshness", "sourceFreshness", "freshness", default={})
        if isinstance(window_freshness, list):
            for item in window_freshness:
                if isinstance(item, dict):
                    source = str(item.get("source") or item.get("name") or "unknown")
                    catalog[source] = {**catalog.get(source, {}), **item, "source": source}
        elif isinstance(window_freshness, dict):
            for source, status in window_freshness.items():
                source = "water_temperature" if source == "waterTemperature" else source
                if isinstance(status, dict):
                    catalog[source] = {**catalog.get(source, {}), **status, "source": source}
                else:
                    catalog[source] = {**catalog.get(source, {}), "source": source, "status": status}
        return list(catalog.values())

    def list_opportunities(
        self, species: str, from_time: datetime, through: datetime
    ) -> tuple[list[OpportunityWindow], datetime, dict[str, str], str]:
        document = self._read_json(self.opportunities_path)
        if isinstance(document, dict):
            validate_opportunity_contract(document, location="Opportunity snapshot root")
            identity = opportunity_identity(document)
            records = document.get("windows", document.get("opportunities", document.get("data", [])))
            generated_at = as_datetime(_first(document, "generated_at", "generatedAt"))
            if generated_at is None:
                raise DataUnavailableError("Opportunity snapshot root has no generated_at timestamp")
        else:
            raise DataUnavailableError("opportunities.json must be a versioned root object")
        if not isinstance(records, list):
            raise DataUnavailableError("opportunities.json must contain a list or a {windows: [...]} object")
        if not records:
            raise DataUnavailableError("opportunities.json contains no opportunity windows")

        site_records, _ = self.list_sites()
        sites = {site.id: site for site in site_records}
        windows: list[OpportunityWindow] = []
        for index, item in enumerate(records):
            if not isinstance(item, dict):
                raise DataUnavailableError(
                    f"Opportunity snapshot window {index} must be a JSON object"
                )
            enriched = dict(item)
            if isinstance(document, dict):
                validate_snapshot_window_shape(
                    enriched,
                    location=f"Opportunity {enriched.get('id')!r}",
                )
                enriched["source_freshness"] = self._snapshot_freshness(document, item)
                for field, expected in identity.items():
                    actual = (
                        enriched.get("modelVersion")
                        if field == "scoring_system_version" and "scoring_system_version" not in enriched
                        else enriched.get(field)
                    )
                    if actual != expected:
                        raise DataUnavailableError(
                            f"Opportunity {enriched.get('id')!r} disagrees with root {field}"
                        )
            try:
                windows.append(
                    normalize_opportunity(
                        enriched,
                        sites=sites,
                        snapshot_generated_at=generated_at,
                    )
                )
            except DataUnavailableError:
                raise
            except (TypeError, ValueError, OverflowError) as exc:
                raise DataUnavailableError(
                    f"Opportunity {enriched.get('id')!r} failed normalized validation"
                ) from exc
        filtered = [
            window
            for window in windows
            if window.species == species and window.end_time > from_time and window.start_time < through
        ]
        filtered.sort(key=lambda window: (-window.opportunity_score, window.start_time, window.site.name))
        ranked = [window.model_copy(update={"rank": index}) for index, window in enumerate(filtered, start=1)]
        return ranked, generated_at, identity, self.source


class PostgresRepository(Repository):
    source = "postgres-postgis"

    def __init__(self, database_url: str):
        self.database_url = database_url.replace("postgresql+psycopg://", "postgresql://", 1)

    def _connect(self):
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover - dependency is present in production image
            raise DataUnavailableError("psycopg is required when DATABASE_URL is configured") from exc
        return psycopg.connect(self.database_url, row_factory=dict_row, connect_timeout=5)

    def list_sites(self) -> tuple[list[SiteDetail], str]:
        query = """
            SELECT id, name, region, locality, ST_Y(location::geometry) AS latitude,
                   ST_X(location::geometry) AS longitude, fishing_modes, access_type,
                   is_accessible, structure_tags, regulation_url, description, access_notes,
                   parking_notes, transit_notes, amenities, bathymetry_summary, casting_zone,
                   official_links
              FROM public.sites
             WHERE is_accessible = TRUE
             ORDER BY name
        """
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(query)
            sites = [normalize_site(dict(row)) for row in cursor.fetchall()]
        if not sites:
            raise DataUnavailableError("The database contains no accessible fishing sites")
        return sites, self.source

    def get_site(self, site_id: str) -> tuple[SiteDetail | None, str]:
        query = """
            SELECT id, name, region, locality, ST_Y(location::geometry) AS latitude,
                   ST_X(location::geometry) AS longitude, fishing_modes, access_type,
                   is_accessible, structure_tags, regulation_url, description, access_notes,
                   parking_notes, transit_notes, amenities, bathymetry_summary, casting_zone,
                   official_links
              FROM public.sites
             WHERE id = %s AND is_accessible = TRUE
        """
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, (site_id,))
            row = cursor.fetchone()
            return (normalize_site(dict(row)) if row else None), self.source

    def list_opportunities(
        self, species: str, from_time: datetime, through: datetime
    ) -> tuple[list[OpportunityWindow], datetime, dict[str, str], str]:
        query = """
            SELECT ow.id, ow.species, ow.target_taxon_id, ow.taxon_catalog_version,
                   ow.observation_contract_version, ow.model_run_contract_version,
                   ow.opportunity_contract_version, ow.scoring_system_kind,
                   ow.scoring_system_version, ow.scoring_system_sha256,
                   ow.site_id, ow.start_time, ow.end_time,
                   ow.opportunity_score, ow.components, ow.confidence,
                   ow.conditions, ow.explanation_factors, ow.model_version, ow.generated_at,
                   COALESCE(
                       jsonb_agg(
                           jsonb_build_object(
                               'source', sf.source,
                               'observed_at', sf.observed_at,
                               'checked_at', sf.checked_at,
                               'freshness_limit_minutes', sf.freshness_limit_minutes,
                               'status', sf.status,
                               'used_in_score', sf.used_in_score,
                               'excluded_reason', sf.excluded_reason
                           )
                       ) FILTER (WHERE sf.id IS NOT NULL), '[]'::jsonb
                   ) AS source_freshness
              FROM public.opportunity_windows ow
         LEFT JOIN public.source_freshness sf ON sf.opportunity_window_id = ow.id
             WHERE ow.species = %s
               AND ow.end_time > %s
               AND ow.start_time < %s
          GROUP BY ow.id
          ORDER BY ow.opportunity_score DESC, ow.start_time ASC
        """
        site_records, _ = self.list_sites()
        sites = {site.id: site for site in site_records}
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, (species, from_time, through))
            rows = [dict(row) for row in cursor.fetchall()]
        if rows:
            for index, row in enumerate(rows):
                validate_database_window_shape(
                    row,
                    location=f"Database opportunity row {index}",
                )
            generated_at = max(as_datetime(row.get("generated_at"), default=utc_now()) or utc_now() for row in rows)
            identity = opportunity_identity(rows[0])
            for row in rows[1:]:
                if opportunity_identity(row) != identity:
                    raise DataUnavailableError("database opportunity rows mix scoring identities")
        else:
            raise DataUnavailableError("database query returned no opportunity scoring identity")
        try:
            windows = [
                normalize_opportunity(row, sites=sites, snapshot_generated_at=generated_at)
                for row in rows
            ]
        except DataUnavailableError:
            raise
        except (TypeError, ValueError, OverflowError) as exc:
            raise DataUnavailableError("database opportunity rows failed normalized validation") from exc
        return (
            [window.model_copy(update={"rank": i}) for i, window in enumerate(windows, 1)],
            generated_at,
            identity,
            self.source,
        )


class HybridRepository(Repository):
    def __init__(self, file_repository: FileRepository, database_repository: PostgresRepository | None):
        self.file_repository = file_repository
        self.database_repository = database_repository

    def _call(self, method: str, *args: Any):
        if self.database_repository is not None:
            try:
                return getattr(self.database_repository, method)(*args)
            except Exception as exc:  # fallback must remain available during database incidents
                LOGGER.warning("Database read failed; using the published file snapshot: %s", exc)
        return getattr(self.file_repository, method)(*args)

    def list_sites(self) -> tuple[list[SiteDetail], str]:
        return self._call("list_sites")

    def get_site(self, site_id: str) -> tuple[SiteDetail | None, str]:
        site: SiteDetail | None = None
        site_source = self.file_repository.source
        if self.database_repository is not None:
            try:
                site, site_source = self.database_repository.get_site(site_id)
            except Exception as exc:
                LOGGER.warning("Database read failed; using the published file snapshot: %s", exc)
        if site is None:
            site, site_source = self.file_repository.get_site(site_id)
        return site, site_source

    def list_opportunities(
        self, species: str, from_time: datetime, through: datetime
    ) -> tuple[list[OpportunityWindow], datetime, dict[str, str], str]:
        if self.database_repository is not None:
            try:
                result = self.database_repository.list_opportunities(species, from_time, through)
                if result[0]:
                    return result
            except Exception as exc:
                LOGGER.warning("Database read failed; using the published file snapshot: %s", exc)
        return self.file_repository.list_opportunities(species, from_time, through)


def build_repository() -> HybridRepository:
    validate_contract_assets()
    default_root = Path(__file__).resolve().parents[3]
    root = Path(os.getenv("DATA_ROOT", str(default_root))).resolve()
    file_repository = FileRepository(root=root)
    database_url = os.getenv("DATABASE_URL")
    database_repository = PostgresRepository(database_url) if database_url else None
    return HybridRepository(file_repository=file_repository, database_repository=database_repository)
