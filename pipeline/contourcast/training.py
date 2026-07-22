"""Reproducible multiscale bathymetry pretraining workflows."""

from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple

import numpy as np

from .deep_model import (
    MultiScaleTerrainEncoder,
    TerrainContrastiveModel,
    TerrainMaskedContrastiveModel,
    TerrainResNetEncoder,
    augment_terrain_batch,
    mask_terrain_blocks,
    masked_reconstruction_loss,
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
from .sources import assert_source_operation, get_source_manifest
from .structure import (
    STRUCTURE_CHANNELS,
    derive_structure_channels,
    load_feature_stack,
)

from shared.species_contract import (
    MODEL_RUN_CONTRACT_VERSION,
    TAXON_CATALOG_VERSION,
    target_scope,
)


HYBRID_PRETRAINING_MODALITIES = ("bathymetry", "backscatter", "fused")
HYBRID_BACKSCATTER_PREFIX = "backscatter_intensity_"


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
    assert_source_operation(grid.source_id, "terrain-pretraining")
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
        nearest_channel_indices=tuple(
            index for index, name in enumerate(channel_names) if name.endswith("__available")
        ),
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
    aligned_layer_paths: Mapping[str, Path] | None = None,
    aligned_layer_expected_sha256: Mapping[str, str] | None = None,
    min_aligned_valid_fraction: float = 0.0,
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
    if not 0 <= min_aligned_valid_fraction <= 1:
        raise ValueError("min_aligned_valid_fraction must be in [0, 1]")
    aligned_paths = dict(aligned_layer_paths or {})
    aligned_hashes = dict(aligned_layer_expected_sha256 or {})
    if set(aligned_hashes) - set(aligned_paths):
        raise ValueError("aligned-layer checksums contain an undeclared layer")
    for name, path in aligned_paths.items():
        if (
            not name.startswith(HYBRID_BACKSCATTER_PREFIX)
            or name.endswith("__available")
        ):
            raise ValueError(
                "aligned backscatter names must use the survey-bound intensity prefix"
            )
        if path.suffix.lower() not in {".tif", ".tiff"}:
            raise ValueError("aligned pretraining layers must be GeoTIFFs")
        actual = sha256_file(path)
        if name in aligned_hashes and aligned_hashes[name].lower() != actual:
            raise ValueError(f"checksum mismatch for aligned layer {name!r}")
        aligned_hashes[name] = actual
    assert_source_operation(source_id, "terrain-pretraining")
    manifest = get_source_manifest(source_id)
    source_sha256 = sha256_file(source_path)
    if expected_sha256 and expected_sha256.lower() != source_sha256:
        raise ValueError(
            f"checksum mismatch for {source_path}: expected {expected_sha256}, got {source_sha256}"
        )
    try:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.warp import reproject
        from rasterio.windows import Window
    except ImportError as error:
        raise RuntimeError(
            "full-survey GeoTIFF corpus building requires rasterio in an isolated environment"
        ) from error

    radii = tuple(float(radius) for radius in radii_m)
    if not radii or any(radius <= 0 for radius in radii):
        raise ValueError("radii_m must contain positive physical radii")
    generator = np.random.default_rng(seed)
    patch_reservoir = []
    x_reservoir = []
    y_reservoir = []
    retained_seen = 0
    tiles_processed = 0
    requested_candidates = 0
    derivation_metadata: Mapping[str, Any] | None = None

    channel_names = STRUCTURE_CHANNELS
    with ExitStack() as stack:
        dataset = stack.enter_context(rasterio.open(source_path))
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
        aligned_datasets = {}
        for name, path in aligned_paths.items():
            source_layer = stack.enter_context(rasterio.open(path))
            if source_layer.count != 1 or not source_layer.crs:
                raise ValueError(f"aligned layer {name!r} must have one band and an explicit CRS")
            aligned_datasets[name] = source_layer
        stride_cells = max(1, int(round(stride_m / max(dx, dy))))
        coarse_height = max(1, int(np.ceil(dataset.height / stride_cells)))
        coarse_width = max(1, int(np.ceil(dataset.width / stride_cells)))
        coarse = dataset.read(
            out_shape=(1, coarse_height, coarse_width),
            masked=True,
            resampling=Resampling.nearest,
        )[0]
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
                window=window,
                boundless=True,
                fill_value=fill_value,
            )[0]
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
            tile_channel_names = STRUCTURE_CHANNELS
            if aligned_datasets:
                for name, source_layer in aligned_datasets.items():
                    layer_nodata = source_layer.nodata
                    layer_fill = layer_nodata if layer_nodata is not None else 0
                    layer_values = np.full(
                        (int(window.height), int(window.width)),
                        layer_fill,
                        dtype=source_layer.dtypes[0],
                    )
                    reproject(
                        source=rasterio.band(source_layer, 1),
                        destination=layer_values,
                        src_transform=source_layer.transform,
                        src_crs=source_layer.crs,
                        src_nodata=layer_nodata,
                        dst_transform=window_transform,
                        dst_crs=dataset.crs,
                        dst_nodata=layer_fill,
                        resampling=Resampling.nearest,
                    )
                    valid = np.isfinite(layer_values)
                    if layer_nodata is not None and np.isfinite(layer_nodata):
                        valid &= ~np.isclose(layer_values, layer_nodata)
                    fill = float(np.median(layer_values[valid])) if np.any(valid) else 0.0
                    filled = np.where(valid, layer_values, fill).astype(np.float32)
                    channels = np.concatenate(
                        [channels, filled[None, ...], valid.astype(np.float32)[None, ...]],
                        axis=0,
                    )
                    tile_channel_names = tile_channel_names + (
                        name,
                        f"{name}__available",
                    )
                channel_names = tile_channel_names
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
                    nearest_channel_indices=tuple(
                        index
                        for index, name in enumerate(tile_channel_names)
                        if name.endswith("__available")
                    ),
                )
            except ValueError as error:
                if "no patches meet min_valid_fraction" in str(error):
                    tiles_processed += 1
                    continue
                raise
            retained = np.asarray(patch_metadata["retained_mask"], dtype=bool)
            retained_indices = np.flatnonzero(retained)
            if aligned_datasets and min_aligned_valid_fraction > 0:
                availability_indices = tuple(
                    index
                    for index, name in enumerate(tile_channel_names)
                    if name.endswith("__available")
                )
                union_available = np.max(patches[:, :, availability_indices], axis=2)
                coverage = np.mean(union_available, axis=(2, 3))
                aligned_keep = np.all(coverage >= min_aligned_valid_fraction, axis=1)
                patches = patches[aligned_keep]
                retained_indices = retained_indices[aligned_keep]
            if not len(patches):
                tiles_processed += 1
                continue
            retained_x = np.asarray(xs, dtype=float)[retained_indices]
            retained_y = np.asarray(ys, dtype=float)[retained_indices]
            for patch, patch_x, patch_y in zip(patches, retained_x, retained_y):
                retained_seen += 1
                if len(patch_reservoir) < max_centers:
                    patch_reservoir.append(patch)
                    x_reservoir.append(float(patch_x))
                    y_reservoir.append(float(patch_y))
                    continue
                replacement = int(generator.integers(0, retained_seen))
                if replacement < max_centers:
                    patch_reservoir[replacement] = patch
                    x_reservoir[replacement] = float(patch_x)
                    y_reservoir[replacement] = float(patch_y)
            tiles_processed += 1

        if not patch_reservoir or derivation_metadata is None:
            raise ValueError("no full-survey patches passed the coverage contract")
        patches = np.stack(patch_reservoir)
        x = np.asarray(x_reservoir, dtype=float)
        y = np.asarray(y_reservoir, dtype=float)
        if len(patches) < 2:
            raise ValueError("fewer than two full-survey patches were retained")
        aligned_metadata = {}
        for name, path in aligned_paths.items():
            availability_index = channel_names.index(f"{name}__available")
            aligned_metadata[name] = {
                "source_id": source_id,
                "source_path": str(path.resolve()),
                "source_sha256": aligned_hashes[name],
                "valid_fraction": float(np.mean(patches[:, :, availability_index])),
                "missingness_channel": f"{name}__available",
                "resampling": "nearest onto the exact bathymetry reference grid",
                "overlap_policy": "survey channels remain separate; no blending or priority fill",
            }
        feature_metadata = dict(derivation_metadata)
        if aligned_metadata:
            feature_metadata["aligned_layers"] = aligned_metadata
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
            "feature_metadata": feature_metadata,
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
                "eligible_centers_seen": retained_seen,
                "retained_centers": int(len(patches)),
                "retention_method": "seeded streaming reservoir across every eligible tile",
                "tiles_processed": tiles_processed,
                "tile_size_cells": tile_size,
                "halo_cells": halo,
                "seed": seed,
                "min_aligned_valid_fraction": min_aligned_valid_fraction,
            },
            "label_scope": (
                "unlabeled bathymetry/backscatter representation pretraining only"
                if aligned_metadata
                else "unlabeled bathymetry representation pretraining only"
            ),
        }
    save_patch_corpus(output_path, patches, x, y, channel_names, corpus_metadata)
    report = {
        "status": "completed",
        "output_path": str(output_path.resolve()),
        "output_sha256": sha256_file(output_path),
        "source_sha256": source_sha256,
        "patches": int(len(patches)),
        "scales": int(patches.shape[1]),
        "channels": list(channel_names),
        "aligned_layers": aligned_metadata,
        "geographic_bounds": [float(np.min(x)), float(np.min(y)), float(np.max(x)), float(np.max(y))],
        "sampling": corpus_metadata["sampling"],
        "claim_boundary": (
            "This full-survey corpus has no catch or habitat labels. It can pretrain an "
            "unlabeled seafloor representation but cannot measure or claim fishing-prediction skill."
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


def resolve_hybrid_pretraining_contract(
    channel_names: Sequence[str],
    corpus_metadata: Mapping[str, Any],
    *,
    modality: str,
    backscatter_prefix: str = HYBRID_BACKSCATTER_PREFIX,
) -> Mapping[str, Any]:
    """Resolve one comparable bathymetry/backscatter ablation without guessing.

    A fused corpus must retain the ten declared structure channels, the measured
    backscatter layer, and its explicit availability mask. The auxiliary source
    identity is required in corpus provenance and must be admitted for terrain
    pretraining. This keeps a median-filled coverage gap from becoming a label.
    """

    names = tuple(str(name) for name in channel_names)
    if not names or any(not name for name in names) or len(set(names)) != len(names):
        raise ValueError("pretraining channel names must be unique and nonempty")
    if modality not in HYBRID_PRETRAINING_MODALITIES:
        raise ValueError(
            f"modality must be one of {', '.join(HYBRID_PRETRAINING_MODALITIES)}"
        )
    missing_structure = tuple(name for name in STRUCTURE_CHANNELS if name not in names)
    if missing_structure:
        raise ValueError(
            f"hybrid pretraining corpus is missing structure channels: {list(missing_structure)}"
        )
    feature_metadata = corpus_metadata.get("feature_metadata")
    if not isinstance(feature_metadata, Mapping):
        raise ValueError("hybrid pretraining corpus is missing feature_metadata")
    aligned_layers = feature_metadata.get("aligned_layers")
    if not isinstance(aligned_layers, Mapping):
        raise ValueError("hybrid pretraining corpus is missing aligned_layers provenance")
    backscatter_value_names = tuple(
        name
        for name in names
        if name.startswith(backscatter_prefix) and not name.endswith("__available")
    )
    if not backscatter_value_names:
        raise ValueError("hybrid pretraining corpus has no survey-bound backscatter channels")
    backscatter_names = []
    backscatter_sources = []
    backscatter_valid_fractions: Dict[str, float] = {}
    for backscatter_channel in backscatter_value_names:
        availability_channel = f"{backscatter_channel}__available"
        if availability_channel not in names:
            raise ValueError(
                f"hybrid pretraining corpus is missing {availability_channel!r}"
            )
        backscatter_metadata = aligned_layers.get(backscatter_channel)
        if not isinstance(backscatter_metadata, Mapping):
            raise ValueError(
                f"hybrid pretraining corpus is missing provenance for {backscatter_channel!r}"
            )
        source_id = backscatter_metadata.get("source_id")
        if not isinstance(source_id, str) or not source_id:
            raise ValueError(f"{backscatter_channel!r} provenance is missing source_id")
        if backscatter_metadata.get("missingness_channel") != availability_channel:
            raise ValueError(
                f"{backscatter_channel!r} provenance does not bind its availability channel"
            )
        valid_fraction = backscatter_metadata.get("valid_fraction")
        if (
            isinstance(valid_fraction, bool)
            or not isinstance(valid_fraction, (int, float))
            or not 0 < float(valid_fraction) <= 1
        ):
            raise ValueError(
                f"{backscatter_channel!r} valid_fraction must be in (0, 1]"
            )
        assert_source_operation(source_id, "terrain-pretraining")
        backscatter_names.extend((backscatter_channel, availability_channel))
        backscatter_sources.append(source_id)
        backscatter_valid_fractions[backscatter_channel] = float(valid_fraction)

    bathymetry_names = tuple(STRUCTURE_CHANNELS)
    backscatter_names = tuple(backscatter_names)
    selected_names = {
        "bathymetry": bathymetry_names,
        "backscatter": backscatter_names,
        "fused": bathymetry_names + backscatter_names,
    }[modality]
    reconstruction_names = {
        "bathymetry": ("depth_m",),
        "backscatter": backscatter_value_names,
        "fused": ("depth_m",) + backscatter_value_names,
    }[modality]
    selected_indices = tuple(names.index(name) for name in selected_names)
    selected_lookup = {name: index for index, name in enumerate(selected_names)}
    reconstruction_indices = tuple(selected_lookup[name] for name in reconstruction_names)
    availability_indices = tuple(
        selected_lookup[f"{name}__available"]
        for name in backscatter_value_names
        if f"{name}__available" in selected_lookup
    )
    reconstruction_availability = tuple(
        selected_lookup[f"{name}__available"] if name in backscatter_value_names else None
        for name in reconstruction_names
    )
    return {
        "contract_version": "castingcompass.hybrid-pretraining/1.0.0",
        "modality": modality,
        "input_channel_names": list(selected_names),
        "input_channel_indices": list(selected_indices),
        "availability_channel_indices": list(availability_indices),
        "reconstruction_channel_names": list(reconstruction_names),
        "reconstruction_channel_indices": list(reconstruction_indices),
        "reconstruction_availability_indices": list(reconstruction_availability),
        "backscatter_channel_names": list(backscatter_value_names),
        "backscatter_source_ids": list(backscatter_sources),
        "backscatter_valid_fractions": backscatter_valid_fractions,
        "claim_scope": "unlabeled seafloor representation pretraining only",
    }


def robust_hybrid_normalization(
    patches: np.ndarray,
    indices: np.ndarray,
    *,
    availability_channel_indices: Sequence[int],
    value_availability_pairs: Sequence[Tuple[int, int]] = (),
) -> Tuple[np.ndarray, np.ndarray]:
    """Fit fold-local robust statistics while preserving binary availability."""

    median, scale = robust_patch_normalization(patches, indices)
    availability = tuple(int(index) for index in availability_channel_indices)
    if len(set(availability)) != len(availability):
        raise ValueError("availability_channel_indices must be unique")
    if availability and (min(availability) < 0 or max(availability) >= patches.shape[2]):
        raise ValueError("availability_channel_indices contains an out-of-range channel")
    if availability:
        observed = patches[:, :, list(availability)]
        if not np.all(np.isin(observed, (0.0, 1.0))):
            raise ValueError("availability channels must contain only zero or one")
        median[list(availability)] = 0.0
        scale[list(availability)] = 1.0
    pairs = tuple((int(value), int(mask)) for value, mask in value_availability_pairs)
    if len(set(pairs)) != len(pairs):
        raise ValueError("value_availability_pairs must be unique")
    for value_index, availability_index in pairs:
        if not 0 <= value_index < patches.shape[2] or availability_index not in availability:
            raise ValueError("value_availability_pairs contains an invalid channel")
        training_values = patches[indices, :, value_index]
        training_available = patches[indices, :, availability_index] > 0.5
        measured = training_values[training_available]
        if not len(measured) or not np.all(np.isfinite(measured)):
            raise ValueError("training geography has no finite measured auxiliary pixels")
        median[value_index] = float(np.median(measured))
        value_scale = float(np.percentile(measured, 75) - np.percentile(measured, 25))
        scale[value_index] = value_scale if value_scale >= 1e-6 else 1.0
    return median, scale


def normalize_hybrid_patches(
    patches: np.ndarray,
    median: np.ndarray,
    scale: np.ndarray,
    *,
    value_availability_pairs: Sequence[Tuple[int, int]],
) -> np.ndarray:
    """Normalize measured values and zero every unavailable auxiliary cell."""

    normalized = normalize_patches(patches, median, scale)
    for value_index, availability_index in value_availability_pairs:
        missing = normalized[:, :, availability_index] <= 0.5
        normalized[:, :, value_index][missing] = 0.0
    return normalized


def _hybrid_pretraining_view(
    model: Any,
    patches: Any,
    contract: Mapping[str, Any],
    *,
    mask_fraction: float,
    mask_block_size: int,
) -> Tuple[Mapping[str, Any], Any]:
    availability_indices = tuple(contract["availability_channel_indices"])
    reconstruction_indices = tuple(contract["reconstruction_channel_indices"])
    view = augment_terrain_batch(
        patches,
        channel_drop=0.0,
        protected_channel_indices=availability_indices,
    )
    targets = view[:, :, list(reconstruction_indices)].clone()
    masked, full_mask = mask_terrain_blocks(
        view,
        reconstruction_indices,
        mask_fraction=mask_fraction,
        block_size=mask_block_size,
    )
    target_mask = full_mask[:, :, list(reconstruction_indices)]
    available = torch.ones_like(target_mask, dtype=torch.bool)
    for target_index, source_index in enumerate(
        contract["reconstruction_availability_indices"]
    ):
        if source_index is not None:
            available[:, :, target_index] = view[:, :, int(source_index)] > 0.5
    outputs = model(masked)
    reconstruction = masked_reconstruction_loss(
        outputs["reconstruction"],
        targets,
        target_mask,
        available_pixels=available,
    )
    return outputs, reconstruction


def hybrid_pretraining_batch_loss(
    model: Any,
    patches: Any,
    coordinates: Any,
    contract: Mapping[str, Any],
    *,
    temperature: float = 0.2,
    min_negative_distance_m: float = 0.0,
    reconstruction_weight: float = 1.0,
    mask_fraction: float = 0.25,
    mask_block_size: int = 4,
) -> Tuple[Any, Mapping[str, float]]:
    """Compute the hybrid objective for two independently masked terrain views."""

    require_torch()
    if reconstruction_weight <= 0:
        raise ValueError("reconstruction_weight must be positive")
    first, first_reconstruction = _hybrid_pretraining_view(
        model,
        patches,
        contract,
        mask_fraction=mask_fraction,
        mask_block_size=mask_block_size,
    )
    second, second_reconstruction = _hybrid_pretraining_view(
        model,
        patches,
        contract,
        mask_fraction=mask_fraction,
        mask_block_size=mask_block_size,
    )
    contrastive = (
        spatial_nt_xent_loss(
            first["projection"],
            second["projection"],
            coordinates,
            temperature=temperature,
            min_negative_distance_m=min_negative_distance_m,
        )
        if coordinates is not None
        else nt_xent_loss(first["projection"], second["projection"], temperature)
    )
    reconstruction = 0.5 * (first_reconstruction + second_reconstruction)
    total = contrastive + reconstruction_weight * reconstruction
    return total, {
        "loss": float(total.detach().cpu()),
        "contrastive_loss": float(contrastive.detach().cpu()),
        "reconstruction_loss": float(reconstruction.detach().cpu()),
    }


def train_hybrid_ssl_epoch(
    model: Any,
    loader: Any,
    optimizer: Any,
    contract: Mapping[str, Any],
    *,
    device: str,
    temperature: float,
    min_negative_distance_m: float,
    reconstruction_weight: float,
    mask_fraction: float,
    mask_block_size: int,
) -> Mapping[str, float]:
    model.train()
    parts = []
    for patches, coordinates in loader:
        loss, batch_parts = hybrid_pretraining_batch_loss(
            model,
            patches.to(device),
            coordinates.to(device),
            contract,
            temperature=temperature,
            min_negative_distance_m=min_negative_distance_m,
            reconstruction_weight=reconstruction_weight,
            mask_fraction=mask_fraction,
            mask_block_size=mask_block_size,
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        parts.append(batch_parts)
    if not parts:
        raise ValueError("hybrid pretraining loader produced no batches")
    return {
        name: float(np.mean([item[name] for item in parts]))
        for name in ("loss", "contrastive_loss", "reconstruction_loss")
    }


def _hybrid_validation_loss(
    model: Any,
    loader: Any,
    contract: Mapping[str, Any],
    **loss_options: Any,
) -> Mapping[str, float]:
    model.eval()
    parts = []
    with torch.no_grad():
        for patches, coordinates in loader:
            if len(patches) < 2:
                continue
            _, batch_parts = hybrid_pretraining_batch_loss(
                model,
                patches.to(loss_options["device"]),
                coordinates.to(loss_options["device"]),
                contract,
                temperature=loss_options["temperature"],
                min_negative_distance_m=loss_options["min_negative_distance_m"],
                reconstruction_weight=loss_options["reconstruction_weight"],
                mask_fraction=loss_options["mask_fraction"],
                mask_block_size=loss_options["mask_block_size"],
            )
            parts.append(batch_parts)
    if not parts:
        raise ValueError("hybrid validation loader produced no informative batches")
    return {
        name: float(np.mean([item[name] for item in parts]))
        for name in ("loss", "contrastive_loss", "reconstruction_loss")
    }


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
    source_id = corpus_metadata.get("source_id")
    if not isinstance(source_id, str) or not source_id:
        raise ValueError("pretraining corpus is missing its admitted source_id")
    assert_source_operation(source_id, "terrain-pretraining")
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


def run_hybrid_seafloor_pretraining(
    corpus_path: Path,
    output_dir: Path,
    *,
    modality: str,
    epochs: int = 10,
    batch_size: int = 32,
    learning_rate: float = 3e-4,
    weight_decay: float = 1e-4,
    base_width: int = 32,
    blocks_per_stage: int = 2,
    projection_dim: int = 128,
    temperature: float = 0.2,
    min_negative_distance_m: float = 512.0,
    reconstruction_weight: float = 1.0,
    mask_fraction: float = 0.25,
    mask_block_size: int = 4,
    validation_fold: int = 0,
    split_regions: int = 5,
    device: str = "auto",
    seed: int = 42,
) -> Mapping[str, Any]:
    """Train one frozen hybrid-objective modality for a later fair ablation."""

    require_torch()
    if epochs < 1 or batch_size < 2:
        raise ValueError("epochs must be positive and batch_size must be at least two")
    if learning_rate <= 0 or weight_decay < 0:
        raise ValueError("learning_rate must be positive and weight_decay nonnegative")
    patches, x, y, channel_names, corpus_metadata = load_patch_corpus(corpus_path)
    source_id = corpus_metadata.get("source_id")
    if not isinstance(source_id, str) or not source_id:
        raise ValueError("pretraining corpus is missing its admitted bathymetry source_id")
    assert_source_operation(source_id, "terrain-pretraining")
    contract = resolve_hybrid_pretraining_contract(
        channel_names,
        corpus_metadata,
        modality=modality,
    )
    selected_indices = contract["input_channel_indices"]
    selected_patches = patches[:, :, selected_indices].astype(np.float32, copy=False)
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
    value_availability_pairs = tuple(
        (int(value_index), int(availability_index))
        for value_index, availability_index in zip(
            contract["reconstruction_channel_indices"],
            contract["reconstruction_availability_indices"],
        )
        if availability_index is not None
    )
    median, scale = robust_hybrid_normalization(
        selected_patches,
        fold.train_indices,
        availability_channel_indices=contract["availability_channel_indices"],
        value_availability_pairs=value_availability_pairs,
    )
    normalized = normalize_hybrid_patches(
        selected_patches,
        median,
        scale,
        value_availability_pairs=value_availability_pairs,
    )

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
    train_loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(train_tensor, train_coordinates),
        batch_size=batch_size,
        shuffle=True,
        drop_last=True,
        generator=torch.Generator().manual_seed(seed),
    )
    validation_loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(validation_tensor, validation_coordinates),
        batch_size=batch_size,
        shuffle=False,
        drop_last=False,
    )
    base_encoder = TerrainResNetEncoder(
        input_channels=selected_patches.shape[2],
        base_width=base_width,
        blocks_per_stage=blocks_per_stage,
    )
    encoder = MultiScaleTerrainEncoder(base_encoder, scales=selected_patches.shape[1])
    model = TerrainMaskedContrastiveModel(
        encoder,
        projection_dim=projection_dim,
        reconstruction_channels=len(contract["reconstruction_channel_indices"]),
    ).to(selected_device)
    optimizer = torch.optim.AdamW(
        model.parameters(), learning_rate, weight_decay=weight_decay
    )
    loss_options = {
        "device": selected_device,
        "temperature": temperature,
        "min_negative_distance_m": min_negative_distance_m,
        "reconstruction_weight": reconstruction_weight,
        "mask_fraction": mask_fraction,
        "mask_block_size": mask_block_size,
    }
    history = []
    best_validation = float("inf")
    best_state = None
    for epoch in range(epochs):
        torch.manual_seed(seed + epoch)
        train_metrics = train_hybrid_ssl_epoch(
            model,
            train_loader,
            optimizer,
            contract,
            **loss_options,
        )
        torch.manual_seed(seed + 10000 + epoch)
        validation_metrics = _hybrid_validation_loss(
            model,
            validation_loader,
            contract,
            **loss_options,
        )
        history.append(
            {
                "epoch": epoch + 1,
                "train": train_metrics,
                "validation": validation_metrics,
            }
        )
        if validation_metrics["loss"] < best_validation:
            best_validation = validation_metrics["loss"]
            best_state = {
                key: value.detach().cpu() for key, value in model.state_dict().items()
            }
    if best_state is None:
        raise RuntimeError("hybrid pretraining did not produce a checkpoint")

    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_dir / f"{modality}_hybrid_encoder.pt"
    metrics_path = output_dir / f"{modality}_hybrid_metrics.json"
    config = {
        "objective": "spatial-contrastive-plus-masked-reconstruction",
        "hybrid_pretraining_contract": dict(contract),
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "weight_decay": weight_decay,
        "base_width": base_width,
        "blocks_per_stage": blocks_per_stage,
        "projection_dim": projection_dim,
        "temperature": temperature,
        "min_negative_distance_m": min_negative_distance_m,
        "reconstruction_weight": reconstruction_weight,
        "mask_fraction": mask_fraction,
        "mask_block_size": mask_block_size,
        "validation_fold": validation_fold,
        "split_regions": split_regions,
        "seed": seed,
        "device": selected_device,
        "scales": int(selected_patches.shape[1]),
    }
    claim_boundary = (
        "Hybrid loss measures optimization on unlabeled bathymetry/backscatter views only. "
        "It is not catch accuracy, habitat validation, calibration, or evidence that the live "
        "Opportunity Score improved. Modalities are not comparable until all three frozen "
        "ablations and an independent probe complete on identical geographic folds."
    )
    run_record = build_run_record(
        command="pretrain-hybrid-seafloor",
        target_taxon_id=None,
        config=config,
        input_paths=(corpus_path,),
        dataset_kind="official_unlabeled_seafloor_remote_sensing",
        status="completed",
        metrics={
            "metrics_artifact": str(metrics_path.resolve()),
            "best_validation_hybrid_loss": best_validation,
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
            "claim_scope": contract["claim_scope"],
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
        "stage": "hybrid_self_supervised_pretraining",
        "modality": modality,
        "train_patches": int(len(fold.train_indices)),
        "validation_patches": int(len(fold.test_indices)),
        "best_validation_hybrid_loss": best_validation,
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
    write_json(output_dir / f"{modality}_run_metadata.json", run_record)
    return {
        "status": "completed",
        "modality": modality,
        "checkpoint": checkpoint_path,
        "checkpoint_sha256": sha256_file(checkpoint_path),
        "metrics": metrics_path,
        "run_metadata": output_dir / f"{modality}_run_metadata.json",
        "best_validation_hybrid_loss": best_validation,
        "device": selected_device,
        "claim_boundary": claim_boundary,
    }
