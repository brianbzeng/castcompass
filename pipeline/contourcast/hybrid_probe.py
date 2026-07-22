"""Frozen downstream probes for the three hybrid seafloor encoders.

The probes in this module are target-agnostic research checks.  They never
mutate a serving policy or expose their results to the opportunity score.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple

import numpy as np
from sklearn.metrics import f1_score

from .deep_model import (
    MultiScaleTerrainEncoder,
    TerrainMaskedContrastiveModel,
    TerrainResNetEncoder,
    require_torch,
    torch,
)
from .habitat_probe import (
    PROBE_CLASS_NAMES,
    _fit_probe,
    _validate_target_agnostic_checkpoint,
    decode_substrate_probe_target,
    sample_seafloor_character_labels,
    summarize_multiscale_patches,
)
from .metadata import build_run_record, sha256_file, verify_run_record_integrity, write_json
from .patches import load_patch_corpus
from .splits import spatial_block_folds
from .training import (
    HYBRID_PRETRAINING_MODALITIES,
    normalize_hybrid_patches,
    resolve_hybrid_pretraining_contract,
)

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    TAXON_CATALOG_VERSION,
    target_scope,
)


HYBRID_PROBE_SCHEMA_VERSION = "castingcompass.hybrid-seafloor-probe/1.0.0"


def _load_hybrid_checkpoint(
    path: Path,
    *,
    corpus_sha256: str,
    modality: str,
    channel_names: Sequence[str],
    corpus_metadata: Mapping[str, Any],
) -> Mapping[str, Any]:
    """Load and fully reconcile one frozen hybrid checkpoint."""

    require_torch()
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    validated = _validate_target_agnostic_checkpoint(
        checkpoint,
        expected_corpus_sha256=corpus_sha256,
    )
    config = validated.get("config")
    if not isinstance(config, Mapping):
        raise ValueError(f"{modality} checkpoint is missing its configuration")
    if config.get("objective") != "spatial-contrastive-plus-masked-reconstruction":
        raise ValueError(f"{modality} checkpoint objective is unsupported")
    stored_contract = config.get("hybrid_pretraining_contract")
    expected_contract = resolve_hybrid_pretraining_contract(
        channel_names,
        corpus_metadata,
        modality=modality,
    )
    if stored_contract != expected_contract:
        raise ValueError(f"{modality} checkpoint input/provenance contract differs from the corpus")
    if stored_contract.get("modality") != modality:
        raise ValueError(f"checkpoint supplied as {modality} declares another modality")
    for field in ("base_width", "blocks_per_stage", "projection_dim", "scales"):
        value = config.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"{modality} checkpoint {field} is invalid")
    if int(config["scales"]) < 1:
        raise ValueError(f"{modality} checkpoint has no physical scales")
    normalization = validated.get("normalization")
    if not isinstance(normalization, Mapping):
        raise ValueError(f"{modality} checkpoint is missing normalization")
    selected_count = len(expected_contract["input_channel_indices"])
    for field in ("median", "iqr"):
        values = normalization.get(field)
        if not isinstance(values, list) or len(values) != selected_count:
            raise ValueError(f"{modality} checkpoint normalization shape is invalid")
        array = np.asarray(values, dtype=np.float32)
        if not np.all(np.isfinite(array)):
            raise ValueError(f"{modality} checkpoint normalization is non-finite")
        if field == "iqr" and np.any(array <= 0):
            raise ValueError(f"{modality} checkpoint normalization scale is nonpositive")
    state = validated.get("state_dict")
    if not isinstance(state, Mapping) or not state:
        raise ValueError(f"{modality} checkpoint has no learned state")
    return validated


def _hybrid_encoder_embeddings(
    patches: np.ndarray,
    checkpoint: Mapping[str, Any],
    *,
    device: str,
    batch_size: int,
    random_encoder: bool,
    seed: int,
) -> np.ndarray:
    """Apply exactly the modality and normalization frozen by the checkpoint."""

    require_torch()
    if patches.ndim != 5:
        raise ValueError("probe patches must be shaped (N,S,C,H,W)")
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    config = checkpoint["config"]
    contract = config["hybrid_pretraining_contract"]
    selected_indices = tuple(int(index) for index in contract["input_channel_indices"])
    selected = patches[:, :, selected_indices].astype(np.float32, copy=False)
    if selected.shape[1] != int(config["scales"]):
        raise ValueError("checkpoint physical-scale count differs from the probe corpus")
    median = np.asarray(checkpoint["normalization"]["median"], dtype=np.float32)
    scale = np.asarray(checkpoint["normalization"]["iqr"], dtype=np.float32)
    pairs = tuple(
        (int(value), int(mask))
        for value, mask in zip(
            contract["reconstruction_channel_indices"],
            contract["reconstruction_availability_indices"],
        )
        if mask is not None
    )
    normalized = normalize_hybrid_patches(
        selected,
        median,
        scale,
        value_availability_pairs=pairs,
    )

    torch.manual_seed(seed)
    base = TerrainResNetEncoder(
        input_channels=selected.shape[2],
        base_width=int(config["base_width"]),
        blocks_per_stage=int(config["blocks_per_stage"]),
    )
    encoder = MultiScaleTerrainEncoder(base, scales=int(config["scales"]))
    model = TerrainMaskedContrastiveModel(
        encoder,
        projection_dim=int(config["projection_dim"]),
        reconstruction_channels=len(contract["reconstruction_channel_indices"]),
    )
    if not random_encoder:
        model.load_state_dict(checkpoint["state_dict"], strict=True)
    model = model.to(device)
    model.eval()
    output = []
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(torch.from_numpy(normalized)),
        batch_size=batch_size,
        shuffle=False,
    )
    with torch.no_grad():
        for (batch,) in loader:
            output.append(model.encoder(batch.to(device)).cpu().numpy())
    return np.concatenate(output, axis=0).astype(np.float32)


def _paired_bootstrap_pairs(
    truth: np.ndarray,
    predictions: Mapping[str, np.ndarray],
    pairs: Sequence[Tuple[str, str]],
    *,
    samples: int,
    seed: int,
) -> Mapping[str, Any]:
    """Compute only comparisons declared before looking at probe outcomes."""

    if samples < 1:
        raise ValueError("bootstrap_samples must be positive")
    if not len(truth):
        raise ValueError("paired bootstrap needs held-out observations")
    generator = np.random.default_rng(seed)
    output: Dict[str, Any] = {}
    for left, right in pairs:
        if left not in predictions or right not in predictions or left == right:
            raise ValueError("paired bootstrap comparison is invalid")
        deltas = np.empty(samples, dtype=float)
        class_indices = tuple(np.flatnonzero(truth == value) for value in np.unique(truth))
        if any(not len(indices) for indices in class_indices):
            raise ValueError("stratified bootstrap encountered an empty class")
        for draw in range(samples):
            indices = np.concatenate(
                [
                    values[generator.integers(0, len(values), len(values))]
                    for values in class_indices
                ]
            )
            deltas[draw] = f1_score(
                truth[indices],
                predictions[left][indices],
                average="macro",
                zero_division=0,
            ) - f1_score(
                truth[indices],
                predictions[right][indices],
                average="macro",
                zero_division=0,
            )
        lower, median, upper = np.quantile(deltas, [0.025, 0.5, 0.975])
        output[f"{left}_minus_{right}"] = {
            "median_macro_f1_delta": float(median),
            "ci_95_low": float(lower),
            "ci_95_high": float(upper),
            "bootstrap_samples": samples,
            "resampling_unit": "held-out-row-within-class",
        }
    return output


def _declared_feature_sets(
    patches: np.ndarray,
    channel_names: Sequence[str],
    checkpoints: Mapping[str, Mapping[str, Any]],
    *,
    device: str,
    batch_size: int,
    seed: int,
) -> Tuple[Mapping[str, np.ndarray], Mapping[str, Any]]:
    feature_sets: Dict[str, np.ndarray] = {}
    contract: Dict[str, Any] = {}
    for offset, modality in enumerate(HYBRID_PRETRAINING_MODALITIES):
        checkpoint = checkpoints[modality]
        input_contract = checkpoint["config"]["hybrid_pretraining_contract"]
        selected_indices = tuple(int(index) for index in input_contract["input_channel_indices"])
        selected_names = tuple(str(name) for name in input_contract["input_channel_names"])
        feature_sets[f"{modality}_pretrained_frozen_encoder"] = _hybrid_encoder_embeddings(
            patches,
            checkpoint,
            device=device,
            batch_size=batch_size,
            random_encoder=False,
            seed=seed,
        )
        feature_sets[f"{modality}_random_frozen_encoder"] = _hybrid_encoder_embeddings(
            patches,
            checkpoint,
            device=device,
            batch_size=batch_size,
            random_encoder=True,
            seed=seed,
        )
        summaries, summary_names = summarize_multiscale_patches(
            patches[:, :, selected_indices],
            selected_names,
        )
        feature_sets[f"{modality}_classical_summaries"] = summaries
        contract[modality] = {
            "pretrained_model_version": checkpoint["model_version"],
            "input_channel_names": list(selected_names),
            "embedding_dimensions": int(
                feature_sets[f"{modality}_pretrained_frozen_encoder"].shape[1]
            ),
            "classical_feature_names": list(summary_names),
            "random_initialization_seed": seed,
            "probe_fit_seed": seed + offset,
        }
    depth_features, depth_names = summarize_multiscale_patches(
        patches,
        channel_names,
        selected_channels=("depth_m",),
    )
    feature_sets["depth_only_summaries"] = depth_features
    contract["depth_only"] = {"feature_names": list(depth_names)}
    return feature_sets, contract


def run_hybrid_seafloor_probe(
    corpus_path: Path,
    checkpoint_paths: Mapping[str, Path],
    label_raster_path: Path,
    output_dir: Path,
    *,
    label_raster_sha256: str | None = None,
    validation_fold: int = 3,
    split_regions: int = 5,
    batch_size: int = 64,
    device: str = "cpu",
    bootstrap_samples: int = 1000,
    seed: int = 42,
) -> Mapping[str, Any]:
    """Run one common substrate probe over all frozen hybrid representations."""

    require_torch()
    if set(checkpoint_paths) != set(HYBRID_PRETRAINING_MODALITIES):
        raise ValueError("exact bathymetry, backscatter, and fused checkpoints are required")
    patches, x, y, channel_names, corpus_metadata = load_patch_corpus(corpus_path)
    corpus_sha256 = sha256_file(corpus_path)
    checkpoints = {
        modality: _load_hybrid_checkpoint(
            checkpoint_paths[modality],
            corpus_sha256=corpus_sha256,
            modality=modality,
            channel_names=channel_names,
            corpus_metadata=corpus_metadata,
        )
        for modality in HYBRID_PRETRAINING_MODALITIES
    }
    frozen_split = {
        (
            checkpoint["config"].get("validation_fold"),
            checkpoint["config"].get("split_regions"),
            checkpoint["config"].get("seed"),
        )
        for checkpoint in checkpoints.values()
    }
    if frozen_split != {(validation_fold, split_regions, seed)}:
        raise ValueError("probe split must exactly match every pretraining holdout")

    raw_labels, label_metadata = sample_seafloor_character_labels(
        label_raster_path,
        x,
        y,
        str(corpus_metadata["crs"]),
        expected_sha256=label_raster_sha256,
    )
    labels = decode_substrate_probe_target(raw_labels)
    valid = labels >= 0
    folds = spatial_block_folds(
        x,
        y,
        n_splits=split_regions,
        random_state=seed,
        min_train=max(64, batch_size),
        min_test=16,
    )
    if not 0 <= validation_fold < len(folds):
        raise ValueError("validation_fold is out of range")
    fold = folds[validation_fold]
    train_indices = fold.train_indices[valid[fold.train_indices]]
    test_indices = fold.test_indices[valid[fold.test_indices]]
    for name, indices in (("training", train_indices), ("held-out", test_indices)):
        if len(np.unique(labels[indices])) != len(PROBE_CLASS_NAMES):
            raise ValueError(f"{name} geography does not contain every probe class")

    feature_sets, feature_contract = _declared_feature_sets(
        patches,
        channel_names,
        checkpoints,
        device=device,
        batch_size=batch_size,
        seed=seed,
    )
    metrics: Dict[str, Any] = {}
    predictions: Dict[str, np.ndarray] = {}
    probabilities: Dict[str, np.ndarray] = {}
    for offset, (name, features) in enumerate(feature_sets.items()):
        result, prediction, probability = _fit_probe(
            features,
            labels,
            train_indices,
            test_indices,
            seed=seed + offset,
        )
        metrics[name] = {**result, "feature_count": int(features.shape[1])}
        predictions[name] = prediction
        probabilities[name] = probability

    declared_pairs = (
        ("bathymetry_pretrained_frozen_encoder", "bathymetry_random_frozen_encoder"),
        ("bathymetry_pretrained_frozen_encoder", "bathymetry_classical_summaries"),
        ("bathymetry_pretrained_frozen_encoder", "depth_only_summaries"),
        ("backscatter_pretrained_frozen_encoder", "backscatter_random_frozen_encoder"),
        ("backscatter_pretrained_frozen_encoder", "backscatter_classical_summaries"),
        ("fused_pretrained_frozen_encoder", "fused_random_frozen_encoder"),
        ("fused_pretrained_frozen_encoder", "fused_classical_summaries"),
        ("fused_pretrained_frozen_encoder", "bathymetry_pretrained_frozen_encoder"),
        ("fused_pretrained_frozen_encoder", "backscatter_pretrained_frozen_encoder"),
    )
    truth = labels[test_indices]
    deltas = _paired_bootstrap_pairs(
        truth,
        predictions,
        declared_pairs,
        samples=bootstrap_samples,
        seed=seed + 1000,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "hybrid_seafloor_probe_metrics.json"
    prediction_path = output_dir / "hybrid_seafloor_probe_predictions.npz"
    claim_boundary = (
        "The USGS character target was interpreted from bathymetry, backscatter, and video. "
        "This common geographic probe measures transferable substrate-character signal only; "
        "it is not an independent biological endpoint, fishing accuracy, catch calibration, "
        "or authority to promote an encoder or change the live Opportunity Score."
    )
    config = {
        "probe_contract": HYBRID_PROBE_SCHEMA_VERSION,
        "validation_fold": validation_fold,
        "split_regions": split_regions,
        "batch_size": batch_size,
        "device": device,
        "bootstrap_samples": bootstrap_samples,
        "seed": seed,
        "target": "decoded_usgs_substrate_3class",
        "declared_pairwise_comparisons": [list(pair) for pair in declared_pairs],
    }
    ordered_checkpoints = tuple(
        checkpoint_paths[modality] for modality in HYBRID_PRETRAINING_MODALITIES
    )
    run_record = build_run_record(
        command="probe-hybrid-seafloor-character",
        target_taxon_id=None,
        config=config,
        input_paths=(corpus_path, *ordered_checkpoints, label_raster_path),
        dataset_kind="official_seafloor_character_probe",
        status="completed",
        metrics={
            "metrics_artifact": str(metrics_path.resolve()),
            "predictions_artifact": str(prediction_path.resolve()),
        },
        notes=claim_boundary,
    )
    result_payload: Dict[str, Any] = {
        "schema_version": HYBRID_PROBE_SCHEMA_VERSION,
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": None,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_taxon_id": None,
        "target_scope": target_scope(None),
        "experiment_version": run_record["experiment_version"],
        "model_version": run_record["model_version"],
        "status": "completed",
        "probe_target": {
            "name": "decoded_usgs_substrate_3class",
            "class_names": list(PROBE_CLASS_NAMES),
            "excluded_substrate_codes": [5, 6],
            "composite_depth_slope_digits_removed": True,
        },
        "strict_transfer_design": {
            "validation_fold": validation_fold,
            "split_regions": split_regions,
            "seed": seed,
            "train_rows": int(len(train_indices)),
            "test_rows": int(len(test_indices)),
            "test_class_counts": {
                PROBE_CLASS_NAMES[int(value)]: int(count)
                for value, count in zip(*np.unique(truth, return_counts=True))
            },
            "pretraining_unlabeled_holdout_matches_probe_holdout": True,
        },
        "corpus_sha256": corpus_sha256,
        "checkpoint_sha256": {
            modality: sha256_file(checkpoint_paths[modality])
            for modality in HYBRID_PRETRAINING_MODALITIES
        },
        "label_metadata": dict(label_metadata),
        "feature_contract": feature_contract,
        "models": metrics,
        "paired_bootstrap": deltas,
        "claim_boundary": claim_boundary,
    }
    write_json(metrics_path, result_payload)
    identity = {
        "schema_version": HYBRID_PROBE_SCHEMA_VERSION,
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": None,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_scope": target_scope(None),
        "target_taxon_id": None,
        "experiment_version": run_record["experiment_version"],
        "model_version": run_record["model_version"],
    }
    np.savez_compressed(
        prediction_path,
        contract_identity_json=json.dumps(identity, sort_keys=True, separators=(",", ":")),
        corpus_indices=test_indices,
        x=x[test_indices],
        y=y[test_indices],
        truth=truth,
        **{f"prediction__{name}": value for name, value in predictions.items()},
        **{f"probability__{name}": value for name, value in probabilities.items()},
    )
    run_record["metrics"]["metrics_sha256"] = sha256_file(metrics_path)
    run_record["metrics"]["predictions_sha256"] = sha256_file(prediction_path)
    verify_run_record_integrity(
        run_record,
        rehash_inputs=True,
        artifact_paths={
            "metrics_sha256": metrics_path,
            "predictions_sha256": prediction_path,
        },
    )
    write_json(output_dir / "hybrid_seafloor_probe_run_metadata.json", run_record)
    return {
        "status": "completed",
        "metrics": metrics_path,
        "predictions": prediction_path,
        "run_metadata": output_dir / "hybrid_seafloor_probe_run_metadata.json",
        "claim_boundary": claim_boundary,
    }
