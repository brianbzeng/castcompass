"""Reproducible multiscale bathymetry pretraining workflows."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple

import numpy as np

from .deep_model import (
    MultiScaleTerrainEncoder,
    TerrainContrastiveModel,
    TerrainResNetEncoder,
    augment_terrain_batch,
    nt_xent_loss,
    require_torch,
    spatial_nt_xent_loss,
    torch,
    train_ssl_epoch,
)
from .metadata import build_run_record, sha256_file, write_json
from .patches import (
    extract_multiscale_patches,
    load_patch_corpus,
    sample_water_centers,
    save_patch_corpus,
)
from .splits import spatial_block_folds
from .structure import load_feature_stack


def build_pretraining_corpus(
    feature_stack_path: Path,
    output_path: Path,
    *,
    radii_m: Sequence[float] = (64.0, 256.0, 1024.0),
    output_size: int = 33,
    stride_m: float = 100.0,
    max_centers: int | None = 2000,
    min_valid_fraction: float = 0.8,
    seed: int = 42,
) -> Mapping[str, Any]:
    """Create a content-addressable, physically scaled SSL patch corpus."""

    channels, grid, channel_names, feature_metadata = load_feature_stack(feature_stack_path)
    x, y = sample_water_centers(
        channels,
        grid,
        stride_m=stride_m,
        max_centers=max_centers,
        seed=seed,
    )
    patches, patch_metadata = extract_multiscale_patches(
        channels,
        grid,
        x,
        y,
        radii_m=radii_m,
        output_size=output_size,
        min_valid_fraction=min_valid_fraction,
    )
    retained = np.asarray(patch_metadata.pop("retained_mask"), dtype=bool)
    x = x[retained]
    y = y[retained]
    metadata: Dict[str, Any] = {
        "feature_stack_sha256": sha256_file(feature_stack_path),
        "source_id": grid.source_id,
        "crs": grid.crs,
        "vertical_datum": grid.vertical_datum,
        "feature_metadata": dict(feature_metadata),
        "patch_design": patch_metadata,
        "sampling": {
            "stride_m": stride_m,
            "max_centers": max_centers,
            "seed": seed,
            "underwater_only": True,
        },
        "label_scope": "unlabeled bathymetry representation pretraining only",
    }
    save_patch_corpus(output_path, patches, x, y, channel_names, metadata)
    report = {
        "status": "completed",
        "output_path": str(output_path.resolve()),
        "output_sha256": sha256_file(output_path),
        "patches": int(len(patches)),
        "scales": int(patches.shape[1]),
        "channels": list(channel_names),
        "patch_shape": list(patches.shape[2:]),
        "patch_design": patch_metadata,
        "claim_boundary": (
            "This corpus has no catch labels. It can pretrain a terrain representation but "
            "cannot measure or claim fishing-prediction skill."
        ),
    }
    write_json(output_path.with_suffix(".provenance.json"), report)
    return report


def robust_patch_normalization(
    patches: np.ndarray, indices: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    """Fit per-channel median/IQR using training geography only."""

    selected = patches[indices]
    if selected.ndim != 5:
        raise ValueError("patches must be shaped (N,S,C,H,W)")
    median = np.median(selected, axis=(0, 1, 3, 4)).astype(np.float32)
    q25 = np.percentile(selected, 25, axis=(0, 1, 3, 4))
    q75 = np.percentile(selected, 75, axis=(0, 1, 3, 4))
    scale = (q75 - q25).astype(np.float32)
    scale[scale < 1e-6] = 1.0
    return median, scale


def normalize_patches(patches: np.ndarray, median: np.ndarray, scale: np.ndarray) -> np.ndarray:
    if patches.ndim != 5 or patches.shape[2] != len(median) or median.shape != scale.shape:
        raise ValueError("normalization statistics do not match patch channels")
    return ((patches - median[None, None, :, None, None]) / scale[None, None, :, None, None]).astype(
        np.float32
    )


def _choose_device(requested: str) -> str:
    require_torch()
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _contrastive_validation_loss(
    model: Any,
    loader: Any,
    *,
    device: str,
    temperature: float,
    min_negative_distance_m: float,
) -> float:
    model.eval()
    losses = []
    with torch.no_grad():
        for batch in loader:
            patches = batch[0] if isinstance(batch, (tuple, list)) else batch
            if len(patches) < 2:
                # NT-Xent needs at least one negative pair; a final singleton
                # batch carries no validation information.
                continue
            patches = patches.to(device)
            coordinates = (
                batch[1].to(device)
                if isinstance(batch, (tuple, list)) and len(batch) > 1
                else None
            )
            first = model(augment_terrain_batch(patches))
            second = model(augment_terrain_batch(patches))
            loss = (
                spatial_nt_xent_loss(
                    first,
                    second,
                    coordinates,
                    temperature=temperature,
                    min_negative_distance_m=min_negative_distance_m,
                )
                if coordinates is not None
                else nt_xent_loss(first, second, temperature)
            )
            losses.append(float(loss.cpu()))
    if not losses:
        raise ValueError("validation loader produced no batches")
    return float(np.mean(losses))


def run_bathymetry_pretraining(
    corpus_path: Path,
    output_dir: Path,
    *,
    epochs: int = 10,
    batch_size: int = 32,
    learning_rate: float = 3e-4,
    weight_decay: float = 1e-4,
    base_width: int = 32,
    blocks_per_stage: int = 2,
    projection_dim: int = 128,
    temperature: float = 0.2,
    min_negative_distance_m: float = 512.0,
    validation_fold: int = 0,
    split_regions: int = 5,
    device: str = "auto",
    seed: int = 42,
) -> Mapping[str, Any]:
    """Train a multiscale SimCLR encoder on unlabeled bathymetry patches."""

    require_torch()
    if epochs < 1 or batch_size < 2:
        raise ValueError("epochs must be positive and batch_size must be at least two")
    patches, x, y, channel_names, corpus_metadata = load_patch_corpus(corpus_path)
    folds = spatial_block_folds(
        x,
        y,
        n_splits=split_regions,
        random_state=seed,
        min_train=max(20, batch_size),
        min_test=max(5, min(batch_size, 16)),
    )
    if not 0 <= validation_fold < len(folds):
        raise ValueError("validation_fold is out of range")
    fold = folds[validation_fold]
    median, scale = robust_patch_normalization(patches, fold.train_indices)
    normalized = normalize_patches(patches, median, scale)

    torch.manual_seed(seed)
    np.random.seed(seed)
    selected_device = _choose_device(device)
    train_tensor = torch.from_numpy(normalized[fold.train_indices])
    validation_tensor = torch.from_numpy(normalized[fold.test_indices])
    train_coordinates = torch.from_numpy(
        np.column_stack([x[fold.train_indices], y[fold.train_indices]]).astype(np.float32)
    )
    validation_coordinates = torch.from_numpy(
        np.column_stack([x[fold.test_indices], y[fold.test_indices]]).astype(np.float32)
    )
    generator = torch.Generator().manual_seed(seed)
    train_loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(train_tensor, train_coordinates),
        batch_size=batch_size,
        shuffle=True,
        drop_last=True,
        generator=generator,
    )
    validation_loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(validation_tensor, validation_coordinates),
        batch_size=batch_size,
        shuffle=True,
        drop_last=False,
        generator=torch.Generator().manual_seed(seed + 1),
    )
    base_encoder = TerrainResNetEncoder(
        input_channels=patches.shape[2],
        base_width=base_width,
        blocks_per_stage=blocks_per_stage,
    )
    encoder = MultiScaleTerrainEncoder(base_encoder, scales=patches.shape[1])
    model = TerrainContrastiveModel(encoder, projection_dim=projection_dim).to(selected_device)
    optimizer = torch.optim.AdamW(
        model.parameters(), learning_rate, weight_decay=weight_decay
    )
    history = []
    best_validation = float("inf")
    best_state = None
    for epoch in range(epochs):
        torch.manual_seed(seed + epoch)
        train_loss = train_ssl_epoch(
            model,
            train_loader,
            optimizer,
            device=selected_device,
            temperature=temperature,
            min_negative_distance_m=min_negative_distance_m,
        )
        torch.manual_seed(seed + 10000 + epoch)
        validation_loss = _contrastive_validation_loss(
            model,
            validation_loader,
            device=selected_device,
            temperature=temperature,
            min_negative_distance_m=min_negative_distance_m,
        )
        history.append(
            {"epoch": epoch + 1, "train_nt_xent": train_loss, "validation_nt_xent": validation_loss}
        )
        if validation_loss < best_validation:
            best_validation = validation_loss
            best_state = {key: value.detach().cpu() for key, value in model.state_dict().items()}
    if best_state is None:
        raise RuntimeError("pretraining did not produce a checkpoint")

    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_dir / "bathymetry_encoder.pt"
    config = {
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "weight_decay": weight_decay,
        "base_width": base_width,
        "blocks_per_stage": blocks_per_stage,
        "projection_dim": projection_dim,
        "temperature": temperature,
        "min_negative_distance_m": min_negative_distance_m,
        "validation_fold": validation_fold,
        "split_regions": split_regions,
        "seed": seed,
        "device": selected_device,
        "channel_names": list(channel_names),
        "scales": int(patches.shape[1]),
    }
    torch.save(
        {
            "state_dict": best_state,
            "config": config,
            "normalization": {"median": median.tolist(), "iqr": scale.tolist()},
            "corpus_sha256": sha256_file(corpus_path),
            "corpus_metadata": dict(corpus_metadata),
            "claim_scope": "unlabeled bathymetry representation pretraining",
        },
        checkpoint_path,
    )
    metrics_path = output_dir / "pretraining_metrics.json"
    metrics = {
        "status": "completed",
        "stage": "self_supervised_pretraining",
        "train_patches": int(len(fold.train_indices)),
        "validation_patches": int(len(fold.test_indices)),
        "best_validation_nt_xent": best_validation,
        "history": history,
        "claim_boundary": (
            "NT-Xent demonstrates optimization on unlabeled terrain views only. It is not a "
            "catch-accuracy metric and does not make the live Opportunity Score more accurate."
        ),
    }
    write_json(metrics_path, metrics)
    run_record = build_run_record(
        command="pretrain-bathymetry",
        config=config,
        input_paths=(corpus_path,),
        dataset_kind="official_unlabeled_bathymetry",
        status="completed",
        metrics={
            "metrics_artifact": str(metrics_path.resolve()),
            "checkpoint_sha256": sha256_file(checkpoint_path),
            "best_validation_nt_xent": best_validation,
        },
        notes=metrics["claim_boundary"],
    )
    write_json(output_dir / "run_metadata.json", run_record)
    return {
        "status": "completed",
        "checkpoint": checkpoint_path,
        "checkpoint_sha256": sha256_file(checkpoint_path),
        "metrics": metrics_path,
        "run_metadata": output_dir / "run_metadata.json",
        "best_validation_nt_xent": best_validation,
        "device": selected_device,
    }
