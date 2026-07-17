"""End-to-end baseline and smoke workflows."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Mapping

import numpy as np

from .evaluation import evaluate_ablations
from .geo import validate_observation_extent
from .ingest import load_model_observations
from .metadata import build_run_record, sha256_file, verify_run_record_integrity, write_json
from .patches import extract_patches, summarize_patches
from .splits import spatial_block_folds
from .synthetic import generate_synthetic_fixture
from .terrain import load_terrain_stack

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    OBSERVATION_CONTRACT_VERSION,
    SYNTHETIC_TARGET_TAXON_ID,
    TAXON_CATALOG_VERSION,
    target_scope,
)


def run_baseline_workflow(
    terrain_path: Path,
    observations_path: Path,
    output_dir: Path,
    *,
    dataset_kind: str,
    target_taxon_id: str,
    patch_size: int = 17,
    n_splits: int = 5,
    buffer_m: float = 250.0,
    random_state: int = 42,
) -> Mapping[str, Any]:
    channels, grid, derivation = load_terrain_stack(terrain_path)
    observations = load_model_observations(
        observations_path,
        grid.crs,
        expected_target_taxon_id=target_taxon_id,
    )
    validate_observation_extent(grid, observations["x"], observations["y"])
    patches = extract_patches(
        channels,
        grid,
        observations["x"],
        observations["y"],
        patch_size=patch_size,
    )
    features, feature_names = summarize_patches(patches)
    occurrence = observations["occurrence"].to_numpy(dtype=int)
    cpue = observations["cpue"].to_numpy(dtype=float)
    folds = spatial_block_folds(
        observations["x"],
        observations["y"],
        n_splits=n_splits,
        buffer_m=buffer_m,
        random_state=random_state,
    )
    evaluation = evaluate_ablations(
        features,
        feature_names,
        occurrence,
        cpue,
        folds,
        random_state=random_state,
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "baseline_metrics.json"
    config = {
        "target_taxon_id": target_taxon_id,
        "patch_size": patch_size,
        "n_splits": n_splits,
        "buffer_m": buffer_m,
        "random_state": random_state,
        "terrain_channels": derivation["channels"],
    }
    run_record = build_run_record(
        command="baseline-evaluation",
        target_taxon_id=target_taxon_id,
        config=config,
        input_paths=(terrain_path, observations_path),
        dataset_kind=dataset_kind,
        status="completed",
        metrics={"metrics_artifact": str(metrics_path.resolve())},
        notes=(
            "pipeline smoke-test metrics only; not evidence of real-world skill or habitat performance"
            if dataset_kind == "synthetic_fixture"
            else "measured on the supplied dataset under the recorded blocked evaluation"
        ),
    )
    results: Dict[str, Any] = {
        "schema_version": MODEL_RUN_CONTRACT_VERSION,
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": OBSERVATION_CONTRACT_VERSION,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_taxon_id": target_taxon_id,
        "target_scope": target_scope(target_taxon_id),
        "experiment_version": run_record["experiment_version"],
        "model_version": run_record["model_version"],
        "status": "completed",
        "dataset_kind": dataset_kind,
        "result_scope": (
            "pipeline smoke-test metrics only; not evidence of real-world skill or habitat performance"
            if dataset_kind == "synthetic_fixture"
            else "measured on the supplied dataset under the recorded blocked evaluation"
        ),
        "rows": int(len(observations)),
        "positive_rate": float(np.mean(occurrence)),
        "patch_size": patch_size,
        "terrain_derivation": dict(derivation),
        **evaluation,
    }
    write_json(metrics_path, results)
    run_record["metrics"]["metrics_sha256"] = sha256_file(metrics_path)
    verify_run_record_integrity(
        run_record,
        rehash_inputs=True,
        artifact_paths={"metrics_sha256": metrics_path},
    )
    write_json(output_dir / "run_metadata.json", run_record)
    return {
        "metrics": metrics_path,
        "run_metadata": output_dir / "run_metadata.json",
        "experiment_version": run_record["experiment_version"],
        "model_version": run_record["model_version"],
    }


def run_smoke_workflow(
    output_dir: Path,
    *,
    seed: int = 42,
    observations: int = 480,
) -> Mapping[str, Any]:
    fixture_dir = output_dir / "fixture"
    paths = generate_synthetic_fixture(fixture_dir, seed=seed, observations=observations)
    results = run_baseline_workflow(
        paths["terrain"],
        paths["observations"],
        output_dir / "evaluation",
        dataset_kind="synthetic_fixture",
        target_taxon_id=SYNTHETIC_TARGET_TAXON_ID,
        patch_size=17,
        n_splits=4,
        buffer_m=150.0,
        random_state=seed,
    )
    return {"fixture": {key: str(value) for key, value in paths.items()}, **results}
