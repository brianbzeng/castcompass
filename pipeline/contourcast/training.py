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
from .geo import GeoGrid, verify_projected_crs
from .metadata import build_run_record, sha256_file, verify_run_record_integrity, write_json
from .patches import (
    extract_multiscale_patches,
    load_patch_corpus,
    sample_water_centers,
    save_patch_corpus,
)
from .splits import spatial_block_folds
from .sources import get_source_manifest
from .structure import STRUCTURE_CHANNELS, derive_structure_channels, load_feature_stack

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    TAXON_CATALOG_VERSION,
    target_scope,
)


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


def build_geotiff_pretraining_corpus(
    source_path: Path,
    output_path: Path,
    *,
    source_id: str,
    vertical_datum: str,
    expected_sha256: str | None = None,
    radii_m: Sequence[float] = (32.0, 128.0, 512.0),
    output_size: int = 33,
    stride_m: float = 64.0,
    max_centers: int = 4096,
    min_valid_fraction: float = 0.8,
    local_radius: int = 4,
    broad_radius: int = 24,
    relief_radius: int = 8,
    horizontal_accuracy_m: float | None = None,
    tile_size: int = 1024,
    seed: int = 42,
) -> Mapping[str, Any]:
    """Window a full GeoTIFF into a multiscale corpus without a giant feature stack.

    Structure channels are derived once per overlapping tile with enough halo
    for the broadest physical view. This keeps native-resolution computation
    bounded while sampling the complete survey footprint.
    """

    if source_path.suffix.lower() not in {".tif", ".tiff"}:
        raise ValueError("streaming pretraining input must be a GeoTIFF")
    if max_centers < 2 or tile_size < 128:
        raise ValueError("max_centers must be at least two and tile_size at least 128")
    if stride_m <= 0:
        raise ValueError("stride_m must be positive")
    manifest = get_source_manifest(source_id)
    source_sha256 = sha256_file(source_path)
    if expected_sha256 and expected_sha256.lower() != source_sha256:
        raise ValueError(
            f"checksum mismatch for {source_path}: expected {expected_sha256}, got {source_sha256}"
        )
    try:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.windows import Window
    except ImportError as error:
        raise RuntimeError(
            "full-survey GeoTIFF corpus building requires rasterio in an isolated environment"
        ) from error

    radii = tuple(float(radius) for radius in radii_m)
    if not radii or any(radius <= 0 for radius in radii):
        raise ValueError("radii_m must contain positive physical radii")
    generator = np.random.default_rng(seed)
    patch_parts = []
    x_parts = []
    y_parts = []
    tiles_processed = 0
    requested_candidates = 0
    derivation_metadata: Mapping[str, Any] | None = None

    with rasterio.open(source_path) as dataset:
        if dataset.count != 1 or not dataset.crs:
            raise ValueError("bathymetry GeoTIFF must have one band and an explicit CRS")
        crs = dataset.crs.to_string()
        verify_projected_crs(crs)
        transform = dataset.transform
        if not np.isclose(transform.b, 0) or not np.isclose(transform.d, 0):
            raise ValueError("rotated rasters must be warped north-up before corpus building")
        dx, dy = float(transform.a), float(abs(transform.e))
        if dx <= 0 or transform.e >= 0:
            raise ValueError("expected positive x and negative y pixel sizes")
        stride_cells = max(1, int(round(stride_m / max(dx, dy))))
        coarse_height = max(1, int(np.ceil(dataset.height / stride_cells)))
        coarse_width = max(1, int(np.ceil(dataset.width / stride_cells)))
        coarse = dataset.read(
            1,
            out_shape=(coarse_height, coarse_width),
            masked=True,
            resampling=Resampling.nearest,
        )
        mask = np.ma.getmaskarray(coarse)
        values = np.asarray(coarse.filled(np.nan), dtype=float)
        water = (~mask) & np.isfinite(values) & (values < 0)
        coarse_rows, coarse_cols = np.nonzero(water)
        if len(coarse_rows) < 2:
            raise ValueError("source raster contains too few sampled underwater cells")
        source_rows = np.minimum(
            ((coarse_rows + 0.5) * dataset.height / coarse_height).astype(int),
            dataset.height - 1,
        )
        source_cols = np.minimum(
            ((coarse_cols + 0.5) * dataset.width / coarse_width).astype(int),
            dataset.width - 1,
        )
        # Oversample to absorb coastal/nodata rejections at the broadest view.
        candidate_limit = min(len(source_rows), max_centers * 2)
        selected = np.sort(
            generator.choice(len(source_rows), size=candidate_limit, replace=False)
        )
        source_rows = source_rows[selected]
        source_cols = source_cols[selected]
        requested_candidates = int(len(source_rows))
        tile_keys = np.column_stack([source_rows // tile_size, source_cols // tile_size])
        order = np.lexsort((tile_keys[:, 1], tile_keys[:, 0]))
        source_rows = source_rows[order]
        source_cols = source_cols[order]
        tile_keys = tile_keys[order]
        unique_keys = np.unique(tile_keys, axis=0)
        largest_radius_cells = int(np.ceil(max(radii) / min(dx, dy)))
        halo = largest_radius_cells + max(broad_radius, relief_radius) + 2
        nodata = dataset.nodata
        fill_value = nodata if nodata is not None else np.nan

        for tile_row, tile_col in unique_keys:
            if sum(len(part) for part in x_parts) >= max_centers:
                break
            include = (tile_keys[:, 0] == tile_row) & (tile_keys[:, 1] == tile_col)
            rows = source_rows[include]
            cols = source_cols[include]
            inner_row = int(tile_row * tile_size)
            inner_col = int(tile_col * tile_size)
            inner_height = min(tile_size, dataset.height - inner_row)
            inner_width = min(tile_size, dataset.width - inner_col)
            window = Window(
                inner_col - halo,
                inner_row - halo,
                inner_width + 2 * halo,
                inner_height + 2 * halo,
            )
            elevation = dataset.read(
                1,
                window=window,
                boundless=True,
                fill_value=fill_value,
            )
            window_transform = dataset.window_transform(window)
            grid = GeoGrid(
                values=elevation,
                crs=crs,
                transform=(
                    window_transform.c,
                    window_transform.a,
                    window_transform.b,
                    window_transform.f,
                    window_transform.d,
                    window_transform.e,
                ),
                vertical_datum=vertical_datum,
                nodata=nodata,
                source_id=source_id,
            )
            channels, derivation_metadata = derive_structure_channels(
                grid,
                local_radius=local_radius,
                broad_radius=broad_radius,
                relief_radius=relief_radius,
                horizontal_accuracy_m=horizontal_accuracy_m,
            )
            xs = transform.c + (cols + 0.5) * transform.a
            ys = transform.f + (rows + 0.5) * transform.e
            try:
                patches, patch_metadata = extract_multiscale_patches(
                    channels,
                    grid,
                    xs,
                    ys,
                    radii_m=radii,
                    output_size=output_size,
                    min_valid_fraction=min_valid_fraction,
                )
            except ValueError as error:
                if "no patches meet min_valid_fraction" in str(error):
                    tiles_processed += 1
                    continue
                raise
            retained = np.asarray(patch_metadata["retained_mask"], dtype=bool)
            patch_parts.append(patches)
            x_parts.append(np.asarray(xs, dtype=float)[retained])
            y_parts.append(np.asarray(ys, dtype=float)[retained])
            tiles_processed += 1

        if not patch_parts or derivation_metadata is None:
            raise ValueError("no full-survey patches passed the coverage contract")
        patches = np.concatenate(patch_parts, axis=0)[:max_centers]
        x = np.concatenate(x_parts)[:max_centers]
        y = np.concatenate(y_parts)[:max_centers]
        if len(patches) < 2:
            raise ValueError("fewer than two full-survey patches were retained")
        corpus_metadata: Dict[str, Any] = {
            "source_path": str(source_path.resolve()),
            "source_sha256": source_sha256,
            "source_id": source_id,
            "source_title": manifest["title"],
            "official_landing_page": manifest["official_landing_page"],
            "crs": crs,
            "vertical_datum": vertical_datum,
            "source_bounds": list(dataset.bounds),
            "source_shape": [dataset.height, dataset.width],
            "native_pixel_m": [dx, dy],
            "feature_metadata": dict(derivation_metadata),
            "patch_design": {
                "radii_m": list(radii),
                "diameters_m": [2 * radius for radius in radii],
                "output_size": output_size,
                "min_valid_fraction": min_valid_fraction,
            },
            "sampling": {
                "method": "full-survey coarse water grid, seeded subsample, tiled derivation",
                "stride_m": stride_m,
                "requested_candidates": requested_candidates,
                "retained_centers": int(len(patches)),
                "tiles_processed": tiles_processed,
                "tile_size_cells": tile_size,
                "halo_cells": halo,
                "seed": seed,
            },
            "label_scope": "unlabeled bathymetry representation pretraining only",
        }
    save_patch_corpus(output_path, patches, x, y, STRUCTURE_CHANNELS, corpus_metadata)
    report = {
        "status": "completed",
        "output_path": str(output_path.resolve()),
        "output_sha256": sha256_file(output_path),
        "source_sha256": source_sha256,
        "patches": int(len(patches)),
        "scales": int(patches.shape[1]),
        "channels": list(STRUCTURE_CHANNELS),
        "geographic_bounds": [float(np.min(x)), float(np.min(y)), float(np.max(x)), float(np.max(y))],
        "sampling": corpus_metadata["sampling"],
        "claim_boundary": (
            "This full-survey corpus has no catch labels. It can pretrain a terrain "
            "representation but cannot measure or claim fishing-prediction skill."
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
    metrics_path = output_dir / "pretraining_metrics.json"
    claim_boundary = (
        "NT-Xent demonstrates optimization on unlabeled terrain views only. It is not a "
        "catch-accuracy metric and does not make the live Opportunity Score more accurate."
    )
    run_record = build_run_record(
        command="pretrain-bathymetry",
        target_taxon_id=None,
        config=config,
        input_paths=(corpus_path,),
        dataset_kind="official_unlabeled_bathymetry",
        status="completed",
        metrics={
            "metrics_artifact": str(metrics_path.resolve()),
            "best_validation_nt_xent": best_validation,
        },
        notes=claim_boundary,
    )
    torch.save(
        {
            "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
            "observation_contract_version": None,
            "taxon_catalog_version": TAXON_CATALOG_VERSION,
            "target_taxon_id": None,
            "target_scope": target_scope(None),
            "experiment_version": run_record["experiment_version"],
            "model_version": run_record["model_version"],
            "state_dict": best_state,
            "config": config,
            "normalization": {"median": median.tolist(), "iqr": scale.tolist()},
            "corpus_sha256": sha256_file(corpus_path),
            "corpus_metadata": dict(corpus_metadata),
            "claim_scope": "unlabeled bathymetry representation pretraining",
        },
        checkpoint_path,
    )
    run_record["metrics"]["checkpoint_sha256"] = sha256_file(checkpoint_path)
    metrics = {
        "model_run_contract_version": MODEL_RUN_CONTRACT_VERSION,
        "observation_contract_version": None,
        "taxon_catalog_version": TAXON_CATALOG_VERSION,
        "target_taxon_id": None,
        "target_scope": target_scope(None),
        "experiment_version": run_record["experiment_version"],
        "model_version": run_record["model_version"],
        "status": "completed",
        "stage": "self_supervised_pretraining",
        "train_patches": int(len(fold.train_indices)),
        "validation_patches": int(len(fold.test_indices)),
        "best_validation_nt_xent": best_validation,
        "history": history,
        "claim_boundary": claim_boundary,
    }
    write_json(metrics_path, metrics)
    run_record["metrics"]["metrics_sha256"] = sha256_file(metrics_path)
    verify_run_record_integrity(
        run_record,
        rehash_inputs=True,
        artifact_paths={
            "checkpoint_sha256": checkpoint_path,
            "metrics_sha256": metrics_path,
        },
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
