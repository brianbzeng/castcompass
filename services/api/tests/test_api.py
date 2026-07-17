from __future__ import annotations

import json
import logging
import threading
import uuid
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.api.app.main import app, get_repository
from services.api.app.repository import (
    DataUnavailableError,
    FileRepository,
    HybridRepository,
    PostgresRepository,
    validate_database_window_shape,
)


SCORING_SHA256 = "a" * 64
SCORING_VERSION = f"heuristic-california-halibut-{SCORING_SHA256}"
CONTRACT_IDENTITY = {
    "species": "california-halibut",
    "target_taxon_id": "california-halibut",
    "taxon_catalog_version": "castingcompass.taxa/1.0.0",
    "observation_contract_version": "castingcompass.observation/2.0.0",
    "model_run_contract_version": "castingcompass.model-run/2.0.0",
    "opportunity_contract_version": "castingcompass.opportunity/2.0.0",
    "scoring_system_kind": "heuristic-configuration",
    "scoring_system_version": SCORING_VERSION,
    "scoring_system_sha256": SCORING_SHA256,
}
WINDOW_CONTRACT_IDENTITY = {
    key: value
    for key, value in CONTRACT_IDENTITY.items()
    if key != "scoring_system_version"
}


@pytest.fixture
def snapshot_root(tmp_path: Path) -> Path:
    (tmp_path / "data").mkdir()
    (tmp_path / "public" / "data").mkdir(parents=True)
    (tmp_path / "data" / "sites.json").write_text(
        json.dumps(
            {
                "sites": [
                    {
                        "id": "test-pier",
                        "name": "Test Pier",
                        "region": "San Francisco Bay",
                        "latitude": 37.8,
                        "longitude": -122.4,
                        "modes": ["public pier"],
                        "access_notes": "Public pedestrian access during posted hours.",
                        "regulation_url": "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay",
                        "structure_tags": ["channel edge"],
                    },
                    {
                        "id": "closed-pier",
                        "name": "Closed Pier",
                        "region": "San Francisco Bay",
                        "latitude": 37.61,
                        "longitude": -122.5,
                        "modes": ["public pier"],
                        "accessStatus": "closed",
                        "accessSourceUrl": "https://example.com/official-closure",
                        "access_notes": "Closed by the managing agency.",
                        "regulation_url": "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay",
                        "structure_tags": ["pier pilings"],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    generated_at = datetime.now(timezone.utc).replace(microsecond=0)
    (tmp_path / "public" / "data" / "opportunities.json").write_text(
        json.dumps(
            {
                **CONTRACT_IDENTITY,
                "generated_at": generated_at.isoformat(),
                "modelVersion": SCORING_VERSION,
                "sources": [
                    {
                        "name": "Open-Meteo Marine SST forecast (Météo-France)",
                        "observedAt": generated_at.isoformat(),
                        "status": "fresh; forecast context only; excluded from scoring",
                        "freshnessLimitHours": 30,
                    }
                ],
                "windows": [
                    {
                        **WINDOW_CONTRACT_IDENTITY,
                        "id": "test-window",
                        "siteId": "test-pier",
                        "species": "california-halibut",
                        "start": (generated_at + timedelta(hours=1)).isoformat(),
                        "end": (generated_at + timedelta(hours=3)).isoformat(),
                        "score": 82,
                        "habitatScore": 86,
                        "seasonalityScore": 78,
                        "dynamicScore": 71,
                        "fishabilityScore": 74,
                        "confidence": "high",
                        "explanationFactors": [
                            {
                                "label": "Channel edge",
                                "direction": "positive",
                                "impact": 0.3,
                                "detail": "A reachable depth transition is present in the casting zone.",
                            }
                        ],
                        "modelVersion": SCORING_VERSION,
                        "conditions": {"waterTempF": 59.8},
                        "source_freshness": [
                            {
                                "source": "water_temperature",
                                "status": "fresh-model-forecast-not-scored",
                            },
                            {
                                "source": "weather",
                                "observed_at": generated_at.isoformat(),
                                "freshness_limit_minutes": 120,
                            },
                            {
                                "source": "tides",
                                "observed_at": "2020-01-01T00:00:00Z",
                                "freshness_limit_minutes": 120,
                            },
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture
def client(snapshot_root: Path):
    repository = FileRepository(snapshot_root)
    app.dependency_overrides[get_repository] = lambda: repository
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_lists_map_ready_sites(client: TestClient):
    response = client.get("/v1/sites")
    assert response.status_code == 200
    assert response.headers["cache-control"].startswith("public")
    assert response.json()[0] == {
        "id": "test-pier",
        "name": "Test Pier",
        "region": "San Francisco Bay",
        "locality": None,
        "latitude": 37.8,
        "longitude": -122.4,
        "fishing_modes": ["pier"],
        "access_type": "public",
        "is_accessible": True,
        "structure_tags": ["channel edge"],
        "regulation_url": "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay",
    }


def test_api_request_logs_are_structured_correlated_and_query_free(client: TestClient, caplog):
    caplog.set_level(logging.INFO, logger="services.api.app.main")
    response = client.get("/v1/sites?private=private.angler@example.com")

    request_id = response.headers["x-request-id"]
    assert str(uuid.UUID(request_id)) == request_id
    entries = []
    for record in caplog.records:
        try:
            entry = json.loads(record.getMessage())
        except json.JSONDecodeError:
            continue
        if entry.get("event") == "http.request.completed":
            entries.append(entry)

    assert len(entries) == 1
    entry = entries[0]
    assert entry["schema_version"] == "castingcompass.log/1.0.0"
    assert entry["service"] == "castingcompass-api"
    assert entry["request_id"] == request_id
    assert entry["route"] == "/v1/sites"
    assert entry["status"] == 200
    assert "private.angler" not in json.dumps(entry)


def test_site_detail_and_not_found(client: TestClient):
    response = client.get("/v1/sites/test-pier")
    assert response.status_code == 200
    assert response.json()["access_notes"].startswith("Public pedestrian")
    assert response.json()["official_links"][0]["kind"] == "regulations"
    assert response.json()["next_window"]["opportunity_score"] == 82
    assert response.json()["data_freshness"]
    assert client.get("/v1/sites/closed-pier").status_code == 404
    assert client.get("/v1/sites/does-not-exist").status_code == 404


def test_opportunity_contract_marks_stale_sources_excluded(client: TestClient):
    response = client.get(
        "/v1/opportunities",
        params={"species": "california-halibut", "hours": 4},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["repository"] == "file-snapshot"
    assert response.headers["x-castingcompass-data-source"] == "file-snapshot"
    assert datetime.fromisoformat(payload["from"]).tzinfo is not None
    assert "not a catch probability" in payload["score_definition"]
    assert len(payload["windows"]) == 1
    window = payload["windows"][0]
    assert window["rank"] == 1
    assert window["target_taxon_id"] == "california-halibut"
    assert window["scoring_system_kind"] == "heuristic-configuration"
    assert window["model_version"] == window["scoring_system_version"]
    assert payload["scoring_system_sha256"] == SCORING_SHA256
    assert window["opportunity_score"] == 82
    assert window["status"] == "partial"
    stale = next(item for item in window["source_freshness"] if item["source"] == "tides")
    assert stale["status"] == "stale"
    assert stale["used_in_score"] is False
    assert "limit" in stale["excluded_reason"]
    sst = next(item for item in window["source_freshness"] if item["source"] == "water_temperature")
    assert sst["status"] == "excluded"
    assert sst["used_in_score"] is False
    assert window["conditions"]["water_temp_f"] == 59.8


def test_rejects_unsupported_species_and_horizon(client: TestClient):
    assert client.get("/v1/opportunities", params={"species": "striped-bass"}).status_code == 422
    assert client.get("/v1/opportunities", params={"hours": 1000}).status_code == 422


def test_missing_snapshot_returns_explicit_503(tmp_path: Path):
    repository = FileRepository(tmp_path)
    app.dependency_overrides[get_repository] = lambda: repository
    try:
        response = TestClient(app).get("/v1/sites")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["invented_values_used"] is False
    assert response.json()["reason"] == "published_data_unavailable"
    assert str(uuid.UUID(response.headers["x-request-id"])) == response.headers["x-request-id"]
    assert response.headers["retry-after"] == "300"


def test_postgres_repository_reuses_bounded_pool_and_public_site_cache():
    site_row = {
        "id": "pooled-pier",
        "name": "Pooled Pier",
        "region": "San Francisco Bay",
        "locality": "Test City",
        "latitude": 37.8,
        "longitude": -122.4,
        "fishing_modes": ["pier"],
        "access_type": "public",
        "is_accessible": True,
        "structure_tags": ["pier pilings"],
        "regulation_url": "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Fishing-Map/sf-bay",
        "description": "A public test site.",
        "access_notes": "Use posted public access.",
        "parking_notes": None,
        "transit_notes": None,
        "amenities": [],
        "bathymetry_summary": None,
        "casting_zone": None,
        "official_links": [],
    }

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def execute(self, query, parameters=None):
            assert "FROM public.sites" in query
            assert parameters is None

        def fetchall(self):
            return [site_row]

    class Connection:
        def cursor(self):
            return Cursor()

    class Pool:
        def __init__(self):
            self.closed = True
            self.open_calls = 0
            self.close_calls = 0
            self.checkouts = 0

        def open(self):
            self.closed = False
            self.open_calls += 1

        def close(self):
            self.closed = True
            self.close_calls += 1

        @contextmanager
        def connection(self):
            self.checkouts += 1
            yield Connection()

    pool = Pool()
    postgres = PostgresRepository(
        "postgresql+psycopg://ignored.example/castingcompass",
        pool=pool,
        site_cache_seconds=60,
    )

    first, source = postgres.list_sites()
    second, _ = postgres.list_sites()
    selected, _ = postgres.get_site("pooled-pier")

    assert source == "postgres-postgis"
    assert first[0].id == "pooled-pier"
    assert second[0].id == "pooled-pier"
    assert selected is not None and selected.id == "pooled-pier"
    assert pool.open_calls == 1
    assert pool.checkouts == 1

    postgres.close()
    assert pool.close_calls == 1


def test_incomplete_or_mixed_opportunity_contract_fails_closed(snapshot_root: Path):
    path = snapshot_root / "public" / "data" / "opportunities.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    del document["windows"][0]["target_taxon_id"]
    path.write_text(json.dumps(document), encoding="utf-8")
    repository = FileRepository(snapshot_root)
    app.dependency_overrides[get_repository] = lambda: repository
    try:
        response = TestClient(app).get("/v1/opportunities")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["invented_values_used"] is False


@pytest.mark.parametrize(
    "mutation",
    [
        "non-object-window",
        "naive-window-time",
        "naive-root-time",
        "nonfinite-score",
        "out-of-range-score",
        "out-of-range-component",
        "heuristic-version-hash-mismatch",
        "invalid-confidence",
        "missing-component",
        "empty-window-list",
    ],
)
def test_malformed_windows_are_never_repaired_or_dropped(snapshot_root: Path, mutation: str):
    path = snapshot_root / "public" / "data" / "opportunities.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    window = document["windows"][0]
    if mutation == "non-object-window":
        document["windows"].append(None)
    elif mutation == "naive-window-time":
        window["start"] = "2026-07-16T08:00:00"
    elif mutation == "naive-root-time":
        document["generated_at"] = "2026-07-16T08:00:00"
    elif mutation == "nonfinite-score":
        window["score"] = float("nan")
    elif mutation == "out-of-range-score":
        window["score"] = 101
    elif mutation == "out-of-range-component":
        window["dynamicScore"] = -1
    elif mutation == "heuristic-version-hash-mismatch":
        mismatched = f"heuristic-california-halibut-{'b' * 64}"
        document["scoring_system_version"] = mismatched
        document["modelVersion"] = mismatched
        window["modelVersion"] = mismatched
    elif mutation == "invalid-confidence":
        window["confidence"] = {"level": "high"}
    elif mutation == "missing-component":
        del window["fishabilityScore"]
    elif mutation == "empty-window-list":
        document["windows"] = []
    path.write_text(json.dumps(document), encoding="utf-8")

    repository = FileRepository(snapshot_root)
    app.dependency_overrides[get_repository] = lambda: repository
    try:
        response = TestClient(app).get("/v1/opportunities")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["invented_values_used"] is False


def test_database_rows_require_canonical_confidence_and_all_component_scores():
    valid = {
        "confidence": {"level": "high", "score": 0.8},
        "components": {
            "habitat_score": 80,
            "seasonality_score": 70,
            "dynamic_score": 60,
            "fishability_score": 50,
            "seasonality_multiplier": 1.4,
            "dynamic_modifier": 0.1,
        },
    }
    validate_database_window_shape(valid, location="valid row")

    malformed = []
    for confidence in ("high", None, {}, {"level": "HIGH"}, {"level": 1}):
        row = json.loads(json.dumps(valid))
        row["confidence"] = confidence
        malformed.append(row)
    for missing, derivation in (
        ("habitat_score", {}),
        ("seasonality_score", {"seasonality_multiplier": 1.4}),
        ("dynamic_score", {"dynamic_modifier": 0.1}),
        ("fishability_score", {}),
    ):
        row = json.loads(json.dumps(valid))
        del row["components"][missing]
        row["components"].update(derivation)
        malformed.append(row)
    malformed.append({**valid, "components": None})

    for index, row in enumerate(malformed):
        with pytest.raises(DataUnavailableError, match="confidence|components"):
            validate_database_window_shape(row, location=f"malformed row {index}")


def test_hybrid_source_attribution_is_atomic_under_concurrent_fallback(snapshot_root: Path):
    file_repository = FileRepository(snapshot_root)
    barrier = threading.Barrier(2)

    class ConcurrentDatabase:
        source = "postgres-postgis"

        def list_opportunities(self, species, from_time, through):
            barrier.wait(timeout=5)
            if from_time.microsecond == 1:
                raise RuntimeError("intentional database fallback")
            windows, generated_at, identity, _ = file_repository.list_opportunities(
                species, from_time, through
            )
            return windows, generated_at, identity, self.source

    hybrid = HybridRepository(file_repository, ConcurrentDatabase())  # type: ignore[arg-type]
    generated_at = datetime.fromisoformat(
        json.loads(file_repository.opportunities_path.read_text(encoding="utf-8"))["generated_at"]
    )
    request_times = [generated_at.replace(microsecond=1), generated_at.replace(microsecond=2)]
    app.dependency_overrides[get_repository] = lambda: hybrid
    try:
        with TestClient(app) as test_client, ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda value: test_client.get(
                        "/v1/opportunities",
                        params={"from": value.isoformat(), "hours": 4},
                    ),
                    request_times,
                )
            )
    finally:
        app.dependency_overrides.clear()

    assert {response.status_code for response in responses} == {200}
    sources = {response.json()["repository"] for response in responses}
    assert sources == {"postgres-postgis", "file-snapshot"}
    for response in responses:
        assert response.headers["x-castingcompass-data-source"] == response.json()["repository"]


def test_site_detail_attributes_mixed_database_site_and_file_forecast(snapshot_root: Path):
    file_repository = FileRepository(snapshot_root)
    site, _ = file_repository.get_site("test-pier")
    assert site is not None

    class DatabaseWithForecastFailure:
        source = "postgres-postgis"

        def get_site(self, site_id):
            return (site if site_id == "test-pier" else None), self.source

        def list_opportunities(self, species, from_time, through):
            raise RuntimeError("intentional database fallback")

    hybrid = HybridRepository(file_repository, DatabaseWithForecastFailure())  # type: ignore[arg-type]
    app.dependency_overrides[get_repository] = lambda: hybrid
    try:
        response = TestClient(app).get("/v1/sites/test-pier")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.json()["next_window"] is not None
    assert response.headers["x-castingcompass-data-source"] == "postgres-postgis+file-snapshot"
