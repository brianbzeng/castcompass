"""Frozen-embedding probes against official seafloor-character labels."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    log_loss,
)
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .deep_model import (
    MultiScaleTerrainEncoder,
    TerrainContrastiveModel,
    TerrainResNetEncoder,
    require_torch,
    torch,
)
from .metadata import build_run_record, sha256_file, verify_run_record_integrity, write_json
from .patches import load_patch_corpus
from .splits import spatial_block_folds

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    TAXON_CATALOG_VERSION,
    target_scope,
)


PROBE_CLASS_NAMES: Tuple[str, ...] = (
    "smooth_fine_medium_sediment",
    "mixed_or_rugose_rock",
    "mobile_coarse_sediment",
)
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def _validate_target_agnostic_checkpoint(
    checkpoint: Any,
    *,
    expected_corpus_sha256: str,
) -> Mapping[str, Any]:
    """Validate immutable checkpoint identity before reading config or weights."""

    if not isinstance(checkpoint, Mapping):
        raise ValueError("checkpoint must be a mapping")
    required_identity_fields = {
        "model_run_contract_version",
        "observation_contract_version",
        "taxon_catalog_version",
        "target_taxon_id",
        "target_scope",
        "experiment_version",
        "model_version",
        "corpus_sha256",
    }
    missing = required_identity_fields - set(checkpoint)
    if missing:
        raise ValueError(f"checkpoint is missing identity fields: {sorted(missing)}")
    if checkpoint.get("model_run_contract_version") != MODEL_RUN_CONTRACT_VERSION:
        raise ValueError("checkpoint model-run contract version is unsupported")
    if checkpoint.get("taxon_catalog_version") != TAXON_CATALOG_VERSION:
        raise ValueError("checkpoint taxon catalog version is unsupported")
    if checkpoint.get("observation_contract_version") is not None:
        raise ValueError("target-agnostic checkpoint must disclaim the observation contract")
    if checkpoint.get("target_taxon_id") is not None:
        raise ValueError("target-agnostic checkpoint cannot declare a target taxon")
    if checkpoint.get("target_scope") != target_scope(None):
        raise ValueError("checkpoint must declare the exact target-agnostic scope")
    for field, prefix in (
        ("experiment_version", "exp-target-agnostic-"),
        ("model_version", "model-target-agnostic-"),
    ):
        value = checkpoint.get(field)
        digest = value.removeprefix(prefix) if isinstance(value, str) else ""
        if not isinstance(value, str) or not value.startswith(prefix) or SHA256_PATTERN.fullmatch(digest) is None:
            raise ValueError(f"checkpoint {field} must be {prefix}<sha256>")
    corpus_sha256 = checkpoint.get("corpus_sha256")
    if (
        not isinstance(corpus_sha256, str)
        or SHA256_PATTERN.fullmatch(corpus_sha256) is None
        or corpus_sha256 != expected_corpus_sha256
    ):
        raise ValueError("checkpoint was not trained from the supplied corpus")
    return checkpoint


def _load_target_agnostic_checkpoint(
    checkpoint_path: Path,
    *,
    expected_corpus_sha256: str,
) -> Mapping[str, Any]:
    require_torch()
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    return _validate_target_agnostic_checkpoint(
        checkpoint,
        expected_corpus_sha256=expected_corpus_sha256,
    )


def decode_substrate_probe_target(raw_values: Sequence[int]) -> np.ndarray:
    """Decode the substrate digit without using composite depth/slope codes.

    USGS values add tens for depth zone and fifties for slope class. The final
    digit retains substrate classes 1–6. Classes 2 and 3 are combined because
    rugose-rock examples are sparse at the sampled corpus locations. Human-made
    classes 5 and 6 remain excluded from this three-class probe.
    """

    raw = np.asarray(raw_values, dtype=int)
    substrate = np.mod(raw, 10)
    output = np.full(raw.shape, -1, dtype=np.int64)
    output[substrate == 1] = 0
    output[np.isin(substrate, (2, 3))] = 1
    output[substrate == 4] = 2
    output[raw <= 0] = -1
    return output


def sample_seafloor_character_labels(
    label_raster_path: Path,
    x: np.ndarray,
    y: np.ndarray,
    source_crs: str,
    *,
    expected_sha256: str | None = None,
) -> Tuple[np.ndarray, Mapping[str, Any]]:
    """Sample the official categorical raster with an explicit CRS transform."""

    actual_sha256 = sha256_file(label_raster_path)
    if expected_sha256 and expected_sha256.lower() != actual_sha256:
        raise ValueError("seafloor-character raster checksum mismatch")
    try:
        import rasterio
        from pyproj import Transformer
    except ImportError as error:
        raise RuntimeError("seafloor-character sampling requires rasterio and pyproj") from error
    with rasterio.open(label_raster_path) as dataset:
        if dataset.count != 1 or not dataset.crs:
            raise ValueError("seafloor-character raster needs one band and an explicit CRS")
        transformer = Transformer.from_crs(source_crs, dataset.crs, always_xy=True)
        target_x, target_y = transformer.transform(x, y)
        raw = np.asarray(
            [int(value[0]) for value in dataset.sample(zip(target_x, target_y))],
            dtype=np.int64,
        )
        metadata = {
            "label_raster_sha256": actual_sha256,
            "label_crs": dataset.crs.to_string(),
            "label_bounds": list(dataset.bounds),
            "label_nodata": dataset.nodata,
            "source_crs": source_crs,
            "coordinate_transform_applied": dataset.crs.to_string().upper() != source_crs.upper(),
            "raw_value_counts": {
                str(int(value)): int(count)
                for value, count in zip(*np.unique(raw, return_counts=True))
            },
        }
    return raw, metadata


def summarize_multiscale_patches(
    patches: np.ndarray,
    channel_names: Sequence[str],
    *,
    selected_channels: Sequence[str] | None = None,
) -> Tuple[np.ndarray, Tuple[str, ...]]:
    """Interpretable center/mean/std/min/max features at each physical scale."""

    if patches.ndim != 5 or patches.shape[2] != len(channel_names):
        raise ValueError("patches must be (N,S,C,H,W) with declared channel names")
    requested = set(selected_channels or channel_names)
    unknown = requested - set(channel_names)
    if unknown:
        raise ValueError(f"unknown channels requested: {sorted(unknown)}")
    center_row = patches.shape[-2] // 2
    center_col = patches.shape[-1] // 2
    features = []
    names = []
    for scale_index in range(patches.shape[1]):
        for channel_index, channel_name in enumerate(channel_names):
            if channel_name not in requested:
                continue
            layer = patches[:, scale_index, channel_index]
            summaries = (
                layer[:, center_row, center_col],
                np.mean(layer, axis=(1, 2)),
                np.std(layer, axis=(1, 2)),
                np.min(layer, axis=(1, 2)),
                np.max(layer, axis=(1, 2)),
            )
            for suffix, values in zip(("center", "mean", "std", "min", "max"), summaries):
                features.append(values)
                names.append(f"scale_{scale_index}__{channel_name}__{suffix}")
    return np.column_stack(features).astype(np.float32), tuple(names)


def _load_encoder_embeddings(
    patches: np.ndarray,
    channel_names: Sequence[str],
    checkpoint: Mapping[str, Any],
    *,
    device: str,
    batch_size: int,
    random_encoder: bool,
    seed: int,
) -> np.ndarray:
    require_torch()
    config = checkpoint["config"]
    if tuple(config["channel_names"]) != tuple(channel_names):
        raise ValueError("checkpoint channel order does not match the probe corpus")
    if int(config["scales"]) != patches.shape[1]:
        raise ValueError("checkpoint physical-scale count does not match the probe corpus")
    normalization = checkpoint["normalization"]
    median = np.asarray(normalization["median"], dtype=np.float32)
    scale = np.asarray(normalization["iqr"], dtype=np.float32)
    normalized = (
        (patches - median[None, None, :, None, None])
        / scale[None, None, :, None, None]
    ).astype(np.float32)
    torch.manual_seed(seed)
    base = TerrainResNetEncoder(
        input_channels=len(channel_names),
        base_width=int(config["base_width"]),
        blocks_per_stage=int(config["blocks_per_stage"]),
    )
    encoder = MultiScaleTerrainEncoder(base, scales=int(config["scales"]))
    model = TerrainContrastiveModel(encoder, projection_dim=int(config["projection_dim"]))
    if not random_encoder:
        model.load_state_dict(checkpoint["state_dict"], strict=True)
    model = model.to(device)
    model.eval()
    batches = []
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(torch.from_numpy(normalized)),
        batch_size=batch_size,
        shuffle=False,
    )
    with torch.no_grad():
        for (batch,) in loader:
            batches.append(model.encoder(batch.to(device)).cpu().numpy())
    return np.concatenate(batches, axis=0).astype(np.float32)


def _fit_probe(
    features: np.ndarray,
    labels: np.ndarray,
    train_indices: np.ndarray,
    test_indices: np.ndarray,
    *,
    seed: int,
) -> Tuple[Mapping[str, Any], np.ndarray, np.ndarray]:
    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(
            max_iter=3000,
            class_weight="balanced",
            random_state=seed,
        ),
    )
    model.fit(features[train_indices], labels[train_indices])
    prediction = model.predict(features[test_indices]).astype(int)
    probability = model.predict_proba(features[test_indices])
    classes = model.named_steps["logisticregression"].classes_.astype(int)
    aligned_probability = np.zeros((len(test_indices), len(PROBE_CLASS_NAMES)), dtype=float)
    aligned_probability[:, classes] = probability
    log_loss_probability = np.clip(aligned_probability, 1e-8, 1 - 1e-8)
    log_loss_probability /= log_loss_probability.sum(axis=1, keepdims=True)
    truth = labels[test_indices]
    report = classification_report(
        truth,
        prediction,
        labels=np.arange(len(PROBE_CLASS_NAMES)),
        target_names=PROBE_CLASS_NAMES,
        output_dict=True,
        zero_division=0,
    )
    metrics: Dict[str, Any] = {
        "accuracy": float(accuracy_score(truth, prediction)),
        "balanced_accuracy": float(balanced_accuracy_score(truth, prediction)),
        "macro_f1": float(f1_score(truth, prediction, average="macro")),
        "log_loss": float(
            log_loss(truth, log_loss_probability, labels=[0, 1, 2])
        ),
        "confusion_matrix": confusion_matrix(truth, prediction, labels=[0, 1, 2]).tolist(),
        "per_class": {
            name: {
                key: float(value) if key != "support" else int(value)
                for key, value in report[name].items()
            }
            for name in PROBE_CLASS_NAMES
        },
    }
    return metrics, prediction, aligned_probability


def _paired_bootstrap_deltas(
    truth: np.ndarray,
    predictions: Mapping[str, np.ndarray],
    *,
    reference: str,
    samples: int,
    seed: int,
) -> Mapping[str, Any]:
    generator = np.random.default_rng(seed)
    output: Dict[str, Any] = {}
    for name, prediction in predictions.items():
        if name == reference:
            continue
        deltas = []
        for _ in range(samples):
            indices = generator.integers(0, len(truth), len(truth))
            reference_score = f1_score(
                truth[indices], predictions[reference][indices], average="macro", zero_division=0
            )
            comparison_score = f1_score(
                truth[indices], prediction[indices], average="macro", zero_division=0
            )
            deltas.append(reference_score - comparison_score)
        lower, median, upper = np.quantile(deltas, [0.025, 0.5, 0.975])
        output[f"{reference}_minus_{name}"] = {
            "median_macro_f1_delta": float(median),
            "ci_95_low": float(lower),
            "ci_95_high": float(upper),
            "bootstrap_samples": samples,
        }
    return output


def run_frozen_seafloor_probe(
    corpus_path: Path,
    checkpoint_path: Path,
    label_raster_path: Path,
    output_dir: Path,
    *,
    label_raster_sha256: str | None = None,
    validation_fold: int = 0,
    split_regions: int = 5,
    batch_size: int = 64,
    device: str = "cpu",
    bootstrap_samples: int = 1000,
    seed: int = 42,
) -> Mapping[str, Any]:
    """Compare pretrained and non-deep probes on a strict geographic holdout."""

    require_torch()
    patches, x, y, channel_names, corpus_metadata = load_patch_corpus(corpus_path)
    corpus_sha256 = sha256_file(corpus_path)
    checkpoint = _load_target_agnostic_checkpoint(
        checkpoint_path,
        expected_corpus_sha256=corpus_sha256,
    )
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
    if len(np.unique(labels[train_indices])) != len(PROBE_CLASS_NAMES):
        raise ValueError("training geography does not contain every probe class")
    if len(np.unique(labels[test_indices])) != len(PROBE_CLASS_NAMES):
        raise ValueError("held-out geography does not contain every probe class")

    pretrained = _load_encoder_embeddings(
        patches,
        channel_names,
        checkpoint,
        device=device,
        batch_size=batch_size,
        random_encoder=False,
        seed=seed,
    )
    random_embeddings = _load_encoder_embeddings(
        patches,
        channel_names,
        checkpoint,
        device=device,
        batch_size=batch_size,
        random_encoder=True,
        seed=seed,
    )
    structure_features, structure_names = summarize_multiscale_patches(
        patches, channel_names
    )
    depth_features, depth_names = summarize_multiscale_patches(
        patches, channel_names, selected_channels=("depth_m",)
    )
    feature_sets = {
        "pretrained_frozen_encoder": pretrained,
        "random_frozen_encoder": random_embeddings,
        "classical_structure_summaries": structure_features,
        "depth_only_summaries": depth_features,
    }
    metrics: Dict[str, Any] = {}
    predictions: Dict[str, np.ndarray] = {}
    probabilities: Dict[str, np.ndarray] = {}
    for index, (name, features) in enumerate(feature_sets.items()):
        result, prediction, probability = _fit_probe(
            features,
            labels,
            train_indices,
            test_indices,
            seed=seed + index,
        )
        metrics[name] = {**result, "feature_count": int(features.shape[1])}
        predictions[name] = prediction
        probabilities[name] = probability
    truth = labels[test_indices]
    deltas = _paired_bootstrap_deltas(
        truth,
        predictions,
        reference="pretrained_frozen_encoder",
        samples=bootstrap_samples,
        seed=seed + 1000,
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = output_dir / "seafloor_probe_metrics.json"
    prediction_path = output_dir / "seafloor_probe_predictions.npz"
    claim_boundary = (
        "The USGS character map was itself derived from bathymetry, backscatter, and "
        "interpreter/video evidence. This probe measures transferable seafloor-character "
        "signal, not independence from the source variables and not fishing accuracy."
    )
    config = {
        "validation_fold": validation_fold,
        "split_regions": split_regions,
        "batch_size": batch_size,
        "device": device,
        "bootstrap_samples": bootstrap_samples,
        "seed": seed,
        "target": "decoded_usgs_substrate_3class",
    }
    run_record = build_run_record(
        command="probe-seafloor-character",
        target_taxon_id=None,
        config=config,
        input_paths=(corpus_path, checkpoint_path, label_raster_path),
        dataset_kind="official_seafloor_character_probe",
        status="completed",
        metrics={
            "metrics_artifact": str(metrics_path.resolve()),
            "predictions_artifact": str(prediction_path.resolve()),
            "pretrained_macro_f1": metrics["pretrained_frozen_encoder"]["macro_f1"],
        },
        notes=claim_boundary,
    )
    result_payload: Dict[str, Any] = {
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
            "pretraining_unlabeled_holdout_matches_probe_holdout": bool(
                checkpoint["config"].get("validation_fold") == validation_fold
                and checkpoint["config"].get("split_regions") == split_regions
                and checkpoint["config"].get("seed") == seed
            ),
        },
        "label_metadata": dict(label_metadata),
        "models": metrics,
        "paired_bootstrap": deltas,
        "feature_contract": {
            "pretrained_embedding_dimensions": int(pretrained.shape[1]),
            "random_embedding_dimensions": int(random_embeddings.shape[1]),
            "classical_structure_feature_count": len(structure_names),
            "depth_only_feature_count": len(depth_names),
        },
        "claim_boundary": claim_boundary,
    }
    write_json(metrics_path, result_payload)
    np.savez_compressed(
        prediction_path,
        contract_identity_json=json.dumps(
            {
                "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
                "observation_contract_version": None,
                "taxon_catalog_version": TAXON_CATALOG_VERSION,
                "target_scope": target_scope(None),
                "target_taxon_id": None,
                "experiment_version": run_record["experiment_version"],
                "model_version": run_record["model_version"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        model_run_contract_version=MODEL_RUN_CONTRACT_VERSION,
        taxon_catalog_version=TAXON_CATALOG_VERSION,
        target_scope_kind="target-agnostic",
        target_taxon_id="",
        experiment_version=run_record["experiment_version"],
        model_version=run_record["model_version"],
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
    write_json(output_dir / "run_metadata.json", run_record)
    return {
        "status": "completed",
        "metrics": metrics_path,
        "predictions": prediction_path,
        "run_metadata": output_dir / "run_metadata.json",
        "pretrained_macro_f1": metrics["pretrained_frozen_encoder"]["macro_f1"],
        "paired_bootstrap": deltas,
    }
