#!/usr/bin/env python3
"""Build the static CastingCompass demo snapshot from public forecast endpoints.

The generator is deterministic for a fixed ``--as-of`` timestamp and the same
upstream responses. Missing upstream values stay null and contribute a neutral
value to the dynamic component; they are never replaced by invented weather or
ocean observations.
"""

from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
import hashlib
import json
import math
import re
import shutil
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    OPPORTUNITY_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    validate_contract_assets,
)


ROOT = Path(__file__).resolve().parents[1]
SITES_PATH = ROOT / "data" / "sites.json"
PUBLIC_DATA = ROOT / "public" / "data"
USER_AGENT = "CastingCompass/0.1 (public-data demo; contact: bzeng0000@gmail.com)"
PACIFIC = ZoneInfo("America/Los_Angeles")

SCORING_SYSTEM_KIND = "heuristic-configuration"
SCORING_CONFIGURATION = {
    "configuration_version": "castingcompass-hybrid-demo/0.6.0",
    "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
    "components": {
        "habitat": 0.44,
        "seasonality": 0.16,
        "dynamic": 0.20,
        "fishability": 0.20,
    },
    "access_adjustment_scale": 0.25,
    "score_semantics": "relative-opportunity-0-100-not-calibrated-probability",
}


def scoring_system_identity() -> tuple[str, str]:
    """Hash the declared configuration and exact scoring source code."""

    code_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    material = json.dumps(
        {"configuration": SCORING_CONFIGURATION, "code_sha256": code_sha256},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(material).hexdigest()
    return f"heuristic-{PRODUCTION_TARGET_TAXON_ID}-{digest}", digest

WEATHER_ANCHORS = {
    "point-reyes": (38.04, -122.96),
    "marin-coast": (37.90, -122.64),
    "north-bay": (37.94, -122.47),
    "golden-gate": (37.81, -122.48),
    "sf-coast": (37.70, -122.50),
    "central-bay": (37.80, -122.39),
    "east-bay": (37.86, -122.32),
    "south-bay": (37.68, -122.14),
    "peninsula-bay": (37.61, -122.34),
    "half-moon-bay": (37.49, -122.47),
}

BUOY_BY_ANCHOR = {
    "point-reyes": "46013",
    "marin-coast": "46013",
    "north-bay": "46026",
    "golden-gate": "46026",
    "sf-coast": "46026",
    "central-bay": "46026",
    "east-bay": "46026",
    "south-bay": "46026",
    "peninsula-bay": "46026",
    "half-moon-bay": "46012",
}

# Product-design seasonal prior. It remains explicitly a versioned fixture
# until a reproducible monthly RecFIN extract is committed.
SEASONALITY_BY_MONTH = {
    1: 34,
    2: 37,
    3: 44,
    4: 57,
    5: 70,
    6: 82,
    7: 88,
    8: 86,
    9: 79,
    10: 66,
    11: 49,
    12: 38,
}

OPEN_COAST_REGIONS = {
    "Point Reyes",
    "Marin Coast",
    "San Francisco Coast",
    "San Mateo Coast",
    "Half Moon Bay",
}

# Access pressure is a deliberately small, transparent planning modifier. Google
# Maps does not expose Popular Times through the Places API, and its terms do not
# permit scraping those charts into another dataset. These tiers are therefore a
# CastingCompass editorial estimate of how constrained the fishable space usually
# feels, not a live headcount. Unknown sites default to the middle tier.
HIGH_PRESSURE_SITES = {
    "fort-baker-pier",
    "torpedo-wharf",
    "crissy-field-east-beach",
    "pier-7",
    "pier-14",
    "emeryville-marina-pier",
    "oyster-point-fishing-pier",
    "pacifica-municipal-pier",
    "pillar-point-west-jetty",
    "pillar-point-east-jetty",
}

LOW_PRESSURE_SITES = {
    "point-reyes-south-beach",
    "herons-head-park-pier",
    "ferry-point-pier",
    "point-isabel-shoreline",
    "middle-harbor-shoreline",
    "oyster-bay-shoreline",
    "san-leandro-marina-shore",
    "dumbarton-pier",
    "seal-point-park",
    "poplar-beach",
}


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def grid_value_for_time(values: list[dict[str, Any]], target: datetime) -> float | None:
    """Read a numeric value from an NWS forecastGridData valid-time interval."""

    for item in values:
        try:
            start_raw, duration_raw = item["validTime"].split("/", 1)
            match = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?", duration_raw)
            if not match:
                continue
            duration = timedelta(
                days=int(match.group(1) or 0),
                hours=int(match.group(2) or 0),
                minutes=int(match.group(3) or 0),
            )
            start = parse_iso(start_raw)
            value = item.get("value")
            if start <= target < start + duration and value is not None:
                return float(value)
        except (KeyError, TypeError, ValueError):
            continue
    return None


def request_json(url: str, timeout: int = 20) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def request_text(url: str, timeout: int = 20) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/plain"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def next_even_hour(value: datetime) -> datetime:
    value = value.astimezone(timezone.utc)
    if value.minute or value.second or value.microsecond:
        value = value.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if value.hour % 2:
        value += timedelta(hours=1)
    return value


def fetch_tides(station: str, start: datetime, end: datetime) -> dict[str, Any]:
    params = {
        "product": "predictions",
        "application": "CastingCompass",
        "begin_date": start.strftime("%Y%m%d"),
        "end_date": end.strftime("%Y%m%d"),
        "datum": "MLLW",
        "station": station,
        "time_zone": "gmt",
        "units": "metric",
        "interval": "60",
        "format": "json",
    }
    url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?" + urllib.parse.urlencode(params)
    try:
        payload = request_json(url)
        predictions = []
        for item in payload.get("predictions", []):
            stamp = datetime.strptime(item["t"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
            predictions.append((stamp, float(item["v"])))
        if not predictions:
            raise ValueError(payload.get("error", {}).get("message", "no predictions returned"))
        return {"status": "fresh", "url": url, "values": predictions, "error": None}
    except (OSError, ValueError, KeyError, urllib.error.URLError) as exc:
        return {"status": "unavailable-excluded", "url": url, "values": [], "error": str(exc)}


def fetch_hourly_weather(anchor: str) -> dict[str, Any]:
    lat, lon = WEATHER_ANCHORS[anchor]
    points_url = f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}"
    try:
        points = request_json(points_url)
        forecast_url = points["properties"]["forecastHourly"]
        grid_url = points["properties"].get("forecastGridData")
        payload = request_json(forecast_url)
        sky_cover_values: list[dict[str, Any]] = []
        grid_error = None
        if grid_url:
            try:
                grid_payload = request_json(grid_url)
                sky_cover_values = grid_payload.get("properties", {}).get("skyCover", {}).get("values", [])
            except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError) as exc:
                grid_error = str(exc)
        periods = []
        for item in payload["properties"]["periods"]:
            speed_match = re.search(r"\d+(?:\s+to\s+(\d+))?", str(item.get("windSpeed", "")))
            wind = None
            if speed_match:
                numbers = [float(number) for number in re.findall(r"\d+", speed_match.group(0))]
                wind = sum(numbers) / len(numbers)
            period_start = parse_iso(item["startTime"])
            period_end = parse_iso(item["endTime"])
            periods.append(
                {
                    "start": period_start,
                    "end": period_end,
                    "windMph": wind,
                    "temperatureF": float(item["temperature"]) if item.get("temperatureUnit") == "F" else None,
                    "isDaytime": bool(item.get("isDaytime")),
                    "shortForecast": item.get("shortForecast"),
                    "cloudCoverPct": grid_value_for_time(sky_cover_values, period_start + (period_end - period_start) / 2),
                }
            )
        updated_raw = payload.get("properties", {}).get("updated") or payload.get("properties", {}).get("updateTime")
        return {
            "status": "fresh",
            "url": forecast_url,
            "gridUrl": grid_url,
            "gridError": grid_error,
            "updated": parse_iso(updated_raw) if updated_raw else None,
            "periods": periods,
            "error": None,
        }
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError) as exc:
        return {
            "status": "unavailable-excluded",
            "url": points_url,
            "gridUrl": None,
            "gridError": None,
            "updated": None,
            "periods": [],
            "error": str(exc),
        }


def fetch_buoy_observation(station: str) -> dict[str, Any]:
    url = f"https://www.ndbc.noaa.gov/data/realtime2/{station}.txt"
    try:
        lines = [line for line in request_text(url).splitlines() if line.strip()]
        headers = lines[0].lstrip("#").split()
        records: list[tuple[datetime, dict[str, str]]] = []
        for line in lines[1:]:
            if line.startswith("#"):
                continue
            values = dict(zip(headers, line.split()))
            try:
                observed = datetime(
                    int(values["YY"]),
                    int(values["MM"]),
                    int(values["DD"]),
                    int(values["hh"]),
                    int(values["mm"]),
                    tzinfo=timezone.utc,
                )
            except (KeyError, TypeError, ValueError):
                continue
            records.append((observed, values))
        if not records:
            raise ValueError("no parseable buoy observations")
        records.sort(key=lambda item: item[0], reverse=True)

        def numeric(values: dict[str, str], key: str) -> float | None:
            raw = values.get(key)
            if raw in {None, "MM"}:
                return None
            try:
                value = float(raw)
            except (TypeError, ValueError):
                return None
            if not math.isfinite(value):
                return None
            if key == "WVHT" and value >= 99:
                return None
            if key in {"DPD", "APD"} and (value <= 0 or value >= 99):
                return None
            if key == "WTMP" and value >= 999:
                return None
            return value

        def latest_valid(key: str) -> tuple[datetime | None, float | None]:
            for stamp, values in records:
                value = numeric(values, key)
                if value is not None:
                    return stamp, value
            return None, None

        swell_observed, wave_m = latest_valid("WVHT")
        period_observed, wave_period_seconds = latest_valid("DPD")
        if wave_period_seconds is None:
            period_observed, wave_period_seconds = latest_valid("APD")
        water_observed, water_c = latest_valid("WTMP")
        pressure_observed, pressure_hpa = latest_valid("PRES")
        pressure_trend_hpa_3h = None
        if pressure_observed is not None and pressure_hpa is not None:
            target = pressure_observed - timedelta(hours=3)
            historical_pressure = None
            historical_stamp = None
            for stamp, values in records:
                candidate = numeric(values, "PRES")
                if candidate is None:
                    continue
                if historical_stamp is None or abs((stamp - target).total_seconds()) < abs((historical_stamp - target).total_seconds()):
                    historical_stamp = stamp
                    historical_pressure = candidate
            if (
                historical_stamp is not None
                and historical_pressure is not None
                and abs((historical_stamp - target).total_seconds()) <= 90 * 60
            ):
                pressure_trend_hpa_3h = round(pressure_hpa - historical_pressure, 1)
        observed = records[0][0]
        if wave_m is None and water_c is None and pressure_hpa is None:
            raise ValueError("no valid WVHT, WTMP, or PRES values in buoy observations")
        return {
            "status": "fresh",
            "url": url,
            "observed": observed,
            "swellObserved": swell_observed,
            "periodObserved": period_observed,
            "waterObserved": water_observed,
            "pressureObserved": pressure_observed,
            "swellFeet": round(wave_m * 3.28084, 1) if wave_m is not None else None,
            "swellPeriodSeconds": round(wave_period_seconds, 1) if wave_period_seconds is not None else None,
            "waterTempF": round((water_c * 9 / 5) + 32, 1) if water_c is not None else None,
            "pressureHpa": round(pressure_hpa, 1) if pressure_hpa is not None else None,
            "pressureTrendHpa3h": pressure_trend_hpa_3h,
            "error": None,
        }
    except (OSError, ValueError, KeyError, IndexError, urllib.error.URLError) as exc:
        return {
            "status": "unavailable-excluded",
            "url": url,
            "observed": None,
            "swellObserved": None,
            "periodObserved": None,
            "waterObserved": None,
            "pressureObserved": None,
            "swellFeet": None,
            "swellPeriodSeconds": None,
            "waterTempF": None,
            "pressureHpa": None,
            "pressureTrendHpa3h": None,
            "error": str(exc),
        }


def fetch_marine_sst(anchors: list[str], start: datetime, end: datetime) -> dict[str, dict[str, Any]]:
    """Fetch hourly SST, waves, and modeled current in one Open-Meteo request.

    The public endpoint is appropriate for this non-commercial prototype only.
    A paid customer endpoint and API key are required before subscriptions,
    advertising, or another commercial launch.
    """

    ordered_anchors = list(dict.fromkeys(anchors))
    if not ordered_anchors:
        return {}
    params = {
        "latitude": ",".join(f"{WEATHER_ANCHORS[anchor][0]:.4f}" for anchor in ordered_anchors),
        "longitude": ",".join(f"{WEATHER_ANCHORS[anchor][1]:.4f}" for anchor in ordered_anchors),
        "hourly": "sea_surface_temperature,wave_height,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction",
        "timezone": "GMT",
        "cell_selection": "sea",
        "start_hour": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M"),
        "end_hour": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M"),
    }
    url = "https://marine-api.open-meteo.com/v1/marine?" + urllib.parse.urlencode(params)
    results = {
        anchor: {
            "status": "unavailable-excluded",
            "url": url,
            "values": [],
            "waveValues": [],
            "currentValues": [],
            "error": None,
        }
        for anchor in ordered_anchors
    }
    try:
        payload = request_json(url)
        locations = payload if isinstance(payload, list) else [payload]
        if len(locations) != len(ordered_anchors):
            raise ValueError(f"expected {len(ordered_anchors)} marine locations, received {len(locations)}")
        for anchor, location in zip(ordered_anchors, locations):
            hourly = location.get("hourly", {})
            times = hourly.get("time", [])
            temperatures = hourly.get("sea_surface_temperature", [])
            wave_heights = hourly.get("wave_height", [])
            wave_periods = hourly.get("wave_period", [])
            wave_directions = hourly.get("wave_direction", [])
            current_velocities = hourly.get("ocean_current_velocity", [])
            current_directions = hourly.get("ocean_current_direction", [])
            values: list[tuple[datetime, float]] = []
            for raw_time, raw_temperature in zip(times, temperatures):
                if raw_temperature is None:
                    continue
                try:
                    temperature_c = float(raw_temperature)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(temperature_c):
                    continue
                values.append((parse_iso(raw_time), round((temperature_c * 9 / 5) + 32, 1)))
            wave_values: list[tuple[datetime, float, float, float]] = []
            for raw_time, raw_height, raw_period, raw_direction in zip(
                times, wave_heights, wave_periods, wave_directions
            ):
                if raw_height is None or raw_period is None or raw_direction is None:
                    continue
                try:
                    height_m = float(raw_height)
                    period_seconds = float(raw_period)
                    direction_degrees = float(raw_direction)
                except (TypeError, ValueError):
                    continue
                if (
                    not math.isfinite(height_m)
                    or not math.isfinite(period_seconds)
                    or not math.isfinite(direction_degrees)
                    or height_m < 0
                    or period_seconds <= 0
                ):
                    continue
                wave_values.append(
                    (
                        parse_iso(raw_time),
                        round(height_m * 3.28084, 1),
                        round(period_seconds, 1),
                        round(direction_degrees % 360, 1),
                    )
                )
            current_values: list[tuple[datetime, float, float]] = []
            for raw_time, raw_velocity, raw_direction in zip(times, current_velocities, current_directions):
                if raw_velocity is None or raw_direction is None:
                    continue
                try:
                    velocity_kmh = float(raw_velocity)
                    direction_degrees = float(raw_direction)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(velocity_kmh) or not math.isfinite(direction_degrees) or velocity_kmh < 0:
                    continue
                current_values.append(
                    (parse_iso(raw_time), round(velocity_kmh / 1.852, 2), round(direction_degrees % 360, 1))
                )
            if values or wave_values or current_values:
                results[anchor] = {
                    "status": "fresh",
                    "url": url,
                    "values": values,
                    "waveValues": wave_values,
                    "currentValues": current_values,
                    "error": None,
                }
            else:
                results[anchor]["error"] = "no valid marine temperature, wave, or current values returned"
        return results
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError) as exc:
        for result in results.values():
            result["error"] = str(exc)
        return results


def nearest_tide(values: list[tuple[datetime, float]], target: datetime) -> float | None:
    if not values:
        return None
    stamp, value = min(values, key=lambda item: abs((item[0] - target).total_seconds()))
    if abs((stamp - target).total_seconds()) > 75 * 60:
        return None
    return value


def tide_for_window(values: list[tuple[datetime, float]], start: datetime, end: datetime) -> tuple[str, float | None]:
    first = nearest_tide(values, start)
    last = nearest_tide(values, end)
    if first is None or last is None:
        return "unavailable", None
    change = last - first
    if change > 0.08:
        return "rising", round(abs(change), 2)
    if change < -0.08:
        return "falling", round(abs(change), 2)
    before = nearest_tide(values, start - timedelta(hours=2))
    after = nearest_tide(values, end + timedelta(hours=2))
    if before is not None and after is not None and first >= before and last >= after:
        return "near high slack", round(abs(change), 2)
    if before is not None and after is not None and first <= before and last <= after:
        return "near low slack", round(abs(change), 2)
    return "slack", round(abs(change), 2)


def tide_levels_for_window(
    values: list[tuple[datetime, float]], start: datetime, end: datetime
) -> list[float] | None:
    levels_m = [
        nearest_tide(values, start - timedelta(hours=2)),
        nearest_tide(values, start),
        nearest_tide(values, end),
        nearest_tide(values, end + timedelta(hours=2)),
    ]
    if any(level is None for level in levels_m):
        return None
    return [round(float(level) * 3.28084, 2) for level in levels_m]


def weather_for_window(periods: list[dict[str, Any]], midpoint: datetime) -> dict[str, Any] | None:
    matches = [period for period in periods if period["start"] <= midpoint < period["end"]]
    if matches:
        return matches[0]
    if not periods:
        return None
    nearest = min(periods, key=lambda period: abs((period["start"] - midpoint).total_seconds()))
    return nearest if abs((nearest["start"] - midpoint).total_seconds()) <= 90 * 60 else None


def sst_for_window(values: list[tuple[datetime, float]], midpoint: datetime) -> float | None:
    if not values:
        return None
    stamp, temperature_f = min(values, key=lambda item: abs((item[0] - midpoint).total_seconds()))
    if abs((stamp - midpoint).total_seconds()) > 90 * 60:
        return None
    return temperature_f


def marine_wave_for_window(
    values: list[tuple[datetime, float, float, float]], midpoint: datetime
) -> tuple[float | None, float | None, float | None]:
    if not values:
        return None, None, None
    stamp, height_feet, period_seconds, direction_degrees = min(
        values, key=lambda item: abs((item[0] - midpoint).total_seconds())
    )
    if abs((stamp - midpoint).total_seconds()) > 90 * 60:
        return None, None, None
    return height_feet, period_seconds, direction_degrees


def marine_current_for_window(
    values: list[tuple[datetime, float, float]], midpoint: datetime
) -> tuple[float | None, float | None]:
    if not values:
        return None, None
    stamp, speed_knots, direction_degrees = min(
        values, key=lambda item: abs((item[0] - midpoint).total_seconds())
    )
    if abs((stamp - midpoint).total_seconds()) > 90 * 60:
        return None, None
    return speed_knots, direction_degrees


def compass_direction(degrees: float | None) -> str | None:
    if degrees is None:
        return None
    labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return labels[int((degrees + 22.5) // 45) % 8]


def daylight_fallback(midpoint: datetime) -> bool:
    local = midpoint.astimezone(PACIFIC)
    # Conservative Bay Area summer fallback used only when NWS is unavailable.
    return (local.hour, local.minute) >= (6, 0) and (local.hour, local.minute) < (20, 30)


def moon_details(moment: datetime) -> tuple[str, float, float]:
    """Return display phase, illuminated percent, and lunar age in days."""

    reference_new_moon = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
    synodic_month = 29.53058867
    age = ((moment - reference_new_moon).total_seconds() / 86400) % synodic_month
    illumination = 50 * (1 - math.cos(2 * math.pi * age / synodic_month))
    phase_index = int(((age / synodic_month) * 8) + 0.5) % 8
    phase_names = [
        "new moon",
        "waxing crescent",
        "first quarter",
        "waxing gibbous",
        "full moon",
        "waning gibbous",
        "last quarter",
        "waning crescent",
    ]
    return phase_names[phase_index], round(illumination, 1), age


def tide_subscore(change_m: float | None) -> float:
    if change_m is None:
        return 50
    if change_m < 0.08:
        return 35
    if change_m < 0.2:
        return 62
    if change_m <= 0.75:
        return 86
    if change_m <= 1.15:
        return 70
    return 50


def wind_subscore(wind_mph: float | None) -> float:
    if wind_mph is None:
        return 50
    if wind_mph <= 7:
        return 88
    if wind_mph <= 12:
        return 75
    if wind_mph <= 18:
        return 55
    if wind_mph <= 25:
        return 30
    return 12


def swell_subscore(swell_feet: float | None) -> float:
    if swell_feet is None:
        return 50
    if 1.5 <= swell_feet <= 4.5:
        return 82
    if swell_feet < 1.5:
        return 68
    if swell_feet <= 6.5:
        return 55
    if swell_feet <= 8:
        return 32
    return 12


def wave_power_kw_per_meter(swell_feet: float | None, period_seconds: float | None) -> float | None:
    """Estimate deep-water wave energy flux from significant height and buoy peak period.

    P ~= 0.49 * Hs^2 * T (kW/m). NDBC peak period is used as a practical
    proxy for energy period, so the product is labeled an estimate in the UI.
    """
    if swell_feet is None or period_seconds is None:
        return None
    height_meters = swell_feet / 3.28084
    return round(0.49 * (height_meters ** 2) * period_seconds, 1)


def wave_power_subscore(power_kw_m: float | None) -> float:
    if power_kw_m is None:
        return 50
    if power_kw_m < 3:
        return 82
    if power_kw_m < 6:
        return 68
    if power_kw_m < 10:
        return 50
    if power_kw_m < 15:
        return 28
    return 8


def cloud_subscore(cloud_cover_pct: float | None) -> float:
    if cloud_cover_pct is None:
        return 50
    # Moderate cover can extend low-light feeding without treating a fully
    # overcast forecast as automatically superior.
    if 35 <= cloud_cover_pct <= 80:
        return 76
    if cloud_cover_pct < 15:
        return 58
    return 66


def pressure_subscore(pressure_trend_hpa_3h: float | None) -> float:
    if pressure_trend_hpa_3h is None:
        return 50
    change = abs(pressure_trend_hpa_3h)
    if change <= 1.5:
        return 72
    if change <= 3:
        return 62
    if change <= 5:
        return 46
    return 30


def water_temp_subscore(water_temp_f: float | None) -> float:
    if water_temp_f is None:
        return 50
    if 54 <= water_temp_f <= 65:
        return 78
    if 50 <= water_temp_f <= 69:
        return 64
    return 45


def current_subscore(current_knots: float | None) -> float:
    if current_knots is None:
        return 50
    # A little moving water can organize bait and feeding lanes. Very fast
    # current makes presentation and safe shore fishing harder. The signal is
    # bounded because the model grid is coarse close to shore.
    if current_knots < 0.15:
        return 46
    if current_knots < 0.35:
        return 68
    if current_knots <= 1.25:
        return 82
    if current_knots <= 1.75:
        return 62
    if current_knots <= 2.25:
        return 38
    return 20


def access_pressure_for_window(site: dict[str, Any], midpoint: datetime) -> tuple[str, int, float]:
    """Return expected access pressure, display percent, and score-point adjustment.

    This is a schedule-based fishability proxy rather than observed attendance.
    Its small range prevents access convenience from overpowering habitat.
    """

    site_id = str(site["id"])
    tier = 3 if site_id in HIGH_PRESSURE_SITES else 1 if site_id in LOW_PRESSURE_SITES else 2
    local = midpoint.astimezone(PACIFIC)
    hour = local.hour + (local.minute / 60)
    if hour < 5:
        hourly_load = 0.12
    elif hour < 8:
        hourly_load = 0.28
    elif hour < 11:
        hourly_load = 0.65
    elif hour < 16:
        hourly_load = 1.0
    elif hour < 19:
        hourly_load = 0.82
    elif hour < 22:
        hourly_load = 0.42
    else:
        hourly_load = 0.18
    if local.weekday() >= 5:
        hourly_load *= 1.15

    pressure = tier * hourly_load
    pressure_pct = round(min(100, pressure / 3.45 * 100))
    if tier == 3:
        adjustment = -7.5 if pressure >= 2.7 else -5.0 if pressure >= 2.0 else -2.0 if pressure >= 0.8 else -0.5
    elif tier == 2:
        adjustment = -3.0 if pressure >= 1.8 else -1.5 if pressure >= 1.15 else 0.0
    else:
        adjustment = 1.5 if pressure < 0.75 else 0.5
    label = "high" if pressure_pct >= 70 else "moderate" if pressure_pct >= 38 else "light"
    return label, pressure_pct, adjustment


def angular_difference(first: float, second: float) -> float:
    return abs((first - second + 180) % 360 - 180)


def beach_slope_class(site: dict[str, Any]) -> str:
    explicit = str(site.get("beachSlopeClass", "")).lower()
    if explicit in {"gentle", "moderate", "steep"}:
        return explicit
    profile = str(site.get("depthProfile", "")).lower()
    if any(token in profile for token in ("steep", "abrupt", "deep close")):
        return "steep"
    if any(token in profile for token in ("gentle", "gradual", "shallow flat", "broad flat")):
        return "gentle"
    return "moderate"


def fishability_score(
    site: dict[str, Any],
    wind_mph: float | None,
    swell_feet: float | None,
    swell_period_seconds: float | None,
    swell_direction_degrees: float | None,
    wave_power_kw_m: float | None,
    current_knots: float | None,
    tide_change: float | None,
    fishing_pressure_pct: int,
) -> tuple[int, str, list[str], str | None, float | None]:
    """Estimate whether an angler can make an effective presentation.

    This is intentionally separate from whether habitat looks promising. It is
    a conservative planning gate based on public forecasts and site exposure,
    not a safety rating. Trip observations will be retained to calibrate it.
    """

    score = 92.0
    reasons: list[str] = []
    open_coast = site["region"] in OPEN_COAST_REGIONS
    breaking_intensity: str | None = None
    breaking_wave_height_feet: float | None = None

    if wind_mph is None:
        score -= 6
        reasons.append("Wind is unavailable, so fishability is treated cautiously.")
    elif wind_mph > 25:
        score -= 42
        reasons.append("Very strong wind makes casting and line control difficult.")
    elif wind_mph > 18:
        score -= 28
        reasons.append("Strong wind will make casting and line control difficult.")
    elif wind_mph > 12:
        score -= 14
        reasons.append("Moderate wind may reduce casting distance and feel.")

    if current_knots is not None:
        if current_knots > 2.25:
            score -= 24
            reasons.append("Very fast modeled current may make it hard to hold the presentation near bottom.")
        elif current_knots > 1.75:
            score -= 12
            reasons.append("Fast modeled current may require heavier tackle and tighter line control.")

    if fishing_pressure_pct >= 80:
        score -= 14
        reasons.append("Expected crowding may leave less room to cast and more lines in the water.")
    elif fishing_pressure_pct >= 60:
        score -= 8
        reasons.append("Expected crowding may limit comfortable casting space.")
    elif fishing_pressure_pct <= 20:
        score += 2

    if tide_change is not None and tide_change > 1.15:
        score -= 7
        reasons.append("A large tide change may make a bottom presentation harder to control.")

    if open_coast:
        slope = beach_slope_class(site)
        slope_multiplier = {"gentle": 0.82, "moderate": 1.0, "steep": 1.28}[slope]
        bearing = float(site.get("castingZone", {}).get("bearingDegrees", 0))
        if swell_direction_degrees is None:
            direction_exposure = 0.75
        else:
            alignment = max(0.0, math.cos(math.radians(angular_difference(bearing, swell_direction_degrees))))
            direction_exposure = 0.25 + (0.75 * alignment)

        if swell_feet is None or wave_power_kw_m is None:
            score = min(score - 18, 62)
            reasons.append("A complete surf forecast is unavailable, so exposed-water fishability is capped.")
        else:
            breaking_wave_height_feet = round(swell_feet * math.sqrt(direction_exposure) * slope_multiplier, 1)
            exposed_power = wave_power_kw_m * direction_exposure * slope_multiplier
            if swell_period_seconds is not None and swell_period_seconds >= 14:
                exposed_power *= 1.12
                score -= 8
                reasons.append("Long-period swell can create stronger surges than wave height alone suggests.")
            elif swell_period_seconds is not None and swell_period_seconds >= 11:
                score -= 4

            if exposed_power >= 15:
                score -= 68
            elif exposed_power >= 10:
                score -= 52
            elif exposed_power >= 6:
                score -= 36
            elif exposed_power >= 3.5:
                score -= 23
            elif exposed_power >= 1.8:
                score -= 11

            if breaking_wave_height_feet >= 6:
                score = min(score, 24)
            elif breaking_wave_height_feet >= 4.5:
                score = min(score, 38)
            elif breaking_wave_height_feet >= 3.5:
                score = min(score, 54)
            elif breaking_wave_height_feet >= 2.5:
                score = min(score, 69)

            if score < 55:
                reasons.append("Estimated shorebreak and surge may prevent a controlled, repeatable presentation.")
            elif score < 72:
                reasons.append("Surf should be fishable only with careful timing and solid footing.")

        if slope == "steep":
            score -= 6
            reasons.append("This beach has a steep nearshore slope where waves can stand up and surge quickly.")

    score = round(max(5, min(98, score)))
    label = "good" if score >= 78 else "workable" if score >= 60 else "difficult" if score >= 38 else "poor"
    if open_coast:
        breaking_intensity = "light" if score >= 78 else "workable" if score >= 60 else "difficult" if score >= 38 else "severe"
    if not reasons:
        reasons.append("Forecast wind, water movement, access pressure, and presentation control look manageable.")
    return score, label, reasons[:4], breaking_intensity, breaking_wave_height_feet


def fishability_score_cap(score: int) -> int:
    if score < 25:
        return 32
    if score < 40:
        return 48
    if score < 55:
        return 66
    if score < 65:
        return 80
    if score < 75:
        return 90
    return 100


def moon_subscore(lunar_age_days: float) -> float:
    # This stays deliberately low-weight. Tide predictions already contain
    # much of the lunar signal, so a second large lunar boost would double-count it.
    spring_tide_proximity = abs(math.cos(2 * math.pi * lunar_age_days / 29.53058867))
    return 52 + (18 * spring_tide_proximity)


def dynamic_score(
    tide_change: float | None,
    wind_mph: float | None,
    swell_feet: float | None,
    wave_power_kw_m: float | None,
    daylight: bool,
    open_coast: bool,
    cloud_cover_pct: float | None,
    pressure_trend_hpa_3h: float | None,
    water_temp_f: float | None,
    lunar_age_days: float,
    current_knots: float | None,
) -> int:
    weighted = [
        (tide_subscore(tide_change), 0.27),
        (current_subscore(current_knots), 0.16),
        (wind_subscore(wind_mph), 0.20),
        (72 if daylight else 48, 0.06),
        (cloud_subscore(cloud_cover_pct), 0.04),
        (pressure_subscore(pressure_trend_hpa_3h), 0.05),
        (water_temp_subscore(water_temp_f), 0.08),
        (moon_subscore(lunar_age_days), 0.04),
    ]
    if open_coast:
        weighted = [(value, weight * 0.78) for value, weight in weighted]
        weighted.append((swell_subscore(swell_feet), 0.08))
        weighted.append((wave_power_subscore(wave_power_kw_m), 0.14))
    raw = sum(value * weight for value, weight in weighted) / sum(weight for _, weight in weighted)
    # High-energy surf is a hard constraint for shore and jetty fishing. Calm
    # wind or a favorable tide must not mask an unsafe/unfishable wave field.
    if open_coast and wave_power_kw_m is not None:
        if wave_power_kw_m >= 15:
            raw = min(raw, 30)
        elif wave_power_kw_m >= 10:
            raw = min(raw, 44)
        elif wave_power_kw_m >= 6:
            raw = min(raw, 58)
    # Conditions are deliberately bounded so a transient forecast cannot erase
    # long-term habitat evidence in the combined rank.
    return round(max(30, min(78, raw)))


def factor_text(
    site: dict[str, Any],
    seasonality: int,
    tide_stage: str,
    tide_change: float | None,
    wind_mph: float | None,
    swell_feet: float | None,
    water_temp_f: float | None,
    ndbc_water_temp_f: float | None,
    daylight: bool,
    cloud_cover_pct: float | None,
    pressure_hpa: float | None,
    pressure_trend_hpa_3h: float | None,
    moon_phase: str,
    moon_illumination_pct: float,
    current_knots: float | None,
    current_direction: str | None,
    wave_power_kw_m: float | None,
    fishability: int,
    fishability_label: str,
) -> list[str]:
    tags = ", ".join(site["structureTags"][:2]).replace("-", " ")
    factors = [f"Look for {tags}.", f"Time of year: {seasonality}/100."]
    if tide_change is None:
        factors.append("Tide forecast unavailable.")
    else:
        factors.append(f"Tide: {tide_stage}, changing {tide_change:.2f} m.")
    condition_bits = []
    if wind_mph is not None:
        condition_bits.append(f"{wind_mph:.0f} mph wind")
    if cloud_cover_pct is not None:
        condition_bits.append(f"{cloud_cover_pct:.0f}% cloud")
    if water_temp_f is not None:
        condition_bits.append(f"{water_temp_f:.1f}°F water")
    if condition_bits:
        factors.append("Conditions: " + ", ".join(condition_bits) + ".")
    if current_knots is not None:
        direction = f" toward {current_direction}" if current_direction else ""
        factors.append(f"Modeled current: {current_knots:.2f} kt{direction}.")
    if site["region"] in OPEN_COAST_REGIONS:
        if swell_feet is None:
            factors.append("Fresh swell reading unavailable.")
        else:
            factors.append(f"Nearby swell: {swell_feet:.1f} ft.")
        if wave_power_kw_m is not None:
            factors.append(f"Estimated surf energy: {wave_power_kw_m:.1f} kW/m.")
    factors.append(f"Fishability: {fishability}/100 ({fishability_label}).")
    sky_bits = []
    if pressure_hpa is not None:
        trend = "steady" if pressure_trend_hpa_3h is None or abs(pressure_trend_hpa_3h) <= 1.5 else "changing"
        sky_bits.append(f"pressure {trend} at {pressure_hpa:.0f} hPa")
    sky_bits.append(f"{moon_phase} moon, {moon_illumination_pct:.0f}% lit")
    factors.append("Sky: " + "; ".join(sky_bits) + ".")
    factors.append("Daylight window." if daylight else "After dark—check access hours.")
    return factors


def source_status(results: list[dict[str, Any]]) -> str:
    statuses = {result["status"] for result in results}
    if statuses == {"fresh"}:
        return "fresh"
    if "fresh" in statuses:
        return "partial; missing inputs excluded"
    return "unavailable; excluded"


def main() -> None:
    validate_contract_assets()
    scoring_system_version, scoring_system_sha256 = scoring_system_identity()
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", help="UTC ISO timestamp used to anchor the 72-hour snapshot")
    args = parser.parse_args()

    generated_at = parse_iso(args.as_of) if args.as_of else datetime.now(timezone.utc)
    start = next_even_hour(generated_at)
    end = start + timedelta(hours=72)
    sites = json.loads(SITES_PATH.read_text())
    active_sites = [site for site in sites if site.get("accessStatus") != "closed"]

    tide_results = {
        station: fetch_tides(station, start - timedelta(hours=3), end + timedelta(hours=3))
        for station in sorted({site["tideStation"] for site in active_sites})
    }
    weather_results = {
        anchor: fetch_hourly_weather(anchor) for anchor in sorted({site["weatherAnchor"] for site in active_sites})
    }
    buoy_results = {
        station: fetch_buoy_observation(station)
        for station in sorted({BUOY_BY_ANCHOR[site["weatherAnchor"]] for site in active_sites})
    }
    marine_sst_results = fetch_marine_sst(
        sorted({site["weatherAnchor"] for site in active_sites}), start, end
    )

    windows: list[dict[str, Any]] = []
    for site in active_sites:
        habitat = int(site["habitatPrior"])
        tide_result = tide_results[site["tideStation"]]
        weather_result = weather_results[site["weatherAnchor"]]
        buoy_result = buoy_results[BUOY_BY_ANCHOR[site["weatherAnchor"]]]
        marine_sst_result = marine_sst_results[site["weatherAnchor"]]
        for index in range(36):
            window_start = start + timedelta(hours=index * 2)
            window_end = window_start + timedelta(hours=2)
            midpoint = window_start + timedelta(hours=1)
            seasonality = SEASONALITY_BY_MONTH[midpoint.astimezone(PACIFIC).month]
            tide_stage, tide_change = tide_for_window(tide_result["values"], window_start, window_end)
            tide_levels_feet = tide_levels_for_window(tide_result["values"], window_start, window_end)
            weather = weather_for_window(weather_result["periods"], midpoint)
            wind_mph = round(weather["windMph"], 1) if weather and weather["windMph"] is not None else None
            cloud_cover_pct = round(weather["cloudCoverPct"], 1) if weather and weather["cloudCoverPct"] is not None else None
            daylight = weather["isDaytime"] if weather else daylight_fallback(midpoint)
            moon_phase, moon_illumination_pct, lunar_age_days = moon_details(midpoint)
            open_coast = site["region"] in OPEN_COAST_REGIONS

            swell_fresh = (
                open_coast
                and buoy_result["status"] == "fresh"
                and buoy_result["swellObserved"] is not None
                and timedelta(hours=-1) <= window_start - buoy_result["swellObserved"] <= timedelta(hours=6)
            )
            ndbc_water_fresh = (
                buoy_result["status"] == "fresh"
                and buoy_result["waterObserved"] is not None
                and timedelta(hours=-1) <= generated_at - buoy_result["waterObserved"] <= timedelta(hours=6)
            )
            pressure_fresh = (
                buoy_result["status"] == "fresh"
                and buoy_result["pressureObserved"] is not None
                and timedelta(hours=-1) <= generated_at - buoy_result["pressureObserved"] <= timedelta(hours=6)
                and window_start <= generated_at + timedelta(hours=6)
            )
            forecast_swell_feet, forecast_period_seconds, forecast_direction_degrees = marine_wave_for_window(
                marine_sst_result.get("waveValues", []), midpoint
            )
            current_knots, current_direction_degrees = marine_current_for_window(
                marine_sst_result.get("currentValues", []), midpoint
            )
            current_direction = compass_direction(current_direction_degrees)
            swell_feet = forecast_swell_feet if open_coast else None
            swell_period_seconds = forecast_period_seconds if open_coast else None
            swell_direction_degrees = forecast_direction_degrees if open_coast else None
            swell_direction = compass_direction(swell_direction_degrees)
            # A fresh buoy pair takes precedence for the immediate window; the
            # marine forecast carries the same metric through the full 72 hours.
            if swell_fresh and buoy_result["swellFeet"] is not None and buoy_result["swellPeriodSeconds"] is not None:
                swell_feet = buoy_result["swellFeet"]
                swell_period_seconds = buoy_result["swellPeriodSeconds"]
            wave_power_kw_m = wave_power_kw_per_meter(swell_feet, swell_period_seconds)
            water_temp_f = sst_for_window(marine_sst_result["values"], midpoint)
            ndbc_water_temp_f = buoy_result["waterTempF"] if ndbc_water_fresh else None
            pressure_hpa = buoy_result["pressureHpa"] if pressure_fresh else None
            pressure_trend_hpa_3h = buoy_result["pressureTrendHpa3h"] if pressure_fresh else None
            dynamic = dynamic_score(
                tide_change,
                wind_mph,
                swell_feet,
                wave_power_kw_m,
                daylight,
                open_coast,
                cloud_cover_pct,
                pressure_trend_hpa_3h,
                water_temp_f,
                lunar_age_days,
                current_knots,
            )
            access_pressure, access_pressure_pct, access_adjustment = access_pressure_for_window(site, midpoint)
            fishability, fishability_label, fishability_reasons, breaking_intensity, breaking_wave_height_feet = fishability_score(
                site,
                wind_mph,
                swell_feet,
                swell_period_seconds,
                swell_direction_degrees,
                wave_power_kw_m,
                current_knots,
                tide_change,
                access_pressure_pct,
            )
            raw_score = (
                (SCORING_CONFIGURATION["components"]["habitat"] * habitat)
                + (SCORING_CONFIGURATION["components"]["seasonality"] * seasonality)
                + (SCORING_CONFIGURATION["components"]["dynamic"] * dynamic)
                + (SCORING_CONFIGURATION["components"]["fishability"] * fishability)
                + (access_adjustment * SCORING_CONFIGURATION["access_adjustment_scale"])
            )
            available_primary = int(tide_change is not None) + int(wind_mph is not None)
            confidence = "medium" if available_primary == 2 else "low"
            conditions = {
                "tideStage": tide_stage,
                "tideLevelsFeet": tide_levels_feet,
                "currentKnots": current_knots,
                "currentDirectionDegrees": current_direction_degrees,
                "currentDirection": current_direction,
                "windMph": wind_mph,
                "swellFeet": swell_feet,
                "swellPeriodSeconds": swell_period_seconds,
                "swellDirectionDegrees": swell_direction_degrees,
                "swellDirection": swell_direction,
                "wavePowerKwM": wave_power_kw_m,
                "breakingIntensity": breaking_intensity,
                "breakingWaveHeightFeet": breaking_wave_height_feet,
                "fishabilityLabel": fishability_label,
                "fishabilityReasons": fishability_reasons,
                "waterTempF": water_temp_f,
                "daylight": daylight,
                "cloudCoverPct": cloud_cover_pct,
                "pressureHpa": pressure_hpa,
                "pressureTrendHpa3h": pressure_trend_hpa_3h,
                "moonPhase": moon_phase,
                "moonIlluminationPct": moon_illumination_pct,
                "fishingPressure": access_pressure,
                "fishingPressurePct": access_pressure_pct,
                "accessAdjustmentPoints": access_adjustment,
            }
            conditions = {key: value for key, value in conditions.items() if value is not None}
            windows.append(
                {
                    "id": f"{site['id']}--{window_start.strftime('%Y%m%dT%H%MZ')}",
                    "siteId": site["id"],
                    "species": PRODUCTION_TARGET_TAXON_ID,
                    "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
                    "taxon_catalog_version": TAXON_CATALOG_VERSION,
                    "observation_contract_version": OBSERVATION_CONTRACT_VERSION,
                    "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
                    "opportunity_contract_version": OPPORTUNITY_CONTRACT_VERSION,
                    "scoring_system_kind": SCORING_SYSTEM_KIND,
                    "scoring_system_sha256": scoring_system_sha256,
                    "modelVersion": scoring_system_version,
                    "start": isoformat(window_start),
                    "end": isoformat(window_end),
                    "score": 0,
                    "habitatScore": habitat,
                    "seasonalityScore": seasonality,
                    "dynamicScore": dynamic,
                    "fishabilityScore": fishability,
                    "confidence": confidence,
                    "explanationFactors": factor_text(
                        site,
                        seasonality,
                        tide_stage,
                        tide_change,
                        wind_mph,
                        swell_feet,
                        water_temp_f,
                        ndbc_water_temp_f,
                        daylight,
                        cloud_cover_pct,
                        pressure_hpa,
                        pressure_trend_hpa_3h,
                        moon_phase,
                        moon_illumination_pct,
                        current_knots,
                        current_direction,
                        wave_power_kw_m,
                        fishability,
                        fishability_label,
                    ),
                    "conditions": conditions,
                    "_rawScore": round(raw_score, 6),
                    "_scoreCap": fishability_score_cap(fishability),
                }
            )

    ordered = sorted(windows, key=lambda item: (-item["_rawScore"], item["start"], item["siteId"]))
    denominator = max(1, len(ordered) - 1)
    ascending_raw_scores = sorted(item["_rawScore"] for item in ordered)
    for item in ordered:
        # Equal combined values receive the same empirical percentile even
        # though list ordering remains deterministic.
        lower_index = bisect_left(ascending_raw_scores, item["_rawScore"])
        upper_index = bisect_right(ascending_raw_scores, item["_rawScore"]) - 1
        tie_midpoint = (lower_index + upper_index) / 2
        percentile_score = round(100 * tie_midpoint / denominator)
        item["score"] = min(percentile_score, item["_scoreCap"])
        del item["_rawScore"]
        del item["_scoreCap"]

    retrieved_at = isoformat(generated_at)
    tide_status = source_status(list(tide_results.values()))
    weather_status = source_status(list(weather_results.values()))
    buoy_status = source_status(list(buoy_results.values()))
    marine_sst_status = source_status(list(marine_sst_results.values()))
    sources = [
        {
            "name": "NOAA CO-OPS hourly tide predictions",
            "observedAt": retrieved_at,
            "status": tide_status,
            "url": "https://api.tidesandcurrents.noaa.gov/api/prod/",
            "freshnessLimitHours": 84,
        },
        {
            "name": "National Weather Service hourly forecasts",
            "observedAt": isoformat(max((result["updated"] for result in weather_results.values() if result["updated"]), default=generated_at)),
            "status": weather_status + "; wind, daylight, and sky cover are scored when available",
            "url": "https://api.weather.gov/",
            "freshnessLimitHours": 6,
        },
        {
            "name": "NOAA NDBC buoy observations",
            "observedAt": isoformat(max((result["observed"] for result in buoy_results.values() if result["observed"]), default=generated_at)),
            "status": buoy_status + "; fresh swell height, period, estimated wave power, and three-hour atmospheric-pressure trend are scored near term",
            "url": "https://www.ndbc.noaa.gov/",
            "freshnessLimitHours": 6,
        },
        {
            "name": "Open-Meteo marine temperature, wave + current forecast (Météo-France)",
            "observedAt": retrieved_at,
            "status": marine_sst_status + "; sea-surface temperature, wave height, period, power, and modeled current speed are bounded score inputs",
            "url": "https://open-meteo.com/en/docs/marine-weather-api",
            "freshnessLimitHours": 30,
            "attribution": "Weather data by Open-Meteo.com; marine model data by Météo-France.",
            "license": "CC BY 4.0",
            "usageNote": "The free endpoint is non-commercial only; use Open-Meteo's paid customer endpoint before enabling subscriptions, advertising, or other commercial use.",
        },
        {
            "name": "Calculated moon phase",
            "observedAt": retrieved_at,
            "status": "calculated locally; low-weight signal to avoid double-counting the lunar effect already present in tides",
            "url": "https://aa.usno.navy.mil/data/MoonFraction",
            "freshnessLimitHours": 168,
        },
        {
            "name": "Provisional monthly California halibut seasonality fixture",
            "observedAt": "2024-12-31T00:00:00Z",
            "status": "prototype prior only; not yet reproduced from a RecFIN export",
            "url": "https://reports.psmfc.org/recfin/",
        },
        {
            "name": "NOAA NCEI bathymetry / curated habitat proxy",
            "observedAt": "2018-01-01T00:00:00Z",
            "status": "demo proxy; trained raster model not yet integrated",
            "url": "https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ngdc.mgg.dem%3Asan_francisco_bay_P090_2018",
        },
        {
            "name": "CastingCompass expected access-pressure schedule",
            "observedAt": retrieved_at,
            "status": "small score modifier; curated space-and-popularity tiers by time of day, not Google Popular Times or live headcount",
            "url": "https://developers.google.com/maps/documentation/places/web-service/place-details",
        },
        {
            "name": "NOAA CoastWatch chlorophyll and water-color inputs",
            "observedAt": retrieved_at,
            "status": "available for research; excluded until coastal resolution, cloud gaps, and local trip-log lift are validated",
            "url": "https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPN20VIIRSDINEOFDaily.html",
        },
    ]

    payload = {
        "schemaVersion": OPPORTUNITY_CONTRACT_VERSION,
        "opportunity_contract_version": OPPORTUNITY_CONTRACT_VERSION,
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": OBSERVATION_CONTRACT_VERSION,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_taxon_id": PRODUCTION_TARGET_TAXON_ID,
        "scoring_system_kind": SCORING_SYSTEM_KIND,
        "scoring_system_version": scoring_system_version,
        "scoring_system_sha256": scoring_system_sha256,
        "generatedAt": retrieved_at,
        "validFrom": isoformat(start),
        "validThrough": isoformat(end),
        "modelVersion": scoring_system_version,
        "status": "demo-public-data-snapshot",
        "species": PRODUCTION_TARGET_TAXON_ID,
        "scoreDefinition": f"Before the fishability cap, a score of 80 ranks within the current comparison set above 80% of the {len(ordered):,} site/windows. Surf, wind, current, steep shorebreak, or expected crowding can cap the displayed score. It is not an 80% catch probability.",
        "notice": "Conditions are informational only. Check official access and CDFW rules. Bathymetry is not for navigation.",
        "sources": sources,
        "windows": ordered,
    }

    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SITES_PATH, PUBLIC_DATA / "sites.json")
    # Keep the browser payload compact. This file is parsed during startup on
    # mobile, so repeated per-window source metadata and pretty-printing have a
    # measurable interaction cost. Source freshness remains available once at
    # the snapshot level.
    (PUBLIC_DATA / "opportunities.json").write_text(
        json.dumps(payload, separators=(",", ":")) + "\n"
    )

    failures = {
        "tides": {station: result["error"] for station, result in tide_results.items() if result["error"]},
        "weather": {anchor: result["error"] for anchor, result in weather_results.items() if result["error"]},
        "buoys": {station: result["error"] for station, result in buoy_results.items() if result["error"]},
        "marineForecast": {anchor: result["error"] for anchor, result in marine_sst_results.items() if result["error"]},
    }
    print(
        json.dumps(
            {
                "siteCount": len(sites),
                "rankedSiteCount": len(active_sites),
                "windowCount": len(ordered),
                "validFrom": payload["validFrom"],
                "validThrough": payload["validThrough"],
                "upstreamFailures": failures,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
