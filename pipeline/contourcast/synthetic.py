"""Deterministic synthetic fixtures for plumbing tests, never real results."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping

import numpy as np
import pandas as pd

from .geo import GeoGrid
from .ingest import save_grid
from .terrain import derive_terrain_channels, save_terrain_stack

from shared.species_contract import (
    OBSERVATION_CONTRACT_VERSION,
    SYNTHETIC_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
)


def generate_synthetic_fixture(
    output_dir: Path,
    *,
    seed: int = 42,
    observations: int = 480,
) -> Mapping[str, Path]:
    """Create a fictional UTM raster and labels to exercise the full pipeline."""

    if observations < 100:
        raise ValueError("synthetic fixture requires at least 100 observations")
    output_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    height = width = 96
    pixel_m = 100.0
    x_origin = 500_000.0
    y_origin = 4_200_000.0

    row, col = np.mgrid[0:height, 0:width]
    east = col / (width - 1)
    north = 1.0 - row / (height - 1)
    shelf = 7.0 + 34.0 * east
    channel = 12.0 * np.exp(-np.square((north - 0.53 - 0.08 * np.sin(8 * east)) / 0.10))
    bars = 3.5 * np.sin(6 * np.pi * east) * np.cos(4 * np.pi * north)
    noise = rng.normal(0.0, 0.35, size=(height, width))
    elevation = -(shelf + channel + bars + noise).astype(np.float32)
    grid = GeoGrid(
        elevation,
        "EPSG:32610",
        (x_origin, pixel_m, 0.0, y_origin, 0.0, -pixel_m),
        "synthetic_datum",
        "metre",
        None,
        "synthetic_fixture",
    )
    bathymetry_path = output_dir / "synthetic_bathymetry.npz"
    save_grid(bathymetry_path, grid)

    channels, derivation = derive_terrain_channels(grid)
    terrain_path = output_dir / "synthetic_terrain.npz"
    save_terrain_stack(terrain_path, channels, grid, derivation)

    rows = rng.integers(0, height, size=observations)
    cols = rng.integers(0, width, size=observations)
    x = x_origin + (cols + 0.5) * pixel_m
    y = y_origin - (rows + 0.5) * pixel_m
    depth = channels[0, rows, cols]
    slope = channels[1, rows, cols]
    roughness = channels[2, rows, cols]
    tpi = channels[4, rows, cols]

    habitat_score = (
        -0.35
        - 0.035 * np.abs(depth - 27.0)
        + 0.09 * np.clip(slope, 0, 12)
        + 0.12 * np.clip(roughness, 0, 8)
        + 0.08 * np.clip(tpi, -5, 5)
    )
    probability = 1.0 / (1.0 + np.exp(-habitat_score))
    occurrence = rng.binomial(1, probability)
    effort_hours = rng.uniform(0.75, 5.0, size=observations)
    positive_rate = np.exp(-0.25 + 0.018 * depth + 0.055 * np.clip(slope, 0, 10))
    catch_count = np.zeros(observations, dtype=int)
    positive_indices = np.flatnonzero(occurrence)
    sampled = rng.poisson(positive_rate[positive_indices] * effort_hours[positive_indices])
    catch_count[positive_indices] = np.maximum(sampled, 1)
    occurrence = (catch_count > 0).astype(int)
    cpue = catch_count / effort_hours

    observed_at = pd.date_range("2024-01-01", periods=observations, freq="12h", tz="UTC")
    taxon_observations = []
    for count in catch_count:
        positive = int(count) > 0
        taxon_observations.append(
            json.dumps(
                [
                    {
                        "taxon_id": SYNTHETIC_TARGET_TAXON_ID,
                        "encounter_count": int(count),
                        "retained_count": 0,
                        "released_count": int(count),
                        "disposition_unknown_count": 0,
                        "identification_confidence": "verified" if positive else "not_observed",
                        "identification_basis": "synthetic-fixture" if positive else "not-observed",
                    }
                ],
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    frame = pd.DataFrame(
        {
            "observation_contract_version": OBSERVATION_CONTRACT_VERSION,
            "taxon_catalog_version": TAXON_CATALOG_VERSION,
            "contract_status": "valid",
            "observation_id": [f"synthetic-{index:05d}" for index in range(observations)],
            "event_id": [f"synthetic-{index:05d}" for index in range(observations)],
            "effort_segment_id": [f"synthetic-effort-{index:05d}" for index in range(observations)],
            "observed_at": observed_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "observed_end_at": (
                observed_at + pd.to_timedelta(effort_hours, unit="h")
            ).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "temporal_precision": "exact",
            "primary_target_taxon_id": SYNTHETIC_TARGET_TAXON_ID,
            "species": SYNTHETIC_TARGET_TAXON_ID,
            "catch_count": catch_count,
            "target_encounter_count": catch_count,
            "any_fish_encounter_count": catch_count,
            "effort_hours": effort_hours,
            "target_effort_unit": "trip-hours",
            "fishing_mode": "synthetic-mode",
            "sample_weight": 1.0,
            "outcome_class": np.where(catch_count > 0, "target_encountered", "no_fish"),
            "source_data_kind": "synthetic-fixture",
            "source_complete_attempt": True,
            "source_expanded_estimate": False,
            "taxon_observations_json": taxon_observations,
            "x": x,
            "y": y,
            "crs": grid.crs,
            "area_id": np.nan,
            "spatial_support_id": [f"synthetic-point-{index:05d}" for index in range(observations)],
            "spatial_support_kind": "point",
            "spatial_resolution": "point",
            "source_id": "synthetic_fixture",
            "occurrence": occurrence,
            "cpue": cpue,
            "terrain_model_eligible": True,
        }
    )
    observations_path = output_dir / "synthetic_observations.csv"
    frame.to_csv(observations_path, index=False)
    return {
        "bathymetry": bathymetry_path,
        "terrain": terrain_path,
        "observations": observations_path,
    }
