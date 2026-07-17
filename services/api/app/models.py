from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

class APIModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class FishingMode(str, Enum):
    SHORE = "shore"
    BEACH = "beach"
    JETTY = "jetty"
    PIER = "pier"


class ConfidenceLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class FreshnessStatus(str, Enum):
    FRESH = "fresh"
    STALE = "stale"
    MISSING = "missing"
    EXCLUDED = "excluded"


class OpportunityStatus(str, Enum):
    FRESH = "fresh"
    PARTIAL = "partial"
    STALE = "stale"


class SourceFreshness(APIModel):
    source: str
    observed_at: datetime | None = None
    checked_at: datetime
    age_minutes: int | None = Field(default=None, ge=0)
    freshness_limit_minutes: int = Field(ge=1)
    status: FreshnessStatus
    used_in_score: bool
    excluded_reason: str | None = None


class ExternalLink(APIModel):
    label: str
    url: HttpUrl
    kind: str = "source"


class CurrentConditions(APIModel):
    tide_stage: str | None = None
    current_knots: float | None = None
    current_direction_degrees: float | None = Field(default=None, ge=0, lt=360)
    current_direction: str | None = None
    wind_mph: float | None = Field(default=None, ge=0)
    swell_feet: float | None = Field(default=None, ge=0)
    swell_period_seconds: float | None = Field(default=None, ge=0)
    swell_direction_degrees: float | None = Field(default=None, ge=0, lt=360)
    swell_direction: str | None = None
    wave_power_kw_m: float | None = Field(default=None, ge=0)
    breaking_intensity: str | None = None
    breaking_wave_height_feet: float | None = Field(default=None, ge=0)
    fishability_label: str | None = None
    fishability_reasons: list[str] = Field(default_factory=list)
    water_temp_f: float | None = None
    water_temp_source: str | None = None
    ndbc_observed_water_temp_f: float | None = None
    ndbc_observed_at: datetime | None = None
    daylight: bool | None = None
    cloud_cover_pct: float | None = Field(default=None, ge=0, le=100)
    pressure_hpa: float | None = Field(default=None, ge=800, le=1200)
    pressure_trend_hpa_3h: float | None = None
    moon_phase: str | None = None
    moon_illumination_pct: float | None = Field(default=None, ge=0, le=100)
    fishing_pressure: str | None = None
    fishing_pressure_pct: float | None = Field(default=None, ge=0, le=100)
    access_adjustment_points: float | None = None
    fishing_pressure_basis: str | None = None


class SiteSummary(APIModel):
    id: str
    name: str
    region: str
    locality: str | None = None
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    fishing_modes: list[FishingMode]
    access_type: str = "public"
    is_accessible: bool = True
    structure_tags: list[str] = Field(default_factory=list)
    regulation_url: HttpUrl


class SiteDetail(SiteSummary):
    description: str | None = None
    access_notes: str
    parking_notes: str | None = None
    transit_notes: str | None = None
    amenities: list[str] = Field(default_factory=list)
    bathymetry_summary: str | None = None
    casting_zone: dict[str, Any] | None = None
    official_links: list[ExternalLink] = Field(default_factory=list)
    data_freshness: list[SourceFreshness] = Field(default_factory=list)
    current_conditions: CurrentConditions | None = None
    next_window: dict[str, Any] | None = None


class ComponentScores(APIModel):
    habitat_score: float = Field(ge=0, le=100)
    seasonality_score: float = Field(ge=0, le=100)
    dynamic_score: float = Field(ge=0, le=100)
    fishability_score: float = Field(default=50, ge=0, le=100)
    seasonality_multiplier: float | None = Field(default=None, ge=0, le=3)
    dynamic_modifier: float | None = Field(default=None, ge=-0.5, le=0.5)


class Confidence(APIModel):
    level: ConfidenceLevel
    score: float | None = Field(default=None, ge=0, le=1)
    reasons: list[str] = Field(default_factory=list)


class ExplanationFactor(APIModel):
    label: str
    direction: str = Field(pattern="^(positive|negative|neutral)$")
    impact: float | None = Field(default=None, ge=-1, le=1)
    detail: str
    source: str | None = None


class OpportunityWindow(APIModel):
    id: str
    species: str
    target_taxon_id: str
    taxon_catalog_version: str
    observation_contract_version: str
    model_run_contract_version: str
    opportunity_contract_version: str
    scoring_system_kind: str
    scoring_system_version: str
    scoring_system_sha256: str
    site: SiteSummary
    start_time: datetime
    end_time: datetime
    opportunity_score: float = Field(ge=0, le=100)
    components: ComponentScores
    confidence: Confidence
    explanation_factors: list[ExplanationFactor] = Field(default_factory=list)
    model_version: str
    generated_at: datetime
    status: OpportunityStatus
    source_freshness: list[SourceFreshness]
    conditions: CurrentConditions | None = None
    rank: int | None = Field(default=None, ge=1)


class OpportunityResponse(APIModel):
    species: str
    target_taxon_id: str
    taxon_catalog_version: str
    observation_contract_version: str
    model_run_contract_version: str
    opportunity_contract_version: str
    scoring_system_kind: str
    scoring_system_version: str
    scoring_system_sha256: str
    from_time: datetime = Field(serialization_alias="from")
    through: datetime
    hours: int
    generated_at: datetime
    repository: str
    score_definition: str = (
        "A relative percentile among the site/window candidates evaluated for this request; "
        "it is not a catch probability or a guaranteed hotspot."
    )
    windows: list[OpportunityWindow]


class HealthResponse(APIModel):
    status: str
    service: str = "contourcast-api"
    version: str
    repository: str
    checked_at: datetime
