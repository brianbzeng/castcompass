from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated, AsyncIterator

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    OPPORTUNITY_CONTRACT_VERSION,
    PRODUCTION_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
)

from .models import (
    HealthResponse,
    OpportunityResponse,
    SiteDetail,
    SiteSummary,
)
from .observability import (
    begin_request,
    configure_logger,
    current_request_id,
    end_request,
    log_event,
    safe_error_fields,
)
from .repository import DataUnavailableError, Repository, build_repository, utc_now

API_VERSION = "0.1.0"
LOGGER = logging.getLogger(__name__)
configure_logger(LOGGER)

repository = build_repository()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    try:
        repository.open()
    except Exception as exc:
        log_event(
            LOGGER,
            "warn",
            "database.pool.startup_deferred",
            **safe_error_fields(exc, "pool_startup_deferred"),
        )
    try:
        yield
    finally:
        repository.close()


def _attribute_data_source(response: Response, source: str) -> None:
    response.headers["X-CastingCompass-Data-Source"] = source


def _combined_data_source(*sources: str) -> str:
    return "+".join(dict.fromkeys(source for source in sources if source)) or "unknown"


def _origins() -> list[str]:
    configured = os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,https://castingcompass.com",
    )
    return [origin.strip() for origin in configured.split(",") if origin.strip()]


app = FastAPI(
    title="CastingCompass API",
    version=API_VERSION,
    description=(
        "Explainable, relative California-halibut opportunity rankings for public shore and pier sites. "
        "Scores are percentiles among currently evaluated options, not catch probabilities. "
        "Bathymetry is not navigational data; regulation links are informational, not legal advice."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins(),
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Accept", "Content-Type", "If-None-Match"],
    expose_headers=["X-CastingCompass-Data-Source", "X-Request-ID"],
)


def get_repository() -> Repository:
    return repository


RepositoryDependency = Annotated[Repository, Depends(get_repository)]


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.method == "GET":
        if request.url.path == "/health":
            response.headers["Cache-Control"] = "no-store"
        elif request.url.path.startswith("/v1/opportunities"):
            response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=600"
        elif request.url.path.startswith("/v1/sites"):
            response.headers["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
    return response


@app.middleware("http")
async def observe_requests(request: Request, call_next):
    token = begin_request(request)
    started = time.perf_counter()
    try:
        try:
            response = await call_next(request)
        except Exception as exc:
            log_event(LOGGER, "error", "http.request.exception", **safe_error_fields(exc))
            response = JSONResponse(
                status_code=500,
                content={"detail": "The request could not be completed."},
                headers={"Cache-Control": "no-store"},
            )
        request_id = current_request_id()
        if request_id:
            response.headers["X-Request-ID"] = request_id
        level = (
            "error"
            if response.status_code >= 500
            else "warn"
            if response.status_code == 429
            else "info"
        )
        log_event(
            LOGGER,
            level,
            "http.request.completed",
            status=response.status_code,
            outcome=(
                "server_error"
                if response.status_code >= 500
                else "client_error"
                if response.status_code >= 400
                else "ok"
            ),
            duration_ms=round(max(0.0, (time.perf_counter() - started) * 1000), 2),
        )
        return response
    finally:
        end_request(token)


@app.exception_handler(DataUnavailableError)
async def unavailable_handler(_: Request, exc: DataUnavailableError):
    log_event(LOGGER, "error", "snapshot.data_unavailable", **safe_error_fields(exc, "data_unavailable"))
    return JSONResponse(
        status_code=503,
        content={
            "detail": "The latest verified CastingCompass data snapshot is unavailable.",
            "reason": "published_data_unavailable",
            "invented_values_used": False,
        },
        headers={"Cache-Control": "no-store", "Retry-After": "300"},
    )


@app.get("/health", response_model=HealthResponse, tags=["operations"])
def health(response: Response, repo: RepositoryDependency) -> HealthResponse:
    try:
        _, source = repo.list_sites()
        status = "ok"
    except Exception:
        source = "unavailable"
        status = "degraded"
    _attribute_data_source(response, source)
    return HealthResponse(
        status=status,
        version=API_VERSION,
        repository=source,
        checked_at=utc_now(),
    )


@app.get("/v1/sites", response_model=list[SiteSummary], tags=["sites"])
def list_sites(response: Response, repo: RepositoryDependency) -> list[SiteSummary]:
    """Return public, reachable fishing sites and the metadata needed to draw map markers."""
    sites, source = repo.list_sites()
    _attribute_data_source(response, source)
    return [SiteSummary.model_validate(site.model_dump()) for site in sites]


@app.get("/v1/sites/{site_id}", response_model=SiteDetail, tags=["sites"])
def get_site(site_id: str, response: Response, repo: RepositoryDependency) -> SiteDetail:
    """Return access notes, structure context, official links, and available freshness metadata."""
    site, source = repo.get_site(site_id)
    if site is None:
        _attribute_data_source(response, source)
        raise HTTPException(status_code=404, detail=f"Unknown fishing site: {site_id}")
    now = utc_now()
    try:
        windows, _, _, opportunity_source = repo.list_opportunities(
            "california-halibut", now, now + timedelta(hours=72)
        )
        next_window = next((window for window in windows if window.site.id == site_id), None)
    except DataUnavailableError:
        next_window = None
    if next_window is None:
        _attribute_data_source(response, source)
        return site
    _attribute_data_source(
        response,
        _combined_data_source(source, opportunity_source),
    )
    return site.model_copy(
        update={
            "current_conditions": next_window.conditions,
            "data_freshness": next_window.source_freshness,
            "next_window": {
                "id": next_window.id,
                "start_time": next_window.start_time,
                "end_time": next_window.end_time,
                "opportunity_score": next_window.opportunity_score,
                "components": next_window.components.model_dump(),
                "confidence": next_window.confidence.model_dump(),
                "status": next_window.status,
                "model_version": next_window.model_version,
                "target_taxon_id": next_window.target_taxon_id,
                "taxon_catalog_version": next_window.taxon_catalog_version,
                "observation_contract_version": next_window.observation_contract_version,
                "model_run_contract_version": next_window.model_run_contract_version,
                "opportunity_contract_version": next_window.opportunity_contract_version,
                "scoring_system_kind": next_window.scoring_system_kind,
                "scoring_system_version": next_window.scoring_system_version,
                "scoring_system_sha256": next_window.scoring_system_sha256,
            },
        }
    )


@app.get("/v1/opportunities", response_model=OpportunityResponse, tags=["opportunities"])
def list_opportunities(
    response: Response,
    repo: RepositoryDependency,
    species: Annotated[
        str,
        Query(pattern="^california-halibut$", description="The v1 model supports California halibut only."),
    ] = "california-halibut",
    from_time: Annotated[
        datetime | None,
        Query(alias="from", description="Inclusive ISO-8601 start time; defaults to the current UTC time."),
    ] = None,
    hours: Annotated[int, Query(ge=2, le=168, description="Forecast horizon, from 2 hours to 7 days.")] = 72,
) -> OpportunityResponse:
    """Rank verified two-hour site windows within the requested horizon."""
    requested_from = from_time or utc_now()
    if requested_from.tzinfo is None:
        requested_from = requested_from.replace(tzinfo=timezone.utc)
    else:
        requested_from = requested_from.astimezone(timezone.utc)
    through = requested_from + timedelta(hours=hours)
    windows, generated_at, identity, source = repo.list_opportunities(
        species, requested_from, through
    )
    _attribute_data_source(response, source)
    return OpportunityResponse(
        species=species,
        target_taxon_id=PRODUCTION_TARGET_TAXON_ID,
        taxon_catalog_version=TAXON_CATALOG_VERSION,
        observation_contract_version=OBSERVATION_CONTRACT_VERSION,
        model_run_contract_version=MODEL_RUN_CONTRACT_VERSION,
        opportunity_contract_version=OPPORTUNITY_CONTRACT_VERSION,
        scoring_system_kind=identity["scoring_system_kind"],
        scoring_system_version=identity["scoring_system_version"],
        scoring_system_sha256=identity["scoring_system_sha256"],
        from_time=requested_from,
        through=through,
        hours=hours,
        generated_at=generated_at,
        repository=source,
        windows=windows,
    )
